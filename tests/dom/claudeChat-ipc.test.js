"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");
const { mockIpcRenderer } = require("../helpers/mockElectron.js");

// claudeChat.class.js writes `window.ClaudeChat` at module load.
global.window = global.window ?? {};
const { ClaudeChat } = require("../../src/classes/claudeChat.class.js");

// Build a ClaudeChat-ish test subject good enough for `_wireIpc()`
// and the resulting handler bodies. Uses real jsdom DOM elements so
// `bubble.querySelector("pre")` + textContent mutations behave like
// they would in the renderer. Each chat-instance method the handlers
// call is replaced with a call-tracking stub so we can assert what
// happened without doing any real work (no real `_extractSources`,
// no real `_speak`, etc.).
function makeChat({
    pendingReqId = "req-1",
    voiceEnabled = false,
    ttsAvailable = false,
    avatarState = "thinking",
    extractSourcesReturn = null,        // override _extractSources output
    ttsFinishReturn = false              // false = not streaming
} = {}) {
    const chat = Object.create(ClaudeChat.prototype);

    chat.ipc = mockIpcRenderer();
    chat.pendingReqId = pendingReqId;
    chat.model = ClaudeChat.DEFAULT_MODEL;
    chat.firstTurn = true;
    chat.activeAssistantBuf = "";
    chat.voiceEnabled = voiceEnabled;
    chat._perf = null;
    chat._ttsStreamActive = false;

    // DOM bits the handlers mutate / read.
    chat.status = document.createElement("div");
    chat.modelName = document.createElement("span");
    chat.activeAssistantBubble = document.createElement("div");
    const pre = document.createElement("pre");
    chat.activeAssistantBubble.appendChild(pre);

    // Stubbed methods — each push their call args into `chat.calls`.
    chat.calls = {};
    const stub = (name, impl) => (...args) => {
        chat.calls[name] = chat.calls[name] || [];
        chat.calls[name].push(args);
        return impl ? impl(...args) : undefined;
    };
    chat._appendAssistantText = stub("_appendAssistantText", (text) => {
        chat.activeAssistantBuf += text || "";
    });
    chat._drainPending = stub("_drainPending");
    chat._extractSources = stub("_extractSources", (buf) =>
        extractSourcesReturn || { cleaned: buf, sources: [] });
    chat._attachSourcesIcon = stub("_attachSourcesIcon");
    chat._appendErrorLine = stub("_appendErrorLine");
    chat._finalizeAssistant = stub("_finalizeAssistant");
    chat._ttsBegin = stub("_ttsBegin");
    chat._ttsPushTail = stub("_ttsPushTail");
    chat._ttsFinish = stub("_ttsFinish", () => ttsFinishReturn);
    chat._speak = stub("_speak");

    // Avatar stub — has its own setState that mutates state for inspection.
    chat.avatar = {
        state: avatarState,
        setState(s) { this.state = s; }
    };

    window.ttsEngine = { isAvailable: ttsAvailable };

    chat._wireIpc();
    return chat;
}

// Small helper to fire an IPC channel synchronously through the mock.
function emit(chat, channel, payload) {
    chat.ipc._emit(channel, payload);
}

// ---------------------------------------------------------------------
// _onDelta
// ---------------------------------------------------------------------

test("_onDelta: ignores deltas with the wrong reqId", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ pendingReqId: "req-X" });
    emit(chat, "claude:delta", { reqId: "DIFFERENT", text: "ignored" });
    assert.equal(chat.calls._appendAssistantText, undefined);
});

test("_onDelta: ignores deltas when there's no pendingReqId at all", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ pendingReqId: null });
    emit(chat, "claude:delta", { reqId: "req-1", text: "ignored" });
    assert.equal(chat.calls._appendAssistantText, undefined);
});

test("_onDelta: matching reqId appends the text", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:delta", { reqId: "req-1", text: "Hello, " });
    emit(chat, "claude:delta", { reqId: "req-1", text: "world." });
    assert.deepEqual(chat.calls._appendAssistantText, [["Hello, "], ["world."]]);
    assert.equal(chat.activeAssistantBuf, "Hello, world.");
});

