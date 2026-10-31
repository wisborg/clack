// Package cache keeps the programs the tools fetch or build -- the
// TypeScript compiler, the browser drivers -- in the user's cache directory,
// one directory per program and version.
package cache

import (
	"os"
	"path/filepath"
)

// Dir returns, creating it if needed, the directory for one version of one
// program: <user cache>/clack/<name>/<version>.
func Dir(name, version string) (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "clack", name, version)
	return dir, os.MkdirAll(dir, 0o755)
}

// Exists reports whether path is a regular file.
func Exists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// WriteExecutable writes an executable atomically: an interrupted write
// never leaves a half-written program at path.
func WriteExecutable(path string, data []byte) error {
	tmp := path + ".partial"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		os.Remove(tmp)
		return err
	}
	return Promote(tmp, path)
}

// Promote moves a finished file from tmp to path, removing tmp if it
// cannot.
func Promote(tmp, path string) error {
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
