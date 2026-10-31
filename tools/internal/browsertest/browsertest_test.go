package browsertest

import (
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
