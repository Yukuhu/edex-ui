// TtsEngine — shared text-to-speech pipeline. Singleton on
// window.ttsEngine. Owns the Kokoro/ONNX worker, sentence splitter,
// per-sentence synthesis queue, sequential audio playback, and the
// speechSynthesis fallback.
//
// Two shapes of use:
//   one-shot  → engine.speak("the full text")
//   streaming → engine.beginStream();
//               engine.pushTail("delta one ");
//               engine.pushTail("delta two…");
//               engine.finishStream();
//
// cancel() bumps an active turn key so in-flight synth/load promises
// bail at their next check.
//
// Events: speakstart / speakend / error / loadstart / loadready /
// loaderror / progress / firstaudio / firstsynth / firstyield /
// synthsample (each fired with the obvious detail payload; see the
// dispatchEvent call sites for shape).

// Eagerly emits sentences as soon as a terminator is seen, even at the
// end of the current buffer. Replaces kokoro-js's TextSplitterStream
// which only yields a sentence after seeing non-whitespace text past
// the terminator — that look-ahead made every sentence land one
// chunk-delay behind, and the final sentence wait for close(). For
// streaming TTS over a live LLM response, eager yield is the win;
// the rare "Mr. Smith" / "..." misclassification is mitigated by an
// abbreviation skip-list (see TtsEngine.ABBREVIATIONS).
class EagerSentenceSplitter {
    _buf = "";
    _queue = [];
    _closed = false;
    _resolve = null;
    _firstYielded = false;
    _earlyYieldMinChars = 25;
    _earlyYieldMaxChars = 80;

    constructor(abbreviations) {
        this._abbreviations = abbreviations || new Set();
    }
    push(text) {
        if (!text) return;
        this._buf += text;
        this._scan();
    }
    close() {
        if (this._closed) return;
        this._closed = true;
        const tail = this._buf.trim();
        if (tail.length > 0) this._queue.push(tail);
        this._buf = "";
        this._wake();
    }
    _scan() {
        const lastEnd = this._consumeTerminators();
        if (lastEnd > 0) this._buf = this._buf.slice(lastEnd);
        this._tryEarlyYield();
        if (this._queue.length > 0) this._wake();
    }

    _consumeTerminators() {
        const re = /[.!?…。？！]+["')\]}」』]*(?=\s|$)|\n+/g;
        let lastEnd = 0;
        let m;
        while ((m = re.exec(this._buf)) !== null) {
            if (this._isAbbreviationFalseAlarm(m, lastEnd)) continue;
            const cut = m.index + m[0].length;
            this._pushTrimmed(this._buf.slice(lastEnd, cut));
            lastEnd = this._skipWhitespaceFrom(cut);
            re.lastIndex = lastEnd;
        }
        return lastEnd;
    }

    _isAbbreviationFalseAlarm(match, lastEnd) {
        if (match[0].startsWith("\n")) return false;
        const beforeMatch = /(\w+)$/.exec(this._buf.slice(lastEnd, match.index));
        const word = beforeMatch ? beforeMatch[1].toLowerCase() : "";
        return this._abbreviations.has(word);
    }

    _pushTrimmed(text) {
        const trimmed = text.trim();
        if (trimmed.length === 0) return;
        this._queue.push(trimmed);
        this._firstYielded = true;
    }

    _skipWhitespaceFrom(start) {
        let i = start;
        while (i < this._buf.length && /\s/.test(this._buf[i])) i++;
        return i;
    }

    // First-chunk early-yield. If nothing has been yielded yet and the
    // buffer has grown past _earlyYieldMinChars, split on the nearest
    // soft boundary (comma / semicolon / em-dash); past
    // _earlyYieldMaxChars, force-split on the last space within the
    // cap. Bounds first-audio latency without splitting "Hi," off as a
    // standalone chunk.
    _tryEarlyYield() {
        if (this._firstYielded || this._buf.length < this._earlyYieldMinChars) return;
        const softCut = this._findEarlySoftCut();
        if (softCut <= 0) return;
        const chunk = this._buf.slice(0, softCut).trim();
        if (chunk.length === 0) return;
        this._queue.push(chunk);
        this._firstYielded = true;
        this._buf = this._buf.slice(this._skipWhitespaceFrom(softCut));
    }

    _findEarlySoftCut() {
        const sm = /[,;:][\s)\]}」』]|—|–/.exec(this._buf);
        if (sm !== null) return sm.index + 1;
        if (this._buf.length < this._earlyYieldMaxChars) return -1;
        const tail = this._buf.slice(0, this._earlyYieldMaxChars);
        const lastSpace = tail.lastIndexOf(" ");
        return lastSpace > this._earlyYieldMinChars ? lastSpace : -1;
    }
    _wake() {
        if (this._resolve) {
            const r = this._resolve;
            this._resolve = null;
            r();
        }
    }
    async *[Symbol.asyncIterator]() {
        while (true) {
            if (this._queue.length > 0) {
                yield this._queue.shift();
                continue;
            }
            if (this._closed) return;
            await new Promise(r => { this._resolve = r; });
        }
    }
}

