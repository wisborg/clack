import { ClackShow, tagName } from "../src/clack";
import { assert, assertEqual, fixture, test } from "./harness";

function make(): ClackShow {
  const el = document.createElement(tagName);
  fixture().append(el);
  return el;
}

test("defines <clack-show>", () => {
  assertEqual(customElements.get(tagName), ClackShow, "the defined element");
});

test("styles its shadow root under the strict policy", () => {
  const el = make();
  // The theme's (base's, as none is named), then Clack's own.
  assertEqual(el.shadowRoot?.adoptedStyleSheets.length, 2, "adopted stylesheets");
  assertEqual(getComputedStyle(el).getPropertyValue("--clack-control-size"), "40px", "a token, from the theme");
  // A custom element is display: inline unless its own stylesheet says
  // otherwise, so this shows the sheet was applied, not merely adopted.
  assertEqual(getComputedStyle(el).display, "block", "display");
});

test("the hidden attribute hides it", () => {
  const el = make();
  el.hidden = true;
  assertEqual(getComputedStyle(el).display, "none", "display when hidden");
});

test("draws its slides in its own shadow root, not the page's", () => {
  const el = make();
  el.append(document.createElement("figure"));
  assertEqual(el.shadowRoot?.querySelector("slot"), null, "no <slot>: the markup is read, not shown");
  assert(el.shadowRoot?.querySelector(".stage"), "a stage for the photos");
});
