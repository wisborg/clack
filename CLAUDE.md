# Clack

A photo slideshow any website can embed, as a custom element, `<clack-show>`, with an index
of its photos, `<clack-index>`. TypeScript, bundled into one ES module with **no runtime dependencies**. **`docs/plan.md` is the design
this is being built to** — read it before planning or implementing anything in `src/`.
Shoebox (`../shoebox`) is its first user, and its `docs/plan.md` holds what the two share:
the dependency policy and the review process.

## Building and testing

There is no Node and no npm here, deliberately. Everything goes through one Go program:

```
go run ./tools/dev build                 # dist/clack.js, dist/clack.min.js, size budget
go run ./tools/dev typecheck             # TypeScript 7 (tsgo), built from source at a pinned commit
go run ./tools/dev test                  # the tests in Safari, Chrome and Firefox
go run ./tools/dev test -browsers=chrome,firefox
go run ./tools/dev gates                 # everything a branch must pass
```

Every command ends with one `dev <command>: ok|FAILED (exit N)` line and exits with that
status, so **never append your own `echo "$?"`**. The `Makefile` is a front door that only
delegates; do not add a target that does the work itself.

- The Go toolchain is pinned by `toolchain` in `go.mod`; `go` fetches it. Do not lower it to
  silence govulncheck — raise it.
- `tsgo`, chromedriver and geckodriver are fetched into the user cache on first use; how each
  is checked is in `DEPENDENCIES.md`. Safari needs "Allow remote automation" turned on once
  (Safari ▸ Settings ▸ Developer).
- Tests are TypeScript in `test/`, run by our own harness (`test/harness.ts`) on a page
  served with a **strict Content-Security-Policy** (`tools/internal/browsertest`). A
  violation a test does not claim with `expectViolation` fails the run. Never weaken the
  policy to make a test pass: the policy is what is being tested.
- A test that cannot run in an engine calls `skip(reason)`; it is reported, not hidden.
- Session output goes in the gitignored `.scratch/`.

## Rules for `src/`

- No runtime dependencies. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`,
  `new Function`, inline styles via `<style>` or `style=""` attributes: DOM is built with
  `createElement`/`textContent`, styles are constructable stylesheets adopted by the shadow
  root. The strict-policy test page enforces this.
- Clack never reads metadata from image files, never requests anything but the images and
  manifest it is given, and never shows metadata unless the page asked for it.
- CSS imported from TypeScript arrives as text (esbuild's text loader).

## Theme and manifest formats

`schema/` holds the published JSON Schemas, `themes/` the built-in themes, and
`docs/themes.md` and `docs/manifest.md` describe both formats; change them together.
`tools/internal/formats` checks every built-in theme and example against the schemas and
for contrast, and `tools/internal/jsonschema` is our validator for exactly the subset of JSON
Schema the schemas use — it refuses any other keyword, so a schema needing one means adding
it there, with a test. Patterns must be valid both in Go (RE2) and in JavaScript.

## Dependencies

Every build or test dependency is in `DEPENDENCIES.md` with its reason and how it is
checked, and its licence in `NOTICE` if anything of it is distributed. Adding one is a
decision to raise with the user first, not a convenience.

## Git

Create a topic branch before the first edit; do not move `main` without the user's go-ahead;
do not push. `main` takes fast-forward merges only. Commit messages explain *why*: an
imperative subject, then paragraphs on what was wrong, what was considered and rejected, and
what a reader might otherwise mistakenly "fix".
