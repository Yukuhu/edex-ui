const signale = require("./utils/logger.js");
const {app, BrowserWindow, dialog, shell} = require("electron");

process.on("uncaughtException", e => {
    // EPIPE on stdout/stderr is benign — happens when piping log output
    // to a process that closed its read end, or when an IPC subprocess
    // dies mid-write during shutdown. Skip both the fatal log and the
    // user-facing crash dialog for it.
    if (e?.code === "EPIPE") {
        return;
    }
    signale.fatal(e);
    dialog.showErrorBox("nDEX-UI crashed", e.message || "Cannot retrieve error message.");
    if (tty) {
        tty.close();
    }
    if (extraTtys) {
        Object.keys(extraTtys).forEach(key => {
            if (extraTtys[key] !== null) {
                extraTtys[key].close();
            }
        });
    }
    process.exit(1);
});

// Disable Chromium's site isolation so embedded <webview> content
// (the WebApps launcher, src/classes/webApp.class.js) renders in the
// parent's process and shares its hit-test grid. Required to work
// around an Electron + Wayland fractional-scaling bug where OOPIF
// pointer events land in wrong webview coordinates — observed as
// "real mouse clicks do nothing inside YouTube/GitHub" while
// programmatic .click() succeeded. Must be set before app.whenReady().
app.commandLine.appendSwitch("disable-site-isolation-trials");
app.commandLine.appendSwitch("disable-features", "IsolateOrigins,site-per-process");

signale.start(`Starting nDEX-UI v${app.getVersion()}`);
signale.info(`With Node ${process.versions.node} and Electron ${process.versions.electron}`);
signale.info(`Renderer is Chrome ${process.versions.chrome}`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    signale.fatal("Error: Another instance of eDEX is already running. Cannot proceed.");
    app.exit(1);
}

signale.time("Startup");

const electron = require("electron");
require('@electron/remote/main').initialize()
const ipc = electron.ipcMain;
const path = require("node:path");
const url = require("node:url");
const fs = require("node:fs");
const which = require("which");
const Terminal = require("./classes/terminal.class.js").Terminal;

ipc.on("log", (e, type, content) => {
    signale[type](content);
});

let win, tty, extraTtys;
const settingsFile = path.join(electron.app.getPath("userData"), "settings.json");
const shortcutsFile = path.join(electron.app.getPath("userData"), "shortcuts.json");
const webappsFile = path.join(electron.app.getPath("userData"), "webapps.json");
const lastWindowStateFile = path.join(electron.app.getPath("userData"), "lastWindowState.json");
const themesDir = path.join(electron.app.getPath("userData"), "themes");
const innerThemesDir = path.join(__dirname, "assets/themes");
const kblayoutsDir = path.join(electron.app.getPath("userData"), "keyboards");
const innerKblayoutsDir = path.join(__dirname, "assets/kb_layouts");
const fontsDir = path.join(electron.app.getPath("userData"), "fonts");
const innerFontsDir = path.join(__dirname, "assets/fonts");

// Unset proxy env variables to avoid connection problems on the internal websockets
// See #222
if (process.env.http_proxy) delete process.env.http_proxy;
if (process.env.https_proxy) delete process.env.https_proxy;

// Bypass GPU acceleration blocklist, trading a bit of stability for a great deal of performance, mostly on Linux
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-video-decode");

// Fix userData folder not setup on Windows
try {
    fs.mkdirSync(electron.app.getPath("userData"));
    signale.info(`Created config dir at ${electron.app.getPath("userData")}`);
} catch(e) {
    signale.info(`Base config dir is ${electron.app.getPath("userData")}`);
}
// First-launch defaults + post-install migrations live in
// `src/utils/settingsSerializer.js` (`defaultSettings`) and
// `src/utils/shortcutDefaults.js` (`DEFAULT_SHORTCUTS` /
// `MIGRATIONS`) — the renderer requires the same modules so adding
// a setting / shortcut is a one-file change. Issue #174.
const { defaultSettings } = require("./utils/settingsSerializer.js");
const { DEFAULT_SHORTCUTS, MIGRATIONS } = require("./utils/shortcutDefaults.js");

