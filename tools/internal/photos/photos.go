// Package photos provides the public-domain photographs the design
// mock-ups and the demo are shown with, listed with their provenance in
// design/photos.json.
//
// The images are not in the repository. Each is fetched once from the URL
// the manifest names into the user cache, and is used only if its SHA-256
// is the one the manifest records -- the same rule as for the browser
// drivers, so a changed file upstream is refused rather than shown.
package photos

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wisborg/clack/tools/internal/cache"
)

// Photo is one manifest entry.
type Photo struct {
	File    string `json:"file"`
	Title   string `json:"title"`
	Caption string `json:"caption"`
	Author  string `json:"author"`
	Licence string `json:"licence"`
	Source  string `json:"source"`
	URL     string `json:"url"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	SHA256  string `json:"sha256"`
}

// Load reads the manifest at path.
func Load(path string) ([]Photo, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m struct {
		Photos []Photo `json:"photos"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	seen := map[string]bool{}
	for _, p := range m.Photos {
		if p.File != filepath.Base(p.File) || !strings.HasSuffix(p.File, ".jpg") {
			return nil, fmt.Errorf("%s: %q is not a plain .jpg file name", path, p.File)
		}
		if seen[p.File] {
			return nil, fmt.Errorf("%s: %s is listed twice", path, p.File)
		}
		seen[p.File] = true
		if !shaRE.MatchString(p.SHA256) {
			return nil, fmt.Errorf("%s: %s: sha256 %q is not 64 lowercase hex digits", path, p.File, p.SHA256)
		}
		if !allowedURL(p.URL) {
			return nil, fmt.Errorf("%s: %s is not fetched from Wikimedia", path, p.File)
		}
		if p.Licence != "CC0" && p.Licence != "Public domain" {
			return nil, fmt.Errorf("%s: %s is %s, not public domain", path, p.File, p.Licence)
		}
	}
	return m.Photos, nil
}

var shaRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// allowedHosts are where photos may come from -- checked for the manifest's
// URLs and again for every redirect the fetch follows.
var allowedHosts = map[string]bool{"upload.wikimedia.org": true, "thumb.wikimedia.org": true}

func allowedURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && allowedHosts[u.Hostname()]
}

// Ensure makes every photo available in the cache, fetching what is missing,
// and returns the directory holding them. Every file, fetched now or
// earlier, is checked against its recorded SHA-256.
func Ensure(ctx context.Context, list []Photo, log io.Writer) (string, error) {
	dir, err := cache.Dir("photos", "v1")
	if err != nil {
		return "", err
	}
	client := &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if !allowedURL(req.URL.String()) {
				return fmt.Errorf("refusing a redirect to %s", req.URL.Host)
			}
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
	for _, p := range list {
		path := filepath.Join(dir, p.File)
		data, err := os.ReadFile(path)
		if err != nil || digest(data) != p.SHA256 {
			fmt.Fprintf(log, "fetching %s (%s, %s)\n", p.File, p.Author, p.Licence)
			data, err = fetch(ctx, client, p.URL)
			if err != nil {
				return "", fmt.Errorf("%s: %w", p.File, err)
			}
			if got := digest(data); got != p.SHA256 {
				return "", fmt.Errorf("%s: SHA-256 %s, want %s; refusing it", p.File, got, p.SHA256)
			}
			if err := cache.WriteFile(path, data, 0o644); err != nil {
				return "", err
			}
		}
	}
	return dir, nil
}

func digest(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func fetch(ctx context.Context, c *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// Wikimedia asks automated clients to identify themselves.
	req.Header.Set("User-Agent", "clack-dev/0 (https://github.com/wisborg/clack)")
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 32<<20))
}
