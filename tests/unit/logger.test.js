"use strict";

// Coverage for src/utils/logger.js — the in-repo replacement for
// the unmaintained `signale` package. Pinning the method surface
// matters because _boot.js dispatches dynamically
// (`signale[type](content)` on the `log` IPC channel) — adding a
// new level without exposing it here would silently break logging
// in production.
//
// Issue #172.

const test = require("node:test");
const assert = require("node:assert/strict");

// Disable colors before requiring; shouldColor() reads NO_COLOR at
// each call, but pinning here keeps the captured output stable
// across environments (e.g. local TTY vs CI).
process.env.NO_COLOR = "1";

const logger = require("../../src/utils/logger.js");

// ── Capture helpers ─────────────────────────────────────────────

function captureStreams(fn) {
    const out = [];
    const err = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = chunk => { out.push(String(chunk)); return true; };
    process.stderr.write = chunk => { err.push(String(chunk)); return true; };
    try {
        fn();
    } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
    }
    return { out: out.join(""), err: err.join("") };
}

// ── Method surface ──────────────────────────────────────────────

test("logger exposes the signale methods _boot.js relies on", () => {
    // The dynamic-dispatch site `signale[type](content)` in _boot.js
    // accepts `type` from the renderer's `log` IPC. Every value any
    // sender currently emits must resolve to a function.
    const required = [
        "info", "success", "complete", "pending", "start", "watch",
        "note", "debug", "warn", "error", "fatal",
        "time", "timeEnd"
    ];
    for (const name of required) {
        assert.equal(typeof logger[name], "function", `missing logger.${name}`);
    }
});

// ── Stream routing ──────────────────────────────────────────────

test("info/success/start/etc. write to stdout", () => {
    const { out, err } = captureStreams(() => {
        logger.info("hello");
        logger.success("ok");
        logger.start("go");
        logger.pending("wait");
    });
    assert.match(out, /hello/);
    assert.match(out, /ok/);
    assert.match(out, /go/);
    assert.match(out, /wait/);
    assert.equal(err, "");
});

test("warn/error/fatal write to stderr (matches signale routing)", () => {
    const { out, err } = captureStreams(() => {
        logger.warn("careful");
        logger.error("broken");
        logger.fatal("dead");
    });
    assert.equal(out, "");
    assert.match(err, /careful/);
    assert.match(err, /broken/);
    assert.match(err, /dead/);
});

// ── Format / level labels ───────────────────────────────────────

test("each level includes its name in the prefix", () => {
    const { out, err } = captureStreams(() => {
        logger.info("a");
        logger.warn("b");
        logger.error("c");
    });
    assert.match(out, /info/);
    assert.match(err, /warning/);
    assert.match(err, /error/);
});

test("util.format-style multi-arg calls work like console.log", () => {
    const { out } = captureStreams(() => {
        logger.info("Terminal exited", 0, null);
    });
    assert.match(out, /Terminal exited 0 null/);
});

// ── time / timeEnd ──────────────────────────────────────────────

test("time + timeEnd reports elapsed ms and clears the timer", () => {
    const { out } = captureStreams(() => {
        logger.time("startup");
        logger.timeEnd("startup");
    });
    assert.match(out, /Initialized timer "startup"/);
    assert.match(out, /Timer "startup" run for: \d+\.\d+ms/);
    assert.equal(logger._timers.has("startup"), false);
});

test("timeEnd without a matching time logs a warning, returns null", () => {
    let returned;
    const { err } = captureStreams(() => {
        returned = logger.timeEnd("nope");
    });
    assert.equal(returned, null);
    assert.match(err, /no matching time/);
});

test("time/timeEnd use a default label when called without args", () => {
    const { out } = captureStreams(() => {
        logger.time();
        logger.timeEnd();
    });
    assert.match(out, /"default"/);
});

// ── Color suppression ───────────────────────────────────────────

test("NO_COLOR=1 strips ANSI escape sequences from output", () => {
    // shouldColor() is read on every emit, so flipping the env
    // here is sufficient — no module re-require needed.
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const { out } = captureStreams(() => {
        logger.info("plain");
    });
    process.env.NO_COLOR = prev;
    // No ESC byte anywhere in the captured output.
    assert.equal(out.includes("\x1b"), false);
});
