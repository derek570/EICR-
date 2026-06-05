# Single-Round Latency Sprint — Plan v7

**Date:** 2026-05-25
**Status:** DRAFT — pending round 7 review.
**Supersedes:** PLAN_v6.md. SURGICAL revision closing Codex round-6 BLOCKER (B-v6.1: `_maybeRecordTerminal` cache-entry guard fails when cache deletes entries during supersede/prune/TTL paths) + 2 IMPORTANTs (I-v6.1 `fastPathCorrelationIdByTurn` plumbing; I-v6.2 `cacheKeyForCorrelation` helper) + 1 NIT.

**Read PLAN_v3.md through PLAN_v6.md alongside this file.** v7 only describes deltas from v6.

---

## §A — v7 pivot deltas

### Pivot 11.6 — Durable ledger-open state outside the cache (closes Codex B-v6.1)

**Problem identified by Codex:** v6 stored "did the ledger open?" as `costRegistered: boolean` on the cache entry itself. But the loaded-barrel cache deliberately deletes entries on `markSuperseded()`, TTL expiry, `invalidateBySlot()`, and `pruneForSession()` paths — well before some `.then()` / `.catch()` / `_onSynthError` handlers run. After deletion, `_maybeRecordTerminal` sees no entry and routes the call to telemetry-only (`speculative_terminal_skipped`), skipping the ledger close even though `charsStarted` was incremented.

Concrete failure trace (from Codex's review):
1. `recordElevenLabsSpeculativeStarted` increments `charsStarted` + `elevenLabsCharacters`.
2. iOS pending-wait times out → `keys.js` calls `markSuperseded(cacheKey, 'ios_post_timeout')`.
3. `_terminate()` aborts the controller + deletes the cache entry.
4. Speculator's deferred `.catch()` runs → `_maybeRecordTerminal(correlationId, 'cancelled')`.
5. Cache lookup fails → no terminal recorded → `charsStarted` orphan → invariant breaks.

**v7 design:** Move "ledger opened?" state to a speculator-local Map whose lifetime is independent of the cache. Tied to the correlation id, NOT to the cache entry.

`src/extraction/loaded-barrel-speculator.js`:
```js
// NEW module-level state, alongside pendingControllers + pendingByCorrelation:
//
// costOpenByCorrelation tracks correlation ids whose Started call SUCCEEDED.
// Set membership = "ledger is open and owes exactly one Terminal."
// Entries are added in _speculate() AFTER recordElevenLabsSpeculativeStarted
// returns true; deleted by _maybeRecordTerminal on the first terminal call
// (idempotent — second call from a different handler no-ops).
//
// Lifetime is INDEPENDENT of the loaded-barrel cache. The cache may delete
// the cacheKey entry during supersede/TTL/invalidate/prune long before the
// speculator's deferred .then()/.catch() runs; this Set survives those
// deletions and continues to hold the correlation id until terminal close.
const costOpenByCorrelation = new Set();
```

Modified `_speculate()` opens the ledger ONLY at the text-sent boundary (v6 Pivot 11.4 unchanged) and records membership in the Set:
```js
// ... after _resolveApiKey, after clientFactory, after abort guard ...

// Open the cost ledger at the text-sent boundary (v6 Pivot 11.4)
if (!costTracker.recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)) {
  // Dedupe or invalid input — no ledger entry created.
  pendingControllers.delete(controller);
  pendingByCorrelation.delete(correlationId);
  resolvePromise(null);
  cache.delete(cacheKey);
  return;
}

// Mark the ledger as open. Lifetime independent of cache; survives
// supersede/prune/TTL deletion of the cacheKey entry. Cleared by
// _maybeRecordTerminal on the first terminal call.
costOpenByCorrelation.add(correlationId);

// ... rest of synth invocation unchanged ...
```

Modified `_maybeRecordTerminal()` consults the durable Set, not the cache:
```js
function _maybeRecordTerminal(correlationId, cacheKey, terminal, opts = {}) {
  // CACHE-INDEPENDENT GUARD: the Set is the source of truth for "ledger opened"
  // because the cache entry may have been deleted by supersede/TTL/invalidate/
  // prune long before this terminal handler runs.
  if (costOpenByCorrelation.has(correlationId)) {
    costOpenByCorrelation.delete(correlationId);  // idempotency: first terminal wins
    costTracker.recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts);
    if (opts.reason) {
      recordOutcome(correlationId, 'voice_latency.speculative_terminal_reason', {
        meta: { terminal, reason: opts.reason, cacheKey },
      });
    }
  } else {
    // Either (a) the ledger was never opened (pre-text abort), OR
    // (b) a previous terminal handler already closed it. Both legitimate.
    recordOutcome(correlationId, 'voice_latency.speculative_terminal_skipped', {
      meta: { terminal_attempted: terminal, reason: opts.reason ?? null, cacheKey },
    });
  }
}
```

The `cacheKey` parameter is now purely diagnostic (logged for context). The cost decision uses ONLY the durable Set.

**Idempotency:** the `Set.delete` on first terminal makes subsequent calls a no-op. Concretely: if both `abortBySlot()` and the deferred `.catch()` try to terminal the same correlationId, exactly ONE wins (the first to call). The second emits `speculative_terminal_skipped` (correct — ledger already closed).

**`cacheKeyForCorrelation` retired entirely.** The helper Codex flagged as missing (I-v6.2) is not needed. The speculator's `.then()`/`.catch()` closures already capture `cacheKey` locally. `abortBySlot()` walks `pendingByCorrelation` and has the cacheKey in the value tuple per v4 Pivot 11.

**Cleanup on shutdown:** `speculator.shutdown()` (current `loaded-barrel-speculator.js:537-544`) iterates `pendingControllers` and aborts them. v7 adds a final sweep: any correlationId remaining in `costOpenByCorrelation` after the abort-loop emits `costTracker.recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled', {reason: 'speculator_shutdown'})` — ensures the invariant holds across speculator restart.

**Cleanup on session-prune:** `pruneForSession(sessionId)` (cache) does NOT touch `costOpenByCorrelation`. The Set entries for that session's correlations remain until their respective terminal handlers fire (via the aborted controller's `.catch()` path). The controller abort guarantees a terminal handler always runs eventually — no leak.

