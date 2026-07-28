# /ep execution log — PLAN-final.md (honest-refusal-2026-07-25, plan B)

- Session: `20260728T033356Z-ep` (chain hop 3)
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260728T033356Z-ep`
- Branch: `ep/honest-refusal-2026-07-25-20260728T033356Z-ep` (base `origin/main` @ `1d4507ea`, post-A1a #123 + post-F #124 — the plan's required post-A1a base)
- Startup sweep: `ep-reap: reaped=0 held=0 working=1`

## Step 1 — Survey post-A1a source anchors
- Status: applied
- Decision: rule 1 — every symbol anchor in the plan verified present on post-#124 main (A1a machinery in `stage6-dispatchers-board.js`, A3 net `:2111`, net-0 drain `:2569`, marker-② `:2828`, both composition sites, both unknown-tool envelope shapes, enums, `field_not_clearable` at `stage6-dispatch-validation.js:261`).
- Files: none (read-only)
- Commit: none

## Step 2 — Shared refusal-notice registry + pure classifyBoardClear (§3.1 + §3.2 extraction)
- Status: applied
- Decision: rule 1. New `src/extraction/refusal-notices.js` (dependency-downstream-only): A1a families + `selectMandatoryNoticeText` moved VERBATIM (compat re-export kept in `stage6-dispatchers-board.js`), `stageMandatoryNotice` exported + extended (coveredToolCallIds/route/repeatKey, coalescing appends coverage, count bumps only on covered-acceptance incl. the round-14 first-transition rule), B-staged pools + all terminals + `renderMandatoryNoticeText` + `renderedNoticeInventory` + `spokenBoardOrdinal`. `classifyBoardClear` extracted pure from dispatcher steps 3–5; dispatcher consumes it. A1a suites 62/62 green unchanged (byte parity).
- Files: `src/extraction/refusal-notices.js` (new), `src/extraction/stage6-dispatchers-board.js`
- Commit: f249b28a

## Step 3 — Three-way field_not_clearable classification + unknown-tool staging (§3.2)
- Status: applied
- Decision: rule 1. `dispatchClearReading`: board-coverable (CANONICAL_BOARD_CLEARABLE canonical-vs-canonical) → bridge (denial family w/ coverage, or `wrong_tool_clear` on the scope-conditioned boardSlotKey); `CIRCUIT_FIELD_ENUM − CLEAR_READING_FIELD_ENUM` → `unsupported_clear` (field_schema label + circuit + board-ordinal discriminator); off-schema → `model_contract::offschema_clear` (raw string never renders). `createToolDispatcher` (string-form) + `createWriteDispatcher` (object-form) invoke a bound `onUnknownToolRefusal` callback at both live + shadow composition sites; envelopes byte-identical.
- Files: `src/extraction/stage6-dispatchers-circuit.js`, `src/extraction/stage6-dispatchers.js`, `src/extraction/refusal-notices.js`, `src/extraction/stage6-shadow-harness.js`
- Commit: b487a150

## Step 4 — A3 × coverage × recovery state machine + net-0 drain (§3.3)
- Status: applied
- Decision: rule 1. allRejected widened for hard-unknown_tool ask_user (round-15); coverage arbitration beside the classification, outside ORPHAN_PROMPT_ENABLED (round-17); branch 2 suppresses REJECTED_PROMPTS + entire orphan branch (no orphanContext — round-16); branch 3 stamps drain:false; net-0 drain gains drain!==false + wrong_tool_clear same-slot success/already-empty reconciliation (round-8, order-independent); rendering via `renderMandatoryNoticeText`; telemetry + route/covered_count.
- Files: `src/extraction/stage6-shadow-harness.js`
- Commit: 3512d1d2

## Step 5 — Tests (§5 matrix)
- Status: applied
- Decision: rule 1. 28-test main suite (`stage6-honest-refusal.test.js`) at the harness seam + 2-test `VOICE_ORPHAN_PROMPT=false` file (module-load env constant forces a separate file) + inventory wired into BOTH client-dedupe sweeps (marker-② union + client-watchdog ALL_BACKEND_LINES, both describes). One assertion adjusted mid-write: `orphanContext` is nulled (not undefined) by the harness's consume path — pin loosened to nullish, substance (no `{transcript}` reinjection) unchanged.
- Files: `src/__tests__/stage6-honest-refusal.test.js` (new), `src/__tests__/stage6-honest-refusal-orphan-off.test.js` (new), `src/__tests__/stage6-catchall-audibility-net.test.js`, `src/__tests__/client-watchdog-fallback.test.js`
- Commit: 157418a7

## Step 6 — Docs (§4)
- Status: applied
- Decision: rule 1. Changelog rows in hub CLAUDE.md + AGENTS.md + docs/reference/changelog.md; architecture.md refusal-registry paragraph beside the A1a net-0 entry; dated parity-ledger row `recording/honest-refusal-notices` (backend-only, owner Derek).
- Files: `CLAUDE.md`, `AGENTS.md`, `docs/reference/changelog.md`, `docs/reference/architecture.md`, `web/docs/parity-ledger.md`
- Commit: 4c7a3e17

## Step 7 — Gates
- Status: applied
- Full backend suite: **6416 passed, 19 skipped (pre-existing), 0 failed** (267/269 suites, 2 skipped suites pre-existing).
- Field-replay corpus: **9/9 pass** (general gate; NO recorded fixture for B by design — §5).
- NO recorded fixture authored (plan §5: the C06B9904 replay is A1a's; a B fixture lands only when a real captured turn contains a B-family refusal).

## [ASSUMED] decisions
- [ASSUMED] step 3 — the unsupported_clear board-ordinal clause renders whenever the slot's board component resolves to an ordinal (incl. single-board jobs with a boards[] array → " on board 1") because plan §3.5 rule (2) requires the rendered string to embed the FULL slot discriminator matching the repeat bucket, and the repeat bucket always carries the resolved board id. Legacy snapshots with no boards[] omit the clause (no second board can exist without boards[]).
- [ASSUMED] step 3 — `stageClearReadingRefusal` is wrapped in try/catch and staging failure logs `stage6.clear_refusal_stage_error` (best-effort beside the byte-identical envelope) — the plan specifies envelopes byte-identical but not the failure posture; fail-open to today's A3 behaviour is the fail-audible choice (§3.6).
- [ASSUMED] step 4 — branch-2 suppression logs a NEW info row `stage6.rejected_prompt_suppressed_by_refusals` (the plan forbids the orphan row on that branch but is silent on replacement forensics; a suppressed-generic with zero telemetry would be undiagnosable in CloudWatch).

## Follow-ups (running)
[FOLLOWUP] A3 REJECTED_PROMPTS wrap-silence for UNCOVERED rejections — `src/extraction/stage6-shadow-harness.js` (REJECTED_PROMPTS is a 3-string `turnNum % len` rotation); byte-identical wrap inside the client 30 s dedupe can silence a 4th consecutive uncovered all-rejected turn; pre-existing, named in plan §8.5 as declined-widening; smallest next action: widen REJECTED_PROMPTS to 5 variants or add an ordinal terminal like plan B's families.
[FOLLOWUP] Recorded fixture for a B-family refusal — none exists by design (plan §5); when a captured field session contains a dispatcher-authored refusal (unsupported_clear / wrong_tool_clear / model_contract), author a recorded-lane fixture locking the refusal audibility; smallest next action: watch session-analytics for `stage6.mandatory_notice_emitted` rows with `route != 'direct'` after deploy.

## Codex diff review (in progress at checkpoint)
- Cycle 1 ran as THREE serial lens reviews (rate-limit forced serial; @-inlining replaced by read-from-disk prompts + addDirs after discovering the MCP schema needed strict `additionalProperties:false`).
- MERGED cycle-1 findings (deduped): F1 partial-coverage drain:false stamped BEFORE recovery (all 3 lenses) — FIXED: stamp deferred into the `!recovered` branch, immediate only under flag-off; F2 direct→covered transition retained direct metadata losing the board ordinal (all 3) — FIXED: transition adopts incoming friendly/field/boardId/reason/turnId; F3 untrusted discriminators (malformed circuit, unresolvable board ordinal) could render byte-identical covered repeats — FIXED: stage nothing, leave uncovered (fail-audible via A3); F4 terminal byte mismatch "voice-clearable" vs plan "voice-CLEARABLE" — FIXED byte-exact; F6 repeat expiry anchored at stage time — FIXED: renderMandatoryNoticeText(nowMs) refreshes entry.lastAt at drain; F5 test-matrix omissions — FIXED: 10 new tests added (partial-coverage recovery, untrusted-discriminator, board-scoped direct↔bridge both orders w/ shared designation, two-circuit interleave to attempt 3+, attempt-6 terminals for ALL remaining direct families, cross-turn direct↔bridge Ze, unknown/offschema attempt-3 terminals, object-form partial coverage, capable-correction-via-already-empty both orders, fake-clock drain-anchor).
- HELD (cycle-2 adjudication): lens-b finding "backend 30s reset vs client playback-anchored dedupe TTL skew" — recommended fix is cross-client (new wire token honored by iOS+web dedupe), OUT_OF_SCOPE with intent_verdict WITHIN_INTENT quoting the ctx gotcha line. The in-scope drain-time anchor (F6) addresses the server-side drain-delay part; the residual client-side TTS-deferral skew is a pre-existing property of the WHOLE field-nil channel (A1a families, all apology rotations identical exposure). Cycle 2 will be asked to re-adjudicate severity given F6 + the pre-existing-class argument; if it still insists on the cross-client fix, run holds CODEX-HELD per rules.
- Next: re-run affected suites (running at checkpoint: bg task b7vmanw05), commit fixes as `fix(ep): address Codex review cycle 1`, re-gate full suite + corpus, cycle-2 review (single-pass verify, listing applied fixes + the held finding), then per-fix mini-review of fix hunks if cycle 2 finds more.

## Codex diff review — VERDICT: PASSED (cycle 2 clean)
- Cycle 1 (3 serial lenses): 5 deduped in-scope findings — ALL APPLIED (commit 80b251e5): F1 stamp-before-recovery, F2 transition metadata, F3 untrusted discriminators, F4 terminal bytes, F6 drain-time expiry anchor; +10 matrix tests.
- Per-fix mini-review: 1 IMPORTANT (deferral gate must equal the recovery block's exact eligibility — answer turns/content-gate combos left the stamp unconsumed) — APPLIED (commit 4ac5894c) + 2 answer-turn tests.
- Cycle 2 (full re-review): "Cycle-1 fixes are resolved and the amended implementation is faithful to the refined plan. No additional in-scope correctness defects." The single carried finding (client playback-anchored dedupe TTL vs backend drain-anchored reset window) was re-adjudicated: IMPORTANT, "explicitly non-BLOCKER for this backend-only diff", recommended_fix explicitly "Do not widen this backend-only plan into that coordinated wire change" (OUT_OF_SCOPE, OUT_OF_INTENT vs the backend-only plan/context). Logged as [FOLLOWUP] below per the held-finding rule — an independent reviewer's real finding is routed to the todo queue, not discarded.
- Final gates after all fixes: full backend suite 6428 passed / 19 skipped / 0 failed; field-replay corpus 9/9; A1a suites byte-green.

[FOLLOWUP] Playback-aware field-nil dedupe (cross-client) — the client 30 s text dedupe anchors at PLAYBACK start while the backend's refusal repeat-window anchors at drain; a deferred-playback client can swallow a reset-to-attempt-1 refusal repeat. Pre-existing exposure for the WHOLE field-nil channel (A1a families, all apology rotations); plan-B families are LESS exposed (ordinal terminals). Codex cycle-2 wording: "Make field-nil refusal dedupe playback-aware across backend, iOS, and web by carrying a unique refusal-occurrence token or playback acknowledgement; expire/reset repeat identity only after the client playback-anchored TTL has elapsed." Smallest next action: author an /rp plan for a refusal-occurrence dedupe token (rides the existing dedupe_token machinery from A1a-P2).

## Completed 2026-07-28T06:25:00Z
- **Outcome header: ALL PASSED** (every step applied or assumed; full backend suite green; Codex diff review PASSED after 1 fix cycle + 1 mini-review cycle).
- **Commits made:**
  - f249b28a refactor(stage6): extract shared refusal-notice registry + pure classifyBoardClear (plan B §3.1–3.2)
  - b487a150 feat(stage6): dispatcher-authored structural refusals — clear_reading three-way classification + unknown-tool routes (plan B §3.2)
  - 3512d1d2 feat(stage6): A3 × coverage × recovery state machine + net-0 drain refusal handling (plan B §3.3)
  - 157418a7 test(stage6): plan B §5 matrix — refusal routing, coverage arbitration, rotation/terminals, distinctness sweeps
  - 4c7a3e17 docs: plan B honest-refusal — changelog rows, architecture net note, parity-ledger row
  - 80b251e5 fix(ep): address Codex review cycle 1 — 5 in-scope findings applied
  - 4ac5894c fix(ep): address Codex per-fix mini-review — partial-coverage stamp gate matches recovery eligibility exactly
- **Files touched:** src/extraction/refusal-notices.js (new), stage6-dispatchers-board.js, stage6-dispatchers-circuit.js, stage6-dispatchers.js, stage6-shadow-harness.js; tests: stage6-honest-refusal.test.js (new, 40 tests), stage6-honest-refusal-orphan-off.test.js (new, 2), stage6-catchall-audibility-net.test.js, client-watchdog-fallback.test.js; docs: CLAUDE.md, AGENTS.md, docs/reference/changelog.md, docs/reference/architecture.md, web/docs/parity-ledger.md.
- **Plan deviations:** none (zero WITHIN_INTENT deviations applied; the one OUT_OF_SCOPE finding was re-adjudicated non-BLOCKER by Codex and logged as a follow-up, per its own recommendation).
- **Assumed decisions:** 3 (see [ASSUMED] section above — board-ordinal clause on single-board jobs; best-effort staging try/catch + warn row; suppression telemetry row).
- **Skipped / blocked / failed steps:** none.
- **Stashes left behind:** none.
- **Tests run + result:** full backend Jest 6428 passed / 19 skipped (pre-existing) / 0 failed; field-replay corpus 9/9 pass; A1a byte-parity suites green throughout.
- **Follow-ups noticed:** 3 — (1) A3 REJECTED_PROMPTS wrap-silence for uncovered rejections (pre-existing, plan §8.5); (2) recorded fixture for a B-family refusal once a real captured turn contains one; (3) playback-aware field-nil dedupe cross-client design (Codex cycle-2 held finding). All queued to todos-certmate.md.
- Deploy outcome appended below after merge + CI.
