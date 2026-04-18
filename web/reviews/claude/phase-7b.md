# Phase 7b — Combined Review (ce8323a / 2d3527f / a85487f / 1ec4e22)

Scope: PWA offline reads + SW update handoff. Four sub-commits reviewed
together as one cohesive phase. No code changes made; findings only.

---

## 1. Summary (per sub-commit)

### 7b1 — `ce8323a` — SW update handoff
Removes `skipWaiting: true` from Serwist config (`web/src/app/sw.ts`).
Adds an explicit `message` listener that calls `self.skipWaiting()` only
on `{type:'SKIP_WAITING'}`. New `SwUpdateProvider`
(`web/src/components/pwa/sw-update-provider.tsx`) watches the registration
via two paths (page-load scan + `updatefound` → `statechange:'installed'`)
and shows a persistent sonner toast with a Reload action; on tap it posts
the message, then reloads once on `controllerchange`. `<Toaster>` mounted
in root layout. `eslint.config.mjs` globalIgnores extended to cover the
emitted Serwist bundle.

### 7b2 — `2d3527f` — IDB read-through cache
New `web/src/lib/pwa/job-cache.ts` — vanilla IDB, DB `certmate-cache`,
two stores (`jobs-list` keyed by `userId`, `job-detail` keyed by
`${userId}:${jobId}`). SWR pattern applied in `dashboard/page.tsx` and
`job/[id]/layout.tsx`: cache read in parallel with network, cache paint
gated on `state === null`, fire-and-forget write-back, error banner
suppressed when a cache paint occurred. `clearAuth()` in `lib/auth.ts`
fires `void clearJobCache()`.

Note the working-tree version of `job-cache.ts` has already been extended
to DB v2 by 7c (adds `outbox` store + `by-user` index). This review
evaluates the shipped 7b slice — DB v1 at the time — but the review's P1
findings still apply to the current v2 file.

### 7b3 — `a85487f` — AppShell offline indicator
New `web/src/lib/pwa/use-online-status.ts` — minimal hook wrapping
`navigator.onLine` + `online`/`offline` window events, SSR-safe default
`true`. New `web/src/components/pwa/offline-indicator.tsx` — amber pill
(WifiOff icon + responsive "Offline" label). Mounted first in the header
right-cluster in `app-shell.tsx`.

### 7b4 — `1ec4e22` — iOS Add-to-Home-Screen hint
New `web/src/components/pwa/ios-install-hint.tsx` — dismissible
`<aside>` rendered only when UA matches iOS, not already standalone, and
not previously dismissed (localStorage key `cm_pwa_ios_hint_dismissed:v1`).
Mounted once on `/settings` between the hero and TEAM section.

---

## 2. Alignment with plan

All four items in `PHASE_7A_HANDOFF.md §"Scope exclusions"` tagged 7b are
addressed. The mandated ordering (SW update handoff first, before any
other 7b feature that would amplify the auto-`skipWaiting` blast radius)
is respected — 7b1 lands strictly before 7b2/3/4. Deferred items (outbox,
edit-UI polish, Sentry, cache TTL) are correctly out of scope. The 7c
kickoff checklist content in the handoff is consistent with what 7c
shipped (`useOutboxReplay`, outbox store in same DB).

Minor deviation: the 7b2 commit message asserts
"`JobProvider`'s `useEffect([initial])` handles the swap from
cached → fresh cleanly (resets isDirty=false on the server snapshot)".
That behaviour is real (`job-context.tsx:49-52`) but its consequences
for mid-render edits are not safe — see P1 finding §3.2.

---

## 3. Correctness (P0/P1/P2) per area

### 3.1 SW update dance (7b1)

