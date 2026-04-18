# Phase 5c Review — Observation Photos

**Commit:** `6a73517` (`feat(web): Phase 5c observation photos`)
**Scope:** `web/src/app/job/[id]/observations/page.tsx`, `web/src/components/observations/{observation-photo.tsx,observation-sheet.tsx}`, `web/src/lib/api-client.ts`, `web/src/lib/types.ts`.
**Reviewer:** Claude Opus 4

---

## 1. Summary

Phase 5c wires up end-to-end observation photo capture on the web frontend:

- New `ObservationPhoto` component performs an auth'd blob fetch (bearer token in header), wraps in `URL.createObjectURL`, and revokes on unmount.
- New `ObservationSheet` modal adds an edit-form UX for observation rows, with separate Camera (`capture="environment"`) and Library buttons plus a thumbnail grid with per-photo delete.
- Three new API methods (`uploadObservationPhoto`, `deleteObservationPhoto`, `fetchPhotoBlob`) added to `api-client.ts`.
- `ObservationRow.photo_keys` renamed to `photos` to match the iOS model.
- The observations page now renders up to 3 inline thumbnails + an "+N" chip per card.

The change is well-structured, well-commented, and largely correct. The single most important defect is a lost-update bug around the Cancel flow: **photos that are uploaded (and committed to S3) inside the sheet are thrown away from the observation if the user taps Cancel, because `draft.photos` is local to the sheet and only propagated on Save.** Several other issues are listed below; none are security-critical.

---

## 2. Alignment with Phase 5c Handoff / iOS Parity

| Handoff requirement | State |
|---|---|
| Two buttons (Camera + Library) matching iOS `EditObservationSheet` | Met (`observation-sheet.tsx:295-316`) |
| Auth'd image fetch via blob URL | Met (`observation-photo.tsx:46-75`) |
| Inline card preview (3 thumbs + `+N`) | Met (`observations/page.tsx:295-317`) |
| `photo_keys` → `photos` rename | Met (`types.ts:229`) |
| Round-trip with iOS `Observation.photos` JSON key | Met (names match); no custom (de)serializer needed |
| Eager upload/eager delete, let S3 lifecycle sweep orphans | **Partially met** — eager on S3 but local-state propagation is Save-gated; see §3 P0-1 |
| Backend routes already live, zero backend changes | Confirmed (`src/routes/photos.js:142` upload, `:193` delete) |
| CLAUDE.md changelog | Met |

---

## 3. Correctness

### P0 — Lost-update on Cancel (photos orphaned, disappear from observation)

**Files:** `observation-sheet.tsx:107-152`, `observations/page.tsx:75-78`.

The sheet mutates local `draft.photos` after upload/delete but only pushes back to the parent via `onSave → handleSave`. If the user:

1. Opens the sheet on an existing observation with photos `[a, b]`.
2. Adds a new photo `c` (S3 upload succeeds, `draft.photos = [a, b, c]`).
3. Taps Cancel (or Esc, or backdrop).

Then `closeSheet()` runs, `draftNew` is discarded, and the observation in `job.observations` still holds `[a, b]`. The blob `c` is now an S3 orphan that the observation cannot see, but it *was* a legitimate upload the inspector expected to keep.

Worse, if they:

1. Tap Delete on existing photo `a` (backend DELETE succeeds, `draft.photos = [b]`).
2. Tap Cancel.

The observation still references `[a, b]` in `job.observations`, but `a` has been hard-deleted from S3 — subsequent renders will show a broken thumbnail forever.

The commit message argues "photos are committed eagerly — S3 lifecycle handles orphans." That is true for cancelled **new observations** only. For **edits to existing observations** (which, per `openEdit` at `observations/page.tsx:70`, is the dominant path), Cancel produces data loss (orphan adds) *and* dangling-filename breakage (orphan deletes).

**Fix options (pick one):**
- Lift `photos` out of the sheet and call `updateJob({ observations })` directly on every successful upload/delete. Drop the Save/Cancel semantics for photos only (like iOS). Recommended.
- Or: on Cancel, diff `draft.photos` vs `observation.photos`, DELETE the newly-added filenames, and re-upload (impossible) the newly-deleted ones. Not viable — delete is destructive.

