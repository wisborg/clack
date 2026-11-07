// The layouts a theme chooses (layout.type) and the header: what each
// draws, and that the mat and frame are measured as the schema says.
import type { ClackShow } from "../src/clack";
import { assert, assertEqual, fixture, skip, sleep, test } from "./harness";
import { contentBox, echo, figures, img, imageLog, makeShow, part, pointer, resetImageLog, settledOn, showBox as box, waitFor } from "./util";


/** A theme file that extends mat, with these lengths for the mat and frame. */
function matted(mat: string, frame: string, bevel = false): string {
  const theme = { format: "clack-theme/1", name: "Framed", extends: "mat", layout: { mat: { width: mat, bevel }, frame: { width: frame } } };
  return echo(JSON.stringify(theme), { path: `framed-${mat}-${frame}-${bevel}.json` });
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.6;

test("the header shows the show's title and how many photos it has, only with a title", async () => {
  const show = makeShow([{}, {}, {}]);
  await settledOn(show, "1 of 3");
  const header = part(show, ".header");
  assert(header.hidden, "no title: no header");
  show.setAttribute("label", "Coastlines");
  assert(!header.hidden, "a title: a header");
  assertEqual(part(show, ".header-title").textContent, "Coastlines", "the title");
  assertEqual(part(show, ".header-count").textContent, "3 photos", "how many photos");
  assert(header.getBoundingClientRect().height > 0, "drawn");
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(header.getBoundingClientRect().bottom <= stage.top, "above the stage");
  show.removeAttribute("label");
  assert(header.hidden, "the title gone: the header too");
});

test("the manifest's title is the header's, in the manifest's language", async () => {
  const manifest = {
    format: "clack-manifest/1",
    title: "Kystlinjer",
    lang: "da",
    slides: [{ id: "a", alt: "", width: 300, height: 200, sources: [{ url: "/img/300x200-6688aa.png?tag=header", width: 300 }] }],
  };
  const show = makeShow([], { src: echo(JSON.stringify(manifest), { path: "header.json" }) });
  await settledOn(show, "1 of 1");
  const title = part(show, ".header-title");
  assertEqual(title.textContent, "Kystlinjer", "the title");
  assertEqual(title.lang, "da", "in its language");
  assertEqual(part(show, ".header-count").textContent, "1 photo", "one photo");
});

test("a theme hides the header, and sets its type", async () => {
  const show = makeShow([{}], { label: "Coastlines", theme: "minimal" });
  await settledOn(show, "1 of 1");
  assertEqual(part(show, ".header").getBoundingClientRect().height, 0, "minimal: no header");
  show.theme = "darkroom";
  const title = getComputedStyle(part(show, ".header-title"));
  assertEqual(title.textTransform, "uppercase", "darkroom's: in capitals");
  assertEqual(title.fontSize, "13px", "at its size");
});

test("in the matted layout, the photo is in a mat and a frame, as wide as the theme says", async () => {
  const show = makeShow([{ width: 300, height: 200 }], { theme: matted("30px", "5px") });
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  const mount = getComputedStyle(part(show, ".slide .mount"));
  assertEqual(mount.paddingTop, "30px", "the mat");
  assertEqual(mount.borderTopWidth, "5px", "the frame");
  assertEqual(mount.backgroundColor, "rgb(248, 247, 243)", "in the mat's colour (#f8f7f3, in either scheme)");
  // The photo is fitted to the room the mount leaves it, and the whole
  // mount to the stage.
  const stage = contentBox(part(show, ".stage"));
  const photo = part(show, ".slide img").getBoundingClientRect();
  const room = { width: stage.width - 70, height: stage.height - 70 };
  assert(near(photo.width, Math.min(room.width, room.height * 1.5)), `the photo, ${photo.width} wide, fills its room, ${room.width}×${room.height}`);
  const framed = part(show, ".slide .mount").getBoundingClientRect();
  assert(framed.width <= stage.width + 0.5 && framed.height <= stage.height + 0.5, `the frame, ${framed.width}×${framed.height}, fits the stage, ${stage.width}×${stage.height}`);
  // And it is fetched at the width it is drawn at.
  assertEqual((part(show, ".slide img") as HTMLImageElement).sizes, `${Math.ceil(photo.width)}px`, "sizes");
});

test("a bevel is drawn in the mat's last 2px, and the mat follows a page's value for it", async () => {
  const show = makeShow([{}], { theme: matted("30px", "5px", true) });
  await waitFor(() => box(show).dataset["bevel"] === "true", "the theme");
  await settledOn(show, "1 of 1");
  const mount = (): CSSStyleDeclaration => getComputedStyle(part(show, ".slide .mount"));
  await waitFor(() => mount().paddingTop === "30px", "the mat, its bevel in it");
  assert(getComputedStyle(part(show, ".slide img")).boxShadow.includes("2px"), "the bevel drawn");
  show.style.setProperty("--clack-mat-width", "12px");
  await waitFor(() => mount().paddingTop === "12px", "the page's mat, measured again");
});

test("cqi in the mat and frame is of the show's width, not the stage's", async () => {
  // 600px wide, less the mat theme's margins: the stage is narrower.
  const show = makeShow([{}], { theme: matted("5cqi", "1cqi") });
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  const mount = getComputedStyle(part(show, ".slide .mount"));
  assertEqual(mount.paddingTop, "30px", "5% of 600px");
  assertEqual(mount.borderTopWidth, "6px", "1% of 600px");
});

test("in the matted layout, the place held for a photo is the photo's, mount and all", async () => {
  const show = makeShow([{ width: 300, height: 200, delay: 1200 }], { theme: matted("30px", "5px") });
  await waitFor(() => {
    const held = show.shadowRoot!.querySelector(".placeholder .mount");
    return !!held && getComputedStyle(held).paddingTop === "30px";
  }, "the placeholder, matted in this theme's mat");
  const held = part(show, ".placeholder .mount").getBoundingClientRect();
  await settledOn(show, "1 of 1");
  const shown = figures(show)[0]!.querySelector(".mount")!.getBoundingClientRect();
  assert(near(held.width, shown.width) && near(held.height, shown.height) && near(held.top, shown.top), `held ${held.width}×${held.height} at ${held.top}, shown ${shown.width}×${shown.height} at ${shown.top}`);
});

test("in every layout but matted, there is no mount: the photo is the box", async () => {
  for (const theme of ["gallery", "darkroom", "minimal"]) {
    const show = makeShow([{}], { theme });
    await settledOn(show, "1 of 1");
    assertEqual(getComputedStyle(part(show, ".slide .mount")).display, "contents", theme);
  }
});

test("full-bleed: the photo has the whole width, and the caption is kept off the edges", async () => {
  const show = makeShow([{ width: 300, height: 100, title: "Wide" }], { theme: "minimal" });
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const photo = part(show, ".slide img").getBoundingClientRect();
  assert(near(photo.width, host.width), `the photo, ${photo.width} wide, as wide as the show, ${host.width}`);
  const caption = part(show, ".caption").getBoundingClientRect();
  assert(caption.left - host.left >= 12, `the caption ${caption.left - host.left}px from the edge`);
});

test("the stage has no padding in any layout, so a photo's sizes are right before the stage is first measured", () => {
  for (const theme of ["base", "gallery", "darkroom", "mat", "minimal", "contact-sheet"]) {
    const stage = getComputedStyle(part(makeShow([{}], { theme }), ".stage"));
    assertEqual(`${stage.paddingTop} ${stage.paddingRight} ${stage.paddingBottom} ${stage.paddingLeft}`, "0px 0px 0px 0px", theme);
  }
});

test("on a show too small for its mat, the mat and frame give way, and the photo keeps two thirds", async () => {
  const show = makeShow([{ width: 300, height: 200 }], { theme: matted("80px", "20px") });
  show.style.width = "300px";
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  const stage = contentBox(part(show, ".stage"));
  const most = Math.min(stage.width, stage.height) / 6;
  const mount = part(show, ".slide .mount");
  const style = getComputedStyle(mount);
  const side = parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
  assert(side <= most + 0.6, `each side ${side}px, at most a sixth of ${Math.min(stage.width, stage.height)}px`);
  assert(parseFloat(style.paddingTop) < 80 && parseFloat(style.borderTopWidth) < 20, `the mat and frame narrowed together: ${style.paddingTop}, ${style.borderTopWidth}`);
  // In proportion, the frame in whole pixels.
  assert(Math.abs(parseFloat(style.borderTopWidth) - side / 5) <= 1, `in proportion: ${style.paddingTop}, ${style.borderTopWidth}`);
  const photo = part(show, ".slide img").getBoundingClientRect();
  assert(photo.width > 0 && photo.height >= (stage.height * 2) / 3 - 1, `the photo ${photo.width}×${photo.height}, in a stage ${stage.width}×${stage.height}`);
  const framed = mount.getBoundingClientRect();
  const room = part(show, ".stage").getBoundingClientRect();
  assert(framed.top >= room.top - 0.5 && framed.bottom <= room.bottom + 0.5, "the frame within the stage");
  assertEqual((part(show, ".slide img") as HTMLImageElement).sizes, `${Math.ceil(photo.width)}px`, "sizes");
});

test("a matted show asks for its first photo at the size it is drawn, mount and all", async () => {
  await resetImageLog();
  // Of two sizes, the larger only for a photo drawn without its mount.
  const dpr = devicePixelRatio;
  const small = img(Math.round(400 * dpr), Math.round((400 * dpr) / 1.5));
  const large = img(Math.round(600 * dpr), Math.round((600 * dpr) / 1.5));
  const show = document.createElement("clack-show") as ClackShow;
  show.setAttribute("theme", "mat");
  show.style.setProperty("--clack-mat-width", "30px");
  show.style.setProperty("--clack-frame-width", "5px");
  show.style.setProperty("--clack-transition-duration", "40ms");
  show.style.width = "600px";
  const fig = document.createElement("figure");
  const im = document.createElement("img");
  im.width = 300;
  im.height = 200;
  im.alt = "a photo";
  im.loading = "lazy"; // the markup's own, which a visitor never sees, not fetched
  im.srcset = `${small} ${Math.round(400 * dpr)}w, ${large} ${Math.round(600 * dpr)}w`;
  fig.append(im);
  show.append(fig);
  fixture().append(show);
  await settledOn(show, "1 of 1");
  const drawn = part(show, ".slide img").getBoundingClientRect().width;
  assert(drawn < 400, `drawn at ${drawn}px, which the smaller size covers`);
  await sleep(200);
  const log = await imageLog();
  assert(!log.some((e) => e.endsWith(large)), `the larger never asked for: ${log.join(" ")}`);
});

test("a change of theme to a matted one changes a photo's sizes once, to what it is drawn at", async () => {
  const show = makeShow([{ width: 300, height: 200 }]);
  await settledOn(show, "1 of 1");
  const photo = part(show, ".slide img") as HTMLImageElement;
  const seen: string[] = [];
  const watch = new MutationObserver(() => seen.push(photo.sizes));
  watch.observe(photo, { attributes: true, attributeFilter: ["sizes"] });
  try {
    show.theme = matted("30px", "5px");
    await waitFor(() => getComputedStyle(part(show, ".slide .mount")).paddingTop === "30px", "the mat");
    await sleep(100);
  } finally {
    watch.disconnect();
  }
  assertEqual(seen.join(" "), `${Math.ceil(photo.getBoundingClientRect().width)}px`, "once, to the width drawn");
});

test("a label of nothing but spaces is no title", async () => {
  const show = makeShow([{}], { label: "   " });
  await settledOn(show, "1 of 1");
  assert(part(show, ".header").hidden, "no header");
});

/** Two sizes of one photo, as a manifest or a script gives them: the smaller wide enough only for a photo drawn at most `fits` px wide. */
function twoSizes(fits: number, larger: number): { small: string; large: string; sources: { url: string; width: number }[] } {
  const dpr = devicePixelRatio;
  const w = (css: number): number => Math.round(css * dpr);
  const small = img(w(fits), Math.round(w(fits) / 1.5));
  const large = img(w(larger), Math.round(w(larger) / 1.5));
  return { small, large, sources: [{ url: small, width: w(fits) }, { url: large, width: w(larger) }] };
}

test("a manifest's title, shown in the header, is counted in the first photo's size", async () => {
  await resetImageLog();
  // 600px wide, its stage about 306px tall without the header and 270px
  // with it: a 3:2 photo drawn about 459px wide, or about 405px.
  const { large, sources } = twoSizes(430, 700);
  const manifest = { format: "clack-manifest/1", title: "Coastlines", slides: [{ id: "a", alt: "", width: 300, height: 200, sources }] };
  // Late enough that the stage is observed first, without the header.
  const show = makeShow([], { src: echo(JSON.stringify(manifest), { path: "titled.json", delay: 300 }) });
  await settledOn(show, "1 of 1");
  const drawn = part(show, ".slide img").getBoundingClientRect().width;
  assert(drawn <= 430, `drawn at ${drawn}px, which the smaller covers`);
  await sleep(200);
  assert(!(await imageLog()).some((e) => e.endsWith(large)), "the larger never asked for");
});

test("slides and a theme set before Clack loads: the first photo is asked for in the theme, mount and all", async () => {
  await resetImageLog();
  // Drawn about 363px wide in a 30px mat and 5px frame; 468px without.
  const { large, sources } = twoSizes(400, 600);
  const inert = document.implementation.createHTMLDocument("");
  const early = inert.createElement("clack-show") as unknown as Record<string, unknown>;
  early["slides"] = [{ id: "s", alt: "early", width: 300, height: 200, sources }];
  early["theme"] = "mat";
  const show = document.adoptNode(early as unknown as ClackShow);
  show.style.setProperty("--clack-mat-width", "30px");
  show.style.setProperty("--clack-frame-width", "5px");
  show.style.setProperty("--clack-transition-duration", "40ms");
  show.style.width = "600px";
  fixture().append(show);
  await settledOn(show, "1 of 1");
  const drawn = part(show, ".slide img").getBoundingClientRect().width;
  assert(drawn <= 400, `drawn at ${drawn}px, which the smaller covers`);
  await sleep(200);
  assert(!(await imageLog()).some((e) => e.endsWith(large)), "the larger never asked for");
});

test("under a page's transform, the first photo is asked for at its size as laid out, not as scaled", async () => {
  await resetImageLog();
  // Drawn about 363px wide; at half scale, its box is half that.
  const { small, sources } = twoSizes(200, 400);
  const card = fixture();
  card.style.transform = "scale(0.5)";
  card.style.transformOrigin = "0 0";
  const show = document.createElement("clack-show") as ClackShow;
  show.setAttribute("theme", "mat");
  show.style.setProperty("--clack-mat-width", "30px");
  show.style.setProperty("--clack-frame-width", "5px");
  show.style.setProperty("--clack-transition-duration", "40ms");
  show.style.width = "600px";
  card.append(show);
  // In the page, and not yet observed: the stage and the mat are read.
  show.slides = [{ id: "s", alt: "scaled", width: 300, height: 200, sources }];
  await settledOn(show, "1 of 1");
  await sleep(200);
  assert(!(await imageLog()).some((e) => e.endsWith(small)), "the smaller, for the scaled size, never asked for");
});

test("a photo that could not be loaded keeps within the stage, however little room there is", async () => {
  const show = makeShow([{ src: "/img/broken.png?tag=small-missing" }]);
  show.style.width = "300px";
  await settledOn(show, "1 of 1");
  const stage = part(show, ".stage").getBoundingClientRect();
  const missing = part(show, ".missing").getBoundingClientRect();
  assert(missing.bottom <= stage.bottom + 0.5 && missing.top >= stage.top - 0.5, `the box, ${missing.top}–${missing.bottom}, within the stage, ${stage.top}–${stage.bottom}`);
});

test("a wide frame on a small show, with no mat, is narrowed to fit, and never drawn wider than counted", async () => {
  const show = makeShow([{}], { theme: matted("0", "40px") });
  show.style.width = "300px";
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  await sleep(50);
  const stage = part(show, ".stage").getBoundingClientRect();
  const framed = part(show, ".slide .mount").getBoundingClientRect();
  assert(framed.top >= stage.top - 0.5 && framed.bottom <= stage.bottom + 0.5, `the frame, ${framed.top}–${framed.bottom}, within the stage, ${stage.top}–${stage.bottom}`);
  assertEqual(getComputedStyle(part(show, ".slide .mount")).paddingTop, "0px", "no mat");
  const photo = part(show, ".slide img").getBoundingClientRect();
  assertEqual((part(show, ".slide img") as HTMLImageElement).sizes, `${Math.ceil(photo.width)}px`, "sizes, as drawn");
});

test("a frame is drawn in whole pixels, and counted as drawn", async () => {
  const show = makeShow([{}], { theme: matted("10px", "1cqi") });
  show.style.width = "613px";
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  await waitFor(() => getComputedStyle(part(show, ".slide .mount")).borderTopWidth === "6px", "1% of 613px, as 6px");
  const stage = part(show, ".stage").style;
  assertEqual(`${stage.getPropertyValue("--clack-mat-inset")} ${stage.getPropertyValue("--clack-frame-inset")}`, "10px 6px", "counted as drawn: the 10px mat and the 6px frame");
  const room = contentBox(part(show, ".stage"));
  const photo = part(show, ".slide img").getBoundingClientRect();
  assert(near(photo.width, Math.min(room.width - 32, (room.height - 32) * 1.5)), `the photo, ${photo.width} wide, fills the room the 16px mount leaves in ${room.width}×${room.height}`);
});

test("a bevel is never wider than its mat", async () => {
  const show = makeShow([{}], { theme: matted("1px", "5px", true) });
  await waitFor(() => box(show).dataset["bevel"] === "true", "the theme");
  await settledOn(show, "1 of 1");
  const shadow = getComputedStyle(part(show, ".slide img")).boxShadow;
  assert(shadow.includes("1px") && !shadow.includes("2px"), `within the 1px mat: ${shadow}`);
});

test("a manifest's title of nothing but spaces is no title", async () => {
  const manifest = { format: "clack-manifest/1", title: "   ", slides: [{ id: "a", alt: "", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }] };
  const show = makeShow([], { src: echo(JSON.stringify(manifest), { path: "blank-title.json" }) });
  await settledOn(show, "1 of 1");
  assert(part(show, ".header").hidden, "no header");
});

/**
 * Every value each photo's sizes was set to while during runs: a photo
 * whose sizes changes after it is first set may be fetched twice.
 */
async function sizesSet(during: () => Promise<void>): Promise<Map<HTMLImageElement, string[]>> {
  const proto = HTMLImageElement.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, "sizes")!;
  const set: Map<HTMLImageElement, string[]> = new Map();
  Object.defineProperty(proto, "sizes", {
    ...own,
    set(this: HTMLImageElement, value: string) {
      const values = set.get(this) ?? [];
      set.set(this, [...values, value]);
      own.set!.call(this, value);
    },
  });
  try {
    await during();
  } finally {
    Object.defineProperty(proto, "sizes", own);
  }
  return set;
}

