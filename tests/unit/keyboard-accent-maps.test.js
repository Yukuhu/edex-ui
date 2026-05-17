"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// keyboard.class.js doesn't write to `window` at module load, but it
// reads layout JSON inside the constructor (via require("node:fs")).
// We only exercise static maps + instance methods that don't touch
// the constructor, so a fresh `Object.create(Keyboard.prototype)`
// works as a test subject without invoking `new Keyboard()`.
const { Keyboard } = require("../../src/classes/keyboard.class.js");

// Each entry: [methodName, staticMapName]. Order mirrors
// DEAD_KEY_TRANSFORMS so anyone adding a new dead-key can keep the
// list in sync.
const ACCENT_PAIRS = [
    ["addCircum",   "CIRCUM_MAP"],
    ["addTrema",    "TREMA_MAP"],
    ["addAcute",    "ACUTE_MAP"],
    ["addGrave",    "GRAVE_MAP"],
    ["addCaron",    "CARON_MAP"],
    ["addBar",      "BAR_MAP"],
    ["addBreve",    "BREVE_MAP"],
    ["addTilde",    "TILDE_MAP"],
    ["addMacron",   "MACRON_MAP"],
    ["addCedilla",  "CEDILLA_MAP"],
    ["addOverring", "OVERRING_MAP"],
    ["toGreek",     "GREEK_MAP"],
    ["addIotasub",  "IOTASUB_MAP"]
];

const instance = Object.create(Keyboard.prototype);

// Inputs that should always fall through to "return char unchanged":
// neither letters used in any of the accent maps, nor control bytes,
// nor multi-char strings, nor the empty string. We use space, digits,
// punctuation, and a couple of non-ASCII characters that no map
// covers.
const UNMAPPED_INPUTS = [" ", "!", "?", ".", ",", ";", "/", "\\", "\x00", "\x1B", "\x08", "ab", "", "ñ", "中"];

test("each accent-pair lookup table is well-formed", async (t) => {
    for (const [method, mapName] of ACCENT_PAIRS) {
        await t.test(`${mapName} is a non-empty object`, () => {
            const m = Keyboard[mapName];
            assert.ok(m && typeof m === "object", `${mapName} must exist`);
            assert.ok(Object.keys(m).length > 0, `${mapName} must have entries`);
        });
        await t.test(`${mapName} has no empty/no-op/null values`, () => {
            const m = Keyboard[mapName];
            for (const [k, v] of Object.entries(m)) {
                assert.equal(typeof v, "string", `${mapName}[${JSON.stringify(k)}] must be a string`);
                assert.notEqual(v, "", `${mapName}[${JSON.stringify(k)}] is empty`);
                assert.notEqual(v, k, `${mapName}[${JSON.stringify(k)}] equals its key (no-op entry)`);
            }
        });
        await t.test(`${method} is an instance method`, () => {
            assert.equal(typeof Keyboard.prototype[method], "function");
        });
    }
});

test("addX round-trips every key in its map", async (t) => {
    for (const [method, mapName] of ACCENT_PAIRS) {
        await t.test(`${method} returns the mapped value for every ${mapName} entry`, () => {
            const m = Keyboard[mapName];
            for (const [k, expected] of Object.entries(m)) {
                assert.equal(instance[method](k), expected, `${method}(${JSON.stringify(k)})`);
            }
        });
    }
});

test("addX returns char unchanged for unmapped inputs", async (t) => {
    for (const [method, mapName] of ACCENT_PAIRS) {
        await t.test(`${method} falls through for inputs outside ${mapName}`, () => {
            const m = Keyboard[mapName];
            for (const input of UNMAPPED_INPUTS) {
                if (input in m) continue; // some unmapped-by-default char might happen to be in a map
                assert.equal(instance[method](input), input, `${method}(${JSON.stringify(input)})`);
            }
        });
    }
});

// Spot-checks for documented edge cases. These read like worked
// examples and would fail loudly if anyone reshuffled the map values
// (e.g. another sticky-cedilla-style typo where two keys swap their
// targets).

