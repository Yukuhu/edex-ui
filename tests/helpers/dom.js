"use strict";
// Shared jsdom bootstrap for Phase 3+ DOM-touching tests.
//
// Usage:
//
//     const { setupDom, teardownDom } = require("../helpers/dom.js");
//     test("...", async (t) => {
//         t.before(setupDom);
//         t.after(teardownDom);
//         // ...real tests using document/window globals...
//     });
//
// We install jsdom's window globals onto Node's `global` so production
// code that reads bare `document` / `window.X` / `CustomEvent` works
// without modification. Anything we install gets cleared in teardownDom
// so tests don't leak DOM state between files.

const { JSDOM } = require("jsdom");

// Names we copy from jsdom's window onto `global`. Keep this list in
// one place so teardown removes exactly what setup added.
//
// `navigator` and `location` are deliberately omitted — Node 22 ships
// its own read-only `navigator` global, and `location` is similarly
// non-writable. jsdom's versions are still reachable via `window.navigator`
// / `window.location` if any production code path needs them.
const INSTALLED = [
    "window", "document",
    "HTMLElement", "Element", "Node", "NodeList", "DocumentFragment",
    "Event", "CustomEvent", "MouseEvent", "KeyboardEvent",
    "getComputedStyle", "DOMParser"
];

function setupDom(html = "<!DOCTYPE html><html><body></body></html>") {
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    for (const name of INSTALLED) {
        if (name in dom.window) {
            global[name] = dom.window[name];
        }
    }
    return dom;
}

function teardownDom() {
    for (const name of INSTALLED) {
        delete global[name];
    }
}

module.exports = { setupDom, teardownDom };
