# Phase 6b — Consolidated Review

**Commit:** `6e85e9e` — feat(web): Phase 6b company settings + company-admin dashboard
**Sources:** `web/reviews/claude/phase-6b.md`, `web/reviews/codex/phase-6b.md`, `web/reviews/context/phase-6b.md`
**Scope verified against source:** `web/src/middleware.ts`, `src/routes/settings.js`, `src/routes/companies.js`, `web/src/app/settings/company/page.tsx`

---

## 1. Phase summary

Phase 6b lands the company branch of the Settings rebuild:

- `GET/PUT /api/settings/:userId/company` wired to a new `/settings/company` page (visible to all authenticated users, editable by company admins).
- A dedicated logo endpoint: `POST /api/settings/:userId/logo` (multer, 10 MB cap, PNG/JPEG only — SVG rejected) + matching auth'd `GET /api/settings/:userId/logo/:filename` with basename path-traversal guard and `Cache-Control: private, max-age=300`.
- A 3-tab company-admin dashboard at `/settings/company/dashboard` (Jobs / Team / Stats) with an Invite Employee sheet that reveals a one-time plaintext temporary password and copy-to-clipboard affordance.
- Typing: `CompanyMember`, `CompanyJobRow`, `CompanyStats`, `InviteEmployeeResponse`, `Paginated<T>` match the on-wire camelCase shape.
- Role gating centralised in `lib/roles.ts` via `isCompanyAdmin`.

Overall the UI structure, typing, and scope broadly match the handoff. Three real correctness issues — all verified against source — block a clean ship: a missing middleware gate on the dashboard, per-user (not per-company) storage of "company settings", and an `employee_id` filter applied after the paginated SQL slice.

## 2. Agreed findings

Both reviews flagged these. Severities reconciled using the stricter of the two where they diverged.

| # | Sev | Area | File:Line | Finding |
|---|-----|------|-----------|---------|
| A1 | P0 | Gating / middleware | `web/src/middleware.ts:58` | `pathname.startsWith('/settings/admin')` is the only role check. `/settings/company/dashboard` has no middleware gate. JWT payload (`src/auth.js:121`) doesn't even carry `company_role`. Commit message's "triple-layer" claim is aspirational, not shipped. |
| A2 | P0 | Data model / correctness | `src/routes/settings.js:99,133,315,358` + `web/src/app/settings/company/page.tsx:64` | Company settings are stored under `settings/{userId}/company_settings.json` and hard-gated on `req.user.id !== userId`. Web calls `api.companySettings(user.id)`, so every non-admin employee loads **their own** empty blob — the "view-only for non-admins" narrative in the commit message breaks on contact. Two admins on one company will diverge permanently. Same scoping mismatch applies to the logo GET/POST. |
| A3 | P1 | Security / exposure | `web/src/app/settings/company/dashboard/page.tsx:380,419` | Plaintext temp password lives in React component state for the modal lifetime, visible in React DevTools. `handleClose` nulls `result` but there's no teardown on unmount/navigation. |
| A4 | P1 | Performance / UX | `web/src/app/settings/company/dashboard/page.tsx:135,155,275,524` | Tab panels unmount on every segmented-control switch — Jobs/Team/Stats refetch and reset pager state on revisit. No SWR / cache. |
| A5 | P1 | UX / state timing | `web/src/app/settings/company/dashboard/page.tsx:325` | `onInvited` fires on POST resolve (before modal dismiss), so the team list refetches while the password modal is still showing. Small replication window could lead admin to close and lose both password + apparent confirmation. |
| A6 | P1 | Accessibility | `web/src/app/settings/company/dashboard/page.tsx:423` | Invite modal has `role="dialog"` / `aria-modal="true"` but no focus trap, no initial focus, no Esc handler, no focus restoration. |
| A7 | P2 | Code quality / dedup | `web/src/app/settings/company/dashboard/page.tsx:155,275,524` | Three near-identical async-resource `useEffect` blocks (loading, error, cancelled, fetch) duplicated across JobsTab / TeamTab / StatsTab. Candidate for a `useAsyncResource` hook. |
| A8 | P2 | Test coverage | (all new files) | No unit, component, or integration tests shipped. Highest-value gaps: `isCompanyAdmin` truth table, logo upload flow, invite success branch, pagination+filter interaction (A9). |

## 3. Disagreements + adjudication

### D1. `employee_id` filter applied after pagination slice