test("_onDelta: payload.text=undefined is treated as empty string", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:delta", { reqId: "req-1" });
    assert.deepEqual(chat.calls._appendAssistantText, [[""]]);
});

test("_onDelta: avatar transitions thinking → responding on first delta", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ avatarState: "thinking" });
    emit(chat, "claude:delta", { reqId: "req-1", text: "x" });
    assert.equal(chat.avatar.state, "responding");
});

test("_onDelta: avatar in non-thinking state is left alone", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ avatarState: "responding" });
    emit(chat, "claude:delta", { reqId: "req-1", text: "x" });
    assert.equal(chat.avatar.state, "responding");
});

test("_onDelta: voice off → no TTS calls", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ voiceEnabled: false, ttsAvailable: true });
    emit(chat, "claude:delta", { reqId: "req-1", text: "x" });
    assert.equal(chat.calls._ttsBegin, undefined);
    assert.equal(chat.calls._ttsPushTail, undefined);
});

test("_onDelta: voice on but ttsEngine unavailable → no TTS calls", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ voiceEnabled: true, ttsAvailable: false });
    emit(chat, "claude:delta", { reqId: "req-1", text: "x" });
    assert.equal(chat.calls._ttsBegin, undefined);
});

test("_onDelta: voice on AND tts available → _ttsBegin + _ttsPushTail fire", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ voiceEnabled: true, ttsAvailable: true });
    emit(chat, "claude:delta", { reqId: "req-1", text: "x" });
    assert.equal(chat.calls._ttsBegin?.length, 1);
    assert.equal(chat.calls._ttsPushTail?.length, 1);
});

test("_onDelta: sets _perf.firstDeltaT on first delta when _perf exists", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    chat._perf = { firstDeltaT: null };
    emit(chat, "claude:delta", { reqId: "req-1", text: "x" });
    assert.equal(typeof chat._perf.firstDeltaT, "number");
});

// ---------------------------------------------------------------------
// _onDone
// ---------------------------------------------------------------------

test("_onDone: ignores done with the wrong reqId", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:done", { reqId: "DIFFERENT" });
    assert.equal(chat.calls._drainPending, undefined);
});

test("_onDone: extracts sources, paints cleaned text on the bubble, finalises", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({
        extractSourcesReturn: { cleaned: "Hello.", sources: [] }
    });
    chat.activeAssistantBuf = "Hello.\n\nSources:\nhttps://x.com";
    emit(chat, "claude:done", { reqId: "req-1" });
    assert.equal(chat.calls._drainPending.length, 1);
    assert.equal(chat.calls._extractSources.length, 1);
    assert.equal(chat.activeAssistantBubble.querySelector("pre").textContent, "Hello.");
    assert.equal(chat.calls._finalizeAssistant.length, 1);
    assert.equal(chat.firstTurn, false);
    assert.equal(chat.status.innerText, "Ready.");
});

test("_onDone: attaches sources icon ONLY when sources are non-empty", (t) => {
    t.after(teardownDom);
    setupDom();
    const withSources = makeChat({
        extractSourcesReturn: { cleaned: "Hello.", sources: [{ url: "https://x", label: "x" }] }
    });
    emit(withSources, "claude:done", { reqId: "req-1" });
    assert.equal(withSources.calls._attachSourcesIcon.length, 1);

    const without = makeChat({
        extractSourcesReturn: { cleaned: "Hello.", sources: [] }
    });
    emit(without, "claude:done", { reqId: "req-1" });
    assert.equal(without.calls._attachSourcesIcon, undefined);
});

test("_onDone: streaming TTS → no fallback _speak", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({ voiceEnabled: true, ttsFinishReturn: true });
    emit(chat, "claude:done", { reqId: "req-1" });
    assert.equal(chat.calls._speak, undefined);
});

test("_onDone: NOT streaming + voice on + non-empty content → _speak(cleaned)", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({
        voiceEnabled: true,
        ttsFinishReturn: false,
        extractSourcesReturn: { cleaned: "Hello world.", sources: [] }
    });
    emit(chat, "claude:done", { reqId: "req-1" });
    assert.equal(chat.calls._speak?.length, 1);
    assert.equal(chat.calls._speak[0][0], "Hello world.");
});

