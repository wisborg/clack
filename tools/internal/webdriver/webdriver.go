// Package webdriver is a minimal client for the W3C WebDriver protocol: just
// enough to open a page in a real browser, run a script in it, and take a
// screenshot.
//
// It talks to the browser vendors' own drivers -- safaridriver (shipped with
// macOS), chromedriver and geckodriver -- over HTTP and JSON, using the
// standard library alone. WebDriver "classic" is deliberately the protocol:
// it is the one all three engines speak today, so one client covers Safari,
// Chrome and Firefox. The bidirectional protocol (WebDriver BiDi) is not yet
// spoken by safaridriver.
package webdriver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

// Browser describes how to start one browser's driver and ask it for a
// session.
type Browser struct {
	// Name is how the browser is selected on the command line.
	Name string
	// Driver is the driver program's name, looked up on PATH when Start is
	// not given a path.
	Driver string
	// args returns the driver's arguments for listening on port.
	args func(port int) []string
	// capabilities returns the session capabilities for o, or an error if
	// the browser cannot do what o asks. o.Headless is ignored by a browser
	// that has no headless mode.
	capabilities func(o Options) (map[string]any, error)
}

// Options says what kind of session to start.
type Options struct {
	// Headless runs the browser without a window, where it can.
	Headless bool
	// Phone, when set, emulates a phone's viewport of this many CSS pixels.
	// Only Chrome can: a desktop browser's window has a minimum width wider
	// than a phone's (500 px for headless Chrome).
	Phone *Size
}

// Size is a viewport size in CSS pixels.
type Size struct{ Width, Height int }

func noPhone(name string, o Options) error {
	if o.Phone != nil {
		return fmt.Errorf("%s cannot emulate a phone's viewport; use chrome", name)
	}
	return nil
}

// Browsers are the engines Clack is tested on, in the order they are run.
var Browsers = []Browser{
	{
		Name:   "safari",
		Driver: "safaridriver",
		args:   func(port int) []string { return []string{"-p", strconv.Itoa(port)} },
		// Safari has no headless mode: a window opens for the duration.
		capabilities: func(o Options) (map[string]any, error) {
			return map[string]any{"browserName": "safari"}, noPhone("safari", o)
		},
	},
	{
		Name:   "chrome",
		Driver: "chromedriver",
		args:   func(port int) []string { return []string{"--port=" + strconv.Itoa(port)} },
		capabilities: func(o Options) (map[string]any, error) {
			args := []string{"--window-size=1280,900"}
			if o.Headless {
				args = append(args, "--headless=new")
			}
			opts := map[string]any{"args": args}
			if o.Phone != nil {
				opts["mobileEmulation"] = map[string]any{
					"deviceMetrics": map[string]any{
						"width": o.Phone.Width, "height": o.Phone.Height,
						"pixelRatio": 1, "touch": true, "mobile": true,
					},
				}
			}
			return map[string]any{"browserName": "chrome", "goog:chromeOptions": opts}, nil
		},
	},
	{
		Name:   "firefox",
		Driver: "geckodriver",
		args:   func(port int) []string { return []string{"--port", strconv.Itoa(port)} },
		capabilities: func(o Options) (map[string]any, error) {
			args := []string{"-width=1280", "-height=900"}
			if o.Headless {
				args = append(args, "-headless")
			}
			return map[string]any{
				"browserName":        "firefox",
				"moz:firefoxOptions": map[string]any{"args": args},
			}, noPhone("firefox", o)
		},
	},
}

// Lookup returns the browser called name.
func Lookup(name string) (Browser, bool) {
	for _, b := range Browsers {
		if b.Name == name {
			return b, true
		}
	}
	return Browser{}, false
}

// ErrDriverMissing is returned by Start when no path is given and the
// driver program is not on PATH.
var ErrDriverMissing = errors.New("driver not found on PATH")

// Driver is a running driver process.
type Driver struct {
	browser Browser
	base    string
	client  *http.Client
	cmd     *exec.Cmd
	output  *limitedBuffer
	exited  chan struct{}
}

// Start runs b's driver -- the program at path, or b.Driver from PATH if
// path is empty -- on a free local port, and waits until it reports that it
// is ready to create sessions.
func Start(ctx context.Context, b Browser, path string) (*Driver, error) {
	if path == "" {
		p, err := exec.LookPath(b.Driver)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", b.Driver, ErrDriverMissing)
		}
		path = p
	}
	port, err := freePort()
	if err != nil {
		return nil, err
	}

	out := &limitedBuffer{limit: 64 << 10}
	cmd := exec.Command(path, b.args(port)...)
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s: %w", b.Driver, err)
	}
	d := &Driver{
		browser: b,
		base:    "http://127.0.0.1:" + strconv.Itoa(port),
		client:  &http.Client{},
		cmd:     cmd,
		output:  out,
		exited:  make(chan struct{}),
	}
	go func() {
		_ = cmd.Wait()
		close(d.exited)
	}()

	if err := d.waitReady(ctx, 20*time.Second); err != nil {
		d.Stop()
		return nil, err
	}
	return d, nil
}

