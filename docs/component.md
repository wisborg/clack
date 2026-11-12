# `<clack-show>`

What the element does today, as built (phase 1, in progress). The plan for the rest is in
[`plan.md`](plan.md).

```html
<script type="module" src="/clack.js"></script>

<clack-show label="Coastlines" loop>
  <figure id="low-tide">
    <img src="low-tide-1280.jpg" srcset="low-tide-640.jpg 640w, low-tide-1280.jpg 1280w"
         width="3840" height="2560" alt="Low tide under a grey sky" loading="lazy">
    <figcaption>Low tide <small>Photo: A. Photographer</small></figcaption>
  </figure>
  …
</clack-show>
```

## Markup

Each child `<figure>` holding an `<img>` — bare, or in a `<picture>` with `<source>`s for
other formats — is a slide, and so is each child `<img>`. Anything else is left alone.

- A `lang` attribute marks a slide's text as in that language: on the `<img>` (or around it,
  inside the show) for its description, on the `<figcaption>` (or around it) for its
  caption, on the `<small>` for its credit. Without one, they are in the page's language.
  `lang=""` says the language is unknown, and is kept so.
- `alt` is the photo's description. Without it Clack warns in the console; `alt=""` says the
  caption already describes it.
- `width` and `height` are required: they keep the photo's space before it loads, so the
  page never jumps. Without them Clack warns and assumes 3:2.
- `src` and `srcset` are used as the page wrote them, as the page's own images use theirs.
- `srcset` (with `w` descriptors) offers the photo at several sizes. Clack works out the
  `sizes` itself, from the size each photo is drawn at.
- The `<figcaption>` is the title; a `<small>` inside it is the credit. Together they are the
  slide's caption, shown beneath the photo — as are a manifest slide's `title` and
  `credit`. Nothing else about a photo is shown unless the page asks.
- The figure's `id` is the slide's id, used by `goTo` and in events. A slide without one is
  numbered by its place, and Clack recognises it by its photo, so it keeps its place when
  others are added before it; a repeated id is renumbered, with a warning.
- `data-full` names the full-size file, for the full-size view still to come (an http,
  https or relative URL; anything else is ignored, with a warning). `data-color` is a
  colour (`#rrggbb`) that holds the slide's place until the show's first photo is shown, and
  `data-thumbhash` a [ThumbHash](https://evanw.github.io/thumbhash/) in base64, painted over
  it as a blurred impression of the photo — the same as a manifest's `placeholder.thumbhash`,
  and held to the same rules (one a manifest could not give is ignored, with a warning).

**Give the images `loading="lazy"`.** Without script the markup is a plain list of photos —
what a reader without script, or a search engine, sees. With script, Clack draws its own
copies of the photos and the markup is not displayed, but a browser fetches every image in
the page that is not lazy, displayed or not.

Clack follows changes to the markup as they happen, keeping its place by slide id. A
caption fixed or a slide added changes only the words and the count: the photo on screen,
and every photo whose slide is unchanged, stays as it is.

A property set on the element before Clack has loaded (`src`, `slides`, `loop`) is taken up
when it loads, before anything is fetched; slides it refuses are reported as an error
(`reportError`), and the show goes on with its manifest or its markup, as if none had been
set. A slide still on its way when the slides change arrives where it now is.

## Slides from a manifest

```html
<clack-show src="/albums/coast/manifest.json">
  <!-- optional: markup shown until the manifest arrives, and if it cannot be had -->
</clack-show>
```

`src` names a manifest ([`manifest.md`](manifest.md)). Until the first arrives, the
markup's slides are shown, as they are without script, and followed as the markup changes;
when `src` changes, the slides shown stay until the new manifest arrives. Its slides then
take their place; its title names the show if `label` does not, and its language is set on
its own text — captions, the photos' descriptions, titles in announcements, and the show's
name where the browser can label by element — while Clack's own words stay in the page's.
Slides from script withdrawn (`slides = null`) bring back a manifest already loaded at once,
without fetching it again. A show moved in the page, however long the move takes, never
fetches its manifest again; one that arrives while the show is out of the page is shown
when it is back.

A manifest that cannot be had — a failed request, the wrong type, too large, not JSON, or
not a valid manifest — brings back the markup's slides (never a previous manifest's), shows
a short notice in the show ("The photos could not be loaded."), fires an `error` event, and
logs every problem found to the console, each named by its place in the file. The notice
goes when the page moves on: another `src`, none, or slides from script. Changing `src`
drops a manifest still on its way; removing it goes back to the markup.

