"use strict";

// Coverage for src/utils/settingsSerializer.js — the pure module
// that turns settings-editor input values into the object written
// to settings.json. Issue #173.
//
// The schema doubles as a contract: every entry in the production
// settings.json should map to a SCHEMA key. This test pins that.

const test = require("node:test");
const assert = require("node:assert/strict");

const { SCHEMA, serializeFromDom } = require("../../src/utils/settingsSerializer.js");

// Fixture: a getValue stub that maps known input ids to typed
// fixture strings (matching how the renderer's <select> /
// <input> elements return values).
function makeGetValue(overrides = {}) {
    const defaults = {
        "settingsEditor-shell": "/bin/zsh",
        "settingsEditor-shellArgs": "",
        "settingsEditor-cwd": "/home/u",
        "settingsEditor-env": "",
        "settingsEditor-username": "u",
        "settingsEditor-keyboard": "en-US",
        "settingsEditor-theme": "tron",
        "settingsEditor-termFontSize": "15",
        "settingsEditor-audio": "true",
        "settingsEditor-audioVolume": "75",
        "settingsEditor-disableFeedbackAudio": "false",
        "settingsEditor-pingAddr": "1.1.1.1",
        "settingsEditor-clockHours": "24",
        "settingsEditor-port": "3000",
        "settingsEditor-monitor": "0",
        "settingsEditor-nointro": "false",
        "settingsEditor-nocursor": "false",
        "settingsEditor-iface": "",
        "settingsEditor-allowWindowed": "true",
        "settingsEditor-keepGeometry": "true",
        "settingsEditor-excludeThreadsFromToplist": "true",
        "settingsEditor-hideDotfiles": "false",
        "settingsEditor-fsListView": "false",
        "settingsEditor-spawnOnTabCycle": "true",
        "settingsEditor-modalCloseButton": "true",
        "settingsEditor-ttsVoice": "af_heart",
        "settingsEditor-ttsDtype": "q8",
        "settingsEditor-chatBackend": "claude-cli",
        "settingsEditor-gemmaDtype": "q4f16",
        "settingsEditor-experimentalGlobeFeatures": "false",
        "settingsEditor-experimentalFeatures": "false"
    };
    const map = { ...defaults, ...overrides };
    return id => map[id];
}

// ── SCHEMA integrity ─────────────────────────────────────────────

test("SCHEMA entries each declare either input+type or preserve", () => {
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.preserve) {
            assert.equal(spec.input, undefined, `${key}: preserve+input is contradictory`);
            assert.equal(spec.type,  undefined, `${key}: preserve+type is contradictory`);
        } else {
            assert.equal(typeof spec.input, "string", `${key}: missing input id`);
            assert.match(spec.type, /^(string|number|boolean)$/, `${key}: unknown type ${spec.type}`);
        }
    }
});

test("SCHEMA covers every key the current renderer wrote", () => {
    // Hard-coded inventory pulled from the pre-extraction
    // writeSettingsFile body so any future drift is loud.
    const expected = [
        "shell", "shellArgs", "cwd", "env", "username", "keyboard",
        "theme", "termFontSize", "audio", "audioVolume",
        "disableFeedbackAudio", "pingAddr", "clockHours", "port",
        "monitor", "nointro", "nocursor", "iface", "allowWindowed",
        "forceFullscreen", "keepGeometry", "excludeThreadsFromToplist",
        "hideDotfiles", "fsListView", "spawnOnTabCycle",
        "modalCloseButton", "ttsVoice", "ttsDtype", "chatBackend",
        "gemmaDtype", "experimentalGlobeFeatures",
        "experimentalFeatures"
    ];
    assert.deepEqual(Object.keys(SCHEMA).sort(), expected.sort());
});

// ── serializeFromDom type coercion ──────────────────────────────

test("serializeFromDom coerces string values per type", () => {
    const out = serializeFromDom(makeGetValue(), {});
    assert.equal(out.shell, "/bin/zsh");
    assert.equal(out.termFontSize, 15);
    assert.equal(out.audioVolume, 75);
    assert.equal(out.audio, true);
    assert.equal(out.nointro, false);
    assert.equal(out.clockHours, 24);
    assert.equal(out.port, 3000);
});

test("serializeFromDom maps boolean strings exactly: only \"true\" is true", () => {
    const out = serializeFromDom(
        makeGetValue({ "settingsEditor-audio": "false" }),
        {}
    );
    assert.equal(out.audio, false);

    const out2 = serializeFromDom(
        makeGetValue({ "settingsEditor-audio": "yes" }),
        {}
    );
    assert.equal(out2.audio, false, "boolean coercion should be strict 'true' compare");
});

