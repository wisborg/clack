import type { ClackShow } from "../src/clack";
import { tagName } from "../src/clack";
import { check, decode, load, ManifestError, maxBytes, parse } from "../src/manifest";
import example from "../schema/examples/manifest.json";
import fixture from "./fixtures/manifests.json";
import { assert, assertEqual, fixture as fixtureEl, test } from "./harness";
import { figure, img, imageLog, resetImageLog, settledOn, waitFor } from "./util";

/** A deep copy of the example manifest, through JSON as a fetched one would come. */
function exampleCopy(): unknown {
  return JSON.parse(JSON.stringify(example)) as unknown;
}

/** Sets the value at a JSON Pointer (null removes it; "" replaces the document). */
function setPointer(doc: unknown, pointer: string, value: unknown): unknown {
  if (pointer === "") return value;
  const parts = pointer.split("/").slice(1).map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
  let cur = doc as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] === undefined || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  // A key under a value that is not an object or array: the random edits
  // ask for these, and they make no sense; the document is left as it was.
  if (typeof cur !== "object" || cur === null) return doc;
  const last = parts[parts.length - 1]!;
  if (value === null) {
    delete cur[last];
  } else {
    // An own property even for "__proto__", as JSON.parse makes it.
    Object.defineProperty(cur, last, { value, enumerable: true, writable: true, configurable: true });
  }
  return doc;
}

test("the shared manifest cases get the verdicts the Go reference gives", () => {
  const failures: string[] = [];
  for (const c of fixture.cases) {
    let doc = exampleCopy();
    for (const [pointer, value] of Object.entries(c.set)) {
      doc = setPointer(doc, pointer, value);
    }
    // error is null, one place, or a list of places.
    const want: string[] | null = c.error === null ? null : Array.isArray(c.error) ? c.error : [c.error];
    // Through JSON text, as from the network: a "__proto__" key stays a key.
    const problems = check(JSON.parse(JSON.stringify(doc)));
    const got = new Set(problems.map((p) => p.path));
    if (want === null && problems.length > 0) {
      failures.push(`${c.name}: refused: ${problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`);
    } else if (want !== null && problems.length === 0) {
      failures.push(`${c.name}: accepted`);
    } else if (want !== null && ([...got].some((p) => !want.includes(p)) || want.some((p) => !got.has(p)))) {
      failures.push(`${c.name}: errors at ${[...got].join(", ")}, want ${want.join(", ")}`);
    }
  }
  // Whole files, as bytes: decoded and parsed as load() does.
  for (const r of fixture.raw) {
    const bytes = Uint8Array.from(atob(r.bytes), (ch) => ch.charCodeAt(0));
    let accepted = true;
    let why = "";
    try {
      parse(decode(bytes), "https://example.com/m.json");
    } catch (e) {
      accepted = false;
      why = String(e);
    }
    if (accepted !== r.accepted) failures.push(`raw ${r.name}: accepted ${accepted}, want ${r.accepted} ${why}`);
  }
  assert(failures.length === 0, failures.join("\n"));
});

test("parse resolves every URL against the manifest's own", () => {
  const m = parse(JSON.stringify(example), "https://photos.example.com/albums/coast/manifest.json");
  assertEqual(m.title, "Coastlines", "title");
  assertEqual(m.lang, "en", "lang");
  const [a, b] = m.slides;
  assertEqual(a!.alternatives[0]!.srcset.split(", ")[0], "https://photos.example.com/albums/coast/photos/02-640.avif 640w", "a source");
  assertEqual(a!.full, "https://photos.example.com/albums/coast/photos/02.jpg", "the full-size file");
  assertEqual(a!.page, "https://photos.example.com/albums/coastlines/low-tide", "the page, from the root");
  assertEqual(b!.src, "https://cdn.example.com/coastlines/01-1280.jpg", "an absolute URL, as it was");
  assertEqual(a!.title, "Low tide", "the title");
  assertEqual(a!.color, "#8a8d8c", "the placeholder colour");
});

