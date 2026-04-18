# Phase 7b1 — Context

**Commit:** `ce8323a`

## Commit message

```
commit ce8323ac5be6be763c491153a2fb18da62a7cad6
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 22:09:39 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 22:09:39 2026 +0100

    feat(web): Phase 7b kickoff — user-initiated SW update handoff
    
    Replace 7a's `skipWaiting: true` with a postMessage-driven prompt +
    sonner toast before any other 7b feature lands. Mandated by
    web/PHASE_7A_HANDOFF.md §"Kickoff checklist for 7b".
    
    Why now (before IDB / offline job list / any 7b feature):
      7a's auto-skipWaiting was safe on the FIRST prod deploy (no prior
      SW existed) but would hot-swap the bundle under an active inspector
      mid-edit on every deploy after that — the old tab's JS chunks would
      404 as soon as the new SW took control. Must ship before deploy #2.
    
    Flow:
      new deploy → /sw.js installs, sits in `waiting` (old SW still
      controls the tab) → SwUpdateProvider detects it and raises a
      persistent sonner toast ("New version available — Reload") → user
      taps → registration.waiting.postMessage({type:'SKIP_WAITING'}) →
      new `message` listener in sw.ts calls self.skipWaiting() →
      clientsClaim (retained from 7a) takes over the tab → browser fires
      `controllerchange` → provider calls window.location.reload() once.
    
    Why not reload() immediately on click:
      reloading before the new SW activates would just re-serve the old
      SW to the fresh page and the toast would re-appear. Waiting on
      controllerchange guarantees the matching client bundle loads.
    
    Update detection covers two races:
      (A) page-load scan via navigator.serviceWorker.getRegistration() —
          catches the case where the user closed the tab before a prior
          deploy's SW finished installing and has now reopened it with a
          worker already in `waiting`.
      (B) live updatefound → statechange:'installed' while
          navigator.serviceWorker.controller is non-null — catches
          in-session upgrades.
    
    The `controller != null` guard is the first-install distinguisher:
    a fresh SW landing for a user who's never had one must NOT surface a
    "new version" toast. `toastShownRef` dedupes if both paths observe
    the same worker (registration resolves after updatefound fires).
    `reloadedRef` prevents a spec-noncompliant double `controllerchange`
    from double-reloading mid-save.
    
    `'serviceWorker' in navigator` early-return keeps the provider inert
    on older Safari and privacy-mode Firefox. Serwist is already
    disable'd in dev (next.config.ts), so this is effectively prod-only.
    
    Toast placement — bottom-right so it clears both the mobile AppShell
    bottom nav and Phase 4's floating RecordingOverlay mini-pill (centre
    or left would overlap). richColors/closeButton/dark theme mounted at
    root layout so future toast.success/error calls pick up semantic
    accent without per-call styling.
    
    sw.ts changes:
      - removed `skipWaiting: true` (comment expanded to explain why)
      - kept clientsClaim, navigationPreload
      - added self.addEventListener('message', ...) that calls
        self.skipWaiting() only on {type:'SKIP_WAITING'}
    
    Listening directly (rather than via Serwist's own handling) keeps
    the contract explicit: the worker skips waiting because a logged-in
    client asked for it, never on its own schedule.
    
    Incidental: eslint.config.mjs globalIgnores now covers public/sw.js
    (and defensive workbox-*/swe-worker-* patterns matching .gitignore).
    Pre-existing issue — 7a's lint passed only because no Serwist bundle
    had been emitted to public/ yet; the current local build produces 1
    error + 106 warnings in the minified SW output. Restores documented
    baseline of 0 errors / 6 warnings.
    
    Why separate commit (not bundled with a 7b feature):
      the handoff mandates skipWaiting replacement BEFORE any other 7b
      work. Reviewers can assess the SW lifecycle change in isolation;
      folding IDB read-through into the same diff would make the
      lifecycle review much harder.
    
    Verification:
      - npm run typecheck   (main + tsconfig.sw.json): clean
      - npm run lint        : 0 errors, 6 warnings (baseline)
      - npm run build       : all routes, public/sw.js emitted,
                              SKIP_WAITING handler bundled in
    
    Scope still deferred: IDB read-through / offline job list (next 7b
    commit), AppShell offline indicator, iOS ATHS hint on /settings,
    outbox (7c), offline job-edit UI (7d), Sentry.
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                     |   1 +
 web/eslint.config.mjs                         |  11 +++
 web/src/app/layout.tsx                        |  18 ++++
 web/src/app/sw.ts                             |  34 +++++++-
 web/src/components/pwa/sw-update-provider.tsx | 121 ++++++++++++++++++++++++++
 5 files changed, 181 insertions(+), 4 deletions(-)
```

