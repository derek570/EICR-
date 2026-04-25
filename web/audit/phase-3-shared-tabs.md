# Phase 3: Shared job tabs (Overview, Installation, Supply, Board, Circuits) — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction   Canon: iOS_

## Summary
Gaps found: **27**  (P0: 9  P1: 13  P2: 5)
Exceptions (intentional divergence, documented): 1 (see Exceptions § — Circuits card-view handoff comment)

Scope covered: Overview + Installation + Supply + Board + Circuits content, fields, cert-type branching and data-shape parity. Excluded per brief: tab-bar visibility (Phase 1), CCU fuseboard matcher (Phase 8), Inspection/Observations/Extent/Design/Staff/PDF (Phase 4/5).

Top-level observation: the single largest parity bug is the web's **data-shape model**. iOS writes `job.installationDetails`, `job.supplyCharacteristics`, `job.boards` (array) and `job.circuits` (flat array) at the root of the `Job` record. The PWA has silently re-bucketed these as `job.installation`, `job.supply`, `job.board.boards`, `job.circuits`. A Sonnet extraction written into the canonical iOS keys by the backend does NOT appear in the PWA UI without a server-side translation layer that I could not find (`web/src/lib/job-context.tsx:1-250`, `web/src/lib/types.ts:226-247` — all four are `Record<string, unknown>`, not the typed iOS structs). Individual field-level gaps below assume the bucket keys will be reconciled first; the bucket mismatch itself is Gap #1.

---

## Tab 1 — OVERVIEW (/job/[id]/page.tsx vs iOS LiveFillView / tab 0)

## Gap #1 — Tab-data bucket names diverge between iOS and PWA  [P0]
**Area:** All five tabs — wire format at the top of the `Job` struct.
**iOS behaviour:** Canonical keys on `Job` (Swift) are `installationDetails`, `supplyCharacteristics`, `boards` (array of `BoardInfo`), `circuits` (flat `Circuit[]`), `inspectionSchedule` — `CertMateUnified/Sources/Views/JobDetail/InstallationTab.swift:35-42` (`installationDetails`), `SupplyTab.swift:10-13` (`supplyCharacteristics`), `BoardTab.swift:16-17` / `74` (`boards`), `CircuitsTab.swift:180-183` (`job.circuits` & `job.boards`). All Codable with snake_case CodingKeys — `InstallationDetails.swift:34-58`, `SupplyCharacteristics.swift:65-111`, `BoardInfo.swift:60-90`, `Circuit.swift:44-79`.
**PWA behaviour:** `JobDetail` aliases these as `installation`, `supply`, `board` (object containing `boards: BoardRecord[]`), `circuits` — `web/src/lib/types.ts:226-247`. All typed as `Record<string, unknown>` — every field access is an unchecked string lookup (`web/src/app/job/[id]/page.tsx:47-49`, `installation/page.tsx:91-94`, `supply/page.tsx:46-47`, `board/page.tsx:63-65`).
**Evidence:** `web/src/lib/types.ts:226-247`:
```
installation?: Record<string, unknown>;
extent?: Record<string, unknown>;
supply?: Record<string, unknown>;
board?: Record<string, unknown>;
circuits?: CircuitRow[];
```
**User impact:** A job saved by iOS arrives at the PWA under `installation_details`, `supply_characteristics`, `boards`, `circuits` (the iOS JSON). The web reads from `installation`, `supply`, `board.boards`, so every field renders as `'—'` / empty until something normalises — no such normaliser appears in `web/src/lib/api-client.ts` or `job-context.tsx`. A PWA-saved job going back to iOS decodes `installationDetails = nil` and loses all installation data. This is the root cause that multiplies into Gaps #6-#26.
**Proposed fix (do not apply):** Pick one (iOS canon per durable rule). Preferred: rename PWA top-level keys to `installation_details`, `supply_characteristics`, `boards`, and keep `circuits` (it already matches). Alternatively, translate in a single place (`api-client.ts::job()`) and the inverse in `queue-save-job.ts`.
**Touchpoints:** `web/src/lib/types.ts`, `web/src/lib/api-client.ts`, `web/src/lib/pwa/queue-save-job.ts`, every `job/[id]/*` page that references the four aliases.

