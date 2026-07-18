# /ep execution log — PLAN-final.md (marker-② backend catch-all audibility net)

## Completed 2026-07-18T~13:30Z (see ship section below for merge/deploy results)

**Outcome: ALL PASSED** — every plan step applied (none skipped/blocked/failed), full backend suite green (5381 passed / 19 skipped / 0 failed), corpus 3/3, Codex diff review PASSED at cycle 7 with zero findings (trajectory 9→2→2→1→3→2→0; every BLOCKER/IMPORTANT either applied in-scope or declined strictly per the plan's own pinned decisions / Codex OUT_OF_INTENT verdicts — **zero plan deviations shipped**).

**Read these first (morning highlights):**
1. **Phase-0 corrected a plan assumption**: a successful `calculate_zs` compute is NOT audible (::calc:: writes are read-back-exempt by the 2026-06-18 design) — the exemption keys on `ok:true ∧ computed>0 ∧ skipped:[] ∧ clean loop ledger`, whole-turn. See the [ASSUMED] entries.
2. **The prompt was self-contradictory BEFORE this wave** (WAIT vs ORPHANED VALUES' "ask, don't wait") — likely the root of the live no-op nondeterminism. All sites now unified on ask-don't-wait; the old WAIT rules are gone (pinned by Group-0b tests).
3. **A pre-existing whole-class silent path was closed as a rider** (Codex cycle 2): generic tool-loop/transport errors no longer early-return an empty extraction — they take the F7 cancellation finalization, so ONE apology always speaks.
4. **KL-1 (known limitation, plan-pinned)**: the per-turn debounce exemption is coarse — a mixed duplicate-reading+empty-calc turn within 1.5s can still end silent. Finer-grained redesign judged OUT_OF_INTENT; consider for PLAN-C or a follow-up.
5. **Follow-ups needing scheduling (add to vault todos)**: F/U-1 deterministic spoken read-back of successful calc results (an explicit "calculate Zs" currently computes SILENTLY); F/U-2 rename_circuit same-ref no-designation silent edge; F/U-3 specific "already recorded" wording for already_set; F/U-4 **pre-existing prod contract drift** — the job_state seeder writes supply Ze as `circuits[0].ze` but both calc dispatchers read `circuits[0].earth_loop_impedance_ze` (seeded supply Ze is invisible to the calculators).
6. **POST-DEPLOY REQUIRED**: field-verify "Zs for circuit 4." speaks an apology (not silence), and run the three Phase-4 live probes — (A) bare, inputs missing → asks; (B) explicit "calculate Zs" with inputs → still computes; (C) bare with inputs → asks (pinned). Probe B may surface F/U-1 (the computed result has no deterministic read-back).

**Commits (15, oldest first):** c1580499 net · d6253422 fixture · a8e14bfb unit suite · 98418c9a prompt steer · 6df9b899 docs · dfd404a3 RED-vehicle migration · cbba25c1 steer trim + caps · cb60acc5 every-not-some · 0eeab216 partial-batch + probe wording · 7360c51f ledger guard · 9b833d02 prompt contradiction + error-path reroute · 17ee449a ORPHANED VALUES unification · 92a40eb9 fail-closed metadata · a88ea6be cycle-5 docs · 355e289d raw-stop + complete ledgers. (+ the execution-log mirror commit.)

**Files touched:** src/extraction/stage6-shadow-harness.js · src/__tests__/stage6-catchall-audibility-net.test.js (new, 24 tests) · src/__tests__/stage6-agentic-prompt.test.js · src/__tests__/field-replay/replay-runner-core.test.js · src/__tests__/field-replay/replay-cli.test.js · tests/fixtures/field-replay-corpus/frc_b6ec5356f67d8655db214b4f16ae8d83/fixture.yaml (new) · config/prompts/sonnet_agentic_system.md · CLAUDE.md · docs/reference/changelog.md · docs/reference/architecture.md · web/docs/parity-ledger.md (docs-only web touch).

**Assumed decisions:** see the two [ASSUMED] entries (calc-compute-is-silent exemption classification; fixture authored to the seeded state's actual `no_ze` reason per the plan's explicit fallback) — both sanity-checked by 7 Codex cycles.

**Skipped / blocked / failed steps:** none. **Stashes left behind:** none (the RED-proof stash was popped same-session).

**Tests:** backend Jest 5381 passed / 19 skipped / 0 failed; field-replay corpus 3/3 (new fixture RED-proven `audibility.turn` pre-fix, required_green post-fix).

- Session: `20260718T101843Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260718T101843Z-ep`
- Branch: `ep/numeric-gate-redesign-20260718T101843Z-ep` (base `main` @ `5aa08439`)
- Plan: `~/.claude/handoffs/EICR_Automation--numeric-gate-redesign-2026-07/PLAN-final.md`

Plan-size check: 5 phases, one subsystem (stage6 audibility nets) + one prompt steer — NOT a many-feature bundle; no [PLAN-SIZE] warning needed.

## Steps

## Step Phase-0 — outcome-classification table
- Status: applied
- Decision: rule 1 (executed as written); every row source-verified in the worktree.
- Files: none (investigation only)
- Commit: none
- Notes: **ONE PLAN ASSUMPTION CORRECTED BY SOURCE** — see calculate_zs outcome (a) below and the [ASSUMED] entry.

### Outcome table — every (tool, outcome) that can end a chimed turn with zero surviving confirmation/ask

| Tool | Outcome | Dispatcher signal | Already audible? | marker-② disposition | Positive signal (source) |
|---|---|---|---|---|---|
| record_reading / record_board_reading / set_field_for_all_circuits | success | perTurnWrites.readings entry, non-derived | YES — synthesiseConfirmations (bundler:853-864) | predicate-4 excludes | bundler:853-864 |
| same | success but confirmation DEBOUNCED | applyConfirmationDebounce drops entry (harness:1496-1515, `suppressed` local) | already-heard on a prior turn | EXEMPT via `debouncedConfirmationCountThisTurn > 0` | harness:1505 |
| record_observation / delete_observation / clear_reading | success | perTurnWrites.observations / deletedObservations / fieldCorrections | YES — synthesiseObservationAndClearedConfirmations (bundler:226+) | predicate-4 excludes | bundler:211-220, 311 |
| create_circuit / rename_circuit / delete_circuit | success | perTurnWrites.circuitOps | YES — state-change TTS (bundler:119-165); create/rename covered-by-reading falls to reading TTS | predicate-4 excludes | bundler:125-143 |
| rename_circuit | success, NO designation AND from_ref===ref | text stays null (bundler:133-140) | NO — silent edge | FIRE (uncertain → fire per plan bias); logged as follow-up F/U-2 | bundler:138-140 |
| add_board / select_board / mark_distribution_circuit | success | perTurnWrites.boardOps | YES — **board-switch VERIFIED audible**: "Switched to the X board"/"Switched board" always non-null (bundler:167-199; designation map harness:1057-1087) | predicate-4 excludes | bundler:177-183 |
| ask_user | emitted | onAskUserStarted → emittedAskToolCallIds (harness:643-662) | YES | predicate-4 excludes | harness:652 |
| ask_user | suppressed pre-emission | F7 net fires FIRST (harness:2036-2117) → prompt queued → drains to confirmations | YES via F7 apology | predicate-4 excludes (F7 prompt counted) | harness:2089-2098 |
| start_dialogue_script | script asks | dialogue-engine safeSend fires ASK_STARTED_OBSERVER → emittedAskToolCallIds | YES | predicate-4 excludes | harness:130-131 comment + F7 choke point |
| start_dialogue_script | script starts, asks nothing (edge) | ok body, no ask | NO | FIRE (uncertain → fire) | — |
| calculate_zs / calculate_r1_plus_r2 | **(a) computed>0 (wrote values)** | body `{ok:true, computed:[…]}`, is_error:false | **NO — writes carry `::calc::` source_turn_id and are EXCLUDED from spoken read-back BY DESIGN** (bundler:625-636 + 851-855, Audio-First #1 auto-derivation exemption, 2026-06-18) | **EXEMPT (designed-silent)** — signal: parsed body `ok===true && computed.length>0`. See [ASSUMED] + follow-up F/U-1 | bundler:634-636, dispatchers-circuit:924 |
| calculate_zs / calculate_r1_plus_r2 | (b) computed==0, missing-input skip (no_r1_r2 / no_ze) | body `{ok:true, computed:[], skipped:[{reason:'no_r1_r2'…}]}`, is_error:false | NO | **FIRE** (the target bug) | dispatchers-circuit:978-985 |
| calculate_zs / calculate_r1_plus_r2 | (c) computed==0, already_set skip | same shape, reason:'already_set' | NO | **FIRE this wave** (pinned Open-q1: never-silent wins; specific wording = follow-up F/U-3) | dispatchers-circuit:974-976 |
| calculate_zs / calculate_r1_plus_r2 | (d) rejected | is_error:true envelope | if ALL calls rejected → A3 allRejected net speaks REJECTED_PROMPTS | predicate-4 excludes; marker-② backstops mixed cases | harness:1615-1618 |
| (no tools) | model no-op | producedNothing | marker-① / A3 fires (chimed) | predicate-4 excludes → mutual exclusion (test h) | harness:1619-1700 |

Additional Phase-0 findings:
- **Produced-then-deduped signal (plan predicate-4 requirement):** the `suppressed` block-scoped local at harness:1505 is the correct capture point; Phase 1 lifts it into a `runLiveMode`-scoped `debouncedConfirmationCountThisTurn`.
- **Mid-stream canonical filter** (harness:1442-1475, `VOICE_MID_STREAM_FILTER`): when ON it can strip already-spoken-mid-stream confirmations, leaving a turn confirmation-less but heard. Flag is default-OFF in prod ("Re-enable when the mid-stream path is debugged"), so NOT added to the exemption signals this wave — noted for the PLAN-C watchdog wave.
- Follow-ups logged (NOT fixed here, per plan):
  - **F/U-1**: a chimed turn whose ONLY output is a *successful* `calculate_zs`/`calculate_r1_plus_r2` write is silent today (::calc:: read-back exemption + model not reading back the tool result). Pre-existing designed behaviour, but for an explicit "calculate Zs" command it is beep-then-silence-with-a-correct-write. Candidate fix: deterministic spoken read-back of calc results (dispatcher/bundler change, own wave).
  - **F/U-2**: `rename_circuit` with no designation and from_ref===ref produces no state-change TTS (silent success edge). marker-② FIREs on it (annoying-but-safe).
  - **F/U-3**: specific "those are already recorded" wording for calculate outcome (c) — a calculate_zs-dispatcher improvement.

## Step Phase-1 — hoist helpers + marker-② catch-all net
- Status: applied
- Decision: rule 1. Hoisted isAudibleText/isCurrentGenPrompt next to generationId; deleted F7+A4 duplicates; per-turn debouncedConfirmationCountThisTurn captured at the applyConfirmationDebounce block; net placed after F7, before §A4 drain; 5 rotating CATCHALL_AUDIBILITY_PROMPTS (string-distinct family, no shared stems); telemetry + try/catch per plan. Existing apology constants additionally exported so the Phase-3 distinctness assertion compares real values, not copies.
- Files: src/extraction/stage6-shadow-harness.js
- Commit: c1580499
- Notes: 56 pre-existing audibility tests green after the hoist. Exemption is outcome-based: parsed body ok===true && computed.length>0 (the ::calc:: designed-silent write) — see Phase-0 [ASSUMED].

## Step Phase-2 — recorded fixture
- Status: applied
- Decision: rule 1 (with the plan's own authored-to-actual-reason fallback). RED proven with the net stashed: "pass — expected RED confirmed: audibility.turn" (failed ONLY as audibility.turn); net restored → xpass; flipped to required_green changing ONLY gate_state + removing expected_failure_id. validate-fixture.mjs clean both states. Corpus 3/3 green post-flip.
- Files: tests/fixtures/field-replay-corpus/frc_b6ec5356f67d8655db214b4f16ae8d83/fixture.yaml
- Commit: d6253422
- Notes: [ASSUMED] the seeded job_state cannot express circuits[0].earth_loop_impedance_ze (the seeder writes supply Ze as the short `ze` key — eicr-extraction-session.js:1547-1552), so the fixture's actual skip reason is `no_ze`, not the plan's preferred `no_r1_r2`. The plan's Phase-2 parenthetical explicitly authorises authoring to the reason the seeded state actually produces; the no_r1_r2 variant is pinned in the Phase-3 unit suite instead. Also noted: a tracked symlink `packages/shared-types/node_modules` gets deleted by npm ci in a fresh worktree — restored via git checkout before committing (not part of the diff).

## Step Phase-3 — unit tests (a)–(h)
- Status: applied
- Decision: rule 1. New src/__tests__/stage6-catchall-audibility-net.test.js (orphan-net mock pattern; perTurnWritesRef mutation for bundler-real confirmations). 14 tests: (a) no_r1_r2 fire w/ Ze under the REAL dispatcher key + telemetry, (b) chime gate, (c) confirmations gate, (d) audible read-back exempts, (e1) produced-then-debounced exempts, (e2) silent non-calc write fires, (f) already_set fires (pinned), (g) board-switch verified-audible exempts, designed-silent computed>0 exempts, (h) marker-① mutual exclusion, whitespace + generation-ownership helper coverage, apology-distinctness (incl. D2 inline literals) + rotation.
- Files: src/__tests__/stage6-catchall-audibility-net.test.js
- Commit: a8e14bfb
- Notes: all 14 green.

## Step Phase-4 — prompt steer
- Status: applied
- Decision: rule 1 + the plan's probe-C pin delegated to /ep: pinned BARE-with-inputs → ASK (a computed value would mask the measured reading; "meter wins" is the existing product rule; compute stays one explicit verb away). ask_user example verified against config/stage6-enumerations.json (reason:missing_value, expected_answer_shape:number — first draft used an invalid `numeric_value`, corrected).
- Files: config/prompts/sonnet_agentic_system.md (tool blurb + Example 8 rewrite, one batched cache-invalidating change)
- Commit: 98418c9a
- Notes: live probes A/B/C are POST-DEPLOY verification (model behaviour, live-lane only) — listed in the morning summary as the field-verify step.

## Step Docs
- Status: applied
- Decision: rule 1. Hub row + detailed changelog entry + architecture.md nets paragraph + parity-ledger row `recording/catchall-audibility-apology` (docs-only web touch, dated, match).
- Files: CLAUDE.md, docs/reference/changelog.md, docs/reference/architecture.md, web/docs/parity-ledger.md
- Commit: 6df9b899

## Step Gate — full suite + corpus
- Status: applied
- Decision: rule 1, with two in-scope fixes the gate surfaced:
  1. **RED-vehicle migration** (commit dfd404a3): 3 field-replay gate-machinery tests used a chimed ANSWER-turn no-op as their controlled audibility.turn RED; marker-② heals that shape (deliberately no answer-turn gate — the plan's predicate list has none, and a truly silent answer turn IS beep-then-silence). Migrated to `confirmations_enabled:false` + `chime_observed:true` — permanently stable because every net is confirmationsEnabled-gated by design. Same migration class the marker-① wave performed.
  2. **Prompt token caps** (commit cbba25c1): the Phase-4 steer exceeded both regression locks; tightened the wording (~90 tokens), then re-measured + bumped caps house-style (base 14950→15180, combined 20200→20420, dated comments). Satisfies the plan's "confirm no token-budget regression" check as deliberate documented growth.
- Result: backend Jest 5369 passed / 19 skipped / 0 failed (5388 total); corpus 3/3.
- Commits: dfd404a3, cbba25c1

## Codex diff review

Mechanics note: the MCP wrapper (`mcp__codex-cli__ask-codex`) returned "Rate Limit Exceeded" for large review payloads (small probes fine, direct CLI fine) — reviews run via direct `codex exec --model gpt-5.6-sol --output-schema` instead (never downgraded, never skipped).

### Cycle 1 — three parallel lenses (wire-contract / silent-path / edge-interactions)
Findings: lens-a 0 · lens-b 5 BLOCKER · lens-c 4 BLOCKER (2 duplicates across lenses). Dispositions:
- **APPLIED** (b1≡c1) exemption existential→whole-turn: `calls.some(computed>0)` masked a sibling silent failure in a mixed turn → `calls.length>0 && calls.every(isDesignedSilentSuccess)` + 3 mixed-outcome regressions (computed+empty, computed+rejected, computed+silent-op). Commit cb60acc5.
- **APPLIED** (c2) partial-batch envelope: one call with computed:[…] AND skipped:[…] is NOT wholly designed-silent → skipped must be empty; board-scoped partial-batch regression. Phase-0 table row added below. Commit 0eeab216.
- **APPLIED** (c4) docs wording: hub + detailed changelog rows no longer read as if the Phase-4 probes were performed — now "REQUIRED post-deploy, not yet run at merge time". Commit 0eeab216.
- **RESOLVED-BY-EVIDENCE** (b2 "Phase-0 table omitted"): the table EXISTS — it lives in THIS execution log (the plan says "recorded inline in this plan", but the plan file is READ-ONLY under /ep's hard rules; the log is the run's deliverable record and is committed into the branch). Lens-c, given the log path, did not re-raise the omission. Tests cover every FIRE/exempt disposition row.
- **DECLINED — plan-decided, PLAN-C-owned** (b3 debounce≠actually-heard, b4 6th-repeat-in-30s rotation collision): both are the plan's DOCUMENTED accepted limitations of a backend-only net ("CLIENT-side dedupe is DELIBERATELY invisible to the backend net — covered by the client watchdog"; the rotation-collision paragraph is copied from the marker-①/NOOP design the plan mandates "ROTATING (turnNum % len) like the others"). Codex marked them WITHIN_INTENT quoting "I would also like this applied to the PWA and the iOS" — but that quote sits under the context file's **SUPERSEDED banner** (the watchdog was split to PLAN-C by Derek at /rp round 3), so the evidence guard fails and no deviation ships. The real fix is PLAN-C, already scheduled.
- **DECLINED — plan-instructed follow-up** (c3 silent successful-calc read-back): the plan explicitly instructs "log as a SEPARATE follow-up (do not fix here)" for designed-silent gaps; this is F/U-1. Codex's WITHIN_INTENT quote is the same superseded client-watchdog line (about clients, not a backend calc read-back) → guard fails. NB: post-deploy probe B may surface this gap live (an explicit "calculate Zs" computes but the read-back depends on the model's own follow-up) — feeds F/U-1's priority.
- **NEW FOLLOW-UP** (from b5) **F/U-4**: pre-existing production contract drift — `_seedStateFromJobState` stores supply Ze as `circuits[0].ze` while BOTH calc dispatchers read `circuits[0].earth_loop_impedance_ze`, so a job_state-seeded supply Ze is invisible to calculate_zs/calculate_r1_plus_r2 (live sessions only get the key via dictated Ze writes). Backend contract fix = own wave (Codex itself marked it OUT_OF_INTENT here). The fixture's no_ze authoring is the plan's own explicit fallback and stands.

Additional Phase-0 table row (c2): | calculate_zs / calculate_r1_plus_r2 | PARTIAL batch (computed>0 AND skipped>0 in ONE envelope) | body {ok:true, computed:[…], skipped:[…]} | NO (computed writes are ::calc::-silent; skipped silent) | **FIRE** (not wholly designed-silent) | dispatchers-circuit envelope shape |

Additional Phase-0 rows (cycle-5 completeness sweep — all non-error, zero-output outcomes; none matches the designed-silent signal `ok:true ∧ computed>0 ∧ skipped:[]`, so ALL are covered by the generic FIRE disposition, same class as test e2's silent non-calc op):
| record_reading | low-confidence capability PRE-APPLY skip (< 0.5 write gated by `low_conf_readback_v1` rollout step) | non-error body, no write applied | NO | **FIRE** | dispatcher capability gate |
| clear_reading | field already unset (nothing to clear) | non-error body, no fieldCorrection recorded | NO | **FIRE** | dispatcher no-op branch |
| delete_observation | id absent (idempotent no-op) | non-error body, no deletion recorded | NO | **FIRE** | dispatcher idempotent branch |
| set_field_for_all_circuits | applied:[] (no circuit qualified) | non-error body, empty applied | NO | **FIRE** | dispatcher fan-out result |

### Cycle-1 per-fix mini-review (fix hunks cb60acc5+0eeab216)
Findings: 1 BLOCKER, 2 IMPORTANT, 1 NIT. Dispositions:
- **APPLIED** (m1) loop-ledger exhaustiveness: `tool_calls` omits thrown dispatchers / padded `internal_no_result` / cap-hit synthetics → exemption additionally requires not-aborted, not-cap-hit, zero summed per-round errors, attempted==accumulated; missing ledger arrays fail CLOSED. 3 regressions (invisible-failure, cap-hit, malformed-skipped). Commit 7360c51f.
- **APPLIED** (m2) `skipped` must be a REAL empty array (missing/null/non-array = shape drift → fail closed). Commit 7360c51f.
- **DECLINED** (m3) duplicate-calc slot correlation — a later `already_set` after a same-turn computed write draws the generic apology; per the plan's FIRE-when-uncertain bias (spurious apology annoying-but-safe; computed write silent by design either way); a board-aware slot-correlation ledger exceeds plan scope.
- **APPLIED** (m4) docs updated to the full exemption contract + corrected test count. Commit 7360c51f.

### Cycle 2 — full re-review
Findings: 2 BLOCKER. Dispositions:
- **APPLIED** (r2-1) prompt self-contradiction: CORE DIRECTIVE 4 + EXTRACTION RULES line 48 said WAIT on a value-less "Zs...", contradicting Example 8 (and, discovered in the c2 mini-review, the PRE-EXISTING ORPHANED VALUES "ask, don't wait" rule — the prompt was already self-contradictory before this wave, which explains the live no-op nondeterminism). All sites unified on the ORPHANED VALUES contract; Group-0b content assertions; token caps re-measured (base 15240 / combined 20480). Commits 9b833d02 + 17ee449a.
- **APPLIED** (r2-2) generic tool-loop failure early-returned an EMPTY extraction before every net → beep-then-silence on any transport error (pre-existing hole). Now routed through the F7 Item-3 reduced finalization (cancelled latch): pre-crash writes still read back, the F7 nothing-audible fallback guarantees one apology, iOS gets a well-formed partial result, stage6_live_error retained. Regression test added. Commit 9b833d02.

### Cycle-2 per-fix mini-review (fix hunks 7360c51f..17ee449a)
Findings: 4 IMPORTANT. Dispositions:
- **APPLIED** (mc2-1) residual ORPHANED VALUES contradiction (see r2-1 above — cycle-2's field-only WAIT carve-out restated the stale side; removed; all sites now defer to ORPHANED VALUES). Commit 17ee449a.
- **APPLIED** (mc2-2) Example 8 board-scope note: `context_board_id` when working on a sub-board (ask-budget buckets separate per board only when supplied). Commit 17ee449a.
- **DECLINED** (mc2-3) generic-failure-after-an-emitted-ask can still end silent (the F7 cancelled-branch predicate treats a prior emitted ask as audibility): PARITY with the shipped F7 watchdog-cancellation semantics — building a separate genericLoopFailed audibility state machine exceeds plan scope; residual corner owned by PLAN-C (which sees actual playback).
- **DECLINED** (mc2-4) dialogue-script resume/entry hooks skipped on the failure path: same parity argument (identical to cancellation semantics; pre-fix the writes were lost entirely — strictly better now).

### Cycle 3 — full re-review
Findings: 0 BLOCKER, 2 IMPORTANT (both in-scope, applied — commit 92a40eb9): fully fail-closed exemption metadata (is_error===false positively; aborted===false; terminal_reason==='end_turn'; ledger elements validated non-negative integers with null-sentinel invalidation) + clean ledgers on the mixed/partial test mocks so the every()/skipped protections are the deciding factor.

### Cycle 4 — full re-review
Findings: 1 IMPORTANT — the coarse per-turn debounce exemption can mask a sibling silent outcome in a mixed duplicate-reading+empty-calc turn. **DECLINED / KL-1 (known limitation)**: the coarse semantics are the PLAN'S OWN PINNED DESIGN (Phase 1: "treat > 0 as speech-intent (exempt)"), and Codex's own intent_verdict was OUT_OF_INTENT for the finer-grained per-slot redesign — per the /ep hard rule an out-of-intent deviation never ships. Corner is vanishingly rare (identical reading repeated within 1.5s AND a calc request in the same utterance; the inspector heard the identical read-back moments earlier; a re-ask next turn fires marker-② normally). Flagged for the morning review.

### Cycle 5 — full re-review
Findings: 3 IMPORTANT (all docs/log completeness, applied — commit a88ea6be): architecture.md probe wording (required-not-verified), generic-failure finalization documented across all three docs + test count corrected, four Phase-0 completeness rows added (record_reading capability skip / clear_reading unset / delete_observation absent id / set_field_for_all_circuits empty applied — all FIRE via the generic disposition).

### Cycle 6 — full re-review
Findings: 2 IMPORTANT (both in-scope, applied — commit 355e289d): raw stop_reason==='end_turn' required (terminal_reason maps max_tokens to 'end_turn' and alone cannot prove clean termination) + ledger arrays must be complete (non-empty, length===rounds; empty is not zero). Abnormal-stop + truncated-ledger regressions; 24 tests.

### Cycle 7 — full re-review
**Findings: 0. VERDICT: PASSED.** Trajectory: 9 → 2(+4 mini) → 2 → 1 → 3 → 2 → 0.

- [ASSUMED] Phase-0/exemption — the plan describes calculate_zs outcome (a) computed+written as "(audible confirmation, fine)". Source shows the opposite: `applyCalculatedReading` stamps `source_turn_id:'::calc::<tool>'` (stage6-dispatchers-circuit.js:924) and the bundler EXCLUDES those writes from synthesiseConfirmations (stage6-event-bundler.js:625-636, 851-855 — the documented 2026-06-18 Audio-First auto-derivation exemption). The plan's own exemption clause ("must NOT apologise on a turn that legitimately did what the inspector asked with no read-back by design" / "proves it is a designed-silent side-effect") covers exactly this, so outcome (a) is classified EXEMPT with the positive outcome signal `ok===true && computed.length>0` — outcome-based, not name-based, per Resolved decision 1. Firing on it would be a false "say that again" after a successful write (the D2-documented worse failure). Logged as F/U-1 for a proper spoken read-back.
