/**
 * Clack: a slideshow for photographs that any website can embed.
 *
 * Importing this module defines `<clack-show>`. See docs/plan.md for the
 * design it is built to.
 */
import { ClackShow, tagName } from "./show";

export { ClackShow, tagName };
export type { SlideChangeDetail } from "./show";
export type { Slide, SlideInput } from "./slides";

// Defining twice throws; a page that loads Clack twice keeps the first.
if (!customElements.get(tagName)) {
  customElements.define(tagName, ClackShow);
}
