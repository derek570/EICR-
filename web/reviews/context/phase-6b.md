# Phase 6b — Context

**Commit:** `6e85e9e`

## Commit message

```
commit 6e85e9e777a2e6ae8fb4f94d302027e7948efed3
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 19:23:09 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 19:23:09 2026 +0100

    feat(web): Phase 6b company settings + company-admin dashboard
    
    Lands the company sub-tree of the settings rebuild: a read-only-by-default
    CompanyDetails page visible to any authenticated user, and a company-admin
    dashboard with Jobs / Team / Stats tabs. Settings hub flipped from
    "Coming in Phase 6b" placeholders to live links.
    
    Why (problem): inspectors need to verify the company stamp (reg number,
    logo) that will print on certs they generate. Hiding the page from
    non-admins makes that harder without any security benefit — the data
    is already in every PDF they've ever produced. Gating mutations only,
    not the view, keeps the information surface available while removing
    the footgun. Company admins in turn need a single dashboard for the
    team-management + overview loop that iOS `CompanyDashboardView.swift`
    already provides but that the previous web rebuild never ported.
    
    Why this approach:
     - **Logo endpoint is dedicated, not inlined.** The handoff flagged this
       as the only backend gap. Added `POST /api/settings/:userId/logo`
       (multer, 10 MB, PNG/JPEG only — SVG rejected because logos get
       inlined into the PDF header and a malicious `<script>` / XXE in an
       SVG would execute during rendering) + a matching auth'd
       `GET /api/settings/:userId/logo/:filename` (basename path-traversal
       guard, `Cache-Control: private, max-age=300`). Rejected inlining as
       base64 in the company_settings blob — a 200 KB logo would bloat
       every settings read and bust cache on trivial updates. Two-step
       save (upload → get key → merge onto JSON → PUT blob) mirrors the
       signature uploader so the existing "orphaned upload on cancel is
       cheap" reasoning carries over.
     - **Triple-layer role gating on the dashboard.** Middleware JWT decode
       is first-line defence; component-level `isCompanyAdmin(user)`
       check is belt-and-braces (defends against JWT-without-company-role
       edge cases); explicit "No company linked" graceful state handles
       system admins who have `role: 'admin'` but no `company_id` — without
       that branch the Jobs/Team/Stats requests would 404 and the UI would
       look broken. All three gates centralised on `isCompanyAdmin` from
       `lib/roles.ts` so the role model can evolve in one place.
     - **Paginated<T> generic matches backend camelCase.** Backend
       `paginatedResponse()` in `src/utils/pagination.js` returns
       `{ data, pagination: { limit, offset, total, hasMore } }` — typed
       the generic with `hasMore` (not snake_case `has_more`) to match
       the wire format exactly. No adapter layer.
     - **Invite flow is two-phase with ephemeral temp password.** Backend
       auto-generates a temp password and returns it once in the invite
       response (email delivery is deferred — see scope exclusions).
       Sheet goes form → success state that displays the password in a
       `<code>` block with a clipboard Copy button. On modal close,
       `setResult(null)` explicitly clears it so the password doesn't
       outlive the modal render. No attempt to persist or re-fetch — if
       the admin closes before copying, they have to reset it via the
       standard admin flow. Matches iOS behaviour.
     - **Dashboard tabs via SegmentedControl, not sub-routes.** The three
       views share a company_id context and move between each other
       constantly; a segmented control keeps state local + avoids a
       URL-per-tab thrash. Deep links to a specific tab aren't a real
       use case for this screen (matches iOS — tab picker, no URL).
     - **Response shape mismatch caught before it shipped.** Handoff
       predicted `getCompanyStats` would return
       `{users_count, jobs_count, observations_count}`; the actual backend
       returns `{jobs_by_status, total_jobs, active_employees,
       jobs_last_7_days}`. Typed and rendered the real shape — 3 StatCards
       for the scalars + a bar-like list for jobs-by-status.
    
    Context:
     - Company page is reachable from the settings hub for all users; the
       hub now renders the Dashboard link card conditionally under the
       same role gate.
     - LogoUploader preview box is 48 × 192px to mirror the actual ~200×60
       PDF header slot — gives admins a realistic preview of how their
       logo will look stamped on certs.
     - Non-admin view uses `disabled` on every FloatingLabelInput + hides
       the save bar entirely (no empty sticky footer) + shows a
       ShieldCheck hint banner explaining why.
     - Scope exclusions per handoff §"Scope exclusions for Phase 6":
       no billing/Stripe wiring, no audit-log surfacing, no email
       delivery for invites (backend doesn't send; temp password is shown
       in-UI as the handoff documents), no logo cropping/resizing
       (inspector uploads a pre-sized PNG/JPEG), no CSV export of jobs
       list, no bulk team actions. All deferred to a future phase.
    
    Files:
     - src/routes/settings.js — new logoUpload multer + POST/GET routes
     - web/src/lib/types.ts — CompanyMember, CompanyJobRow, CompanyStats,
       InviteEmployeeResponse, Paginated<T>
     - web/src/lib/api-client.ts — companySettings, updateCompanySettings,
       uploadCompanyLogo, fetchLogoBlob, companyUsers, companyJobs,
       companyStats, inviteEmployee
     - web/src/components/settings/logo-uploader.tsx — upload + preview
     - web/src/app/settings/company/page.tsx — read-only-for-non-admins form
     - web/src/app/settings/company/dashboard/page.tsx — Jobs/Team/Stats +
       InviteEmployeeSheet with temp-password reveal
     - web/src/app/settings/page.tsx — flip Company section from placeholder
       to live links
     - CLAUDE.md — Changelog row
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                       |   1 +
 src/routes/settings.js                          | 112 ++++
 web/src/app/settings/company/dashboard/page.tsx | 720 ++++++++++++++++++++++++
 web/src/app/settings/company/page.tsx           | 233 ++++++++
 web/src/app/settings/page.tsx                   |  33 +-
 web/src/components/settings/logo-uploader.tsx   | 189 +++++++
 web/src/lib/api-client.ts                       | 135 +++++
 web/src/lib/types.ts                            |  85 +++
 8 files changed, 1497 insertions(+), 11 deletions(-)
```

