# Phase 1: Job Detail Tab Structure & Cert-Type Gating — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction_

## Summary
Gaps found: 8  (P0: 4  P1: 2  P2: 2)
Exceptions (intentional divergence, documented): 0

## Side-by-side tab matrix

| # | Tab | iOS EICR | iOS EIC | PWA EICR | PWA EIC | Status |
|---|-----|----------|---------|----------|---------|--------|
| 1 | Overview      | Yes (idx 0) | Yes (idx 0) | Yes (slug '')           | Yes (slug '')           | OK |
| 2 | Installation  | Yes (idx 1) | Yes (idx 1) | Yes (/installation)     | Yes (/installation)     | OK |
| 3 | Supply        | Yes (idx 2) | Yes (idx 2) | Yes (/supply)           | Yes (/supply)           | OK |
| 4 | Board         | Yes (idx 3) | Yes (idx 3) | Yes (/board)            | Yes (/board)            | OK |
| 5 | Circuits      | Yes (idx 4) | Yes (idx 4) | Yes (/circuits)         | Yes (/circuits)         | OK |
| 6 | Observations  | **Yes (idx 5, tab)** | No | **Route exists (/observations) but NOT in tab bar** | **Route exists (/observations) but NOT in tab bar** | DIVERGENT |
| 7 | Inspection    | Yes (idx 6) | Yes (idx 5) | Yes (/inspection)       | Yes (/inspection)       | OK |
| 8 | Extent        | **No** | Yes (idx 6) | **Yes (/extent) — shown to EICR** | Yes (/extent)           | DIVERGENT |
| 9 | Design        | **No** | Yes (idx 7) | **Yes (/design) — shown to EICR** | Yes (/design)           | DIVERGENT |
| 10 | Staff        | Yes (idx 7) | Yes (idx 8) | Yes (/staff)            | Yes (/staff)            | OK |
| 11 | PDF          | Yes (idx 8) | Yes (idx 9) | Yes (/pdf)              | Yes (/pdf)              | OK |

Evidence: iOS tab arrays `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:330-357` and content branch `:306-328`. PWA unified list `web/src/components/job/job-tab-nav.tsx:49-60`.

---

## Gap #1 — PWA hides Observations tab behind a FAB on EICR, not as a tab  [P0]
**Area:** Job Detail → Tab bar → EICR tab set
**iOS behaviour:** EICR exposes "Observations" as tab index 5 with an `exclamationmark.triangle` icon; tapping opens the Observations list/edit sheet — `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:345-355` and content `:320`.
**PWA behaviour:** `UNIFIED_TABS` omits `/observations` entirely; the nav reasoning says "Observations is NOT a tab (it lives behind the Obs button in the floating action bar)" — `web/src/components/job/job-tab-nav.tsx:27-33,49-60`. The route exists at `web/src/app/job/[id]/observations/page.tsx` and is reachable only by deep link.
**Evidence:** `web/src/components/job/job-tab-nav.tsx:27-33` — "Observations is NOT a tab (it lives behind the Obs button in the floating action bar)" — AND the actual FAB (`web/src/components/job/floating-action-bar.tsx:34-38`) renders only a `<MicButton>`; there is no Obs button there, so the rationale comment is also stale.
**User impact:** EICR inspectors using the PWA cannot navigate to the Observations list during review. The note in `job-tab-nav.tsx` assumes an Obs button inside the FAB, but that button does not exist — see Gap #2. Result: the Observations page (which exists, renders, and is needed to review/edit Sonnet-created observations) is orphaned from the UI.
**Proposed fix:** Restore Observations as a tab for EICR (matching iOS ordering: between Circuits and Inspection). Keep hidden for EIC.
**Touchpoints:** `web/src/components/job/job-tab-nav.tsx` (reintroduce cert-type-aware tab list or an Observations entry gated on `certificateType !== 'EIC'`); consumers of `<JobTabNav>` already pass no extra prop (`web/src/app/job/[id]/layout.tsx:130`).

