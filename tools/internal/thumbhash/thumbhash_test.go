package thumbhash

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"math"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite test/fixtures/thumbhash.json from this package's encoder and decoder")

// image is a test image, made from integers alone so that it is the same
// bytes wherever it is made.
type image struct {
	name string
	w, h int
	rgba []byte
}

func makeImage(name string, w, h int, px func(x, y int) [4]int) image {
	rgba := make([]byte, w*h*4)
	for y := range h {
		for x := range w {
			v := px(x, y)
			for k := range 4 {
				rgba[(y*w+x)*4+k] = byte(v[k])
			}
		}
	}
	return image{name, w, h, rgba}
}

func images() []image {
	return []image{
		makeImage("landscape gradient", 100, 75, func(x, y int) [4]int { return [4]int{x * 255 / 99, y * 255 / 74, 128, 255} }),
		makeImage("portrait pattern", 30, 80, func(x, y int) [4]int { return [4]int{(x * y) % 256, 200, (x * 7) % 256, 255} }),
		makeImage("square with alpha", 64, 64, func(x, y int) [4]int { return [4]int{x * 4, 255 - y*4, 90, (x * y) % 256} }),
		makeImage("wide strip", 100, 9, func(x, y int) [4]int {
			r := 20
			if x < 50 {
				r = 230
			}
			return [4]int{r, 120, y * 28, 255}
		}),
		makeImage("tall with edge alpha", 12, 100, func(x, y int) [4]int {
			a := 255
			if y < 10 {
				a = y * 25
			}
			return [4]int{40, 60 + y, 200 - x*10, a}
		}),
		makeImage("one pixel", 1, 1, func(x, y int) [4]int { return [4]int{10, 20, 30, 255} }),
		makeImage("fully transparent", 10, 10, func(x, y int) [4]int { return [4]int{x * 20, y * 20, 0, 0} }),
		makeImage("mid grey", 50, 50, func(x, y int) [4]int { return [4]int{128, 128, 128, 255} }),
	}
}

// base64Cases are texts and what FromBase64 makes of them (hex), or "!"
// where it refuses: as a browser's atob reads them, but for whitespace.
var base64Cases = []struct{ text, bytes string }{
	{"3OcRJYB4d3h/iIeHeEh3eIhw+j3A", "dce71125807877787f888787784877788870fa3dc0"},
	{"AAAAAAA", "0000000000"},
	{"AAAAAAA=", "0000000000"},
	{"AAAAAA", "00000000"},
	{"AAAAAA==", "00000000"},
	{"AAAAAAB", "0000000000"}, // bits past the last byte are ignored
	{"/+/+/+8", "ffeffeffef"},
	{"", ""},
	{"AAAAA", "!"},     // a fifth of a group
	{"AAAAAA=", "!"},   // padding begun but not finished
	{"AAAAAAA==", "!"}, // too much padding
	{"AAAA=AAA", "!"},  // padding inside
	{"====", "!"},
	{"AAAA AAA", "!"}, // atob would allow these; we do not
	{"AAAA\nAAA", "!"},
	{"-_-_-_-_", "!"}, // the URL alphabet
}

// fixture is test/fixtures/thumbhash.json, which the browser's decoder
// (test/thumbhash.test.ts) is held to as well.
type fixture struct {
	Comment string        `json:"$comment"`
	Base64  []base64Case  `json:"base64"`
	Refused []string      `json:"refused"`
	Images  []fixtureCase `json:"images"`
}

type base64Case struct {
	Text  string  `json:"text"`
	Bytes *string `json:"bytes"`
}

type fixtureCase struct {
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Hash    string `json:"hash"`
	Decoded struct {
		Width  int    `json:"width"`
		Height int    `json:"height"`
		RGBA   string `json:"rgba"`
	} `json:"decoded"`
}

const fixturePath = "../../../test/fixtures/thumbhash.json"

func TestFromBase64(t *testing.T) {
	for _, c := range base64Cases {
		b, err := FromBase64(c.text)
		want := c.bytes
		switch {
		case want == "!" && err == nil:
			t.Errorf("FromBase64(%q) = %x, want an error", c.text, b)
		case want != "!" && err != nil:
			t.Errorf("FromBase64(%q): %v", c.text, err)
		case want != "!" && hex.EncodeToString(b) != want:
			t.Errorf("FromBase64(%q) = %x, want %s", c.text, b, want)
		}
	}
}

