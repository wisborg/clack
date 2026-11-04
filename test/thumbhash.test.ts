// Clack's ThumbHash decoder against the tools' (tools/internal/thumbhash),
// from one fixture made by the tools: the same texts read, the same hashes
// refused, and the same pixels drawn, give or take one where engines'
// cosines differ. And the placeholder painted from one, wherever a slide
// comes from.
import { fromInput, readMarkup, type SlideInput } from "../src/slides";
import { draw, fromBase64, parse, read } from "../src/thumbhash";
import fixture from "./fixtures/thumbhash.json";
import { assert, assertEqual, fixture as host, test } from "./harness";
import { figures, makeShow, part, settledOn, waitFor } from "./util";

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** Asserts that fn throws a TypeError whose message matches. */
function refuses(fn: () => unknown, message: RegExp, what: string): void {
  try {
    fn();
  } catch (e) {
    assert(e instanceof TypeError && message.test(e.message), `${what}: ${String(e)}`);
    return;
  }
  assert(false, `${what}: accepted`);
}
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

test("ThumbHash: base64 is read as the tools read it", () => {
  for (const c of fixture.base64) {
    const got = fromBase64(c.text);
    assertEqual(got === null ? null : toHex(got), c.bytes, JSON.stringify(c.text));
  }
});

test("ThumbHash: a hash short of its terms, or of no width, is refused", () => {
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
  const c = fixture.images[0]!;
  assert(parse(toBase64(fromHex(c.hash))), "a hash in base64");
  assertEqual(parse(toBase64(fromHex(fixture.refused[0]!))), null, "a hash of no width");
  assertEqual(parse("not base64!"), null, "not base64");
});

const hash = toBase64(fromHex(fixture.images.find((c) => c.name === "landscape gradient")!.hash));

test("a slide's ThumbHash is read from markup, and a bad one ignored, with a warning", () => {
  const h = host();
  for (const value of [hash, "AAAAAA="]) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = "a.jpg";
    img.width = 3;
    img.height = 2;
    img.alt = "A";
    img.dataset["thumbhash"] = value;
    fig.append(img);
    h.append(fig);
  }
  const warnings: string[] = [];
  const [a, b] = readMarkup(h, (m) => warnings.push(m));
  assertEqual(a!.thumbhash, hash, "kept as given");
  assertEqual(b!.thumbhash, "", "the bad one ignored");
  assertEqual(warnings.length, 1, `one warning: ${warnings.join("; ")}`);
  assert(warnings[0]!.includes("data-thumbhash"), warnings[0]!);
});

test("a slide's ThumbHash from script must be one, in either shape", () => {
  const slide: SlideInput = { id: "a", alt: "A", width: 3, height: 2, sources: [{ url: "a.jpg", width: 3 }] };
  const [s] = fromInput([{ ...slide, placeholder: { thumbhash: hash } }]);
  assertEqual(s!.thumbhash, hash, "the manifest's shape");
  assertEqual(fromInput([s!])[0]!.thumbhash, hash, "Clack's shape, given back");
  assertEqual(fromInput([{ ...slide }])[0]!.thumbhash, "", "none");
  refuses(() => fromInput([{ ...slide, placeholder: { thumbhash: "3OcRJYB4" } }]), /ThumbHash/, "the manifest's shape, cut short");
  refuses(() => fromInput([{ ...s!, thumbhash: "3OcRJYB4" }]), /ThumbHash/, "Clack's shape, cut short");
  refuses(() => fromInput([{ ...s!, thumbhash: 7 as unknown as string }]), /thumbhash/, "not a string");
});

test("the first photo's place is painted from its ThumbHash while it loads", async () => {
  const show = makeShow([{ delay: 800 }]);
  show.querySelector("img")!.dataset["thumbhash"] = hash;
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill canvas"), "the impression");
  const canvas = part(show, ".placeholder .fill canvas") as HTMLCanvasElement;
  assertEqual(`${canvas.width}×${canvas.height}`, "32×23", "drawn at the hash's own size");
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

test("a slide without a ThumbHash has no impression painted", async () => {
  const show = makeShow([{ delay: 600 }]);
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill"), "the placeholder");
  assertEqual(show.shadowRoot!.querySelector(".placeholder canvas"), null, "no canvas");
  await settledOn(show, "1 of 1");
});
