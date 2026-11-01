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
import { fromInput, readMarkup, type Slide, type SlideInput } from "./slides";
import { listen } from "./swipe";

export const tagName = "clack-show";

/** The words Clack says. English for now; they will be translatable. */
const text = {
  show: "Photos",
  carousel: "carousel",
  slide: "slide",
  previous: "Previous photo",
  next: "Next photo",
  of: (n: number, count: number) => `${n} of ${count}`,
  announce: (n: number, count: number, title: string) => `Photo ${n} of ${count}${title ? `: ${title}` : ""}`,
  failed: "This photo could not be loaded.",
};

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

function el<K extends keyof HTMLElementTagNameMap>(name: K, className: string, part = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(name);
  e.className = className;
  if (part) e.setAttribute("part", part);
  return e;
}

/** A transition in progress, and what must happen when it ends, however it ends. */
interface Running {
  animations: Animation[];
  done: () => void;
}

/** The `<clack-show>` element. */
export class ClackShow extends HTMLElement {
  static readonly observedAttributes = ["loop", "fit", "label"];

  readonly #internals: ElementInternals;
  readonly #stage: HTMLDivElement;
  readonly #title: HTMLSpanElement;
  readonly #credit: HTMLSpanElement;
  readonly #counter: HTMLSpanElement;
  readonly #previous: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #live: HTMLDivElement;

  #slides: Slide[] = [];
  readonly #indexById = new Map<string, number>();
  /** Set when the slides came from script; markup is then not read. */
  #scripted = false;
  readonly #photos = new Photos();
  /** The slide asked for, which may still be loading. */
  #target = -1;
  /** The slide on screen, or -1 before the first is. */
  #shown = -1;
  #figure: HTMLElement | null = null;
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
    root.adoptedStyleSheets = [styles()];

    const show = el("div", "show", "show");
    // Focusable by a click (not by Tab), so the keys work after clicking
    // the photo; the controls are what Tab reaches.
    this.#stage = el("div", "stage", "stage");
    this.#stage.tabIndex = -1;

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

    show.append(this.#stage, below);
    root.append(show, this.#live);

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

  connectedCallback(): void {
    // A page may set a property before Clack is loaded: the value then sits
    // on the element itself, hiding the class's accessor, and is moved
    // through the accessor now.
    const own = this as unknown as Record<string, unknown>;
    for (const name of ["slides", "loop"]) {
      if (Object.hasOwn(this, name)) {
        const value = own[name];
        delete own[name];
        own[name] = value;
      }
    }
    this.#resize.observe(this.#stage);
    this.#stopSwipe = listen(this.#stage, {
      move: (dx) => this.#drag(dx),
      end: (outcome) => this.#swiped(outcome),
    });
    if (!this.#scripted) {
      this.#mutations.observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
      this.#readMarkup();
    }
  }

