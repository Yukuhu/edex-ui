// Ambient module stubs for runtime deps that live in `src/node_modules`
// rather than the repo root. The `Typecheck` workflow only `npm ci`s
// the root (matches #183's Electron-skip), so these packages aren't
// installed and `tsc` would otherwise error with TS2307. Stubbing as
// `any` is fine — the renderer typechecks runtime calls against
// these surfaces at the call site, not against the package's own
// types.
declare module "howler";
declare module "node-pty";
declare module "xterm";
declare module "xterm-addon-attach";
declare module "xterm-addon-fit";
declare module "xterm-addon-ligatures";
declare module "xterm-addon-webgl";
declare module "@electron/remote";
declare module "@huggingface/transformers";
declare module "kokoro-js";
declare module "nanoid";
declare module "smoothie";
declare module "systeminformation";
declare module "username";
declare module "geolite2-redist";
declare module "maxmind";
declare module "pretty-bytes";
declare module "shell-env";
declare module "tail";
declare module "which";

// Ambient TypeScript declarations for nDEX-UI's custom `window.*`
// extensions. Loaded by `tsconfig.json` so any file with
// `// @ts-check` can read renderer state from `window` without a
// "Property 'X' does not exist on type 'Window & typeof globalThis'"
// error.
//
// The canonical inventory of every symbol is `docs/globals.md`.
// This file mirrors it as types — strictly enough to catch typos,
// loosely enough that opt-in migrations don't trigger a cascade
// of "Property 'foo' does not exist on type" errors for adjacent
// untyped state.
//
// Convention: shapes we know precisely get full interfaces; the
// rest stay as `any` until a future PR tightens them. Issue #201.

interface NdexUiSettings {
    shell?: string;
    shellArgs?: string;
    cwd?: string;
    env?: string;
    username?: string;
    keyboard?: string;
    theme?: string;
    termFontSize?: number;
    audio?: boolean;
    audioVolume?: number;
    disableFeedbackAudio?: boolean;
    pingAddr?: string;
    clockHours?: number;
    port?: number;
    monitor?: number;
    nointro?: boolean;
    nocursor?: boolean;
    nocursorOverride?: boolean;
    nointroOverride?: boolean;
    iface?: string | false;
    allowWindowed?: boolean;
    forceFullscreen?: boolean;
    keepGeometry?: boolean;
    excludeThreadsFromToplist?: boolean;
    hideDotfiles?: boolean;
    fsListView?: boolean;
    spawnOnTabCycle?: boolean;
    modalCloseButton?: boolean;
    ttsVoice?: string;
    ttsDtype?: string;
    chatBackend?: string;
    gemmaDtype?: string;
    experimentalGlobeFeatures?: boolean;
    experimentalFeatures?: boolean;
}

interface Window {
    // Per-launch state (see docs/globals.md "Renderer state (per-launch singletons)")
    settings: NdexUiSettings;
    shortcuts: any[];
    webapps: any[];
    lastWindowState: any;
    theme: any;
    term: { [tab: number]: any };
    currentTerm: number;
    keyboard: any;
    mods: any;
    modals: { [id: string]: any };
    audioManager: any;
    ttsEngine: any;
    gemmaEngine: any;
    updateCheck: any;
    si: any;

    // Transient per-modal (see docs/globals.md "Renderer state (transient, per-modal)")
    activeControlMenu?: any;
    activeFuzzyFinder?: any;
    activeWebApp?: any;

    // Escape / DOM helpers (see docs/globals.md "Helpers")
    _escapeHtml: (s: unknown) => string;
    _purifyCSS: (s: unknown) => string;
    _strictCssNumber: (v: unknown) => number;
    _safeCssValue: (s: unknown) => string;
    _encodePathURI: (uri: string) => string;
    _delay: (ms: number) => Promise<void>;
    _loadTheme: (theme: any) => void;
    _hotSwitchTheme: (name: string) => void;
    _hotSwitchKeyboard: (name: string) => void;
    _renderWebAppManageRows: (apps: any[]) => string;

    // Renderer-class identifiers attached at module end
    Shortcuts: any;
    FsModal: any;
    ClaudeChat: any;
    AIAvatar: any;
    FilesystemDisplay: any;
    TtsEngine: any;

    // Vendored
    pdfjsLib?: any;

    // Page-level action functions (see docs/globals.md "Page-level action functions")
    themeChanger: (theme: string) => void;
    remakeKeyboard: (layout: string) => void;
    focusShellTab: (n: number) => void;
    openSettings: () => Promise<void>;
    openControlMenu: () => void;
    openShortcutsHelp: () => void;
    openWebApp: (id: string) => void;
    openAddWebApp: () => void;
    openManageWebApps: () => void;
    removeWebApp: (id: string) => void;
    writeWebAppEntry: () => void;
    writeFile: (path: string) => void;
    writeSettingsFile: () => void;
    toggleFullScreen: () => void;
    useAppShortcut: (action: string) => boolean;
    registerKeyboardShortcuts: () => void;
    fsModalConfirmYes: () => void;
    fsModalConfirmNo: () => void;

    // Internal flags (see docs/globals.md "Internal flags + bookkeeping")
    passwordMode?: string;
    isTermFilterValidated?: boolean;
    NDEX_WEBAPP_DEBUG?: boolean;
}
