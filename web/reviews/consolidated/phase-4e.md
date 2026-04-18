# Phase 4e — Consolidated Review (Claude + Codex)

**Commit:** `9f1dba6` — feat(web): Phase 4e VAD sleep/wake with 3s ring buffer replay
**Inputs:** `web/reviews/claude/phase-4e.md`, `web/reviews/codex/phase-4e.md`, `web/reviews/context/phase-4e.md`
**Scope:** `audio-ring-buffer.ts` (new), `sleep-manager.ts` (new), `deepgram-service.ts` (pause/resume/sendInt16PCM), `recording-context.tsx` (SleepManager wiring + ring buffer write).

---

## 1. Phase summary

Phase 4e ports the iOS 3-tier power model (Active → Dozing → Sleeping) to the web client. Two new modules land — `AudioRingBuffer` (Int16 circular PCM buffer, 3 s default) and `SleepManager` (timer-only state machine) — plus `DeepgramService.pause() / resume(replay?) / sendInt16PCM()` for KeepAlive-based WS pause with pre-wake replay. `RecordingProvider` wires the final-transcript stream, per-sample audio level, and per-sample Float32 writes into the ring buffer so both wake-from-doze and wake-from-sleep paths can replay the last ~3 s of audio.

Both reviewers agree the tier semantics, WS pause/resume strategy, and module decomposition are sound and faithful to iOS. The commit message is exemplary (WHAT/WHY/WHY-THIS-APPROACH with cost reasoning and a deliberate Silero deferral). Three real issues converge across both reviews: (a) the ring buffer is fed at the mic's native rate but sent to Deepgram as 16 kHz, (b) manual `pause()`/`resume()` bypass the SleepManager, causing two state machines to drift, and (c) no unit coverage for a timer- and index-heavy module. Codex additionally flags a WS-readiness race on the sleep→active reconnect path that Claude missed; Claude additionally flags `onStateChange` being emitted-but-never-subscribed (cleanup) and an init-order nit.

---

## 2. Agreed findings

| Severity (consolidated) | Area | File:line | Issue |
|---|---|---|---|
| **P0** | Correctness / audio fidelity | `recording-context.tsx:347,353` + `audio-ring-buffer.ts:21` + `deepgram-service.ts:132` | Ring buffer is constructed `new AudioRingBuffer(3, 16000)` and fed raw `samples` from `mic-capture` at `handle.sampleRate`, but `sendInt16PCM()` does **not** resample, while live `sendSamples()` **does** (`deepgram-service.ts:112`). On any device where the AudioContext does not honour `sampleRate: 16000` (iOS Safari commonly returns 44.1/48 kHz), replay is interpreted by Deepgram at the wrong rate → pitch-shifted, wrong duration, garbage transcription of exactly the pre-wake sentence the buffer exists to preserve. **Verified in source** — both reviewers correct. |
| **P1** | Correctness / state sync | `recording-context.tsx:541,555` vs `sleep-manager.ts:105,112` | Manual `pause()` flips React state to `'dozing'` and pauses DG/Sonnet but never transitions `SleepManager` out of `'active'`; `resume()` flips React back to `'active'` without re-arming the SM. Result: the 15s no-transcript timer keeps running through manual pause (can auto-sleep while the UI says "Recording"); wake-by-speech during manual pause cannot fire (SM is `'active'`, `processAudioLevel` gated); the 2 s post-doze cooldown never applies to manual resume. |
| **P1** | Test coverage | `web/` (no vitest/jest) + `audio-ring-buffer.ts:42–53` + `sleep-manager.ts:*` | No unit test runner exists in the workspace. ~250 lines of stateful/timer/wraparound code land with zero automated coverage. Drain wrap-stitch math is correct by inspection but a one-character off-by-one would silently corrupt every wake replay. Both reviewers converge on "add vitest + ring buffer + SleepManager + pause/resume tests" as a blocker-adjacent follow-up. |
| **P2** | Code quality / comment drift | `recording-context.tsx:29–36` | Provider header still describes pre-4e `60s / 5m` semantics and says "VAD sleep/wake (Phase 4e) still to come" — materially wrong after this commit. |
| **P2** | Code quality | `recording-context.tsx:443,541` | `pause()` / `resume()` duplicate parts of the wake/doze transition logic rather than sharing one transition API — this duplication is *how* the P1 divergence bug slipped in. Extracting a shared transition helper would fix both at once. |

---

## 3. Disagreements + adjudication

### 3a. Is the RMS-vs-level threshold mismatch a real bug?

