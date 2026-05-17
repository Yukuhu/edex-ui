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

const { escapeHtml, purifyCSS, strictCssNumber, safeCssValue } = require("../../src/utils/escapeHelpers.js");

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

// ── strictCssNumber ──────────────────────────────────────────────

test("strictCssNumber passes through finite numbers", () => {
    assert.equal(strictCssNumber(0), 0);
    assert.equal(strictCssNumber(170), 170);
    assert.equal(strictCssNumber(-1), -1);
    assert.equal(strictCssNumber(3.14), 3.14);
});

test("strictCssNumber parses well-formed numeric strings", () => {
    // The themes.json schema declares r/g/b as numbers, but a
    // malformed file could ship them as strings — accept them.
    assert.equal(strictCssNumber("170"), 170);
    assert.equal(strictCssNumber("3.14"), 3.14);
    assert.equal(strictCssNumber("-1"), -1);
});

test("strictCssNumber rejects break-out attempts → 0", () => {
    // The whole point of the helper. Without it,
    // `rgb(${theme.r}, …)` with a malicious theme.r becomes:
    //   rgb(0); background: url(javascript:alert(1)); /*, 0, 0)*/
    // The 0 fallback collapses the attack to `rgb(0, …)`.
    assert.equal(strictCssNumber("0); background: url(javascript:alert(1))"), 0);
    assert.equal(strictCssNumber("0 /* inject */"), 0);
    assert.equal(strictCssNumber("170; }script: alert(1)"), 0);
});

test("strictCssNumber rejects NaN, Infinity, and non-numeric strings", () => {
    assert.equal(strictCssNumber(NaN), 0);
    assert.equal(strictCssNumber(Infinity), 0);
    assert.equal(strictCssNumber(-Infinity), 0);
    assert.equal(strictCssNumber("not a number"), 0);
    assert.equal(strictCssNumber(""), 0,
        "Number('') is 0 — finite — but trimming whitespace and treating empty as missing matches the renderer's 'no value' expectation");
});

test("strictCssNumber returns 0 for null/undefined", () => {
    assert.equal(strictCssNumber(null), 0);
    assert.equal(strictCssNumber(undefined), 0);
});

test("strictCssNumber returns 0 for non-string-non-number input", () => {
    assert.equal(strictCssNumber({}), 0);
    assert.equal(strictCssNumber([]), 0,
        "Number([]) is 0 — still 0; just pin the contract");
    assert.equal(strictCssNumber(true), 1,
        "Number(true) is 1 — finite — so passes through. Defensible.");
});

// ── safeCssValue ──────────────────────────────────────────────────

test("safeCssValue leaves a normal hex colour untouched", () => {
    assert.equal(safeCssValue("#aabbcc"), "#aabbcc");
    assert.equal(safeCssValue("#000000"), "#000000");
    assert.equal(safeCssValue("#fff"), "#fff");
});

test("safeCssValue leaves rgb()/rgba() functional values intact", () => {
    assert.equal(safeCssValue("rgb(170, 207, 209)"), "rgb(170, 207, 209)");
    assert.equal(safeCssValue("rgba(170,207,209,0.3)"), "rgba(170,207,209,0.3)");
});

test("safeCssValue leaves quoted font names intact (used for --font_main: \"X\")", () => {
    // The renderer wraps the value in `"..."`. Quotes inside the
    // value aren't dangerous here — the CSS string literal already
    // owns them.
    assert.equal(safeCssValue("United Sans Medium"), "United Sans Medium");
    assert.equal(safeCssValue("Fira Code"), "Fira Code");
});

test("safeCssValue strips ; (declaration boundary)", () => {
    // The actual attack pattern: theme.colors.black = "#000; background: red"
    // renders as `:root { --color_black: #000; background: red; … }`,
    // which applies `background: red` to <html>. After the strip:
    //   --color_black: #000 background: red;
    // → invalid → dropped.
    assert.equal(safeCssValue("#000; background: red"), "#000 background: red");
});

test("safeCssValue strips { and } (rule-block boundaries)", () => {
    assert.equal(safeCssValue("#000} body { background: red"), "#000 body  background: red");
    assert.equal(safeCssValue("#000 { hack: yes }"), "#000  hack: yes ");
});

test("safeCssValue strips < and > (style-tag boundaries)", () => {
    // < alone is what purifyCSS catches; safeCssValue adds > for
    // belt-and-braces in value contexts where `>` has no legitimate
    // role (child-combinator only matters in selectors).
    assert.equal(safeCssValue("#000</style><script>alert(1)</script>"), "#000/stylescriptalert(1)/script");
});

test("safeCssValue strips \\ (CSS escape sequence prefix)", () => {
    // CSS escapes (`\3c` = `<`) could otherwise smuggle a banned
    // char past the regex strip.
    assert.equal(safeCssValue("#000\\3c"), "#0003c");
    // Both `\` and `;` are stripped in a single pass, so even an
    // already-escaped boundary char loses both halves. That's
    // strictly safer than letting the CSS parser later decode the
    // escape into a literal `;`.
    assert.equal(safeCssValue("red\\;background:red"), "redbackground:red");
});

test("safeCssValue returns \"\" for null/undefined", () => {
    assert.equal(safeCssValue(null), "");
    assert.equal(safeCssValue(undefined), "");
});

test("safeCssValue coerces non-string input via String()", () => {
    assert.equal(safeCssValue(170), "170");
    assert.equal(safeCssValue({ toString: () => "#aabbcc" }), "#aabbcc");
});
