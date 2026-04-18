## 1. Summary of the phase

Phase 5c adds a real observation-photo workflow to the web rebuild: inspectors can open an add/edit sheet, capture or pick images, see thumbnail previews, delete photos, and view inline photo previews on observation cards. It also renames `ObservationRow.photo_keys` to `photos` and adds the API client methods needed to upload, delete, and fetch auth-protected photo blobs.

## 2. Alignment with original plan

This mostly matches the handoff doc and commit intent. The implementation does deliver the new sheet UI, separate Camera/Library affordances, authenticated blob fetch via `ObservationPhoto`, inline card previews, and the `photo_keys` → `photos` rename.

The main miss is semantic rather than visual: the handoff describes eager upload/eager delete that should behave like iOS, but the implementation only applies photo adds/deletes to the sheet-local draft until `Save`. That means the backend photo store and the observation JSON can diverge if the user cancels or saves at the wrong time, which is not true parity with the intended flow.

## 3. Correctness issues

- **P1** `Cancel` can silently desynchronise photo state from the persisted observation. In [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:119), successful uploads append the filename only to local `draft.photos`; in [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:138), deletes remove it only from local draft; but [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:178), [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:194), and [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:396) all discard that draft on cancel. Result: upload-then-cancel leaves an orphaned backend photo with no observation reference; delete-then-cancel leaves the observation still pointing at a filename that was already deleted server-side.
- **P1** `Save` is allowed while an upload is still in flight, so the saved observation can omit the photo the user just selected. [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:116) starts async upload, but [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:399) does not disable Save. If the user taps Save before the upload resolves, [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:154) persists the pre-upload draft and the later filename append is lost when the sheet unmounts.
- **P2** The observation card is implemented as a clickable `div` with `role="button"` that contains a real `button` for remove, in [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:234) and [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:268). That is invalid interactive nesting and produces brittle keyboard/screen-reader behaviour.

## 4. Security issues

- **None found [low/informational]** in the reviewed phase. The photo routes use encoded path segments in [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:216) and [api-client.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:258), and the UI does not inject photo filenames into HTML unsafely.

## 5. Performance issues

- **P2** Every thumbnail mounts its own fetch/object-URL lifecycle in [observation-photo.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-photo.tsx:46), with no cache or deduplication. The same photo can be fetched twice when it appears in the card preview and the open sheet.
- **P2** Large observation/photo lists will trigger one network request per thumbnail render in both [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:302) and [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:367). That is probably acceptable for small defect-photo counts, but it does not scale well.

## 6. Accessibility issues

- **P1** Nested interactive controls on the observation card, at [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:234) and [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:268), are a real accessibility defect.
- **P2** The modal has `role="dialog"` and `aria-modal`, but no focus trap, no initial focus placement, and no focus restoration on close in [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:168). Keyboard users can tab behind the dialog.

## 7. Code quality

- The phase is generally clean and coherent: `ObservationPhoto` is well isolated, blob URLs are revoked correctly, and the API surface is small and typed.
- The weak spot is state ownership. Photo side effects are backend-immediate but model-persistence is draft-local, which makes the component logic internally inconsistent and hard to reason about.
- Current working-tree drift is low for this review: `observations/page.tsx`, `observation-sheet.tsx`, and `observation-photo.tsx` are unchanged since `6a73517`; `api-client.ts` and `types.ts` have later Phase 6 additions, but the Phase 5c methods/types are unchanged.

## 8. Test coverage gaps

There are no `test`/`spec` files under `web/` for this flow.

Missing coverage I would expect here:
- upload success/failure, delete success/failure, and cancel/save interactions for `ObservationSheet`
- the “save during upload” race
- `ObservationPhoto` skeleton/error/ready transitions and `URL.revokeObjectURL` cleanup
- keyboard interaction for observation cards and dialog focus behaviour

## 9. Suggested fixes

1. [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:119) and [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:80): persist photo add/delete to the parent observation state immediately after successful upload/delete, not only inside the sheet draft. This keeps `job.observations` aligned with backend side effects and fixes cancel-induced drift.
2. [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:399): disable `Save` and `Cancel` while `uploading` is true, or await outstanding upload promises before closing. This removes the lost-photo race.
3. [page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/observations/page.tsx:234): replace the clickable `div[role="button"]` wrapper with a real button/link-style trigger plus a separate sibling remove button, or make the whole card non-interactive and add an explicit “Edit” button. This fixes invalid nested controls.
4. [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:168): add modal focus management: move initial focus into the sheet, trap focus while open, and restore focus to the triggering control on close.
5. [observation-photo.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-photo.tsx:46): add a small in-memory cache keyed by `userId/jobId/filename/thumbnail` to dedupe fetches and reuse blob URLs across card preview + sheet grid.
6. [observation-sheet.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/components/observations/observation-sheet.tsx:107): add tests covering upload/delete/cancel/save sequencing, especially the races above, before extending the same pattern to later authenticated-blob features.

## 10. Overall verdict

**Needs rework.**

Top 3 priority fixes:
1. Make photo add/delete persistence consistent with eager backend side effects.
2. Prevent `Save`/close while uploads are still in flight.
3. Fix the observation card’s invalid interactive structure for keyboard and screen-reader users.