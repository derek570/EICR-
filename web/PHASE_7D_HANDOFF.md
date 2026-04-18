# Phase 7d — Offline-sync UI polish (handoff)

> Web rebuild · branch `web-rebuild` · Phase 7c closed at the
> mechanism-only outbox commit (see `PHASE_7C_HANDOFF.md`).
> Phase 7d closes Phase 7.

## Objective

Phase 7c shipped the offline mutation outbox + replay worker as a
headless mechanism — the queue worked, but the UI had no idea it
existed. An inspector editing a field offline saw nothing that told
them the edit was durable; a poisoned row (permanent 4xx) was
invisible until they or an engineer opened DevTools.

Phase 7d wires the user-facing surface on top of the 7c mechanism:

1. **OfflineIndicator cluster** — the amber offline pill now carries
   a blue pending-count dot when the outbox has rows, plus two
   sibling pills that can appear even while online: a blue "Syncing
   N" indicator while the replay worker is draining, and a red
   "Failed N" link-pill that deep-links to the admin page when any
   row is poisoned.
2. **JobRow "Pending" chip** — dashboard job cards render a small
   blue chip between the cert/date line and the status pill when
   any mutation for that `jobId` is still in the outbox (pending or
   poisoned). Tells the inspector at a glance which jobs still have
   unsynced edits.
3. **`/settings/system` admin page** — the first route where an
   inspector can see pending + poisoned rows, discard edits they no
   longer want, and re-queue rows whose underlying server-side cause
   has been resolved.
4. **Settings hub link** — the "Offline Sync" card only appears in
   `/settings` when the local outbox has work to do. Hidden in the
   99% of sessions where everything's synced so the hub stays calm.

## What shipped

Single commit, pure UI + two small helpers on the outbox module.
No backend changes. No new Phase 7c mechanism changes.

### New

- `web/src/lib/pwa/use-outbox-state.ts` — `useOutboxState()` hook.
  Returns `{pending, poisoned, pendingJobIds, loading, refresh}`.
  Refresh triggers: mount, `subscribeOutboxChanges` (both same-tab
  local bus and cross-tab `BroadcastChannel`), and
  `visibilitychange → visible` (covers the case where the replay
  worker drained rows while the tab was backgrounded).
- `web/src/app/settings/system/page.tsx` — admin page listing
  pending + poisoned rows. Discard button on every row (two-step
  `window.confirm` — this is the only data-loss path in the rebuild
  and the confirm is cheap insurance). Retry button on poisoned
  rows only. Patch payload rendered as truncated JSON (≤ 240 chars)
  so the inspector can read what they queued. Not role-gated — any
  authenticated user can manage their own device's queue.

### Modified

