// What a theme puts around the photo: the caption card, floating controls,
// controls shown only for the visitor's activity, and how one photo gives
// way to the next.
import type { ClackShow, SlideInput } from "../src/clack";
import { shadowReach, transitionFrames, transitionOf } from "../src/show";
import { assert, assertEqual, fixture, skip, sleep, test } from "./harness";
import { figures, imageLog, img, logged, makeShow, part, pointer, resetImageLog, settledOn, showBox as box, themed, waitFor } from "./util";

/** Whether the visitor could see and point at the controls now. */
function shown(e: Element): boolean {
  const style = getComputedStyle(e);
  return style.pointerEvents !== "none" && style.opacity !== "0";
}

/**
 * Focuses e as the keyboard would, or a click (as far as :focus-visible,
 * which the show goes by, can tell), or skips where the engine cannot be
 * told which, or fires no focus events at all.
 */
function focusAs(e: HTMLElement, keyboard: boolean): void {
  if (!document.hasFocus()) skip("this engine's window does not have focus, so focusing fires no focus event, as it would for a visitor's keyboard");
  e.focus({ focusVisible: keyboard } as FocusOptions);
  if (e.matches(":focus-visible") === keyboard) return;
  e.blur();
  skip(`this engine does not take focus({ focusVisible: ${keyboard} }), so cannot be shown focus as ${keyboard ? "the keyboard's" : "a click's"}`);
}

// ---- The caption card ------------------------------------------------------

test("in mat, the caption is a card in the label's colours", async () => {
  const show = makeShow([{ title: "Low tide", credit: "Someone" }], { theme: "mat" });
  await settledOn(show, "1 of 1");
  const caption = getComputedStyle(part(show, ".caption"));
  // Mat's label: #f7f6f2 in light, #f1efe9 in dark; its text the same in both.
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  assertEqual(caption.backgroundColor, dark ? "rgb(241, 239, 233)" : "rgb(247, 246, 242)", "the label's colour");
  assertEqual(getComputedStyle(part(show, ".title")).color, "rgb(29, 29, 31)", "its text (#1d1d1f)");
  assertEqual(getComputedStyle(part(show, ".credit")).color, "rgb(107, 107, 112)", "its credit (#6b6b70)");
  assertEqual(getComputedStyle(part(show, ".title")).fontStyle, "italic", "mat's caption type");
});

test("no card is drawn where there is no caption to put on one", async () => {
  const none = makeShow([{}, {}], { theme: "mat" });
  await settledOn(none, "1 of 2");
  assertEqual(getComputedStyle(part(none, ".caption")).backgroundColor, "rgba(0, 0, 0, 0)", "a show with no captions: no card");
  const some = makeShow([{ title: "One" }, {}], { theme: "mat" });
  await settledOn(some, "1 of 2");
  await some.next();
  await settledOn(some, "2 of 2");
  assertEqual(getComputedStyle(part(some, ".caption")).visibility, "hidden", "a slide with none, in a show with some: its place kept, unseen");
});

// ---- Floating controls -----------------------------------------------------

test("floating, the caption and controls are a bar over the foot of the stage, which the photo has all of", async () => {
  const show = makeShow([{ title: "Wide", width: 300, height: 100 }], { theme: "minimal" });
  show.style.width = "800px"; // wider than a narrow show's 640px
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(Math.abs(stage.height - host.height) < 1, `the stage, ${stage.height} tall, as tall as the show, ${host.height}`);
  const bar = part(show, ".below").getBoundingClientRect();
  assert(bar.bottom < host.bottom && bar.top > host.top + host.height / 2, `the bar, ${bar.top}–${bar.bottom}, over the foot of ${host.top}–${host.bottom}`);
  assert(Math.abs(bar.left + bar.width / 2 - (host.left + host.width / 2)) < 1, "centred");
  assert(getComputedStyle(part(show, ".caption")).display !== "none", "the caption on it");
});

test("on a narrow show, the floating bar runs from side to side, the caption on a line of its own above the controls", async () => {
  const theme = themed("minimal-always-narrow", { extends: "minimal", controls: { reveal: "always" } });
  const show = makeShow([{ title: "Narrow" }], { theme });
  show.style.width = "360px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const bar = part(show, ".below").getBoundingClientRect();
  assert(Math.abs(bar.left - host.left - 12) < 1 && Math.abs(host.right - bar.right - 12) < 1, `the bar ${bar.left - host.left}px and ${host.right - bar.right}px from the sides`);
  const caption = part(show, ".caption").getBoundingClientRect();
  const controls = part(show, ".controls").getBoundingClientRect();
  assert(caption.width > 200 && caption.bottom <= controls.top, `the caption, ${caption.width}px wide, above the controls`);
  assert(caption.top >= bar.top && controls.bottom <= bar.bottom, "both on the bar");
  assert(shown(part(show, ".caption")) && getComputedStyle(part(show, ".caption")).visibility === "visible", "seen, as a caption is");
});

// ---- Shown for the visitor's activity ---------------------------------------

