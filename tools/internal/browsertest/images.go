package browsertest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// testImages serves made-up images for the tests, so no test depends on a
// real photo or the network:
//
//	GET /img/{w}x{h}-{rrggbb}.png   a w by h image in that colour, with a
//	                                darker diagonal so a crop is visible
//	    ?delay={ms}                 answered only after that long (at most 10 s)
//	    ?tag={anything}             ignored; makes the URL distinct, so the
//	                                browser's own cache cannot answer for it
//	GET /img/broken.png             served as a PNG, but not one
//	GET /img-log                    the paths and queries of every image
//	                                requested since the last reset, in order,
//	                                and "cancelled <path>" for each delayed
//	                                one the browser gave up on before it came
//	POST /img-log/reset             empties the log
type testImages struct {
	mu    sync.Mutex
	cache map[string][]byte
	log   []string
}

var imagePath = regexp.MustCompile(`^([0-9]{1,4})x([0-9]{1,4})-([0-9a-f]{6})\.png$`)

func (t *testImages) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /img/{name}", t.serveImage)
	mux.HandleFunc("GET /img-log", func(w http.ResponseWriter, r *http.Request) {
		t.mu.Lock()
		log := append([]string{}, t.log...)
		t.mu.Unlock()
		headers(w, "application/json")
		json.NewEncoder(w).Encode(log)
	})
	mux.HandleFunc("POST /img-log/reset", func(w http.ResponseWriter, r *http.Request) {
		t.mu.Lock()
		t.log = nil
		t.mu.Unlock()
		securityHeaders(w)
		w.WriteHeader(http.StatusNoContent)
	})
}

func (t *testImages) serveImage(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	t.mu.Lock()
	t.log = append(t.log, r.URL.RequestURI())
	t.mu.Unlock()

	if d := r.URL.Query().Get("delay"); d != "" {
		ms, err := strconv.Atoi(d)
		if err != nil || ms < 0 || ms > 10_000 {
			http.Error(w, "delay is 0 to 10000 ms", http.StatusBadRequest)
			return
		}
		select {
		case <-time.After(time.Duration(ms) * time.Millisecond):
		case <-r.Context().Done():
			// The browser gave up on it: logged, so a test can see that a
			// load it no longer needed was cancelled.
			t.mu.Lock()
			t.log = append(t.log, "cancelled "+r.URL.RequestURI())
			t.mu.Unlock()
			return
		}
	}
	if name == "broken.png" {
		headers(w, "image/png")
		w.Write([]byte("this is not a PNG"))
		return
	}
	m := imagePath.FindStringSubmatch(name)
	if m == nil {
		http.NotFound(w, r)
		return
	}
	body, err := t.image(m[1], m[2], m[3])
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	headers(w, "image/png")
	w.Write(body)
}

func (t *testImages) image(ws, hs, hex string) ([]byte, error) {
	key := ws + "x" + hs + "-" + hex
	t.mu.Lock()
	body, ok := t.cache[key]
	t.mu.Unlock()
	if ok {
		return body, nil
	}
	w, _ := strconv.Atoi(ws)
	h, _ := strconv.Atoi(hs)
	if w < 1 || h < 1 || w*h > 4_000_000 {
		return nil, fmt.Errorf("%dx%d: from 1x1 to 4 megapixels", w, h)
	}
	v, _ := strconv.ParseUint(hex, 16, 32)
	c := color.NRGBA{uint8(v >> 16), uint8(v >> 8), uint8(v), 255}
	dark := color.NRGBA{c.R / 2, c.G / 2, c.B / 2, 255}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			// A band along the diagonal from top left to bottom right.
			if d := x*h - y*w; d > -w*h/20 && d < w*h/20 {
				img.SetNRGBA(x, y, dark)
			} else {
				img.SetNRGBA(x, y, c)
			}
		}
	}
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, img); err != nil {
		return nil, err
	}
	t.mu.Lock()
	if t.cache == nil {
		t.cache = map[string][]byte{}
	}
	t.cache[key] = buf.Bytes()
	t.mu.Unlock()
	return buf.Bytes(), nil
}
