"use strict";

// Cross-module integrity tests: SCHEMA ↔ defaultSettings(), and
// DEFAULT_SHORTCUTS ↔ SHORTCUTS_DEFINITION. The whole point of
// issue #174 is to make these sources of truth move together, so
// pin the relationship as tests rather than docstrings.

const test = require("node:test");
const assert = require("node:assert/strict");

// Both helpers below pull in shortcuts.class.js which assigns itself
// to `window.Shortcuts` at module load — give it a minimal window.
global.window = global.window ?? {};
global.window._escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

const { SCHEMA, defaultSettings, serializeFromDom } =
    require("../../src/utils/settingsSerializer.js");
const { DEFAULT_SHORTCUTS, MIGRATIONS } =
    require("../../src/utils/shortcutDefaults.js");
const { SHORTCUTS_DEFINITION } =
    require("../../src/classes/shortcuts.class.js");

// ── SCHEMA ↔ defaults integrity ────────────────────────────────

test("defaultSettings() returns a key for every non-preserve SCHEMA entry", () => {
    // The drift this test catches is exactly the bug issue #174 was
    // filed to fix: SCHEMA used to declare env / username / monitor /
    // iface / keepGeometry but `_boot.js`'s defaults didn't include
    // them, so the settings editor rendered `value="undefined"` and
    // the save path dropped them back out.
    const defs = defaultSettings({ platform: "linux", userDataDir: "/tmp" });
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.preserve) continue;
        assert.ok(key in defs, `default missing for SCHEMA key '${key}'`);
    }
});

test("defaultSettings() doesn't include keys SCHEMA doesn't know about", () => {
    const defs = defaultSettings({ platform: "linux", userDataDir: "/tmp" });
    for (const key of Object.keys(defs)) {
        assert.ok(key in SCHEMA, `unexpected default key '${key}'`);
    }
});

test("default values type-match their SCHEMA spec", () => {
    const defs = defaultSettings({ platform: "linux", userDataDir: "/tmp" });
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.preserve) continue;
        const v = defs[key];
        if (spec.type === "number") {
            assert.equal(typeof v, "number", `${key}: expected number, got ${typeof v}`);
            assert.ok(Number.isFinite(v), `${key}: expected finite number`);
        } else if (spec.type === "boolean") {
            assert.equal(typeof v, "boolean", `${key}: expected boolean, got ${typeof v}`);
        } else if (spec.type === "string") {
            assert.equal(typeof v, "string", `${key}: expected string, got ${typeof v}`);
        }
    }
});

test("defaultSettings() round-trips through serializeFromDom unchanged", () => {
    // Stringify each default the same way the editor's <select>
    // elements would (booleans → "true"/"false"; numbers → decimal),
    // hand them to the serializer, and compare. This catches schema-
    // vs-serializer drift in either direction.
    const defs = defaultSettings({ platform: "linux", userDataDir: "/tmp" });
    const fixture = {};
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.preserve) continue;
        const v = defs[key];
        let str;
        if (spec.type === "boolean") str = v ? "true" : "false";
        else str = String(v);
        fixture[spec.input] = str;
    }
    const out = serializeFromDom(id => fixture[id], { forceFullscreen: defs.forceFullscreen });
    assert.deepEqual(out, defs);
});

// ── Platform-aware shell choice ────────────────────────────────

test("defaultSettings(win32) picks powershell.exe", () => {
    const d = defaultSettings({ platform: "win32", userDataDir: "C:\\Users\\x" });
    assert.equal(d.shell, "powershell.exe");
    assert.equal(d.cwd, "C:\\Users\\x");
});

test("defaultSettings(linux/darwin) picks bash", () => {
    for (const platform of ["linux", "darwin", "freebsd"]) {
        const d = defaultSettings({ platform, userDataDir: "/tmp" });
        assert.equal(d.shell, "bash", `expected bash on ${platform}`);
    }
});

test("defaultSettings() tolerates missing env argument", () => {
    // Defensive — covers the case where _boot.js gets refactored
    // and forgets to pass platform/userDataDir.
    const d = defaultSettings();
    assert.equal(typeof d.shell, "string");
    assert.equal(typeof d.cwd, "string");
});

// ── DEFAULT_SHORTCUTS ↔ SHORTCUTS_DEFINITION integrity ─────────

test("every DEFAULT_SHORTCUTS app-action resolves in SHORTCUTS_DEFINITION", () => {
    // Same drift hazard as the settings side: adding a default
    // shortcut without a help-modal description (or vice versa)
    // used to be a silent bug.
    for (const cut of DEFAULT_SHORTCUTS) {
        if (cut.type !== "app") continue;
        // TAB_1..TAB_5 are dispatched individually but the help
        // modal collapses them under TAB_X.
        const lookup = cut.action.startsWith("TAB_") ? "TAB_X" : cut.action;
        assert.ok(
            lookup in SHORTCUTS_DEFINITION,
            `DEFAULT_SHORTCUTS action '${cut.action}' has no SHORTCUTS_DEFINITION entry (looked up as '${lookup}')`
        );
    }
});

test("DEFAULT_SHORTCUTS entries have the required shape", () => {
    for (const cut of DEFAULT_SHORTCUTS) {
        assert.ok(["app", "shell"].includes(cut.type), `unknown type '${cut.type}'`);
        assert.equal(typeof cut.trigger, "string", "trigger must be a string");
        assert.ok(cut.trigger.length > 0, "trigger must not be empty");
        assert.equal(typeof cut.action,  "string", "action must be a string");
        assert.equal(typeof cut.enabled, "boolean", "enabled must be a boolean");
    }
});

// ── MIGRATIONS ─────────────────────────────────────────────────

test("MIGRATIONS backfills CONTROL_MENU when missing", () => {
    const list = [];
    let mutated = false;
    for (const m of MIGRATIONS) {
        if (m.apply(list)) mutated = true;
    }
    assert.equal(mutated, true);
    const cm = list.find(s => s.action === "CONTROL_MENU");
    assert.ok(cm, "CONTROL_MENU entry should be backfilled");
    assert.equal(cm.trigger, "Ctrl+Shift+O");
});

test("MIGRATIONS rewrites legacy Ctrl+Shift+Space CONTROL_MENU trigger", () => {
    const list = [
        { type: "app", trigger: "Ctrl+Shift+Space", action: "CONTROL_MENU", enabled: true }
    ];
    let mutated = false;
    for (const m of MIGRATIONS) {
        if (m.apply(list)) mutated = true;
    }
    assert.equal(mutated, true);
    assert.equal(list[0].trigger, "Ctrl+Shift+O");
});

test("MIGRATIONS is idempotent — re-running on an up-to-date file is a no-op", () => {
    const list = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
    let mutated = false;
    for (const m of MIGRATIONS) {
        if (m.apply(list)) mutated = true;
    }
    assert.equal(mutated, false);
    assert.deepEqual(list, DEFAULT_SHORTCUTS);
});
