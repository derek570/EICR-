# Phase 5c — Context

**Commit:** `6a73517`

## Commit message

```
commit 6a73517077047b79e6a9e5559d1f7ca2fa6280d2
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 16:53:13 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 16:53:13 2026 +0100

    feat(web): Phase 5c observation photos
    
    What changed
    ============
    Inspectors can now capture or attach photos to observations on the web
    frontend, matching iOS parity. Add/edit modal with Camera + Library
    buttons, live thumbnail grid, per-photo delete, and inline preview on
    each observation card.
    
    Why
    ===
    `ObservationRow.photo_keys` has been dormant since Phase 3c. Without
    photos, inspectors could describe defects but couldn't prove them
    visually — breaking parity with iOS (where defect photos flow through
    to the PDF) and weakening the output for clients. 5c closes that gap.
    
    Why this approach
    =================
    - **Auth'd image fetch via blob URL.** The photo endpoint requires a
      bearer token. `<img src>` never attaches our Authorization header, so
      we fetch the bytes via `api.fetchPhotoBlob`, wrap in
      `URL.createObjectURL`, and revoke on unmount. `<ObservationPhoto>`
      encapsulates this (skeleton → ready → error fallback). Same pattern
      will be reusable for signatures in Phase 6.
    - **Eager upload, eager delete.** iOS commits photos immediately and
      lets S3 lifecycle sweep orphans. We match that — simpler state
      management and the failure mode (orphan after cancelled-new
      observation) is already handled server-side.
    - **Two buttons, not one.** Memory memo recommended a single picker,
      but Derek explicitly asked for two to match iOS `EditObservationSheet`.
      Camera input uses `capture="environment"` for rear-camera hint; Library
      omits `capture` so the native photo-library picker shows. Matches
      iOS UX 1:1.
    - **`photo_keys` → `photos` rename.** Grep confirmed zero call-sites —
      the old name always misled because the backend stores filenames,
      not opaque "keys". Cheaper to rename now than after 5d lands. The
      new name matches iOS `Observation.photos` so round-trips are lossless.
    - **Inline card preview.** Three thumbnails + `+N` chip mirrors iOS's
      card-level affordance; the sheet shows the full grid with delete
      buttons.
    - **Three new API methods, not two.** `fetchPhotoBlob` needs a
      bespoke `fetch` (the shared `request()` helper always parses as
      JSON/text). Keeping it alongside upload/delete in `api-client.ts`
      keeps all photo concerns in one place.
    
    Context
    =======
    - Backend routes (`src/routes/photos.js:142` upload, `:193` delete) are
      already live — zero backend changes. The memo had confused the upload
      shape with a pre-signed-URL pattern; correction captured in memory.
    - Add button was previously stubbed with "wires up in Phase 5" — now
      enabled.
    - CSS matches existing card-surface + chip patterns from 5a/5b for
      visual consistency (same radii, same error banners, same spinners).
    - `useParams` now used on observations page to resolve `jobId`; matches
      the pattern already in `job/[id]/page.tsx`.
    - CLAUDE.md changelog entry added per project commit rules.
    
    Scope exclusions (deferred)
    ===========================
    - Bulk upload / drag-drop — nice-to-have, iOS doesn't have it.
    - Photo annotations — iOS doesn't have them either.
    - LiveFillView (5d) — next sub-phase.
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                          |   1 +
 web/src/app/job/[id]/observations/page.tsx         | 162 +++++++-
 .../components/observations/observation-photo.tsx  | 110 ++++++
 .../components/observations/observation-sheet.tsx  | 406 +++++++++++++++++++++
 web/src/lib/api-client.ts                          |  76 ++++
 web/src/lib/types.ts                               |   9 +-
 6 files changed, 743 insertions(+), 21 deletions(-)
```
