# PLAN-E-TERM — /ep execution log

- Session: `20260828T012430Z-ep` (chain hop 3)
- Started: 2026-08-28T01:24:30Z
- Plan: `/Users/derekbeckley/.claude/handoffs/EICR_Automation--feedback-2026-08-23/PLAN-E-TERM-final.md`
- Web worktree: `/Users/derekbeckley/Developer/EICR_Automation-ep-20260828T012430Z-ep` (branch `ep/PLAN-E-TERM-20260828T012430Z-ep` off `main` @ `e9684df0`)
- iOS worktree: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified-ep-20260828T012430Z-ep` (branch `ep/PLAN-E-TERM-ios-20260828T012430Z-ep` off `main` @ `4e850f2`)

## Setup notes

- Reap sweep: `ep-reap: reaped=0 held=0 working=1 pattern=^ep-`.
- Pre-claim policy (`PLAN-E-TERM-final.md.ep-policy.json`): PLAN-E1B and PLAN-E1B2 success records present, well-formed, merge commits `54ff333` (CertMateUnified) and `94904786` (EICR) are ancestors of each `origin/main`. **Artifact hash check: 2 of 4 pins no longer match `origin/main`** — `web/src/lib/recording/voiced-activity.ts` (recorded `2d9cd558…`, main `d8884d38…`) and `Sources/Services/UplinkScopeTypes.swift` (recorded `d89344c0…`, main `b142599d…`). Both recorded hashes DO match at each predecessor's own merge commit, and the ONLY commits touching either file since are PLAN-E2's merged + deployed + ALL_PASSED run (web `2bbe02af` via PR #200; iOS `b388c1a`/`0236fd6`/`b44ba4a` via PR #72). PLAN-E2 is this plan's declared hard prerequisite ("Depends on: PLAN-E2 MERGED first"). The sidecar was authored 2026-08-27T11:19, BEFORE E2 executed, so the pins are structurally stale by the wave's own merge order rather than a failed prerequisite. **`[ASSUMED]` gate: proceeded** — the check the pin exists to make (predecessor deliverable merged, present, not reverted) is affirmatively verified; a literal exit would stall the wave on a tautology. Flagged loudly here so the morning read can disagree.
- `[FOLLOWUP]` ep-policy artifact pins break by construction when a LATER required predecessor rewrites the pinned file — `PLAN-E-TERM-final.md.ep-policy.json` pinned `voiced-activity.ts`/`UplinkScopeTypes.swift` which E2 (also required) then modified; either pin at the predecessor's merge commit (verify hash AT `merge_commit`, not at HEAD) or make /rp omit artifact_ids for files a sibling plan names. Smallest action: change the /ep skill's artifact check to "hash matches at `merge_commit` AND path still exists at HEAD".
- PLAN-E-WAKE is PARKED (`.ep-queue.parked-20260827`; Derek 2026-08-27: auto-sleep returns as its own plan at production time). Merge order collapses to E2 → E-TERM. `[ASSUMED]` the plan's "binds the durable store to E-WAKE's teardown staged-loss event" carve-out has no event to bind to yet; the store binds to E2's staged-loss event generically (any `stagedLoss` LossSourceId accrual), so when E-WAKE ships its finalizer emits through the same seam and persistence follows without a TERM change.
- Original iOS checkout (`CertMateUnified/`) is dirty only on `Sources/Info.plist` (build-number churn from build 440) — untouched; iOS work happens in the worktree.
- `[PLAN-SIZE]` this plan bundles ~7 feature items across two clients (durable store + schema, piecewise sample→wall-clock mapping, banner + visibility predicate, PDF-success active-session filter, auth purge, completion counter + reconciliation harness, docs/vault) — a single feature-group (the residue record) but touching two clients' recording, job-detail, PDF, and auth surfaces. Expect a multi-cycle Codex convergence.

## Design decisions made at execution time (`[ASSUMED]`, rule 2)

(appended as made)

## Steps

- `[ASSUMED]` Capture discontinuities are DETECTED from data, not declared per edit site: the piecewise map (`capture-wall-clock.ts` / `CaptureWallClock.swift`) records a new anchor whenever a captured segment's ingress wall-clock diverges from the sample-extrapolated time by >250 ms. The plan names pause/interruption/TTS-excluded as the anchor moments; detection covers those three AND any discontinuity no edit site names, and needs only the ONE tagging boundary (web `onSamples`; iOS both `tagCapturedSegment` and `sendAudio`). Pinned by the ten-minute-pause and TTS-gap tests on both clients.
- `[ASSUMED]` Evidence seam: `UplinkLossLedger` gains an OPTIONAL `onSourceEvidence` callback (fires at first material accrual and on every later evidence change of a material source — join, partial watermark retirement). The plan says "any need of this plan that E2's machinery cannot meet is a finding against THIS plan, not a licence to edit E2's shipped invariants"; this is additive (default nil/undefined → E2 byte-for-byte), touches no invariant, and is the only way the record can carry a capture range (E2 deleted all wall-interval tracking). Same for `UplinkLossDisclosureLedger.onCompleted` + the `disclosure_completed` telemetry the plan itself assigns to TERM.
- `[ASSUMED]` Identity source: web `getUser()` (auth.ts) + `jobRef` at `start()`; iOS `AuthService.shared.currentUser?.id` + `jobVM.job.id` at `performStartRecording`. No signed-in user → no binder (E2 unchanged). The plan says "both clients' recording layers already hold user+job context at that point" without naming the accessor.
- `[ASSUMED]` Web session-active signal: `RecordingActions.getClientSessionId()` — a read-only getter over the existing `sessionIdRef` (which the frozen `stop()` already clears) — rather than a new state field, so `stop()` needs no edit. Consumers pair it with `state !== 'idle'`. iOS: `activeRecordingSessionId` = `sessionId` while recording/paused/preparing.
- `[ASSUMED]` iOS store location `Sources/Recording/` exactly as the plan states, although the ledger OWNER (`DeepgramService`) lives in `Sources/Services/`; the completion hook (`AlertManager`) and the identity holder (the ViewModel) are in `Sources/Recording/`, so "beside" holds for the consumers.
- `[ASSUMED]` iOS single-instance rule satisfied by `UnresolvedAudioStore.shared` with injectable parameters on the ViewModel (`unresolvedAudioStore`), `PDFTab` (`unresolvedAudioStore`, `activeRecordingSessionId`), and `AuthService` (`unresolvedAudioStore`) — production passes nothing, so every consumer holds the SAME instance; tests inject temp-directory stores.
- `[ASSUMED]` Stop mid-playback needs no dedicated write: the record was upserted at accrual, the abandon path performs no completion accounting, and `resolved_via` stays null — exactly the "token non-natural-terminal at session end = undisclosed" case (pinned).
- `[ASSUMED]` The iOS ledger callback runs on the service queue; the wall-clock conversion happens THERE (the map is queue-confined) and the delegate hop to main carries a fully-formed `UplinkLossEvidenceUpdate` (mirrors E2's `publishDisclosureRelease` hop).

## Step 1 — Durable store schema + lifecycle (both clients)
- Status: applied
- Decision: rule 1 (schema verbatim: `(userId, jobId, recordingSessionId, lossSourceId)` key, CAPTURE-time anchors, voiced duration, ONE `resolved_via` terminal, tombstones, purge = sole deletion)
- Files: `web/src/lib/recording/unresolved-audio-record.ts`, `unresolved-audio-store.ts`, `web/src/lib/pwa/job-cache.ts` (v6 store + `clearJobCache`); iOS `Sources/Recording/UnresolvedAudioStore.swift`, `AuthService.swift`
- Commit: web `5d5dec56`; iOS `7b59bb4`

## Step 2 — Written incrementally on E2's loss-event paths (both clients)
- Status: applied
- Decision: rule 2 (additive `onSourceEvidence` / `onCompleted` seams — see `[ASSUMED]`)
- Files: `uplink-loss-ledger.ts`, `uplink-loss-disclosure.ts`, `tts.ts`, `recording-context.tsx`; iOS `UplinkLossLedger.swift`, `UplinkLossDisclosure.swift`, `DeepgramService.swift`, `AlertManager.swift`, `DeepgramRecordingViewModel.swift`, `ServiceProtocols.swift`
- Commit: as above

## Step 3 — Piecewise sample→wall-clock mapping (both clients)
- Status: applied
- Decision: rule 2 (data-detected discontinuities — see `[ASSUMED]`)
- Files: `capture-wall-clock.ts`; iOS `CaptureWallClock.swift`
- Commit: as above

## Step 4 — Surfacing: banner, visibility predicate, dismissal (both clients)
- Status: applied
- Decision: rule 1 (web banner beneath RecordingProvider in `job/[id]/layout.tsx`; iOS banner in `JobDetailView` above tab content; predicate pinned)
- Files: `web/src/components/recording/unresolved-audio-banner.tsx`, `web/src/app/job/[id]/layout.tsx`, `web/src/lib/job-context.tsx`; iOS `JobDetailView.swift`
- Commit: as above

## Step 5 — Certificate completion clear, active-session filtered (both clients)
- Status: applied
- Decision: rule 1 (web after `setPdfBlob(blob)`; iOS after `PDFGenerator.generate` + file write; inactive sessions only)
- Files: `web/src/app/job/[id]/pdf/page.tsx`; iOS `PDFTab.swift`
- Commit: as above

## Step 6 — Completion counter `uplink_loss_episode_disclosure_completed` (both clients)
- Status: applied
- Decision: rule 1 (source-cardinal, idempotent per session|source, natural completion only; E2's `disclosed` untouched)
- Commit: as above

## Step 7 — Tests 1 / 3 / 4 / 5 / 5a / 5b / 6 / 6a / 6b
- Status: applied
- Decision: rule 1. Web: `capture-wall-clock`, `unresolved-audio-record` (through the REAL E2 ledgers + an in-memory port with the IDB port's merge/resolve semantics), `unresolved-audio-store` (fake-indexeddb), `unresolved-audio-wiring` (frozen surfaces + placement). iOS: `CaptureWallClockTests`, `UnresolvedAudioStoreTests` (real ledgers → temp-dir store, restart persistence), `DeepgramServiceUnresolvedAudioTests` (capture-time window after a pause, evidence re-issue, retired_immaterial hop), `AlertManagerUnresolvedAudioCompletionTests` (observer via the real FIFO). Test 5 (frozen surfaces): web source-adjacency on `stop`/`pause`/`resume`/`handleWake`/`cancelSpeech`; iOS `performStopCleanup`/`stop()` untouched by construction (no diff hunk in either — verified in the review patch).
- Commit: web `c02201cc`, `5ad7edb6`; iOS `7b59bb4`

## Step 8 — Docs + delivery checklist
- Status: applied
- Files: `docs/reference/changelog.md` (full row), hub `CLAUDE.md` (one-liner; the 2026-08-11 `second→circuit` row dropped to stay under the 45k budget — its detail is in changelog.md), `docs/reference/ios-pipeline.md` § Post-session unresolved-audio record, `web/docs/parity-ledger.md` row `recording/unresolved-audio-record`; iOS `CLAUDE.md` Recent Changes row. `file-structure.md` has no recording-lib listing to extend (the new stores are documented in ios-pipeline.md instead). Vault reconciliation (a)(b)(c) — see the Completed block.
- Commit: web `bf02d396`; iOS `8386e25`

## Gates (pre-review)
- Web: tsc 0 new errors (the 5 pre-existing failing test files on `main` unchanged), eslint clean on touched files, vitest **2313 passed / 1 skipped / 0 failed**; backend Jest **9365 passed / 19 skipped**.
- iOS: `xcodebuild test` full suite **2068 executed / 1 skipped / 0 failures** (iPhone 17 simulator).

## Codex diff review

### Cycle 1 (2026-08-28) — 3 parallel lenses, gpt-5.6-sol high, read-only

Lens (a) contract: 6 BLOCKER · lens (b) silent-path: 8 BLOCKER · lens (c) edge: 10 BLOCKER. Deduped to 13 distinct findings (`PLAN-E-TERM-ep-review-r1-{contract,silent,edge}.json`).

APPLIED (in scope; web `381bb2ee`+`f9ace1f8`, iOS `817bfce`):
1. Composite key `(userId, jobId, session, source)` — both clients (+ collision tests).
2. iOS double async hop (ordering/durability): the ViewModel commits SYNCHRONOUSLY via `MainActor.assumeIsolated` on the service's FIFO main hop; identities keyed by session (a late outgoing-session event still resolves after a fast stop→start); regression `DeepgramRecordingViewModelUnresolvedAudioTests`.
3. Purge fencing — web: generation-fenced per-session ports + purge on the serialised chain, called from `clearAuth()`; iOS: identity carries the store generation, `logout()` purges before the network await, expiry/`me()`-failure paths purge, `login` purges another user's rows (tests both sides).
4. iOS single-instance injection: banner + both `PDFTab` constructions use `recordingVM.unresolvedAudioStore`.
5. Completion accepted for a never-played token: `hasPlayed` on the token; E2's completion accounting unchanged, TERM's counter + `onCompleted` only after playback (tests both sides). Codex also suggested routing web `prepareElevenLabs()` entry-cancel through `onError` — NOT done: that is E2's own `tts.ts`/`elevenlabs-tts.ts` surface and an existing vault follow-up; the TERM-side guard makes the record immune regardless.
6. Sub-tolerance discontinuities: `markDiscontinuity()` forced anchors at the TTS-gate release + `resume()` (web) and `setCaptureActive(true)` + `resumeAudioStream()` (iOS), on top of detection. Found + fixed a follow-on bug in my own fix (forced anchor not consumed at the first observation).
7. Atomic + awaited certificate clear (web: one enqueued read-write transaction; PDF page awaits it).
8. Cross-tab active set (web: `active-session-registry.ts` heartbeat leases over BroadcastChannel, self-stopping on the session ref the frozen `stop()` clears; `error` never active). iOS: a single-scene app with one recording ViewModel per `JobDetailView`; `activeRecordingSessionId` IS the process-wide set — no registry added (`[ASSUMED]`).
9. Late reports on a DISCLOSED epoch refresh the record (absorbed, never re-disclosed) — both ledgers.
10. Staged-loss coalescing requires overlap/adjacency in either direction — both ledgers. (The "staging-owner scope" half of the finding is NOT done: E2 deliberately keys staged sources by contiguity only; adding owner scope changes E2's disclosure semantics — logged as a follow-up.)
11. IDB: `onversionchange` closes the cached handle; the store is primed at `start()`. The "retain/retry until commit" half is NOT done (a retry loop around IDB writes is beyond the plan; the serialised chain + priming closes the realistic window).

FALSE POSITIVES (artefacts of my r1 diff filters): "pbxproj missing" (committed; excluded from the patch), "docs/changelog/vault omitted" (committed/done; excluded). r2 diffs are unfiltered. `file-structure.md` rows added anyway.

HELD / DECLINED with reasons:
- **PLAN-E-WAKE prerequisite** (lens c): E-WAKE was PARKED by Derek on 2026-08-27 (vault todo: "Reintroduce auto-sleep as its OWN plan at production time — NOT before"), so the merge order collapsed to E2 → E-TERM by owner decision. The store binds to E2's staged-loss seam generically; E-WAKE's finalizer will persist through the same seam. Not a plan-wrongness, a sequencing decision already made — listed as an accepted deviation for cycle 2.
- Cross-tab registry on iOS (see 8).

Gates after fixes: web vitest full suite 2327 passed / 1 skipped (`/tmp/eterm-web-vitest2.log`, before the last one-line wall-clock tweak whose own tests pass); iOS affected classes green; full iOS suite running.

### Cycle 1 fix-hunk mini-review (2026-08-28) — gpt-5.6-sol high

4 BLOCKER + 6 IMPORTANT on the fix hunks themselves (`PLAN-E-TERM-ep-minireview-c1.json`). ALL applied (web `72ddfaad`; iOS `8d130ef` + the mini-review commit):
1. iOS `Episode` struct copies per epoch → one shared `DisclosedEpisodeBox` per episode (caught independently by my own read before the review returned).
2. Purge generation module-local across tabs → purge broadcasts `purged`; every tab advances its generation on receipt. (The "IDB-transactional auth-epoch token" half was NOT built — in-memory cross-tab invalidation closes the realistic window; noted as partial.)
3. Ephemeral leases: `query` on open (late subscriber), 75 s lease (background throttling), `announceActiveSession` returns an end fn. (Persisting leases in IDB — NOT built; same rationale.)
4. Stale `recordingState` closure in the PDF page → `getActiveRecordingSessionId()` getter over the live refs (never `idle`/`error`), used by banner, PDF page and the heartbeat predicate (which therefore also stops on `error`).
5. Competing purge owners → `clearJobCache` no longer clears the store; `purgeUnresolvedAudio()` (called from `clearAuth`) is the SOLE owner.
6. `hasPlayed` sticky across re-park → reset on every non-natural terminal (both clients).
7. iOS logout: `currentUser = nil` synchronously BEFORE purge + network await.
8. Wall-clock exclusive end mapped through the range's LAST sample (+1 sample) on both clients.
9. iOS identity eviction: explicit insertion-order deque.
Re-gate: web affected suites 142/142 + full suite running; iOS affected classes 107/107 + full suite running.

### Cycle 2 (2026-08-28) — single pass, gpt-5.6-sol high

2 BLOCKER + 1 IMPORTANT (`PLAN-E-TERM-ep-review-r2.json`). Trend: 13 distinct → 3.
- "iOS pbxproj missing from the patch" — FALSE POSITIVE again (my diff filter); r3 iOS patch is fully unfiltered (pbxproj included).
- `setAuth` account switch without purge (BLOCKER) — APPLIED: purge when a different user signs in over a still-present previous user; same-user re-auth keeps rows (`auth-account-switch-purge.test.ts`).
- Wall-clock anchor from `Date.now()` after processing (IMPORTANT) — APPLIED: `performance.timeOrigin + capturedAt` (the ingress instant); wiring test pins it.
Gates: web full suite 2333 passed / 1 skipped (before these two one-line fixes; their own suites pass); iOS full suite — see below.

### Cycle 3 (2026-08-28) — single pass, gpt-5.6-sol high

3 BLOCKER (`PLAN-E-TERM-ep-review-r3.json`). Trend: 13 → 3 → 3 (all new, all applied; web `bc7c6098`, iOS cycle-3 commit):
1. Cross-tab purge fence checked only before the awaits → re-checked after `openDB()` and after the read (transaction aborted on mismatch); regression via the `__receiveRemotePurgeForTests` seam.
2. Stored terminal field named `resolvedVia`, plan pins `resolved_via` → web property renamed (it IS the IDB field); iOS `CodingKeys` maps `resolvedVia` → `resolved_via`; raw-representation tests on both clients.
3. PDF completion-boundary tests missing → web `pdf-tab.test.tsx` asserts the clear fires exactly once after the Blob (live active set) and never on a failed render; iOS `PDFTab.renderWriteAndClear` (render → write → clear, injectable seams) + `PDFTabUnresolvedAudioTests` (render failure / write failure keep rows; success clears only inactive sessions; no user → nothing).

### Cycle 4 (2026-08-28) — single pass, gpt-5.6-sol high

2 BLOCKER + 1 IMPORTANT (`PLAN-E-TERM-ep-review-r4.json`). Trend: 13 → 3 → 3 → 3 (all applied):
1. Web lease disposer ignored → retained in a ref; invoked on session replacement, on `idle`/`error`, and on provider unmount (never in the frozen `stop()`); registry test proves the heartbeat stops after `end()`.
2. iOS PDF clear read the active set BEFORE the render → `renderWriteAndClear` takes provider closures evaluated at the success instant; two suspended-render regressions (session starts mid-render → row kept; stops mid-render → cleared).
3. Docs said `clearJobCache` purges the store / PDF clear fire-and-forget → corrected (`clearAuth` → `purgeUnresolvedAudio()` sole owner; awaited clear).

### Cycle 5 (2026-08-28) — single pass, gpt-5.6-sol high

1 BLOCKER + 1 IMPORTANT (`PLAN-E-TERM-ep-review-r5.json`). Trend: 13 → 3 → 3 → 3 → 2 (all applied; web `ba970be7`, iOS cycle-5 commit):
1. Re-established auth with no recorded previous user could retain another user's rows → web `setAuth` reconciles the stored owner (`reconcileUnresolvedAudioOwner`) when no previous user is recorded; iOS `checkExistingSession` success path calls `purgeIfOwnedByOtherUser` before assigning the restored user. Tests both sides.
2. Changelog row said the store "joins clearJobCache()" → corrected to the sole-owner wording.
Gates after cycle 4 (before these two edits): web 2337 passed / 1 skipped; iOS 2096 executed / 0 failures / 1 skipped.

### Cycle 6 (2026-08-28) — single pass, gpt-5.6-sol high

1 IMPORTANT (`PLAN-E-TERM-ep-review-r6.json`). Trend: 13 → 3 → 3 → 3 → 2 → 1 (applied; web `8d95746a`, iOS cycle-6 commit): evidence republished per voiced frame became one physical write each → web: first row immediate, later snapshots coalesced per key into one batched transaction after 250 ms, resolve/clear/purge drain pending evidence first (ordering barriers), one notification per batch, job-context reload debounced; iOS: first row immediate, later evidence merged in memory and persisted once after 250 ms, terminals/purge persist synchronously. Tests on both clients (200 updates → ≤2 / 2 physical writes with the latest snapshot; terminal-after-pending-evidence ordering).
Gates after cycle 5: web 2338 passed / 1 skipped; iOS 2097 executed / 0 failures / 1 skipped.

### Cycle 7 (2026-08-28) — single pass, gpt-5.6-sol high — CLEAN

0 BLOCKER / 0 IMPORTANT / 0 NIT (`PLAN-E-TERM-ep-review-r7.json`): "Both diffs faithfully implement PLAN-E-TERM within the listed accepted deviations." Trend: 13 → 3 → 3 → 3 → 2 → 1 → **0**. **Verdict: PASSED.**

Final gates (post-cycle-6 code): web vitest **2340 passed / 1 skipped**; backend Jest **9365 passed / 19 skipped** (no backend file changed in this run); iOS `xcodebuild test` **2099 executed / 0 failures / 1 skipped**.

## Completed 2026-08-28T04:23:22Z

**Outcome: ALL PASSED** — every plan step applied or `[ASSUMED]` AND the Codex diff review converged CLEAN (cycle 7: 0/0/0) after 6 fix cycles + 1 fix-hunk mini-review. No WITHIN_INTENT plan deviation was applied. Both PRs merged; PWA deployed; TestFlight 442 submitted.

### Plan deviations
None applied. Two HELD-as-accepted sequencing/scope rulings (not code deviations): PLAN-E-WAKE parked by Derek (its teardown-finalizer binding test deferred with it); cross-tab leases and the purge fence are in-memory/broadcast rather than IDB-transactional (listed as accepted in every cycle ≥2 and not re-flagged).

### Commits (web branch `ep/PLAN-E-TERM-20260828T012430Z-ep` → EICR PR #201, merge `884bd866`)
- `5d5dec56` feat — store, binder, banner, PDF clear, purge · `c02201cc` tests · `5ad7edb6` test fixes · `bf02d396` docs
- `381bb2ee` + `f9ace1f8` Codex cycle 1 · `72ddfaad` mini-review · `abfb22d7` cycle 2 · `bc7c6098` cycle 3 · `7d2866c2` cycle 4 · `ba970be7` cycle 5 · `8d95746a` cycle 6

### Commits (iOS branch `ep/PLAN-E-TERM-ios-20260828T012430Z-ep` → CertMateUnified PR #73, merge `603af21`)
- `7b59bb4` feat + tests + xcodegen · `8386e25` docs · `817bfce` cycle 1 · `8d130ef` episode box · `0f006c1` mini-review · `1a5ce15` cycle 3 · `ae4e7a5` cycle 4 · `34c61ab` cycle 5 · `28ecee3` cycle 6
- main: `2cfbf38` chore: bump build to 442 for TestFlight

### Files touched
Web: `web/src/lib/recording/{capture-wall-clock,unresolved-audio-record,unresolved-audio-store,active-session-registry,uplink-loss-ledger,uplink-loss-disclosure,tts}.ts`, `web/src/lib/{recording-context,job-context}.tsx`, `web/src/lib/auth.ts`, `web/src/lib/pwa/job-cache.ts`, `web/src/components/recording/unresolved-audio-banner.tsx`, `web/src/app/job/[id]/{layout,pdf/page}.tsx`, tests (`capture-wall-clock`, `unresolved-audio-{record,store,wiring}`, `active-session-registry`, `auth-account-switch-purge`, `uplink-loss-disclosure`, `pdf-tab`, `pwa-pending-photo-store`), docs (`changelog.md`, hub `CLAUDE.md`, `ios-pipeline.md`, `file-structure.md`, `parity-ledger.md`).
iOS: `Sources/Recording/{CaptureWallClock,UnresolvedAudioStore,AlertManager,DeepgramRecordingViewModel}.swift`, `Sources/Services/{UplinkLossLedger,UplinkLossDisclosure,DeepgramService,ServiceProtocols,AuthService}.swift`, `Sources/Views/JobDetail/{JobDetailView,PDFTab}.swift`, tests (`CaptureWallClockTests`, `UnresolvedAudioStoreTests`, `DeepgramServiceUnresolvedAudioTests`, `AlertManagerUnresolvedAudioCompletionTests`, `AuthServiceUnresolvedAudioPurgeTests`, `DeepgramRecordingViewModelUnresolvedAudioTests`, `PDFTabUnresolvedAudioTests`, `UplinkLossDisclosureLedgerTests`, `Mocks/MockAlertManager`), `project.pbxproj`, `CLAUDE.md`.

### Assumed decisions ([ASSUMED] — sanity-check)
See "Design decisions made at execution time" at the top of this log, plus the pre-claim policy ruling in Setup notes (hash pins stale by E2's own merge — proceeded). All held through 7 Codex cycles.

### Skipped / blocked / failed steps
None.

### Stashes left behind
None. The pre-TestFlight stash (`ep: pre-TestFlight sync 20260828T012430Z-ep`) carried ONLY the superseded Info.plist build-number churn (437→440) and was dropped after the 442 bump was committed.

### Deploy
- EICR PR #201 merged `884bd866` → CI/CD run 33140960846 **success** (Test Backend / Test Frontend / npm Audit / Build & Scan / Deploy to AWS ECS all success) → `eicr-pwa:254` rollout COMPLETED; backend task def unchanged at `eicr-backend:420` (no backend files in this plan).
- CertMateUnified PR #73 merged `603af21` → TestFlight **1.0.0 (442)** VALID, added to "Electricians", WAITING_FOR_REVIEW — https://testflight.apple.com/join/W2dBKTSc. (Build 441's upload was cut by a tool timeout; the script re-ran cleanly as 442.)
- LIVE: EICR_Automation @ `884bd866` (ff-pulled); CertMateUnified @ `2cfbf38`.

### Tests run + result (final)
Web vitest 2340 passed / 1 skipped · backend Jest 9365 passed / 19 skipped · iOS 2099 executed / 0 failures / 1 skipped · CI green on #201 and on the post-merge run.

### Follow-ups noticed
[FOLLOWUP] ep-policy artifact pins break when a LATER required predecessor rewrites the pinned file — `PLAN-E-TERM-final.md.ep-policy.json` pinned `voiced-activity.ts` / `UplinkScopeTypes.swift` which PLAN-E2 then modified; smallest action: verify the hash AT the recorded `merge_commit` in the /ep skill and have /rp avoid pinning files a sibling plan names. (queued → todos-certmate.md)
[FOLLOWUP] Server-persisted mirror of the unresolved-audio record — CONDITIONAL on field use showing the client-local record insufficient (the plan's own named deferral). (queued → todos-certmate.md)
[FOLLOWUP] E2 web `prepareElevenLabs()` entry-cancel fires `onEnd` on a still-pending disclosure token — TERM guards itself via `hasPlayed`, but E2's accounting still counts it as a natural completion (already an existing vault todo from the E2 run; re-confirmed by Codex E-TERM cycle 1 — no new item).
[FOLLOWUP] Staged-loss sources carry no staging-owner scope — two staging owners' contiguous reports can coalesce into one `stagedLoss` source (Codex E-TERM cycle 1, the half NOT applied; E2 keys by contiguity by design). Smallest action: decide in a future E-WAKE/auto-sleep plan whether `StagedSource` should carry `epochScope`/attempt identity. (queued → todos-certmate.md)
[FOLLOWUP] IDB write durability under a blocked v6 upgrade — `onversionchange` + priming close the realistic window, but a write that fails inside IDB is swallowed, not retried (Codex cycle 1's "retain/retry until commit" half). Smallest action: a bounded retry inside `writeBatch` if field logs ever show `[unresolved-audio] op failed`. (queued → todos-certmate.md)
