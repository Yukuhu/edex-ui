"use strict";
// @ts-check

class HardwareInspector {
    constructor(parentId) {
        if (!parentId) throw "Missing parameters";

        // Create DOM. The `parentId` is always passed by `initUI()`
        // in _renderer.js with an id that exists in ui.html.
        const parent = document.getElementById(parentId);
        if (!parent) throw new Error(`HardwareInspector: parent #${parentId} missing`);
        this.parent = parent;
        this._element = document.createElement("div");
        this._element.setAttribute("id", "mod_hardwareInspector");
        this._element.innerHTML = `<div id="mod_hardwareInspector_inner">
            <div>
                <h1>MANUFACTURER</h1>
                <h2 id="mod_hardwareInspector_manufacturer" >NONE</h2>
            </div>
            <div>
                <h1>MODEL</h1>
                <h2 id="mod_hardwareInspector_model" >NONE</h2>
            </div>
            <div>
                <h1>CHASSIS</h1>
                <h2 id="mod_hardwareInspector_chassis" >NONE</h2>
            </div>
        </div>`;

        this.parent.append(this._element);

        this.updateInfo();
        this.infoUpdater = setInterval(() => {
            this.updateInfo();
        }, 20000);
    }
    updateInfo() {
        window.si.system().then((/** @type {any} */ d) => {
            window.si.chassis().then((/** @type {any} */ e) => {
                // The three target elements are created in our
                // constructor above; safety-check anyway in case
                // the parent column was hot-swapped away.
                const mfg = document.getElementById("mod_hardwareInspector_manufacturer");
                const model = document.getElementById("mod_hardwareInspector_model");
                const chassis = document.getElementById("mod_hardwareInspector_chassis");
                if (mfg) mfg.innerText = this._trimDataString(d.manufacturer);
                if (model) model.innerText = this._trimDataString(d.model, d.manufacturer, e.type);
                if (chassis) chassis.innerText = e.type;
            });
        });
    }
    _trimDataString(str, ...filters) {
        return str.trim().split(" ").filter(word => {
            if (typeof filters !== "object") return true;

            return !filters.includes(word);
        }).slice(0, 2).join(" ");
    }
}

module.exports = {
    HardwareInspector
};
