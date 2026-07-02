# Visual baseline — 2026-07 (WS0 item 4)

**Status: web COMPLETE (all 14 screens ×2 viewports) — iOS PARTIAL (EICR set complete; 10 EIC screens blocked, see iOS section).** Re-run 2026-07-02 (second session) with the parity test account + two seeded jobs after the original autonomous session was blocked on credentials. This folder is the WS5 spec / WS8 acceptance reference.

## Fixture / account

| Item | Value |
|---|---|
| Account | `parity-test@certmate.uk` (dedicated parity QA account; password held in `~/.certmate-test-creds` on the dev Mac — NOT committed) |
| EICR job | `job_1782978942222` — "1 Test Fixture Lane, Reading, RG1 1AA", 3 circuits, 2 observations (C2 + C3), earthing/bonding + main-fuse fields populated |
| EIC job | `job_1782978943693` — same address fixture, Extent + Design populated |
| Usage discipline | READ-ONLY: no job field edited, no save/generate/delete control touched. The only server-side artifacts are recording sessions from the two `recording-*` captures (`POST /api/recording/start` — session records, not job data; nothing dictated/applied) and login events. |

## Web captures (2026-07-02)

- **Source:** production `https://certmate.uk` (backend `api.certmate.uk`), signed in as the parity test account. Local-dev capture was superseded by the task mandate to baseline production.
- **Tool:** `node web/tests-e2e/visual-baseline-capture.mjs` (committed) — Playwright chromium headless, `colorScheme: 'dark'`, full-page PNG except the dialog/recording shots (viewport).
- **Viewports:** `*-iphone.png` = iPhone 14 device profile at `deviceScaleFactor: 1` (390×844 CSS px — device resolution per compression guidance, not @3x); `*-desktop.png` = 1440×900.
- **Auth mechanics (in the script):** API login → synthesized Playwright storage state (`cm_token`/`cm_user` localStorage + `token` cookie, exactly what `setAuth()` stores). The UI login form could not be used — see delta #1. Device-local gates pre-seeded so they don't obscure captures: T&Cs acceptance (`termsAccepted*` localStorage — device-local only, no backend call), job tour (`cm-tour-job` localStorage), dashboard tour (IDB `certmate-cache/app-settings/tour-state`).
- **Compression:** PNG at device resolution (~8 MB for 51 files — under the 25 MB folder cap; no PNG optimiser available on the capture host, not needed at this size).

