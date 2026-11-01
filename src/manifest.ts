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
import { Schema, type Problem } from "./schema";
import { fromInput, usableURL, type Keyed, type SlideInput } from "./slides";

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
 * Checks a parsed manifest against the format, returning every problem; none
 * means it is valid. It never throws, whatever it is given.
 */
export function check(doc: unknown): Problem[] {
  compiled ??= new Schema(manifestSchema);
  const problems = compiled.validate(doc);
  // Beyond the schema: ids are unique, and a slide offers each size of each
  // type once (tools/internal/formats.CheckManifest).
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
          if (typeof o?.width !== "number") return;
          const key = `${o.width} ${typeof o.type === "string" ? o.type : ""}`;
          if (seen.has(key)) problems.push({ path: `/slides/${i}/sources/${k}`, message: "another source has the same width and type" });
          seen.add(key);
        });
      }
    });
  }
  return problems;
}

/**
 * Reads a manifest: parses the text, checks it, and resolves its URLs
 * against base (the URL it came from). Throws a ManifestError naming every
 * problem, or a SyntaxError for text that is not JSON.
 */
export function parse(text: string, base: string): Manifest {
  const doc = JSON.parse(text) as unknown;
  const problems = check(doc);
  if (problems.length > 0) {
    throw new ManifestError(problems);
  }
  const m = doc as { title?: string; description?: string; lang?: string; slides: SlideInput[] };
  // Every URL becomes absolute, resolved against the manifest's, and is
  // checked once more as it will be used: http or https, nothing else.
  const resolve = (url: string, path: string): string => {
    const abs = new URL(url, base).href;
    if (!usableURL(abs)) {
      throw new ManifestError([{ path, message: "does not resolve to an http or https URL" }]);
    }
    return abs;
  };
  const slides = m.slides.map((s, i): SlideInput => {
    const out: SlideInput = {
      ...s,
      sources: s.sources.map((src, k) => ({ ...src, url: resolve(src.url, `/slides/${i}/sources/${k}/url`) })),
    };
    if (s.full) out.full = { ...s.full, url: resolve(s.full.url, `/slides/${i}/full/url`) };
    if (s.page) out.page = resolve(s.page, `/slides/${i}/page`);
    return out;
  });
  return {
    title: m.title ?? "",
    description: m.description ?? "",
    lang: m.lang ?? "",
    slides: fromInput(slides),
  };
}

/** The most a manifest may weigh: 20,000 slides with all their metadata fit with room to spare. */
export const maxBytes = 16 * 1024 * 1024;

/**
 * Fetches and reads the manifest at url. Only JSON is accepted (by its
 * Content-Type), and no more than maxBytes of it; the request carries
 * cookies to the page's own origin only, and can be cancelled with signal.
 */
export async function load(url: string, signal: AbortSignal): Promise<Manifest> {
  const response = await fetch(url, { credentials: "same-origin", signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Clack: the manifest could not be fetched: ${response.status} ${response.statusText}`.trim());
  }
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new Error(`Clack: the manifest must be served as application/json, not ${type || "nothing"}`);
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    throw new Error(`Clack: the manifest is larger than ${maxBytes} bytes`);
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
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return parse(text, response.url || url);
}
