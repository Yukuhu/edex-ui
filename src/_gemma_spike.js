// ⚠️ THROWAWAY SPIKE — issue #84 (part of #83). NOT production code.
// Injects a hardcoded panel into the bottom-right of the UI with two
// buttons:
//   • "Run Gemma spike" — loads onnx-community/gemma-4-E4B-it-ONNX under
//     WebGPU in a module worker and streams ~128 tokens (unknown #1).
//   • "TTS smoke test"  — runs kokoro-js TTS via window.ttsEngine to
//     confirm v3 still works with v4 installed alongside (unknown #2).
//
// To remove the spike: delete this file, src/workers/gemma-spike-worker.js,
// and the <script src="_gemma_spike.js"> tag in src/ui.html.
//
// NOTE: _renderer.js builds its layout with `document.body.innerHTML += …`,
// which re-parses the whole body and recreates every node — that silently
// drops any addEventListener listener bound to our buttons. So we (a) bind
// a single delegated click listener on `document` (never recreated), (b)
// re-query elements by id at click time instead of holding stale refs, and
// (c) rebuild the panel if the re-parse ever drops it.

(() => {
    "use strict";

    const PANEL_ID = "gemmaSpikePanel";
    const LOG_ID = "gemmaSpikeLog";
    const GEMMA_BTN_ID = "gemmaSpikeRunBtn";
    const TTS_BTN_ID = "gemmaSpikeTtsBtn";

    function ensurePanel() {
        if (document.getElementById(PANEL_ID)) return;

        const panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.style.cssText = [
            "position:fixed", "bottom:8px", "right:8px", "z-index:2147483647",
            "width:420px", "max-height:50vh", "overflow:auto",
            "background:rgba(0,0,0,0.92)", "border:1px solid #aacfd1",
            "color:#aacfd1", "font-family:monospace", "font-size:11px",
            "padding:8px", "box-shadow:0 0 12px rgba(170,207,209,0.4)"
        ].join(";");

        // Built as an HTML string so it survives _renderer.js's
        // `body.innerHTML +=` re-parse intact (inline styles + ids are
        // serialised; JS-attached listeners would not be).
        const btnCss = "flex:1;background:#1a2a2b;color:#aacfd1;" +
            "border:1px solid #aacfd1;padding:4px 6px;" +
            "font-family:monospace;font-size:11px;cursor:pointer";
        panel.innerHTML =
            '<div style="font-weight:bold;margin-bottom:6px;color:#f0c674">' +
            '⚠ GEMMA SPIKE #84 — throwaway</div>' +
            '<div style="display:flex;gap:6px;margin-bottom:6px">' +
            '<button id="' + GEMMA_BTN_ID + '" style="' + btnCss + '">Run Gemma spike</button>' +
            '<button id="' + TTS_BTN_ID + '" style="' + btnCss + '">TTS smoke test</button>' +
            '</div>' +
            '<pre id="' + LOG_ID + '" style="white-space:pre-wrap;margin:0;line-height:1.35"></pre>';

        document.body.appendChild(panel);
    }

    function getLog() {
        ensurePanel();
        return document.getElementById(LOG_ID);
    }

    function logLine(text) {
        const log = getLog();
        log.textContent += text + "\n";
        log.scrollTop = log.scrollHeight;
        console.info("[gemma-spike]", text);
    }

    function runGemma() {
        const btn = document.getElementById(GEMMA_BTN_ID);
        if (btn) btn.disabled = true;
        getLog().textContent = "";
        logLine("Spawning module worker…");

        let worker;
        try {
            worker = new Worker("workers/gemma-spike-worker.js", { type: "module" });
        } catch (err) {
            logLine("FAILED to construct worker: " + (err.message || err));
            if (btn) btn.disabled = false;
            return;
        }

        let answer = "";
        const finish = () => {
            worker.terminate();
            const b = document.getElementById(GEMMA_BTN_ID);
            if (b) b.disabled = false;
        };

        worker.addEventListener("message", (ev) => {
            const msg = ev.data || {};
            switch (msg.type) {
                case "status":
                    logLine("· " + msg.message);
                    break;
                case "load-progress":
                    if (msg.event && (msg.event.status === "initiate" || msg.event.status === "done")) {
                        logLine("  [" + msg.event.status + "] " + (msg.event.file || ""));
                    }
                    break;
                case "token": {
                    answer += msg.token;
                    const log = getLog();
                    log.textContent = log.textContent.replace(/(\n>> .*)?$/, "\n>> " + answer);
                    log.scrollTop = log.scrollHeight;
                    break;
                }
                case "done":
                    logLine("");
                    logLine("=== METRICS (paste into #83) ===");
                    logLine("transformers.js: " + msg.metrics.transformersVersion);
                    logLine("load:            " + msg.metrics.loadMs + " ms");
                    logLine("time-to-first:   " + msg.metrics.ttfbMs + " ms");
                    logLine("generate:        " + msg.metrics.genMs + " ms");
                    logLine("tokens:          " + msg.metrics.tokenCount);
                    logLine("tokens/sec:      " + msg.metrics.tokensPerSec);
                    logLine("Also record: download size (DevTools Network) + VRAM (Activity Monitor / GPU report).");
                    finish();
                    break;
                case "error":
                    logLine("ERROR: " + msg.message);
                    finish();
                    break;
            }
        });
        worker.addEventListener("error", (err) => {
            // A module worker that fails to *load* (e.g. an unresolved
            // import) fires a bare Event with no detail — surface every
            // field we can so it isn't an opaque "[object Event]".
            const parts = [];
            if (err.message) parts.push(err.message);
            if (err.filename) parts.push("@ " + err.filename + ":" + err.lineno + ":" + err.colno);
            if (!parts.length) parts.push("bare " + err.type + " event (module worker likely failed to load — check DevTools console for the import error)");
            logLine("WORKER ERROR: " + parts.join(" "));
            finish();
        });
        worker.addEventListener("messageerror", (e) => {
            logLine("WORKER MESSAGEERROR: " + (e && e.type));
            finish();
        });

        worker.postMessage({ type: "run" });
    }

    async function runTts() {
        const btn = document.getElementById(TTS_BTN_ID);
        if (btn) btn.disabled = true;
        logLine("");
        logLine("TTS smoke test — checking window.ttsEngine…");
        try {
            if (!window.ttsEngine) {
                logLine("window.ttsEngine is undefined — kokoro-js may have failed to load.");
                return;
            }
            logLine("ttsEngine.isAvailable = " + window.ttsEngine.isAvailable);
            await window.ttsEngine.preload();
            window.ttsEngine.speak("Transformers version four and kokoro version three coexist.");
            logLine("speak() called — listen for audio. If it plays, kokoro-js still works.");
        } catch (err) {
            logLine("TTS ERROR: " + (err.stack || err.message || err));
        } finally {
            const b = document.getElementById(TTS_BTN_ID);
            if (b) b.disabled = false;
        }
    }

    // Single delegated listener on `document` — survives _renderer.js's
    // body re-parse, unlike per-button listeners. Capture phase so we run
    // regardless of any handler _renderer.js attaches further down.
    document.addEventListener("click", (e) => {
        const t = e.target;
        if (!t || !t.id) return;
        if (t.id === GEMMA_BTN_ID) {
            e.stopPropagation();
            runGemma();
        } else if (t.id === TTS_BTN_ID) {
            e.stopPropagation();
            runTts();
        }
    }, true);

    // Build now, and re-assert after _renderer.js's async layout build so
    // the panel reappears if the body re-parse ever drops it entirely.
    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", ensurePanel);
    } else {
        ensurePanel();
    }
    for (const delay of [1000, 3000, 6000]) {
        setTimeout(ensurePanel, delay);
    }
})();
