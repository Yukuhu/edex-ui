"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");
const { mockTerminal } = require("../helpers/mockTerminal.js");

const { Keyboard } = require("../../src/classes/keyboard.class.js");

// Build a fake Keyboard wired to:
//   - a real jsdom-backed `container` div (so dataset reads/writes
//     hit the real DOMTokenList / DOMStringMap surfaces)
//   - a mock terminal at window.term[0]
//   - a stubbed `window.useAppShortcut` capturing called actions
function makeKeyboard({ shortcuts = {}, linkedToTerm = true } = {}) {
    const kb = Object.create(Keyboard.prototype);
    kb.container = document.createElement("div");
    document.body.appendChild(kb.container);
    kb.ctrlseq = ["", "\x1B", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
    kb._shortcuts = {
        Ctrl: [], Alt: [], Shift: [], CtrlShift: [],
        CtrlAlt: [], AltShift: [], CtrlAltShift: [],
        ...shortcuts
    };

    // window plumbing pressKey reaches for.
    const term = mockTerminal();
    window.term = [term];
    window.currentTerm = 0;
    window.keyboard = { linkedToTerm };
    window.useAppShortcut = (action) => {
        window.useAppShortcut.calls = window.useAppShortcut.calls || [];
        window.useAppShortcut.calls.push(action);
    };
    return { kb, term };
}

// Helper: build a fake on-screen key element with a populated dataset.
function fakeKeyElement(dataset = {}) {
    const el = document.createElement("div");
    for (const [k, v] of Object.entries(dataset)) el.dataset[k] = v;
    return el;
}

// ---------------------------------------------------------------------
// Plain cmd write paths
// ---------------------------------------------------------------------

test("pressKey: plain letter routes to terminal.write when linkedToTerm", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    const key = fakeKeyElement({ cmd: "a" });
    kb.pressKey(key);
    assert.deepEqual(term.calls, [{ method: "write", arg: "a" }]);
});

test("pressKey: newline routes to terminal.writelr('') when linkedToTerm", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    kb.pressKey(fakeKeyElement({ cmd: "\n" }));
    assert.deepEqual(term.calls, [{ method: "writelr", arg: "" }]);
});

test("pressKey: newline dispatches a 'change' CustomEvent on activeElement when NOT linkedToTerm", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard({ linkedToTerm: false });

    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();
    const events = [];
    input.addEventListener("change", (e) => events.push({ type: e.type, detail: e.detail }));

    kb.pressKey(fakeKeyElement({ cmd: "\n" }));

    // Should hit the activeElement change-dispatch path, NOT the terminal.
    assert.equal(term.calls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "change");
    assert.equal(events[0].detail, "enter");
});

// ---------------------------------------------------------------------
// Shortcut dispatch
// ---------------------------------------------------------------------

// Note on shortcut shape: the Keyboard constructor splits a configured
// shortcut's trigger on "+" and keeps only the LAST segment in
// _shortcuts[cat] (the modifier prefix becomes the bucket key, the
// trigger becomes just the final keystroke). So a "Ctrl+Shift+A"
// shortcut lives at _shortcuts.CtrlShift with trigger "A" — that's
// what the test bucket needs to mimic.

test("pressKey: app-type shortcut calls useAppShortcut and short-circuits write", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard({
        shortcuts: { CtrlShift: [{ enabled: true, trigger: "A", type: "app", action: "CLAUDE_CHAT" }] }
    });
    kb.container.dataset.isCtrlOn = "true";
    kb.container.dataset.isShiftOn = "true";

    kb.pressKey(fakeKeyElement({ cmd: "a" }));

    assert.deepEqual(window.useAppShortcut.calls, ["CLAUDE_CHAT"]);
    // App shortcut short-circuits — the underlying cmd is NOT written.
    assert.equal(term.calls.length, 0);
});

test("pressKey: shell-type shortcut writes to terminal and ALSO falls through to write the cmd", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard({
        shortcuts: { CtrlShift: [{ enabled: true, trigger: "L", type: "shell", action: "ls -la", linebreak: true }] }
    });
    kb.container.dataset.isCtrlOn = "true";
    kb.container.dataset.isShiftOn = "true";

    kb.pressKey(fakeKeyElement({ cmd: "l" }));

    // Shell shortcut fires the command (with linebreak → writelr).
    assert.ok(term.calls.some(c => c.method === "writelr" && c.arg === "ls -la"));
    // It does NOT short-circuit, so the underlying cmd is also written.
    assert.ok(term.calls.some(c => c.method === "write" && c.arg === "l"));
});

test("pressKey: disabled shortcuts are ignored", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({
        shortcuts: { CtrlShift: [{ enabled: false, trigger: "A", type: "app", action: "SHOULD_NOT_FIRE" }] }
    });
    kb.container.dataset.isCtrlOn = "true";
    kb.container.dataset.isShiftOn = "true";

    kb.pressKey(fakeKeyElement({ cmd: "a" }));

    // useAppShortcut.calls is undefined or empty.
    assert.ok(!window.useAppShortcut.calls || window.useAppShortcut.calls.length === 0);
});

test("pressKey: no modifiers held → no shortcut lookup happens", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard({
        // The Ctrl bucket has a matching shortcut, but with no
        // modifiers held the cat is "" and the `cat.length <= 1`
        // guard short-circuits before the lookup. So a plain "a"
        // press just writes "a", regardless of what's in the bucket.
        shortcuts: { Ctrl: [{ enabled: true, trigger: "A", type: "app", action: "SHOULD_NOT_FIRE" }] }
    });
    // No modifier flags set on the container.
    kb.pressKey(fakeKeyElement({ cmd: "a" }));

    assert.ok(!window.useAppShortcut.calls || window.useAppShortcut.calls.length === 0);
    assert.deepEqual(term.calls, [{ method: "write", arg: "a" }]);
});

