# Known-flaky scenarios — DO NOT DELETE without reading this file

This file lives in `tests/fixtures/voice-latency-scenarios/` alongside the scenarios it documents.

## Purpose

The 2026-06-01 matrix run deleted 13 scenarios as "Sonnet sampling noise." Several of them would have caught the 2026-06-02 field-test bug (`session E87F58C1` — `rcd_type="AND"` off-enum + under-fanning to circuit 3 only). **A 50% pass rate on a multi-circuit fan-out scenario is INFORMATION, not noise.**

If you are about to delete a scenario because it failed, **read this file first.** Each known-flaky entry below explains the bug class the flakiness catches. If your scenario maps to one of these classes, mark it as known-flaky here instead of deleting.

## Format

Each entry:

```
## <scenario-path>
**Bug class:** <one-line summary>
**Why it flakes:** <Sonnet variance / Deepgram garble variance / iOS timing / etc.>
**What deleting it costs:** <the bug it would silently re-enable>
```

## Known-flaky entries (2026-06-02 audit)

### `speculator_races/probe_different_field_same_turn_correction.yaml`

**Bug class:** Sonnet non-determinism on cross-field "actually sorry" correction.
**Why it flakes:** Sonnet sometimes interprets "polarity OK, actually sorry, R1+R2 0.42" as TWO independent writes (both persist); other runs interpret as a topic-switch where the polarity write is dropped. Same transcript, different result across runs.
**What deleting it costs:** Cross-field correction is a real inspector pattern. Inspector dictating fast over multiple circuits will hit this. If the scenario is deleted and Sonnet ever shifts entirely to the "drop second write" branch, no other scenario catches it. The flakiness IS the signal.

### `bulk/circuits_2_and_3_list.yaml`

**Bug class:** Sonnet under-fanning / silent turn drop on multi-circuit list parsing.
**Why it flakes:** 5-trial run on prod 2026-06-02 showed 4 passes + 1 trial where Sonnet returned ZERO readings on "Insulation L to L 200 megohms for circuits 2 and 3." Same transcript, different result — 80% hit rate. The 1 miss was a SILENT drop (no extraction, no ask_user, no error).
**What deleting it costs:** This is the same bug class as 2026-06-02 session E87F58C1 ("rcd_type=AND on circuit 2 only" — under-fanning). When Sonnet drops the list-form turn entirely, the inspector hears nothing and assumes the system missed them. When Sonnet drops partial writes, only one column updates. Both are silent failures from the inspector's perspective. **Pinning the broadcast-list pattern as a regression-guard is essential** — silent under-fanning is the worst kind of bug.

## How to interpret a flake

A scenario in this file failing on a particular run is the SYSTEM-IS-INCONSISTENT signal, not the TEST-IS-BROKEN signal. Three triage paths:

1. **Same scenario flakes >50% over 10 trials** — consider strengthening the scenario to allow either of the observed outcomes (`has_no_reading` for the bug shape; `has_reading` left flexible). Mark with a `flaky_threshold_pct` annotation in the description.

2. **Scenario flakes only when prod Sonnet drifts to a new model version** — that's a known-acceptable model-version flake. Cross-reference the Anthropic SDK changelog. If a model-version-bump caused it, the scenario IS catching real drift.

3. **Scenario starts failing 100% (was passing)** — this is the regression-guard firing as designed. Likely the underlying behaviour shifted (Sonnet retrain, dispatcher change, schema update). Investigate before silencing.

DO NOT just delete because "tests flake". The 2026-06-01 deletion of 13 scenarios cost us the 2026-06-02 field-test bug. Every entry here is paid for in real inspector-experience.

