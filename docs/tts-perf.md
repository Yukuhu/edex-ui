# Claude Chat TTS — responsiveness measurements

Per Issue #24 and the project rule that **responsiveness is the
primary goal**. Every variant tried during the investigation is logged
here with its before/after numbers, including the ones we ultimately
reject — so future-us doesn't re-try a dead-end.

## Methodology

- **Standardized prompt** (used for every measurement unless noted):
  > *"Give me five facts about the city of Hamburg, each as a
  > separate paragraph with a bold heading."*

  Chosen because it produces consistent multi-sentence output with
  markdown bold + paragraph breaks + soft boundaries, exercising the
  whole pipeline.

- **Cold vs warm**: every variant is measured both **cold** (first
  prompt after chat-modal open, worker freshly loaded) and **warm**
  (second prompt in the same session). Cold reflects worst-case;
  warm reflects steady-state.

- **Reading**: each row is the **median of 3 runs**. The TTS dtype is
  `q8` for all comparisons.

- **Machine**: macOS 14.x on Apple Silicon (M-series). All times in
  milliseconds unless noted.

## Metrics

| Metric | Definition |
|---|---|
| `T-first-audio` | Time from `_submit` (user clicked Send) to `audio.onplay` of sentence #1. **The headline number.** |
| `synth-ms/char` | Per-character synth time on the first 3 sentences. Captures whether parallelism, dtype, or warmup is paying off. |
| `queue-peak` | Highest depth of `_ttsAudioQueue` during the response. Bigger = synthesis is outrunning playback. |
| `UI-block-max` | Longest single sync block on the renderer JS thread during synthesis. Should stay near 0 with the worker. |
| `feels` | Subjective: "snappy" / "OK" / "laggy" / "worse". |

## Variants

### 0. Baseline — `e1beb85` (PR #23 merged state)

| Run | T-first-audio | synth-ms/char | queue-peak | UI-block-max | feels |
|---|---|---|---|---|---|
| cold | 6103ms | 58.2 / 30.5 / 25.9 | 9 | 0ms | OK |
| warm | 2890ms | 35.8 / 30.1 / 26.1 | 9 | 0ms | OK |

Notes: this is the state after merging PR #23. Streaming + worker
enabled; pre-warm on voice toggle only; comma-only soft-yield at ≥25
chars, force-cap 80; sequential `_synthInWorker`.

- First sentence on Hamburg prompt is the bold heading
  `**Germany's Second Largest City**` (33 chars after markdown strip).
  Whole-sentence synth at warm rate is ~1037ms → that's the T-first-audio
  floor on this response shape.
- Cold T-first-audio extra ~3s is Claude CLI TTFT.
- queue-peak=9 confirms streaming is fully pipelined; sentences 2-15
  are synthesized while sentence 1's audio plays.
- `UI-block-max=0ms` — worker is doing its job.

### 1a. Aggressive sub-sentence chunking — **REJECTED**

| Run | T-first-audio | synth-ms/char | queue-peak | UI-block-max | feels |
|---|---|---|---|---|---|
| cold | 13629ms ⚠ | 31.0 / 44.5 / 23.6 | 7 | 13540ms ⚠ | worse |
| warm | 4824ms | 35.0 / 30.8 / 51.0 | 24 | 0ms | "very noticeable pauses" |

**Verdict: revert.**

- T-first-audio got *worse* on both cold and warm vs baseline.
- Subjective: chunk boundaries break prosody — every comma turns into
  a spoken pause. Unacceptable for a feature where speech quality
  matters.
- Cold also exposed a chunker bug (`RangeError: Invalid array length`
  from an infinite loop when a soft-boundary matched at index 0 of
  the remaining buffer — `cut === 0` produces no progress). UI froze
  for 13.5s, which the `UI-block-max` correctly caught.
- The conceptual problem with 1a on Hamburg-style prompts: the
  bottleneck is the first sentence (33 char heading at ~30ms/char
  ≈ 1s), and chunking can't help a sentence that's already below
  the cap. For sentences above the cap, total synth work is the
  same; chunking just shifts wall-clock from "one big synth" to
  "many small synths" which has worse per-call amortization.

### 1b. Pre-warm on chat modal open — **SKIPPED**

Analysis says this won't change T-first-audio: pre-warm already
finishes before the user submits in the current flow. The win would
only be "time-from-modal-open-to-voice-ready", which the user
typically spends typing their prompt anyway. Quality-of-life
improvement but not a responsiveness win. Defer to a future ergonomic
PR if requested.

### 1c. Concurrent worker synthesis (multiple in flight) — **SKIPPED**

Analysis says this won't change T-first-audio either: the worker is
single-threaded, and sentence #1 is the only synthesis in flight when
the user is waiting. The baseline shows queue-peak=9-24, meaning
synthesis is already comfortably outpacing playback with a single
worker. Adding parallelism would only help if the queue were
*draining*, which it isn't.

