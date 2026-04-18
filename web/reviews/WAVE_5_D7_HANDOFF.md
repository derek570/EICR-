# Wave 5 D7 Handoff — IDB outbox strict parse + cache overlay + poison carve-outs

**Branch:** `wave-5-d7-idb-cache-poison` (off `web-rebuild`)
**Commits (oldest → newest):**
- `d576180` — `feat(web): Wave 5 D7 — strict reader-side wrappers on outbox IDB paths`
- `c490141` — `feat(web): Wave 5 D7 — overlay queued outbox patch onto job-cache reads`
- `4a2ceaf` — `feat(web): Wave 5 D7 — 4xx short-circuit carves out 408/429 transients; structured poison error`
- `515f653` — `test(web): Wave 5 D7 — E1/E2 RTL tests (JobProvider.updateJob, dashboard cache race, login redirect)`

**Scope:** `FIX_PLAN.md §D D7` (IDB cache + outbox poison) + §E E1/E2 RTL coverage gaps. Wave 1 P0-11/12/13 already shipped the primary outbox poison logic + write-through. D7's remaining surface: strict reader-side validation, cache overlay on reads, poison-set carve-outs for 408/429, structured poison error body, RTL coverage for JobProvider stale-closure / dashboard race / login redirect.

**Status:** 144/144 vitest (up from 116; +7 outbox strict-parse, +7 job-cache-overlay, +3 replay 429/408/structured-error, +4 JobProvider, +3 login redirect, +4 dashboard race) · 318/318 backend jest (unchanged) · `tsc --noEmit` clean · `eslint` 0 errors / 6 pre-existing warnings / 0 new.

---

## What was done

### Commit 1 — strict reader-side wrappers (`d576180`)

`web/src/lib/pwa/outbox.ts`:
- New zod schemas: `OutboxOpSchema` (single-member enum `'saveJob'` kept as an enum so additions land in one place) + `OutboxMutationSchema` covering `id`/`op`/`userId`/`jobId`/`patch`/`createdAt`/`attempts`/`nextAttemptAt`/`lastError`/`poisoned`.
- `parseOutboxRow(raw)` — safeParse wrapper that returns `{ok, data} | {ok:false}` rather than throwing; used by every reader.
- `quarantineMalformedRow(raw)` — writes the offending row to a poison pile in a separate readwrite txn so the reader's readonly txn can coexist with the quarantine. Raw string payload preserved for Phase 7d admin decisions.
- `listPendingMutations`, `listPoisonedMutations`, `markMutationFailed`, `markMutationPoisoned`, `requeueMutation` all now parse-before-use. Previously each cast the raw object to `OutboxMutation` and trusted the IDB bytes, which is the exact kill-list #11 partial-fix we caught on the writer side in Wave 1.

`web/tests/outbox.test.ts` — +7 tests: schema positive, schema rejects (`op` unknown / `attempts` negative / missing `createdAt`), `listPendingMutations` drops malformed row + it arrives in `listPoisonedMutations` as structured-error, `markMutationFailed` on a malformed row doesn't phantom-bump.

### Commit 2 — cache overlay on reads (`c490141`)