### P0 — `useMemo([])` memo deps for `userId` is a lint trap, but in practice OK

**File:** `observations/page.tsx:53`, `observation-sheet.tsx:80`.

```tsx
const userId = React.useMemo(() => getUser()?.id ?? null, []);
```

`getUser()` reads from `localStorage` (auth module). The empty dep array means a signed-out → signed-in transition inside the same mounted tree won't refresh `userId`. Not a regression because the rest of the app has this pattern, but worth noting: a Tab-switch or cross-tab login event would not trigger re-render here. Low risk in practice — the Observations tab is reached only after an auth-gated route guard. Consider reading from an auth context instead of `localStorage` at a later phase.

### P1 — `editing` memoization reads `observations.find` on every render

**File:** `observations/page.tsx:96-101`.

```tsx
const editing =
  editingId === null
    ? null
    : ((draftNew && draftNew.id === editingId
        ? draftNew
        : observations.find((o) => o.id === editingId)) ?? null);
```

`editing` is not memoized, so `observations.find` runs every render. Cheap today (observations list is small) but produces a fresh object reference on each render, which will churn `ObservationSheet`'s memoization if it ever gains one. Wrap in `useMemo`.

### P1 — `handleFile` uses the same handler for both inputs

**File:** `observation-sheet.tsx:107`, bound to both `cameraInputRef` (`:327`) and `libraryInputRef` (`:335`).

Functionally correct (both need identical behaviour) but this means the first file from a multi-select is taken (`files?.[0]`) and the rest silently dropped. Neither input has `multiple`, so technically moot, but note that on iOS Safari the Library picker sometimes allows multi-select via long-press; a single file selection is guaranteed only because `multiple` is not set. Acceptable as designed.

### P1 — Sequential/concurrent upload race: no queue

**File:** `observation-sheet.tsx:107-132`.

If the user taps Camera → captures → taps Library quickly before the first upload completes, the button `disabled={uploading}` (`:301`, `:311`) gates only the *button*. But:

- `setDraft((d) => ({ ...d, photos: [...(d.photos ?? []), photo.filename] }))` inside two concurrent `handleFile` calls would work correctly because the functional setter is safe.
- However the backend uses `photo_${Date.now()}${ext}` for the filename (`src/routes/photos.js:163`). If two uploads hit within the same ms (rare but possible on fast connections with small files) they would collide on filename — second upload overwrites first's S3 object. Not caused by this commit, but Phase 5c is the first client path that can trigger it. Worth logging.

In practice `disabled={uploading}` + the `.click()` indirection prevents the common race. Low priority.

### P1 — No client-side file validation (size / MIME)

**File:** `observation-sheet.tsx:107-132`.

Backend cap is 100 MB (`photos.js:26`). A 50 MB HEIC blob would upload, consume S3 bytes, succeed server-side, but never fit the grid thumbnail endpoint well. Pre-validation with a polite error is a trivial UX win and matches the document-extraction flow (5b) which does the same.

Also: `accept="image/*"` is permissive enough that some browsers will pass through `.svg` / `.tiff` — the backend's `IMAGE_MIMES` filter rejects non-image, but the user sees a bland "Upload failed (400)" rather than "SVG not supported." Low priority.

### P1 — `deletePhoto` runs without confirmation

**File:** `observation-sheet.tsx:134-152`, trash button at `:374-382`.

A single tap on the trash icon fires an immediate, irreversible backend DELETE. iOS presumably has a confirmation sheet; web has none. At minimum a `window.confirm` or a two-tap "tap to confirm" affordance is warranted for a destructive action on mobile. Touch-target is 24×24 (h-6 w-6) which is also below the 44×44 minimum (see §6).

### P2 — `ObservationPhoto` re-fetches on every `thumbnail`/`filename` change, no cache

**File:** `observation-photo.tsx:46-75`.

The effect depends on `[userId, jobId, filename, thumbnail]`. Navigating into the sheet after seeing the card preview re-fetches the same thumbnail. Browser HTTP cache should cover this because the backend sets `Cache-Control: public, max-age=31536000` (`src/routes/photos.js:130`), and `fetch` respects that — so the second fetch is a 304/cached response. But `Authorization: Bearer` invalidates shared caches, and `credentials: 'include'` opts into cookies. In practice Safari does cache auth'd GETs in the memory cache, so this is a non-issue; just worth flagging that a module-level `Map<string, Promise<Blob>>` would dedupe in-flight requests cleanly if you ever hit scale issues.

