// FsModal — a single Modal that hosts two FilesystemDisplay panes
// side-by-side with drag-and-drop file ops between them.
//
// Public API:
//   FsModal.open()             — single-instance guard; opens (or focuses) the modal
//   FsModal._lastCwds          — { left: <path>, right: <path> } persists between opens
//   instance.focusedPane       — last-clicked pane (left or right), used by global FS_LIST_VIEW / FS_DOTFILES
//
// Drop semantics:
//   - plain drop: copy
//   - shift held during drop: move
//   - destination already exists: confirm via a sub-Modal before proceeding
//   - directory drops are recursive; symlinks are copied as links (dereference: false)

class FsModal {
    static _lastCwds = { left: null, right: null };
    static _instance = null;

    static open() {
        if (FsModal._instance) {
            // Already open — pull it to the top.
            try { FsModal._instance.modal && window.modals[FsModal._instance.modal.id]?.focus(); } catch (_) {}
            return FsModal._instance;
        }
        return new FsModal();
    }

    constructor() {
        const os = require("os");
        const path = require("path");
        this.osLib = os;
        this.pathLib = path;
        this.fsLib = require("fs");

        FsModal._instance = this;
        this.leftPane = null;
        this.rightPane = null;
        this.focusedPane = null; // becomes either pane on first mousedown

        const detachKeyboard = window.keyboard?.detach ? () => window.keyboard.detach() : () => {};
        const attachKeyboard = window.keyboard?.attach ? () => window.keyboard.attach() : () => {};
        detachKeyboard();

        const html = `<div class="fs_modal_root">
            <div class="fs_modal_columns">
                <div class="fs_modal_column" data-side="left">
                    <div class="fs_modal_paneHeader">
                        <span class="fs_modal_path" id="fs_modal_pathLeft"></span>
                        <span class="fs_modal_navButtons">
                            <button type="button" data-action="up"      title="Up one level">UP</button>
                            <button type="button" data-action="home"    title="Home directory">HOME</button>
                            <button type="button" data-action="termcwd" title="Active terminal's CWD">TTY CWD</button>
                            <button type="button" data-action="refresh" title="Refresh">REFRESH</button>
                            <button type="button" data-action="listview" title="Toggle list / grid (Ctrl+Shift+L)">VIEW</button>
                            <button type="button" data-action="dotfiles" title="Toggle hidden files (Ctrl+Shift+H)">DOTFILES</button>
                        </span>
                    </div>
                    <div class="fs_modal_pane" id="fs_modal_paneLeft"></div>
                </div>
                <div class="fs_modal_column" data-side="right">
                    <div class="fs_modal_paneHeader">
                        <span class="fs_modal_path" id="fs_modal_pathRight"></span>
                        <span class="fs_modal_navButtons">
                            <button type="button" data-action="up">UP</button>
                            <button type="button" data-action="home">HOME</button>
                            <button type="button" data-action="termcwd">TTY CWD</button>
                            <button type="button" data-action="refresh">REFRESH</button>
                            <button type="button" data-action="listview">VIEW</button>
                            <button type="button" data-action="dotfiles">DOTFILES</button>
                        </span>
                    </div>
                    <div class="fs_modal_pane" id="fs_modal_paneRight"></div>
                </div>
            </div>
            <div class="fs_modal_status">
                <span>Drag between panes to copy. Hold <kbd>Shift</kbd> while dropping to move. Existing files prompt for confirmation.</span>
            </div>
        </div>`;

        this.modal = new Modal({
            type: "custom",
            title: "FILESYSTEM",
            html
        }, () => {
            // onclose: stash CWDs and tear down panes.
            if (this.leftPane)  { FsModal._lastCwds.left  = this.leftPane.dirpath  || FsModal._lastCwds.left; this.leftPane.destroy();  }
            if (this.rightPane) { FsModal._lastCwds.right = this.rightPane.dirpath || FsModal._lastCwds.right; this.rightPane.destroy(); }
            FsModal._instance = null;
            attachKeyboard();
            if (window.term && window.currentTerm !== undefined && window.term[window.currentTerm]) {
                try { window.term[window.currentTerm].term.focus(); } catch (_) {}
            }
        });
        this.modal._isFsModal = true;
        if (window.modals?.[this.modal.id]) window.modals[this.modal.id]._isFsModal = true;

        // Resolve the modal DOM root after Modal mounts it.
        this.root = document.getElementById("modal_" + this.modal.id);
        this.pathLeftEl  = this.root.querySelector("#fs_modal_pathLeft");
        this.pathRightEl = this.root.querySelector("#fs_modal_pathRight");
        this.leftColumn  = this.root.querySelector(".fs_modal_column[data-side='left']");
        this.rightColumn = this.root.querySelector(".fs_modal_column[data-side='right']");

        // Initial CWDs: last-used → home dir (or the terminal's CWD if there is none yet).
        const home = os.homedir();
        const initialLeft  = FsModal._lastCwds.left  || home;
        const initialRight = FsModal._lastCwds.right || home;

        this.leftPane  = new FilesystemDisplay({ container: this.root.querySelector("#fs_modal_paneLeft"),  initialCwd: initialLeft  });
        this.rightPane = new FilesystemDisplay({ container: this.root.querySelector("#fs_modal_paneRight"), initialCwd: initialRight });

        // Track focused pane and react to drop events from either pane.
        this._onPaneMousedown = e => {
            const col = e.target.closest(".fs_modal_column");
            if (!col) return;
            this.focusedPane = col.dataset.side === "left" ? this.leftPane : this.rightPane;
            this.root.querySelectorAll(".fs_modal_column").forEach(c => c.classList.toggle("focused", c === col));
        };
        this.root.addEventListener("mousedown", this._onPaneMousedown);
        // Default focus on left.
        this.focusedPane = this.leftPane;
        this.leftColumn.classList.add("focused");

        this._onDrop = e => {
            const { srcPath, srcName, srcType, shiftKey, targetPane } = e.detail || {};
            if (!srcPath || !targetPane) return;
            this._handleDrop({ srcPath, srcName, srcType, move: shiftKey, targetPane });
        };
        this.root.addEventListener("ndex-fs-drop", this._onDrop);

        // Update the path label on each pane when its CWD changes.
        this._onCwd = e => {
            if (e.detail && e.detail.pane === this.leftPane)  this.pathLeftEl.textContent  = e.detail.cwd;
            if (e.detail && e.detail.pane === this.rightPane) this.pathRightEl.textContent = e.detail.cwd;
        };
        this.root.addEventListener("ndex-fs-cwd", this._onCwd);
        // Initial labels (panes may not have emitted yet).
        this.pathLeftEl.textContent  = initialLeft;
        this.pathRightEl.textContent = initialRight;

        // Per-pane header buttons.
        this.root.querySelectorAll(".fs_modal_column").forEach(col => {
            const pane = col.dataset.side === "left" ? this.leftPane : this.rightPane;
            col.querySelectorAll(".fs_modal_navButtons button").forEach(btn => {
                btn.addEventListener("click", () => this._headerAction(pane, btn.dataset.action));
            });
        });
    }

