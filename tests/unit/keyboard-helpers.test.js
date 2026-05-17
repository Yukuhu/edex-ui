"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { Keyboard } = require("../../src/classes/keyboard.class.js");

// A fake Keyboard subject good enough for the helpers that read
// `this.container.dataset` and `this.ctrlseq`. Avoids the real
// constructor's layout-JSON load and DOM-element queries.
function fakeKeyboard(initialDataset = {}) {
    const kb = Object.create(Keyboard.prototype);
    kb.container = { dataset: { ...initialDataset } };
    // ctrlseq[1] is conventionally the ESC byte in the real Keyboard
    // (set from terminal escape sequences). Use \x1B so _normalizeTrigger
    // produces the same string the real code does.
    kb.ctrlseq = ["", "\x1B", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
    return kb;
}

// ---------------------------------------------------------------------
// _normalizeTrigger
// ---------------------------------------------------------------------

test("_normalizeTrigger", async (t) => {
    const kb = fakeKeyboard();

    await t.test("lowercases the trigger", () => {
        assert.equal(kb._normalizeTrigger("A"), "a");
        assert.equal(kb._normalizeTrigger("ABC"), "abc");
    });
    await t.test("'plus' → '+'", () => {
        assert.equal(kb._normalizeTrigger("plus"), "+");
        assert.equal(kb._normalizeTrigger("Plus"), "+");
    });
    await t.test("'space' → ' '", () => {
        assert.equal(kb._normalizeTrigger("space"), " ");
    });
    await t.test("'tab' → '\\t'", () => {
        assert.equal(kb._normalizeTrigger("tab"), "\t");
    });
    await t.test("'backspace' and 'delete' both → '\\b'", () => {
        assert.equal(kb._normalizeTrigger("backspace"), "\b");
        assert.equal(kb._normalizeTrigger("delete"), "\b");
    });
    await t.test("'esc' → ctrlseq[1] (the ESC byte)", () => {
        assert.equal(kb._normalizeTrigger("esc"), "\x1B");
    });
    await t.test("'escape' → ctrlseq[1] (the ESC byte) [regression: #142 alternation-order fix]", () => {
        // Pre-fix: /esc|escape/ matched 'esc' first, leaving 'ape'
        // trailing. After #142 the regex is /escape|esc/.
        assert.equal(kb._normalizeTrigger("escape"), "\x1B");
        // Equivalently: the full string maps to the single ESC byte,
        // NOT to "\x1Bape".
        assert.notEqual(kb._normalizeTrigger("escape"), "\x1Bape");
    });
    await t.test("'return' and 'enter' both → '\\r'", () => {
        assert.equal(kb._normalizeTrigger("return"), "\r");
        assert.equal(kb._normalizeTrigger("enter"), "\r");
    });
    await t.test("unknown tokens pass through (after lowercasing)", () => {
        assert.equal(kb._normalizeTrigger("a"), "a");
        assert.equal(kb._normalizeTrigger("F1"), "f1");
        assert.equal(kb._normalizeTrigger("X"), "x");
    });
});

// ---------------------------------------------------------------------
// _shouldPlayTypingSound
// ---------------------------------------------------------------------

test("_shouldPlayTypingSound", async (t) => {
    const letter = { code: "KeyA", repeat: false };
    const letterRepeating = { code: "KeyA", repeat: true };
    const shift = { code: "ShiftLeft", repeat: false };
    const shiftRepeating = { code: "ShiftLeft", repeat: true };
    const ctrlRepeating = { code: "ControlRight", repeat: true };
    const altRepeating = { code: "AltLeft", repeat: true };
    const capsRepeating = { code: "CapsLock", repeat: true };

    await t.test("returns false when passwordMode is anything other than 'false'", () => {
        for (const mode of ["true", "", undefined]) {
            const kb = fakeKeyboard({ passwordMode: mode });
            assert.equal(kb._shouldPlayTypingSound(letter), false, `passwordMode=${JSON.stringify(mode)}`);
        }
    });
    await t.test("plays for any non-repeat keydown when passwordMode='false'", () => {
        const kb = fakeKeyboard({ passwordMode: "false" });
        assert.equal(kb._shouldPlayTypingSound(letter), true);
        assert.equal(kb._shouldPlayTypingSound(shift), true);
    });
    await t.test("plays for repeating non-modifier keys (autorepeat-while-typing)", () => {
        const kb = fakeKeyboard({ passwordMode: "false" });
        assert.equal(kb._shouldPlayTypingSound(letterRepeating), true);
    });
    await t.test("silent for repeating modifier keys (#516)", () => {
        const kb = fakeKeyboard({ passwordMode: "false" });
        assert.equal(kb._shouldPlayTypingSound(shiftRepeating), false);
        assert.equal(kb._shouldPlayTypingSound(ctrlRepeating), false);
        assert.equal(kb._shouldPlayTypingSound(altRepeating), false);
        assert.equal(kb._shouldPlayTypingSound(capsRepeating), false);
    });
    await t.test("returns false defensively for non-boolean e.repeat values", () => {
        const kb = fakeKeyboard({ passwordMode: "false" });
        for (const r of [undefined, null, 0, 1, "true"]) {
            assert.equal(
                kb._shouldPlayTypingSound({ code: "KeyA", repeat: r }),
                false,
                `repeat=${JSON.stringify(r)}`
            );
        }
    });
});

// ---------------------------------------------------------------------
// _isEnterKey
// ---------------------------------------------------------------------

test("_isEnterKey", async (t) => {
    const kb = fakeKeyboard();
    const fakeKey = (cls) => ({ attributes: { class: { value: cls } } });

    await t.test("true when the class string ends with 'keyboard_enter'", () => {
        assert.equal(kb._isEnterKey(fakeKey("keyboard_key keyboard_enter")), true);
        assert.equal(kb._isEnterKey(fakeKey("keyboard_enter")), true);
    });
    await t.test("false when the class doesn't end with 'keyboard_enter'", () => {
        assert.equal(kb._isEnterKey(fakeKey("keyboard_key")), false);
        assert.equal(kb._isEnterKey(fakeKey("keyboard_key active")), false);
        assert.equal(kb._isEnterKey(fakeKey("")), false);
    });
});

// ---------------------------------------------------------------------
// _currentShortcutCat
// ---------------------------------------------------------------------

test("_currentShortcutCat", async (t) => {
    await t.test("returns empty string with no modifiers held", () => {
        assert.equal(fakeKeyboard()._currentShortcutCat(), "");
    });
    await t.test("returns 'Ctrl' for Ctrl alone", () => {
        assert.equal(fakeKeyboard({ isCtrlOn: "true" })._currentShortcutCat(), "Ctrl");
    });
    await t.test("returns 'Alt' for Alt alone", () => {
        assert.equal(fakeKeyboard({ isAltOn: "true" })._currentShortcutCat(), "Alt");
    });
    await t.test("returns 'Shift' for Shift alone", () => {
        assert.equal(fakeKeyboard({ isShiftOn: "true" })._currentShortcutCat(), "Shift");
    });
    await t.test("concatenates in canonical Ctrl/Alt/Shift order", () => {
        assert.equal(fakeKeyboard({ isCtrlOn: "true", isShiftOn: "true" })._currentShortcutCat(), "CtrlShift");
        assert.equal(fakeKeyboard({ isCtrlOn: "true", isAltOn: "true" })._currentShortcutCat(), "CtrlAlt");
        assert.equal(fakeKeyboard({ isAltOn: "true", isShiftOn: "true" })._currentShortcutCat(), "AltShift");
        assert.equal(fakeKeyboard({ isCtrlOn: "true", isAltOn: "true", isShiftOn: "true" })._currentShortcutCat(), "CtrlAltShift");
    });
    await t.test("treats flag values other than 'true' as off", () => {
        // Important: dataset values come from string-coerced booleans.
        // Anything other than the literal "true" should be ignored.
        assert.equal(fakeKeyboard({ isCtrlOn: "false" })._currentShortcutCat(), "");
        assert.equal(fakeKeyboard({ isCtrlOn: true })._currentShortcutCat(), ""); // boolean true, not string
    });
});

// ---------------------------------------------------------------------
// _applyModifierCmd
// ---------------------------------------------------------------------

test("_applyModifierCmd", async (t) => {
    const key = (extra) => ({ dataset: { cmd: "a", ...extra } });

    await t.test("returns the input cmd unchanged with no modifiers held", () => {
        const kb = fakeKeyboard();
        assert.equal(kb._applyModifierCmd(key({ shift_cmd: "A" }), "a"), "a");
    });
    await t.test("Shift swaps to shift_cmd when present", () => {
        const kb = fakeKeyboard({ isShiftOn: "true" });
        assert.equal(kb._applyModifierCmd(key({ shift_cmd: "A" }), "a"), "A");
    });
    await t.test("CapsLock swaps to shift_cmd (acts like Shift for letters)", () => {
        const kb = fakeKeyboard({ isCapsLckOn: "true" });
        assert.equal(kb._applyModifierCmd(key({ shift_cmd: "A" }), "a"), "A");
    });
    await t.test("CapsLock also swaps to capslck_cmd when present (overrides shift_cmd)", () => {
        const kb = fakeKeyboard({ isCapsLckOn: "true" });
        assert.equal(kb._applyModifierCmd(key({ shift_cmd: "A", capslck_cmd: "AA" }), "a"), "AA");
    });
    await t.test("Ctrl swaps to ctrl_cmd when present", () => {
        const kb = fakeKeyboard({ isCtrlOn: "true" });
        assert.equal(kb._applyModifierCmd(key({ ctrl_cmd: "\x01" }), "a"), "\x01");
    });
    await t.test("Alt swaps to alt_cmd when present", () => {
        const kb = fakeKeyboard({ isAltOn: "true" });
        assert.equal(kb._applyModifierCmd(key({ alt_cmd: "à" }), "a"), "à");
    });
    await t.test("Alt+Shift overrides with altshift_cmd (highest precedence in the chain)", () => {
        const kb = fakeKeyboard({ isAltOn: "true", isShiftOn: "true" });
        assert.equal(
            kb._applyModifierCmd(key({ shift_cmd: "A", alt_cmd: "à", altshift_cmd: "À" }), "a"),
            "À"
        );
    });
    await t.test("Fn swaps to fn_cmd when present", () => {
        const kb = fakeKeyboard({ isFnOn: "true" });
        assert.equal(kb._applyModifierCmd(key({ fn_cmd: "F1" }), "a"), "F1");
    });
    await t.test("ignores modifier flags when the key has no matching dataset attr", () => {
        // Shift held but the key doesn't have shift_cmd defined → no swap.
        const kb = fakeKeyboard({ isShiftOn: "true" });
        assert.equal(kb._applyModifierCmd(key({}), "a"), "a");
    });
});

// ---------------------------------------------------------------------
// _applyPendingDeadKey
// ---------------------------------------------------------------------

test("_applyPendingDeadKey", async (t) => {
    await t.test("returns cmd unchanged when no dead-key flag is set", () => {
        const kb = fakeKeyboard();
        assert.equal(kb._applyPendingDeadKey("a"), "a");
        assert.equal(kb.container.dataset.isNextCircum, undefined);
    });
    await t.test("applies the matching transform and clears the flag", () => {
        const kb = fakeKeyboard({ isNextCircum: "true" });
        assert.equal(kb._applyPendingDeadKey("a"), "â");
        assert.equal(kb.container.dataset.isNextCircum, "false");
    });
    await t.test("clears EVERY dead-key flag after applying (sticky-cedilla regression)", () => {
        // The pre-existing cedilla typo (fixed in #142) left
        // `isNextCedilla` stuck at "true" after applying. The
        // table-driven loop now uniformly resets every flag.
        const kb = fakeKeyboard({ isNextCedilla: "true" });
        assert.equal(kb._applyPendingDeadKey("c"), "ç");
        assert.equal(kb.container.dataset.isNextCedilla, "false");
    });
    await t.test("dispatches to Greek via toGreek (no addGreek method)", () => {
        const kb = fakeKeyboard({ isNextGreek: "true" });
        assert.equal(kb._applyPendingDeadKey("a"), "α");        // #148: lower-a → lower alpha
        assert.equal(kb.container.dataset.isNextGreek, "false");

        const kb2 = fakeKeyboard({ isNextGreek: "true" });
        assert.equal(kb2._applyPendingDeadKey("A"), "Α");       // #148: upper-A → upper alpha (was lowercase α)
        assert.equal(kb2.container.dataset.isNextGreek, "false");

        const kb3 = fakeKeyboard({ isNextGreek: "true" });
        assert.equal(kb3._applyPendingDeadKey("b"), "β");
        assert.equal(kb3.container.dataset.isNextGreek, "false");
    });
    await t.test("when multiple flags are set, every match applies in DEAD_KEY_TRANSFORMS order", () => {
        // Pin the order: if both Circum AND Acute are set, the loop
        // applies Circum first (its position in the list), then Acute
        // attempts to map the already-circum'd char. ACUTE_MAP doesn't
        // know about â, so it falls through. Both flags clear.
        const kb = fakeKeyboard({ isNextCircum: "true", isNextAcute: "true" });
        assert.equal(kb._applyPendingDeadKey("a"), "â");
        assert.equal(kb.container.dataset.isNextCircum, "false");
        assert.equal(kb.container.dataset.isNextAcute, "false");
    });
});

// ---------------------------------------------------------------------
// _tryHandleEscapedCommand
// ---------------------------------------------------------------------

test("_tryHandleEscapedCommand", async (t) => {
    await t.test("returns false for an unknown cmd, doesn't touch the dataset", () => {
        const kb = fakeKeyboard();
        const before = { ...kb.container.dataset };
        assert.equal(kb._tryHandleEscapedCommand("UNKNOWN"), false);
        assert.deepEqual(kb.container.dataset, before);
    });
    await t.test("returns true for 'CAPSLCK: ON' and flips isCapsLckOn", () => {
        const kb = fakeKeyboard();
        assert.equal(kb._tryHandleEscapedCommand("CAPSLCK: ON"), true);
        assert.equal(kb.container.dataset.isCapsLckOn, "true");
    });
    await t.test("returns true for 'CAPSLCK: OFF' and clears isCapsLckOn", () => {
        const kb = fakeKeyboard({ isCapsLckOn: "true" });
        assert.equal(kb._tryHandleEscapedCommand("CAPSLCK: OFF"), true);
        assert.equal(kb.container.dataset.isCapsLckOn, "false");
    });
    await t.test("returns true for 'CIRCUM' and sets isNextCircum='true'", () => {
        const kb = fakeKeyboard();
        assert.equal(kb._tryHandleEscapedCommand("CIRCUM"), true);
        assert.equal(kb.container.dataset.isNextCircum, "true");
    });
    await t.test("every entry in ESCAPED_CMD_HANDLERS round-trips", () => {
        for (const [cmd, h] of Object.entries(Keyboard.ESCAPED_CMD_HANDLERS)) {
            const kb = fakeKeyboard();
            assert.equal(kb._tryHandleEscapedCommand(cmd), true, `cmd ${cmd}`);
            assert.equal(kb.container.dataset[h.flag], h.value, `cmd ${cmd} → ${h.flag}`);
        }
    });
});