test("controls shown only for activity appear when the pointer moves, and go a few seconds after", async () => {
  const show = makeShow([{}, {}], { theme: "darkroom" });
  await settledOn(show, "1 of 2");
  const controls = part(show, ".controls");
  assert(!shown(controls), "unseen, and not in the pointer's way, before any activity");
  const p = pointer(show);
  p.send("pointermove", p.left + 10, { buttons: 0 });
  await waitFor(() => shown(controls), "shown when the pointer moves");
  await sleep(3300);
  assert(!shown(controls), "gone a few seconds after");
});

test("controls shown only for activity are still there for the keyboard, and shown while focus is among them", async () => {
  const show = makeShow([{}, {}], { theme: "darkroom" });
  await settledOn(show, "1 of 2");
  const next = part(show, ".next") as HTMLButtonElement;
  // Focusable, unseen as it is: not hidden from the keyboard, as display
  // none, visibility hidden or inert would hide it.
  next.focus();
  assertEqual(show.shadowRoot!.activeElement, next, "focusable while unseen");
  next.blur();
  // Tabbed to.
  focusAs(next, true);
  await waitFor(() => shown(part(show, ".controls")), "shown with focus among them");
  // Long after the activity that focusing them was.
  await sleep(3300);
  assert(shown(part(show, ".controls")), "still, while focus is among them");
  next.blur();
});

test("floating controls shown only for activity go, and the bar with them, but the caption stays, in a box of its own", async () => {
  const show = makeShow([{ title: "A" }, {}], { theme: "minimal" });
  await settledOn(show, "1 of 2");
  assertEqual(getComputedStyle(part(show, ".controls")).opacity, "0", "the controls unseen");
  const below = part(show, ".below");
  assertEqual(getComputedStyle(below, "::before").opacity, "0", "no bar drawn");
  assertEqual(getComputedStyle(below).pointerEvents, "none", "nor in the pointer's way");
  const caption = part(show, ".caption");
  assert(getComputedStyle(caption).opacity === "1" && getComputedStyle(below).opacity === "1" && getComputedStyle(caption).visibility === "visible", "the caption still seen, as a caption is");
  assertEqual(getComputedStyle(caption, "::before").opacity, "1", "on a box of the bar's surface, not on the bare photo");
  // Once the visitor is here, the bar is back, and the caption's box goes into it.
  const p = pointer(show);
  p.send("pointermove", p.left + 10, { buttons: 0 });
  await waitFor(() => shown(part(show, ".controls")), "the controls shown when the pointer moves");
  await waitFor(() => getComputedStyle(caption, "::before").opacity === "0", "the caption on the bar again");
  const none = makeShow([{}, {}], { theme: "minimal" });
  await settledOn(none, "1 of 2");
  assert(!shown(part(none, ".below")), "a show with no captions: the whole bar unseen");
  const always = makeShow([{ title: "A" }, {}], { theme: themed("minimal-always", { extends: "minimal", controls: { reveal: "always" } }) });
  await waitFor(() => box(always).dataset["reveal"] === "always", "the theme");
  await settledOn(always, "1 of 2");
  assert(shown(part(always, ".below")), "always shown, where the theme says so");
});

// ---- How one photo gives way to the next -----------------------------------

test("a slide moves the photos along: the next comes in from the side the last leaves by", () => {
  const forward = transitionFrames("slide", -1, null);
  assertEqual(`${forward.incoming[0]!.transform} ${forward.outgoing[1]!.transform}`, "translateX(100%) translateX(-100%)", "the next, from the right; the last, to the left");
  const back = transitionFrames("slide", 1, null);
  assertEqual(`${back.incoming[0]!.transform} ${back.outgoing[1]!.transform}`, "translateX(-100%) translateX(100%)", "back: the other way");
  const swiped = transitionFrames("slide", -1, -80);
  assertEqual(swiped.outgoing[0]!.transform, "translateX(-80px)", "a swiped photo goes on from where the finger let go");
  assertEqual(transitionFrames("crossfade", -1, null).incoming.map((k) => k.opacity).join(), "0,1", "a crossfade fades");
});

test("with reduced motion, nothing slides: a short crossfade instead; and none is none", () => {
  assertEqual(JSON.stringify(transitionOf("slide", 600, false)), '{"type":"slide","ms":600}', "a slide");
  assertEqual(JSON.stringify(transitionOf("slide", 600, true)), '{"type":"crossfade","ms":200}', "reduced: a short crossfade");
  assertEqual(JSON.stringify(transitionOf("crossfade", 600, false)), '{"type":"crossfade","ms":600}', "a crossfade");
  assertEqual(transitionOf("none", 600, false), null, "none");
  assertEqual(transitionOf("slide", 0, false), null, "no time: none");
});

