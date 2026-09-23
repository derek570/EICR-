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

### Round 1 — two concurrent lanes, ten findings

| # | Lane | Severity | Finding | Disposition |
|---|---|---|---|---|
| 1 | comprehensive | BLOCKER | A fenced reading `return`ed from the per-reading loop, so a turn writing board A circuit 3 AND board B circuit 3 stopped at the first, tombstoned reading and the eligible board-B write never entered. Entry depended on READING ORDER. | FIXED |
| 2 | both | BLOCKER | `readExistingValues` read the SELECTED board while the hook had resolved the WRITE's board, so another board's pre-existing values were seeded into the episode and surfaced in `recorded` as though this walk had captured them. | FIXED |
| 3 | specialist | BLOCKER | Three other fallthrough exits discarded the terminal tri-state, so a DEFINITE non-delivery there lost the rendered line with no recovery. | FIXED |
| 4 | comprehensive | IMPORTANT | `findLatestOperationForWrite` could not find, or mis-credited, the operation at both pending-write drain sites, where the derivation runs before the circuit is bound. | FIXED |
| 5 | comprehensive | IMPORTANT | A `sets` target appeared in both `recorded[].derived` and non-clearable `existing_values` — two contradictory instructions about one field. | FIXED |
| 6 | comprehensive | IMPORTANT | A same-turn derivation that FILLED the asked slot was read as a miss, ending the walk on a slot that was no longer missing. | FIXED |
| 7 | comprehensive | IMPORTANT | The fence matrix asserted a local replica of the comparison rather than the production fence. | FIXED |
| 8 | specialist | IMPORTANT | With `VOICE_MID_STREAM_FILTER` on, a filtered canonical confirmation plus Decision 17's `spoken_owner` omission can leave a value never read back. | RECORDED, not fixed |
| 9 | specialist | OUT_OF_INTENT | The fence discards an answer carrying information beyond the clears. | REFUSED, carried to Derek |

Both BLOCKER board findings are the same class as the defect the executor found independently before
the lanes reported (`150aa151`): the plan's one-board-normalisation rule was applied at every READER
and missed on the WRITER's side of the same seam. Three separate sites, one root cause.

**Finding 7 is worth naming as a pattern.** It is the third time in this plan that a test asserted a
REPLICA of production logic instead of production logic — after the carrier fold and before it, the
fence. Each was fixed by extracting the rule to one exported function that both the caller and the
test use. The lesson is in the ledger.

**Finding 8's justification, stated so it can be checked rather than believed.** The plan's own omit
predicate says: "It is the exact predicate the engine already uses at the two sites that decide NOT to
speak something … if `spoken_owner = 'bundler'` can ever be set without the bundler speaking, two
shipped rules are already wrong and this one fails no worse." The finding is real; the class was
considered and accepted; the flag is default-off; and closing it means changing two already-shipped
rules. Carried to the follow-up queue with the finding attached rather than fixed under this plan.

### Round 2 — fix verification

One fresh lane against the fix diff (`11b48491` → `117cb01d`), asking three questions: does each fix
close its finding, did any fix introduce a new defect, and are the new tests real (would they fail
against the pre-fix behaviour, or pass either way).

**Verdict on round 1.** Of the ten findings, the lane closed eight, confirmed the two recorded
dispositions as deliberate rather than missed, and found three new defects — two BLOCKERs and one
IMPORTANT. It also reported that the three new tests it was asked to check are real: each fails
against the pre-fix behaviour.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 11 | BLOCKER | The entry-hook fix stamps the episode with the write's own board, but every snapshot write the episode then made went through the BARE mutator, which writes main's bucket whatever board the episode is on. A board-B walk set MAIN's circuit 3 while the note and the tombstone named board B. Closing the re-ask loop opened a cross-board write. | FIXED |
| 12 | BLOCKER | A `sets` derivation that OVERWROTE a pre-existing value made that field episode-owned, so it left `existing_values` and the directive permitted clearing it. Following the note would blank a certificate value that predates the walk, with nothing in the note saying it had existed. | FIXED |
| 13 | IMPORTANT | The fence-harness suite asserted log rows and in-memory `stagedText`, never the result delivered for speech, so a later finalizer or bundler change could drop an unfenced answer with every assertion still green. | FIXED |

