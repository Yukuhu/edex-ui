// ⚠️ THROWAWAY SPIKE — issue #84 (part of #83). NOT production code.
// Delete this file, _gemma_spike.js, and the ui.html script tag once the
// spike write-up lands on #83.
//
// Goal: de-risk the two unknowns before the real Gemma backend (#85+):
//   1. Does `onnx-community/gemma-4-E4B-it-ONNX` load + stream under
//      WebGPU inside Electron 42's renderer, from a module web worker?
//   2. Does `@huggingface/transformers` v4 actually install and run
//      alongside kokoro-js (which pins v3)?
//
// Must be loaded as an ES module worker:
//   new Worker("workers/gemma-spike-worker.js", { type: "module" })
//
// Mirrors src/workers/tts-worker-web.js: imports the *web* transformers
// build (onnxruntime-web + WebGPU/JSEP) by relative path, because module
// workers can't resolve bare specifiers.

import { pipeline, TextStreamer, env } from "../node_modules/@huggingface/transformers/dist/transformers.web.js";

// Point onnxruntime-web at the local ort-wasm files — the default is a
// CDN URL the renderer's CSP blocks. NOTE (spike finding #84): unlike
// transformers.js v3 (which co-located ort-wasm-*.jsep.{mjs,wasm} in its
// own dist/, see tts-worker-web.js), v4 ships ONLY the .jsep.mjs loader
// there — the .jsep.wasm binary lives in the hoisted onnxruntime-web
// package. So wasmPaths must point at onnxruntime-web/dist/, which holds
// both files. kokoro-js keeps its own nested onnxruntime-web@1.22, so
// this never touches the v3 path.
try {
    const wasmDir = new URL("../node_modules/onnxruntime-web/dist/", import.meta.url).href;
    env.backends.onnx.wasm.wasmPaths = wasmDir;
} catch (_) {
    // Fall back to defaults if URL resolution somehow fails.
}

// Unlike the TTS workers (which set useFSCache/useBrowserCache = false on
// a ~92 MB model), we leave caching at its defaults here so a second run
// loads from cache instead of re-pulling ~3-4 GB. Proper resumable FS
// caching is #89's job — this just proves "second run doesn't re-download".

const MODEL_ID = "onnx-community/gemma-4-E4B-it-ONNX";

let generator = null;

self.addEventListener("message", async (event) => {
    if (event.origin && event.origin !== self.location.origin) return; // S2819
    const msg = event.data || {};
    try {
        if (msg.type === "run") {
            await handleRun(msg.prompt || "In one sentence, what is a terminal emulator?");
        }
    } catch (err) {
        self.postMessage({ type: "error", message: err?.stack || err?.message || String(err) });
    }
});

function status(message) {
    self.postMessage({ type: "status", message });
}

async function handleRun(prompt) {
    // --- WebGPU adapter check (unknown #1, fail fast with a clear reason) ---
    if (typeof navigator === "undefined" || !navigator.gpu) {
        throw new Error("WebGPU not available in worker context (navigator.gpu missing)");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("WebGPU requestAdapter() returned null");
    }
    status(`WebGPU adapter OK. Loading ${MODEL_ID} (dtype q4f16)…`);

    // --- Load: text-generation pipeline, WebGPU device ---
    let lastPct = -1;
    const loadStart = performance.now();
    if (!generator) {
        generator = await pipeline("text-generation", MODEL_ID, {
            dtype: "q4f16",
            device: "webgpu",
            progress_callback: (e) => {
                self.postMessage({ type: "load-progress", event: e });
                if (e.status === "progress" && typeof e.progress === "number") {
                    const pct = Math.floor(e.progress);
                    if (pct !== lastPct && pct % 5 === 0) {
                        lastPct = pct;
                        status(`Downloading ${e.file || ""} ${pct}%`);
                    }
                }
            }
        });
    }
    const loadMs = performance.now() - loadStart;
    status(`Model ready in ${(loadMs / 1000).toFixed(1)}s. Generating…`);

    // --- Generate: TextStreamer, confirm streaming callbacks fire (unknown #1) ---
    const messages = [{ role: "user", content: prompt }];
    let tokenCount = 0;
    let firstTokenMs = null;
    const genStart = performance.now();

    const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text) => {
            if (firstTokenMs === null) firstTokenMs = performance.now() - genStart;
            tokenCount++;
            self.postMessage({ type: "token", token: text });
        }
    });

    const output = await generator(messages, {
        max_new_tokens: 128,
        do_sample: false,
        streamer
    });
    const genMs = performance.now() - genStart;

    // transformers.js returns the full conversation; grab the last turn's text.
    let finalText = "";
    try {
        const generated = output?.[0]?.generated_text;
        finalText = Array.isArray(generated)
            ? (generated[generated.length - 1]?.content ?? "")
            : String(generated ?? "");
    } catch (_) {}

    self.postMessage({
        type: "done",
        metrics: {
            loadMs: Math.round(loadMs),
            ttfbMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
            genMs: Math.round(genMs),
            tokenCount,
            tokensPerSec: tokenCount > 0 ? +(tokenCount / (genMs / 1000)).toFixed(2) : 0,
            transformersVersion: env?.version ?? "unknown"
        },
        finalText
    });
}
