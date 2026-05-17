"use strict";

// DOM coverage for HardwareInspector — exercises the constructor's
// parent guard and the updateInfo null-safe DOM writes. Issue #201.

const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");

global.window = global.window ?? {};

const { HardwareInspector } = require("../../src/classes/hardwareInspector.class.js");

// Stub the `systeminformation` proxy that lives on `window.si`.
// Each call returns a Promise so the production code's
// `window.si.system().then(...)` chain resolves with our fixture.
function stubSi({ manufacturer = "Dell Inc.", model = "Latitude 7420", chassis = "Notebook" } = {}) {
    global.window.si = {
        system: () => Promise.resolve({ manufacturer, model }),
        chassis: () => Promise.resolve({ type: chassis })
    };
}

function buildParent(id = "test_hw_parent") {
    const parent = document.createElement("div");
    parent.id = id;
    document.body.appendChild(parent);
    return parent;
}

test("HardwareInspector constructor throws on missing parent", () => {
    setupDom();
    try {
        stubSi();
        assert.throws(
            () => new HardwareInspector("does_not_exist"),
            /parent #does_not_exist missing/
        );
    } finally {
        teardownDom();
    }
});

test("HardwareInspector constructor injects the three info <h2> cells", async () => {
    setupDom();
    try {
        stubSi();
        buildParent();
        const inspector = new HardwareInspector("test_hw_parent");
        clearInterval(inspector.infoUpdater);

        assert.ok(document.getElementById("mod_hardwareInspector_manufacturer"));
        assert.ok(document.getElementById("mod_hardwareInspector_model"));
        assert.ok(document.getElementById("mod_hardwareInspector_chassis"));
        // Constructor kicked off updateInfo() — await its chain
        // before teardownDom() clears `window.si`, or the async
        // .then's `chassis` lookup races against the wipe.
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        teardownDom();
    }
});

test("HardwareInspector.updateInfo populates the three cells from si fixtures", async () => {
    setupDom();
    try {
        stubSi({ manufacturer: "Acme Co", model: "M1 Pro", chassis: "Desktop" });
        buildParent();
        const inspector = new HardwareInspector("test_hw_parent");
        clearInterval(inspector.infoUpdater);

        // Constructor calls updateInfo() — wait for the two
        // chained Promises to resolve before asserting.
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        // `_trimDataString` deduplicates against the manufacturer +
        // chassis-type filters and caps at two words. "Acme Co" has
        // no overlap with model "M1 Pro", so manufacturer renders
        // verbatim. "M1 Pro" has no overlap with "Acme" or
        // "Desktop" either, so model renders verbatim.
        const mfg     = document.getElementById("mod_hardwareInspector_manufacturer");
        const model   = document.getElementById("mod_hardwareInspector_model");
        const chassis = document.getElementById("mod_hardwareInspector_chassis");
        assert.equal(mfg.innerText, "Acme Co");
        assert.equal(model.innerText, "M1 Pro");
        assert.equal(chassis.innerText, "Desktop");
    } finally {
        teardownDom();
    }
});

test("HardwareInspector.updateInfo is a no-op when the target cells were removed", async () => {
    // The renderer's hot-swap path can remove the parent column
    // mid-poll. The null checks (issue #201) keep updateInfo from
    // crashing in that window.
    setupDom();
    try {
        stubSi();
        buildParent();
        const inspector = new HardwareInspector("test_hw_parent");
        clearInterval(inspector.infoUpdater);

        document.getElementById("mod_hardwareInspector_manufacturer").remove();
        document.getElementById("mod_hardwareInspector_model").remove();
        document.getElementById("mod_hardwareInspector_chassis").remove();

        // Must not throw.
        inspector.updateInfo();
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        teardownDom();
    }
});

// ── _trimDataString pure helper ──────────────────────────────────

test("_trimDataString trims, splits on spaces, filters duplicates, caps at 2 words", async () => {
    setupDom();
    try {
        stubSi();
        buildParent();
        const inspector = new HardwareInspector("test_hw_parent");
        clearInterval(inspector.infoUpdater);
        // Drain the constructor-driven updateInfo chain so it
        // doesn't fire after teardownDom().
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        // "Acme Inc"  → trimmed → ["Acme", "Inc"] → no filter → first 2 → "Acme Inc"
        assert.equal(inspector._trimDataString("  Acme Inc  "), "Acme Inc");
        // "Dell Latitude 7420" with filter "Dell"
        //   → ["Dell", "Latitude", "7420"]
        //   → filter strips "Dell"
        //   → first 2 → "Latitude 7420"
        assert.equal(inspector._trimDataString("Dell Latitude 7420", "Dell"), "Latitude 7420");
        // Same source with both filters → "Latitude 7420"
        assert.equal(
            inspector._trimDataString("Dell Latitude 7420", "Dell", "Notebook"),
            "Latitude 7420"
        );
    } finally {
        teardownDom();
    }
});
