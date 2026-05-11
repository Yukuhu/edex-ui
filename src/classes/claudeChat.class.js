// Chat modal that talks to the local `claude -p` CLI via IPC bridge in
// _main_claude.js. One UUIDv4 session ID per modal opening — every turn
// within the same modal reuses it (Claude CLI's --session-id), so context
// carries across turns; closing the modal drops the session.

class ClaudeChat {
    // Forced via --model on every spawn so the chat doesn't inherit
    // whatever the user's Claude Code default happens to be.
    static DEFAULT_MODEL = "claude-haiku-4-5";

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

        const detachKeyboard = (typeof window !== "undefined" && window.keyboard && window.keyboard.detach) ? () => window.keyboard.detach() : () => {};
        const attachKeyboard = (typeof window !== "undefined" && window.keyboard && window.keyboard.attach) ? () => window.keyboard.attach() : () => {};
        detachKeyboard();

        this.modal = new Modal({
            type: "custom",
            title: `CLAUDE CHAT <i>session ${this.sessionId.slice(0, 8)}</i>`,
            html: `<div class="claudeChat_root">
                    <div class="claudeChat_modelLine" id="claudeChat_modelLine">model: <span id="claudeChat_modelName">${ClaudeChat.DEFAULT_MODEL}</span></div>
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
        };
        this._onDone = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            this._finalizeAssistant();
            this.firstTurn = false;
            this.status.innerText = "Ready.";
        };
        this._onError = (e, payload) => {
            if (!this.pendingReqId || payload.reqId !== this.pendingReqId) return;
            const msg = (payload && payload.message) ? payload.message : "Unknown error";
            this._appendErrorLine(msg);
            this._finalizeAssistant();
            this.status.innerText = "Error.";
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
        this.ipc.send("claude:send", {
            reqId: this.pendingReqId,
            sessionId: this.sessionId,
            firstTurn: this.firstTurn,
            model: this.model,
            prompt
        });
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
        if (!this.activeAssistantBubble) this._beginAssistantBubble();
        this.activeAssistantBuf += text;
        const pre = this.activeAssistantBubble.querySelector("pre");
        pre.textContent = this.activeAssistantBuf;
        this._scrollToBottom();
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
        this.ipc.removeListener("claude:delta", this._onDelta);
        this.ipc.removeListener("claude:done", this._onDone);
        this.ipc.removeListener("claude:error", this._onError);
        this.ipc.removeListener("claude:result", this._onResult);
        this.ipc.removeListener("claude:model", this._onModel);
    }
}

module.exports = { ClaudeChat };
window.ClaudeChat = ClaudeChat;
