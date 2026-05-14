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

(() => {
    "use strict";

    function build() {
        const panel = document.createElement("div");
        panel.id = "gemmaSpikePanel";
        panel.style.cssText = [
            "position:fixed", "bottom:8px", "right:8px", "z-index:99999",
            "width:420px", "max-height:50vh", "overflow:auto",
            "background:rgba(0,0,0,0.92)", "border:1px solid #aacfd1",
            "color:#aacfd1", "font-family:monospace", "font-size:11px",
            "padding:8px", "box-shadow:0 0 12px rgba(170,207,209,0.4)"
        ].join(";");

        const title = document.createElement("div");
        title.textContent = "⚠ GEMMA SPIKE #84 — throwaway";
        title.style.cssText = "font-weight:bold;margin-bottom:6px;color:#f0c674";
        panel.appendChild(title);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:6px;margin-bottom:6px";
        const gemmaBtn = mkBtn("Run Gemma spike");
        const ttsBtn = mkBtn("TTS smoke test");
        btnRow.appendChild(gemmaBtn);
        btnRow.appendChild(ttsBtn);
        panel.appendChild(btnRow);

        const log = document.createElement("pre");
        log.id = "gemmaSpikeLog";
        log.style.cssText = "white-space:pre-wrap;margin:0;line-height:1.35";
        panel.appendChild(log);

        document.body.appendChild(panel);

        gemmaBtn.addEventListener("click", () => runGemma(gemmaBtn, log));
        ttsBtn.addEventListener("click", () => runTts(ttsBtn, log));
    }

    function mkBtn(label) {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = [
            "flex:1", "background:#1a2a2b", "color:#aacfd1",
            "border:1px solid #aacfd1", "padding:4px 6px",
            "font-family:monospace", "font-size:11px", "cursor:pointer"
        ].join(";");
        return b;
    }

    function logLine(log, text) {
        log.textContent += text + "\n";
        log.scrollTop = log.scrollHeight;
        console.info("[gemma-spike]", text);
    }

    function runGemma(btn, log) {
        btn.disabled = true;
        log.textContent = "";
        logLine(log, "Spawning module worker…");

        let worker;
        try {
            worker = new Worker("workers/gemma-spike-worker.js", { type: "module" });
        } catch (err) {
            logLine(log, "FAILED to construct worker: " + (err.message || err));
            btn.disabled = false;
            return;
        }

        let answer = "";
        worker.addEventListener("message", (ev) => {
            const msg = ev.data || {};
            switch (msg.type) {
                case "status":
                    logLine(log, "· " + msg.message);
                    break;
                case "load-progress":
                    // Verbose; only surface file-level start/done.
                    if (msg.event && (msg.event.status === "initiate" || msg.event.status === "done")) {
                        logLine(log, `  [${msg.event.status}] ${msg.event.file || ""}`);
                    }
                    break;
                case "token":
                    answer += msg.token;
                    log.textContent = log.textContent.replace(/(\n>> .*)?$/, "\n>> " + answer);
                    log.scrollTop = log.scrollHeight;
                    break;
                case "done":
                    logLine(log, "");
                    logLine(log, "=== METRICS (paste into #83) ===");
                    logLine(log, "transformers.js: " + msg.metrics.transformersVersion);
                    logLine(log, "load:            " + msg.metrics.loadMs + " ms");
                    logLine(log, "time-to-first:   " + msg.metrics.ttfbMs + " ms");
                    logLine(log, "generate:        " + msg.metrics.genMs + " ms");
                    logLine(log, "tokens:          " + msg.metrics.tokenCount);
                    logLine(log, "tokens/sec:      " + msg.metrics.tokensPerSec);
                    logLine(log, "Also record: download size (DevTools Network) + VRAM (Activity Monitor / GPU report).");
                    worker.terminate();
                    btn.disabled = false;
                    break;
                case "error":
                    logLine(log, "ERROR: " + msg.message);
                    worker.terminate();
                    btn.disabled = false;
                    break;
            }
        });
        worker.addEventListener("error", (err) => {
            logLine(log, "WORKER ERROR: " + (err.message || err));
            btn.disabled = false;
        });

        worker.postMessage({ type: "run" });
    }

    async function runTts(btn, log) {
        btn.disabled = true;
        logLine(log, "");
        logLine(log, "TTS smoke test — checking window.ttsEngine…");
        try {
            if (!window.ttsEngine) {
                logLine(log, "window.ttsEngine is undefined — kokoro-js may have failed to load.");
                return;
            }
            logLine(log, "ttsEngine.isAvailable = " + window.ttsEngine.isAvailable);
            await window.ttsEngine.preload();
            window.ttsEngine.speak("Transformers version four and kokoro version three coexist.");
            logLine(log, "speak() called — listen for audio. If it plays, kokoro-js still works.");
        } catch (err) {
            logLine(log, "TTS ERROR: " + (err.stack || err.message || err));
        } finally {
            btn.disabled = false;
        }
    }

    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", build);
    } else {
        build();
    }
})();
