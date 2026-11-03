# Manifests

A manifest is a JSON file listing the slides of one show: which photos, in what order, at what
sizes, and whatever is known about each that the page wants shown. The format is
**`clack-manifest/1`**, defined by
[`schema/manifest-1.schema.json`](../schema/manifest-1.schema.json). Clack fetches it from
`<clack-show src="…">`, or is given the same structure from JavaScript.

*This is a draft (phase 0). It may change until the first release; after that, format 1 only
grows in ways old manifests keep working with, and anything else is format 2.*

## Content, not presentation

A manifest says what the photos are. How the show behaves — auto-play and its interval,
whether metadata is shown, the theme, the size — is the page's choice, made on the element.
The same manifest can feed a small embedded show and a full-window one.

Clack shows what the manifest holds, and **reads nothing from the image files**. What a
visitor can learn about a photo is exactly what the host put in the manifest it served them,
which is how Shoebox decides who sees where and when a photo was taken: it builds each
visitor's manifest from what they are allowed to see.

## The smallest manifest

```json
{
  "format": "clack-manifest/1",
  "slides": [
    {
      "id": "1",
      "alt": "Low tide under a grey sky",
      "width": 3840,
      "height": 2560,
      "sources": [{ "url": "low-tide-1280.jpg", "width": 1280 }]
    }
  ]
}
```

[`schema/examples/manifest.json`](../schema/examples/manifest.json) uses every field.

## The show

| property | |
|---|---|
| `format` | `"clack-manifest/1"`, required. A format Clack does not know is refused, never guessed at. |
| `title` | the show's title, for the header |
| `description` | plain text; line breaks are kept |
| `lang` | the language of the manifest's text, such as `en-AU`, so screen readers pronounce it right |
| `slides` | the slides, in order; at most 20,000 |

## A slide

| property | |
|---|---|
| `id` | required: letters, digits, `-` and `_`, unique in the manifest and stable, so a link to a slide keeps working |
| `type` | `image`, the default and, for now, the only one; video will be added beside it |
| `alt` | required: what the photo shows, for anyone who cannot see it. `""` marks a photo that adds nothing the caption does not already say. |
| `width`, `height` | required: the photo's size in pixels as it is shown (after rotation), so its space is kept before it loads and the page never jumps |
| `sources` | required: the photo at one to sixteen sizes, each `{ url, width, height?, type? }`. The browser fetches the one that fits the screen and its pixel density. Give `type` (`image/avif`, `image/webp`, `image/jpeg`, `image/png`, `image/jxl`) when offering more than one format; a browser skips types it cannot show. |
| `full` | the full-size file, `{ url, width, height?, type? }`, fetched only when the full-size view opens. Without it, that view uses the largest source. |
| `page` | the photo's own page, if it has one |
| `placeholder` | `{ thumbhash, color }`: a ThumbHash (base64, about 25 bytes) painted as a blurred impression of the photo while it loads, and its average colour for the moment before that |
| `focus` | `{ x, y }` from 0 to 1: the point kept in view when the photo is cropped to fill a frame |
| `duration` | seconds this slide stays during auto-play, in place of the show's interval |
| `description`, `camera`, `time`, `location`, `technical` | metadata, by class (below) |
| `extra` | further facts for the details panel, as `[{ label, value }]`, in order |

Text is always plain text: Clack sets it with `textContent`, so a caption can never become
markup, whatever it contains.

### URLs

