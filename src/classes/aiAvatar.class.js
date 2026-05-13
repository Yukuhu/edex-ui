// Programmatic Canvas-2D HUD avatar for the Claude chat modal.
//
// Look: holographic head/bust (Cortana-style) framed by two TRON-style
// HUD rings. The head is drawn purely with vector primitives — no assets.
// Scrolling scanlines clipped to the head silhouette sell the "hologram"
// effect; eyes blink, the mouth animates when responding/speaking, and
// the head bobs subtly while idle.
//
// States: idle | thinking | responding | speaking | error
//   idle       — slow breathing, occasional blink
//   thinking   — eyes pulse + orbit arc on the outer rings, head tilts
//   responding — mouth oscillates narrow, head bobs (tokens streaming)
//   speaking   — mouth oscillates wide (TTS playing)
//   error      — red wash that auto-decays back to idle
//
// Theme-aware: rereads --color_r/g/b from the document root every frame
// so theme changes propagate without restarting the avatar.

class AIAvatar {
    constructor(canvas) {
        if (!canvas) throw new Error("AIAvatar requires a canvas element");
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.state = "idle";
        this._errorDecay = 0;
        this._started = performance.now();
        this._raf = null;
        this._nextBlinkAt = 0;
        this._blinkUntil = 0;
        this._resize();
        this._onResize = () => this._resize();
        window.addEventListener("resize", this._onResize);
        this._loop = this._loop.bind(this);
        this._raf = requestAnimationFrame(this._loop);
    }

    setState(state) {
        if (!["idle", "thinking", "responding", "speaking", "error"].includes(state)) return;
        this.state = state;
        if (state === "error") this._errorDecay = 1.0;
    }

