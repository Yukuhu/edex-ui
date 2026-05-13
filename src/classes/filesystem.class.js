// FilesystemDisplay — a single file-browser pane, scoped to a container
// element. Multiple instances can coexist (the FsModal mounts two of
// them side-by-side). Click handlers are bound at runtime via
// addEventListener rather than inline onclick strings, so there are no
// global references to a specific instance baked into the DOM.
//
// Public surface:
//   new FilesystemDisplay({ container | parentId, initialCwd?, followTerminal? })
//   .readFS(dir)            — navigate to dir
//   .readDevices()          — render the mounted-blocks ("Show disks") view
//   .refresh()              — re-read the current dir
//   .toggleListview()       — toggles list vs grid view (per-instance)
//   .toggleHidedotfiles()   — toggles dotfile visibility (per-instance)
//   .setFollowTerminal(b)   — opt into legacy oncwdchange-driven tracking
//   .destroy()              — tear down listeners and timers
//
// Pane root element gets the class `fs_pane`. When a drag from this
// pane is dropped on another pane root, a CustomEvent 'ndex-fs-drop'
// bubbles up carrying { detail: { srcPath, srcName, srcType, shiftKey } }.

class FilesystemDisplay {
    constructor(opts) {
        if (!opts || (!opts.container && !opts.parentId)) throw new Error("Missing options");

        const fs = require("fs");
        const path = require("path");

        this.fsLib = fs;
        this.pathLib = path;
        this.cwd = [];
        this.cwd_path = null;
        this.iconcolor = `rgb(${window.theme.r}, ${window.theme.g}, ${window.theme.b})`;
        this._formatBytes = (a, b) => {
            if (0 == a) return "0 Bytes";
            const c = 1024, d = b || 2, e = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
            const f = Math.floor(Math.log(a) / Math.log(c));
            return Number.parseFloat((a / Math.pow(c, f)).toFixed(d)) + " " + e[f];
        };
        this.fileIconsMatcher = require("./assets/misc/file-icons-match.js");
        this.icons = require("./assets/icons/file-icons.json");
        this.edexIcons = {
            theme: {
                width: 24, height: 24,
                svg: '<path d="M 17.9994,3.99805L 17.9994,2.99805C 17.9994,2.44604 17.5514,1.99805 16.9994,1.99805L 4.9994,1.99805C 4.4474,1.99805 3.9994,2.44604 3.9994,2.99805L 3.9994,6.99805C 3.9994,7.55005 4.4474,7.99805 4.9994,7.99805L 16.9994,7.99805C 17.5514,7.99805 17.9994,7.55005 17.9994,6.99805L 17.9994,5.99805L 18.9994,5.99805L 18.9994,9.99805L 8.9994,9.99805L 8.9994,20.998C 8.9994,21.55 9.4474,21.998 9.9994,21.998L 11.9994,21.998C 12.5514,21.998 12.9994,21.55 12.9994,20.998L 12.9994,11.998L 20.9994,11.998L 20.9994,3.99805L 17.9994,3.99805 Z"/>'
            },
            themesDir: {
                width: 24, height: 24,
                svg: `<path d="m9.9994 3.9981h-6c-1.105 0-1.99 0.896-1.99 2l-0.01 12c0 1.104 0.895 2 2 2h16c1.104 0 2-0.896 2-2v-9.9999c0-1.104-0.896-2-2-2h-8l-1.9996-2z" stroke-width=".2"/><path stroke-linejoin="round" d="m18.8 9.3628v-0.43111c0-0.23797-0.19314-0.43111-0.43111-0.43111h-5.173c-0.23797 0-0.43111 0.19313-0.43111 0.43111v1.7244c0 0.23797 0.19314 0.43111 0.43111 0.43111h5.1733c0.23797 0 0.43111-0.19314 0.43111-0.43111v-0.43111h0.43111v1.7244h-4.3111v4.7422c0 0.23797 0.19314 0.43111 0.43111 0.43111h0.86221c0.23797 0 0.43111-0.19314 0.43111-0.43111v-3.879h3.449v-3.4492z" stroke-width=".086221" fill="${window.theme.colors.light_black}"/>`
            },
            kblayout: {
                width: 24, height: 24,
                svg: '<path d="M 18.9994,9.99807L 16.9994,9.99807L 16.9994,7.99807L 18.9994,7.99807M 18.9994,12.9981L 16.9994,12.9981L 16.9994,10.9981L 18.9994,10.9981M 15.9994,9.99807L 13.9994,9.99807L 13.9994,7.99807L 15.9994,7.99807M 15.9994,12.9981L 13.9994,12.9981L 13.9994,10.9981L 15.9994,10.9981M 15.9994,16.9981L 7.99941,16.9981L 7.99941,14.9981L 15.9994,14.9981M 6.99941,9.99807L 4.99941,9.99807L 4.99941,7.99807L 6.99941,7.99807M 6.99941,12.9981L 4.99941,12.9981L 4.99941,10.9981L 6.99941,10.9981M 7.99941,10.9981L 9.99941,10.9981L 9.99941,12.9981L 7.99941,12.9981M 7.99941,7.99807L 9.99941,7.99807L 9.99941,9.99807L 7.99941,9.99807M 10.9994,10.9981L 12.9994,10.9981L 12.9994,12.9981L 10.9994,12.9981M 10.9994,7.99807L 12.9994,7.99807L 12.9994,9.99807L 10.9994,9.99807M 19.9994,4.99807L 3.99941,4.99807C 2.89441,4.99807 2.0094,5.89406 2.0094,6.99807L 1.99941,16.9981C 1.99941,18.1021 2.89441,18.9981 3.99941,18.9981L 19.9994,18.9981C 21.1034,18.9981 21.9994,18.1021 21.9994,16.9981L 21.9994,6.99807C 21.9994,5.89406 21.1034,4.99807 19.9994,4.99807 Z"/>'
            },
            kblayoutsDir: {
                width: 24, height: 24,
                svg: `<path d="m9.9994 3.9981h-6c-1.105 0-1.99 0.896-1.99 2l-0.01 12c0 1.104 0.895 2 2 2h16c1.104 0 2-0.896 2-2v-9.9999c0-1.104-0.896-2-2-2h-8l-1.9996-2z" stroke-width=".2"/><path stroke-linejoin="round" d="m17.48 11.949h-1.14v-1.14h1.14m0 2.8499h-1.14v-1.14h1.14m-1.7099-0.56999h-1.14v-1.14h1.14m0 2.8499h-1.14v-1.14h1.14m0 3.4199h-4.56v-1.14h4.56m-5.13-2.85h-1.1399v-1.14h1.14m0 2.8499h-1.1399v-1.14h1.14m0.56998 0h1.14v1.14h-1.14m0-2.8499h1.14v1.14h-1.14m1.7099 0.56999h1.14v1.14h-1.14m0-2.8499h1.14v1.14h-1.14m5.13-2.8494h-9.1199c-0.62982 0-1.1343 0.51069-1.1343 1.14l-0.0057 5.6998c0 0.62925 0.51013 1.14 1.14 1.14h9.1196c0.62925 0 1.14-0.5107 1.14-1.14v-5.6998c0-0.62926-0.5107-1.14-1.14-1.14z" stroke-width="0.114" fill="${window.theme.colors.light_black}"/>`
            },
            settings: {
                width: 24, height: 24,
                svg: '<path d="M 11.9994,15.498C 10.0664,15.498 8.49939,13.931 8.49939,11.998C 8.49939,10.0651 10.0664,8.49805 11.9994,8.49805C 13.9324,8.49805 15.4994,10.0651 15.4994,11.998C 15.4994,13.931 13.9324,15.498 11.9994,15.498 Z M 19.4284,12.9741C 19.4704,12.6531 19.4984,12.329 19.4984,11.998C 19.4984,11.6671 19.4704,11.343 19.4284,11.022L 21.5414,9.36804C 21.7294,9.21606 21.7844,8.94604 21.6594,8.73004L 19.6594,5.26605C 19.5354,5.05005 19.2734,4.96204 19.0474,5.04907L 16.5584,6.05206C 16.0424,5.65607 15.4774,5.32104 14.8684,5.06903L 14.4934,2.41907C 14.4554,2.18103 14.2484,1.99805 13.9994,1.99805L 9.99939,1.99805C 9.74939,1.99805 9.5434,2.18103 9.5054,2.41907L 9.1304,5.06805C 8.52039,5.32104 7.95538,5.65607 7.43939,6.05206L 4.95139,5.04907C 4.7254,4.96204 4.46338,5.05005 4.33939,5.26605L 2.33939,8.73004C 2.21439,8.94604 2.26938,9.21606 2.4574,9.36804L 4.5694,11.022C 4.5274,11.342 4.49939,11.6671 4.49939,11.998C 4.49939,12.329 4.5274,12.6541 4.5694,12.9741L 2.4574,14.6271C 2.26938,14.78 2.21439,15.05 2.33939,15.2661L 4.33939,18.73C 4.46338,18.946 4.7254,19.0341 4.95139,18.947L 7.4404,17.944C 7.95639,18.34 8.52139,18.675 9.1304,18.9271L 9.5054,21.577C 9.5434,21.8151 9.74939,21.998 9.99939,21.998L 13.9994,21.998C 14.2484,21.998 14.4554,21.8151 14.4934,21.577L 14.8684,18.9271C 15.4764,18.6741 16.0414,18.34 16.5574,17.9431L 19.0474,18.947C 19.2734,19.0341 19.5354,18.946 19.6594,18.73L 21.6594,15.2661C 21.7844,15.05 21.7294,14.78 21.5414,14.6271L 19.4284,12.9741 Z"/>'
            }
        };

        // Resolve the container DOM element.
        this.container = opts.container || document.getElementById(opts.parentId);
        if (!this.container) throw new Error("FilesystemDisplay: container not found");

        // Mark the root so cross-pane drop targets can find each other.
        this.container.classList.add("fs_pane");
        if (window.settings?.hideDotfiles) this.container.classList.add("hideDotfiles");
        if (window.settings?.fsListView) this.container.classList.add("list-view");

        this.container.innerHTML = `
            <div class="fs_pane_container"></div>
            <div class="fs_pane_space_bar">
                <h1>EXIT DISPLAY</h1>
                <h3>Calculating available space...</h3><progress value="100" max="100"></progress>
            </div>
            <div class="fs_pane_error" hidden></div>`;
        this.filesContainer = this.container.querySelector(".fs_pane_container");
        this.errorEl = this.container.querySelector(".fs_pane_error");
        this.space_bar = {
            root: this.container.querySelector(".fs_pane_space_bar"),
            exitBtn: this.container.querySelector(".fs_pane_space_bar > h1"),
            text: this.container.querySelector(".fs_pane_space_bar > h3"),
            bar: this.container.querySelector(".fs_pane_space_bar > progress")
        };

        this.fsBlock = {};
        this.dirpath = "";
        this.failed = false;
        this._noTracking = false;
        this._followTerminal = !!opts.followTerminal;
        this._runNextTick = false;
        this._reading = false;
        this._timer = null;

        this._asyncFSwrapper = new Proxy(fs, {
            get: function(fs, prop) {
                if (prop in fs) {
                    return function(...args) {
                        return new Promise((resolve, reject) => {
                            fs[prop](...args, (err, d) => {
                                if (typeof err !== "undefined" && err !== null) reject(err);
                                if (typeof d !== "undefined") resolve(d);
                                if (typeof d === "undefined" && typeof err === "undefined") resolve();
                            });
                        });
                    };
                }
            },
            set: function() { return false; }
        });

        // Periodic refresh trigger driven by the fs.watch handler.
        this._timer = setInterval(() => {
            if (this._runNextTick === true) {
                this._runNextTick = false;
                this.readFS(this.dirpath);
            }
        }, 1000);

        // Click dispatcher — one delegated listener instead of N inline onclicks.
        this.filesContainer.addEventListener("click", e => {
            const item = e.target.closest(".fs_pane_item");
            if (!item) return;
            const idx = Number.parseInt(item.dataset.idx, 10);
            if (Number.isNaN(idx)) return;
            this._handleItemClick(idx, e);
        });

        // Drag source: every item with data-idx becomes draggable. We
        // attach `dragstart` at the container level via delegation.
        this.filesContainer.addEventListener("dragstart", e => {
            const item = e.target.closest(".fs_pane_item[draggable='true']");
            if (!item) return;
            const idx = Number.parseInt(item.dataset.idx, 10);
            if (Number.isNaN(idx)) return;
            const entry = this.cwd[idx];
            if (!entry?.path) { e.preventDefault(); return; }
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("application/x-ndex-fs", JSON.stringify({
                path: entry.path,
                name: entry.name,
                type: entry.category || entry.type
            }));
            // Some platforms need a text/plain fallback to satisfy
            // dataTransfer expectations.
            e.dataTransfer.setData("text/plain", entry.path);
        });

        // Drop target: any drop on the pane root dispatches a CustomEvent.
        this.container.addEventListener("dragover", e => {
            if (!e.dataTransfer.types.includes("application/x-ndex-fs")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = e.shiftKey ? "move" : "copy";
            this.container.classList.add("dragover");
        });
        this.container.addEventListener("dragleave", e => {
            if (e.target !== this.container) return;
            this.container.classList.remove("dragover");
        });
        this.container.addEventListener("drop", e => {
            this.container.classList.remove("dragover");
            const payload = e.dataTransfer.getData("application/x-ndex-fs");
            if (!payload) return;
            e.preventDefault();
            let parsed;
            try { parsed = JSON.parse(payload); } catch (_) { return; }
            this.container.dispatchEvent(new CustomEvent("ndex-fs-drop", {
                bubbles: true,
                detail: {
                    srcPath: parsed.path,
                    srcName: parsed.name,
                    srcType: parsed.type,
                    shiftKey: !!e.shiftKey,
                    targetPane: this
                }
            }));
        });

        // Disk-view exit button on the space bar.
        this.space_bar.exitBtn.addEventListener("click", () => {
            // Only meaningful in disk view (filesContainer has class "disks").
            if (this.filesContainer.classList.contains("disks")) {
                this.render(this.cwd);
            }
        });

        if (this._followTerminal) this._wireFollowTerminal();

        // Initial CWD load is async; keep it out of the constructor
        // body so Sonar's S7059 is satisfied. Caller doesn't await —
        // readFS renders into `this.filesContainer` when it resolves.
        this._applyInitialCwd(opts.initialCwd);
    }

    _applyInitialCwd(cwd) {
        if (cwd) this.readFS(cwd);
    }

    setFollowTerminal(on) {
        if (on === this._followTerminal) return;
        this._followTerminal = !!on;
        if (this._followTerminal) this._wireFollowTerminal();
    }

    _wireFollowTerminal() {
        // Defer to next tick so window.term is available even if the
        // pane was constructed during boot.
        setTimeout(() => {
            if (!window.term?.[window.currentTerm]) return;
            const num = window.currentTerm;
            const term = window.term[num];
            // Snap to the terminal's current CWD if we have one.
            const cwd = term.cwd;
            if (cwd && cwd !== this.cwd_path) {
                if (cwd.startsWith("FALLBACK |-- ")) {
                    this.cwd_path = cwd;
                    this._noTracking = true;
                    this.readFS(cwd.slice(13));
                } else {
                    this.cwd_path = cwd;
                    this.readFS(cwd);
                    this._watchFS(cwd);
                }
            }
            term.oncwdchange = newCwd => {
                if (!this._followTerminal) return;
                if (this._noTracking) return;
                if (newCwd && newCwd !== this.cwd_path && window.currentTerm === num) {
                    this.cwd_path = newCwd;
                    if (this._fsWatcher) { this._fsWatcher.close(); this._fsWatcher = null; }
                    if (newCwd.startsWith("FALLBACK |-- ")) {
                        this.readFS(newCwd.slice(13));
                        this._noTracking = true;
                    } else {
                        this.readFS(newCwd);
                        this._watchFS(newCwd);
                    }
                }
            };
        }, 0);
    }

    _watchFS(dir) {
        if (this._fsWatcher) { this._fsWatcher.close(); this._fsWatcher = null; }
        try {
            this._fsWatcher = this.fsLib.watch(dir, (eventType) => {
                if (eventType !== "change") this._runNextTick = true;
            });
        } catch (_) { /* watch can fail on some FS — fall through */ }
    }

    toggleHidedotfiles() {
        if (window.settings.hideDotfiles) {
            this.container.classList.remove("hideDotfiles");
            window.settings.hideDotfiles = false;
        } else {
            this.container.classList.add("hideDotfiles");
            window.settings.hideDotfiles = true;
        }
    }

    toggleListview() {
        if (window.settings.fsListView) {
            this.container.classList.remove("list-view");
            window.settings.fsListView = false;
        } else {
            this.container.classList.add("list-view");
            window.settings.fsListView = true;
        }
    }

    refresh() {
        if (this.dirpath) this.readFS(this.dirpath);
    }

    destroy() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._fsWatcher) { try { this._fsWatcher.close(); } catch (_) {} this._fsWatcher = null; }
        // Drop terminal hook so the pane isn't a ghost listener.
        if (this._followTerminal && window.term && window.currentTerm !== undefined) {
            const term = window.term[window.currentTerm];
            if (term?.oncwdchange) term.oncwdchange = () => {};
        }
    }

    setFailedState() {
        this.failed = true;
        this.errorEl.removeAttribute("hidden");
        this.errorEl.innerText = "CANNOT ACCESS CURRENT WORKING DIRECTORY";
        this.filesContainer.innerHTML = "";
    }

    async readFS(dir) {
        if (this.failed === true || this._reading) return false;
        this._reading = true;
        this.errorEl.setAttribute("hidden", "");

        this.filesContainer.setAttribute("class", "fs_pane_container");

        if (process.platform === "win32" && dir.endsWith(":")) dir = dir + "\\";
        let tcwd = dir;
        let content;
        try {
            content = await this._asyncFSwrapper.readdir(tcwd);
        } catch (err) {
            console.warn(err);
            this._reading = false;
            this.setFailedState();
            return false;
        }

        this._reCalculateDiskUsage(tcwd);
        this.cwd = [];

        await new Promise((resolve, reject) => {
            if (content.length === 0) resolve();
            content.forEach(async (file, i) => {
                let fstat;
                try {
                    fstat = await this._asyncFSwrapper.lstat(this.pathLib.join(tcwd, file));
                } catch (e) {
                    if (!String(e.message || "").includes("EPERM") && !String(e.message || "").includes("EBUSY")) {
                        return reject(e);
                    }
                }
                const e = {
                    name: window._escapeHtml(file),
                    path: this.pathLib.resolve(tcwd, file),
                    type: "other",
                    category: "other",
                    hidden: false
                };
                if (typeof fstat !== "undefined") {
                    e.lastAccessed = fstat.mtime.getTime();
                    if (fstat.isDirectory()) { e.category = "dir"; e.type = "dir"; }
                    if (e.category === "dir" && tcwd === settingsDir && file === "themes") e.type = "edex-themesDir";
                    if (e.category === "dir" && tcwd === settingsDir && file === "keyboards") e.type = "edex-kblayoutsDir";
                    if (fstat.isSymbolicLink()) { e.category = "symlink"; e.type = "symlink"; }
                    if (fstat.isFile()) { e.category = "file"; e.type = "file"; e.size = fstat.size; }
                } else {
                    e.type = "system";
                    e.hidden = true;
                }
                if (e.category === "file" && tcwd === themesDir && file.endsWith(".json")) e.type = "edex-theme";
                if (e.category === "file" && tcwd === keyboardsDir && file.endsWith(".json")) e.type = "edex-kblayout";
                if (e.category === "file" && tcwd === settingsDir && file === "settings.json") e.type = "edex-settings";
                if (e.category === "file" && tcwd === settingsDir && file === "shortcuts.json") e.type = "edex-shortcuts";
                if (file.startsWith(".")) e.hidden = true;
                this.cwd.push(e);
                if (i === content.length - 1) resolve();
            });
        }).catch(() => { this.setFailedState(); });

        if (this.failed) { this._reading = false; return false; }

        const ordering = { dir: 0, symlink: 1, file: 2, other: 3 };
        this.cwd.sort((a, b) => (ordering[a.category] - ordering[b.category] || a.name.localeCompare(b.name)));
        this.cwd.splice(0, 0, { name: "Show disks", type: "showDisks" });
        if (tcwd !== "/" && /^[A-Z]:\\$/i.test(tcwd) === false) {
            this.cwd.splice(1, 0, { name: "Go up", type: "up" });
        }
        this.dirpath = tcwd;
        this.render(this.cwd);
        this._reading = false;
        // Tell any external observer (e.g. FsModal) that this pane moved.
        this.container.dispatchEvent(new CustomEvent("ndex-fs-cwd", {
            bubbles: true,
            detail: { pane: this, cwd: tcwd }
        }));
        return true;
    }

    async readDevices() {
        if (this.failed === true) return false;
        const blocks = await window.si.blockDevices();
        const devices = [];
        blocks.forEach(block => {
            if (this.fsLib.existsSync(block.mount)) {
                let type = (block.type === "rom") ? "rom" : "disk";
                if (block.removable && block.type !== "rom") type = "usb";
                devices.push({
                    name: (block.label !== "") ? `${block.label} (${block.name})` : `${block.mount} (${block.name})`,
                    type,
                    path: block.mount
                });
            }
        });
        this.render(devices, true);
    }

    async render(originBlockList, isDiskView) {
        const blockList = JSON.parse(JSON.stringify(originBlockList));
        if (this.failed === true) return false;
        if (isDiskView) {
            this.filesContainer.setAttribute("class", "fs_pane_container disks");
        } else {
            this.filesContainer.setAttribute("class", "fs_pane_container");
        }

        let filesDOM = "";
        blockList.forEach((entry, blockIndex) => {
            const hidden = entry.hidden ? " hidden" : "";
            let icon = "";
            let typeLabel = "";

            switch (entry.type) {
                case "showDisks":      icon = this.icons.showDisks; typeLabel = "--"; entry.category = "showDisks"; break;
                case "up":             icon = this.icons.up;        typeLabel = "--"; entry.category = "up";        break;
                case "symlink":        icon = this.icons.symlink; break;
                case "disk":           icon = this.icons.disk;    break;
                case "rom":            icon = this.icons.rom;     break;
                case "usb":            icon = this.icons.usb;     break;
                case "edex-theme":         icon = this.edexIcons.theme;        typeLabel = "nDEX-UI theme"; break;
                case "edex-kblayout":      icon = this.edexIcons.kblayout;     typeLabel = "nDEX-UI keyboard layout"; break;
                case "edex-settings":
                case "edex-shortcuts":     icon = this.edexIcons.settings;     typeLabel = "nDEX-UI config file"; break;
                case "system":             icon = this.edexIcons.settings; break;
                case "edex-themesDir":     icon = this.edexIcons.themesDir;    typeLabel = "nDEX-UI themes folder"; break;
                case "edex-kblayoutsDir":  icon = this.edexIcons.kblayoutsDir; typeLabel = "nDEX-UI keyboards folder"; break;
                default: {
                    const iconName = this.fileIconsMatcher(entry.name);
                    icon = this.icons[iconName];
                    if (typeof icon === "undefined") {
                        if (entry.type === "file") icon = this.icons.file;
                        if (entry.type === "dir") { icon = this.icons.dir; typeLabel = "folder"; }
                        if (typeof icon === "undefined") icon = this.icons.other;
                    } else if (entry.category !== "dir") {
                        typeLabel = iconName.replace("icon-", "");
                    } else {
                        typeLabel = "special folder";
                    }
                }
            }
            if (typeLabel === "") typeLabel = entry.type;
            entry.type = typeLabel;

            // Promote known media types so click routes to openMedia.
            if (entry.type === "video" || entry.type === "audio" || entry.type === "image") {
                this.cwd[blockIndex].type = entry.type;
            }

            const sizeStr = typeof entry.size === "number" ? this._formatBytes(entry.size) : "--";
            const lastStr = typeof entry.lastAccessed === "number" ? new Date(entry.lastAccessed).toLocaleString() : "--";

            // Real files/dirs are draggable; special entries (up, showDisks, system) are not.
            const draggable = entry.path && entry.type !== "up" && entry.type !== "--" && entry.category !== "showDisks" && entry.category !== "up";

            filesDOM += `<div class="fs_pane_item fs_disp_${entry.type}${hidden} animationWait" data-idx="${blockIndex}"${draggable ? ' draggable="true"' : ""}>
                            <svg viewBox="0 0 ${icon.width} ${icon.height}" fill="${this.iconcolor}">${icon.svg}</svg>
                            <h3>${entry.name}</h3>
                            <h4>${typeLabel}</h4>
                            <h4>${sizeStr}</h4>
                            <h4>${lastStr}</h4>
                        </div>`;
        });
        this.filesContainer.innerHTML = filesDOM;

        // Render animation — fade items in with a small audible tick.
        let id = 0;
        while (this.filesContainer.childNodes[id]) {
            const el = this.filesContainer.childNodes[id];
            el.setAttribute("class", el.className.replace(" animationWait", ""));
            if (window.settings.hideDotfiles !== true || el.className.indexOf("hidden") === -1) {
                window.audioManager.folder.play();
                await _delay(30);
            }
            id++;
        }
    }

    _handleItemClick(idx, ev) {
        const entry = this.cwd[idx];
        if (!entry) return;

        const { ctrl, shift } = this._getClickModifiers(ev);
        if (ctrl && entry.path)  { this._openInOS(entry); return; }
        if (shift && entry.path) { this._writeQuotedPath(entry.path); return; }

        const pseudo = entry.category || entry.type;
        if (pseudo === "showDisks") { this.readDevices(); return; }
        if (pseudo === "up")        { this.readFS(this.pathLib.resolve(this.dirpath, "..")); return; }

        if (this._isDirectoryEntry(entry)) { this._enterDirectory(entry); return; }
        if (this._isDiskEntry(entry))      { this._enterDisk(entry); return; }

        this._handleEntryType(idx, entry);
    }

    // Returns ctrl/shift state for a click event, consulting both the real
    // event modifiers (physical keyboard) and the on-screen keyboard's
    // dataset flags so virtual-modifier clicks behave the same.
    _getClickModifiers(ev) {
        const kbContainer = window.keyboard?.container;
        return {
            ctrl:  ev.ctrlKey  || ev.metaKey || kbContainer?.dataset.isCtrlOn  === "true",
            shift: ev.shiftKey               || kbContainer?.dataset.isShiftOn === "true",
        };
    }

    // Legacy ctrl-click: open the entry through the OS handler and
    // minimize the window so the OS-opened app gets focus.
    _openInOS(entry) {
        electron.shell.openPath(entry.path);
        try { remote.getCurrentWindow().minimize(); } catch (_) {}
    }

    // Legacy shift-click: stage a quoted path on the active terminal so
    // the user can compose a command around it.
    _writeQuotedPath(p) {
        window.term[window.currentTerm].write('"' + p + '"');
    }

    _isDirectoryEntry(entry) {
        return entry.type === "dir" || entry.type?.endsWith?.("Dir");
    }

    // Directory click — if this pane is terminal-tracking, drive the
    // terminal (so the shell's cwd stays in sync); otherwise navigate
    // the pane directly.
    _enterDirectory(entry) {
        if (this._followTerminal && !this._noTracking) {
            window.term[window.currentTerm].writelr('cd "' + entry.name + '"');
        } else {
            this.readFS(entry.path);
        }
    }

    _isDiskEntry(entry) {
        return entry.type === "disk" || entry.type === "rom" || entry.type === "usb";
    }

    // Mounted-block-device click. Same follow-terminal split as a
    // directory, with one Windows quirk: switching drives is `C:` not
    // `cd C:`, so the path is stripped of backslashes and written raw.
    _enterDisk(entry) {
        if (!(this._followTerminal && !this._noTracking)) {
            this.readFS(entry.path);
            return;
        }
        if (process.platform === "win32") {
            window.term[window.currentTerm].writelr(entry.path.replaceAll("\\", ""));
        } else {
            window.term[window.currentTerm].writelr('cd "' + entry.path + '"');
        }
    }

    // Final dispatcher for type-keyed actions. Anything not matched here
    // is a no-op.
    _handleEntryType(idx, entry) {
        switch (entry.type) {
            case "file":            this.openFile(idx); return;
            case "video":
            case "audio":
            case "image":           this.openMedia(idx); return;
            case "edex-theme":      window.themeChanger(entry.name.slice(0, -5)); return;
            case "edex-kblayout":   window.remakeKeyboard(entry.name.slice(0, -5)); return;
            case "edex-settings":   window.openSettings(); return;
            case "edex-shortcuts":  window.openShortcutsHelp(); return;
            case "symlink":
            case "other":
                if (entry.path) this._writeQuotedPath(entry.path);
                return;
        }
    }

    async _reCalculateDiskUsage(p) {
        this.fsBlock = null;
        this.space_bar.text.innerHTML = "Calculating available space...";
        this.space_bar.bar.removeAttribute("value");
        try {
            const d = await window.si.fsSize();
            d.forEach(b => { if (p.startsWith(b.mount)) this.fsBlock = b; });
            this._renderDiskUsage(this.fsBlock);
        } catch (_) {
            this.space_bar.text.innerHTML = "Could not calculate mountpoint usage.";
            this.space_bar.bar.value = 100;
        }
    }

    _renderDiskUsage(fsBlock) {
        if (this.filesContainer.classList.contains("disks") || fsBlock === null) return;
        const splitter = (process.platform === "win32") ? "\\" : "/";
        const displayMount = (fsBlock.mount.length < 18) ? fsBlock.mount : "..." + splitter + fsBlock.mount.split(splitter).pop();
        if (!isNaN(fsBlock.use)) {
            this.space_bar.text.innerHTML = `Mount <strong>${displayMount}</strong> used <strong>${Math.round(fsBlock.use)}%</strong>`;
            this.space_bar.bar.value = Math.round(fsBlock.use);
        } else if (!isNaN((fsBlock.size / fsBlock.used) * 100)) {
            const usage = Math.round((fsBlock.size / fsBlock.used) * 100);
            this.space_bar.text.innerHTML = `Mount <strong>${displayMount}</strong> used <strong>${usage}%</strong>`;
            this.space_bar.bar.value = usage;
        } else {
            this.space_bar.text.innerHTML = "Could not calculate mountpoint usage.";
            this.space_bar.bar.value = 100;
        }
    }

    openFile(name) {
        let block;
        if (typeof name === "number") {
            block = this.cwd[name];
            name = block.name;
        }
        const mime = require("mime-types");
        block.path = block.path.replace(/\\/g, "/");
        const filetype = mime.lookup(name.split(".").pop());
        switch (filetype) {
            case "application/pdf": {
                const html = `<div>
                    <div class="pdf_options">
                        <button class="zoom_in"><svg viewBox="0 0 ${this.icons["zoom-in"].width} ${this.icons["zoom-in"].height}" fill="${this.iconcolor}">${this.icons["zoom-in"].svg}</svg></button>
                        <button class="zoom_out"><svg viewBox="0 0 ${this.icons["zoom-out"].width} ${this.icons["zoom-out"].height}" fill="${this.iconcolor}">${this.icons["zoom-out"].svg}</svg></button>
                        <button class="previous_page"><svg viewBox="0 0 ${this.icons["backwards"].width} ${this.icons["backwards"].height}" fill="${this.iconcolor}">${this.icons["backwards"].svg}</svg></button>
                        <span>Page: <span class="page_num"/></span><span>/</span> <span class="page_count"></span></span>
                        <button class="next_page"><svg viewBox="0 0 ${this.icons["forwards"].width} ${this.icons["forwards"].height}" fill="${this.iconcolor}">${this.icons["forwards"].svg}</svg></button>
                    </div>
                    <div class="pdf_container fsDisp_mediaDisp"><canvas class="pdf_canvas" /></div>
                </div>`;
                const newModal = new Modal({ type: "custom", title: _escapeHtml(name), html });
                DocReader.show({ modalId: newModal.id, path: block.path });
                break;
            }
            default:
                if (mime.charset(filetype) === "UTF-8") {
                    this.fsLib.readFile(block.path, "utf-8", (err, data) => {
                        if (err) {
                            Modal.show({ type: "info", title: "Failed to load file: " + block.path, html: String(err) });
                            console.log(err);
                            return;
                        }
                        window.keyboard.detach();
                        Modal.show({
                            type: "custom",
                            title: _escapeHtml(name),
                            html: `<textarea id="fileEdit" rows="40" cols="150" spellcheck="false">${data}</textarea><p id="fedit-status"></p>`,
                            buttons: [{ label: "Save to Disk", action: `window.writeFile('${block.path}')` }]
                        }, () => {
                            window.keyboard.attach();
                            window.term[window.currentTerm].term.focus();
                        });
                    });
                }
        }
    }

    openMedia(name, p, type) {
        let block, html;
        if (typeof name === "number") {
            block = this.cwd[name];
            name = block.name;
        }
        block.path = block.path.replace(/\\/g, "/");
        switch (type || block.type) {
            case "image":
                html = `<img class="fsDisp_mediaDisp" src="${window._encodePathURI(p || block.path)}" ondragstart="return false;">`;
                break;
            case "audio":
                html = `<div><div class="media_container" data-fullscreen="false">
                    <audio class="media fsDisp_mediaDisp" preload="auto"><source src="${window._encodePathURI(p || block.path)}">Unsupported audio format!</audio>
                    <div class="media_controls" data-state="hidden">
                        <div class="playpause media_button" data-state="play"><svg viewBox="0 0 ${this.icons.play.width} ${this.icons.play.height}" fill="${this.iconcolor}">${this.icons.play.svg}</svg></div>
                        <div class="progress_container"><div class="progress"><span class="progress_bar"></span></div></div>
                        <div class="media_time">00:00:00</div>
                        <div class="volume_icon"><svg viewBox="0 0 ${this.icons.volume.width} ${this.icons.volume.height}" fill="${this.iconcolor}">${this.icons.volume.svg}</svg></div>
                        <div class="volume"><div class="volume_bkg"></div><div class="volume_bar"></div></div>
                    </div></div></div>`;
                break;
            case "video":
                html = `<div><div class="media_container" data-fullscreen="false">
                    <video class="media fsDisp_mediaDisp" preload="auto"><source src="${window._encodePathURI(p || block.path)}">Unsupported video format!</video>
                    <div class="media_controls" data-state="hidden">
                        <div class="playpause media_button" data-state="play"><svg viewBox="0 0 ${this.icons.play.width} ${this.icons.play.height}" fill="${this.iconcolor}">${this.icons.play.svg}</svg></div>
                        <div class="progress_container"><div class="progress"><span class="progress_bar"></span></div></div>
                        <div class="media_time">00:00:00</div>
                        <div class="volume_icon"><svg viewBox="0 0 ${this.icons.volume.width} ${this.icons.volume.height}" fill="${this.iconcolor}">${this.icons.volume.svg}</svg></div>
                        <div class="volume"><div class="volume_bkg"></div><div class="volume_bar"></div></div>
                        <div class="fs media_button" data-state="go-fullscreen"><svg viewBox="0 0 ${this.icons.fullscreen.width} ${this.icons.fullscreen.height}" fill="${this.iconcolor}">${this.icons.fullscreen.svg}</svg></div>
                    </div></div></div>`;
                break;
            default:
                throw new Error("fsDisp media displayer: unknown type " + (type || block.type));
        }
        const newModal = new Modal({ type: "custom", title: _escapeHtml(name), html });
        if (block.type === "audio" || block.type === "video") {
            MediaPlayer.show({ modalId: newModal.id, path: block.path, type: block.type });
        }
    }
}

module.exports = {
    FilesystemDisplay
};
window.FilesystemDisplay = FilesystemDisplay;
