# Phase 2 Review — Write Tools + Shadow Integration

**Status:** SCAFFOLD (pending Claude + Codex dual review per phase-gate contract)
**Created:** 2026-04-21
**Last updated:** 2026-04-21 (initial scaffold, Plan 02-06 Task 6)

---

## Reviewers

- **Claude (Anthropic)** — senior engineer reviewer (pending)
- **Codex (OpenAI)** — senior engineer reviewer (pending)

This file holds verdicts from BOTH reviewers. Phase 2 cannot close (cannot
advance to Phase 3 planning) until both have signed off or the explicit
block-list is empty.

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
| 02-06   | Shadow integration (comparator + rewired harness + integration tests) | IN REVIEW |

Deliverable for Phase 2: a shadow-mode end-to-end extraction path that runs
behind the `SONNET_TOOL_CALLS=shadow` env var, produces divergence log rows
comparing legacy vs tool-call slot shapes, and returns legacy bytes to iOS
(wire unchanged).

---

## Requirements Coverage

Map each REQUIREMENTS.md entry to the plan/test that satisfies it. Reviewers
confirm coverage is REAL (test exists AND exercises the requirement) rather
than aspirational.

| Req ID | Summary | Plan | Test file | Covered? |
|--------|---------|------|-----------|----------|
| STS-01 | record_reading dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | TBC |
| STS-02 | clear_reading dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | TBC |
| STS-03 | create_circuit dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | TBC |
| STS-04 | rename_circuit dispatcher | 02-03 | stage6-dispatchers-circuit.test.js | TBC |
| STS-05 | record_observation dispatcher | 02-04 | stage6-dispatchers-observation.test.js | TBC |
| STS-06 | delete_observation dispatcher | 02-04 | stage6-dispatchers-observation.test.js | TBC |
| STD-07 | record_observation atom | 02-01, 02-04 | stage6-snapshot-mutators.test.js | TBC |
| STD-08 | delete_observation atom (BLOCK-2 noop) | 02-01, 02-04 | stage6-snapshot-mutators.test.js + stage6-dispatchers-observation.test.js | TBC |
| STD-09 | Event bundler | 02-05 | stage6-event-bundler.test.js | TBC |
| STT-03 | Multi-round integration | 02-06 | stage6-tool-loop-e2e.test.js | YES |
| STT-09 | Same-turn correction | 02-06 | stage6-same-turn-correction.test.js | YES |
| STI-02 | iOS sees single extraction per turn | 02-05 | stage6-event-bundler.test.js (implicit) + stage6-tool-loop-e2e.test.js | TBC |
| STO-01 | Divergence observability (stage6_divergence log) | 02-06 | stage6-shadow-harness.test.js + stage6-tool-loop-e2e.test.js | YES |

Reviewers: fill TBC cells with `YES` / `NO` / `PARTIAL (reason)` after reading
each test file listed.

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

Reviewers: confirm each reconciliation is documented in code (inline comment)
AND in the 02-06 SUMMARY.md.

---

## Claude Review (PENDING)

<!-- Claude fills this section. Verdict options: APPROVED / BLOCKED / APPROVED_WITH_COMMENTS. -->

### Verdict
_pending_

### Strengths
- _pending_

### Blocking Issues
- _pending_

### Non-Blocking Comments
- _pending_

### Sign-off
_pending — awaiting review_

---

## Codex Review (PENDING)

<!-- Codex fills this section. Verdict options: APPROVED / BLOCKED / APPROVED_WITH_COMMENTS. -->

### Verdict
_pending_

### Strengths
- _pending_

### Blocking Issues
- _pending_

### Non-Blocking Comments
- _pending_

### Sign-off
_pending — awaiting review_

---

## Reconciliation of Review Verdicts

<!-- After both reviews land, the phase lead (human) resolves any conflicting
blocking issues here and sets final phase status. -->

### Final Phase 2 Status
`IN_REVIEW` → `APPROVED` | `BLOCKED` (TBD)

### Action Items Before Phase 3 Planning
1. _pending_

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

Reviewers: confirm every file in this manifest exists on disk and has a
commit on the `stage6-agentic-extraction` branch.
