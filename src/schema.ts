/**
 * A validator for the part of JSON Schema (draft 2020-12) that Clack's own
 * schemas use: the same subset as the tools' Go validator
 * (tools/internal/jsonschema), with the same rules for where an error is
 * reported, so the two reach the same verdicts on the same files. Clack
 * carries the published schemas themselves, stripped of their annotations
 * at build time, and checks themes and manifests against them.
 *
 * The schemas are Clack's own and trusted; the documents are not. Nothing a
 * document holds can reach a prototype: object keys are looked up in maps
 * built from the schema, never on plain objects.
 */

/** One way a document fails its schema: where (a JSON Pointer) and why. */
export interface Problem {
  path: string;
  message: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Node {
  always?: boolean;
  types?: string[];
  hasConst?: boolean;
  constVal?: Json;
  enum?: Json[];
  properties?: Map<string, Node>;
  patternProperties?: [RegExp, Node][];
  additional?: Node;
  required?: string[];
  dependentRequired?: Map<string, string[]>;
  propertyNames?: Node;
  minProps?: number;
  maxProps?: number;
  items?: Node;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  allOf?: Node[];
  anyOf?: Node[];
  oneOf?: Node[];
  not?: Node;
  if?: Node;
  then?: Node;
  else?: Node;
  ref?: Node;
}

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** A compiled schema. */
export class Schema {
  readonly #root: Node;

  /** Compiles a schema as the build ships it (see tools/internal/bundle). */
  constructor(schema: unknown) {
    const root = schema as Record<string, Json>;
    const defs = new Map<string, Node>();
    const rawDefs = (root["$defs"] ?? {}) as Record<string, Json>;
    for (const name of Object.keys(rawDefs)) defs.set(name, {});
    const compile = (v: Json, into: Node = {}): Node => {
      if (typeof v === "boolean") {
        into.always = v;
        return into;
      }
      const m = v as Record<string, Json>;
      const sub = (k: string): Node | undefined => (own(m, k) ? compile(m[k]!) : undefined);
      const num = (k: string): number | undefined => (own(m, k) ? (m[k] as number) : undefined);
      const set = <K extends keyof Node>(k: K, value: Node[K] | undefined): void => {
        if (value !== undefined) into[k] = value;
      };
      if (own(m, "type")) into.types = typeof m["type"] === "string" ? [m["type"]] : (m["type"] as string[]);
      if (own(m, "const")) {
        into.hasConst = true;
        into.constVal = m["const"]!;
      }
      set("enum", m["enum"] as Json[] | undefined);
      if (own(m, "properties")) {
        const p = m["properties"] as Record<string, Json>;
        into.properties = new Map(Object.keys(p).map((k) => [k, compile(p[k]!)]));
      }
      if (own(m, "patternProperties")) {
        const p = m["patternProperties"] as Record<string, Json>;
        into.patternProperties = Object.keys(p).map((k) => [new RegExp(k, "u"), compile(p[k]!)]);
      }
      set("additional", sub("additionalProperties"));
      set("required", m["required"] as string[] | undefined);
      if (own(m, "dependentRequired")) {
        const d = m["dependentRequired"] as Record<string, string[]>;
        into.dependentRequired = new Map(Object.keys(d).map((k) => [k, d[k]!]));
      }
      set("propertyNames", sub("propertyNames"));
      set("minProps", num("minProperties"));
      set("maxProps", num("maxProperties"));
      set("items", sub("items"));
      set("minItems", num("minItems"));
      set("maxItems", num("maxItems"));
      set("minLength", num("minLength"));
      set("maxLength", num("maxLength"));
      if (own(m, "pattern")) into.pattern = new RegExp(m["pattern"] as string, "u");
      for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) set(k, num(k));
      for (const k of ["allOf", "anyOf", "oneOf"] as const) {
        if (own(m, k)) into[k] = (m[k] as Json[]).map((s) => compile(s));
      }
      set("not", sub("not"));
      set("if", sub("if"));
      set("then", sub("then"));
      set("else", sub("else"));
      if (own(m, "$ref")) {
        const target = defs.get((m["$ref"] as string).replace("#/$defs/", ""));
        if (!target) throw new Error(`Clack: a schema refers to ${String(m["$ref"])}, which it does not define`);
        into.ref = target;
      }
      return into;
    };
    for (const [name, node] of defs) compile(rawDefs[name]!, node);
    this.#root = compile(root as Json);
  }

  /** Every way doc fails the schema, sorted by place; none means it is valid. Never throws. */
  validate(doc: unknown): Problem[] {
    const out: Problem[] = [];
    validate(this.#root, doc as Json, "", out);
    return out.sort((a, b) => byCodePoint(a.path, b.path));
  }
}

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  switch (typeof v) {
    case "boolean":
      return "a boolean";
    case "number":
      return "a number";
    case "string":
      return "a string";
  }
  return "an object";
}

function isType(v: Json, t: string): boolean {
  switch (t) {
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
  }
  return false;
}

function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]!));
  }
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => own(b, k) && equal(a[k]!, b[k]!));
}

const show = (v: Json): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = typeof v;
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * Orders strings by code point, which is the order of their UTF-8 bytes --
 * as Go sorts them -- not of their UTF-16 units, as < does.
 */
export function byCodePoint(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const d = p.value.codePointAt(0)! - q.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/** Whether v is something JSON can hold: what a parser gives, and nothing else. */
function isJson(v: unknown): v is Json {
  switch (typeof v) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(v);
    case "object":
      return v === null || Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
  }
  return false;
}