// waitReady polls the driver's status endpoint until it says it is ready.
func (d *Driver) waitReady(ctx context.Context, limit time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	for {
		var status struct {
			Ready   bool   `json:"ready"`
			Message string `json:"message"`
		}
		err := d.command(ctx, http.MethodGet, "/status", nil, &status)
		if err == nil && status.Ready {
			return nil
		}
		select {
		case <-d.exited:
			return fmt.Errorf("%s exited before it was ready:\n%s", d.browser.Driver, d.output)
		case <-ctx.Done():
			if err == nil {
				err = errors.New(status.Message)
			}
			return fmt.Errorf("%s not ready after %s: %v", d.browser.Driver, limit, err)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Output is what the driver has written so far, for diagnosing a failure.
func (d *Driver) Output() string { return d.output.String() }

// Stop ends the driver process.
func (d *Driver) Stop() {
	if d.cmd.Process != nil {
		_ = d.cmd.Process.Kill()
	}
	<-d.exited
}

// Session is one browser session: a browser window under the driver's
// control.
type Session struct {
	d  *Driver
	ID string
}

// NewSession opens the browser.
func (d *Driver) NewSession(ctx context.Context, o Options) (*Session, error) {
	caps, err := d.browser.capabilities(o)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"capabilities": map[string]any{"alwaysMatch": caps},
	}
	var created struct {
		SessionID string `json:"sessionId"`
	}
	if err := d.command(ctx, http.MethodPost, "/session", body, &created); err != nil {
		return nil, fmt.Errorf("%s: new session: %w", d.browser.Name, err)
	}
	if created.SessionID == "" {
		return nil, fmt.Errorf("%s: new session: no session id in the reply", d.browser.Name)
	}
	return &Session{d: d, ID: created.SessionID}, nil
}

func (s *Session) path(p string) string { return "/session/" + s.ID + p }

// Navigate loads url and waits for the page to finish loading.
func (s *Session) Navigate(ctx context.Context, url string) error {
	return s.d.command(ctx, http.MethodPost, s.path("/url"), map[string]any{"url": url}, nil)
}

// SetScriptTimeout bounds how long ExecuteAsync waits for its script.
func (s *Session) SetScriptTimeout(ctx context.Context, t time.Duration) error {
	body := map[string]any{"script": t.Milliseconds()}
	return s.d.command(ctx, http.MethodPost, s.path("/timeouts"), body, nil)
}

// ExecuteAsync runs script as the body of a function in the page. The
// function's last argument is a callback; the value it is called with is
// decoded into result.
func (s *Session) ExecuteAsync(ctx context.Context, script string, args []any, result any) error {
	if args == nil {
		args = []any{}
	}
	body := map[string]any{"script": script, "args": args}
	return s.d.command(ctx, http.MethodPost, s.path("/execute/async"), body, result)
}

// SetWindowSize resizes the browser window. In a headless browser the
// window is the viewport, so this is how a phone-sized page is drawn.
func (s *Session) SetWindowSize(ctx context.Context, width, height int) error {
	body := map[string]any{"width": width, "height": height}
	return s.d.command(ctx, http.MethodPost, s.path("/window/rect"), body, nil)
}

// Screenshot returns a PNG of the browser's viewport.
func (s *Session) Screenshot(ctx context.Context) ([]byte, error) {
	var encoded string
	if err := s.d.command(ctx, http.MethodGet, s.path("/screenshot"), nil, &encoded); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(encoded)
}

// Close ends the session and closes the browser.
func (s *Session) Close(ctx context.Context) error {
	return s.d.command(ctx, http.MethodDelete, s.path(""), nil, nil)
}

// Error is an error reported by the driver, in the protocol's own terms.
type Error struct {
	Status  int    // the HTTP status
	Code    string // the WebDriver error code, such as "javascript error"
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s (HTTP %d): %s", e.Code, e.Status, e.Message)
}

// command sends one WebDriver command and decodes the reply's "value" into
// out, which may be nil.
func (d *Driver) command(ctx context.Context, method, path string, body, out any) error {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, reqBody)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return err
	}
	return decodeReply(resp.StatusCode, raw, out)
}

// decodeReply interprets a WebDriver reply: {"value": ...} on success, and
// {"value": {"error", "message"}} with a non-2xx status on failure.
func decodeReply(status int, raw []byte, out any) error {
	var reply struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return fmt.Errorf("HTTP %d: reply is not WebDriver JSON: %.200s", status, raw)
	}
	if status < 200 || status > 299 {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(reply.Value, &e)
		if e.Error == "" {
			e.Error = "unknown error"
		}
		return &Error{Status: status, Code: e.Error, Message: e.Message}
	}
	if out == nil || len(reply.Value) == 0 {
		return nil
	}
	if err := json.Unmarshal(reply.Value, out); err != nil {
		return fmt.Errorf("decoding reply value: %w", err)
	}
	return nil
}

// freePort asks the system for a port nobody is listening on. Another
// program could take it before the driver does; the driver then fails to
// start, which is reported, not hidden.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// limitedBuffer keeps the first limit bytes written to it, safely across
// goroutines, and drops the rest.
type limitedBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.limit - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
