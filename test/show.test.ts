import type { ClackShow, SlideChangeDetail, SlideInput } from "../src/clack";
import { tagName } from "../src/clack";
import { assert, assertEqual, fixture, skip, sleep, test } from "./harness";
import { figure, figures, img, imageLog, makeShow, onScreen, part, resetImageLog, settledOn, waitFor } from "./util";

const three = [{ title: "One", credit: "Me" }, { title: "Two" }, { title: "Three" }];

/** Collects the show's slidechange events. */
function changes(show: ClackShow): SlideChangeDetail[] {
  const seen: SlideChangeDetail[] = [];
  show.addEventListener("slidechange", (e) => seen.push(e.detail));
  return seen;
}

function key(show: ClackShow, k: string): void {
  show.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

test("shows the first slide once its photo is decoded", async () => {
  const show = makeShow(three);
  const seen = changes(show);
  await settledOn(show, "1 of 3");
  const photo = part(show, ".slide img") as HTMLImageElement;
  assert(photo.complete && photo.naturalWidth > 0, "the photo on screen is loaded");
  assertEqual(photo.alt, "photo 1", "alt");
  assertEqual(seen.length, 1, "slidechange events");
  assertEqual(seen[0]!.index, 0, "index");
  assertEqual(seen[0]!.previous, -1, "previous, before the first");
  assertEqual(part(show, ".title").textContent, "One", "title");
  assertEqual(part(show, ".credit").textContent, "Me", "credit");
  assertEqual(part(show, ".counter").textContent, "1 / 3", "counter");
  assertEqual(show.count, 3, "count");
});

test("the controls move between slides and stop at the ends", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  const prev = part(show, "button.previous");
  const next = part(show, "button.next");
  assertEqual(prev.ariaDisabled, "true", "previous, at the first");
  assertEqual(prev.ariaLabel, "Previous photo", "its label");
  next.click();
  assertEqual(show.index, 1, "the index moves at once");
  await settledOn(show, "2 of 3");
  assertEqual(part(show, ".title").textContent, "Two", "title");
  assertEqual(part(show, ".credit").hidden, true, "no credit, hidden");
  next.click();
  await settledOn(show, "3 of 3");
  assertEqual(next.ariaDisabled, "true", "next, at the last");
  next.click();
  await sleep(50);
  assertEqual(show.index, 2, "a disabled control does nothing");
  assertEqual(await show.next(), false, "next() at the last");
  prev.click();
  await settledOn(show, "2 of 3");
});

test("loop wraps round at the ends", async () => {
  const show = makeShow(three, { loop: "" });
  await settledOn(show, "1 of 3");
  assertEqual(part(show, "button.previous").ariaDisabled, null, "previous, looping");
  assert(await show.previous(), "previous() was shown");
  await settledOn(show, "3 of 3");
  show.loop = false;
  assertEqual(part(show, "button.next").ariaDisabled, "true", "next, after loop is turned off");
});

test("the keys move between slides, the way the text runs", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  key(show, "ArrowRight");
  await settledOn(show, "2 of 3");
  key(show, "End");
  await settledOn(show, "3 of 3");
  key(show, "Home");
  await settledOn(show, "1 of 3");
  show.dir = "rtl";
  key(show, "ArrowLeft");
  await settledOn(show, "2 of 3");
  const e = new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true });
  show.dispatchEvent(e);
  assertEqual(e.defaultPrevented, false, "a key with Ctrl is the browser's");
  assertEqual(show.index, 1, "and moves nothing");
});

test("goTo goes by index or id", async () => {
  const show = makeShow([{ id: "a" }, { id: "b" }, { id: "c" }]);
  await settledOn(show, "1 of 3");
  assert(await show.goTo("c"), "goTo(id)");
  assertEqual(onScreen(show), "3 of 3", "on screen");
  assert(await show.goTo(1), "goTo(index)");
  let refused = false;
  await show.goTo("nope").catch((e: unknown) => (refused = e instanceof RangeError));
  assert(refused, "goTo an unknown id rejects with a RangeError");
});

