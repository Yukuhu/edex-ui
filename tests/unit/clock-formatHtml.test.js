"use strict";

// Coverage for Clock._formatClockHtml — the pure formatter behind
// the on-screen 24h / 12h clock widget. Issue #201.

const test = require("node:test");
const assert = require("node:assert/strict");

// clock.class.js reads `window.settings` in its constructor and
// touches `document.getElementById` in `updateClock`. Neither path
// is exercised by the static formatter, so a minimal `global.window`
// stub is all we need to satisfy the module-load contract.
global.window = global.window ?? {};

const { Clock } = require("../../src/classes/clock.class.js");
const fmt = Clock._formatClockHtml;

// ── 24-hour formatting ────────────────────────────────────────────

test("24h: zero-pads single-digit components and wraps each char in <span>", () => {
    const { html, ampm } = fmt(new Date("2025-01-01T03:07:09Z"), false);
    // The dates are interpreted in the local TZ — pin against the
    // shape rather than absolute values, then exercise specific
    // expected substrings.
    assert.equal(ampm, null);
    // Six digits + two `:` separators → 8 characters.
    const spanCount = (html.match(/<span>/g) || []).length;
    const emCount   = (html.match(/<em>/g)   || []).length;
    assert.equal(spanCount, 6, "six <span>-wrapped digits");
    assert.equal(emCount, 2, "two <em>-wrapped colons");
});

test("24h: noon stays as 12:00:00, no AM/PM affix", () => {
    // Construct a Date that resolves to 12:00:00 in *local* time by
    // building it from local components.
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    const { html, ampm } = fmt(t, false);
    assert.equal(ampm, null);
    assert.match(html, /^<span>1<\/span><span>2<\/span><em>:<\/em>/);
});

// ── 12-hour formatting ────────────────────────────────────────────

test("12h: 13:00 renders as 01:00 + PM", () => {
    const t = new Date();
    t.setHours(13, 0, 0, 0);
    const { html, ampm } = fmt(t, true);
    assert.equal(ampm, "PM");
    // Hour-tens digit is `0`, ones digit is `1`.
    assert.match(html, /^<span>0<\/span><span>1<\/span><em>:<\/em>/);
    // Trailing AM/PM span.
    assert.ok(html.endsWith("<span>PM</span>"));
});

test("12h: midnight 00:xx renders as 12:xx + AM (hour-zero quirk)", () => {
    const t = new Date();
    t.setHours(0, 30, 0, 0);
    const { html, ampm } = fmt(t, true);
    assert.equal(ampm, "AM");
    assert.match(html, /^<span>1<\/span><span>2<\/span><em>:<\/em><span>3<\/span><span>0<\/span>/);
    assert.ok(html.endsWith("<span>AM</span>"));
});

test("12h: 12:00 noon stays 12 + PM (boundary case)", () => {
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    const { html, ampm } = fmt(t, true);
    assert.equal(ampm, "PM");
    assert.match(html, /^<span>1<\/span><span>2<\/span>/);
    assert.ok(html.endsWith("<span>PM</span>"));
});

test("12h: 23:59:59 renders as 11:59:59 + PM", () => {
    const t = new Date();
    t.setHours(23, 59, 59, 0);
    const { html, ampm } = fmt(t, true);
    assert.equal(ampm, "PM");
    // Each component is two digits → six total digit spans + AM/PM.
    const spanCount = (html.match(/<span>/g) || []).length;
    assert.equal(spanCount, 7, "six digit spans + AM/PM span");
});

test("12h: 1:00 AM renders without leading-zero overflow", () => {
    const t = new Date();
    t.setHours(1, 5, 0, 0);
    const { html, ampm } = fmt(t, true);
    assert.equal(ampm, "AM");
    // Hour stays as 01 (zero-padded), AM appended.
    assert.match(html, /^<span>0<\/span><span>1<\/span><em>:<\/em>/);
});

// ── Char wrapping contract ────────────────────────────────────────

test("digits always go inside <span>, colons always inside <em>", () => {
    const t = new Date();
    t.setHours(10, 20, 30, 0);
    const { html } = fmt(t, false);
    // No raw digits leaking outside spans.
    const stripped = html.replace(/<span>[^<]*<\/span>/g, "").replace(/<em>:<\/em>/g, "");
    assert.equal(stripped, "", "all chars accounted for by either <span>{digit}</span> or <em>:</em>");
});
