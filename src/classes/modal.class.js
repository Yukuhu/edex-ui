window.modals = {};

class Modal {
    // Insertion-ordered stack of open modals — last entry is the topmost
    // and is what Esc closes. close() splices the modal out.
    static _stack = [];

    // Global Esc → close topmost. Wired once on first Modal construction.
    // Stops propagation so per-modal Esc handlers (e.g. ClaudeChat input)
    // don't double-fire.
    static _ensureGlobalEsc() {
        if (Modal._escWired) return;
        Modal._escWired = true;
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            const top = Modal._stack[Modal._stack.length - 1];
            if (!top) return;
            e.preventDefault();
            e.stopPropagation();
            try { top.close(); } catch (_) {}
        }, true); // capture phase so we beat input-level handlers
    }

    constructor(options, onclose) {
        Modal._ensureGlobalEsc();
        if (!options || !options.type) throw "Missing parameters";

        this.type = options.type;
        this.id = require("nanoid").nanoid();
        while (typeof window.modals[this.id] !== "undefined") {
            this.id = require("nanoid")();
        }
        this.title = options.title || options.type || "Modal window";
        this.message = options.message || "Lorem ipsum dolor sit amet.";
        this.onclose = onclose;
        this.classes = "modal_popup";
        let buttons = [];
        let augs = [];
        let zindex = 0;

        // Reserve a slot in window.modals
        window.modals[this.id] = {};

        switch(this.type) {
            case "error":
                this.classes += " error";
                zindex = 1500;
                buttons.push({label:"PANIC", action:"window.modals['"+this.id+"'].close();"}, {label:"RELOAD", action:"window.location.reload(true);"});
                augs.push("tr-clip", "bl-rect", "r-clip");
                break;
            case "warning":
                this.classes += " warning";
                zindex = 1000;
                buttons.push({label:"OK", action:"window.modals['"+this.id+"'].close();"});
                augs.push("bl-clip", "tr-clip", "r-rect", "b-rect");
                break;
            case "custom":
                this.classes += " info custom";
                zindex = 500;
                buttons = options.buttons || [];
                // The auto-added Close button can be hidden via the
                // modalCloseButton setting (default true). Esc still
                // closes the modal regardless — Modal._ensureGlobalEsc
                // is always wired.
                if (window.settings?.modalCloseButton !== false) {
                    buttons.push({label:"Close", action:"window.modals['"+this.id+"'].close();"});
                }
                augs.push("tr-clip", "bl-clip");
                break;
            default:
                this.classes += " info";
                zindex = 500;
                buttons.push({label:"OK", action:"window.modals['"+this.id+"'].close();"});
                augs.push("tr-clip", "bl-clip");
                break;
        }

        let DOMstring = `<div id="modal_${this.id}" class="${this.classes}" style="z-index:${zindex+Object.keys(window.modals).length};" augmented-ui="${augs.join(" ")} exe">
            <h1>${this.title}</h1>
            ${this.type === "custom" ? options.html : "<h5>"+this.message+"</h5>"}
            <div>`;
            buttons.forEach(b => {
                DOMstring += `<button onclick="${b.action}">${b.label}</button>`;
            });
        DOMstring += `</div>
        </div>`;

        this.close = () => {
            // Remove from the stack first so a quick second Esc closes
            // the next one down even during the close animation.
            const stackIdx = Modal._stack.indexOf(this);
            if (stackIdx !== -1) Modal._stack.splice(stackIdx, 1);

            let modalElement = document.getElementById("modal_"+this.id);
            if (modalElement) {
                modalElement.setAttribute("class", "modal_popup "+this.type+" blink");
                window.audioManager.denied.play();
                setTimeout(() => {
                    modalElement.remove();
                    delete window.modals[this.id];
                }, 100);
            } else {
                delete window.modals[this.id];
            }

            if (typeof this.onclose === "function") {
                this.onclose();
            }
        };

        this.focus = () => {
            let modalElement = document.getElementById("modal_"+this.id);
            modalElement.setAttribute("class", this.classes+" focus");
            Object.keys(window.modals).forEach(id => {
                if (id === this.id) return;
                window.modals[id].unfocus();
            });
        };

        this.unfocus = () => {
            let modalElement = document.getElementById("modal_"+this.id);
            modalElement.setAttribute("class", this.classes);
        };

        let tmp = document.createElement("div");
        tmp.innerHTML = DOMstring;
        let element = tmp.firstChild;

        element.addEventListener("mousedown", () => {
            this.focus();
        });
        element.addEventListener("touchstart", () => {
            this.focus();
        });

        switch(this.type) {
            case "error":
                window.audioManager.error.play();
                break;
            case "warning":
                window.audioManager.alarm.play();
                break;
            default:
                window.audioManager.info.play();
                break;
        }
        window.modals[this.id] = this;
        Modal._stack.push(this);
        document.body.appendChild(element);
        this.focus();

        // Allow dragging the modal around
        let draggedModal = document.getElementById(`modal_${this.id}`);
        let dragTarget = document.querySelector(`div#modal_${this.id} > h1:first-child`);

        draggedModal.zindex = draggedModal.getAttribute("style");

        // Wait for correct rendering of medias and such before calculating rect size
        setTimeout(() => {
            let rect = draggedModal.getBoundingClientRect();
            draggedModal.posX = rect.left;
            draggedModal.posY = rect.top;
        }, 500);

        // Mouse
        function modalMousedownHandler(e) {
            draggedModal.lastMouseX = e.clientX;
            draggedModal.lastMouseY = e.clientY;

            draggedModal.setAttribute("style", `${draggedModal.zindex}background: rgba(var(--color_r), var(--color_g), var(--color_b), 0.5);left: ${draggedModal.posX}px;top: ${draggedModal.posY}px;`);

            window.addEventListener("mousemove", modalMousemoveHandler);
            window.addEventListener("mouseup", modalMouseupHandler);
        }
        function modalMousemoveHandler(e) {
            draggedModal.posX = draggedModal.posX + (e.clientX - draggedModal.lastMouseX);
            draggedModal.posY = draggedModal.posY + (e.clientY - draggedModal.lastMouseY);
            draggedModal.lastMouseX = e.clientX;
            draggedModal.lastMouseY = e.clientY;

            draggedModal.setAttribute("style", `${draggedModal.zindex}background: rgba(var(--color_r), var(--color_g), var(--color_b), 0.5);left: ${draggedModal.posX}px;top: ${draggedModal.posY}px;`);
        }
        function modalMouseupHandler(e) {
            window.removeEventListener("mousemove", modalMousemoveHandler);
            draggedModal.setAttribute("style", `${draggedModal.zindex}left: ${draggedModal.posX}px;top: ${draggedModal.posY}px;`);

            window.removeEventListener("mouseup", modalMouseupHandler);
        }
        dragTarget.addEventListener("mousedown", modalMousedownHandler);

        // Touch
        function modalTouchstartHandler(e) {
            draggedModal.lastMouseX = e.changedTouches[0].clientX;
            draggedModal.lastMouseY = e.changedTouches[0].clientY;

            draggedModal.setAttribute("style", `${draggedModal.zindex}background: rgba(var(--color_r), var(--color_g), var(--color_b), 0.5);left: ${draggedModal.posX}px;top: ${draggedModal.posY}px;`);

            window.addEventListener("touchmove", modalTouchmoveHandler);
            window.addEventListener("touchend", modalTouchendHandler);
        }
        function modalTouchmoveHandler(e) {
            draggedModal.posX = draggedModal.posX + (e.changedTouches[0].clientX - draggedModal.lastMouseX);
            draggedModal.posY = draggedModal.posY + (e.changedTouches[0].clientY - draggedModal.lastMouseY);
            draggedModal.lastMouseX = e.changedTouches[0].clientX;
            draggedModal.lastMouseY = e.changedTouches[0].clientY;

            draggedModal.setAttribute("style", `${draggedModal.zindex}background: rgba(var(--color_r), var(--color_g), var(--color_b), 0.5);left: ${draggedModal.posX}px;top: ${draggedModal.posY}px;`);
        }
        function modalTouchendHandler(e) {
            window.removeEventListener("touchmove", modalTouchmoveHandler);
            draggedModal.setAttribute("style", `${draggedModal.zindex}left: ${draggedModal.posX}px;top: ${draggedModal.posY}px;`);

            window.removeEventListener("touchend", modalTouchendHandler);
        }
        dragTarget.addEventListener("touchstart", modalTouchstartHandler);

        return this.id;
    }

    // Fire-and-forget factory. Constructor side-effects (DOM insertion,
    // stack registration) are the actual "work"; this wrapper exists so
    // callers don't have to write `new Modal(...)` at statement level
    // (which trips Sonar S1848). Returns the instance for the rare
    // caller that does want a handle.
    static show(options, onclose) {
        return new Modal(options, onclose);
    }
}

module.exports = {
    Modal
};