Finding 11 is the FOURTH site of the one-board-normalisation class in this plan, and the first on the
WRITE path rather than the read path. The rule now holds as one sentence: inside an episode, every
read and every write resolves through `state.effectiveBoardId`.

Finding 12 needed a decision, not just a patch. The replaced value cannot travel in `existing_values`
— the value in that slot now is the derived one, and calling that pre-existing would be false — so it
travels in its own `derived_replaced` key and the directive gained one clause: restore it rather than
clear it. Ownership is now asked in two places (the note's filter and the baseline guard), so it is
ONE exported function in a zero-import leaf, not a predicate copied twice. That is the same pattern
finding 7 named, applied before a reviewer had to find it again.

Both fixes are red-proofed, and each reversion fails only its own test.

## Acceptance 9 — the live lane

Run 2026-09-23 against the real endpoint (`gpt-6-luna`, tier `fast`, effort `low`). Six cases: the
handoff notes from acceptance 1, 3 and 8, the device-absence case from acceptance 2, and both id-140
utterances. Full evidence, including the provenance table and the raw results, in
`PLAN-A-acceptance-9-live-lane.md` and `PLAN-A-live-probe-results-2026-09-23.json` in the handoff
directory.

Every case produced an audible outcome — zero SILENT turns, and both id-140 utterances, the reported
dead ends, now speak. Zero `start_dialogue_script` calls for a handed-off circuit (0 attempts, 0
re-entries). Zero applied writes of a value the dispatcher rejected. No pre-existing value cleared:
the device-absence turn cleared the one entry under `recorded` and left `existing_values` alone, and
the IR all-filled turn cleared nothing and read none of its three values back.

The probe drives production's ingress order — wrapper first, then the harness on the transcript the
wrapper handed forward. PLAN-A2's probe called the harness directly and its own review recorded that
as a limit; here it would have been fatal, because the note only exists because the wrapper made it.

One deviation is recorded and not fixed: on the id-140 "None." case the model dispatched THREE asks
in one turn where the directive says ask ONE. The turn was audible, so it is not the reported defect,
and the ask budget is not this plan's surface. It is in the repo todo queue with its evidence.

Two earlier probe runs reported two correct turns as SILENT. The probe was reading `result.readings`,
which does not exist, and filtering WS frames on keys the clears and the orphan prompt do not carry.
The fault was the instrument, not the code under test; both were fixed and the run above is the
corrected one. Recording it because a probe that under-reports success is the same hazard as one that
over-reports it.


### Round 3 — the circuit-breaker, recorded BEFORE the fixes

Three rounds, three sets of BLOCKERs, all in the multi-board area. That is the churn circuit-breaker
in `~/.claude/rules/planning.md`: stop patching and question the PREMISE. The condition below was
written before the fixes were made, so it binds whichever way the check came out.

**The premise check:** can a dialogue episode's board ever differ from the selected board?

- `record_reading` HAS NO `board_id` PARAMETER. `stage6-tool-schemas.js` says so in the
  `record_reading` block, and the calculators' own `board_id` comments give the history: "The circuit
  mutators' board_id was deleted by Plan 08B (2026-08-11); the calculators keep theirs because a
  cross-board calc is a legitimate read-mostly operation." The dispatcher stamps
  `EFFECTIVE_CIRCUIT_SLOT.boardId` from the resolved CURRENT board, so
  `effectiveBoardIdForReading` cannot return anything else.
- Therefore the scenario every board finding is built on — "an explicit `record_reading` for board B
  circuit 3 while main is selected" — **the wire cannot produce**. This is the A1b pattern from the
  rules file: rounds spent defending an unreachable scenario.
- **One path does remain**, and it is not the one the findings name: a script PAUSED for circuit
  creation lets the model run, `select_board` does not touch `dialogueScriptState`
  (`stage6-dispatchers-board.js` mutates `currentBoardId` and nothing else), and the resume then
  walks a stale board.

**The condition, committed in advance:** if the only reachable divergence is the paused-resume path,
close it with ONE fence rather than carrying the board through the wire frames and the bulk
enumerator. A further board finding after that fence is an escalation, not another patch.

**Dispositions.**

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 14 | BLOCKER | Script extraction frames omit `board_id`, so a cross-board episode's readings route to the wrong client row. | UNREACHABLE — fenced at the one reachable ingress |
| 15 | BLOCKER | An RCD→RCBO mirror overwrites a pre-existing `ocpd_bs_en` with no baseline, because the target is not an RCD slot and so is absent from `state.values`. | FIXED |
| 16 | BLOCKER | `handleBulkApplyReply` enumerates targets by parsing `snapshot.circuits` keys as integers, which excludes composite sub-board keys, then applies that main-derived set to the episode's board. | UNREACHABLE for a cross-board episode once fenced; the main-board enumeration is PRE-EXISTING and out of this plan's intent |
| 17 | IMPORTANT | The fence-harness additions assert delivered speech but still seed per-turn state through a zero-tool-call loop, so they do not red-proof a real clear-plus-answer dispatch. | ACCEPTED as accurate; recorded, not fixed |

Finding 14 and finding 16 are real descriptions of the code. They are not real descriptions of
anything an inspector can cause, once the resume path is fenced — and finding 16's main-board half
predates this plan by months and belongs to whoever next touches bulk propagation.

Finding 17 is correct and I am not going to overstate the fix. The `spoken_response` assertions are
genuine new coverage — they pin the projection a log row cannot — but the reviewer is right that they
would also pass against the prior code, so they are coverage, not a red proof. A real
clear_reading-plus-answer_user dispatch needs the tool loop unmocked with a stubbed vendor, which is
a new harness and not something to build inside a delivery round. It is in the repo todo queue.

### Acceptance re-audit — enumerated, not sampled

The plan has ELEVEN acceptance items, not nine. Before writing the outcome record I walked each one
against actual test evidence rather than recalling it, because an audit's completeness claim is
itself a claim and this one was about to be written into a lifecycle record.

| # | Evidence | Verdict |
|---|---|---|
| 1 | `dialogue-engine-first-miss-handoff.test.js` acceptance-1 block + live case 1 | PASS |
| 2 | fence matrix in `device-absence-fence.test.js` and `-harness.test.js`; live case 2 cleared `rcd_type` only and left `rcd_bs_en` | PASS — see the gap below |
| 3 | `breaking-capacity-advisory.test.js`; live case 3 wrote `ocpd_type = N/A` then asked | PASS |
| 4 | terminal-read-back suites | PASS |
| 5 | tombstone matrix in the handoff suite | PASS |
| 6 | "a DIFFERENT family enters through the ordinary entry loop" | PASS |
| 7 | the annotated-transcript case in the handoff suite | PASS |
| 8 | `all_filled_entry` case + live case 8 (nothing cleared, nothing read back) | PASS |
| 9 | `PLAN-A-acceptance-9-live-lane.md` | PASS |
| 10 | A3 case in the handoff suite; arbiter / verbatim-repeat / JSON-boundary carried from v3 | PASS |
| 11 | `terminal-readback-carrier.test.js` + `terminal-readback-recovery.test.js` | PASS |

**The audit found one genuine gap, in item 2.** Its fence matrix includes a CANCELLED-turn row —
"cancelled turn with a surviving clear → fenced, `ANSWER_FALLBACK_TEXT` NOT staged" — and nothing
covered it. The fence's own comment says it runs "on the NORMAL and the CANCELLED path alike", and
the cancelled path is exactly where the fixed apology would otherwise speak on top of the clears. Two
cases now cover it, with a negative control, and the positive one is red-proofed: neutering
`computeAnswerFence` fails it.

Had I written the outcome record from memory, item 2 would have been recorded PASS on the strength of
the rows that were covered. That is the failure mode the enumerate-don't-sample rule exists for.

### Round 4 — my premise argument was wrong, and the reviewer proved it

Round 3's dispositions above claimed two BLOCKERs were unreachable. **That claim was false, and the
round-4 lane demonstrated it against source.** I checked ONE write ingress and generalised from it.

- `set_field_for_all_circuits` **does** take a `board_id`, and stamps the named board on each per-ref
  `EFFECTIVE_CIRCUIT_SLOT` (`stage6-dispatchers-circuit.js`). So a tool-only bulk write can start an
  episode on a board the inspector is not standing at, with no `record_reading` involved. I had even
  read that schema — its description says "Scope the bulk write to one board" — and did not connect it.
- The iOS **`select_board` frame** assigns `stateSnapshot.currentBoardId` directly in
  `sonnet-stream.js`, with no reference to `dialogueScriptState`, and arrives on ANY turn. My
  reasoning was "the script owns the floor, so the model cannot select_board" — true, and irrelevant:
  the floor keeps the MODEL out, not the client. Divergence during an ACTIVE episode is reachable.
- Finding 16's bulk enumerator needed no cross-board episode at all. An ordinary walk on a SELECTED
  sub-board hits it, and my round-2 board carry made it worse: targets from main's numeric keys,
  writes to the episode's board.

The circuit-breaker was right that the answer was structural. It was wrong about which structure,
because I built it on a premise I had not finished checking.

**What ships instead — the invariant the codebase already had, restored.** `snapshot-write.js` used
to say "Dialogue scripts are circuit-scoped on the current board." PLAN-A's entry-hook change is what
invented the cross-board episode. So:

1. **A walk-through never STARTS on a board that is not selected** — the entry hook skips such a
   reading (`_entry_from_write_skipped_other_board`). The bulk write still lands and is still read
   back; it is just not a reason to start a conversation about another board.
2. **An episode whose board moves ENDS** — one shared `endEpisodeOnBoardDrift`, called at the
   every-turn ingress AND at resume, so the iOS frame is covered and not just the pause. Terminal
   read-back speaks, queued values are abandoned, the utterance falls through to the model. Honouring
   cross-wrapper isolation, as the broadcast pre-filter and active-path handler already do.
3. **"All circuits" enumerates THIS board** via `listCircuitRefsInBoard`.

With 1 and 2, an episode's board is always the selected board, so board-less extraction frames route
correctly and finding 14 dissolves for a reason that is now true rather than assumed.

| # | Disposition |
|---|---|
| 14 (frames omit board_id) | CLOSED by construction — episodes cannot leave the selected board |
| 15 (RCD→RCBO mirror baseline) | was already FIXED in round 3; lane confirmed |
| 16 (bulk enumerator) | FIXED properly |
| 17 (resume test proves too little) | FIXED — the control now performs a REAL resume, so the positive fails on the board and nothing else |

**Four tests asserted the design I removed and were rewritten, not deleted.** The cross-board write
test now runs with the sub-board SELECTED; the entry-hook test asserts the refusal AND keeps the
stamp/lookup agreement on a selected sub-board; the ordering test keeps the `continue`-not-`return`
property on the one shape that still reaches it (one circuit, two boards — two circuits is
intercepted earlier as a broadcast). All three new behaviours are red-proofed, and the resume
negative control stays green when the ender is neutered, so it cannot be passing for an unrelated
reason.

**The lesson, since it cost two rounds.** "This is unreachable" is a claim about EVERY ingress, and I
verified one. The circuit-breaker rule says question the premise; it does not say the first premise
you form is right. A premise argument needs the same enumerate-don't-sample discipline as an audit —
and mine should have started by listing every tool that can stamp a board, which is a five-minute grep.

### Round 5 — the binding holds; three IMPORTANTs, one of them not this plan's

Zero BLOCKERs. The lane confirmed the selected-board invariant for an active episode and showed its
enumeration: every `currentBoardId` writer (`ensureMultiBoardShape` seeding, session-start
hydration, `add_board`, `select_board`, the iOS frame — no board rename or delete dispatcher exists)
and every episode-creation path (regex `runEntry`, `enterScriptByName`, the post-dispatch entry hook,
`runPivot`, paused resume). That is the enumeration I should have produced myself two rounds ago.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 18 | IMPORTANT | A PAUSED episode can be replaced by another wrapper's entry before its owning wrapper or the resume fence runs, losing its applied operation with no read-back. | NOT THIS PLAN — evidenced below, follow-up queued |
| 19 | IMPORTANT | `effectiveBoardIdForReading` matched on field+ref only, so a turn writing the same field and ref on two boards attributed BOTH readings to whichever marker came first — and with the new selected-board check, the eligible reading was skipped as another board's. | FIXED |
| 20 | IMPORTANT | The board-drift exit never purged a dangling confirmation prompt, unlike the hard-timeout and broadcast-abort exits beside it, so a queued ring "All correct?" could play after the switch. | FIXED |

**Finding 18 is real and it is not a PLAN-A regression.** I checked rather than argued this time. Driving
a paused IR episode carrying one applied operation, then entering a ring walk through the production
wrapper, loses the IR state and its operation — **identically with and without board drift**:

```
NO DRIFT (same board) -> schema=ring_continuity ops=0  (IR paused state lost? true)
WITH DRIFT            -> schema=ring_continuity ops=0  (IR paused state lost? true)
```

The loss is in the paused-episode lifecycle and predates this plan; the board binding neither causes
it nor worsens it. Closing it properly means settling a paused episode through its OWNING schema at
every entry path, which needs schema resolution across wrappers — a structural change, not a
delivery-round patch. Queued with this evidence.

**Finding 19 was mine**, in the resolver lambda I wrote. The projected readings carry their own
`board_id` exactly when a turn spans two boards — the only turn where the board is ambiguous — so the
reading is now passed to the resolver and its declared board wins, with the marker scan kept for the
ordinary case and made to refuse rather than guess when markers disagree.

**Finding 20 was mine too**, and the giveaway was sitting next to the code: the hard-timeout exit
purges under `schema.confirmation?.buildMessage` and I wrote a new terminal exit without it.

Both fixes red-proofed. The first attempt at finding 19's test passed with the fix reverted — it
supplied its own resolver, so it proved nothing about the engine. It now asserts the engine PASSES
the reading and fails without it.

### Round 6 — the stop condition, written before the result

BLOCKERs by round: 3, 3, 3, 0. Round 5's remainder was two small local fixes (a resolver argument
and a purge call) plus one finding correctly outside this plan. That is a convergence shape, not a
churn shape, so round 6 is a verification of those two fixes and is intended to be the last.

**Committed in advance, so it binds whichever way it lands:**

- CLEAN or NIT-only → merge.
- An IMPORTANT in the two fixed areas → fix it and merge; those areas are four lines between them.
- **A BLOCKER anywhere, or any finding that reopens the board question → HOLD and hand to Derek.**
  Five rounds in one subsystem with two of my own premises disproved is the point at which my
  judgement about this area stops being the cheapest thing to trust. A sixth round's BLOCKER would
  mean the design needs an owner who is not the person who has now been wrong about it twice.
- Round 7 is not authorised by this condition under any outcome.