/** That each photo's sizes was set once, and to what it is drawn at, if it is on screen. */
function assertSetOnce(set: Map<HTMLImageElement, string[]>, show: ClackShow): void {
  assert(set.size > 0, "a photo was asked for");
  for (const [img, values] of set) {
    assertEqual(values.length, 1, `${img.alt}: sizes set ${values.join(", then ")}`);
  }
  const shown = part(show, ".slide img") as HTMLImageElement;
  assertEqual(shown.sizes, `${Math.ceil(shown.getBoundingClientRect().width)}px`, "the photo on screen: sizes, as drawn");
}

test("a titled manifest in a narrowed mat: each photo's size is set once, header, mat and all", async () => {
  let show: ClackShow | undefined;
  const set = await sizesSet(async () => {
    const manifest = { format: "clack-manifest/1", title: "Coastlines", slides: [{ id: "a", alt: "titled", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }] };
    show = makeShow([], { theme: "mat", src: echo(JSON.stringify(manifest), { path: "titled-mat.json", delay: 300 }) });
    // A mat wide enough to be narrowed on this stage, as the window's may be.
    show.style.setProperty("--clack-mat-width", "80px");
    await settledOn(show, "1 of 1");
    await sleep(100);
  });
  assertSetOnce(set, show!);
});

