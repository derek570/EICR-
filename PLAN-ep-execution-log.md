# /ep execution log — P7 obs-dedupe-demotion (marker ④, feedback id 82)

- Session: `20260724T113749Z-ep` (chain hop 4)
- Plan: `~/.claude/handoffs/EICR_Automation--p7-obs-dedupe-demotion-2026-07-23/PLAN-final.md`
- EICR_Automation worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260724T113749Z-ep`, branch `ep/PLAN-20260724T113749Z-ep` off `main` @ `e7a97cff`
- iOS repo (CertMateUnified, SEPARATE gitignored repo): `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`

## Structural facts (verified at startup)

- CertMateUnified is a SEPARATE nested git repo, gitignored in EICR_Automation → the `/ep` worktree isolates ONLY EICR_Automation. iOS work happens in an isolated CertMateUnified worktree off iOS `origin/main` (@ `ee71c8c`, clean — NOT the HELD `marker1-numeric-chatter-gate` branch the checkout sits on).
- Swift file is `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` (plan cited `Sources/…` — line/path shifted post P1/A1/P5/P2).
- **Cross-repo delivery pattern (P2 precedent, this same batch):** Web + docs (EICR_Automation worktree) = full `/ep` deliverable → gate → Codex → merge → deploy. iOS (CertMateUnified worktree) = compile-verified + committed + **draft PR, NOT merged/TestFlighted** — rides the SUPERVISED P7-shared TestFlight build (autonomous runs have no reliable iOS test loop; P2's iOS PR #35 is a draft awaiting the same shared build). P7's plan says "ride the SAME build as P2" → consistent.

## Steps

### iOS Fix 1 — applySonnetObservations id-keyed upsert (Fix spec 1)
- Status: applied
- Decision: rule 1. Replaced the >0.7 text-similarity gate with server `observation_id` keying: non-nil id already present → IDEMPOTENT REPLAY (fill-absent-only on regulation/rationale/regulationTitle/regulationDescription/scheduleItem, `continue` BEFORE the pending-photo/recentObservationId/observation_added creation side-effects); non-nil id not seen → apply (server authoritative); nil/empty id → retain the text-similarity fallback for id-less rows ONLY. Added one-release diagnostic `observation_apply {observation_id, dedupe_bypassed_reason[, filled_absent]}` via `serverWS.sendClientDiagnostic` + debug log.
- Files: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`

