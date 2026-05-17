"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// fsModal.class.js writes `window.FsModal` at module load.
global.window = global.window ?? {};
const { FsModal } = require("../../src/classes/fsModal.class.js");

// Build a `_handleDrop`-ready test subject. Each helper is a
// call-tracking stub so we can assert the orchestration sequence
// without doing any real fs work.
function makeFsModal({
    validateDropReturn = { ok: true, dstPath: "/dst/x.txt" },
    dstExistsReturn = false,
    confirmReturn = true,
    executeMoveImpl,
    executeCopyImpl
} = {}) {
    const m = Object.create(FsModal.prototype);
    m.calls = {
        validateDrop: [], dstExists: [], confirm: [],
        executeMove: [], executeCopy: [], refreshBothPanes: [],
        info: []
    };
    m._validateDrop = (args) => {
        m.calls.validateDrop.push(args);
        return validateDropReturn;
    };
    m._dstExists = (p) => {
        m.calls.dstExists.push(p);
        return dstExistsReturn;
    };
    m._confirm = async (title, detailLine) => {
        m.calls.confirm.push({ title, detailLine });
        return confirmReturn;
    };
    m._executeMove = async (src, dst) => {
        m.calls.executeMove.push({ src, dst });
        if (executeMoveImpl) return executeMoveImpl(src, dst);
    };
    m._executeCopy = async (src, dst, force) => {
        m.calls.executeCopy.push({ src, dst, force });
        if (executeCopyImpl) return executeCopyImpl(src, dst, force);
    };
    m._refreshBothPanes = async () => {
        m.calls.refreshBothPanes.push(Date.now());
    };
    m._info = (msg) => {
        m.calls.info.push(msg);
    };
    return m;
}

// ---------------------------------------------------------------------
// Pre-check failures
// ---------------------------------------------------------------------

test("_handleDrop: pre-check failure with a reason → _info called, no fs ops", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: false, reason: "Target pane has no current directory." }
    });
    await m._handleDrop({ srcPath: "/x.txt", srcName: "x.txt", move: false, targetPane: {} });
    assert.deepEqual(m.calls.info, ["Target pane has no current directory."]);
    assert.equal(m.calls.dstExists.length, 0);
    assert.equal(m.calls.executeCopy.length, 0);
    assert.equal(m.calls.executeMove.length, 0);
    assert.equal(m.calls.refreshBothPanes.length, 0);
});

test("_handleDrop: pre-check failure with reason=null (same-dir no-op) is silent", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: false, reason: null }
    });
    await m._handleDrop({ srcPath: "/a/x.txt", srcName: "x.txt", move: false, targetPane: { dirpath: "/a" } });
    assert.equal(m.calls.info.length, 0);   // no info dialog
    assert.equal(m.calls.dstExists.length, 0);
    assert.equal(m.calls.executeCopy.length, 0);
});

// ---------------------------------------------------------------------
// Copy path (no overwrite needed)
// ---------------------------------------------------------------------

test("_handleDrop: clean copy (no existing dst) → executeCopy(force=false) then refresh", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" },
        dstExistsReturn: false
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: false, targetPane: { dirpath: "/dst" } });
    assert.equal(m.calls.confirm.length, 0);   // no overwrite prompt
    assert.deepEqual(m.calls.executeCopy, [{ src: "/src/x.txt", dst: "/dst/x.txt", force: false }]);
    assert.equal(m.calls.executeMove.length, 0);
    assert.equal(m.calls.refreshBothPanes.length, 1);
    assert.equal(m.calls.info.length, 0);
});

// ---------------------------------------------------------------------
// Overwrite paths
// ---------------------------------------------------------------------

test("_handleDrop: existing dst + user confirms → executeCopy(force=true) then refresh", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" },
        dstExistsReturn: true,
        confirmReturn: true
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: false, targetPane: { dirpath: "/dst" } });
    assert.deepEqual(m.calls.confirm, [{ title: "Overwrite x.txt?", detailLine: "/dst/x.txt" }]);
    assert.deepEqual(m.calls.executeCopy, [{ src: "/src/x.txt", dst: "/dst/x.txt", force: true }]);
    assert.equal(m.calls.refreshBothPanes.length, 1);
});

test("_handleDrop: existing dst + user cancels overwrite → no execute, no refresh", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" },
        dstExistsReturn: true,
        confirmReturn: false
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: false, targetPane: { dirpath: "/dst" } });
    assert.equal(m.calls.confirm.length, 1);
    assert.equal(m.calls.executeCopy.length, 0);
    assert.equal(m.calls.refreshBothPanes.length, 0);
    assert.equal(m.calls.info.length, 0);
});

// ---------------------------------------------------------------------
// Move path
// ---------------------------------------------------------------------

test("_handleDrop: move=true routes through executeMove (not executeCopy)", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" }
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: true, targetPane: { dirpath: "/dst" } });
    assert.deepEqual(m.calls.executeMove, [{ src: "/src/x.txt", dst: "/dst/x.txt" }]);
    assert.equal(m.calls.executeCopy.length, 0);
    assert.equal(m.calls.refreshBothPanes.length, 1);
});

// ---------------------------------------------------------------------
// Execute errors
// ---------------------------------------------------------------------

test("_handleDrop: executeCopy throws → _info('Copy failed: <msg>'), no refresh", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" },
        executeCopyImpl: async () => { throw new Error("permission denied"); }
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: false, targetPane: { dirpath: "/dst" } });
    assert.deepEqual(m.calls.info, ["Copy failed: permission denied"]);
    assert.equal(m.calls.refreshBothPanes.length, 0);
});

test("_handleDrop: executeMove throws → _info('Move failed: <msg>'), no refresh", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" },
        executeMoveImpl: async () => { throw new Error("EXDEV after copy"); }
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: true, targetPane: { dirpath: "/dst" } });
    assert.deepEqual(m.calls.info, ["Move failed: EXDEV after copy"]);
    assert.equal(m.calls.refreshBothPanes.length, 0);
});

test("_handleDrop: thrown non-Error gets stringified into the info message", async () => {
    const m = makeFsModal({
        validateDropReturn: { ok: true, dstPath: "/dst/x.txt" },
        executeCopyImpl: async () => { throw "bare string"; }   // not an Error object
    });
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: false, targetPane: { dirpath: "/dst" } });
    assert.deepEqual(m.calls.info, ["Copy failed: bare string"]);
});

// ---------------------------------------------------------------------
// Validate-drop argument plumbing
// ---------------------------------------------------------------------

test("_handleDrop: passes srcPath/srcName/targetPane through to _validateDrop", async () => {
    const m = makeFsModal();
    const pane = { dirpath: "/dst" };
    await m._handleDrop({ srcPath: "/src/x.txt", srcName: "x.txt", move: false, targetPane: pane });
    assert.deepEqual(m.calls.validateDrop, [{ srcPath: "/src/x.txt", srcName: "x.txt", targetPane: pane }]);
});
