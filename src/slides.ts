/**
 * Slides: what Clack shows, read from the host page's markup or given from
 * script, in one shape whatever the source.
 */
import manifestSchema from "../schema/manifest-1.schema.json";

/** One `<source>` of a `<picture>`: the same photo in another format. */
export interface Alternative {
  type: string;
  srcset: string;
  media: string;
}

/** A slide, as Clack uses it. */
export interface Slide {
  /** Stable and unique in the show, for links and for keeping one's place. */
  id: string;
  alt: string;
  /** The photo's size in pixels, as shown; its proportions are kept before it loads. */
  width: number;
  height: number;
  src: string;
  /** A srcset of width descriptors, or "" for only src. */
  srcset: string;
  alternatives: Alternative[];
  /** The full-size file, or "" to use the largest source. */
  full: string;
  /** The photo's own page, or "". */
  page: string;
  /** A colour to paint while the photo loads, or "". */
  color: string;
  title: string;
  credit: string;
}

/**
 * A slide as the show keeps it: with `key`, what identifies it across
 * changes to the slides. That is its id when it was given one; a slide
 * without one is numbered by its place, which shifts when a slide is added
 * before it, so it is known by its photo instead.
 */
export interface Keyed extends Slide {
  key: string;
  /**
   * The language of the slide's own text (its caption, its description),
   * or "" for the page's: a manifest's, for its slides; the markup's, for
   * those read from the page. Text on screen is marked with the language
   * of the slide it belongs to, whichever show it came from.
   */
  lang: string;
}

// The published schema's rule for a language tag, not a copy of it.
const langPattern = new RegExp(manifestSchema.$defs.lang.pattern, "u");

/** A slide as given from script: the slide format of a manifest. */
export interface SlideInput {
  id: string;
  alt: string;
  width: number;
  height: number;
  sources: { url: string; width: number; type?: string }[];
  full?: { url: string };
  page?: string;
  placeholder?: { color?: string };
  description?: { title?: string; credit?: string };
}

const collapse = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

