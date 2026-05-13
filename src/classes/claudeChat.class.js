// Chat modal that talks to the local `claude -p` CLI via IPC bridge in
// _main_claude.js. One UUIDv4 session ID per modal opening — every turn
// within the same modal reuses it (Claude CLI's --session-id), so context
// carries across turns; closing the modal drops the session.

// Eagerly emits sentences as soon as a terminator is seen, even at the
// end of the current buffer. Replaces kokoro-js's TextSplitterStream
// which only yields a sentence after seeing non-whitespace text past
// the terminator — that look-ahead made every sentence land one
// chunk-delay behind, and the final sentence wait for close(). For
// streaming TTS over a live LLM response, eager yield is the win;
// the rare "Mr. Smith" / "..." misclassification is mitigated by an
// abbreviation skip-list (see ClaudeChat.ABBREVIATIONS).
class EagerSentenceSplitter {
    constructor(abbreviations) {
        this._buf = "";
        this._queue = [];
        this._closed = false;
        this._resolve = null;
        this._abbreviations = abbreviations || new Set();
        // Track whether we've already yielded the first chunk of a turn.
        // The very first yield is allowed to break on a soft boundary
        // (comma / semicolon / em-dash) so the user hears audio sooner
        // when the response opens with a long clause-rich sentence.
        // Subsequent yields stick to the full-sentence rule.
        this._firstYielded = false;
        // Don't early-yield until at least this many chars have arrived
        // — avoids cutting "Hi," off as a standalone chunk.
        this._earlyYieldMinChars = 25;
        // If the buffer grows past this many chars without a real
        // terminator, force a soft-boundary split anyway. Bounds the
        // worst-case first-audio latency.
        this._earlyYieldMaxChars = 80;
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
        // Two kinds of break (both for full sentences):
        //   1. Sentence terminator [.!?…。？！]+ optionally followed by
        //      closing quotes/brackets, lookahead-bounded by whitespace
        //      or end-of-buffer.
        //   2. Newline run (\n+). Treats every line break as a sentence
        //      boundary — required for markdown bullet lists and other
        //      structured output where there are no periods between
        //      items. Kokoro's own splitter does the same.
        const re = /[.!?…。？！]+["')\]}」』]*(?=\s|$)|\n+/g;
        let lastEnd = 0;
        let m;
        while ((m = re.exec(this._buf)) !== null) {
            const isNewlineBreak = m[0].startsWith("\n");
            // Abbreviation skip only applies to the terminator branch;
            // newlines always cut.
            if (!isNewlineBreak) {
                const beforeMatch = this._buf.slice(lastEnd, m.index).match(/(\w+)$/);
                const word = beforeMatch ? beforeMatch[1].toLowerCase() : "";
                if (this._abbreviations.has(word)) continue;
            }
            const cut = m.index + m[0].length;
            const sentence = this._buf.slice(lastEnd, cut).trim();
            if (sentence.length > 0) {
                this._queue.push(sentence);
                this._firstYielded = true;
            }
            // Skip any whitespace after the break so the next sentence
            // doesn't start with a stray space.
            lastEnd = cut;
            while (lastEnd < this._buf.length && /\s/.test(this._buf[lastEnd])) {
                lastEnd++;
            }
            re.lastIndex = lastEnd;
        }
        if (lastEnd > 0) this._buf = this._buf.slice(lastEnd);

        // First-chunk early-yield. If we still haven't yielded anything
        // for this turn and the buffer is long enough, look for a soft
        // boundary (comma, semicolon, dash) — splitting there gets
        // first audio out the door sooner. Past _earlyYieldMaxChars we
        // give up on punctuation and just split on the nearest space.
        if (!this._firstYielded && this._buf.length >= this._earlyYieldMinChars) {
            let softCut = -1;
            const softRe = /[,;:][\s)\]}」』]|—|–/g;
            const sm = softRe.exec(this._buf);
            if (sm !== null) softCut = sm.index + 1;
            if (softCut === -1 && this._buf.length >= this._earlyYieldMaxChars) {
                // Force-split on the last space within the cap.
                const tail = this._buf.slice(0, this._earlyYieldMaxChars);
                const lastSpace = tail.lastIndexOf(" ");
                if (lastSpace > this._earlyYieldMinChars) softCut = lastSpace;
            }
            if (softCut > 0) {
                const chunk = this._buf.slice(0, softCut).trim();
                if (chunk.length > 0) {
                    this._queue.push(chunk);
                    this._firstYielded = true;
                    let trimStart = softCut;
                    while (trimStart < this._buf.length && /\s/.test(this._buf[trimStart])) {
                        trimStart++;
                    }
                    this._buf = this._buf.slice(trimStart);
                }
            }
        }

        if (this._queue.length > 0) this._wake();
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

class ClaudeChat {
    // Forced via --model on every spawn so the chat doesn't inherit
    // whatever the user's Claude Code default happens to be.
    static DEFAULT_MODEL = "claude-haiku-4-5";

    // Kokoro TTS — neural, runs fully in the renderer via WASM/ONNX.
    // Models are fetched from HuggingFace on first use of each dtype —
    // never bundled. We currently re-download on every cold start
    // (`useFSCache: false`); see the from_pretrained call below for the
    // rationale. The defaults here are the fallbacks when
    // window.settings is missing.
    static TTS_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
    static TTS_DTYPE = "q8";
    static TTS_VOICE = "af_heart";

    // All voices shipped in Kokoro-82M-v1.0-ONNX. Same model file
    // covers them all — switching voices does not trigger a re-fetch.
    // Grades come from kokoro-js's own voice index (overall quality).
    static VOICES = [
        // American Female
        { id: "af_heart",   grade: "A",  region: "US", gender: "F", traits: "❤️" },
        { id: "af_bella",   grade: "A-", region: "US", gender: "F", traits: "🔥" },
        { id: "af_nicole",  grade: "B-", region: "US", gender: "F", traits: "🎧" },
        { id: "af_aoede",   grade: "C+", region: "US", gender: "F" },
        { id: "af_kore",    grade: "C+", region: "US", gender: "F" },
        { id: "af_sarah",   grade: "C+", region: "US", gender: "F" },
        { id: "af_alloy",   grade: "C",  region: "US", gender: "F" },
        { id: "af_nova",    grade: "C",  region: "US", gender: "F" },
        { id: "af_sky",     grade: "C-", region: "US", gender: "F" },
        { id: "af_jessica", grade: "D",  region: "US", gender: "F" },
        { id: "af_river",   grade: "D",  region: "US", gender: "F" },
        // American Male
        { id: "am_fenrir",  grade: "C+", region: "US", gender: "M" },
        { id: "am_michael", grade: "C+", region: "US", gender: "M" },
        { id: "am_puck",    grade: "C+", region: "US", gender: "M" },
        { id: "am_echo",    grade: "D",  region: "US", gender: "M" },
        { id: "am_eric",    grade: "D",  region: "US", gender: "M" },
        { id: "am_liam",    grade: "D",  region: "US", gender: "M" },
        { id: "am_onyx",    grade: "D",  region: "US", gender: "M" },
        { id: "am_santa",   grade: "D-", region: "US", gender: "M" },
        { id: "am_adam",    grade: "F+", region: "US", gender: "M" },
        // British Female
        { id: "bf_emma",     grade: "B-", region: "UK", gender: "F", traits: "🚺" },
        { id: "bf_isabella", grade: "C",  region: "UK", gender: "F" },
        { id: "bf_alice",    grade: "D",  region: "UK", gender: "F", traits: "🚺" },
        { id: "bf_lily",     grade: "D",  region: "UK", gender: "F", traits: "🚺" },
        // British Male
        { id: "bm_fable",  grade: "C",  region: "UK", gender: "M", traits: "🚹" },
        { id: "bm_george", grade: "C",  region: "UK", gender: "M" },
        { id: "bm_lewis",  grade: "D+", region: "UK", gender: "M" },
        { id: "bm_daniel", grade: "D",  region: "UK", gender: "M", traits: "🚹" }
    ];

