"use strict";

// IPC channel name registry.
//
// Every `ipc.send` / `ipc.on` channel literal in `src/_boot.js`,
// `src/_main_claude.js`, `src/_renderer.js`, and the renderer
// classes goes through this module. The original motivation
// (issue #177): typo'd channel strings used to fail silently —
// `ipc.send("ttyspwan")` lands in nobody's handler, no warning,
// no log. With every channel pinned to a single constant, a typo
// becomes a `no-undef` or `TypeError` at load time.
//
// The current channel names are **not** consistent — three
// conventions coexist (`camelCase`, `colon:separated`,
// `hyphen-suffix`). They're frozen as-is here to keep the
// migration zero-risk; renaming is a separate change tracked
// against the project's "Suggested follow-ups" board.
//
// Pure module — no DOM, no electron — so the unit suite can
// import it without booting either process.

// Static channel names. Frozen so an accidental mutation
// (`CHANNELS.TTY_SPAWN = "..."`) throws in strict mode.
const CHANNELS = Object.freeze({
    // Renderer → main: log a line through signale-compatible levels.
    // Payload: `(level, content)` where level ∈ {info, debug, note,
    // error, …} matches the in-repo logger's method names.
    LOG:                    "log",

    // Renderer → main: request a new pty. Payload: ignored ("true"
    // string for historical reasons).
    // Main → renderer: ttyspawn reply on the *same* channel below
    // with "SUCCESS: <port>" or "ERROR: <reason>".
    TTY_SPAWN:              "ttyspawn",
    TTY_SPAWN_REPLY:        "ttyspawn-reply",

    // Theme + keyboard override storage in the main-process
    // userPrefs. Pattern is `get<X>` request + reply on the same
    // channel; `set<X>` is a one-way persist.
    THEME_GET:              "getThemeOverride",
    THEME_SET:              "setThemeOverride",
    KB_GET:                 "getKbOverride",
    KB_SET:                 "setKbOverride",

    // systeminformation worker pool (src/_multithread.js).
    // Renderer → main: `(type, id, ...args)`.
    // Main → renderer reply uses `systeminformationReply(id)` below
    // because the channel name carries the request id.
    SI_CALL:                "systeminformation-call",

    // Claude CLI bridge (src/_main_claude.js).
    // Renderer → main:
    CLAUDE_SEND:            "claude:send",
    CLAUDE_CANCEL:          "claude:cancel",
    // Main → renderer (events streamed back over the same reqId):
    CLAUDE_DELTA:           "claude:delta",
    CLAUDE_DONE:            "claude:done",
    CLAUDE_ERROR:           "claude:error",
    CLAUDE_RESULT:          "claude:result",
    CLAUDE_MODEL:           "claude:model"
});

// Per-request reply channel for the systeminformation worker pool.
// Builds `"systeminformation-reply-<id>"`. Both sides (Proxy in
// _renderer.js and the worker dispatcher in _multithread.js) call
// this so the format only has to be right in one place.
function systeminformationReply(id) {
    return `systeminformation-reply-${id}`;
}

// Per-pty bidirectional channel. Each Terminal instance subscribes
// to its own port-suffixed channel; main-side terminal.class.js
// pushes "New cwd" / "Fallback cwd" / "New process" events on it
// and the renderer sends "Renderer startup" / "Resize" back. The
// `port` value is the TTY's TCP port from `_boot.js`'s ttyspawn
// flow.
function terminalChannel(port) {
    return `terminal_channel-${port}`;
}

module.exports = {
    CHANNELS,
    systeminformationReply,
    terminalChannel
};
