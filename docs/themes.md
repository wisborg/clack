# Themes

A Clack theme is a JSON file that says how a slideshow looks: its colours in light and dark,
how the photo sits in the frame, how captions and controls are set, how one photo gives way
to the next, and how an album's index looks. The format is **`clack-theme/1`**, defined by
[`schema/theme-1.schema.json`](../schema/theme-1.schema.json); editors that read JSON Schema
complete and check a theme as it is typed if the file starts with `"$schema"`.

*This is a draft (phase 0). It may change until the first release; after that, format 1 only
grows in ways old themes keep working with, and anything else is format 2.*

## A theme is tokens, not CSS

Every value in a theme has a type — a colour, a length, a duration, or one of a fixed set of
words — and Clack checks each one before compiling it into CSS custom properties inside its
shadow root. Nothing in a theme is passed through as CSS. A theme can therefore change how
Clack looks, and nothing else:

- it cannot load anything: `url()` is no token's type, fonts are system fonts (or, later,
  fonts Clack bundles), and `extends` names only built-in themes;
- it cannot reach outside Clack, hide the pause control, or make a control too small to use;
- it cannot inject markup or script, because no value is ever markup.

So a site can let people choose or upload themes without trusting them. Arbitrary CSS, if it
ever comes, will be a separate stylesheet a site's admin adds — trusted content, kept apart.

## The smallest theme

```json
{
  "$schema": "https://raw.githubusercontent.com/wisborg/clack/main/schema/theme-1.schema.json",
  "format": "clack-theme/1",
  "name": "Harbour",
  "extends": "gallery",
  "colors": {
    "light": { "canvas": "#eef0f1" },
    "dark": { "canvas": "#16191b" }
  }
}
```

Only `format` and `name` are required. A theme starts from the one it `extends` — `base` if
it says nothing — and sets what it changes. When themes are combined, objects merge key by
key and any other value replaces the one beneath it. `name`, `description`, `author` and
`extends` belong to one file and are never inherited.

Comments are allowed: `// to the end of the line` and `/* between markers */`, outside
strings. Nothing else beyond JSON is: no trailing commas, no single quotes.
[`schema/examples/theme-annotated.json`](../schema/examples/theme-annotated.json) is a
commented example.

Properties whose names start with `x-` are ignored by Clack and kept for other programs.
Any other property Clack does not know is an error, named in the message, so a misspelt
token is caught rather than silently doing nothing.

## The built-in themes

In [`themes/`](../themes), each extending `base`, which sets every token:

| name | the idea |
|---|---|
| `gallery` | white or charcoal walls, wide margins, a small serif caption beneath |
| `darkroom` | near-black, no chrome until the pointer moves, the photo the only light; dark only |
| `mat` | each photo in a mat board with a fine bevel, framed, with a museum label |
| `minimal` | edge to edge, controls floating over the photo, sans-serif |
| `contact-sheet` | for an album's index: strips of film with frame numbers; Gallery's slideshow |

## The tokens

### `scheme`

