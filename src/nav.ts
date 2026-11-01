/**
 * Where navigation leads, as plain functions of the numbers involved, so
 * the rules are tested without a DOM.
 */

/**
 * The slide `delta` steps from `index` in a show of `count`: wrapping round
 * when the show loops, and stopping at the first and last when it does not.
 */
export function step(index: number, count: number, delta: number, loop: boolean): number {
  if (count <= 0) {
    return 0;
  }
  const to = index + delta;
  if (loop) {
    return ((to % count) + count) % count;
  }
  return Math.min(Math.max(to, 0), count - 1);
}

/** Whether there is a slide `delta` steps away (always, when looping). */
export function canStep(index: number, count: number, delta: number, loop: boolean): boolean {
  return count > 1 && (loop || (index + delta >= 0 && index + delta < count));
}

/**
 * The slides worth loading ahead while `index` is shown, nearest first: the
 * next and the previous, then one more in the direction of travel. Each
 * appears once, and never `index` itself.
 */
export function preloadOrder(index: number, count: number, direction: 1 | -1, loop: boolean): number[] {
  const out: number[] = [];
  for (const delta of [direction, -direction, 2 * direction]) {
    if (!canStep(index, count, delta, loop)) {
      continue;
    }
    const i = step(index, count, delta, loop);
    if (i !== index && !out.includes(i)) {
      out.push(i);
    }
  }
  return out;
}

/**
 * The width, in CSS pixels, at which a photo of `aspect` (width / height)
 * is drawn in a frame of `frameWidth` by `frameHeight`: what its `sizes`
 * should say, so the browser fetches no more pixels than it shows. `cover`
 * fills the frame, cropping; `contain` fits the whole photo inside it.
 */
export function drawnWidth(frameWidth: number, frameHeight: number, aspect: number, fit: "contain" | "cover"): number {
  if (frameWidth <= 0 || frameHeight <= 0 || !(aspect > 0)) {
    return 0;
  }
  const byHeight = frameHeight * aspect;
  return Math.ceil(fit === "cover" ? Math.max(frameWidth, byHeight) : Math.min(frameWidth, byHeight));
}

/**
 * Whether a swipe that has moved `dx` pixels in a frame `width` wide, last
 * moving at `velocity` pixels per millisecond, should go on to the next
 * slide (-1 for a swipe to the left, which brings the next one; 1 for the
 * previous) or spring back (0). A long drag commits, and so does a short,
 * quick flick in the direction it was dragged.
 */
export function swipeOutcome(dx: number, velocity: number, width: number): -1 | 0 | 1 {
  const far = Math.abs(dx) > width * 0.2;
  const flick = Math.abs(velocity) > 0.35 && Math.sign(velocity) === Math.sign(dx) && Math.abs(dx) > 12;
  if (!far && !flick) {
    return 0;
  }
  return dx < 0 ? -1 : 1;
}
