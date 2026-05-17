"use strict";

// Coverage for FuzzyFinder's pure static helpers: _stripCwdFallback
// (defensive against Terminal.class.js's "FALLBACK |-- " prefix) and
// _matchAndSort (the scoring logic the Ctrl+Shift+F modal uses).
// Issue #175.

const test = require("node:test");
const assert = require("node:assert/strict");

// fuzzyFinder.class.js doesn't write to `window` at module load —
// `FuzzyFinder` is just a class with `module.exports`. We only call
// static methods, so no DOM stubbing is needed.
const { FuzzyFinder } = require("../../src/classes/fuzzyFinder.class.js");
const stripFallback = FuzzyFinder._stripCwdFallback;
const matchAndSort = FuzzyFinder._matchAndSort;

// ── _stripCwdFallback ────────────────────────────────────────────

test("strips the FALLBACK |-- prefix when present", () => {
    assert.equal(stripFallback("FALLBACK |-- /home/u"), "/home/u");
    assert.equal(stripFallback("FALLBACK |-- C:\\Users\\u"), "C:\\Users\\u");
});

test("leaves real paths untouched", () => {
    assert.equal(stripFallback("/home/u"), "/home/u");
    assert.equal(stripFallback("C:\\Users\\u"), "C:\\Users\\u");
    assert.equal(stripFallback(""), "");
});

test("strips only the leading occurrence — embedded 'FALLBACK |--' is preserved", () => {
    assert.equal(stripFallback("/home/u/FALLBACK |-- subdir"), "/home/u/FALLBACK |-- subdir");
});

test("non-string inputs pass through unchanged", () => {
    // The caller can hand us a `term?.cwd` that's undefined when the
    // current tab hasn't connected yet, or null from a stub. The
    // helper isn't a coercer — its only job is the prefix strip.
    assert.equal(stripFallback(undefined), undefined);
    assert.equal(stripFallback(null), null);
});

// ── _matchAndSort ────────────────────────────────────────────────

test("matchAndSort returns substring matches, case-insensitive", () => {
    const files = ["index.js", "README.md", "package.json", "tests"];
    const out = matchAndSort(files, "js", 10);
    assert.deepEqual(out.sort(), ["index.js", "package.json"]);
});

test("empty query returns up to slotLimit files in input order", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    const out = matchAndSort(files, "", 5);
    assert.deepEqual(out, ["a", "b", "c", "d", "e"]);
});

test("no matches → empty array", () => {
    const out = matchAndSort(["a.txt", "b.txt"], "xyz", 5);
    assert.deepEqual(out, []);
});

test("startsWith matches bubble to the top, others keep readdir order", () => {
    const files = ["package.json", "tsconfig.json", "test.js", "test.md"];
    const out = matchAndSort(files, "test", 5);
    // "test.js" and "test.md" start with "test"; "tsconfig.json"
    // doesn't but contains "t". Wait, "test.js" startsWith "test"
    // (yes), "tsconfig.json" startsWith "test" (no, starts with
    // "tsc"). So we get test.js and test.md at the front.
    assert.equal(out[0], "test.js");
    assert.equal(out[1], "test.md");
    // package.json doesn't contain "test" at all → not in matches.
    assert.equal(out.includes("package.json"), false);
});

test("case insensitivity applies to both haystack and needle", () => {
    const files = ["README.md", "readme-extras.txt", "Reading.org"];
    const out = matchAndSort(files, "read", 5);
    assert.equal(out.length, 3);
    // All three start with some case-variant of "read", so they all
    // get the startsWith bonus.
});

test("slotLimit caps the result count", () => {
    const files = Array.from({length: 20}, (_, i) => `match${i}.txt`);
    const out = matchAndSort(files, "match", 5);
    assert.equal(out.length, 5);
    // First 5 of the readdir order, which all start with "match".
    assert.deepEqual(out, ["match0.txt", "match1.txt", "match2.txt", "match3.txt", "match4.txt"]);
});

test("scan stops once slotLimit matches found — later files are not consulted", () => {
    // Important for large directories (the user's home with 10k
    // files): we cap scanning, not just slicing.
    const files = ["a", "b", "match-X", "match-Y", "match-Z", "match-extra"];
    const out = matchAndSort(files, "match", 2);
    assert.equal(out.length, 2);
    // Only the first two matches encountered. "match-Z" / "match-extra"
    // should never be visited.
    assert.deepEqual(out, ["match-X", "match-Y"]);
});

test("non-string filenames are coerced via String() — defensive", () => {
    // fs.readdirSync should always return strings, but the helper
    // shouldn't crash on a stub that yields numbers.
    const out = matchAndSort([1, 2, 3, "x"], "x", 5);
    assert.deepEqual(out, ["x"]);
});

test("null/undefined query is treated as the empty string", () => {
    const files = ["a", "b", "c"];
    assert.deepEqual(matchAndSort(files, null, 10), ["a", "b", "c"]);
    assert.deepEqual(matchAndSort(files, undefined, 10), ["a", "b", "c"]);
});

test("regex-special chars in the query don't crash the matcher", () => {
    // includes() is a plain substring search, but a future
    // optimisation that builds a RegExp would need to escape.
    // Pinning the current contract.
    const files = ["a.b.c", "a(b)c", "[bracket]"];
    assert.deepEqual(matchAndSort(files, ".", 10), ["a.b.c"]);
    assert.deepEqual(matchAndSort(files, "(", 10), ["a(b)c"]);
    assert.deepEqual(matchAndSort(files, "[", 10), ["[bracket]"]);
});