## Slides from script

```js
show.slides = [
  { id: "low-tide", alt: "Low tide under a grey sky", width: 3840, height: 2560,
    sources: [
      { url: "low-tide-1280.avif", width: 1280, type: "image/avif" },
      { url: "low-tide-1280.jpg", width: 1280 },
    ],
    description: { title: "Low tide", credit: "A. Photographer" } },
];
```

The shape is a manifest's slide (see [`manifest.md`](manifest.md)), checked by the same
rules as in a manifest — the manifest schema's own — so whatever a manifest may hold, a
script may give, and nothing else: URLs in printable ASCII (a space is `%20`), at most
sixteen sources, the image types listed, no property the format does not know (but `x-`
ones), each width of each type once, a `thumbhash` that is one. A `null` or `undefined` field is taken as absent; an
object may be used twice (`full` may be one of the `sources`). Slides are plain data, as
JSON gives it: only an object's own fields are read. Relative URLs are relative to the page
as it is when the slides are given, and kept so, however the page's address changes later.
Or the
shape is Clack's own, as the `slides` getter returns it — so `show.slides =
show.slides.filter(…)` works, the photos of the slides kept are not fetched again, and each
slide keeps its languages (`lang`, `captionLang`, `creditLang`); its `color` and `thumbhash`
are as a manifest's `placeholder` has them, and one that is not refused like any other bad
value (unlike `data-color` and `data-thumbhash`, which are ignored with a warning). Sources are grouped by
type into a `<picture>`; the untyped ones make the `<img>`. A slide that cannot be shown
throws a `TypeError` that names it and says why, and the show keeps the slides it had. While slides come from
script neither the markup nor a manifest is read; `show.slides = null` goes back to them.

## Attributes

| attribute | |
|---|---|
| `src` | a manifest to show (see above) |
| `label` | what the show is called, for screen readers (default: the manifest's title, or "Photos"); not shown — the header shows the manifest's title |
| `loop` | the next of the last slide is the first, and the other way round |
| `fit` | `contain` (default): the whole photo, as large as fits. `cover`: the frame filled, cropped |
| `theme` | how the show looks: a built-in theme's name (`gallery`, `darkroom`, `mat`, `minimal`, `contact-sheet`, or `base`, which is what it is without one), or the URL of a theme file (see [Styling](#styling)) |

The element is 3:2 unless the page gives it a height.

## Properties, methods and events

| | |
|---|---|
| `index` | the slide asked for — it may still be loading |
| `count` | how many slides |
| `loop` | the `loop` attribute, as a boolean |
| `src` | the `src` attribute, as a property: setting it is setting the attribute |
| `theme` | the `theme` attribute, likewise |
| `slides` | the slides, as Clack reads them; set to give them from script |
| `next()`, `previous()` | move one slide; the promise says whether it was shown (`false` if another was asked for first) |
| `goTo(index or id)` | go to a slide; rejects with a `RangeError` if there is none |
| `slidechange` event | a slide is on screen: `detail` is `{ index, id, previous }` |
| `error` event | the manifest named by `src` could not be had (the console says why) |

## What it does for the visitor

- **Controls:** previous and next, and a counter. At the ends of a show that does not loop
  they are marked unavailable (`aria-disabled`), not disabled, so keyboard focus stays.
- **Keys** (with focus in the show): ← and → move the way the text runs (so the other way
  round in a right-to-left page), Home and End go to the first and last. A click anywhere
  in the show gives it focus for them — even on a control in Safari, or Firefox on a Mac,
  whose clicks focus no button. Where a click leaves focus on the show itself — on the
  caption, the title or the mat, or in Safari and Firefox on a Mac on a control — Shift with
  a key is left to the page, to extend a selection; on the photo it moves the show.
- **Swipe and drag**, with touch, pen or mouse: a long drag or a quick flick moves on; a
  short one springs back; up-and-down is left to the page, to scroll. At the ends the photo
  resists.
- **Never a half-loaded photo.** The next photo is fetched at the size it is drawn and
  decoded before it is shown; until then the current one stays, the counter already says
  where the visitor is going, and if it takes more than a moment a hairline sweeps the foot
  of the frame. A newer request always wins over an older, slower one. A photo asked for
  while the show is hidden is fetched at the size it was last drawn at — before the show was
  ever laid out, at the window's width — so that whatever waits on it is not left waiting;
  hiding a show does not change the size of the photos it has.
- **Loading ahead:** once a photo is on screen, the next, the previous, and the one after
  next are fetched. Photos no longer near are let go of (Firefox then stops their download;
  Chrome and Safari finish it into their cache).
- **A crossfade or a slide** between photos, as the theme says. With reduced motion a slide
  becomes a short crossfade, and a crossfade is shortened; while the page is hidden, the
  change is made at once.
- **A photo that cannot be loaded** keeps its place, with its description and a note
  saying so; the show goes on.
- **Screen readers** hear the show as a carousel of slides ("3 of 24"), and the visitor's
  own moves are announced politely ("Photo 3 of 24: Low tide"); moves made by the page's
  script are not.

## Styling

A theme ([`themes.md`](themes.md)) says how the show looks. The `theme` attribute names a
built-in one, taken up at once, or the URL of a theme file. A value with no `.`, `/` or `:`
in it is always a name: one that is not a built-in theme's (`Darkroom`, `galery`, `dark
room`) is refused with a message in the console, and never fetched, so a theme file's URL
needs one of them (`harbour.json`, `./harbour`). Spaces around the value are ignored.

A theme file is fetched as a manifest is — once the show is in the page, served as JSON,
cookies sent to the page's own origin only — and checked whole before anything of it is
used; until it is here the show keeps the theme it had, and if it cannot be had or is
refused — or takes more than 30 seconds to arrive, from the last time it was asked for — the show keeps that theme for good and
the console says why, each problem by its place in the file. A show that is not in the page
fetches nothing and says nothing. The last few files asked for are kept, so one is fetched once however many
shows use it and however its URL is spelt (its fragment, `#…`, aside); a file that has changed is seen at a new URL
(`harbour.json?v=2`) or when the page is loaded again. Setting `theme` again to one that
failed fetches it again. (No event says so yet.)