  disconnectedCallback(): void {
    this.#resize.disconnect();
    this.#mutations.disconnect();
    this.#stopSwipe?.();
    this.#stopSwipe = null;
    this.#finishTransitions();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    switch (name) {
      case "label":
        this.#internals.ariaLabel = value || text.show;
        break;
      case "loop":
        this.#updateControls();
        break;
      case "fit":
        this.#photos.resize((id) => this.#sizes(this.#indexById.get(id) ?? -1));
        break;
    }
  }

  // ---- The public interface -------------------------------------------

  /** The slides, as Clack reads them. */
  get slides(): readonly Readonly<Slide>[] {
    return this.#slides.map((s) => ({ ...s, alternatives: s.alternatives.map((a) => ({ ...a })) }));
  }

  /**
   * Gives the show its slides from script, in the manifest's slide format,
   * in place of its markup. Throws a TypeError naming the slide and the
   * problem if one cannot be shown. null goes back to reading the markup.
   */
  set slides(input: readonly SlideInput[] | null) {
    if (input === null) {
      this.#scripted = false;
      if (this.isConnected) {
        this.#mutations.observe(this, { childList: true, subtree: true, attributes: true, characterData: true });
        this.#readMarkup();
      }
      return;
    }
    const slides = fromInput(input);
    this.#scripted = true;
    this.#mutations.disconnect();
    this.#setSlides(slides);
  }

  /** The slide being shown, or about to be: its photo may still be loading. */
  get index(): number {
    return this.#target;
  }

  get count(): number {
    return this.#slides.length;
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
    const index = typeof slide === "number" ? slide : this.#slides.findIndex((s) => s.id === slide);
    if (!Number.isInteger(index) || index < 0 || index >= this.#slides.length) {
      return Promise.reject(new RangeError(`Clack: there is no slide ${JSON.stringify(slide)}`));
    }
    return this.#request(index, { user: false });
  }

  // ---- Slides ----------------------------------------------------------

  #readMarkup(): void {
    this.#setSlides(readMarkup(this, (m) => console.warn(`Clack: ${m}`)));
  }

  /**
   * Takes a new list of slides, keeping what it can: the visitor's place
   * (by slide id), the photo on screen if its slide is still there with the
   * same photo, and every other photo that has not changed. A caption fixed
   * or a slide added changes nothing on screen but the words and the count.
   */
  #setSlides(slides: Slide[]): void {
    const old = this.#slides;
    if (slides.length === old.length && slides.every((s, i) => JSON.stringify(s) === JSON.stringify(old[i]))) {
      return;
    }
    const keepId = old[this.#target]?.id;
    const shownSlide = old[this.#shown];
    this.#token++;
    this.#pending = null;
    this.#stage.classList.remove("loading");
    this.#slides = slides;
    this.#indexById.clear();
    slides.forEach((s, i) => this.#indexById.set(s.id, i));
    this.#photos.carryOver(slides);

    // Where the slide on screen is now, if it is still there unchanged.
    const shownAt = shownSlide ? (this.#indexById.get(shownSlide.id) ?? -1) : -1;
    this.#shown = shownAt >= 0 && photoKey(slides[shownAt]!) === photoKey(shownSlide!) ? shownAt : -1;
    if (this.#figure && this.#shown >= 0) {
      this.#figure.ariaLabel = text.of(this.#shown + 1, slides.length);
    }
    this.#target = -1;

    if (slides.length === 0) {
      this.#finishTransitions();
      this.#figure?.remove();
      this.#figure = null;
      this.#caption(null);
      this.#updateControls();
      return;
    }
    const at = Math.max(0, keepId === undefined ? 0 : (this.#indexById.get(keepId) ?? 0));
    if (at === this.#shown) {
      this.#target = at;
      this.#caption(slides[at]!);
      this.#updateControls();
      this.#preload(at);
      return;
    }
    // Whatever is on screen stays until the new slide's photo is ready.
    void this.#request(at, { user: false });
  }

  // ---- Navigation ------------------------------------------------------

  #go(delta: 1 | -1, how: How): Promise<boolean> {
    const from = this.#target < 0 ? 0 : this.#target;
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
      this.#token++;
      this.#pending = null;
      this.#target = target;
      this.#stage.classList.remove("loading");
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
    const photo = this.#photos.get(this.#slides[target]!, this.#sizes(target), true);
    // Let go of what is no longer near. What is ahead of the target is kept
    // if it is already coming, but not started until the target is on
    // screen (see #preload).
    const ahead = preloadOrder(target, this.#slides.length, this.#direction, this.loop);
    this.#photos.keepOnly(this.#ids([target, this.#shown, ...ahead]));
    this.#stage.classList.toggle("loading", photo.state === "loading");
    if (!this.#figure || this.#figure.classList.contains("placeholder")) {
      this.#placeholder(target);
    }
    const pending = photo.settled.then(() => {
      if (token !== this.#token) {
        return false;
      }
      this.#pending = null;
      this.#stage.classList.remove("loading");
      this.#display(target, photo, how);
      this.#preload(target);
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
    this.#photos.keepOnly(this.#ids([target, this.#shown, ...order]));
  }

  /** The ids of the slides at these indexes (any out of range left out). */
  #ids(indexes: number[]): Set<string> {
    const ids = new Set<string>();
    for (const i of indexes) {
      const slide = this.#slides[i];
      if (slide) ids.add(slide.id);
    }
    return ids;
  }

  /**
   * Holds the place of the first photo while it loads: a frame of its
   * proportions, in its colour if it has one, so the page does not wait on
   * an empty box. The photo fades in over it.
   */
  #placeholder(index: number): void {
    const slide = this.#slides[index]!;
    this.#figure?.remove();
    const figure = el("figure", "slide placeholder", "slide");
    figure.role = "group";
    figure.ariaRoleDescription = text.slide;
    figure.ariaLabel = text.of(index + 1, this.#slides.length);
    figure.ariaBusy = "true";
    figure.style.setProperty("--clack-aspect", String(slide.width / slide.height));
    if (slide.color) {
      // Checked as #rrggbb when the slide was read.
      figure.style.setProperty("--clack-placeholder", slide.color);
    }
    figure.append(el("div", "fill"));
    this.#stage.append(figure);
    this.#figure = figure;
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
      this.#announce(text.announce(index + 1, this.#slides.length, slide.title));
    }

    const duration = old ? this.#duration() : 0;
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

  #makeFigure(index: number, slide: Slide, photo: Photo): HTMLElement {
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

  /** The crossfade's length in milliseconds, from the theme, shortened when motion is reduced. */
  #duration(): number {
    const style = getComputedStyle(this);
    if (style.getPropertyValue("--clack-transition").trim() === "none") {
      return 0;
    }
    const value = style.getPropertyValue("--clack-transition-duration").trim();
    const m = /^([0-9.]+)(ms|s)$/.exec(value);
    let ms = m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : 700;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      ms = Math.min(ms, 200);
    }
    return Number.isFinite(ms) ? Math.min(ms, 3000) : 700;
  }

  #caption(slide: Slide | null): void {
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

  #announce(message: string): void {
    // Emptied first, so the same words twice are still read twice.
    this.#live.textContent = "";
    requestAnimationFrame(() => {
      this.#live.textContent = message;
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
    const free = canStep(this.#shown, this.#slides.length, delta, this.loop);
    figure.style.setProperty("--clack-drag", `${free ? dx : dx * 0.25}px`);
  }

  #swiped(outcome: -1 | 0 | 1): void {
    const figure = this.#figure;
    if (!figure) {
      return;
    }
    const offset = parseFloat(figure.style.getPropertyValue("--clack-drag")) || 0;
    const delta = ((outcome === -1 ? 1 : -1) * (this.#rtl() ? -1 : 1)) as 1 | -1;
    const go = outcome !== 0 && canStep(this.#shown, this.#slides.length, delta, this.loop);
    if (go) {
      const target = step(this.#shown, this.#slides.length, delta, this.loop);
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
    this.#photos.resize((id) => this.#sizes(this.#indexById.get(id) ?? -1));
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
