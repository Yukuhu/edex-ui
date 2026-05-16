// Disable eval()
window.eval = global.eval = function () {
    throw new Error("eval() is disabled for security reasons.");
};

// Wayland viewport overshoot fix (#32). Electron 42 + KWin Wayland
// makes the renderer's layout viewport (window.innerWidth/Height)
// larger than the actually-visible screen — observed as
// innerWidth=3474 on a 3440-wide display, with the surplus rendered
// past the right and bottom edges of the window. Scaling the
// documentElement via CSS transform fits everything into the visible
// area without introducing black bars. The transform also makes
// <html> the containing block for position:fixed descendants, so
// they get the same compression and pin to the visible edges instead
// of the off-screen ones. Click coordinates are auto-corrected by
// the browser through the transform; pointer interaction is
// unaffected. The clean root-cause fix would be --ozone-platform=x11
// but that crashes the GPU process on the open-source radv AMD
// driver and breaks WebGL (globe widget).
(function fixViewportOvershoot() {
    if (typeof window === "undefined" || !window.screen) return;
    const OVERSHOOT_THRESHOLD_PX = 8;
    const apply = () => {
        const sw = window.screen.availWidth || window.screen.width;
        const sh = window.screen.availHeight || window.screen.height;
        const iw = window.innerWidth;
        const ih = window.innerHeight;
        if (!sw || !sh || !iw || !ih) return;
        const root = document.documentElement;
        if (iw - sw < OVERSHOOT_THRESHOLD_PX && ih - sh < OVERSHOOT_THRESHOLD_PX) {
            // Clear any earlier transform if we no longer overshoot.
            if (root.style.transform) {
                root.style.transform = "";
                root.style.transformOrigin = "";
            }
            return;
        }
        const s = Math.min(sw / iw, sh / ih, 1);
        // Center the scaled content within the visible screen so the
        // unused strip is split evenly across both edges of the
        // constrained axis (#32 follow-up).
        const tx = Math.max(0, (sw - iw * s) / 2);
        const ty = Math.max(0, (sh - ih * s) / 2);
        root.style.transformOrigin = "top left";
        root.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    };
    // The renderer's window settles to its final size after script
    // load on some boots — race condition between BrowserWindow
    // creation and the renderer's first measurement. Re-apply on
    // every resize so we converge regardless of timing.
    apply();
    window.addEventListener("resize", apply);
})();

// Security helper :)
window._escapeHtml = text => {
    let map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => {return map[m];});
};
window._encodePathURI = uri => {
    return encodeURI(uri).replace(/#/g, "%23");
};
window._purifyCSS = str => {
    if (typeof str === "undefined") return "";
    if (typeof str !== "string") {
        str = str.toString();
    }
    return str.replace(/[<]/g, "");
};
window._delay = ms => {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, ms);
    });
};

// Initiate basic error handling
window.onerror = (msg, path, line, col, error) => {
    const safeMsg = typeof msg === "string" ? msg : JSON.stringify(msg);
    document.getElementById("boot_screen").innerHTML += `${error} :  ${safeMsg}<br/>==> at ${path}  ${line}:${col}`;
};

const path = require("path");
const fs = require("fs");
const electron = require("electron");
const remote = require("@electron/remote");
const ipc = electron.ipcRenderer;

const settingsDir = remote.app.getPath("userData");
const themesDir = path.join(settingsDir, "themes");
const keyboardsDir = path.join(settingsDir, "keyboards");
const fontsDir = path.join(settingsDir, "fonts");
const settingsFile = path.join(settingsDir, "settings.json");
const shortcutsFile = path.join(settingsDir, "shortcuts.json");
const webappsFile = path.join(settingsDir, "webapps.json");
const lastWindowStateFile = path.join(settingsDir, "lastWindowState.json");

// Load config
window.settings = require(settingsFile);
window.shortcuts = require(shortcutsFile);
window.webapps = require(webappsFile);
window.lastWindowState = require(lastWindowStateFile);

// Load CLI parameters
if (remote.process.argv.includes("--nointro")) {
    window.settings.nointroOverride = true;
} else {
    window.settings.nointroOverride = false;
}
if (remote.process.argv.includes("--nocursor")) {
    window.settings.nocursorOverride = true;
} else {
    window.settings.nocursorOverride = false;
}

// Retrieve theme override (hotswitch)
ipc.once("getThemeOverride", (e, theme) => {
    if (theme !== null) {
        window.settings.theme = theme;
        window.settings.nointroOverride = true;
        _loadTheme(require(path.join(themesDir, window.settings.theme+".json")));
    } else {
        _loadTheme(require(path.join(themesDir, window.settings.theme+".json")));
    }
});
ipc.send("getThemeOverride");
// Same for keyboard override/hotswitch
ipc.once("getKbOverride", (e, layout) => {
    if (layout !== null) {
        window.settings.keyboard = layout;
        window.settings.nointroOverride = true;
    }
});
ipc.send("getKbOverride");

// Load UI theme
window._loadTheme = theme => {

    if (document.querySelector("style.theming")) {
        document.querySelector("style.theming").remove();
    }

    // Load fonts
    let mainFont = new FontFace(theme.cssvars.font_main, `url("${path.join(fontsDir, theme.cssvars.font_main.toLowerCase().replace(/ /g, '_')+'.woff2').replace(/\\/g, '/')}")`);
    let lightFont = new FontFace(theme.cssvars.font_main_light, `url("${path.join(fontsDir, theme.cssvars.font_main_light.toLowerCase().replace(/ /g, '_')+'.woff2').replace(/\\/g, '/')}")`);
    let termFont = new FontFace(theme.terminal.fontFamily, `url("${path.join(fontsDir, theme.terminal.fontFamily.toLowerCase().replace(/ /g, '_')+'.woff2').replace(/\\/g, '/')}")`);

    document.fonts.add(mainFont);
    document.fonts.load("12px "+theme.cssvars.font_main);
    document.fonts.add(lightFont);
    document.fonts.load("12px "+theme.cssvars.font_main_light);
    document.fonts.add(termFont);
    document.fonts.load("12px "+theme.terminal.fontFamily);

    document.querySelector("head").innerHTML += `<style class="theming">
    :root {
        --font_main: "${window._purifyCSS(theme.cssvars.font_main)}";
        --font_main_light: "${window._purifyCSS(theme.cssvars.font_main_light)}";
        --font_mono: "${window._purifyCSS(theme.terminal.fontFamily)}";
        --color_r: ${window._purifyCSS(theme.colors.r)};
        --color_g: ${window._purifyCSS(theme.colors.g)};
        --color_b: ${window._purifyCSS(theme.colors.b)};
        --color_black: ${window._purifyCSS(theme.colors.black)};
        --color_light_black: ${window._purifyCSS(theme.colors.light_black)};
        --color_grey: ${window._purifyCSS(theme.colors.grey)};

        /* Used for error and warning modals */
        --color_red: ${window._purifyCSS(theme.colors.red) || "red"};
        --color_yellow: ${window._purifyCSS(theme.colors.yellow) || "yellow"};
    }

    body {
        font-family: var(--font_main), sans-serif;
        cursor: ${(window.settings.nocursorOverride || window.settings.nocursor) ? "none" : "default"} !important;
    }

    * {
   	   ${(window.settings.nocursorOverride || window.settings.nocursor) ? "cursor: none !important;" : ""}
	}

    ${window._purifyCSS(theme.injectCSS || "")}
    </style>`;

    window.theme = theme;
    window.theme.r = theme.colors.r;
    window.theme.g = theme.colors.g;
    window.theme.b = theme.colors.b;
};

