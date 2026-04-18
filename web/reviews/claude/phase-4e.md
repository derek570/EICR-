# Phase 4e Review — VAD Sleep/Wake with 3s Ring Buffer Replay

**Commit:** `9f1dba6` — feat(web): Phase 4e VAD sleep/wake with 3s ring buffer replay
**Reviewer:** Claude (Opus 4)
**Scope:** `web/src/lib/recording/audio-ring-buffer.ts`, `sleep-manager.ts`, `deepgram-service.ts` (deltas), `recording-context.tsx` (deltas).

---

## 1. Summary

Phase 4e ports the iOS 3-tier power model (Active → Dozing → Sleeping) and the 3-second pre-wake audio replay buffer to the web client. The implementation introduces two well-scoped new modules (`AudioRingBuffer`, `SleepManager`), extends `DeepgramService` with `pause()` / `resume(replay?)` / `sendInt16PCM()`, and wires everything through the existing `RecordingProvider`. The commit message is excellent — WHAT/WHY/WHY-THIS-APPROACH are all present with quantitative cost reasoning.

The shape of the code is clean and readable. The state machine (timers, cooldown, callback ownership) is correct and matches the iOS semantics described in `docs/reference/vad-investigation.md`. However, there are **three correctness issues that will bite in production** (one P0, two P1): a ring-buffer sample-rate assumption that silently breaks replay fidelity on non-16kHz mics, a missing `setState('active')` callback wiring after `SleepManager.start()` emits state via `onStateChange` (the sleep-manager reports state but `RecordingProvider` never subscribes to it — React state + machine state can drift), and a stale-state race in `pause()` / `resume()` / `onEnterDozing` where the React `state` setter is invoked from a plain JS callback even though the manager's internal state is the authoritative source.

Additionally, the review flagged by the commit message itself (RMS-only wake is a placeholder for Silero VAD) is a deliberate, documented regression versus iOS (per journal entry 2026-03-05, iOS moved from RMS-like gating to Silero at threshold 0.85 / 30 frames specifically because of false wakes from breathing / tool noise / phone movement). This is fine as a first pass provided follow-up Silero integration is tracked.

**Overall:** ship-worthy once the P0 resample-on-replay issue is addressed. The architectural shape is sound and the tier semantics are correct.

---

## 2. Alignment with iOS + Phase 4e Spec

| Spec item | Status | Notes |
|---|---|---|
| 3-tier state machine | ✅ | `'active' \| 'dozing' \| 'sleeping'` in `sleep-manager.ts:25`. Correct transitions. |
| `noTranscriptTimeout = 15s` | ✅ | `sleep-manager.ts:59`. Matches iOS `SleepManager.swift`. |
| `dozingTimeout = 1800s` (30min) | ✅ | `sleep-manager.ts:60`. |
| Doze: pause WS, keep alive | ✅ | `deepgram-service.ts:151–153` sets `paused=true`; `startKeepAlive` continues. |
| Sleep: full WS teardown | ✅ | `recording-context.tsx:463` `teardownDeepgram()` + `teardownSonnet()`. |
| 3-s ring buffer | ✅ | `audio-ring-buffer.ts:21–24` default 3s @ 16kHz. |
| Ring buffer writes while paused | ✅ | `recording-context.tsx:353` `ringBufferRef.current?.writeFloat32(samples)` is unconditional, before `deepgramRef.sendSamples()`. |
| Replay on wake-from-doze | ✅ | `recording-context.tsx:415–416` drains then `deepgramRef.resume(replay)`. |
| Replay on wake-from-sleep | ✅ | `recording-context.tsx:406–409`. |
| Post-doze cooldown | ✅ | `sleep-manager.ts:176` 2000ms cooldown matches iOS 63-frame (~2s) window. |
| Final-only reset (not interim) | ✅ | `recording-context.tsx:258` `onSpeechActivity()` is only called from `onFinalTranscript`. Prevents AGC self-feed documented in iOS journal. |
| Server pause-before-WS-pause | ✅ | `recording-context.tsx:453–454` calls `sonnetRef.pause()` before `deepgramRef.pause()` (matches iOS fix `4c75ccf`). |
| Mic preserved across sleep | ✅ | `onEnterSleeping` does NOT teardown mic; ring buffer keeps writing. |
| Wake via **Silero** VAD | ❌ (deliberate) | RMS-only wake documented as placeholder in `sleep-manager.ts:16–19`. iOS has regressed from RMS-like gating precisely because of false wakes (journal 2026-03-05: raised to 0.85 + 30 frames). Web now sits closer to the **older, broken** iOS version. |
| Deepgram `UtteranceEnd`-driven doze entry | ❌ (deliberate?) | Journal entry 2026-03-06 documents iOS switching to Deepgram-UtteranceEnd for **doze entry** because Silero got stuck. Web uses "no-final-transcript for 15s", which is closer to the old iOS approach. Since web doesn't have Silero yet, this is moot for now — but `onUtteranceEnd` is exposed on `DeepgramService` yet never wired into the SleepManager; a future Silero port should revisit. |

