## 1. Summary of the phase
Phase 3a replaced the `TabStub` placeholders with real client-side forms for the Installation, Supply, and Board tabs, using the new `SectionCard`, `FloatingLabelInput`, `SelectChips`, `SegmentedControl`, and `NumericStepper` primitives. It also introduced the first multi-board UI on the web side and conditional EIC/EICR sections intended to match the iOS flow.

The three reviewed page files are unchanged in the current working tree since `25580d8`, so the file/line references below still match the commit.

## 2. Alignment with original plan
Mostly aligned on surface area: the tabs, sections, conditional EIC/EICR rendering, hero banners, and multi-board controls described in the handoff are present.

Two important gaps remain:
- The “Staff hint card — links to `/staff`” objective was not met. The card is only decorative text in [installation/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/installation/page.tsx:352); there is no actual navigation affordance.
- The implementation does not align with the backend job contract. The new pages read/write `job.installation`, `job.supply`, and `job.board`, but the API still serves `installation_details`, `supply_characteristics`, `board_info`, and top-level `boards` from [src/routes/jobs.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:575). That means the phase matches the handoff intent visually, but not the data model actually returned by the backend.

## 3. Correctness issues
- **P1** Existing job data will not hydrate into these tabs because the pages read the wrong root keys. Installation reads `job.installation` in [installation/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/installation/page.tsx:88), Supply reads `job.supply` in [supply/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/supply/page.tsx:44), and Board reads `job.board` in [board/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/board/page.tsx:63). The backend response still returns `installation_details`, `supply_characteristics`, `board_info`, and top-level `boards` in [src/routes/jobs.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:575). On real fetched jobs, these forms will start blank even when data exists.
- **P1** The Board tab ignores persisted board data and synthesizes a new `DB1` instead. [board/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/board/page.tsx:64) only looks for `job.board.boards`; the API provides `boards` at the top level and `board_info` separately. Result: existing boards are invisible, and the UI can present a fake empty board over real data.
- **P2** “Next inspection due” is derived inconsistently. In [installation/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/installation/page.tsx:98), the due date is recomputed only when the year stepper changes. Editing the inspection date later does not recompute it, and clearing the year only clears `next_inspection_years`, leaving a stale `next_inspection_due_date` behind.
- **P2** The means-of-earthing toggle is stored as two booleans (`means_earthing_distributor` and `means_earthing_electrode`) in [supply/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/supply/page.tsx:144). Those keys have no other consumer in the repo, so this is currently a UI-only encoding of a single state and is likely to drift from extraction/PDF/save logic.

## 4. Security issues
No concrete security defects stood out in this phase’s diff. I did not see new XSS, auth, CSRF, secret-handling, or PII-exposure issues in these three pages.

## 5. Performance issues
- The job context updates the whole `job` object on every keystroke in [job-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:55), so each input change rerenders the entire active page and all controlled fields. That is acceptable for now, but these tabs are already large enough that typing latency is a realistic future risk on lower-end devices.
- `SelectChips` renders each option twice, once in the dropdown list and again in the chip row, in [select-chips.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/ui/select-chips.tsx:85) and [select-chips.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/ui/select-chips.tsx:127). This is not severe, but it adds DOM weight across many repeated controls.

## 6. Accessibility issues
- `SegmentedControl` uses `role="radiogroup"`/`role="radio"` in [segmented-control.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/ui/segmented-control.tsx:47) but does not implement arrow-key navigation or roving tabindex. It works as a row of buttons, not as an accessible radio group.
- `SelectChips` claims keyboard navigation in its docblock, but there are no key handlers in [select-chips.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/ui/select-chips.tsx:7). The listbox semantics are incomplete.
- The board selector pills have no selected-state semantics in [board/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/board/page.tsx:102). Screen readers get plain buttons, not “selected board” state.
- The board notes `<textarea>` in [board/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/board/page.tsx:301) has no associated label, only a section heading and placeholder.

