"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// claudeChat.class.js assigns `window.ClaudeChat = ClaudeChat;` at module
// load, so we need a global `window` before `require`-ing it. Electron,
// Modal, AIAvatar, ttsEngine etc. are only touched inside the constructor
// — `_migrateBackend` is static and loads cleanly.
global.window = global.window ?? {};
const { ClaudeChat } = require("../../src/classes/claudeChat.class.js");

test("ClaudeChat._migrateBackend", async (t) => {
    await t.test("migrates the legacy 'gemma' short name to 'gemma-local'", () => {
        assert.equal(ClaudeChat._migrateBackend("gemma"), "gemma-local");
    });
    await t.test("passes 'gemma-local' through unchanged", () => {
        assert.equal(ClaudeChat._migrateBackend("gemma-local"), "gemma-local");
    });
    await t.test("collapses the legacy 'cli' short name to 'claude-cli'", () => {
        assert.equal(ClaudeChat._migrateBackend("cli"), "claude-cli");
    });
    await t.test("passes 'claude-cli' through unchanged", () => {
        assert.equal(ClaudeChat._migrateBackend("claude-cli"), "claude-cli");
    });
    await t.test("falls back to 'claude-cli' for undefined", () => {
        assert.equal(ClaudeChat._migrateBackend(undefined), "claude-cli");
    });
    await t.test("falls back to 'claude-cli' for null", () => {
        assert.equal(ClaudeChat._migrateBackend(null), "claude-cli");
    });
    await t.test("falls back to 'claude-cli' for an empty string", () => {
        assert.equal(ClaudeChat._migrateBackend(""), "claude-cli");
    });
    await t.test("falls back to 'claude-cli' for any unknown identifier", () => {
        assert.equal(ClaudeChat._migrateBackend("openai"), "claude-cli");
        assert.equal(ClaudeChat._migrateBackend("anthropic"), "claude-cli");
        assert.equal(ClaudeChat._migrateBackend("garbage"), "claude-cli");
    });
});
