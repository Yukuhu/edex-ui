"use strict";

// DOM coverage for Clock — exercises the constructor's parent guard
// and the per-tick updateClock flow against jsdom. Pairs with the
// pure-formatter coverage in tests/unit/clock-formatHtml.test.js.
// Issue #201.

const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");

// clock.class.js reads `window.settings.clockHours` in its
// constructor; install a minimal `window` so the require()-time
// load doesn't crash.
global.window = global.window ?? {};

const { Clock } = require("../../src/classes/clock.class.js");

function withClock(opts = {}, fn) {
    setupDom();
    try {
        global.window.settings = { clockHours: opts.clockHours ?? 24 };
        const parent = document.createElement("div");
        parent.id = "test_clock_parent";
        document.body.appendChild(parent);

        const clock = new Clock("test_clock_parent");
        // Stop the 1-second interval so test runs don't leak timers
        // (and so we control updateClock's invocation count).
        clearInterval(clock.updater);
        try {
            fn(clock);
        } finally {
            // Construction calls updateClock() once; updater is
            // already cleared above. Nothing else to tear down at
            // the Clock level — the dom teardown will sweep the
            // DOM nodes.
        }
    } finally {
        teardownDom();
    }
}

test("Clock constructor throws on missing parent", () => {
    setupDom();
    try {
        global.window.settings = { clockHours: 24 };
        assert.throws(
            () => new Clock("does_not_exist"),
            /parent #does_not_exist missing/
        );
    } finally {
        teardownDom();
    }
});

test("Clock constructor injects #mod_clock + #mod_clock_text into parent", () => {
    withClock({ clockHours: 24 }, (clock) => {
        const root = document.getElementById("mod_clock");
        const text = document.getElementById("mod_clock_text");
        assert.ok(root, "#mod_clock created");
        assert.ok(text, "#mod_clock_text created");
        // updateClock ran once during construction → text is populated.
        assert.ok(text.innerHTML.includes("<span>"));
        // `lastTime` is stamped on every updateClock call.
        assert.ok(clock.lastTime instanceof Date);
    });
});

test("Clock 12-hour mode adds the mod_clock_twelve class", () => {
    withClock({ clockHours: 12 }, () => {
        const root = document.getElementById("mod_clock");
        assert.ok(root.classList.contains("mod_clock_twelve"));
    });
});

test("Clock 24-hour mode omits the mod_clock_twelve class", () => {
    withClock({ clockHours: 24 }, () => {
        const root = document.getElementById("mod_clock");
        assert.equal(root.classList.contains("mod_clock_twelve"), false);
    });
});

test("Clock.updateClock writes formatted HTML to #mod_clock_text", () => {
    withClock({ clockHours: 24 }, (clock) => {
        // Wipe what construction wrote, then call again.
        const text = document.getElementById("mod_clock_text");
        text.innerHTML = "";
        clock.updateClock();
        // Six digit spans + two colon ems.
        const spanCount = (text.innerHTML.match(/<span>/g) || []).length;
        const emCount   = (text.innerHTML.match(/<em>/g)   || []).length;
        assert.equal(spanCount, 6);
        assert.equal(emCount, 2);
    });
});

test("Clock.updateClock 12-hour mode emits AM/PM span", () => {
    withClock({ clockHours: 12 }, (clock) => {
        const text = document.getElementById("mod_clock_text");
        text.innerHTML = "";
        clock.updateClock();
        // 7 spans = 6 digits + AM/PM.
        const spanCount = (text.innerHTML.match(/<span>/g) || []).length;
        assert.equal(spanCount, 7);
        assert.match(text.innerHTML, /<span>(AM|PM)<\/span>$/);
    });
});

test("Clock.updateClock is a no-op when the target element was removed", () => {
    // Hot-swap / theme reload paths can rebuild the DOM mid-tick.
    // The new null check (issue #201) should make updateClock
    // silently no-op instead of crashing.
    withClock({ clockHours: 24 }, (clock) => {
        document.getElementById("mod_clock_text").remove();
        // Must not throw.
        clock.updateClock();
    });
});
