class Keyboard {
    // Maps physical-keyboard event codes to the `data-cmd` attribute
    // value of the corresponding on-screen key. Used by `findKey` to
    // animate the right on-screen element when a physical key is
    // pressed. `Enter` is special-cased in `findKey` because it maps
    // to multiple elements via querySelectorAll.
    //
    // The arrow / Escape / Backspace values are the raw control bytes
    // that the on-screen keyboard layout JSON also uses (and the
    // terminal expects on stdin) — `\x1B` is ESC, `\x08` is BS. The
    // pre-fork source had these as invisible bytes inline; using the
    // escape form keeps them visible in the diff and in editors.
    static KEY_CODE_TO_DATA_CMD = {
        "ShiftLeft":    "ESCAPED|-- SHIFT: LEFT",
        "ShiftRight":   "ESCAPED|-- SHIFT: RIGHT",
        "ControlLeft":  "ESCAPED|-- CTRL: LEFT",
        "ControlRight": "ESCAPED|-- CTRL: RIGHT",
        "AltLeft":      "ESCAPED|-- FN: ON",
        "AltRight":     "ESCAPED|-- ALT: RIGHT",
        "CapsLock":     "ESCAPED|-- CAPSLCK: ON",
        "Escape":       "\x1B",
        "Backspace":    "\x08",
        "ArrowUp":      "\x1BOA",
        "ArrowLeft":    "\x1BOD",
        "ArrowDown":    "\x1BOB",
        "ArrowRight":   "\x1BOC"
    };

