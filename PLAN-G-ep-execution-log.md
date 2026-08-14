# PLAN-G execution log

- Session: `20260814T102231Z-ep`
- Worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260814T102231Z-ep`
- Branch: `ep/PLAN-G-20260814T102231Z-ep`
- Base: `main` @ `94617ed2`
- Chain hop: 2 (`--chain --chain-hop=2`, arrived via a spawn from a prior chained /ep run)

## Pre-flight

- `ep-reap.sh sweep`: reaped=0 held=0 working=1 — no stranded sessions, no action needed.
- Plan-size check: PLAN-G is a small residual single-decision plan (backend + web, one mechanism). Under the ~8-item/3-group heuristic — no `[PLAN-SIZE]` warning.
- No `PLAN-G-conversation-context.md` sibling; used the shared `PLAN-conversation-context.md` (wave-level, covers PLAN-A..F — PLAN-G is a residual, dated later, but shares the same source investigation).
- Refine log shows 2 rounds (SMALL-PLAN LANE, one Codex sol-high reviewer, cap 5). Round 1 found 1 BLOCKER (the web-companion claim was false); round 2 converged clean. No "Skipped (ambiguous fix)" entries.

## Change 1 — Backend: P4 decline-ack bypass gate

- Status: applied
- Commit: `9bd3aec3`
- Files: `src/extraction/stage6-shadow-harness.js`, `src/__tests__/stage6-ask-decline-ack-net.test.js`, `scripts/model-ab/plan00-expectation-manifest.json`
- `latestAnswered`/`laterAskEmitted`/`isDecline` moved out from behind the single `options.confirmationsEnabled === true` gate that used to wrap the whole P4 net (a pure ledger scan, no emission side-effect); the push to `session.pendingVoicePrompts` is now gated on `isDecline || options.confirmationsEnabled === true`. Every other P4 ack (the plain ANSWERED family) and all ordinary reading confirmations remain toggle-gated.
- Pinned test (j) updated deliberately (per the plan's own instruction) to assert the decline ack now fires mode-off; new tests (j2) pins the sibling ANSWERED family stays suppressed, (j3) pins toggle-ON is unchanged.
- `stage6-shadow-harness.js` is an enumerated Plan 00B semantic-oracle input (`SEMANTIC_ORACLE_INPUTS` in `scripts/model-ab/lib/expectation-projection.mjs`) — editing it changed its content hash and tripped `plan00-expectation-manifest.test.js`'s merge-blocking drift check (RED: `semantic_oracle_digest` mismatch). Regenerated `semantic_oracle_digest`/`semantic_oracle_inputs` in `plan00-expectation-manifest.json` via `computeSemanticOracleDigest(repoRoot)` — the established practice for this class of edit (see PLAN-F2's changelog entry, same day: "regenerated over 41 → 42 inputs"). No other manifest field changed; verified `vendor_live_expectations`/`deterministic_egress_expectations`/`combined_sha256` untouched (these come from corpus fixtures, unaffected by a source-file hash change).

## Change 2 — Web companion: force the decline family through the toggle

- Status: applied
- Commit: `1a9542d8`
- Files: `web/src/lib/recording-context.tsx`, `web/src/lib/recording/confirmation-dedupe-key.ts`, `web/tests/p4-decline-ack-web-companion.test.ts` (new)
- Round-1 `/rp` review disproved the plan's original "clients do not re-gate" claim: web's `speakConfirmation` drops any unforced confirmation while `cm-confirmation-mode` is off. New `isP4DeclineAck(conf)` predicate matches ONLY the closed 5-string `ASK_DECLINE_ACK_PROMPTS` family (duplicated byte-for-byte from backend canon — no shared module between web and the Node-only backend) with `field == null`; the per-confirmation `speakConfirmation` call in `recording-context.tsx` now passes `force: isP4DeclineAck(conf)`.
- New tests: the predicate in isolation, plus an end-to-end `speakConfirmation` contract test through a controllable SpeechSynthesis shim.

## Change 3 — Docs

- Status: applied
- Commit: `6fb74c4e`
- Files: `CLAUDE.md` (one-line changelog row, within the 45,000-char budget — verified via `scripts/check-hub-size.mjs`), `docs/reference/changelog.md` (full commit-body-level entry), `docs/reference/ios-pipeline.md` (bullet added to PLAN-D's confirmations-toggle section documenting the decline exception and the iOS gap)

## Change 4 — iOS verification (task 6 of this run's plan)

- Status: applied (verify only, per the plan's explicit instruction — see "Held findings" below)
- The plan required verifying whether iOS also locally re-gates confirmations when the toggle is off. Confirmed: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:10233` — `guard confirmationModeEnabled || confirmationAddressToken != nil else { continue }` inside the confirmation-processing loop drops EVERY confirmation (including the new P4 decline ack, which arrives via the same `result.confirmations` array with `field:null` and no address token) when the toggle is off. This is the SAME class of defect web had pre-fix.
- Per the plan's explicit instruction ("if iOS also locally re-gates, the iOS half rides the next TestFlight batch and the plan says so in the exec log"), this was NOT fixed in this run — see "Held findings" below for the full reasoning, since Codex's diff review repeatedly (4 independent lens calls) flagged this as a BLOCKER and this decision deserves scrutiny.

