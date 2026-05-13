# PWA Observation-Photo Auto-Link — Implementation Plan (2026-05-13)

**Author:** Claude (drafted 2026-05-13 after L2 audit on the 2026-05-12 PWA-parity push).
**Status:** Drafted. Decisions PROPOSED but not yet locked — Derek to confirm Phase 0 before any code lands.
**Effort estimate:** 4–6 sessions (~10–14 hours), single branch, 6 commits.
**Depends on:** Nothing critical. IDB v3 schema must remain backward-compatible on bump to v4 (read-through cache from Phase 7b is the only existing v3 user).
**Risk class:** **Low-Medium** — adds a feature, doesn't change existing apply paths. Main risks are (a) IDB migration, (b) server upload-during-resize race, (c) "unassigned pool" scope creep.

---

## Goal

Close the lone behaviour-shaped gap from the 2026-05-12 PWA-parity audit. After this work:

1. Inspector taps a new **Photo** button on the recording chrome → iPad camera opens via standard `<input type=file accept=image/* capture=environment>`.
2. If a Sonnet observation was created within the last 60 s, the photo auto-attaches to that observation's `photos[]` (Case B / reverse-link).
3. If no recent observation, the photo enters a pending-photo slot (one slot, replace-on-new — iOS parity); the next Sonnet observation in the same 60 s window attaches it (Case A / forward-link).
4. If the 60 s window expires with no observation, the photo moves into `job.unassigned_photos[]` so the inspector can pick it back up later via a new "From Job" sheet in the observation editor.
5. Camera button hidden when `isRecording === false` — same gate as iOS (`DeepgramRecordingViewModel.swift:1505-1511`).

Behavioural parity with iOS canon end-to-end. Same 60 s window. Same replace-don't-queue semantics. Same EXIF stripping. Same unassigned-pool fallback.

---

## Out of scope

- **Photo annotation / markup UI** — neither platform has this; not in this sprint.
- **Multi-photo queue** — iOS replaces a pending photo on second capture (lines 1551–1553 overwrite the tuple). PWA mirrors. No queue.
- **PDF photo embedding** — observations carry filenames; PDF renders them via the existing image-fetch path. No template change needed.
- **Cross-job photo pool** — `unassigned_photos[]` lives on `JobDetail`. A photo captured against Job A never appears in Job B.
- **Document-extraction photo flow** — separate endpoint, separate use case.
- **Backend changes** — `PUT /api/jobs/:userId/:jobId` already accepts arbitrary fields on the job object; `unassigned_photos[]` round-trips as-is. **Verify in Phase 0** with a curl that adding the field doesn't get stripped (CLAUDE.md immutable-backend rule applies — if it IS stripped, that's a planned cross-platform mandate to bump).
- **Server-side dedupe of pending uploads** — the upload-during-resize race (see Risks §3 below) is handled client-side via local placeholder IDs.

---

## Phase 0 — Decisions (PROPOSED, awaiting Derek confirmation)

Each item below has a recommended option and is binding once Derek signs off.

### 0.1 Time window value

**Recommendation:** 60 seconds — match iOS `observationPhotoLinkWindow = 60.0` (`DeepgramRecordingViewModel.swift:493`). Defined as `OBSERVATION_PHOTO_LINK_WINDOW_MS = 60_000` colocated with `applyObservations` in `apply-extraction.ts`.

**Why match exactly:** iOS chose 60 s empirically — long enough for "take a photo, then describe what it shows" but short enough that cross-observation contamination is rare. Re-tuning on PWA risks the platforms behaving differently from each other in unobvious ways. Easier debugging if the value is one constant on each side.

### 0.2 Pending photo: replace vs queue

**Recommendation:** Replace. iOS overwrites at `:1553` when a second photo arrives before the first attaches. **The replaced photo's bytes are NOT lost** — they've already been uploaded to the server by that point, just orphaned. The new photo becomes the pending candidate.

**Alternative considered:** queue (FIFO list of pending photos). Rejected — adds complexity, diverges from iOS, and inspectors don't actually take a burst of photos waiting for a single observation. Real-world flow is 1:1.

### 0.3 EXIF / GPS stripping

