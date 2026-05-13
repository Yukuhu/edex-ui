// Chat modal that talks to the local `claude -p` CLI via IPC bridge in
// _main_claude.js. One UUIDv4 session ID per modal opening — every turn
// within the same modal reuses it (Claude CLI's --session-id), so context
// carries across turns; closing the modal drops the session.
//
// TTS pipeline (Kokoro worker, sentence splitter, audio queue,
// speechSynthesis fallback) lives in src/classes/ttsEngine.class.js
// and is reached here via window.ttsEngine. ClaudeChat retains only
// the chat-shaped streaming wrapper (`_ttsPushTail` slices off URLs
// and the trailing Sources block before pushing into the engine), the
// voice toggle button, and the avatar-state / perf-log listeners.

class ClaudeChat {
    // Forced via --model on every spawn so the chat doesn't inherit
    // whatever the user's Claude Code default happens to be.
    static DEFAULT_MODEL = "claude-haiku-4-5";

    // Kokoro TTS — runs in src/workers/tts-worker.js, owned by
    // window.ttsEngine. The static voice/dtype tables below are still
    // exposed here because the settings editor in _renderer.js reads
    // ClaudeChat.VOICES and ClaudeChat.DTYPES; defaults live on
    // TtsEngine (DEFAULT_VOICE / DEFAULT_DTYPE).

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
        if (window.modals && Object.values(window.modals).some(m => m?._isClaudeChat)) {
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

        // Streaming TTS — the heavy lifting (worker, splitter, queue,
        // playback, fallback) lives in window.ttsEngine. The chat only
        // tracks the slice of the rolling assistant buffer it has
        // already pushed into the engine, plus a one-shot guard so
        // each turn calls beginStream() exactly once.
        this._ttsStreamActive = false;   // a stream has been opened on the engine this turn
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

        const detachKeyboard = (typeof window !== "undefined" && window.keyboard?.detach) ? () => window.keyboard.detach() : () => {};
        const attachKeyboard = (typeof window !== "undefined" && window.keyboard?.attach) ? () => window.keyboard.attach() : () => {};
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

        // Engine → chat UI bindings. Avatar, status line, and the
        // download-progress bar are chat-owned; the engine owns the
        // audio. Stored as a map so _teardown can iterate it once.
        this._engineListeners = {
            speakstart: () => {
                if (this.avatar) this.avatar.setState("speaking");
                this.status.innerText = "Speaking.";
            },
            speakend: () => {
                if (this.avatar && !this.pendingReqId) this.avatar.setState("idle");
                if (!this.pendingReqId) this.status.innerText = "Ready.";
                this._emitTurnPerfSummary();
            },
            loadstart: ev => {
                const dtype = ev.detail?.dtype || "";
                this.status.innerText = `Loading Kokoro TTS (${dtype})…`;
                this._showProgress(`Loading model (${dtype})…`);
            },
            loadready: ev => {
                const { dtype, backend } = ev.detail || {};
                this._hideProgress();
                this.status.innerText = `Kokoro ready (${dtype}, ${backend}).`;
            },
            loaderror: () => { this._hideProgress(); },
            progress: ev => this._onTtsProgress(ev.detail),
            synthsample: ev => {
                const { chars, ms } = ev.detail || {};
                if (!this._perf) return;
                if (this._perf.firstSentenceSynthMs.length < 3 && chars > 0) {
                    this._perf.firstSentenceSynthMs.push({ chars, ms });
                }
                if (this._ttsStreamActive) {
                    const peak = window.ttsEngine.queueSize;
                    if (peak > this._perf.queuePeak) this._perf.queuePeak = peak;
                }
            },
            firstaudio: ev => { if (this._perf?.firstAudioT === null) this._perf.firstAudioT = ev.detail.t; },
            firstsynth: ev => { if (this._perf?.firstSynthDoneT === null) this._perf.firstSynthDoneT = ev.detail.t; },
            firstyield: ev => { if (this._perf?.firstTtsYieldT === null) this._perf.firstTtsYieldT = ev.detail.t; }
        };
        for (const [name, fn] of Object.entries(this._engineListeners)) {
            window.ttsEngine.addEventListener(name, fn);
        }

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
            if (this._perf?.firstDeltaT === null) {
                this._perf.firstDeltaT = performance.now();
            }
            this._appendAssistantText(payload.text || "");
            if (this.avatar?.state === "thinking") {
                this.avatar.setState("responding");
            }
            // Streaming TTS — kick off (idempotent) on the first delta
            // and push the new tail. Cheap; nothing happens unless
            // voice is on AND neural TTS is available.
            if (this.voiceEnabled && window.ttsEngine?.isAvailable) {
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
            const msg = payload?.message ? payload.message : "Unknown error";
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
        const neural = !!window.ttsEngine?.isAvailable;
        const kokoroSuffix = neural ? " (KOKORO)" : "";
        this.voiceToggle.textContent = this.voiceEnabled
            ? `VOICE: ON${kokoroSuffix}`
            : "VOICE: OFF";
        this.voiceToggle.classList.toggle("on", this.voiceEnabled);
        this._refreshTtsConfigDisplay();
        if (!this.voiceEnabled) this._cancelSpeech();
        if (this.voiceEnabled && neural) {
            // Pre-warm the Kokoro pipeline. Model load is the long pole on
            // the first turn of a session — kicking it off here means it's
            // (usually) ready by the time the user submits, so streaming
            // can start synthesizing as soon as the first sentence
            // boundary arrives instead of waiting for the model.
            window.ttsEngine.preload().catch(err => {
                console.warn("Kokoro pre-warm failed:", err);
            });
        }
        if (this.voiceEnabled && !neural && typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices().length === 0) {
            this.status.innerText = "Voice enabled, but no TTS voice is available on this system.";
        }
    }

    _cancelSpeech() {
        if (window.ttsEngine) window.ttsEngine.cancel();
        this._ttsStreamActive = false;
        this._ttsPushedLen = 0;
        this._ttsSourcesReached = false;
    }

    _speak(text) {
        if (window.ttsEngine) window.ttsEngine.speak(text);
    }

    // -------------------------------------------------------------------
    // Streaming TTS — chat-shaped wrapper around window.ttsEngine.
    //
    // `_onDelta` calls `_ttsBegin()` (idempotent) on every delta and
    // `_ttsPushTail()` to forward newly-rendered text. `_ttsBegin`
    // resets the per-turn slice trackers and opens an engine stream;
    // `_ttsPushTail` slices off the trailing Sources block (so URLs
    // don't get read aloud) and pre-strips markdown that fits inside
    // one delta. `_onDone` calls `_ttsFinish()`, which closes the
    // engine stream and lets the audio queue drain. Cancellation
    // (Esc / new prompt / voice off) goes through `_cancelSpeech`,
    // which calls `engine.cancel()` and clears these chat-side fields.

    _ttsBegin() {
        if (this._ttsStreamActive) return;
        if (!this.voiceEnabled || !window.ttsEngine?.isAvailable) return;
        this._ttsStreamActive = true;
        this._ttsPushedLen = 0;
        this._ttsSourcesReached = false;
        this._refreshTtsConfigDisplay();
        window.ttsEngine.beginStream();
    }

    // Push the new tail of `activeAssistantBuf + _pendingChars` into the
    // engine's stream, after stripping URLs and detecting the Sources
    // block. Keeps the spoken cutoff aligned with what `_extractSources`
    // will trim from the bubble at end-of-turn.
    _ttsPushTail() {
        if (this._ttsSourcesReached) return;
        if (!this._ttsStreamActive) return;
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
        // run fits in one delta. The engine's per-sentence pass in
        // _consume catches anything that straddles a delta boundary (#54).
        cleaned = TtsEngine.stripMarkdown(cleaned);
        if (cleaned.length > 0) {
            window.ttsEngine.pushTail(cleaned);
        }
        this._ttsPushedLen = cutoff;
    }

    // Close the engine stream. Returns true if a stream was active so
    // `_onDone` knows to skip the legacy one-shot `_speak(spoken)` path.
    _ttsFinish() {
        if (!this._ttsStreamActive) return false;
        this._ttsPushTail();
        this._ttsStreamActive = false;
        return window.ttsEngine.finishStream();
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
        const voice = window.settings?.ttsVoice || TtsEngine.DEFAULT_VOICE;
        const dtype = window.settings?.ttsDtype || TtsEngine.DEFAULT_DTYPE;
        this.ttsConfigEl.innerText = `${voice} / ${dtype}`;
    }

    _formatBytes(n) {
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "?";
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
                if (this._perf?.firstBubbleCharT === null) {
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
        // The TTS worker is owned by the engine singleton and survives
        // chat close — the next chat session reuses the warm pipeline.
        if (window.ttsEngine && this._engineListeners) {
            for (const [name, fn] of Object.entries(this._engineListeners)) {
                window.ttsEngine.removeEventListener(name, fn);
            }
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