// Create default settings file
if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings({
        platform: process.platform,
        userDataDir: electron.app.getPath("userData")
    }), "", 4));
    signale.info(`Default settings written to ${settingsFile}`);
}
// Create default shortcuts file
if (!fs.existsSync(shortcutsFile)) {
    fs.writeFileSync(shortcutsFile, JSON.stringify(DEFAULT_SHORTCUTS, "", 4));
    signale.info(`Default keymap written to ${shortcutsFile}`);
} else {
    // Run post-install migrations against the existing shortcuts.json
    // so users upgrading from an older version pick up new bindings
    // and re-bindings without having to delete the file.
    try {
        const cur = JSON.parse(fs.readFileSync(shortcutsFile, "utf-8"));
        let changed = false;
        for (const migration of MIGRATIONS) {
            if (migration.apply(cur)) {
                signale.info(`shortcuts.json migration applied: ${migration.description}`);
                changed = true;
            }
        }
        if (changed) fs.writeFileSync(shortcutsFile, JSON.stringify(cur, "", 4));
    } catch (e) {
        signale.warn("shortcuts.json migration failed:", e);
    }
}
// Create / backfill the WebApps registry (src/classes/webApp.class.js).
// Curated starter list — DRM-encrypted sites (YouTube Music, Spotify,
// Netflix) are intentionally omitted from the seed because vanilla
// Electron lacks Widevine.
const WEBAPP_SEEDS = [
    { id: "youtube", name: "YouTube",     url: "https://www.youtube.com",       icon: null },
    { id: "reddit",  name: "Reddit",      url: "https://www.reddit.com",        icon: null },
    { id: "hn",      name: "Hacker News", url: "https://news.ycombinator.com",  icon: null },
    { id: "github",  name: "GitHub",      url: "https://github.com",            icon: null }
];
if (!fs.existsSync(webappsFile)) {
    fs.writeFileSync(webappsFile, JSON.stringify(WEBAPP_SEEDS, "", 4));
    signale.info(`Default WebApps written to ${webappsFile}`);
} else {
    try {
        const cur = JSON.parse(fs.readFileSync(webappsFile, "utf-8"));
        let changed = false;
        for (const seed of WEBAPP_SEEDS) {
            if (!cur.some(a => a.id === seed.id)) {
                cur.push(seed);
                changed = true;
                signale.info(`Backfilled WebApp "${seed.id}" into existing webapps.json`);
            }
        }
        if (changed) fs.writeFileSync(webappsFile, JSON.stringify(cur, "", 4));
    } catch (e) {
        signale.warn("WebApps backfill failed:", e);
    }
}
//Create default window state file
if(!fs.existsSync(lastWindowStateFile)) {
    fs.writeFileSync(lastWindowStateFile, JSON.stringify({
        useFullscreen: true
    }, "", 4));
    signale.info(`Default last window state written to ${lastWindowStateFile}`);
}

// Copy default themes & keyboard layouts & fonts
signale.pending("Mirroring internal assets...");
try {
    fs.mkdirSync(themesDir);
} catch(e) {
    // Folder already exists
}
fs.readdirSync(innerThemesDir).forEach(e => {
    fs.writeFileSync(path.join(themesDir, e), fs.readFileSync(path.join(innerThemesDir, e), {encoding:"utf-8"}));
});
try {
    fs.mkdirSync(kblayoutsDir);
} catch(e) {
    // Folder already exists
}
fs.readdirSync(innerKblayoutsDir).forEach(e => {
    fs.writeFileSync(path.join(kblayoutsDir, e), fs.readFileSync(path.join(innerKblayoutsDir, e), {encoding:"utf-8"}));
});
try {
    fs.mkdirSync(fontsDir);
} catch(e) {
    // Folder already exists
}
fs.readdirSync(innerFontsDir).forEach(e => {
    fs.writeFileSync(path.join(fontsDir, e), fs.readFileSync(path.join(innerFontsDir, e)));
});

// Version history logging
const versionHistoryPath = path.join(electron.app.getPath("userData"), "versions_log.json");
const versionHistory = fs.existsSync(versionHistoryPath) ? require(versionHistoryPath) : {};
const version = app.getVersion();
if (typeof versionHistory[version] === "undefined") {
	versionHistory[version] = {
		firstSeen: Date.now(),
		lastSeen: Date.now()
	};
} else {
	versionHistory[version].lastSeen = Date.now();
}
fs.writeFileSync(versionHistoryPath, JSON.stringify(versionHistory, 0, 2), {encoding:"utf-8"});

