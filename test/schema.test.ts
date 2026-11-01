// The browser's JSON Schema validator (src/schema.ts) against what the Go
// one (tools/internal/jsonschema) is tested with: the same rules, the same
// places for errors.
import { Schema } from "../src/schema";
import themeSchema from "../schema/theme-1.schema.json";
import base from "../themes/base.json";
import contactSheet from "../themes/contact-sheet.json";
import darkroom from "../themes/darkroom.json";
import gallery from "../themes/gallery.json";
import mat from "../themes/mat.json";
import minimal from "../themes/minimal.json";
import { assert, assertEqual, test } from "./harness";

const where = (s: Schema, doc: unknown): string =>
  s
    .validate(doc)
    .map((p) => `${p.path}: ${p.message}`)
    .join("; ");

test("the built-in themes are valid themes", () => {
  const s = new Schema(themeSchema);
  for (const [name, theme] of Object.entries({ base, gallery, darkroom, mat, minimal, contactSheet })) {
    assertEqual(where(s, theme), "", name);
  }
});

test("themes are refused for what the Go checks refuse them for", () => {
  const s = new Schema(themeSchema);
  const theme = (extra: Record<string, unknown>): unknown => ({ format: "clack-theme/1", name: "T", ...extra });
  const cases: [string, Record<string, unknown>, string][] = [
    ["a url() colour", { colors: { light: { canvas: "url(https://example.com/x.png)" } } }, "/colors/light/canvas"],
    ["var() in a colour", { colors: { light: { canvas: "var(--x)" } } }, "/colors/light/canvas"],
    ["CSS smuggled in", { css: "body { display: none }" }, "/css"],
    ["extends a URL", { extends: "https://example.com/theme.json" }, "/extends"],
    ["a font to fetch", { fonts: { serif: "https://fonts.example.com/x.woff2" } }, "/fonts/serif"],
    ["a calc() length", { index: { gap: "calc(100vw - 1px)" } }, "/index/gap"],
    ["an incomplete clamp", { index: { rowHeight: { min: "1px" } } }, "/index/rowHeight"],
    ["a zero font size", { caption: { size: "0rem" } }, "/caption/size"],
    ["a forced scheme's other colours", { scheme: "dark", colors: { light: {} } }, "/colors"],
    ["the next format", { format: "clack-theme/2" }, "/format"],
  ];
  for (const [name, extra, path] of cases) {
    const problems = s.validate(theme(extra));
    assert(problems.length > 0, `${name}: accepted`);
    for (const p of problems) assertEqual(p.path, path, `${name}: ${p.message}`);
  }
  assertEqual(where(s, theme({ "x-site": { any: ["thing"] } })), "", "an extension");
});

test("of several forms, the error reported is the nearest one's", () => {
  const s = new Schema({
    oneOf: [{ type: "string" }, { type: "object", properties: { min: { type: "string" } } }],
  });
  assertEqual(where(s, { min: 1 }), "/min: must be string, not a number", "the object form, nearly right");
  assertEqual(where(s, 7), ": matches none of the allowed forms", "no form near");
  const both = new Schema({ oneOf: [{ type: "integer" }, { type: "number" }] });
  assertEqual(where(both, 1), ": matches more than one of the allowed forms", "two forms at once");
});

test("the validator keeps a document's keys away from prototypes", () => {
  const s = new Schema({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false });
  const doc = JSON.parse('{"__proto__": {"a": 1}, "constructor": 1, "toString": 2}') as unknown;
  const paths = s.validate(doc).map((p) => p.path).join(" ");
  assertEqual(paths, "/__proto__ /constructor /toString", "each is just an unknown key");
  assertEqual(({} as { a?: unknown }).a, undefined, "and nothing reached Object.prototype");
});
