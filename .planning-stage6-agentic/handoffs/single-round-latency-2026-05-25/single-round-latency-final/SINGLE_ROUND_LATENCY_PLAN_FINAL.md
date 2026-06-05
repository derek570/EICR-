> **Status: ZERO BLOCKERs from both Claude Plan-agent AND Codex CLI**
>
> Convergence achieved 2026-05-25 at round 8. Loaded Barrel precedent was 9 rounds; this sprint converged at 8.
>
> **Round 8 verdicts:**
> - Claude Plan-agent (round 8): 0 BLOCKERs, 0 IMPORTANTs, 1 NIT — SHIP
> - Codex CLI (round 8, gpt-5.5 xhigh): 0 BLOCKERs, 0 IMPORTANTs, 1 NIT — SHIP
>
> The locked plan IS PLAN_v8.md below (cumulative of pivots from v2 onward). See REVIEW_HISTORY.md for the full round-by-round audit trail. See EXECUTION_HANDOFF.md for orientation before starting Phase 0.

# Single-Round Latency Sprint — Plan v8

**Date:** 2026-05-25
**Status:** DRAFT — pending round 8 review.
**Supersedes:** PLAN_v7.md. SURGICAL revision closing Codex round-7 BLOCKER (B-v7.1: `costOpenByCorrelation` scope contradiction) + IMPORTANT (I-v7.1: new telemetry outcomes not registered).

**Read PLAN_v3.md through PLAN_v7.md alongside this file.** v8 only describes deltas from v7.

---

## §A — v8 pivot deltas

### Pivot 11.9 — `costOpenByCorrelation` scoped INSIDE `createSpeculator()` (closes Codex B-v7.1)

**Problem identified by Codex:** v7's text said "speculator-local" but the code block declared the Set as MODULE-level (`const costOpenByCorrelation = new Set();`). With per-session `costTracker` closures (`loaded-barrel-speculator.js:115-122`), a global Set causes cross-session sweep contamination: Session A's shutdown could close Session B's correlation against A's cost tracker.

**v8 design — Set is allocated INSIDE `createSpeculator()`, alongside `pendingControllers` and `pendingByCorrelation`:**

```js
// src/extraction/loaded-barrel-speculator.js
//
// Inside createSpeculator(opts) closure, after pendingControllers/pendingByCorrelation:

export function createSpeculator({ sessionId, apiKey, costTracker, logger, ... }) {
  // ... existing per-instance state ...
  const pendingControllers = new Set();
  const pendingByCorrelation = new Map();   // v4 Pivot 11

  // NEW v8 (Pivot 11.9 — scope-corrected from v7 Pivot 11.6):
  // costOpenByCorrelation is PER-INSTANCE state. Tracks correlation
  // ids whose recordElevenLabsSpeculativeStarted() succeeded on THIS
  // speculator's costTracker. Set membership = "ledger is open and
  // owes exactly one Terminal call against THIS costTracker."
  //
  // SCOPE: instance-local (same lifetime as `pendingControllers`).
  // SHUTDOWN sweep iterates only this instance's Set; cannot touch
  // any other speculator/session.
  const costOpenByCorrelation = new Set();

  // ... rest of factory ...

  function _maybeRecordTerminal(correlationId, cacheKey, terminal, opts = {}) {
    if (costOpenByCorrelation.has(correlationId)) {
      costOpenByCorrelation.delete(correlationId);     // idempotency: first terminal wins
      costTracker.recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts);
      if (opts.reason) {
        // Direct logger.info — NOT recordOutcome (see Pivot 11.10 for telemetry rationale).
        logger?.info?.('voice_latency.speculative_terminal_reason', {
          correlationId, terminal, reason: opts.reason, cacheKey, sessionId,
        });
      }
    } else {
      // Either pre-text abort OR prior terminal already closed the ledger.
      // Both legitimate; direct logger.info for telemetry.
      logger?.info?.('voice_latency.speculative_terminal_skipped', {
        correlationId, terminal_attempted: terminal, reason: opts.reason ?? null,
        cacheKey, sessionId,
      });
    }
  }

  // ... _speculate() and other methods (unchanged contract from v6-v7) ...

  function shutdown() {
    // existing: abort all in-flight controllers
    for (const controller of pendingControllers) {
      try { controller.abort(); } catch (_) { /* swallow */ }
    }
    pendingControllers.clear();
    pendingByCorrelation.clear();

    // NEW v8: sweep this instance's costOpenByCorrelation. Routes through
    // _maybeRecordTerminal which uses the SAME instance's costTracker.
    // No cross-session contamination possible because both the Set and
    // _maybeRecordTerminal are closed over THIS createSpeculator scope.
    const orphans = Array.from(costOpenByCorrelation);  // snapshot before iteration
    for (const correlationId of orphans) {
      // cacheKey may be derivable from pendingByCorrelation (already cleared above);
      // when missing, pass null — sweep is for cost accounting only, not cache lookup.
      _maybeRecordTerminal(correlationId, /*cacheKey=*/null, 'cancelled', {
        reason: 'speculator_shutdown',
      });
    }
    // costOpenByCorrelation is now empty (each _maybeRecordTerminal call deletes its entry).

    cache.pruneForSession(sessionId);
  }

  return { onSnapshotPatch, onToolUseStreamed, onLoopComplete, abortBySlot, shutdown };
}
```

