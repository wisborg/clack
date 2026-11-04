// This follows the algorithm of ThumbHash's reference implementation
// (https://github.com/evanw/thumbhash), which is the format's only
// definition, and is used under its licence:
//
// Copyright (c) 2023 Evan Wallace
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// Package thumbhash encodes and decodes ThumbHashes, Evan Wallace's format
// for a blurred impression of a photo in about 25 bytes, which Clack paints
// while the photo loads.
//
// Clack's tools use the encoder to make placeholders for the test images,
// and the decoder to check what Clack's own (src/thumbhash.ts) draws from
// them. Shoebox will use the encoder at import.
package thumbhash

import (
	"encoding/base64"
	"errors"
	"math"
	"strings"
)

// The arithmetic here is written so that every machine gets the same bytes
// from the same image. Go lets a compiler fuse x*y + z into one
// instruction, rounded once instead of twice, and arm64's does so where
// amd64's does not; so each product that is then added is converted to
// float64, which the language defines as rounding it, and which prevents
// the fusion. The conversions look redundant, and are not.
//
// What is left is noise in the last bits of the cosines, which a term that
// is in truth zero -- every term of a flat channel, many of a symmetric
// image -- is made of; and a zero term normalises to exactly half way
// between two four-bit values, where noise would choose the side. So a
// term within noise of zero is taken as zero (the reference encoder keeps
// the noise; what it makes of such a term is arbitrary either way).
const noise = 1e-9

// Encode returns the ThumbHash of an image w by h pixels, at most 100 on a
// side, given as RGBA bytes (not premultiplied), row by row.
func Encode(w, h int, rgba []byte) ([]byte, error) {
	if w < 1 || h < 1 || w > 100 || h > 100 {
		return nil, errors.New("thumbhash: the image must be 1 to 100 pixels on a side")
	}
	if len(rgba) != w*h*4 {
		return nil, errors.New("thumbhash: rgba is not w*h*4 bytes")
	}

	// The average colour, weighted by alpha.
	var avgR, avgG, avgB, avgA float64
	for i := range w * h {
		alpha := float64(rgba[i*4+3]) / 255
		avgR += float64(alpha / 255 * float64(rgba[i*4]))
		avgG += float64(alpha / 255 * float64(rgba[i*4+1]))
		avgB += float64(alpha / 255 * float64(rgba[i*4+2]))
		avgA += alpha
	}
	if avgA > 0 {
		avgR /= avgA
		avgG /= avgA
		avgB /= avgA
	}
	hasAlpha := avgA < float64(w*h)
	lLimit := 7.0 // fewer luminance terms if there is alpha
	if hasAlpha {
		lLimit = 5
	}
	longest := float64(max(w, h))
	lx := max(1, int(math.Round(lLimit*float64(w)/longest)))
	ly := max(1, int(math.Round(lLimit*float64(h)/longest)))

	// To LPQA, composited over the average colour.
	l := make([]float64, w*h)
	p := make([]float64, w*h)
	q := make([]float64, w*h)
	a := make([]float64, w*h)
	for i := range w * h {
		alpha := float64(rgba[i*4+3]) / 255
		r := float64(avgR*(1-alpha)) + float64(alpha/255*float64(rgba[i*4]))
		g := float64(avgG*(1-alpha)) + float64(alpha/255*float64(rgba[i*4+1]))
		b := float64(avgB*(1-alpha)) + float64(alpha/255*float64(rgba[i*4+2]))
		l[i] = (r + g + b) / 3
		p[i] = (r+g)/2 - b
		q[i] = r - g
		a[i] = alpha
	}

	// Each channel as a DCT: a constant (DC) term and normalised varying
	// (AC) terms, with the scale that normalised them.
	encode := func(channel []float64, nx, ny int) (dc float64, ac []float64, scale float64) {
		fx := make([]float64, w)
		for cy := range ny {
			for cx := 0; cx*ny < nx*(ny-cy); cx++ {
				f := 0.0
				for x := range w {
					fx[x] = math.Cos(math.Pi / float64(w) * float64(cx) * (float64(x) + 0.5))
				}
				for y := range h {
					fy := math.Cos(math.Pi / float64(h) * float64(cy) * (float64(y) + 0.5))
					for x := range w {
						f += float64(channel[x+y*w] * fx[x] * fy)
					}
				}
				f /= float64(w * h)
				if math.Abs(f) < noise {
					f = 0
				}
				if cx > 0 || cy > 0 {
					ac = append(ac, f)
					scale = math.Max(scale, math.Abs(f))
				} else {
					dc = f
				}
			}
		}
		if scale > 0 {
			for i := range ac {
				ac[i] = 0.5 + float64(0.5/scale*ac[i])
			}
		}
		return dc, ac, scale
	}
	lDC, lAC, lScale := encode(l, max(3, lx), max(3, ly))
	pDC, pAC, pScale := encode(p, 3, 3)
	qDC, qAC, qScale := encode(q, 3, 3)
	var aDC, aScale float64
	var aAC []float64
	if hasAlpha {
		aDC, aAC, aScale = encode(a, 5, 5)
	}

	// The constants.
	round := func(f float64) int { return int(math.Round(f)) }
	isLandscape := w > h
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	header24 := round(63*lDC) | round(31.5+float64(31.5*pDC))<<6 | round(31.5+float64(31.5*qDC))<<12 | round(31*lScale)<<18 | b2i(hasAlpha)<<23
	side := lx
	if isLandscape {
		side = ly
	}
	header16 := side | round(63*pScale)<<3 | round(63*qScale)<<9 | b2i(isLandscape)<<15
	hash := []byte{byte(header24), byte(header24 >> 8), byte(header24 >> 16), byte(header16), byte(header16 >> 8)}
	acStart := 5
	if hasAlpha {
		hash = append(hash, byte(round(15*aDC)|round(15*aScale)<<4))
		acStart = 6
	}

	// The varying terms, four bits each.
	channels := [][]float64{lAC, pAC, qAC}
	if hasAlpha {
		channels = append(channels, aAC)
	}
	index := 0
	for _, ac := range channels {
		for _, f := range ac {
			at := acStart + index>>1
			for len(hash) <= at {
				hash = append(hash, 0)
			}
			hash[at] |= byte(round(15*f) << ((index & 1) << 2))
			index++
		}
	}
	return hash, nil
}

