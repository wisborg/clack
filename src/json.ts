/**
 * What the manifest and theme loaders share: fetching a JSON file with a
 * limit on its size, reading its bytes strictly as UTF-8, parsing it, and
 * checking its shape -- nesting, numbers, Unicode -- before any schema is
 * consulted, as the tools do (tools/internal/formats).
 */
import { describeProblems, escape, type Problem } from "./schema";

/**
 * How deeply a manifest's or a theme's values may nest -- far beyond any
 * real one: a manifest's slides go five deep, a theme four. The tools
 * apply the same limit (formats.MaxDepth), so the two agree on every file.
 */
export const maxDepth = 64;

/**
 * The most problems collected from one manifest or theme. Its verdict is
 * settled by the first; a list of millions would only use up memory, and
 * the console could not show it anyway. The tools have no such limit, so
 * past it the two may name different places (the browser keeps the
 * earliest it found); below it, they name the same.
 */
export const maxProblems = 1000;

/**
 * A file -- a manifest or a theme -- that was refused, with every problem
 * found (up to maxProblems): the first five in its message.
 */
export class RefusedError extends Error {
  readonly problems: Problem[];

  constructor(what: string, problems: Problem[]) {
    const shown = describeProblems(problems.slice(0, 5)).map((l) => l.trim());
    if (problems.length > 5) shown.push(`and ${problems.length - 5} more`);
    super(`Clack: the ${what} was refused: ${shown.join("; ")}`);
    this.problems = problems;
  }
}

/**
 * What the console is told of a file that could not be used: refused, with
 * every problem by its place (saying so if checking stopped at
 * maxProblems), or not had at all, and why. then says what the show does
 * about it.
 */
export function reportFailure(what: string, url: string, e: unknown, then: string): void {
  if (e instanceof RefusedError) {
    const n = e.problems.length;
    const many = n >= maxProblems ? `${n} or more problems (checking stops there)` : `${n} problem${n === 1 ? "" : "s"}`;
    console.error(`Clack: the ${what} ${url} was refused, for ${many}${then}:\n${describeProblems(e.problems, 100).join("\n")}`);
  } else {
    console.error(`Clack: the ${what} ${url} could not be loaded${then}:`, e);
  }
}

export type Obj = Record<string, unknown>;

/**
 * Sets o[k] to v as a field of its own, whatever k is: "__proto__" too,
 * which an assignment would take as o's prototype.
 */
export function put(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Whether v is a JSON object (not an array, not null). */
export const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with a parsed value before any schema is consulted, added
 * to out: values nested more than maxDepth deep; numbers too large to be
 * held (JSON.parse makes them Infinity). Not lone surrogates: those are
 * looked for in the text (loneSurrogateIn), where none can hide -- in a
 * value nested too deep for this walk, past maxProblems, or replaced by a
 * repeated key.
 *
 * v sits at path, depth deep in its document; skip, if v holds it, is left
 * for a later call. The walk is depth first, in the document's order, so
 * once out holds maxProblems the ones kept are the earliest. It keeps its
 * own stack -- each container and how far through it -- so no document can
 * exhaust the call stack, and spells out a path only for a problem.
 */
export function checkJSON(v: unknown, path: string, depth: number, out: Problem[], skip?: unknown): void {
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
  const enter = (c: object, key: string | number, d: number): void => {
    frames.push({ c, keys: Array.isArray(c) ? null : Object.keys(c), i: 0, key, depth: d });
  };
  // The value itself.
  if (typeof v === "number" && !Number.isFinite(v)) report(path, "is a number too large to hold");
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
    const x: unknown = (f.c as Record<string | number, unknown>)[key];
    if (typeof x === "number") {
      if (!Number.isFinite(x)) report(pathTo(key), "is a number too large to hold");
    } else if (typeof x === "object" && x !== null && x !== skip) {
      if (f.depth + 1 > maxDepth) report(pathTo(key), `nests more than ${maxDepth} deep`);
      else enter(x, key, f.depth + 1);
    }
  }
}

const escapeStep = (key: string | number): string => (typeof key === "number" ? String(key) : escape(key));

/** Half of a surrogate pair as an escape; or as itself, standing alone in the text (in Unicode mode, a pair is one code point). */
const escapedHalf = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g;
const eitherHalf = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}|\p{Cs}/gu;

/**
 * Where JSON text holds half of a surrogate pair without its other half
 * (formats.loneSurrogate), and whether it is an escape; or null. Looked for
 * in the text, as the tools look for it, and not in the parsed value: the
 * walk of that stops at a value nested too deep, or once enough problems
 * are found, and never sees a value that a repeated key replaced.
 *
 * Only for text that parsed as JSON, with any comments gone: then every
 * backslash is in a string, and one starts an escape unless the
 * backslashes just before it pair it off. So the search is native -- for
 * each \u escape of a surrogate, not for every character -- which matters
 * in a manifest of many megabytes with an emoji written as a pair. Text
 * decoded from bytes cannot hold a half as itself (UTF-8 cannot), so only
 * text from script is searched for those too; there, as JSON.parse reads
 * it, an escape and a half as itself can make a pair, either way round.
 */
