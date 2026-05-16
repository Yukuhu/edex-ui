// GemmaEngine — front for src/workers/gemma-worker.js.
//
// Mirrors src/classes/ttsEngine.class.js's shape so claudeChat (and
// any future consumer) can swap a TTS-style listener block over to
// generation events without learning a new vocabulary. The worker is
// spawned lazily on the first load()/generate() call and reused for
// the rest of the session.
//
// Events (all CustomEvent; see dispatchEvent call sites for detail
// shapes):
//   progress    — { ...transformers progress event }   ← same as TtsEngine
//   loadstart   — { dtype }                            ← same as TtsEngine
//   loadready   — { dtype, backend, loadMs }           ← same as TtsEngine
//   loaderror   — { message }                          ← same as TtsEngine
//   delta       — { text }                             ← per streamed chunk
//   done        — { tokens, genMs, tokensPerSec, cancelled }
//   error       — { message }                          ← generation failures

class GemmaEngine extends EventTarget {
    static DEFAULT_DTYPE = "q4f16";

    constructor() {
        super();

        // Worker state. Gemma 4 E4B runs in a Web Worker — see
        // src/workers/gemma-worker.js. Keeping the pipeline off the
        // renderer's JS thread means model download, ONNX session
        // setup, and the token sampler don't block the UI.
        this._worker = null;
        this._loadedDtype = null;
        this._loadPromise = null;
        this._loadResolve = null;
        this._loadReject = null;
        this._generatePending = null; // { id, resolve, reject }
        this._genNextId = 1;
    }

    // WebGPU is required for the model to fit (q4f16 is ~4 GB; WASM's
    // ~4 GB address-space cap leaves no room). Consumers should hide
    // the Gemma backend in their UI when this returns false.
    get isAvailable() {
        return typeof navigator !== "undefined" && !!navigator.gpu;
    }
    get isGenerating() { return this._generatePending !== null; }
    get currentDtype() { return this._loadedDtype; }
    get currentBackend() { return this._loadedDtype ? "webgpu" : null; }

    // Pre-warm the pipeline for the given dtype (or the configured
    // dtype). Idempotent: returns the in-flight promise if a load is
    // already running, or a resolved promise if the requested dtype
    // is already loaded.
    load(dtype) {
        const d = dtype || window.settings?.gemmaDtype || GemmaEngine.DEFAULT_DTYPE;
        return this._ensureLoaded(d);
    }

    // Run one generation turn. `messages` is the Gemma chat-template
    // array: [{role: "user"|"assistant", content: "..."}].
    // Resolves with `{ tokens, genMs, tokensPerSec, cancelled }` when
    // the worker emits `generate-done`. Streams individual chunks
    // via `delta` events along the way.
    generate(messages, options = {}) {
        if (this._generatePending) {
            return Promise.reject(new Error("Generation already in progress"));
        }
        const dtype = window.settings?.gemmaDtype || GemmaEngine.DEFAULT_DTYPE;
        return this._ensureLoaded(dtype).then(() => this._generateInWorker(messages, options));
    }

    // Interrupt the in-flight generation. The worker's
    // InterruptableStoppingCriteria fires after the current token, so
    // expect one or two more `delta` events before `done` arrives
    // with `cancelled: true`. No-op when no generation is active.
    cancel() {
        if (!this._worker || !this._generatePending) return;
        this._worker.postMessage({ type: "cancel" });
    }

    // Hard shutdown — terminates the worker, rejects pending
    // promises. The next load()/generate() call will spawn a fresh
    // worker. Not used during normal modal lifecycle (the singleton
    // lives for the session); provided for explicit cleanup.
    terminate() {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
            this._loadedDtype = null;
        }
        const reject = new Error("Engine terminated");
        if (this._loadReject) {
            this._loadReject(reject);
            this._loadResolve = this._loadReject = this._loadPromise = null;
        }
        if (this._generatePending) {
            this._generatePending.reject(reject);
            this._generatePending = null;
        }
    }

    // -------------------------------------------------------------------
    // Worker management

    _ensureWorker() {
        if (this._worker) return this._worker;
        this._worker = new Worker("workers/gemma-worker.js", { type: "module" });
        this._worker.addEventListener("message", ev => this._onWorkerMessage(ev));
        this._worker.addEventListener("error", err => {
            console.warn("[Gemma Worker] error:", err.message || err);
            const e = new Error(err.message || "Worker error");
            if (this._loadReject) {
                this._loadReject(e);
                this._loadResolve = this._loadReject = this._loadPromise = null;
            }
            if (this._generatePending) {
                this._generatePending.reject(e);
                this._generatePending = null;
            }
        });
        return this._worker;
    }

    _ensureLoaded(dtype) {
        this._ensureWorker();
        if (this._loadedDtype === dtype && this._loadPromise === null) {
            return Promise.resolve();
        }
        if (this._loadPromise !== null) return this._loadPromise;

        this.dispatchEvent(new CustomEvent("loadstart", { detail: { dtype } }));
        this._loadPromise = new Promise((resolve, reject) => {
            this._loadResolve = resolve;
            this._loadReject = reject;
        });
        this._worker.postMessage({ type: "load", dtype });
        return this._loadPromise;
    }

    _generateInWorker(messages, options) {
        if (!this._worker || this._loadedDtype === null) {
            return Promise.reject(new Error("Worker not loaded"));
        }
        const id = this._genNextId++;
        return new Promise((resolve, reject) => {
            this._generatePending = { id, resolve, reject };
            this._worker.postMessage({ type: "generate", id, messages, options });
        });
    }

    _onWorkerMessage(ev) {
        const msg = ev.data || {};
        if (msg.type === "load-progress") {
            this.dispatchEvent(new CustomEvent("progress", { detail: msg.event }));
        } else if (msg.type === "load-ready") {
            const backend = msg.backend || "webgpu";
            console.info(`[Gemma] Worker load(${msg.dtype}) backend=${backend} load=${(msg.loadMs ?? 0).toFixed(0)}ms`);
            this._loadedDtype = msg.dtype;
            this.dispatchEvent(new CustomEvent("loadready", {
                detail: { dtype: msg.dtype, backend, loadMs: msg.loadMs }
            }));
            if (this._loadResolve) this._loadResolve();
            this._loadResolve = this._loadReject = this._loadPromise = null;
        } else if (msg.type === "load-error") {
            this.dispatchEvent(new CustomEvent("loaderror", { detail: { message: msg.message } }));
            if (this._loadReject) this._loadReject(new Error(msg.message));
            this._loadResolve = this._loadReject = this._loadPromise = null;
        } else if (msg.type === "token") {
            this.dispatchEvent(new CustomEvent("delta", { detail: { text: msg.text } }));
        } else if (msg.type === "generate-done") {
            const detail = {
                tokens: msg.tokens,
                genMs: msg.genMs,
                tokensPerSec: msg.tokensPerSec,
                cancelled: !!msg.cancelled
            };
            console.info(`[Gemma] gen=${(msg.genMs ?? 0).toFixed(0)}ms tokens=${msg.tokens} (${(msg.tokensPerSec ?? 0).toFixed(2)} tok/s)${msg.cancelled ? " cancelled" : ""}`);
            this.dispatchEvent(new CustomEvent("done", { detail }));
            if (this._generatePending) {
                this._generatePending.resolve(detail);
                this._generatePending = null;
            }
        } else if (msg.type === "generate-error") {
            this.dispatchEvent(new CustomEvent("error", { detail: { message: msg.message } }));
            if (this._generatePending) {
                this._generatePending.reject(new Error(msg.message));
                this._generatePending = null;
            }
        }
    }
}
