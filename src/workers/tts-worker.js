// Off-main-thread Kokoro TTS synthesis.
//
// Owns the kokoro-js pipeline so the renderer's JS thread isn't blocked
// by phonemize (WASM, sync), tensor manipulation, or RawAudio→WAV
// conversion. The renderer sends sentences in; the worker sends back
// raw Float32 PCM samples that the renderer wraps as a WAV blob and
// plays via an Audio element.
//
// Requires `nodeIntegrationInWorker: true` in BrowserWindow.webPreferences
// (set in _boot.js) so `require("kokoro-js")` works in the worker
// context. Without that, the worker can't see Node's CJS resolver.
//
// Message protocol (main → worker):
//   { type: "load", dtype }
//   { type: "synthesize", id, text, voice }
//   { type: "cancel" }                              // best-effort, see below
//
// Message protocol (worker → main):
//   { type: "load-progress", event }                // raw kokoro progress
//   { type: "load-ready", dtype, loadMs, warmMs }
//   { type: "load-error", message }
//   { type: "synth-result", id, samples, sampleRate, durationSec }
//   { type: "synth-error", id, message }

const { KokoroTTS } = require("kokoro-js");

// Disable transformers' FileSystem and Browser caches in the worker for
// the same reason the renderer does — see the comment in
// classes/claudeChat.class.js near `useFSCache = false` for the
// FileResponse/match issue.
try {
    const transformers = require("@huggingface/transformers");
    transformers.env.useFSCache = false;
    transformers.env.useBrowserCache = false;
} catch (envErr) {
    // Best-effort; falls through to defaults if the package layout shifts.
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
            // Best-effort: in-flight `generate()` calls run to completion
            // because ONNX session.run isn't cancellable from outside.
            // The main thread should drop the resulting audio if it's
            // no longer wanted.
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
    // Already loaded with same dtype? Re-warm just to make sure the
    // session is hot and tell the renderer it's ready.
    if (kokoro && loadedDtype === dtype) {
        self.postMessage({ type: "load-ready", dtype, loadMs: 0, warmMs: 0 });
        return;
    }
    // Dtype changed — drop the cached session so from_pretrained reloads.
    if (kokoro && loadedDtype !== dtype) {
        kokoro = null;
        loadedDtype = null;
    }

    // Variant 2: ask onnxruntime-node to try the CoreML EP first on
    // macOS (and CUDA on platforms that have it), falling back to CPU.
    // transformers.js's session_options is passed through to ORT.
    // If an EP isn't available, ORT silently falls back to the next one
    // in the list. Only meaningful EPs that ship with the standard
    // onnxruntime-node 1.21 build are listed here.
    const platform = typeof process !== "undefined" ? process.platform : "";
    const executionProviders = [];
    if (platform === "darwin") executionProviders.push("coreml");
    executionProviders.push("cpu");

    const loadStart = performance.now();
    kokoro = await KokoroTTS.from_pretrained(
        "onnx-community/Kokoro-82M-v1.0-ONNX",
        {
            dtype,
            session_options: { executionProviders },
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
    } catch (_) {
        // non-fatal
    }
    const warmMs = performance.now() - warmStart;

    self.postMessage({ type: "load-ready", dtype, loadMs, warmMs });
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
    // Build the WAV bytes in the worker too — the float→int16 conversion
    // is otherwise a 50-200ms sync block on the main thread per sentence.
    const wav = buildWav(samples, sampleRate);
    self.postMessage(
        { type: "synth-result", id, wav, sampleRate, synthMs, chars: text.length },
        [wav]
    );
}

// Float32 [-1,1] PCM samples → 16-bit mono WAV ArrayBuffer.
function buildWav(samples, sampleRate) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    // RIFF chunk
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + numSamples * 2, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    // fmt sub-chunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    // data sub-chunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, numSamples * 2, true);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}
