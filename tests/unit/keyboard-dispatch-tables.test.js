"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { Keyboard } = require("../../src/classes/keyboard.class.js");

// ---------------------------------------------------------------------
// KEY_CODE_TO_DATA_CMD  (physical-key event.code → on-screen data-cmd)
// ---------------------------------------------------------------------

test("KEY_CODE_TO_DATA_CMD is well-formed", async (t) => {
    const M = Keyboard.KEY_CODE_TO_DATA_CMD;

    await t.test("exists as a non-empty object", () => {
        assert.ok(M && typeof M === "object");
        assert.ok(Object.keys(M).length > 0);
    });

    await t.test("every value is a string (possibly the empty string)", () => {
        // Escape's data-cmd is the single ESC byte, which is non-empty
        // but a single character; we don't require length > 0 because
        // the layout JSON might legitimately use empty cmd values.
        for (const [k, v] of Object.entries(M)) {
            assert.equal(typeof v, "string", `${k} → ${JSON.stringify(v)}`);
        }
    });

    await t.test("no Enter entry — Enter is special-cased in findKey via querySelectorAll", () => {
        assert.equal(M.Enter, undefined);
    });

    await t.test("modifier-key codes map to ESCAPED|-- selector values", () => {
        assert.equal(M.ShiftLeft,    "ESCAPED|-- SHIFT: LEFT");
        assert.equal(M.ShiftRight,   "ESCAPED|-- SHIFT: RIGHT");
        assert.equal(M.ControlLeft,  "ESCAPED|-- CTRL: LEFT");
        assert.equal(M.ControlRight, "ESCAPED|-- CTRL: RIGHT");
        assert.equal(M.AltLeft,      "ESCAPED|-- FN: ON");
        assert.equal(M.AltRight,     "ESCAPED|-- ALT: RIGHT");
        assert.equal(M.CapsLock,     "ESCAPED|-- CAPSLCK: ON");
    });

    await t.test("Escape + Backspace map to single-byte control characters", () => {
        // The on-screen layout JSON uses raw bytes for these. Pre-fork
        // source had them inline as invisible chars; #135/#136 made
        // them visible via \x escapes. Pin the byte values.
        assert.equal(M.Escape,    "\x1B");
        assert.equal(M.Backspace, "\x08");
    });

    await t.test("Arrow keys map to ESC + O + direction byte sequences", () => {
        assert.equal(M.ArrowUp,    "\x1BOA");
        assert.equal(M.ArrowLeft,  "\x1BOD");
        assert.equal(M.ArrowDown,  "\x1BOB");
        assert.equal(M.ArrowRight, "\x1BOC");
    });
});

// ---------------------------------------------------------------------
// DEAD_KEY_TRANSFORMS  (sequential apply list, table-driven dispatch)
// ---------------------------------------------------------------------

test("DEAD_KEY_TRANSFORMS is well-formed", async (t) => {
    const arr = Keyboard.DEAD_KEY_TRANSFORMS;

    await t.test("is an array of exactly 13 entries", () => {
        assert.ok(Array.isArray(arr));
        assert.equal(arr.length, 13);
    });

    await t.test("every entry has a `flag` starting with 'isNext'", () => {
        for (const t of arr) {
            assert.equal(typeof t.flag, "string");
            assert.ok(t.flag.startsWith("isNext"), `flag ${JSON.stringify(t.flag)}`);
        }
    });

    await t.test("every entry's `method` is callable on Keyboard.prototype", () => {
        for (const t of arr) {
            assert.equal(typeof t.method, "string");
            assert.equal(
                typeof Keyboard.prototype[t.method],
                "function",
                `Keyboard.prototype.${t.method} should be a function`
            );
        }
    });

    await t.test("flag names are unique (no duplicate dispatch entries)", () => {
        const flags = arr.map(t => t.flag);
        assert.equal(new Set(flags).size, flags.length);
    });

    await t.test("method names are unique (no two flags dispatch to the same transform)", () => {
        const methods = arr.map(t => t.method);
        assert.equal(new Set(methods).size, methods.length);
    });

    await t.test("covers every published dead-key dispatch", () => {
        const expected = new Set([
            "isNextCircum", "isNextTrema", "isNextAcute", "isNextGrave",
            "isNextCaron", "isNextBar", "isNextBreve", "isNextTilde",
            "isNextMacron", "isNextCedilla", "isNextOverring",
            "isNextGreek", "isNextIotasub"
        ]);
        const actual = new Set(arr.map(t => t.flag));
        assert.deepEqual(actual, expected);
    });
});

// ---------------------------------------------------------------------
// ESCAPED_CMD_HANDLERS  (escaped-cmd → dataset-flag mutation)
// ---------------------------------------------------------------------

test("ESCAPED_CMD_HANDLERS is well-formed", async (t) => {
    const M = Keyboard.ESCAPED_CMD_HANDLERS;

    await t.test("exists as a non-empty object", () => {
        assert.ok(M && typeof M === "object");
        assert.ok(Object.keys(M).length > 0);
    });

    await t.test("every handler has a string `flag` and a string `value`", () => {
        for (const [cmd, h] of Object.entries(M)) {
            assert.equal(typeof h.flag, "string", `${cmd}.flag`);
            assert.equal(typeof h.value, "string", `${cmd}.value`);
        }
    });

    await t.test("every handler's `value` is either 'true' or 'false'", () => {
        for (const [cmd, h] of Object.entries(M)) {
            assert.ok(
                h.value === "true" || h.value === "false",
                `${cmd} value ${JSON.stringify(h.value)}`
            );
        }
    });

    await t.test("CAPSLCK and FN have both ON and OFF entries", () => {
        assert.equal(M["CAPSLCK: ON"].flag, "isCapsLckOn");
        assert.equal(M["CAPSLCK: ON"].value, "true");
        assert.equal(M["CAPSLCK: OFF"].flag, "isCapsLckOn");
        assert.equal(M["CAPSLCK: OFF"].value, "false");
        assert.equal(M["FN: ON"].flag, "isFnOn");
        assert.equal(M["FN: ON"].value, "true");
        assert.equal(M["FN: OFF"].flag, "isFnOn");
        assert.equal(M["FN: OFF"].value, "false");
    });

    await t.test("each dead-key flag in DEAD_KEY_TRANSFORMS has a matching escaped cmd setting it to 'true'", () => {
        // CIRCUM, TREMA, ACUTE, GRAVE, CARON, BAR, BREVE, TILDE,
        // MACRON, CEDILLA, OVERRING, GREEK, IOTASUB
        for (const t of Keyboard.DEAD_KEY_TRANSFORMS) {
            // strip the "isNext" prefix and uppercase
            const cmd = t.flag.slice("isNext".length).toUpperCase();
            assert.ok(cmd in M, `escaped cmd ${cmd} is missing`);
            assert.equal(M[cmd].flag, t.flag);
            assert.equal(M[cmd].value, "true");
        }
    });
});
