"use strict";
// @ts-check

class Clock {
    constructor(parentId) {
        if (!parentId) throw "Missing parameters";

        // Load settings
        this.twelveHours = (window.settings.clockHours === 12);

        // Create DOM. The `parentId` is always passed by `initUI()`
        // in _renderer.js with an id that exists in ui.html; the
        // non-null assertion documents that contract for the type
        // checker.
        const parent = document.getElementById(parentId);
        if (!parent) throw new Error(`Clock: parent #${parentId} missing`);
        this.parent = parent;
        this.parent.innerHTML += `<div id="mod_clock" class="${(this.twelveHours) ? "mod_clock_twelve" : ""}">
            <h1 id="mod_clock_text"><span>?</span><span>?</span><span>:</span><span>?</span><span>?</span><span>:</span><span>?</span><span>?</span></h1>
        </div>`;

        this.lastTime = new Date();

        this.updateClock();
        this.updater = setInterval(() => {
            this.updateClock();
        }, 1000);
    }
    // Pure formatter — extracted as a static so the renderer-less
    // unit suite can pin the 12-hour translation + zero-pad + per-
    // char span wrapping without booting jsdom. Issue #201.
    /**
     * @param {Date} time
     * @param {boolean} twelveHours
     * @returns {{ html: string, ampm: string | null }}
     */
    static _formatClockHtml(time, twelveHours) {
        // Split into two phases:
        //   1. Numeric hours/minutes/seconds — used for the 12-hour
        //      translation arithmetic below.
        //   2. Zero-padded *string* slots fed into the final
        //      template literal. Keeping them as separate arrays
        //      lets the type-checker keep the numbers numeric for
        //      the arithmetic phase.
        const nums = [time.getHours(), time.getMinutes(), time.getSeconds()];
        /** @type {string | null} */
        let ampm = null;

        // 12-hour mode translation
        if (twelveHours) {
            ampm = (nums[0] >= 12) ? "PM" : "AM";
            if (nums[0] > 12) nums[0] = nums[0] - 12;
            if (nums[0] === 0) nums[0] = 12;
        }

        const parts = nums.map(n => n.toString().length === 2 ? n.toString() : "0" + n);
        const raw = `${parts[0]}:${parts[1]}:${parts[2]}`;
        const chars = raw.match(/.{1}/g) || [];
        let html = "";
        chars.forEach(e => {
            if (e === ":") html += "<em>"+e+"</em>";
            else html += "<span>"+e+"</span>";
        });

        if (twelveHours) html += `<span>${ampm}</span>`;

        return { html, ampm };
    }

    updateClock() {
        const time = new Date();
        const { html, ampm } = Clock._formatClockHtml(time, this.twelveHours);
        this.ampm = ampm;
        const target = document.getElementById("mod_clock_text");
        if (target) target.innerHTML = html;
        this.lastTime = time;
    }
}

module.exports = {
    Clock
};
