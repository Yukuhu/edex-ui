"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// filesystem.class.js writes `window.FilesystemDisplay` at module load,
// and the icon SVG strings interpolate `window.theme.colors.light_black`
// — but only inside the constructor's instance-property initialisation,
// so module load itself just needs `window` defined.
global.window = global.window ?? {};

const { FilesystemDisplay } = require("../../src/classes/filesystem.class.js");

// Minimal icon shape — width/height/svg — matching what the real
// icons table emits.
const ICO = { width: 24, height: 24, svg: "<path/>" };

function fakeFs() {
    const f = Object.create(FilesystemDisplay.prototype);
    f.icons = {
        showDisks: ICO, up: ICO, symlink: ICO, disk: ICO, rom: ICO, usb: ICO,
        file: ICO, dir: ICO, other: ICO,
        "icon-text":  { ...ICO, svg: "<text/>"  },
        "icon-image": { ...ICO, svg: "<image/>" }
    };
    f.edexIcons = {
        theme:        { ...ICO, svg: "<theme/>" },
        kblayout:     { ...ICO, svg: "<kbd/>"   },
        settings:     { ...ICO, svg: "<set/>"   },
        themesDir:    { ...ICO, svg: "<td/>"    },
        kblayoutsDir: { ...ICO, svg: "<kdd/>"   }
    };
    f.fileIconsMatcher = (name) => {
        if (name.endsWith(".txt")) return "icon-text";
        if (name.endsWith(".png")) return "icon-image";
        return "icon-unknown";  // unmatched names land here so we can exercise the "undefined" branch
    };
    f.iconcolor = "rgb(0,255,0)";
    f._formatBytes = (n) => `${n}b`;
    return f;
}

// ---------------------------------------------------------------------
// _isMediaType  (the pure-est helper in the file)
// ---------------------------------------------------------------------

test("FilesystemDisplay._isMediaType", () => {
    const f = fakeFs();
    assert.equal(f._isMediaType("video"), true);
    assert.equal(f._isMediaType("audio"), true);
    assert.equal(f._isMediaType("image"), true);
    assert.equal(f._isMediaType("file"), false);
    assert.equal(f._isMediaType("dir"), false);
    assert.equal(f._isMediaType(""), false);
    assert.equal(f._isMediaType(undefined), false);
});

// ---------------------------------------------------------------------
// _isDraggable  (the 4-arm rule)
// ---------------------------------------------------------------------

test("FilesystemDisplay._isDraggable", async (t) => {
    const f = fakeFs();
    await t.test("regular files and dirs with a backing path → draggable", () => {
        assert.equal(f._isDraggable({ path: "/foo.txt", type: "file" }), true);
        assert.equal(f._isDraggable({ path: "/foo",     type: "dir"  }), true);
    });
    await t.test("no path → not draggable", () => {
        assert.equal(f._isDraggable({ type: "file" }), false);
        assert.equal(f._isDraggable({ path: "", type: "file" }), false);
        assert.equal(f._isDraggable({ path: null, type: "file" }), false);
    });
    await t.test("the 'up' pseudo-entry → not draggable", () => {
        assert.equal(f._isDraggable({ path: "/somewhere", type: "up" }), false);
    });
    await t.test("the '--' filler type → not draggable", () => {
        assert.equal(f._isDraggable({ path: "/somewhere", type: "--" }), false);
    });
    await t.test("showDisks / up category → not draggable even with a path", () => {
        assert.equal(f._isDraggable({ path: "/anywhere", type: "file", category: "showDisks" }), false);
        assert.equal(f._isDraggable({ path: "/anywhere", type: "file", category: "up" }), false);
    });
});

// ---------------------------------------------------------------------
// _resolveIconAndType  (the 13-case switch)
// ---------------------------------------------------------------------

test("FilesystemDisplay._resolveIconAndType", async (t) => {
    const f = fakeFs();

    await t.test("showDisks: sets category, returns '--' typeLabel + showDisks icon", () => {
        const entry = { type: "showDisks", name: "(disks)" };
        const r = f._resolveIconAndType(entry);
        assert.equal(r.icon, f.icons.showDisks);
        assert.equal(r.typeLabel, "--");
        assert.equal(entry.category, "showDisks");
    });
    await t.test("up: sets category, returns '--' typeLabel + up icon", () => {
        const entry = { type: "up", name: ".." };
        const r = f._resolveIconAndType(entry);
        assert.equal(r.typeLabel, "--");
        assert.equal(entry.category, "up");
    });
    await t.test("symlink / disk / rom / usb: typeLabel falls back to entry.type", () => {
        for (const t of ["symlink", "disk", "rom", "usb"]) {
            const r = f._resolveIconAndType({ type: t, name: "x" });
            assert.equal(r.typeLabel, t);
        }
    });
    await t.test("edex-theme / kblayout / settings / shortcuts / themesDir / kblayoutsDir: humanised labels", () => {
        assert.equal(f._resolveIconAndType({ type: "edex-theme",        name: "n" }).typeLabel, "nDEX-UI theme");
        assert.equal(f._resolveIconAndType({ type: "edex-kblayout",     name: "n" }).typeLabel, "nDEX-UI keyboard layout");
        assert.equal(f._resolveIconAndType({ type: "edex-settings",     name: "n" }).typeLabel, "nDEX-UI config file");
        assert.equal(f._resolveIconAndType({ type: "edex-shortcuts",    name: "n" }).typeLabel, "nDEX-UI config file");
        assert.equal(f._resolveIconAndType({ type: "edex-themesDir",    name: "n" }).typeLabel, "nDEX-UI themes folder");
        assert.equal(f._resolveIconAndType({ type: "edex-kblayoutsDir", name: "n" }).typeLabel, "nDEX-UI keyboards folder");
    });
    await t.test("default branch dispatches to _resolveDefaultIcon", () => {
        const r = f._resolveIconAndType({ type: "file", name: "x.txt" });
        // _resolveDefaultIcon looks up by file-icons match → "icon-text" → strips "icon-" → "text"
        assert.equal(r.typeLabel, "text");
    });
});

