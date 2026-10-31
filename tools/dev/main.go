// Command dev builds, checks and tests Clack. It is the one place each of
// those jobs is spelled out; the Makefile only delegates here.
//
//	go run ./tools/dev build                # dist/clack.js and dist/clack.min.js
//	go run ./tools/dev typecheck            # TypeScript 7 (tsgo), strict
//	go run ./tools/dev test [-browsers=...] # the tests, in Safari, Chrome and Firefox
//	go run ./tools/dev gates                # everything a branch must pass
//	go run ./tools/dev tsgo                 # build the pinned compiler; print its path
//	go run ./tools/dev clean                # remove dist/ and .scratch/
//	go run ./tools/dev help                 # this list
//
// Every command, help and mistakes included, ends with one "dev <command>:
// ok" or "dev <command>: FAILED (exit N)" line and exits with that status.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/wisborg/clack/tools/internal/browsertest"
	"github.com/wisborg/clack/tools/internal/bundle"
	"github.com/wisborg/clack/tools/internal/drivers"
	"github.com/wisborg/clack/tools/internal/tsgo"
	"github.com/wisborg/clack/tools/internal/webdriver"
)

// sizeBudget is the most the minified bundle may weigh, gzipped. The plan
// sets it; the build enforces it so that growth is a decision, not a drift.
const sizeBudget = 25 << 10

const banner = "/*! Clack | Apache-2.0 | https://github.com/wisborg/clack */"

type command struct {
	name string
	help string
	run  func(ctx context.Context, args []string) error
}

var commands []command

func init() {
	commands = []command{
		{"build", "bundle dist/clack.js and dist/clack.min.js, and check the size budget", cmdBuild},
		{"typecheck", "type-check src/ and test/ with TypeScript " + tsgo.Version, cmdTypecheck},
		{"test", "run the tests in real browsers (-browsers=safari,chrome,firefox -headed)", cmdTest},
		{"gates", "everything a branch must pass, one status line each", cmdGates},
		{"tsgo", "build the pinned TypeScript compiler if needed and print its path", cmdTsgo},
		{"clean", "remove dist/ and .scratch/", cmdClean},
		{"help", "this list", nil},
	}
}

// usageError is a mistake in how dev was called; it exits 2.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

// silent marks an error whose explanation has already been printed.
var silent = errors.New("")

func main() {
	name, err := dispatch()
	code := 0
	switch {
	case err == nil:
	case errors.As(err, new(usageError)):
		code = 2
	default:
		code = 1
	}
	if err != nil && err.Error() != "" {
		fmt.Fprintln(os.Stderr, err)
	}
	label := "dev " + name
	if name == "" {
		label = "dev"
	}
	if code == 0 {
		fmt.Printf("%s: ok\n", label)
	} else {
		fmt.Printf("%s: FAILED (exit %d)\n", label, code)
	}
	os.Exit(code)
}

// dispatch runs the command named on the command line and returns its name
// for the status line.
func dispatch() (string, error) {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		return "", usageError{"dev: no command given"}
	}
	name := os.Args[1]
	if name == "-h" || name == "--help" {
		name = "help"
	}
	var cmd *command
	for i := range commands {
		if commands[i].name == name {
			cmd = &commands[i]
		}
	}
	if cmd == nil {
		usage(os.Stderr)
		return name, usageError{fmt.Sprintf("dev: unknown command %q", name)}
	}
	if cmd.run == nil {
		usage(os.Stdout)
		return name, nil
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := chdirRoot(); err != nil {
		return name, err
	}
	err := cmd.run(ctx, os.Args[2:])
	if errors.Is(err, flag.ErrHelp) {
		// The flag package has already printed the command's flags.
		return name, nil
	}
	return name, err
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: go run ./tools/dev <command> [flags]")
	fmt.Fprintln(w)
	for _, c := range commands {
		fmt.Fprintf(w, "  %-10s %s\n", c.name, c.help)
	}
}

// parse parses a command's flags, reporting a bad flag as a usage error.
func parse(fs *flag.FlagSet, args []string) error {
	err := fs.Parse(args)
	if err != nil && !errors.Is(err, flag.ErrHelp) {
		return usageError{err.Error()}
	}
	if err == nil && fs.NArg() > 0 {
		return usageError{fmt.Sprintf("dev %s: unexpected argument %q", fs.Name(), fs.Arg(0))}
	}
	return err
}

