// What a theme puts around the photo: the caption card, floating controls,
// controls shown only for the visitor's activity, and how one photo gives
// way to the next.
import type { ClackShow } from "../src/clack";
import { transitionFrames, transitionOf } from "../src/show";
import { assert, assertEqual, skip, sleep, test } from "./harness";
import { echo, figures, img, makeShow, part, pointer, settledOn, showBox as box, waitFor } from "./util";

/** A theme file extending base, made of these tokens. */
function themed(name: string, tokens: Record<string, unknown>): string {
  return echo(JSON.stringify({ format: "clack-theme/1", name, ...tokens }), { path: `${name}.json` });
}

/** Whether the visitor could see and point at the controls now. */
function shown(e: Element): boolean {
  const style = getComputedStyle(e);
  return style.pointerEvents !== "none" && style.opacity !== "0";
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

test("floating, the caption and controls are a bar over the foot of the photo, which has the whole stage", async () => {
  const show = makeShow([{ title: "Wide", width: 300, height: 100 }], { theme: "minimal" });
  show.style.width = "800px"; // wider than a narrow show's 640px
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(Math.abs(stage.height - host.height) < 1, `the stage, ${stage.height} tall, as tall as the show, ${host.height}`);
  const bar = part(show, ".below").getBoundingClientRect();
  assert(bar.bottom < host.bottom && bar.top > host.top + host.height / 2, `the bar, ${bar.top}–${bar.bottom}, over the foot of ${host.top}–${host.bottom}`);
  assert(Math.abs(bar.left + bar.width / 2 - (host.left + host.width / 2)) < 1, "centred");
  assertEqual(getComputedStyle(part(show, ".caption")).display, "block", "the caption on it");
});

test("on a narrow show, the floating bar runs from side to side, with only the controls", async () => {
  const show = makeShow([{ title: "Narrow" }], { theme: "minimal" });
  show.style.width = "360px";
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const bar = part(show, ".below").getBoundingClientRect();
  assert(Math.abs(bar.left - host.left - 12) < 1 && Math.abs(host.right - bar.right - 12) < 1, `the bar ${bar.left - host.left}px and ${host.right - bar.right}px from the sides`);
  assertEqual(part(show, ".caption").getBoundingClientRect().width, 1, "no caption to be seen on it");
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
  assertEqual(next.tabIndex, 0, "in the tab order");
  if (!document.hasFocus()) skip("this engine's window does not have focus, so nothing in it is focused as a visitor's keyboard would");
  next.focus();
  await waitFor(() => shown(part(show, ".controls")), "shown with focus among them");
  // Long after the activity that focusing them was.
  await sleep(3300);
  assert(shown(part(show, ".controls")), "still, while focus is among them");
  next.blur();
});

test("floating controls shown only for activity hide the whole bar", async () => {
  const show = makeShow([{ title: "A" }, {}], { theme: "minimal" });
  await settledOn(show, "1 of 2");
  assert(!shown(part(show, ".below")), "the bar, caption and all, unseen");
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
  assertEqual(`${incoming} ${outgoing}`, "translateX(100%) translateX(-100%)", "the next in from the right, the last out to the left");
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
  assertEqual(`${incoming} ${outgoing}`, "translateX(-100%) translateX(100%)", "the next in from the left, the last out to the right");
});

test("controls focused by a click or a tap, not the keyboard, still go", async () => {
  const show = makeShow([{}, {}], { theme: "darkroom" });
  await settledOn(show, "1 of 2");
  const p = pointer(show);
  p.send("pointermove", p.left + 10, { buttons: 0 });
  // As a click leaves it: focused, but not as the keyboard focuses.
  (part(show, ".next") as HTMLButtonElement).focus({ focusVisible: false } as FocusOptions);
  await sleep(3300);
  assert(!shown(part(show, ".controls")), "gone a few seconds after, focus or not");
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
  const show = makeShow([{ title: "Houses above the harbour, at dusk" }, { title: "Dusk" }], { theme });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 2");
  const before = part(show, ".next").getBoundingClientRect().left;
  await show.next();
  await settledOn(show, "2 of 2");
  assertEqual(part(show, ".next").getBoundingClientRect().left, before, "Next where it was");
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

test("on a narrow show, the floating bar's caption is unseen, but still there for screen readers", async () => {
  const show = makeShow([{ title: "Narrow" }], { theme: "minimal" });
  show.style.width = "360px";
  await settledOn(show, "1 of 1");
  const caption = getComputedStyle(part(show, ".caption"));
  assert(caption.display !== "none" && caption.visibility !== "hidden", "not taken from screen readers");
  assertEqual(part(show, ".caption").getBoundingClientRect().width, 1, "unseen");
});

test("where the text runs right to left, the floating bar's wider side is the caption's", async () => {
  const theme = themed("minimal-always-rtl", { extends: "minimal", controls: { reveal: "always" } });
  const show = makeShow([{ title: "كورنيش" }], { theme, dir: "rtl" });
  show.style.width = "800px";
  await waitFor(() => box(show).dataset["reveal"] === "always", "the theme");
  await settledOn(show, "1 of 1");
  const bar = getComputedStyle(part(show, ".below"));
  assertEqual(`${bar.paddingRight} ${bar.paddingLeft}`, "18px 8px", "18px on the right, where the caption is");
});

test("a theme that shows no credit draws no card for a slide with only a credit", async () => {
  const theme = themed("mat-uncredited", { extends: "mat", caption: { credit: false } });
  const show = makeShow([{ credit: "Someone" }, { credit: "Someone else" }], { theme });
  await waitFor(() => box(show).dataset["credit"] === "false", "the theme");
  await settledOn(show, "1 of 2");
  assertEqual(getComputedStyle(part(show, ".caption")).backgroundColor, "rgba(0, 0, 0, 0)", "no card");
});