**Recommendation:** Strip. iOS strips via `CGImageDestination`; the PWA canvas redraw approach drops EXIF by default. Free parity.

**Rationale:** GPS in EXIF on a customer-site photo is a privacy issue. Even though we control the server S3 lifecycle, photos sometimes get exported to PDF and emailed to clients — best to never embed GPS in the bytes at all.

### 0.4 Pending state persistence across reload

**Recommendation:** IDB-persisted, per-job, with a 60 s soft TTL.

**Why:** if the inspector hits a Safari refresh during a recording (PWA bug, low battery, accidental tab close), the bytes have been uploaded to the server but the local pending-photo metadata would be lost in memory. Persisting to IDB lets the next page-load reconnect the pending state to an arriving observation. iOS doesn't need this because the view model lives across the recording session; PWA needs it because page reload kills React state.

**Alternative:** in-memory only. Rejected — page reload during recording is a real failure mode, and the IDB schema is already in place (just need a v3 → v4 bump).

### 0.5 Photo button visibility

**Recommendation:** Always-visible cluster, after Doc. Tone `blue`, icon `Camera` (already imported on `recording-chrome.tsx`).

**Alternative:** tablet-only (md+). Rejected — recording is supported on mobile widths (the Obs button is the only tablet-only one because of horizontal-space constraints with that cluster; one more 56 px button fits on a 360 px viewport).

### 0.6 Camera source on iPad

**Recommendation:** `<input type=file accept=image/* capture=environment>` (HTML5 standard). Opens iPad/iPhone Safari camera with rear-camera preference. No library fallback button — if the inspector wants library, they use the standard observation-sheet upload (which is unchanged).

**Why no library fallback on the recording chrome button:** the recording-time button is for "take a photo of what I'm looking at right now". Library access is the wrong UX on a live recording. iOS does expose both (lines 113–121), but that's a SwiftUI sheet decision driven by the existing photo-capture pattern.

### 0.7 Unassigned-photo pool fallback

**Recommendation:** IN SCOPE for this sprint. Adds `JobDetail.unassigned_photos?: string[]`, a write helper in `recording-context.tsx`, and a "From Job" picker in the observation edit sheet (`observation-sheet.tsx`) gated on `job.unassigned_photos?.length > 0`. iOS canon: `Job.swift:100-104`, `JobViewModel.swift:510-525`, `EditObservationSheet.swift:144-156`.

**Why in scope:** without it, expired-pending photos are orphans in S3 with no UI surface. The inspector can't recover them. That's worse than the pre-sprint state because at least the pre-sprint inspector never took the photo in the first place.

**Could split:** if Derek wants to ship faster, Phase 6 (the pool + picker) can be a follow-up — the recording-chrome button + auto-link still works, the recover-orphan path is just missing. But the L2 todo line specifically called out "auto-link within observation window", and the window-expired branch is half the iOS canon.

### 0.8 Paused-session handling

**Recommendation:** Match iOS — only the `isRecording` gate, no separate `isPaused` check (iOS `:1505` is the only guard). A photo captured during a chitchat-pause window still attempts to attach because Sonnet observations could still arrive (chitchat-pause stops *forwarding*, but Sonnet is still authoritative on already-emitted observations).

---

## iOS canon — every reference

Every file:line below is verified by reconnaissance on 2026-05-13. The PWA port mirrors these exactly.

### State (`DeepgramRecordingViewModel.swift`)
- **`:493`** — `static let observationPhotoLinkWindow: TimeInterval = 60.0`
- **`:497`** — `private var pendingObservationPhoto: (data: Data, path: String, timestamp: Date)?`
- **`:499`** — `private var recentObservationId: UUID?`
- **`:500`** — `private var recentObservationTimestamp: Date?`

