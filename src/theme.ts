/**
 * Themes: how a show looks, as a JSON file of typed tokens, format
 * clack-theme/1 (docs/themes.md, schema/theme-1.schema.json).
 *
 * A theme may come from anyone, so it is read as the tools read it
 * (tools/internal/formats.ParseTheme) and refused whole if anything is
 * wrong: comments removed, parsed, its shape checked, checked against the
 * published schema itself, resolved onto the built-in theme it extends, and
 * its colours held to WCAG's contrasts in every scheme it is shown in. Both
 * are held to the same cases (test/fixtures/themes.json).
 *
 * Nothing in a theme is CSS. Each token, checked, becomes one CSS custom
 * property on the show -- set through the CSS object model, one property
 * at a time, so no value can ever be read as more than a value -- or, for
 * a choice between layouts, a data attribute on the show's own frame.
 */
import themeSchema from "../schema/theme-1.schema.json";
import base from "../themes/base.json";
import contactSheet from "../themes/contact-sheet.json";
import darkroom from "../themes/darkroom.json";
import gallery from "../themes/gallery.json";
import mat from "../themes/mat.json";
import minimal from "../themes/minimal.json";
import { checkJSON, decodeUTF8, fetchJSON, hasLoneSurrogate, isObject, loneSurrogateProblem, maxProblems, parseJSON, RefusedError, type Obj } from "./json";
import { Schema, sortProblems, type Problem } from "./schema";

/** The built-in themes, by the name a page or a theme gives them. base is what every theme starts from. */
const builtins = new Map<string, Obj>([
  ["base", base],
  ["gallery", gallery],
  ["darkroom", darkroom],
  ["mat", mat],
  ["minimal", minimal],
  ["contact-sheet", contactSheet],
]);

/** The built-in themes' names. */
export const builtinNames: readonly string[] = [...builtins.keys()];

/** Whether name is a built-in theme's. */
export const isBuiltin = (name: string): boolean => builtins.has(name);

/**
 * The most a theme file may weigh, here as in the tools
 * (formats.MaxThemeBytes): base, which sets every token, is under 3 KB.
 */
export const maxThemeBytes = 64 * 1024;

/** A theme that was refused, with every problem found. */
export class ThemeError extends RefusedError {
  constructor(problems: Problem[]) {
    super("theme", problems);
    this.name = "ThemeError";
  }
}

/**
 * Text with its comments -- `// to the end of the line` and `/* between
 * markers *\/`, outside strings -- turned to spaces, newlines kept
 * (tools/internal/jsonc.Strip). A comment or a string that is never closed
 * is a SyntaxError, not something to guess about.
 */
