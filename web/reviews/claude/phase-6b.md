# Phase 6b Review — Company Settings + Company-Admin Dashboard

**Commit:** `6e85e9e`
**Scope:** `src/routes/settings.js` (+112), `web/src/lib/types.ts` (+85), `web/src/lib/api-client.ts` (+135), `web/src/components/settings/logo-uploader.tsx` (new, 189), `web/src/app/settings/company/page.tsx` (new, 233), `web/src/app/settings/company/dashboard/page.tsx` (new, 720), `web/src/app/settings/page.tsx` (+22/-11), `CLAUDE.md` (+1).

---

## 1. Summary

Phase 6b lands the three company-scoped surfaces the handoff called out:

1. `GET/PUT /api/settings/:userId/company` read-through form (`/settings/company`) — visible to everyone, editable by company-admins.
2. New `POST /api/settings/:userId/logo` + `GET /api/settings/:userId/logo/:filename` endpoints with 10 MB cap and PNG/JPEG-only filter, plus a two-step save (upload → merge key → PUT blob) in `LogoUploader`.
3. A 3-tab dashboard at `/settings/company/dashboard` (Jobs / Team / Stats) with an Invite sheet that surfaces a one-time plaintext temp password.

The code is workmanlike and broadly faithful to the handoff, with good component/typing hygiene (named `CompanyMember`, `CompanyJobRow`, `CompanyStats`, `Paginated<T>` match the on-wire shape). There are a handful of real correctness issues worth fixing before a wider rollout — the most impactful are (a) the `user_id` filter semantics on `/api/companies/:companyId/jobs` being **post-paginated on the backend**, (b) a fundamental mismatch between the "non-admins can still view company details" narrative and the per-user S3 storage shape, and (c) missing `/settings/company/dashboard` middleware gating that the handoff explicitly asked for.

## 2. Alignment with handoff

| Handoff requirement | Status |
|---|---|
| `companySettings` / `updateCompanySettings` / `uploadCompanyLogo` / `fetchLogoBlob` / `companyUsers` / `companyJobs` / `companyStats` / `inviteEmployee` | Present (`web/src/lib/api-client.ts:373–490`). |
| Dedicated `POST /api/settings/:userId/logo` (handoff recommended option **a**) | Present (`src/routes/settings.js:306–342`). |
| 3-up StatsGrid, no charts | Present (`dashboard/page.tsx:547–566`). |
| Invite sheet w/ click-to-copy one-time temp password, nulls on close | Present (`dashboard/page.tsx:417–421`). |
| Non-admin read-only view w/ "ask your admin" hint | Present (`company/page.tsx:133–139`). |
| Triple-layer gating (middleware → component → "no company") | **PARTIAL** — middleware gate is missing for `/settings/company/dashboard`; see §3 P0-1. |
| Logo cropping deferred | Correctly deferred. |
| Bulk team actions, audit-log UI, email invites deferred | Correctly deferred. |

## 3. Correctness

### P0 — ship-blockers

