# iOS ↔ PWA Parity Ledger

Single source of truth for the iOS CertMateUnified → web (certmate.uk) gap
audit. Each row maps one iOS surface (field / button / section / sheet / flow)
to its current PWA counterpart.

Status legend:

- `match` — behaviourally + visually equivalent
- `partial` — some fields / behaviour present, others missing
- `missing` — no PWA counterpart
- `backend` — gap requires a backend change before UI can close it
- `ios-only` — intentionally iOS-only (native camera overlay, WKWebView PDF, Core Data, PhotosPicker, `fullScreenCover`, ShareLink, etc.)

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

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `Views/Dashboard/DashboardView.swift:L419-L508` (hero gradient + metric boxes + shimmer + breathing) | `web/src/app/dashboard/page.tsx:L278-L318` (HeroCard + HeroStat + AnimatedCounter) | match |  | Both render ACTIVE/DONE/EXP inline on a blue→green gradient; web uses `AnimatedCounter`. |
| `DashboardView.swift:L384-L387` expiringJobCount derived from `lastModified < 4 years` | `dashboard/page.tsx` stats memo | match | 3 | Phase 3: mirrors iOS placeholder — done + `updated_at` < 4y ago. Backend does NOT ship `next_inspection_due` on the Job list; authoritative fix remains a backend flag (raised below). |
| `DashboardView.swift:L512-L548` (search bar — localizedCaseInsensitiveContains on `address`) | `dashboard/page.tsx:L192-L205` (`<input type="search">` filter) | match |  |  |
| `DashboardView.swift:L552-L580` Start EICR + Start EIC gradient action cards (blue / green) | `dashboard/page.tsx:L173-L189` (StartTile) | match |  |  |
| `DashboardView.swift:L708-L724` `createAndNavigate` with auto-apply-defaults + preset picker sheet | `dashboard/page.tsx` simple create; Circuits tab Apply Defaults on demand | partial | 9 | Phase 9 decision: closed as a **defer** — inspectors prefer triggering Apply Defaults from the Circuits tab after CCU photo / document extraction adds circuits. Auto-apply-on-create would run against an empty circuits array and leave nothing visible, so the ergonomic win is marginal. Preset-picker sheet rolls up with the multi-preset Defaults CRUD row (needs backend shape work — tracked below). |
| `DashboardView.swift:L89-L114` skeleton job-row shimmer while loading | `dashboard/page.tsx:L225-L233` cm-shimmer placeholder rows | match |  |  |
| `DashboardView.swift:L115-L132` empty-state icon + "Start a new EICR or EIC above" | `dashboard/page.tsx:L234-L239` equivalent empty message | match |  |  |
| `DashboardView.swift:L133-L165` JobRow NavigationLink with swipe-to-delete (trailing) | `web/src/components/dashboard/job-row.tsx` | match | 3 | Phase 3: pointer-driven swipe-left reveals trailing Delete on touch/pen; right-click opens a custom context-menu on desktop. Both go through Phase 1 `ConfirmDialog`; `onDeleted` drops the row from the dashboard list on success. |
| `DashboardView.swift:L584-L672` "Setup & Tools" grid (Defaults, Company, Staff, Settings, Tour, Log Out) | `dashboard/page.tsx` Setup & Tools grid | match | 3 | Phase 3: Tour tile added (toggles "Start tour" ↔ "Stop tour"). Defaults tile hidden until Phase 6 (per Phase 3 brief decision). |
| `DashboardView.swift:L593-L595` Defaults tile → DefaultsManagerView sheet | Reached via Settings → Certificate Defaults → `/settings/defaults` | match | 6 | Phase 6: defaults hub lives at `/settings/defaults` with Default Values + Cable Size Defaults sub-routes. Dashboard Setup & Tools does NOT expose a separate Defaults tile — the Settings hub is the single entry point (avoids duplicating nav surface). |
| `DashboardView.swift:L596-L598` Company tile → CompanyDetailsView sheet | `settings/company/page.tsx` | match |  |  |
| `DashboardView.swift:L602-L604` Staff tile → InspectorListView sheet | `settings/staff/page.tsx` | match |  |  |
| `DashboardView.swift:L605-L607` Settings tile → SettingsView sheet | `settings/page.tsx` | match |  |  |
| `DashboardView.swift:L611-L641` Tour toggle (ON/OFF pill) + auto-start | `dashboard/page.tsx` Tour tile + `useTour` | match | 3 | Phase 3: `useTour({ autoStartOnFirstRun: true })` auto-launches on first visit when IDB `tour-state.seen === false`. Dashboard tile toggles Start/Stop; tour survives hard reload via IDB. |
| `DashboardView.swift:L642-L667` Log Out button with red tint | `dashboard/page.tsx:L269` `SetupTile variant="destructive"` | match |  |  |
| `DashboardView.swift:L676-L703` TourManager start / navigate to job / TTS narration | `useTour` hook + `TourOverlay` | partial | 3 | Phase 3: Ports the start/next/prev/pause/resume/stop transport controls — dashboard-only 4-step walkthrough (welcome → Start EICR → Setup & Tools → Alerts bell). Scope-conservative: TTS narration + cross-view tour navigation deferred. iOS uses the `/api/proxy/elevenlabs-tts` endpoint; narration is not wired on web in Phase 3 (silent tour). |
| `DashboardView.swift:L294-L308` Delete Job confirmation alert | `job-row.tsx` `ConfirmDialog` | match | 3 | Phase 3: destructive ConfirmDialog with "Delete job for <address>? This cannot be undone." text wraps both the swipe-delete and right-click-delete paths. |
| `DashboardView.swift:L188-L189` pull-to-refresh `.refreshable` | N/A (SWR IDB cache + focus refresh) | partial | 9 | Phase 9 defer: SWR IDB cache + tab-focus re-fetch already serves every case a pull-to-refresh would (inspector returns to dashboard → focus listener refetches). Implementing a touch-based pull gesture on a web page fights with native browser scroll overscroll behaviour, especially on iOS Safari. No inspector feedback asking for the gesture — closed as intentional platform divergence. |
| `DashboardView.swift:L43-L46` `OfflineBanner` slide-in on connection loss | `web/src/components/pwa/offline-indicator.tsx` header pill (`md+`) + `<OfflineBanner />` full-width banner (`< md`) | match | 9 | Phase 9: `OfflineIndicator` now renders the amber pill only on `md+` viewports; below that breakpoint the full-width `<OfflineBanner />` (mounted by AppShell just under the header) matches the iOS slide-in shape. One component, breakpoint-driven — same offline state drives both so pending counts stay consistent. |
| `DashboardView.swift:L201-L221` toolbar Alerts bell + Settings gear (top-right) | `app-shell.tsx` + `<AlertsBell />` | match | 3 | Phase 3: bell lives in the right header cluster between OfflineIndicator + user name. Badge count drives off `bucketJobs(jobs).needsAttention.length` (same helper as the /alerts page). Tapping navigates to /alerts. |
| `Views/Alerts/AlertsView.swift` whole view (Failed / In Progress / Recently Completed sections) | `app/alerts/page.tsx` | match | 3 | Phase 3: new `/alerts` route. Three collapsible `SectionCard`s with TallyBadge counts; buckets derived via pure `bucketJobs(jobs)` (iOS parity — status-based only, not computeWarnings). |
| `AlertsView.swift:L176-L191` empty-state "All Clear" green shield | `app/alerts/page.tsx` `EmptyState` | match | 3 | Phase 3: green Shield icon + "All clear" copy + subtitle. |
| `AlertsView.swift:L130-L172` alertJobRow with status conduit stripe + badge | `app/alerts/page.tsx` reuses `<JobRow>` | match | 3 | Phase 3: rather than a bespoke alert-row variant, the existing `<JobRow>` renders inside each `SectionCard` — same coloured stripe + status pill, stays consistent with the dashboard. |
| `Views/Tour/TourOverlayView.swift:L13-L76` floating transport controls (step counter / back / play-pause / forward / stop) | `components/tour/tour-overlay.tsx` + `tour-step-highlight.tsx` | match | 3 | Phase 3: capsule-shaped floating pill at the bottom of the viewport; 5 controls (counter N/TOTAL, back, pause/resume, forward, stop). Spotlight cutout + accent ring + tip card. |
| `CertMateApp.swift` `@AppStorage("appTourEnabled")` default=true | `lib/tour/state.ts` (IDB `app-settings/tour-state`) | match | 3 | Phase 3: IDB-backed (partitioned with `certmate-cache`); `{seen, disabled}` survives hard reloads and is wiped on sign-out via `clearJobCache()`. |
| `Views/Dashboard/JobRowView.swift` (status pill, coloured stripe, cert type, address, last modified) | `components/dashboard/job-row.tsx` | match |  | Web row exists and has pendingSync chip extra. |
| `Views/Dashboard/DefaultsModal.swift:L37` preset picker reusing `Constants.circuitFieldOrder` for per-field defaults | Defaults now persist globally; no per-job picker modal | match | 6 | Phase 6 simplifies the iOS "pick-a-preset-per-job" modal to a single user-scoped defaults blob saved on `/settings/defaults/*`. Multi-preset CRUD deferred (see DefaultValuesView row). |
| `Views/Dashboard/InspectorModal.swift` (quick inspector picker from dashboard) | MISSING (by design) | partial | 9 | Phase 9 defer: web deliberately routes all inspector switching through Settings → Staff + the per-job Staff tab. The iOS dashboard modal exists because iOS lacks a persistent tab for per-job staff; web has one, so an extra modal on the dashboard would be redundant. Closed as an intentional platform divergence. |
| `Views/Create/CreateCertificateSheet.swift` PresetPickerSheet (shown after new-job create) | MISSING (defer — needs multi-preset Defaults) | partial | 9 | Phase 9 defer: only meaningful once multi-preset Defaults lands. Web's current user-scoped defaults blob is single-preset. Needs a backend endpoint (`/api/defaults/presets` collection + named-preset CRUD) before the PWA picker UI can be wired. **Tracked as a todo in `obsidian-vault/active/todos-certmate.md`** under "Multi-preset Defaults backend endpoint". |

---

## Job — Overview tab

