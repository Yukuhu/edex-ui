// Spike (issue #84): scratch worker that loads Gemma 4 E4B ONNX under
// WebGPU via @huggingface/transformers v4 and streams a few tokens
// back. NOT production wiring — no graceful fallback, no resumable
// download, no progress modal. Triggered from a dev-console launcher
// (see src/_gemma_spike.js) to answer:
//
//   1. Does `onnx-community/gemma-4-E4B-it-ONNX` (q4f16) actually load
//      and stream under WebGPU inside Electron 42's renderer?
//   2. Does `@huggingface/transformers` v4 work in a module worker
//      alongside the kokoro-js@1.2.1 nested v3 install?
//
// Must be loaded as an ES module worker:
//   new Worker("workers/gemma-spike-worker.js", { type: "module" })
//
// Message protocol (one-shot, throwaway):
//   in:  { type: "load" }
//        { type: "generate", prompt: "..." }
//   out: { type: "load-progress", event }
//        { type: "load-ready", loadMs, backend }
//        { type: "token", text }            // streamed chunk
//        { type: "generate-done", genMs, tokens, tokensPerSec }
//        { type: "error", phase, message }

import {
    pipeline,
    TextStreamer,
    env
} from "../node_modules/@huggingface/transformers/dist/transformers.web.js";

// Gemma is multi-GB — keep FS caching ON so a relaunch is fast.
// (Kokoro workers disable this; we deliberately diverge.)
env.useFSCache = true;
env.useBrowserCache = true;

// Point ORT at the local copy of ort-wasm-simd-threaded — same CSP
// rationale as tts-worker-web.js.
try {
    const wasmDir = new URL(
        "../node_modules/@huggingface/transformers/dist/",
        import.meta.url
    ).href;
    env.backends.onnx.wasm.wasmPaths = wasmDir;
} catch (_) { /* fall back to defaults */ }

let generator = null;

self.addEventListener("message", async (event) => {
    if (event.origin && event.origin !== self.location.origin) return; // S2819
    const msg = event.data || {};
    try {
        if (msg.type === "load") {
            await handleLoad();
        } else if (msg.type === "generate") {
            await handleGenerate(msg.prompt);
        }
    } catch (err) {
        self.postMessage({
            type: "error",
            phase: msg.type,
            message: err?.message ? err.message : String(err)
        });
    }
});

async function handleLoad() {
    if (generator) {
        self.postMessage({ type: "load-ready", loadMs: 0, backend: "webgpu", cached: true });
        return;
    }

    if (typeof navigator === "undefined" || !navigator.gpu) {
        throw new Error("WebGPU not available in worker context");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("WebGPU requestAdapter() returned null");
    }

    const loadStart = performance.now();
    generator = await pipeline(
        "text-generation",
        "onnx-community/gemma-4-E4B-it-ONNX",
        {
            dtype: "q4f16",
            device: "webgpu",
            progress_callback: (e) => {
                self.postMessage({ type: "load-progress", event: e });
            }
        }
    );
    const loadMs = performance.now() - loadStart;

    self.postMessage({ type: "load-ready", loadMs, backend: "webgpu", cached: false });
}

async function handleGenerate(prompt) {
    if (!generator) {
        throw new Error("Pipeline not loaded — send { type: 'load' } first");
    }

    let tokenCount = 0;
    const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        callback_function: (text) => {
            tokenCount += 1;
            self.postMessage({ type: "token", text });
        }
    });

    const messages = [
        { role: "user", content: prompt }
    ];

    const genStart = performance.now();
    await generator(messages, {
        max_new_tokens: 128,
        do_sample: false,
        streamer
    });
    const genMs = performance.now() - genStart;
    const tokensPerSec = tokenCount > 0 ? (tokenCount / (genMs / 1000)) : 0;

    self.postMessage({
        type: "generate-done",
        genMs,
        tokens: tokenCount,
        tokensPerSec
    });
}
