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
// one place so teardown restores exactly what setup added.
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

// Track the active jsdom + snapshot the global descriptors we replace,
// so:
//   - teardownDom can call window.close() and let jsdom release its
//     timers / pending requests (recommended by jsdom docs; otherwise
//     instances accumulate across the test run);
//   - we restore any pre-existing global properties exactly instead of
//     blindly `delete`-ing them (the prior Phase 1+2 tests set
//     `global.window = {}` at module load to satisfy the
//     `window.ClaudeChat = …` assignment in claudeChat.class.js;
//     a blanket delete would strand later require()s of the same file).
let activeDom = null;
const previousGlobals = new Map();

function setupDom(html = "<!DOCTYPE html><html><body></body></html>") {
    if (activeDom) activeDom.window.close();
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    activeDom = dom;
    for (const name of INSTALLED) {
        if (!(name in dom.window)) continue;
        if (!previousGlobals.has(name)) {
            previousGlobals.set(name, Object.getOwnPropertyDescriptor(global, name) || null);
        }
        global[name] = dom.window[name];
    }
    return dom;
}

function teardownDom() {
    if (activeDom) {
        activeDom.window.close();
        activeDom = null;
    }
    for (const name of INSTALLED) {
        const prev = previousGlobals.get(name);
        if (prev) {
            Object.defineProperty(global, name, prev);
        } else {
            delete global[name];
        }
    }
    previousGlobals.clear();
}

module.exports = { setupDom, teardownDom };