### P2 — Cache-Control header on auth'd blob fetch sends cookies to a token-gated endpoint

**File:** `api-client.ts:259`.

`credentials: 'include'` is set on `fetchPhotoBlob`, `fetchSignatureBlob`, `fetchLogoBlob`. Harmless today (backend accepts either), but combining cookie auth + bearer auth on a GET means any CSRF analysis needs to treat these GETs as cookie-authenticated. GETs shouldn't be state-changing so this is fine, but worth noting in security posture. See §4.

### P2 — `makeId()` fallback uses `Math.random()` not crypto

**File:** `observations/page.tsx:42-47`.

Only used for client-local observation IDs, not for anything security-sensitive. Collision probability is negligible for a single inspector's session. Fine.

### P2 — `observation.description ? 'Edit observation' : 'Add observation'` is wrong heuristic

**File:** `observation-sheet.tsx:190`.

An observation with only a code or only a location (no description yet) renders the sheet title as "Add observation" even during an edit. Should key on whether the row existed in `observations` vs being a `draftNew`. Minor polish.

---

## 4. Security

- **Auth'd fetch is correctly implemented.** Bearer token attached via `Authorization` header; blob URL is local-scope; revoked on unmount (`observation-photo.tsx:73`). Good.
- **Blob URL leaks on inner-effect restart.** The effect cleanup calls `URL.revokeObjectURL(objectUrl)` only if the local `objectUrl` var was assigned. If the fetch is still in-flight when the effect re-runs (e.g. filename prop change during load), `cancelled` flips and the blob is never assigned — correct, no leak. If the fetch has *just* resolved and set state, the cleanup runs synchronously before the next effect; `objectUrl` holds the URL, and it is revoked. Good.
- **CORS / cookie behaviour.** `credentials: 'include'` on blob GETs combined with bearer auth is defence-in-depth but broadens the request surface for CSRF analysis. GETs are safe by convention; not a finding.
- **XSS.** Photo `filename` is taken from backend response and passed to `encodeURIComponent` before appearing in the URL (`api-client.ts:258`, `:235`). No direct DOM sink. Safe.
- **Filename handling.** The backend generates `photo_${Date.now()}${ext}` server-side (`photos.js:163`) so the client never injects a filename into a path. Safe.
- **Path traversal.** `filename` round-trips through `encodeURIComponent` on both GET and DELETE. The backend must still validate (we didn't audit `src/routes/photos.js:193`), but the client's contribution is clean.
- **No client-side MIME check.** See P1. Low-severity since the backend rejects via `IMAGE_MIMES`.
- **ObjectURL lifecycle on error.** On fetch error (`status === 'error'`), no blob URL was created, so nothing to revoke. Good.

No P0/P1 security findings.

---

## 5. Performance

- **Re-fetch on grid render.** Each thumbnail is its own `<ObservationPhoto>` with its own `useEffect`, so N photos = N network fetches. Acceptable for small N, wasteful for N > 10. Fine for defect-photo counts but worth revisiting when signatures land.
- **No request dedup.** Card preview and sheet grid both mount `<ObservationPhoto>` with the same `userId/jobId/filename/thumbnail=true` — two separate blob URLs, two separate `URL.createObjectURL` objects for the same bytes. Memory cost ~= 2× thumbnail size per photo. Could be dedupped via a shared cache (Map + ref-counted `URL.createObjectURL`). Low priority.
- **Large-photo memory.** The blob fetch loads the *entire* thumbnail into memory. Backend default is a scaled JPEG (thumbnail query), so small. For the full-res variant (`thumbnail={false}`), a 20 MB JPEG would be fully buffered in a Blob + `createObjectURL`. The current usage only ever passes `thumbnail` (explicit at `observations/page.tsx:307` and `observation-sheet.tsx:372`), so this is latent — if a future lightbox flips to full-res, make sure it revokes aggressively.
- **Body scroll lock** (`observation-sheet.tsx:89`) correctly restores `prevOverflow` on unmount. Good.
- **No debounce on upload** (expected: user-initiated). Fine.

---

## 6. Accessibility

### Findings

- **Trash button (delete photo)** is 24×24 px (`h-6 w-6` at `observation-sheet.tsx:378`). Guidelines require **44×44 minimum** on mobile. Major miss. Combine with P1-delete-confirmation above.
- **`aria-hidden` on `<input type="file">`** (`:329`, `:337`) is correct (the inputs are hidden; the `<Button>`s drive them).
- **Role="button" on ObservationCard** (`observations/page.tsx:234-243`) implements Enter/Space handler explicitly — correct. Would be cleaner as an actual `<button>`, but nested trash button inside would then be invalid HTML. Current pattern is the usual workaround.
- **Modal backdrop is a `<button>`** (`observation-sheet.tsx:175-180`) with `aria-label="Close"`. Good — clickable and screen-reader-discoverable.
- **Focus trap missing.** The modal opens but does not trap focus. Tab will leak to the page behind. Also, on open focus is not moved into the modal; a screen reader may not announce it. Recommend focusing the first interactive element (code chips) on mount.
- **`alt=""` on card thumbnails** (`observations/page.tsx:306`) — correct, they are decorative previews with the card as interactive context.
- **`alt="Observation defect photo"` on sheet grid** (`observation-sheet.tsx:371`) — generic. If the observation had a description, `alt` could be `Defect photo: ${description}` for context. Minor.
- **Error banner uses `role="alert"`** (`:352`). Good. Upload status uses `role="status"` (`:342`). Good.
- **Broken-image fallback** (`observation-photo.tsx:88-100`) is `role="img"` with `aria-label="Photo failed to load"`. Good.
- **Color-contrast check deferred** — chip labels on coloured backgrounds (`--color-status-processing` amber with white text) may be borderline. Out of scope but worth a pass.
- **`prefers-reduced-motion`** not honoured by the loading `animate-pulse` skeleton. Low severity.
- **Esc to close** is wired (`:85`). Good.

---

## 7. Code Quality

- **Clear, self-documenting.** Comments are excellent — rare inline rationale for `capture="environment"`, for the header-blob pattern, and for the Save-on-commit flow. Stands out.
- **Shared upload concerns co-located** in `api-client.ts`. Good instinct.
- **Duplication.** `fetchPhotoBlob`, `fetchSignatureBlob`, `fetchLogoBlob` are nearly identical functions (`api-client.ts:247`, `:348`, `:421`). A single `fetchAuthedBlob(path)` helper would collapse them to 4 lines each. Worth refactoring in Phase 6 wind-down.
- **`handleFile` catches broadly.** `err instanceof ApiError` branch is good; falls back to `Error` shape. Matches the rest of the codebase.
- **Type narrowing on `getUser()`**: returns `User | null`. Correctly handled with `?? null`.
- **`observation-sheet.tsx:80` not-signed-in fallthrough**. Uploads/deletes early-return silently when `userId == null`. UX-wise, the buttons are `disabled`, so this is defence in depth. Fine.
- **Magic strings.** `'new'` sentinel mentioned in the page comment (`observations/page.tsx:58`) isn't actually used — the code uses a real `draftNew` row with a real id. Comment is stale. Minor.
- **`CODE_COLOUR` duplicated** across `observations/page.tsx:24` and `observation-sheet.tsx:53`. Extract to a shared const or the types module.
- **No enum for `'C1' | 'C2' | 'C3' | 'FI'`**. Used as keys in multiple places; a central `const OBSERVATION_CODES` would help.

---

## 8. Test Coverage

- Grep confirms **no Jest/Vitest tests** were added for any of the new files. The existing `web/src/` test folders don't pick up these components.
- No Playwright/E2E for the upload flow.
- Blob-URL lifecycle (the trickiest correctness concern) is untested.

Suggested additions (in priority order):

1. **Unit test** `observation-sheet.tsx` — mock `api` and assert that `handleFile` appends to `draft.photos` on success and sets error on failure; `deletePhoto` reverts local state on failure (it currently doesn't, by the way — see P1 below).
2. **Unit test** `observation-photo.tsx` — mock `fetchPhotoBlob`, assert skeleton → ready transitions, and assert `URL.revokeObjectURL` is called on unmount.
3. **Integration test** of the Save/Cancel flow: open sheet on existing obs → upload → cancel → confirm the uploaded photo is *still* on the observation (or, once fix-1 lands, confirm on-Cancel cleanup behaviour).
4. **Contract test** that `ObservationRow.photos` round-trips through `saveJob` + `job` fetch without mangling.

---

## 9. Suggested Fixes (numbered, file:line)

1. **(P0) Fix cancel-loses-photos.** `observation-sheet.tsx:119-120`, `:139-142`. Lift `photos` out of the sheet's Save/Cancel gate: on successful upload/delete, call a new prop `onPhotosChange(photos: string[])` that the page wires to `updateJob({ observations: ... })` immediately. Drop the photos-only Save semantic, matching iOS.
2. **(P1) Add delete confirmation.** `observation-sheet.tsx:374-382`. Wrap the trash in a two-tap confirmation or a `window.confirm`.
3. **(P1) Enlarge trash touch target.** `observation-sheet.tsx:378`. Expand to 44×44 (e.g. `h-11 w-11`) with a smaller inner icon, and add visible focus ring.
4. **(P1) Client-side file-size guard.** `observation-sheet.tsx:111`. Reject files > 20 MB with a user-facing error before `api.uploadObservationPhoto`.
5. **(P1) Focus management on modal open.** `observation-sheet.tsx:83-94`. On mount, focus the first interactive element; on unmount, restore focus to the element that opened the sheet.
6. **(P1) Trap focus inside modal.** Same effect. Cycle Tab/Shift-Tab within the panel.
7. **(P1) Memoize `editing`.** `observations/page.tsx:96-101`. Wrap in `useMemo`.
8. **(P1) Don't mutate `draft.photos` optimistically on delete before backend confirms.** `observation-sheet.tsx:138-142`. The code does await before mutating — actually fine. Disregard.
9. **(P2) Dedupe auth'd blob helpers.** `api-client.ts:247/348/421`. Factor to `fetchAuthedBlob(path: string)`.
10. **(P2) Extract `CODE_COLOUR` and `CODE_LABEL`** to a shared const (`web/src/lib/observation-codes.ts` or `types.ts`). Currently duplicated at `observations/page.tsx:24` and `observation-sheet.tsx:53`.
11. **(P2) Fix title heuristic.** `observation-sheet.tsx:190`. Pass an `isNew` prop from the page (it already knows via `draftNew`).
12. **(P2) Drop stale `'new'` sentinel comment.** `observations/page.tsx:58`.
13. **(P2) Refine thumbnail alt text.** `observation-sheet.tsx:371`. Use the description when available.
14. **(P2) Move the upload filename generation to a UUID** on the backend (`src/routes/photos.js:163`) to eliminate the `Date.now()` collision race. Out-of-scope for Phase 5c but flag for a backend ticket.
15. **(P2) Add unit + integration tests** per §8.

---

## 10. Verdict + Top 3 Priorities

**Verdict: Approve with changes.** The commit ships a well-structured, visually-polished, iOS-parity photo flow. The architecture (auth'd blob fetch, eager S3 writes, sheet-local editing) is sound. But the Save/Cancel gate over a side-effectful upload/delete path produces a real data-loss bug (P0-1) that needs a follow-up commit before Phase 5d builds on this.

**Top 3 priorities:**

1. **Fix the Cancel-loses-photos lost-update bug** (Suggested fix 1). This is a data-loss path that inspectors will hit the first time they cancel an edit after adding a photo. Either lift photo state to the page (matching iOS's eager-commit semantic), or change Cancel to blocked-when-photos-changed.
2. **Accessibility polish on the modal** — touch-target size on the trash button (fix 3), focus management (fix 5 + 6), and delete confirmation (fix 2). These are genuine a11y gaps and all three are cheap.
3. **Add tests** (fix 15). Blob-URL lifecycle, upload optimistic update, and the cancel-flow fix from (1) all deserve unit coverage before Phase 5d (LiveFillView) introduces concurrent UI surface over the same data.

Nothing security-critical; no blockers to deploy; follow-up fixes can land as a Phase 5c.1 patch.