// ---------------------------------------------------------------------
// _resolveDefaultIcon  (the fallback cascade)
// ---------------------------------------------------------------------

test("FilesystemDisplay._resolveDefaultIcon", async (t) => {
    const f = fakeFs();

    await t.test("file with matched extension → icon + stripped label", () => {
        const r = f._resolveDefaultIcon({ type: "file", name: "x.txt" });
        assert.equal(r.icon, f.icons["icon-text"]);
        assert.equal(r.typeLabel, "text");
    });
    await t.test("file with unmatched extension → falls back to icons.file + 'file' label", () => {
        // fileIconsMatcher returns "icon-unknown" → f.icons["icon-unknown"] is undefined.
        // Cascade: typeof icon === undefined branch:
        //   - entry.type === "file" → icon = icons.file
        //   - typeLabel remains "" → trailing default → entry.type ("file")
        const r = f._resolveDefaultIcon({ type: "file", name: "x.weird" });
        assert.equal(r.icon, f.icons.file);
        assert.equal(r.typeLabel, "file");
    });
    await t.test("dir with unmatched extension → falls back to icons.dir + 'folder' label", () => {
        const r = f._resolveDefaultIcon({ type: "dir", name: "subdir" });
        assert.equal(r.icon, f.icons.dir);
        assert.equal(r.typeLabel, "folder");
    });
    await t.test("matched-icon + category=dir → 'special folder' label", () => {
        const r = f._resolveDefaultIcon({ type: "dir", name: "x.txt", category: "dir" });
        // fileIconsMatcher returns "icon-text" (matched). Inner else-if
        // hits: entry.category === "dir" → typeLabel = "special folder".
        assert.equal(r.typeLabel, "special folder");
    });
    await t.test("everything-else fallback uses icons.other when type isn't file or dir", () => {
        const r = f._resolveDefaultIcon({ type: "something", name: "x.weird" });
        assert.equal(r.icon, f.icons.other);
    });
});

// ---------------------------------------------------------------------
// _buildItemHTML  (the <div> template)
// ---------------------------------------------------------------------

test("FilesystemDisplay._buildItemHTML", async (t) => {
    const f = fakeFs();

    await t.test("renders a draggable item with size + lastAccessed", () => {
        const html = f._buildItemHTML(
            { type: "file", name: "doc.txt", path: "/doc.txt", size: 1024, lastAccessed: 0 },
            7,
            f.icons["icon-text"],
            "text"
        );
        assert.ok(html.includes(`fs_disp_file`));
        assert.ok(html.includes(`data-idx="7"`));
        assert.ok(html.includes(`draggable="true"`));
        assert.ok(html.includes(`>doc.txt<`));
        assert.ok(html.includes(`>text<`));
        assert.ok(html.includes(`>1024b<`));   // _formatBytes stub
        assert.ok(html.includes(`viewBox="0 0 24 24"`));
        assert.ok(html.includes(`fill="rgb(0,255,0)"`));   // iconcolor
    });
    await t.test("renders a hidden-class item when entry.hidden", () => {
        const html = f._buildItemHTML(
            { type: "file", name: ".bashrc", path: "/.bashrc", hidden: true },
            0,
            ICO,
            "file"
        );
        assert.ok(html.includes("fs_disp_file hidden"));
    });
    await t.test("omits draggable attr for non-draggable entries", () => {
        const html = f._buildItemHTML(
            { type: "up", name: "..", path: "/somewhere" },
            0,
            ICO,
            "--"
        );
        assert.ok(!html.includes("draggable"));
    });
    await t.test("uses '--' for missing size / lastAccessed", () => {
        const html = f._buildItemHTML(
            { type: "file", name: "x", path: "/x" },   // no size, no lastAccessed
            0,
            ICO,
            "file"
        );
        // Both <h4> for size and lastAccessed should contain "--".
        const dashes = html.match(/>--</g) || [];
        assert.equal(dashes.length, 2);
    });
});