    // Quantization tiers. Each is a separate .onnx file on HuggingFace,
    // fetched on first use of that dtype within a session. With
    // FS-cache disabled, switching to a new dtype refetches; switching
    // back within the same session reuses the in-memory pipeline if it
    // wasn't invalidated. Sizes are approximate.
    static DTYPES = [
        { id: "q8",    label: "q8 (~92 MB, recommended)" },
        { id: "fp16",  label: "fp16 (~163 MB)" },
        { id: "fp32",  label: "fp32 (~326 MB)" },
        { id: "q4f16", label: "q4f16 (~155 MB)" },
        { id: "q4",    label: "q4 (~50 MB, low)" }
    ];

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

    // Patterns shared between `_extractSources` (end-of-turn cleanup of
    // the bubble text) and the streaming TTS filter (`_ttsPushTail`).
    // Keeping them in one place ensures the spoken text and the rendered
    // text agree on what counts as a URL / sources block.
    //
    // `SOURCES_BLOCK_RE` matches an optional markdown-emphasis wrapper
    // around Sources/References/Citations + the rest of the string.
    // `INLINE_LINK_RE` matches `[label](url)` markdown links.
    // `BARE_URL_RE` matches standalone http(s) URLs.
    static SOURCES_BLOCK_RE = /\n+\s*(?:[#*_]+\s*)?(?:Sources?|References?|Citations?)\s*(?:[*_]+)?\s*:?\s*\n[\s\S]*$/i;
    static INLINE_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
    static BARE_URL_RE = /https?:\/\/\S+/g;

    // URL safety helper — only http(s) URLs are allowed to reach
    // shell.openExternal. `javascript:` or `file:` schemes can execute
    // arbitrary code via the OS handler, so we hard-reject them.
    static _isHttpUrl(s) {
        if (typeof s !== "string" || s.length === 0) return false;
        try {
            const u = new URL(s);
            return u.protocol === "http:" || u.protocol === "https:";
        } catch (_) {
            return false;
        }
    }

    static open() {
        if (window.modals && Object.values(window.modals).some(m => m && m._isClaudeChat)) {
            return; // already open
        }
        return new ClaudeChat();
    }

    constructor() {
        const ipc = require("electron").ipcRenderer;
        const { randomUUID } = require("crypto");

        this.ipc = ipc;
        this.sessionId = randomUUID();
        this.firstTurn = true;
        this.pendingReqId = null;
        this.activeAssistantBubble = null;
        this.activeAssistantBuf = "";
        this.model = ClaudeChat.DEFAULT_MODEL;
        this.voiceEnabled = false;
        this.avatar = null;
        this.currentUtterance = null;
        this.currentAudio = null;
        this.currentTtsReq = null;
        this.neuralTtsAvailable = true; // WASM, demoted on first failure
        this.pendingAudioUrl = null;
        // Kokoro runs in a Web Worker — see src/workers/tts-worker.js.
        // Keeping the pipeline off the renderer's JS thread means
        // phonemize (WASM, sync), ONNX preprocessing, and the
        // Float32→WAV conversion don't block the chat UI during
        // synthesis. The worker itself loads kokoro-js via require()
        // (enabled by `nodeIntegrationInWorker: true` in _boot.js).
        this._ttsWorker = null;          // Worker instance
        this._ttsWorkerLoadedDtype = null;
        this._ttsLoadPromise = null;     // in-flight load, if any
        this._ttsLoadResolve = null;
        this._ttsLoadReject = null;
        this._ttsSynthPending = new Map(); // id → { resolve, reject }
        this._ttsSynthNextId = 1;

        // Streaming TTS state. The splitter accepts delta chunks via
        // `push(text)` and yields full sentences to kokoro's `stream()`
        // generator; each yielded sentence is synthesized and queued
        // for sequential playback. See _ttsBegin / _ttsConsume.
        this._ttsStream = null;          // TextSplitterStream instance
        this._ttsTurnKey = 0;            // bumped on cancel; consumers check before acting
        this._ttsAudioQueue = [];        // [{ url, audio }] pending playback
        this._ttsPlaying = false;        // an <audio> element is actively playing
        this._ttsPushedLen = 0;          // chars from rolling buffer already pushed
        this._ttsSourcesReached = false; // saw Sources block — stop pushing

        // Typewriter-style streaming: buffer raw deltas, then reveal
        // characters on a steady RAF tick so the output reads like a
        // smooth stream instead of token-batch jumps.
        this._pendingChars = "";
        this._streamRaf = null;
        this._streamLastT = 0;
        this._streamCarry = 0;          // sub-char accumulator across frames
        this._streamHorizonMs = 250;    // try to drain the pending buffer within ~250ms

        // Perf: PerformanceObserver flags any main-thread task longer
        // than 50ms (browser default for the "longtask" entry type).
        // We feed the worst one per turn into the perf summary so we
        // can see if the worker is actually keeping the UI thread free.
        this._perf = null;
        try {
            if (typeof PerformanceObserver !== "undefined") {
                this._longTaskObserver = new PerformanceObserver((list) => {
                    if (!this._perf) return;
                    for (const entry of list.getEntries()) {
                        if (entry.duration > this._perf.longTaskMax) {
                            this._perf.longTaskMax = entry.duration;
                        }
                    }
                });
                this._longTaskObserver.observe({ entryTypes: ["longtask"] });
            }
        } catch (_) {
            // Not all environments support longtask. Skip silently.
        }

        const detachKeyboard = (typeof window !== "undefined" && window.keyboard && window.keyboard.detach) ? () => window.keyboard.detach() : () => {};
        const attachKeyboard = (typeof window !== "undefined" && window.keyboard && window.keyboard.attach) ? () => window.keyboard.attach() : () => {};
        detachKeyboard();

        this.modal = new Modal({
            type: "custom",
            title: `CLAUDE CHAT <i>session ${this.sessionId.slice(0, 8)}</i>`,
            html: `<div class="claudeChat_root">
                    <div class="claudeChat_header">
                        <canvas class="claudeChat_avatar" id="claudeChat_avatar"></canvas>
                        <div class="claudeChat_headerInfo">
                            <div class="claudeChat_modelLine" id="claudeChat_modelLine">model: <span id="claudeChat_modelName">${ClaudeChat.DEFAULT_MODEL}</span></div>
                            <div class="claudeChat_voiceLine">voice: <button id="claudeChat_voiceToggle" type="button">VOICE: OFF</button></div>
                            <div class="claudeChat_ttsLine">TTS: <span id="claudeChat_ttsConfig">…</span></div>
                        </div>
                    </div>
                    <div class="claudeChat_scrollback" id="claudeChat_scrollback"></div>
                    <div class="claudeChat_inputRow">
                        <textarea
                            id="claudeChat_input"
                            placeholder="Ask Claude... (Enter to send, Shift+Enter for newline, Esc to close)"
                            rows="3"
                            spellcheck="false"
                            autocomplete="off"
                        ></textarea>
                        <button id="claudeChat_send" type="button">SEND</button>
                    </div>
                    <div class="claudeChat_status" id="claudeChat_status">Ready. Type a prompt and press Send.</div>
                    <div class="claudeChat_progress" id="claudeChat_progress" hidden>
                        <div class="claudeChat_progress_label" id="claudeChat_progress_label"></div>
                        <div class="claudeChat_progress_track"><div class="claudeChat_progress_fill" id="claudeChat_progress_fill"></div></div>
                    </div>
                </div>`,
            buttons: []
        }, () => {
            this._teardown();
            attachKeyboard();
            if (window.term && window.currentTerm !== undefined && window.term[window.currentTerm]) {
                try { window.term[window.currentTerm].term.focus(); } catch (_) {}
            }
        });
        this.modal._isClaudeChat = true;
        window.modals[this.modal.id]._isClaudeChat = true;

        this.scrollback = document.getElementById("claudeChat_scrollback");
        this.input = document.getElementById("claudeChat_input");
        this.sendBtn = document.getElementById("claudeChat_send");
        this.status = document.getElementById("claudeChat_status");
        this.progressEl = document.getElementById("claudeChat_progress");
        this.progressLabel = document.getElementById("claudeChat_progress_label");
        this.progressFill = document.getElementById("claudeChat_progress_fill");
        this.modelName = document.getElementById("claudeChat_modelName");
        this.ttsConfigEl = document.getElementById("claudeChat_ttsConfig");
        this.voiceToggle = document.getElementById("claudeChat_voiceToggle");
        this._refreshTtsConfigDisplay();
        this.avatarCanvas = document.getElementById("claudeChat_avatar");

        this.avatar = new AIAvatar(this.avatarCanvas);
        this.avatar.setState("idle");

        this.voiceToggle.addEventListener("click", () => this._toggleVoice());

        this.sendBtn.addEventListener("click", () => this._submit());
        this.input.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) {
                // Plain Enter sends; Shift+Enter inserts a newline.
                e.preventDefault();
                this._submit();
                return;
            }
            // Esc is handled globally by Modal._ensureGlobalEsc().
        });

