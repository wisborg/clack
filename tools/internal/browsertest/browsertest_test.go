package browsertest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestServeSendsThePolicyWithEveryFile(t *testing.T) {
	s, err := Serve(map[string][]byte{"/test.js": []byte("export {}")})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, path := range []string{"", "test.js"} {
		resp, err := http.Get(s.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("/%s: %s", path, resp.Status)
		}
		if got := resp.Header.Get("Content-Security-Policy"); got != ContentSecurityPolicy {
			t.Errorf("/%s: policy = %q", path, got)
		}
	}
	resp, err := http.Get(s.URL + "test.js")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// Module scripts are refused unless served as JavaScript.
	if ct := resp.Header.Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
		t.Errorf("test.js content type = %q", ct)
	}
}

func TestReportFailed(t *testing.T) {
	for _, tc := range []struct {
		name string
		r    Report
		want bool
	}{
		{"all passed", Report{Results: []Result{{Passed: true}}}, false},
		{"skipped is not failed", Report{Results: []Result{{Passed: true}, {Skipped: "no Trusted Types"}}}, false},
		{"one failed", Report{Results: []Result{{Passed: true}, {Error: "boom"}}}, true},
		{"run error", Report{Error: "bundle did not start"}, true},
	} {
		if got := tc.r.Failed(); got != tc.want {
			t.Errorf("%s: Failed() = %v", tc.name, got)
		}
	}
}

