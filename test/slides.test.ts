import { fromInput, readMarkup, srcsetURLs, usableURL, type SlideInput } from "../src/slides";
import { assert, assertEqual, assertThrows, fixture, test } from "./harness";

function markup(html: string[]): HTMLElement {
  // Built from parts with DOM calls: the page's policy forbids parsing
  // markup from strings, and so would Trusted Types.
  const host = fixture();
  for (const make of html) {
    host.append(build(make));
  }
  return host;
}

// A tiny builder: "figure#a>img[src=a.jpg][width=300][height=200][alt=A]".
function build(spec: string): Element {
  const [head, ...rest] = spec.split(">");
  const m = /^([a-z]+)(#[^[]+)?((?:\[[^\]]*\])*)$/.exec(head!);
  assert(m, `bad spec ${spec}`);
  const e = document.createElement(m[1]!);
  if (m[2]) e.id = m[2].slice(1);
  for (const [, k, v] of m[3]!.matchAll(/\[([a-z-]+)(?:=([^\]]*))?\]/g)) {
    if (k === "text") e.textContent = v ?? "";
    else e.setAttribute(k!, v ?? "");
  }
  if (rest.length) e.append(build(rest.join(">")));
  return e;
}

test("readMarkup reads figures, pictures and bare images", () => {
  const host = markup([
    "figure#dawn>img[src=a.jpg][srcset=a-640.jpg 640w, a-1280.jpg 1280w][width=3000][height=2000][alt=Low tide][data-full=a-full.jpg][data-color=#8a8d8c]",
    "img[src=b.jpg][width=200][height=300][alt=B]",
    "p[text=not a slide]",
  ]);
  const cap = document.createElement("figcaption");
  cap.append("Low ", "tide  at\n dawn");
  const small = document.createElement("small");
  small.textContent = "Public domain";
  cap.append(small);
  host.firstElementChild!.append(cap);
  const picture = build("figure>picture>source[type=image/avif][srcset=c.avif 800w]");
  picture.querySelector("picture")!.append(build("img[src=c.jpg][width=800][height=600][alt=C]"));
  host.append(picture);

  const warnings: string[] = [];
  const slides = readMarkup(host, (m) => warnings.push(m));
  assertEqual(slides.length, 3, "slides");
  const [a, b, c] = slides;
  assertEqual(a!.id, "dawn", "the figure's id");
  assertEqual(a!.alt, "Low tide", "alt");
  assertEqual(a!.width, 3000, "width");
  assertEqual(a!.srcset, "a-640.jpg 640w, a-1280.jpg 1280w", "srcset, as written");
  assertEqual(a!.full, "a-full.jpg", "the full-size file");
  assertEqual(a!.color, "#8a8d8c", "the placeholder colour");
  assertEqual(a!.title, "Low tide at dawn", "the title, its spaces collapsed");
  assertEqual(a!.credit, "Public domain", "the credit, from <small>");
  assertEqual(b!.id, "2", "a slide with no id is numbered");
  assertEqual(b!.title, "", "no caption");
  assertEqual(c!.alternatives.length, 1, "the picture's source");
  assertEqual(c!.alternatives[0]!.type, "image/avif", "its type");
  assertEqual(warnings.length, 0, `warnings: ${warnings.join("; ")}`);
});

test("readMarkup takes the figure's photo, not an image in its caption", () => {
  const host = markup(["figure>figcaption>img[src=icon.png][width=16][height=16][alt=icon]"]);
  host.firstElementChild!.append(build("img[src=photo.jpg][width=3][height=2][alt=Photo]"));
  const [slide] = readMarkup(host, () => {});
  assertEqual(slide!.src, "photo.jpg", "the photo");
});

test("readMarkup never gives two slides one id", () => {
  // Slide 1 is called "2"; slide 2 has no id, so would be "2" by number.
  const host = markup(["figure#2>img[src=a.jpg][width=3][height=2][alt=A]", "figure>img[src=b.jpg][width=3][height=2][alt=B]", "figure#2-2>img[src=c.jpg][width=3][height=2][alt=C]"]);
  const ids = readMarkup(host, () => {}).map((s) => s.id);
  assertEqual(new Set(ids).size, 3, `ids ${ids.join(", ")}`);
  assertEqual(ids[0], "2", "the first keeps its own");
});

test("readMarkup ignores a full-size URL that is not http(s)", () => {
  const host = markup(["figure>img[src=a.jpg][width=3][height=2][alt=A][data-full=javascript:alert(1)]"]);
  const warnings: string[] = [];
  const [slide] = readMarkup(host, (m) => warnings.push(m));
  assertEqual(slide!.full, "", "the full-size URL is dropped");
  assert(warnings.some((w) => w.includes("data-full")), "with a warning");
});

test("readMarkup warns of what it has to guess", () => {
  const host = markup(["figure#x>img[src=a.jpg]", "figure#x>img[src=b.jpg][width=3][height=2][alt=]"]);
  const warnings: string[] = [];
  const slides = readMarkup(host, (m) => warnings.push(m));
  assertEqual(slides.length, 2, "both are still shown");
  assert(warnings.some((w) => w.includes("no alt text")), "warns of missing alt");
  assert(warnings.some((w) => w.includes("width and height")), "warns of a missing size");
  assert(warnings.some((w) => w.includes("already used")), "warns of a repeated id");
  assertEqual(slides[1]!.id, "2", "the repeat is renumbered");
  assertEqual(slides[1]!.alt, "", "an empty alt is kept as empty");
});