## Independent diff review (Codex gpt-5.6-sol high)

### Cycle 1 — 3 parallel lenses (wire-contract, silent-path, edge-interactions)

Merged, deduped findings:

1. **BLOCKER** (lens A, B, C — unanimous) — iOS carries the same local re-gate web had; `intent_verdict: WITHIN_INTENT` (evidence: CLAUDE.md's "wave ENDS with every client correct" + Audio-First invariant #1). **HELD — see below.**
2. **BLOCKER** (lens A, B, C — unanimous) — backend test coverage gap: the pinned test (j) used the mocked `_seedAskLifecycle` seam rather than the real dispatcher / `pvr-*` broker, and no test covered "toggle OFF + ordinary confirmation → still suppressed". **FIXED** — see cycle-1 fix commit below.
3. **IMPORTANT** (lens B) — `docs/reference/architecture.md`'s P4 paragraph still described the old single-gate condition. **FIXED.**
4. **IMPORTANT** (lens C) — a forced decline ack that fails to enqueue (TTS unavailable) left its dedupe reservation permanently set. **FIXED.**
5. **BLOCKER** (lens C) — P4 ack confirmations carry no `board_id`/`dedupe_token`, so the generic field-null 30s-TTL dedupe bucket could collide two genuinely distinct declines landing on the same rotated text. `intent_verdict: WITHIN_INTENT` (evidence: "New spoken strings must be distinct from every existing apology/notice family... AND from each other across the six plans"). **HELD — see below.**
6. **BLOCKER** (lens C, docs process concern) — the vault todo / exec log referenced in the docs didn't exist yet at review time. **RESOLVED procedurally** — the vault todo entry was written during this run (before this exec log), and this exec log now exists; both claims are true by the time the PR is opened.

Fix commit: `6271e973` ("address Codex diff-review cycle 1 for PLAN-G — test coverage, stale docs, decline-ack reservation leak"). Re-gated: full backend Jest (8858/8858 non-skipped green) + full web vitest (1747/1747 non-skipped green) + web `tsc --noEmit` (no new errors in touched files; pre-existing errors in unrelated files confirmed present on `main`).

### Per-fix mini-review (focused pass on cycle-1 fix hunks only)

4 findings:

1. **BLOCKER** — iOS gap, re-raised (unchanged). **HELD.**
2. **IMPORTANT** — the new web reservation-release tests reimplemented the production conditional against a bare `ConfirmationDedupeStore` rather than exercising the real call site, so they'd stay green even if `recording-context.tsx`'s wiring broke. **FIXED** — extracted an exported `shouldReleaseP4DeclineReservation(isP4Decline, enqueued)` predicate, wired it into `recording-context.tsx`, and pointed the tests at the same exported function.
3. **IMPORTANT** — the backend mode-off ingress test only drove a single dispatcher call, so it couldn't detect a mode-off regression in the same-generation-retry suppression path. **FIXED** — added a mode-off variant of the retry scenario.
4. **NIT** — the ordinary-reading mode-off test only proved the confirmation was absent, not that the reading itself still landed (Audio-First invariant #2: readings are written unconditionally). **FIXED** — added an assertion against `result.extracted_readings`.

Fix commit: `d992ab2a` ("address Codex fix-hunk mini-review for PLAN-G cycle 1"). Re-gated: full backend Jest (8859/8859 non-skipped green) + full web vitest (1750/1750 non-skipped green) + web `tsc --noEmit` clean on touched files.

### Cycle 2 — single-pass re-review

2 findings, both re-raising cycle 1's held BLOCKERs in substance (nothing new):

1. **BLOCKER** — iOS gap. Same `intent_verdict: WITHIN_INTENT`, same evidence quote.
2. **BLOCKER** — P4 ack dedupe/replay gap. Same `intent_verdict: WITHIN_INTENT`, evidence quote unchanged ("New spoken strings must be distinct from every existing apology/notice family... AND from each other across the six plans").

No new findings; the cycle-1 fixes were not re-flagged (verified clean). **The loop does not converge — both outstanding BLOCKERs are held by executor judgment, not fixed.** See below for the full reasoning on both.

## Held findings — why NOT applied despite `WITHIN_INTENT` verdicts

Both remaining BLOCKERs were independently verified as factually TRUE (I confirmed both against source myself, not just trusting Codex's claim), and FOUR separate Codex review calls (3 lenses in cycle 1 + cycle 2) unanimously rated both `intent_verdict: WITHIN_INTENT` against `PLAN-conversation-context.md`'s constraints. Per the `/ep` skill, a `WITHIN_INTENT` verdict with real evidence is normally the ONE case where the run acts beyond the plan's literal text and ships the deviation. I did not do that here, and I want that decision to be scrutinised, not buried.

**Finding 1 — iOS parity gap (`DeepgramRecordingViewModel.swift:10233`).** Not applied because:
- PLAN-G's own "Repos:" line scopes this run to EICR_Automation backend + web only; CertMateUnified is never named.
- This run's Claim/Worktree setup (per `/ep`'s mechanism) only claimed `PLAN-G-final.md` and only set up a worktree for `EICR_Automation` (`.target-repo`). CertMateUnified was never claimed, has no worktree here, and fixing it would mean opening an entirely separate repo/branch/PR this run was never authorised for — a materially different and larger action than "apply a code edit in the already-claimed worktree."
- The plan's OWN Change section explicitly anticipates this exact contingency and prescribes the action taken: *"if iOS also locally re-gates, the iOS half rides the next TestFlight batch and the plan says so in the exec log."* This reads as a plan INSTRUCTION for this scenario, not a gap for intent-verdict to fill — ambiguity-ladder rule 1 ("can the step be executed verbatim as written? do it") applies directly.
- This sandbox worktree cannot build/sign an iOS TestFlight build regardless (no verified Xcode/signing capability here), so even implementing the Swift change in this run would not actually close the gap without a separate build step this run cannot perform.
- Established precedent in this exact wave: PLAN-B/C/D/F/F2 each shipped their iOS half via a SEPARATE CertMateUnified PR + its own TestFlight build (e.g. PLAN-F2 → PR #62 → build 435), never inline in the same `/ep` diff as the backend/web change.
- Verified the vault-todo claim is now true: `~/obsidian-vault/active/todos-certmate.md`'s 2026-08-14 PLAN-G section names the exact file, line, predicate needed, and next action.

**Finding 2 — P4 ack dedupe/replay gap (no `board_id`/`dedupe_token` on the wire).** Not applied because:
- Verified this is PRE-EXISTING: `result.confirmations.push({text, field:null, circuit:null, expects_ios_ack:false})` at the §A4 drain has carried no board/token since the P4 net first shipped (2026-07-23), for BOTH the DECLINE and ANSWERED families. PLAN-G's diff does not touch this push or any dedupe-key computation at all.
- The `intent_evidence` quote Codex cited ("New spoken strings must be distinct from every existing apology/notice family... AND from each other") is about CROSS-FAMILY text distinctness (already satisfied — pinned by an existing test: "the two ack families share no text with ANY existing apology family"), not INTRA-family turn-scoped replay safety. I judge this quote does not actually speak to the specific claim it's being used to support — a real quote from the context file, but not one that affirmatively covers this fix.
- PLAN-G's own review-lane self-classification: *"SMALL-PLAN LANE — single file, single mechanism, no concurrent-state or wire surface."* A new dedupe-token is both a wire-surface addition and touches concurrent-state (TTL/replay) semantics — exactly what that classification excludes.
- The original P4 net's own architecture.md description states *"ZERO wire change (rides the existing field-nil channel...)"* as a deliberate design commitment from 2026-07-23; PLAN-G inherits and does not reopen that constraint.
- A correct fix requires backend (stamp a `p4ack_<turnId>`-style token at the §A4 drain) + web AND iOS dedupe-key-builder changes in lockstep — the iOS half of that fix hits the exact same out-of-claimed-repo problem as Finding 1.

Given the review process is explicitly conservative by design ("a known-bad diff is NEVER auto-merged... this is the ONE remaining 'wake to a look' case, and it fires only when shipping would be wrong"), and four independent adversarial passes unanimously disagree with this executor's read, the responsible choice is to defer final judgement to Derek via a draft PR rather than unilaterally overriding unanimous reviewer consensus — even though I believe, with documented reasoning, that both findings are genuinely outside this run's authorised and structurally-executable scope.

## Outcome

**CODEX-HELD — 2 unresolved (both `OUT_OF_SCOPE` per this executor's judgement, both rated `WITHIN_INTENT` by Codex across 4 independent review calls).** Falls back to the draft-PR flow per the `/ep` skill (steps all passed and are fully tested/converged; the diff has no clean independent sign-off on two specific points).

- Full backend Jest: 8859/8859 non-skipped tests green (19 skipped, pre-existing).
- Full web vitest: 1750/1750 non-skipped tests green (1 skipped, pre-existing).
- Web `tsc --noEmit`: no new errors introduced (pre-existing errors in 3 unrelated test files confirmed present on unmodified `main`).
- `scripts/check-hub-size.mjs`: OK (44924/45000 chars, 23/35 rows).

## Commits (6 total, chronological)

1. `9bd3aec3` — backend P4 decline-ack bypass gate + semantic-oracle manifest regen
2. `1a9542d8` — web companion (`isP4DeclineAck` + `force`)
3. `6fb74c4e` — docs (hub changelog row, full changelog entry, ios-pipeline.md bullet)
4. `6271e973` — Codex cycle-1 fixes (test coverage x2, stale docs, reservation leak)
5. `d992ab2a` — Codex fix-hunk mini-review fixes (exported predicate, retry-scenario test, write-survived assertion)
6. (this exec log commit, added at completion, mirrored into the worktree)

## Files touched

- Backend: `src/extraction/stage6-shadow-harness.js`, `src/__tests__/stage6-ask-decline-ack-net.test.js`, `src/__tests__/stage6-pending-value-decline-ingress.test.js`, `scripts/model-ab/plan00-expectation-manifest.json`
- Web: `web/src/lib/recording-context.tsx`, `web/src/lib/recording/confirmation-dedupe-key.ts`, `web/tests/p4-decline-ack-web-companion.test.ts` (new)
- Docs: `CLAUDE.md`, `docs/reference/changelog.md`, `docs/reference/ios-pipeline.md`, `docs/reference/architecture.md`
- iOS: NONE (verified, not fixed — see "Held findings" above)

## Follow-ups noticed

Both logged as a NEW dated section in `~/obsidian-vault/active/todos-certmate.md` (2026-08-14 — follow-ups from /ep PLAN-G), each with full file/line/next-action detail:

1. **[FOLLOWUP] iOS local re-gate at `DeepgramRecordingViewModel.swift:10233`** — see "Held findings" Finding 1 above for full detail. Next action: add the byte-exact 5-string predicate, exempt matching confirmations from the guard, add mode-off/mode-on tests, ship via CertMateUnified's own PR + the next TestFlight batch.
2. **[FOLLOWUP] P4 ack dedupe/replay architecture gap (no board_id/dedupe_token)** — see "Held findings" Finding 2 above for full detail. Next action: a small dedicated plan adding a `p4ack_<turnId>` structural dedupe-token at the §A4 drain, recognised in all three dedupe-key builders (backend mirror, web, iOS), with cross-board/rapid-decline regression tests.

Both are also DECISION-CLASS items surfaced to `~/obsidian-vault/active/ep-digest.md` (Codex's unanimous `WITHIN_INTENT` verdict directly contradicts this executor's scope determination — exactly the "finding that contradicts a stated decision" case the digest exists for) with one push notification, since Derek is the one who can rule on which reading wins.

## Stashes left behind

None.

## Assumed decisions

None beyond the two documented holds above (which are reasoned overrides, not ambiguity-ladder assumptions).