### `captureObservationPhoto(imageData:)` (`DeepgramRecordingViewModel.swift:1504-1591`)
- **`:1505-1511`** — `guard isRecording else { log + return }` (no fallback UI action; caller does its own upload)
- **`:1513`** — `guard let scaledData = ImageScaler.scale(imageData) else { return }`
- **`:1516-1518`** — write scaled JPEG to temp file at `{jobId}_obs_{UUID}.jpg`
- **`:1522-1549`** — Case B (reverse): if `recentObservationId` within window → append path to that observation's `.photos`, queue visual alert `"Photo added to observation"`, clear recent-state, return
- **`:1552-1556`** — Case A (pending): overwrite `pendingObservationPhoto` tuple, queue visual alert `"Photo captured — say your observation"`
- **`:1564-1575`** — auto-expiry timer: after 60 s, move path into `jobVM.addPhotosToUnassigned([pending.path])`, log `observation_photo_expired_to_pool`
- **`:1582-1590`** — separate Task uploads scaled bytes to API as backup

### `applySonnetObservations` forward-link block (`DeepgramRecordingViewModel.swift:5581-5599`)
- **`:5583-5593`** — if `pendingObservationPhoto` exists and within window → append to LAST observation's `.photos` (Sonnet emits ≤1 obs per turn typically), clear pending state, log `observation_photo_attached_pending`
- **`:5596-5599`** — record `recentObservationId` + `recentObservationTimestamp` for next reverse-link

### Supporting iOS files
- **`JobDetailView.swift:592`** — sole call site: `recordingVM.captureObservationPhoto(imageData: data)` inside `.fullScreenCover(item: $activePhotoMode)`
- **`PhotoCaptureView.swift:32-186`** — `UIImagePickerController` (`.camera`, rear, flash, portrait-locked); library fallback at `:113-121`; JPEG quality 0.85 at `:179`
- **`ImageScaler.swift:65-93`** — max dimension 2048 px, JPEG quality 0.80, EXIF + GPS stripped via `jpegDataStrippingMetadata`
- **`Job.swift:100-104`** — `var unassignedPhotos: [String]?`
- **`JobViewModel.swift:510-525`** — `func addPhotosToUnassigned(_ refs: [String])` — dedupes on add
- **`EditObservationSheet.swift:144-156`** — "From Job" button (only shows when `hasAnyPickableJobPhotos`)
- **`EditObservationSheet.swift:215-238`** — `JobPhotosPickerSheet` presentation, source-aware (`.ccu` / `.unassigned` / `.observation`)

---

## PWA gap audit — every reference

### Recording context (`web/src/lib/recording-context.tsx`)
- **`:289-327`** — current `useState` declarations; observation-photo state will join this block.
- **`:339-346`** — `jobRef.current` + `updateJobRef.current` pattern. Reads/writes go through these refs so the WS callbacks don't depend on stale closures.

### Apply path (`web/src/lib/recording/apply-extraction.ts`)
- **`:843-899`** — `applyObservations` body. The forward-link block (mirror of iOS `:5581-5593`) goes here, immediately after the row is appended.
- **`:1605`** — `applyObservations` called from `applyExtractionToJob`. The forward-link needs access to `pendingObservationPhoto` — passed via a new `options.pendingPhoto?: PendingObservationPhoto` argument.

### Photo upload today (`web/src/components/observations/observation-sheet.tsx`)
- **`:101-126`** — existing `handleFile` for in-sheet uploads. Unchanged by this sprint. The new recording-time path uses a **different code surface** in `recording-context.tsx`, but they share the same backend endpoint and response shape.

### Backend upload endpoint (`web/src/lib/api-client.ts:432-447`)
- `uploadObservationPhoto(userId, jobId, photo)` → `POST /api/job/:userId/:jobId/photos`
- Response: `{photo: {filename, url, thumbnail_url, uploaded_at}}` — `filename` is server-generated and the only field that gets persisted onto `ObservationRow.photos[]`.

### Recording chrome (`web/src/components/recording/recording-chrome.tsx`)
- **`:280-300`** — CCU / Doc / Obs button cluster. Photo button slots between Doc and Obs.
- **`:462-485`** — `ParityButton` signature: `{ label, tone, icon, onClick, disabled?, disabledReason?, ariaPressed?, ariaLabel? }`. Tone palette: `violet | green | orange | cyan | blue`.