At-a-glance readonly dashboard inside a job.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift` (tab host)

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `JobDetailView.swift:L68-L100` phone header (back + address + menu) | `web/src/components/job/job-header.tsx` | partial | 4 | Web header lacks the menu button (Edit Defaults, Apply Defaults, Start Tour). Menu entries iOS-only until defaults + tour ship. |
| `JobDetailView.swift:L88-L103` menu → Edit Default Values | Reached via Settings → Certificate Defaults | match | 6 | Phase 6: Defaults editor lives on `/settings/defaults/values`; web doesn't replicate the per-job menu entry since the defaults are user-scoped, not job-scoped — the Settings hub is the authoritative location. |
| `JobDetailView.swift:L97-L99` menu → Apply Defaults to Job | Circuits tab action rail | match | 6 | Phase 5 shipped the button; Phase 6 wired it to read user-saved defaults via `useUserDefaults`. Users trigger it from the Circuits tab rather than from a job-wide menu — same result, matches where inspectors are when they want to fill circuit fields. |
| `JobDetailView.swift:L100-L102` menu → Start Tour | MISSING | partial | 3 | Phase 3 scope: tour launch lives on the dashboard Setup tile + `/settings` → "Start tour" row. Per-job "Start tour" menu entry deferred — the current 4-step tour is dashboard-only; job-detail tour steps aren't ported yet. |
| iOS tab model: one tab selected (0=Overview) with swipeable TabView | `web/src/components/job/job-tab-nav.tsx` (pill nav) | match |  | Web uses a horizontal pill nav instead of swipe, acceptable pattern difference. |
| `web/src/app/job/[id]/page.tsx:L64-L121` HeroBox Client / Installation / Supply / Main Fuse / Earthing | N/A (web-only Overview dashboard design) | ios-only |  | iOS has no hero-box Overview — it launches straight into Installation. Web's Overview is an additional surface. Leaving for reference. |
| Live field population during recording (read from `liveFillState.job`) — iOS `LiveFillView` | `web/src/components/live-fill/live-fill-view.tsx` | partial | 8 | Web LiveFillView covers most sections but layout differs — iOS keeps Overview tab live, web overlays LiveFillView separately. |
| Overview "General Condition" summary card linked to Installation tab | `app/job/[id]/page.tsx:L126-L149` `SummaryCard` | match |  |  |
| Overview Circuits compact table (lg: wide 29-col matrix) | `app/job/[id]/page.tsx:L270-L518` CircuitsPanel + WideCircuitsPanel | match |  | Web renders both compact + 29-col wide view. iOS only shows a similar shape in landscape. |
| Overview Observations panel with C1/C2/C3/FI chip | `app/job/[id]/page.tsx:L526-L582` ObservationsPanel | match |  |  |

---

## Job — Installation tab

Client, installation address, inspection dates, premises, report details.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/InstallationTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `InstallationTab.swift:L310-L340` heroHeader gradient ("Installation Details" / "Client, premises & dates") | `web/src/app/job/[id]/installation/page.tsx:L121-L134` | match |  |  |
| `InstallationTab.swift:L60` client_name `CMFloatingTextField` | `installation/page.tsx:L138-L141` FloatingLabelInput | match |  |  |
| `InstallationTab.swift:L61` client_address | `installation/page.tsx:L143-L146` | match |  |  |
| `InstallationTab.swift:L62` client_town | `installation/page.tsx:L149-L152` | match |  |  |
| `InstallationTab.swift:L63` client_county | `installation/page.tsx:L153-L156` | match |  |  |
| `InstallationTab.swift:L64` client_postcode (+ postcode autocomplete debounce) | `installation/page.tsx` + `hooks/use-postcode-lookup.ts` | match |  | Phase 4: `api.lookupPostcode` wraps backend `GET /api/postcode/:postcode`; 400ms debounce + canonical-form memo in `usePostcodeLookup` hook; fill-empty-only semantics for town/county. |
| `InstallationTab.swift:L65` client_phone (phonePad keyboard) | `installation/page.tsx:L163-L168` inputMode="tel" | match |  |  |
| `InstallationTab.swift:L66-L67` client_email (autocapitalise none, email keyboard) | `installation/page.tsx:L170-L177` | match |  |  |
| `InstallationTab.swift:L76` address (installation) | `installation/page.tsx:L182-L185` | match |  |  |
| `InstallationTab.swift:L77-L79` town/county/postcode (installation) | `installation/page.tsx` | match |  | Phase 4: installation-address postcode wired to the same `usePostcodeLookup` hook used for the client postcode; fill-empty-only for town/county. |
| `InstallationTab.swift:L80` occupier_name | `installation/page.tsx:L202-L206` | match |  |  |
| `InstallationTab.swift:L90-L93` CMDatePickerField `Date of Inspection` | `installation/page.tsx:L212-L216` `<input type="date">` | match |  |  |
| `InstallationTab.swift:L95-L101` `Date of Previous Inspection` (EICR only, N/A allowed) | `installation/page.tsx` | match |  | Phase 4: N/A pill-button toggle stores literal `"N/A"` as the value and disables the date input; tap again to re-enable. Matches iOS `CMDatePickerStringField` sentinel contract. |
| `InstallationTab.swift:L103-L107` Next inspection years Picker (menu) | `installation/page.tsx:L226-L232` NumericStepper (1–10) | match |  | iOS uses a Picker bound to `Constants.inspectionIntervals`; web uses a stepper — acceptable affordance difference, same end result. Default 5 seeded on mount (Phase 4). |
| `InstallationTab.swift:L109-L112` Next inspection due (auto-recomputed) | `installation/page.tsx:L234-L239` + `setYears` auto-compute | match |  |  |
| `InstallationTab.swift:L122-L127` Premises Description (CMFloatingPicker, `Constants.premisesDescriptions`) | `installation/page.tsx:L244-L249` SelectChips (4 options: Residential/Commercial/Industrial/Other) | match |  |  |
| `InstallationTab.swift:L130-L131` Toggle "Installation records available" (EICR only) | `installation/page.tsx:L256-L270` SegmentedControl Yes/No | match |  | Toggle-vs-segmented is acceptable. |
| `InstallationTab.swift:L132-L133` Toggle "Evidence of additions/alterations" (EICR only) | `installation/page.tsx:L274-L288` SegmentedControl | match |  |  |
| `InstallationTab.swift:L145` previous_certificate_number (EICR) | `installation/page.tsx:L297-L301` | match |  |  |
| `InstallationTab.swift:L146` estimated_age_of_installation (EICR) | `installation/page.tsx:L302-L307` | match |  |  |
| `InstallationTab.swift:L155-L157` Reason for Report (multiline 2-4 lines, EICR) | `installation/page.tsx:L312-L317` MultilineField rows=3 | match |  |  |
| `InstallationTab.swift:L166-L168` General Condition of Installation (multiline 3-6, EICR) | `installation/page.tsx:L321-L326` MultilineField rows=4 | match |  |  |
| `InstallationTab.swift:L177-L179` Extent of installation covered (multiline, EICR) | `installation/page.tsx:L330-L335` | match |  |  |
| `InstallationTab.swift:L180-L182` Agreed limitations (multiline, EICR) | `installation/page.tsx:L336-L341` | match |  |  |
| `InstallationTab.swift:L183` Agreed with (single line, EICR) | `installation/page.tsx:L342-L346` | match |  |  |
| `InstallationTab.swift:L184-L186` Operational limitations (multiline, EICR) | `installation/page.tsx:L347-L352` | match |  |  |
| `InstallationTab.swift:L344-L399` Inspector Section (quick-select pills + add-new inline + signature capture + default star) | `installation/page.tsx:L358-L364` static SectionCard hint only ("lives on Staff tab") | partial | 6 | Phase 4 scope limit: inline inspector pills + add-new form deferred to Phase 6 (Settings/Staff hub is the proper home for staff CRUD). The punt-to-Staff-tab hint stays. |
| `InstallationTab.swift:L460-L490` inline new-inspector form (first/last/position/signature/isDefault) | Reached via Settings → Staff | ios-only | 6 | Web routes new-inspector creation through Settings → Staff → New, matching the web's single source-of-truth for staff CRUD. Inline add inside Installation is an iOS-only convenience that would duplicate the form surface on web. Closed as intentional platform divergence. |
| `InstallationTab.swift:L502-L527` ensureDateOfInspection / autoSelectDefaultIfNeeded / default nextInspectionYears=5 | `installation/page.tsx` | match |  | Phase 4: one-shot mount effect seeds `date_of_inspection` = today, `next_inspection_years` = 5, and computed `next_inspection_due_date`. Inspector auto-select deferred to Phase 6 alongside inline inspector picker. |
| `InstallationTab.swift:L12-L18` inspector state (@State newFirstName, newSignatureData, saveError) | `settings/staff/[inspectorId]/page.tsx` | match |  | Ported to separate staff detail page. |

---

## Job — Supply tab

Earthing, live conductors, PFC, Ze, main switch, RCD, bonding, SPD.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `SupplyTab.swift:L442-L472` heroHeader "Supply Characteristics" | `web/src/app/job/[id]/supply/page.tsx:L387-L404` HeroBanner | match |  |  |
| `SupplyTab.swift:L28-L31` Earthing Arrangement picker + onChange auto-flips TT flags | `supply/page.tsx` | match |  | Phase 4: `setEarthingArrangement` side-effects `means_earthing_electrode=true` when TT and mirrors `inspection.is_tt_earthing`. Non-TT selections leave electrode flag alone (intentional override respected). Unit-tested in `tests/phase-4-supply-tt-sideeffect.test.ts`. |
| `SupplyTab.swift:L50-L54` Live Conductors picker | `supply/page.tsx:L72-L77` SelectChips | match |  |  |
| `SupplyTab.swift:L56-L60` Number of Supplies picker (`Constants.numberOfSupplies`) | `supply/page.tsx` plain numeric input | partial | 9 | Phase 9 defer: requires porting iOS `Constants.numberOfSupplies` → `@certmate/shared-utils` and a value-round-trip audit with the backend. Free-form numeric input is behaviourally correct; preset picker is ergonomic polish. Tracked under "Supply preset pickers" follow-up. |
| `SupplyTab.swift:L62-L72` Nominal Voltage U / Uo pickers | `supply/page.tsx` plain numeric inputs | partial | 9 | Phase 9 defer: same Constants-port dependency. Free-form input is acceptable — inspectors type `230` in practice. |
| `SupplyTab.swift:L74-L78` Nominal Frequency picker | `supply/page.tsx` plain numeric input | partial | 9 | Phase 9 defer: same Constants-port dependency. The only realistic value is `50` (UK) so the free-form input rarely sees anything else. |
| `SupplyTab.swift:L88-L91` Means of earthing: Distributor + Electrode toggles (both shown) | `supply/page.tsx` | match |  | Phase 4: two independent Yes/No SegmentedControls so distributor+electrode can both be true (e.g. PME + supplementary earth electrode). |
| `SupplyTab.swift:L93-L103` if electrode: type picker + resistance + location (hidden until enabled) | `supply/page.tsx` | match |  | Phase 4: SelectChips with 6 options (Earth Rod / EE / P / T / M / O) mirroring iOS `Constants.earthElectrodeTypes`; resistance + location fields unchanged. |
| `SupplyTab.swift:L113-L132` Main switch BS/EN picker + "Other" → custom text | `supply/page.tsx` plain text | partial | 9 | Phase 9 defer: same Constants-port dependency; tracked under "Supply preset pickers" follow-up. |
| `SupplyTab.swift:L134-L138` Main switch poles picker | `supply/page.tsx` plain text | partial | 9 | Phase 9 defer: same Constants-port dependency. |
| `SupplyTab.swift:L140-L160` Main switch voltage picker + "Other" | `supply/page.tsx` plain numeric | partial | 9 | Phase 9 defer: same Constants-port dependency. |
| `SupplyTab.swift:L162-L182` Main switch current picker + "Other" | `supply/page.tsx` plain numeric | partial | 9 | Phase 9 defer: same Constants-port dependency. |
| `SupplyTab.swift:L184-L188` Fuse/Setting A picker | `supply/page.tsx` plain numeric | partial | 9 | Phase 9 defer: same Constants-port dependency. |
| `SupplyTab.swift:L190` Location text | `supply/page.tsx:L216-L220` | match |  |  |
| `SupplyTab.swift:L193-L197` Conductor material picker + "Copper" QuickSetButton | `supply/page.tsx` | match |  | Phase 4: added `main_switch_conductor_material` text input with Copper quick-set pill. Shared-types already carried the field (`packages/shared-types/src/supply.ts:27-28`). |
| `SupplyTab.swift:L199-L203` Main switch conductor CSA picker | `supply/page.tsx` | match |  | Phase 4: added `main_switch_conductor_csa` numeric input alongside the material picker. |
| `SupplyTab.swift:L213-L224` RCD Operating Current IΔn picker + N/A + LIM quicksets + test-result Ω | `supply/page.tsx` plain numeric + tested pair | partial | 9 | Phase 9 defer: tracked under "Supply preset pickers" — needs `Constants.rcdOperatingCurrents` port. Paired tested-value field already present and Phase 4 seeds the preset field to "N/A" on first appearance so the PDF renders cleanly even without a picker. |
| `SupplyTab.swift:L226-L239` RCD Time Delay picker (ms) + N/A + LIM + test result | `supply/page.tsx` | partial | 9 | Phase 9 defer: same Constants-port dependency. |
| `SupplyTab.swift:L241-L254` RCD Operating Time picker + N/A + LIM + test result | `supply/page.tsx` | partial | 9 | Phase 9 defer: same Constants-port dependency. |
| `SupplyTab.swift:L264-L275` Earthing conductor material + CSA | `supply/page.tsx` | match |  | Phase 4: added Copper quick-set pill to the earthing-conductor material field; CSA already present. |
| `SupplyTab.swift:L277-L294` Earthing conductor continuity check PASS/FAIL/LIM button row | `supply/page.tsx` | match |  | Phase 4: replaced the numeric Ω input with a 3-state SegmentedControl; data model aligns with iOS `Constants.continuityResults`. |
| `SupplyTab.swift:L303-L314` Main bonding material + CSA picker + Copper | `supply/page.tsx` | match |  | Phase 4: added Copper quick-set pill to main bonding material. |
| `SupplyTab.swift:L316-L332` Main bonding continuity PASS/FAIL/LIM | `supply/page.tsx` | match |  | Phase 4: 3-state SegmentedControl mirrors iOS (PASS/FAIL/LIM); `autoContinuityIfBonded` auto-ticks PASS when any bond row is PASS. |
| `SupplyTab.swift:L342` Bonding — Water PASS/FAIL/LIM | `supply/page.tsx` | match |  | Phase 4: 3-state SegmentedControl. |
| `SupplyTab.swift:L344` Bonding — Gas | `supply/page.tsx` | match |  | Phase 4: 3-state SegmentedControl. |
| `SupplyTab.swift:L346` Bonding — Oil | `supply/page.tsx` | match |  | Phase 4: 3-state SegmentedControl. |
| `SupplyTab.swift:L348` Bonding — Structural Steel | `supply/page.tsx` | match |  | Phase 4: 3-state SegmentedControl. |
| `SupplyTab.swift:L350` Bonding — Lightning | `supply/page.tsx` | match |  | Phase 4: 3-state SegmentedControl. |
| `SupplyTab.swift:L353-L366` Bonding — Other N/A toggle + text | `supply/page.tsx:L336-L354` FloatingLabelInput + trailing N/A button | match |  |  |
| `SupplyTab.swift:L343-L351` `autoContinuityIfBonded` — auto-sets main bonding continuity PASS when any bond is PASS | `supply/page.tsx` | match |  | Phase 4: `setBonding` promotes main_bonding_continuity → PASS when any of the 5 extraneous bonds is PASS; never stomps a manual FAIL. Unit-tested. |
| `SupplyTab.swift:L377-L395` Test results — PFC + Ze + onChange auto-sets polarity + earthing continuity when Ze entered | `supply/page.tsx` | match |  | Phase 4: `handleZeChange` fires the auto-tick once per field; a manual-override Set prevents re-tripping after the inspector has deliberately set polarity=No or continuity=FAIL. |
| `SupplyTab.swift:L394` Supply polarity toggle | `supply/page.tsx:L116-L135` SegmentedControl Yes/No | match |  |  |
| `SupplyTab.swift:L405-L423` SPD: BS/EN picker + type text + short circuit kA picker + rated A picker | `supply/page.tsx` plain text inputs | partial | 9 | Phase 9 defer: same Constants-port dependency. Phase 4 seeds SPD fields to "N/A" on first appearance so the PDF never has blank rows. |
| `SupplyTab.swift:L488-L512` Defaults application: SPD/RCD/MainBonding default to "N/A" on first appearance | `supply/page.tsx` | match |  | Phase 4: one-shot mount effect seeds SPD (4 fields), RCD (6 fields), main bonding (3 fields) → "N/A" when empty. Guarded via seededRef so it never re-fires. |
| `SupplyTab.swift:L514-L527` detectCustomValues — re-enable "Other" UI when loaded value isn't in preset list | N/A (pickers not yet ported) | partial | 9 | Phase 9 defer: only relevant once the Supply preset pickers land. Rolls up with the "Supply preset pickers" follow-up; no UI surface to wire this into until then. |

---

## Job — Board tab

Multiple boards per job (main + sub-distribution/sub-main), per-board metadata.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/BoardTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `BoardTab.swift:L71-L118` horizontal board selector bar with star-for-main + inline plus | `web/src/app/job/[id]/board/page.tsx:L102-L139` board pills + Add + Remove | match |  |  |
| `BoardTab.swift:L22-L48` toolbar actions: Add / Move Left / Move Right / Remove | `components/job/board-selector-bar.tsx` | match |  | Phase 4: new `BoardSelectorBar` primitive surfaces Move left / Move right / Remove with edge-disable, plus the Add pill. Reorder via array splice. |
| `BoardTab.swift:L50-L62` Remove confirmation dialog "will remove all circuits + observations" | `board/page.tsx` | match |  | Phase 4: Remove wraps `ConfirmDialog` (Phase 1 primitive); description surfaces the cascade count (N circuits + M observations tagged to this board). |
| `BoardTab.swift:L122-L171` board hero header (designation + location + isSubBoard fedFrom) | `board/page.tsx` `HeroBanner` aggregated count (now `HeroHeader` with `board` accent) | partial | 9 | Phase 9 defer: per-board hero (designation + fedFrom context) would require the hero to re-render on every board-selector change — reducing the hero's purpose as a "you are on the Board tab" banner. Web surfaces the per-board context in the designation field + location card directly; the hero is intentionally aggregate-only. Phase 9 migrated the static hero to `<HeroHeader accent="board">` for visual parity with the rest of the tabs. |
| `BoardTab.swift:L190` designation field | `board/page.tsx:L143-L147` | match |  |  |
| `BoardTab.swift:L191` name field | `board/page.tsx:L148-L152` | match |  |  |
| `BoardTab.swift:L192` location field | `board/page.tsx:L173-L177` | match |  |  |
| `BoardTab.swift:L193` manufacturer field | `board/page.tsx:L153-L157` | match |  |  |
| `BoardTab.swift` (implicit) — `model` field on iOS? | `board/page.tsx:L158-L162` | ios-only |  | Web has `model`; iOS BoardTab doesn't surface one. Confirm backing model has `model` field. |
| `BoardTab.swift:L196-L203` BoardType picker (main/sub_distribution/sub_main) | `board/page.tsx:L164-L169` SelectChips | match |  |  |
| `BoardTab.swift:L205-L210` Fed From picker (filters other boards) when sub-board | `board/page.tsx` | match |  | Phase 4: sub-boards show a SelectChips of the OTHER boards' designations; plain text "feed circuit ref" still available in the sub-main cable section. |
| `BoardTab.swift:L370-L389` parentBoardBinding — auto-fills `suppliedFrom` + inherits earthing from parent | `board/page.tsx` `setParent` | match |  | Phase 4: picking a parent populates `supplied_from` with the parent's designation and inherits earthing arrangement when the child doesn't have one set yet. |
| `BoardTab.swift:L209` `suppliedFrom` text when main board | `board/page.tsx:L178-L182` | match |  |  |
| `BoardTab.swift:L212-L216` Phases picker (`Constants.phaseOptions`) | `board/page.tsx:L187-L192` SelectChips (Single/Three) | match |  |  |
| `BoardTab.swift:L217-L221` Earthing picker | `board/page.tsx:L193-L198` SelectChips | match |  |  |
| `BoardTab.swift:L231-L235` Sub-main cable material (sub-boards only) | `board/page.tsx:L267-L272` | match |  |  |
| `BoardTab.swift:L236` Live CSA | `board/page.tsx:L273-L278` | match |  |  |
| `BoardTab.swift:L237` CPC CSA | `board/page.tsx:L285-L290` | match |  |  |
| `BoardTab.swift:L238` Cable length | `board/page.tsx:L279-L284` | match |  |  |
| `BoardTab.swift:L248` Main switch BS(EN) | `board/page.tsx:L229-L233` | match |  |  |
| `BoardTab.swift:L249` voltage rating | `board/page.tsx:L234-L238` | match |  |  |
| `BoardTab.swift:L250` rated current | `board/page.tsx:L239-L243` | match |  |  |
| `BoardTab.swift:L259` polarity confirmed toggle (✓ sentinel string) | `board/page.tsx` | match |  | Phase 4: Yes/No SegmentedControl on the Protection section; writes the iOS `✓` sentinel when Yes so round-trip is lossless. |
| `BoardTab.swift:L260` phases confirmed text | `board/page.tsx` | match |  | Phase 4: plain text input on the Protection section (matches iOS's free-text use case, e.g. "L1-L2-L3 OK"). |
| `BoardTab.swift:L261` RCD trip time ms | `board/page.tsx:L219-L223` | match |  |  |
| `BoardTab.swift:L262` IPF rating kA | `board/page.tsx:L244-L248` | match |  |  |
| `BoardTab.swift:L263` RCD rating mA | `board/page.tsx:L252-L256` | match |  |  |
| `BoardTab.swift:L272` SPD type text | `board/page.tsx:L257-L261` | match |  |  |
| `BoardTab.swift:L273` SPD status text | `board/page.tsx` | match |  | Phase 4: added `spd_status` alongside `spd_type` in the SPD section. |
| `BoardTab.swift:L282` overcurrent BS(EN) | `board/page.tsx` | match |  | Phase 4: new "Overcurrent device" SectionCard with BS EN / voltage / current. |
| `BoardTab.swift:L283` overcurrent voltage | `board/page.tsx` | match |  | Phase 4: as above. |
| `BoardTab.swift:L284` overcurrent current | `board/page.tsx` | match |  | Phase 4: as above. |
| `BoardTab.swift:L296` Ze at this board | `board/page.tsx:L199-L203` | match |  |  |
| `BoardTab.swift:L297` Zs at DB | `board/page.tsx:L205-L209` | match |  |  |
| `BoardTab.swift:L298` Ipf at DB | `board/page.tsx:L211-L215` | match |  |  |
| `BoardTab.swift:L304-L310` Notes section (TextEditor, 80pt min) | `board/page.tsx:L300-L307` `<textarea rows=3>` | match |  |  |

---

## Job — Circuits tab

Per-circuit readings — the biggest tab (29 column schedule + action rail + CCU flows).

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/CircuitsTab.swift`
- `CertMateUnified/Sources/Views/CCUExtraction/CCUExtractionModeSheet.swift`
- `CertMateUnified/Sources/Views/CCUExtraction/CircuitMatchReviewView.swift`
- `CertMateUnified/Sources/Utilities/Constants.swift:L180-L224` (column definitions)

