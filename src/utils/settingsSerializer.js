"use strict";

// Settings shape + serializer. Pure module — no DOM, no electron, no
// file I/O — so the unit suite can exercise the schema and the
// `value → settings.json` mapping without booting the renderer.
//
// Issue #173 (extract from _renderer.js). Issue #174 will move the
// bootstrap defaults in _boot.js to consume this same SCHEMA so adding
// a new setting becomes a one-file change.

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
function serializeFromDom(getValue, existing) {
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

module.exports = { SCHEMA, serializeFromDom };
