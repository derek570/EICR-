# iOS ↔ PWA Parity Ledger

Single source of truth for the iOS CertMateUnified → web (certmate.uk) gap
audit. Each row maps one iOS surface (field / button / section / sheet / flow)
to its current PWA counterpart.

Status legend:

- `match` — behaviourally + visually equivalent
- `partial` — some fields / behaviour present, others missing
- `missing` — no PWA counterpart
- `ios-only` — intentionally iOS-only (native camera overlay, WKWebView PDF, Core Data, PhotosPicker, `fullScreenCover`, ShareLink, etc.)
- `backend` — **RETIRED 2026-07-02** for parity-program work (Derek 2026-07-01: zero backend changes). No active row may carry it. Anything that appears to need backend/schema/prompt/shared-type work must be rewritten as a dated deliberate-divergence / blocked-by-zero-backend note with an owner, or re-scoped to a frontend-only gap.

Row columns (added in the 2026-07-02 WS0 sweep):

- `id` — stable slug identifying the row. NEVER renumber, NEVER reuse. New rows get a fresh id. `web/docs/parity-ledger-files.json` maps web file paths → row ids for the CI staleness warning (`scripts/check-parity-ledger.mjs`).
- `last-verified` — ISO date the row was last re-verified against CURRENT iOS + web source. Blank = not re-verified since the column was added (blank counts as stale for the CI warning). Only set it when you actually re-checked the row — never fabricate.

Target phases: **2** (PDF) · **3** (Dashboard + Alerts + Tour) · **4**
(Static job-tab parity) · **5** (Circuits core actions) · **6** (Settings
completion) · **7** (CCU modes + match review) · **8** (Recording
polish) · **9** (Cross-cutting polish).

iOS paths are relative to the `CertMateUnified/` repo (sibling to the web
monorepo — not tracked inside it). Web paths are relative to the
`EICR_Automation` monorepo root.

---

## Dashboard & Alerts

Landing screen (dashboard) + global alerts bell + alerts page + guided tour.

iOS sources:

