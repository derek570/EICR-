# Claude Plan-agent review — PLAN v7 (round 7)

**Date:** 2026-05-25
**Reviewer:** Claude (plan-agent)
**Verdict:** 0 BLOCKERs, 0 IMPORTANTs, 1 minor observation. **SHIP.**

## Round-6 closure verification

### B-v6.1 — Cache-entry guard fails after entry deletion → CLOSED by Pivot 11.6

Verified the codebase reality Codex flagged:
- `loaded-barrel-cache.js:116` confirms `entries.delete(entry.cacheKey)` runs synchronously inside `_terminate()`.
- `_terminate()` is reached by `markSuperseded()` (`:296`), `invalidateBySlot()` (`:309`), `pruneForSession()` (`:374`), TTL fire (`:224-229`), per-session-cap eviction (`:137`), global-cap eviction (`:150`), and slot-prune paths (`:344-365`).
- Speculator's deferred `.catch()` runs from `_onSynthError` (`loaded-barrel-speculator.js:298`) AFTER the cache entry has been deleted by the abort that the cache itself fired (`:107-115`).

Codex's failure trace is reproducible against current code. v7's `costOpenByCorrelation` Set placed at module scope in the speculator is the correct fix: its lifetime is bound to the speculator instance (which only goes away on `shutdown()`), not to the cache entry. The `Set.has()` check at `_maybeRecordTerminal` is the source of truth; the `cacheKey` arg is now purely diagnostic. This structurally closes B-v6.1.

### I-v6.1 — `fastPathCorrelationIdByTurn` plumbing → CLOSED by Pivot 8.4

The 6-step lifecycle (allocation in `active-sessions.js` createSession, population in `runLiveMode` at turnId mint, consumption at `startAudioFinalizer`, cleanup in try/finally, session-teardown via GC, LRU caps) is unambiguous. The cap of 100 turn entries × 8 correlations per turn is conservative and matches the existing `pendingFastTtsSlots` pattern from v3 Pivot 5.

### I-v6.2 — `cacheKeyForCorrelation` helper → CLOSED by Pivot 11.7

Adopting Option (b) — pass `cacheKey` directly — is the simpler design. Verified that the speculator's `.then()`/`.catch()` closures at lines 265 and 297 already capture `cacheKey` locally, and `pendingByCorrelation` (v4 Pivot 11) carries `cacheKey` in its value tuple so `abortBySlot()` has it too. No new cache exports, no reverse-index Map. Cleaner contract.

### N-v6.1 — Cost invariant placement → CLOSED by Pivot 11.8

Test-only assertion in `src/__tests__/test-helpers/cost-invariant.js` consumed from `afterEach` is the correct placement. Avoids hot-path overhead in production.

## Specifically-requested checks

### Are there remaining races where `costOpenByCorrelation` could leak (memory orphan)?

I walked the post-Started exit paths and could not find a leak under the v7 design:

1. **Happy path (synth completes):** `markReady` flow → `_maybeRecordTerminal` → `Set.delete`. Closed.
2. **Post-text synth error (network, 401, etc.):** `_onSynthError` → `_maybeRecordTerminal('failed' or 'cancelled')` → `Set.delete`. Closed.
3. **Post-text abort via cache `_terminate`:** controller aborted, `.catch()` runs, `_onSynthError` → terminal. Closed.
4. **Post-text `abortBySlot` (v4 Pivot 11):** terminal('cancelled') called inline → `Set.delete`. The eventual `.catch()` from the aborted controller sees Set already drained → emits `speculative_terminal_skipped` (correct). No double-record, no leak.
5. **Pre-text abort (controller.signal.aborted before Started):** Set never added → nothing to leak. The `_maybeRecordTerminal` from any later handler emits skipped — correct.
6. **Speculator `shutdown()`:** v7 explicitly adds a sweep loop AFTER `pendingControllers` abort, iterating `costOpenByCorrelation` and emitting terminal('cancelled', reason='speculator_shutdown'). This is the critical addition — without it, the WS-close path would leak whatever started speculations hadn't yet routed through their `.catch()`. Pivot 11.6 §"Cleanup on shutdown" addresses this.
7. **Session crash / process exit:** The Set is in-memory only. Process exit drops it along with everything else — no persistent leak. Cost-tracker state is also in-memory per session, so the invariant is meaningful within a session's lifetime and resets cleanly on restart. Acceptable.
8. **Synth promise never resolves (vendor SDK pathological hang):** The `pendingControllers` Set + the v5 hang-watchdog from earlier pivots ensure the controller will be aborted eventually; the abort fires `.catch()` → terminal → Set.delete. No leak.

**One edge case worth noting (not a blocker):** if `recordElevenLabsSpeculativeStarted` throws (unexpected — currently it only returns boolean), Pivot 11.6's code would add to the Set only on `true` return. That is correct. The `try/catch` discipline around the Started call should be preserved by the executor.

### Idempotency under concurrent abortBySlot + deferred .catch

The contract is: whichever caller reaches `_maybeRecordTerminal` first calls `costTracker.recordElevenLabsSpeculativeTerminal(...)`; that caller also drains the Set. The second caller sees `!Set.has(correlationId)` and emits `speculative_terminal_skipped`. Because JavaScript is single-threaded and `Set.has()` followed by `Set.delete()` runs atomically within one synchronous block, there is no interleaving hazard. The cost-tracker terminal record happens BEFORE the next microtask can run, so even back-to-back `_maybeRecordTerminal` calls from two `.then`/`.catch` handlers in the same microtask flush will resolve correctly: first one wins, second sees an empty Set.

