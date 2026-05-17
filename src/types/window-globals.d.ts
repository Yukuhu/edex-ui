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
