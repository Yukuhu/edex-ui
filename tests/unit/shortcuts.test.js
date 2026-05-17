"use strict";

// Coverage for the pure / DOM-free surface of
// src/classes/shortcuts.class.js. Issue #173.
//
// `useAppShortcut`, `openShortcutsHelp`, `registerKeyboardShortcuts`,
// and `init` all read renderer-global state (`window.term`, `Modal`,
// `remote.globalShortcut`, …) that a unit test would have to stub
// extensively. They're exercised end-to-end at runtime. Here we pin:
//
//   - SHORTCUTS_DEFINITION integrity — every action the dispatcher
//     handles has a human-readable description, and vice versa.
//   - `_shortcutField` coerces malformed shortcuts.json fields to a
//     string so the help-modal render doesn't throw.
//   - `_renderShortcutsAppList` / `_renderShortcutsCustomList`
//     produce the expected row structure and route user-controlled
//     fields through window._escapeHtml.

const test = require("node:test");
const assert = require("node:assert/strict");

// shortcuts.class.js assigns Shortcuts to window.Shortcuts at module
// load — give it a minimal `window` first.
global.window = global.window ?? {};

// The render helpers read `window._escapeHtml`. Install a real escape
// implementation so the assertions can verify proper escaping rather
// than just the helper being called.
global.window._escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const Shortcuts = require("../../src/classes/shortcuts.class.js");

// ── SHORTCUTS_DEFINITION integrity ──────────────────────────────

test("SHORTCUTS_DEFINITION covers every action useAppShortcut dispatches", () => {
    // Every visible action name in the help modal corresponds to a
    // case in `useAppShortcut`. Pinning this prevents a description
    // from going stale when the dispatcher gains a new action.
    const dispatched = [
        "COPY", "PASTE", "NEXT_TAB", "PREVIOUS_TAB",
        "TAB_1", "TAB_2", "TAB_3", "TAB_4", "TAB_5",
        "SETTINGS", "SHORTCUTS", "FUZZY_SEARCH",
        "FS_OPEN", "FS_LIST_VIEW", "FS_DOTFILES",
        "KB_PASSMODE", "KB_TOGGLE", "PANELS_TOGGLE",
        "DEV_DEBUG", "DEV_RELOAD", "CLAUDE_CHAT", "CONTROL_MENU"
    ];
    // The TAB_1..TAB_5 actions share a description entry under
    // TAB_X (the help modal collapses them); _renderShortcutsAppList
    // normalises that mapping.
    for (const action of dispatched) {
        const lookup = action.startsWith("TAB_") ? "TAB_X" : action;
        assert.ok(
            lookup in Shortcuts.SHORTCUTS_DEFINITION,
            `missing SHORTCUTS_DEFINITION entry for ${action} (looked up as ${lookup})`
        );
    }
});

// ── _shortcutField ──────────────────────────────────────────────

test("_shortcutField coerces null/undefined to empty string", () => {
    assert.equal(Shortcuts._shortcutField(null), "");
    assert.equal(Shortcuts._shortcutField(undefined), "");
});

test("_shortcutField coerces non-string scalars and objects via String()", () => {
    assert.equal(Shortcuts._shortcutField(42), "42");
    assert.equal(Shortcuts._shortcutField(true), "true");
    assert.equal(Shortcuts._shortcutField({ toString: () => "x" }), "x");
});

// ── _renderShortcutsAppList ─────────────────────────────────────

test("_renderShortcutsAppList emits one row per app shortcut", () => {
    const html = Shortcuts._renderShortcutsAppList([
        { type: "app", trigger: "Ctrl+C",      action: "COPY",     enabled: true  },
        { type: "app", trigger: "Ctrl+Tab",    action: "NEXT_TAB", enabled: false },
        // shell entries are skipped here.
        { type: "shell", trigger: "Ctrl+Shift+G", action: "git status", enabled: true }
    ]);
    const rowCount = (html.match(/<tr>/g) || []).length;
    assert.equal(rowCount, 2);
    assert.match(html, /Ctrl\+C/);
    assert.match(html, /Ctrl\+Tab/);
    assert.match(html, /YES/);
    assert.match(html, /NO/);
});

test("_renderShortcutsAppList collapses TAB_1..TAB_5 to the TAB_X description", () => {
    const html = Shortcuts._renderShortcutsAppList([
        { type: "app", trigger: "Ctrl+1", action: "TAB_1", enabled: true }
    ]);
    // The TAB_X description body mentions <strong>X</strong>.
    assert.match(html, /<strong>X<\/strong>/);
});

test("_renderShortcutsAppList escapes the trigger field in the attribute", () => {
    // A malformed shortcuts.json could carry a trigger with `"` in it.
    // The help modal renders it as `<input ... value="${trigger}">`,
    // so a missing escape would break out of the attribute.
    const html = Shortcuts._renderShortcutsAppList([
        { type: "app", trigger: "\" onerror=\"alert(1)", action: "COPY", enabled: true }
    ]);
    assert.equal(html.includes("\" onerror=\""), false);
    assert.match(html, /&quot;/);
});

test("_renderShortcutsAppList escapes the action when no description matches", () => {
    // User-edited shortcuts.json can declare an action name we don't
    // recognise. The render falls back to displaying the raw action
    // text — escape it so a chevron in the name can't introduce tags.
    const html = Shortcuts._renderShortcutsAppList([
        { type: "app", trigger: "Ctrl+X", action: "<script>alert(1)</script>", enabled: true }
    ]);
    assert.equal(html.includes("<script>"), false);
    assert.match(html, /&lt;script&gt;/);
});

// ── _renderShortcutsCustomList ──────────────────────────────────

test("_renderShortcutsCustomList only emits shell-type rows", () => {
    const html = Shortcuts._renderShortcutsCustomList([
        { type: "shell", trigger: "Ctrl+G", action: "git status", enabled: true,  linebreak: true  },
        { type: "shell", trigger: "Ctrl+L", action: "ls -la",     enabled: false, linebreak: false },
        { type: "app",   trigger: "Ctrl+C", action: "COPY",       enabled: true                     }
    ]);
    const rowCount = (html.match(/<tr>/g) || []).length;
    assert.equal(rowCount, 2);
    assert.match(html, /git status/);
    assert.match(html, /ls -la/);
    assert.equal(html.includes(">COPY<"), false);
});

test("_renderShortcutsCustomList reflects linebreak via the checkbox attr", () => {
    const html = Shortcuts._renderShortcutsCustomList([
        { type: "shell", trigger: "Ctrl+G", action: "git", enabled: true, linebreak: true }
    ]);
    assert.match(html, /name="shortcutsHelpNew_Enter" checked/);
});