export function stripComments(text: string): string {
  const parts: string[] = [];
  let from = 0;
  const blank = (to: number, at: number): void => {
    parts.push(text.slice(from, at), text.slice(at, to).replace(/[^\n\r]/g, " "));
    from = to;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; ; i++) {
        if (i >= text.length) throw new SyntaxError("a string is not closed");
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
    } else if (c === "/" && text[i + 1] === "/") {
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      blank(end, i);
      i = end - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new SyntaxError("a /* comment is not closed");
      blank(end + 2, i);
      i = end + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.join("");
}

let compiledSchema: Schema | undefined;

/**
 * Reads a theme file's bytes: no more than maxThemeBytes, strictly UTF-8,
 * and then as readTheme reads its text. Throws a ThemeError.
 */
export function readThemeBytes(bytes: Uint8Array): Obj {
  if (bytes.byteLength > maxThemeBytes) throw new ThemeError([{ path: "", message: `is larger than ${maxThemeBytes} bytes` }]);
  const text = decodeUTF8(bytes);
  if (text === null) throw new ThemeError([{ path: "", message: "is not UTF-8" }]);
  return readTheme(text);
}

/**
 * Reads a theme's text and returns it resolved onto what it extends --
 * every token set -- or throws a ThemeError with every problem, each by
 * its place. Each step is taken only if the one before it passed.
 */
export function readTheme(text: string): Obj {
  let doc: unknown;
  let stripped: string;
  try {
    stripped = stripComments(text);
    doc = parseJSON(stripped);
  } catch (e) {
    throw new ThemeError([{ path: "", message: `is not JSON: ${(e as Error).message}` }]);
  }
  // In the text, with its comments gone, as the tools look (formats.Parse).
  if (hasLoneSurrogate(stripped)) throw new ThemeError([loneSurrogateProblem]);
  // Nesting and numbers; lone surrogates are found in the text, above.
  const shape: Problem[] = [];
  checkJSON(doc, "", 1, shape);
  if (shape.length > 0) throw new ThemeError(sortProblems(shape));
  // The earliest maxProblems, by place, as for a manifest.
  const problems = (compiledSchema ??= new Schema(themeSchema)).validate(doc).slice(0, maxProblems);
  if (problems.length > 0) throw new ThemeError(problems);
  const resolved = resolve(doc as Obj);
  const contrast = checkContrast(resolved);
  if (contrast.length > 0) throw new ThemeError(sortProblems(contrast));
  return resolved;
}

/** A built-in theme, resolved: checked by the tools, so taken as it is. */
export function builtinTheme(name: string): Obj {
  const theme = builtins.get(name)!;
  return name === "base" ? merge({}, theme) : resolve(theme);
}

/** What belongs to one theme file, and is never inherited. */
const own = new Set(["$schema", "name", "description", "author", "extends"]);

/**
 * theme merged onto the theme it extends, itself merged the same way, down
 * to base (formats.Resolve): objects merge key by key, and any other value
 * replaces the one beneath it. A theme shown in one scheme only keeps only
 * that scheme's colours, and is refused if it sets the other's itself.
 * Only for a theme that has passed the schema, so every key is the
 * format's own but the theme's extensions (x-), which it keeps -- as the
 * tools do -- and inherits none of.
 */
function resolve(theme: Obj): Obj {
  const out = chain(theme, 0);
  const schemes = schemesOf(out);
  if (schemes.length === 1) {
    const shown = schemes[0]!;
    const colors = isObject(theme["colors"]) ? theme["colors"] : {};
    for (const scheme of Object.keys(colors)) {
      if (scheme !== shown) {
        throw new ThemeError([{ path: `/colors/${scheme}`, message: `this theme is shown only in ${shown}, so its ${scheme} colours would never be used` }]);
      }
    }
    out["colors"] = { [shown]: (out["colors"] as Obj)[shown] };
  }
  return out;
}

function chain(theme: Obj, depth: number): Obj {
  if (depth > builtins.size) throw new ThemeError([{ path: "/extends", message: "themes extend each other in a cycle" }]);
  const parentName = typeof theme["extends"] === "string" && theme["extends"] ? theme["extends"] : "base";
  const parent = builtins.get(parentName);
  if (!parent) throw new ThemeError([{ path: "/extends", message: `"${parentName}" is not a built-in theme` }]);
  const beneath = parentName === "base" ? parent : chain(parent, depth + 1);
  const inherited: Obj = {};
  for (const k of Object.keys(beneath)) {
    if (!own.has(k) && !k.startsWith("x-")) inherited[k] = beneath[k];
  }
  return merge(inherited, theme);
}

/**
 * over merged onto under, as a new value sharing nothing with either -- but
 * an extension's (x-) value, kept as it is: Clack never reads one, and it
 * may hold any key at all, "__proto__" among them, which a copy made by
 * assignment would turn into a prototype.
 */
function merge(under: Obj, over: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(under)) out[k] = clone(under[k]);
  for (const k of Object.keys(over)) {
    if (k.startsWith("x-")) {
      out[k] = over[k];
      continue;
    }
    const a = out[k];
    const b = over[k];
    out[k] = isObject(a) && isObject(b) ? merge(a, b) : clone(b);
  }
  return out;
}

const clone = (v: unknown): unknown => (isObject(v) ? merge({}, v) : Array.isArray(v) ? v.map(clone) : v);

