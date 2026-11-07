/**
 * Loading photos: each slide's `<img>` (in a `<picture>` when it has other
 * formats) is built once, fetched at the size it is drawn, and decoded
 * before anyone sees it, so a transition never reveals a half-painted
 * photo. Photos far from the current one are let go, cancelling their
 * download if it is still running.
 */
import { applyLang, type Keyed, type Slide } from "./slides";

/** "dropped": let go of before it arrived, and never to be shown. */
export type LoadState = "loading" | "ready" | "failed" | "dropped";

/** One slide's photo, built and on its way. */
export interface Photo {
  /** What goes in the slide: the `<picture>`, or the `<img>` alone. */
  readonly element: HTMLElement;
  readonly img: HTMLImageElement;
  /** What the photo was built from; another key is another photo. */
  readonly key: string;
  state: LoadState;
  /** Settles when the photo is decoded, has failed, or is dropped; never rejects. */
  readonly settled: Promise<LoadState>;
  /** Settles it as dropped, if it has not settled yet. */
  readonly drop: () => void;
  /** Gives it the size it is drawn at, and fetches it, if it has not been. */
  readonly start: (sizes: string) => void;
  /** Whether it has been: until it is, it is not fetched. */
  readonly started: boolean;
}

/** What makes a slide's photo the photo it is: a change to any of these is a new photo. */
export function photoKey(slide: Slide): string {
  return JSON.stringify([slide.src, slide.srcset, slide.alternatives, slide.width, slide.height]);
}

/**
 * A slide's photo, built but not yet fetched: start() gives it the size it
 * is drawn at, and its URLs, and the browser fetches it then.
 */
function build(slide: Slide): { element: HTMLElement; img: HTMLImageElement; start: (sizes: string) => void } {
  const img = document.createElement("img");
  img.alt = slide.alt;
  img.width = slide.width;
  img.height = slide.height;
  img.decoding = "async";
  img.draggable = false;
  img.setAttribute("part", "photo");
  // Into a <picture> (if it has other formats) before any URL is set: an
  // <img> chooses among its picture's sources only once it is in it, and
  // would otherwise start fetching its own candidate first.
  const sources = slide.alternatives.map((alt) => {
    const source = document.createElement("source");
    if (alt.type) source.type = alt.type;
    if (alt.media) source.media = alt.media;
    return source;
  });
  let element: HTMLElement = img;
  if (sources.length > 0) {
    element = document.createElement("picture");
    element.append(...sources, img);
  }
  const start = (sizes: string): void => {
    // sizes before srcset: the browser picks a candidate as soon as srcset
    // is set, and should pick it for the size the photo is drawn at.
    for (const [i, source] of sources.entries()) {
      source.sizes = sizes;
      source.srcset = slide.alternatives[i]!.srcset;
    }
    img.sizes = sizes;
    if (slide.srcset) img.srcset = slide.srcset;
    img.src = slide.src;
  };
  return { element, img, start };
}

/**
 * Waits until img has a decoded frame to show, or has failed. decode()
 * rejects for a broken image, and in some engines also when the request is
 * replaced (a larger candidate after a resize) though the image is fine,
 * so a rejection is checked against what actually loaded.
 */
async function settle(img: HTMLImageElement): Promise<LoadState> {
  try {
    await img.decode();
    return "ready";
  } catch {
    if (!img.complete) {
      await new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      });
    }
    return img.naturalWidth > 0 ? "ready" : "failed";
  }
}

/** The photos of one show, by slide key (see Keyed). */
export class Photos {
  readonly #photos = new Map<string, Photo>();

  /**
   * The photo for slide, building and starting it if need be. `urgent`
   * asks the browser to fetch it ahead of others. sizes is the size it is
   * drawn at, or null while that is not known -- a show out of the page, or
   * hidden -- when it is built but not fetched until resize() says.
   */
  get(slide: Keyed, sizes: string | null, urgent: boolean): Photo {
    let photo = this.#photos.get(slide.key);
    if (!photo) {
      const { element, img, start } = build(slide);
      img.fetchPriority = urgent ? "high" : "low";
      let begin = (): void => {};
      const begun = new Promise<void>((resolve) => {
        begin = resolve;
      });
      // A photo let go of while loading may never fire load or error (the
      // engine may not even stop the download), so dropping it settles it.
      let drop = (): void => {};
      const dropped = new Promise<LoadState>((resolve) => {
        drop = () => resolve("dropped");
      });
      const settled = Promise.race([begun.then(() => settle(img)), dropped]);
      let started = false;
      const p: Photo = {
        element,
        img,
        key: photoKey(slide),
        state: "loading",
        settled,
        drop,
        start: (s) => {
          if (started) return;
          started = true;
          start(s);
          begin();
        },
        get started() {
          return started;
        },
      };
      void settled.then((state) => {
        p.state = state;
      });
      if (sizes !== null) p.start(sizes);
      photo = p;
      this.#photos.set(slide.key, photo);
    } else if (urgent) {
      photo.img.fetchPriority = "high";
    }
    return photo;
  }

  /** The photo for a slide's key, if there is one; nothing is built or started. */
  peek(key: string): Photo | undefined {
    return this.#photos.get(key);
  }

  /**
   * Sets the size every photo is drawn at; the browser fetches more pixels
   * only if it needs them. One not yet fetched, for want of its size, is
   * fetched now.
   */
  resize(sizes: (key: string) => string): void {
    for (const [key, photo] of this.#photos) {
      const s = sizes(key);
      if (!photo.started) {
        photo.start(s);
      } else if (photo.img.sizes !== s) {
        for (const source of photo.element.querySelectorAll("source")) {
          source.sizes = s;
        }
        photo.img.sizes = s;
      }
    }
  }

  /**
   * Lets go of every photo but those of the slides in keep. One still
   * loading stops, and none is drawn again without being fetched afresh
   * (the browser's cache usually answers). One on screen stays there until
   * it is replaced.
   */
  keepOnly(keep: ReadonlySet<string>): void {
    for (const [id, photo] of this.#photos) {
      if (!keep.has(id)) {
        this.#let(id, photo);
      }
    }
  }

  /**
   * The slides have changed: keeps each photo whose slide is still there
   * with the same photo (its alt text brought up to date), and lets go of
   * the rest.
   */
  carryOver(slides: readonly Keyed[]): void {
    const now = new Map(slides.map((s) => [s.key, s]));
    for (const [id, photo] of this.#photos) {
      const slide = now.get(id);
      if (slide && photoKey(slide) === photo.key) {
        // The same photo, perhaps described anew, perhaps in another
        // language: the description and its language follow the slide.
        photo.img.alt = slide.alt;
        applyLang(photo.img, slide.lang);
      } else {
        this.#let(id, photo);
      }
    }
  }

  #let(id: string, photo: Photo): void {
    if (photo.state === "loading" && !photo.element.isConnected) {
      // An empty URL drops the request. Firefox then stops the download;
      // Chrome and Safari (2026) finish it into their cache, which no way
      // of letting go of the image changes -- hence preloading only once a
      // photo is on screen, so skipping through slides does not start
      // downloads nobody will see.
      for (const source of photo.element.querySelectorAll("source")) {
        source.srcset = "";
      }
      photo.img.srcset = "";
      photo.img.src = "";
    }
    photo.drop();
    this.#photos.delete(id);
  }
}
