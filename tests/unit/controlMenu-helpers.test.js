"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { ControlMenu } = require("../../src/classes/controlMenu.class.js");

// `_renderEntrySlots` interpolates through `window._escapeHtml`.
// We don't need real HTML escaping — identity is enough for the
// structural tests below — but a real escaper makes a couple of
// "what about characters that need escaping?" assertions meaningful.
global.window = global.window ?? {};
global.window._escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function fakeMenu() {
    const m = Object.create(ControlMenu.prototype);
    m.path = [];
    // _buildSubmenu is called when an entry has `buildSubmenu`. We stub
    // it to return a known array so we can exercise the dynamic-submenu
    // branch of _pathCrumbs.
    m._buildSubmenu = (kind) => {
        if (kind === "themes")  return [{ id: "neon", label: "Neon" }, { id: "tron", label: "Tron" }];
        if (kind === "webapps") return [{ id: "wa1",  label: "WebApp 1" }];
        return [];
    };
    return m;
}

// ---------------------------------------------------------------------
// _pathCrumbs
// ---------------------------------------------------------------------

test("ControlMenu._pathCrumbs", async (t) => {
    await t.test("empty path → just the root crumb", () => {
        const m = fakeMenu();
        assert.deepEqual(m._pathCrumbs(), ["Control Menu"]);
    });
    await t.test("walks into a static submenu", () => {
        const m = fakeMenu();
        m.path = ["style"];
        assert.deepEqual(m._pathCrumbs(), ["Control Menu", "Style"]);
    });
    await t.test("walks into a static submenu and then a leaf-action child", () => {
        const m = fakeMenu();
        m.path = ["style", "themes"];
        // "themes" inside "style" uses `buildSubmenu` — _pathCrumbs
        // descends into the dynamic submenu via _buildSubmenu("themes").
        assert.deepEqual(m._pathCrumbs(), ["Control Menu", "Style", "Theme..."]);
    });
    await t.test("walks into a dynamic submenu (buildSubmenu)", () => {
        const m = fakeMenu();
        m.path = ["style", "themes", "neon"];
        assert.deepEqual(m._pathCrumbs(), ["Control Menu", "Style", "Theme...", "Neon"]);
    });
    await t.test("stops at the first unresolved id (returns the prefix walked so far)", () => {
        const m = fakeMenu();
        m.path = ["style", "does-not-exist", "more"];
        assert.deepEqual(m._pathCrumbs(), ["Control Menu", "Style"]);
    });
});

// ---------------------------------------------------------------------
// _renderEmptySlots
// ---------------------------------------------------------------------

test("ControlMenu._renderEmptySlots", async (t) => {
    const m = fakeMenu();

    await t.test("renders 'No matches' as the first row and N-1 filler rows", () => {
        const html = m._renderEmptySlots(5);
        // First row is selected and labeled "No matches".
        assert.ok(html.includes(`id="controlMenuMatch-0"`));
        assert.ok(html.includes("controlMenuMatchSelected"));
        assert.ok(html.includes("No matches"));
        // Remaining 4 slots are empty filler rows with sequential ids.
        for (let i = 1; i < 5; i++) {
            assert.ok(html.includes(`id="controlMenuMatch-${i}"`), `slot ${i} missing`);
        }
    });
    await t.test("with slots=1 renders only the 'No matches' row", () => {
        const html = m._renderEmptySlots(1);
        assert.ok(html.includes(`controlMenuMatch-0`));
        assert.ok(!html.includes(`controlMenuMatch-1`));
    });
});

// ---------------------------------------------------------------------
// _renderEntrySlots
// ---------------------------------------------------------------------

test("ControlMenu._renderEntrySlots", async (t) => {
    const m = fakeMenu();

    await t.test("populates one row per entry, fillers for the rest", () => {
        const html = m._renderEntrySlots(
            [{ id: "a", label: "Alpha", hint: "Ctrl+A" }, { id: "b", label: "Beta", hint: "Ctrl+B" }],
            0,
            5
        );
        assert.ok(html.includes("Alpha"));
        assert.ok(html.includes("Beta"));
        assert.ok(html.includes(`controlMenuMatch-2`));   // filler
        assert.ok(html.includes(`controlMenuMatch-3`));
        assert.ok(html.includes(`controlMenuMatch-4`));
    });
    await t.test("only the `selected` row gets the controlMenuMatchSelected class", () => {
        const html = m._renderEntrySlots(
            [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "c", label: "Gamma" }],
            1, // pick the middle
            5
        );
        // Count the "controlMenuMatchSelected" occurrences — exactly 1.
        const matches = html.match(/controlMenuMatchSelected/g) || [];
        assert.equal(matches.length, 1);
        // And it's on the second slot (index 1).
        const idx1Start = html.indexOf(`controlMenuMatch-1`);
        const idx2Start = html.indexOf(`controlMenuMatch-2`);
        const selectedPos = html.indexOf("controlMenuMatchSelected");
        assert.ok(selectedPos > idx1Start && selectedPos < idx2Start, "selected class should attach to slot 1");
    });
    await t.test("entries with submenu/buildSubmenu show '›' hint regardless of e.hint", () => {
        const html = m._renderEntrySlots(
            [{ id: "x", label: "Has children", hint: "ignored", submenu: [{}] }],
            0,
            1
        );
        assert.ok(html.includes("›"));
        assert.ok(!html.includes("ignored"));

        const html2 = m._renderEntrySlots(
            [{ id: "y", label: "Builds children", hint: "also ignored", buildSubmenu: "themes" }],
            0,
            1
        );
        assert.ok(html2.includes("›"));
        assert.ok(!html2.includes("also ignored"));
    });
    await t.test("entries with no children show e.hint (or empty)", () => {
        const html = m._renderEntrySlots(
            [{ id: "z", label: "Plain", hint: "Ctrl+Z" }, { id: "n", label: "NoHint" }],
            0,
            2
        );
        assert.ok(html.includes("Ctrl+Z"));
        assert.ok(html.includes("Plain"));
        assert.ok(html.includes("NoHint"));
    });
    await t.test("escapes HTML-special characters in label + hint", () => {
        const html = m._renderEntrySlots(
            [{ id: "evil", label: "<script>alert(1)</script>", hint: "&\"'" }],
            0,
            1
        );
        // Raw "<script>" must not appear; the encoded form must.
        assert.ok(!html.includes("<script>"));
        assert.ok(html.includes("&lt;script&gt;"));
        assert.ok(html.includes("&amp;"));
        assert.ok(html.includes("&quot;"));
    });
});

// ---------------------------------------------------------------------
// Static menu structure (sanity check)
// ---------------------------------------------------------------------

test("ControlMenu.MENU is well-formed", () => {
    const M = ControlMenu.MENU;
    assert.ok(Array.isArray(M) && M.length > 0);
    const seenIds = new Set();
    for (const entry of M) {
        assert.equal(typeof entry.id, "string");
        assert.ok(!seenIds.has(entry.id), `duplicate top-level menu id ${entry.id}`);
        seenIds.add(entry.id);
        assert.equal(typeof entry.label, "string");
        // Each entry is one of: leaf (action), static submenu, dynamic submenu.
        const isLeaf       = typeof entry.action === "function";
        const isSubmenu    = Array.isArray(entry.submenu);
        const isBuildMenu  = typeof entry.buildSubmenu === "string";
        assert.ok(
            isLeaf || isSubmenu || isBuildMenu,
            `entry ${entry.id} has neither action, submenu, nor buildSubmenu`
        );
    }
});
