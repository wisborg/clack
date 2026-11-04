import { fromInput, readMarkup, srcsetURLs, usableURL, type SlideInput } from "../src/slides";
import { assert, assertEqual, assertThrows, fixture, test } from "./harness";

/** A URL as Clack keeps it: made absolute against the page when read or given. */
const abs = (url: string): string => new URL(url, document.baseURI).href;

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
  assertEqual(a!.srcset, "a-640.jpg 640w, a-1280.jpg 1280w", "srcset, as the page wrote it");
  assertEqual(a!.full, "a-full.jpg", "the full-size file, as written");
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
    { url: "a-1280,x.jpg", width: 1280 },
  ],
  description: { title: " The  title ", credit: "Me" },
};

test("fromInput groups sources by type", () => {
  const [s] = fromInput([ok]);
  assertEqual(s!.srcset, `${abs("a-640.jpg")} 640w, ${abs("a-1280,x.jpg")} 1280w`, "the <img>'s, a comma inside a URL left as it is");
  assertEqual(s!.src, abs("a-1280,x.jpg"), "src is the largest");
  assertEqual(s!.alternatives.length, 1, "one <source>");
  assertEqual(s!.alternatives[0]!.srcset, `${abs("a-640.avif")} 640w, ${abs("a-1280.avif")} 1280w`, "the avif sources");
  assertEqual(s!.title, "The title", "the title, collapsed");
  // With only typed sources, the last type makes the <img>.
  const [t] = fromInput([{ ...ok, sources: [{ url: "x.webp", width: 10, type: "image/webp" }, { url: "x.jpg", width: 10, type: "image/jpeg" }] }]);
  assertEqual(t!.srcset, `${abs("x.jpg")} 10w`, "the <img> takes the last type");
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
    ["a URL with a space, which a manifest would refuse too", [{ ...ok, sources: [{ url: "a b.jpg", width: 1 }] }]],
    ["seventeen sources, one more than a manifest allows", [{ ...ok, sources: Array.from({ length: 17 }, (_, k) => ({ url: `a${k}.jpg`, width: k + 1 })) }]],
    ["a type a manifest would refuse", [{ ...ok, sources: [{ url: "a.gif", width: 1, type: "image/gif" }] }]],
    ["a property a manifest would refuse", [{ ...ok, colour: "red" }]],
    ["a title that is not text", [{ ...ok, description: { title: 5 } }]],
    ["a page that is not text", [{ ...ok, page: 5 }]],
    ["a source type that is not text", [{ ...ok, sources: [{ url: "a.jpg", width: 1, type: 5 }] }]],
  ];
  for (const [what, input] of cases) {
    assertThrows(() => fromInput(input as SlideInput[]), TypeError, what);
  }
});

test("fromInput takes an object used twice, and undefined for an absent field", () => {
  const sources = [
    { url: "a-640.jpg", width: 640 },
    { url: "a-4000.jpg", width: 4000 },
  ];
  const [s] = fromInput([{ id: "a", alt: "", width: 4000, height: 3000, sources, full: sources[1]!, page: undefined, description: { title: "T", credit: undefined } }]);
  assertEqual(s!.full, abs("a-4000.jpg"), "the shared object, accepted");
  assertEqual(s!.title, "T", "undefined, taken as absent");
});

test("fromInput holds script slides to a manifest's rules beyond the schema too", () => {
  const twice = [{ ...ok, sources: [{ url: "a.jpg", width: 640 }, { url: "b.jpg", width: 640 }] }];
  assertThrows(() => fromInput(twice), TypeError, "two sources of one width and type");
  const sparse: unknown[] = [];
  sparse[1] = { url: "a.jpg", width: 10 };
  let message = "";
  try {
    fromInput([{ ...ok, sources: sparse as SlideInput["sources"] }]);
  } catch (e) {
    message = String(e);
  }
  assert(message.includes("Clack: slide 1: /sources/0"), `a hole, named by its place: ${message}`);
  const proto = JSON.parse(`{"id":"a","alt":"","width":1,"height":1,"sources":[{"url":"a.jpg","width":1}],"__proto__":1}`) as SlideInput;
  assertThrows(() => fromInput([proto]), TypeError, "a __proto__ field, refused as a manifest refuses it");
});

