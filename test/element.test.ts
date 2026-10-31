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
  assertEqual(el.shadowRoot?.adoptedStyleSheets.length, 1, "adopted stylesheets");
  // A custom element is display: inline unless its own stylesheet says
  // otherwise, so this shows the sheet was applied, not merely adopted.
  assertEqual(getComputedStyle(el).display, "block", "display");
});

test("the hidden attribute hides it", () => {
  const el = make();
  el.hidden = true;
  assertEqual(getComputedStyle(el).display, "none", "display when hidden");
});

test("slots the photos it is given", () => {
  const el = make();
  el.append(document.createElement("figure"));
  const slot = el.shadowRoot?.querySelector("slot");
  assert(slot, "no <slot> in the shadow root");
  assertEqual(slot.assignedElements().length, 1, "assigned elements");
});
