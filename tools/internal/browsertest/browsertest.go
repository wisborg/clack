// Package browsertest runs Clack's tests in real browsers.
//
// The tests are TypeScript, bundled into one script and served from a local
// server on a page with a strict Content-Security-Policy -- the strictest a
// host site could reasonably choose -- so every test also checks that Clack
// works under it. The page reports its results to the WebDriver session
// waiting on it, and asks it, between, for the visitor's own input (drive).
package browsertest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/wisborg/clack/tools/internal/webdriver"
)

// ContentSecurityPolicy is the policy the test page is served under. It
// allows scripts and styles from the page's own origin only: no inline
// script or style, no eval, no Trusted Types policies at all (so any
// assignment of a string to a DOM sink such as innerHTML throws in engines
// that enforce Trusted Types), and nothing from anywhere else.
const ContentSecurityPolicy = "default-src 'none'; " +
	"script-src 'self'; " +
	"style-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"connect-src 'self'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'; " +
	"require-trusted-types-for 'script'; " +
	"trusted-types 'none'"

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clack tests</title>
<script type="module" src="/test.js"></script>
</head>
<body>
<main id="fixtures"></main>
</body>
</html>
`

// Server serves the test page and the bundled tests.
type Server struct {
	URL string
	srv *http.Server

	mu   sync.Mutex
	last string // the test last started (see Started)
}

// Started returns the name of the test the page last said it was
// starting, and forgets it: when a browser goes down mid-run, the test it
// went down in.
func (s *Server) Started() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	last := s.last
	s.last = ""
	return last
}

// Serve starts the test server on a free loopback port. files maps a path
// such as "/test.js" to its contents. It also serves made-up images for the
// tests (see testImages), and manifests of any kind (see registerEcho).
func Serve(files map[string][]byte) (*Server, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	images := &testImages{}
	images.register(mux)
	registerEcho(mux, images)
	srv, err := serveOn(l, mux, files)
	if err != nil {
		return nil, err
	}
	mux.HandleFunc("POST /progress", func(w http.ResponseWriter, r *http.Request) {
		name, _ := io.ReadAll(io.LimitReader(r.Body, 1000))
		srv.mu.Lock()
		srv.last = string(name)
		srv.mu.Unlock()
		securityHeaders(w)
		w.WriteHeader(http.StatusNoContent)
	})
	return srv, nil
}

// ServeDirs starts a server on addr ("127.0.0.1:0" for any free port)
// serving each directory under its URL prefix, such as "/photos/", with the
// same strict policy as the test page -- so a design page that would need
// the policy loosened is found out while it is still a mock-up.
func ServeDirs(addr string, dirs map[string]string) (*Server, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	for prefix, dir := range dirs {
		fs := http.StripPrefix(prefix, http.FileServerFS(os.DirFS(dir)))
		mux.Handle("GET "+prefix, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			securityHeaders(w)
			fs.ServeHTTP(w, r)
		}))
	}
	return start(l, mux), nil
}

// start serves mux on l.
func start(l net.Listener, mux *http.ServeMux) *Server {
	s := &Server{
		URL: "http://" + l.Addr().String() + "/",
		srv: &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second},
	}
	go s.srv.Serve(l)
	return s
}

func serveOn(l net.Listener, mux *http.ServeMux, files map[string][]byte) (*Server, error) {
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		headers(w, "text/html; charset=utf-8")
		io.WriteString(w, page)
	})
	for path, body := range files {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			headers(w, contentType(path))
			w.Write(body)
		})
	}
	return start(l, mux), nil
}

// Close stops the server.
func (s *Server) Close() error { return s.srv.Close() }

func headers(w http.ResponseWriter, ct string) {
	w.Header().Set("Content-Type", ct)
	securityHeaders(w)
}

// securityHeaders sets what every response from a test or design server
// carries: the strict policy, and no sniffing or caching.
func securityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Security-Policy", ContentSecurityPolicy)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
}

func contentType(path string) string {
	switch {
	case strings.HasSuffix(path, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(path, ".map"), strings.HasSuffix(path, ".json"):
		return "application/json"
	}
	return "application/octet-stream"
}

// Report is what the test page hands back.
type Report struct {
	UserAgent string `json:"userAgent"`
	// Hidden says the page was hidden during the run, when the browser
	// throttles timers and stops animations: see test/harness.ts.
	Hidden  bool     `json:"hidden"`
	Results []Result `json:"results"`
	// Error is set when the test run itself failed, not one test.
	Error string `json:"error"`
}

// Result is one test's outcome.
type Result struct {
	Name    string  `json:"name"`
	Passed  bool    `json:"passed"`
	Skipped string  `json:"skipped"` // why, when the engine cannot run it
	Error   string  `json:"error"`
	Millis  float64 `json:"ms"`
}

// Failed reports whether anything in the run failed.
func (r Report) Failed() bool {
	if r.Error != "" {
		return true
	}
	for _, t := range r.Results {
		if !t.Passed && t.Skipped == "" {
			return true
		}
	}
	return false
}

// nextScript hands the page the answer to what it last asked of the driver
// (null at first, then an error's text, or "" if it was done), and waits for
// what it asks next: input to perform, or the run's report. See clackNext in
// test/harness.ts.
// It hands back, too, the run the page named in its first message: a page
// reloaded between rounds has a run of its own, started afresh, and says
// so (gone) rather than take another run's answer for its own.
const nextScript = `
const [answer, run] = arguments;
const done = arguments[arguments.length - 1];
const next = window.clackNext;
if (!next) {
  done({gone: true});
  return;
}
next(answer, run).then(done, (e) => done({report: {error: String((e && e.stack) || e)}}));
`

// message is what the page asks of the driver: exactly one of these.
type message struct {
	// Input is WebDriver input sources to perform, as the visitor's own.
	Input json.RawMessage `json:"input"`
	// Release lets go of whatever input left pressed: after each test that
	// gave any, so that nothing of it is held into the next.
	Release bool `json:"release"`
	// Focus gives the page's window the focus, for a test of what focus
	// does: without it, focusing fires no focus events.
	Focus bool `json:"focus"`
	// Report ends the run.
	Report *Report `json:"report"`
	// Gone says the page has no test run to follow: the bundle did not
	// start, or -- after the first round -- the page went away.
	Gone bool `json:"gone"`
	// Run names the page's run, in every message: handed back with each
	// answer, so a page started afresh is not given another's.
	Run string `json:"run"`
}

// inputTimeout bounds each thing done for the page between rounds, as
// scriptTimeout bounds the rounds and runTimeout all of them: a driver that
// never answers ends the run with an error rather than holding it open
// with no report. Each is quick -- a pointer moved, a key pressed -- so
// this is far past what any takes. A variable, for the tests to shorten.
var inputTimeout = 30 * time.Second

// runTimeout bounds the whole run in one browser, all its rounds together.
// The page keeps well inside it (runBudgetMs in test/harness.ts), with
// room for what is done for it between its tests, so that a slow run still
// comes back as a report of what passed and what did not.
const runTimeout = 10 * time.Minute

// driven is what drive needs of a WebDriver session.
type driven interface {
	ExecuteAsync(ctx context.Context, script string, args []any, result any) error
	PerformActions(ctx context.Context, actions json.RawMessage) error
	ReleaseActions(ctx context.Context) error
	FocusWindow(ctx context.Context) error
}

// drive runs the tests on p, a page with the test bundle loaded, to their
// report. WebDriver takes one command at a time, and a script waiting in
// the page is one: so the run goes in rounds -- the page waits for what it
// needs of the driver, the driver does it, and calls back in with the
// answer.
func drive(ctx context.Context, p driven) (Report, error) {
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	var answer, run any // null: nothing asked yet, of no run yet
	for round := 0; ; round++ {
		var m message
		if err := p.ExecuteAsync(ctx, nextScript, []any{answer, run}, &m); err != nil {
			return Report{}, err
		}
		if run == nil {
			run = m.Run
		}
		if m.Gone && round == 0 {
			return Report{Error: "the test bundle did not start: window.clackNext is missing"}, nil
		}
		if m.Gone {
			// What the page had found went with it: say so, rather than
			// report a run of nothing, or the one it starts again.
			return Report{}, errors.New("the test page went away during the run (it navigated, or was reloaded)")
		}
		if m.Report != nil {
			return *m.Report, nil
		}
		err := do(ctx, p, m)
		if errors.Is(err, errUnknown) {
			return Report{}, err
		}
		if ctx.Err() != nil {
			return Report{}, fmt.Errorf("the run did not end within %v: %w", runTimeout, ctx.Err())
		}
		if errors.Is(err, context.DeadlineExceeded) {
			// Cut off, the driver may still be doing it: what it does
			// late would land in a later test. Not a run to go on with.
			return Report{}, fmt.Errorf("the driver did not finish what the page asked within %v: %w", inputTimeout, err)
		}
		answer = ""
		if err != nil {
			// The page's to report, in the test that asked; a driver that
			// has gone is found out by the next round.
			answer = err.Error()
		}
	}
}

var errUnknown = errors.New("the page asked the driver for nothing it knows")

// do does for the page what m asks, within inputTimeout.
func do(ctx context.Context, p driven, m message) error {
	ctx, cancel := context.WithTimeout(ctx, inputTimeout)
	defer cancel()
	switch {
	case m.Release:
		return p.ReleaseActions(ctx)
	case m.Focus:
		return p.FocusWindow(ctx)
	case m.Input != nil:
		return p.PerformActions(ctx, m.Input)
	}
	return errUnknown
}

// scriptTimeout bounds each round of the test run in one browser (drive),
// as inputTimeout bounds what is done between rounds; it is runTimeout, as
// a run with no input is one round.
const scriptTimeout = runTimeout

// Run opens url in b, driven by the driver at driverPath (or found on PATH
// when it is empty), and returns the test page's report. Notes on what it
// did besides are written to log.
func Run(ctx context.Context, b webdriver.Browser, driverPath, url string, headless bool, log io.Writer) (Report, error) {
	o := webdriver.Options{Headless: headless}
	// A browser can end its first process straight after starting --
	// Firefox does, after applying a downloaded update, and restarts itself
	// -- which the driver reports as a failed session. A second start finds
	// nothing left to apply. Open retries once, which covers that without
	// guessing at any driver's wording; a failure that persists is reported
	// as it was.
	d, s, err := Open(ctx, b, driverPath, o, log)
	if err != nil {
		return Report{}, err
	}
	defer d.Stop()
	defer CloseSession(ctx, s)

	if err := s.SetScriptTimeout(ctx, scriptTimeout); err != nil {
		return Report{}, err
	}
	if err := s.Navigate(ctx, url); err != nil {
		return Report{}, err
	}
	report, err := drive(ctx, s)
	if err != nil {
		return Report{}, err
	}
	if len(report.Results) == 0 && report.Error == "" {
		report.Error = "the page reported no tests"
	}
	return report, nil
}

// CloseSession closes s within a bounded time, so that a browser that has
// stopped answering cannot hold the program open, even after Ctrl-C has
// cancelled ctx.
func CloseSession(ctx context.Context, s *webdriver.Session) {
	closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	s.Close(closeCtx)
}

// Open starts b's driver and a session in it, retrying once as Run does.
// The caller stops the driver when done.
func Open(ctx context.Context, b webdriver.Browser, driverPath string, o webdriver.Options, log io.Writer) (*webdriver.Driver, *webdriver.Session, error) {
	d, s, err := open(ctx, b, driverPath, o)
	if err != nil {
		fmt.Fprintf(log, "%s: could not start a session; trying once more (%v)\n", b.Name, firstLine(err))
		d, s, err = open(ctx, b, driverPath, o)
	}
	return d, s, err
}

// open starts b's driver and a session in it.
func open(ctx context.Context, b webdriver.Browser, driverPath string, o webdriver.Options) (*webdriver.Driver, *webdriver.Session, error) {
	d, err := webdriver.Start(ctx, b, driverPath)
	if err != nil {
		return nil, nil, err
	}
	s, err := d.NewSession(ctx, o)
	if err != nil {
		err = withOutput(err, d)
		d.Stop()
		return nil, nil, err
	}
	return d, s, nil
}

func firstLine(err error) string {
	line, _, _ := strings.Cut(err.Error(), "\n")
	return line
}

func withOutput(err error, d *webdriver.Driver) error {
	if out := strings.TrimSpace(d.Output()); out != "" {
		return fmt.Errorf("%w\ndriver output:\n%s", err, out)
	}
	return err
}