## Gap #2 — Overview page is read-only; iOS Overview is the LiveFillView during recording  [P1]
**Area:** Overview tab — intent.
**iOS behaviour:** Tab 0 conditionally renders `TranscriptBarView + LiveFillView` while recording (`JobDetailView.swift:273-281`), so it IS the live-fill writing surface — circuits populate in place, fields flash as Sonnet writes them, inspector can see the form change while dictating.
**PWA behaviour:** `page.tsx` is strictly read-only hero tiles + panels that deep-link to the edit tabs (`web/src/app/job/[id]/page.tsx:37-169`). The header doc-comment even calls this out: "Every field is read-only here; edits still happen on the dedicated tab pages." The job layout notes it "always renders during a recording session" (`layout.tsx:132-141`), so the surface exists, it's just not the same surface iOS uses.
**Evidence:** `web/src/app/job/[id]/page.tsx:35-38` comment: "switching to the dashboard layout means they can see hero values populate live as Sonnet extracts them, without having to leave the Overview tab."
**User impact:** On iOS the inspector sees the full circuit schedule update mid-dictation. On the PWA they see five hero tiles and a compact circuits table, then have to tap into `/circuits` to see the full edit surface. Acceptable as a design choice for small screens, but it is divergent from iOS and no handoff file authorises it.
**Proposed fix:** Either document as Exception (inspector already approved card-vs-schedule trade-off — see Exceptions §) or add the full 29-column table behind a landscape breakpoint (already partially shipped — see Gap #3).
**Touchpoints:** `web/src/app/job/[id]/page.tsx`.

## Gap #3 — WideCircuitsPanel renders a 29-column table that is actually missing 3 iOS columns  [P1]
**Area:** Overview → wide circuits panel.
**iOS behaviour:** `Constants.circuitFieldOrder` is 30 entries (`Constants.swift:180-211`) and an iOS unit test enforces the count: `UtilitiesTests.swift:204` `XCTAssertEqual(Constants.circuitFieldOrder.count, 30)`.
**PWA behaviour:** `WideCircuitsPanel` renders its own bespoke 29-column layout (`web/src/app/job/[id]/page.tsx:387-517`). Counting the `<td>`s emitted by `WideCircuitRow`: 29 cells. The header comment above it claims "full 29-column circuit matrix" — that is wrong relative to iOS which has 30.
**Evidence:** Compared iOS `Constants.circuitFieldOrder:180-211` (30 rows) vs PWA `WideCircuitRow:463-518` columns. **Missing on PWA:** `max_disconnect_time_s`. **Present in iOS but absent from WideCircuitRow group header:** the "Disconnection" group (iOS `Constants.circuitFieldGroups:217`). The PWA groups are also re-named: iOS uses "Circuit Details / Conductors / Disconnection / Overcurrent Devices / RCD / Ring Final / Continuity / Insulation Resistance / Test Results"; PWA uses "Circuit / Cond / Dt / OCPD / RCD / Ring / Cont / IR / Test" (`web/src/app/job/[id]/page.tsx:390-418`). The abbreviations are fine; the **missing Dt column** is not.
**User impact:** Inspector glancing at the landscape Overview cannot confirm the max disconnection time value was captured — the column does not exist in the web DOM at all. Misses a safety-critical BS 7671 field.
**Proposed fix:** Add `max_disconnect_time_s` cell under the "Dt" group (iOS has it as one of two Dt-column fields; PWA currently shows `live_csa_mm2` + `cpc_csa_mm2` in that slot, which iOS puts under "Conductors").
**Touchpoints:** `web/src/app/job/[id]/page.tsx:419-449,463-518`.

## Gap #4 — Overview hero box field keys are guess-reads, unaligned with iOS canonical names  [P1]
**Area:** Overview → five hero boxes (Client / Installation / Supply / Main Fuse / Earthing).
**iOS behaviour:** iOS does not ship an equivalent hero-strip; the Overview is LiveFillView (see Gap #2). Values come from `job.installationDetails.*`, `job.supplyCharacteristics.*`, `job.boards[0].*` directly.
**PWA behaviour:** `page.tsx:87-120` reads `supply.ze_ohm ?? supply.ze`, `supply.pfc_ka ?? supply.pfc`, `supply.main_fuse_bs_en ?? board.main_switch_bs_en`, `supply.main_fuse_rating_a ?? board.main_switch_rated_current_a`, `supply.tails_csa_mm2 ?? supply.tails_csa`, `supply.earthing_conductor_csa_mm2 ?? supply.earthing_conductor_csa`, `supply.main_bonding_csa_mm2 ?? supply.main_bonding_csa` — none of these left-hand keys exist in the iOS `SupplyCharacteristics` model.
**Evidence:** iOS canon from `SupplyCharacteristics.swift:66-111`: the real keys are `earth_loop_impedance_ze`, `prospective_fault_current`, `main_switch_bs_en` (NOT `main_fuse_bs_en`), `main_switch_current` (NOT `main_fuse_rating_a`), `earthing_conductor_csa` (NOT `..._mm2`), `main_bonding_csa`. The PWA Overview guesses both a shadow "mm2" suffix set and a shadow "main_fuse_*" namespace that neither iOS nor the backend emits.
**User impact:** All five hero boxes except `earthing_arrangement` render `'—'` on any iOS-sourced job because the left-hand fallback never matches. The right-hand fallbacks DO match (e.g. `supply.ze` matches nothing either — the canonical key is `earth_loop_impedance_ze`).
**Proposed fix:** Use iOS canonical keys: `earth_loop_impedance_ze`, `prospective_fault_current`, `main_switch_bs_en`, `main_switch_current`, `earthing_conductor_csa`, `main_bonding_csa`.
**Touchpoints:** `web/src/app/job/[id]/page.tsx:87-120`.

## Gap #5 — Overview hero Ze@DB is read from `supply.ze_at_db_ohm`; iOS stores Ze per BOARD  [P1]
**Area:** Overview → Supply hero.
**iOS behaviour:** `BoardInfo` stores per-board `ze` and `zsAtDb` (`BoardInfo.swift:29-31`, `BoardTab.swift:296-298`). There is NO supply-level `ze_at_db` concept — each board records its own Ze.
**PWA behaviour:** `page.tsx:94` reads `supply.ze_at_db_ohm ?? supply.ze_at_db`, treating it as a supply property.
**Evidence:** `web/src/app/job/[id]/page.tsx:94`:
```
['Ze@DB', str(supply.ze_at_db_ohm) ?? str(supply.ze_at_db)],
```
**User impact:** Always em-dash because those keys aren't written anywhere. Inspector can't glance at DB-level Ze from Overview — has to open Board tab and page through each board.
**Proposed fix:** Pull from `boards[0].ze` / `zs_at_db` or enumerate all boards.
**Touchpoints:** `web/src/app/job/[id]/page.tsx:87-97`.

---

## Tab 2 — INSTALLATION (/job/[id]/installation/page.tsx vs InstallationTab.swift)

## Gap #6 — Postcode autocomplete missing on PWA  [P1]
**Area:** Installation → address / client-address postcode fields.
**iOS behaviour:** Debounced (400ms) lookup against `APIClient.shared.lookupPostcode()`; fills town + county if empty and normalises the postcode itself (`InstallationTab.swift:219-306`).
**PWA behaviour:** `Postcode` is a plain text input, no lookup triggered — `web/src/app/job/[id]/installation/page.tsx:158-162, 197-201`. No autocomplete, no API call.
**User impact:** Inspector must type town + county manually on every job — iOS users expect the postcode-type-and-tab muscle memory to work.
**Proposed fix:** Add `debounce + fetch` against `/api/lookup/postcode` (if the backend endpoint exists; otherwise add).
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx`, `web/src/lib/api-client.ts`.

## Gap #7 — `Next inspection (years)` is a numeric stepper; iOS is a `Picker` restricted to `Constants.inspectionIntervals`  [P1]
**Area:** Installation → Inspection dates → years field.
**iOS behaviour:** `Picker("Next inspection (years)", selection: ... , ForEach(Constants.inspectionIntervals, ...))` — a dropdown of allowed values only (`InstallationTab.swift:103-107`).
**PWA behaviour:** `<NumericStepper min={1} max={10} step={1}>` (`installation/page.tsx:226-233`) — allows values 1-10 inclusive, no gating.
**Evidence:** `installation/page.tsx:226-233`:
```
<NumericStepper label="Next inspection (years)" value={...} onValueChange={setYears} min={1} max={10} step={1} />
```
**User impact:** Inspector can save arbitrary values like "7 years" which do not match the BS 7671 Best Practice Guide 4 periodicity table that `Constants.inspectionIntervals` enumerates. On a PDF round-trip the cert fails schema validation.
**Proposed fix:** Replace with a `<SelectChips>` or `<Picker>`-equivalent using the same values as iOS `Constants.inspectionIntervals`.
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx:226-233`.

## Gap #8 — PWA omits the in-tab inspector/staff picker iOS renders on this tab  [P1]
**Area:** Installation → Staff section.
**iOS behaviour:** Installation tab renders a **full inspector picker + inline create sheet** inside a `CMSectionCard` after the Premises / Report Details blocks (`InstallationTab.swift:343-490`): horizontal pills of saved inspectors, Add New inline form with signature capture, auto-select-default-if-none, deleted-inspector warning label.
**PWA behaviour:** Installation page renders a `SectionCard` with subtitle "Inspector assignment lives on the Staff tab." and no interactive content — `web/src/app/job/[id]/installation/page.tsx:358-365`. The Staff tab itself has a separate roster-loading bug (Phase 1 Gap #5).
**User impact:** Two extra taps to assign an inspector vs one tap on iOS. Inspector has to navigate away from the cert-details context, assign, then navigate back.
**Proposed fix:** Embed an inspector pill picker inside Installation (simple select from the user's roster — no inline Add, keep that on /staff).
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx`, `web/src/lib/api-client.ts` (inspector roster — currently unwired; see Phase 1 Gap #5).

## Gap #9 — `Email` field is not its own grid row on iOS but is on PWA  [P2]
**Area:** Installation → Client details layout.
**iOS:** Client email is a standalone floating-label field below the grid (`InstallationTab.swift:66-67`).
**PWA:** Email is a standalone floating-label field below the grid (`installation/page.tsx:170-177`).
Actually matches. Withdrawn — no gap.

## Gap #9 (revised) — `Premises` description chip set does not include iOS `Constants.premisesDescriptions` full list  [P1]
**Area:** Installation → Premises → Description chips.
**iOS behaviour:** Options come from `Constants.premisesDescriptions` — not inlined, but drives the Picker at `InstallationTab.swift:122-127`. (Constants file not re-read here; per iOS tradition this is a longer list than Residential/Commercial/Industrial/Other.)
**PWA behaviour:** Hard-coded four values: `Residential / Commercial / Industrial / Other` — `installation/page.tsx:79-84`.
**User impact:** Can't tick "Agricultural", "Educational", "Healthcare", etc. if iOS supports them — PDF shows the restricted PWA value which iOS may not round-trip to the same rendered label.
**Proposed fix:** Verify `Constants.premisesDescriptions` list and align chip options 1-1.
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx:79-84`.

## Gap #10 — `Records available` + `Evidence of additions` render as SegmentedControl pass/fail; iOS uses a `Toggle`  [P2]
**Area:** Installation → Premises.
**iOS behaviour:** Two `Toggle` rows (`InstallationTab.swift:130-133`) — binary on/off.
**PWA behaviour:** Two `<SegmentedControl variant='pass'|'fail'>` with three implicit states: yes / no / null (`installation/page.tsx:252-289`).
**User impact:** Functional difference — PWA has a null tri-state (never clicked) that iOS does not. A fresh job on iOS = `false`; on PWA = `null`. Save/load round-trip probably survives but the "pass / fail" chrome (`variant: 'pass' | 'fail'`) implies a regulatory assertion rather than a user preference, which is wrong copy for this field.
**Proposed fix:** Swap to a neutral toggle-style control (checkbox or SegmentedControl with `variant: 'info'`).
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx:252-289`.

## Gap #11 — `Date of previous inspection` should support an "N/A" value on EICR  [P1]
**Area:** Installation → Inspection dates (EICR only).
**iOS behaviour:** `CMDatePickerStringField(label: "Date of Previous Inspection", dateString: ..., allowNA: true)` — the field can be set to "N/A" (`InstallationTab.swift:96-100`). `dateOfPreviousInspection` is a `String?` not a `Date?` on iOS (`InstallationDetails.swift:25`).
**PWA behaviour:** Plain `<FloatingLabelInput type="date">` — no N/A option. An HTML date input cannot store the literal "N/A" (`installation/page.tsx:219-225`).
**User impact:** Inspector who knows there's no prior cert can't mark the field as "N/A" — has to leave it blank, which downstream tooling may not distinguish from "unknown".
**Proposed fix:** Replace with a date-or-N/A composite (checkbox toggles between date-picker and "N/A" literal).
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx:219-225`.

## Gap #12 — `ensureDateOfInspection()` seed logic missing on web  [P1]
**Area:** Installation → auto-populated defaults.
**iOS behaviour:** On appear, iOS seeds `dateOfInspection = Date()`, `nextInspectionYears = 5`, and computes `nextInspectionDueDate` (`InstallationTab.swift:503-528`). Guarantees the PDF always has these values even for a never-touched job.
**PWA behaviour:** No seed; `date_of_inspection` stays unset until the user picks one (`installation/page.tsx:212-217`). `setYears` only computes the due date at user interaction (`:104-113`).
**User impact:** A job created via the PWA and immediately PDF'd has blank inspection date. iOS never has this bug.
**Proposed fix:** Seed on JobProvider mount: if `installation.date_of_inspection` is unset, set to today; if `next_inspection_years` is unset, set to 5; derive `next_inspection_due_date`.
**Touchpoints:** `web/src/app/job/[id]/installation/page.tsx` (useEffect) or `web/src/lib/job-context.tsx` (prop post-fetch normalisation).

---

## Tab 3 — SUPPLY (/job/[id]/supply/page.tsx vs SupplyTab.swift)

## Gap #13 — Earthing-TT side-effects not wired on web  [P0]
**Area:** Supply → Earthing arrangement picker.
**iOS behaviour:** On `earthingArrangement` change, iOS auto-sets `meansEarthingElectrode = true` / `meansEarthingDistributor = false` when TT is picked, inverse when non-TT. AND flips `inspectionSchedule.isTTEarthing` on the Inspection tab's schedule state (`SupplyTab.swift:32-48`). This is a downstream inspection-schedule auto-fill that drives which rows get marked N/A.
**PWA behaviour:** Earthing picker is a plain `<SelectChips>` — no side-effect wiring (`supply/page.tsx:65-71`). Means-of-earthing segmented control is manually managed separately (`:138-163`).
**User impact:** Selecting TT on web leaves Means of Earthing in whatever state the user last manually set, and DOES NOT mark the Inspection TT flag. Downstream `is_tt_earthing` on Inspection is never auto-flipped → Section 3 items won't get pre-N/A'd on a TT system → inspector has to click each one manually.
**Proposed fix:** In `patch`, detect `earthing_arrangement` changes and co-patch `means_earthing_distributor`, `means_earthing_electrode`, AND the Inspection tab's `is_tt_earthing` (already a known field — Phase 1 Gap #6).
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx`, `web/src/app/job/[id]/inspection/page.tsx`.

## Gap #14 — Main-switch BS EN / Voltage / Current are free-text on web, iOS is picker+"Other"-custom  [P0]
**Area:** Supply → Main switch section.
**iOS behaviour:** Three pickers with "Other"-reveals-custom-text-field flow — `SupplyTab.swift:113-182`. Options come from `Constants.mainSwitchBsEn`, `mainSwitchVoltageRatings`, `mainSwitchCurrents`. iOS also renders a `Poles` picker and `Fuse/Setting (A)` picker and `Conductor Material` picker + `CSA` picker — all enum-driven.
**PWA behaviour:** Six `<FloatingLabelInput>` free-text fields — `supply/page.tsx:187-220`. Conductor material + conductor CSA missing entirely.
**Evidence:** `supply/page.tsx:186-221` shows only: BS EN, Poles, Voltage, Current, Fuse setting, Location — all free-text.
**User impact:** Inspectors type arbitrary strings ("63A" vs "63" vs "63 A") → search / analytics breaks, PDF layout breaks if the field expects a numeric value. Worse: no Conductor material / CSA, so tails cannot be documented.
**Proposed fix:** Replace six inputs with enum pickers matching `Constants.mainSwitchBsEn / mainSwitchVoltageRatings / mainSwitchCurrents / numberOfPoles / mainSwitchFuseSettings / conductorMaterials / mainConductorCsa`. Add Conductor material + CSA.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx:187-222`, `web/src/lib/constants.ts` (add mirrors).

## Gap #15 — RCD section missing QuickSet N/A + LIM buttons and ms unit hints  [P1]
**Area:** Supply → RCD design vs tested rows.
**iOS behaviour:** Each of the three RCD rows (In, time-delay, operating-time) has two inline QuickSet buttons — N/A and LIM — that set the value to those literals (`SupplyTab.swift:219-254`). Plus test-result sub-fields separately. Fields show "ms" unit chip.
**PWA behaviour:** Six plain text inputs — `supply/page.tsx:226-262`. No quick-set, no units displayed.
**User impact:** Inspector has to type "N/A" / "LIM" by hand for every row that doesn't apply (>50% of domestic RCDs are type AC → time-delay / operating-time are LIM).
**Proposed fix:** Add N/A and LIM chips next to each RCD row; add a unit suffix chip.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx:225-263`.

## Gap #16 — Earthing-conductor continuity + main-bonding continuity are free-text on web, iOS is PASS/FAIL/LIM button group  [P0]
**Area:** Supply → Earthing conductor + Main protective bonding.
**iOS behaviour:** Three-button group PASS / FAIL / LIM with colour tint per selection (`SupplyTab.swift:277-332`, driven by `Constants.continuityResults`).
**PWA behaviour:** Free-text input labelled "Continuity (Ω)" — completely different field type and semantics (`supply/page.tsx:279-283, 301-305`). iOS stores a PASS/FAIL/LIM string, PWA expects a numeric ohm value.
**User impact:** Data round-trips with the PWA writing "0.07" or similar into a field iOS decodes as a PASS/FAIL/LIM literal → iOS will display "0.07" as an unknown status chip.
**Proposed fix:** Replace with SegmentedControl PASS/FAIL/LIM.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx:265-306`.

## Gap #17 — Means-of-earthing control shape mismatch  [P1]
**Area:** Supply → Means of earthing.
**iOS behaviour:** Two independent Toggles (`SupplyTab.swift:87-91`), so a user could theoretically set both (for a combined distributor-and-electrode installation, which happens on TN-C-S with a backup electrode).
**PWA behaviour:** Single SegmentedControl that flips both bits in lockstep (either / or) — `supply/page.tsx:138-163`.
**User impact:** Installations that are both distributor-supplied AND have an additional local electrode (common retrofit) can't be represented on the PWA.
**Proposed fix:** Two independent switches matching iOS.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx:138-163`.

## Gap #18 — Bonding PASS/FAIL/LIM fields + auto-propagation logic missing  [P0]
**Area:** Supply → Bonding of extraneous parts.
**iOS behaviour:** Water / Gas / Oil / Structural Steel / Lightning are PASS/FAIL/LIM pickers (`BondingResultPicker`) — `SupplyTab.swift:342-368`. Plus an `autoContinuityIfBonded()` side-effect: if any bond is PASS, set `mainBondingContinuity` to PASS (unless already FAIL) — `SupplyTab.swift:556-565`. Plus an explicit N/A toggle on "Other".
**PWA behaviour:** All five bonds are free-text inputs (`supply/page.tsx:311-353`). No auto-propagation.
**User impact:** Same data-shape mismatch as #16 — PASS/FAIL/LIM literals travel as free-text on web. `main_bonding_continuity` never auto-fills → Supply tab's test-result section looks incomplete.
**Proposed fix:** Replace with PASS/FAIL/LIM pickers; wire auto-propagation to `main_bonding_continuity`.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx:309-354`.

## Gap #19 — SPD defaults-to-N/A + RCD defaults-to-N/A + Main-bonding defaults-to-N/A auto-fills missing  [P1]
**Area:** Supply → applyDefaultsIfNeeded.
**iOS behaviour:** On tab-appear, iOS auto-fills 12 fields to "N/A" if nil — `SupplyTab.swift:488-512`. SPD (4), RCD design+test (6), Main-bonding (3). This is why the typical EICR PDF shows "N/A" in those rows for domestic cases.
**PWA behaviour:** No on-mount seeding (`supply/page.tsx:42-58`). Field values default to empty string.
**User impact:** A fresh PWA-created cert lands at the PDF generator with empty SPD / RCD / bonding rows instead of "N/A"; PDF layout may break (columns expecting a value) or render misleading blanks.
**Proposed fix:** Add `applyDefaultsIfNeeded` on mount mirroring iOS.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx`.

## Gap #20 — Ze-auto-wiring of polarity + earthing continuity missing  [P1]
**Area:** Supply → Test results → Ze field.
**iOS behaviour:** On Ze entry, iOS auto-sets `supplyPolarityConfirmed = true` and `earthingConductorContinuity = "PASS"` if they were unset (`SupplyTab.swift:378-392`). Rationale: measuring Ze proves both polarity and earth continuity, so auto-tick them.
**PWA behaviour:** No side-effect (`supply/page.tsx:109-114`).
**User impact:** Inspector has to manually tick Polarity and Earthing Continuity after entering Ze. Two extra taps per cert.
**Proposed fix:** Wire `earth_loop_impedance_ze` onChange to patch `supply_polarity_confirmed: true` and `earthing_conductor_continuity: 'PASS'` if unset.
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx`.

## Gap #21 — Supply section "Test Results" block does NOT exist on web  [P1]
**Area:** Supply → section order.
**iOS behaviour:** Eight sections in order: Supply Details · Means of Earthing · Main Switch · RCD · Earthing Conductor · Main Bonding · Bonding of Extraneous · **Test Results (Prospective Fault Current + Ze + Supply Polarity Confirmed)** · SPD. (`SupplyTab.swift:22-427`).
**PWA behaviour:** The Test Results section is absent. Ze + PFC are squashed into the top "Supply details" card (`supply/page.tsx:103-135`); `supply_polarity_confirmed` is also in "Supply details". No dedicated card.
**User impact:** Section ordering mismatches iOS so a trained inspector's scrolling muscle memory breaks. Test values are mingled with supply-config values — cognitively different categories.
**Proposed fix:** Restore an explicit "Test Results" card for Ze, PFC, polarity, and move them out of "Supply details".
**Touchpoints:** `web/src/app/job/[id]/supply/page.tsx`.

---

## Tab 4 — BOARD (/job/[id]/board/page.tsx vs BoardTab.swift)

## Gap #22 — "Fed from" parent-board picker missing on web; free-text only  [P0]
**Area:** Board → supplied from / parent relationship.
**iOS behaviour:** Non-main boards get a **dropdown of all other boards** (`fedFromPicker` in `BoardTab.swift:320-342`) which sets `parentBoardId` and auto-populates `suppliedFrom` display text from the parent's designation. Also inherits the parent's earthing if unset (`:375-386`).
**PWA behaviour:** Single free-text input "Supplied from" regardless of board type (`board/page.tsx:178-183`). No parent picker, no `parent_board_id` is ever written. Also no auto-inheritance.
**User impact:** Sub-board → parent linkage is unrepresentable on PWA. Multi-board jobs saved on PWA come back to iOS with nil `parentBoardId`, so the "Fed from" dropdown shows empty / "None (Main Supply)" even for DB2/DB3.
**Proposed fix:** When `board_type !== 'main'`, replace Supplied-from input with a `<SelectChips>` of other boards' IDs; on change, patch `parent_board_id` + auto-set `supplied_from` to parent's designation.
**Touchpoints:** `web/src/app/job/[id]/board/page.tsx:172-184`.

## Gap #23 — Board form missing sections: Main switch/Protection/SPD/Overcurrent ordering + required iOS fields  [P1]
**Area:** Board → section set.
**iOS sections (in order, `BoardTab.swift:186-312`):** 1) Board Details, 2) Sub-Main Cable (sub-boards only), 3) Main Switch, 4) Protection (polarity, phases-confirmed, RCD trip time, IPF rating, RCD rating), 5) SPD (type + status), 6) Overcurrent Device (BS EN + voltage + current), 7) Supply at This Board (Ze + Zs@DB + Ipf@DB), 8) Notes.
**PWA sections (in order, `board/page.tsx:141-308`):** 1) Identity, 2) Location, 3) Supply to board, 4) Main switch / protection (merged), 5) Sub-main cable (conditional), 6) Notes.
**Differences:**
- PWA merges iOS Main Switch + Protection + partial SPD into one "Main switch / protection" card.
- PWA has no "Overcurrent Device" section (iOS fields `overcurrent_bs_en`, `overcurrent_voltage`, `overcurrent_current` are not edited).
- PWA includes a `Model` field (`board/page.tsx:158-162`) that iOS does NOT have on `BoardInfo`.
- PWA is missing iOS fields: `phases_confirmed`, `rcd_trip_time`, `spd_status` (only spd_type is on PWA).
**User impact:** Inspector on web cannot record overcurrent-device details, SPD status, or phases-confirmed — these are BS 7671 schedule fields that must appear on the PDF.
**Proposed fix:** Add the three missing sections (Protection, Overcurrent Device) and the `spd_status` field. Remove the invented `model` field (or flag as exception).
**Touchpoints:** `web/src/app/job/[id]/board/page.tsx`.