---

## 3. Correctness (ordered by severity)

### P0 — Ring buffer replay ignores actual mic sample rate (fidelity bug)

**File:** `recording-context.tsx:347` and `audio-ring-buffer.ts:21–24`.

`AudioRingBuffer` is constructed with hard-coded `(3, 16000)`:

```ts
ringBufferRef.current = new AudioRingBuffer(3, 16000);
```

but the ring buffer is written with `samples` from `mic-capture.ts`, which runs at `handle.sampleRate` (whatever the AudioContext actually negotiated). `mic-capture.ts:69` constructs `new AudioCtx({ sampleRate: 16000 })`, but:
1. Safari (especially iOS) is documented to ignore the `sampleRate` option on `AudioContext` and use the hardware rate (commonly 44100 or 48000).
2. `audioContext.sampleRate` is then exposed as `handle.sampleRate`, and `openDeepgram(handle.sampleRate)` in `recording-context.tsx:375` tells `DeepgramService` to resample in `sendSamples`. Good.
3. **But** the ring-buffer writes happen BEFORE the resample step (in `onSamples`, `recording-context.tsx:353`), so it stores samples at the mic's **native** rate (e.g. 48kHz).
4. On wake, `drain()` returns an `Int16Array`, and `DeepgramService.sendInt16PCM()` dumps it into the WS **without resampling** — Deepgram is told (via the URL) that the stream is 16kHz linear16.

**Consequences** on a 48kHz-native device:
- 48000 samples in the buffer are interpreted by Deepgram as 3 seconds of 16kHz audio — but it's actually 1 second of audio played at 3× speed (pitch shifted up 1.5 octaves).
- Deepgram transcription of the replayed segment is garbage.
- On a 44100Hz device, the ring buffer holds 48000/44100 ≈ 1.09s of audio, replayed at ≈ 2.76× speed.
- The first ~1–3s of every wake sentence — which is *exactly* what the ring buffer exists to fix — is silently mangled on any non-16kHz mic.

**Impact:** iOS Safari on iPhone (the primary mobile target) commonly ignores the 16kHz `AudioContext` constraint. This is a high-probability silent regression on iOS web users.

**Fix direction:** either (a) resample samples to 16kHz before `writeFloat32` into the ring buffer (i.e., move the resample upstream of both DG and buffer), or (b) construct the ring buffer with `durationSec=3, sampleRate=handle.sampleRate` AND resample the drained buffer before `sendInt16PCM`.

### P0 — `drain()` returns correctly ordered samples but math is fragile (confirm via tests)

**File:** `audio-ring-buffer.ts:42–53`.

