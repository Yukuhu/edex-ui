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

module.exports = { escapeHtml, purifyCSS };
