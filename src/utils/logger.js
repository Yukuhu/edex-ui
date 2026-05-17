"use strict";

// Minimal in-repo logger. Drop-in replacement for the parts of
// `signale` the project actually used (13 methods, dispatched both
// statically and dynamically via `signale[type](...)` in
// _boot.js:59). Signale@1.4.0 has been unmaintained since 2019;
// replacing it with this file removes a stale transitive surface
// without adding a new dependency. Issue #172.
//
// Output shape mirrors signale closely enough that anyone watching
// the boot console won't be surprised:
//
//     ✔  success   Settings loaded!
//     ℹ  info      With Node 22.x and Electron 42.x
//     ▶  start     Starting nDEX-UI v3.0.0-SNAPSHOT
//     ⏱  timeEnd   Startup → 1284ms
//
// Colors are ANSI escapes added only when stdout is a TTY (i.e. an
// interactive terminal). In CI / piped contexts they're suppressed
// so the log stays grep-friendly. `NO_COLOR` (per no-color.org) and
// `FORCE_COLOR` are honored.

const { format } = require("node:util");

// ── Color handling ──────────────────────────────────────────────

function shouldColor() {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
    return Boolean(process.stdout && process.stdout.isTTY);
}

const ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    grey: "\x1b[90m"
};

function paint(text, color) {
    if (!shouldColor()) return text;
    return `${ANSI[color] || ""}${text}${ANSI.reset}`;
}

// ── Level table ────────────────────────────────────────────────
//
// Each entry: { symbol, label (padded to 9 chars), color, stream }.
// `stream` picks stdout vs stderr — signale routes warn/error/fatal
// to stderr, and we preserve that so `npm start 2>logfile` still
// captures the real problems.

const STDOUT = "stdout";
const STDERR = "stderr";

const LEVELS = {
    info:     { symbol: "ℹ", label: "info     ", color: "blue",    stream: STDOUT },
    success:  { symbol: "✔", label: "success  ", color: "green",   stream: STDOUT },
    complete: { symbol: "☒", label: "complete ", color: "cyan",    stream: STDOUT },
    pending:  { symbol: "☐", label: "pending  ", color: "magenta", stream: STDOUT },
    start:    { symbol: "▶", label: "start    ", color: "green",   stream: STDOUT },
    watch:    { symbol: "…", label: "watch    ", color: "yellow",  stream: STDOUT },
    note:     { symbol: "✱", label: "note     ", color: "blue",    stream: STDOUT },
    debug:    { symbol: "●", label: "debug    ", color: "grey",    stream: STDOUT },
    warn:     { symbol: "⚠", label: "warning  ", color: "yellow",  stream: STDERR },
    error:    { symbol: "✖", label: "error    ", color: "red",     stream: STDERR },
    fatal:    { symbol: "✖", label: "fatal    ", color: "red",     stream: STDERR }
};

// ── Core emit ──────────────────────────────────────────────────

function emit(levelName, args) {
    const level = LEVELS[levelName];
    if (!level) {
        // Defensive: an unknown `type` arriving via the `log` IPC
        // channel should still surface somewhere, not silently
        // drop. Default to `info` formatting with the actual name
        // in the prefix so we can spot rogue callers.
        const fallback = LEVELS.info;
        const prefix = paint(`${fallback.symbol}  ${levelName.padEnd(9)}`, fallback.color);
        process.stdout.write(`${prefix} ${format(...args)}\n`);
        return;
    }
    const prefix = paint(`${level.symbol}  ${level.label}`, level.color);
    const stream = level.stream === STDERR ? process.stderr : process.stdout;
    stream.write(`${prefix} ${format(...args)}\n`);
}

// ── Public surface ─────────────────────────────────────────────

const logger = {};
for (const name of Object.keys(LEVELS)) {
    logger[name] = (...args) => emit(name, args);
}

// `time(label)` / `timeEnd(label)` — mirrors signale's elapsed-ms
// reporting. The map is process-global; concurrent timers under
// the same label clobber each other (matches signale's behavior).
const timers = new Map();

logger.time = (label = "default") => {
    timers.set(label, process.hrtime.bigint());
    const level = LEVELS.start;
    const prefix = paint(`${level.symbol}  timer    `, level.color);
    process.stdout.write(`${prefix} Initialized timer "${label}"\n`);
};

logger.timeEnd = (label = "default") => {
    const startedAt = timers.get(label);
    if (startedAt === undefined) {
        logger.warn(`timeEnd("${label}") with no matching time() call`);
        return null;
    }
    timers.delete(label);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = LEVELS.complete;
    const prefix = paint(`${level.symbol}  timer    `, level.color);
    process.stdout.write(`${prefix} Timer "${label}" run for: ${ms.toFixed(2)}ms\n`);
    return ms;
};

// Exposed for tests; not part of the documented surface.
logger._timers = timers;
logger._LEVELS = LEVELS;
logger._shouldColor = shouldColor;

module.exports = logger;
