/**
 * Slides: what Clack shows, read from the host page's markup or given from
 * script, in one shape whatever the source.
 */

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
export function readMarkup(host: Element, warn: (message: string) => void): Slide[] {
  const slides: Slide[] = [];
  const ids = new Set<string>();
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
    let id = collapse(figure?.id || img.dataset["id"]) || String(n);
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

    slides.push({
      id,
      alt: alt ?? "",
      width,
      height,
      src: img.getAttribute("src") ?? "",
      srcset: img.getAttribute("srcset") ?? "",
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
export function fromInput(input: readonly SlideInput[]): Slide[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Clack: slides must be an array");
  }
  const ids = new Set<string>();
  return input.map((s, i): Slide => {
    const fail = (why: string): never => {
      throw new TypeError(`Clack: slide ${i + 1}: ${why}`);
    };
    if (typeof s !== "object" || s === null) fail("not an object");
    if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)) fail("id must be 1 to 64 letters, digits, - or _");
    if (ids.has(s.id)) fail(`the id "${s.id}" is already used`);
    ids.add(s.id);
    if (typeof s.alt !== "string") fail("alt must be a string");
    for (const [name, v] of [["width", s.width], ["height", s.height]] as const) {
      if (!Number.isInteger(v) || v < 1) fail(`${name} must be a positive integer`);
    }
    if (!Array.isArray(s.sources) || s.sources.length === 0) fail("sources must have at least one source");

    // Sources are grouped by type, in the order each type first appears.
    // The untyped group makes the <img>; each typed group makes a <source>.
    // With no untyped group, the last typed one -- conventionally the most
    // widely supported -- makes the <img> instead.
    const groups = new Map<string, { url: string; width: number }[]>();
    for (const [k, src] of s.sources.entries()) {
      if (typeof src?.url !== "string" || !usableURL(src.url)) fail(`source ${k + 1}: the URL must be http, https or relative`);
      if (!Number.isInteger(src.width) || src.width < 1) fail(`source ${k + 1}: width must be a positive integer`);
      const type = src.type ?? "";
      groups.set(type, [...(groups.get(type) ?? []), src]);
    }
    const imgType = groups.has("") ? "" : [...groups.keys()].pop()!;
    const imgSources = groups.get(imgType)!;
    groups.delete(imgType);
    const srcset = (list: { url: string; width: number }[]): string =>
      list.map((src) => `${srcsetURL(src.url)} ${src.width}w`).join(", ");
    const largest = imgSources.reduce((a, b) => (b.width > a.width ? b : a));

    const full = s.full?.url ?? "";
    if (full && !usableURL(full)) fail("the full-size URL must be http, https or relative");
    const page = s.page ?? "";
    if (page && !usableURL(page)) fail("the page URL must be http, https or relative");
    const color = s.placeholder?.color ?? "";

    return {
      id: s.id,
      alt: s.alt,
      width: s.width,
      height: s.height,
      src: largest.url,
      srcset: srcset(imgSources),
      alternatives: [...groups].map(([type, list]) => ({ type, srcset: srcset(list), media: "" })),
      full,
      page,
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "",
      title: collapse(s.description?.title),
      credit: collapse(s.description?.credit),
    };
  });
}

/**
 * A URL as it can stand in a srcset, where a comma or space would end it:
 * those are percent-encoded, which a server reads the same.
 */
function srcsetURL(url: string): string {
  return url.replace(/[,\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
