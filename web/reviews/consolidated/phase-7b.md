# Phase 7b — Consolidated Review (ce8323a / 2d3527f / a85487f / 1ec4e22)

Consolidates Claude's one combined review of the whole phase against Codex's
four per-sub-commit reviews (7b1 SW update handoff, 7b2 IDB read-through,
7b3 offline indicator, 7b4 iOS A2HS hint). Attribution to sub-commits is by
file path when Claude's review does not name one explicitly.

---

## 1. Phase summary

Phase 7b delivers the user-facing PWA offline-read slice: 7b1 replaces the
unconditional `skipWaiting` with a user-mediated SW update handoff (sonner
toast + `SKIP_WAITING` message), 7b2 adds a vanilla-IDB read-through cache
(`certmate-cache`, two stores) for the dashboard list and job detail with a
fire-and-forget write-back, 7b3 mounts an amber AppShell offline pill driven
by `navigator.onLine`, and 7b4 adds a dismissible Safari/iOS Add-to-Home-Screen
hint on `/settings`. The four sub-commits ship in the mandated order (update
handoff first) and the deferred items (outbox, edit UI, TTL/eviction, Sentry)
stay out of scope — outbox arrives later in 7c.

---

## 2. Agreed findings per sub-commit

### 7b1 — SW update handoff (ce8323a)

- **[P1] [Correctness] `sw-update-provider.tsx:108-113`** — `controllerchange`
  listener reloads unconditionally; on a first-ever install with
  `clientsClaim: true` (`sw.ts:86`), the browser fires `controllerchange`,
  `toastShownRef` is false, `reloadedRef` flips true, and the page reloads
  without any user action. Gate `onControllerChange` on a new
  `reloadRequestedRef` / `acceptedUpdateRef` that is set only inside the toast
  action. (Claude §3.1 P1, Codex 7b1 §3 P1 — identical.)

- **[P2] [Correctness] `sw-update-provider.tsx:80-106`** — `watchRegistration`
  only checks `registration.waiting` and attaches an `updatefound` listener;
  an SW already in `installing` state at the moment `getRegistration()`
  resolves is never observed, so that upgrade is not prompted until the next
  full navigation. Factor a `watchInstalling(worker)` helper, call it for
  `registration.installing` immediately plus inside `updatefound`.
  (Claude §3.1 P2 / §7 nit, Codex 7b1 §3 P2.)

- **[P2] [Test coverage]** — no automated tests for SW lifecycle
  (first-install no-reload, waiting-at-load → one toast, accept → reload
  exactly once, duplicate `controllerchange` does not double-reload). Both
  reviewers flag Playwright browser tests as the appropriate layer.
  (Claude §8, Codex 7b1 §8.)

### 7b2 — IDB read-through cache (2d3527f)

- **[P1] [Correctness] `dashboard/page.tsx:64` + `job/[id]/layout.tsx:65`**
  — the cache callback guards with `jobs === null` / `job === null`, but the
  effect's dep array intentionally omits those values, so the closure always
  sees the initial `null`. If the network returns first and IDB resolves
  second, the stale cache calls `setJobs(cached)` / `setJob(cached)` and
  clobbers the fresh data — directly contradicting the commit-message claim
  that "late cache cannot overwrite fresh network data". Replace with a ref
  or the functional `setJobs(prev => prev ?? cached)` form.
  (Claude §5 P2 / §9.11 — Claude under-graded this as P2 "harmless
  idempotent double-fire"; Codex 7b2 §3 P1 correctly identifies it as a
  clobber. Consolidated severity: **P1** — Codex is right.)

- **[P1] [Correctness] `job/[id]/layout.tsx` (fetch `.then` → `setJob(detail)`)
  + `job-context.tsx:49-52`** — when the fresh network fetch lands, the
  layout calls `setJob(detail)`; `JobProvider`'s `useEffect([initial])` runs
  `setJob(initial)` **and** `setIsDirty(false)`, wiping any in-flight local
  edits made during the cache-paint window. The commit message dismisses
  this as "callers above don't re-provide" but the layout itself is the
  caller. No current UI calls `updateJob` during layout fetch, so unreachable
  today — but 7c outbox + 7d edit UI depend on this invariant. Fix: skip
  the swap when `isDirty`, or merge server-wins-on-non-dirty-fields.
  (Claude §3.2 P1 — Codex-unique miss; Claude identified it.)

