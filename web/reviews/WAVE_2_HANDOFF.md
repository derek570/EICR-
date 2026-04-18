# Wave 2 Handoff — Contract Alignment + Test Scaffolding

**Branch:** `web-rebuild`
**Scope:** `FIX_PLAN.md §F. Wave 2 — Contract alignment + test scaffolding`
**Status:** D6 ✅ · D12 ✅ · D2 deferred to Wave 2b · 32/32 tests green · `tsc --noEmit` clean · `npm run lint` clean (0 errors, 6 pre-existing warnings)

---

## What was done

Wave 2 is split into two halves in the plan:
- **2a (this handoff):** D6 (test harness stood up) + D12 (ApiError JSON envelope parsing) + regression tests backfilling Wave 1 fix surfaces.
- **2b (deferred):** D2 (adapter layer + zod schemas + `@certmate/shared-types` reuse). Sized too large to land alongside harness bring-up without losing coherence; handed off below.

### D12 — ApiError JSON envelope parsing

| File | Change |
|---|---|
| `web/src/lib/types.ts` | `ApiError` gained a third constructor arg — `public body?: unknown`. Structured parsed body is now reachable on thrown errors. |
| `web/src/lib/api-client.ts` | Added `parseErrorBody(res)` — reads `content-type`, `JSON.parse`s when applicable, lifts `{error: "..."}` to `.message`, preserves the full parsed shape on `.body`, falls through to `res.text()` for non-JSON error bodies. Both `request()` branches (`res.ok === false` and the fetch-throws path) now thread through. |
| `web/src/app/dashboard/page.tsx` | `/401/.test(err.message)` → `err instanceof ApiError && err.status === 401`. |
| `web/src/app/job/[id]/layout.tsx` | Same replacement. |

