/*! ThumbHash decoding in Clack follows the reference implementation's
algorithm (https://github.com/evanw/thumbhash), under its licence:

Copyright (c) 2023 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */

/**
 * ThumbHash: a blurred impression of a photo in about 25 bytes, painted
 * while the photo loads. The tools' encoder and decoder
 * (tools/internal/thumbhash) are the reference this is tested against
 * (test/fixtures/thumbhash.json): the same hashes refused, and the same
 * pixels drawn, give or take one where engines' cosines differ.
 */

/** What a hash holds: each channel's constant and varying terms, and its shape. */
export interface ThumbHash {
  lx: number;
  ly: number;
  hasAlpha: boolean;
  /** Constant terms: luminance, yellow-blue, red-green, alpha. */
  dc: [number, number, number, number];
  l: number[];
  p: number[];
  q: number[];
  a: number[];
  /** The approximate width / height of the photo. */
  ratio: number;
}

/**
 * The bytes of a hash in base64, as atob reads them -- padding complete or
 * left off, bits past the last byte ignored -- but with no whitespace, or
 * null if it is not base64 (tools: thumbhash.FromBase64).
 */
export function fromBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Reads a hash's terms, or null for one too short for what its header
 * says it holds, or of no width or height (tools: thumbhash.Check). A hash
 * may run on past its terms; the rest is ignored.
 */
export function read(hash: Uint8Array): ThumbHash | null {
  if (hash.length < 5) return null;
  const header24 = hash[0]! | (hash[1]! << 8) | (hash[2]! << 16);
  const header16 = hash[3]! | (hash[4]! << 8);
  const hasAlpha = header24 >> 23 !== 0;
  const landscape = header16 >> 15 !== 0;
  const across = landscape ? (hasAlpha ? 5 : 7) : header16 & 7;
  const down = landscape ? header16 & 7 : hasAlpha ? 5 : 7;
  if (!across || !down) return null;
  if (hasAlpha && hash.length < 6) return null;
  const lx = Math.max(3, across);
  const ly = Math.max(3, down);
  const start = hasAlpha ? 6 : 5;
  let index = 0;
  let short = false;
  // The varying terms, four bits each; saturation is boosted by 1.25 to
  // make up for what quantisation takes away.
  const terms = (nx: number, ny: number, scale: number): number[] => {
    const out: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++, index++) {
        const at = start + (index >> 1);
        if (at >= hash.length) short = true;
        out.push((((hash[at]! >> ((index & 1) << 2)) & 15) / 7.5 - 1) * scale);
      }
    }
    return out;
  };
  const l = terms(lx, ly, ((header24 >> 18) & 31) / 31);
  const p = terms(3, 3, (((header16 >> 3) & 63) / 63) * 1.25);
  const q = terms(3, 3, (((header16 >> 9) & 63) / 63) * 1.25);
  const a = hasAlpha ? terms(5, 5, (hash[5]! >> 4) / 15) : [];
  if (short) return null;
  return {
    lx,
    ly,
    hasAlpha,
    dc: [
      (header24 & 63) / 63,
      ((header24 >> 6) & 63) / 31.5 - 1,
      ((header24 >> 12) & 63) / 31.5 - 1,
      hasAlpha ? (hash[5]! & 15) / 15 : 1,
    ],
    l,
    p,
    q,
    a,
    ratio: across / down,
  };
}

/** The hash in base64, read; or null if it is not one. */
export function parse(base64: string): ThumbHash | null {
  const bytes = fromBase64(base64);
  return bytes && read(bytes);
}

/**
 * What a hash draws: an image at most 32 pixels on a side, its RGBA not
 * premultiplied, to be scaled up by the browser, whose smoothing finishes
 * the blur.
 */
export function draw(t: ThumbHash): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const { lx, ly, hasAlpha, ratio } = t;
  const w = Math.round(ratio > 1 ? 32 : 32 * ratio);
  const h = Math.round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  const nx = Math.max(lx, hasAlpha ? 5 : 3);
  const ny = Math.max(ly, hasAlpha ? 5 : 3);
  // Truncated, as the reference stores them, not rounded, as a clamped
  // array would.
  const byte = (v: number): number => Math.trunc(Math.max(0, 255 * Math.min(1, v)));
  for (let y = 0, i = 0; y < h; y++) {
    for (let cy = 0; cy < ny; cy++) fy[cy] = Math.cos((Math.PI / h) * (y + 0.5) * cy);
    for (let x = 0; x < w; x++, i += 4) {
      let [l, p, q, a] = t.dc;
      for (let cx = 0; cx < nx; cx++) fx[cx] = Math.cos((Math.PI / w) * (x + 0.5) * cx);
      for (let cy = 0, j = 0; cy < ly; cy++) {
        for (let cx = cy ? 0 : 1, fy2 = fy[cy]! * 2; cx * ly < lx * (ly - cy); cx++, j++) l += t.l[j]! * fx[cx]! * fy2;
      }
      for (let cy = 0, j = 0; cy < 3; cy++) {
        for (let cx = cy ? 0 : 1, fy2 = fy[cy]! * 2; cx < 3 - cy; cx++, j++) {
          const f = fx[cx]! * fy2;
          p += t.p[j]! * f;
          q += t.q[j]! * f;
        }
      }
      if (hasAlpha) {
        for (let cy = 0, j = 0; cy < 5; cy++) {
          for (let cx = cy ? 0 : 1, fy2 = fy[cy]! * 2; cx < 5 - cy; cx++, j++) a += t.a[j]! * fx[cx]! * fy2;
        }
      }
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      rgba[i] = byte(r);
      rgba[i + 1] = byte(r - q);
      rgba[i + 2] = byte(b);
      rgba[i + 3] = byte(a);
    }
  }
  return { width: w, height: h, rgba };
}
