// Main-process bridge to the locally-installed `claude` CLI.
//
// Strategy: spawn `claude -p` in stream-json mode for each user turn,
// pipe the user message on stdin, parse newline-delimited JSON events
// from stdout and forward text deltas + done/error to the renderer via IPC.
//
// Conversation continuity within a modal session is achieved by passing
// the same --session-id (a UUIDv4) to every spawn for that modal.

const { spawn } = require("node:child_process");
const { ipcMain } = require("electron");

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

    ipcMain.on("claude:send", (e, payload) => {
        const { reqId, sessionId, prompt, firstTurn, model } = payload || {};
        if (!reqId || !prompt) {
            e.sender.send("claude:error", { reqId, message: "Missing reqId or prompt" });
            return;
        }
        runClaude(e.sender, reqId, sessionId, prompt, !!firstTurn, model);
    });

    ipcMain.on("claude:cancel", (e, { reqId } = {}) => {
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
        sender.send("claude:error", { reqId, message: `Failed to spawn claude: ${err.message}` });
        return;
    }
    activeProcs.set(reqId, proc);

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdoutBuf = "";
    let stderrBuf = "";
    let lastEmittedText = "";

    // System init event carries the model + cwd + session ID.
    const handleSystem = (ev) => {
        if (ev.subtype === "init" && ev.model) {
            sender.send("claude:model", { reqId, model: ev.model });
        }
    };

    // Partial-message stream: deltas arrive on `stream_event` blocks.
    const handleStreamEvent = (ev) => {
        if (ev.event?.type !== "content_block_delta") return;
        const d = ev.event.delta;
        if (d?.type !== "text_delta") return;
        if (typeof d.text !== "string" || d.text.length === 0) return;
        sender.send("claude:delta", { reqId, text: d.text });
        lastEmittedText += d.text;
    };

    // Final assistant message: catches anything we missed via deltas.
    const handleAssistant = (ev) => {
        if (!ev.message || !Array.isArray(ev.message.content)) return;
        const fullText = ev.message.content
            .filter(b => b.type === "text")
            .map(b => b.text || "")
            .join("");
        if (fullText.length <= lastEmittedText.length) return;
        const remainder = fullText.slice(lastEmittedText.length);
        sender.send("claude:delta", { reqId, text: remainder });
        lastEmittedText = fullText;
    };

    const dispatchEvent = (ev) => {
        switch (ev.type) {
            case "system": return handleSystem(ev);
            case "stream_event": return handleStreamEvent(ev);
            case "assistant": return handleAssistant(ev);
            case "result":
                // Includes usage, is_error, subtype — forward usage to renderer
                sender.send("claude:result", { reqId, result: ev });
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
        sender.send("claude:error", { reqId, message: err.message });
    });

    proc.on("close", code => {
        activeProcs.delete(reqId);
        if (code !== 0 && lastEmittedText.length === 0) {
            const tail = stderrBuf.trim().split("\n").slice(-5).join("\n") || `exit code ${code}`;
            sender.send("claude:error", { reqId, message: tail });
        } else {
            sender.send("claude:done", { reqId, code });
        }
    });
}

module.exports = { init };
