// Spike (issue #84): scratch launcher for gemma-spike-worker.js.
// Throwaway — exists only to answer "does Gemma 4 E4B ONNX load and
// stream under WebGPU in this Electron build?". Will be deleted once
// the spike lands a write-up on #83/#84.
//
// Usage (DevTools console after the boot screen finishes):
//   await gemmaSpike("Why is the sky blue?")
//
// Logs every worker message to the console and paints a fixed overlay
// in the top-left with the streamed text + summary metrics.

(() => {
    let panel = null;
    function ensurePanel() {
        if (panel) return panel;
        panel = document.createElement("div");
        panel.id = "gemma-spike-panel";
        Object.assign(panel.style, {
            position: "fixed", top: "8px", left: "8px",
            width: "560px", maxHeight: "70vh", overflow: "auto",
            zIndex: 99999, padding: "8px 10px",
            background: "rgba(0,0,0,0.85)", color: "#9efeff",
            font: "12px/1.4 monospace",
            border: "1px solid #29b8c1", borderRadius: "3px",
            whiteSpace: "pre-wrap", pointerEvents: "auto"
        });
        const close = document.createElement("button");
        close.textContent = "×";
        Object.assign(close.style, {
            float: "right", background: "transparent", color: "#9efeff",
            border: "1px solid #29b8c1", cursor: "pointer", marginLeft: "6px"
        });
        close.onclick = () => { panel.remove(); panel = null; };
        panel.appendChild(close);
        const body = document.createElement("div");
        body.id = "gemma-spike-body";
        panel.appendChild(body);
        document.body.appendChild(panel);
        return panel;
    }
    function write(line) {
        ensurePanel();
        const body = document.getElementById("gemma-spike-body");
        body.textContent += line + "\n";
        panel.scrollTop = panel.scrollHeight;
    }
    function writeRaw(text) {
        ensurePanel();
        const body = document.getElementById("gemma-spike-body");
        body.textContent += text;
        panel.scrollTop = panel.scrollHeight;
    }

    window.gemmaSpike = async function gemmaSpike(prompt) {
        prompt = prompt || "In one sentence, what is the speed of light?";
        write(`[spike] starting — prompt: ${JSON.stringify(prompt)}`);

        if (!navigator.gpu) {
            write("[spike] navigator.gpu missing on renderer — WebGPU disabled");
        } else {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (adapter) {
                    const info = adapter.info || {};
                    write(`[spike] WebGPU adapter ok — vendor=${info.vendor || "?"} arch=${info.architecture || "?"} device=${info.device || "?"}`);
                } else {
                    write("[spike] WebGPU requestAdapter() returned null");
                }
            } catch (e) {
                write(`[spike] adapter probe threw: ${e.message}`);
            }
        }

        const worker = new Worker("workers/gemma-spike-worker.js", { type: "module" });
        let loadProgressLast = 0;

        const done = new Promise((resolve, reject) => {
            worker.addEventListener("error", (err) => {
                write(`[worker:error] ${err.message || err}`);
                reject(err);
            });
            worker.addEventListener("message", (ev) => {
                const m = ev.data || {};
                switch (m.type) {
                    case "load-progress": {
                        const e = m.event || {};
                        if (e.status === "progress" && typeof e.progress === "number") {
                            const pct = Math.floor(e.progress);
                            if (pct >= loadProgressLast + 5) {
                                loadProgressLast = pct;
                                write(`[load] ${e.file || "?"} ${pct}% (${Math.round((e.loaded||0)/1e6)}/${Math.round((e.total||0)/1e6)} MB)`);
                            }
                        } else if (e.status && e.status !== "progress") {
                            write(`[load] ${e.status} ${e.file || ""}`);
                        }
                        break;
                    }
                    case "load-ready":
                        write(`[load] ready — ${Math.round(m.loadMs)}ms (cached=${!!m.cached}, backend=${m.backend})`);
                        write(`[gen] sending prompt …`);
                        worker.postMessage({ type: "generate", prompt });
                        break;
                    case "token":
                        writeRaw(m.text);
                        break;
                    case "generate-done":
                        write(`\n[gen] done — ${m.tokens} tokens in ${Math.round(m.genMs)}ms (${m.tokensPerSec.toFixed(2)} tok/s)`);
                        resolve(m);
                        worker.terminate();
                        break;
                    case "error":
                        write(`[worker:${m.phase}] ${m.message}`);
                        reject(new Error(m.message));
                        worker.terminate();
                        break;
                    default:
                        console.log("[gemma-spike] unhandled message:", m);
                }
            });
        });

        worker.postMessage({ type: "load" });
        return done;
    };

    console.info("[gemma-spike] launcher loaded — call await gemmaSpike() in the console.");
})();
