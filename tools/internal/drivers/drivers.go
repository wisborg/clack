// Package drivers fetches the WebDriver programs for Chrome and Firefox from
// the browsers' vendors, verifies them, and keeps them in the user's cache.
//
// Safari's driver ships with macOS and is used from there. The other two are
// fetched rather than installed by hand because neither is reliably
// installable otherwise -- Homebrew disabled its chromedriver cask in 2026
// for failing Gatekeeper -- and because chromedriver must match the installed
// Chrome's version, which changes every few weeks on its own.
//
// What each download is checked against:
//
//   - chromedriver comes from Chrome for Testing, Google's channel for exactly
//     this purpose, for the build of Chrome that is installed. It cannot be
//     pinned, because it must follow Chrome's own updates, and Google
//     publishes no checksums for it and does not sign it with its developer
//     certificate (on macOS it carries only the linker's ad-hoc signature).
//     So the trust in it is HTTPS from Google's own storage, and no more:
//     the index must point there, and the binary must report the version
//     the index named. This is the weakest check in the toolchain, and it is
//     recorded as such in DEPENDENCIES.md.
//   - geckodriver is pinned to one release, and its SHA-256 for each
//     platform is recorded here. A different file is refused.
package drivers

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/wisborg/clack/tools/internal/cache"
)

const (
	// GeckodriverVersion is the pinned geckodriver release. Changing it is a
	// dependency change: update the digests below and DEPENDENCIES.md.
	GeckodriverVersion = "0.37.1"

	cftIndex = "https://googlechromelabs.github.io/chrome-for-testing/latest-patch-versions-per-build-with-downloads.json"
)

// geckodriverAssets are the release files for each platform and their
// SHA-256 digests, as published on the v0.37.1 GitHub release. The macOS
// file is a universal binary, the same for both architectures.
var geckodriverAssets = map[string]struct{ asset, sha256 string }{
	"darwin/arm64": {"macos-aarch64", "d02b3f7003f999caf90974a2ef5da0286c05d01cee19112c86846d759fdba4f5"},
	"darwin/amd64": {"macos", "d02b3f7003f999caf90974a2ef5da0286c05d01cee19112c86846d759fdba4f5"},
	"linux/amd64":  {"linux64", "e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e"},
	"linux/arm64":  {"linux-aarch64", "8fd90b951422fbad5b56539fb344dff66eb3f986d615d8d6fde9f1f62dad610c"},
}

var client = &http.Client{Timeout: 5 * time.Minute}

// chromeVersionRE finds the version in `Google Chrome 156.0.8078.74`.
var chromeVersionRE = regexp.MustCompile(`\d+\.\d+\.\d+\.\d+`)

// Geckodriver returns the path of the pinned geckodriver, fetching it first
// if it is not in the cache.
func Geckodriver(ctx context.Context, log io.Writer) (string, error) {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	a, ok := geckodriverAssets[platform]
	if !ok {
		return "", fmt.Errorf("no geckodriver %s is recorded for %s", GeckodriverVersion, platform)
	}
	dir, err := cache.Dir("geckodriver", GeckodriverVersion)
	if err != nil {
		return "", err
	}
	bin := filepath.Join(dir, "geckodriver")
	if cache.Exists(bin) {
		return bin, nil
	}

	url := fmt.Sprintf("https://github.com/mozilla/geckodriver/releases/download/v%[1]s/geckodriver-v%[1]s-%[2]s.tar.gz",
		GeckodriverVersion, a.asset)
	fmt.Fprintf(log, "fetching geckodriver %s from Mozilla's release; this happens once\n", GeckodriverVersion)
	archive, err := download(ctx, url, 64<<20)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(archive)
	if got := hex.EncodeToString(sum[:]); got != a.sha256 {
		return "", fmt.Errorf("geckodriver download has SHA-256 %s, want the pinned %s; refusing it", got, a.sha256)
	}
	exe, err := fromTarGz(archive, "geckodriver")
	if err != nil {
		return "", err
	}
	return bin, cache.WriteExecutable(bin, exe)
}