```ts
out.set(this.buffer.subarray(this.writeIndex, this.capacity), 0);
out.set(this.buffer.subarray(0, this.writeIndex), this.capacity - this.writeIndex);
```

The math is correct: first copy writes `capacity − writeIndex` samples at offset 0; second copy writes `writeIndex` samples at offset `capacity − writeIndex`, landing exactly at the end of the first copy. Boundary cases:
- `writeIndex === 0` + `isFull`: first copy = all `capacity` samples → offset 0. Second copy = `subarray(0,0)` (empty) → offset `capacity`. `Int16Array.set(empty, capacity)` is legal. ✅
- `writeIndex === capacity`: unreachable — `writeFloat32` wraps `writeIndex` to 0 when it hits `capacity`. ✅

This is correct, but there is **zero test coverage** and a one-character off-by-one (e.g. `capacity + 1 - writeIndex`) would silently corrupt every wake replay. See Section 8.

### P1 — `SleepManager.onStateChange` is emitted but never subscribed in `RecordingProvider`

**File:** `sleep-manager.ts:35,139` (emits) vs `recording-context.tsx:448–470` (never wires `onStateChange`).

`SleepManager` exposes `onStateChange` as a debug hook but the `RecordingProvider` does not subscribe to it. Instead, `setState('dozing' | 'sleeping' | 'active')` is called from **each individual** callback (`onEnterDozing`, `onEnterSleeping`, `onWake` → `handleWake`). This works today but has two consequences:

1. **Duplication:** the React `RecordingState` is set in 5 places (`start`, `handleWake`, `pause`, `resume`, `onEnterDozing`, `onEnterSleeping`, `stop`). A future edit that adds a new manager transition (e.g. a "light sleep" tier) must remember to add the React setter at every call site.
2. **Drift risk:** if the manager ever transitions internally without firing the specific `onEnter*` callback (e.g. a future "wake already in progress, ignore" guard short-circuits `onWake`), the React state could linger behind. Subscribing `onStateChange: setState` would make the manager the single source of truth.

Not wrong today — but load-bearing and fragile as the file grows. Recommend wiring `onStateChange` as the authoritative setter and removing the per-callback `setState('...')` calls.

### P1 — `resume()` does not re-arm the SleepManager after manual doze

**File:** `recording-context.tsx:541–597`.

`pause()` at line 541 flips the React state to `'dozing'` and pauses Deepgram/Sonnet — but **does not call `SleepManager.onSpeechActivity()` or any SM API**. The SleepManager's internal state is still `'active'`, which means:

- The no-transcript timer (armed by `start()`) continues running. If the user paused at t=14.9s and held the paused state for 10s, at t=15s the timer fires and `onEnterDozing` is invoked — which calls `sonnetRef.pause()` / `deepgramRef.pause()` a second time (idempotent) and sets React state to `'dozing'` (already dozing). Benign.
- The wake heuristic never runs (SleepManager is still `active`, and `processAudioLevel` early-returns). So during a manual pause, the user's speech **will not wake the system**. The `resume()` button is the only way out.
- On `resume()`, neither the SleepManager's `onSpeechActivity` nor a new `start()` is called. The no-transcript timer may have already fired (→ SM internally `dozing`), in which case `onSpeechActivity()` is a no-op (guard at line 106 — `if (this.state !== 'active') return`).

**Net effect:** manual pause/resume transitions "mostly work" because (a) the doze entry is idempotent and (b) on resume, the next final transcript's `onSpeechActivity()` call will re-arm the timer. But it's accidental, and the 2-second cooldown in `processAudioLevel` is not applied to a manual pause (`onEnterDozing` sets `cooldownUntilMs` but manual `pause()` does not), so an inspector who manually paused cannot rely on wake-by-speech at all unless the 15s auto-timer also fires first.

### P1 — Wake during `requesting-mic` / `idle` state is impossible but `SleepManager.start()` is only called after `beginMicPipeline()`

