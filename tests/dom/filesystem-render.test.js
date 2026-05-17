"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setupDom, teardownDom } = require("../helpers/dom.js");

// `filesystem.class.js` writes `window.FilesystemDisplay` at module
// load — install a minimal `window` first.
global.window = global.window ?? {};
const { FilesystemDisplay } = require("../../src/classes/filesystem.class.js");

// Minimal icon shape — width/height/svg — matching what the real
// icons table emits. Use real `<path class="...-marker"/>` markers
// inside the svg so jsdom's HTML parser doesn't mangle them (it
// normalises unknown self-closing custom tags like `<showDisks/>` to
// `<showdisks></showdisks>` and lowercases attribute names).
const ICO = (marker) => ({
    width: 24,
    height: 24,
    svg: `<path class="${marker}"/>`
});

function fakeFs({ failed = false, cwd = [] } = {}) {
    const f = Object.create(FilesystemDisplay.prototype);
    f.failed = failed;
    f.cwd = cwd;
    f.filesContainer = document.createElement("div");
    document.body.appendChild(f.filesContainer);

    f.icons = {
        showDisks: ICO("showDisks-marker"),
        up:        ICO("up-marker"),
        symlink:   ICO("symlink-marker"),
        disk:      ICO("disk-marker"),
        rom:       ICO("rom-marker"),
        usb:       ICO("usb-marker"),
        file:      ICO("file-marker"),
        dir:       ICO("dir-marker"),
        other:     ICO("other-marker"),
        "icon-text":  ICO("text-marker"),
        "icon-image": ICO("image-marker")
    };
    f.edexIcons = {
        theme:        ICO("theme-marker"),
        kblayout:     ICO("kbd-marker"),
        settings:     ICO("set-marker"),
        themesDir:    ICO("td-marker"),
        kblayoutsDir: ICO("kdd-marker")
    };
    f.fileIconsMatcher = (name) => {
        if (name.endsWith(".txt")) return "icon-text";
        if (name.endsWith(".png")) return "icon-image";
        return "icon-unknown";
    };
    f.iconcolor = "rgb(0,255,0)";
    f._formatBytes = (n) => `${n}b`;
    return f;
}

// `render()` calls `await _delay(30)` per visible row from inside
// `_playRenderAnimation`. The real `_delay` is set on window by
// _renderer.js; in tests we replace it with an instant-resolve
// no-op (and the global form because filesystem.class.js references
// the bare identifier).
function installDelayStub() {
    global._delay = () => Promise.resolve();
}

// `_playRenderAnimation` calls `window.audioManager.folder.play()`
// for each non-hidden row and reads `window.settings.hideDotfiles`.
function installAudioManagerStub() {
    const calls = { folder: 0 };
    window.audioManager = { folder: { play: () => { calls.folder++; } } };
    return calls;
}

// ---------------------------------------------------------------------
// Failure short-circuit
// ---------------------------------------------------------------------

test("render: returns false and skips DOM mutation when this.failed", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs({ failed: true });
    f.filesContainer.innerHTML = "<p>untouched</p>";
    const ret = await f.render([{ name: "x", type: "file", path: "/x" }], false);

    assert.equal(ret, false);
    assert.equal(f.filesContainer.innerHTML, "<p>untouched</p>");
});

// ---------------------------------------------------------------------
// Container class switch
// ---------------------------------------------------------------------

test("render: isDiskView=true → 'fs_pane_container disks' class", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs();
    await f.render([], true);
    assert.equal(f.filesContainer.getAttribute("class"), "fs_pane_container disks");
});

test("render: isDiskView=false → just 'fs_pane_container'", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs();
    await f.render([], false);
    assert.equal(f.filesContainer.getAttribute("class"), "fs_pane_container");
});

// ---------------------------------------------------------------------
// Empty + single + multi-entry rendering
// ---------------------------------------------------------------------

test("render: empty blockList → no children, class still set", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs();
    await f.render([], false);
    assert.equal(f.filesContainer.children.length, 0);
});

test("render: single regular file → one <div> with expected attrs/content", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs({ cwd: [{ name: "doc.txt", type: "file", path: "/doc.txt", size: 1024, lastAccessed: 0 }] });
    await f.render([{ name: "doc.txt", type: "file", path: "/doc.txt", size: 1024, lastAccessed: 0 }], false);

    assert.equal(f.filesContainer.children.length, 1);
    const item = f.filesContainer.children[0];
    assert.ok(item.className.includes("fs_pane_item"));
    assert.ok(item.className.includes("fs_disp_text"));   // typeLabel from fileIconsMatcher
    assert.equal(item.dataset.idx, "0");
    assert.equal(item.getAttribute("draggable"), "true");
    assert.ok(item.innerHTML.includes(">doc.txt<"));
    assert.ok(item.innerHTML.includes(">text<"));         // type label
    assert.ok(item.innerHTML.includes(">1024b<"));        // formatBytes stub
});

