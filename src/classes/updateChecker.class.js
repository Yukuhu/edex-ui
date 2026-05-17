class UpdateChecker {
    // Compare the local app version (e.g. "3.0.0-SNAPSHOT" or
    // "1.2.0-pre") against the `tag_name` of a GitHub release
    // (e.g. "v1.2.3"). Returns one of:
    //
    //   "latest" → the local version exactly matches the release tag
    //              after stripping its leading "v".
    //   "dev"    → the local version's numeric flattening is greater
    //              than the release tag's — i.e. running ahead of any
    //              published release.
    //   "newer"  → the release tag is ahead of the local version, so
    //              there's an update to advertise.
    //   null     → the inputs were malformed (missing tag, non-string,
    //              or non-numeric after flattening) and the caller
    //              should treat the call as a failed lookup.
    //
    // The comparison uses the same "strip dots, compare as integer"
    // shape the upstream eDEX-UI codebase has used since 2017. It's
    // not semver-aware (1.2.10 numerically flattens to 1210, which
    // compares wrongly against 1.3.0 → 130) but it has been stable
    // long enough that fixing it is its own decision; this helper
    // exists to make the *current* behavior testable. Issue #175.
    //
    // Asymmetries preserved for parity:
    //   - The tag is stripped of its first character (the leading
    //     "v"), regardless of what it is.
    //   - `-pre` is stripped from the local version only — GitHub
    //     tags never carry it.
    static _compareVersion(current, tagName) {
        if (typeof current !== "string" || typeof tagName !== "string") return null;
        if (tagName.length < 2) return null;

        const tag = tagName.slice(1);
        if (tag === current) return "latest";

        const tagNum = Number(tag.replace(/\./g, ""));
        const curNum = Number(current.replace("-pre", "").replace(/\./g, ""));
        if (!Number.isFinite(tagNum) || !Number.isFinite(curNum)) return null;

        if (tagNum < curNum) return "dev";
        return "newer";
    }

    constructor() {
        let https = require("node:https");
        let electron = require("electron");
        let remote = require("@electron/remote");
        let current = remote.app.getVersion();

        this._failed = false;
        this._willfail = false;
        this._fail = e => {
            this._failed = true;
            electron.ipcRenderer.send("log", "note", "UpdateChecker: Could not fetch latest release from GitHub's API.");
            electron.ipcRenderer.send("log", "debug", `Error: ${e}`);
        };

        https.get({
            protocol: "https:",
            host: "api.github.com",
            path: "/repos/Yukuhu/edex-ui/releases/latest",
            headers: {
                "User-Agent": "nDEX-UI UpdateChecker"
            }
        }, res => {
            switch(res.statusCode) {
                case 200:
                    break;
                case 404:
                    this._fail("Got 404 (Not Found) response from server");
                    break;
                default:
                    this._willfail = true;
            }

            let rawData = "";

            res.on('data', chunk => {
                rawData += chunk;
            });

            res.on('end', () => {
                let d = rawData;
                if (this._failed === true) {
                    // Do nothing, it already failed
                } else if (this._willfail) {
                    this._fail(d.toString());
                } else {
                    try {
                        let release = JSON.parse(d.toString());
                        const verdict = UpdateChecker._compareVersion(current, release.tag_name);
                        if (verdict === "latest") {
                            electron.ipcRenderer.send("log", "info", "UpdateChecker: Running latest version.");
                        } else if (verdict === "dev") {
                            electron.ipcRenderer.send("log", "info", "UpdateChecker: Running an unreleased, development version.");
                        } else if (verdict === "newer") {
                            new Modal({
                                type: "info",
                                title: "New version available",
                                message: `nDEX-UI <strong>${release.tag_name}</strong> is now available.<br/>Head over to <a href="#" onclick="require('electron').shell.openExternal('${release.html_url}')">github.com</a> to download the latest version.`
                            });
                            electron.ipcRenderer.send("log", "info", `UpdateChecker: New version ${release.tag_name} available.`);
                        } else {
                            // verdict === null — the payload didn't
                            // carry a usable tag_name. Funnel through
                            // the same failure path as a network /
                            // parse error so the user gets one
                            // consistent log line.
                            this._fail("Malformed release payload (missing or invalid tag_name)");
                        }
                    } catch(e) {
                        this._fail(e);
                    }
                }
            });
        }).on('error', e => {
            this._fail(e);
        });
    }
}

module.exports = {
    UpdateChecker
};