**P1 — `controllerchange` listener mounts on first install too.**
`sw-update-provider.tsx:108-113` registers the `controllerchange` handler
unconditionally. For a user whose very first-ever visit triggers a fresh
SW install, the first install activates → claims the client (because
`clientsClaim: true` in `sw.ts:86`) → browser fires `controllerchange`.
There is no waiting SW, `toastShownRef` is false, `reloadedRef` flips to
true and `window.location.reload()` runs once on the inspector's first
load. The two-path guard correctly avoids showing the *toast* on first
install, but the reload is not guarded. Effect: double page load on
first visit. Not a data corruption bug, but a visible jank.
Fix: gate `onControllerChange` on `toastShownRef.current === true` (i.e.
"we initiated the upgrade") rather than just on not-yet-reloaded.

**P1 — dev / privacy-mode crash on `navigator.serviceWorker` access.**
`sw-update-provider.tsx:56-57` guards with
`if (!('serviceWorker' in navigator)) return;` — correct. However, the
same provider reads `navigator.serviceWorker.controller` inside the
`statechange` handler (`:93`) without rechecking. If the user revokes the
permission mid-session (rare but possible on Firefox private mode),
`navigator.serviceWorker` remains defined but the controller reference
throws on access in some engines. Low real-world likelihood. P2 at most,
noted here because the `controller` read happens inside a long-lived
closure.

**P2 — `updatefound` may be missed between getRegistration resolve and
listener attach.** The promise returned by `getRegistration()` resolves
asynchronously (`:104`). If a `waiting` SW lands in the window between
`getRegistration()` starting and `watchRegistration()` attaching the
`updatefound` listener, the current `registration.waiting` check at
`:84` will still catch it — so this is actually safe. Documented here
only to confirm the two-path design is correct.

**P2 — `reloadedRef` prevents only double-reload-in-same-session.** If
the SW activates, claims the tab, reloads — then immediately another
deploy lands, the provider would catch the new waiting SW correctly on
the next mount because `reloadedRef` is a `useRef` freshly initialised on
mount. OK.

**P0 (none).** The handoff race protections (toastShownRef + reloadedRef
+ controller-null guard) cover the main cases. The missing case is only
the first-install `controllerchange` reload above.

**P1 — missing message-source validation in `sw.ts`.** The `message`
listener (`sw.ts:199-203`) accepts any client's postMessage as long as
the `type` field matches. In a service worker, `event.source` is the
Client that sent the message. Because the worker's scope is same-origin
only, cross-origin postMessage is impossible, so this is not a security
bug. However, it's worth noting: a third-party-origin iframe embedded
in the page could not reach the SW, and a compromised first-party script
could already do worse. Keeping the assertion here for completeness; no
fix required.

