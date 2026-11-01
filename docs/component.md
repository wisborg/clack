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

- `alt` is the photo's description. Without it Clack warns in the console; `alt=""` says the
  caption already describes it.
- `width` and `height` are required: they keep the photo's space before it loads, so the
  page never jumps. Without them Clack warns and assumes 3:2.
- `srcset` (with `w` descriptors) offers the photo at several sizes. Clack works out the
  `sizes` itself, from the size each photo is drawn at.
- The `<figcaption>` is the title; a `<small>` inside it is the credit.
- The figure's `id` is the slide's id, used by `goTo` and in events.
- `data-full` names the full-size file (for the full-size view, still to come), and
  `data-color` a colour (`#rrggbb`) for the moment before the photo arrives.

**Give the images `loading="lazy"`.** Without script the markup is a plain list of photos —
what a reader without script, or a search engine, sees. With script, Clack draws its own
copies of the photos and the markup is not displayed, but a browser fetches every image in
the page that is not lazy, displayed or not.

Clack follows changes to the markup as they happen, keeping its place by slide id.

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

The shape is a manifest's slide (see [`manifest.md`](manifest.md)). Sources are grouped by
type into a `<picture>`; the untyped ones make the `<img>`. A slide that cannot be shown
throws a `TypeError` that names it and says why — a URL that is not http, https or relative,
a missing size, a repeated id — and the show keeps the slides it had. While slides come from
script the markup is not read; `show.slides = null` goes back to it.

## Attributes

| attribute | |
|---|---|
| `label` | what the show is called, for screen readers (default "Photos") |
| `loop` | the next of the last slide is the first, and the other way round |
| `fit` | `contain` (default): the whole photo, as large as fits. `cover`: the frame filled, cropped |

The element is 3:2 unless the page gives it a height.

## Properties, methods and events

| | |
|---|---|
| `index` | the slide asked for — it may still be loading |
| `count` | how many slides |
| `loop` | the `loop` attribute, as a boolean |
| `slides` | the slides, as Clack reads them; set to give them from script |
| `next()`, `previous()` | move one slide; the promise says whether it was shown (`false` if another was asked for first) |
| `goTo(index or id)` | go to a slide; rejects with a `RangeError` if there is none |
| `slidechange` event | a slide is on screen: `detail` is `{ index, id, previous }` |

## What it does for the visitor

- **Controls:** previous and next, and a counter. At the ends of a show that does not loop
  they are marked unavailable (`aria-disabled`), not disabled, so keyboard focus stays.
- **Keys** (with focus in the show): ← and → move the way the text runs (so the other way
  round in a right-to-left page), Home and End go to the first and last.
- **Swipe and drag**, with touch, pen or mouse: a long drag or a quick flick moves on; a
  short one springs back; up-and-down is left to the page, to scroll. At the ends the photo
  resists.
- **Never a half-loaded photo.** The next photo is fetched at the size it is drawn and
  decoded before it is shown; until then the current one stays, the counter already says
  where the visitor is going, and if it takes more than a moment a hairline sweeps the foot
  of the frame. A newer request always wins over an older, slower one.
- **Loading ahead:** once a photo is on screen, the next, the previous, and the one after
  next are fetched. Photos no longer near are let go of (Firefox then stops their download;
  Chrome and Safari finish it into their cache).
- **Crossfade** between photos, shortened when the visitor asks for reduced motion.
- **A photo that cannot be loaded** keeps its place, with its description and a note
  saying so; the show goes on.
- **Screen readers** hear the show as a carousel of slides ("3 of 24"), and the visitor's
  own moves are announced politely ("Photo 3 of 24: Low tide"); moves made by the page's
  script are not.

## Styling

Every themable value is a custom property on the element, named after its theme token —
`--clack-canvas`, `--clack-text`, `--clack-transition-duration`, and so on (`src/clack.css`
lists them, with base's values). A page can set them on `clack-show`; theme files will
compile to the same properties. `color-scheme` on the element forces light or dark. Parts
for `::part()`: `show`, `stage`, `slide`, `photo`, `below`, `caption`, `controls`,
`button`, `previous`, `next`, `counter`, `missing`.