## Gap #24 — Board toolbar/menu actions missing: Move Left / Move Right / Remove (with circuits-cascade warning)  [P1]
**Area:** Board → board-bar actions.
**iOS:** Secondary toolbar group offers Add Board, Move Left, Move Right, Remove Board (with confirmation dialog "This will also remove all circuits and observations on this board.") — `BoardTab.swift:20-62`.
**PWA:** Only Add board + Remove (no confirmation dialog, no reorder) — `board/page.tsx:121-138`.
**User impact:** No way to reorder boards on the PWA (iOS order drives PDF page order). Remove has no cascade warning — one tap destroys all circuits on that board silently.
**Proposed fix:** Add reorder buttons + confirmation dialog matching iOS copy.
**Touchpoints:** `web/src/app/job/[id]/board/page.tsx:121-138`.

## Gap #25 — Board type enum values — PWA and iOS use identical raw values but iOS display labels differ  [P2]
**Area:** Board type chip labels.
**iOS:** `BoardType.label` = "Main Board" / "Sub-Distribution" / "Sub-Main" (`BoardInfo.swift:10-15`).
**PWA:** Chip labels "Main board" / "Sub-distribution" / "Sub-main" — sentence-case instead of title-case (`board/page.tsx:35-39`). Raw values align.
**User impact:** Cosmetic.
**Proposed fix:** Match casing.
**Touchpoints:** `web/src/app/job/[id]/board/page.tsx:35-39`.