## Handoff doc: PHASE_6_HANDOFF.md

# Phase 6 — Admin + Settings parity (handoff)

> Web rebuild · branch `web-rebuild` · Phase 5 closed at `cccd548` (LiveFillView)

## Objective

Port the iOS Settings / Inspector / Admin surfaces to the web so that
inspectors can manage their profile, staff/inspector signatures, company
branding, and — for system / company admins — other users and company
dashboards without leaving the web client. Matches iOS parity so the
two clients can be used interchangeably in the field and in the back
office.

Phase 6 is larger than 5a–5d — it adds a whole new route tree. Plan it
as **three sub-phases** that each ship as their own commit:

- **6a** — `/settings` hub + **staff** (inspector profiles + signature capture)
- **6b** — **company** settings (details, logo) + company-admin dashboard
- **6c** — **admin** users (system-admin CRUD: create, edit, reset password, unlock)

Stop-the-line rule: 6a must ship green before 6b/6c. Staff profiles +
signatures are the highest-value piece for the MVP — an inspector can't
produce a valid certificate without them, and admin CRUD is only used
by a handful of system admins.

## iOS reference

| Concern | File · line |
|---|---|
| Settings hub (role-gated sections) | `CertMateUnified/Sources/Views/Settings/SettingsView.swift` (441 lines) |
| Alt settings hub (collapsible sections) | `CertMateUnified/Sources/Views/Settings/SettingsHubView.swift` (345 lines) |
| Inspector list | `CertMateUnified/Sources/Views/Inspector/InspectorListView.swift` |
| Inspector detail editor | `CertMateUnified/Sources/Views/Inspector/InspectorDetailView.swift` (400+ lines) |
| Signature capture (pen canvas) | `CertMateUnified/Sources/Views/Components/SignatureCaptureView.swift` |
| Company details form | `CertMateUnified/Sources/Views/CompanyDetails/CompanyDetailsView.swift` |
| Company admin dashboard (Jobs/Team/Stats) | `CertMateUnified/Sources/Views/Admin/CompanyDashboardView.swift` |
| System admin: list users | `CertMateUnified/Sources/Views/Admin/AdminUsersListView.swift` |
| System admin: edit user | `CertMateUnified/Sources/Views/Admin/AdminEditUserView.swift` |
| System admin: create user | `CertMateUnified/Sources/Views/Admin/AdminCreateUserView.swift` |
| Photo picker (logo upload) | `CertMateUnified/Sources/Views/Components/PhotoPickerView.swift` |
| User model (role flags) | `CertMateUnified/Sources/Models/User.swift` |
| Inspector model (10 equipment fields) | `CertMateUnified/Sources/Models/Inspector.swift` |
| InspectorProfile (lighter API shape) | `CertMateUnified/Sources/Models/InspectorProfile.swift` |