**Verification: every shutdown sweep can ONLY touch its own instance's `costTracker`** because both `costOpenByCorrelation` and the `_maybeRecordTerminal` it calls are captured in the same closure. Codex's cross-session failure trace is structurally impossible.

**Snapshot-before-iteration:** `Array.from(costOpenByCorrelation)` BEFORE the loop avoids the "modify-during-iteration" hazard when `_maybeRecordTerminal` deletes from the Set. Standard JS pattern; clean.

**`pendingByCorrelation.clear()` happens BEFORE the sweep:** the sweep's `cacheKey` is `null` (diagnostic-only — the cache pruning happens at the end via `cache.pruneForSession`). The `_maybeRecordTerminal` signature already accepts `cacheKey: string | null`.

### Pivot 11.10 — Telemetry outcomes use direct `logger.info`, not `recordOutcome()` (closes Codex I-v7.1)

**Problem identified by Codex:** v7's code snippets called `recordOutcome(correlationId, 'voice_latency.speculative_terminal_reason', ...)`. `recordOutcome()` in `voice-latency-telemetry.js:192-197` validates against `SERVER_OUTCOMES ∪ IOS_OUTCOMES` (`:118`). Neither new outcome string is in the enum, so v7's calls would be silently dropped after logging `voice_latency.unknown_outcome`. The production gates that depend on these strings would have no data.

**v8 design — direct `logger.info` instead of `recordOutcome()`:**

