# Renderer globals

Every `window.X` symbol the nDEX-UI renderer relies on, by category.
Filed against [issue #178](https://github.com/Yukuhu/edex-ui/issues/178)
to settle the recurring "what's safe to read here?" question and to
keep [ESLint's `RENDERER_SHARED` map](../eslint.config.js) honest as
the renderer evolves.

## Why so many globals?

The renderer is an Electron classic-script page. Every file under
`src/classes/` is loaded via a separate `<script>` tag in `ui.html`,
and class declarations at the top level of those scripts become
**bindings in the shared global script scope** — visible as bare
identifiers (`Modal`, `Terminal`, …) to every later `<script>`, *not*
properties on `window` unless explicitly assigned. The renderer's
`_renderer.js` is loaded last and follows the same rule for its
top-level `const`s.

Genuine `window.X = …` assignments exist for symbols that need to be:

1. **Reached by event-handler attributes** like `onclick="window.foo()"`
   — Modal action buttons (`Modal._stack`, `fsModalConfirmYes`,
   `useAppShortcut`, the WebApp manager buttons).
2. **Shared mutable state** that classes need to update from anywhere
   (`window.term`, `window.settings`, `window.theme`).
3. **Hand-off points between modules** when the assigning class file
   and the reader live in different `<script>` tag scopes (the
   `window.AIAvatar = AIAvatar`-style end-of-file assignments).
4. **Browser hooks** (`window.onerror`, `window.onmouseup`,
   `window.onresize`).

The rest of this document is the inventory.

## Vendored / browser-built-in

These come from outside the project. Don't reassign.

| Symbol | Source | Notes |
| --- | --- | --- |
| `window.pdfjsLib` | `node_modules/pdfjs-dist`, set in `ui.html:43` | PDF rendering library used by `docReader.class.js`. ESM bridge sets it on `window` so classic-script callers can reach it. |
| `window.ENCOM`, `window.Vec2` | `src/assets/vendor/encom-globe.js` | Three.js-based globe vendor. Read by `locationGlobe.class.js`. |
| `window.Howl`, `window.Howler`, `window.HowlerGlobal`, `window.Sound` | `node_modules/howler` UMD | Audio playback. |
| `window.chrome` | Stubbed in `src/classes/webApp-preload.js:71` | Compatibility shim for sites that probe Chromium extension APIs. |
| `window.eval` | `src/_renderer.js:6` | Replaced with a thrower for security hardening (#170). The only intentional `no-global-assign` site in the codebase. |

## Service-class identifiers attached at module end

`<script>`-tag class declarations are visible to later scripts as bare
identifiers, but a handful also attach themselves to `window` so they
remain reachable when `require()`d from another classic script or
from a unit test that stubs `global.window`.

| Symbol | Owner | Used by |
| --- | --- | --- |
| `window.AIAvatar` | `src/classes/aiAvatar.class.js:328` | renderer test stubs |
| `window.ClaudeChat` | `src/classes/claudeChat.class.js:1249` | `Shortcuts.useAppShortcut`, modal "buttons" `action` strings |
| `window.FilesystemDisplay` | `src/classes/filesystem.class.js:763` | `fsModal.class.js` |
| `window.FsModal` | `src/classes/fsModal.class.js:260` | `Shortcuts.useAppShortcut`, the focus listener |
| `window.TtsEngine` | `src/classes/ttsEngine.class.js:600` | `Modal._ttsSource` wiring, `_renderer.js` boot |
| `window.Shortcuts` | `src/classes/shortcuts.class.js` | `_renderer.js`'s one-shot `Shortcuts.init()` call |

## Renderer state (per-launch singletons)

These hold mutable state for the running session. They're initialised
during boot, mutated as the user interacts.

| Symbol | Owner | Lifecycle |
| --- | --- | --- |
| `window.settings` | `_renderer.js:101` reads `settings.json`; `window.writeSettingsFile` rewrites it on Save | persistent; reloaded on Reload UI |
| `window.shortcuts` | `_renderer.js:102` reads `shortcuts.json` | persistent |
| `window.webapps` | `_renderer.js:103` reads `webapps.json`; `_renderer.js:1199` mutates on remove | persistent |
| `window.lastWindowState` | `_renderer.js:104` reads `lastWindowState.json`; `window.toggleFullScreen` rewrites on F11 | persistent |
| `window.theme` | `_renderer.js:186` via `_loadTheme` | per-page; rebuilt on theme swap |
| `window.audioManager` | `_renderer.js:279` | `new AudioManager()` once; never replaced |
| `window.ttsEngine` | `_renderer.js:285` | `new TtsEngine()` once; never replaced |
| `window.gemmaEngine` | `_renderer.js:294` | `new GemmaEngine()` once; never replaced |
| `window.keyboard` | `_renderer.js:468` (initial), `:627` (on `remakeKeyboard`) | replaced on layout change |
| `window.term` | `_renderer.js:572` | `{ 0: Terminal, 1: Terminal, … }` keyed by tab index |
| `window.currentTerm` | `_renderer.js:579` initial, `:638` on tab focus | integer, active tab index |
| `window.mods` | `_renderer.js:516` | `{ clock, sysinfo, cpuinfo, … }` — sidebar widget instances |
| `window.modals` | `src/classes/modal.class.js:1` | `{ [id]: Modal }` registry; mutated by `new Modal()` and `Modal.close()` |
| `window.updateCheck` | `_renderer.js:615` | `new UpdateChecker()` once |
| `window.si` | `_renderer.js:256` | `systeminformation` Proxy that delegates to the worker pool |

## Renderer state (transient, per-modal)

These point at the *currently open* instance of a singleton modal.
They're `undefined` when the modal isn't open.

| Symbol | Owner | Cleared when |
| --- | --- | --- |
| `window.activeControlMenu` | set in `_renderer.js:1053` | `ControlMenu.close()` (close handler clears it) |
| `window.activeFuzzyFinder` | set in `src/classes/shortcuts.class.js:205` | FuzzyFinder close |
| `window.activeWebApp` | set in `src/classes/webApp.class.js:23` | WebApp close |

## Helpers (set once, function-valued)

Pure functions wired onto `window` at boot. The `_`-prefixed names
were inherited from the upstream eDEX-UI codebase; the convention is
"renderer-private helper, not part of any public API".

| Symbol | Owner | Purpose |
| --- | --- | --- |
| `window._escapeHtml` | `_renderer.js:63` (re-exports `src/utils/escapeHelpers.js`) | OWASP five-char HTML escape (#170) |
| `window._purifyCSS` | `_renderer.js:64` | `<style>`-tag breakout guard (#170) |
| `window._encodePathURI` | `_renderer.js:65` | `encodeURI` + `#` → `%23` for file:// URLs |
| `window._delay` | `_renderer.js:68` | `setTimeout` wrapped as a `Promise` |
| `window._loadTheme` | `_renderer.js:139` | Theme load + CSS-vars inject |
| `window._hotSwitchTheme` | `_renderer.js:193` | Live theme swap from Control Menu |
| `window._hotSwitchKeyboard` | `_renderer.js:201` | Keyboard-layout swap (asks user to reload) |
| `window._renderWebAppManageRows` | `_renderer.js:1154` | Build the rows for the WebApp manager modal |

## Page-level action functions

The renderer wires these so that Modal button `onclick="…"` strings,
Control Menu entries, and shortcut dispatchers can reach them by name.

| Symbol | Owner | Trigger / caller |
| --- | --- | --- |
| `window.themeChanger` | `_renderer.js:618` | Control Menu Style submenu |
| `window.remakeKeyboard` | `_renderer.js:625` | settings save with new keyboard |
| `window.focusShellTab` | `_renderer.js:634` | clicking a shell tab; `Shortcuts.useAppShortcut("TAB_*")` |
| `window.openSettings` | `_renderer.js:695` | `Ctrl+Shift+S`, Control Menu |
| `window.openControlMenu` | `_renderer.js:1051` | `Ctrl+Shift+O` |
| `window.openWebApp` | `_renderer.js:1056` | Control Menu WebApp list |
| `window.openAddWebApp` | `_renderer.js:1065` | "Add WebApp" button |
| `window.openManageWebApps` | `_renderer.js:1166` | "Manage WebApps" button |
| `window.removeWebApp` | `_renderer.js:1197` | "Remove" button per row |
| `window.writeWebAppEntry` | `_renderer.js:1099` | Add WebApp form submit |
| `window.writeFile` | `_renderer.js:1218` | Modal-based file editor save |
| `window.writeSettingsFile` | `_renderer.js:1228` | settings editor "Save" |
| `window.toggleFullScreen` | `_renderer.js:1237` | Control Menu, F11 |
| `window.openShortcutsHelp` | `src/classes/shortcuts.class.js`, attached by `Shortcuts.init` | `Ctrl+Shift+K` |
| `window.useAppShortcut` | same | every shortcut handler |
| `window.registerKeyboardShortcuts` | same | initial boot + window-focus event |
| `window.fsModalConfirmYes`, `window.fsModalConfirmNo` | `src/classes/fsModal.class.js:236-237` | Overwrite-confirm Modal button `action` strings |

## Browser event hooks

Plain `window.X = handler` wiring of DOM events.

| Symbol | Owner | Purpose |
| --- | --- | --- |
| `window.onerror` | `_renderer.js:75` (boot-screen), `:218` (post-boot Modal-based) | Uncaught-error display |
| `window.onmouseup` | `_renderer.js:589` | Restore terminal focus after on-screen-keyboard taps |
| `window.onresize` | `_renderer.js:1295` | Debounced xterm.fit() |

## Internal flags + bookkeeping

Small bits of state that exist solely because the producer and
consumer live in different `<script>` tag scopes.

| Symbol | Owner | Read by |
| --- | --- | --- |
| `window.passwordMode` | `src/classes/keyboard.class.js:521` (mirrors the on-screen keyboard's dataset attr) | `terminal.class.js:208` (decide whether to suppress visual echo) |
| `window.isTermFilterValidated` | `src/classes/terminal.class.js:67` (sets once after the active theme's `colorFilter` array passes validation) | same file (`:30`, `:33`) on subsequent Terminal constructions |
| `window.NDEX_WEBAPP_DEBUG` | externally set (DevTools console) | `src/classes/webApp-preload.js:16` — flips preload-logging on |

Three entries in earlier revisions of this table —
`window.edexErrorsModals`, `window._settingsOpening`,
`window.resizeTimeout` — were moved off `window` to module-local
declarations at the top of `_renderer.js` in [issue #193](https://github.com/Yukuhu/edex-ui/issues/193).
Every reader was already same-file, so the global lifetime added
nothing.
