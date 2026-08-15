# PLAN-G2 — `/ep` execution log

**Plan:** `PLAN-G2-final.md` — close both of PLAN-G's Codex-held findings (iOS local
confirmation-mode re-gate silencing P4 decline acks; both P4 ack families lacking a
structural dedupe token), per Derek's 2026-08-14 decision: *"side with Codex — fix both,
ship everything together."*

**Repos:** EICR_Automation (backend + web, continuing PR #185's branch
`ep/PLAN-G-20260814T102231Z-ep`) + CertMateUnified (iOS, new branch
`ep/PLAN-G2-ios-20260814T135556Z-ep` off `main`).

## Completed 2026-08-15T15:55:00Z

## Outcome

**ALL PASSED** — both repos merged, deployed, and live. No held findings, no deviations
from the plan's literal text.

## Change 1 — iOS local confirmation-mode re-gate exemption

`DeepgramRecordingViewModel.swift` carried the same local `confirmationModeEnabled` re-gate
web had pre-fix: a byte-exact `isP4DeclineAck` predicate over the closed five-string
`ASK_DECLINE_ACK_PROMPTS` family now exempts matching confirmations from both the mode-off
diagnostic loop and the actual confirmation guard, mirroring the backend/web fix exactly.

## Change 2 — `p4ack_<turnId>` structural dedupe token (both P4 ack families)

Both `ASK_DECLINE_ACK_PROMPTS` and `ASK_ANSWERED_ACK_PROMPTS` now carry a
`dedupe_token: p4ack_<turnId>` stamped at the production site
(`pendingVoicePrompts.push` in `stage6-shadow-harness.js`) and explicitly copied through the
§A4 drain into `result.confirmations` (the drain otherwise reconstructs wire confirmations
from text/field/circuit/expects_ios_ack only, stripping metadata). The `p4ack_` prefix is
recognised in the same structural-prefix mechanism PLAN-B/PLAN-F2 established (never the
field allowlist), at all four recognition points: backend `ios-dedupe-key.js`
(`STRUCTURAL_DEDUPE_TOKEN_PREFIXES`), the server-side debounce branches in
`stage6-event-bundler.js` (`SERVER_STRUCTURAL_DEDUPE_TOKEN_PREFIXES`), web
`confirmation-dedupe-key.ts`, and iOS `buildConfirmationDedupeKey`.

## Codex diff review — EICR (backend + web), 3 cycles to clean

Small-plan lane, `gpt-5.6-sol` high, cap 5.

### Cycle 1 — 4 findings, all fixed (commit `68702e17`)

1. **BLOCKER** — the new §A4-drain `p4ack_` debounce pass read `session.confirmationDebounceState`
   but the drain never populated it for a real P4 ack path, so the debounce logic was
   unreachable for anything but the test harness. Fixed by wiring the real drain call site.
2. **BLOCKER** — the Plan-00 semantic judge's `field_null_fallback` branch had no awareness of
   the new `dedupe_token`, so a wrong-token or missing-token confirmation would still pass.
   Fixed by extending `judgeFrozenEvidence` to compare `audible.match?.dedupe_token` against
   the frozen row's `dedupe_token`.
3. **IMPORTANT** — `architecture.md` and `field-replay-corpus.md` still described the P4 net
   as zero-wire-change / tokenless. Fixed — both updated to describe the token-bearing
   contract.
4. **NIT** — no test coverage for the `ASK_ANSWERED_ACK_PROMPTS` family's new token (only
   DECLINE was covered). Fixed — added mirrored ANSWERED-family tests across all four
   dedupe-key builders.

Follow-up: a pre-commit lint-staged pass reformatted `plan00-lifecycle-hooks.js` (an
enumerated semantic-oracle input) after the digest was computed, invalidating it — fixed with
a follow-up regen+commit (`0cfda050`), matching documented repo precedent (`e926fb0e`).

### Cycle 2 — 3 findings, all fixed (commit `a85d3366`)

1. **IMPORTANT** — the cycle-1 debounce-wiring test exercised a mocked
   `session.confirmationDebounceState` directly rather than the real §A4 drain, so it would
   stay green even if the drain's wiring broke again. Fixed — added a real-drain debounce
   test pre-seeding `confirmationDebounceState.tokenKeysMs`.
