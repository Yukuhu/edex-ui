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
//   progress           — { ...transformers progress event }   ← same as TtsEngine
//   loadstart          — { dtype }                            ← same as TtsEngine
//   loadready          — { dtype, backend, loadMs }           ← same as TtsEngine
//   loaderror          — { message }                          ← same as TtsEngine
//   delta              — { text }                             ← per streamed chunk
//   done               — { tokens, genMs, tokensPerSec, cancelled }
//   error              — { message }                          ← generation failures
//   availabilitychange — { state, reason? }                   ← fires once when the
//                                                               WebGPU adapter probe
//                                                               resolves

class GemmaEngine extends EventTarget {
    static DEFAULT_DTYPE = "q4f16";

    // Minimum free disk space required before kicking off a cold model
    // download, by dtype. Numbers are the documented per-tier weights
    // plus a ~1 GB cushion for in-flight `.incomplete` files and ORT
    // session scratch. A short fall-through default protects future
    // tiers added without an explicit entry.
    static MIN_FREE_BYTES_BY_DTYPE = {
        "q4f16": 5 * 1024 * 1024 * 1024,  // ~3.6 GB on disk + cushion
        "q8":    9 * 1024 * 1024 * 1024   // ~6.8 GB on disk + cushion
    };
    static MIN_FREE_BYTES_DEFAULT = 5 * 1024 * 1024 * 1024;

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
        // When a generation is in flight: holds the pending id plus its resolve/reject. null otherwise.
        this._generatePending = null;
        this._genNextId = 1;
        // Resolved on first use and memoised. Lives under the app's
        // userData path so the cache survives across launches and is
        // visible to the user (and `rm -rf`-able if they want to wipe
        // the multi-GB model files manually).
        this._cacheDir = null;