**File:** `recording-context.tsx:490–494`.

```ts
await beginMicPipeline();
buildSleepManager();
setState('active');
beginTick();
```

`beginMicPipeline()` already connects the `onLevel` callback to `sleepManagerRef.current?.processAudioLevel(level)` (line 360). Because `sleepManagerRef` is null until `buildSleepManager()` runs on line 492, the optional chain correctly no-ops. However, any levels delivered by the mic between `await startMicCapture` resolving and `buildSleepManager` running are lost — fine for this tier (no state yet) but means the cooldown window after session start is *implicit*. Low severity; document or reverse the order (`buildSleepManager()` first, then `await beginMicPipeline`).

### P2 — `onEnterDozing` unconditionally calls `clearTick()` + `setMicLevel(0)` — but the cost ticker stops when dozing, producing a user-visible cost freeze

**File:** `recording-context.tsx:455–457`.

`clearTick()` halts the Deepgram $0.0077/min accrual during doze — which is correct for accuracy (Deepgram is paused) but means the hero cost readout visibly freezes for the 15s between the last final transcript and the 1800s+ doze window. This is intentional per the commit message ("cost ticker stopped"), and matches iOS. No issue, but worth confirming with the UX spec that the frozen hero cost is the intended behaviour (users may read the freeze as a bug).

### P2 — `lastLevelPushRef` throttle is *before* `processAudioLevel` — good, but UI-level throttle is not applied to the VAD path

**File:** `recording-context.tsx:357–363`. Already correct — `processAudioLevel` is called **above** the 16ms throttle, so the SleepManager sees every sample (~60–125Hz depending on buffer size). Worth a code-comment acknowledgement because the order is subtle.

### P2 — `handleWake` from `sleeping` without mic handle recurses into `beginMicPipeline()` but ring buffer is reset

**File:** `recording-context.tsx:399–403`.

```ts
if (!mic) {
  // Mic died while sleeping — start a fresh pipeline. Rare.
  await beginMicPipeline();
}
```

`beginMicPipeline()` creates a **new** ring buffer (line 347 `new AudioRingBuffer(3, 16000)`), throwing away whatever was captured before mic-loss. The wake will succeed but the 3s replay will be empty — Deepgram misses the wake sentence. This is the "rare" case and no replay is attempted afterward. Consider: if mic died, did we even have pre-wake audio? Probably not; this is fine. But `onWake` still fires with `from='sleeping'` — so the user experience is a wake with no transcription of whatever triggered it. Low severity because by definition the mic wasn't running.

### P2 — `pause()` and `resume()` do not update the SleepManager's internal state

Covered in P1 above — flagging at P2 that these are in the "public" RecordingActions contract. A `SleepManager.forceDoze()` / `forceActive()` API would make this explicit.

### P2 — `sendInt16PCM` path in `resume()` doesn't check `WebSocket.OPEN`

**File:** `deepgram-service.ts:132–144`.

The guard is `this.state !== 'connected'`, which tracks the service's cached state. If the WS transitioned to CLOSING (code 1000 acknowledged but handshake in flight) between `resume()` entry and `send()`, this will throw into the catch block. Caught and silently dropped — benign, but the replay is lost. Not a regression, matches `sendSamples`.

---

## 4. Security

- No new user input reaches the network. Deepgram keys are fetched via `api.deepgramKey(sessionId)` (existing auth path) — unchanged from Phase 4c.
- WebSocket auth uses subprotocol token (`['token', apiKey]`) per `rules/mistakes.md` guidance. Correct.
- Ring buffer stores raw mic PCM in memory only; no persistence. Size bounded to 3s × 16kHz × 2 bytes = 96KB. No DoS surface.
- `SleepManager` timers are bounded (15s, 1800s); no unbounded re-arm loops.
- No XSS / injection surfaces introduced.

No security concerns.

---

## 5. Performance

