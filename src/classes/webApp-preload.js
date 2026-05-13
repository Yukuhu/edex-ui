// Injected into every WebApp's <webview> renderer. All console output
// here gets forwarded to the parent's DevTools via the host's
// `console-message` listener (webApp.class.js), prefixed with the
// app id and the level number from the host side.
//
// The goal is to make every interesting client-side event visible in
// one log stream so we can debug "click does nothing" reports without
// pasting console snippets each time.
(function () {
    const PREFIX = "[ndex-webapp]";
    // Flip to true (or set window.NDEX_WEBAPP_DEBUG before this preload
    // runs — e.g. via webview.executeJavaScript at dev time) to surface
    // the high-volume pointer/hover/navigation/lifecycle stream used to
    // diagnose the "clicks do nothing" bug. Off by default so production
    // sessions don't drown the parent DevTools.
    const DEBUG = (typeof window !== "undefined" && window.NDEX_WEBAPP_DEBUG === true);

    // Fingerprint spoofing for Google's anti-embedded-browser check.
    // Google's sign-in classifies "embedded" via three signals: the UA
    // string (spoofed on the <webview> element), the Sec-CH-UA request
    // headers (rewritten in src/_boot.js' onBeforeSendHeaders), and
    // navigator.userAgentData read from JS. All three must agree or
    // Google trips its mismatch heuristic. Real Chrome 148 reports
    // a "Google Chrome" brand entry; Electron's Chromium does not.
    // Patch the brand list onto the prototype so getters on the
    // Navigator instance return our spoofed object. This is an arms
    // race with Google's detection — expect to need updates.
    try {
        const fakeBrands = [
            { brand: "Not_A Brand",  version: "8"   },
            { brand: "Chromium",     version: "148" },
            { brand: "Google Chrome", version: "148" }
        ];
        const fakeUAD = {
            brands: fakeBrands,
            mobile: false,
            platform: "Linux",
            toJSON() {
                return { brands: this.brands, mobile: this.mobile, platform: this.platform };
            },
            getHighEntropyValues(hints) {
                const all = {
                    brands: fakeBrands,
                    mobile: false,
                    platform: "Linux",
                    platformVersion: "6.17.7",
                    architecture: "x86",
                    bitness: "64",
                    model: "",
                    uaFullVersion: "148.0.7778.97",
                    fullVersionList: fakeBrands.map(b => ({ brand: b.brand, version: b.version + ".0.7778.97" })),
                    wow64: false
                };
                const out = {};
                if (Array.isArray(hints)) for (const h of hints) if (h in all) out[h] = all[h];
                return Promise.resolve(out);
            }
        };
        try {
            Object.defineProperty(Navigator.prototype, "userAgentData", {
                get() { return fakeUAD; },
                configurable: true
            });
        } catch (_) {
            Object.defineProperty(navigator, "userAgentData", {
                get() { return fakeUAD; },
                configurable: true
            });
        }
        // Cheap supporting tells that detection libraries also probe.
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) {
            window.chrome.runtime = {
                OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
                PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" }
            };
        }
        try {
            Object.defineProperty(Navigator.prototype, "webdriver", {
                get() { return false; },
                configurable: true
            });
        } catch (_) {}
        // Real Chrome on Linux ships with multilingual defaults; an
        // empty/single-element languages array is one of the cheaper
        // bot-fingerprint flags.
        try {
            Object.defineProperty(Navigator.prototype, "languages", {
                get() { return ["en-US", "en"]; },
                configurable: true
            });
        } catch (_) {}
        // Electron renders no plugins by default; Chrome lists the PDF
        // viewer family. Forge a minimal plugins array so length > 0.
        try {
            const fakePlugins = [
                { name: "PDF Viewer",          filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chrome PDF Viewer",   filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" }
            ];
            fakePlugins.length = 3;
            Object.defineProperty(Navigator.prototype, "plugins", {
                get() { return fakePlugins; },
                configurable: true
            });
        } catch (_) {}
        // Sanity log so we can verify the spoof reached the page's
        // world (not just the preload's isolated world). If we ever
        // see brand "Chromium" without "Google Chrome" here, the
        // contextIsolation toggle on the webview/popup regressed.
        console.log(PREFIX, "fingerprint spoof applied; brands=" +
            (navigator.userAgentData?.brands || []).map(b => b.brand).join(","));
    } catch (e) {
        console.log(PREFIX, "userAgentData spoof failed", e?.message);
    }

    function describeEl(el) {
        if (el?.nodeType !== 1) return String(el);
        const parts = [el.tagName.toLowerCase()];
        if (el.id) parts.push("#" + el.id);
        if (el.className && typeof el.className === "string") {
            const cls = el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".");
            if (cls) parts.push("." + cls);
        }
        const href = el.getAttribute?.("href");
        if (href) parts.push(`href="${href}"`);
        const aria = el.getAttribute?.("aria-label");
        if (aria) parts.push(`aria="${aria}"`);
        return parts.join("");
    }

    function logPointerEvent(name, e) {
        const targetAtPoint = document.elementFromPoint(e.clientX, e.clientY);
        const closestLink = e.target?.closest?.("a, button") ||
                            targetAtPoint?.closest?.("a, button");
        console.log(
            PREFIX,
            name,
            `(${Math.round(e.clientX)},${Math.round(e.clientY)})`,
            "target=" + describeEl(e.target),
            "atPoint=" + describeEl(targetAtPoint),
            closestLink ? "closestLink=" + describeEl(closestLink) : "noLink",
            e.defaultPrevented ? "DEFAULT_PREVENTED" : ""
        );
    }

    // Diagnostic firehose — only useful while debugging the click /
    // navigation / lifecycle stream. Gated so production sessions
    // don't flood the parent DevTools.
    if (DEBUG) {
        ["mousedown", "mouseup", "click", "pointerdown", "pointerup"].forEach(type => {
            window.addEventListener(type, e => logPointerEvent(type, e), { capture: true });
        });

        // Event-driven nav watcher (popstate/hashchange + pushState/
        // replaceState patches) instead of polling — same coverage,
        // no setInterval (guardrails eval-dom rule), no idle wakeups.
        let lastUrl = location.href;
        const onNav = () => {
            const here = location.href;
            if (here !== lastUrl) {
                console.log(PREFIX, "navigation:", lastUrl, "->", here);
                lastUrl = here;
            }
        };
        window.addEventListener("popstate", onNav);
        window.addEventListener("hashchange", onNav);
        const origPush = history.pushState;
        history.pushState = function () {
            const r = origPush.apply(this, arguments);
            onNav();
            return r;
        };
        const origReplace = history.replaceState;
        history.replaceState = function () {
            const r = origReplace.apply(this, arguments);
            onNav();
            return r;
        };

        let lastHover = null;
        document.addEventListener("mouseover", e => {
            const closestLink = e.target?.closest?.("a, button, [role='button']");
            if (closestLink && closestLink !== lastHover) {
                lastHover = closestLink;
                const cursor = getComputedStyle(closestLink).cursor;
                console.log(PREFIX, "hover", describeEl(closestLink), "cursor=" + cursor);
            }
        }, { capture: true });

        document.addEventListener("DOMContentLoaded", () => {
            console.log(PREFIX, "DOMContentLoaded", location.href);
        });
        window.addEventListener("load", () => {
            console.log(PREFIX, "load", location.href);
        });
        window.addEventListener("beforeunload", () => {
            console.log(PREFIX, "beforeunload", location.href);
        });
    }

    // Error reporting stays on unconditionally — it's low-volume and
    // genuinely useful for diagnosing user-reported breakage.
    window.addEventListener("error", e => {
        console.log(PREFIX, "page-error", e.message, "at", e.filename + ":" + e.lineno);
    });
    window.addEventListener("unhandledrejection", e => {
        console.log(PREFIX, "unhandled-rejection", e.reason && (e.reason.message || e.reason));
    });

    console.log(PREFIX, "preload injected for", location.href, DEBUG ? "(DEBUG)" : "");
})();
