# /ep execution log — PLAN-B (designation hygiene, feedback ids 128+131)

- Session: `20260823T170031Z-ep` (chain hop 2, wave feedback-2026-08-23)
- Plan: `~/.claude/handoffs/EICR_Automation--feedback-2026-08-23/PLAN-B-final.md` (converged r22, reopened cap-30)
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260823T170031Z-ep` on branch `ep/PLAN-B-final-20260823T170031Z-ep` off `main` @ `e8f42d29` (includes PLAN-A's merge)
- Startup sweep: `ep-reap: reaped=0 held=0 working=1`

[PLAN-SIZE] this plan bundles ~12 execution items (8 ingress classes + 3 matcher surfaces + fixture) — one feature group (designation hygiene), so no split; expect a long Codex convergence.

## Steps

## Step B1-helper — canonicaliser + golden vectors + unit tests
- Status: applied
- Decision: rule 1 (verbatim). [ASSUMED] "a NEUTRAL dispatch-layer-owned module (beside record-reading-coercion.js)" implemented as a NEW zero-import sibling file `src/extraction/designation-canonicaliser.js` (not inside record-reading-coercion.js) — keeps `circuit-resolution.js`'s import free of the bs-code parser dependency chain; single plausible reading given the stated dependency-direction rationale.
- Files: src/extraction/designation-canonicaliser.js, config/designation-canonical-vectors.json (cross-platform contract for PLAN-B2), src/__tests__/designation-canonicaliser.test.js (34 tests)
- Commit: f4cb1c22

## Step B1-ingress-1..4 — create/rename/record_reading/bulk + speculator
- Status: applied
- Decision: rule 1. circuit_designation branch INSIDE coerceRecordReadingValue (covers dispatcher+bulk+speculator with one cleaned value); explicit reject-empty gates (`invalid_designation`) in all four dispatchers; create duplicate guard upgraded to trimmed case-insensitive canonical both orientations (stored side canonicalised too; canonical-empty stored rows can never block); rename/bulk deliberately gain NO duplicate guard (locked by test); speculator skips banned-only pre-observation.
- Files: src/extraction/record-reading-coercion.js, src/extraction/stage6-dispatchers-circuit.js, src/extraction/loaded-barrel-speculator.js, src/__tests__/stage6-designation-hygiene-ingress.test.js (18 tests)
- Commit: 8bf8bc45

## Step B1-ingress-5+8 — circuitsToCSV + process_job (+ extract_chunk/extract_session)
- Status: applied
- Decision: rule 1. Repair-never-reject inside circuitsToCSV (one boundary, six routes); process_job repairs extracted rows pre-salvage/CSV/PDF; extract_chunk + extract_session (live via /api/recording routes incl. /extract-transcript transitively) repair at egress + carry the prompt rule.
- Files: src/export.js, src/process_job.js, src/extract_chunk.js, src/extract_session.js, src/__tests__/designation-hygiene-persistence.test.js
- Commit: pending (batched post-agent to avoid lint-staged stash races)

## Step B1-ingress-7 — text-extract endpoints own-or-retire
- Status: applied (OWNED — both LIVE)
- Decision: rule 2. Liveness verified: sonnetExtractFromText ← ws-recording.js:531 (WS mounted at server.js /api/recording/stream); sonnetExtractFromAudio ← routes/extraction.js:1065 (sonnet-extract route). NOT retired; canonicalised at sonnetExtractFromText egress (covers both transitively) + sonnet_text_system.md prompt rule.
- Files: src/sonnet_extract.js, config/prompts/sonnet_text_system.md

## Step B1-grep-inventory (completeness authority)
- Status: applied
- Decision: greps run per plan. FINDINGS: (1) designation-write files — dispatchers-circuit ✓covered, eicr-extraction-session ✓seam (ingress 6), process_job ✓covered, dispatchers-board = BOARD designation (different field, out of product-rule scope), inspect-projector = read-only projection. (2) circuitsToCSV callers — jobs.js :744/:820/:1101, recording.js :243/:491, export.js :30, ocr.js :72 — ALL funnel through the repaired serializer (pinned by caller-inventory test). (3) test_results.csv writers — process_job :568 ✓repaired-upstream, ocr/recording ✓serializer, routes/pdf.js :45 = REPRINT of already-persisted CSV (not an ingress; pre-fix rows converge per B4). (4) streamed-tool consumers — speculator ✓, adapters/tool-loop/shadow-harness are plumbing to covered consumers. (5) circuit-row producers — extract_chunk/extract_session/sonnet_extract ✓egress-repaired; ccu-single-shot/ccu-sliding-window/ocr_certificate rows persist ONLY via the circuitsToCSV callers (accepted-import path) ✓class 5. No site found that fits no class.

## Step B2 — prompt one-liners + tool schema + prompt-contract test
- Status: applied
- Decision: rule 1. Edge-only wording (never "never include the word" — interior strip stays deferred) in sonnet_agentic_system.md (+DESIGNATION WORDING line after CIRCUIT NAMING), sonnet_extraction_system.md, sonnet_extraction_eic_system.md, sonnet_text_system.md, extract_chunk/extract_session inline prompts; create_circuit schema description aligned. Contract test pins the two kept examples + forbids interior-strip phrasing.
- Files: 4 prompt files, src/extraction/stage6-tool-schemas.js, src/__tests__/designation-prompt-contract.test.js

## Step B3-matcher — circuit-resolution.js
- Status: applied
- Decision: rule 1. All seven B3 sub-specs implemented: canonical pass-1 both directions, query-side canonical guard (empty → zero candidates; generic "the circuit" bogus-match eliminated), empty-canonical row exclusion (raw AND canonical, both passes), two-tier short-remainder guard (short=token-boundary; strict single-letter/numeric = bounded-reply or the three adjacency shapes tested against RAW text since stripDesignationFiller eats the leading "the"), pass-2 canonical stored tokens + user-side edge-token drop, matchedDesignation = canonical variant (mask-findable; sharedDesignation stays RAW for quote-back), round-19 pass-union on canonical-only admissions with raw-precedence preserved.
- Files: src/extraction/dialogue-engine/helpers/circuit-resolution.js, src/__tests__/circuit-resolution-designation-hygiene.test.js (16 tests incl. exact evidence strings)
- Notes: all 23 pre-existing dialogue-engine/circuit-resolution suites green (785 tests).

## Step B3-twins+resolver — legacy twins + answer-resolver census decoration (agent)
- Status: applied
- Decision: rule 1 via delegated agent; report verified. Twins gain query-side canonical guard + canonical-both-directions + empty-canonical exclusion + short-remainder tiers, byte-identical between the two scripts, NO fold table. Answer-resolver census DECORATED (designation_match_value + eligibility flag: full|token_boundary|bounded_only|ineligible), filtered only inside designation lanes (matchDesignation, §C1 fuzzy, quantified, exact lanes via shared keys helper); broadcast/"circuit N"/multi-ref/escalation read raw census untouched; dispatcher-ask decorates at census build.
- Files: insulation-resistance-script.js, ring-continuity-script.js, stage6-answer-resolver.js, stage6-dispatcher-ask.js + 2 new test files (51 tests)
- Notes: [ASSUMED] numeric-only remainders keep the PRE-EXISTING stop-word exact-lane behaviour (bare "7" already auto-resolved raw "Circuit 7" before B3 — locked, not changed). [ASSUMED] twins query "the circuit" → canonical "the" (twins never had a filler strip; pre-existing shape kept) — residual exposure requires a degenerate reply + designation containing literal "the"; left for Codex to weigh. Verified: 18 suites/983 tests required set + 210 suites/5220 broad sweep green.

## Step Tests-3 — field-replay fixture + oracle (agent)
- Status: applied (with two evidence-backed refinements to the plan's letter)
- Decision: per-concern split (the spec's SECOND sanctioned option) + atomic designation_hygiene oracle, single failure id per op.
  - [ASSUMED/applied-differently] Plan said "expected_red pre-fix → required_green"; the fix lands FIRST on this branch, so the fixture registers required_green + red_proof_failure_id (the corpus schema's documented fix-lands-first dual-proof admission) and the RED half is EXECUTED as a jest canonicaliser-revert test through the real dispatcher graph — an on-disk expected_red would have failed this branch's merge gate.
  - [ASSUMED/plan-premise corrected] the id-131 IR-entry half is STRUCTURALLY outside the recorded v1 boundary (processInsulationResistanceTurn runs pre-harness; declared `ingress` capability exclusion) — the evidence claim "recorded lane CAN lock these fixes" holds for the id-128 write half only. The id-131 fixture is frozen `unsupported_pending` (the corpus's designed parking state, reported every run) with a dual-proof promotion route in named_followup; the ask-half stays unit-locked by the pure matcher tests.
  - [ASSUMED] corpus CLI runner (scripts/voice-latency-bench/transcript-replay-direct-runner.mjs) touched out-of-listed-surface by necessity (~20 lines, injects readCircuitDesignation; precedented by toClearWireField).
- Files: fixture-schema.mjs, replay-assertions.mjs, replay-runner-core.mjs, transcript-replay-direct-runner.mjs, 2 fixtures (frc_6600a62a…, frc_db9ad2a8…), 2 test files (38+RED tests), field-replay-corpus.md section
- Notes: hand-authored per the corpus's documented process; no AWS access; validate-fixture ✓, field-replay 14 suites/261 tests ✓, replay:field-corpus 10/10 + 1 unsupported_pending exit 0, prepush strict gate ✓.
[FOLLOWUP] Dialogue-script ingress replay lane — recorded in frc_db9ad2a8's named_followup: the id-131 "srv-irs-" ask half is v1 ingress-excluded from the recorded corpus; a future ingress lane promotes the parked fixture via the dual RED+GREEN proof route; until then the matcher unit tests are the lock.

## Step plan00-collateral — post-00B corpus lane + manifest regeneration
- Status: applied
- Decision: rule 2. PLAN-B's two new corpus fixtures + two edited semantic-oracle inputs made the plan00 drift checks fail CLOSED (by design). [ASSUMED] resolution: explicit frozen POST_00B_CORPUS_FIXTURE_IDS lane (fixtures owned by the field-replay gate, added after the 00B cohort froze — pulling them into the reviewed safety-classified vendor cohort would corrupt 00B governance for a program closed 2026-08-07); all three join sites (partition test, lane-driver, evidence CLI) join over listVendorLaneCorpusIds; unlisted new fixtures still fail everywhere (fail-closed preserved). Manifest regenerated from the checkout (digest over 42 inputs, lane sha256s + combined anchor) — the same sanctioned step PLAN-A performed. plan00-expectation-manifest + plan00-lane-driver: 63/63 green.
- Files: expectation-projection.mjs, lane-driver.mjs, plan00-evidence/cli.mjs, plan00-expectation-manifest.test.js, plan00-expectation-manifest.json
- Commit: d455cbf9

## Step chain-pipeline — successor prefetch evaluated
- Status: applied (prefetch DECLINED per gate)
- Decision: PLAN-D-final is queued (.ep-queue) but DECLARES a hard ordering dependency on this plan ("PLAN-B must merge BEFORE D3's recorded fixture is locked", PLAN-D-final.md:395) → the no-overlap gate's declared-dependency clause fails → stay SERIAL. The normal chain spawns PLAN-D after this run completes.

## Codex diff review

### Cycle 1 — parallel 3-lens review (wire / silent / edge)
- Diff: PLAN-B-ep-diff-r1.patch (52 files, +4983/−89). Verdicts: wire lens 6 findings; silent lens 4 (after 1 dead-lens retry — full-transcript stream overflow, retried with toolOutputTokenLimit); edge lens 4 BLOCKER + 2 IMPORTANT (after 1 dead-lens retry — narration + empty findings, retried with resetSession). Merged + deduped: 13 in-scope findings + 1 OUT_OF_SCOPE/WITHIN_INTENT.
- [DEVIATION] cycle 1 — applied mixed-turn audibility for invalid_designation rejections; plan said only "REJECT with one invalid_designation validation error so the model retries or asks", original intent supports staging an audible notice even when a sibling success stands the catch-all down (evidence: "Audio-First invariants (hub CLAUDE.md, verbatim-loaded this session): every dictated reading read back exactly once; ask only for structural gaps/invalid values; latency is a bug."). Implemented via the EXISTING partial-failure family system (new invalid_designation family + scope-family membership; staged at all four reject sites); no cancellation-on-retry arbitration was added (consistent with every existing family — a retry-success plus notice is chatty, never silent).
- Fix distribution: canonicaliser standalone-dash + matcher query-side tier guard + audibility family = orchestrator (done, 843 tests green); seam wire-shape/op-collapse/NUL-byte/board-blind-dedupe = seam-agent; twins closed adjacency + query-tier mirror + board-scoped walk + resolver raw-vs-canonical collision = twins-agent; id-131 executable ingress lane + oracle board predicate + schema delimiter parity = fixture-agent; route/endpoint-level persistence tests = route-tests-agent.

### Cycle 1 fix status (agents)
- seam-agent: 4/4 applied (wire-shape {text,field,circuit} enumerable-only with Symbol-carried metadata; op-collapse REMOVED; NUL byte was inside the removed collapse's template key — 0 NULs verified byte-level; board-aware dedupe via getCircuitBucket at both sites). 55/55 own + 39-suite/758 sweep green.
- twins-agent: 4/4 applied (closed "the X circuit" adjacency; query-side tiers mirrored — SHORT queries downgrade to whole-token rather than banned outright, matching my shared-matcher implementation exactly; board-scoped twin walks via listCircuitRefsInBoard/getCircuitBucket; resolver raw-priority guarded by canonical-collision union→ambiguous). 42+35 tests green.
- orchestrator collateral fix: stage6-partial-failure-notices locked scope-family equality updated for invalid_designation (137/137 green).
- route-tests-agent: went idle WITHOUT a final report (silent-agent check applied — work inspected directly). Delivered 3 real new suites (extract-endpoints, route-jobs-export-ocr, route-recording) + extended persistence tests; its process_job end-to-end test was UNDRIVABLE (`import.meta.dirname` undefined under jest --experimental-vm-modules — pre-existing env limitation the repo already documents in export.test.js) and was REMOVED; process_job row-repair stays covered by helper unit tests + source pin. All 10 designation-hygiene suites green (171 tests).

### Cycle 1 finding counts: 14 in-scope (6 wire + 4 silent + 4/2 edge, deduped) + 1 sanctioned deviation → all APPLIED
### Mini-review (fix hunks): 6 findings (1 BLOCKER + 5 IMPORTANT) → all APPLIED (incl. one fix-of-a-fix: the op-collapse removal over-corrected and was restored board-keyed)
### Cycle 2: 4 findings (2 BLOCKER + 1 IMPORTANT + 1 NIT) → all APPLIED (strict-collision fallback key; injective board ordinal via the codebase's own spokenBoardOrdinal rule; per-ref bulk staging replacing the scope machinery; Unicode dashes)
### Cycle 3: 1 IMPORTANT (stale changelog rows re the now-executable id-131 fixture) → APPLIED
### Cycle 4: CLEAN — zero findings. VERDICT: **PASSED** (1 sanctioned plan deviation)
- Trajectory 14 → 6 → 4 → 1 → 0 across 4 cycles + 1 hunk-focused mini-review; 2 dead-lens retries in cycle 1 (transcript-stream overflow; narration+empty-findings), both recovered per the project's dead-lens playbook.
- Full gates re-run green after every fix cycle; final: backend 369 suites / 9,304 tests, web 157 files / 1,757 tests, corpus 11/11 executable, plan00 63/63, hub-size guard OK.

## Step B4 — existing-data note
- Status: applied (no code — documented decision)
- Decision: rule 1. NO retroactive cleanup (default per plan); save-path repair converges stored data organically. Open question for Derek recorded in Follow-ups.

## Completed 2026-08-23T20:45:00Z (Europe/London 21:45)

**Outcome: ALL PASSED (plan-deviation: 1 applied within original intent)**

### Plan deviations (read this first)
- **[DEVIATION] `invalid_designation` rejections are AUDIBLE in mixed turns.** The plan specified only "REJECT with one invalid_designation validation error so the model retries or asks"; Codex's silent-path lens showed a MIXED turn (sibling success standing the catch-all down) would drop the rejection in silence, verdict OUT_OF_SCOPE + **WITHIN_INTENT** with evidence quoted from the conversation context: *"Audio-First invariants (hub CLAUDE.md, verbatim-loaded this session): every dictated reading read back exactly once; ask only for structural gaps/invalid values; latency is a bug."* Shipped as a new `invalid_designation` partial-failure family staged at all four dispatcher sites (per-circuit targets from the resolved bulk candidates), with drain-side subtraction when a corrected same-turn retry lands — a retry-success is never double-spoken as a failure, and a dropped name is never silent.
- Four further execution refinements were accepted by Codex as within the plan's own sanctioned options/necessities (listed to it each cycle, never re-flagged): the id-131 fixture made EXECUTABLE via a new `dialogue_ingress` replay lane over the real `processInsulationResistanceTurn` (the plan's per-concern-oracle option, with the corpus's fix-lands-first dual-proof replacing the literal expected_red→required_green sequencing since the fix lands first on this branch); plan00's explicit `POST_00B_CORPUS_FIXTURE_IDS` lane (the two new corpus fixtures are field-replay-gate-owned, not 00B vendor-cohort members); board-scoped twin walks (pre-existing sub-board misroute Codex required fixing); the process_job end-to-end route test replaced by unit tests + source pin (`import.meta.dirname` undefined under jest vm-modules — pre-existing env limitation).

### Commits (15, feature branch `ep/PLAN-B-final-20260823T170031Z-ep`)
f4cb1c22 canonicaliser + golden vectors · 8bf8bc45 interactive ingresses 1-4 + speculator · 81ed9dd6 persistence/egress ingresses 5+7+8 · 171db30f B2 prompts + schema · 0e615f83 B3 matcher · 64121a9c twins + answer-resolver (agent) · 602d103d legacy seam (agent) · af535caf replay oracle + fixtures (agent) · d455cbf9 plan00 lane + manifest · d4a68f26 docs/changelog · 37738522 Codex cycle-1 fixes · ed98780b mini-review fixes · 57ab3cbc digest regen · c047ccf3 cycle-2 fixes · 7be189ae cycle-3 doc fix (+ the exec-log commit after this block)

### Assumed decisions (sanity-check these)
- Helper lives in a NEW zero-import module `src/extraction/designation-canonicaliser.js` (plan's "neutral dispatch-layer-owned module beside record-reading-coercion.js").
- Golden-vector contract path: `config/designation-canonical-vectors.json`.
- Numeric-only canonical remainders keep the PRE-EXISTING stop-word exact-lane behaviour in the answer-resolver (bare "7" already auto-resolved raw "Circuit 7" before this wave — locked by test, not changed).
- Twins keep NO filler strip (pre-existing shape); their query-side guard handles banned-only replies.
- SHORT (<3 char, non-strict) queries downgrade to whole-token comparison rather than being banned outright (preserves the shipped P3-A "EV" behaviour) — implemented identically in all four matchers.

### Skipped / blocked / failed steps: NONE (every plan step applied; one test file authored then removed as undrivable, see route-tests note above).
### Stashes left behind: none.

### Tests run + result (final state)
- Backend Jest: 369 suites / 9,304 passed (1 pre-existing skipped suite, 19 skipped tests), 0 failures.
- Web vitest: 157 files / 1,757 passed (1 skipped), 0 failures.
- Field-replay corpus: 11/11 executable fixtures pass, 0 unsupported_pending; prepush strict gate green; ~250 new PLAN-B tests overall.
- plan00: 19 suites incl. manifest + lane-driver green after digest regeneration.

### Follow-ups noticed
[FOLLOWUP] Cross-write designation collision framework — rename/reading/bulk designation writes have NO duplicate guard (deliberate, SWAP/REORDER contract); /rp rounds 10–17 drafted a stage-then-commit framework and the plan directs it to a vault todo seeded with those findings; smallest next action: Derek prioritises (or discards) it as its own plan.
[FOLLOWUP] Replace the legacy twins' hand-duplicated matchers with the shared `findCircuitsByDesignation` — now carrying three generations of mirrored fixes (edge-canonical, tier guards, board-scoped walk), the byte-identical-mirror maintenance cost keeps growing; separately-reviewable change, noted in both twin files.
[FOLLOWUP] Reconnect replay never re-enqueues buffered legacy `questions_for_user` (flushPendingExtractions) — pre-existing for ALL legacy questions, observed by the seam work; a clarification buffered across a disconnect is not replayed; smallest next action: decide whether the legacy off-mode path warrants it before the mode retires.
(+2 decision-class items routed to the /ep digest: B4 retroactive cleanup of stored designations — default NO shipped; interior-token removal — deferred, default NO shipped.)

