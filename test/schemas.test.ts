// The schemas' patterns are read by Go's regexp (RE2) in the tools, and by
// JavaScript in editors and, later, in Clack's own loader. These tests hold
// every pattern to the same strings in every engine as the Go tests do
// (tools/internal/formats), from one fixture, so the two cannot drift apart.
import manifestSchema from "../schema/manifest-1.schema.json";
import themeSchema from "../schema/theme-1.schema.json";
import fixture from "./fixtures/patterns.json";
import { assert, test } from "./harness";

const schemas: Record<string, unknown> = {
  "theme-1.schema.json": themeSchema,
  "manifest-1.schema.json": manifestSchema,
};

interface Cases {
  match: string[];
  nomatch: string[];
}

const escape = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = (part: string): string => part.replaceAll("~1", "/").replaceAll("~0", "~");

// at follows a JSON Pointer into a schema.
function at(doc: unknown, pointer: string): unknown {
  let cur = doc;
  for (const part of pointer.split("/").slice(1)) {
    const key = unescape(part);
    assert(typeof cur === "object" && cur !== null && key in cur, `no ${pointer}`);
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// JSON Schema patterns are ECMAScript regular expressions in Unicode mode,
// unanchored: the schemas anchor their own.
function compile(source: string): RegExp {
  return new RegExp(source, "u");
}

// Every pattern in a schema: each pattern keyword, by the pointer of the
// schema holding it, and each key of patternProperties, by its own pointer.
// The Go tests find the same set (patternsIn in tools/internal/formats).
function patterns(doc: unknown, pointer = ""): Map<string, string> {
  const found = new Map<string, string>();
  if (typeof doc !== "object" || doc === null) {
    return found;
  }
  for (const [key, value] of Object.entries(doc)) {
    const here = `${pointer}/${escape(key)}`;
    if (key === "pattern" && typeof value === "string") {
      found.set(pointer, value);
    } else if (key === "patternProperties" && typeof value === "object" && value !== null) {
      for (const source of Object.keys(value)) {
        found.set(`${here}/${escape(source)}`, source);
      }
    }
    for (const [k, v] of patterns(value, here)) {
      found.set(k, v);
    }
  }
  return found;
}

test("every schema pattern compiles as JavaScript", () => {
  for (const [file, schema] of Object.entries(schemas)) {
    for (const [pointer, source] of patterns(schema)) {
      try {
        compile(source);
      } catch (e) {
        throw new Error(`${file}#${pointer}: ${String(e)}`);
      }
    }
  }
});

test("patterns accept and refuse what Go's do", () => {
  const failures: string[] = [];
  const covered = new Set<string>();
  for (const [key, value] of Object.entries(fixture)) {
    if (key.startsWith("$")) {
      continue;
    }
    const [file = "", pointer = ""] = key.split("#");
    const source = patterns(schemas[file]).get(pointer);
    assert(source !== undefined, `${key}: no pattern there`);
    at(schemas[file], pointer); // and the pointer leads somewhere
    covered.add(key);
    const re = compile(source);
    const cases = value as Cases;
    for (const s of cases.match) {
      if (!re.test(s)) failures.push(`${key}: refused ${JSON.stringify(s)}`);
    }
    for (const s of cases.nomatch) {
      if (re.test(s)) failures.push(`${key}: accepted ${JSON.stringify(s)}`);
    }
  }
  for (const [file, schema] of Object.entries(schemas)) {
    for (const pointer of patterns(schema).keys()) {
      if (!covered.has(`${file}#${pointer}`)) failures.push(`${file}#${pointer}: no cases in the fixture`);
    }
  }
  assert(failures.length === 0, failures.join("\n"));
});