function createWindow(settings) {
    signale.info("Creating window...");

    let display;
    if (!isNaN(settings.monitor)) {
        display = electron.screen.getAllDisplays()[settings.monitor] || electron.screen.getPrimaryDisplay();
    } else {
        display = electron.screen.getPrimaryDisplay();
    }
    let {x, y, width, height} = display.bounds;
    win = new BrowserWindow({
        title: "nDEX-UI",
        x,
        y,
        width,
        height,
        show: false,
        resizable: true,
        movable: settings.allowWindowed || false,
        fullscreen: settings.forceFullscreen || false,
        autoHideMenuBar: true,
        frame: settings.allowWindowed || false,
        backgroundColor: '#000000',
        webPreferences: {
            devTools: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: true,
            nodeIntegration: true,
            nodeIntegrationInSubFrames: false,
            // Lets the chat-modal's TTS worker (src/workers/tts-worker.js)
            // require("kokoro-js") + @huggingface/transformers off the
            // renderer's JS thread, so synthesis doesn't block UI.
            nodeIntegrationInWorker: true,
            // Enables the <webview> tag used by the WebApps launcher
            // (src/classes/webApp.class.js) to host third-party sites
            // in an isolated Chromium renderer with per-app cookies.
            webviewTag: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: settings.experimentalFeatures || false
        }
    });
    require('@electron/remote/main').enable(win.webContents);

    win.loadURL(url.format({
        pathname: path.join(__dirname, 'ui.html'),
        protocol: 'file:',
        slashes: true
    }));

    signale.complete("Frontend window created!");
    win.show();
    if (!settings.allowWindowed) {
        win.setResizable(false);
    } else if (!require(lastWindowStateFile)["useFullscreen"]) {
        win.setFullScreen(false);
    }

    signale.watch("Waiting for frontend connection...");
}

app.on('ready', async () => {
    signale.pending(`Loading settings file...`);
    let settings = require(settingsFile);
    signale.pending(`Resolving shell path...`);
    settings.shell = await which(settings.shell).catch(e => { throw(e) });
    signale.info(`Shell found at ${settings.shell}`);
    signale.success(`Settings loaded!`);

    if (!require("node:fs").existsSync(settings.cwd)) throw new Error("Configured cwd path does not exist.");

    // See #366
    let cleanEnv = await require("shell-env")(settings.shell).catch(e => { throw e; });

    Object.assign(cleanEnv, {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "nDEX-UI",
        TERM_PROGRAM_VERSION: app.getVersion()
    }, settings.env);

    require("./_main_claude.js").init({ cleanEnv });

    signale.pending(`Creating new terminal process on port ${settings.port || '3000'}`);
    tty = new Terminal({
        role: "server",
        shell: settings.shell,
        params: settings.shellArgs || '',
        cwd: settings.cwd,
        env: cleanEnv,
        port: settings.port || 3000
    });
    signale.success(`Terminal back-end initialized!`);
    tty.onclosed = (code, signal) => {
        tty.ondisconnected = () => {};
        signale.complete("Terminal exited", code, signal);
        app.quit();
    };
    tty.onopened = () => {
        signale.success("Connected to frontend!");
        signale.timeEnd("Startup");
    };
    tty.onresized = (cols, rows) => {
        signale.info("Resized TTY to ", cols, rows);
    };
    tty.ondisconnected = () => {
        signale.error("Lost connection to frontend");
        signale.watch("Waiting for frontend connection...");
    };

    // Support for multithreaded systeminformation calls
    signale.pending("Starting multithreaded calls controller...");
    require("./_multithread.js");

    createWindow(settings);

    // Support for more terminals, used for creating tabs (currently limited to 4 extra terms)
    extraTtys = {};
    let basePort = settings.port || 3000;
    basePort = Number(basePort) + 2;

    for (let i = 0; i < 4; i++) {
        extraTtys[basePort+i] = null;
    }

    ipc.on("ttyspawn", (e, arg) => {
        let port = null;
        Object.keys(extraTtys).forEach(key => {
            if (extraTtys[key] === null && port === null) {
                extraTtys[key] = {};
                port = key;
            }
        });

        if (port === null) {
            signale.error("TTY spawn denied (Reason: exceeded max TTYs number)");
            e.sender.send("ttyspawn-reply", "ERROR: max number of ttys reached");
        } else {
            signale.pending(`Creating new TTY process on port ${port}`);
            let term = new Terminal({
                role: "server",
                shell: settings.shell,
                params: settings.shellArgs || '',
                cwd: tty.tty._cwd || settings.cwd,
                env: cleanEnv,
                port: port
            });
            signale.success(`New terminal back-end initialized at ${port}`);
            term.onclosed = (code, signal) => {
                term.ondisconnected = () => {};
                term.wss.close();
                signale.complete(`TTY exited at ${port}`, code, signal);
                extraTtys[term.port] = null;
                term = null;
            };
            term.onopened = pid => {
                signale.success(`TTY ${port} connected to frontend (process PID ${pid})`);
            };
            term.onresized = () => {};
            term.ondisconnected = () => {
                term.onclosed = () => {};
                term.close();
                term.wss.close();
                extraTtys[term.port] = null;
                term = null;
            };

            extraTtys[port] = term;
            e.sender.send("ttyspawn-reply", "SUCCESS: "+port);
        }
    });

    // Backend support for theme and keyboard hotswitch
    let themeOverride = null;
    let kbOverride = null;
    ipc.on("getThemeOverride", (e, arg) => {
        e.sender.send("getThemeOverride", themeOverride);
    });
    ipc.on("getKbOverride", (e, arg) => {
        e.sender.send("getKbOverride", kbOverride);
    });
    ipc.on("setThemeOverride", (e, arg) => {
        themeOverride = arg;
    });
    ipc.on("setKbOverride", (e, arg) => {
        kbOverride = arg;
    });
});

