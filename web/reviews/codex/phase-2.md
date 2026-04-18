# Review: Phase 2 (`83b0863`)

## 1. Summary of the phase
Phase 2 introduced the `/job/[id]/...` shell: a shared job layout, `JobProvider` context, header, tab navigation, overview screen, and placeholder pages for the non-overview tabs. It also added a Phase 2 visual harness in `verify-visual.ts` and the first typed client surface for fetching/saving a full job detail document.

Current-branch note: the touched files have evolved since `83b0863` (`layout.tsx`, `page.tsx`, `job-header.tsx`, `job-tab-nav.tsx`, `api-client.ts`, `types.ts`, `verify-visual.ts`, `globals.css` all changed later), but the main contract issues below still persist in the current tree.

## 2. Alignment with original plan
The implementation broadly matches the handoff: job-detail routing exists, the shared shell is in place, overview exists, and the tab scaffold shipped separately from the real forms.

Gaps/mismatches:
- The commit message says the Phase 2 visual harness covers 18 routes / 36 screenshots, but the code in `83b0863:web/scripts/verify-visual.ts:164-195` actually generates 19 routes: 9 EICR + 10 EIC.
- The handoff describes cert-type-aware tab sets matching iOS. The nav/overview are cert-aware in `83b0863`, but the routes themselves are not guarded, so unsupported screens remain directly reachable by URL.

## 3. Correctness issues

### P1
- **Frontend job model does not match the backend API contract.**  
  Phase 2 introduced `JobDetail` with keys like `installation`, `supply`, `board`, `inspection`, `extent`, `design`, and `inspector` in [`web/src/lib/types.ts:192`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/lib/types.ts:192 ). Current tab consumers read those fields directly, e.g. [`web/src/app/job/[id]/installation/page.tsx:86`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/installation/page.tsx:86 ) and [`web/src/app/job/[id]/supply/page.tsx:43`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/supply/page.tsx:43 ). But the backend returns and persists different keys: `installation_details`, `supply_characteristics`, `board_info`/`boards`, `inspection_schedule`, `extent_and_type`, `design_construction`, `inspector_id` in [`src/routes/jobs.js:575-592`]( /Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:575 ) and [`src/routes/jobs.js:653-740`]( /Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:653 ). The Phase 2 visual mocks use the frontend-only shape in `83b0863:web/scripts/verify-visual.ts:101-130`, so the harness masks the integration break instead of catching it.
- **`api.saveJob()` uses `PATCH`, but the backend only implements `PUT`.**  
  The Phase 2 client added `saveJob` with `method: 'PATCH'` in [`web/src/lib/api-client.ts:272-280`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:272 ). The backend route is `PUT /api/job/:userId/:jobId` in [`src/routes/jobs.js:651`]( /Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:651 ), and the backend tests only cover `PUT` in [`src/__tests__/jobs.test.js:202-228`]( /Users/derekbeckley/Developer/EICR_Automation/src/__tests__/jobs.test.js:202 ). Once Phase 4/7 started calling `saveJob`, this became a hard integration failure.

### P2
- **401 handling is brittle and may strand expired sessions on an error card.**  
  In the Phase 2 layout, auth expiry is detected with `/401/.test(err.message)` (`83b0863:web/src/app/job/[id]/layout.tsx:46-53`; same pattern still exists in [`web/src/app/job/[id]/layout.tsx:80-85`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:80 )). But `request()` throws `ApiError(status, body || statusText)` in [`web/src/lib/api-client.ts:62-64`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:62 ), so a normal 401 message like `"Unauthorized"` will not match. Result: users can get a permanent “Couldn’t load job” card instead of being signed out and redirected.
- **Wrong-cert tab routes are reachable directly.**  
  Phase 2 created separate pages for `/extent`, `/design`, and `/observations`, and the harness comment explicitly says `extent` “renders either way” in `83b0863:web/scripts/verify-visual.ts:167`. That means an EICR job can still open `/extent` or `/design`, and an EIC job can still open `/observations`, even though the cert-specific nav hides them. If the intent is iOS parity, these routes should redirect or 404.

## 4. Security issues
- **None identified specific to this phase.** The backend correctly re-authorizes access on job fetch/update via `auth.canAccessUser` in [`src/routes/jobs.js:477-480`]( /Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:477 ) and [`src/routes/jobs.js:666-669`]( /Users/derekbeckley/Developer/EICR_Automation/src/routes/jobs.js:666 ).

## 5. Performance issues
- **P2: every job edit invalidates the entire job shell.**  
  `JobProvider` stores the full `job` object and exposes one context value object in `83b0863:web/src/lib/job-context.tsx:55-70` (still the same in [`web/src/lib/job-context.tsx:55-70`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/lib/job-context.tsx:55 )). Any field update forces all consumers of `useJobContext()` to re-render, including header and any future heavy tabs. Acceptable for stubs; likely noticeable once circuits/observations are populated.