test("addCircum: documented Esperanto + superscript-digit coverage", () => {
    // Esperanto letters with circumflex (the historical reason the map exists).
    assert.equal(instance.addCircum("c"), "ĉ");
    assert.equal(instance.addCircum("g"), "ĝ");
    assert.equal(instance.addCircum("h"), "ĥ");
    assert.equal(instance.addCircum("j"), "ĵ");
    assert.equal(instance.addCircum("s"), "ŝ");
    assert.equal(instance.addCircum("u"), "û"); // note: û in CIRCUM_MAP, distinct from ŭ in BREVE_MAP
    // Superscript digits — the "doubles as superscript" pun.
    assert.equal(instance.addCircum("0"), "⁰");
    assert.equal(instance.addCircum("1"), "¹");
    assert.equal(instance.addCircum("2"), "²");
    assert.equal(instance.addCircum("9"), "⁹");
});

test("addBreve: ŭ vs û distinction (breve produces ŭ, NOT û)", () => {
    // This was the kind of error the sticky-cedilla bug was an instance
    // of — two related-but-different mappings sharing a target. Pin them.
    assert.equal(instance.addBreve("u"), "ŭ");
    assert.equal(instance.addBreve("U"), "Ŭ");
    assert.notEqual(instance.addBreve("u"), instance.addCircum("u"));
});

test("addCedilla: every cased letter pair maps consistently", () => {
    // Cedilla coverage was 22 entries — ~11 letter pairs. Asserting
    // the case-pair invariant catches the kind of copy/paste error
    // that originally produced the sticky-cedilla typo (one entry's
    // mutation accidentally swapped).
    const m = Keyboard.CEDILLA_MAP;
    for (const k of Object.keys(m)) {
        if (k !== k.toLowerCase()) continue; // only walk the lowercase keys
        const upper = k.toUpperCase();
        if (!(upper in m)) continue; // not every letter has both halves
        assert.equal(m[k].toUpperCase(), m[upper], `cedilla case mismatch for ${k}/${upper}`);
    }
});

test("addOverring: documented entries map correctly", () => {
    // Upper-case W and Y with ring above don't exist as precomposed
    // Unicode characters, so OVERRING_MAP only has the lowercase w/y.
    // Asserting the lowercase-only asymmetry pins the current state.
    assert.equal(instance.addOverring("a"), "å");
    assert.equal(instance.addOverring("A"), "Å");
    assert.equal(instance.addOverring("u"), "ů");
    assert.equal(instance.addOverring("U"), "Ů");
    assert.equal(instance.addOverring("w"), "ẘ");
    assert.equal(instance.addOverring("y"), "ẙ");
    assert.equal(instance.addOverring("W"), "W"); // no precomposed; falls through
    assert.equal(instance.addOverring("Y"), "Y"); // no precomposed; falls through
});

test("toGreek: every Latin letter has both case pairs (#148)", () => {
    // #148 closed the case-asymmetric gaps in the pre-fork switch
    // (e.g. `A → α` mapping uppercase to lowercase, and most letters
    // having only one half of the pair). Every Latin letter the map
    // covers must now have both cases pointing at the same-case Greek
    // letter.
    const m = Keyboard.GREEK_MAP;
    for (const k of Object.keys(m)) {
        if (k !== k.toLowerCase()) continue;
        const upper = k.toUpperCase();
        assert.ok(upper in m, `GREEK_MAP missing uppercase pair for ${k}`);
        assert.equal(m[k].toUpperCase(), m[upper], `GREEK_MAP case mismatch for ${k}/${upper}`);
    }
});

test("toGreek: documented sample of Latin → Greek mappings", () => {
    assert.equal(instance.toGreek("a"), "α");
    assert.equal(instance.toGreek("A"), "Α");
    assert.equal(instance.toGreek("b"), "β");
    assert.equal(instance.toGreek("w"), "ω");
    assert.equal(instance.toGreek("W"), "Ω");
    assert.equal(instance.toGreek("j"), "θ"); // j is the phonetic stand-in for theta
    assert.equal(instance.toGreek("q"), "χ"); // q is the phonetic stand-in for chi
});

test("addIotasub: the 10 documented Greek vowels round-trip", () => {
    // IOTASUB_MAP had exactly 10 entries — pin them.
    const m = Keyboard.IOTASUB_MAP;
    assert.equal(Object.keys(m).length, 10);
    for (const k of Object.keys(m)) {
        assert.equal(instance.addIotasub(k), m[k]);
    }
});
