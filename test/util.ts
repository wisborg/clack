// Helpers for the component's tests.
import type { ClackShow } from "../src/clack";
import { tagName } from "../src/clack";
import { assert, fixture, sleep } from "./harness";

let unique = 0;

/**
 * The URL of a made-up image from the test server (tools/internal/browsertest),
 * distinct from every other so no cache can answer for it.
 */
export function img(width: number, height: number, color = "6688aa", delayMs = 0): string {
  const q = `tag=${++unique}${delayMs ? `&delay=${delayMs}` : ""}`;
  return `/img/${width}x${height}-${color}.png?${q}`;
}

export interface Fig {
  width?: number;
  height?: number;
  delay?: number;
  src?: string;
  title?: string;
  credit?: string;
  id?: string;
}

/** A show made from markup, one figure per entry, in the fixture. */
export function makeShow(figs: Fig[], attrs: Record<string, string> = {}): ClackShow {
  const show = document.createElement(tagName);
  for (const [k, v] of Object.entries(attrs)) {
    show.setAttribute(k, v);
  }
  // Quick transitions, so tests do not wait on the crossfade.
  show.style.setProperty("--clack-transition-duration", "40ms");
  show.style.width = "600px";
  for (const [i, f] of figs.entries()) {
    show.append(figure(f, i));
  }
  fixture().append(show);
  return show;
}

export function figure(f: Fig, i = 0): HTMLElement {
  const fig = document.createElement("figure");
  if (f.id) fig.id = f.id;
  const im = document.createElement("img");
  const w = f.width ?? 300;
  const h = f.height ?? 200;
  im.width = w;
  im.height = h;
  im.alt = `photo ${i + 1}`;
  im.loading = "lazy";
  im.src = f.src ?? img(w, h, "6688aa", f.delay ?? 0);
  fig.append(im);
  if (f.title !== undefined || f.credit !== undefined) {
    const cap = document.createElement("figcaption");
    cap.append(f.title ?? "");
    if (f.credit !== undefined) {
      const small = document.createElement("small");
      small.textContent = f.credit;
      cap.append(small);
    }
    fig.append(cap);
  }
  return fig;
}

/** Waits until cond holds, polling; fails with what after timeoutMs. */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(15);
  }
}

/** The figures in the show's stage: the slide on screen, and any fading out. */
export function figures(show: ClackShow): HTMLElement[] {
  return Array.from(show.shadowRoot!.querySelectorAll<HTMLElement>(".slide"));
}

/** The slide on screen once transitions are done: its label, such as "2 of 3". */
export function onScreen(show: ClackShow): string {
  const f = figures(show);
  return f[f.length - 1]?.ariaLabel ?? "";
}

/** Waits for the show to have exactly one slide on screen, its photo (not a placeholder), with that label. */
export async function settledOn(show: ClackShow, label: string): Promise<void> {
  await waitFor(
    () => figures(show).length === 1 && !figures(show)[0]!.classList.contains("placeholder") && onScreen(show) === label,
    `the show to settle on "${label}" (it shows "${onScreen(show)}")`,
  );
}

export function part(show: ClackShow, selector: string): HTMLElement {
  const e = show.shadowRoot!.querySelector<HTMLElement>(selector);
  assert(e, `no ${selector} in the shadow root`);
  return e;
}

export async function imageLog(): Promise<string[]> {
  return (await (await fetch("/img-log")).json()) as string[];
}

export async function resetImageLog(): Promise<void> {
  await fetch("/img-log/reset", { method: "POST" });
}

/** Waits until the image log has an entry for which match holds. */
export async function logged(match: (entry: string) => boolean, what: string, timeoutMs = 2500): Promise<string[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const log = await imageLog();
    if (log.some(match)) {
      return log;
    }
    if (performance.now() > deadline) {
      throw new Error(`${what}: not in the log (${log.join(" ")})`);
    }
    await sleep(50);
  }
}

