// Themes: Clack's checker against the tools' (tools/internal/formats
// ParseTheme), from the shared cases; what a theme compiles to; and the
// theme attribute, with built-in themes and theme files.
import type { ClackShow } from "../src/clack";
import { builtinTheme, compile, contrast, parseColor, readTheme, readThemeBytes, stripComments, ThemeError } from "../src/theme";
import fixture from "./fixtures/themes.json";
import { assert, assertEqual, assertThrows, skip, sleep, test } from "./harness";
import { checkRaw, comparePlaces, echo, figures, imageLog, makeShow, places, quietly, random, resetImageLog, setPointer, settledOn, waitFor } from "./util";

const builtinNames = ["base", "gallery", "darkroom", "mat", "minimal", "contact-sheet"];

/** A file in the repository, as the test server serves it (tools/dev, /repo/). */
async function repoFile(path: string): Promise<string> {
  const response = await fetch(`/repo/${path}`);
  assert(response.ok, `${path}: ${response.status}`);
  return response.text();
}

/** The example theme's text, as the tools read it: comments and all. */
async function exampleText(): Promise<string> {
  return repoFile("schema/examples/theme-annotated.json");
}

/** A theme's problems: none if it is accepted. */
function problemsOf(read: () => unknown): { path: string; message: string }[] {
  try {
    read();
    return [];
  } catch (e) {
    if (e instanceof ThemeError) return e.problems;
    throw e;
  }
}


test("the shared theme cases get the verdicts the Go reference gives", async () => {
  const text = await exampleText();
  const failures: string[] = [];
  for (const c of fixture.cases) {
    let doc = JSON.parse(stripComments(text)) as unknown;
    for (const [pointer, value] of Object.entries(c.set)) doc = setPointer(doc, pointer, value);
    const wrong = comparePlaces(c.name, c.error, problemsOf(() => readThemeBytes(new TextEncoder().encode(JSON.stringify(doc)))));
    if (wrong) failures.push(wrong);
  }
  type Raw = { name: string; text?: string; bytes?: string; file?: string; padTo?: number; accepted: boolean; error?: string; why?: string };
  for (const r of fixture.raw as Raw[]) {
    let bytes =
      r.text !== undefined
        ? new TextEncoder().encode(r.text)
        : r.bytes !== undefined
          ? Uint8Array.from(atob(r.bytes), (ch) => ch.charCodeAt(0))
          : new TextEncoder().encode(await repoFile(r.file!));
    if (r.padTo !== undefined && r.padTo > bytes.length) {
      const padded = new Uint8Array(r.padTo).fill(0x20);
      padded.set(bytes);
      bytes = padded;
    }
    failures.push(...checkRaw(r.name, r, problemsOf(() => readThemeBytes(bytes))));
  }
  assert(failures.length === 0, failures.join("\n"));
});

test("comments are taken out without moving anything else", () => {
  const text = '{ // a\n "a": "/* not */", /* b\n c */ "b": 1 }';
  const out = stripComments(text);
  assertEqual(out.length, text.length, "the same length");
  assertEqual(out.split("\n").length, text.split("\n").length, "the same lines");
  assertEqual(JSON.stringify(JSON.parse(out)), '{"a":"/* not */","b":1}', "the strings kept");
  assertThrows(() => stripComments('{"a": 1} /* open'), SyntaxError, "a comment not closed");
  assertThrows(() => stripComments('{"a": "open'), SyntaxError, "a string not closed");
});

test("colours are read, and their contrast measured, as WCAG says", () => {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
  const white = parseColor("#fff")!;
  const black = parseColor("rgb(0 0 0)")!;
  assert(near(contrast(black, white), 21) && near(contrast(white, black), 21), "black and white");
  assert(near(contrast(parseColor("#777777")!, white), 4.48), "the classic just-too-light grey");
  assert(near(contrast(parseColor("rgb(0 0 0 / 50%)")!, white), 3.98), "composited first: #808080 on white");
  assertEqual(parseColor("#11223344")?.map((v) => Math.round(v * 255)).join(), "17,34,51,68", "#rrggbbaa");
  assertEqual(parseColor("rgb(1 2 3 / .5)")?.[3], 0.5, "alpha");
  assertEqual(parseColor("red"), null, "a name");
});

