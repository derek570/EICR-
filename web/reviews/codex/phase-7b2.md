## 1. Summary of the phase

Phase `7b` adds a client-side IndexedDB read-through cache for the dashboard job list and per-job detail payloads, then switches both top-level fetch sites to a stale-while-revalidate pattern. It also clears that cache on sign-out so cached job data is not left behind on shared devices.

I checked the handoff/context doc first, reviewed `git show --stat 2d3527f` and `git show 2d3527f`, then read the current working-tree files. The current tree has later drift only in [job-cache.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:1) for Phase 7c (`DB_VERSION = 2`, outbox store); [dashboard/page.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:1), [job layout](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:1), and [auth.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/auth.ts:1) are unchanged in the relevant logic.

## 2. Alignment with original plan

This implementation broadly matches the handoff and commit intent:

- It adds the promised IDB cache module and uses it at the two intended fetch sites.
- It keeps the cache best-effort and SSR-safe.
- It clears cached job data from `clearAuth()`.
- It does not overreach into write-path/offline mutation work, which the handoff explicitly deferred to 7c/7d.

What is missing is not scope, but correctness in the SWR coordination: the comments claim stale cache cannot overwrite fresher network data, but the actual closure logic does not enforce that.

## 3. Correctness issues

### P1: Late cache reads can overwrite fresher network data on both pages
- [dashboard/page.tsx:64](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:64)
- [job layout:65](</Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:65>)

Both cache callbacks test `jobs === null` / `job === null`, but those values are captured from the effect’s initial render. Because the dependency array intentionally omits `jobs`/`job`, those callbacks always see the initial `null`. If the network returns first and the cache resolves later, the stale cache can still call `setJobs(cached)` / `setJob(cached)` and clobber the fresh response. This directly contradicts the intended “late cache can’t overwrite fresh network data” behavior.

### P1: Dashboard can miss valid cached data if the network fails before IDB resolves
- [dashboard/page.tsx:82](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:82)

On network failure, the dashboard immediately does `setError(err.message)` and `setJobs([])` when `hadCache` is still `false`. If the cache read resolves slightly later, it is blocked by the same stale `jobs === null` guard path in intent, and in practice the UI is already forced into the empty/error state. Result: an offline user can still lose a perfectly valid cached dashboard, depending on timing.

### P2: The cached DB handle is never closed on `versionchange`, so future schema upgrades can be blocked by older tabs
- [job-cache.ts:86](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:86)

`openDB()` caches the `IDBDatabase` for the tab lifetime, but the code never installs `db.onversionchange = ... db.close()`. That means a later schema bump in another tab can be blocked indefinitely by an older tab holding the connection open. This was theoretical in `7b`, but it is now relevant in the current tree because Phase 7c already bumped the DB to v2.

## 4. Security issues

- `[none found, low]` I did not find a new XSS/auth/CSRF/injection/secret-leak issue introduced by this phase.
- `[note]` Clearing the cache on sign-out is defense-in-depth rather than the primary isolation boundary; the actual read paths are already keyed by `userId`.

## 5. Performance issues

- `[P2]` No eviction policy for `job-detail`; every opened job is retained until sign-out. [job-cache.ts:229](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:229) stores `cachedAt`, but nothing uses it for TTL/LRU cleanup. For inspectors with long-lived sessions and many jobs, storage can grow without bound until quota pressure starts causing silent cache-write failures.
- `[P2]` Because of the stale-closure bug above, a slower cache read can trigger an unnecessary extra render after fresh network data has already painted. [dashboard/page.tsx:64](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:64), [job layout:65](</Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:65>)

## 6. Accessibility issues

No material accessibility regressions stood out in this phase. The added behavior is mostly data-loading logic, and the visible error states continue to use `role="alert"` correctly in the touched screens.

## 7. Code quality

- The IDB helper is well-contained and keeps the surface area small; avoiding a new dependency is reasonable here.
- `cachedAt` is written but unused in Phase 7b, which suggests either incomplete freshness semantics or dead metadata. [job-cache.ts:199](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:199), [job-cache.ts:244](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:244)
- The comments in both fetch sites overstate correctness: they describe a guard against cache clobbering fresh data, but the implementation does not actually provide that guarantee. That mismatch makes future maintenance riskier.

## 8. Test coverage gaps

I did not find targeted automated coverage for this phase’s cache behavior.

Missing tests:
- Dashboard: cache resolves after network success, and must not overwrite fresh data.
- Dashboard: network fails before cache resolves, and cached jobs should still paint.
- Job layout: cache resolves after network success, and must not overwrite fresh detail.
- Auth sign-out: `clearAuth()` clears both IDB stores.
- IDB open/upgrade behavior: stale tabs release the DB on `versionchange`.

## 9. Suggested fixes

1. [web/src/app/dashboard/page.tsx:64](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:64) and [web/src/app/job/[id]/layout.tsx:65](</Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:65>)  
   Replace the `jobs === null` / `job === null` closure checks with a ref or functional-state gate that reads current state at callback time.  
   Why: the current callbacks capture the initial `null` and can overwrite fresher network data.

2. [web/src/app/dashboard/page.tsx:82](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:82)  
   Do not immediately force `setJobs([])` on network failure until the cache read has definitely completed and returned no data. Coordinate the two async paths with refs or `Promise.allSettled`.  
   Why: otherwise offline users can lose a valid cached dashboard due to timing.

3. [web/src/lib/pwa/job-cache.ts:127](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:127)  
   In `request.onsuccess`, attach `db.onversionchange = () => { db.close(); dbPromise = null; }`.  
   Why: without this, old tabs can block later schema upgrades, which is now a real concern given the current tree’s v2 upgrade.

4. [web/src/lib/pwa/job-cache.ts:199](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:199) and [web/src/lib/pwa/job-cache.ts:244](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/pwa/job-cache.ts:244)  
   Either use `cachedAt` for TTL/LRU pruning or remove it until freshness/eviction is implemented.  
   Why: right now it adds schema/storage cost without enforcing any retention policy.

5. [web/src/app/dashboard/page.tsx:84](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/dashboard/page.tsx:84) and [web/src/app/job/[id]/layout.tsx:82](</Users/derekbeckley/Developer/EICR_Automation/web/src/app/job/[id]/layout.tsx:82>)  
   Branch on `err instanceof ApiError && err.status === 401` rather than regexing `err.message`.  
   Why: the client already has a typed error surface; message matching is brittle and can miss auth failures depending on backend response text.

## 10. Overall verdict

**Ship with fixes.**

The phase is directionally right and mostly aligned with the handoff, but the two SWR race conditions are real and undercut the core promise of “cache first, then fresh, without clobbering.” Top 3 fixes:

1. Fix stale-closure cache clobbering on dashboard and job detail.
2. Fix the dashboard “network fails before cache resolves” race.
3. Add `onversionchange` DB-handle cleanup in `job-cache.ts`.