# Changelog

All notable changes to nDEX-UI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0-SNAPSHOT] — unreleased

First release line of **nDEX-UI**, a maintained fork of the archived
[eDEX-UI](https://github.com/GitSquared/edex-ui) (last upstream release
[v2.2.8](https://github.com/GitSquared/edex-ui/releases/tag/v2.2.8),
2021-10-18). The major-version bump reflects the full Electron stack
upgrade and the rebrand; the project still pays attribution to the
original author Gabriel "Squared" SAILLARD — see the README
[Acknowledgments](README.md#acknowledgments) section.

### Added

- **Persistent FS cache for the Gemma model** under
  `<userData>/gemma-cache/`. The engine resolves this path via
  `@electron/remote`, ensures the directory exists, and passes it to
  the worker in the `load` message; the worker sets
  `env.cacheDir = cacheDir` before calling the transformers.js
  pipeline. Without this pin, transformers.js falls back to an
  in-process default that lives in transient locations under
  Electron and re-downloaded the multi-GB shards on every launch.
  The stable cache lets HF Hub's resumable-download machinery pick
  up a partial shard after a kill / network drop and continue from
  the existing bytes instead of restarting from zero. The TTS
  workers are untouched — they still set `env.useFSCache = false` on
  purpose. (Closes #89)
- **Disk-space pre-check before kicking off a cold Gemma download**.
  Refuses to start when the cache drive doesn't have enough headroom
  for the requested dtype (~5 GB for `q4f16`, ~9 GB for `q8` —
  documented weights + ~1 GB cushion for `.incomplete` shards and ORT
  session scratch). Fires the existing `loaderror` event so the chat
  modal surfaces it through the same error path as any other load
  failure, with a message that names the cache dir and the actual
  free-bytes count.
- **`chatBackend` and `gemmaDtype` settings rows** in the in-app
  settings editor (`Ctrl+Shift+S`). Both keys were already in
  `_boot.js` defaults and the `writeSettingsFile` serializer as
  pass-throughs; this finishes the job by adding the actual editor
  `<select>` rows so users can change them from the UI. `gemmaDtype`
  offers `q4f16` (~3.6 GB, recommended for 8 GB VRAM) and `q8`
  (~6.8 GB, higher quality). `chatBackend` offers `claude-cli`
  (subprocess, online — default) and `gemma-local` (WebGPU,
  offline). Canonicalised the internal `chatBackend` values from the
  brief pre-#88 release (`"cli"` / `"gemma"`) to the longer names;
  `claudeChat.class.js` and the settings-editor `<select>` accept
  the short names too so existing `settings.json` files keep working
  until the next editor save canonicalises them. (Closes #88)
- **Chat backend toggle in the Claude Chat modal**: header now has a
  `CLAUDE CLI` ↔ `LOCAL GEMMA` button that routes turns to either the
  existing `claude` CLI subprocess (default, unchanged) or the local
  WebGPU `GemmaEngine`. The active backend persists via
  `window.settings.chatBackend` (default `"cli"`, added to `_boot.js`
  defaults and `writeSettingsFile` pass-through). On the Gemma path
  the chat maintains an in-renderer transcript and ships it whole
  each turn (no `--resume` equivalent on the local model); CLI and
  Gemma contexts are independent. Switching backend mid-turn cancels
  the in-flight request cleanly — `claude:cancel` on the CLI side or
  `gemmaEngine.cancel()` on the Gemma side. Token deltas flow into
  the existing typewriter pipeline (`_appendAssistantText`) and the
  shared progress bar (`_onTtsProgress`) is reused for Gemma's
  multi-GB model download. Avatar/status-line states wire to the
  same lifecycle events. (Closes #87)
- **`GemmaEngine` singleton** (`src/classes/gemmaEngine.class.js`,
  `window.gemmaEngine`): clean abstraction over the gemma-worker so
  callers don't poke the worker directly. Mirrors `TtsEngine`'s
  shape (extends `EventTarget`, lazy worker spawn, idempotent
  `load(dtype)`, single-in-flight `generate(messages, options)`,
  `cancel()`, `terminate()`, plus `isAvailable` / `isGenerating` /
  `currentDtype` / `currentBackend` getters). Event names and
  payload shapes for `progress` / `loadstart` / `loadready` /
  `loaderror` match `TtsEngine` exactly so the chat modal's existing
  progress-bar UI reuses without modification; generation streams
  via `delta` events and terminates with a `done` event carrying
  `{ tokens, genMs, tokensPerSec, cancelled }`. Reads
  `window.settings.gemmaDtype` (default `q4f16`). Instantiated
  alongside `window.ttsEngine` in `_renderer.js`; not wired into
  chat yet — that's the next sub-issue. (Closes #86)
- **Gemma 4 E4B text-generation worker** (`src/workers/gemma-worker.js`):
  module web worker that loads `onnx-community/gemma-4-E4B-it-ONNX`
  via `@huggingface/transformers` v4 under WebGPU and streams tokens
  back to the renderer over postMessage. Modeled on
  `tts-worker-web.js`. Message protocol: `load` → `load-progress` /
  `load-ready`, `generate` → streamed `token` events → `generate-done`,
  `cancel` interrupts in-flight generation via transformers.js's
  `InterruptableStoppingCriteria`. Three runtime patches concentrated
  in `loadTransformersWithPatches()` are required to make WebGPU
  reachable under Electron's `nodeIntegrationInWorker: true` without
  a bundler: a blob-URL rewrite of `transformers.web.js` to redirect
  the two bare-specifier ORT imports to absolute paths against
  `node_modules`, an in-place patch that forces transformers'
  `apis.IS_NODE_ENV` branch unreachable so it picks `ONNX_WEB`
  instead of the stubbed `onnxruntime_node_exports`, and a mask of
  `process.type` to `"renderer"` so ORT's WASM bootstrap skips its
  `import("worker_threads")` branch. Validated by the issue #84
  spike. FS caching is kept on (Gemma model is multi-GB; see #89 for
  resumable downloads). No UI integration here — that lives in #86+.
  (Closes #85)
- **Reusable TTS infrastructure for text-document modals**: the
  Kokoro/ONNX worker, sentence splitter, audio queue and
  `speechSynthesis` fallback that powered Claude Chat have been
  extracted into a new `TtsEngine` class (singleton on
  `window.ttsEngine`). The `Modal` class now accepts an opt-in
  `ttsSource` option — a literal string, a `() => string` callback, or
  a `{selector: "#id"}` reference — and renders a SPEAK toggle in the
  modal header that reads the source aloud through the engine. Claude
  Chat continues to use the same pipeline via the engine; its avatar,
  voice toggle and `[PERF]` console line are unchanged. No existing
  modal opts in yet — file viewers / PDF reader / shortcuts help will
  follow in their own changes. (Closes #81)
- **WebApps launcher**: install and open web-first tools (YouTube,
  Reddit, Hacker News, GitHub all seeded by default) as in-app
  launchers without leaving nDEX. Reachable via
  `Ctrl+Shift+O → Apps ›`, with synthetic `+ Add new...` and
  `⚙ Manage...` entries on the same list. Each app runs in an
  Electron `<webview>` with a per-app cookie partition
  (`persist:webapp-<id>`), so YouTube remembers your login without
  bleeding session into other apps. While a WebApp is open:
  - `F11` toggles the modal between standard size and a full nDEX
    viewport fill.
  - `Ctrl+Shift+T` reserves the slot for the future "promote into a
    terminal tab" feature (tracked in issue #29; shows a placeholder
    warning today).
  - `Esc` closes the WebApp cleanly.
  Persisted to `userData/webapps.json`. Boot-time backfill restores
  any missing seeded apps without touching user-added ones. DRM-
  encrypted streams (YouTube Music, Spotify, Netflix) do not play
  on vanilla Electron — Widevine support is tracked in issue #30.
  (Closes #28)
- **Central control menu** (`Ctrl+Shift+O`): Omarchy-style launcher
  that surfaces every common action behind a single hotkey, modelled
  on the existing Fuzzy Finder modal. Type to filter, arrow keys to
  navigate, Enter to activate or descend into a submenu, Backspace to
  ascend, Esc to close. Top-level entries: **Settings**, **Shortcuts**,
  **Style** (live theme switch, keyboard layout picker), **Toggle**
  (panels, on-screen keyboard, filesystem dotfiles, list view,
  pass-mode), **Open** (fuzzy file search, file browser, Claude chat),
  **Dev** (DevTools, reload UI, restart eDEX), and **Quit**. Existing
  direct shortcuts (`Ctrl+Shift+S/K/F/E/...`) are unchanged — the menu
  is purely additive. New bindings are backfilled into pre-existing
  `shortcuts.json` files on next launch. (Closes #26)
- **Claude chat modal** (`Ctrl+Shift+A`): TRON-styled popup wired to
  the locally-installed `claude` CLI in stream-json mode. One UUIDv4
  session per opening, `--session-id` on the first turn and `--resume`
  on follow-ups so context carries across turns. Forces
  `--model claude-haiku-4-5` so the chat doesn't inherit whatever the
  user's global Claude Code default happens to be. (PR #3)
- **Holographic Cortana-style avatar** in the chat-modal header
  (`src/classes/aiAvatar.class.js`). Programmatic Canvas-2D HUD with
  framing rings; state machine over `idle` / `thinking` /
  `responding` / `speaking` / `error` drives a vector head with
  swept-back hair, slanted eye slits, animated mouth, and scrolling
  scanlines clipped to the head silhouette. Theme-aware via
  `--color_r/g/b`. (PR #4)
- **Neural text-to-speech** via Kokoro-82M (`kokoro-js ^1.2.1`,
  default voice `af_heart` at `q8` quantization). Fetches the ONNX
  model from HuggingFace on first use within a session; falls back
  to `speechSynthesis` if the model load fails. Voice toggle in the
  chat modal — off by default. **Streams sentence-by-sentence as
  Claude is still generating** via a custom eager splitter
  (`EagerSentenceSplitter`) — sentences yield on `.!?` or newline
  immediately (kokoro-js's own splitter waits for a chunk past the
  terminator, which delayed every sentence by one delta). Markdown
  bold/italic/code markers, URLs, and code-fence lines are stripped
  before synthesis so kokoro doesn't speak "asterisk asterisk" or
  "three backticks". Synthesis runs entirely in a Web Worker
  (`src/workers/tts-worker.js`) — the renderer's JS thread stays
  unblocked during synthesis, and only handles audio playback. The
  pipeline is pre-warmed on voice toggle so the first sentence
  doesn't pay model-load + ONNX-warmup latency. On macOS the worker
  asks onnxruntime-node to try the **CoreML execution provider**
  first (falling back to CPU for any ops CoreML can't compile) —
  yields ~10% faster per-character synth on Apple Silicon. Each
  turn also emits two `[PERF]` console.info lines (turn summary +
  stage breakdown) for ongoing latency tuning; see
  `docs/tts-perf.md`. (PR #4, streaming + worker added by PR
  closing #22, CoreML EP + instrumentation by PR closing #24)
- **Assistant persona for the chat modal**: full `--system-prompt`
  override drops the default Claude Code coding-agent framing.
  `WebSearch` and `WebFetch` are pre-allowed; file/shell tools
  (`Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `NotebookEdit`,
  `Task`, `TodoWrite`) are explicitly disallowed. (PR #4)
- **Smooth token streaming**: a `requestAnimationFrame` ticker
  reveals incoming text at an adaptive rate so the display reads as a
  smooth stream instead of token-batch jumps. (PR #4)
- **Source extraction**: after a response completes, the trailing
  `Sources:` / `References:` / `Citations:` block is removed from the
  chat bubble; markdown-link URLs are stripped (labels stay); a
  `🔗 N` button at the end of the message opens a separate **Sources**
  modal listing numbered, clickable links that open externally via
  `shell.openExternal` (gated to http(s) only). (PR #4)
- **Two-pane filesystem modal** (`Ctrl+Shift+E`): side-by-side
  filesystem browser. Each pane has its own CWD (persisted across
  modal opens) and a header strip with UP / HOME / TTY-CWD / REFRESH
  / VIEW / DOTFILES buttons. (PR #7)
- **Drag-and-drop between filesystem panes**: copy by default, move
  when **Shift** is held; overwrite-existing prompts via a sub-modal;
  recursive directory copy; cross-device moves fall back from
  `fs.rename` → `cp` + `rm` on `EXDEV`; symlinks copied as links
  (`dereference: false`). (PR #7)
- **`Ctrl+Shift+B` toggles the on-screen keyboard**. Hiding the
  keyboard grows the terminal to ~92% of the body height (up from
  ~60%). The resize is top-anchored so the terminal's top edge stays
  fixed and only the bottom edge moves. (PR #8)
- **`Ctrl+Shift+M` toggles the left + right side panels** (system
  / network widgets). Hiding them grows the terminal horizontally
  from 65% to 95% width. Runtime-only — resets on relaunch. (PR
  closing #12)
- **Combined fullscreen terminal mode**: when both `Ctrl+Shift+B`
  and `Ctrl+Shift+M` are toggled on, the terminal expands to fill
  the viewport minus a thin breathing-room inset that lets the
  augmented-ui frame's `bl-clip` corner and bottom/right border
  render fully. No new shortcut — composes from the existing two.
  (PR closing #12)
- **Global Esc closes the topmost modal** across the whole app —
  Settings, Shortcuts help, Claude chat, sources, error dialogs.
  Stacked modals (e.g. chat → sources) close one at a time
  top-down. (PR #6)
- **`modalCloseButton` setting** (default `true`): when `false`, the
  auto-added Close button on custom-type modals is hidden. Esc still
  closes regardless, so users can't lock themselves into a modal.
  (PR #6)
- **`spawnOnTabCycle` setting** (default `true`): controls whether
  `Ctrl+Tab` / `Ctrl+Shift+Tab` spawn a new terminal when cycling
  past an empty slot. Default `true` makes `Ctrl+Tab` from a fresh
  boot open tab 1, tab 2, etc., matching the behavior most users
  expect. Set to `false` for the legacy skip-empty behavior. (PR #5)
- **`ttsVoice` and `ttsDtype` settings** for the Claude Chat neural
  TTS. `ttsVoice` (default `af_heart`) picks one of Kokoro-82M's 28
  voices — voice grades from kokoro-js's own index are shown in the
  dropdown labels (e.g. `af_heart (A, US/F, ❤️)`, `am_adam (F+, US/M)`).
  Switching voices is free since they all share one model file.
  `ttsDtype` (default `q8`, ~92 MB) chooses the quantization tier:
  `q8`, `fp16` (~163 MB), `fp32` (~326 MB), `q4f16` (~155 MB), or
  `q4` (~50 MB, low). Each dtype is fetched from HuggingFace on
  demand on first use — never bundled in the binary. The active
  `voice / dtype` is shown in the chat modal header. Closes #20.
- **TTS model download progress bar** with rolling speed readout
  (`<file> — 47% (15.3 MB / 32.5 MB) — 8.2 MB/s`). Hidden when no
  download is in flight; switches to an indeterminate sweep
  animation for instant cache hits so the user always sees the
  load happen.
- **`Ctrl+Shift+E` shortcut** (`FS_OPEN`) to open the new filesystem
  modal. (PR #7)
- **README "About this fork" + "Acknowledgments" sections** that
  credit Gabriel "Squared" SAILLARD as the original eDEX-UI author
  with a link back to `GitSquared/edex-ui`. (PR #2)
- **SonarCloud static analysis** runs on every push to `master` and
  every PR via `.github/workflows/sonarcloud.yml`. Blocks on the
  quality gate so a failing gate marks the check red and branch
  protection can require it, mirroring CodeQL. Project key
  `Yukuhu_edex-ui`; vendored assets / fonts / audio are excluded so
  the analyser only sees first-party code. (Closes #33)

### Changed

- **Rebranded** from eDEX-UI to **nDEX-UI**: `name`, `productName`,
  `appId` (`com.ndex.ui`), in-app strings (window title, boot screen,
  welcome banner, crash dialog, `TERM_PROGRAM`, file-type labels,
  update-check User-Agent), and the `UpdateChecker` endpoint now
  queries the fork's releases. User-facing file extensions
  (`.edex-theme`, `.edex-kblayout`, `.edex-settings`) intentionally
  kept so existing config files continue to be recognized. (PR #1)
- **Version bumped to `3.0.0-SNAPSHOT`** across both `package.json`
  files and their lockfiles. (PR #1)
- **Electron 12 → 32**, **node-pty 0.10 → 1.x**, **@electron/remote
  1.x → 2.x**, **electron-rebuild → @electron/rebuild ^4**,
  **electron-builder 22 → 26** to restore installability on current
  Node and Apple Silicon. Code patches for Electron API breakages:
  removed `enableRemoteModule`, added per-window
  `@electron/remote/main.enable(win.webContents)`, replaced removed
  `new-window` event with `setWindowOpenHandler`, rewrote all
  `electron.remote.X` callsites to use `require("@electron/remote")`
  directly. (PR #1)
- **Electron 32 → 42**, plus runtime-dep bumps to clear the npm-audit
  surface: `systeminformation ^5.31.6`, `pdfjs-dist ^4.10.38`,
  `geolite2-redist ^3.1.3`, `ws ^8.18`, `nanoid ^3.3.12`,
  `smoothie ^1.36.1`. PDF.js now loads as an ESM module that bridges
  to `window.pdfjsLib`; GeoIP init uses dynamic `import()` to consume
  the ESM-only `geolite2-redist 3.x`. (PR #1)
- **Inline filesystem panel removed** in favor of the modal. The
  vacated ~43vw × 30vh area below the terminal is intentionally
  empty for now (reserved for future content). The `FilesystemDisplay`
  class was refactored to be container-scoped (multiple instances
  supported), driven by addEventListener instead of inline `onclick`
  strings, with HTML5 drag attributes and opt-in terminal tracking.
  `Ctrl+Shift+L` / `Ctrl+Shift+H` now apply to the focused pane while
  the modal is open. (PR #7)
- **Fuzzy finder** (`Ctrl+Shift+F`) reads the active terminal's CWD
  directly via `term.cwd` (with `FALLBACK |-- ` prefix stripping)
  now that the `window.fsDisp` singleton is gone. (PR #7)
- **Persona prompt** instructs Claude to use `WebSearch` / `WebFetch`
  silently — no permission-asking, no "training data may be out of
  date" disclaimers, no inline URL listing (the UI extracts them
  separately). (PR #4)

### Removed

- **Inline `section#filesystem` panel** and its associated CSS rules
  (43vw × 30vh slot below the terminal). The two-pane modal replaces
  it. (PR #7)
- **Upstream maintainer personal info**: author email and donate /
  sponsor / Twitter links scrubbed from `package.json` files,
  `.github/FUNDING.yml` (deleted), `SECURITY.md` (rewrote to use
  GitHub Security Advisories), and README. LICENSE retains the
  original GPLv3 attribution; `build.copyright` keeps the 2017-2021
  attribution alongside the new fork copyright. (PR #2)
- **Sponsor banner asset** `media/sponsor-uidev-bytes.jpg` and
  unused `media/youtube-demo-teaser.gif`. (PR #2)

### Fixed

- **Terminal init crash under color v5 (ESM-only)**: `color@5` ships
  as an ES module, so `require("color")` from `terminal.class.js`
  returned the namespace object and `color(base)` threw "color is not
  a function". Resolve the constructor via `.default` with a
  function-shape fallback so both v3.x and v5+ keep working.
  (Closes #93)
- **Augmented-ui stylesheet 404 on fresh install**: `augmented-ui` v2
  renamed its dist file from `augmented.css` to `augmented-ui.css`.
  Updated the `<link>` in `ui.html`. (Closes #94)
- **Terminal no longer crashes on init under xterm v5**: the
  ligatures addon's `registerCharacterJoiner` moved behind a proposed-
  API opt-in flag in xterm 5.x. Without it, fresh installs threw
  `You must set the allowProposedApi option to true to use proposed
  API` from `LigaturesAddon.activate` and never reached UI ready.
  Added `allowProposedApi: true` to the `xTerm` constructor in
  `terminal.class.js`. (Closes #95)
- **EPIPE no longer pops the "nDEX-UI crashed" dialog**: the main
  process's `uncaughtException` handler now skips the dialog for
  `e.code === "EPIPE"`, which is benign collateral when killing the
  app or when an IPC subprocess closes its stdin mid-write.
- **Terminal frame is no longer clipped in fullscreen mode**: switched
  the fullscreen-mode sizing from percentage-based (`calc(100% - …)`)
  to explicit viewport units (`calc(100vw - …)` / `calc(100vh - …)`)
  because the body's `flex-wrap: wrap` interacted with the percentage
  height in a way that pushed main_shell past the viewport bottom,
  clipping the augmented-ui frame's bottom border + `bl-clip` corner.
  Also added `box-sizing: border-box` to `section#main_shell` so its
  `padding` doesn't add extra dimensions on top of the percentage
  width/height, and a matching `background-color: var(--color_light_black)`
  so any xterm-rows-rounding gap at the bottom doesn't reveal the
  body grid through. (PR closing #12)


- **Modernization unblocks Apple Silicon / macOS 26** — the original
  Electron 12 / node-pty 0.10 stack failed to compile on Node ≥ 18
  and predated arm64-darwin support. (PR #1)
- **Cross-platform TTS**: chose `kokoro-js` over native Piper because
  the official Piper macOS aarch64 archive ships without its runtime
  dylibs (an unfixed upstream packaging bug since Nov 2023). Kokoro
  runs identically on Win / Linux / Mac because it's WASM + ONNX in
  the renderer; no native binaries. (PR #4)
- **Terminal theme on first paint**: `align-self: flex-start` (the
  fix that anchors the terminal's top edge during the keyboard-toggle
  resize) is applied **after** boot via JS rather than from CSS,
  because applying it from boot confused xterm's WebGL canvas paint
  and the terminal first rendered with the body grid showing
  through. (PR #8)
- **Sources modal focus restoration**: after closing the sources
  sub-modal, focus returns to the chat input so Esc still closes the
  parent chat modal. (PR #4)
- **Plain `Enter` sends in the chat modal** (Shift+Enter inserts a
  newline). The first iteration only sent on Ctrl/Cmd+Enter, which
  felt unintuitive. (PR #3 follow-up)

### Security

- Bumped `electron` from 32 to 42, clearing 17 GHSA advisories
  (ASAR integrity bypass, AppleScript injection, service-worker IPC
  spoofing, several use-after-frees, registry-key injection,
  USB-device filter bypass, HTTP header injection, etc.). (PR #1)
- Bumped `systeminformation` to ^5.31.6, closing a **critical**
  command-injection finding (GHSA-gx6r-qc2v-3p3v and others).
  (PR #1)
- Bumped `pdfjs-dist` to ^4.10.38, closing the high-severity
  arbitrary-JS-execution-on-malicious-PDF advisory
  (GHSA-wgrm-67xf-hhpq). (PR #1)
- Bumped `ws` to ^8.18, closing the high-severity DoS via
  header-count advisory (GHSA-3h5v-q93c-6h6q). (PR #1)
- Bumped `nanoid` and `smoothie` to patched versions. (PR #1)
- Bumped `geolite2-redist` and `@electron/rebuild` so transitive
  `tar` dependencies are no longer vulnerable. (PR #1)
- **Validate URL scheme before `shell.openExternal`**: the source
  URLs surfaced by the chat modal ultimately come from
  model-generated text, so the click handler hard-rejects anything
  that isn't `http(s):` before passing it to `shell.openExternal`
  (which would otherwise execute `javascript:` or `file:` schemes
  via the OS handler). Defence layered both at extraction time and
  at the click site. (PR #4 follow-up)

## [2.2.8] — 2021-10-18

Final upstream release of eDEX-UI before the project was archived.
See the original repository for the complete history prior to this
changelog: <https://github.com/GitSquared/edex-ui/releases/tag/v2.2.8>.