app.on('web-contents-created', (e, contents) => {
    // The WebApps launcher (src/classes/webApp.class.js) embeds third-
    // party sites in a <webview>. Each guest gets its own webContents
    // and this event fires for it too — so a single global handler
    // that denies popups and blocks navigation will sink every link
    // click inside the webview (GitHub "open in new tab", YouTube
    // OAuth popups, GitHub repo links) and look like "click does
    // nothing". Scope the guards by getType():
    //   - "webview" → let the embedded page navigate freely, allow
    //                 popups so OAuth flows work (popups inherit the
    //                 webview's partition → cookies/session persist).
    //   - everything else (the main BrowserWindow) → keep the original
    //     deny-popup + lock-navigation behavior.
    //
    // Note: <webview>'s `new-window` DOM event was removed in Electron
    // 22+ with no direct replacement (see breaking-changes / issue
    // #31117), so popup routing for webviews must live here in the
    // main process, not in the renderer.
    if (contents.getType() === 'webview') {
        // Spoof the partition's client-hint headers to match real
        // Chrome. Without this, Google's anti-embedded-browser check
        // sees Sec-CH-UA="Chromium" (not "Google Chrome") and blocks
        // sign-in with "Couldn't sign you in / this browser may not be
        // secure". The UA string is already spoofed on the <webview>
        // element; this is the matching server-side signal. Paired
        // with the navigator.userAgentData override in
        // src/classes/webApp-preload.js — sites that compare the JS
        // brand list against the request headers won't see a mismatch.
        //
        // Trade-off: violates Google's ToS, may break next time they
        // tighten detection. See the Go-with-B discussion in the
        // commit message for #28.
        const sess = contents.session;
        if (sess && !sess._ndexChHeaderHookInstalled) {
            sess._ndexChHeaderHookInstalled = true;
            const CHROME_BRAND_LIST = '"Not_A Brand";v="8", "Chromium";v="148", "Google Chrome";v="148"';
            sess.webRequest.onBeforeSendHeaders((details, callback) => {
                const headers = details.requestHeaders;
                // Header names from Chromium are typically Title-Case,
                // but Electron normalizes them inconsistently. Patch
                // every common case rather than rely on one spelling.
                for (const k of Object.keys(headers)) {
                    const lk = k.toLowerCase();
                    if (lk === "sec-ch-ua") headers[k] = CHROME_BRAND_LIST;
                    else if (lk === "sec-ch-ua-full-version-list") headers[k] = CHROME_BRAND_LIST;
                    else if (lk === "sec-ch-ua-mobile") headers[k] = "?0";
                    else if (lk === "sec-ch-ua-platform") headers[k] = '"Linux"';
                }
                callback({ requestHeaders: headers });
            });
        }
        // Popup windows (Google OAuth, target=_blank) need the same
        // preload + non-isolated context as the parent webview, or
        // their navigator.userAgentData reverts to Electron's Chromium
        // brand list and Google's anti-embedded-browser check trips.
        // Without overrideBrowserWindowOptions the popup runs vanilla
        // and the spoof effectively only protects the webview, not
        // the actual sign-in page that opens in a new window.
        const webappPreload = path.join(__dirname, "classes/webApp-preload.js");
        contents.setWindowOpenHandler(({ url }) => {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    webPreferences: {
                        preload: webappPreload,
                        contextIsolation: false,
                        nodeIntegration: false,
                        sandbox: false
                    }
                }
            };
        });
        // setUserAgent on the popup before it can issue any further
        // network requests. The opener's UA isn't inherited reliably
        // for popups across Electron versions, so be explicit.
        contents.on('did-create-window', (childWin) => {
            try {
                const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
                childWin.webContents.setUserAgent(UA);
            } catch (err) {
                signale.warn("WebApp popup setUserAgent failed:", err);
            }
        });
        return;
    }

    // Host (main UI) webContents — keep the original guards.
    contents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
        if (url !== contents.getURL()) e.preventDefault();
    });
});

app.on('window-all-closed', () => {
    signale.info("All windows closed");
    app.quit();
});

app.on('before-quit', () => {
    tty.close();
    Object.keys(extraTtys).forEach(key => {
        if (extraTtys[key] !== null) {
            extraTtys[key].close();
        }
    });
    signale.complete("Shutting down...");
});