test("a photo is decoded before it is shown; until then the current one stays", async () => {
  const show = makeShow([{}, { delay: 700 }, {}]);
  await settledOn(show, "1 of 3");
  const arrived = show.goTo(1);
  await sleep(150);
  assertEqual(show.index, 1, "index, while loading");
  assertEqual(part(show, ".counter").textContent, "2 / 3", "the counter already says where");
  assertEqual(onScreen(show), "1 of 3", "the current photo stays");
  assert(part(show, ".stage").classList.contains("loading"), "the stage says it is loading");
  assert(await arrived, "the slow photo arrived");
  const photo = figures(show).at(-1)!.querySelector("img")!;
  assert(photo.complete && photo.naturalWidth > 0, "decoded when shown");
  assert(!part(show, ".stage").classList.contains("loading"), "loading is over");
});

test("a newer request wins over a slower, older one", async () => {
  const show = makeShow([{}, { delay: 900 }, {}]);
  await settledOn(show, "1 of 3");
  const seen = changes(show);
  const slow = show.goTo(1);
  await sleep(50);
  const fast = show.goTo(2);
  assertEqual(await fast, true, "the newer one is shown");
  assertEqual(await slow, false, "the older one is not");
  await sleep(300);
  assertEqual(seen.map((d) => d.index).join(), "2", "only the newer one was ever on screen");
  // Going back to the slide on screen while another loads cancels that one.
  const third = show.goTo(1);
  assertEqual(await show.goTo(2), true, "back to the one on screen");
  assertEqual(await third, false, "the one in between is dropped");
});

/** Waits until the image log has an entry for which match holds. */
async function logged(match: (entry: string) => boolean, what: string, timeoutMs = 2500): Promise<string[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const log = await imageLog();
    if (log.some(match)) {
      return log;
    }
    if (performance.now() > deadline) {
      throw new Error(`${what}: not in the log (${log.join(" ")})`);
    }
    await sleep(50);
  }
}

test("preloads the next slides, and cancels what is no longer wanted", async () => {
  await resetImageLog();
  const show = makeShow([{}, {}, {}, { delay: 4000 }, {}, {}, {}, {}]);
  const urls = Array.from(show.querySelectorAll("img"), (i) => {
    const u = new URL(i.src);
    return u.pathname + u.search;
  });
  await settledOn(show, "1 of 8");
  let log = await logged((e) => e === urls[2], "slide 3, two ahead");
  assert(log.includes(urls[1]!), "slide 2, the next, is fetched");
  await sleep(200);
  log = await imageLog();
  assert(!log.includes(urls[3]!) && !log.includes(urls[7]!), `nothing further: ${log.join(" ")}`);
  // From slide 3, slow slide 4 is next; from slide 7 it is not wanted.
  await show.goTo(2);
  await logged((e) => e === urls[3], "slow slide 4, once it is next");
  await show.goTo(6);
  // Clack lets go of slide 4. Firefox then stops its download; Chrome and
  // Safari finish it into their cache whatever is done with the image.
  if (!navigator.userAgent.includes("Firefox/")) {
    skip("this engine finishes a download nobody wants; only Firefox stops it");
  }
  await logged((e) => e === `cancelled ${urls[3]}`, "slide 4's download, cancelled");
});

test("skipping quickly through slides fetches only those it stops at", async () => {
  await resetImageLog();
  const show = makeShow(Array.from({ length: 12 }, () => ({ delay: 300 })));
  const urls = Array.from(show.querySelectorAll("img"), (i) => {
    const u = new URL(i.src);
    return u.pathname + u.search;
  });
  await settledOn(show, "1 of 12");
  await sleep(500); // the preloads of slide 1
  await resetImageLog();
  // Five presses before anything arrives: slides 2 to 6 are asked for in
  // turn, and only slide 6 is shown.
  for (let i = 0; i < 5; i++) {
    void show.next();
  }
  await settledOn(show, "6 of 12");
  await sleep(500);
  const log = (await imageLog()).filter((e) => !e.startsWith("cancelled"));
  // From slide 6, the preloads are 7, 5 and 8; nothing beyond.
  for (const i of [8, 9, 10, 11]) {
    assert(!log.includes(urls[i]!), `slide ${i + 1} was fetched: ${log.join(" ")}`);
  }
  assert(log.includes(urls[6]!), "slide 7, the next from where it stopped, is preloaded");
});

