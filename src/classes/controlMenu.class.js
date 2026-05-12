class ControlMenu {
    static MENU = [
        { id: "settings",  label: "Settings",  hint: "Ctrl+Shift+S", action: () => window.openSettings() },
        { id: "shortcuts", label: "Shortcuts", hint: "Ctrl+Shift+K", action: () => window.openShortcutsHelp() },
        { id: "style", label: "Style", submenu: [
            { id: "themes",    label: "Theme...",           buildSubmenu: "themes" },
            { id: "keyboards", label: "Keyboard layout...", buildSubmenu: "keyboards" }
        ]},
        { id: "toggle", label: "Toggle", submenu: [
            { id: "panels",   label: "Panels",              hint: "Ctrl+Shift+M", action: () => window.useAppShortcut("PANELS_TOGGLE") },
            { id: "kb",       label: "On-screen keyboard", hint: "Ctrl+Shift+B", action: () => window.useAppShortcut("KB_TOGGLE") },
            { id: "dotfiles", label: "Filesystem dotfiles", hint: "Ctrl+Shift+H", action: () => window.useAppShortcut("FS_DOTFILES") },
            { id: "list",     label: "List view",          hint: "Ctrl+Shift+L", action: () => window.useAppShortcut("FS_LIST_VIEW") },
            { id: "pass",     label: "Pass-mode",          hint: "Ctrl+Shift+P", action: () => window.useAppShortcut("KB_PASSMODE") }
        ]},
        { id: "open", label: "Open", submenu: [
            { id: "fuzzy",  label: "Fuzzy file search", hint: "Ctrl+Shift+F", action: () => window.useAppShortcut("FUZZY_SEARCH") },
            { id: "files",  label: "File browser",     hint: "Ctrl+Shift+E", action: () => window.useAppShortcut("FS_OPEN") },
            { id: "claude", label: "Claude chat",      hint: "Ctrl+Shift+A", action: () => window.useAppShortcut("CLAUDE_CHAT") }
        ]},
        { id: "apps", label: "Apps", buildSubmenu: "webapps" },
        { id: "dev", label: "Dev", submenu: [
            { id: "devtools", label: "DevTools",   hint: "Ctrl+Shift+I",  action: () => window.useAppShortcut("DEV_DEBUG") },
            { id: "reload",   label: "Reload UI",  hint: "Ctrl+Shift+F5", action: () => window.useAppShortcut("DEV_RELOAD") },
            { id: "restart",  label: "Restart eDEX",                     action: () => {
                const remote = require("@electron/remote");
                remote.app.relaunch();
                remote.app.quit();
            } }
        ]},
        { id: "quit", label: "Quit", action: () => require("@electron/remote").app.quit() }
    ];

    constructor() {
        if (document.getElementById("controlMenu") || document.getElementById("settingsEditor")) {
            return false;
        }

        window.keyboard.detach();

        this.path = [];
        this.filter = "";
        this.selected = 0;
        this._cache = {};

        this.disp = new Modal({
            type: "custom",
            title: "Control Menu",
            html: `<div id="controlMenuBreadcrumb"></div>
                <input type="search" id="controlMenu" placeholder="Type to filter..." />
                <ul id="controlMenu-results">
                    <li id="controlMenuMatch-0" class="controlMenuMatchSelected"></li>
                    <li id="controlMenuMatch-1"></li>
                    <li id="controlMenuMatch-2"></li>
                    <li id="controlMenuMatch-3"></li>
                    <li id="controlMenuMatch-4"></li>
                </ul>`,
            buttons: []
        }, () => {
            delete window.activeControlMenu;
            window.keyboard.attach();
            window.term[window.currentTerm].term.focus();
        });

        this.input = document.getElementById("controlMenu");
        this.results = document.getElementById("controlMenu-results");
        this.crumb = document.getElementById("controlMenuBreadcrumb");

        this.input.addEventListener('input', e => {
            if ((e.inputType && e.inputType.startsWith("delete")) || (e.detail && typeof e.detail === "string" && e.detail.startsWith("delete"))) {
                this.input.value = "";
                this.filter = "";
            } else {
                this.filter = this.input.value;
            }
            this.selected = 0;
            this.render();
        });

        this.input.addEventListener('change', e => {
            if (e.detail === "enter") {
                this.activate();
            }
        });

        this.input.addEventListener('keydown', e => {
            switch (e.key) {
                case 'Enter':
                    this.activate();
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
                case 'Backspace':
                    // Ascend only when input is empty; otherwise let the
                    // native delete run and the 'input' event re-render.
                    if (this.input.value === "" && this.path.length > 0) {
                        this.ascend();
                        e.preventDefault();
                    }
                    break;
                default:
                    // Other keys fall through to the 'input' event.
            }
        });

        this.render();
        this.input.focus();
    }

    _moveSelection(delta) {
        const entries = this.visibleEntries();
        if (entries.length === 0) return;
        const next = (this.selected + delta + entries.length) % entries.length;
        const cur = document.querySelector("li.controlMenuMatchSelected");
        const nextEl = document.getElementById(`controlMenuMatch-${next}`);
        if (cur) cur.removeAttribute("class");
        if (nextEl) nextEl.setAttribute("class", "controlMenuMatchSelected");
        this.selected = next;
    }

    currentLevel() {
        let level = ControlMenu.MENU;
        for (const id of this.path) {
            const entry = level.find(e => e.id === id);
            if (!entry) return [];
            if (Array.isArray(entry.submenu)) {
                level = entry.submenu;
            } else if (entry.buildSubmenu) {
                level = this._buildSubmenu(entry.buildSubmenu);
            } else {
                return [];
            }
        }
        return level;
    }

    _buildSubmenu(kind) {
        if (this._cache[kind]) return this._cache[kind];
        if (kind === "webapps") {
            const apps = Array.isArray(window.webapps) ? window.webapps : [];
            const entries = apps.map(app => ({
                id: app.id,
                label: app.name,
                action: () => window.openWebApp(app.id)
            }));
            entries.push({ id: "__add",    label: "+ Add new...", action: () => window.openAddWebApp() });
            entries.push({ id: "__manage", label: "⚙ Manage...",   action: () => window.openManageWebApps() });
            this._cache[kind] = entries;
            return entries;
        }
        const fs = require("fs");
        const path = require("path");
        const remote = require("@electron/remote");
        const userData = remote.app.getPath("userData");
        let dir, hot;
        if (kind === "themes") {
            dir = path.join(userData, "themes");
            hot = (name) => window._hotSwitchTheme(name);
        } else if (kind === "keyboards") {
            dir = path.join(userData, "keyboards");
            hot = (name) => window._hotSwitchKeyboard(name);
        } else {
            return [];
        }
        let entries = [];
        try {
            entries = fs.readdirSync(dir)
                .filter(f => f.endsWith(".json"))
                .map(f => f.replace(/\.json$/, ""))
                .sort()
                .map(name => ({ id: name, label: name, action: () => hot(name) }));
        } catch (e) {
            console.warn(`ControlMenu: could not read ${dir}:`, e);
        }
        this._cache[kind] = entries;
        return entries;
    }

    visibleEntries() {
        const level = this.currentLevel();
        if (!this.filter) return level;
        const q = this.filter.toLowerCase();
        return level.filter(e => e.label.toLowerCase().includes(q));
    }

    render() {
        const crumbs = ["Control Menu"];
        let lvl = ControlMenu.MENU;
        for (const id of this.path) {
            const entry = lvl.find(e => e.id === id);
            if (!entry) break;
            crumbs.push(entry.label);
            if (Array.isArray(entry.submenu)) lvl = entry.submenu;
            else if (entry.buildSubmenu) lvl = this._buildSubmenu(entry.buildSubmenu);
        }
        this.crumb.textContent = crumbs.join(" › ");

        const entries = this.visibleEntries();
        if (this.selected >= entries.length) this.selected = 0;

        const SLOTS = 5;
        let html = "";
        if (entries.length === 0) {
            html = `<li id="controlMenuMatch-0" class="controlMenuMatchSelected">No matches<span class="controlMenuHint"></span></li>`;
            for (let i = 1; i < SLOTS; i++) html += `<li id="controlMenuMatch-${i}"></li>`;
            this.results.innerHTML = html;
            return;
        }
        for (let i = 0; i < SLOTS; i++) {
            const e = entries[i];
            if (!e) {
                html += `<li id="controlMenuMatch-${i}"></li>`;
                continue;
            }
            const isSelected = (i === this.selected);
            const hasChildren = !!(e.submenu || e.buildSubmenu);
            const hint = hasChildren ? "›" : (e.hint || "");
            const cls = isSelected ? "controlMenuMatchSelected" : "";
            html += `<li id="controlMenuMatch-${i}" class="${cls}" onclick="window.activeControlMenu._clickRow(${i})">${window._escapeHtml(e.label)}<span class="controlMenuHint">${window._escapeHtml(hint)}</span></li>`;
        }
        this.results.innerHTML = html;
    }

    _clickRow(i) {
        const entries = this.visibleEntries();
        if (i >= entries.length) return;
        const cur = document.querySelector("li.controlMenuMatchSelected");
        if (cur) cur.removeAttribute("class");
        const nextEl = document.getElementById(`controlMenuMatch-${i}`);
        if (nextEl) nextEl.setAttribute("class", "controlMenuMatchSelected");
        this.selected = i;
        this.activate();
    }

    activate() {
        const entries = this.visibleEntries();
        const entry = entries[this.selected];
        if (!entry) return;
        if (Array.isArray(entry.submenu) || entry.buildSubmenu) {
            this.path.push(entry.id);
            this.filter = "";
            this.input.value = "";
            this.selected = 0;
            this.render();
            this.input.focus();
            return;
        }
        // Leaf: close the menu first so the keyboard/term refocus chain
        // runs cleanly, then invoke the action (which may itself open
        // another modal).
        const action = entry.action;
        this.disp.close();
        if (typeof action === "function") {
            try { action(); } catch (err) { console.warn("ControlMenu action failed:", err); }
        }
    }

    ascend() {
        this.path.pop();
        this.filter = "";
        this.input.value = "";
        this.selected = 0;
        this.render();
    }
}

module.exports = {
    ControlMenu
};
