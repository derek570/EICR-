---
phase: 02-write-tools
plan: 02-06
subsystem: stage6-agentic-extraction
tags: [shadow-mode, tool-loop, comparator, bundler-integration, e2e-tests, phase-gate]
dependency_graph:
  requires:
    - 02-01 (snapshot atoms)
    - 02-02 (dispatcher barrel + validators + per-turn-writes)
    - 02-03 (circuit dispatchers)
    - 02-04 (observation dispatchers)
    - 02-05 (event bundler + BUNDLER_PHASE)
    - phase-01 runToolLoop + mockStream helper
  provides:
    - runShadowHarness (Phase 2 rewire driving real multi-round loop)
    - projectSlots + compareSlots (pure comparator)
    - stage6_divergence log row schema (phase:2)
    - Phase 2 REVIEW.md scaffold
  affects:
    - none (shadow-only; iOS wire unchanged; legacy path unchanged)
tech_stack:
  added: []
  patterns:
    - pure-function-comparator (zero imports, zero side effects)
    - factory-scoped-accumulator (createPerTurnWrites per turn)
    - divergence-log-per-turn (not per-call; single row is the unit of analysis)
key_files:
  created:
    - src/extraction/stage6-slot-comparator.js
    - src/__tests__/stage6-shadow-comparator.test.js
    - src/__tests__/stage6-tool-loop-e2e.test.js
    - src/__tests__/stage6-same-turn-correction.test.js
    - .planning-stage6-agentic/phases/02-write-tools/REVIEW.md
  modified:
    - src/extraction/stage6-shadow-harness.js (rewired Phase 1 canned-replay → Phase 2 real loop)
    - src/__tests__/stage6-shadow-harness.test.js (rewritten for Phase 2 behavior)
decisions:
  - Observation UUIDs stripped in comparator projection — legacy + tool paths generate separate UUIDs; comparing would always diverge.
  - shadow_cost_usd is null for Phase 2 (runToolLoop has no usage accumulator); Phase 7 will replace null with real tracking.
  - Live mode throws (not silent legacy fallback) — operators can't accidentally route live traffic through an untested path.
  - REVIEW.md is a dual-reviewer gate scaffold (Claude + Codex), blocking Phase 3 planning until both sign off.
metrics:
  duration_minutes: 180
  completed_date: 2026-04-21
  tests_added: 24
  tests_total_stage6: 183
  tests_total_backend: 543
---

# Phase 2 Plan 02-06: Shadow Integration Summary

End-to-end rewire of the Phase 1 shadow harness to drive the REAL Phase 2 multi-round tool loop (not canned replay) through dispatchers → bundler → comparator → divergence log, gated behind `SONNET_TOOL_CALLS=shadow` with legacy return bytes unchanged. Closes Phase 2.

## What Shipped

### Production code
- **`stage6-slot-comparator.js`** (279 lines): Pure `projectSlots(result)` + `compareSlots(legacy, tool)`. Zero imports, zero side effects. Projects extraction results into `{readings: Map, cleared: Set, observations: Set, circuit_ops: Set, observation_deletions: Set}` and runs set-diff + value-diff with priority-ranked reason codes (`identical` > `value_mismatch` > `dispatcher_strict_mode` > `extra_in_tool` > `observation_set_diff` > `circuit_ops_diff` > `extra_in_legacy`). Observation UUIDs stripped — keyed on `(code, text)` only.
- **`stage6-shadow-harness.js`** (full rewrite): Phase 1 canned-replay harness replaced with Phase 2 real loop. Imports `runToolLoop`, `createWriteDispatcher`, `createPerTurnWrites`, `bundleToolCallsIntoResult`, `BUNDLER_PHASE`, `compareSlots`, `TOOL_SCHEMAS`. On `mode==='shadow'`: runs legacy first, snapshots `turnNum` AFTER legacy await, instantiates fresh `perTurnWrites`, drives `runToolLoop` (wrapped in try/catch — on throw emits `stage6_shadow_error` warn and returns legacy), bundles post-loop into result shape, compares slots, emits single `stage6_divergence` info row per turn, returns LEGACY to iOS. On `mode==='off'`: legacy only, zero client calls, zero log rows. On `mode==='live'`: throws `'not implemented until Phase 7'`.

