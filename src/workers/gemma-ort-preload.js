// ⚠️ THROWAWAY SPIKE — issue #84 (part of #83). NOT production code.
//
// SPIKE FINDING: the worker runs with `nodeIntegrationInWorker: true`,
// so transformers.js's `apis.IS_NODE_ENV` is true and its onnx backend
// picks `onnxruntime-node` — which esbuild stubbed to an empty `{}`
// when we bundled the *web* build, so `ONNX.InferenceSession` came back
// undefined and ONNX session creation threw "Cannot read properties of
// undefined (reading 'create')".
//
// transformers.js checks `globalThis[Symbol.for("onnxruntime")]` FIRST,
// before the node/web branches — that's its documented override hook.
// This module must be imported *before* the transformers bundle so the
// symbol is set by the time the bundle's onnx backend module evaluates.
// ESM evaluates imports depth-first in source order, so a bare
// `import "./gemma-ort-preload.js"` ahead of the bundle import is enough.
//
// The real backend (#85) will need the same override (or to run the
// worker without node integration).

import * as ORT_WEB from "../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs";

globalThis[Symbol.for("onnxruntime")] = ORT_WEB;