        // IPC subscriptions — keep references so we can remove on close
        this._onDelta = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            if (this._perf && this._perf.firstDeltaT === null) {
                this._perf.firstDeltaT = performance.now();
            }
            this._appendAssistantText(payload.text || "");
            if (this.avatar && this.avatar.state === "thinking") {
                this.avatar.setState("responding");
            }
            // Streaming TTS — kick off (idempotent) on the first delta
            // and push the new tail. Cheap; nothing happens unless
            // voice is on AND neural TTS is available.
            if (this.voiceEnabled && this.neuralTtsAvailable) {
                this._ttsBegin();
                this._ttsPushTail();
            }
        };
        this._onDone = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            this._drainPending();
            // Extract sources from the completed response, replace the
            // bubble's text with the cleaned version, attach a sources
            // icon if any were found, and use the cleaned text for TTS
            // so URLs don't get read out loud.
            const { cleaned, sources } = this._extractSources(this.activeAssistantBuf);
            if (this.activeAssistantBubble) {
                this.activeAssistantBubble.querySelector("pre").textContent = cleaned;
                if (sources.length > 0) {
                    this._attachSourcesIcon(this.activeAssistantBubble, sources);
                }
            }
            const spoken = cleaned;
            this._finalizeAssistant();
            this.firstTurn = false;
            this.status.innerText = "Ready.";
            // If a streaming TTS pipeline was started during this turn,
            // close the splitter and let the consumer drain — the
            // playback queue will settle the avatar back to idle on its
            // own. Otherwise (voice off, or neural unavailable so
            // streaming never began) fall through to the legacy
            // one-shot path with the full cleaned text.
            const streaming = this._ttsFinish();
            if (streaming) {
                // Consumer pumps the queue; nothing more to do here.
            } else if (this.voiceEnabled && spoken.trim().length > 0) {
                this._speak(spoken);
            } else if (this.avatar) {
                this.avatar.setState("idle");
            }
        };
        this._onError = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            this._drainPending();
            const msg = (payload && payload.message) ? payload.message : "Unknown error";
            this._appendErrorLine(msg);
            this._finalizeAssistant();
            this.status.innerText = "Error.";
            if (this.avatar) this.avatar.setState("error");
        };
        this._onResult = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            const r = payload.result || {};
            if (r.usage) {
                const u = r.usage;
                const total = (u.input_tokens || 0) + (u.output_tokens || 0);
                this.status.innerText = `Done. ${total} tokens (in ${u.input_tokens || 0} / out ${u.output_tokens || 0}).`;
            }
        };

        this._onModel = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            if (payload.model && payload.model !== this.model) {
                this.model = payload.model;
                this.modelName.textContent = this.model;
            }
        };

        ipc.on("claude:delta", this._onDelta);
        ipc.on("claude:done", this._onDone);
        ipc.on("claude:error", this._onError);
        ipc.on("claude:result", this._onResult);
        ipc.on("claude:model", this._onModel);

        setTimeout(() => { try { this.input.focus(); } catch (_) {} }, 50);
    }

    _submit() {
        const prompt = this.input.value.trim();
        if (!prompt) return;
        if (this.pendingReqId) return; // already in flight

        // Cancel any TTS still in flight from the previous turn — both
        // playing audio and the streaming consumer.
        this._cancelSpeech();

        // Perf instrumentation. The chat modal records a few timestamps
        // per turn so we can log T-first-audio (submit → audio.onplay
        // of sentence 1), queue-peak (max concurrent synthesized
        // sentences ahead of playback), and the first-3-sentence per-
        // char synth rate. Numbers feed docs/tts-perf.md. Behaviour-
        // neutral.
        this._perf = {
            submitT: performance.now(),
            ipcOutT: null,         // just before ipc.send("claude:send")
            firstDeltaT: null,     // first claude:delta IPC received
            firstBubbleCharT: null,// first char rendered into the bubble (RAF)
            firstTtsYieldT: null,  // first sentence emitted by splitter
            firstSynthDoneT: null, // first synth-result message resolved
            firstAudioT: null,     // audio.onplay of sentence 1
            firstSentenceSynthMs: [],
            queuePeak: 0,
            longTaskMax: 0,
            cold: this._perf ? false : true
        };

        this._appendUserBubble(prompt);
        this.input.value = "";
        this._beginAssistantBubble();

        this.pendingReqId = `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        this.status.innerText = "Querying claude…";
        if (this.avatar) this.avatar.setState("thinking");
        if (this._perf) this._perf.ipcOutT = performance.now();
        this.ipc.send("claude:send", {
            reqId: this.pendingReqId,
            sessionId: this.sessionId,
            firstTurn: this.firstTurn,
            model: this.model,
            prompt
        });
    }

    _toggleVoice() {
        this.voiceEnabled = !this.voiceEnabled;
        const kokoroSuffix = this.neuralTtsAvailable ? " (KOKORO)" : "";
        this.voiceToggle.textContent = this.voiceEnabled
            ? `VOICE: ON${kokoroSuffix}`
            : "VOICE: OFF";
        this.voiceToggle.classList.toggle("on", this.voiceEnabled);
        this._refreshTtsConfigDisplay();
        if (!this.voiceEnabled) {
            this._cancelSpeech();
            if (this.avatar && !this.pendingReqId) this.avatar.setState("idle");
        }
        if (this.voiceEnabled && this.neuralTtsAvailable) {
            // Pre-warm the Kokoro pipeline. Model load is the long pole on
            // the first turn of a session — kicking it off here means it's
            // (usually) ready by the time the user submits, so streaming
            // can start synthesizing as soon as the first sentence
            // boundary arrives instead of waiting for the model.
            const dtype = (window.settings && window.settings.ttsDtype) || ClaudeChat.TTS_DTYPE;
            this._ensureWorkerLoaded(dtype).catch(err => {
                console.warn("Kokoro pre-warm failed:", err);
            });
        }
        if (this.voiceEnabled && !this.neuralTtsAvailable && typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices().length === 0) {
            this.status.innerText = "Voice enabled, but no TTS voice is available on this system.";
        }
    }

    _cancelSpeech() {
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
        this.currentUtterance = null;
        if (this.currentAudio) {
            try { this.currentAudio.pause(); } catch (_) {}
            this.currentAudio = null;
        }
        if (this.pendingAudioUrl) {
            try { URL.revokeObjectURL(this.pendingAudioUrl); } catch (_) {}
            this.pendingAudioUrl = null;
        }
        // Tear down any active streaming TTS pipeline too.
        this._ttsCancel();
        // No IPC cancel for WASM piper — we drop currentTtsReq, and
        // _speakPiper will see the mismatch and abandon its result.
        this.currentTtsReq = null;
    }

    _speak(text) {
        if (this.neuralTtsAvailable) {
            this._speakNeural(text);
        } else {
            this._speakSystem(text);
        }
    }

    // Lazily creates the TTS Worker and wires its message handler. The
    // worker outlives individual turns — we kill it on modal close.
    //
    // The WebGPU worker (`tts-worker-web.js`) is kept in tree but
    // not used by default: in an Electron node-integrated worker
    // kokoro.web.js's bundled transformers still detects Node and
    // refuses `device: "webgpu"` ("Should be one of: cpu."). To
    // actually run WebGPU we'd need a non-node-integrated worker
    // context, which is a separate refactor. The default node-CPU
    // worker now also tries the CoreML execution provider on macOS
    // before falling back to CPU.
    _ensureWorker() {
        if (this._ttsWorker) return this._ttsWorker;
        const forceBackend = window.settings && window.settings.ttsBackend;
        const path = forceBackend === "webgpu"
            ? "workers/tts-worker-web.js"
            : "workers/tts-worker.js";
        const workerOpts = path.endsWith("-web.js") ? { type: "module" } : undefined;
        this._ttsBackendInUse = path.endsWith("-web.js") ? "webgpu" : "node-cpu";
        this._ttsWorker = new Worker(path, workerOpts);
        this._ttsWorker.addEventListener("message", (ev) => this._onTtsWorkerMessage(ev));
        this._ttsWorker.addEventListener("error", (err) => {
            console.warn(`[TTS Worker:${this._ttsBackendInUse}] error:`, err.message || err);
            // Reject any in-flight promises so consumers don't hang.
            if (this._ttsLoadReject) {
                this._ttsLoadReject(new Error(err.message || "Worker error"));
                this._ttsLoadResolve = this._ttsLoadReject = this._ttsLoadPromise = null;
            }
            for (const p of this._ttsSynthPending.values()) {
                p.reject(new Error(err.message || "Worker error"));
            }
            this._ttsSynthPending.clear();
        });
        return this._ttsWorker;
    }

    // If the WebGPU worker's load fails, swap to the node-CPU worker
    // and retry. Called from the load-error handler.
    _fallbackToNodeWorker() {
        if (this._ttsBackendInUse !== "webgpu") return;
        console.warn("[TTS] WebGPU load failed; falling back to node-CPU worker");
        try { this._ttsWorker.terminate(); } catch (_) {}
        this._ttsWorker = null;
        this._ttsWorkerLoadedDtype = null;
        // Reset the pending-load tracking so _ensureWorkerLoaded can
        // restart cleanly with the node worker.
        this._ttsLoadResolve = this._ttsLoadReject = this._ttsLoadPromise = null;
        // Mark this so _ensureWorker uses the node path even though
        // ttsBackend isn't set.
        if (!window.settings) window.settings = {};
        window.settings.ttsBackend = "node";
    }

    // Load (or reuse) the Kokoro pipeline in the worker for the given
    // dtype. Idempotent: returns the same promise while a load is in
    // flight; resolves immediately if already loaded with the same dtype.
    _ensureWorkerLoaded(dtype) {
        this._ensureWorker();
        if (this._ttsWorkerLoadedDtype === dtype && this._ttsLoadPromise === null) {
            return Promise.resolve();
        }
        if (this._ttsLoadPromise !== null) return this._ttsLoadPromise;

        this.status.innerText = `Loading Kokoro TTS (${dtype})…`;
        this._showProgress(`Loading model (${dtype})…`);
        this._ttsLoadPromise = new Promise((resolve, reject) => {
            this._ttsLoadResolve = resolve;
            this._ttsLoadReject = reject;
        });
        this._ttsWorker.postMessage({ type: "load", dtype });
        return this._ttsLoadPromise;
    }

    // Send a sentence to the worker for synthesis. Returns a Promise
    // that resolves with an audio Blob (WAV) ready to play.
    _synthInWorker(text, voice) {
        if (!this._ttsWorker || this._ttsWorkerLoadedDtype === null) {
            return Promise.reject(new Error("Worker not loaded"));
        }
        const id = this._ttsSynthNextId++;
        return new Promise((resolve, reject) => {
            this._ttsSynthPending.set(id, { resolve, reject });
            this._ttsWorker.postMessage({ type: "synthesize", id, text, voice });
        });
    }

    // Worker → main thread message dispatcher.
    _onTtsWorkerMessage(ev) {
        const msg = ev.data || {};
        if (msg.type === "load-progress") {
            this._onTtsProgress(msg.event);
        } else if (msg.type === "load-ready") {
            const backend = msg.backend || this._ttsBackendInUse || "node-cpu";
            console.info(`[TTS] Worker load(${msg.dtype}) backend=${backend} load=${msg.loadMs.toFixed(0)}ms warmup=${msg.warmMs.toFixed(0)}ms`);
            this._ttsWorkerLoadedDtype = msg.dtype;
            this._hideProgress();
            this.status.innerText = `Kokoro ready (${msg.dtype}, ${backend}).`;
            if (this._ttsLoadResolve) this._ttsLoadResolve();
            this._ttsLoadResolve = this._ttsLoadReject = this._ttsLoadPromise = null;
        } else if (msg.type === "load-error") {
            // If the WebGPU worker failed to load, fall back to the
            // node-CPU worker transparently and retry the load.
            if (this._ttsBackendInUse === "webgpu") {
                console.warn(`[TTS] WebGPU worker load-error message: ${msg.message}`);
                const pendingDtype = (window.settings && window.settings.ttsDtype) || ClaudeChat.TTS_DTYPE;
                this._fallbackToNodeWorker();
                // _ensureWorkerLoaded will spin up the node worker on
                // the next call. Defer to avoid recursion in the same
                // message tick.
                setTimeout(() => {
                    this._ensureWorkerLoaded(pendingDtype).catch(err => {
                        console.warn("Fallback worker load also failed:", err);
                    });
                }, 0);
                return;
            }
            this._hideProgress();
            if (this._ttsLoadReject) this._ttsLoadReject(new Error(msg.message));
            this._ttsLoadResolve = this._ttsLoadReject = this._ttsLoadPromise = null;
        } else if (msg.type === "synth-result") {
            const pending = this._ttsSynthPending.get(msg.id);
            if (!pending) return;
            this._ttsSynthPending.delete(msg.id);
            const blob = new Blob([msg.wav], { type: "audio/wav" });
            console.info(`[TTS] sentence synth=${msg.synthMs.toFixed(0)}ms chars=${msg.chars}`);
            // Perf: capture per-char synth rate for first 3 sentences
            // of the current turn. Used by the turn-summary line.
            if (this._perf && this._perf.firstSentenceSynthMs.length < 3 && msg.chars > 0) {
                this._perf.firstSentenceSynthMs.push({
                    chars: msg.chars,
                    ms: msg.synthMs
                });
            }
            pending.resolve(blob);
        } else if (msg.type === "synth-error") {
            const pending = this._ttsSynthPending.get(msg.id);
            if (!pending) return;
            this._ttsSynthPending.delete(msg.id);
            pending.reject(new Error(msg.message));
        }
    }

    async _speakNeural(text) {
        this._cancelSpeech();
        const opId = `tts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        this.currentTtsReq = opId;
        if (this.avatar) this.avatar.setState("speaking");
        const voice = (window.settings && window.settings.ttsVoice) || ClaudeChat.TTS_VOICE;
        const dtype = (window.settings && window.settings.ttsDtype) || ClaudeChat.TTS_DTYPE;
        this._refreshTtsConfigDisplay();
        try {
            await this._ensureWorkerLoaded(dtype);
            if (this.currentTtsReq !== opId) return; // cancelled while loading
            this.status.innerText = "Synthesizing…";
            const wavBlob = await this._synthInWorker(text, voice);
            if (this.currentTtsReq !== opId) return; // cancelled mid-synthesis
            this.status.innerText = "Speaking.";
            const url = URL.createObjectURL(wavBlob);
            this.pendingAudioUrl = url;
            const audio = new Audio(url);
            audio.onplay = () => { if (this.avatar) this.avatar.setState("speaking"); };
            const cleanup = () => {
                if (this.pendingAudioUrl === url) {
                    URL.revokeObjectURL(url);
                    this.pendingAudioUrl = null;
                }
                this.currentAudio = null;
                if (this.currentTtsReq === opId) this.currentTtsReq = null;
                if (this.avatar && !this.pendingReqId) this.avatar.setState("idle");
                this.status.innerText = "Ready.";
            };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            this.currentAudio = audio;
            audio.play().catch(err => {
                console.warn("Audio playback failed:", err);
                cleanup();
            });
        } catch (err) {
            // Per-call fallback only. Pre-PR-21 we demoted permanently
            // (`neuralTtsAvailable = false`), but with user-switchable
            // dtypes a transient failure on a not-yet-cached dtype would
            // disable neural TTS for the whole session — even though
            // switching back to a known-good dtype would work. Let the
            // next call retry from_pretrained.
            console.warn("Kokoro TTS failed, falling back to speechSynthesis:", err);
            this.status.innerText = `Kokoro failed (${err && err.message ? err.message : err}); using system voice.`;
            this._hideProgress();
            if (this.currentTtsReq === opId) this.currentTtsReq = null;
            this._speakSystem(text);
        }
    }

    // -------------------------------------------------------------------
    // Streaming TTS pipeline.
    //
    // Kicked off from `_onDelta` on the first chunk of a turn (when voice
    // is enabled). Each subsequent delta pushes its tail into a
    // TextSplitterStream; the stream yields complete sentences to
    // kokoro's `stream()` generator, which synthesizes audio per
    // sentence; `_ttsPumpQueue` plays the resulting Audio elements in
    // order. Cancellation (Esc / voice off / new prompt / modal close)
    // goes through `_ttsCancel`, which bumps `_ttsTurnKey` so any
    // in-flight consumer aborts after its current yield.

    // Initialize a new streaming turn. Idempotent within a turn: callable
    // from every delta, only kicks off the pipeline on the first call.
    _ttsBegin() {
        if (this._ttsStream || this._ttsLoadingTurnKey) return;
        if (!this.voiceEnabled || !this.neuralTtsAvailable) return;

        const dtype = (window.settings && window.settings.ttsDtype) || ClaudeChat.TTS_DTYPE;
        const voice = (window.settings && window.settings.ttsVoice) || ClaudeChat.TTS_VOICE;

        this._ttsTurnKey++;
        const turnKey = this._ttsTurnKey;
        this._ttsLoadingTurnKey = turnKey;
        this._ttsPushedLen = 0;
        this._ttsSourcesReached = false;
        this._ttsPendingClose = false;
        this._ttsAudioQueue = [];

        this._refreshTtsConfigDisplay();

        this._ensureWorkerLoaded(dtype).then(() => {
            // Worker ready. If the user cancelled / opened a new turn
            // while loading, abandon.
            if (this._ttsTurnKey !== turnKey) {
                this._ttsLoadingTurnKey = null;
                return;
            }
            this._ttsLoadingTurnKey = null;
            // Use our eager splitter, not kokoro's TextSplitterStream —
            // see EagerSentenceSplitter's comment for why.
            this._ttsStream = new EagerSentenceSplitter(ClaudeChat.ABBREVIATIONS);
            // Push everything that arrived during load.
            this._ttsPushTail();
            // If _onDone fired while we were loading, propagate the close.
            if (this._ttsPendingClose) {
                this._ttsPendingClose = false;
                try { this._ttsStream.close(); } catch (_) {}
            }
            this._ttsConsume(turnKey, voice);
        }).catch(err => {
            // Pipeline load failed. _onDone's fallback path will speak
            // via the system voice over the full text.
            this._ttsLoadingTurnKey = null;
            console.warn("Kokoro pipeline load failed:", err);
            this._hideProgress();
        });
    }

    // Push the new tail of `activeAssistantBuf + _pendingChars` into the
    // splitter, after stripping URLs and detecting the Sources block.
    _ttsPushTail() {
        if (this._ttsSourcesReached) return;
        if (!this._ttsStream) return;
        const rolling = this.activeAssistantBuf + this._pendingChars;
        let cutoff = rolling.length;
        const blockMatch = rolling.match(ClaudeChat.SOURCES_BLOCK_RE);
        if (blockMatch) {
            this._ttsSourcesReached = true;
            cutoff = blockMatch.index;
        }
        if (cutoff <= this._ttsPushedLen) return;
        const tail = rolling.slice(this._ttsPushedLen, cutoff);
        // Strip URLs from the tail. Markdown links keep their label so
        // the spoken text reads naturally; bare URLs are dropped.
        let cleaned = tail.replace(ClaudeChat.INLINE_LINK_RE, (_m, label) => label);
        cleaned = cleaned.replace(ClaudeChat.BARE_URL_RE, "");
        // Markdown strip is a fast path here — works when a `**bold**`
        // run fits in one delta. The sentence-time pass in _ttsConsume
        // catches anything that straddles a delta boundary (#54).
        cleaned = this._stripMarkdownForTts(cleaned);
        if (cleaned.length > 0) {
            try { this._ttsStream.push(cleaned); } catch (_) {}
        }
        this._ttsPushedLen = cutoff;
    }

    // Scrub markdown for TTS. Called at two points: per-tail (fast
    // path while text is streaming in) and per-sentence (safety net
    // after assembly). The orphan-marker passes at the end matter
    // for the sentence call: when `**bold**` straddles a streaming
    // delta boundary, neither half has a balanced pair and the
    // first regex misses; the orphan kill catches it. Per-tail
    // calls fall through those passes as no-ops on well-formed input.
    _stripMarkdownForTts(text) {
        if (!text) return text;
        // Code fences first so balanced strips don't operate inside them.
        text = text.replace(/^```[^\n]*\n?/gm, "");
        // Inline code spans: keep content, drop backticks.
        text = text.replace(/`+([^`\n]+?)`+/g, "$1");
        // Balanced emphasis pairs.
        text = text.replace(/\*\*([^*\n]+?)\*\*/g, "$1");                  // **bold**
        text = text.replace(/(?<![*])\*([^*\n]+?)\*(?![*])/g, "$1");       // *italic*
        text = text.replace(/__([^_\n]+?)__/g, "$1");                      // __bold__
        text = text.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "$1");           // _italic_
        // Orphan markers from cross-delta or cross-sentence splits.
        // Multi-char runs are always safe to nuke once their balanced
        // pairs have been consumed above.
        text = text.replace(/\*\*+/g, "");
        text = text.replace(/__+/g, "");
        // Single-char orphans: only kill when adjacent to a word char,
        // so whitespace-surrounded literal `*` (e.g. `git commit *`)
        // and standalone `_` (e.g. variable names already past the
        // balanced pass) survive.
        text = text.replace(/\*(?=\w)|(?<=\w)\*/g, "");
        text = text.replace(/_(?=\w)|(?<=\w)_/g, "");
        // Line-leading bullet markers — otherwise kokoro reads each
        // list item as "asterisk item one, asterisk item two."
        text = text.replace(/^\s*[*+-]\s+/gm, "");
        return text;
    }

    // Called from _onDone. Closes the splitter (or queues a pending
    // close if the pipeline is still loading). Returns true if a stream
    // was active so the caller can skip the legacy `_speak(spoken)`.
    _ttsFinish() {
        if (!this._ttsStream && !this._ttsLoadingTurnKey) return false;
        this._ttsPushTail();
        if (this._ttsStream) {
            try { this._ttsStream.close(); } catch (_) {}
        } else {
            this._ttsPendingClose = true;
        }
        return true;
    }

    // Hard cancel — drops everything, stops audio, bumps the turn key so
    // any in-flight consumer or pending load bails after its next check.
    _ttsCancel() {
        this._ttsTurnKey++;
        this._ttsLoadingTurnKey = null;
        if (this._ttsStream) {
            try { this._ttsStream.close(); } catch (_) {}
            this._ttsStream = null;
        }
        for (const item of this._ttsAudioQueue) {
            try { URL.revokeObjectURL(item.url); } catch (_) {}
        }
        this._ttsAudioQueue = [];
        this._ttsPlaying = false;
        this._ttsPushedLen = 0;
        this._ttsSourcesReached = false;
        this._ttsPendingClose = false;
    }

    // Async consumer loop — pulls one sentence at a time from our eager
    // splitter, synthesizes it via kokoro.generate(), queues the audio,
    // and pumps the queue. Bypasses kokoro's own stream() generator so
    // we get eager sentence emission instead of one-chunk-behind.
    async _ttsConsume(turnKey, voice) {
        const turnStart = performance.now();
        let firstSentenceTime = null;
        let sentenceCount = 0;
        try {
            for await (const rawSentence of this._ttsStream) {
                if (this._ttsTurnKey !== turnKey) return;
                if (!rawSentence || !rawSentence.trim()) continue;
                // Safety-net scrub — the per-tail strip in
                // _ttsPushTail misses markers that straddle a
                // streaming delta boundary (#54). At this point the
                // sentence is fully assembled, so the balanced-pair
                // regexes and orphan-marker passes both see complete
                // context.
                const sentence = this._stripMarkdownForTts(rawSentence);
                if (!sentence || !sentence.trim()) continue;
                if (firstSentenceTime === null) {
                    firstSentenceTime = performance.now() - turnStart;
                    if (this._perf && this._perf.firstTtsYieldT === null) {
                        this._perf.firstTtsYieldT = performance.now();
                    }
                    console.info(`[TTS] First sentence yielded at +${firstSentenceTime.toFixed(0)}ms: ${sentence.slice(0, 50)}…`);
                }
                sentenceCount++;
                const blob = await this._synthInWorker(sentence, voice);
                if (this._perf && this._perf.firstSynthDoneT === null) {
                    this._perf.firstSynthDoneT = performance.now();
                }
                if (this._ttsTurnKey !== turnKey) return;
                const url = URL.createObjectURL(blob);
                const el = new Audio(url);
                this._ttsAudioQueue.push({ url, audio: el });
                if (this._perf && this._ttsAudioQueue.length > this._perf.queuePeak) {
                    this._perf.queuePeak = this._ttsAudioQueue.length;
                }
                this._ttsPumpQueue();
            }
        } catch (err) {
            if (this._ttsTurnKey !== turnKey) return;
            console.warn("Kokoro streaming failed mid-turn:", err);
            // Fall back to system voice over whatever the bubble holds.
            this._speakSystem(this.activeAssistantBuf || "");
        } finally {
            // Stream consumed to completion (close or break) — drop the
            // splitter reference so the next turn starts fresh. Do not
            // touch the audio queue here; pumpQueue handles draining.
            if (this._ttsTurnKey === turnKey) {
                this._ttsStream = null;
            }
        }
    }

    // Sequential audio player. Each Audio waits for the previous to end
    // before starting, so sentences land in order. Settles the avatar
    // back to idle once the queue drains AND no more sentences are
    // pending from the consumer.
    _ttsPumpQueue() {
        if (this._ttsPlaying) return;
        const next = this._ttsAudioQueue.shift();
        if (!next) return;
        this._ttsPlaying = true;
        if (this.avatar) this.avatar.setState("speaking");
        this.status.innerText = "Speaking.";
        // Perf: track first audio of the turn.
        const isFirstAudioOfTurn = this._perf && this._perf.firstAudioT === null;
        const cleanup = () => {
            try { URL.revokeObjectURL(next.url); } catch (_) {}
            this._ttsPlaying = false;
            if (this.currentAudio === next.audio) this.currentAudio = null;
            if (this._ttsAudioQueue.length > 0) {
                this._ttsPumpQueue();
            } else if (!this._ttsStream && this.avatar && !this.pendingReqId) {
                // Stream is closed and queue is empty — turn is done.
                this.avatar.setState("idle");
                this.status.innerText = "Ready.";
                this._emitTurnPerfSummary();
            }
        };
        if (isFirstAudioOfTurn) {
            next.audio.addEventListener("playing", () => {
                if (this._perf && this._perf.firstAudioT === null) {
                    this._perf.firstAudioT = performance.now();
                }
            }, { once: true });
        }
        next.audio.onended = cleanup;
        next.audio.onerror = cleanup;
        this.currentAudio = next.audio;
        next.audio.play().catch(cleanup);
    }

    // Emit one line per turn with the headline perf numbers. Goes to
    // console.info so the user can copy the numbers into
    // docs/tts-perf.md.
    _emitTurnPerfSummary() {
        if (!this._perf) return;
        const p = this._perf;
        const tFirst = p.firstAudioT !== null
            ? (p.firstAudioT - p.submitT).toFixed(0)
            : "n/a";
        const rates = p.firstSentenceSynthMs
            .map(s => `${(s.ms / s.chars).toFixed(1)}`)
            .join("/");
        const longTask = p.longTaskMax > 0 ? p.longTaskMax.toFixed(0) : "0";
        console.info(
            `[PERF] turn ${p.cold ? "cold" : "warm"} | T-first-audio=${tFirst}ms | synth-ms/char=${rates || "n/a"} | queue-peak=${p.queuePeak} | UI-block-max=${longTask}ms`
        );
        // Variant 3a: stage breakdown of the first-audio latency
        // budget. Each segment is rounded to ms and labelled so we
        // can see at a glance which stage is the long pole. "n/a" if
        // the previous stage's timestamp wasn't recorded (e.g. on
        // error paths).
        const dt = (a, b) => (a !== null && b !== null) ? (b - a).toFixed(0) + "ms" : "n/a";
        console.info(
            `[PERF] stages | submit→ipc=${dt(p.submitT, p.ipcOutT)}` +
            ` ipc→delta=${dt(p.ipcOutT, p.firstDeltaT)}` +
            ` delta→bubble=${dt(p.firstDeltaT, p.firstBubbleCharT)}` +
            ` delta→yield=${dt(p.firstDeltaT, p.firstTtsYieldT)}` +
            ` yield→synth=${dt(p.firstTtsYieldT, p.firstSynthDoneT)}` +
            ` synth→audio=${dt(p.firstSynthDoneT, p.firstAudioT)}`
        );
    }

    // HuggingFace transformers.js progress callback. Emits per-file
    // events with a 0-100 progress field while a model shard streams
    // in. We show one bar per active file; the label updates as files
    // complete. Cached files emit no progress events at all.
    _onTtsProgress(e) {
        if (!this.progressEl || !e) return;
        const file = e.file || "";
        if (e.status === "progress") {
            const pct = Math.max(0, Math.min(100, Number(e.progress) || 0));
            const loaded = Number(e.loaded) || 0;
            const total = Number(e.total) || 0;
            const now = performance.now();
            // Reset speed tracker when the file changes.
            if (this._progFile !== file) {
                this._progFile = file;
                this._progLastT = now;
                this._progLastLoaded = loaded;
                this._progSpeedBps = 0;
            }
            // Sample speed at ~750ms intervals so the readout is stable
            // without lagging real bandwidth changes.
            const dt = (now - this._progLastT) / 1000;
            if (dt >= 0.75) {
                this._progSpeedBps = (loaded - this._progLastLoaded) / dt;
                this._progLastT = now;
                this._progLastLoaded = loaded;
            }
            const speedStr = this._progSpeedBps > 0
                ? ` — ${this._formatBytes(this._progSpeedBps)}/s`
                : "";
            this.progressEl.hidden = false;
            this.progressFill.classList.remove("indeterminate");
            this.progressLabel.innerText =
                `${file} — ${pct.toFixed(0)}%  (${this._formatBytes(loaded)} / ${this._formatBytes(total)})${speedStr}`;
            this.progressFill.style.width = pct.toFixed(1) + "%";
        } else if (e.status === "initiate" || e.status === "download") {
            this.progressEl.hidden = false;
            this.progressLabel.innerText = `${file} — starting…`;
            this._progFile = null;
            this._progSpeedBps = 0;
        } else if (e.status === "done") {
            this.progressFill.classList.remove("indeterminate");
            this.progressLabel.innerText = `${file} — done`;
            this.progressFill.style.width = "100%";
            this._progFile = null;
        } else if (e.status === "ready") {
            this._hideProgress();
        }
    }

    _showProgress(labelText) {
        if (!this.progressEl) return;
        this.progressEl.hidden = false;
        // Indeterminate look for cache hits: a thin fill while we wait
        // for either a real progress event or `ready`/await resolution.
        this.progressLabel.innerText = labelText || "";
        this.progressFill.classList.add("indeterminate");
        this.progressFill.style.width = "30%";
    }

    _hideProgress() {
        if (!this.progressEl) return;
        this.progressEl.hidden = true;
        this.progressFill.classList.remove("indeterminate");
        this.progressFill.style.width = "0%";
        this.progressLabel.innerText = "";
    }

    _refreshTtsConfigDisplay() {
        if (!this.ttsConfigEl) return;
        const voice = (window.settings && window.settings.ttsVoice) || ClaudeChat.TTS_VOICE;
        const dtype = (window.settings && window.settings.ttsDtype) || ClaudeChat.TTS_DTYPE;
        this.ttsConfigEl.innerText = `${voice} / ${dtype}`;
    }

    _formatBytes(n) {
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "?";
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    _speakSystem(text) {
        if (typeof speechSynthesis === "undefined") return;
        try {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            const voices = speechSynthesis.getVoices();
            if (voices.length > 0) u.voice = voices[0];
            u.onstart = () => { if (this.avatar) this.avatar.setState("speaking"); };
            u.onend = () => {
                this.currentUtterance = null;
                if (this.avatar && !this.pendingReqId) this.avatar.setState("idle");
            };
            u.onerror = u.onend;
            this.currentUtterance = u;
            speechSynthesis.speak(u);
        } catch (err) {
            console.warn("TTS failed:", err);
            if (this.avatar) this.avatar.setState("idle");
        }
    }

    _appendUserBubble(text) {
        const el = document.createElement("div");
        el.className = "claudeChat_bubble claudeChat_user";
        el.innerHTML = `<span class="claudeChat_role">USER</span><pre></pre>`;
        el.querySelector("pre").textContent = text;
        this.scrollback.appendChild(el);
        this._scrollToBottom();
    }

    _beginAssistantBubble() {
        const el = document.createElement("div");
        el.className = "claudeChat_bubble claudeChat_assistant pending";
        el.innerHTML = `<span class="claudeChat_role">CLAUDE</span><pre></pre>`;
        this.scrollback.appendChild(el);
        this.activeAssistantBubble = el;
        this.activeAssistantBuf = "";
        this._scrollToBottom();
    }

    _appendAssistantText(text) {
        if (!text) return;
        if (!this.activeAssistantBubble) this._beginAssistantBubble();
        this._pendingChars += text;
        this._ensureStreamTimer();
    }

    _ensureStreamTimer() {
        if (this._streamRaf || !this._pendingChars.length) return;
        const tick = (t) => {
            if (!this.activeAssistantBubble) {
                this._streamRaf = null;
                return;
            }
            const dt = this._streamLastT ? (t - this._streamLastT) : 16;
            this._streamLastT = t;
            // Adaptive reveal rate: aim to drain the current pending
            // buffer within streamHorizonMs. Floors at ~1 char per frame
            // so the typewriter effect is always visible.
            const ratePerMs = Math.max(0.06, this._pendingChars.length / this._streamHorizonMs);
            this._streamCarry += ratePerMs * dt;
            const n = Math.max(1, Math.floor(this._streamCarry));
            this._streamCarry -= n;
            if (n > 0 && this._pendingChars.length > 0) {
                const chunk = this._pendingChars.slice(0, n);
                this._pendingChars = this._pendingChars.slice(n);
                this.activeAssistantBuf += chunk;
                this.activeAssistantBubble.querySelector("pre").textContent = this.activeAssistantBuf;
                this._scrollToBottom();
                if (this._perf && this._perf.firstBubbleCharT === null) {
                    this._perf.firstBubbleCharT = performance.now();
                }
            }
            if (this._pendingChars.length > 0) {
                this._streamRaf = requestAnimationFrame(tick);
            } else {
                this._streamRaf = null;
                this._streamLastT = 0;
                this._streamCarry = 0;
            }
        };
        this._streamLastT = 0;
        this._streamRaf = requestAnimationFrame(tick);
    }

    // Pull sources out of the assistant's text so they don't clutter the
    // bubble. Returns { cleaned, sources: [{ url, label }] }.
    //
    // First we look for a trailing "Sources:" / "References:" /
    // "Citations:" heading and lop off everything from there to end
    // (extracting the URLs in that block into the sources list). Then
    // in what's left, markdown links keep their label visible and bare
    // URLs are removed entirely.
    _extractSources(text) {
        const sources = [];
        let cleaned = text;

        const pushUrl = (url, label) => {
            const trimmed = url.replace(/[.,;:!?)\]]+$/, "");
            // Defence-in-depth: never collect anything that isn't http/https.
            // The regexes that feed this already require https?:// at the
            // start, but an explicit URL parse rejects malformed inputs and
            // makes the safety story easy to audit.
            if (!ClaudeChat._isHttpUrl(trimmed)) return;
            sources.push({ url: trimmed, label: label || trimmed });
        };

        // 1. Trailing sources block. Same regex used by the streaming
        //    TTS filter so the spoken cutoff matches the bubble cutoff.
        const blockMatch = cleaned.match(ClaudeChat.SOURCES_BLOCK_RE);
        if (blockMatch) {
            const block = blockMatch[0];
            // Pull URLs (markdown-link OR bare) out of the trailing block.
            block.replace(ClaudeChat.INLINE_LINK_RE, (_m, label, url) => {
                pushUrl(url, label);
                return "";
            });
            (block.match(ClaudeChat.BARE_URL_RE) || []).forEach(u => pushUrl(u, null));
            cleaned = cleaned.slice(0, blockMatch.index);
        }

        // 2. Markdown links in main body: keep label, capture url.
        cleaned = cleaned.replace(ClaudeChat.INLINE_LINK_RE, (_m, label, url) => {
            pushUrl(url, label);
            return label;
        });

        // 3. Bare URLs in main body: strip and capture.
        cleaned = cleaned.replace(ClaudeChat.BARE_URL_RE, url => {
            pushUrl(url, null);
            return "";
        });

        // 4. Tidy whitespace and dangling-bullet leftovers.
        cleaned = cleaned.replace(/^[ \t]*[-*•]\s*$/gm, "");
        cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

        // 5. Dedupe by URL, keeping the first label seen.
        const seen = new Map();
        sources.forEach(s => { if (!seen.has(s.url)) seen.set(s.url, s); });
        return { cleaned, sources: Array.from(seen.values()) };
    }

    _attachSourcesIcon(bubble, sources) {
        const icon = document.createElement("button");
        icon.className = "claudeChat_sourcesIcon";
        icon.type = "button";
        icon.title = `${sources.length} source${sources.length === 1 ? "" : "s"}`;
        icon.innerHTML = `<span class="claudeChat_sourcesGlyph">🔗</span><span>${sources.length}</span>`;
        icon.addEventListener("click", () => this._showSourcesModal(sources));
        bubble.appendChild(icon);
    }

    _showSourcesModal(sources) {
        const escape = (s) => (window._escapeHtml || (x => x))(String(s));
        const itemsHtml = sources.map((s, i) => {
            const labelDifferent = s.label && s.label !== s.url;
            return `<div class="claudeChat_sourceItem">
                <span class="claudeChat_sourceNum">[${i + 1}]</span>
                <button type="button"
                        class="claudeChat_sourceLink"
                        data-url="${escape(s.url)}"
                        title="${escape(s.url)}">${escape(s.label || s.url)}</button>
                ${labelDifferent ? `<div class="claudeChat_sourceUrl">${escape(s.url)}</div>` : ""}
            </div>`;
        }).join("");
        const modal = new Modal({
            type: "custom",
            title: `SOURCES <i>${sources.length}</i>`,
            html: `<div class="claudeChat_sourcesList">${itemsHtml}</div>`
        }, () => {
            // Restore focus to the chat input so the chat's own Esc/Enter
            // bindings keep working after the sources modal closes.
            if (this.input) { try { this.input.focus(); } catch (_) {} }
        });
        // Wire link buttons after the modal has rendered.
        setTimeout(() => {
            const modalEl = document.getElementById("modal_" + modal.id);
            if (!modalEl) return;
            modalEl.querySelectorAll(".claudeChat_sourceLink").forEach(btn => {
                btn.addEventListener("click", () => {
                    const url = btn.dataset.url;
                    // Re-check the scheme at the call site too — the URL
                    // ultimately originates from model-generated text, so
                    // don't trust that nothing tampered with the DOM
                    // attribute. shell.openExternal will happily launch a
                    // file:// or javascript: handler, so we gate it here.
                    if (!ClaudeChat._isHttpUrl(url)) {
                        console.warn("Refusing to open non-http(s) URL:", url);
                        return;
                    }
                    try { require("electron").shell.openExternal(url); }
                    catch (err) { console.warn("Failed to open URL:", err); }
                });
            });
        }, 0);
    }

    _drainPending() {
        if (this._streamRaf) {
            cancelAnimationFrame(this._streamRaf);
            this._streamRaf = null;
        }
        this._streamLastT = 0;
        this._streamCarry = 0;
        if (this._pendingChars.length > 0 && this.activeAssistantBubble) {
            this.activeAssistantBuf += this._pendingChars;
            this._pendingChars = "";
            this.activeAssistantBubble.querySelector("pre").textContent = this.activeAssistantBuf;
            this._scrollToBottom();
        } else {
            this._pendingChars = "";
        }
    }

    _appendErrorLine(msg) {
        if (!this.activeAssistantBubble) this._beginAssistantBubble();
        const pre = this.activeAssistantBubble.querySelector("pre");
        const prefix = this.activeAssistantBuf.length ? "\n\n" : "";
        this.activeAssistantBuf += `${prefix}[claude error] ${msg}`;
        pre.textContent = this.activeAssistantBuf;
        this.activeAssistantBubble.classList.add("error");
        this._scrollToBottom();
    }

    _finalizeAssistant() {
        if (this._streamRaf) {
            cancelAnimationFrame(this._streamRaf);
            this._streamRaf = null;
        }
        this._pendingChars = "";
        this._streamLastT = 0;
        this._streamCarry = 0;
        if (this.activeAssistantBubble) {
            this.activeAssistantBubble.classList.remove("pending");
        }
        this.activeAssistantBubble = null;
        this.activeAssistantBuf = "";
        this.pendingReqId = null;
    }

    _scrollToBottom() {
        this.scrollback.scrollTop = this.scrollback.scrollHeight;
    }

    _teardown() {
        if (this.pendingReqId) {
            this.ipc.send("claude:cancel", { reqId: this.pendingReqId });
        }
        this._cancelSpeech();
        if (this._ttsWorker) {
            try { this._ttsWorker.terminate(); } catch (_) {}
            this._ttsWorker = null;
            this._ttsWorkerLoadedDtype = null;
            this._ttsSynthPending.clear();
        }
        if (this._longTaskObserver) {
            try { this._longTaskObserver.disconnect(); } catch (_) {}
            this._longTaskObserver = null;
        }
        if (this.avatar) {
            this.avatar.destroy();
            this.avatar = null;
        }
        this.ipc.removeListener("claude:delta", this._onDelta);
        this.ipc.removeListener("claude:done", this._onDone);
        this.ipc.removeListener("claude:error", this._onError);
        this.ipc.removeListener("claude:result", this._onResult);
        this.ipc.removeListener("claude:model", this._onModel);
    }
}

module.exports = { ClaudeChat };
window.ClaudeChat = ClaudeChat;