### iOS Fix 2 — observation_update handler id-first scoped fuzzy (Fix spec 2)
- Status: applied
- Decision: rule 1. Fuzzy fallback now SKIPS any row carrying a DIFFERENT server id when the incoming id is non-empty (`if incomingId != nil, !(obs.serverId ?? "").isEmpty { return false }`); on a legacy (no-serverId) fuzzy match with a non-empty incoming id, the id is STAMPED onto the matched row (`matchedByFuzzyLegacy`). nil incoming id keeps the unrestricted fuzzy (older-server compat).
- Files: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`

### iOS tests (Fix spec / Tests-gates)
- Status: applied
- Decision: rule 1. New `ApplySonnetObservationsP7Tests.swift` (distinct-id/high-overlap both render; distinct-id/identical-text both render; same-id replay one entry + fill-absent + NO creation side-effects; refine→replay no stale restore; non-tail-row pending-photo untouched; nil-id text fallback dedupe+render). Extended `HandleObservationUpdateTests.swift` with the 3 P7 update-handler cases (id-miss+nil-server-id→update+stamp; nil-incoming fuzzy; distinct-id→create-without-mutating). Added VM `_test_` hooks: `_test_applySonnetObservations`, `_test_setPendingObservationPhoto`, `_test_pendingObservationPhotoPath`, `_test_recentObservationId`.
- Files: `CertMateUnified/Tests/CertMateUnifiedTests/Recording/ApplySonnetObservationsP7Tests.swift`, `.../HandleObservationUpdateTests.swift`, `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`
- Note: the new test file wasn't in the committed (XcodeGen-managed) `.xcodeproj`; ran `xcodegen generate` (clean +4-line diff, project.yml already in sync) so it compiles into the target. Reverted the unintended `Info.plist` CFBundleVersion 420→100 the regen made (build numbering is deploy-testflight's job; this run ships a DRAFT iOS PR, not a TestFlight). iOS commit `6eb223c`.
- Tests run: `xcodebuild build-for-testing` (app+tests) exit 0; `xcodebuild test -only-testing:ApplySonnetObservationsP7Tests` → 6/6; `HandleObservationUpdateTests` → 11/11 (8 original + 3 new P7). All green.

### Web Fix 3 — applyObservations id-keyed + replay metadata + scoped fuzzy (Fix spec 3)
- Status: applied
- Decision: rule 1. `applyObservations` now keys on `server_id`: replay → fill-absent-only; nil-id → retained `observationLooksDuplicate`. Return type changed `ObservationRow[] | null` → `{rows, acceptedForSchedule} | null`; the single caller (`applyExtractionToJob`) updated to gate `markScheduleItemsFromObservations` on `acceptedForSchedule` (never the raw frame) and photo/reverse-link on a real APPEND (not `changed`). `applyObservationUpdate` fuzzy loop scoped: `if (hasIncomingId && existing[i].server_id) continue`. EIC schedule path preserved as `[]` (observations dropped → nothing accepted; consistent with "gate on accepted creations").
- Files: `web/src/lib/recording/apply-extraction.ts`
- Web commit `cdd1511d`.

### Web tests + docs (Tests-gates + Documentation)
- Status: applied
- Decision: rule 1. New `web/tests/apply-extraction-observations-p7.test.ts` (10 cases incl. the DISCRIMINATING clear→replay schedule regression). RETAINED M9/exact-dedupe parity tests pass UNCHANGED (nil-id fallback path). Docs: ios-pipeline.md new "Observation apply identity (P7)" section; changelog.md + hub CLAUDE.md rows; parity-ledger.md new `recording/observation-id-dedupe` row (partial until device smoke) + files-map entry. Docs commit `fccec6b3`.
- Files: `web/tests/apply-extraction-observations-p7.test.ts`, `docs/reference/ios-pipeline.md`, `docs/reference/changelog.md`, `CLAUDE.md`, `web/docs/parity-ledger.md`, `web/docs/parity-ledger-files.json`

### Gates
- iOS: build-for-testing exit 0; P7 apply 6/6 + update-handler 11/11 green.
- Web: focused observation suite 51/51; **full web workspace suite 1467 passed / 1 skipped / 0 failed**; eslint clean on changed files; typecheck adds ZERO new errors (17 pre-existing on `main` in two untouched test files); parity-ledger check 0 duplicate/stale/blank.
- Node: local run on Node 25 (dev box; no Node 20 available). Change is pure logic in `apply-extraction.ts` (no jsdom/Storage) → Node-version-insensitive; the authoritative merge gate is CI's Node-20 "Test Frontend" job.

## Codex diff review

Reviewed the COMBINED cross-repo implementation (web+docs worktree diff + iOS diff) against the plan — P7 is cross-platform so both diffs are one logical change.

### Cycle 1 (gpt-5.6-sol, high) — 2 BLOCKER + 2 IMPORTANT, all APPLIED (in-scope)
- **[BLOCKER] web schedule projection from raw obs** (`apply-extraction.ts`): a replay that filled an ABSENT `schedule_item` projected the STALE replay `code` (row may have been refined), and a creation's M11-stripped invalid ref still reached `markScheduleItemsFromObservations` (no ref validation → orphan key). FIX (in-scope): dropped the replay `schedule_item` fill entirely (plan allows "at most fill absent"), and normalised the creation projection to `{...obs, code, schedule_item: row.schedule_item}` (validated ref + parsed code). Discriminating schedule test still holds.
- **[BLOCKER] iOS replay filled `scheduleItem` without linking** (`DeepgramRecordingViewModel.swift`): filling the field skipped `ObservationScheduleLinker`, so the Inspection-tab outcome stayed blank AND diverged from web. FIX (in-scope): dropped the iOS replay `scheduleItem` fill too — symmetric with web; a replay now fills only pure data fields (regulation/rationale/canonical wording) on BOTH clients.
- **[IMPORTANT] web tests weaker than the plan mandate**: the photo test used a single row (not a non-tail match) and there was no web refine→replay-preserves-fields test. FIX: photo test now seeds matched-non-tail A + unrelated tail B (asserts neither gets the photo); added an initial→refine→ORIGINAL-replay test (absent regulation fills; since-refined code+text NOT restored).
- **[IMPORTANT] legacy-stamp tests hit the exact-match shortcut** (iOS + web): `original_text` equalled the row text, so the >70% fuzzy branch never ran. FIX: changed both to non-identical ~86%-overlap text ("small hole **on** the side **of** enclosure").

### Cycle 2 (gpt-5.6-sol, high) — 1 BLOCKER + 2 IMPORTANT
- **[BLOCKER] replay could restore CLEARED canonical wording** (both clients): the fill-absent set still included `regulation_title`/`regulation_description`, which `observation_update` sets UNCONDITIONALLY (a table-miss clears them to nil). Codex's insight generalises: a replay is the SAME frame the original apply consumed, so fill-absent can ONLY no-op or restore an authoritatively-cleared field → never useful, sometimes harmful. FIX (in-scope, APPLIED): made the idempotent-replay a **PURE NO-OP** on BOTH clients (log + skip; fill nothing). Plan-faithful ("at most fill absent" → filling none). Added regression tests: replay after an `observation_update` that CLEARED `regulation_title` → wording NOT restored (iOS `testReplay_DoesNotRestoreClearedCanonicalWording`; web equivalent). Docs (ios-pipeline.md + changelog + hub + parity ledger) updated fill-absent → pure no-op.
- **[IMPORTANT] web `observation_update` does not reconcile `inspection_schedule`** — OUT OF SCOPE (pre-existing, not applied). `applyObservationUpdate` (the pure fn P7 touched) never reconciled schedule; the CALLER (`recording-context.tsx onObservationUpdate`) persists only `{observations}`. P7 did NOT introduce or worsen this — it's a separate pre-existing web/iOS parity gap in the observation_update→schedule path, unrelated to the dedupe demotion (Fix spec 3 does not cover it). FOLLOW-UP: vault todo `todos-certmate.md` — "web observation_update should reconcile inspection_schedule.items (iOS parity)". Not a P7 ship blocker.
- **[IMPORTANT] full iOS suite not run** — VALID per plan "Full iOS suite … before … PR delivery". APPLIED: ran the complete `xcodebuild test` scheme — **1023 functional test cases passed, 0 failures** (both P7 classes green in the full run); the run was killed by the environment during the trailing `PerformanceTests` timing BENCHMARKS (non-correctness; one already passed at 0.795s). iOS ships a DRAFT PR (rides the supervised P7-shared TestFlight build where the full suite incl. perf re-runs with a human — P2 precedent).

### Cycle 3 (gpt-5.6-sol, high) — CLEAN
Empty findings. "No remaining BLOCKER or IMPORTANT … Both clients implement pure no-op same-ID replay, distinct-ID creation, legacy nil-ID fallback, and scoped fuzzy observation updates; web schedule projection uses normalized accepted creations only." Two comment-only NITs (retired fill-absent wording) fixed best-effort. **Codex diff review verdict: PASSED.**


## Completed 2026-07-24T13:40:00Z

### Outcome header: ALL PASSED

Two-repo deliverable, both gate-green + Codex-clean (cycle 3 empty findings):
- **EICR_Automation worktree (web + docs)** → full `/ep` deliverable: ready PR → merge → CI → ECS (frontend) → make-live.
- **CertMateUnified (iOS, separate repo)** → DRAFT PR, NOT merged/TestFlighted — rides the supervised P7-shared TestFlight build (autonomous runs have no reliable iOS test loop; P2 precedent, plan "ride the SAME build as P2").

### Commits — EICR_Automation branch `ep/PLAN-20260724T113749Z-ep`
- `cdd1511d` — web companion (server-id dedupe + `{rows, acceptedForSchedule}` metadata + scoped fuzzy)
- `fccec6b3` — docs (ios-pipeline P7 section + changelog + hub + parity ledger + files-map)
- `0b0c339f` — Codex cycle-1 (web schedule projection normalise + test faithfulness)
- `564efcb0` — Codex cycle-2 (web replay = pure no-op + cleared-wording regression + doc sync)
- `a555ee42` — comment cleanup (pure-no-op wording)
- (final) — this execution log

### Commits — CertMateUnified branch `ep/p7-obs-dedupe-20260724T113749Z-ep`
- `6eb223c` — P7 iOS (applySonnetObservations id-keyed + observation_update scoped fuzzy + tests + hooks)
- `01c54a7` — Codex cycle-1 (drop replay scheduleItem fill + fuzzy test)
- `5e055dd` — Codex cycle-2 (replay = pure no-op + cleared-wording regression)

### Files touched
- Web: `web/src/lib/recording/apply-extraction.ts`, `web/tests/apply-extraction-observations-p7.test.ts`
- Docs: `docs/reference/ios-pipeline.md`, `docs/reference/changelog.md`, `CLAUDE.md`, `web/docs/parity-ledger.md`, `web/docs/parity-ledger-files.json`
- iOS: `Sources/Recording/DeepgramRecordingViewModel.swift`, `Tests/CertMateUnifiedTests/Recording/ApplySonnetObservationsP7Tests.swift`, `Tests/CertMateUnifiedTests/Recording/HandleObservationUpdateTests.swift`, `CertMateUnified.xcodeproj/project.pbxproj`

### Plan deviations
None. One Codex-suggested fix (make the replay a pure no-op vs the plan's "fill absent") was applied within the plan's explicit "at most fill absent" latitude — a tightening, not a deviation; intent_verdict null (in-scope).

### Assumed decisions
- iOS delivery = DRAFT PR (not TestFlight) per the P2 batch precedent + plan "ride the SAME build as P2" (the supervised P7-shared build). Rationale in the Structural facts header.

### Skipped / blocked / failed
None. One Codex IMPORTANT (web `observation_update`→schedule reconciliation) was PRE-EXISTING + out of P7 scope → vault follow-up `todos-certmate.md`, not applied.

### Tests run + result
- Web: full workspace suite **1469 passed / 1 skipped / 0 failed**; P7 focused 12; retained M9/exact-dedupe unchanged; eslint clean; ZERO new typecheck errors (17 pre-existing on main, untouched files); parity-ledger check 0 dup/stale/blank.
- iOS: `xcodebuild build-for-testing` exit 0; focused P7 6 + update-handler 11 green; full suite **1023 functional passed / 0 failed** (killed during perf benchmarks).
- Codex diff review: 3 cycles → PASSED (cycle-1 2B+2I, cycle-2 1B+2I, cycle-3 CLEAN).