// shape returns how many luminance terms a hash has across and down, as
// its header gives them, which is also the shape of the image it is of; an
// error if it is too short to say, or says there are none.
func shape(hash []byte) (across, down int, err error) {
	if len(hash) < 5 {
		return 0, 0, errors.New("thumbhash: too short")
	}
	side := int(hash[3] & 7)
	hasAlpha := hash[2]&0x80 != 0
	isLandscape := hash[4]&0x80 != 0
	long := 7
	if hasAlpha {
		long = 5
	}
	if isLandscape {
		across, down = long, side
	} else {
		across, down = side, long
	}
	if across == 0 || down == 0 {
		return 0, 0, errors.New("thumbhash: no size")
	}
	return across, down, nil
}

// AspectRatio is the approximate width / height of the image a hash is of.
func AspectRatio(hash []byte) (float64, error) {
	across, down, err := shape(hash)
	if err != nil {
		return 0, err
	}
	return float64(across) / float64(down), nil
}

// FromBase64 reads a hash written in base64 as a browser's atob does
// (the HTML standard's "forgiving-base64 decode"), and so as Clack does:
// with its padding either complete or left off, and any bits past the last
// byte ignored; but, unlike atob, with no whitespace.
func FromBase64(s string) ([]byte, error) {
	if len(s)%4 == 0 {
		s = strings.TrimSuffix(strings.TrimSuffix(s, "="), "=")
	}
	for _, c := range []byte(s) {
		if !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '+' || c == '/') {
			return nil, errors.New("thumbhash: not base64")
		}
	}
	if len(s)%4 == 1 {
		return nil, errors.New("thumbhash: not base64")
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// terms is what a hash holds: the constant and varying terms of each
// channel, and how many luminance terms there are across and down.
type terms struct {
	lx, ly             int
	hasAlpha           bool
	lDC, pDC, qDC, aDC float64
	lAC, pAC, qAC, aAC []float64
	ratio              float64
}

// read reads a hash's terms, refusing one too short for what its header
// says it holds, or of no width or height. A hash may run on past its
// terms; the rest is ignored, as the reference ignores it.
func read(hash []byte) (*terms, error) {
	across, down, err := shape(hash)
	if err != nil {
		return nil, err
	}
	header24 := int(hash[0]) | int(hash[1])<<8 | int(hash[2])<<16
	header16 := int(hash[3]) | int(hash[4])<<8
	t := &terms{
		lDC:      float64(header24&63) / 63,
		pDC:      float64((header24>>6)&63)/31.5 - 1,
		qDC:      float64((header24>>12)&63)/31.5 - 1,
		hasAlpha: header24>>23 != 0,
		aDC:      1,
		lx:       max(3, across),
		ly:       max(3, down),
		ratio:    float64(across) / float64(down),
	}
	lScale := float64((header24>>18)&31) / 31
	pScale := float64((header16>>3)&63) / 63
	qScale := float64((header16>>9)&63) / 63
	aScale := 0.0
	acStart := 5
	if t.hasAlpha {
		if len(hash) < 6 {
			return nil, errors.New("thumbhash: too short")
		}
		t.aDC = float64(hash[5]&15) / 15
		aScale = float64(hash[5]>>4) / 15
		acStart = 6
	}

	// The varying terms; saturation is boosted by 1.25 to make up for what
	// quantisation takes away.
	index := 0
	short := false
	decode := func(nx, ny int, scale float64) []float64 {
		var ac []float64
		for cy := range ny {
			cx := 0
			if cy == 0 {
				cx = 1
			}
			for ; cx*ny < nx*(ny-cy); cx++ {
				at := acStart + index>>1
				if at >= len(hash) {
					short = true
					return ac
				}
				v := int(hash[at]>>((index&1)<<2)) & 15
				ac = append(ac, (float64(v)/7.5-1)*scale)
				index++
			}
		}
		return ac
	}
	t.lAC = decode(t.lx, t.ly, lScale)
	t.pAC = decode(3, 3, pScale*1.25)
	t.qAC = decode(3, 3, qScale*1.25)
	if t.hasAlpha {
		t.aAC = decode(5, 5, aScale)
	}
	if short {
		return nil, errors.New("thumbhash: too short for its terms")
	}
	return t, nil
}

// Check returns why a hash cannot be drawn, if it cannot: exactly when
// Decode would refuse it, without drawing it.
func Check(hash []byte) error {
	_, err := read(hash)
	return err
}

// Decode returns the image a hash is an impression of, at most 32 pixels
// on a side, as RGBA bytes.
func Decode(hash []byte) (w, h int, rgba []byte, err error) {
	t, err := read(hash)
	if err != nil {
		return 0, 0, nil, err
	}
	lx, ly, hasAlpha := t.lx, t.ly, t.hasAlpha
	if t.ratio > 1 {
		w, h = 32, int(math.Round(32/t.ratio))
	} else {
		w, h = int(math.Round(32*t.ratio)), 32
	}
	rgba = make([]byte, w*h*4)
	n, m := max(lx, 3), max(ly, 3)
	if hasAlpha {
		n, m = max(lx, 5), max(ly, 5)
	}
	fx := make([]float64, n)
	fy := make([]float64, m)
	clamp := func(v float64) byte { return byte(math.Max(0, 255*math.Min(1, v))) }
	for y, i := 0, 0; y < h; y++ {
		for x := 0; x < w; x, i = x+1, i+4 {
			l, p, q, a := t.lDC, t.pDC, t.qDC, t.aDC
			for cx := range fx {
				fx[cx] = math.Cos(math.Pi / float64(w) * (float64(x) + 0.5) * float64(cx))
			}
			for cy := range fy {
				fy[cy] = math.Cos(math.Pi / float64(h) * (float64(y) + 0.5) * float64(cy))
			}
			for cy, j := 0, 0; cy < ly; cy++ {
				cx := 0
				if cy == 0 {
					cx = 1
				}
				for fy2 := fy[cy] * 2; cx*ly < lx*(ly-cy); cx, j = cx+1, j+1 {
					l += float64(t.lAC[j] * fx[cx] * fy2)
				}
			}
			for cy, j := 0, 0; cy < 3; cy++ {
				cx := 0
				if cy == 0 {
					cx = 1
				}
				for fy2 := fy[cy] * 2; cx < 3-cy; cx, j = cx+1, j+1 {
					f := fx[cx] * fy2
					p += float64(t.pAC[j] * f)
					q += float64(t.qAC[j] * f)
				}
			}
			if hasAlpha {
				for cy, j := 0, 0; cy < 5; cy++ {
					cx := 0
					if cy == 0 {
						cx = 1
					}
					for fy2 := fy[cy] * 2; cx < 5-cy; cx, j = cx+1, j+1 {
						a += float64(t.aAC[j] * fx[cx] * fy2)
					}
				}
			}
			// Unfused, as above, so every machine draws the same.
			b := l - float64(2.0/3.0*p)
			r := (float64(3*l) - b + q) / 2
			g := r - q
			rgba[i], rgba[i+1], rgba[i+2], rgba[i+3] = clamp(r), clamp(g), clamp(b), clamp(a)
		}
	}
	return w, h, rgba, nil
}