    _headerAction(pane, action) {
        switch (action) {
            case "up":       pane.readFS(this.pathLib.resolve(pane.dirpath || this.osLib.homedir(), "..")); break;
            case "home":     pane.readFS(this.osLib.homedir()); break;
            case "termcwd": {
                if (!window.term?.[window.currentTerm]) break;
                let cwd = window.term[window.currentTerm].cwd || window.settings.cwd;
                if (cwd?.startsWith("FALLBACK |-- ")) cwd = cwd.slice(13);
                if (cwd) pane.readFS(cwd);
                break;
            }
            case "refresh":  pane.refresh(); break;
            case "listview": pane.toggleListview(); break;
            case "dotfiles": pane.toggleHidedotfiles(); break;
        }
    }

    async _handleDrop({ srcPath, srcName, move, targetPane }) {
        // Resolve destination inside the target pane's CWD.
        const dstDir = targetPane.dirpath;
        if (!dstDir) {
            this._info("Target pane has no current directory.");
            return;
        }
        const dstPath = this.pathLib.join(dstDir, srcName);

        // No-op if dropping in the same directory.
        const srcDir = this.pathLib.dirname(srcPath);
        if (this.pathLib.resolve(srcDir) === this.pathLib.resolve(dstDir)) return;

        // Sanity gate — refuse anything that would touch / or move root.
        if (srcPath === "/" || dstPath === "/" || srcPath === "" || dstPath === "") {
            this._info("Refusing destructive operation on the filesystem root.");
            return;
        }

        // Detect overwrite and prompt.
        let exists = false;
        try { exists = this.fsLib.existsSync(dstPath); } catch (_) {}
        if (exists) {
            const proceed = await this._confirm(`Overwrite ${srcName}?`, dstPath);
            if (!proceed) return;
        }

        try {
            if (move) {
                try {
                    await this.fsLib.promises.rename(srcPath, dstPath);
                } catch (err) {
                    if (err?.code === "EXDEV") {
                        // Cross-device — fall back to copy + delete.
                        await this.fsLib.promises.cp(srcPath, dstPath, { recursive: true, force: true, dereference: false });
                        await this.fsLib.promises.rm(srcPath, { recursive: true, force: true });
                    } else { throw err; }
                }
            } else {
                await this.fsLib.promises.cp(srcPath, dstPath, { recursive: true, force: !!exists, dereference: false });
            }
        } catch (err) {
            this._info(`${move ? "Move" : "Copy"} failed: ${err?.message ? err.message : String(err)}`);
            return;
        }

        // Refresh both panes so the change is visible everywhere.
        try { await this.leftPane.refresh();  } catch (_) {}
        try { await this.rightPane.refresh(); } catch (_) {}
    }

    _confirm(title, detailLine) {
        return new Promise(resolve => {
            let resolved = false;
            window.fsModalConfirmYes = () => { if (!resolved) { resolved = true; resolve(true);  } window.modals[m.id].close(); };
            window.fsModalConfirmNo  = () => { if (!resolved) { resolved = true; resolve(false); } window.modals[m.id].close(); };
            const m = new Modal({
                type: "custom",
                title: title,
                html: `<h5>The destination already exists. Overwrite it?</h5><p style="opacity:0.6;font-family:var(--font_mono);font-size:1.3vh;word-break:break-all;">${(window._escapeHtml || (s => s))(detailLine)}</p>`,
                buttons: [
                    { label: "Overwrite", action: "window.fsModalConfirmYes();" },
                    { label: "Cancel",    action: "window.fsModalConfirmNo();" }
                ]
            }, () => {
                // If the user closes via Esc or the modal's own Close button
                // without picking, treat that as Cancel.
                if (!resolved) { resolved = true; resolve(false); }
            });
        });
    }

    _info(message) {
        Modal.show({ type: "info", title: "Filesystem", message });
    }
}

module.exports = { FsModal };
window.FsModal = FsModal;
