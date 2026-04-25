# Stage 6 — Golden-Session Divergence Fixtures

Deterministic fixtures that feed `scripts/stage6-golden-divergence.js` for the
Phase 4 SC #6 gate (≤10% divergence between the legacy extraction result shape
and the tool-call dispatcher + bundler output, after STR-02 canonicalisation).

## Purpose

These fixtures are **not** real-model shadow runs. They are hand-crafted
pairs of canned SSE streams that — when replayed — should drive the legacy
and tool-call paths to the *same* canonical slot writes. The gate they close
is deterministic-equivalence: if our normaliser + dispatcher + bundler
mechanics are sound, divergence must be 0% on this set. Any non-zero
divergence here is a bug in the pipeline, not a model-behaviour signal.

Real-model shadow runs arrive in Phase 5 (20-session exit check, STT-11
full set) and Phase 7 (STR-03 production traffic gate, ≤5% session /
≤2% call).

## Fixture shape

Every fixture is a JSON file with these keys:

| Key | Required | Purpose |
|---|---|---|
| `_doc` | yes | 1–2 paragraph explanation: scenario, STQ-02 category, convergence rationale. |
| `_requirement` | yes | STT-11 plus any specific sub-requirement the fixture exercises. |
| `_fixture_shape` | yes | `"dual-SSE"` (this directory) or `"tool-call-only"` (e.g. Plan 04-04's F21934D4). |
| `pre_turn_state.snapshot` | yes | Starting `{ circuits, pending_readings, observations, validation_alerts }`. Circuits referenced by `record_reading` / `clear_reading` MUST be pre-registered here or the dispatcher's `validateRecordReading` (see `src/extraction/stage6-dispatch-validation.js`) will reject the write with `circuit_not_found`. |
| `pre_turn_state.askedQuestions` | yes | Usually `[]` — this gate lives one level above the QuestionGate. |
| `pre_turn_state.extractedObservations` | yes | Usually `[]`. |
| `transcript` | yes | The utterance text the model receives. Inspector-voice, British English. |
| `sse_events_legacy` | yes for dual-SSE | One `record_extraction` tool_use whose `input` JSON matches the pre-Phase-4 `extractFromUtterance` return shape (`extracted_readings`, `field_clears`, `circuit_updates`, `observations`, `questions_for_user`). |
| `sse_events_tool_call` | yes | Round-1 of the granular tool-call flow: one or more `record_reading` / `clear_reading` / `create_circuit` / `rename_circuit` / `record_observation` / `delete_observation` tool_use blocks, ending with `stop_reason: "tool_use"`. |
| `sse_events_tool_call_round2` | optional | Round-2 end_turn. If omitted, the runner synthesises a trivial end_turn so `runToolLoop` terminates. |
| `expected_slot_writes` | yes | Truth witness: the slot writes both paths should converge on. Used as documentation — the divergence test compares the two PATHS to each other, not to this field, but a reviewer should be able to read this and predict the outcome. |

## The 5 fixtures shipped with Plan 04-05

| File | STQ-02 Category | What it locks |
|---|---|---|
| `sample-01-routine.json` | 1 — routine capture | Single reading. Baseline: one utterance → one tool_use → one canonical write. |
| `sample-02-correction.json` | 2 — same-turn correction | `clear_reading` + `record_reading` in one round. STT-09 last-write-wins on the perTurnWrites Map. |
| `sample-03-post-ask-resolved.json` | 3 — post-ask-resolved (ambiguous-circuit CONSEQUENTS only) | `create_circuit` + `record_reading` in one round. Models the state AFTER an `ask_user` has been answered; the round-trip itself is elided and tested separately (Phase 3 ask-integration suites + F21934D4 replay). Renamed from `sample-03-ambiguous-circuit.json` in Plan 04-07 r1 so the filename no longer overclaims the coverage; a proper round-trip fixture lands in Phase 5's STT-11 full exit check. |
| `sample-04-batched.json` | 4 — batched readings | Four parallel `record_reading` tool_uses in one round. Confirms no cross-talk on the perTurnWrites Map (keys are `field::circuit`). |
| `sample-05-refill-guard.json` | STQ-05 restraint | Supply-level Ze pre-fill on circuit 1. Neither path re-emits (1,ze); both only write the new (3,zs). Different field-combo from F21934D4 so both shapes are covered. |

Plan 04-04's `F21934D4-re-ask-scenario.json` (a tool-call-only fixture) is
referenced by the divergence test via the `extraFixtures` option rather than
duplicated here — that fixture remains the single source of truth owned by
Plan 04-04.

## Adding a new golden

1. Start from the shape above. Always include `_doc` + `_requirement`.
2. The tool-call round MUST pre-register any circuits its `record_reading`
   calls reference, unless the round also emits `create_circuit` for them
   FIRST (same round, earlier block index).
3. For determinism, AVOID `ask_user` tool_uses. Phase 3's
   `stage6-dispatcher-ask.js` registry is stateful and threads through a
   session-scoped `pendingAsks` + `ws` surface the divergence harness does
   not wire. If a scenario conceptually needs `ask_user`, capture the
   POST-RESOLVED state and flag the deviation in `_doc`.
4. Validate with:
   ```bash
   node scripts/stage6-golden-divergence.js --dir src/__tests__/fixtures/stage6-golden-sessions --threshold 0.10
   ```
5. Expected output: `"session_divergence_rate": 0, "call_divergence_rate": 0`.
   Anything else means the fixture's two SSE streams don't converge under
   the normaliser — inspect `first_10_divergent_samples.reasons` to see
   which slot section disagreed.

## Re-use chain

- **Phase 4 SC #6 (this plan)** — deterministic equivalence across the 5
  fixtures shipped here plus 04-04's F21934D4. Expected: 0% divergence.
  Budget: 10% (ample — covers future authoring error).
- **Phase 5 SC #8 (20-golden-session exit check)** — this directory grows
  by 15 fixtures (5 new per STQ-02 category + 10 synthesised from real
  production transcripts). Same runner, same normaliser, same threshold.
- **Phase 7 STR-03 gate** — real-model shadow traffic flows through a
  streaming variant of the same normaliser. The deterministic baseline
  this plan establishes is the before-picture; STR-03 divergence is
  measured against it. Threshold tightens to STR-03's 5% session / 2%
  call.

## Links

- Script: `scripts/stage6-golden-divergence.js`
- Tests: `src/__tests__/stage6-golden-divergence.test.js`
- Normaliser contract: `STR-02` in `.planning-stage6-agentic/REQUIREMENTS.md`
- Golden-session subset: `STT-11` in `.planning-stage6-agentic/REQUIREMENTS.md`
- Cross-plan fixture reference: `src/__tests__/fixtures/stage6-sse/f21934d4-re-ask-scenario.json`
  (owned by Plan 04-04)