const ok: SlideInput = {
  id: "a",
  alt: "A",
  width: 3000,
  height: 2000,
  sources: [
    { url: "a-640.avif", width: 640, type: "image/avif" },
    { url: "a-640.jpg", width: 640 },
    { url: "a-1280.avif", width: 1280, type: "image/avif" },
    { url: "a 1280,x.jpg", width: 1280 },
  ],
  description: { title: " The  title ", credit: "Me" },
};

test("fromInput groups sources by type", () => {
  const [s] = fromInput([ok]);
  assertEqual(s!.srcset, "a-640.jpg 640w, a%201280%2Cx.jpg 1280w", "the <img>'s, with space and comma encoded");
  assertEqual(s!.src, "a 1280,x.jpg", "src is the largest");
  assertEqual(s!.alternatives.length, 1, "one <source>");
  assertEqual(s!.alternatives[0]!.srcset, "a-640.avif 640w, a-1280.avif 1280w", "the avif sources");
  assertEqual(s!.title, "The title", "the title, collapsed");
  // With only typed sources, the last type makes the <img>.
  const [t] = fromInput([{ ...ok, sources: [{ url: "x.webp", width: 10, type: "image/webp" }, { url: "x.jpg", width: 10, type: "image/jpeg" }] }]);
  assertEqual(t!.srcset, "x.jpg 10w", "the <img> takes the last type");
  assertEqual(t!.alternatives.map((a) => a.type).join(), "image/webp", "the other makes a <source>");
});

test("fromInput refuses what cannot be shown", () => {
  const cases: [string, unknown][] = [
    ["a javascript: URL", [{ ...ok, sources: [{ url: "javascript:alert(1)", width: 10 }] }]],
    ["a data: URL", [{ ...ok, sources: [{ url: "data:image/png;base64,AA", width: 10 }] }]],
    ["a javascript: page", [{ ...ok, page: "javascript:alert(1)" }]],
    ["a data: full size", [{ ...ok, full: { url: "data:," } }]],
    ["no sources", [{ ...ok, sources: [] }]],
    ["a zero width", [{ ...ok, width: 0 }]],
    ["a bad id", [{ ...ok, id: "a/b" }]],
    ["a repeated id", [ok, ok]],
    ["no alt", [{ ...ok, alt: undefined }]],
    ["not an array", { length: 1 }],
    ["a title that is not text", [{ ...ok, description: { title: 5 } }]],
    ["a page that is not text", [{ ...ok, page: 5 }]],
    ["a source type that is not text", [{ ...ok, sources: [{ url: "a.jpg", width: 1, type: 5 }] }]],
  ];
  for (const [what, input] of cases) {
    assertThrows(() => fromInput(input as SlideInput[]), TypeError, what);
  }
});

test("fromInput takes null for an absent field, as serialisers write it", () => {
  const [s] = fromInput([{ ...ok, page: null, description: { title: null, credit: null }, placeholder: { color: null } } as unknown as SlideInput]);
  assertEqual(s!.page, "", "page");
  assertEqual(s!.title, "", "title");
});

test("a markup slide's languages are those set inside the show", () => {
  const host = markup([
    "figure>img[src=a.jpg][width=3][height=2][alt=A]",
    "figure[lang=da]>img[src=b.jpg][width=3][height=2][alt=B]",
    "figure>img[src=c.jpg][width=3][height=2][alt=C][lang=de]",
    "figure[lang=]>img[src=d.jpg][width=3][height=2][alt=D]",
  ]);
  const cap = document.createElement("figcaption");
  cap.lang = "fr";
  cap.textContent = "Un chien";
  host.children[2]!.append(cap);
  host.setAttribute("lang", "en");
  const [a, b, c, d] = readMarkup(host, () => {});
  assertEqual(a!.lang, null, "none set: the page's, inherited");
  assertEqual(b!.lang, "da", "the figure's");
  assertEqual(c!.lang, "de", "the photo's own, for its description");
  assertEqual(c!.captionLang, "fr", "the caption's own, for the caption");
  assertEqual(d!.lang, "", "unknown, kept as unknown");
});

test("a slide's language survives being read and given back", () => {
  const host = markup(["figure[lang=x-klingon]>img[src=a.jpg][width=3][height=2][alt=A]"]);
  const [slide] = readMarkup(host, () => {});
  const [back] = fromInput([slide!]);
  assertEqual(back!.lang, "x-klingon", "kept");
});

test("usableURL allows http, https and relative URLs only", () => {
  for (const u of ["a.jpg", "/a.jpg", "//cdn.example.com/a.jpg", "https://example.com/a.jpg", "http://example.com"]) {
    assert(usableURL(u), `refused ${u}`);
  }
  for (const u of ["javascript:alert(1)", " javascript:alert(1)", "JAVASCRIPT:x", "data:,x", "blob:x", "file:///x", "mailto:a@b"]) {
    assert(!usableURL(u), `accepted ${u}`);
  }
});

test("srcsetURLs reads a srcset as browsers do", () => {
  const cases: [string, string[]][] = [
    ["a.jpg 640w, b.jpg 1280w", ["a.jpg", "b.jpg"]],
    ["a.jpg", ["a.jpg"]],
    ["  a.jpg 1x ,b.jpg 2x  ", ["a.jpg", "b.jpg"]],
    ["a,b.jpg 640w, c.jpg", ["a,b.jpg", "c.jpg"]],
    ["a.jpg,, b.jpg", ["a.jpg", "b.jpg"]],
    ["javascript:x 1x, b.jpg 2x", ["javascript:x", "b.jpg"]],
    ["", []],
  ];
  for (const [set, want] of cases) {
    assertEqual(srcsetURLs(set).join(" | "), want.join(" | "), JSON.stringify(set));
  }
});