test("fetches the photo at the size it is drawn", async () => {
  const show = makeShow([{ width: 1500, height: 1000 }]);
  await settledOn(show, "1 of 1");
  const photo = part(show, ".slide img") as HTMLImageElement;
  const stage = part(show, ".stage").getBoundingClientRect();
  const drawn = Math.ceil(Math.min(stage.width, stage.height * 1.5));
  assertEqual(photo.sizes, `${drawn}px`, "sizes");
  assertEqual(Math.round(photo.getBoundingClientRect().width), Math.round(Math.min(stage.width, stage.height * 1.5)), "the width it is drawn at");
  show.style.width = "300px";
  await waitFor(() => photo.sizes !== `${drawn}px`, "sizes to follow a resize");
});

test("a photo that cannot be loaded keeps its place and says so", async () => {
  const show = makeShow([{}, { src: "/img/broken.png?tag=b" }, {}]);
  await settledOn(show, "1 of 3");
  await show.next();
  await settledOn(show, "2 of 3");
  const slide = figures(show)[0]!;
  assert(slide.classList.contains("failed"), "marked as failed");
  assertEqual(slide.querySelector(".missing-alt")?.textContent, "photo 2", "its alt text is shown");
  assert(await show.next(), "and the show goes on");
});

test("the crossfade ends with one slide on screen, or there is none", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing fades in a hidden page");
  const show = makeShow(three);
  show.style.setProperty("--clack-transition-duration", "300ms");
  await settledOn(show, "1 of 3");
  await show.next();
  assertEqual(figures(show).length, 2, "both, while fading");
  await settledOn(show, "2 of 3");
  // Pressing on during a fade finishes it at once.
  await show.next();
  await show.previous();
  assert(figures(show).length <= 2, "never more than two");
  await settledOn(show, "2 of 3");
  show.style.setProperty("--clack-transition", "none");
  await show.next();
  assertEqual(figures(show).length, 1, "with no transition, at once");
});

test("slidechange says which slide, and from which", async () => {
  const show = makeShow([{ id: "a" }, { id: "b" }]);
  await settledOn(show, "1 of 2");
  const seen = changes(show);
  await show.next();
  assertEqual(JSON.stringify(seen), JSON.stringify([{ index: 1, id: "b", previous: 0 }]), "detail");
});

test("announces the visitor's navigation, not the page's", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  const live = part(show, ".live");
  assertEqual(live.ariaLive, "polite", "a polite live region");
  await show.next();
  await sleep(100);
  assertEqual(live.textContent, "", "next() from script is not announced");
  part(show, "button.next").click();
  await waitFor(() => live.textContent !== "", "an announcement");
  assertEqual(live.textContent, "Photo 3 of 3: Three", "the announcement");
});

