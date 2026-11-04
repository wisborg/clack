// Command dev builds, checks and tests Clack. It is the one place each of
// those jobs is spelled out; the Makefile only delegates here.
//
//	go run ./tools/dev build                # dist/clack.js and dist/clack.min.js
//	go run ./tools/dev typecheck            # TypeScript 7 (tsgo), strict
//	go run ./tools/dev test [-browsers=...] # the tests, in Safari, Chrome and Firefox
//	go run ./tools/dev gates                # everything a branch must pass
//	go run ./tools/dev tsgo                 # build the pinned compiler; print its path
//	go run ./tools/dev serve                # the design pages, on http://127.0.0.1:8737/
//	go run ./tools/dev shots                # screenshots of the design pages -> .scratch/shots/
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
	"regexp"
	"strings"
	"time"

	"github.com/wisborg/clack/tools/internal/browsertest"
	"github.com/wisborg/clack/tools/internal/bundle"
	"github.com/wisborg/clack/tools/internal/drivers"
	"github.com/wisborg/clack/tools/internal/photos"
	"github.com/wisborg/clack/tools/internal/tsgo"
	"github.com/wisborg/clack/tools/internal/webdriver"
)

// sizeBudget is the most the minified bundle may weigh, gzipped. The plan
// sets it; the build enforces it so that growth is a decision, not a drift.
// Raised from 25 KB to 32 KB on 2026-11-01, with the user, when the
// measured cost of the features still to come showed 25 would not hold
// them in one file (docs/plan.md, "Targets").
const sizeBudget = 32 << 10

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
		{"serve", "serve design/ with the photos, under the strict policy (-addr)", cmdServe},
		{"shots", "screenshot the design pages at desktop and phone size into .scratch/shots/", cmdShots},
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
		srv.Started() // a fresh start for each browser
		report, err := browsertest.Run(ctx, b, driver, srv.URL, !*headed, os.Stderr)
		if err != nil {
			fmt.Printf("%-8s FAILED to run: %v\n", b.Name, err)
			if last := srv.Started(); last != "" {
				fmt.Printf("%-8s it went down during %q\n", "", last)
			}
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
	if r.Hidden {
		fmt.Printf("%-8s NOTE: the test page was hidden during the run (its window behind a full-screen app,\n"+
			"         on another desktop, or minimised), so the browser throttled its timers; timeouts may\n"+
			"         be that, not the code. Run again with the window in view.\n", "")
	}
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

// designServer serves design/ at /, the verified photos at /photos/, and
// Clack's build at /dist/ for the demo pages. build says whether to build
// it first: required, or only attempted (a failed build then breaks the
// demo pages, not the mock-ups, which never load it).
type buildMode int

const (
	noBuild buildMode = iota
	tryBuild
	mustBuild
)

func designServer(ctx context.Context, addr string, build buildMode) (*browsertest.Server, error) {
	if build != noBuild {
		if err := cmdBuild(ctx, nil); err != nil {
			if build == mustBuild {
				return nil, err
			}
			fmt.Fprintf(os.Stderr, "dev serve: the build failed, so the demo pages will not work: %v\n", err)
		}
	}
	list, err := photos.Load("design/photos.json")
	if err != nil {
		return nil, err
	}
	dir, err := photos.Ensure(ctx, list, os.Stderr)
	if err != nil {
		return nil, err
	}
	return browsertest.ServeDirs(addr, map[string]string{"/": "design", "/photos/": dir, "/dist/": "dist"})
}

func cmdServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:8737", "address to listen on; another device can reach it only if this is not loopback")
	if err := parse(fs, args); err != nil {
		return err
	}
	srv, err := designServer(ctx, *addr, tryBuild)
	if err != nil {
		return err
	}
	defer srv.Close()
	fmt.Printf("serving the mock-ups on %smockups/ and the demo on %sdemo/ -- Ctrl-C to stop\n", srv.URL, srv.URL)
	<-ctx.Done()
	return nil
}