**P0-1. Middleware does not guard `/settings/company/dashboard`.**
`web/src/middleware.ts:58` only checks `pathname.startsWith('/settings/admin')`. The handoff §"Design decisions" §1 (and this commit's own commit message, line "Triple-layer role gating… Middleware JWT decode is first-line defence") asserts middleware is the first layer. In practice, the dashboard relies purely on component-level gating (`dashboard/page.tsx:63–76`) plus backend 403s. Consequence: non-admins briefly see the page shell / loading state and trigger 403s from `companyJobs` / `companyUsers` / `companyStats` on mount — exactly the "flash-of-admin-chrome" the handoff wanted to avoid. Add `/settings/company/dashboard` (and ideally `/settings/company` for signed-out users, though the generic gate already covers that) to the middleware check that reads `payload.company_role`.

**P0-2. Company details page is per-user, not per-company — the "view-only for non-admins" promise is broken.**
`src/routes/settings.js:102` hard-guards `req.user.id !== userId` → 403. Because the web form calls `api.companySettings(user.id)` (`company/page.tsx:64`), a non-admin loads **their own** `settings/{userId}/company_settings.json` blob, which is almost always empty — admins write to *their* user's blob. The commit message justifies the open view with "the data is already in every PDF they've ever produced", which is true of the PDF — but on this page a non-admin sees a blank form, not the company's actual branding. Options:
- (a) Look up `user.company_id` → resolve to the **owner/creator's** userId → fetch their blob; or better,
- (b) Move company_settings to a per-company key (`companies/{companyId}/company_settings.json`) and add a tenant-scoped read; or
- (c) Re-scope: drop the "view-only for non-admins" framing and gate the whole page on `isCompanyAdmin`.
As shipped the feature is a UX trap for any employee who follows the Settings hub link. Pick one and close the loop.

**P0-3. `employee_id` filter on `/api/companies/:companyId/jobs` is applied *after* pagination slice.**
`src/routes/companies.js:302–336`: `getJobsByCompanyPaginated` returns only `limit` rows, and the JS `.filter(j => j.user_id === employeeFilter)` then runs on that slice (line 336). Under any realistic dataset (> 50 jobs in the company), filtering for employee X returns a subset of page 1 instead of X's full job list, and `total` still reflects the unfiltered company total — so the pager says "1–12 of 847" while only showing that employee's 3 jobs from page 1. Either push the filter into the SQL (`WHERE company_id = $1 AND user_id = $2`) + separate `COUNT`, or refuse `employee_id` on paginated requests. The web client doesn't pass `employee_id` today (it's wired into `companyJobs` but no UI surface calls it), so the bug is latent — but it will bite the first consumer of the `employeeId` param.

### P1 — should fix

**P1-1. `InviteEmployeeResponse.temporaryPassword` leaks into browser dev-tools Network tab, logs, and React DevTools.** Shipping the plaintext over HTTPS is unavoidable (this is the whole point), but two things worsen exposure:
  - The modal stores it in component state (`dashboard/page.tsx:380`) so React DevTools exposes it for as long as the modal is open.
  - `handleClose()` nulls `result` (`dashboard/page.tsx:419`) but **doesn't clear `name` / `email`**; more importantly there's no autoClose-on-unmount guard if the user navigates away (Next router prefetches). Consider `useEffect(() => () => setResult(null), [])` as a hard teardown. For React DevTools exposure, wrapping the value in a `useRef<string | null>` + `useSyncExternalStore` or splatting it into state only for a single render then reading from a ref would be ideal — but at minimum a comment in `types.ts` warning consumers never to log `InviteEmployeeResponse` would help.
  - Browser `autocomplete="off"` is absent on the password `<code>` block — not actionable in the current markup, but worth adding `data-lpignore="true"` / `data-1p-ignore="true"` so password managers don't ingest it.

**P1-2. Temp password entropy is 48 bits.** `src/routes/companies.js:199` → `crypto.randomBytes(6).toString('base64url').slice(0,8)`. Six random bytes is 48 bits; base64url is 6 bits/char, so 8 chars encodes the full 48 bits (OK), but the password is only ever 8 chars from a 64-char alphabet — against an offline attacker with `password_hash` that's weak. iOS parity aside, consider 10–12 chars (60–72 bits) while keeping it short enough to dictate over the phone. Not blocking, but noting.

**P1-3. `setReload((n) => n + 1)` after invite, but `InviteEmployeeSheet` stays mounted on success.**
`dashboard/page.tsx:325`: `onInvited` runs when the POST resolves, not when the modal closes. `useEffect([companyId, reload])` fires immediately and re-fetches `companyUsers`. That's fine, except: the success branch of the modal then shows the temp-password UI while the parent list has already re-rendered with the new row. If the invite transiently fails to surface on the list (replication lag, even in a single-writer Postgres this is <5 ms but visible in tests) the admin might close the modal and lose both the password AND think the invite silently failed. Prefer firing `onInvited` from `handleClose()` (after the admin has acknowledged the password) instead of from the POST resolution. This matches iOS: the list refreshes after the sheet dismisses.

**P1-4. Logo upload is synchronous but `company_settings.json` is not updated until the user clicks Save.** If an admin uploads a new logo and navigates away, the S3 object exists but the blob still points at the old key. The commit message acknowledges this ("orphans are cheap"), but there's no cleanup / retention policy anywhere, and no indication of the blob being orphaned is surfaced in the UI. A future `Remove` click also only sets `logo_file=null` locally — the S3 object is never DELETEd (confirmed by `LogoUploader:107–114`, which explicitly `onUploaded(null)` and the comment at `logo-uploader.tsx:29–30`). This is fine short-term but logs orphans indefinitely; add to Phase-7+ cleanup backlog.