class TtsEngine extends EventTarget {
    static DEFAULT_DTYPE = "q8";
    static DEFAULT_VOICE = "af_heart";

    // Common English abbreviations that look like sentence endings but
    // aren't. Subset of kokoro-js's own list, used by EagerSplitter to
    // avoid yielding mid-sentence on "Mr.", "Dr.", "etc." and friends.
    static ABBREVIATIONS = new Set([
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
        "st", "mt", "etc", "co", "inc", "ltd", "dept", "vs", "p", "pg",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
        "oct", "nov", "dec",
        "sun", "mon", "tue", "wed", "thu", "fri", "sat"
    ]);

    // Scrub markdown for TTS. Called per-sentence as a safety net after
    // assembly; streaming consumers may also call this statically on the
    // per-tail fast path when emphasis markers could span a delta.
    static stripMarkdown(text) {
        if (!text) return text;
        text = text.replace(/^```[^\n]*\n?/gm, "");
        text = text.replace(/`+([^`\n]+?)`+/g, "$1");
        text = text.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
        text = text.replace(/(?<![*])\*([^*\n]+?)\*(?![*])/g, "$1");
        text = text.replace(/__([^_\n]+?)__/g, "$1");
        text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "$1");
        text = text.replace(/\*\*+/g, "");
        text = text.replace(/__+/g, "");
        text = text.replace(/\*(?=\w)|(?<=\w)\*/g, "");
        text = text.replace(/_(?=\w)|(?<=\w)_/g, "");
        text = text.replace(/^\s*[*+-]\s+/gm, "");
        return text;
    }

    constructor() {
        super();

        // Worker state. Kokoro runs in a Web Worker — see
        // src/workers/tts-worker.js. Keeping the pipeline off the
        // renderer's JS thread means phonemize (WASM, sync), ONNX
        // preprocessing, and the Float32→WAV conversion don't block
        // the UI during synthesis.
        this._worker = null;
        this._workerBackendInUse = null;
        this._workerLoadedDtype = null;
        this._loadPromise = null;
        this._loadResolve = null;
        this._loadReject = null;
        this._synthPending = new Map(); // id → { resolve, reject }
        this._synthNextId = 1;

        // Has the neural pipeline crashed unrecoverably this session?
        // Currently never permanently set false (we let each call retry),
        // but consumers may inspect `isAvailable` for a UI hint.
        this._neuralAvailable = true;

        // Streaming-turn state.
        this._stream = null;            // active EagerSentenceSplitter
        this._turnKey = 0;              // bumped on cancel; consumers check before acting
        this._loadingTurnKey = null;    // turnKey of an in-flight load
        // Audio queue (sequential playback). One <audio> at a time.
        this._audioQueue = [];          // [{ url, audio }]
        this._playing = false;
        this._currentAudio = null;
        this._currentAudioUrl = null;

        // speechSynthesis fallback state.
        this._currentUtterance = null;

        // Per-turn perf hooks (engine fires events; consumers track).
        this._firstAudioFired = false;
        this._firstSynthFired = false;
        this._firstYieldFired = false;
    }

    get isAvailable() { return this._neuralAvailable; }
    get isSpeaking() {
        return this._playing
            || this._audioQueue.length > 0
            || this._stream !== null
            || this._loadingTurnKey !== null
            || (this._currentUtterance !== null);
    }
    get queueSize() { return this._audioQueue.length; }
    get currentTurnKey() { return this._turnKey; }
    get currentDtype() { return this._workerLoadedDtype; }
    get currentBackend() { return this._workerBackendInUse; }

    // Pre-warm the Kokoro pipeline for the given dtype (or the
    // currently-configured dtype). First-turn TTS latency is dominated
    // by model load; calling this when the user toggles voice on means
    // the pipeline is (usually) ready by the time they send.
    preload(dtype) {
        if (!this._neuralAvailable) return Promise.resolve();
        const d = dtype || window.settings?.ttsDtype || TtsEngine.DEFAULT_DTYPE;
        return this._ensureWorkerLoaded(d);
    }

    // One-shot speak. Cancels any prior speech, then streams `text`
    // through the same pipeline as beginStream/pushTail/finishStream.
    speak(text) {
        if (!text || !String(text).trim()) return;
        this.cancel();
        if (this._neuralAvailable) {
            this.beginStream();
            this.pushTail(String(text));
            this.finishStream();
        } else {
            this._speakSystem(String(text));
        }
    }

    // Initialize a new streaming turn. Idempotent within a turn:
    // callable from every delta, only kicks off the pipeline on the
    // first call. The splitter is created eagerly so pushTail() calls
    // that arrive while the worker is still loading are queued rather
    // than dropped — once `_consume` starts, it pulls those sentences
    // in order via the async iterator.
    beginStream() {
        if (this._stream || this._loadingTurnKey) return;
        if (!this._neuralAvailable) return;

        const dtype = window.settings?.ttsDtype || TtsEngine.DEFAULT_DTYPE;
        const voice = window.settings?.ttsVoice || TtsEngine.DEFAULT_VOICE;

        this._turnKey++;
        const turnKey = this._turnKey;
        this._loadingTurnKey = turnKey;
        this._audioQueue = [];
        this._firstAudioFired = false;
        this._firstSynthFired = false;
        this._firstYieldFired = false;
        this._stream = new EagerSentenceSplitter(TtsEngine.ABBREVIATIONS);

        this._ensureWorkerLoaded(dtype).then(() => {
            if (this._turnKey !== turnKey) {
                this._loadingTurnKey = null;
                return;
            }
            this._loadingTurnKey = null;
            this._consume(turnKey, voice);
        }).catch(err => {
            this._loadingTurnKey = null;
            // Splitter still holds any pushed text. Consumers can close
            // it on their next finishStream() call; we just won't have
            // synthesized anything. Surface the failure.
            this.dispatchEvent(new CustomEvent("error", { detail: { message: err?.message || String(err) } }));
        });
    }

    // Push more text into the active stream's buffer. No-op if no
    // stream is active. EagerSentenceSplitter.push doesn't throw.
    pushTail(text) {
        if (!this._stream || !text) return;
        this._stream.push(String(text));
    }

    // Close the active stream — flushes the tail as a final chunk.
    // Returns true if a stream was active so callers can branch on it.
    finishStream() {
        if (!this._stream) return false;
        this._stream.close();
        return true;
    }

    // Hard cancel — drops everything, stops audio, bumps the turn key
    // so any in-flight consumer or pending load bails at its next
    // check. Always fires `speakend` if we were speaking.
    cancel() {
        const wasSpeaking = this.isSpeaking;
        this._turnKey++;
        this._loadingTurnKey = null;
        this._closeActiveStream();
        this._cancelSystemUtterance();
        this._stopCurrentAudio();
        this._drainQueue();
        this._playing = false;
        if (wasSpeaking) this.dispatchEvent(new Event("speakend"));
    }

    _closeActiveStream() {
        if (!this._stream) return;
        // Splitter.close() is idempotent (guards on `_closed`) — no
        // need to swallow exceptions here.
        this._stream.close();
        this._stream = null;
    }

    _cancelSystemUtterance() {
        if (typeof speechSynthesis !== "undefined") {
            try {
                speechSynthesis.cancel();
            } catch (err) {
                // Web Speech API can throw in unusual browser states;
                // best-effort cleanup, log for diagnostics only.
                console.debug("speechSynthesis.cancel ignored:", err);
            }
        }
        this._currentUtterance = null;
    }

    // pause() does not fire onended/onerror, so the per-audio cleanup
    // closure in _pumpQueue never runs and would leak the blob URL.
    // Detach handlers, pause, and revoke here.
    _stopCurrentAudio() {
        if (this._currentAudio) {
            this._currentAudio.onended = null;
            this._currentAudio.onerror = null;
            try {
                this._currentAudio.pause();
            } catch (err) {
                // pause() can throw if the element was never primed;
                // best-effort cleanup, log for diagnostics only.
                console.debug("Audio.pause ignored:", err);
            }
            this._currentAudio = null;
        }
        if (this._currentAudioUrl) {
            URL.revokeObjectURL(this._currentAudioUrl);
            this._currentAudioUrl = null;
        }
    }

    _drainQueue() {
        for (const item of this._audioQueue) URL.revokeObjectURL(item.url);
        this._audioQueue = [];
    }

    // Hard-kill the worker. Engine remains usable; next speak() will
    // spin up a new worker. Rarely needed — the worker survives modal
    // close so the warmed pipeline is reused.
    terminate() {
        this.cancel();
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
            this._workerLoadedDtype = null;
            this._synthPending.clear();
        }
    }