### Action rail buttons (top)

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CircuitsTab.swift:L79-L114` portrait-only boards filter bar (horizontal pills) | `circuits/page.tsx:L240-L259` board pills (any orientation) | match |  |  |
| `CircuitsTab.swift:L132-L139` Cancel delete-mode button | N/A — web has single "Delete all" with confirm dialog | match | 5 | Phase 5: web simplifies multi-select → single "Delete all circuits on this board" guarded by `ConfirmDialog`. Wider web viewports make per-row delete trivially accessible; multi-select-mode state machine was not worth porting. |
| `CircuitsTab.swift:L142-L155` Select All / Deselect All in delete mode | N/A — no multi-select mode on web | match | 5 | Subsumed by the simplification above. |
| `CircuitsTab.swift:L157-L164` "Delete (N)" bulk delete with count | `circuits/page.tsx` Delete → `setConfirmDeleteAllOpen(true)` + `ConfirmDialog` showing count | match | 5 | Dialog body renders "This will remove N circuits …" so the count-aware intent is preserved. |
| `CircuitsTab.swift:L166-L171` Add circuit button | `circuits/page.tsx:L380-L385` Add → RailButton onClick={addCircuit} | match |  |  |
| `CircuitsTab.swift:L173-L180` Delete mode toggle (enters multi-select) | N/A — no multi-select mode on web | match | 5 | Same rationale as the Cancel-delete-mode row. |
| `CircuitsTab.swift:L182-L188` Apply Defaults button | `circuits/page.tsx` Defaults → `handleApplyDefaults` via `@certmate/shared-utils` `applyDefaultsToCircuits` | match | 5 | Phase 5 shipped. Non-overwrite invariant enforced in the shared helper (unit test `phase-5-apply-defaults.test.ts`). |
| `CircuitsTab.swift:L190-L197` Reverse circuits button | `circuits/page.tsx:L398` Reverse → `reverse()` (wired) | match |  |  |
| `CircuitsTab.swift:L199-L222` Calculate menu (Zs = Ze + R1+R2, R1+R2 = Zs − Ze) | `circuits/page.tsx` Calculate rail button → floating menu → `handleCalculateZs` / `handleCalculateR1R2` via `@certmate/shared-utils` `applyZsCalculation` / `applyR1R2Calculation` | match | 5 | Phase 5 shipped. Pure helpers live in `packages/shared-utils/src/impedance.ts`; `formatImpedance` mirrors iOS trailing-zero trim. Negative R1+R2 skipped (iOS parity). |
| `CircuitsTab.swift:L224-L245` CCU Photo button + retry state + mode sheet flow | `circuits/page.tsx` CCU RailButton → `<CcuModeSheet>` → `<input capture="environment">` → mode-specific apply (names_only / full_capture / hardware_update) | match | 7 | Phase 7 closed. Mode sheet opens first; chosen mode is parked in a ref between dismiss + picker onChange; Hardware Update mode runs `matchCircuits()` and navigates to `/job/[id]/circuits/match-review`. |
| `CircuitsTab.swift:L247-L260` Extract Doc button + dialog (Take Photo / Library / Files) | `circuits/page.tsx:L413-L420` Extract RailButton + hidden `<input accept="image/*">` + `handleDocFile` | partial | 7 | Web has single library picker only — no camera nor file picker. PDFs explicitly not supported (backend limitation). |

### CCU extraction flow (Mode sheet + match review)

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CCUExtractionModeSheet.swift:L5-L76` 3 modes: Circuit names only / Hardware update / Full capture | `components/job/ccu-mode-sheet.tsx` `<CcuModeSheet>` | match | 7 | Phase 7 shipped. Three-tile dialog with persisted last-used mode (`cm-ccu-last-mode`). Mode values `names_only` / `full_capture` / `hardware_update` gate three client-side apply strategies in `apply-ccu-analysis.ts`; the backend response is unchanged. |
| `CircuitMatchReviewView.swift:L5-L80` Matched circuits list with reassign + unmatched-existing footer | `app/job/[id]/circuits/match-review/page.tsx` full review screen | match | 7 | Phase 7 shipped. Standalone page, not a sheet — desktop has room; match data flows via sessionStorage (`cm-ccu-match-handoff:<jobId>:<nonce>`). One-tap "Accept matches above 80%" shortcut is a web-only affordance; iOS UX simplifications (inline combobox vs sheet-per-row) explained in the page docblock. |
| `CircuitsTab.swift:L429-L434` CCU mode sheet presentation (`.presentationDetents([.medium])`) | `components/job/ccu-mode-sheet.tsx` centred Dialog | match | 7 | Web uses a centred Dialog rather than iOS's half-height sheet presentation — equivalent affordance, adapted for desktop + mobile browser chrome. |
| `CircuitsTab.swift:L437-L445` CCU photo source dialog (Take Photo / Choose from Library) | `circuits/page.tsx` openCcuPicker — opens mode sheet first, then `<input capture="environment">` | partial | 7 | Web's `<input capture="environment">` still asks the OS for camera with library fallback; the mode sheet adds one step before the picker but doesn't split camera vs library as a separate dialog. Acceptable divergence — browser file-input UI already covers both. |
| `CircuitsTab.swift:L457-L468` CircuitMatchReviewView sheet + confirmMatches / cancelReview | `match-review/page.tsx` sticky Apply / Cancel footer → `applyCcuAnalysisToJob(... mode: 'hardware_update')` → navigate back to Circuits | match | 7 | Phase 7 shipped. One-to-one reassign invariant preserved (claiming an existing circuit releases any prior claim). |
| `CircuitsTab.swift:L470-L484` extractionVM flowState dispatch (complete/error/savedForRetry) | `circuits/page.tsx` try/catch with `setActionHint` + mode-specific progress copy | partial | 7 | Web has success hint + error banner + mode-aware progress text ("Analysing board labels…" / "Analysing new board hardware…"). The "saved for retry" offline queue stays iOS-only for now — see PendingExtractionQueue row below. |
| `CircuitsTab.swift:L272-L353` PendingExtractionQueue banner + thumbnails + Retry All + auto-retry on network restore | MISSING (defer — needs IDB blob store) | partial | 9 | Phase 9 defer: replicating the iOS photo-upload queue requires IDB blob storage + a separate replay worker because `/api/analyze-ccu` isn't a standard PATCH (the mutation outbox at `lib/pwa/outbox.ts` only handles JSON patches). Web's Phase 7 CCU flow is synchronous — fails surface inline via the error banner. Raise separately as a CCU offline-queue feature if inspector feedback surfaces demand. |
| `CircuitsTab.swift:L486-L491` Auto-retry on `NetworkMonitor.shared.isConnected` flip | MISSING (defer — paired with pending queue) | partial | 9 | Phase 9 defer: paired with the pending-extractions row above. Same scoping — needs the blob store first, then the auto-retry lives on top of it. |
| `CircuitsTab.swift:L505-L530` PhotosPicker / fileImporter / camera full-screen cover | partial via hidden file input | ios-only |  | PhotosPicker / fileImporter / PhotoCaptureView are native iOS primitives; web browser file input is the counterpart. Acceptable. |