// Hot-swap helpers invoked from the Control Menu's Style submenu.
window._hotSwitchTheme = (name) => {
    try {
        _loadTheme(require(path.join(themesDir, name + ".json")));
        window.settings.theme = name;
    } catch (e) {
        console.warn("Theme hot-swap failed:", e);
    }
};
window._hotSwitchKeyboard = (name) => {
    // Live re-instantiating the on-screen keyboard layout is out of
    // scope; persist the choice and ask the user to reload.
    try {
        window.settings.keyboard = name;
        fs.writeFileSync(settingsFile, JSON.stringify(window.settings, "", 4));
        new Modal({
            type: "warning",
            message: `Keyboard layout set to "${name}". Reload UI (Ctrl+Shift+F5) to apply.`
        });
    } catch (e) {
        console.warn("Keyboard hot-swap failed:", e);
    }
};

function initGraphicalErrorHandling() {
    window.edexErrorsModals = [];
    window.onerror = (msg, path, line, col, error) => {
        const safeMsg = typeof msg === "string" ? msg : JSON.stringify(msg);
        let errorModal = new Modal({
            type: "error",
            title: error,
            message: `${safeMsg}<br/>        at ${path}  ${line}:${col}`
        });
        window.edexErrorsModals.push(errorModal);

        ipc.send("log", "error", `${error}: ${safeMsg}`);
        ipc.send("log", "debug", `at ${path} ${line}:${col}`);
    };
}

function waitForFonts() {
    return new Promise(resolve => {
        if (document.readyState !== "complete" || document.fonts.status !== "loaded") {
            document.addEventListener("readystatechange", () => {
                if (document.readyState === "complete") {
                    if (document.fonts.status === "loaded") {
                        resolve();
                    } else {
                        document.fonts.onloadingdone = () => {
                            if (document.fonts.status === "loaded") resolve();
                        };
                    }
                }
            });
        } else {
            resolve();
        }
    });
}

// A proxy function used to add multithreading to systeminformation calls - see backend process manager @ _multithread.js
function initSystemInformationProxy() {
    const { nanoid } = require("nanoid/non-secure");

    window.si = new Proxy({}, {
        apply: () => {throw new Error("Cannot use sysinfo proxy directly as a function")},
        set: () => {throw new Error("Cannot set a property on the sysinfo proxy")},
        get: (target, prop, receiver) => {
            return function(...args) {
                let callback = typeof args.at(-1) === "function";

                return new Promise((resolve, reject) => {
                    let id = nanoid();
                    ipc.once("systeminformation-reply-"+id, (e, res) => {
                        if (callback) {
                            args.at(-1)(res);
                        }
                        resolve(res);
                    });
                    ipc.send("systeminformation-call", prop, id, ...args);
                });
            };
        }
    });
}

// Init audio
window.audioManager = new AudioManager();

// Init shared TTS engine — singleton consumed by both ClaudeChat
// (streaming sentence-by-sentence) and any Modal that opted into a
// SPEAK toggle via `ttsSource`. The Kokoro worker is loaded lazily on
// first use, so creating the instance here is cheap.
window.ttsEngine = new TtsEngine();

// Init shared Gemma chat engine — singleton consumed by ClaudeChat
// when the chat backend is switched to local-Gemma. The transformers.js
// pipeline + WebGPU session are loaded lazily on first use; spawning
// the engine here is cheap (no worker spun up until load()/generate()).
window.gemmaEngine = new GemmaEngine();

// See #223
remote.app.focus();

let i = 0;
if (window.settings.nointro || window.settings.nointroOverride) {
    initGraphicalErrorHandling();
    initSystemInformationProxy();
    document.getElementById("boot_screen").remove();
    document.body.setAttribute("class", "");
    waitForFonts().then(initUI);
} else {
    displayLine();
}

// Startup boot log
function displayLine() {
    let bootScreen = document.getElementById("boot_screen");
    let log = fs.readFileSync(path.join(__dirname, "assets", "misc", "boot_log.txt")).toString().split('\n');

    function isArchUser() {
        return require("os").platform() === "linux"
                && fs.existsSync("/etc/os-release")
                && fs.readFileSync("/etc/os-release").toString().includes("arch");
    }

    if (typeof log[i] === "undefined") {
        setTimeout(displayTitleScreen, 300);
        return;
    }

    if (log[i] === "Boot Complete") {
        window.audioManager.granted.play();
    } else {
        window.audioManager.stdout.play();
    }
    bootScreen.innerHTML += log[i]+"<br/>";
    i++;

    switch(true) {
        case i === 2:
            bootScreen.innerHTML += `nDEX-UI Kernel version ${remote.app.getVersion()} boot at ${String(new Date())}; root:xnu-1699.22.73~1/RELEASE_X86_64`;
            setTimeout(displayLine, 500);
            break;
        case i === 4:
            setTimeout(displayLine, 500);
            break;
        case i > 4 && i < 25:
            setTimeout(displayLine, 30);
            break;
        case i === 25:
            setTimeout(displayLine, 400);
            break;
        case i === 42:
            setTimeout(displayLine, 300);
            break;
        case i > 42 && i < 82:
            setTimeout(displayLine, 25);
            break;
        case i === 83:
            if (isArchUser())
                bootScreen.innerHTML += "btw i use arch<br/>";
            setTimeout(displayLine, 25);
            break;
        case i >= log.length-2 && i < log.length:
            setTimeout(displayLine, 300);
            break;
        default:
            setTimeout(displayLine, Math.pow(1 - (i/1000), 3)*25);
    }
}

// Show "logo" and background grid
async function displayTitleScreen() {
    let bootScreen = document.getElementById("boot_screen");
    if (bootScreen === null) {
        bootScreen = document.createElement("section");
        bootScreen.setAttribute("id", "boot_screen");
        bootScreen.setAttribute("style", "z-index: 9999999");
        document.body.appendChild(bootScreen);
    }
    bootScreen.innerHTML = "";
    window.audioManager.theme.play();

    await _delay(400);

    document.body.setAttribute("class", "");
    bootScreen.setAttribute("class", "center");
    bootScreen.innerHTML = "<h1>nDEX-UI</h1>";
    let title = document.querySelector("section > h1");

    await _delay(200);

    document.body.setAttribute("class", "solidBackground");

    await _delay(100);

    title.setAttribute("style", `background-color: rgb(${window.theme.r}, ${window.theme.g}, ${window.theme.b});border-bottom: 5px solid rgb(${window.theme.r}, ${window.theme.g}, ${window.theme.b});`);

    await _delay(300);

    title.setAttribute("style", `border: 5px solid rgb(${window.theme.r}, ${window.theme.g}, ${window.theme.b});`);

    await _delay(100);

    title.setAttribute("style", "");
    title.setAttribute("class", "glitch");

    await _delay(500);

    document.body.setAttribute("class", "");
    title.setAttribute("class", "");
    title.setAttribute("style", `border: 5px solid rgb(${window.theme.r}, ${window.theme.g}, ${window.theme.b});`);

    await _delay(1000);
    if (window.term) {
        bootScreen.remove();
        return true;
    }
    initGraphicalErrorHandling();
    initSystemInformationProxy();
    waitForFonts().then(() => {
        bootScreen.remove();
        initUI();
    });
}

// Returns the user's desired display name
async function getDisplayName() {
    let user = settings.username || null;
    if (user)
        return user;

    try {
        user = await require("username")();
    } catch (e) {}

    return user;
}