### IDB schema (`web/src/lib/pwa/job-cache.ts:56-132`)
- `DB_NAME = 'certmate-cache'`, `DB_VERSION = 3` today.
- Stores: `jobs-list`, `job-detail`, `outbox`, `app-settings`.
- New store: `pending-observation-photo` (keyPath: `jobId`, value: `{ jobId, blobId, filename?, timestamp }`). Migration runs on v3 → v4.
- Helpers: `wrapRequest` / `wrapTransaction` / `wrapTransactionStrict` — use these.

### Wire types
- `web/src/lib/recording/sonnet-session.ts:60-76` — `Observation` wire (no `photos` field — Sonnet never emits photos).
- `web/src/lib/types.ts:330-379` — `ObservationRow.photos?: string[]`. Already exists. Round-trips via `PUT /api/jobs/:userId/:jobId`.

### Constants convention
- `web/src/lib/recording/live-fill-state.ts:49` — `DEFAULT_WINDOW_MS = 3000`. Module-level const, `_MS` suffix. Match pattern: `OBSERVATION_PHOTO_LINK_WINDOW_MS = 60_000` near `applyObservations`.

### Tests pattern
- `web/tests/apply-extraction-observations-parity.test.ts` — `makeJob` / `makeResult` helpers, `it.each`-style table-driven tests. New tests follow this style.

---

## Phase order

Six commits on a single branch `pwa-observation-photo-autolink-2026-05-13`. Order is dependency-driven — earlier commits enable later ones without breaking anything between.

| # | Phase | Files | Risk | Effort |
|---|---|---|---|---|
| 1 | IDB v4 bump + pending-photo store schema | `pwa/job-cache.ts` | Low (migration tested) | 1 hr |
| 2 | `recording-context.tsx` pending-photo state + window constant + helpers | `recording-context.tsx` + new `lib/recording/observation-photo.ts` | Low | 1.5 hr |
| 3 | Forward-link in `applyObservations` | `apply-extraction.ts` + tests | Medium | 2 hr |
| 4 | Image-resize utility + `captureObservationPhoto` handler | new `lib/image-resize.ts`, `recording-context.tsx` | Medium (browser-API quirks) | 2 hr |
| 5 | Recording-chrome `Photo` button | `recording-chrome.tsx` | Low | 0.5 hr |
| 6 | Unassigned-photo pool + "From Job" picker | `types.ts`, `observation-sheet.tsx`, new `components/observations/job-photos-picker-sheet.tsx` | Medium | 3 hr |

**Phase 1 — IDB v4 bump.** Add `STORE_PENDING_PHOTO` constant + `createObjectStore('pending-observation-photo', { keyPath: 'jobId' })` in the upgrade path. Read/write helpers `readPendingPhoto(jobId)` / `writePendingPhoto(record)` / `clearPendingPhoto(jobId)`. **Critical test:** existing v3 user (real Safari profile with cached jobs) upgrades cleanly — no data loss. Use the existing upgrade pattern at `pwa/job-cache.ts:101+`.

**Phase 2 — Context state.** New module-level constant `OBSERVATION_PHOTO_LINK_WINDOW_MS = 60_000`. New `useRef<PendingObservationPhoto | null>(null)` + `recentObservationRef: { id, timestamp } | null`. On mount, read pending-photo from IDB; on every change, debounced-write back. New `captureObservationPhoto(file: File)` function (signature only — handler logic comes in Phase 4). Export `PendingObservationPhoto` type for cross-module use.

**Phase 3 — Forward-link.** In `applyObservations`, after the row-creation block (`apply-extraction.ts:898` area):
```ts
if (options.pendingPhoto && Date.now() - options.pendingPhoto.timestamp < OBSERVATION_PHOTO_LINK_WINDOW_MS) {
  const lastIdx = newRows.length - 1;
  newRows[lastIdx] = { ...newRows[lastIdx], photos: [...(newRows[lastIdx].photos ?? []), options.pendingPhoto.filename] };
  options.onPhotoAttached?.(options.pendingPhoto.blobId); // caller clears pending state
}
```
Caller (`recording-context.tsx` `applyExtractionToJob` site) threads `pendingPhoto` + `onPhotoAttached` callback. Tests: photo within window, photo outside window, photo with no observations (pending stays), two observations in one turn (attaches to last).