    // -------------------------------------------------------------------
    // Worker management

    // Lazily creates the TTS Worker and wires its message handler.
    _ensureWorker() {
        if (this._worker) return this._worker;
        const forceBackend = window.settings?.ttsBackend;
        const workerPath = forceBackend === "webgpu"
            ? "workers/tts-worker-web.js"
            : "workers/tts-worker.js";
        const workerOpts = workerPath.endsWith("-web.js") ? { type: "module" } : undefined;
        this._workerBackendInUse = workerPath.endsWith("-web.js") ? "webgpu" : "node-cpu";
        this._worker = new Worker(workerPath, workerOpts);
        this._worker.addEventListener("message", (ev) => this._onWorkerMessage(ev));
        this._worker.addEventListener("error", (err) => {
            console.warn(`[TTS Worker:${this._workerBackendInUse}] error:`, err.message || err);
            if (this._loadReject) {
                this._loadReject(new Error(err.message || "Worker error"));
                this._loadResolve = this._loadReject = this._loadPromise = null;
            }
            for (const p of this._synthPending.values()) {
                p.reject(new Error(err.message || "Worker error"));
            }
            this._synthPending.clear();
        });
        return this._worker;
    }

    // If the WebGPU worker's load fails, swap to the node-CPU worker
    // and retry. Called from the load-error handler.
    _fallbackToNodeWorker() {
        if (this._workerBackendInUse !== "webgpu") return;
        console.warn("[TTS] WebGPU load failed; falling back to node-CPU worker");
        this._worker.terminate();
        this._worker = null;
        this._workerLoadedDtype = null;
        this._loadResolve = this._loadReject = this._loadPromise = null;
        if (!window.settings) window.settings = {};
        window.settings.ttsBackend = "node";
    }

