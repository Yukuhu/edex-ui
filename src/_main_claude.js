// Main-process bridge to the locally-installed `claude` CLI.
//
// Strategy: spawn `claude -p` in stream-json mode for each user turn,
// pipe the user message on stdin, parse newline-delimited JSON events
// from stdout and forward text deltas + done/error to the renderer via IPC.
//
// Conversation continuity within a modal session is achieved by passing
// the same --session-id (a UUIDv4) to every spawn for that modal.

const { spawn } = require("child_process");
const { ipcMain } = require("electron");

let _cleanEnv = null;
const activeProcs = new Map(); // reqId -> ChildProcess

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

            // System init event carries the model + cwd + session ID.
            if (ev.type === "system" && ev.subtype === "init" && ev.model) {
                sender.send("claude:model", { reqId, model: ev.model });
                continue;
            }

            // Partial-message stream: deltas arrive on `stream_event` blocks.
            if (ev.type === "stream_event" && ev.event && ev.event.type === "content_block_delta") {
                const d = ev.event.delta;
                if (d && d.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
                    sender.send("claude:delta", { reqId, text: d.text });
                    lastEmittedText += d.text;
                }
                continue;
            }

            // Final assistant message: catches anything we missed via deltas.
            if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
                const fullText = ev.message.content
                    .filter(b => b.type === "text")
                    .map(b => b.text || "")
                    .join("");
                if (fullText.length > lastEmittedText.length) {
                    const remainder = fullText.slice(lastEmittedText.length);
                    sender.send("claude:delta", { reqId, text: remainder });
                    lastEmittedText = fullText;
                }
                continue;
            }

            if (ev.type === "result") {
                // Includes usage, is_error, subtype — forward usage to renderer
                sender.send("claude:result", { reqId, result: ev });
            }
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
