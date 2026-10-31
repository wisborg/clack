// Package browsertest runs Clack's tests in real browsers.
//
// The tests are TypeScript, bundled into one script and served from a local
// server on a page with a strict Content-Security-Policy -- the strictest a
// host site could reasonably choose -- so every test also checks that Clack
// works under it. The page reports its results through a promise the
// WebDriver session waits on.
package browsertest

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
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
}

// Serve starts the test server on a free loopback port. files maps a path
// such as "/test.js" to its contents.
func Serve(files map[string][]byte) (*Server, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	return serveOn(l, mux, files)
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
	case strings.HasSuffix(path, ".map"):
		return "application/json"
	}
	return "application/octet-stream"
}

// Report is what the test page hands back.
type Report struct {
	UserAgent string   `json:"userAgent"`
	Results   []Result `json:"results"`
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

// waitScript waits for the promise the test bundle leaves on window.
const waitScript = `
const done = arguments[arguments.length - 1];
const run = window.clackTestRun;
if (!run) {
  done({error: "the test bundle did not start: window.clackTestRun is missing"});
  return;
}
run.then(done, (e) => done({error: String((e && e.stack) || e)}));
`

// scriptTimeout bounds the whole test run in one browser. The harness keeps
// well inside it (see runBudgetMs in test/harness.ts), so that a slow run
// still comes back as a report rather than as a WebDriver timeout.
const scriptTimeout = 10 * time.Minute

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
	var report Report
	if err := s.ExecuteAsync(ctx, waitScript, nil, &report); err != nil {
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
