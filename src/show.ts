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
import { listen } from "./swipe";
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

/** A theme as the show adopts it: its stylesheet, and its layout's choices. */
interface Look {
  sheet: CSSStyleSheet;
  choices: Compiled["choices"];
}

/**
 * Every theme's stylesheet, so a show can tell them from the page's own:
 * a page that saved the shadow root's sheets and puts them back, an old
 * theme's among them, must not have that theme's outlast every later one.
 */
const lookSheets = new WeakSet<CSSStyleSheet>();

/**
 * A compiled theme as a stylesheet of its own: one rule for :host, its
 * properties set one at a time through the CSS object model, so each value
 * is only ever a value.
 */
function lookOf({ properties, choices }: Compiled): Look {
  const sheet = new CSSStyleSheet();
  lookSheets.add(sheet);
  sheet.replaceSync(":host {}");
  const style = (sheet.cssRules[0] as CSSStyleRule).style;
  for (const [name, value] of properties) style.setProperty(name, value);
  return { sheet, choices };
}

/**
 * The looks of the theme files asked for last, by URL, so a file is fetched
 * once however many shows ask for it -- and forgotten if it fails, so
 * asking again fetches it again. Only the last few are kept: a page that
 * previews many themes, or a new version of one at a new URL, does not
 * collect them all. A fetch is not cancelled when a show stops wanting it:
 * another may want it still, and a theme file is small.
 */
const themeFiles = new Map<string, Promise<Look>>();
const themeFilesKept = 8;
/** How long a theme file may take to arrive, in ms: far more than a few kilobytes ever need. */
const themeFileTimeout = 30_000;

function themeFile(url: string): Promise<Look> {
  let look = themeFiles.get(url);
  if (look) {
    themeFiles.delete(url); // to the end: asked for last
  } else {
    // A server that never answers fails it in the end, so it can be asked for again.
    look = loadTheme(url, AbortSignal.timeout(themeFileTimeout)).then((t) => lookOf(compile(t)));
    look.catch(() => {
      if (themeFiles.get(url) === look) themeFiles.delete(url);
    });
  }
  themeFiles.set(url, look);
  for (const oldest of themeFiles.keys()) {
    if (themeFiles.size <= themeFilesKept) break;
    themeFiles.delete(oldest);
  }
  return look;
}

// The built-in themes' looks, each made once and shared by every show.
const builtinLooks = new Map<string, Look>();

function builtinLook(name: string): Look {
  let look = builtinLooks.get(name);
  if (!look) {
    look = lookOf(compile(builtinTheme(name)));
    builtinLooks.set(name, look);
  }
  return look;
}

/**
 * The crossfade's length in ms, from the theme's as CSS computes it (NaN
 * when it is not a time): 700 if it is not one, at most 200 when motion is
 * reduced, and never more than 3 s.
 */
