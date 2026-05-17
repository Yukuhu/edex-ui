# Working rules for nDEX-UI

This file is read on every session start. The rules below are not
optional — they describe how change lands in this repository.

## Project at a glance

- **nDEX-UI** is a maintained fork of the archived
  [eDEX-UI](https://github.com/GitSquared/edex-ui), versioned
  `3.0.0-SNAPSHOT` on the `master` branch. See [CHANGELOG.md](CHANGELOG.md)
  for what has accumulated on the unreleased line.
- **Run locally:** `npm run start` from the repo root (Electron 42,
  Node 22 on PATH).
- **Default branch:** `master`.
- **GitHub repo:** `Yukuhu/edex-ui`.

## Rules

### 1. Every change must be tracked in a GitHub issue

GitHub Issues are enabled on the repo. Before touching code:

- **Search existing issues** to make sure the work isn't already filed
  (`gh issue list --repo Yukuhu/edex-ui --search "..."`).
- **Open an issue** describing the problem or proposal if none exists
  (`gh issue create --repo Yukuhu/edex-ui ...`). Capture the *why*
  (user-facing symptom, motivation) and the *what* (intended outcome),
  not just the *how*.
- **Reference the issue number** in branch names (`feat/<n>-...` /
  `bug/<n>-...`), commit messages, and PR descriptions. Use GitHub's
  closing keywords (`Closes #<n>`) in the PR body so the issue is
  retired automatically on merge.

The only exceptions are trivial fixes (typos, broken links, removed
unused code) where the diff itself is its own explanation. Even then,
prefer to open a one-line issue if there is any chance someone might
ask "why was this changed?" later.

### 2. Every change ships through a feature/bug branch and a Pull Request

No direct commits to `master`. The workflow:

```
git checkout master
git pull --ff-only
git checkout -b <type>/<n>-<short-slug>
# … work …
git commit -m "<type>: <imperative summary>

Closes #<n>"
git push -u origin <type>/<n>-<short-slug>
gh pr create --repo Yukuhu/edex-ui --base master --head <type>/<n>-<short-slug> \
  --title "<short title>" --body "$(cat <<'EOF'
## Summary
…

Closes #<n>

## Test plan
- [ ] …
EOF
)"
```

- **Branch types:** `feat/` for new features, `bug/` for fixes,
  `chore/` for tooling / non-code, `docs/` for documentation,
  `security/` for security-only changes.
- **One PR, one focused change.** If you find yourself describing the
  PR with "and" or "also", split it.
- **Update CHANGELOG.md** in the same PR for any user-facing change.
- After merge, **delete the branch** locally and on origin:
  `git checkout master && git pull && git branch -d <branch> && git push origin --delete <branch>`.

## Tests

- The unit-test suite lives under `tests/` and runs on Node's built-in
  `node:test` (no JS testing dependencies beyond `jsdom` for DOM tests).
- `npm test` runs the suite (`spec` reporter on stdout).
- `npm run test:coverage` additionally emits `coverage/lcov.info`,
  which SonarCloud reads via `sonar.javascript.lcov.reportPaths` in
  `sonar-project.properties`.
- `npm run test:audit` preserves the legacy `snyk` security scan that
  used to live under `npm test`.
- The GitHub Actions `Tests` workflow (`.github/workflows/tests.yml`)
  runs `npm ci && npm test` on every PR + master push. The
  `SonarCloud` workflow additionally runs `test:coverage` so the
  Quality Gate's `new_coverage` condition gates each PR.
- See `tests/README.md` for layout, the `global.window` shim
  rationale, and the tier-1 (pure helpers) vs tier-2 (DOM-touching
  via jsdom) split.

## Commit and PR conventions

- Commit messages use a `<type>: <imperative summary>` first line
  followed by a blank line and a body explaining the *why*. Reference
  the issue with `Closes #<n>` in the body.
- PR titles are short (under ~70 chars). PR bodies always include a
  **Summary**, the `Closes #<n>` link, and a **Test plan** checklist.
- Co-author trailer: when changes are produced via Claude Code, keep
  the existing project convention of including
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
  in the commit trailer.

## Things to remember

- **Settings live in two places:** the bootstrap defaults in
  `src/_boot.js` (written to `settings.json` on first launch only) and
  the in-app editor + persistence in `src/_renderer.js`. Adding a new
  setting means touching both — and the renderer's `writeSettingsFile`
  serializer — or it won't survive a save.
- **Shortcuts also live in two places:** the default `shortcuts.json`
  template in `src/_boot.js` and the `useAppShortcut` switch +
  `shortcutsDefinition` table in `src/_renderer.js`.
- **Modal Esc closes the topmost modal globally**
  (`src/classes/modal.class.js`); the auto-Close button on
  `type: "custom"` modals is gated by `window.settings.modalCloseButton`.
  Don't add per-modal `Escape` handlers — they'll fight the global one.
- **The on-screen keyboard tracks Ctrl / Shift state via dataset flags**
  (`window.keyboard.container.dataset.isCtrlOn`,  `.isShiftOn`).
  Click-driven UI that needs to react to modifiers should consult both
  the real event modifiers (`event.ctrlKey` / `.shiftKey`) and these
  dataset flags so on-screen-keyboard users aren't left out.
- **Don't reintroduce `window.fsDisp`.** The inline filesystem panel
  has been retired; the source of truth for the user's working
  directory is `window.term[window.currentTerm].cwd` (which may carry
  the `FALLBACK |-- ` prefix when tracking failed). Strip that prefix
  before using it as a path.
- **Electron 42 ships Node 22+ internally** — `fs.promises.cp`
  (recursive, with `dereference: false`), `fs.promises.rm`, and other
  modern fs APIs are fine to use.