    constructor(opts) {
        if (!opts.layout || !opts.container) throw "Missing options";

        const layout = JSON.parse(require("node:fs").readFileSync(opts.layout, {encoding: "utf-8"}));
        this.ctrlseq = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
        this.container = document.getElementById(opts.container);

        this.linkedToTerm = true;
        this.detach = () => {
            this.linkedToTerm = false;
        };
        this.attach = () => {
            this.linkedToTerm = true;
        };

        // Set default keyboard properties
        this.container.dataset.isShiftOn = false;
        this.container.dataset.isCapsLckOn = false;
        this.container.dataset.isAltOn = false;
        this.container.dataset.isCtrlOn = false;
        this.container.dataset.isFnOn = false;

        this.container.dataset.passwordMode = false;

        // Build arrays for enabling keyboard shortcuts
        this._shortcuts = {
            CtrlAltShift: [],
            CtrlAlt: [],
            CtrlShift: [],
            AltShift: [],
            Ctrl: [],
            Alt: [],
            Shift: []
        };
        window.shortcuts.forEach(scut => {
            let cut = { ...scut };
            let mods = cut.trigger.split("+");
            cut.trigger = mods.pop();

            let order = ["Ctrl", "Alt", "Shift"];
            mods.sort((a, b) => {
                return order.indexOf(a) - order.indexOf(b);
            });

            let cat = mods.join("");
            
            if (cut.type === "app" && cut.action === "TAB_X" && cut.trigger === "X") {
                for (let i = 1; i <= 5; i++) {
                    let ncut = { ...cut };
                    ncut.trigger = `${i}`;
                    ncut.action = `TAB_${i}`;
                    this._shortcuts[cat].push(ncut);
                }
            } else {
                this._shortcuts[cat].push(cut);
            }
        });

        // Parse keymap and create DOM
        Object.keys(layout).forEach(row => {
            this.container.innerHTML += `<div class="keyboard_row" id="`+row+`"></div>`;
            layout[row].forEach(keyObj => {

                let key = document.createElement("div");
                key.setAttribute("class", "keyboard_key");

                if (keyObj.cmd === " ") {
                    key.setAttribute("id", "keyboard_spacebar");
                } else if (keyObj.cmd === "\r") {
                    key.setAttribute("class", "keyboard_key keyboard_enter");
                    key.innerHTML = `<h1>${keyObj.name}</h1>`;
                } else {
                    key.innerHTML = `
                        <h5>${keyObj.altshift_name || ""}</h5>
                        <h4>${keyObj.fn_name || ""}</h4>
                        <h3>${keyObj.alt_name || ""}</h3>
                        <h2>${keyObj.shift_name || ""}</h2>
                        <h1>${keyObj.name || ""}</h1>`;
                }

                // Icon support, overrides previously defined innerHTML
                // Arrow and other icons
                let icon = null;
                if (keyObj.name.startsWith("ESCAPED|-- ICON: ")) {
                    keyObj.name = keyObj.name.substr(17);
                    switch(keyObj.name) {
                        case "ARROW_UP":
                            icon = `<svg viewBox="0 0 24.00 24.00"><path fill-opacity="1" d="m12.00004 7.99999 4.99996 5h-2.99996v4.00001h-4v-4.00001h-3z"/><path stroke-linejoin="round" fill-opacity="0.65" d="m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"/></svg>`;
                            break;
                        case "ARROW_LEFT":
                            icon = `<svg viewBox="0 0 24.00 24.00"><path fill-opacity="1" d="m7.500015 12.499975 5-4.99996v2.99996h4.00001v4h-4.00001v3z"/><path stroke-linejoin="round" fill-opacity="0.65" d="m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"/></svg>`;
                            break;
                        case "ARROW_DOWN":
                            icon = `<svg viewBox="0 0 24.00 24.00"><path fill-opacity="1" d="m12 17-4.99996-5h2.99996v-4.00001h4v4.00001h3z"/><path stroke-linejoin="round" fill-opacity="0.65" d="m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"/></svg>`;
                            break;
                        case "ARROW_RIGHT":
                            icon = `<svg viewBox="0 0 24.00 24.00"><path fill-opacity="1" d="m16.500025 12.500015-5 4.99996v-2.99996h-4.00001v-4h4.00001v-3z"/><path stroke-linejoin="round" fill-opacity="0.65" d="m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"/></svg>`;
                            break;
                        default:
                            icon = `<svg viewBox="0 0 24.00 24.00"><path fill="#ff0000" fill-opacity="1" d="M 8.27125,2.9978L 2.9975,8.27125L 2.9975,15.7275L 8.27125,21.0012L 15.7275,21.0012C 17.485,19.2437 21.0013,15.7275 21.0013,15.7275L 21.0013,8.27125L 15.7275,2.9978M 9.10125,5L 14.9025,5L 18.9988,9.10125L 18.9988,14.9025L 14.9025,18.9988L 9.10125,18.9988L 5,14.9025L 5,9.10125M 9.11625,7.705L 7.705,9.11625L 10.5912,12.0025L 7.705,14.8825L 9.11625,16.2937L 12.0025,13.4088L 14.8825,16.2937L 16.2938,14.8825L 13.4087,12.0025L 16.2938,9.11625L 14.8825,7.705L 12.0025,10.5913"/></svg>`;
                    }

                    key.innerHTML = icon;
                }

                Object.keys(keyObj).forEach(property => {
                    for (let i = 1; i < this.ctrlseq.length; i++) {
                        keyObj[property] = keyObj[property].replace("~~~CTRLSEQ"+i+"~~~", this.ctrlseq[i]);
                    }
                    if (property.endsWith("cmd")) {
                        key.dataset[property] = keyObj[property];
                    }
                });

                document.getElementById(row).appendChild(key);
            });
        });

        // Hoisted outside the per-key loop so we don't re-query the DOM
        // for every key — the .keyboard_enter NodeList is stable from
        // here on.
        const enterElements = document.querySelectorAll(".keyboard_enter");
        this.container.childNodes.forEach(row => {
            row.childNodes.forEach(key => {
                if (this._isEnterKey(key)) {
                    this._wireEnterKeyHandlers(key, enterElements);
                } else {
                    this._wireRegularKeyHandlers(key);
                }

                // See #229
                key.onmouseleave = () => {
                    clearTimeout(key.holdTimeout);
                    clearInterval(key.holdInterval);
                };
            });
        });

        // Tactile multi-touch support (#100)
        this.container.addEventListener("touchstart", e => {
            e.preventDefault();
            for (let i = 0; i < e.changedTouches.length; i++) {
                let key = e.changedTouches[i].target.parentElement;
                if (key.tagName === 'svg') key = key.parentElement;
                if (key.getAttribute("class").startsWith("keyboard_key")) {
                    key.setAttribute("class", key.getAttribute("class")+" active");
                    key.onmousedown({preventDefault: () => {return true}});
                } else {
                    key = e.changedTouches[i].target;
                    if (key.getAttribute("class").startsWith("keyboard_key")) {
                        key.setAttribute("class", key.getAttribute("class")+" active");
                        key.onmousedown({preventDefault: () => {return true}});
                    }
                }
            }
        });
        let dropKeyTouchHandler = e => {
            e.preventDefault();
            for (let i = 0; i < e.changedTouches.length; i++) {
                let key = e.changedTouches[i].target.parentElement;
                if (key.tagName === 'svg') key = key.parentElement;
                if (key.getAttribute("class").startsWith("keyboard_key")) {
                    key.setAttribute("class", key.getAttribute("class").replace("active", ""));
                    key.onmouseup({preventDefault: () => {return true}});
                } else {
                    key = e.changedTouches[i].target;
                    if (key.getAttribute("class").startsWith("keyboard_key")) {
                        key.setAttribute("class", key.getAttribute("class").replace("active", ""));
                        key.onmouseup({preventDefault: () => {return true}});
                    }
                }
            }
        };
        this.container.addEventListener("touchend", dropKeyTouchHandler);
        this.container.addEventListener("touchcancel", dropKeyTouchHandler);

        // Bind actual keyboard actions to on-screen animations (for use without a touchscreen)
        let findKey = e => {
            // Fix incorrect querySelector error
            const physkey = (e.key === "\"") ? `\\"` : e.key;

            // Find basic keys (typically letters, upper and lower-case)
            let key = document.querySelector('div.keyboard_key[data-cmd="'+physkey+'"]');
            if (key === null) key = document.querySelector('div.keyboard_key[data-shift_cmd="'+physkey+'"]');

            // Find special keys (shift, control, arrows, etc.) via lookup table.
            if (key === null) {
                const specialCmd = Keyboard.KEY_CODE_TO_DATA_CMD[e.code];
                if (specialCmd !== undefined) {
                    key = document.querySelector('div.keyboard_key[data-cmd="' + specialCmd + '"]');
                } else if (e.code === "Enter") {
                    key = document.querySelectorAll('div.keyboard_key.keyboard_enter');
                }
            }

            // Find "rare" keys (ctrl and alt symbols)
            if (key === null) key = document.querySelector('div.keyboard_key[data-ctrl_cmd="'+e.key+'"]');
            if (key === null) key = document.querySelector('div.keyboard_key[data-alt_cmd="'+e.key+'"]');

            return key;
        };

        this.keydownHandler = e => {
            // See #330
            if (e.getModifierState("AltGraph") && e.code === "AltRight") {
                document.querySelector('div.keyboard_key[data-cmd="ESCAPED|-- CTRL: LEFT"]').setAttribute("class", "keyboard_key");
            }

            // See #440
            if (e.code === "ControlLeft" || e.code === "ControlRight") this.container.dataset.isCtrlOn = true;
            if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.container.dataset.isShiftOn = true;
            if (e.code === "AltLeft" || e.code === "AltRight") this.container.dataset.isAltOn = true;
            if (e.code === "CapsLock" && this.container.dataset.isCapsLckOn !== "true") this.container.dataset.isCapsLckOn = true;
            if (e.code === "CapsLock" && this.container.dataset.isCapsLckOn === "true") this.container.dataset.isCapsLckOn = false;

            let key = findKey(e);
            if (key === null) return;
            if (key.length) {
                key.forEach(enterElement => {
                    enterElement.setAttribute("class", "keyboard_key active keyboard_enter");
                });
            } else {
                key.setAttribute("class", "keyboard_key active");
            }

            // See #516
            if (this._shouldPlayTypingSound(e)) {
                window.audioManager.stdin.play();
            }
        };

        document.onkeydown = this.keydownHandler;

        document.onkeyup = e => {
            // See #330
            if (e.key === "Control" && e.getModifierState("AltGraph")) return;

            // See #440
            if (e.code === "ControlLeft" || e.code === "ControlRight") this.container.dataset.isCtrlOn = false;
            if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.container.dataset.isShiftOn = false;
            if (e.code === "AltLeft" || e.code === "AltRight") this.container.dataset.isAltOn = false;

            let key = findKey(e);
            if (key === null) return;
            if (key.length) {
                key.forEach(enterElement => {
                    enterElement.setAttribute("class", "keyboard_key blink keyboard_enter");
                });
                setTimeout(() => {
                    key.forEach(enterElement => {
                        enterElement.setAttribute("class", "keyboard_key keyboard_enter");
                    });
                }, 100);
            } else {
                key.setAttribute("class", "keyboard_key blink");
                setTimeout(() => {
                    key.setAttribute("class", "keyboard_key");
                }, 100);
            }

            if(this.container.dataset.passwordMode == "false" && e.key === "Enter")
                window.audioManager.granted.play();
        };

        window.addEventListener("blur", () => {
            document.querySelectorAll("div.keyboard_key.active").forEach(key => {
                key.setAttribute("class", key.getAttribute("class").replace("active", ""));
                key.onmouseup({preventDefault: () => {return true}});
            });
        });
    }
    static DEAD_KEY_TRANSFORMS = [
        { flag: "isNextCircum",   method: "addCircum" },
        { flag: "isNextTrema",    method: "addTrema" },
        { flag: "isNextAcute",    method: "addAcute" },
        { flag: "isNextGrave",    method: "addGrave" },
        { flag: "isNextCaron",    method: "addCaron" },
        { flag: "isNextBar",      method: "addBar" },
        { flag: "isNextBreve",    method: "addBreve" },
        { flag: "isNextTilde",    method: "addTilde" },
        { flag: "isNextMacron",   method: "addMacron" },
        { flag: "isNextCedilla",  method: "addCedilla" },
        { flag: "isNextOverring", method: "addOverring" },
        { flag: "isNextGreek",    method: "toGreek" },
        { flag: "isNextIotasub",  method: "addIotasub" }
    ];