test("a script slide may nest exactly as deep as a manifest's", () => {
  let deep: unknown = [];
  for (let i = 0; i < 61; i++) deep = [deep];
  // The slide is 3 deep in a manifest; x-data 4; its arrays the rest.
  assertThrows(() => fromInput([{ ...ok, "x-data": deep }]), TypeError, "deeper than a manifest allows");
  let fits: unknown = [];
  for (let i = 0; i < 59; i++) fits = [fits];
  assertEqual(fromInput([{ ...ok, "x-data": fits }]).length, 1, "as deep as a manifest allows");
});

test("a renamed slide given back does not share its key with another", () => {
  const host = markup(["figure#b>img[src=b.jpg][width=3][height=2][alt=B]"]);
  const [b] = readMarkup(host, () => {});
  const renamed = { ...b!, id: "x" };
  const out = fromInput([renamed, { id: "b", alt: "", width: 1, height: 1, sources: [{ url: "n.jpg", width: 1 }] }]);
  assert(out[0]!.key !== out[1]!.key, `keys ${out[0]!.key} and ${out[1]!.key}`);
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

test("a credit can have a language of its own; a round trip keeps each", () => {
  const host = markup(["figure>img[src=a.jpg][width=3][height=2][alt=A][lang=de]"]);
  const cap = document.createElement("figcaption");
  cap.append("Low tide ");
  const small = document.createElement("small");
  small.lang = "da";
  small.textContent = "Foto: Jens Hansen";
  cap.append(small);
  host.firstElementChild!.append(cap);
  const [slide] = readMarkup(host, () => {});
  assertEqual(slide!.captionLang, null, "the caption: the page's");
  assertEqual(slide!.creditLang, "da", "the credit: its own");
  const [back] = fromInput([slide!]);
  assertEqual(back!.captionLang, null, "the caption's null kept, not the photo's language put in its place");
  assertEqual(back!.creditLang, "da", "the credit's kept");
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

test("markup URLs are used as the page wrote them, and an <img> with none has none", () => {
  const host = markup([
    "figure>img[width=3][height=2][alt=A][data-src=lazy.jpg]",
    "figure>img[src=a.jpg][srcset=/cdn/w_640,h_427/a.jpg 640w][width=3][height=2][alt=B]",
  ]);
  const [a, b] = readMarkup(host, () => {});
  assertEqual(a!.src, "", "no src: none, not the page's own address");
  assertEqual(b!.srcset, "/cdn/w_640,h_427/a.jpg 640w", "a comma inside a CDN-style URL, as written");
});

test("a URL that srcset could not hold is encoded, and nothing else", () => {
  const [s] = fromInput([{ ...ok, sources: [{ url: "https://cdn.example.com/w_640,h_427/a.jpg", width: 640 }, { url: "https://cdn.example.com/a.jpg,", width: 1280 }] }]);
  assertEqual(s!.srcset, "https://cdn.example.com/w_640,h_427/a.jpg 640w, https://cdn.example.com/a.jpg%2C 1280w", "only the trailing comma");
});

test("a shared object cannot carry a value deeper than a manifest allows", () => {
  let d: unknown = [];
  for (let i = 0; i < 58; i++) d = [d]; // fits where first met, under x-a
  assertThrows(() => fromInput([{ ...ok, "x-a": d, "x-b": [[[[d]]]] }]), TypeError, "too deep where it is met again");
  assertEqual(fromInput([{ ...ok, "x-a": d, "x-b": d }]).length, 1, "the same depth twice is fine");
});
