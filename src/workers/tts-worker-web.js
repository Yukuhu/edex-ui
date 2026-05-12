// Variant 2 (issue #24): WebGPU-backed Kokoro synthesis.
//
// Loads the **web** variant of kokoro-js + transformers.js (uses
// onnxruntime-web) so we can target the WebGPU execution provider on
// Apple Silicon (and any other platform with a working WebGPU
// adapter). Same message protocol as tts-worker.js so the renderer
// can swap workers transparently.
//
// Must be loaded as an ES module worker:
//   new Worker("workers/tts-worker-web.js", { type: "module" })
//
// If WebGPU is unavailable, the load message returns a load-error and
// the renderer falls back to the node-CPU worker.

import { KokoroTTS, env } from "../node_modules/kokoro-js/dist/kokoro.web.js";

// Don't touch FS or browser caches — same rationale as the node
// worker. transformers.js's caching path on web is OPFS, which works,
// but to keep parity with the node worker we leave it off.
env.useFSCache = false;
env.useBrowserCache = false;

// Point transformers.js at the local copies of ort-wasm-simd-threaded
// (the WebGPU/JSEP runtime) — the default is a CDN URL that the
// renderer's CSP doesn't allow, and we'd rather not loosen CSP for
// it. The .mjs and .wasm files live next to transformers.js in
// node_modules. `import.meta.url` is the worker file's file:// URL,
// so the relative path resolves correctly when packaged or in dev.
try {
    const wasmDir = new URL("../node_modules/@huggingface/transformers/dist/", import.meta.url).href;
    env.backends.onnx.wasm.wasmPaths = wasmDir;
} catch (_) {
    // Fall back to defaults if URL resolution somehow fails.
}

let kokoro = null;
let loadedDtype = null;

self.addEventListener("message", async (event) => {
    if (event.origin && event.origin !== self.location.origin) return; // S2819
    const msg = event.data || {};
    try {
        if (msg.type === "load") {
            await handleLoad(msg.dtype);
        } else if (msg.type === "synthesize") {
            await handleSynth(msg.id, msg.text, msg.voice);
        } else if (msg.type === "cancel") {
            // No-op; in-flight session.run isn't cancellable.
        }
    } catch (err) {
        self.postMessage({
            type: msg.type === "synthesize" ? "synth-error" : "load-error",
            id: msg.id,
            message: (err && err.message) ? err.message : String(err)
        });
    }
});

async function handleLoad(dtype) {
    if (kokoro && loadedDtype === dtype) {
        self.postMessage({ type: "load-ready", dtype, loadMs: 0, warmMs: 0 });
        return;
    }
    if (kokoro && loadedDtype !== dtype) {
        kokoro = null;
        loadedDtype = null;
    }

    // Quick WebGPU adapter check — if the renderer didn't get one,
    // bail early with a clear error so the caller can fall back.
    if (typeof navigator === "undefined" || !navigator.gpu) {
        throw new Error("WebGPU not available in worker context");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("WebGPU requestAdapter() returned null");
    }

    const loadStart = performance.now();
    kokoro = await KokoroTTS.from_pretrained(
        "onnx-community/Kokoro-82M-v1.0-ONNX",
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

    // ONNX session warmup — first run on a fresh session is 2-4× slower
    // than steady state. A representative-length warmup utterance gets
    // the kernels hot before the user's first real sentence.
    const warmStart = performance.now();
    try {
        await kokoro.generate("Ready to talk with you now.", { voice: "af_heart" });
    } catch (_) {}
    const warmMs = performance.now() - warmStart;

    self.postMessage({ type: "load-ready", dtype, loadMs, warmMs, backend: "webgpu" });
}

async function handleSynth(id, text, voice) {
    if (!kokoro) {
        self.postMessage({ type: "synth-error", id, message: "Pipeline not loaded" });
        return;
    }
    const synthStart = performance.now();
    const rawAudio = await kokoro.generate(text, { voice });
    const synthMs = performance.now() - synthStart;
    const samples = rawAudio.audio || rawAudio.data;
    const sampleRate = rawAudio.sampling_rate || 24000;
    const wav = buildWav(samples, sampleRate);
    self.postMessage(
        { type: "synth-result", id, wav, sampleRate, synthMs, chars: text.length },
        [wav]
    );
}

// Float32 [-1,1] PCM samples → 16-bit mono WAV ArrayBuffer.
// Duplicated from tts-worker.js so each worker file is self-contained.
function buildWav(samples, sampleRate) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + numSamples * 2, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}
