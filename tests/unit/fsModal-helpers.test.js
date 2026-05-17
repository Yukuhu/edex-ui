"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// fsModal.class.js writes `window.FsModal` at module load.
global.window = global.window ?? {};

const { FsModal } = require("../../src/classes/fsModal.class.js");

// Real node:path / node:fs work great here — _validateDrop just needs
// join + dirname + resolve, and _dstExists needs existsSync.
const path = require("node:path");
const fs   = require("node:fs");
const os   = require("node:os");

function fakeFsModal(overrides = {}) {
    const m = Object.create(FsModal.prototype);
    m.pathLib = path;
    m.fsLib   = fs;
    return Object.assign(m, overrides);
}

// ---------------------------------------------------------------------
// _validateDrop
// ---------------------------------------------------------------------

test("FsModal._validateDrop", async (t) => {
    const m = fakeFsModal();

    await t.test("rejects when target pane has no current directory", () => {
        const r = m._validateDrop({ srcPath: "/a/b.txt", srcName: "b.txt", targetPane: { dirpath: "" } });
        assert.deepEqual(r, { ok: false, reason: "Target pane has no current directory." });
    });
    await t.test("rejects (silently, reason=null) when src and dst are the same directory", () => {
        const r = m._validateDrop({ srcPath: "/a/b.txt", srcName: "b.txt", targetPane: { dirpath: "/a" } });
        assert.deepEqual(r, { ok: false, reason: null });
    });
    await t.test("rejects when src or dst would resolve to the filesystem root", () => {
        const r1 = m._validateDrop({ srcPath: "/", srcName: "anything", targetPane: { dirpath: "/dest" } });
        assert.equal(r1.ok, false);
        assert.ok(r1.reason.includes("Refusing destructive operation"));

        // Empty srcPath/dstPath also blocked.
        const r2 = m._validateDrop({ srcPath: "", srcName: "x", targetPane: { dirpath: "/dest" } });
        assert.equal(r2.ok, false);
    });
    await t.test("accepts a valid cross-directory drop, returns the joined dstPath", () => {
        const r = m._validateDrop({ srcPath: "/a/b.txt", srcName: "b.txt", targetPane: { dirpath: "/c" } });
        assert.equal(r.ok, true);
        assert.equal(r.dstPath, path.join("/c", "b.txt"));
    });
    await t.test("the same-dir check uses path.resolve (so '/a' and '/a/' are equivalent)", () => {
        const r = m._validateDrop({ srcPath: "/a/b.txt", srcName: "b.txt", targetPane: { dirpath: "/a/" } });
        assert.deepEqual(r, { ok: false, reason: null });
    });
});

// ---------------------------------------------------------------------
// _dstExists
// ---------------------------------------------------------------------

test("FsModal._dstExists", async (t) => {
    const m = fakeFsModal();

    // Build temp files we can reliably check.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsmodal-"));
    const existing = path.join(tmpDir, "exists.txt");
    fs.writeFileSync(existing, "x");
    const missing = path.join(tmpDir, "missing.txt");

    await t.test("returns true for an existing path", () => {
        assert.equal(m._dstExists(existing), true);
    });
    await t.test("returns false for a missing path", () => {
        assert.equal(m._dstExists(missing), false);
    });
    await t.test("returns false defensively when fsLib.existsSync throws", () => {
        const m2 = fakeFsModal({
            fsLib: { existsSync: () => { throw new Error("boom"); } }
        });
        assert.equal(m2._dstExists("/anything"), false);
    });

    // Cleanup.
    try { fs.unlinkSync(existing); } catch (_) {}
    try { fs.rmdirSync(tmpDir);  } catch (_) {}
});

// ---------------------------------------------------------------------
// _executeMove + _executeCopy (small wrappers; cover the EXDEV fallback)
// ---------------------------------------------------------------------

test("FsModal._executeMove falls back to cp+rm on EXDEV", async () => {
    const calls = [];
    const m = fakeFsModal({
        fsLib: {
            promises: {
                rename: async () => { const err = new Error("EXDEV"); err.code = "EXDEV"; throw err; },
                cp:     async (...args) => { calls.push(["cp", ...args]); },
                rm:     async (...args) => { calls.push(["rm", ...args]); }
            }
        }
    });
    await m._executeMove("/src", "/dst");
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "cp");
    assert.equal(calls[1][0], "rm");
});

test("FsModal._executeMove rethrows non-EXDEV errors", async () => {
    const m = fakeFsModal({
        fsLib: {
            promises: {
                rename: async () => { const err = new Error("EACCES"); err.code = "EACCES"; throw err; },
                cp: async () => assert.fail("should not be reached"),
                rm: async () => assert.fail("should not be reached")
            }
        }
    });
    await assert.rejects(m._executeMove("/src", "/dst"), /EACCES/);
});

test("FsModal._executeMove succeeds on a clean rename", async () => {
    const calls = [];
    const m = fakeFsModal({
        fsLib: {
            promises: {
                rename: async (s, d) => { calls.push(["rename", s, d]); },
                cp: async () => assert.fail("cp should not be reached on a clean rename"),
                rm: async () => assert.fail("rm should not be reached on a clean rename")
            }
        }
    });
    await m._executeMove("/src", "/dst");
    assert.deepEqual(calls, [["rename", "/src", "/dst"]]);
});

test("FsModal._executeCopy passes force=!!exists through to cp", async () => {
    const calls = [];
    const m = fakeFsModal({
        fsLib: { promises: { cp: async (...args) => calls.push(args) } }
    });
    await m._executeCopy("/src", "/dst", true);
    assert.equal(calls[0][2].force, true);

    await m._executeCopy("/src", "/dst", false);
    assert.equal(calls[1][2].force, false);

    // Verify the other cp options stay constant (recursive + dereference).
    for (const c of calls) {
        assert.equal(c[2].recursive, true);
        assert.equal(c[2].dereference, false);
    }
});