/** The next photo shown on a show whose theme slides, and its own and the last one's transforms as they start. */
async function slideOn(show: ClackShow): Promise<{ incoming: string; outgoing: string; cut: string }> {
  // Long enough to be seen as it starts (the tests' shows are quick).
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 2");
  await sleep(200); // the next preloaded
  const leaving = figures(show)[0]!;
  void show.next();
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const coming = figures(show).find((f) => f !== leaving)!;
  const frames = (f: Element): ComputedKeyframe[] => (f.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  const outgoing = frames(leaving);
  return { incoming: String(frames(coming)[0]!["transform"]), outgoing: String(outgoing[outgoing.length - 1]!["transform"]), cut: getComputedStyle(box(show)).overflowX };
}

test("a theme that slides moves the photos along, cut off at the show's sides as they go", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding", { transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{}, {}], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  const { incoming, outgoing, cut } = await slideOn(show);
  // A whole stage and more (past the show's margin: see below).
  assert(/^translateX\((calc\()?100%/.test(incoming) && /^translateX\((calc\()?-100%/.test(outgoing), `the next in from the right, the last out to the left: ${incoming}, ${outgoing}`);
  assertEqual(cut, "clip", "cut off at the sides as they go");
  await settledOn(show, "2 of 2");
  await waitFor(() => getComputedStyle(box(show)).overflowX === "visible", "nothing cut off once they have gone");
});

test("where the text runs right to left, the next slides in from the left", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-rtl", { transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{}, {}], { theme, dir: "rtl" });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  const { incoming, outgoing } = await slideOn(show);
  assert(/^translateX\((calc\()?-100%/.test(incoming) && /^translateX\((calc\()?100%/.test(outgoing), `the next in from the left, the last out to the right: ${incoming}, ${outgoing}`);
});

test("controls focused by a click or a tap, not the keyboard, still go -- though keys follow", async () => {
  const show = makeShow([{}, {}, {}], { theme: "darkroom" });
  await settledOn(show, "1 of 3");
  const p = pointer(show);
  p.send("pointermove", p.left + 10, { buttons: 0 });
  // As a click leaves it: pressed, then focused, not as the keyboard's.
  const next = part(show, ".next") as HTMLButtonElement;
  next.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true, composed: true }));
  focusAs(next, false);
  assertEqual(show.shadowRoot!.activeElement, next, "focused");
  // Keys follow: Chrome and Firefox take the focus for the keyboard's
  // then, which is not what keeps the controls up.
  show.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await sleep(3300);
  assert(!shown(part(show, ".controls")), "gone a few seconds after the last key, focus or not");
  next.blur();
});

test("the first photo, and a new photo of the slide on screen, fade in rather than slide", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-first", { transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([], { theme });
  show.style.setProperty("--clack-transition-duration", "600ms");
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.slides = [{ id: "a", alt: "first", width: 300, height: 200, sources: [{ url: img(300, 200, "6688aa", 800), width: 300 }] }];
  await waitFor(() => figures(show).some((f) => f.getAnimations().length > 0), "the photo to come in");
  const coming = figures(show).find((f) => !f.classList.contains("placeholder"))!;
  const frames = (coming.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  assertEqual(`${frames[0]!["opacity"]} ${frames[0]!["transform"] ?? ""}`, "0 ", "faded in, in place");
  await settledOn(show, "1 of 1");
});

test("a slide after a swipe brings the next in beside the last, where the finger let it go", () => {
  const swiped = transitionFrames("slide", -1, -80);
  assertEqual(swiped.incoming[0]!.transform, "translateX(calc(-80px + 100%))", "beside it, not a stage away");
});

test("the floating bar is in the stage, at its foot, whatever the layout's margins", async () => {
  const theme = themed("gallery-floating", { extends: "gallery", controls: { style: "floating", reveal: "always" } });
  const show = makeShow([{ title: "Gallery" }], { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["controls"] === "floating", "the theme");
  await settledOn(show, "1 of 1");
  const stage = part(show, ".stage").getBoundingClientRect();
  const bar = part(show, ".below").getBoundingClientRect();
  assert(bar.bottom <= stage.bottom && bar.bottom > stage.bottom - 30, `the bar's foot, ${bar.bottom}, at the stage's, ${stage.bottom}`);
});

test("the floating bar is of one width whatever the title, so its controls stay under the pointer", async () => {
  const theme = themed("minimal-always-2", { extends: "minimal", controls: { reveal: "always" } });
  const long = "Houses above the harbour, at dusk, from the old customs house on the far side of the water";
  const show = makeShow([{ title: long }, { title: "Dusk" }], { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 2");
  const before = part(show, ".next").getBoundingClientRect();
  await show.next();
  await settledOn(show, "2 of 2");
  const after = part(show, ".next").getBoundingClientRect();
  assertEqual(`${after.left},${after.top}`, `${before.left},${before.top}`, "Next where it was, from a caption of two lines to one");
});

test("a floating bar with no captions is the controls alone, as wide as they are", async () => {
  const theme = themed("minimal-always-3", { extends: "minimal", controls: { reveal: "always" } });
  const show = makeShow([{}, {}], { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 2");
  const bar = getComputedStyle(part(show, ".below"));
  assertEqual(`${bar.paddingLeft} ${bar.paddingRight}`, "8px 8px", "even on both sides");
  assertEqual(getComputedStyle(part(show, ".caption")).display, "none", "no caption on it");
});


test("where the text runs right to left, the floating bar's wider side is the caption's", async () => {
  const theme = themed("minimal-always-rtl", { extends: "minimal", controls: { reveal: "always" } });
  const show = makeShow([{ title: "كورنيش" }], { theme, dir: "rtl" });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 1");
  const bar = part(show, ".below").getBoundingClientRect();
  const caption = part(show, ".caption").getBoundingClientRect();
  const controls = part(show, ".controls").getBoundingClientRect();
  assert(Math.abs(bar.right - caption.right - 8) < 1, `the caption at the right, ${bar.right - caption.right}px in`);
  assert(Math.abs(controls.left - bar.left - 8) < 1, `the controls at the left, ${controls.left - bar.left}px in`);
  assertEqual(getComputedStyle(part(show, ".caption")).paddingRight, "10px", "its text 18px in, with the caption's own 10px");
});

test("a theme that shows no credit draws no card for a slide with only a credit", async () => {
  const theme = themed("mat-uncredited", { extends: "mat", caption: { credit: false } });
  const show = makeShow([{ credit: "Someone" }, { credit: "Someone else" }], { theme });
  await waitFor(() => box(show).dataset["showCredit"] === "false", "the theme");
  await settledOn(show, "1 of 2");
  assertEqual(getComputedStyle(part(show, ".caption")).backgroundColor, "rgba(0, 0, 0, 0)", "no card");
});

test("a change of theme redraws the caption card: none for a slide whose only words the theme does not show, and back", async () => {
  const show = makeShow([{ credit: "Someone" }, { title: "Titled" }], { theme: "mat" });
  await settledOn(show, "1 of 2");
  const caption = part(show, ".caption");
  assertEqual(getComputedStyle(caption).visibility, "visible", "mat shows the credit, on its card");
  show.theme = themed("mat-uncredited-2", { extends: "mat", caption: { credit: false } });
  await waitFor(() => box(show).dataset["showCredit"] === "false", "the theme");
  assertEqual(getComputedStyle(caption).visibility, "hidden", "a theme that shows no credit: no card with nothing on it");
  show.theme = "mat";
  assertEqual(getComputedStyle(caption).visibility, "visible", "mat again: the credit on its card again");
  show.theme = themed("mat-uncredited-2", { extends: "mat", caption: { credit: false } });
  await waitFor(() => box(show).dataset["showCredit"] === "false", "the theme again");
  await show.next();
  await settledOn(show, "2 of 2");
  assertEqual(getComputedStyle(caption).visibility, "visible", "a title, on its card, credit or not");
});

test("on the floating bar, a long title or credit is shown whole, on more lines, short of the controls", async () => {
  const theme = themed("minimal-credited", { extends: "minimal", caption: { credit: true }, controls: { reveal: "always" } });
  const long = "Photograph by Someone With a Long Name, courtesy of Some Very Long Archive Name Indeed";
  const show = makeShow([{ title: long, credit: long }], { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["showCredit"] === "true" && box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 1");
  const controls = part(show, ".controls").getBoundingClientRect();
  const bar = part(show, ".below").getBoundingClientRect();
  assert(controls.right <= bar.right, `the controls, to ${controls.right}, still on the bar, to ${bar.right}: not pushed off it`);
  for (const name of [".title", ".credit"]) {
    const r = part(show, name).getBoundingClientRect();
    assert(r.right <= controls.left, `${name} ends at ${r.right}, short of the controls at ${controls.left}`);
    const e = part(show, name);
    assert(e.scrollWidth <= e.clientWidth && r.height > 30, `${name}: whole, on more than one line (${r.height}px)`);
  }
  assert(controls.bottom <= bar.bottom, "the controls on the bar, at its foot");
});

test("on the floating bar, over whatever photo, the counter and the credit are in the text's colour; on a card, in the card's", async () => {
  const theme = themed("minimal-credited-2", { extends: "minimal", caption: { credit: true } });
  const show = makeShow([{ title: "A", credit: "B" }, {}], { theme });
  await waitFor(() => box(show).dataset["showCredit"] === "true", "the theme");
  await settledOn(show, "1 of 2");
  const text = getComputedStyle(part(show, ".title")).color;
  assertEqual(getComputedStyle(part(show, ".counter")).color, text, "the counter");
  assertEqual(getComputedStyle(part(show, ".credit")).color, text, "the credit");
  const card = themed("minimal-carded", { extends: "minimal", caption: { credit: true, card: true } });
  const carded = makeShow([{ title: "A", credit: "B" }, {}], { theme: card });
  await waitFor(() => box(carded).dataset["card"] === "true", "the theme");
  await settledOn(carded, "1 of 2");
  carded.style.setProperty("--clack-label-muted", "rgb(1, 2, 3)");
  assertEqual(getComputedStyle(part(carded, ".credit")).color, "rgb(1, 2, 3)", "on a card, the credit in the card's own muted colour");
});

test("a photo held aside by a drag when a key moves on slides on from where it is held, and the rest of the drag is no swipe", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-held", { transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{}, {}, {}], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 3");
  await sleep(200); // the next preloaded
  const leaving = figures(show)[0]!;
  const p = pointer(show);
  const x = p.left + p.width / 2;
  p.send("pointerdown", x);
  p.send("pointermove", x - 60);
  p.send("pointermove", x - 120);
  await waitFor(() => leaving.style.getPropertyValue("--clack-drag") !== "", "the photo held aside");
  const held = leaving.style.getPropertyValue("--clack-drag");
  show.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const frames = (leaving.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  assertEqual(String(frames[0]!["transform"]), `translateX(${held})`, "from where it was held, not from the middle");
  // The finger goes on moving, and lets go as a swipe would.
  p.send("pointermove", x - 200);
  assert(leaving.isConnected && leaving.getAnimations().length > 0, "the slide is not cut short by the rest of the drag");
  p.send("pointerup", x - 200, { buttons: 0 });
  await settledOn(show, "2 of 3");
  await sleep(100);
  assertEqual(show.index, 1, "the second, and not on to the third: the letting go was no swipe");
  assertEqual(figures(show)[0]!.style.getPropertyValue("--clack-drag"), "", "the photo on screen not held aside");
});

test("a floating bar's caption too long for one line widens nothing", async () => {
  const theme = themed("minimal-always-long", { extends: "minimal", controls: { reveal: "always" } });
  const long = "A very long title for a photograph of houses above the harbour at dusk, ".repeat(4).trim();
  const show = makeShow([{ title: long }], { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(stage.width <= host.width + 0.5, `the stage, ${stage.width}px, no wider than the show, ${host.width}px`);
  const bar = part(show, ".below").getBoundingClientRect();
  assert(bar.width <= 560.5, `the bar at its width, ${bar.width}px`);
  const title = part(show, ".title");
  assert(title.scrollWidth <= title.clientWidth, "the title on as many lines as it needs, within the bar");
});

test("a slide moves the photos past the show's margin: neither is seen in it as they come and go", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("gallery-sliding", { extends: "gallery", transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{ width: 600, height: 200 }, { width: 600, height: 200 }], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 2");
  await sleep(200); // the next preloaded
  const host = box(show).getBoundingClientRect();
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(stage.right < host.right - 8, "a margin beside the stage, for this to show anything");
  const leaving = figures(show)[0]!;
  void show.next();
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const coming = figures(show).find((f) => f !== leaving)!;
  const all = [...leaving.getAnimations(), ...coming.getAnimations()];
  for (const a of all) a.pause();
  const at = (t: number): void => all.forEach((a) => (a.currentTime = t));
  at(0);
  const first = coming.querySelector("img")!.getBoundingClientRect();
  // Gallery's soft shadow reaches 36px past the photo.
  assert(first.left >= host.right + 36, `as it starts, the next photo, from ${first.left}, and its shadow are past the show's edge, ${host.right}`);
  at(599);
  const last = leaving.querySelector("img")!.getBoundingClientRect();
  assert(last.right <= host.left - 35, `as it ends, the last photo, to ${last.right}, and its shadow are past the show's other edge, ${host.left}`);
  for (const a of all) a.finish();
  await settledOn(show, "2 of 2");
});

test("no empty caption card is drawn while the first photo loads", async () => {
  const show = makeShow([{ title: "Slow", delay: 1500 }], { theme: "mat" });
  await waitFor(() => box(show).dataset["captioned"] === "true", "the slides");
  assertEqual(getComputedStyle(part(show, ".caption")).visibility, "hidden", "no card, with nothing on it yet");
  await settledOn(show, "1 of 1");
  assertEqual(getComputedStyle(part(show, ".caption")).visibility, "visible", "the card, once there is a caption for it");
});

test("with reduced motion, a photo moved aside fades where it is, carrying on no further", () => {
  const still = transitionFrames("crossfade", -1, -120, { still: true });
  assertEqual(`${still.outgoing[0]!.transform} ${still.outgoing[1]!.transform}`, "translateX(-120px) translateX(-120px)", "where it is held, to the end");
  const moving = transitionFrames("crossfade", -1, -120);
  assertEqual(moving.outgoing[1]!.transform, "translateX(-12%)", "otherwise, on a little the way it went");
});

test("a floating bar with no captions goes by its surface and its controls, never faded as a whole, which would cut its blur off", async () => {
  const show = makeShow([{}, {}], { theme: "minimal" });
  await settledOn(show, "1 of 2");
  const below = part(show, ".below");
  assert(getComputedStyle(below, "::before").opacity === "0" && !shown(part(show, ".controls")), "the bar's surface and its controls unseen");
  assertEqual(getComputedStyle(below).pointerEvents, "none", "nor in the pointer's way");
  // A parent fading is a backdrop root: its surface's blur would see
  // nothing of the photo while it faded.
  assertEqual(getComputedStyle(below).opacity, "1", "the bar itself never faded");
  box(show).classList.add("active");
  assertEqual(getComputedStyle(below).opacity, "1", "nor coming back");
  box(show).classList.remove("active");
});

test("as the floating bar comes and goes, the caption does not move", async () => {
  const show = makeShow([{ title: "Still here" }, {}], { theme: "minimal" });
  show.style.setProperty("--clack-transition-duration", "0s");
  show.style.width = "800px";
  await settledOn(show, "1 of 2");
  const before = part(show, ".title").getBoundingClientRect();
  const p = pointer(show);
  p.send("pointermove", p.left + 10, { buttons: 0 });
  await waitFor(() => shown(part(show, ".controls")), "the bar shown");
  const after = part(show, ".title").getBoundingClientRect();
  assertEqual(`${after.left},${after.top}`, `${before.left},${before.top}`, "the title where it was");
});

test("the controls do not move as the slide's number gains a digit", async () => {
  const theme = themed("minimal-always-count", { extends: "minimal", controls: { reveal: "always" } });
  // "99 / 120" to "100 / 120": past what the counter's least width holds.
  const show = makeShow(Array.from({ length: 120 }, (_, i) => ({ title: `Slide ${i + 1}` })), { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 120");
  await show.goTo(98);
  await settledOn(show, "99 of 120");
  const before = part(show, ".previous").getBoundingClientRect().left;
  await show.goTo(99);
  await settledOn(show, "100 of 120");
  assertEqual(part(show, ".previous").getBoundingClientRect().left, before, "Previous where it was");
});

test("a step slides though the photo on screen changed while the next loaded, and says where it came from", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-changed", { transition: { type: "slide", duration: "600ms" } });
  const slide = (id: string, url: string): SlideInput => ({ id, alt: id, width: 300, height: 200, sources: [{ url, width: 300 }] });
  const show = makeShow([], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  const second = slide("b", img(300, 200, "aa8866", 800));
  show.slides = [slide("a", img(300, 200)), second];
  await settledOn(show, "1 of 2");
  const seen: number[] = [];
  show.addEventListener("slidechange", (e) => seen.push((e as CustomEvent<{ previous: number }>).detail.previous));
  const leaving = figures(show)[0]!;
  void show.next();
  // The first slide's photo changes while the second is on its way.
  show.slides = [slide("a", img(300, 200, "88aa66")), second];
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const coming = figures(show).find((f) => f !== leaving)!;
  const frames = (coming.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  assert(String(frames[0]!["transform"] ?? "").startsWith("translateX"), `slid in: ${JSON.stringify(frames[0])}`);
  assertEqual(seen.join(), "0", "from the first slide");
  await settledOn(show, "2 of 2");
});

test("after a swipe, the next keeps the wall's width from the last as both go, as after a key", () => {
  const swiped = transitionFrames("slide", -1, -200, { beyond: 88 });
  assertEqual(swiped.incoming[0]!.transform, "translateX(calc(-200px + calc(100% + 88px)))", "a stage and the margin from where the last was let go");
  assertEqual(swiped.outgoing[1]!.transform, "translateX(calc(-100% - 88px))", "and the last as far beyond, the other way");
});

test("a slide moves a photo past the margin by as much as any shadow Clack draws under it reaches", async () => {
  const reach = (shadow: string): number => {
    let most = 0;
    // Each layer, as computed: a colour, then x, y, blur and spread in px.
    for (const layer of shadow.split(/,(?![^(]*\))/)) {
      if (layer.includes("inset") || layer.trim() === "none") continue;
      const [x, , blur, spread] = (layer.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      most = Math.max(most, Math.abs(x ?? 0) + (blur ?? 0) + (spread ?? 0));
    }
    return most;
  };
  for (const [theme, at] of [["gallery", ".slide img"], ["mat", ".slide .mount"]] as const) {
    const show = makeShow([{}], { theme });
    await settledOn(show, "1 of 1");
    const r = reach(getComputedStyle(part(show, at)).boxShadow);
    assert(r > 0 && r <= shadowReach, `${theme}: its shadow reaches ${r}px, within the ${shadowReach}px a slide allows`);
  }
});

test("a jump while the photo on screen is changing goes the way the slides lie", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-jump", { transition: { type: "slide", duration: "600ms" } });
  const slide = (id: string, url: string): SlideInput => ({ id, alt: id, width: 300, height: 200, sources: [{ url, width: 300 }] });
  const show = makeShow([], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  const [a, c] = [slide("a", img(300, 200)), slide("c", img(300, 200, "8866aa"))];
  show.slides = [a, slide("b", img(300, 200, "aa8866")), c];
  await settledOn(show, "1 of 3");
  await show.next();
  await settledOn(show, "2 of 3");
  await sleep(200); // the first preloaded, behind
  // The second slide's photo changes, and is slow to come; meanwhile, back to the first.
  show.slides = [a, slide("b", img(300, 200, "66aa88", 3000)), c];
  const leaving = figures(show).find((f) => f.getAnimations().length === 0)!;
  void show.goTo(0);
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const coming = figures(show).find((f) => f !== leaving)!;
  const first = String((coming.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!["transform"]);
  assert(/^translateX\((calc\()?-100%/.test(first), `back: the first in from the left, ${first}`);
  await settledOn(show, "1 of 3");
});

test("a slide past the margin measures it as laid out, whatever transform the page puts around the show", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("gallery-sliding-scaled", { extends: "gallery", transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{}, {}], { theme });
  const scaled = document.createElement("div");
  scaled.style.transform = "scale(0.5)";
  show.replaceWith(scaled);
  scaled.append(show);
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 2");
  await sleep(200); // the next preloaded
  const want = Math.ceil(parseFloat(getComputedStyle(box(show)).paddingRight)) + shadowReach;
  const leaving = figures(show)[0]!;
  void show.next();
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const coming = figures(show).find((f) => f !== leaving)!;
  const first = String((coming.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!["transform"]);
  assertEqual(first, `translateX(calc(100% + ${want}px))`, "the margin in the show's own px, not halved");
  await settledOn(show, "2 of 2");
});

test("a narrow floating bar with no captions is still the controls alone, as wide as they are", async () => {
  const theme = themed("minimal-always-narrow-bare", { extends: "minimal", controls: { reveal: "always" } });
  const show = makeShow([{}, {}], { theme });
  show.style.width = "360px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 2");
  const host = show.getBoundingClientRect();
  const bar = part(show, ".below").getBoundingClientRect();
  assert(bar.width < host.width / 2, `the bar ${bar.width}px wide, not from side to side of ${host.width}px`);
  assert(Math.abs(bar.left + bar.width / 2 - (host.left + host.width / 2)) < 1, "centred");
});

test("a photo springing back from a drag when a key moves on goes on from where it has got to", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-sprung", { transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{}, {}, {}], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 3");
  await sleep(200); // the next preloaded
  const leaving = figures(show)[0]!;
  const p = pointer(show);
  const x = p.left + p.width / 2;
  // A short, slow drag, let go: no swipe, so it springs back.
  p.send("pointerdown", x);
  for (let i = 1; i <= 4; i++) {
    p.send("pointermove", x - i * 10);
    await sleep(60);
  }
  await sleep(150);
  p.send("pointerup", x - 40, { buttons: 0 });
  await waitFor(() => leaving.getAnimations().length > 0, "the spring back");
  show.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await waitFor(() => figures(show).length > 1, "the next coming");
  const frames = (leaving.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  const from = new DOMMatrix(String(frames[0]!["transform"])).m41;
  assert(from < -1, `from where it had got to, ${from}px, not the middle`);
  await settledOn(show, "2 of 3");
});

test("a photo held by a drag when the page takes its slide away springs back, and the next takes it from there", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const show = makeShow([{}, {}]);
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 2");
  const held = figures(show)[0]!;
  const p = pointer(show);
  const x = p.left + p.width / 2;
  p.send("pointerdown", x);
  p.send("pointermove", x - 60);
  p.send("pointermove", x - 120);
  await waitFor(() => held.style.getPropertyValue("--clack-drag") !== "", "the photo held aside");
  show.slides = [{ id: "z", alt: "another", width: 300, height: 200, sources: [{ url: img(300, 200, "aa66aa", 600), width: 300 }] }];
  const spring = held.getAnimations()[0];
  assert(spring !== undefined, "springing back, not snapped to the middle");
  assertEqual(String((spring!.effect as KeyframeEffect).getKeyframes()[0]!["transform"]), "translateX(-120px)", "from where it was held");
  p.send("pointerup", x - 120, { buttons: 0 });
  await settledOn(show, "1 of 1");
});

test("as the floating bar goes and comes back, its caption is never on less than the bar's surface", async () => {
  const show = makeShow([{ title: "A" }, {}], { theme: "minimal" });
  await settledOn(show, "1 of 2");
  const caption = part(show, ".caption");
  const below = part(show, ".below");
  box(show).classList.add("active");
  await waitFor(() => getComputedStyle(below, "::before").opacity === "1" && getComputedStyle(caption, "::before").opacity === "0", "the bar drawn, the caption on it");
  // Going: the caption's box at once, while the bar fades.
  box(show).classList.remove("active");
  assertEqual(getComputedStyle(caption, "::before").opacity, "1", "the caption's box drawn at once");
  // Coming back: the caption's box stays until the bar has faded in.
  box(show).classList.add("active");
  assertEqual(getComputedStyle(caption, "::before").opacity, "1", "the caption's box kept while the bar fades in");
  await waitFor(() => getComputedStyle(caption, "::before").opacity === "0", "and gone once it has");
  box(show).classList.remove("active");
});

test("the bar and the controls come and go by opacity alone, which is composited", async () => {
  const show = makeShow([{ title: "A" }, {}], { theme: "minimal" });
  await settledOn(show, "1 of 2");
  assertEqual(getComputedStyle(part(show, ".below")).transitionDuration, "0s", "the bar itself, nothing (see above)");
  for (const [what, style] of [
    ["its surface", getComputedStyle(part(show, ".below"), "::before")],
    ["the caption's box", getComputedStyle(part(show, ".caption"), "::before")],
    ["the controls", getComputedStyle(part(show, ".controls"))],
  ] as const) {
    assertEqual(style.transitionProperty, "opacity", what);
  }
});

test("focus the keyboard brings from the photo to the controls keeps them up, though it moves only within the show", async () => {
  const show = makeShow([{}, {}], { theme: "darkroom" });
  await settledOn(show, "1 of 2");
  // Clicked, the photo has the focus, for the arrow keys; then a Tab.
  const stage = part(show, ".stage");
  stage.focus();
  assertEqual(show.shadowRoot!.activeElement, stage, "the photo focused");
  focusAs(part(show, ".previous"), true);
  assert(box(show).classList.contains("key-focus"), "kept up while focus is among them");
  (show.shadowRoot!.activeElement as HTMLElement).blur();
  await sleep(0);
  assert(!box(show).classList.contains("key-focus"), "and not once it has gone");
});

test("a visitor who pointed in the show, then tabbed back from elsewhere, has the controls kept up", async () => {
  const show = makeShow([{}, {}], { theme: "darkroom" });
  await settledOn(show, "1 of 2");
  const p = pointer(show);
  const x = p.left + 10;
  p.send("pointerdown", x);
  p.send("pointerup", x, { buttons: 0 });
  // Elsewhere in the page, and back by the keyboard: nothing of which
  // happens in the show.
  const away = document.createElement("button");
  fixture().append(away);
  away.focus();
  focusAs(part(show, ".next"), true);
  assert(box(show).classList.contains("key-focus"), "kept up while focus is among them");
  (show.shadowRoot!.activeElement as HTMLElement).blur();
});

test("a new photo of the slide on screen leaves the way the visitor goes as it was, and preloads ahead", async () => {
  await resetImageLog();
  const slide = (id: string, url: string): SlideInput => ({ id, alt: id, width: 300, height: 200, sources: [{ url, width: 300 }] });
  const urls = Array.from({ length: 10 }, () => img(300, 200));
  const show = makeShow([]);
  show.slides = urls.map((u, i) => slide(String(i), u));
  await settledOn(show, "1 of 10");
  // Forwards, to slide 6, and its neighbours preloaded: 7, 5 and 8.
  await show.goTo(5);
  await settledOn(show, "6 of 10");
  await logged((e) => e === urls[7], "slide 8, preloaded");
  await sleep(200);
  await resetImageLog();
  const swapped = img(300, 200, "aa8866");
  show.slides = urls.map((u, i) => slide(String(i), i === 5 ? swapped : u));
  await logged((e) => e === swapped, "slide 6's new photo");
  await sleep(300);
  const log = await imageLog();
  // Turned round, the show would preload 5, 7 and 4 -- slide 4 anew.
  assert(!log.includes(urls[3]!), `still forwards: nothing fetched behind, ${log.join(" ")}`);
});

test("a step while the last is still sliding in takes the photo on from where it has got to", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("sliding-twice", { transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{}, {}, {}], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 3");
  await sleep(300); // the next two preloaded
  const first = figures(show)[0]!;
  void show.next();
  await waitFor(() => first.getAnimations().length > 0, "the photos to move");
  const second = figures(show).find((f) => f !== first)!;
  await sleep(100);
  void show.next();
  await waitFor(() => figures(show).length > 2 || !figures(show).includes(first), "the third coming");
  await waitFor(() => second.getAnimations().length > 0, "the second leaving");
  const frames = (second.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  const from = new DOMMatrix(String(frames[0]!["transform"])).m41;
  assert(from > 1, `from where it had got to, ${from}px, not the middle`);
  await settledOn(show, "3 of 3");
});

test("with reduced motion, nothing of the floating bar fades: it and its caption's box come and go at once", async () => {
  const show = makeShow([{ title: "A" }, {}], { theme: "minimal" });
  await settledOn(show, "1 of 2");
  // The visitor's setting cannot be emulated here: Clack's stylesheet, as
  // if it applied.
  const root = show.shadowRoot!;
  const clack = root.adoptedStyleSheets.find((s) => Array.from(s.cssRules).some((r) => r instanceof CSSMediaRule && r.media.mediaText.includes("prefers-reduced-motion")))!;
  const text = Array.from(clack.cssRules, (r) =>
    r instanceof CSSMediaRule && r.media.mediaText.includes("prefers-reduced-motion") ? Array.from(r.cssRules, (i) => i.cssText).join("\n") : r.cssText,
  ).join("\n");
  const reduced = new CSSStyleSheet();
  reduced.replaceSync(text);
  const saved = [...root.adoptedStyleSheets];
  root.adoptedStyleSheets = saved.map((s) => (s === clack ? reduced : s));
  try {
    for (const [what, style] of [
      ["the controls", getComputedStyle(part(show, ".controls"))],
      ["the bar's surface", getComputedStyle(part(show, ".below"), "::before")],
      ["the caption's box", getComputedStyle(part(show, ".caption"), "::before")],
    ] as const) {
      assertEqual(`${style.transitionDuration} ${style.transitionDelay}`, "0s 0s", what);
    }
  } finally {
    root.adoptedStyleSheets = saved;
  }
});

test("with no margin, a slide still moves a photo past the reach of its shadow: one just past the edge casts it back in", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing moves in a hidden page");
  const theme = themed("bleed-shadow-sliding", { extends: "minimal", layout: { shadow: "soft" }, transition: { type: "slide", duration: "600ms" } });
  const show = makeShow([{ width: 600, height: 200 }, { width: 600, height: 200 }], { theme });
  await waitFor(() => getComputedStyle(show).getPropertyValue("--clack-transition").trim() === "slide", "the theme");
  show.style.setProperty("--clack-transition-duration", "600ms");
  await settledOn(show, "1 of 2");
  await sleep(200); // the next preloaded
  const host = box(show).getBoundingClientRect();
  const leaving = figures(show)[0]!;
  assert(leaving.querySelector("img")!.getBoundingClientRect().right >= host.right - 1, "the photo to the show's edge, for this to show anything");
  assert(getComputedStyle(leaving.querySelector("img")!).boxShadow !== "none", "a shadow under it");
  void show.next();
  await waitFor(() => leaving.getAnimations().length > 0, "the photos to move");
  const coming = figures(show).find((f) => f !== leaving)!;
  const all = [...leaving.getAnimations(), ...coming.getAnimations()];
  for (const a of all) a.pause();
  for (const a of all) a.currentTime = 0;
  const first = coming.querySelector("img")!.getBoundingClientRect();
  assert(first.left >= host.right + 36, `as it starts, the next photo, from ${first.left}, and its shadow are past the show's edge, ${host.right}`);
  for (const a of all) a.finish();
  await settledOn(show, "2 of 2");
});