## 7. Code quality
- The frontend contract is drifting because page-local shapes are duplicated instead of being normalized centrally. The pages depend on `installation`/`supply`/`board`, while the backend and extraction types still speak `installation_details`/`supply_characteristics`/`board_info`/`boards`; see [types.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:192) and [types.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:350).
- The staff hint copy is misleading. [installation/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/installation/page.tsx:356) says assignment “lives on the Staff tab,” but the card is non-interactive.
- The custom `MultilineField` in [installation/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/installation/page.tsx:370) and the inline board notes textarea duplicate form-field behavior outside the shared primitives, which increases drift risk.

## 8. Test coverage gaps
I could not find frontend test/spec files under `web/` covering these tabs or the shared form primitives.

High-value missing tests:
- Hydration tests proving fetched API payloads populate Installation/Supply/Board fields from the real backend shape.
- Board tests for existing `boards` data, add/remove behavior, and active-board switching.
- Installation tests for due-date recomputation when either date or interval changes, and for clearing the interval.
- Accessibility tests for segmented controls, listbox/select behavior, and textarea labelling.

## 9. Suggested fixes
1. `web/src/app/job/[id]/installation/page.tsx:88`, `web/src/app/job/[id]/supply/page.tsx:44`, `web/src/app/job/[id]/board/page.tsx:63`, `web/src/lib/types.ts:192`  
   Normalize the job payload at the API boundary or in `JobProvider` so the UI reads a single canonical shape. Either map backend fields into `installation`/`supply`/`board` on fetch, or update these pages to read `installation_details`/`supply_characteristics`/`board_info` plus top-level `boards`. This is the highest-priority correctness fix because current fetched jobs will not populate these forms.

2. `web/src/app/job/[id]/board/page.tsx:64`, `src/routes/jobs.js:584`  
   Rework Board hydration to consume existing top-level `boards` and `board_info` instead of synthesizing `[newBoard()]` whenever `job.board.boards` is missing. Otherwise the tab hides real persisted board data and invents an empty board.

3. `web/src/app/job/[id]/installation/page.tsx:98`  
   Make `next_inspection_due_date` a deterministic derivation from `date_of_inspection` and `next_inspection_years`, recomputing when either changes and clearing when the interval is cleared. This removes stale derived state and avoids invalid due dates surviving edits.

4. `web/src/app/job/[id]/installation/page.tsx:352`  
   Turn the Staff hint card into an actual link or button that navigates to `/job/[id]/staff`. The handoff explicitly called for a link; the current implementation is only decorative copy.

5. `web/src/components/ui/segmented-control.tsx:47`  
   Add roving tabindex and arrow-key handling consistent with radio-group semantics, or drop the radio roles and present it as a button group with accurate semantics. Right now the ARIA contract is incomplete.

6. `web/src/components/ui/select-chips.tsx:7`  
   Either implement the documented keyboard behavior or remove the misleading comment and simplify the ARIA. At minimum, add keyboard open/close and option navigation if this remains a custom listbox.

7. `web/src/app/job/[id]/board/page.tsx:301`  
   Add a programmatic label for the notes textarea, ideally reusing a shared textarea primitive. Placeholder text is not a label.

8. `web/src/app/job/[id]/supply/page.tsx:144`  
   Replace the two-boolean means-of-earthing representation with one canonical field, or explicitly map it into the backend/extraction model. A single choice encoded as two booleans is fragile and currently repo-local.

## 10. Overall verdict
**Needs rework.**

The UI surface is strong and broadly matches the phase handoff, but the main data-model integration is wrong: these tabs read a frontend-only shape while the backend still returns different keys, and the Board tab in particular can hide real persisted data behind a synthesized empty board.

Top 3 priority fixes:
1. Fix the frontend/backend job-shape mismatch for Installation, Supply, and Board data.
2. Fix Board hydration so existing `boards`/`board_info` are shown instead of synthesized `DB1`.
3. Fix `next_inspection_due_date` derivation and add tests around date/interval changes.