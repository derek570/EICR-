# Wave 4 Batch 2 Handoff — admin polish (6c + 6b + D12 tails)

**Branch:** `wave-4-batch-2-admin-polish` (off `web-rebuild`)
**Commits (oldest → newest):**
- `77f8c2e` — `feat(web): Wave 4 batch 2 D12 tail — parseOrThrow on login + admin writes`
- `c1d91bd` — `feat(web+backend): Wave 4 batch 2 6c — editable company_id/company_role + deactivate confirm modal`
- `69de035` — `test(backend): Wave 4 batch 2 6b tail — company-scoped settings key regression tests`

**Scope:** three interlocked tails identified during the Phase 6/Wave-2 post-mortems:
- **6c tail** — admin user-edit page exposed `company_id` / `company_role` read-only; deactivate fired on a single click.
- **6b tail** — P0-15 (shared company-settings key) had no regression test guarding the fix.
- **D12 tail** — `parseOrWarn` was the only parse mode; login + admin writes silently accepted drift.

**Status:** 116/116 vitest (up from 102; +7 adapters, +7 api-client) · 318/318 backend jest (up from 305; +7 admin-users, +5 settings-company-scope, +1 existing `/companies/list` case that tripped until the endpoint landed) · `tsc --noEmit` clean · `eslint` 0 errors / 0 warnings on the eight touched files.

---

## What was done

### Commit A — D12 tail: strict parse on login + admin writes

`web/src/lib/adapters/validate.ts`:
- New `parseOrThrow<S>(schema, data, context, httpStatus = 200)`. Same zod check as `parseOrWarn`; on drift throws `new ApiError(httpStatus, 'Response shape invalid', data)` instead of returning the raw payload. `console.warn` preserved for observability parity.

`web/src/lib/adapters/index.ts`:
- Re-exports `parseOrThrow` alongside `parseOrWarn`.
- Re-exports `CompanyLiteSchema` / `CompanyLiteListSchema` (prepped for the 6c picker; see Commit B).

`web/src/lib/adapters/admin.ts`:
- New `CompanyLiteSchema = z.object({ id: z.string(), name: z.string() })` and its list variant. Deliberately NOT re-using the full `CompanySchema` — the picker payload is an `{id, name}` lite projection.

