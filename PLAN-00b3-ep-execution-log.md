# Execution log — Plan 00B-3 (oracle-evidence contract)

- Session: `20260804T183049Z-ep`
- Plan: `~/.claude/handoffs/EICR_Automation--00b-oracle-evidence-contract-2026-08-04/PLAN-final.md`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260804T183049Z-ep`
- Base branch: `ep/plan-20260804T070017Z-ep` @ `5386b0de` (pushed tip verified; local branch fast-forwarded 6e62f664 → 5386b0de before worktree add)
- Invocation: `--plan=… --no-chain` (policy sidecar: explicit_only + require_no_chain both satisfied)

## Pre-claim policy verification (all PASSED)

- 00A success record present, `terminal_class: shipped`.
- Predecessor plan SHA-256 `67fc03f1…` matches recorded value.
- Merge commit `9ea3bbaa` is an ancestor of fresh `origin/main` ✓.
- Artifact `plan00_tracked_bundle_provenance` at `.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity/provenance.json` on `origin/main` hashes to `537a0d51…` ✓ (checked against origin/main per the conversation-context gotcha — the working checkout is on an unrelated trial branch and does not carry the file).
- Live deployment: `eicr-backend:376`, rollout COMPLETED, runningCount 1 — exact match to the recorded runtime identity ✓.

## Startup

- `ep-reap: reaped=0 held=0 working=0` (sweep clean).
- npm install in worktree on Node v20.20.2 (1423 packages).

## Step C0 — contract schema + two-sided fixture + executable contract test
- Status: applied
- Decision: rule 1 (verbatim). Schema authored and committed FIRST (`1cbe14b2`), one pre-implementation amendment (`70da654e`: quiescence compatibility inverted to the CLOSED non-quiescent terminal set — the dispatcher terminal vocabulary is open-ended, grep-verified). Fixture naming decided: `tests/fixtures/test-contracts/plan00-evidence-contract/{schema-v1,snapshot-v1,projection-v1,snapshot-ineligible-v1,projection-ineligible-v1}.json` (TWO snapshot/projection pairs: eligible + ineligible, so freeze-row/rejected-case shapes are shared-fixture cases without contaminating the eligible session).
- The asynchronous PRODUCER_KINDS counter registry REMAINS a separate contract (not replaced) — recorded per plan C0.
- New evaluation-only modules: `src/extraction/plan00-evidence-registry.js` (closed producer registry backing both enums), `src/extraction/plan00-evidence-projection.js` (buildEvidenceProjectionV1 five-key-only + projectFrozenLedgersV1 + comparableSubset).
- **RED-proven at branch tip `70da654e`** (before any C1–C5 fix): `plan00-evidence-contract.test.js` → **32 failed / 19 passed**. RED classes map exactly to the plan: F1 (rejected-resolution publishes / no rejected-audit rows / no structural-latch rows), F2 (open asks in all three families leave freeze eligible; stop-race and stop-boundary-terminal cases), F3 (delivery rows carry no semantic family/producer; playback rows carry no hash/family; no producer_unknown fail-loud), C1-ternary (no idempotent audit row; no playback_rejected row), C5 (no freeze_invalid rows; unconsumed provisional not folded; api_transport absent from attributeRoundUsage AND the round_usage allowlist), three-way agreement (both sessions), SEMANTIC_ORACLE_INPUTS membership (7 paths). GREEN as expected: schema-drift checks, both two-sided fixture reconstructions, pre-admission telemetry (already implemented), accepted-resolution row, 00C-consumer exclusion.
- Commits: `1cbe14b2`, `70da654e`, `4beeecc4`

## Steps C1+C2+C3+C5 — implementation (commit `5646eafb`), C3 scan (`fa1d4ec8`), C4 (`24eec8ea`)
- Status: applied
- Contract suite 32-RED → **53/53 GREEN**; all four cycle-5 findings + every C5 field RED→GREEN through the REAL hooks.
- Sanctioned pin migrations executed in the same commits: audibility-ledgers :105/:116 → the `{accepted:false, reason}` no-latch contract (plus a new later-full-proof-still-succeeds case); lifecycle-hooks exact-shape pin gains the three `open_asks_*` keys; the `family:'fast_tts'` pin (:982 actual) → producer_id/semantic_family/transport split with per-ACK playback rows; the srv-ambiguity test migrated to `producerId:'dialogue_script_ask'`.
- `[ASSUMED]` C2 windowed-judge carve-out (rule 2 — single obviously-correct interpretation): the C2 fold flipped recorded fixture `frc_4687948e…` to INVALID_HOLD — its replay legitimately leaves the IR script's follow-up ask (`ir_live_earth_mohm`) emitted-but-unresolved at stop, and dialogue asks are OUTSIDE the corpus observation boundary (the `dialogue_answer_ingress` exclusion; the fixture cannot even declare the ask its transcript provokes). The plan requires BOTH the C2 rule AND mock lane 9/9 with a frozen corpus, so `composeCaptureInvalid` proceeds past quiescence ONLY when the sole non-quiescence is `open_asks_*` (every other count zero, revisions stable) — a stable open ask cannot mutate judged evidence. The FREEZE itself stays strict (ineligible + counts carry the ask — exactly what 00C's completion fold consumes; 00C's "non_quiescent_at_stop is always evidence-ineligible" rule is UNCHANGED). Two new pins; mock lane restored 9/9.
- `[ASSUMED]` C5 latch semantics (rule 2): freeze_invalid rows do NOT flip the completion latch's own `eligible` flag (it keeps its quiescence-only meaning; the judge reads the latches separately and the plan's pins only require "healthy freezes eligible" + "rows inside the latched snapshot with stable revisions"). C5 ineligibility rides the rows into the projection (`eligible_for_family_credit:false`) and the 00C fold rule.
- C4 RED evidence: the new discrimination assertions against the pre-change scenario list received **0** observation_update frames (the missing-coverage proof); with the legs added, matrix 4/4 and both `rule_6_edit` frames (code_change + correction_lead_in) pinned on the wire. Legs live in the LEGACY block — the RULE-6 classifier is a legacy-session seam; the frame egress under test (buildResultFrameLedger) is shared.
- api_transport threaded: adapters stamp `chat_completions`/`responses`; tool-loop + session attribution thread (`anthropic_messages` for bare SDK); allowlist retains it.
- Expectation manifest regenerated (combined `d0a90fbf…`, oracle `bf5cbdf7…`); 7 new SEMANTIC_ORACLE_INPUTS entries; 00C consumer exclusion pinned.

## Step — verification + docs + 00C amendment
- Status: applied
- 00C canonical PLAN-final.md: dated CONSUMER-half amendment (2026-08-04b) appended as an extension of the existing 00B-2 amendment — accepted/rejected row schema + closed rejection vocabulary + validation precedence + zero-credit + deterministic HOLD, ternary ACK verdicts, unknown-producer rows, canonical freeze-time row classes with the ineligibility fold rule, C0 artifact-reuse obligation. Handoff folders cited BY NAME only (bundle renderer fail-closed rule honoured). 00C refine log gained the matching dated note. Tracked bundle regenerated (`plan00-bundle-provenance.mjs --write`, 4 reference copies) and `plan00-bundle-provenance.test.js` green — the exact failure the conversation-context gotcha predicted was observed first (unregenerated amendment failed the full backend gate) then closed.
- Expectation manifest regenerated POST-implementation: oracle digest `fd570fd6…` (the earlier `bf5cbdf7…` regen was invalidated by later source commits — regen is order-sensitive; final regen after last src change).
- Docs: field-replay-corpus.md §Plan 00B-3; hub CLAUDE.md row; changelog.md full row. Commits `19c8aa3b` (+ implementation commits listed above).
- Field-replay corpus pre-push STRICT gate: **9/9 green**.

## Independent diff review (Codex, gpt-5.6 high)
- Cycle 1: three parallel lenses, **14 unique findings** → all fixed (`51a9799a`) + mini-review 1b (`05e5f732`: send-generation replay identity, regime-scoped rejected helper, fail-closed count reconciliation).
- Cycle 2: 3 findings (executable field-spec validation, regime composition, closed count domain) → `4570eba4`.
- Cycle 3: 3 findings — last cycle with any BLOCKER (stage-discriminated field specs, family-qualified rejection bindings, exhaustive real-output coverage) → `60ff22f5`.
- Cycle 4: 2 IMPORTANT + 1 NIT (sequence-positional rejection binding, stage/terminal matching, grammar closure) → `bb6ad498`.
- Cycle 5: 1 IMPORTANT (validating lifecycle state machine — terminals never reopen) → `3a54cbb6` + manifest regen `5c89803a`.
- Cycle 6: 1 IMPORTANT (lifecycle transition grammar joins the SHARED contract artifact) → `e6217996` + regen `35735c0b`.
- Cycle 7: 1 IMPORTANT + 1 NIT (grammar becomes ONE executable table; docs propagation) → `ebb56967` + regen `ec904466`.
- Cycle 8: 1 IMPORTANT, test-completeness only (hand-enumerated lifecycle matrix; state-preservation asserted for a subset) → `95c85cbb`: stage universe derived from LIFECYCLE_TRANSITIONS + asserted equal to the schema's non-join stages; full table-derived cross-product matrix; state preservation proven via discriminating follow-up transitions, documented skip rule `wouldBe !== priorClass` for the 7 no-discriminator cases. Manifest regen produced an IDENTICAL digest (test file is not an oracle input) — no regen commit needed.
- **Cycle 9 (final): CLEAN — zero findings.** A/B/C verified PASS (matrix genuinely consumes `LIFECYCLE_TRANSITIONS`; all 7 skips have no discriminator; commit is test-only). The reviewer's "D FAIL" was its own bare `npx jest` invocation missing `--experimental-vm-modules` (ran 0 tests); the repo-configured run passed **120/120** — not a regression.
- `[ASSUMED]` Convergence-breaker judgement (recorded in-session before cycle 8): finding COUNT plateaued at ~1 from cycle 5 but severity collapsed monotonically (zero BLOCKERs since cycle 3) and every finding since cycle 5 was a strict mechanical propagation of the previous cycle's own fix (runtime→schema→executable drift→test matrix→docs). Judged convergence-in-substance; continued within the cap of 10 with the bright line "any BLOCKER or IMPORTANT at cycle 9 → CODEX-HELD, no further argument". Cycle 9 was clean.

## Completed — outcome: ALL PASSED
- Verification: backend **7930 passed / 0 failed** (19 pre-existing skips); contract suite 120/120; mock semantic lane **9/9**; field-replay pre-push strict gate green; expectation manifest regenerated on the settled tree (current oracle digest `b4679079640e9d68`).
- Codex diff review: 9 cycles, final verdict CLEAN (cap 10 not reached; convergence bright line honoured).
- Commits: 19 on `ep/plan-20260804T070017Z-ep` atop 00B-2's held tip `5386b0de` (schema-first C0 `1cbe14b2`/`70da654e`/`4beeecc4`, implementation `5646eafb`, C3 scan `fa1d4ec8`, C4 `24eec8ea`, docs+00C amendment `19c8aa3b`, review fixes `51a9799a`..`95c85cbb`).
- `[ASSUMED]` entries this run: (1) C2 windowed-judge carve-out — option-gated `windowedOpenAskFamilies`, lane driver declares `['dialogue_script']` only (dialogue asks are outside the corpus observation boundary; freeze itself stays strict); (2) C5 latch semantics — freeze_invalid rows ride the projection as `eligible_for_family_credit:false`, never flip the quiescence latch; (3) the convergence-breaker judgement above.
- Follow-ups (not defects of this run): `packages/shared-types/node_modules` is a TRACKED symlink at base `5386b0de` (mode 120000) — npm install deletes it, restored to base each time; worth untracking in a hygiene commit. The MCP codex-cli wrapper cannot see `/opt/homebrew/bin/codex` — `codex exec` via shell is the working path.
- Ship: pushed → PR #154 READY → merged → CI deploy watched (task-def revision increment + Deploy job conclusion, never rolloutState) — see Ship section below.
