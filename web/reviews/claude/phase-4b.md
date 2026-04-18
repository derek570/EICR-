# Phase 4b Review — Real mic capture via AudioWorklet + RMS VU meter

**Commit:** `72fb7da`
**Scope:** `web/public/audio-worklet-processor.js`, `web/src/lib/recording/mic-capture.ts`, `web/src/lib/recording-context.tsx` (Phase 4b diff only — later phases 4c/4d/4e evolution noted but not reviewed).
**Reviewer:** Claude Opus 4.6
**Method:** Analysis-only. No code modified.

---

## 1. Summary

Phase 4b replaces the Phase 4a synthetic VU-meter loop with a real `getUserMedia` → `AudioContext` → `AudioWorkletNode` pipeline. A small `PCMCaptureProcessor` running on the audio thread forwards 128-sample Float32Array blocks to the main thread as transferable `ArrayBuffer`s. On the main thread, `startMicCapture()` computes per-block RMS, smooths it with a 0.3 EMA, and emits both a 0–1 level (for the VU meter) and the raw samples (for Phase 4c Deepgram streaming). `RecordingProvider.start()`/`pause()`/`resume()` are wired to the new handle, with a user-friendly permission-denied message and a `track.ended` watchdog. A `ScriptProcessorNode` fallback handles environments where `audioWorklet.addModule` rejects.

The change is clean, small (~294 insertions), well-commented, and the design-choice rationale aligns with the project's iOS/Safari rules (`{ ideal: 16000 }`, zero-copy `postMessage` transfer, level-push throttling). It is analysis-only scaffolding on a trusted path: mic audio stays in the browser in this phase; Deepgram/Sonnet egress is deferred to 4c/4d.

## 2. Alignment with Phase Goals

| Goal | Evidence | Status |
|------|----------|--------|
| Real mic capture via AudioWorklet | `mic-capture.ts:80-82`, `audio-worklet-processor.js:12-26` | Met |
| RMS VU meter reacting to speech | `mic-capture.ts:99-108` | Met |
| iOS Safari `{ ideal: value }` pattern | `mic-capture.ts:57-58` | Met (per `rules/mistakes.md`) |
| ScriptProcessor fallback | `mic-capture.ts:83-89` | Met |
| Permission-denied surface | `recording-context.tsx@72fb7da:148-158` | Met |
| `pause()` tears down mic entirely | `recording-context.tsx@72fb7da:166-173` | Met (deliberate — deferred to 4e) |
| Track-ended watchdog | `mic-capture.ts:127-132` | Met |
| ~60Hz level-push throttle | `recording-context.tsx@72fb7da:135-140` | Met |
| Extracted, reusable helper | `mic-capture.ts` module boundary | Met |

No scope creep. No Phase 4c/4d/4e work snuck in.

## 3. Correctness

### P0 — Critical

None. No crashes, no data loss, no security bypass, no violated rules from `.claude/rules`.

### P1 — Should fix before next phase

**P1-1. AudioWorklet + `AudioContext({ sampleRate: 16000 })` can throw on some iOS Safari versions.**
`mic-capture.ts:69` forces `new AudioCtx({ sampleRate: 16000 })`. Older iOS Safari (≤ 15.3) historically ignored or threw on the `sampleRate` option, and some builds reject non-native rates (typically 48000) with `NotSupportedError`. Combined with `{ ideal: 16000 }` on the track (which may yield 48000 anyway), the AudioContext could refuse to construct while `getUserMedia` has already granted the mic. Result: the `catch` in `start()` surfaces a confusing non-permission error but the mic permission prompt was still accepted. Consider trying `16000` first, then falling back to the default context rate and handling resampling downstream. See also P1-3.

