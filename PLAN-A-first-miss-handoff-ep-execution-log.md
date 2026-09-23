# PLAN-A execution log — first-miss handoff (feedback-2026-09-17, ids 140/141/143)

- **Plan:** `~/.claude/handoffs/EICR_Automation--feedback-2026-09-17/PLAN-A-v53.md`
  (sha256 `2d008a6c8cc0ed669450d14b39aa2ededbf515beb81ceb94e5ffa73ca1182582`; `PLAN-A.md` byte-equal)
- **Convergence:** `WAVE-CONTEXT.md` § Decision 23 (TAKEN 2026-09-21). Targeted round 31 closed under
  the round-30 adjudicator's pre-committed outcome condition, clause (b); the hold was resolved by
  coordinator amendment A-256…A-259. Do not dispatch a round 32.
- **Executor:** session `eicr-automation-75 [7113c5]`, Claude Opus 5 / high, `/ep` chain hop 3
  (Decision 27), assigned by the wave coordinator `eicr-automation-a7` (verified on the ListAgents
  roster before accepting).
- **Worktrees:** `EICR_Automation-a-ep-20260923` on `ep/plan-a-dialogue-handoff-20260923` from
  `f20ff152`; `CertMateUnified-a-ep-20260923` on `ep/plan-a-bs7671-doc-20260923` from `b1b3ed7`.
- **Date:** 2026-09-23.

---

## 1. FIRST OBLIGATION — the citation walk (Decision 23)

The `.ep-queue` marker's first obligation is to OPEN every cited construct before touching the code it
points at, record every drift as a ledger row, and STOP on a design drift.

**Discharged before any code was written.** Ledger rows `A-260` and `A-261`.

- **Zero source drift between the pin and `origin/main`.** `git diff --stat 02106091 f20ff152 --`
  over `engine.js`, `stage6-shadow-harness.js`, `sonnet-stream.js`, `stage6-event-bundler.js`,
  `stage6-dispatchers-circuit.js`, `stage6-dispatchers-script.js`, `config/field_schema.json`,
  `dialogue-engine/schemas/`, `stage6-dispatch-validation.js` and `value-enum-validator.js` returns
  EMPTY. The only files this plan touches that moved between pin and main are docs.
- **ENUMERATED, not sampled.** ~115 constructs opened. `A-261` lists them.
- **ZERO design drift.** One pointer-level finding (`A-260`): the rejected-is-not-an-outcome argument
  cites `engine.js:4227-4228`, which is step 8's guard, while the paragraph's general claim — covering
  the pending-write-drain rejection too — additionally needs the miss branch's own guard at `:4337`.
  Both guards exist and carry the identical two conditions, so the stated property holds in every
  case. Recorded; execution continued.

---

## 2. What shipped

Six commits on `ep/plan-a-dialogue-handoff-20260923`:

| Commit | Unit |
|---|---|
| `b4879d60` | The `circuit-value-descriptors.js` dependency leaf + its oracle; Decision 9 (ladder removed) and Decision 16 (21-value researched `suggestions` list) |
| `4d69c8b3` | Decision 17 — per-field completion-summary suppression, with its three consequential edits |
| `a9cebf89` | The advisory carrier, on all three read-back producers |
| `127075ca` | §A1-A5 core — the handoff, the note, the tombstone, the fence, the carrier, the recovery step |
| `1e67e57d` | The acceptance suites |
| `11b48491` | Docs, the parity-ledger row and its files map, changelog and hub rows |

One commit on `ep/plan-a-bs7671-doc-20260923` in the iOS repo: `7ce7c88`, the § 4 correction. Planning
document only — no app code, no build impact, no TestFlight implication.

### Scope held

Shipped nothing the plan puts out of scope. Specifically NOT shipped: the
`closed-enum-vectors.json` `suggestions` section, its iOS byte copy, either digest constant,
`Constants.breakingCapacities`, any client code, any wire-shape change, any new tool, dispatcher or
tool-schema property. Those four client artefacts are one indivisible shipment needing a TestFlight
cycle and are scheduled through the ledger row with an owner.

### A sibling-ordering observation, recorded rather than worked around

The plan's acceptance case 2 expects an `ocpd_bs_en = BS EN 61009` write to carry an EMPTY `derived`.
That is true only after PLAN-CS's CS-64 deletes the four `bs_code` mirrors, and PLAN-A merges FIRST —
so on today's `main` the mirror is live and `derived` is `['rcd_bs_en']`. The implementation records
whatever `applyDerivations` produced, so it is correct in both states; the test DERIVES its
expectation from the schema rather than hardcoding either value, and therefore needs no edit when the
sibling lands.

---

## 3. Tests

### New

