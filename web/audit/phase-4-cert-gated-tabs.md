# Phase 4: Cert-gated Tab Contents — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction_

**Scope:** Tab CONTENTS for Inspection, Observations, Extent, Design. Tab-bar visibility was locked in Phase 1 (Observations = EICR-only tab; Extent + Design = EIC-only; Staff roster-loading gap carried forward). This audit only looks at what lives INSIDE each of those pages.

**Canon rule (durable, 2026-04-24):** iOS is canonical. Divergence is a bug unless explicitly documented. All claims cite iOS source.

## Summary
Gaps found: 14  (P0: 8  P1: 4  P2: 2)
Exceptions (intentional divergence, documented): 0

## Carried forward from Phase 1 (not restated)
- Gap #1 / #2: Observations tab orphaned on PWA + FAB missing Obs action. (Tab-bar visibility.)
- Gap #3 / #4: Extent + Design tabs shown to EICR in PWA. (Tab-bar visibility.)
- Gap #5: Staff tab designer/constructor roster not loaded on EIC. (Roster plumbing.)
- Gap #6: Inspection auto-fill toggle key casing — this phase supersedes with an exact wire-format analysis (see Gap #11 below).

---

## INSPECTION TAB

### Gap #9 — Outcome enum diverges materially between iOS and PWA  [P0]
**Area:** Inspection tab → per-item outcome chip group
**iOS behaviour:** `InspectionOutcome` has exactly 7 cases: `tick` (ok), `notApplicable` ("N/A"), `c1` ("C1"), `c2` ("C2"), `c3` ("C3"), `limitation` ("LIM"), `notVerified` ("NV") — `CertMateUnified/Sources/Models/InspectionSchedule.swift:3-25`. There is NO "✗" (fail) outcome and NO "FI" outcome on the schedule item — FI exists only as an `ObservationCode` (`Observation.swift:4-8`), it is never written to an inspection item.
**PWA behaviour:** `ScheduleOutcome` is `'✓' | '✗' | 'N/A' | 'LIM' | 'C1' | 'C2' | 'C3' | 'FI' | '—'` — `web/src/lib/constants/inspection-schedule.ts:405`. The displayed chips on a row are `['✓', '✗', 'N/A', 'LIM', 'C1', 'C2', 'C3', 'FI']` (`web/src/lib/constants/inspection-schedule.ts:407`, rendered at `web/src/app/job/[id]/inspection/page.tsx:344`). Two outcomes (`✗`, `FI`) exist ONLY on the PWA and will serialise into `inspection.items[ref]` as values no backend / iOS consumer recognises. The `NV` (Not Verified) outcome — present in iOS and in the backend AI prompt (`src/extract.js:148-149` reads `_outcome_options` from the schema) — is MISSING from the PWA.
**Evidence:** iOS enum `InspectionSchedule.swift:3-11`:
```swift
enum InspectionOutcome: String, Codable, Sendable, CaseIterable {
    case tick
    case notApplicable = "N/A"
    case c1 = "C1"
    case c2 = "C2"
    case c3 = "C3"
    case limitation = "LIM"
    case notVerified = "NV"
}
```
PWA constants `inspection-schedule.ts:405-407`:
```ts
export type ScheduleOutcome = '✓' | '✗' | 'N/A' | 'LIM' | 'C1' | 'C2' | 'C3' | 'FI' | '—';
export const OUTCOME_OPTIONS: ScheduleOutcome[] = ['✓', '✗', 'N/A', 'LIM', 'C1', 'C2', 'C3', 'FI'];
```
iOS stores the raw-value string for `tick` as the literal `"tick"` (default enum rawValue; no explicit override). PWA stores `"✓"`. The PDF renderer (`src/routes/pdf.js:134`) passes `inspection_schedule` through verbatim, so an EICR completed on web will serialise `{"1.1":"✓", ...}` and on iOS `{"1.1":"tick", ...}` — two incompatible wire formats for the same field.
**User impact:** Any EICR edited in both clients will have its schedule outcomes lost/overwritten (the PDF template and any downstream consumers can't read both dialects). On the PWA, inspectors can select `✗` or `FI` for a schedule item — neither is a valid BS 7671 Appendix 6 outcome and the iOS app will throw a JSON-decode error on `InspectionOutcome` when it encounters them (no `defaultDecoder` fallback in the struct at `InspectionSchedule.swift:61-68`).
**Proposed fix:** Drop `✗` and `FI` from the PWA outcome set. Add `NV` (Not Verified). Change the "✓" raw value to "tick" (or migrate iOS to "✓" — but that's a breaking data migration). Simplest path: change `ScheduleOutcome` union values and the `OUTCOME_OPTIONS` array to match iOS exactly, display `tick` as a ✓ glyph in the UI via a value→label map (keep wire value = "tick").
**Touchpoints:** `web/src/lib/constants/inspection-schedule.ts`, `web/src/app/job/[id]/inspection/page.tsx` (outcomeColour + chip map).

### Gap #10 — iOS stores an `InspectionItem` object per ref; PWA stores a bare outcome string  [P0]
**Area:** Inspection tab → data shape
**iOS behaviour:** `InspectionSchedule.items: [String: InspectionItem]` where `InspectionItem { outcome: InspectionOutcome, observationText: String? }` — `InspectionSchedule.swift:37-38` and `:27-35`. Each item is a tagged object with a nullable inline observation-text field.
**PWA behaviour:** `inspection.items: Record<string, ScheduleOutcome>` — `web/src/app/job/[id]/inspection/page.tsx:47-48`. No wrapper object; no place for `observation_text`. Writing is bare: `patch({ items: { ...items, [ref]: outcome } })` at `inspection/page.tsx:85`.
**Evidence:** iOS codable keys (`InspectionSchedule.swift:31-35`):
```swift
enum CodingKeys: String, CodingKey {
    case outcome
    case observationText = "observation_text"
}
```
PWA assignment (`inspection/page.tsx:85`):
```ts
patch({ items: { ...items, [ref]: outcome === items[ref] ? undefined : outcome } });
```
**User impact:** When a PWA-saved job round-trips to iOS the `InspectionItem` decode fails (iOS expects `{outcome: "tick", observation_text: null}` and gets the bare string `"✓"`). iOS's `init(from:)` on `InspectionSchedule.swift:61-68` does a soft-fail (`try?`) and silently replaces `items` with `[:]`, so all 92 EICR rows go blank. This is a silent data-loss bug triggered by opening a web-saved EICR on iPhone.
**Proposed fix:** Change the PWA store shape to match: `items: Record<string, { outcome: ScheduleOutcome, observation_text?: string }>`. Update `setOutcome` to construct the object. Update `ScheduleRow` to read `items[ref]?.outcome`.
**Touchpoints:** `web/src/app/job/[id]/inspection/page.tsx:47-117`, `web/src/lib/constants/inspection-schedule.ts` (add ScheduleItemEntry type).

### Gap #11 — Auto-fill toggle wire keys mis-match iOS  [P0]
**Area:** Inspection tab → schedule-options toggles (TT earthing, microgeneration, Section 7 N/A)
**iOS behaviour:** `InspectionSchedule` JSON keys are `has_microgeneration`, `is_tt_earthing`, `mark_section7_na` — `InspectionSchedule.swift:44-50`. Note the last one has NO underscore between "7" and "na".
**PWA behaviour:** Uses `has_microgeneration` ✓, `is_tt_earthing` ✓, `mark_section_7_na` ✗ (extra underscore) — `web/src/app/job/[id]/inspection/page.tsx:47-52, 99, 106, 116, 133`.
**Evidence:** iOS coding keys (`InspectionSchedule.swift:44-50`):
```swift
enum CodingKeys: String, CodingKey {
    case items
    case linkedObservationIds = "linked_observation_ids"
    case hasMicrogeneration = "has_microgeneration"
    case isTTEarthing = "is_tt_earthing"
    case markSection7NA = "mark_section7_na"   // <-- no underscore between 7 and na
}
```
PWA shape (`inspection/page.tsx:47-52`):
```ts
type InspectionShape = {
  items?: Record<string, ScheduleOutcome | undefined>;
  is_tt_earthing?: boolean;
  has_microgeneration?: boolean;
  mark_section_7_na?: boolean;   // <-- extra underscore
};
```
**User impact:** A web user's Section-7-N/A toggle state never persists to iOS (and vice versa — iOS writes `mark_section7_na` which the web's shape rejects as unknown). The Section 7 bulk-N/A fill still works within a single client, but switching devices drops the toggle state, leaving the 19 Section 7 items in an inconsistent state.
**Proposed fix:** Rename the PWA key to `mark_section7_na` to match iOS. Confirms Phase 1 Gap #6 resolution (align PWA to iOS). Consider migrating any already-saved `mark_section_7_na` values via a one-off read-both-write-canonical shim.
**Touchpoints:** `web/src/app/job/[id]/inspection/page.tsx:51,99,106,116,133`.

### Gap #12 — PWA has no `linked_observation_ids` map → inline-observation workflow absent  [P0]
**Area:** Inspection tab → observation linking
**iOS behaviour:** `InspectionSchedule.linkedObservationIds: [String: UUID]` maps schedule ref → observation id (`InspectionSchedule.swift:39`, wire key `linked_observation_ids`). When the inspector taps C1/C2/C3 on a row and there's no existing linked observation, iOS inlines `InlineObservationForm` directly below the row — `InspectionTab.swift:287-300` + `InlineObservationForm.swift:1-60`. When an observation IS linked, iOS renders the full `ObservationCardView` inline below the row — `InspectionTab.swift:271-283` — so the inspector can review/edit without tab-switching. Changing an item to `tick`/`N/A`/`NV` while an observation is linked triggers a destructive-action alert — `InspectionTab.swift:43-66` + `InspectionScheduleViewModel.swift:91-125`.
**PWA behaviour:** No `linked_observation_ids` field is read or written anywhere in `web/src/` (verified via grep). Tapping C1/C2/C3 on a schedule row does NOTHING beyond recording the outcome — no inline form, no card preview, no prompt — `inspection/page.tsx:84-86`. There is no bridge from Inspection → Observations for the row-linked workflow iOS uses as its primary data-entry pattern.
**Evidence:** `web/src/app/job/[id]/inspection/page.tsx:84-86`:
```ts
const setOutcome = (ref: string, outcome: ScheduleOutcome) => {
  patch({ items: { ...items, [ref]: outcome === items[ref] ? undefined : outcome } });
};
```
vs iOS `InspectionScheduleViewModel.swift:127-147` (applyOutcome → linker → observation expansion).
**User impact:** The entire "tap C2 on 4.8 → get a location + text field → save linked observation" pattern is broken on web. Inspectors must navigate to the (currently orphaned, Phase 1 Gap #1) Observations page and create the observation blind — losing the schedule ref context and the server-side auto-populated `schedule_item`. No destructive-action warning means tapping ✓ on a row with a Sonnet-created linked observation silently orphans the observation (its `scheduleItem` field keeps pointing at a now-ticked row).
**Proposed fix:** (1) Add `linked_observation_ids: Record<string, string>` to `InspectionShape`. (2) Introduce an inline observation form inside `ScheduleRow` when `outcome in {C1, C2, C3}` and no linked id exists. (3) On outcome change to `{tick, N/A, NV}` with a linked id present, show a confirmation dialog before clearing. (4) Render a condensed `ObservationCard` preview inline when a linked id is present.
**Touchpoints:** new component + rewire `web/src/app/job/[id]/inspection/page.tsx`, `web/src/components/observations/observation-sheet.tsx`, `web/src/lib/constants/inspection-schedule.ts` (types).

### Gap #13 — Microgeneration / TT auto-controlled refs not disabled when toggle is undefined  [P1]
**Area:** Inspection tab → row disabled-state
**iOS behaviour:** `InspectionScheduleViewModel.isItemDisabled` — `InspectionScheduleViewModel.swift:43-49` — disables the microgen set (`2.0, 4.11, 4.21, 4.22`) and the TT set (`3.1, 3.2`) UNCONDITIONALLY (any non-EIC job), regardless of toggle state. The display outcome defaults to `.tick` or `.notApplicable` computed from toggle state via `autoOutcome(for:)` — `InspectionScheduleViewModel.swift:53-73`. Default (toggles undefined) treats as `isTT=false`, `hasMicro=false`, so `3.1=tick`, `3.2=N/A`, `2.0=N/A`, `4.11=N/A`, `4.21=N/A`, `4.22=N/A` — and the row is ALWAYS disabled.
**PWA behaviour:** `autoControlled` set only adds `3.1/3.2` when `insp.is_tt_earthing !== undefined`, and `2.0/4.11/4.21/4.22` when `insp.has_microgeneration !== undefined` — `web/src/app/job/[id]/inspection/page.tsx:121-137`. If the inspector never touches the toggles (the common case for a first-time user), those 6 rows are editable — the inspector can set them to C3 or LIM manually, then toggling microgen ON overwrites the manual value.
**Evidence:** PWA `inspection/page.tsx:121-137`:
```ts
const autoControlled = React.useMemo(() => {
  const refs = new Set<string>();
  if (insp.is_tt_earthing !== undefined) { refs.add('3.1'); refs.add('3.2'); }
  if (insp.has_microgeneration !== undefined) { … }
  if (insp.mark_section_7_na) { … }
  return refs;
}, [insp.is_tt_earthing, insp.has_microgeneration, insp.mark_section_7_na]);
```
iOS disables these refs for all non-EIC jobs.
**User impact:** Inspectors can enter outcomes for microgen/TT items that the iOS app treats as auto-controlled. Saved values disappear on iOS reopen (auto-tick overrides). Also inconsistent review of completeness (the "n/m answered" counter credits manual entries that the iOS equivalent marks disabled).
**Proposed fix:** Always disable `3.1, 3.2, 2.0, 4.11, 4.21, 4.22` for EICR regardless of toggle state, mirroring iOS. Default toggle values to `false` at render-time when undefined (matches iOS's `== true` check at `InspectionScheduleViewModel.swift:56-58`).
**Touchpoints:** `web/src/app/job/[id]/inspection/page.tsx:121-137`.

### Gap #14 — Inspection auto-fill "Progress" count uses wrong baseline  [P2]
**Area:** Inspection tab → per-section "n/m" progress indicator
**iOS behaviour:** A section's completion count credits both auto-disabled items AND manually-answered items — `InspectionTab.swift:322-325`:
```swift
let reviewed = items.filter { vm.isItemDisabled($0.ref) || vm.schedule.items[$0.ref] != nil }.count
```
**PWA behaviour:** Credits items with outcome !== undefined OR in autoControlled set — `inspection/page.tsx:205-207`. Because PWA's `autoControlled` is toggle-gated (Gap #13), the Section 2 microgen item and 3.1/3.2 don't count as answered until the inspector touches the toggles. Visually the inspector sees "0/1" on Section 2 until they specifically toggle microgen.
**Evidence:** PWA `inspection/page.tsx:205-207`:
```ts
const answered = sectionItems.filter(
  (i) => items[i.ref] !== undefined || autoControlled.has(i.ref)
).length;
```
**User impact:** Misleading progress display. Downgraded to P2 because (a) it only surfaces when microgen is untouched, and (b) fixing Gap #13 fixes this transitively.
**Proposed fix:** Dependent on Gap #13 — no standalone fix needed.
**Touchpoints:** `web/src/app/job/[id]/inspection/page.tsx:205-207`.

---

## OBSERVATIONS TAB

### Gap #15 — `ObservationRow` shape drops half the iOS `JobObservation` fields  [P0]
**Area:** Observations tab → observation data model
**iOS behaviour:** `JobObservation` has: `id`, `serverId (server_id)`, `code`, `itemLocation (item_location)`, `observationText (observation_text)`, `scheduleItem (schedule_item)`, `scheduleDescription (schedule_description)`, `regulation`, `photos`, `boardId (board_id)` — `CertMateUnified/Sources/Models/Observation.swift:29-59`.
**PWA behaviour:** `ObservationRow` has: `id`, `code`, `description`, `location`, `remedial`, `photos` — `web/src/lib/types.ts:256-270`. Field key divergences:
| iOS wire key | PWA field key | Notes |
|---|---|---|
| `item_location` | `location` | Rename |
| `observation_text` | `description` | Rename |
| `schedule_item` | (missing) | No picker, no storage on PWA row |
| `schedule_description` | (missing) | Ditto |
| `regulation` | (missing) | Ditto |
| `server_id` | (missing) | Multi-turn Sonnet refinement can't patch the right row |
| `board_id` | (missing) | Multi-board EICRs can't attribute observations |
| (none) | `remedial` | PWA-only field, not in iOS — will be dropped on round-trip |
**Evidence:** PWA `types.ts:256-270` vs iOS `Observation.swift:29-59`.
Also `apply-document-extraction.ts:345-356` acknowledges the gap and stashes `schedule_item` + `regulation` on the row as passthrough metadata, but the Observations UI (`observations/page.tsx`, `observation-sheet.tsx`) never reads them back.
**User impact:** iOS-created observations with a `schedule_item` / `regulation` disappear from the web UI (they still serialise but the sheet can't edit them — and Save will wipe them because the cleaned row at `observation-sheet.tsx:149-155` doesn't preserve passthrough keys). Multi-turn Sonnet refinement (`server_id`-based patch path) breaks on web. Web's `remedial` field is non-canonical and gets silently dropped to iOS.
**Proposed fix:** Expand `ObservationRow` to match iOS exactly: rename `description`→`observation_text`, `location`→`item_location`, add `schedule_item`, `schedule_description`, `regulation`, `server_id`, `board_id`. Drop `remedial` (or promote it — but iOS has no such field, so iOS is canon: drop). Update all call sites.
**Touchpoints:** `web/src/lib/types.ts:256-270`, `web/src/components/observations/observation-sheet.tsx`, `web/src/app/job/[id]/observations/page.tsx`, `web/src/lib/recording/apply-document-extraction.ts` (passthrough), Sonnet output parsers.

### Gap #16 — Observation sheet has no Schedule Item picker or Regulation field  [P0]
**Area:** Observations tab → Edit/Add sheet
**iOS behaviour:** Both the Add sheet (`ObservationsTab.swift:220` — "Schedule Item (e.g. 4.4)") and Edit sheet (`EditObservationSheet.swift:88-91`) show a `scheduleItem` text field and a `regulation` text field (Edit only). Values feed `ObservationScheduleLinker` for bidirectional sync with `InspectionSchedule.linkedObservationIds`.
**PWA behaviour:** `observation-sheet.tsx:193-276` renders only: Code chips, Location, Description, Remedial action, Photos. No schedule-ref input, no regulation input.
**Evidence:** iOS Add sheet `ObservationsTab.swift:220`:
```swift
TextField("Schedule Item (e.g. 4.4)", text: $scheduleItem)
```
iOS Edit sheet `EditObservationSheet.swift:88-91`:
```swift
TextField("Schedule Item (e.g. 4.4)", text: $scheduleItem)
    .cmTextFieldStyle()
TextField("Regulation (e.g. 411.3.2)", text: $regulation)
    .cmTextFieldStyle()
```
vs PWA `observation-sheet.tsx:242-275` — fields are only Description + Remedial.
**User impact:** PWA-created observations have no schedule-ref, so the Inspection tab can't show them inline and the PDF can't cross-reference them to Appendix 6 items. BS 7671 regulation citations (core evidence in a C1/C2 classification) can't be captured on web at all.
**Proposed fix:** Add Schedule Item input (text or combobox from `EICR_SCHEDULE` refs) and Regulation input. Wire `schedule_item` into the Observation write (requires Gap #15 first). Consider a combobox instead of free text so the ref auto-links to the Inspection row.
**Touchpoints:** `web/src/components/observations/observation-sheet.tsx`, `web/src/lib/constants/inspection-schedule.ts` (export ref list helper for combobox).

### Gap #17 — Code enum parity OK; labels copy drift  [P2]
**Area:** Observations sheet → code chip labels
**iOS behaviour:** Labels: C1 "Danger present", C2 "Potentially dangerous", C3 "Improvement recommended", FI "Further investigation" — `Observation.swift:10-17`.
**PWA behaviour:** `observation-sheet.tsx:47-53` CODE_OPTIONS: C1 "Danger present" ✓, C2 "Potentially dangerous" ✓, C3 "Improvement recommended" ✓, FI "Further investigation" ✓. Observations list page (`observations/page.tsx:31-36`) uses expanded labels — C1 "Danger present — immediate action required", C2 "Potentially dangerous — urgent remedial action", C3 "Improvement recommended", FI "Further investigation required". These are richer than iOS but deviate from canon.
**Evidence:** `web/src/app/job/[id]/observations/page.tsx:31-36` adds extra copy suffixes absent from iOS.
**User impact:** Minor UX divergence. BS 7671 official wording for FI is "Further investigation required" so the PWA list label is arguably more correct, but inconsistent with the iOS sheet + list. Kept at P2.
**Proposed fix:** Align list + sheet labels with iOS `Observation.swift:10-17` exactly, or consciously flag PWA labels as an intentional copy upgrade.
**Touchpoints:** `web/src/app/job/[id]/observations/page.tsx:31-36`, `web/src/components/observations/observation-sheet.tsx:47-53`.

### Gap #18 — No multi-photo selection on PWA; no "From Job" picker; no camera upload compression  [P1]
**Area:** Observations sheet → photo grid
**iOS behaviour:** `PhotoPickerView.swift:13-17` uses `PhotosPicker(maxSelectionCount: 5, matching: .images)` — select up to 5 at once. `EditObservationSheet.swift:144-156, 215-239` exposes a third "From Job" button (when other job photos are pickable) that opens `JobPhotosPickerSheet` to move photos between the CCU, the unassigned pool, and other observations, with the pending-moves bookkeeping at `EditObservationSheet.swift:289-303`.
**PWA behaviour:** `observation-sheet.tsx:284-327` — two hidden file inputs (Camera `capture="environment"`, Library no capture), each accepts ONE file per click (`type="file"` without `multiple`), uploaded immediately via `api.uploadObservationPhoto`. No "From Job" picker, no CCU/unassigned/cross-observation moves. `photos` array has no documented maximum.
**Evidence:** `observation-sheet.tsx:310-327`:
```tsx
<input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFile} …/>
<input ref={libraryInputRef} type="file" accept="image/*" onChange={handleFile} …/>
```
Single `event.target.files?.[0]` at `:102`.
**User impact:** Selecting 5 defect photos from the library takes 5 round-trips instead of 1 on iOS. No way on web to reclaim a photo misfiled on a different observation or the CCU thumbnail. No unassigned-pool workflow at all (the pool EXISTS on the iOS job object but the PWA doesn't render or write to `unassigned_photos`).
**Proposed fix:** Add `multiple` to the Library input and loop upload. Add a "From Job" button gated on existence of CCU / unassigned / other-obs photos, opening a chooser. Port the iOS pending-moves state machine (source-strip on save, cancel is no-op).
**Touchpoints:** `web/src/components/observations/observation-sheet.tsx`, new `JobPhotosPickerSheet` component, `web/src/lib/api-client.ts` (bulk upload / moveObservationPhoto helpers), `web/src/lib/types.ts` (add `unassigned_photos?: string[]` to `JobDetail`).

### Gap #19 — Add-observation sheet lacks the iOS "server-side add" path; delete uses different dialog  [P1]
**Area:** Observations tab → Add + Delete flows
**iOS behaviour:** Add flow is `viewModel.addObservation(code:location:text:scheduleItem:photoPaths:)` — `ObservationsTab.swift:338-349` — which routes through JobViewModel.save() (which fires the backend sync). Delete uses `contextMenu` long-press → confirmation (`ObservationsTab.swift:35-42`) AND inside EditObservationSheet a trash toolbar item with `.alert("Delete observation?", …)` and explanatory text "This cannot be undone. Any linked schedule item will be reset to OK." — `EditObservationSheet.swift:175-206`.
**PWA behaviour:** Add flow mounts the same `ObservationSheet` via `draftNew` with a fresh UUID; on Save, the parent appends to `job.observations` via `updateJob({observations: [...observations, next]})` — `observations/page.tsx:80-90`. Delete uses a bare `Remove` button on the card with NO confirmation — `observations/page.tsx:268-280` calls `removeAt(obs.id)` directly, which filters without prompting. No iOS-parity delete button inside the edit sheet (only a Cancel/Save footer).
**Evidence:** `web/src/app/job/[id]/observations/page.tsx:92-94`:
```ts
const removeAt = (id: string) => {
  updateJob({ observations: observations.filter((o) => o.id !== id) });
};
```
iOS `EditObservationSheet.swift:198-206`:
```swift
.alert("Delete observation?", isPresented: $showDeleteConfirmation) {
    Button("Delete", role: .destructive) { viewModel.deleteObservation(id: observationId); dismiss() }
    Button("Cancel", role: .cancel) {}
} message: {
    Text("This cannot be undone. Any linked schedule item will be reset to OK.")
}
```
**User impact:** Inspector mistaps "Remove" on a card and loses a C1/C2 finding with no undo and no prompt. Also the inspection-link cascade (resetting `linkedObservationIds[ref]` when deleting a linked observation, `ObservationScheduleLinker.observationDeleted`) never fires on web because (a) the linked-ids map doesn't exist (Gap #12), and (b) the delete path is a plain filter.
**Proposed fix:** Add confirmation dialog before delete (use Radix AlertDialog). Add a destructive Delete button inside the edit sheet toolbar. Implement the linker-cascade once Gap #12 lands.
**Touchpoints:** `web/src/app/job/[id]/observations/page.tsx:92-94, 268-280`, `web/src/components/observations/observation-sheet.tsx` (add delete button).

---

## EXTENT TAB (EIC-only after Phase 1 gating)

### Gap #20 — Installation-type chip picker values match iOS; labels use sentence-case and drop a word  [P2]
**Area:** Extent tab → Installation Type picker
**iOS behaviour:** `Constants.installationTypes` values: `["new_installation", "addition", "alteration", "consumer_unit_upgrade"]` — `Constants.swift:367`. Display names: "New Installation", "Addition", "Alteration", "Consumer Unit Upgrade" — `Constants.swift:370-378`.
**PWA behaviour:** Values match iOS exactly — `web/src/app/job/[id]/extent/page.tsx:29-34`. Labels are "New installation", "Addition", "Alteration", "Consumer unit upgrade" (sentence case on PWA vs Title Case on iOS).
**Evidence:** `web/src/app/job/[id]/extent/page.tsx:29-34`:
```ts
const INSTALLATION_TYPES = [
  { value: 'new_installation', label: 'New installation' },
  { value: 'addition', label: 'Addition' },
  { value: 'alteration', label: 'Alteration' },
  { value: 'consumer_unit_upgrade', label: 'Consumer unit upgrade' },
];
```
iOS `Constants.swift:371-375`: "New Installation", "Consumer Unit Upgrade".
**User impact:** Visual drift only. Selection values survive round-trip.
**Proposed fix:** Update PWA labels to Title Case: "New Installation", "Consumer Unit Upgrade".
**Touchpoints:** `web/src/app/job/[id]/extent/page.tsx:29-34`.

### Gap #21 — Extent tab `extent`/`comments` data path overlaps Installation tab's `extent` field — namespace collision  [P0]
**Area:** Extent tab vs Installation tab data shape
**iOS behaviour:** Two DIFFERENT `extent` keys on iOS:
- EICR only: `InstallationDetails.extent`, `agreedLimitations`, `agreedWith`, `operationalLimitations` rendered on Installation tab — `InstallationTab.swift:173-189` (wrapped in `if !isEIC`).
- EIC only: `ExtentAndType.extent`, `installationType`, `comments` rendered on Extent tab — `ExtentTab.swift:7-10` (`viewModel.job.extentAndType`).
These live at two different paths in the Job model (`job.installation.extent` vs `job.extentAndType.extent`) and never collide.
**PWA behaviour:** Extent tab writes to `job.extent.extent` — `web/src/app/job/[id]/extent/page.tsx:40-47`:
```ts
const data = React.useMemo<ExtentShape>(() => (job.extent ?? {}) as ExtentShape, [job.extent]);
const patch = React.useCallback(
  (next: Partial<ExtentShape>) => { updateJob({ extent: { ...data, ...next } }); },
  [data, updateJob]
);
```
So `job.extent` on web corresponds to iOS's `ExtentAndType` (EIC-only) — but the backend JSON shape and field names on iOS are `extent_and_type: {extent, installation_type, comments}`, NOT a top-level `extent` bag. The web model calls the bag "extent" (singular) and the nested string also "extent" — so `job.extent.extent` is the EIC extent string.
Meanwhile the Installation tab on PWA (`web/src/app/job/[id]/installation/page.tsx` — not in Phase 4 scope but relevant) reads/writes `job.installation.extent` — a DIFFERENT field pointing to the iOS `InstallationDetails.extent` that is EICR-only on iOS.
**Evidence:** iOS `Job.swift` (not read here but implied by `ExtentAndType` CodingKeys) and `ExtentAndType.swift:8-12` which uses top-level keys `extent, comments, installation_type`. The web `job.extent` bag does NOT wire to iOS's `extent_and_type` JSON key.
**User impact:** EIC extent data written on web will not land in iOS's `extentAndType` model (wrong JSON path). If Phase 1's tab gating ships (Extent tab = EIC-only), the current `job.extent` bag becomes orphaned. This is a structural bug that requires a backend or client-side rename.
**Proposed fix:** Confirm the backend wire contract. Likely rename web's `job.extent` bag to `job.extent_and_type` and align the nested key. Verify against `src/routes/jobs.js` + `src/models/JobModel.js`. Likely needs a migration read-shim.
**Touchpoints:** `web/src/app/job/[id]/extent/page.tsx:40-47`, `web/src/lib/types.ts:229` (currently `extent?: Record<string, unknown>`), backend schema (out of scope here — flag for Phase 2/3 data-shape audit).

### Gap #22 — Extent Comments section shown to all cert types in PWA; iOS shows it only on EIC (and it's EIC-only per Phase 1)  [P1]
**Area:** Extent tab → Comments section
**iOS behaviour:** Comments field lives on `ExtentTab.swift:47-61`. The whole tab is EIC-only (`JobDetailView.swift:313,315`), so comments are EIC-only by inclusion.
**PWA behaviour:** `extent/page.tsx:90-98` renders Comments unconditionally (for EIC and — pre-Phase-1-fix — also EICR).
**Evidence:** Extent page has no `isEIC` branch around the Comments SectionCard (`extent/page.tsx:90`).
**User impact:** Once Phase 1 Gap #3 lands (Extent tab hidden on EICR), this issue is moot — comments will only be reachable on EIC. Kept here to track if Phase 1 gating slips.
**Proposed fix:** Dependent on Phase 1 Gap #3. No standalone fix needed.
**Touchpoints:** `web/src/app/job/[id]/extent/page.tsx:90-98`.

---

## DESIGN TAB (EIC-only after Phase 1 gating)

### Gap #23 — Design tab data shape matches iOS; no departure fields divergence  [no gap]
**Not a gap.** iOS `DesignConstruction` has `departuresFromBs7671` (`departures_from_bs7671`) and `departureDetails` (`departure_details`) — `DesignConstruction.swift:3-11`. PWA `DesignShape` has the same two keys verbatim — `web/src/app/job/[id]/design/page.tsx:21-24`. The "No Departures" green shortcut, info banner, label text all match iOS exactly (`DesignTab.swift:38-65`). No action needed.

### Gap #24 — Design tab has NO designer/constructor pickers on web; iOS keeps them on Staff tab  [not-a-gap for Design, tracked at Staff]
**Not a gap on Design tab.** Designer / constructor pickers live on the Staff (`InspectorTab`) tab on iOS, not on Design. Phase 1 Gap #5 tracks the Staff roster-loading bug. Nothing new for Phase 4.

---

## Cross-cutting shape summary

| Concept | iOS wire key | PWA key | Status |
|---|---|---|---|
| Inspection items map | `inspection_schedule.items` (String→InspectionItem) | `inspection.items` (String→string) | Key + value shape diverge (Gap #10) |
| TT toggle | `inspection_schedule.is_tt_earthing` | `inspection.is_tt_earthing` | OK |
| Microgen toggle | `inspection_schedule.has_microgeneration` | `inspection.has_microgeneration` | OK |
| Section 7 N/A toggle | `inspection_schedule.mark_section7_na` | `inspection.mark_section_7_na` | DIVERGE (Gap #11) |
| Linked observation ids | `inspection_schedule.linked_observation_ids` | (missing) | DIVERGE (Gap #12) |
| Observation schedule ref | `observations[].schedule_item` | (missing — passthrough only) | DIVERGE (Gap #16) |
| Observation regulation | `observations[].regulation` | (missing) | DIVERGE (Gap #16) |
| Observation location | `observations[].item_location` | `observations[].location` | Key rename (Gap #15) |
| Observation body | `observations[].observation_text` | `observations[].description` | Key rename (Gap #15) |
| EIC extent | `extent_and_type.{extent,installation_type,comments}` | `extent.{extent,installation_type,comments}` | Wrong JSON bag name (Gap #21) |
| Design departures | `design_construction.departures_from_bs7671` | `design.departures_from_bs7671` | ? (bag-name parity not verified; flag for Phase 2) |

Inspection item refs (schedule count): iOS EICR = 92 items / 7 sections (`Constants.swift:232-346`). PWA EICR = 92 items / 7 sections (`inspection-schedule.ts:15-385`). Counts match. Wording has minor punctuation drift (em-dash vs newline-bullets in refs 1.1 and 4.13; "Non-sheathed" vs "Non sheathed" in 5.4) — treated as cosmetic, not a separate gap.

EIC schedule: iOS = 14 flat items (`Constants.swift:349-364`). PWA = 14 flat items (`inspection-schedule.ts:387-402`). Refs match exactly. OK.

---

## Exceptions / intentional divergence
None documented. No handoff (`web/PHASE_*_HANDOFF.md`, `web/reviews/*`) cites any of the above as intentional — they are all drift.

## Open questions for the user
None — user directive 2026-04-24 is "match iOS exactly, divergence is a bug." All 14 gaps stand as bugs pending fix in later phases. Ordering for remediation (most structural first):
1. Gap #10 (items shape), Gap #15 (observation shape), Gap #21 (extent bag) — data-shape blockers preventing any EICR round-trip
2. Gap #9 (outcome enum) — wire-value divergence
3. Gap #11 (Section 7 toggle key) — silent toggle-state loss
4. Gap #12 (linked_observation_ids + inline form) — primary data-entry pattern absent
5. Gap #16 (schedule-item + regulation fields), Gap #18 (multi-photo + From-Job), Gap #19 (delete confirmation)
6. Gap #13, #14, #17, #20, #22 — UX polish

---

## Methodology log
- iOS canonical files read in full: `InspectionTab.swift` (376L), `ObservationsTab.swift` (351L), `ExtentTab.swift` (146L), `DesignTab.swift` (139L), `EditObservationSheet.swift` (343L), `InspectionScheduleViewModel.swift` (1-170 of 215L), `Observation.swift` (94L), `InspectionSchedule.swift` (69L), `ExtentAndType.swift` (12L), `DesignConstruction.swift` (11L), `ScheduleItemsReference.swift` (27L), `Constants.swift` (schedule region 232-392).
- PWA files read in full: `inspection/page.tsx` (389L), `observations/page.tsx` (321L), `extent/page.tsx` (101L), `design/page.tsx` (117L), `observation-sheet.tsx` (402L), `observation-photo.tsx` (110L), `inspection-schedule.ts` (408L).
- Cross-references checked: `web/src/lib/types.ts` (220-270), `web/src/lib/recording/apply-document-extraction.ts` (286-355 for passthrough metadata confirmation), `src/routes/jobs.js` (inspection_schedule round-trip confirmation), `src/extract.js` (`_outcome_options` schema hint confirmation).
- No schedule-item counts mismatch; the 92/92/14 counts all reconcile. Only the SHAPE of each item and the enum diverge.
- Backend wire format for `mark_section7_na` vs `mark_section_7_na` verified by reading iOS CodingKeys directly — iOS canon is the shorter form (no underscore between 7 and na).
