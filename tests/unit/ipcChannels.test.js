"use strict";

// Coverage for src/ipc/channels.js — the registry that the original
// motivation of issue #177 was about: every `ipc.send` / `ipc.on`
// channel literal in the codebase now flows through this module,
// so a typo in the registry is a single-file bug rather than a
// silently-dropped IPC message.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    CHANNELS,
    systeminformationReply,
    terminalChannel
} = require("../../src/ipc/channels.js");

// ── Structural invariants ────────────────────────────────────────

test("CHANNELS is frozen", () => {
    // `Object.freeze` makes assignment a TypeError in strict mode.
    assert.equal(Object.isFrozen(CHANNELS), true);
    assert.throws(
        () => { CHANNELS.LOG = "nope"; },
        TypeError
    );
});

test("every CHANNELS value is a non-empty string", () => {
    for (const [key, value] of Object.entries(CHANNELS)) {
        assert.equal(typeof value, "string", `${key} should be a string`);
        assert.ok(value.length > 0, `${key} should not be empty`);
    }
});

test("CHANNELS values are unique", () => {
    // Two keys mapping to the same channel literal would mean every
    // sender hits both handlers — a silent foot-gun. Catch it here.
    const seen = new Map();
    for (const [key, value] of Object.entries(CHANNELS)) {
        if (seen.has(value)) {
            assert.fail(`channel ${JSON.stringify(value)} is used by both ${seen.get(value)} and ${key}`);
        }
        seen.set(value, key);
    }
});

test("CHANNELS keys follow SCREAMING_SNAKE_CASE", () => {
    // Cheap convention check — the test catches an inadvertent
    // `Cluade_Send` typo, and it's load-bearing because the renderer
    // uses bare-identifier-ish reference in the static class field.
    for (const key of Object.keys(CHANNELS)) {
        assert.match(key, /^[A-Z][A-Z0-9_]*$/, `key ${key} should be SCREAMING_SNAKE_CASE`);
    }
});

// ── Inventory of expected channels ───────────────────────────────

test("CHANNELS includes every channel name the codebase currently uses", () => {
    // Hard-coded inventory pulled from the pre-extraction grep so any
    // accidental removal during a future refactor is loud.
    const expected = [
        "LOG",
        "TTY_SPAWN", "TTY_SPAWN_REPLY",
        "THEME_GET", "THEME_SET",
        "KB_GET", "KB_SET",
        "SI_CALL",
        "CLAUDE_SEND", "CLAUDE_CANCEL",
        "CLAUDE_DELTA", "CLAUDE_DONE", "CLAUDE_ERROR",
        "CLAUDE_RESULT", "CLAUDE_MODEL"
    ];
    assert.deepEqual(Object.keys(CHANNELS).sort(), expected.sort());
});

// ── Static channel name parity (preserve current wire format) ────

test("static channel values match the pre-#177 wire format verbatim", () => {
    // Renaming is intentionally out of scope for this PR (zero-risk
    // migration). Pinning each value so a future rename PR is loud.
    assert.equal(CHANNELS.LOG,             "log");
    assert.equal(CHANNELS.TTY_SPAWN,       "ttyspawn");
    assert.equal(CHANNELS.TTY_SPAWN_REPLY, "ttyspawn-reply");
    assert.equal(CHANNELS.THEME_GET,       "getThemeOverride");
    assert.equal(CHANNELS.THEME_SET,       "setThemeOverride");
    assert.equal(CHANNELS.KB_GET,          "getKbOverride");
    assert.equal(CHANNELS.KB_SET,          "setKbOverride");
    assert.equal(CHANNELS.SI_CALL,         "systeminformation-call");
    assert.equal(CHANNELS.CLAUDE_SEND,     "claude:send");
    assert.equal(CHANNELS.CLAUDE_CANCEL,   "claude:cancel");
    assert.equal(CHANNELS.CLAUDE_DELTA,    "claude:delta");
    assert.equal(CHANNELS.CLAUDE_DONE,     "claude:done");
    assert.equal(CHANNELS.CLAUDE_ERROR,    "claude:error");
    assert.equal(CHANNELS.CLAUDE_RESULT,   "claude:result");
    assert.equal(CHANNELS.CLAUDE_MODEL,    "claude:model");
});

// ── Dynamic-channel factories ────────────────────────────────────

test("systeminformationReply(id) produces the same wire format both sides expect", () => {
    assert.equal(systeminformationReply("abc-123"), "systeminformation-reply-abc-123");
    assert.equal(systeminformationReply(0), "systeminformation-reply-0");
});

test("terminalChannel(port) produces the same wire format both sides expect", () => {
    assert.equal(terminalChannel(3000), "terminal_channel-3000");
    assert.equal(terminalChannel(3001), "terminal_channel-3001");
});

test("factories return distinct channels for distinct inputs", () => {
    // Defends against an accidental refactor that drops the
    // parameter from the template literal (which would make every
    // pty share one channel — a great way to leak output between
    // terminals).
    assert.notEqual(terminalChannel(3000), terminalChannel(3001));
    assert.notEqual(systeminformationReply("a"), systeminformationReply("b"));
});