**P1-2. Sample-rate mismatch risk feeding Deepgram in Phase 4c.**
`mic-capture.ts:69` requests context at 16000 but the `MediaStreamTrack` sample rate is not guaranteed to match (especially on desktop Chrome with an external 48 kHz interface — Chrome creates an internal resampler but the audible result isn't always exactly 16 kHz). The worklet always emits at `audioContext.sampleRate`. Because the handle returns `audioContext.sampleRate` (line 134) and 4c uses it (`recording-context.tsx:269`, `375`), Deepgram will be told the correct rate — good. But the intent "16 kHz mono for Deepgram" is not guaranteed, and there's no log/metric when the actual rate differs. Recommend logging `audioContext.sampleRate` once at startup so field issues are diagnosable.

**P1-3. `audioContext.resume()` is only awaited; it is not retried after a user gesture.**
`mic-capture.ts:70-72` resumes if suspended. On iOS Safari, an AudioContext created before a user gesture can land in `suspended` and reject `resume()` unless called within the gesture callback. `start()` is invoked from a button click so this usually works, but the `await` chain (`await getUserMedia` → `new AudioCtx` → `await resume`) runs *after* the permission prompt returns, which on iOS Safari can be hundreds of ms *after* the originating user gesture, so the context may silently stay suspended. The VU meter would stay at zero. No retry and no warning. Construct the `AudioContext` synchronously inside the click handler (and pass it in) to preserve the user-gesture affinity, or at minimum log/surface `audioContext.state` after `resume()`.

**P1-4. `track.ended` listener is never removed.**
`mic-capture.ts:127-132` attaches an `ended` listener but `stop()` (lines 137-152) does not `track.removeEventListener('ended', …)`. After `stop()` runs, `track.stop()` will itself fire `ended`, which invokes `opts.onError` with "Microphone track ended". The consumer (`recording-context.tsx@72fb7da:142-146`) then calls `setState('error')` and pops a phantom error *on a clean stop*. Hoist the handler into a named function and remove it in `stop()`, or guard `onError` with the same `stopped` flag used on line 135.

**P1-5. ScriptProcessor fallback is permanently connected to `audioContext.destination`.**
`mic-capture.ts:88` does `scriptNode.connect(audioContext.destination)` because `ScriptProcessorNode` requires its output to be consumed. That routes the **live mic signal directly to the user's speakers**, producing a feedback loop (especially with `echoCancellation: true` dampened — EC is applied by the platform before the stream, so this routing loops the post-EC signal). Consumer VPN browsers or old Edge (the fallback target) are exactly the environments that will hear themselves on the laptop speakers. Route through a `GainNode` with `gain.value = 0` instead of connecting directly to destination.

**P1-6. `audioWorklet.addModule` rejection is overly broad.**
`mic-capture.ts:79-89` catches any error from `addModule` and falls back. If the worklet file 404s (e.g. PWA precache miss, custom CSP, Next `basePath`), we silently downgrade to the deprecated path with the feedback loop (P1-5). Add a narrower predicate (e.g. catch only `'audioWorklet' in audioContext === false`) or log the fallback reason.

### P2 — Nice to have

**P2-1. No `AbortSignal` support.**
`startMicCapture` is async but does not accept an `AbortSignal`. If the user hits Stop while `getUserMedia` is still waiting for the permission dialog, the promise will resolve *after* the user wanted to cancel, opening a mic that is then immediately torn down — OK in practice but wasteful and may flash the mic indicator unexpectedly.

**P2-2. EMA constant and mapping are magic numbers.**
`mic-capture.ts:94,106` hard-code `0.3` EMA and `rms/0.3` / `^0.7` mapping. The commit message justifies them empirically. Promoting to `const` with a named comment block (ideally tied to the iOS app's same curve) would make tuning traceable.

**P2-3. `opts.onSamples?.(samples)` may be called with a detached buffer.**
`audio-worklet-processor.js:20` transfers the ArrayBuffer. After `handleSamples` reads the samples for RMS (fine, that's before `onSamples` runs), the consumer in `recording-context.tsx:353` writes the same buffer to a ring buffer. Phase 4b has no ring-buffer consumer, so this is latent; but it means any Phase 4c code that *retransfers* the buffer (e.g. posting to a WebSocket worker) will invalidate subsequent `setSamples` readers down the chain. Document the ownership contract on `onSamples`.

**P2-4. No JSDoc on `handle.sampleRate`.**
Minor. The `MicCaptureHandle.sampleRate` field has no JSDoc — a comment clarifying it's `AudioContext.sampleRate` (not the track rate) would prevent 4c confusion.

**P2-5. `NotSupportedError` path when worklet is unavailable on SSR.**
`typeof window === 'undefined'` check on line 50 is good, but `'use client'` boundaries plus Next 16 server components mean this module could still be imported server-side if the call graph changes. No concrete bug today.

**P2-6. Error message regex overmatches.**
`recording-context.tsx@72fb7da:152-155` tests `/NotAllowed|denied|dismiss/i`. "dismiss" could match an unrelated error like "Connection dismissed by peer". Use `DOMException.name === 'NotAllowedError'` instead of a regex where the exception object is in hand.

## 4. Security

- `navigator.mediaDevices.getUserMedia` is called only from a user-driven `start()` path — no background mic open. OK.
- `echoCancellation`, `noiseSuppression`, `autoGainControl` all `true` — consistent with privacy-respecting defaults, no raw-PCM leakage.
- Worklet loaded from same-origin `/audio-worklet-processor.js`. Content is static, 26 lines, no network or storage access from the processor. OK.
- In Phase 4b, samples never leave the browser (`onSamples` consumer in the original 4b `recording-context.tsx` is absent — `setTranscript([])` and empty). Confirmed no WS egress at this commit.
- `pause()` fully tears the mic down, closing the track. This is the safer default for Phase 4b and matches the "why" in the commit message. Good security posture.
- No hard-coded tokens, keys, or user data. No XSS surface.

**Risk:** The commit message correctly flags Phase 4e will swap `pause()` for a keep-alive. When that lands, audit the permission/indicator implications separately (this review does not cover it).

## 5. Performance

- **Zero-copy worklet transfer** (`audio-worklet-processor.js:19-20`): correct use of transferable ArrayBuffer. Good.
- **RMS loop** (`mic-capture.ts:100-104`): tight, scalar, no allocations. 128 samples every ~8 ms = ~16 k mults/sec — trivial.
- **60 Hz level throttle** (`recording-context.tsx@72fb7da:135-140`): correct approach; uses `performance.now()` which is monotonic. Good.
- **`setInterval` at 100 ms** for the timer/cost tick (`recording-context.tsx@72fb7da:115-121`): fine; cheap, not drifting meaningfully over a recording.
- **Potential issue:** every block creates a new Float32Array (`audio-worklet-processor.js:19`) → GC pressure at ~125 Hz. At 128 samples × 4 bytes = 512 bytes/block × 125 /s = 64 KB/s of short-lived allocations. Negligible on desktop; measurable on low-end Android. Acceptable.
- **Context close is fire-and-forget** (`mic-capture.ts:149-151`): `.catch(() => {})` swallows. OK but silent. Suggest `.catch(console.warn)` in dev.

Overall performance is good. No obvious leaks in Phase 4b itself (see P1-4 for the only semi-leak — spurious error fire).

## 6. Accessibility

Phase 4b is not a UI surface directly, but:

- **Permission-denied copy** (`recording-context.tsx@72fb7da:154`) is plain, actionable prose — good for screen readers.
- **State is mirrored into `state === 'error'`** which downstream components can announce via `aria-live`. The overlay rendering itself is outside this phase.
- No focus trap or keyboard interaction added in this diff — N/A.

No a11y regressions. Recommend (not blocking) that the permission error be surfaced via `aria-live="assertive"` in the overlay (covered by Phase 4a review if applicable).

## 7. Code Quality

**Strengths:**
- Tight module boundary; `startMicCapture` has one well-documented job.
- Named types (`MicCaptureHandle`, `MicCaptureOptions`) with JSDoc.
- Comments explain *why*, not just *what* (e.g. the transfer-buffer aliasing comment, iOS rule reference).
- Refs-based teardown (`micRef`, `tickRef`, `lastLevelPushRef`) avoids React dependency loops — good React idiom for audio-graph lifecycles.
- `stop()` is idempotent (`stopped` guard, line 135).

**Weaknesses:**
- Hard-coded constants (EMA 0.3, mapping 0.3/0.7, throttle 16, ScriptProcessor buffer 4096) — promote to named consts.
- Duplicate `startMicCapture` call sites in `start()` and `resume()` (both in `recording-context.tsx@72fb7da`) — the Phase 4b diff extracts nothing here. (4c onward does extract `beginMicPipeline`; this is already addressed in subsequent phases.)
- `webkitAudioContext` cast (`mic-capture.ts:67-68`) is fine but awkward — a lib type augmentation would be cleaner.
- No ESLint disable comments needed — clean lint.
- Error message regex (P2-6) is brittle.

## 8. Test Coverage

**Current state:** Zero tests for Phase 4b.

- No unit tests for `startMicCapture` (searched `web/src` for `mic-capture` — only `sw.ts` references it in a comment, plus `recording-context.tsx` imports it). 
- No tests for the worklet processor.
- No integration tests for `RecordingProvider.start/pause/resume` with a mocked `getUserMedia`.

The file set is inherently hard to unit-test because AudioWorklet + MediaStream do not exist in jsdom, and Node's `vm` cannot host AudioContext. Nevertheless, the pure-logic parts are testable:

- **RMS + EMA mapping** (`handleSamples` closure) could be extracted as a pure function and tested with representative Float32Array fixtures (silence, sine, clipping).
- **Level throttle** (`lastLevelPushRef` gate in `recording-context`) is testable with a fake clock.
- **Permission-denied regex** is testable by string input.
- **State transitions** in `RecordingProvider` can be tested with `@testing-library/react` using a mocked `startMicCapture` module.

Recommend at minimum: a pure `computeRmsLevel(samples, prev, ema)` extraction with 3–4 table-tests, and a Playwright smoke test that denies mic permission and asserts the error message.

## 9. Suggested Fixes (numbered, file:line)

1. **`web/src/lib/recording/mic-capture.ts:127-132`** — Hoist the `ended` listener into a named function and remove it inside `stop()` (or check the `stopped` flag before calling `onError`) so a clean teardown does not fire a phantom "Microphone track ended" error into the UI. *(P1-4)*
2. **`web/src/lib/recording/mic-capture.ts:85-88`** — Route the ScriptProcessor output through a muted `GainNode` (`gain.value = 0`) instead of connecting directly to `audioContext.destination` to prevent live-mic feedback on the fallback path. *(P1-5)*
3. **`web/src/lib/recording/mic-capture.ts:69-72`** — Construct the `AudioContext` synchronously inside the click handler (pass it in) so iOS Safari retains user-gesture affinity, or log `audioContext.state` after `await audioContext.resume()` and surface a clear error when still `suspended`. *(P1-3)*
4. **`web/src/lib/recording/mic-capture.ts:69`** — Wrap `new AudioCtx({ sampleRate: 16000 })` in a try/fallback to `new AudioCtx()` (no options) for iOS Safari versions that reject non-native rates; log the effective `audioContext.sampleRate`. *(P1-1, P1-2)*
5. **`web/src/lib/recording/mic-capture.ts:79-89`** — Narrow the fallback `catch` to a specific error (feature-detect `'audioWorklet' in audioContext` or match by name) and log the reason so a 404 on the worklet JS doesn't silently degrade into the ScriptProcessor path. *(P1-6)*
6. **`web/src/lib/recording-context.tsx@72fb7da:152-155`** — Replace `/NotAllowed|denied|dismiss/i.test(msg)` with `err instanceof DOMException && err.name === 'NotAllowedError'` for precise matching. *(P2-6)*
7. **`web/src/lib/recording/mic-capture.ts:93-107`** — Promote `EMA`, the `0.3` RMS anchor, and the `0.7` exponent to named module-scope constants with a comment tying them to the iOS app's equivalent curve. *(P2-2)*
8. **`web/src/lib/recording/mic-capture.ts:49`** — Accept an optional `{ signal?: AbortSignal }` option and abort the `getUserMedia` request if the user hits Stop before the permission prompt resolves. *(P2-1)*
9. **`web/src/lib/recording/mic-capture.ts:29-32`** — Add JSDoc to `MicCaptureHandle.sampleRate` clarifying it is `AudioContext.sampleRate`, not the `MediaStreamTrack` rate. *(P2-4)*
10. **`web/src/lib/recording/mic-capture.ts` (new tests)** — Extract `computeLevel(samples, prev)` as a pure helper and add Vitest table-tests for silence / 1 kHz sine / clipped inputs; add a Playwright smoke that denies mic permission and asserts the friendly error copy. *(§8)*

## 10. Verdict + Top 3 Priorities

**Verdict:** **Approve with follow-ups.** Phase 4b achieves its stated goal, aligns with project rules (iOS `{ ideal }`, transferable buffers, React ref-based audio lifecycles), and contains no P0 defects. The weaknesses are realistic edge-case handling (iOS suspended context, feedback loop on the deprecated fallback, spurious track-ended error on clean stop) rather than design mistakes.

**Top 3 priorities before Phase 4c ships to production:**

1. **Fix #1 (track.ended phantom error)** — one-line bug that will flash the overlay red on every legitimate Stop press. Highest visibility, cheapest fix.
2. **Fix #2 (ScriptProcessor → destination feedback loop)** — audible mic-on-speaker feedback for any user whose browser hits the fallback path; qualitatively bad and hard to diagnose post-hoc.
3. **Fix #3 + #4 (iOS Safari suspended context + sampleRate fallback)** — the whole point of running Phase 4b before Deepgram is to validate the iOS PWA audio path. Surface `audioContext.state` after `resume()` and fall back gracefully on non-native sample rates so field reports are actionable.
