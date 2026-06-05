# Claude Plan-agent review — PLAN v3 (round 3)

**Date:** 2026-05-25
**Verdict:** 0 BLOCKERs, 2 IMPORTANTs, 3 NITs — **CONVERGED. SHIP after IMPORTANTs.**

## v2 IMPORTANT closure verification

- **I1 streaming_http_audio gate:** CLOSED — v3 §E lines 128-132 + §I line 349.
- **I2 suppression-key shape:** CLOSED — v3 §E moves suppression to iOS, backend has no map.
- **I3 iOS expanded_text:** CLOSED — v3 §E lines 140-145 spec full chain including contract test.
- **I4 cost-on-LB-on:** CLOSED — Pivot 7 + §E cost section. Honest $0 vs LB-on baseline.

## Codex v2 BLOCKER closure verification

- **NB1 protocol wording:** CLOSED — push REAL non-empty toolResults; stop_reason stays as Anthropic-reported; terminal_reason carries early-terminate signal.
- **NB2 backend-vs-iOS suppression:** CLOSED via Pivot 4 — iOS marks slot on play() success.
- **NB3 4xx-fallback speaks rejected:** CLOSED via Pivot 5 — local fallback REMOVED from fast-tts handling.
- **B10 telemetry sufficiency:** CLOSED via Pivot 6 — 12 new fields + /playback-ack endpoint.

## NEW IMPORTANTs

### NI1: `pendingFastTtsSlots` cleanup contract under-specified for crash/reconnect
Map cleared on `endTurn` but no precise definition of endTurn. WS drop mid-Sonnet-stream + speculator-already-skipped → slot lingers → next turn for same slot also skips → silent loss. Specify: (a) `endTurn` = `runLiveMode` post-`emitTurnSummary`; (b) WS close clears all pending turnIds; (c) inner Set capped at 32 slots with `pending_fast_tts_overflow` log.

### NI2: Pivot 7 abort path needs explicit speculator API surface
v3 says `controller.abort()`. The `pendingControllers` Set in speculator is private; no exported `abortBySlot` exists. Add `speculator.abortBySlot({ sessionId, turnId, boardId, field, circuit })` via parallel `Map<correlationId, {slot, controller}>`. Call from session layer at same point `pendingFastTtsSlots.add()` fires. Unit test `loaded-barrel-speculator-abort-by-slot.test.js`.

## NITs

- NN1: `boards.length === 0` legacy single-board edge — add comment in predicate code.
- NN2: `/playback-ack` endpoint needs auth/rate-limit/body validation specs.
- NN3: Race A under wider Phase 2 race window — iOS should queue bundler confirmation while fast-tts POST in flight; drop on 200+play success or drain on terminal.

## Recommended verdict

**CONVERGED at 0 BLOCKERs.** SHIP after pinning NI1 and NI2 (~1 day of additional spec work). All v2 BLOCKERs from Codex closed; all v2 IMPORTANTs from me closed. The new race surface introduced by Pivots 4 + 7 is architecturally better than v2's backend-suppression — iOS-side dedup is the correct location for playback-state knowledge.

Convergence achieved from my side at zero BLOCKERs. Codex should be asked to verify NB1/NB2/NB3/B10 closure on their end before final SHIP.
