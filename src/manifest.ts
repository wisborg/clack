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
import { checkSources, maxDepth, maxProblems, rules } from "./rules";
import { byCodePoint, describeProblems, escape, type Problem } from "./schema";
import { convert, type Keyed, type SlideInput } from "./slides";

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

export { maxDepth };

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with a parsed value before any schema is consulted: values
 * nested more than maxDepth deep, and numbers too large to be held
 * (JSON.parse makes them Infinity), added to out. v sits at path, depth
 * deep in its document; the contents of skip, if v holds it, are left for
 * a later call. Walks with a stack of its own, so no document can exhaust
 * the call stack, and stops once out holds maxProblems.
 */
function checkJSON(v: unknown, path: string, depth: number, out: Problem[], skip?: unknown): void {
  // Each value remembers its parent and its key; its path is spelt out
  // only for a value with a problem, not for each of a large manifest's
  // million values.
  interface Item {
    v: unknown;
    parent: Item | null;
    key: string;
    depth: number;
  }
  const pathOf = (it: Item): string => (it.parent ? `${pathOf(it.parent)}/${escape(it.key)}` : path);
  const stack: Item[] = [{ v, parent: null, key: "", depth }];
  while (stack.length > 0 && out.length < maxProblems) {
    const it = stack.pop()!;
    const x = it.v;
    if (typeof x === "number" && !Number.isFinite(x)) {
      out.push({ path: pathOf(it), message: "is a number too large to hold" });
    } else if (typeof x === "object" && x !== null) {
      if (it.depth > maxDepth) {
        out.push({ path: pathOf(it), message: `nests more than ${maxDepth} deep` });
        continue;
      }
      if (x === skip) continue;
      for (const key of Object.keys(x)) {
        stack.push({ v: (x as Obj)[key], parent: it, key, depth: it.depth + 1 });
      }
    }
  }
}

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
  const slides = all && all.length <= maxSlides ? all : null;
  const sorted = (problems: Problem[]): Problem[] => problems.sort((a, b) => byCodePoint(a.path, b.path));
  const full = (problems: Problem[]): boolean => problems.length >= maxProblems;

  // Shape first: a value too deep or too large is all that is reported.
  const shape: Problem[] = [];
  checkJSON(doc, "", 1, shape, all ?? undefined);
  for (let i = 0; slides && i < slides.length && !full(shape); i++) {
    checkJSON(slides[i], `/slides/${i}`, 3, shape);
    yield;
  }
  if (shape.length > 0) return sorted(shape);

  const problems = top.validate(doc, false);
  const ids = new Map<string, number>();
  for (let i = 0; slides && i < slides.length && !full(problems); i++) {
    const s = slides[i];
    const path = `/slides/${i}`;
    slide.validate(s, false, path, problems);
    // Beyond the schema: ids are unique in the manifest, and a slide
    // offers each width of each type once.
    const id = (s as { id?: unknown } | null)?.id;
    if (typeof id === "string") {
      const first = ids.get(id);
      if (first !== undefined) problems.push({ path: `${path}/id`, message: `"${id}" is also the id of slide ${first}` });
      else ids.set(id, i);
    }
    checkSources(s, path, problems);
    yield;
  }
  // In order of place, as the tools list them.
  return sorted(problems).slice(0, maxProblems);
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
  return runToEnd(reading(text, base));
}

/**
 * The one way a manifest's text becomes a Manifest, in steps of about a
 * slide: parse() runs them straight through; load() lets the page draw and
 * answer input every few milliseconds of them. (JSON.parse itself is one
 * step, the size of the file: no engine offers it in parts.)
 */
function* reading(text: string, base: string): Generator<void, Manifest> {
  const doc = parseJSON(text);
  yield;
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
    throw new ManifestError(unresolved.sort((a, b) => byCodePoint(a.path, b.path)));
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
  let bytes: Uint8Array;
  if (buffer) {
    bytes = buffer.subarray(0, size);
  } else {
    bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
  }
  // Decoded, then read as parse() reads any manifest -- one way in, which
  // the tests exercise too -- with the page free to draw and answer input
  // between the steps.
  const text = decode(bytes);
  await yieldToPage();
  const steps = reading(text, response.url || url);
  let since = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    // The page gets a turn every few milliseconds of work, not after
    // every step; and a manifest dropped meanwhile is not read on.
    if (performance.now() - since > 8) {
      await yieldToPage();
      signal.throwIfAborted();
      since = performance.now();
    }
  }
}

/**
 * Lets the page draw and answer input before going on -- unless it is
 * hidden, when nobody is waiting. A message to itself rather than a timer:
 * browsers hold chained timers back to 4 ms or more each, and much longer
 * in a page out of view.
 */
function yieldToPage(): Promise<void> {
  if (document.visibilityState === "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
