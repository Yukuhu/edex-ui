"use strict";

// Minimal ESLint baseline for nDEX-UI (issue #169).
//
// Goal: surface dead code, undeclared globals, and obvious bugs
// without forcing a style rewrite. Style/format rules are out of
// scope here — Sonar handles them where it cares.
//
// Source layout, for context:
//   src/_boot.js, src/_main_claude.js, src/_multithread.js
//     -> Electron main process (Node only)
//   src/_renderer.js, src/classes/*.class.js
//     -> Electron renderer (Node + browser globals + shared scope)
//   src/classes/webApp-preload.js
//     -> <webview> preload (browser-only IIFE)
//   src/workers/*.js
//     -> Web Workers (gemma + tts-worker-web are ES modules;
//        tts-worker uses CommonJS require under
//        nodeIntegrationInWorker)
//   tests/**/*.js
//     -> node:test (Node only; jsdom helper installs window/document
//        onto global so dom tests use them bare)

const js = require("@eslint/js");
const globals = require("globals");

// `globals@15` ships a few keys with trailing whitespace
// (e.g. "AudioWorkletGlobalScope ") which ESLint 9 rejects. Trim
// defensively so we don't inherit the upstream bug.
function clean(set) {
    const out = {};
    for (const [key, value] of Object.entries(set)) {
        out[key.trim()] = value;
    }
    return out;
}

const NODE = clean(globals.node);
const BROWSER = clean(globals.browser);
const WORKER = clean(globals.worker);

// Identifiers initialized once at script-tag load time in the
// renderer's shared scope (either by `_renderer.js`'s top-level
// `const X = require(...)` or by `*.class.js` files assigning to
// `window`). Reading any of these bare from another renderer file
// is intentional, not a typo.
//
// When adding a new renderer class, add it here too. The eventual
// `docs/globals.md` (issue #178) will be the canonical reference;
// until then, this list serves as a working inventory.
const RENDERER_SHARED = {
    // Node modules loaded once at the top of _renderer.js
    path: "readonly",
    fs: "readonly",
    electron: "readonly",
    remote: "readonly",
    ipc: "readonly",

    // Renderer-resolved paths (top of _renderer.js)
    settings: "readonly",
    settingsDir: "readonly",
    themesDir: "readonly",
    keyboardsDir: "readonly",
    fontsDir: "readonly",
    settingsFile: "readonly",
    shortcutsFile: "readonly",
    webappsFile: "readonly",
    lastWindowStateFile: "readonly",

    // Helpers attached to window from _renderer.js
    _delay: "readonly",
    _escapeHtml: "readonly",
    _loadTheme: "readonly",
    _purifyCSS: "readonly",
    renderPage: "readonly",

    // Externals attached to window from ui.html
    pdfjsLib: "readonly",

    // Class identifiers — each `*.class.js` ends with
    // `window.X = X;` and gets read bare from sibling files.
    AIAvatar: "readonly",
    AudioManager: "readonly",
    ClaudeChat: "readonly",
    Clock: "readonly",
    Conninfo: "readonly",
    ControlMenu: "readonly",
    Cpuinfo: "readonly",
    DocReader: "readonly",
    FilesystemDisplay: "readonly",
    FsModal: "readonly",
    FuzzyFinder: "readonly",
    GemmaEngine: "readonly",
    HardwareInspector: "readonly",
    Keyboard: "readonly",
    LocationGlobe: "readonly",
    MediaPlayer: "readonly",
    Modal: "readonly",
    Netstat: "readonly",
    RAMwatcher: "readonly",
    Shortcuts: "readonly",
    Sysinfo: "readonly",
    Terminal: "readonly",
    Toplist: "readonly",
    TtsEngine: "readonly",
    UpdateChecker: "readonly",
    WebApp: "readonly"
};

const COMMON_RULES = {
    "no-unused-vars": ["warn", {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_"
    }],
    "no-undef": "error",
    "prefer-const": "warn",
    "eqeqeq": ["warn", "smart"],
    "no-implicit-globals": "error",
    "no-empty": ["warn", { "allowEmptyCatch": true }],
    "no-constant-condition": ["error", { "checkLoops": false }],
    // Catches reassignment of read-only globals (undefined, NaN,
    // eval, …). One legitimate site exists — `src/_renderer.js:2`
    // intentionally replaces `global.eval` to disable eval as a
    // hardening measure — and is annotated locally with
    // `// eslint-disable-next-line no-global-assign` rather than
    // exempting `eval` here.
    "no-global-assign": "error",

    // The three rules below come from js.configs.recommended at
    // "error". For the baseline PR we want lint to pass against
    // current master without source edits (issue #169 ACs). They
    // each flag a handful of pre-existing sites that can be
    // cleaned up incrementally; demote to "warn" for visibility.
    "no-case-declarations": "warn",
    "no-extra-boolean-cast": "warn",
    "no-useless-escape": "warn"
};

module.exports = [
    {
        ignores: [
            "node_modules/**",
            "src/node_modules/**",
            "prebuild-src/**",
            "coverage/**",
            "dist/**",
            "file-icons/**",
            "media/**",
            "src/assets/vendor/**",
            "src/assets/fonts/**",
            "src/assets/audio/**",
            "src/assets/icons/**",
            "src/assets/misc/**",
            "src/assets/themes/**",
            "src/assets/kb_layouts/**",
            "src/assets/css/**",
            "**/*.min.js"
        ]
    },

    js.configs.recommended,

    {
        // Default: anything not matched below is treated as a Node
        // CommonJS file (root-level scripts, generators, etc.).
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "commonjs",
            globals: NODE
        },
        rules: COMMON_RULES
    },

    {
        // Electron main-process modules.
        files: [
            "src/_boot.js",
            "src/_main_claude.js",
            "src/_multithread.js"
        ],
        languageOptions: {
            globals: NODE
        }
    },

    {
        // Electron renderer-process modules. They `require()` like
        // Node but also touch `window`, `document`, DOM APIs, and
        // read each other's top-level identifiers via the shared
        // script-tag scope (see RENDERER_SHARED above).
        files: [
            "src/_renderer.js",
            "src/classes/**/*.js"
        ],
        languageOptions: {
            globals: { ...NODE, ...BROWSER, ...RENDERER_SHARED }
        }
    },

    {
        // <webview>-side preload script.
        files: ["src/classes/webApp-preload.js"],
        languageOptions: {
            globals: { ...BROWSER, ...NODE }
        }
    },

    {
        // Workers. Gemma and tts-worker-web are ES modules (use
        // top-level await / import); tts-worker is CommonJS but the
        // parser tolerates require() inside sourceType:"module".
        files: ["src/workers/**/*.js"],
        languageOptions: {
            sourceType: "module",
            globals: { ...WORKER, ...NODE }
        }
    },

    {
        // node:test files (Node-only globals by default).
        files: ["tests/**/*.js"],
        languageOptions: {
            globals: NODE
        }
    },

    {
        // DOM tests bootstrap jsdom via tests/helpers/dom.js, which
        // installs `window`/`document`/`HTMLElement`/etc. onto
        // Node's `global`. The tests then read them bare.
        files: ["tests/dom/**/*.js"],
        languageOptions: {
            globals: { ...NODE, ...BROWSER }
        }
    }
];