The two new telemetry events are NOT outcomes (they don't terminate a correlation-id's lifecycle for the cost tracker — that's `recordElevenLabsSpeculativeTerminal`). They're observability events. Direct `logger.info` is the right channel:

```js
// In _maybeRecordTerminal (Pivot 11.9):
if (opts.reason) {
  logger?.info?.('voice_latency.speculative_terminal_reason', {
    correlationId, terminal, reason: opts.reason, cacheKey, sessionId,
  });
}

// In the else branch:
logger?.info?.('voice_latency.speculative_terminal_skipped', {
  correlationId, terminal_attempted: terminal, reason: opts.reason ?? null,
  cacheKey, sessionId,
});
```

These appear in CloudWatch as top-level event-name rows (same shape as `voice_latency.fast_path_complete`, `stage6_live_extraction`, etc. — there are dozens of `voice_latency.*` direct-logger emissions already in the codebase that don't go through `recordOutcome`).

`SERVER_OUTCOMES` remains UNCHANGED. The two new events are NOT outcomes — they're freestanding observability emissions and dashboard queries filter on `event` field directly.

Production gates updated in §D below to query the direct-logger event names.

### Pivot 11.11 — `_maybeRecordTerminal` documentation: dual dedup gates (closes Claude O-v7.1)

**v8 documentation addition to `_speculate()`** (Claude's minor observation from round 7):

```js
function _speculate({ field, circuit, boardId, value, confidence, turnId }) {
  // Dedup gate #1 — cachePeek before any work.
  if (cachePeek(cacheKey)) {
    perTurnCount -= 1;
    return;
  }

  // ... pendingFastTtsSlots skip check (Pivot 9 from v3-v4) ...

  const correlationId = mintCorrelationId(sessionId, 'loaded_barrel');
  const controller = new AbortController();

  pendingControllers.add(controller);
  pendingByCorrelation.set(correlationId, { slot: { field, circuit, boardId }, controller, cacheKey });
  cacheSet({ cacheKey, ..., correlationId, promise, resolvePromise, controller });

  // ... _resolveApiKey + clientFactory + controller.signal.aborted guard ...

  // Dedup gate #2 — recordElevenLabsSpeculativeStarted returns false on duplicate
  // correlation id (defensive against logic-error double-Start). Pre-text dedup.
  // Note: this is BELT for the dedup; cachePeek (gate #1) is the braces.
  if (!costTracker.recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)) {
    pendingControllers.delete(controller);
    pendingByCorrelation.delete(correlationId);
    resolvePromise(null);
    cache.delete(cacheKey);
    return;  // Ledger NEVER opened. Set NOT populated. No invariant impact.
  }

  // LEDGER OPEN. Add to durable instance-Set.
  costOpenByCorrelation.add(correlationId);

  // ... client.synth() ...
}
```

The two-line comment block above gate #2 makes the dedup-layering explicit for the executor.

---

## §B — Updated files (v8 deltas vs v7)

| File | v8 change |
|---|---|
| `src/extraction/loaded-barrel-speculator.js` | MOVE `costOpenByCorrelation` declaration INSIDE `createSpeculator()` closure; update `_maybeRecordTerminal` to use `logger.info` instead of `recordOutcome`; add snapshot-before-iteration in shutdown sweep; add Pivot 11.11 comment block |
| `src/extraction/voice-latency-telemetry.js` | NO CHANGES — `SERVER_OUTCOMES` enum unchanged; new events emit via direct logger |

---

## §C — Updated tests (v8 deltas)

- `src/__tests__/loaded-barrel-speculator-cost-integrity.test.js` (UPDATED from v7):
  - **NEW critical case:** "cross-session shutdown isolation" — instantiate TWO `createSpeculator()` instances (session A + session B); call `Started` on each; call `shutdown()` on A; assert B's `costTracker` is UNCHANGED and B's `costOpenByCorrelation` still contains B's correlation id. Asserts the scope-correction.
  - **NEW case:** "shutdown snapshot-before-iteration" — register N=5 in-flight speculations; call `shutdown()`; assert all 5 emit `voice_latency.speculative_terminal_reason` with `reason: 'speculator_shutdown'`; assert `costOpenByCorrelation.size === 0` post-sweep.
  - Remaining cases from v7 unchanged.
- `src/__tests__/loaded-barrel-speculator-shutdown-sweep.test.js` (from v7) is folded into the cost-integrity suite; deleted as separate file.

---

## §D — Verification gate deltas (vs v7)

| Gate | v8 delta |
|---|---|
| **G0** | UPDATED query: dashboards filter on event-name `voice_latency.speculative_terminal_reason` or `voice_latency.speculative_terminal_skipped` directly (NOT through the `recordOutcome` outcome field). CloudWatch Insights example:
```
filter event = "voice_latency.speculative_terminal_reason"
| stats count() by reason
``` |
| **G2.unit** | New required case in cost-integrity suite: cross-session shutdown isolation. |

---

## §E — Things NOT to break (v8 deltas vs v7)

28. **`SERVER_OUTCOMES` and `IOS_OUTCOMES` enums in `voice-latency-telemetry.js`** — UNCHANGED. v8 adds zero entries; new events use direct logger.info path instead.
29. **`recordOutcome()` validator behaviour** — unchanged. No new outcomes to register.
30. **`createSpeculator()` factory signature** — unchanged. New `costOpenByCorrelation` is internal state, not exposed.

---

## §F — Cost-integrity correctness contract (v8 final)

All paths from PLAN_v7 §F UNCHANGED. The structural correctness contract is preserved; the only fix is making the scope-correction physical-truth in the code.

Additional cross-session invariant added:
- **Session A's shutdown cannot affect Session B's cost ledger.** Verified by closure scoping: `costOpenByCorrelation` allocated inside `createSpeculator()` is unreachable from any other instance's `shutdown()`.

---

## §G — Revision history

- **v1-v6** — see prior revisions.
- **v7** — Pivot 11.6 (durable Set), Pivot 8.4 (fastPathCorrelationIdByTurn lifecycle), Pivot 11.7 (signature), Pivot 11.8 (test-only invariant). Closed Codex round-6 B-v6.1.
- **v8** — Pivot 11.9 (move Set INSIDE createSpeculator closure — closes Codex round-7 B-v7.1 scope contradiction), Pivot 11.10 (direct logger.info for new telemetry events — closes Codex round-7 I-v7.1), Pivot 11.11 (documentation of dual dedup gates per Claude O-v7.1). Target: zero BLOCKERs from both reviewers.

---

## §H — Open questions resolved in v8

- v7's "speculator-local" wording is now backed by physical-truth code scope.
- v7's `recordOutcome` calls for new events are now direct `logger.info` — no enum surgery needed.
- Cross-session shutdown isolation is asserted by test.