- **[P2] [Reliability] `job-cache.ts` openDB** — no
  `db.onversionchange = () => db.close()`. An older tab holding the handle
  open blocks a later schema upgrade; already practically relevant because
  7c has already bumped to `DB_VERSION = 2`.
  (Codex 7b2 §3 P2, Claude §3.2 P2 on `clearJobCache` includes STORE_OUTBOX
  — same area. Consolidated: **P2** reliability.)

- **[P2] [Correctness] `dashboard/page.tsx:91-94` + `job/[id]/layout.tsx:90-92`**
  — error banner suppressed whenever `hadCache` is true. HTTP 5xx gets
  silently swallowed so a persistent server bug leaves the user on stale
  cache forever (pill won't fire because `navigator.onLine === true`).
  Distinguish network failures (`TypeError`) from HTTP errors and only
  suppress the former. (Claude §3.2 P2 — Codex 7b2 flagged adjacent race
  at `dashboard/page.tsx:82`; both cluster on the same error-handling code
  path.)

- **[P2] [Code quality] `job-cache.ts:199, 244`** — `cachedAt` written but
  never read. Either use for TTL/LRU or remove until eviction lands.
  (Codex 7b2 §5/§7. Claude §3.2 P1 "no cache TTL / version invalidation"
  overlaps — add a `schemaVer` per record.) Consolidated: **P2**.

- **[P2] [Test coverage]** — no tests for `job-cache.ts` get/put round-trip,
  `clearJobCache` empties stores, late-cache-after-network race, network-
  fails-before-cache race, `onversionchange` behaviour. Both reviewers
  agree on the gap. (Claude §8.1, Codex 7b2 §8.)

### 7b3 — AppShell offline indicator (a85487f)

- **[P1] [Accessibility/Copy] `offline-indicator.tsx:54`** — `aria-label`
  claims "changes will not sync until your connection returns", which
  implies an outbox/queued-write model that 7b does NOT ship (handoff
  explicitly says offline writes are out of scope in 7b — outbox arrives
  in 7c). Rewrite to remove the sync-later promise: "You are offline.
  Some data may be previously loaded. Reconnect before making changes."
  (Codex 7b3 §3 P1 — Codex-unique; Claude did not flag the copy.)

- **[P1] [Reliability] iOS Safari `navigator.onLine`** — semantics are
  unreliable on iOS: captive portals, low-power transitions, lock cycles,
  airplane toggles while backgrounded all leave the OS reporting
  "connected" while HTTP traffic fails. The pill will silently fail during
  inspector basement/dead-spot scenarios. Defensible caveat for 7b but
  should be planned for: add a reachability probe (HEAD on
  `/api/health/ready`) triggered by failed fetches. (Claude §3.3 P1.)

- **[P2] [Reliability] `use-online-status.ts`** — listen for
  `visibilitychange` and re-read `navigator.onLine` on `visible` to catch
  backgrounded-tab resume where iOS does not replay missed `online`/
  `offline` events. (Claude §3.3 P2.)

- **[P2] [Test coverage]** — no tests for `useOnlineStatus` (SSR default,
  mount correction, event transitions) or `OfflineIndicator` render/null
  behaviour. (Codex 7b3 §8, Claude §8.2.)

### 7b4 — iOS Add-to-Home-Screen hint (1ec4e22)

- **[P1] [Correctness] `ios-install-hint.tsx:73`** — UA regex
  `/iPad|iPhone|iPod/.test(ua)` misses iPadOS 13+ Safari, which by default
  reports a Mac desktop UA. A large cohort of the iPad target audience
  never sees the hint. Augment with
  `(navigator.platform === 'MacIntel' || /Macintosh/.test(ua)) &&
  navigator.maxTouchPoints > 1`. (Claude §3.4 P1, Codex 7b4 §3 P1 —
  identical finding, different expression.)

- **[P2] [Reliability] `ios-install-hint.tsx:82`** — `localStorage.getItem`
  has no try/catch even though `setItem` does. In "Block All Cookies" iOS
  Safari, the effect throws and `setVisible(true)` never runs — the
  failure mode is benign (banner stays hidden) but inconsistent with the
  stated resilience goal. Wrap read in the same safe-storage helper.
  (Codex 7b4 §3 P2, Claude §3.4 P2 — both agree on the finding;
  disagree only on how bad it is — consolidated P2 because it fails
  closed safely.)

- **[P2] [A11y] `ios-install-hint.tsx:103`** — region
  `aria-label="Install CertMate on your iPhone"` excludes iPad users who
  will start seeing the banner once the UA fix lands. Use platform-neutral
  "Install CertMate on your device" or "Add CertMate to your Home
  Screen". (Codex 7b4 §6 P2 — Codex-unique.)

- **[P2] [A11y] `ios-install-hint.tsx:140`** — inline Share icon has
  `aria-label="Share"` inside a sentence that already says "Tap the Share
  icon in Safari's toolbar", producing a duplicated "Share Share" screen-
  reader readout. Change to `aria-hidden`. (Claude §6 P2, Codex 7b4 §6 P2
  — identical.)

- **[P1] [Security/UX] `auth.ts:41-52` vs localStorage key** — dismissal
  key `cm_pwa_ios_hint_dismissed:v1` persists across sign-outs on shared
  devices. User A dismisses → user B signs in, never sees hint, defeats
  discoverability. Either key the value per-userId or purge in
  `clearAuth()`. (Claude §4 P1 — Codex-unique miss; Claude identified it.)

- **[P2] [Test coverage]** — no tests for iPhone UA render, iPadOS UA
  render, standalone suppression, dismissed suppression, storage failure
  paths. (Codex 7b4 §8, Claude §8.4.)

---

## 3. Disagreements + adjudication

### 7b2 — severity of the stale-closure cache race

- **Claude** (§5 P2 / §9.11) classifies the `jobs === null` / `job === null`
  closure race as a harmless "theoretical strict-mode double-fire",
  suggesting `setJobs(prev => prev ?? cached)` purely as polish.
- **Codex 7b2** (§3 P1) classifies the same closure as a real clobber:
  late IDB read overwrites fresher network data.

**Adjudication: Codex is right, severity is P1.** The closure captures
`jobs === null` from first render; the dep array omits `jobs`; the
network-completes-first-then-cache-resolves ordering is not strict-mode
specific and does happen (IDB is slower than a warm HTTP cache on many
devices). The functional-setter fix Claude proposes in §9.11 is exactly
what resolves the P1 Codex raised.

### 7b1 — whether to handle `registration.installing`

- **Codex 7b1** (§3 P2) lists this as a real race to fix.
- **Claude** (§3.1 P2) dismisses it as "actually safe because
  `registration.waiting` at `:84` will still catch it".

**Adjudication: Codex is right on the narrow window.** There is a small
interval where the worker has fired `updatefound` and advanced to
`installing` but not yet `installed`, and if the user's `getRegistration()`
resolves in that window, `registration.waiting === null` AND `updatefound`
has already fired, so the new `addEventListener('updatefound')` will never
see it again. Severity **P2** (narrow window; next navigation recovers).

### 7b2 — `dbPromise` sticky-failure race

- **Claude** (§3.2 P1) initially tags as P1 then self-downgrades to P2,
  concluding the sync Promise assignment is safe.
- **Codex 7b2** does not raise it.

**Adjudication: downgrade to noted-only (see §6 Dropped).** Claude's own
walk-through concludes the code is safe.

### 7b3 — whether the `aria-label` overreaches

- **Codex 7b3** (§3 P1) — the copy promises sync-later that 7b does not
  ship.
- **Claude** does not flag this (her a11y section approves `role="status"`/
  `aria-live` without auditing the string).

**Adjudication: Codex is right, severity P1.** The handoff explicitly
defers offline writes, and the commit message for 7b3 is clear that edits
"still vanish". The user-facing copy must not contradict. Fix before 7d
touches the same surface.

---

## 4. Claude-unique findings

### 7b1

- **[P2] `reloadOnOnline: true` collision** — `next.config.ts:21` leaves
  Serwist's built-in `reloadOnOnline` enabled; after a user accepts the
  update toast while offline, a later online transition can trigger a
  second Serwist-managed reload. Idempotent (no data loss) but a
  polish issue; re-evaluate the flag now that 7b's cache + 7c's outbox
  cover the underlying UX. (Claude §3.1 P2 / §9.8.)

- **[P2] same-origin `ServiceWorker.postMessage` check** — defence-in-depth
  only; SW scope is already same-origin. Keep in mind, no fix required.
  (Claude §3.1 P1 note / §9.10.)

- **[P2] `navigator.serviceWorker.controller` access inside long-lived
  closure** (`sw-update-provider.tsx:93`) — could throw in edge-case
  privacy modes. Low likelihood. (Claude §3.1 P1 — self-downgraded.)

### 7b2

- **[P1] mid-edit clobber via `JobProvider`** (see §2 above — Claude's
  finding, not Codex's).

- **[P1] schema drift when JobDetail shape changes across deploys** —
  add a per-record `schemaVer` validated on read, discard on mismatch.
  (Claude §3.2 P1 / §9.4.)

- **[P1] `putCachedJobs` races with sign-out** (`dashboard/page.tsx:80`) —
  fire-and-forget write-back may commit after `clearJobCache()` runs.
  Stamp writes with a session token or await before sign-out. (Claude
  §3.2 P1.)

### 7b3

- **[P1] iOS Safari `navigator.onLine` unreliability** — captive portals,
  low-power, etc. Defensible caveat for 7b but plan the reachability probe.
  (Claude §3.3 P1.)

- **[P2] `visibilitychange` backgrounded-tab replay** — add listener and
  re-read `onLine` on `visible`. (Claude §3.3 P2 / §9.6.)

- **[P1] sonner toast a11y** — verify the toast Action button is focusable
  and tab-reachable; persistent toast that isn't focusable is ignorable
  by keyboard users. (Claude §6 P1.) Note: technically a 7b1-layer
  concern but surfaces here.

### 7b4

- **[P1] dismissal key survives sign-out on shared devices** (§4 P1) —
  see consolidated §2.

- **[P2] numbered `<ol>` circles** — visible "1"/"2" text alongside `<ol>`
  semantics produces duplicate screen-reader readouts; `aria-hidden`
  the visible numbers. (Claude §6 P2.)

- **[P2] display-mode coverage** (`fullscreen`, macOS dock-install) —
  no user impact because macOS UA never matches, but noted. (Claude §3.4
  P2.)

---

## 5. Codex-unique findings

### 7b1

- **[P2] Unhandled rejection on `getRegistration()`** (`sw-update-provider.tsx:104-106`)
  — no `.catch(...)`; transient SW registration failures / privacy-mode
  can emit an unhandled promise rejection from a root-mounted effect.
  Wrap with `.catch`, plus defensive error handling around
  `waiting.postMessage` — show a fallback "Refresh to update" path or
  reset toast state if the waiting worker is gone/redundant.
  (Codex 7b1 §3 P2 / §9.3.)

### 7b2

- **[P1] network-fails-before-cache-resolves race**
  (`dashboard/page.tsx:82`) — on network failure, the dashboard
  immediately calls `setError(err.message)` + `setJobs([])` when
  `hadCache` is still false; if IDB resolves slightly later the UI is
  already forced to empty/error and the cache path is stale-gated out.
  Coordinate both async paths with refs or `Promise.allSettled`.
  (Codex 7b2 §3 P1.)

- **[P2] error classification via regex on `err.message`**
  (`dashboard/page.tsx:84`, `job/[id]/layout.tsx:82`) — the client has
  a typed `ApiError`; branch on `err instanceof ApiError && err.status === 401`
  rather than message text. (Codex 7b2 §9.5.)

- **[P2] no `job-detail` eviction** — `cachedAt` written and unused;
  long-lived sessions grow unbounded until quota pressure. (Codex 7b2
  §5/§7.)

### 7b3

- **[P1] misleading sync-later copy in `aria-label`** (see §3
  adjudication — adopted as P1).

- **[P2] `title` shortens the full explanation** (`offline-indicator.tsx:55`)
  — handoff said both `title` and `aria-label` should carry the full
  string. Align them to the same corrected message or drop `title`.
  (Codex 7b3 §6 P2.)

### 7b4

- **[P2] `localStorage.getItem` throws in restricted storage** — paired
  with safe-storage helper refactor. (Codex 7b4 §3 P2.)

- **[P2] iPhone-only region label** (`ios-install-hint.tsx:103`) — see
  §2 above (adopted). (Codex 7b4 §6 P2.)

---

## 6. Dropped / downgraded

- **Claude §3.2 — `dbPromise` sticky-failure race on concurrent first
  open** — Claude's own walk-through concludes the sync Promise assignment
  is safe; downgraded from P1 to note-only. No action.

- **Claude §3.1 — `sw.ts` message-source validation** — Claude raises and
  self-dismisses; cross-origin postMessage to a same-origin SW scope is
  impossible. No action needed.

- **Claude §3.1 P2 — `updatefound` missed between `getRegistration`
  resolve and listener attach** — Claude documents, walks through, and
  confirms safe. Codex 7b1's overlapping §3 P2 is distinct (the
  `installing`-window race) and is adopted. Drop the generic
  "resolve-then-attach" framing.

- **Claude §3.4 P2 — `'MSStream' in window`** — confirmed as zero-cost
  legacy guard. No action.

- **Claude §3.4 P2 — no suppression if user just clicked Share** —
  acknowledged as acceptable staleness in the handoff; Codex did not
  raise. No action.

- **Claude §4 P2 — cached IDB data across shared devices** — correctly
  identified as a broader sign-out / crash-recovery problem not specific
  to 7b. No action within 7b scope.

- **Claude §5 — IDB connection cold-path / double transaction** — noted
  as expected / fire-and-forget; no action.

- **Claude §5 — `useOnlineStatus` multi-consumer event-listener
  duplication** — only one consumer today; revisit if adoption grows.
  No action.

- **Claude §5 — sonner toast `duration: Infinity` memory** —
  negligible; no action.

- **Claude §7 — `job-cache.ts:125` `void event;` micro-nit** — no action.

- **Claude §7 — `DB_VERSION = 2` header-JSDoc jarring** — stylistic, no
  action (was a 7c change layered on 7b).

- **Codex 7b2 §4 — sign-out clearing as defense-in-depth** — noted as
  not-a-finding.

---

## 7. Net verdict + top 3 priority fixes

**Verdict: ship with fixes.**

Both reviewers agree Phase 7b is well-scoped, well-ordered (7b1 first, as
the handoff mandated), and the user-facing value (safe update handshake,
offline dashboard+detail, visible offline state, iOS installability) is
real. The combined review flagged **6 P1s and ~12 P2s across 4 sub-commits,
plus 1 genuine disagreement (the 7b2 stale-closure race severity, resolved
as P1)**. Test coverage is uniformly absent — 4 files across the phase
have zero Vitest/Playwright coverage for correctness-critical async
behaviour.

The three issues below should land before Phase 7d edits the same
surfaces.

### Top 3 priority fixes (across all four sub-commits)

1. **7b1 — gate `controllerchange` reload on explicit user acceptance.**
   `sw-update-provider.tsx:108-113` — introduce `reloadRequestedRef`,
   set inside the toast action only, early-return in `onControllerChange`
   otherwise. Fixes the first-install unsolicited reload identified by
   both reviewers.

2. **7b2 — fix the stale-closure cache clobber on both SWR sites.**
   `dashboard/page.tsx:64` + `job/[id]/layout.tsx:65` — replace the
   closure `jobs === null` / `job === null` guard with the functional
   `setJobs(prev => prev ?? cached)` form (or a ref). Additionally,
   guard the `JobProvider` `useEffect([initial])` overwrite
   (`job-context.tsx:49-52`) against `isDirty`, so 7c outbox + 7d edit
   UI can rely on the cache not wiping in-flight edits.

3. **7b4 — fix iPadOS UA detection in the A2HS hint.**
   `ios-install-hint.tsx:73` — extend with
   `(navigator.platform === 'MacIntel' || /Macintosh/.test(ua)) &&
   navigator.maxTouchPoints > 1`. Without this, a large cohort of the
   iPad target audience never sees the hint the sub-commit was written
   to deliver.