// ---------------------------------------------------------------------
// Modifier cmd swap (round-trip through the full pressKey path)
// ---------------------------------------------------------------------

test("pressKey: Shift swaps to shift_cmd", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    kb.container.dataset.isShiftOn = "true";
    kb.pressKey(fakeKeyElement({ cmd: "a", shift_cmd: "A" }));
    assert.deepEqual(term.calls, [{ method: "write", arg: "A" }]);
});

test("pressKey: Alt+Shift overrides with altshift_cmd", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    kb.container.dataset.isAltOn = "true";
    kb.container.dataset.isShiftOn = "true";
    kb.pressKey(fakeKeyElement({ cmd: "a", shift_cmd: "A", alt_cmd: "à", altshift_cmd: "À" }));
    assert.deepEqual(term.calls, [{ method: "write", arg: "À" }]);
});

// ---------------------------------------------------------------------
// Dead-key transforms (round-trip through pressKey)
// ---------------------------------------------------------------------

test("pressKey: with isNextCircum set, 'a' becomes 'â' and flag clears", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    kb.container.dataset.isNextCircum = "true";
    kb.pressKey(fakeKeyElement({ cmd: "a" }));
    assert.deepEqual(term.calls, [{ method: "write", arg: "â" }]);
    assert.equal(kb.container.dataset.isNextCircum, "false");
});

test("pressKey: cedilla flag clears after applying (sticky-cedilla regression lock)", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    kb.container.dataset.isNextCedilla = "true";
    kb.pressKey(fakeKeyElement({ cmd: "c" }));
    assert.deepEqual(term.calls, [{ method: "write", arg: "ç" }]);
    // Pre-fix this would have been "true" — see #142.
    assert.equal(kb.container.dataset.isNextCedilla, "false");
});

// ---------------------------------------------------------------------
// Escaped commands
// ---------------------------------------------------------------------

test("pressKey: ESCAPED|-- CAPSLCK: ON flips isCapsLckOn and short-circuits", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    const ret = kb.pressKey(fakeKeyElement({ cmd: "ESCAPED|-- CAPSLCK: ON" }));
    assert.equal(ret, true);
    assert.equal(kb.container.dataset.isCapsLckOn, "true");
    assert.equal(term.calls.length, 0);   // never reaches the write path
});

test("pressKey: ESCAPED|-- CIRCUM sets the isNextCircum flag", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard();
    kb.pressKey(fakeKeyElement({ cmd: "ESCAPED|-- CIRCUM" }));
    assert.equal(kb.container.dataset.isNextCircum, "true");
});

test("pressKey: unknown ESCAPED|-- X falls through and writes the stripped payload (regression: #142)", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb, term } = makeKeyboard();
    // Pre-fix this PR's variant would have written the full
    // "ESCAPED|-- UNKNOWN" because the strip happened inside the
    // try-handle helper; #142's rework split the strip out of the
    // helper so unknown commands still emit their stripped payload.
    kb.pressKey(fakeKeyElement({ cmd: "ESCAPED|-- UNKNOWN" }));
    assert.deepEqual(term.calls, [{ method: "write", arg: "UNKNOWN" }]);
});

// ---------------------------------------------------------------------
// Non-terminal write path (linkedToTerm = false)
// ---------------------------------------------------------------------

test("pressKey: plain cmd appends to active <input> value when NOT linkedToTerm", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({ linkedToTerm: false });
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();

    kb.pressKey(fakeKeyElement({ cmd: "d" }));
    assert.equal(input.value, "abcd");
});

test("pressKey: '\\x08' (backspace) removes the last char from active element", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({ linkedToTerm: false });
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();

    kb.pressKey(fakeKeyElement({ cmd: "\x08" }));
    assert.equal(input.value, "ab");
});

test("pressKey: '\\x1BOD' (left arrow) decrements caret on active element", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({ linkedToTerm: false });
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(2, 2);

    kb.pressKey(fakeKeyElement({ cmd: "\x1BOD" }));
    assert.equal(input.selectionStart, 1);
    assert.equal(input.selectionEnd, 1);
});

test("pressKey: '\\x1BOC' (right arrow) increments caret on active element", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({ linkedToTerm: false });
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(1, 1);

    kb.pressKey(fakeKeyElement({ cmd: "\x1BOC" }));
    assert.equal(input.selectionStart, 2);
    assert.equal(input.selectionEnd, 2);
});

test("pressKey: other control sequences are suppressed on active element (not appended)", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({ linkedToTerm: false });
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();

    // The first char of ctrlseq[1] (= "\x1B") matches the suppression
    // table — a bare ESC byte should NOT be appended.
    kb.pressKey(fakeKeyElement({ cmd: "\x1B" }));
    assert.equal(input.value, "abc");
});

test("pressKey: 'input' CustomEvent fires on active element with the right detail", (t) => {
    t.after(teardownDom);
    setupDom();
    const { kb } = makeKeyboard({ linkedToTerm: false });
    const input = document.createElement("input");
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();

    const events = [];
    input.addEventListener("input", (e) => events.push(e.detail));

    kb.pressKey(fakeKeyElement({ cmd: "d" }));        // insert
    kb.pressKey(fakeKeyElement({ cmd: "\x08" }));      // delete

    assert.deepEqual(events, ["insert", "delete"]);
});
