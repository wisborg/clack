// Clack's ThumbHash decoder against the tools' (tools/internal/thumbhash),
// from one fixture made by the tools: the same texts read, the same hashes
// refused, and the same pixels drawn, give or take one where engines'
// cosines differ. And the placeholder painted from one, wherever a slide
// comes from.
import { fromInput, readMarkup, type SlideInput } from "../src/slides";
import { draw, fromBase64, parse, read } from "../src/thumbhash";
import fixture from "./fixtures/thumbhash.json";
import { assert, assertEqual, assertThrows, fixture as host, test } from "./harness";
import { figure, figures, makeShow, part, settledOn, waitFor } from "./util";

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

test("ThumbHash: base64 is read as the tools read it", () => {
  for (const c of fixture.base64) {
    const got = fromBase64(c.text);
    assertEqual(got === null ? null : toHex(got), c.bytes, JSON.stringify(c.text));
  }
});

test("ThumbHash: a hash short of its terms, or of no width or height, is refused", () => {
  for (const hex of fixture.refused) {
    assertEqual(read(fromHex(hex)), null, hex);
  }
});

test("ThumbHash: each hash draws what the tools draw", () => {
  for (const c of fixture.images) {
    const t = read(fromHex(c.hash));
    assert(t, `${c.name}: refused`);
    const { width, height, rgba } = draw(t);
    assertEqual(`${width}×${height}`, `${c.decoded.width}×${c.decoded.height}`, `${c.name}: its size`);
    const want = fromHex(c.decoded.rgba);
    assertEqual(rgba.length, want.length, `${c.name}: its bytes`);
    let worst = 0;
    for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(rgba[i]! - want[i]!));
    assert(worst <= 1, `${c.name}: a value off by ${worst}`);
  }
});

test("ThumbHash: parse reads base64 and the hash in it", () => {
  assert(parse(gradient()), "a hash in base64");
  assertEqual(parse(toBase64(fromHex(fixture.refused[0]!))), null, "a hash of no width");
  assertEqual(parse("not base64!"), null, "not base64");
});

/** The gradient's hash, in base64: red rising to the right, 32×23 drawn. */
function gradient(): string {
  const c = fixture.images.find((c) => c.name === "landscape gradient");
  assert(c, "the fixture has no landscape gradient");
  return toBase64(fromHex(c.hash));
}

/** A hash followed by more base64: drawable, but longer than a manifest may give. */
const overlong = (): string => gradient() + "A".repeat(40);

/** The fixture, with a figure for each value, given its image as data-key. */
function marked(key: string, values: string[]): HTMLElement {
  const h = host();
  for (const value of values) {
    const fig = figure({ src: "a.jpg", width: 3, height: 2 });
    fig.querySelector("img")!.dataset[key] = value;
    h.append(fig);
  }
  return h;
}

test("a slide's ThumbHash and colour are read from markup, and a bad one ignored, with a warning", () => {
  const hash = gradient();
  const warnings: string[] = [];
  const [a, b, c] = readMarkup(marked("thumbhash", [hash, "AAAAAA=", overlong()]), (m) => warnings.push(m));
  assertEqual(a!.thumbhash, hash, "kept as given");
  assertEqual(b!.thumbhash, "", "one that is not base64 ignored");
  assertEqual(c!.thumbhash, "", "one longer than a manifest may give ignored");
  assertEqual(warnings.length, 2, `two warnings: ${warnings.join("; ")}`);
  assert(warnings.every((w) => w.includes("data-thumbhash")), warnings.join("; "));
  // A colour, held to the manifest's rule as the hash is.
  warnings.length = 0;
  assertEqual(readMarkup(marked("color", ["#336699", "#369", "grey"]), (m) => warnings.push(m)).map((s) => s.color).join(), "#336699,,", "only #rrggbb kept");
  assertEqual(warnings.length, 2, `two warnings: ${warnings.join("; ")}`);
  assert(warnings.every((w) => w.includes("data-color")), warnings.join("; "));
});

test("a slide's ThumbHash from script must be one, in either shape", () => {
  const hash = gradient();
  const slide: SlideInput = { id: "a", alt: "A", width: 3, height: 2, sources: [{ url: "a.jpg", width: 3 }] };
  const [s] = fromInput([{ ...slide, placeholder: { thumbhash: hash } }]);
  assertEqual(s!.thumbhash, hash, "the manifest's shape");
  assertEqual(fromInput([s!])[0]!.thumbhash, hash, "Clack's shape, given back");
  assertEqual(fromInput([{ ...slide }])[0]!.thumbhash, "", "none");
  assertThrows(() => fromInput([{ ...slide, placeholder: { thumbhash: "3OcRJYB4" } }]), TypeError, "the manifest's shape, cut short", /ThumbHash/);
  assertThrows(() => fromInput([{ ...s!, thumbhash: "3OcRJYB4" }]), TypeError, "Clack's shape, cut short", /ThumbHash/);
  assertThrows(() => fromInput([{ ...s!, thumbhash: overlong() }]), TypeError, "Clack's shape, longer than a manifest may give", /ThumbHash/);
  assertThrows(() => fromInput([{ ...s!, thumbhash: 7 as unknown as string }]), TypeError, "not a string", /thumbhash/);
  // Optional in what is given, as in the type: a slide built without one.
  const { thumbhash: _, ...without } = s!;
  assertEqual(fromInput([without])[0]!.thumbhash, "", "Clack's shape without one");
});

