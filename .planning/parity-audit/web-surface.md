# Web Surface Enumeration

## 1. Top-level app routes (Next.js page.tsx files)

| Route | File path | Purpose |
|-------|-----------|---------|
| `/` | `/src/app/page.tsx` | Root redirect to dashboard |
| `/login` | `/src/app/login/page.tsx` | Authentication login screen with glass card UI |
| `/dashboard` | `/src/app/dashboard/page.tsx` | Home dashboard with job list, stats, and Start EICR/EIC buttons |
| `/alerts` | `/src/app/alerts/page.tsx` | Three-bucket alert view (Needs Attention, In Progress, Recently Completed) |
| `/offline` | `/src/app/offline/page.tsx` | Offline fallback with connection recovery messaging |
| `/settings` | `/src/app/settings/page.tsx` | Settings hub with navigation to sub-routes |
| `/dev-reference/primitives` | `/src/app/dev-reference/primitives/page.tsx` | Component library reference (dev-only) |

## 2. EICR/EIC job workflow tabs

Tabs are defined in a unified array for both EICR and EIC certificate types at `/src/components/job/job-tab-nav.tsx:49-60`.

| Tab label | Slug | File:line (tab definition) | File:line (content component) | Status badge |
|-----------|------|---------------------------|-------------------------------|--------------|
| Overview | `` (empty) | `/src/components/job/job-tab-nav.tsx:50` | `/src/app/job/[id]/page.tsx` | None |
| Installation | `/installation` | `/src/components/job/job-tab-nav.tsx:51` | `/src/app/job/[id]/installation/page.tsx` | complete |
| Supply | `/supply` | `/src/components/job/job-tab-nav.tsx:52` | `/src/app/job/[id]/supply/page.tsx` | complete |
| Board | `/board` | `/src/components/job/job-tab-nav.tsx:53` | `/src/app/job/[id]/board/page.tsx` | complete |
| Circuits | `/circuits` | `/src/components/job/job-tab-nav.tsx:54` | `/src/app/job/[id]/circuits/page.tsx` | warning |
| Inspection | `/inspection` | `/src/components/job/job-tab-nav.tsx:55` | `/src/app/job/[id]/inspection/page.tsx` | None |
| Extent | `/extent` | `/src/components/job/job-tab-nav.tsx:56` | `/src/app/job/[id]/extent/page.tsx` | None |
| Design | `/design` | `/src/components/job/job-tab-nav.tsx:57` | `/src/app/job/[id]/design/page.tsx` | None |
| Staff | `/staff` | `/src/components/job/job-tab-nav.tsx:58` | `/src/app/job/[id]/staff/page.tsx` | None |
| PDF | `/pdf` | `/src/components/job/job-tab-nav.tsx:59` | `/src/app/job/[id]/pdf/page.tsx` | None |

**Design tab location:** The "Design" tab is declared at `/src/components/job/job-tab-nav.tsx:57` with slug `/design` and routes to `/src/app/job/[id]/design/page.tsx`.

## 3. Settings hub pages

| Route | File path | Page heading |
|-------|-----------|-------------|
| `/settings` | `/src/app/settings/page.tsx` | User name (from context) + Settings hub menu |
| `/settings/about` | `/src/app/settings/about/page.tsx` | About |
| `/settings/change-password` | `/src/app/settings/change-password/page.tsx` | Change Password |
| `/settings/company` | `/src/app/settings/company/page.tsx` | Company Settings |
| `/settings/company/dashboard` | `/src/app/settings/company/dashboard/page.tsx` | Company Dashboard (role-gated: company admin / system admin) |
| `/settings/debug` | `/src/app/settings/debug/page.tsx` | Debug Dashboard (dev-only or debug toggle) |
| `/settings/defaults` | `/src/app/settings/defaults/page.tsx` | Defaults Manager |
| `/settings/defaults/values` | `/src/app/settings/defaults/values/page.tsx` | Default Values |
| `/settings/defaults/cable` | `/src/app/settings/defaults/cable/page.tsx` | Cable Size Defaults |
| `/settings/diagnostics` | `/src/app/settings/diagnostics/page.tsx` | Diagnostics |
| `/settings/invite` | `/src/app/settings/invite/page.tsx` | Invite Employee (role-gated: company admin) |
| `/settings/staff` | `/src/app/settings/staff/page.tsx` | Staff Members |
| `/settings/staff/[inspectorId]` | `/src/app/settings/staff/[inspectorId]/page.tsx` | Staff Member Detail (create/edit) |
| `/settings/system` | `/src/app/settings/system/page.tsx` | Offline Sync Admin |
| `/settings/admin/users` | `/src/app/settings/admin/users/page.tsx` | System Admin Users List (role-gated: system admin) |
| `/settings/admin/users/new` | `/src/app/settings/admin/users/new/page.tsx` | Create User (role-gated: system admin) |
| `/settings/admin/users/[userId]` | `/src/app/settings/admin/users/[userId]/page.tsx` | Edit User (role-gated: system admin) |

## 4. Modal sheets / dialogs / drawers

