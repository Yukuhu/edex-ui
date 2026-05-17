"use strict";
// @ts-check

// Settings shape, defaults, and serializer. Pure module — no DOM, no
// electron, no file I/O — so the unit suite can exercise the schema
// and the `value → settings.json` mapping without booting the
// renderer.
//
// Both the renderer (settings-editor save path) and `_boot.js`
// (first-launch template) require this module. Adding a new setting
// is now a one-file change:
//   1. add the key to `SCHEMA` with its editor input id and type,
//   2. add a default in `defaultSettings()` below,
//   3. add the editor input to the settings modal in `_renderer.js`.
//
// Issue #173 extracted SCHEMA + serializeFromDom from `_renderer.js`.
// Issue #174 folds the `_boot.js` first-launch defaults into this
// same module.

// SCHEMA: one entry per persisted settings key.
//
// - `input`  → id of the corresponding <input>/<select> in the settings
//              editor modal. The renderer reads `.value` from the
//              element and hands it to `serializeFromDom` below.
// - `type`   → "string" | "number" | "boolean". The boolean form
//              expects `.value === "true"` (the settings-editor
//              <select> elements emit "true" / "false" strings).
// - `preserve: true` → not present in the editor form. The serializer
//              copies the value from the previous settings object so
//              callers don't have to special-case it. Currently only
//              `forceFullscreen` uses this — it's editable from the
//              control menu, not the settings editor.
const SCHEMA = {
    shell:                     { input: "settingsEditor-shell",                     type: "string"  },
    shellArgs:                 { input: "settingsEditor-shellArgs",                 type: "string"  },
    cwd:                       { input: "settingsEditor-cwd",                       type: "string"  },
    env:                       { input: "settingsEditor-env",                       type: "string"  },
    username:                  { input: "settingsEditor-username",                  type: "string"  },
    keyboard:                  { input: "settingsEditor-keyboard",                  type: "string"  },
    theme:                     { input: "settingsEditor-theme",                     type: "string"  },
    termFontSize:              { input: "settingsEditor-termFontSize",              type: "number"  },
    audio:                     { input: "settingsEditor-audio",                     type: "boolean" },
    audioVolume:               { input: "settingsEditor-audioVolume",               type: "number"  },
    disableFeedbackAudio:      { input: "settingsEditor-disableFeedbackAudio",      type: "boolean" },
    pingAddr:                  { input: "settingsEditor-pingAddr",                  type: "string"  },
    clockHours:                { input: "settingsEditor-clockHours",                type: "number"  },
    port:                      { input: "settingsEditor-port",                      type: "number"  },
    monitor:                   { input: "settingsEditor-monitor",                   type: "number"  },
    nointro:                   { input: "settingsEditor-nointro",                   type: "boolean" },
    nocursor:                  { input: "settingsEditor-nocursor",                  type: "boolean" },
    iface:                     { input: "settingsEditor-iface",                     type: "string"  },
    allowWindowed:             { input: "settingsEditor-allowWindowed",             type: "boolean" },
    forceFullscreen:           { preserve: true                                                     },
    keepGeometry:              { input: "settingsEditor-keepGeometry",              type: "boolean" },
    excludeThreadsFromToplist: { input: "settingsEditor-excludeThreadsFromToplist", type: "boolean" },
    hideDotfiles:              { input: "settingsEditor-hideDotfiles",              type: "boolean" },
    fsListView:                { input: "settingsEditor-fsListView",                type: "boolean" },
    spawnOnTabCycle:           { input: "settingsEditor-spawnOnTabCycle",           type: "boolean" },
    modalCloseButton:          { input: "settingsEditor-modalCloseButton",          type: "boolean" },
    ttsVoice:                  { input: "settingsEditor-ttsVoice",                  type: "string"  },
    ttsDtype:                  { input: "settingsEditor-ttsDtype",                  type: "string"  },
    chatBackend:               { input: "settingsEditor-chatBackend",               type: "string"  },
    gemmaDtype:                { input: "settingsEditor-gemmaDtype",                type: "string"  },
    experimentalGlobeFeatures: { input: "settingsEditor-experimentalGlobeFeatures", type: "boolean" },
    experimentalFeatures:      { input: "settingsEditor-experimentalFeatures",      type: "boolean" }
};

// Build a settings object from form input values.
//
// `getValue(inputId)` → string. Pass any reader: the renderer hands a
// `id => document.getElementById(id)?.value` closure; tests pass a
// fixture-backed lookup.
//
// `existing` is the previous settings object — used to copy through
// `preserve: true` keys (currently just `forceFullscreen`).
//
// Values that come back literally `"undefined"` (the corrupted-select
// fallback — a <select> whose options don't match the current value
// returns the string "undefined" from `.value`) are dropped from the
// result. The check fires **before** type coercion so a number field
// reading "undefined" doesn't slip through as NaN, and a boolean
// field doesn't slip through as `false`.
/**
 * @param {(inputId: string) => string | null | undefined} getValue
 * @param {Record<string, unknown>} [existing]
 * @returns {Record<string, unknown>}
 */
