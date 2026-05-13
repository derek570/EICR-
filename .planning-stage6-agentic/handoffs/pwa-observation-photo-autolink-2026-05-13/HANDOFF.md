# PWA Observation-Photo Auto-Link — Fresh-Context Handoff

**Read this first** in a new session. Full plan in sibling [`PLAN.md`](PLAN.md) (~530 lines, refer as needed).
Drafted 2026-05-13.
Status: **Planned. Decisions PROPOSED, not locked. No code yet.**

---

## What this is

Closing the lone behaviour-shaped gap from the 2026-05-12 PWA-parity audit. Inspectors on iPad need to be able to take an observation photo *during* a voice recording and have it auto-link to the nearest-in-time Sonnet observation — same as iOS has done since at least 2026-04-22.

Today on PWA: photos can ONLY be attached by opening the observation sheet and uploading from there. There is no recording-time camera button at all. The "CCU" / "Doc" / "Obs" buttons on `recording-chrome.tsx:280-300` all just navigate to other tabs.

After this sprint: a sixth button (**Photo**) appears alongside CCU/Doc/Obs. Tap it → iPad camera opens via standard HTML5 `<input type=file accept=image/* capture=environment>` → photo resizes locally to ≤ 2048 px at JPEG 0.80 (EXIF + GPS stripped, iOS parity) → uploads to the existing `/api/job/:userId/:jobId/photos` endpoint → auto-links to a recent observation if one exists within 60 s, OR enters a pending slot for the next observation to claim, OR moves into a new `job.unassigned_photos[]` pool after 60 s where the inspector can recover it via a "From Job" picker on the observation edit sheet.

Behavioural parity with iOS canon end-to-end.

---

## What you need to know cold

### iOS already does this; PWA doesn't

iOS canon entry points (verified 2026-05-13 by reconnaissance):
- **State** lives on `DeepgramRecordingViewModel.swift:493-500` — one static `observationPhotoLinkWindow: TimeInterval = 60.0`, three private vars (`pendingObservationPhoto` tuple, `recentObservationId`, `recentObservationTimestamp`).
- **Capture flow** at `DeepgramRecordingViewModel.swift:1504-1591` — `captureObservationPhoto(imageData:)`. Gates on `isRecording`, scales bytes, writes temp file, tries Case B reverse-link first (recent observation within window) then falls through to Case A (pending tuple + 60 s expiry timer that moves to `unassignedPhotos`).
- **Forward-link** at `DeepgramRecordingViewModel.swift:5581-5599` — inside `applySonnetObservations`. After appending the new observation, scans `pendingObservationPhoto`, attaches to LAST observation if within window, clears pending state, records new `recentObservationId` + timestamp.
- **Storage** — `Observation.photos: [String]?` (filenames). `Job.unassignedPhotos: [String]?` (`Job.swift:100-104`). Both round-trip via the existing job save endpoint.

### PWA architecture relevant to this sprint