test("every built-in theme compiles to values CSS takes, every one of them", () => {
  for (const name of builtinNames) {
    const { properties, choices } = compile(builtinTheme(name));
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host {}");
    const style = (sheet.cssRules[0] as CSSStyleRule).style;
    for (const [property, value] of properties) {
      style.setProperty(property, value);
      // A custom property takes anything; color-scheme is the one that is not.
      assert(style.getPropertyValue(property) !== "", `${name}: ${property}: ${value} is not taken`);
    }
    for (const token of ["canvas", "text", "padding-inline", "caption-size", "control-size", "transition-duration", "index-gap"]) {
      assert(properties.some(([p]) => p === `--clack-${token}`), `${name}: --clack-${token} is set`);
    }
    for (const [choice, value] of Object.entries(choices)) assert(value !== "undefined", `${name}: ${choice} is chosen`);
  }
  const darkroom = new Map(compile(builtinTheme("darkroom")).properties);
  assertEqual(darkroom.get("color-scheme"), "dark", "darkroom forces dark");
  assert(!darkroom.get("--clack-shadow")!.includes("light-dark"), "and its shadow is dark's alone");
  const mat = new Map(compile(builtinTheme("mat")).properties);
  assert(mat.get("--clack-shadow") === "none" || mat.get("--clack-shadow")!.includes("light-dark"), "a theme in both schemes: a shadow for each");
  assertEqual(darkroom.get("--clack-canvas"), "#0b0b0b", "in dark only, its own colour");
  const gallery = new Map(compile(builtinTheme("gallery")).properties);
  assertEqual(gallery.get("color-scheme"), "light dark", "gallery follows the visitor");
  assertEqual(gallery.get("--clack-surface"), "light-dark(#fbfbfa, #232323)", "a colour in each scheme");
  assertEqual(gallery.get("--clack-padding-inline"), "clamp(16px, 5cqi, 72px)", "a fluid length");
  assertEqual(new Map(compile(builtinTheme("minimal")).properties).get("--clack-caption-credit"), "none", "no credit");
});

test("no theme, however broken, makes the checker throw other than a ThemeError", async () => {
  const text = await exampleText();
  const values: unknown[] = [null, true, 0, -1, 1e308, "", "#fff", "rgb(0 0 0 / 0.5)", "12px", { min: "1px", ideal: "2cqi", max: "3px" }, [], {}, "x".repeat(400), "dark", "gallery"];
  const keys = ["canvas", "x-a", "__proto__", "constructor", "scheme", "extends", "colors", "light", "type", ""];
  const next = random(20261105);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const base = JSON.parse(stripComments(text)) as unknown;
  for (let round = 0; round < 800; round++) {
    let doc = structuredClone(base);
    for (let edits = 1 + Math.floor(next() * 4); edits > 0; edits--) {
      const at = pick(places(doc));
      const r = next();
      if (r < 0.6) doc = setPointer(doc, at, structuredClone(pick(values)));
      else if (r < 0.8 && at) doc = setPointer(doc, at, null);
      else doc = setPointer(doc, `${at}/${pick(keys)}`, structuredClone(pick(values)));
    }
    const json = JSON.stringify(doc) ?? "null";
    try {
      readTheme(json);
    } catch (e) {
      if (!(e instanceof ThemeError)) throw new Error(`round ${round}: ${String(e)} on ${json.slice(0, 300)}`);
    }
  }
  // Text cut anywhere: a comment or string left open, or not JSON.
  for (let i = 0; i < 200; i++) {
    const cut = text.slice(0, Math.floor(next() * text.length));
    try {
      readTheme(cut);
    } catch (e) {
      if (!(e instanceof ThemeError)) throw new Error(`a cut at ${cut.length}: ${String(e)}`);
    }
  }
});

// ---- On the element ------------------------------------------------------

/** A token's value on a show, as CSS computes it. */
const token = (show: ClackShow, name: string): string => getComputedStyle(show).getPropertyValue(`--clack-${name}`);

/** The show's box, which carries its layout's choices. */
const box = (show: ClackShow): HTMLElement => show.shadowRoot!.querySelector<HTMLElement>(".show")!;

test("a built-in theme is taken up at once, by its name, and base without one", () => {
  const show = makeShow([{}]);
  assertEqual(token(show, "canvas"), "light-dark(#f3f3f1, #1b1b1b)", "base, with no theme named");
  assertEqual(box(show).dataset["layout"], "gallery", "base's layout");
  show.theme = "darkroom";
  assertEqual(show.getAttribute("theme"), "darkroom", "the property is the attribute");
  assertEqual(token(show, "canvas"), "#0b0b0b", "darkroom's canvas");
  assertEqual(getComputedStyle(show).colorScheme, "dark", "dark, whatever the visitor's setting");
  assertEqual(getComputedStyle(show).backgroundColor, "rgb(11, 11, 11)", "and drawn in it");
  assertEqual(box(show).dataset["layout"], "stage", "darkroom's layout");
  assertEqual(box(show).dataset["reveal"], "on-activity", "and its controls' reveal");
  show.removeAttribute("theme");
  assertEqual(token(show, "canvas"), "light-dark(#f3f3f1, #1b1b1b)", "base again");
});

