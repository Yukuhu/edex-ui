"use strict";
// Minimal stand-ins for the Electron surfaces tests need to fake.
// Each function returns a fresh object so tests stay independent.

// Mimics electron.ipcRenderer well enough for `on` / `removeListener` /
// `send` callsites. Adds a test-only `_emit(channel, payload)` that
// invokes every listener registered for the channel (simulating a
// message arriving from the main process).
function mockIpcRenderer() {
    const handlers = new Map();
    return {
        // production surface
        on(channel, fn) {
            if (!handlers.has(channel)) handlers.set(channel, []);
            handlers.get(channel).push(fn);
        },
        removeListener(channel, fn) {
            const list = handlers.get(channel);
            if (!list) return;
            const i = list.indexOf(fn);
            if (i !== -1) list.splice(i, 1);
        },
        send(channel, payload) {
            this.sent.push({ channel, payload });
        },

        // test surface
        sent: [],                                          // every send() call
        _handlers: handlers,                               // for inspection
        _emit(channel, payload) {                          // simulate IPC inbound
            const list = handlers.get(channel) || [];
            // Match real ipcRenderer: callback receives (event, payload).
            for (const fn of list) fn({}, payload);
        },
        _channels() { return [...handlers.keys()]; }
    };
}

module.exports = { mockIpcRenderer };