// Create the UI's html structure and initialize the terminal client and the keyboard
async function initUI() {
    document.body.innerHTML += `<section class="mod_column" id="mod_column_left">
        <h3 class="title"><p>PANEL</p><p>SYSTEM</p></h3>
    </section>
    <section id="main_shell" style="height:0%;width:0%;opacity:0;margin-bottom:30vh;" augmented-ui="bl-clip tr-clip exe">
        <h3 class="title" style="opacity:0;"><p>TERMINAL</p><p>MAIN SHELL</p></h3>
        <h1 id="main_shell_greeting"></h1>
    </section>
    <section class="mod_column" id="mod_column_right">
        <h3 class="title"><p>PANEL</p><p>NETWORK</p></h3>
    </section>`;

    await _delay(10);

    window.audioManager.expand.play();
    document.getElementById("main_shell").setAttribute("style", "height:0%;margin-bottom:30vh;");

    await _delay(500);

    document.getElementById("main_shell").setAttribute("style", "margin-bottom: 30vh;");
    document.querySelector("#main_shell > h3.title").setAttribute("style", "");

    await _delay(700);

    document.getElementById("main_shell").setAttribute("style", "opacity: 0;");
    // The legacy inline filesystem section used to live here. It's been
    // retired — the new two-pane FilesystemDisplay lives in the FsModal
    // popup, opened with Ctrl+Shift+E. The slot is intentionally empty.
    document.body.innerHTML += `
    <section id="keyboard" style="opacity:0;">
    </section>`;
    window.keyboard = new Keyboard({
        layout: path.join(keyboardsDir, settings.keyboard+".json"),
        container: "keyboard"
    });

    await _delay(10);

    document.getElementById("main_shell").setAttribute("style", "");

    await _delay(270);

    let greeter = document.getElementById("main_shell_greeting");

    getDisplayName().then(user => {
        if (user) {
            greeter.innerHTML += `Welcome back, <em>${user}</em>`;
        } else {
            greeter.innerHTML += "Welcome back";
        }
    });

    greeter.setAttribute("style", "opacity: 1;");

    document.getElementById("keyboard").setAttribute("style", "");
    document.getElementById("keyboard").setAttribute("class", "animation_state_1");
    window.audioManager.keyboard.play();

    await _delay(100);

    document.getElementById("keyboard").setAttribute("class", "animation_state_1 animation_state_2");

    await _delay(1000);

    greeter.setAttribute("style", "opacity: 0;");

    await _delay(100);

    document.getElementById("keyboard").setAttribute("class", "");

    await _delay(400);

    greeter.remove();

    // Initialize modules
    window.mods = {};

    // Left column
    window.mods.clock = new Clock("mod_column_left");
    window.mods.sysinfo = new Sysinfo("mod_column_left");
    window.mods.hardwareInspector = new HardwareInspector("mod_column_left");
    window.mods.cpuinfo = new Cpuinfo("mod_column_left");
    window.mods.ramwatcher = new RAMwatcher("mod_column_left");
    window.mods.toplist = new Toplist("mod_column_left");

    // Right column
    window.mods.netstat = new Netstat("mod_column_right");
    window.mods.globe = new LocationGlobe("mod_column_right");
    window.mods.conninfo = new Conninfo("mod_column_right");

    // Fade-in animations
    document.querySelectorAll(".mod_column").forEach(e => {
        e.setAttribute("class", "mod_column activated");
    });
    let i = 0;
    let left = document.querySelectorAll("#mod_column_left > div");
    let right = document.querySelectorAll("#mod_column_right > div");
    let x = setInterval(() => {
        if (!left[i] && !right[i]) {
            clearInterval(x);
        } else {
            window.audioManager.panels.play();
            if (left[i]) {
                left[i].setAttribute("style", "animation-play-state: running;");
            }
            if (right[i]) {
                right[i].setAttribute("style", "animation-play-state: running;");
            }
            i++;
        }
    }, 500);

    await _delay(100);

    // Initialize the terminal
    let shellContainer = document.getElementById("main_shell");
    shellContainer.innerHTML += `
        <ul id="main_shell_tabs">
            <li id="shell_tab0" onclick="window.focusShellTab(0);" class="active"><p>MAIN SHELL</p></li>
            <li id="shell_tab1" onclick="window.focusShellTab(1);"><p>EMPTY</p></li>
            <li id="shell_tab2" onclick="window.focusShellTab(2);"><p>EMPTY</p></li>
            <li id="shell_tab3" onclick="window.focusShellTab(3);"><p>EMPTY</p></li>
            <li id="shell_tab4" onclick="window.focusShellTab(4);"><p>EMPTY</p></li>
        </ul>
        <div id="main_shell_innercontainer">
            <pre id="terminal0" class="active"></pre>
            <pre id="terminal1"></pre>
            <pre id="terminal2"></pre>
            <pre id="terminal3"></pre>
            <pre id="terminal4"></pre>
        </div>`;
    window.term = {
        0: new Terminal({
            role: "client",
            parentId: "terminal0",
            port: window.settings.port || 3000
        })
    };
    window.currentTerm = 0;
    window.term[0].onprocesschange = p => {
        document.getElementById("shell_tab0").innerHTML = `<p>MAIN - ${p}</p>`;
    };
    // Prevent losing hardware keyboard focus on the terminal when using touch keyboard
    window.onmouseup = e => {
        if (window.keyboard.linkedToTerm) window.term[window.currentTerm].term.focus();
    };
    globalThis.term[0].term.writeln("\u001b[1m"+`Welcome to nDEX-UI v${remote.app.getVersion()} - Electron v${process.versions.electron}`+"\u001b[0m");

    await _delay(100);

    // Anchor main_shell to the top NOW that xterm has had a chance to
    // initialize its WebGL canvas against the body's default centered
    // flex layout. Applying align-self in CSS from the start confuses
    // the canvas paint and the terminal boots with the body background
    // showing through. Applying it post-boot via JS gives us the
    // top-anchored growth animation for Ctrl+Shift+B without breaking
    // the initial render.
    document.getElementById("main_shell").style.alignSelf = "flex-start";

    // The inline filesystem panel was retired in favor of the two-pane
    // FsModal (Ctrl+Shift+E). The terminal still tracks its own CWD —
    // resend it after a hot reload so anything else relying on
    // term.cwd (e.g. fuzzyFinder) has fresh state.
    if (globalThis.performance.getEntriesByType("navigation")[0]?.type === "reload") {
        window.term[window.currentTerm].resendCWD();
    }

    await _delay(200);

    window.updateCheck = new UpdateChecker();
}

window.themeChanger = theme => {
    ipc.send("setThemeOverride", theme);
    setTimeout(() => {
        window.location.reload(true);
    }, 100);
};

window.remakeKeyboard = layout => {
    document.getElementById("keyboard").innerHTML = "";
    window.keyboard = new Keyboard({
        layout: path.join(keyboardsDir, layout+".json" || settings.keyboard+".json"),
        container: "keyboard"
    });
    ipc.send("setKbOverride", layout);
};

window.focusShellTab = number => {
    window.audioManager.folder.play();

    if (number !== window.currentTerm && window.term[number]) {
        window.currentTerm = number;

        document.querySelectorAll(`ul#main_shell_tabs > li:not(:nth-child(${number+1}))`).forEach(e => {
            e.setAttribute("class", "");
        });
        document.getElementById("shell_tab"+number).setAttribute("class", "active");

        document.querySelectorAll(`div#main_shell_innercontainer > pre:not(:nth-child(${number+1}))`).forEach(e => {
            e.setAttribute("class", "");
        });
        document.getElementById("terminal"+number).setAttribute("class", "active");

        window.term[number].fit();
        window.term[number].term.focus();
        window.term[number].resendCWD();
    } else if (number > 0 && number <= 4 && window.term[number] !== null && typeof window.term[number] !== "object") {
        window.term[number] = null;

        document.getElementById("shell_tab"+number).innerHTML = "<p>LOADING...</p>";
        ipc.send("ttyspawn", "true");
        ipc.once("ttyspawn-reply", (e, r) => {
            if (r.startsWith("ERROR")) {
                document.getElementById("shell_tab"+number).innerHTML = "<p>ERROR</p>";
            } else if (r.startsWith("SUCCESS")) {
                let port = Number(r.substr(9));

                window.term[number] = new Terminal({
                    role: "client",
                    parentId: "terminal"+number,
                    port
                });

                window.term[number].onclose = e => {
                    delete window.term[number].onprocesschange;
                    document.getElementById("shell_tab"+number).innerHTML = "<p>EMPTY</p>";
                    document.getElementById("terminal"+number).innerHTML = "";
                    window.term[number].term.dispose();
                    delete window.term[number];
                    window.useAppShortcut("PREVIOUS_TAB");
                };

                window.term[number].onprocesschange = p => {
                    document.getElementById("shell_tab"+number).innerHTML = `<p>#${number+1} - ${p}</p>`;
                };

                document.getElementById("shell_tab"+number).innerHTML = `<p>::${port}</p>`;
                setTimeout(() => {
                    window.focusShellTab(number);
                }, 500);
            }
        });
    }
};