// chdirRoot moves to the repository root, so every command works the same
// from any directory inside it.
func chdirRoot() error {
	dir, err := os.Getwd()
	if err != nil {
		return err
	}
	for {
		if b, err := os.ReadFile(filepath.Join(dir, "go.mod")); err == nil &&
			bytes.HasPrefix(b, []byte("module github.com/wisborg/clack\n")) {
			return os.Chdir(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return errors.New("dev: not inside the clack repository")
		}
		dir = parent
	}
}

func cmdBuild(ctx context.Context, args []string) error {
	if err := parse(flag.NewFlagSet("build", flag.ContinueOnError), args); err != nil {
		return err
	}
	if err := os.MkdirAll("dist", 0o755); err != nil {
		return err
	}
	if _, err := bundle.Build(bundle.Options{
		Entry: "src/clack.ts", Outfile: "dist/clack.js", Write: true, Banner: banner,
	}); err != nil {
		return err
	}
	files, err := bundle.Build(bundle.Options{
		Entry: "src/clack.ts", Outfile: "dist/clack.min.js", Write: true, Banner: banner, Minify: true,
	})
	if err != nil {
		return err
	}
	// The budget is checked against what was just built, not whatever is on
	// disk.
	var min []byte
	for _, f := range files {
		if filepath.Base(f.Path) == "clack.min.js" {
			min = f.Contents
		}
	}
	if min == nil {
		return errors.New("the minified build produced no clack.min.js")
	}
	gz := gzipSize(min)
	fmt.Printf("dist/clack.min.js: %s, %s gzipped (budget %s)\n", kb(len(min)), kb(gz), kb(sizeBudget))
	if gz > sizeBudget {
		return fmt.Errorf("dist/clack.min.js is %s gzipped, over the %s budget", kb(gz), kb(sizeBudget))
	}
	return nil
}

func gzipSize(b []byte) int {
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	w.Write(b)
	w.Close()
	return buf.Len()
}

func kb(n int) string { return fmt.Sprintf("%.1f KB", float64(n)/1024) }

func cmdTypecheck(ctx context.Context, args []string) error {
	if err := parse(flag.NewFlagSet("typecheck", flag.ContinueOnError), args); err != nil {
		return err
	}
	bin, err := tsgo.Path(ctx, os.Stderr)
	if err != nil {
		return err
	}
	return run(ctx, bin, "-p", "tsconfig.json")
}

func cmdTsgo(ctx context.Context, args []string) error {
	if err := parse(flag.NewFlagSet("tsgo", flag.ContinueOnError), args); err != nil {
		return err
	}
	bin, err := tsgo.Path(ctx, os.Stderr)
	if err != nil {
		return err
	}
	fmt.Println(bin)
	return nil
}

func cmdTest(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	names := fs.String("browsers", "safari,chrome,firefox", "comma-separated browsers to test in")
	headed := fs.Bool("headed", false, "show Chrome and Firefox windows (Safari always shows one)")
	if err := parse(fs, args); err != nil {
		return err
	}
	var browsers []webdriver.Browser
	for _, n := range strings.Split(*names, ",") {
		b, ok := webdriver.Lookup(strings.TrimSpace(n))
		if !ok {
			return usageError{fmt.Sprintf("dev test: unknown browser %q", n)}
		}
		browsers = append(browsers, b)
	}

	files, err := bundle.Build(bundle.Options{Entry: "test/all.ts", Outfile: "test.js"})
	if err != nil {
		return err
	}
	served := map[string][]byte{}
	for _, f := range files {
		served["/"+filepath.Base(f.Path)] = f.Contents
	}
	srv, err := browsertest.Serve(served)
	if err != nil {
		return err
	}
	defer srv.Close()

	failed := false
	for _, b := range browsers {
		driver, err := driverFor(ctx, b)
		if err != nil {
			// An engine that was not tested has not passed.
			fmt.Printf("%-8s NOT RUN: %v\n", b.Name, err)
			failed = true
			continue
		}
		report, err := browsertest.Run(ctx, b, driver, srv.URL, !*headed, os.Stderr)
		if err != nil {
			fmt.Printf("%-8s FAILED to run: %v\n", b.Name, err)
			failed = true
			continue
		}
		printReport(b.Name, report)
		failed = failed || report.Failed()
	}
	if failed {
		return silent
	}
	return nil
}

// driverFor returns the driver to run b with: Safari's own, which ships
// with macOS, or one fetched and verified by package drivers.
func driverFor(ctx context.Context, b webdriver.Browser) (string, error) {
	switch b.Name {
	case "chrome":
		return drivers.Chromedriver(ctx, os.Stderr)
	case "firefox":
		return drivers.Geckodriver(ctx, os.Stderr)
	}
	return "", nil
}

func printReport(browser string, r browsertest.Report) {
	var passed, skipped, failed int
	for _, t := range r.Results {
		switch {
		case t.Skipped != "":
			skipped++
		case t.Passed:
			passed++
		default:
			failed++
		}
	}
	fmt.Printf("%-8s %d passed, %d failed, %d skipped  (%s)\n", browser, passed, failed, skipped, r.UserAgent)
	if r.Error != "" {
		fmt.Printf("    RUN FAILED: %s\n", r.Error)
	}
	for _, t := range r.Results {
		switch {
		case t.Skipped != "":
			fmt.Printf("    skip  %s: %s\n", t.Name, t.Skipped)
		case !t.Passed:
			fmt.Printf("    FAIL  %s\n          %s\n", t.Name, strings.ReplaceAll(t.Error, "\n", "\n          "))
		}
	}
}

func cmdGates(ctx context.Context, args []string) error {
	if err := parse(flag.NewFlagSet("gates", flag.ContinueOnError), args); err != nil {
		return err
	}
	gates := []struct {
		name string
		run  func() error
	}{
		{"gofmt", func() error { return gofmt(ctx) }},
		{"go vet", func() error { return run(ctx, "go", "vet", "./...") }},
		{"go test", func() error { return run(ctx, "go", "test", "./...") }},
		{"govulncheck", func() error { return run(ctx, "go", "tool", "govulncheck", "./...") }},
		{"typecheck", func() error { return cmdTypecheck(ctx, nil) }},
		{"build", func() error { return cmdBuild(ctx, nil) }},
		{"browsers", func() error { return cmdTest(ctx, nil) }},
	}
	status := make([]string, len(gates))
	anyFailed := false
	for i, g := range gates {
		fmt.Printf("--- %s\n", g.name)
		status[i] = "ok"
		if err := g.run(); err != nil {
			if msg := err.Error(); msg != "" {
				fmt.Println(msg)
			}
			status[i] = "FAILED"
			anyFailed = true
		}
	}
	fmt.Println()
	for i, g := range gates {
		fmt.Printf("  %-12s %s\n", g.name, status[i])
	}
	if anyFailed {
		return silent
	}
	return nil
}

// gofmt checks the Go sources with the gofmt of the toolchain go.mod pins,
// not whichever gofmt is first on PATH: formatting can change between
// releases, and the gate must agree with the toolchain that builds.
func gofmt(ctx context.Context) error {
	goroot, err := exec.CommandContext(ctx, "go", "env", "GOROOT").Output()
	if err != nil {
		return fmt.Errorf("go env GOROOT: %w", err)
	}
	bin := filepath.Join(strings.TrimSpace(string(goroot)), "bin", "gofmt")
	cmd := exec.CommandContext(ctx, bin, "-l", "tools")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// A file gofmt cannot parse is reported on stderr, with its reason.
		return fmt.Errorf("gofmt: %w\n%s", err, stderr.String())
	}
	if s := strings.TrimSpace(string(out)); s != "" {
		return errors.New("not gofmt-formatted:\n" + s)
	}
	return nil
}

func cmdClean(ctx context.Context, args []string) error {
	if err := parse(flag.NewFlagSet("clean", flag.ContinueOnError), args); err != nil {
		return err
	}
	for _, dir := range []string{"dist", ".scratch"} {
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	return nil
}

// run runs a program with its output passed through.
func run(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}
