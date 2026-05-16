// FuzzyFinder — Ctrl+Shift+F cwd file-search modal. Five result slots,
// arrow keys to navigate, Enter to inject a quoted path into the
// active terminal.
const SLOTS = 5;

class FuzzyFinder {
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
        let cwd = term?.cwd || window.settings?.cwd;
        if (cwd?.startsWith("FALLBACK |-- ")) cwd = cwd.slice(13);
        this._currentCwd = cwd;

        let files;
        try {
            files = fs.readdirSync(cwd);
        } catch (_) {
            files = [];
        }

        const q = text.toLowerCase();
        const matches = [];
        for (const name of files) {
            if (matches.length >= SLOTS) break;
            if (name.toLowerCase().includes(q)) matches.push(name);
        }

        // Names that start with the query come first; others keep
        // their (readdir-determined) order. Equivalent to the original
        // three-branch comparator.
        const startsWithQ = name => Number(name.toLowerCase().startsWith(q));
        matches.sort((a, b) => startsWithQ(b) - startsWithQ(a));

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