| Suite | Covers |
|---|---|
| `circuit-value-descriptors.test.js` | The descriptor-vs-validator ORACLE over every non-`_ui_` circuit field × a fixed vector set, one coerced value fed to both sides; two schema-locks |
| `circuit-value-descriptors-imports.test.js` | The leaf's import restriction as a CLOSURE property, with the instrument proven to fail on a known-bad module and each arm of the predicate exercised separately |
| `dialogue-engine-finish-summary-segments.test.js` | Decision 17 — byte-identity against both pre-change templates pinned as literals, and exactly-once across the turn boundary with a fail-closed direction |
| `breaking-capacity-advisory.test.js` | Decision 9/16 — the derivation, and paths (a), (b) and (d) end to end |
| `dialogue-engine-first-miss-handoff.test.js` | Acceptance 1, 2, 5, 6, 7, 8 — the handoff, the note, the tombstone matrix, board normalisation, A3, A4, derived provenance |
| `device-absence-fence.test.js` | `survivingClears` and the fence's scope rule |
| `terminal-readback-carrier.test.js` | `safeSend`'s boolean, the tri-state through a real handoff, and the PRODUCTION fold |
| `terminal-readback-recovery.test.js` | The recovery step and its placement, with a negative control |

### Two deliberate strengthenings

1. **The aggregator is IMPORTED, not replicated.** The first draft of the carrier test re-implemented
   the fold inline, which pins nothing — a replica can agree with a wrong implementation. The fold was
   extracted to the zero-import `terminal-readback-carrier.js`; `sonnet-stream.js` and the test now
   call the same function.
2. **The placement assertion is RED-PROOFED.** The recovery block was moved to AFTER the A3 net and
   the suite re-run: exactly the placement case went red and the other six stayed green. Restored and
   re-confirmed.

### Ten pre-existing tests updated

Each was an intended consequence, and each was updated to assert the NEW behaviour while keeping its
original invariant and its history:

- the no-progress cap suite, rewritten around the first miss and GAINING the two guards a naive
  implementation fails (an ordinary answer must NOT hand off; a compound reply answering a different
  slot MUST);
- four defer-negative cases, which keep "does not defer" and now assert what not deferring means;
- two A2 provenance cases, whose re-dictation moves onto the SAME turn as the answer to the slot the
  engine asked, plus a new `(e2)` pinning that the per-turn form hands off while STILL being
  spoken and STILL creating no phantom write;
- the ring correction case, asserting its invariant at the terminal exit where it now happens;
- the B107472D replay case, SPLIT rather than filtered — legacy parity keeps the half that is still
  parity, and the miss half becomes an engine-only assertion. Adding a `normaliseEmits` filter was
  rejected: it would have left the scenario asserting nothing about the behaviour it exists to cover.

### Gates

| Gate | Result |
|---|---|
| Backend Jest | 9669 passed, 19 skipped, 0 failed |
| Web Vitest | 2819 passed, 1 skipped |
| ESLint (`npm run lint`) | 0 errors |
| Field-replay corpus (`replay:field-corpus:prepush`) | 13/13 pass, strict gate green |
| `check-hub-size.mjs` | OK, 44558/45000 chars |
| `build-regex-fresh-occurrence-evidence.mjs --verify` | digests match the checkout |

### Two evidence documents re-pinned, only where they drifted

- `scripts/model-ab/plan00-expectation-manifest.json` — `engine.js` is a declared semantic-oracle
  input and its digest check is merge-blocking.
- `docs/reference/evidence/regex-fresh-occurrence.json` — ONE digest, for the edited
  `sonnet-stream.js`, updated to the generator's own computed value with `--verify` green afterwards.
  This follows commit `f36d644d` exactly. A full regeneration was deliberately NOT used: every run
  input is optional and a missing one records as `not_run`, so it would have blanked A02D's real
  measured evidence, and its baseline lane cannot be reproduced at all (it needs the PRE-A02D web
  sources).

---

## 4. A behaviour change WIDER than the reported ids — flagged, not buried

A mid-walk correction to an EARLIER slot now ends the walk-through. "Actually the lives are 0.44"
while the engine asked for neutrals is a compound reply with an unanswered ask, so under Decision 1 it
is a first miss.

What the inspector experiences: the correction LANDS, the terminal exit reads back what the run
captured (both the superseded and the corrected value, each exactly once), and the model continues
from the note's `remaining` — which carries the unanswered slot first. Nothing is lost and nothing is
silent.

The plan anticipates this: its consequence 2 states that a handoff turn routinely carries applied
writes and that `recorded` is routinely non-empty. It is recorded here because it is broader than the
three reported ids and is worth a field ear on the first session.

---

## 5. Review

Two fresh, independent Codex lanes on `gpt-6-sol` at reasoning effort high (the routing the dispatch
note specifies), launched concurrently against base `f20ff152` head `11b48491`:

- **comprehensive** — plan faithfulness, actual bugs, acceptance omissions, regressions;
- **specialist** — the AUDIBLE boundary and the tombstone state machine, i.e. can this diff make the
  inspector hear a recorded value twice, or not at all.

Inputs, prompts, raw logs and findings: `PLAN-A-ep-reviews/` in the handoff directory.

<!-- REVIEW OUTCOME APPENDED BELOW -->