A theme's colours, lengths, type and timing become custom properties on the element, named
after their tokens — `--clack-canvas`, `--clack-text`, `--clack-transition-duration`, and so
on (`compile` in `src/theme.ts` names them all). A page can set them on `clack-show` too, and
its value wins over the theme's. The font families, `fonts.*`, are `--clack-serif`,
`--clack-sans` and `--clack-mono`, for now always the visitor's own. Its choices of layout — `layout.type`, `mat.bevel`,
`caption.card` and `credit`, `header.visible`, `controls.style` and `reveal`, `progress.position`,
`details.position` and `index.style` — are not properties: they choose among Clack's own
styles, inside the element, so a page chooses them with a theme, not with CSS: to hide
credits, say, a theme file that extends the one it uses with `"caption": { "credit": false }`. With a theme that follows the visitor's light or dark setting (`scheme:
"auto"`, as most do), `color-scheme` on the element forces one; a theme that forces a scheme
itself, such as `darkroom`, has only that scheme's colours, so `color-scheme` changes
nothing of it but the browser's own controls. Parts
for `::part()`: `show`, `header`, `stage`, `slide`, `photo`, `below`, `caption`, `controls`,
`button`, `previous`, `next`, `counter`, `missing`. The stage stacks the photos among
themselves, so a `z-index` given to `slide`, `photo` or `missing` counts only within it.
