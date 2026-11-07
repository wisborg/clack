# Design

Static mock-ups for settling Clack's look before the component exists: the five built-in
themes (docs/plan.md, "Themes"), each in light and dark, as a slideshow and with the details
panel open, plus the contact sheet for an album's index.

```
go run ./tools/dev serve                       # http://127.0.0.1:8737/mockups/
go run ./tools/dev serve -addr 0.0.0.0:8737    # also reachable from a phone on the same network
go run ./tools/dev shots                       # every page, light and dark, desktop and phone -> .scratch/shots/
```

`demo/` holds pages made with the real component, built fresh by `serve` and `shots`
(`go run ./tools/dev shots -set demo`), to compare with the mock-ups at the same sizes:
`slideshow` from markup, and a page for each theme (`gallery`, `darkroom`, `mat`,
`minimal`) from one manifest of the photographs, `coastlines.json`, which the tools check as
they check the examples.

`?scheme=light` or `?scheme=dark` forces a scheme; otherwise the page follows the system.
Darkroom is dark by nature and ignores it.

The pages are served under the same strict Content-Security-Policy as the tests, so nothing
here relies on inline style or script that Clack itself could not use. `mockups.css` holds
each theme as the values its theme file will carry, written as CSS custom properties, so the
mock-ups double as the first draft of how theme tokens map onto CSS. The theme files
themselves are in `themes/`. When the contrast check was written, three of the approved
colours fell just short of WCAG AA and were darkened slightly, here and there: Mat's
secondary text on its wall, the museum label's credit line, and the contact sheet's
secondary text.

## The photographs

Public domain (CC0), from Wikimedia Commons, listed with author and source in
`photos.json`. They are not committed: the tools fetch each into the user cache and refuse any
whose SHA-256 differs from the one recorded. The captions are ours. The details shown in the
panel are invented, to show the layout.
