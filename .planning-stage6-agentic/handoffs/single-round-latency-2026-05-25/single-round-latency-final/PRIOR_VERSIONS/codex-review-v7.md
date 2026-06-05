# Codex CLI review — PLAN v7 (round 7)

**Date:** 2026-05-25
**Reviewer:** Codex CLI
**Verdict:** 1 BLOCKER, 1 IMPORTANT — **DO NOT SHIP as written.**

v7 closes the round-6 cache-entry lifetime bug in concept: a durable ledger-open structure keyed by `correlationId` is the right fix, and `_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)` with `cacheKey` diagnostic-only closes the missing `cacheKeyForCorrelation` helper.

I do **not** concur with SHIP as written because Pivot 11.6 has a scope contradiction that is load-bearing for shutdown correctness.

## BLOCKERs

### B-v7.1: `costOpenByCorrelation` must be speculator-instance scoped, not module scoped

**Where:** `PLAN_v7.md:24-40`, `PLAN_v7.md:95`; `src/extraction/loaded-barrel-speculator.js:115-130`, `src/extraction/loaded-barrel-speculator.js:536-545`

v7 first says the ledger-open state is "speculator-local", but the code block declares:

```js
const costOpenByCorrelation = new Set();
```

as "module-level state" (`PLAN_v7.md:28-40`). That is not safe with the current speculator shape. `createSpeculator()` captures a session-specific `costTracker` (`loaded-barrel-speculator.js:115-122`) and has per-instance `pendingControllers` (`:126-130`) plus per-instance `shutdown()` (`:536-545`). If the Set is file-scope/global, one speculator's shutdown sweep can see correlation ids opened by another session/turn and record them as `cancelled` against the wrong `costTracker`.

Concrete failure:

1. Session A and session B both have post-text speculations in flight.
2. Both correlation ids are in the global `costOpenByCorrelation`.
3. Session A closes; A's `shutdown()` aborts only A's controllers, then sweeps the global Set.
4. The sweep records B's correlation id as `cancelled` on A's cost tracker and deletes it from the global Set.
5. B's synth later completes/fails; B's `_maybeRecordTerminal()` sees the id missing and emits skipped telemetry.
6. B's cost tracker still has `charsStarted` with no matching terminal. The v6 invariant is broken again.

This also creates the memory-orphan shape the review request asks about if the sweep records terminals directly without deleting Set entries. The sweep should either call `_maybeRecordTerminal(...)` or explicitly delete each id it closes.

**Required fix:** put `costOpenByCorrelation` inside `createSpeculator()`, next to the existing `pendingControllers` and v4 `pendingByCorrelation`, so shutdown only sweeps the instance it owns. If a module-level structure is required, it must be a Map carrying ownership (`sessionId`, `costTracker`, maybe `cacheKey`) and shutdown must filter by owner; that is more complex than needed.

With that scope correction, Pivot 11.6 closes B-v6.1.

## IMPORTANTs

### I-v7.1: v7's new terminal telemetry events are not valid `recordOutcome()` outcomes yet

**Where:** `PLAN_v7.md:65-86`, `PLAN_v7.md:216`; `src/extraction/voice-latency-telemetry.js:66-118`, `src/extraction/voice-latency-telemetry.js:192-197`

The `_maybeRecordTerminal()` snippet calls:

```js
recordOutcome(correlationId, 'voice_latency.speculative_terminal_reason', ...)
recordOutcome(correlationId, 'voice_latency.speculative_terminal_skipped', ...)
```

Current `recordOutcome()` drops unknown outcomes after logging `voice_latency.unknown_outcome`. `SERVER_OUTCOMES` does not include either of these strings, so the v7 production gate on `voice_latency.speculative_terminal_skipped` rate would have no usable data unless the enum/logging path is updated.

Fix by either adding explicit allowed outcomes (preferably without the `voice_latency.` prefix if staying inside `voice_latency.outcome`) or by emitting these as direct logger events outside `recordOutcome()`. Cost accounting is unaffected, so this is IMPORTANT rather than BLOCKER.

## Requested Pivot Checks

### Pivot 11.6 — durable ledger-open Set

The cache-lifetime independence is correct **if** the Set is scoped to the speculator instance. It survives `markSuperseded()`, TTL, `invalidateBySlot()`, and `pruneForSession()` deleting cache entries before deferred handlers run. Idempotency under `abortBySlot()` plus deferred `.catch()` is sound because `Set.has()` / `Set.delete()` is synchronous in one event-loop turn.

Shutdown racing with a same-instance `markReady()` is not a blocker: whichever synchronous path reaches `_maybeRecordTerminal()` first wins, and the other skips. The blocker is cross-instance/global sweep, not same-promise interleaving.

### Pivot 8.4 — `fastPathCorrelationIdByTurn`

The lifecycle is now pinned well enough: allocate, populate once after turn id mint, consume at finalizer arm, clear in `finally`, and let session teardown GC the whole session object. Implementation note: current `runLiveMode()` receives `transcriptText`, `regexResults`, and `options`, not the raw WS message, so the executor should thread `regex_fast_correlation_id` from `handleTranscript()` into `runShadowHarness(..., options)` before populating the map.

### Pivot 11.7 — `_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)`

Closed. Passing `cacheKey` from the local `.then()`/`.catch()` closures and from `pendingByCorrelation` is the right replacement for the nonexistent `cacheKeyForCorrelation()` helper. The cost decision must remain entirely independent of `cacheKey`.

### Pivot 11.8 — test-only invariant

Appropriate. The invariant belongs in focused tests and deployment checks, not the production cost-tracker hot path.

## §F Coverage

The correctness table covers the important classes, but it is not literally exhaustive. The executor should treat these rows as covered aliases:

- `invalidateBySlot()`, `pruneSessionUnboardedEntries()`, `pruneMismatchedBoardEntries()`, per-session cap eviction, and global cap eviction are all post-text cache termination/abort paths.
- no API key and `clientFactory` failure are pre-text failures.
- `cachePeek()` duplicate and `recordElevenLabsSpeculativeStarted()` returning false are separate no-ledger paths.
- ready-entry TTL after successful `markReady()` does not owe another terminal because the completed terminal already fired.

No new table row is required for shipment once the Set scope is corrected, but these should be represented in the regression suite names or comments so future reviewers do not have to infer coverage.

## Recommended Verdict

**DO NOT SHIP v7 as written.**

Make `costOpenByCorrelation` explicitly instance-scoped inside `createSpeculator()` and ensure the shutdown sweep deletes entries via `_maybeRecordTerminal()` or equivalent. Add the missing telemetry outcome/logging update. After those surgical edits, I would expect a zero-blocker v8.