### Key mechanics to copy

1. **Role-gated rendering, not just routing.** iOS shows/hides entire
   sections based on `user.isAdmin` (system admin, `role == 'admin'`)
   and `user.isCompanyAdmin` (`company_role in ['owner','admin']`).
   Don't rely on route-level gating alone — a normal user landing on
   `/settings/admin/users` should see a friendly "not authorised"
   message, not a blank page or redirect-to-login.
2. **Signature canvas.** `SignatureCaptureView` is a pen-drawn canvas
   that renders the existing PNG if present and a draw-area otherwise.
   On gesture end it exports to PNG `Data`. Clear button nukes. Web
   uses an HTML5 `<canvas>` with pointer events + `toBlob('image/png')`.
3. **Inspector profiles are stored as one JSON blob per user.** There
   are no per-profile endpoints — every edit is a full-array PUT to
   `/api/inspector-profiles/:userId`. Optimistic concurrency is just
   "last writer wins"; matches iOS.
4. **Signature upload is multipart, not inline base64.** Backend
   `/api/inspector-profiles/:userId/upload-signature` returns an S3
   key (`settings/{userId}/signatures/signature_{ts}.png`) that you
   then store as `signature_file` on the profile. Two-step flow:
   upload-then-save. Matches iOS `APIClient.uploadSignature`.