- **Claude:** Treats it as P2 documentation / future-Silero concern; notes `wakeRmsThreshold: 0.02` needs a comment.
- **Codex:** Elevates to P2 correctness — `SleepManager` consumes the **smoothed, curve-mapped UI level** from `mic-capture.ts:104`, not raw RMS. The handoff claimed iOS constants (`energy floor 0.002`) were lifted 1:1, but (i) the code uses `0.02`, and (ii) the input signal is post-EMA, post-nonlinear mapping, so the numeric threshold is not comparable to iOS.

**Adjudication: Codex is more correct.** This is not just documentation — the commit message explicitly claims "Constants lifted 1:1 from iOS … so behaviour matches observationally." The input signal transformation invalidates that claim regardless of what constant is chosen. Keep at **P2** but frame it as a correctness/parity bug (the wake heuristic cannot be reasoned about from iOS constants), not just a comment fix. Either feed raw RMS to `processAudioLevel` (separate from the UI level) or rewrite the threshold/docs to reflect the mapped signal.

### 3b. Does replay drop on wake-from-sleep because of a WS-readiness race?

- **Codex:** Flags as **P1**. `handleWake` for `from === 'sleeping'` calls `await openDeepgram(mic.sampleRate)` then immediately `deepgramRef.current?.sendInt16PCM(replay)`. `openDeepgram` only awaits token fetch; `DeepgramService.connect()` returns synchronously while `ws.onopen` is still pending. `sendInt16PCM` guards on `state !== 'connected'` and silently drops — the entire replay buffer is lost on the sleep→active path.
- **Claude:** Does not flag this. Implicitly treats `await openDeepgram` as sufficient.

**Adjudication: Codex is correct and this is a real P1.** Verified in source: `deepgram-service.ts:132` early-returns when `state !== 'connected'`, and there's no `await` for `onopen` in `openDeepgram`. Promote to **P1** in the agreed list below. Fix: either `openDeepgram` resolves on `ws.onopen`, or `DeepgramService` queues pending replay/live blocks until `connected` fires. This is the *specifically advertised* feature (pre-wake replay across sleep) failing on its primary path.

### 3c. Are `pause()`/`resume()` correctness vs structural issues?

- **Claude:** P1 for "manual pause can't be woken by speech" and P2 for "does not update SM internal state".
- **Codex:** Single P1, framed as state divergence.

**Adjudication: Same bug, Codex's framing is cleaner.** Consolidate into one P1 row (already in §2). Claude's additional observation (2 s cooldown never applies to manual resume) is a valid sub-point to note in the fix.

### 3d. Severity of ring-buffer wrap-stitch math absent tests

- **Claude:** Calls the math "correct but fragile" and lists it as a P0 under the "needs tests" banner.
- **Codex:** Treats missing tests as P1 across the phase, doesn't call the stitch math out specifically.

**Adjudication: Math is correct; the risk is test-coverage, not code.** Downgrade Claude's per-issue P0 to be a specific test case inside the consolidated P1 "add vitest coverage" item. The P0 slot stays exclusively for the sample-rate bug.

---

## 4. Claude-unique findings (kept)

| Severity | Area | File:line | Note |
|---|---|---|---|
| P1 | API hygiene | `sleep-manager.ts:35,139` vs `recording-context.tsx:448–470` | `SleepManager.onStateChange` is declared, emitted, and never subscribed. Either delete the hook or wire it as the single source of truth that drives `setState`, which would also collapse the 5 separate call sites that set React state after each SM transition. |
| P2 | Init order | `recording-context.tsx:490–492` | `buildSleepManager()` runs **after** `await beginMicPipeline()`. Any mic samples arriving before the manager exists are lost to `processAudioLevel`. Reverse the order or document it. |
| P2 | Dead code | `sleep-manager.ts:82–84` | `currentState` getter is unused. Remove, or promote to the authoritative read used by the provider. |
| P2 | Naming | `sleep-manager.ts:136` | Private `setState` collides with React vocabulary — rename `transitionTo`. |
| P2 | Duplication | `recording-context.tsx:393–418,559–575` | Extract shared `replayAndActivate(from)` helper used by both `handleWake` and `resume` — reduces risk while fixing the P1 state-sync bug. |
| P2 | Future-proofing | `deepgram-service.ts:311` → `sleep-manager.ts` | `onUtteranceEnd` is exposed on DG but never fed to the SM. iOS journal (2026-03-06) switched doze entry to UtteranceEnd after Silero got stuck — wire the hook now so the Silero follow-up doesn't also have to rewire doze entry. |
| P2 | Defensive guards | `deepgram-service.ts:151,158` | `pause()` / `resume()` succeed even when `state` is `'connecting'` / `'error'`. Add `if (this.state !== 'connected') return;` to both. |
| P2 | UX confirmation | `recording-context.tsx:455–457` | `clearTick()` during doze visibly freezes the cost readout for the 15s→1800s window. Matches iOS and the commit's intent, but worth explicit UX sign-off that the freeze isn't read as a bug. |
| P2 | Observability | `sleep-manager.ts:144,158,170,182` + `recording-context.tsx:390` | No `console.info('[sleep] →dozing …')` instrumentation. iOS added JSONL logging in 2026-02-26 precisely because production regressions took days to diagnose otherwise. At least the transition events + drain byte count should be logged. |
| P2 | Named constants | `recording-context.tsx:361,184` | Magic `16` (ms throttle) and the `DEEPGRAM_USD_PER_MIN / 60 / 10` tick maths need named constants for search-ability during tuning. |

