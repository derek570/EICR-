# Claude Plan-agent review — PLAN v5 (round 5)

**Date:** 2026-05-25
**Verdict:** 0 BLOCKERs, 0 IMPORTANTs, 2 NITs — **SHIP. v5 converges. All round-4 items closed with surgical, codebase-aligned edits. The remaining nits are documentation polish, not correctness gaps.**

## Round-4 closure verification

### B-v4.1 — Cost-tracker signature contradiction
**CLOSED** by Pivot 11.1. v5 picks option (c) from my round-4 analysis:
- Signature extended to `recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts = {})`.
- `terminal` STAYS the existing 3-value enum (`completed | cancelled | failed`) — no validator change, no silent no-op risk.
- `opts.reason` carries the free-text WHY and emits a SEPARATE `voice_latency.speculative_terminal_reason` telemetry event — clean separation between cost-ledger affecting fields and dashboard attribution.
- `opts.cancelledBeforeTextSent: true` correctly skips the `charsCancelled` increment (no chars billed if the speculator never reached `client.synth()`).
- Back-compat preserved (2-arg legacy calls still work — opts defaults to `{}`).
- Test coverage at `cost-tracker-opts-reason.test.js` hits all four paths (legacy 2-arg, reason emission, cancelledBeforeTextSent skip, both-unset legacy match).

This is exactly the right reconciliation. Cost integrity preserved, telemetry intent preserved, no validator surgery required.

### I1 — deferredTTS interaction
**CLOSED** by Pivot 10.1. Four explicit rules pinned:
1. Fast-tts playback uses a new `playFastPathAudio(audioData, slot)` function that bypasses `shouldDeferPlayback` — does NOT route through `speakWithTTS` (line 1136-1141). Rationale (the audible-latency win requires immediate play) is sound; the inspector-talking-over scenario is acceptable and already matches cache-HIT behaviour.
2. Bundler queue check happens at TOP of `speakBriefConfirmation` BEFORE `speakWithTTS` dispatch — the bypass-the-queue race I flagged is closed.
3. `deferredTTS` 6s-drop transitions matching `bundlerPlayed` slots back to `idle` — keeps queue logic honest. Defensive but correct.
4. Late fast-tts arriving for `bundlerPlayed` slot: DISCARD audio, transition to `resolved`. Explicit "free the buffer" instruction prevents memory accumulation.

Updated race matrix (6 scenarios) covers all transitions I flagged + the deferredTTS-drop case. Test file `AlertManagerStateMachineTests.swift` enumerates all 6 scenarios.

### I2 — Type normalization on abortBySlot predicate
**CLOSED** by Pivot 11.2. The `slotMatches` predicate now:
- Normalizes boardId via `String()` coercion + empty-string → null (matches existing `loaded-barrel-cache.js:invalidateBySlot` contract).
- Coerces circuit via `Number()` for the comparison (string-vs-int hint mismatches handled).
- Explicitly documents `circuit: 0` vs `circuit: null` as DIFFERENT (board-level vs unset) — exactly what I asked for.
- Exports `slotMatches` for reuse + testing.
- Test cases enumerate the four edge cases I identified (empty-string boardId, numeric-vs-string circuit, circuit:0 vs null distinction, cross-board mismatch).

Predicate now aligns with the cache's existing contract. The "abortBySlot returns 0 in race conditions and wasted-synth claim breaks" risk is closed.

### I3 — `getActiveSession` falsely claimed
**CLOSED** by Pivot 12.1. v5 acknowledges the v4 claim was false, adds an explicit new helper `getActiveSessionEntry(sessionId)` that returns `activeSessions.get(sessionId) ?? null`. Phase 1 fast-tts endpoint validation uses the new helper. Code sample resolves `liveBoardId` correctly via `entry.session?.stateSnapshot?.currentBoardId ?? getMainBoardId(...)`. The executor now has an unambiguous import target.

