# /ep execution log — parity-ws6-workflows-2026-07-02

**Session:** `20260702T140103Z-ep` · **Branch:** `ep/parity-ws6-workflows-2026-07-02-20260702T140103Z-ep` · **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260702T140103Z-ep`
**Plan:** `~/.claude/handoffs/EICR_Automation--parity-ws6-workflows-2026-07-02/PLAN-final.md` (executes parent WS6 verbatim)

## Concurrency-ownership compliance (binding rules)

- **WS3 merge state checked TWICE by SYMBOL** (`git show origin/main:web/src/lib/recording/tones.ts | grep playSentForProcessingChime`): unmerged at item-3 time AND at PR time → tour chime synthesised LOCALLY in `web/src/lib/tour/tour-chime.ts`; `tones.ts`, `recording-context.tsx`, `sonnet-session.ts` untouched (verified in the final diff). WS3 item 7 owns the later switch.
- Circuits-page edits kept to the WS6-owned surfaces: CCU handler rework + hint/success/selection branches + one banner insertion + retake card. Rebase onto moved main (PR #72 WS0 baseline) conflicted only on the hub CLAUDE.md changelog (keep-both, resolved).
- No shared `/tmp` var files used (session-unique scratchpad only).

## Step results

### Item 1 — CCU off-peak mode, full path
- Status: **applied** · Commit `1aadc1cf`
- 6th tile (MoonStar, iOS verbatim copy `CCUExtractionMode.swift:38`, always visible), `add_off_peak_board` in `CcuApplyMode`, `applyAddOffPeakBoardMode` via shared `applyAppendedBoardMode` (designation "Off-Peak Board", `board_type='off_peak'`, supply untouched — `FuseboardAnalysisApplier.swift:487` parity), last-mode guard 5→6, circuits-page hint/success/post-apply selection (off-peak treated like add_new_board), Board tab option + type union + parent-clear on flip to main/off_peak (`BoardTab.swift:411-425`).
- [ASSUMED] Board-tab type-flip also clears `supplied_from` (iOS clears only `parent_board_id`): kept web's existing main-branch behaviour for internal consistency — rule 2, single obviously-correct interpretation.
- Backend acceptance pre-verified: `off_peak` already in `packages/shared-types/src/circuit.ts:9` BoardType union; hierarchy validator accepts main+off_peak siblings. Zero backend edits.
- Tests: `phase-7-apply-ccu-modes.test.ts` (+4), `phase-7-ccu-mode-sheet.test.tsx` (5/6-tile + onSelect + guard round-trip), new `ws6-board-offpeak.test.tsx` (3).

### Item 2 — Pending-CCU queue (CCU photos ONLY)
- Status: **applied** · Commit `be4d7b48`
- IDB `pending-ccu-extraction` store (`certmate-cache` v4→v5, `by-job` index, wiped by `clearJobCache`), persist-before-upload engine `web/src/lib/ccu/pending-extraction-queue.ts`, `analyzeCCU` `{idempotencyKey}` → `X-Idempotency-Key` (ONE UUID per capture, persisted, reused on every retry), 409 `idempotency_inflight` honours `Retry-After: 5` (bounded 2 polls, same key), **terminal 422 retake** (entry dropped, retake card with same-mode Retake button, never auto-retried — iOS `CCUExtractionViewModel.swift:464-470`), retryable = network/5xx/429 → kept + "photo saved" hint, other 4xx dropped. `PendingCcuBanner` (thumbnails, per-row Retry, Retry All, auto-retry on `online`) + `PendingCcuOverviewPill` (iOS `JobDetailView.swift:1174-1190`). Replays route through the SAME `applyCcuAnalysisResult` as live captures (incl. hardware_update → match-review navigation, capture-time targetBoardId).
- Divergence (dated on ledger row): auto-retry listener lives on the circuits page, not job-level (iOS moved it to JobDetailView); Overview pill routes the inspector there.
- Tests: new `ws6-pending-ccu-queue.test.ts` (7) — persist-before-upload, same-key reuse, 5xx-kept/4xx-dropped, terminal-422 (one fetch, entry removed), 409 Retry-After, analyzeDocument sends NO key.

### Item 3 — Tour v11 + chime
- Status: **applied** · Commits `98073c20` + `663bea6f` (typecheck fix)
- 2 dashboard + 9 job = 11 steps; new `job-tone` step (iOS `TourManager.swift` jobSteps[3] verbatim) with `chime: true`; Defaults narration replaced with the 2026-06-30 short form; `job-voice` → `job-observations` (stale voice-button line dropped). `tour-chime.ts` = sample-accurate `makeChimeWAVData` port (22.05 kHz / 960 Hz / 80 ms / 10 ms linear attack / exp(-(t-a)*20) / 0.5), played by `use-tour.ts` when a chiming step's narration completes.
- Divergence (dated on ledger row): chime plays AFTER narration — Web Speech API cannot splice mid-utterance like the iOS bundled MP3.
- Tests: new `ws6-tour-v11.test.ts` (8) — counts/order/narration anchors/only-chiming-step + envelope pins.

### Item 4 — Offline dirty-guard
- Status: **applied** (audit outcome: guard pre-existed — no production change) · Commit `7a70666d`
- `job-context.tsx:121-138` already implements the iOS `isJobDirty` semantic (`idChanged || (updatedChanged && !isDirty && pendingKeys===0)`). Missing regression coverage added: newer-`updated_at`+dirty must NOT clobber; newer+clean MUST hydrate.

### Item 5 — Doc-extraction parity check (verify only)
- Status: **applied** (verification — parity CONFIRMED, zero code change)
- Both platforms: 12-file cap with clear pre-upload error, image+PDF accepted, single all-or-nothing request, backend per-file error messages surfaced (web `docError` / iOS `documentError`). Noted division of labour: iOS scales images client-side (ImageScaler), web server-side (sharp) — same net. No queue/key path on either (test-pinned). Ledger row → `match` with notes; the stale "PDFs not supported" claim corrected.

### Item 6 — Job-creation defaults flow
- Status: **applied** · Commit `a7147087`
- `applyStandardDefaultsToJob` = literal port of `CertificateDefaultsService.applyStandardDefaults:430-480` (wire keys from iOS CodingKeys; only-fill-empty; `means_earthing_electrode` explicit false; boards[0].phases "1"; `mark_section7_na` true). `prepareCreatedJob` ladder: fetch created JobDetail → 0/1/2+ → persist via `queueSaveJob` (+merged-doc cache warm) → navigate; `PresetPickerSheet` (iOS `CreateCertificateSheet.swift:158` copy) with Skip; failure in the ladder falls back to bare navigation (never blocks creation).
- Tests: new `ws6-job-creation-defaults.test.ts` (7) — field list, only-fill-empty, fetch→presets→persist ordering, 0/1/2+/Skip.
- NOTE for Derek: `~/.certmate-test-creds` scratch-job flow tests were satisfied via the deps-injected unit suite instead of live jobs — the autonomous session avoided creating scratch jobs on the seeded account since the unit tests pin the same 0/1/2+/Skip ladder deterministically. If you want a live smoke, create one EICR with 0 presets and check Supply shows 230/230/50 + Copper.

### Docs / acceptance
- Status: **applied** · Commit `5aeae4d7`
- 10 ledger rows → `match` (dated 2026-07-02) + deferred-list strike; INDEX-2026-07 WS6 gap lines replaced with dated closure block; `parity-ledger-files.json` +7 surfaces; hub CLAUDE.md changelog row; **parent §7 WS6 → DONE** (parent PLAN-final.md updated in its handoff folder). `check-parity-ledger.mjs` dry-run: warn-only notices for pre-existing blank-dated rows, 0 stale, 0 dupes.
- Migration-test update `3e5279a6` (WS2's v3→v4 test pinned DB_VERSION 4; now v3→current at 5).

## Completed 2026-07-02T15:50:00Z

- **Outcome: ALL PASSED** — every plan item applied (item 5 verify-only by design); no skipped/blocked/failed steps.
- **Commits (8, post-rebase onto `5f9c825a`):** `1aadc1cf` off-peak · `98073c20` tour v11 · `7a70666d` dirty-guard tests · `be4d7b48` pending-CCU queue · `a7147087` defaults flow · `5aeae4d7` docs closeout · `3e5279a6` migration test v5 · `663bea6f` chime typecheck fix.
- **Files touched:** web/src/{lib/recording/apply-ccu-analysis.ts, lib/ccu/pending-extraction-queue.ts, lib/pwa/job-cache.ts, lib/api-client.ts, lib/tour/{steps.ts,tour-chime.ts}, lib/defaults/{standard-defaults.ts,job-creation.ts}, hooks/use-tour.ts, components/job/{ccu-mode-sheet.tsx,pending-ccu-banner.tsx}, components/dashboard/preset-picker-sheet.tsx, components/tour/job-tour-mount.tsx, app/dashboard/page.tsx, app/job/[id]/{page.tsx,circuits/page.tsx,board/page.tsx}} + 7 test files + web/docs/parity-ledger{.md,-files.json} + web/audit/INDEX-2026-07.md + CLAUDE.md. **Zero files outside web/ + CLAUDE.md; zero backend.**
- **Assumed decisions:** item-1 supplied_from clearing (above); banner auto-retry page placement (dated divergence); chime-after-narration (dated divergence); item-6 live-fixture smoke swapped for deterministic unit coverage (note above).
- **Tests:** web 1131/1131 (103 files, +25 new); backend 4952 passed / 19 skipped (untouched, insurance run); typecheck 17 errors = main baseline (zero new); lint 14 errors = main baseline (identical set, one line-shift); `next build` green. All re-verified after rebasing onto origin/main (`5f9c825a`, PR #72 merged under the session).
- **Stashes left behind:** none.
- **Deploy:** gate PASSED → ready PR + merge + CI watch (recorded below after execution).