test("a second show in a theme file already here takes it up at once, and asks for its photo in it", async () => {
  const theme = matted("30px", "5px");
  const first = makeShow([{}], { theme });
  await waitFor(() => box(first).dataset["layout"] === "matted", "the theme, for the first show");
  let show: ClackShow | undefined;
  const set = await sizesSet(async () => {
    show = makeShow([{ width: 300, height: 200 }], { theme });
    assertEqual(box(show).dataset["layout"], "matted", "taken up at once");
    await settledOn(show, "1 of 1");
    await sleep(100);
  });
  assertSetOnce(set, show!);
});

test("a show hidden and shown again asks for a photo at its size, not as if it had none", async () => {
  const slides = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, alt: `photo ${i + 1}`, width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }));
  const show = makeShow([]);
  show.slides = slides;
  await settledOn(show, "1 of 6");
  show.hidden = true;
  await sleep(100); // observed with no size
  let done: Promise<boolean> | undefined;
  const set = await sizesSet(async () => {
    show.hidden = false;
    done = show.goTo(5); // in the same task: not yet observed again
    await done;
    await settledOn(show, "6 of 6");
  });
  const last = [...set].find(([img]) => img.alt === "photo 6");
  assert(last, "the last photo was asked for");
  assert(!last[1].includes("100vw"), `its sizes: ${last[1].join(", then ")}`);
});