test("parse refuses what is not JSON, and names every problem in what is", () => {
  let e: unknown = null;
  try {
    parse("{ not json", "https://example.com/");
  } catch (err) {
    e = err;
  }
  assert(e instanceof SyntaxError, "not JSON: a SyntaxError");
  try {
    parse(JSON.stringify({ format: "clack-manifest/1", slides: [{ id: "a" }], extra: 1 }), "https://example.com/");
  } catch (err) {
    e = err;
  }
  assert(e instanceof ManifestError, "a ManifestError");
  const paths = (e as ManifestError).problems.map((p) => p.path).sort();
  assertEqual(paths.join(" "), "/extra /slides/0 /slides/0 /slides/0 /slides/0", "every problem, by place");
});

/** A tiny pseudo-random generator, seeded, so a failure can be repeated. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every place in a document, as JSON Pointers. */
function places(doc: unknown, at = ""): string[] {
  const out = [at];
  if (Array.isArray(doc)) doc.forEach((v, i) => out.push(...places(v, `${at}/${i}`)));
  else if (typeof doc === "object" && doc !== null) {
    for (const [k, v] of Object.entries(doc)) out.push(...places(v, `${at}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  }
  return out;
}

test("no manifest, however broken, makes the checker throw or the parser fail other than as it should", () => {
  const values: unknown[] = [
    null, true, false, 0, -1, 0.5, 1e308, -1e308, 2 ** 53, "", "x", "javascript:alert(1)", "//", "#", "x-",
    "a".repeat(6000), [], [{}], {}, { id: "z" }, { "x-": 1 }, { __proto__: null }, "constructor", "toString",
  ];
  const keys = ["id", "x-a", "__proto__", "constructor", "toString", "hasOwnProperty", "slides", "url", ""];
  const next = random(20261101);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  for (let round = 0; round < 1500; round++) {
    let doc = exampleCopy();
    for (let edits = 1 + Math.floor(next() * 4); edits > 0; edits--) {
      const at = pick(places(doc));
      const r = next();
      if (r < 0.6) doc = setPointer(doc, at, pick(values));
      else if (r < 0.8 && at) doc = setPointer(doc, at, null);
      else doc = setPointer(doc, `${at === "" ? "" : at}/${pick(keys)}`.replace(/^\/\//, "/"), pick(values));
    }
    const text = JSON.stringify(doc) ?? "null";
    let problems: unknown;
    try {
      problems = check(JSON.parse(text));
    } catch (e) {
      throw new Error(`round ${round}: check threw ${String(e)} on ${text.slice(0, 300)}`);
    }
    assert(Array.isArray(problems), `round ${round}: check returned no list`);
    try {
      parse(text, "https://example.com/m.json");
    } catch (e) {
      if (!(e instanceof ManifestError)) {
        throw new Error(`round ${round}: parse threw ${String(e)} on ${text.slice(0, 300)}`);
      }
    }
  }
  // Truncated text is not JSON, and says so.
  const whole = JSON.stringify(example);
  for (let i = 0; i < 200; i++) {
    const cut = whole.slice(0, Math.floor(next() * whole.length));
    try {
      parse(cut, "https://example.com/");
    } catch (e) {
      if (!(e instanceof SyntaxError) && !(e instanceof ManifestError)) throw new Error(`a cut at ${cut.length}: ${String(e)}`);
    }
  }
});

/** A URL on the test server that answers with body, as type. */
function echo(body: string, o: { path?: string; type?: string; status?: number; delay?: number } = {}): string {
  const q = new URLSearchParams({ body });
  if (o.type) q.set("type", o.type);
  if (o.status) q.set("status", String(o.status));
  if (o.delay) q.set("delay", String(o.delay));
  return `/echo/${o.path ?? "manifest.json"}?${q}`;
}

function manifestOf(n: number, extra: Record<string, unknown> = {}): string {
  const slides = Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    alt: `manifest photo ${i + 1}`,
    width: 300,
    height: 200,
    sources: [{ url: img(300, 200, "557799"), width: 300 }],
    description: { title: `M${i + 1}` },
  }));
  return JSON.stringify({ format: "clack-manifest/1", title: "From a manifest", lang: "da", slides, ...extra });
}

async function refusal(url: string): Promise<string> {
  try {
    await load(url, new AbortController().signal);
  } catch (e) {
    return String(e);
  }
  return "";
}

test("load accepts JSON only, of a size that makes sense, from where it says", async () => {
  const m = await load(echo(manifestOf(2)), new AbortController().signal);
  assertEqual(m.slides.length, 2, "slides");
  assert((await refusal(echo(manifestOf(1), { type: "text/html" }))).includes("application/json"), "HTML is refused");
  assert((await refusal(echo("{}", { status: 404 }))).includes("404"), "a 404 is refused");
  assert((await refusal(`/big?bytes=${maxBytes + 1}&declare=1`)).includes("larger"), "a declared size too large is refused");
  assert((await refusal(`/big?bytes=${maxBytes + 1}`)).includes("larger"), "an undeclared size too large is refused, as it comes");
  assert((await refusal(echo("%FF", {}).replace("body=%25FF", "body=%FF"))).includes("not UTF-8"), "bytes that are not UTF-8 are refused");
  // After a redirect, relative URLs are relative to where it ended.
  const body = JSON.stringify({ format: "clack-manifest/1", slides: [{ id: "r", alt: "", width: 1, height: 1, sources: [{ url: "r.png", width: 1 }] }] });
  const at = echo(body, { path: "albums/coast/manifest.json" });
  const moved = await load(`/redirect?to=${encodeURIComponent(at)}`, new AbortController().signal);
  assertEqual(new URL(moved.slides[0]!.src).pathname, "/echo/albums/coast/r.png", "resolved against the final URL");
});

function show(attrs: Record<string, string>, markup = 0): ClackShow {
  const s = document.createElement(tagName);
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.style.setProperty("--clack-transition-duration", "40ms");
  s.style.width = "600px";
  for (let i = 0; i < markup; i++) s.append(figure({}, i));
  fixtureEl().append(s);
  return s;
}

test("a show with src shows its manifest's slides, named and in its language", async () => {
  const s = show({ src: echo(manifestOf(3)) });
  await waitFor(() => s.count === 3, "the manifest's slides");
  await settledOn(s, "1 of 3");
  assertEqual(s.slides[0]!.alt, "manifest photo 1", "its photo");
  const root = s.shadowRoot!;
  assertEqual(root.querySelector(".caption")!.getAttribute("lang"), "da", "its language, on its caption");
  assertEqual(root.querySelector(".slide img")!.getAttribute("lang"), "da", "and on the photo's description");
  assertEqual(root.querySelector(".show")!.hasAttribute("lang"), false, "not on Clack's own words");
  assertEqual(root.querySelector("button.next")!.closest("[lang]"), null, "the buttons are in the page's language");
  assertEqual(root.querySelector(".title")!.textContent, "M1", "its caption");
});

test("while the manifest loads, the markup is shown; then the manifest's slides", async () => {
  const s = show({ src: echo(manifestOf(2), { delay: 600 }) }, 4);
  await waitFor(() => s.count === 4, "the markup's slides first");
  await waitFor(() => s.count === 2, "then the manifest's");
  await settledOn(s, "1 of 2");
});

test("a manifest that cannot be had leaves the markup, says so, and fires error", async () => {
  const s = document.createElement(tagName);
  s.setAttribute("src", echo(JSON.stringify({ format: "clack-manifest/1", slides: [{ id: "x" }] })));
  s.append(figure({}));
  let fired = false;
  s.addEventListener("error", () => (fired = true));
  const quiet = console.error;
  console.error = () => {};
  try {
    fixtureEl().append(s);
    await waitFor(() => fired, "the error event");
  } finally {
    console.error = quiet;
  }
  const notice = s.shadowRoot!.querySelector<HTMLElement>(".notice")!;
  assertEqual(notice.hidden, false, "the notice is shown");
  assertEqual(notice.role, "status", "as a status");
  assertEqual(s.count, 1, "the markup's slide stays");
});

test("changing src drops the manifest on its way", async () => {
  const s = show({ src: echo(manifestOf(5), { delay: 800 }) });
  s.setAttribute("src", echo(manifestOf(2)));
  await waitFor(() => s.count === 2, "the second manifest");
  await new Promise((r) => setTimeout(r, 1000));
  assertEqual(s.count, 2, "the first never arrives");
  s.removeAttribute("src");
  await waitFor(() => s.count === 0, "back to the (empty) markup");
});

test("slides from script take over from src, and null goes back to it", async () => {
  const s = show({ src: echo(manifestOf(3)) });
  await waitFor(() => s.count === 3, "the manifest");
  s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  assertEqual(s.count, 1, "the script's");
  s.slides = null;
  await waitFor(() => s.count === 3, "the manifest again");
});

test("no URL, however long or nearly right, takes long to check", () => {
  // The URL pattern is written so each part can match only one way: a
  // backtracking engine stays linear. (RE2, in the tools, always is.)
  const slide = (url: string): unknown => ({ id: "a", alt: "", width: 1, height: 1, sources: [{ url, width: 1 }] });
  const near = [
    `https://${"a".repeat(1990)} `,
    `//${"a".repeat(1990)}\u0000`,
    `${"a".repeat(1990)}:x`,
    `/${"a".repeat(1990)} `,
    `https://${"a".repeat(2_000_000)} `,
  ];
  for (const url of near) {
    const t0 = performance.now();
    const problems = check({ format: "clack-manifest/1", slides: Array.from({ length: 50 }, () => slide(url)) });
    const ms = performance.now() - t0;
    assert(problems.length > 0, `${url.length} characters: refused`);
    assert(ms < 250, `${url.length} characters, 50 times: ${ms.toFixed(0)} ms`);
  }
});

test("check never throws, even on what JSON cannot hold", () => {
  const odd: unknown[] = [
    undefined,
    { format: "clack-manifest/1", slides: [{ id: "a", alt: "", width: 1, height: 1, sources: [{ url: "a.jpg", width: 1, type: undefined }] }] },
    { format: "clack-manifest/1", slides: [{ id: "a", alt: "", width: 1n, height: 1, sources: [{ url: "a.jpg", width: 1 }] }] },
    { format: "clack-manifest/1", slides: new Map() },
    { format: () => 1, slides: [] },
  ];
  for (const doc of odd) {
    assert(check(doc).length > 0, `refused: ${String(doc)}`);
  }
});

test("problems are listed in order of place, those beyond the schema too", () => {
  const slides = Array.from({ length: 10 }, (_, i) => ({ id: i === 9 ? "x" : `s${i}`, alt: "", width: 1, height: 1, sources: [{ url: "a.jpg", width: 1 }] }));
  slides[9]!.id = "s0"; // a repeated id, found after the schema's checks
  (slides[2] as Record<string, unknown>)["bad"] = 1;
  const paths = check({ format: "clack-manifest/1", slides }).map((p) => p.path);
  assertEqual(paths.join(" "), "/slides/2/bad /slides/9/id", "in order");
});

test("a URL the parser cannot resolve is a problem named by its place", () => {
  const body = { format: "clack-manifest/1", slides: [{ id: "a", alt: "", width: 1, height: 1, sources: [{ url: "https://a:99999/x.jpg", width: 1 }] }] };
  let e: unknown = null;
  try {
    parse(JSON.stringify(body), "https://example.com/");
  } catch (err) {
    e = err;
  }
  assert(e instanceof ManifestError, `a ManifestError, not ${String(e)}`);
  assertEqual((e as ManifestError).problems[0]!.path, "/slides/0/sources/0/url", "its place");
});

test("a manifest with a byte-order mark is refused, as the tools refuse it", async () => {
  assert((await refusal(echo(`﻿${manifestOf(1)}`))).includes("SyntaxError"), "refused as not JSON");
});

async function manifestFetches(): Promise<number> {
  return (await imageLog()).filter((e) => e.startsWith("manifest ")).length;
}

test("a manifest is fetched once: not twice when Clack loads late, nor again when the show moves", async () => {
  await resetImageLog();
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement(tagName);
  early.setAttribute("src", echo(manifestOf(2)));
  const s = document.adoptNode(early) as ClackShow;
  s.style.setProperty("--clack-transition-duration", "40ms");
  fixtureEl().append(s);
  await waitFor(() => s.count === 2, "the manifest");
  await settledOn(s, "1 of 2");
  fixtureEl().append(s); // moved to another place in the page
  await settledOn(s, "1 of 2");
  assertEqual(await manifestFetches(), 1, "fetches");
});

test("after a manifest fails, the notice goes once the page moves on", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const s = show({ src: echo("{}", { status: 500 }) }, 1);
    const notice = s.shadowRoot!.querySelector<HTMLElement>(".notice")!;
    await waitFor(() => !notice.hidden, "the notice");
    s.removeAttribute("src");
    await waitFor(() => notice.hidden === true, "the notice to go, back to the markup");
    s.setAttribute("src", echo("{}", { status: 500 }));
    await waitFor(() => !notice.hidden, "the notice again");
    s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
    assertEqual(notice.hidden, true, "gone, slides from script");
  } finally {
    console.error = quiet;
  }
});

