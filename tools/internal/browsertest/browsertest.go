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
	s := &Server{
		URL: "http://" + l.Addr().String() + "/",
		srv: &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second},
	}
	go s.srv.Serve(l)
	return s, nil
}

// Close stops the server.
func (s *Server) Close() error { return s.srv.Close() }

func headers(w http.ResponseWriter, ct string) {
	h := w.Header()
	h.Set("Content-Type", ct)
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

// Run opens url in b, driven by the driver at driverPath (or found on PATH
// when it is empty), and returns the test page's report.
func Run(ctx context.Context, b webdriver.Browser, driverPath, url string, headless bool) (Report, error) {
	d, err := webdriver.Start(ctx, b, driverPath)
	if err != nil {
		return Report{}, err
	}
	defer d.Stop()

	s, err := d.NewSession(ctx, headless)
	if err != nil {
		return Report{}, withOutput(err, d)
	}
	defer s.Close(context.WithoutCancel(ctx))

	if err := s.SetScriptTimeout(ctx, 2*time.Minute); err != nil {
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

func withOutput(err error, d *webdriver.Driver) error {
	if out := strings.TrimSpace(d.Output()); out != "" {
		return fmt.Errorf("%w\ndriver output:\n%s", err, out)
	}
	return err
}