function positive(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Reads the slides from a show's markup: each child `<figure>` holding an
 * `<img>` (bare or in a `<picture>`), or each child `<img>`. Anything else
 * is left alone. The figure's `<figcaption>` is the title, and a `<small>`
 * in it the credit. Problems that do not stop a slide being shown are
 * passed to warn.
 */
export function readMarkup(host: Element, warn: (message: string) => void): Keyed[] {
  const slides: Keyed[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const child of host.children) {
    const figure = child.localName === "figure" ? child : null;
    // The figure's photo, not an icon that happens to sit in its caption.
    const img = figure
      ? Array.from(figure.querySelectorAll("img")).find((i) => !i.closest("figcaption"))
      : child.localName === "img"
        ? child
        : null;
    if (!(img instanceof HTMLImageElement)) {
      continue;
    }
    const n = slides.length + 1;
    const given = collapse(figure?.id || img.dataset["id"]);
    let id = given || String(n);
    if (ids.has(id)) {
      // Its number, unless that is taken too (an earlier figure may have
      // it as its id), and then its number with a suffix.
      const asked = id;
      id = String(n);
      for (let k = 2; ids.has(id); k++) {
        id = `${n}-${k}`;
      }
      warn(`slide ${n}: the id "${asked}" is already used; using "${id}" instead`);
    }
    ids.add(id);

    const alt = img.getAttribute("alt");
    if (alt === null) {
      warn(`slide ${n}: the <img> has no alt text; describe the photo, or give alt="" if the caption already does`);
    }
    let width = positive(img.getAttribute("width"));
    let height = positive(img.getAttribute("height"));
    if (!width || !height) {
      warn(`slide ${n}: the <img> needs width and height, so its space is kept before it loads`);
      width = 3;
      height = 2;
    }

    const alternatives: Alternative[] = [];
    const picture = img.parentElement?.localName === "picture" ? img.parentElement : null;
    for (const source of picture?.querySelectorAll(":scope > source") ?? []) {
      const srcset = source.getAttribute("srcset");
      if (srcset) {
        alternatives.push({
          type: source.getAttribute("type") ?? "",
          srcset,
          media: source.getAttribute("media") ?? "",
        });
      }
    }

    // Checked now, though nothing uses it yet: the full-size view will,
    // and a URL that is not http(s) must never reach a link or an image.
    let full = img.dataset["full"] ?? "";
    if (full && !usableURL(full)) {
      warn(`slide ${n}: data-full must be an http, https or relative URL; it is ignored`);
      full = "";
    }

    const caption = figure?.querySelector(":scope > figcaption");
    let title = "";
    let credit = "";
    if (caption) {
      const small = caption.querySelector("small");
      credit = collapse(small?.textContent);
      title = collapse(
        Array.from(caption.childNodes)
          .filter((node) => node !== small)
          .map((node) => node.textContent)
          .join(" "),
      );
    }

    const src = img.getAttribute("src") ?? "";
    const srcset = img.getAttribute("srcset") ?? "";
    let key = given ? `id:${id}` : `photo:${src} ${srcset}`;
    for (let k = 2; keys.has(key); k++) {
      key = `${given ? `id:${id}` : `photo:${src} ${srcset}`}#${k}`;
    }
    keys.add(key);

    slides.push({
      key,
      lang: markupLang(figure ?? img, host),
      id,
      alt: alt ?? "",
      width,
      height,
      src,
      srcset,
      alternatives,
      full,
      page: "",
      color: /^#[0-9a-fA-F]{6}$/.test(img.dataset["color"] ?? "") ? img.dataset["color"]! : "",
      title,
      credit,
    });
  }
  return slides;
}

/**
 * The language a slide's markup is marked with inside the show, or "" to
 * inherit the page's, as the show's own text does. Only lang attributes
 * between the slide and the show count: one further out applies to the
 * whole show already, and is followed as it changes.
 */
function markupLang(e: Element, host: Element): string {
  for (let at: Element | null = e; at && at !== host; at = at.parentElement) {
    const lang = at.getAttribute("lang");
    if (lang !== null) return lang;
  }
  return "";
}

/**
 * Whether a URL may be used: http or https once resolved against the
 * document. Anything else -- javascript:, data:, blob:, file: -- is refused.
 */
export function usableURL(url: string): boolean {
  try {
    const protocol = new URL(url, document.baseURI).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Turns slides given from script into Clack's own, refusing what cannot be
 * shown with a TypeError that says which slide and why. The full manifest
 * format is checked by the manifest loader; this checks what a slide needs.
 */
export function fromInput(input: readonly (SlideInput | Slide)[]): Keyed[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Clack: slides must be an array");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const unique = (slide: Keyed): Keyed => {
    if (keys.has(slide.key)) slide.key = `id:${slide.id}`;
    keys.add(slide.key);
    return slide;
  };
  return input.map((s, i): Keyed => {
    const fail = (why: string): never => {
      throw new TypeError(`Clack: slide ${i + 1}: ${why}`);
    };
    if (typeof s !== "object" || s === null) fail("not an object");
    if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)) fail("id must be 1 to 64 letters, digits, - or _");
    if (ids.has(s.id)) fail(`the id "${s.id}" is already used`);
    ids.add(s.id);
    if (typeof s.alt !== "string") fail("alt must be a string");
    // Absent, null (as many serialisers write an empty field) or a string.
    const text = (v: unknown, what: string): void => {
      if (v !== undefined && v !== null && typeof v !== "string") fail(`${what} must be a string`);
    };
    for (const [name, v] of [["width", s.width], ["height", s.height]] as const) {
      if (!Number.isInteger(v) || v < 1) fail(`${name} must be a positive integer`);
    }
    if (isSlide(s)) {
      return unique(checkSlide(s, fail));
    }
    if (!Array.isArray(s.sources) || s.sources.length === 0) fail("sources must have at least one source");
    for (const [k, src] of s.sources.entries()) {
      if (typeof src?.url !== "string" || !usableURL(src.url)) fail(`source ${k + 1}: the URL must be http, https or relative`);
      if (!Number.isInteger(src.width) || src.width < 1) fail(`source ${k + 1}: width must be a positive integer`);
      text(src.type, `source ${k + 1}: type`);
    }
    if (s.full && (typeof s.full.url !== "string" || !usableURL(s.full.url))) fail("the full-size URL must be http, https or relative");
    text(s.page, "the page URL");
    if (s.page && !usableURL(s.page)) fail("the page URL must be http, https or relative");
    text(s.description?.title, "the title");
    text(s.description?.credit, "the credit");
    text(s.placeholder?.color, "the placeholder colour");
    return unique(convert(s, ""));
  });
}

/**
 * Turns a slide in the manifest's shape into Clack's, without checking it:
 * the caller has (fromInput, or the manifest loader, which checks the whole
 * manifest against its schema first).
 */