// Settings editor
window.openSettings = async () => {
    // The DOM-only guard isn't enough: the `await
    // window.si.networkInterfaces()` below means N rapid presses of
    // Ctrl+Shift+S all pass the guard before the first modal lands
    // in the DOM, stacking N copies (#50). Pair the DOM check with
    // an in-flight flag set synchronously after the guard and
    // cleared in finally, so only the first call wins the race.
    if (window._settingsOpening || document.getElementById("settingsEditor")) return;
    window._settingsOpening = true;
    try {

    // Build lists of available keyboards, themes, monitors
    let keyboards, themes, monitors, ifaces;
    fs.readdirSync(keyboardsDir).forEach(kb => {
        if (!kb.endsWith(".json")) return;
        kb = kb.replace(".json", "");
        if (kb === window.settings.keyboard) return;
        keyboards += `<option>${kb}</option>`;
    });
    fs.readdirSync(themesDir).forEach(th => {
        if (!th.endsWith(".json")) return;
        th = th.replace(".json", "");
        if (th === window.settings.theme) return;
        themes += `<option>${th}</option>`;
    });
    for (let i = 0; i < remote.screen.getAllDisplays().length; i++) {
        if (i !== window.settings.monitor) monitors += `<option>${i}</option>`;
    }
    let nets = await window.si.networkInterfaces();
    nets.forEach(net => {
        if (net.iface !== window.mods.netstat.iface) ifaces += `<option>${net.iface}</option>`;
    });

    // Unlink the tactile keyboard from the terminal emulator to allow filling in the settings fields
    window.keyboard.detach();

    new Modal({
        type: "custom",
        title: `Settings <i>(v${remote.app.getVersion()})</i>`,
        html: `<table id="settingsEditor">
                    <tr>
                        <th>Key</th>
                        <th>Description</th>
                        <th>Value</th>
                    </tr>
                    <tr>
                        <td>shell</td>
                        <td>The program to run as a terminal emulator</td>
                        <td><input type="text" id="settingsEditor-shell" value="${window.settings.shell}"></td>
                    </tr>
                    <tr>
                        <td>shellArgs</td>
                        <td>Arguments to pass to the shell</td>
                        <td><input type="text" id="settingsEditor-shellArgs" value="${window.settings.shellArgs || ''}"></td>
                    </tr>
                    <tr>
                        <td>cwd</td>
                        <td>Working Directory to start in</td>
                        <td><input type="text" id="settingsEditor-cwd" value="${window.settings.cwd}"></td>
                    </tr>
                    <tr>
                        <td>env</td>
                        <td>Custom shell environment override</td>
                        <td><input type="text" id="settingsEditor-env" value="${window.settings.env}"></td>
                    </tr>
                    <tr>
                        <td>username</td>
                        <td>Custom username to display at boot</td>
                        <td><input type="text" id="settingsEditor-username" value="${window.settings.username}"></td>
                    </tr>
                    <tr>
                        <td>keyboard</td>
                        <td>On-screen keyboard layout code</td>
                        <td><select id="settingsEditor-keyboard">
                            <option>${window.settings.keyboard}</option>
                            ${keyboards}
                        </select></td>
                    </tr>
                    <tr>
                        <td>theme</td>
                        <td>Name of the theme to load</td>
                        <td><select id="settingsEditor-theme">
                            <option>${window.settings.theme}</option>
                            ${themes}
                        </select></td>
                    </tr>
                    <tr>
                        <td>termFontSize</td>
                        <td>Size of the terminal text in pixels</td>
                        <td><input type="number" id="settingsEditor-termFontSize" value="${window.settings.termFontSize}"></td>
                    </tr>
                    <tr>
                        <td>audio</td>
                        <td>Activate audio sound effects</td>
                        <td><select id="settingsEditor-audio">
                            <option>${window.settings.audio}</option>
                            <option>${!window.settings.audio}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>audioVolume</td>
                        <td>Set default volume for sound effects (0.0 - 1.0)</td>
                        <td><input type="number" id="settingsEditor-audioVolume" value="${window.settings.audioVolume || '1.0'}"></td>
                    </tr>
                    <tr>
                        <td>disableFeedbackAudio</td>
                        <td>Disable recurring feedback sound FX (input/output, mostly)</td>
                        <td><select id="settingsEditor-disableFeedbackAudio">
                            <option>${window.settings.disableFeedbackAudio}</option>
                            <option>${!window.settings.disableFeedbackAudio}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>port</td>
                        <td>Local port to use for UI-shell connection</td>
                        <td><input type="number" id="settingsEditor-port" value="${window.settings.port}"></td>
                    </tr>
                    <tr>
                        <td>pingAddr</td>
                        <td>IPv4 address to test Internet connectivity</td>
                        <td><input type="text" id="settingsEditor-pingAddr" value="${window.settings.pingAddr || "1.1.1.1"}"></td>
                    </tr>
                    <tr>
                        <td>clockHours</td>
                        <td>Clock format (12/24 hours)</td>
                        <td><select id="settingsEditor-clockHours">
                            <option>${(window.settings.clockHours === 12) ? "12" : "24"}</option>
                            <option>${(window.settings.clockHours === 12) ? "24" : "12"}</option>
                        </select></td>
                    <tr>
                        <td>monitor</td>
                        <td>Which monitor to spawn the UI in (defaults to primary display)</td>
                        <td><select id="settingsEditor-monitor">
                            ${(typeof window.settings.monitor !== "undefined") ? "<option>"+window.settings.monitor+"</option>" : ""}
                            ${monitors}
                        </select></td>
                    </tr>
                    <tr>
                        <td>nointro</td>
                        <td>Skip the intro boot log and logo${(window.settings.nointroOverride) ? " (Currently overridden by CLI flag)" : ""}</td>
                        <td><select id="settingsEditor-nointro">
                            <option>${window.settings.nointro}</option>
                            <option>${!window.settings.nointro}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>nocursor</td>
                        <td>Hide the mouse cursor${(window.settings.nocursorOverride) ? " (Currently overridden by CLI flag)" : ""}</td>
                        <td><select id="settingsEditor-nocursor">
                            <option>${window.settings.nocursor}</option>
                            <option>${!window.settings.nocursor}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>iface</td>
                        <td>Override the interface used for network monitoring</td>
                        <td><select id="settingsEditor-iface">
                            <option>${window.mods.netstat.iface}</option>
                            ${ifaces}
                        </select></td>
                    </tr>
                    <tr>
                        <td>allowWindowed</td>
                        <td>Allow using F11 key to set the UI in windowed mode</td>
                        <td><select id="settingsEditor-allowWindowed">
                            <option>${window.settings.allowWindowed}</option>
                            <option>${!window.settings.allowWindowed}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>keepGeometry</td>
                        <td>Try to keep a 16:9 aspect ratio in windowed mode</td>
                        <td><select id="settingsEditor-keepGeometry">
                            <option>${(window.settings.keepGeometry === false) ? 'false' : 'true'}</option>
                            <option>${(window.settings.keepGeometry === false) ? 'true' : 'false'}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>excludeThreadsFromToplist</td>
                        <td>Display threads in the top processes list</td>
                        <td><select id="settingsEditor-excludeThreadsFromToplist">
                            <option>${window.settings.excludeThreadsFromToplist}</option>
                            <option>${!window.settings.excludeThreadsFromToplist}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>hideDotfiles</td>
                        <td>Hide files and directories starting with a dot in file display</td>
                        <td><select id="settingsEditor-hideDotfiles">
                            <option>${window.settings.hideDotfiles}</option>
                            <option>${!window.settings.hideDotfiles}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>fsListView</td>
                        <td>Show files in a more detailed list instead of an icon grid</td>
                        <td><select id="settingsEditor-fsListView">
                            <option>${window.settings.fsListView}</option>
                            <option>${!window.settings.fsListView}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>spawnOnTabCycle</td>
                        <td>When cycling tabs with Ctrl+Tab / Ctrl+Shift+Tab, spawn a new terminal into any empty slot the cycle passes through. When false, the cycle only switches between already-initialized tabs.</td>
                        <td><select id="settingsEditor-spawnOnTabCycle">
                            <option>${window.settings.spawnOnTabCycle !== false}</option>
                            <option>${window.settings.spawnOnTabCycle === false}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>modalCloseButton</td>
                        <td>Show the &quot;Close&quot; button at the bottom of modal popups. When false, modals are closed via Esc only (Esc is wired globally and works for every modal regardless of this setting).</td>
                        <td><select id="settingsEditor-modalCloseButton">
                            <option>${window.settings.modalCloseButton !== false}</option>
                            <option>${window.settings.modalCloseButton === false}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>ttsVoice</td>
                        <td>Voice used by the Claude Chat neural TTS (Kokoro-82M). All voices share the same model file, so switching is free once the model is cached. Grades come from kokoro-js's own voice index.</td>
                        <td><select id="settingsEditor-ttsVoice">
                            ${(() => {
                                const cur = window.settings.ttsVoice || "af_heart";
                                const list = (typeof ClaudeChat !== "undefined" && ClaudeChat.VOICES) ? ClaudeChat.VOICES : [{id: cur, grade: "", region: "", gender: ""}];
                                const label = (v) => {
                                    const tail = [v.grade, [v.region, v.gender].filter(Boolean).join("/"), v.traits].filter(Boolean).join(", ");
                                    return tail ? `${v.id} (${tail})` : v.id;
                                };
                                const curObj = list.find(v => v.id === cur) || {id: cur, grade: "", region: "", gender: ""};
                                const ordered = [curObj, ...list.filter(v => v.id !== cur)];
                                return ordered.map(v => `<option value="${v.id}">${label(v)}</option>`).join("");
                            })()}
                        </select></td>
                    </tr>
                    <tr>
                        <td>ttsDtype</td>
                        <td>Quantization for the Kokoro TTS model. Each tier is fetched on demand on first use and cached locally; the old tier stays cached, so switching back is free.</td>
                        <td><select id="settingsEditor-ttsDtype">
                            ${(() => {
                                const cur = window.settings.ttsDtype || "q8";
                                const list = (typeof ClaudeChat !== "undefined" && ClaudeChat.DTYPES)
                                    ? ClaudeChat.DTYPES
                                    : [{id: cur, label: cur}];
                                const ordered = [
                                    list.find(d => d.id === cur) || {id: cur, label: cur},
                                    ...list.filter(d => d.id !== cur)
                                ];
                                return ordered.map(d => `<option value="${d.id}">${d.label}</option>`).join("");
                            })()}
                        </select></td>
                    </tr>
                    <tr>
                        <td>chatBackend</td>
                        <td>Which backend the Claude Chat modal sends turns to. <code>claude-cli</code> uses the locally-installed authenticated <code>claude</code> CLI (online, full toolset). <code>gemma-local</code> runs Gemma 4 E4B ONNX in-app via WebGPU (offline, no tools).</td>
                        <td><select id="settingsEditor-chatBackend">
                            ${(() => {
                                const curRaw = window.settings.chatBackend;
                                // Migrate pre-#88 short names so the dropdown
                                // shows the right option even before the user
                                // saves through this editor.
                                const cur = curRaw === "gemma" ? "gemma-local"
                                    : curRaw === "cli" ? "claude-cli"
                                    : (curRaw || "claude-cli");
                                const list = (typeof ClaudeChat !== "undefined" && ClaudeChat.CHAT_BACKENDS)
                                    ? ClaudeChat.CHAT_BACKENDS
                                    : [{id: cur, label: cur}];
                                const ordered = [
                                    list.find(b => b.id === cur) || {id: cur, label: cur},
                                    ...list.filter(b => b.id !== cur)
                                ];
                                // If the WebGPU probe came back unavailable,
                                // grey out the gemma-local option with the
                                // probe's reason in the tooltip. Leaving it
                                // visible (rather than removing it) keeps the
                                // dropdown consistent across machines and lets
                                // users see why the backend is gated. When the
                                // saved backend is `gemma-local` AND it's
                                // disabled, we'd otherwise put a disabled
                                // option at the top of the list — push it to
                                // the end in that case so the dropdown opens
                                // on the selectable claude-cli option instead.
                                const av = window.gemmaEngine?.availability;
                                const gemmaDown = av?.state === "unavailable";
                                const reason = gemmaDown ? (av.reason || "WebGPU not supported.") : "";
                                const renderOrder = gemmaDown
                                    ? [...ordered.filter(b => b.id !== "gemma-local"), ...ordered.filter(b => b.id === "gemma-local")]
                                    : ordered;
                                return renderOrder.map(b => {
                                    const disable = gemmaDown && b.id === "gemma-local";
                                    const title = disable ? ` title="${window._escapeHtml(reason)}"` : "";
                                    const suffix = disable ? " — unavailable" : "";
                                    return `<option value="${b.id}"${disable ? " disabled" : ""}${title}>${b.label}${suffix}</option>`;
                                }).join("");
                            })()}
                        </select></td>
                    </tr>
                    <tr>
                        <td>gemmaDtype</td>
                        <td>Quantization for the local Gemma 4 E4B ONNX model. Multi-GB download on first use, cached locally afterwards; switching tiers re-downloads but old tiers stay cached.</td>
                        <td><select id="settingsEditor-gemmaDtype">
                            ${(() => {
                                const cur = window.settings.gemmaDtype || "q4f16";
                                const list = (typeof ClaudeChat !== "undefined" && ClaudeChat.GEMMA_DTYPES)
                                    ? ClaudeChat.GEMMA_DTYPES
                                    : [{id: cur, label: cur}];
                                const ordered = [
                                    list.find(d => d.id === cur) || {id: cur, label: cur},
                                    ...list.filter(d => d.id !== cur)
                                ];
                                return ordered.map(d => `<option value="${d.id}">${d.label}</option>`).join("");
                            })()}
                        </select></td>
                    </tr>
                    <tr>
                        <td>experimentalGlobeFeatures</td>
                        <td>Toggle experimental features for the network globe</td>
                        <td><select id="settingsEditor-experimentalGlobeFeatures">
                            <option>${window.settings.experimentalGlobeFeatures}</option>
                            <option>${!window.settings.experimentalGlobeFeatures}</option>
                        </select></td>
                    </tr>
                    <tr>
                        <td>experimentalFeatures</td>
                        <td>Toggle Chrome's experimental web features (DANGEROUS)</td>
                        <td><select id="settingsEditor-experimentalFeatures">
                            <option>${window.settings.experimentalFeatures}</option>
                            <option>${!window.settings.experimentalFeatures}</option>
                        </select></td>
                    </tr>
                </table>
                <h6 id="settingsEditorStatus">Loaded values from memory</h6>
                <br>`,
        buttons: [
            {label: "Open in External Editor", action:`electron.shell.openPath('${settingsFile}');electronWin.minimize();`},
            {label: "Save to Disk", action: "window.writeSettingsFile()"},
            {label: "Reload UI", action: "window.location.reload(true);"},
            {label: "Restart eDEX", action: "remote.app.relaunch();remote.app.quit();"}
        ]
    }, () => {
        // Link the keyboard back to the terminal
        window.keyboard.attach();

        // Focus back on the term
        window.term[window.currentTerm].term.focus();
    });

    } finally {
        window._settingsOpening = false;
    }
};