    static ESCAPED_CMD_HANDLERS = {
        "CAPSLCK: ON":  { flag: "isCapsLckOn",   value: "true" },
        "CAPSLCK: OFF": { flag: "isCapsLckOn",   value: "false" },
        "FN: ON":       { flag: "isFnOn",        value: "true" },
        "FN: OFF":      { flag: "isFnOn",        value: "false" },
        "CIRCUM":       { flag: "isNextCircum",  value: "true" },
        "TREMA":        { flag: "isNextTrema",   value: "true" },
        "ACUTE":        { flag: "isNextAcute",   value: "true" },
        "GRAVE":        { flag: "isNextGrave",   value: "true" },
        "CARON":        { flag: "isNextCaron",   value: "true" },
        "BAR":          { flag: "isNextBar",     value: "true" },
        "BREVE":        { flag: "isNextBreve",   value: "true" },
        "TILDE":        { flag: "isNextTilde",   value: "true" },
        "MACRON":       { flag: "isNextMacron",  value: "true" },
        "CEDILLA":      { flag: "isNextCedilla", value: "true" },
        "OVERRING":     { flag: "isNextOverring",value: "true" },
        "GREEK":        { flag: "isNextGreek",   value: "true" },
        "IOTASUB":      { flag: "isNextIotasub", value: "true" }
    };