test("a src that fails after another loaded leaves the markup, not the old manifest", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const s = show({ src: echo(manifestOf(3)) }, 1);
    await waitFor(() => s.count === 3, "the first manifest");
    s.setAttribute("src", echo("{}", { status: 404 }));
    await waitFor(() => s.count === 1, "the markup's one slide");
    assert(s.shadowRoot!.querySelector(".caption")!.getAttribute("lang") !== "da", "nor the old manifest's language");
  } finally {
    console.error = quiet;
  }
});

test("slides withdrawn before Clack loads start one fetch, not two", async () => {
  await resetImageLog();
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement(tagName) as unknown as Record<string, unknown>;
  (early as unknown as Element).setAttribute("src", echo(manifestOf(2)));
  early["slides"] = null;
  const s = document.adoptNode(early as unknown as ClackShow);
  fixtureEl().append(s);
  await waitFor(() => s.count === 2, "the manifest");
  assertEqual(await manifestFetches(), 1, "fetches");
});

test("a show moved while its manifest loads does not start it again", async () => {
  await resetImageLog();
  const s = show({ src: echo(manifestOf(2), { delay: 500 }) });
  await new Promise((r) => setTimeout(r, 100));
  fixtureEl().append(s); // moved while the manifest is on its way
  await waitFor(() => s.count === 2, "the manifest");
  assertEqual(await manifestFetches(), 1, "fetches");
});

