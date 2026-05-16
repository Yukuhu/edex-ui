// Spike (issue #84): scratch worker that loads Gemma 4 E4B ONNX under
// WebGPU via @huggingface/transformers v4 and streams a few tokens
// back. NOT production wiring — no graceful fallback, no resumable
// download, no progress modal. Triggered from a dev-console launcher
// (see src/_gemma_spike.js).
//
// Must be loaded as an ES module worker:
//   new Worker("workers/gemma-spike-worker.js", { type: "module" })
//
// Heavy diagnostic instrumentation: every phase posts a `boot` message
// so we can tell exactly where things die. The transformers import is
// dynamic (and try/catched) instead of a static `import` so an import
// failure surfaces a real error message instead of the silent
// no-message worker error event.

self.postMessage({ type: "boot", phase: "worker-script-started" });

// Register the message listener BEFORE the top-level `await import`.
// The renderer fires worker.postMessage({type:"load"}) immediately after
// constructing the worker; if the listener isn't yet attached when the
// message dispatches, the event is dropped silently. Queue early
// messages and drain them once boot finishes.
let pipeline, TextStreamer, env;
let bootReady = false;
const pendingMessages = [];

async function dispatch(msg) {
    self.postMessage({ type: "boot", phase: `message-received-${msg.type}` });
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
            message: err?.stack || err?.message || String(err)
        });
    }
}

self.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (!bootReady) {
        self.postMessage({ type: "boot", phase: `message-queued-${msg.type}` });
        pendingMessages.push(msg);
        return;
    }
    dispatch(msg);
});

try {
    // Use transformers.min.js (the standalone-bundled build) rather
    // than transformers.web.js (the bundler-target build). The .web.*
    // variants emit `import "onnxruntime-web/webgpu"` — a bare
    // specifier that module workers can't resolve. .min.js inlines
    // ORT directly so it just loads.
    const m = await import("../node_modules/@huggingface/transformers/dist/transformers.min.js");
    pipeline = m.pipeline;
    TextStreamer = m.TextStreamer;
    env = m.env;
    self.postMessage({
        type: "boot",
        phase: "transformers-imported",
        version: m.env?.version || "?",
        hasPipeline: typeof pipeline === "function",
        hasStreamer: typeof TextStreamer === "function"
    });
} catch (importErr) {
    self.postMessage({
        type: "error",
        phase: "import",
        message: importErr?.stack || importErr?.message || String(importErr)
    });
    throw importErr;
}

// Gemma is multi-GB — keep FS caching ON so a relaunch is fast.
// (Kokoro workers disable this; we deliberately diverge.)
try {
    // Best-effort env config — v4's transformers.min.js bundles ORT
    // inline, so wasmPaths is usually unnecessary. Only set fields
    // that actually exist; never throw on a missing nested object.
    if ("useFSCache" in env) env.useFSCache = true;
    if ("useFS" in env) env.useFS = true;
    if ("useBrowserCache" in env) env.useBrowserCache = true;
    const onnxBackend = env?.backends?.onnx;
    let wasmDir = null;
    if (onnxBackend?.wasm && typeof onnxBackend.wasm === "object") {
        wasmDir = new URL(
            "../node_modules/@huggingface/transformers/dist/",
            import.meta.url
        ).href;
        onnxBackend.wasm.wasmPaths = wasmDir;
    }
    self.postMessage({
        type: "boot",
        phase: "env-configured",
        wasmDir,
        envKeys: Object.keys(env).slice(0, 20),
        onnxKeys: onnxBackend ? Object.keys(onnxBackend) : null
    });
} catch (envErr) {
    self.postMessage({
        type: "error",
        phase: "env-config",
        message: envErr?.stack || envErr?.message || String(envErr)
    });
    throw envErr;
}

let generator = null;

bootReady = true;
self.postMessage({
    type: "boot",
    phase: "ready-for-messages",
    queued: pendingMessages.length
});

// Drain any messages that arrived during top-level await.
while (pendingMessages.length > 0) {
    dispatch(pendingMessages.shift());
}

async function handleLoad() {
    self.postMessage({ type: "boot", phase: "load-handler-entered" });
    if (generator) {
        self.postMessage({ type: "load-ready", loadMs: 0, backend: "webgpu", cached: true });
        return;
    }

    if (typeof navigator === "undefined" || !navigator.gpu) {
        throw new Error("WebGPU not available in worker context");
    }
    self.postMessage({ type: "boot", phase: "load-navigator-gpu-present" });
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("WebGPU requestAdapter() returned null");
    }
    self.postMessage({
        type: "boot",
        phase: "load-adapter-ok",
        vendor: adapter.info?.vendor,
        arch: adapter.info?.architecture
    });

    const loadStart = performance.now();
    self.postMessage({ type: "boot", phase: "load-calling-pipeline" });
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
    self.postMessage({ type: "boot", phase: "load-pipeline-returned", loadMs });

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