**Why:** pre-D12 the error toast rendered `{"error":"Unauthorised"}` literally on any 4xx from the backend, because `src/routes/*.js` always wraps errors in `{error: "..."}`. The old dashboard/job-layout regex `/401/.test(err.message)` would match `{"error":"401 expired"}` but MISS `{"error":"Unauthorised"}`, leaking users past the sign-out redirect. Branching on `.status` is semantically correct (it's the HTTP contract) and lets the parsed body travel with the error for advanced consumers without forcing everyone through `JSON.parse`.

**Why this approach:** the naive alternative was to `res.json()` every error and give up on non-JSON responses; fail-soft `parseErrorBody` handles HTML error pages (nginx 502s, Cloudfront 5xx HTML) the same way the old code did but with structured bodies when available. No call-site migration required — `.message` is still string-valued.

### D6 — Test harness

Stood up vitest 4 + jsdom 29 + @testing-library/react 16 + @testing-library/jest-dom 6 + fake-indexeddb 6.

| File | Purpose |
|---|---|
| `web/vitest.config.ts` (new) | jsdom env, `@/` alias → `web/src`, setup file wiring, 5s test timeout. |
| `web/tests/setup.ts` (new) | Extends vitest's `expect` with jest-dom matchers; side-effect-imports `fake-indexeddb/auto`; installs an in-memory `localStorage`/`sessionStorage` shim. |
| `web/package.json` | `"test": "vitest run"`, `"test:watch": "vitest"`. Devdeps: vitest, @vitest/ui, @vitejs/plugin-react, @testing-library/{react,jest-dom,user-event}, jsdom, fake-indexeddb. |

Two harness-shaped decisions worth surfacing for the next session:

1. **jest-dom wiring.** The stock `import '@testing-library/jest-dom/vitest'` shorthand breaks in this monorepo because npm hoists `jest-dom` to the workspace-root `node_modules`, where vitest isn't installed (it only lives in `web/node_modules`). The shorthand's internal `import 'vitest'` fails resolution. Fix: explicit `import * as matchers from '@testing-library/jest-dom/matchers'; expect.extend(matchers)` in `tests/setup.ts`. Import graph stays inside `web/`, so the bare-specifier lookup works.

2. **localStorage shim.** jsdom 29 under vitest 4 installs `Storage.prototype` on `window` but the `localStorage` instance's methods (`getItem`, `setItem`, `clear`) don't reliably resolve as own or inherited properties — accessing `localStorage.getItem` throws `TypeError: not a function`. Rather than chase jsdom internals, `setup.ts` replaces both storage globals with a plain `Map`-backed `Storage` implementation. Only auth.ts consumes `localStorage` so the surface is narrow.

### Regression backfill — Wave 1 fix surfaces

5 test suites, 32 test cases. One file per surface from `WAVE_1_HANDOFF.md → Recommended next wave`, plus the D12 cases.

| Test file | Covers | Cases |
|---|---|---|
| `web/tests/auth-redirect.test.ts` | P0-16 — `sanitiseRedirect` rejects `//evil.com`, `\\evil.com`, absolute URLs; accepts single-leading-slash paths. | 5 |
| `web/tests/middleware.test.ts` | P0-4 (dotted dynamic paths don't bypass auth, genuine static assets do, `/api/*` passthrough) + P0-5 (employee blocked from `/settings/company/dashboard`, owner/admin allowed, system admin allowed, non-admin blocked from `/settings/admin`) + expired/missing token. | 7 |
| `web/tests/apply-ccu-analysis.test.ts` | P0-3 — multi-board scoping, `board_model → board_model` + `name` dual-write, null-safe SPD path. | 3 |
| `web/tests/outbox.test.ts` | P0-11 (strict IDB writes + FIFO), P0-12 (4xx poisoning + head-of-line skip), Q3 (`MAX_ATTEMPTS === 15` poisons after N failures), exp backoff, requeue/discard/purge. | 12 |
| `web/tests/api-client.test.ts` | D12 (envelope lift, structured body preserved, text fallthrough, 401 by status not regex) + P0-1 (saveJob uses PUT). | 5 |

**Why only 5 surfaces:** these are the five Wave 1 fixes with pure-function seams suitable for unit tests without a React component tree or backend round-trip. The rest — P0-2 (JobProvider functional updater), P0-7/8 (AudioWorklet + Deepgram reconnect), P0-13 (cache write-through across replay), P0-14 (SW `controllerchange` latch) — all require RTL + MSW or a service-worker mock harness that's right-sized for Wave 3/4 alongside their deeper fixes.

**Isolation strategy:** outbox tests reset state via `purgeOutbox()` (a `store.clear()` on the live connection) rather than `indexedDB.deleteDatabase(DB_NAME)`. The outbox module caches `dbPromise` at module scope, so `deleteDatabase` blocks waiting for the open handle and hangs `beforeEach` at the vitest hook timeout. This is documented inline in `tests/outbox.test.ts` so future test authors don't repeat the mistake.

---

## Verification

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  5 passed (5)
      Tests  32 passed (32)
   Duration  716ms

$ ../node_modules/.bin/tsc --noEmit
# clean

$ npm run lint
# 0 errors, 6 pre-existing warnings (unrelated to Wave 2)
```

Pre-existing lint warnings are the `useCallback` dep warnings on job-tab page files and one unused `_certificateType` — all pre-date Wave 2 and are tracked under Wave 4 polish.

---

## Why this approach

D12 + D6 share a causal link: D12 is the smallest behavioural fix that makes the harness testable at the HTTP boundary without MSW. Landing D12 first unblocked `api-client.test.ts` cleanly; landing D6 first would have meant writing the D12 tests twice (once against `TypeError: Unexpected token` and once against `ApiError.status`). Doing them together in Wave 2a is the right unit.

Tests-per-Wave-1-fix was a deliberate trade: rather than writing a hermetic abstract "outbox state machine" suite, each test file names the defect number it's pinning. When Wave 3's recording hardening touches these surfaces the fix author can re-read the specific regression it's supposed to prevent, not a generic behavioural spec.

D2 (the adapter layer) was deferred because:
1. It's the biggest item in the plan (L sized in FIX_PLAN §D).
2. It needs `@certmate/shared-types` consumer migration across 14+ tab pages — much of which is already typed against the Partial<Record<string,unknown>> shapes the plan wants to replace.
3. Landing it atomically with Wave 2a's 600-line harness bring-up would make the PR untestable and un-reviewable.

Wave 2b should open with D2 as its primary goal and nothing else.

---

## Recommended next wave

Per `FIX_PLAN.md §F`:

- **Wave 2b — D2 adapter layer.** Introduce `web/src/lib/adapters/` with zod schemas per API response (`GET /api/job`, `GET /api/job/:userId/:jobId`, `GET /api/settings/:userId/company`, etc.). Migrate `api-client.ts` callers to the parsed types. Shared-types-first for fields that round-trip between iOS/web (InspectorInfo, CircuitRow, ObservationRow). Runtime validation only at the adapter boundary — internal code trusts its types.
- **Wave 3 — Recording hardening.** D7 (already partially delivered as P0-11/12/13 in Wave 1; remaining work is the replay-path observability tests against MSW) + D11 (component de-dupe) + E7 (Deepgram reconnect tests with a fake WS server).

Wave 3 blocks on 2b landing only for the NumberNormaliser parity tests — those want the adapter-parsed circuit types so the fake readings match the wire shape without hand-rolled fixtures.

---

## Remaining known gaps (genuinely deferred)

- **Integration layer (RTL + MSW).** D6 called for three test tiers; only the unit tier is live. MSW stand-up is the right Wave 2b companion since most integration surfaces (JobProvider.updateJob, dashboard cache race, login redirect rules) want adapter-parsed fixtures anyway.
- **E2E (Playwright).** Deferred to Wave 5 (`FIX_PLAN.md §F Wave 5 — polish + E2E`). No harness cost in Wave 2b.
- **Telemetry on outbox poisoning.** Carried forward from Wave 1 Q3. Needs a `/api/metrics/outbox-poisoned` surface; sized for Wave 4 alongside the admin a11y sweep which already touches the admin dashboard.
- **Lint warnings (6).** Five `react-hooks/exhaustive-deps` on tab pages + one unused `_certificateType`. Wave 4 polish.

---

## File inventory

**Added:**
- `web/vitest.config.ts`
- `web/tests/setup.ts`
- `web/tests/auth-redirect.test.ts`
- `web/tests/middleware.test.ts`
- `web/tests/apply-ccu-analysis.test.ts`
- `web/tests/outbox.test.ts`
- `web/tests/api-client.test.ts`
- `web/src/lib/auth-redirect.ts` (extracted `sanitiseRedirect` from `login/page.tsx` so the function is importable without pulling React + `useSearchParams`).

**Modified:**
- `web/src/lib/types.ts` — `ApiError.body` field.
- `web/src/lib/api-client.ts` — `parseErrorBody` helper; both error paths in `request()`.
- `web/src/app/dashboard/page.tsx` — 401 classifier.
- `web/src/app/job/[id]/layout.tsx` — 401 classifier.
- `web/src/app/login/page.tsx` — import `sanitiseRedirect` from the new module.
- `web/package.json` — test scripts + dev deps.

---

D6 + D12 landed. Wave 2b (D2 adapters) is the right next unit of work.
