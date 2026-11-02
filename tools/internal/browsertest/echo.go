package browsertest

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// registerEcho adds what the manifest tests fetch:
//
//	GET /echo/{path...}?body=..&type=..&status=..&delay=..
//	    answers with body, as type (default application/json), with status
//	    (default 200), after delay ms (at most 10 s). The path is free, so a
//	    test can give a manifest the URL its relative URLs resolve against.
//	GET /big?bytes=N&declare=0|1
//	    N bytes (at most 32 MiB) of JSON whitespace and then {}: a manifest
//	    too large to accept. declare=1 sends Content-Length; otherwise the
//	    body is streamed without saying its size.
//	GET /redirect?to=URL
//	    a 302 to URL, which must be a path on this server.
//	GET /once/{name}?body=..
//	    body, as JSON, the first time; 503 every time after: the same URL
//	    that worked once and then fails.
//
// Each /echo request is added to the image log (see testImages) as
// "manifest <path and query>", so a test can count the fetches.
func registerEcho(mux *http.ServeMux, log *testImages) {
	mux.HandleFunc("GET /echo/{path...}", func(w http.ResponseWriter, r *http.Request) {
		log.mu.Lock()
		log.log = append(log.log, "manifest "+r.URL.RequestURI())
		log.mu.Unlock()
		q := r.URL.Query()
		if d := q.Get("delay"); d != "" {
			ms, err := strconv.Atoi(d)
			if err != nil || ms < 0 || ms > 10_000 {
				http.Error(w, "delay is 0 to 10000 ms", http.StatusBadRequest)
				return
			}
			select {
			case <-time.After(time.Duration(ms) * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
		ct := q.Get("type")
		if ct == "" {
			ct = "application/json"
		}
		status := http.StatusOK
		if s := q.Get("status"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 200 || n > 599 {
				http.Error(w, "status is 200 to 599", http.StatusBadRequest)
				return
			}
			status = n
		}
		headers(w, ct)
		w.WriteHeader(status)
		w.Write([]byte(q.Get("body")))
	})
	var onceMu sync.Mutex
	served := map[string]bool{}
	mux.HandleFunc("GET /once/{name}", func(w http.ResponseWriter, r *http.Request) {
		log.mu.Lock()
		log.log = append(log.log, "manifest "+r.URL.RequestURI())
		log.mu.Unlock()
		onceMu.Lock()
		again := served[r.PathValue("name")]
		served[r.PathValue("name")] = true
		onceMu.Unlock()
		if again {
			securityHeaders(w)
			http.Error(w, "gone wrong since", http.StatusServiceUnavailable)
			return
		}
		headers(w, "application/json")
		w.Write([]byte(r.URL.Query().Get("body")))
	})
	mux.HandleFunc("GET /big", func(w http.ResponseWriter, r *http.Request) {
		n, err := strconv.Atoi(r.URL.Query().Get("bytes"))
		if err != nil || n < 0 || n > 32<<20 {
			http.Error(w, "bytes is 0 to 32 MiB", http.StatusBadRequest)
			return
		}
		headers(w, "application/json")
		if r.URL.Query().Get("declare") == "1" {
			w.Header().Set("Content-Length", strconv.Itoa(n+2))
		}
		chunk := []byte(strings.Repeat(" ", 64<<10))
		for n > 0 {
			k := min(n, len(chunk))
			if _, err := w.Write(chunk[:k]); err != nil {
				return // the client stopped reading: as it should
			}
			n -= k
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		w.Write([]byte("{}"))
	})
	mux.HandleFunc("GET /redirect", func(w http.ResponseWriter, r *http.Request) {
		to := r.URL.Query().Get("to")
		// A path on this server, and nothing a browser might read as another
		// host: no "//", and no backslash, which browsers take for "/".
		u, err := url.Parse(to)
		if err != nil || u.Scheme != "" || u.Host != "" || !strings.HasPrefix(to, "/") ||
			strings.HasPrefix(to, "//") || strings.ContainsAny(to, "\\\t\r\n") {
			http.Error(w, "to must be a path on this server", http.StatusBadRequest)
			return
		}
		securityHeaders(w)
		http.Redirect(w, r, to, http.StatusFound)
	})
}
