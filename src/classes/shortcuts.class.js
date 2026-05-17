"use strict";

// Shortcut dispatch + the help-modal render helpers, extracted from
// `_renderer.js` (issue #173). Issue #174 will fold the bootstrap
// shortcut defaults from `_boot.js` into this same module so adding
// a new shortcut becomes a one-file change.
//
// `useAppShortcut` reads renderer-global services (`window.term`,
// `window.keyboard`, `window.FsModal`, `window.ClaudeChat`, …)
// directly. That's the established pattern in this codebase
// — every shortcut target lives on `window`, and inverting the
// dependency would amount to a service-locator rewrite for no
// behavior change. See issue #178 for the broader documentation of
// the renderer's shared scope.

// Human-readable description shown in the shortcut help modal.
// Some entries contain intentional inline HTML (<strong>, <code>,
// <br>) — see the `description` lookup in
// `_renderShortcutsAppList` below for the escape contract.
const SHORTCUTS_DEFINITION = {
    "COPY": "Copy selected buffer from the terminal.",
    "PASTE": "Paste system clipboard to the terminal.",
    "NEXT_TAB": "Switch to the next opened terminal tab (left to right order).",
    "PREVIOUS_TAB": "Switch to the previous opened terminal tab (right to left order).",
    "TAB_X": "Switch to terminal tab <strong>X</strong>, or create it if it hasn't been opened yet.",
    "SETTINGS": "Open the settings editor.",
    "SHORTCUTS": "List and edit available keyboard shortcuts.",
    "FUZZY_SEARCH": "Search for entries in the current working directory.",
    "FS_OPEN": "Open the two-pane filesystem browser.",
    "FS_LIST_VIEW": "Toggle list / grid view in the focused pane of the filesystem browser.",
    "FS_DOTFILES": "Toggle hidden files in the focused pane of the filesystem browser.",
    "KB_PASSMODE": "Toggle the on-screen keyboard's \"Password Mode\", which allows you to safely<br>type sensitive information even if your screen might be recorded (disable visual input feedback).",
    "KB_TOGGLE": "Show / hide the on-screen keyboard. Hiding it grows the terminal to fill the freed space.",
    "PANELS_TOGGLE": "Show / hide the left + right side panels (system / network widgets). Hiding them grows the terminal horizontally.",
    "DEV_DEBUG": "Open Chromium Dev Tools, for debugging purposes.",
    "DEV_RELOAD": "Trigger front-end hot reload.",
    "CLAUDE_CHAT": "Open the Claude chat modal (talks to the locally installed <code>claude</code> CLI).",
    "CONTROL_MENU": "Open the central control / launcher menu.",
    "WEBAPP_FULLSCREEN": "(Inside a WebApp) Toggle the modal between standard size and full nDEX viewport. Bound to <code>F11</code>.",
    "WEBAPP_TO_TAB": "(Inside a WebApp) Promote the WebApp into a terminal tab slot. Bound to <code>Ctrl+Shift+T</code>. Placeholder until issue #29 lands the tab-bar refactor."
};

// Coerce a shortcuts.json field to a string. The file is user-editable
// so a malformed entry (null, number, object) could otherwise throw
// from `startsWith` / `_escapeHtml` mid-forEach and take out the whole
// shortcuts help modal.
function _shortcutField(v) {
    return String(v ?? "");
}

// Build the rows for the "Emulator shortcuts" accordion.
function _renderShortcutsAppList(shortcuts) {
    const esc = window._escapeHtml;
    let html = "";
    shortcuts.filter(e => e.type === "app").forEach(cut => {
        const trigger = _shortcutField(cut.trigger);
        const rawAction = _shortcutField(cut.action);
        const action = rawAction.startsWith("TAB_") ? "TAB_X" : rawAction;
        // SHORTCUTS_DEFINITION entries contain intentional inline HTML
        // (<strong>, <code>, <br>) so they are emitted unescaped. The
        // ?? fallback handles user-edited shortcuts.json entries whose
        // action key isn't in the lookup; that path *is* user input, so
        // escape it.
        const description = SHORTCUTS_DEFINITION[action] ?? esc(action);
        html += `<tr>
                        <td>${cut.enabled ? "YES" : "NO"}</td>
                        <td><input disabled type="text" maxlength=25 value="${esc(trigger)}"></td>
                        <td>${description}</td>
                    </tr>`;
    });
    return html;
}

