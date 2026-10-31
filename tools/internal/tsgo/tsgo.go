// Package tsgo provides the TypeScript compiler -- TypeScript 7, the native
// port written in Go -- built from source at a pinned commit.
//
// Why built here rather than downloaded: TypeScript 7 is published as npm
// packages and as prebuilt binaries on its GitHub release. Either means
// trusting a binary built elsewhere. Its source, though, is an ordinary Go
// module in the tsc/ directory of microsoft/TypeScript, so it can be fetched
// at an exact commit and built with the local Go toolchain, its dependencies
// checked against its own go.sum like any other Go build. Two independent
// builds of the pinned commit produce byte-identical binaries.
//
// Why not `go install`: the Go module proxy cannot resolve a release version
// for it (the module path is still github.com/microsoft/typescript-go, a
// repository archived when development moved), so the source is fetched with
// git, by commit hash, and the hash is verified after checkout.
package tsgo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	// Version is the TypeScript release the pinned commit is tagged as.
	Version = "7.0.2"
	// Commit is the commit tagged v7.0.2 in microsoft/TypeScript. Changing
	// it is a dependency change: see DEPENDENCIES.md.
	Commit = "1e4744d68260a7cb91b62b12edc3f6a2187faaf1"

	repository = "https://github.com/microsoft/TypeScript.git"
)

// Path returns the path of the compiler, building it first if it is not
// already in the user's cache. Progress is written to log.
func Path(ctx context.Context, log io.Writer) (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cache, "clack", "tsgo", Commit)
	bin := filepath.Join(dir, "tsgo")

	if v, err := version(ctx, bin); err == nil && v == Version {
		return bin, nil
	}

	fmt.Fprintf(log, "building TypeScript %s (tsgo) from source at %.12s; this happens once\n", Version, Commit)
	src := filepath.Join(dir, "src")
	if err := os.RemoveAll(src); err != nil {
		return "", err
	}
	if err := os.MkdirAll(src, 0o755); err != nil {
		return "", err
	}
	if err := fetch(ctx, src); err != nil {
		return "", fmt.Errorf("fetching TypeScript source: %w", err)
	}

	tmp := bin + ".tmp"
	build := exec.CommandContext(ctx, "go", "build",
		"-C", filepath.Join(src, "tsc"),
		"-mod=readonly", "-trimpath",
		"-o", tmp, "./cmd/tsgo")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	build.Stdout, build.Stderr = log, log
	if err := build.Run(); err != nil {
		return "", fmt.Errorf("building tsgo: %w", err)
	}
	v, err := version(ctx, tmp)
	if err != nil {
		return "", err
	}
	if v != Version {
		return "", fmt.Errorf("built tsgo reports version %q, want %q", v, Version)
	}
	if err := os.Rename(tmp, bin); err != nil {
		return "", err
	}
	// The source is no longer needed; the binary is self-contained.
	_ = os.RemoveAll(src)
	return bin, nil
}

// fetch checks out the pinned commit's compiler sources -- tsc/cmd and
// tsc/internal, 45 MB rather than the repository's gigabytes -- into dir.
func fetch(ctx context.Context, dir string) error {
	steps := [][]string{
		{"init", "-q"},
		{"remote", "add", "origin", repository},
		{"sparse-checkout", "set", "--cone", "tsc/cmd", "tsc/internal"},
		{"fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", Commit},
		{"-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"},
	}
	for _, args := range steps {
		if out, err := git(ctx, dir, args...); err != nil {
			return fmt.Errorf("git %s: %w\n%s", strings.Join(args, " "), err, out)
		}
	}
	head, err := git(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if got := strings.TrimSpace(head); got != Commit {
		return fmt.Errorf("checked out %s, want the pinned %s", got, Commit)
	}
	return nil
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

// version runs bin --version and returns the version it reports.
func version(ctx context.Context, bin string) (string, error) {
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return "", err
	}
	return parseVersion(string(out))
}

// parseVersion reads the output of tsgo --version, "Version 7.0.2".
func parseVersion(out string) (string, error) {
	v, ok := strings.CutPrefix(strings.TrimSpace(out), "Version ")
	if !ok || v == "" || strings.ContainsAny(v, " \n") {
		return "", errors.New("unrecognised --version output: " + out)
	}
	return v, nil
}
