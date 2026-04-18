# Phase 6c — System-admin user management (handoff)

> Web rebuild · branch `web-rebuild` · Phase 6b closed at `6e85e9e`
> (company settings + company-admin dashboard).

## Objective

Final sub-phase of Phase 6. Port the iOS admin CRUD surfaces so system
admins (`role === 'admin'`) can create, edit, reset-password, and
unlock users from the web client — matching iOS
`AdminUsersListView` / `AdminEditUserView` / `AdminCreateUserView`.

This is the smallest of the three 6x sub-phases: one new route sub-tree
(`/settings/admin/users`), one shared form component, two modals, five
new API-client methods, zero backend changes.

## State at start of 6c (what's already in place)

All the pre-work from 6a + the role/type plumbing from 6b is already
landed and is **fully reusable**. Do not re-invent these:

| Reuse | Where |
|---|---|
| `AdminUser` type (extends `User` with `is_active`, `last_login`, `locked_until`, `failed_login_attempts`) | `web/src/lib/types.ts:78` |
| `Paginated<T>` generic envelope (matches backend camelCase `hasMore`) | `web/src/lib/types.ts` |
| `isSystemAdmin(user)` helper | `web/src/lib/roles.ts` |
| `useCurrentUser()` hook (snapshot + revalidate) | `web/src/lib/use-current-user.ts` |
| Middleware JWT check that redirects non-admins away from `/settings/admin/*` | `web/src/middleware.ts` |
| Settings hub already renders the "Manage Users" link card under `isSystemAdmin(user)`, currently `disabled` with `disabledLabel="Coming in Phase 6c"` | `web/src/app/settings/page.tsx:116-128` |
| Settings layout (`AppShell`, no RecordingProvider) | `web/src/app/settings/layout.tsx` |
| Floating-label input primitive | `web/src/components/ui/floating-label-input.tsx` |
| SectionCard primitive | `web/src/components/ui/section-card.tsx` |
| SegmentedControl primitive (used for the admin list's filter chips if you want them) | wherever 6b used it |
| Modal / sheet pattern with the two-phase form→success state + "shown once" password reveal | `web/src/app/settings/company/dashboard/page.tsx` (`InviteEmployeeSheet`) — **copy this for ResetPasswordSheet, trim the form, reuse the copy-to-clipboard bit** |
| Auth'd API client (`request()` helper, Bearer header, JSON/text/blob variants) | `web/src/lib/api-client.ts` |

## iOS reference

| Concern | File |
|---|---|
| Users list | `CertMateUnified/Sources/Views/Admin/AdminUsersListView.swift` |
| Edit user | `CertMateUnified/Sources/Views/Admin/AdminEditUserView.swift` |
| Create user | `CertMateUnified/Sources/Views/Admin/AdminCreateUserView.swift` |
| Role flags on User | `CertMateUnified/Sources/Models/User.swift` |

### Mechanics to copy from iOS

1. **Edit form grey-outs the self-destruct fields.** If the row being
   edited is the currently-logged-in admin, disable the `role` and
   `is_active` controls with a tooltip / hint: "You can't demote or
   deactivate yourself." The backend enforces both
   (`src/routes/admin-users.js:129-135`) and will return a 400 — UI
   guard is purely to avoid a round-trip error.
2. **Reset-password is modal + one-shot.** iOS pops a sheet with a
   single password field, submits, closes on success. Backend
   invalidates the user's existing JWT via `incrementTokenVersion`
   (`admin-users.js:180`) so every live session for that user dies
   the next time they make an API call. The UI should note that
   after success.
3. **Unlock is conditional + one-click.** Only render the "Unlock"
   button when `locked_until && new Date(locked_until) > now`.
   Clicking fires `POST /api/admin/users/:userId/unlock` with no
   body. No modal — just a confirm then a toast/banner.
4. **No delete.** The iOS admin screens do NOT have a delete button.
   The backend has no delete endpoint. Deactivate (`is_active: false`)
   is the soft-delete path. Mirror this — don't invent a DELETE
   button.

## Backend (already live, no changes needed)

All routes mounted under `/api/admin/users` gated by `requireAuth +
requireAdmin` at the mount point (`src/api.js`). See
`src/routes/admin-users.js`.

| Method · Path | Body | Response | Notes |
|---|---|---|---|
| GET `/api/admin/users` | `?limit=50&offset=0` (omit for full list) | **With** pagination params: `Paginated<AdminUser>` (`{data, pagination: {limit, offset, total, hasMore}}`). **Without**: bare `AdminUser[]`. | Always pass `limit`+`offset` so the response shape is consistent — matches the pattern 6b uses for `companyJobs`. |
| POST `/api/admin/users` | `{email, name, password, company_name?, role?, company_id?, company_role?}` | `201 AdminUser` | password ≥ 8 chars. Role defaults to `'user'`, company_role to `'employee'`. 409 on duplicate email. |
| PUT `/api/admin/users/:userId` | `{name?, email?, company_name?, role?, is_active?}` | `{success: true}` | 400 if trying to self-demote (`role !== 'admin'` on self) or self-deactivate (`is_active: false` on self). |
| POST `/api/admin/users/:userId/reset-password` | `{password}` | `{success: true}` | password ≥ 8 chars. Invalidates existing sessions. |
| POST `/api/admin/users/:userId/unlock` | — | `{success: true}` | Clears `failed_login_attempts` + `locked_until`. |

AdminUser response fields (from `db.listUsers` / `db.getUserById`):
`id, email, name, company_name, role, company_id, company_role,
is_active, last_login, locked_until, failed_login_attempts, created_at`.
The `AdminUser` type in `web/src/lib/types.ts:78` already covers
all of these — do NOT re-declare.

## Implementation plan

### Step 1 — API client methods

Add to `web/src/lib/api-client.ts` (five new methods, all typed):

```ts
adminListUsers(params?: { limit?: number; offset?: number }): Promise<Paginated<AdminUser>> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  const qs = `?limit=${limit}&offset=${offset}`;
  return request<Paginated<AdminUser>>(`/api/admin/users${qs}`);
}
adminCreateUser(body: {
  email: string; name: string; password: string;
  company_name?: string; role?: 'admin' | 'user';
  company_id?: string; company_role?: 'owner' | 'admin' | 'employee';
}): Promise<AdminUser> {
  return request<AdminUser>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
}
adminUpdateUser(userId: string, patch: {
  name?: string; email?: string; company_name?: string;
  role?: 'admin' | 'user'; is_active?: boolean;
}): Promise<{ success: true }> {
  return request(`/api/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify(patch) });
}
adminResetPassword(userId: string, password: string): Promise<{ success: true }> {
  return request(`/api/admin/users/${userId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}
adminUnlockUser(userId: string): Promise<{ success: true }> {
  return request(`/api/admin/users/${userId}/unlock`, { method: 'POST' });
}
```

Always send `limit`+`offset` on the list call so the backend returns
the `Paginated<T>` envelope (see 6b's `companyJobs` — same reasoning).

### Step 2 — Routes

- `web/src/app/settings/admin/users/page.tsx` — paginated list.
- `web/src/app/settings/admin/users/new/page.tsx` — create form.
- `web/src/app/settings/admin/users/[userId]/page.tsx` — edit form +
  reset-password + unlock affordances.

No separate `/settings/admin/page.tsx` landing — the hub already
routes directly to `/settings/admin/users`. Middleware guards the
whole sub-tree.

### Step 3 — Components

Keep it simple — do **not** create a `components/settings/admin-*`
tree. Inline the forms inside the page files (the dashboard in 6b
set the precedent). Extract only if something gets reused across
pages.

**What to inline:**

- **Users list page** — fetch on mount, show pagination controls
  (Prev / Next, 50 per page), render a card list with: avatar
  initial, name, email, role pill (`admin` gets brand-blue,
  `user` neutral), company-role pill (if any), active/inactive
  badge (red "Inactive" when `!is_active`), locked badge ("Locked"
  when `locked_until && new Date(locked_until) > now`).
  Row is a `<Link href="/settings/admin/users/{id}">`. Add a
  floating "+ New user" button top-right.
- **User form page (shared create+edit via a `UserForm` inner
  component)** — FloatingLabelInputs for name, email, company_name
  + a password input for create-mode only. Role `<select>` (`admin`
  / `user`). Company role `<select>` (`owner` / `admin` / `employee`
  / `''` for none — backend accepts null via omitted field).
  `is_active` toggle (edit-mode only — new users are always active).
  Self-edit guard: if `userId === currentUser.id`, disable role +
  is_active with a hint banner "You can't demote or deactivate
  yourself."
- **Reset-password sheet** — copy `InviteEmployeeSheet` from
  `/settings/company/dashboard/page.tsx`. Single password field,
  ≥ 8 char client guard, POST, success state with an info line:
  "All existing sessions for this user have been signed out." No
  copy-to-clipboard here (the admin is setting a password they
  know — they don't need it read back).
- **Unlock button** — render inline on the edit page, only when
  the user is currently locked. `<Button variant="secondary">
  Unlock account</Button>` → `window.confirm('Unlock this
  account?')` → POST → refresh the row.

### Step 4 — Wire up the hub link

`web/src/app/settings/page.tsx:116-128` currently renders the
"Manage Users" LinkCard with `disabled` + `disabledLabel="Coming
in Phase 6c"`. Drop those two props to go live. The
`isSystemAdmin(user)` gate that wraps the whole SectionGroup stays.

### Step 5 — Verify

```bash
cd web
npx tsc --noEmit     # must be clean
npm run lint         # do not regress the 6-warning baseline
npm run build        # must pass; verify /settings/admin/users shows in the route table
```

Baseline as of `6e85e9e`: 0 errors, 6 pre-existing warnings (unrelated
files — `react-hooks/exhaustive-deps` on five job tab pages + one
unused-vars on `job-tab-nav.tsx`).

**Manual test plan (6c):**
- Log in as a system admin. Settings hub shows Administration
  section with "Manage Users" enabled.
- Click through → list of users loads, pagination works.
- Click "+ New user" → fill form with a password ≥ 8 chars → submit
  → redirected to list, new row present.
- Try creating with password "short" → client-side 400, no network
  request.
- Try creating with a duplicate email → 409, surface error banner.
- Edit another user → change role admin↔user + toggle `is_active`
  → save → list reflects.
- Edit your own user → role + is_active are disabled with hint
  banner.
- Open reset-password sheet → set new password ≥ 8 chars → success
  state → close.
- Lock a user (six failed logins via login page) → their row shows
  "Locked" badge → edit page shows Unlock button → click → confirm
  → badge clears on refresh.
- Log in as a regular user → navigate to `/settings/admin/users`
  → middleware redirects to `/settings`.

## Scope exclusions (defer to later phase)

Handoff-level: these are intentionally NOT in 6c. Don't scope-creep.

- **Delete user.** Backend has no delete endpoint. Deactivate via
  `is_active: false` is the soft-delete.
- **Audit-log surfacing.** Backend logs every admin action via
  `logAction` (`admin-users.js:98,140,182,213`) but we don't have
  a read endpoint for it. Phase 7+.
- **Company assignment UI.** Backend supports
  `POST /api/companies/:companyId/users/:userId/assign` but iOS
  doesn't surface it and there's no clean UX for picking a company
  from a free list yet. Leave `company_id` editable as a raw UUID
  field behind a "Company" label only — advanced-users-only
  affordance. Full picker deferred.
- **Bulk actions** (bulk deactivate, bulk reset). Rare, messy UI,
  no iOS precedent.
- **Email notifications** on create / reset. Backend doesn't send.
  The admin is expected to communicate credentials out-of-band
  (same as the 6b invite flow).
- **Failed-login-attempts display.** The field exists on
  `AdminUser` but has no UX value — the "Locked" badge is enough
  signal. Don't render the counter.

## Commit

One commit at the end:

```
feat(web): Phase 6c system-admin user management
```

Full-body message per `CLAUDE.md` commit rules (what / why / why
this approach / context), plus a Changelog row in `CLAUDE.md`
matching the detail of 6a and 6b entries.

Files you'll touch (all new except the two marked):

- `web/src/lib/api-client.ts` **(modify)** — five new admin methods
- `web/src/app/settings/admin/users/page.tsx` — list
- `web/src/app/settings/admin/users/new/page.tsx` — create
- `web/src/app/settings/admin/users/[userId]/page.tsx` — edit +
  reset + unlock
- `web/src/app/settings/page.tsx` **(modify)** — drop `disabled` +
  `disabledLabel` on the Admin link card
- `CLAUDE.md` **(modify)** — Changelog row

## After 6c ships

Phase 6 is closed. Next candidates (pick with Derek):

- **Phase 7** — PWA offline / sync (iOS-parity for intermittent
  connectivity on site visits).
- **Documents tab polish** — the observation photo + document
  extraction surfaces are Phase-5 complete but the UX could use
  batch upload + reorder.
- **Testing** — there are currently zero Playwright E2E tests for
  the rebuild. Settings + recording flows are good candidates.

Update memory (`project_web_rebuild_phase5.md` → new
`project_web_rebuild_phase6.md`) to record: "6a/6b/6c all shipped.
Phase 6 closed."