// Build the rows for the "Custom command shortcuts" accordion.
function _renderShortcutsCustomList(shortcuts) {
    const esc = window._escapeHtml;
    let html = "";
    shortcuts.filter(e => e.type === "shell").forEach(cut => {
        const trigger = _shortcutField(cut.trigger);
        const action = _shortcutField(cut.action);
        html += `<tr>
                            <td>${cut.enabled ? "YES" : "NO"}</td>
                            <td><input disabled type="text" maxlength=25 value="${esc(trigger)}"></td>
                            <td>
                                <input disabled type="text" placeholder="Run terminal command..." value="${esc(action)}">
                                <input disabled type="checkbox" name="shortcutsHelpNew_Enter" ${cut.linebreak ? "checked" : ""}>
                                <label for="shortcutsHelpNew_Enter">Enter</label>
                            </td>
                        </tr>`;
    });
    return html;
}

// Wrap pre-rendered row blocks in the two accordions + outer help text.
function _shortcutsHelpHTML(appList, customList) {
    return `<h5>Using either the on-screen or a physical keyboard, you can use the following shortcuts:</h5>
                <details open id="shortcutsHelpAccordeon1">
                    <summary>Emulator shortcuts</summary>
                    <table class="shortcutsHelp">
                        <tr>
                            <th>Enabled</th>
                            <th>Trigger</th>
                            <th>Action</th>
                        </tr>
                        ${appList}
                    </table>
                </details>
                <br>
                <details id="shortcutsHelpAccordeon2">
                    <summary>Custom command shortcuts</summary>
                    <table class="shortcutsHelp">
                        <tr>
                            <th>Enabled</th>
                            <th>Trigger</th>
                            <th>Command</th>
                        </tr>
                       ${customList}
                    </table>
                </details>
                <br>`;
}

// Mirror the two <details> accordions so opening one auto-closes the
// other. Runs after the modal is mounted; safe to call multiple times
// because the listeners are scoped to fresh elements each time.
function _wireShortcutsAccordions() {
    const wrap1 = document.getElementById("shortcutsHelpAccordeon1");
    const wrap2 = document.getElementById("shortcutsHelpAccordeon2");
    wrap1.addEventListener("toggle", () => { wrap2.open = !wrap1.open; });
    wrap2.addEventListener("toggle", () => { wrap1.open = !wrap2.open; });
}

