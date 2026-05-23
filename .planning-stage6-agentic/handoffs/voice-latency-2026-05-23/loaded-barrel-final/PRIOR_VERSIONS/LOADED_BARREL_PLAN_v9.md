# Loaded Barrel v9 — Board-Transition Prune, Diff Scope Lock, Timer-Race Guard

**Date:** 2026-05-24
**Supersedes:** v8 (1 BLOCKER both reviewers + 4 IMPORTANT each)
**Read order:** v6 → v7 → v8 → v9 (delta-on-delta-on-delta)

## v8 BLOCKER + IMPORTANT closure

| v8 finding | v9 fix |
|---|---|
| **BL1 (Plan + Codex)** 1→2 board transition leaves un-board-keyed cache entries consumable for wrong board | **[NEW]** Phase 2.B step 5a: speculator subscribes to `onSnapshotPatch` for `boardOps` AS WELL as `readings/boardReadings`. When patch contains a `add_board` op (i.e. `snapshot.boards.length` increased) OR `change_current_board` op that switches to a different boardId: invoke `cache.pruneSessionUnboardedEntries(sessionId)` which iterates the session's per-session LRU and removes every entry whose stored `slot.boardId === null` AND state `∈ {'pending', 'ready'}`. Pending entries get `cancelled_cap`-equivalent reason `cancelled_board_transition`. New harness scenario `loaded_barrel_board_added_mid_turn.yaml` asserts cache size goes to 0 after add_board. |
| **I1 (Plan)** wrapper-diff implementation must use Map-key-equality + handle overwrites | **[NEW]** Phase 2.A explicit spec: `diffReadingsMap(before: Map, after: Map): {added: Map, removed: Set, overwritten: Map<key, {old, new}>}`. Speculator runs only for `added` and `overwritten.new` entries (NOT removed). Test: corrections that overwrite (same key, new value) trigger speculator with the NEW value. Unit test covers all three branches. |
| **I2 (Plan)** Promise.race timer-vs-resolve ordering non-deterministic on same tick | **[NEW]** Phase 3 §A timer-callback addition: in the `setTimeout(200)` callback, BEFORE resolving the race with `'timeout'`, re-peek the cache. If `entry.state === 'ready'`, return `{type: 'spec_late', buf: entry.mp3Buffer}` instead. New pseudocode in §A. Also: live-fallback path guards `if (res.headersSent || res.writableEnded) return;` before calling `streamConfirmationViaElevenLabs`. Test scenario: scripted micro-timing where synth completes at exactly t=200ms; cache hit is preferred. |
| **I3 (Plan)** drift detector needs bundler text to compare against speculator text on HIT path | **[CHANGE]** Phase 5 §I-N4 expanded: bundler ALWAYS runs at turn-end regardless of HIT/MISS/PENDING outcomes. Its emitted `confirmations[]` are matched against speculator-cached texts for the same `(sessionId, turnId, slot)`. Each turn writes a `loaded_barrel_drift_check` row to CloudWatch with `{matched: int, mismatched: int, mismatched_samples: [{cached, bundler}]}`. Alert fires on >0.1% mismatch over a 1h window. HIT path itself doesn't suppress bundler — only the wire-emission of redundant audio is skipped (iOS already played the cached buf). |
| **I4 (Plan)** wrapper-diff scope is overbroad (includes boardOps/observations that produce NO confirmation) | **[CHANGE]** Phase 2.A diff is restricted to `readings` + `boardReadings` Maps. `boardOps`/`observationOps`/`circuitOps` are still INSPECTED but only to fire `pruneSessionUnboardedEntries` (BL1 fix). They do NOT trigger speculator synth. Documented as "two consumers, one wrapper hook: readings-diff for speculation, ops-presence for invalidation." |
| **Codex I1** wrapper-diff for "later dispatches that clear/overwrite/reassign" | **[CHANGE]** Already handled by `overwritten` branch in I1 fix above + Codex-2's `invalidateBySlot` from v7. Plus new: `clear_reading` dispatches produce a `removed` map entry in the diff → speculator calls `cache.invalidateBySlot(sessionId, turnId, slot)` which aborts pending + drops ready for that slot. Explicit in Phase 2.B step 6. |
| **Codex I2** `boardReadings` Map shape vs v8's stated `readings + board_ops + observation_ops` | resolved by I4 above — explicit scope is `readings` + `boardReadings` only. Verified key shape: composite encoded via `encodeReadingKey(field, circuit, boardId)` with NUL sentinel for null boardId. Diff uses Map-key-equality (string comparison) on these encoded strings. |
| **Codex I3** CAS markSuperseded must be pending→aborted only | **[NEW]** State machine table (frozen): `pending → ready` (speculator completes), `pending → aborted` (invalidate/supersede/cap), `ready → claimed` (HIT), `ready → ttl_expired` (TTL fires), `ready → aborted` (board transition prune). Forbidden: `claimed → *`, `aborted → *`, `ttl_expired → *`. `markSuperseded` CAS: `pending → aborted` only — refuses if state ≠ pending. |
| **Codex I4** parity-hash deferred ⇒ silent drift window | **[ACCEPTED, mitigation tightened]** v8 already documented this trade-off. v9 mitigation: `tts-text-expander.js` and `AlertManager.swift:expandForTTS` get matching `EXPANDER_VERSION = '2026-05-24'` string constant. Phase 0 fixture file lives alongside both files with cross-references in a comment block. Any edit to either MUST bump both version strings and update fixtures. PR template check (lint-style): `git diff` for the iOS file changes triggers a checklist line "Did you update tts-text-expander.js + EXPANDER_VERSION?". Soft control, not a runtime gate. v10 considers automated cross-file check via pre-commit hook. |
| **Plan N1** effort arithmetic 24.5 vs 25.5 | **[FIX]** Effort total corrected to 25.5 backend days. |
| **Plan N2** open question 3 (board_ops cumulative-per-turn) | **[CLOSE]** Verified append-only per-turn at stage6-per-turn-writes.js:65-75. Removed from open questions. |
| **Plan N3** iOS Stage6Messages.swift decoder change for confirmations[].board_id | **[NEW]** Phase 4a iOS scope expanded by 2 lines: `ValueConfirmation` struct adds `let boardId: String?` with CodingKey `board_id`. Decoder uses `decodeIfPresent` so old wire shape still decodes. |
| **Codex N1** ValueConfirmation struct field addition | identical to Plan N3 above, single line item |
| **Codex N2** iOS dedupe key needs boardId at 4b | **[NEW]** Phase 4b iOS task: `AlertManager` confirmation dedupe key extends from `field_circuit` to `field_circuit_boardId`. 1-line change. |