test("a swipe moves on; a scroll or a short drag does not", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  const stage = part(show, ".stage");
  const r = stage.getBoundingClientRect();
  const y = r.top + r.height / 2;
  const at = (type: string, x: number, dy = 0): void => {
    stage.dispatchEvent(
      new PointerEvent(type, { pointerId: 7, isPrimary: true, button: 0, clientX: x, clientY: y + dy, bubbles: true, cancelable: true, composed: true }),
    );
  };
  const x0 = r.left + r.width * 0.8;
  // Up and down: the page's, to scroll.
  at("pointerdown", x0);
  at("pointermove", x0 + 2, 40);
  at("pointermove", x0 - 200, 60);
  at("pointerup", x0 - 200, 60);
  await sleep(100);
  assertEqual(show.index, 0, "a vertical gesture is a scroll");
  // A short, slow drag springs back.
  at("pointerdown", x0);
  at("pointermove", x0 - 20);
  await sleep(150);
  at("pointermove", x0 - 30);
  await sleep(150);
  at("pointerup", x0 - 30);
  await sleep(100);
  assertEqual(show.index, 0, "a short drag springs back");
  // A long drag to the left brings the next.
  at("pointerdown", x0);
  for (let i = 1; i <= 8; i++) {
    at("pointermove", x0 - i * 40);
  }
  at("pointerup", x0 - 320);
  assertEqual(show.index, 1, "a long swipe left: the next");
  await settledOn(show, "2 of 3");
  // At the first slide a swipe right has nowhere to go.
  await show.goTo(0);
  at("pointerdown", x0 - 300);
  for (let i = 1; i <= 8; i++) {
    at("pointermove", x0 - 300 + i * 40);
  }
  at("pointerup", x0 + 20);
  await sleep(50);
  assertEqual(show.index, 0, "nothing before the first");
});

test("follows changes to its markup, keeping its place", async () => {
  const show = makeShow([{ id: "a" }, { id: "b" }]);
  await settledOn(show, "1 of 2");
  await show.goTo("b");
  show.prepend(figure({ id: "z" }));
  await waitFor(() => show.count === 3, "the new slide");
  assertEqual(show.index, 2, "still on b, now third");
  await settledOn(show, "3 of 3");
  show.lastElementChild!.remove();
  await waitFor(() => show.count === 2, "the slide to go");
  assertEqual(show.index, 0, "its slide gone, back to the first");
});

test("slides can be given from script, with pictures for other formats", async () => {
  const show = document.createElement(tagName);
  show.style.setProperty("--clack-transition-duration", "40ms");
  show.append(figure({}));
  fixture().append(show);
  const slides: SlideInput[] = [1, 2].map((n) => ({
    id: `s${n}`,
    alt: `script ${n}`,
    width: 300,
    height: 200,
    sources: [
      { url: img(300, 200, "aa6633"), width: 300, type: "image/png" },
      { url: img(600, 400, "aa6633"), width: 600 },
    ],
  }));
  show.slides = slides;
  assertEqual(show.count, 2, "the script's slides, not the markup's");
  await settledOn(show, "1 of 2");
  const picture = part(show, ".slide picture");
  assertEqual(picture.querySelector("source")?.type, "image/png", "a <source> for the typed sources");
  assertEqual((picture.querySelector("img") as HTMLImageElement).alt, "script 1", "the <img>");
  show.append(figure({}));
  await sleep(50);
  assertEqual(show.count, 2, "markup is not read while script gives the slides");
  let threw = false;
  try {
    show.slides = [{ ...slides[0]!, sources: [{ url: "javascript:alert(1)", width: 1 }] }];
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, "a slide that cannot be shown throws a TypeError");
  assertEqual(show.count, 2, "and the slides stay as they were");
  show.slides = null;
  assertEqual(show.count, 2, "null goes back to the markup");
  await settledOn(show, "1 of 2");
});

test("labels the show and each slide for screen readers", async () => {
  const show = makeShow(three, { label: "Coastlines" });
  await settledOn(show, "1 of 3");
  const slide = figures(show)[0]!;
  assertEqual(slide.role, "group", "a slide is a group");
  assertEqual(slide.ariaRoleDescription, "slide", "described as a slide");
  assertEqual(part(show, ".counter").ariaHidden, "true", "the counter is for the eye only");
  for (const icon of show.shadowRoot!.querySelectorAll("svg")) {
    assertEqual(icon.getAttribute("aria-hidden"), "true", "icons are hidden");
  }
});

