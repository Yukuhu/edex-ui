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

```
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
