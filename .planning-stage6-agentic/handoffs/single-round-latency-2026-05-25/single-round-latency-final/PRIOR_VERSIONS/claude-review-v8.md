# Claude Plan-agent review — PLAN v8 (round 8)

**Date:** 2026-05-25
**Reviewer:** Claude (plan-agent)
**Verdict:** 0 BLOCKERs, 0 IMPORTANTs, 1 NIT. **SHIP.**

## Round-7 closure verification

### B-v7.1 — `costOpenByCorrelation` scope contradiction → CLOSED by Pivot 11.9

**Conceded:** I missed this in round 7. Codex was right. v7's prose said "speculator-local" but the code block at PLAN_v7.md:28-40 declared the Set with prose framing "NEW module-level state" — a contradiction load-bearing for shutdown correctness. With `createSpeculator()` capturing per-session `costTracker` (verified at `loaded-barrel-speculator.js:115-122`), a global Set would let Session A's shutdown sweep close Session B's correlation ids against A's `costTracker`. My round-7 SHIP verdict was wrong on this specific point.

v8 Pivot 11.9 places the Set INSIDE the `createSpeculator()` closure, alongside `pendingControllers` (current line 130) and `pendingByCorrelation` (v4 Pivot 11). Verified:

- **Cross-session isolation:** Yes. Both `costOpenByCorrelation` AND `_maybeRecordTerminal` are captured in the same `createSpeculator()` closure. There is no path by which one instance's `shutdown()` can reach another instance's Set or another instance's `costTracker`. Codex's failure trace (Session A sweeps B's correlation against A's tracker) is structurally impossible.
- **Snapshot-before-iteration:** `Array.from(costOpenByCorrelation)` at PLAN_v8.md:76 BEFORE the for-loop is the correct JS idiom. `_maybeRecordTerminal` mutates the Set (via `Set.delete`) inside the loop body, which would skip entries if iterated live. Snapshot prevents this. Clean.
- **Shutdown sweep correctness:** The sweep uses the SAME `_maybeRecordTerminal` function, which uses the SAME `costTracker` closure-captured at factory construction. Closes only THIS instance's ledger.

### I-v7.1 — New telemetry outcomes not in `SERVER_OUTCOMES` → CLOSED by Pivot 11.10

Verified at `voice-latency-telemetry.js:118` that `ALL_OUTCOMES = new Set([...SERVER_OUTCOMES, ...IOS_OUTCOMES])` and at `:194` that `recordOutcome` drops unknown outcomes after logging `voice_latency.unknown_outcome`. Neither `speculative_terminal_reason` nor `speculative_terminal_skipped` is in `SERVER_OUTCOMES` (lines 66-108). v7's calls would have been silently dropped — Codex's I-v7.1 was sound.

v8's switch to direct `logger.info('voice_latency.speculative_terminal_reason', {...})` is correct:

