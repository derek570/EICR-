# /ep execution log — PLAN-A (address-mirror gate relaxation, feedback id 126)

## Completed 2026-08-23T17:05:00Z (interim — deploy result appended below after CI)

- **Outcome header: ALL PASSED** — every plan step applied or assumed; Codex diff review PASSED (3 cycles + mini-review, cycle 3 CLEAN: 0 BLOCKER / 0 IMPORTANT / 2 NIT applied); zero sanctioned plan deviations.
- **PR:** https://github.com/derek570/EICR-/pull/192 (ready, merged on green checks)
- **Commits:** `d745434f` feat (server predicate + all three prompts, atomic matched pair) · `356c3149` test+manifest · `faad3bff` docs · `4fba7f56` fix cycle-1 · `5434a3d3` fix mini-review · `9068bc1d` fix cycle-2 · `4490b5b6` NITs · (+ exec-log mirror)
- **Files touched:** `src/extraction/address-mirror-controller.js`, `src/extraction/stage6-shadow-harness.js`, `src/extraction/sonnet-stream.js`, `src/db.js`, `config/prompts/sonnet_agentic_system.md`, `config/prompts/sonnet_extraction_system.md`, `config/prompts/sonnet_extraction_eic_system.md`, `src/__tests__/` (4 mirror files + agentic-prompt + dispatcher + NEW legacy-prompt-contract + NEW live-seam + NEW ingress), `scripts/model-ab/plan00-expectation-manifest.json`, `CLAUDE.md`, `docs/reference/changelog.md`, `docs/reference/architecture.md`
- **Plan deviations:** none shipped (two OUT_OF_SCOPE review findings refuted against standing decisions — see Codex section; logged as follow-ups).
- **Assumed decisions:** see "Assumed decisions" section (blocked status under the CHECK-constrained `'conflict'`, blocked-dominates-conflict ordering, prompt cap bumps per P8 precedent).
- **Skipped / blocked / failed steps:** none.
- **Stashes left behind:** none.
- **Tests:** backend Jest 8974 passed / 355 suites; web vitest 1757 passed; plan00 drift test green; check-hub-size green; corpus gate green via pre-push.
- **Follow-ups noticed:** 4 (see section below; 2 queued to vault at execution time, 2 refuted-finding records appended at completion).