window.openControlMenu = () => {
    if (document.getElementById("controlMenu") || document.getElementById("settingsEditor")) return;
    window.activeControlMenu = new ControlMenu();
};

window.openWebApp = (id) => {
    const app = (window.webapps || []).find(a => a.id === id);
    if (!app) {
        Modal.show({ type: "warning", message: `WebApp "${window._escapeHtml(id)}" not found.` });
        return;
    }
    WebApp.show(app);
};

window.openAddWebApp = () => {
    if (document.getElementById("webappAddName")) return;
    window.keyboard.detach();
    Modal.show({
        type: "custom",
        title: "Add WebApp",
        html: `<div style="min-width:50vw">
            <label class="webappAddLabel" for="webappAddName">Name</label>
            <input class="webappAddField" id="webappAddName" type="text" maxlength="60" placeholder="YouTube" />
            <label class="webappAddLabel" for="webappAddUrl">URL (http:// or https://)</label>
            <input class="webappAddField" id="webappAddUrl" type="text" maxlength="500" placeholder="https://example.com" />
            <label class="webappAddLabel" for="webappAddIcon">Icon URL (optional — reserved, not rendered yet)</label>
            <input class="webappAddField" id="webappAddIcon" type="text" maxlength="500" placeholder="" />
            <p style="font-family:var(--font_main_light);font-size:1.1vh;opacity:0.6;margin-top:0.6vh">
                Note: DRM-encrypted streams (YouTube Music, Spotify, Netflix) will not play —
                vanilla Electron lacks Widevine. See issue #30.
            </p>
        </div>`,
        buttons: [
            { label: "Save", action: "window.writeWebAppEntry()" }
        ]
    }, () => {
        window.keyboard.attach();
        window.term[window.currentTerm].term.focus();
    });
    // rAF instead of setTimeout: Modal appends synchronously, but its own
    // focus() runs before this callback would, so we wait one frame to
    // claim the input. setTimeout here trips guardrails' eval-dom rule.
    requestAnimationFrame(() => {
        const n = document.getElementById("webappAddName");
        if (n) n.focus();
    });
};