Tests at `loaded-barrel-speculator-cost-integrity.test.js` (NEW):
- **markSuperseded post-text path:** Started → markSuperseded deletes cache entry → controller aborts → `_onSynthError` calls `_maybeRecordTerminal` → ledger is closed with 'cancelled' (NOT silently skipped). Invariant `charsCompleted + charsCancelled + charsFailed === charsStarted` holds.
- **pruneForSession post-text path:** Started → pruneForSession deletes cache entry → controller aborts → terminal closes ledger. Invariant holds.
- **TTL expiry post-text path:** Started → cache TTL fires → entry deleted → controller aborts → terminal closes. Invariant holds.
- **abortBySlot + deferred catch race:** abortBySlot fires first, calls terminal('cancelled') → Set drops correlationId → deferred catch later calls terminal → no double-record, second call emits skipped event. Invariant holds.
- **Shutdown sweep:** Started → shutdown() called → orphan correlationId in Set → sweep records terminal('cancelled', reason='speculator_shutdown') → invariant holds.
- **Pre-text abort:** abort fires before `recordElevenLabsSpeculativeStarted` → Set never added → terminal handler emits skipped (correct). No invariant violation because `charsStarted` was never incremented.
- **Happy path:** synth completes → markReady → `_maybeRecordTerminal('completed')` → ledger closes with 'completed'. Invariant holds.

### Pivot 8.4 — `fastPathCorrelationIdByTurn` plumbing pinned (closes Codex I-v6.1 + Claude I-v6.1)

**Problem:** v6 Pivot 8.3 referenced `session.fastPathCorrelationIdByTurn.get(turnId)` but didn't say where the Map is allocated, who populates it, or when it's cleared.

**v7 design — full lifecycle pinned:**

1. **Allocation** — in `active-sessions.js` session-creation site (`createSession` or equivalent on first transcript), add:
   ```js
   session.fastPathCorrelationIdByTurn = new Map();   // turnId → Set<correlationId>
   ```
   Same place that `session.pendingFastTtsSlots` is allocated per v3 Pivot 5.

2. **Population** — in `runLiveMode()` (`stage6-shadow-harness.js:197+`), AFTER `turnId` is minted from `session.turnCount + 1`, the WS transcript message is parsed. If `transcript.regex_fast_correlation_id` is present:
   ```js
   if (transcriptMessage.regex_fast_correlation_id) {
     const existing = session.fastPathCorrelationIdByTurn.get(turnId) ?? new Set();
     existing.add(transcriptMessage.regex_fast_correlation_id);
     session.fastPathCorrelationIdByTurn.set(turnId, existing);
   }
   ```
   This runs ONCE per turn at runLiveMode entry — before the transcript reaches `runToolLoop`.

