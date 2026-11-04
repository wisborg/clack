/**
 * The rules a manifest's slides follow, wherever the slides come from: the
 * published manifest schema (schema/manifest-1.schema.json), as the build
 * ships it -- its rules without its explanations -- compiled two ways, the
 * document around its slides and one slide; and the rules beyond the schema
 * that concern a single slide. A large manifest is checked a slide at a
 * time, with the page free in between, and slides given from script are
 * held to exactly the same rules as a manifest's.
 */
import manifestSchema from "../schema/manifest-1.schema.json";
import { Schema, type Problem } from "./schema";
import { parse } from "./thumbhash";

/**
 * How deeply a manifest's values may nest -- far beyond any real manifest,
 * whose slides go five deep. The tools apply the same limit
 * (formats.CheckJSON), so the two agree on every file.
 */
export const maxDepth = 64;

/**
 * The most problems collected from one manifest. Its verdict is settled by
 * the first; a list of millions would only use up memory, and the console
 * could not show it anyway.
 */
export const maxProblems = 1000;

let compiled: { top: Schema; slide: Schema; maxSlides: number } | undefined;

/** The manifest without its slides' contents (their number is still checked), and a slide. */
export function rules(): { top: Schema; slide: Schema; maxSlides: number } {
  if (!compiled) {
    // The top: the published schema with the slides' items left out --
    // and every other rule for the slides kept, whatever is added to them
    // -- by shallow copies of the parts on the way.
    const { items: _items, ...slides } = manifestSchema.properties.slides;
    const top = { ...manifestSchema, properties: { ...manifestSchema.properties, slides } };
    compiled = {
      top: new Schema(top),
      slide: new Schema({ $defs: manifestSchema.$defs, $ref: "#/$defs/slide" }),
      maxSlides: slides.maxItems,
    };
  }
  return compiled;
}

/**
 * The rules beyond the schema for one slide (tools/internal/formats
 * .CheckManifest): it offers each width of each type once, and its
 * thumbhash, if it has one, is one. Only what the schema accepts is
 * considered, and the rest left to the schema's own errors, so that each
 * problem is reported once, in the same place by the tools and the browser.
 */
export function checkSlideRules(slide: unknown, path: string, out: Problem[]): void {
  checkSources(slide, path, out);
  const hash = (slide as { placeholder?: { thumbhash?: unknown } | null } | null)?.placeholder?.thumbhash;
  thumbhashPattern ??= new RegExp(manifestSchema.$defs.slide.properties.placeholder.properties.thumbhash.pattern);
  if (typeof hash === "string" && thumbhashPattern.test(hash) && !parse(hash)) {
    out.push({ path: `${path}/placeholder/thumbhash`, message: "is not a ThumbHash" });
  }
}

let thumbhashPattern: RegExp | undefined;

/**
 * Each width of each type once: considering only a width that is a whole
 * number from 1 to 100,000 and a type that is absent or a string, so the
 * tools and the browser report the same places whatever the values (Go and
 * JavaScript spell -0 or 1e20 differently).
 */
function checkSources(slide: unknown, path: string, out: Problem[]): void {
  const sources = (slide as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources)) return;
  const seen = new Set<string>();
  for (let k = 0; k < sources.length; k++) {
    const o = sources[k] as { width?: unknown; type?: unknown } | null;
    const w = o?.width;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 100000) continue;
    if (o!.type !== undefined && typeof o!.type !== "string") continue;
    const key = `${w} ${o!.type ?? ""}`;
    if (seen.has(key)) out.push({ path: `${path}/sources/${k}`, message: "another source has the same width and type" });
    seen.add(key);
  }
}