**Phase 4 — Capture handler.** New `lib/image-resize.ts`:
```ts
export async function resizeImage(blob: Blob, maxWidth = 2048, quality = 0.80): Promise<Blob>
```
Canvas-based: `createImageBitmap(blob)` → `OffscreenCanvas` if available else `<canvas>` → `canvas.toBlob('image/jpeg', quality)`. EXIF/GPS dropped automatically by canvas redraw. `captureObservationPhoto(file)` flow:
1. Resize.
2. Generate local `blobId` (UUID).
3. Persist `{ jobId, blobId, timestamp, status: 'uploading' }` to IDB.
4. Upload via `api.uploadObservationPhoto`.
5. On success, update IDB record with `filename`; if `recentObservationRef` valid → reverse-link via `updateJob` patch + clear pending; else → keep as pending.
6. On upload failure: drop the IDB record, show error toast.

**Phase 5 — Button.** One new `ParityButton` in `recording-chrome.tsx:280-300` between Doc and Obs. Wires a hidden `<input type=file accept=image/* capture=environment ref={photoInputRef}>` declared at the top of the recording layout. `onClick={() => photoInputRef.current?.click()}`. `onChange` calls into the recording-context `captureObservationPhoto`.

**Phase 6 — Unassigned pool.** TypeScript-level: add `unassigned_photos?: string[]` to `JobDetail` type. Pool helper `addPhotoToUnassignedPool(blobId)` runs on the 60 s expiry timer in `recording-context.tsx`. New `JobPhotosPickerSheet` component (mirrors `EditObservationSheet.swift:215-238`) — three sections: CCU photos, observation photos from OTHER observations on the job, unassigned pool. Source-aware return so the caller can MOVE the photo from `unassigned_photos` to the target observation atomically (not duplicate).

---

## Test plan

### Unit (Phase 2 + 3)
1. `mergePendingPhotoIntoObservations` — within window: attach. Outside: no-op. Empty observations: no-op.
2. `mergePendingPhotoIntoObservations` — two observations in one turn: attach to last only (iOS parity).
3. `mergePendingPhotoIntoObservations` — no `pendingPhoto`: no-op (regression).
4. IDB round-trip: write → read → clear, all three from a single tab.
5. IDB across simulated reload (close + reopen connection): pending photo survives, window TTL respected.

### Integration through `applyExtractionToJob` (Phase 3)
6. Observation arrives 30 s after photo → attaches.
7. Observation arrives 90 s after photo → does NOT attach, pending entry stays for the 60 s grace from now (this is a deliberate iOS divergence — see Risks §4).
8. Observation arrives with existing photos[] → new photo appends, doesn't replace.

### E2E (Phase 4–5)
9. Playwright test: open recording, tap Photo, attach a fixture image, dictate an observation; verify photos[] on the resulting observation.
10. Same but with observation first, photo second within 60 s; reverse-link path.
11. Same but with second photo while first is pending; first photo lands in unassigned_photos.

### Edge (Phase 4)
12. Photo capture during chitchat-pause window: succeeds, attaches to next observation that lands.
13. Photo capture during `recording === 'idle'`: button is disabled (mirror iOS `isRecording` gate).
14. Photo > 10 MB original: resize down to ≤ 2 MB before upload.
15. Photo without EXIF: works (sanity).
16. Photo with GPS EXIF: GPS dropped post-resize (verify via `Exif.parse(resizedBlob)` in test).

---

## Risks

### 1. Upload-during-resize race
**Risk:** observation lands after `recording-context.captureObservationPhoto` returns the resize Promise but before the upload Promise resolves. At that point we have the timestamp + blobId but NOT the server filename — can't write to `observations[i].photos[]`.

**Mitigation:** local placeholder ID. Phase 4 generates a client-side UUID at resize completion. Forward-link writes the placeholder onto `photos[]`. Upload-success handler does a second patch: scan all observations, replace placeholder with filename. Tests pin both orders (upload before observation, observation before upload).

### 2. IDB schema migration
**Risk:** PWA users on v3 already have cached job data. A buggy v3 → v4 upgrade could nuke the cache.

**Mitigation:** the v4 upgrade ONLY adds a new object store. Existing stores untouched. Standard IndexedDB upgrade pattern. Test against a populated v3 fixture (write some v3 data first, then bump to v4, then read).