---

## Tab 5 — CIRCUITS (/job/[id]/circuits/page.tsx vs CircuitsTab.swift)

## Gap #26 — 29-column sticky-schedule table replaced by per-circuit card view  [P1 — but see Exceptions]
**Area:** Circuits → table shape.
**iOS behaviour:** Full horizontally-scrolling table; `circuit_ref` + `circuit_designation` sticky on the left, 28 other fields horizontally scrollable, grouped by `circuitFieldGroups` (Conductors / Disconnection / OCPD / RCD / Ring Final / Continuity / IR / Test Results) — `CircuitsTab.swift:355-358, 688-753` + `Constants.swift:180-224`. Also: group-header row, field-header row, data rows with fixed heights for pixel alignment (`:61-64`).
**PWA behaviour:** Stack of collapsible `CircuitCard` components — one circuit per card, 5 sub-sections (Identity / Cable / OCPD / RCD / Test readings) — `circuits/page.tsx:235-423, 460-711`. No table at all.
**User impact:** Scanning 20 circuits for anomalies is O(N) card-opens on PWA vs a single wide glance on iOS. Inspectors reviewing before sign-off use the table layout for cross-circuit comparison (e.g. checking Zs consistency).
**Proposed fix:** See Exceptions — this is a deliberate PWA ergonomic trade-off acknowledged in the page doc-comment (`:30-47`). Keep as-is pending user sign-off; otherwise add an optional table view behind a viewport-width breakpoint.