// Dispatch table for the built-in `cut.action` values defined in
// `_boot.js`'s shortcuts.json defaults. Returns `true` on a recognised
// action and `false` otherwise (matching the legacy contract — see
// the `useAppShortcut`-driven callsites in WebApp's keyboard handler).
function useAppShortcut(action) {
    switch (action) {
        case "COPY":
            window.term[window.currentTerm].clipboard.copy();
            return true;
        case "PASTE":
            window.term[window.currentTerm].clipboard.paste();
            return true;
        case "NEXT_TAB": {
            // spawnOnTabCycle (default true): cycle through all 5 slots and
            // let focusShellTab() spawn a TTY into any empty one. When the
            // user explicitly sets it false, fall back to the legacy
            // skip-empty-slots behavior so cycling only walks already-
            // initialized tabs.
            if (window.settings.spawnOnTabCycle !== false) {
                const cur = window.currentTerm || 0;
                window.focusShellTab((cur + 1) % 5);
            } else {
                const j = window.currentTerm || 0;
                if (window.term[j+1]) {
                    window.focusShellTab(j+1);
                } else if (window.term[j+2]) {
                    window.focusShellTab(j+2);
                } else if (window.term[j+3]) {
                    window.focusShellTab(j+3);
                } else if (window.term[j+4]) {
                    window.focusShellTab(j+4);
                } else {
                    window.focusShellTab(0);
                }
            }
            return true;
        }
        case "PREVIOUS_TAB": {
            if (window.settings.spawnOnTabCycle !== false) {
                const cur = window.currentTerm || 0;
                window.focusShellTab((cur + 4) % 5);
            } else {
                let i = window.currentTerm || 4;
                if (window.term[i] && i !== window.currentTerm) {
                    window.focusShellTab(i);
                } else if (window.term[i-1]) {
                    window.focusShellTab(i-1);
                } else if (window.term[i-2]) {
                    window.focusShellTab(i-2);
                } else if (window.term[i-3]) {
                    window.focusShellTab(i-3);
                } else if (window.term[i-4]) {
                    window.focusShellTab(i-4);
                }
            }
            return true;
        }
        case "TAB_1": window.focusShellTab(0); return true;
        case "TAB_2": window.focusShellTab(1); return true;
        case "TAB_3": window.focusShellTab(2); return true;
        case "TAB_4": window.focusShellTab(3); return true;
        case "TAB_5": window.focusShellTab(4); return true;
        case "SETTINGS":
            window.openSettings();
            return true;
        case "SHORTCUTS":
            window.openShortcutsHelp();
            return true;
        case "FUZZY_SEARCH":
            // FuzzyFinder is a renderer class — visible bare from
            // the shared script scope. See RENDERER_SHARED in
            // eslint.config.js.
            window.activeFuzzyFinder = new FuzzyFinder();
            return true;
        case "FS_OPEN":
            window.FsModal.open();
            return true;
        case "FS_LIST_VIEW":
            // Applies to the focused pane inside the open FsModal;
            // no-op when the modal isn't open.
            if (globalThis.FsModal?._instance?.focusedPane) {
                window.FsModal._instance.focusedPane.toggleListview();
            }
            return true;
        case "FS_DOTFILES":
            if (globalThis.FsModal?._instance?.focusedPane) {
                window.FsModal._instance.focusedPane.toggleHidedotfiles();
            }
            return true;
        case "KB_PASSMODE":
            window.keyboard.togglePasswordMode();
            return true;
        case "KB_TOGGLE":
            document.body.classList.toggle("keyboardHidden");
            // Re-fit xterm after the CSS height transition settles.
            setTimeout(() => {
                if (globalThis.term?.[globalThis.currentTerm]) {
                    try { window.term[window.currentTerm].fit(); } catch (_) {}
                }
            }, 550);
            return true;
        case "PANELS_TOGGLE":
            document.body.classList.toggle("panelsHidden");
            // Re-fit xterm after the CSS width transition settles
            // (main_shell already transitions width over 0.5s).
            setTimeout(() => {
                if (globalThis.term?.[globalThis.currentTerm]) {
                    try { window.term[window.currentTerm].fit(); } catch (_) {}
                }
            }, 550);
            return true;
        case "DEV_DEBUG":
            // `remote` is declared once in _renderer.js
            // (`const remote = require("@electron/remote")`) and is
            // visible from every renderer class via the shared
            // classic-script lexical environment. See ESLint's
            // RENDERER_SHARED map for the inventory.
            remote.getCurrentWindow().webContents.toggleDevTools();
            return true;
        case "DEV_RELOAD":
            window.location.reload(true);
            return true;
        case "CLAUDE_CHAT":
            window.ClaudeChat.open();
            return true;
        case "CONTROL_MENU":
            window.openControlMenu();
            return true;
        default:
            console.warn(`Unknown "${action}" app shortcut action`);
            return false;
    }
}

