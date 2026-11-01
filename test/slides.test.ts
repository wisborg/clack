import { fromInput, readMarkup, usableURL, type SlideInput } from "../src/slides";
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
  ];
  for (const [what, input] of cases) {
    assertThrows(() => fromInput(input as SlideInput[]), TypeError, what);
  }
});

test("usableURL allows http, https and relative URLs only", () => {
  for (const u of ["a.jpg", "/a.jpg", "//cdn.example.com/a.jpg", "https://example.com/a.jpg", "http://example.com"]) {
    assert(usableURL(u), `refused ${u}`);
  }
  for (const u of ["javascript:alert(1)", " javascript:alert(1)", "JAVASCRIPT:x", "data:,x", "blob:x", "file:///x", "mailto:a@b"]) {
    assert(!usableURL(u), `accepted ${u}`);
  }
});