export function convert(s: SlideInput, lang: string): Keyed {
  // Sources are grouped by type, in the order each type first appears.
  // The untyped group makes the <img>; each typed group makes a <source>.
  // With no untyped group, the last typed one -- conventionally the most
  // widely supported -- makes the <img> instead.
  const groups = new Map<string, { url: string; width: number }[]>();
  for (const src of s.sources) {
    const type = src.type ?? "";
    groups.set(type, [...(groups.get(type) ?? []), src]);
  }
  const imgType = groups.has("") ? "" : [...groups.keys()].pop()!;
  const imgSources = groups.get(imgType)!;
  groups.delete(imgType);
  const srcset = (list: { url: string; width: number }[]): string =>
    list.map((src) => `${srcsetURL(src.url)} ${src.width}w`).join(", ");
  const largest = imgSources.reduce((a, b) => (b.width > a.width ? b : a));
  const color = s.placeholder?.color ?? "";
  return {
    key: `id:${s.id}`,
    lang,
    id: s.id,
    alt: s.alt,
    width: s.width,
    height: s.height,
    src: largest.url,
    srcset: srcset(imgSources),
    alternatives: [...groups].map(([type, list]) => ({ type, srcset: srcset(list), media: "" })),
    full: s.full?.url ?? "",
    page: s.page ?? "",
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "",
    title: collapse(s.description?.title),
    credit: collapse(s.description?.credit),
  };
}

/**
 * A URL as it can stand in a srcset, where a comma or space would end it:
 * those are percent-encoded, which a server reads the same.
 */
function srcsetURL(url: string): string {
  return url.replace(/[,\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** Whether a slide given from script is in Clack's own shape (as the `slides` getter returns), not a manifest's. */
function isSlide(s: SlideInput | Slide): s is Slide {
  return typeof (s as Slide).src === "string" && !("sources" in s);
}

/**
 * Checks a slide in Clack's own shape -- one the page read from `slides`
 * and gives back, perhaps changed -- as strictly as one in a manifest's:
 * every URL, in src, in each srcset and in each source, must be http, https
 * or relative. (The id, alt and size were checked by the caller.)
 */
function checkSlide(s: Slide, fail: (why: string) => never): Keyed {
  const str = (v: unknown, what: string): string => (typeof v === "string" ? v : fail(`${what} must be a string`));
  if (!usableURL(s.src)) fail("src must be an http, https or relative URL");
  const srcsetOK = (set: string, what: string): string => {
    for (const url of srcsetURLs(str(set, what))) {
      if (!usableURL(url)) fail(`${what}: every URL must be http, https or relative`);
    }
    return set;
  };
  if (!Array.isArray(s.alternatives)) fail("alternatives must be an array");
  const full = str(s.full ?? "", "full");
  if (full && !usableURL(full)) fail("the full-size URL must be http, https or relative");
  const page = str(s.page ?? "", "page");
  if (page && !usableURL(page)) fail("the page URL must be http, https or relative");
  const color = str(s.color ?? "", "color");
  // A slide read from the show and given back keeps its identity, so its
  // photo is not fetched again; the caller makes sure keys are unique.
  const { key, lang } = s as Partial<Keyed>;
  return {
    key: typeof key === "string" && key ? key : `id:${s.id}`,
    lang: typeof lang === "string" && langPattern.test(lang) ? lang : "",
    id: s.id,
    alt: s.alt,
    width: s.width,
    height: s.height,
    src: s.src,
    srcset: srcsetOK(s.srcset ?? "", "srcset"),
    alternatives: s.alternatives.map((a, k) => ({
      type: str(a?.type ?? "", `alternative ${k + 1}: type`),
      media: str(a?.media ?? "", `alternative ${k + 1}: media`),
      srcset: srcsetOK(a?.srcset, `alternative ${k + 1}: srcset`),
    })),
    full,
    page,
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "",
    title: collapse(str(s.title ?? "", "title")),
    credit: collapse(str(s.credit ?? "", "credit")),
  };
}

/**
 * The URLs in a srcset, read as the HTML standard reads one: a URL runs to
 * the next whitespace, loses any commas at its end, and its descriptors run
 * to the next comma.
 */
export function srcsetURLs(srcset: string): string[] {
  const urls: string[] = [];
  let i = 0;
  const space = /[\t\n\f\r ]/;
  while (i < srcset.length) {
    while (i < srcset.length && (space.test(srcset[i]!) || srcset[i] === ",")) i++;
    if (i >= srcset.length) break;
    let j = i;
    while (j < srcset.length && !space.test(srcset[j]!)) j++;
    let url = srcset.slice(i, j);
    i = j;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      // Descriptors, to the next comma outside parentheses.
      let depth = 0;
      while (i < srcset.length) {
        const c = srcset[i]!;
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) break;
        i++;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}
