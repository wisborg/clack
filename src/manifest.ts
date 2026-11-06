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
import { checkJSON, decodeUTF8, fetchJSON, hasLoneSurrogate, isObject, loneSurrogateProblem, maxProblems, parseJSON, RefusedError, yieldToPage } from "./json";
import { checkSlideRules, rules } from "./rules";
import { describeProblems, sortProblems, type Problem } from "./schema";
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
export class ManifestError extends RefusedError {
  constructor(problems: Problem[]) {
    super("manifest", problems);
    this.name = "ManifestError";
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
function* checking(doc: unknown, loneInText = false): Generator<void, Problem[]> {
  const all = isObject(doc) && Array.isArray(doc["slides"]) ? (doc["slides"] as unknown[]) : null;
  const { top, slide, maxSlides } = rules();
  // More slides than a manifest may hold settle the verdict, alone and at
  // once, as in the tools (formats.ParseManifest): nothing else is looked
  // at, so the two report the one same place.
  if (all && all.length > maxSlides) return [{ path: "/slides", message: `must have at most ${maxSlides} items` }];
  // Then a lone surrogate, if the text had one (hasLoneSurrogate), alone.
  if (loneInText) return [loneSurrogateProblem];
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
  return runToEnd(reading(parseJSON(text), base, hasLoneSurrogate(text)));
}

/**
 * The one way a manifest's text becomes a Manifest, in steps of about a
 * slide: parse() runs them straight through; load() lets the page draw and
 * answer input every few milliseconds of them. (JSON.parse itself is one
 * step, the size of the file: no engine offers it in parts.)
 */
function* reading(doc: unknown, base: string, lone: boolean): Generator<void, Manifest> {
  const problems = yield* checking(doc, lone);
  if (problems.length > 0) {
    throw new ManifestError(problems);
  }
  yield;
  return yield* building(doc, base);
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
  const text = decodeUTF8(bytes);
  if (text === null) throw new ManifestError([{ path: "", message: "is not UTF-8" }]);
  return text;
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
  // Decoded and parsed in one go, and the bytes let go of before the long
  // check and build begin: with their text, up to three times the
  // manifest's size.
  let { bytes, url: at }: { bytes: Uint8Array | null; url: string } = await fetchJSON(url, signal, "manifest", maxBytes);
  await yieldToPage();
  signal.throwIfAborted();
  let text: string | null = decode(bytes!);
  bytes = null;
  const doc = parseJSON(text);
  const lone = hasLoneSurrogate(text);
  text = null;
  // Then read as parse() reads any manifest -- one way in, which the tests
  // exercise too -- with the page given a turn every few milliseconds, and
  // a manifest dropped meanwhile not read on.
  const steps = reading(doc, at, lone);
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
