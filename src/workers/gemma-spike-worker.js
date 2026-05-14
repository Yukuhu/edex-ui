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
// SPIKE FINDING (#84): unlike kokoro-js (whose kokoro.web.js ships fully
// pre-bundled), @huggingface/transformers v4's own dist/transformers.web.js
// keeps `onnxruntime-web/webgpu` + `onnxruntime-common` as *bare* static
// imports — which a module worker cannot resolve, so importing it directly
// dies with an opaque worker `error` Event before any code runs. So we
// pre-bundle it once with esbuild into a self-contained ESM file:
//
//   npx esbuild node_modules/@huggingface/transformers/dist/transformers.web.js \
//     --bundle --format=esm --outfile=workers/gemma-transformers.bundle.js
//
// The real backend (#85) will need an equivalent bundling step in the
// build pipeline. The bundle is committed here only because the whole
// spike is throwaway.

import { pipeline, TextStreamer, env } from "./gemma-transformers.bundle.js";

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
    // Progress logging has to cope with HuggingFace serving the big
    // *.onnx_data weight files WITHOUT a content-length header — so
    // `e.progress`/`e.total` are undefined and a percentage-only logger
    // goes dark for minutes on the multi-GB files. Track per-file state
    // and fall back to "MB downloaded" + throttle by time, not by %.
    const MB = 1024 * 1024;
    const fileState = new Map(); // file -> { lastPct, lastLoggedMs, lastBytes }
    const loadStart = performance.now();
    if (!generator) {
        generator = await pipeline("text-generation", MODEL_ID, {
            dtype: "q4f16",
            device: "webgpu",
            progress_callback: (e) => {
                self.postMessage({ type: "load-progress", event: e });
                if (e.status !== "progress" || !e.file) return;
                const st = fileState.get(e.file) || { lastPct: -1, lastLoggedMs: 0, lastBytes: 0 };
                const now = performance.now();
                if (typeof e.progress === "number" && typeof e.total === "number" && e.total > 0) {
                    // content-length known: log on 10% boundaries.
                    const pct = Math.floor(e.progress);
                    if (pct !== st.lastPct && pct % 10 === 0) {
                        st.lastPct = pct;
                        status(`${e.file} ${pct}% (${(e.total / MB).toFixed(0)} MB)`);
                    }
                } else if (typeof e.loaded === "number") {
                    // content-length unknown: log MB every ~2s so the big
                    // weight files don't look stalled.
                    if (now - st.lastLoggedMs > 2000) {
                        const mb = e.loaded / MB;
                        const rate = st.lastLoggedMs
                            ? ((e.loaded - st.lastBytes) / MB) / ((now - st.lastLoggedMs) / 1000)
                            : 0;
                        st.lastLoggedMs = now;
                        st.lastBytes = e.loaded;
                        status(`${e.file} ${mb.toFixed(0)} MB${rate ? ` (${rate.toFixed(1)} MB/s)` : ""}`);
                    }
                }
                fileState.set(e.file, st);
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