function loneSurrogateAt(text: string, fromScript: boolean): { index: number; escaped: boolean } | null {
  /** The half starting at i, if one does: its code unit, and how long it is written. */
  const halfAt = (i: number): { unit: number; length: number } | null => {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return { unit: c, length: 1 };
    if (c !== 0x5c || !/^\\u[dD][89a-fA-F][0-9a-fA-F]{2}$/.test(text.slice(i, i + 6))) return null;
    let slashes = 0;
    while (text[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) return null; // "\\u...": a backslash, then letters
    return { unit: parseInt(text.slice(i + 2, i + 6), 16), length: 6 };
  };
  const halves = new RegExp(fromScript ? eitherHalf : escapedHalf);
  for (let m = halves.exec(text); m; m = halves.exec(text)) {
    const half = halfAt(m.index);
    if (!half) continue;
    const lone = { index: m.index, escaped: half.length === 6 };
    if (half.unit >= 0xdc00) return lone; // a low half with no high half before it
    const low = halfAt(m.index + half.length);
    if (!low || low.unit < 0xdc00) return lone; // a high half with no low half after it
    halves.lastIndex = m.index + half.length + low.length; // the pair, whole
  }
  return null;
}

/**
 * The problem a lone surrogate in JSON text is, if it holds one
 * (loneSurrogateAt): the one problem reported, against the whole file, as
 * the tools report it (they find it before anything else can be checked);
 * the message says where.
 */
export function loneSurrogateIn(text: string, fromScript: boolean): Problem | null {
  const lone = loneSurrogateAt(text, fromScript);
  if (!lone) return null;
  const { index } = lone;
  let line = 1;
  for (let at = text.indexOf("\n"); at >= 0 && at < index; at = text.indexOf("\n", at + 1)) line++;
  const column = index - text.lastIndexOf("\n", index - 1);
  const what = lone.escaped ? "a lone surrogate escape" : "a lone surrogate";
  return { path: "", message: `has a string that is not well-formed Unicode (${what}, at line ${line}, column ${column})` };
}

/**
 * Parses JSON, throwing only a SyntaxError: a parser may give up on a
 * document too deep for it with something else, and to the caller it is
 * all text that is not JSON.
 */
export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw e instanceof SyntaxError ? e : new SyntaxError(String(e));
  }
}

/**
 * Bytes as UTF-8 text, strictly, or null if they are not UTF-8. A
 * byte-order mark is kept, and so refused as not JSON, as the tools refuse
 * it (JSON has none: RFC 8259, 8.1).
 */
export function decodeUTF8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Fetches the JSON file at url -- a manifest or a theme, as what says --
 * and returns its bytes and the URL it came from, after any redirect. Only
 * JSON is accepted (by its Content-Type), and no more than maxBytes of it;
 * the request carries cookies to the page's own origin only, and can be
 * cancelled with signal. A response refused before it is read is
 * cancelled, not left to download. Throws an Error that says why -- for a
 * file too large, the one refused makes, as the file's own checks refuse
 * one (and the tools do, as a problem in it).
 */
export async function fetchJSON(url: string, signal: AbortSignal, what: string, maxBytes: number, refused: (problems: Problem[]) => Error): Promise<{ bytes: Uint8Array; url: string }> {
  const response = await fetch(url, { credentials: "same-origin", signal, headers: { Accept: "application/json" } });
  const refuse = async (why: string | Error): Promise<never> => {
    await response.body?.cancel().catch(() => {});
    throw typeof why === "string" ? new Error(`Clack: ${why}`) : why;
  };
  const tooLarge = (): Error => refused([{ path: "", message: `is larger than ${maxBytes} bytes` }]);
  if (!response.ok) {
    await refuse(`the ${what} could not be fetched: ${response.status} ${response.statusText}`.trim());
  }
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    await refuse(`the ${what} must be served as application/json, not ${type || "nothing"}`);
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await refuse(tooLarge());
  }
  // Read in pieces, so a file that does not say its size, or says it
  // wrongly, still cannot be larger than the limit.
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`Clack: the ${what} has no body`);
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
      throw tooLarge();
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
  if (buffer) return { bytes: buffer.subarray(0, size), url: response.url || url };
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return { bytes, url: response.url || url };
}

/**
 * Lets the page draw and answer input -- and, in a page out of view, its
 * other work -- before going on. A message to itself rather than a timer:
 * browsers hold chained timers back to 4 ms or more each, and much longer
 * in a page out of view, but not messages.
 */
export function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
