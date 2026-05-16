// Gemma 4 E4B ONNX text-generation worker, modeled on
// src/workers/tts-worker-web.js. Owns the transformers.js pipeline
// off the renderer's JS thread and streams tokens back to the caller
// over postMessage.
//
// Must be loaded as a module worker:
//   new Worker("workers/gemma-worker.js", { type: "module" })
//
// Three runtime adaptations are needed for transformers.js v4 +
// onnxruntime-web to drive WebGPU under Electron's
// `nodeIntegrationInWorker: true`. They were validated by the spike
// for issue #84; the worker is otherwise standard.
//
// Message protocol (mirrors tts-worker-web.js shape):
//   in:  { type: "load", dtype }
//        { type: "generate", id, messages, options? }
//        { type: "cancel" }
//   out: { type: "load-progress", event }
//        { type: "load-ready", loadMs, dtype, backend }
//        { type: "load-error", message }
//        { type: "token", id, text }            // one per streamed chunk
//        { type: "generate-done", id, tokens, genMs, tokensPerSec, cancelled }
//        { type: "generate-error", id, message }

// ── Environment masking ─────────────────────────────────────────────
// Electron's `nodeIntegrationInWorker: true` exposes a real Node
// `process` to the worker. transformers.js v4 and onnxruntime-web both
// branch on it and pick Node-only code paths that don't exist in the
// web build:
//   - transformers' `apis.IS_NODE_ENV` checks `process.release.name`.
//   - ORT's `ort-wasm-simd-threaded.asyncify.mjs` gates its
//     `import("worker_threads")` on `process.type !== "renderer"`.
// Mask both so each library falls through to its browser path. The
// rest of the Node integration (require, fs, …) is untouched.
try {
    if (typeof process !== "undefined") {
        if (process.release?.name === "node") {
            Object.defineProperty(process.release, "name", {
                value: "electron-renderer",
                configurable: true
            });
        }
        if (process.type && process.type !== "renderer") {
            Object.defineProperty(process, "type", {
                value: "renderer",
                configurable: true
            });
        }
    }
} catch (_) { /* not writable in some contexts — ignore */ }

// ── Message listener registered first ───────────────────────────────
// Top-level `await` is used below to load transformers. Module-worker
// semantics deliver messages dispatched during that await without
// queueing them — they're dropped if no listener is attached at
// dispatch time. Attach now and buffer until boot completes.
let pipeline, TextStreamer, InterruptableStoppingCriteria, env;
let generator = null;
let loadedDtype = null;
let bootReady = false;
const pendingMessages = [];
let inflightStopper = null;
// Serialize load → generate so they can't interleave when the
// renderer fires both immediately. `cancel` deliberately bypasses
// the chain — if it queued, it'd wait for the very generate it was
// meant to stop, and by then `inflightStopper` would be null.
let dispatchChain = Promise.resolve();
function enqueueDispatch(msg) {
    dispatchChain = dispatchChain.then(() => dispatch(msg));
    return dispatchChain;
}

async function dispatch(msg) {
    try {
        if (msg.type === "load") {
            await handleLoad(msg);
        } else if (msg.type === "generate") {
            await handleGenerate(msg);
        }
    } catch (err) {
        const errType = msg.type === "generate" ? "generate-error" : "load-error";
        self.postMessage({
            type: errType,
            id: msg.id,
            message: err?.message ? err.message : String(err)
        });
    }
}

self.addEventListener("message", (event) => {
    if (event.origin && event.origin !== self.location.origin) return; // S2819
    const msg = event.data || {};
    if (msg.type === "cancel") {
        // Synchronous, queue-bypassing. Safe at any boot stage:
        // before boot or between generates `inflightStopper` is null.
        if (inflightStopper) inflightStopper.interrupt();
        return;
    }
    if (!bootReady) {
        pendingMessages.push(msg);
        return;
    }
    enqueueDispatch(msg);
});

// ── Load transformers.js with runtime patches ───────────────────────
try {
    const m = await loadTransformersWithPatches();
    pipeline = m.pipeline;
    TextStreamer = m.TextStreamer;
    InterruptableStoppingCriteria = m.InterruptableStoppingCriteria;
    env = m.env;
    // Gemma model is multi-GB; FS cache makes subsequent runs fast.
    // (TTS workers turn this off because Kokoro is small; here we
    // explicitly keep it on — see issue #89 for resumable downloads.)
    env.useFSCache = true;
    env.useBrowserCache = true;
} catch (importErr) {
    self.postMessage({
        type: "load-error",
        message: importErr?.message ? importErr.message : String(importErr)
    });
    throw importErr;
}

bootReady = true;
while (pendingMessages.length > 0) enqueueDispatch(pendingMessages.shift());