- **Hot path (audio samples):** `onSamples` now does an extra `ringBufferRef.writeFloat32(samples)` per block. That's a tight for-loop over ~128 samples (Worklet) or 4096 (ScriptProcessor). Clamp + round + assign per sample — on the order of microseconds. No GC pressure (writes into pre-allocated `Int16Array`). ✅
- **`processAudioLevel`:** called on every audio callback (not throttled). Internal work is O(1) — one `performance.now()` + a branch + an increment. ✅
- **Timers:** 2 × setTimeout + 1 × setInterval (inherited KeepAlive). No drift risk.
- **`drain()`:** allocates a fresh `Int16Array` (48000 × 2B = 96KB) on each wake. Called 0–few-times per session. Negligible. ✅
- **Re-renders:** `onEnterDozing` calls `setMicLevel(0)` + `setState('dozing')` — two renders. `onEnterSleeping`: one render + `teardownDeepgram`/`teardownSonnet` each trigger `setDeepgramState`/`setSonnetState`. Acceptable.

**Concern:** none. Worth stress-testing: rapid wake/sleep cycling (VAD chatter) should not leak timers — the `clearNoTranscriptTimer` and `clearDozingTimer` calls look correct in every path.

---

## 6. Accessibility

N/A — Phase 4e is pipeline-internal. No UI changes in this commit. The pre-existing overlay states (`dozing`, `sleeping`) were defined in Phase 4a. Verify in a follow-up that:
- ARIA live region for state transitions (`"Paused — listening for speech"` on doze) is announced.
- The manual pause button's state is reflected in `aria-pressed` on the Pause/Resume control (outside this commit's scope).
- `prefers-reduced-motion` is respected for any dozing→active animation on the hero readout (also outside this commit).

No accessibility regression introduced.

---

## 7. Code Quality

**Strengths:**
- `AudioRingBuffer` is small, self-contained, idiomatic. Int16 storage + Float32 writer avoids a double copy on the hot path.
- `SleepManager` has clear public/private separation, named callback interfaces, guard clauses that prevent illegal transitions (`enterDozing` guards on `active`, `enterSleeping` guards on `dozing`).
- Comments are excellent: each block explains *why* (the AGC self-feed comment at line 103 is a save-the-next-maintainer moment).
- Commit message WHY paragraph documents the Silero deferral explicitly with a TODO.
- Constants lifted 1:1 from iOS with source references in comments.
- `DeepgramService.sendInt16PCM` safely defensive-copies caller-supplied subarrays (line 138–140).

**Weaknesses:**
- Both new files lack unit tests (see Section 8).
- `SleepManager.currentState` getter is unused — dead code.
- `SleepManager.onStateChange` is declared, emitted, but not subscribed by any caller — either remove or subscribe (see P1).
- Magic numbers in `recording-context.tsx:361` (`16ms` throttle) — already commented as "~60Hz UI cap" but would be clearer as a named constant.
- `recording-context.tsx` has grown to 680 lines with many `useCallback`s and deep deps arrays. The file is at the upper limit of readability; consider extracting the `pause`/`resume`/`handleWake`/`buildSleepManager` cluster into `use-sleep-lifecycle.ts` hook.
- TypeScript: `Exclude<SleepState, 'active'>` is used consistently — nice. But the `setState` dual meaning in `sleep-manager.ts` (internal method `setState(next)`) and React's setState could confuse; rename internal `setState` → `transitionTo`.
- `sleep-manager.ts:137` `if (this.state === next) return;` guard is good, but means `onStateChange` never fires with the starting `'active'` on `start()` — wait, it does not, because `start()` calls `setState('active')` which equals current — NO callback. Intentional? Probably fine but surprising.
- `handleWake` has two code paths that duplicate the "open mic + DG + Sonnet + replay" sequence with `resume()`. Extract a shared `replayAndGoActive()` helper.

---

## 8. Test Coverage

