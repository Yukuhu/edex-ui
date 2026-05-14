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

// There are TWO independent node-detections to defuse:
//
//  1. transformers.js: IS_NODE_ENV = process.release.name === "node".
//     Misfires -> onnxruntime-node branch (stubbed empty here).
//
//  2. onnxruntime-web's Emscripten wasm glue: it runs
//       m = isNode && ("renderer" != globalThis.process?.type)
//       if (m) { require("worker_threads"); global.Worker = ... }
//     A nodeIntegrationInWorker worker has process.type === "worker",
//     so m is true and the glue tries to import the Node-only
//     "worker_threads" module — which a module worker can't resolve
//     ("Failed to resolve module specifier 'worker_threads'").
//     Emscripten added that `"renderer" != process.type` clause as an
//     Electron-renderer escape hatch, so we take it: set process.type
//     to "renderer". (The worker also sets wasm.numThreads = 1, so no
//     pthread pool is spawned in the first place.)

function patch(obj, key, want) {
    try { obj[key] = want; } catch (_) {}
    if (obj[key] !== want) {
        try {
            Object.defineProperty(obj, key, { value: want, configurable: true, writable: true });
        } catch (_) {}
    }
    return obj[key];
}

let nodeNameAfterPatch = "(no process)";
let processTypeAfterPatch = "(no process)";
try {
    const p = globalThis.process;
    if (p) {
        if (p.release && p.release.name === "node") {
            // process.release may be frozen/non-writable — try the prop,
            // then a fresh object, then a forced redefine.
            try { p.release.name = "electron"; } catch (_) {}
            if (p.release.name === "node") {
                try { p.release = Object.assign({}, p.release, { name: "electron" }); } catch (_) {}
            }
            if (p.release.name === "node") {
                patch(p, "release", Object.assign({}, p.release, { name: "electron" }));
            }
        }
        nodeNameAfterPatch = p.release ? p.release.name : "(no process.release)";
        processTypeAfterPatch = patch(p, "type", "renderer");
    }
} catch (e) {
    nodeNameAfterPatch = "(patch threw: " + (e && e.message) + ")";
}

// Exported so the worker can log whether the patches actually took.
export const ortEnvProbe = { nodeNameAfterPatch, processTypeAfterPatch };
