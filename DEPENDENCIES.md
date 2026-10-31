# Dependencies

What Clack ships — `dist/clack.js` and `dist/clack.min.js` — contains no third-party code at
all. Everything below is used to build and test it, on a developer's machine or in CI, and
never reaches a website.

Each entry says what it is for, why it is not ours, who maintains it, its licence, and how
the copy we run is checked. A change to any of them — a new entry, a version, a pin — is
reviewed as code (see the review process in Shoebox's `docs/plan.md`).

## Go modules (`go.mod`)

| module | for | why not ours | maintained by | licence |
|---|---|---|---|---|
| Go toolchain, pinned by `toolchain` in `go.mod` | building and running the tools | — | the Go team | BSD-3-Clause |
| `github.com/evanw/esbuild` | bundling and minifying the TypeScript | a bundler and minifier is a large, subtle program; esbuild is among the most used, and is itself written in Go | Evan Wallace | MIT |
| `golang.org/x/vuln` (govulncheck), as a `tool` | the vulnerability gate | — | the Go team | BSD-3-Clause |

esbuild depends only on `golang.org/x/sys`. govulncheck brings `golang.org/x/mod`,
`x/sync`, `x/sys`, `x/telemetry` and `x/tools`, all from the Go team. `x/telemetry` records
nothing unless the user has turned Go telemetry on (`go telemetry on`); it is off by default.

All are checked by the Go checksum database through `go.sum`.

## Programs fetched by the tools

These are fetched into the user's cache directory (`~/Library/Caches/clack/` on macOS) the
first time they are needed.

| program | for | from | how the copy is checked |
|---|---|---|---|
| TypeScript 7.0.2 (`tsgo`) | type checking | built from source: `microsoft/TypeScript`, `tsc/`, commit `1e4744d6…` (tag v7.0.2) | fetched by commit hash and the hash verified after checkout; its own dependencies verified by its `go.sum`; built with `-trimpath`, and two builds are byte-identical. Apache-2.0, Microsoft. |
| geckodriver 0.37.1 | driving Firefox | Mozilla's GitHub release | SHA-256 pinned per platform in `tools/internal/drivers`. MPL-2.0, Mozilla. |
| chromedriver | driving Chrome | Google's Chrome for Testing, matched to the installed Chrome's build | **HTTPS from Google's storage only.** It cannot be pinned (it must follow Chrome's own updates), Google publishes no checksums, and it is not signed with Google's developer certificate. The tools require the index to point at Google's storage and the binary to report the version the index named. This is the weakest check in the toolchain. BSD-3-Clause, Google. |

## Programs used from the system

| program | for |
|---|---|
| `git` | fetching the TypeScript source |
| `safaridriver` | driving Safari; ships with macOS |
| Safari, Chrome, Firefox | the browsers the tests run in |