function serializeFromDom(getValue, existing) {
    /** @type {Record<string, unknown>} */
    const out = {};
    const prev = existing || {};
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.preserve) {
            out[key] = prev[key];
            continue;
        }
        const raw = getValue(spec.input);
        // `raw == null` catches both `undefined` (missing DOM
        // element under the optional-chaining contract
        // `getElementById(id)?.value`) and the literal `null`. The
        // string `"undefined"` is the corrupted-<select> fallback
        // documented above. Either way, skip — don't let boolean
        // coercion produce `false` or string assignment persist
        // `null` in settings.json.
        if (raw == null || raw === "undefined") continue;
        switch (spec.type) {
            case "number": {
                // `Number("")` and `Number("   ")` both coerce to 0,
                // which would silently persist as a valid setting
                // (`port: 0`, `clockHours: 0`, …). Drop whitespace-
                // only inputs before coercion. String fields are
                // not affected — an empty `iface` legitimately means
                // "auto-detect" in netstat.class.js.
                if (typeof raw === "string" && raw.trim() === "") continue;
                const num = Number(raw);
                if (!Number.isFinite(num)) continue;
                out[key] = num;
                break;
            }
            case "boolean":
                out[key] = raw === "true";
                break;
            default:
                out[key] = raw;
        }
    }
    return out;
}

// Return the object `_boot.js` writes to settings.json on first
// launch. The two platform-dependent fields (`shell` and `cwd`) are
// pulled from the `env` argument so the function stays free of
// electron / process imports and is unit-testable.
//
// `env.platform`     — e.g. `process.platform` ("win32"/"darwin"/…)
// `env.userDataDir`  — e.g. `electron.app.getPath("userData")`
//
// Every key in SCHEMA (except `preserve: true` keys) is included.
// Drift between SCHEMA and these defaults used to be a real bug: the
// settings editor exposed inputs for `env` / `username` / `monitor` /
// `iface` / `keepGeometry` which never had bootstrap defaults, so the
// editor rendered them as `value="undefined"` and the save path
// silently dropped them. Adding a SCHEMA entry without a default
// here now fails the cross-module integrity test in
// `tests/unit/settingsSerializer.test.js`.
function defaultSettings(env) {
    const platform = (env && env.platform) || "linux";
    const userDataDir = (env && env.userDataDir) || "";
    return {
        shell:                     platform === "win32" ? "powershell.exe" : "bash",
        shellArgs:                 "",
        cwd:                       userDataDir,
        // Empty string means "no env overrides" — the PTY-spawn path
        // in _boot.js passes this straight to node-pty's options.env.
        env:                       "",
        // Empty string means "fall back to the OS username" — the
        // renderer reads `settings.username || null` (see
        // getDisplayName).
        username:                  "",
        keyboard:                  "en-US",
        theme:                     "tron",
        termFontSize:              15,
        audio:                     true,
        audioVolume:               1.0,
        disableFeedbackAudio:      false,
        pingAddr:                  "1.1.1.1",
        clockHours:                24,
        port:                      3000,
        // 0 is the primary display — same outcome as the
        // `!isNaN(settings.monitor)` guard in _boot.js's window
        // setup, which falls through to `getPrimaryDisplay()`
        // when the index is invalid.
        monitor:                   0,
        nointro:                   false,
        nocursor:                  false,
        // Empty string means "auto-detect the first connected
        // interface" — the renderer's netstat.class.js typechecks
        // `typeof settings.iface === "string"` and falls through
        // to auto-detect when the lookup fails.
        iface:                     "",
        allowWindowed:             false,
        forceFullscreen:           true,
        // The renderer's check is `=== false`, so `true` and a
        // missing value behaved identically pre-#174. Pinning to
        // `true` keeps that behaviour for new users and makes
        // the setting visible in settings.json from day one.
        keepGeometry:              true,
        excludeThreadsFromToplist: true,
        hideDotfiles:              false,
        fsListView:                false,
        spawnOnTabCycle:           true,
        modalCloseButton:          true,
        ttsVoice:                  "af_heart",
        ttsDtype:                  "q8",
        chatBackend:               "claude-cli",
        gemmaDtype:                "q4f16",
        experimentalGlobeFeatures: false,
        experimentalFeatures:      false
    };
}

module.exports = { SCHEMA, serializeFromDom, defaultSettings };
