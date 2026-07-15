# /ep execution log — field-feedback-2026-07-14 (PLAN-final.md)

- Session: `20260714T135523Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260714T135523Z-ep`
- Branch: `ep/PLAN-20260714T135523Z-ep` (base `main` @ 03fe73d7)
- Plan: 25-round /rp cap-reached; round-25's two §D2 fixes applied un-re-reviewed (extra verify-before-edit there).
- Deliverables: (1) backend PR, (2) iOS PR + TestFlight (nested CertMateUnified repo — own worktree), (3) web PR.
- Node 20 used for all test runs. `npm install` in worktree: OK.

## Steps

## Step A1(a) — backend dedupe_token + mirror + telemetry move
- Status: applied
- Decision: rule 1 (verbatim). One incident: a perl edit double-encoded stage6-event-bundler.js (UTF-8 read as Latin-1); detected by test mojibake failures, fixed by `git checkout` of the file and re-applying all edits via the Edit tool + a byte-safe python insert for the NUL-byte `confirmationDebounceKey` region. Final file verified valid UTF-8 with the 4 original NULs intact.
- Files: src/extraction/ios-dedupe-key.js, stage6-event-bundler.js, stage6-shadow-harness.js + 4 test files (1 new: stage6-shadow-harness-telemetry.test.js)
- Commit: f0a8197a
- Notes: 9 pre-existing bundler tests updated for the new `_confidence`-retained contract (deliberate, per plan). Token compositions: obs→`obs_<id>`, deletion→`obsdel_<id>`, clear→`clear_<field>_<circ|board>_<turnId|ordN>`, circuit_op→`circop_<turnId|noturn>_<idx>_<op>_<ref>`, designation→`desig_<scope>_<turnId>` (no token when turnId absent — bare-key fallback). Full backend suite green (4972).

## Step A2 — clear_reading wire canonicalisation + semantic clearer audit (deploy gate)
- Status: applied
- Decision: rule 1 (verbatim). Extracted the full iOS applySonnetReadings circuit-level wire→property mapping and the build-418 Stage6FieldClearer tables from the main-checkout Swift sources into a committed fixture; NEXT-table additions define exactly what the iOS PR must implement (r1_plus_r2→r1r2; max_disconnect_time(_s)→maxDisconnectTime→maxDisconnectTimeS; ocpd_breaking_capacity(_ka)→ocpdBreakingCapacity→ocpdBreakingCapacityKa; ocpd_max_zs_ohm→ocpdMaxZs→ocpdMaxZsOhm; ir_test_voltage(_v)→irTestVoltage→irTestVoltageV).
- Files: stage6-event-bundler.js (CLEAR_WIRE_EXEMPT + wire map), stage6-tool-schemas.js (CLEAR_READING_FIELD_ENUM, 3 exclusions), stage6-clear-wire-audit.test.js (NEW, deploy gate), tests/fixtures/ios-stage6-field-clearer.fixture.json (NEW), bundler tests.
- Commit: 2e09229e
- Notes: audit passes for all 28 enum fields under the NEXT table; build-418 lane proves no mis-clear during the rollout window (r1_plus_r2 + 4 gap keys are benign no-ops until TestFlight). r2_ohm exemption pinned as load-bearing.