/** The colour schemes a resolved theme is shown in. */
function schemesOf(resolved: Obj): ("light" | "dark")[] {
  const s = resolved["scheme"];
  return s === "light" ? ["light"] : s === "dark" ? ["dark"] : ["light", "dark"];
}

// ---- Contrast --------------------------------------------------------

/**
 * Pairs of roles and the least contrast WCAG 2.2 asks of them: 4.5:1 for
 * text (1.4.3), 3:1 for controls and the focus ring (1.4.11).
 */
const contrastRules: [string, string, number][] = [
  ["text", "canvas", 4.5],
  ["text", "surface", 4.5],
  ["muted", "canvas", 4.5],
  ["muted", "surface", 4.5],
  ["accent", "canvas", 3],
  ["control", "canvas", 3],
  ["controlActive", "canvas", 3],
  ["labelText", "label", 4.5],
  ["labelMuted", "label", 4.5],
  ["edgePrint", "film", 4.5],
];

/** The roles other colours are measured against, which must be opaque for the measure to mean anything. */
const opaque = ["canvas", "surface", "label", "film"];

/**
 * Every colour in a resolved theme that falls short of the contrast it
 * needs, in each scheme it is shown in (formats.CheckContrast), at its
 * place in the theme as resolved.
 */
function checkContrast(resolved: Obj): Problem[] {
  const out: Problem[] = [];
  const colors = resolved["colors"] as Record<string, Record<string, string>>;
  for (const scheme of schemesOf(resolved)) {
    const palette = colors[scheme] ?? {};
    const at = (role: string): string => `/colors/${scheme}/${role}`;
    const bad = new Set<string>();
    const get = (role: string): RGBA | null => {
      const c = Object.hasOwn(palette, role) ? parseColor(palette[role]!) : null;
      if (!c && !bad.has(role)) {
        bad.add(role);
        out.push({ path: at(role), message: Object.hasOwn(palette, role) ? "is not a colour" : "is not set" });
      }
      return c;
    };
    for (const role of opaque) {
      const c = get(role);
      if (c && c[3] !== 1) out.push({ path: at(role), message: "must be opaque" });
    }
    for (const [fg, bg, min] of contrastRules) {
      const f = get(fg);
      const b = get(bg);
      if (!f || !b) continue;
      const c = contrast(f, b);
      if (c < min) out.push({ path: at(fg), message: `on ${bg} is ${c.toFixed(2)}:1, needs ${min.toFixed(1)}:1` });
    }
  }
  return out;
}

/** A colour in sRGB: red, green, blue and alpha, each from 0 to 1. */
type RGBA = [number, number, number, number];

/** The colour forms the theme schema allows (formats.ParseColor), or null. */
export function parseColor(s: string): RGBA | null {
  let m = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), n(6)];
  }
  m = /^rgb\( ?([0-9]{1,3}) ([0-9]{1,3}) ([0-9]{1,3})(?: \/ ([0-9.]+%?))? ?\)$/.exec(s);
  if (!m) return null;
  const ch = [m[1], m[2], m[3]].map(Number);
  if (ch.some((n) => n > 255)) return null;
  let a = 1;
  if (m[4] !== undefined) {
    const pct = m[4].endsWith("%");
    a = Number(pct ? m[4].slice(0, -1) : m[4]);
    if (Number.isNaN(a)) return null;
    if (pct) a /= 100;
    if (a < 0 || a > 1) return null;
  }
  return [ch[0]! / 255, ch[1]! / 255, ch[2]! / 255, a];
}

/** The relative luminance WCAG defines, of an opaque colour. */
function luminance([r, g, b]: RGBA): number {
  const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG's contrast ratio of fg, composited over bg, against bg, which must be opaque. */
export function contrast(fg: RGBA, bg: RGBA): number {
  const mix = (f: number, b: number): number => f * fg[3] + b * (1 - fg[3]);
  const over: RGBA = [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2]), 1];
  let a = luminance(over);
  let b = luminance(bg);
  if (a < b) [a, b] = [b, a];
  return (a + 0.05) / (b + 0.05);
}

// ---- Compiling -------------------------------------------------------

