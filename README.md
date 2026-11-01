# Clack

A slideshow for photographs that any website can embed, as one custom element (and, for an
index of the photos, a second one, `<clack-index>`):

```html
<clack-show autoplay="6s" theme="gallery">
  <figure><img src="dawn.jpg" width="2560" height="1707" alt="Low tide at dawn"></figure>
  …
</clack-show>
```

Manual and automatic progression, a chosen display size with the full-size photo one click
away, optional metadata (hidden unless asked for), and themes defined in files anyone can
write. No runtime dependencies, nothing fetched from a third party, and it works under a strict
Content-Security-Policy.

Named after the sound a slide projector made between slides.

## Status

Planning. Nothing is built yet. **[docs/plan.md](docs/plan.md) is the design this will be built
to**, with the reasoning behind each decision and the alternatives that were rejected.

## Building

No Node, no npm. Go and git are all that is needed; the tools fetch the rest, checked as
described in [DEPENDENCIES.md](DEPENDENCIES.md).

```
make build      # dist/clack.js and dist/clack.min.js
make test       # the tests, in Safari, Chrome and Firefox
make gates      # everything a change must pass
```

Safari's driver needs "Allow remote automation" turned on once, in Safari ▸ Settings ▸
Developer.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