test("render: multi-entry → all children in order", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const blockList = [
        { name: "a.txt",  type: "file", path: "/a.txt" },
        { name: "sub",    type: "dir",  path: "/sub"   },
        { name: "..",     type: "up"                   }
    ];
    const f = fakeFs({ cwd: [...blockList] });
    await f.render(blockList, false);

    assert.equal(f.filesContainer.children.length, 3);
    assert.ok(f.filesContainer.children[0].innerHTML.includes(">a.txt<"));
    assert.ok(f.filesContainer.children[1].innerHTML.includes(">sub<"));
    assert.ok(f.filesContainer.children[2].innerHTML.includes(">..<"));
});

// ---------------------------------------------------------------------
// Entry mutations
// ---------------------------------------------------------------------

test("render: mutates entry.type to the resolved typeLabel (CSS class reflects it)", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    // Use a non-media-type file so the media-promotion `this.cwd[i].type`
    // write doesn't fire (the separate "media-type promotion" test below
    // covers that branch with a matching cwd array).
    const f = fakeFs();
    await f.render([{ name: "doc.txt", type: "file", path: "/doc.txt" }], false);
    const item = f.filesContainer.children[0];
    // typeLabel for ".txt" goes through `_resolveDefaultIcon` →
    // matched "icon-text" → strips "icon-" → "text". The class is
    // built from `fs_disp_${entry.type}` after the mutation.
    assert.ok(item.className.includes("fs_disp_text"));
});

test("render: showDisks pseudo-entry gets entry.category and its dedicated icon", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs();
    await f.render([{ name: "(disks)", type: "showDisks" }], false);
    const item = f.filesContainer.children[0];
    // Type was relabeled to '--', and the showDisks SVG made it into
    // the HTML. (jsdom lowercases unknown self-closing tags; assert
    // via the marker class we put on the inner <path>.)
    assert.ok(item.className.includes("fs_disp_--"));
    assert.ok(item.querySelector(".showDisks-marker"));
});

test("render: media-type entries (video/audio/image) are promoted onto this.cwd[i].type", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    // For an image file, `_resolveDefaultIcon` returns typeLabel "image"
    // (stripped from "icon-image"). Then `_isMediaType("image")` is true,
    // which triggers `this.cwd[blockIndex].type = entry.type`.
    const cwd = [{ name: "photo.png", type: "file", path: "/photo.png" }];
    const f = fakeFs({ cwd });
    await f.render([{ name: "photo.png", type: "file", path: "/photo.png" }], false);

    // The promotion mutation should land on `cwd[0].type`.
    assert.equal(cwd[0].type, "image");
});

// ---------------------------------------------------------------------
// Animation effects
// ---------------------------------------------------------------------

test("render: removes the 'animationWait' class from every child", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    installAudioManagerStub();

    const f = fakeFs();
    await f.render(
        [{ name: "a.txt", type: "file", path: "/a.txt" },
         { name: "b.txt", type: "file", path: "/b.txt" }],
        false
    );

    for (const child of f.filesContainer.children) {
        assert.ok(
            !child.className.includes("animationWait"),
            `child still has animationWait: ${child.className}`
        );
    }
});

test("render: calls audioManager.folder.play() once per non-hidden child", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    const audio = installAudioManagerStub();

    const f = fakeFs();
    await f.render(
        [{ name: "a.txt", type: "file", path: "/a.txt" },
         { name: "b.txt", type: "file", path: "/b.txt" },
         { name: "c.txt", type: "file", path: "/c.txt" }],
        false
    );

    assert.equal(audio.folder, 3);
});

test("render: skips audio + delay for hidden entries when hideDotfiles is true", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: true };
    const audio = installAudioManagerStub();

    const f = fakeFs();
    await f.render(
        [
            { name: ".bashrc", type: "file", path: "/.bashrc", hidden: true },
            { name: "a.txt",   type: "file", path: "/a.txt" }
        ],
        false
    );

    // Only one play call — the hidden entry is skipped.
    assert.equal(audio.folder, 1);
    // Both children still rendered, both still have animationWait removed.
    assert.equal(f.filesContainer.children.length, 2);
    for (const c of f.filesContainer.children) {
        assert.ok(!c.className.includes("animationWait"));
    }
});

test("render: still plays audio for hidden entries when hideDotfiles is NOT set", async (t) => {
    t.after(teardownDom);
    setupDom();
    installDelayStub();
    window.settings = { hideDotfiles: false };
    const audio = installAudioManagerStub();

    const f = fakeFs();
    await f.render(
        [
            { name: ".bashrc", type: "file", path: "/.bashrc", hidden: true },
            { name: "a.txt",   type: "file", path: "/a.txt" }
        ],
        false
    );
    assert.equal(audio.folder, 2);
});