5. **Company invite returns a temporary password.** `POST
   /api/companies/:companyId/invite` creates a user and returns the
   plaintext temp password in the response — show it once in a modal,
   tell the admin to copy it. Do NOT email it (backend doesn't send).
6. **Admin user updates cannot self-destruct.** Backend rejects
   removing your own admin role or deactivating yourself. Mirror the
   UI — grey out those fields on the "edit myself" case so the API
   never rejects a submit.

### What iOS does that we can skip

- **SettingsHubView's collapsible-sections aesthetic** — the two iOS
  settings screens (`SettingsView` + `SettingsHubView`) are redundant.
  Port `SettingsView`'s layout, drop `SettingsHubView`.
- **iOS ImagePicker for logo upload** — iOS uses `PhotosUI`. Web uses
  a plain `<input type="file" accept="image/*">` like the CCU / doc
  extraction pickers already in Phase 5.
- **Test-equipment section on Inspector detail.** Inspector has 10
  optional strings (5 devices × serial + calibration date). iOS
  renders them as a collapsible sub-section. Ship for 6a but keep it
  simple — a single expandable card with 10 FloatingLabelInputs is
  fine. Don't invent a schema UI.
- **Offline / queued edits.** Settings edits are rare and can be
  online-only for now. Phase 7 (PWA + offline) will revisit.
- **Company dashboard "Stats" charts.** The iOS stats view shows a
  few counts + a trend chart. Port the counts; defer the chart to a
  later phase — a simple `{users_count, jobs_count, observations_count}`
  grid is enough for 6b.

## Web state already in place (reuse, don't rebuild)

| Concern | Location |
|---|---|
| Typed API client wrapper | `web/src/lib/api-client.ts` (pattern: `api.method(...)` returning typed promises) |
| Auth storage (token + user) | `web/src/lib/auth.ts` (`getUser`, `setAuth`, `clearAuth`) |
| Middleware auth gate | `web/src/middleware.ts` (checks cookie + JWT expiry; no role check yet) |
| User type | `web/src/lib/types.ts#User` — **missing `company_id?` + `company_role?`** |
| App shell / nav bar | `web/src/components/layout/app-shell.tsx` |
| Form primitives | `web/src/components/ui/floating-label-input.tsx`, `input.tsx`, `button.tsx`, `card.tsx`, `section-card.tsx`, `select-chips.tsx`, `segmented-control.tsx` |
| Multipart-upload reference | `api.uploadObservationPhoto` in `api-client.ts` (Phase 5c — reuse the exact pattern for signature + logo) |
| Auth'd blob fetch pattern | `web/src/components/observations/observation-photo.tsx` (blob → `URL.createObjectURL` → revoke; reuse verbatim for rendering signatures / logos) |
| iOS design parity notes | `memory/ios_design_parity.md` |

Legacy pre-rebuild pages (for UX reference only, not code reuse — the
new stack is React 19 + Tailwind 4):

- `_archive/web-legacy/app/(app)/settings/page.tsx` (settings hub)
- `_archive/web-legacy/app/(app)/settings/company/page.tsx` (company form)
- `_archive/web-legacy/app/(app)/settings/billing/page.tsx` (defer — billing is out of scope for Phase 6)

No legacy `inspectors/page.tsx` exists in `_archive/web-legacy/` despite
the changelog entry — that page lived in a prior `frontend/` tree that
was already archived before `web-legacy`. Port fresh from iOS.

## Backend API surface (no changes required)

All endpoints below are already live. Keep the web caller shape
matching the iOS caller shape so the server-side contract stays
singular.

### Settings + inspector profiles (`src/routes/settings.js`)

| Method · Path | Auth | Purpose |
|---|---|---|
| GET `/api/settings/:userId/defaults` | requireAuth | User certificate defaults |
| PUT `/api/settings/:userId/defaults` | requireAuth | Update defaults |
| GET `/api/settings/:userId/company` | requireAuth | Company branding JSON |
| PUT `/api/settings/:userId/company` | requireAuth | Update company JSON |
| GET `/api/inspector-profiles/:userId` | requireAuth | Array of profiles |
| PUT `/api/inspector-profiles/:userId` | requireAuth | Replace profiles array |
| POST `/api/inspector-profiles/:userId/upload-signature` | requireAuth (multipart, field `signature`, PNG/JPEG, 10MB max) | Returns `{signature_file: s3Key}` |

### System admin users (`src/routes/admin-users.js`, gated by `requireAdmin`)

| Method · Path | Body | Notes |
|---|---|---|
| GET `/api/admin/users` | `?limit=50&offset=0` | Paginated list |
| POST `/api/admin/users` | `{email, name, password, role?, company_id?, company_role?}` | password ≥ 8 chars |
| PUT `/api/admin/users/:userId` | `{name?, email?, company_name?, role?, is_active?}` | Rejects self-deactivation / self-demotion |
| POST `/api/admin/users/:userId/reset-password` | `{password}` | Invalidates sessions |
| POST `/api/admin/users/:userId/unlock` | — | Clears failed-attempt lockout |

### Companies (`src/routes/companies.js`)

| Method · Path | Auth | Purpose |
|---|---|---|
| GET `/api/companies` | requireAdmin | List all |
| POST `/api/companies` | requireAdmin | Create |
| GET `/api/companies/:companyId` | requireAuth (member or admin) | Read |
| PUT `/api/companies/:companyId` | requireAdmin | Update |
| GET `/api/companies/:companyId/users` | requireCompanyAdmin | Team list |
| POST `/api/companies/:companyId/invite` | requireCompanyAdmin | Returns `{userId, email, name, temporaryPassword}` |
| POST `/api/companies/:companyId/users/:userId/assign` | requireAdmin | Assign to company |
| GET `/api/companies/:companyId/jobs` | requireCompanyAdmin | `?limit=50&offset=0&employee_id=...` |
| GET `/api/companies/:companyId/stats` | requireCompanyAdmin | Counts envelope |

## Implementation plan

### 0. Pre-work (once, before 6a)

- Extend `User` in `web/src/lib/types.ts`:
  ```ts
  export interface User {
    id: string;
    email: string;
    name: string;
    company_name?: string;
    role?: 'admin' | 'user';
    company_id?: string;
    company_role?: 'owner' | 'admin' | 'employee';
  }
  ```
- Add three type exports: `InspectorProfile`, `CompanySettings`,
  `AdminUser` (extends User with `is_active`, `last_login`,
  `locked_until`, `failed_login_attempts`). Do this up-front so the
  API-client methods added per sub-phase can be fully typed.
- Add a tiny `web/src/lib/roles.ts` helper:
  ```ts
  export const isSystemAdmin = (u: User | null) => u?.role === 'admin';
  export const isCompanyAdmin = (u: User | null) =>
    isSystemAdmin(u) || u?.company_role === 'owner' || u?.company_role === 'admin';
  ```
  Every gated render calls these — do NOT inline the string comparisons
  at the call site. Keeps the whole codebase consistent when the role
  model evolves.
- Extend middleware (`web/src/middleware.ts`) so `/settings/admin/*`
  redirects non-admins to `/settings`. Decide the source of truth
  below — see "Design decisions" §1.
- Add a `useCurrentUser()` hook in `web/src/lib/auth.ts` (or a new
  `use-current-user.ts`) that returns `{user, refresh}` backed by
  `api.me()` on mount + `getUser()` for instant render. Every
  settings page needs live role info that's not stale.

### 6a — `/settings` hub + staff (inspector profiles)

**Routes:**
- `web/src/app/settings/layout.tsx` — top bar with back-to-dashboard
  + tabs sidebar (Profile, Staff, Company, Admin — the last two
  conditionally rendered). No RecordingProvider here — settings is
  out of the recording tree.
- `web/src/app/settings/page.tsx` — hub with role-gated quick-links
  to the sub-pages. Ports iOS `SettingsView.swift`.
- `web/src/app/settings/staff/page.tsx` — inspector list (ports
  `InspectorListView`).
- `web/src/app/settings/staff/[inspectorId]/page.tsx` — inspector
  detail editor (ports `InspectorDetailView`). `[inspectorId]` can be
  the literal string `new` to add a new profile.

**Components:**
- `web/src/components/settings/inspector-list.tsx` — card list with
  stacked-avatar hero (reuse iOS visual grammar), Add button, context
  menu (Edit / Set default / Delete).
- `web/src/components/settings/inspector-detail-form.tsx` —
  FloatingLabelInput fields (firstName, lastName, position,
  enrolment_number, organisation), `isDefault` toggle, equipment
  section (10 FloatingLabelInputs grouped into 5 device rows with a
  Collapse wrapper), and the signature canvas.
- `web/src/components/settings/signature-canvas.tsx` — HTML5
  `<canvas>` with pointer events. Reads existing signature via
  `<ObservationPhoto>`-style auth'd blob fetch (signatures are
  private S3 objects behind the API). Export: `canvas.toBlob('image/png')`
  on user tap-Save. Expose a `clear()` and a `getBlob()` to the
  parent form. Respect `prefers-reduced-motion` (no smoothing animation).