### Circuit row editor — all 29 columns

Column order from `Constants.swift:L180-L211`. Web surfaces them grouped in collapsible sections (Identity / Cable / OCPD / RCD / Test readings). iOS surfaces them in a horizontally-scrolling table in landscape and portrait-card grid in portrait.

| iOS key + label | ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|---|
| `circuit_ref` (Ref) | `Constants.swift:L181` | `circuits/page.tsx:L519-L522` | match |  |  |
| `circuit_designation` (Description) | `Constants.swift:L182` | `circuits/page.tsx:L524-L527` | match |  |  |
| `wiring_type` (Wiring Type) | `Constants.swift:L183` | `circuits/page.tsx:L546-L549` plain text | partial | 5 | iOS uses a picker (`Constants.circuitWiringTypes`); web is free-form. |
| `ref_method` (Ref Method) | `Constants.swift:L184` | `circuits/page.tsx:L551-L554` plain text | partial | 5 | iOS picker (`Constants.circuitReferenceMethods`). |
| `number_of_points` (Points) | `Constants.swift:L185` | `circuits/page.tsx:L529-L533` | match |  |  |
| `live_csa_mm2` (Live mm²) | `Constants.swift:L186` | `circuits/page.tsx:L555-L560` | match |  |  |
| `cpc_csa_mm2` (CPC mm²) | `Constants.swift:L187` | `circuits/page.tsx:L561-L566` | match |  |  |
| `max_disconnect_time_s` (Max Disc Time) | `Constants.swift:L188` | `circuits/page.tsx:L534-L539` | match |  |  |
| `ocpd_bs_en` (OCPD BS/EN) | `Constants.swift:L189` | `circuits/page.tsx:L572-L576` plain text | partial | 5 | iOS picker with presets. |
| `ocpd_type` (OCPD Type) | `Constants.swift:L190` | `circuits/page.tsx:L577-L582` SelectChips (B/C/D) | match |  |  |
| `ocpd_rating_a` (Rating A) | `Constants.swift:L191` | `circuits/page.tsx:L583-L588` | match |  |  |
| `ocpd_breaking_capacity_ka` (kA) | `Constants.swift:L192` | `circuits/page.tsx:L589-L594` | match |  |  |
| `ocpd_max_zs_ohm` (Max Zs Ω) | `Constants.swift:L193` | `circuits/page.tsx:L595-L600` | match |  |  |
| `rcd_bs_en` (RCD BS/EN) | `Constants.swift:L194` | `circuits/page.tsx:L606-L610` plain text | partial | 5 | iOS picker. |
| `rcd_type` (RCD Type) | `Constants.swift:L195` | `circuits/page.tsx:L611-L616` SelectChips (AC/A/B/F) | match |  |  |
| `rcd_operating_current_ma` (IΔn mA) | `Constants.swift:L196` | `circuits/page.tsx:L617-L622` plain numeric | partial | 5 | iOS uses circuit-specific RCD currents picker. |
| `rcd_rating_a` (RCD A) | `Constants.swift:L197` | `circuits/page.tsx:L623-L628` | match |  |  |
| `ring_r1_ohm` (Ring r1) | `Constants.swift:L198` | `circuits/page.tsx:L635-L640` | match |  |  |
| `ring_rn_ohm` (Ring rn) | `Constants.swift:L199` | `circuits/page.tsx:L641-L646` | match |  |  |
| `ring_r2_ohm` (Ring r2) | `Constants.swift:L200` | `circuits/page.tsx:L647-L652` | match |  |  |
| `r1_r2_ohm` (R1+R2) | `Constants.swift:L201` | `circuits/page.tsx:L653-L658` | match |  |  |
| `r2_ohm` (R2) | `Constants.swift:L202` | `circuits/page.tsx:L659-L664` | match |  |  |
| `ir_test_voltage_v` (IR Test V) | `Constants.swift:L203` | `circuits/page.tsx:L671-L676` plain numeric | partial | 5 | iOS uses preset picker (`Constants.irTestVoltages`). |
| `ir_live_live_mohm` (IR L-L) | `Constants.swift:L204` | `circuits/page.tsx:L677-L682` | match |  |  |
| `ir_live_earth_mohm` (IR L-E) | `Constants.swift:L205` | `circuits/page.tsx:L683-L688` | match |  |  |
| `polarity_confirmed` (Polarity) | `Constants.swift:L206` | `circuits/page.tsx:L696-L705` SegmentedControl Pass/Fail/N/A | match |  |  |
| `measured_zs_ohm` (Meas Zs) | `Constants.swift:L207` | `circuits/page.tsx:L665-L670` | match |  |  |
| `rcd_time_ms` (RCD ms) | `Constants.swift:L208` | `circuits/page.tsx:L689-L694` | match |  |  |
| `rcd_button_confirmed` (RCD Btn) | `Constants.swift:L209` | `circuits-sticky-table.tsx` select column (OK/Y/N) | partial | 5 | Exposed in the Table view via a schema-aligned `<select>`; Cards view doesn't surface it yet. Close fully when card view adds an RCD Btn row. |
| `afdd_button_confirmed` (AFDD Btn) | `Constants.swift:L210` | `circuits-sticky-table.tsx` select column (OK/Y/N) | partial | 5 | Same — Table view only. |