    pressKey(key) {
        let cmd = key.dataset.cmd || "";
        if (this._dispatchKeyboardShortcut(cmd)) return;
        cmd = this._applyModifierCmd(key, cmd);
        cmd = this._applyPendingDeadKey(cmd);

        // `ESCAPED|-- X` commands always have their prefix stripped
        // first. If X is a known dataset-flag mutation, fire it and
        // short-circuit. If not, fall through and write the bare X
        // (preserves the original behavior where unknown escaped
        // commands still emit their stripped payload).
        if (cmd.startsWith("ESCAPED|-- ")) {
            cmd = cmd.substr(11);
            if (this._tryHandleEscapedCommand(cmd)) return true;
        }
        return this._writeCmd(cmd);
    }

    // Builds the "Ctrl"/"Alt"/"Shift" concatenation key that indexes
    // into `this._shortcuts` based on which modifier dataset flags
    // are currently set on the on-screen keyboard.
    _currentShortcutCat() {
        let cat = "";
        if (this.container.dataset.isCtrlOn === "true") cat += "Ctrl";
        if (this.container.dataset.isAltOn === "true") cat += "Alt";
        if (this.container.dataset.isShiftOn === "true") cat += "Shift";
        return cat;
    }

    // Normalizes a shortcut trigger string from shortcuts.json so the
    // string-equality comparison against the rendered `cmd` works.
    _normalizeTrigger(trig) {
        return trig.toLowerCase()
            .replace("plus", "+")
            .replace("space", " ")
            .replace("tab", "\t")
            .replace(/backspace|delete/, "\b")
            // Order matters: /esc|escape/ would match the "esc" prefix
            // first and leave "ape" trailing — anchor + put the longer
            // alternative first so "escape" matches whole.
            .replace(/escape|esc/, this.ctrlseq[1])
            .replace(/return|enter/, "\r");
    }

    // Iterate the shortcut bucket matching the current modifier state.
    // Returns true if an app-type shortcut fired (caller short-circuits
    // and does NOT write the cmd). Shell-type shortcuts still write
    // their command into the terminal but do not short-circuit the
    // caller — preserving the original behavior.
    _dispatchKeyboardShortcut(cmd) {
        const cat = this._currentShortcutCat();
        if (cat.length <= 1) return false;
        let triggered = false;
        this._shortcuts[cat].forEach(cut => {
            if (!cut.enabled) return;
            if (cmd !== this._normalizeTrigger(cut.trigger)) return;
            if (cut.type === "app") {
                window.useAppShortcut(cut.action);
                triggered = true;
            } else if (cut.type === "shell") {
                // Bare `writelr`/`write` in the pre-fork source were a
                // long-standing typo — those identifiers aren't defined
                // anywhere (they're methods on the Terminal instance).
                // The sibling shortcut dispatcher in _renderer.js used
                // the string form correctly. The branch was dead in
                // practice (no default shell-type shortcut matches the
                // gated modifier combos), so the ReferenceError that
                // would have fired never did.
                const fn = cut.linebreak ? "writelr" : "write";
                window.term[window.currentTerm][fn](cut.action);
            } else {
                console.warn(`${cut.trigger} has unknown type`);
            }
        });
        return triggered;
    }

