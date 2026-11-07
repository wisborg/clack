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

/** A gesture being listened for: stop listening, or cancel the one under way. */
export interface Swipes {
  stop(): void;
  /**
   * Ends the gesture under way, if any, without its end: the rest of it is
   * not heard -- as when what it was dragging has gone.
   */
  cancel(): void;
}

/** Starts listening on target. */
export function listen(target: HTMLElement, handlers: SwipeHandlers): Swipes {
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
    // Captured from the start, so a pointer released outside the photo
    // still ends the gesture here rather than leaving it open.
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer cannot be captured; see move().
    }
  };

  const move = (e: PointerEvent): void => {
    if (e.pointerId !== id) {
      return;
    }
    // A mouse whose button was let go of where this element did not hear it
    // (when it could not be captured) has ended its gesture: a swipe of it
    // springs back, as a cancelled one does.
    if (e.pointerType === "mouse" && e.buttons === 0) {
      if (swiping) handlers.end(0);
      reset();
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
      // Cancelled, or capture lost without a release: spring back.
      handlers.end(e.type === "pointerup" ? swipeOutcome(dx, velocity, target.clientWidth) : 0);
    }
    reset();
  };

  // A swipe that moved must not also count as a click on the photo. Only
  // the click that follows the swipe straight away is its own: a touch
  // swipe is often followed by none, and a later click -- from a tap, the
  // keyboard or a script -- is not the swipe's.
  let swipeEnded = -Infinity;
  const click = (e: MouseEvent): void => {
    if (e.timeStamp - swipeEnded < 400) {
      e.stopPropagation();
      e.preventDefault();
      swipeEnded = -Infinity;
    }
  };
  const upCapture = (e: PointerEvent): void => {
    if (e.pointerId === id && swiping) {
      swipeEnded = e.timeStamp;
    }
  };

  target.addEventListener("pointerdown", down);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", upCapture, { capture: true });
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
  target.addEventListener("lostpointercapture", up);
  target.addEventListener("click", click, { capture: true });
  return {
    stop() {
      target.removeEventListener("pointerdown", down);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", upCapture, { capture: true });
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      target.removeEventListener("lostpointercapture", up);
      target.removeEventListener("click", click, { capture: true });
    },
    cancel: reset,
  };
}