| Screens | Files |
|---|---|
| Login | `web/login-{iphone,desktop}.png` |
| Dashboard | `web/dashboard-{iphone,desktop}.png` |
| Job tabs — EICR (overview, installation, supply, board, circuits, observations, inspection, staff, pdf) | `web/job-<tab>-eicr-{iphone,desktop}.png` |
| Job tabs — EIC (overview, installation, supply, board, circuits, extent, design, inspection, staff, pdf) | `web/job-<tab>-eic-{iphone,desktop}.png` |
| Recording (live session UI, connected + LISTENING) | `web/recording-eicr-{iphone,desktop}.png` |
| Settings hub | `web/settings-{iphone,desktop}.png` |
| CCU mode sheet (open, no photo picked) | `web/ccu-mode-sheet-eicr-{iphone,desktop}.png` + `web/ccu-mode-sheet-eicr-iphone-element.png` (dialog-element shot — see delta #2 for why the viewport shot is offset) |
| Observation card (populated, C2+C3) | `web/observation-card-eicr-{iphone,desktop}.png` |

- PDF tab captured in its amber "Not yet generated" state (Generate is a mutating server call — not clicked).

## Visual deltas observed during capture (RECORDED ONLY — WS5 owns any fix; computed-styles measured per `rules/mistakes.md`)

1. **Web login broken for company-less users.** `POST /api/auth/login` returns `company_id: null` for the parity account; `LoginResponseSchema` (`web/src/lib/adapters/auth.ts`) declares `company_id: z.string().optional()` — not `.nullable()` — and login uses `strict: true`, so the form fails with "Response shape invalid" for any user not bound to a company. iOS logs in fine (iOS is canon; the wire value is legitimately null per the schema's own comment). Frontend-only fix (`.nullable()`); NOT a backend change.
2. **All styled dialogs render double-offset from center.** Measured on the live DOM (CCU mode sheet, iPhone 14 viewport): computed `translate: -50% -50%` (Tailwind v4 standalone property from `-translate-x-1/2 -translate-y-1/2`) AND `transform: matrix(1,0,0,1,-179,-286.75)` (from `.cm-dialog-content[data-state='open'] { transform: translate(-50%,-50%) scale(1) }` in `globals.css`) BOTH apply → the shift is doubled and the dialog top-left corner lands off-viewport (rect x=-147, y=-241.5 on a 390×664 viewport; also visibly off-center at 1440×900). Affects every `DialogContent` consumer (CCU mode sheet + settings modals). The `ccu-mode-sheet-eicr-iphone.png` capture shows the bug as production users see it; the `-element.png` companion shows the sheet content itself.

## iOS captures (2026-07-02)

- **Build:** `xcodegen generate` (project was stale — picked up `tour_step_11.mp3`; pbxproj change PR'd separately in CertMateUnified #31, Info.plist build-number churn reverted) then `xcodebuild -scheme CertMateUnified -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/certmate-dd`. Simulator: iPhone 17 Pro, iOS 26.2.
- **Driver:** the host GUI session was locked (autonomous run), so window-level automation was impossible; screens were driven by a TEMPORARY XCUITest target (`BaselineUITests`, run via `xcodebuild test`, headless through testmanagerd) that logged in, walked the tab chips, opened the CCU sheet (Cancel'd), started one recording (screenshot, then app kill — no End/Apply), and attached named screenshots. The target + test file were REVERTED after capture; nothing test-related is committed.
- **Account state pre-seeded device-locally** (no server writes): T&Cs (`termsAccepted*` UserDefaults), tour off (`appTourEnabled=false`), mic permission (`simctl privacy grant microphone`). The springboard "Save Password?" sheet is dismissed by the driver.
- **Compression:** `sips` JPEG q80 at native 3x resolution (1206×2622) — ~2.9 MB for 15 files; folder total ~11 MB, under the 25 MB cap.

| Screens | Files |
|---|---|
| Login | `ios/login.jpg` |
| Dashboard (hero + Setup & Tools; job list below fold) | `ios/dashboard.jpg` + `ios/dashboard-jobs.jpg` |
| Job tabs — EICR ×9 | `ios/job-<tab>-eicr.jpg` |
| CCU mode sheet (open, Cancel'd) | `ios/ccu-mode-sheet-eicr.jpg` |
| Recording (live, Connected/Listening) | `ios/recording-eicr.jpg` |
| Settings hub | `ios/settings.jpg` |
| Observation card (populated, WITH canonical BS 7671 wording — 411.3.4 title/description/rationale rendered) | on `ios/job-observations-eicr.jpg` |

### iOS BLOCKED — EIC job screens (10)

`job-{overview,installation,supply,board,circuits,extent,design,inspection,staff,pdf}-eic` could not be captured: **the EIC job never appears in the iOS job list.** Root cause (verified in source + API): `/api/jobs/:userId` returns both seeded jobs, but iOS `JobListViewModel.deduplicateApiJobs` collapses jobs **by address** and keeps the first — the two fixtures share "1 Test Fixture Lane", so the EIC job is silently dropped before caching. This is an iOS product bug for legitimate same-address EICR+EIC pairs (a common real-world scenario) — log-don't-replicate class (parent §3E). Re-run options: reseed the EIC job at a distinct address and re-run the driver (`testCaptureBaseline` walks whichever cert types it finds), or fix the iOS dedupe first.

**WS5 deferred-review note (2026-07-02, user-confirmed):** WS5's design-system acceptance ran EICR screens against their iOS baselines; the EIC screens were reviewed web-before/after only, using the iOS EICR tab captures as canon PROXY for shared styling. The EIC-vs-iOS screen-by-screen review is DEFERRED until the 10 iOS EIC captures above land. (Note the EIC fixture has since been reseeded at "7 Fixture Court, Reading, RG2 2BB", so the address-dedupe blocker no longer applies to a re-run.)

### Cross-platform deltas noticed during capture (RECORDED only)

- iOS CCU mode sheet has SIX modes (incl. **Add Off-Peak Board**); web has five — matches the existing WS6 off-peak ledger gap, now with baseline evidence.
- iOS observation card renders canonical BS 7671 wording (411.3.4 shown); the web card shows only the classification chip + "from schedule item" link — the known obs-card canonical-wording plumbing gap (WS3), now with baseline evidence.
- iOS dashboard hero reports "1 ACTIVE" / Recent Jobs (1) vs web's 2 — same address-dedupe root cause as the EIC blocker above.

Blocker history in `web/audit/INDEX-2026-07.md` → "WS0 execution blockers" (updated by this session: web complete, iOS EIC-only remainder).