// ── preserve: forceFullscreen ───────────────────────────────────

test("forceFullscreen is copied from the existing settings object", () => {
    const out = serializeFromDom(makeGetValue(), { forceFullscreen: true });
    assert.equal(out.forceFullscreen, true);

    const out2 = serializeFromDom(makeGetValue(), { forceFullscreen: false });
    assert.equal(out2.forceFullscreen, false);
});

test("preserve keys handle a missing existing settings object", () => {
    // Renderer never passes undefined in practice, but the serializer
    // should still produce a defined entry rather than crash.
    const out = serializeFromDom(makeGetValue(), undefined);
    assert.ok("forceFullscreen" in out);
});

// ── "undefined" string filter ───────────────────────────────────

test("string values that come back literally \"undefined\" are dropped", () => {
    const out = serializeFromDom(
        makeGetValue({ "settingsEditor-iface": "undefined" }),
        {}
    );
    assert.equal("iface" in out, false);
    // Other keys with valid values must be unaffected.
    assert.equal(out.shell, "/bin/zsh");
});

test("\"undefined\" is dropped before boolean coercion (not stored as false)", () => {
    // A corrupted <select> on a boolean field used to coerce
    // "undefined" → false, persisting a misleading value. The
    // pre-coercion filter drops the entry entirely so the existing
    // settings.json default wins on next load.
    const out = serializeFromDom(
        makeGetValue({ "settingsEditor-audio": "undefined" }),
        {}
    );
    assert.equal("audio" in out, false);
});

test("\"undefined\" is dropped before number coercion (not stored as NaN)", () => {
    // Same hazard for number fields: Number("undefined") is NaN,
    // and JSON.stringify(NaN) emits `null` — silently corrupting
    // settings.json.
    const out = serializeFromDom(
        makeGetValue({ "settingsEditor-port": "undefined" }),
        {}
    );
    assert.equal("port" in out, false);
});

test("non-finite numeric input is also dropped", () => {
    // Belt-and-braces: if a future input control produces "abc"
    // for a number field, the same safety applies.
    const out = serializeFromDom(
        makeGetValue({ "settingsEditor-port": "abc" }),
        {}
    );
    assert.equal("port" in out, false);
});

test("empty / whitespace-only string on a numeric field is dropped (Number(\"\") === 0 hazard)", () => {
    // `Number("")` and `Number("   ")` both coerce to 0, which
    // would silently persist as a valid setting (port: 0,
    // clockHours: 0, …). The serializer drops blank inputs on
    // numeric fields specifically.
    for (const blank of ["", "   ", "\t"]) {
        const out = serializeFromDom(
            makeGetValue({ "settingsEditor-port": blank }),
            {}
        );
        assert.equal("port" in out, false, `port should be dropped for ${JSON.stringify(blank)}`);
    }
});

test("getValue returning undefined drops every non-preserve key", () => {
    // The renderer hands serializeFromDom an
    // `id => document.getElementById(id)?.value` closure (or its
    // equivalent). If an editor element is missing — say a settings
    // modal that hasn't fully rendered, or a future field that was
    // removed from the HTML but not yet from SCHEMA — the closure
    // returns `undefined`. The serializer must drop those keys
    // rather than persist them as `false` (booleans) or `null`
    // (strings, via JSON.stringify) in settings.json.
    const out = serializeFromDom(() => undefined, { forceFullscreen: true });
    for (const [key, spec] of Object.entries(SCHEMA)) {
        if (spec.preserve) continue;
        assert.equal(key in out, false, `${key} should be dropped when getValue returns undefined`);
    }
    // Preserve keys still come through from `existing`.
    assert.equal(out.forceFullscreen, true);
});

test("empty string on a string field is preserved (e.g. iface: \"\" means auto-detect)", () => {
    // The numeric-blank guard must not affect string fields.
    // netstat.class.js explicitly treats an empty `iface` as
    // "find the first connected interface" — dropping it would
    // change behaviour on machines that have set it back to auto.
    const out = serializeFromDom(
        makeGetValue({ "settingsEditor-iface": "" }),
        {}
    );
    assert.equal(out.iface, "");
});

// ── overall shape ───────────────────────────────────────────────

test("serializeFromDom produces an object with no extra keys", () => {
    const out = serializeFromDom(makeGetValue(), {});
    for (const key of Object.keys(out)) {
        assert.ok(key in SCHEMA, `unexpected key in output: ${key}`);
    }
});