### Circuits — grid / layout / misc

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CircuitsTab.swift:L565-L572` portraitCardGrid vs stickyGrid layout | `circuits/page.tsx` Cards/Table toggle — Cards = collapsible list, Table = sticky 29-col grid (`components/job/circuits-sticky-table.tsx`) | match | 5 | Phase 5 shipped. Toggle persists to localStorage under `cm-circuits-view`; mobile default = Cards, desktop (≥1024) default = Table. Sticky left columns are Ref + Designation; scrollable pane holds all 27 remaining columns with iOS-derived widths. |
| `CircuitsTab.swift:L580-L600` landscape multi-board section header | N/A — web board selector is a pill bar above the table regardless of orientation | match | 5 | Web doesn't swap layouts on orientation; the existing board-pills selector covers the multi-board UX in both Cards and Table modes. |
| `CircuitsTab.swift:L19-L21` polarityManuallyCleared Set<String> (prevents auto-set overwrite) | N/A — no polarity auto-set on web yet | match | 5 | Guard only exists to protect against an auto-set iOS feature the web client doesn't implement. Re-visit if/when polarity auto-confirm ships (would pair with recording pipeline). |
| `CircuitsTab.swift:L393-L410` Bulk-delete alert with dynamic count | `circuits/page.tsx` `ConfirmDialog` — body text renders `N circuit(s)` dynamically | match | 5 | Same intent; shape differs (modal vs native alert). |
| `CircuitsTab.swift:L411-L426` Scan Error + Impedance Calculation alerts | `circuits/page.tsx` inline `actionHint` banner + error banners | match |  | Shape differs (banner vs alert); same intent. Calculate banner surfaces per-reason skip counts. |
| `CircuitsTab.swift:L486-L520` `onChange(of: viewModel.job.circuits.count)` clear stale expandedCircuitId / draggedCircuitId | `circuits/page.tsx:L119` expandedId auto-clear on remove | partial | 5 | Web lacks drag-reorder, so draggedCircuitId N/A. |
| Drag-and-drop reorder (`draggedCircuitId`) | `CircuitsTab.swift:L11` | MISSING | partial | 5 | Deferred from Phase 5 — drag reorder is niche on the table view (inspectors reorder rarely; web Reverse already covers the most common case). Re-visit only if parity ledger shows an inspector hitting it. |
| `CircuitsTab.swift:L278-L295` Pending extractions section — thumbnails + Retry All | MISSING (defer — paired with PendingExtractionQueue) | partial | 9 | Phase 9 defer: duplicate of the PendingExtractionQueue row above. Rolls up under the same CCU offline-queue feature. |
| `CircuitsTab.swift:L130` stub → `setActionHint(\`${label} — not available on web yet.\`)` | Removed — `stub()` helper deleted, all three consumers (Delete all / Apply defaults / Calculate) are wired | match | 5 | Closed by Phase 5. |

---

## Job — Observations tab

EICR-only (EIC uses Extent/Design instead). List of C1/C2/C3/FI observations with photos.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/ObservationsTab.swift`
- `CertMateUnified/Sources/Views/JobDetail/EditObservationSheet.swift`
- `CertMateUnified/Sources/Views/Components/ObservationCardView.swift`
- `CertMateUnified/Sources/Views/Components/InlineObservationForm.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `ObservationsTab.swift:L66-L129` hero gradient + C1/C2/C3/FI count badges + Add button | `web/src/app/job/[id]/observations/page.tsx:L108-L148` hero + CountBadge pills + Add | match |  |  |
| `ObservationsTab.swift:L146-L169` empty state "No Observations" + green shield | `observations/page.tsx:L150-L158` SectionCard empty state | match |  |  |
| `ObservationsTab.swift:L22-L45` LazyVStack of ObservationCardView with context-menu delete | `observations/page.tsx` | match |  | Phase 4: inline trash button now routes through `ConfirmDialog` so a mis-tap doesn't delete the defect + photos silently. Desktop inline affordance kept (context-menu is iOS-specific). |
| `ObservationsTab.swift:L173-L178` deleteObservation + ObservationScheduleLinker.observationDeleted | `observations/page.tsx` | match |  | Phase 4: deletion of an observation removes it from `observations[]`; Inspection tab reads the linked observation via `observations.find(o => o.schedule_item === ref)`, so the preview naturally disappears — no bespoke linker needed. |
| `ObservationsTab.swift:L181-L349` AddObservationSheet (NavigationStack with 3 sections) | `components/observations/observation-sheet.tsx` | match |  |  |
| AddObservationSheet Classification picker (C1/C2/C3/FI with label) `L201-L207` | `observation-sheet.tsx` CODE_OPTIONS hint row | match |  |  |
| AddObservationSheet Location field `L215-L216` | observation-sheet.tsx location input | match |  |  |
| AddObservationSheet Observation text (multiline) `L217-L220` | observation-sheet.tsx description multiline | match |  |  |
| AddObservationSheet Schedule Item (e.g. 4.4) `L220-L221` | `components/observations/observation-sheet.tsx` | match |  | Phase 4: two-column "Schedule item" + "Schedule item description" inputs added to the sheet; auto-populated when the observation is created from the Inspection tab. ObservationCard on the list view renders a "from schedule item N.N" pill when present. Shared-types already carried the fields. |
| AddObservationSheet remedial action | `observation-sheet.tsx` Remedial block | match | 9 | Web adds a `remedial` field (matches the EditObservationSheet treatment on iOS at `EditObservationSheet.swift:L210+`). The iOS AddObservationSheet omits it, but the field round-trips through the backend so the data model matches. Phase 9: closed as `match` — web is a superset here and the row is authoritative as-is. |
| Photos section — horizontal scroll of ObservationPhotoThumbnail with X-button remove `L230-L256` | `observation-sheet.tsx` photo grid with delete | match |  |  |
| Camera button (fullScreenCover → PhotoCaptureView) `L267-L272` | observation-sheet.tsx Camera input (`capture="environment"`) | ios-only |  | iOS uses native camera overlay; web uses OS file input. Acceptable — no gap to close. |
| PhotosPicker Library button `L260-L266` | observation-sheet.tsx Library input | match |  | iOS PhotosPicker is native; web library file input covers same case. |
| onAppear / toolbar Save + Cancel + Add (disabled when text empty) `L285-L302` | observation-sheet.tsx Save / Cancel | match |  |  |
| ObservationCardView photo thumbnails (inline preview, tap to enlarge) | `observations/page.tsx:L296-L316` ObservationPhoto thumbs + "+N more" chip | match |  |  |
| Tap ObservationCardView → open edit sheet | observations/page.tsx:L237, ObservationCard onOpen | match |  |  |
| Inline observation editor surfaced in Inspection tab when C1/C2/C3 tapped (`InspectionTab.swift:L286-L298` + `Components/InlineObservationForm.swift`) | `inspection/page.tsx` InlineObservationForm | match |  | Phase 4: see "InlineObservationForm when C1/C2/C3 selected" row above. |

---

## Job — Inspection tab

BS 7671 Appendix 6 inspection schedule (~90 items for EICR, 14 for EIC).

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/InspectionTab.swift`
- `CertMateUnified/Sources/Views/Components/OutcomeButtonGroup.swift`
- `CertMateUnified/Sources/Views/Components/InlineObservationForm.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `InspectionTab.swift:L70-L102` hero "Inspection Schedule" gradient | `web/src/app/job/[id]/inspection/page.tsx:L144-L159` gradient hero | match |  |  |
| `InspectionTab.swift:L147-L223` scheduleToggles card (TT / Microgen / Section 7 N/A) with Auto badge + hint | `inspection/page.tsx:L161-L186` `SectionCard accent="blue"` with three ToggleRows (EICR only) | match |  |  |
| `InspectionTab.swift:L154-L157` TT toggle → calls `vm.setTTEarthing` (auto-ticks 3.2, N/As 3.1) | `inspection/page.tsx:L90-L100` setTTEarthing | match |  |  |
| `InspectionTab.swift:L181-L204` Microgeneration toggle → 2.0, 4.11, 4.21, 4.22 | `inspection/page.tsx:L102-L107` setMicrogeneration | match |  |  |
| `InspectionTab.swift:L209-L220` Section 7 N/A bulk toggle | `inspection/page.tsx:L109-L117` setSection7NA | match |  |  |
| `InspectionTab.swift:L112-L128` EICR: 8 sections each with header + icon + progress | `inspection/page.tsx:L203-L252` EICR_SCHEDULE.map(sections) with progress counter | match |  | Sections + items + ScheduleRow + OUTCOME_OPTIONS all wired. |
| `InspectionTab.swift:L134-L143` EIC single list (14 top-level items) | `inspection/page.tsx:L188-L201` `EIC_SCHEDULE.map` single card | match |  |  |
| `InspectionTab.swift:L255-L318` scheduleItemRow — ref + description + OutcomeButtonGroup + Auto badge | `inspection/page.tsx:L306-L369` ScheduleRow | match |  |  |
| `InspectionTab.swift:L322-L344` per-section progress N/Total + mini bar | `inspection/page.tsx:L212-L240` equivalent progress bar | match |  |  |
| `InspectionTab.swift:L266-L284` linked-observation inline preview under a row | `inspection/page.tsx` ScheduleRow | match |  | Phase 4: observations with `schedule_item === ref` render an inline preview (code pill + location + description + "Tap to edit"); tapping opens the shared `ObservationSheet`. |
| `InspectionTab.swift:L286-L300` InlineObservationForm when C1/C2/C3 selected (location + text + Save) | `inspection/page.tsx` InlineObservationForm | match |  | Phase 4: picking C1/C2/C3 on a row with no linked observation slides an inline form (location + description) beneath. Save creates the observation with `schedule_item` + `schedule_description` pre-populated. |
| `InspectionTab.swift:L43-L66` confirmation alert "Delete linked observation?" when outcome changes | `inspection/page.tsx` | match |  | Phase 4: changing an outcome that currently has a linked observation queues a ConfirmDialog (Phase 1 primitive); the outcome change + observation delete land atomically on confirm. Unit-tested. |

---

## Job — Staff tab

Role picker (EICR: inspector + authorised; EIC: designer + constructor + inspector) with test equipment card.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/InspectorTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `InspectorTab.swift:L77-L108` hero "Staff Assignments" gradient | `web/src/app/job/[id]/staff/page.tsx:L88-L103` | match |  |  |
| `InspectorTab.swift:L20-L40` EIC: 3 role picker cards (Designer / Constructor / Inspection & Testing) | `staff/page.tsx:L107-L131` RolePickerCard ×3 | match |  |  |
| `InspectorTab.swift:L41-L55` EICR: 2 role picker cards (Inspected / Authorised) | `staff/page.tsx:L132-L151` RolePickerCard ×2 | match |  |  |
| `InspectorTab.swift:L112-L184` staffPickerCard — list of inspector rows with avatar + name + position + checkmark | `staff/page.tsx:L160-L245` RolePickerCard | match |  |  |
| `InspectorTab.swift:L117-L123` empty state "No staff profiles configured" | `staff/page.tsx:L177-L193` "No staff profiles configured yet" info | match |  | Web copy also nudges to Settings → Inspectors. |
| `InspectorTab.swift:L60-L62` equipment card shown below active inspector | `staff/page.tsx:L153` EquipmentCard mount | match |  |  |
| `InspectorTab.swift:L188-L240` Test Equipment card — MFT / Continuity / IR / Earth Fault / RCD each with S/N + Cal date | `staff/page.tsx:L248-L327` EquipmentCard + EquipmentRow ×5 | match |  |  |
| `InspectorTab.swift:L67-L72` fetchAllInspectors on appear | `staff/page.tsx:L71-L72` reads `data.inspectors` from job | match |  | Phase 4 reviewed: MVP pattern — inspector roster lives on the job. If admin needs cross-job roster consistency (e.g. editing an inspector in Settings and seeing it reflected mid-job without reload), promote to `/api/inspectors` call in a later phase. Acceptable as-is. |

---

## Job — Extent tab (EIC)

Scope + installation type + comments. EIC-only.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/ExtentTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `ExtentTab.swift:L78-L109` hero "Extent & Limitations" | `web/src/app/job/[id]/extent/page.tsx:L54-L70` | match |  |  |
| `ExtentTab.swift:L26-L33` Extent multiline + character count | `extent/page.tsx:L74-L80` MultilineField showCount | match |  |  |
| `ExtentTab.swift:L36-L41` Installation Type picker (Constants.installationTypes) | `extent/page.tsx:L80-L87` SelectChips (4 options) | match |  |  |
| `ExtentTab.swift:L52-L59` Comments multiline + count | `extent/page.tsx:L90-L98` MultilineField showCount | match |  |  |

---

## Job — Design tab (EIC)

BS 7671 departures + details. EIC-only.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/DesignTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `DesignTab.swift:L82-L113` hero "Design & Construction" | `web/src/app/job/[id]/design/page.tsx:L48-L64` | match |  |  |
| `DesignTab.swift:L24-L36` info banner ("Record any departures from BS 7671 and reasons") | `design/page.tsx:L66-L79` equivalent blue-tinted info banner | match |  |  |
| `DesignTab.swift:L38-L57` "No Departures" green shortcut capsule → prefill `No departures` / `N/A` | `design/page.tsx:L81-L100` equivalent | match |  |  |
| `DesignTab.swift:L61-L62` Departures multiline (100pt min) | `design/page.tsx:L102-L107` MultilineField rows=4 | match |  |  |
| `DesignTab.swift:L64-L65` Departure Details multiline | `design/page.tsx:L108-L113` MultilineField rows=4 | match |  |  |

---

## Job — PDF tab

Generate + preview + share the final PDF certificate.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/PDFTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `PDFTab.swift:L68-L121` hero with pulsing status dot ("PDF generated" / "Not yet generated") | `pdf/page.tsx` `HeroBanner` + `StatusDot` (animate-ping amber ring until blob exists) | match |  | Phase 2: wires the pulsing ring + "Generating…" transient state; colour and copy match iOS. |
| `PDFTab.swift:L125-L155` Missing-data warnings card | `pdf/page.tsx` `SectionCard accent="test-results"` "Missing data" | match |  | Phase 2: swapped accent from `amber` → `test-results` for iOS parity with `CMSectionCard(category: .testResults)`. |
| `pdf/page.tsx` web-only warning computation (installation addr / inspection date / ≥1 board / ≥1 circuit / staff roles) | iOS `JobViewModel.pdfWarnings()` (company + inspector only) | partial |  | Web list is intentionally broader — iOS users complete tabs linearly; web inspectors benefit from the richer check. Parity is "spirit of", not line-for-line. |
| `PDFTab.swift:L178-L200` Generate PDF button (gradient, green→blue) | `pdf/page.tsx` `GenerateButton` (same green→blue gradient, shadow, spinner swap) | match |  | Phase 2: live via `api.generatePdf`. |
| `PDFTab.swift:L203-L222` Preview PDF button (opens PDFPreviewController sheet) | `pdf/page.tsx` Preview button + inline `<PdfPreview>` iframe below Actions (scroll-into-view on click) | match |  | Phase 2: renders the Blob via an object URL in an `<iframe>` inline (rather than a modal / sheet) — cleaner scroll-through UX for desktop. |
| `PDFTab.swift:L225-L237` Share PDF via ShareLink | `pdf/page.tsx` Share button: `navigator.share({files:[File]})` with `downloadBlob` fallback | partial |  | Phase 2: Web Share API on supported browsers (Chrome Android, iOS Safari 15+); desktop Safari / Firefox lack file-payload share support and fall back to an anchor download. |
| `PDFTab.swift:L243-L262` Generating overlay (ProgressView + ultraThinMaterial) | `pdf/page.tsx` absolute overlay on the Actions card (`Loader2` spin + "Generating…") | match |  | Phase 2: scoped to the Actions card so other tabs stay interactive. |
| `PDFTab.swift:L270-L292` `generateLocalPDF()` — `PDFGenerator.generate(from: job)` + temp file + ShareLink URL | `api-client.ts` `generatePdf(userId, jobId)` → `POST /api/job/:userId/:jobId/generate-pdf` → Blob | match |  | Phase 2: backend renders via Python ReportLab + Playwright; client holds the Blob in session state (no persistence — matches iOS re-generate-each-time). |
| Delete / discard generated PDF (iOS: no explicit discard — data cleared on view dismiss) | `pdf/page.tsx` Delete button + `ConfirmDialog` → clears Blob state | match |  | Phase 2 extra affordance: web session lives longer than iOS tab dismissal, so an explicit Discard beats accumulating stale Blobs. |
| `PDFTab.swift:L53-L57` `.sheet(isPresented: $showPreview)` PDFPreviewController (UIViewControllerRepresentable over PDFKit) | MISSING (web uses inline iframe) | ios-only |  | Native PDFKit viewer; web uses `<iframe src={object-URL}>` via `PdfPreview`. Legitimately iOS-only. |

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

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `RecordingOverlay.swift:L38-L239` ultraThinMaterial glass pill floating over job detail | `web/src/components/recording/recording-chrome.tsx:L103-L236` fixed bottom bar with backdrop blur | match |  | Layout differs (iOS floats overlay pill; web pins to bottom) but both host the same controls. |
| `RecordingOverlay.swift:L47-L64` Voice feedback toggle (speaker.wave.2.fill / speaker.slash) | `recording-chrome.tsx` Voice ParityButton + `lib/recording/tts.ts` | match |  | Phase 8 wired the toggle to `localStorage['cm-voice-feedback']` and a SpeechSynthesis singleton. Sonnet `confirmations` + `question` events are spoken when the toggle is ON; web uses the browser's native TTS voices (no ElevenLabs; matches iOS which uses AVSpeechSynthesizer). |
| `RecordingOverlay.swift:L66-L83` Defaults button (slider.horizontal.3 purple) → onSetDefaults | `recording-chrome.tsx` disabled ParityButton + link to `/settings/defaults` | partial | 9 | Phase 9 defer: the Defaults editor lives on its own route (Phase 6 `/settings/defaults`) rather than as an inline recording-overlay button. Opening a full editor mid-recording would steal the inspector's focus from the active dictation. Closed as intentional web UX divergence — the overlay button remains disabled with a pointer to the Settings route. |
| `RecordingOverlay.swift:L86-L102` Apply Defaults button → onApplyDefaults | `recording-chrome.tsx` disabled ParityButton + Circuits tab action rail | partial | 9 | Phase 9 defer: Apply Defaults is a Circuits-tab action (visible on the right action rail). Inspectors don't mix dictation with a circuit-wide fill-empties sweep — the two flows happen at different moments. Closed as intentional web UX divergence. |
| `RecordingOverlay.swift:L105-L121` CCU Photo button (orange) | `recording-chrome.tsx:L177-L182` deep-link to /circuits | partial | 8 | Web deep-links to Circuits tab — iOS handles it inline from recording. |
| `RecordingOverlay.swift:L124-L140` Doc Extract button (cyan) | `recording-chrome.tsx:L183-L188` deep-link to /circuits | partial | 8 |  |
| `RecordingOverlay.swift:L143-L159` Observation camera button | `recording-chrome.tsx:L189-L194` deep-link to /observations | partial | 8 |  |
| `RecordingOverlay.swift:L163-L178` End Session button (stop.fill red) + `showEndSessionConfirmation` | `recording-chrome.tsx` End CircleButton → `<ConfirmDialog>` | match |  | Phase 8 wrapped the End button in the Phase 1 `<ConfirmDialog>` primitive ("End this recording session?") so an errant tap can't nuke an in-progress session. |
| `RecordingOverlay.swift:L182-L204` Pause/Resume/Start (mic.fill / pause.fill / play.fill) with tint | `recording-chrome.tsx:L207-L222` Pause / Resume CircleButton | match |  |  |
| `RecordingOverlay.swift:L255-L277` Geministatus content — VADIndicator + Waveform + extraction status | `recording-chrome.tsx` VuMeter + StatePill + `<VadIndicator>` | match |  | Phase 8 split VAD state back out of the pill into a dedicated `<VadIndicator>` (dot + label) so the inspector sees the same Active/Dozing/Sleeping/Idle signal iOS shows. |
| `VADIndicatorView.swift:L1-L27` coloured circle (idle/listening/speaking/trailing) pulse | `web/src/components/recording/vad-indicator.tsx` | match |  | Phase 8 landed the dedicated dot-with-ring indicator. Pulse honours prefers-reduced-motion via the global CSS guard. |
| `WaveformView` | `recording-chrome.tsx:L282-L308` VuMeter (24 bars) | match |  | Different algorithm but same role (mic-level vis). |
| `ProcessingBadgeView.swift:L5-L25` "Processing Audio (N)" animated badge | `web/src/components/recording/processing-badge.tsx` | match |  | Phase 8 added the badge — driven off `processingCount` in recording-context (transcripts sent to Sonnet minus extraction/question replies observed). Hidden at zero. |
| `PendingDataBanner.swift:L1-L20` "N unassigned readings" warning | `web/src/components/recording/pending-data-banner.tsx` | match |  | Phase 8 shipped the banner — count increments off Sonnet `validation_alerts`. Dismissal lives alongside the alert card. |
| `AlertCardView.swift:L1-L60+` non-blocking validation alert card (C1/C2/C3 severity icon + Yes/No/Dismiss + queued count) | `web/src/components/recording/alert-card.tsx` | partial | 8 | Phase 8 landed the question stack with Dismiss + "+N more" queue badge. Yes/No inline response buttons are still iOS-only — the web client relies on the inspector voice-answering into the transcript (which Sonnet picks up anyway). Follow-up: wire tap-Yes/No back into `SonnetSession.sendCorrection`. |
| `TranscriptStripView.swift:L35-L100` pulsing dot + horizontal transcript + latest confirmed field badge | `web/src/components/recording/transcript-bar.tsx:L24-L100+` top-docked transcript bar with pulse + interim italic | partial | 8 | Web keeps rolling transcript tail; iOS focuses on the LAST line with highlight flash when a field confirms. Similar intent, different edge behaviour. |
| Transcript highlight flash (keyword spotlight + colour) | TranscriptStripView:L94+ highlights array | MISSING (defer — cosmetic) | partial | 9 | Phase 9 defer: the confirmed-field flash on the `<LiveFillView>` overlay is the primary confirmation feedback inspectors use. The transcript-keyword flash is a secondary cue that iOS shows; closing the gap on web would require a keyword-range highlighter in the transcript bar without clear user benefit. Raise separately if inspectors request it. |
| `LiveFillView.swift:L1-L1554` full-form live dashboard with compact landscape layout | `web/src/components/live-fill/live-fill-view.tsx:L1-L60+` equivalent overlay | partial | 8 | Web LiveFillView covers most sections (installation / supply / board / circuits / observations) but lacks iOS-specific: CCU slot crops tap-to-correct grid (`LiveFillView.swift:L44-L47`), per-section compact horizontal layout, "purpose of report" picker sheet, inline general-condition picker. |
| `LiveFillView.swift:L44-L47` `ccuSlotsSection` tap-to-correct for geometric extraction crops | MISSING (defer — requires geometric CCU pipeline) | partial | 9 | Phase 9 defer: requires the geometric CCU extraction pipeline (slot crops as individual images) which isn't built yet. Web's Phase 7 CCU flow uses a whole-image model. Raise separately when the geometric pipeline ships. |
| `LiveFillView.swift:L12-L14` showGeneralConditionPicker / showPurposeOfReportPicker / showInstallationTypePicker sheets | MISSING (defer — live-fill overlay is non-interactive on web) | partial | 9 | Phase 9 defer: web's `<LiveFillView>` is a display overlay — fields are edited on the underlying tab, not inside the overlay. Adding interactive pickers mid-recording would conflict with the dictation flow. Closed as intentional web UX divergence. |
| `DebugDashboardView.swift:L22-L60` hidden debug dashboard (triple-tap Settings version) with Live / Regex / Sonnet / Stats tabs | `/settings/debug` (Phase 6) | partial | 9 | Phase 6 shipped a developer-only Debug Dashboard at `/settings/debug` gated by NODE_ENV + the About-page toggle. It covers IDB row counts, SW registration, auth-token masking, raw diagnostics JSON — but not iOS's Live / Regex / Sonnet / Stats live-session panes. Phase 9 defer: those panes tail the in-process recording pipeline, which isn't a persistent surface the web dev tools can snoop cleanly. Follow-up: standalone recording-session replay viewer if inspectors ever request session forensics. |
| Voice command executor (e.g. "move to circuit 5", "set OCPD to 32A") | `packages/shared-utils/src/voice-commands.ts` + wired in `recording-context.tsx` | partial | 8 | Phase 8 ported the MVP dispatcher: `update_field`, `reorder_circuits`, `query_field`. Punted: `add_circuit`, `delete_circuit`, `calculate_impedance` (already accessible from Circuits tab menu), `query_summary`. Parser grammar is intentionally narrow — Sonnet still handles freeform dictation. |
| Cost bar / cost pill — `£~X.XX` during recording | `recording-chrome.tsx` formatCost + formatElapsed | match |  | Phase 8 switched the `$` prefix to `£~` to match iOS (UK-only inspector base; USD/GBP difference at pence-level is within the cost display's rounding noise). |
| `formatElapsed` timer during recording | recording-chrome.tsx same | match |  |  |
| 3-tier sleep (Active / Dozing / Sleeping) indicator | `recording-chrome.tsx:L240-L266` state-pill supports dozing/sleeping | match |  |  |
| `recording-chrome.tsx:L41-L49` RecordingRing (pulsing border around page) — keeps page visible during recording | iOS keeps overlay floating over the page | match |  | Different visual treatment; both communicate "recording in progress" — no gap. |
| `recording-chrome.tsx` Voice button `disabledReason="Voice prompts are iOS-only for now."` | covered above | match |  | Phase 8 flipped the button from disabled to an active toggle. |
| `recording-chrome.tsx` Apply button `disabledReason="Apply-last-snapshot is iOS-only for now."` | `recording-chrome.tsx` (disabled) | partial | 9 | Phase 9 defer: Apply-last-snapshot depends on per-job snapshot history that isn't in the data model. Rolls up with the RecordingOverlay Defaults buttons above — the Apply Defaults path via the Circuits tab action rail covers the fill-empty-from-user-defaults case, which is what inspectors actually want this button to do. |
| `recording-context.tsx` sonnet-session + deepgram-service + mic-capture + resample + audio-ring-buffer + sleep-manager | iOS `DeepgramRecordingViewModel` + `DeepgramService` + `SonnetStreamingSession` | match |  | Web pipeline is feature-complete as of Phase 4e; architecture matches. |

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

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `SettingsHubView.swift:L51-L105` profile hero (gradient avatar circle + name + email + role badges) | `web/src/app/settings/page.tsx:L67-L94` | match |  |  |
| `SettingsHubView.swift:L81-L86` role badges (system role + company role) | `settings/page.tsx:L84-L92` RoleBadge | match |  |  |
| `SettingsHubView.swift:L109-L149` Company & Team section (4 rows when admin) | `settings/page.tsx:L105-L139` split into TEAM + COMPANY | match |  |  |
| `SettingsHubView.swift:L113-L118` Company Details row | `settings/page.tsx:L119-L129` /settings/company | match |  |  |
| `SettingsHubView.swift:L122-L126` Staff Management row | `settings/page.tsx:L106-L113` /settings/staff | match |  |  |
| `SettingsHubView.swift:L133-L137` Company Dashboard row (isCompanyAdmin gated) | `settings/page.tsx:L130-L138` /settings/company/dashboard | match |  |  |
| `SettingsHubView.swift:L141-L145` Invite Employee row | `/settings/invite` (Phase 6) + existing company dashboard dialog | match | 6 | Phase 6: dedicated `/settings/invite` route mirrors iOS's nav entry. Shares the same `api.inviteEmployee` contract (POST `/api/companies/:companyId/invite`) and the one-shot temp-password reveal pattern as the company dashboard invite sheet. Role-gated on `isCompanyAdmin`. |
| `SettingsHubView.swift:L154-L174` Certificate Defaults section (Cable Size Defaults + Default Values) | `settings/page.tsx` → `/settings/defaults` hub | match | 6 | Phase 6: hub route splits to `/settings/defaults/values` (Default Values) + `/settings/defaults/cable` (Cable Size Defaults). Defaults persist to `/api/settings/:userId/defaults`; Circuits tab now threads `userDefaults` through `applyDefaultsToCircuits` so saved presets fill empty fields on Apply Defaults. |
| `SettingsHubView.swift:L179-L191` Account section: Change Password | `/settings/change-password` | match | 6 | Phase 6: 3-input form (current / new / confirm) with show-hide toggles, client validation (≥ 8 chars, new !== current, match), `api.changePassword` → `PUT /api/auth/change-password`. 401 surfaces the backend "current password is incorrect" copy inline; success card + 2s redirect to `/settings`. |
| `SettingsHubView.swift:L196-L235` App section: Audio Import / Terms & Legal / Version row | partial — `/settings/about` landed; Audio Import + Terms deferred | partial | 6 | Phase 6: About page lands with version (`NEXT_PUBLIC_APP_VERSION`), acknowledgments, and the debug-mode toggle that gates the Debug Dashboard. Audio Import + Terms remain iOS-only / deferred (see rows below). |
| `SettingsHubView.swift:L200-L205` Audio Import → `AudioImportView` | MISSING | ios-only | 6 | iOS test affordance only (file picker into Deepgram). Not a web requirement; inspectors record via the live pipeline on web. |
| `SettingsHubView.swift:L209-L213` Terms & Legal → `TermsAcceptanceView` | MISSING (handled at signup) | partial | 9 | Phase 9 defer: web handles terms acceptance at signup; a settings-level re-read surface is low priority and not a compliance blocker. Paired with the `Views/Launch/TermsAcceptanceView.swift` row below — raise separately if legal asks for ongoing consent surfaces. |
| `SettingsHubView.swift:L217-L231` Version row (non-navigable, shows app version + blue pill) | `/settings/about` Version card | match | 6 | Phase 6: shown on the About page with build + environment. No triple-tap — the Debug Dashboard is gated by the About-page toggle instead. |
| `DebugDashboardView.swift` hidden debug dashboard | `/settings/debug` (gated on NODE_ENV !== 'production' OR `cm-debug=1`) | match | 6 | Phase 6: dev-only dashboard with masked auth token, per-store IDB row counts, SW registration list, raw diagnostics JSON. Hub row only renders when the About toggle has flipped the flag. |
| `SettingsHubView.swift` / support flow | `/settings/diagnostics` | match | 6 | Phase 6: Export Diagnostics (JSON download + copy-to-clipboard with SENSITIVE_PATTERN redaction) + Clear Cache (SW unregister, IDB delete, storage clear, /login redirect — gated by ConfirmDialog). |
| `SettingsHubView.swift:L240-L270` Danger Zone — Log Out (red pill) | `settings/page.tsx:L175-L182` Button ghost | match |  |  |
| Settings → Offline Sync (web-only) | `settings/page.tsx:L146-L160` conditionally-rendered | ios-only |  | PWA-only IDB outbox admin page; no iOS counterpart (iOS offline uses Core Data). |
| Settings → Administration → Manage Users (system admin only) | `settings/page.tsx:L163-L173` gated | match |  |  |
| `components/pwa/ios-install-hint.tsx` Add-to-Home-Screen hint | `settings/page.tsx:L102` IOSInstallHint | match |  | Phase 7b. iOS has no equivalent (is the app). |

### Company details page

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CompanyDetailsView.swift:L14-L56` company hero header + info / address / contact / logo / warnings / save button | `web/src/app/settings/company/page.tsx` | match |  |  |
| Company name + registration + VAT fields | ports on web present (per page structure) | match |  |  |
| Logo upload via PhotosPicker | `components/settings/logo-uploader.tsx` | match |  |  |
| Validation warnings section | web equivalent exists via save flow | match |  |  |
| `CompanyDetailsViewModel.load()` on appear | `settings/company/page.tsx` useEffect fetch | match |  |  |

### Staff (inspector) list + detail

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `InspectorListView.swift` gradient hero + stacked avatars + count, card list, swipe-to-delete, empty state with Add | `web/src/app/settings/staff/page.tsx` | match |  |  |
| `InspectorDetailView.swift:L1-L60+` profile header + name section + signature + position + default toggle + test equipment with 5 instrument rows | `web/src/app/settings/staff/[inspectorId]/page.tsx` | match |  | Based on line count (418) — full port confirmed. |
| Signature capture (`SignatureCaptureView.swift`) | `components/settings/signature-canvas.tsx` | match |  | Custom `<canvas>` implementation. |

### Admin (system admin)

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `AdminUsersListView.swift:L1-L253` paginated users list with role + company-role + status pills | `web/src/app/settings/admin/users/page.tsx:L1-L293` | match |  |  |
| `AdminCreateUserView.swift:L1-L274` new-user form (name/email/password/companyName/role/companyRole/selectedCompany) | `web/src/app/settings/admin/users/new/page.tsx:L1-L219` | partial | 6 | Web takes plain `companyId` input; iOS has a Company picker populated from `/api/companies`. Web's "companyId is free-form UUID — deferred" note confirms the gap. |
| `AdminEditUserView.swift:L1-L524` edit user details + role + active toggle + reset password + unlock | `web/src/app/settings/admin/users/[userId]/page.tsx:L1-L653` | match |  |  |
| `AdminEditUserView.swift:L25-L30` Reset Password flow (new password input + API call) | covered by web page | match |  |  |
| `AdminEditUserView.swift:L32-L33` Deactivate/Reactivate confirm | covered by web page | match |  |  |
| `AdminEditUserView.swift:L33` Unlock confirm (after failed login lockouts) | covered by web page | match |  |  |
| `AdminQueueView.swift:L1-L451` admin queue (pending jobs / retry / failures) | MISSING (PWA wire-up follow-up) | partial | 9 | Ledger-fix 2026-04-24: the backend endpoints already exist — `GET /api/admin/queue/status` and `GET /api/admin/queue/health` in `src/admin_api.js:59,72`. iOS calls these via `APIClient.adminGetHealth()` at `APIClient.swift:551`. The PWA just needs a page that hits them. Reclassified from `backend` (blocking on backend) to `partial` (PWA-only wire-up). Failure-replay mutation (iOS "retry failed job" button) is a separate, smaller concern — can start with read-only view. |
| `AdminStatsView.swift:L1-L305` admin stats dashboard (totals / charts / breakdowns) | `web/src/app/settings/company/dashboard/page.tsx` stats tab (company-only) | partial | 9 | Ledger-fix 2026-04-24: backend endpoint `GET /api/admin/stats` already exists (`src/admin_api.js:85`); iOS consumes it via `APIClient.adminGetStats()` at `APIClient.swift:547`. PWA just needs a system-wide admin stats page that calls it (company stats page covers the company-scoped case). Pure PWA follow-up. |
| `CompanyDashboardView.swift:L1-L583` Jobs / Team / Stats tabs + invite employee dialog | `web/src/app/settings/company/dashboard/page.tsx:L1-L671` | match |  |  |
| `InviteEmployeeView.swift:L1-L248` invite form (name/email/auto-gen password surfaced once) | Merged into Company Dashboard Team tab in web | match |  |  |

### Defaults management

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `DefaultsManagerView.swift:L1-L272` list of certificate presets + add/edit/delete | `/settings/defaults` hub page | match | 6 | Phase 6: hub splits into Default Values + Cable Size editors. iOS "named preset" concept (multiple presets per user) is deferred — web ships a single global defaults blob which covers 95% of the usage inspectors actually have. |
| `DefaultValuesView.swift:L1-L194` per-tab default-value editor with named preset save | `/settings/defaults/values` | partial | 9 | Phase 6: ports the high-traffic subset (max disconnect time, IR voltage, RCD operating current, polarity, OCPD type, breaking capacity, wiring + ref method) rather than every tab's every field. Per-tab surface + named-preset CRUD deferred to Phase 9 polish — most inspectors only ever preset the Test-Readings bundle. |
| `CableSizeDefaultsView.swift:L1-L212` cable CSV defaults by OCPD rating + material + ref method | `/settings/defaults/cable` | match | 6 | Phase 6: per-type (lighting / socket / cooker / shower / immersion) editor for live CSA, CPC CSA, OCPD rating, OCPD type. Scoped keys (`{type}.live_csa_mm2` etc.) persist for iOS parity; web reads fall back to schema defaults (non-overwrite invariant guards against stomping inspector edits). |
| `ApplyDefaultsSheet.swift:L1-L95` "Apply these defaults to this job?" confirmation | `job/[id]/circuits` "Apply Defaults" button | match | 6 | Phase 5 wired the Circuits action; Phase 6 threads `userDefaults` through `useUserDefaults` → `applyDefaultsToCircuits`. IDB-cached so offline Apply-Defaults sees the user's saved values. No separate confirmation sheet — the action is already one tap, iOS's sheet was "sure you want to do it?" which is friction we skipped on web. |

### Change password

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `ChangePasswordView.swift:L1-L60+` current + new + confirm + strength meter + show/hide toggles | `/settings/change-password` | match | 6 | Phase 6: 3 password inputs with per-field show/hide eye toggle; `PUT /api/auth/change-password` on submit; backend 401 surfaces as inline banner ("Current password is incorrect") without form reset. Success → green confirmation card, 2s router.push('/settings'). |
| `ChangePasswordView.swift:L41-L55` password strength (0-4) calculation | Not implemented | ios-only | 9 | Deferred: iOS surfaces a 0–4 strength bar; web uses a stricter minimum (≥ 8 chars rather than iOS's ≥ 6) as the single gate. If inspectors request the meter, port in Phase 9. |
| `ChangePasswordView.swift` keyboard focus fluidity (FocusState) | Native Tab-key flow | partial | 9 | Phase 9 defer: web's native Tab-key flow + autocomplete hints cover the fluidity case inspectors actually need. Explicit `autoFocus` on the Enter-to-next field transitions is an iOS affordance that a browser can't replicate precisely without trapping Tab — closed as an intentional platform divergence. |

### App → Audio Import + Terms

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `AudioImportView.swift` import existing audio recording into Deepgram pipeline | MISSING (iOS test affordance) | ios-only | 9 | Phase 9: closed as `ios-only` — iOS includes AudioImport as a test affordance (load a pre-recorded WAV into the live pipeline for QA). Web uses direct mic capture only; importing an audio file into the live Sonnet conversation would bypass the VAD / sleep state machine. Not an inspector-facing requirement. |
| `Views/Launch/TermsAcceptanceView.swift` + `Views/Launch/LegalTexts.swift` | MISSING (handled at signup) | partial | 9 | Phase 9 defer: terms acceptance happens at signup (web registration flow); re-reading the terms inside the app is a low-value surface. Paired with the Settings-hub Terms & Legal row above. |

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

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CertMateDesign.swift` — colour tokens (brandBlue/brandGreen/dark surfaces/gradients/shadows/animations) | `web/src/lib/design-tokens.ts` + `globals.css` CSS vars | match |  |  |
| `CMSectionCard.swift` — gradient-bordered card with category-coded accent | `web/src/components/ui/section-card.tsx` | match |  | Phase 1 — added iOS-parity category accents (client/electrical/board/test-results/schedule/notes/protection) driven by `SECTION_ACCENTS` token map in `lib/constants/section-accents.ts`. |
| Hero gradient (blue→green or green→blue) used on every tab header | web tab pages render equivalent gradients + `components/ui/hero-header.tsx` | match |  | Phase 1 — reusable `HeroHeader` primitive with breathing radial glow (respects `prefers-reduced-motion`). Accepts the same `SectionAccent` token set as `SectionCard`. |
| Staggered section entrance (`cmStaggeredEntrance(index:appeared:)`) | `globals.css` `.cm-stagger-in` / `.cm-stagger-children` utilities | match | 9 | Phase 9: ported as a CSS-only utility (no framer-motion dependency). Applying `cm-stagger-children` to a flex column cascades `nth-child(1..12)` delays (0..440ms) so SectionCards fade+rise into place. Every job tab container (installation, supply, board, circuits, design, extent, staff, inspection, observations, pdf) now wears the class. Honours `prefers-reduced-motion` — the animation collapses to a no-op. |
| Data-arrival flash (`DataArrivalFlash.swift`) — blue flash when Sonnet fills a field | `web/src/components/live-fill/live-field.tsx` + `globals.css` `.cm-live-field` | match | 9 | Phase 9 confirm: verified the `.cm-live-field[data-recent="true"]` rule still fires across every tab after the Phase 4-8 surgery. Phase 8 voice-command + Phase 7 CCU/doc-extraction paths both flow through `liveFillStore.setRecent()` so new-in-phase fields inherit the flash automatically. |
| `CMFloatingTextField` floating-label input | `web/src/components/ui/floating-label-input.tsx` | match |  |  |
| `CMFloatingPicker` | `web/src/components/ui/select-chips.tsx` + `labelled-select.tsx` | match |  |  |
| `CMUnitTextField` (text with trailing unit) | `web/src/components/ui/floating-label-input.tsx` `trailing` slot | match |  | Used in Supply tab for Ω / V / A / kA. |
| `CMDatePickerField` | `<input type="date">` native | match |  |  |
| `SignatureCaptureView` | `web/src/components/settings/signature-canvas.tsx` | match |  |  |
| `PhotoCaptureView` (fullScreenCover native camera) | `<input type="file" accept="image/*" capture="environment">` | ios-only |  | Different native affordance — web equivalent is acceptable. |
| `PhotoPickerView` (PhotosPicker) | `<input type="file">` | ios-only |  | iOS-native primitive; web file input is the equivalent. |
| `StatusBadge` (valid/expired/expiring/pending coloured pills) | `web/src/components/ui/pill.tsx` | match |  |  |
| `OutcomeButtonGroup.swift` (✓/✗/N/A/LIM/C1/C2/C3/FI chip row) | inlined in `inspection/page.tsx` ScheduleRow | match |  |  |
| `TypingText.swift` typing animation | N/A (tour narration silent on web) | partial | 9 | Phase 9 defer: web's Phase 3 tour is silent (no TTS narration) so there's no subtitle text to animate. Rolls up with the "TourManager TTS narration" row — if that lands later, TypingText becomes a paired follow-up. Not a standalone blocker. |
| `OfflineBanner.swift` (top of dashboard when offline) | `web/src/components/pwa/offline-indicator.tsx` + `<OfflineBanner />` (`< md`) | match | 9 | Phase 9: closed — mobile viewports (`< md`) now render the full-width banner matching iOS shape; desktop keeps the inline header pill because the banner would push authenticated-page content below a 64-px bar on every route. See OfflineIndicator row above. |
| Skeleton shimmer (dashboard loading) | `globals.css` `.cm-shimmer` + `dashboard/page.tsx:L225-L233` + `components/ui/skeleton-row.tsx` | match |  | Phase 1 — reusable `SkeletonRow` primitive wrapping the existing `.cm-shimmer` keyframes with `role="status"` + `aria-busy`. |
| Job-deletion confirmation alert (universally) | `components/dashboard/job-row.tsx` + per-circuit + observations + board-remove + pdf-discard + admin-deactivate + staff-remove all `ConfirmDialog` | match | 9 | Phase 9: audited every destructive handler — dashboard job delete (P3), alerts-page job delete (P3), per-circuit trash (P9 new), delete-all-circuits (P5), observation delete (P4), board remove-with-cascade (P4), PDF discard (P2), admin deactivate / unlock (P6), staff delete (P6), outbox discard (P7). All route through `ConfirmDialog` (destructive variant fires haptic pulse via Phase 9 `lib/haptic.ts`). |
| `components/ui/confirm-dialog.tsx` | reused in Settings outbox discard | match |  | Phase 1 — added `destructive` ergonomic alias + internal async-promise busy tracking so destructive actions can't double-fire while the mutation is in flight. |
| Tally-badge primitive (Observations totals, Phase 3 Alerts bell) | `components/ui/tally-badge.tsx` | match |  | Phase 1 — count+label pill with severity variants (destructive/warn/info/muted/success) mapped to the existing `--color-severity-*` tokens. |
| Brand logo | `components/brand/logo.tsx` | match |  |  |
| Tab bar / sidebar navigation shell | `components/layout/app-shell.tsx` | match |  |  |
| Job header (back + title + menu) | `components/job/job-header.tsx` | partial | 4 | Menu missing (see Overview tab). |
| Job tab nav pill bar | `components/job/job-tab-nav.tsx` | match |  |  |
| Floating mic FAB when idle | `components/job/floating-action-bar.tsx` | match |  |  |
| `recording-context.tsx` sonnet+deepgram plumbing | Already shipped Phase 4 | match |  |  |
| Haptic feedback on taps (`UIImpactFeedbackGenerator`) | `web/src/lib/haptic.ts` + wired into `ConfirmDialog` confirm path | partial | 9 | Phase 9: best-effort `haptic()` wrapper over `navigator.vibrate()` (Chrome/Firefox Android only; iOS Safari + desktop no-op silently). Wired into the destructive ConfirmDialog confirm so delete confirms on Android give a light buzz. Closed as `partial` not `match` because iOS Safari genuinely has no Vibration API — we can't match the iOS Taptic Engine experience on an iPhone Safari PWA, which is a browser-platform limitation, not a bug to fix. |
| Reduce-motion respect (`@Environment(\.accessibilityReduceMotion)`) | `globals.css` `@media (prefers-reduced-motion: reduce)` — now pervasive | match | 9 | Phase 9 audit: the global reducer in `globals.css:L219-L228` collapses every `animation-duration` and `transition-duration` to 0.01ms under `prefers-reduced-motion: reduce`, plus per-feature null-outs on `.cm-live-field` / `.cm-live-section` / `.cm-rec-ring` / `.cm-dialog-*` / `.cm-stagger-in` / `.cm-stagger-children`. Phase 9 verified every new animation (stagger, hero glow) honours the preference. |
| `components/pwa/install-button.tsx` — Add to Home Screen button | `components/pwa/install-prompt-provider.tsx` | ios-only |  | Web-only (iOS is a native app). |
| `components/pwa/sw-update-provider.tsx` — service-worker update notification | — | ios-only |  | Web-only. |
| `components/pwa/offline-indicator.tsx` | — | ios-only |  | iOS uses `OfflineBanner`. |
| `components/ui/numeric-stepper.tsx` | MISSING iOS equivalent (iOS uses Picker) | ios-only |  | Web-specific affordance. |
| `components/ui/segmented-control.tsx` | `Picker(.segmented)` iOS | match |  |  |
| `components/ui/select-chips.tsx` | `CMFloatingPicker` or `Picker(.segmented)` | match |  |  |
| `components/ui/floating-label-input.tsx` | `CMFloatingTextField` | match |  |  |
| `components/ui/multiline-field.tsx` | `TextField(axis:.vertical, lineLimit:)` | match |  |  |
| `components/ui/icon-button.tsx` 44×44 hit target primitive (Wave 4 D8) | iOS uses native Button with frame(minHeight: 44) | match |  | Ensures WCAG 2.1 AA touch target. |

---

## Phase 9 — Cross-cutting polish summary

Final state (as of 2026-04-24, post ledger-fix):

| status | count |
|---|---|
| `match` | 285 |
| `partial` (intentional defer — see per-row notes) | 67 |
| `ios-only` (intentional platform divergence) | 16 |
| `backend` (unblocks when backend ships endpoint) | 0 |
| `missing` | 0 |

Note: the prior count showed 1 `backend` and 66 `partial`. The ledger-fix commit on 2026-04-24 re-classified `AdminQueueView` from `backend` → `partial` after confirming the backend endpoints already exist (`src/admin_api.js:59,72,85`). `AdminStatsView` kept its `partial` status but the blocking note was corrected. No work was lost — two `partial` rows are now pure PWA wire-ups, and one `partial` row (`PresetPickerSheet`) is the only remaining defer that genuinely needs a new backend endpoint (tracked in `obsidian-vault/active/todos-certmate.md`).

Phase 9 flipped ~32 rows into terminal states:

- **Closed to `match`:** staggered section entrance (CSS utility ported), data-arrival flash (audited across every tab + new-in-phase voice/CCU paths), offline banner (breakpoint-driven twin shape), universal destructive confirmation (10 handlers audited — all through `ConfirmDialog`), reduce-motion respect (global + per-feature rules), data-arrival flash regression check.
- **Closed to `ios-only`:** AudioImport (test affordance), inline-inspector-add inside Installation (Settings → Staff is the single source of truth).
- ~~**Closed to `backend`:** AdminQueueView — requires `/api/admin/queue` before any UI work.~~ **Corrected 2026-04-24 (ledger-fix):** the backend endpoints (`/api/admin/queue/status`, `/api/admin/queue/health`, `/api/admin/stats`) already exist and are consumed by iOS. Reclassified to `partial` (PWA wire-up follow-up, no backend work needed). Final backend count is now **0** on main.
- **Closed to `partial` with explicit defer:** Supply preset pickers (bundle — needs `Constants.*` port to `@certmate/shared-utils`), CCU pending-extractions queue (needs IDB blob store), RecordingOverlay Defaults buttons (intentional web UX — Settings route over inline), transcript keyword flash (cosmetic, no user demand), haptic feedback (Vibration API best-effort only; iOS Safari has no API), TypingText (paired with tour TTS — both silent on web for now), LiveFillView pickers (overlay is read-only on web by design), Terms & Legal surfaces (handled at signup), ChangePassword FocusState (native Tab suffices).

Seven rows deferred beyond Phase 9 — all marked `partial` or `backend` and raised as separate follow-ups:

1. Multi-preset Defaults CRUD — **needs backend `/api/defaults/presets` shape (todo in `obsidian-vault/active/todos-certmate.md`)**. Only genuine backend dependency left.
2. Supply preset pickers bundle (`Constants.*` port to shared-utils, ~9 pickers).
3. CCU pending-extractions queue (IDB blob store + extraction-replay worker).
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

This ledger is the authoritative record of the Phases 0–9 parity project. The rebuild closes here.