- `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift`
- `CertMateUnified/Sources/Views/Dashboard/JobRowView.swift`
- `CertMateUnified/Sources/Views/Dashboard/DefaultsModal.swift`
- `CertMateUnified/Sources/Views/Dashboard/InspectorModal.swift`
- `CertMateUnified/Sources/Views/Alerts/AlertsView.swift`
- `CertMateUnified/Sources/Views/Tour/TourOverlayView.swift`
- `CertMateUnified/Sources/Views/Create/CreateCertificateSheet.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| dashboard/dashboardview-419 | `Views/Dashboard/DashboardView.swift:L419-L508` (hero gradient + metric boxes + shimmer + breathing) | `web/src/app/dashboard/page.tsx:L278-L318` (HeroCard + HeroStat + AnimatedCounter) | match |  |  | Both render ACTIVE/DONE/EXP inline on a blue→green gradient; web uses `AnimatedCounter`. |
| dashboard/dashboardview-384 | `DashboardView.swift:L384-L387` expiringJobCount derived from `lastModified < 4 years` | `dashboard/page.tsx` stats memo | match |  | 3 | Phase 3: mirrors iOS placeholder — done + `updated_at` < 4y ago. Backend does NOT ship `next_inspection_due` on the Job list; under the 2026-07-01 zero-backend rule the client-side derivation IS the accepted approach (deliberate divergence, dated 2026-07-02) — do NOT plan a backend flag. |
| dashboard/dashboardview-512 | `DashboardView.swift:L512-L548` (search bar — localizedCaseInsensitiveContains on `address`) | `dashboard/page.tsx:L192-L205` (`<input type="search">` filter) | match |  |  |  |
| dashboard/dashboardview-552 | `DashboardView.swift:L552-L580` Start EICR + Start EIC gradient action cards (blue / green) | `dashboard/page.tsx:L173-L189` (StartTile) | match |  |  |  |
| dashboard/dashboardview-708 | `DashboardView.swift:L708-L724` `createAndNavigate` with auto-apply-defaults + preset picker sheet | `dashboard/page.tsx` createJob → `prepareCreatedJob` ladder (see `dashboard/job-creation-defaults-flow`) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 6) — see `dashboard/job-creation-defaults-flow` for the full contract. |
| dashboard/dashboardview-89 | `DashboardView.swift:L89-L114` skeleton job-row shimmer while loading | `dashboard/page.tsx:L225-L233` cm-shimmer placeholder rows | match |  |  |  |
| dashboard/dashboardview-115 | `DashboardView.swift:L115-L132` empty-state icon + "Start a new EICR or EIC above" | `dashboard/page.tsx:L234-L239` equivalent empty message | match |  |  |  |
| dashboard/dashboardview-133 | `DashboardView.swift:L133-L165` JobRow NavigationLink with swipe-to-delete (trailing) | `web/src/components/dashboard/job-row.tsx` | match |  | 3 | Phase 3: pointer-driven swipe-left reveals trailing Delete on touch/pen; right-click opens a custom context-menu on desktop. Both go through Phase 1 `ConfirmDialog`; `onDeleted` drops the row from the dashboard list on success. |
| dashboard/dashboardview-584 | `DashboardView.swift:L584-L672` "Setup & Tools" grid (Defaults, Company, Staff, Settings, Tour, Log Out) | `dashboard/page.tsx` Setup & Tools grid | match |  | 3 | Phase 3: Tour tile added (toggles "Start tour" ↔ "Stop tour"). Defaults tile hidden until Phase 6 (per Phase 3 brief decision). |
| dashboard/dashboardview-593 | `DashboardView.swift:L593-L595` Defaults tile → DefaultsManagerView sheet | Reached via Settings → Certificate Defaults → `/settings/defaults` | match |  | 6 | Phase 6: defaults hub lives at `/settings/defaults` with Default Values + Cable Size Defaults sub-routes. Dashboard Setup & Tools does NOT expose a separate Defaults tile — the Settings hub is the single entry point (avoids duplicating nav surface). |
| dashboard/dashboardview-596 | `DashboardView.swift:L596-L598` Company tile → CompanyDetailsView sheet | `settings/company/page.tsx` | match |  |  |  |
| dashboard/dashboardview-602 | `DashboardView.swift:L602-L604` Staff tile → InspectorListView sheet | `settings/staff/page.tsx` | match |  |  |  |
| dashboard/dashboardview-605 | `DashboardView.swift:L605-L607` Settings tile → SettingsView sheet | `settings/page.tsx` | match |  |  |  |
| dashboard/dashboardview-611 | `DashboardView.swift:L611-L641` Tour toggle (ON/OFF pill) + auto-start | `dashboard/page.tsx` Tour tile + `useTour` | match |  | 3 | Phase 3: `useTour({ autoStartOnFirstRun: true })` auto-launches on first visit when IDB `tour-state.seen === false`. Dashboard tile toggles Start/Stop; tour survives hard reload via IDB. |
| dashboard/dashboardview-642 | `DashboardView.swift:L642-L667` Log Out button with red tint | `dashboard/page.tsx:L269` `SetupTile variant="destructive"` | match |  |  |  |
| dashboard/dashboardview-676 | `DashboardView.swift:L676-L703` TourManager start / navigate to job / TTS narration | `useTour` hook + `TourOverlay` + `web/src/lib/tour/steps.ts` (2 dashboard + 9 job, v11 narrations) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 3) — v11 refresh incl. the chime step; see `dashboard/tour-v11`. Narration engine divergence stands as before: iOS plays bundled ElevenLabs MP3s, web speaks via Web Speech API. |
| dashboard/dashboardview-294 | `DashboardView.swift:L294-L308` Delete Job confirmation alert | `job-row.tsx` `ConfirmDialog` | match |  | 3 | Phase 3: destructive ConfirmDialog with "Delete job for <address>? This cannot be undone." text wraps both the swipe-delete and right-click-delete paths. |
| dashboard/dashboardview-188 | `DashboardView.swift:L188-L189` pull-to-refresh `.refreshable` | N/A (SWR IDB cache + focus refresh) | partial |  | 9 | Phase 9 defer: SWR IDB cache + tab-focus re-fetch already serves every case a pull-to-refresh would (inspector returns to dashboard → focus listener refetches). Implementing a touch-based pull gesture on a web page fights with native browser scroll overscroll behaviour, especially on iOS Safari. No inspector feedback asking for the gesture — closed as intentional platform divergence. WS7 re-audits the pull-to-refresh SUPPRESSION policy in installed-PWA mode (parent §3D — the goal is no browser-artifact refresh gesture, not adding one). WS7 2026-07-03: policy CONFIRMED + enforced — `overscroll-behavior: none` on html+body (`globals.css`) suppresses the browser pull-to-refresh / rubber-band in standalone; no touch pull gesture added (intentional divergence stands). Awaiting iPhone A2HS device smoke for the actual standalone overscroll behaviour. |
| dashboard/dashboardview-43 | `DashboardView.swift:L43-L46` `OfflineBanner` slide-in on connection loss | `web/src/components/pwa/offline-indicator.tsx` header pill (`md+`) + `<OfflineBanner />` full-width banner (`< md`) | match |  | 9 | Phase 9: `OfflineIndicator` now renders the amber pill only on `md+` viewports; below that breakpoint the full-width `<OfflineBanner />` (mounted by AppShell just under the header) matches the iOS slide-in shape. One component, breakpoint-driven — same offline state drives both so pending counts stay consistent. |
| dashboard/dashboardview-201 | `DashboardView.swift:L201-L221` toolbar Alerts bell + Settings gear (top-right) | `app-shell.tsx` + `<AlertsBell />` | match |  | 3 | Phase 3: bell lives in the right header cluster between OfflineIndicator + user name. Badge count drives off `bucketJobs(jobs).needsAttention.length` (same helper as the /alerts page). Tapping navigates to /alerts. |
| dashboard/alertsview | `Views/Alerts/AlertsView.swift` whole view (Failed / In Progress / Recently Completed sections) | `app/alerts/page.tsx` | match |  | 3 | Phase 3: new `/alerts` route. Three collapsible `SectionCard`s with TallyBadge counts; buckets derived via pure `bucketJobs(jobs)` (iOS parity — status-based only, not computeWarnings). |
| dashboard/alertsview-176 | `AlertsView.swift:L176-L191` empty-state "All Clear" green shield | `app/alerts/page.tsx` `EmptyState` | match |  | 3 | Phase 3: green Shield icon + "All clear" copy + subtitle. |
| dashboard/alertsview-130 | `AlertsView.swift:L130-L172` alertJobRow with status conduit stripe + badge | `app/alerts/page.tsx` reuses `<JobRow>` | match |  | 3 | Phase 3: rather than a bespoke alert-row variant, the existing `<JobRow>` renders inside each `SectionCard` — same coloured stripe + status pill, stays consistent with the dashboard. |
| dashboard/touroverlayview-13 | `Views/Tour/TourOverlayView.swift:L13-L76` floating transport controls (step counter / back / play-pause / forward / stop) | `components/tour/tour-overlay.tsx` + `tour-step-highlight.tsx` | match |  | 3 | Phase 3: capsule-shaped floating pill at the bottom of the viewport; 5 controls (counter N/TOTAL, back, pause/resume, forward, stop). Spotlight cutout + accent ring + tip card. |
| dashboard/certmateapp | `CertMateApp.swift` `@AppStorage("appTourEnabled")` default=true | `lib/tour/state.ts` (IDB `app-settings/tour-state`) | match |  | 3 | Phase 3: IDB-backed (partitioned with `certmate-cache`); `{seen, disabled}` survives hard reloads and is wiped on sign-out via `clearJobCache()`. |
| dashboard/jobrowview | `Views/Dashboard/JobRowView.swift` (status pill, coloured stripe, cert type, address, last modified) | `components/dashboard/job-row.tsx` | match |  |  | Web row exists and has pendingSync chip extra. |
| dashboard/defaultsmodal-37 | `Views/Dashboard/DefaultsModal.swift:L37` preset picker reusing `Constants.circuitFieldOrder` for per-field defaults | Defaults now persist globally; no per-job picker modal | match |  | 6 | Phase 6 simplifies the iOS "pick-a-preset-per-job" modal to a single user-scoped defaults blob saved on `/settings/defaults/*`. Multi-preset CRUD deferred (see DefaultValuesView row). |
| dashboard/inspectormodal | `Views/Dashboard/InspectorModal.swift` (quick inspector picker from dashboard) | MISSING (by design) | partial |  | 9 | Phase 9 defer: web deliberately routes all inspector switching through Settings → Staff + the per-job Staff tab. The iOS dashboard modal exists because iOS lacks a persistent tab for per-job staff; web has one, so an extra modal on the dashboard would be redundant. Closed as an intentional platform divergence. |
| dashboard/createcertificatesheet | `Views/Create/CreateCertificateSheet.swift` PresetPickerSheet (shown after new-job create) | `components/dashboard/preset-picker-sheet.tsx` ("Apply Defaults" / "Choose which defaults to apply" / per-preset rows / Skip) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 6) — see `dashboard/job-creation-defaults-flow`. |

---

## Job — Overview tab

At-a-glance readonly dashboard inside a job.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift` (tab host)

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| overview/jobdetailview-68 | `JobDetailView.swift:L68-L100` phone header (back + address + menu) | `web/src/components/job/job-header.tsx` | partial |  | 4 | Web header lacks the menu button (Edit Defaults, Apply Defaults, Start Tour). Menu entries iOS-only until defaults + tour ship. |
| overview/jobdetailview-88 | `JobDetailView.swift:L88-L103` menu → Edit Default Values | Reached via Settings → Certificate Defaults | match |  | 6 | Phase 6: Defaults editor lives on `/settings/defaults/values`; web doesn't replicate the per-job menu entry since the defaults are user-scoped, not job-scoped — the Settings hub is the authoritative location. |
| overview/jobdetailview-97 | `JobDetailView.swift:L97-L99` menu → Apply Defaults to Job | Circuits tab action rail | match |  | 6 | Phase 5 shipped the button; Phase 6 wired it to read user-saved defaults via `useUserDefaults`. Users trigger it from the Circuits tab rather than from a job-wide menu — same result, matches where inspectors are when they want to fill circuit fields. |
| overview/jobdetailview-100 | `JobDetailView.swift:L100-L102` menu → Start Tour | MISSING | partial |  | 3 | Phase 3 scope: tour launch lives on the dashboard Setup tile + `/settings` → "Start tour" row. Per-job "Start tour" menu entry deferred — the current 4-step tour is dashboard-only; job-detail tour steps aren't ported yet. |
| overview/ios-tab-model-one-tab | iOS tab model: one tab selected (0=Overview) with swipeable TabView | `web/src/components/job/job-tab-nav.tsx` (pill nav) | match | 2026-07-02 |  | Web uses a horizontal pill nav instead of swipe, acceptable pattern difference. Tab SET + ORDER + cert-type gating re-verified 2026-07-02 against `JobDetailView.swift:472-536` (incl. null-certType → EICR fallback at `job-tab-nav.tsx:123` mirroring iOS `isEIC=false`) — NO re-drift of the Wave-5 P0 class. Visual FORM gap (rail + paged content) tracked at `crosscutting/tab-rail-form` (WS5). |
| overview/web-src-app-job-id-page-tsx-l64-l121 | `web/src/app/job/[id]/page.tsx:L64-L121` HeroBox Client / Installation / Supply / Main Fuse / Earthing | N/A (web-only Overview dashboard design) | ios-only |  |  | iOS has no hero-box Overview — it launches straight into Installation. Web's Overview is an additional surface. Leaving for reference. |
| overview/livefillstate-job | Live field population during recording (read from `liveFillState.job`) — iOS `LiveFillView` | `web/src/components/live-fill/live-fill-view.tsx` | partial |  | 8 | Web LiveFillView covers most sections but layout differs — iOS keeps Overview tab live, web overlays LiveFillView separately. |
| overview/overview-general-condition-summary-card | Overview "General Condition" summary card linked to Installation tab | `app/job/[id]/page.tsx:L126-L149` `SummaryCard` | match |  |  |  |
| overview/overview-circuits-compact-table-lg | Overview Circuits compact table (lg: wide 29-col matrix) | `app/job/[id]/page.tsx:L270-L518` CircuitsPanel + WideCircuitsPanel | match |  |  | Web renders both compact + 29-col wide view. iOS only shows a similar shape in landscape. |
| overview/overview-observations-panel-with-c1-c2-c3-fi | Overview Observations panel with C1/C2/C3/FI chip | `app/job/[id]/page.tsx:L526-L582` ObservationsPanel | match |  |  |  |

---

## Job — Installation tab

Client, installation address, inspection dates, premises, report details.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/InstallationTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| installation/installationtab-310 | `InstallationTab.swift:L310-L340` heroHeader gradient ("Installation Details" / "Client, premises & dates") | `web/src/app/job/[id]/installation/page.tsx:L121-L134` | match |  |  |  |
| installation/installationtab-60 | `InstallationTab.swift:L60` client_name `CMFloatingTextField` | `installation/page.tsx:L138-L141` FloatingLabelInput | match |  |  |  |
| installation/installationtab-61 | `InstallationTab.swift:L61` client_address | `installation/page.tsx:L143-L146` | match |  |  |  |
| installation/installationtab-62 | `InstallationTab.swift:L62` client_town | `installation/page.tsx:L149-L152` | match |  |  |  |
| installation/installationtab-63 | `InstallationTab.swift:L63` client_county | `installation/page.tsx:L153-L156` | match |  |  |  |
| installation/installationtab-64 | `InstallationTab.swift:L64` client_postcode (+ postcode autocomplete debounce) | `installation/page.tsx` + `hooks/use-postcode-lookup.ts` | match |  |  | Phase 4: `api.lookupPostcode` wraps backend `GET /api/postcode/:postcode`; 400ms debounce + canonical-form memo in `usePostcodeLookup` hook; fill-empty-only semantics for town/county. |
| installation/installationtab-65 | `InstallationTab.swift:L65` client_phone (phonePad keyboard) | `installation/page.tsx:L163-L168` inputMode="tel" | match |  |  |  |
| installation/installationtab-66 | `InstallationTab.swift:L66-L67` client_email (autocapitalise none, email keyboard) | `installation/page.tsx:L170-L177` | match |  |  |  |
| installation/installationtab-76 | `InstallationTab.swift:L76` address (installation) | `installation/page.tsx:L182-L185` | match |  |  |  |
| installation/installationtab-77 | `InstallationTab.swift:L77-L79` town/county/postcode (installation) | `installation/page.tsx` | match |  |  | Phase 4: installation-address postcode wired to the same `usePostcodeLookup` hook used for the client postcode; fill-empty-only for town/county. |
| installation/installationtab-80 | `InstallationTab.swift:L80` occupier_name | `installation/page.tsx:L202-L206` | match |  |  |  |
| installation/installationtab-90 | `InstallationTab.swift:L90-L93` CMDatePickerField `Date of Inspection` | `installation/page.tsx:L212-L216` `<input type="date">` | match |  |  |  |
| installation/installationtab-95 | `InstallationTab.swift:L95-L101` `Date of Previous Inspection` (EICR only, N/A allowed) | `installation/page.tsx` | match |  |  | Phase 4: N/A pill-button toggle stores literal `"N/A"` as the value and disables the date input; tap again to re-enable. Matches iOS `CMDatePickerStringField` sentinel contract. |
| installation/installationtab-103 | `InstallationTab.swift:L103-L107` Next inspection years Picker (menu) | `installation/page.tsx:L226-L232` NumericStepper (1–10) | match |  |  | iOS uses a Picker bound to `Constants.inspectionIntervals`; web uses a stepper — acceptable affordance difference, same end result. Default 5 seeded on mount (Phase 4). |
| installation/installationtab-109 | `InstallationTab.swift:L109-L112` Next inspection due (auto-recomputed) | `installation/page.tsx:L234-L239` + `setYears` auto-compute | match |  |  |  |
| installation/installationtab-122 | `InstallationTab.swift:L122-L127` Premises Description (CMFloatingPicker, `Constants.premisesDescriptions`) | `installation/page.tsx:L244-L249` SelectChips (4 options: Residential/Commercial/Industrial/Other) | match |  |  |  |
| installation/installationtab-130 | `InstallationTab.swift:L130-L131` Toggle "Installation records available" (EICR only) | `installation/page.tsx:L256-L270` SegmentedControl Yes/No | match |  |  | Toggle-vs-segmented is acceptable. |
| installation/installationtab-132 | `InstallationTab.swift:L132-L133` Toggle "Evidence of additions/alterations" (EICR only) | `installation/page.tsx:L274-L288` SegmentedControl | match |  |  |  |
| installation/installationtab-145 | `InstallationTab.swift:L145` previous_certificate_number (EICR) | `installation/page.tsx:L297-L301` | match |  |  |  |
| installation/installationtab-146 | `InstallationTab.swift:L146` estimated_age_of_installation (EICR) | `installation/page.tsx:L302-L307` | match |  |  |  |
| installation/installationtab-155 | `InstallationTab.swift:L155-L157` Reason for Report (multiline 2-4 lines, EICR) | `installation/page.tsx:L312-L317` MultilineField rows=3 | match |  |  |  |
| installation/installationtab-166 | `InstallationTab.swift:L166-L168` General Condition of Installation (multiline 3-6, EICR) | `installation/page.tsx:L321-L326` MultilineField rows=4 | match |  |  |  |
| installation/installationtab-177 | `InstallationTab.swift:L177-L179` Extent of installation covered (multiline, EICR) | `installation/page.tsx:L330-L335` | match |  |  |  |
| installation/installationtab-180 | `InstallationTab.swift:L180-L182` Agreed limitations (multiline, EICR) | `installation/page.tsx:L336-L341` | match |  |  |  |
| installation/installationtab-183 | `InstallationTab.swift:L183` Agreed with (single line, EICR) | `installation/page.tsx:L342-L346` | match |  |  |  |
| installation/installationtab-184 | `InstallationTab.swift:L184-L186` Operational limitations (multiline, EICR) | `installation/page.tsx:L347-L352` | match |  |  |  |
| installation/installationtab-344 | `InstallationTab.swift:L344-L399` Inspector Section (quick-select pills + add-new inline + signature capture + default star) | `installation/page.tsx:L358-L364` static SectionCard hint only ("lives on Staff tab") | partial |  | 6 | Phase 4 scope limit: inline inspector pills + add-new form deferred to Phase 6 (Settings/Staff hub is the proper home for staff CRUD). The punt-to-Staff-tab hint stays. |
| installation/installationtab-460 | `InstallationTab.swift:L460-L490` inline new-inspector form (first/last/position/signature/isDefault) | Reached via Settings → Staff | ios-only |  | 6 | Web routes new-inspector creation through Settings → Staff → New, matching the web's single source-of-truth for staff CRUD. Inline add inside Installation is an iOS-only convenience that would duplicate the form surface on web. Closed as intentional platform divergence. |
| installation/installationtab-502 | `InstallationTab.swift:L502-L527` ensureDateOfInspection / autoSelectDefaultIfNeeded / default nextInspectionYears=5 | `installation/page.tsx` | match | 2026-07-03 |  | Phase 4: one-shot mount effect seeds `date_of_inspection` = today, `next_inspection_years` = 5, and computed `next_inspection_due_date`. Inspector auto-select deferred to Phase 6 alongside inline inspector picker. **2026-07-03 (commit `851ba63e`): seeder now GATES on `JobProvider.isHydrated`** — never seeds on an IDB cache paint, only after a real `api.job()` doc lands. Closes the P1 auto-seed-on-unhydrated-job data-loss bug (`web/audit/INDEX-2026-07.md`, "THIRD frontend bug"). Now truly iOS-canonical: iOS `ensureDateOfInspection` likewise runs only after `load()` succeeds. |
| installation/installationtab-12 | `InstallationTab.swift:L12-L18` inspector state (@State newFirstName, newSignatureData, saveError) | `settings/staff/[inspectorId]/page.tsx` | match |  |  | Ported to separate staff detail page. |

---

## Job — Supply tab

Earthing, live conductors, PFC, Ze, main switch, RCD, bonding, SPD.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| supply/supplytab-442 | `SupplyTab.swift:L442-L472` heroHeader "Supply Characteristics" | `web/src/app/job/[id]/supply/page.tsx:L387-L404` HeroBanner | match |  |  |  |
| supply/supplytab-28 | `SupplyTab.swift:L28-L31` Earthing Arrangement picker + onChange auto-flips TT flags | `supply/page.tsx` | match |  |  | Phase 4: `setEarthingArrangement` side-effects `means_earthing_electrode=true` when TT and mirrors `inspection.is_tt_earthing`. Non-TT selections leave electrode flag alone (intentional override respected). Unit-tested in `tests/phase-4-supply-tt-sideeffect.test.ts`. |
| supply/supplytab-50 | `SupplyTab.swift:L50-L54` Live Conductors picker | `supply/page.tsx:L72-L77` SelectChips | match |  |  |  |
| supply/supplytab-56 | `SupplyTab.swift:L56-L60` Number of Supplies picker (`Constants.numberOfSupplies`) | `supply/page.tsx` plain numeric input | partial |  | 9 | Phase 9 defer: requires porting iOS `Constants.numberOfSupplies` → `@certmate/shared-utils` and a value-round-trip audit with the backend. Free-form numeric input is behaviourally correct; preset picker is ergonomic polish. Tracked under "Supply preset pickers" follow-up. |
| supply/supplytab-62 | `SupplyTab.swift:L62-L72` Nominal Voltage U / Uo pickers | `supply/page.tsx` plain numeric inputs | partial |  | 9 | Phase 9 defer: same Constants-port dependency. Free-form input is acceptable — inspectors type `230` in practice. |
| supply/supplytab-74 | `SupplyTab.swift:L74-L78` Nominal Frequency picker | `supply/page.tsx` plain numeric input | partial |  | 9 | Phase 9 defer: same Constants-port dependency. The only realistic value is `50` (UK) so the free-form input rarely sees anything else. |
| supply/supplytab-88 | `SupplyTab.swift:L88-L91` Means of earthing: Distributor + Electrode toggles (both shown) | `supply/page.tsx` | match |  |  | Phase 4: two independent Yes/No SegmentedControls so distributor+electrode can both be true (e.g. PME + supplementary earth electrode). |
| supply/supplytab-93 | `SupplyTab.swift:L93-L103` if electrode: type picker + resistance + location (hidden until enabled) | `supply/page.tsx` | match |  |  | Phase 4: SelectChips with 6 options (Earth Rod / EE / P / T / M / O) mirroring iOS `Constants.earthElectrodeTypes`; resistance + location fields unchanged. |
| supply/supplytab-113 | `SupplyTab.swift:L113-L132` Main switch BS/EN picker + "Other" → custom text | `supply/page.tsx` plain text | partial |  | 9 | Phase 9 defer: same Constants-port dependency; tracked under "Supply preset pickers" follow-up. |
| supply/supplytab-134 | `SupplyTab.swift:L134-L138` Main switch poles picker | `supply/page.tsx` plain text | partial |  | 9 | Phase 9 defer: same Constants-port dependency. |
| supply/supplytab-140 | `SupplyTab.swift:L140-L160` Main switch voltage picker + "Other" | `supply/page.tsx` plain numeric | partial |  | 9 | Phase 9 defer: same Constants-port dependency. |
| supply/supplytab-162 | `SupplyTab.swift:L162-L182` Main switch current picker + "Other" | `supply/page.tsx` plain numeric | partial |  | 9 | Phase 9 defer: same Constants-port dependency. |
| supply/supplytab-184 | `SupplyTab.swift:L184-L188` Fuse/Setting A picker | `supply/page.tsx` plain numeric | partial |  | 9 | Phase 9 defer: same Constants-port dependency. |
| supply/supplytab-190 | `SupplyTab.swift:L190` Location text | `supply/page.tsx:L216-L220` | match |  |  |  |
| supply/supplytab-193 | `SupplyTab.swift:L193-L197` Conductor material picker + "Copper" QuickSetButton | `supply/page.tsx` | match |  |  | Phase 4: added `main_switch_conductor_material` text input with Copper quick-set pill. Shared-types already carried the field (`packages/shared-types/src/supply.ts:27-28`). |
| supply/supplytab-199 | `SupplyTab.swift:L199-L203` Main switch conductor CSA picker | `supply/page.tsx` | match |  |  | Phase 4: added `main_switch_conductor_csa` numeric input alongside the material picker. |
| supply/supplytab-213 | `SupplyTab.swift:L213-L224` RCD Operating Current IΔn picker + N/A + LIM quicksets + test-result Ω | `supply/page.tsx` plain numeric + tested pair | partial |  | 9 | Phase 9 defer: tracked under "Supply preset pickers" — needs `Constants.rcdOperatingCurrents` port. Paired tested-value field already present and Phase 4 seeds the preset field to "N/A" on first appearance so the PDF renders cleanly even without a picker. |
| supply/supplytab-226 | `SupplyTab.swift:L226-L239` RCD Time Delay picker (ms) + N/A + LIM + test result | `supply/page.tsx` | partial |  | 9 | Phase 9 defer: same Constants-port dependency. |
| supply/supplytab-241 | `SupplyTab.swift:L241-L254` RCD Operating Time picker + N/A + LIM + test result | `supply/page.tsx` | partial |  | 9 | Phase 9 defer: same Constants-port dependency. |
| supply/supplytab-264 | `SupplyTab.swift:L264-L275` Earthing conductor material + CSA | `supply/page.tsx` | match |  |  | Phase 4: added Copper quick-set pill to the earthing-conductor material field; CSA already present. |
| supply/supplytab-277 | `SupplyTab.swift:L277-L294` Earthing conductor continuity check PASS/FAIL/LIM button row | `supply/page.tsx` | match |  |  | Phase 4: replaced the numeric Ω input with a 3-state SegmentedControl; data model aligns with iOS `Constants.continuityResults`. |
| supply/supplytab-303 | `SupplyTab.swift:L303-L314` Main bonding material + CSA picker + Copper | `supply/page.tsx` | match |  |  | Phase 4: added Copper quick-set pill to main bonding material. |
| supply/supplytab-316 | `SupplyTab.swift:L316-L332` Main bonding continuity PASS/FAIL/LIM | `supply/page.tsx` | match |  |  | Phase 4: 3-state SegmentedControl mirrors iOS (PASS/FAIL/LIM); `autoContinuityIfBonded` auto-ticks PASS when any bond row is PASS. |
| supply/supplytab-342 | `SupplyTab.swift:L342` Bonding — Water PASS/FAIL/LIM | `supply/page.tsx` | match |  |  | Phase 4: 3-state SegmentedControl. |
| supply/supplytab-344 | `SupplyTab.swift:L344` Bonding — Gas | `supply/page.tsx` | match |  |  | Phase 4: 3-state SegmentedControl. |
| supply/supplytab-346 | `SupplyTab.swift:L346` Bonding — Oil | `supply/page.tsx` | match |  |  | Phase 4: 3-state SegmentedControl. |
| supply/supplytab-348 | `SupplyTab.swift:L348` Bonding — Structural Steel | `supply/page.tsx` | match |  |  | Phase 4: 3-state SegmentedControl. |
| supply/supplytab-350 | `SupplyTab.swift:L350` Bonding — Lightning | `supply/page.tsx` | match |  |  | Phase 4: 3-state SegmentedControl. |
| supply/supplytab-353 | `SupplyTab.swift:L353-L366` Bonding — Other N/A toggle + text | `supply/page.tsx:L336-L354` FloatingLabelInput + trailing N/A button | match |  |  |  |
| supply/supplytab-343 | `SupplyTab.swift:L343-L351` `autoContinuityIfBonded` — auto-sets main bonding continuity PASS when any bond is PASS | `supply/page.tsx` | match |  |  | Phase 4: `setBonding` promotes main_bonding_continuity → PASS when any of the 5 extraneous bonds is PASS; never stomps a manual FAIL. Unit-tested. |
| supply/supplytab-377 | `SupplyTab.swift:L377-L395` Test results — PFC + Ze + onChange auto-sets polarity + earthing continuity when Ze entered | `supply/page.tsx` | match |  |  | Phase 4: `handleZeChange` fires the auto-tick once per field; a manual-override Set prevents re-tripping after the inspector has deliberately set polarity=No or continuity=FAIL. |
| supply/supplytab-394 | `SupplyTab.swift:L394` Supply polarity toggle | `supply/page.tsx:L116-L135` SegmentedControl Yes/No | match |  |  |  |
| supply/supplytab-405 | `SupplyTab.swift:L405-L423` SPD: BS/EN picker + type text + short circuit kA picker + rated A picker | `supply/page.tsx` plain text inputs | partial |  | 9 | Phase 9 defer: same Constants-port dependency. Phase 4 seeds SPD fields to "N/A" on first appearance so the PDF never has blank rows. |
| supply/supplytab-488 | `SupplyTab.swift:L488-L512` Defaults application: SPD/RCD/MainBonding default to "N/A" on first appearance | `supply/page.tsx` | match | 2026-07-03 |  | Phase 4: one-shot mount effect seeds SPD (4 fields), RCD (6 fields), main bonding (3 fields) → "N/A" when empty. Guarded via seededRef so it never re-fires. **2026-07-03 (commit `851ba63e`): coercion now GATES on `JobProvider.isHydrated`** — never seeds on an IDB cache paint, only after a real `api.job()` doc lands. Same P1 data-loss fix as `installation/installationtab-502`; iOS `applyDefaultsIfNeeded` also runs only after a successful load. |
| supply/supplytab-514 | `SupplyTab.swift:L514-L527` detectCustomValues — re-enable "Other" UI when loaded value isn't in preset list | N/A (pickers not yet ported) | partial |  | 9 | Phase 9 defer: only relevant once the Supply preset pickers land. Rolls up with the "Supply preset pickers" follow-up; no UI surface to wire this into until then. |

---

## Job — Board tab

Multiple boards per job (main + sub-distribution/sub-main), per-board metadata.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/BoardTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| board/boardtab-71 | `BoardTab.swift:L71-L118` horizontal board selector bar with star-for-main + inline plus | `web/src/app/job/[id]/board/page.tsx:L102-L139` board pills + Add + Remove | match |  |  |  |
| board/boardtab-22 | `BoardTab.swift:L22-L48` toolbar actions: Add / Move Left / Move Right / Remove | `components/job/board-selector-bar.tsx` | match |  |  | Phase 4: new `BoardSelectorBar` primitive surfaces Move left / Move right / Remove with edge-disable, plus the Add pill. Reorder via array splice. |
| board/boardtab-50 | `BoardTab.swift:L50-L62` Remove confirmation dialog "will remove all circuits + observations" | `board/page.tsx` | match |  |  | Phase 4: Remove wraps `ConfirmDialog` (Phase 1 primitive); description surfaces the cascade count (N circuits + M observations tagged to this board). |
| board/boardtab-122 | `BoardTab.swift:L122-L171` board hero header (designation + location + isSubBoard fedFrom) | `board/page.tsx` `HeroBanner` aggregated count (now `HeroHeader` with `board` accent) | partial |  | 9 | Phase 9 defer: per-board hero (designation + fedFrom context) would require the hero to re-render on every board-selector change — reducing the hero's purpose as a "you are on the Board tab" banner. Web surfaces the per-board context in the designation field + location card directly; the hero is intentionally aggregate-only. Phase 9 migrated the static hero to `<HeroHeader accent="board">` for visual parity with the rest of the tabs. |
| board/boardtab-190 | `BoardTab.swift:L190` designation field | `board/page.tsx:L143-L147` | match |  |  |  |
| board/boardtab-191 | `BoardTab.swift:L191` name field | `board/page.tsx:L148-L152` | match |  |  |  |
| board/boardtab-192 | `BoardTab.swift:L192` location field | `board/page.tsx:L173-L177` | match |  |  |  |
| board/boardtab-193 | `BoardTab.swift:L193` manufacturer field | `board/page.tsx:L153-L157` | match |  |  |  |
| board/boardtab | `BoardTab.swift` (implicit) — `model` field on iOS? | `board/page.tsx:L158-L162` | ios-only |  |  | Web has `model`; iOS BoardTab doesn't surface one. Confirm backing model has `model` field. |
| board/boardtab-196 | `BoardTab.swift:L196-L203` BoardType picker (main/sub_distribution/sub_main) | `board/page.tsx:L164-L169` SelectChips | match |  |  |  |
| board/boardtab-205 | `BoardTab.swift:L205-L210` Fed From picker (filters other boards) when sub-board | `board/page.tsx` | match |  |  | Phase 4: sub-boards show a SelectChips of the OTHER boards' designations; plain text "feed circuit ref" still available in the sub-main cable section. |
| board/boardtab-370 | `BoardTab.swift:L370-L389` parentBoardBinding — auto-fills `suppliedFrom` + inherits earthing from parent | `board/page.tsx` `setParent` | match |  |  | Phase 4: picking a parent populates `supplied_from` with the parent's designation and inherits earthing arrangement when the child doesn't have one set yet. |
| board/boardtab-209 | `BoardTab.swift:L209` `suppliedFrom` text when main board | `board/page.tsx:L178-L182` | match |  |  |  |
| board/boardtab-212 | `BoardTab.swift:L212-L216` Phases picker (`Constants.phaseOptions`) | `board/page.tsx:L187-L192` SelectChips (Single/Three) | match |  |  |  |
| board/boardtab-217 | `BoardTab.swift:L217-L221` Earthing picker | `board/page.tsx:L193-L198` SelectChips | match |  |  |  |
| board/boardtab-231 | `BoardTab.swift:L231-L235` Sub-main cable material (sub-boards only) | `board/page.tsx:L267-L272` | match |  |  |  |
| board/boardtab-236 | `BoardTab.swift:L236` Live CSA | `board/page.tsx:L273-L278` | match |  |  |  |
| board/boardtab-237 | `BoardTab.swift:L237` CPC CSA | `board/page.tsx:L285-L290` | match |  |  |  |
| board/boardtab-238 | `BoardTab.swift:L238` Cable length | `board/page.tsx:L279-L284` | match |  |  |  |
| board/boardtab-248 | `BoardTab.swift:L248` Main switch BS(EN) | `board/page.tsx:L229-L233` | match |  |  |  |
| board/boardtab-249 | `BoardTab.swift:L249` voltage rating | `board/page.tsx:L234-L238` | match |  |  |  |
| board/boardtab-250 | `BoardTab.swift:L250` rated current | `board/page.tsx:L239-L243` | match |  |  |  |
| board/boardtab-259 | `BoardTab.swift:L259` polarity confirmed toggle (✓ sentinel string) | `board/page.tsx` | match |  |  | Phase 4: Yes/No SegmentedControl on the Protection section; writes the iOS `✓` sentinel when Yes so round-trip is lossless. |
| board/boardtab-260 | `BoardTab.swift:L260` phases confirmed text | `board/page.tsx` | match |  |  | Phase 4: plain text input on the Protection section (matches iOS's free-text use case, e.g. "L1-L2-L3 OK"). |
| board/boardtab-261 | `BoardTab.swift:L261` RCD trip time ms | `board/page.tsx:L219-L223` | match |  |  |  |
| board/boardtab-262 | `BoardTab.swift:L262` IPF rating kA | `board/page.tsx:L244-L248` | match |  |  |  |
| board/boardtab-263 | `BoardTab.swift:L263` RCD rating mA | `board/page.tsx:L252-L256` | match |  |  |  |
| board/boardtab-272 | `BoardTab.swift:L272` SPD type text | `board/page.tsx:L257-L261` | match |  |  |  |
| board/boardtab-273 | `BoardTab.swift:L273` SPD status text | `board/page.tsx` | match |  |  | Phase 4: added `spd_status` alongside `spd_type` in the SPD section. |
| board/boardtab-282 | `BoardTab.swift:L282` overcurrent BS(EN) | `board/page.tsx` | match |  |  | Phase 4: new "Overcurrent device" SectionCard with BS EN / voltage / current. |
| board/boardtab-283 | `BoardTab.swift:L283` overcurrent voltage | `board/page.tsx` | match |  |  | Phase 4: as above. |
| board/boardtab-284 | `BoardTab.swift:L284` overcurrent current | `board/page.tsx` | match |  |  | Phase 4: as above. |
| board/boardtab-296 | `BoardTab.swift:L296` Ze at this board | `board/page.tsx:L199-L203` | match |  |  |  |
| board/boardtab-297 | `BoardTab.swift:L297` Zs at DB | `board/page.tsx:L205-L209` | match |  |  |  |
| board/boardtab-298 | `BoardTab.swift:L298` Ipf at DB | `board/page.tsx:L211-L215` | match |  |  |  |
| board/boardtab-304 | `BoardTab.swift:L304-L310` Notes section (TextEditor, 80pt min) | `board/page.tsx:L300-L307` `<textarea rows=3>` | match |  |  |  |

---

## Job — Circuits tab

Per-circuit readings — the biggest tab (29 column schedule + action rail + CCU flows).

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/CircuitsTab.swift`
- `CertMateUnified/Sources/Views/CCUExtraction/CCUExtractionModeSheet.swift`
- `CertMateUnified/Sources/Views/CCUExtraction/CircuitMatchReviewView.swift`
- `CertMateUnified/Sources/Utilities/Constants.swift:L180-L224` (column definitions)

### Action rail buttons (top)

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| circuits-rail/circuitstab-79 | `CircuitsTab.swift:L79-L114` portrait-only boards filter bar (horizontal pills) | `circuits/page.tsx:L240-L259` board pills (any orientation) | match |  |  |  |
| circuits-rail/circuitstab-132 | `CircuitsTab.swift:L132-L139` Cancel delete-mode button | N/A — web has single "Delete all" with confirm dialog | match |  | 5 | Phase 5: web simplifies multi-select → single "Delete all circuits on this board" guarded by `ConfirmDialog`. Wider web viewports make per-row delete trivially accessible; multi-select-mode state machine was not worth porting. |
| circuits-rail/circuitstab-142 | `CircuitsTab.swift:L142-L155` Select All / Deselect All in delete mode | N/A — no multi-select mode on web | match |  | 5 | Subsumed by the simplification above. |
| circuits-rail/circuitstab-157 | `CircuitsTab.swift:L157-L164` "Delete (N)" bulk delete with count | `circuits/page.tsx` Delete → `setConfirmDeleteAllOpen(true)` + `ConfirmDialog` showing count | match |  | 5 | Dialog body renders "This will remove N circuits …" so the count-aware intent is preserved. |
| circuits-rail/circuitstab-166 | `CircuitsTab.swift:L166-L171` Add circuit button | `circuits/page.tsx:L380-L385` Add → RailButton onClick={addCircuit} | match |  |  |  |
| circuits-rail/circuitstab-173 | `CircuitsTab.swift:L173-L180` Delete mode toggle (enters multi-select) | N/A — no multi-select mode on web | match |  | 5 | Same rationale as the Cancel-delete-mode row. |
| circuits-rail/circuitstab-182 | `CircuitsTab.swift:L182-L188` Apply Defaults button | `circuits/page.tsx` Defaults → `handleApplyDefaults` via `@certmate/shared-utils` `applyDefaultsToCircuits` | match |  | 5 | Phase 5 shipped. Non-overwrite invariant enforced in the shared helper (unit test `phase-5-apply-defaults.test.ts`). |
| circuits-rail/circuitstab-190 | `CircuitsTab.swift:L190-L197` Reverse circuits button | `circuits/page.tsx:L398` Reverse → `reverse()` (wired) | match |  |  |  |
| circuits-rail/circuitstab-199 | `CircuitsTab.swift:L199-L222` Calculate menu (Zs = Ze + R1+R2, R1+R2 = Zs − Ze) | `circuits/page.tsx` Calculate rail button → floating menu → `handleCalculateZs` / `handleCalculateR1R2` via `@certmate/shared-utils` `applyZsCalculation` / `applyR1R2Calculation` | match |  | 5 | Phase 5 shipped. Pure helpers live in `packages/shared-utils/src/impedance.ts`; `formatImpedance` mirrors iOS trailing-zero trim. Negative R1+R2 skipped (iOS parity). |
| circuits-rail/circuitstab-224 | `CircuitsTab.swift:L224-L245` CCU Photo button + retry state + mode sheet flow | `circuits/page.tsx` CCU RailButton → `<CcuModeSheet>` → `<input capture="environment">` → mode-specific apply (names_only / full_capture / hardware_update) | match |  | 7 | Phase 7 closed. Mode sheet opens first; chosen mode is parked in a ref between dismiss + picker onChange; Hardware Update mode runs `matchCircuits()` and navigates to `/job/[id]/circuits/match-review`. |
| circuits-rail/circuitstab-247 | `CircuitsTab.swift:L247-L260` Extract Doc button + dialog (Take Photo / Library / Files) | `circuits/page.tsx:L413-L420` Extract RailButton + hidden `<input accept="image/*">` + `handleDocFile` | partial |  | 7 | Web has single library picker only — no camera nor file picker. PDFs explicitly not supported (backend limitation). |

### CCU extraction flow (Mode sheet + match review)

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| ccu-flow/ccuextractionmodesheet-5 | `CCUExtractionMode.swift` — SIX modes: circuitNamesOnly / hardwareUpdate / fullCapture / appendRail / addNewBoard / addOffPeakBoard | `components/job/ccu-mode-sheet.tsx` `<CcuModeSheet>` — SIX modes (off-peak tile shipped 2026-07-02; last-mode guard widened 5→6) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 1) — see `ccu-flow/off-peak-mode` for the full-path detail. Same ordering/copy/visibility rules as iOS (`appendRail` hidden at zero circuits; both board-appending tiles always visible). |
| ccu-flow/circuitmatchreviewview-5 | `CircuitMatchReviewView.swift:L5-L80` Matched circuits list with reassign + unmatched-existing footer | `app/job/[id]/circuits/match-review/page.tsx` full review screen | match |  | 7 | Phase 7 shipped. Standalone page, not a sheet — desktop has room; match data flows via sessionStorage (`cm-ccu-match-handoff:<jobId>:<nonce>`). One-tap "Accept matches above 80%" shortcut is a web-only affordance; iOS UX simplifications (inline combobox vs sheet-per-row) explained in the page docblock. |
| ccu-flow/circuitstab-429 | `CircuitsTab.swift:L429-L434` CCU mode sheet presentation (`.presentationDetents([.medium])`) | `components/job/ccu-mode-sheet.tsx` centred Dialog | match |  | 7 | Web uses a centred Dialog rather than iOS's half-height sheet presentation — equivalent affordance, adapted for desktop + mobile browser chrome. |
| ccu-flow/circuitstab-437 | `CircuitsTab.swift:L437-L445` CCU photo source dialog (Take Photo / Choose from Library) | `circuits/page.tsx` openCcuPicker — opens mode sheet first, then `<input capture="environment">` | partial |  | 7 | Web's `<input capture="environment">` still asks the OS for camera with library fallback; the mode sheet adds one step before the picker but doesn't split camera vs library as a separate dialog. Acceptable divergence — browser file-input UI already covers both. |
| ccu-flow/circuitstab-457 | `CircuitsTab.swift:L457-L468` CircuitMatchReviewView sheet + confirmMatches / cancelReview | `match-review/page.tsx` sticky Apply / Cancel footer → `applyCcuAnalysisToJob(... mode: 'hardware_update')` → navigate back to Circuits | match |  | 7 | Phase 7 shipped. One-to-one reassign invariant preserved (claiming an existing circuit releases any prior claim). |
| ccu-flow/circuitstab-470 | `CircuitsTab.swift:L470-L484` extractionVM flowState dispatch (complete/error/savedForRetry) | `circuits/page.tsx` try/catch with `setActionHint` + mode-specific progress copy | partial |  | 7 | Web has success hint + error banner + mode-aware progress text ("Analysing board labels…" / "Analysing new board hardware…"). The "saved for retry" offline queue stays iOS-only for now — see PendingExtractionQueue row below. |
| ccu-flow/circuitstab-272 | `CircuitsTab.swift:L333-L400` PendingExtractionQueue banner + thumbnails + Retry All + auto-retry on network restore | `components/job/pending-ccu-banner.tsx` on the circuits page + `lib/ccu/pending-extraction-queue.ts` (IDB `pending-ccu-extraction` store, `certmate-cache` v5) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 2): persist-before-upload Blob queue, one idempotency key per capture reused on every retry (`X-Idempotency-Key` → backend `withIdempotency('ccu')`), 409 inflight honours Retry-After: 5, terminal 422 retake (entry dropped, retake card, never auto-retried), per-row Retry + Retry All + auto-retry on window `online`, Overview "photos waiting to upload" pill (JobDetailView.swift:1174-1190). CCU photos ONLY — doc extraction stays queue-free (test-pinned). |
| ccu-flow/circuitstab-486 | `JobDetailView.swift:817` Auto-retry on `NetworkMonitor.shared.isConnected` flip (moved from CircuitsTab 2026-04-28) | `pending-ccu-banner.tsx` window `online` listener → sequential retryAll | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 2). Divergence note (dated 2026-07-02): iOS retries from JobDetail level (any tab); web's listener lives in the circuits-page banner, so auto-retry fires while the circuits tab is mounted — acceptable because that's where captures happen and the Overview pill routes the inspector there. |
| ccu-flow/circuitstab-505 | `CircuitsTab.swift:L505-L530` PhotosPicker / fileImporter / camera full-screen cover | partial via hidden file input | ios-only |  |  | PhotosPicker / fileImporter / PhotoCaptureView are native iOS primitives; web browser file input is the counterpart. Acceptable. |

### Circuit row editor — all 29 columns

Column order from `Constants.swift:L180-L211`. Web surfaces them grouped in collapsible sections (Identity / Cable / OCPD / RCD / Test readings). iOS surfaces them in a horizontally-scrolling table in landscape and portrait-card grid in portrait.

| id | iOS key + label | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|---|
| circuits-col/constants-181 | `circuit_ref` (Ref) | `Constants.swift:L181` | `circuits/page.tsx:L519-L522` | match |  |  |  |
| circuits-col/constants-182 | `circuit_designation` (Description) | `Constants.swift:L182` | `circuits/page.tsx:L524-L527` | match |  |  |  |
| circuits-col/constants-183 | `wiring_type` (Wiring Type) | `Constants.swift:L183` | `circuits/page.tsx:L546-L549` plain text | partial |  | 5 | iOS uses a picker (`Constants.circuitWiringTypes`); web is free-form. |
| circuits-col/constants-184 | `ref_method` (Ref Method) | `Constants.swift:L184` | `circuits/page.tsx:L551-L554` plain text | partial |  | 5 | iOS picker (`Constants.circuitReferenceMethods`). |
| circuits-col/constants-185 | `number_of_points` (Points) | `Constants.swift:L185` | `circuits/page.tsx:L529-L533` | match |  |  |  |
| circuits-col/constants-186 | `live_csa_mm2` (Live mm²) | `Constants.swift:L186` | `circuits/page.tsx:L555-L560` | match |  |  |  |
| circuits-col/constants-187 | `cpc_csa_mm2` (CPC mm²) | `Constants.swift:L187` | `circuits/page.tsx:L561-L566` | match |  |  |  |
| circuits-col/constants-188 | `max_disconnect_time_s` (Max Disc Time) | `Constants.swift:L188` | `circuits/page.tsx:L534-L539` | match |  |  |  |
| circuits-col/constants-189 | `ocpd_bs_en` (OCPD BS/EN) | `Constants.swift:L189` | `circuits/page.tsx:L572-L576` plain text | partial |  | 5 | iOS picker with presets. |
| circuits-col/constants-190 | `ocpd_type` (OCPD Type) | `Constants.swift:L190` | `circuits/page.tsx:L577-L582` SelectChips (B/C/D) | match |  |  |  |
| circuits-col/constants-191 | `ocpd_rating_a` (Rating A) | `Constants.swift:L191` | `circuits/page.tsx:L583-L588` | match |  |  |  |
| circuits-col/constants-192 | `ocpd_breaking_capacity_ka` (kA) | `Constants.swift:L192` | `circuits/page.tsx:L589-L594` | match |  |  |  |
| circuits-col/constants-193 | `ocpd_max_zs_ohm` (Max Zs Ω) | `Constants.swift:L193` | `circuits/page.tsx:L595-L600` | match |  |  |  |
| circuits-col/constants-194 | `rcd_bs_en` (RCD BS/EN) | `Constants.swift:L194` | `circuits/page.tsx:L606-L610` plain text | partial |  | 5 | iOS picker. |
| circuits-col/constants-195 | `rcd_type` (RCD Type) | `Constants.swift:L195` | `circuits/page.tsx:L611-L616` SelectChips (AC/A/B/F) | match |  |  |  |
| circuits-col/constants-196 | `rcd_operating_current_ma` (IΔn mA) | `Constants.swift:L196` | `circuits/page.tsx:L617-L622` plain numeric | partial |  | 5 | iOS uses circuit-specific RCD currents picker. |
| circuits-col/constants-197 | `rcd_rating_a` (RCD A) | `Constants.swift:L197` | `circuits/page.tsx:L623-L628` | match |  |  |  |
| circuits-col/constants-198 | `ring_r1_ohm` (Ring r1) | `Constants.swift:L198` | `circuits/page.tsx:L635-L640` | match |  |  |  |
| circuits-col/constants-199 | `ring_rn_ohm` (Ring rn) | `Constants.swift:L199` | `circuits/page.tsx:L641-L646` | match |  |  |  |
| circuits-col/constants-200 | `ring_r2_ohm` (Ring r2) | `Constants.swift:L200` | `circuits/page.tsx:L647-L652` | match |  |  |  |
| circuits-col/constants-201 | `r1_r2_ohm` (R1+R2) | `Constants.swift:L201` | `circuits/page.tsx:L653-L658` | match |  |  |  |
| circuits-col/constants-202 | `r2_ohm` (R2) | `Constants.swift:L202` | `circuits/page.tsx:L659-L664` | match |  |  |  |
| circuits-col/constants-203 | `ir_test_voltage_v` (IR Test V) | `Constants.swift:L203` | `circuits/page.tsx:L671-L676` plain numeric | partial |  | 5 | iOS uses preset picker (`Constants.irTestVoltages`). |
| circuits-col/constants-204 | `ir_live_live_mohm` (IR L-L) | `Constants.swift:L204` | `circuits/page.tsx:L677-L682` | match |  |  |  |
| circuits-col/constants-205 | `ir_live_earth_mohm` (IR L-E) | `Constants.swift:L205` | `circuits/page.tsx:L683-L688` | match |  |  |  |
| circuits-col/constants-206 | `polarity_confirmed` (Polarity) | `Constants.swift:L206` | `circuits/page.tsx:L696-L705` SegmentedControl Pass/Fail/N/A | match |  |  |  |
| circuits-col/constants-207 | `measured_zs_ohm` (Meas Zs) | `Constants.swift:L207` | `circuits/page.tsx:L665-L670` | match |  |  |  |
| circuits-col/constants-208 | `rcd_time_ms` (RCD ms) | `Constants.swift:L208` | `circuits/page.tsx:L689-L694` | match |  |  |  |
| circuits-col/constants-209 | `rcd_button_confirmed` (RCD Btn) | `Constants.swift:L209` | `circuits-sticky-table.tsx` select column (OK/Y/N) | partial |  | 5 | Exposed in the Table view via a schema-aligned `<select>`; Cards view doesn't surface it yet. Close fully when card view adds an RCD Btn row. |
| circuits-col/constants-210 | `afdd_button_confirmed` (AFDD Btn) | `Constants.swift:L210` | `circuits-sticky-table.tsx` select column (OK/Y/N) | partial |  | 5 | Same — Table view only. |

### Circuits — grid / layout / misc

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| circuits-misc/circuitstab-565 | `CircuitsTab.swift:L565-L572` portraitCardGrid vs stickyGrid layout | `circuits/page.tsx` Cards/Table toggle — Cards = collapsible list, Table = sticky 29-col grid (`components/job/circuits-sticky-table.tsx`) | match |  | 5 | Phase 5 shipped. Toggle persists to localStorage under `cm-circuits-view`; mobile default = Cards, desktop (≥1024) default = Table. Sticky left columns are Ref + Designation; scrollable pane holds all 27 remaining columns with iOS-derived widths. |
| circuits-misc/circuitstab-580 | `CircuitsTab.swift:L580-L600` landscape multi-board section header | N/A — web board selector is a pill bar above the table regardless of orientation | match |  | 5 | Web doesn't swap layouts on orientation; the existing board-pills selector covers the multi-board UX in both Cards and Table modes. |
| circuits-misc/circuitstab-19 | `CircuitsTab.swift:L19-L21` polarityManuallyCleared Set<String> (prevents auto-set overwrite) | N/A — no polarity auto-set on web yet | match |  | 5 | Guard only exists to protect against an auto-set iOS feature the web client doesn't implement. Re-visit if/when polarity auto-confirm ships (would pair with recording pipeline). |
| circuits-misc/circuitstab-393 | `CircuitsTab.swift:L393-L410` Bulk-delete alert with dynamic count | `circuits/page.tsx` `ConfirmDialog` — body text renders `N circuit(s)` dynamically | match |  | 5 | Same intent; shape differs (modal vs native alert). |
| circuits-misc/circuitstab-411 | `CircuitsTab.swift:L411-L426` Scan Error + Impedance Calculation alerts | `circuits/page.tsx` inline `actionHint` banner + error banners | match |  |  | Shape differs (banner vs alert); same intent. Calculate banner surfaces per-reason skip counts. |
| circuits-misc/circuitstab-486 | `CircuitsTab.swift:L486-L520` `onChange(of: viewModel.job.circuits.count)` clear stale expandedCircuitId / draggedCircuitId | `circuits/page.tsx:L119` expandedId auto-clear on remove | partial |  | 5 | Web lacks drag-reorder, so draggedCircuitId N/A. |
| circuits-misc/draggedcircuitid | Drag-and-drop reorder (`draggedCircuitId`) | `CircuitsTab.swift:L11` | MISSING |  | partial | 5 | Deferred from Phase 5 — drag reorder is niche on the table view (inspectors reorder rarely; web Reverse already covers the most common case). Re-visit only if parity ledger shows an inspector hitting it. |
| circuits-misc/circuitstab-278 | `CircuitsTab.swift:L333-L400` Pending extractions section — thumbnails + Retry All | `components/job/pending-ccu-banner.tsx` | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 2) — duplicate of `ccu-flow/circuitstab-272`; see that row. |
| circuits-misc/circuitstab-130 | `CircuitsTab.swift:L130` stub → `setActionHint(\`${label} — not available on web yet.\`)` | Removed — `stub()` helper deleted, all three consumers (Delete all / Apply defaults / Calculate) are wired | match |  | 5 | Closed by Phase 5. |

---

## Job — Observations tab

EICR-only (EIC uses Extent/Design instead). List of C1/C2/C3/FI observations with photos.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/ObservationsTab.swift`
- `CertMateUnified/Sources/Views/JobDetail/EditObservationSheet.swift`
- `CertMateUnified/Sources/Views/Components/ObservationCardView.swift`
- `CertMateUnified/Sources/Views/Components/InlineObservationForm.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| observations/observationstab-66 | `ObservationsTab.swift:L66-L129` hero gradient + C1/C2/C3/FI count badges + Add button | `web/src/app/job/[id]/observations/page.tsx:L108-L148` hero + CountBadge pills + Add | match |  |  |  |
| observations/observationstab-146 | `ObservationsTab.swift:L146-L169` empty state "No Observations" + green shield | `observations/page.tsx:L150-L158` SectionCard empty state | match |  |  |  |
| observations/observationstab-22 | `ObservationsTab.swift:L22-L45` LazyVStack of ObservationCardView with context-menu delete | `observations/page.tsx` | match |  |  | Phase 4: inline trash button now routes through `ConfirmDialog` so a mis-tap doesn't delete the defect + photos silently. Desktop inline affordance kept (context-menu is iOS-specific). |
| observations/observationstab-173 | `ObservationsTab.swift:L173-L178` deleteObservation + ObservationScheduleLinker.observationDeleted | `observations/page.tsx` | match |  |  | Phase 4: deletion of an observation removes it from `observations[]`; Inspection tab reads the linked observation via `observations.find(o => o.schedule_item === ref)`, so the preview naturally disappears — no bespoke linker needed. |
| observations/observationstab-181 | `ObservationsTab.swift:L181-L349` AddObservationSheet (NavigationStack with 3 sections) | `components/observations/observation-sheet.tsx` | match |  |  |  |
| observations/l201-l207 | AddObservationSheet Classification picker (C1/C2/C3/FI with label) `L201-L207` | `observation-sheet.tsx` CODE_OPTIONS hint row | match |  |  |  |
| observations/l215-l216 | AddObservationSheet Location field `L215-L216` | observation-sheet.tsx location input | match |  |  |  |
| observations/l217-l220 | AddObservationSheet Observation text (multiline) `L217-L220` | observation-sheet.tsx description multiline | match |  |  |  |
| observations/l220-l221 | AddObservationSheet Schedule Item (e.g. 4.4) `L220-L221` | `components/observations/observation-sheet.tsx` | match |  |  | Phase 4: two-column "Schedule item" + "Schedule item description" inputs added to the sheet; auto-populated when the observation is created from the Inspection tab. ObservationCard on the list view renders a "from schedule item N.N" pill when present. Shared-types already carried the fields. |
| observations/addobservationsheet-remedial-action | AddObservationSheet remedial action | `observation-sheet.tsx` Remedial block | match |  | 9 | Web adds a `remedial` field (matches the EditObservationSheet treatment on iOS at `EditObservationSheet.swift:L210+`). The iOS AddObservationSheet omits it, but the field round-trips through the backend so the data model matches. Phase 9: closed as `match` — web is a superset here and the row is authoritative as-is. |
| observations/l230-l256 | Photos section — horizontal scroll of ObservationPhotoThumbnail with X-button remove `L230-L256` | `observation-sheet.tsx` photo grid with delete | match |  |  |  |
| observations/l267-l272 | Camera button (fullScreenCover → PhotoCaptureView) `L267-L272` | observation-sheet.tsx Camera input (`capture="environment"`) | ios-only |  |  | iOS uses native camera overlay; web uses OS file input. Acceptable — no gap to close. |
| observations/l260-l266 | PhotosPicker Library button `L260-L266` | observation-sheet.tsx Library input | match |  |  | iOS PhotosPicker is native; web library file input covers same case. |
| observations/l285-l302 | onAppear / toolbar Save + Cancel + Add (disabled when text empty) `L285-L302` | observation-sheet.tsx Save / Cancel | match |  |  |  |
| observations/observationcardview-photo-thumbnails-inline-prev | ObservationCardView photo thumbnails (inline preview, tap to enlarge) | `observations/page.tsx:L296-L316` ObservationPhoto thumbs + "+N more" chip | match |  |  |  |
| observations/tap-observationcardview-open-edit | Tap ObservationCardView → open edit sheet | observations/page.tsx:L237, ObservationCard onOpen | match |  |  |  |
| observations/inspectiontab-286 | Inline observation editor surfaced in Inspection tab when C1/C2/C3 tapped (`InspectionTab.swift:L286-L298` + `Components/InlineObservationForm.swift`) | `inspection/page.tsx` InlineObservationForm | match |  |  | Phase 4: see "InlineObservationForm when C1/C2/C3 selected" row above. |

---

## Job — Inspection tab

BS 7671 Appendix 6 inspection schedule (~90 items for EICR, 14 for EIC).

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/InspectionTab.swift`
- `CertMateUnified/Sources/Views/Components/OutcomeButtonGroup.swift`
- `CertMateUnified/Sources/Views/Components/InlineObservationForm.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| inspection/inspectiontab-70 | `InspectionTab.swift:L70-L102` hero "Inspection Schedule" gradient | `web/src/app/job/[id]/inspection/page.tsx:L144-L159` gradient hero | match |  |  |  |
| inspection/inspectiontab-147 | `InspectionTab.swift:L147-L223` scheduleToggles card (TT / Microgen / Section 7 N/A) with Auto badge + hint | `inspection/page.tsx:L161-L186` `SectionCard accent="blue"` with three ToggleRows (EICR only) | match |  |  |  |
| inspection/inspectiontab-154 | `InspectionTab.swift:L154-L157` TT toggle → calls `vm.setTTEarthing` (auto-ticks 3.2, N/As 3.1) | `inspection/page.tsx:L90-L100` setTTEarthing | match |  |  |  |
| inspection/inspectiontab-181 | `InspectionTab.swift:L181-L204` Microgeneration toggle → 2.0, 4.11, 4.21, 4.22 | `inspection/page.tsx:L102-L107` setMicrogeneration | match |  |  |  |
| inspection/inspectiontab-209 | `InspectionTab.swift:L209-L220` Section 7 N/A bulk toggle | `inspection/page.tsx:L109-L117` setSection7NA | match |  |  |  |
| inspection/inspectiontab-112 | `InspectionTab.swift:L112-L128` EICR: 8 sections each with header + icon + progress | `inspection/page.tsx:L203-L252` EICR_SCHEDULE.map(sections) with progress counter | match |  |  | Sections + items + ScheduleRow + OUTCOME_OPTIONS all wired. |
| inspection/inspectiontab-134 | `InspectionTab.swift:L134-L143` EIC single list (14 top-level items) | `inspection/page.tsx:L188-L201` `EIC_SCHEDULE.map` single card | match |  |  |  |
| inspection/inspectiontab-255 | `InspectionTab.swift:L255-L318` scheduleItemRow — ref + description + OutcomeButtonGroup + Auto badge | `inspection/page.tsx:L306-L369` ScheduleRow | match |  |  |  |
| inspection/inspectiontab-322 | `InspectionTab.swift:L322-L344` per-section progress N/Total + mini bar | `inspection/page.tsx:L212-L240` equivalent progress bar | match |  |  |  |
| inspection/inspectiontab-266 | `InspectionTab.swift:L266-L284` linked-observation inline preview under a row | `inspection/page.tsx` ScheduleRow | match |  |  | Phase 4: observations with `schedule_item === ref` render an inline preview (code pill + location + description + "Tap to edit"); tapping opens the shared `ObservationSheet`. |
| inspection/inspectiontab-286 | `InspectionTab.swift:L286-L300` InlineObservationForm when C1/C2/C3 selected (location + text + Save) | `inspection/page.tsx` InlineObservationForm | match |  |  | Phase 4: picking C1/C2/C3 on a row with no linked observation slides an inline form (location + description) beneath. Save creates the observation with `schedule_item` + `schedule_description` pre-populated. |
| inspection/inspectiontab-43 | `InspectionTab.swift:L43-L66` confirmation alert "Delete linked observation?" when outcome changes | `inspection/page.tsx` | match |  |  | Phase 4: changing an outcome that currently has a linked observation queues a ConfirmDialog (Phase 1 primitive); the outcome change + observation delete land atomically on confirm. Unit-tested. |

---

## Job — Staff tab

Role picker (EICR: inspector + authorised; EIC: designer + constructor + inspector) with test equipment card.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/InspectorTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| staff/inspectortab-77 | `InspectorTab.swift:L77-L108` hero "Staff Assignments" gradient | `web/src/app/job/[id]/staff/page.tsx:L88-L103` | match |  |  |  |
| staff/inspectortab-20 | `InspectorTab.swift:L20-L40` EIC: 3 role picker cards (Designer / Constructor / Inspection & Testing) | `staff/page.tsx:L107-L131` RolePickerCard ×3 | match |  |  |  |
| staff/inspectortab-41 | `InspectorTab.swift:L41-L55` EICR: 2 role picker cards (Inspected / Authorised) | `staff/page.tsx:L132-L151` RolePickerCard ×2 | match |  |  |  |
| staff/inspectortab-112 | `InspectorTab.swift:L112-L184` staffPickerCard — list of inspector rows with avatar + name + position + checkmark | `staff/page.tsx:L160-L245` RolePickerCard | match |  |  |  |
| staff/inspectortab-117 | `InspectorTab.swift:L117-L123` empty state "No staff profiles configured" | `staff/page.tsx:L177-L193` "No staff profiles configured yet" info | match |  |  | Web copy also nudges to Settings → Inspectors. |
| staff/inspectortab-60 | `InspectorTab.swift:L60-L62` equipment card shown below active inspector | `staff/page.tsx:L153` EquipmentCard mount | match |  |  |  |
| staff/inspectortab-188 | `InspectorTab.swift:L188-L240` Test Equipment card — MFT / Continuity / IR / Earth Fault / RCD each with S/N + Cal date | `staff/page.tsx:L248-L327` EquipmentCard + EquipmentRow ×5 | match |  |  |  |
| staff/inspectortab-67 | `InspectorTab.swift:L67-L72` fetchAllInspectors on appear | `staff/page.tsx:L71-L72` reads `data.inspectors` from job | match |  |  | Phase 4 reviewed: MVP pattern — inspector roster lives on the job. If admin needs cross-job roster consistency (e.g. editing an inspector in Settings and seeing it reflected mid-job without reload), promote to `/api/inspectors` call in a later phase. Acceptable as-is. |

---

## Job — Extent tab (EIC)

Scope + installation type + comments. EIC-only.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/ExtentTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| extent/extenttab-78 | `ExtentTab.swift:L78-L109` hero "Extent & Limitations" | `web/src/app/job/[id]/extent/page.tsx:L54-L70` | match |  |  |  |
| extent/extenttab-26 | `ExtentTab.swift:L26-L33` Extent multiline + character count | `extent/page.tsx:L74-L80` MultilineField showCount | match |  |  |  |
| extent/extenttab-36 | `ExtentTab.swift:L36-L41` Installation Type picker (Constants.installationTypes) | `extent/page.tsx:L80-L87` SelectChips (4 options) | match |  |  |  |
| extent/extenttab-52 | `ExtentTab.swift:L52-L59` Comments multiline + count | `extent/page.tsx:L90-L98` MultilineField showCount | match |  |  |  |

---

## Job — Design tab (EIC)

BS 7671 departures + details. EIC-only.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/DesignTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| design/designtab-82 | `DesignTab.swift:L82-L113` hero "Design & Construction" | `web/src/app/job/[id]/design/page.tsx:L48-L64` | match |  |  |  |
| design/designtab-24 | `DesignTab.swift:L24-L36` info banner ("Record any departures from BS 7671 and reasons") | `design/page.tsx:L66-L79` equivalent blue-tinted info banner | match |  |  |  |
| design/designtab-38 | `DesignTab.swift:L38-L57` "No Departures" green shortcut capsule → prefill `No departures` / `N/A` | `design/page.tsx:L81-L100` equivalent | match |  |  |  |
| design/designtab-61 | `DesignTab.swift:L61-L62` Departures multiline (100pt min) | `design/page.tsx:L102-L107` MultilineField rows=4 | match |  |  |  |
| design/designtab-64 | `DesignTab.swift:L64-L65` Departure Details multiline | `design/page.tsx:L108-L113` MultilineField rows=4 | match |  |  |  |

---

## Job — PDF tab

Generate + preview + share the final PDF certificate.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/PDFTab.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| pdf/pdftab-68 | `PDFTab.swift:L68-L121` hero with pulsing status dot ("PDF generated" / "Not yet generated") | `pdf/page.tsx` `HeroBanner` + `StatusDot` (animate-ping amber ring until blob exists) | match | 2026-07-02 |  | Phase 2: wires the pulsing ring + "Generating…" transient state; colour and copy match iOS. |
| pdf/pdftab-125 | `PDFTab.swift:L125-L155` Missing-data warnings card | `pdf/page.tsx` `SectionCard accent="test-results"` "Missing data" | match | 2026-07-02 |  | Phase 2: swapped accent from `amber` → `test-results` for iOS parity with `CMSectionCard(category: .testResults)`. |
| pdf/pdf-page-tsx | `pdf/page.tsx` web-only warning computation (installation addr / inspection date / ≥1 board / ≥1 circuit / staff roles) | iOS `JobViewModel.pdfWarnings()` (company + inspector only) | partial | 2026-07-02 |  | Web list is intentionally broader — iOS users complete tabs linearly; web inspectors benefit from the richer check. Parity is "spirit of", not line-for-line. |
| pdf/pdftab-178 | `PDFTab.swift:L178-L200` Generate PDF button (gradient, green→blue) | `pdf/page.tsx` `GenerateButton` (same green→blue gradient, shadow, spinner swap) | match | 2026-07-02 |  | Phase 2 styling unchanged; WS9 2026-07-02: button now fires the CLIENT render (see pdf/pdftab-270); a separate secondary "Generate on server (fallback)" action carries the old server path. |
| pdf/pdftab-203 | `PDFTab.swift:L203-L222` Preview PDF button (opens PDFPreviewController sheet) | `pdf/page.tsx` Preview button + inline `<PdfPreview>` iframe below Actions (scroll-into-view on click) | match | 2026-07-02 |  | Phase 2: renders the Blob via an object URL in an `<iframe>` inline (rather than a modal / sheet) — cleaner scroll-through UX for desktop. |
| pdf/pdftab-225 | `PDFTab.swift:L225-L237` Share PDF via ShareLink | `pdf/page.tsx` Share button: `navigator.share({files:[File]})` with `downloadBlob` fallback | partial | 2026-07-02 |  | Phase 2: Web Share API on supported browsers (Chrome Android, iOS Safari 15+); desktop Safari / Firefox lack file-payload share support and fall back to an anchor download. |
| pdf/pdftab-243 | `PDFTab.swift:L243-L262` Generating overlay (ProgressView + ultraThinMaterial) | `pdf/page.tsx` absolute overlay on the Actions card (`Loader2` spin + "Generating…") | match | 2026-07-02 |  | Phase 2: scoped to the Actions card so other tabs stay interactive. |
| pdf/pdftab-270 | `PDFTab.swift:L270-L292` `generateLocalPDF()` — `PDFGenerator.generate(from: job)` + temp file + ShareLink URL; stamps `pdf_s3_key: local://<filename>` (`PDFTab.swift:363`) | `pdf/page.tsx` `handleGenerate('client')` → `@/lib/pdf/generate-certificate` — CLIENT-SIDE render of the ported iOS template (foreignObject capture + pdf-lib Blob), stamps `local://<filename>`; server `POST …/generate-pdf` demoted to the explicit "Generate on server (fallback)" action stamping `route://` (flips behind the debug page after field validation — TODO(ws9-followup)) | match | 2026-07-02 | WS9 | WS9 2026-07-02: web now generates locally from job state exactly like iOS (template port `web/src/lib/pdf/template/`, data-graph mirror of `PDFGenerator.swift:9-68`). Blob stays session-scoped (matches iOS re-generate-each-time). Retry-after-failed-render implements compliance spec §4.3 (re-use written attestation_ids, NO re-prompt) — current iOS does NOT (its only retry re-presents IssueCertificateSheet): dated deliberate divergence toward the SPEC; iOS spec-parity todo 2026-07-02 in vault todos-certmate.md. |
| pdf/delete-discard-generated-pdf | Delete / discard generated PDF (iOS: no explicit discard — data cleared on view dismiss) | `pdf/page.tsx` Delete button + `ConfirmDialog` → clears Blob state | match | 2026-07-02 |  | Phase 2 extra affordance: web session lives longer than iOS tab dismissal, so an explicit Discard beats accumulating stale Blobs. |
| pdf/pdftab-53 | `PDFTab.swift:L53-L57` `.sheet(isPresented: $showPreview)` PDFPreviewController (UIViewControllerRepresentable over PDFKit) | MISSING (web uses inline iframe) | ios-only | 2026-07-02 |  | Native PDFKit viewer; web uses `<iframe src={object-URL}>` via `PdfPreview`. Legitimately iOS-only. |

---

## Recording pipeline

Voice dictation + live transcript + Sonnet extraction + live fill into fields.

iOS sources:

- `CertMateUnified/Sources/Views/Recording/RecordingOverlay.swift`
- `CertMateUnified/Sources/Views/Recording/TranscriptStripView.swift`
- `CertMateUnified/Sources/Views/Recording/VADIndicatorView.swift`
- `CertMateUnified/Sources/Views/Recording/WaveformView.swift`
- `CertMateUnified/Sources/Views/Recording/ProcessingBadgeView.swift`
- `CertMateUnified/Sources/Views/Recording/PendingDataBanner.swift`
- `CertMateUnified/Sources/Views/Recording/AlertCardView.swift`
- `CertMateUnified/Sources/Views/Recording/LiveFillView.swift`
- `CertMateUnified/Sources/Views/Recording/DebugDashboardView.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| recording/recordingoverlay-38 | `RecordingOverlay.swift:L38-L239` ultraThinMaterial glass pill floating over job detail | `web/src/components/recording/recording-chrome.tsx:L103-L236` fixed bottom bar with backdrop blur | match |  |  | Layout differs (iOS floats overlay pill; web pins to bottom) but both host the same controls. |
| recording/recordingoverlay-47 | `RecordingOverlay.swift:L47-L64` Voice feedback toggle (speaker.wave.2.fill / speaker.slash) | `recording-chrome.tsx` Voice ParityButton + `lib/recording/tts.ts` | match |  |  | Phase 8 wired the toggle to `localStorage['cm-voice-feedback']`. UPDATED 2026-07-02: the "native TTS only / no ElevenLabs" description is stale — web now has ElevenLabs TTS (`web/src/lib/recording/elevenlabs-tts.ts`) with native SpeechSynthesis fallback, and iOS speaks via ElevenLabs through AlertManager. Queue-architecture parity is tracked at `recording/tts-fifo` (WS3). |
| recording/recordingoverlay-66 | `RecordingOverlay.swift:L66-L83` Defaults button (slider.horizontal.3 purple) → onSetDefaults | `recording-chrome.tsx` disabled ParityButton + link to `/settings/defaults` | partial |  | 9 | Phase 9 defer: the Defaults editor lives on its own route (Phase 6 `/settings/defaults`) rather than as an inline recording-overlay button. Opening a full editor mid-recording would steal the inspector's focus from the active dictation. Closed as intentional web UX divergence — the overlay button remains disabled with a pointer to the Settings route. |
| recording/recordingoverlay-86 | `RecordingOverlay.swift:L86-L102` Apply Defaults button → onApplyDefaults | `recording-chrome.tsx` disabled ParityButton + Circuits tab action rail | partial |  | 9 | Phase 9 defer: Apply Defaults is a Circuits-tab action (visible on the right action rail). Inspectors don't mix dictation with a circuit-wide fill-empties sweep — the two flows happen at different moments. Closed as intentional web UX divergence. |
| recording/recordingoverlay-105 | `RecordingOverlay.swift:L105-L121` CCU Photo button (orange) | `recording-chrome.tsx:L177-L182` deep-link to /circuits | partial |  | 8 | Web deep-links to Circuits tab — iOS handles it inline from recording. |
| recording/recordingoverlay-124 | `RecordingOverlay.swift:L124-L140` Doc Extract button (cyan) | `recording-chrome.tsx:L183-L188` deep-link to /circuits | partial |  | 8 |  |
| recording/recordingoverlay-143 | `RecordingOverlay.swift:L143-L159` Observation camera button | `recording-chrome.tsx:L189-L194` deep-link to /observations | partial |  | 8 |  |
| recording/recordingoverlay-163 | `RecordingOverlay.swift:L163-L178` End Session button (stop.fill red) + `showEndSessionConfirmation` | `recording-chrome.tsx` End CircleButton → `<ConfirmDialog>` | match |  |  | Phase 8 wrapped the End button in the Phase 1 `<ConfirmDialog>` primitive ("End this recording session?") so an errant tap can't nuke an in-progress session. |
| recording/recordingoverlay-182 | `RecordingOverlay.swift:L182-L204` Pause/Resume/Start (mic.fill / pause.fill / play.fill) with tint | `recording-chrome.tsx:L207-L222` Pause / Resume CircleButton | match |  |  |  |
| recording/recordingoverlay-255 | `RecordingOverlay.swift:L255-L277` Geministatus content — VADIndicator + Waveform + extraction status | `recording-chrome.tsx` VuMeter + StatePill + `<VadIndicator>` | match |  |  | Phase 8 split VAD state back out of the pill into a dedicated `<VadIndicator>` (dot + label) so the inspector sees the same Active/Dozing/Sleeping/Idle signal iOS shows. |
| recording/vadindicatorview-1 | `VADIndicatorView.swift:L1-L27` coloured circle (idle/listening/speaking/trailing) pulse | `web/src/components/recording/vad-indicator.tsx` | match |  |  | Phase 8 landed the dedicated dot-with-ring indicator. Pulse honours prefers-reduced-motion via the global CSS guard. |
| recording/waveformview | `WaveformView` | `recording-chrome.tsx:L282-L308` VuMeter (24 bars) | match |  |  | Different algorithm but same role (mic-level vis). |
| recording/processingbadgeview-5 | `ProcessingBadgeView.swift:L5-L25` "Processing Audio (N)" animated badge | `web/src/components/recording/processing-badge.tsx` | match |  |  | Phase 8 added the badge — driven off `processingCount` in recording-context (transcripts sent to Sonnet minus extraction/question replies observed). Hidden at zero. |
| recording/pendingdatabanner-1 | `PendingDataBanner.swift:L1-L20` "N unassigned readings" warning | `web/src/components/recording/pending-data-banner.tsx` | match |  |  | Phase 8 shipped the banner — count increments off Sonnet `validation_alerts`. Dismissal lives alongside the alert card. |
| recording/alertcardview-1 | `AlertCardView.swift:L1-L60+` non-blocking validation alert card (C1/C2/C3 severity icon + Yes/No/Dismiss + queued count) | `web/src/components/recording/alert-card.tsx` | partial |  | 8 | Phase 8 landed the question stack with Dismiss + "+N more" queue badge. Yes/No inline response buttons are still iOS-only — the web client relies on the inspector voice-answering into the transcript (which Sonnet picks up anyway). Follow-up: wire tap-Yes/No back into `SonnetSession.sendCorrection`. |
| recording/transcriptstripview-35 | `TranscriptStripView.swift:L35-L100` pulsing dot + horizontal transcript + latest confirmed field badge | `web/src/components/recording/transcript-bar.tsx:L24-L100+` top-docked transcript bar with pulse + interim italic | partial |  | 8 | Web keeps rolling transcript tail; iOS focuses on the LAST line with highlight flash when a field confirms. Similar intent, different edge behaviour. |
| recording/transcript-highlight-flash-keyword-spotlight | Transcript highlight flash (keyword spotlight + colour) — `TranscriptStripView.swift:L94+` highlights array | MISSING (defer — cosmetic) | partial |  | 9 | Phase 9 defer: the confirmed-field flash on the `<LiveFillView>` overlay is the primary confirmation feedback inspectors use. The transcript-keyword flash is a secondary cue that iOS shows; closing the gap on web would require a keyword-range highlighter in the transcript bar without clear user benefit. Raise separately if inspectors request it. |
| recording/livefillview-1 | `LiveFillView.swift:L1-L1554` full-form live dashboard with compact landscape layout | `web/src/components/live-fill/live-fill-view.tsx:L1-L60+` equivalent overlay | partial |  | 8 | Web LiveFillView covers most sections (installation / supply / board / circuits / observations) but lacks iOS-specific: CCU slot crops tap-to-correct grid (`LiveFillView.swift:L44-L47`), per-section compact horizontal layout, "purpose of report" picker sheet, inline general-condition picker. |
| recording/livefillview-44 | `LiveFillView.swift:L44-L47` `ccuSlotsSection` tap-to-correct for geometric extraction crops | MISSING (defer — requires geometric CCU pipeline) | partial |  | 9 | Phase 9 defer: requires the geometric CCU extraction pipeline (slot crops as individual images) which isn't built yet. Web's Phase 7 CCU flow uses a whole-image model. Raise separately when the geometric pipeline ships. |
| recording/livefillview-12 | `LiveFillView.swift:L12-L14` showGeneralConditionPicker / showPurposeOfReportPicker / showInstallationTypePicker sheets | MISSING (defer — live-fill overlay is non-interactive on web) | partial |  | 9 | Phase 9 defer: web's `<LiveFillView>` is a display overlay — fields are edited on the underlying tab, not inside the overlay. Adding interactive pickers mid-recording would conflict with the dictation flow. Closed as intentional web UX divergence. |
| recording/debugdashboardview-22 | `DebugDashboardView.swift:L22-L60` hidden debug dashboard (triple-tap Settings version) with Live / Regex / Sonnet / Stats tabs | `/settings/debug` (Phase 6) | partial |  | 9 | Phase 6 shipped a developer-only Debug Dashboard at `/settings/debug` gated by NODE_ENV + the About-page toggle. It covers IDB row counts, SW registration, auth-token masking, raw diagnostics JSON — but not iOS's Live / Regex / Sonnet / Stats live-session panes. Phase 9 defer: those panes tail the in-process recording pipeline, which isn't a persistent surface the web dev tools can snoop cleanly. Follow-up: standalone recording-session replay viewer if inspectors ever request session forensics. |
| recording/voice-command-executor-e-g-move | Voice command executor (e.g. "move to circuit 5", "set OCPD to 32A") | `packages/shared-utils/src/voice-commands.ts` + wired in `recording-context.tsx` | partial |  | 8 | Phase 8 ported the MVP dispatcher: `update_field`, `reorder_circuits`, `query_field`. Punted: `add_circuit`, `delete_circuit`, `calculate_impedance` (already accessible from Circuits tab menu), `query_summary`. Parser grammar is intentionally narrow — Sonnet still handles freeform dictation. |
| recording/x-xx | Cost bar / cost pill — `£~X.XX` during recording | `recording-chrome.tsx` formatCost + formatElapsed | match |  |  | Phase 8 switched the `$` prefix to `£~` to match iOS (UK-only inspector base; USD/GBP difference at pence-level is within the cost display's rounding noise). |
| recording/formatelapsed | `formatElapsed` timer during recording | recording-chrome.tsx same | match |  |  |  |
| recording/3-tier-sleep-active-dozing | 3-tier sleep (Active / Dozing / Sleeping) indicator | `recording-chrome.tsx:L240-L266` state-pill supports dozing/sleeping | match |  |  |  |
| recording/recording-chrome-tsx-l41-l49 | `recording-chrome.tsx:L41-L49` RecordingRing (pulsing border around page) — keeps page visible during recording | iOS keeps overlay floating over the page | match |  |  | Different visual treatment; both communicate "recording in progress" — no gap. |
| recording/recording-chrome-tsx | `recording-chrome.tsx` Voice button `disabledReason="Voice prompts are iOS-only for now."` | covered above | match |  |  | Phase 8 flipped the button from disabled to an active toggle. |
| recording/recording-chrome-tsx-2 | `recording-chrome.tsx` Apply button `disabledReason="Apply-last-snapshot is iOS-only for now."` | `recording-chrome.tsx` (disabled) | partial |  | 9 | Phase 9 defer: Apply-last-snapshot depends on per-job snapshot history that isn't in the data model. Rolls up with the RecordingOverlay Defaults buttons above — the Apply Defaults path via the Circuits tab action rail covers the fill-empty-from-user-defaults case, which is what inspectors actually want this button to do. |
| recording/recording-context-tsx | `recording-context.tsx` sonnet-session + deepgram-service + mic-capture + resample + audio-ring-buffer + sleep-manager | iOS `DeepgramRecordingViewModel` + `DeepgramService` + `SonnetStreamingSession` | partial | 2026-07-02 | WS3 | UPDATED 2026-07-02 (WS3 shipped): capability advertising (pending prod verification), TranscriptGate, gate-pass chime, read-back dedupe re-key all landed. UPDATED 2026-07-06: FIFO TTS (item 8, `recording/tts-fifo`) + `cancel_pending_tts` (`recording/cancel-pending-tts`) shipped. Remaining WS3-FU gaps — fast-path TTS (item 4), playback telemetry (item 5) — owned by `parity-ws3b-voice-latency-2026-07`. UPDATED 2026-07-08 (A2, sess_mrbnds2d_jczh): orphan classifier now ports the iOS `supplyFields` rescue (`non-circuit-fields.ts`, verbatim copy of `DeepgramRecordingViewModel.swift:10031-10087`) — section fields (client_name etc.) are never buffered for a circuit-disambiguation ask; diagnostic `non_circuit_field_rescued_from_buffer` mirrors iOS `supply_field_rescued_from_buffer`. Accepted cross-repo drift: the set is a literal copy; web drift guard (`non-circuit-fields.test.ts`) covers web route drift only. |

---

## Settings hub

Profile + company + team + defaults + account + app + danger zone.

iOS sources:

- `CertMateUnified/Sources/Views/Settings/SettingsHubView.swift`
- `CertMateUnified/Sources/Views/Settings/SettingsView.swift`
- `CertMateUnified/Sources/Views/Settings/ChangePasswordView.swift`
- `CertMateUnified/Sources/Views/CompanyDetails/CompanyDetailsView.swift`
- `CertMateUnified/Sources/Views/Inspector/InspectorListView.swift`
- `CertMateUnified/Sources/Views/Inspector/InspectorDetailView.swift`
- `CertMateUnified/Sources/Views/Admin/AdminUsersListView.swift`
- `CertMateUnified/Sources/Views/Admin/AdminCreateUserView.swift`
- `CertMateUnified/Sources/Views/Admin/AdminEditUserView.swift`
- `CertMateUnified/Sources/Views/Admin/AdminQueueView.swift`
- `CertMateUnified/Sources/Views/Admin/AdminStatsView.swift`
- `CertMateUnified/Sources/Views/Admin/CompanyDashboardView.swift`
- `CertMateUnified/Sources/Views/Admin/InviteEmployeeView.swift`
- `CertMateUnified/Sources/Views/Defaults/DefaultsManagerView.swift`
- `CertMateUnified/Sources/Views/Defaults/DefaultValuesView.swift`
- `CertMateUnified/Sources/Views/Defaults/CableSizeDefaultsView.swift`
- `CertMateUnified/Sources/Views/Defaults/ApplyDefaultsSheet.swift`
- `CertMateUnified/Sources/Views/AudioImport/AudioImportView.swift`
- `CertMateUnified/Sources/Views/Launch/TermsAcceptanceView.swift`

### Profile + routing

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-profile/settingshubview-51 | `SettingsHubView.swift:L51-L105` profile hero (gradient avatar circle + name + email + role badges) | `web/src/app/settings/page.tsx:L67-L94` | match |  |  |  |
| settings-profile/settingshubview-81 | `SettingsHubView.swift:L81-L86` role badges (system role + company role) | `settings/page.tsx:L84-L92` RoleBadge | match |  |  |  |
| settings-profile/settingshubview-109 | `SettingsHubView.swift:L109-L149` Company & Team section (4 rows when admin) | `settings/page.tsx:L105-L139` split into TEAM + COMPANY | match |  |  |  |
| settings-profile/settingshubview-113 | `SettingsHubView.swift:L113-L118` Company Details row | `settings/page.tsx:L119-L129` /settings/company | match |  |  |  |
| settings-profile/settingshubview-122 | `SettingsHubView.swift:L122-L126` Staff Management row | `settings/page.tsx:L106-L113` /settings/staff | match |  |  |  |
| settings-profile/settingshubview-133 | `SettingsHubView.swift:L133-L137` Company Dashboard row (isCompanyAdmin gated) | `settings/page.tsx:L130-L138` /settings/company/dashboard | match |  |  |  |
| settings-profile/settingshubview-141 | `SettingsHubView.swift:L141-L145` Invite Employee row | `/settings/invite` (Phase 6) + existing company dashboard dialog | match |  | 6 | Phase 6: dedicated `/settings/invite` route mirrors iOS's nav entry. Shares the same `api.inviteEmployee` contract (POST `/api/companies/:companyId/invite`) and the one-shot temp-password reveal pattern as the company dashboard invite sheet. Role-gated on `isCompanyAdmin`. |
| settings-profile/settingshubview-154 | `SettingsHubView.swift:L154-L174` Certificate Defaults section (Cable Size Defaults + Default Values) | `settings/page.tsx` → `/settings/defaults` hub | match |  | 6 | Phase 6: hub route splits to `/settings/defaults/values` (Default Values) + `/settings/defaults/cable` (Cable Size Defaults). Defaults persist to `/api/settings/:userId/defaults`; Circuits tab now threads `userDefaults` through `applyDefaultsToCircuits` so saved presets fill empty fields on Apply Defaults. |
| settings-profile/settingshubview-179 | `SettingsHubView.swift:L179-L191` Account section: Change Password | `/settings/change-password` | match |  | 6 | Phase 6: 3-input form (current / new / confirm) with show-hide toggles, client validation (≥ 8 chars, new !== current, match), `api.changePassword` → `PUT /api/auth/change-password`. 401 surfaces the backend "current password is incorrect" copy inline; success card + 2s redirect to `/settings`. |
| settings-profile/settingshubview-196 | `SettingsHubView.swift:L196-L235` App section: Audio Import / Terms & Legal / Version row | partial — `/settings/about` landed; Audio Import + Terms deferred | partial |  | 6 | Phase 6: About page lands with version (`NEXT_PUBLIC_APP_VERSION`), acknowledgments, and the debug-mode toggle that gates the Debug Dashboard. Audio Import + Terms remain iOS-only / deferred (see rows below). |
| settings-profile/settingshubview-200 | `SettingsHubView.swift:L200-L205` Audio Import → `AudioImportView` | MISSING | ios-only |  | 6 | iOS test affordance only (file picker into Deepgram). Not a web requirement; inspectors record via the live pipeline on web. |
| settings-profile/settingshubview-209 | `SettingsHubView.swift:L209-L213` Terms & Legal → `TermsAcceptanceView` | MISSING (handled at signup) | partial |  | 9 | Phase 9 defer: web handles terms acceptance at signup; a settings-level re-read surface is low priority and not a compliance blocker. SUPERSEDED IN PART 2026-07-02: Derek decided 2026-07-01 to PORT the iOS T&Cs signature capture to the web terms gate — WS7 (`crosscutting/terms-signature-port`). The settings re-read surface itself remains deferred. |
| settings-profile/settingshubview-217 | `SettingsHubView.swift:L217-L231` Version row (non-navigable, shows app version + blue pill) | `/settings/about` Version card | match |  | 6 | Phase 6: shown on the About page with build + environment. No triple-tap — the Debug Dashboard is gated by the About-page toggle instead. |
| settings-profile/debugdashboardview | `DebugDashboardView.swift` hidden debug dashboard | `/settings/debug` (gated on NODE_ENV !== 'production' OR `cm-debug=1`) | match |  | 6 | Phase 6: dev-only dashboard with masked auth token, per-store IDB row counts, SW registration list, raw diagnostics JSON. Hub row only renders when the About toggle has flipped the flag. |
| settings-profile/settingshubview | `SettingsHubView.swift` / support flow | `/settings/diagnostics` | match |  | 6 | Phase 6: Export Diagnostics (JSON download + copy-to-clipboard with SENSITIVE_PATTERN redaction) + Clear Cache (SW unregister, IDB delete, storage clear, /login redirect — gated by ConfirmDialog). |
| settings-profile/settingshubview-240 | `SettingsHubView.swift:L240-L270` Danger Zone — Log Out (red pill) | `settings/page.tsx:L175-L182` Button ghost | match |  |  |  |
| settings-profile/settings-offline-sync-web-only | Settings → Offline Sync (web-only) | `settings/page.tsx:L146-L160` conditionally-rendered | ios-only |  |  | PWA-only IDB outbox admin page; no iOS counterpart (iOS offline uses Core Data). |
| settings-profile/settings-administration-manage | Settings → Administration → Manage Users (system admin only) | `settings/page.tsx:L163-L173` gated | match |  |  |  |
| settings-profile/components-pwa-ios-install-hint-tsx | `components/pwa/ios-install-hint.tsx` Add-to-Home-Screen hint | `settings/page.tsx:L102` IOSInstallHint | match |  |  | Phase 7b. iOS has no equivalent (is the app). |

### Company details page

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-company/companydetailsview-14 | `CompanyDetailsView.swift:L14-L56` company hero header + info / address / contact / logo / warnings / save button | `web/src/app/settings/company/page.tsx` | match |  |  |  |
| settings-company/company-name-registration | Company name + registration + VAT fields | ports on web present (per page structure) | match |  |  |  |
| settings-company/logo-upload-via-photospicker | Logo upload via PhotosPicker | `components/settings/logo-uploader.tsx` | match |  |  |  |
| settings-company/validation-warnings-section | Validation warnings section | web equivalent exists via save flow | match |  |  |  |
| settings-company/companydetailsviewmodel-load | `CompanyDetailsViewModel.load()` on appear | `settings/company/page.tsx` useEffect fetch | match |  |  |  |

### Staff (inspector) list + detail

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-staff/inspectorlistview | `InspectorListView.swift` gradient hero + stacked avatars + count, card list, swipe-to-delete, empty state with Add | `web/src/app/settings/staff/page.tsx` | match |  |  |  |
| settings-staff/inspectordetailview-1 | `InspectorDetailView.swift:L1-L60+` profile header + name section + signature + position + default toggle + test equipment with 5 instrument rows | `web/src/app/settings/staff/[inspectorId]/page.tsx` | match |  |  | Based on line count (418) — full port confirmed. |
| settings-staff/signaturecaptureview | Signature capture (`SignatureCaptureView.swift`) | `components/settings/signature-canvas.tsx` | match |  |  | Custom `<canvas>` implementation. |

### Admin (system admin)

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-admin/adminuserslistview-1 | `AdminUsersListView.swift:L1-L253` paginated users list with role + company-role + status pills | `web/src/app/settings/admin/users/page.tsx:L1-L293` | match |  |  |  |
| settings-admin/admincreateuserview-1 | `AdminCreateUserView.swift:L1-L274` new-user form (name/email/password/companyName/role/companyRole/selectedCompany) | `web/src/app/settings/admin/users/new/page.tsx:L1-L219` | partial |  | 6 | Web takes plain `companyId` input; iOS has a Company picker populated from `/api/companies`. Web's "companyId is free-form UUID — deferred" note confirms the gap. |
| settings-admin/adminedituserview-1 | `AdminEditUserView.swift:L1-L524` edit user details + role + active toggle + reset password + unlock | `web/src/app/settings/admin/users/[userId]/page.tsx:L1-L653` | match |  |  |  |
| settings-admin/adminedituserview-25 | `AdminEditUserView.swift:L25-L30` Reset Password flow (new password input + API call) | covered by web page | match |  |  |  |
| settings-admin/adminedituserview-32 | `AdminEditUserView.swift:L32-L33` Deactivate/Reactivate confirm | covered by web page | match |  |  |  |
| settings-admin/adminedituserview-33 | `AdminEditUserView.swift:L33` Unlock confirm (after failed login lockouts) | covered by web page | match |  |  |  |
| settings-admin/adminqueueview-1 | `AdminQueueView.swift:L1-L451` admin queue (pending jobs / retry / failures) | MISSING (PWA wire-up follow-up) | partial |  | 9 | Ledger-fix 2026-04-24: the backend endpoints already exist — `GET /api/admin/queue/status` and `GET /api/admin/queue/health` in `src/admin_api.js:59,72`. iOS calls these via `APIClient.adminGetHealth()` at `APIClient.swift:551`. The PWA just needs a page that hits them. Reclassified from `backend` (blocking on backend) to `partial` (PWA-only wire-up). Failure-replay mutation (iOS "retry failed job" button) is a separate, smaller concern — can start with read-only view. |
| settings-admin/adminstatsview-1 | `AdminStatsView.swift:L1-L305` admin stats dashboard (totals / charts / breakdowns) | `web/src/app/settings/company/dashboard/page.tsx` stats tab (company-only) | partial |  | 9 | Ledger-fix 2026-04-24: backend endpoint `GET /api/admin/stats` already exists (`src/admin_api.js:85`); iOS consumes it via `APIClient.adminGetStats()` at `APIClient.swift:547`. PWA just needs a system-wide admin stats page that calls it (company stats page covers the company-scoped case). Pure PWA follow-up. |
| settings-admin/companydashboardview-1 | `CompanyDashboardView.swift:L1-L583` Jobs / Team / Stats tabs + invite employee dialog | `web/src/app/settings/company/dashboard/page.tsx:L1-L671` | match |  |  |  |
| settings-admin/inviteemployeeview-1 | `InviteEmployeeView.swift:L1-L248` invite form (name/email/auto-gen password surfaced once) | Merged into Company Dashboard Team tab in web | match |  |  |  |

### Defaults management

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-defaults/defaultsmanagerview-1 | `DefaultsManagerView.swift:L1-L272` list of certificate presets + add/edit/delete | `/settings/defaults` hub page | match |  | 6 | Phase 6: hub splits into Default Values + Cable Size editors. UPDATED 2026-07-02: the "single global defaults blob / named presets deferred" claim is STALE — web now has named `CertificateDefaultPreset` records + `cable_defaults[]` (`web/src/lib/defaults/{types,service,hooks}.ts`, verified) persisted under the existing settings endpoint. Remaining gap is the job-creation auto-apply/picker flow only — WS6 (`dashboard/job-creation-defaults-flow`). |
| settings-defaults/defaultvaluesview-1 | `DefaultValuesView.swift:L1-L194` per-tab default-value editor with named preset save | `/settings/defaults/values` | partial |  | 9 | Phase 6: ports the high-traffic subset (max disconnect time, IR voltage, RCD operating current, polarity, OCPD type, breaking capacity, wiring + ref method) rather than every tab's every field. Per-tab surface deferred — most inspectors only ever preset the Test-Readings bundle. (UPDATED 2026-07-02: the named-preset model now exists on web — see the DefaultsManager row above; the open work is the WS6 job-creation flow, not preset CRUD plumbing.) |
| settings-defaults/cablesizedefaultsview-1 | `CableSizeDefaultsView.swift:L1-L212` cable CSV defaults by OCPD rating + material + ref method | `/settings/defaults/cable` | match |  | 6 | Phase 6: per-type (lighting / socket / cooker / shower / immersion) editor for live CSA, CPC CSA, OCPD rating, OCPD type. Scoped keys (`{type}.live_csa_mm2` etc.) persist for iOS parity; web reads fall back to schema defaults (non-overwrite invariant guards against stomping inspector edits). |
| settings-defaults/applydefaultssheet-1 | `ApplyDefaultsSheet.swift:L1-L95` "Apply these defaults to this job?" confirmation | `job/[id]/circuits` "Apply Defaults" button | match |  | 6 | Phase 5 wired the Circuits action; Phase 6 threads `userDefaults` through `useUserDefaults` → `applyDefaultsToCircuits`. IDB-cached so offline Apply-Defaults sees the user's saved values. No separate confirmation sheet — the action is already one tap, iOS's sheet was "sure you want to do it?" which is friction we skipped on web. |

### Change password

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-password/changepasswordview-1 | `ChangePasswordView.swift:L1-L60+` current + new + confirm + strength meter + show/hide toggles | `/settings/change-password` | match |  | 6 | Phase 6: 3 password inputs with per-field show/hide eye toggle; `PUT /api/auth/change-password` on submit; backend 401 surfaces as inline banner ("Current password is incorrect") without form reset. Success → green confirmation card, 2s router.push('/settings'). |
| settings-password/changepasswordview-41 | `ChangePasswordView.swift:L41-L55` password strength (0-4) calculation | Not implemented | ios-only |  | 9 | Deferred: iOS surfaces a 0–4 strength bar; web uses a stricter minimum (≥ 8 chars rather than iOS's ≥ 6) as the single gate. If inspectors request the meter, port in Phase 9. |
| settings-password/changepasswordview | `ChangePasswordView.swift` keyboard focus fluidity (FocusState) | Native Tab-key flow | partial |  | 9 | Phase 9 defer: web's native Tab-key flow + autocomplete hints cover the fluidity case inspectors actually need. Explicit `autoFocus` on the Enter-to-next field transitions is an iOS affordance that a browser can't replicate precisely without trapping Tab — closed as an intentional platform divergence. |

### App → Audio Import + Terms

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| settings-app/audioimportview | `AudioImportView.swift` import existing audio recording into Deepgram pipeline | MISSING (iOS test affordance) | ios-only |  | 9 | Phase 9: closed as `ios-only` — iOS includes AudioImport as a test affordance (load a pre-recorded WAV into the live pipeline for QA). Web uses direct mic capture only; importing an audio file into the live Sonnet conversation would bypass the VAD / sleep state machine. Not an inspector-facing requirement. |
| settings-app/termsacceptanceview | `Views/Launch/TermsAcceptanceView.swift` + `Views/Launch/LegalTexts.swift` | MISSING (handled at signup) | partial |  | 9 | Phase 9 defer: terms acceptance happens at signup (web registration flow); re-reading the terms inside the app is a low-value surface. SUPERSEDED IN PART 2026-07-02: the signature-capture half is now WS7 work (`crosscutting/terms-signature-port`, Derek 2026-07-01). |

---

## Cross-cutting

Hero headers, section-card accents, skeletons, confirmations, empty states, offline banners, PWA install hints, service-worker update.

iOS sources:

- `CertMateUnified/Sources/Views/Components/CMSectionCard.swift`
- `CertMateUnified/Sources/Views/Components/CertMateComponents.swift`
- `CertMateUnified/Sources/Views/Components/CertMateDesign.swift`
- `CertMateUnified/Sources/Views/Components/CMFloatingTextField.swift`
- `CertMateUnified/Sources/Views/Components/CMFloatingPicker.swift`
- `CertMateUnified/Sources/Views/Components/CMUnitTextField.swift`
- `CertMateUnified/Sources/Views/Components/CMDatePickerField.swift`
- `CertMateUnified/Sources/Views/Components/DataArrivalFlash.swift`
- `CertMateUnified/Sources/Views/Components/StatusBadge.swift`
- `CertMateUnified/Sources/Views/Components/TypingText.swift`
- `CertMateUnified/Sources/Views/Components/SignatureCaptureView.swift`
- `CertMateUnified/Sources/Views/Components/PhotoCaptureView.swift`
- `CertMateUnified/Sources/Views/Components/PhotoPickerView.swift`
- `CertMateUnified/Sources/Views/Components/OfflineBanner.swift`
- `CertMateUnified/Sources/Views/Components/OutcomeButtonGroup.swift`

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| crosscutting/certmatedesign | `CertMateDesign.swift` — colour tokens (brandBlue/brandGreen/dark surfaces/gradients/shadows/animations) | `web/src/lib/design-tokens.ts` + `globals.css` CSS vars | match |  |  |  |
| crosscutting/cmsectioncard | `CMSectionCard.swift` — gradient-bordered card with category-coded accent | `web/src/components/ui/section-card.tsx` | match |  |  | Phase 1 — added iOS-parity category accents (client/electrical/board/test-results/schedule/notes/protection) driven by `SECTION_ACCENTS` token map in `lib/constants/section-accents.ts`. |
| crosscutting/hero-gradient-blue-green-or-green-blue | Hero gradient (blue→green or green→blue) used on every tab header | web tab pages render equivalent gradients + `components/ui/hero-header.tsx` | match |  |  | Phase 1 — reusable `HeroHeader` primitive with breathing radial glow (respects `prefers-reduced-motion`). Accepts the same `SectionAccent` token set as `SectionCard`. |
| crosscutting/cmstaggeredentrance-index-appeared | Staggered section entrance (`cmStaggeredEntrance(index:appeared:)`) | `globals.css` `.cm-stagger-in` / `.cm-stagger-children` utilities | match |  | 9 | Phase 9: ported as a CSS-only utility (no framer-motion dependency). Applying `cm-stagger-children` to a flex column cascades `nth-child(1..12)` delays (0..440ms) so SectionCards fade+rise into place. Every job tab container (installation, supply, board, circuits, design, extent, staff, inspection, observations, pdf) now wears the class. Honours `prefers-reduced-motion` — the animation collapses to a no-op. |
| crosscutting/dataarrivalflash | Data-arrival flash (`DataArrivalFlash.swift`) — blue flash when Sonnet fills a field | `web/src/components/live-fill/live-field.tsx` + `globals.css` `.cm-live-field` | match |  | 9 | Phase 9 confirm: verified the `.cm-live-field[data-recent="true"]` rule still fires across every tab after the Phase 4-8 surgery. Phase 8 voice-command + Phase 7 CCU/doc-extraction paths both flow through `liveFillStore.setRecent()` so new-in-phase fields inherit the flash automatically. |
| crosscutting/cmfloatingtextfield | `CMFloatingTextField` floating-label input | `web/src/components/ui/floating-label-input.tsx` | match |  |  |  |
| crosscutting/cmfloatingpicker | `CMFloatingPicker` | `web/src/components/ui/select-chips.tsx` + `labelled-select.tsx` | match |  |  |  |
| crosscutting/cmunittextfield | `CMUnitTextField` (text with trailing unit) | `web/src/components/ui/floating-label-input.tsx` `trailing` slot | match |  |  | Used in Supply tab for Ω / V / A / kA. |
| crosscutting/cmdatepickerfield | `CMDatePickerField` | `<input type="date">` native | match |  |  |  |
| crosscutting/signaturecaptureview | `SignatureCaptureView` | `web/src/components/settings/signature-canvas.tsx` | match |  |  |  |
| crosscutting/photocaptureview | `PhotoCaptureView` (fullScreenCover native camera) | `<input type="file" accept="image/*" capture="environment">` | ios-only |  |  | Different native affordance — web equivalent is acceptable. |
| crosscutting/photopickerview | `PhotoPickerView` (PhotosPicker) | `<input type="file">` | ios-only |  |  | iOS-native primitive; web file input is the equivalent. |
| crosscutting/statusbadge | `StatusBadge` (valid/expired/expiring/pending coloured pills) | `web/src/components/ui/pill.tsx` | match |  |  |  |
| crosscutting/outcomebuttongroup | `OutcomeButtonGroup.swift` (✓/✗/N/A/LIM/C1/C2/C3/FI chip row) | inlined in `inspection/page.tsx` ScheduleRow | match |  |  |  |
| crosscutting/typingtext | `TypingText.swift` typing animation | N/A (tour narration silent on web) | partial |  | 9 | Phase 9 defer: web's Phase 3 tour is silent (no TTS narration) so there's no subtitle text to animate. Rolls up with the "TourManager TTS narration" row — if that lands later, TypingText becomes a paired follow-up. Not a standalone blocker. |
| crosscutting/offlinebanner | `OfflineBanner.swift` (top of dashboard when offline) | `web/src/components/pwa/offline-indicator.tsx` + `<OfflineBanner />` (`< md`) | match |  | 9 | Phase 9: closed — mobile viewports (`< md`) now render the full-width banner matching iOS shape; desktop keeps the inline header pill because the banner would push authenticated-page content below a 64-px bar on every route. See OfflineIndicator row above. |
| crosscutting/skeleton-shimmer-dashboard-loading | Skeleton shimmer (dashboard loading) | `globals.css` `.cm-shimmer` + `dashboard/page.tsx:L225-L233` + `components/ui/skeleton-row.tsx` | match |  |  | Phase 1 — reusable `SkeletonRow` primitive wrapping the existing `.cm-shimmer` keyframes with `role="status"` + `aria-busy`. |
| crosscutting/job-deletion-confirmation-alert-universally | Job-deletion confirmation alert (universally) | `components/dashboard/job-row.tsx` + per-circuit + observations + board-remove + pdf-discard + admin-deactivate + staff-remove all `ConfirmDialog` | match |  | 9 | Phase 9: audited every destructive handler — dashboard job delete (P3), alerts-page job delete (P3), per-circuit trash (P9 new), delete-all-circuits (P5), observation delete (P4), board remove-with-cascade (P4), PDF discard (P2), admin deactivate / unlock (P6), staff delete (P6), outbox discard (P7). All route through `ConfirmDialog` (destructive variant fires haptic pulse via Phase 9 `lib/haptic.ts`). |
| crosscutting/components-ui-confirm-dialog-tsx | `components/ui/confirm-dialog.tsx` | reused in Settings outbox discard | match |  |  | Phase 1 — added `destructive` ergonomic alias + internal async-promise busy tracking so destructive actions can't double-fire while the mutation is in flight. |
| crosscutting/tally-badge-primitive-observations-totals-phase | Tally-badge primitive (Observations totals, Phase 3 Alerts bell) | `components/ui/tally-badge.tsx` | match |  |  | Phase 1 — count+label pill with severity variants (destructive/warn/info/muted/success) mapped to the existing `--color-severity-*` tokens. |
| crosscutting/brand-logo | Brand logo | `components/brand/logo.tsx` | match |  |  |  |
| crosscutting/tab-bar-sidebar-navigation | Tab bar / sidebar navigation shell | `components/layout/app-shell.tsx` | match |  |  |  |
| crosscutting/job-header-back-title | Job header (back + title + menu) | `components/job/job-header.tsx` | partial |  | 4 | Menu missing (see Overview tab). |
| crosscutting/job-tab-nav-pill-bar | Job tab nav pill bar | `components/job/job-tab-nav.tsx` | match | 2026-07-02 |  | Gating re-verified 2026-07-02 (see `overview/ios-tab-model-one-tab`). |
| crosscutting/floating-mic-fab-when-idle | Floating mic FAB when idle | `components/job/floating-action-bar.tsx` | match |  |  |  |
| crosscutting/recording-context-tsx | `recording-context.tsx` sonnet+deepgram plumbing | Already shipped Phase 4 | match |  |  |  |
| crosscutting/uiimpactfeedbackgenerator | Haptic feedback on taps (`UIImpactFeedbackGenerator`) | `web/src/lib/haptic.ts` + `ConfirmDialog` confirm + WS7: `haptic('heavy')` gate-pass (`recording-context.tsx`) & `haptic('light')` job tab-rail (`job-tab-nav.tsx`) | partial | 2026-07-03 | 9 | Phase 9: best-effort `haptic()` wrapper over `navigator.vibrate()` (Chrome/Firefox Android only; iOS Safari + desktop no-op silently). WS7 (2026-07-03) added the two live iOS `UIImpactFeedbackGenerator` sites: heavy on the gate-pass "sent for processing" beat (mirrors `DeepgramRecordingViewModel.playChime()`) and light on every job tab-rail tap (`JobDetailView.swift:190`); `AppTabBar.swift` is legacy (no web app-bar) so no app-shell haptic. STAYS `partial` PERMANENTLY (NOT flipped to `match` after device smoke): iPhone Safari genuinely has no Vibration API, so the iOS Taptic experience cannot be matched on an iPhone A2HS PWA — an ACCEPTED platform divergence (parent §6 item 4). Wiring proven by `ws7-haptic-call-sites.test.tsx`. |
| crosscutting/environment-accessibilityreducemotion | Reduce-motion respect (`@Environment(\.accessibilityReduceMotion)`) | `globals.css` `@media (prefers-reduced-motion: reduce)` — now pervasive | match |  | 9 | Phase 9 audit: the global reducer in `globals.css:L219-L228` collapses every `animation-duration` and `transition-duration` to 0.01ms under `prefers-reduced-motion: reduce`, plus per-feature null-outs on `.cm-live-field` / `.cm-live-section` / `.cm-rec-ring` / `.cm-dialog-*` / `.cm-stagger-in` / `.cm-stagger-children`. Phase 9 verified every new animation (stagger, hero glow) honours the preference. |
| crosscutting/components-pwa-install-button-tsx | `components/pwa/install-button.tsx` — Add to Home Screen button | `components/pwa/install-prompt-provider.tsx` | ios-only |  |  | Web-only (iOS is a native app). |
| crosscutting/components-pwa-sw-update-provider-tsx | `components/pwa/sw-update-provider.tsx` — service-worker update notification | — | ios-only |  |  | Web-only. |
| crosscutting/components-pwa-offline-indicator-tsx | `components/pwa/offline-indicator.tsx` | — | ios-only |  |  | iOS uses `OfflineBanner`. |
| crosscutting/components-ui-numeric-stepper-tsx | `components/ui/numeric-stepper.tsx` | MISSING iOS equivalent (iOS uses Picker) | ios-only |  |  | Web-specific affordance. |
| crosscutting/components-ui-segmented-control-tsx | `components/ui/segmented-control.tsx` | `Picker(.segmented)` iOS | match |  |  |  |
| crosscutting/components-ui-select-chips-tsx | `components/ui/select-chips.tsx` | `CMFloatingPicker` or `Picker(.segmented)` | match |  |  |  |
| crosscutting/components-ui-floating-label-input-tsx | `components/ui/floating-label-input.tsx` | `CMFloatingTextField` | match |  |  |  |
| crosscutting/components-ui-multiline-field-tsx | `components/ui/multiline-field.tsx` | `TextField(axis:.vertical, lineLimit:)` | match |  |  |  |
| crosscutting/components-ui-icon-button-tsx | `components/ui/icon-button.tsx` 44×44 hit target primitive (Wave 4 D8) | iOS uses native Button with frame(minHeight: 44) | match |  |  | Ensures WCAG 2.1 AA touch target. |

---

---

## Parity-program sweep — 2026-07-02 (WS0)

Rows added by the 2026-07-02 WS0 audit (parent program: `~/.claude/handoffs/EICR_Automation--ios-web-full-parity-program-2026-07-01/PLAN-final.md` §3; wire-shape input: `web/audit/ws3-checklist-2026-07.md`). Pre-sweep ledger row count: **367**. Workstream assignments (WS2–WS9) are recorded in the phase column; `web/audit/INDEX-2026-07.md` is the gap index.

Deliberately NOT added (parent §3E non-gaps): regex does NOT pre-create circuits on either platform (`applyRegexMatches` ignores `result.newCircuits`; circuit creation is Sonnet-only via `create_circuit`); auto-derivations are unspoken by design; the iOS CCU-photo double-persist (`JobDetailView.swift:1291-1303` vs `:1312-1324`) is an iOS bug to log, NOT to replicate; fuzzy/edit-distance Deepgram garble correction is rejected project-wide (curated equal-weight keyterms are the only sanctioned correction mechanism). Existing iOS-only platform-capability rows remain ACCEPTED divergences (parent §6 item 4) — only closest-web-equivalent work where §3D calls for it (WS7).

| id | ios-ref | web-ref | status | last-verified | phase | notes |
|---|---|---|---|---|---|---|
| recording/capability-advertising | `ServerWebSocketService.swift:304-306` sends `["regex_fast_v2","client_playback_telemetry","low_conf_readback_v1"]` | web `session_start` sends `capabilities: { voice_latency: { version: 1, supports: ['low_conf_readback_v1'] } }` (`VOICE_LATENCY_SUPPORTS`, `sonnet-session.ts`; wire shape pinned by test) | partial | 2026-07-02 | WS3 | SHIPPED 2026-07-02 — **PENDING PRODUCTION VERIFICATION** (two-phase rule): flips to `match` only after a post-deploy authenticated web session shows `low_conf_readback_v1` in CloudWatch `voice_latency.startup_log`. Verified pre-advertise: web has NO local reading-confidence drop filter. `regex_fast_v2`/`client_playback_telemetry` deliberately NOT claimed — owned by WS3-FU `parity-ws3b-voice-latency-2026-07`. |
| recording/flux-migration | `DeepgramService.swift:608` `sttModel = .flux`; `:1684` `/v2/listen` `flux-general-en`; `eot_threshold=0.7`, `eot_timeout_ms=5000`, `mip_opt_out=true`; Configure w/ echo-validation; 80ms/1280-sample batcher | `web/src/lib/recording/deepgram-service.ts` — Flux path SHIPPED behind an `sttModel:'nova3'\|'flux'` selector: `buildFluxURL` (`/v2/listen`, `flux-general-en`, eot 0.7/5000, `mip_opt_out`), TurnInfo→delegate mapping, Configure w/ echo-validation + RTT, Error/Fatal/ConfigureFailure surfaced, 80ms/1280 batcher, equal-weight builder `generateFluxKeyterms` (NO `:boost`). Gated by the runtime kill-switch `DEEPGRAM_STT_MODEL` (`runtime-config.ts` + `/runtime-config` route + `ecs/task-def-frontend.json`), DEFAULT `nova3`. | partial | 2026-07-03 | WS4 | **PARTIAL/BLOCKED — Flux built, NOT the product default.** Phase-0 synthetic probe validated the keyterm mechanism (LIM garble corrected) but left insulation/trip-time INCONCLUSIVE (synthetic voice too clean); per the plan an inconclusive probe is not a full green light → do NOT curate iOS blind. iOS `default_config.json` prune HELD (needs real-audio spot check + TestFlight, surfaced to Derek — `phase0-probe-results.md`). Flux-default flip = one commit flipping `DEFAULT_STT_MODEL`+task-def to `flux` AFTER (1) the curated iOS list ships via TestFlight and (2) the real-audio check. nova-3 stays the kill-switch fallback until a NAMED nova-3-removal follow-up. NO fuzzy garble correction (parent §3E). UPDATED 2026-07-08 (A1 root cause, sess_mrbnds2d_jczh): the web Flux mapping dropped `onUtteranceEnd` on transcript-bearing `EndOfTurn` (iOS canon fires final + utterance-end) — `isInspectorSpeaking` stuck true and every FIFO confirmation deferred forever. FIXED 2026-07-08: EndOfTurn-with-transcript now fires final then utterance-end; composition regression `web/tests/flux-utterance-end-fifo-resume.test.ts`. Device ear-check pending (vault todo). |
| recording/flux-kill-switch | (no iOS analogue — iOS is Flux-only, no runtime model switch) | `web/src/app/runtime-config/route.ts` (top-level `/runtime-config`, force-dynamic, no-store, NetworkOnly in sw.ts), `web/src/lib/runtime-config.ts` (fetch once per recording session; `DEFAULT_STT_MODEL` product default vs `SAFE_STT_MODEL='nova3'` never-flip fail-safe; value normalisation), `ecs/task-def-frontend.json` `DEEPGRAM_STT_MODEL=nova3`, `.github/workflows/deploy.yml` `frontend-taskdef` deploy target | match | 2026-07-03 | WS4 | Web-only runtime kill-switch (no iOS counterpart). Frontend-infra exception to the `web/`-only rule (frontend deployment source, NOT backend) — logged in parent §7 WS4. |
| observations/obs-card-canonical-wording | `ObservationCardView.swift` renders, in order: reg ref → canonical `regulationTitle` → canonical `regulationDescription` → italic "Because …" rationale | web decodes + persists + renders all three in iOS order (`sonnet-session.ts` both paths, `apply-extraction.ts` incl. nil-on-MISS clearing, `observations/page.tsx`; duplicate dead `observation_update` case deleted) | match | 2026-07-02 | WS3 | SHIPPED 2026-07-02 (item 3). Update-MISS CLEARS stale wording (unconditional assignment, iOS parity); rationale keeps non-empty-overwrite-only. Tests: initial / update-HIT / update-MISS-clears / 2 render. |
| recording/transcript-gate | `DeepgramRecordingViewModel.swift:22-160` `TranscriptGate.shouldForward` + trigger/stopword arrays ~`:327-:430` | `web/src/lib/recording/transcript-gate.ts` FULL literal port (all branches + arrays + thresholds incl. the 2026-06-12 two-word identity threshold), wired in `dispatchFinal` before `sendTranscript` with non-mutating ask peeks | match | 2026-07-02 | WS3 | SHIPPED 2026-07-02 (item 7). Behaviour change: non-qualifying chatter stops reaching Sonnet. 17 per-branch tests + 9 wiring tests (stale-slot reject, Stage6 short answer, legacy in_response_to, regex-only never suppressed, processing-counter no-bump-on-reject). UPDATED 2026-07-08 (A3, sess_mrbnds2d_jczh): the gate's `hasRegexHit` input is now FRESHNESS-gated in the apply layer (`computeFreshRegexWrites`, value-equality vs job state hints-ON / per-session shadow hints-OFF) — cumulative-window re-hits of an unchanged value no longer chime/send on chitchat (iOS canon: `applyRegexValue` `newValue != currentValue`, DeepgramRecordingViewModel.swift:7577-7595). Known iOS quirk NOT ported: the iOS circuit-HINT loop (:5188-5210) inserts hit keys WITHOUT equality — the WS-C differ classifies that divergence WARN-with-note, not FAIL. Regression pins: `regex-freshness-gate.test.ts` (exact session sequence, both env paths). |
| recording/gate-pass-chime | `DeepgramRecordingViewModel.swift:209-232` `makeChimeWAVData` — 960 Hz / 80 ms soft-attack sine, fires ONLY on gate pass | `tones.ts` `playSentForProcessingChime()` — sample-accurate PCM AudioBuffer render (same constants/envelope), fired only on gate PASS; tour reuses the SAME helper (tour-local synth deleted) | match | 2026-07-02 | WS3 | SHIPPED 2026-07-02 (item 7). `playAttentionTone`/`playConfirmationChime` untouched (mirror different iOS sounds 1007/1025). Waveform pinned by ws6-tour-v11 tests. |
| recording/tts-fifo | `AlertManager.swift:236` serial FIFO queue (Phase 7.1): deferred ElevenLabs synth until head-of-queue, `playOrDeferQueueHead` last-mile defer, TTL/overflow drop-oldest, `purge(prefix)` cancel-key drain | `web/src/lib/recording/tts-queue.ts` (FIFO pump: last-mile deferral gate, drop-oldest MAX 6, `onDiscarded` un-record, `preemptFlush`/`purge`/`reset`) + `tts.ts` two-path split (confirmations→FIFO, `speak()`→preempting direct path) + `elevenlabs-tts.ts prepareElevenLabs` fetch/play split | match | 2026-07-06 | WS3-FU `parity-ws3b-voice-latency-2026-07` (item 8) | SHIPPED 2026-07-06 (web TTS FIFO parity). Two-path design mirrors iOS Phase 7.1 scope: confirmations (+ future fast-path) FIFO-queue; `ask_user`/alerts/tour keep the separate direct `speak()` deferral slot (iOS `speakWithTTS` + single `deferredTTS`) and PREEMPT the queue. Deliberate divergence: voice-command `spoken_response` stays on `speakConfirmation` (FIFO) rather than iOS's direct `speakResponse` — rare/low-stakes ack, future-pass candidate. Ledger-gate (Derek 2026-07-06): flipped on merge/deploy; iPhone/iPad Safari ear-verify is a dated vault todo, NOT a merge gate. UPDATED 2026-07-08 (A1): defer-resume now PROVEN under Flux — the missing Flux `onUtteranceEnd` (see `recording/flux-migration`) had stranded every deferred head in the field; `flux-utterance-end-fifo-resume.test.ts` pins Flux EndOfTurn → `handleInspectorStoppedSpeaking` → `resumeIfDeferred` → play. |
| recording/assistant-answers | `DeepgramRecordingViewModel.swift:9852-9890` `handleVoiceCommandResponse` → `speakBriefConfirmation` (VCR frames speak UNCONDITIONALLY — no toggle gate) | `recording-context.tsx onVoiceCommandResponse` → `speakConfirmation(text, {force:true})` (A1 companion commit) + `tests/fixtures/pwa-replay-sessions/a1-vcr-answer-toggle-off.yaml` + `web/tests/a1-vcr-answer-contract.test.ts` | partial | 2026-07-23 | A1 agentic-voice | ADDED 2026-07-23 (A1): the model's `answer_user` spoken answers (+ the fixed failed-answer fallback) ride the existing `voice_command_response` frame — zero wire-shape change, zero iOS change. Web previously MUTED VCR speech when the confirmation toggle (web default OFF) was off; `{force:true}` matches iOS's unconditional speak. RED-proven replay scenario pins toggle-OFF playback; toggle-ON pinned exactly-once. Dated bounded limitations (Phase 0.2, ask-collision/burst class — an answer is conversational, the user re-asks): iOS DROPS an answer arriving while `AlertManager.isAwaitingResponse` (`AlertManager.swift:1416-1424`); web direct-ask `preemptFlush` discards queued answers; FIFO depth-6 drop-oldest; NO text-keyed dedupe on the VCR path (identical answers queue independently). A2's client wave owns fixes if field use shows they bite. Item-3.5 documented opt-out: a confirmation-OFF user's borderline dictation stays silent (existing designed behaviour, NOT changed by A1 — only ANSWERS are confirmations-independent). Row stays `partial` until the PR-2 live probes are ear-verified on both clients (web in BOTH toggle states); server-direct probes (B, A2-other-board) get their true client E2E after follow-up A2 ships the client question lane. ACCEPTED EXPOSURE (dated 2026-07-23, owner Derek — joint redaction sweep todo in vault todos-certmate.md): answers share the SAME pre-existing downstream raw-text logging class ask_user question text already has (web VCR/TTS client diagnostics, iOS VCR debug 100-char prefix, ElevenLabs proxy success row keys.js:690-706); A1 adds no NEW exposure and all BACKEND logs are hash-only. |
| recording/fast-path-tts | iOS `fastPathPatterns`/`matchFastPathCandidate` → `POST /api/voice-latency/regex-fast-tts` (whitelist mirrors backend `regex-fast-eligibility.js`) | absent (verified 2026-07-02: zero hits in `web/src/`); the `tts-queue.ts` `cancelKey`/`purge(prefix)` hook is in place for when it lands (2026-07-06) | missing | 2026-07-02 | WS3-FU `parity-ws3b-voice-latency-2026-07` | NOT shipped (item 4; required before WS8) — owned by the NAMED follow-up. The TTS FIFO (item 8, `recording/tts-fifo`) shipped 2026-07-06 and pre-wired the `purge(prefix)` forward hook fast-path will use. Advertise `regex_fast_v2` only after implemented + verified in backend session logs. |
| recording/playback-telemetry | iOS `ServerWebSocketService` / `APIClient.postPlaybackAck` playback-start/finish acks | absent (verified 2026-07-02: zero playback-ack hits in `web/src/`) | missing | 2026-07-02 | WS3-FU `parity-ws3b-voice-latency-2026-07` | NOT shipped in WS3 (2026-07-02) — owned by the NAMED pre-WS8 follow-up WS3-FU `parity-ws3b-voice-latency-2026-07` (parent WS3 item 5). Advertise `client_playback_telemetry` only after the telemetry is live. |
| recording/cancel-pending-tts | iOS Phase 6.3: backend `cancel_pending_tts { prefix }` (`engine.js:1020-1024`) silences a stale focused-mode script prompt + clears its ask state | `sonnet-session.ts` decode (`onCancelPendingTts`, guarded case, `clearInFlightToolCallIdByPrefix`) → `tts-prompt-helpers.ts handleCancelPendingTts` cancels the DIRECT `speak()`/`deferredTtsRef` prompt (NOT gated on the audio window) + clears `InFlightQuestionTracker` + `questions` UI + dismiss timers; `ttsQueue.purge(prefix)` forward hook | match | 2026-07-06 | WS3-FU `parity-ws3b-voice-latency-2026-07` | SHIPPED 2026-07-06 with the TTS FIFO. Pre-fix web had ZERO handling — the backend emitted the frame and web dropped it, so a cancelled script ask's prompt could still play and the next utterance mis-attributed to a dead ask. |
| recording/chime-silence-watchdog | iOS+web client chime-silence watchdog (PLAN-C, Phases 5/6): arm a timer on a processing chime, disarm when a spoken output of the arming utterance's response epoch plays back; else a 20s native fallback apology. `CHIME_SILENCE_WATCHDOG_MS=20000`. Backend emit-site contract = P4a/P4b (`session_ack speech_epochs:1` capability) + P4c (answer-side confirmations carry the epoch) + **P4d (question-side: ask/question/voice-command frames carry `utterance_id`)** | **BACKEND-ONLY so far.** P4d (2026-07-20) completed the server emit-site matrix — every `ask_user_started`/`question`/`voice_command_response` frame now carries the creation-time `utterance_id` (additive-optional; byte-identical when absent). The WEB watchdog CONSUMER is Phase 5 (not yet built): `web/src/lib/recording/sonnet-session.ts` currently DROPS `turn_id`/`utterance_id` — the Phase-5 prerequisite. | missing | 2026-07-20 | PLAN-C Phase 4 (backend) → Phase 5 (web watchdog) | NEW ROW 2026-07-20. Deliberate lag WITH OWNER: **Derek / PLAN-C Phase 5** owns the web watchdog client. Backend P4c+P4d ship first (both on `main` before any client arms — clients self-protect via the P4b capability gate + kill switches, so the additive wire fields are inert until a consumer exists). Web todo: (1) stop dropping `turn_id`/`utterance_id` in `sonnet-session.ts`; (2) build the epoch-correlated arm/disarm state machine (design settled in the PLAN-C refine rounds — disarm on actual playback-start of an originEpoch===E item, NOT on `onUtteranceEnd`/raw SpeechStarted). Vault todo in `todos-certmate.md`. |
| recording/voice-feedback-capture | `TranscriptProcessor.swift` HEAD: sentence-opener trigger `^\s*(?:feedback\|debug)\b` (:233), capture mode w/ rolling accumulation, exit `end/stop/finish/done feedback\|debug` + garble-tolerant utterance-final `and/an/in feedback` (:205), 30s/20-entry pre-trigger rolling window (:85-102), upload `POST /api/debug-report` (`APIClient.swift:1329`), `performStopCleanup` auto-close (:1854-1870), TTS ack "Feedback logged" (:2201) | `web/src/lib/recording/feedback-capture.ts` (literal state-machine port, injectable clock) + `recording-context.tsx` dispatchFinal branch (AFTER voice-command short-circuit, BEFORE cumulative append/regex/gate/chime/send) + `api-client.ts debugReport` + stop() auto-close + `speakConfirmation('Feedback logged')` ack | match | 2026-07-08 | pwa-replay-harness Wave 6 (A4) | NEW ROW 2026-07-08 — this gap was UNTRACKED (a WS0-audit escape; why the parity program never caught the missing capture — sess_mrbnds2d_jczh A4). Canon pin: web ports CertMateUnified **HEAD** ONLY — NO inactivity timeout (the 20s auto-close + in-capture dual-route exist only on unmerged iOS PR #17 `fc68448`; dated follow-up: re-visit when PR #17 merges to iOS HEAD). iOS-verbatim quirk kept: a bare "Feedback." trigger leaves the trailing "." in the buffer; the BACKEND's >=3-char guard is the noise filter (voice_feedback id 7 incident). Known divergence (backend-immutable): backend hardcodes `source: 'ios_v2_voice'` in debug_report.json (recording.js:1607) — web markers distinguishable only via the `sess_*` id shape; fix belongs to a future cross-platform backend wave. Tests: 11 unit + 4 full-provider placement/upload/ack + the sess_mrbnds2d_jczh fixture A4 case (xfail removed — four-bug proof complete). |
| recording/readback-dedup-rekey | iOS confirmation dedupe key = field+circuit+board+text-hash (2026-06-18) + circuits-list in key (`8b51418`) + §A1a token precedence for the five text-op fields (856ac1a) | `confirmation-dedupe-key.ts` — literal port (djb2 UInt64 BigInt, three shapes + `DEDUPE_TOKEN_FIELDS` token branch), wired at the D6 confirmation loop; `Confirmation` type gains `circuits`/`board_id`/`dedupe_token` | match | 2026-07-15 | WS3 → field-feedback-2026-07-14 (A1(a)) | SHIPPED 2026-07-02 (item 2). Hash vectors generated from the backend mirror `src/extraction/ios-dedupe-key.js` and pinned. Never-clear bare-"no": verified — web has NO client field-clearing path (clears are server-driven `field_clears` only) and the gate forwards bare negations for the backend read-back window to resolve. UPDATED 2026-07-15 (A1(a), session 6B6FE011 F2/F7/F10): the five text-op fields (circuit_op/observation/observation_deletion/field_cleared/circuit_designation) prefer the backend-stamped `${field}_${dedupe_token}` key in EVERY branch, so identical-text repeats of DISTINCT operations stop client-deduping; measured fields IGNORE tokens (bare single-circuit shape stays load-bearing for the correction cross-match); token absent = legacy shapes byte-unchanged. Vectors regenerated by executing the token-aware backend mirror, pinned identical to the Swift + backend drift tests (incl. desig ordinal/board-scoped + clear `_ord0` forms). |
| recording/confirmation-dedupe-ttl | iOS A1(b) (856ac1a): three dedupe stores — permanent `confirmedFieldKeys` (field read-backs) + field-nil 30 s TTL `[String: Date]` stamped at AUDIBLE PLAYBACK START + AGELESS `reservedConfirmationKeys` while queued; shared `forgetConfirmationKey` un-record on every pre-play discard; session reset clears all three | `web/src/lib/recording/confirmation-dedupe-store.ts` (three-store twin, injected clock) + `tts-queue.ts` `onPlaybackStarted(dedupeKey)` hook (mirror lifecycle of `onDiscarded`) + `recording-context.tsx` wiring (isLive/reserve at the D6 loop; `onDiscarded` → `forget` clears ALL stores; BOTH session-reset sites) | match | 2026-07-15 | field-feedback-2026-07-14 (A1(b)) | NEW ROW 2026-07-15. Session 6B6FE011 F7/F10: identical field-nil apologies 11+ min apart — the second swallowed by the session-lifetime set (beep-then-silence, audio-first #1). Derek-decided 30 s TTL. Reservation ≠ TTL entry (plan round-24): an apology deferred past 30 s in the queue stays live (no unheard-expiry duplicate); the TTL starts at being HEARD, never at enqueue. Web has ONE recording site (the FIFO defers internally — no separate iOS-style flush path). Tests: store-unit TTL boundary + end-to-end through the real tts-queue (played / preempt-flushed / deferred-then-resumed paths). |
| recording/catchall-audibility-apology | Backend marker-② (numeric-gate-redesign 2026-07-18): catch-all audibility net in `stage6-shadow-harness.js` speaks a rotating `CATCHALL_AUDIBILITY_PROMPTS` apology when a chimed turn ends with zero speech-intent (e.g. "Zs for circuit 4." → `calculate_zs` empty). iOS renders it via the existing field-nil confirmation channel (F7 apologies + marker-①, live) | Same — the apology rides the EXISTING field-null `expects_ios_ack:false` confirmation channel the web FIFO already renders/dedupes (A1(b) 30 s field-nil TTL); the new wording is string-distinct from every other apology family so channels never cross-dedupe (pinned by backend test). ZERO web change this wave (docs-only touch) | match | 2026-07-18 | numeric-gate-redesign (marker-②) | NEW ROW 2026-07-18. Backend-only wave; the richer per-client chime-silence WATCHDOG is the separate PLAN-C wave (own /rp cycle). Verify-by-ear on both clients rides the post-deploy field check ("Zs for circuit 4." → apology instead of silence). |
| recording/garble-aliases-f8-f10 | iOS C4 (67ffb9d): `TranscriptFieldMatcher.spokenAbbreviations` + `NumberNormaliser.spokenAbbreviations` gain `zedi`→Ze; `rcdTimePattern`/`rcdTimeFlexPattern` accept `icd` alongside `rcd` | `transcript-field-matcher.ts` SPOKEN_ABBREVIATIONS `\bzedi\b`→Ze + RCD_TIME_PATTERN/RCD_TIME_FLEX accept `icd` alongside `rcd`; `number-normaliser.ts` SPOKEN_ABBREVIATIONS `\bzedi\b`→Ze (the backend-facing `normalise()` output) | match | 2026-07-15 | field-feedback-2026-07-14 (C4) | NEW ROW 2026-07-15. Session 6B6FE011 F8 "ICD trip time" (06:24) + F10 "Zedi" (06:27) — enumerated garble aliases with field evidence (lim/tryptoid class); NO broad fuzzy correction (§3E stands). Exact iOS mirror: the third trip-time pattern (designation-scoped, rcd-prefix optional) deliberately UNCHANGED because its iOS twin (:1440) is unchanged; `keyword-boosts.ts` deliberately untouched (iOS made no keyterm change — garbles are recognition OUTPUTS, not keyterms, and the WS4 keyterm curation is HELD). Backend twins (rcd.js ICD+triptan, prompt steering) shipped in PR #87. |
| recording/observation-processing-cue | iOS `maybeSpeakObservationProcessingCue` (DGVM:2941 — "Processing observation" via `speakBriefConfirmation` on observation-shaped finals; suppress ladder bare_lead_in / active_alert / awaiting_response / tts_speaking / inspector_speaking) + this wave's B2 defer-don't-drop (856ac1a): `inspector_speaking` sets `pendingObservationCue`, drained single-shot at utterance end behind the deferred-confirmation gate, cleared on session reset | absent on web (verified 2026-07-15: zero cue hits in `web/src`; only the `transcript-gate.ts isObservation` primitive exists — its doc comment already anticipates the cue) | missing | 2026-07-15 | field-feedback-2026-07-14 (B2) | DEFERRED 2026-07-15 with owner: **Derek**. Not a small mirror: the BASE cue (an earlier iOS wave) was never ported, so the web gap = base cue + this wave's defer-drain delta — needs the full suppress ladder (`isBareObservationLeadIn` has no web port), a single-shot `pendingObservationCue` drained at BOTH inspector-stopped-speaking sites (utterance-end + phantom-reset), drain-gate parity with the deferred-confirmation flush, and session-reset clearing. Ear-verifiable NEW web voice behaviour → its own wave, not a rider on the A1/C4 sweep. **FLIP PREREQUISITE (2026-07-24, chunk C1):** the backend `OBSERVATION_TIER_ROUTING` router shipped DARK (default OFF) — flipping it ON routes BOTH clients' observation turns to Sonnet (added latency), so this web cue must ship + verify BEFORE that global flip (iOS's `maybeSpeakObservationProcessingCue` already masks it). No numeric latency gate (Derek: masked by cue, not gated on a number). When this web companion ships, UPDATE this row (status → match, verification date, concrete `web/src` paths, `parity-ledger-files.json` mapping) rather than adding a new row. |
| recording/address-dual-ask | iOS B1 (856ac1a): a server `client_address` ask latches OFF the client-local `address_for_client_confirmation` alert + cancels a queued/presented copy (the F1 duplicate-ask fix — iOS has a local 4 s address-offer debounce, `shouldOfferAddressForClientFromVoice`) | web has NO client-local address-for-client ask path (verified 2026-07-15: zero `address_for_client` / `addressConfirm` / `questionAskCounts` hits in `web/src`; every web ask is server-driven via `onQuestion`) | match | 2026-07-15 | field-feedback-2026-07-14 (B1) | NO GAP — the F1 dual-path class is structurally impossible on web because the local-ask half never existed; nothing to port. Row recorded so the next sweep doesn't re-derive the verification. |
| recording/ask-context-board-id | iOS does NOT decode `ask_user.context_board_id` either (verified 2026-07-02: zero refs in CertMateUnified Sources; the client answer path is keyed by `tool_call_id`) | web answer path likewise keyed by `tool_call_id` (`recording-context.tsx` dispatchFinal → `sendAskUserAnswered`; pinned by `tests/transcript-gate-wiring.test.ts` scenario b) | match | 2026-07-02 | WS3 | CORRECTED 2026-07-02 (WS3 item 9c): the field is BACKEND-INTERNAL — `stage6-tool-schemas.js` threads it through server-side ask flows (#61) but neither client decodes it. The original 'iOS carries it' claim was wrong; no web action. |
| supply/surge-namespace | iOS Fix D `surge_*` UI + SPD-vs-main-switch regex split (`a62000e` + `b54cb75`) | COMPLETE (sweep 2026-07-02): supply form card, live-fill ×4, CCU apply (Option A + No/N-A stamps), doc-extraction, adapters/ccu, preset editor, Sonnet voice apply → `supply_characteristics` (pinned) | match | 2026-07-02 | WS3 | Sweep verified fallback-removal parity (zero `board.spd_type`→`spd_type_supply` in `web/src`), no web supply-field CSV exists (server-side), server-PDF loads the job from DB so surge rides persistence. One gap closed: voice-apply routing test added. |
| installation/eic-comments | iOS renders the EIC comments cell + dedicated `comments` voice case: EIC-only, newline-APPEND (`DeepgramRecordingViewModel.swift:6650-6670`) | form cell pre-existed (`extent/page.tsx`, `extent_and_type.comments`); voice divert-to-comments apply path ADDED 2026-07-02 (`apply-extraction.ts` — EIC-only guard, newline-append, EICR drop) | match | 2026-07-02 | WS3 | SHIPPED 2026-07-02 (item 9b). Audit-first honoured: cell NOT re-added; PDF path posts no body (server loads job from DB). Pre-fix a diverted note default-routed into `supply_characteristics` — invisible. 5 tests. |
| circuits/lim-sentinel-display | iOS IR fields accept/display the `LIM` sentinel; P3 (2026-07-23) extends LIM to ALL numeric reading fields via the voice path, with a sentinel-safe derivation guard + max-Zs invalidation so LIM is never silently overwritten | P3 web ships: `circuit-derivations.ts` sentinel guard (no fabrication over LIM), `apply-extraction.ts` `shouldClearAutoDerivedMaxZs` before/after helper, `transcript-field-matcher.ts` narrowed to the exact four LIM forms, + the `lim_ranged_write_v1` capability advert; existing IR display path unchanged | match | 2026-07-23 | WS3 | P3 feedback id 86: voice path now writes LIM to the numeric reading fields (six ranged + ungated numerics); `recomputeAll` no longer fabricates over a LIM (byte-parity with iOS `CircuitDerivations`), and an auto-derived `ocpd_max_zs_ohm` is cleared (not left stale) when the rating→LIM; four-form policy (`lim/limb/limp/limitation`) on the client instant-regex (near-matches rejected). Web MUST advertise `lim_ranged_write_v1` or web users lose LIM acceptance (backend deny-first). Tests: `circuit-derivations-lim-guard.test.ts`, `apply-extraction-max-zs-lim.test.ts`, `lim-sentinel.test.ts` (four-form + near-match). iOS result-status + capability advert on P3's own TestFlight build. |
| crosscutting/cmdesign-token-deltas | `CertMateUnified/Sources/Views/Components/CertMateDesign.swift` (CMDesign = single iOS token source: 4px grid, cardPadding 20, sectionGap 28, radii 10/14/18/22/26, heights input 52 / listRow 72, elevation ladder, green/blue accent scales, SectionAccent category map) | `web/src/app/globals.css` `@theme` + `web/src/lib/design-tokens.ts` regenerated from CMDesign (WS5 2026-07-02); mapping table at `web/audit/cmdesign-token-map-2026-07.md` | match | 2026-07-02 | WS5 | CLOSED 2026-07-02: values moved to CMDesign (text/status/soft-brand/transcript colors, accent scales added, semantic radii input 12/button 14/card 18/section 16/hero 22/cta-pill 26 from live-call-site winners, h-input 52, h-tabbar 49); spacing KEYS+VALUES kept (user decision 2026-07-02 — `max-w-*` override block intact, computed-verified 768px). Dated deliberate divergence: `Spacing.sectionGap=28` page-stack retrofit skipped (layout change beyond token scope); web page stacks stay gap-16/24. |
| crosscutting/ios-signature-styling | iOS glassmorphism card recipe (blue@3% tint + glass gradient + directional 1pt gradient border + soft shadow), 3pt `cmStatusConduit` leading-edge bar, hero breathing+shimmer, gradient tab underline w/ slide, spring animation library, pulsing red/orange 6pt recording border, UPPERCASE 13-semibold +0.6-tracking form labels, monospaced data values | `.cm-card` glass recipe + SectionCard conduit gradient (`ui/card.tsx`/`ui/section-card.tsx`), `.cm-hero::after` shimmer + breathe (`ui/hero-header.tsx`), sliding gradient underline (`job/job-tab-nav.tsx`), `--ease-spring`/`--ease-out-soft`, `.cm-rec-ring` (pre-existing), field chrome per CMFloatingTextField (`ui/floating-label-input.tsx` et al) | match | 2026-07-02 | WS5 | SHIPPED 2026-07-02, all motion reduced-motion gated. Dated deliberate divergence: UPPERCASE 13-semibold `formLabel`/`cmFormLabel` NOT applied to field controls — that token has ZERO live iOS call sites (grep 2026-07-02); live iOS fields render the floating 12px-medium label, which web now matches. Mono data values live only where iOS uses them (LiveFill/grid — already ported). See `web/audit/cmdesign-token-map-2026-07.md` typography notes. |
| crosscutting/tab-rail-form | `JobDetailView.swift:170-309` custom horizontal scrollable rail + paged swipe content | `web/src/components/job/job-tab-nav.tsx` — rail restyled to iOS (WS5 2026-07-02): active blue icon + white bold label, inactive white/35+white/45, single 3px blue→green gradient underline sliding between tabs (measured indicator + `--ease-spring`) | partial | 2026-07-02 | WS5 | Rail visual form CLOSED 2026-07-02. Stays `partial` for the dated accepted pattern difference: PAGED SWIPE CONTENT is not ported — web keeps routed pages (consistent with `overview/ios-tab-model-one-tab`) unless Derek asks for swipe paging. |
| inspection/section-accents-dup | iOS SectionAccent per inspection section — canon `InspectionTab.swift:362-374` `sectionCategory(for:)`: [schedule, electrical, protection, board, testResults, notes, notes, client] | `web/src/lib/constants/section-accents.ts` `EICR_INSPECTION_SECTION_CATEGORIES` (shared, index-aligned, modulo-consumed); inspection page consumes it — local colour list deleted | match | 2026-07-02 | WS5 | CLOSED 2026-07-02: ad-hoc blue/amber/magenta list replaced by the iOS category map (`magenta` had no iOS category — remapped per index list); category cards also pick up the CMSectionCard surface recipe. |
| observations/obs-photo-autolink | `DeepgramRecordingViewModel.swift:2257` capture, `:1094` link window 60 s, `:7262` forward-link in `applySonnetObservations`; `JobPhotosPickerSheet.swift` From-Job picker | REBASED + MERGED 2026-07-02 (WS2): parked branch `e880043d`..`577f8107` replayed onto main (one keep-both conflict), plus adapter fix — `unassigned_photos` declared in `JobDetailSchema` (strip-mode would have dropped it) + nullable `string[]` wire type. Capture → pending → bidirectional 60 s auto-link → unassigned pool + From-Job picker all live | partial | 2026-07-02 | WS2 | `partial` NOT `match` until the iPad Safari device smoke passes (upload-during-resize race + camera quirks are runtime-only; todo in todos-certmate.md, 2026-07-02). Two dated deliberate divergences (2026-07-02): (1) picker has NO CCU source — web has no persisted `ccu_photo_path` and the job wire neither emits nor accepts one; zero-backend rule forbids adding it (frontend-only port impossible); (2) web-extra camera/library chooser on the Photo button (iOS is camera-only; iPadOS Safari can't strictly enforce camera from `<input capture>`). Flip to `match` only after the device smoke passes AND leaving the two divergences noted. |
| ccu-flow/off-peak-mode | `CCUExtractionMode.swift` `addOffPeakBoard` (off-peak sibling board, always-visible tile) | `ccu-mode-sheet.tsx` 6th tile + `applyAddOffPeakBoardMode` (`apply-ccu-analysis.ts`) + last-mode guard 5→6 + circuits-page hint/success/selection + Board tab `off_peak` option (no parent UI) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 1, full path): sibling board stamped `board_type='off_peak'` + designation "Off-Peak Board" (`FuseboardAnalysisApplier.swift:487` parity); supply characteristics untouched; type-flip to main/off_peak clears parent (BoardTab.swift:411-425). Tests: apply-mode contract + sheet 6-tile + Board-tab render gates (`ws6-board-offpeak.test.tsx`). |
| dashboard/tour-v11 | `TourManager.swift` 11 steps (2 dashboard + 9 job) incl. job step 4 "conversational + tone" with the REAL 960 Hz chime spliced into the bundled MP3 (build 417) | `web/src/lib/tour/steps.ts` 2 dashboard + 9 job = 11 steps; `job-tone` step plays the chime via the shared `playSentForProcessingChime()` (`lib/recording/tones.ts`) | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 3): v11 copy verbatim (Defaults narration shortened per 2026-06-30 revision; Observations step drops the stale voice-button line). DELIBERATE DIVERGENCE (dated 2026-07-02): iOS splices the chime INTO the MP3; Web Speech API can't splice mid-utterance, so web plays the sample-accurate synth (`makeChimeWAVData` port) immediately AFTER the step narration. SWITCHED 2026-07-02 (WS3 item 7c): tour now calls the shared `playSentForProcessingChime()` from `lib/recording/tones.ts`; the tour-local synth (`lib/tour/tour-chime.ts`) is deleted — one copy of the chime synthesis in web/. |
| dashboard/job-creation-defaults-flow | `JobListViewModel.swift:200-234` `autoApplyDefaults` → `applyStandardDefaults` (STANDARD defaults even with 0 presets); 1 preset → auto-apply; 2+ → PresetPicker sheet with Skip | `dashboard/page.tsx` createJob → `prepareCreatedJob` (`lib/defaults/job-creation.ts`): fetch created JobDetail → 0 → `applyStandardDefaultsToJob` port; 1 → `applyPresetToJob`; 2+ → `PresetPickerSheet` with Skip; persist via `queueSaveJob` (+cache warm) → navigate | match | 2026-07-02 | WS6 | SHIPPED 2026-07-02 (WS6 item 6). Standard-defaults field list is a literal port of `CertificateDefaultsService.applyStandardDefaults:430-480` (wire keys from iOS CodingKeys; only-fill-empty; `means_earthing_electrode` explicit false). Storage stays the existing settings blob — zero backend. Tests: field list, only-fill-empty, fetch→apply→persist ordering, 0/1/2+/Skip (`ws6-job-creation-defaults.test.ts`). |
| crosscutting/offline-dirty-guard | iOS offline-first GRDB with `isJobDirty` guard — a cached/background fetch never clobbers unsaved local edits | `job-context.tsx:121-138` guard: replace only on id change OR (updated_at advanced AND !isDirty AND no pending patch) | match | 2026-07-02 | WS6 | AUDITED 2026-07-02 (WS6 item 4): the guard ALREADY existed — audit outcome is parity-confirmed, no production change. Missing regression coverage added: newer-updated_at + dirty must NOT clobber; newer-updated_at + clean MUST hydrate (`job-context.test.tsx` (e)/(f)). |
| circuits-rail/doc-extraction-parity | iOS doc extraction: ≤12 files, image+PDF, whole-batch failure surfacing (`JobViewModel.analyzeDocument` — direct upload, NO pending queue) | `circuits/page.tsx` handleDocFile: 12-file client cap with clear error, `accept="image/*,application/pdf"` multiple, single `api.analyzeDocument` call, errors (incl. backend per-file messages like "PDF #2 exceeds 32MB") surface via docError | match | 2026-07-02 | WS6 | VERIFIED 2026-07-02 (WS6 item 5, verification-only): parity confirmed, no code change. The stale "PDFs not supported" claim is wrong — both platforms accept image+PDF; neither has per-file partial RESULTS (single all-or-nothing Anthropic call). Noted division of labour: iOS scales images client-side (ImageScaler), web uploads originals and the backend transcodes (sharp) — same net behaviour. Doc path intentionally has NO queue/idempotency key (test-pinned in `ws6-pending-ccu-queue.test.ts`). |
| pdf/pdf-fidelity | `EICRHTMLTemplate.swift` → WKWebView `createPDF()` local render (portrait+landscape merge) + `IssueCertificateSheet` two-attestation clickwrap (attestations persist even if render fails). **Any `EICRHTMLTemplate.swift` change REQUIRES a companion change in `web/src/lib/pdf/template/` (esp. `eicr-html-template.ts` + `css.ts`) — this row note + the WS1 web-companion rule in `CertMateUnified/CLAUDE.md` are the load-bearing drift-stop for iOS-side template changes (the CI ledger warner cannot see the nested CertMateUnified repo).** | CLIENT-SIDE render SHIPPED 2026-07-02: `web/src/lib/pdf/` (template port + data-graph mirror of `PDFGenerator.swift:9-68` + foreignObject capture + pdf-lib Blob) wired into `pdf/page.tsx`; two-attestation clickwrap live (`IssueCertificateModal`), attestations persist on render failure + spec-§4.3 no-re-prompt retry | partial | 2026-07-02 | WS9 | 2026-07-02: client render PASSED the page-by-page acceptance diff vs iOS reference PDFs (EICR 9/9 + EIC 5/5 pages, identical boxes/values/badges/footers; evidence `web/audit/ws9-pdf-fidelity-2026-07/`). Stays `partial` until FIELD validation accepts the renderer — flips to `match` alongside the server-button debug-page flip (parent §6 item 5). Accepted deltas: 3× raster vs vector text; sub-line word-wrap in two long paragraphs; web-only group-header CSS compensation (dated in `css.ts`). `window.print()` remains debug-only (unused). |
| crosscutting/pwa-nav-transitions | iOS push/pop navigation feel | web default Next.js route swaps — no view-transition push/pop | partial | 2026-07-03 | WS7 | Parent §3D ("indistinguishable on mobile" bar). DEPLOYED 2026-07-03 (WS7): stays `partial` — view-transition push/pop feel DEFERRED (needs Next's experimental `viewTransition` config flag + on-device validation; not flipped autonomously to avoid a router-level regression). Awaiting iPhone A2HS device smoke. |
| crosscutting/pwa-chrome-suppressions | iOS-native scroll/tap/selection behaviour | `globals.css` overscroll-behavior:none (html+body), tap-highlight transparent, scoped user-select/touch-callout on chrome (inputs kept selectable), `.p*-safe` env helpers; AppShell header `pt-safe`+`min-h-14` | partial | 2026-07-03 | WS7 | Parent §3D sweep; includes verifying zero browser artifacts in standalone display + safe-area audit on notched devices. DEPLOYED 2026-07-03 (WS7): suppressions + safe-area shipped; pull-to-refresh SUPPRESSED via overscroll-behavior:none (no gesture added — see `dashboard/dashboardview-188`). Source-locked in `ws7-standalone-chrome.test.tsx`; actual standalone overscroll/notch behaviour awaits iPhone A2HS device smoke (jsdom can't emulate display-mode:standalone/env()). |
| crosscutting/keyboard-accessory-bar | iOS circuit-cell keyboard toolbar: LIM / N/A / prev / next / Done | `CircuitKeyboardAccessory` + `useCircuitAccessoryController` (`circuit-keyboard-accessory.tsx`) + shared `circuit-focus-fields.ts`, wired into card/sticky/desktop | partial | 2026-07-03 | WS7 | WS7 owns the toolbar UI; the LIM button wires to the WS3 sentinel path (`circuits/lim-sentinel-display`, merged PR #76). DEPLOYED 2026-07-03 (WS7): all three surfaces; visualViewport positioning + blur-survival + cross-circuit prev/next wrap; 13 iOS focusable fields (tokens on all but ref/designation) + 12 web-extra keyboard fields (dated divergence — prev/next/Done but NO LIM/N/A, iOS renders them as dropdowns). 34 tests. Awaiting iPhone A2HS device smoke (real soft-keyboard inset). |
| crosscutting/splash-continuity | iOS branded loading view (bolt.shield.fill in hero-gradient circle) | `BrandedSplash` (bolt.shield + blue→green hero-gradient circle + blue/green CertMate wordmark, WS5 tokens) wired as root `app/loading.tsx` | partial | 2026-07-03 | WS7 | Parent §3D. DEPLOYED 2026-07-03 (WS7): cold-launch/segment-stream splash mirrors iOS RootView. Awaiting iPhone A2HS device smoke. |
| crosscutting/terms-signature-port | iOS `termsAcceptanceSignature` (`UserDefaults` blob) captured at the terms gate | signature canvas on the terms gate (`terms/page.tsx` + `legal-texts-gate.ts` all-or-nothing persist + `signature-canvas.tsx` helperText/onContentChange), client-side only | partial | 2026-07-03 | WS7 | Decided 2026-07-01: PORT it (un-parked — supersedes the "parked pending legal review" notes in the old `web/audit/INDEX.md`). DEPLOYED 2026-07-03 (WS7): 7th attestation, completion 6→7, Accept gated on a non-empty signature, `termsAcceptanceSignature` PNG data URL persisted signature-first/all-or-nothing (storage-throw rolls back all terms keys + no redirect); `hasAcceptedCurrentTerms()` unchanged (existing users don't re-sign); NO backend write; terms gate NOT `/onboarding/consent`. 27 terms tests. Awaiting iPhone A2HS device smoke. |
| crosscutting/session-analytics-upload | iOS uploads full session analytics to S3 `session-analytics/{userId}/{sessionId}/` — `debug_log.jsonl` + `field_sources.json` + `manifest.json` + `job_snapshot.json` (multipart at session stop) | web uploads NOTHING from the client — only the backend-written `cost_summary.json` exists for web sessions (verified 2026-07-08: sess_mrbnds2d_jczh has cost_summary only; iOS sessions from 2026-06-25 have all files). Web behavioural events exist only as `client_diagnostic` (CloudWatch + in-process). | missing | 2026-07-08 | pwa-replay-harness §5 | NEW ROW 2026-07-08 (was an untracked gap). Consequence: field-debugging a web session means CloudWatch spelunking (80-char textPreview truncation), and the WS-C session→fixture converter cannot process web sessions — sess_mrbnds2d_jczh had to be hand-transcribed. NOT implemented by the harness plan (the harness captures traces in-process); a diagnostics-parity fix for a future wave. Vault todo in todos-certmate.md. |

---

## Phase 9 — Cross-cutting polish summary

Final state of the PHASE 0–9 REBUILD (as of 2026-04-24, post ledger-fix — historical; superseded by the live count table below):

| status | count |
|---|---|
| `match` | 285 |
| `partial` (intentional defer — see per-row notes) | 67 |
| `ios-only` (intentional platform divergence) | 16 |
| `backend` (unblocks when backend ships endpoint) | 0 |
| `missing` | 0 |

Note: the prior count showed 1 `backend` and 66 `partial`. The ledger-fix commit on 2026-04-24 re-classified `AdminQueueView` from `backend` → `partial` after confirming the backend endpoints already exist (`src/admin_api.js:59,72,85`). `AdminStatsView` kept its `partial` status but the blocking note was corrected. No work was lost — two `partial` rows are now pure PWA wire-ups, and one `partial` row (`PresetPickerSheet`) was then believed to need a new backend endpoint — CORRECTED 2026-07-02: that claim was stale (web already has named presets under the existing settings endpoint); the row is re-scoped frontend-only (WS6) and the vault todo superseded. Zero rows require backend work.

Phase 9 flipped ~32 rows into terminal states:

- **Closed to `match`:** staggered section entrance (CSS utility ported), data-arrival flash (audited across every tab + new-in-phase voice/CCU paths), offline banner (breakpoint-driven twin shape), universal destructive confirmation (10 handlers audited — all through `ConfirmDialog`), reduce-motion respect (global + per-feature rules), data-arrival flash regression check.
- **Closed to `ios-only`:** AudioImport (test affordance), inline-inspector-add inside Installation (Settings → Staff is the single source of truth).
- ~~**Closed to `backend`:** AdminQueueView — requires `/api/admin/queue` before any UI work.~~ **Corrected 2026-04-24 (ledger-fix):** the backend endpoints (`/api/admin/queue/status`, `/api/admin/queue/health`, `/api/admin/stats`) already exist and are consumed by iOS. Reclassified to `partial` (PWA wire-up follow-up, no backend work needed). Final backend count is now **0** on main.
- **Closed to `partial` with explicit defer:** Supply preset pickers (bundle — needs `Constants.*` port to `@certmate/shared-utils`), CCU pending-extractions queue (needs IDB blob store), RecordingOverlay Defaults buttons (intentional web UX — Settings route over inline), transcript keyword flash (cosmetic, no user demand), haptic feedback (Vibration API best-effort only; iOS Safari has no API), TypingText (paired with tour TTS — both silent on web for now), LiveFillView pickers (overlay is read-only on web by design), Terms & Legal surfaces (handled at signup), ChangePassword FocusState (native Tab suffices).

Seven rows deferred beyond Phase 9 — all marked `partial` or `backend` and raised as separate follow-ups:

1. ~~Multi-preset Defaults CRUD — needs backend `/api/defaults/presets` shape.~~ **Corrected 2026-07-02:** named presets already exist on web (`web/src/lib/defaults/`); re-scoped to the frontend-only WS6 job-creation flow (`dashboard/job-creation-defaults-flow`). NO backend dependency remains anywhere in the ledger.
2. Supply preset pickers bundle (`Constants.*` port to shared-utils, ~9 pickers).
3. ~~CCU pending-extractions queue (IDB blob store + extraction-replay worker).~~ **Shipped 2026-07-02 (WS6 item 2):** `lib/ccu/pending-extraction-queue.ts` + `pending-ccu-banner.tsx` (see `ccu-flow/circuitstab-272`).
4. ~~Admin queue (`AdminQueueView`) — backend endpoint first.~~ **Corrected:** endpoints exist (`/api/admin/queue/status`, `/api/admin/queue/health`). Pure PWA wire-up follow-up.
5. ~~Admin stats system-wide dashboard (`/api/admin/stats`).~~ **Corrected:** endpoint exists. Pure PWA wire-up follow-up.
6. Transcript keyword-highlight flash (cosmetic).
7. Geometric CCU slot-crop tap-to-correct (requires geometric extraction pipeline).

### Phase 9 additions shipped in this PR

- `web/src/lib/haptic.ts` — `navigator.vibrate()` wrapper with SSR + iOS-Safari safe no-op; wired into `ConfirmDialog` destructive confirm.
- `web/src/app/globals.css` — `cm-stagger-fade-slide-up` keyframes + `.cm-stagger-in` / `.cm-stagger-children` utilities (reduce-motion aware).
- `web/src/components/pwa/offline-indicator.tsx` — `<OfflineBanner />` mobile-only full-width variant; inline pill restricted to `md+` breakpoints.
- `web/src/components/ui/hero-header.tsx` — now live on every job tab (installation, supply, board, circuits, observations, extent, design, inspection, staff, pdf) with per-section category accents.
- `web/src/app/job/[id]/circuits/page.tsx` — per-circuit delete now routes through `ConfirmDialog` (not just the bulk delete).
- `web/src/app/settings/staff/page.tsx` — `SkeletonRow` placeholders replace the centred loading spinner.
- `web/tests/phase-9-haptic.test.ts` — graceful-degradation coverage.

This ledger was the authoritative record of the Phases 0–9 parity project (the 2026-04 rebuild). **Re-opened 2026-07-02 as the LIVING ledger of the iOS↔Web Full-Parity Program** (WS0–WS9): the 2026-07 sweep section above holds the program gap rows, `web/audit/INDEX-2026-07.md` is the gap index, and `scripts/check-parity-ledger.mjs` warns in CI when PRs touch files whose rows have gone >30 days unverified.

## Live status counts — 2026-07-02 sweep

| status | count |
|---|---|
| `match` | 283 |
| `partial` | 84 |
| `ios-only` | 16 |
| `missing` | 13 |
| **total rows** | **396** |

Rows re-verified 2026-07-02: 25. Rows with blank `last-verified` are stale by definition for the CI warning.

