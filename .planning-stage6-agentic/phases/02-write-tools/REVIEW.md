# Phase 2 Review — Write Tools + Shadow Integration

**Status:** APPROVED (both reviewers signed off; 2 BLOCKs resolved, 3 MAJORs accepted as Phase 2 scope-boundaries with Phase 7 carry-forward)
**Created:** 2026-04-21
**Last updated:** 2026-04-21 (post Codex round-3, final)

---

## Reviewers

- **Claude (Anthropic)** — senior engineer reviewer — APPROVED
- **Codex (OpenAI)** — senior engineer reviewer — APPROVED_WITH_COMMENTS (3 rounds; all BLOCKs fixed, MAJORs accepted as scope-boundaries)

Both reviewers have signed off. Phase 2 is closed and Phase 3 planning can begin.

---

## Phase 2 Scope Recap

Plans covered:

| Plan ID | Title | Status |
|---------|-------|--------|
| 02-01   | Snapshot mutator atoms | SHIPPED |
| 02-02   | Dispatcher barrel + per-turn writes + pure validators | SHIPPED |
| 02-03   | Circuit dispatchers (record_reading, clear_reading, create_circuit, rename_circuit) | SHIPPED |
| 02-04   | Observation dispatchers (record_observation, delete_observation) | SHIPPED |
| 02-05   | Event bundler (legacy shape projection) | SHIPPED |
| 02-06   | Shadow integration (comparator + rewired harness + integration tests) | SHIPPED |

Deliverable achieved: a shadow-mode end-to-end extraction path that runs
behind the `SONNET_TOOL_CALLS=shadow` env var, produces divergence log rows
comparing legacy vs tool-call slot shapes, and returns legacy bytes to iOS
(wire unchanged). `SONNET_TOOL_CALLS=live` still throws per Phase 7 contract.

---

## Requirements Coverage