func TestTestImages(t *testing.T) {
	srv, err := Serve(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	get := func(path string) (*http.Response, []byte) {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp, body
	}
	resp, body := get("img/30x20-336699.png?tag=a")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("status %d, type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	img, err := png.Decode(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 30 || b.Dy() != 20 {
		t.Errorf("size %v", b)
	}
	if r, g, b, _ := img.At(29, 0).RGBA(); r>>8 != 0x33 || g>>8 != 0x66 || b>>8 != 0x99 {
		t.Errorf("corner colour %x %x %x", r>>8, g>>8, b>>8)
	}
	for _, bad := range []string{"img/0x20-336699.png", "img/5000x5000-336699.png", "img/30x20-xyz.png", "img/30x20-336699.png?delay=99999"} {
		if resp, _ := get(bad); resp.StatusCode < 400 {
			t.Errorf("%s: status %d", bad, resp.StatusCode)
		}
	}
	if _, err := png.Decode(bytes.NewReader(func() []byte { _, b := get("img/broken.png"); return b }())); err == nil {
		t.Error("broken.png decoded")
	}
	_, logBody := get("img-log")
	var log []string
	json.Unmarshal(logBody, &log)
	if len(log) != 6 || log[0] != "/img/30x20-336699.png?tag=a" {
		t.Errorf("log = %v", log)
	}
	r, err := http.Post(srv.URL+"img-log/reset", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	_, logBody = get("img-log")
	if string(bytes.TrimSpace(logBody)) != "[]" && string(bytes.TrimSpace(logBody)) != "null" {
		t.Errorf("log after reset = %s", logBody)
	}
}

func TestEcho(t *testing.T) {
	srv, err := Serve(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	resp, err := http.Get(srv.URL + "echo/a/b.json?body=%7B%7D&type=text/plain&status=404")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 404 || resp.Header.Get("Content-Type") != "text/plain" || string(body) != "{}" {
		t.Errorf("echo: %d %q %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	resp, err = http.Get(srv.URL + "big?bytes=100000&declare=1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if len(body) != 100002 || resp.ContentLength != 100002 {
		t.Errorf("big: %d bytes, declared %d", len(body), resp.ContentLength)
	}
	resp, err = http.Get(srv.URL + "redirect?to=/echo/x.json%3Fbody%3D1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.Request.URL.Path != "/echo/x.json" || string(body) != "1" {
		t.Errorf("redirect: ended at %s with %q", resp.Request.URL, body)
	}
	for _, elsewhere := range []string{"//example.com/", "/%5Cexample.com", "/%09/example.com", "https://example.com/", "x"} {
		resp, err = http.Get(srv.URL + "redirect?to=" + elsewhere)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Errorf("redirect to %s: %d", elsewhere, resp.StatusCode)
		}
	}
}

func TestStartedRemembersTheLastTest(t *testing.T) {
	srv, err := Serve(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	for _, name := range []string{"first", "second"} {
		resp, err := http.Post(srv.URL+"progress", "text/plain", strings.NewReader(name))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	if got := srv.Started(); got != "second" {
		t.Errorf("Started() = %q, want second", got)
	}
	if got := srv.Started(); got != "" {
		t.Errorf("Started() again = %q, want it forgotten", got)
	}
}

// fakePage answers drive's rounds from a script: each ExecuteAsync records
// the answer it was given and returns the next message.
type fakePage struct {
	messages []string // JSON, one per round
	answers  []any
	runs     []any
	did      []string
	fail     error  // what giving input -- performing, releasing, focusing -- returns
	block    bool   // whether giving input waits for its context to end
	then     func() // called once input is given
	causeErr bool   // whether blocked input fails with the context's cause, as an HTTP call does
}

func (f *fakePage) ExecuteAsync(ctx context.Context, script string, args []any, result any) error {
	if len(args) != 2 {
		return fmt.Errorf("args = %v, want the answer and the run", args)
	}
	f.answers = append(f.answers, args[0])
	f.runs = append(f.runs, args[1])
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(f.messages) == 0 {
		return errors.New("asked for a round past the last")
	}
	m := f.messages[0]
	f.messages = f.messages[1:]
	return json.Unmarshal([]byte(m), result)
}

func (f *fakePage) PerformActions(ctx context.Context, actions json.RawMessage) error {
	return f.give(ctx, "perform "+string(actions))
}

func (f *fakePage) ReleaseActions(ctx context.Context) error { return f.give(ctx, "release") }

func (f *fakePage) FocusWindow(ctx context.Context) error { return f.give(ctx, "focus") }

// give records what was done, calls then, and blocks or fails as f says.
func (f *fakePage) give(ctx context.Context, what string) error {
	f.did = append(f.did, what)
	if f.then != nil {
		f.then()
	}
	if f.block {
		<-ctx.Done()
		if f.fail != nil {
			return f.fail // a driver failing just as the context ended
		}
		if f.causeErr {
			return fmt.Errorf("Post: %w", context.Cause(ctx))
		}
		return ctx.Err()
	}
	return f.fail
}

func TestDriveGivesThePageItsInputAndAnswers(t *testing.T) {
	f := &fakePage{messages: []string{
		`{"run": "r1", "input": [{"type": "key", "id": "k", "actions": []}]}`,
		`{"run": "r1", "release": true}`,
		`{"focus": true}`,
		`{"report": {"userAgent": "fake", "results": [{"name": "a", "passed": true}]}}`,
	}}
	r, err := drive(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if r.UserAgent != "fake" || len(r.Results) != 1 {
		t.Errorf("report = %+v", r)
	}
	want := []string{`perform [{"type": "key", "id": "k", "actions": []}]`, "release", "focus"}
	if fmt.Sprint(f.did) != fmt.Sprint(want) {
		t.Errorf("did %q, want %q", f.did, want)
	}
	// Nothing asked at first; then each done.
	if fmt.Sprintf("%#v", f.answers) != `[]interface {}{interface {}(nil), "", "", ""}` {
		t.Errorf("answers = %#v", f.answers)
	}
	// Of no run at first; then of the run the page named, every time.
	if fmt.Sprintf("%#v", f.runs) != `[]interface {}{interface {}(nil), "r1", "r1", "r1"}` {
		t.Errorf("runs = %#v", f.runs)
	}
}

func TestDriveTellsThePageWhatTheDriverCouldNotDo(t *testing.T) {
	f := &fakePage{
		messages: []string{`{"input": []}`, `{"report": {"error": "stopped"}}`},
		fail:     errors.New("move target out of bounds"),
	}
	r, err := drive(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if r.Error != "stopped" {
		t.Errorf("report = %+v", r)
	}
	if len(f.answers) != 2 || f.answers[1] != "move target out of bounds" {
		t.Errorf("answers = %#v, want the driver's error given back", f.answers)
	}
}

func TestDriveTellsAPageThatWentFromOneThatNeverStarted(t *testing.T) {
	r, err := drive(context.Background(), &fakePage{messages: []string{`{"gone": true}`}})
	if err != nil || !strings.Contains(r.Error, "did not start") {
		t.Errorf("first round: report %+v, error %v; want the bundle not started", r, err)
	}
	f := &fakePage{messages: []string{`{"release": true}`, `{"gone": true}`}}
	if _, err := drive(context.Background(), f); err == nil || !strings.Contains(err.Error(), "went away") {
		t.Errorf("a later round: error %v, want the page gone", err)
	}
}

func TestDriveGivesUpOnADriverThatNeverAnswers(t *testing.T) {
	defer func(was time.Duration) { inputTimeout = was }(inputTimeout)
	inputTimeout = 20 * time.Millisecond
	f := &fakePage{messages: []string{`{"focus": true}`, `{"report": {}}`}, block: true}
	// Cut off by its own deadline, not the run's -- and the run ends: the
	// driver may still be doing it.
	_, err := drive(context.Background(), f)
	if !errors.Is(err, context.DeadlineExceeded) || len(f.answers) != 1 {
		t.Errorf("error %v after %d rounds, want the deadline after the first", err, len(f.answers))
	}
}

func TestDriveSaysWhenTheRunsDeadlinePassed(t *testing.T) {
	defer func(was time.Duration) { runTimeout = was }(runTimeout)
	runTimeout = 20 * time.Millisecond
	f := &fakePage{messages: []string{`{"focus": true}`}, block: true}
	if _, err := drive(context.Background(), f); err == nil || err.Error() != "the run did not end within 20ms: context deadline exceeded" || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error %v, want the run's deadline named", err)
	}
}

func TestDriveSaysNothingMoreOfACallTheDeadlineCut(t *testing.T) {
	defer func(was time.Duration) { runTimeout = was }(runTimeout)
	runTimeout = 20 * time.Millisecond
	// As the HTTP client gives it: the call failed with the deadline's cause.
	f := &fakePage{messages: []string{`{"focus": true}`}, block: true, causeErr: true}
	_, err := drive(context.Background(), f)
	if err == nil || err.Error() != "the run did not end within 20ms: context deadline exceeded" {
		t.Errorf("error %v, want the run's deadline alone", err)
	}
}

func TestDriveKeepsADriversOwnFailingAtTheDeadline(t *testing.T) {
	defer func(was time.Duration) { runTimeout = was }(runTimeout)
	runTimeout = 20 * time.Millisecond
	// The browser gone just as the run's deadline passed: both said.
	f := &fakePage{messages: []string{`{"focus": true}`}, fail: errors.New("session deleted"), block: true}
	_, err := drive(context.Background(), f)
	if err == nil || !strings.Contains(err.Error(), "did not end") || !strings.Contains(err.Error(), "session deleted") {
		t.Errorf("error %v, want the deadline and the driver's own failing", err)
	}
}

func TestDriveLeavesTheCallersEndAsItIs(t *testing.T) {
	// A deadline of the caller's own: not called the run's.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := drive(ctx, &fakePage{messages: []string{`{"focus": true}`}, block: true}); !errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "did not end") {
		t.Errorf("error %v, want the caller's deadline as it is", err)
	}
	// Cancelled before the first round.
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	if _, err := drive(ctx, &fakePage{messages: []string{`{"report": {}}`}}); !errors.Is(err, context.Canceled) {
		t.Errorf("error %v, want the cancelling", err)
	}
	// Cancelled as the driver failed on its own: still the cancelling.
	ctx, cancel = context.WithCancel(context.Background())
	f := &fakePage{messages: []string{`{"release": true}`}, fail: errors.New("EOF"), then: cancel}
	if _, err := drive(ctx, f); !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "EOF") {
		t.Errorf("error %v, want the cancelling, and what the driver said", err)
	}
	// Cancelled (Ctrl-C) just as what the page asked was done: an error
	// still, not a run of nothing.
	ctx, cancel = context.WithCancel(context.Background())
	f = &fakePage{messages: []string{`{"focus": true}`, `{"report": {}}`}, then: cancel}
	if _, err := drive(ctx, f); !errors.Is(err, context.Canceled) {
		t.Errorf("error %v, want the cancelling", err)
	}
}

func TestDriveGivesADriversFailingAsItIs(t *testing.T) {
	// A round failing with the run going on (the browser gone, say): the
	// driver's own words, and nothing made of a context that did not end.
	_, err := drive(context.Background(), &fakePage{})
	if err == nil || err.Error() != "asked for a round past the last" {
		t.Errorf("error %v, want the driver's own", err)
	}
}

func TestDriveRefusesAMessageItDoesNotKnow(t *testing.T) {
	f := &fakePage{messages: []string{`{"scroll": 3}`}}
	if _, err := drive(context.Background(), f); err == nil {
		t.Error("drive took a message it does not know")
	}
}
