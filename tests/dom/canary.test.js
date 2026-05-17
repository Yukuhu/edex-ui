"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");
const { mockIpcRenderer } = require("../helpers/mockElectron.js");

// ---------------------------------------------------------------------
// jsdom helper smoke tests
// ---------------------------------------------------------------------

test("setupDom installs window/document/Element globals", (t) => {
    t.after(teardownDom);
    setupDom();

    assert.ok(global.window);
    assert.ok(global.document);
    assert.ok(global.HTMLElement);
    assert.ok(global.Event);
    assert.ok(global.CustomEvent);

    const div = document.createElement("div");
    div.textContent = "hi";
    document.body.appendChild(div);
    assert.equal(document.body.children.length, 1);
    assert.equal(document.body.firstChild.textContent, "hi");
    assert.ok(div instanceof global.HTMLElement);
});

test("teardownDom removes the installed globals", () => {
    setupDom();
    assert.ok(global.window);
    teardownDom();
    assert.equal(global.window, undefined);
    assert.equal(global.document, undefined);
});

// ---------------------------------------------------------------------
// Real production code path on real DOM nodes
// ---------------------------------------------------------------------

test("Keyboard._isEnterKey works on real DOM elements", (t) => {
    t.after(teardownDom);
    setupDom();

    // Keyboard reads `key.attributes["class"].value` — the previous
    // fake-shape tests in #149 assumed this matches real DOM. Verify.
    const { Keyboard } = require("../../src/classes/keyboard.class.js");
    const kb = Object.create(Keyboard.prototype);

    const enterKey = document.createElement("div");
    enterKey.setAttribute("class", "keyboard_key keyboard_enter");
    assert.equal(kb._isEnterKey(enterKey), true);

    const regular = document.createElement("div");
    regular.setAttribute("class", "keyboard_key");
    assert.equal(kb._isEnterKey(regular), false);
});

// ---------------------------------------------------------------------
// mockIpcRenderer smoke test
// ---------------------------------------------------------------------

test("mockIpcRenderer round-trips on/_emit and tracks send/removeListener", () => {
    const ipc = mockIpcRenderer();
    const seen = [];
    const handler = (_e, payload) => seen.push(payload);

    ipc.on("test:channel", handler);
    ipc.on("other:channel", () => assert.fail("should not be invoked"));

    ipc.send("test:out", { value: 42 });
    assert.deepEqual(ipc.sent, [{ channel: "test:out", payload: { value: 42 } }]);

    ipc.on("test:channel", (_e, p) => seen.push({ second: p }));
    ipc._emit("test:channel", "hello");
    assert.deepEqual(seen, ["hello", { second: "hello" }]);

    ipc.removeListener("test:channel", handler);
    ipc._emit("test:channel", "again");
    assert.deepEqual(seen, ["hello", { second: "hello" }, { second: "again" }]);
});