// Restore keyboard focus to the active terminal after the shortcuts
// help modal closes.
function _shortcutsHelpOnClose() {
    window.keyboard.attach();
    window.term[window.currentTerm].term.focus();
}

// Open the shortcuts help modal. Idempotent — quick repeat
// `Ctrl+Shift+K` presses don't stack copies (same hazard as #50).
function openShortcutsHelp() {
    if (document.getElementById("settingsEditor") || document.getElementById("shortcutsHelpAccordeon1")) return;

    const appList = _renderShortcutsAppList(window.shortcuts);
    const customList = _renderShortcutsCustomList(window.shortcuts);

    // Modal "buttons" entries are JS source strings spliced into an
    // `onclick="…"` attribute. Apostrophes in the user's userData
    // path (e.g. `/Users/John's Mac/…`) would otherwise close the
    // string literal early and break the action. JSON.stringify
    // produces a properly-quoted JS string literal.
    const shortcutsPathLiteral = JSON.stringify(String(shortcutsFile ?? ""));

    window.keyboard.detach();
    new Modal({
        type: "custom",
        title: `Available Keyboard Shortcuts <i>(v${remote.app.getVersion()})</i>`,
        html: _shortcutsHelpHTML(appList, customList),
        buttons: [
            { label: "Open Shortcuts File", action: `electron.shell.openPath(${shortcutsPathLiteral});electronWin.minimize();` },
            { label: "Reload UI", action: "window.location.reload(true);" }
        ]
    }, _shortcutsHelpOnClose);

    _wireShortcutsAccordions();
}

// Bind every enabled entry in window.shortcuts to `remote.globalShortcut`.
// Called from `_renderer.js` once shortcuts.json has been loaded.
//
// `window.shortcuts` is read from a user-editable JSON file, so the
// trigger/action fields can legitimately be null / numbers / objects.
// `_shortcutField` coerces them to strings up-front so a single
// malformed entry can't throw out of `.replace` / `.forEach` and skip
// every shortcut after it.
function registerKeyboardShortcuts() {
    const globalShortcut = remote.globalShortcut;
    window.shortcuts.forEach(cut => {
        if (!cut.enabled) return;

        const trigger = _shortcutField(cut.trigger).trim();
        const action = _shortcutField(cut.action);
        if (!trigger) return;

        if (cut.type === "app") {
            if (action === "TAB_X") {
                for (let i = 1; i <= 5; i++) {
                    const expanded = trigger.replace("X", i);
                    const dfn = () => { window.useAppShortcut(`TAB_${i}`); };
                    globalShortcut.register(expanded, dfn);
                }
            } else {
                globalShortcut.register(trigger, () => {
                    window.useAppShortcut(action);
                });
            }
        } else if (cut.type === "shell") {
            globalShortcut.register(trigger, () => {
                const fn = (cut.linebreak) ? "writelr" : "write";
                window.term[window.currentTerm][fn](action);
            });
        } else {
            console.warn(`${trigger} has unknown type`);
        }
    });
}

// One-shot wiring: clear any stale global-shortcut registrations and
// publish the three `window.*` entrypoints the renderer + the rest of
// the codebase still address by name. Called once from `_renderer.js`.
function init() {
    remote.globalShortcut.unregisterAll();
    window.openShortcutsHelp = openShortcutsHelp;
    window.useAppShortcut = useAppShortcut;
    window.registerKeyboardShortcuts = registerKeyboardShortcuts;
}

const Shortcuts = {
    SHORTCUTS_DEFINITION,
    _shortcutField,
    _renderShortcutsAppList,
    _renderShortcutsCustomList,
    _shortcutsHelpHTML,
    _wireShortcutsAccordions,
    useAppShortcut,
    openShortcutsHelp,
    registerKeyboardShortcuts,
    init
};

module.exports = Shortcuts;
if (typeof window !== "undefined") window.Shortcuts = Shortcuts;