test("the page's own value for a token wins over the theme's", () => {
  const show = makeShow([{}], { theme: "darkroom" });
  show.style.setProperty("--clack-canvas", "#202020");
  assertEqual(getComputedStyle(show).backgroundColor, "rgb(32, 32, 32)", "the page's canvas");
});

test("a theme file is fetched, checked and taken up; the show keeps its theme meanwhile", async () => {
  const harbour = JSON.stringify({ format: "clack-theme/1", name: "Harbour", extends: "mat", colors: { light: { canvas: "#eef0f1" }, dark: { canvas: "#16191b" } } });
  const show = makeShow([{}], { theme: "minimal" });
  show.theme = echo(harbour, { path: "harbour.json", delay: 300 });
  assertEqual(box(show).dataset["layout"], "full-bleed", "minimal's, until the file is here");
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme file's layout (mat's, which it extends)");
  assertEqual(token(show, "canvas"), "light-dark(#eef0f1, #16191b)", "its own colours");
});

test("a theme file that is refused, or cannot be had, leaves the theme there was, and says why", async () => {
  const pale = JSON.stringify({ format: "clack-theme/1", name: "Pale", colors: { light: { muted: "#bbbbbb" } } });
  for (const [theme, why] of [
    [echo(pale, { path: "pale.json" }), "/colors/light/muted: on canvas is"],
    [echo("{}", { path: "gone.json", status: 404 }), "404"],
    [echo(pale, { path: "pale.txt", type: "text/plain" }), "application/json"],
    ["javascript:alert(1)", "not an http(s) URL"],
    ["Darkroom", "not a built-in theme (they are base, gallery, darkroom, mat, minimal, contact-sheet)"],
    ["galery", "not a built-in theme"],
  ] as const) {
    await quietly(async (errors) => {
      const show = makeShow([{}], { theme: "mat" });
      show.theme = theme;
      await waitFor(() => errors.length > 0, `the console told for ${theme}`);
      assert(errors[0]!.includes(why), `${theme}: ${errors[0]}`);
      assertEqual(box(show).dataset["layout"], "matted", `${theme}: mat's layout kept`);
    });
  }
});

test("a theme asked for while another is on its way replaces it", async () => {
  const slow = JSON.stringify({ format: "clack-theme/1", name: "Slow", extends: "minimal" });
  const show = makeShow([{}]);
  show.theme = echo(slow, { path: "slow.json", delay: 400 });
  show.theme = "mat";
  assertEqual(box(show).dataset["layout"], "matted", "mat, at once");
  await sleep(600);
  assertEqual(box(show).dataset["layout"], "matted", "still mat: the slow one was dropped");
});

/** How many times the test server was asked for a theme file at this path (by /echo, which logs each). */
async function fetchesOf(path: string): Promise<number> {
  return (await imageLog()).filter((e) => e.startsWith(`manifest /echo/${path}?`)).length;
}

test("a word that is not a built-in theme's name is not fetched, and space around a name is no matter", async () => {
  const show = makeShow([{}], { theme: " darkroom " });
  assertEqual(box(show).dataset["layout"], "stage", "darkroom, the spaces aside");
  show.theme = "   ";
  assertEqual(box(show).dataset["layout"], "gallery", "base, for nothing but spaces");
  const before = performance.getEntriesByType("resource").length;
  await quietly(async (errors) => {
    const words = ["Darkroom", "galery", "contact_sheet", "Mørk", "dark room", "harbour?v=2"];
    for (const word of words) show.theme = word;
    assertEqual(errors.length, words.length, `each said: ${errors.join(" | ")}`);
  });
  await sleep(100);
  const fetched = performance.getEntriesByType("resource").slice(before).map((e) => e.name);
  assert(!fetched.some((u) => /Darkroom|galery|contact_sheet|M%C3%B8rk|dark%20room|harbour/.test(u)), `fetched: ${fetched.join(" ")}`);
  assertEqual(box(show).dataset["layout"], "gallery", "base kept");
});

test("a theme file is fetched once for the page, however it is spelt and however many shows ask", async () => {
  await resetImageLog();
  const shared = JSON.stringify({ format: "clack-theme/1", name: "Shared", extends: "mat" });
  const url = echo(shared, { path: "shared.json", delay: 200 });
  const shows = [makeShow([{}], { theme: url }), makeShow([{}], { theme: url })];
  // The same file, spelt another way, or with a fragment: the same file, so nothing to do.
  shows[0]!.theme = url.replace("/echo/", "/echo/./");
  shows[1]!.theme = `${url}#v1`;
  await waitFor(() => shows.every((s) => box(s).dataset["layout"] === "matted"), "both shows in the shared theme");
  shows.push(makeShow([{}], { theme: url }));
  await waitFor(() => box(shows[2]!).dataset["layout"] === "matted", "a third, later");
  assertEqual(await fetchesOf("shared.json"), 1, "fetched once");
});