- **Claude:** P0 ship-blocker — filter runs on the paginated slice (line 336), `total` is unfiltered (line 339). Pager says "1–12 of 847" while showing only 3 rows for the filtered employee. Latent because no current UI passes `employee_id`, but the param is wired in `api-client.ts`.
- **Codex:** Not raised.
- **Source verification:** Confirmed. `src/routes/companies.js:302-306` → `getJobsByCompanyPaginated` returns at most `limit` rows; line 336 `filtered = mapped.filter(...)`; line 339 passes unfiltered `total` to `paginatedResponse`.
- **Adjudication:** **Accepted, P1 (not P0)** — bug is real and will silently mis-report filtered counts, but no current UI surface exercises the `employee_id` param so it cannot corrupt production users today. Downgrade from P0→P1 as latent/pre-productionising. Claude's fix (push filter into SQL with a new param on `getJobsByCompanyPaginated` + a filtered COUNT) is correct.

### D2. Logo upload ignores `storage.uploadBytes` return value

- **Codex:** P1 correctness — `src/routes/settings.js:329,336` (and `storage.js:94`) ignores the boolean from `uploadBytes`, so a storage failure still returns `{ logo_file: <key> }` and the client persists a broken pointer.
- **Claude:** Not raised. (Claude separately flagged orphaned logos on cancel as P1-4, a different concern.)
- **Adjudication:** **Accepted, P1.** Codex-unique finding; the two logo issues are complementary (cancel-orphans vs failed-upload-false-success). Fix: check the `uploadBytes` return, 500 on false, don't emit `logo_file`. Temp-file cleanup into `finally`.

### D3. Error state never cleared before retry

- **Codex:** P2 — `dashboard/page.tsx:155,275,524` effects don't `setError(null)` on retry or success, so a transient failure sticks.
- **Claude:** Not raised.
- **Adjudication:** **Accepted, P2.** Straightforward UX bug; two-line fix (null error before fetch + on success). Also informs the recommended `useAsyncResource` extraction (A7).

### D4. Middleware gate severity

- **Claude:** P0 ship-blocker.
- **Codex:** P1 (embedded in "triple-layer claim not delivered").
- **Adjudication:** **P0.** This is the only guard between unauthenticated-but-logged-in non-admin users and an admin-chrome shell. The commit message explicitly advertises middleware as first-line defence, and the mitigation (add `company_role` claim + path check, or downgrade the commit message) is cheap.

### D5. Per-user vs per-company storage severity

- **Claude:** P0.
- **Codex:** P1.
- **Adjudication:** **P0.** A non-admin employee hitting `/settings/company` sees a blank form labelled "Branding (view-only)" — a UX trap that contradicts the commit message's stated intent. Either data-model migration (per-company key) or scope narrowing (gate the page on `isCompanyAdmin`) closes the loop; either way, the current state is user-visibly wrong.

### D6. Disabled inputs for non-admin view

- **Codex:** P2 accessibility — disabled inputs aren't focusable/selectable, bad for a "verify and copy details" screen.
- **Claude:** Not raised.
- **Adjudication:** **Accepted, P2.** Use `readOnly` instead of `disabled`, or render as plain text. Pairs with the A2/D5 fix — if the page becomes admin-only, moot.

## 4. Claude-unique findings

- **C1 [P1]** Temp password entropy is 48 bits — `src/routes/companies.js:199` → `crypto.randomBytes(6).toString('base64url').slice(0,8)`. 8 chars from a 64-char alphabet against an offline attacker is weak. Recommend `randomBytes(9).toString('base64url').slice(0,12)` (72 bits).
- **C2 [P1]** `uploadCompanyLogo` in `web/src/lib/api-client.ts:401` fabricates `'logo.png'` name on raw Blob, so server writes `logo_*.png` even for a JPEG-typed blob. Forward original MIME, or reject Blobs with empty `type`.
- **C3 [P1]** Logo upload is eager but `company_settings.json` only updates on Save. Orphan S3 objects on cancel; Remove-click never DELETEs. Needs a Phase-7+ sweep job.
- **C4 [P2]** Path-traversal guard in logo GET (`src/routes/settings.js:364`) is a negative allow-list. Prefer `/^[A-Za-z0-9._-]+$/` + `path.basename(filename) === filename`.
- **C5 [P2]** `JobsTab` "Showing X–Y of Z" defensive clamp when `jobs.length === 0`.
- **C6 [P2]** `StatCard` uses `color-mix(in oklab, …)` — unsupported on Safari 15.3 and earlier; add CSS custom-property fallback.
- **C7 [P2]** `formatShortDate` catches parse errors but will silently render raw string if backend switches to Unix epoch. Add `Number.isNaN(d.getTime())` guard.
- **C8 [P2]** `TeamMemberRow` avatar initial falls back to `''` for empty `name || email`. Default to `'?'`.
- **C9 [P2]** `StatsTab` never surfaces `stats.company.name` — dashboard header is a generic "Company Dashboard" when the data is on hand.
- **C10 [P2]** `CompanyJobRow.status` is a strict union; backend can return anything or default to `'done'`. Either widen the type or align with the canonical enum.
- **C11 [P2]** Pagination indicator `1 / 17` lacks `aria-live="polite"` — SR users don't hear page changes.
- **C12 [P2]** `<code>` block with temp password has no programmatic affordance for SRs. Add `aria-label` describing the password and Copy button.
- **C13 [P2]** No rate-limit on `POST /api/companies/:companyId/invite` — admin could spam bcrypt + audit rows.
- **C14 [P2]** Full-blob PUT on `updateCompanySettings` drops any future server-side-only field the client doesn't know about. Document or switch to server-side merge / `If-Match`.
- **C15 [P2]** MIME filter trusts client-declared type; consider magic-byte check before ever rendering server-side.