### Shutdown sweep correctness

The v7 shutdown ordering is:
1. Abort all `pendingControllers` (existing behavior, line 537-544).
2. NEW: iterate `costOpenByCorrelation` — for each remaining entry, emit terminal('cancelled', reason='speculator_shutdown').
3. `pruneForSession(sessionId)` (existing, line 545).

Question: do the controller aborts in step 1 synchronously route through `_onSynthError` → `_maybeRecordTerminal`? No — `controller.abort()` rejects the synth promise but the `.catch()` handler is microtask-scheduled. So when step 2 runs, the Set is still populated with everything that hadn't yet finished synth. Step 2 closes those entries. Then when the microtasks run, the `.catch()` handlers will call `_maybeRecordTerminal`, see empty Set, and emit skipped events. Correct double-prevention via the same Set idempotency.

The sweep is sound.

### Cost invariant under pruneForSession

v7 explicitly states `pruneForSession` does NOT touch `costOpenByCorrelation`. The Set entries persist until controllers fire `.catch()`. Since `pruneForSession` calls `_terminate()` which calls `controller.abort()`, every pruned pending entry's `.catch()` will eventually fire and close the ledger. Verified by tracing `_terminate` lines 107-115. Sound.

## Pivot-by-pivot soundness assessment

| Pivot | Design | Soundness |
|---|---|---|
| 11.6 Durable `costOpenByCorrelation` Set | Module-level Set in speculator, add on Started success, delete on first terminal, shutdown sweep | SOUND. Cache-lifetime independence verified. |
| 8.4 `fastPathCorrelationIdByTurn` lifecycle | Allocate in createSession, populate at runLiveMode turnId mint, consume in finalizer, cleanup in try/finally | SOUND. Mirrors `pendingFastTtsSlots` pattern. |
| 11.7 Signature change | `_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)` with cacheKey diagnostic-only | SOUND. No new cache export needed. |
| 11.8 Invariant in test code | `assertCostInvariant` helper, `afterEach` consumption | SOUND. Production hot-path stays clean. |

## Minor observation (not blocking)

### O-v7.1: Document the "Started returned false" path in Pivot 11.6

The Pivot 11.6 code snippet shows that if `recordElevenLabsSpeculativeStarted(...)` returns false (dedupe case from `cost-tracker.js`), the function early-returns and the Set is NOT populated. That's correct. But the §F cost-integrity correctness contract table doesn't explicitly call out the dedupe row. Verified the dedup row in the table at line 238: "Pre-text dedup (Started returned false) | unchanged | unchanged | YES". This is fine but the row sits under "Pre-text" — semantically the dedup check actually happens at the very start of `_speculate()` (line 174-180 in the current speculator, via `cachePeek`). The v7 move of `Started` to the text-sent boundary means there's a SECOND dedup gate (the Started call itself) just before `client.synth()`. Both early-returns short-circuit correctly without polluting the Set. Not worth blocking, but the executor might benefit from a one-line comment in the code explaining the two dedup layers.

## Things I verified in the codebase (v7 deltas)

| Claim | Status |
|---|---|
| `_terminate()` synchronously deletes cache entry (line 116) before any deferred handler | VERIFIED |
| `markSuperseded`, `pruneForSession`, `invalidateBySlot`, TTL, both eviction paths all route through `_terminate` | VERIFIED |
| `pendingControllers` Set already exists in speculator (line 130) for shutdown sweep | VERIFIED |
| `shutdown()` exists at line 536-548 and currently aborts controllers + prunes; v7's added sweep slots in cleanly | VERIFIED |
| `active-sessions.js` exposes `activeSessions` Map (line 15) — the v6 plan's "createSession site" refers to the WS-handler insertion in `sonnet-stream.js`, not `active-sessions.js` itself | VERIFIED — minor wording note: §B says "active-sessions.js" but the actual `session = {...}` allocation lives in `sonnet-stream.js`. The executor should know to populate `fastPathCorrelationIdByTurn` wherever `pendingFastTtsSlots` is allocated (v3 Pivot 5). Not blocking. |
| `pendingByCorrelation` and `abortBySlot` are introduced by v4 Pivot 11 (not yet in code) — v7 correctly references them as established by prior pivots | VERIFIED |
| No `cacheKeyForCorrelation` export exists in `loaded-barrel-cache.js` — v7's retirement of the helper is the right call | VERIFIED |

## Recommended verdict

**ZERO BLOCKERS. SHIP v7.**

v7 is the convergence draft. Pivot 11.6's durable Set design is the correct response to Codex's B-v6.1 — it cleanly decouples cost-ledger lifecycle from cache-entry lifecycle. The shutdown sweep + idempotent Set.delete guarantee that every Started call gets exactly one Terminal call, including under concurrent abort races and cache deletion races.

The two prior IMPORTANTs (fastPath plumbing + signature) are both pinned with full implementation detail. The NIT on invariant placement is resolved by test-only assertion.

I find no remaining BLOCKER, IMPORTANT, or significant NIT. Pending Codex round-7 concurrence, this plan is shippable.