test("a title that wraps onto another line is counted in the next photo's size", async () => {
  const manifest = (title: string, alt: string) => ({ format: "clack-manifest/1", title, slides: [{ id: "a", alt, width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }] });
  const show = makeShow([], { src: echo(JSON.stringify(manifest("Short", "first")), { path: "short-title.json" }) });
  show.style.width = "320px";
  await settledOn(show, "1 of 1");
  let ready: Promise<void> | undefined;
  const set = await sizesSet(async () => {
    const long = "A long title that will not fit on one line of a narrow show, nor two";
    show.src = echo(JSON.stringify(manifest(long, "second")), { path: "long-title.json" });
    ready = waitFor(() => part(show, ".slide img").getAttribute("alt") === "second", "the second manifest's photo");
    await ready;
    await sleep(100);
  });
  assert(part(show, ".header").getBoundingClientRect().height > 40, "the title on more than one line");
  assertSetOnce(set, show);
});

test("however large a theme's mat, the show does not widen what holds it", async () => {
  const holder = document.createElement("div");
  holder.style.width = "400px";
  holder.style.overflow = "auto";
  fixture().append(holder);
  const show = makeShow([{}], { theme: matted("40vw", "40vh") });
  holder.append(show); // from where makeShow put it
  show.style.width = "400px";
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  assert(holder.scrollWidth <= holder.clientWidth, `scrolls ${holder.scrollWidth} wide in ${holder.clientWidth}`);
});