/** A theme as CSS: custom properties for :host, and the layout's choices as data attributes for the show's frame. */
export interface Compiled {
  properties: [string, string][];
  choices: Record<string, string>;
}

/** The visitor's own fonts, by family: the only fonts there are, for now. */
const systemFonts: Record<string, string> = {
  serif: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

/** The soft shadow under a photo, tuned for each scheme. */
const softShadow =
  "0 1px 2px light-dark(rgb(0 0 0 / 0.06), rgb(0 0 0 / 0.5)), 0 14px 36px light-dark(rgb(0 0 0 / 0.14), rgb(0 0 0 / 0.55))";

/** camelCase as kebab-case: controlActive, control-active. */
const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * A resolved theme as CSS, every token named after its place
 * (docs/themes.md): colors.*.canvas is --clack-canvas, caption.size is
 * --clack-caption-size, and so on. Every value has passed the schema, so
 * each is already one CSS value of its kind.
 */
export function compile(t: Obj): Compiled {
  const p: [string, string][] = [];
  const set = (name: string, value: unknown): void => {
    p.push([`--clack-${name}`, String(value)]);
  };
  // A length or duration of 0, which the schema allows without a unit, is
  // given one: inside clamp() or max(), as Clack's styles use them, a bare
  // 0 is a number, not a length, and makes the whole declaration invalid.
  const one = (v: unknown, unit: string): string => (v === "0" ? `0${unit}` : String(v));
  const length = (v: unknown): string => (isObject(v) ? `clamp(${one(v["min"], "px")}, ${one(v["ideal"], "px")}, ${one(v["max"], "px")})` : one(v, "px"));
  const get = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (isObject(o) ? o[k] : undefined), t);

  const schemes = schemesOf(t);
  p.push(["color-scheme", schemes.join(" ")]);
  const colors = t["colors"] as Record<string, Record<string, string>>;
  for (const role of Object.keys(colors[schemes[0]!]!)) {
    const [light, dark] = schemes.map((s) => colors[s]![role]!);
    set(kebab(role), dark === undefined ? light : `light-dark(${light}, ${dark})`);
  }

  for (const family of ["serif", "sans", "mono"]) set(family, systemFonts[family]);
  for (const side of ["inline", "top", "bottom"]) set(`padding-${side}`, length(get(`layout.padding.${side}`)));
  set("shadow", get("layout.shadow") === "soft" ? softShadow : "none");
  set("mat-width", length(get("layout.mat.width")));
  set("frame-width", length(get("layout.frame.width")));
  for (const part of ["caption", "header"]) {
    set(`${part}-font`, `var(--clack-${String(get(`${part}.font`))})`);
    for (const token of ["size", "weight", "style", "case"]) set(`${part}-${token}`, get(`${part}.${token}`));
    set(`${part}-tracking`, one(get(`${part}.tracking`), "em"));
  }
  set("caption-credit", get("caption.credit") ? "block" : "none");
  set("control-size", length(get("controls.size")));
  set("transition", get("transition.type"));
  set("transition-duration", one(get("transition.duration"), "s"));
  set("index-row-height", length(get("index.rowHeight")));
  set("index-frame-width", length(get("index.frameWidth")));
  set("index-gap", length(get("index.gap")));

  const choices: Record<string, string> = {
    layout: String(get("layout.type")),
    bevel: String(get("layout.mat.bevel")),
    card: String(get("caption.card")),
    header: String(get("header.visible")),
    controls: String(get("controls.style")),
    reveal: String(get("controls.reveal")),
    progress: String(get("progress.position")),
    details: String(get("details.position")),
    index: String(get("index.style")),
  };
  return { properties: p, choices };
}

/**
 * Fetches the theme at url and reads it, resolved; throws a ThemeError for
 * a theme that is refused, or an Error for one that could not be had.
 */
export async function loadTheme(url: string, signal: AbortSignal): Promise<Obj> {
  const { bytes } = await fetchJSON(url, signal, "theme", maxThemeBytes);
  signal.throwIfAborted();
  return readThemeBytes(bytes);
}