### Tests added (24 new)
- **`stage6-shadow-comparator.test.js`** (11 tests): all seven reason branches + projection edge cases (null, malformed input, observation UUID independence).
- **`stage6-tool-loop-e2e.test.js`** (3 tests): STT-03 multi-round (2 tool rounds + end_turn = 3 stream calls, rounds=3); SHADOW-OFF idempotency (success criterion #6); MINOR-2 live-mode bypass guard.
- **`stage6-same-turn-correction.test.js`** (2 tests): STT-09 record→record→clear collapse + Map slot isolation guard (clearing volts::1 leaves amps::1 intact).
- **`stage6-shadow-harness.test.js`** (8 tests, rewritten): off/shadow/live modes, turnId offset, legacy-throws, tool-loop-throws (caught), logger-failure-tolerance, divergence-log shape.

### Planning artifact
- **`REVIEW.md` scaffold**: Requirement coverage matrix (13 req IDs mapped to tests), contract reconciliation list (8 items), file manifest (10 production + 11 test files), empty verdict slots for Claude + Codex, action-item section. Blocks Phase 3 planning until both reviewers sign off.

## Contract Reconciliations (plan → reality)

Eight places where the as-planned contract diverged from code reality; each resolved inline with a comment at the code site AND a line in REVIEW.md:

1. **Streaming API**: `session.client.messages.stream` (not `create`).
2. **System cache_control**: Array-of-blocks `[{type:'text', text, cache_control:{type:'ephemeral'}}]`, not a raw string. Matches SDK v3 prompt-caching requirement.
3. **Live mode MUST throw**: `SONNET_TOOL_CALLS=live` raises immediately (not a silent legacy fallback).
4. **Session surface verified**: `session.client` (not `session.anthropic`), `session.systemPrompt` exists, no `session.model` field — model literal `'claude-sonnet-4-6'` duplicated at call site.
5. **shadow_cost_usd: null**: runToolLoop has no usage accumulator in Phase 2; the log field is explicitly null (not omitted) to reserve the schema slot for Phase 7.
6. **BUNDLER_PHASE literal**: Imported from `stage6-event-bundler.js` (actually importable).
7. **turnNum snapshot AFTER legacy await**: `extractFromUtterance` increments `session.turnCount` — reading before the await yielded stale values; reading after matches legacy log attribution.
8. **Observation UUID stripped**: Comparator projection keys observations on `(code, text)` only. Legacy + tool paths each generate UUIDs; preserving them would make every observation comparison diverge.

## Seven Contract Confirmations (harness invariants tested)

The rewired harness preserves seven end-to-end contracts, each exercised by at least one test:

1. **iOS wire unchanged** — `result === legacyResult` (reference equality) on all three modes.
2. **Legacy invoked exactly once per turn** — `extractFromUtterance` called 1x regardless of round count.
3. **Rounds counter matches stream calls** — `rounds === client._callCount` (3 for 2-round scenario).
4. **Single divergence row per turn** — `logger.info` called exactly once with `'stage6_divergence'` tag.
5. **Bundler runs post-loop, once** — `perTurnWrites` bundled after all rounds, not per round.
6. **SHADOW-OFF idempotency** — `mode==='off'` → zero client calls, zero log rows, legacy returned.
7. **Live mode gate** — `mode==='live'` throws before legacy runs; client never touched.

## Deviations from Plan

### Rule-1 fix (auto-fixed during execution)

**[Rule 1 — Bug] Map iteration in `setOnlyIn` helper**
- **Found during:** Task 2 (comparator unit tests)
- **Issue:** Initial implementation used `for (const k of a)` on a Map, which yields `[key, value]` entries (the default Map iterator) — not keys. `b.has(entry)` then always returned false, causing spurious "readings only in legacy" diagnoses.
- **Fix:** Explicit `const keys = typeof a.keys === 'function' ? a.keys() : a;` to normalize Set and Map iteration to keys-only. Added a comment at the call site.
- **Files modified:** `src/extraction/stage6-slot-comparator.js`
- **Commit:** `c78b76e`

### Rule-3 fix (scenario correction during Task 4 authoring)

**[Rule 3 — Blocking] Legacy stub missing circuit_updates in multi-round E2E test**
- **Found during:** Task 4 first test run
- **Issue:** The default scenario tests `identical`-slot convergence but the legacy stub omitted `circuit_updates: [{op:'create', circuit_ref:2}]`, so tool output diverged on `circuit_ops_diff`. Test asserted `reason === 'identical'`.
- **Fix:** Added `circuit_updates` to the legacy stub — this is what a hypothetical non-strict legacy path would emit for the same transcript. Documented inline so maintainers don't re-trip.
- **Files modified:** `src/__tests__/stage6-tool-loop-e2e.test.js`
- **Commit:** `03e4b7a`

### Planning-tree reconstruction

The `.planning-stage6-agentic/phases/` directory did not exist on the working branch (only `handoffs/` was present). The REVIEW.md scaffold for Task 6 required creating the phase directory from scratch. Non-issue — the scaffold is a leaf artifact, not dependent on earlier planning docs.

## Authentication Gates
None.

## Test Suite Results

- **Stage 6 regression**: 18 test suites, **183 tests passed**, 0 failed.
- **Full backend regression**: 36 suites, **543 tests passed**, 3 skipped (pre-existing), 0 failed.
- Test duration: 0.6s (stage6-only), 5.6s (full).

## REVIEW.md Location

`.planning-stage6-agentic/phases/02-write-tools/REVIEW.md`

Contains empty verdict slots for Claude and Codex, requirement coverage matrix pre-filled with TBC entries for reviewers to confirm, contract reconciliation list with all 8 items. Final Phase 2 Status: `IN_REVIEW`. Phase 3 planning blocked until dual sign-off.

## Commits (in order)

| Hash | Subject |
|------|---------|
| `c78b76e` | `feat(02-06): add stage6 slot comparator (projectSlots + compareSlots)` |
| `20667f6` | `test(02-06): add 11 tests for stage6 slot comparator` |
| `d600a6f` | `feat(02-06): rewire stage6 shadow harness to drive real tool loop` |
| `03e4b7a` | `test(stage6-02-06): STT-03 E2E integration — multi-round tool loop + shadow harness` |
| `ca9025e` | `test(stage6-02-06): STT-09 same-turn correction — record→record→clear collapses to zero readings` |
| `ee9d479` | `docs(stage6-02-06): REVIEW.md scaffold for Phase 2 dual-reviewer gate` |

## Self-Check: PASSED

**Files on disk verified present:**
- FOUND: src/extraction/stage6-slot-comparator.js
- FOUND: src/extraction/stage6-shadow-harness.js (rewired)
- FOUND: src/__tests__/stage6-shadow-comparator.test.js
- FOUND: src/__tests__/stage6-shadow-harness.test.js (rewritten)
- FOUND: src/__tests__/stage6-tool-loop-e2e.test.js
- FOUND: src/__tests__/stage6-same-turn-correction.test.js
- FOUND: .planning-stage6-agentic/phases/02-write-tools/REVIEW.md

**Commits verified on stage6-agentic-extraction:**
- FOUND: c78b76e, 20667f6, d600a6f, 03e4b7a, ca9025e, ee9d479

**Tests verified passing:** stage6 183/183, full backend 543/543 (3 pre-existing skipped).