test("a slide's colour from script must be one, as its ThumbHash must", () => {
  const [s] = fromInput([{ id: "a", alt: "A", width: 3, height: 2, sources: [{ url: "a.jpg", width: 3 }], placeholder: { color: "#336699" } }]);
  assertEqual(fromInput([s!])[0]!.color, "#336699", "given back");
  assertThrows(() => fromInput([{ ...s!, color: "grey" }]), TypeError, "a colour by name", /colou?r/);
});

test("the first photo's place is painted from its ThumbHash while it loads", async () => {
  const show = makeShow([{ delay: 1500 }]);
  // Inherited from the page, and not wanted: the blur is the smoothing.
  show.style.setProperty("image-rendering", "pixelated");
  show.querySelector("img")!.dataset["thumbhash"] = gradient();
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill canvas"), "the impression");
  const canvas = part(show, ".placeholder .fill canvas") as HTMLCanvasElement;
  assertEqual(`${canvas.width}×${canvas.height}`, "32×23", "drawn at the hash's own size");
  assertEqual(canvas.ariaHidden, "true", "hidden from screen readers, as the figure's label names it");
  assertEqual(getComputedStyle(canvas).imageRendering, "auto", "smoothed, whatever the page sets");
  const fill = part(show, ".placeholder .fill").getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  assert(Math.abs(box.width - fill.width) < 1 && Math.abs(box.height - fill.height) < 1, `stretched over the photo's place: ${box.width}×${box.height} in ${fill.width}×${fill.height}`);
  // The gradient: red to the right. (Read back from the canvas, which no
  // engine here randomises.)
  const pixels = canvas.getContext("2d")!.getImageData(0, 11, 32, 1).data;
  assert(pixels[31 * 4]! - pixels[0]! > 150, `red rises left to right: ${pixels[0]} to ${pixels[31 * 4]}`);
  await settledOn(show, "1 of 1");
  assertEqual(figures(show)[0]!.querySelector("canvas"), null, "gone once the photo is up");
});

test("a placeholder brought up to date while the photo loads keeps its impression", async () => {
  // Long enough for every step below to happen before the photo arrives;
  // if it ever comes sooner, the test says so rather than timing out.
  const show = makeShow([{ delay: 3000 }]);
  const img = show.querySelector("img")!;
  img.dataset["thumbhash"] = gradient();
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill canvas"), "the impression");
  const placeholder = part(show, ".placeholder");
  const canvas = part(show, ".placeholder canvas");
  /** Waits for cond while the placeholder is still up; fails at once if it is not. */
  const meanwhile = async (cond: () => boolean, what: string): Promise<void> => {
    await waitFor(() => !placeholder.isConnected || cond(), what);
    assert(placeholder.isConnected, `${what}: the photo came, or the placeholder was replaced, first`);
  };
  img.dataset["color"] = "#336699"; // the markup changes, and the placeholder with it
  await meanwhile(() => placeholder.style.getPropertyValue("--clack-placeholder") === "#336699", "the new colour");
  assertEqual(placeholder.querySelector("canvas"), canvas, "the same canvas, not decoded again");
  delete img.dataset["thumbhash"];
  await meanwhile(() => !placeholder.querySelector("canvas"), "the impression gone with its hash");
  img.dataset["thumbhash"] = gradient();
  await meanwhile(() => !!placeholder.querySelector("canvas"), "painted again with its hash back");
  await settledOn(show, "1 of 1");
});

test("with cover, the impression holds the whole frame, cropped as the photo will be", async () => {
  // A panorama, 10:1: wider than any ThumbHash can say (7:1 at most), so
  // the hash's own proportions would crop it differently from the photo.
  const show = makeShow([{ width: 1000, height: 100, delay: 1500 }], { fit: "cover" });
  show.querySelector("img")!.dataset["thumbhash"] = gradient();
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill canvas"), "the impression");
  const held = part(show, ".placeholder .fill").getBoundingClientRect();
  const box = part(show, ".placeholder canvas").getBoundingClientRect();
  // What object-fit: cover makes of a 10:1 photo in the frame: as tall as
  // the frame, ten times as wide, centred.
  const width = Math.max(held.width, held.height * 10);
  const height = Math.max(held.height, held.width / 10);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1;
  assert(near(box.width, width) && near(box.height, height), `the impression is ${box.width}×${box.height}, the photo will be ${width}×${height}`);
  assert(near(box.left + box.width / 2, held.left + held.width / 2) && near(box.top + box.height / 2, held.top + held.height / 2), "centred, as the photo will be");
  await settledOn(show, "1 of 1");
  const photo = figures(show)[0]!.querySelector("img")!.getBoundingClientRect();
  assert(near(held.width, photo.width) && near(held.height, photo.height), `the place held, ${held.width}×${held.height}, is the photo's, ${photo.width}×${photo.height}`);
});

test("a slide without a ThumbHash has no impression painted", async () => {
  const show = makeShow([{ delay: 600 }]);
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill"), "the placeholder");
  assertEqual(show.shadowRoot!.querySelector(".placeholder canvas"), null, "no canvas");
  await settledOn(show, "1 of 1");
});
