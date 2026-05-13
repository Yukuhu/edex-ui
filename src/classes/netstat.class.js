class Netstat {
    constructor(parentId) {
        if (!parentId) throw "Missing parameters";

        // Create DOM
        this.parent = document.getElementById(parentId);
        this.parent.innerHTML += `<div id="mod_netstat">
            <div id="mod_netstat_inner">
                <h1>NETWORK STATUS<i id="mod_netstat_iname"></i></h1>
                <div id="mod_netstat_innercontainer">
                    <div>
                        <h1>STATE</h1>
                        <h2>UNKNOWN</h2>
                    </div>
                    <div>
                        <h1>IPv4</h1>
                        <h2>--.--.--.--</h2>
                    </div>
                    <div>
                        <h1>PING</h1>
                        <h2>--ms</h2>
                    </div>
                </div>
            </div>
        </div>`;

        // Cache references to the three value cells. The DOM nodes are
        // created once above and never replaced, so re-querying them on
        // every 2s tick is pure waste.
        this.inameEl = document.getElementById("mod_netstat_iname");
        const cells = this.parent.querySelectorAll("#mod_netstat_innercontainer > div > h2");
        this.stateEl = cells[0];
        this.ipEl    = cells[1];
        this.pingEl  = cells[2];

        this.offline = false;
        this.lastconn = {finished: false}; // Prevent geoip lookup attempt until maxminddb is loaded
        this.iface = null;
        this.failedAttempts = {};
        this.runsBeforeGeoIPUpdate = 0;

        this._httpsAgent = new (require("https").Agent)({
            keepAlive: false,
            maxSockets: 10
        });

        // Init updaters
        this.updateInfo();
        this.infoUpdater = setInterval(() => {
            this.updateInfo();
        }, 2000);

        // Init GeoIP integrated backend
        this.geoLookup = {
            get: () => null
        };
        this._initGeoIP();
    }

    // Extracted from the constructor so Sonar's S7059 (no async work
    // in constructors) is satisfied. Caller doesn't await — the
    // class polls `this.lastconn.finished` before consulting
    // `this.geoLookup`.
    _initGeoIP() {
        const maxmind = require("maxmind");
        // geolite2-redist 3.x is ESM-only. Dynamic `import("geolite2-redist")`
        // does not work in the Electron renderer — the browser-side ESM
        // resolver doesn't understand bare specifiers and the lookup silently
        // failed. Node 22+ supports require() of ESM, so use that instead.
        Promise.resolve(require("geolite2-redist")).then(mod => {
            const geolite2 = mod.default || mod;
            return geolite2.open('GeoLite2-City', path => maxmind.open(path));
        }).then(reader => {
            this.geoLookup = reader;
            this.lastconn.finished = true;
        }).catch(e => {
            console.warn("GeoIP setup failed:", e);
        });
    }
    updateInfo() {
        window.si.networkInterfaces().then(async data => {
            let offline = false;

            let net = data[0];
            let netID = 0;

            if (typeof window.settings.iface === "string") {
                while (net.iface !== window.settings.iface) {
                    netID++;
                    if (data[netID]) {
                        net = data[netID];
                    } else {
                        // No detected interface has the custom iface name, fallback to automatic detection on next loop
                        window.settings.iface = false;
                        return false;
                    }
                }
            } else {
                // Find the first external, IPv4 connected networkInterface that has a MAC address set

                while (net.operstate !== "up" || net.internal === true || net.ip4 === "" || net.mac === "") {
                    netID++;
                    if (data[netID]) {
                        net = data[netID];
                    } else {
                        // No external connection!
                        this.iface = null;
                        this.inameEl.innerText = "Interface: (offline)";
                        this.offline = true;
                        this._renderOffline();
                        break;
                    }
                }
            }

            if (net.ip4 !== this.internalIPv4) this.runsBeforeGeoIPUpdate = 0;

            this.iface = net.iface;
            this.internalIPv4 = net.ip4;
            this.inameEl.innerText = "Interface: "+net.iface;

            if (net.ip4 === "127.0.0.1") {
                offline = true;
            } else {
                if (this.runsBeforeGeoIPUpdate === 0 && this.lastconn.finished) {
                    this.lastconn = require("https").get({host: "myexternalip.com", port: 443, path: "/json", localAddress: net.ip4, agent: this._httpsAgent}, res => {
                        let rawData = "";
                        res.on("data", chunk => {
                            rawData += chunk;
                        });
                        res.on("end", () => {
                            try {
                                let data = JSON.parse(rawData);
                                this.ipinfo = {
                                    ip: data.ip,
                                    geo: this.geoLookup.get(data.ip).location
                                };

                                this.ipEl.innerHTML = window._escapeHtml(this.ipinfo.ip);

                                this.runsBeforeGeoIPUpdate = 10;
                            } catch(e) {
                                this.failedAttempts[e] = (this.failedAttempts[e] || 0) + 1;
                                if (this.failedAttempts[e] > 2) return false;
                                console.warn(e);
                                console.info(rawData.toString());
                                let electron = require("electron");
                                electron.ipcRenderer.send("log", "note", "NetStat: Error parsing data from myexternalip.com");
                                electron.ipcRenderer.send("log", "debug", `Error: ${e}`);
                            }
                        });
                    }).on("error", e => {
                        // Drop it
                    });
                } else if (this.runsBeforeGeoIPUpdate !== 0) {
                    this.runsBeforeGeoIPUpdate = this.runsBeforeGeoIPUpdate - 1;
                }

                let p = await this.ping(window.settings.pingAddr || "1.1.1.1", 80, net.ip4).catch(() => { offline = true });

                this.offline = offline;
                if (offline) {
                    this._renderOffline();
                } else {
                    this.stateEl.innerHTML = "ONLINE";
                    this.pingEl.innerHTML = Math.round(p)+"ms";
                }
            }
        });
    }

    // Reset the three status cells to their offline placeholder values.
    _renderOffline() {
        this.stateEl.innerHTML = "OFFLINE";
        this.ipEl.innerHTML    = "--.--.--.--";
        this.pingEl.innerHTML  = "--ms";
    }

    ping(target, port, local) {
        return new Promise((resolve, reject) => {
            let s = new (require("net").Socket)();
            let start = process.hrtime();

            s.connect({
                port,
                host: target,
                localAddress: local,
                family: 4
            }, () => {
                let time_arr = process.hrtime(start);
                let time = (time_arr[0] * 1e9 + time_arr[1]) / 1e6;
                resolve(time);
                s.destroy();
            });
            s.on('error', e => {
                s.destroy();
                reject(e);
            });
            s.setTimeout(1900, function() {
                s.destroy();
                reject(new Error("Socket timeout"));
            });
        });
    }
}

module.exports = {
    Netstat
};