## Gap #27 — PWA Circuit card is missing 6 iOS fields  [P0]
**Area:** Circuits → per-circuit editable fields.
**iOS fields (30 per `Constants.circuitFieldOrder:180-211`):** circuit_ref, circuit_designation, wiring_type, ref_method, number_of_points, live_csa_mm2, cpc_csa_mm2, max_disconnect_time_s, ocpd_bs_en, ocpd_type, ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm, rcd_bs_en, rcd_type, rcd_operating_current_ma, rcd_rating_a, ring_r1_ohm, ring_rn_ohm, ring_r2_ohm, r1_r2_ohm, r2_ohm, ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm, polarity_confirmed, measured_zs_ohm, rcd_time_ms, rcd_button_confirmed, afdd_button_confirmed. Plus model-only (no column): is_distribution_circuit, feeds_board_id.
**PWA CircuitCard fields (`circuits/page.tsx:516-706`):** circuit_ref, circuit_designation, number_of_points, max_disconnect_time_s, wiring_type, ref_method, live_csa_mm2, cpc_csa_mm2, ocpd_bs_en, ocpd_type, ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm, rcd_bs_en, rcd_type, rcd_operating_current_ma, rcd_rating_a, ring_r1_ohm, ring_rn_ohm, ring_r2_ohm, r1_r2_ohm, r2_ohm, measured_zs_ohm, ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm, rcd_time_ms, polarity_confirmed. Count: 28.
**Missing on PWA:** `rcd_button_confirmed`, `afdd_button_confirmed`, `is_distribution_circuit`, `feeds_board_id`. (4 fields.) The action rail also lacks CCU-extraction mode sheet for distribution-circuit linking.
**User impact:** Inspector cannot record RCD button test confirmation or AFDD button test confirmation on the PWA — both are ticked on the iOS schedule. PDF rows for those columns will be blank on any PWA-filled cert.
**Proposed fix:** Add two more fields (rcd_button_confirmed, afdd_button_confirmed) to the "Test readings" sub-section, both as yes/no toggles. Distribution-circuit linking is a Phase 8 / multi-board follow-up but the fields exist.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:632-708`.

## Gap #28 — Right-hand action rail has 3 stub buttons that throw an "unavailable" toast  [P0]
**Area:** Circuits → action rail.
**iOS actions (`CircuitsTab.swift:132-263`):** Add, Delete (delete-mode select-all toggle + selected count), Apply Defaults, Reverse, Calculate (menu: Zs = Ze + R1+R2 OR R1+R2 = Zs - Ze, all circuits), CCU Photo, Extract Doc.
**PWA actions (`circuits/page.tsx:379-421`):** Add (works), Delete (stub → "not available"), Apply Defaults (stub), Reverse (works), Calculate (stub), CCU Photo (works), Extract (works).
**Evidence:** `circuits/page.tsx:124-131`:
```
// Non-functional actions that the iOS app carries but the web rebuild
// hasn't wired yet. We keep the buttons visible … but surface an honest
// "not available yet" hint rather than a silent no-op.
```
**User impact:** Three primary row actions do nothing. Delete-All is a daily workflow (clearing out CCU-synthesised circuits to re-scan); Apply Defaults is the one-click cable-size / OCPD pre-fill; Calculate is how Zs gets computed from R1+R2 for every circuit at once.
**Proposed fix:** Wire the three stub buttons.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:130, 388-403`.

