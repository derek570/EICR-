# Phase 2 — Context

**Commit:** `83b0863`

## Commit message

```
commit 83b0863a3e63e4fe1f0e7bf61e42e1e0dd736e75
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 11:49:17 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 11:49:17 2026 +0100

    feat(web): Phase 2 — job detail shell with 10 tabs
    
    Adds the navigable skeleton for every /job/[id]/... route plus supporting
    infrastructure. Tab contents are TabStub placeholders; real editing
    surfaces land in Phase 3a/3b/3c.
    
    What
    - JobProvider context (lib/job-context.tsx): holds fetched JobDetail +
      dirty/saving flags, exposes updateJob(partial) for per-tab edits. Debounced
      save effect deferred to Phase 4.
    - Job detail layout (app/job/[id]/layout.tsx): auth-gates the route, fetches
      the full job detail once, wraps children in JobProvider, renders header +
      tab nav + scroll container. Skeleton shimmer while loading, error card
      on fetch failure.
    - JobTabNav (components/job/job-tab-nav.tsx): horizontal scroll strip on
      mobile, 220px vertical sidebar on desktop. Two tab sets — EICR (Overview,
      Installation, Supply, Board, Circuits, Observations, Inspection, Inspector,
      PDF) and EIC (Overview, Installation, Extent, Supply, Board, Circuits,
      Inspection, Design, Inspector, PDF) — matching the iOS JobDetailView enum.
    - JobHeader (components/job/job-header.tsx): address + cert type pill +
      save status chip (saved / unsaved / saving…).
    - TabStub (components/job/tab-stub.tsx): reusable "coming in Phase N"
      placeholder used by 9 of 10 tabs for now.
    - Tab pages: installation, extent, supply, board, circuits, observations,
      inspection, design, inspector, pdf — each a small TabStub wrapper.
    - Overview page (app/job/[id]/page.tsx): section grid with links to every
      tab + cert-type-aware set.
    - API client: added api.job(userId, jobId) + api.saveJob(userId, jobId, patch).
    - Types: JobDetail, CircuitRow, ObservationRow, InspectorInfo.
    - globals.css: .scrollbar-hide helper for the mobile tab strip.
    - verify-visual.ts: PHASE 2 routes for every tab × both cert types (18
      routes, 36 screenshots including mobile + desktop), with scoped
      page.route mocks for /api/job/<userId>/<jobId>.
    
    Why
    - iOS users move between the 10 tabs constantly during an inspection; the
      web app has to have the same spatial layout (same tab order, same
      spot to click Circuits) before it can feel familiar.
    - Splitting route creation from tab-content-building means we can land
      auth + navigation + save-status UX in one reviewable commit, then
      replace tab bodies individually without breaking the shell.
    - JobProvider-as-context (not Zustand) keeps tab edits colocated with
      the layout that owns fetching — React context is enough until we need
      recording state to cross route boundaries (Phase 4, which will lift to
      Zustand as originally planned).
    
    Why this approach
    - Mobile tab strip uses overflow-x + scrollbar-hide rather than a
      hamburger drawer: Derek's inspection flow constantly flips between
      Circuits and Observations on a phone, so the tabs must be one tap away
      at all times. The legacy web did a fixed sidebar and it didn't scale to
      375px viewports.
    - Inline `maxWidth` on content containers avoids the Tailwind 4
      `max-w-3xl` one-word-per-line regression we documented in Phase 0.
    - Mock URL matcher in verify-visual.ts now pops the last path segment
      instead of .includes() — caught in the first Phase 2 run where
      demo-eicr was matching MOCK_EIC_JOB because 'demo-eicr'.includes('demo-eic')
      is true.
    
    Visual verification
    - PHASE=2 npm run verify produces 34 screenshots (EICR × 9 tabs × 2
      viewports + EIC × 10 tabs × 2 viewports - 2 overlaps from shared tab
      slugs). Spot-checked EICR overview (desktop + mobile), Circuits stub,
      and EIC overview — all render with correct cert-type-specific tabs and
      mock data.
    
    Follow-ups (Phase 3+)
    - Replace each TabStub with its real form.
    - Wire beforeunload guard and debounced auto-save into JobProvider (Phase 4
      when the recording overlay also needs to flush state).
```

## Files changed

```
 web/scripts/verify-visual.ts               | 103 +++++++++++++++++++++++++++
 web/src/app/globals.css                    |   9 +++
 web/src/app/job/[id]/board/page.tsx        |  11 +++
 web/src/app/job/[id]/circuits/page.tsx     |  11 +++
 web/src/app/job/[id]/design/page.tsx       |  11 +++
 web/src/app/job/[id]/extent/page.tsx       |  11 +++
 web/src/app/job/[id]/inspection/page.tsx   |  11 +++
 web/src/app/job/[id]/inspector/page.tsx    |  11 +++
 web/src/app/job/[id]/installation/page.tsx |  11 +++
 web/src/app/job/[id]/layout.tsx            | 110 +++++++++++++++++++++++++++++
 web/src/app/job/[id]/observations/page.tsx |  11 +++
 web/src/app/job/[id]/page.tsx              |  98 +++++++++++++++++++++++++
 web/src/app/job/[id]/pdf/page.tsx          |  11 +++
 web/src/app/job/[id]/supply/page.tsx       |  11 +++
 web/src/components/job/job-header.tsx      |  60 ++++++++++++++++
 web/src/components/job/job-tab-nav.tsx     |  96 +++++++++++++++++++++++++
 web/src/components/job/tab-stub.tsx        |  40 +++++++++++
 web/src/lib/api-client.ts                  |  24 ++++++-
 web/src/lib/job-context.tsx                |  73 +++++++++++++++++++
 web/src/lib/types.ts                       |  52 ++++++++++++++
 20 files changed, 774 insertions(+), 1 deletion(-)
```