## Steps A3, B3, C4-backend, INV-2 — delegated to subagents, reviewed, committed
- Status: applied
- Decision: rule 1; diffs reviewed before commit. A3 kept the guard chain intact (predicate-widen only, observation flavour after #5a re-parse). B3's sanitiser-positive fixture PROVEN rejected today (plain-sentence citation). C4 updated two handover tests that pinned the old "triptan bails to Sonnet" reliance (deliberate, per plan note). INV-2 threshold 2500 bytes/char.
- Commits: a28a1488 (A3), c40023c1 (B3), 7adbde01 (C4 rcd.js), a78147e9 (INV-2)

## Step A4 — pending-value write-or-reask guarantee
- Status: applied
- Decision: rule 1 with ONE [ASSUMED] (rule 2): the shape-4 "neither value nor field → apology" terminal applies within the chain; a 'none' ask with NO captured value and a non-field reply falls through to the LEGACY body instead of apologising — engaging there would break the mandatory no-CPC/Class-II question the plan explicitly preserves (pinned by regression test).
- Files: stage6-pending-value.js (NEW), registry, dispatcher-ask (broker `pvr-*`), overtake-classifier, sonnet-stream (pre-queue + direct-channel detector gate), harness (apology drain); 21+11 tests.
- Commit: 1ca886b4 (+ WS-level integration tests by subagent, committed later)

## Steps C1–C3, C4-prompt, D1-prompt, D2 — prompt wave + mechanics
- Status: applied
- Decision: rule 1. Round-25's two un-re-reviewed D2 fixes implemented with verify-first care: (a) chain identity implemented as a server-minted `clarification_chain_id` echoed via tool_result → continuation input (the only way a server-assigned per-observation id can survive the model round-trip; NOT ctx.turnId), budget key `observation_clarify#<chain>`; (b) three-way crack outcomes in prompt + tests. Prompt token caps raised 13200→14850 / 18400→20100 (dated rationale; mandated content measured ~1.6k tokens after a trim pass).
- Commits: 37900f2a (C1 fuzzy), aa5a3584 (D2 mechanics), f6fe0d63 (prompt wave)
- Notes: full backend suite green at every commit (5081 tests at the last run).

## Step docs — changelog + hub rows
- Status: applied
- Commit: 075dd01e (changelog.md entry + CLAUDE.md + AGENTS.md rows). No reference-file updates needed (no UI-field or extractable-field changes; new wire properties documented in changelog + contract comments).

## Step iOS (partial) — C4-iOS, A2-iOS clearer, INV-3
- Status: applied (in the CertMateUnified worktree `/Users/derekbeckley/Developer/CertMateUnified-ep-20260714T135523Z-ep`, branch `ep/field-feedback-2026-07-14-20260714T135523Z-ep`, base build-418 d541d2b)
- Commits: 67ffb9d (C4 zedi/icd in matcher + normaliser), 11a749d (A2 clearer — byte-matched to the backend audit fixture), b993034 (INV-3 dead guard deleted)
- Notes: A1(a/b) + B1 + B2 delegated to a subagent with the verbatim plan text; diff review before commit. D1 harness extension + A4 WS integration tests also delegated.

## Steps A4-tests, D1-harness, iOS A1/B1/B2 — subagent work committed
- Commits: eaf0e32d + 82506b6a (A4 WS integration tests, 78 green), 15b71cd0 (D1/D2 harness extension; BOTH original live probes PASS against the real model — D2 asked the exact targeted question and coded C3 post-answer; D1 reworded professionally and coded C2), 856ac1a (iOS A1a token decode + key precedence, A1b 30s TTL + ageless reservation with fast-path both-orderings, B1 dual-address suppression, B2 cue defer — ~29 new tests green on iPhone 16e sim).
- iOS agent deviations (reviewed, sound, pinned by tests): interrupt-reset releases+drops the parked bundler instead of re-dispatching (shared audioPlayer would be stolen mid-interrupt); pre-play discard re-dispatch hops one MainActor tick (queue re-entrancy). TTL_DROP_NEW combos unreachable through the public surface — documented.

## Codex diff review — cycle 1 (gpt-5.6-sol via codex exec CLI; MCP absent in this spawned session)
- 7 BLOCKERs, ALL in-scope, ALL applied (commit 7e55d7c5): board_id threading in createAutoResolveWriteHook (pre-existing drop); detector select aliases (squash + PME map); D2 net qualification narrowed (record_observation only; audibility-proving continuation outcomes only); broker retire() + net wiring; field_cleared token turn+ordinal (iOS vectors updated in the CertMateUnified branch, targeted suites re-run green); 4 extra D2 live fixtures + strengthened matcher; architecture.md Stage 6 section.
- ONE partial application flagged to cycle 2: unknown clarification_chain_id still MINTS a fresh chain (not validation_error) — rejection would be an inaudible failure; deliberate, argued in the r2 prompt.
- Re-gate after fixes: 5089 tests green.
## Codex diff review — cycle 2 (in progress at last context checkpoint)
- 4 BLOCKER + 1 IMPORTANT, all in-scope, ALL APPLIED (uncommitted at checkpoint — commit as "fix(voice): Codex review cycle 2"): (r2-#1) isPendingValueAsk eligibility predicate (missing_field-family reasons only) + flow engagement gated on pendingValue/pvr — closes the address-mirror hijack; (r2-#2) detector default branch counts any non-scope number as a value (schema-type-text numeric fields); (r2-#3) detector guard HOISTED before observation_clarify + step-3 shape branches in classifyOvertake; (r2-#4) sanitizeObservationRegulation ranks keyword-introduced candidates first + rejects bare leading-zero decimals; (r2-#5) 4 C1-C3 live-advisory fixtures written (c1_unmatched_designation_asks, c1_explicit_new_circuit_created, c2_garbled_rename_ref_asks, c3_clear_never_rehomes — expect key forbid_tools).
- NEXT STEPS (if resuming from summary): (1) confirm affected suites + FULL backend suite green; (2) commit cycle-2 fixes; (3) diff → PLAN-ep-diff-r3.patch, run codex exec cycle 3 (same prompt file pattern /tmp/codex-review-prompt-r2.txt, note applied r2 fixes, cap is 3); (4) on clean: backend push + gh pr create (READY) + merge + gh run watch + ECS verify; (5) iOS: docs rows (CLAUDE.md/AGENTS.md Recent Changes in CertMateUnified worktree /Users/derekbeckley/Developer/CertMateUnified-ep-20260714T135523Z-ep, branch ep/field-feedback-2026-07-14-20260714T135523Z-ep, 5 commits incl. 856ac1a) + push + PR + merge + TestFlight (deploy-testflight.sh from the ORIGINAL checkout after ff-pull; iOS full suite ALREADY GREEN); (6) web PR off updated main (A1 twin vectors regenerate from mirror; C4 web aliases; B1/B2 checks; A2 harness pin; parity-ledger rows); (7) finalize log, .ep-done, worktree cleanup, make-live ff-pull of REPO_ROOT.
- [NOTE] the 4 NEW D2 live-advisory fixtures are committed but their LIVE sweep hung (cache-keepalive loop, likely one ask's reply matcher not firing under --scenario-dir sweep; killed). ADVISORY lane by definition; the two ORIGINAL probes passed live. Follow-up: run the four individually via --scenario=<file> and tune the no-CPC matcher if needed.

## Codex diff review — cycle 3 (FINAL, cap reached)
- 3 BLOCKER + 1 IMPORTANT, all NEW (not bounces of applied fixes):
  1. [BLOCKER] A4 shape (2) unreachable for ORIGINAL asks: the flow-engagement gate requires a captured pendingValue or a pvr-* id, so an eligible missing-field ask whose capture returned null can't route a field-name reply into the chain. Fix per Codex: register `pendingValueEligible: isPendingValueAsk(input)` on the entry regardless of capture success, copy into the outcome, gate on it.
  2. [BLOCKER] Two DISTINCT same-turn circuit_designation ops still collapse before token stamping (perTurnWrites.readings is last-write-wins by design) — the plan pinned "two designation changes on one circuit → both speak". Fix: append-only designation-op log in per-turn-writes + dispatcher, synthesise per op.
  3. [BLOCKER] Pre-audible broker failures (register throw, ws closed, ws.send throw) end WITHOUT the terminal apology — runPendingValueChain treats every unanswered outcome as already-audible. Fix: broker distinguishes question_emitted from pre-emit failure; chain routes pre-emit failures to terminalApology().
  4. [IMPORTANT] Detector squashed-option matching over-matches ("not tested" → 'tt'; 'AC' inside "actually"). Fix: boundary-aware compact-option regex instead of unbounded substring.
- VERDICT at cap 3: CODEX-HELD (draft PRs opened). **Derek raised the cap to 15 ("Raise the review cap to 15 please and continue") — loop resumed.**

## Codex diff review — cycles 4-9 (cap raised to 15 by Derek)
- **Cycle 4** (commit 6ca7736d): applied all four r3 findings first (pendingValueEligible end-to-end; designationOps append-only log + per-op read-backs with `desig_<c>_<turn>_ord<N>` tokens; broker_emit_failed pre-emit terminal apology; boundary-anchored option matching). Review then found 6 NEW BLOCKERs, all applied: sonnet-stream direct-channel guard gains pendingValueEligible; classifier accepts null contextField as 'none'; ambiguous capture STOPS (no question fallback when transcript has candidates); span-aware scope-run parsing (lists/ranges/"circuit number N"); D2 net continuation must match the anchor's clarification_chain_id; token debounce → windowed per-key Map (A,B,A replay killed). +1 IMPORTANT self-marked OUT_OF_SCOPE (extraction-watchdog vs sequential brokered asks) → sanctioned follow-up #1. Full suite 5108.
- **Cycle 5** (commit 219dce52): 3 in-scope BLOCKERs applied: shape-4 terminal-apology reachability (engagement guard falls to legacy ONLY for non-eligible asks; no-CPC fixture corrected to prompt-mandated reason:missing_context); board-scoped designation tokens + board-matched expansion lookup (single-board tokens byte-identical — iOS vectors unaffected, verified); designation excluded from multi-circuit grouping (+ builder guard; __DESIGNATION__ leak). +1 OUT_OF_SCOPE (D2 mutation-to-chain correlation — needs observation tool-contract change) → sanctioned follow-up #2. Full suite 5112.
- **Cycle 6** (commit abf9ce79): 1 in-scope BLOCKER applied: validateClearReading enforces CLEAR_READING_FIELD_ENUM at runtime (`field_not_clearable`; schema enum alone is not enforced by Anthropic tools). Exposed 12 latent off-schema test fixtures across 6 files (Ze_ohms/volts/npts/board-field clears) — all corrected to real schema fields with in-range values; one test re-pinned to the §A2-canonicalised wire copy. +1 OUT_OF_SCOPE (generic pre-emission ask-audibility net) → sanctioned follow-up #3. Full suite 5116.
- **Cycle 7** (commit dd0eaf55): 2 BLOCKERs applied: unit binding beats scope inheritance in classifyNumbers (telegraphic "Zs circuit 4 0.30 ohms" captures + detector-completes; unit terminates the run); B3 bare regulation fallback requires the BS 7671 reference shape (measurements like "1.20 ohms" return null — CONSCIOUSLY SUPERSEDES the pinned 'Table 41.1'→'41.1' trade-off, that pin now asserts null). Full suite 5126.
- **Cycle 8** (commit 04ace2ed): 2 BLOCKERs applied: detector boolean branch honours schema type==='boolean' (+true/false vocab) — means_earthing_* readings no longer consumable as stale ask answers; ios_send_attempt emission + _confidence strip moved AFTER the last confirmation appender (A4 drain) so A3-orphan/D2-net/A4-apology prompts each get exactly one telemetry row. Full suite 5131.
- **Cycle 9: CLEAN — zero findings.** "The two cycle-8 fixes are faithful to the plan and correct in their surrounding call paths, and no new critical backend defect was identified." → SHIP.
- Convergence: 7→5→4→6→3→1→2→2→0 findings across 9 cycles; 28 in-scope findings applied, 3 sanctioned out-of-scope follow-ups logged.

## Sanctioned out-of-scope follow-ups (Codex-identified, plan does not authorise; carry to a future plan)
1. Extraction-watchdog (30s force-clear of isExtracting) can expire mid-chain when A4 brokers two sequential 20s asks — re-arm/defer the watchdog while pendingAsks is non-empty, with an absolute ceiling. (cycle 4)
2. D2 net cannot correlate a record_observation mutation to a specific clarification chain — add optional clarification_chain_id to the observation tool contract + prompt, evaluate each answered anchor per chain. (cycle 5)
3. Generic pre-emission audibility net for initial model-emitted asks: an ask suppressed before ask_user_started (restrained_mode / ask_budget_exhausted / validation_error) leaves a chime with no audible follow-up if nothing else in the turn speaks. (cycle 6)

## Completed
- **Outcome header: ALL PASSED — Codex gate CLEAN at cycle 9 of user-raised cap 15 (28 in-scope findings applied; 3 sanctioned follow-ups)**
- Plan steps: ALL applied (backend A1a/A2/A3/A4/B3/C1-C4/D1/D2/INV-2 + docs; iOS A1a/A1b/A2/B1/B2/C4/INV-3 + docs). Web PR (deliverable 3) NOT STARTED — blocked on the backend merge by design (vectors regenerate from the merged mirror); ledger rows for the web twin must accompany it.
- Backend suite: 5131 green (final). iOS full suite green (iPhone 16e).
- Assumed decisions: A4 no-CPC preservation (legacy fallthrough for non-engaging 'none' asks); mint-on-unknown chain ids (audibility over strictness — argued to Codex, not re-flagged in r3).
- Live probes: D1 + D2-original PASS live; 8 further advisory fixtures committed, live sweep run pending (one hung sweep noted).
- Stashes: none. Ship chain (backend merge → CI → ECS → iOS merge → TestFlight → web PR) recorded below.
