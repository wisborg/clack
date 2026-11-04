# Clack — plan

Clack is a slideshow for photographs that any website can embed: manual and automatic
progression, a chosen display size with a full-size view one click away, optional metadata
(hidden unless the page asks for it), and themes defined in files that anyone can write.
It also draws an index of the photos — a justified grid or a contact sheet — that opens the
slideshow at the photo chosen.

It is named after the sound a slide projector made between slides. Unlike the projector, it
should never show a half-loaded picture.

Its first user is [Shoebox](https://github.com/wisborg/shoebox), a self-hosted photo album,
but Clack knows nothing about Shoebox: it shows the photos and the metadata it is given, from
markup, a manifest, or JavaScript. Shoebox's plan holds the decisions the two share — the
dependency policy and the review process — and this one holds everything about the slideshow
and its themes.

Phase 0 is done and phase 1 is under way: see [Phases](#phases), and `docs/component.md`
for what the element does so far.

---

## Principles

- **Look and quality over speed of delivery.** A feature is finished when it looks right on a
  large calibrated screen and on a phone, not when it works.
- **No runtime dependencies**, and as few build dependencies as possible, each written down
  with its reason in `DEPENDENCIES.md`.
- **No third party at view time.** Clack requests the images and manifest it is given, and
  nothing else: no fonts from a font service, no analytics, no telemetry.
- **The host site stays in charge.** Clack never leaks styles into the page, never needs the
  page to loosen its Content-Security-Policy, and never shows metadata nobody asked it to
  (a slide's title and credit are its caption, shown as a `<figcaption>` is; see
  [Metadata](#metadata)).

---

## Decision 1: language

Clack runs in the visitor's browser, so it is JavaScript in the end; the choice is only
about how it is written and what it carries.

- **TypeScript source, shipped as one ES module.** Types catch whole classes of bugs in the
  state machine (slide index, play/pause, loading states) that tests rarely reach. What ships
  is ordinary JavaScript. The CSS travels inside it, as the text of a constructable stylesheet
  the shadow root adopts: no stylesheet URL for the host to configure, no flash of unstyled
  content, and no `<style>` element for the host's Content-Security-Policy to allow.
- **Zero runtime dependencies.** No framework, no utility library, no polyfills. Everything
  Clack needs — pointer events, the Fullscreen API, `IntersectionObserver`,
  `HTMLImageElement.decode()`, the Web Animations API, custom elements, Shadow DOM — is in
  every evergreen browser.
- **Rejected: a framework (React, Svelte, Lit…).** It would force a framework on host sites
  that don't use it, or carry a second copy into sites that use a different version. Lit is
  the most defensible of these (small, Google-maintained), but a slideshow is a small amount of
  DOM and the gain does not pay for the dependency.
- **Rejected: WebAssembly.** Nothing in a slideshow is compute-bound.

---

## Decision 2: build and test tooling — no Node

Node is not needed, and the npm ecosystem is where most recent supply-chain incidents
have happened. The front-end is built and tested without it, all through one Go program,
`go run ./tools/dev` (verified in phase 0; how each piece is checked is in
`DEPENDENCIES.md`):

- **Bundling and minifying: esbuild, through its Go API**
  (`github.com/evanw/esbuild/pkg/api`). esbuild is itself written in Go, has a very large user
  base, and its module depends only on `golang.org/x/sys`. It produces `dist/clack.js`
  (readable) and `dist/clack.min.js`, with source maps. It strips TypeScript types but does
  not check them, and a warning from it fails the build.
- **Type checking: TypeScript 7, built from source.** TypeScript 7 (August 2026) is the
  native port, written in Go. Its source is an ordinary Go module in `tsc/` of
  `microsoft/TypeScript`, so the tools fetch exactly one commit (the v7.0.2 tag's), verify
  its hash, and build it with the local Go toolchain; two builds are byte-identical. `go
  install` cannot do this, because the module proxy has no release version for it. The npm
  fallback the plan allowed for is not needed.
- **Browser tests: a small W3C WebDriver client of our own, in Go, standard library only.**
  WebDriver is HTTP and JSON. It drives Safari (`safaridriver` ships with macOS), Chrome
  (`chromedriver`) and Firefox (`geckodriver`) — all three real engines, which matters for a
  visual component — and takes screenshots for visual regression tests. The tools fetch
  chromedriver from Google's Chrome for Testing for the installed Chrome's build, and a
  pinned, checksummed geckodriver from Mozilla; Homebrew disabled its chromedriver package in
  2026, and the driver must follow Chrome's updates anyway. Rejected: Playwright (excellent,
  but Node and a large install), chromedp (Chrome only, several dependencies).
- **The test page enforces a strict Content-Security-Policy**, including Trusted Types, and
  any policy violation a test did not provoke on purpose fails the run. Every test is
  therefore also a test that Clack works on the strictest site that might embed it.
- **Logic tests** for the pure parts (state machine, layout maths, theme validation,
  ThumbHash decoding) run in the browser through the same harness, so there is one test
  runner, not two.
- **The Go toolchain is pinned** with `toolchain` in `go.mod`, and govulncheck is a gate: the
  first run found fifteen standard-library vulnerabilities in the installed Go 1.26.5, fixed
  by pinning the current release.

---

## Dependencies

What ships has none. What builds and tests it:

| dependency | for | verdict |
|---|---|---|
| Go toolchain, pinned | the build and test tools under `tools/` | — |
| `evanw/esbuild` (Go API) | bundling, minifying | accept: huge user base, depends only on `golang.org/x/sys` |
| TypeScript 7 (`tsgo`), built from a pinned commit | type checking | accept: Microsoft |
| `golang.org/x/vuln` (govulncheck) | the vulnerability gate | accept: the Go team |
| browser drivers (`safaridriver`, `chromedriver`, `geckodriver`) | browser tests | external programs, from the browser vendors |
| bundled fonts | the themes' typography | open-licensed (OFL), listed in `NOTICE`; served as files beside the module, since browsers do not reliably honour a font declared inside a shadow root |

`DEPENDENCIES.md` holds the full record: maintainers, licences, and how the copy of each that
we run is checked.

A WebDriver client, a test harness, the ThumbHash decoder and the theme loader are ours.

---

## The component

### Embedding

Three ways in, from least to most code, all of them the same component:

```html
<!-- 1. Markup only: works with no script at all, as a plain list of images -->
<clack-show autoplay="6s" fit="contain" theme="gallery">
  <figure>
    <img src="a-1280.jpg" srcset="a-640.jpg 640w, a-1280.jpg 1280w, a-2560.jpg 2560w"
         width="2560" height="1707" alt="Low tide at dawn"
         data-full="a-full.jpg">
    <figcaption>Low tide at dawn</figcaption>
    <script type="application/json" data-metadata>{"camera":"…","taken":"…"}</script>
  </figure>
  …
</clack-show>

<!-- 2. A manifest URL -->
<clack-show src="/albums/coast/manifest.json"></clack-show>

<!-- 3. JavaScript -->
<script type="module">
  import { Clack } from "/clack.js";
  Clack.create(element, { slides, autoplay: { interval: 6000 }, metadata: "toggle" });
</script>
```

- **A custom element** works in any site and inside any framework, because to all of them it
  is just an HTML element. **Shadow DOM** keeps the host site's CSS out of Clack and
  Clack's out of the site; themes reach in through CSS custom properties and `::part()`, which
  is the supported, stable way to style it.
- **Progressive enhancement:** the light-DOM markup is meaningful by itself (images with alt
  text and captions), so search engines, readers with script disabled, and the moment before
  the script loads all see photos, not an empty box.
- **The manifest** (`clack-manifest/1`, `docs/manifest.md`) is a JSON format with a published
  schema — the same format Shoebox produces — so Clack is usable with any backend.
- Published as one file plus a source map (fonts, when a theme bundles one, beside it), with
  SRI hashes in each release, so a site can copy the files and serve them itself. An npm package can come later; it is not the primary
  channel.

### Progression

- **Manual:** previous/next controls, arrow keys, Home/End, swipe and drag with
  velocity-aware snapping, optional thumbnail strip, optional click/tap zones on the image.
- **Automatic:** interval per show or per slide; loop or stop at the end; a visible progress
  indicator; and always a **pause control** — WCAG 2.2.2 requires one for content that moves on
  its own for more than five seconds. Auto-play pauses while the pointer is over the image or
  focus is inside Clack, and while the tab is hidden (Page Visibility), and resumes where
  it left off.
- **`prefers-reduced-motion`:** transitions become instant or a short fade; Ken Burns motion is
  off; auto-play still works but nothing slides.
- Events (`slidechange`, `play`, `pause`, `open-full`, `close-full`) and methods (`next()`,
  `goTo(i)`, `play()`) for host pages, and the URL fragment can track the current slide so a
  slide can be linked and the back button behaves.

### Size and the full-size view

- **Display size** is set by the host: `fit="contain"` (whole photo, letterboxed — the
  default), `fit="cover"` (fill the frame, cropped), or a fixed or maximum box
  (`width`/`height`/`max-height`, any CSS length). The frame's aspect ratio can follow each
  photo or be fixed so the page doesn't jump between portrait and landscape.
- The browser picks the resolution from `srcset`/`sizes` for the actual pixels on screen,
  device pixel ratio included, so a 4K screen gets a 4K image and a phone doesn't download one.
- **Click to open full size** (configurable: on, off, or a button only) opens a full-viewport
  view at the original resolution, with pinch and wheel zoom up to 1:1 pixels, panning, and
  double-tap/double-click to toggle fit and 1:1. It uses the Fullscreen API where the host
  allows it and a fixed overlay where it doesn't. The full-size file is fetched only when this
  view opens.

### Photo quality is mostly about loading

What makes a slideshow look professional or cheap is mostly what happens between images:

- **Never show a half-decoded image.** The next image is fetched and `decode()`d before the
  transition starts; a transition waits for decoding rather than revealing a partly painted
  image.
- **Preload** the next and previous slide (more when auto-playing, in the direction of travel),
  cancelling stale loads when someone skips ahead.
- **No layout shift:** every slide's dimensions are known in advance (from `width`/`height`
  or the manifest).
- **Placeholders:** a ThumbHash — about 25 bytes per photo, carried in the manifest — paints a
  blurred impression of the photo instantly while the real one loads. The decoder is ~150 lines
  we write ourselves, following the format's reference implementation (MIT, noted in `NOTICE`).
- **Colour:** images keep their ICC profile (see the media pipeline), so wide-gamut photos show
  in wide gamut on screens that can display it. The theme's background colours are chosen with
  this in mind: a neutral grey or black, never a tinted one, behind photographs.
- **Transitions** animate only `opacity` and `transform`, on the compositor: crossfade (the
  default), slide, Ken Burns (a slow, subtle pan-and-zoom; per-slide focus point optional), and
  none.

### Metadata

**The caption is not metadata.** A slide's title and credit are its caption — shown beneath
it by default, as a `<figcaption>` is in markup, and set as the theme says (`caption`
tokens). This is what a museum label or a printed photo book shows, and what the approved
mock-ups show; Shoebox's plan treats the `description` class the same way, as visible to
anyone who can see the photo. A page that wants no caption at all can turn it off (an
attribute, `caption="none"`, to come with metadata display). *(Decided with the user,
2026-11-02.)*

**Everything else is metadata, and hidden by default:** the caption's longer text, keywords,
camera, time, place, technical details and extra facts. When enabled: `metadata="toggle"` (an info button reveals it) or
`"visible"`; placed as an overlay, below the image, or in a side panel (a theme decision).
Shown fields and their order are configurable; structured fields (camera, lens, focal length,
aperture, shutter, ISO, date, place) are formatted by Clack using `Intl` for the visitor's
locale.

**Clack never reads metadata from the image file.** It shows what it is given. This keeps
it small, and it is what makes Shoebox's access control meaningful: the images Shoebox serves carry
no metadata to read.

### The index

A second element, `<clack-index>`, shows every photo of a show at once, styled by the same
theme's `index` tokens: a **justified grid** (rows of equal height, each photo in its own
proportions, filling the width) or a **contact sheet** (strips of film with frame numbers).
Choosing a photo opens the `<clack-show>` it is paired with at that photo, and closing the
show returns focus to the same thumbnail.

```html
<clack-index for="show" theme="contact-sheet">
  <a href="/albums/coast/low-tide"><img src="low-tide-320.jpg" srcset="…" width="3840"
     height="2560" alt="Low tide under a grey sky"></a>
  …
  <a rel="next" href="/albums/coast?page=2">More photos</a>
</clack-index>
<clack-show id="show" src="/albums/coast/manifest.json"></clack-show>
```

- **Decided (2026-11-01): Clack draws the index, not each host.** The index needs what the
  slideshow already has — `srcset`, ThumbHash placeholders, lazy loading, keyboard use and
  screen-reader labels — and the Contact sheet theme is only useful if the index is Clack's.
- **Markup first, like the show, and enhanced in place.** The light DOM is the list of links
  to each photo's page, which the host may already lay out as the justified grid in CSS
  alone (`flex-grow` in proportion to each photo's shape, every box sized before its photo
  arrives) — Shoebox does, from the same theme tokens. With script, Clack draws the same rows
  from the same rule, so nothing moves when it takes over, and a visitor returning with Back
  lands where they were.
- **Sections.** An index can be divided under headings — Shoebox shows a trip's days this
  way, a heading per day and its photos beneath — each section a group of its own in the
  markup.
- **Large albums come a page at a time.** A `rel="next"` link at the end works without
  script; with script, the next page is fetched as the visitor nears the end, and the rows
  continue without reflowing the ones above. (Whether pages also come as manifests is
  settled with the element.)
- **The same rules as the show:** Shadow DOM, the strict Content-Security-Policy, text only
  ever set as text, and only the images it is given are requested.

### Accessibility and security

- The WAI-ARIA carousel pattern: `aria-roledescription` "carousel"/"slide", "3 of 24" labels,
  a polite live region for manual navigation that is silent during auto-play, focus kept in
  place on navigation and trapped in the full-size view, all controls reachable and visible by
  keyboard, alt text required (missing alt is a console warning in development builds).
- Themes are checked for text contrast (WCAG AA) when they load, as osmbase checks a route's
  contrast against its palettes.
- Data is only ever inserted with `textContent` and attribute setters — never `innerHTML` — so
  a caption cannot become markup. No `eval`, no `new Function`, no inline event handlers; the
  component is tested on a page with a strict Content-Security-Policy and Trusted Types enforced.
  It makes no network request except for the images and manifest it is given.

### Targets

- Evergreen browsers: current Safari (macOS and iOS), Chrome/Edge, Firefox, and the version
  before each. iOS Safari is the most likely to be wrong and gets tested on a device.
- A size budget, measured in CI: JS + CSS under 32 KB compressed. It was 25 KB until
  2026-11-01: with the core and the manifest loader built (13.2 KB), the measured cost of
  the rest came to 28–29 KB. The choice was then between raising the budget, loading the
  rarer parts (the full-size view, the index) from further files, or cutting features;
  Clack staying one file mattered more than the number, which was set before anything was
  measured. Near the end of phase 1 the whole of `src/` is reviewed for size.
- Video slides (for fitdash videos, later) are kept possible by modelling a slide as a media
  item with a type, not as an `<img>`.

---

## Themes

### Format

A theme is a **JSON file of typed design tokens**, format `clack-theme/1`, with a published
JSON Schema (`schema/theme-1.schema.json`; every token is described in `docs/themes.md`). Mat,
abridged from `themes/mat.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/wisborg/clack/main/schema/theme-1.schema.json",
  "format": "clack-theme/1",
  "name": "Mat",
  "colors": {
    "light": { "canvas": "#e4e3df", "muted": "#636368", "mat": "#f8f7f3", "frame": "#1f1d1b" },
    "dark":  { "canvas": "#2a2a29", "mat": "#f8f7f3", "frame": "#0f0f0f" }
  },
  "layout": {
    "type": "matted",
    "padding": { "inline": { "min": "16px", "ideal": "4.4cqi", "max": "64px" } },
    "shadow": "none",
    "mat": { "width": { "min": "22px", "ideal": "6.5vmin", "max": "80px" }, "bevel": true }
  },
  "caption": { "size": "15px", "style": "italic", "card": true }
}
```

- **Every theme extends another**, `base` unless it names a built-in one, and sets only what
  it changes: objects merge key by key. `base` sets every token, so a theme of three lines is
  complete. Only built-in themes can be extended, so loading a theme never fetches another.
- **Tokens, not CSS.** Every value has a type (colour, length, duration, one of a fixed set of
  layouts and styles) and is validated before use, then compiled into CSS custom properties.
  A theme from a stranger can therefore do nothing but change how Clack looks: it cannot
  load a remote font or image (`url()` is not a token type), hide the pause button, or inject
  anything. Validation errors name the field and the problem.
- **Layouts are a fixed, curated set** implemented in our CSS — `full-bleed`, `matted` (photo
  in a mat board, like a framed print), `gallery` (generous margins, caption beneath, like a
  museum wall), `stage` (dark surround, image the only light) — and a theme picks and tunes
  one. A new layout is a code change; a new theme isn't.
- **Light and dark schemes** in every theme; the theme says whether it follows the visitor's
  `prefers-color-scheme` or forces one.
- **JSON** because browsers and Go both parse it with no dependency; comments (`//` and
  `/* */`) are allowed and stripped by our own loader so hand-written themes can be annotated.
- **Fonts are bundled or system**, never fetched from a font service. Bundled fonts are
  open-licensed (OFL), self-hosted, subset, and listed in `NOTICE`.
- **An escape hatch, later and only for site admins:** a theme may ship an extra stylesheet,
  which the host serves from its own origin. Arbitrary CSS is trusted content, so it is an admin
  capability, never something a theme file can do by itself.

### Out of the box

Five, each finished to the point of being someone's first choice, and each in light and dark
except Darkroom, which is dark by nature and says so in its theme file:

| theme | the idea |
|---|---|
| **Gallery** | white or charcoal walls, wide margins, small serif caption beneath |
| **Darkroom** | near-black, no chrome until the pointer moves, the photo is the only light |
| **Mat** | each photo in a mat board with a fine bevel, like a framed print |
| **Minimal** | edge to edge, controls on hover, sans-serif |
| **Contact sheet** | for indexes: a film-strip feel with frame numbers |

Before any of them are implemented, the look is settled in phase 0 as static HTML mock-ups
with real (licence-clean) photographs, and reviewed on a phone, a laptop and a large screen.

---

## Reviews

Clack follows the review process in Shoebox's plan. In short: every branch passes the gates
(type check, build, browser tests on all three engines, the size budget) and gets a code review
before it is reported ready to merge; whatever handles input from the page or the manifest —
the theme loader, the manifest parser, anything that writes to the DOM — also gets a security
review; the theme and manifest parsers are fuzzed; and the whole repository is reviewed at the
end of each phase. Visual changes are reviewed as screenshots on all three engines, side by
side with the version before.

---

## Phases

**0 — Foundations**
- Licence, `DEPENDENCIES.md`, the gates. *(done)*
- Verify the Node-free toolchain: esbuild through Go, tsgo, the WebDriver harness on Safari,
  Chrome and Firefox. *(done: Safari 26.5, Chrome 156 and Firefox 157 all pass)*
- Design: the visual language and the five themes as static mock-ups with real photographs,
  reviewed on phone, laptop and large screen. *(done: mock-ups in `design/`, with
  public-domain photographs; approved 2026-11-01)*
- Draft the theme and manifest schemas. *(drafted: `schema/`, the built-in themes in `themes/`,
  `docs/themes.md` and `docs/manifest.md`; checked by our own validator for the subset of JSON
  Schema they use, with the contrast of every built-in theme checked in each scheme)*

**1 — First release**
- Core: slides, manual navigation (controls, keys, swipe), responsive images,
  decode-before-show, preloading, ThumbHash placeholders, crossfade. *(done; what the
  element does is in `docs/component.md`, and `design/demo/` shows it with the design
  photographs. The ThumbHash decoder follows the format's reference implementation, the
  only definition the format has, so it carries that implementation's MIT notice, in the
  source, in the bundle and in `NOTICE`; the tools' encoder and decoder,
  `tools/internal/thumbhash`, are what it is tested against.)*
- Manifests: `<clack-show src>`, every value checked before any is used, against the same
  shared cases as the Go reference, and fuzzed in both. *(done. Clack checks against the
  published schemas themselves — shipped without their annotations, about 1.2 KB compressed
  each — with a validator of its own for the same subset of JSON Schema as the Go one, so
  the browser and the tools cannot disagree about a rule; themes will be checked the same
  way. Known limit: manifest URLs cannot use internationalised domain names, until the tools
  can check them as browsers do — the reasons, and what lifting it would take, are in
  `docs/manifest.md`, "Not supported, and why".)*
- Sizing modes and the full-size view with zoom and pan.
- Auto-play with pause control, visibility and reduced-motion handling.
- Metadata display (hidden by default), theme loading and validation, the five themes.
- The index, `<clack-index>`: justified and contact-sheet layouts, paired with a show,
  sections, paging, enhancing the host's layout in place.
- Title slides: a slide type that introduces a part of a show (a day of a trip), for
  Shoebox's slideshows of an album with its sub-albums.
- Accessibility pass, strict-CSP test page, documentation, a demo page.
- A review of all of `src/` for size, now that it is all there: what each part costs, and
  what can be made smaller without making it worse.

**2 — Polish**
- Ken Burns, thumbnail strip, URL fragment sync.

**Later**
- Video slides (Shoebox's activity albums and fitdash's videos).
- An npm package, if anyone asks for one.

---

## Licence

Apache-2.0, like the rest of the workspace.
