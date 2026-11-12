// The visitor's own pointer and keys, given by the WebDriver session the
// tests run under (input in ./harness): what the browser acts on as on a
// visitor's -- :hover, Tab moving focus, :focus-visible as a click or a key
// leaves it -- which no event a script makes can have it do.
import { assert, fixture, focusWindow, input, mouse, skip, type Action } from "./harness";

/** WebDriver's code points for the keys the tests press (its spec's "keyboard actions" table). */
export const Key = {
  Tab: "\uE004",
  Shift: "\uE008",
  Alt: "\uE00A",
  ArrowLeft: "\uE012",
  ArrowRight: "\uE014",
} as const;

/**
 * Where in the viewport the mouse goes to be over e: its centre, or a
 * point that far from its top left, in the whole pixels the driver takes.
 * The point must be e's, not something drawn over it, as the visitor's
 * pointer would find.
 */
export function pointOn(e: Element, at?: { x: number; y: number }): { x: number; y: number } {
  e.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = e.getBoundingClientRect();
  const x = Math.floor(r.left + (at ? at.x : r.width / 2));
  const y = Math.floor(r.top + (at ? at.y : r.height / 2));
  const root = e.getRootNode() as Document | ShadowRoot;
  const hit = root.elementFromPoint(x, y);
  assert(hit && (hit === e || e.contains(hit)), `the point (${x}, ${y}) is over ${hit?.nodeName ?? "nothing"}, not the ${e.nodeName} it is to be over`);
  return { x, y };
}

/** Moves the mouse over e (pointOn), as the visitor's. */
export function moveTo(e: Element, at?: { x: number; y: number }): Promise<void> {
  return input([mouse([{ type: "pointerMove", ...pointOn(e, at) }])]);
}

/**
 * Presses the mouse at the point that far into e, moves it by dx in ms,
 * and lets it go, as the visitor's drag.
 */
export function drag(e: Element, at: { x: number; y: number }, dx: number, ms: number): Promise<void> {
  const from = pointOn(e, at);
  return input([
    mouse([
      { type: "pointerMove", ...from },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", x: from.x + dx, y: from.y, duration: ms },
      { type: "pointerUp", button: 0 },
    ]),
  ]);
}

/** Moves the mouse over e and clicks it, as the visitor's. */
export function click(e: Element): Promise<void> {
  return input([mouse([{ type: "pointerMove", ...pointOn(e) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }])]);
}

/** Presses each of keys and lets it go, one after another, as the visitor's keyboard. */
export function press(...keys: string[]): Promise<void> {
  const actions: Action[] = keys.flatMap((value) => [
    { type: "keyDown", value },
    { type: "keyUp", value },
  ]);
  return input([{ type: "key", id: "keyboard", actions }]);
}

/** Presses the last of keys with the others held, as Shift-Tab. */
export function chord(...keys: string[]): Promise<void> {
  const held = keys.slice(0, -1);
  const key = keys[keys.length - 1]!;
  const actions: Action[] = [
    ...held.map((value): Action => ({ type: "keyDown", value })),
    { type: "keyDown", value: key },
    { type: "keyUp", value: key },
    ...held.reverse().map((value): Action => ({ type: "keyUp", value })),
  ];
  return input([{ type: "key", id: "keyboard", actions }]);
}

/** The keys that take focus from one control to the next, once found (tabber). */
let tabKeys: string[] | null = null;

/**
 * Finds how this engine's keyboard takes focus from control to control,
 * and returns that, as a key: Tab -- or Option-Tab in Safari, whose Tab
 * goes only from field to field unless the visitor asks otherwise, as its
 * keyboard users do. Finding it moves focus: called at the start of a
 * test, before focus is anywhere the test watches.
 */
export async function tabber(): Promise<(backwards?: boolean) => Promise<void>> {
  if (!(await focusWindow())) skip("this engine's window does not take the focus, so the keyboard moves no focus in it");
  if (!tabKeys) {
    const at = fixture();
    const from = document.createElement("input");
    const to = document.createElement("button");
    to.textContent = "to";
    at.append(from, to);
    try {
      for (const keys of [[Key.Tab], [Key.Alt, Key.Tab]]) {
        // A Tab that went past the page, to the browser's own toolbar,
        // took the window's focus with it.
        await focusWindow();
        from.focus();
        await chord(...keys);
        if (document.activeElement === to) {
          tabKeys = keys;
          break;
        }
      }
    } finally {
      at.remove();
    }
    if (!tabKeys) skip("neither Tab nor Option-Tab takes focus from a field to a button here: the system's keyboard navigation is off");
  }
  const keys = tabKeys;
  return (backwards = false) => chord(...(backwards ? [Key.Shift, ...keys] : keys));
}
