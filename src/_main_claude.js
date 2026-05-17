// Main-process bridge to the locally-installed `claude` CLI.
//
// Strategy: spawn `claude -p` in stream-json mode for each user turn,
// pipe the user message on stdin, parse newline-delimited JSON events
// from stdout and forward text deltas + done/error to the renderer via IPC.
//
// Conversation continuity within a modal session is achieved by passing
// the same --session-id (a UUIDv4) to every spawn for that modal.

"use strict";
// @ts-check

/** @typedef {import("./ipc/channels.js").ClaudeSendPayload}   ClaudeSendPayload */
/** @typedef {import("./ipc/channels.js").ClaudeDeltaPayload}  ClaudeDeltaPayload */
/** @typedef {import("./ipc/channels.js").ClaudeDonePayload}   ClaudeDonePayload */
/** @typedef {import("./ipc/channels.js").ClaudeErrorPayload}  ClaudeErrorPayload */
/** @typedef {import("./ipc/channels.js").ClaudeResultPayload} ClaudeResultPayload */
/** @typedef {import("./ipc/channels.js").ClaudeModelPayload}  ClaudeModelPayload */
/** @typedef {import("./ipc/channels.js").ClaudeCancelPayload} ClaudeCancelPayload */

const { spawn } = require("node:child_process");
const { ipcMain } = require("electron");
const { CHANNELS } = require("./ipc/channels.js");

// Typed-sender helpers. Electron's `webContents.send(channel, ...args)`
// takes `any[]`, so without these wrappers the IPC payload typedefs
// in src/ipc/channels.js would only catch protocol drift on the
// *receiver* side. With them, every send site through this module
// is validated against the typedef at typecheck time. Issue #195.
//
// The helpers are intentionally narrow — one per channel — so an
// unrelated CLAUDE_* channel can't accidentally be passed a payload
// shaped for a different one.
/**
 * @param {Electron.WebContents} sender
 * @param {ClaudeDeltaPayload} payload
 */
function sendDelta(sender, payload)  { sender.send(CHANNELS.CLAUDE_DELTA, payload); }
/**
 * @param {Electron.WebContents} sender
 * @param {ClaudeDonePayload} payload
 */
function sendDone(sender, payload)   { sender.send(CHANNELS.CLAUDE_DONE, payload); }
/**
 * @param {Electron.WebContents} sender
 * @param {ClaudeErrorPayload} payload
 */
function sendError(sender, payload)  { sender.send(CHANNELS.CLAUDE_ERROR, payload); }
/**
 * @param {Electron.WebContents} sender
 * @param {ClaudeResultPayload} payload
 */
function sendResult(sender, payload) { sender.send(CHANNELS.CLAUDE_RESULT, payload); }
/**
 * @param {Electron.WebContents} sender
 * @param {ClaudeModelPayload} payload
 */
function sendModel(sender, payload)  { sender.send(CHANNELS.CLAUDE_MODEL, payload); }

let _cleanEnv = null;
const activeProcs = new Map(); // reqId -> ChildProcess

// System prompt for the chat modal. Fully replaces the default
// Claude Code coding-agent prompt via --system-prompt, so the chat
// reads as a friendly assistant instead of as a coding session.
const CHAT_PERSONA_PROMPT = `
You are a friendly, conversational AI assistant embedded inside the nDEX-UI sci-fi terminal interface. Think "helpful companion" — knowledge questions, brainstorming, casual conversation, advice, planning, general curiosity.

You are NOT a coding agent. You are NOT in a development workflow. The user is chatting with you in a small popup window. They have not asked you to operate on files, run commands, or autonomously do tasks. Don't offer to. If they explicitly ask for code or technical help, answer in plain prose; you do not have a working directory, a repository, or shell access in this context.

Web access is already enabled. You have WebSearch and WebFetch available and pre-authorized for this chat — use them freely and silently whenever the user asks about current events, news, weather, prices, sports, recent developments, or anything time-sensitive or beyond your training cutoff. Do NOT ask the user for permission to search; the answer is already yes. Do NOT preface your reply with disclaimers like "my training data may be out of date" or "let me search for that" — just search and give the answer. Do NOT list the URLs you visited in your reply text; the UI extracts and displays sources separately, so plain prose without inline citation markers is best.

How to respond:
- Be concise and natural. Short responses are usually better. Expand only when the user asks for detail.
- Plain prose. No markdown headers, no bullet lists unless genuinely necessary, no code fences unless they asked for code. Your output is displayed in a small monospace modal and may be read aloud by text-to-speech.
- Sound human: speak directly, no "I'd be happy to help with that!" filler, no enumerating what you're about to say.
- Don't mention tools you can't use or workflows that aren't available in this chat context. Just answer with what you can.
- If you genuinely don't know something and a search wouldn't help, say so simply.
`.trim();