    // Apply the modifier-key cmd swap. Shift / CapsLock both swap to
    // `shift_cmd`; CapsLock additionally to `capslck_cmd`; Ctrl/Alt/Fn
    // to their respective dataset attrs; Alt+Shift overrides with
    // `altshift_cmd`. Preserves the original precedence order.
    _applyModifierCmd(key, cmd) {
        const d = this.container.dataset;
        if (d.isShiftOn === "true" && key.dataset.shift_cmd || d.isCapsLckOn === "true" && key.dataset.shift_cmd) cmd = key.dataset.shift_cmd;
        if (d.isCapsLckOn === "true" && key.dataset.capslck_cmd) cmd = key.dataset.capslck_cmd;
        if (d.isCtrlOn === "true" && key.dataset.ctrl_cmd) cmd = key.dataset.ctrl_cmd;
        if (d.isAltOn === "true" && key.dataset.alt_cmd) cmd = key.dataset.alt_cmd;
        if (d.isAltOn === "true" && d.isShiftOn === "true" && key.dataset.altshift_cmd) cmd = key.dataset.altshift_cmd;
        if (d.isFnOn === "true" && key.dataset.fn_cmd) cmd = key.dataset.fn_cmd;
        return cmd;
    }

    // Apply any pending dead-key transform (circumflex, diaeresis,
    // acute, grave, …) to `cmd` and clear the flag. Table-driven —
    // each entry pairs the dataset flag with the transform method.
    // Note: this incidentally fixes a typo from the original inlined
    // sequence where `isNextCedilla` was reset to "true" instead of
    // "false", leaving the cedilla transform sticky.
    _applyPendingDeadKey(cmd) {
        const d = this.container.dataset;
        for (const t of Keyboard.DEAD_KEY_TRANSFORMS) {
            if (d[t.flag] === "true") {
                cmd = this[t.method](cmd);
                d[t.flag] = "false";
            }
        }
        return cmd;
    }

    // Try to handle a prefix-stripped ESCAPED command (e.g. "CIRCUM",
    // "CAPSLCK: ON") by flipping the matching dataset flag. Caller
    // strips the "ESCAPED|-- " prefix before calling. Returns true
    // on a hit so the caller can short-circuit.
    _tryHandleEscapedCommand(cmd) {
        const handler = Keyboard.ESCAPED_CMD_HANDLERS[cmd];
        if (!handler) return false;
        this.container.dataset[handler.flag] = handler.value;
        return true;
    }

    // Dispatch the final cmd to the active output: terminal (when
    // `linkedToTerm`) or the active DOM element. Newline is special-
    // cased so it routes to `writelr` / a synthetic "change" event.
    _writeCmd(cmd) {
        if (cmd === "\n") {
            if (window.keyboard.linkedToTerm) {
                window.term[window.currentTerm].writelr("");
            } else {
                document.activeElement.dispatchEvent(new CustomEvent("change", {detail: "enter" }));
            }
            return true;
        }
        if (window.keyboard.linkedToTerm) {
            window.term[window.currentTerm].write(cmd);
            return;
        }
        this._writeCmdToActiveElement(cmd);
    }

    // Cmd writing for the non-terminal path (e.g. focus on a textarea
    // or input). Handles arrow-key cursor movement and backspace
    // explicitly; suppresses any other control sequence; appends
    // plain text. The case labels here use the raw control-byte
    // strings the layout emits (BS = \x08, ESC+OD / ESC+OC for the
    // arrow keys).
    _writeCmdToActiveElement(cmd) {
        let isDelete = false;
        if (typeof document.activeElement.value !== "undefined") {
            // Case labels here use the raw control bytes that the
            // on-screen layout JSON emits; \x08 = backspace, \x1B = ESC.
            // Escape forms (vs literal invisible bytes in source) are
            // used so the intent is visible in diffs and editors.
            switch(cmd) {
                case "\x08":
                    document.activeElement.value = document.activeElement.value.slice(0, -1);
                    isDelete = true;
                    break;
                case "\x1BOD":
                    document.activeElement.selectionStart--;
                    document.activeElement.selectionEnd = document.activeElement.selectionStart;
                    break;
                case "\x1BOC":
                    document.activeElement.selectionEnd++;
                    document.activeElement.selectionStart = document.activeElement.selectionEnd;
                    break;
                default:
                    if (this.ctrlseq.indexOf(cmd.slice(0, 1)) !== -1) {
                        // Prevent trying to write other control sequences
                    } else {
                        document.activeElement.value = document.activeElement.value+cmd;
                    }
            }
        }
        // Emulate oninput events
        document.activeElement.dispatchEvent(new CustomEvent("input", {detail: ((isDelete)? "delete" : "insert") }));
        document.activeElement.focus();
    }
    togglePasswordMode() {
        const d = (this.container.dataset.passwordMode === "true") ? "false" : "true";
        this.container.dataset.passwordMode = d;
        window.passwordMode = d;
        return d;
    }

