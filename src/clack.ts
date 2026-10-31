/**
 * Clack: a slideshow for photographs, as one custom element.
 *
 * This is the skeleton the toolchain is verified with -- an element that
 * defines itself, styles its shadow root and slots its children. The
 * component is built in phase 1, to docs/plan.md.
 */
import css from "./clack.css";

/** The element's tag name. */
export const tagName = "clack-show";

// One stylesheet, shared by every instance in the document.
let sheet: CSSStyleSheet | undefined;

function styles(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  }
  return sheet;
}

/** The `<clack-show>` element. */
export class ClackShow extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [styles()];
    root.append(document.createElement("slot"));
  }
}

// Defining twice throws; a page that loads Clack twice keeps the first.
if (!customElements.get(tagName)) {
  customElements.define(tagName, ClackShow);
}

declare global {
  interface HTMLElementTagNameMap {
    "clack-show": ClackShow;
  }
}
