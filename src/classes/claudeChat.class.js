// Chat modal that talks to the local `claude -p` CLI via IPC bridge in
// _main_claude.js. One UUIDv4 session ID per modal opening — every turn
// within the same modal reuses it (Claude CLI's --session-id), so context
// carries across turns; closing the modal drops the session.

class ClaudeChat {
    // Forced via --model on every spawn so the chat doesn't inherit
    // whatever the user's Claude Code default happens to be.
    static DEFAULT_MODEL = "claude-haiku-4-5";

    // Kokoro TTS — neural, runs fully in the renderer via WASM/ONNX.
    // The model + voice are cached after first use; the model file is
    // ~92 MB (q8 quantization). `af_heart` is the highest-graded voice.
    static TTS_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
    static TTS_DTYPE = "q8";
    static TTS_VOICE = "af_heart";

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
        this.modelName = document.getElementById("claudeChat_modelName");
        this.voiceToggle = document.getElementById("claudeChat_voiceToggle");
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
            if (e.key === "Escape") {
                e.preventDefault();
                window.modals[this.modal.id].close();
            }
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
        try {
            if (!this._kokoroTts) {
                this.status.innerText = "Loading Kokoro TTS (first run downloads ~92 MB)…";
                if (!this._kokoroModule) {
                    // Dynamic ESM import from CJS — same pattern as geolite2-redist 3.x.
                    this._kokoroModule = await import("kokoro-js");
                }
                this._kokoroTts = await this._kokoroModule.KokoroTTS.from_pretrained(
                    ClaudeChat.TTS_MODEL_ID,
                    { dtype: ClaudeChat.TTS_DTYPE }
                );
            }
            if (this.currentTtsReq !== opId) return; // cancelled while loading
            this.status.innerText = "Synthesizing…";
            const rawAudio = await this._kokoroTts.generate(text, {
                voice: ClaudeChat.TTS_VOICE
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
            console.warn("Kokoro TTS failed, falling back to speechSynthesis:", err);
            this.status.innerText = `Kokoro failed (${err && err.message ? err.message : err}); using system voice.`;
            this.neuralTtsAvailable = false; // demote permanently for this session
            if (this.currentTtsReq === opId) this.currentTtsReq = null;
            this._speakSystem(text);
        }
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
