"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");
const { ControlMenu } = require("../../src/classes/controlMenu.class.js");

// `_renderEntrySlots` interpolates user-controlled label/hint values
// through `window._escapeHtml`. Install a real escaper so the
// HTML-escaping assertions below actually exercise encoding.
function installEscapeHtml() {
    window._escapeHtml = (s) => String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Build a ControlMenu without running the real constructor (which
// pulls in window.keyboard / DOM IDs from a Modal). We supply just
// the instance state that `render` reads: `path`, `selected`,
// `filter`, `crumb`, `results`, and a `_buildSubmenu` stub for the
// dynamic-submenu branch (the real implementation reads themes/
// kblayouts from disk).
function makeMenu({ buildSubmenuStub } = {}) {
    const m = Object.create(ControlMenu.prototype);
    m.path = [];
    m.selected = 0;
    m.filter = "";
    m.crumb = document.createElement("div");
    m.results = document.createElement("ul");
    m._cache = {};
    m._buildSubmenu = buildSubmenuStub
        || ((kind) => kind === "webapps"
            ? [{ id: "wa1", label: "WebApp 1", action: () => {} }, { id: "__add", label: "+ Add", action: () => {} }]
            : [{ id: "neon", label: "Neon", action: () => {} }, { id: "tron", label: "Tron", action: () => {} }]);
    return m;
}

// ---------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------

test("render: empty path + no filter shows top-level menu", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    m.render();

    assert.equal(m.crumb.textContent, "Control Menu");
    // Top-level MENU has at least the "Settings" entry — verify a couple
    // of expected labels make it into the results HTML.
    assert.ok(m.results.innerHTML.includes("Settings"));
    assert.ok(m.results.innerHTML.includes("Shortcuts"));
    // No "No matches" overlay.
    assert.ok(!m.results.innerHTML.includes("No matches"));
});

// ---------------------------------------------------------------------
// Static submenu navigation
// ---------------------------------------------------------------------

test("render: path into a static submenu updates crumb + entries", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    m.path = ["toggle"];
    m.render();

    assert.equal(m.crumb.textContent, "Control Menu › Toggle");
    // The "Toggle" submenu has 5 entries — Panels, On-screen keyboard,
    // Filesystem dotfiles, List view, Pass-mode. Spot-check two ends.
    assert.ok(m.results.innerHTML.includes("Panels"));
    assert.ok(m.results.innerHTML.includes("Pass-mode"));
});

// ---------------------------------------------------------------------
// Dynamic submenu navigation (buildSubmenu)
// ---------------------------------------------------------------------

test("render: path into a dynamic submenu uses _buildSubmenu", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu({
        buildSubmenuStub: (kind) => {
            assert.equal(kind, "webapps");
            return [{ id: "wa1", label: "MyApp", action: () => {} }];
        }
    });
    m.path = ["apps"];
    m.render();

    assert.equal(m.crumb.textContent, "Control Menu › Apps");
    assert.ok(m.results.innerHTML.includes("MyApp"));
});

// ---------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------

test("render: filter narrows the visible entries (case-insensitive)", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    m.filter = "sett"; // matches "Settings"
    m.render();

    assert.ok(m.results.innerHTML.includes("Settings"));
    // Other top-level entries shouldn't render.
    assert.ok(!m.results.innerHTML.includes("Shortcuts"));
    assert.ok(!m.results.innerHTML.includes("Style"));
});

test("render: filter matching nothing → 'No matches' overlay with 4 filler slots", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    m.filter = "zzzz-no-such-entry";
    m.render();

    assert.ok(m.results.innerHTML.includes("No matches"));
    // The empty-slots overlay lays out 5 rows total: slot 0 is "No
    // matches" and slots 1-4 are empty filler.
    for (let i = 0; i < 5; i++) {
        assert.ok(
            m.results.innerHTML.includes(`controlMenuMatch-${i}`),
            `slot ${i} should be present`
        );
    }
});

// ---------------------------------------------------------------------
// Selection clamping + highlight
// ---------------------------------------------------------------------

test("render: selected >= visible-entries clamps back to 0", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    m.filter = "sett"; // narrows to a single entry ("Settings")
    m.selected = 42;   // way out of range
    m.render();

    assert.equal(m.selected, 0);
    // The 'controlMenuMatchSelected' class should now be on slot 0.
    assert.match(m.results.innerHTML, /controlMenuMatch-0[^>]*controlMenuMatchSelected/);
});

test("render: selection class lands on the right slot", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    m.selected = 2; // pick the third top-level entry
    m.render();

    // controlMenuMatchSelected appears exactly once.
    const matches = m.results.innerHTML.match(/controlMenuMatchSelected/g) || [];
    assert.equal(matches.length, 1);
    // And it's on slot 2.
    assert.match(m.results.innerHTML, /controlMenuMatch-2[^>]*controlMenuMatchSelected/);
});

// ---------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------

test("render: HTML-special chars in labels go through _escapeHtml", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu({
        buildSubmenuStub: () => [
            { id: "evil", label: "<script>alert(1)</script>", hint: "&\"'" }
        ]
    });
    m.path = ["apps"];
    m.render();

    // The raw "<script>" must not appear; the encoded form must.
    assert.ok(!m.results.innerHTML.includes("<script>"));
    assert.ok(m.results.innerHTML.includes("&lt;script&gt;"));
    // The trailing-modifier-state hint is also escape-passed.
    assert.ok(m.results.innerHTML.includes("&amp;"));
});

// ---------------------------------------------------------------------
// Hint placement
// ---------------------------------------------------------------------

test("render: entries with children show '›' regardless of declared hint", (t) => {
    t.after(teardownDom);
    setupDom();
    installEscapeHtml();

    const m = makeMenu();
    // The top-level "Style" entry has a submenu — its hint slot should
    // be `›`, not any keyboard shortcut.
    m.render();
    // Find the slot that hosts "Style" and check the trailing hint.
    const html = m.results.innerHTML;
    const styleStart = html.indexOf("Style");
    const styleSlot  = html.slice(styleStart, styleStart + 120);
    assert.ok(styleSlot.includes("›"));
});
