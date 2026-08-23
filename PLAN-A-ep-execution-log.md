# PLAN-A `/ep` execution log — feedback-2026-08-11 wave

- **Session:** `20260812T075528Z-ep` · **Plan:** `PLAN-A-final.md` (ids 114/116/123)
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260812T075528Z-ep`
- **Branch:** `ep/PLAN-A-feedback-2026-08-11-20260812T075528Z-ep` off `origin/main` @ `9c4e2557`
- **Chain:** `--chain`, hop 1. `PLAN-A2-final.md` converged mid-run and is `.ep-queue`d — it is the chain successor.

## Step 1 — §1.1 Morphological designation folding (id 116)
- Status: applied
- Decision: rule 1 (verbatim). Two-pass matcher in `findCircuitsByDesignation`: pass 1 byte-for-byte unchanged (eligible pairs collected during the same walk); pass 2 fold-table token-sequence containment on zero candidates, raw-offset token records, leading-filler dropped by dropping records, `matchedUserSpan` for unique matches only. Span threaded via `circuitResolutionMeta` → `maskCircuitResolution` designation branch BEFORE the literal search.
- Files: `src/extraction/dialogue-engine/helpers/circuit-resolution.js`, `src/extraction/dialogue-engine/engine.js`, tests `dialogue-engine.test.js` (+10), `dialogue-engine-correction-paths.test.js` (+7 masking variants incl. leading filler / doubled whitespace / hyphenation / punctuation-before-voltage / ambiguous no-arbitrary-pick).
- Commit: `89dc26dd`
- Notes: verified `reply` is one binding at both the lookup (:2614) and mask (:3267) sites, so span offsets line up. Pass-1 matches keep `matchedUserSpan: null` (literal search still owns them).

## Step 2 — §1.2 Value-first compound IR extractor (id 123)
- Status: applied
- Decision: rule 1 (verbatim). `schema.compoundEntryExtractor(text)` in `insulation-resistance.js` — label-pair-first (both orderings + gated "both" phrasing, never "both circuits"), bounded same-clause prefix (rejects `;`/CR/LF/contrast tokens), IR-qualification (sentinel/gt, explicit megaohm unit, closed connector set) + conflicting-unit rejection, exactly-one-qualified rule, whole-span `\bcircuit\s*\d{1,3}\b` guard. Consulted in `runEntry` on ordinary AND scope-conflict paths only when named extraction found neither IR slot, with RAW text.
- Files: `src/extraction/dialogue-engine/schemas/insulation-resistance.js`, `src/extraction/dialogue-engine/engine.js`, new `src/__tests__/dialogue-engine-compound-ir-entry.test.js` (34 tests: verbatim positive → both legs `>299`; all plan negatives on BOTH paths).
- Commit: `cac73360`
- Notes: [ASSUMED] "returned neither IR slot" implemented as `length === 0` on the named-extraction result — exactly equivalent for the IR schema (only L-L/L-E carry namedExtractors) and the natural generalisation for any future schema hook.

## Step 3 — Fix group 3: pending-value decline branch (id 114)
- Status: applied
- Decision: rule 1 (verbatim, truth table implemented exactly). Decline checked FIRST at the initial ask (after the engagement gate, so a decline at a NON-pending-value ask keeps existing handling — truth-table row 4) and at each brokered outcome; silent `user_declined` body; P4 net stays sole ack producer. Eligibility/capture hoisted pre-Promise; dispatcher-local fingerprint store + `recordDeclinedPendingFingerprint` callback; pre-registration short-circuit via the `multiDescriptionGenerationAbandoned` direct-return precedent (`answer_outcome:'user_moved_on'` + `dispatcher_error:'user_declined'` diagnostic on the canonical ask row). Vocabulary: `doesn't matter` → DECLINE_PHRASE_RE; `don't worry`/`doesn't matter` both-apostrophe forms → CANCEL_PHRASES; prompt line added.
- Files: `src/extraction/stage6-dispatcher-ask.js`, `src/extraction/stage6-answer-resolver.js`, `config/prompts/sonnet_agentic_system.md`, tests: `stage6-dispatcher-ask-pending-value.test.js` (+11), new `stage6-pending-value-decline-ingress.test.js` (5 — real dispatcher through the real harness, exactly-one-ack via `result.confirmations`), `stage6-answer-resolver.test.js` (+30 family matrix), `stage6-classify-decline-reply.test.js` (+6).
- Commit: `50f7c045`
- Notes: [ASSUMED] the match rule's "same normalised value AND circuit" is implemented as same-value-with-COMPATIBLE-circuit (equal or unknown on either side; conflicts already excluded) — a strictly-known-equal-circuit reading would exempt the primary id-114 retry, whose inverted shape never knows a circuit. Documented in-code. [ASSUMED] the plan's field-alias example (`rcd_trip_time`) is enum-blocked at `validateAskUser` today, so the alias fold ships as defence-in-depth and the committed test exercises the representable reformat (same canonical field, different reason/shape) instead.

