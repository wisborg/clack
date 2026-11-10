/**
 * `<clack-show>`: the slideshow element.
 *
 * It reads its slides from its own markup (or is given them from script),
 * shows one at a time in its shadow root, and moves between them with its
 * controls, the keyboard, or a swipe. The next photo is always fetched and
 * decoded before it is shown; until then the current one stays, and the
 * counter already says where the visitor is going.
 */
import css from "./clack.css";
import { icon } from "./icons";
import { photoKey, Photos, type Photo } from "./images";
import { canStep, drawnWidth, preloadOrder, step } from "./nav";
import { load, type Manifest } from "./manifest";
import { reportFailure } from "./json";
import { readThumbHash } from "./rules";
import { applyLang, fromInput, readMarkup, resolveHTTP, type Keyed, type Slide, type SlideInput } from "./slides";
import { listen, type Swipes } from "./swipe";
import { builtinNames, builtinTheme, compile, isBuiltin, loadTheme, type Compiled } from "./theme";
import { draw } from "./thumbhash";

export const tagName = "clack-show";

/** The words Clack says. English for now; they will be translatable. */
const text = {
  show: "Photos",
  carousel: "carousel",
  slide: "slide",
  previous: "Previous photo",
  next: "Next photo",
  of: (n: number, count: number) => `${n} of ${count}`,
  // What is said when the visitor moves to a slide, around its title (the
  // title goes between the two parts), or without one.
  announceTitled: (n: number, count: number): [string, string] => [`Photo ${n} of ${count}: `, ""],
  announce: (n: number, count: number) => `Photo ${n} of ${count}`,
  failed: "This photo could not be loaded.",
  photos: (count: number) => (count === 1 ? "1 photo" : `${count} photos`),
  noManifest: "The photos could not be loaded.",
};

/** What has become of the manifest src names (see ClackShow.#manifest). */
type ManifestState =
  | { state: "none" }
  | { state: "loading"; abort: AbortController }
  | { state: "loaded"; manifest: Manifest }
  | { state: "failed" };

/**
 * What src names: none, an http(s) URL resolved against the page, or text
 * that is not one (to fail, once, like any other). Like every URL Clack
 * uses, it must be http or https: a blob: or data: manifest has no address
 * to resolve its own relative URLs against.
 */
type Src = { url: string } | { bad: string } | null;

function resolveSrc(src: string | null): Src {
  if (!src) return null;
  const r = resolveHTTP(src, document.baseURI);
  return typeof r === "string" ? { url: r } : { bad: src };
}

/** Where the slides on screen came from (see ClackShow.#showing). */
type Showing =
  | { from: "none" }
  | { from: "markup" }
  | { from: "manifest"; manifest: Manifest }
  | { from: "script"; slides: Keyed[] };

const sameSrc = (a: Src, b: Src): boolean =>
  a === b || (a !== null && b !== null && ("url" in a ? "url" in b && a.url === b.url : "bad" in b && a.bad === b.bad));

/** What `slidechange` says. */
export interface SlideChangeDetail {
  index: number;
  id: string;
  previous: number;
}

/** How a slide came to be asked for, which decides how it arrives. */
interface How {
  /** By the visitor, through Clack's controls, keys or a swipe: announced. */
  user: boolean;
  /**
   * A committed swipe: the way the finger went on screen (-1 left, 1
   * right), which the old photo carries on in, and the drag offset it left
   * that photo at.
   */
  swipe?: { exit: -1 | 1; offset: number };
}

// One stylesheet, shared by every instance in the document.
let sheet: CSSStyleSheet | undefined;

function styles(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  return sheet;
}

/**
 * Every theme's stylesheet, so a show can tell them from the page's own:
 * a page that saved the shadow root's sheets and puts them back, an old
 * theme's among them, must not have that theme's outlast every later one.
 */
const themeSheets = new WeakSet<CSSStyleSheet>();

/**
 * A compiled theme as a stylesheet of its own: one rule for :host, its
 * properties set one at a time through the CSS object model, so each value
 * is only ever a value. One for each show, not shared: the shadow root is
 * open, and a page that changes one show's sheet changes only that show.
 */
function themeSheet({ properties }: Compiled): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  themeSheets.add(sheet);
  sheet.replaceSync(":host {}");
  const style = (sheet.cssRules[0] as CSSStyleRule).style;
  for (const [name, value] of properties) style.setProperty(name, value);
  return sheet;
}

/**
 * An element's content box as laid out, in CSS pixels, untouched by any
 * transform: from its computed style, less any padding and border a page
 * may give it (the stage is a part) where its box sizing counts them in.
 * Nothing, out of the page or hidden.
 */
function laidOut(e: Element): { width: number; height: number } {
  const style = getComputedStyle(e);
  const px = (...names: string[]): number => names.reduce((sum, n) => sum + (parseFloat(style.getPropertyValue(n)) || 0), 0);
  const inner = style.boxSizing === "border-box";
  const width = (parseFloat(style.width) || 0) - (inner ? px("padding-left", "padding-right", "border-left-width", "border-right-width") : 0);
  const height = (parseFloat(style.height) || 0) - (inner ? px("padding-top", "padding-bottom", "border-top-width", "border-bottom-width") : 0);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/** Where the photos are drawn: the stage's size, and what the mount takes around a photo, each side. */
interface Geometry {
  stage: { width: number; height: number };
  /** The mount's mat and frame, each side, in px; 0 but in the matted layout. */
  mat: number;
  frame: number;
}

/** Content in the mount, which in the matted layout frames it (see clack.css). */
function mount(content: Element): HTMLElement {
  const m = el("div", "mount");
  m.append(content);
  return m;
}

/** Where a show's theme is (#theme). */
type ThemeState = { is: "shown" } | { is: "to-fetch"; url: string } | { is: "fetching" } | { is: "to-say"; error: unknown } | { is: "failed" };

/** A theme file asked for: on its way, or here (or failed, and soon forgotten). */
interface ThemeFile {
  compiled: Promise<Compiled>;
  /** It, once it has arrived: to be taken up at once, not a turn later. */
  value: Compiled | null;
  settled: boolean;
  /** Gives it the whole time to arrive again, from now: someone has asked for it now. */
  wait(): void;
}

/**
 * The theme files asked for, by URL, so a file is fetched once however
 * many shows ask for it -- and forgotten if it fails, so asking again
 * fetches it again. Of those that have arrived, only the last few asked
 * for are kept: a page that previews many themes, or a new version of one
 * at a new URL, does not collect them all; one on its way is kept until it
 * arrives. A fetch is not cancelled when a show stops wanting it: another
 * may want it still, and a theme file is small.
 */
const themeFiles = new Map<string, ThemeFile>();
const themeFilesKept = 8;
/**
 * How long a theme file may take to arrive, in ms, from the last time it
 * was asked for: far more than a few kilobytes ever need. A server that
 * never answers fails it in the end, so it can be asked for again.
 */
const themeFileTimeout = 30_000;

function themeFile(url: string): ThemeFile {
  let file = themeFiles.get(url);
  if (file) {
    themeFiles.delete(url); // to the end: asked for last
  } else {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const compiled = loadTheme(url, controller.signal).then(compile);
    const f: ThemeFile = {
      compiled,
      value: null,
      settled: false,
      wait() {
        if (f.settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException(`no answer in ${themeFileTimeout / 1000} seconds`, "TimeoutError")), themeFileTimeout);
      },
    };
    const settle = (): void => {
      f.settled = true;
      clearTimeout(timer);
      keepFewThemeFiles();
    };
    compiled.then((value) => {
      f.value = value;
      settle();
    }, () => {
      if (themeFiles.get(url) === f) themeFiles.delete(url);
      settle();
    });
    file = f;
  }
  file.wait();
  themeFiles.set(url, file);
  keepFewThemeFiles();
  return file;
}

/** Forgets the theme files that have arrived but were asked for longest ago, past themeFilesKept of them. */
function keepFewThemeFiles(): void {
  let here = 0;
  for (const f of themeFiles.values()) if (f.settled) here++;
  for (const [url, f] of themeFiles) {
    if (here <= themeFilesKept) break;
    if (!f.settled) continue;
    themeFiles.delete(url);
    here--;
  }
}