// pageCheck reports, once every image on the page has settled, whether the
// page is a real one (not the server's 404) and which images failed to
// load or decode -- a missing photo must fail the run, not leave an empty
// frame in a screenshot that says "ok". The load event does not wait for
// lazily loaded images, which a real index uses, so each is told to load
// now and waited for. On a demo page, the images are those inside each
// <clack-show>, once it has a photo on screen and its fade is over -- not
// its markup's, which a visitor's browser never displays -- and a show
// whose photo could not be loaded counts as a failed image. Both waits
// share one deadline, well inside the session's 30 s script timeout, so a
// page that stalls is reported rather than ending the run.
const pageCheck = `
const done = arguments[arguments.length - 1];
(async () => {
  const deadline = performance.now() + 20000;
  const left = () => Math.max(0, deadline - performance.now());
  const shows = [...document.querySelectorAll("clack-show")];
  const onScreen = (show) => new Promise((resolve) => {
    const look = () => {
      const root = show.shadowRoot;
      const settled = root && root.querySelectorAll(".slide").length === 1 && !root.querySelector(".placeholder");
      if (settled) resolve(); else setTimeout(look, 50);
    };
    look();
  });
  const showsTimedOut = await Promise.race([
    Promise.all(shows.map(onScreen)).then(() => false),
    new Promise((r) => setTimeout(() => r(true), left())),
  ]);
  const imgs = [
    ...[...document.images].filter((img) => !img.closest("clack-show")),
    ...shows.flatMap((s) => [...s.shadowRoot.querySelectorAll("img")]),
  ];
  const settled = imgs.map((img) => {
    img.loading = "eager";
    return img.decode().then(() => null, () => img.currentSrc || img.src);
  });
  const timeout = new Promise((r) => setTimeout(() => r("timeout"), left()));
  const r = await Promise.race([Promise.all(settled), timeout]);
  const missing = shows
    .filter((s) => s.shadowRoot.querySelector(".slide.failed"))
    .map((s) => "a <clack-show> could not load its photo");
  done({
    title: document.title,
    timedOut: showsTimedOut || r === "timeout",
    failed: r === "timeout" ? missing : [...r.filter((x) => x), ...missing],
  });
})().catch((e) => done({title: "", timedOut: false, failed: ["the page check failed: " + e]}));
`

// viewportSize reports the page's viewport.
const viewportSize = `arguments[arguments.length - 1]([innerWidth, innerHeight]);`

// fitViewport sizes the window so that the viewport -- what a screenshot
// shows -- is width by height. A window's outer size includes whatever
// chrome the browser draws, even headless Chrome, so the first resize is
// measured and corrected once, and anything still off is an error rather
// than a screenshot named for a size it is not.
func fitViewport(ctx context.Context, s *webdriver.Session, width, height int) error {
	if err := s.SetWindowSize(ctx, width, height); err != nil {
		return err
	}
	var got [2]int
	if err := s.ExecuteAsync(ctx, viewportSize, nil, &got); err != nil {
		return err
	}
	if got == [2]int{width, height} {
		return nil
	}
	if err := s.SetWindowSize(ctx, 2*width-got[0], 2*height-got[1]); err != nil {
		return err
	}
	if err := s.ExecuteAsync(ctx, viewportSize, nil, &got); err != nil {
		return err
	}
	if got != [2]int{width, height} {
		return fmt.Errorf("asked for a %dx%d viewport and got %dx%d", width, height, got[0], got[1])
	}
	return nil
}

// pageNameRE is what a design page may be called: no path, no extension.
var pageNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// viewport is a size design pages are judged at.
type viewport struct {
	name          string
	width, height int
	phone         bool // emulated as a phone, not set by sizing a window
}

var viewports = []viewport{
	{"desktop", 1440, 900, false},
	{"phone", 390, 844, true},
}