## Gap #2 — FAB rationale refers to an Obs button that does not exist  [P0]
**Area:** Job Detail → Floating action bar
**iOS behaviour:** Recording overlay has an Obs button (`onCamera`) that captures an observation photo — `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:291-301` (wiring) and the visible tab at idx 5 on EICR provides the separate observation-list surface.
**PWA behaviour:** `<FloatingActionBar>` renders only a Mic FAB; no Obs button/link, no path to `/observations`, and it hides itself entirely while recording — `web/src/components/job/floating-action-bar.tsx:27-39`.
**Evidence:** `web/src/components/job/floating-action-bar.tsx:34-38`:
```
<div className="pointer-events-auto flex items-center gap-2.5">
  <MicButton onClick={onMicClick} recording={false} />
</div>
```
**User impact:** The documented escape hatch (FAB → Obs) that justified dropping the Observations tab is absent. Combined with Gap #1, the `/observations` route is unreachable from the job chrome on any cert type.
**Proposed fix:** Either (a) add a working Obs button to the FAB that links to `/job/[id]/observations`, or (b) restore the Observations tab (Gap #1). iOS does both: tab idx 5 + a recording-time "Obs" action inside RecordingChrome.
**Touchpoints:** `web/src/components/job/floating-action-bar.tsx` (add button + cert-type guard) AND/OR `web/src/components/job/job-tab-nav.tsx`.

## Gap #3 — PWA shows Extent tab to EICR jobs; iOS hides it  [P0]
**Area:** Job Detail → Tab bar → EICR
**iOS behaviour:** Extent tab appears ONLY when `isEIC == true` — `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:313,315` (`if isEIC { … ExtentTab(...).tag(6) }`) and tab list `:338-343` (EIC) vs `:344-355` (EICR, no Extent entry).
**PWA behaviour:** `/extent` is present in `UNIFIED_TABS` regardless of cert type — `web/src/components/job/job-tab-nav.tsx:56`.
**Evidence:** `web/src/components/job/job-tab-nav.tsx:29-30` claims "the backend permits them on EICR too and iOS keeps them visible" — but the iOS code directly contradicts this at `JobDetailView.swift:313,344-355`. The rationale comment is wrong.
**User impact:** EICR inspectors see a tab that serves no EICR-specific purpose (its primary field "Installation Type" is explicitly gated to EIC inside the page — `web/src/app/job/[id]/extent/page.tsx:80-87`), and EICR-only "extent / agreed limitations / agreed with / operational limitations" fields already live on the Installation tab (iOS `InstallationTab.swift:173-189`) causing content duplication confusion.
**Proposed fix:** Gate the `/extent` tab entry on `certificateType === 'EIC'`.
**Touchpoints:** `web/src/components/job/job-tab-nav.tsx` (make the tab list cert-type aware or filter in render; also remove/correct the misleading "iOS keeps them visible" comment).

## Gap #4 — PWA shows Design tab to EICR jobs; iOS hides it  [P0]
**Area:** Job Detail → Tab bar → EICR
**iOS behaviour:** Design tab appears ONLY for EIC — `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:313,316` (`if isEIC { … DesignTab(...).tag(7) }`) and tab list `:340` vs EICR set `:344-355`.
**PWA behaviour:** `/design` is present in `UNIFIED_TABS` regardless of cert type — `web/src/components/job/job-tab-nav.tsx:57`.
**Evidence:** `web/src/components/job/job-tab-nav.tsx:57`:
```
{ slug: '/design', label: 'Design', Icon: DraftingCompass },
```
No cert-type gate; same misleading "unified" rationale as Gap #3.
**User impact:** EICR inspectors see a "Design" tab (BS 7671 departures form) that is only relevant to EIC (new-install certification). Encourages inspectors to fill a field that won't appear on an EICR PDF.
**Proposed fix:** Gate the `/design` tab entry on `certificateType === 'EIC'`.
**Touchpoints:** `web/src/components/job/job-tab-nav.tsx`.

## Gap #5 — Staff tab does NOT render Designer / Constructor pickers on EIC despite page already branching for EIC  [P1]
**Area:** Job Detail → Staff tab → EIC
**iOS behaviour:** EIC Staff tab renders THREE role pickers: "Responsible for Design" (`designerId`), "Responsible for Construction" (`constructorId`), "Inspection & Testing" (`inspectorId`) — `CertMateUnified/Sources/Views/JobDetail/InspectorTab.swift:19-40`.
**PWA behaviour:** `staff/page.tsx` is coded to render those three EIC pickers (`web/src/app/job/[id]/staff/page.tsx:105-131`), BUT the `inspectors` roster is populated from `data.inspectors` which is never loaded from `/api/inspectors` — the code fallback (`:72`) just reads `job.inspectors ?? []`. The empty-state copy acknowledges the gap: "No staff profiles configured yet. Add inspectors under Settings → Inspectors (Phase 6)" (`:188-192`).
**Evidence:** `web/src/app/job/[id]/staff/page.tsx:71-72`:
```
const data = job as unknown as StaffJobShape;
const inspectors = data.inspectors ?? [];
```
**User impact:** On EIC, the Design / Construction / Inspection role pickers render but always show the empty hint — no inspector can be selected, so `designer_id` / `constructor_id` never get set, and the downstream PDF will be missing those signatories.
**Proposed fix:** Wire the Staff page to fetch the inspector roster (`api.inspectors`) rather than relying on an embedded `job.inspectors` array.
**Touchpoints:** `web/src/app/job/[id]/staff/page.tsx`, `web/src/lib/api-client.ts` (add `inspectors(userId)` if missing), `web/src/lib/types.ts` (Inspector type).

## Gap #6 — Inspection schedule data keys diverge between iOS and PWA  [P1]
**Area:** Job Detail → Inspection tab — auto-fill flags
**iOS behaviour:** Schedule flags live on `InspectionSchedule` as `isTTEarthing`, `hasMicrogeneration`, `markSection7NA` (accessed via `InspectionScheduleViewModel` bindings in `InspectionTab.swift:152-215`).
**PWA behaviour:** `inspection/page.tsx` stores them as `is_tt_earthing`, `has_microgeneration`, `mark_section_7_na` under `job.inspection` — `web/src/app/job/[id]/inspection/page.tsx:47-52,90-117`.
**Evidence:** `web/src/app/job/[id]/inspection/page.tsx:47-52`:
```
type InspectionShape = {
  items?: Record<string, ScheduleOutcome | undefined>;
  is_tt_earthing?: boolean;
  has_microgeneration?: boolean;
  mark_section_7_na?: boolean;
};
```
iOS emits `snake_case` camelCase keys on the Swift side but the backend contract and field names for sync should be verified. The outcomes Map (ref → outcome) shape matches, but this audit cannot verify round-trip without the backend schema.
**User impact:** If the backend stores camelCase-from-iOS and snake_case-from-PWA separately, the auto-fill toggles set by an iOS session won't reflect in a PWA review (and vice versa). Toggle state would desync across platforms.
**Proposed fix:** Confirm the JSON wire key set in the backend `inspection_schedule` column and align the PWA types to the canonical keys. This is not in Phase 1's scope to fix, but documenting here so Phase 2 (data-shape audit) picks it up.
**Touchpoints:** `web/src/app/job/[id]/inspection/page.tsx`, `web/src/lib/types.ts`, backend `src/models/JobModel.js` (not touched by this audit).

## Gap #7 — Stale / wrong tab-nav rationale comments  [P2]
**Area:** Code hygiene — `job-tab-nav.tsx` doc comment
**iOS behaviour:** (No iOS correlate — this is a web-side documentation issue.)
**PWA behaviour:** The leading JSDoc claims "The tab set is unified for EICR + EIC per iOS: Observations is NOT a tab … Extent & Design are always shown — the backend permits them on EICR too and iOS keeps them visible." — `web/src/components/job/job-tab-nav.tsx:27-32`. Both claims are false against the iOS canonical source (see Gaps #1, #3, #4).
**Evidence:** `web/src/components/job/job-tab-nav.tsx:27-33`. A second stale block lives at `:62-68` referencing the removed `certificateType` prop as "dead API surface after the tab set was unified" — this removal is what perpetuates Gaps #3 / #4.
**User impact:** None directly; misleads the next developer into rebuilding the same bug.
**Proposed fix:** Update the doc comments alongside the fixes for Gaps #1/#3/#4 to describe the true cert-type gating.
**Touchpoints:** `web/src/components/job/job-tab-nav.tsx`.

## Gap #8 — `JobTabNav` no longer accepts `certificateType`, so the component can't gate at all without refactor  [P2]
**Area:** Code structure — tab-nav API surface
**iOS behaviour:** (No iOS correlate.)
**PWA behaviour:** `JobTabNav` takes only `{ jobId }` (`web/src/components/job/job-tab-nav.tsx:69`). There's no prop the parent can use to pass cert type, and the component doesn't read `useJobContext()` itself. The parent `layout.tsx:130` renders `<JobTabNav jobId={jobId} />` outside any consumer.
**Evidence:** `web/src/components/job/job-tab-nav.tsx:62-69`:
```
/**
 * The `certificateType` prop was retained through Wave 4 as dead API
 * surface after the tab set was unified for EICR + EIC. …
 */
export function JobTabNav({ jobId }: { jobId: string }) {
```
**User impact:** Any fix for Gaps #1/#3/#4 must either (a) accept a `certificateType` prop from the parent (which is inside `<JobProvider>` at `layout.tsx:126`), or (b) have `JobTabNav` call `useJobContext()` itself. Neither is done today, so the cert-type gate has nowhere to hook in.
**Proposed fix:** Re-add a `certificateType` prop (parent is inside JobProvider already) OR `useJobContext()` inside `JobTabNav` — pick one consistent with the rest of the file. No runtime bug in isolation; flagged so a fix for the P0s doesn't re-strand.
**Touchpoints:** `web/src/components/job/job-tab-nav.tsx`, `web/src/app/job/[id]/layout.tsx`.

---

## Exceptions / intentional divergence
None documented. The prior parity notes (`PHASE_5D_HANDOFF.md`, `PHASE_6_HANDOFF.md`, `PHASE_6C_HANDOFF.md`, `PHASE_7B_HANDOFF.md`, `reviews/WEB_REBUILD_COMPLETION.md`, `reviews/MINI_WAVE_4_5_HANDOFF.md`) were searched for `observations|tab set|unified|cert.type|EIC.*tab|EICR.*tab`; no entry authorises the unified / always-show behaviour that the PWA implements. The only claim of intent is the inline `job-tab-nav.tsx:27-33` comment, which cites a missing memo ("memory/ios_design_parity.md §'Tab set (unified)'") — that file does not exist anywhere in the repo under `EICR_Automation/` or `~/` (verified via `find`). The comment is therefore an undocumented, unverifiable justification and is treated as drift, not exception.

## Open questions for the user — RESOLVED 2026-04-24

User directive (durable, captured in `feedback_ios_is_canon_for_parity.md`): **match iOS exactly; divergence is a bug unless explicitly documented.**

1. **Observations on EICR — RESOLVED: both.** Copy iOS: restore Observations as a tab (between Circuits and Inspection, EICR only) AND add a working Obs action during recording. Gaps #1 + #2 stand as P0 and will be fixed together.
2. **Extent / Design on EICR — RESOLVED: gate to EIC.** Copy iOS. Gaps #3 + #4 stand as P0.
3. **Inspection schedule key casing — RESOLVED: align with iOS (camelCase) pending backend contract check.** Phase 2 will verify the wire format on the backend and decide whether to transform at the boundary or migrate the column. Gap #6 stays open pending that check.