**API client methods (add):**
- `api.inspectorProfiles(userId): Promise<InspectorProfile[]>` — GET
- `api.updateInspectorProfiles(userId, profiles): Promise<void>` — PUT
- `api.uploadSignature(userId, blob): Promise<{signature_file: string}>`
  — multipart POST, reuse the `uploadObservationPhoto` pattern (same
  `FormData` + `Authorization` header dance).
- `api.fetchSignatureBlob(userId, filename)` — bespoke `fetch`
  returning a `Blob`, identical to `api.fetchPhotoBlob`. Different
  path (`/api/settings/:userId/signatures/:filename`) — verify with
  a `curl` first; if no direct route exists, the multipart upload
  is fine but reading back will need a new endpoint. **TODO: confirm
  before coding — may require a tiny backend addition.**

**Flow for signature save (the tricky bit):**
1. User draws on canvas → parent form holds a local `Blob | null`.
2. On Save: if a fresh blob exists, POST it via
   `api.uploadSignature` → get `signature_file` back.
3. Merge the returned s3 key into the in-memory profile.
4. PUT the full profiles array.
5. Clear the dirty flag.

Never PUT profiles with an inline base64 signature — the backend
schema expects a string key, not bytes.

### 6b — Company settings + company-admin dashboard

**Routes:**
- `web/src/app/settings/company/page.tsx` — company details form.
  Shown to any authenticated user (they can see their own company's
  branding). Editable only for company-admins — non-admins see a
  read-only view with an "ask your admin to edit" hint.
- `web/src/app/settings/company/dashboard/page.tsx` — 3-tab dashboard
  (Jobs / Team / Stats). Company-admin only.

**Components:**
- `web/src/components/settings/company-details-form.tsx` — fields
  from backend shape: `company_name`, `company_address`,
  `company_phone`, `company_email`, `company_website`,
  `company_registration`, `logo_file`. Use SectionCard to group.
- `web/src/components/settings/logo-uploader.tsx` — library-only
  image picker (no `capture="environment"` — company logos are rarely
  photographed), ~200×60 preview box, upload on select (match the
  eager-upload pattern from 5c).
- `web/src/components/settings/company-dashboard-tabs.tsx` — reuse
  `SegmentedControl`.