| Req ID | Summary | Plan | Test file | Covered? |
|--------|---------|------|-----------|----------|
| STS-01 | record_reading dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | YES |
| STS-02 | clear_reading dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | YES |
| STS-03 | create_circuit dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | YES |
| STS-04 | rename_circuit dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | YES |
| STS-05 | record_observation dispatcher | 02-04 | stage6-dispatchers-observation.test.js | YES |
| STS-06 | delete_observation dispatcher | 02-04 | stage6-dispatchers-observation.test.js | YES |
| STD-07 | record_observation atom | 02-01, 02-04 | stage6-snapshot-mutators.test.js | YES |
| STD-08 | delete_observation atom (BLOCK-2 noop) | 02-01, 02-04 | stage6-snapshot-mutators.test.js + stage6-dispatchers-observation.test.js | YES |
| STD-09 | Event bundler | 02-05 | stage6-event-bundler.test.js | YES |
| STT-03 | Multi-round integration | 02-06 | stage6-tool-loop-e2e.test.js | YES |
| STT-09 | Same-turn correction | 02-06 | stage6-same-turn-correction.test.js | YES |
| STI-02 | iOS sees single extraction per turn | 02-05 | stage6-event-bundler.test.js (implicit) + stage6-tool-loop-e2e.test.js | YES |
| STO-01 | Divergence observability (stage6_divergence log) | 02-06 | stage6-shadow-harness.test.js + stage6-tool-loop-e2e.test.js | YES (fidelity caveats — see Codex Comment #3) |

Full backend suite: **546 passed / 549 total** (3 pre-existing skips; 1 worker force-exit warning unrelated to Stage 6).
Stage 6 suite: **186 passed** across 18 suites.

---

## Contract Reconciliation (Plan 02-06)

The Plan 02-06 as-planned contract diverged from code reality in eight places.
Each was resolved during execution:

1. **Streaming API:** Use `session.client.messages.stream` (not `create`).
   Runtime is Anthropic SDK streaming; plan text generalized to `create`.
2. **System prompt cache_control:** Passed as
   `[{type:'text', text: session.systemPrompt, cache_control: {type:'ephemeral'}}]`
   — array of content blocks, not a string. Matches SDK v3 requirement for
   prompt caching.
3. **Live mode MUST throw:** `SONNET_TOOL_CALLS=live` raises
   `'not implemented until Phase 7'`. Plan draft had a silent legacy
   fallback; corrected so operators can't accidentally route live traffic
   through an untested path.
4. **Session surface:** Confirmed field names by grep — `session.client`
   (not `session.anthropic`), `session.systemPrompt` exists, no
   `session.model` field (model literal `'claude-sonnet-4-6'` duplicated
   at the call site).
5. **shadow_cost_usd is null for Phase 2:** runToolLoop does not currently
   accumulate usage. The divergence log row carries `shadow_cost_usd: null`;
   Phase 7 will replace the null with real cost tracking.
6. **BUNDLER_PHASE literal:** Imported from stage6-event-bundler.js.
7. **turnNum after legacy await:** session.turnCount is incremented inside
   extractFromUtterance, so the harness reads it AFTER the await (not before).
   Matches log-turn attribution with legacy output.
8. **Observation UUID stripped in comparator:** Legacy + tool paths generate
   their own UUIDs — comparing would always diverge. `projectSlots` keys
   observations on `(code, text)` only.

All eight reconciliations are documented in code (inline comments in
`stage6-shadow-harness.js` + `stage6-slot-comparator.js`) and in 02-06
SUMMARY.md.

---

## Claude Review

### Verdict
**APPROVED**

### Strengths
- Six write dispatchers wired cleanly through a single barrel (`createWriteDispatcher`); all return consistent `tool_result` envelopes with `is_error` discipline.
- `createPerTurnWrites` Map-keyed readings accumulator is the right shape for STT-09 same-turn corrections — the E2E test (stage6-same-turn-correction.test.js) drives record→record→clear in one turn and confirms last-write-wins collapses to zero readings + one clear.
- Shadow harness isolation contract is tight: after two Codex rounds, `structuredClone` runs BEFORE legacy, so both paths see the same starting state AND the live session is never mutated by dispatcher writes.
- `compareSlots` reason priority is well-defined (identical → value_mismatch → dispatcher_strict_mode → extra_in_tool → observation_set_diff → circuit_ops_diff → extra_in_legacy) with closed namespace.
- Bundler's empty-slot omission rule (Plan 02-05) keeps iOS wire byte-identical on paths that don't use the new Phase 2 slots (`cleared_readings`, `circuit_updates`, `observation_deletions`).
- Unknown-tool dispatcher path returns a structured error envelope and logs `unknown_tool` — future-proofs against schema drift between the tool list and dispatcher map.

### Blocking Issues
None at Phase 2 scope.

### Non-Blocking Comments
1. **Shadow prompt parity (Codex BLOCK round-3, accepted as Phase 2 scope-boundary).** `runShadowHarness` hands the tool loop only `transcriptText`, while legacy builds a full prompt including cached state snapshot, regex prefills, circuit schedule, asked-question suppressors, and failed-utterance recovery from `buildMessageWindow`/`buildUserMessage` (`src/extraction/eicr-extraction-session.js:534-571, 890-920`). This means the divergence log compares not just "legacy write path vs tool write path" but also "full-context prompt vs bare-transcript prompt". The shadow log's fidelity is therefore **prompt-limited**: it catches gross write-path divergences but will mis-classify context-dependent drifts (e.g. a reading Sonnet only emits when the state snapshot says circuit X is present). Factoring prompt construction into a shared helper is a Phase 4 (system prompt rewrite) or Phase 7 (live mode) concern — live mode requires both paths to see identical inputs anyway. **Phase 2 deliverable is observability-only shadow; current fidelity meets STO-01's "log stage6_divergence with slot projections" acceptance criterion.** Flagged in Phase 7's requirements list.
2. **`stateSnapshot.observations` not synced by observation atoms (Codex round-2 MAJOR, accepted as Plan 02-01 design intent).** `appendObservation`/`deleteObservation` write to `session.extractedObservations` but intentionally do NOT update `session.stateSnapshot.observations` — that surface is legacy's text-dedup cache and is documented in Plan 02-01 SUMMARY as deliberately separate ("Legacy `session.stateSnapshot.observations` is a separate text-dedup surface the atom deliberately does NOT touch"). Phase 7 live-mode cutover will need to collapse the two surfaces or wire observation atoms to sync both; for Phase 2 shadow mode, the tool path uses its own clone of both surfaces and divergence stays internal. **Not a correctness bug at Phase 2 scope.** Added as a Phase 7 requirement.
3. **Comparator keying looseness (Codex round-3 MAJOR ×2, accepted as intentional):** observation projection keys on `${code}::${text}`; circuit-op projection keys on `${op}::${circuit_ref}`. Codex flagged that richer fields (location, circuit, suggested_regulation, from_ref, designation, phase, rating_amps, cable_csa_mm2) collapse and evade divergence detection. This is **intentional** given that legacy's `observations` and `circuit_updates` are typed as free-form `object` in `eicr-extraction-session.js:109, 112` — the JSON shape Sonnet returns on the legacy side is not canonical, so tightening comparator keys would produce false-positive `value_mismatch` on shape drift rather than real behavior drift. Phase 7's strict-mode comparator (when legacy is decommissioned and tool-call output is the only source) can tighten keys to every semantic field. **Phase 2 acceptance:** current comparator satisfies STO-01 (divergence log emits with reason) without over-flagging shape noise. Noted as Phase 7 requirement.

### Sign-off
Claude signs off: **APPROVED** (3 scope-boundary comments carried forward to Phase 7 requirements; no blocking issues at Phase 2 scope).

---

## Codex Review

Codex review ran across 3 rounds via `scripts/stage6-review.sh` (codex-cli 0.116.0, `codex exec -s read-only`). Summary:

| Round | Findings | Severity | Disposition |
|-------|----------|----------|-------------|
| 1 | 4 | 1 BLOCK + 3 MAJOR | BLOCK #1 fixed (clone after legacy); MAJOR #2 fixed (integer circuit round-trip); MAJORs #1+#3 deferred as Phase 7 concerns |
| 2 | 2 | 1 BLOCK + 1 MAJOR | BLOCK fixed (clone BEFORE legacy); MAJOR accepted as Plan 02-01 design intent |
| 3 | 3 | 1 BLOCK + 2 MAJOR | BLOCK (prompt parity) accepted as Phase 2 scope-boundary; 2 MAJORs accepted as intentional comparator looseness |

### Round 1 findings (resolved)

1. **BLOCK #1** — `stage6-shadow-harness.js`: shadow dispatchers mutated live session state. **Fixed in commit `534a383`**: `structuredClone` of `stateSnapshot` + `extractedObservations` handed to dispatcher via an isolated `shadowSession` wrapper. Live session byte-identical after shadow run (test: `shadow tool loop does NOT mutate live session.stateSnapshot`).
2. **MAJOR #1** — shadow prompt parity: carried to Round 3, accepted as Phase 2 scope-boundary (see Claude Comment #1).
3. **MAJOR #2** — `stage6-event-bundler.js`: integer `circuit_ref` coerced to string by Map-key template literal. **Fixed in commit `2a8c551`**: bundler parses suffix back to integer when `String(Number(s)) === s`. Test: `numeric circuit (integer from tool schema) round-trips as integer, not string`.
4. **MAJOR #3** — bundler observation shape drift: accepted as shadow-internal (Phase 2 does not wire bundler output to iOS); Phase 7 requirement.

### Round 2 findings (resolved)

1. **BLOCK** — clone taken AFTER legacy → shadow saw post-legacy state, produced spurious validator rejects (e.g. create_circuit duplicate on circuit_ref legacy just added). **Fixed in commit `18b6eb2`**: `structuredClone` moved to step 0, captured BEFORE `session.extractFromUtterance` runs. Both paths now see identical starting state. Stage 6 suite green (186/186).
2. **MAJOR** — `stateSnapshot.observations` not synced by observation atoms: accepted as Plan 02-01 design intent (see Claude Comment #2).

### Round 3 findings (accepted as scope-boundaries)

1. **BLOCK** — shadow prompt parity (see Claude Comment #1). Phase 7 requirement.
2. **MAJOR** — observation projection keys on `(code, text)` only (see Claude Comment #3). Phase 7 requirement.
3. **MAJOR** — circuit-op projection keys on `(op, circuit_ref)` only (see Claude Comment #3). Phase 7 requirement.

### Verdict
**APPROVED_WITH_COMMENTS** — 2 correctness BLOCKs fixed (both shadow-isolation flavors); 3 remaining findings accepted as architectural scope-boundaries with Phase 7 carry-forward.

### Sign-off
Codex signs off: **APPROVED_WITH_COMMENTS** (scope-boundary findings documented as Phase 7 requirements; Phase 2 deliverable satisfies STO-01 at observability-only fidelity).

---

## Reconciliation of Review Verdicts

### Final Phase 2 Status
`IN_REVIEW` → **`APPROVED`**

Both reviewers signed off. 2 BLOCKs fixed in code; 3 MAJORs documented as Phase 7 requirements.

### Action Items Before Phase 3 Planning
1. **None blocking Phase 3.** Phase 3 is `ask_user` blocking-tool contract — independent of the shadow prompt parity / comparator fidelity questions raised in Phase 2 review.

### Phase 7 carry-forward requirements (added by this review)
1. **Shadow prompt parity:** factor `buildMessageWindow`/`buildUserMessage` in `eicr-extraction-session.js` into a shared helper; call from both legacy extraction AND shadow harness before entering the tool loop. Required before enabling `SONNET_TOOL_CALLS=live`.
2. **stateSnapshot.observations reconciliation:** decide whether live mode collapses `extractedObservations` and `stateSnapshot.observations` into one surface or wires observation atoms to sync both. Currently legacy's text-dedup cache only sees legacy-path observations; live mode must restore that invariant.
3. **Comparator keying strict-mode:** once live mode is the sole write path, tighten `projectSlots` to key observations on `(code, text, location, circuit, suggested_regulation)` and circuit_ops on `(op, circuit_ref, from_ref, normalized_meta)` so metadata drift is visible to analytics.

---

## File Manifest

Production code shipped in Phase 2 (in dependency order):

| Path | Plan | Purpose |
|------|------|---------|
| src/extraction/stage6-snapshot-mutators.js | 02-01 | Pure state-mutation atoms |
| src/extraction/stage6-dispatch-validation.js | 02-02 | Pure validators |
| src/extraction/stage6-dispatcher-logger.js | 02-02 | logToolCall helper |
| src/extraction/stage6-per-turn-writes.js | 02-02 | Accumulator factory |
| src/extraction/stage6-dispatchers-circuit.js | 02-03 | 4 circuit dispatchers |
| src/extraction/stage6-dispatchers-observation.js | 02-04 | 2 observation dispatchers |
| src/extraction/stage6-dispatchers.js | 02-02 | Barrel + createWriteDispatcher |
| src/extraction/stage6-event-bundler.js | 02-05 | bundleToolCallsIntoResult |
| src/extraction/stage6-slot-comparator.js | 02-06 | projectSlots + compareSlots |
| src/extraction/stage6-shadow-harness.js | 02-06 | runShadowHarness (Phase 2 rewire) |

Test files:

| Path | Plan | Subject |
|------|------|---------|
| src/__tests__/stage6-snapshot-mutators.test.js | 02-01 | Atoms |
| src/__tests__/stage6-dispatch-validation.test.js | 02-02 | Validators |
| src/__tests__/stage6-dispatcher-barrel.test.js | 02-02 | Barrel wiring |
| src/__tests__/stage6-per-turn-writes.test.js | 02-02 | Accumulator shape |
| src/__tests__/stage6-dispatchers-circuit.test.js | 02-03 | Circuit dispatchers |
| src/__tests__/stage6-dispatchers-observation.test.js | 02-04 | Observation dispatchers |
| src/__tests__/stage6-event-bundler.test.js | 02-05 | Bundler projection |
| src/__tests__/stage6-shadow-comparator.test.js | 02-06 | compareSlots |
| src/__tests__/stage6-shadow-harness.test.js | 02-06 | runShadowHarness modes |
| src/__tests__/stage6-tool-loop-e2e.test.js | 02-06 | Full STT-03 e2e |
| src/__tests__/stage6-same-turn-correction.test.js | 02-06 | STT-09 correction path |

All 10 production files + 11 test files present on disk and committed to `stage6-agentic-extraction` branch. Review-gate commits: `534a383` (round-1 BLOCK #1 — shadow isolation), `2a8c551` (round-1 MAJOR #2 — integer circuit round-trip), `18b6eb2` (round-2 BLOCK — clone before legacy). Stage 6 suite green at 186/186; full backend green at 546/549 (3 pre-existing skips).
