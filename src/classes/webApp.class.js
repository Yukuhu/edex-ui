class WebApp {
    // v1 keeps a single webapp open at a time. Opening another closes
    // the current one — Chromium renderers per webview aren't free.
    static _instance = null;

    // Matches the Chromium version bundled with Electron 42 (148.x).
    // Mismatched UAs sometimes flip Google's "embedded browser"
    // heuristics — they 403 sign-in when the UA looks older than the
    // real engine. This doesn't bypass Google's full anti-embedding
    // policy (some sign-in flows still refuse webviews on principle),
    // but it removes one easy fingerprint.
    static USERAGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

    constructor(app) {
        if (WebApp._instance) {
            try {
                WebApp._instance.close();
            } catch (err) {
                console.warn("WebApp: closing previous instance failed", err);
            }
        }
        WebApp._instance = this;
        window.activeWebApp = this;

        this.app = app;
        this.fullscreen = false;

        window.keyboard.detach();

        const partition = `persist:webapp-${app.id}`;
        const safeName = window._escapeHtml(app.name);
        const safeUrl = window._escapeHtml(app.url);
        // app.id is sanitized when added through the UI, but webapps.json
        // can be hand-edited — escape every interpolation into HTML
        // attributes as defense-in-depth.
        const safeId = window._escapeHtml(app.id);
        // Build a file:// URL for the preload script. Using string
        // concatenation is fragile on Windows (`file://C:\…` is
        // invalid); pathToFileURL handles drive letters and separator
        // conversion.
        const path = require("path");
        const url = require("url");
        const preloadUrl = url.pathToFileURL(path.join(__dirname, "classes/webApp-preload.js")).toString();

        this.disp = new Modal({
            type: "custom",
            title: `WebApp · ${safeName}`,
            html: `<div class="webappContainer" id="webappContainer-${safeId}">
                <div class="webappToolbar">
                    <span class="webappTitle">${safeName}</span>
                    <span class="webappHint">F11 / Ctrl+Enter fullscreen &nbsp;·&nbsp; Ctrl+Shift+T &rarr; tab &nbsp;·&nbsp; Esc close</span>
                    <button type="button" class="webappFsBtn" id="webappFsBtn-${safeId}" title="Toggle fullscreen (F11 / Ctrl+Enter)" onclick="window.activeWebApp && window.activeWebApp.toggleFullscreen()">&#x2922;</button>
                </div>
                <div class="webappViewport" id="webappViewport-${safeId}">
                    <webview
                        id="webappView-${safeId}"
                        class="webappWebview"
                        src="${safeUrl}"
                        partition="${window._escapeHtml(partition)}"
                        allowpopups
                        useragent="${window._escapeHtml(WebApp.USERAGENT)}"
                        preload="${window._escapeHtml(preloadUrl)}"
                        webpreferences="contextIsolation=false, nodeIntegration=false"
                    ></webview>
                </div>
            </div>`,
            buttons: []
        }, () => {
            // onclose
            if (this._docKeydown) {
                document.removeEventListener("keydown", this._docKeydown, true);
                this._docKeydown = null;
            }
            if (WebApp._instance === this) WebApp._instance = null;
            if (window.activeWebApp === this) delete window.activeWebApp;
            window.keyboard.attach();
            window.term[window.currentTerm].term.focus();
        });

        // Tag the modal so the CSS can size it big and toggle the
        // fullscreen-fill variant.
        //
        // Critical: Modal.focus()/unfocus() re-apply the class
        // attribute via setAttribute("class", this.classes + " focus"),
        // which wipes any classes added with classList.add. To survive
        // that, we mutate this.disp.classes itself and reapply the
        // string manually — every subsequent focus()/unfocus() then
        // preserves our classes.
        this.modalEl = document.getElementById("modal_" + this.disp.id);
        this.disp.classes += " webappModal";
        this._reapplyModalClasses();

        this.container = document.getElementById(`webappContainer-${app.id}`);
        this.webview = document.getElementById(`webappView-${app.id}`);

        // Document-level keydown so the hotkeys fire even when focus is
        // on the modal chrome (close button, toolbar) or anywhere else
        // in the parent renderer. Inside the webview we rely on
        // before-input-event instead (separate Chromium process).
        this._docKeydown = (e) => this._handleHotkey(e);
        document.addEventListener("keydown", this._docKeydown, true);

        // Wire webview lifecycle + hotkey interception + diagnostics.
        if (this.webview) {
            this.webview.addEventListener("dom-ready", () => this._wireWebviewKeys());
            this.webview.addEventListener("did-finish-load", () => {
                console.log(`[WebApp:${app.id}] did-finish-load`);
            });
            this.webview.addEventListener("did-fail-load", (e) => {
                if (e.isMainFrame) {
                    console.warn(`[WebApp:${app.id}] did-fail-load ${e.errorCode} ${e.errorDescription} → ${e.validatedURL}`);
                    new Modal({
                        type: "warning",
                        message: `Could not load <code>${window._escapeHtml(e.validatedURL)}</code><br>${window._escapeHtml(e.errorDescription || "")} (${e.errorCode})`
                    });
                }
            });
            this.webview.addEventListener("render-process-gone", (e) => {
                console.warn(`[WebApp:${app.id}] render-process-gone reason=${e.reason} exitCode=${e.exitCode}`);
                new Modal({
                    type: "error",
                    title: "WebApp crashed",
                    message: `The embedded renderer for <code>${window._escapeHtml(app.name)}</code> exited (reason: <code>${window._escapeHtml(e.reason || "unknown")}</code>). Reopen the app from the launcher to retry.`
                });
                // The webview is dead; close the host modal so the
                // user isn't staring at an unresponsive black frame.
                this.close();
            });
            this.webview.addEventListener("console-message", (e) => {
                // Forward webview console output to the parent renderer
                // so the user can see it from DevTools (Ctrl+Shift+I).
                const tag = `[WebApp:${app.id}:${e.level}]`;
                if (e.level >= 2) console.warn(tag, e.message);
                else console.log(tag, e.message);
            });
            // Popup routing (target=_blank, window.open) is wired in
            // the main process via setWindowOpenHandler on the guest's
            // webContents — see src/_boot.js' web-contents-created
            // handler. The <webview>'s `new-window` DOM event was
            // removed in Electron 22+ with no direct replacement.
        }
    }

    // Single source of truth for the WebApp hotkey map. Called both
    // from the host document's keydown listener (parent renderer) and
    // from the webview's before-input-event listener (guest renderer);
    // each path supplies its own preventDefault callback because the
    // event shapes differ.
    _dispatchHotkey({ key, ctrl, shift }, preventDefault) {
        const k = (key || "").toLowerCase();
        if (key === "F11") {
            preventDefault();
            this.toggleFullscreen();
            return true;
        }
        if (ctrl && (k === "enter" || k === "return")) {
            preventDefault();
            this.toggleFullscreen();
            return true;
        }
        if (ctrl && shift && k === "t") {
            preventDefault();
            this.tabIntegrateStub();
            return true;
        }
        if (ctrl && shift && k === "d") {
            preventDefault();
            this.openWebviewDevtools();
            return true;
        }
        return false;
    }

    _wireWebviewKeys() {
        try {
            const remote = require("@electron/remote");
            const wc = remote.webContents.fromId(this.webview.getWebContentsId());
            if (!wc || wc._webappHotkeysWired) return;
            wc._webappHotkeysWired = true;
            wc.on("before-input-event", (event, input) => {
                if (input.type !== "keyDown") return;
                this._dispatchHotkey(
                    { key: input.key, ctrl: input.control, shift: input.shift },
                    () => event.preventDefault()
                );
            });
        } catch (e) {
            console.warn("WebApp: failed to wire webview hotkeys", e);
        }
    }

    _handleHotkey(e) {
        this._dispatchHotkey(
            { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey },
            () => e.preventDefault()
        );
    }

    openWebviewDevtools() {
        try {
            if (this.webview && typeof this.webview.openDevTools === "function") {
                this.webview.openDevTools();
                console.log(`[WebApp:${this.app.id}] webview devtools opened`);
            }
        } catch (e) {
            console.warn(`[WebApp:${this.app.id}] openDevTools failed`, e);
        }
    }

    toggleFullscreen() {
        if (!this.modalEl) return;
        this.fullscreen = !this.fullscreen;
        // See _reapplyModalClasses — we own the class string so focus/
        // unfocus don't drop the fullscreen class.
        this.disp.classes = this.disp.classes.replace(/\s*webappFullscreen/g, "");
        if (this.fullscreen) this.disp.classes += " webappFullscreen";
        this._reapplyModalClasses();
        const btn = document.getElementById(`webappFsBtn-${this.app.id}`);
        if (btn) btn.innerHTML = this.fullscreen ? "&#x2923;" : "&#x2922;";
        console.log(`[WebApp:${this.app.id}] fullscreen=${this.fullscreen}`);
    }

    _reapplyModalClasses() {
        if (!this.modalEl) return;
        const wasFocused = this.modalEl.className.split(/\s+/).includes("focus");
        this.modalEl.setAttribute("class", this.disp.classes + (wasFocused ? " focus" : ""));
    }

    tabIntegrateStub() {
        new Modal({
            type: "warning",
            message: "Tab integration is still on the roadmap — tracked in <a href=\"#\" onclick=\"require('@electron/remote').shell.openExternal('https://github.com/Yukuhu/edex-ui/issues/29');return false;\">issue #29</a>."
        });
    }

    close() {
        if (this.disp) this.disp.close();
    }
}

module.exports = {
    WebApp
};