## 5. Codex-unique findings

- **X1 [P1]** Logo upload ignores `storage.uploadBytes` boolean → silent success on storage failure (adjudicated in D2 above).
- **X2 [P2]** Error state never cleared between tab retries (adjudicated in D3 above).
- **X3 [P2]** Non-admin company-details fields rendered with `disabled` rather than `readOnly`, harming selection/copy accessibility (adjudicated in D6 above).
- **X4 [context]** Commit message advertises a triple-layer gate but implementation only delivers client-side + backend enforcement; docs and code out of sync. (Same root cause as A1; Codex frames it as a doc-drift issue too.)

## 6. Dropped / downgraded

- **Claude P1-1 sub-bullet on `autocomplete="off"` / `data-lpignore`** — downgrade to P3/noted. Password is in a `<code>` tag, not an `<input>`; password managers generally don't ingest plain `<code>` text.
- **Claude P2 on `TeamMemberRow` avatar initial (C8)** — kept as P2 but noted as purely cosmetic.
- **Claude P1-4 on orphaned logos (C3)** — tracked but not blocking; backlog item for Phase 7+.
- **Claude §4 "No CSRF protection"** — the app uses `Authorization: Bearer`, not cookie-auth; CSRF surface is minimal. Flag for audit but not a Phase-6b blocker.
- **Claude P2-ish on `color-mix` (C6)** — baseline-supported since 2023 in all targeted browsers; noted but not acted on.
- **Claude D1 (employee_id filter)** — downgraded P0→P1 per adjudication (latent, no current UI consumer).

Nothing dropped outright — every concern is either agreed, adjudicated, or parked to backlog.

## 7. Net verdict + top 3

**Verdict:** **Needs rework before rollout to non-admin employees.** The code quality is good and architectural calls (dedicated logo endpoint, two-step save, segmented-control tabs) are correct. But two of the three P0s (A1 middleware, A2 per-user storage) are user-visible the moment a non-admin follows the live Settings-hub link, and the third (D1 / employee filter) will silently lie about counts as soon as the `employee_id` UI lands.

### Top 3 priorities

1. **Resolve the company-settings-per-user vs company-view mismatch (A2 / D5).**
   `src/routes/settings.js:99,133,315,358` + `web/src/app/settings/company/page.tsx:64`. Pick one:
   (a) migrate storage to `companies/{companyId}/company_settings.json` + a company-scoped read (ideal long-term), or
   (b) resolve to the owner's userId server-side, or
   (c) gate the whole page on `isCompanyAdmin` and drop the "view-only for non-admins" framing.
   The logo GET/POST scope must move with the settings blob. Every non-admin employee sees the feature broken until this is done.

2. **Middleware-gate `/settings/company/dashboard` — or delete the "triple-layer" claim (A1 / D4).**
   `web/src/middleware.ts:58` + `src/auth.js:121`. Either sign `company_role` into the JWT and extend the path check, or narrow the commit message / comments to reflect the actual two-layer (client + backend) gate. Today's flash-of-admin-chrome plus unauthorised 403 spray on mount contradicts the design doc.

3. **Push `employee_id` filter into SQL + add fetch-failure handling on the logo upload (D1 + D2 / X1).**
   `src/routes/companies.js:302-339` — accept `employeeId` in `getJobsByCompanyPaginated`, add `AND user_id = $N` to both COUNT and data query, remove the JS `.filter()`. Separately, `src/routes/settings.js:329` — check the `storage.uploadBytes` boolean and 500 on false so the client never persists a broken `logo_file` pointer. Both are small, high-confidence fixes that close the only remaining correctness gaps before the feature meets a real admin workflow.

Not blocking but strongly recommended alongside: temp-password entropy bump (C1), teardown-on-unmount for the invite modal (A3), focus-trap + Esc handler (A6), and a small test pass covering the logo upload two-step flow + invite success branch + pagination-with-filter interaction.
