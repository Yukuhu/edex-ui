"use strict";
// @ts-check

// Pure helpers for safe HTML / CSS interpolation. Extracted from
// `_renderer.js` so they can be required from the main process and
// the unit test suite without dragging in Electron. The renderer
// re-attaches the exports to `window._escapeHtml` / `window._purifyCSS`
// for backward compatibility with the in-page call sites.
//
// Issue #170.

// HTML escape for text content and double-quoted attribute values.
// Maps the OWASP-recommended five characters; everything else passes
// through untouched. Returns "" for null/undefined and coerces other
// non-string input via String() — matches the defensive patterns at
// existing call sites (`(window._escapeHtml || (s => s))(...)` in
// fsModal/claudeChat, `String(s ?? "")` stubs in the test suite).
//
// Not intended for: unquoted attribute values, javascript: URI
// contexts, or splicing into a <script> body. Those need
// context-specific encoders (URL encoding, JSON-string encoding,
// etc.) — none of the project's existing call sites need them.
/**
 * @param {unknown} text
 * @returns {string}
 */
function escapeHtml(text) {
    if (text === null || text === undefined) return "";
    const str = typeof text === "string" ? text : String(text);
    const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
    };
    return str.replace(/[&<>"']/g, m => map[m]);
}

// Sanitize a value before splicing it into a <style> block. NOT a
// general CSS sanitizer — only strips `<` so an attacker-controlled
// theme value can't prematurely close the surrounding <style> tag
// and break into an HTML context. CSS parsers don't care about `<`
// inside a property value, so removing it is a no-op for legitimate
// CSS.
//
// `>` is deliberately preserved: theme.injectCSS may contain valid
// child combinators (e.g. `.foo > .bar`), and `>` alone can't close
// a <style> tag without the leading `<`.
//
// Returns "" for null/undefined, coerces other non-string input via
// String().
/**
 * @param {unknown} str
 * @returns {string}
 */
function purifyCSS(str) {
    if (str === null || str === undefined) return "";
    const s = typeof str === "string" ? str : String(str);
    return s.replace(/</g, "");
}

// Strict-numeric coercion for CSS contexts. Returns the input as a
// finite number when possible, otherwise `0`. NaN / Infinity /
// strings that contain non-numeric tokens never reach the stylesheet.
//
// Use this when interpolating user-supplied values into `rgb()`,
// `rgba()`, `hsl()`, or any other CSS function that expects a number
// — e.g. theme.colors.r/g/b. Without this guard, a malicious theme
// setting `r: "0); background: url(javascript:alert(1))"` could
// break out of the rgb() call and inject CSS into the rule's
// selector context. The threat model is narrow (an attacker must
// convince the user to install a malicious theme file under their
// userData/themes/ directory) but the fix is cheap.
//
// Issue #197.
/**
 * @param {unknown} v
 * @returns {number}
 */
function strictCssNumber(v) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

// Tightened sibling of `purifyCSS` for *value* contexts — colors,
// font names, and the like. Strips the small set of characters that
// can break out of a CSS declaration value:
//
//   `;`     — declaration boundary; would let the value introduce
//             a new declaration into the same rule.
//   `{` `}` — rule-block boundaries; could open or close rules.
//   `<` `>` — `<style>` tag boundaries; same threat purifyCSS already
//             addresses for `<`, plus `>` (which purifyCSS keeps
//             because theme.injectCSS uses it for child
//             combinators — irrelevant in a color/font value).
//   `\`     — CSS escape sequence prefix; could encode any of the
//             above. Strip pre-emptively.
//
// Use this for theme.colors.* and theme.cssvars.* / theme.terminal.fontFamily
// — anywhere the value is splice into a declaration body and the value
// itself doesn't legitimately need any of those characters. Keep
// `purifyCSS` for `theme.injectCSS`, which is intentionally arbitrary
// CSS and needs `>` for selectors. Issue #199.
/**
 * @param {unknown} s
 * @returns {string}
 */
function safeCssValue(s) {
    if (s === null || s === undefined) return "";
    const str = typeof s === "string" ? s : String(s);
    return str.replace(/[;{}<>\\]/g, "");
}

module.exports = { escapeHtml, purifyCSS, strictCssNumber, safeCssValue };