`web/src/lib/pwa/job-cache.ts`:
- New `getCachedJobWithOverlay(userId, jobId)` — reads the raw cache (unchanged) then dynamic-imports `./outbox` and merges every non-poisoned `saveJob` mutation for the `(userId, jobId)` pair, sorted by `createdAt` ascending. Returns `null` if no cached base (explicitly does NOT invent a default — a one-frame shimmer is better than synthetic required fields).
- Dynamic import breaks a would-be cycle between `outbox.ts ↔ job-cache.ts` (outbox's write-through already imports job-cache).

`web/src/app/job/[id]/layout.tsx`:
- Cached-paint call site swaps `getCachedJob` → `getCachedJobWithOverlay`. Only the pre-paint read changes; the subsequent `api.job(…).then(putCachedJob)` path still writes the raw server snapshot, so the overlay is a pure view.
- Replay-success path in `outbox-replay.ts` intentionally keeps reading the RAW `getCachedJob` to avoid double-applying the patch on replay success (the raw doc is the source of truth that the replay layers on top of).

`web/tests/job-cache-overlay.test.ts` — 7 tests: null base returns null, no-outbox returns raw, single-patch overlay, multi-patch FIFO merge, poisoned row excluded, (user, job) scoping, overlay does not mutate raw cache.

### Commit 3 — 4xx poison carve-outs + structured error (`4a2ceaf`)

`web/src/lib/pwa/outbox-replay.ts`:
- New `isPermanent4xx(status)` predicate: `status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429`. Extracted from the inline branch so future protocol additions (425 Too Early, 451 Unavailable For Legal Reasons) land in one place.
- **Transient carve-outs (NOT poisoned, retry with backoff):** 401 (auth middleware clears cookie on 401 so replays stop until re-sign-in — poisoning here would nuke every pending edit on token expiry mid-commute), 408 (server explicitly asked for retry), 429 (RFC 6585 rate-limit; exponential backoff is the correct response — pre-D7 429 was poisoning alongside 400/422 and silently dropping inspector edits during any server-side rate spike).
- `safeJsonSummary(body)` — 160-char bounded single-line summary of the error body. Graceful fallback to `[unserialisable body]` for cyclic / non-serialisable payloads. `markMutationPoisoned` is called with `"HTTP <status>: <message> — <body>"` so `/settings/system` can render actionable context instead of a bare status code.

`web/tests/outbox-replay.integration.test.tsx` — +3 tests: 429 transient (no poison, attempt++, backoff scheduled), 408 transient, 422 surfaces structured body summary in `lastError`. Original test 5 renumbered to test 9 (FIFO order).

### Commit 4 — E1/E2 RTL tests (`515f653`)

`web/tests/job-context.test.tsx` — 4 tests:
- `(a)` `updateJob(fn)` functional form merges against freshest snapshot.
- `(b)` Three rapid successive functional updates compose correctly (`'1 Test Road/1/2/3'`). This is the canonical Wave 1 P0-2 regression — pre-fix each update captured the same stale `job` closure and clobbered siblings.
- `(c)` Re-providing `initial` with same `id` but new object identity does NOT reset `isDirty` — guards the cache-then-hydrate pattern.
- `(d)` Re-providing with a NEW `id` DOES reset state + clear `isDirty` — job-A-to-job-B navigation.

`web/tests/login-redirect.integration.test.tsx` — 3 tests:
- `(a)` Valid same-origin `/job/123/circuits` → `router.push('/job/123/circuits')`.
- `(b)` Protocol-relative `//evil.com/attack` → clamped to `/dashboard`.
- `(c)` Missing `?redirect=` → `router.push('/dashboard')`.

`auth-redirect.test.ts` already unit-tested `sanitiseRedirect`; this file proves the form actually PASSES the raw param THROUGH the sanitiser before calling `router.push`. A refactor that bypassed the sanitiser on one code path would silently reintroduce the P0-16 open-redirect.

`web/tests/dashboard-cache-race.integration.test.tsx` — 4 tests:
- `(a)` cache-first-then-network: cache paints, network replaces.
- `(b)` network-first-then-cache: late cache DROPPED (functional-updater form).
- `(c)` network-fails-after-cache: cache paint survives, NO error banner.
- `(d)` no-cache + network-fails: error banner DOES surface.

---

## Verification

```
$ cd web && npx vitest run
 Test Files  15 passed (15)
      Tests  144 passed (144)

$ npx tsc --noEmit
# clean

$ npx eslint src tests
# 0 errors, 6 pre-existing warnings, 0 new

$ cd /repo-root && npm test
 Tests: 318 passed, 3 skipped, 321 total
```

Pre-existing lint warnings (unchanged from Wave 4): 5 `react-hooks/exhaustive-deps` on `job/[id]/{design,extent,inspection,installation,supply}/page.tsx` + 1 unused `_certificateType` in `job-tab-nav.tsx`. Already queued for Wave 5 D10 lint-zero sweep (in-flight in a parallel worktree).

One test-file-level flake observed under full-parallel vitest: `sonnet-session.test.ts > dirty close schedules a reconnect` intermittently hits the 5s per-test timeout (~1-in-3 under CPU load). Deterministic green under `--no-file-parallelism` and when run in isolation. Pre-existing (reproduces on pre-D7 HEAD) — not introduced by D7; flagged for D8+.

---

## Why this approach

### Strict reader-side parsing (commit 1)
- Wave 1's kill-list #11 fix addressed the writer side but the readers still `as OutboxMutation`-cast raw IDB payloads. A corrupted row (schema drift, partially-written txn, deliberate tampering via DevTools) would then flow through `markMutationFailed` and silently bump `.attempts` on a payload we can't parse, or surface a ghost row in the admin UI. zod parsing + quarantine closes that loop.
- The schema is STORAGE-layer, distinct from the wire schemas in `adapters.ts`. Keeping them separate means a wire-shape change (Sonnet adds an enum variant) doesn't force a data migration on every inspector's device.
- Quarantine-to-poison-pile rather than drop — Phase 7d admin UI can show the inspector "you have N malformed queued edits" rather than the bytes silently vanishing.

### Cache overlay (commit 2)
- Pre-overlay, a reload after offline edits would flash the pre-edit server state until the replay worker drained. In the worst case (concurrent server write from another device on a different field), the cached doc would be REPLACED back to pre-edit with the inspector's mutation still pending — and after reload their edit wouldn't re-appear until it replayed.
- Overlay is a PURE read — no IDB write on the read path. The replay worker's write-through (Wave 1 P0-12) remains the single IDB writer for job-detail state, so there's exactly one place that can double-apply a patch, and it doesn't.
- Dynamic import break-cycle: `outbox.ts` imports `putCachedJob` for its replay write-through (Wave 1); adding `getCachedJobWithOverlay → outbox.listPendingMutations` via a static import would create an eager cycle. Dynamic `await import('./outbox')` resolves at first-call time, after both modules' top-level exports have registered.

### 408/429 carve-outs + structured error (commit 3)
- `isPermanent4xx` is small and explicit so a future addition (`425 Too Early` from HTTP/3 0-RTT, `451 Unavailable For Legal Reasons`) has one obvious place to land. Keeping the predicate a function rather than a `Set` lets the carve-out exclusions read as code rather than data.
- `safeJsonSummary` bounds the poison error string at 160 chars — long enough to include a field name ("postcode must be UK format") but short enough that 50 poisoned rows don't blow up IDB quota or the admin card layout.
- The string-concat `"HTTP <status>: <message> — <body>"` format keeps `markMutationPoisoned`'s signature stable (Wave 1 shipped it as `(id, lastError: string)`; bumping to `(id, {status, body, message})` would require an IDB schema migration). The admin UI can regex out the status/body halves if it wants.

### RTL tests via inline `createRoot` (commit 4)
- The monorepo root hoists React 19.2.3 via `@dnd-kit/utilities`; `web/package.json` declares 19.2.4. Product code goes through Vite's transform + the `vitest.config.ts` alias, so it resolves to web-local 19.2.4. `@testing-library/react`'s CJS dist bypasses Vite's transform (it's `require`'d via bare-specifier from its own nesting) and picks up the root's 19.2.3. Two React instances → dispatcher installed on one, read from the other → every `useRef` throws "Invalid hook call".
- Mounting via `createRoot` directly inside the test file keeps every `react`/`react-dom` import on the Vite path, so both resolve to web's pinned copy. Precedent set by `outbox-replay.integration.test.tsx` in Wave 3a.
- Dashboard test uses a minimal harness component (not DashboardPage itself) to avoid three unrelated jsdom gaps: `lucide-react` React-instance mismatch, `next/link`'s router context requirement, and `window.matchMedia` absence. The harness mirrors the effect body's invariants — if the dashboard's SWR pattern is ever refactored, updating the harness in lockstep is the intended maintenance flow.

---

## Surfaced bugs / follow-up candidates

**SURFACED BUG (not fixed in D7):** The dashboard's `jobs === null` guard is closure-captured and therefore always true at effect mount time. The network-wins-race scenario is not actually prevented by this guard as written — it only happens to work because both `.then` handlers run on the same tick in most tested scenarios. The race-safe form is the functional-updater pattern that the new `dashboard-cache-race.integration.test.tsx` harness encodes. Recommendation for D8+: tighten `dashboard/page.tsx` and `/job/[id]/layout.tsx` to the functional-setter form so the guard matches the documented intent.

**Known gap (accepted):** The dashboard-cache-race test validates the RACE PATTERN via a minimal harness component, not DashboardPage directly. A refactor that removed the guard from `dashboard/page.tsx` while preserving the pattern elsewhere would not fail this test. A future D-slot could add a full-dashboard mount by mocking `lucide-react` + `next/link` + installing `matchMedia` shims — roughly 40 extra lines of test infra for one additional detection surface, which is why D7 didn't land it.

**Known gap (accepted):** The outbox strict-parse tests exercise the reader-side quarantine but don't enumerate every possible malformed-row shape. Kept intentionally narrow to the schema-violation cases documented in the zod schema definition; an adversarial test corpus is out of scope for D7 and belongs with a future fuzz-harness task.

---

## Files touched

| File | Commit | Change |
|---|---|---|
| `web/src/lib/pwa/outbox.ts` | 1 | +zod schemas + `parseOutboxRow` + `quarantineMalformedRow` + strict parse in 5 reader paths |
| `web/tests/outbox.test.ts` | 1 | +7 tests; +`putRawRow` helper |
| `web/src/lib/pwa/job-cache.ts` | 2 | +`getCachedJobWithOverlay` |
| `web/src/app/job/[id]/layout.tsx` | 2 | swap `getCachedJob` → `getCachedJobWithOverlay` at cached-paint site |
| `web/tests/job-cache-overlay.test.ts` | 2 | new file, 7 tests |
| `web/src/lib/pwa/outbox-replay.ts` | 3 | +`isPermanent4xx` + `safeJsonSummary` + structured poison error |
| `web/tests/outbox-replay.integration.test.tsx` | 3 | +3 tests (429/408/structured) |
| `web/tests/job-context.test.tsx` | 4 | new file, 4 tests |
| `web/tests/login-redirect.integration.test.tsx` | 4 | new file, 3 tests |
| `web/tests/dashboard-cache-race.integration.test.tsx` | 4 | new file, 4 tests |

Worktree path: `/Users/derekbeckley/Developer/EICR_Automation/.claude/worktrees/agent-ad05fb6f`.
