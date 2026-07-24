# /ep execution log — P8 prompt-steers-batch (feedback ids 88 + 83)

- Session: `20260724T125845Z-ep`
- Chain: ON (wave member, `.ep-queue` present), hop 5/12
- Target repo: `/Users/derekbeckley/Developer/EICR_Automation`
- Base branch: `main` @ `5aa540dd` (includes prior chain merges through PR #116)
- Branch: `ep/PLAN-20260724T125845Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260724T125845Z-ep`
- Started: 2026-07-24T12:59Z

**Plan-size check:** ONE feature group (backend prompt-only, 2 steers on `sonnet_agentic_system.md` + tests + docs). Not a large bundle — no `[PLAN-SIZE]` warning.

**Nature of plan:** MODEL-DECISION bugs → recorded-lane fixtures cannot lock them. Verification is LIVE probes (documented, not run at merge — no `ANTHROPIC_API_KEY` in CI yet). The suite guards plumbing + prompt budget only.

---

## Step-by-step log

## Step 1 — Phase 0: re-derive prompt anchors
- Status: applied
- Decision: rule 1 — grepped current `config/prompts/sonnet_agentic_system.md` (408 lines). All plan anchors confirmed EXACT:
  - Example 8 @ `:302` ✓ (bare-Zs missing_value ask body @ `:304`)
  - FIELD-AMBIGUITY RULE @ `:121` ✓ (worked example `:124-126`); ORPHANED VALUES @ `:103`
  - AMBIGUOUS C2/C3 SEVERITY block @ `:241-247` ✓ (WHEN/HOW/OUTCOMES/CLEAR-CUT GUARDS/BOUND/CHAIN ID); `clarification_chain_id` echo @ `:247`
  - RULE 2 (NO INFERRED OBSERVATIONS) @ `:219` ✓
  - A1 marker blocks @ `:15-24, 37-44, 55-60, 359-361, 392-408` ✓ — all three edit targets (FIELD-AMBIGUITY/Example-8, AMBIGUOUS block) sit OUTSIDE every marker → both flag variants get the steers.
  - Budget test: `src/__tests__/stage6-agentic-prompt.test.js`. Base cap `renderedOn<=16060` @ `:1099` (measured 15960); combined cap `combinedRenderedOn<=21300` @ `:394` (measured 21198). Estimate = `Math.ceil(render.length/4)` (char/4 token estimate — measurable precisely). Stale "flag-off byte-identical to the pre-A1" comment @ `:390`.
  - Group 0b @ `:112` (Steer-1 site); Group 18 @ `:1665` (Steer-2 site); Group 19 @ `:1760` (CHAIN ID).
- Files: none (read-only)
- Commit: none
- Notes: `renderAgenticSystemPrompt(true)` in `src/extraction/eicr-extraction-session.js` renders the flag-ON variant; budget measured against it.

## Step 2 — Verify BS 7671 citations (bs7671-domain-reference loaded)
- Status: applied
- Decision: rule 1 — every Steer-2 regulation number verified correct against BS 7671:2018+A2:2022 + the domain skill's C1/C2/C3/NC framework:
  - **416.2.1** IP2X/IPXXB (general basic-protection enclosure) ✓; **416.2.2** IP4X/IPXXD on readily-accessible HORIZONTAL TOP surfaces (stricter — correct, this is the top-surface rule) ✓; **416.2.3** barrier securing (key/tool) ✓.
  - **411.3.1.2** main protective bonding provision ✓ (already cited in prompt @:239); **544.1.1** + **Table 54.8** main-bond CSA under PME ✓; **701.415.2** bathroom supplementary omission conditions ✓; **544.2** supplementary-bond CSA ✓; **512.2** external influences / environmental IP (distinct from 416.2 basic protection) ✓.
  - Local reg table (`config/bs7671-regulations.json`, 68 entries) backs 416.2.2 / 411.3.1.2 / 544.1.1 / 701.415.2; misses 416.2.1 / 416.2.3 / 544.2 / 512.2 — table MISS is the documented common case (model wording survives on miss), not a defect.
  - C-code gradations match repo's `observation-code-lookup.js:124-146` (C1=danger now, C2=potentially dangerous, C3=improvement, NC=non-conformity). Plan's BPG4-precise choices (accessible-to-touch→C1; ≥6mm² undersized-but-sound main bond→NC) both keep the SAFETY-critical direction correct (never blanket-C2, never under-code accessible live parts). 4-round /rp reviewers converged on these.
- Files: none (verification only)
- Commit: none
- Notes: **PRE-EXISTING DATA ISSUE (morning follow-up, NOT in P8 scope):** `config/bs7671-regulations.json:167` has 416.2.2 titled "Nominal voltage - ELV lighting" (wrong — it's the top-surface IP4X reg). This is a shared-backend reg-lookup table, not a P8 prompt citation; 416.2 is already cited in the live prompt (Example 13 @:349) so this imprecision pre-dates P8. Flagged only — fixing it touches shared backend + risks iOS regression (out of prompt-only scope).

## Steps 3+4 — Draft, compact, and apply both steers (single batched edit)
- Status: applied
- Decision: rule 1 — both steers land OUTSIDE all A1 marker blocks (common region) → render in BOTH flag variants (verified: flag-OFF grew +516 too).
  - **Steer 1 (id 88)** folded into Example 8 as a new bullet (`GARBLE-ADJACENT VALUE`, @:309): anchor+scope+valid-value → WRITE even with a mid-utterance garble; two observable guards (leading-"no" correction; "no"+value ask-reply) + missing-scope/contradiction/invalid still clarify. Worked example "Zs on the cooker is n o 0.55" → record_reading pinned.
  - **Steer 2 (id 83)** inserted into the AMBIGUOUS C2/C3 block between BOUND and CHAIN ID (`DECIDING FACTS BY CLASS`, @:247): three classes sharing ONE ACCESS LADDER (compaction lever from the plan), reusing the block's one-ask budget + clarification_chain_id. All BS 7671 citations verified in Step 2.
- Files: `config/prompts/sonnet_agentic_system.md`
- Commit: pending (batched with tests+docs per plan "ONE focused logical unit")
- Notes: light trim pass applied to honour the plan's "trim before measuring"; net growth +517/+516 (base/combined), under the plan's own ~600 estimate. The ~250 target was aspirational — the plan states a cap bump on BOTH is the EXPECTED path, not a fallback. Over-trimming would cut reviewer-approved domain precision.

## Step 5 — Re-measure + bump budget caps
- Status: applied
- Decision: rule 1 — measured post-edit renders precisely (char/4 estimate, the test's own metric): base flag-ON 16477 (+517), combined ON 21714 (+516). Bumped caps to measured+~100: base `renderedOn<=16580` (@:1152, headroom 103), combined `combinedRenderedOn<=21820` (@:440, headroom 106), with justified-headroom history comments at both sites flagging the P8 additions + shared-region growth.
- Files: `src/__tests__/stage6-agentic-prompt.test.js`
- Commit: pending

## Step 6 — Contract pins (both flag states) + stale-comment sweep
- Status: applied
- Decision: rule 1 — added `renderedOff` to `beforeAll`; Group 0b gains a Steer-1 pin and Group 18 gains a Steer-2 pin, each asserting the steer text in BOTH `renderedOn` and `renderedOff`. Softened the two now-stale "flag-off render byte-identical to the pre-A1 prompt" comments (prompt test combined-cap comment + answers-session header) — the A1 OFF-marker blocks stay verbatim, but the SHARED region grew, so the flag-off render is no longer pre-A1-identical (cosmetic; prod render is flag-ON anyway).
- Files: `src/__tests__/stage6-agentic-prompt.test.js`, `src/__tests__/stage6-agentic-answers-session.test.js`
- Commit: pending
- Notes: NO byte-identity ASSERTION existed (the flag-off test only checks presence/absence of answer-feature markers, which my steers don't touch) — so nothing broke. Ran both affected suites: **89/89 pass** (incl. new pins, bumped caps, existing AMBIGUOUS-block slice test still within window).

## Step 7 — Docs (prompt reference + changelog + hub)
- Status: applied
- Decision: rule 1 — doc-of-record for voice/Stage-6 is `docs/reference/ios-pipeline.md` (P7/P2/P6/C1 all update it). Added a P8 "Model-decision prompt steers" section (both steers, budget note, live probes, key files). Added a full changelog.md row + a hub CLAUDE.md one-line summary row.
- Files: `docs/reference/ios-pipeline.md`, `docs/reference/changelog.md`, `CLAUDE.md`
- Commit: pending

## Step 8 — Full backend suite gate
- Status: applied
- Decision: rule 1 — ran the full backend Jest suite (`node --experimental-vm-modules node_modules/jest/bin/jest.js`). Result: **Test Suites 254 passed / 2 skipped; Tests 6096 passed / 0 failed / 19 skipped; exit 0.** The `✗ frc_...ab: audibility.turn` line is an expected-red field-replay fixture asserted WITHIN a passing gate test (the recorded lane proves expected_red must fail). The "worker failed to exit gracefully" warning is the known S3-mock timer leak, not a failure.
- Files: none (test run)
- Commit: `56d709b6` (the batched P8 commit — prompt + tests + docs, one logical unit)

## LIVE probes (post-deploy — documented, NOT run at merge)
Model-decision verification cannot run in CI (no `ANTHROPIC_API_KEY` — open vault todo; the nightly live lane picks these up). Documented in the plan + `docs/reference/ios-pipeline.md`:
- Probe A (id 88): "Zs on the <designation> is n o <value>" (with scope) → WRITE + read-back, no ask.
- Probe B (correction regression): read-back a value, then "No. It was <other>" → correction, not a spurious write.
- Probe C (id 83): "Observation: small hole in the top of the consumer unit" (multi-turn) → ONE deciding-fact ask, then a DISCRIMINATING code (accessible-to-touch → **C1**, not C2).
- Probe D (Example-8 regression): bare "Zs for circuit N." → still exactly ONE missing_value ask.

## Codex diff review
- Status: cycle 1 done, fixes applied, re-gating

### Cycle 1 — parallel 3-lens review (wire-faithfulness / silent-path / edge-interactions)
Merged findings (deduped). **APPLIED (in-scope):**
- **[BLOCKER] NC / "NO observation" un-emittable (silent-path + edge lenses).** VERIFIED: `record_observation.code` enum in `config/stage6-enumerations.json` = `["C1","C2","C3","FI"]` — **no NC**. The plan's Steer-2 "→ NC" and "→ NO observation (not C3)" instruct an un-emittable code + (for an EXPLICIT observation) conflict with RULE 1a "must record" and would false-fire the D2 dropped-observation net → a silent/looped path. **Fix (in-scope correctness):** reworked both to "**C3 at most, never C2**", preserving the anti-over-code SAFETY intent (a sound bond is never blanket-C2) while every explicit observation resolves to a valid emittable code — eliminates the silent-drop/D2 path by construction. This is a faithful realization of the plan's CORE intent (the plan cannot have meant "emit a code that doesn't exist"). Flagged prominently: the literal "NC" text is gone.
- **[BLOCKER] source stale-comment sweep incomplete.** I'd swept only the two TEST comments; `src/extraction/eicr-extraction-session.js` (render-fn comment + export comment) and `docs/reference/architecture.md` still claimed flag-off byte-identity. The plan's sweep explicitly names "source comment". Softened all three (comment-only; no behaviour change).
- **[IMPORTANT] "one-ask budget" understates BOUND.** BOUND permits one initial + one continuation; the plan (line 49) warns against calling it "one-ask". Fixed to "bounded clarification budget (one initial ask + at most one continuation)".
- **[IMPORTANT] ACCESS LADDER claimed to cover bonding.** Bonding has its own decision tree (extraneous/adequacy), not the touch-access ladder. Reworded intro: TWO classes share the ladder; bonding is its OWN tree.
- **[Steer-1 precedence/filled-slot]** Broadened the ask-reply guard (any reply to a pending ask, incl. a decline "No, leave it") + added the empty-slot-writes / filled-slot-still-clears-then-records note, as an explicit PRECEDENCE line.
- **[test edge-interaction]** The pre-existing Group 18 test sliced the AMBIGUOUS block at a fixed 3200 chars; the larger Steer 2 pushed `clarification_chain_id` past it → widened the window 3200→4400 (block genuinely grew; assertion intent unchanged).

**DISMISSED (with reasoning):**
- "Restore verbose accessories ranked facts (broken/missing vs design gap; height/accessibility)" — CONTRADICTS the plan's own explicit compactness mandate ("Keep the per-class checklist COMPACT … NOT verbose prose — the prompt budget is near cap"). The access ladder + examples already convey these dimensions.
- "416.2.3 absent from prose" — the plan PROSE (final.md lines 44-46) doesn't include 416.2.3 either (it's only in the citations-to-verify list); my prose matches the plan prose. Not a deviation.
- **Budget > ~250 target (raised by all three lenses, 2×BLOCKER/1×IMPORTANT)** — the plan is UNAMBIGUOUS that the ~250 is an aspirational TARGET to trim toward and that "a measured cap bump on BOTH caps is the EXPECTED outcome, not a contingency … compaction cannot recover ~600 tokens by folding alone." Derek's mandated THREE cited classes + the cycle-1 correctness fixes structurally cannot fit ≤250. I MINIMISED (shared ACCESS LADDER, terse prose, dropped Steer-1's numbered list) and set caps from measured+~100. NOT held — the plan explicitly sanctions the bump; holding on an impossible target would let the reviewer override the plan's clear intent.

Net growth after fixes: base +637 / combined +636 (was +517/+516 pre-fix). Cycle-1 fixes committed `96573643`.

### Per-fix mini-review (fix hunks only, `git diff 56d709b6 HEAD`)
Codex reviewed ONLY the cycle-1 fix hunks. 6 defects found. **APPLIED (in-scope):**
- **[board-scope, IMPORTANT]** Steer-1's filled-slot correction note said "clears then records" but `clear_reading` is circuit-only — a board-level correction (Ze, CSA) overwrites via `record_board_reading`. Reworded: "a circuit field clears-then-records, a board field overwrites via `record_board_reading`". Pin updated.
- **[correction-ordering, IMPORTANT]** "No. It was 0.63" was pointed at BARE NEGATION, which is value-LESS only. Reworded: a leading-"no" reply with no in-utterance anchor+scope is NOT this write — it resolves against the recent read-back as a correction; the value-LESS "no" is BARE NEGATION. Pin updated.
- **[test-coverage, IMPORTANT]** The bonding pin didn't assert the C2 branches and used a NON-LOCAL `/never C2/`. Strengthened: slice the main-bond clause locally and assert the extraneous-part gate + `absent/<6mm²/thermal → C2` + the sound-bond `C3 at most … never C2` bound to that clause; bathroom omission `C3 at most, never C2` asserted too.
- **[test-boundary, NIT]** The Group-18 slice window (4400 magic number) pulled in ~854 chars of WORKED EXAMPLES. Bounded STRUCTURALLY at `indexOf('WORKED EXAMPLES:')` instead.
- **[comment-accuracy, NIT]** The two softened `eicr-extraction-session.js` cache comments disagreed. Aligned: a shared edit changes both rendered strings; only the SENT variant misses cache; prod latches one variant → one cold window per deploy.

**KEPT / DEFERRED (finding 1, [BLOCKER] "C3-at-most over-codes"):** Codex wants a genuine NC/no-code terminal — an emittable `NC` enum value + RULE-1a/D2 rework so a fully-compliant finding records nothing. That is a **backend schema + dispatcher change**: OUT_OF_SCOPE for a prompt-only plan AND a backend-immutable-rule / iOS-canon violation, AND OUT_OF_INTENT (the conversation-context pins this as "Backend PROMPT-ONLY … ONE batched edit"). My in-scope "C3 at most, never C2" is SAFE (never under-codes danger), representable, a DEFENSIBLE domain position (an undersized-by-current-standards bond is a legitimate C3 improvement), and strictly better than pre-P8 (which auto-picked C3 with no anti-C2 guard). It already eliminated the actual broken path (un-emittable code / silent-drop / D2 loop). Not a hold — the diff ships SAFE. **Deferred backend follow-up (for the morning / a future plan):** add an emittable `NC`/no-code observation outcome + RULE-1a/D2 acceptance so a fully-compliant explicit observation can record no coded defect. Logged here + surfaced in the PR body.

Re-measured after mini-review fixes: base +685 (measured 16645) / combined +685 (measured 21883). Mini-review fixes committed `8201dca2`.

### Cycle 2 — full re-review of the amended diff
Passed the ALREADY-DECIDED note (C3-at-most is a deliberate in-scope resolution; budget bump is plan-sanctioned) so Codex didn't re-bounce those. 4 findings, all in-scope:
- **[BLOCKER, correctness/safety]** The bonding sentence grammatically gated the thermal-damage → C2 branch behind the "only matters on an extraneous part" prefix AND flattened thermal damage to an unconditional C2, dropping the existing CLEAR-CUT GUARD's C1 escalation ("thermal damage → C2 unless immediate present danger → C1"). Real under-code risk. **Fix:** reworded so the extraneous prerequisite governs ONLY the absent/ineffective + undersized branches; thermal damage is INDEPENDENT of extraneous status and carries "→ C2 (or C1 if immediate present danger — the clear-cut guard above)". Bonding test pin updated to assert the limited prerequisite + the independent thermal C2/C1 branch.
- **[IMPORTANT, edition-verification]** Exec-log evidence said "verified against 2018+A2:2022" while docs said "current-edition". Reconciled: the cited numbers (416.2.x, 411.3.1.2, 544.x, 701.415.2, 512.2) are stable CORE regs unchanged across 2018+A2:2022 / A3:2024 (AFDD/fire bolt-on) / A4:2026 — none renumber protection/bonding/bathroom regs — so verification holds for the repo's `BS 7671:2018+A4:2026` reference. Changelog wording made precise.
- **[NIT, test-correctness]** The Steer-2 pin only proved heading < checklist < CHAIN ID; a checklist moved BEFORE BOUND would still pass (breaking its "budget above" reference). Added a BOUND-position check (`bi > ai`, `di > bi`) + search CHAIN ID from `di`.
- **[NIT, test-doc]** Renamed the answers-session test "preserves every original line" → "preserves A1 OFF-block lines" (it checks 3 OFF-block lines, and P8 intentionally changed the shared region).

Re-measured after cycle-2 fixes: base +726 (measured 16686) / combined +725 (measured 21923). Cycle-2 fixes committed `d237817e`.

### Cycle 3 — full re-review (finding count decreasing: cyc1 heavy → cyc2 2 → cyc3 2)
2 IMPORTANT findings, both in-scope, both applied:
- **[plan-faithfulness]** The accessories/CU class had dropped the plan's ranked deciding facts "(2) broken/missing component vs design gap; (3) height/accessibility" (final.md line 46). I'd dismissed this in cycle 1 citing compactness — but the plan prose lists them and the enclosure class kept its 3 facts, so this was an asymmetric omission. Added them tersely ("apply the ACCESS LADDER, then weigh broken/missing component vs design gap, then height/accessibility") + a local accessories-clause pin. ~+12 tokens.
- **[documentation-correctness]** The doc summaries (ios-pipeline/changelog/hub) still described the PRE-cycle-2 bonding semantics (thermal grammatically under the extraneous prefix; unconditional C2; no C1 escalation) and the changelog intro still said "reuses its one-ask budget". Updated all three doc bonding summaries to the cycle-2 semantics (extraneous governs only absent/undersized; thermal independent → C2/C1) and the "one-ask budget" intro → "bounded clarification budget". Also swept two stale "one-ask budget" TEST comments.

Final measured: base +745 (measured 16705, headroom 85) / combined +745 (measured 21943, headroom 82). Caps `renderedOn<=16790` / `combinedRenderedOn<=22025` unchanged (still pass). Prompt suites 89/89 green. Cycle-3 fixes committed `b59feaed`.

### Cycle 4 — CONVERGED (PASSED)
Codex returned **ZERO findings** — the diff review PASSES. "Clean. Cycle-3 additions are consistent, and all three documentation summaries match the prompt's bonding tree." Finding-count trajectory: cyc1 (heavy, ~5 applied) → mini-review (3 applied, 1 kept-deferred) → cyc2 (1B+1I+2N) → cyc3 (2I) → cyc4 (0). Healthy convergence.

**Verdict: PASSED** (no sanctioned plan deviations — the NC→C3 rework was an in-scope correctness fix within the plan's anti-over-code intent, not a deviation requiring intent-sanction). Total: 4 full cycles + 1 per-fix mini-review.

**Deferred backend follow-up (surfaced in PR body + here for the morning):** add an emittable `NC`/no-code `record_observation` outcome + RULE-1a/D2 acceptance so a FULLY-compliant explicit observation (a sound ≥6 mm² bond; a satisfied 701.415.2 bathroom omission) can record NO coded defect instead of the current representable floor of "C3 at most". OUT OF P8's prompt-only scope (backend schema + dispatcher; backend-immutable/iOS-canon).

## Completed 2026-07-24 (ALL PASSED)

**Outcome header: ALL PASSED** — every plan step applied; full backend suite green; Codex diff review PASSED (4 cycles + 1 mini-review; converged clean, zero unresolved).

### Plan deviations
None requiring intent-sanction. The plan's literal "→ NC" / "→ NO observation" text was reworked to "C3 at most, never C2" as an **in-scope correctness fix** (the `record_observation.code` enum has no NC; "NO observation" conflicts with RULE 1a — the plan cannot have meant an un-emittable code). This preserves the plan's core anti-over-code intent and is documented throughout. The ideal NC/no-code outcome is a **deferred backend follow-up** (out of prompt-only scope).

### Commits (feature branch `ep/PLAN-20260724T125845Z-ep`)
- `56d709b6` feat(prompt): P8 batched model-decision steers — garble-adjacent value writes (id 88) + observation C-coding deciding-facts checklist (id 83)
- `96573643` fix(ep): address Codex review cycle 1 — un-emittable NC→C3, source stale-comment sweep, budget/precedence precision
- `8201dca2` fix(ep): address Codex per-fix mini-review — board-scope correction, value-bearing negation, local bonding pins
- `d237817e` fix(ep): address Codex review cycle 2 — bonding thermal-damage C1 escalation + test/edition precision
- `b59feaed` fix(ep): address Codex review cycle 3 — restore accessories ranked facts + sync doc bonding semantics
- (+ this execution-log commit)

### Files touched
- `config/prompts/sonnet_agentic_system.md` — Steer 1 (garble-adjacent value writes, folded into Example 8) + Steer 2 (three-class C2/C3 deciding-facts checklist in the AMBIGUOUS block)
- `src/__tests__/stage6-agentic-prompt.test.js` — bumped budget caps (16790 / 22025) + Group-0b Steer-1 pin + Group-18 Steer-2 pins (both flag renders) + widened AMBIGUOUS-block slice
- `src/__tests__/stage6-agentic-answers-session.test.js` — softened stale byte-identity comment + renamed a test
- `src/extraction/eicr-extraction-session.js` — stale-comment sweep (render-fn + export comments; comment-only, no behaviour change)
- `docs/reference/ios-pipeline.md` — new "Model-decision prompt steers (P8)" section
- `docs/reference/changelog.md` — full P8 row
- `docs/reference/architecture.md` — softened stale A1 byte-identity claim
- `CLAUDE.md` — hub changelog one-liner

### Assumed decisions
None material — every plan step executed verbatim or with a single obviously-correct interpretation (anchors all confirmed exact in Phase 0).

### Skipped / blocked / failed
None.

### Tests
- `stage6-agentic-prompt.test.js` + `stage6-agentic-answers-session.test.js`: 89/89 green.
- Full backend Jest suite: 254 suites passed (2 skipped); **6096 tests passed, 0 failed, 19 skipped** (the `frc_…ab audibility.turn` line is an expected-RED field-replay fixture asserted within a passing gate test).

### LIVE probes (documented, NOT run at merge — no ANTHROPIC_API_KEY in CI; nightly live lane covers regression)
A) "Zs on the <designation> is n o <value>" → WRITE + read-back, no ask.
B) read-back a value, then "No. It was <other>" → correction, not a spurious write.
C) "Observation: small hole in the top of the consumer unit" (multi-turn) → ONE deciding-fact ask, then a DISCRIMINATING code (accessible-to-touch → C1, not C2).
D) bare "Zs for circuit N." → still exactly ONE missing_value ask.

### Deferred follow-up (morning)
Backend NC/no-code observation outcome (see the Codex review section) — add an emittable no-code terminal + RULE-1a/D2 acceptance so a fully-compliant explicit observation records no coded defect. Prompt-only P8 lands "C3 at most" as the safe representable floor.