test("fills the width of its line, with or without a height", async () => {
  const box = fixture();
  box.style.width = "500px";
  const show = makeShow(three);
  show.style.width = "";
  box.append(show);
  await settledOn(show, "1 of 3");
  let r = show.getBoundingClientRect();
  assertEqual(Math.round(r.width), 500, "width, with no height set");
  assertEqual(Math.round(r.height), Math.round(500 / 1.5), "height: 3:2 by default");
  show.style.height = "600px";
  r = show.getBoundingClientRect();
  assertEqual(Math.round(r.width), 500, "width, with a height set");
  assertEqual(Math.round(r.height), 600, "height, as set");
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(stage.right <= r.right && stage.left >= r.left, "the stage stays inside the show");
});

test("in a hidden page, a new slide replaces the old at once", async () => {
  if (document.visibilityState !== "hidden") skip("this engine's window is visible");
  const show = makeShow(three);
  show.style.setProperty("--clack-transition-duration", "3s");
  await settledOn(show, "1 of 3");
  await show.next();
  assertEqual(figures(show).length, 1, "no fade");
});

test("adds nothing to the page outside its own box", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  const box = show.getBoundingClientRect();
  for (const e of show.shadowRoot!.querySelectorAll<HTMLElement>("*")) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    assert(r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5, `.${e.className} reaches outside the show`);
  }
});

test("a property set before Clack is loaded is not lost", async () => {
  // An element made in a document with no window is not upgraded, like one
  // in a page whose Clack script has not run yet.
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement(tagName) as unknown as Record<string, unknown>;
  early["loop"] = true;
  early["slides"] = [{ id: "s", alt: "early", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  const show = document.adoptNode(early as unknown as ClackShow);
  show.style.setProperty("--clack-transition-duration", "40ms");
  fixture().append(show);
  assert(show instanceof HTMLElement && "goTo" in show, "upgraded");
  assertEqual(show.count, 1, "the slides set before");
  assertEqual(show.hasAttribute("loop"), true, "loop set before");
  await settledOn(show, "1 of 1");
});

/** Pointer events on the stage, as a mouse, pen or finger would send them. */
function pointer(show: ClackShow) {
  const stage = part(show, ".stage");
  const r = stage.getBoundingClientRect();
  const y = r.top + r.height / 2;
  return {
    stage,
    left: r.left,
    width: r.width,
    send(type: string, x: number, init: PointerEventInit = {}): void {
      stage.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, ...init }),
      );
    },
    swipe(from: number, to: number): void {
      this.send("pointerdown", from);
      for (let i = 1; i <= 8; i++) {
        this.send("pointermove", from + ((to - from) * i) / 8);
      }
      this.send("pointerup", to, { buttons: 0 });
    },
  };
}

test("a mouse let go of outside the photo does not leave a drag behind", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  const p = pointer(show);
  const x = p.left + p.width * 0.8;
  p.send("pointerdown", x);
  // Released elsewhere, unheard; then it comes back with no button held.
  p.send("pointermove", x - 300, { buttons: 0 });
  await sleep(50);
  assertEqual(show.index, 0, "no button, no swipe");
  assertEqual(figures(show)[0]!.style.getPropertyValue("--clack-drag"), "", "the photo does not follow it");
  p.swipe(x, x - 320);
  assertEqual(show.index, 1, "the next drag works");
});

test("after a swipe, the next click is not swallowed", async () => {
  const show = makeShow(three);
  await settledOn(show, "1 of 3");
  const p = pointer(show);
  const x = p.left + p.width * 0.8;
  p.swipe(x, x - 320);
  await settledOn(show, "2 of 3");
  let clicks = 0;
  show.addEventListener("click", () => clicks++);
  // A touch swipe is often followed by no click; a later click, from a
  // keyboard or a script with no pointer before it, is not the swipe's.
  await sleep(450);
  p.stage.click();
  assertEqual(clicks, 1, "the click reached the page");
  // The click a mouse sends straight after a drag is the drag's own.
  p.swipe(x, x - 320);
  p.stage.click();
  assertEqual(clicks, 1, "the drag's own click is held back");
});