// Tools the chat assistant should never reach for.
const DISALLOWED_TOOLS = [
    "Bash", "Edit", "Write", "Read", "Glob", "Grep",
    "NotebookEdit", "Task", "TodoWrite"
];

// Tools the assistant IS allowed to use — pre-approved so claude -p
// doesn't auto-deny them in non-interactive mode.
const ALLOWED_TOOLS = ["WebSearch", "WebFetch"];

function init({ cleanEnv }) {
    _cleanEnv = cleanEnv || process.env;

    ipcMain.on(CHANNELS.CLAUDE_SEND, (e, /** @type {ClaudeSendPayload} */ payload) => {
        const { reqId, sessionId, prompt, firstTurn, model } = payload || {};
        if (!reqId || !prompt) {
            sendError(e.sender, { reqId, message: "Missing reqId or prompt" });
            return;
        }
        runClaude(e.sender, reqId, sessionId, prompt, !!firstTurn, model);
    });

    ipcMain.on(CHANNELS.CLAUDE_CANCEL, (e, /** @type {ClaudeCancelPayload} */ { reqId } = { reqId: "" }) => {
        const proc = activeProcs.get(reqId);
        if (proc) {
            try { proc.kill("SIGTERM"); } catch (_) {}
        }
    });
}

function runClaude(sender, reqId, sessionId, prompt, firstTurn, model) {
    const args = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--disallowedTools", DISALLOWED_TOOLS.join(" "),
        "--allowedTools", ALLOWED_TOOLS.join(" "),
        // Persona only applies on the first turn — once the session is
        // established, --resume picks up the same configuration so
        // re-passing it would be redundant (and is in fact rejected by
        // claude when combined with --resume).
        ...(firstTurn ? ["--system-prompt", CHAT_PERSONA_PROMPT] : []),
    ];
    if (model) {
        args.push("--model", model);
    }
    if (sessionId) {
        // First turn: create the session with this UUID.
        // Follow-up turns: resume it (claude rejects --session-id reuse).
        args.push(firstTurn ? "--session-id" : "--resume", sessionId);
    }

    let proc;
    try {
        proc = spawn("claude", args, {
            env: _cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (err) {
        sendError(sender, { reqId, message: `Failed to spawn claude: ${err.message}` });
        return;
    }
    activeProcs.set(reqId, proc);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdoutBuf = "";
    let stderrBuf = "";
    let lastEmittedText = "";

    // System init event carries the model + cwd + session ID.
    const handleSystem = (/** @type {any} */ ev) => {
        if (ev.subtype === "init" && ev.model) {
            sendModel(sender, { reqId, model: ev.model });
        }
    };

    // Partial-message stream: deltas arrive on `stream_event` blocks.
    const handleStreamEvent = (/** @type {any} */ ev) => {
        if (ev.event?.type !== "content_block_delta") return;
        const d = ev.event.delta;
        if (d?.type !== "text_delta") return;
        if (typeof d.text !== "string" || d.text.length === 0) return;
        sendDelta(sender, { reqId, text: d.text });
        lastEmittedText += d.text;
    };

    // Final assistant message: catches anything we missed via deltas.
    const handleAssistant = (/** @type {any} */ ev) => {
        if (!ev.message || !Array.isArray(ev.message.content)) return;
        const fullText = ev.message.content
            .filter((/** @type {any} */ b) => b.type === "text")
            .map((/** @type {any} */ b) => b.text || "")
            .join("");
        if (fullText.length <= lastEmittedText.length) return;
        const remainder = fullText.slice(lastEmittedText.length);
        sendDelta(sender, { reqId, text: remainder });
        lastEmittedText = fullText;
    };

    const dispatchEvent = (/** @type {any} */ ev) => {
        switch (ev.type) {
            case "system": return handleSystem(ev);
            case "stream_event": return handleStreamEvent(ev);
            case "assistant": return handleAssistant(ev);
            case "result":
                // Includes usage, is_error, subtype — forward usage to renderer
                sendResult(sender, { reqId, result: ev });
                return;
        }
    };

    proc.stdout.on("data", chunk => {
        stdoutBuf += chunk.toString();
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line.trim()) continue;
            let ev;
            try { ev = JSON.parse(line); }
            catch (_) { continue; }
            dispatchEvent(ev);
        }
    });

    proc.stderr.on("data", chunk => {
        stderrBuf += chunk.toString();
    });

    proc.on("error", err => {
        activeProcs.delete(reqId);
        sendError(sender, { reqId, message: err.message });
    });

    proc.on("close", code => {
        activeProcs.delete(reqId);
        if (code !== 0 && lastEmittedText.length === 0) {
            const tail = stderrBuf.trim().split("\n").slice(-5).join("\n") || `exit code ${code}`;
            sendError(sender, { reqId, message: tail });
        } else {
            sendDone(sender, { reqId, code: code ?? 0 });
        }
    });
}

module.exports = { init };