window.writeWebAppEntry = () => {
    const nameEl = document.getElementById("webappAddName");
    const urlEl = document.getElementById("webappAddUrl");
    const iconEl = document.getElementById("webappAddIcon");
    if (!nameEl || !urlEl) return;
    const name = nameEl.value.trim();
    const url = urlEl.value.trim();
    const icon = iconEl?.value.trim() || null;
    if (!name) {
        Modal.show({ type: "warning", message: "Name is required." });
        return;
    }
    if (!/^https?:\/\//i.test(url)) {
        Modal.show({ type: "warning", message: "URL must start with <code>http://</code> or <code>https://</code>." });
        return;
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id) {
        Modal.show({ type: "warning", message: "Name must contain at least one letter or digit." });
        return;
    }
    if ((window.webapps || []).some(a => a.id === id)) {
        Modal.show({ type: "warning", message: `A WebApp with id "${window._escapeHtml(id)}" already exists. Pick a different name or remove the existing one first.` });
        return;
    }
    window.webapps.push({ id, name, url, icon });
    try {
        fs.writeFileSync(webappsFile, JSON.stringify(window.webapps, "", 4));
    } catch (e) {
        Modal.show({ type: "error", title: "WebApp save failed", message: String(e) });
        return;
    }
    // Drop the cached webapps submenu so the next Control Menu open
    // reflects the new entry.
    if (globalThis.activeControlMenu?._cache) {
        delete window.activeControlMenu._cache.webapps;
    }
    // Close the Add modal — find by the topmost custom modal.
    const stack = (Modal._stack || []).slice().reverse();
    for (const m of stack) {
        if (document.getElementById("webappAddName")) {
            m.close();
            break;
        }
    }
};

// Render the rows for the Manage WebApps table. Built as plain HTML
// strings for the per-row cells (text content is safely HTML-escaped),
// but the Remove button carries the id on a data attribute instead of
// being interpolated into an `onclick="..."` JS string — that pattern
// is XSS-fragile because HTML attribute decoding unescapes &#39; back
// to ' and breaks out of the single-quoted JS literal. The click is
// bound via delegation in openManageWebApps so it survives both the
// initial render and the in-place re-render done by removeWebApp.
window._renderWebAppManageRows = (apps) => {
    if (!apps.length) {
        return `<tr><td colspan="3" style="opacity:0.6">No WebApps installed yet.</td></tr>`;
    }
    return apps.map(app => `
        <tr>
            <td>${window._escapeHtml(app.name)}</td>
            <td style="opacity:0.6">${window._escapeHtml(app.url)}</td>
            <td style="text-align:right"><button type="button" class="webappRemoveBtn" data-webapp-id="${window._escapeHtml(app.id)}">Remove</button></td>
        </tr>`).join("");
};

window.openManageWebApps = () => {
    // Single-instance guard — #webappManageTable is created below.
    // Without this, rapid clicks on "Manage..." stack copies (#52).
    if (document.getElementById("webappManageTable")) return;
    window.keyboard.detach();
    const rows = window._renderWebAppManageRows(window.webapps || []);
    Modal.show({
        type: "custom",
        title: "Manage WebApps",
        html: `<div style="min-width:55vw">
            <table id="webappManageTable">
                <thead><tr><th>Name</th><th>URL</th><th></th></tr></thead>
                <tbody id="webappManageBody">${rows}</tbody>
            </table>
        </div>`,
        buttons: []
    }, () => {
        window.keyboard.attach();
        window.term[window.currentTerm].term.focus();
    });
    const body = document.getElementById("webappManageBody");
    if (body) {
        body.addEventListener("click", (e) => {
            const btn = e.target.closest(".webappRemoveBtn");
            if (!btn) return;
            const id = btn.dataset.webappId;
            if (id) window.removeWebApp(id);
        });
    }
};

window.removeWebApp = (id) => {
    const before = (window.webapps || []).length;
    window.webapps = (window.webapps || []).filter(a => a.id !== id);
    if (window.webapps.length === before) return;
    try {
        fs.writeFileSync(webappsFile, JSON.stringify(window.webapps, "", 4));
    } catch (e) {
        Modal.show({ type: "error", title: "WebApp save failed", message: String(e) });
        return;
    }
    if (globalThis.activeControlMenu?._cache) {
        delete window.activeControlMenu._cache.webapps;
    }
    // The tbody's delegated click handler stays attached across this
    // innerHTML swap because the listener is on the tbody itself.
    const body = document.getElementById("webappManageBody");
    if (body) {
        body.innerHTML = window._renderWebAppManageRows(window.webapps);
    }
};

window.writeFile = (path) => {
    fs.writeFile(path, document.getElementById("fileEdit").value, "utf-8", () => {
        document.getElementById("fedit-status").innerHTML = "<i>File saved.</i>";
    });
};