test("a photo is cut off at the show's sides only while it is dragged or swiped", async () => {
  const show = makeShow([{}, {}, {}]);
  await settledOn(show, "1 of 3");
  assertEqual(getComputedStyle(box(show)).overflowX, "visible", "at rest: nothing cut off");
  const p = pointer(show);
  const x = p.left + p.width * 0.8;
  // As a swipe goes (pointer().swipe), but looked at before it is let go.
  p.send("pointerdown", x);
  for (let i = 1; i <= 8; i++) p.send("pointermove", x - (320 * i) / 8);
  assertEqual(getComputedStyle(box(show)).overflowX, "clip", "while dragged");
  p.send("pointerup", x - 320, { buttons: 0 });
  await settledOn(show, "2 of 3");
  await waitFor(() => getComputedStyle(box(show)).overflowX === "visible", "nothing cut off once it has moved on");
});

test("the stage's focus ring is drawn over the photo, inside the stage's edge", async () => {
  const show = makeShow([{}], { theme: "minimal", fit: "cover" });
  await settledOn(show, "1 of 1");
  const stage = part(show, ".stage");
  stage.focus({ focusVisible: true } as FocusOptions);
  if (!stage.matches(":focus-visible")) skip("this engine does not show focus asked for from script");
  const ring = getComputedStyle(stage, "::before");
  assertEqual(`${ring.outlineStyle} ${ring.outlineOffset} ${ring.zIndex} ${ring.position}`, "solid -2px 1 absolute", "a ring of its own, inside the edge, over the slides");
  assertEqual(getComputedStyle(stage).outlineStyle, "none", "not the stage's own, which the photo would cover");
});