**None.** The `web/` workspace has Playwright E2E but no unit test runner (no `vitest`, `jest`, or test scripts in `package.json`). Phase 4e introduces ~250 lines of stateful, race-condition-prone code (timers, callbacks, wrapping indices) with zero automated coverage.

**What should be tested at unit level:**

1. `AudioRingBuffer`
   - Not-yet-full drain returns `[0..writeIndex)` in order.
   - Full drain (writeIndex === 0 after wrap) returns the full buffer in oldest-first order.
   - Full drain (writeIndex > 0) returns a correctly stitched buffer — **this is the one that silently corrupts replay if the two `.set` offsets are miswritten**.
   - Float32 clamp: `writeFloat32([2.0, -2.0])` yields `[32767, -32767]` not overflow.
   - Reset after drain: `size === 0`, subsequent writes start at index 0.

2. `SleepManager`
   - `start()` → after 15s timer fires with no `onSpeechActivity`, `onEnterDozing` fires.
   - Doze → after 1800s, `onEnterSleeping` fires.
   - `onSpeechActivity` while `active` resets the 15s timer.
   - `onSpeechActivity` while `dozing` is a no-op (documented behaviour).
   - `processAudioLevel` during cooldown does NOT wake.
   - `processAudioLevel` with 12 consecutive frames above threshold wakes from doze; 11 frames do not.
   - Sub-threshold sample resets `consecutiveSpeechFrames` to 0.
   - `stop()` clears both timers and resets state.

3. `DeepgramService.pause/resume/sendInt16PCM`
   - `pause()` → `sendSamples()` no-ops.
   - `resume(replay)` → `sendSamples()` flows again, `replay` bytes hit the WS.
   - `sendInt16PCM` defensive-copies subarray views.

Recommend adding `vitest` to the workspace and at minimum the ring buffer + sleep manager test suites. Both modules are pure TS with no DOM deps — trivial to test, high ROI.

**Manual/E2E:**
- No Playwright scenario added for the 15s→doze→replay flow.
- No instrumentation log lines (`console.info('[SleepManager] →dozing')`) in web, unlike the iOS equivalent which added extensive JSONL logging in commit 2026-02-26 specifically so production regressions could be debugged.

---

## 9. Suggested Fixes (numbered, file:line)

