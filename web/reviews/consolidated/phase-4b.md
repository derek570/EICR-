# Phase 4b — Consolidated Review

**Commit:** `72fb7da` — feat(web): Phase 4b real mic capture via AudioWorklet + RMS VU meter
**Reviewers consolidated:** Claude Opus 4.6, Codex
**Method:** Analysis-only. No source modifications. Findings verified via `git show 72fb7da` on the three files in scope.

---

## 1. Phase Summary

Phase 4b replaces the Phase 4a synthetic VU-meter loop with a real `getUserMedia` → `AudioContext` → `AudioWorkletNode` pipeline.

- **New files:** `web/public/audio-worklet-processor.js` (26-line PCM capture processor that posts 128-sample Float32Array blocks via transferable ArrayBuffer) and `web/src/lib/recording/mic-capture.ts` (155 lines; `startMicCapture({ onSamples, onLevel, onError })` helper with `ScriptProcessorNode` fallback).
- **Refactor:** `RecordingProvider.start()` / `resume()` now drive a real mic pipeline with per-block RMS smoothed by a 0.3 EMA, a ~60 Hz level-push throttle on the React side, and a permission-denied message surface. `pause()` tears the mic down entirely (deliberate — Phase 4e will swap this for a VAD keep-alive).
- **Scope:** Mic audio stays in the browser at this phase; Deepgram/Sonnet egress is deferred to 4c/4d. Transcripts stay empty; VU meter is the only live surface.

Both reviewers agree the change is clean, well-commented, and broadly aligned with the stated plan. Both recommend "ship with fixes"; the disagreement is only over *which* follow-ups are P1.

---

## 2. Agreed Findings