### 3. `unassigned_photos[]` backend round-trip
**Risk:** the backend's `PUT /api/jobs/:userId/:jobId` validates against a known field set somewhere. Adding an undeclared field might get stripped silently.

**Mitigation:** Phase 0 verification — a one-off `curl` to staging or local backend confirming `unassigned_photos` appears on a subsequent GET. If it gets stripped, we have a planned cross-platform mandate (CLAUDE.md exception path) — bump it to backend work first.

### 4. Window-expired-with-stale-state divergence
**Risk:** iOS clears `pendingObservationPhoto` and moves the path to `unassignedPhotos` on the 60 s timer. PWA's IDB-backed state might keep an "expired" record around if the user closes the tab during the recording — on the next page load, the entry exists but is past TTL.

**Mitigation:** on `readPendingPhoto`, check `Date.now() - record.timestamp > LINK_WINDOW_MS + GRACE_MS`. If past grace (10 s), upgrade to unassigned pool immediately and return null. Grace covers clock skew on the iPad if it was offline + just came back.

### 5. iPad Safari `capture=environment` flakiness
**Risk:** historical iOS Safari builds have ignored the `capture` attribute and opened a picker instead. As of iOS 17 it's reliable but worth verifying.

**Mitigation:** test on the actual deploy target (iPad iOS 17+). If it doesn't open the camera, we fall back to a regular file picker — same UX as the existing observation-sheet upload. No code change, just user expectation.

### 6. Photo button visible during the no-recording state
**Risk:** mirror iOS — disabled when `!isRecording`. The button still RENDERS so the chrome doesn't reflow on recording start/stop, but the `onClick` is a no-op.

**Mitigation:** `<ParityButton disabled={!isRecording} disabledReason="Start a recording to capture observation photos">` — uses the existing disabled-tooltip pattern that the other chrome buttons already use.

---

## Cross-platform considerations

- **Backend is shared with iOS and SHOULD NOT change.** Adding `unassigned_photos[]` to the job object is the only border-touching piece. iOS already writes this field today (`JobViewModel.swift:510-525`). Backend already accepts it (it would never have round-tripped on iOS otherwise). Confirmed safe.
- **PDF rendering** (`Sources/PDF/EICRHTMLTemplate.swift` + `web/src/lib/pdf/` if applicable): `observations[].photos[]` is the only field consumed. Filename → CGImage / `<img>` lookup. Unchanged by this sprint.
- **Cross-platform field test:** during the field-test phase, take a photo on the PWA, observe that the iOS app's job-detail view sees the same observation with the same photo attached. Verifies the wire round-trip.

---

## Field-test runbook (Phase 7)

Once all six commits land, run on a real iPad:

1. **Forward-link.** Start recording. Tap Photo. Attach a fixture (have the inspector point at a socket and snap). Dictate: *"C2 observation on circuit 3 — exposed cable in cupboard."* Verify the observation row in the schedule shows a photo thumbnail.

2. **Reverse-link.** Start recording. Dictate the observation FIRST. Within 60 s, tap Photo and capture. Verify the same attachment.

3. **Window expiry.** Start recording. Tap Photo. Wait 70 s. Dictate observation. Verify the photo is NOT attached — instead, it appears in the new "From Job" picker on the observation edit sheet, under an "Unassigned" section.

4. **Cross-platform.** Repeat (1) on PWA. Close PWA, open iOS app on the same job. Verify the observation shows the photo on iOS too.

5. **Reload mid-recording.** Start recording, tap Photo, then refresh Safari mid-recording. Reopen the job. Start a new recording, dictate the observation within 60 s. Verify the photo (which had been uploaded before the refresh) still auto-attaches because the IDB pending entry survived.

---

## What to verify in Phase 0 BEFORE writing code

1. `unassigned_photos[]` actually round-trips via the backend. One `PUT` + one `GET` against staging confirms this.
2. iPad Safari `capture=environment` opens the camera on the latest iPadOS — not just shows a picker.
3. Derek confirms the 7 decisions in §0 above (or proposes alternatives).

If any of those three fail, this plan needs revision before code lands.