    // Whether keydown should play the typing tick. Silent in password
    // mode, and on repeats of pure-modifier keys (#516: Shift/Alt/Ctrl/
    // Caps held down doesn't tick once per OS repeat). Mirrors the
    // original strict `=== true` / `=== false` checks so non-boolean
    // `e.repeat` values fall through to "don't play" exactly as before.
    _shouldPlayTypingSound(e) {
        if (this.container.dataset.passwordMode !== "false") return false;
        if (e.repeat === false) return true;
        if (e.repeat !== true) return false;
        return !e.code.startsWith("Shift")
            && !e.code.startsWith("Alt")
            && !e.code.startsWith("Control")
            && !e.code.startsWith("Caps");
    }

    // True when `key` is one of the two DOM elements that make up the
    // visually-split Enter key. The class string ends with
    // "keyboard_enter" for both halves.
    _isEnterKey(key) {
        return key.attributes["class"].value.endsWith("keyboard_enter");
    }

    // Wire mousedown/mouseup for the split Enter key. Both halves
    // animate together via `enterElements`.
    _wireEnterKeyHandlers(key, enterElements) {
        key.onmousedown = e => {
            this.pressKey(key);
            key.holdTimeout = setTimeout(() => {
                key.holdInterval = setInterval(() => {
                    this.pressKey(key);
                }, 70);
            }, 400);

            enterElements.forEach(enterEl => {
                enterEl.setAttribute("class", "keyboard_key active keyboard_enter");
            });

            // Keep focus on the terminal
            if (window.keyboard.linkedToTerm) window.term[window.currentTerm].term.focus();
            if (this.container.dataset.passwordMode == "false")
                window.audioManager.granted.play();
            e.preventDefault();
        };
        key.onmouseup = () => {
            clearTimeout(key.holdTimeout);
            clearInterval(key.holdInterval);

            enterElements.forEach(enterEl => {
                enterEl.setAttribute("class", "keyboard_key blink keyboard_enter");
            });
            setTimeout(() => {
                enterElements.forEach(enterEl => {
                    enterEl.setAttribute("class", "keyboard_key keyboard_enter");
                });
            }, 100);
        };
    }