/** Characters, as JSON Schema counts them: code points, not UTF-16 units. */
function chars(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const escape = (k: string): string => k.replaceAll("~", "~0").replaceAll("/", "~1");

function check(n: Node, v: Json, path: string): Problem[] {
  const out: Problem[] = [];
  validate(n, v, path, out);
  return out;
}

/**
 * The errors of the nearest failed alternative, as the Go validator chooses:
 * one that failed only inside the value is nearer than one that failed on the
 * value itself, and among those the one with fewest errors; if every one
 * failed on the value itself, a summary.
 */
function closest(failures: Problem[][], path: string): Problem[] {
  let best: Problem[] | null = null;
  for (const f of failures) {
    if (!f.some((p) => p.path === path) && (best === null || f.length < best.length)) best = f;
  }
  return best ?? [{ path, message: "matches none of the allowed forms" }];
}

function validate(n: Node, v: Json, path: string, out: Problem[]): void {
  const add = (message: string, at = path): void => {
    out.push({ path: at, message });
  };
  if (!isJson(v)) {
    // Given from script rather than parsed: undefined, a function, a
    // BigInt, a class instance. Never valid, and never looked into.
    add("is not a JSON value");
    return;
  }
  if (n.always !== undefined) {
    if (!n.always) add("is not allowed here");
    return;
  }
  if (n.ref) validate(n.ref, v, path, out);
  if (n.types && !n.types.some((t) => isType(v, t))) {
    add(`must be ${n.types.join(" or ")}, not ${typeOf(v)}`);
    return;
  }
  if (n.hasConst && !equal(v, n.constVal!)) add(`must be ${show(n.constVal!)}`);
  if (n.enum && !n.enum.some((e) => equal(v, e))) add(`must be one of ${n.enum.map(show).join(", ")}, not ${show(v)}`);

  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    for (const r of n.required ?? []) if (!own(v, r)) add(`"${r}" is required`);
    const keys = Object.keys(v).sort(byCodePoint);
    for (const k of keys) {
      for (const r of n.dependentRequired?.get(k) ?? []) if (!own(v, r)) add(`"${r}" is required with "${k}"`);
    }
    if (n.minProps !== undefined && keys.length < n.minProps) add(`must have at least ${n.minProps} properties`);
    if (n.maxProps !== undefined && keys.length > n.maxProps) add(`must have at most ${n.maxProps} properties`);
    for (const k of keys) {
      const at = `${path}/${escape(k)}`;
      if (n.propertyNames) for (const p of check(n.propertyNames, k, at)) add(`property name ${p.message}`, at);
      let matched = false;
      const p = n.properties?.get(k);
      if (p) {
        validate(p, v[k]!, at, out);
        matched = true;
      }
      for (const [re, pn] of n.patternProperties ?? []) {
        if (re.test(k)) {
          validate(pn, v[k]!, at, out);
          matched = true;
        }
      }
      if (!matched && n.additional) {
        if (n.additional.always === false) add("is not a property this object has", at);
        else validate(n.additional, v[k]!, at, out);
      }
    }
  } else if (Array.isArray(v)) {
    if (n.minItems !== undefined && v.length < n.minItems) add(`must have at least ${n.minItems} items`);
    if (n.maxItems !== undefined && v.length > n.maxItems) add(`must have at most ${n.maxItems} items`);
    if (n.items) v.forEach((item, i) => validate(n.items!, item, `${path}/${i}`, out));
  } else if (typeof v === "string") {
    // Characters are code points, one or two UTF-16 units each, so a
    // string's length in units bounds its count both ways: they are only
    // counted when that cannot settle it.
    const atLeast = (k: number): boolean => v.length >= 2 * k || (v.length >= k && chars(v) >= k);
    const tooLong = n.maxLength !== undefined && atLeast(n.maxLength + 1);
    if (n.minLength !== undefined && !atLeast(n.minLength)) add(`must be at least ${n.minLength} characters`);
    if (tooLong) add(`must be at most ${n.maxLength} characters`);
    // A string already too long is not also matched: the patterns are
    // written to match in linear time, and this bounds the work besides.
    if (n.pattern && !tooLong && !n.pattern.test(v)) add(`${show(v)} does not have the expected form`);
  } else if (typeof v === "number") {
    if (n.minimum !== undefined && v < n.minimum) add(`must be at least ${n.minimum}`);
    if (n.maximum !== undefined && v > n.maximum) add(`must be at most ${n.maximum}`);
    if (n.exclusiveMinimum !== undefined && v <= n.exclusiveMinimum) add(`must be more than ${n.exclusiveMinimum}`);
    if (n.exclusiveMaximum !== undefined && v >= n.exclusiveMaximum) add(`must be less than ${n.exclusiveMaximum}`);
  }

  for (const s of n.allOf ?? []) validate(s, v, path, out);
  for (const [list, one] of [[n.anyOf, false], [n.oneOf, true]] as const) {
    if (!list) continue;
    const failures: Problem[][] = [];
    let matches = 0;
    for (const s of list) {
      const e = check(s, v, path);
      if (e.length === 0) {
        matches++;
        if (!one) break;
      } else {
        failures.push(e);
      }
    }
    if (matches === 0) out.push(...closest(failures, path));
    else if (one && matches > 1) add("matches more than one of the allowed forms");
  }
  if (n.not && check(n.not, v, path).length === 0) add("has a form that is not allowed here");
  if (n.if) {
    if (check(n.if, v, path).length === 0) {
      if (n.then) validate(n.then, v, path, out);
    } else if (n.else) {
      validate(n.else, v, path, out);
    }
  }
}