    // Load (or reuse) the Kokoro pipeline for the given dtype.
    // Idempotent: returns the same promise while a load is in flight.
    _ensureWorkerLoaded(dtype) {
        this._ensureWorker();
        if (this._workerLoadedDtype === dtype && this._loadPromise === null) {
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

    // Send a sentence to the worker for synthesis. Returns a Promise
    // that resolves with an audio Blob (WAV) ready to play.
    _synthInWorker(text, voice) {
        if (!this._worker || this._workerLoadedDtype === null) {
            return Promise.reject(new Error("Worker not loaded"));
        }
        const id = this._synthNextId++;
        return new Promise((resolve, reject) => {
            this._synthPending.set(id, { resolve, reject });
            this._worker.postMessage({ type: "synthesize", id, text, voice });
        });
    }

    _onWorkerMessage(ev) {
        const msg = ev.data || {};
        if (msg.type === "load-progress") {
            this.dispatchEvent(new CustomEvent("progress", { detail: msg.event }));
        } else if (msg.type === "load-ready") {
            const backend = msg.backend || this._workerBackendInUse || "node-cpu";
            console.info(`[TTS] Worker load(${msg.dtype}) backend=${backend} load=${msg.loadMs.toFixed(0)}ms warmup=${msg.warmMs.toFixed(0)}ms`);
            this._workerLoadedDtype = msg.dtype;
            this.dispatchEvent(new CustomEvent("loadready", {
                detail: { dtype: msg.dtype, backend, loadMs: msg.loadMs, warmMs: msg.warmMs }
            }));
            if (this._loadResolve) this._loadResolve();
            this._loadResolve = this._loadReject = this._loadPromise = null;
        } else if (msg.type === "load-error") {
            if (this._workerBackendInUse === "webgpu") {
                console.warn(`[TTS] WebGPU worker load-error message: ${msg.message}`);
                const pendingDtype = window.settings?.ttsDtype || TtsEngine.DEFAULT_DTYPE;
                this._fallbackToNodeWorker();
                setTimeout(() => {
                    this._ensureWorkerLoaded(pendingDtype).catch(err => {
                        console.warn("Fallback worker load also failed:", err);
                    });
                }, 0);
                return;
            }
            this.dispatchEvent(new CustomEvent("loaderror", { detail: { message: msg.message } }));
            if (this._loadReject) this._loadReject(new Error(msg.message));
            this._loadResolve = this._loadReject = this._loadPromise = null;
        } else if (msg.type === "synth-result") {
            const pending = this._synthPending.get(msg.id);
            if (!pending) return;
            this._synthPending.delete(msg.id);
            const blob = new Blob([msg.wav], { type: "audio/wav" });
            console.info(`[TTS] sentence synth=${msg.synthMs.toFixed(0)}ms chars=${msg.chars}`);
            this.dispatchEvent(new CustomEvent("synthsample", { detail: { chars: msg.chars, ms: msg.synthMs } }));
            pending.resolve(blob);
        } else if (msg.type === "synth-error") {
            const pending = this._synthPending.get(msg.id);
            if (!pending) return;
            this._synthPending.delete(msg.id);
            pending.reject(new Error(msg.message));
        }
    }

    // -------------------------------------------------------------------
    // Streaming consumer + playback

    async _consume(turnKey, voice) {
        try {
            for await (const rawSentence of this._stream) {
                if (this._turnKey !== turnKey) return;
                await this._consumeSentence(rawSentence, turnKey, voice);
                if (this._turnKey !== turnKey) return;
            }
        } catch (err) {
            if (this._turnKey !== turnKey) return;
            console.warn("Kokoro streaming failed mid-turn:", err);
            this.dispatchEvent(new CustomEvent("error", { detail: { message: err?.message || String(err) } }));
        } finally {
            if (this._turnKey === turnKey) this._stream = null;
        }
    }

    // Safety-net scrub — even if a streaming consumer pre-stripped per
    // delta, markers that straddled a delta boundary land here
    // unbalanced.
    async _consumeSentence(rawSentence, turnKey, voice) {
        if (!rawSentence?.trim()) return;
        const sentence = TtsEngine.stripMarkdown(rawSentence);
        if (!sentence?.trim()) return;
        this._fireOnce("_firstYieldFired", "firstyield");
        const blob = await this._synthInWorker(sentence, voice);
        this._fireOnce("_firstSynthFired", "firstsynth");
        if (this._turnKey !== turnKey) return;
        const url = URL.createObjectURL(blob);
        this._audioQueue.push({ url, audio: new Audio(url) });
        this._pumpQueue();
    }

    _fireOnce(flagName, eventName) {
        if (this[flagName]) return;
        this[flagName] = true;
        this.dispatchEvent(new CustomEvent(eventName, { detail: { t: performance.now() } }));
    }

    _pumpQueue() {
        if (this._playing) return;
        const next = this._audioQueue.shift();
        if (!next) return;
        const wasIdle = !this._currentUtterance;
        this._playing = true;
        if (wasIdle) {
            this.dispatchEvent(new Event("speakstart"));
        }
        const isFirstAudio = !this._firstAudioFired;
        const cleanup = () => {
            URL.revokeObjectURL(next.url);
            this._playing = false;
            if (this._currentAudio === next.audio) {
                this._currentAudio = null;
                this._currentAudioUrl = null;
            }
            if (this._audioQueue.length > 0) {
                this._pumpQueue();
            } else if (!this._stream) {
                this.dispatchEvent(new Event("speakend"));
            }
        };
        if (isFirstAudio) {
            next.audio.addEventListener("playing", () => {
                if (!this._firstAudioFired) {
                    this._firstAudioFired = true;
                    this.dispatchEvent(new CustomEvent("firstaudio", { detail: { t: performance.now() } }));
                }
            }, { once: true });
        }
        next.audio.onended = cleanup;
        next.audio.onerror = cleanup;
        this._currentAudio = next.audio;
        this._currentAudioUrl = next.url;
        next.audio.play().catch(cleanup);
    }

    // speechSynthesis fallback — used when the neural pipeline is
    // unavailable or has been demoted for this call.
    _speakSystem(text) {
        if (typeof speechSynthesis === "undefined") return;
        try {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            const voices = speechSynthesis.getVoices();
            if (voices.length > 0) u.voice = voices[0];
            u.onstart = () => this.dispatchEvent(new Event("speakstart"));
            u.onend = () => {
                this._currentUtterance = null;
                this.dispatchEvent(new Event("speakend"));
            };
            u.onerror = u.onend;
            this._currentUtterance = u;
            speechSynthesis.speak(u);
        } catch (err) {
            console.warn("TTS failed:", err);
            this.dispatchEvent(new CustomEvent("error", { detail: { message: err?.message || String(err) } }));
        }
    }
}

module.exports = { TtsEngine };
window.TtsEngine = TtsEngine;
