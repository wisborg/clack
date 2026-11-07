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

/**
 * A show made ready to be put in the page in the mat theme, its mat 30px
 * and its frame 5px (unless the theme is set otherwise), 600px wide, and
 * quick to cross-fade: its 3:2 photos drawn about 363px wide.
 */
function matShow(show: ClackShow, theme = true): ClackShow {
  if (theme) show.setAttribute("theme", "mat");
  show.style.setProperty("--clack-mat-width", "30px");
  show.style.setProperty("--clack-frame-width", "5px");
  show.style.setProperty("--clack-transition-duration", "40ms");
  show.style.width = "600px";
  return show;
}

/** A manifest of n photos, titled, served at a path of its own. */
function titled(title: string, n: number, path: string): string {
  const slides = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, alt: `${title} ${i + 1}`, width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }));
  return echo(JSON.stringify({ format: "clack-manifest/1", title, slides }), { path });
}

test("the header shows the manifest's title and how many photos it has, only with a title", async () => {
  const show = makeShow([{}, {}, {}]);
  await settledOn(show, "1 of 3");
  const header = part(show, ".header");
  assert(header.hidden, "no title: no header");
  show.src = titled("Coastlines", 3, "header-three.json");
  await waitFor(() => !header.hidden, "a title: a header");
  assertEqual(part(show, ".header-title").textContent, "Coastlines", "the title");
  await waitFor(() => part(show, ".header-count").textContent === "3 photos", "how many photos");
  assert(header.getBoundingClientRect().height > 0, "drawn");
  const stage = part(show, ".stage").getBoundingClientRect();
  assert(header.getBoundingClientRect().bottom <= stage.top, "above the stage");
  show.removeAttribute("src");
  await waitFor(() => header.hidden === true, "the title gone: the header too");
});