## Gap #29 — Board filter in portrait shows all circuits with `null` board_id when a board is selected  [P1]
**Area:** Circuits → board filter.
**iOS behaviour:** Board selector filters circuits where `boardId == selectedBoardId` only — `CircuitsTab.swift:90-107` + `CircuitsViewModel.filteredCircuits` (relied on elsewhere, exact semantics are board-id equality).
**PWA behaviour:** `visible = circuits.filter(c => c.board_id === selectedBoardId || c.board_id == null)` (`circuits/page.tsx:99-101`) — **orphan circuits with null board_id are shown on every selected board**, not just "unassigned".
**User impact:** Inspector sees duplicate orphan rows under every board tab; deleting one copy per board is confusing and error-prone.
**Proposed fix:** Filter only on `c.board_id === selectedBoardId`; render orphans under a distinct "Unassigned" pseudo-board.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:99-101`.

## Gap #30 — RCD_TYPES option set lacks "S" (selective) and `F`  [P2]
**Area:** Circuits → RCD type chips.
**iOS:** Selector options not hard-coded in CircuitsTab but RCD type enum includes `AC / A / B / F / S` per backend CCU analysis contract (`web/src/lib/types.ts:300` — `rcd_type?: 'AC' | 'A' | 'B' | 'F' | 'S'`).
**PWA:** `RCD_TYPES` chip options limited to AC / A / B / F (`circuits/page.tsx:58-63`). No `S`.
**User impact:** Can't set RCD type to "S" on the PWA, even though the backend / CCU path emits it.
**Proposed fix:** Add `{ value: 'S', label: 'S' }` to the chip options.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:58-63`.

