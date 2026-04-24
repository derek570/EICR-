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
| `DashboardView.swift:L384-L387` expiringJobCount derived from `lastModified < 4 years` | `dashboard/page.tsx:L132-L135` `exp = 0` hardcoded | partial | 3 | Both platforms need `next_inspection_due` on Job list. Web currently renders 0 — add derived value once backend ships the field, mirror iOS's 4-year fallback for now. |
| `DashboardView.swift:L512-L548` (search bar — localizedCaseInsensitiveContains on `address`) | `dashboard/page.tsx:L192-L205` (`<input type="search">` filter) | match |  |  |
| `DashboardView.swift:L552-L580` Start EICR + Start EIC gradient action cards (blue / green) | `dashboard/page.tsx:L173-L189` (StartTile) | match |  |  |
| `DashboardView.swift:L708-L724` `createAndNavigate` with auto-apply-defaults + preset picker sheet | `dashboard/page.tsx:L146-L158` simple create → push | partial | 3 | Web calls `api.createJob` then routes; no preset picker / auto-apply defaults flow. Requires Defaults data first (Phase 6). |
| `DashboardView.swift:L89-L114` skeleton job-row shimmer while loading | `dashboard/page.tsx:L225-L233` cm-shimmer placeholder rows | match |  |  |
| `DashboardView.swift:L115-L132` empty-state icon + "Start a new EICR or EIC above" | `dashboard/page.tsx:L234-L239` equivalent empty message | match |  |  |
| `DashboardView.swift:L133-L165` JobRow NavigationLink with swipe-to-delete (trailing) | `web/src/components/dashboard/job-row.tsx` Link + pendingSync chip | partial | 3 | Web row lacks swipe-delete / context-menu delete. Delete currently only from job-detail. |
| `DashboardView.swift:L584-L672` "Setup & Tools" grid (Defaults, Company, Staff, Settings, Tour, Log Out) | `dashboard/page.tsx:L249-L272` Company / Staff / Settings / Log Out tiles | partial | 3 | Web is missing Defaults tile + Tour toggle tile — Defaults page doesn't exist yet (Phase 6), Tour is Phase 3. |
| `DashboardView.swift:L593-L595` Defaults tile → DefaultsManagerView sheet | MISSING | missing | 6 | Defaults management page not built. See [`Views/Defaults/DefaultsManagerView.swift`](#) + `DefaultValuesView.swift` + `CableSizeDefaultsView.swift` + `ApplyDefaultsSheet.swift`. |
| `DashboardView.swift:L596-L598` Company tile → CompanyDetailsView sheet | `settings/company/page.tsx` | match |  |  |
| `DashboardView.swift:L602-L604` Staff tile → InspectorListView sheet | `settings/staff/page.tsx` | match |  |  |
| `DashboardView.swift:L605-L607` Settings tile → SettingsView sheet | `settings/page.tsx` | match |  |  |
| `DashboardView.swift:L611-L641` Tour toggle (ON/OFF pill) + auto-start | MISSING | missing | 3 | Web has no tour at all. See TourOverlayView row below. |
| `DashboardView.swift:L642-L667` Log Out button with red tint | `dashboard/page.tsx:L269` `SetupTile variant="destructive"` | match |  |  |
| `DashboardView.swift:L676-L703` TourManager start / navigate to job / TTS narration | MISSING | missing | 3 | Needs TourManager port + ElevenLabs TTS (backend already exposes `/api/tour-narration`). |
| `DashboardView.swift:L294-L308` Delete Job confirmation alert | MISSING | missing | 3 | Web deletion path not wired; add confirm dialog in `components/dashboard/job-row.tsx`. |
| `DashboardView.swift:L188-L189` pull-to-refresh `.refreshable` | MISSING | partial | 3 | Web has no pull-to-refresh; relies on stale-while-revalidate cache. |
| `DashboardView.swift:L43-L46` `OfflineBanner` slide-in on connection loss | `web/src/components/pwa/offline-indicator.tsx` (header pill) | partial | 9 | Web renders a header pill, not a full-width banner with slide transition. Both communicate offline but shape differs; evaluate whether a banner is needed. |
| `DashboardView.swift:L201-L221` toolbar Alerts bell + Settings gear (top-right) | `web/src/components/layout/app-shell.tsx` (header) | partial | 3 | Web header has no Alerts bell. Settings icon is present. |
| `Views/Alerts/AlertsView.swift` whole view (Failed / In Progress / Recently Completed sections) | MISSING | missing | 3 | No `/alerts` route on web. Data is already available via `api.jobs` — pure UI phase. |
| `AlertsView.swift:L176-L191` empty-state "All Clear" green shield | MISSING | missing | 3 |  |
| `AlertsView.swift:L130-L172` alertJobRow with status conduit stripe + badge | MISSING | missing | 3 |  |
| `Views/Tour/TourOverlayView.swift:L13-L76` floating transport controls (step counter / back / play-pause / forward / stop) | MISSING | missing | 3 |  |
| `CertMateApp.swift` `@AppStorage("appTourEnabled")` default=true | MISSING | missing | 3 | Persist in localStorage on web. |
| `Views/Dashboard/JobRowView.swift` (status pill, coloured stripe, cert type, address, last modified) | `components/dashboard/job-row.tsx` | match |  | Web row exists and has pendingSync chip extra. |
| `Views/Dashboard/DefaultsModal.swift:L37` preset picker reusing `Constants.circuitFieldOrder` for per-field defaults | MISSING | missing | 6 | Coupled to missing Defaults system (Phase 6). |
| `Views/Dashboard/InspectorModal.swift` (quick inspector picker from dashboard) | MISSING | missing | 6 |  |
| `Views/Create/CreateCertificateSheet.swift` PresetPickerSheet (shown after new-job create) | MISSING | missing | 3/6 | Shows only if >1 matching preset exists. Needs Defaults to be useful. |

---

## Job — Overview tab

At-a-glance readonly dashboard inside a job.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift` (tab host)

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `JobDetailView.swift:L68-L100` phone header (back + address + menu) | `web/src/components/job/job-header.tsx` | partial | 4 | Web header lacks the menu button (Edit Defaults, Apply Defaults, Start Tour). Menu entries iOS-only until defaults + tour ship. |
| `JobDetailView.swift:L88-L103` menu → Edit Default Values | MISSING | missing | 6 | Depends on defaults editor. |
| `JobDetailView.swift:L97-L99` menu → Apply Defaults to Job | MISSING | missing | 6 |  |
| `JobDetailView.swift:L100-L102` menu → Start Tour | MISSING | missing | 3 |  |
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
| `InstallationTab.swift:L64` client_postcode (+ postcode autocomplete debounce) | `installation/page.tsx:L158-L162` | partial | 4 | Web lacks postcodes.io autocomplete / 400ms debounce described at `InstallationTab.swift:L251-L305`. Backend endpoint `lookupPostcode` already exists on iOS APIClient — needs a web wrapper. |
| `InstallationTab.swift:L65` client_phone (phonePad keyboard) | `installation/page.tsx:L163-L168` inputMode="tel" | match |  |  |
| `InstallationTab.swift:L66-L67` client_email (autocapitalise none, email keyboard) | `installation/page.tsx:L170-L177` | match |  |  |
| `InstallationTab.swift:L76` address (installation) | `installation/page.tsx:L182-L185` | match |  |  |
| `InstallationTab.swift:L77-L79` town/county/postcode (installation) | `installation/page.tsx:L187-L201` | partial | 4 | Postcode autocomplete missing here too. |
| `InstallationTab.swift:L80` occupier_name | `installation/page.tsx:L202-L206` | match |  |  |
| `InstallationTab.swift:L90-L93` CMDatePickerField `Date of Inspection` | `installation/page.tsx:L212-L216` `<input type="date">` | match |  |  |
| `InstallationTab.swift:L95-L101` `Date of Previous Inspection` (EICR only, N/A allowed) | `installation/page.tsx:L218-L225` EICR-only date input | partial | 4 | Web input has no explicit N/A toggle — iOS `CMDatePickerStringField` supports an "N/A" sentinel. |
| `InstallationTab.swift:L103-L107` Next inspection years Picker (menu) | `installation/page.tsx:L226-L232` NumericStepper (1–10) | partial | 4 | iOS uses a Picker bound to `Constants.inspectionIntervals`; web uses a stepper. Same end result, different affordance. |
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
| `InstallationTab.swift:L344-L399` Inspector Section (quick-select pills + add-new inline + signature capture + default star) | `installation/page.tsx:L358-L364` static SectionCard hint only ("lives on Staff tab") | partial | 4 | iOS shows inline inspector picker + Add New form + SignatureCaptureView directly on Installation tab. Web punts to Staff tab. Could keep the punt — but inline inspector pills would save two taps. |
| `InstallationTab.swift:L460-L490` inline new-inspector form (first/last/position/signature/isDefault) | MISSING | missing | 6 | Covered by Settings → Staff detail page separately. Inline add is iOS-only convenience. |
| `InstallationTab.swift:L502-L527` ensureDateOfInspection / autoSelectDefaultIfNeeded / default nextInspectionYears=5 | `installation/page.tsx:L104-L113` setYears handler (partial) | partial | 4 | Web doesn't auto-seed inspection date on mount, nor auto-select default inspector. |
| `InstallationTab.swift:L12-L18` inspector state (@State newFirstName, newSignatureData, saveError) | `settings/staff/[inspectorId]/page.tsx` | match |  | Ported to separate staff detail page. |

---

## Job — Supply tab

Earthing, live conductors, PFC, Ze, main switch, RCD, bonding, SPD.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/SupplyTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `SupplyTab.swift:L442-L472` heroHeader "Supply Characteristics" | `web/src/app/job/[id]/supply/page.tsx:L387-L404` HeroBanner | match |  |  |
| `SupplyTab.swift:L28-L31` Earthing Arrangement picker + onChange auto-flips TT flags | `supply/page.tsx:L66-L71` SelectChips (TN-S/TN-C-S/TT/IT) | partial | 4 | Web picker doesn't side-effect `means_earthing_electrode=true` when TT, nor set `inspection.isTTEarthing`. That chains through to Inspection tab's smart toggle — iOS does the cross-tab coupling. |
| `SupplyTab.swift:L50-L54` Live Conductors picker | `supply/page.tsx:L72-L77` SelectChips | match |  |  |
| `SupplyTab.swift:L56-L60` Number of Supplies picker (`Constants.numberOfSupplies`) | `supply/page.tsx:L79-L84` plain numeric input | partial | 4 | iOS offers a picker of preset counts; web is free-form. |
| `SupplyTab.swift:L62-L72` Nominal Voltage U / Uo pickers | `supply/page.tsx:L91-L102` plain numeric inputs | partial | 4 | Web lacks preset voltage list (`Constants.voltages`). |
| `SupplyTab.swift:L74-L78` Nominal Frequency picker | `supply/page.tsx:L85-L90` plain numeric input | partial | 4 |  |
| `SupplyTab.swift:L88-L91` Means of earthing: Distributor + Electrode toggles (both shown) | `supply/page.tsx:L138-L163` single SegmentedControl (one-of-two) | partial | 4 | iOS allows both toggles independently; web forces exclusive choice. Real installations can have both — the SegmentedControl is too restrictive. |
| `SupplyTab.swift:L93-L103` if electrode: type picker + resistance + location (hidden until enabled) | `supply/page.tsx:L164-L183` conditional block — FreeFormText for type/resistance/location | partial | 4 | Web lacks electrode type dropdown (rod/plate/tape/mat/other). |
| `SupplyTab.swift:L113-L132` Main switch BS/EN picker + "Other" → custom text | `supply/page.tsx:L188-L192` plain text | partial | 4 | Web lacks BS/EN preset list + Other-text escape hatch. |
| `SupplyTab.swift:L134-L138` Main switch poles picker | `supply/page.tsx:L193-L197` plain text | partial | 4 |  |
| `SupplyTab.swift:L140-L160` Main switch voltage picker + "Other" | `supply/page.tsx:L198-L203` plain numeric | partial | 4 | Same "Other" pattern missing. |
| `SupplyTab.swift:L162-L182` Main switch current picker + "Other" | `supply/page.tsx:L204-L209` plain numeric | partial | 4 |  |
| `SupplyTab.swift:L184-L188` Fuse/Setting A picker | `supply/page.tsx:L210-L215` plain numeric | partial | 4 |  |
| `SupplyTab.swift:L190` Location text | `supply/page.tsx:L216-L220` | match |  |  |
| `SupplyTab.swift:L193-L197` Conductor material picker + "Copper" QuickSetButton | MISSING | missing | 4 | Web Supply tab has no conductor material / CSA on main switch — these fields are covered under Earthing Conductor instead. Confirm field mapping; may need to add. |
| `SupplyTab.swift:L199-L203` Main switch conductor CSA picker | MISSING | missing | 4 |  |
| `SupplyTab.swift:L213-L224` RCD Operating Current IΔn picker + N/A + LIM quicksets + test-result Ω | `supply/page.tsx:L226-L230` plain numeric | partial | 4 | Web lacks picker + N/A/LIM quicksets + paired test-result field. |
| `SupplyTab.swift:L226-L239` RCD Time Delay picker (ms) + N/A + LIM + test result | `supply/page.tsx:L232-L237` plain numeric | partial | 4 |  |
| `SupplyTab.swift:L241-L254` RCD Operating Time picker + N/A + LIM + test result | `supply/page.tsx:L238-L261` plain design+tested pair | partial | 4 |  |
| `SupplyTab.swift:L264-L275` Earthing conductor material + CSA | `supply/page.tsx:L265-L285` plain | partial | 4 | Missing material/CSA picker + Copper quickset. |
| `SupplyTab.swift:L277-L294` Earthing conductor continuity check PASS/FAIL/LIM button row | `supply/page.tsx:L278-L283` plain numeric continuity Ω input | partial | 4 | Web takes a numeric reading; iOS takes PASS/FAIL/LIM outcome. Data model differs. |
| `SupplyTab.swift:L303-L314` Main bonding material + CSA picker + Copper | `supply/page.tsx:L287-L306` plain | partial | 4 |  |
| `SupplyTab.swift:L316-L332` Main bonding continuity PASS/FAIL/LIM | `supply/page.tsx:L299-L305` plain numeric | partial | 4 | Same shape mismatch as earthing conductor. |
| `SupplyTab.swift:L342` Bonding — Water PASS/FAIL/LIM | `supply/page.tsx:L311-L315` plain text | partial | 4 | Web takes free-form text; iOS uses BondingResultPicker (3-state). |
| `SupplyTab.swift:L344` Bonding — Gas | `supply/page.tsx:L316-L320` | partial | 4 |  |
| `SupplyTab.swift:L346` Bonding — Oil | `supply/page.tsx:L321-L325` | partial | 4 |  |
| `SupplyTab.swift:L348` Bonding — Structural Steel | `supply/page.tsx:L326-L330` | partial | 4 |  |
| `SupplyTab.swift:L350` Bonding — Lightning | `supply/page.tsx:L331-L335` | partial | 4 |  |
| `SupplyTab.swift:L353-L366` Bonding — Other N/A toggle + text | `supply/page.tsx:L336-L354` FloatingLabelInput + trailing N/A button | match |  |  |
| `SupplyTab.swift:L343-L351` `autoContinuityIfBonded` — auto-sets main bonding continuity PASS when any bond is PASS | MISSING | missing | 4 | Side-effect logic not ported. |
| `SupplyTab.swift:L377-L395` Test results — PFC + Ze + onChange auto-sets polarity + earthing continuity when Ze entered | `supply/page.tsx:L103-L135` PFC + Ze + polarity segmented | partial | 4 | Web lacks the "auto-tick polarity + earthing continuity on Ze entry" side effect. |
| `SupplyTab.swift:L394` Supply polarity toggle | `supply/page.tsx:L116-L135` SegmentedControl Yes/No | match |  |  |
| `SupplyTab.swift:L405-L423` SPD: BS/EN picker + type text + short circuit kA picker + rated A picker | `supply/page.tsx:L357-L381` plain text inputs | partial | 4 | Missing preset pickers + Constants.spdBsEnOptions / spdShortCircuit / spdRatedCurrent. |
| `SupplyTab.swift:L488-L512` Defaults application: SPD/RCD/MainBonding default to "N/A" on first appearance | MISSING | missing | 4 | Web doesn't seed N/A defaults. |
| `SupplyTab.swift:L514-L527` detectCustomValues — re-enable "Other" UI when loaded value isn't in preset list | MISSING | missing | 4 | Only matters once pickers exist. |

---

## Job — Board tab

Multiple boards per job (main + sub-distribution/sub-main), per-board metadata.

iOS sources:

- `CertMateUnified/Sources/Views/JobDetail/BoardTab.swift`

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `BoardTab.swift:L71-L118` horizontal board selector bar with star-for-main + inline plus | `web/src/app/job/[id]/board/page.tsx:L102-L139` board pills + Add + Remove | match |  |  |
| `BoardTab.swift:L22-L48` toolbar actions: Add / Move Left / Move Right / Remove | `board/page.tsx:L121-L138` Add + Remove only | partial | 4 | Web lacks reorder (move left/right). |
| `BoardTab.swift:L50-L62` Remove confirmation dialog "will remove all circuits + observations" | `board/page.tsx:L85-L90` `removeActive` silent | partial | 4 | Web deletes without confirmation dialog and without reference to cascading circuit deletions. |
| `BoardTab.swift:L122-L171` board hero header (designation + location + isSubBoard fedFrom) | `board/page.tsx:L313-L338` HeroBanner aggregated count | partial | 4 | Web hero is static ("Distribution Boards / N boards"); iOS per-board hero shows designation + fedFrom context. |
| `BoardTab.swift:L190` designation field | `board/page.tsx:L143-L147` | match |  |  |
| `BoardTab.swift:L191` name field | `board/page.tsx:L148-L152` | match |  |  |
| `BoardTab.swift:L192` location field | `board/page.tsx:L173-L177` | match |  |  |
| `BoardTab.swift:L193` manufacturer field | `board/page.tsx:L153-L157` | match |  |  |
| `BoardTab.swift` (implicit) — `model` field on iOS? | `board/page.tsx:L158-L162` | ios-only |  | Web has `model`; iOS BoardTab doesn't surface one. Confirm backing model has `model` field. |
| `BoardTab.swift:L196-L203` BoardType picker (main/sub_distribution/sub_main) | `board/page.tsx:L164-L169` SelectChips | match |  |  |
| `BoardTab.swift:L205-L210` Fed From picker (filters other boards) when sub-board | `board/page.tsx:L291-L295` plain text "Feed circuit ref" | partial | 4 | Web has no parent-board picker — just a text field. iOS selects a parent board by ID and inherits earthing. |
| `BoardTab.swift:L370-L389` parentBoardBinding — auto-fills `suppliedFrom` + inherits earthing from parent | MISSING | missing | 4 |  |
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
| `BoardTab.swift:L259` polarity confirmed toggle (✓ sentinel string) | MISSING | missing | 4 | Web Board tab has no polarity toggle. |
| `BoardTab.swift:L260` phases confirmed text | MISSING | missing | 4 |  |
| `BoardTab.swift:L261` RCD trip time ms | `board/page.tsx:L219-L223` | match |  |  |
| `BoardTab.swift:L262` IPF rating kA | `board/page.tsx:L244-L248` | match |  |  |
| `BoardTab.swift:L263` RCD rating mA | `board/page.tsx:L252-L256` | match |  |  |
| `BoardTab.swift:L272` SPD type text | `board/page.tsx:L257-L261` | match |  |  |
| `BoardTab.swift:L273` SPD status text | MISSING | missing | 4 | Web only has SPD type, no spd_status. |
| `BoardTab.swift:L282` overcurrent BS(EN) | MISSING | missing | 4 | Web Board tab doesn't render separate overcurrent device section. |
| `BoardTab.swift:L283` overcurrent voltage | MISSING | missing | 4 |  |
| `BoardTab.swift:L284` overcurrent current | MISSING | missing | 4 |  |
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
| `CircuitsTab.swift:L132-L139` Cancel delete-mode button | MISSING | missing | 5 | Web has no multi-select delete mode at all. |
| `CircuitsTab.swift:L142-L155` Select All / Deselect All in delete mode | MISSING | missing | 5 |  |
| `CircuitsTab.swift:L157-L164` "Delete (N)" bulk delete with count | `circuits/page.tsx:L386-L391` `stub('Delete all')` — non-functional | missing | 5 | Button is present but surfaces "not available on web yet." Listed at line 130. |
| `CircuitsTab.swift:L166-L171` Add circuit button | `circuits/page.tsx:L380-L385` Add → RailButton onClick={addCircuit} | match |  |  |
| `CircuitsTab.swift:L173-L180` Delete mode toggle (enters multi-select) | MISSING | missing | 5 |  |
| `CircuitsTab.swift:L182-L188` Apply Defaults button | `circuits/page.tsx:L392-L397` `stub('Apply defaults')` | missing | 5 | Button rendered but stubbed. |
| `CircuitsTab.swift:L190-L197` Reverse circuits button | `circuits/page.tsx:L398` Reverse → `reverse()` (wired) | match |  |  |
| `CircuitsTab.swift:L199-L222` Calculate menu (Zs = Ze + R1+R2, R1+R2 = Zs − Ze) | `circuits/page.tsx:L399-L404` `stub('Calculate Zs / R1+R2')` | missing | 5 | Full impedance calculator algorithm at `CircuitsTab.swift:L1660+` not ported. |
| `CircuitsTab.swift:L224-L245` CCU Photo button + retry state + mode sheet flow | `circuits/page.tsx:L405-L412` CCU RailButton + hidden `<input capture="environment">` + `handleCcuFile` | partial | 7 | Web triggers camera + hits `/api/analyze-ccu`, but skips mode selection. See CCU Mode Sheet rows below. |
| `CircuitsTab.swift:L247-L260` Extract Doc button + dialog (Take Photo / Library / Files) | `circuits/page.tsx:L413-L420` Extract RailButton + hidden `<input accept="image/*">` + `handleDocFile` | partial | 7 | Web has single library picker only — no camera nor file picker. PDFs explicitly not supported (backend limitation). |

### CCU extraction flow (Mode sheet + match review)

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CCUExtractionModeSheet.swift:L5-L76` 3 modes: Circuit names only / Hardware update / Full capture | MISSING | missing | 7 | Web skips the mode sheet and runs the "circuits only" path. `CCUExtractionMode` enum + mode-specific prompts need porting. |
| `CircuitMatchReviewView.swift:L5-L80` Matched circuits list with reassign + unmatched-existing footer | MISSING | missing | 7 | Mode 2 (hardware update) requires this review sheet. No web UI. |
| `CircuitsTab.swift:L429-L434` CCU mode sheet presentation (`.presentationDetents([.medium])`) | MISSING | missing | 7 |  |
| `CircuitsTab.swift:L437-L445` CCU photo source dialog (Take Photo / Choose from Library) | `circuits/page.tsx:L132-L135` openCcuPicker — opens file picker directly | partial | 7 | Web's `<input capture="environment">` tries camera first but falls back silently to library. Less explicit than iOS dialog. |
| `CircuitsTab.swift:L457-L468` CircuitMatchReviewView sheet + confirmMatches / cancelReview | MISSING | missing | 7 |  |
| `CircuitsTab.swift:L470-L484` extractionVM flowState dispatch (complete/error/savedForRetry) | `circuits/page.tsx:L166-L174` try/catch with `setActionHint` | partial | 7 | Web has success hint + error banner but no "saved for retry" offline queue. |
| `CircuitsTab.swift:L272-L353` PendingExtractionQueue banner + thumbnails + Retry All + auto-retry on network restore | MISSING | missing | 7 | Entire offline-retry queue for CCU photos is iOS-only. Large engineering cost — evaluate need on web. |
| `CircuitsTab.swift:L486-L491` Auto-retry on `NetworkMonitor.shared.isConnected` flip | MISSING | missing | 7 |  |
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
| `rcd_button_confirmed` (RCD Btn) | `Constants.swift:L209` | MISSING | missing | 5 | Web card doesn't expose the boolean RCD-button confirmation. |
| `afdd_button_confirmed` (AFDD Btn) | `Constants.swift:L210` | MISSING | missing | 5 | Same — AFDD button confirmation missing on web. |

### Circuits — grid / layout / misc

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `CircuitsTab.swift:L565-L572` portraitCardGrid vs stickyGrid layout | `circuits/page.tsx:L460-L710` CircuitCard list (collapsible) | partial | 5 | iOS ships a full 29-column horizontally-scrolling sticky grid in landscape. Web uses only the card view. Wide Overview panel at `app/job/[id]/page.tsx:L364-L461` shows read-only version. |
| `CircuitsTab.swift:L580-L600` landscape multi-board section header | MISSING | missing | 5 | Only relevant with sticky grid. |
| `CircuitsTab.swift:L19-L21` polarityManuallyCleared Set<String> (prevents auto-set overwrite) | MISSING | missing | 5 | No auto-set logic on web to require this guard yet. |
| `CircuitsTab.swift:L393-L410` Bulk-delete alert with dynamic count | MISSING | missing | 5 |  |
| `CircuitsTab.swift:L411-L426` Scan Error + Impedance Calculation alerts | `circuits/page.tsx:L304-L329` inline banners | match |  | Shape differs (banner vs alert); same intent. |
| `CircuitsTab.swift:L486-L520` `onChange(of: viewModel.job.circuits.count)` clear stale expandedCircuitId / draggedCircuitId | `circuits/page.tsx:L119` expandedId auto-clear on remove | partial | 5 | Web lacks drag-reorder, so draggedCircuitId N/A. |
| Drag-and-drop reorder (`draggedCircuitId`) | `CircuitsTab.swift:L11` | MISSING | missing | 5 | Web Circuits have no drag reorder. |
| `CircuitsTab.swift:L278-L295` Pending extractions section — thumbnails + Retry All | MISSING | missing | 7 | Covered under CCU flow. |
| `CircuitsTab.swift:L130` stub → `setActionHint(\`${label} — not available on web yet.\`)` | `circuits/page.tsx:L130` same string | missing | 5 | The `stub()` text literally says the feature is unimplemented — every consumer (Delete all, Apply defaults, Calculate) is a targeted gap. |

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
| `ObservationsTab.swift:L22-L45` LazyVStack of ObservationCardView with context-menu delete | `observations/page.tsx:L160-L172` flex-col cards with inline trash button | partial | 4 | Web uses an inline remove button rather than a long-press context menu; trade-off acceptable for desktop. |
| `ObservationsTab.swift:L173-L178` deleteObservation + ObservationScheduleLinker.observationDeleted | `observations/page.tsx:L92-L94` plain list filter | partial | 4 | Web doesn't call an equivalent `ObservationScheduleLinker` to clean up any linked schedule ref (`inspection.items[ref]`). Cross-tab link may leak. |
| `ObservationsTab.swift:L181-L349` AddObservationSheet (NavigationStack with 3 sections) | `components/observations/observation-sheet.tsx` | match |  |  |
| AddObservationSheet Classification picker (C1/C2/C3/FI with label) `L201-L207` | `observation-sheet.tsx` CODE_OPTIONS hint row | match |  |  |
| AddObservationSheet Location field `L215-L216` | observation-sheet.tsx location input | match |  |  |
| AddObservationSheet Observation text (multiline) `L217-L220` | observation-sheet.tsx description multiline | match |  |  |
| AddObservationSheet Schedule Item (e.g. 4.4) `L220-L221` | MISSING | missing | 4 | Web sheet has no "Schedule Item" input field. Populated via Inspection tab instead. |
| AddObservationSheet remedial action | iOS has no `remedial` field in AddObservationSheet | `observation-sheet.tsx` + page.tsx:L287-L294 Remedial block | partial | 4 | Web adds a `remedial` field; iOS surfaces remedial via `EditObservationSheet.swift:L210+` (confirmed separately in `Views/JobDetail/EditObservationSheet.swift` not fully read). |
| Photos section — horizontal scroll of ObservationPhotoThumbnail with X-button remove `L230-L256` | `observation-sheet.tsx` photo grid with delete | match |  |  |
| Camera button (fullScreenCover → PhotoCaptureView) `L267-L272` | observation-sheet.tsx Camera input (`capture="environment"`) | partial |  | iOS uses native camera overlay; web uses OS file input. Acceptable. |
| PhotosPicker Library button `L260-L266` | observation-sheet.tsx Library input | match |  | iOS PhotosPicker is native; web library file input covers same case. |
| onAppear / toolbar Save + Cancel + Add (disabled when text empty) `L285-L302` | observation-sheet.tsx Save / Cancel | match |  |  |
| ObservationCardView photo thumbnails (inline preview, tap to enlarge) | `observations/page.tsx:L296-L316` ObservationPhoto thumbs + "+N more" chip | match |  |  |
| Tap ObservationCardView → open edit sheet | observations/page.tsx:L237, ObservationCard onOpen | match |  |  |
| Inline observation editor surfaced in Inspection tab when C1/C2/C3 tapped (`InspectionTab.swift:L286-L298` + `Components/InlineObservationForm.swift`) | MISSING | missing | 4 | Web Inspection tab doesn't spawn an inline observation form on outcome click. See Inspection tab rows. |

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
| `InspectionTab.swift:L266-L284` linked-observation inline preview under a row | MISSING | missing | 4 | When an outcome has a linked observation, iOS renders the full `ObservationCardView` inline (tap to open edit sheet). Web just shows the outcome chip. |
| `InspectionTab.swift:L286-L300` InlineObservationForm when C1/C2/C3 selected (location + text + Save) | MISSING | missing | 4 | Web lacks inline create-observation flow from schedule outcome click. Inspector has to switch tabs. |
| `InspectionTab.swift:L43-L66` confirmation alert "Delete linked observation?" when outcome changes | MISSING | missing | 4 | Side-effect of missing linked-observation integration. |

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
| `InspectorTab.swift:L67-L72` fetchAllInspectors on appear | `staff/page.tsx:L71-L72` reads `data.inspectors` from job | partial | 4 | Web reads inspectors embedded on the job object, not a dedicated `/api/inspectors` call. Matches MVP pattern; fine unless roster must diverge between dashboard + job. |

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
| `PDFTab.swift:L68-L121` hero with pulsing status dot ("PDF generated" / "Not yet generated") | `web/src/app/job/[id]/pdf/page.tsx:L61-L86` hero with ready/not-ready dot | match |  |  |
| `PDFTab.swift:L125-L155` Missing-data warnings card | `pdf/page.tsx:L88-L113` SectionCard "Missing data" with computed warnings | match |  |  |
| `pdf/page.tsx:L133-L162` web-only warning computation (installation addr / inspection date / ≥1 board / ≥1 circuit / staff roles) | iOS calls `viewModel.pdfWarnings()` from backend | partial | 2 | Web computes warnings client-side; iOS delegates to its view-model. Both render identical warning strings. |
| `PDFTab.swift:L178-L200` Generate PDF button (gradient, green→blue) | `pdf/page.tsx:L117` ActionButton Generate — `disabled` | missing | 2 | **Web has no PDF generation wired.** Button is visually present but `disabled`. Backend endpoint `/api/pdf/:jobId` exists and works for iOS. |
| `PDFTab.swift:L203-L222` Preview PDF button (opens PDFPreviewController sheet) | `pdf/page.tsx:L118` ActionButton Preview — `disabled` | missing | 2 | Needs PDF render + iframe/object embed on web. |
| `PDFTab.swift:L225-L237` Share PDF via ShareLink | `pdf/page.tsx:L119` Share — `disabled` | partial | 2 | Web could use Web Share API (`navigator.share` / `navigator.canShare`) for files on capable browsers; desktop fallback is just download. |
| `PDFTab.swift:L243-L262` Generating overlay (ProgressView + ultraThinMaterial) | MISSING | missing | 2 | Needs loading state once Generate is wired. |
| `PDFTab.swift:L270-L292` `generateLocalPDF()` — `PDFGenerator.generate(from: job)` + temp file + ShareLink URL | MISSING (backend-only) | backend | 2 | iOS renders PDF on-device via WKWebView (EICRHTMLTemplate.swift). Web must call the **server** `/api/pdf/:jobId` endpoint (Python ReportLab + Playwright in backend). Confirm backend endpoint authenticated with JWT + returns `application/pdf`. |
| `pdf/page.tsx:L121-L125` "PDF generation isn't wired up on web yet" copy | N/A | missing | 2 | Copy confirms the gap; replace once wired. |
| `PDFTab.swift:L53-L57` `.sheet(isPresented: $showPreview)` PDFPreviewController (UIViewControllerRepresentable over PDFKit) | MISSING | ios-only |  | Native PDFKit viewer; web uses `<embed>` or pdf.js. |

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
| `RecordingOverlay.swift:L47-L64` Voice feedback toggle (speaker.wave.2.fill / speaker.slash) | `recording-chrome.tsx:L152-L158` ParityButton disabled "iOS-only" | missing | 8 | Web has the TTS text-to-speech confirmation feedback disabled; hook into AlertManager + ElevenLabs. |
| `RecordingOverlay.swift:L66-L83` Defaults button (slider.horizontal.3 purple) → onSetDefaults | `recording-chrome.tsx:L159-L165` ParityButton disabled | missing | 8 | Requires defaults editor (Phase 6) + apply flow. |
| `RecordingOverlay.swift:L86-L102` Apply Defaults button → onApplyDefaults | `recording-chrome.tsx:L166-L172` ParityButton disabled | missing | 8 |  |
| `RecordingOverlay.swift:L105-L121` CCU Photo button (orange) | `recording-chrome.tsx:L177-L182` deep-link to /circuits | partial | 8 | Web deep-links to Circuits tab — iOS handles it inline from recording. |
| `RecordingOverlay.swift:L124-L140` Doc Extract button (cyan) | `recording-chrome.tsx:L183-L188` deep-link to /circuits | partial | 8 |  |
| `RecordingOverlay.swift:L143-L159` Observation camera button | `recording-chrome.tsx:L189-L194` deep-link to /observations | partial | 8 |  |
| `RecordingOverlay.swift:L163-L178` End Session button (stop.fill red) + `showEndSessionConfirmation` | `recording-chrome.tsx:L198-L203` CircleButton End → `stop()` | partial | 8 | Web skips confirmation; iOS presents a parent-owned alert to confirm. |
| `RecordingOverlay.swift:L182-L204` Pause/Resume/Start (mic.fill / pause.fill / play.fill) with tint | `recording-chrome.tsx:L207-L222` Pause / Resume CircleButton | match |  |  |
| `RecordingOverlay.swift:L255-L277` Geministatus content — VADIndicator + Waveform + extraction status | `recording-chrome.tsx:L282-L308` VuMeter + StatePill | partial | 8 | Web StatePill rolls VAD state + status into one pill. Acceptable simplification. |
| `VADIndicatorView.swift:L1-L27` coloured circle (idle/listening/speaking/trailing) pulse | `recording-chrome.tsx:L240-L266` StatePill (different shape) | partial | 8 | Web combines into StatePill; iOS VAD indicator is separate. |
| `WaveformView` | `recording-chrome.tsx:L282-L308` VuMeter (24 bars) | match |  | Different algorithm but same role (mic-level vis). |
| `ProcessingBadgeView.swift:L5-L25` "Processing Audio (N)" animated badge | MISSING | missing | 8 | Web doesn't surface a processing-count badge while Sonnet works. |
| `PendingDataBanner.swift:L1-L20` "N unassigned readings" warning | MISSING | missing | 8 | Web has no concept of "pending/unassigned readings" surfaced in the UI. |
| `AlertCardView.swift:L1-L60+` non-blocking validation alert card (C1/C2/C3 severity icon + Yes/No/Dismiss + queued count) | MISSING | missing | 8 | Sonnet validation alerts (e.g. "Ring continuity on Circuit 3?") aren't rendered on web. Backend emits `validationAlert` events via websocket. |
| `TranscriptStripView.swift:L35-L100` pulsing dot + horizontal transcript + latest confirmed field badge | `web/src/components/recording/transcript-bar.tsx:L24-L100+` top-docked transcript bar with pulse + interim italic | partial | 8 | Web keeps rolling transcript tail; iOS focuses on the LAST line with highlight flash when a field confirms. Similar intent, different edge behaviour. |
| Transcript highlight flash (keyword spotlight + colour) | TranscriptStripView:L94+ highlights array | MISSING | missing | 8 | Web transcript doesn't flash the keyword that just confirmed a field. |
| `LiveFillView.swift:L1-L1554` full-form live dashboard with compact landscape layout | `web/src/components/live-fill/live-fill-view.tsx:L1-L60+` equivalent overlay | partial | 8 | Web LiveFillView covers most sections (installation / supply / board / circuits / observations) but lacks iOS-specific: CCU slot crops tap-to-correct grid (`LiveFillView.swift:L44-L47`), per-section compact horizontal layout, "purpose of report" picker sheet, inline general-condition picker. |
| `LiveFillView.swift:L44-L47` `ccuSlotsSection` tap-to-correct for geometric extraction crops | MISSING | missing | 8 | Requires geometric CCU pipeline slot crops. Likely deferred to Phase 7 alongside CCU modes. |
| `LiveFillView.swift:L12-L14` showGeneralConditionPicker / showPurposeOfReportPicker / showInstallationTypePicker sheets | MISSING | missing | 8 |  |
| `DebugDashboardView.swift:L22-L60` hidden debug dashboard (triple-tap Settings version) with Live / Regex / Sonnet / Stats tabs | MISSING | missing | 9 | Developer-only; lowest priority. |
| Voice command executor (e.g. "move to circuit 5", "set OCPD to 32A") | iOS `AlertManager.shared` / voice commands | MISSING | missing | 8 | Web doesn't parse voice commands; only transcript goes to Sonnet. |
| Cost bar / cost pill — `$X.XX` during recording | `recording-chrome.tsx:L131-L138` formatCost + formatElapsed | match |  |  |
| `formatElapsed` timer during recording | recording-chrome.tsx same | match |  |  |
| 3-tier sleep (Active / Dozing / Sleeping) indicator | `recording-chrome.tsx:L240-L266` state-pill supports dozing/sleeping | match |  |  |
| `recording-chrome.tsx:L41-L49` RecordingRing (pulsing border around page) — keeps page visible during recording | iOS keeps overlay floating over the page | partial |  | Different visual treatment; both achieve the "page visible while recording" goal. |
| `recording-chrome.tsx:L147-L158` Voice button `disabledReason="Voice prompts are iOS-only for now."` | covered above | missing | 8 |  |
| `recording-chrome.tsx:L163-L171` Apply button `disabledReason="Apply-last-snapshot is iOS-only for now."` | covered above | missing | 8 |  |
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
| `SettingsHubView.swift:L141-L145` Invite Employee row | Covered inside `/settings/company/dashboard` invite dialog (`dashboard/page.tsx` Dialog) | match |  | Web merges Invite into Company Dashboard tab; iOS has dedicated nav entry. |
| `SettingsHubView.swift:L154-L174` Certificate Defaults section (Cable Size Defaults + Default Values) | MISSING | missing | 6 | Entire Defaults system missing on web. |
| `SettingsHubView.swift:L179-L191` Account section: Change Password | MISSING | missing | 6 | `ChangePasswordView.swift` (495 lines) not ported. **Backend endpoint `/api/auth/change-password` must exist** — check. |
| `SettingsHubView.swift:L196-L235` App section: Audio Import / Terms & Legal / Version row | MISSING | missing | 6 | None of the three surfaces exist on web. |
| `SettingsHubView.swift:L200-L205` Audio Import → `AudioImportView` | MISSING | missing | 6 | iOS-only (file picker into Deepgram pipeline for testing?). Evaluate web need. |
| `SettingsHubView.swift:L209-L213` Terms & Legal → `TermsAcceptanceView` | MISSING | missing | 6 | Legal copy is in `CertMateUnified/legal/`; needs web rendering. Compliance requirement. |
| `SettingsHubView.swift:L217-L231` Version row (non-navigable, shows app version + blue pill) | MISSING | missing | 6 | Trivial; just a footer `v${PKG.version}`. Could also triple-tap to open Debug Dashboard. |
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
| `AdminQueueView.swift:L1-L451` admin queue (pending jobs / retry / failures) | MISSING | missing | 6 | No web admin queue. 451 LoC — medium task. Backend route likely `/api/admin/queue`. |
| `AdminStatsView.swift:L1-L305` admin stats dashboard (totals / charts / breakdowns) | `web/src/app/settings/company/dashboard/page.tsx` stats tab (partial) | partial | 6 | Web has Company stats but not **system-wide** admin stats. Required endpoint `/api/admin/stats`. |
| `CompanyDashboardView.swift:L1-L583` Jobs / Team / Stats tabs + invite employee dialog | `web/src/app/settings/company/dashboard/page.tsx:L1-L671` | match |  |  |
| `InviteEmployeeView.swift:L1-L248` invite form (name/email/auto-gen password surfaced once) | Merged into Company Dashboard Team tab in web | match |  |  |

### Defaults management

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `DefaultsManagerView.swift:L1-L272` list of certificate presets + add/edit/delete | MISSING | missing | 6 | Entire Defaults feature not on web. |
| `DefaultValuesView.swift:L1-L194` per-tab (Installation/Supply/Board/Circuits/Observations/Inspection/Extent/Design) default-value editor with named preset save | MISSING | missing | 6 | Re-uses all tab editors in a "template" mode. Significant engineering. |
| `CableSizeDefaultsView.swift:L1-L212` cable CSV defaults by OCPD rating + material + ref method | MISSING | missing | 6 | Domain-specific preset editor. |
| `ApplyDefaultsSheet.swift:L1-L95` "Apply these defaults to this job?" confirmation | MISSING | missing | 6 |  |

### Change password

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `ChangePasswordView.swift:L1-L60+` current + new + confirm + strength meter + show/hide toggles | MISSING | missing | 6 | Backend route must accept `{currentPassword,newPassword}` — verify `/api/auth/change-password` exists. |
| `ChangePasswordView.swift:L41-L55` password strength (0-4) calculation | MISSING | missing | 6 |  |
| `ChangePasswordView.swift` keyboard focus fluidity (FocusState) | MISSING | missing | 9 | iOS affordance; web auto-tab works. |

### App → Audio Import + Terms

| ios-ref | web-ref | status | phase | notes |
|---|---|---|---|---|
| `AudioImportView.swift` import existing audio recording into Deepgram pipeline | MISSING | missing | 6 | Confirm backend supports this upload path on web; likely iOS test affordance only. |
| `Views/Launch/TermsAcceptanceView.swift` + `Views/Launch/LegalTexts.swift` | MISSING | missing | 6 | Legal page; can just render `legal/terms.md`. |

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
| `CMSectionCard.swift` — gradient-bordered card with category-coded accent | `web/src/components/ui/section-card.tsx` | match |  |  |
| Hero gradient (blue→green or green→blue) used on every tab header | web tab pages render equivalent gradients | match |  |  |
| Staggered section entrance (`cmStaggeredEntrance(index:appeared:)`) | MISSING | missing | 9 | Web tabs don't have per-card stagger-in animations. Consider `framer-motion` or CSS `animation-delay`. |
| Data-arrival flash (`DataArrivalFlash.swift`) — blue flash when Sonnet fills a field | `web/src/components/live-fill/live-field.tsx` | partial | 8 | Web has LiveField with flash; check visual parity. |
| `CMFloatingTextField` floating-label input | `web/src/components/ui/floating-label-input.tsx` | match |  |  |
| `CMFloatingPicker` | `web/src/components/ui/select-chips.tsx` + `labelled-select.tsx` | match |  |  |
| `CMUnitTextField` (text with trailing unit) | `web/src/components/ui/floating-label-input.tsx` `trailing` slot | match |  | Used in Supply tab for Ω / V / A / kA. |
| `CMDatePickerField` | `<input type="date">` native | match |  |  |
| `SignatureCaptureView` | `web/src/components/settings/signature-canvas.tsx` | match |  |  |
| `PhotoCaptureView` (fullScreenCover native camera) | `<input type="file" accept="image/*" capture="environment">` | partial |  | Different native affordance. |
| `PhotoPickerView` (PhotosPicker) | `<input type="file">` | partial |  |  |
| `StatusBadge` (valid/expired/expiring/pending coloured pills) | `web/src/components/ui/pill.tsx` | match |  |  |
| `OutcomeButtonGroup.swift` (✓/✗/N/A/LIM/C1/C2/C3/FI chip row) | inlined in `inspection/page.tsx` ScheduleRow | match |  |  |
| `TypingText.swift` typing animation | MISSING | missing | 9 | iOS uses this for tour narration subtitles. |
| `OfflineBanner.swift` (top of dashboard when offline) | `web/src/components/pwa/offline-indicator.tsx` (header pill) | partial | 9 | Visual shape differs. |
| Skeleton shimmer (dashboard loading) | `globals.css` `.cm-shimmer` + `dashboard/page.tsx:L225-L233` | match |  |  |
| Job-deletion confirmation alert (universally) | MISSING on dashboard row | missing | 9 | Covered above. |
| `components/ui/confirm-dialog.tsx` | reused in Settings outbox discard | match |  |  |
| Brand logo | `components/brand/logo.tsx` | match |  |  |
| Tab bar / sidebar navigation shell | `components/layout/app-shell.tsx` | match |  |  |
| Job header (back + title + menu) | `components/job/job-header.tsx` | partial | 4 | Menu missing (see Overview tab). |
| Job tab nav pill bar | `components/job/job-tab-nav.tsx` | match |  |  |
| Floating mic FAB when idle | `components/job/floating-action-bar.tsx` | match |  |  |
| `recording-context.tsx` sonnet+deepgram plumbing | Already shipped Phase 4 | match |  |  |
| Haptic feedback on taps (`UIImpactFeedbackGenerator`) | MISSING | missing | 9 | Vibration API on mobile Safari is inconsistent; evaluate. |
| Reduce-motion respect (`@Environment(\.accessibilityReduceMotion)`) | `globals.css` `@media (prefers-reduced-motion: reduce)` sparse usage | partial | 9 | Web has some respect; iOS pervasively checks. |
| `components/pwa/install-button.tsx` — Add to Home Screen button | `components/pwa/install-prompt-provider.tsx` | ios-only |  | Web-only (iOS is a native app). |
| `components/pwa/sw-update-provider.tsx` — service-worker update notification | — | ios-only |  | Web-only. |
| `components/pwa/offline-indicator.tsx` | — | ios-only |  | iOS uses `OfflineBanner`. |
| `components/ui/numeric-stepper.tsx` | MISSING iOS equivalent (iOS uses Picker) | ios-only |  | Web-specific affordance. |
| `components/ui/segmented-control.tsx` | `Picker(.segmented)` iOS | match |  |  |
| `components/ui/select-chips.tsx` | `CMFloatingPicker` or `Picker(.segmented)` | match |  |  |
| `components/ui/floating-label-input.tsx` | `CMFloatingTextField` | match |  |  |
| `components/ui/multiline-field.tsx` | `TextField(axis:.vertical, lineLimit:)` | match |  |  |
| `components/ui/icon-button.tsx` 44×44 hit target primitive (Wave 4 D8) | iOS uses native Button with frame(minHeight: 44) | match |  | Ensures WCAG 2.1 AA touch target. |