## 6. Accessibility issues
- **P2: save-status changes are not announced to assistive tech.**  
  `SaveStatus` is just a changing `<span>` with no `role="status"` / `aria-live` in `83b0863:web/src/components/job/job-header.tsx:37-59` (same issue remains in [`web/src/components/job/job-header.tsx:65-87`]( /Users/derekbeckley/Developer/EICR_Automation/web/src/components/job/job-header.tsx:65 )). “Saved / Unsaved / Saving…” is important state and should be announced.
- **P2: loading shell is visual-only.**  
  `JobShellLoading` is shimmer blocks only, with no accessible loading text or `aria-busy` marker in `83b0863:web/src/app/job/[id]/layout.tsx:79-109`. Screen-reader users get almost no feedback while the job loads.

## 7. Code quality
- **Tab metadata is duplicated in three places.**  
  Phase 2 hard-coded tab definitions in `83b0863:web/src/components/job/job-tab-nav.tsx:21-44`, `83b0863:web/src/app/job/[id]/page.tsx:18-44`, and `83b0863:web/scripts/verify-visual.ts:164-195`. This already caused drift later: the current nav is unified while the Phase 2 overview/harness logic originally assumed cert-specific sets. One source of truth was needed here.
- **Type naming drift from backend semantics starts in this phase.**  
  The Phase 2 `JobDetail` names read like a normalized UI model, but no adapter layer was added. That leaves the codebase in an awkward half-state: UI-friendly names on the client, legacy persistence names on the server, and no explicit translation point.

## 8. Test coverage gaps
- The web workspace still has no unit/integration test coverage for this shell; `rg` only finds the Playwright-style `verify-visual.ts` harness, not real `*.test.*` files under `web/`.
- Missing high-value coverage:
  1. API contract tests proving `api.job()` and `api.saveJob()` match the backend field names and HTTP verbs.
  2. Route tests for wrong-cert deep links (`/extent`, `/design`, `/observations`).
  3. Auth-expiry tests verifying a 401 redirects to `/login` instead of rendering the error card.
  4. Consistency tests for tab metadata so nav, overview, and visual harness cannot drift.

## 9. Suggested fixes
1. **`web/src/lib/api-client.ts:131-135,272-280`**  
   Add an explicit adapter layer: map backend payloads (`installation_details`, `supply_characteristics`, `extent_and_type`, etc.) into the UI model on read, and map UI edits back to backend keys on save. Also change `saveJob()` to use `PUT` unless/until the backend supports `PATCH`.  
   Why: this is the main integration break and the foundation all later phases build on.

2. **`web/src/lib/types.ts:192-239`**  
   Either redefine `JobDetail` to the backend’s actual wire format, or introduce separate `ApiJobDetail` and `UiJobDetail` types and convert between them in the API client.  
   Why: the current single type claims the wrong contract and makes the visual harness lie.

3. **`web/src/app/job/[id]/layout.tsx:80-85`**  
   Replace regex-on-message auth detection with `err instanceof ApiError && err.status === 401`.  
   Why: redirect behavior should depend on the status code, not brittle string matching.

4. **`web/src/app/job/[id]/extent/page.tsx`, `design/page.tsx`, `observations/page.tsx`**  
   Add certificate-type guards and redirect or `notFound()` when the route is invalid for the current job type.  
   Why: nav parity is not enough if unsupported screens remain deep-linkable.

5. **`web/src/components/job/job-header.tsx:65-87`**  
   Wrap the save indicator in a polite live region, e.g. `role="status" aria-live="polite"`.  
   Why: save state is meaningful asynchronous feedback.

6. **`web/src/app/job/[id]/layout.tsx:143-163`**  
   Add a screen-reader-visible loading message and/or `aria-busy` on the loading shell.  
   Why: shimmer alone is not accessible.

7. **`web/src/components/job/job-tab-nav.tsx`, `web/src/app/job/[id]/page.tsx`, `web/scripts/verify-visual.ts`**  
   Export one shared tab-config module and consume it from nav, overview, and the visual harness.  
   Why: this removes drift and would have prevented the later parity regressions.

8. **`web/scripts/verify-visual.ts:164-195`**  
   Assert the generated route count and keep the comment accurate.  
   Why: the current code/comment mismatch makes the visual verification story less trustworthy.

## 10. Overall verdict
**Needs rework.**

Top 3 priority fixes:
1. Align the client/server job-detail contract.
2. Fix `saveJob()` to use the backend’s actual method and payload.
3. Replace brittle 401 handling with real status-based auth redirects.