---

## 5. Codex-unique findings (kept)

| Severity | Area | File:line | Note |
|---|---|---|---|
| **P1** | Correctness / race | `recording-context.tsx:404` + `deepgram-service.ts:63,132` | Wake-from-sleep replay drops because `openDeepgram` does not await `ws.onopen` — see §3b adjudication. Promoted to agreed P1. |
| P2 | Residual a11y | `recording-overlay.tsx:64` | Recording overlay is marked as a modal dialog but still has no focus-trap / initial-focus / return-focus handling. Predates 4e but flagged as a residual gap in the touched area. |
| P2 | Performance | `deepgram-service.ts:136` | `sendInt16PCM()` copies the full Int16 buffer before `ws.send()`. Acceptable at 3 s × 16 kHz × 2 B = 96 KB; becomes costly if replay window grows or if (per the P0) a 48 kHz buffer is mis-sent. |

---

## 6. Dropped / downgraded

| Originally raised | By | Disposition | Reason |
|---|---|---|---|
| Ring-buffer `drain()` wrap-stitch math as standalone P0 | Claude | **Downgraded** → folded into the "add vitest" P1 | Math is correct by inspection; risk is test-coverage, not code. |
| `wakeRmsThreshold` being a comment/docs issue | Claude | **Reframed** as Codex's P2 parity bug | Input signal is mapped/smoothed — raw-RMS parity with iOS is broken regardless of threshold. |
| `handleWake` reopening with missing mic (`from='sleeping'` and `!mic`) throws away ring buffer | Claude | **Kept as P2** (implicit) | True but by definition the mic wasn't running, so there is no pre-wake audio to preserve — no material regression. |
| `lastLevelPushRef` 16 ms throttle ordering | Claude | **Kept P2, informational only** | Code is already correct; Claude only asked for a comment. |
| No security findings | Both | **Confirmed** | No new XSS/auth/secret surfaces. Agreed. |

---

## 7. Net verdict + top 3 priorities

**Verdict: NEEDS REWORK before merge.** Approve the architecture and tier semantics; reject the shipping state because two correctness bugs (P0 + the promoted Codex P1) directly negate the commit's headline feature — "replay the 3 s before wake so Deepgram doesn't miss the sentence." On a 44.1/48 kHz iOS Safari mic the replay is pitch-corrupt; on the sleep→active path the replay is dropped entirely. Either failure alone makes the feature non-functional on the primary PWA target. The remaining P1s (manual pause/resume state drift; no unit tests) are structural blockers that will compound as Silero lands.

### Top 3 priorities

1. **Fix ring-buffer sample-rate handling (P0).** Either resample `samples` to 16 kHz *before* `writeFloat32` (preferred — keeps `sendInt16PCM` contract), or construct `AudioRingBuffer` with `handle.sampleRate` **and** resample the drained chunk before `sendInt16PCM`. Without this, every wake on a non-16 kHz mic — i.e. most iOS Safari sessions — replays at the wrong rate.
2. **Make wake-from-sleep wait for a connected Deepgram socket (P1, Codex).** Change `openDeepgram` to resolve on `ws.onopen`, or queue replay/live PCM inside `DeepgramService` until `state === 'connected'`. Without this, the sleep→active replay is silently dropped even when sample rate is correct.
3. **Unify manual pause/resume with the SleepManager (P1) and add vitest coverage (P1).** Route manual controls through a single `SleepManager.forceDoze()` / `forceActive()` API (or the same `onEnterDozing`/`onWake` callbacks), subscribe `onStateChange` as the sole React-state writer, then add unit tests for `AudioRingBuffer` drain variants, `SleepManager` timer transitions + cooldown + wake-frame-count, and `DeepgramService.pause/resume/sendInt16PCM`. Removes the two-state-machine drift risk and locks the module against silent regressions before Silero lands.