**P1-5. `uploadCompanyLogo` fabricates `'logo.png'` on raw Blob input.** `api-client.ts:401` — `new File([blob], 'logo.png', { type: 'image/png' })`. The server relies on `path.extname(file.originalname)` (`settings.js:316`) to pick the output extension, so a PNG-typed blob that's actually JPEG bytes will be stored as `logo_*.png` and served with `Content-Type: image/png` (`settings.js:354`) — browsers sniff, so this mostly works, but the Cache-Control / Content-Type combo misleads any downstream PDF renderer that trusts the extension. Either keep the File path (callers always pass a File from `<input type="file">`), or forward the original MIME.

### P2 — nice-to-haves

- `JobsTab` renders "Showing `offset+1`–`offset+jobs.length` of `total`" (`dashboard/page.tsx:204`). When `jobs.length === 0` on an empty last page (shouldn't happen because `hasMore` prevents it, but paranoia), it would render "Showing 51–50 of 50" — defensively clamp. Low severity.
- `JOBS_PAGE_SIZE = 50` (`dashboard/page.tsx:146`). Backend `parsePagination` caps at `maxLimit=200`; fine. Consider exposing the page size to the admin (50 rows on a phone is a lot of scroll); not urgent.
- `StatCard` uses `color-mix(in oklab, …)` (`dashboard/page.tsx:614`). Safari 15.3 and earlier don't support `color-mix`. Baseline widely available since 2023 so probably fine for a PWA, but worth a one-line CSS custom-property fallback.
- `formatShortDate` swallows parse errors via `try/catch`; if the backend ever returns `created_at` as a Unix epoch instead of ISO, the UI will silently show the raw string. Consider `Number.isNaN(d.getTime())` check.
- `TeamMemberRow` derives initial from `name || email`; empty-string after `.trim()` would `charAt(0)` to `''` (not crash), but the rendered pill will be blank. Fall back to `'?'` for robustness.
- `StatsTab` doesn't surface `stats.company` (returned at `/api/companies/:companyId/stats`), so the dashboard header says "Company Dashboard" rather than the actual company name. `CompanyStats.company.name` is typed but unused — wire it into the page title or the first StatCard.
- `requestInit` passes `credentials: 'include'` (`api-client.ts:54`) for logo fetch (`fetchLogoBlob`), but `fetchLogoBlob`'s bespoke `fetch` call (line 425) also sets `credentials: 'include'`. Consistent with `fetchSignatureBlob`. OK.

## 4. Security

- **Path traversal:** `filename.includes('/') || filename.includes('..')` (`settings.js:364`). Adequate but negative allow-list. Prefer `path.basename(filename) === filename && /^[\w.-]+$/.test(filename)` to catch `.` / backslash / zero-byte edge cases. Same weakness exists in the signature route so it's consistent, not new.
- **Tenant scoping on logo GET/POST:** `req.user.id !== userId` (`settings.js:315`, `:358`). Per-user scoping is correct given the current storage shape, but combined with P0-2 this means only the uploading admin can fetch their own logo via this endpoint — employees can't render it. That's a feature bug today. If the settings blob migrates to per-company storage (P0-2), the logo scope must migrate too.
- **SVG rejection:** Good call (commit msg + `logoUpload` config at `settings.js:27`) — SVG embedded in PDF headers is a well-documented XSS vector. Consider also rejecting animated PNGs (they render as a still frame but some PDF pipelines choke); not blocking.
- **MIME filter runs pre-disk:** `createFileFilter(['image/png','image/jpeg'])` — good. But the server trusts the client-declared MIME. A malicious client can declare `image/png` for an EXE; mitigated by the fact we only read bytes + pass to `storage.uploadBytes` (never executed). Consider a magic-byte check (`file.path` → `Buffer.alloc(12)` read) if logos are ever rendered server-side by something that parses file headers.
- **No CSRF protection:** The app uses `credentials: 'include'` + `Authorization: Bearer` (`api-client.ts:38,54`). If the cookie is `SameSite=Lax` or stricter, CSRF is largely mitigated for mutations; worth confirming in the backend auth middleware. `uploadCompanyLogo` in particular is a 10 MB POST — a CSRF would be catastrophic only insofar as storage bill goes up, but still worth locking.
- **No rate-limit on invite:** A company admin could spam `POST /api/companies/:companyId/invite` — each one creates a user, a bcrypt hash, and an audit row. Backend should add a per-admin rate limit.
- **Invite response is `201 Created`** (`companies.js:223`) with the plaintext password in the body. Correct; no redirect-following concern. Ensure backend logs never include `req.body` on successful invites or `res.body` — `logger.info('Employee invited…')` at `companies.js:217` looks clean.
- **Temp password in `<code>` tag** (`dashboard/page.tsx:444`) is rendered into the DOM, meaning any XSS-capable code (e.g., a future CSP-bypass) can `document.querySelector('code').innerText`. Mitigation: CSP + never retain past modal close (P1-1).

## 5. Performance

- **No N+1.** `getUsersByCompany` (`db.js:1282`), `getJobsByCompanyPaginated` (`db.js:1329`), `getCompanyStats` (`db.js:1354–1366`) are single queries or `Promise.all`'d triples. Good.
- **`getCompanyStats` uses three sequential round-trips** but in `Promise.all` — fine. Could be collapsed into one CTE (`WITH status_counts AS … , employee_count AS … , recent AS …`) for a small latency win; not worth the complexity at current scale.
- **`companyJobs` request fan-out on tab switch:** Jobs tab un-mounts on switch to Team, and re-mounts on switch-back, re-issuing the network request. For a paginated list that is effectively static between interactions this is wasteful. Consider hoisting the fetched state into the parent `CompanyDashboardPage` or using a simple in-memory map keyed on `(companyId, offset)`. Low priority but easy win for UX.
- **No SWR/stale-while-revalidate.** Every mount = fresh fetch. Fine for now, but when offline (Phase 7b IDB cache) is wired in, these three tabs are natural candidates for read-through.
- **Logo `max-age=300`** is sensible; 5 min is short enough that admin edits show up "eventually". `private` scope is correct (logos aren't secret, but are tenant-scoped).

## 6. Accessibility

Positive:
- `aria-modal="true"`, `role="dialog"`, `aria-labelledby="invite-title"` on the sheet (`dashboard/page.tsx:425–428`).
- `role="alert"` on error banners (`dashboard/page.tsx:636`, `company/page.tsx:212`).
- `aria-busy aria-live="polite"` on `LoadingRows` (`dashboard/page.tsx:646`).
- `aria-label` on icon-only buttons (back arrow `dashboard/page.tsx:116`, copy button `:452`, `company/page.tsx:115`).
- `disabled` state consistently applied to inputs in the non-admin view.

Gaps:
- **No focus trap in the invite modal.** `<div role="dialog" aria-modal="true">` is not enough; keyboard `Tab` will leak out of the modal into the underlying page. No `ESC` handler either (`dashboard/page.tsx:423–514`). Users with AT can escape-by-accident or lose focus. Add a focus-trap (or use Radix/HeadlessUI Dialog which does this for free).
- **No initial focus placement** on modal open — focus stays on the "Invite" button that opened it, which is now behind a backdrop.
- **`<code>` block with temp password has no programmatic affordance** for screen readers — visually it's a monospace box with a Copy button but SRs will read "code: XYZ Copy button". Add an `aria-label` on the code, e.g. `aria-label="Temporary password: XYZ. Copy with button."`.
- **Pagination controls** (`dashboard/page.tsx:207–227`) lack `aria-label` for `Prev` / `Next` — icons + "Prev" / "Next" text is fine for sighted users, but the current page indicator `1 / 17` has no `aria-live` so SR users don't hear the page change.
- **Color contrast:** `var(--color-text-tertiary)` on `var(--color-surface-2)` for 11px text is likely below WCAG AA 4.5:1 (depends on token resolution). Worth checking with the design tokens resolved.
- **Logo preview `<img alt="Company logo">`** (`logo-uploader.tsx:180`) is generic; if the company name is available, `alt={\`${companyName} logo\`}` is more informative.

## 7. Code quality

- **Hook dependency arrays:** `JobsTab`'s `useEffect` (`dashboard/page.tsx:155`) correctly includes `[companyId, offset]`; `TeamTab` (`:275`) uses `[companyId, reload]`; `StatsTab` (`:524`) uses `[companyId]`. All three set state + then fetch + then check `cancelled`. Good pattern, consistent.
- **`encodeURIComponent` on path params:** `api-client.ts:374,382,405,425,441,450,475,484`. Consistent. Good.
- **`request<T>` generic for typed returns.** Good.
- **Three near-identical `useEffect` blocks in `JobsTab` / `TeamTab` / `StatsTab`.** Each has its own `cancelled` ref, error state, loading state. A `useAsyncResource<T>(key, fn)` hook would save ~40 lines and centralise the cleanup pattern. Low priority.
- **`LogoPreview` re-fetches whenever `logoFile` changes** (`logo-uploader.tsx:175`), which is correct — but also whenever `userId` changes, which never happens inside a single page render. Fine.
- **Inline `STATUS_COLOR` map after `JobRow`** (`dashboard/page.tsx:258–263`) — hoist above use to avoid the temporal-dead-zone-like confusion (it works due to hoisting of `const` within module scope, but stylistically put the constant above the consumer).
- **`CompanyJobRow.status` union** (`types.ts:114`) is `'pending' | 'processing' | 'done' | 'failed'` but backend returns whatever `j.status` is or `'done'` as default (`companies.js:324`). If the DB ever emits another status string (e.g. `'cancelled'`), TypeScript will silently mis-type. Consider a `string` fallback + runtime narrowing, or align with the canonical status enum defined elsewhere in `types.ts` (look for `Job.status`).
- **`settings: CompanySettings` PUT** (`api-client.ts:385`) — the backend does a **full-blob overwrite** (`settings.js:143`). If a future field is added on the server and the client doesn't know about it, a PUT from this client will **drop that field**. Documenting this on `updateCompanySettings` is good; considering a last-writer-wins with `If-Match` header or a server-side merge is the proper fix when the schema grows.
- **`CompanySettings.logo_file` is `string | null`** (`types.ts:68`) — good. But `updateCompanySettings` unions it; `LogoUploader.onUploaded(null)` passes `null`. The backend serialises `null` into JSON (confirmed — `JSON.stringify` preserves null). OK.

## 8. Test coverage

No tests shipped with this commit. Given the sensitivity of the surfaces:

- **Unit tests missing:**
  - `isCompanyAdmin(user)` truth table (admin role / owner / admin / employee / null).
  - `formatShortDate` for ISO / invalid / cross-year inputs.
- **Component tests missing:**
  - Non-admin renders read-only (`company/page.tsx`).
  - Invite success branch renders password and Copy button.
  - Invite close clears `result`.
  - Dashboard "no company_id" fallback.
- **Integration / e2e missing:**
  - Logo upload → settings save → re-load shows new logo (two-step flow is the most error-prone path).
  - Invite → new user visible in team list → new user can log in with temp password.
  - Pagination forward+back preserves `offset` correctly.
- **Backend tests missing:**
  - `POST /api/settings/:userId/logo` rejects SVG, rejects > 10 MB, rejects foreign `userId`.
  - `GET /api/settings/:userId/logo/:filename` rejects `..` traversal, 404s on missing, 403s cross-tenant.
  - `/api/companies/:companyId/jobs?employee_id=x` — the post-pagination filter bug (P0-3) would be caught by a test that paginates past page 1.

The commit message's manual test plan is reasonable but not executable; automated coverage is needed before rollout.

## 9. Suggested fixes

Numbered, ordered by priority. File paths are absolute.

1. **P0 — add `/settings/company/dashboard` to middleware gate.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/middleware.ts:58` — extend the check:
   - After the admin check, also redirect non-company-admins away from `/settings/company/dashboard`. Requires JWT to include `company_role` in the payload (confirm); if not, only route-level gate works. At minimum, add a comment explaining why the dashboard is intentionally NOT middleware-gated if the JWT lacks `company_role`.

2. **P0 — resolve the "non-admin views company" paradox.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/page.tsx:64` calls `api.companySettings(user.id)` — for a non-admin this loads an empty blob. Either (a) migrate to a company-keyed read (`companies/:companyId/settings`), (b) look up the owner's userId server-side, or (c) gate the whole page on `isCompanyAdmin` and drop the "view-only" narrative. Pick one before shipping to employees.

3. **P0 — fix `employee_id` filter in `getJobsByCompanyPaginated`.**
   `/Users/derekbeckley/Developer/EICR_Automation/src/routes/companies.js:302–336` — push the filter into SQL:
   - Accept `employee_id` in `getJobsByCompanyPaginated(companyId, limit, offset, employeeId?)`, append `AND user_id = $N` to both the COUNT and the data query. Remove the JS `.filter()`. Correct `total` to the filtered count.

4. **P1 — null out invite password on modal unmount + hide from DevTools.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:380` — add `useEffect(() => () => setResult(null), [])` for hard teardown; consider stashing password in `useRef` + using a separate boolean state to drive rendering.

5. **P1 — move the `onInvited` callback from POST resolve to modal close.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:393` → move to line 420 inside `handleClose()` (before `onClose()`).

6. **P1 — increase temp password entropy.**
   `/Users/derekbeckley/Developer/EICR_Automation/src/routes/companies.js:199` — `crypto.randomBytes(9).toString('base64url').slice(0, 12)` yields 72 bits. Adjust the UI note to "12 characters".

7. **P1 — forward original MIME in `uploadCompanyLogo`.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/api-client.ts:401` — when wrapping a Blob, preserve `blob.type`. If the type is empty, reject client-side before upload.

8. **P1 — focus-trap + Esc-to-close in invite sheet.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:423–514` — use a focus-trap library or the native `<dialog>` element with `showModal()`. Add `keydown` handler for Esc.

9. **P2 — status live region for pagination.**
   `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:216–218` — wrap the page indicator in `<span aria-live="polite">`.

10. **P2 — tighten filename allow-list in logo GET.**
    `/Users/derekbeckley/Developer/EICR_Automation/src/routes/settings.js:364` — replace the negative check with `/^[A-Za-z0-9._-]+$/.test(filename)` and 400 on fail.

11. **P2 — render `company.name` on the dashboard header.**
    `/Users/derekbeckley/Developer/EICR_Automation/web/src/app/settings/company/dashboard/page.tsx:120` — surface `stats.company.name` (or fetch `getCompany(companyId)` once) so the page isn't generic.

12. **P2 — extract `useAsyncResource<T>`.**
    Collapse the three near-identical `useEffect` blocks in `JobsTab` / `TeamTab` / `StatsTab` into one hook.

13. **P2 — add integration test for logo upload → settings save → reload.**
    New file under `/Users/derekbeckley/Developer/EICR_Automation/web/tests/` (pick the existing test layout) exercising the two-step flow.

14. **P2 — orphan logo cleanup.**
    Log orphaned `settings/{userId}/logos/*.png` and schedule Phase-7+ sweep. Track in `todos-certmate.md`.

## 10. Verdict + top 3 priorities

**Verdict:** Ship-after-fixing the P0s. The code quality is good, the architectural decisions (dedicated logo endpoint, per-filename auth GET, two-step save) are correct, and the UI/UX matches iOS faithfully. But the three P0s (middleware gap, per-user storage mismatch, post-paginated filter) each introduce real user-visible or correctness-visible bugs that will surface the moment non-admin employees or companies > 50 jobs exercise the feature. Additionally, Phase 6b is marked complete in `CLAUDE.md` but no tests were added — the commit history has been growing the untested surface area since Phase 5.

**Top 3 priorities:**

1. **Middleware-gate `/settings/company/dashboard`** (fix #1). This is the smallest change with the highest leverage — restores the commit message's own stated "triple-layer" promise and prevents the flash-of-chrome + 403 spray for non-admin navigations.
2. **Resolve the company-settings-per-user vs company-view semantic mismatch** (fix #2). The most user-impacting bug: every non-admin employee who lands on `/settings/company` will see an empty form labeled "Branding and contact info (view-only)" and conclude the feature is broken. Pick a direction (gate the page, or move storage) and close the loop.
3. **Push `employee_id` into the paginated SQL and add tests for pagination + filter interaction** (fix #3 + fix #13). This is the only latent correctness bug that can silently corrupt admin decision-making (wrong totals, missing jobs) and is easy to miss in manual testing.

Wrote reviews/claude/phase-6b.md.