- `web/src/lib/pwa/outbox.ts`:
  - Added change-notification pub/sub: `subscribeOutboxChanges(fn)`
    subscribes, every write (enqueue / remove / markFailed /
    markPoisoned / requeue / discard / purge) notifies.
    Dual-channel: local `EventTarget` bus (because
    `BroadcastChannel` doesn't fire in the sender tab) +
    `BroadcastChannel('certmate-outbox')` for cross-tab sync
    (admin page in tab A picks up a discard from tab B).
  - Added `discardMutation(id)` — user-initiated deletion, same
    IDB write as `removeMutation` but separately exported so
    future instrumentation can tell discards from replay-success
    removes without a flag-threading dance.
  - Added `requeueMutation(id)` — clears poison flag + resets
    `attempts` to 0 + sets `nextAttemptAt: Date.now()` so the
    replay worker picks it up on its next trigger. Preserves
    `lastError` so the admin UI can show the prior failure if it
    poisons again immediately.
- `web/src/components/pwa/offline-indicator.tsx` — promoted from a
  single amber pill to a cluster of up to three pills. Keeps the
  `OfflineIndicator` export name so no import sites need touching.
  Render matrix:
  - Offline + no pending → amber "Offline" pill (unchanged from 7b).
  - Offline + pending > 0 → amber pill with a small absolute-
    positioned blue dot in the top-right corner. Pure overlay, no
    additional horizontal space, matches the 7c handoff's stated
    design preference.
  - Online + pending > 0 → blue "Syncing N" pill. Drains on its
    own as the replay worker ships each row.
  - Poisoned > 0 (regardless of online) → red "Failed N" link-pill
    to `/settings/system`. Keyboard-reachable via Tab; full count
    is in the accessible name so screen readers don't have to
    infer it from the tiny glyph.
- `web/src/components/dashboard/job-row.tsx` — added optional
  `pendingSync` prop. When true, renders a blue chip with a
  cloud-upload glyph between the cert/date line and the job status
  pill. Deliberately separate from the backend status pill so
  "offline sync state" can't be confused with
  "backend job lifecycle" (pending / processing / done / failed).
- `web/src/app/dashboard/page.tsx` — `useOutboxState()` on mount;
  passes `pendingSync={pendingJobIds.has(j.id)}` to every `JobRow`.
- `web/src/app/settings/page.tsx` — conditionally renders the new
  "OFFLINE SYNC" section (one LinkCard to `/settings/system`) when
  `useOutboxState()` reports any pending or poisoned rows. Subtitle
  switches between "N pending edits waiting to sync" and
  "N failed · N pending" based on whether poisoned rows exist.

### Not modified (deliberate)

- `web/src/lib/pwa/outbox-replay.ts` — already calls the outbox
  writes that are now instrumented to notify, so the replay path
  auto-wires into the UI without a code change. Verified end-to-end
  in the DevTools walkthrough below.
- `web/src/lib/pwa/queue-save-job.ts` — same rationale.
- `web/src/lib/pwa/job-cache.ts` — schema (DB v2) is unchanged. No
  new stores, no new indexes.
- `web/src/components/layout/app-shell.tsx` — no change. The
  `OfflineIndicator` import was the header's single entry point
  for this whole cluster; extending the component in place kept the
  change local.

## Verification

```bash
cd web
export PATH="/opt/homebrew/bin:$PATH"
npx tsc --noEmit                      # clean
npx tsc --noEmit -p tsconfig.sw.json  # clean
npm run lint                          # 0 errors, 6 pre-existing warnings (unchanged from 7c)
npm run build                         # succeeds; /settings/system shows in the route table
```

### DevTools walkthrough (Chrome, production build)

1. **Application → IndexedDB → `certmate-cache` → `outbox`** — same
   schema as 7c (DB v2, three stores). No migration.
2. **Pending UI flow**:
   - DevTools → Network → Offline.
   - On `/dashboard`, edit a field on a job (once Phase 4's
     debounced save wires `queueSaveJob` in — until then, enqueue
     manually from the console: `(await import('…/queue-save-job.js')).queueSaveJob(userId, jobId, {certificate_type: 'EIC'})`).
   - Amber offline pill gains a blue dot in the top-right corner.
   - The job's row on the dashboard shows a blue "Pending" chip.
   - Open `/settings` → new "OFFLINE SYNC" section appears with
     "1 pending edit waiting to sync".
   - Open `/settings/system` → the pending row is listed with its
     JSON patch preview.
3. **Retry flow**:
   - Network → Online. The replay worker fires on the `online`
     event; within ~1s the row disappears from `/settings/system`,
     the dashboard chip clears, the settings hub section hides
     itself, and the OfflineIndicator cluster collapses to empty.
4. **Poisoned flow**:
   - Offline-enqueue a patch the server will 4xx (e.g. an invalid
     `certificate_type`). Online — the replay worker's `attempt`
     catches the 4xx and calls `markMutationPoisoned`.
   - Red "Failed 1" link-pill appears in the header cluster.
   - Click through → `/settings/system` shows the row under
     "Failed edits" with the error message + attempt count.
   - Click **Retry** → poison cleared, `attempts: 0`,
     `nextAttemptAt: now`. The replay worker picks it up on the
     next mount / `online` / visibilitychange. If it 4xxs again it
     re-poisons.
   - Click **Discard** (after confirming) → row removed; all
     indicators clear.
5. **Cross-tab sync**:
   - Open `/dashboard` in tab A, `/settings/system` in tab B.
   - Offline-enqueue a mutation in tab A.
   - Tab B's pending list updates within one tick via
     `BroadcastChannel('certmate-outbox')`.

## Design decisions

### Why a hook, not a context provider

`useOutboxState()` re-reads IDB on every change notification. Two
components that both render it will each maintain their own state —
not free, but measured: `listPendingMutations()` + `listPoisonedMutations()`
together are two `getAll()` calls against a store with single-digit
rows, so each refresh is sub-millisecond.

A context provider would save the duplicate IDB reads but introduces
a new top-level Provider + a memoisation boundary. The dashboard is
the only page that needs per-row state (Pending chip); the header
cluster + settings hub only need totals. The duplication cost is
lower than the coordination cost, and the code is simpler without
a provider.

### Why `BroadcastChannel` for cross-tab sync

IDB doesn't emit events on its own writes. The options were:

- **Polling** — every N seconds, re-read. Wasteful and the latency
  is a user-visible "is it working?" delay.
- **`storage` events** — only fire for `localStorage` writes, not
  IDB. Would require writing a dummy key on every mutation, which
  duplicates state + introduces a second source of truth.
- **`BroadcastChannel`** — purpose-built for same-origin cross-tab
  messaging, evergreen browser support, zero state. Paired with a
  same-tab `EventTarget` (because `BroadcastChannel` intentionally
  doesn't deliver to the sender).

### Why the admin page isn't role-gated

Outbox rows are tied to the inspector who created them and live on
*this device*. Hiding the page behind `isSystemAdmin` would lock a
normal inspector out of resolving their own failed edits — exactly
the user who needs the page most. The data the page surfaces is
already visible to the logged-in user by virtue of having the
access token that created it.

The page is still under the `/settings` sub-tree so it naturally
inherits the AppShell auth gate and the settings layout chrome;
no new middleware needed.

### Why Pending chip is separate from the status pill

Job status (`pending` / `processing` / `done` / `failed`) is a
server-side lifecycle. Outbox state is a client-side sync state.
Conflating them on the same pill would mean a done job with a
pending offline edit reads as "pending" (wrong) or "done" (loses
the sync signal). Two pills, two concerns — the Pending chip sits
*before* the status pill so status remains the primary, right-
aligned anchor.

### Why confirm() on discard, not modal

This is the only data-loss path in the rebuild. A dedicated modal
would be nicer UX but adds surface area; `window.confirm` is
native, keyboard-accessible, and impossible to bypass accidentally.
Re-queue does not confirm because its worst case is "it fails again
and you end up back where you started" — no data loss.

### Why the settings hub card is conditional

The hub is the primary role-scoped navigation surface. A permanently-
visible "Offline Sync" link is noise for the session-long common
case of an empty outbox. When there's work to do, the OfflineIndicator
cluster in the header already carries a link (the red "Failed" pill)
so the settings hub card is belt-and-braces rather than primary.
Showing it *only* when non-empty keeps the hub calm.

## Scope exclusions

- **Toast on first successful replay after being offline.** Phase
  7a/7c's `reloadOnOnline: true` handles the full-page reload case;
  a toast duplicating that signal would flash briefly before the
  reload. Deferred — revisit if Serwist's reload behaviour changes.
- **Conflict dialog.** Still last-writer-wins per-field, same as
  Phase 7c. A real conflict surface needs per-field base versions
  from the backend — an out-of-scope API change.
- **Per-user outbox purge.** `clearJobCache()` still nukes the whole
  outbox on sign-out. The `by-user` index on the store (from 7c)
  stays unused, ready for the day this becomes a problem.
- **Debounced-save wiring.** The first caller of `queueSaveJob` is
  still Phase 4's debounced flush — not part of 7d. Until then the
  UI is correct but the outbox only gains rows via manual console
  calls or future code.
- **Audit log.** Discards + re-queues write nothing to the backend.
  If audit trails become required, the outbox helpers would be the
  right place to emit an analytics event.

## Files touched

- `web/src/lib/pwa/outbox.ts` *(modify)* — pub/sub + discard/requeue
- `web/src/lib/pwa/use-outbox-state.ts` *(new)* — React hook
- `web/src/components/pwa/offline-indicator.tsx` *(rewrite)* — cluster
- `web/src/components/dashboard/job-row.tsx` *(modify)* — Pending chip
- `web/src/app/dashboard/page.tsx` *(modify)* — wire pendingSync
- `web/src/app/settings/page.tsx` *(modify)* — conditional hub link
- `web/src/app/settings/system/page.tsx` *(new)* — admin page
- `CLAUDE.md` *(modify)* — changelog row + current-focus update

## After 7d

**Phase 7 is closed.** Seven sub-phases (`7a`, four 7b commits,
`7c`, `7d`) shipped the full PWA surface: install, offline, IDB
read-through, offline indicator, iOS install hint, offline mutation
outbox, and the offline-sync UI polish.

Next candidates (pick with Derek):

- **Phase 8** — staged deploy + production promotion. Move
  `web-rebuild` → `main`, point `docker/frontend.Dockerfile` at
  the new `web/`, verify CI/CD, cutover `certomatic3000.co.uk`.
- **Debounced-save flush** — wire `queueSaveJob` into Phase 4's
  save path so the 7c/7d plumbing actually carries real edits.
  Smaller than a full phase; could land in parallel with Phase 8.
- **E2E test coverage** — zero Playwright tests exist for the
  rebuild. Offline-sync flows are a strong candidate given the
  amount of timing-dependent logic.

## Known good commit to branch from

`<Phase 7c commit hash>` → *Phase 7c close* → **`<Phase 7d commit hash>`** → Phase 8 branches from here.