## Handoff doc: PHASE_7B_HANDOFF.md

# Phase 7b — PWA Offline Reads + Update Handoff (handoff)

> Web rebuild · branch `web-rebuild` · Phase 7a closed at `eb72acc` (PWA foundation)

## Objective

Phase 7b closes the four `PHASE_7A_HANDOFF.md` §"Scope exclusions" items
that were tagged "7b": replace the first-deploy-only `skipWaiting`
shortcut with a user-mediated update prompt, add stale-while-revalidate
IDB caching so previously-visited jobs render offline, surface the
connectivity state in the AppShell header, and give iOS users a
pathway to install (Safari never fires `beforeinstallprompt`).

**What 7b does *not* do:** write path. Offline edits still vanish —
the outbox / mutation queue is Phase 7c, and offline job-edit UI
polish is 7d. The IDB cache is **read-only SWR** — writes still
require network.

Phase 7b shipped as four focused commits in mandated order.

## What shipped

### Commits (in order)

| Commit    | Sub-phase                       |
|-----------|---------------------------------|
| `ce8323a` | SW update handoff (kickoff)     |
| `2d3527f` | IDB read-through cache          |
| `a85487f` | AppShell offline indicator      |
| `1ec4e22` | iOS Add-to-Home-Screen hint     |

### 1. SW update handoff (`ce8323a`)

**New**

- `web/src/components/pwa/sw-update-provider.tsx` — renders null. Watches `navigator.serviceWorker` for `waiting` states via two paths:
  - **(A)** Page-load scan via `registration` (catches the tab-closed-before-last-deploy-activated case).
  - **(B)** Live `updatefound` → `statechange: installed` while `navigator.serviceWorker.controller != null` (catches in-session upgrades).
  The `controller != null` guard is the first-install distinguisher — a fresh SW for a user who's never had one should NOT show a "new version" toast. `toastShownRef` dedupes, `reloadedRef` guards against spec-noncompliant double `controllerchange` firings. On user tap, posts `{type:'SKIP_WAITING'}` to `registration.waiting`, waits for `controllerchange`, reloads once.

**Modified**

