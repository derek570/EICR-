## 1. Summary of the phase

Phase 5b wires the Circuits-tab `Extract` rail button to `/api/analyze-document`, adds client types/API plumbing, and introduces a merge helper that folds extracted installation, supply, board, circuit, and observation data into the current `JobDetail`. The merge policy is intentionally “fill empty only”, with circuit matching by `circuit_ref` and observation dedupe based on iOS-style keys.

I reviewed commit `766735f` plus the current working tree. For this phase’s core path, [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:79) and [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:1) are unchanged since the commit; [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:1), [apply-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-extraction.ts:1), [types.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:1), and `CLAUDE.md` have evolved later for Phases 6/7.

## 2. Alignment with original plan

The implementation broadly matches the handoff doc and commit intent:

- `Extract` is now wired on the Circuits rail, opens a library-first image picker, posts multipart to `/api/analyze-document`, and merges non-destructively.
- The merge helper applies the fill-empty-only rule across installation, supply, board, circuits, and observations.
- Circuit matching is by case-insensitive `circuit_ref`, and unmatched rows are appended with `board_id`.
- Observation dedupe follows the intended `(schedule_item + code)` or `(location + first-50-char prefix)` logic.
- PDF support is correctly deferred.

Missing / weakly met objectives:

- The implementation is not actually safe against in-flight concurrent edits, despite the handoff’s stated goal that extraction must be safe to run after the inspector has started typing.
- The helper comment says malformed / `success: false` envelopes are tolerated, but the code does not implement that check.

## 3. Correctness issues

### P1
- **Stale-state merge can overwrite user edits made while extraction is in flight.**  
  The document patch is computed from the `job` object captured when the request started in [circuits/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:182), then applied later with a shallow section replace via [job-context.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:55). Because [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:374) builds whole-section / whole-array patches from that old snapshot, any manual edits the user makes in `installation`, `supply`, `board`, `circuits`, or `observations` during the upload/analysis window can be lost when `updateJob(patch)` lands. This directly violates the intended “safe after typing has started” behavior.

### P2
- **`mergeBoard()` returns a board patch even when nothing changed.**  
  In [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:175), `boards` is always cloned when `boardState.boards` exists, so the guard at line 205 (`boards === boardState.boards`) is never true. Result: extraction often returns a synthetic “changed” `board` patch with identical data, unnecessarily marking the job dirty and causing extra rerenders. It also makes the surrounding code believe a board patch exists when none was meaningfully produced.

- **Circuits without `circuit_ref` are silently dropped.**  
  [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:236) skips any extracted circuit whose `circuit_ref` is missing. That means partially legible prior certs or handwritten sheets can lose otherwise useful designation/OCPD/RCD/test data entirely, with no warning and no summary signal.

- **Commented contract and actual behavior diverge for `success: false`.**  
  The public helper comment in [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:370) claims malformed / `success: false` responses return an empty patch. The implementation immediately reads `response.formData` and never checks `response.success` at all. Today the backend returns `200 { success: true, formData }` on success and non-2xx on failure ([extraction.js](/Users/derekbeckley/Developer/EICR_Automation/src/routes/extraction.js:1497)), so this is latent, but the helper’s documented behavior is false.

## 4. Security issues

- No Phase-5b-specific security issues found in the reviewed frontend path. The upload uses `FormData`, error text is rendered as text content, and I did not see an XSS/auth/CORS regression introduced by this commit.

## 5. Performance issues

- **No-op board patches create unnecessary state churn.**  
  Same root cause as above in [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:175). This forces needless `updateJob` work even when document extraction yielded no board-level data.

- **Whole-array replacement for circuits/observations amplifies rerender cost.**  
  [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:227) and [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:305) rebuild and replace full arrays. That is acceptable for current scale, but combined with the stale-state issue it increases the blast radius of each response.

## 6. Accessibility issues

- No major accessibility regressions found in this phase. The trigger remains a native button, errors use `role="alert"`, and status text uses `role="status"` in [circuits/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:297).

Minor note:
- The empty-state copy still only mentions CCU Photo and not document extraction ([circuits/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:348)), which is a UX/content gap rather than an accessibility defect.

## 7. Code quality

- **Type-safety hole around preserved observation metadata.**  
  The helper deliberately preserves `schedule_item` and `regulation` by casting `ObservationRow` to `Record<string, unknown>` in [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:347), but `ObservationRow` still does not declare those fields in the current tree ([types.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:216)). That makes downstream usage invisible to TypeScript and encourages more bag-casting.

- **Misleading comments.**  
  The `success: false` comment in [apply-document-extraction.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:370) does not match behavior. Comments this specific need to stay exact.

## 8. Test coverage gaps

There are no Phase-5b-targeted tests in `web/` for:

- document extraction merge semantics
- observation dedupe idempotency
- board synthesis / board-targeting behavior
- no-op extraction behavior
- concurrent user-edit vs async extraction race handling
- malformed / partial backend envelopes

This phase is merge-logic-heavy and should not rely on manual verification alone.

## 9. Suggested fixes

1. [web/src/app/job/[id]/circuits/page.tsx:182](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/circuits/page.tsx:182), [web/src/lib/job-context.tsx:55](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:55), [web/src/lib/recording/apply-document-extraction.ts:374](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:374): change the extraction apply path to merge against the latest job state at commit time, not the stale closure snapshot. Either add a functional `updateJob(prev => next)` API or re-read current state before applying. This prevents user edits made during upload/analysis from being overwritten.

2. [web/src/lib/recording/apply-document-extraction.ts:175](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:175): fix `mergeBoard()` so it returns `null` when no board field changed. Track a real `boardChanged` boolean instead of using `boards === boardState.boards`, which is ineffective after cloning. This avoids false dirty state and pointless rerenders.

3. [web/src/lib/recording/apply-document-extraction.ts:236](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:236): decide and implement a fallback policy for extracted circuits without `circuit_ref`. At minimum, count and surface them as skipped; preferably append them with a synthesized ref or quarantine bucket if enough identifying data exists. Silent drop is too lossy.

4. [web/src/lib/recording/apply-document-extraction.ts:370](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:370): either enforce `if (!response?.success) return empty patch` or remove the misleading comment. The code and documented contract should match.

5. [web/src/lib/types.ts:216](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:216) and [web/src/lib/recording/apply-document-extraction.ts:345](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:345): add `schedule_item?: string` and `regulation?: string` to `ObservationRow` if the app intends to preserve them. That removes the `Record<string, unknown>` cast and makes future UI use safer.

6. Add focused tests around [web/src/lib/recording/apply-document-extraction.ts:110](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:110), [220](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:220), and [291](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/recording/apply-document-extraction.ts:291): cover fill-empty-only merges, idempotent re-run of the same doc, no-op board extraction, missing `circuit_ref`, and observation dedupe edge cases.

## 10. Overall verdict

**Needs rework.**

The phase is directionally strong and mostly aligned with the plan, but the stale-state merge race is a real data-loss risk in exactly the workflow this feature is meant to support. The no-op board patch bug and lack of coverage around merge edge cases make the current implementation too fragile to ship as-is.

Top 3 priority fixes:

1. Eliminate the stale-snapshot overwrite race during async extraction.
2. Fix `mergeBoard()` so no-op document reads do not emit fake board patches.
3. Add tests for idempotency, board targeting, and partial/malformed extraction inputs.