### I4 — Late-ACK behaviour
**CLOSED** by Pivot 8.1. Late-ACK path emits a separate `voice_latency.late_playback_ack` CloudWatch row (option 2 from my round-4 recommendation — the one I preferred). Row contains `{sessionId, turnId, slot_key, source, at_ms, received_at_ms, lag_ms}` for post-hoc dashboard correlation against the earlier `turn_audio_summary`. Endpoint returns 204 for both on-time and late paths (iOS doesn't distinguish, which is correct). CloudWatch immutability preserved.

### NITs — N1 through N5
- **N1 (state count):** Pivot 10.2 corrects the header AND justifies why `resolved` is not redundant (scenarios where fast-tts arrives after bundler already played need a distinct terminal). Correctly retained as 5 states.
- **N2 (pendingControllers preservation):** Pivot 11.3 explicit: existing Set STAYS, new Map ADDED in parallel. Both cleared on terminal in same code path. Doc comment added.
- **N3 (invalidateBySlot signature cite):** Not explicitly addressed as a numbered pivot in v5, but v5 §F mentions "N3 explicit cite". I would have liked the cite line itself spelled out in §B file table, but it's a doc-only gap and the cache line 309 signature is already verified.
- **N4 (cleanup rationale):** Pivot 12.2 rewrites the comment correctly — the real ordering reason is that `pendingAudioFinalizers` must be armed before any `/playback-ack` POST can find it; `pendingFastTtsSlots` cleanup is unrelated and just colocated for convenience.
- **N5 (expected_acks circular formula):** Pivot 8.2 fixes — counts by intent (`fast_tts_correlation_id != null`) not outcome. The bonus refinement (`decrementExpectedAcks` for rejected fast-tts with a deferred-decrement stash in `session.pendingAckDecrements`) is a clean handling of the race where the endpoint rejects before the finalizer is armed.

## BLOCKERs

None.

## IMPORTANTs

None.

## NITs

### N-v5.1: §B file table omits the iOS test file
The §C tests section lists `AlertManagerStateMachineTests.swift` (NEW, 6 race scenarios) but §B's "Updated files" table doesn't include the iOS test file. Cosmetic — the executor will create it anyway from §C — but the table would be tidier as a complete manifest.

### N-v5.2: Pivot 8.2's `pendingAckDecrements` stash is a new data structure introduced inline
The deferred-decrement Map (`session.pendingAckDecrements: Map<turnId, number>`) is introduced mid-paragraph in Pivot 8.2 without a separate entry in §B's file table or §C's test list. The executor should know:
- Where it lives (`session` object on what — `active-sessions.js` entry?).
- When it's cleared (presumably when the finalizer arms and subtracts, but explicit cleanup-on-turnEnd would be safer to prevent slow leaks if a turn dies between rejection and finalizer arm).

A test asserting "rejected fast-tts → decremented finalizer → no orphan stash" would close this loop. `voice-latency-turn-summary-decrement.test.js` is listed; I'd want one of its cases to assert the stash is cleared.

## Things I verified in the codebase (v5 deltas)

| Claim | Status |
|---|---|
| `cost-tracker.js:254-266` validator accepts 3-value enum | VERIFIED in round-4; v5's design preserves this (no change required to validator) |
| `loaded-barrel-cache.js:invalidateBySlot` normalization template | VERIFIED in round-4; v5's `slotMatches` adopts compatible normalization |
| `active-sessions.js` exports `activeSessions` Map | VERIFIED in round-4; v5 correctly adds `getActiveSessionEntry` as new helper |
| `AlertManager.swift:1136-1141` deferral check is the right insertion point | VERIFIED in round-4; v5's `playFastPathAudio` correctly bypasses it |
| `AlertManager.swift:1178-1213` resume/drop is the right transition site | VERIFIED in round-4; v5's defensive `bundlerPlayed → idle` on drop is sound |
| `pendingControllers` is a Set (not slot-addressable) | VERIFIED in round-4; v5 preserves it for shutdown() |

## Recommended verdict

**SHIP v5.** Zero BLOCKERs, zero IMPORTANTs. The single round-4 BLOCKER (cost-tracker signature contradiction) is reconciled with the cleanest of the three options I proposed (extend with opts, keep terminal enum stable). All four IMPORTANTs are addressed with codebase-aligned, executor-actionable specs. The two remaining NITs are documentation polish that will not cause production failures or wasted executor cycles.

**Convergence achieved.** v5 is the convergence draft the §G open-question carry-forward claims it is. No further plan revision needed before execution; the executor can begin Phase 1 (fast-tts endpoint) immediately.

**Sanity check on Codex round-3 BLOCKERs:** B1 (telemetry emission model) and B2 (two-entry speculator skip) remain CLOSED — v5 made no changes that regress those resolutions. Pivot 8's two-row split is intact; Pivot 9's `_speculate()` shared preflight is intact.
