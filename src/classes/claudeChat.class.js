// Chat modal that talks to the local `claude -p` CLI via IPC bridge in
// _main_claude.js. One UUIDv4 session ID per modal opening — every turn
// within the same modal reuses it (Claude CLI's --session-id), so context
// carries across turns; closing the modal drops the session.

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
        this._kokoroModule = null;  // lazy-imported kokoro-js namespace
        this._kokoroTts = null;     // cached KokoroTTS instance
        this._kokoroDtype = null;   // dtype the cached instance was loaded with

        // Typewriter-style streaming: buffer raw deltas, then reveal
        // characters on a steady RAF tick so the output reads like a
        // smooth stream instead of token-batch jumps.
        this._pendingChars = "";
        this._streamRaf = null;
        this._streamLastT = 0;
        this._streamCarry = 0;          // sub-char accumulator across frames
        this._streamHorizonMs = 250;    // try to drain the pending buffer within ~250ms

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
            this._appendAssistantText(payload.text || "");
            if (this.avatar && this.avatar.state === "thinking") {
                this.avatar.setState("responding");
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
            if (this.voiceEnabled && spoken.trim().length > 0) {
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

        this._appendUserBubble(prompt);
        this.input.value = "";
        this._beginAssistantBubble();

        this.pendingReqId = `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        this.status.innerText = "Querying claude…";
        if (this.avatar) this.avatar.setState("thinking");
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
        this.voiceToggle.textContent = this.voiceEnabled
            ? `VOICE: ON${this.neuralTtsAvailable ? " (KOKORO)" : ""}`
            : "VOICE: OFF";
        this.voiceToggle.classList.toggle("on", this.voiceEnabled);
        this._refreshTtsConfigDisplay();
        if (!this.voiceEnabled) {
            this._cancelSpeech();
            if (this.avatar && !this.pendingReqId) this.avatar.setState("idle");
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

    async _speakNeural(text) {
        this._cancelSpeech();
        const opId = `tts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        this.currentTtsReq = opId;
        if (this.avatar) this.avatar.setState("speaking");
        const voice = (window.settings && window.settings.ttsVoice) || ClaudeChat.TTS_VOICE;
        const dtype = (window.settings && window.settings.ttsDtype) || ClaudeChat.TTS_DTYPE;
        this._refreshTtsConfigDisplay();
        try {
            // Dtype is baked in at from_pretrained — drop the cached
            // instance when the user picks a different precision so the
            // next call re-loads with the right weights.
            if (this._kokoroTts && this._kokoroDtype !== dtype) {
                this._kokoroTts = null;
                this._kokoroDtype = null;
            }
            if (!this._kokoroTts) {
                this.status.innerText = `Loading Kokoro TTS (${dtype})…`;
                // Show the bar immediately so cache hits (no progress
                // events) still give visible feedback. The label gets
                // overwritten by per-file progress when a real download
                // actually starts.
                this._showProgress(`Loading model (${dtype})…`);
                if (!this._kokoroModule) {
                    // kokoro-js ships a CJS build under its `require` export
                    // condition (dist/kokoro.cjs). Dynamic `import("kokoro-js")`
                    // silently failed in the renderer because the browser-side
                    // ESM resolver does not understand bare specifiers — Kokoro
                    // was falling back to speechSynthesis on every call.
                    // require() resolves through Node and bypasses that.
                    this._kokoroModule = require("kokoro-js");

                    // In the Electron renderer, transformers.node.cjs's
                    // file-system cache trips over its own FileResponse/match
                    // logic and throws "Unable to get model file path or
                    // buffer" on the model file. Force buffer-mode loading by
                    // disabling both caches — slightly slower (re-fetches on
                    // every cold launch) but reliable.
                    try {
                        const transformers = require("@huggingface/transformers");
                        transformers.env.useFSCache = false;
                        transformers.env.useBrowserCache = false;
                    } catch (envErr) {
                        console.warn("Could not configure transformers env:", envErr);
                    }
                }
                this._kokoroTts = await this._kokoroModule.KokoroTTS.from_pretrained(
                    ClaudeChat.TTS_MODEL_ID,
                    { dtype: dtype, progress_callback: (e) => this._onTtsProgress(e) }
                );
                this._hideProgress();
                this._kokoroDtype = dtype;
                this.status.innerText = `Kokoro ready (${dtype}).`;
            }
            if (this.currentTtsReq !== opId) return; // cancelled while loading
            this.status.innerText = "Synthesizing…";
            const rawAudio = await this._kokoroTts.generate(text, {
                voice: voice
            });
            if (this.currentTtsReq !== opId) return; // cancelled mid-synthesis
            this.status.innerText = "Speaking.";
            const wavBlob = rawAudio.toBlob();
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
        if (typeof n !== "number" || !isFinite(n) || n < 0) return "?";
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

        // 1. Trailing sources block. Matches an optional markdown-emphasis
        //    wrapper (#, *, _) around "Sources" / "References" / "Citations",
        //    optional trailing emphasis + colon, and consumes everything to
        //    end of string.
        const blockRe = /\n+\s*(?:[#*_]+\s*)?(?:Sources?|References?|Citations?)\s*(?:[*_]+)?\s*:?\s*\n[\s\S]*$/i;
        const blockMatch = cleaned.match(blockRe);
        if (blockMatch) {
            const block = blockMatch[0];
            // Pull URLs (markdown-link OR bare) out of the trailing block.
            block.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => {
                pushUrl(url, label);
                return "";
            });
            (block.match(/https?:\/\/\S+/g) || []).forEach(u => pushUrl(u, null));
            cleaned = cleaned.slice(0, blockMatch.index);
        }

        // 2. Markdown links in main body: keep label, capture url.
        cleaned = cleaned.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => {
            pushUrl(url, label);
            return label;
        });

        // 3. Bare URLs in main body: strip and capture.
        cleaned = cleaned.replace(/https?:\/\/\S+/g, url => {
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
                    const url = btn.getAttribute("data-url");
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