- `web/src/components/settings/team-list.tsx` — team member rows
  with role pill, last-login timestamp, Invite button.
- `web/src/components/settings/invite-employee-sheet.tsx` — modal
  with name + email + Invite action. **Critical:** after the API
  returns, show the returned `temporaryPassword` in a copy-to-clipboard
  box with a "This will only be shown once" notice. Don't silently
  drop it.
- `web/src/components/settings/company-stats-grid.tsx` — 3-up count
  cards (users, jobs, observations). No charts.

**API client methods (add):**
- `api.companySettings(userId)` / `api.updateCompanySettings(userId, patch)`
- `api.companyUsers(companyId)` — team list
- `api.companyJobs(companyId, params?)` — paginated
- `api.companyStats(companyId)`
- `api.inviteEmployee(companyId, {name, email})`
- `api.uploadCompanyLogo(userId, blob)` — **TODO: check if a logo-
  upload endpoint exists.** The backend settings route exposes
  company JSON read/write but I couldn't find a dedicated logo
  multipart endpoint. If it doesn't exist, two options:
  (a) add a tiny `POST /api/settings/:userId/logo` backend route
       mirroring the signature uploader, OR
  (b) inline base64 in `company_settings.logo_file`.
  Recommendation: **(a)**. Inline base64 bloats the JSON blob and
  cache-busts every read. Confirm with Derek before coding.

### 6c — System admin user management

**Routes:**
- `web/src/app/settings/admin/page.tsx` — guarded landing for
  non-admins ("You don't have access to this area"). System-admin
  only.
- `web/src/app/settings/admin/users/page.tsx` — paginated user list.
- `web/src/app/settings/admin/users/[userId]/page.tsx` — edit user
  form.
- `web/src/app/settings/admin/users/new/page.tsx` — create user
  form.

**Components:**
- `web/src/components/settings/admin-user-list.tsx` — table-ish card
  list with role pill, is_active badge, locked badge (if
  `locked_until > now`). Pagination at 50 per page.
- `web/src/components/settings/admin-user-form.tsx` — shared
  create/edit form. For edit, passes `initial` + hides password
  field. For create, requires password. For "edit myself",
  grey-out-and-disable the role + is_active controls with a tooltip
  ("You can't demote or deactivate yourself").
- `web/src/components/settings/reset-password-sheet.tsx` — modal
  with new-password field, validates ≥ 8 chars client-side, POSTs,
  shows success + "User's sessions have been invalidated" note.
- `web/src/components/settings/unlock-button.tsx` — conditional
  render (only when user is locked), one-click unlock with
  confirmation.

**API client methods (add):**
- `api.adminListUsers(params?)`
- `api.adminCreateUser(body)`
- `api.adminUpdateUser(userId, patch)`
- `api.adminResetPassword(userId, password)`
- `api.adminUnlockUser(userId)`

### Verify (every sub-phase)

```bash
cd web
npx tsc --noEmit
npm run lint
```

Baseline as of `cccd548`: 0 errors, 6 pre-existing warnings (unrelated
files — `react-hooks/exhaustive-deps` on five job tab pages + one
unused-vars on `job-tab-nav.tsx`). Don't regress either.

**Manual test plan (6a):**
- Log in as a normal user. `/settings` loads. Staff tab visible,
  Admin tab hidden.
- Add a new inspector profile with a drawn signature → save → list
  shows the new row → re-open → signature renders from S3.
- Delete a profile → confirm prompt → list updates.
- Toggle `isDefault` on one profile → only one has the green badge.

**Manual test plan (6b):**
- Log in as a company admin. Company Dashboard tab visible.
- Edit company name + logo → save → reload → values persist.
- Invite employee → modal shows the temp password once → copy →
  close → new user visible in Team list on next load.
- Jobs tab paginates (`limit=50`), Stats tab shows three counts.

**Manual test plan (6c):**
- Log in as a system admin. Admin tab visible.
- List users → paginate → edit → set is_active=false → save →
  affected user's next request 401s.
- Try to deactivate yourself → form disables the control with the
  tooltip (client-side block; backend also rejects).
- Reset a user's password → they can log in with the new one.
- Unlock a locked user → button disappears after success.

### Commit layout

- `feat(web): Phase 6a settings hub + inspector profiles`
- `feat(web): Phase 6b company settings + company-admin dashboard`
- `feat(web): Phase 6c system-admin user management`