        // WebGPU availability probe — `navigator.gpu` only tells us the
        // API surface is present; `requestAdapter()` is what reveals
        // whether a real adapter is reachable (driver enabled, GPU
        // visible to the renderer, ANGLE/Vulkan path negotiated). We
        // run it once at construction, cache the result, and fire
        // `availabilitychange` so consumers can refresh their UI.
        // States:
        //   "unknown"     — probe hasn't completed yet
        //   "available"   — a GPUAdapter was returned
        //   "unavailable" — no API, no adapter, or the probe threw
        this.availability = { state: "unknown" };
        // Hold on to the probe promise so _ensureLoaded can await it
        // before booting the worker. Without that, a fast caller can
        // win the race against the async `requestAdapter()` call and
        // spawn the worker on a machine that's about to be marked
        // unavailable.
        this._availabilityProbe = this._probeAvailability();
    }

    async _probeAvailability() {
        let next;
        if (typeof navigator === "undefined" || !navigator.gpu) {
            next = {
                state: "unavailable",
                reason: "WebGPU is not exposed in this runtime — the local Gemma backend needs `navigator.gpu`."
            };
        } else {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    next = {
                        state: "unavailable",
                        reason: "No WebGPU adapter is available on this machine (no compatible GPU, drivers missing, or WebGPU disabled by policy)."
                    };
                } else {
                    next = { state: "available" };
                }
            } catch (err) {
                next = {
                    state: "unavailable",
                    reason: `WebGPU adapter probe failed: ${err?.message || String(err)}`
                };
            }
        }
        this.availability = next;
        this.dispatchEvent(new CustomEvent("availabilitychange", { detail: next }));
    }

    // Path under userData where transformers.js stores Gemma model
    // shards. Stable across launches so HF Hub's resumable downloads
    // can pick up a partial shard. Lazy because @electron/remote
    // round-trips into main, and the engine is constructed before
    // anyone needs the directory.
    _resolveCacheDir() {
        if (this._cacheDir) return this._cacheDir;
        try {
            const path = require("node:path");
            const userData = require("@electron/remote").app.getPath("userData");
            this._cacheDir = path.join(userData, "gemma-cache");
            try {
                require("node:fs").mkdirSync(this._cacheDir, { recursive: true });
            } catch (_) { /* exists or unwritable — let the worker surface the real error */ }
        } catch (err) {
            console.warn("[Gemma] couldn't resolve cache dir, falling back to transformers.js default:", err);
            this._cacheDir = null;
        }
        return this._cacheDir;
    }

    // Throws a user-readable error if the cache drive doesn't have
    // enough headroom for the requested dtype's weights. Skipped when
    // we couldn't resolve a cache dir (the fallback path is whatever
    // transformers.js picks; let it surface its own errors there).
    _assertDiskSpace(dtype) {
        const cacheDir = this._resolveCacheDir();
        if (!cacheDir) return;
        let free;
        try {
            const { bsize, bavail } = require("node:fs").statfsSync(cacheDir);
            free = bsize * bavail;
        } catch (err) {
            // statfsSync is Node 19+; Electron 42 ships Node 22+. If
            // it somehow fails we treat the check as inconclusive
            // rather than blocking the user.
            console.warn("[Gemma] disk-space pre-check skipped:", err);
            return;
        }
        const needed = GemmaEngine.MIN_FREE_BYTES_BY_DTYPE[dtype]
            ?? GemmaEngine.MIN_FREE_BYTES_DEFAULT;
        if (free < needed) {
            const gb = (n) => (n / (1024 ** 3)).toFixed(1);
            throw new Error(
                `Not enough disk space for Gemma ${dtype}: need ~${gb(needed)} GB free `
                + `at ${cacheDir}, have ${gb(free)} GB.`
            );
        }
    }

    // WebGPU is required for the model to fit (q4f16 is ~4 GB; WASM's
    // ~4 GB address-space cap leaves no room). Consumers should hide
    // the Gemma backend in their UI when this returns false.
    //
    // Two layers of detection:
    //   - the async probe in `_probeAvailability` is authoritative once
    //     it has resolved (calls `requestAdapter()` and remembers the
    //     answer in `this.availability`);
    //   - until then we fall back to the sync `navigator.gpu` API
    //     surface check so the very first read (which happens before
    //     the probe's microtask runs) doesn't spuriously report
    //     unavailable on supported machines.
    get isAvailable() {
        if (this.availability?.state === "available") return true;
        if (this.availability?.state === "unavailable") return false;
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
        // Mark the engine busy synchronously, before awaiting the load.
        // Without this, a second generate() that lands while load is
        // still pending also passes the guard, and both calls clobber
        // each other's `_generatePending` entry when the load resolves.
        const pending = { id: null, resolve: null, reject: null };
        this._generatePending = pending;

        const dtype = window.settings?.gemmaDtype || GemmaEngine.DEFAULT_DTYPE;
        return new Promise((resolve, reject) => {
            pending.resolve = resolve;
            pending.reject = reject;
            this._ensureLoaded(dtype).then(() => {
                if (this._generatePending !== pending) {
                    // Engine was terminated or the slot was cleared
                    // (e.g. by a worker-error event) while we were
                    // loading.
                    reject(new Error("Generation aborted before start"));
                    return;
                }
                if (!this._worker || this._loadedDtype === null) {
                    this._generatePending = null;
                    reject(new Error("Worker not loaded"));
                    return;
                }
                pending.id = this._genNextId++;
                this._worker.postMessage({
                    type: "generate",
                    id: pending.id,
                    messages,
                    options
                });
            }).catch(err => {
                if (this._generatePending === pending) this._generatePending = null;
                reject(err);
            });
        });
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
            // Drop the dead worker so the next load()/generate() spawns
            // a fresh one rather than poking a corpse.
            try { this._worker?.terminate(); } catch (_) { /* ok */ }
            this._worker = null;
            this._loadedDtype = null;
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
        // Hold off until the WebGPU probe has resolved — between
        // construction and the microtask flip there's a window where
        // `state` is still "unknown" but the machine has no adapter.
        // Re-enter once the probe lands so the unavailable branch
        // below catches it.
        // Nullish check, not a Promise-truthiness check — the probe is
        // always either null or a Promise reference; we want "is the
        // probe in flight?", not "did the probe resolve to a truthy
        // value?". `!= null` keeps Sonar's S6544 happy and reads
        // explicitly.
        if (this.availability?.state === "unknown" && this._availabilityProbe != null) {
            return this._availabilityProbe.then(() => this._ensureLoaded(dtype));
        }
        if (this._loadedDtype === dtype && this._loadPromise === null) {
            return Promise.resolve();
        }
        if (this._loadPromise !== null) return this._loadPromise;

        // Refuse to spin up the worker if the WebGPU probe came back
        // unavailable — the in-worker `requestAdapter()` call would
        // throw anyway, but doing it here keeps the error message
        // user-facing (probe reason) rather than the generic worker
        // error and avoids the boot-time transformers.js download.
        if (this.availability?.state === "unavailable") {
            const message = this.availability.reason || "WebGPU is not available on this machine.";
            this.dispatchEvent(new CustomEvent("loaderror", { detail: { message } }));
            return Promise.reject(new Error(message));
        }

        // Cheap up-front sanity check: bail before we spawn a worker
        // and start fetching multi-GB shards if the cache drive can't
        // even hold them. Errors here fire `loaderror` (matching the
        // worker-side load-error event shape) and reject _loadPromise
        // so the chat modal surfaces them through its existing handler.
        const cacheDir = this._resolveCacheDir();
        try {
            this._assertDiskSpace(dtype);
        } catch (err) {
            this.dispatchEvent(new CustomEvent("loaderror", {
                detail: { message: err.message }
            }));
            return Promise.reject(err);
        }

        this._ensureWorker();
        this.dispatchEvent(new CustomEvent("loadstart", { detail: { dtype } }));
        this._loadPromise = new Promise((resolve, reject) => {
            this._loadResolve = resolve;
            this._loadReject = reject;
        });
        this._worker.postMessage({ type: "load", dtype, cacheDir });
        return this._loadPromise;
    }

    _onWorkerMessage(ev) {
        const msg = ev.data || {};
        switch (msg.type) {
            case "load-progress": return this._onLoadProgress(msg);
            case "load-ready":    return this._onLoadReady(msg);
            case "load-error":    return this._onLoadError(msg);
            case "token":         return this._onToken(msg);
            case "generate-done": return this._onGenerateDone(msg);
            case "generate-error":return this._onGenerateError(msg);
        }
    }

    _onLoadProgress(msg) {
        this.dispatchEvent(new CustomEvent("progress", { detail: msg.event }));
    }

    _onLoadReady(msg) {
        const backend = msg.backend || "webgpu";
        console.info(`[Gemma] Worker load(${msg.dtype}) backend=${backend} load=${(msg.loadMs ?? 0).toFixed(0)}ms`);
        this._loadedDtype = msg.dtype;
        this.dispatchEvent(new CustomEvent("loadready", {
            detail: { dtype: msg.dtype, backend, loadMs: msg.loadMs }
        }));
        if (this._loadResolve) this._loadResolve();
        this._loadResolve = this._loadReject = this._loadPromise = null;
    }

    _onLoadError(msg) {
        this.dispatchEvent(new CustomEvent("loaderror", { detail: { message: msg.message } }));
        if (this._loadReject) this._loadReject(new Error(msg.message));
        this._loadResolve = this._loadReject = this._loadPromise = null;
    }

    _onToken(msg) {
        this.dispatchEvent(new CustomEvent("delta", { detail: { text: msg.text } }));
    }

    _onGenerateDone(msg) {
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
    }

    _onGenerateError(msg) {
        this.dispatchEvent(new CustomEvent("error", { detail: { message: msg.message } }));
        if (this._generatePending) {
            this._generatePending.reject(new Error(msg.message));
            this._generatePending = null;
        }
    }
}