1. **[P0] Resample before ring-buffer write** — `recording-context.tsx:347,353`. Either (a) resample `samples` to 16kHz before `ringBufferRef.writeFloat32`, or (b) initialise the ring buffer with `handle.sampleRate` AND run the drained samples through `resampleTo16k` before `sendInt16PCM`. Option (a) is simpler and keeps Deepgram's contract identical on both paths.
2. **[P0] Add unit tests for `AudioRingBuffer.drain()` wrap stitching** — `audio-ring-buffer.ts:42–53`. Adopt `vitest`; at minimum cover the three drain states (empty, partial, wrapped-full).
3. **[P1] Wire `onStateChange: setState` in `buildSleepManager`** — `recording-context.tsx:447`. Delete the per-callback `setState('dozing'|'sleeping')` and let the manager emit through the single hook. Add a mapping helper to translate `SleepState` → `RecordingState` (since `'active'` is identical but a manual `pause()` produces `'dozing'`).
4. **[P1] Make manual `pause()` / `resume()` drive the SleepManager** — `recording-context.tsx:541,555`. Add `SleepManager.forceDoze()` / `forceActive()` (or reuse `enterDozing` as a public method) so the internal state stays coherent and the 2s cooldown applies uniformly. Without this, manual-pause audio cannot wake automatically.
5. **[P1] Reverse order: build SleepManager before opening mic pipeline** — `recording-context.tsx:490–492`. So `processAudioLevel` callbacks from the first mic samples have a manager to target. Cosmetic but clarifies initialisation order.
6. **[P1] Add instrumentation logging** — `sleep-manager.ts:144,158,170,182` + `recording-context.tsx:390`. Match iOS `DebugLogger` behaviour. Minimum: `console.info('[sleep] →dozing', { noTranscriptMs })`, `'→sleeping'`, `'→active (wake from X)'`, and the drain byte count from the ring buffer. The 2026-02-26 journal entry is explicit that the *absence* of logging was the reason prod bugs took days to diagnose on iOS.
7. **[P2] Remove unused `currentState` getter** — `sleep-manager.ts:82–84`. Or promote it to be the source of truth that `RecordingProvider` reads (pairs with fix #3).
8. **[P2] Named constants** — `recording-context.tsx:361` `16` → `UI_LEVEL_THROTTLE_MS`. `recording-context.tsx:184` `DEEPGRAM_USD_PER_MIN / 60 / 10` → `DEEPGRAM_USD_PER_TICK` with a comment. Helps search when tuning.
9. **[P2] Rename `SleepManager.setState` → `transitionTo`** — `sleep-manager.ts:136`. Avoids collision with React terminology.
10. **[P2] Extract replay-and-activate** — `recording-context.tsx:393–418` and `559–575`. Shared helper `replayAndActivate(from: 'dozing'|'sleeping')` used by both `handleWake` and `resume`.
11. **[P2] Wire `onUtteranceEnd` for future Silero port** — `deepgram-service.ts:311` → `sleep-manager.ts`. Add an `onUtteranceEnd()` entry point that arms a short (5s) doze timer per the 2026-03-06 journal entry, so the Silero follow-up doesn't also need to rewire doze entry. Track in TODO if not shipping now.
12. **[P2] Document RMS threshold tuning** — `sleep-manager.ts:62` `wakeRmsThreshold: 0.02`. Add a code comment explaining this corresponds roughly to iOS's Silero threshold and that the known limitation is false-wake-from-breathing (iOS journal 2026-03-05). Makes the deferred Silero work discoverable.
13. **[P2] Guard `pause()`/`resume()` against state misuse** — `deepgram-service.ts:151,158`. Currently `pause()` will succeed even in `'connecting'` / `'error'`. Add `if (this.state !== 'connected') return;`.
14. **[P2] Consider `onStateChange` for `'active'` on start** — `sleep-manager.ts:89,136`. Initial `setState('active')` from `'active'` (default) is a no-op, so subscribers never learn the machine is live. Either emit unconditionally on `start()`, or document that subscribers should assume `'active'` post-`start()`.

---

## 10. Verdict + Top 3 Priorities

**Verdict:** APPROVE WITH FIXES. The tier semantics, WS pause/resume approach, and ring-buffer design are all sound and faithful to the iOS reference. The commit message quality is exemplary. However, the sample-rate assumption in the ring buffer is a silent-correctness bug that materially breaks the feature's main value prop (replay-on-wake) on iOS Safari — the exact browser the PWA primarily targets. The drain() math is correct but untested in a hot area where a one-character error would silently corrupt audio, which alone justifies adding a minimal test runner.

**Top 3 priorities before merge (or hot-fix PR):**

1. **Fix the ring-buffer sample-rate bug** (P0, fix #1). Resample before write, or store + resample on drain. Without this, every wake on a 44.1k/48k mic replays at wrong pitch and Deepgram transcription of the pre-wake segment is garbage — negating the entire purpose of Phase 4e.
2. **Add `vitest` + unit tests for `AudioRingBuffer.drain()` and `SleepManager` transitions** (P0/P1, fixes #2). Roughly 80 lines of test code for a state machine that will only grow when Silero lands. Blocks regressions in a module that is silent-failure prone.
3. **Unify React state via `SleepManager.onStateChange`** (P1, fix #3) and make manual `pause()`/`resume()` drive the SM (fix #4). Prevents the "manual pause cannot wake by speech" UX wart and eliminates the drift-between-two-state-machines maintenance burden before more code accrues.
