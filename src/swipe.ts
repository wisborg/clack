/**
 * Swiping and dragging between photos, with touch, pen or mouse. A gesture
 * becomes a swipe only once it has moved further sideways than up or
 * down; until then it is the page's (to scroll, with touch-action: pan-y).
 */
import { swipeOutcome } from "./nav";

export interface SwipeHandlers {
  /** The photo follows the pointer: dx pixels from where it started. */
  move(dx: number): void;
  /** The gesture ended: -1 goes to the next slide, 1 to the previous, 0 springs back. */
  end(outcome: -1 | 0 | 1): void;
}

/** How far a pointer moves before it is a swipe or a scroll. */
const slop = 8;

/** Starts listening on target; returns the function that stops. */
export function listen(target: HTMLElement, handlers: SwipeHandlers): () => void {
  let id: number | null = null;
  let startX = 0;
  let startY = 0;
  let swiping = false;
  // Recent positions, for the speed at the moment of release.
  let samples: { x: number; t: number }[] = [];

  const reset = (): void => {
    id = null;
    swiping = false;
    samples = [];
  };

  const down = (e: PointerEvent): void => {
    if (id !== null || !e.isPrimary || e.button !== 0) {
      return;
    }
    id = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    samples = [{ x: e.clientX, t: e.timeStamp }];
  };

  const move = (e: PointerEvent): void => {
    if (e.pointerId !== id) {
      return;
    }
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!swiping) {
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) {
        return;
      }
      if (Math.abs(dy) >= Math.abs(dx)) {
        reset(); // a scroll, not a swipe
        return;
      }
      swiping = true;
      // Keep the gesture even if the pointer leaves the photo.
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic or already-released pointer cannot be captured; the
        // gesture still works while the pointer stays over the photo.
      }
    }
    e.preventDefault();
    samples.push({ x: e.clientX, t: e.timeStamp });
    // A tenth of a second is enough to know how fast it was going.
    while (samples.length > 2 && e.timeStamp - samples[0]!.t > 100) {
      samples.shift();
    }
    handlers.move(dx);
  };

  const up = (e: PointerEvent): void => {
    if (e.pointerId !== id) {
      return;
    }
    if (swiping) {
      const dx = e.clientX - startX;
      const first = samples[0]!;
      const elapsed = e.timeStamp - first.t;
      const velocity = elapsed > 0 ? (e.clientX - first.x) / elapsed : 0;
      handlers.end(e.type === "pointercancel" ? 0 : swipeOutcome(dx, velocity, target.clientWidth));
    }
    reset();
  };

  // A swipe that moved must not also count as a click on the photo.
  const click = (e: MouseEvent): void => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  };
  let suppressClick = false;
  const upCapture = (e: PointerEvent): void => {
    suppressClick = e.pointerId === id && swiping;
  };

  target.addEventListener("pointerdown", down);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", upCapture, { capture: true });
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
  target.addEventListener("click", click, { capture: true });
  return () => {
    target.removeEventListener("pointerdown", down);
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", upCapture, { capture: true });
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    target.removeEventListener("click", click, { capture: true });
  };
}
