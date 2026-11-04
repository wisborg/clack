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
import { checkSlideRules, maxDepth, maxProblems, rules } from "./rules";
import { describeProblems, escape, sortProblems, type Problem } from "./schema";
import { convert, resolveHTTP, type Keyed, type SlideInput } from "./slides";

export type { Problem };
export { describeProblems };

/** A manifest, checked, with every URL resolved against the manifest's own. */
export interface Manifest {
  title: string;
  description: string;
  /** The language of its text, or null to inherit the page's. */
  lang: string | null;
  slides: Keyed[];
}

/** A manifest that was refused, with every problem found. */
export class ManifestError extends Error {
  readonly problems: Problem[];

  constructor(problems: Problem[]) {
    const shown = describeProblems(problems.slice(0, 5)).map((l) => l.trim());
    if (problems.length > 5) shown.push(`and ${problems.length - 5} more`);
    super(`Clack: the manifest was refused: ${shown.join("; ")}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with a parsed value before any schema is consulted, added
 * to out: values nested more than maxDepth deep; numbers too large to be
 * held (JSON.parse makes them Infinity); and strings, names included, that
 * are not well-formed Unicode -- a lone surrogate, which the tools' decoder
 * would turn into U+FFFD, merging names that differ here. That last is
 * reported once, against the whole file, as the tools report it (they find
 * it in the raw text, before any path exists); the message says where.
 *
 * v sits at path, depth deep in its document; skip, if v holds it, is left
 * for a later call. The walk is depth first, in the document's order, so
 * once out holds maxProblems the ones kept are the earliest. It keeps its
 * own stack -- each container and how far through it -- so no document can
 * exhaust the call stack, and spells out a path only for a problem.
 */
function checkJSON(v: unknown, path: string, depth: number, out: Problem[], lone: Problem[], skip?: unknown): void {
  interface Frame {
    c: object;
    keys: string[] | null; // null for an array, walked by index
    i: number;
    key: string | number; // its key in the frame below
    depth: number;
  }
  const frames: Frame[] = [];
  const pathTo = (key?: string | number): string => {
    let p = path;
    for (let f = 1; f < frames.length; f++) p += `/${escapeStep(frames[f]!.key)}`;
    return key === undefined ? p : `${p}/${escapeStep(key)}`;
  };
  const report = (where: string, message: string): void => {
    if (out.length < maxProblems) out.push({ path: where, message });
  };
  // Into lone, not out: like the tools, which find it before anything else
  // can be checked, a lone surrogate is then the only problem reported.
  const surrogate = (where: () => string): void => {
    if (lone.length === 0) lone.push({ path: "", message: `has a string that is not well-formed Unicode (a lone surrogate), at ${where() || "(the whole file)"}` });
  };
  const enter = (c: object, key: string | number, d: number): void => {
    frames.push({ c, keys: Array.isArray(c) ? null : Object.keys(c), i: 0, key, depth: d });
  };
  // The value itself.
  if (typeof v === "number" && !Number.isFinite(v)) report(path, "is a number too large to hold");
  if (typeof v === "string" && loneSurrogate.test(v)) surrogate(() => path);
  if (typeof v !== "object" || v === null || v === skip) return;
  if (depth > maxDepth) return report(path, `nests more than ${maxDepth} deep`);
  enter(v, "", depth);
  while (frames.length > 0 && out.length < maxProblems) {
    const f = frames[frames.length - 1]!;
    const n = f.keys ? f.keys.length : (f.c as unknown[]).length;
    if (f.i >= n) {
      frames.pop();
      continue;
    }
    const key: string | number = f.keys ? f.keys[f.i]! : f.i;
    f.i++;
    if (typeof key === "string" && loneSurrogate.test(key)) surrogate(() => pathTo(key));
    const x: unknown = (f.c as Record<string | number, unknown>)[key];
    if (typeof x === "number") {
      if (!Number.isFinite(x)) report(pathTo(key), "is a number too large to hold");
    } else if (typeof x === "string") {
      if (loneSurrogate.test(x)) surrogate(() => pathTo(key));
    } else if (typeof x === "object" && x !== null && x !== skip) {
      if (f.depth + 1 > maxDepth) report(pathTo(key), `nests more than ${maxDepth} deep`);
      else enter(x, key, f.depth + 1);
    }
  }
}

const escapeStep = (key: string | number): string => (typeof key === "number" ? String(key) : escape(key));

/** A surrogate standing alone: in Unicode mode, a pair is one code point and does not match. */
const loneSurrogate = /\p{Cs}/u;

/**
 * Checks a parsed manifest against the format, returning its problems, in
 * order of place -- at most maxProblems of them; none means it is valid.
 * It never throws, whatever it is given.
 */
export function check(doc: unknown): Problem[] {
  return runToEnd(checking(doc));
}

/**
 * The checks, in steps of a slide: the document around its slides, then
 * the slides -- first for their shape (nesting, numbers), then against the
 * schema and the rules beyond it. Slides past the most a manifest may hold
 * are not looked at: the manifest is refused for their number already.
 * Checking stops once maxProblems are found; the verdict is settled.
 */
function* checking(doc: unknown): Generator<void, Problem[]> {
  const all = isObject(doc) && Array.isArray(doc["slides"]) ? (doc["slides"] as unknown[]) : null;
  const { top, slide, maxSlides } = rules();
  // More slides than a manifest may hold settle the verdict, alone and at
  // once, as in the tools (formats.ParseManifest): nothing else is looked
  // at, so the two report the one same place.
  if (all && all.length > maxSlides) return [{ path: "/slides", message: `must have at most ${maxSlides} items` }];
  const slides = all;
  const full = (problems: Problem[]): boolean => problems.length >= maxProblems;

  // Shape first: a value too deep or too large is all that is reported.
  const shape: Problem[] = [];
  const lone: Problem[] = [];
  checkJSON(doc, "", 1, shape, lone, all ?? undefined);
  for (let i = 0; slides && i < slides.length && !full(shape); i++) {
    checkJSON(slides[i], `/slides/${i}`, 3, shape, lone);
    yield;
  }
  if (lone.length > 0) return lone;
  if (shape.length > 0) return sortProblems(shape);

  const problems = top.validate(doc, false);
  const ids = new Map<string, number>();
  for (let i = 0; slides && i < slides.length && !full(problems); i++) {
    const s = slides[i];
    const path = `/slides/${i}`;
    slide.validate(s, false, path, problems);
    // Beyond the schema: ids are unique in the manifest, and the rules
    // for each slide alone.
    const id = (s as { id?: unknown } | null)?.id;
    if (typeof id === "string") {
      const first = ids.get(id);
      if (first !== undefined) problems.push({ path: `${path}/id`, message: `"${id}" is also the id of slide ${first}` });
      else ids.set(id, i);
    }
    checkSlideRules(s, path, problems);
    yield;
  }
  // In order of place, as the tools list them.
  return sortProblems(problems).slice(0, maxProblems);
}

/** Runs steps to their end, without pausing. */
function runToEnd<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Reads a manifest: parses the text, checks it, and resolves its URLs
 * against base (the URL it came from). Throws a ManifestError naming every
 * problem, or a SyntaxError for text that is not JSON; nothing else.
 */
export function parse(text: string, base: string): Manifest {
  return runToEnd(reading(parseJSON(text), base));
}

/**
 * The one way a manifest's text becomes a Manifest, in steps of about a
 * slide: parse() runs them straight through; load() lets the page draw and
 * answer input every few milliseconds of them. (JSON.parse itself is one
 * step, the size of the file: no engine offers it in parts.)
 */
function* reading(doc: unknown, base: string): Generator<void, Manifest> {
  const problems = yield* checking(doc);
  if (problems.length > 0) {
    throw new ManifestError(problems);
  }
  yield;
  return yield* building(doc, base);
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    // A parser may give up on a document too deep for it with something
    // other than a SyntaxError; to the caller it is all text that is not
    // a manifest.
    throw e instanceof SyntaxError ? e : new SyntaxError(String(e));
  }
}

/** A checked manifest, its URLs resolved against base and its slides converted, a slide at a time. */
function* building(doc: unknown, base: string): Generator<void, Manifest> {
  const m = doc as { title?: string; description?: string; lang?: string; slides: SlideInput[] };
  // Every URL becomes absolute, resolved against the manifest's, and must
  // then be http or https. One the URL parser refuses is a problem in the
  // manifest like any other, named by its place; all are gathered first.
  const unresolved: Problem[] = [];
  const resolve = (url: string, path: string): string => {
    const r = resolveHTTP(url, base);
    if (typeof r === "string") return r;
    unresolved.push({ path, message: r.problem });
    return url;
  };
  const slides: Keyed[] = [];
  for (const [i, s] of m.slides.entries()) {
    const out: SlideInput = {
      ...s,
      sources: s.sources.map((src, k) => ({ ...src, url: resolve(src.url, `/slides/${i}/sources/${k}/url`) })),
    };
    if (s.full) out.full = { ...s.full, url: resolve(s.full.url, `/slides/${i}/full/url`) };
    if (s.page) out.page = resolve(s.page, `/slides/${i}/page`);
    // Checked whole already, against the schema: converted, not checked again.
    slides.push(convert(out, m.lang ?? null));
    yield;
  }
  if (unresolved.length > 0) {
    throw new ManifestError(sortProblems(unresolved));
  }
  return {
    title: m.title ?? "",
    description: m.description ?? "",
    lang: m.lang ?? null,
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

/**
 * The most a manifest may weigh, here as in the tools (formats.MaxBytes):
 * 20,000 slides -- as many as a manifest may hold -- of about 1.6 KB each,
 * their sources and all their metadata.
 */
export const maxBytes = 32 * 1024 * 1024;

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
  // Into one buffer of the size the server declared; if it says nothing,
  // or turns out to have understated it, into pieces joined at the end.
  let buffer = declared > 0 ? new Uint8Array(declared) : null;
  let parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      await reader.cancel();
      throw new Error(`Clack: the manifest is larger than ${maxBytes} bytes`);
    }
    if (buffer && size + value.byteLength <= buffer.byteLength) {
      buffer.set(value, size);
    } else {
      if (buffer) {
        parts = [buffer.subarray(0, size)];
        buffer = null;
      }
      parts.push(value);
    }
    size += value.byteLength;
  }
  // Joined, decoded and parsed in one go, so the bytes and their text --
  // up to three times the manifest's size -- are let go before the long
  // check and build begin.
  const joined = (): Uint8Array => {
    if (buffer) return buffer.subarray(0, size);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    return bytes;
  };
  await yieldToPage();
  signal.throwIfAborted();
  const doc = parseJSON(decode(joined()));
  buffer = null;
  parts = [];
  // Then read as parse() reads any manifest -- one way in, which the tests
  // exercise too -- with the page given a turn every few milliseconds, and
  // a manifest dropped meanwhile not read on.
  const steps = reading(doc, response.url || url);
  let since = performance.now();
  for (;;) {
    signal.throwIfAborted();
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - since > 8) {
      await yieldToPage();
      since = performance.now();
    }
  }
}

/**
 * Lets the page draw and answer input -- and, in a page out of view, its
 * other work -- before going on. A message to itself rather than a timer:
 * browsers hold chained timers back to 4 ms or more each, and much longer
 * in a page out of view, but not messages.
 */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