Could be revisited if a future workload (e.g., a different voice
model with much slower per-call synth) makes the queue drain — but on
current Kokoro/q8 numbers, this is solved.

### 2. WebGPU / CoreML ONNX backend — **PARTIAL KEEP (CoreML only)**

| Run | T-first-audio | synth-ms/char | queue-peak | UI-block-max | feels |
|---|---|---|---|---|---|
| cold | 6037ms | 36.2 / 27.6 / 24.9 | 9 | 0ms | same |
| warm | 4319ms* | 35.2 / 25.9 / 24.5 | 9 | 0ms | same |

\*Warm T-first-audio regression vs baseline (4319 vs 2890) is Claude
TTFT variance — synth itself was identical. Per-char rates are the
honest measurement.

**WebGPU: REJECTED (blocked)**

kokoro.web.js loaded fine inside the worker, but its bundled
transformers.js detected the node-integrated worker as Node and
reported the available device list as `["cpu"]` only — `device:
"webgpu"` was rejected with:

  > `Unsupported device: "webgpu". Should be one of: cpu.`

To actually access WebGPU we'd need a non-node-integrated worker (a
separate Electron BrowserWindow or a properly isolated Worker
context), which is a several-hour refactor and a bigger architectural
change than this investigation scoped. The
`src/workers/tts-worker-web.js` file is left in tree, ready to be
re-enabled once we have a clean non-Node worker — but it's not the
default, and won't activate unless `window.settings.ttsBackend ===
"webgpu"`.

**CoreML EP: KEEP**

Added `session_options.executionProviders = ["coreml", "cpu"]` on
darwin in the node worker. onnxruntime-node accepts this; CoreML
silently falls back to CPU for ops it can't compile. Per-char rates
dropped ~10% (30.5→27.6 cold, 30.1→25.9 warm) — modest but real on
Apple Silicon, and free in code size. Non-darwin platforms get
`["cpu"]` only, so no behaviour change there.

### 3a. Chat-path instrumentation — **KEEP (diagnostic only)**

Pure measurement, no behaviour change. Each turn now emits a stage
breakdown line so the long pole is visible at a glance. Numbers from
one cold+warm sample on the Hamburg prompt:

| Stage | Cold (ms) | Warm (ms) | % of total |
|---|---|---|---|
| submit → ipc-out | 2 | 2 | <1% |
| **ipc-out → first-delta** | **3627** | **2997** | **66% / 77%** |
| first-delta → first-bubble-char | 3 | 18 | <1% |
| first-delta → first-tts-yield | 923 | 1 | varies |
| first-tts-yield → first-synth-done | 968 | 887 | 17-23% |
| first-synth-done → first-audio-onplay | 10 | 4 | <1% |
| **Total (T-first-audio)** | **5529** | **3890** | |

**Headline finding:** Claude CLI TTFT (`ipc-out → first-delta`) owns
the budget. Synthesis is the second slice but already optimized down
to ~900ms after PR #23 + variant 2. The streaming and worker work
have paid off — synth is no longer the bottleneck.

Cold's `delta → yield` of 923ms reflects splitter waiting for the
first full sentence boundary while text streams. Warm's 1ms is the
case where the first delta already contains a complete sentence.

### 3b. Acting on 3a's findings — **SKIPPED (no actionable lever)**

Investigated. Skipping because no realistic optimization moves the
needle on the dominant `ipc → first-delta` stage:

- **Pre-warm `claude` binary into OS page cache**: spawning `claude
  --version` on modal open could shave maybe 200-500ms off cold-start
  (CLI startup ≈ 600ms; the rest is API request time which is
  Anthropic's wall-clock). Marginal win, only on cold. Adds a
  speculative subprocess spawn that may or may not help depending on
  OS scheduler.
- **Replace `claude -p` CLI with @anthropic-ai/sdk**: would skip the
  CLI entirely and remove spawn cost. Significant refactor of
  `_main_claude.js`, conflicts with the project's "uses local claude
  install" architecture (per CLAUDE.md). Out of scope.
- **Avatar canvas warmup / settings cache**: the breakdown shows
  these stages are already <20ms. Nothing to save.

Variant 3a's instrumentation is KEPT (no runtime cost when nobody's
looking, useful for future debugging). Variant 3b's would-be changes
are not pursued.

## Final decision

After all variants are measured, list the **kept** changes here with
their measured win. Rejected variants get a short reason note so we
don't relitigate.

| Variant | Status | Win over baseline | Notes |
|---|---|---|---|
| 1a | _TBD_ | _TBD_ | |
| 1b | _TBD_ | _TBD_ | |
| 1c | _TBD_ | _TBD_ | |
| 2 | _TBD_ | _TBD_ | |
| 3b | _TBD_ | _TBD_ | |