window.writeSettingsFile = () => {
    window.settings = {
        shell: document.getElementById("settingsEditor-shell").value,
        shellArgs: document.getElementById("settingsEditor-shellArgs").value,
        cwd: document.getElementById("settingsEditor-cwd").value,
        env: document.getElementById("settingsEditor-env").value,
        username: document.getElementById("settingsEditor-username").value,
        keyboard: document.getElementById("settingsEditor-keyboard").value,
        theme: document.getElementById("settingsEditor-theme").value,
        termFontSize: Number(document.getElementById("settingsEditor-termFontSize").value),
        audio: (document.getElementById("settingsEditor-audio").value === "true"),
        audioVolume: Number(document.getElementById("settingsEditor-audioVolume").value),
        disableFeedbackAudio: (document.getElementById("settingsEditor-disableFeedbackAudio").value === "true"),
        pingAddr: document.getElementById("settingsEditor-pingAddr").value,
        clockHours: Number(document.getElementById("settingsEditor-clockHours").value),
        port: Number(document.getElementById("settingsEditor-port").value),
        monitor: Number(document.getElementById("settingsEditor-monitor").value),
        nointro: (document.getElementById("settingsEditor-nointro").value === "true"),
        nocursor: (document.getElementById("settingsEditor-nocursor").value === "true"),
        iface: document.getElementById("settingsEditor-iface").value,
        allowWindowed: (document.getElementById("settingsEditor-allowWindowed").value === "true"),
        forceFullscreen: window.settings.forceFullscreen,
        keepGeometry: (document.getElementById("settingsEditor-keepGeometry").value === "true"),
        excludeThreadsFromToplist: (document.getElementById("settingsEditor-excludeThreadsFromToplist").value === "true"),
        hideDotfiles: (document.getElementById("settingsEditor-hideDotfiles").value === "true"),
        fsListView: (document.getElementById("settingsEditor-fsListView").value === "true"),
        spawnOnTabCycle: (document.getElementById("settingsEditor-spawnOnTabCycle").value === "true"),
        modalCloseButton: (document.getElementById("settingsEditor-modalCloseButton").value === "true"),
        ttsVoice: document.getElementById("settingsEditor-ttsVoice").value,
        ttsDtype: document.getElementById("settingsEditor-ttsDtype").value,
        chatBackend: document.getElementById("settingsEditor-chatBackend").value,
        gemmaDtype: document.getElementById("settingsEditor-gemmaDtype").value,
        experimentalGlobeFeatures: (document.getElementById("settingsEditor-experimentalGlobeFeatures").value === "true"),
        experimentalFeatures: (document.getElementById("settingsEditor-experimentalFeatures").value === "true")
    };

    Object.keys(window.settings).forEach(key => {
        if (window.settings[key] === "undefined") {
            delete window.settings[key];
        }
    });

    fs.writeFileSync(settingsFile, JSON.stringify(window.settings, "", 4));
    document.getElementById("settingsEditorStatus").innerText = "New values written to settings.json file at "+new Date().toTimeString();
};

window.toggleFullScreen = () => {
    let useFullscreen = (electronWin.isFullScreen() ? false : true);
    electronWin.setFullScreen(useFullscreen);

    //Update settings
    window.lastWindowState["useFullscreen"] = useFullscreen;

    fs.writeFileSync(lastWindowStateFile, JSON.stringify(window.lastWindowState, "", 4));
};

// Display available keyboard shortcuts and custom shortcuts helper
const SHORTCUTS_DEFINITION = {
    "COPY": "Copy selected buffer from the terminal.",
    "PASTE": "Paste system clipboard to the terminal.",
    "NEXT_TAB": "Switch to the next opened terminal tab (left to right order).",
    "PREVIOUS_TAB": "Switch to the previous opened terminal tab (right to left order).",
    "TAB_X": "Switch to terminal tab <strong>X</strong>, or create it if it hasn't been opened yet.",
    "SETTINGS": "Open the settings editor.",
    "SHORTCUTS": "List and edit available keyboard shortcuts.",
    "FUZZY_SEARCH": "Search for entries in the current working directory.",
    "FS_OPEN": "Open the two-pane filesystem browser.",
    "FS_LIST_VIEW": "Toggle list / grid view in the focused pane of the filesystem browser.",
    "FS_DOTFILES": "Toggle hidden files in the focused pane of the filesystem browser.",
    "KB_PASSMODE": "Toggle the on-screen keyboard's \"Password Mode\", which allows you to safely<br>type sensitive information even if your screen might be recorded (disable visual input feedback).",
    "KB_TOGGLE": "Show / hide the on-screen keyboard. Hiding it grows the terminal to fill the freed space.",
    "PANELS_TOGGLE": "Show / hide the left + right side panels (system / network widgets). Hiding them grows the terminal horizontally.",
    "DEV_DEBUG": "Open Chromium Dev Tools, for debugging purposes.",
    "DEV_RELOAD": "Trigger front-end hot reload.",
    "CLAUDE_CHAT": "Open the Claude chat modal (talks to the locally installed <code>claude</code> CLI).",
    "CONTROL_MENU": "Open the central control / launcher menu.",
    "WEBAPP_FULLSCREEN": "(Inside a WebApp) Toggle the modal between standard size and full nDEX viewport. Bound to <code>F11</code>.",
    "WEBAPP_TO_TAB": "(Inside a WebApp) Promote the WebApp into a terminal tab slot. Bound to <code>Ctrl+Shift+T</code>. Placeholder until issue #29 lands the tab-bar refactor."
};

// Coerce a shortcuts.json field to a string. The file is user-editable
// so a malformed entry (null, number, object) could otherwise throw
// from `startsWith` / `_escapeHtml` mid-forEach and take out the whole
// shortcuts help modal.
const _shortcutField = (v) => String(v ?? "");

const _renderShortcutsAppList = (shortcuts) => {
    let html = "";
    shortcuts.filter(e => e.type === "app").forEach(cut => {
        const trigger = _shortcutField(cut.trigger);
        const rawAction = _shortcutField(cut.action);
        const action = rawAction.startsWith("TAB_") ? "TAB_X" : rawAction;
        // SHORTCUTS_DEFINITION entries contain intentional inline HTML
        // (<strong>, <code>, <br>) so they are emitted unescaped. The
        // ?? fallback handles user-edited shortcuts.json entries whose
        // action key isn't in the lookup; that path *is* user input, so
        // escape it.
        const description = SHORTCUTS_DEFINITION[action] ?? window._escapeHtml(action);
        html += `<tr>
                        <td>${cut.enabled ? 'YES' : 'NO'}</td>
                        <td><input disabled type="text" maxlength=25 value="${window._escapeHtml(trigger)}"></td>
                        <td>${description}</td>
                    </tr>`;
    });
    return html;
};

const _renderShortcutsCustomList = (shortcuts) => {
    let html = "";
    shortcuts.filter(e => e.type === "shell").forEach(cut => {
        const trigger = _shortcutField(cut.trigger);
        const action = _shortcutField(cut.action);
        html += `<tr>
                            <td>${cut.enabled ? 'YES' : 'NO'}</td>
                            <td><input disabled type="text" maxlength=25 value="${window._escapeHtml(trigger)}"></td>
                            <td>
                                <input disabled type="text" placeholder="Run terminal command..." value="${window._escapeHtml(action)}">
                                <input disabled type="checkbox" name="shortcutsHelpNew_Enter" ${cut.linebreak ? 'checked' : ''}>
                                <label for="shortcutsHelpNew_Enter">Enter</label>
                            </td>
                        </tr>`;
    });
    return html;
};

const _shortcutsHelpHTML = (appList, customList) => `<h5>Using either the on-screen or a physical keyboard, you can use the following shortcuts:</h5>
                <details open id="shortcutsHelpAccordeon1">
                    <summary>Emulator shortcuts</summary>
                    <table class="shortcutsHelp">
                        <tr>
                            <th>Enabled</th>
                            <th>Trigger</th>
                            <th>Action</th>
                        </tr>
                        ${appList}
                    </table>
                </details>
                <br>
                <details id="shortcutsHelpAccordeon2">
                    <summary>Custom command shortcuts</summary>
                    <table class="shortcutsHelp">
                        <tr>
                            <th>Enabled</th>
                            <th>Trigger</th>
                            <th>Command</th>
                        </tr>
                       ${customList}
                    </table>
                </details>
                <br>`;

const _shortcutsHelpOnClose = () => {
    window.keyboard.attach();
    window.term[window.currentTerm].term.focus();
};

// Mirror the two <details> accordions so opening one auto-closes the other.
const _wireShortcutsAccordions = () => {
    const wrap1 = document.getElementById('shortcutsHelpAccordeon1');
    const wrap2 = document.getElementById('shortcutsHelpAccordeon2');
    wrap1.addEventListener('toggle', () => { wrap2.open = !wrap1.open; });
    wrap2.addEventListener('toggle', () => { wrap1.open = !wrap2.open; });
};

