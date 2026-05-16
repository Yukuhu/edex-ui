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

// Electron's `nodeIntegrationInWorker: true` injects a real Node
// `process` global with `process.release.name === "node"`. onnxruntime-
// web's WebGPU bundle detects that and tries to `import "worker_threads"`
// for multi-threading — which fails because the worker context can't
// resolve a Node built-in as a bare specifier. Masking the name to a
// non-"node" string makes ORT's detection branch into its browser
// implementation. The rest of the Node integration (require, fs, …)
// is untouched.
try {
    if (typeof process !== "undefined") {
        // Mask `process.release.name` so transformers.js's
        // `apis.IS_NODE_ENV` flips to false in the bits we haven't
        // already runtime-patched.
        if (process.release?.name === "node") {
            Object.defineProperty(process.release, "name", {
                value: "electron-renderer",
                configurable: true
            });
        }
        // Mask `process.type` so onnxruntime-web's WASM bootstrap
        // (ort-wasm-simd-threaded.asyncify.mjs) sees a "renderer"
        // and skips its `import("worker_threads")` branch. Under
        // nodeIntegrationInWorker, Electron defaults this to "worker".
        if (process.type && process.type !== "renderer") {
            Object.defineProperty(process, "type", {
                value: "renderer",
                configurable: true
            });
        }
    }
    self.postMessage({
        type: "boot",
        phase: "process-masked",
        releaseName: process?.release?.name,
        type: process?.type
    });
} catch (_) { /* if process isn't writable, just continue */ }

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
    // Option (c) from #84: use transformers.web.js (the bundler-target
    // build, which CAN drive WebGPU because it imports the real
    // onnxruntime-web/webgpu package) instead of transformers.min.js
    // (the standalone build, which inlines only CPU/WASM backends).
    //
    // The .web.js source has two bare-specifier imports that module
    // workers can't resolve on their own: "onnxruntime-web/webgpu" and
    // "onnxruntime-common". Fetch the source, rewrite both to absolute
    // file:// URLs against node_modules, blob-URL it, and dynamic-import
    // the blob. Effectively a poor man's import map.
    const transformersSrcUrl = new URL(
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

    self.postMessage({
        type: "boot",
        phase: "import-fetching",
        src: transformersSrcUrl.href
    });
    const srcText = await (await fetch(transformersSrcUrl)).text();
    // Three rewrites:
    // 1+2. Bare-specifier imports → absolute file:// URLs (the module
    //      worker can't resolve "onnxruntime-web/webgpu" or
    //      "onnxruntime-common" on its own).
    // 3.   Force the node-env branch of the ORT runtime-selection
    //      block to be unreachable. Under `nodeIntegrationInWorker:
    //      true`, Electron sets `process.release.name === "node"`, so
    //      transformers.js v4's `apis.IS_NODE_ENV` is true and it
    //      picks the (stubbed-empty) `onnxruntime_node_exports`
    //      branch instead of `ONNX_WEB`. Result: `ONNX.InferenceSession`
    //      is undefined and session creation throws
    //      `Cannot read properties of undefined (reading 'create')`.
    //      Rewriting just the conditional keeps every other
    //      IS_NODE_ENV check accurate and avoids touching `process`.
    const patched = srcText
        .replace(/from\s*"onnxruntime-web\/webgpu"/g, `from "${ortWebgpuUrl}"`)
        .replace(/from\s*"onnxruntime-common"/g, `from "${ortCommonUrl}"`)
        .replace(
            /\}\s*else if\s*\(apis\.IS_NODE_ENV\)\s*\{\s*ONNX = onnxruntime_node_exports;/,
            "} else if (false /* spike: forced to ONNX_WEB under nodeIntegrationInWorker */) { ONNX = onnxruntime_node_exports;"
        );
    const nodeBranchPatched = patched.length !== srcText.length || /false \/\* spike/.test(patched);
    self.postMessage({
        type: "boot",
        phase: "import-patched",
        bytes: patched.length,
        rewrites: 3,
        nodeBranchPatched
    });

    const blob = new Blob([patched], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    const m = await import(blobUrl);
    URL.revokeObjectURL(blobUrl);

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
        // ort-wasm-simd-threaded.* lives in onnxruntime-web's dist/,
        // not transformers'. (kokoro-js's web worker pointed at
        // transformers' copy because v3 stashed it there; v4 doesn't.)
        wasmDir = new URL(
            "../node_modules/onnxruntime-web/dist/",
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