// ── Implementation ──────────────────────────────────────────────────

// Fetches transformers.web.js as text, rewrites three things, then
// dynamic-imports the result via a blob URL. This is the minimum patch
// set that makes the WebGPU pipeline reachable under nodeIntegration-
// InWorker without a bundler.
async function loadTransformersWithPatches() {
    const srcUrl = new URL(
        "../node_modules/@huggingface/transformers/dist/transformers.web.js",
        import.meta.url
    );
    const ortWebgpuUrl = new URL(
        "../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs",
        import.meta.url
    ).href;
    const ortCommonUrl = new URL(
        "../node_modules/onnxruntime-common/dist/esm/index.js",
        import.meta.url
    ).href;

    const srcText = await (await fetch(srcUrl)).text();
    const patched = srcText
        // 1. Module workers can't resolve bare specifiers; redirect to
        //    absolute file:// URLs against node_modules. (No import-map
        //    support across workers in current Chromium.)
        .replace(/from\s*"onnxruntime-web\/webgpu"/g, `from "${ortWebgpuUrl}"`)
        .replace(/from\s*"onnxruntime-common"/g, `from "${ortCommonUrl}"`)
        // 2. Force transformers' Node-runtime branch unreachable so it
        //    picks ONNX_WEB. Without this, the stubbed-empty
        //    onnxruntime_node_exports leaves InferenceSession undefined.
        .replace(
            /\}\s*else if\s*\(apis\.IS_NODE_ENV\)\s*\{\s*ONNX = onnxruntime_node_exports;/,
            "} else if (false /* gemma-worker: force ONNX_WEB under nodeIntegrationInWorker */) { ONNX = onnxruntime_node_exports;"
        );

    const blob = new Blob([patched], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
        return await import(blobUrl);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

async function handleLoad(msg) {
    const dtype = msg.dtype || "q4f16";
    if (generator && loadedDtype === dtype) {
        self.postMessage({ type: "load-ready", loadMs: 0, dtype, backend: "webgpu", cached: true });
        return;
    }
    if (generator && loadedDtype !== dtype) {
        generator = null;
        loadedDtype = null;
    }

    if (typeof navigator === "undefined" || !navigator.gpu) {
        throw new Error("WebGPU not available in worker context");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("WebGPU requestAdapter() returned null");
    }

    // Pin the FS cache to a stable directory under the app's userData
    // path (passed in by GemmaEngine). Without this, transformers.js
    // falls back to its in-process default (relative to CWD, OS-
    // dependent), which can land in transient locations under Electron
    // and silently re-download on the next launch. The same setting
    // lets HF Hub's resumable-download machinery find a partially-
    // downloaded shard and continue from the existing bytes.
    if (msg.cacheDir) env.cacheDir = msg.cacheDir;

    const loadStart = performance.now();
    generator = await pipeline(
        "text-generation",
        "onnx-community/gemma-4-E4B-it-ONNX",
        {
            dtype,
            device: "webgpu",
            progress_callback: (e) => {
                self.postMessage({ type: "load-progress", event: e });
            }
        }
    );
    loadedDtype = dtype;
    const loadMs = performance.now() - loadStart;
    self.postMessage({ type: "load-ready", loadMs, dtype, backend: "webgpu", cached: false });
}

async function handleGenerate(msg) {
    if (!generator) {
        throw new Error("Pipeline not loaded — send { type: 'load' } first");
    }
    if (inflightStopper) {
        // Single-in-flight contract: callers (#86's GemmaEngine) hold
        // one worker per chat session and serialize their own turns.
        // Rejecting a second generate keeps `cancel` unambiguous.
        throw new Error("Generation already in progress");
    }
    const { id, messages, options = {} } = msg;

    let tokenCount = 0;
    const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        callback_function: (text) => {
            tokenCount += 1;
            self.postMessage({ type: "token", id, text });
        }
    });

    const stopper = new InterruptableStoppingCriteria();
    inflightStopper = stopper;

    const genStart = performance.now();
    try {
        await generator(messages, {
            max_new_tokens: options.max_new_tokens ?? 512,
            do_sample: options.do_sample ?? false,
            temperature: options.temperature,
            top_p: options.top_p,
            streamer,
            stopping_criteria: stopper
        });
    } finally {
        if (inflightStopper === stopper) inflightStopper = null;
    }

    const genMs = performance.now() - genStart;
    const tokensPerSec = tokenCount > 0 ? (tokenCount / (genMs / 1000)) : 0;
    self.postMessage({
        type: "generate-done",
        id,
        tokens: tokenCount,
        genMs,
        tokensPerSec,
        cancelled: stopper.interrupted === true
    });
}
