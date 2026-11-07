// The layouts a theme chooses (layout.type) and the header: what each
// draws, and that the mat and frame are measured as the schema says.
import type { ClackShow } from "../src/clack";
import { assert, assertEqual, fixture, sleep, test } from "./harness";
import { contentBox, echo, figures, img, imageLog, makeShow, part, resetImageLog, settledOn, showBox as box, waitFor } from "./util";


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
  assert(Math.abs(parseFloat(style.borderTopWidth) - side / 5) <= 0.5, `in proportion: ${style.paddingTop}, ${style.borderTopWidth}`);
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