test("_onDone: NOT streaming + voice off → avatar.setState('idle')", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat({
        voiceEnabled: false,
        ttsFinishReturn: false,
        avatarState: "responding",
        extractSourcesReturn: { cleaned: "Hi.", sources: [] }
    });
    emit(chat, "claude:done", { reqId: "req-1" });
    assert.equal(chat.avatar.state, "idle");
});

// ---------------------------------------------------------------------
// _onError
// ---------------------------------------------------------------------

test("_onError: ignores errors with the wrong reqId", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:error", { reqId: "DIFFERENT", message: "boom" });
    assert.equal(chat.calls._appendErrorLine, undefined);
});

test("_onError: matching reqId — appends error line, status='Error.', avatar='error'", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:error", { reqId: "req-1", message: "spawn ENOENT" });
    assert.deepEqual(chat.calls._appendErrorLine[0], ["spawn ENOENT"]);
    assert.equal(chat.calls._finalizeAssistant.length, 1);
    assert.equal(chat.status.innerText, "Error.");
    assert.equal(chat.avatar.state, "error");
});

test("_onError: missing message defaults to 'Unknown error'", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:error", { reqId: "req-1" });
    assert.deepEqual(chat.calls._appendErrorLine[0], ["Unknown error"]);
});

// ---------------------------------------------------------------------
// _onResult
// ---------------------------------------------------------------------

test("_onResult: ignores results with the wrong reqId", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    chat.status.innerText = "untouched";
    emit(chat, "claude:result", { reqId: "DIFFERENT", result: { usage: { input_tokens: 1 } } });
    assert.equal(chat.status.innerText, "untouched");
});

test("_onResult: writes 'Done. N tokens (in I / out O).' from usage", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:result", {
        reqId: "req-1",
        result: { usage: { input_tokens: 42, output_tokens: 7 } }
    });
    assert.equal(chat.status.innerText, "Done. 49 tokens (in 42 / out 7).");
});

test("_onResult: result without `usage` is silently ignored", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    chat.status.innerText = "Working.";
    emit(chat, "claude:result", { reqId: "req-1", result: {} });
    assert.equal(chat.status.innerText, "Working.");   // unchanged
});

// ---------------------------------------------------------------------
// _onModel
// ---------------------------------------------------------------------

test("_onModel: ignores model updates with the wrong reqId", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    const oldModel = chat.model;
    emit(chat, "claude:model", { reqId: "DIFFERENT", model: "claude-opus-4-7" });
    assert.equal(chat.model, oldModel);
});

test("_onModel: same model is a no-op (no DOM mutation)", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    chat.modelName.textContent = "ORIGINAL";
    emit(chat, "claude:model", { reqId: "req-1", model: chat.model });
    assert.equal(chat.modelName.textContent, "ORIGINAL");
});

test("_onModel: different model updates this.model and modelName.textContent", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    emit(chat, "claude:model", { reqId: "req-1", model: "claude-opus-4-7" });
    assert.equal(chat.model, "claude-opus-4-7");
    assert.equal(chat.modelName.textContent, "claude-opus-4-7");
});

test("_onModel: empty model is treated as falsy and ignored", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    const oldModel = chat.model;
    emit(chat, "claude:model", { reqId: "req-1", model: "" });
    assert.equal(chat.model, oldModel);
});

// ---------------------------------------------------------------------
// _wireIpc: every channel has a single listener after wiring
// ---------------------------------------------------------------------

test("_wireIpc: registers exactly one handler per claude:* channel", (t) => {
    t.after(teardownDom);
    setupDom();
    const chat = makeChat();
    const channels = chat.ipc._channels();
    assert.deepEqual(
        channels.sort(),
        ["claude:delta", "claude:done", "claude:error", "claude:model", "claude:result"]
    );
    for (const c of channels) {
        assert.equal(chat.ipc._handlers.get(c).length, 1, `${c} should have exactly 1 handler`);
    }
});
