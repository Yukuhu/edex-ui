"use strict";
// Minimal stand-in for `window.term[N]` — the Terminal instance pressKey
// and friends call .write() / .writelr() on. Captures calls in an
// inspectable `calls` array so tests can assert on the exact sequence.

function mockTerminal() {
    return {
        calls: [],
        write(s)   { this.calls.push({ method: "write",   arg: s }); },
        writelr(s) { this.calls.push({ method: "writelr", arg: s }); }
    };
}

module.exports = { mockTerminal };