test("a show whose manifest failed, once moved, does not fail again", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    let errors = 0;
    const s = document.createElement(tagName);
    s.addEventListener("error", () => errors++);
    s.setAttribute("src", echo("{}", { status: 500 }));
    fixtureEl().append(s);
    await waitFor(() => errors === 1, "the error");
    fixtureEl().append(s);
    await new Promise((r) => setTimeout(r, 300));
    assertEqual(errors, 1, "error events");
  } finally {
    console.error = quiet;
  }
});

test("after a manifest with no slides, changing src does not bring in the markup", async () => {
  const s = show({ src: echo(JSON.stringify({ format: "clack-manifest/1", slides: [] }), { delay: 300 }) }, 2);
  await waitFor(() => s.count === 2, "the markup, while the first manifest loads");
  await waitFor(() => s.count === 0, "the empty manifest");
  s.setAttribute("src", echo(manifestOf(1), { delay: 300 }));
  await new Promise((r) => setTimeout(r, 100));
  assertEqual(s.count, 0, "still the empty manifest, while the next loads -- not the markup");
  await waitFor(() => s.count === 1, "the next manifest");
});

test("markup added while the first manifest loads is shown until it arrives", async () => {
  const s = show({ src: echo(manifestOf(2), { delay: 700 }) });
  await new Promise((r) => setTimeout(r, 50));
  s.append(figure({}), figure({}), figure({}));
  await waitFor(() => s.count === 3, "the markup added after connecting");
  await waitFor(() => s.count === 2, "then the manifest");
});