**P2 — `reloadOnOnline: true` collides with update-handoff flow.**
`next.config.ts:18-21` still has `reloadOnOnline: true` from 7a.
Walkthrough: inspector is offline with a waiting SW, taps Reload in the
sonner toast → `SKIP_WAITING` is posted but the message may not deliver
reliably when offline (it does, it's intra-process). Network comes back
→ Serwist's internal `reloadOnOnline` fires a full reload at a moment
that may race the update handoff's own reload. Both paths idempotently
reload, so no data loss, but it can double-reload. P2 polish.

### 3.2 IDB read-through correctness / stale cache (7b2)

**P1 — cached paint overwrites local edits when fresh network lands.**
Sequence: (a) user visits `/job/abc` → cache hits → `JobProvider` mounts
with cached detail; (b) user starts editing a field (e.g. fills in a
circuit reading); (c) network fetch resolves ~1–2s later; (d) layout
calls `setJob(detail)` → new `JobDetail` object identity; (e)
`JobProvider`'s `useEffect([initial])` (`job-context.tsx:49-52`) runs
`setJob(initial)` AND `setIsDirty(false)`. The local edit is lost.
Note `setJob` inside JobProvider is also in `useMemo` deps so the whole
context value rebuilds — every consumer re-renders with server data.
Critical: this is offline-edit loss in the read-cache phase. The 7b2
commit message acknowledges this but dismisses it with "callers above
this layout don't re-provide" — they do, because the layout itself owns
`initial` via `setJob(detail)` in the fetch `.then()`.
Fix direction: guard the fresh overwrite — either (i) skip
`setJob(detail)` if `isDirty` is true (preferred for parity with a
debounced save flow), (ii) merge server over local non-dirty fields,
or (iii) add a per-field "server wins if not locally edited" check.
This is tied to Phase 4's debounced save flush (not yet wired), so it
may be mitigated when that lands — but the read-only cache slice must
not introduce the bug before the write path can compensate.

**P1 — no cache TTL / version invalidation.** The handoff acknowledges
this as deferred, but worth flagging the correctness implication: if the
`JobDetail` shape changes in a future backend schema (e.g. a new
required field is added and the UI crashes when it's missing), a cached
record from before the deploy can render under new UI code and throw.
The SW update handshake (7b1) handles the JS bundle rev, but IDB
persists across SW upgrades. Fix direction: bump `DB_VERSION` on every
breaking schema change (still the current shipped behaviour — DB_VERSION
is 2 in-tree because 7c changed the schema). Alternative: a `schemaVer`
field on each cached record, validated on read.

**P1 — `dbPromise` sticky-failure race.** `openDB()` (`job-cache.ts:88`)
caches a pending promise in module scope. On `onerror` / `onblocked`
the promise is nulled so retries work. However, if two call sites
invoke `openDB()` nearly simultaneously while no promise exists, they
both see `dbPromise === null` and each opens a new `IDBOpenDBRequest`.
One of them will succeed; the other will fire `onblocked` on the first
and be rejected. The caller of the rejected one sees a single failed
read/write, and the next call succeeds on the cached promise. Not a
data bug, but a noisy log on the first concurrent hit.
Fix: set `dbPromise` synchronously before the request opens (already
done here because the Promise executor runs sync) — this is actually
safe since the Promise is assigned before any `.then()`. Leaving as P2
unless confirmed otherwise.

**P1 — `putCachedJobs` races with sign-out.**
`dashboard/page.tsx:80` fires `void putCachedJobs(user.id, list)` after
a successful fetch. If the user then signs out quickly, `clearJobCache()`
runs (`auth.ts:51`), but the `putCachedJobs` transaction may commit
after the clear — user A's jobs end up in user A's cache entry for user
B to never see unless they happen to have the same userId. Not quite a
leak since keyed by userId, but if user A signs out and then signs
back in, the stale jobs resurface silently. Low impact; mostly confusing
in practice.
Fix: await `putCachedJobs` before sign-out, or stamp writes with a
session token and verify on next read.

**P2 — error suppression hides 5xx while cache paints.**
`dashboard/page.tsx:91-94` and `job/[id]/layout.tsx:90-92` suppress the
error banner whenever `hadCache` is true. If the network returns 500
repeatedly (server-side bug), the user sees a happy stale list forever.
The pill (`OfflineIndicator`) won't fire because `navigator.onLine` is
true. No visible signal.
Fix: only suppress for network-level errors (TypeError `Failed to
fetch`), pass through HTTP 5xx to the banner. This hooks into the same
captive-portal caveat in 3.3.

**P2 — `wrapRequest` resolves even when the transaction aborts.**
`job-cache.ts:153-161` wraps the request but the request can succeed
while the *transaction* fails on commit (e.g. quota exceeded). For
reads this is OK (the read value is already returned), for writes the
caller uses `wrapTransaction` separately, which handles it. Fine.

**P2 — `clearJobCache` includes `STORE_OUTBOX` in the transaction scope
but the store is 7c.** (`job-cache.ts:277`) If a user were bisecting
between 7b2 and 7c with an already-populated v1 DB, the v1→v2 upgrade
path in `onupgradeneeded` handles it. OK at HEAD; noted for historical
awareness.

### 3.3 `navigator.onLine` reliability / iOS Safari (7b3)

**P1 — iOS Safari `navigator.onLine` is ~unreliable.** `useOnlineStatus`
relies entirely on `navigator.onLine` + the `online`/`offline` window
events. On iOS Safari (WebKit), `navigator.onLine` returns `true`
whenever the OS reports *any* network-interface presence, and the
`online`/`offline` events fire inconsistently during:
- iOS low-power mode transitions,
- lock-screen lock/unlock cycles,
- airplane-mode toggles while the page is backgrounded,
- captive-portal login screens that hijack the TCP/DNS path.

Result: the pill (and more importantly the error-suppression logic in
3.2 that depends on it being complementary) will fail to show during
real-world inspector workflows — job-site basements with wifi radios
that the OS still reports as associated, van dead-spots, etc.

The handoff explicitly calls this out as "documented caveat" and
defers real retry logic to failed fetches. That's a defensible scope
call, **but** the AppShell has no fallback signal — a fetch failure
currently suppresses the error banner (3.2 P2) and the pill does not
fire, so the inspector sees a silent stale render with no indication
that the "most recent save" is actually from 4 hours ago.

Fix direction (for a future phase): supplement `navigator.onLine` with
a lightweight reachability probe — a HEAD against `/api/health/ready`
with a short timeout, triggered on user-visible failed fetches, used
to flip an internal "server-reachable" state. The pill can use either
signal.

**P1 — `useOnlineStatus` SSR hydration mismatch risk.** The hook
returns `true` on server and first client render, then the `useEffect`
runs and flips to `navigator.onLine`. If the actual value is `false` on
mount, React 19's stricter hydration may log a mismatch warning once
the indicator appears post-hydration. In practice, because the pill
returns `null` when online (`offline-indicator.tsx:49`), the
server-rendered DOM is empty and the post-mount DOM adds one element,
which is a valid client-only render, not a mismatch — so no warning.
Confirmed safe.

**P2 — `online`/`offline` events do not fire on all browsers after tab
sleep/restore.** When iOS backgrounds the tab for hours and foregrounds
it, some WebKit versions do not replay missed `online`/`offline`
events. Mitigation: also listen for `visibilitychange` and re-read
`navigator.onLine` on `visible` transitions.

### 3.4 A2HS hint detection / dismissal persistence (7b4)

**P1 — iPadOS 13+ reports as Mac in UA.** The regex
`/iPad|iPhone|iPod/.test(ua)` (`ios-install-hint.tsx:73`) will miss iPad
Safari on iPadOS 13+, which by default spoofs as Mac OS X. Indicator:
the `Request Desktop Website` preference (default ON for iPad) changes
the UA to look exactly like Safari on macOS.
Fix: augment with `/Macintosh/.test(ua) && navigator.maxTouchPoints > 1`
as the iPad tell. Without it, a large cohort of the actual iOS target
audience never sees the hint.

**P2 — The `'MSStream' in window` guard is for IE/Edge-Legacy, not
Windows Phone.** The commit message claims it filters Windows Phone UAs
that spoofed iOS. Accurate historical note (IE11 on Windows Phone did
set `window.MSStream`), but the specific browsers in question are long
end-of-life. Keeping the guard is zero-cost, so no action.

**P2 — `localStorage.getItem` inside the effect can throw in
cookies-disabled iOS Safari.** The effect reads
`localStorage.getItem(DISMISS_KEY)` at `:82` without try/catch. If the
user has "Block All Cookies" enabled, `localStorage` access throws
`SecurityError`. The component's whole effect unwinds, `setVisible` is
not called, and the banner stays hidden — actually a safe failure. The
setter path correctly has try/catch; the getter does not, but the
failure mode is benign.

**P2 — `display-mode: standalone` does not catch `fullscreen` / modern
iOS A2HS mode.** iOS A2HS installs render in standalone mode, so this is
fine. But if the user adds to dock on macOS Safari as a web app
(Sonoma+), `display-mode` may report `minimal-ui`. The banner still
suppresses on macOS because the UA regex never matches, so no user
impact.

**P2 — no suppression if the user just clicked iOS Share.** After the
inspector adds the app, the banner will keep showing on `/settings`
until the *next* launch (which opens in standalone → suppresses). Mild
staleness acknowledged in handoff; acceptable.

---

## 4. Security

**P2 — cached job data leak across same-origin origins on shared
devices.** `clearJobCache()` wipes the DB on sign-out, but if the tab
crashes before `clearAuth()` runs, the IDB rows persist. The same
concern applied to localStorage in earlier phases. The mitigation is
that the cookie/localStorage token is also still present in that case,
so a next user would land in the previous user's session — broader bug,
not 7b-specific.

**P2 — `ServiceWorker.postMessage` has no origin check.** Covered in
3.1 P1 note. Same-origin by construction.

**P1 — iOS install hint localStorage key is unversioned per-user.**
Dismissal persists across sign-outs (`auth.ts:41-52` clears the job
cache but not arbitrary localStorage keys). User A dismisses on a
shared tablet → user B signs in, doesn't see the hint. Minor, but the
hint's whole purpose is discoverability. Fix direction: key the value
on userId (or clear it in `clearAuth()`).

**No P0 security issues.** Toast content is static strings; no XSS
surface. postMessage channel has no user-influenced payload. IDB
stores the JobDetail API response verbatim — trust boundary is the API,
same as the memory-resident copy.

---

## 5. Performance

**P1 — every dashboard and job navigation opens the IDB connection
cold-path on first use per tab.** Expected; `dbPromise` caches the
handle for the tab lifetime after that. OK.

**P2 — two IDB transactions per visit** (read at mount, write on
fetch success). Fire-and-forget so not on the critical path.

**P2 — `useOnlineStatus` binds global event listeners on every
component that uses the hook.** Currently only one consumer
(`OfflineIndicator`), so single binding. If adoption grows, consider
a module-level subscription with a shared store.

**P2 — cached list paint is gated on `jobs === null`.**
`dashboard/page.tsx:66` — reads `jobs` from closure scope of the effect
body rather than a ref or state getter. If React strict-mode in dev
runs the effect twice, both runs see `jobs === null` in their own
closures and may both call `setJobs(cached)`. Harmless (idempotent) but
worth noting.

**P2 — sonner toast with `duration: Infinity` keeps an active DOM
node.** Negligible memory, mentioned for completeness.

---

## 6. Accessibility

- `<OfflineIndicator>`: `role="status"` + `aria-live="polite"` is
  correct choice for non-urgent state. `aria-label` carries the full
  context string — good.
- Responsive hide of the "Offline" label below `sm` breakpoint: icon is
  `aria-hidden`, the parent `<span>` has `aria-label`, so screen readers
  still announce the full string. Correct.
- `<IOSInstallHint>`: `<aside role="region" aria-label=...>` is correct
  for a landmark. Dismiss button has `aria-label="Dismiss install
  hint"`. 32×32 hit area meets WCAG 2.1 AA (24×24 target).
- **P2 — the inline Share icon inside the `<li>` text has
  `aria-label="Share"`** (`ios-install-hint.tsx:140`) which will make
  screen readers announce "Tap the Share Share icon in Safari's
  toolbar" — duplicated word. Fix: `aria-hidden` and rely on the
  surrounding text, which already contains the word "Share" implicitly
  via "Share icon".
- **P2 — the numbered `<ol>` uses decorative circles with visible "1"
  / "2" text** and flex-centred layout. Works for sighted users; for
  screen readers, the `<ol>` semantics carry the ordering, so the
  visible numbers are technically redundant. Not a bug, could be
  `aria-hidden` to avoid duplicate "one" readouts.
- **P1 — sonner toast's accessibility depends on sonner's own
  implementation.** Verify that the toast's Action button receives
  focus (or at least is tab-reachable). A persistent toast that's not
  focusable is ignorable by keyboard users. Sonner does make the action
  button focusable, but confirm in manual QA.
- **P2 — focus management on SW reload.** When the user taps Reload and
  the page eventually reloads, focus is lost. For a deploy-upgrade flow
  this is acceptable; users expect a fresh page.

---

## 7. Code quality

Overall strong — small, focused files; commit messages explain *why*
(as mandated by the project's `CLAUDE.md`); no reach into unrelated
subsystems.

Nits:
- `sw-update-provider.tsx:80-98`: `watchRegistration` nested function
  inside the effect is fine, but the closed-over `registration.waiting`
  is read only once at call time — if a second `updatefound` fires for
  a later deploy in the same session without the page reloading, the
  listener chain is re-attached. The `toastShownRef` dedupes the toast,
  so not a bug, but slight leak of duplicate `updatefound` listeners
  across sessions — addEventListener deduplicates identical handlers,
  so even this is fine.
- `job-cache.ts:125`: `void event;` is a workaround to silence the
  unused-param lint. Could be eliminated by dropping the `event`
  parameter entirely — `IDBOpenDBRequest.onupgradeneeded`'s event is
  the same as `request` in scope here.
- `job-cache.ts`: mixing `export` + `const`/`function` declarations
  with the `export const DB_VERSION = 2;` at the top is fine, but the
  jump from "v1 shipped here" in the header JSDoc to `DB_VERSION = 2`
  is jarring when reading the 7b2 diff in isolation. Consistent
  with 7c.
- `use-online-status.ts:35`: returning a plain boolean is fine, but
  two consumers now would each attach their own listeners. Consider a
  shared zustand store like `install-store.ts` if adoption grows.
- `ios-install-hint.tsx:73`: UA detection is split across two
  expressions; unify in a local `isIOSPlatform(ua)` helper if you add
  the iPadOS check (see §3.4 P1).
- `app-shell.tsx:12` imports `useOutboxReplay` (7c) — confirms the HEAD
  of branch includes 7c changes layered on top of 7b.

---

## 8. Test coverage

**None.** No Vitest / RTL tests exist for any of:
- `sw-update-provider.tsx`
- `sw.ts` (SW message handler)
- `job-cache.ts`
- `use-online-status.ts`
- `offline-indicator.tsx`
- `ios-install-hint.tsx`

Ripgrep for any of these file names inside `**/*.test.*` returns no
hits.

Priority test additions (Phase 7d or dedicated):
1. `job-cache.ts` — Node `fake-indexeddb` is trivial to wire. Cover:
   get/put round-trip, `clearJobCache` empties all stores, openDB
   reject-then-retry path, `wrapRequest` swallows errors.
2. `use-online-status.ts` — RTL with `jest-environment-jsdom` and
   manual event dispatch. Fire `online` / `offline` → assert state.
3. `sw-update-provider.tsx` — mock `navigator.serviceWorker` surface
   (getRegistration, waiting, addEventListener). Cover: first-install
   suppresses toast (and the P1 reload bug), upgrade path shows toast
   exactly once, double-controllerchange does not double-reload.
4. `ios-install-hint.tsx` — UA + standalone mocks, matchMedia mock,
   localStorage clear between tests.

Existing verification (`npm run typecheck` / `lint` / `build`) covers
syntactic correctness only.

---

## 9. Suggested fixes (numbered, file:line)

1. **`sw-update-provider.tsx:108-113`** — gate `onControllerChange` on
   `toastShownRef.current === true` so a first-install activation does
   not trigger an unsolicited reload on a user's first-ever visit.
   (P1 §3.1)

2. **`job-context.tsx:49-52` (called from `job/[id]/layout.tsx:77`)** —
   when the fresh network fetch lands and `setJob(detail)` is called on
   a JobProvider that has a dirty state, either (a) skip the swap
   entirely, (b) merge server-wins-on-non-dirty-fields, or (c) queue
   the server copy until the user's debounced save flushes. Currently
   mid-cache-render edits are clobbered. (P1 §3.2)

3. **`dashboard/page.tsx:91-94` + `job/[id]/layout.tsx:90-92`** —
   distinguish network failures (`TypeError`) from HTTP error
   responses (5xx). Suppress error banner only for the former when
   `hadCache` is true; surface the latter so a persistent server-side
   bug doesn't silently stale the UI. (P2 §3.2)

4. **`job-cache.ts` (whole file)** — add a schema version stamp per
   record (e.g. `schemaVer: 2`) validated on read; on mismatch,
   discard the row. Protects against JobDetail shape drift across
   deploys when the user has a persistent IDB. (P1 §3.2)

5. **`ios-install-hint.tsx:73`** — extend UA detection to catch iPadOS
   13+ (which defaults to a desktop-Mac UA): add
   `/Macintosh/.test(ua) && navigator.maxTouchPoints > 1`. Without
   this, iPad Safari never sees the hint. (P1 §3.4)

6. **`use-online-status.ts:38-51`** — listen to `visibilitychange` as
   well and re-read `navigator.onLine` on `visible` transitions, to
   catch backgrounded-tab resume cases on iOS where the
   `online`/`offline` events did not fire. (P2 §3.3)

7. **`auth.ts:41-52`** — also purge the iOS install-hint dismissal key
   (`cm_pwa_ios_hint_dismissed:v1`) on sign-out if the product intent is
   "one dismissal per user" rather than "one per device". Or key the
   dismissal on userId. (P1 §4)

8. **`next.config.ts:21` — `reloadOnOnline: true`** — once the outbox
   is in play (now, per 7c), reloading on back-online resets any
   in-flight state and collides with the update-handoff reload. Worth
   re-evaluating whether this flag should stay on now that 7b's
   SWR cache + 7c's outbox already solve the underlying problem.
   (P2 §3.1)

9. **`ios-install-hint.tsx:140`** — change the inline Share icon from
   `aria-label="Share"` to `aria-hidden`; the surrounding text already
   reads "Tap the Share icon in Safari's toolbar". Removes the
   "Share Share icon" screen-reader duplication. (P2 §6)

10. **`sw.ts:199-203`** — optionally verify `event.source?.url` is
    same-origin before honouring `SKIP_WAITING`. Currently always
    same-origin by SW scope, so defence-in-depth only. (P2 §4)

11. **`dashboard/page.tsx:64-70` + `job/[id]/layout.tsx:65-71`** — the
    cache-paint guard `jobs === null` reads stale closure. Move to a
    ref or use the functional `setJobs(prev => prev ?? cached)` form
    to eliminate the theoretical strict-mode double-fire race. (P2 §5)

12. **Test scaffolding** — add the four test files described in §8
    before Phase 7c UI polish lands; the SW update + IDB layers are
    correctness-critical and currently only covered by DevTools
    walkthroughs.

---

## 10. Verdict + top 3 priorities

**Verdict: ship.** Phase 7b is well-scoped, well-documented, and the
implementation choices (vanilla IDB over `idb`, `useState` over
`useSyncExternalStore`, explicit `message` listener over
Serwist-managed skip) are defensible and consistent with the project's
"don't speculate" posture. The SW update dance is substantially safer
than 7a's auto-`skipWaiting`, which was the whole point. The IDB cache
is a real inspector-workflow improvement for site-basement / van
dead-spot cases. The offline pill and iOS hint close visible UX gaps.

That said, three issues are meaningful enough to fix before Phase 7d
touches the same surfaces:

### Top 3 priorities

1. **Cache-paint wipes in-progress edits when fresh network lands.**
   (§3.2 P1, fix §9.2.) Today no UI calls `updateJob` during layout
   fetch, so unreachable in practice — but 7c's outbox + 7d's edit UI
   will both depend on this invariant and silently break it.

2. **First-install `controllerchange` reload.** (§3.1 P1, fix §9.1.)
   Every brand-new user gets a single unsolicited page reload on first
   visit. Low impact, trivial fix.

3. **iPadOS A2HS hint miss.** (§3.4 P1, fix §9.5.) A large cohort of the
   iOS target audience (iPad on iPadOS 13+) never sees the install
   hint with the current UA regex. The whole point of the 7b4 commit is
   discoverability; missing iPads defeats that.
