"use strict";

// Default shortcuts.json template + post-install backfill rules. Pure
// module — no DOM, no electron, no file I/O — so `_boot.js` can use
// it on first launch and the unit suite can pin every entry's action
// against `SHORTCUTS_DEFINITION` in `shortcuts.class.js`.
//
// Why split from `shortcuts.class.js`? That class is a renderer
// module: it references `Modal`, `FuzzyFinder`, `remote`, etc. via
// the renderer's shared script scope. `_boot.js` runs in the
// Electron main process and would crash on first `require()` of
// those. Keeping the pure-data part here lets both processes share
// the same source of truth without dragging the main process into
// the renderer's world.
//
// Issue #174.

// First-launch shortcuts.json contents. Mirrors the inline literal
// that used to live in `_boot.js`. Editing the renderer-side
// dispatcher (`useAppShortcut` in `shortcuts.class.js`) without
// adding the trigger here will surface in the
// "every DEFAULT_SHORTCUTS action resolves" cross-module test.
const DEFAULT_SHORTCUTS = [
    { type: "app",   trigger: "Ctrl+Shift+C",      action: "COPY",          enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+V",      action: "PASTE",         enabled: true  },
    { type: "app",   trigger: "Ctrl+Tab",          action: "NEXT_TAB",      enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+Tab",    action: "PREVIOUS_TAB",  enabled: true  },
    { type: "app",   trigger: "Ctrl+X",            action: "TAB_X",         enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+S",      action: "SETTINGS",      enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+K",      action: "SHORTCUTS",     enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+F",      action: "FUZZY_SEARCH",  enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+E",      action: "FS_OPEN",       enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+L",      action: "FS_LIST_VIEW",  enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+H",      action: "FS_DOTFILES",   enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+P",      action: "KB_PASSMODE",   enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+B",      action: "KB_TOGGLE",     enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+M",      action: "PANELS_TOGGLE", enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+A",      action: "CLAUDE_CHAT",   enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+O",      action: "CONTROL_MENU",  enabled: true  },
    { type: "app",   trigger: "Ctrl+Shift+I",      action: "DEV_DEBUG",     enabled: false },
    { type: "app",   trigger: "Ctrl+Shift+F5",     action: "DEV_RELOAD",    enabled: true  },
    { type: "shell", trigger: "Ctrl+Shift+Alt+Space", action: "neofetch", linebreak: true, enabled: false }
];

// In-place migrations for users with a pre-existing shortcuts.json,
// run from `_boot.js`. Returns `true` when any entry was mutated /
// added so the caller knows to rewrite the file.
//
// Each rule is intentionally narrow: it only fires when the
// already-present state is ambiguous (missing entirely vs. carrying a
// legacy trigger). Adding a rule here means a new line in this array
// plus a `signale.info` line at the call site in `_boot.js`.
const MIGRATIONS = [
    {
        // CONTROL_MENU launcher was added after 1.x. Existing users
        // upgrading miss the binding unless we backfill it.
        description: "backfill CONTROL_MENU",
        apply(shortcuts) {
            if (shortcuts.some(s => s.action === "CONTROL_MENU")) return false;
            shortcuts.push({ type: "app", trigger: "Ctrl+Shift+O", action: "CONTROL_MENU", enabled: true });
            return true;
        }
    },
    {
        // The original CONTROL_MENU trigger was Ctrl+Shift+Space.
        // IBus / fcitx on most Linux desktops claim that combo so the
        // event never reaches Electron. Move existing entries onto
        // Ctrl+Shift+O while leaving the rest of the shortcut alone.
        description: "migrate CONTROL_MENU from Ctrl+Shift+Space to Ctrl+Shift+O",
        apply(shortcuts) {
            const entry = shortcuts.find(s => s.action === "CONTROL_MENU");
            if (!entry || entry.trigger !== "Ctrl+Shift+Space") return false;
            entry.trigger = "Ctrl+Shift+O";
            return true;
        }
    }
];

module.exports = { DEFAULT_SHORTCUTS, MIGRATIONS };