## §A — v9 timer-race-safe pseudocode (I2 fix)

```javascript
// keys.js short-circuit, pending-await branch:
if (cached && cached.state === 'pending') {
  const winner = await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

    cached.promise.then((buf) => settle({type: 'spec', buf}));

    setTimeout(() => {
      // RE-PEEK before timing out: synth may have completed
      // in same macrotask as the timer fire
      const recheck = loadedBarrelCache.peek(key);
      if (recheck && recheck.state === 'ready') {
        settle({type: 'spec_late', buf: recheck.mp3Buffer});
      } else {
        settle({type: 'timeout'});
      }
    }, 200);
  });

  if ((winner.type === 'spec' || winner.type === 'spec_late')
      && loadedBarrelCache.claim(key)) {
    // serve cached buffer
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Voice-Latency-Source', winner.type === 'spec' ? 'loaded_barrel_hit_pending' : 'loaded_barrel_hit_late');
    res.write(winner.buf);
    res.end();
    recordOutcome(cached.correlationId, winner.type === 'spec' ? 'loaded_barrel_hit_pending' : 'loaded_barrel_hit_late');
    promoteSpeculativeToCanonical(cached.correlationId);
    return;
  }

  // timeout or claim lost
  loadedBarrelCache.markSuperseded(key);  // CAS pending→aborted only
}

// live fallback path:
if (res.headersSent || res.writableEnded) return;  // safety
await streamConfirmationViaElevenLabs(/* existing path */);
```

## §B — State machine (frozen — must not change without explicit RFC)

```
   ┌──────┐  synth ok      ┌───────┐  claim()   ┌─────────┐
   │pending├──────────────►│ ready ├───────────►│ claimed │
   └──┬───┘                └───┬───┘            └─────────┘
      │ abort/supersede        │ ttl
      │ cap/board_transition   ▼
      ▼                    ┌─────────────┐
   ┌─────────┐             │ ttl_expired │
   │ aborted │             └─────────────┘
   └─────────┘
```

All cancellation reasons reach `recordElevenLabsSpeculativeTerminal` exactly once. Audit invariant test (Phase 5): every `recordElevenLabsSpeculativeStarted(correlationId)` has exactly one matching `recordElevenLabsSpeculativeTerminal(correlationId, reason)`.

## §C — Effort (corrected)

| Item | Days |
|---|---|
| Phase 0 | 6 |
| Phase 1 | 4 |
| Phase 2 (wrapper-diff + speculator + cache + cap + ledger + board-transition prune) | 7.5 |
| Phase 3 (keys.js short-circuit + atomic claim + timer-race guard) | 1.5 |
| Phase 4a iOS (turnId + board_id decode + ValueConfirmation field) | 0.5 + TestFlight |
| Phase 4b iOS (slot fields + parity header + dedupe key) | 1.5 + TestFlight |
| Phase 5 (invariants + state-machine audit + drift detector) | 3 |
| Phase 6 (harness scenarios incl. board-transition + timer-race) | 3 |
| Phase 7 field assessment | 0 (2 wks wall) |
| **Total** | **25.5 backend + 2 iOS + 2 wks field** |

## Remaining open issues (NOT blockers)

- **OD1.** Single-source-of-truth for expandForTTS rules — v10 candidate (JSON resource refactor)
- **OD2.** WS pooling per session — v10 candidate
- **OD3.** "Loaded Barrel" naming overlap — cosmetic
- **OD4.** Cost-model HIT rate 70% assumption vs 50% rollback gate — measured in Phase 7

## Decision gate (UNCHANGED from v8 + 1 strengthened)

1. iOS `AlertManager.expandForTTS` rules captured + parity tests pass
2. ElevenLabs WS short-text behaviour verified
3. `turnId` + `board_id` round-trip verified on TestFlight 4a build
4. Phase 1.F readiness probe reports ≥80% 4a adoption before flag flips
5. **STRENGTHENED**: Wrapper-diff PoC test — speculator-text == bundler-text for 100 sampled record_reading + record_board_reading combinations + 20 corrections (overwrite branch) + 10 clear_reading patches. 130/130 match required, not 99%+.
6. **NEW**: State-machine audit test — fuzzer that runs 10,000 random sequences of (synth_ok, synth_fail, claim, supersede, ttl, board_transition) against a single cache entry. Zero illegal transitions. Zero orphaned starts.