`auto` (base's choice) follows the visitor's light or dark setting, and follows it live when
it changes. `light` or `dark` forces one. A theme shown in one scheme — because it forces
it, or extends a theme that does, such as `darkroom` — has only that scheme's colours, and
giving it the other's is an error. A theme that extends `darkroom` and sets `scheme` back
to `auto` gets base's light colours for the scheme Darkroom leaves out.

### `colors`

`colors.light` and `colors.dark` each set colours by role:

| role | what it colours | contrast it must reach |
|---|---|---|
| `canvas` | behind everything: the wall | — (must be opaque) |
| `surface` | panels, such as the details panel | — (must be opaque) |
| `text` | titles and captions | 4.5:1 on canvas and on surface |
| `muted` | credits, counters, labels | 4.5:1 on canvas and on surface |
| `hairline` | rules, the progress track, a hovered control's backdrop | — |
| `accent` | the focus ring, the active state | 3:1 on canvas |
| `control`, `controlActive` | control icons, at rest and hovered | 3:1 on canvas |
| `mat`, `frame` | the mat board and picture frame (`matted`) | — |
| `label`, `labelText`, `labelMuted` | the caption card (`caption.card`) | 4.5:1 for both texts on label |
| `film`, `edgePrint`, `mark` | the contact sheet's film, frame numbers, and pick mark | 4.5:1 for edgePrint on film |

The contrasts are WCAG 2.2's: 4.5:1 for text (1.4.3), 3:1 for controls and focus indicators
(1.4.11). They are checked when a theme loads, in every scheme it is shown in, with
translucent colours composited over the colour beneath them first. A theme that falls short
is refused with the pair, the scheme and the ratio it reached, such as `/colors/light/muted: on
canvas is 3.95:1, needs 4.5:1`. (This check found three such pairs in the first draft of the
built-in themes.)

Colours are written `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b)` or
`rgb(r g b / alpha)`, with alpha from 0 to 1 or as a percentage. Keep the colours behind
photographs neutral: a tinted wall shifts how every photo on it looks.

### Lengths

A length is `0` or a number with a unit: `px`, `rem`, `em` (of the show's text), `cqi`, `cqw`
(of the show's width), or `vw`, `vh`, `vmin`, `vmax` (of the window). No negative lengths,
and no `calc()`. Not `%`, which CSS reads as a share of a different box for each property,
and not `cqh`, `cqb`, `cqmin` or `cqmax`: the show's height is worked out from its width,
so it is not there to be a share of.

Where a token says *fluid*, it can instead grow with the show between two bounds — CSS's
`clamp()`:

```json
"inline": { "min": "16px", "ideal": "5cqi", "max": "72px" }
```

That is how the built-in themes give a phone 16px margins and a large screen 72px, without
a separate set of values for small screens.

### `layout`

| token | values |
|---|---|
| `type` | `gallery` (margins, caption beneath), `stage` (dark surround), `matted` (mat and frame), `full-bleed` (as large as the show, controls over it) |
| `padding.inline`, `.top`, `.bottom` | fluid lengths |
| `shadow` | `none`, or `soft`: a shadow under the photo, tuned for each scheme |
| `mat.width` | fluid length (`matted`) |
| `mat.bevel` | `true` for a fine bevelled edge at the mat's cut |
| `frame.width` | length (`matted`) |

Layouts are Clack's code, not the theme's: a new layout is a change to Clack, a new theme is
not.

### `caption` and `header`

The caption sits beneath the photo (or in the floating controls, in `full-bleed`); the
header is the line above it, with the manifest's title and how many photos it has (shown only when the manifest has a title; a page's `label` is for screen readers, not shown). Both take:

| token | values |
|---|---|
| `font` | `serif`, `sans` or `mono` |
| `size` | 8px to 48px, or 0.5 to 3 in rem or em |
| `weight` | 300, 400, 500, 600 or 700 |
| `style` | `normal` or `italic` |
| `tracking` | letter spacing, -0.05em to 0.3em |
| `case` | `none` or `uppercase` |

and the caption also `card` (set it on a card in the label colours) and `credit` (show the
credit line); the header also `visible`.

### `controls`, `progress`, `transition`, `details`

| token | values |
|---|---|
| `controls.style` | `plain` (icons on the canvas) or `floating` (a translucent bar over the photo) |
| `controls.size` | length; Clack never makes a target smaller than 24px (WCAG 2.5.8) |
| `controls.reveal` | `always`, or `on-activity`: shown when the pointer moves or focus arrives, hidden after a few seconds |
| `progress.position` | `below` the caption, or along the show's bottom `edge` |
| `transition.type` | `crossfade`, `slide` or `none`; with reduced motion, `slide` becomes a short crossfade |
| `transition.duration` | up to 3s, in `ms` or `s` |
| `details.position` | `side`, `below` or `overlay`; on a narrow show, every position becomes a sheet |

The pause control is always present and reachable by keyboard, whatever a theme says
(WCAG 2.2.2).

### `index`

How `<clack-index>`, the index of a show's photos, looks, so one theme styles the index and
the slideshow alike.

| token | values |
|---|---|
| `style` | `justified` (rows of equal height, each photo in its own proportions) or `contact-sheet` (strips of film) |
| `rowHeight` | fluid length (`justified`) |
| `frameWidth` | fluid length: the narrowest a frame may be (`contact-sheet`); as many fit as will |
| `gap` | length |

### `fonts`

`fonts.serif`, `fonts.sans` and `fonts.mono` choose the typeface for each family. For now
the only value is `system`, the visitor's own fonts; bundled, open-licensed fonts will be
added as further values. A theme can never name a font to fetch.

## How a theme is checked

1. The file is at most 64 KB (base, which sets every token, is under 3 KB), and UTF-8.
2. Comments are removed, and the file is parsed as JSON. Its values may nest at most 64
   deep, no number may be too large to hold, and every string must be well-formed Unicode
   — the same limits as a manifest's.
3. It is checked against the schema: every property known, every value of its type.
4. It is merged onto the theme it extends, down to `base`.
5. The result's contrasts are checked in each scheme it is shown in.

Each step is taken only if the one before it passed. Each failure names where it is, for
example `/colors/light/canvas: "red" does not have the expected form`; a contrast is named
at the colour that falls short, in the theme as merged, for example `/colors/light/muted: on
canvas is 3.95:1, needs 4.5:1`. A theme that fails is not used; the show keeps the theme it
had.

The built-in themes and the examples go through the same checks in the tools
(`tools/internal/formats`, `ParseTheme`), and both are held to the same cases
([`test/fixtures/themes.json`](../test/fixtures/themes.json)): the same verdict, and the same
places, for every one.

## What Clack draws of a theme, so far

Every token is checked and compiled, but the show does not yet draw all of them. It does
draw the colours `canvas`, `surface`, `text`, `muted`, `hairline`, `accent`, `control`,
`controlActive`, `mat` and `frame` (not yet the label's three or the film's three), the
scheme, the padding, the four layouts, the shadow, the mat and its bevel, the frame, the
header and its type, the caption's type and whether it shows the credit, the controls'
size, and the transition's duration, or `none`. The caption card, floating controls and
their reveal, the progress line, the `slide` transition (a crossfade until then), the
details panel and the index are still to come; until floating controls are, `full-bleed`
has its caption and controls beneath the photo.

In `matted`, the frame casts its own shadow, and `layout.shadow` is not drawn. The mat and
the frame are measured as of the show, as the schema says — `cqi` in either is of the
show's width — though the photo they surround is fitted to the stage within it. The bevel
is drawn in the mat's last 2px (or all of a narrower one), and the frame in whole device pixels, as a browser draws it. On a show too small for its mat (the built-in themes' mat is
a share of the window, not of the show), the mat and frame are narrowed together, so that
each side takes no more than a sixth of the stage's shorter side, and the photo keeps two
thirds of it.