3. **Consumption** — `startAudioFinalizer(session, turnId, ...)` calls:
   ```js
   const correlationIds = session.fastPathCorrelationIdByTurn.get(turnId) ?? new Set();
   const decrementCount = consumePendingDecrements(session.sessionId, correlationIds);
   ```
   per v6 Pivot 8.3. No change.

4. **Cleanup** — in the existing `try/finally` block from v5 Pivot 12.1 around `runLiveMode` body (`stage6-shadow-harness.js`), the `finally` clears both maps for that turnId:
   ```js
   try {
     // ... runLiveMode body ...
     emitTurnCoreSummary(...);
     startAudioFinalizer(...);
   } finally {
     session.pendingFastTtsSlots.delete(turnId);
     session.fastPathCorrelationIdByTurn.delete(turnId);
   }
   ```

5. **Session-teardown cleanup** — when the WS closes and `activeSessions.delete(sessionId)` runs (existing path in `sonnet-stream.js`), the entire `session` object is garbage-collected including these maps. No additional teardown needed.

6. **LRU cap:** outer Map sized at 100 turnId entries (defensive against turn-leak under pathological error paths). Same cap as v3 `pendingFastTtsSlots`. Inner Set capped at 8 correlation ids per turn (one inspector utterance generates at most ~5 fast-tts POSTs realistically).

### Pivot 11.7 — `_maybeRecordTerminal` signature finalized (closes Codex I-v6.2 + Claude I-v6.2)

**v7 design:**
```js
function _maybeRecordTerminal(correlationId, cacheKey, terminal, opts = {})
```

