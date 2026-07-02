# /ep execution log — parity-ws5-design-system-2026-07-02 (PLAN-final.md)

- Session: 20260702T155747Z-ep
- Branch: ep/parity-ws5-design-system-2026-07-02-20260702T155747Z-ep
- Worktree: /Users/derekbeckley/Developer/EICR_Automation-ep-20260702T155747Z-ep
- Base: main @ 1375dcb8 (pulled origin/main 2026-07-02T15:58Z; 51 baseline PNGs verified in web/audit/visual-baseline-2026-07/web/)

## Step 1 — Survey CMDesign + web tokens + live call sites
- Status: applied
- Decision: rule 1 (verbatim). Read CertMateDesign.swift (1285 lines), globals.css, design-tokens.ts; call-site greps run per plan bullet 2.
- Key findings (drive later steps):
  - Live iOS token winners by call-site count: `Spacing.cardPadding=20` (22 uses) over `Dimensions.cardPadding=16` (1 use — but that ONE use is CMSectionCard's content padding, so section cards pad 16 while cmCardStyle cards pad 20); `CornerRadius.card=18` (59) for generic cards; `cardRedesign=16` (11, incl. CMSectionCard × 40 call sites); `inputRedesign=12` on the live floating-field components (CMFloatingTextField/CMUnitTextField/CMFloatingPicker, 102 combined call sites) vs `CornerRadius.input=10` on `cmTextFieldStyle` (12 call sites); `Spacing.sectionGap=28` (23) over `Dimensions.sectionGap=24` (0).
  - `cmFormLabel()` (UPPERCASE 13-semibold) has ZERO live call sites; `Typography.formLabel` appears only in LoginView + one CertMateComponents site. The live iOS field-label pattern is CMFloatingTextField's floated label: 12px medium, sentence case, TextColors.secondary, Green.vibrant when focused. Field spec: bg Elevation.L2, border 1.5pt L3 default / Green.vibrant focused + 12px green glow, radius 12, minHeight 52.
  - `Typography.dataValue`/`monoData` live usage: LiveFillView value rows + CMSectionCard preview — web `live-field.tsx` already has the mono path.
  - Web named spacing utilities (`p-md` etc.): ZERO call sites — --spacing-* value changes are inert; keys+values kept per resolved decision.
  - Web surface-0..3 ALREADY match the iOS elevation ladder exactly; text/status/soft-brand colors diverge (web used Apple-system/Tailwind approximations).
  - iOS tab rail (JobDetailView:266-309): active = blue icon + white bold label; inactive white@0.35/0.45; underline 3px, `Gradients.tabIndicator` (blue→green), radius 1.5, blue glow shadow, slides (matchedGeometryEffect + tabSlide spring).
  - CMSectionCard recipe (CMSectionCard.swift:48-108): bg L1 + Blue.subtle (8%), inset 3pt accent gradient bar (accent→40%, py 8 pl 4), gradient border accent 20%→8%, radius 16, padding 16. Web SectionCard diverges: bg L2, solid full-height stripe, solid border, radius 14.
  - BUG found in recording-chrome.tsx photo-chooser dialog: references UNDEFINED CSS vars (`--color-border`, `--color-surface-elevated`, `--color-surface-hover`) — will fix in the recipes step (WS5-owned file, styling only).
- Files: none changed
- Commit: none
## Step 2 — Token reconciliation (map + globals.css + design-tokens.ts)
- Status: applied
- Decision: rule 1. Keys kept (user decision), values moved to CMDesign; iOS component radii added as NEW semantic tokens (--radius-input/button/card/section-card/hero/cta-pill) rather than mutating the 258-call-site generic scale; live-call-site winners chosen for every CMDesign duplicate, recorded in the table's notes column. Spacing values ALSO unchanged (zero named-utility call sites → change buys nothing); Spacing.sectionGap=28 retrofit skipped as a layout change beyond token reconciliation — noted on the ledger row.
- Files: web/audit/cmdesign-token-map-2026-07.md (new), web/src/app/globals.css, web/src/lib/design-tokens.ts
- Commit: 1b0ecd69
- Notes: rec-*/severity-* tokens deliberately stay on Apple dark system values (iOS uses bare Color.red/.green/.orange). design-tokens.ts has zero consumers/tests — safe.

## Step 3+4 — Dialog double-offset fix + terms cleanup + Playwright regression
- Status: applied
- Decision: rule 1, measure-first honoured: spec written FIRST and run against the unfixed tree — measured 288px vertical offset on the /terms legal-doc dialog (live DOM, chromium). Fix: .cm-dialog-content animation moved from `transform: translate(-50%,-50%) scale()` onto the standalone `scale` property so the Tailwind v4 `translate` utilities are the single translation source; terms/page.tsx duplicated positioning classes removed in the SAME commit (grep re-run post-pull: still the only styled consumer duplicating translate; job-header.tsx:84 is a standalone non-dialog use — untouched).
- Regression: web/tests-e2e/dialog-centering.spec.ts (terms dialog = styled consumer exercising the consumer cleanup; geometry + translate/transform mechanism asserts). Pre-fix FAIL (288px), post-fix PASS chromium+webkit (webkit browser had to be `playwright install`ed in this environment).
- Evidence: before/after screenshots at scratchpad dialog-evidence/dialog-{before,after}-fix.png (copied to handoff folder at completion).
- Files: web/src/app/globals.css, web/src/app/terms/page.tsx, web/tests-e2e/dialog-centering.spec.ts
- Commit: 6e384feb
## Step 5 — Component recipes (glass card / conduit / hero shimmer / tab underline / rec ring / springs)
- Status: applied
- Decision: rule 1. All surfaces extended IN PLACE (.cm-card rewritten — zero pre-existing consumers; SectionCard/HeroHeader/JobTabNav restyled; recording ring already ported, untouched). Gradient borders via the padding-box/border-box background technique (no wrapper DOM). Tab underline = measured single indicator (offsetLeft/offsetWidth + ResizeObserver) transitioning left/width with --ease-spring; iOS matchedGeometryEffect equivalent. tests/section-card.test.tsx re-locked to the new contract (old test promised the pre-WS5 "byte-identical" surface — deliberately superseded; jsdom hex/rgb serialisation quirk handled with an either-form matcher).
- Bug fixed en route: recording-chrome photo-chooser tiles referenced UNDEFINED CSS vars (--color-border/--color-surface-elevated/--color-surface-hover) → mapped to real tokens (border-default, surface-3/4).
- Files: globals.css, ui/card.tsx, ui/section-card.tsx, ui/hero-header.tsx, job/job-tab-nav.tsx, recording/recording-chrome.tsx, tests/section-card.test.tsx
- Commits: 32835c48, 705b57a0, d97de5ac
## Step 6 — Section accents consolidated onto iOS category map
- Status: applied
- Decision: rule 1. Shared EICR_INSPECTION_SECTION_CATEGORIES added to section-accents.ts (canon InspectionTab.swift:362-374, per-index [schedule, electrical, protection, board, test-results, notes, notes, client], modulo-consumed, 8th entry = .client); inspection page's local colour list deleted; magenta remap cited in the commit message. Typecheck diffed against main: IDENTICAL baseline (33 pre-existing lines, all tests/job-row-swipe-delete.test.tsx).
- Files: web/src/lib/constants/section-accents.ts, web/src/app/job/[id]/inspection/page.tsx
- Commit: 6b5ff501

## Step 7 — Shared field controls → iOS floating-field spec
- Status: applied (one [ASSUMED] within it)
- Decision: rule 1 for the chrome (L2 bg / 1.5px L3 border / green focus + 12px glow / radius 12 / height 52 / 17px value — straight from CMFloatingTextField.swift). [ASSUMED] rule 2 for the LABEL: plan's "UPPERCASE 13-semibold form labels" names Typography.formLabel/cmFormLabel, which have ZERO live call sites on iOS job forms — per the plan's own "map from tokens live views actually reference" instruction the labels follow the floating label's floated state instead (12px medium sentence-case, secondary → green focused). Skip recorded in the token map's typography section. Mono data values NOT applied to text inputs (iOS uses bodyRegular there; mono lives in LiveFill/grid rows, already mirrored on web).
- Side benefit: 17px value text clears iOS Safari's <16px zoom-on-focus trigger (old 15px inputs zoomed the viewport on every tap).
- Files: ui/floating-label-input.tsx, ui/labelled-select.tsx, ui/multiline-field.tsx, ui/select-chips.tsx
- Commit: a35f1cba
## Step 8 — Visual verification (before/after + measured spot-checks) — INCIDENT + RECOVERY
- Status: applied (with one production-data incident, fully remediated in-session)
- **INCIDENT:** the first local after-capture sweep WIPED the seeded parity EICR job (`job_eicr` in ~/.certmate-test-creds) at 2026-07-02T16:37:41Z. Chain: the job-detail GET failed once (transient, local shim/cold-compile) → the page painted a blank/summary doc → the installation+supply pages' AUTO-SEED DEFAULTERS (`ensureDateOfInspection` + next_inspection_years=5 at installation/page.tsx:167-185; supply N/A coercions) marked the blank doc dirty → debounced queueSaveJob PUT wrote the blank form state to production. The EIC job's GET succeeded so its save round-tripped intact (updated_at bumped 16:38:16Z, data unchanged).
- **RECOVERY:** EICR fixture restored 16:47:16Z via one PUT built from the twin EIC fixture (MANIFEST documents them as the same seed) + EICR-specific overrides read from the committed baseline PNGs (client/address/dates). Verified field-by-field post-restore: client, addresses, dates (prev 2021-06-01, next 2031-07-02), supply (freq 50 / PFC 1.2 / earthing 16-PASS / bonding 10), Wylex board, 3 circuits (Downstairs Sockets / Upstairs Lighting / Cooker), 2 observations (C2 5.9 + C3 5.12.4), schedule outcomes. Residual deltas vs pre-incident: fresh UUIDs on the 2 observations + 1 board; some empty-string keys from the blank write remain merged into the blobs (render-neutral). EIC job untouched apart from the bumped updated_at.
- **PREVENTION (committed):** hard read-only guard in visual-baseline-capture.mjs — local-capture mode fulfills every non-GET/HEAD/OPTIONS API request with a 503 at the route layer. Re-ran the full sweep under the guard: production updated_at values frozen; 48 valid after-captures produced.
- **FOUND PRODUCT BUG (not fixed here — out of WS5 scope):** auto-seed-defaulters + debounced save on an unhydrated job doc = REMOTE DATA LOSS for any user whose job-detail GET fails once (offline blip, 5xx, parse failure) while a cached summary paints. Recorded in INDEX-2026-07 bugs list with owner = next parity session; morning attention recommended (this is a P1-class field-data risk, iOS unaffected — iOS seeds only after `load()` succeeds).
- Verification results: computed-style spot-checks ALL PASS (brand/soft/status/text/transcript colors, radius input 12/card 18/section 16/hero 22, h-input 52, h-tabbar 49, body #fff on #0a0a0f, max-w-3xl = 768px override INTACT); real production data confirmed rendering before trusting diffs; screen review vs committed baseline on installation/overview/inspection/CCU-sheet/PDF/dashboard/settings/login — changes are the intended WS5 deltas (glass cards, conduit gradients, tab underline, field chrome, sentence-case labels); WS6 CCU sheet + WS9 PDF pages inherit tokens cleanly; dialog centred (before/after PNGs archived).
- Files: web/tests-e2e/visual-baseline-capture.mjs (extensions + guard); committed baseline folder NOT modified (captures went to scratch via OUT_DIR)
- Commit: bac6d479
- Evidence: after-captures/ (key screens) + after-captures-full/ (48 shots) + dialog-before/after PNGs in this handoff folder
## Step 9 — Gates
- Status: applied
- vitest: 103 files / 1131 tests PASS. typecheck: identical to main baseline (33 pre-existing lines, all in untouched tests/job-row-swipe-delete.test.tsx). lint: identical to main baseline (12 pre-existing errors / 16 warnings, whitespace-normalised diff empty). build: green. Playwright: dialog-centering green chromium+webkit + smoke green; 3 failures (record.spec ×2, record-tts-elevenlabs ×1) verified PRE-EXISTING — each reproduced identically on main (likely the WS6 tour overlay intercepting the Start-recording click; not WS5's).
- Commit: none (verification only)

## Step 10 — Ledger + INDEX + MANIFEST + changelogs
- Status: applied
- Ledger: cmdesign-token-deltas → match (dated sectionGap divergence note); ios-signature-styling → match (dated formLabel-skip divergence); tab-rail-form → partial (rail CLOSED, dated swipe-paging accepted difference per plan); section-accents-dup → match. INDEX-2026-07: WS5 gaps → CLOSED summary; dialog bug marked FIXED; NEW P1 data-loss bug recorded with owner; EIC deferred-review note added (mirrored in MANIFEST, user-confirmed wording). Hub CLAUDE.md row + docs/reference/changelog.md long-form entry (sanctioned docs exception to web-only scope).
- Files: web/docs/parity-ledger.md, web/audit/INDEX-2026-07.md, web/audit/visual-baseline-2026-07/MANIFEST.md, CLAUDE.md, docs/reference/changelog.md
- Commit: 01a515e6
## Completed 2026-07-02T20:08:00Z

**Outcome: ALL PASSED** — every plan step applied (one documented [ASSUMED] decision inside step 7; zero skipped / blocked / failed). One production-data incident occurred mid-run and was fully remediated + hardened against in the same session (step 8).

### Commits made (9, on ep/parity-ws5-design-system-2026-07-02-20260702T155747Z-ep off main@1375dcb8)
- 1b0ecd69 feat(pwa): WS5 token reconciliation — regenerate web tokens from iOS CMDesign
- 6e384feb fix(pwa): dialog double-offset — single translation source + centering regression
- 32835c48 feat(pwa): WS5 component recipes — glass card, section conduit, hero shimmer, spring easings
- 705b57a0 feat(pwa): WS5 tab rail — iOS colours + sliding gradient underline
- d97de5ac fix(pwa): photo-chooser tiles referenced undefined CSS vars; tab-nav docblock refresh
- 6b5ff501 feat(pwa): WS5 — inspection section accents consolidated onto the iOS category map
- a35f1cba feat(pwa): WS5 — shared field controls restyled to the iOS floating-field spec
- bac6d479 feat(tests-e2e): local-recapture support + HARD read-only guard for visual-baseline capture
- 01a515e6 docs(parity): WS5 closeout — ledger flips, INDEX, changelogs, deferred-review note, data-loss bug logged
(+ the execution-log mirror commit after this block)

### Files touched
web/src/app/globals.css; web/src/lib/design-tokens.ts; web/audit/cmdesign-token-map-2026-07.md (new); web/src/components/ui/{card,section-card,hero-header,dialog,floating-label-input,labelled-select,multiline-field,select-chips}.tsx; web/src/components/job/job-tab-nav.tsx; web/src/components/recording/recording-chrome.tsx; web/src/app/terms/page.tsx; web/src/app/job/[id]/inspection/page.tsx; web/src/lib/constants/section-accents.ts; web/tests-e2e/dialog-centering.spec.ts (new); web/tests-e2e/visual-baseline-capture.mjs; web/tests/section-card.test.tsx; web/docs/parity-ledger.md; web/audit/INDEX-2026-07.md; web/audit/visual-baseline-2026-07/MANIFEST.md; CLAUDE.md; docs/reference/changelog.md. ZERO backend files.

### Assumed decisions (sanity-check these)
- [ASSUMED] Step 7 field-control LABELS: plan text said "UPPERCASE 13-semibold form labels" (CMDesign.Typography.formLabel/cmFormLabel), but that recipe has ZERO live call sites on iOS job forms — per the plan's own "map from tokens live views actually reference" rule, web labels match CMFloatingTextField's floated state (12px medium, sentence case, secondary → green focused). Recorded in the token map + ledger divergence note.
- [ASSUMED] `Spacing.sectionGap=28` page-stack retrofit skipped (token-scope judgement); dated divergence on the cmdesign-token-deltas ledger row.
- [ASSUMED] Production fixture restore (step 8): restoring the wiped parity EICR job autonomously was judged corrective (damage caused by this run, QA fixture account, values documented in MANIFEST + committed baseline PNGs) rather than a user-consent destructive action. Fresh UUIDs on 2 observations + 1 board are the only identity deltas.

### ⚠️ Morning attention items
1. **Production incident (remediated):** the seeded parity EICR job (job_1782978942222) was briefly wiped at 16:37:41Z by the first local visual-capture sweep and restored at 16:47:16Z — details in step 8. EIC job untouched (updated_at bumped only).
2. **OPEN P1 product bug found:** installation/supply auto-seed defaulters + debounced save can write a BLANK doc over a job whenever the detail GET fails once while a cached/summary doc paints (remote data loss; iOS not affected). Recorded in web/audit/INDEX-2026-07.md with owner "next parity session" — recommend prioritising.
3. 3 Playwright failures in record.spec/record-tts-elevenlabs are PRE-EXISTING on main (each reproduced on the main checkout; likely the WS6 tour overlay intercepting clicks) — not from this wave, may want a follow-up.

### Skipped / blocked / failed steps
None.

### Stashes left behind
None.

### Tests run + result
Web vitest 1131/1131 PASS (103 files); typecheck + lint byte-identical to main baseline; `next build` green; Playwright: new dialog-centering spec PASS on chromium+webkit, smoke PASS, 3 pre-existing main-baseline failures (verified on main). Computed-style spot-checks all PASS incl. max-w-3xl=768px override survival. 48-screen after-capture sweep verified against the committed baseline with real production fixture data.
