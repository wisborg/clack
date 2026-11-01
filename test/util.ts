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

/** Waits for the show to have exactly one slide on screen, with that label. */
export async function settledOn(show: ClackShow, label: string): Promise<void> {
  await waitFor(() => figures(show).length === 1 && onScreen(show) === label, `the show to settle on "${label}" (it shows "${onScreen(show)}")`);
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