Every URL is `http://` or `https://` (the scheme in any letter case), or relative — resolved against the manifest's own URL,
or the page's when the slides come from JavaScript. Every other scheme is refused: no
`data:`, `blob:` or `javascript:`. A URL is printable ASCII: anything else, a space or a
letter like `ø` included, is percent-encoded (`%C3%B8`), which every server and every
browser read the same way. A host is a domain name of ASCII labels, the last beginning
with a letter (`photos.example.com`), or an IPv4 address (`192.0.2.7`), with a port up to
65535 if any (a host may end in a dot, as a fully qualified name does); and a relative URL
does not begin with a backslash where a browser would read it as a slash. These are the forms every URL parser reads alike, so a URL the schema accepts
always resolves, in the tools as in the browser. Not allowed: bracketed IPv6 hosts, user
names in URLs, and internationalised domain names — see
[Not supported, and why](#not-supported-and-why). The schema says so, and Clack checks each
resolved URL again before using it. Clack requests these URLs and nothing else.

## Metadata, by class

Metadata comes in the same classes Shoebox grants access by, so a host includes or leaves out
whole classes. Each is optional, and so is everything in it. Clack formats numbers and dates
for the visitor's locale.

A slide's `title` and `credit` are its caption: Clack shows them beneath the photo by
default, as a `<figcaption>` is shown in markup. Everything else here is shown only when the
page asks for it (with the `metadata` attribute, to come). A host that would not have even
the title and credit shown leaves them out of the manifest, or turns the caption off.

| class | properties |
|---|---|
| `description` | `title` and `credit`, shown as the slide's caption by default; `caption` (a longer text) and `keywords`, shown only if the page asks |
| `camera` | `make`, `model`, `lens`, `focalLength` and `focalLength35` (mm), `aperture` (the f-number: `2.8` is ƒ/2.8), `exposure` (seconds: `0.004` is 1/250 s), `exposureBias` (stops), `iso`, `flash` |
| `time` | `taken`: local time where the photo was taken, as precisely as it is known (below) |
| `location` | `latitude`, `longitude`, `altitude` (m), `direction` (degrees from true north), `precision` (`exact` or `approximate`), `place` (`name`, `locality`, `region`, `country`) |
| `technical` | `width` and `height` of the original, `colorProfile`, `fileSize` (bytes), `format` |

`time.taken` is written `1999`, `1999-07`, `1999-07-14`, `1999-07-14T18:05`, with seconds
and an offset from UTC (`+10:00`, `Z`) when they are known. It is shown as the local time it
was where the photo was taken, not converted to the visitor's time zone: a sunset photo says
evening wherever it is seen. A scanned print from 1999 may only know its year, and says so.

`location` is the most sensitive class. `precision: "approximate"` says the coordinates were
rounded on purpose, and Clack shows them as such. A latitude needs a longitude, and the other
way round.

## Extensions

Properties whose names start with `x-`, on the manifest or on a slide, are ignored by Clack
and kept for other programs. Any other property Clack does not know is an error, named in the
message — in particular, metadata outside the five classes is refused rather than shown or
dropped silently.

## Fetching

Clack fetches a manifest with the page's cookies only if it is on the page's own origin, and
accepts it only if:

- the response is a success (2xx), served as `application/json` (or another `+json` type);
- it is at most 32 MB — room for the 20,000 slides a manifest may hold, at about 1.6 KB each
  with their sources and all their metadata — refused as soon as it is known to be larger,
  whether the server said so or not (the tools refuse it too);
- it is UTF-8, strictly (no byte-order mark, no bytes that are not UTF-8), and JSON — plain
  JSON: unlike a theme, a manifest is written by programs, so it has no comments;
- its values nest at most 64 deep, no number is too large to hold, and every string, names
  included, is well-formed Unicode (no `\ud800` standing alone, which some decoders turn
  into U+FFFD and so merge names that differ);
- it is a valid `clack-manifest/1`, with nothing it does not know (but `x-` properties).

Relative URLs in it are resolved against the URL it was finally fetched from, after any
redirects. A manifest is refused whole, never shown in part: one bad slide is a bad
manifest.

## Not supported, and why

### Internationalised domain names

A manifest's URLs cannot name a host by an internationalised domain name — one with letters
beyond ASCII, such as `bücher.example`, which is written `xn--bcher-kva.example` in a URL.
No label of a host may begin `xn--`. A photo host with such a name is given by an ASCII
name for the same server instead. *(Decided 2026-11-02, with the user.)*

**Why.** Clack's rule is that the tools (Go) and the browser reach the same verdict on every
manifest: a manifest that passes the tools is never refused by Clack on a visitor's screen.
Whether an `xn--` label is valid is decided by the browser's URL parser, through the IDNA
rules of Unicode's UTS #46: the label must decode as Punycode, and what it decodes to must
pass a set of mapping, normalisation and script checks. `xn--a` is refused; `xn--bcher-kva`
is accepted. None of that can be expressed in the schema's pattern, which is a regular
expression; and Go's standard library has no implementation of it to check with. Allowing
such hosts would therefore let manifests through the tools that browsers then refuse, so the
schema refuses them all.

**What allowing them would take,** if it is needed:

1. A UTS #46 implementation on the tools' side, to check each `xn--` host as browsers do:
   `golang.org/x/net/idna` (the Go team's, but a new dependency, to be decided as such —
   `DEPENDENCIES.md`), or one of our own (Punycode is short; UTS #46's mapping and validity
   tables are not).
2. The pattern loosened to let `xn--` labels through, with the check in the tools and in
   Clack's loader (the browser's `new URL()` already does it) as a rule beyond the schema,
   like unique slide ids.
3. Shared cases for valid and invalid IDN hosts in `test/fixtures/manifests.json`, which both
   sides must judge alike — the cases now refused (`xn--a`, `xn--bcher-kva`) move to the
   accepted or refused lists by what UTS #46 says.

Bracketed IPv6 hosts and user names in URLs are left out for the same reason, with less
cost: the browser and Go parse them differently, and photo hosts have no need of them.

## Checks beyond the schema

The schema cannot say everything; Clack also refuses a manifest whose slide ids repeat, and
one with two sources of one slide at the same width and type. The tools check the examples
the same way (`tools/internal/formats`).