test("a swiped photo leaves the way the finger went, right to left too", async () => {
  if (document.visibilityState === "hidden") skip("this engine's window is hidden, and nothing animates in a hidden page");
  const show = makeShow(three);
  show.dir = "rtl";
  show.style.setProperty("--clack-transition-duration", "400ms");
  await settledOn(show, "1 of 3");
  await sleep(300); // slide 2, preloaded
  const p = pointer(show);
  const x = p.left + p.width * 0.2;
  const leaving = figures(show)[0]!;
  p.swipe(x, x + 320); // rightwards: the next, in a right-to-left show
  await waitFor(() => leaving.getAnimations().length > 0, "the old photo to animate");
  const frames = (leaving.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes();
  const end = String(frames[frames.length - 1]!["transform"]);
  assert(/translateX\(12%\)/.test(end), `it leaves to the right: ${end}`);
  assertEqual(show.index, 1, "the next slide");
});

test("a change to the markup leaves the photo on screen alone", async () => {
  const show = makeShow([{ id: "a", title: "A" }, { id: "b", title: "Typo" }]);
  await settledOn(show, "1 of 2");
  await show.goTo("b");
  await settledOn(show, "2 of 2");
  const slide = figures(show)[0]!;
  const photo = slide.querySelector("img")!;
  show.children[1]!.querySelector("figcaption")!.firstChild!.textContent = "Fixed";
  await waitFor(() => part(show, ".title").textContent === "Fixed", "the new caption");
  show.prepend(figure({ id: "z" }));
  await waitFor(() => show.count === 3, "the new slide");
  assertEqual(figures(show).length, 1, "nothing else drawn");
  assertEqual(figures(show)[0], slide, "the same slide on screen");
  assertEqual(slide.querySelector("img"), photo, "the same photo, not fetched again");
  assertEqual(slide.ariaLabel, "3 of 3", "its label follows its new place");
  assertEqual(show.index, 2, "and so does the index");
});

test("a looping show loads ahead forwards when it wraps round", async () => {
  const show = makeShow([], { loop: "" });
  const slide = (n: number, url = img(300, 200)): SlideInput => ({ id: `s${n}`, alt: "", width: 300, height: 200, sources: [{ url, width: 300 }] });
  const slides = [0, 1, 2, 3, 4, 5].map((n) => slide(n));
  show.slides = slides;
  await settledOn(show, "1 of 6");
  await show.goTo(5);
  await settledOn(show, "6 of 6");
  // Slide 3 was loaded when the show opened; a new URL for it means only
  // loading ahead from slide 1, forwards, fetches it now. (From script, so
  // no image of the page's own can have fetched it first.)
  const fresh = img(300, 200);
  slides[2] = slide(2, fresh);
  show.slides = slides;
  await resetImageLog();
  await show.next(); // from the last to the first: forwards
  await logged((e) => e === fresh, "slide 3, two ahead");
});

test("moving on keeps the downloads it will need next", async () => {
  await resetImageLog();
  const show = makeShow([{}, {}, { delay: 1500 }, {}]);
  const urls = Array.from(show.querySelectorAll("img"), (i) => new URL(i.src).pathname + new URL(i.src).search);
  await settledOn(show, "1 of 4");
  await logged((e) => e === urls[2], "slow slide 3, preloaded");
  await show.next(); // slide 2 is ready; slide 3 is still coming
  await settledOn(show, "2 of 4");
  await show.next();
  await settledOn(show, "3 of 4");
  const log = await imageLog();
  assertEqual(log.filter((e) => e.endsWith(urls[2]!)).length, 1, `slide 3 fetched once: ${log.join(" ")}`);
});

test("the first photo's place is held in its colour while it loads", async () => {
  const show = makeShow([{ delay: 600 }]);
  show.querySelector("img")!.dataset["color"] = "#336699";
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder .fill"), "the placeholder");
  const fill = part(show, ".placeholder .fill");
  await waitFor(() => getComputedStyle(fill).backgroundColor === "rgb(51, 102, 153)", `its colour (${getComputedStyle(fill).backgroundColor})`);
  assertEqual(part(show, ".placeholder").ariaBusy, "true", "marked busy");
  await settledOn(show, "1 of 1");
});

test("a swipe while the first photo loads steps from where the visitor is going", async () => {
  const show = makeShow([{ delay: 800 }, {}, {}, {}], { loop: "" });
  await waitFor(() => !!show.shadowRoot!.querySelector(".placeholder"), "the placeholder");
  const p = pointer(show);
  const x = p.left + p.width * 0.2;
  p.swipe(x, x + 320); // rightwards: the previous, which wraps to the last
  assertEqual(show.index, 3, "the last slide, not the one before it");
  await settledOn(show, "4 of 4");
});

test("a slidechange listener can go elsewhere at once", async () => {
  const show = makeShow([{}, {}, {}, {}, {}, { delay: 600 }]);
  await settledOn(show, "1 of 6");
  let sent = false;
  show.addEventListener("slidechange", () => {
    if (!sent) {
      sent = true;
      void show.goTo(5);
    }
  });
  await show.next();
  await settledOn(show, "6 of 6");
  const photo = figures(show)[0]!.querySelector("img")!;
  assert(photo.complete && photo.naturalWidth > 0, "the slide it went to has its photo");
});

test("slides without ids keep their place, and their photos, when one is added", async () => {
  const show = makeShow([{}, {}, {}]);
  await settledOn(show, "1 of 3");
  await show.goTo(2);
  await settledOn(show, "3 of 3");
  const slide = figures(show)[0]!;
  const photo = slide.querySelector("img")!;
  show.prepend(figure({}));
  await waitFor(() => show.count === 4, "the new slide");
  assertEqual(show.index, 3, "still on the same photo, now fourth");
  assertEqual(figures(show)[0], slide, "the same slide on screen");
  assertEqual(slide.querySelector("img"), photo, "the same photo, not fetched again");
});

test("a slide still loading arrives, and says so, when the markup changes meanwhile", async () => {
  const show = makeShow([{ title: "A" }, { delay: 500, title: "B" }]);
  await settledOn(show, "1 of 2");
  const going = show.goTo(1);
  await sleep(50);
  show.children[0]!.querySelector("figcaption")!.firstChild!.textContent = "A, fixed";
  assertEqual(await going, true, "the slide asked for was shown");
  assertEqual(onScreen(show), "2 of 2", "on screen");
});

test("slides set wrongly before Clack loads are reported, and the show still works", async () => {
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement(tagName) as unknown as Record<string, unknown>;
  early["slides"] = [{ id: "bad", alt: "", width: 1, height: 1, sources: [{ url: "javascript:alert(1)", width: 1 }] }];
  const show = document.adoptNode(early as unknown as ClackShow);
  show.append(figure({}));
  show.style.setProperty("--clack-transition-duration", "40ms");
  let reported: unknown = null;
  const onError = (e: ErrorEvent): void => {
    reported = e.error;
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    fixture().append(show);
  } finally {
    window.removeEventListener("error", onError);
  }
  assert(reported instanceof TypeError, `the bad slides were reported (${String(reported)})`);
  assertEqual(show.count, 1, "and the markup is read instead");
  await settledOn(show, "1 of 1");
});

test("the slides read from a show can be given back to it", async () => {
  const show = makeShow([{ id: "a" }, { id: "b" }, { id: "c" }]);
  await settledOn(show, "1 of 3");
  const photo = figures(show)[0]!.querySelector("img")!;
  show.slides = show.slides.filter((s) => s.id !== "b");
  assertEqual(show.count, 2, "the slides given back");
  assertEqual(figures(show)[0]!.querySelector("img"), photo, "the photo on screen is the same");
  let threw = false;
  try {
    show.slides = [{ ...show.slides[0]!, srcset: "a.jpg 1x, javascript:alert(1) 2x" }];
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, "a URL in a srcset that is not http(s) is refused");
});
