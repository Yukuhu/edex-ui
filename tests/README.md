# nDEX-UI test suite

Unit tests for `src/`, using Node's built-in test runner (`node:test`,
Node 22+). Zero JS testing dependencies — the framework ships with the
runtime Electron 42 already provides.

## Running

```bash
npm test               # run the suite
npm run test:coverage  # run the suite and emit line / branch / function coverage
```

The previously-named `npm test` (which ran `snyk` security scan) was
renamed to `npm run test:audit`.

## Layout

```text
tests/
├── README.md             — you are here
├── unit/                 — pure-logic / data-driven tests, no DOM
├── helpers/              — shared mocks + fixtures (Phase 3+: jsdom, electron
│                           remote stubs, Terminal stubs, etc.)
└── dom/                  — DOM-touching tests (Phase 3+)
```

Tests files are named `<area>-<unit>.test.js` and live under the
directory that matches the kind of stubbing they need. The runner
discovers `**/*.test.js` automatically.

## Why the global `window` shim?

Some classes (`claudeChat`, etc.) assign themselves to `window.X` at
module load. We provide a minimal `global.window = {}` before
`require()`-ing them so the load doesn't throw. Constructor code that
actually depends on `electron`, `document`, `Modal`, `AIAvatar`, etc.
is only reached when tests explicitly construct an instance — static
methods load cleanly.

## Rule of thumb: `innerHTML` vs `textContent`

When you need to put a value into an element, pick by **what the value
is**, not by what's convenient:

- **Plain text** (a number, a status word, a username, a file size,
  any string with no intentional markup) → **`textContent`**. The
  HTML parser is bypassed entirely, so a `<` in the value can never
  be parsed as a tag — even if escaping is forgotten.

- **Structured markup with interpolated user data** → **`innerHTML`**
  is fine *if* every interpolated value goes through
  `window._escapeHtml(...)` (or `_purifyCSS` for `<style>` contexts).
  Static template literals with no interpolation are safe as is.

- **Building lots of nodes** → prefer creating elements with
  `document.createElement` and appending, rather than templating a
  long HTML string. The result is easier to reason about, and there's
  no temptation to skip the escape on one branch.

Things that look safe but aren't:

- **Attribute-quoted values** (`<input value="${x}">`) still need
  escaping — a `"` in `x` breaks out of the attribute. `_escapeHtml`
  covers this.

- **OS-supplied strings** (process names, drive labels, file names,
  usernames) are user-controllable. Linux filenames can contain `<`
  and `>`; Windows volume labels can contain whatever the user typed
  when they formatted the disk.

- **Network responses** (`myexternalip.com`, GeoIP API, GitHub
  Releases API) — escape on read, even when the endpoint is trusted,
  so a future endpoint swap or compromise doesn't become an XSS.

The audit that landed with #171 walks the codebase end-to-end; the
escape-helper tests in `tests/unit/escapeHelpers.test.js` (#170) pin
the contract for both helpers.

## Categories (and what's deferred)

- **Tier 1 — pure logic / data tables.** Highest-value unit-test
  targets: lookup tables, dispatch maps, normalisers, predicates.
  Phase 2 focuses here.
- **Tier 2 — DOM-touching methods.** Need a `jsdom` setup + shared
  electron/Terminal mocks. Phase 3.
- **Tier 3 — heavy I/O, native bindings, web workers.** `terminal`
  (node-pty), `netstat`, `sysinfo`, `updateChecker`, `fuzzyFinder`,
  `src/workers/*`. Skipped for unit tests; covered by manual /
  integration testing.
- **Tier 4 — E2E.** Optional Playwright smoke test, phased separately.