`cacheKey` parameter:
- DIAGNOSTIC ONLY — logged in `meta` for telemetry correlation.
- NOT used for the cost decision (that's `costOpenByCorrelation` per Pivot 11.6).
- Passed by callers from local scope; speculator's `.then()`/`.catch()` already capture it; `abortBySlot()` retrieves it from `pendingByCorrelation`.

**No new exports from `loaded-barrel-cache.js`.** `cacheKeyForCorrelation` is NOT needed and NOT added. Codex's preferred Option (b) — pass cacheKey directly — is adopted verbatim.

### Pivot 11.8 — Cost invariant assertion placement (closes Claude N-v6.1 NIT)

**v7 design:** the invariant `charsCompleted + charsCancelled + charsFailed === charsStarted` is asserted in TEST CODE ONLY, NOT in production cost-tracker hot path.

- New test helper `_assertCostInvariant(costTracker)` in `src/__tests__/test-helpers/cost-invariant.js`.
- Called from `afterEach` in `cost-tracker-pre-text-abort.test.js` and `loaded-barrel-speculator-cost-integrity.test.js`.
- Production `cost-tracker.js` does NOT add hot-path validation (overhead avoidable).

Implementation:
```js
// src/__tests__/test-helpers/cost-invariant.js
export function assertCostInvariant(costTracker) {
  const s = costTracker.elevenLabsSpeculative;
  if (s.charsCompleted + s.charsCancelled + s.charsFailed !== s.charsStarted) {
    throw new Error(`Speculative cost invariant violated: ` +
      `completed=${s.charsCompleted} + cancelled=${s.charsCancelled} + ` +
      `failed=${s.charsFailed} !== started=${s.charsStarted}`);
  }
}
```

---

## §B — Updated files (v7 deltas vs v6)

| File | v7 change |
|---|---|
| `src/extraction/loaded-barrel-speculator.js` | ADD module-level `costOpenByCorrelation: Set`; modify `_speculate()` to add on Started success; modify `_maybeRecordTerminal` to consult Set + delete on terminal; modify `shutdown()` to sweep orphans |
| `src/extraction/active-sessions.js` | ADD `session.fastPathCorrelationIdByTurn: Map<turnId, Set<correlationId>>` in createSession site (alongside existing `pendingFastTtsSlots`) |
| `src/extraction/stage6-shadow-harness.js` | POPULATE the map on WS transcript with `regex_fast_correlation_id` in `runLiveMode` entry; CLEANUP both maps in the existing try/finally block |
| `src/extraction/loaded-barrel-cache.js` | NO CHANGES — `cacheKeyForCorrelation` is NOT added (retired per Pivot 11.7) |

---

## §C — Updated tests (v7 deltas)

- `src/__tests__/loaded-barrel-speculator-cost-integrity.test.js` (NEW): 7 cases enumerated in Pivot 11.6. Each `afterEach` asserts the cost invariant.
- `src/__tests__/test-helpers/cost-invariant.js` (NEW): `assertCostInvariant` helper.
- `src/__tests__/voice-latency-turn-summary-decrement.test.js` (UPDATED): assert `fastPathCorrelationIdByTurn` lifecycle — populated on transcript, consumed at finalizer-arm, cleared in finally.
- `src/__tests__/loaded-barrel-speculator-shutdown-sweep.test.js` (NEW): asserts orphan correlationIds in `costOpenByCorrelation` are closed on shutdown.

---

## §D — Verification gate deltas (vs v6)

| Gate | v7 delta |
|---|---|
| **G0** | UNCHANGED. v7 fixes only affect the speculator + finalizer plumbing, not the telemetry contract. |
| **G2.unit** | EXTENDED: new `loaded-barrel-speculator-cost-integrity` suite. Pass criteria: all 7 cases including markSuperseded/pruneForSession/TTL-expiry assert invariant holds. |
| **Production gate (new)** | After v7 deploys, CloudWatch `voice_latency.speculative_terminal_skipped` event rate should drop to ~pre-text-abort rate (which equals `loaded_barrel_pretext_abort` event count). Any divergence indicates the durable-Set guard is leaking. |

---

## §E — Things NOT to break (v7 deltas vs v6)

23. **`loaded-barrel-cache.js` exports** — unchanged. No new exports added (`cacheKeyForCorrelation` retired).
24. **`recordElevenLabsSpeculativeTerminal` signature** — unchanged from v5 (`(correlationId, terminal, opts={})`).
25. **`pendingByCorrelation` from v4 Pivot 11** — unchanged. v7 adds `costOpenByCorrelation` ALONGSIDE it (different concerns: pendingByCorrelation is for abort routing, costOpenByCorrelation is for terminal accounting).
26. **`pendingControllers` Set from speculator** — unchanged (v5 Pivot 11.3 preserved it for shutdown sweep).
27. **Cache lifecycle (`_terminate`, `markSuperseded`, `pruneForSession`, TTL)** — unchanged. v7's correctness contract no longer depends on cache entry lifetime.

---

## §F — Cost-integrity correctness contract (v7 final)

For every speculation that the speculator attempts:

| Path | `charsStarted` | `charsCancelled/Completed/Failed` | Invariant holds? |
|---|---|---|---|
| Pre-text abort (abort before `client.synth()`) | unchanged | unchanged | YES (0 + 0 + 0 = 0) |
| Pre-text key-resolution failure | unchanged | unchanged | YES |
| Pre-text dedup (Started returned false) | unchanged | unchanged | YES |
| Post-text successful synth (markReady) | incremented | charsCompleted incremented | YES |
| Post-text abort (abortBySlot, .catch runs) | incremented | charsCancelled incremented | YES |
| Post-text markSuperseded + .catch (Codex's failure scenario) | incremented | charsCancelled incremented (via `_maybeRecordTerminal` durable Set) | YES |
| Post-text pruneForSession + .catch | incremented | charsCancelled incremented | YES |
| Post-text TTL expiry + .catch | incremented | charsCancelled incremented | YES |
| Post-text shutdown sweep | incremented | charsCancelled incremented (via shutdown loop) | YES |
| Concurrent abortBySlot + .catch (race) | incremented | charsCancelled incremented ONCE (Set idempotency) | YES |
| Post-text synth network failure | incremented | charsFailed incremented | YES |

All paths preserve `charsCompleted + charsCancelled + charsFailed === charsStarted`.

---

## §G — Revision history

- **v1-v5** — see prior revisions.
- **v6** — Pivot 11.4 (move Started to text-sent boundary), Pivot 8.3 (decrement keyed by correlation), Pivot 11.5 (G0 gate split).
- **v7** — Pivot 11.6 (durable `costOpenByCorrelation` Set replacing cache-entry guard), Pivot 8.4 (`fastPathCorrelationIdByTurn` full lifecycle), Pivot 11.7 (`_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)` signature with cacheKey as diagnostic-only), Pivot 11.8 (cost-invariant assertion in test code only). Target: zero BLOCKERs from both reviewers.

---

## §H — Open questions resolved in v7

- v6's `cacheKey` lookup for the terminal guard is REPLACED by a durable Set. No cache-lifetime dependency in the cost accounting.
- `fastPathCorrelationIdByTurn` allocation, population, cleanup, and LRU bounds — all pinned.
- `cacheKeyForCorrelation` helper — NOT added. Signature change takes cacheKey directly.
- Cost-invariant assertion placement — test code only, no hot-path overhead.
