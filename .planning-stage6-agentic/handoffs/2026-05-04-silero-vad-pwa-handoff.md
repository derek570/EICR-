# Handoff: PWA Silero v5 ONNX VAD wake gate (T20)

**Author:** Claude Opus 4.7 session, 2026-05-04
**Branch:** `pwa-ios-parity-overnight`
**Status (code):** SHIPPED on branch — all 6 implementation steps
landed across 3 commits (`fe774bb`, `ced407f`, `709debc`). 468/468
web vitest cases green; production build clean.
**Status (rollout):** Default flipped ON by user instruction
(skipping the planned one-week soak). The env flag is now an
emergency kill switch — set `NEXT_PUBLIC_SILERO_VAD=0` at build
time to revert.

**Implementation SHA pins:**
- iOS-canon model: `silero_vad.onnx`,
  SHA256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`,
  size 2,327,524 bytes. Identical bytes shipped at
  `web/public/models/silero_vad.onnx` and
  `CertMateUnified/Sources/Resources/silero_vad.onnx`.
- onnxruntime-web pinned to `^1.25.1` in `web/package.json`.

---

## Why this is open

The PWA's `SleepManager` wakes from sleeping based on raw RMS energy
(≥0.02 for 12 consecutive ~16ms frames ≈ 200ms). On a quiet bench
that works; in the field it false-wakes on:

- Tool noise (impact driver, drill, multimeter beep)
- Footsteps, breath, knee bumps on the consumer-unit cabinet
- Vehicle noise (the inspector's van, passing traffic)
- HVAC plant rooms, fans, ventilation

Each false-wake causes a Deepgram reconnect (~1–2s key fetch + ~1–2s
WS handshake + ring buffer replay). On a busy day that's tens of
unnecessary reconnects, each one with a small risk of the
reconnect-storm pattern documented at iOS production session
E3842961 (2026-04-27). It also burns Deepgram session-start fees.

iOS solved this on 2026-04-27 by adopting Silero v5 ONNX:

- **Threshold 0.80 probability** (vs RMS, which has no probability
  semantics).
- **Sliding window 12 / 30 frames** (12 frames of speech in any
  960ms window — ~384ms of sustained speech).
- **Energy floor 0.002 RMS** before VAD inference runs (frames
  below the floor count as non-speech but DON'T reset prior speech
  count — so a brief mic dip mid-utterance doesn't kill the wake).

The PWA file at `web/src/lib/recording/sleep-manager.ts` already has
the 12-frame window and energy-floor structure in place — only the
score function needs to swap from `rms >= 0.02` to
`sileroVad.process(chunk) >= 0.80`.

---

## iOS implementation reference

### Model

- **File:** `silero_vad.onnx` (Silero v5)
- **Source:** Silero GitHub release at <https://github.com/snakers4/silero-vad>
  — pin a specific commit in package.json or check the model into
  `web/public/models/silero_vad.onnx` so deploys are reproducible.
  iOS pinned the v5 model in `Resources/`; matching version is
  load-bearing for behavioural parity.
- **Size:** ~2.2MB (vs v3's 800KB). Worth the bytes for the noise
  robustness.

### Inputs (per call)

- `input: float32[1, 576]` — 64 context samples (last 64 of the
  prior chunk) + 512 fresh samples.
- `state: float32[2, 1, 128]` — recurrent state, persists across
  calls.
- `sr: int64` — sample rate scalar, 16000.

### Outputs

- `output: float32[1, 1]` — speech probability for this 32ms chunk.
- `stateN: float32[2, 1, 128]` — updated state for the next call.

### Per-call protocol (iOS `SileroVAD.process` line 42)

1. Lock (single-threaded inference — ONNX Runtime's session is
   stateful via `state`, racing two calls would corrupt it).
2. Build `inputData = context + chunk`.
3. Run session with `inputs = { input, state, sr }`,
   `outputNames = { output, stateN }`.
4. Extract probability from `output`.
5. Update `state` from `stateN` for the next call.
6. Save the last 64 samples of `chunk` as the next call's `context`.
7. Return probability.

`reset()` zeros both `state` and `context`. iOS calls this on every
session start so a long-running app instance doesn't carry
inter-session state.

---

## Web implementation plan

### Step 1 — dependencies (one commit)

```bash
cd web
npm install onnxruntime-web --save
```

The `onnxruntime-web` package ships:
- `dist/ort.min.js` — main runtime, ~3MB compressed.
- `dist/ort-wasm.wasm`, `ort-wasm-simd.wasm`,
  `ort-wasm-threaded.wasm` — WASM backends.

Configure the WASM path in `next.config.ts` so Next bundles them
correctly:

```ts
// next.config.ts
const nextConfig = {
  // ... existing config ...
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
  async headers() {
    return [
      // Cross-Origin-Isolation needed for SharedArrayBuffer-backed
      // multi-thread ORT. Skip if we're staying single-thread.
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};
```

**Risk: COEP/COOP headers break embedded third-party content.**
Audit any iframes or cross-origin assets first. If there's any, skip
the COEP header and configure ORT for single-thread mode (slower but
zero CORS impact). For VAD inference at 32ms chunks, single-thread
is more than fast enough.

### Step 2 — host the model (one commit)

```bash
mkdir -p web/public/models
# Download silero_vad v5 from snakers4/silero-vad releases
# (verify SHA256 matches whatever the iOS bundle ships)
curl -L -o web/public/models/silero_vad.onnx \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
```

Add a SHA256 verification step to CI to guard against silent model
drift. Use `crypto.subtle.digest('SHA-256', ...)` in a build hook or
just check the file in.

The file is fetched at runtime via `fetch('/models/silero_vad.onnx')`
+ `arrayBuffer()`. Service worker (Serwist) should cache it under the
`certmate-cache` IDB so offline recordings still wake correctly.

### Step 3 — write the VAD wrapper (`web/src/lib/recording/silero-vad.ts`)

Mirror the iOS API surface so the swap into `SleepManager` is a
one-line replacement of the RMS check.

```ts
// web/src/lib/recording/silero-vad.ts
import * as ort from 'onnxruntime-web';

export class SileroVAD {
  private session: ort.InferenceSession | null = null;
  private state: Float32Array;
  private context: Float32Array;
  private static readonly STATE_SIZE = 2 * 1 * 128;
  private static readonly CONTEXT_SIZE = 64;
  private static readonly CHUNK_SIZE = 512;

  constructor() {
    this.state = new Float32Array(SileroVAD.STATE_SIZE);
    this.context = new Float32Array(SileroVAD.CONTEXT_SIZE);
  }

  async load(modelUrl = '/models/silero_vad.onnx'): Promise<void> {
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error(`silero_vad fetch failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    this.session = await ort.InferenceSession.create(buf, {
      executionProviders: ['wasm'],
      // Single-thread: avoids the COEP/COOP requirement and
      // SharedArrayBuffer browser feature gating. 32ms chunks take
      // <2ms inference on a mid-tier iPhone — single-thread is fine.
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
  }

  /**
   * Process a 512-sample chunk @ 16kHz mono float32.
   * Returns the speech probability in [0, 1]. Throws if the
   * session hasn't loaded yet — the SleepManager bootstrap awaits
   * load() before arming the wake gate so this should never fire
   * in production.
   */
  async process(chunk: Float32Array): Promise<number> {
    if (!this.session) throw new Error('SileroVAD: session not loaded');
    if (chunk.length !== SileroVAD.CHUNK_SIZE) {
      throw new Error(`SileroVAD: expected ${SileroVAD.CHUNK_SIZE}, got ${chunk.length}`);
    }
    // Build [1, 576] input = 64 context + 512 chunk.
    const input = new Float32Array(SileroVAD.CONTEXT_SIZE + SileroVAD.CHUNK_SIZE);
    input.set(this.context, 0);
    input.set(chunk, SileroVAD.CONTEXT_SIZE);

    const inputTensor = new ort.Tensor('float32', input, [1, input.length]);
    const stateTensor = new ort.Tensor('float32', this.state, [2, 1, 128]);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);

    const outputs = await this.session.run({
      input: inputTensor,
      state: stateTensor,
      sr: srTensor,
    });

    const probability = (outputs.output.data as Float32Array)[0];
    // Update state from stateN (mirrors iOS line 93).
    this.state = new Float32Array((outputs.stateN.data as Float32Array));
    // Save trailing 64 samples as next call's context.
    this.context = chunk.slice(SileroVAD.CHUNK_SIZE - SileroVAD.CONTEXT_SIZE);
    return probability;
  }

  reset(): void {
    this.state.fill(0);
    this.context.fill(0);
  }
}
```

### Step 4 — feed 512-sample chunks into VAD

The PWA's mic capture currently emits Float32 PCM at 16kHz via
`mic-capture.ts` → `resampleTo16k` → `audio-ring-buffer.ts`. Add a
chunk accumulator at the SleepManager-input boundary:

```ts
// In recording-context.tsx where micCallback drives sleepManager.processAudioLevel
// Replace the RMS gate with a chunk accumulator + VAD:

const VAD_CHUNK_SIZE = 512;  // 32ms @ 16kHz
let vadAccumulator = new Float32Array(VAD_CHUNK_SIZE);
let vadAccumulatorOffset = 0;

const onSamples = async (samples: Float32Array) => {
  // Push samples into the 512-sample accumulator. When full, drop
  // a chunk into the VAD and reset.
  for (let i = 0; i < samples.length; i++) {
    vadAccumulator[vadAccumulatorOffset++] = samples[i];
    if (vadAccumulatorOffset === VAD_CHUNK_SIZE) {
      const chunk = vadAccumulator;
      vadAccumulator = new Float32Array(VAD_CHUNK_SIZE);
      vadAccumulatorOffset = 0;
      // Energy floor — skip inference on near-silent chunks.
      const rms = computeRms(chunk);
      if (rms < 0.002) {
        sleepManagerRef.current?.processVadFrame(/* score = */ 0);
        continue;
      }
      // Inference is async but fast (<2ms typical). Don't await
      // here — fire and forget; the SleepManager's per-frame
      // gating handles late frames.
      void sileroRef.current
        ?.process(chunk)
        .then((prob) => sleepManagerRef.current?.processVadFrame(prob))
        .catch(() => {});
    }
  }
};
```

### Step 5 — swap SleepManager's wake gate

Replace `processAudioLevel(rms)` with `processVadFrame(score)`:

```ts
// In sleep-manager.ts:
processVadFrame(score: number): void {
  if (this.state === 'active') return;
  if (performance.now() < this.cooldownUntilMs) {
    this.consecutiveSpeechFrames = 0;
    return;
  }
  // iOS canon — 0.80 threshold, 12 consecutive frames.
  if (score >= this.cfg.vadWakeThreshold) {
    this.consecutiveSpeechFrames++;
    if (this.consecutiveSpeechFrames >= this.cfg.wakeFramesRequired) {
      this.consecutiveSpeechFrames = 0;
      this.isPostWakeGrace = true;
      this.setState('active');
      this.armNoTranscriptTimer();
      this.cbs.onWake?.('sleeping');
    }
  } else {
    this.consecutiveSpeechFrames = 0;
  }
}
```

Update config defaults:

```ts
const DEFAULTS: Required<SleepManagerConfig> = {
  noTranscriptTimeoutSec: 60,
  questionAnswerTimeoutSec: 75,
  postWakeGraceSec: 90,
  vadWakeThreshold: 0.80,        // ← new (iOS line 42)
  wakeFramesRequired: 12,
  postSleepCooldownMs: 2000,
};
```

Drop the now-unused `wakeRmsThreshold` field.

### Step 6 — bootstrap on session start

```ts
// In recording-context.tsx start():
const silero = new SileroVAD();
await silero.load();   // ~50–200ms first time, cached by SW after
sileroRef.current = silero;
```

Failure to load (offline + uncached) → fall back to the RMS path
with a console warning. The session continues; the inspector just
loses the noise-rejection benefit until the model is reachable.

### Step 7 — tests

- Unit tests for the chunk accumulator (drop the right 512-sample
  windows; preserve trailing partial samples).
- Mock the ONNX session (`load()` no-op + `process()` returning a
  scripted probability) and confirm SleepManager wakes after exactly
  12 consecutive ≥0.80 scores.
- Confirm the 2s cooldown after entering sleep suppresses wake even
  if the mock returns 1.0 every frame.
- Integration test: start a session, drive VAD scores below
  threshold for 60s, assert the no-final timer entered sleeping.
  Drive 12 consecutive ≥0.80 scores, assert it woke with
  `from === 'sleeping'`.

### Step 8 — feature flag the rollout

```ts
// In sleep-manager.ts config:
useSileroVad?: boolean;  // default false until prod-soak passes
```

Initial deploy: flag OFF, both code paths in place. Flip ON in
`web/.env.production` after a one-week soak with monitoring of the
`stage6.transcript_suppressed_during_wake` and
`recording_session_started` CloudWatch metrics. Roll back is a
single env var change.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bundle size jump (~5MB JS + 2.2MB model) impacts FCP on slow networks | High | Lazy-load `silero-vad.ts` only after the user starts a recording — ORT + model fetch hides behind the first speak/listen prompt. PWA cache makes subsequent loads instant. |
| iOS Safari rejects the WASM file (CSP / MIME) | Medium | Verify Content-Security-Policy allows `wasm-unsafe-eval`; add `wasm` to `Content-Type` in next.config.ts headers if Safari serves it as `application/octet-stream`. |
| ONNX session creation crashes on iOS Safari (memory) | Low–Med | Single-thread mode + the small v5 model fit comfortably in the 256MB iOS Safari heap. Verify with Memory profiler. |
| `BigInt64Array` for the `sr` tensor unsupported on older browsers | Low | All target browsers (Safari 15+, Chrome 88+) support BigInt. Worst case: skip the `sr` tensor — Silero v5 defaults to 16kHz. |
| Inference race — two parallel `process()` calls corrupt `state` | High if not handled | The accumulator pattern above is single-threaded by JS event-loop semantics, but if a future caller fans out — protect with a mutex (single-flight queue). |
| Model SHA drifts vs iOS bundle | Medium | CI step verifies SHA256 of `web/public/models/silero_vad.onnx` matches the iOS-bundled file. Document the SHA in this handoff once committed. |
| COEP/COOP headers break OAuth popups / embeds | Medium | Skip COEP if not using multi-thread ORT. Audit `app/login/`, `app/auth/` for cross-origin redirects before flipping. |

---

## Definition of done

1. ✅ `npm install onnxruntime-web` lands. (`fe774bb`)
2. ✅ Model file at `web/public/models/silero_vad.onnx` with SHA256
   recorded above. (`fe774bb`)
3. ✅ `web/src/lib/recording/silero-vad.ts` matches the iOS API.
   (`ced407f`)
4. ✅ Mic capture pipeline emits 512-sample chunks to VAD via the
   accumulator in `vad-accumulator.ts`. (`ced407f` + `709debc`)
5. ✅ SleepManager exposes `processVadFrame(score)`; recording
   context routes Silero scores through it when loaded, RMS via
   `processAudioLevel` otherwise. Master flag is
   `NEXT_PUBLIC_SILERO_VAD` (env var, not a config object field —
   simpler than threading a config through SleepManager when the
   gate happens upstream of it). (`709debc`)
6. ✅ Tests covering: chunk accumulation (11 cases,
   `tests/vad-accumulator.test.ts`), wake gate (8 cases,
   `tests/sleep-manager-vad.test.ts`). 468/468 vitest green.
   (`ced407f` + `709debc`)
7. ⏳ CloudWatch metrics for false-wake count (compare prev RMS path
   to Silero path). NOT populated — soak skipped on the code flip;
   counters still worth wiring so a regression has telemetry.
8. ✅ Default flipped ON in code (recording-context.tsx) by user
   instruction. Kill switch is `NEXT_PUBLIC_SILERO_VAD=0` build-arg.
9. ⏳ iOS bundle SHA256 matches web SHA256 — currently true
   (`1a153a22…` matches both); CI guard not yet added.

## Remaining work (post-flip)

The flag is ON in production from the next deploy of this branch.
Two follow-ups remain — neither blocks the cutover, both are
defence-in-depth for the soak window we skipped:

1. **Add the SHA-match CI guard.** A small step in the deploy
   workflow that diffs `web/public/models/silero_vad.onnx` SHA256
   against `CertMateUnified/Sources/Resources/silero_vad.onnx`. If
   either side bumps without the other, the build fails. Stops the
   subtle drift this whole port is designed to prevent.

2. **Add CloudWatch counters.** Two metrics on the recording flow:
   - `recording.wake.fired{path=silero|rms}` — incremented per wake.
   - `recording.wake.cooldown_suppressed` — incremented when a wake
     would have fired but cooldown was active.
   Wire them into the recording-context onWake / suppressed paths.
   Goal: dashboard the per-deploy false-wake rate so a regression
   surfaces in data before it surfaces as inspector complaints.

---

## Files this handoff touches (preview)

- `web/package.json` — add onnxruntime-web
- `web/next.config.ts` — WASM headers, possible COEP/COOP
- `web/public/models/silero_vad.onnx` — new (binary)
- `web/src/lib/recording/silero-vad.ts` — new
- `web/src/lib/recording/sleep-manager.ts` — replace
  `processAudioLevel` with `processVadFrame`, drop RMS config
- `web/src/lib/recording-context.tsx` — chunk accumulator + VAD
  init + ref management
- `web/src/lib/recording/mic-capture.ts` — possibly: emit
  pre-resampled 16kHz frames at the SleepManager boundary if
  ergonomic
- `web/tests/silero-vad.test.ts` — new
- `web/tests/sleep-manager-vad.test.ts` — new

---

## Earlier context (this session, 2026-05-04)

12 commits closed 11 of 12 audit gaps from the iOS↔PWA parity
report. Branch: `pwa-ios-parity-overnight`. The audit identified
T20 as the largest remaining gap; everything else either landed
cleanly or fits in a small follow-up. See:

- `.planning/parity-audit/diff.md` — the original audit doc
- Commits `b879375 → 246c368` (12 total) on this branch

The iOS reference for SileroVAD is at
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Audio/SileroVAD.swift`
(120 lines) — the code pattern there is the exact contract this
port needs to match. iOS uses `OnnxRuntimeBindings` (Objective-C
bridge); the web port uses `onnxruntime-web`. The wire shapes
match — that's the point.

When you pick this up: read SileroVAD.swift first (it's short),
then this doc, then start with Step 1. Should be one focused
~4-hour session with the model file fetched, the wrapper written,
and the SleepManager swap done — but the soak + flag rollout adds
a week of calendar time before T20 can be marked closed.