test("a refused manifest is logged with its URL and every problem, by place", async () => {
  const logged: string[] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const slides = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` }));
    const url = echo(JSON.stringify({ format: "clack-manifest/1", slides }));
    const s = document.createElement(tagName);
    let failed = false;
    s.addEventListener("error", () => (failed = true));
    s.setAttribute("src", url);
    fixtureEl().append(s);
    await waitFor(() => failed, "the error");
  } finally {
    console.error = quiet;
  }
  const message = logged.join("\n");
  assert(message.includes("/echo/manifest.json"), "names the manifest");
  assert(message.includes("48 problems"), `counts every problem: ${message.slice(0, 200)}`);
  assert(message.includes("/slides/11:"), "and lists the last");
});

test("a src that is not a URL fails once, and the notice goes with it", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    let errors = 0;
    const s = document.createElement(tagName);
    s.addEventListener("error", () => errors++);
    s.setAttribute("src", "http://a:99999/m.json");
    s.append(figure({}));
    fixtureEl().append(s);
    await waitFor(() => errors === 1, "the error");
    fixtureEl().append(s); // moved
    await new Promise((r) => setTimeout(r, 100));
    assertEqual(errors, 1, "not again for a move");
    const notice = s.shadowRoot!.querySelector<HTMLElement>(".notice")!;
    s.removeAttribute("src");
    await waitFor(() => notice.hidden === true, "the notice to go");
  } finally {
    console.error = quiet;
  }
});

test("setting src again after a failure retries it", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    await resetImageLog();
    let errors = 0;
    const url = echo("{}", { status: 503 });
    const s = document.createElement(tagName);
    s.addEventListener("error", () => errors++);
    s.setAttribute("src", url);
    fixtureEl().append(s);
    await waitFor(() => errors === 1, "the first failure");
    s.setAttribute("src", url); // the same, as a page retrying would
    await waitFor(() => errors === 2, "the retry's failure");
    assertEqual(await manifestFetches(), 2, "fetched twice");
  } finally {
    console.error = quiet;
  }
});

test("a show moved with an await between does not fetch its manifest again", async () => {
  await resetImageLog();
  const s = show({ src: echo(manifestOf(2), { delay: 400 }) });
  await new Promise((r) => setTimeout(r, 50));
  const parent = s.parentElement!;
  s.remove();
  await Promise.resolve();
  await Promise.resolve();
  parent.append(s);
  await waitFor(() => s.count === 2, "the manifest");
  assertEqual(await manifestFetches(), 1, "fetches");
});

test("text on screen keeps the language of the slide it belongs to", async () => {
  // The markup's slide is in the page's language; the manifest's slides,
  // whose photos are slow, in Danish.
  const body = JSON.parse(manifestOf(1)) as { slides: { sources: { url: string }[] }[] };
  body.slides[0]!.sources[0]!.url = img(300, 200, "557799", 900);
  const s = show({ src: echo(JSON.stringify(body)) }, 0);
  s.append(figure({ title: "English caption" }));
  await waitFor(() => s.count === 1 && s.slides[0]!.alt === "manifest photo 1", "the manifest's slide, its photo still coming");
  const caption = s.shadowRoot!.querySelector(".caption")!;
  assert(caption.getAttribute("lang") !== "da", `the markup's caption, still on screen, is not marked Danish (${caption.getAttribute("lang")})`);
  await waitFor(() => s.shadowRoot!.querySelector(".title")!.textContent === "M1", "the manifest's caption");
  assertEqual(caption.getAttribute("lang"), "da", "now Danish");
});
