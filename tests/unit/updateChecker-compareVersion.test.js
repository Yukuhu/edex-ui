"use strict";

// Coverage for UpdateChecker._compareVersion — the pure version
// matcher that decides whether the running build is up-to-date,
// running ahead of the latest published release, or behind a new
// release. Issue #175.

const test = require("node:test");
const assert = require("node:assert/strict");

// updateChecker.class.js requires "@electron/remote" at constructor
// load time; the *class declaration* and static methods don't. We
// touch the static surface only, so the bare require is safe.
const { UpdateChecker } = require("../../src/classes/updateChecker.class.js");
const cmp = UpdateChecker._compareVersion;

// ── Latest path ──────────────────────────────────────────────────

test("local version matches the release tag → 'latest'", () => {
    assert.equal(cmp("3.0.0", "v3.0.0"), "latest");
    assert.equal(cmp("1.2.3", "v1.2.3"), "latest");
});

test("local version with '-pre' suffix matches tag → 'latest' iff slice form matches", () => {
    // The legacy contract is `tag.slice(1) === current` — the
    // `-pre` strip on `current` only kicks in for the numeric
    // compare. So "1.2.0-pre" is NOT considered equal to "v1.2.0"
    // at the equality step; it falls through to the numeric branch.
    assert.equal(cmp("1.2.0-pre", "v1.2.0"), "newer");
});

// ── Newer path ───────────────────────────────────────────────────

test("release tag's numeric flattening is greater → 'newer'", () => {
    assert.equal(cmp("1.0.0", "v1.0.1"), "newer");
    assert.equal(cmp("1.2.3", "v2.0.0"), "newer");
});

test("release vastly newer → still 'newer'", () => {
    assert.equal(cmp("0.9.0", "v3.0.0"), "newer");
});

// ── Dev path ─────────────────────────────────────────────────────

test("local version's numeric flattening is greater → 'dev'", () => {
    // i.e. running an unreleased SNAPSHOT ahead of the latest tag.
    assert.equal(cmp("3.1.0", "v3.0.0"), "dev");
    assert.equal(cmp("2.0.0", "v1.9.9"), "dev");
});

test("'-pre' suffix on local is stripped before the numeric compare", () => {
    // "1.2.0-pre" → numeric 120; "v1.1.9" → numeric 119. Local
    // is ahead, so the local build is "dev".
    assert.equal(cmp("1.2.0-pre", "v1.1.9"), "dev");
});

// ── Malformed inputs → null ──────────────────────────────────────

test("non-string inputs return null", () => {
    assert.equal(cmp(undefined, "v1.0.0"), null);
    assert.equal(cmp("1.0.0", undefined), null);
    assert.equal(cmp(null, "v1.0.0"), null);
    assert.equal(cmp("1.0.0", null), null);
    assert.equal(cmp(123, "v1.0.0"), null);
});

test("short tag (no version after the 'v') returns null", () => {
    // tag.slice(1) of "" is "", numeric flattening yields NaN.
    assert.equal(cmp("1.0.0", "v"), null);
    assert.equal(cmp("1.0.0", ""), null);
});

test("non-numeric tag returns null", () => {
    // "vlatest" → slice → "latest" → NaN after Number()
    assert.equal(cmp("1.0.0", "vlatest"), null);
    assert.equal(cmp("1.0.0", "v-abc"), null);
});

test("non-numeric local version returns null", () => {
    assert.equal(cmp("not-a-version", "v1.0.0"), null);
});

// ── Quirks documented (legacy parity) ────────────────────────────

test("legacy numeric flattening doesn't honor positional weight", () => {
    // 1.2.10 → 1210 vs 1.3.0 → 130. The algorithm thinks 1210 > 130,
    // so it concludes the *tag* (1.2.10) is newer than the local
    // (1.3.0) — the well-known upstream eDEX-UI bug. Preserved
    // verbatim; fixing it is its own decision tracked separately.
    assert.equal(cmp("1.3.0", "v1.2.10"), "newer",
        "1.2.10 → 1210 vs 1.3.0 → 130: algorithm thinks tag is ahead → 'newer'");
});

test("tag's leading character is always stripped, even when not 'v'", () => {
    // Documented quirk: the slice(1) is unconditional. A future
    // tag scheme that drops the "v" prefix would silently lose
    // its first digit — and would then numerically flatten to a
    // value below the local version, returning "dev" rather than
    // "latest". This test pins that behavior so any future fix is
    // a deliberate decision.
    assert.equal(cmp("1.0.0", "1.0.0"), "dev",
        "tag '1.0.0' → slice(1) → '.0.0' → numeric 0 — local (100) wins → 'dev'");
});
