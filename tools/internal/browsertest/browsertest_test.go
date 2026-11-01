package browsertest

import (
	"bytes"
	"encoding/json"
	"image/png"
	"io"
	"net/http"
	"testing"
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