// Chromedriver returns the path of a chromedriver for the installed Chrome,
// fetching it first if it is not in the cache.
func Chromedriver(ctx context.Context, log io.Writer) (string, error) {
	chromeVersion, err := installedChrome(ctx)
	if err != nil {
		return "", err
	}
	// A chromedriver drives every patch release of the same build.
	build := chromeVersion[:strings.LastIndex(chromeVersion, ".")]
	platform, err := cftPlatform()
	if err != nil {
		return "", err
	}

	// The cache is keyed by build, so a Chrome update within the build
	// needs nothing, and one to a new build fetches a new driver.
	dir, err := cache.Dir("chromedriver", build)
	if err != nil {
		return "", err
	}
	bin := filepath.Join(dir, "chromedriver")
	if cache.Exists(bin) {
		return bin, nil
	}

	url, version, err := cftDownload(ctx, build, platform)
	if err != nil {
		return "", err
	}
	fmt.Fprintf(log, "fetching chromedriver %s from Chrome for Testing, for Chrome %s; this happens once per Chrome build\n",
		version, chromeVersion)
	archive, err := download(ctx, url, 128<<20)
	if err != nil {
		return "", err
	}
	exe, err := fromZip(archive, "chromedriver-"+platform+"/chromedriver")
	if err != nil {
		return "", err
	}
	tmp := bin + ".unverified"
	if err := cache.WriteExecutable(tmp, exe); err != nil {
		return "", err
	}
	if err := checkVersion(ctx, tmp, version); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return bin, cache.Promote(tmp, bin)
}

// checkVersion runs bin --version and requires it to name version.
func checkVersion(ctx context.Context, bin, version string) error {
	out, err := exec.CommandContext(ctx, bin, "--version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("chromedriver --version: %v\n%s", err, out)
	}
	if !strings.HasPrefix(string(out), "ChromeDriver "+version+" ") {
		return fmt.Errorf("the chromedriver downloaded for %s reports %q; refusing it", version, strings.TrimSpace(string(out)))
	}
	return nil
}

// installedChrome returns the version of the Chrome that is installed, such
// as "156.0.8078.74".
func installedChrome(ctx context.Context) (string, error) {
	var candidates []string
	switch runtime.GOOS {
	case "darwin":
		candidates = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
	case "linux":
		for _, name := range []string{"google-chrome", "google-chrome-stable"} {
			if p, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, p)
			}
		}
	}
	for _, c := range candidates {
		out, err := exec.CommandContext(ctx, c, "--version").Output()
		if err != nil {
			continue
		}
		if v := chromeVersionRE.FindString(string(out)); v != "" {
			return v, nil
		}
	}
	return "", errors.New("Google Chrome is not installed where it was looked for")
}

func cftPlatform() (string, error) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "darwin/arm64":
		return "mac-arm64", nil
	case "darwin/amd64":
		return "mac-x64", nil
	case "linux/amd64":
		return "linux64", nil
	case "linux/arm64":
		return "linux-arm64", nil
	}
	return "", fmt.Errorf("Chrome for Testing has no chromedriver for %s/%s", runtime.GOOS, runtime.GOARCH)
}

// cftDownload looks up the chromedriver for build in the Chrome for Testing
// index.
func cftDownload(ctx context.Context, build, platform string) (url, version string, err error) {
	raw, err := download(ctx, cftIndex, 16<<20)
	if err != nil {
		return "", "", err
	}
	return parseIndex(raw, build, platform)
}

// parseIndex finds the chromedriver for build and platform in a Chrome for
// Testing index.
func parseIndex(raw []byte, build, platform string) (url, version string, err error) {
	var index struct {
		Builds map[string]struct {
			Version   string `json:"version"`
			Downloads struct {
				Chromedriver []struct {
					Platform string `json:"platform"`
					URL      string `json:"url"`
				} `json:"chromedriver"`
			} `json:"downloads"`
		} `json:"builds"`
	}
	if err := json.Unmarshal(raw, &index); err != nil {
		return "", "", fmt.Errorf("reading the Chrome for Testing index: %w", err)
	}
	b, ok := index.Builds[build]
	if !ok {
		return "", "", fmt.Errorf("Chrome for Testing has no chromedriver for Chrome build %s yet", build)
	}
	for _, d := range b.Downloads.Chromedriver {
		if d.Platform == platform {
			// Only Google's own storage is accepted as the source.
			if !strings.HasPrefix(d.URL, "https://storage.googleapis.com/chrome-for-testing-public/") {
				return "", "", fmt.Errorf("the index points chromedriver at an unexpected host: %s", d.URL)
			}
			return d.URL, b.Version, nil
		}
	}
	return "", "", fmt.Errorf("Chrome for Testing has no %s chromedriver for build %s", platform, build)
}

func download(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", url, err)
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("GET %s: larger than the %d MB expected", url, limit>>20)
	}
	return b, nil
}

func fromTarGz(archive []byte, name string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s is not in the archive", name)
		}
		if err != nil {
			return nil, err
		}
		if h.Name == name && h.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(tr, 128<<20))
		}
	}
}

func fromZip(archive []byte, name string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		return io.ReadAll(io.LimitReader(rc, 128<<20))
	}
	return nil, fmt.Errorf("%s is not in the archive", name)
}
