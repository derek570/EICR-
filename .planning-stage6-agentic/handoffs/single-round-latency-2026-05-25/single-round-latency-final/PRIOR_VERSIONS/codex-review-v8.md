# Codex CLI review — PLAN v8 (round 8)

**Date:** 2026-05-25  
**Reviewer:** Codex CLI  
**Verdict:** 0 BLOCKERs, 0 IMPORTANTs, 1 NIT — **SHIP.**

v8 closes both round-7 findings. Pivot 11.9 makes the durable ledger-open Set physically instance-scoped, which removes the cross-session shutdown failure I blocked on in v7. Pivot 11.10 moves the two new terminal-observability rows out of `recordOutcome()`, which avoids the `SERVER_OUTCOMES` validator drop. I do not see a new blocker.

## BLOCKERs

None.

## IMPORTANTs

None.

## Round-7 Closure

### B-v7.1 — `costOpenByCorrelation` scope contradiction: CLOSED

v8 puts `costOpenByCorrelation` inside `createSpeculator()` (`PLAN_v8.md:24-38`), next to the other per-instance state. That matches the live code shape: `createSpeculator()` receives a session-local `costTracker` (`src/extraction/loaded-barrel-speculator.js:115-124`), owns per-instance `pendingControllers` (`:126-130`), and owns the `shutdown()` closure (`:536-548`).

With the Set and `_maybeRecordTerminal()` both captured by the same factory invocation, Session A's shutdown cannot iterate Session B's ledger-open ids and cannot write a terminal event into Session A's `costTracker` for Session B's work. The v7 failure trace is structurally impossible under the v8 scope.

The shutdown sweep also routes through `_maybeRecordTerminal()` (`PLAN_v8.md:76-82`), so the same function that deletes from the Set is the function that records the terminal against the closure-captured `costTracker`. That preserves idempotency: first terminal wins, later terminal attempts become skipped telemetry only.

Snapshot-before-iteration is correct. `Array.from(costOpenByCorrelation)` before the loop is a clean way to avoid iterator/mutation surprises while `_maybeRecordTerminal()` deletes each id.

Clearing `pendingByCorrelation` before the sweep only loses `cacheKey` context for the shutdown-reason log. It does not affect cost correctness because `cacheKey` is diagnostic-only in the v7/v8 contract.

### I-v7.1 — New telemetry outcomes not registered: CLOSED

The live validator confirms the v7 issue: `SERVER_OUTCOMES` does not contain these two strings (`src/extraction/voice-latency-telemetry.js:66-108`), and `recordOutcome()` drops unknown outcomes after warning (`:192-197`).

v8 no longer sends these strings through `recordOutcome()` (`PLAN_v8.md:107-120`). Direct `logger.info('voice_latency.speculative_terminal_reason', ...)` and `logger.info('voice_latency.speculative_terminal_skipped', ...)` are appropriate because these rows are observability events, not terminal outcomes in the `voice_latency.outcome` vocabulary. Existing direct-event precedent includes `voice_latency.fast_path_complete` (`src/routes/voice-latency-fast-tts.js:123`) and `stage6_live_extraction` (`src/extraction/stage6-shadow-harness.js:625`).

The production data will be queryable by event name, with the field-name nit below.

## Requested Pivot Checks

### Pivot 11.9 — instance-local cost Set

Sound. Cross-session contamination is structurally impossible because both the Set and the terminal recorder are closure-local to one `createSpeculator()` instance. Shutdown uses this instance's `_maybeRecordTerminal()`, which uses this instance's `costTracker`.

### Pivot 11.10 — direct logger telemetry

Sound. This closes the enum-validator problem without expanding `SERVER_OUTCOMES` for rows that are not outcomes. Production dashboards can query the emitted event name directly; they should use the repo's actual logger field name (`message`) rather than the plan's sample `event` field.

### Pivot 11.11 — dual-dedup-gate documentation

Helpful. The comment makes the two dedup layers explicit:

- `cachePeek(cacheKey)` is the normal duplicate-entry gate before work starts.
- `recordElevenLabsSpeculativeStarted(...) === false` is the defensive duplicate-Started gate, and the plan correctly says the ledger was never opened and the Set must not be populated on that branch.

That is the right executor signal for preserving the cost invariant.

## NITs

### N-v8.1: CloudWatch query example should filter `message`, not `event`

`PLAN_v8.md:124` and `PLAN_v8.md:196-200` say dashboards filter on the `event` field:

```sql
filter event = "voice_latency.speculative_terminal_reason"
| stats count() by reason
```

In this repo's production logger, the first argument to `logger.info()` serializes as the JSON `message` field (`src/logger.js:62-65`):

```json
{"timestamp":"...","level":"info","message":"voice_latency.speculative_terminal_reason", ...}
```

So the gate query should be:

```sql
filter message = "voice_latency.speculative_terminal_reason"
| stats count() by reason
```

or, if querying raw `@message`, parse/filter accordingly. This is not a blocker because the direct logger rows are emitted and queryable; the sample field name is the only mismatch.

## Recommended Verdict

**ZERO BLOCKERS. SHIP v8.**

v8 closes Codex B-v7.1 and I-v7.1 with the right surgical changes. The only correction I would make before handing to implementation is the CloudWatch example field name from `event` to `message`.