window.openShortcutsHelp = () => {
    // Also guard on this modal's own DOM (#shortcutsHelpAccordeon1
    // is created below) so rapid Ctrl+Shift+K presses don't stack
    // copies — same hazard as #50.
    if (document.getElementById("settingsEditor") || document.getElementById("shortcutsHelpAccordeon1")) return;

    const appList = _renderShortcutsAppList(window.shortcuts);
    const customList = _renderShortcutsCustomList(window.shortcuts);

    window.keyboard.detach();
    new Modal({
        type: "custom",
        title: `Available Keyboard Shortcuts <i>(v${remote.app.getVersion()})</i>`,
        html: _shortcutsHelpHTML(appList, customList),
        buttons: [
            {label: "Open Shortcuts File", action:`electron.shell.openPath('${shortcutsFile}');electronWin.minimize();`},
            {label: "Reload UI", action: "window.location.reload(true);"},
        ]
    }, _shortcutsHelpOnClose);

    _wireShortcutsAccordions();
};

window.useAppShortcut = action => {
    switch(action) {
        case "COPY":
            window.term[window.currentTerm].clipboard.copy();
            return true;
        case "PASTE":
            window.term[window.currentTerm].clipboard.paste();
            return true;
        case "NEXT_TAB": {
            // spawnOnTabCycle (default true): cycle through all 5 slots and
            // let focusShellTab() spawn a TTY into any empty one. When the
            // user explicitly sets it false, fall back to the legacy
            // skip-empty-slots behavior so cycling only walks already-
            // initialized tabs.
            if (window.settings.spawnOnTabCycle !== false) {
                const cur = window.currentTerm || 0;
                window.focusShellTab((cur + 1) % 5);
            } else {
                const j = window.currentTerm || 0;
                if (window.term[j+1]) {
                    window.focusShellTab(j+1);
                } else if (window.term[j+2]) {
                    window.focusShellTab(j+2);
                } else if (window.term[j+3]) {
                    window.focusShellTab(j+3);
                } else if (window.term[j+4]) {
                    window.focusShellTab(j+4);
                } else {
                    window.focusShellTab(0);
                }
            }
            return true;
        }
        case "PREVIOUS_TAB": {
            if (window.settings.spawnOnTabCycle !== false) {
                const cur = window.currentTerm || 0;
                window.focusShellTab((cur + 4) % 5);
            } else {
                let i = window.currentTerm || 4;
                if (window.term[i] && i !== window.currentTerm) {
                    window.focusShellTab(i);
                } else if (window.term[i-1]) {
                    window.focusShellTab(i-1);
                } else if (window.term[i-2]) {
                    window.focusShellTab(i-2);
                } else if (window.term[i-3]) {
                    window.focusShellTab(i-3);
                } else if (window.term[i-4]) {
                    window.focusShellTab(i-4);
                }
            }
            return true;
        }
        case "TAB_1":
            window.focusShellTab(0);
            return true;
        case "TAB_2":
            window.focusShellTab(1);
            return true;
        case "TAB_3":
            window.focusShellTab(2);
            return true;
        case "TAB_4":
            window.focusShellTab(3);
            return true;
        case "TAB_5":
            window.focusShellTab(4);
            return true;
        case "SETTINGS":
            window.openSettings();
            return true;
        case "SHORTCUTS":
            window.openShortcutsHelp();
            return true;
        case "FUZZY_SEARCH":
            window.activeFuzzyFinder = new FuzzyFinder();
            return true;
        case "FS_OPEN":
            window.FsModal.open();
            return true;
        case "FS_LIST_VIEW":
            // Applies to the focused pane inside the open FsModal;
            // no-op when the modal isn't open.
            if (globalThis.FsModal?._instance?.focusedPane) {
                window.FsModal._instance.focusedPane.toggleListview();
            }
            return true;
        case "FS_DOTFILES":
            if (globalThis.FsModal?._instance?.focusedPane) {
                window.FsModal._instance.focusedPane.toggleHidedotfiles();
            }
            return true;
        case "KB_PASSMODE":
            window.keyboard.togglePasswordMode();
            return true;
        case "KB_TOGGLE":
            document.body.classList.toggle("keyboardHidden");
            // Re-fit xterm after the CSS height transition settles.
            setTimeout(() => {
                if (globalThis.term?.[globalThis.currentTerm]) {
                    try { window.term[window.currentTerm].fit(); } catch (_) {}
                }
            }, 550);
            return true;
        case "PANELS_TOGGLE":
            document.body.classList.toggle("panelsHidden");
            // Re-fit xterm after the CSS width transition settles
            // (main_shell already transitions width over 0.5s).
            setTimeout(() => {
                if (globalThis.term?.[globalThis.currentTerm]) {
                    try { window.term[window.currentTerm].fit(); } catch (_) {}
                }
            }, 550);
            return true;
        case "DEV_DEBUG":
            remote.getCurrentWindow().webContents.toggleDevTools();
            return true;
        case "DEV_RELOAD":
            window.location.reload(true);
            return true;
        case "CLAUDE_CHAT":
            window.ClaudeChat.open();
            return true;
        case "CONTROL_MENU":
            window.openControlMenu();
            return true;
        default:
            console.warn(`Unknown "${action}" app shortcut action`);
            return false;
    }
};

// Global keyboard shortcuts
const globalShortcut = remote.globalShortcut;
globalShortcut.unregisterAll();

window.registerKeyboardShortcuts = () => {
    window.shortcuts.forEach(cut => {
        if (!cut.enabled) return;

        if (cut.type === "app") {
            if (cut.action === "TAB_X") {
                for (let i = 1; i <= 5; i++) {
                    let trigger = cut.trigger.replace("X", i);
                    let dfn = () => { window.useAppShortcut(`TAB_${i}`) };
                    globalShortcut.register(trigger, dfn);
                }
            } else {
                globalShortcut.register(cut.trigger, () => {
                    window.useAppShortcut(cut.action);
                });
            }
        } else if (cut.type === "shell") {
            globalShortcut.register(cut.trigger, () => {
                let fn = (cut.linebreak) ? "writelr" : "write";
                window.term[window.currentTerm][fn](cut.action);
            });
        } else {
            console.warn(`${cut.trigger} has unknown type`);
        }
    });
};
window.registerKeyboardShortcuts();

// See #361
window.addEventListener("focus", () => {
    window.registerKeyboardShortcuts();
});

window.addEventListener("blur", () => {
    globalShortcut.unregisterAll();
});

// Prevent showing menu, exiting fullscreen or app with keyboard shortcuts
document.addEventListener("keydown", e => {
    if (e.key === "Alt") {
        e.preventDefault();
    }
    if (e.code.startsWith("Alt") && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
    }
    if (e.key === "F11" && !settings.allowWindowed) {
        e.preventDefault();
    }
    if (e.code === "KeyD" && e.ctrlKey) {
        e.preventDefault();
    }
    if (e.code === "KeyA" && e.ctrlKey) {
        e.preventDefault();
    }
});

// Fix #265
window.addEventListener("keyup", e => {
    if (require("os").platform() === "win32" && e.key === "F4" && e.altKey === true) {
        remote.app.quit();
    }
});

// Fix double-tap zoom on touchscreens
electron.webFrame.setVisualZoomLevelLimits(1, 1);

// Resize terminal with window
window.onresize = () => {
    if (typeof window.currentTerm !== "undefined") {
        if (typeof window.term[window.currentTerm] !== "undefined") {
            window.term[window.currentTerm].fit();
        }
    }
};

// See #413
window.resizeTimeout = null;
let electronWin = remote.getCurrentWindow();
electronWin.on("resize", () => {
    if (settings.keepGeometry === false) return;
    clearTimeout(window.resizeTimeout);
    window.resizeTimeout = setTimeout(() => {
        let win = remote.getCurrentWindow();
        if (win.isFullScreen()) return false;
        if (win.isMaximized()) {
            win.unmaximize();
            win.setFullScreen(true);
            return false;
        }

        let size = win.getSize();

        if (size[0] >= size[1]) {
            win.setSize(size[0], parseInt(size[0] * 9 / 16));
        } else {
            win.setSize(size[1], parseInt(size[1] * 9 / 16));
        }
    }, 100);
});

electronWin.on("leave-full-screen", () => {
    remote.getCurrentWindow().setSize(960, 540);
});
