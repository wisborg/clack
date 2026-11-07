import type { ClackShow } from "../src/clack";
import { tagName } from "../src/clack";
import { check, decode, load, ManifestError, maxBytes, parse } from "../src/manifest";
import example from "../schema/examples/manifest.json";
import fixture from "./fixtures/manifests.json";
import patternCases from "./fixtures/patterns.json";
import manifestSchemaForTest from "../schema/manifest-1.schema.json";
import { assert, assertEqual, fixture as fixtureEl, sleep, test } from "./harness";
import { checkRaw, comparePlaces, echo, figure, img, imageLog, places, quietly, random, resetImageLog, setPointer, settledOn, waitFor } from "./util";

/** A deep copy of the example manifest, through JSON as a fetched one would come. */
function exampleCopy(): unknown {
  return JSON.parse(JSON.stringify(example)) as unknown;
}

test("the shared manifest cases get the verdicts the Go reference gives", () => {
  const failures: string[] = [];
  for (const c of fixture.cases) {
    let doc = exampleCopy();
    for (const [pointer, value] of Object.entries(c.set)) {
      doc = setPointer(doc, pointer, value);
    }
    // Through JSON text, as from the network: a "__proto__" key stays a key.
    // JSON.stringify writes -0 as 0, so -0 is carried through as a marker
    // and put back in the text, to reach the checker as it would.
    const text = JSON.stringify(doc, (_k, v: unknown) => (Object.is(v, -0) ? "\u0000minus-zero" : v)).replaceAll('"\\u0000minus-zero"', "-0");
    // Through parse(), as a fetched manifest goes: its URLs resolved too,
    // so a refusal at that step is compared with the tools' as well.
    let problems: { path: string; message: string }[] = [];
    try {
      parse(text, "https://example.com/albums/coast/manifest.json");
    } catch (e) {
      problems = e instanceof ManifestError ? e.problems : [{ path: "", message: String(e) }];
    }
    const wrong = comparePlaces(c.name, c.error, problems);
    if (wrong) failures.push(wrong);
  }
  // Whole files, as bytes: decoded and parsed as load() does.
  for (const r of fixture.raw as { name: string; bytes: string; accepted: boolean; error?: string; why?: string }[]) {
    const bytes = Uint8Array.from(atob(r.bytes), (ch) => ch.charCodeAt(0));
    let problems: { path: string; message: string }[] = [];
    try {
      parse(decode(bytes), "https://example.com/m.json");
    } catch (e) {
      problems = e instanceof ManifestError ? e.problems : [{ path: "", message: String(e) }];
    }
    failures.push(...checkRaw(r.name, r, problems));
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
      // A copy of each value, so no two places share one object and no
      // object ends up inside itself.
      if (r < 0.6) doc = setPointer(doc, at, structuredClone(pick(values)));
      else if (r < 0.8 && at) doc = setPointer(doc, at, null);
      else doc = setPointer(doc, `${at === "" ? "" : at}/${pick(keys)}`.replace(/^\/\//, "/"), structuredClone(pick(values)));
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
  const bigDeclared = await refusal(`/big?bytes=${maxBytes + 1}&declare=1`);
  assert(bigDeclared.includes("was refused: (the whole file): is larger than"), `a declared size too large is refused: ${bigDeclared || "accepted"}`);
  const big = await refusal(`/big?bytes=${maxBytes + 1}`);
  assert(big.includes("was refused: (the whole file): is larger than"), `an undeclared size too large is refused, as it comes: ${big || "accepted"}`);
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
  assertEqual(root.querySelector(".title")!.getAttribute("lang"), "da", "its language, on its caption");
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
  await quietly(async () => {
    fixtureEl().append(s);
    await waitFor(() => fired, "the error event");
  });
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

test("a lone surrogate in a manifest's text is found wherever it is, written as itself or escaped", () => {
  const slide = '{"id":"a","alt":"","width":1,"height":1,"sources":[{"url":"a.jpg","width":1}]}';
  const deep = (inner: string): string => "[".repeat(70) + inner + "]".repeat(70);
  for (const [name, lone] of [
    ["written as itself", "\ud800"],
    ["escaped", "\\ud800"],
  ] as const) {
    for (const [where, text] of [
      ["in a value a repeated key replaces", `{"format":"clack-manifest/1","x-a":"${lone}","x-a":1,"slides":[${slide}]}`],
      ["nested too deep", `{"format":"clack-manifest/1","x-a":${deep(`"${lone}"`)},"slides":[${slide}]}`],
    ] as const) {
      let message = "";
      try {
        parse(text, "https://example.com/m.json");
      } catch (e) {
        if (e instanceof ManifestError) message = e.problems.map((p) => p.message).join(" | ");
      }
      assert(/lone surrogate/.test(message) && !/nests/.test(message), `${name}, ${where}: ${message || "accepted"}`);
    }
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
  await quietly(async () => {
    const s = show({ src: echo("{}", { status: 500 }) }, 1);
    const notice = s.shadowRoot!.querySelector<HTMLElement>(".notice")!;
    await waitFor(() => !notice.hidden, "the notice");
    s.removeAttribute("src");
    await waitFor(() => notice.hidden === true, "the notice to go, back to the markup");
    s.setAttribute("src", echo("{}", { status: 500 }));
    await waitFor(() => !notice.hidden, "the notice again");
    s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
    assertEqual(notice.hidden, true, "gone, slides from script");
  });
});

test("a src that fails after another loaded leaves the markup, not the old manifest", async () => {
  await quietly(async () => {
    const s = show({ src: echo(manifestOf(3)) }, 1);
    await waitFor(() => s.count === 3, "the first manifest");
    s.setAttribute("src", echo("{}", { status: 404 }));
    await waitFor(() => s.count === 1, "the markup's one slide");
    assert(s.shadowRoot!.querySelector(".title")!.getAttribute("lang") !== "da", "nor the old manifest's language");
  });
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
  await quietly(async () => {
    let errors = 0;
    const s = document.createElement(tagName);
    s.addEventListener("error", () => errors++);
    s.setAttribute("src", echo("{}", { status: 500 }));
    fixtureEl().append(s);
    await waitFor(() => errors === 1, "the error");
    fixtureEl().append(s);
    await sleep(300);
    assertEqual(errors, 1, "error events");
  });
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
  const logged = await quietly(async () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` }));
    const url = echo(JSON.stringify({ format: "clack-manifest/1", slides }));
    const s = document.createElement(tagName);
    let failed = false;
    s.addEventListener("error", () => (failed = true));
    s.setAttribute("src", url);
    fixtureEl().append(s);
    await waitFor(() => failed, "the error");
  });
  const message = logged.join("\n");
  assert(message.includes("/echo/manifest.json"), "names the manifest");
  assert(message.includes("48 problems"), `counts every problem: ${message.slice(0, 200)}`);
  assert(message.includes("/slides/11:"), "and lists the last");
});

test("a src that is not a URL fails once, and the notice goes with it", async () => {
  await quietly(async () => {
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
  });
});

test("setting src again after a failure retries it", async () => {
  await quietly(async () => {
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
  });
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
  const caption = s.shadowRoot!.querySelector(".title")!;
  assert(caption.getAttribute("lang") !== "da", `the markup's caption, still on screen, is not marked Danish (${caption.getAttribute("lang")})`);
  await waitFor(() => s.shadowRoot!.querySelector(".title")!.textContent === "M1", "the manifest's caption");
  assertEqual(caption.getAttribute("lang"), "da", "now Danish");
});

test("every URL the schema's pattern accepts is one the browser can resolve", () => {
  const urls = (patternCases as unknown as Record<string, { match: string[] }>)["manifest-1.schema.json#/$defs/url"]!.match;
  for (const u of urls) {
    let ok = true;
    try {
      new URL(u, "https://example.com/albums/coast/manifest.json");
    } catch {
      ok = false;
    }
    assert(ok, `accepted by the pattern, refused by the URL parser: ${u}`);
  }
});

test("slides from script withdrawn bring back the manifest at once, not fetched again", async () => {
  await resetImageLog();
  const s = show({ src: echo(manifestOf(3)) });
  await waitFor(() => s.count === 3, "the manifest");
  s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  s.slides = null;
  await waitFor(() => s.count === 3, "the manifest back");
  assertEqual(await manifestFetches(), 1, "fetches");
});

test("a show moved over several tasks does not fetch its manifest again", async () => {
  await resetImageLog();
  const s = show({ src: echo(manifestOf(2), { delay: 300 }) });
  await new Promise((r) => setTimeout(r, 50));
  const parent = s.parentElement!;
  s.remove();
  await new Promise((r) => setTimeout(r, 500)); // out of the page while it arrives
  parent.append(s);
  await waitFor(() => s.count === 2, "the manifest, held until the show was back");
  assertEqual(await manifestFetches(), 1, "fetches");
});

test("a photo kept across manifests takes the new one's language", async () => {
  const photo = img(300, 200, "557799");
  const manifest = (lang: string, alt: string): string =>
    JSON.stringify({ format: "clack-manifest/1", lang, slides: [{ id: "a", alt, width: 300, height: 200, sources: [{ url: photo, width: 300 }] }] });
  const s = show({ src: echo(manifest("en", "Low tide")) });
  await settledOn(s, "1 of 1");
  const kept = s.shadowRoot!.querySelector(".slide img")!;
  s.setAttribute("src", echo(manifest("da", "Lavvande")));
  await waitFor(() => kept.getAttribute("alt") === "Lavvande", "the new description");
  assertEqual(s.shadowRoot!.querySelector(".slide img"), kept, "the same photo");
  assertEqual(kept.getAttribute("lang"), "da", "in the new language");
});

test("the manifest's title names the show in the manifest's language", async () => {
  const s = show({ src: echo(manifestOf(1)) });
  await waitFor(() => s.count === 1, "the manifest");
  // The header's title, which names it, shown or not.
  const name = s.shadowRoot!.querySelector<HTMLElement>(".header-title")!;
  assertEqual(name.textContent, "From a manifest", "the title");
  assertEqual(name.getAttribute("lang"), "da", "its language");
});

test("random URLs: whatever the schema's pattern accepts, the browser resolves", () => {
  const url = new RegExp((manifestSchemaForTest.$defs.url as { pattern: string }).pattern, "u");
  const bits = ["a", "x", "n", "X", "N", "-", "--", "_", "1", "9", ".", "/", "//", "\\", ":", "%", "[", "]", "@", "?", "#", "xn--", "255", "256", ":65535", ":65536", "https://", "http://", "//"];
  const next = random(7);
  let accepted = 0;
  for (let i = 0; i < 20000; i++) {
    let u = "";
    for (let n = 1 + Math.floor(next() * 8); n > 0; n--) u += bits[Math.floor(next() * bits.length)];
    if (!url.test(u)) continue;
    accepted++;
    let resolved = true;
    try {
      new URL(u, "https://example.com/albums/coast/manifest.json");
    } catch {
      resolved = false;
    }
    assert(resolved, `accepted by the pattern, refused by the URL parser: ${u}`);
  }
  assert(accepted > 500, `enough of them were accepted to mean something (${accepted})`);
});

test("a manifest that failed on a refetch is never brought back from before", async () => {
  await quietly(async () => {
    // The same URL: it works the first time, and fails every time after.
    const url = `/once/m${Math.random().toString(36).slice(2)}?${new URLSearchParams({ body: manifestOf(3) })}`;
    const s = show({ src: url }, 1);
    await waitFor(() => s.count === 3, "the manifest");
    s.removeAttribute("src");
    await waitFor(() => s.count === 1, "the markup");
    let failed = false;
    s.addEventListener("error", () => (failed = true));
    s.setAttribute("src", url);
    await waitFor(() => failed, "the refetch failing");
    s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
    s.slides = null;
    await new Promise((r) => setTimeout(r, 100));
    assertEqual(s.count, 1, "the markup, not the copy from before");
    assertEqual(s.shadowRoot!.querySelector<HTMLElement>(".notice")!.hidden, false, "and the notice, back with it");
  });
});

test("slides withdrawn bring a loaded manifest back at once: goTo works straight away", async () => {
  const s = show({ src: echo(manifestOf(3)) });
  await waitFor(() => s.count === 3, "the manifest");
  s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  s.slides = null;
  assertEqual(s.count, 3, "the manifest, at once");
  assert(await s.goTo("m2"), "goTo one of its slides, at once");
});

test("a manifest that fails while the show is out of the page fetches nothing until it is back", async () => {
  await quietly(async () => {
    const s = show({ src: echo(manifestOf(2)) });
    await waitFor(() => s.count === 2 && s.slides[0]!.alt === "manifest photo 1", "the manifest");
    // Markup whose photos nobody has fetched yet, so a fetch would show.
    s.append(figure({}, 0), figure({}, 1));
    s.setAttribute("src", echo("{}", { status: 500, delay: 300 }));
    await new Promise((r) => setTimeout(r, 20));
    const parent = s.parentElement!;
    s.remove();
    await resetImageLog();
    await new Promise((r) => setTimeout(r, 600)); // it fails while the show is out
    assertEqual((await imageLog()).filter((e) => e.startsWith("/img/")).length, 0, "no photo fetched for a show out of the page");
    parent.append(s);
    await waitFor(() => s.slides[0]?.alt === "photo 1", "the markup, once back");
    assertEqual(s.shadowRoot!.querySelector<HTMLElement>(".notice")!.hidden, false, "with the notice");
  });
});

test("a new manifest's captions show at once, even while a photo is still coming", async () => {
  const manifest = (lang: string, title: string, slow: boolean): string =>
    JSON.stringify({
      format: "clack-manifest/1",
      lang,
      slides: [
        { id: "a", alt: "A", width: 300, height: 200, sources: [{ url: photoA, width: 300 }], description: { title } },
        { id: "b", alt: "B", width: 300, height: 200, sources: [{ url: slow ? photoSlow : photoB, width: 300 }] },
      ],
    });
  const photoA = img(300, 200, "557799");
  const photoB = img(300, 200, "557799");
  const photoSlow = img(300, 200, "557799", 1500);
  const s = show({ src: echo(manifest("en", "Low tide", true)) });
  await settledOn(s, "1 of 2");
  void s.next(); // slide 2's photo is slow: a request is in flight
  s.setAttribute("src", echo(manifest("da", "Lavvande", true)));
  await waitFor(() => s.shadowRoot!.querySelector(".title")!.textContent === "Lavvande", "the caption of the slide on screen, at once");
  assertEqual(s.shadowRoot!.querySelector(".title")!.getAttribute("lang"), "da", "in its language");
});

test("a page that answers a failed manifest with slides of its own keeps them", async () => {
  await quietly(async () => {
    const s = document.createElement(tagName);
    s.append(figure({}));
    s.addEventListener("error", () => {
      assertEqual(s.count, 1, "the markup is shown by the time error fires");
      s.slides = [
        { id: "f1", alt: "fallback", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] },
        { id: "f2", alt: "fallback", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] },
      ];
    });
    s.setAttribute("src", echo("{}", { status: 500 }));
    fixtureEl().append(s);
    await waitFor(() => s.count === 2, "the page's fallback");
    s.append(figure({}), figure({}));
    await new Promise((r) => setTimeout(r, 100));
    assertEqual(s.count, 2, "the fallback stays, whatever the markup does");
    assertEqual(s.slides[0]!.alt, "fallback", "the page's slides");
  });
});

test("a relative src means what it meant when it was set, wherever the page goes", async () => {
  await resetImageLog();
  const before = location.href;
  const s = show({ src: `echo/manifest.json?${new URLSearchParams({ body: manifestOf(2) })}` });
  await waitFor(() => s.count === 2, "the manifest");
  try {
    history.pushState(null, "", "/somewhere/else/");
    const parent = s.parentElement!;
    s.remove();
    parent.append(s);
    s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
    s.slides = null;
    await new Promise((r) => setTimeout(r, 200));
    assertEqual(s.count, 2, "the same manifest");
    assertEqual(await manifestFetches(), 1, "fetched once");
  } finally {
    history.replaceState(null, "", before);
  }
});

test("a manifest with no language leaves the show's name in the page's", async () => {
  const s = show({ src: echo(JSON.stringify({ format: "clack-manifest/1", title: "Coast", slides: [] })) });
  await waitFor(() => s.shadowRoot!.querySelector(".header-title")!.textContent === "Coast", "the name");
  assertEqual(s.shadowRoot!.querySelector(".header-title")!.hasAttribute("lang"), false, "inherited, not unknown");
});

test("slides withdrawn while the show is out of the page are back as soon as it is", () => {
  const s = show({}, 2);
  const parent = s.parentElement!;
  s.slides = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  s.remove();
  s.slides = null;
  parent.append(s);
  assertEqual(s.count, 2, "the markup, at once");
});

test("a manifest failing while the show is out of the page fires error once it is back", async () => {
  await quietly(async () => {
    let errors = 0;
    const s = show({ src: echo("{}", { status: 500, delay: 200 }) });
    s.addEventListener("error", () => errors++);
    const parent = s.parentElement!;
    s.remove();
    await new Promise((r) => setTimeout(r, 500));
    assertEqual(errors, 0, "not while out of the page");
    parent.append(s);
    assertEqual(errors, 1, "once back");
  });
});

test("an error owed for a manifest since dropped is never fired", async () => {
  await quietly(async () => {
    let errors = 0;
    const s = show({ src: echo("{}", { status: 500, delay: 200 }) });
    s.addEventListener("error", () => errors++);
    const parent = s.parentElement!;
    s.remove();
    await new Promise((r) => setTimeout(r, 500)); // fails while out of the page
    s.setAttribute("src", echo(manifestOf(2)));
    parent.append(s);
    await waitFor(() => s.count === 2, "the new manifest");
    assertEqual(errors, 0, "no error for the manifest dropped");
  });
});

test("slides withdrawn while a manifest is fetched again give way to the markup at once", async () => {
  const s = show({ src: echo(manifestOf(3), { delay: 1000 }) }, 2);
  await waitFor(() => s.count === 2, "the markup, while the manifest loads");
  s.slides = [{ id: "s", alt: "script", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  s.slides = null;
  assertEqual(s.slides[0]?.alt, "photo 1", "the markup's, not the withdrawn script's");
  await waitFor(() => s.count === 3, "then the manifest");
});

test("Clack loading late fetches nothing for a src the page has given slides in place of", async () => {
  await resetImageLog();
  const manifestURL = echo(manifestOf(2));
  const scriptPhoto = img(300, 200, "aa3366");
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement(tagName);
  early.setAttribute("src", manifestURL);
  const fig = figure({});
  early.append(fig);
  const markupPhoto = fig.querySelector("img")!.getAttribute("src")!;
  (early as unknown as Record<string, unknown>)["slides"] = [{ id: "s", alt: "", width: 300, height: 200, sources: [{ url: scriptPhoto, width: 300 }] }];
  const s = document.adoptNode(early) as ClackShow;
  fixtureEl().append(s);
  await settledOn(s, "1 of 1");
  // Only this test's own URLs are looked for: an earlier test's photos may
  // still be arriving.
  const log = await imageLog();
  assert(!log.includes(`manifest ${manifestURL}`), `no manifest fetched: ${log.join(" ")}`);
  assert(log.includes(scriptPhoto), `the script's photo fetched: ${log.join(" ")}`);
  assert(!log.includes(markupPhoto), `the markup's photo not fetched: ${log.join(" ")}`);
});

test("a src that is not a URL fails a moment later, so a page can listen for it, and can retry", async () => {
  await quietly(async () => {
    const s = document.createElement(tagName);
    s.setAttribute("src", "http://a:99999/m.json");
    fixtureEl().append(s);
    let errors = 0;
    s.addEventListener("error", () => {
      errors++;
      if (errors < 3) s.setAttribute("src", s.getAttribute("src")!); // retry, as a page might
    });
    await waitFor(() => errors === 3, "each failure, retried");
    await new Promise((r) => setTimeout(r, 100));
    assertEqual(errors, 3, "no more than asked for");
  });
});

test("a large manifest is checked in batches, each problem at its place", () => {
  const slides = Array.from({ length: 1234 }, (_, i) => ({ id: `s${i}`, alt: "", width: 1, height: 1, sources: [{ url: "a.jpg", width: 1 }] }));
  (slides[1100] as Record<string, unknown>)["bad"] = 1;
  slides[1200]!.id = "s3";
  const paths = check({ format: "clack-manifest/1", slides }).map((p) => p.path);
  assertEqual(paths.join(" "), "/slides/1100/bad /slides/1200/id", "found, and placed");
});

test("the failure notice is unseen until its words are in it", async () => {
  await quietly(async () => {
    const s = show({ src: echo("{}", { status: 500 }) });
    const notice = s.shadowRoot!.querySelector<HTMLElement>(".notice")!;
    // Looked at the moment it appears, not whenever a poll comes round.
    let whenShown: { text: string; opacity: string } | null = null;
    const watch = new MutationObserver(() => {
      if (!notice.hidden && whenShown === null) whenShown = { text: notice.textContent ?? "", opacity: getComputedStyle(notice).opacity };
    });
    watch.observe(notice, { attributes: true, attributeFilter: ["hidden"] });
    await waitFor(() => whenShown !== null, "the notice");
    watch.disconnect();
    assertEqual(whenShown!.text, "", "empty as it appears");
    assertEqual(whenShown!.opacity, "0", "and unseen while empty");
    await waitFor(() => notice.textContent !== "", "its words");
    assertEqual(getComputedStyle(notice).opacity, "1", "seen once it has them");
  });
});

test("a slide with a million problems is checked without throwing, and its problems capped", () => {
  const extra = Array.from({ length: 300000 }, () => ({}));
  const problems = check({ format: "clack-manifest/1", slides: [{ id: "a", alt: "", width: 1, height: 1, sources: [{ url: "a.jpg", width: 1 }], extra }] });
  assert(problems.length > 0 && problems.length <= 1000, `capped: ${problems.length}`);
});

test("more slides than a manifest may hold are refused for their number, not checked one by one", () => {
  const t0 = performance.now();
  const problems = check({ format: "clack-manifest/1", slides: Array.from({ length: 25000 }, () => ({})) });
  assertEqual(problems.map((p) => p.path).join(" "), "/slides", "the one problem");
  assert(performance.now() - t0 < 500, "quickly");
});

test("a credit with no language of its own is in the page's, not the caption's", async () => {
  const s = show({});
  s.slides = [{ id: "a", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }], description: { title: "Marée basse", credit: "Photo: Jane" } }];
  s.slides = [{ ...s.slides[0]!, captionLang: "fr", creditLang: null }];
  await settledOn(s, "1 of 1");
  const root = s.shadowRoot!;
  assertEqual(root.querySelector(".title")!.getAttribute("lang"), "fr", "the title in French");
  assertEqual(root.querySelector(".credit")!.closest("[lang]"), null, "the credit inheriting the page's");
});

test("a page retrying an invalid src from its error handler stays responsive", async () => {
  await quietly(async () => {
    const s = document.createElement(tagName);
    s.setAttribute("src", "http://a:99999/m.json");
    let errors = 0;
    let timerRan = false;
    let timerRanBy = -1;
    s.addEventListener("error", () => {
      errors++;
      if (errors === 1) setTimeout(() => (timerRan = true), 0);
      if (errors === 10 && timerRanBy < 0) timerRanBy = timerRan ? 10 : 0;
      if (errors < 10) s.setAttribute("src", s.getAttribute("src")!);
    });
    fixtureEl().append(s);
    await waitFor(() => errors === 10, "ten failures");
    assertEqual(timerRanBy, 10, "the page's own timer ran between retries");
  });
});

test("src is a property too, and one set before Clack loads is taken up", async () => {
  const s = show({});
  s.src = echo(manifestOf(2));
  assertEqual(s.getAttribute("src"), s.src, "it reflects the attribute");
  await waitFor(() => s.count === 2, "the manifest");
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement(tagName) as unknown as Record<string, unknown>;
  early["src"] = echo(manifestOf(3));
  const late = document.adoptNode(early as unknown as ClackShow);
  fixtureEl().append(late);
  await waitFor(() => late.count === 3, "the manifest set as a property before Clack loaded");
});

test("the problems kept, past the limit, are the earliest in the file", () => {
  const doc = JSON.parse(`{"format":"clack-manifest/1","slides":[],"x-a":[${Array(2000).fill("1e999").join(",")}]}`) as unknown;
  const paths = check(doc).map((p) => p.path);
  assert(paths.includes("/x-a/0") && paths.includes("/x-a/999"), "the first thousand");
  assert(!paths.includes("/x-a/1999"), "not the last");
});

test("a later failure's notice is given its words a moment after it shows, not at once", async () => {
  await quietly(async () => {
    const s = show({ src: echo("{}", { status: 500 }) });
    const notice = s.shadowRoot!.querySelector<HTMLElement>(".notice")!;
    await waitFor(() => !notice.hidden, "the first notice");
    s.setAttribute("src", echo("{}", { status: 500, delay: 60 })); // within the first's moment
    let textWhenShown: string | null = null;
    const watch = new MutationObserver(() => {
      if (!notice.hidden && textWhenShown === null) textWhenShown = notice.textContent ?? "";
    });
    watch.observe(notice, { attributes: true, attributeFilter: ["hidden"] });
    await waitFor(() => textWhenShown !== null, "the second notice");
    await new Promise((r) => setTimeout(r, 30));
    watch.disconnect();
    assertEqual(notice.textContent, "", "still empty just after it shows: the first one's timer is gone");
  });
});

test("a page retrying a src that fetch refuses at once stays responsive", async () => {
  await quietly(async () => {
    const s = document.createElement(tagName);
    s.setAttribute("src", `${location.origin.replace("//", "//user:pw@")}/m.json`); // fetch refuses credentials in a URL
    let errors = 0;
    let timerRan = false;
    let timerRanBy = -1;
    s.addEventListener("error", () => {
      errors++;
      if (errors === 1) setTimeout(() => (timerRan = true), 0);
      if (errors === 10 && timerRanBy < 0) timerRanBy = timerRan ? 10 : 0;
      if (errors < 10) s.setAttribute("src", s.getAttribute("src")!);
    });
    fixtureEl().append(s);
    await waitFor(() => errors === 10, "ten failures");
    assertEqual(timerRanBy, 10, "the page's own timer ran between retries");
  });
});

test("too many slides are refused for their number alone, whatever else is wrong", () => {
  const slides = Array.from({ length: 20001 }, () => ({}));
  assertEqual(check({ slides, "x-n": Infinity }).map((p) => p.path).join(" "), "/slides", "the one place, as in the tools");
});

test("relative URLs in script slides keep the meaning they had when given", async () => {
  const before = location.href;
  const s = show({});
  const name = img(300, 200).slice(1); // relative to the page: "img/..."
  s.slides = [
    { id: "a", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] },
    { id: "b", alt: "", width: 300, height: 200, sources: [{ url: name, width: 300 }] },
  ];
  try {
    history.pushState(null, "", "/somewhere/else/");
    assertEqual(s.slides[1]!.src, new URL(name, before).href, "resolved against the page when given");
    await s.goTo("b");
    await settledOn(s, "2 of 2");
    const photo = s.shadowRoot!.querySelector<HTMLImageElement>(".slide img")!;
    assert(photo.complete && photo.naturalWidth > 0, "and fetched from there");
  } finally {
    history.replaceState(null, "", before);
  }
});

test("an object shared at every level is copied once, not once per way to reach it", () => {
  let a: unknown = [];
  for (let i = 0; i < 50; i++) a = [a, a];
  const t0 = performance.now();
  const slide = { id: "a", alt: "", width: 1, height: 1, sources: [{ url: "a.jpg", width: 1 }], "x-a": a };
  const s = document.createElement(tagName);
  s.slides = [slide];
  assert(performance.now() - t0 < 500, "quickly");
  assertEqual(s.count, 1, "and taken");
});

test("a src that is not http or https is refused, not fetched", async () => {
  await quietly(async () => {
    const blob = URL.createObjectURL(new Blob([manifestOf(1)], { type: "application/json" }));
    const s = document.createElement(tagName);
    s.append(figure({}));
    let failed = false;
    s.addEventListener("error", () => (failed = true));
    s.setAttribute("src", blob);
    fixtureEl().append(s);
    await waitFor(() => failed, "the error");
    assertEqual(s.count, 1, "the markup, not the blob's slides");
    URL.revokeObjectURL(blob);
  });
});

test("the problem kept first is the earliest in the file, even inside a container", () => {
  const doc = JSON.parse(`{"format":"clack-manifest/1","slides":[],"x-a":[[1e999],${Array(1000).fill("1e999").join(",")}]}`) as unknown;
  const paths = check(doc).map((p) => p.path);
  assert(paths.includes("/x-a/0/0"), `the first, inside the nested array, is kept: ${paths.slice(0, 3).join(" ")}`);
});
