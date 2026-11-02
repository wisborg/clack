/**
 * Manifests: the slides of a show as a JSON file, format clack-manifest/1
 * (docs/manifest.md, schema/manifest-1.schema.json).
 *
 * A manifest comes from somewhere other than the page, so every value in
 * it is checked before any of it is used, against the published schema
 * itself, and a manifest that breaks any rule is refused whole, with every
 * problem named by its place in the file. The tools check against the same
 * schema in Go (tools/internal/formats), and both are held to the same
 * cases (test/fixtures/manifests.json).
 */
import manifestSchema from "../schema/manifest-1.schema.json";
import { byCodePoint, escape, Schema, type Problem } from "./schema";
import { convert, type Keyed, type SlideInput } from "./slides";

export type { Problem };

/** A manifest, checked, with every URL resolved against the manifest's own. */
export interface Manifest {
  title: string;
  description: string;
  lang: string;
  slides: Keyed[];
}

/** A manifest that was refused, with every problem found. */
export class ManifestError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[]) {
    const shown = problems.slice(0, 5).map((p) => `${p.path || "(document)"}: ${p.message}`);
    if (problems.length > 5) shown.push(`and ${problems.length - 5} more`);
    super(`Clack: the manifest was refused: ${shown.join("; ")}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

// The published schema itself (schema/manifest-1.schema.json), as the
// build ships it: its rules, without its explanations.
let compiled: Schema | undefined;

/**
 * How deeply a manifest's values may nest -- far beyond any real manifest,
 * whose slides go five deep. The tools apply the same limit
 * (formats.CheckJSON), so the two agree on every file.
 */
export const maxDepth = 64;

/**
 * What is wrong with a parsed document before any schema is consulted:
 * values nested more than maxDepth deep, and numbers too large to be held
 * (JSON.parse makes them Infinity). Walks with a stack of its own, so no
 * document can exhaust the call stack.
 */
function checkJSON(doc: unknown): Problem[] {
  // Each value remembers its parent and its key; its path is spelt out
  // only for a value with a problem, not for each of a large manifest's
  // million values.
  interface Item {
    v: unknown;
    parent: Item | null;
    key: string;
    depth: number;
  }
  const pathOf = (it: Item): string => (it.parent ? `${pathOf(it.parent)}/${escape(it.key)}` : "");
  const problems: Problem[] = [];
  const stack: Item[] = [{ v: doc, parent: null, key: "", depth: 1 }];
  while (stack.length > 0) {
    const it = stack.pop()!;
    const v = it.v;
    if (typeof v === "number" && !Number.isFinite(v)) {
      problems.push({ path: pathOf(it), message: "is a number too large to hold" });
    } else if (typeof v === "object" && v !== null) {
      if (it.depth > maxDepth) {
        problems.push({ path: pathOf(it), message: `nests more than ${maxDepth} deep` });
        continue;
      }
      for (const key of Object.keys(v)) {
        stack.push({ v: (v as Record<string, unknown>)[key], parent: it, key, depth: it.depth + 1 });
      }
    }
  }
  return problems;
}

/**
 * Checks a parsed manifest against the format, returning every problem; none
 * means it is valid. It never throws, whatever it is given.
 */
export function check(doc: unknown): Problem[] {
  const shape = checkJSON(doc);
  if (shape.length > 0) {
    return shape.sort((a, b) => byCodePoint(a.path, b.path));
  }
  compiled ??= new Schema(manifestSchema);
  const problems = compiled.validate(doc, false);
  // Beyond the schema: ids are unique, and a slide offers each size of each
  // type once (tools/internal/formats.CheckManifest). Both consider only
  // what the schema accepts -- an id that is a string; a width that is a
  // whole number from 1 to 100,000; a type that is absent or a string --
  // and leave the rest to the schema's own errors, so the two report the
  // same places whatever the values (Go and JavaScript spell -0 or 1e20
  // differently).
  const slides = (doc as { slides?: unknown } | null)?.slides;
  if (Array.isArray(slides)) {
    const ids = new Map<string, number>();
    slides.forEach((slide: unknown, i) => {
      const s = slide as { id?: unknown; sources?: unknown } | null;
      if (typeof s?.id === "string") {
        const first = ids.get(s.id);
        if (first !== undefined) problems.push({ path: `/slides/${i}/id`, message: `"${s.id}" is also the id of slide ${first}` });
        else ids.set(s.id, i);
      }
      if (Array.isArray(s?.sources)) {
        const seen = new Set<string>();
        s.sources.forEach((src: unknown, k) => {
          const o = src as { width?: unknown; type?: unknown } | null;
          const w = o?.width;
          if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 100000) return;
          if (o!.type !== undefined && typeof o!.type !== "string") return;
          const key = `${w} ${o!.type ?? ""}`;
          if (seen.has(key)) problems.push({ path: `/slides/${i}/sources/${k}`, message: "another source has the same width and type" });
          seen.add(key);
        });
      }
    });
  }
  // In order of place, as the tools list them.
  return problems.sort((a, b) => byCodePoint(a.path, b.path));
}

/**
 * Reads a manifest: parses the text, checks it, and resolves its URLs
 * against base (the URL it came from). Throws a ManifestError naming every
 * problem, or a SyntaxError for text that is not JSON; nothing else.
 */
export function parse(text: string, base: string): Manifest {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    // A parser may give up on a document too deep for it with something
    // other than a SyntaxError; to the caller it is all text that is not
    // a manifest.
    throw e instanceof SyntaxError ? e : new SyntaxError(String(e));
  }
  const problems = check(doc);
  if (problems.length > 0) {
    throw new ManifestError(problems);
  }
  const m = doc as { title?: string; description?: string; lang?: string; slides: SlideInput[] };
  // Every URL becomes absolute, resolved against the manifest's, and must
  // then be http or https. One the URL parser refuses (a bad port, a broken
  // host) is a problem in the manifest like any other, named by its place;
  // all are gathered first.
  const unresolved: Problem[] = [];
  const resolve = (url: string, path: string): string => {
    let u: URL;
    try {
      u = new URL(url, base);
    } catch {
      unresolved.push({ path, message: "is not a URL that can be resolved" });
      return url;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") unresolved.push({ path, message: "does not resolve to an http or https URL" });
    return u.href;
  };
  const slides = m.slides.map((s, i): Keyed => {
    const out: SlideInput = {
      ...s,
      sources: s.sources.map((src, k) => ({ ...src, url: resolve(src.url, `/slides/${i}/sources/${k}/url`) })),
    };
    if (s.full) out.full = { ...s.full, url: resolve(s.full.url, `/slides/${i}/full/url`) };
    if (s.page) out.page = resolve(s.page, `/slides/${i}/page`);
    // Checked whole already, against the schema: converted, not checked again.
    return convert(out, m.lang ?? "");
  });
  if (unresolved.length > 0) {
    throw new ManifestError(unresolved);
  }
  return {
    title: m.title ?? "",
    description: m.description ?? "",
    lang: m.lang ?? "",
    slides,
  };
}

/**
 * Turns a manifest's bytes into text: UTF-8, strictly. A byte-order mark is
 * kept, and so refused as not JSON, as the tools refuse it (JSON has none:
 * RFC 8259, 8.1). Bytes that are not UTF-8 are a ManifestError.
 */
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ManifestError([{ path: "", message: "is not UTF-8" }]);
  }
}

/** The most a manifest may weigh: 20,000 slides with all their metadata fit with room to spare. */
export const maxBytes = 16 * 1024 * 1024;

/**
 * Fetches and reads the manifest at url. Only JSON is accepted (by its
 * Content-Type), and no more than maxBytes of it; the request carries
 * cookies to the page's own origin only, and can be cancelled with signal.
 * A response refused before it is read is cancelled, not left to download.
 */
export async function load(url: string, signal: AbortSignal): Promise<Manifest> {
  const response = await fetch(url, { credentials: "same-origin", signal, headers: { Accept: "application/json" } });
  const refuse = async (why: string): Promise<never> => {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Clack: ${why}`);
  };
  if (!response.ok) {
    await refuse(`the manifest could not be fetched: ${response.status} ${response.statusText}`.trim());
  }
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    await refuse(`the manifest must be served as application/json, not ${type || "nothing"}`);
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await refuse(`the manifest is larger than ${maxBytes} bytes`);
  }
  // Read in pieces, so a manifest that does not say its size, or says it
  // wrongly, still cannot be larger than the limit.
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Clack: the manifest has no body");
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Clack: the manifest is larger than ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return parse(decode(bytes), response.url || url);
}