func cmdShots(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("shots", flag.ContinueOnError)
	browserName := fs.String("browser", "chrome", "browser to draw the pages in")
	set := fs.String("set", "mockups", "which pages: mockups (design/mockups/) or demo (design/demo/)")
	only := fs.String("pages", "", "comma-separated page names (default: every page in the set)")
	if err := parse(fs, args); err != nil {
		return err
	}
	b, ok := webdriver.Lookup(*browserName)
	if !ok {
		return usageError{fmt.Sprintf("dev shots: unknown browser %q", *browserName)}
	}
	title, ok := map[string]string{"mockups": "Clack mock-up", "demo": "Clack demo"}[*set]
	if !ok {
		return usageError{fmt.Sprintf("dev shots: -set is mockups or demo, not %q", *set)}
	}
	var pages []string
	if *only != "" {
		for _, p := range strings.Split(*only, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			if !pageNameRE.MatchString(p) {
				return usageError{fmt.Sprintf("dev shots: %q is not a page name", p)}
			}
			if !cacheExists(filepath.Join("design", *set, p+".html")) {
				return usageError{fmt.Sprintf("dev shots: there is no design/%s/%s.html", *set, p)}
			}
			pages = append(pages, p)
		}
	} else {
		matches, err := filepath.Glob(filepath.Join("design", *set, "*.html"))
		if err != nil {
			return err
		}
		for _, m := range matches {
			pages = append(pages, strings.TrimSuffix(filepath.Base(m), ".html"))
		}
	}
	if len(pages) == 0 {
		return usageError{"dev shots: no pages to draw"}
	}

	build := noBuild
	if *set == "demo" {
		build = mustBuild
	}
	srv, err := designServer(ctx, "127.0.0.1:0", build)
	if err != nil {
		return err
	}
	defer srv.Close()
	driver, err := driverFor(ctx, b)
	if err != nil {
		return err
	}
	out := filepath.Join(".scratch", "shots")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	var problems []string
	for _, vp := range viewports {
		found, err := shootViewport(ctx, b, driver, srv.URL, vp, *set, title, pages, out)
		if err != nil {
			return fmt.Errorf("%s: %w", vp.name, err)
		}
		problems = append(problems, found...)
	}
	if len(problems) > 0 {
		// The screenshots are still written, to show what went wrong.
		return errors.New(strings.Join(problems, "\n"))
	}
	return nil
}

// shootViewport draws every page, light and dark, at one viewport size, in
// a session of its own: a phone is emulated from the session's start, and a
// desktop viewport is set by sizing the window. It returns the problems it
// saw on the pages; an error means it could not draw them at all.
func shootViewport(ctx context.Context, b webdriver.Browser, driver, base string, vp viewport, set, title string, pages []string, out string) ([]string, error) {
	o := webdriver.Options{Headless: true}
	if vp.phone {
		o.Phone = &webdriver.Size{Width: vp.width, Height: vp.height}
	}
	d, s, err := browsertest.Open(ctx, b, driver, o, os.Stderr)
	if err != nil {
		return nil, err
	}
	defer d.Stop()
	defer browsertest.CloseSession(ctx, s)

	if err := s.SetScriptTimeout(ctx, 30*time.Second); err != nil {
		return nil, err
	}
	// The viewport is measured on a page of the server's, under the same
	// policy as the design pages.
	if err := s.Navigate(ctx, base+"mockups/index.html"); err != nil {
		return nil, err
	}
	if vp.phone {
		if err := checkViewport(ctx, s, vp.width, vp.height); err != nil {
			return nil, err
		}
	} else if err := fitViewport(ctx, s, vp.width, vp.height); err != nil {
		return nil, err
	}

	var problems []string
	for _, page := range pages {
		for _, scheme := range []string{"light", "dark"} {
			url := fmt.Sprintf("%s%s/%s.html?scheme=%s", base, set, page, scheme)
			if err := s.Navigate(ctx, url); err != nil {
				return nil, err
			}
			var check struct {
				Title    string   `json:"title"`
				TimedOut bool     `json:"timedOut"`
				Failed   []string `json:"failed"`
			}
			if err := s.ExecuteAsync(ctx, pageCheck, nil, &check); err != nil {
				return nil, err
			}
			switch {
			case !strings.HasSuffix(check.Title, title):
				problems = append(problems, fmt.Sprintf("%s: not a design page (title %q)", url, check.Title))
			case check.TimedOut:
				problems = append(problems, fmt.Sprintf("%s: the page or its images still loading after 20 s", url))
			case len(check.Failed) > 0:
				problems = append(problems, fmt.Sprintf("%s: images failed: %s", url, strings.Join(check.Failed, ", ")))
			}
			png, err := s.Screenshot(ctx)
			if err != nil {
				return nil, err
			}
			prefix := ""
			if set != "mockups" {
				prefix = set + "-"
			}
			name := filepath.Join(out, fmt.Sprintf("%s%s-%s-%s.png", prefix, page, scheme, vp.name))
			if err := os.WriteFile(name, png, 0o644); err != nil {
				return nil, err
			}
			fmt.Println(name)
		}
	}
	return problems, nil
}

// checkViewport requires the viewport to be width by height.
func checkViewport(ctx context.Context, s *webdriver.Session, width, height int) error {
	var got [2]int
	if err := s.ExecuteAsync(ctx, viewportSize, nil, &got); err != nil {
		return err
	}
	if got != [2]int{width, height} {
		return fmt.Errorf("asked for a %dx%d viewport and got %dx%d", width, height, got[0], got[1])
	}
	return nil
}

func cacheExists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
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