test("a theme file that failed is fetched again when it is asked for again", async () => {
  await resetImageLog();
  const url = echo("{}", { path: "retry.json", status: 503 });
  const show = makeShow([{}]);
  await quietly(async (errors) => {
    show.theme = url;
    await waitFor(() => errors.length === 1, "the first failure");
    show.theme = url;
    await waitFor(() => errors.length === 2, "the second");
  });
  assertEqual(await fetchesOf("retry.json"), 2, "fetched each time");
});

test("a 0 without a unit, as a theme may write it, still makes valid CSS", async () => {
  const zero = JSON.stringify({
    format: "clack-theme/1",
    name: "Zero",
    layout: { padding: { inline: { min: "0", ideal: "4cqi", max: "48px" }, top: "0" } },
    caption: { tracking: "0" },
    controls: { size: "0" },
    transition: { duration: "0" },
  });
  const show = makeShow([{}, {}], { theme: echo(zero, { path: "zero.json" }) });
  await waitFor(() => token(show, "control-size") === "0px", "the theme");
  const button = show.shadowRoot!.querySelector("button")!.getBoundingClientRect();
  assert(button.width >= 24 && button.height >= 24, `a control is still at least 24px: ${button.width}×${button.height}`);
  const padding = getComputedStyle(box(show));
  assertEqual(padding.paddingTop, "0px", "the top, 0");
  assert(parseFloat(padding.paddingLeft) > 0 && parseFloat(padding.paddingBottom) > 0, `the rest kept: ${padding.padding}`);
  // (The show's own is the page's: the tests set it short on every show.)
  assertEqual(new Map(compile(readTheme(zero)).properties).get("--clack-transition-duration"), "0s", "no transition");
});

test("a theme file is fetched only once its show is in the page", async () => {
  await resetImageLog();
  const url = echo(JSON.stringify({ format: "clack-theme/1", name: "Later", extends: "mat" }), { path: "later.json" });
  const show = document.createElement("clack-show") as ClackShow;
  show.theme = url;
  await sleep(200);
  assertEqual(await fetchesOf("later.json"), 0, "not while it is out of the page");
  makeShow([{}]).replaceWith(show);
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme, once it is in");
  assertEqual(await fetchesOf("later.json"), 1, "fetched then");
});

test("past 1,000 problems, a theme's earliest 1,000 are kept", () => {
  const many = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${String(i).padStart(4, "0")}`, 1]));
  const problems = problemsOf(() => readTheme(JSON.stringify({ format: "clack-theme/1", name: "N", ...many })));
  assertEqual(problems.length, 1000, "how many");
  assertEqual(problems[0]!.path, "/k0000", "the earliest first");
});

test("a sheet the page adopted into the shadow root outlasts a change of theme", () => {
  const show = makeShow([{}]);
  const mine = new CSSStyleSheet();
  mine.replaceSync(":host { outline: 3px solid rgb(1, 2, 3); }");
  show.shadowRoot!.adoptedStyleSheets = [...show.shadowRoot!.adoptedStyleSheets, mine];
  show.theme = "mat";
  show.theme = "darkroom";
  assert(show.shadowRoot!.adoptedStyleSheets.includes(mine), "the page's sheet is still there");
  assertEqual(getComputedStyle(show).outlineColor, "rgb(1, 2, 3)", "and applied");
  assertEqual(box(show).dataset["layout"], "stage", "with darkroom's");
});

test("a theme that is not one says so only once its show is in the page", async () => {
  await quietly(async (errors) => {
    const show = document.createElement("clack-show") as ClackShow;
    show.theme = "galery";
    await sleep(50);
    assertEqual(errors.length, 0, "nothing said for a show out of the page");
    makeShow([{}]).replaceWith(show);
    assertEqual(errors.length, 1, `said once it is in: ${errors.join(" | ")}`);
  });
});

test("a transition lasts as long as CSS works out the token's time, calc() and all", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing animates in a hidden page");
  const show = makeShow([{}, {}]);
  show.style.setProperty("--clack-transition-duration", "calc(2 * 150ms)");
  await settledOn(show, "1 of 2");
  await sleep(300); // slide 2, preloaded
  const leaving = figures(show)[0]!;
  void show.next();
  await waitFor(() => leaving.getAnimations().length > 0, "the old photo to animate");
  assertEqual(leaving.getAnimations()[0]!.effect!.getTiming().duration, 300, "300ms");
});