Each with a full body per `CLAUDE.md` commit rules and a Changelog row.

## Design decisions to nail in the plan

1. **Role gating — middleware vs component.** Two options:

   - **Middleware-only:** read `cm_user` cookie (currently
     token-only), decode role, redirect non-admins before render.
     Fast, but requires duplicating the user in a cookie that's
     currently only in `localStorage`.
   - **Component-level:** every admin page calls `useCurrentUser()`,
     renders a `<Unauthorised />` fallback if the user lacks the
     role. Slightly slower (flash of loading) but single source of
     truth (`api.me()`).

   Recommendation: **Component-level, plus a belt-and-braces
   middleware check on the path prefix `/settings/admin`** that
   reads the existing `token` cookie, decodes the JWT payload
   (role is in the payload — backend signs it), and redirects
   without a server round-trip. Two layers of defence, one
   authoritative.

2. **Signature storage shape.** Store the returned s3 key on the
   profile as `signature_file`. Render via auth'd blob fetch. Don't
   even consider inline base64 — the canvas produces a ~30KB PNG
   and the profiles array grows linearly.

3. **Temp password display on invite.** The returned password must
   be shown once, never logged, never retained in state after the
   modal closes. Use a click-to-copy button with a "copied" toast.
   On modal close, null out the in-memory value.

4. **"Edit myself" in admin UI.** Linking from /settings/profile to
   the admin edit form is a footgun (user demotes themselves and
   loses the page). Keep /settings/profile as a separate, simpler
   form (name + email + change password) that hits a different
   endpoint than the admin one. Users who are also system admins
   see both.

5. **Inspector list cap.** iOS doesn't paginate — presumably no
   inspector has > 20 profiles. Port the same, but render with a
   virtualised list only if the count exceeds ~50 (unlikely). A
   simple mapped list is fine for v1.

6. **Equipment section.** Flat 10-field form, one collapsible
   SectionCard. Don't invent a nested schema — matches iOS storage
   shape exactly.

7. **Logo aspect ratio.** Don't crop client-side. Store whatever
   the user uploads; the PDF generators already handle aspect-ratio
   scaling. Cropping in the browser is Phase 7+ territory.

## Scope exclusions (for each commit message)

- Billing / subscription / Stripe (out of scope for whole rebuild).
- Email invitations (backend doesn't send — we show the temp
  password and the admin hands it off manually).
- Audit log UI (`src/auth.js` writes audit rows; surfacing them is
  a separate phase).
- Stats charts / trends — counts only.
- User profile avatar image upload — defer.
- Company logo cropping / aspect-ratio picker — defer.
- Offline edits / optimistic updates — Phase 7.
- Task Queue / system stats admin screens that `SettingsView` shows
  — iOS-only ops tool, deprioritised.
- Bulk actions (e.g. deactivate many at once) — defer.

## After Phase 6

- **Phase 7** — PWA manifest + offline + accessibility pass (service
  worker, offline cache, reduced-motion sweep, keyboard-nav audit,
  screen-reader audit).
- **Phase 8** — Staged deploy + production promotion (promote
  `web-rebuild` → `main`, update `docker/frontend.Dockerfile` to
  point at the new `web/`, verify CI/CD pipeline, cutover
  `certmate.uk`).

## Useful references

- Latest shipped commit: `cccd548` (Phase 5d LiveFillView).
- CLAUDE.md changelog: top rows for 5a–5d — follow the same level of
  detail on each 6a/6b/6c entry.
- Legacy UX shots (archived): `_archive/web-legacy/app/(app)/settings/`
  — useful for styling inspiration only; the Next.js 16 + Tailwind 4
  + CertMateDesign tokens live in `web/`.
- iOS parity notes: `memory/ios_design_parity.md`.
- Project memory: `.claude/projects/-Users-derekbeckley-Developer-EICR-Automation/memory/project_web_rebuild_phase5.md`
  (Phase 5 complete entry) — mint a new
  `project_web_rebuild_phase6.md` at 6a kickoff.
- Shared multipart-upload pattern: `api.uploadObservationPhoto` in
  `web/src/lib/api-client.ts` (Phase 5c). Signature + logo uploaders
  should be near-copies.
- Auth'd blob render pattern: `web/src/components/observations/observation-photo.tsx`.