2. **IMPORTANT** — `recordFrameDeliveryEvidence` (the real producer-path caller of the judge)
   was module-private, so the cycle-1 judge fix had only ever been tested by calling
   `judgeFrozenEvidence` directly — no test proved the token actually threads from the real
   producer path. Fixed — exported the function and added two producer-path tests.
3. **NIT** — `docs/reference/ios-pipeline.md`'s "decline acks are the one documented exception"
   bullet was stale (pre-dated the iOS fix). Fixed.

### Cycle 3 (final) — 1 finding, fixed (commit `20d15a6a`)

1. **NIT** — the judge's `dedupe_token` comparison didn't honour an `expected_key` alias the
   way `replay-assertions.mjs` (the field-replay lane's equivalent check) does, so the two
   lanes' judging logic had silently diverged. Fixed — added the `expected_key` fallback to
   `dedupe_token` for parity, with PASS/FAIL tests for both.

Re-gated after cycle 3: 0 BLOCKER, 0 IMPORTANT (1 NIT applied) — clean per the skill's
literal convergence rule, no cycle 4 required.

### Dropped mid-review: the field-replay fixture token assertion

Mid-cycle-1, `frc_85ace7677d0e1c4a7b2f3609e5d1a8c4/fixture.yaml` briefly gained a literal
`match.dedupe_token: p4ack_frsess_...` assertion. Investigated directly against source (not
trusted blind) and reverted: the field-replay recorded lane (`mintSessionId(corpusId)`) and
the Plan-00 vendor-live lane (`lane-<corpusId>`) mint *different* session ids for the same
`corpus_id`, so a token computed against one harness's session id is wrong for the other —
this fixture is enumerated in `VENDOR_LIVE_FIXTURE_IDS` and runs under both. Reverted to
`text_exact`-only with an explanatory comment; documented as a caution in
`field-replay-corpus.md` so a future session doesn't re-attempt the same fix.

## Codex diff review — CertMateUnified (iOS), 2 cycles to clean

Small-plan lane, `gpt-5.6-sol` high, cap 5.

### Cycle 1 — 2 findings, both fixed (commit `e8a138f`)

1. **IMPORTANT** — `isP4DeclineAck` initially trimmed whitespace before comparing against the
   closed five-string family (`.trimmingCharacters`), widening the match beyond the plan's
   byte-exact spec. Fixed — removed the trim; added a whitespace-padding regression test
   proving a padded near-match stays muted.
2. **NIT** — missing an ANSWERED-family rapid-distinct dedupe test mirroring the backend/web
   coverage. Fixed.

### Cycle 2 — clean (0 BLOCKER, 0 IMPORTANT, 0 NIT)

## Gates (final, pre-merge)

- **EICR backend Jest:** 351/352 suites (1 pre-existing skip), 8882/8901 tests (19
  pre-existing skips) — green.
- **EICR web vitest:** full suite green, no new failures.
- **EICR `scripts/check-hub-size.mjs`:** OK.
- **EICR field-replay corpus:** 9/9 strict, required_green.
- **CertMateUnified `xcodebuild test`:** 1750/1750, 0 failures — green (includes the new
  `P4DeclineAckModeGateTests.swift`, 9 tests).

## Merge + deploy

- **EICR PR #185** ("ep: PLAN-G + PLAN-G2 — ALL PASSED — iOS parity + P4 dedupe token both
  resolved") merged `92446841` (2026-08-15T15:04:43Z). CI green; ECS deploy job succeeded
  (backend + PWA task-def revisions incremented, rolloutState COMPLETED).
- **CertMateUnified PR #64** ("ep: PLAN-G2 (iOS) — P4 decline-ack mode-off exemption +
  p4ack_ dedupe token — ALL PASSED") merged `da655db6` (2026-08-15T15:32:13Z) — required
  `gh pr ready 64` first (opened as draft). TestFlight build 436: archived, uploaded, VALID,
  added to the Electricians external group, submitted for beta review
  (WAITING_FOR_REVIEW). Build-number bump (435→436) committed separately (`f953fa4`,
  `chore: bump build to 436 for TestFlight`).

## Commits

**EICR_Automation** (14 total on `ep/PLAN-G-20260814T102231Z-ep`, chronological — PLAN-G's
own 6 plus PLAN-G2's 8):

1. `9bd3aec3` — PLAN-G backend P4 decline-ack bypass gate
2. `1a9542d8` — PLAN-G web companion
3. `6fb74c4e` — PLAN-G docs
4. `6271e973` — PLAN-G Codex cycle-1 fixes
5. `d992ab2a` — PLAN-G Codex fix-hunk mini-review fixes
6. `75f24d17` — PLAN-G execution log
7. `9fd1cb4c` — PLAN-G2 change 2 (backend) — `p4ack_<turnId>` structural dedupe token
8. `e9b197bd` — PLAN-G2 change 2 (web) — `p4ack_` prefix recognition
9. `f2c906f9` — PLAN-G2 canonical-reference sweep (docs, fixture strengthen, manifest regen)
10. `70352452` — PLAN-G2 close-out — architecture.md iOS note de-staled
11. `68702e17` — PLAN-G2 Codex cycle 1 fixes
12. `0cfda050` — Plan-00 oracle digest regen after pre-commit prettier pass
13. `a85d3366` — PLAN-G2 Codex cycle 2 fixes
14. `20d15a6a` — PLAN-G2 Codex cycle 3 (final) fix

**CertMateUnified** (3 total on `ep/PLAN-G2-ios-20260814T135556Z-ep`):

1. `1dfe9bd` — PLAN-G2 changes 1+2 (iOS)
2. `e8a138f` — Codex cycle 1 fixes
3. (merge `da655db6`; build-bump `f953fa4` committed to `main` post-merge, separate from
   the PR)

## Files touched

- **Backend:** `src/extraction/stage6-shadow-harness.js`, `src/extraction/ios-dedupe-key.js`,
  `src/extraction/stage6-event-bundler.js`, `src/extraction/plan00-lifecycle-hooks.js`,
  `src/extraction/sonnet-stream.js`, `scripts/model-ab/lib/semantic-judge.mjs`,
  `scripts/model-ab/plan00-expectation-manifest.json`,
  `tests/fixtures/field-replay-corpus/frc_85ace7677.../fixture.yaml` (comment only, net
  revert), `src/__tests__/stage6-ask-decline-ack-net.test.js`,
  `src/__tests__/stage6-event-bundler-debounce.test.js`, `src/__tests__/ios-dedupe-key.test.js`,
  `src/__tests__/plan00-lane-driver.test.js`, `src/__tests__/field-replay/fixture-schema.test.js`
- **Web:** `web/src/lib/recording/confirmation-dedupe-key.ts`,
  `web/tests/confirmation-dedupe-key.test.ts`
- **Docs:** `docs/reference/architecture.md`, `docs/reference/field-replay-corpus.md`,
  `docs/reference/ios-pipeline.md`, `CLAUDE.md`, `docs/reference/changelog.md`
- **iOS:** `Sources/Recording/DeepgramRecordingViewModel.swift`,
  `Tests/CertMateUnifiedTests/Recording/P4DeclineAckModeGateTests.swift` (new),
  `Tests/CertMateUnifiedTests/Recording/ConfirmationDedupeKeyTests.swift`,
  `CertMateUnified.xcodeproj/project.pbxproj` (xcodegen regen — new test file registration
  only), `Sources/Info.plist` (build-number bump, separate commit)

## Follow-ups noticed

None. Both of PLAN-G's held findings are now fully closed; every Codex finding across both
review loops (7 total: 4+3+1 backend/web, 2+0 iOS) was fixed in-run. No `OUT_OF_SCOPE` or
`OUT_OF_INTENT` items were held this run.

## Stashes left behind

None.

## Assumed decisions

None — this run had a pre-resolved decision (Derek's 2026-08-14 "fix both, ship together")
and no further ambiguity-ladder judgement calls were required.

## Worktree cleanup

Both worktrees removed post-merge:
`/Users/derekbeckley/Developer/EICR_Automation-ep-20260814T135556Z-ep` and
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified-ep-20260814T135556Z-ep`.
Merged local branches deleted (`ep/PLAN-G-20260814T102231Z-ep`,
`ep/PLAN-G2-ios-20260814T135556Z-ep`).

## Make-it-live (post-merge `main` sync)

- **CertMateUnified:** clean, already fast-forwarded to `da655db6` / `f953fa4` — confirmed
  live.
- **EICR_Automation:** SKIPPED — the local `main` checkout has a pre-existing uncommitted
  `package-lock.json` change that predates this session (present in the session's opening
  `git status`). Per the `/ep` skill's non-destructive rule, dirty state is left untouched
  rather than stashed/reset. `origin/main` itself is current (deploy succeeded from CI, which
  builds from the merge commit directly) — only the developer's local checkout is behind.