## Gap #31 — Circuit-card collapses hide information that iOS shows inline (wiring type summary)  [P2]
**Area:** Circuits → card collapsed state.
**iOS behaviour:** N/A (iOS is a flat table, no collapse).
**PWA behaviour:** Collapsed card shows `wiring_type || 'no cable set'` + rating summary (`circuits/page.tsx:498`). That's fine as a compact digest, but stale copy ("no cable set") implies a cable field rather than a wiring-type/ref-method/CSA triple.
**User impact:** Cosmetic.
**Touchpoints:** `web/src/app/job/[id]/circuits/page.tsx:496-500`.

---

## Exceptions / intentional divergence

1. **Circuits card-view vs 29-col sticky table (Gap #26).** `circuits/page.tsx:30-47` contains an explicit design-choice comment: "each circuit is a collapsible card with its fields grouped by concern … trades side-by-side scanning for much better mobile ergonomics — inspectors overwhelmingly edit one circuit at a time in the field, so we optimise for depth rather than breadth." This is documented intent, matching the "small-screen field use" PWA use case distinct from iOS. No external handoff file was found authorising it (searched `web/PHASE_*_HANDOFF.md`, `web/reviews/*`), so per the durable rule this is still a divergence, but the author flagged it deliberately. Keep as-is pending user sign-off.

## Open questions for the user

1. **Gap #1 (bucket rename):** the surface area of flipping `installation` → `installation_details` etc. is ~40 files + the queue-save-job + backend reader. Should the audit flag this as a single P0 requiring migration design, or split into four P0s (one per bucket)? Keeping as one for now.

2. **Gap #26 (table vs card view):** is the "card view for mobile, table view for desktop" mode the intended end-state, or should the PWA match iOS exactly?

3. **Gap #23 (PWA-invented `model` field):** delete or keep? iOS does not store it on `BoardInfo`, so any data entered there has no home on a round-trip.