/** Sets the value at a JSON Pointer (null removes it; "" replaces the document). */
export function setPointer(doc: unknown, pointer: string, value: unknown): unknown {
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

/** A tiny pseudo-random generator, seeded, so a failure can be repeated. */
export function random(seed: number): () => number {
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
export function places(doc: unknown, at = ""): string[] {
  const out = [at];
  if (Array.isArray(doc)) doc.forEach((v, i) => out.push(...places(v, `${at}/${i}`)));
  else if (typeof doc === "object" && doc !== null) {
    for (const [k, v] of Object.entries(doc)) out.push(...places(v, `${at}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  }
  return out;
}

/** A URL on the test server that answers with body, as type. */
export function echo(body: string, o: { path?: string; type?: string; status?: number; delay?: number } = {}): string {
  const q = new URLSearchParams({ body });
  if (o.type) q.set("type", o.type);
  if (o.status) q.set("status", String(o.status));
  if (o.delay) q.set("delay", String(o.delay));
  return `/echo/${o.path ?? "manifest.json"}?${q}`;
}

/**
 * A theme file on the test server, named name, made of these tokens (it
 * extends base unless they say otherwise), at a path of its name:
 * "Other 0" at other-0.json.
 */
export function themed(name: string, tokens: Record<string, unknown> = {}, o: { delay?: number } = {}): string {
  const path = `${name.toLowerCase().replaceAll(" ", "-")}.json`;
  return echo(JSON.stringify({ format: "clack-theme/1", name, ...tokens }), { path, ...o });
}

/** Runs fn with console.error collected rather than shown, and returns what was said. */
export async function quietly(fn: (errors: string[]) => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const quiet = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await fn(errors);
  } finally {
    console.error = quiet;
  }
  return errors;
}

/**
 * A shared case's verdict against what was wanted (the same contract as
 * the tools' comparePlaces, in tools/internal/formats): error is null for a
 * file that must be accepted, else one place or a list of places, and a
 * refused file must have an error at each and nowhere else. Returns what
 * is wrong, or null.
 */
export function comparePlaces(name: string, error: string | readonly string[] | null, got: readonly { path: string; message: string }[]): string | null {
  const want = error === null ? null : typeof error === "string" ? [error] : error;
  const places = new Set(got.map((p) => p.path));
  if (want === null) return got.length > 0 ? `${name}: refused: ${got.map((p) => `${p.path}: ${p.message}`).join("; ")}` : null;
  if (got.length === 0) return `${name}: accepted`;
  if ([...places].some((p) => !want.includes(p)) || want.some((p) => !places.has(p))) {
    return `${name}: errors at ${[...places].join(", ")}, want ${want.join(", ")}`;
  }
  return null;
}

/**
 * A raw shared case's verdict against what was wanted (the tools'
 * checkRaw): accepted or not; if it gives one, every problem at its one
 * place; and if it says why, some problem saying so. Returns what is
 * wrong, if anything.
 */
export function checkRaw(name: string, want: { accepted: boolean; error?: string; why?: string }, got: readonly { path: string; message: string }[]): string[] {
  const out: string[] = [];
  const said = got.map((p) => `${p.path}: ${p.message}`).join("; ");
  if ((got.length === 0) !== want.accepted) out.push(`raw ${name}: accepted ${got.length === 0}, want ${want.accepted} ${said}`);
  if (want.error !== undefined && got.some((p) => p.path !== want.error)) out.push(`raw ${name}: errors at ${got.map((p) => p.path).join(", ")}, want only ${JSON.stringify(want.error)}`);
  if (want.why !== undefined && !got.some((p) => p.message.includes(want.why!))) out.push(`raw ${name}: nothing says ${JSON.stringify(want.why)}: ${said}`);
  return out;
}

/** An element's content box: its size less its padding (and border). */
export function contentBox(e: Element): { width: number; height: number } {
  const r = e.getBoundingClientRect();
  const st = getComputedStyle(e);
  const px = (...names: string[]): number => names.reduce((sum, n) => sum + parseFloat(st.getPropertyValue(n)), 0);
  return {
    width: r.width - px("padding-left", "padding-right", "border-left-width", "border-right-width"),
    height: r.height - px("padding-top", "padding-bottom", "border-top-width", "border-bottom-width"),
  };
}

/** A show's own box, .show in its shadow root, which carries its layout's choices. */
export function showBox(show: ClackShow): HTMLElement {
  return show.shadowRoot!.querySelector<HTMLElement>(".show")!;
}

/** Pointer events on the stage, as a mouse, pen or finger would send them. */
export function pointer(show: ClackShow) {
  const stage = part(show, ".stage");
  const r = stage.getBoundingClientRect();
  const y = r.top + r.height / 2;
  return {
    stage,
    left: r.left,
    width: r.width,
    send(type: string, x: number, init: PointerEventInit = {}): void {
      stage.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, ...init }),
      );
    },
    swipe(from: number, to: number): void {
      this.send("pointerdown", from);
      for (let i = 1; i <= 8; i++) {
        this.send("pointermove", from + ((to - from) * i) / 8);
      }
      this.send("pointerup", to, { buttons: 0 });
    },
  };
}

/**
 * Has show go as it does for a visitor who asked for reduced motion: its
 * stylesheet with the reduced-motion block applied whatever the setting,
 * which WebDriver cannot set. Everything Clack does for reduced motion is
 * in that block -- the transition too, which it reads from there (.probe)
 * -- so this is all of it. Returns how to put the stylesheet back.
 */
export function reduceMotion(show: ClackShow): () => void {
  const root = show.shadowRoot!;
  const reducing = (r: CSSRule): r is CSSMediaRule => r instanceof CSSMediaRule && r.media.mediaText.includes("prefers-reduced-motion");
  const clack = root.adoptedStyleSheets.find((s) => Array.from(s.cssRules).some(reducing));
  assert(clack, "Clack's stylesheet has a reduced-motion block");
  const reduced = new CSSStyleSheet();
  reduced.replaceSync(Array.from(clack.cssRules, (r) => (reducing(r) ? Array.from(r.cssRules, (i) => i.cssText).join("\n") : r.cssText)).join("\n"));
  const saved = [...root.adoptedStyleSheets];
  root.adoptedStyleSheets = saved.map((s) => (s === clack ? reduced : s));
  return () => {
    root.adoptedStyleSheets = saved;
  };
}

/**
 * A show of two photos whose theme (called name) slides for 600ms, ready
 * to step: the theme taken up, the first photo settled, the next
 * preloaded. page, if given, is done to the show before any of it -- a
 * page's own style, say.
 */
export async function slidingShow(name: string, page?: (show: ClackShow) => void): Promise<ClackShow> {
  const show = makeShow([{}, {}], { theme: themed(name, { transition: { type: "slide", duration: "600ms" } }) });
  page?.(show);
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 2");
  await sleep(200); // the next preloaded
  return show;
}