| # | Severity | Area | File:Line | Finding |
|---|----------|------|-----------|---------|
| A1 | P1 | Correctness / Browser portability | `web/src/lib/recording/mic-capture.ts:79-82` (worklet branch) and `:85-88` (fallback branch) | The audio graph is incomplete on the preferred path. `source -> workletNode` is connected but the worklet is **never connected to a sink** (muted `GainNode` or `destination`). Web Audio rendering is pull-based; without a downstream sink the graph is not guaranteed to run, so `port.onmessage` may never fire on browsers that prune disconnected processors. The fallback path *does* connect to `audioContext.destination`, which (as Claude notes) also routes the post-EC mic signal to the user's speakers — a feedback loop on the deprecated path. Fix: route both paths through a muted `GainNode` (`gain.value = 0`) and onward to `destination`. Codex flagged the worklet-disconnect bug; Claude flagged the fallback-feedback bug; the same fix addresses both. |
| A2 | P1 | Code quality / Drift | `web/src/lib/recording-context.tsx` `start()` vs `resume()` | Mic startup and error handling are duplicated across `start()` and `resume()`. Permission-denied normalisation lives only in `start()`; `resume()` surfaces raw browser error strings. Extract a shared `beginMicPipeline()` helper and route both call sites through it. (Codex explicit; Claude called this out in §7 Weaknesses.) |
| A3 | P2 | Code quality / Maintainability | `web/src/lib/recording/mic-capture.ts` (EMA, RMS anchor 0.3, curve exponent 0.7, ScriptProcessor buffer 4096, throttle constant) | Magic numbers are scattered through the RMS/mapping/fallback path. Promote to named module-scope constants with comments that tie them to the iOS app's equivalent curve so future tuning is traceable. |
| A4 | P2 | Test coverage | (all three files) | Zero test coverage for Phase 4b. Both reviewers agree at minimum the pure-logic parts (`computeLevel` extraction, permission-denied classification, state transitions with mocked `startMicCapture`) should get table/unit tests, and a Playwright smoke that denies mic permission should assert the friendly error copy. |
| A5 | P2 | Code quality / Documentation | `web/src/lib/recording/mic-capture.ts:35-37` (`onSamples` JSDoc) | The doc comment says "the underlying buffer is reused by the caller," but in practice the worklet path transfers the ArrayBuffer (so the *processor*-side view is detached, not reused) and the ScriptProcessor path copies into a fresh `Float32Array`. Neither path matches the comment. Verified by reading `mic-capture.ts:115-121` — the fallback uses `new Float32Array(event.inputBuffer.getChannelData(0))`. Document the real ownership contract (Claude P2-3; Codex §7). |
| A6 | P2 | Correctness / UX | `web/src/lib/recording-context.tsx` permission-denied copy | Error-match path is brittle (Claude P2-6: `/NotAllowed|denied|dismiss/i` overmatches; Codex §3-P2: `resume()` doesn't normalise at all). Consolidated fix: use `DOMException.name === 'NotAllowedError'` inside a shared helper reused by both `start()` and `resume()`. |

---

## 3. Disagreements + Adjudication

| # | Topic | Claude | Codex | Adjudication |
|---|-------|--------|-------|--------------|
| D1 | `track.ended` listener firing on clean stop (Claude P1-4) | P1 — phantom "Microphone track ended" error after every user-initiated Stop because the listener is never removed and `stream.getTracks().forEach(t => t.stop())` fires `ended` synthetically. | Not raised. | **Uphold as P1.** Verified in `mic-capture.ts:122-127` (`track.addEventListener('ended', ...)` has no counterpart removal) and `:137-152` (`stop()` calls `t.stop()` but never `removeEventListener`). This is a real, user-visible regression on the happy path. One-line fix (guard `onError` with the `stopped` flag on line 135, or hoist and remove the listener). |
| D2 | Cancellation safety of `start()` / `resume()` (Codex P1 §3) | Partially raised (P2-1 AbortSignal), framed as "wasteful" — not a correctness bug. | P1 — if the user hits Stop while `getUserMedia` is still resolving, `stop()` sets state to `idle`, but the in-flight `start()` then sets `micRef`, flips state to `active`, and re-starts ticking, resurrecting a session the user cancelled. | **Uphold as P1.** Codex's framing is correct — this is a state-machine race, not just wasted mic permissions. The `start()` async body has multiple `await` points between the user's click and the final `setState('active')`, and there is no session-token / generation guard. Fix: capture a local generation id before the first await and bail on every await resumption if the generation has advanced. Also apply to `resume()` and to `onError` callbacks (see D3). |
| D3 | Stale `onError` callbacks overwriting a newer session's state (Codex P2) | Not raised. | P2 — provider's `onError` handlers mutate global state without checking the failing handle is the current one; combined with D2 this can flip a new session into `error` based on a stale mic. | **Uphold as P2.** Correct in principle and a natural follow-on from D2's session-token approach. Cheap once D2's generation check exists. |
| D4 | Reset `micLevel` to 0 on error transitions (Codex §3-P2) | Not raised. | P2 — after an error the ring retains a stale scale, misleading users. | **Uphold as P2.** Small UX polish; cheap and obvious given the existing level state. |
| D5 | iOS Safari `AudioContext({ sampleRate: 16000 })` rejection risk (Claude P1-1) | P1 — older iOS Safari / some builds reject non-native rates with `NotSupportedError`; needs try/fallback to default context rate. | Not raised. | **Downgrade to P2.** Real concern, but speculative at this commit — no reported field breakage cited. Worth logging the effective `audioContext.sampleRate` (Claude P1-2) and adding a graceful fallback, but the absence of concrete reproduction means it does not block Phase 4c. |
| D6 | iOS Safari suspended AudioContext after `await getUserMedia` (Claude P1-3) | P1 — permission prompt delay can break user-gesture affinity; context stays suspended silently; VU meter reads zero. | Not raised. | **Uphold as P1.** Consistent with `rules/mistakes.md` around iOS audio quirks. At minimum, log `audioContext.state` after `await audioContext.resume()` and surface a clear error when still `suspended`. Constructing the context synchronously in the click handler is the robust fix. |
| D7 | `audioWorklet.addModule` catch is too broad (Claude P1-6) | P1 — a 404/CSP on the worklet JS silently degrades to the ScriptProcessor path (and thus to feedback-loop risk, see A1). | Not raised. | **Downgrade to P2.** Narrowing the catch (feature-detect `'audioWorklet' in audioContext`, or match by error name) is worthwhile, but only becomes P1 if A1 is not fixed. Once A1 is fixed (muted GainNode on both paths), the silent-degradation risk is cosmetic — log the reason and move on. |
| D8 | ScriptProcessor 4096-buffer latency (Codex §5) | Not raised. | Informational — 4096 frames at 16 kHz ≈ 256 ms, visibly laggier than the worklet. | **Keep as P2/info.** Acceptable as a fallback; pair with A3 (promote buffer size to a named constant) and document the latency trade-off. |
| D9 | Commit message vs. actual overlay placeholder text (Codex §2) | Not raised. | Minor — commit says overlay shows "Listening…" while the body renders "Start speaking — transcripts will appear here in real time." | **Keep as P3 / note only.** Doc/commit-message drift, not a code defect. Worth correcting the commit-body language in future phases but no runtime impact. |

---

## 4. Claude-Unique Findings

- **C1 (P2-1, downgraded):** No `AbortSignal` support on `startMicCapture`. Subsumed by D2 once a session-token guard is added; the `AbortSignal` is a cleaner ergonomic for Phase 4c/4e consumers but not required.
- **C2 (P2-3):** Phase 4c/4e ownership contract on the transferred ArrayBuffer. Any future consumer that *re-transfers* the buffer (e.g. posting to a WebSocket worker) will detach it before later consumers read it. Latent at 4b; worth documenting before 4c lands. Ties into A5.
- **C3 (P2-5):** SSR/`'use client'` boundary note. `typeof window === 'undefined'` guard is good; call-graph changes in Next 16 server components could re-import this module. No concrete bug today.
- **C4 (Perf note):** Per-block Float32Array allocation creates ~64 KB/s of short-lived garbage. Acceptable on desktop; measurable on low-end Android. Flagged as informational only.
- **C5 (Perf / observability):** `audioContext.close().catch(() => {})` swallows errors silently. Suggest `.catch(console.warn)` in dev builds.
- **C6 (Code quality):** `webkitAudioContext` inline cast is awkward; a lib type augmentation would read cleaner.

## 5. Codex-Unique Findings

- **X1 (P1 — upheld as D2):** Cancellation race in `start()` / `resume()` vs. `stop()`.
- **X2 (P2 — upheld as D3):** Stale `onError` callbacks from previous mic handles overwriting newer session state.
- **X3 (P2 — upheld as D4):** `micLevel` not reset to `0` on error transitions.
- **X4 (§2):** Commit-message / UI-copy drift around "Listening…" placeholder (downgraded to note; see D9).
- **X5 (§6):** Overlay focus-management gap (`role="dialog"` present, but no initial focus target). Codex explicitly notes this predates Phase 4b — out of scope for this review but worth tracking separately.

## 6. Dropped / Downgraded

- **Claude P1-1 → P2** (D5) — iOS Safari non-native sample-rate rejection: speculative without reported breakage; address alongside logging.
- **Claude P1-6 → P2** (D7) — broad `addModule` catch: becomes cosmetic once A1 (muted GainNode) lands.
- **Claude P2-1** (C1) — AbortSignal: folded into D2.
- **Codex §6 (overlay focus management)** — out of scope (predates Phase 4b).

## 7. Net Verdict + Top 3 Priorities

**Verdict: Ship with fixes (approve-with-follow-ups).**

No P0. No security regressions. Mic audio stays in the browser at this commit. Both reviewers converge on "structure is sound, correctness edges need tightening." The P1s are realistic edge-case handling — not design mistakes — but two of them (audio-graph completeness, cancellation race) sit on the hot path and can silently break the phase's stated goal ("a real VU meter driven by speech").

**Top 3 priorities before Phase 4c ships to production:**

1. **Fix the audio-graph topology on both paths (A1).** Route both `workletNode` and `scriptNode` through a muted `GainNode` (`gain.value = 0`) to `audioContext.destination`. This single change fixes Codex's "worklet never renders" risk and Claude's "ScriptProcessor feedback loop" in one go — the highest-leverage fix in this review.
2. **Make `start()` / `resume()` cancellation-safe (D2 + D3).** Add a session-token / generation guard at every `await` boundary and bind `onError` to the specific handle. Prevents Stop-while-prompt-open from resurrecting a session the user cancelled, and prevents stale mics flipping a newer session into `error`.
3. **Eliminate the `track.ended` phantom error on clean Stop (D1) and consolidate error normalisation (A2 + A6).** Hoist the `ended` listener, remove it (or guard with the `stopped` flag) inside `stop()`, and extract a shared `beginMicPipeline()` / `normaliseMicError()` helper so `resume()` inherits the friendly permission-denied copy. Small diff, high UX payoff — the current code flashes a red error on every legitimate Stop press.

iOS Safari hardening (D5, D6) and logging of the effective `audioContext.sampleRate` should follow as Phase 4c prerequisites but are not blockers for closing Phase 4b.