- **`recording-context.tsx`** is where the WS handlers + jobRef + updateJob refs all live (`:289-346`). New state (`pendingPhotoRef`, `recentObservationRef`) goes here.
- **`apply-extraction.ts:843-899`** has `applyObservations` — the right place to put the forward-link block (mirrors iOS `:5581-5599`).
- **`pwa/job-cache.ts:56-132`** has the existing IDB schema at v3. Adding a `pending-observation-photo` store needs a v3 → v4 bump (only adds a new object store, doesn't touch existing data — low risk).
- **`recording-chrome.tsx:280-300`** has the CCU / Doc / Obs button cluster. Photo button slots after Doc. `ParityButton` signature at `:462-485`.
- **No client-side image-resize utility exists yet.** Phase 4 adds `lib/image-resize.ts` (canvas-based, no new dependency).
- **Upload endpoint** `api.uploadObservationPhoto` is already wired (`api-client.ts:432-447`) — same path used by the in-sheet upload today. Returns `{photo: {filename, ...}}`. Filename is what gets persisted.

### Backend is shared and IMMUTABLE for this sprint

Per CLAUDE.md, the backend (`src/`, RDS, S3) is shared with iOS and must not change during PWA-only work. The new `unassigned_photos[]` field on the job object already round-trips today (iOS writes it). Phase 0 verifies this with a `curl` round-trip. If verification fails, the plan needs revision before code starts — bumping it to cross-platform work first.

---

## Locked decisions (PROPOSED — Derek to confirm before Phase 1)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| **0.1** Time window | **60 seconds**, constant `OBSERVATION_PHOTO_LINK_WINDOW_MS = 60_000` | Match iOS exactly. Re-tuning risks platforms diverging. |
| **0.2** Pending photo | **Replace, not queue** | iOS overwrites at `:1553`. Real-world flow is 1:1. Queue adds complexity for no benefit. |
| **0.3** EXIF/GPS stripping | **Strip** | Canvas redraw drops it for free. Customer-site GPS in PDF would be a privacy issue. |
| **0.4** Reload persistence | **IDB-backed** | iOS doesn't need this (VM survives); PWA does (page reload kills React state). v3 → v4 bump. |
| **0.5** Photo button | **Always visible, after Doc, tone `blue`** | iPad and mobile both record; one more 56 px button fits a 360 px viewport. |
| **0.6** Camera source | **HTML5 `capture=environment`** only, no library fallback | Recording-time button is "snap what I'm looking at"; library is wrong UX during a live record. |
| **0.7** Unassigned pool fallback | **IN SCOPE** — adds `JobDetail.unassigned_photos`, helper, and "From Job" picker on observation edit sheet | Without it, expired-pending photos become S3 orphans with no UI surface. iOS canon: `Job.swift:100-104`, `EditObservationSheet.swift:144-156`. |
| **0.8** Paused-session handling | **No `isPaused` gate** — match iOS, only `isRecording` matters | Sonnet observations can still arrive during chitchat-pause; the auto-link logic stays correct. |

Each could split as a follow-up if Derek wants to ship faster — see "Could split" notes inside PLAN.md §0.

---

## Deal-breakers / verified gotchas

These are the three things any naive implementation would get wrong. Each has a mitigation in PLAN.md §Risks.

1. **Upload-during-resize race.** PWA uploads are async; iOS writes to local temp file then attaches by path. PWA can't write the eventual server filename onto an observation that lands while the upload is in flight. → Use a client-side placeholder UUID at resize completion; rewrite to the real filename on upload success. Tests cover both orderings.

2. **IDB v3 → v4 migration must be additive only.** Existing PWA users have populated v3 caches. The v4 upgrade adds ONE new object store (`pending-observation-photo`, keyPath `jobId`). Touches nothing else. Test against a populated v3 fixture before merge.

3. **`unassigned_photos[]` backend round-trip not verified.** iOS writes the field today; the assumption is the backend round-trips it untouched (it doesn't have a strict field allowlist on the job-save endpoint). **Phase 0 must verify with curl** before any code lands. If it gets stripped, this becomes a cross-platform mandate — backend work needs to land first (then this sprint can resume).

Plus two iPad Safari quirks that aren't deal-breakers but worth catching in test:
- `capture=environment` reliably opens the camera on iOS 17+. Older iPadOS opens a picker. Test on the deploy target.
- Mid-recording Safari reload during photo capture is a real failure mode. The IDB-backed pending state covers it; verify in field test (PLAN.md §Field-test runbook step 5).

---

## Phase order

Six commits on a single branch `pwa-observation-photo-autolink-2026-05-13`:

| # | Phase | Files | Risk | Effort |
|---|---|---|---|---|
| 1 | IDB v4 bump + pending-photo store schema | `pwa/job-cache.ts` | Low | 1 hr |
| 2 | `recording-context.tsx` state + helpers (no UI yet) | `recording-context.tsx`, new `lib/recording/observation-photo.ts` | Low | 1.5 hr |
| 3 | Forward-link in `applyObservations` | `apply-extraction.ts` + tests | Medium | 2 hr |
| 4 | Image-resize + `captureObservationPhoto` handler | new `lib/image-resize.ts`, `recording-context.tsx` | Medium (browser-API quirks) | 2 hr |
| 5 | Photo button on recording chrome | `recording-chrome.tsx` | Low | 0.5 hr |
| 6 | Unassigned pool + "From Job" picker | `types.ts`, `observation-sheet.tsx`, new `components/observations/job-photos-picker-sheet.tsx` | Medium | 3 hr |

Phases 1–5 form a usable feature; Phase 6 is the recovery path for expired-pending photos. Could split Phase 6 to a follow-up sprint if shipping faster matters more than orphan-recovery UX (PLAN.md §0.7).

---

## First commit to make

Once Phase 0 is signed off:

```bash
git checkout -b pwa-observation-photo-autolink-2026-05-13
```

Open `web/src/lib/pwa/job-cache.ts`:
- Bump `DB_VERSION = 3` → `DB_VERSION = 4`.
- Add `const STORE_PENDING_PHOTO = 'pending-observation-photo'`.
- In the `onupgradeneeded` handler (around line 101+), add an additive branch:
  ```ts
  if (event.oldVersion < 4 && !db.objectStoreNames.contains(STORE_PENDING_PHOTO)) {
    db.createObjectStore(STORE_PENDING_PHOTO, { keyPath: 'jobId' });
  }
  ```
- Export three new helpers: `readPendingPhoto(jobId): Promise<PendingObservationPhotoRecord | null>`, `writePendingPhoto(record)`, `clearPendingPhoto(jobId)`.
- Add a unit test in `tests/pwa-pending-photo-store.test.ts` mirroring `tests/pwa-job-cache.test.ts`'s style (use `fake-indexeddb`).

Commit message: `feat(pwa): IDB v4 — add pending-observation-photo store (L2 phase 1)`.

After Phase 1 is green, follow PLAN.md §Phase order for the rest.

---

## Anti-patterns to avoid

1. **Don't pile this into `observation-sheet.tsx`.** That sheet is for the in-sheet editing flow and stays unchanged. The recording-time path is a separate code surface in `recording-context.tsx`.
2. **Don't queue pending photos.** iOS replaces. Match. (Why is in PLAN.md §0.2.)
3. **Don't gate on `isPaused`.** iOS doesn't (only `isRecording`). Match. (PLAN.md §0.8.)
4. **Don't skip the resize step.** Upload of a full-res iPad photo is ~12 MB and stalls on cellular. Resize first.
5. **Don't bump IDB version for any reason other than adding the new store.** Existing v3 data is load-bearing for the Phase 7b read-through cache.
6. **Don't introduce a new server endpoint.** The existing `POST /api/job/:userId/:jobId/photos` is the right thing — it's what the observation-sheet already calls.
7. **Don't add `photos` to the Sonnet wire `Observation` type** (`sonnet-session.ts:60-76`). Sonnet doesn't emit photos. Photos enter `ObservationRow.photos[]` from the client only.

---

## When to stop and ask

- **Phase 0 verification of `unassigned_photos[]` round-trip fails.** Stop. Backend work needed first.
- **iPad Safari `capture=environment` shows a picker instead of camera on iPadOS 17+.** Stop. Re-decide camera source.
- **Resizing a 12 MB iPad photo via `<canvas>` takes >2 s on iPad Air 4.** Slow path — consider OffscreenCanvas + Web Worker. Plan-revision time.
- **Backend rejects `unassigned_photos[]` array of length > N** — verify in Phase 0; if N exists, document it.

---

## Reference index

| What | Where |
|---|---|
| iOS state declarations | `DeepgramRecordingViewModel.swift:493-500` |
| iOS capture handler | `DeepgramRecordingViewModel.swift:1504-1591` |
| iOS forward-link | `DeepgramRecordingViewModel.swift:5581-5599` |
| iOS unassigned pool | `Job.swift:100-104` + `JobViewModel.swift:510-525` |
| iOS "From Job" picker | `EditObservationSheet.swift:144-238` |
| iOS image scaling | `ImageScaler.swift:65-93` |
| PWA recording context | `recording-context.tsx:289-346` |
| PWA observation apply | `apply-extraction.ts:843-899` |
| PWA observation sheet | `observation-sheet.tsx:101-126` |
| PWA upload endpoint | `api-client.ts:432-447` |
| PWA recording chrome | `recording-chrome.tsx:280-300` (cluster), `:462-485` (ParityButton) |
| PWA IDB schema | `pwa/job-cache.ts:56-132` |
| PWA wire observation | `sonnet-session.ts:60-76` |
| PWA observation row | `types.ts:330-379` |
| PWA window constants convention | `recording/live-fill-state.ts:49` |
| PWA test pattern | `tests/apply-extraction-observations-parity.test.ts` |