    // Wire mousedown/mouseup for everything that isn't the Enter key.
    // Modifier keys (CTRL/SHIFT/ALT) flip dataset state on press/release;
    // regular keys press through (with hold-to-repeat after 400ms).
    _wireRegularKeyHandlers(key) {
        key.onmousedown = e => {
            if (/^ESCAPED\|-- (CTRL|SHIFT|ALT){1}.*/.test(key.dataset.cmd)) {
                let cmd = key.dataset.cmd.substr(11);
                if (cmd.startsWith("CTRL")) {
                    this.container.dataset.isCtrlOn = "true";
                }
                if (cmd.startsWith("SHIFT")) {
                    this.container.dataset.isShiftOn = "true";
                }
                if (cmd.startsWith("ALT")) {
                    this.container.dataset.isAltOn = "true";
                }
            } else {
                key.holdTimeout = setTimeout(() => {
                    key.holdInterval = setInterval(() => {
                        this.pressKey(key);
                    }, 70);
                }, 400);
                this.pressKey(key);
            }

            // Keep focus on the terminal
            if (window.keyboard.linkedToTerm) window.term[window.currentTerm].term.focus();
            if(this.container.dataset.passwordMode == "false")
                window.audioManager.stdin.play();
            e.preventDefault();
        };
        key.onmouseup = e => {
            if (/^ESCAPED\|-- (CTRL|SHIFT|ALT){1}.*/.test(key.dataset.cmd)) {
                let cmd = key.dataset.cmd.substr(11);
                if (cmd.startsWith("CTRL")) {
                    this.container.dataset.isCtrlOn = "false";
                }
                if (cmd.startsWith("SHIFT")) {
                    this.container.dataset.isShiftOn = "false";
                }
                if (cmd.startsWith("ALT")) {
                    this.container.dataset.isAltOn = "false";
                }
            } else {
                clearTimeout(key.holdTimeout);
                clearInterval(key.holdInterval);
            }

            key.setAttribute("class", "keyboard_key blink");
            setTimeout(() => {
                key.setAttribute("class", "keyboard_key");
            }, 100);
        };
    }
    static CIRCUM_MAP = {
        "a": "â",
        "A": "Â",
        "z": "ẑ",
        "Z": "Ẑ",
        "e": "ê",
        "E": "Ê",
        "y": "ŷ",
        "Y": "Ŷ",
        "u": "û",
        "U": "Û",
        "i": "î",
        "I": "Î",
        "o": "ô",
        "O": "Ô",
        "s": "ŝ",
        "S": "Ŝ",
        "g": "ĝ",
        "G": "Ĝ",
        "h": "ĥ",
        "H": "Ĥ",
        "j": "ĵ",
        "J": "Ĵ",
        "w": "ŵ",
        "W": "Ŵ",
        "c": "ĉ",
        "C": "Ĉ",
        "1": "¹",
        "2": "²",
        "3": "³",
        "4": "⁴",
        "5": "⁵",
        "6": "⁶",
        "7": "⁷",
        "8": "⁸",
        "9": "⁹",
        "0": "⁰",
    };
    addCircum(char) {
        return Keyboard.CIRCUM_MAP[char] ?? char;
    }
    static TREMA_MAP = {
        "a": "ä",
        "A": "Ä",
        "e": "ë",
        "E": "Ë",
        "t": "ẗ",
        "y": "ÿ",
        "Y": "Ÿ",
        "u": "ü",
        "U": "Ü",
        "i": "ï",
        "I": "Ï",
        "o": "ö",
        "O": "Ö",
        "h": "ḧ",
        "H": "Ḧ",
        "w": "ẅ",
        "W": "Ẅ",
        "x": "ẍ",
        "X": "Ẍ",
    };
    addTrema(char) {
        return Keyboard.TREMA_MAP[char] ?? char;
    }
    static ACUTE_MAP = {
        "a": "á",
        "A": "Á",
        "c": "ć",
        "C": "Ć",
        "e": "é",
        "E": "E",
        "g": "ǵ",
        "G": "Ǵ",
        "i": "í",
        "I": "Í",
        "j": "ȷ́",
        "J": "J́",
        "k": "ḱ",
        "K": "Ḱ",
        "l": "ĺ",
        "L": "Ĺ",
        "m": "ḿ",
        "M": "Ḿ",
        "n": "ń",
        "N": "Ń",
        "o": "ó",
        "O": "Ó",
        "p": "ṕ",
        "P": "Ṕ",
        "r": "ŕ",
        "R": "Ŕ",
        "s": "ś",
        "S": "Ś",
        "u": "ú",
        "U": "Ú",
        "v": "v́",
        "V": "V́",
        "w": "ẃ",
        "W": "Ẃ",
        "y": "ý",
        "Y": "Ý",
        "z": "ź",
        "Z": "Ź",
        "ê": "ế",
        "Ê": "Ế",
        "ç": "ḉ",
        "Ç": "Ḉ",
    };
    addAcute(char) {
        return Keyboard.ACUTE_MAP[char] ?? char;
    }
    static GRAVE_MAP = {
        "a": "à",
        "A": "À",
        "e": "è",
        "E": "È",
        "i": "ì",
        "I": "Ì",
        "m": "m̀",
        "M": "M̀",
        "n": "ǹ",
        "N": "Ǹ",
        "o": "ò",
        "O": "Ò",
        "u": "ù",
        "U": "Ù",
        "v": "v̀",
        "V": "V̀",
        "w": "ẁ",
        "W": "Ẁ",
        "y": "ỳ",
        "Y": "Ỳ",
        "ê": "ề",
        "Ê": "Ề",
    };
    addGrave(char) {
        return Keyboard.GRAVE_MAP[char] ?? char;
    }
    static CARON_MAP = {
        "a": "ǎ",
        "A": "Ǎ",
        "c": "č",
        "C": "Č",
        "d": "ď",
        "D": "Ď",
        "e": "ě",
        "E": "Ě",
        "g": "ǧ",
        "G": "Ǧ",
        "h": "ȟ",
        "H": "Ȟ",
        "i": "ǐ",
        "I": "Ǐ",
        "j": "ǰ",
        "k": "ǩ",
        "K": "Ǩ",
        "l": "ľ",
        "L": "Ľ",
        "n": "ň",
        "N": "Ň",
        "o": "ǒ",
        "O": "Ǒ",
        "r": "ř",
        "R": "Ř",
        "s": "š",
        "S": "Š",
        "t": "ť",
        "T": "Ť",
        "u": "ǔ",
        "U": "Ǔ",
        "z": "ž",
        "Z": "Ž",
        "1": "₁",
        "2": "₂",
        "3": "₃",
        "4": "₄",
        "5": "₅",
        "6": "₆",
        "7": "₇",
        "8": "₈",
        "9": "₉",
        "0": "₀",
    };
    addCaron(char) {
        return Keyboard.CARON_MAP[char] ?? char;
    }
    static BAR_MAP = {
        "a": "ⱥ",
        "A": "Ⱥ",
        "b": "ƀ",
        "B": "Ƀ",
        "c": "ȼ",
        "C": "Ȼ",
        "d": "đ",
        "D": "Đ",
        "e": "ɇ",
        "E": "Ɇ",
        "g": "ǥ",
        "G": "Ǥ",
        "h": "ħ",
        "H": "Ħ",
        "i": "ɨ",
        "I": "Ɨ",
        "j": "ɉ",
        "J": "Ɉ",
        "l": "ł",
        "L": "Ł",
        "o": "ø",
        "O": "Ø",
        "p": "ᵽ",
        "P": "Ᵽ",
        "r": "ɍ",
        "R": "Ɍ",
        "t": "ŧ",
        "T": "Ŧ",
        "u": "ʉ",
        "U": "Ʉ",
        "y": "ɏ",
        "Y": "Ɏ",
        "z": "ƶ",
        "Z": "Ƶ",
    };
    addBar(char) {
        return Keyboard.BAR_MAP[char] ?? char;
    }
    static BREVE_MAP = {
        "a": "ă",
        "A": "Ă",
        "e": "ĕ",
        "E": "Ĕ",
        "g": "ğ",
        "G": "Ğ",
        "i": "ĭ",
        "I": "Ĭ",
        "o": "ŏ",
        "O": "Ŏ",
        "u": "ŭ",
        "U": "Ŭ",
        "à": "ằ",
        "À": "Ằ",
    };
    addBreve(char) {
        return Keyboard.BREVE_MAP[char] ?? char;
    }
    static TILDE_MAP = {
        "a": "ã",
        "A": "Ã",
        "e": "ẽ",
        "E": "Ẽ",
        "i": "ĩ",
        "I": "Ĩ",
        "n": "ñ",
        "N": "Ñ",
        "o": "õ",
        "O": "Õ",
        "u": "ũ",
        "U": "Ũ",
        "v": "ṽ",
        "V": "Ṽ",
        "y": "ỹ",
        "Y": "Ỹ",
        "ê": "ễ",
        "Ê": "Ễ",
    };
    addTilde(char) {
        return Keyboard.TILDE_MAP[char] ?? char;
    }
    static MACRON_MAP = {
        "a": "ā",
        "A": "Ā",
        "e": "ē",
        "E": "Ē",
        "g": "ḡ",
        "G": "Ḡ",
        "i": "ī",
        "I": "Ī",
        "o": "ō",
        "O": "Ō",
        "u": "ū",
        "U": "Ū",
        "y": "ȳ",
        "Y": "Ȳ",
        "é": "ḗ",
        "É": "Ḗ",
        "è": "ḕ",
        "È": "Ḕ",
    };
    addMacron(char) {
        return Keyboard.MACRON_MAP[char] ?? char;
    }
    static CEDILLA_MAP = {
        "c": "ç",
        "C": "Ç",
        "d": "ḑ",
        "D": "Ḑ",
        "e": "ȩ",
        "E": "Ȩ",
        "g": "ģ",
        "G": "Ģ",
        "h": "ḩ",
        "H": "Ḩ",
        "k": "ķ",
        "K": "Ķ",
        "l": "ļ",
        "L": "Ļ",
        "n": "ņ",
        "N": "Ņ",
        "r": "ŗ",
        "R": "Ŗ",
        "s": "ş",
        "S": "Ş",
        "t": "ţ",
        "T": "Ţ",
    };
    addCedilla(char) {
        return Keyboard.CEDILLA_MAP[char] ?? char;
    }
    static OVERRING_MAP = {
        "a": "å",
        "A": "Å",
        "u": "ů",
        "U": "Ů",
        "w": "ẘ",
        "y": "ẙ",
    };
    addOverring(char) {
        return Keyboard.OVERRING_MAP[char] ?? char;
    }
    toGreek(char) {
        switch (char) {
            case "b":
                return "β";
            case "p":
                return "π";
            case "P":
                return "Π";
            case "d":
                return "δ";
            case "D":
                return "Δ";
            case "l":
                return "λ";
            case "L":
                return "Λ";
            case "j":
                return "θ";
            case "J":
                return "Θ";
            case "z":
                return "ζ";
            case "w":
                return "ω";
            case "W":
                return "Ω";
            case "A":
                return "α";
            case "u":
                return "υ";
            case "U":
                return "Υ";
            case "i":
                return "ι";
            case "e":
                return "ε";
            case "t":
                return "τ";
            case "s":
                return "σ";
            case "S":
                return "Σ";
            case "r":
                return "ρ";
            case "R":
                return "Ρ";
            case "n":
                return "ν";
            case "m":
                return "μ";
            case "y":
                return "ψ";
            case "Y":
                return "Ψ";
            case "x":
                return "ξ";
            case "X":
                return "Ξ";
            case "k":
                return "κ";
            case "q":
                return "χ";
            case "Q":
                return "Χ";
            case "g":
                return "γ";
            case "G":
                return "Γ";
            case "h":
                return "η";
            case "f":
                return "φ";
            case "F":
                return "Φ";
            default:
                return char;
        }
    }
    static IOTASUB_MAP = {
        "o": "ǫ",
        "O": "Ǫ",
        "a": "ą",
        "A": "Ą",
        "u": "ų",
        "U": "Ų",
        "i": "į",
        "I": "Į",
        "e": "ę",
        "E": "Ę",
    };
    addIotasub(char) {
        return Keyboard.IOTASUB_MAP[char] ?? char;
    }
}

module.exports = {
    Keyboard
};