- These events are NOT correlation-id outcomes (they don't terminate a lifecycle for telemetry waterfall purposes — `recordElevenLabsSpeculativeTerminal` already does that). They're freestanding observability events.
- The `voice_latency.*` direct-logger pattern is already established in the codebase (e.g., `voice-latency-telemetry.js:148` emits `voice_latency.unknown_source`, `:165` emits `voice_latency.unknown_hop`, `:173` emits `voice_latency.span` — none through `recordOutcome`).
- `SERVER_OUTCOMES` remaining UNCHANGED is the right call. The enum is a controlled vocabulary for the `voice_latency.outcome` event-name field. New observability events get their own event names.
- Production gate query (PLAN_v8.md:196-200) correctly filters on `event = "voice_latency.speculative_terminal_reason"` directly, matching the new emission shape.

### O-v7.1 — Dual-dedup-gate documentation → CLOSED by Pivot 11.11

The two-comment block in Pivot 11.11 makes the dedup layering explicit: gate #1 is `cachePeek` (the braces), gate #2 is `recordElevenLabsSpeculativeStarted` returning false (the belt). The "Ledger NEVER opened. Set NOT populated. No invariant impact." comment is exactly what the executor needs to avoid a defensive-but-wrong add-to-Set on the false-return branch. Helpful.

## Specifically-requested checks

### Q1: Does `loaded-barrel-speculator.js:115-122` accept per-session `costTracker` per instance?

VERIFIED at lines 115-124:
```
export function createSpeculator({
  sessionId,
  apiKey,
  costTracker,
  ...
}) {
  if (!sessionId) throw new TypeError('createSpeculator: sessionId required');
  if (!costTracker) throw new TypeError('createSpeculator: costTracker required');
```

The `costTracker` is a constructor param, validated as required. Each call to `createSpeculator()` closes over its own tracker. JSDoc at line 100-102 confirms: "every speculative Started + Terminal on it" — implying per-instance binding. Codex's B-v7.1 claim is load-bearing and correct.

### Q2: Could `pendingByCorrelation.clear()` BEFORE the cost-sweep lose `cacheKey` context?

NO. The v8 sweep at PLAN_v8.md:80 passes `/*cacheKey=*/null`. The cacheKey on the new telemetry events is diagnostic-only — used only for log correlation, not for the cost decision (which uses ONLY `costOpenByCorrelation.has(...)`). Pivot 11.7 from v7 explicitly retired the cacheKey-dependence for the cost path.

However: there is a minor observability degradation. The shutdown-sweep emissions of `speculative_terminal_reason` will have `cacheKey: null` in their meta, while non-shutdown emissions have the actual cacheKey. This is acceptable because (a) `reason: 'speculator_shutdown'` already identifies these events distinctly, (b) `correlationId + sessionId + terminal` are sufficient for forensics, and (c) the cacheKey could be retrieved BEFORE clearing `pendingByCorrelation` if dashboards need it. See NIT N-v8.1 below.

### Q3: Are other module-level Sets in the speculator intentionally global?

VERIFIED: the `cache` from `loaded-barrel-cache.js` (imports at lines 47-57) IS module-level by design. The cache uses `cacheKey` strings that embed `sessionId` (built by `buildCacheKey({sessionId, turnId, boardId, ...})` at line 166-173), so per-session isolation comes from KEY namespacing, not instance scoping. `pruneForSession(sessionId)` (line 545, called in `shutdown()`) is how an instance cleans up its keys from the shared cache.

This is a different model from `costOpenByCorrelation`. The cost-tracker is per-instance (a closure-captured object), so cleanup CANNOT be done by filtering keys — it has to be done by iterating only ids whose tracker matches. Putting the Set in the closure achieves that naturally. The two design choices (shared cache, instance Set) are consistent with their respective downstream contracts.

No other module-level state in the speculator presents the same cross-session hazard. Confirmed by reading lines 1-130 — only the imports and `DEFAULT_OUTPUT_FORMAT`/`parseCircuit`/`defaultClientFactory` are module-scoped, none of which are stateful per-correlation.

## Pivot-by-pivot soundness

| Pivot | Design | Soundness |
|---|---|---|
| 11.9 Set INSIDE createSpeculator | Closure-scoped Set, snapshot-before-iterate, shutdown calls `_maybeRecordTerminal` per id | SOUND. Cross-session contamination structurally impossible. |
| 11.10 Direct `logger.info` for new events | Bypass `recordOutcome`, use event-name field for dashboard filter | SOUND. Matches existing `voice_latency.*` direct-logger pattern in the file. |
| 11.11 Dedup-gate comment block | Two-line explanation above gate #2 | SOUND. Helpful executor signal. |

## NIT (not blocking)

### N-v8.1: Shutdown sweep loses `cacheKey` from log meta

Minor. The current PLAN_v8.md:80 passes `cacheKey: null` to the shutdown sweep because `pendingByCorrelation.clear()` (line 70) ran first. If forensic dashboards correlate `speculative_terminal_reason` events back to cache slots, the shutdown rows will have a gap.

Trivial fix (not required for ship): swap the ordering — snapshot `pendingByCorrelation` to a `Map<correlationId, cacheKey>` BEFORE clearing, then look up the cacheKey per sweep iteration. Or move the `pendingByCorrelation.clear()` AFTER the sweep loop. Either preserves the cacheKey context. Executor can decide; not a planning concern.

## Recommended verdict

**ZERO BLOCKERS. SHIP v8.**

v8 closes Codex round-7 B-v7.1 (scope contradiction) and I-v7.1 (telemetry channel) with surgical edits. The closure scoping of `costOpenByCorrelation` makes cross-session contamination structurally impossible — not just "improbable in practice." The direct-logger emission for the two new events matches existing codebase patterns and avoids unnecessary enum surgery. Pivot 11.11's dedup-gate documentation is a helpful executor signal that costs nothing.

N-v8.1 is a minor observability polish and not a ship gate.

After 8 rounds, this plan has converged. I am confident in SHIP.
