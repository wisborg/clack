/**
 * Loading photos: each slide's `<img>` (in a `<picture>` when it has other
 * formats) is built once, fetched at the size it is drawn, and decoded
 * before anyone sees it, so a transition never reveals a half-painted
 * photo. Photos far from the current one are let go, cancelling their
 * download if it is still running.
 */
import type { Slide } from "./slides";

/** "dropped": let go of before it arrived, and never to be shown. */
export type LoadState = "loading" | "ready" | "failed" | "dropped";

/** One slide's photo, built and on its way. */
export interface Photo {
  /** What goes in the slide: the `<picture>`, or the `<img>` alone. */
  readonly element: HTMLElement;
  readonly img: HTMLImageElement;
  state: LoadState;
  /** Settles when the photo is decoded, has failed, or is dropped; never rejects. */
  readonly settled: Promise<LoadState>;
  /** Settles it as dropped, if it has not settled yet. */
  readonly drop: () => void;
}

function build(slide: Slide, sizes: string): { element: HTMLElement; img: HTMLImageElement } {
  const img = document.createElement("img");
  img.alt = slide.alt;
  img.width = slide.width;
  img.height = slide.height;
  img.decoding = "async";
  img.draggable = false;
  img.setAttribute("part", "photo");
  // sizes before srcset: the browser picks a candidate as soon as srcset is
  // set, and should pick it for the size the photo is drawn at.
  img.sizes = sizes;
  if (slide.alternatives.length === 0) {
    if (slide.srcset) img.srcset = slide.srcset;
    img.src = slide.src;
    return { element: img, img };
  }
  const picture = document.createElement("picture");
  for (const alt of slide.alternatives) {
    const source = document.createElement("source");
    if (alt.type) source.type = alt.type;
    if (alt.media) source.media = alt.media;
    source.sizes = sizes;
    source.srcset = alt.srcset;
    picture.append(source);
  }
  // Into the <picture> before its URLs are set: an <img> chooses among its
  // picture's sources only once it is in it, and would otherwise start
  // fetching its own candidate first.
  picture.append(img);
  if (slide.srcset) img.srcset = slide.srcset;
  img.src = slide.src;
  return { element: picture, img };
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

/** The photos of one show, by slide index. */
export class Photos {
  readonly #photos = new Map<number, Photo>();

  /**
   * The photo for slides[index], building and starting it if need be.
   * `urgent` asks the browser to fetch it ahead of others.
   */
  get(slides: readonly Slide[], index: number, sizes: string, urgent: boolean): Photo {
    let photo = this.#photos.get(index);
    if (!photo) {
      const slide = slides[index];
      if (!slide) {
        throw new RangeError(`no slide ${index}`);
      }
      const { element, img } = build(slide, sizes);
      img.fetchPriority = urgent ? "high" : "low";
      // A photo let go of while loading may never fire load or error (the
      // engine may not even stop the download), so dropping it settles it.
      let drop = (): void => {};
      const dropped = new Promise<LoadState>((resolve) => {
        drop = () => resolve("dropped");
      });
      const settled = Promise.race([settle(img), dropped]);
      const p: Photo = { element, img, state: "loading", settled, drop };
      void settled.then((state) => {
        p.state = state;
      });
      photo = p;
      this.#photos.set(index, photo);
    } else if (urgent) {
      photo.img.fetchPriority = "high";
    }
    return photo;
  }

  /** Sets the size every photo is drawn at; the browser fetches more pixels only if it needs them. */
  resize(sizes: (index: number) => string): void {
    for (const [index, photo] of this.#photos) {
      const s = sizes(index);
      if (photo.img.sizes !== s) {
        for (const source of photo.element.querySelectorAll("source")) {
          source.sizes = s;
        }
        photo.img.sizes = s;
      }
    }
  }

  /**
   * Lets go of every photo but those in keep: one still loading stops, and
   * none is drawn again without being fetched afresh (the browser's cache
   * usually answers).
   */
  keepOnly(keep: ReadonlySet<number>): void {
    for (const [index, photo] of this.#photos) {
      if (keep.has(index) || photo.element.isConnected) {
        continue;
      }
      if (photo.state === "loading") {
        // An empty URL drops the request. Firefox then stops the download;
        // Chrome and Safari (2026) finish it into their cache, which no
        // way of letting go of the image changes -- hence preloading only
        // once a photo is on screen, so skipping through slides does not
        // start downloads nobody will see.
        for (const source of photo.element.querySelectorAll("source")) {
          source.srcset = "";
        }
        photo.img.srcset = "";
        photo.img.src = "";
        photo.drop();
      }
      this.#photos.delete(index);
    }
  }

  /** Forgets every photo: the slides have changed. */
  clear(): void {
    this.keepOnly(new Set());
    this.#photos.clear();
  }
}