## Step 4 — Documentation & delivery
- Status: applied
- Decision: rule 1. New ios-pipeline.md section; hub row (three oldest PLAN-2B round rows moved out to respect the enforced 45k budget — their detail already lived in changelog.md); full changelog.md entry. `check-hub-size` passes (44803/45000).
- Files: `docs/reference/ios-pipeline.md`, `CLAUDE.md`, `docs/reference/changelog.md`.
- Commit: `19c143d2`

## Step 5 — Test gate
- `replay:field-corpus`: PASS (exit 0, all verdicts pass).
- Full backend suite: first run hit host-level ENOSPC (root disk 99% full, 188MB free) — 22 failures, ALL `ENOSPC` in mkdtemp/write paths, zero code failures. Freed 2.5G (npm cache clean) and re-ran per ladder rule 5.
- Second run: 3 real failures, both drift pins working as designed — (a) the two prompt-cap regression locks (group 3's single additive prompt line landed with zero remaining headroom; re-locked at measured + ~100 per the 4e949b32/P8 precedent), (b) the plan00 `semantic_oracle_digest` (engine.js + stage6-dispatcher-ask.js are enumerated oracle inputs; regenerated by calling the real `computeSemanticOracleDigest`, per the 6fe0c2eb precedent — never hand-typed). Commit `34e8be74`.
- Third (confirmation) run: GREEN — 331 suites passed (1 skipped, pre-existing), 8486 tests passed, jest exit 0. Deploy gate: ALL PASSED (pending Codex diff review).

## Codex diff review
- Pipelined-successor prefetch: SKIPPED — `PLAN-A2-final.md` is queued but its instrumentation targets the same `runEntry`/engine.js paths this diff changes (the plan's own integration note declares the overlap), so the no-overlap gate fails; serial chain retained.
- Rate-limit episode 09:53–14:28: every MCP `ask-codex` attempt refused. Root cause found at 14:26 — the RAW `codex` CLI works; the refusals came from the MCP wrapper layer, and the "competing epx session" was this session itself. Review re-launched over `codex exec` directly (same model `gpt-5.6-sol`, high effort, read-only, schema-constrained output) — the transport changed, the review did not.
- **Cycle 1 (three parallel lenses: wire-contract / silent-path / edge-interaction):** 13 raw findings → deduped set of 9 substantive. APPLIED (commit `a8f28552`): fingerprint match rule tightened to the plan's strict same-field OR same-value-AND-same-circuit-knowledge (all three lenses); brokered `declineBody` now returns the decline utterance, not the initial answer; compound extractor — rightmost trailing-pair selection, `MΩ` delimiter fix, whole-suffix conflicting-unit scan, IR-subject anchor for connector qualification; pass-2 tokeniser folds ALL punctuation (letter/digit runs). APPLIED AS SANCTIONED DEVIATION (commit `43b6ad98`, Codex verdict WITHIN_INTENT with verbatim context quote — the Audio-First invariant): compound restatement co-dictated with the circuit answer routes through the M4 escape (guard + fresh-reading predicate), so its magnitude is never certified as the test voltage and the correction reaches the model.
- **[DEVIATION] cycle 1 — applied compound-restatement handling on the circuit-resolution turn; plan scoped `compoundEntryExtractor` to `runEntry` only; original intent supports it (evidence: "Audio-First invariants are MANDATORY: every dictated reading read back EXACTLY once (never 0, never 2); structurally complete readings written and read back").**
- REBUTTED (recorded for cycle 2, not applied): (a) rejecting compound shapes on a preceding unqualified number — the plan names `\bcircuit\s*\d{1,3}\b` as the SOLE scope marker and forbids inventing markers; an unqualified naked number can never certify. (b) widening `validateAskUser` for the `rcd_trip_time` alias — a validation-rejected ask emits nothing to the inspector, so the no-reask invariant already holds; enum widening exceeds the plan. (c) decline-ack bypass of confirmations-off — PINNED by the P4 net's own test (j) ("mode-off opted out of the spoken channel", feedback id 85); overriding a recorded deliberate decision is a human call → follow-up, not an autonomous override.

- **Cycle 2** (single-pass on the amended diff, `codex exec` detached): fixes verified; 2 in-scope IMPORTANTs → APPLIED (commit `9da566f3`): symbolic Ω/kΩ conflicting-unit alternatives; negative-sign candidate rejection.
- **Fix-hunk mini-review** (between cycles): 4 IMPORTANTs, all adjudicated as plan-letter or convention conflicts (whole-suffix rejection IS the plan's rule; mΩ case-insensitivity matches `parseBareMegaohmsWithUnit`; fingerprint board/field-arm extensions exceed the plan's enumerated rule) — carried into cycle-2/3 prompts as adjudicated items, none re-raised.
- **Cycle 3**: 2 narrower refinements of the cycle-2 fixes → APPLIED (commit `60ca8c5f`): OHM SIGN U+2126 in all three symbolic-ohm classes; signed digit-leading candidates hard-fail the whole extraction (`return []`), sign class widened, non-digit candidates exempt.
- **Cycle 4: CLEAN — zero findings.** "No new findings… No localized regressions found." VERDICT: **PASSED** (4 cycles, trajectory 9→2→2→0; convergence breaker armed at 2→2 but cycle 4 confirmed asymptotic polish, not churn).
- Re-gates: full suite green after cycle 1 (8498 passed + digest re-anchor `24fd3b2f`), full suite + corpus green after cycle 2 (8506 passed, corpus exit 0), affected suites (4503 tests) green after cycle 3; the pre-push hook re-runs the full gate at ship time.

## Completed (see final block below)

[FOLLOWUP] Decline acks are silent when the confirmations toggle is OFF — `stage6-shadow-harness.js` P4 net is wholly gated on `confirmationsEnabled` (pinned by test (j), feedback id 85), so an id-114 decline in that state resolves correctly but speaks nothing; Codex cycle-1 (silent-path lens) flagged it, and PLAN-D of this wave owns confirmations-off awareness cues; smallest next action: decide whether the DECLINE family should bypass the toggle (1-line emission-gate change + updating pinned test (j)).

[FOLLOWUP] Stale /ep worktrees left on disk — `EICR_Automation-ep-20260810T150718Z-ep` (1.3G) and `EICR_Automation-ep-20260811T184002Z-ep` (54M, the dead 08C session with a stale `.ep-claimed`); the root disk hit 99% mid-run and ENOSPC-failed 22 tests; smallest next action: verify each branch is merged, then `git worktree remove` (+ delete the stale claim if 08C's plan is superseded).

## Completed 2026-08-12T15:03:33Z

**Outcome: ALL PASSED (plan-deviation: 1 applied within original intent)**

**Plan deviations (read this first):**
- [DEVIATION] cycle 1 — applied compound-restatement handling on the circuit-resolution turn (engine.js: exclusive-voltage guard + `handleVoltageNoParse` fresh-reading predicate consult `compoundEntryExtractor` on the circuit-masked reply, routing through the M4 escape). The plan scoped `compoundEntryExtractor` to `runEntry` only; without the deviation, "circuit 7, greater than 250 L-L and L-E" certified 250 as the TEST VOLTAGE. Codex verdict: WITHIN_INTENT — intent_evidence (verbatim from the conversation context): "Audio-First invariants are MANDATORY: every dictated reading read back EXACTLY once (never 0, never 2); structurally complete readings written and read back; latency is first-class." Commit `43b6ad98`.

**Commits (oldest first):**
- `89dc26dd` fix(dialogue-engine): pass-2 morphological designation folding (id 116)
- `cac73360` fix(dialogue-engine): value-first compound IR entry extractor (id 123)
- `50f7c045` fix(stage6): pending-value decline branch + declined-pending fingerprint (id 114)
- `19c143d2` docs(plan-a): reference + changelog rows
- `34e8be74` chore: re-anchor prompt-cap locks + plan00 semantic-oracle digest
- `a8f28552` fix(ep): Codex cycle 1 (fingerprint strictness, decline reply text, extractor hardening, punctuation folding)
- `43b6ad98` fix(ep): plan deviation within original intent (compound restatement, M4 escape)
- `24fd3b2f` chore: digest regen for cycle-1 fixes
- `9da566f3` fix(ep): Codex cycle 2 (symbolic ohm conflicts, negative-reading rejection)
- `60ca8c5f` fix(ep): Codex cycle 3 (U+2126, signed-candidate hard-fail)

**Files touched:** `src/extraction/dialogue-engine/helpers/circuit-resolution.js`, `src/extraction/dialogue-engine/engine.js`, `src/extraction/dialogue-engine/schemas/insulation-resistance.js`, `src/extraction/stage6-dispatcher-ask.js`, `src/extraction/stage6-answer-resolver.js`, `config/prompts/sonnet_agentic_system.md`, `scripts/model-ab/plan00-expectation-manifest.json`, `docs/reference/ios-pipeline.md`, `docs/reference/changelog.md`, `CLAUDE.md`, 7 test files (2 new: `dialogue-engine-compound-ir-entry.test.js`, `stage6-pending-value-decline-ingress.test.js`).

**Assumed decisions:**
- [ASSUMED] §1.2 "neither IR slot" gate implemented as `length === 0` on the named-extraction result (equivalent for the IR schema; natural generalisation).
- [ASSUMED] the plan's `rcd_trip_time` alias example is enum-blocked at `validateAskUser`, so the fingerprint alias fold ships as defence-in-depth and the committed test exercises the representable reformat instead.
- (the earlier [ASSUMED] compatible-circuit widening of the fingerprint rule was REVERSED by Codex cycle 1 — the shipped rule is the plan's strict form with unknown===unknown knowledge equality.)

**Skipped / blocked / failed steps:** none — every plan step applied.

**Stashes left behind:** none.

**Tests run + result:** full backend suite GREEN (8,506 passed / 19 skipped pre-existing, jest exit 0) + `replay:field-corpus` GREEN (exit 0) after cycle 2; affected suites (4,503 tests) green after cycle 3; pre-push hook re-runs the full gate at ship. First full-suite run failed on host ENOSPC (disk 99% full — freed 2.5G npm cache); two drift pins fired by design (prompt-cap locks, plan00 digest) and were re-anchored per precedent.

**Codex diff review: PASSED** — 4 cycles (3-lens parallel cycle 1 → single-pass verifies), trajectory 9→2→2→0, 1 sanctioned deviation, 6 adjudicated rebuttals (none re-raised after adjudication).

**Follow-ups noticed:**
[FOLLOWUP] Stale /ep worktrees left on disk — `EICR_Automation-ep-20260810T150718Z-ep` (1.3G) and `EICR_Automation-ep-20260811T184002Z-ep` (54M, dead 08C session with stale `.ep-claimed`); root disk hit 99% mid-run and ENOSPC-failed 22 tests; next action: verify each branch is merged, then `git worktree remove` (+ clear the stale claim if superseded).
[FOLLOWUP] Decline acks are silent when the confirmations toggle is OFF — the P4 net is wholly gated on `confirmationsEnabled` (pinned by its test (j), feedback id 85), so an id-114 decline in that state resolves correctly but speaks nothing; PLAN-D owns confirmations-off awareness; next action: decide whether the DECLINE family should bypass the toggle (1-line emission-gate change + update pinned test (j)).
[FOLLOWUP] Declined-pending fingerprints carry no BOARD identity — circuit numbers repeat across boards, so a same-generation cross-board retry with identical field/value/circuit would be suppressed (contrived within one turn, but real); the plan's rule enumerates field/value/circuit only; next action: add a canonical effective-board component with knowledge-state semantics if multi-board sessions surface it.