- `web/src/app/sw.ts` — removed `skipWaiting: true` from `new Serwist({...})`. Kept `clientsClaim: true` + `navigationPreload: true`. Appended a `message` listener: `if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()`. Listening directly (rather than via Serwist's config) keeps the contract explicit — the worker skips waiting *because a client asked*, never on its own schedule.
- `web/src/app/layout.tsx` — mounted `<SwUpdateProvider />` and `<Toaster position="bottom-right" theme="dark" richColors closeButton />` from `sonner`. Bottom-right clears both the mobile AppShell bottom nav AND the floating `RecordingOverlay` mini-pill from Phase 4.
- `web/eslint.config.mjs` — added `public/sw.js`, `public/sw.js.map`, `public/swe-worker-*.js(.map)`, `public/workbox-*.js(.map)` to `globalIgnores`. Pre-existing gap — the 7a lint run happened before any Serwist bundle had been emitted to `public/`.

**Why first:** `PHASE_7A_HANDOFF.md` §"Kickoff checklist for 7b" mandated this land BEFORE any other 7b feature. The second-ever prod deploy would otherwise hot-swap the bundle under an active inspector mid-edit.

### 2. IDB read-through cache (`2d3527f`)

**New**

- `web/src/lib/pwa/job-cache.ts` — vanilla IDB helper (no `idb` package — tiny surface, 7c can upgrade if needed). Database `certmate-cache`, version 1, two object stores:
  - `jobs-list` (keyPath `userId`) — value `{userId, jobs: Job[], cachedAt}`
  - `job-detail` (keyPath `key`) — value `{key: 'userId:jobId', userId, jobId, detail: JobDetail, cachedAt}`
  Module-scoped `dbPromise` caches the open handle for tab lifetime; on rejection it nulls out so the next call retries. `onblocked` surfaces as reject rather than hanging. Six exports: `getCachedJobs`, `putCachedJobs`, `getCachedJob`, `putCachedJob`, `clearJobCache`, and an internal `isSupported` guard. All SSR-safe via `typeof indexedDB === 'undefined'` early-return. Errors inside transactions swallow to `null`/`void` and `console.warn` — a failed read must never break the page.

**Modified**

- `web/src/app/dashboard/page.tsx` — SWR pattern in the main fetch `useEffect`. Cache read and network fetch fire in parallel. Cache-resolved list paints only if `jobs === null` (prevents a late cache resolve clobbering fresh network data); network success always overwrites and fire-and-forget writes back. **Error suppression**: if network fails but cache painted, the error banner is suppressed (inspector can still browse cached jobs).
- `web/src/app/job/[id]/layout.tsx` — mirror of the same pattern for `api.job(userId, jobId)`. `<JobProvider>` mounts with cached data while the network catches up.
- `web/src/lib/auth.ts` — `clearAuth()` now fires `void clearJobCache()` after localStorage + cookie wipe. **Shared-device security**: user A's cached jobs must not be renderable by user B. Fire-and-forget because the caller is about to navigate to `/login`; the tab stays alive long enough for the readwrite transaction to commit.

**Why vanilla IDB, not React Query's persister:** the app doesn't use React Query despite the dep being installed. Imperative `useEffect + state` is the Phase 3–6 pattern throughout; switching now would balloon the diff.

**Why no cache-on-save:** `api.saveJob` has no UI callers yet (Phase 4 shipped the recording/extraction path but stopped before the debounced save flush). Wiring `putCachedJob` into a non-existent save flow would be speculative per CLAUDE.md §"Don't design for hypothetical future requirements". When saves land, the caller wires it in the same commit.

### 3. AppShell offline indicator (`a85487f`)

**New**

- `web/src/lib/pwa/use-online-status.ts` — minimal hook wrapping `navigator.onLine` + window `online`/`offline` events. Returns a plain boolean. SSR-safe: defaults to `true` (optimistic); `useEffect` flips to `navigator.onLine` on mount. Defaulting to `false` would flash the pill on every cold render even for online users.
- `web/src/components/pwa/offline-indicator.tsx` — amber pill with `WifiOff` lucide icon, "Offline" text on `sm+` / icon-only below. Uses `--color-status-processing` (amber #ff9f0a). **Amber, not red** — degraded ≠ broken; the SWR cache keeps everything browsable. `role="status"` + `aria-live="polite"` — informational, not assertive.

**Modified**

- `web/src/components/layout/app-shell.tsx` — `<OfflineIndicator />` mounted as the **first** item in the header right-cluster (before user-name → InstallButton → Sign-out). The SWR cache may be showing stale data and the pill is how the inspector knows.

**No "back online" confirmation toast** — Serwist's `reloadOnOnline: true` (set in `next.config.ts` since 7a) already triggers `window.location.reload()` when the browser fires `online` after being offline. The pill disappearing IS the confirmation.

**`navigator.onLine` truthiness caveat** (documented in both files): `true` means "the device has a network interface", NOT "the backend is reachable". Captive-portal wifi, hotel DNS hijack, and ISP blocks all look "online" to the browser. The pill handles only the clear-cut no-interface case; real retry logic must be driven by failed fetches (the SWR paths from `2d3527f`).

### 4. iOS Add-to-Home-Screen hint (`1ec4e22`)

**New**

- `web/src/components/pwa/ios-install-hint.tsx` — dismissible `<aside role="region">` on `/settings`. Renders only when **all** of:
  - `/iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)` (the `MSStream` guard filters old Windows Phones that spoofed iOS UAs).
  - NOT `(navigator as IOSNavigator).standalone === true` (iOS-specific property, typed via a local interface extension rather than polluting a global declare).
  - NOT `window.matchMedia('(display-mode: standalone)').matches` (cross-browser standard, reliable on iPadOS 16+).
  - `localStorage.getItem('cm_pwa_ios_hint_dismissed:v1') !== '1'`.

  The `:v1` suffix on the dismissal key is deliberate: a future campaign can reset the pool by bumping to `:v2` with no data-migration step. try/catch around `setItem` handles private-mode Safari + quota-exceeded.

  Visual: brand-blue-tinted surface (`color-mix(in srgb, var(--color-brand-blue) 10%, var(--color-surface-2))`) + 30%-opacity brand-blue border (matches 6b LinkCards so it feels native). Plus icon tile, numbered ol with inline Share icon on step 1 (brand-blue — mirrors what the user sees in Safari's toolbar), bolded "Add to Home Screen" / "Add" on step 2. Top-right × dismiss button, 32×32 hit area.

**Modified**

- `web/src/app/settings/page.tsx` — single import + single render site, between the hero profile section and the TEAM SectionGroup. The banner self-suppresses in every no-show case, so the settings page has no platform-specific branching.

**Why `/settings` and not `/dashboard`:** the dashboard is already dense (hero + recent jobs + setup grid) and adding an install prompt would push Recent Jobs below the fold on a phone during the primary daily workflow. `/settings` is low-traffic by inspector standards — the user is already in "configure my app" mode there.

**No auto-dismiss-on-install** — iOS "installs" don't fire a web-platform event. The banner is suppressed on the next navigation after install via the standalone check at mount. One-cycle staleness is acceptable for a once-in-a-lifetime flow.

## Verification

```
npm run typecheck                  # clean (main + sw via tsconfig.sw.json)
npm run lint                       # 0 errors, 6 warnings (baseline — unchanged from 6c/7a)
npm run build                      # succeeds; public/sw.js emitted with SKIP_WAITING handler
```

Build output confirmed all 7a routes still prerender; `/settings`
still static.

### DevTools walkthrough (Chrome, production build via `npm start`)

1. **Application → Service Workers** — `/sw.js` active, no `skipWaiting` in the Serwist config (grep `public/sw.js` for `SKIP_WAITING` — 2 occurrences).
2. **Application → IndexedDB → `certmate-cache`**:
   - Visit `/dashboard` → one row in `jobs-list` keyed by userId.
   - Open any job → one row in `job-detail` keyed `{userId}:{jobId}`.
   - Sign out → both stores empty.
3. **Network → Offline → reload `/dashboard`** — list renders from cache (no `/offline` fallback).
4. **Network → Offline** at any time — amber "Offline" pill appears in the AppShell header right-cluster. Switch back online → pill disappears + page reloads (Serwist `reloadOnOnline: true`).
5. **Device emulation → iPhone 14 → `/settings`** — install-hint banner visible; tap × → localStorage row `cm_pwa_ios_hint_dismissed:v1=1`; reload → banner stays hidden; clear the row → banner returns.
6. **Device emulation → Pixel 7** — install-hint banner never renders (UA regex miss).

### Update-handoff test

Two sequential prod builds with different `BUILD_ID`s:

1. First deploy → install cleanly, no toast (no prior SW).
2. Open the app, keep the tab alive. Deploy the second build.
3. Focus the tab → `SwUpdateProvider` detects the `waiting` SW (path A or B) → sonner toast "New version available — Reload".
4. Tap Reload → `registration.waiting.postMessage({type:'SKIP_WAITING'})` → SW activates → `controllerchange` → `window.location.reload()` (once, guarded by `reloadedRef`).
5. Next load shows the new build; toast does not re-appear.

## Scope exclusions (deferred to 7c/7d)

- **No outbox / mutation queue** — offline edits to fields still vanish. That's 7c.
- **No offline job-edit UI** — no "saved locally" / "pending sync" chips. That's 7d.
- **No cache-on-save** — `api.saveJob` has no UI callers yet; when the Phase 4 debounced-save flush lands, it should call `putCachedJob(userId, jobId, detail)` in the same success handler so the cache stays fresh without a separate fetch.
- **No cache TTL / eviction** — entries live forever (bounded only by the browser's own IDB quota eviction). 7c or 7d can add a `cachedAt`-based purge if the working set grows, but for a per-inspector job list this isn't yet load-bearing.
- **No push notifications, periodic sync, share target, web share target** — not in Phase 7 at all.
- **No Sentry / error aggregation** — `error.tsx` still logs `error.digest` to console only.
- **No iOS ATHS banner on other pages** — only `/settings`. If analytics later show low install rates we can add a second instance on `/dashboard`, but the handoff recommendation is to leave the dashboard clean.
- **No "offline" state in sub-routes** — e.g. opening `/job/[id]/observations` offline without ever having visited the job at all will still fall through to `/offline`. Only the `layout.tsx` fetch is cached; the inner `observations` fetch is not. 7c/7d should consider per-section caching if inspectors start landing deep-links offline.

## Kickoff checklist for 7c (outbox / mutation queue)

Before shipping any 7c feature, settle these architectural questions in
a single design commit or short README:

1. **Where the mutations live.** The obvious store is a third IDB object store in `certmate-cache` (e.g. `outbox`, keyPath `id`) holding `{id, op: 'saveJob'|..., userId, jobId, patch: JobPatch, createdAt, attempts, lastError?}`. Keep it in the same DB so `clearJobCache()` purges it on sign-out (otherwise one user's pending edits could replay under another user's auth).
2. **The write path.** `api.saveJob` (currently unused from UI) needs a wrapper — call it `queueSaveJob` — that:
   - Optimistically applies the patch to the in-memory `JobProvider` state.
   - Writes the mutation to the outbox.
   - Fires the network request in parallel; on 2xx, removes the outbox row; on failure, leaves it for the replay worker.
   - Updates the IDB `job-detail` cache with the optimistic result so reloads don't lose the local edit.
3. **The replay worker.** Likely a hook mounted in `AppShell` or root layout. Listens for `online` events; scans the outbox in FIFO order; retries each row with exponential backoff (cap attempts — e.g. 10 — before moving to a `poisoned` state that needs manual review). `navigator.onLine` alone isn't trustworthy (captive portals, DNS blocks) — a failed replay must not drain the queue, just increment `attempts` and wait for the next trigger.
4. **UI surface.** Almost certainly a Phase 7d job — 7c should ship the mechanism even without chips/badges. But decide now: where does the user see pending count? Candidates: a secondary dot on the existing `<OfflineIndicator />`, a dedicated `<SyncIndicator />`, or a toast on first successful replay. Don't implement, just pick.
5. **Conflict strategy.** Server returns current state on every save (already true via the existing `saveJob` response shape). On replay, if the server state has moved beyond the outbox row's base version, the client must either (a) auto-merge (last-writer-wins on scalar fields, which is what iOS already does) or (b) reject and surface a conflict dialog. Pick (a) for parity with iOS unless there's a strong reason to diverge.
6. **Shared-device safety.** Every outbox row MUST carry `userId`. On sign-out, purge only rows matching the signing-out user — don't nuke the whole store (another signed-in profile in a different tab could lose pending edits). Or decide sign-out always nukes everything for simplicity; document whichever.

**Do NOT land 7c UI polish (chips, badges, conflict modals) in the mechanism commit.** Keep them separate so the replay loop can be reviewed in isolation — a busted outbox corrupts data, and a compact diff is the only way to verify correctness.

## Known good commit to branch from

`eb72acc` → *Phase 7a* → `ce8323a` → `2d3527f` → `a85487f` → **`1ec4e22`** → Phase 7c branches from here.
