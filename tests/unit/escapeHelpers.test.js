"use strict";

// Coverage for src/utils/escapeHelpers.js — the helpers that gate
// every interpolated value into HTML or <style> contexts in the
// renderer (themes, web-app definitions, shortcuts, file system
// names, chat output, …).
//
// Goal: pin the threat model so we don't silently regress to a
// weaker escape, and exercise the OWASP XSS Filter Evasion cheat-
// sheet basics. Issue #170.

const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml, purifyCSS } = require("../../src/utils/escapeHelpers.js");

// ── escapeHtml ───────────────────────────────────────────────────

test("escapeHtml maps the five OWASP-recommended characters", () => {
    assert.equal(escapeHtml("&"), "&amp;");
    assert.equal(escapeHtml("<"), "&lt;");
    assert.equal(escapeHtml(">"), "&gt;");
    assert.equal(escapeHtml("\""), "&quot;");
    assert.equal(escapeHtml("'"), "&#039;");
});

test("escapeHtml escapes & before producing entities (no double-escape)", () => {
    // Naively replacing < then & yields &amp;lt; — order matters.
    assert.equal(escapeHtml("<b>&"), "&lt;b&gt;&amp;");
    assert.equal(escapeHtml("&amp;"), "&amp;amp;");
});

test("escapeHtml neutralizes a basic <script> tag", () => {
    const evil = "<script>alert(1)</script>";
    const safe = escapeHtml(evil);
    assert.equal(safe, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert.equal(safe.includes("<"), false);
    assert.equal(safe.includes(">"), false);
});

test("escapeHtml prevents attribute-value breakouts (double-quote)", () => {
    // Real call site shape: `<input value="${escapeHtml(x)}">`
    const payload = "\" onclick=\"alert(1)";
    const escaped = escapeHtml(payload);
    assert.equal(escaped.includes("\""), false);
    // The renderer would emit: <input value="&quot; onclick=&quot;alert(1)">
    // which keeps the attacker inside the value.
    assert.match(escaped, /^&quot;/);
});

test("escapeHtml prevents attribute-value breakouts (single-quote)", () => {
    // Some templates use single-quoted attributes.
    const payload = "' onerror='alert(1)";
    const escaped = escapeHtml(payload);
    assert.equal(escaped.includes("'"), false);
});

test("escapeHtml leaves benign content untouched", () => {
    assert.equal(escapeHtml("Hello, world."), "Hello, world.");
    assert.equal(escapeHtml(""), "");
    assert.equal(escapeHtml("Schöne Grüße"), "Schöne Grüße");
});

test("escapeHtml returns \"\" for null/undefined input", () => {
    // Matches the defensive `(window._escapeHtml || (s => s))(...)`
    // patterns in fsModal/claudeChat — those guards exist precisely
    // because the previous impl crashed on null.
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml coerces non-string input via String()", () => {
    assert.equal(escapeHtml(42), "42");
    assert.equal(escapeHtml(true), "true");
    assert.equal(escapeHtml({ toString: () => "<x>" }), "&lt;x&gt;");
});

// ── purifyCSS ────────────────────────────────────────────────────

test("purifyCSS strips < to prevent <style> tag breakout", () => {
    // The whole point: an attacker-controlled theme value that
    // contains `</style><script>...</script>` must not be able to
    // close the surrounding <style> block.
    const payload = "red; } </style><script>alert(1)</script><style>{ color: ";
    const purified = purifyCSS(payload);
    assert.equal(purified.includes("<"), false);
    assert.equal(purified.includes("</style"), false);
});

test("purifyCSS preserves > so child combinators in injectCSS keep working", () => {
    // theme.injectCSS is splice into the same <style> block; valid
    // CSS like `.parent > .child { … }` must survive.
    const css = ".parent > .child { color: red; }";
    assert.equal(purifyCSS(css), css);
});

test("purifyCSS leaves benign CSS values untouched", () => {
    assert.equal(purifyCSS("#aabbcc"), "#aabbcc");
    assert.equal(purifyCSS("rgba(255, 0, 0, 0.5)"), "rgba(255, 0, 0, 0.5)");
    assert.equal(purifyCSS("\"Fira Code\""), "\"Fira Code\"");
});

test("purifyCSS returns \"\" for null/undefined input", () => {
    assert.equal(purifyCSS(null), "");
    assert.equal(purifyCSS(undefined), "");
});

test("purifyCSS coerces non-string input via String()", () => {
    assert.equal(purifyCSS(42), "42");
    assert.equal(purifyCSS({ toString: () => "red < blue" }), "red  blue");
});
