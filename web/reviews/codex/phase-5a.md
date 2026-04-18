## 1. Summary of the phase
Phase 5a replaces the stub CCU rail action with a real camera-first file picker on the Circuits tab, posts the image to `/api/analyze-ccu`, and merges the returned board/circuit data into the current job. It also adds a dedicated CCU merge helper, CCU response types, inline status/error UI, and dismissible follow-up questions for unresolved RCD types.

The current working tree has moved on since `35b5310` by adding document-extraction flow and broader API/types changes, but the core CCU helper and its merge semantics are still materially the same, so the findings below still apply.

## 2. Alignment with original plan
Broadly, yes: the commit does wire the CCU button to a real upload flow, adds `api.analyzeCCU`, ports the iOS-style circuit merge/data-loss guard, persists raw analysis, and surfaces inspector questions.

Two gaps versus the stated intent:
- The handoff says the response includes main-switch metadata, but only `main_switch_bs_en`, voltage, and current are consumed; `main_switch_type`, `main_switch_poles`, and `main_switch_position` are typed but dropped ([types.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:268), [apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:122)).
- The handoff says RCD normalisation mirrors iOS for `AC/A/B/F/S/A-S/B-S/B+`, but the Circuits UI only offers `AC/A/B/F`, so several “valid” imported values cannot be represented in the editor ([apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:35), [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:57)).

## 3. Correctness issues
- **P0** Async stale-state merge can drop user edits made while analysis is running. `handleCcuFile` awaits the upload, then computes `applyCcuAnalysisToJob(job, analysis, ...)` from the render-time `job` snapshot and finally calls `updateJob(patch)`; `updateJob` is only a shallow top-level merge. Any edits to `board`, `supply`, or `circuits` made during the request window can be overwritten by stale whole-section bags ([page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:130), [job-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:55), [apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:88)).
- **P1** `ccu_analysis` is overwritten globally, so analysing a second board destroys the first board’s raw analysis, which breaks the commit’s “review/retry without re-uploading” goal for multi-board jobs ([apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:357)).
- **P2** `analysis.board_model` is written into `board.name`, but the board UI has a separate `model` field. Result: imported board model lands in the wrong slot and the actual Model input stays empty ([apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:119), [board/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/board/page.tsx:148)).
- **P2** Valid imported RCD types can become invisible/uneditable in the Circuits UI. The merge helper accepts `S`, `A-S`, `B-S`, and `B+`, but the chip options only include `AC/A/B/F` ([apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:35), [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:601)).
- **P2** The phase types `main_switch_type`, `main_switch_poles`, and `main_switch_position`, but the merge helper ignores them completely, so part of the analyser output is silently discarded ([types.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:270), [apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:122)).

## 4. Security issues
- No phase-specific security defects stood out in this diff. The upload goes through the existing authenticated `request()` wrapper with bearer auth plus `credentials: 'include'` ([api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:34)).

## 5. Performance issues
- No major phase-specific performance problem found. The merge is linear over circuits and the UI work is modest.
- Minor: `buildBoardPatch()` always returns a fresh `board` object even when nothing changed, which causes unnecessary dirty-state churn and rerenders ([apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:153)).

## 6. Accessibility issues
- **Low** Every dismiss button has the same accessible name, `Dismiss question`, so screen-reader users cannot tell which prompt they are dismissing. Include the question text or circuit ref in the label ([page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:335)).

## 7. Code quality
- The merge helper has good inline documentation and the data-loss guard is clearly implemented.
- There is some schema drift: the helper/commentary assumes one set of board/RCD semantics while the current UI exposes another (`name` vs `model`, full iOS RCD list vs truncated chip list).
- `ccu_analysis` is stored as an unstructured `Record<string, unknown>` cast, which weakens type guarantees right where long-lived persisted analysis data is being saved ([apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:359)).

## 8. Test coverage gaps
- I did not find automated unit/integration tests for `applyCcuAnalysisToJob`, `handleCcuFile`, or the CCU rail flow. `web/package.json` has lint/typecheck and a visual verification script, but no test runner/specs for this logic.
- Missing cases:
  - user edits while CCU upload is in flight
  - multi-board jobs with two CCU analyses
  - unmatched existing circuits with and without readings
  - valid imported RCD types outside `AC/A/B/F`
  - board-model field mapping

## 9. Suggested fixes
1. [web/src/app/job/[id]/circuits/page.tsx:130](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:130), [web/src/lib/job-context.tsx:55](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:55): rebase the CCU patch against the latest job state, not the render snapshot. Either add a functional `updateJob(prev => next)` path or hold `jobRef.current` and compute `applyCcuAnalysisToJob(jobRef.current, analysis, ...)` at resolve time. This closes the data-loss bug for in-flight edits.
2. [web/src/lib/recording/apply-ccu-analysis.ts:357](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:357): store raw analysis per board, e.g. `ccu_analysis: { ...(job.ccu_analysis ?? {}), [boardId]: analysis }`, or append a timestamped history. This preserves review/retry data across multiple boards.
3. [web/src/lib/recording/apply-ccu-analysis.ts:119](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:119), [web/src/app/job/[id]/board/page.tsx:159](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/board/page.tsx:159): map `analysis.board_model` into `board.model` instead of `board.name`, or populate both if legacy consumers still read `name`. This aligns the merge with the actual editor schema.
4. [web/src/app/job/[id]/circuits/page.tsx:57](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:57): extend `RCD_TYPES` to include `S`, `A-S`, `B-S`, and `B+`, or narrow `VALID_RCD_TYPES` to what the UI can truly render. Right now imported values can silently disappear from the selector state.
5. [web/src/lib/recording/apply-ccu-analysis.ts:122](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:122): either merge `main_switch_type` / `main_switch_poles` / `main_switch_position` into board fields the app understands, or remove them from the typed contract until they are actually supported. Silent drop is easy to miss and hard to debug.
6. [web/src/app/job/[id]/circuits/page.tsx:335](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:335): change the dismiss button label to something like `Dismiss question: What is the RCD type for circuit 4?` for screen-reader clarity.
7. [web/src/lib/recording/apply-ccu-analysis.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-ccu-analysis.ts:1): add unit tests around merge semantics, especially stale-state rebasing, unmatched-circuit preservation, multi-board storage, and RCD type handling.

## 10. Overall verdict
**Needs rework.**

Top 3 priority fixes:
1. Fix the stale async merge that can overwrite user edits during CCU analysis.
2. Stop overwriting `ccu_analysis` globally; preserve raw analysis per board/history.
3. Align imported field semantics with the UI schema, especially `board_model` and the full supported RCD type set.