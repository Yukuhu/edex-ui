// ⚠️ THROWAWAY SPIKE — issue #84 (part of #83). NOT production code.
//
// SPIKE FINDING: the worker runs with `nodeIntegrationInWorker: true`,
// which leaves `process.release.name === "node"`. transformers.js
// computes `IS_NODE_ENV` from exactly that, then its onnx backend:
//
//   if (Symbol.for("onnxruntime") in globalThis) ONNX = that   // sets no devices
//   else if (IS_NODE_ENV)  ONNX = onnxruntime-node             // empty stub here
//   else                   ONNX = onnxruntime-web + push webgpu/wasm
//
// We want the third branch: it both wires the (rewired) web ORT *and*
// populates `supportedDevices` with "webgpu". The Symbol override only
// did the first half — hence "Unsupported device: webgpu. Should be one
// of: ." So instead of overriding the symbol, neutralise the single
// signal that misfires: make `process.release.name` not be "node".
// IS_WEBWORKER_ENV stays true, so transformers.js cleanly treats this
// as the web worker it actually is.
//
// This module must be imported *before* the transformers bundle so the
// patch lands before the bundle computes IS_NODE_ENV at module-eval.
//
// The real backend (#85) faces the same nodeIntegrationInWorker tension
// and will need an equivalent shim (or a non-node-integrated worker).

let nodeNameAfterPatch = "(no process)";
try {
    const p = globalThis.process;
    if (p && p.release && p.release.name === "node") {
        // Try increasingly forceful overrides — `process.release` may be
        // a plain writable object, a frozen one, or a non-writable prop.
        try { p.release.name = "electron"; } catch (_) {}
        if (p.release.name === "node") {
            try { p.release = Object.assign({}, p.release, { name: "electron" }); } catch (_) {}
        }
        if (p.release.name === "node") {
            try {
                Object.defineProperty(p, "release", {
                    value: Object.assign({}, p.release, { name: "electron" }),
                    configurable: true, writable: true
                });
            } catch (_) {}
        }
    }
    nodeNameAfterPatch = p && p.release ? p.release.name : "(no process.release)";
} catch (e) {
    nodeNameAfterPatch = "(patch threw: " + (e && e.message) + ")";
}

// Exported so the worker can log whether the patch actually took.
export const ortEnvProbe = { nodeNameAfterPatch };
