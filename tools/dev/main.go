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
// Every command ends with one "dev <command>: ok" or "dev <command>: FAILED
// (exit N)" line and exits with that status.
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
	}
}

func main() {
	if len(os.Args) < 2 {
		usage(os.Stderr)
		os.Exit(2)
	}
	name := os.Args[1]
	if name == "help" || name == "-h" || name == "--help" {
		usage(os.Stdout)
		return
	}
	var cmd *command
	for i := range commands {
		if commands[i].name == name {
			cmd = &commands[i]
		}
	}
	if cmd == nil {
		fmt.Fprintf(os.Stderr, "dev: unknown command %q\n\n", name)
		usage(os.Stderr)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	err := chdirRoot()
	if err == nil {
		err = cmd.run(ctx, os.Args[2:])
	}
	if err != nil {
		if msg := err.Error(); msg != "" {
			fmt.Fprintln(os.Stderr, msg)
		}
		fmt.Printf("dev %s: FAILED (exit 1)\n", name)
		os.Exit(1)
	}
	fmt.Printf("dev %s: ok\n", name)
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: go run ./tools/dev <command> [flags]")
	fmt.Fprintln(w)
	for _, c := range commands {
		fmt.Fprintf(w, "  %-10s %s\n", c.name, c.help)
	}
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

// silent marks an error whose explanation has already been printed.
var silent = errors.New("")

func cmdBuild(ctx context.Context, args []string) error {
	if err := flag.NewFlagSet("build", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}
	if err := os.MkdirAll("dist", 0o755); err != nil {
		return err
	}
	for _, o := range []bundle.Options{
		{Entry: "src/clack.ts", Outfile: "dist/clack.js", Write: true, Banner: banner},
		{Entry: "src/clack.ts", Outfile: "dist/clack.min.js", Write: true, Banner: banner, Minify: true},
	} {
		if _, err := bundle.Build(o); err != nil {
			return err
		}
	}
	min, err := os.ReadFile("dist/clack.min.js")
	if err != nil {
		return err
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
	if err := flag.NewFlagSet("typecheck", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}
	bin, err := tsgo.Path(ctx, os.Stderr)
	if err != nil {
		return err
	}
	return run(ctx, bin, "-p", "tsconfig.json")
}

func cmdTsgo(ctx context.Context, args []string) error {
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
	if err := fs.Parse(args); err != nil {
		return err
	}
	var browsers []webdriver.Browser
	for _, n := range strings.Split(*names, ",") {
		b, ok := webdriver.Lookup(strings.TrimSpace(n))
		if !ok {
			return fmt.Errorf("unknown browser %q", n)
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
		report, err := browsertest.Run(ctx, b, driver, srv.URL, !*headed)
		if err != nil && b.Name == "firefox" && strings.Contains(err.Error(), "unexpectedly closed with status 0") {
			// Firefox applies a downloaded update when it starts and then
			// restarts itself; geckodriver sees the first process end and
			// gives up. The second start finds nothing left to apply.
			fmt.Println("firefox  exited at once, as it does after applying an update; trying again")
			report, err = browsertest.Run(ctx, b, driver, srv.URL, !*headed)
		}
		switch {
		case err != nil:
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
	if err := flag.NewFlagSet("gates", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}
	gates := []struct {
		name string
		run  func() error
	}{
		{"gofmt", func() error {
			out, err := exec.CommandContext(ctx, "gofmt", "-l", "tools").Output()
			if err != nil {
				return err
			}
			if s := strings.TrimSpace(string(out)); s != "" {
				return errors.New("not gofmt-formatted:\n" + s)
			}
			return nil
		}},
		{"go vet", func() error { return run(ctx, "go", "vet", "./...") }},
		{"go test", func() error { return run(ctx, "go", "test", "./...") }},
		{"govulncheck", func() error { return run(ctx, "go", "tool", "govulncheck", "./...") }},
		{"typecheck", func() error { return cmdTypecheck(ctx, nil) }},
		{"build", func() error { return cmdBuild(ctx, nil) }},
		{"browsers", func() error { return cmdTest(ctx, nil) }},
	}
	var failed []string
	for _, g := range gates {
		fmt.Printf("--- %s\n", g.name)
		if err := g.run(); err != nil {
			if msg := err.Error(); msg != "" {
				fmt.Println(msg)
			}
			failed = append(failed, g.name)
		}
	}
	fmt.Println()
	for _, g := range gates {
		status := "ok"
		for _, f := range failed {
			if f == g.name {
				status = "FAILED"
			}
		}
		fmt.Printf("  %-12s %s\n", g.name, status)
	}
	if len(failed) > 0 {
		return silent
	}
	return nil
}

func cmdClean(ctx context.Context, args []string) error {
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
