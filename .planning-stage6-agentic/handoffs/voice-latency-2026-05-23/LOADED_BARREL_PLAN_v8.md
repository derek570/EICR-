# Loaded Barrel v8 — Wrapper Diff, 200ms Claim, JSON-Resource Rules

**Date:** 2026-05-24
**Supersedes:** v7 (5 distinct BLOCKERs across Plan + Codex)
**Read order:** v6 → v7 → v8 (this is a delta on v7's deltas)

## v7 BLOCKER closure

| v7 BLOCKER | v8 fix |
|---|---|
| **B-V7-1 / Codex-1** `onDispatchedToolUse` hook + `snapshotPatch` not in dispatcher API; would require every dispatcher signature changing | **[CHANGE]** Drop the per-dispatcher hook approach. Instead: add a single `dispatchToolUseWithDiff(toolUse, ctx)` wrapper in `stage6-tool-loop.js` that (a) snapshots `perTurnWrites` BEFORE dispatch, (b) calls existing dispatcher chain unchanged, (c) diffs `perTurnWrites` AFTER, (d) emits `onSnapshotPatch({toolUse, dispatchResult, patch})` to subscribers. No dispatcher signature changes. Diff = added/removed `readings` Map entries (composite-key `boardId::field::circuit`) + board_ops + observation_ops. Phase 2 explicitly declares: ONE new wrapper + ONE new lifecycle hook (`onSnapshotPatch`), nothing else. |
| **B-V7-2** pending-promise 1500ms await breaks HTTP timing | **[CHANGE]** Phase 3 Codex-1 deadline cut: `PENDING_AWAIT_MAX_MS=200` (was 1500). Rationale: ElevenLabs Flash p95 TTFB ≈ 340ms; speculator started at dispatch should complete ≈350-450ms after iOS POST arrives in the typical case. 200ms catches the "speculator nearly done" window without making timeout-fall-through worse than just calling live. New atomic claim: cache entry has `state: 'pending'|'ready'|'claimed'|'aborted'`. Both keys.js and speculator's complete-handler do compare-and-swap on state via single-threaded event loop (Node is single-threaded, no real race). Pseudocode in §A. |
| **B-V7-3** iOS-first single TestFlight unachievable; Phase 4 grew | **[CHANGE]** Split Phase 4 into 4a (minimal, ships first) + 4b (parity-version, ships later): **4a** = iOS POSTs `turnId` + reads `result.confirmations[].board_id` (snake_case decode addition). Single-commit, ~6 lines. **4b** = `boardId/field/circuit` POST fields + `x-expand-version` header + Bundle hash + capability handshake. Phase 1.F readiness probe measures 4a adoption; flag flips to ON for 1% sessions ONLY for cached entries keyed without boardId AND only for record_reading (not record_board_reading) until 4b adopts. Multi-board protection via Phase 5 invariant that drops cache entries when ANY board has >1 board in the session jobState. Documented limitation. |
| **Codex-2** `confirmations[].board_id` not on wire | **[CHANGE]** Phase 1.B bundler-export sub-task expanded: `buildConfirmations(perTurnWrites, snapshotView)` is modified to emit `{text, field, circuit, board_id}` per entry. iOS Phase 4a adds the snake_case decode (`boardId` keyed off `board_id`). Backwards-compat: old iOS clients ignore unknown field. |
| **B-V7-3 part 2 / I-V7-1 / Codex-3** build-time parity hash unreliable | **[CHANGE]** Defer parity-version gate to v9. v8 ships WITHOUT runtime version-hash check. Instead: Phase 0 ordered-fixture parity test gates code-merge. Field divergence detection via I-N4's text-drift detector (bundler-vs-speculator comparison) emits CloudWatch `loaded_barrel_text_drift` metric; alert on >0.1% drift fires manual rollback. Trades runtime safety for shippability. v9 considers JSON-resource refactor of iOS rule table to enable code-gen single-source-of-truth. |
| **I-V7-1** rules in Swift source not hashable cleanly | accepted, see above |
| **I-V7-2** speculative ledger orphan on `superseded` | **[CHANGE]** Phase 2.B step 9 expansion: any branch that drops a pending entry (superseded, aborted, ttl-expired, invalidate-by-slot) MUST call `recordElevenLabsSpeculativeTerminal(correlationId, <reason>)`. Reason enum: `'completed'|'cancelled_invalidated'|'cancelled_superseded'|'cancelled_ttl'|'cancelled_cap'|'failed'`. Audit invariant test: zero orphaned starts across all 10 harness scenarios. |
| **I-V7-3** snapshotPatch not in dispatcher return | resolved by wrapper-diff approach above |
| **I-V7-4** speculator computing text against partial state | **[CHANGE]** Wrapper-diff approach gives speculator the SAME `perTurnWrites + snapshotPatch` view that the bundler will use at turn-end. New `buildConfirmationTextFromSnapshotPatch(patch, sessionContext)` exported in Phase 1.B, called by BOTH speculator (per-patch) and bundler (per-turn aggregate). Test: speculator-computed text MUST equal bundler-computed text for that single patch. |

## §A — Atomic claim pseudocode (B-V7-2 fix)

```javascript
// Cache entry:
// { state, slot, promise, controller, mp3Buffer?, correlationId, charsBilled }

// keys.js short-circuit (single-threaded Node event loop, no real race):
const cached = loadedBarrelCache.peek(key);
if (cached && cached.state === 'ready') {
  if (loadedBarrelCache.claim(key)) {  // atomic CAS state: 'ready' -> 'claimed'
    res.set(...);
    res.write(cached.mp3Buffer);
    res.end();
    recordOutcome(cached.correlationId, 'loaded_barrel_hit');
    promoteSpeculativeToCanonical(cached.correlationId);
    return;
  }
  // claim failed (concurrent consume) — fall through to live
}
if (cached && cached.state === 'pending') {
  // race condition: speculator still synthesizing
  const winner = await Promise.race([
    cached.promise.then((buf) => ({type: 'spec', buf})),
    new Promise((r) => setTimeout(() => r({type: 'timeout'}), 200))
  ]);
  if (winner.type === 'spec' && loadedBarrelCache.claim(key)) {
    res.set(...);
    res.write(winner.buf);
    res.end();
    recordOutcome(cached.correlationId, 'loaded_barrel_hit_pending');
    promoteSpeculativeToCanonical(cached.correlationId);
    return;
  }
  // timeout or claim lost: supersede the speculator and fall through
  loadedBarrelCache.markSuperseded(key);  // sets state: 'aborted'
}
// fall-through to existing live synth path
```

```javascript
// Speculator's complete-handler:
on synth success(buf) {
  const entry = cache.get(key);
  if (!entry) return;  // pruned
  if (entry.state === 'aborted' || entry.state === 'claimed') {
    recordElevenLabsSpeculativeTerminal(entry.correlationId, 'cancelled_superseded');
    return;
  }
  // CAS pending -> ready
  if (!cache.markReady(key, buf)) {
    recordElevenLabsSpeculativeTerminal(entry.correlationId, 'cancelled_superseded');
    return;
  }
  recordElevenLabsSpeculativeTerminal(entry.correlationId, 'completed');
  entry.promise.resolve(buf);
}
```

State machine: `pending → ready → claimed` (HIT) | `pending → aborted` (invalidate/supersede) | `pending → ready → ttl_expired`. Five transitions. Each has explicit Terminal call.

## §B — Single-board guardrail (B-V7-3 fix)

Phase 5 invariant test: speculator MUST early-return (no synth, no telemetry) when `session.jobState.boards.length > 1` AND iOS adoption gate hasn't reached 4b. Implementation: `if (sessionContext.requiresBoardIdKeying && !session.voiceLatency.capabilities.includes('loaded_barrel_v8b')) return;`.

iOS 4a clients advertise `loaded_barrel_v8a` capability (POSTs turnId, reads board_id).
iOS 4b clients advertise `loaded_barrel_v8b` capability (POSTs slot fields + parity).

Backend per-session gate:
- 0 boards or 1 board AND client has v8a → speculator runs, key omits boardId
- >1 board AND client has v8b → speculator runs, key includes boardId
- otherwise → no-op

## §C — Effort revision

| Item | Days |
|---|---|
| Phase 0 (no change from v7: ordered fixtures + drift telemetry spec) | 6 |
| Phase 1 (A-F, plus wrapper-diff scaffolding) | 4 |
| Phase 2 (wrapper + onSnapshotPatch + speculator + cache + cap + ledger) | 7 |
| Phase 3 (keys.js short-circuit + atomic claim + 200ms pending-await) | 1.5 |
| Phase 4a iOS (turnId + board_id decode) | 0.5 iOS + TestFlight cycle |
| Phase 4b iOS (slot fields + parity header) | 1.5 iOS + TestFlight cycle |
| Phase 5 (invariants + single-board guard + drift detector) | 3 |
| Phase 6 (harness scenarios incl. state-machine cases) | 3 |
| Phase 7 field assessment | 0 (2 wks wall) |
| **Total** | **24.5 backend + 2 iOS (split 0.5+1.5) + 2 wks field** |

## v8 explicit non-goals

- Parity-version runtime hash — deferred to v9 (requires iOS rule-table refactor)
- WS pooling per session — deferred to v9
- Multi-round Sonnet latency floor — SEPARATE sprint (prompt change)

## Open questions for next reviewer

1. Does Express response semantics actually allow `await Promise.race` mid-handler without leaking sockets when timeout fires AND the awaited promise resolves at the same tick?
2. Is `perTurnWrites.readings` actually a Map with composite-key structure today, or per-board nested? (Need to verify before wrapper-diff can compute patches.)
3. Are board_ops + observation_ops in `perTurnWrites` today, and are they cumulative-per-turn or per-dispatch?

## Decision gate

Four checks (UNCHANGED from v7 + 1 new):
1. iOS `AlertManager.expandForTTS` rules captured + parity tests pass
2. ElevenLabs WS short-text behaviour verified
3. `turnId` + `board_id` round-trip verified on TestFlight 4a build
4. Phase 1.F readiness probe reports ≥80% 4a adoption before flag flips
5. **NEW**: Wrapper-diff PoC test: speculator-text == bundler-text for 100 sampled record_reading + record_board_reading combinations (must be 100% match, not 99%)