// The built-in themes, each compiled once.
const builtinThemes = new Map<string, Compiled>();

function builtinCompiled(name: string): Compiled {
  let compiled = builtinThemes.get(name);
  if (!compiled) {
    compiled = compile(builtinTheme(name));
    builtinThemes.set(name, compiled);
  }
  return compiled;
}

/**
 * The transition's length in ms, from the theme's as CSS computes it (NaN
 * when it is not a time): 700 if it is not one, or is less than none; at
 * most 200 when motion is reduced, and never more than 3 s.
 */
export function crossfade(ms: number, reduced: boolean): number {
  const given = ms >= 0 ? ms : 700;
  return Math.min(given, reduced ? 200 : 3000);
}

/**
 * The transition a theme asks for (transition.type, and its duration in
 * ms as CSS computes it: see crossfade), as it is played: none for none,
 * or none long; and with reduced motion, nothing slides -- a short
 * crossfade instead.
 */
export function transitionOf(type: string, ms: number, reduced: boolean): { type: "crossfade" | "slide"; ms: number } | null {
  const length = crossfade(ms, reduced);
  if (type === "none" || length <= 0) return null;
  return { type: type === "slide" && !reduced ? "slide" : "crossfade", ms: length };
}

/** How long controls shown for the visitor's activity stay once it stops, in ms. */
const revealFor = 3000;

/**
 * How one photo gives way to the next: the keyframes of the one coming in
 * and the one going out. exit is the way the one going out leaves on
 * screen (-1 to the left); offset, where a swipe let go of it, if one did.
 * A crossfade fades one into the other (a swiped photo carrying on a
 * little the way the finger went); a slide moves both along by a whole
 * stage, the next coming in from the side the last leaves by.
 */
export function transitionFrames(type: "crossfade" | "slide", exit: -1 | 1, offset: number | null): { incoming: Keyframe[]; outgoing: Keyframe[] } {
  const from = `translateX(${offset ?? 0}px)`;
  if (type === "slide") {
    // The next starts beside the last, where a swipe let go of it.
    const beside = offset ? `translateX(calc(${offset}px + ${-exit * 100}%))` : `translateX(${-exit * 100}%)`;
    return {
      incoming: [{ transform: beside }, { transform: "translateX(0)" }],
      outgoing: [{ transform: from }, { transform: `translateX(${exit * 100}%)` }],
    };
  }
  return {
    incoming: [{ opacity: 0 }, { opacity: 1 }],
    outgoing:
      offset === null
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { opacity: 1, transform: from },
            { opacity: 0, transform: `translateX(${exit * 12}%)` },
          ],
  };
}

function el<K extends keyof HTMLElementTagNameMap>(name: K, className: string, part = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(name);
  e.className = className;
  if (part) e.setAttribute("part", part);
  return e;
}

/**
 * A canvas painted with what a ThumbHash draws: a few pixels a side, which
 * the stylesheet stretches over the photo's place, the browser's smoothing
 * finishing the blur. Null if the hash is not one (it was checked when the
 * slide was read) or the canvas cannot be drawn on.
 */
