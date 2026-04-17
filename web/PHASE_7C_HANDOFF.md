# Phase 7c — Offline mutation outbox + replay worker (handoff)

> Web rebuild · branch `web-rebuild` · Phase 7b closed at `1ec4e22` (iOS
> Add-to-Home-Screen hint).

## Objective

Close the most painful scope exclusion from Phase 7b: **offline edits
still vanish**. When an inspector changes a field on-site with no
connectivity, the raw `api.saveJob` rejects and the edit is lost. Phase
7c captures each mutation in IndexedDB before the network attempt,
replays the queue the moment connectivity returns, and preserves FIFO
ordering across retries so per-field last-writer-wins semantics match
iOS.

7c ships the **mechanism** only — the queue, the wrapper, the replay
worker. UI polish (pending-count badges, conflict dialogs, poisoned-row
admin screen) is intentionally deferred to Phase 7d. Keeping the
mechanism commit compact is a correctness guarantee: a busted outbox
corrupts user data, and a focused diff is the only way to review the
replay loop end-to-end.

## What shipped

Single commit — mechanism only. No UI surface changes.

### New

- `web/src/lib/pwa/outbox.ts` — vanilla-IDB mutation store. Exports:
  - `OutboxMutation` type (`{id, op, userId, jobId, patch, createdAt, attempts, nextAttemptAt, lastError?, poisoned?}`).
  - `enqueueSaveJobMutation(userId, jobId, patch)` — appends one row, returns the stored record. **Throws on IDB failure** (unlike the read cache's best-effort swallow) — a missed queue write silently drops user edits, which is the exact failure mode 7c exists to prevent.
  - `listPendingMutations()` — non-poisoned rows sorted `createdAt` ascending. FIFO order is a correctness guarantee for per-field last-writer-wins (see "Conflict model" below).
  - `removeMutation(id)` — after a successful replay. Idempotent so two tabs racing to drain can't error each other out.
  - `markMutationFailed(id, error)` — read-modify-write in a single transaction so parallel-tab retries can't drift the attempts counter from reality. Applies exponential backoff (2^(n-1) × 2s, capped 5 min) and poisons after `MAX_ATTEMPTS = 10` consecutive failures.
  - `purgeOutbox()` — wipes the whole store. Exposed for ops even though 7c only uses it transitively through `clearJobCache()`.
- `web/src/lib/pwa/queue-save-job.ts` — write-path wrapper. Order matters:
  1. Enqueue to outbox **first**. If this throws, bubble it — durability is broken.
  2. Fire `api.saveJob` best-effort. 4xx is re-thrown (persistent rejection; the caller needs to unwind optimistic UI). Network / 5xx returns `{queued: true, synced: false}` and leaves the row for the worker.
  3. On 2xx, remove the row and refresh the IDB read cache (either via `opts.optimisticDetail` or a cached-doc read-modify-write).
- `web/src/lib/pwa/outbox-replay.ts` — `useOutboxReplay()` hook. Four trigger surfaces: mount-time pass, window `online` event, `visibilitychange → visible`, and self-reschedule on `setTimeout` to the earliest `nextAttemptAt`. Serialised via `runningRef` so parallel triggers coalesce. Stops the batch on first failure (captive-portal symmetry + FIFO correctness).

### Modified

- `web/src/lib/pwa/job-cache.ts`:
  - Bumped `DB_VERSION` 1 → 2. `onupgradeneeded` adds the `outbox` store (`keyPath: 'id'`, `by-user` index on `userId`) additively — existing `jobs-list` / `job-detail` data is preserved across the upgrade via the universal `!contains()` pattern rather than version-gating with `event.oldVersion`.
  - Exported `openDB`, `wrapRequest`, `wrapTransaction`, `isSupported`, `DB_NAME`, `STORE_OUTBOX`, `OUTBOX_INDEX_BY_USER` so `outbox.ts` + future Phase 7d UI can reuse them. Keeps schema ownership in one place instead of duplicating the open/wrap boilerplate across two files.
  - Extended `clearJobCache()` to also clear the `outbox` store on sign-out. Documented decision: we nuke the whole outbox (not just the signing-out user's rows) for symmetry with the read-cache wipe and because replaying a pending mutation under the wrong user's auth would be far worse than losing a pending edit. See "Shared-device safety" below.
- `web/src/components/layout/app-shell.tsx` — mounted `useOutboxReplay()` on the auth-gated layout boundary. The hook is a no-op when the outbox is empty (single `getAll()` ~<1ms), so there's no cost to remounting it on every auth-gated navigation.

### Not modified (deliberate)

- `web/src/lib/job-context.tsx` — `JobProvider.updateJob` still does only the in-memory merge. **No caller of `queueSaveJob` exists yet.** Phase 4's debounced-save flush is the intended first consumer; when it lands it should call `queueSaveJob(userId, jobId, patch, { optimisticDetail: mergedJob })` in place of the raw `api.saveJob`. Wiring it now would be speculative per CLAUDE.md §"Don't design for hypothetical future requirements" — the mechanism lands here so the consumer doesn't need to reinvent it.
- `web/src/components/pwa/offline-indicator.tsx` — no pending-count badge. That's 7d.
- No new route, no new page. Mechanism-only.

## Verification

```
export PATH="/opt/homebrew/bin:$PATH"
npx tsc --noEmit                    # clean (main)
npx tsc --noEmit -p tsconfig.sw.json # clean (service worker)
npm run lint                         # 0 errors, 6 pre-existing warnings (unchanged from 7b)
npm run build                        # succeeds; public/sw.js emitted; all 25 routes intact
```

### DevTools walkthrough (Chrome, production build via `npm start`)

1. **Application → IndexedDB → `certmate-cache`** — three stores: `jobs-list`, `job-detail`, `outbox` (new). Version 2.
2. **Manual enqueue test** (simulates a Phase 4 caller):
   ```js
   // In the DevTools console on an authenticated page:
   const { queueSaveJob } = await import('/_next/static/chunks/…/queue-save-job.js');
   await queueSaveJob('<userId>', '<jobId>', { certificate_type: 'EIC' });
   // Expect: no network error, no outbox row (synced inline).
   ```
3. **Offline enqueue test**:
   - DevTools → Network → Offline.
   - Run `queueSaveJob(...)` as above. Expect `{queued: true, synced: false}`.
   - IDB → `outbox` → one row with `attempts: 0`, `nextAttemptAt ≈ createdAt`.
   - Network → Online. Within 1s, the row should disappear (replay worker fires on `online`).
4. **Exponential backoff test**:
   - Offline enqueue. Reload the tab.
   - Go back online. The worker will fire `api.saveJob`; if the server 500s (e.g. backend down), the row stays with `attempts: 1`, `nextAttemptAt: now + 2s`, `lastError: "HTTP 500: …"`.
   - Next attempt waits 4s, then 8s, ..., capped at 5 min.
   - After 10 failures: `poisoned: true`, row is skipped by the worker.
5. **Sign-out purge** — with a pending outbox row, tap Sign out. IDB → `outbox` is empty immediately after redirect to `/login`.

### Replay-ordering test (FIFO correctness)

1. Offline → enqueue mutation A: `{certificate_type: 'EICR'}`.
2. Offline → enqueue mutation B: `{certificate_type: 'EIC'}`.
3. Online. Worker drains A first, then B. Server final state: `certificate_type: 'EIC'`.
4. If the order inverted (B then A), the server would end on `'EICR'` — wrong. The FIFO guarantee (IDB sort + stop-on-failure) prevents this.

## Scope exclusions (deferred to 7d)

- **Pending-count badge on `<OfflineIndicator />`.** The handoff recommendation is still a secondary dot on the existing amber pill rather than a separate `<SyncIndicator />` — fewer chrome elements, same information.
- **"Saved locally / pending sync" chips per job row.** Phase 7d.
- **Poisoned-row admin UI.** Phase 7d should surface poisoned rows with options: discard, re-queue (resets `attempts` + `poisoned`), or edit the patch.
- **Conflict dialog.** 7c's conflict model is last-writer-wins per-field (matches iOS `APIClient.saveJob`). A real conflict UI would need per-field base versions that the backend doesn't yet emit — an out-of-scope backend change.
- **Per-user outbox purge on sign-out.** Currently `clearJobCache()` nukes the whole outbox; see "Shared-device safety" below for the documented trade-off.
- **First consumer** — `JobProvider`'s debounced save effect doesn't exist yet (Phase 4 shipped recording + extraction but stopped before save flush). When it lands it should call `queueSaveJob` rather than `api.saveJob` directly, in the same commit that introduces the save flush.
- **New `op` kinds beyond `saveJob`.** The `OutboxOp` type is a union with a single variant today. Future ops (delete observation, upload media) can extend it; the replay worker's `switch` on `m.op` is ready to accept new branches.
- **Service-worker-driven Background Sync API.** Would let the queue drain while the tab is closed. Not in 7c — Safari doesn't support it and the additional complexity isn't justified by the visit-frequency of an inspector's open tab.

## Design decisions (nailed down here so 7d doesn't have to re-litigate)

### Conflict model — last-writer-wins per field

`api.saveJob` is a PATCH that only carries dirty fields. When the
replay worker retries, the server merges the patch into whatever
current state it holds. Two inspectors editing the same job from
different clients converge on a per-field last-writer-wins doc — same
semantics as iOS. A full conflict-surface UI would need per-field base
versions that the backend doesn't currently emit; adding that machinery
is a far larger scope than the offline-tolerance 7c promises. Revisit
if real-world conflict frequency proves problematic.

### Shared-device safety — nuke-everything on sign-out

The handoff posed two options: purge only the signing-out user's rows,
or wipe the whole outbox on every sign-out. We chose the latter because:

- A pending mutation from user A replayed under user B's auth token
  would corrupt data under B's name — far worse than losing a pending
  edit.
- Inspector workflow is single-user-per-device in practice (company-
  issued tablet or personal phone), so the data-loss exposure is
  minimal.
- Symmetric with `clearJobCache()`'s existing behaviour on
  `jobs-list` / `job-detail` — the cache is already user-scoped via
  `userId` keys but gets wiped wholesale anyway, because the exposure
  model is the same.

The `by-user` index on the outbox exists for a future per-user purge
path if real-world use proves we need one — it's cheap to create
during initial schema creation, far more expensive to add after the
fact (another version bump).

### Why NOT run the worker at root layout

The obvious alternative is mounting `useOutboxReplay()` at
`src/app/layout.tsx` alongside `InstallPromptProvider` and
`SwUpdateProvider`. Rejected because:

- Root layout renders on `/login` + public routes, where the user
  has no auth token. The hook would need a token-check gate, which
  duplicates logic already enforced at AppShell's layout boundary.
- Remounting the hook on auth-gated navigation is essentially free
  (single IDB `getAll()` on mount, no network call if empty).
- Keeping PWA surface-area providers at the root and auth-dependent
  plumbing inside AppShell makes future teardown cleaner (e.g. if we
  ever SSG a marketing page, nothing auth-ish leaks in).

### Why stop the batch on first failure

- **Captive portals / DNS hijack**: when the first request fails, the
  next nine are overwhelmingly likely to fail the same way. Pushing
  through would 10× the attempt counter increment on every affected
  row, accelerating poisoning for rows that are fine in isolation.
- **FIFO correctness**: per-field last-writer-wins requires strict
  in-order replay. Skipping a failure and continuing could invert
  order (e.g. A fails, B succeeds, A later succeeds — server ends on
  A's state, but the user expected B's to win because it was enqueued
  later). Stopping on failure preserves the invariant.
- **Backoff coherence**: all affected rows share the same underlying
  outage, so they should all wait the same cooldown. Stopping means
  only the first row's `nextAttemptAt` advances; the rest stay
  eligible, and the next trigger can retry them together once the
  outage clears.

### Why MAX_ATTEMPTS = 10

Exponential backoff 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, then
capped at 5 min for attempts 9 + 10 = 18 minutes of wall-clock retry
tolerance. That weathers a typical outage without retaining a
permanently broken mutation (e.g. a patch that references a deleted
foreign key) that'll 4xx forever. Poisoned rows are preserved for the
Phase 7d admin UI to surface — silent discard is ruled out as user-
data loss.

## Kickoff checklist for 7d

Before shipping any 7d feature:

1. **Decide on the surface.** Recommendation: secondary indicator on
   the existing `<OfflineIndicator />` — a small blue dot (not red)
   overlapping the amber pill when `listPendingMutations().length > 0`.
   Tooltip: "N pending edits — will sync when online". Click opens a
   drawer listing poisoned rows with discard / re-queue actions.
2. **Per-row UI.** Job cards on `/dashboard` get a subtle "pending
   sync" chip when any mutation for that `jobId` is in the outbox.
   Phase 7b already has the dashboard SWR hook — add a
   `listPendingMutations()` read alongside it (gated on an
   `online === false || outbox-changed` signal).
3. **Poisoned-row admin UI.** A `/settings/system` page (system-admin
   only? or show to every user for their own rows?) that surfaces
   `{listPendingMutations, listPoisonedMutations, discardMutation,
   requeueMutation}`. Backend isn't involved — these are all local
   IDB operations.
4. **Toast on first successful replay after being offline.** The
   existing Serwist `reloadOnOnline: true` already reloads the page
   when the browser fires `online`. 7d could instead show a sonner
   success toast once all pending mutations drain, rather than a
   full reload (which loses any in-progress edits).
5. **Wire `queueSaveJob` into the debounced save path.** Phase 4 or
   its successor should land the debounced flush in the same commit
   as the consumer call; this handoff does NOT ship that wiring.

## Known good commit to branch from

`1ec4e22` → *Phase 7b close* → **`<Phase 7c commit hash>`** → Phase 7d
branches from here.
