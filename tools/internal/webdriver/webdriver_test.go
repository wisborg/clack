package webdriver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeReplySuccess(t *testing.T) {
	var got struct {
		SessionID string `json:"sessionId"`
	}
	if err := decodeReply(200, []byte(`{"value":{"sessionId":"abc","capabilities":{}}}`), &got); err != nil {
		t.Fatal(err)
	}
	if got.SessionID != "abc" {
		t.Errorf("sessionId = %q, want abc", got.SessionID)
	}
}

func TestDecodeReplyNullValue(t *testing.T) {
	// Navigate and Close reply {"value": null}; that is success, not an error.
	if err := decodeReply(200, []byte(`{"value":null}`), nil); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeReplyError(t *testing.T) {
	err := decodeReply(500, []byte(`{"value":{"error":"javascript error","message":"x is not defined","stacktrace":""}}`), nil)
	var we *Error
	if !errors.As(err, &we) {
		t.Fatalf("err = %v, want *Error", err)
	}
	if we.Code != "javascript error" || we.Message != "x is not defined" || we.Status != 500 {
		t.Errorf("got %+v", we)
	}
}

func TestDecodeReplyErrorWithoutCode(t *testing.T) {
	// A failure status is a failure even when the body does not say why.
	err := decodeReply(404, []byte(`{"value":{}}`), nil)
	var we *Error
	if !errors.As(err, &we) || we.Code != "unknown error" {
		t.Fatalf("err = %v, want an unknown error", err)
	}
}

func TestDecodeReplyNotJSON(t *testing.T) {
	if err := decodeReply(200, []byte(`<html>proxy error</html>`), nil); err == nil {
		t.Fatal("want an error for a reply that is not JSON")
	}
}

// fakeDriver answers the handful of commands a test run uses, recording what
// it was asked.
type fakeDriver struct {
	t        *testing.T
	requests []string
	bodies   map[string]map[string]any
}

func (f *fakeDriver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := r.Method + " " + r.URL.Path
	f.requests = append(f.requests, key)
	if r.Body != nil {
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			var body map[string]any
			if err := json.Unmarshal(raw, &body); err != nil {
				f.t.Errorf("%s: body is not JSON: %s", key, raw)
			}
			f.bodies[key] = body
		}
	}
	w.Header().Set("Content-Type", "application/json")
	switch key {
	case "POST /session":
		io.WriteString(w, `{"value":{"sessionId":"s1","capabilities":{"browserName":"chrome"}}}`)
	case "POST /session/s1/url", "POST /session/s1/timeouts", "DELETE /session/s1",
		"POST /session/s1/actions", "DELETE /session/s1/actions":
		io.WriteString(w, `{"value":null}`)
	case "GET /session/s1/window":
		io.WriteString(w, `{"value":"w1"}`)
	case "POST /session/s1/window":
		io.WriteString(w, `{"value":null}`)
	case "POST /session/s1/execute/async":
		io.WriteString(w, `{"value":{"passed":3}}`)
	case "GET /session/s1/screenshot":
		io.WriteString(w, `{"value":"`+base64.StdEncoding.EncodeToString([]byte("\x89PNG"))+`"}`)
	default:
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"value":{"error":"unknown command","message":"`+key+`"}}`)
	}
}

func TestSessionFlow(t *testing.T) {
	fake := &fakeDriver{t: t, bodies: map[string]map[string]any{}}
	srv := httptest.NewServer(fake)
	defer srv.Close()

	chrome, _ := Lookup("chrome")
	d := &Driver{browser: chrome, base: srv.URL, client: srv.Client()}
	ctx := context.Background()

	s, err := d.NewSession(ctx, Options{Headless: true})
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "s1" {
		t.Fatalf("session id = %q", s.ID)
	}
	caps := fake.bodies["POST /session"]["capabilities"].(map[string]any)["alwaysMatch"].(map[string]any)
	args := caps["goog:chromeOptions"].(map[string]any)["args"].([]any)
	if !containsArg(args, "--headless=new") {
		t.Errorf("headless chrome args = %v, want --headless=new", args)
	}

	if err := s.Navigate(ctx, "http://127.0.0.1:1/"); err != nil {
		t.Fatal(err)
	}
	if got := fake.bodies["POST /session/s1/url"]["url"]; got != "http://127.0.0.1:1/" {
		t.Errorf("navigate url = %v", got)
	}

	var result struct {
		Passed int `json:"passed"`
	}
	if err := s.ExecuteAsync(ctx, "arguments[0]({passed: 3})", nil, &result); err != nil {
		t.Fatal(err)
	}
	if result.Passed != 3 {
		t.Errorf("passed = %d", result.Passed)
	}
	// The protocol requires args to be an array, never null.
	if args, ok := fake.bodies["POST /session/s1/execute/async"]["args"].([]any); !ok || len(args) != 0 {
		t.Errorf("args = %#v, want []", fake.bodies["POST /session/s1/execute/async"]["args"])
	}

	// The page's input sources go to the driver as they are.
	moves := json.RawMessage(`[{"type":"pointer","id":"mouse","actions":[{"type":"pointerMove","x":3,"y":4}]}]`)
	if err := s.PerformActions(ctx, moves); err != nil {
		t.Fatal(err)
	}
	sent, _ := json.Marshal(fake.bodies["POST /session/s1/actions"]["actions"])
	if string(sent) != `[{"actions":[{"type":"pointerMove","x":3,"y":4}],"id":"mouse","type":"pointer"}]` {
		t.Errorf("actions = %s", sent)
	}
	if err := s.ReleaseActions(ctx); err != nil {
		t.Fatal(err)
	}

	// Its own window, by the handle the driver gives it.
	if err := s.FocusWindow(ctx); err != nil {
		t.Fatal(err)
	}
	if got := fake.bodies["POST /session/s1/window"]["handle"]; got != "w1" {
		t.Errorf("switched to window %v, want w1", got)
	}

	png, err := s.Screenshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(png) != "\x89PNG" {
		t.Errorf("screenshot = %q", png)
	}

	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	want := "POST /session,POST /session/s1/url,POST /session/s1/execute/async,POST /session/s1/actions,DELETE /session/s1/actions,GET /session/s1/window,POST /session/s1/window,GET /session/s1/screenshot,DELETE /session/s1"
	if got := strings.Join(fake.requests, ","); got != want {
		t.Errorf("requests:\n got %s\nwant %s", got, want)
	}
}

func TestSafariIgnoresHeadless(t *testing.T) {
	safari, _ := Lookup("safari")
	caps, err := safari.capabilities(Options{Headless: true})
	if err != nil || len(caps) != 1 || caps["browserName"] != "safari" {
		t.Errorf("safari capabilities = %v, %v; Safari has no headless option to pass", caps, err)
	}
}

func TestOnlyChromeEmulatesAPhone(t *testing.T) {
	phone := Options{Phone: &Size{390, 844}}
	for _, b := range Browsers {
		caps, err := b.capabilities(phone)
		if b.Name != "chrome" {
			if err == nil {
				t.Errorf("%s accepted a phone viewport it cannot emulate", b.Name)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		m := caps["goog:chromeOptions"].(map[string]any)["mobileEmulation"].(map[string]any)["deviceMetrics"].(map[string]any)
		if m["width"] != 390 || m["height"] != 844 {
			t.Errorf("chrome device metrics = %v", m)
		}
	}
}

func TestLimitedBuffer(t *testing.T) {
	b := &limitedBuffer{limit: 5}
	n, err := b.Write([]byte("abc"))
	if n != 3 || err != nil {
		t.Fatalf("Write = %d, %v", n, err)
	}
	// A writer that is told fewer bytes were written than it gave would
	// treat that as an error; the buffer claims them all and keeps what fits.
	if n, _ := b.Write([]byte("defgh")); n != 5 {
		t.Errorf("Write = %d, want 5", n)
	}
	if got := b.String(); got != "abcde" {
		t.Errorf("kept %q, want abcde", got)
	}
}

func containsArg(args []any, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}