export function crossfade(ms: number, reduced: boolean): number {
  const given = Number.isFinite(ms) ? ms : 700;
  return Math.min(given, reduced ? 200 : 3000);
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
  /** The manifest's title, hidden, in its language: what names the show when it does (see #name). */
  readonly #nameBox: HTMLSpanElement;
  readonly #stage: HTMLDivElement;
  readonly #notice: HTMLParagraphElement;
  readonly #title: HTMLSpanElement;
  readonly #credit: HTMLSpanElement;
  readonly #counter: HTMLSpanElement;
  readonly #previous: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #live: HTMLDivElement;
  /** The show's outermost box, which carries the theme's layout choices. */
  readonly #box: HTMLDivElement;
  /**
   * The theme asked for (a built-in's name, or a theme file's URL,
   * resolved), whether it failed, and what is still to be done about it
   * once the show is in the page: a file to fetch, or why there is none
   * -- or why it failed, when it failed while the show was out of the page.
   */
  #theme: { asked: string; failed: boolean; pending: { url: string } | { error: unknown } | null } = { asked: "", failed: false, pending: null };

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
  #frame = { width: 0, height: 0 };

  #stopSwipe: (() => void) | null = null;
  readonly #resize = new ResizeObserver((entries) => this.#onResize(entries));
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
    this.#look(builtinLook("base"));
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

    this.#nameBox = el("span", "name");
    this.#nameBox.hidden = true;
    this.#live = el("div", "live");
    this.#live.ariaLive = "polite";
    this.#live.ariaAtomic = "true";

    show.append(this.#stage, below);
    root.append(show, this.#live, this.#nameBox);

    this.addEventListener("keydown", (e) => this.#onKey(e));
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
    this.#stopSwipe = listen(this.#stage, {
      move: (dx) => this.#drag(dx),
      end: (outcome) => this.#swiped(outcome),
    });
    // A page may set a property before Clack is loaded: the value then sits
    // on the element itself, hiding the class's accessor, and is moved
    // through the accessor now. A value the setter refuses is reported, as
    // it would have been had Clack been there, and the show carries on.
    const own = this as unknown as Record<string, unknown>;
    for (const name of ["src", "slides", "loop", "theme"]) {
      if (Object.hasOwn(this, name)) {
        const value = own[name];
        delete own[name];
        try {
          own[name] = value;
        } catch (e) {
          reportError(e);
        }
      }
    }
    // The markup is read again on a reconnect, in case it changed while
    // the show was out of the page and not watching it.
    if (this.#showing.from === "markup") this.#showing = { from: "none" };
    this.#ready = true;
    this.#takeUpTheme();
    this.#render();
  }

  disconnectedCallback(): void {
    this.#ready = false;
    document.removeEventListener("visibilitychange", this.#onVisibility);
    // A manifest on its way is not dropped: there is no telling a move --
    // however long it takes -- from a removal, and a show that is moved must
    // not download it again. What becomes of it is shown when the show is
    // back (#render does nothing out of the page); a show removed for good
    // downloads it once, and is collected with it.
    this.#resize.disconnect();
    this.#mutations.disconnect();
    this.#stopSwipe?.();
    this.#stopSwipe = null;
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
        this.#photos.resize((key) => this.#sizes(this.#indexByKey.get(key) ?? -1));
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
    if (asked === this.#theme.asked && !this.#theme.failed) return;
    if (isBuiltin(asked)) {
      this.#theme = { asked, failed: false, pending: null };
      this.#look(builtinLook(asked));
      return;
    }
    const pending =
      url === null
        ? { error: new Error(`it is not a built-in theme (they are ${builtinNames.join(", ")}), nor a URL`) }
        : typeof url === "string"
          ? { url }
          : { error: new Error(`it is not an http(s) URL (${url.problem})`) };
    this.#theme = { asked, failed: false, pending };
    this.#takeUpTheme();
  }

  /**
   * Fetches the theme file asked for, or says why there is none to fetch --
   * only once the show is in the page, as for its manifest: a show made and
   * never shown asks for nothing, and says nothing.
   */
  #takeUpTheme(): void {
    const theme = this.#theme;
    const pending = theme.pending;
    if (!this.#ready || pending === null) return;
    theme.pending = null;
    if ("error" in pending) {
      this.#themeFailed(theme.asked, pending.error);
      return;
    }
    themeFile(pending.url).then(
      (look) => {
        if (this.#theme === theme) this.#look(look);
      },
      (e: unknown) => {
        if (this.#theme !== theme) return;
        // Said once the show is back in the page, if it left meanwhile.
        if (this.#ready) this.#themeFailed(pending.url, e);
        else theme.pending = { error: e };
      },
    );
  }

  /** The theme asked for could not be had, or was refused: said to the console, the show keeping the theme it has. */
  #themeFailed(name: string, e: unknown): void {
    this.#theme.failed = true;
    reportFailure("theme", name, e, "; the show keeps the theme it had");
  }

  /**
   * Shows the show in a look: its stylesheet before Clack's own, which no
   * theme can override, and its choices on the show's box. Any sheet the
   * page has adopted into the shadow root itself is kept, after Clack's.
   */
  #look({ sheet, choices }: Look): void {
    const root = this.shadowRoot!;
    const pages = root.adoptedStyleSheets.filter((s) => !lookSheets.has(s) && s !== styles());
    root.adoptedStyleSheets = [sheet, styles(), ...pages];
    for (const [name, value] of Object.entries(choices)) this.#box.dataset[name] = value;
  }

  #showManifest(m: Manifest): void {
    this.#showing = { from: "manifest", manifest: m };
    this.#mutations.disconnect();
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
   * language goes with each slide -- see Keyed.lang.)
   */
  #setTitle(title: string, lang: string | null): void {
    this.#showTitle = title;
    this.#name();
    this.#nameBox.textContent = title;
    applyLang(this.#nameBox, lang);
  }

  /** Names the show: its label, else the manifest's title, else "Photos". */
  #name(): void {
    const label = this.getAttribute("label");
    const byElement = "ariaLabelledByElements" in this.#internals;
    const internals = this.#internals as ElementInternals & { ariaLabelledByElements: Element[] | null };
    // The text is always given too: an engine that does not follow a
    // reference from the host into its own shadow tree falls back to it,
    // so the show is never left without a name.
    this.#internals.ariaLabel = label || this.#showTitle || text.show;
    if (byElement) internals.ariaLabelledByElements = !label && this.#showTitle ? [this.#nameBox] : null;
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

    // Where a slide is now, if it is still there with the same photo.
    const now = (slide: Keyed | undefined): number => {
      const i = slide ? this.#indexByKey.get(slide.key) : undefined;
      return i !== undefined && photoKey(slides[i]!) === photoKey(slide!) ? i : -1;
    };
    this.#shown = now(shownSlide);
    if (this.#figure && this.#shown >= 0) {
      this.#figure.ariaLabel = text.of(this.#shown + 1, slides.length);
    }
    const target = now(wanted);

    if (slides.length === 0) {
      this.#cancelPending();
      this.#target = -1;
      this.#finishTransitions();
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
    const photo = this.#photos.get(slide, this.#sizes(target), true);
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
    for (const i of order) {
      this.#photos.get(this.#slides[i]!, this.#sizes(i), false);
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
      figure.append(el("div", "fill"));
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
      figure.firstElementChild!.replaceChildren(...(canvas ? [canvas] : []));
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

    const duration = old ? this.#duration(figure) : 0;
    if (old && duration > 0) {
      const timing: KeyframeAnimationOptions = { duration, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
      const outgoing: Keyframe[] = how.swipe
        ? [
            { opacity: 1, transform: `translateX(${how.swipe.offset}px)` },
            { opacity: 0, transform: `translateX(${how.swipe.exit * 12}%)` },
          ]
        : [{ opacity: 1 }, { opacity: 0 }];
      const animations = [figure.animate([{ opacity: 0 }, { opacity: 1 }], timing), old.animate(outgoing, timing)];
      const running: Running = {
        animations,
        done: () => {
          old.remove();
          this.#running = this.#running.filter((r) => r !== running);
        },
      };
      this.#running.push(running);
      void Promise.all(animations.map((a) => a.finished)).then(running.done, running.done);
    } else {
      old?.remove();
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
      figure.append(box);
    } else {
      figure.append(photo.element);
    }
    // The photo's description is the manifest's text, in its language.
    const described = figure.querySelector("img, .missing-alt");
    if (described instanceof HTMLElement) applyLang(described, slide.lang);
    return figure;
  }

  /** Ends every running transition at once, at its end. */
  #finishTransitions(): void {
    for (const r of [...this.#running]) {
      for (const a of r.animations) {
        a.finish();
      }
      r.done();
    }
  }

  /**
   * The crossfade's length in milliseconds, from the theme, shortened when
   * motion is reduced, and none while the page is hidden: nobody sees it,
   * and an engine may not run animations in a hidden page at all, which
   * would leave the old slide in place until the page is shown again.
   */
  #duration(figure: HTMLElement): number {
    if (document.visibilityState === "hidden") {
      return 0;
    }
    const style = getComputedStyle(this);
    if (style.getPropertyValue("--clack-transition").trim() === "none") {
      return 0;
    }
    // As CSS reads the token -- a theme's, or any time the page sets,
    // calc() and all -- from the slide coming in, whose animation-duration
    // is this crossfade's (see .slide in clack.css): computed, it is always
    // seconds. A value that is not a time leaves it at CSS's initial 0s,
    // and a show out of the page has no computed style at all.
    const ms = parseFloat(getComputedStyle(figure).animationDuration) * 1000;
    return crossfade(ms, matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  #caption(slide: Keyed | null): void {
    // Each part in its own language, the box around them in none, so a
    // part whose language is null inherits the page's, not the other's.
    applyLang(this.#title, slide ? slide.captionLang : null);
    applyLang(this.#credit, slide ? slide.creditLang : null);
    this.#title.textContent = slide?.title ?? "";
    this.#credit.textContent = slide?.credit ?? "";
    this.#credit.hidden = !slide?.credit;
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
    this.#finishTransitions();
    // Where there is nowhere to go, the photo resists.
    const delta = (dx < 0 ? 1 : -1) * (this.#rtl() ? -1 : 1);
    const free = canStep(this.#from(), this.#slides.length, delta, this.loop);
    figure.style.setProperty("--clack-drag", `${free ? dx : dx * 0.25}px`);
  }

  #swiped(outcome: -1 | 0 | 1): void {
    const figure = this.#figure;
    if (!figure) {
      return;
    }
    const offset = parseFloat(figure.style.getPropertyValue("--clack-drag")) || 0;
    const delta = ((outcome === -1 ? 1 : -1) * (this.#rtl() ? -1 : 1)) as 1 | -1;
    const from = this.#from();
    const go = outcome !== 0 && canStep(from, this.#slides.length, delta, this.loop);
    if (go) {
      const target = step(from, this.#slides.length, delta, this.loop);
      const photo = this.#photos.get(this.#slides[target]!, this.#sizes(target), true);
      if (photo.state !== "loading") {
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
    figure.style.removeProperty("--clack-drag");
    if (offset !== 0) {
      figure.animate([{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }], {
        duration: 220,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }

  // ---- Size -------------------------------------------------------------

  #onResize(entries: ResizeObserverEntry[]): void {
    const box = entries[entries.length - 1]?.contentRect;
    if (!box) {
      return;
    }
    this.#frame = { width: box.width, height: box.height };
    this.#photos.resize((key) => this.#sizes(this.#indexByKey.get(key) ?? -1));
  }

  /** What the `sizes` of slide i's photo should say: the width it is drawn at. */
  #sizes(i: number): string {
    if (this.#frame.width === 0) {
      const r = this.#stage.getBoundingClientRect();
      this.#frame = { width: r.width, height: r.height };
    }
    const slide = this.#slides[i];
    const fit = this.getAttribute("fit") === "cover" ? "cover" : "contain";
    const w = slide ? drawnWidth(this.#frame.width, this.#frame.height, slide.width / slide.height, fit) : 0;
    return w > 0 ? `${w}px` : "100vw";
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