// TestFixture keeps the shared fixture what this package makes of the test
// images and texts; run with -update to rewrite it after a deliberate change.
func TestFixture(t *testing.T) {
	f := fixture{Comment: "Made by go test ./tools/internal/thumbhash -update, from its encoder and decoder: what Clack's decoder (src/thumbhash.ts) must make of each. \"base64\" gives texts and their bytes in hex, or null where they must be refused. \"refused\" gives hashes, in hex, that must be refused: too short for what their headers say, or of no width. \"images\" gives test images (made in that test) by name and size, the hash of each in hex, and what the hash draws: its size and its pixels as RGBA, in hex, each of which Clack's may differ from by one, as cosines differ slightly between engines."}
	for _, c := range base64Cases {
		bc := base64Case{Text: c.text}
		if b, err := FromBase64(c.text); err == nil {
			h := hex.EncodeToString(b)
			bc.Bytes = &h
		}
		f.Base64 = append(f.Base64, bc)
	}
	f.Refused = append(f.Refused, hex.EncodeToString(noWidth))
	for _, im := range images() {
		hash, err := Encode(im.w, im.h, im.rgba)
		if err != nil {
			t.Fatalf("%s: %v", im.name, err)
		}
		// Each hash cut short: by its last byte, and to its headers.
		for _, n := range []int{len(hash) - 1, 6, 5, 4} {
			if err := Check(hash[:n]); err == nil {
				t.Fatalf("%s: the first %d bytes are not refused", im.name, n)
			}
			f.Refused = append(f.Refused, hex.EncodeToString(hash[:n]))
		}
		w, h, rgba, err := Decode(hash)
		if err != nil {
			t.Fatalf("%s: %v", im.name, err)
		}
		c := fixtureCase{Name: im.name, Width: im.w, Height: im.h, Hash: hex.EncodeToString(hash)}
		c.Decoded.Width, c.Decoded.Height, c.Decoded.RGBA = w, h, hex.EncodeToString(rgba)
		f.Images = append(f.Images, c)
	}
	want, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	path := filepath.FromSlash(fixturePath)
	if *update {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (make it with go test ./tools/internal/thumbhash -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s is not what this package makes; if the change is deliberate, rewrite it with -update", fixturePath)
	}
}

// average is an image's average colour, weighted by alpha, and its average
// alpha, each from 0 to 1.
func average(w, h int, rgba []byte) (r, g, b, a float64) {
	for i := range w * h {
		alpha := float64(rgba[i*4+3]) / 255
		r += alpha * float64(rgba[i*4]) / 255
		g += alpha * float64(rgba[i*4+1]) / 255
		b += alpha * float64(rgba[i*4+2]) / 255
		a += alpha
	}
	if a > 0 {
		r, g, b = r/a, g/a, b/a
	}
	return r, g, b, a / float64(w*h)
}

// TestImpression checks that what a hash draws resembles its image: the
// same shape, about the same average colour and alpha, and only as much
// alpha as the image had.
func TestImpression(t *testing.T) {
	for _, im := range images() {
		hash, err := Encode(im.w, im.h, im.rgba)
		if err != nil {
			t.Fatalf("%s: %v", im.name, err)
		}
		if len(hash) > 25 {
			t.Errorf("%s: %d bytes", im.name, len(hash))
		}
		w, h, rgba, err := Decode(hash)
		if err != nil {
			t.Fatalf("%s: %v", im.name, err)
		}
		if w > 32 || h > 32 || (w != 32 && h != 32) {
			t.Errorf("%s: drawn %d×%d", im.name, w, h)
		}
		// The format holds ratios only as far as 7:1, or 5:1 with alpha.
		ratio, _ := AspectRatio(hash)
		limit := 7.0
		if hash[2]&0x80 != 0 {
			limit = 5
		}
		want := math.Min(limit, math.Max(1/limit, float64(im.w)/float64(im.h)))
		if got := float64(w) / float64(h); math.Abs(math.Log(got/want)) > 0.2 {
			t.Errorf("%s: drawn %d×%d (ratio %.2f, approximately %.2f) for %d×%d", im.name, w, h, got, ratio, im.w, im.h)
		}
		r0, g0, b0, a0 := average(im.w, im.h, im.rgba)
		r1, g1, b1, a1 := average(w, h, rgba)
		if a0 > 0 && math.Max(math.Abs(r1-r0), math.Max(math.Abs(g1-g0), math.Abs(b1-b0))) > 0.06 {
			t.Errorf("%s: average colour %.2f %.2f %.2f, drawn %.2f %.2f %.2f", im.name, r0, g0, b0, r1, g1, b1)
		}
		if math.Abs(a1-a0) > 0.06 {
			t.Errorf("%s: average alpha %.2f, drawn %.2f", im.name, a0, a1)
		}
		if hasAlpha := hash[2]&0x80 != 0; hasAlpha != (a0 < 1) {
			t.Errorf("%s: alpha flag %v for average alpha %.3f", im.name, hasAlpha, a0)
		}
	}
}

// TestGradient checks that a hash keeps where things are, not only their
// colour: the gradient image is red to the right and green to the bottom.
func TestGradient(t *testing.T) {
	im := images()[0]
	hash, _ := Encode(im.w, im.h, im.rgba)
	w, h, rgba, err := Decode(hash)
	if err != nil {
		t.Fatal(err)
	}
	at := func(x, y, k int) int { return int(rgba[(y*w+x)*4+k]) }
	if l, r := at(2, h/2, 0), at(w-3, h/2, 0); r-l < 150 {
		t.Errorf("red goes from %d to %d left to right", l, r)
	}
	if top, bottom := at(w/2, 2, 1), at(w/2, h-3, 1); bottom-top < 150 {
		t.Errorf("green goes from %d to %d top to bottom", top, bottom)
	}
}

func TestEncodeRefuses(t *testing.T) {
	for _, c := range []struct {
		w, h, n int
	}{{0, 1, 0}, {1, 0, 0}, {101, 1, 404}, {1, 101, 404}, {2, 2, 15}, {2, 2, 17}} {
		if _, err := Encode(c.w, c.h, make([]byte, c.n)); err == nil {
			t.Errorf("Encode(%d, %d, %d bytes) gave no error", c.w, c.h, c.n)
		}
	}
}

// noWidth is a hash of a portrait image whose header says it has no
// luminance terms across: complete, but of no width.
var noWidth = make([]byte, 23)

// TestDecodeRefuses checks that a hash too short for what its header says
// is refused, not drawn from bytes that are not there.
func TestDecodeRefuses(t *testing.T) {
	for _, im := range images() {
		hash, _ := Encode(im.w, im.h, im.rgba)
		for n := range len(hash) {
			if _, _, _, err := Decode(hash[:n]); err == nil || Check(hash[:n]) == nil {
				t.Errorf("%s: the first %d of %d bytes decoded", im.name, n, len(hash))
			}
		}
	}
	if _, _, _, err := Decode(noWidth); err == nil {
		t.Error("a hash of no width decoded")
	}
}

func FuzzDecode(f *testing.F) {
	for _, im := range images() {
		hash, _ := Encode(im.w, im.h, im.rgba)
		f.Add(hash)
	}
	f.Fuzz(func(t *testing.T, hash []byte) {
		w, h, rgba, err := Decode(hash)
		if err != nil {
			return
		}
		if w < 1 || h < 1 || w > 32 || h > 32 || len(rgba) != w*h*4 {
			t.Fatalf("decoded %d×%d with %d bytes", w, h, len(rgba))
		}
	})
}

// TestCosines checks cosPi against math.Cos over every argument the
// encoder and decoder use, and at the edges of its reduction.
func TestCosines(t *testing.T) {
	// math.Cos is the reference only as far as its argument is exact: π·n/d
	// is rounded, by up to an ulp of the angle. So, closely, in the first
	// quadrant, where that is small; and over the whole circle, as closely
	// as the reference allows.
	worst, whole := 0.0, 0.0
	for d := 1; d <= 200; d++ {
		for n := 0; n <= 8*(2*100); n++ {
			got, want := cosPi(n, d), math.Cos(math.Pi*float64(n%(2*d))/float64(d))
			if 2*n <= d {
				worst = math.Max(worst, math.Abs(got-want))
			}
			whole = math.Max(whole, math.Abs(got-want))
		}
	}
	if worst > 5e-16 || whole > 2e-15 {
		t.Errorf("cosPi is %g from math.Cos at worst in the first quadrant, %g in all", worst, whole)
	}
	for _, c := range []struct {
		n, d int
		want float64
	}{{0, 1, 1}, {1, 2, 0}, {1, 1, -1}, {3, 2, 0}, {2, 1, 1}, {1, 4, math.Sqrt2 / 2}} {
		if got := cosPi(c.n, c.d); math.Abs(got-c.want) > 2e-16 {
			t.Errorf("cos(π·%d/%d) = %g, want %g", c.n, c.d, got, c.want)
		}
	}
	if cosPi(1, 2) != 0 || cosPi(3, 2) != 0 {
		t.Error("cos(π/2) is not exactly 0")
	}
}

// cosineSum is the checksum of every cosine the encoder and decoder can
// ask for -- cos(π·c·(2i+1)/2n) for n up to 100 and c below 8 -- bit for bit.
const cosineSum = "ad2cecf4d63056002da482ba731dab4084ce36f9d8c7f5f0d840ade3d064005b"

// TestCosinesAreTheSameEverywhere holds those cosines to the checksum
// taken where the fixture was made, so a machine that computes any one of
// them differently fails here, by name, rather than in a fixture byte that
// a test image happens to reach. Run it as GOARCH=amd64, and with
// GOAMD64=v3, as well as natively.
func TestCosinesAreTheSameEverywhere(t *testing.T) {
	h := sha256.New()
	var b [8]byte
	for n := 1; n <= 100; n++ {
		for c := range 8 {
			for i := range n {
				binary.LittleEndian.PutUint64(b[:], math.Float64bits(cosPi(c*(2*i+1), 2*n)))
				h.Write(b[:])
			}
		}
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != cosineSum {
		t.Errorf("the cosines' checksum is %s, want %s", got, cosineSum)
	}
}