| Name | Trigger file:line | Component file:line | Purpose |
|------|-------------------|-------------------|---------|
| Confirm Dialog (generic) | Various pages | `/src/components/ui/confirm-dialog.tsx` | Confirmation wrapper for destructive actions (delete observations, clear cache, discard outbox mutations, delete staff members) |
| Observation Sheet (add/edit) | `/src/app/job/[id]/observations/page.tsx:66-75` | `/src/components/observations/observation-sheet.tsx:62` | Capture observation code, location, description, remedial action, and photo uploads (camera + library) |
| CCU Mode Sheet | `/src/app/job/[id]/circuits/page.tsx` (CCU Photo button) | `/src/components/job/ccu-mode-sheet.tsx` | Select CCU extraction strategy (Circuit Names Only / Full Capture / Hardware Update) before photo capture |
| Reset Password Sheet | `/src/app/settings/admin/users/[userId]/page.tsx:209-211` | `/src/app/settings/admin/users/[userId]/page.tsx:289-340 (ResetPasswordSheet)` | Admin reset password for system users |
| Invite Employee Sheet | `/src/app/settings/company/dashboard/page.tsx:325` | `/src/app/settings/company/dashboard/page.tsx:370-500 (InviteEmployeeSheet)` | Create new employee with email/name, returns one-time password |

## 5. Admin/management surfaces

| Surface | File:line | Role gate | Purpose |
|---------|-----------|-----------|---------|
| System Admin Users List | `/src/app/settings/admin/users/page.tsx:43` | `isSystemAdmin` | Paginated list of all system users with role/status pills and edit affordances |
| Create User (admin) | `/src/app/settings/admin/users/new/page.tsx:38` | `isSystemAdmin` | Admin create system user with email/name/password/role/company assignment |
| Edit User (admin) | `/src/app/settings/admin/users/[userId]/page.tsx:1` | `isSystemAdmin` | Admin edit system user: role, company role, activate/deactivate, lock/unlock, reset password |
| Company Dashboard | `/src/app/settings/company/dashboard/page.tsx:33` | `isCompanyAdmin` (includes system admin) | Tabbed view of company jobs, team members, and stats with invite affordance |
| Invite Employee | `/src/app/settings/invite/page.tsx:37` | `isCompanyAdmin` (includes system admin) | Company admin invite employee with email/name, returns one-time password |
| Offline Sync Admin | `/src/app/settings/system/page.tsx:48` | No gate (all authenticated users) | Inspect and manage offline mutation outbox: pending rows, poisoned rows, retry/discard affordances |

## 6. Recording / capture flows

| Name | Entry control file:line | Capture view file:line | Type |
|------|------------------------|------------------------|------|
| Voice Recording Session | `/src/components/job/floating-action-bar.tsx:21-39` (Mic FAB) | `/src/components/recording/recording-chrome.tsx:53-62` (chrome + action bar) | Audio transcription with transcript bar, VAD indicator, state pill, VU meter, Pause/End controls |
| CCU Photo Analysis | `/src/app/job/[id]/circuits/page.tsx` (CCU Photo button) | `/src/components/job/ccu-mode-sheet.tsx` → camera input → `/src/app/job/[id]/circuits/match-review/page.tsx` | Photo upload to `/api/analyze-ccu` with three application modes; Hardware Update shows match review screen |
| Document Extraction | `/src/app/job/[id]/circuits/page.tsx` (Extract Doc button) | Document file input (inline) | Upload document to extract circuit/installation data |
| Observation Photo Capture | `/src/components/observations/observation-sheet.tsx:92-99` | `/src/components/observations/observation-sheet.tsx` (photo grid + two inputs) | Two file inputs (Camera with `capture="environment"` for rear camera; Library without capture) for observation defect photos |
| Signature Capture | `/src/app/settings/staff/[inspectorId]/page.tsx` (Staff member edit) | `/src/components/settings/signature-canvas.tsx` | Canvas-based signature drawing with PNG upload to S3 |

## 7. Top-level routes I might have missed

| Route | File path | Notes |
|-------|-----------|-------|
| `/job/[id]` | `/src/app/job/[id]/layout.tsx` | Job detail shell wrapping all tabs (not a page, layout only) |
| `/job/[id]/circuits/match-review` | `/src/app/job/[id]/circuits/match-review/page.tsx` | Hardware Update match review screen (sub-route of circuits with sessionStorage handoff) |
| `/job/[id]/observations` | `/src/app/job/[id]/observations/page.tsx` | Observations list with photo grid (not in main tab nav; accessed via FAB or Overview) |

**Oddities:**
- No `/accounts` or `/profile` routes; user profile lives in settings hub
- Observations are accessible via `/job/[id]/observations` but are NOT a tab in the main nav bar (tab nav has 10 items only)
- Match review is a dynamic sub-route under circuits triggered by CCU Hardware Update flow, not a static tab
- Two entry points to invite: `/settings/invite` (full page) and company dashboard sheet (same backend)
- No separate route for company settings edit; company details edit flows on `/settings/company/page.tsx` inline

---

**Summary:**
- **Section 1:** 7 top-level routes
- **Section 2:** 10 tabs in unified nav
- **Section 3:** 17 settings routes
- **Section 4:** 5 modal/sheet/dialog surfaces
- **Section 5:** 6 admin/management surfaces (3 system admin, 2 company admin, 1 all-users)
- **Section 6:** 5 distinct recording/capture flows
- **Section 7:** 3 additional routes (layout + match review + observations page)