function impression(hash: string): HTMLCanvasElement | null {
  const t = readThumbHash(hash);
  if (!t) return null;
  const { width, height, rgba } = draw(t);
  const canvas = el("canvas", "impression");
  // A picture of what is coming, which the figure's label already names.
  canvas.ariaHidden = "true";
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

/** A transition in progress, and what must happen when it ends, however it ends. */
interface Running {
  animations: Animation[];
  done: () => void;
}

/** The `<clack-show>` element. */
export class ClackShow extends HTMLElement {
  static readonly observedAttributes = ["loop", "fit", "label", "src", "theme"];

  readonly #internals: ElementInternals;
  /**
   * The manifest's title, hidden, in its language: what names the show
   * when it does (see #name). Not the header's title, which is the same
   * words, but styled: in a theme's capitals, a screen reader may spell
   * the name out.
   */
  readonly #nameBox: HTMLSpanElement;
  readonly #stage: HTMLDivElement;
  readonly #notice: HTMLParagraphElement;
  readonly #title: HTMLSpanElement;
  readonly #credit: HTMLSpanElement;
  readonly #counter: HTMLSpanElement;
  readonly #previous: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #live: HTMLDivElement;
  /** Unseen, and no part: where what the theme's tokens come to is read (#measure, #transition). */
  readonly #probe: HTMLDivElement;
  /** The line above the stage, and its two parts: the show's title, and how many photos it has. */
  readonly #header: HTMLDivElement;
  readonly #headerTitle: HTMLSpanElement;
  readonly #headerCount: HTMLSpanElement;
  /** The manifest's language, for its title in the header. */
  #showLang: string | null = null;
  /**
   * The theme's stylesheet, adopted now: held, so that it is known again.
   * Safari may let go of a sheet's script object that only a WeakSet holds
   * -- the sheet itself living on, adopted -- and make a new one, which
   * themeSheets does not know: the old theme's sheet would then be kept as
   * one of the page's, after Clack's, and outlast the next theme.
   */
  #sheet: CSSStyleSheet | null = null;
  /** The show's outermost box, which carries the theme's layout choices. */
  readonly #box: HTMLDivElement;
  /**
   * The theme asked for (a built-in's name, or a theme file's URL,
   * resolved), and where it is: shown; a file to fetch once the show is in
   * the page, or on its way; or failed -- said, or to be said once the
   * show is in the page. Asking for one that failed again is a retry.
   */
  #theme: { asked: string; state: ThemeState } = { asked: "", state: { is: "shown" } };

  #slides: Keyed[] = [];
  readonly #indexById = new Map<string, number>();
  readonly #indexByKey = new Map<string, number>();
  /** Slides given from script, shown in place of the manifest's or the markup's while set. */
  #script: Keyed[] | null = null;
  /** The manifest's title, which names the show when the page has not. */
  #showTitle = "";
  /** The warnings of the last reading of the markup: one is given again only if it went away and came back. */
  #warnings = new Set<string>();
  /**
   * The manifest src names, resolved when src is set -- so a relative src
   * keeps meaning what it meant then, whatever the page's address becomes.
   */
  #src: Src = null;
  /**
   * Set from connectedCallback, once what the page set before Clack loaded
   * has been taken up, until disconnectedCallback. When Clack loads after
   * the page, the src attribute's callback comes first, already connected:
   * the show must not fetch or draw anything before it knows whether the
   * page gave slides of its own.
   */
  #ready = false;
  /**
   * What has become of the manifest #src names, in one state: a src set
   * again, or changed, starts it afresh (#dropManifest); nothing else does
   * -- not a move, not slides from script withdrawn.
   */
  #manifest: ManifestState = { state: "none" };
  /**
   * Where the slides on screen came from -- nothing yet, the markup, or
   * which manifest or which slides from script -- in one field, so what is
   * shown is never said twice.
   */
  #showing: Showing = { from: "none" };
  /** An error event owed to the page: the manifest failed while the show was out of it. */
  #owedError = false;
  /** The timer that gives the notice its words (see #noticeOn). */
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #photos = new Photos();
  /** The slide asked for, which may still be loading. */
  #target = -1;
  /** The slide on screen, or -1 before the first is. */
  #shown = -1;
  #figure: HTMLElement | null = null;
  /** The hash whose impression the placeholder holds, or "" for none. */
  #painted = "";
  #direction: 1 | -1 = 1;
  /** Bumped by every request, so a slow photo cannot arrive after a newer one. */
  #token = 0;
  #pending: Promise<boolean> | null = null;
  #running: Running[] = [];
  /** The mount's sizes as last given to the CSS, so that they are given only when they change. */
  #mountCSS = "";
  /** Where the photos were drawn when the show was last laid out: what a hidden show's photos are asked for at. */
  #lastGeometry: Geometry | null = null;

  #swipes: Swipes | null = null;
  /** Stops listening for the screen's pixel ratio to change (#watchRatio). */
  #unwatchRatio: (() => void) | null = null;
  /** Hides controls shown for the visitor's activity once it stops (#onActivity). */
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** When the visitor was last active here, and with what kind of pointer, if one. */
  #lastActivity = 0;
  #lastPointer = "";
  /** Where the photo was, springing back, when a drag caught it again: where the drag starts from. */
  #caught = 0;
  /** The photo springing back after a drag that went nowhere, while it does. */
  #springing: Animation | null = null;
  /**
   * The stage and the probe: either changing size changes where the
   * photos are drawn -- the probe only in the matted layout.
   */
  readonly #resize = new ResizeObserver((entries) => {
    if (this.#box.dataset["layout"] !== "matted" && entries.every((e) => e.target !== this.#stage)) return;
    this.#relayout();
  });
  // Changes to the markup re-read the slides; the host's own attributes
  // (loop, fit, label) are not slides, and have their own callback.
  readonly #mutations = new MutationObserver((records) => {
    if (records.some((r) => r.type !== "attributes" || r.target !== this)) {
      this.#readMarkup();
    }
  });

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.#internals.role = "region";
    this.#internals.ariaRoleDescription = text.carousel;
    this.#internals.ariaLabel = text.show;

    const root = this.attachShadow({ mode: "open" });
    const show = el("div", "show", "show");
    this.#box = show;
    this.#look(builtinCompiled("base"));
    // Focusable by a click (not by Tab), so the keys work after clicking
    // the photo; the controls are what Tab reaches.
    this.#stage = el("div", "stage", "stage");
    this.#stage.tabIndex = -1;
    // Says so when the manifest could not be had; a polite status, read once.
    this.#notice = el("p", "notice", "notice");
    this.#notice.role = "status";
    this.#noticeOff();
    this.#stage.append(this.#notice);

    const below = el("div", "below", "below");
    const caption = el("p", "caption", "caption");
    this.#title = el("span", "title");
    this.#credit = el("span", "credit");
    caption.append(this.#title, this.#credit);

    const controls = el("div", "controls", "controls");
    this.#previous = this.#button(text.previous, "previous", () => this.#user(-1));
    this.#next = this.#button(text.next, "next", () => this.#user(1));
    this.#counter = el("span", "counter", "counter");
    // The counter is for the eye; the slide's own label and the live region
    // say the same to a screen reader.
    this.#counter.ariaHidden = "true";
    controls.append(this.#previous, this.#counter, this.#next);
    below.append(caption, controls);

    this.#live = el("div", "live");
    this.#live.ariaLive = "polite";
    this.#live.ariaAtomic = "true";

    // Not a <header>, which would be a landmark of the page's.
    this.#header = el("div", "header", "header");
    this.#headerTitle = el("span", "header-title");
    this.#headerCount = el("span", "header-count");
    this.#header.append(this.#headerTitle, this.#headerCount);
    this.#header.hidden = true;
    // Hidden from screen readers: its title is the show's name already,
    // and the slides say where the visitor is, of how many.
    this.#header.ariaHidden = "true";

    // After the stage, though drawn above it (clack.css): so it is painted
    // over a shadow the stage casts, with no z-index of its own.
    show.append(this.#stage, below, this.#header);
    this.#probe = el("div", "probe");
    this.#nameBox = el("span", "name");
    this.#nameBox.hidden = true;
    // In a box of no size that clips it, so that however large the
    // theme's mat, the probe never adds to what the page can scroll.
    const probes = el("div", "probes");
    probes.append(this.#probe);
    root.append(show, this.#live, this.#nameBox, probes);

    this.addEventListener("keydown", (e) => this.#onKey(e));
    for (const type of ["pointermove", "pointerdown", "keydown", "focusin"] as const) {
      this.addEventListener(type, this.#onActivity, { passive: true });
    }
  }

  #button(label: string, name: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", name, `button ${name}`);
    b.type = "button";
    b.ariaLabel = label;
    b.append(icon(name === "previous" ? "chevron-left" : "chevron-right"));
    b.addEventListener("click", () => {
      if (b.ariaDisabled !== "true") onClick();
    });
    return b;
  }

  /**
   * A page hidden in the middle of a fade may not run it on (Safari stops
   * animations in a hidden page): it is finished at once, so the old slide
   * is not left behind until the page is shown again.
   */
  readonly #onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.#finishTransitions();
  };

  connectedCallback(): void {
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#resize.observe(this.#stage);
    this.#resize.observe(this.#probe);
    this.#watchRatio();
    this.#swipes = listen(this.#stage, {
      move: (dx) => this.#drag(dx),
      end: (outcome) => this.#swiped(outcome),
    });
    // A page may set a property before Clack is loaded: the value then sits
    // on the element itself, hiding the class's accessor, and is moved
    // through the accessor now. A value the setter refuses is reported, as
    // it would have been had Clack been there, and the show carries on.
    const own = this as unknown as Record<string, unknown>;
    const replay = (name: string): void => {
      if (Object.hasOwn(this, name)) {
        const value = own[name];
        delete own[name];
        try {
          own[name] = value;
        } catch (e) {
          reportError(e);
        }
      }
    };
    // The theme first, before slides from script may ask for a photo: so
    // the first is asked for at the size it is drawn at in it, mount and
    // all.
    for (const name of ["theme", "src", "slides", "loop"]) replay(name);
    // The markup is read again on a reconnect, in case it changed while
    // the show was out of the page and not watching it.
    if (this.#showing.from === "markup") this.#showing = { from: "none" };
    this.#ready = true;
    this.#takeUpTheme();
    this.#render();
  }

  disconnectedCallback(): void {
    this.#ready = false;
    // The visitor's activity, here, is over.
    clearTimeout(this.#idle);
    this.#idle = undefined;
    this.#box.classList.remove("active");
    // A drag the visitor was in the middle of ends here: its end will not
    // be heard.
    this.#endDrag();
    document.removeEventListener("visibilitychange", this.#onVisibility);
    // A manifest on its way is not dropped: there is no telling a move --
    // however long it takes -- from a removal, and a show that is moved must
    // not download it again. What becomes of it is shown when the show is
    // back (#render does nothing out of the page); a show removed for good
    // downloads it once, and is collected with it.
    this.#resize.disconnect();
    this.#unwatchRatio?.();
    this.#unwatchRatio = null;
    this.#mutations.disconnect();
    this.#swipes?.stop();
    this.#swipes = null;
    this.#finishTransitions();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    switch (name) {
      case "label":
        this.#name();
        break;
      case "src": {
        const src = resolveSrc(value);
        // The same src again does nothing -- unless what it names failed:
        // setting src again is how a page retries.
        if (sameSrc(src, this.#src) && this.#manifest.state !== "failed") break;
        this.#src = src;
        this.#dropManifest();
        this.#render();
        break;
      }
      case "loop":
        this.#updateControls();
        break;
      case "fit":
        this.#relayout();
        break;
      case "theme":
        this.#setTheme(value ?? "");
        break;
    }
  }

  // ---- The public interface -------------------------------------------

  /**
   * The slides, as Clack reads them. They can be given back, changed or
   * not, to the setter.
   */
  get slides(): readonly Readonly<Slide>[] {
    return this.#slides.map((s) => ({ ...s, alternatives: s.alternatives.map((a) => ({ ...a })) }));
  }

  /**
   * Gives the show its slides from script, in place of its manifest's or
   * markup's: in the manifest's slide format, or in Clack's own (as the
   * getter returns them). Throws a TypeError naming the slide and the
   * problem if one cannot be shown. null goes back to the manifest or the
   * markup, at once.
   */
  set slides(input: readonly (SlideInput | Slide)[] | null) {
    this.#script = input === null ? null : fromInput(input);
    this.#render();
  }

  /** The slide being shown, or about to be: its photo may still be loading. */
  get index(): number {
    return this.#target;
  }

  get count(): number {
    return this.#slides.length;
  }

  /** The src attribute: the manifest to show, or "" for the markup. */
  get src(): string {
    return this.getAttribute("src") ?? "";
  }

  set src(url: string) {
    this.setAttribute("src", url);
  }

  /** The theme: a built-in theme's name, or the URL of a theme file; "" for base. */
  get theme(): string {
    return this.getAttribute("theme") ?? "";
  }

  set theme(value: string) {
    this.setAttribute("theme", value);
  }

  get loop(): boolean {
    return this.hasAttribute("loop");
  }

  set loop(on: boolean) {
    this.toggleAttribute("loop", on);
  }

  /** Goes to the next slide. The promise says whether it was shown (false if another was asked for first). */
  next(): Promise<boolean> {
    return this.#go(1, { user: false });
  }

  /** Goes to the previous slide. */
  previous(): Promise<boolean> {
    return this.#go(-1, { user: false });
  }

  /** Goes to a slide by its index or its id. */
  goTo(slide: number | string): Promise<boolean> {
    const index = typeof slide === "number" ? slide : (this.#indexById.get(slide) ?? -1);
    if (!Number.isInteger(index) || index < 0 || index >= this.#slides.length) {
      return Promise.reject(new RangeError(`Clack: there is no slide ${JSON.stringify(slide)}`));
    }
    return this.#request(index, { user: false });
  }

  // ---- Slides ----------------------------------------------------------

  #readMarkup(): void {
    // A warning is given when it first appears, and again only if it went
    // away and came back -- not at every reading of the same markup.
    const now = new Set<string>();
    const slides = readMarkup(this, (m) => {
      now.add(m);
      if (!this.#warnings.has(m)) console.warn(`Clack: ${m}`);
    });
    this.#warnings = now;
    this.#setSlides(slides);
  }

  /**
   * Shows what should be shown now, from the state of things -- slides
   * from script, else the manifest's state, else the markup -- and starts
   * fetching the manifest src names, if it is not on its way. Every change
   * comes through here, at once, so whatever order they come in there is
   * one decision, and at most one fetch for a src. Out of the page, nothing
   * is done until the show is back.
   *
   * While a manifest loads, what is shown stays -- a previous manifest's
   * slides -- or else the markup's are shown, followed as the markup
   * changes: at first, and when slides from script are withdrawn. A manifest that cannot be had brings back the
   * markup's slides, says so, and fires error -- after the show has drawn
   * itself, so a page that answers by giving slides of its own keeps them.
   */
  #render(): void {
    // Slides from script are the page's own, and shown at once, even out
    // of the page (as before Clack has loaded): they need no fetch.
    if (this.#script) {
      const script = this.#script;
      if (this.#showing.from !== "script" || this.#showing.slides !== script) {
        // A manifest on its way is dropped, and fetched again if these
        // slides are withdrawn; one already loaded is kept, to come back to.
        if (this.#manifest.state === "loading") this.#dropManifest();
        this.#showing = { from: "script", slides: script };
        this.#noticeOff();
        this.#mutations.disconnect();
        this.#setTitle("", null);
        this.#setSlides(script);
      }
      return;
    }
    if (!this.#ready) return;
    if (this.#src && this.#manifest.state === "none") this.#startLoad(this.#src);
    const m = this.#manifest;
    const shown = this.#showing;
    switch (m.state) {
      case "loaded":
        this.#noticeOff();
        if (shown.from !== "manifest" || shown.manifest !== m.manifest) this.#showManifest(m.manifest);
        break;
      case "failed":
        if (shown.from !== "markup") this.#markup();
        this.#noticeOn();
        break;
      case "loading":
        this.#noticeOff();
        // What is shown stays -- unless it is slides from script, just
        // withdrawn: then the markup, until the manifest arrives.
        if (shown.from === "none" || shown.from === "script") this.#markup();
        break;
      case "none":
        this.#noticeOff();
        if (shown.from !== "markup") this.#markup();
        break;
    }
    if (this.#owedError) {
      this.#owedError = false;
      this.dispatchEvent(new Event("error"));
    }
  }

  /**
   * Starts fetching the manifest src names. A src that is not a URL fails
   * the same way a fetch does -- a moment later, not within the call that
   * set it -- so a page can listen for error after setting it, and a page
   * that retries from its handler does not call itself without end.
   */
  #startLoad(src: NonNullable<Src>): void {
    const abort = new AbortController();
    this.#manifest = { state: "loading", abort };
    const loading = "url" in src ? load(src.url, abort.signal) : Promise.reject(new Error("Clack: src is not a URL"));
    const name = "url" in src ? src.url : src.bad;
    loading.then(
      (manifest) => {
        if (abort.signal.aborted) return;
        this.#manifest = { state: "loaded", manifest };
        this.#render();
      },
      // Every failure is acted on a task later, however it came: some come
      // at once (not a URL; a URL fetch() will not take, with a user name
      // in it), and a page that retries from its error handler would then
      // loop through microtasks for ever, and never draw again.
      (e: unknown) =>
        setTimeout(() => {
          if (abort.signal.aborted) return;
          this.#failed(name, e);
          this.#render();
        }, 0),
    );
  }

  /**
   * The manifest could not be had: said to the console, with every
   * problem by its place; the markup and a notice follow when the show
   * renders, and the page's error event after that.
   */
  #failed(url: string, e: unknown): void {
    reportFailure("manifest", url, e, "");
    this.#manifest = { state: "failed" };
    this.#owedError = true;
  }

  /** Stops the manifest on its way, if any, and forgets what became of the last: src is to be read afresh. */
  #dropManifest(): void {
    if (this.#manifest.state === "loading") this.#manifest.abort.abort();
    this.#manifest = { state: "none" };
    // An error owed for a manifest dropped is not owed any more.
    this.#owedError = false;
  }

  // ---- The theme ---------------------------------------------------------

  /**
   * Takes up the theme asked for: a built-in at once, by its name; a theme
   * file once it has been fetched and checked, the show keeping the theme
   * it has until then -- and keeping it, if the file cannot be had or is
   * refused, which is said to the console. A value with no dot, slash or
   * colon is a name, and one that is not a built-in's is not fetched as a
   * file: it is a misspelt name far more often than a file without a dot.
   * The same theme asked for again
   * -- the same name, or a URL that resolves the same, against the page's
   * address now -- does nothing, unless it failed: asking again is how a
   * page retries.
   */
  #setTheme(value: string): void {
    const given = value.trim() || "base";
    // A name, unless it has what only a URL has: a dot, a slash or a colon.
    // A URL is one file whatever its fragment says.
    const resolved = isBuiltin(given) || !/[./:]/.test(given) ? null : resolveHTTP(given, document.baseURI);
    const url = typeof resolved === "string" ? resolved.replace(/#.*$/s, "") : resolved;
    const asked = typeof url === "string" ? url : given;
    const was = this.#theme.state.is;
    if (asked === this.#theme.asked && was !== "failed" && was !== "to-say") return;
    if (isBuiltin(asked)) {
      this.#theme = { asked, state: { is: "shown" } };
      this.#look(builtinCompiled(asked));
      return;
    }
    const state: ThemeState =
      url === null
        ? { is: "to-say", error: new Error(`it is not a built-in theme (they are ${builtinNames.join(", ")}), nor a URL`) }
        : typeof url === "string"
          ? { is: "to-fetch", url }
          : { is: "to-say", error: new Error(`it is not an http(s) URL (${url.problem})`) };
    this.#theme = { asked, state };
    this.#takeUpTheme();
  }

  /**
   * Fetches the theme file asked for, or says why there is none to fetch --
   * only once the show is in the page, as for its manifest: a show made and
   * never shown asks for nothing, and says nothing.
   */
  #takeUpTheme(): void {
    const theme = this.#theme;
    const state = theme.state;
    // A file already here is taken up at once, as a built-in is, in the
    // page or not -- it asks for nothing -- and so before any photo is
    // asked for in the theme before it.
    const here = state.is === "to-fetch" ? themeFiles.get(state.url)?.value : null;
    if (here && state.is === "to-fetch") {
      themeFile(state.url); // asked for last, so kept
      theme.state = { is: "shown" };
      this.#look(here);
      return;
    }
    if (!this.#ready) return;
    if (state.is === "to-say") {
      // Said, the show keeping the theme it has.
      theme.state = { is: "failed" };
      reportFailure("theme", theme.asked, state.error, "; the show keeps the theme it had");
      return;
    }
    if (state.is !== "to-fetch") return;
    theme.state = { is: "fetching" };
    const file = themeFile(state.url);
    file.compiled.then(
      (compiled) => {
        if (this.#theme !== theme) return;
        theme.state = { is: "shown" };
        this.#look(compiled);
      },
      (error: unknown) => {
        if (this.#theme !== theme) return;
        // Said now -- or once the show is back in the page, if it left
        // meanwhile.
        theme.state = { is: "to-say", error };
        this.#takeUpTheme();
      },
    );
  }

  /**
   * Shows the show in a theme: a stylesheet of its own before Clack's, which no
   * theme can override, and its choices on the show's box. Any sheet the
   * page has adopted into the shadow root itself is kept, after Clack's.
   */
  #look(compiled: Compiled): void {
    const root = this.shadowRoot!;
    const pages = root.adoptedStyleSheets.filter((s) => !themeSheets.has(s) && s !== styles());
    this.#sheet = themeSheet(compiled);
    root.adoptedStyleSheets = [this.#sheet, styles(), ...pages];
    const { choices } = compiled;
    for (const [name, value] of Object.entries(choices)) this.#box.dataset[name] = value;
    // Its own air, its own mat, perhaps a mount where there was none.
    this.#relayout();
  }

  #showManifest(m: Manifest): void {
    this.#showing = { from: "manifest", manifest: m };
    this.#mutations.disconnect();
    // The title first, so the slides' photos are asked for with the
    // header it brings (see #name).
    this.#setTitle(m.title, m.lang);
    this.#setSlides(m.slides);
  }

  /** The markup's slides, followed as the markup changes. */
  #markup(): void {
    this.#showing = { from: "markup" };
    this.#setTitle("", null);
    this.#mutations.observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
    this.#readMarkup();
  }

  /**
   * Shows the notice that the manifest could not be had, if it is not up
   * already: shown first and given its words a moment later, since a
   * status that appears with its text already in it is not reliably read
   * out.
   */
  #noticeOn(): void {
    if (!this.#notice.hidden) return;
    // Unseen (but read) while it is empty, so no blank box shows. The
    // words come a moment later -- from this showing's own timer, not one
    // left from an earlier failure, which would fill it at once.
    clearTimeout(this.#noticeTimer);
    this.#notice.textContent = "";
    this.#notice.classList.add("empty");
    this.#notice.hidden = false;
    this.#noticeTimer = setTimeout(() => {
      if (this.#notice.hidden) return;
      this.#notice.textContent = text.noManifest;
      this.#notice.classList.remove("empty");
    }, 100);
  }

  /** Hides the notice, and the words it was about to be given. */
  #noticeOff(): void {
    clearTimeout(this.#noticeTimer);
    this.#notice.hidden = true;
  }

  /**
   * The manifest's title names the show if the page has not, read in the
   * manifest's language: the show is labelled by a hidden element of its
   * own that carries it, where the engine supports labelling by element
   * from ElementInternals; otherwise by the text alone. (The slides' own
   * language goes with each slide -- see Keyed.lang.) A title of nothing
   * but spaces is none.
   */
  #setTitle(title: string, lang: string | null): void {
    this.#showTitle = title.trim() ? title : "";
    this.#showLang = lang;
    this.#nameBox.textContent = this.#showTitle;
    applyLang(this.#nameBox, lang);
    this.#name();
  }

  /**
   * Names the show: its label, else the manifest's title, else "Photos";
   * and shows the manifest's title, if it has one, in the header.
   */
  #name(): void {
    const label = this.getAttribute("label")?.trim() ?? "";
    const byElement = "ariaLabelledByElements" in this.#internals;
    const internals = this.#internals as ElementInternals & { ariaLabelledByElements: Element[] | null };
    // The text is always given too: an engine that does not follow a
    // reference from the host into its own shadow tree falls back to it,
    // so the show is never left without a name.
    this.#internals.ariaLabel = label || this.#showTitle || text.show;
    if (byElement) internals.ariaLabelledByElements = !label && this.#showTitle ? [this.#nameBox] : null;
    // The header is the manifest's title's, in its language; the label is
    // the page's name for the show, for screen readers, not shown.
    const title = this.#showTitle;
    applyLang(this.#headerTitle, this.#showLang);
    // The header shown, hidden, or of another height makes the stage
    // another height; the photos are not given new sizes here, but when
    // the stage is next observed, before anything paints: by then any
    // slides that came with the title are set, and the photos about to be
    // let go are gone. A photo asked for meanwhile is measured as it is.
    this.#headerTitle.textContent = title;
    this.#header.hidden = !title;
  }

  /**
   * Takes a new list of slides, keeping what it can: the visitor's place,
   * the photo on screen if its slide is still there with the same photo, a
   * photo on its way if its slide is, and every other photo that has not
   * changed. Slides are matched by key (see Keyed), not by place. A caption
   * fixed or a slide added changes nothing on screen but the words and the
   * count.
   */
  #setSlides(slides: Keyed[]): void {
    const old = this.#slides;
    if (slides.length === old.length && slides.every((s, i) => JSON.stringify(s) === JSON.stringify(old[i]))) {
      return;
    }
    const wanted = old[this.#target];
    const shownSlide = old[this.#shown];
    this.#slides = slides;
    this.#indexById.clear();
    this.#indexByKey.clear();
    slides.forEach((s, i) => {
      this.#indexById.set(s.id, i);
      this.#indexByKey.set(s.key, i);
    });
    this.#photos.carryOver(slides);
    // How many there are, in the header, and whether any has a title or a
    // credit, for which every caption keeps a line: before any photo is
    // asked for, as either may change the stage's height.
    this.#headerCount.textContent = slides.length ? text.photos(slides.length) : "";
    this.#box.dataset["titles"] = String(slides.some((s) => s.title));
    this.#box.dataset["credits"] = String(slides.some((s) => s.credit));

    // Where a slide is now, if it is still there with the same photo.
    const now = (slide: Keyed | undefined): number => {
      const i = slide ? this.#indexByKey.get(slide.key) : undefined;
      return i !== undefined && photoKey(slides[i]!) === photoKey(slide!) ? i : -1;
    };
    this.#shown = now(shownSlide);
    // The slide on screen gone in the middle of a drag of its photo: the
    // drag ends here, and the rest of the gesture is not a swipe.
    if (this.#shown < 0 && this.#figure?.style.getPropertyValue("--clack-drag")) {
      this.#swipes?.cancel();
      this.#endDrag();
    }
    if (this.#figure && this.#shown >= 0) {
      this.#figure.ariaLabel = text.of(this.#shown + 1, slides.length);
    }
    const target = now(wanted);

    if (slides.length === 0) {
      this.#cancelPending();
      this.#target = -1;
      this.#finishTransitions();
      this.#endDrag();
      this.#figure?.remove();
      this.#figure = null;
      this.#caption(null);
      this.#updateControls();
      return;
    }
    if (this.#pending && target >= 0) {
      // The slide asked for is still coming, and still wanted: it arrives
      // where it now is (the request looks it up by key), and whoever asked
      // for it is told it was shown.
      this.#target = target;
      this.#updateControls();
      this.#refreshShown();
      // Its placeholder, if it has one up, is brought up to date: its
      // colour, shape or hash may be what changed.
      if (this.#figure?.classList.contains("placeholder")) {
        this.#placeholder(target);
      }
      return;
    }
    this.#cancelPending();
    // The visitor's place: the slide they asked for, even if its photo has
    // changed; else the one on screen; else, if neither is left, the first.
    const at = (wanted ? this.#indexByKey.get(wanted.key) : undefined) ?? (this.#shown >= 0 ? this.#shown : 0);
    if (at === this.#shown) {
      this.#target = at;
      this.#refreshShown();
      this.#updateControls();
      this.#preload(at);
      return;
    }
    // Whatever is on screen stays until the new slide's photo is ready.
    this.#target = -1;
    void this.#request(at, { user: false });
  }

  /**
   * The slide on screen, kept across a change to the slides: its caption,
   * and a missing photo's description in its place, follow the slide as it
   * now is (the photo's own alt and lang follow in Photos.carryOver).
   */
  #refreshShown(): void {
    const slide = this.#slides[this.#shown];
    if (!slide) return;
    this.#caption(slide);
    const missing = this.#figure?.querySelector<HTMLElement>(".missing-alt");
    if (missing) {
      missing.textContent = slide.alt;
      applyLang(missing, slide.lang);
    }
  }

  /** Forgets the slide on its way, if any: whoever asked for it is told it was not shown. */
  #cancelPending(): void {
    this.#token++;
    this.#pending = null;
    this.#stage.classList.remove("loading");
  }

  // ---- Navigation ------------------------------------------------------

  /**
   * Where a step starts: the slide asked for, which may still be loading --
   * pressing on twice goes two slides on -- or the first, before any.
   */
  #from(): number {
    return this.#target < 0 ? 0 : this.#target;
  }

  #go(delta: 1 | -1, how: How): Promise<boolean> {
    const from = this.#from();
    if (!canStep(from, this.#slides.length, delta, this.loop)) {
      return Promise.resolve(false);
    }
    return this.#request(step(from, this.#slides.length, delta, this.loop), how, delta);
  }

  #user(delta: 1 | -1): void {
    void this.#go(delta, { user: true });
  }

  /**
   * Asks for slide target. direction is the way the visitor is going, when
   * a step says so (on from the last slide of a looping show is forward,
   * though the index falls); a jump works it out from the indexes.
   */
  #request(target: number, how: How, direction?: 1 | -1): Promise<boolean> {
    if (target === this.#target && this.#pending) {
      return this.#pending;
    }
    if (target === this.#shown) {
      // Back to the slide on screen before the one asked for arrived: that
      // one is no longer wanted, and this one is already here.
      this.#cancelPending();
      this.#target = target;
      this.#updateControls();
      return Promise.resolve(true);
    }
    if (direction) {
      this.#direction = direction;
    } else if (this.#shown >= 0) {
      this.#direction = target > this.#shown ? 1 : -1;
    }
    this.#target = target;
    this.#updateControls();
    const token = ++this.#token;
    const slide = this.#slides[target]!;
    const sizes = this.#sizer();
    const photo = this.#photos.get(slide, () => sizes(target), true);
    // Let go of what is no longer near. What is ahead of the target is kept
    // if it is already coming, but not started until the target is on
    // screen (see #preload).
    const ahead = preloadOrder(target, this.#slides.length, this.#direction, this.loop);
    this.#photos.keepOnly(this.#keys([target, this.#shown, ...ahead]));
    this.#stage.classList.toggle("loading", photo.state === "loading");
    if (!this.#figure || this.#figure.classList.contains("placeholder")) {
      this.#placeholder(target);
    }
    const pending = photo.settled.then((state) => {
      // The slides may have changed while it loaded: it is found by key.
      const index = this.#indexByKey.get(slide.key);
      if (token !== this.#token || state === "dropped" || index === undefined) {
        return false;
      }
      this.#pending = null;
      this.#stage.classList.remove("loading");
      this.#display(index, photo, how);
      // A slidechange listener may already have asked for another slide;
      // loading ahead of this one would then let go of that one's photo.
      if (token === this.#token) {
        this.#preload(index);
      }
      return true;
    });
    this.#pending = pending;
    return pending;
  }

  /**
   * Starts fetching the slides the visitor is likely to want next. Only
   * once a photo is on screen: a visitor skipping through slides would
   * otherwise start downloads for each one passed, and most engines finish
   * a download even after Clack lets go of it.
   */
  #preload(target: number): void {
    const order = preloadOrder(target, this.#slides.length, this.#direction, this.loop);
    const sizes = this.#sizer();
    for (const i of order) {
      this.#photos.get(this.#slides[i]!, () => sizes(i), false);
    }
    this.#photos.keepOnly(this.#keys([target, this.#shown, ...order]));
  }

  /** The keys of the slides at these indexes (any out of range left out). */
  #keys(indexes: number[]): Set<string> {
    const keys = new Set<string>();
    for (const i of indexes) {
      const slide = this.#slides[i];
      if (slide) keys.add(slide.key);
    }
    return keys;
  }

  /**
   * Holds the place of the first photo while it loads: a frame of its
   * proportions, in its colour if it has one, and with its impression
   * painted from its ThumbHash if it has one and its photo has not yet
   * settled (one that has -- shown, or failed -- replaces the placeholder
   * at once; one in the HTTP cache still has to be decoded, so it is
   * painted for that moment), so the page does not wait on an empty box. The photo fades in over it.
   * A placeholder already up is brought up to date in place -- each step,
   * each change to the markup -- and its impression painted again only if
   * the hash is not the one it holds.
   */
  #placeholder(index: number): void {
    const slide = this.#slides[index]!;
    let figure = this.#figure;
    // Only ever over nothing, or over the placeholder: never a photo.
    if (figure && !figure.classList.contains("placeholder")) return;
    if (!figure) {
      figure = el("figure", "slide placeholder", "slide");
      figure.role = "group";
      figure.ariaRoleDescription = text.slide;
      figure.ariaBusy = "true";
      figure.append(mount(el("div", "fill")));
      this.#stage.append(figure);
      this.#figure = figure;
      this.#painted = "";
    }
    figure.ariaLabel = text.of(index + 1, this.#slides.length);
    figure.style.setProperty("--clack-aspect", String(slide.width / slide.height));
    if (slide.color) {
      // Checked as #rrggbb when the slide was read.
      figure.style.setProperty("--clack-placeholder", slide.color);
    } else {
      figure.style.removeProperty("--clack-placeholder");
    }
    const photo = this.#photos.peek(slide.key);
    const hash = slide.thumbhash && (!photo || photo.state === "loading") ? slide.thumbhash : "";
    if (hash !== this.#painted) {
      const canvas = hash ? impression(hash) : null;
      figure.querySelector(".fill")!.replaceChildren(...(canvas ? [canvas] : []));
      this.#painted = hash;
    }
  }

  // ---- Showing a slide -------------------------------------------------

  #display(index: number, photo: Photo, how: How): void {
    this.#finishTransitions();
    const previous = this.#shown;
    const old = this.#figure;
    const slide = this.#slides[index]!;
    const figure = this.#makeFigure(index, slide, photo);
    this.#stage.append(figure);
    this.#figure = figure;
    this.#shown = index;
    this.#caption(slide);
    this.#updateControls();
    if (how.user) {
      this.#announce(index + 1, this.#slides.length, slide);
    }

    let transition = old ? this.#transition() : null;
    // A slide only from one slide to another: a photo replacing its
    // placeholder, or a new photo of the slide on screen, fades in place.
    if (transition?.type === "slide" && (previous < 0 || previous === index)) transition = { ...transition, type: "crossfade" };
    if (old && transition) {
      const timing: KeyframeAnimationOptions = { duration: transition.ms, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
      // The way the old photo leaves: the finger's, or the way the visitor
      // is going -- leftwards for the next, where the text runs left to right.
      const exit = how.swipe ? how.swipe.exit : ((-this.#direction * (this.#rtl() ? -1 : 1)) as -1 | 1);
      const frames = transitionFrames(transition.type, exit, how.swipe ? how.swipe.offset : null);
      // Cut off at the show's sides while they slide (#settleMoving).
      if (transition.type === "slide") this.#box.classList.add("moving");
      const animations = [figure.animate(frames.incoming, timing), old.animate(frames.outgoing, timing)];
      const running: Running = {
        animations,
        done: () => {
          old.remove();
          this.#running = this.#running.filter((r) => r !== running);
          this.#settleMoving();
        },
      };
      this.#running.push(running);
      void Promise.all(animations.map((a) => a.finished)).then(running.done, running.done);
    } else {
      old?.remove();
      this.#settleMoving();
    }

    this.dispatchEvent(
      new CustomEvent<SlideChangeDetail>("slidechange", { detail: { index, id: slide.id, previous }, bubbles: true }),
    );
  }

  #makeFigure(index: number, slide: Keyed, photo: Photo): HTMLElement {
    const figure = el("figure", "slide", "slide");
    figure.role = "group";
    figure.ariaRoleDescription = text.slide;
    figure.ariaLabel = text.of(index + 1, this.#slides.length);
    // The photo's proportions, for the CSS that fits it to the frame.
    figure.style.setProperty("--clack-aspect", String(slide.width / slide.height));
    if (photo.state === "failed") {
      figure.classList.add("failed");
      const box = el("div", "missing", "missing");
      const what = el("span", "missing-alt");
      what.textContent = slide.alt;
      const why = el("span", "missing-why");
      why.textContent = text.failed;
      box.append(icon("photo-off"), what, why);
      figure.append(mount(box));
    } else {
      figure.append(mount(photo.element));
    }
    // The photo's description is the manifest's text, in its language.
    const described = figure.querySelector("img, .missing-alt");
    if (described instanceof HTMLElement) applyLang(described, slide.lang);
    return figure;
  }

  /** Ends every running transition at once, at its end. */
  #finishTransitions(): void {
    // The spring back too: the photo where it was going, in place.
    this.#springing?.finish();
    for (const r of [...this.#running]) {
      for (const a of r.animations) {
        a.finish();
      }
      r.done();
    }
  }

  /**
   * How one photo gives way to the next, from the theme -- a crossfade or a
   * slide, and how long it takes -- or null for none at once. With reduced
   * motion, a slide is a crossfade, and short; and there is none while the
   * page is hidden: nobody sees it, and an engine may not run animations in
   * a hidden page at all, which would leave the old slide in place until
   * the page is shown again.
   */
  #transition(): { type: "crossfade" | "slide"; ms: number } | null {
    if (document.visibilityState === "hidden") {
      return null;
    }
    // The tokens as the probe inherits them.
    const style = getComputedStyle(this.#probe);
    const type = style.getPropertyValue("--clack-transition").trim();
    // A 0 without a unit, as a theme may write it, and so a page: none,
    // though CSS takes no time without one, and calc() below would drop it.
    const token = style.getPropertyValue("--clack-transition-duration").trim();
    if (/^[+-]?(?:0+\.?0*|\.0+)$/.test(token)) {
      return null;
    }
    // As CSS reads the token -- a theme's, or any time the page sets,
    // calc() and all -- a second longer (see .probe in clack.css), so that
    // one that is not a time, which leaves CSS's initial 0s (or auto, in
    // an engine that has it), is told from 0s; computed, it is always
    // seconds. A show out of the page has no computed style at all.
    const s = parseFloat(style.animationDuration);
    return transitionOf(type, s > 0 ? Math.round(s * 1000) - 1000 : NaN, matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  #caption(slide: Keyed | null): void {
    // Each part in its own language, the box around them in none, so a
    // part whose language is null inherits the page's, not the other's.
    applyLang(this.#title, slide ? slide.captionLang : null);
    applyLang(this.#credit, slide ? slide.creditLang : null);
    this.#title.textContent = slide?.title ?? "";
    this.#credit.textContent = slide?.credit ?? "";
    // Nothing to say: its place kept, but no card drawn for it.
    const credited = !!slide?.credit && this.#box.dataset["credit"] !== "false";
    this.#title.parentElement!.classList.toggle("blank", !slide?.title && !credited);
  }

  /**
   * The visitor is here: the pointer moved or pressed, a key, focus. In a
   * theme whose controls appear only then (controls.reveal on-activity),
   * they are shown, and hidden again a few seconds after the last of it --
   * unless the pointer rests on them, or focus is among them (clack.css
   * shows them then whatever this says).
   */
  readonly #onActivity = (e: Event): void => {
    if (this.#box.dataset["reveal"] !== "on-activity") return;
    if (e instanceof PointerEvent) this.#lastPointer = e.pointerType;
    this.#lastActivity = performance.now();
    this.#box.classList.add("active");
    // One timer for all of it, however many events: it looks again when
    // it runs (#onIdle).
    this.#idle ??= setTimeout(() => this.#onIdle(), revealFor);
  };

  /**
   * A few seconds after the activity that showed the controls: hidden, if
   * there has been none since, and the pointer does not rest on them -- a
   * mouse's or a pen's: a touch leaves what it last touched hovered.
   */
  #onIdle(): void {
    this.#idle = undefined;
    const left = revealFor - (performance.now() - this.#lastActivity);
    const floating = this.#box.dataset["controls"] === "floating";
    const resting = this.#lastPointer !== "touch" && this.#box.querySelector(floating ? ".below" : ".controls")!.matches(":hover");
    if (left > 0 || resting) {
      this.#idle = setTimeout(() => this.#onIdle(), left > 0 ? left : revealFor);
      return;
    }
    this.#box.classList.remove("active");
  }

  #updateControls(): void {
    const count = this.#slides.length;
    const at = Math.max(this.#target, 0);
    this.#counter.textContent = count ? `${at + 1} / ${count}` : "";
    for (const [button, delta] of [[this.#previous, -1], [this.#next, 1]] as const) {
      // aria-disabled rather than disabled: a disabled button drops the
      // keyboard focus, and the visitor who pressed it would lose their place.
      button.ariaDisabled = canStep(at, count, delta, this.loop) ? null : "true";
    }
  }

  #announce(n: number, count: number, slide: Keyed): void {
    // Emptied first, so the same words twice are still read twice. The
    // title is the slide's own text, in its language; the rest is Clack's.
    this.#live.textContent = "";
    requestAnimationFrame(() => {
      if (!slide.title) {
        this.#live.textContent = text.announce(n, count);
        return;
      }
      const [before, after] = text.announceTitled(n, count);
      const t = el("span", "");
      t.textContent = slide.title;
      applyLang(t, slide.captionLang);
      this.#live.replaceChildren(before, t, after);
    });
  }


  // ---- Input ------------------------------------------------------------

  #rtl(): boolean {
    return getComputedStyle(this).direction === "rtl";
  }

  #onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    const forward = this.#rtl() ? -1 : 1;
    switch (e.key) {
      case "ArrowRight":
        this.#user(forward === 1 ? 1 : -1);
        break;
      case "ArrowLeft":
        this.#user(forward === 1 ? -1 : 1);
        break;
      case "Home":
        if (this.#slides.length) void this.#request(0, { user: true });
        break;
      case "End":
        if (this.#slides.length) void this.#request(this.#slides.length - 1, { user: true });
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  #drag(dx: number): void {
    const figure = this.#figure;
    if (!figure || this.#shown < 0) {
      return;
    }
    // Caught again as it springs back: it follows the finger from where it
    // was caught, not from where it is going.
    const springing = this.#springing;
    if (springing) {
      this.#caught = new DOMMatrix(getComputedStyle(figure).transform).m41;
      this.#springing = null;
      springing.cancel();
    }
    this.#finishTransitions();
    // Where there is nowhere to go, the photo resists.
    const delta = (dx < 0 ? 1 : -1) * (this.#rtl() ? -1 : 1);
    const free = canStep(this.#from(), this.#slides.length, delta, this.loop);
    // Cut off at the show's sides while it moves, so it never widens the
    // page; only then, so nothing else at the sides is (#settleMoving).
    this.#box.classList.add("moving");
    figure.style.setProperty("--clack-drag", `${this.#caught + (free ? dx : dx * 0.25)}px`);
  }

  /** Ends a drag of figure's photo: back in place, and nothing cut off once nothing moves. */
  #endDrag(figure = this.#figure): void {
    this.#caught = 0;
    figure?.style.removeProperty("--clack-drag");
    this.#settleMoving();
  }

  /**
   * Stops cutting photos off at the show's sides once none is moved aside
   * or moving -- by Clack: a drag, a spring back, a swipe's fade (the
   * crossfades, as one may have taken over from a drag). Not a page's own
   * animation of its slides, which moves nothing aside.
   */
  #settleMoving(): void {
    const figures = this.#stage.querySelectorAll<HTMLElement>(".slide");
    const dragged = Array.from(figures).some((f) => f.style.getPropertyValue("--clack-drag"));
    if (!dragged && !this.#springing && this.#running.length === 0) this.#box.classList.remove("moving");
  }

  #swiped(outcome: -1 | 0 | 1): void {
    const figure = this.#figure;
    if (!figure) {
      return;
    }
    const offset = parseFloat(figure.style.getPropertyValue("--clack-drag")) || 0;
    this.#caught = 0; // the gesture's own: its next starts afresh
    const delta = ((outcome === -1 ? 1 : -1) * (this.#rtl() ? -1 : 1)) as 1 | -1;
    const from = this.#from();
    const go = outcome !== 0 && canStep(from, this.#slides.length, delta, this.loop);
    if (go) {
      const target = step(from, this.#slides.length, delta, this.loop);
      const sizes = this.#sizer();
      const photo = this.#photos.get(this.#slides[target]!, () => sizes(target), true);
      // Back to the one on screen (the visitor had asked for another, still
      // coming): nothing takes over from it, so it springs back.
      if (photo.state !== "loading" && target !== this.#shown) {
        // Ready: it takes over from the photo where the finger left it,
        // which carries on the way the finger went.
        const exit = outcome === -1 ? -1 : 1;
        void this.#request(target, { user: true, swipe: { exit, offset } }, delta);
        return;
      }
      this.#springBack(figure, offset);
      void this.#request(target, { user: true }, delta);
      return;
    }
    this.#springBack(figure, offset);
  }

  #springBack(figure: HTMLElement, offset: number): void {
    if (offset !== 0) {
      const back = figure.animate([{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }], {
        duration: 220,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
      this.#springing = back;
      const done = (): void => {
        if (this.#springing === back) this.#springing = null;
        this.#settleMoving();
      };
      void back.finished.then(done, done);
    }
    // After the animation has begun, so the photo is cut off while it runs.
    this.#endDrag(figure);
  }

  // ---- Size -------------------------------------------------------------

  /**
   * Something that may change where the photos are drawn has changed --
   * the stage's size or the probe's (as observed), a theme, the header --
   * and every photo is given its size again, the mount's too: at once, in
   * the page, so that it is right before anything paints. While the show
   * has no size (hidden), the photos keep the sizes they had: given the
   * window's width, an engine could fetch the largest of each.
   */
  #relayout(): void {
    if (!this.#ready) return;
    const geometry = this.#layOut();
    if (!geometry) return;
    this.#photos.resize((key) => this.#sizes(this.#indexByKey.get(key) ?? -1, geometry));
  }

  /**
   * Lays the photos out again when the screen's pixel ratio changes (the
   * window moved to another screen), which no size may: the frame is in
   * whole device pixels.
   */
  #watchRatio(): void {
    this.#unwatchRatio?.();
    const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    const changed = (): void => {
      this.#watchRatio();
      this.#relayout();
    };
    query.addEventListener("change", changed);
    this.#unwatchRatio = () => query.removeEventListener("change", changed);
  }

  /**
   * Lays the photos out: where they are drawn now (#measure), its mount
   * given to the CSS, and kept as what a hidden show's photos are asked
   * for at. Null, and nothing given, while the stage has no size -- but a
   * layout with no mount has none whatever the stage's size.
   */
  #layOut(): Geometry | null {
    const geometry = this.#measure();
    if (geometry) {
      this.#mount(geometry.mat, geometry.frame);
      this.#lastGeometry = geometry;
    } else if (this.#box.dataset["layout"] !== "matted") {
      this.#mount(0, 0);
    }
    return geometry;
  }

  /**
   * The sizes of each photo asked for in one go (a request, its
   * preloads): laid out once, when the first is built, and not for those
   * already there. While the show has no size -- hidden, or not yet in
   * the page -- as when it last had one; before it ever did, the
   * window's width. A photo is always fetched when asked for, so that
   * whoever waits on it (goTo, a lightbox opening once it is ready) is
   * not left waiting.
   */
  #sizer(): (i: number) => string {
    let geometry: Geometry | null | undefined;
    return (i) => {
      if (geometry === undefined) geometry = this.#layOut() ?? this.#lastGeometry;
      return this.#sizes(i, geometry) ?? "100vw";
    };
  }

  /**
   * Where the photos are drawn, now: the stage's size, and what the mount
   * comes to around a photo, in px, from the theme's mat and frame as of
   * the show (the probe's size: see .probe in clack.css); none but in the
   * matted layout. The bevel, where there is one, is drawn in the mat's
   * last 2px (clack.css). Null while the stage has no size: out of the
   * page, or hidden. Only read: #layOut gives it to the CSS.
   *
   * Never more than a sixth of the stage's shorter side, each side: on a
   * show too small for its mat -- the built-in one is of the window, not
   * the show -- the mat and frame are narrowed together, and the photo
   * keeps two thirds of the stage. The frame is in whole device pixels,
   * rounded down, as a browser draws a border, so that the frame drawn is
   * the frame counted at any pixel ratio; a frame there is is at least one.
   *
   * Worked out afresh each time it is needed -- once for each pass over
   * the photos, or each go at asking for some -- never kept: a header that
   * changes height, a theme, the page's own styles all change it, and
   * nothing need remember to say so. Read as laid out (laidOut), the same
   * way whatever asks.
   */
  #measure(): Geometry | null {
    const stage = laidOut(this.#stage);
    if (stage.width === 0 || stage.height === 0) return null;
    let mat = 0;
    let frame = 0;
    if (this.#box.dataset["layout"] === "matted") {
      // A pixel more than each, there.
      const probe = laidOut(this.#probe);
      mat = Math.max(0, probe.width - 1);
      const asked = Math.max(0, probe.height - 1);
      const dpr = devicePixelRatio || 1;
      // Rounded down, but not past a sixteenth of a device pixel: what is
      // laid out is a hair short of a whole one where it should be one.
      const device = (f: number): number => (asked > 0 ? Math.max(1, Math.floor(f * dpr + 1 / 16)) / dpr : 0);
      frame = device(asked);
      const most = Math.min(stage.width, stage.height) / 6;
      if (mat + frame > most) {
        // Narrowed in proportion, never widened.
        const k = Math.min(1, most / (mat + asked));
        frame = device(asked * k);
        mat = Math.max(0, Math.min(mat * k, most - frame));
      }
    }
    return { stage, mat, frame };
  }

  /** Gives the CSS the mount's mat and frame, each side, if they have changed. */
  #mount(mat: number, frame: number): void {
    const css = `${mat}px ${frame}px`;
    if (css === this.#mountCSS) return;
    this.#mountCSS = css;
    this.#stage.style.setProperty("--clack-mat-inset", `${mat}px`);
    this.#stage.style.setProperty("--clack-frame-inset", `${frame}px`);
  }

  /**
   * What the `sizes` of slide i's photo should say, laid out so: the width
   * it is drawn at; the window's width before there was any layout. Null
   * for a photo whose slide has gone: it is about to be let go, and keeps
   * the sizes it has.
   */
  #sizes(i: number, geometry: Geometry | null): string | null {
    const slide = this.#slides[i];
    if (!slide) return null;
    if (!geometry) return "100vw";
    const { stage, mat, frame } = geometry;
    const fit = this.getAttribute("fit") === "cover" ? "cover" : "contain";
    // The room the mount leaves the photo, if the layout has one.
    const room = (side: number): number => Math.max(0, side - 2 * (mat + frame));
    return `${Math.max(1, drawnWidth(room(stage.width), room(stage.height), slide.width / slide.height, fit))}px`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "clack-show": ClackShow;
  }
  interface HTMLElementEventMap {
    slidechange: CustomEvent<SlideChangeDetail>;
  }
}