test("a label names the show for screen readers, and is not shown", async () => {
  const show = makeShow([{}], { label: "Coastlines" });
  await settledOn(show, "1 of 1");
  assert(part(show, ".header").hidden, "no header for a label");
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
  const show = makeShow([], { src: titled("Coastlines", 1, "header-minimal.json"), theme: "minimal" });
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

test("full-bleed with plain controls: the photo has the whole width, and the caption beneath is kept off the edges", async () => {
  const theme = echo(JSON.stringify({ format: "clack-theme/1", name: "Bleed", extends: "minimal", controls: { style: "plain", reveal: "always" } }), { path: "bleed-plain.json" });
  const show = makeShow([{ width: 300, height: 100, title: "Wide" }], { theme });
  await waitFor(() => box(show).dataset["controls"] === "plain" && box(show).dataset["layout"] === "full-bleed", "the theme");
  await settledOn(show, "1 of 1");
  const host = show.getBoundingClientRect();
  const photo = part(show, ".slide img").getBoundingClientRect();
  assert(near(photo.width, host.width), `the photo, ${photo.width} wide, as wide as the show, ${host.width}`);
  const caption = part(show, ".caption").getBoundingClientRect();
  assert(caption.left - host.left >= 12, `the caption ${caption.left - host.left}px from the edge`);
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
  // Of two sizes, the larger only for a photo drawn without its mount:
  // drawn about 363px wide in the mount, 468px without.
  const { large, sources } = twoSizes(400, 600);
  const show = matShow(document.createElement("clack-show") as ClackShow);
  const fig = document.createElement("figure");
  const im = document.createElement("img");
  im.width = 300;
  im.height = 200;
  im.alt = "a photo";
  im.loading = "lazy"; // the markup's own, which a visitor never sees, not fetched
  im.srcset = sources.map((s) => `${s.url} ${s.width}w`).join(", ");
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
  const show = matShow(document.adoptNode(early as unknown as ClackShow), false);
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
  const show = matShow(document.createElement("clack-show") as ClackShow);
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
async function sizesSet(during: () => Promise<void>, onFirst?: (img: HTMLImageElement) => void): Promise<Map<HTMLImageElement, string[]>> {
  const proto = HTMLImageElement.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, "sizes")!;
  const set: Map<HTMLImageElement, string[]> = new Map();
  Object.defineProperty(proto, "sizes", {
    ...own,
    set(this: HTMLImageElement, value: string) {
      const values = set.get(this) ?? [];
      if (values.length === 0) onFirst?.(this);
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
  // Narrower now than when it was last laid out.
  show.style.width = "400px";
  const set = await sizesSet(async () => {
    show.hidden = false;
    await show.goTo(5); // in the same task: not yet observed again
    await settledOn(show, "6 of 6");
  });
  const last = [...set].find(([img]) => img.alt === "photo 6");
  assert(last, "the last photo was asked for");
  // Set once, to the width it is drawn at now, not as it was (459px), to
  // a pixel: an engine's layout may round it either way.
  const drawn = part(show, ".slide img").getBoundingClientRect().width;
  assert(last[1].length === 1 && Math.abs(parseFloat(last[1][0]!) - drawn) <= 1, `its sizes: ${last[1].join(", then ")}, drawn at ${drawn}px`);
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

test("a show hidden leaves its photos' sizes as they were", async () => {
  const show = makeShow([{}, {}, {}]);
  await settledOn(show, "1 of 3");
  await sleep(200); // the others preloaded
  const set = await sizesSet(async () => {
    show.hidden = true;
    await sleep(150); // observed with no size
  });
  assertEqual([...set.values()].flat().join(" "), "", "no size given while it has none");
});

test("a show hidden still goes where it is asked, its photo fetched at the size it was last drawn at", async () => {
  const show = makeShow([{}, {}, {}, {}, {}]);
  await settledOn(show, "1 of 5");
  const drawn = (part(show, ".slide img") as HTMLImageElement).sizes;
  show.hidden = true;
  await sleep(100);
  const set = await sizesSet(async () => {
    const went = await Promise.race([show.goTo(4), sleep(3000).then(() => "waiting")]);
    assertEqual(went, true, "goTo resolves, hidden");
  });
  const last = [...set].find(([img]) => img.alt === "photo 5");
  assert(last, "the photo asked for");
  assertEqual(last[1].join(" "), drawn, "at the size the photos were drawn at");
});

test("a show hidden, given new slides and shown again in one go, shows them", async () => {
  const show = makeShow([{}, {}]);
  await settledOn(show, "1 of 2");
  show.hidden = true;
  await sleep(100);
  show.slides = [{ id: "n", alt: "new", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
  show.hidden = false;
  await settledOn(show, "1 of 1");
  assertEqual(part(show, ".slide img").getAttribute("alt"), "new", "the new photo, on screen");
});

test("a theme changed while the show is hidden is drawn in when it is shown again", async () => {
  const show = makeShow([{}], { theme: matted("30px", "5px") });
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  await waitFor(() => getComputedStyle(part(show, ".slide .mount")).paddingTop === "30px", "mounted");
  show.hidden = true;
  await sleep(100);
  show.theme = "gallery";
  show.hidden = false;
  const stage = part(show, ".stage").style;
  assertEqual(`${stage.getPropertyValue("--clack-mat-inset")} ${stage.getPropertyValue("--clack-frame-inset")}`, "0px 0px", "no mount in gallery");
  const room = contentBox(part(show, ".stage"));
  const photo = part(show, ".slide img").getBoundingClientRect();
  assert(near(photo.width, Math.min(room.width, room.height * 1.5)), `the photo, ${photo.width} wide, fills ${room.width}×${room.height}`);
});

test("captions with and without a credit, or a title, keep the stage the same height", async () => {
  const show = makeShow([{ title: "One", credit: "Someone" }, { title: "Two" }, {}]);
  await settledOn(show, "1 of 3");
  const heights: number[] = [];
  for (const at of ["1 of 3", "2 of 3", "3 of 3"]) {
    await settledOn(show, at);
    heights.push(part(show, ".stage").getBoundingClientRect().height);
    if (at !== "3 of 3") await show.next();
  }
  assert(heights.every((h) => near(h, heights[0]!)), `the stage: ${heights.join(", ")}`);
});

test("a drag whose photo's slide is taken away does not move on when it is let go", async () => {
  const show = makeShow([]);
  const slide = (id: string) => ({ id, alt: id, width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] });
  show.slides = [slide("a"), slide("b"), slide("c")];
  await settledOn(show, "1 of 3");
  await sleep(200); // the others ready
  const p = pointer(show);
  const x = p.left + p.width * 0.8;
  p.send("pointerdown", x);
  p.send("pointermove", x - 60);
  show.slides = [slide("b"), slide("c")]; // "a", on screen, gone
  const at = show.index;
  for (let i = 2; i <= 8; i++) p.send("pointermove", x - 40 * i);
  p.send("pointerup", x - 320, { buttons: 0 });
  await sleep(300);
  assertEqual(show.index, at, "where the slides put it, not a step on");
  assertEqual(getComputedStyle(box(show)).overflowX, "visible", "nothing cut off");
});

test("the header's count is there before the first photo is asked for", async () => {
  const counts: string[] = [];
  let show: ClackShow | undefined;
  const set = await sizesSet(async () => {
    const manifest = { format: "clack-manifest/1", title: "Coastlines", slides: [{ id: "a", alt: "counted", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }] };
    show = makeShow([], { src: echo(JSON.stringify(manifest), { path: "counted.json", delay: 200 }) });
    await settledOn(show!, "1 of 1");
  }, (img) => counts.push(`${img.alt}: ${part(show!, ".header-count").textContent}`));
  assert(set.size > 0, "a photo was asked for");
  assertEqual(counts[0], "counted: 1 photo", "the count, when the photo was first given its size");
});

test("a swipe back to the photo on screen, while another is coming, springs back", async () => {
  const show = makeShow([{}, { delay: 1500 }, {}]);
  await settledOn(show, "1 of 3");
  void show.next(); // the second, still coming
  const p = pointer(show);
  const x = p.left + p.width * 0.2;
  p.swipe(x, x + 320); // rightwards: back to the first, on screen
  await waitFor(() => !figures(show).some((f) => f.style.getPropertyValue("--clack-drag")), "the photo back in place");
  await waitFor(() => getComputedStyle(box(show)).overflowX === "visible", "nothing cut off");
  assertEqual(show.index, 0, "on the first");
});

test("a drag cut short -- the slides taken away, or the show moved -- leaves nothing behind", async () => {
  for (const cut of ["slides emptied", "moved"] as const) {
    const show = makeShow([], {});
    show.slides = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, alt: `photo ${i + 1}`, width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }));
    await settledOn(show, "1 of 3");
    const p = pointer(show);
    const x = p.left + p.width * 0.8;
    p.send("pointerdown", x);
    p.send("pointermove", x - 60);
    assertEqual(getComputedStyle(box(show)).overflowX, "clip", `${cut}: while dragged`);
    const figure = figures(show)[0]!;
    if (cut === "slides emptied") {
      show.slides = [];
    } else {
      const place = show.parentElement!;
      show.remove();
      place.append(show);
    }
    assertEqual(getComputedStyle(box(show)).overflowX, "visible", `${cut}: nothing cut off`);
    assertEqual(figure.style.getPropertyValue("--clack-drag"), "", `${cut}: the photo back in place`);
  }
});

test("a narrowed frame is never narrowed away", async () => {
  const show = makeShow([{}], { theme: matted("80px", "2px") });
  show.style.width = "320px";
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  await waitFor(() => parseFloat(getComputedStyle(part(show, ".slide .mount")).paddingTop) < 80, "narrowed");
  // A device pixel: half a CSS pixel on a screen of twice the density.
  const border = parseFloat(getComputedStyle(part(show, ".slide .mount")).borderTopWidth);
  assert(Math.abs(border - 1 / devicePixelRatio) < 0.01, `a pixel, at least: ${border}px`);
});

test("a theme file already here, set before Clack loads with slides, is the one the first photo is asked for in", async () => {
  const theme = matted("30px", "5px");
  const first = makeShow([{}], { theme });
  await waitFor(() => box(first).dataset["layout"] === "matted", "the theme, for the first show");
  let show: ClackShow | undefined;
  const set = await sizesSet(async () => {
    const inert = document.implementation.createHTMLDocument("");
    const early = inert.createElement("clack-show") as unknown as Record<string, unknown>;
    early["slides"] = [{ id: "s", alt: "early, in a file's theme", width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] }];
    early["theme"] = theme;
    show = document.adoptNode(early as unknown as ClackShow);
    show.style.setProperty("--clack-transition-duration", "40ms");
    show.style.width = "600px";
    fixture().append(show);
    assertEqual(box(show).dataset["layout"], "matted", "taken up at once");
    await settledOn(show, "1 of 1");
    await sleep(100);
  });
  assertSetOnce(set, show!);
});

test("a stage the page gives padding, counted in its width, is measured by the room inside it", async () => {
  const page = new CSSStyleSheet();
  page.replaceSync("clack-show.padded::part(stage) { box-sizing: border-box; padding: 12px; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, page];
  try {
    const show = makeShow([{}], { class: "padded" });
    await settledOn(show, "1 of 1");
    const photo = part(show, ".slide img") as HTMLImageElement;
    assertEqual(photo.sizes, `${Math.ceil(photo.getBoundingClientRect().width)}px`, "sizes, as drawn");
  } finally {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== page);
  }
});

test("a page's own animation of its slides does not keep the show cut off at its sides", async () => {
  const page = new CSSStyleSheet();
  page.replaceSync("@keyframes clack-test-breathe { to { opacity: 0.98; } } clack-show.breathing::part(slide) { animation: clack-test-breathe 10s infinite; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, page];
  try {
    const show = makeShow([{}, {}], { class: "breathing" });
    await settledOn(show, "1 of 2");
    const p = pointer(show);
    const x = p.left + p.width * 0.5;
    await letGoSlowly(p, x, 40); // too short, and slow: back it springs
    await waitFor(() => getComputedStyle(box(show)).overflowX === "visible", "nothing cut off once it is back");
  } finally {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== page);
  }
});

test("a photo caught again as it springs back follows the finger", async () => {
  const show = makeShow([{}, {}]);
  await settledOn(show, "1 of 2");
  const p = pointer(show);
  const x = p.left + p.width * 0.5;
  await letGoSlowly(p, x, 40);
  const figure = figures(show)[0]!;
  assert(figure.getAnimations().length > 0, "springing back");
  await sleep(40); // part of the way back
  const caught = new DOMMatrix(getComputedStyle(figure).transform).m41;
  assert(caught < -1, `caught on its way back: at ${caught}px`);
  p.send("pointerdown", x);
  p.send("pointermove", x - 30);
  p.send("pointermove", x - 60);
  assertEqual(figure.getAnimations().length, 0, "the spring back let go of");
  const now = new DOMMatrix(getComputedStyle(figure).transform).m41;
  assert(Math.abs(now - (caught - 60)) < 1, `followed from where it was caught, ${caught}px: at ${now}px`);
  await sleep(150);
  p.send("pointermove", x - 60);
  p.send("pointerup", x - 60, { buttons: 0 });
  await sleep(300);
});

test("a show with no credit keeps no line for one", async () => {
  const show = makeShow([{ title: "One" }, { title: "Two" }]);
  await settledOn(show, "1 of 2");
  assertEqual(getComputedStyle(part(show, ".credit")).display, "none", "no credit line");
  const credited = makeShow([{ title: "One", credit: "Someone" }, { title: "Two" }]);
  await settledOn(credited, "1 of 2");
  await credited.next();
  await settledOn(credited, "2 of 2");
  assert(part(credited, ".credit").getBoundingClientRect().height > 0, "but one where some slide has a credit, for every slide");
});

test("a manifest arriving does not give the markup's photos, about to go, sizes of its own", async () => {
  const show = makeShow([{}, {}, {}]);
  await settledOn(show, "1 of 3");
  await sleep(200); // the markup's neighbours preloaded
  const markup = new Set(figures(show).map((f) => f.querySelector("img")!));
  const set = await sizesSet(async () => {
    show.src = titled("Arriving", 2, "arriving.json");
    await waitFor(() => part(show, ".header-title").textContent === "Arriving", "the manifest");
    await settledOn(show, "1 of 2");
  });
  // The markup's photos are "photo 1" and on; the manifest's, "Arriving 1" and on.
  const resized = [...set.keys()].filter((img) => markup.has(img) || img.alt.startsWith("photo"));
  assertEqual(resized.map((img) => img.alt).join(", "), "", "none of the markup's photos given new sizes");
});

test("a frame of a fraction of a pixel is drawn, and counted, as the browser draws it: rounded down", async () => {
  const show = makeShow([{}], { theme: matted("10px", "9.6px") });
  await waitFor(() => box(show).dataset["layout"] === "matted", "the theme");
  await settledOn(show, "1 of 1");
  const want = Math.floor(9.6 * devicePixelRatio) / devicePixelRatio;
  const border = parseFloat(getComputedStyle(part(show, ".slide .mount")).borderTopWidth);
  assert(Math.abs(border - want) < 0.01, `${border}px, want ${want}px`);
  assertEqual(part(show, ".stage").style.getPropertyValue("--clack-frame-inset"), `${want}px`, "counted as drawn");
});

/** A drag of the photo by `by` px leftwards, held still before it is let go: too slow to be a flick. */
async function letGoSlowly(p: ReturnType<typeof pointer>, x: number, by: number): Promise<void> {
  p.send("pointerdown", x);
  p.send("pointermove", x - by / 2);
  p.send("pointermove", x - by);
  await sleep(150);
  p.send("pointermove", x - by);
  p.send("pointerup", x - by, { buttons: 0 });
}

test("a drag cut short still keeps the click its release makes from the page", async () => {
  const show = makeShow([]);
  const slide = (id: string) => ({ id, alt: id, width: 300, height: 200, sources: [{ url: img(300, 200), width: 300 }] });
  show.slides = [slide("a"), slide("b")];
  await settledOn(show, "1 of 2");
  let clicks = 0;
  show.addEventListener("click", () => clicks++);
  const p = pointer(show);
  const x = p.left + p.width * 0.8;
  p.send("pointerdown", x);
  p.send("pointermove", x - 40);
  p.send("pointermove", x - 80);
  show.slides = [slide("b")]; // "a", dragged, gone
  p.send("pointerup", x - 80, { buttons: 0 });
  p.stage.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  assertEqual(clicks, 0, "the release's click kept back");
});

test("a show going back from a manifest to its markup does not give the manifest's photos new sizes", async () => {
  const show = makeShow([{}, {}]);
  show.src = titled("Leaving", 3, "leaving.json");
  await waitFor(() => part(show, ".header-title").textContent === "Leaving", "the manifest");
  await settledOn(show, "1 of 3");
  await sleep(200); // its neighbours preloaded
  const set = await sizesSet(async () => {
    show.removeAttribute("src");
    await settledOn(show, "1 of 2");
  });
  const resized = [...set.keys()].filter((img) => img.alt.startsWith("Leaving"));
  assertEqual(resized.map((img) => img.alt).join(", "), "", "none of the manifest's photos given new sizes");
});