`web/src/lib/api-client.ts`:
- `request<T>()` gains an optional `options: RequestOptions` param (`{ strict?: boolean }`). When `strict: true`, zod mismatch routes through `parseOrThrow`; default keeps `parseOrWarn`.
- `login()`, `adminUpdateUser()`, `adminResetPassword()`, `adminUnlockUser()` flipped to `{ strict: true }`.
- `adminUpdateUser` signature expanded with `company_id?: string | null` and `company_role?: 'owner' | 'admin' | 'employee' | null` (used by Commit B's picker).
- New `adminListCompanies(): Promise<CompanyLite[]>` — read path, stays on default `parseOrWarn` (a drifted name shouldn't block an admin from editing a user).

Tests:
- `web/tests/adapters.test.ts` — `parseOrThrow contract` block (5 tests: happy path, ApiError on drift, default `httpStatus=200`, custom `httpStatus`, `console.warn` observability) + `CompanyLiteListSchema` block (2 tests: happy path, missing-name rejection).
- `web/tests/api-client.test.ts` — `Wave 4 batch 2 — strict parse on login + admin writes` block (7 tests: login throw + pass, `adminUpdateUser` throw + pass, `adminResetPassword` throw, `adminUnlockUser` throw, `adminListCompanies` graceful degradation).

### Commit B — 6c: editable company_id / company_role + deactivate confirm

`web/src/app/settings/admin/users/[userId]/page.tsx`:
- `company_id` is a `<LabelledSelect>` populated from `api.adminListCompanies()`. Current assignment preserved as an option even if the list load fails.
- `company_role` picker for the three-tier enum plus a `— none —` option that writes `null`.
- `is_active` toggle no longer saves directly. A true→false transition opens a `<ConfirmDialog confirmVariant="danger">` with copy explaining token-version / existing-session semantics. Cancel reverts the toggle so the UI matches reality.

`src/routes/admin-users.js`:
- New `GET /companies/list` (mounted at `/api/admin/users/companies/list`) — returns `[{id, name}]` lite pairs only; `settings` / `is_active` / `created_at` never leak.
- `PUT /:userId` guards two new cases:
  - Self-reassignment (400) — an admin editing their own row cannot change their own `company_id` (silent company-admin-access revoke foot-gun).
  - `company_role` enum validation (400) — whitelist `owner` / `admin` / `employee` / `null`; DB column is free-text so without this a stray value persists.

`web/src/lib/types.ts`:
- New `CompanyLite` interface (`{ id: string; name: string }`).

Tests:
- `src/__tests__/admin-users.test.js` — 7 tests covering `/companies/list` lite projection + 500-on-error, self-reassign 400 + same-value no-op allowed + other-user allowed, `company_role` 400 on invalid value, acceptance of all three valid values, null clearing.

### Commit C — 6b tail: company-settings key regression tests

`src/__tests__/settings-company-scope.test.js` — 5 supertest cases against an in-process Express app with the real settings router and a stubbed storage layer that captures the S3 key on write:
- PUT `/settings/:userId/company` with `company_id` writes to `settings/company/<company_id>/company_settings.json`.
- PUT `/settings/:userId/company` without `company_id` (legacy solo admin) falls back to `settings/<user_id>/`.
- PUT `/settings/:userId/company` 403s when a company `employee` tries to write.
- PUT `/settings/:userId/defaults` stays per-user (personal preferences, not company-shared).
- PUT `/inspector-profiles/:userId` stays per-user (per-inspector signatures).

No production code changed in Commit C — the 6b fix was already comprehensive; this commit adds the guard rail.

---

## Verification

| Gate | Result |
|------|--------|
| `npm test` (backend jest) | 318 passed, 3 skipped, 1 skipped suite |
| `npm test --workspace=web` (vitest) | 116 passed across 11 test files |
| `npx tsc --noEmit` in `web/` | clean |
| `eslint` on touched files | 0 errors / 0 warnings |

The eight touched files were linted individually because the repo-root `npm run lint` has an unrelated pre-existing config issue (`eslint` 9.x rejecting the `packages/` glob pattern); that is not introduced by this branch.

---

## Why this approach

**Re-used `ApiError` (not a new `ValidationError`)** — existing `err instanceof ApiError` branches in form handlers keep working; `.status` / `.message` / `.body` are already surfaced in toast + error-banner paths.

**Opt-in `{ strict: true }` per-call, not a global default** — reads should degrade gracefully so a backend prompt-tuning change doesn't break inspector dashboards. Scoped escalation at the call site is minimum-surface-area.

**`adminListCompanies` under `/api/admin/users/companies/list` (slightly awkward URL)** — keeps blast radius to one router file. Opening a new `/api/admin` root router surface just for a single lite endpoint would have been scope creep.

**`company_id` dropdown, not typeahead** — companies table is tens, not thousands. Dropdown is simpler, works offline once cached, avoids a debounced endpoint.

**`ConfirmDialog` on deactivate only** — deactivation is the irreversible-from-UX-perspective action; role/company changes can be toggled back in a click. The friction is earned.

**Self-reassignment guard uses `!==` not just `has()`** — a no-op write of the same `company_id` still lands, matching existing partial-update save semantics elsewhere.

**In-process Express app in 6b tests (not pure unit test of `companySettingsPrefix`)** — catches a router that calls the wrong helper, not just a helper regression. Stubbed storage captures exact S3 key written.

---

## Cross-stack concerns

- **iOS**: unaffected. The JWT shape is unchanged (D4 claims retained); the new `/companies/list` endpoint is admin-only and iOS has no admin UI.
- **Backend auth middleware**: unchanged. The 6c self-reassign guard lives in the route handler, not middleware — keeps the middleware pure auth-gate.
- **Offline (Phase 7c outbox)**: `adminUpdateUser` is an admin-surface mutation. The current outbox replays job mutations only; admin writes were never queued and still aren't. No offline-replay risk from the strict-parse flip.

---

## File inventory

Modified:
- `web/src/lib/adapters/validate.ts`
- `web/src/lib/adapters/index.ts`
- `web/src/lib/adapters/admin.ts`
- `web/src/lib/api-client.ts`
- `web/src/lib/types.ts`
- `web/src/app/settings/admin/users/[userId]/page.tsx`
- `web/tests/adapters.test.ts`
- `web/tests/api-client.test.ts`
- `src/routes/admin-users.js`

Added:
- `src/__tests__/admin-users.test.js`
- `src/__tests__/settings-company-scope.test.js`
- `web/reviews/WAVE_4_BATCH_2_HANDOFF.md` (this file)

---

## Recommended next

- Merge `wave-4-batch-2-admin-polish` → `web-rebuild`.
- Consider promoting `adminCreateUser` (currently `parseOrWarn`) to strict in a future pass — it's a write path and the same "silent drift reads as success" hazard applies. Left alone here because the form already validates required fields and the failure mode is visually obvious (row doesn't appear in the list after reload).
- Phase 9 candidate: fold `/api/admin/users/companies/list` into a more sensible URL like `/api/admin/companies/list` by opening a dedicated admin-companies router. Not worth the churn as a one-off but would be natural as part of a wider admin-surface refactor.
