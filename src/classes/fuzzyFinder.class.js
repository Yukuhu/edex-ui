// FuzzyFinder — Ctrl+Shift+F cwd file-search modal. Five result slots,
// arrow keys to navigate, Enter to inject a quoted path into the
// active terminal.
const SLOTS = 5;

class FuzzyFinder {
    // Strip the legacy `"FALLBACK |-- "` prefix Terminal.class.js
    // adds to `cwd` when the OS-level lookup failed and we fell back
    // to a guessed directory. The prefix isn't a real path
    // component, so anything that wants to `readdirSync` on it
    // (FuzzyFinder, FsModal, …) needs to remove it first. Issue #175.
    static _stripCwdFallback(cwd) {
        if (typeof cwd !== "string") return cwd;
        return cwd.startsWith("FALLBACK |-- ") ? cwd.slice(13) : cwd;
    }

    // Pure filter+sort for an in-memory file list. The same logic
    // the on-screen Ctrl+Shift+F modal uses:
    //   1. Case-insensitive substring match.
    //   2. Stop after `slotLimit` matches — there are only N row
    //      slots, no point scoring the whole disk.
    //   3. Names that *start with* the query bubble to the top;
    //      everything else keeps its readdir-determined order.
    // Issue #175.
    static _matchAndSort(files, query, slotLimit) {
        const q = String(query ?? "").toLowerCase();
        const matches = [];
        for (const name of files) {
            if (matches.length >= slotLimit) break;
            if (String(name).toLowerCase().includes(q)) matches.push(name);
        }
        const startsWithQ = name => Number(String(name).toLowerCase().startsWith(q));
        matches.sort((a, b) => startsWithQ(b) - startsWithQ(a));
        return matches;
    }

    constructor() {
        if (document.getElementById("fuzzyFinder") || document.getElementById("settingsEditor")) {
            return false;
        }

        window.keyboard.detach();

        // The first slot is pre-selected so Enter on an empty input
        // still resolves a row (and shows "No results" otherwise).
        let listHtml = `<li id="fuzzyFinderMatch-0" class="fuzzyFinderMatchSelected"></li>`;
        for (let i = 1; i < SLOTS; i++) listHtml += `<li id="fuzzyFinderMatch-${i}"></li>`;

        this.disp = new Modal({
            type: "custom",
            title: "Fuzzy cwd file search",
            html: `<input type="search" id="fuzzyFinder" placeholder="Search file in cwd..." />
                <ul id="fuzzyFinder-results">${listHtml}</ul>`,
            buttons: [
                {label: "Select", action: "window.activeFuzzyFinder.submit()"}
            ]
        }, () => {
            delete window.activeFuzzyFinder;
            window.keyboard.attach();
            window.term[window.currentTerm].term.focus();
        });

        this.input = document.getElementById("fuzzyFinder");
        this.results = document.getElementById("fuzzyFinder-results");

        this.input.addEventListener('input', e => {
            if (e.inputType?.startsWith("delete") || e.detail?.startsWith?.("delete")) {
                this.input.value = "";
                this.search("");
            } else {
                this.search(this.input.value);
            }
        });
        this.input.addEventListener('change', e => {
            if (e.detail === "enter") this.submit();
        });
        this.input.addEventListener('keydown', e => {
            switch (e.key) {
                case 'Enter':
                    this.submit();
                    e.preventDefault();
                    break;
                case 'ArrowDown':
                    this._moveSelection(+1);
                    e.preventDefault();
                    break;
                case 'ArrowUp':
                    this._moveSelection(-1);
                    e.preventDefault();
                    break;
                default:
                    // Other keys fall through to the 'input' event.
            }
        });

        this.search("");
        this.input.focus();
    }

    // Move the highlighted row by delta, with the original wrap rules:
    //   ArrowDown past the last slot → wraps to slot 0.
    //   ArrowUp before slot 0        → stays at slot 0.
    _moveSelection(delta) {
        const cur = document.querySelector('li.fuzzyFinderMatchSelected');
        if (!cur) return;
        const idx = Number(cur.id.slice("fuzzyFinderMatch-".length));
        const target = idx + delta;
        const targetEl = document.getElementById(`fuzzyFinderMatch-${target}`);
        const next = targetEl ? target : 0;
        this._selectRow(next);
    }

    // Apply the "selected" class to row `i`, clearing any prior selection.
    _selectRow(i) {
        const cur = document.querySelector('li.fuzzyFinderMatchSelected');
        if (cur) cur.removeAttribute("class");
        const el = document.getElementById(`fuzzyFinderMatch-${i}`);
        if (el) el.setAttribute("class", "fuzzyFinderMatchSelected");
    }

    search(text) {
        // Resolve the active terminal's CWD. The legacy inline filesystem
        // panel exposed this via window.fsDisp; that panel has been
        // retired in favor of the FsModal (Ctrl+Shift+E), so the
        // terminal is now the single source of truth.
        const fs = require("node:fs");
        const term = window.term?.[window.currentTerm];
        const cwd = FuzzyFinder._stripCwdFallback(term?.cwd || window.settings?.cwd);
        this._currentCwd = cwd;

        let files;
        try {
            files = fs.readdirSync(cwd);
        } catch (_) {
            files = [];
        }

        const matches = FuzzyFinder._matchAndSort(files, text, SLOTS);

        // NOTE: when matches is empty, the legacy code wrote a "No
        // results" placeholder and then immediately overwrote it with
        // 5 empty <li> tags, so the placeholder never actually
        // displayed. Preserving that for behavioural parity — the
        // visible result of an empty search is 5 blank rows.
        //
        // Build rows as DOM nodes (not innerHTML) so file names go in
        // via textContent and cannot be parsed as HTML — a filename
        // like `<img onerror=...>` is rendered as text. CodeQL
        // js/stored-xss flagged the previous innerHTML interpolation.
        const rows = [];
        matches.forEach((name, i) => {
            const li = document.createElement("li");
            li.id = `fuzzyFinderMatch-${i}`;
            if (i === 0) li.className = "fuzzyFinderMatchSelected";
            li.textContent = name;
            li.addEventListener("click", () => this._selectRow(i));
            rows.push(li);
        });
        for (let i = matches.length; i < SLOTS; i++) rows.push(document.createElement("li"));
        this.results.replaceChildren(...rows);
    }

    submit() {
        const sel = document.querySelector("li.fuzzyFinderMatchSelected");
        const file = sel ? sel.innerText : "";
        if (file === "No results" || file.length <= 0) {
            this.disp.close();
            return;
        }

        const filePath = path.resolve(this._currentCwd || ".", file);
        window.term[window.currentTerm].write(`'${filePath}'`);
        this.disp.close();
    }
}

module.exports = {
    FuzzyFinder
};