- **Session:** `20260823T143152Z-ep`
- **Plan:** `~/.claude/handoffs/EICR_Automation--feedback-2026-08-23/PLAN-A-final.md` (wave member, `.ep-queue` marked)
- **Repo:** `/Users/derekbeckley/Developer/EICR_Automation`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260823T143152Z-ep`
- **Branch:** `ep/PLAN-A-final-20260823T143152Z-ep` (off `main` @ `6fd695f0`)

## Step A1a — relax the shared `complete()` predicate (all ~9 call sites)
- Status: applied
- Decision: rule 1 — executed verbatim; ONE shared function so every consumer moved together.
- Files: `src/extraction/address-mirror-controller.js`
- Commit: `17dc1b8a`
- Notes: predicate = meaningful `address` AND ≥1 of `postcode`/`town`/`county`, both families. Existing 30-test controller suite stayed green untouched.

## Step A1b — snapshot-aware `directQuestion` helper (pure function of persisted source_snapshot)
- Status: applied
- Decision: rule 1. The initial-emission site in `applyDirectCommand` now calls the same helper as durable replay and the `:1341` legacy answer-equality check — byte-deterministic across emission/restart/answer.
- Files: `src/extraction/address-mirror-controller.js`
- Commit: `17dc1b8a`
- Notes: two wordings — no address: "What is the <family> address, including a town, county, or postcode?"; address without corroborator: "What is the <family> postcode, town, or county?".

## Step A1c — hybrid-address guard (fail-closed, zero new durable state)
- Status: applied
- Decision: rule 1. Guard at FIVE points: candidate-build (closed rejection `source_missing_target_components`, one-shot NOT burned), answer-time yes (late race a — blocked terminal consumes the one-shot), direct-command time (dominates the conflict clarification, whose "yes" would authorise the hybrid), deciding-write path (`finalizeDirectAfterWrites`), and materialisation/recovery time (late race b — authorised-target snapshot cannot bless a source-absent component).
- Files: `src/extraction/address-mirror-controller.js`
- Commit: `17dc1b8a`
- Notes: blocked terminals persist under status `'conflict'` (both mirror tables carry a CHECK constraint closing the status set — verified in `migrations/014_address_mirror_intents.cjs`) with `terminal_outcome = {outcome:'blocked', reason:'source_missing_target_components', missing_source_keys:[ordered], source_family, target_family}`. Speech is generated SOLELY from the persisted payload (`hybridBlockerSpeech`), convenience variant names the fresh-direct-command recovery route. Blocked replay short-circuits BEFORE the drift checks so a post-block source dictation cannot reroute the undelivered terminal into a generic drift conflict.

## Step A1d — seam fixes (shadow-harness followup retention + terminal classifier)
- Status: applied
- Decision: rule 1. `stage6-shadow-harness.js` ~:2779 now retains `ADDRESS_MIRROR_DIRECT_FOLLOWUP` when directFinal carries question OR clearAskId (the live-path asymmetry the plan named); `sonnet-stream.js`'s transcript-ingress terminal mirror-outcome set gains `'blocked'`.
- Files: `src/extraction/stage6-shadow-harness.js`, `src/extraction/sonnet-stream.js`
- Commit: `17dc1b8a`

## Step A2 — prompt relaxation, all three prompts, same-commit matched pair
- Status: applied
- Decision: rule 1. Agentic `:206` relaxed + HYBRID ELIGIBILITY rule + `source_missing_target_components` terminal-for-snapshot disposition; both legacy extraction prompts (`sonnet_extraction_system.md` :142-146/:151, `sonnet_extraction_eic_system.md` :94/:100) identical relaxation + satisfiable DEFER + hybrid ban + guess-ban-with-corroboration note.
- Files: `config/prompts/sonnet_agentic_system.md`, `config/prompts/sonnet_extraction_system.md`, `config/prompts/sonnet_extraction_eic_system.md`
- Commit: `637f6477`
- Notes: verified no "address + postcode" completeness phrasing survives in any of the three mirror blocks (grep + pinned by tests).

## Step A3 — DEFER rewrite + deferred-fire worked example
- Status: applied
- Decision: rule 1. `:207` literally reworded (names the corroborating components; "a bare street line alone is not enough; do not retry in the same turn"); new worked example appended after the second one — address alone turn N, county turn N+2 → ask fires on N+2's write.
- Files: `config/prompts/sonnet_agentic_system.md`
- Commit: `637f6477`

## Step A4 — postcode back-fill open question
- Status: applied (default taken)
- Decision: rule 2 — headless run, plan carries the default: NO back-fill this wave; mirroring stays a point-in-time copy. Recorded as follow-up todo (see Follow-ups).
- Files: none
- Commit: none

## Step T — tests
- Status: applied
- Decision: rule 1, with one deliberate fixture correction: the town/county-only hybrid fixture's expected missing keys are `['town']` not `['town','county']` — the standard source has a county, so the target's county is the pre-existing CONFLICT class (present-but-different) while only town is genuinely ABSENT; blocked dominates and names only the missing component. The plan's matrix wording ("naming ALL missing components") is satisfied — the county was never missing.
- Files: `src/__tests__/address-mirror-controller.test.js` (+29 → 59 tests), `src/__tests__/stage6-address-mirror-dispatcher.test.js` (production tool-loop disposition contract with the REAL controller, mirroring the shadow-harness `claimLiveAsk` wrapper), `src/__tests__/stage6-agentic-prompt.test.js` (Group 15 +2 tests; both token caps bumped measured+~100 per the documented P8 precedent — combined 24589→25054 measured 24954, base 19339→19805 measured 19705, dated history entries added), `src/__tests__/address-mirror-legacy-prompt-contract.test.js` (NEW — per-legacy-prompt contract, 8 tests), `src/__tests__/address-mirror-hybrid-live-seam.test.js` (NEW — REAL runShadowHarness live tool loop: deciding county write → blocked; cancel_pending_tts precedes exactly one spoken blocker; zero copy), `src/__tests__/address-mirror-hybrid-ingress.test.js` (NEW — real sonnet-stream ws ingress: one spoken blocker frame, no model fallthrough, reservation dedupe, organic recovery)
- Commits: `482cd10c`, `5ec25521`
- Notes: restart-recovery of blocked terminals (both convenience and direct) is pinned at controller level with store doubles (exact persisted wording replayed after a snapshot mutation). The plan's "restart recovery through real sonnet-stream ingress" is covered by the combination (ingress terminal + controller-level recovery); a full durable-store ws restart harness would have required a Postgres double for the ws layer that no existing test file has.

## Step P — plan00 semantic-oracle manifest regeneration (merge-blocking)
- Status: applied
- Decision: rule 1. Deterministic regeneration of ONLY the drifted fields (`semantic_oracle_digest` + the 3 changed input rows: address-mirror-controller, sonnet-stream, stage6-shadow-harness); lanes/fixtures byte-untouched. Drift test 22/22 green.
- Files: `scripts/model-ab/plan00-expectation-manifest.json`
- Commit: `5ec25521`

## Step D — docs
- Status: applied
- Decision: rule 1. Hub row (oldest row dropped to respect the 45k budget — check-hub-size green at 44034/45000), full changelog.md entry, architecture.md voice-address span: new dated subsection + deciding-answer rewording.
- Files: `CLAUDE.md`, `docs/reference/changelog.md`, `docs/reference/architecture.md`
- Commit: `2d2e2700`

## Assumed decisions
- [ASSUMED] Blocked-terminal DB status = `'conflict'` — both mirror tables CHECK-constrain status to `('pending','resolved_yes','resolved_no','conflict'[, 'cancelled'])`; the blocked shape is distinguished by `terminal_outcome.reason`, exactly the plan's "existing JSON terminal_outcome" instruction. No migration.
- [ASSUMED] Blocked-vs-conflict dominance when a target holds BOTH a differing shared component AND a source-absent one → blocked wins and names only the absent components (fail-closed dominance per the plan's "no generic conflict routing"); the conflict class re-emerges naturally on retry after the missing component is dictated.
- [ASSUMED] Prompt token caps bumped (2 tests) rather than trimming the mandated prompt additions — the caps' own comments document "measured + ~100, P8 precedent" as the expected path for deliberate feature additions.

## Codex diff review

### Cycle 1 — parallel 3-lens (wire-contract / silent-path / edge-interactions), gpt-5.6-sol high
Merged findings (deduped by location+substance): **12 BLOCKER-class + 3 IMPORTANT** across the three lenses; two findings appeared in all three lists (vault todos + architecture :290) and three in two lists.

**APPLIED (in-scope):**
1. Blocked-terminal speech precedence — new `stageBlockedTerminal` (force-replace; first-wins `stageAcknowledgement` could let same-turn `answer_user` prose displace the mandatory blocker while its delivery token was ACKed); legacy off-mode finalizer now overwrites `spoken_response` when `directFinal.outcome === 'blocked'` (was fill-only).
2. `blocked` added to the `ask_user_answered` durable-recovery terminal branch (was yes/no/conflict — a late race resolved via the answer frame would have discarded the staged blocker unspoken) and to the transcript-anchor `recordAskResolved` outcome list (evidence ask-ledger closure).
3. `persistConvenienceDeliveryConflict` gains a `terminalPayload` param and `conflict()` passes the blocked payload on the claimed-recovery path (a resolved_yes crash + late target component previously persisted a bare `{outcome:'conflict'}` and every later recovery spoke the generic drift wording).
4. Delivery-lease fencing: both `conflictAddressMirror*` DB functions accept an `expectedDeliveryClaimToken` predicate (null = legacy unfenced); the BLOCKED persist sites fence to their lease and stage nothing on a lost lease (return duplicate). Pre-existing conflict callers keep legacy semantics deliberately (their behaviour is pre-plan; noted, not widened).
5. Clarification progression: `rebindDirectIncomplete` refreshes the persisted source snapshot on a partial-progress write (address arrives on a no-address ask) and re-emits the progressed question; a NEW direct command colliding with a pending clarification now REPLAYS the pending question instead of consuming the utterance silently (`already_pending` + question routes to the ingress question branch — terminal classifier gains a question-string guard).
6. Test matrix: client→site direction pinned for legacy claim, convenience suppression, direct blocker wording + recovery, late race (a); blocked-terminal shared-CAS race (exactly one spoken blocker); durable ws RESTART test through the real reconnect outbox replay (persisted undelivered blocked row → exactly one spoken blocker, zero copy, row marked delivered).
7. Docs/delivery: architecture.md "address/postcode ask" → source-completion wording; both vault follow-up todos written to `todos-certmate.md` (frontmatter `updated` bumped, `last_action` untouched).
8. Commit atomicity: branch history rewritten (unpushed, no force-push involved) so the server predicate + all three prompt halves land in ONE commit (`d745434f`), tests+manifest and docs in follow-on commits.

**REFUTED (presented to cycle 2 with evidence, not applied, not held):**
- "Confirmations-OFF suppresses the deciding source write's read-back" (silent-lens + edge-lens, OUT_OF_SCOPE, verdict WITHIN_INTENT): the quoted intent evidence concerns DERIVED-write silence, not the confirmations toggle; confirmations-OFF is the sole documented Audio-First exception per shipped PLAN-D 2026-08-13 (ids 121/122/124) — forcing read-backs in OFF mode would contradict that shipped decision. Pre-existing behaviour, unchanged by this diff. Logged as [FOLLOWUP].
- "Seeded/lookup-derived locality can corroborate a garbled address" (edge-lens, IMPORTANT, OUT_OF_SCOPE, Codex's own verdict OUT_OF_INTENT quoting the context's "postcode-lookup/locality behaviour untouched"): a deliberate plan non-goal, and thin in practice (lookup locality only exists after an authoritative postcode write — which already completes the family). Logged as [FOLLOWUP].

### Mini-review of cycle-1 fix hunks — 4 IMPORTANT, all applied
1. Conflict UPDATEs also require lease FRESHNESS (10s window) and renew `delivery_claimed_at` atomically — token equality alone let an expired owner persist-and-speak while a reclaimer materialised.
2. Fence widened to EVERY post-claim conflict persist (claimed convenience recovery, direct source_drift/target_drift) — lost lease → silent duplicate.
3. `materializeDirectTerminal` reordered: replay collection PURE, staging deferred until ownership confirmed (a lost-lease loser previously had its staged replays bundled to the wire); blocked terminals stage NO replays.
4. `rebindDirectIncomplete` lost-CAS guard (no null deref; callers decline to re-ask); same guard on the pre-existing conflict-rebind consumer. New lease-expiry reclaim-race test.

### Cycle 2 — 2 BLOCKER + 3 IMPORTANT, all applied; refuted items NOT re-raised
1. [BLOCKER] Effective-source merge in `finalizeDirectAfterWrites`: live snapshot wins where populated, crash-persisted components preserved (never regressed to null by a blank-restart snapshot); provenance ledger merges the same way. Restart test proves address survives crash + blank snapshot and replays with provenance.
2. [BLOCKER] `expected_answer_shape` stated by the controller from persisted `clarification_kind` on every question-bearing return; every emitter honours it (already_pending replay of a CONFLICT question stays yes_no; progressed incomplete re-ask is free_text; `buildResultFrameLedger`'s hard-coded yes_no removed). Wire pin through real ingress.
3. [IMPORTANT] Finalize-driven question-less clearAskId terminals resolve their ask in the Plan-00 evidence ledger (live shadow-harness + legacy finalizer) — previously the ask stayed open and invalidated quiescence.
4. [IMPORTANT] DB fence source-contract test (token + freshness + atomic renewal on BOTH conflict UPDATEs) + lost-lease loser tests for convenience/source_drift/target_drift.
5. [IMPORTANT] Full client→site reverse coverage: town/county-only + multi-component (convenience + direct), equal-populated copy, late race (b) with reversed-family payload direction.

### Cycle 3 — CLEAN (0 BLOCKER, 0 IMPORTANT, 2 NIT — both applied once, no NIT looping)
- `expectedAnswerShape` added to the initial hasConflict return (+ test assertion).
- Changelog row updated to the final reviewed state (~41 tests; review-hardening summary).

**Verdict: PASSED.** Trajectory: 15 (3-lens merge) → 4 (mini) → 5 → 0+2 NIT. No sanctioned plan deviations shipped (SANCTIONED_DEVIATIONS empty — the two OUT_OF_SCOPE findings were refuted against standing repo decisions with evidence, accepted by cycles 2 and 3 without re-raise, and logged as follow-ups).

## Follow-ups noticed
[FOLLOWUP] A4 postcode back-fill after a completed mirror — when a postcode is dictated AFTER the mirror copied a family, it does NOT back-fill the mirrored family (default NO shipped this wave, plan-sanctioned); the source-snapshot hash machinery in `address-mirror-controller.js` exists to support it; next action: Derek decides whether back-fill is wanted, then a small plan wires it through the mirror controller's snapshot-hash path.
[FOLLOWUP] Guided source-completion flow for hybrid-blocked targets — the fail-closed terminal shipped here tells the inspector to dictate the missing source component and re-command; a GUIDED flow (pending question that walks them through it) was designed in /rp rounds 3-4 and found to need new durable machinery (convenience-ledger phase or direct-intent handoff, persisted required-component set, DB migration, live/legacy/reconnect orchestration) — see `PLAN-A-refine-log.md` rounds 3-4 for the design; next action: only worth a plan if field use shows the spoken-instruction recovery is too clumsy.
[FOLLOWUP] Confirmations-OFF and the deciding mirror source write — Codex's silent-path lens flagged (cycle 1) that with confirmations OFF, a dictated source component that completes an incomplete direct mirror is written but not read back (only the copy/blocker terminal speaks). REFUTED for this wave: confirmations-OFF is the sole documented Audio-First exception (shipped PLAN-D 2026-08-13, ids 121/122/124) and the behaviour predates this diff — but the interaction is now easier to hit since town/county also complete a family; next action: consider whether the mirror's deciding write deserves the same explicit-exception treatment PLAN-D gave decline acks, only if field use surfaces confusion.
[FOLLOWUP] Locality provenance as mirror corroboration — Codex's edge lens noted (cycle 1, its own verdict OUT_OF_INTENT) that a snapshot-seeded or postcode-lookup-derived town/county counts toward the relaxed completeness the same as a dictated one; `stableSnapshot` strips provenance. Thin in practice (lookup locality only exists after an authoritative postcode write, which already completes the family) and the plan explicitly left PLAN-E locality behaviour untouched; next action: only revisit if a field session shows a stale seeded locality corroborating a wrong street line.