    destroy() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
        window.removeEventListener("resize", this._onResize);
    }

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(40, Math.round(rect.width));
        const h = Math.max(40, Math.round(rect.height));
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._w = w;
        this._h = h;
    }

    _themeColor(alpha = 1) {
        const root = getComputedStyle(document.documentElement);
        const r = Number.parseInt(root.getPropertyValue("--color_r")) || 170;
        const g = Number.parseInt(root.getPropertyValue("--color_g")) || 207;
        const b = Number.parseInt(root.getPropertyValue("--color_b")) || 209;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    _loop(t) {
        if (!this._raf) return;
        const dt = (t - (this._lastT || t)) / 1000;
        this._lastT = t;
        const elapsed = (t - this._started) / 1000;

        const ctx = this.ctx;
        const w = this._w, h = this._h;
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2, cy = h / 2;
        const r0 = Math.min(w, h) * 0.46;
        const r1 = r0 * 0.78;
        const r2 = r0 * 0.66;

        this._drawOuterRing(ctx, cx, cy, r0, elapsed);
        this._drawMiddleRing(ctx, cx, cy, r1, elapsed);
        this._drawHead(ctx, cx, cy, r2, elapsed);

        if (this.state === "thinking") {
            this._drawThinkingArc(ctx, cx, cy, r0, elapsed);
        }

        if (this._errorDecay > 0) {
            this._errorDecay = Math.max(0, this._errorDecay - dt * 1.6);
            ctx.fillStyle = `rgba(255, 70, 70, ${this._errorDecay * 0.45})`;
            ctx.fillRect(0, 0, w, h);
        }

        this._raf = requestAnimationFrame(this._loop);
    }

    _drawOuterRing(ctx, cx, cy, r0, elapsed) {
        const themeStrong = this._themeColor(1);
        const themeMid = this._themeColor(0.5);
        const themeSoft = this._themeColor(0.22);

        ctx.lineWidth = 1.2;
        ctx.strokeStyle = themeMid;
        ctx.beginPath();
        ctx.arc(cx, cy, r0, 0, Math.PI * 2);
        ctx.stroke();

        const tickCount = 24;
        const tickRot = elapsed * 0.25;
        for (let i = 0; i < tickCount; i++) {
            const a = tickRot + (i / tickCount) * Math.PI * 2;
            const ix = cx + Math.cos(a) * r0;
            const iy = cy + Math.sin(a) * r0;
            const ox = cx + Math.cos(a) * (r0 + 3);
            const oy = cy + Math.sin(a) * (r0 + 3);
            ctx.strokeStyle = i % 4 === 0 ? themeStrong : themeSoft;
            ctx.beginPath();
            ctx.moveTo(ix, iy);
            ctx.lineTo(ox, oy);
            ctx.stroke();
        }
    }

    _drawMiddleRing(ctx, cx, cy, r1, elapsed) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-elapsed * 0.4);
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = this._themeColor(0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, r1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    _drawThinkingArc(ctx, cx, cy, r0, elapsed) {
        const head = elapsed * 1.8;
        ctx.strokeStyle = this._themeColor(1);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r0 + 6, head, head + 0.9);
        ctx.stroke();
        for (let i = 1; i <= 3; i++) {
            const a = head - i * 0.15;
            ctx.fillStyle = this._themeColor(0.5 - i * 0.13);
            ctx.beginPath();
            ctx.arc(cx + Math.cos(a) * (r0 + 6), cy + Math.sin(a) * (r0 + 6), 1.6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawHead(ctx, cx, cy, r, elapsed) {
        const themeStrong = this._themeColor(1);
        const themeMid = this._themeColor(0.55);
        const themeFaint = this._themeColor(0.18);
        const themeFill = this._themeColor(0.1);

        // Idle breathing — head Y oscillates ±0.8 px.
        const breath = Math.sin(elapsed * 1.4) * 0.8;
        // Thinking — head tilts a few degrees and nods slowly.
        const tilt = this.state === "thinking" ? Math.sin(elapsed * 1.8) * 0.06 : 0;
        // Responding/speaking — slight bob.
        const bob = (this.state === "responding" || this.state === "speaking")
            ? Math.sin(elapsed * (this.state === "speaking" ? 6 : 4)) * 1.2
            : 0;

        const hw = r * 0.62;
        const hh = r * 0.82;
        const headY = cy - r * 0.18 + breath + bob;

        ctx.save();
        ctx.translate(cx, headY);
        ctx.rotate(tilt);

        // Hair — swept-back curves on both sides.
        ctx.strokeStyle = themeStrong;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        // Left sweep, three strands.
        ctx.moveTo(-hw * 0.75, -hh * 0.55);
        ctx.quadraticCurveTo(-hw * 1.5, -hh * 1.15, -hw * 0.35, -hh * 1.1);
        ctx.moveTo(-hw * 0.45, -hh * 0.7);
        ctx.quadraticCurveTo(-hw * 1.2, -hh * 1.35, -hw * 0.1, -hh * 1.25);
        ctx.moveTo(-hw * 0.15, -hh * 0.85);
        ctx.quadraticCurveTo(-hw * 0.85, -hh * 1.45, hw * 0.1, -hh * 1.3);
        // Right sweep, mirrored.
        ctx.moveTo(hw * 0.75, -hh * 0.55);
        ctx.quadraticCurveTo(hw * 1.5, -hh * 1.15, hw * 0.35, -hh * 1.1);
        ctx.moveTo(hw * 0.45, -hh * 0.7);
        ctx.quadraticCurveTo(hw * 1.2, -hh * 1.35, hw * 0.1, -hh * 1.25);
        ctx.moveTo(hw * 0.15, -hh * 0.85);
        ctx.quadraticCurveTo(hw * 0.85, -hh * 1.45, -hw * 0.1, -hh * 1.3);
        ctx.stroke();

        // Head silhouette (egg shape — slightly narrower at top, rounded chin).
        const headPath = new Path2D();
        // Start at top, sweep down-right via temple, around to chin, mirror back.
        headPath.moveTo(0, -hh);
        headPath.bezierCurveTo(hw * 0.55, -hh, hw, -hh * 0.55, hw, -hh * 0.05);
        headPath.bezierCurveTo(hw, hh * 0.55, hw * 0.55, hh, 0, hh);
        headPath.bezierCurveTo(-hw * 0.55, hh, -hw, hh * 0.55, -hw, -hh * 0.05);
        headPath.bezierCurveTo(-hw, -hh * 0.55, -hw * 0.55, -hh, 0, -hh);
        headPath.closePath();

        // Fill (translucent).
        ctx.fillStyle = themeFill;
        ctx.fill(headPath);
        // Outline.
        ctx.strokeStyle = themeStrong;
        ctx.lineWidth = 1.5;
        ctx.stroke(headPath);

        // Scanlines clipped to head — moving downward.
        ctx.save();
        ctx.clip(headPath);
        const scanSpeed = 18;
        const scanGap = 7;
        const scanOff = (elapsed * scanSpeed) % scanGap;
        ctx.strokeStyle = themeMid;
        ctx.lineWidth = 0.6;
        for (let y = -hh - scanGap; y < hh + scanGap; y += scanGap) {
            ctx.beginPath();
            ctx.moveTo(-hw, y + scanOff);
            ctx.lineTo(hw, y + scanOff);
            ctx.stroke();
        }
        // Faint vertical data streams.
        ctx.strokeStyle = themeFaint;
        ctx.lineWidth = 0.8;
        for (let i = -2; i <= 2; i++) {
            const x = i * (hw * 0.45);
            ctx.beginPath();
            ctx.moveTo(x, -hh);
            ctx.lineTo(x, hh);
            ctx.stroke();
        }
        ctx.restore();

        // Face features.
        // Blinks: schedule next blink stochastically; close eyes briefly.
        if (elapsed > this._nextBlinkAt) {
            this._blinkUntil = elapsed + 0.12;
            this._nextBlinkAt = elapsed + 3 + Math.random() * 3;
        }
        const blinking = elapsed < this._blinkUntil;
        const thinkPulse = this.state === "thinking" ? 0.65 + 0.35 * Math.abs(Math.sin(elapsed * 4)) : 1;
        ctx.strokeStyle = this._themeColor(thinkPulse);
        ctx.fillStyle = this._themeColor(thinkPulse);
        ctx.lineWidth = 1.6;
        const eyeY = -hh * 0.18;
        const eyeDx = hw * 0.36;
        const eyeHalf = hw * 0.11;
        if (blinking) {
            ctx.beginPath();
            ctx.moveTo(-eyeDx - eyeHalf, eyeY);
            ctx.lineTo(-eyeDx + eyeHalf, eyeY);
            ctx.moveTo(eyeDx - eyeHalf, eyeY);
            ctx.lineTo(eyeDx + eyeHalf, eyeY);
            ctx.stroke();
        } else {
            // Eyes as short slanted slashes — TRON-y, not cute.
            ctx.beginPath();
            ctx.moveTo(-eyeDx - eyeHalf, eyeY + 0.5);
            ctx.lineTo(-eyeDx + eyeHalf, eyeY - 1.5);
            ctx.moveTo(eyeDx - eyeHalf, eyeY - 1.5);
            ctx.lineTo(eyeDx + eyeHalf, eyeY + 0.5);
            ctx.stroke();
            // Pupils as faint dots.
            ctx.beginPath();
            ctx.arc(-eyeDx, eyeY, 1, 0, Math.PI * 2);
            ctx.arc(eyeDx, eyeY, 1, 0, Math.PI * 2);
            ctx.fill();
        }

        // Nose — thin vertical hint.
        ctx.strokeStyle = themeMid;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(0, eyeY + hh * 0.08);
        ctx.lineTo(0, hh * 0.12);
        ctx.stroke();

        // Mouth — animates with state.
        const mouthY = hh * 0.32;
        let mouthHeight = 0.6;
        if (this.state === "responding") {
            mouthHeight = 1.2 + 1.5 * Math.abs(Math.sin(elapsed * 9));
        } else if (this.state === "speaking") {
            mouthHeight = 2 + 3 * Math.abs(Math.sin(elapsed * 11) * (0.7 + 0.3 * Math.sin(elapsed * 17)));
        }
        ctx.fillStyle = themeStrong;
        ctx.beginPath();
        ctx.ellipse(0, mouthY, hw * 0.18, mouthHeight, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        // Neck + shoulders — below the rotated head context so they stay level.
        ctx.strokeStyle = themeStrong;
        ctx.lineWidth = 1.5;
        const neckTop = headY + hh - 1;
        const neckBot = headY + hh + r * 0.18;
        ctx.beginPath();
        ctx.moveTo(cx - hw * 0.32, neckTop);
        ctx.lineTo(cx - hw * 0.42, neckBot);
        ctx.moveTo(cx + hw * 0.32, neckTop);
        ctx.lineTo(cx + hw * 0.42, neckBot);
        // Shoulder line — flares outward.
        ctx.moveTo(cx - hw * 1.25, neckBot + r * 0.06);
        ctx.lineTo(cx + hw * 1.25, neckBot + r * 0.06);
        // Collarbone notches.
        ctx.moveTo(cx - hw * 0.55, neckBot + r * 0.02);
        ctx.lineTo(cx - hw * 0.85, neckBot + r * 0.06);
        ctx.moveTo(cx + hw * 0.55, neckBot + r * 0.02);
        ctx.lineTo(cx + hw * 0.85, neckBot + r * 0.06);
        ctx.stroke();
    }
}

module.exports = { AIAvatar };
window.AIAvatar = AIAvatar;
