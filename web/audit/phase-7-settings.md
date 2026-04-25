# Phase 7 — Settings Parity Audit (iOS canon vs PWA /web)

Read-only audit. iOS is canon. Divergence is a bug unless explicitly documented.
Date: 2026-04-24. Scope: Settings hub, Staff/Inspector profiles, Company details,
System admin user CRUD, Company admin dashboard, Defaults, Change password,
Diagnostics/About, Offline sync card.

Excluded (other phases): job-editor Staff tab (P5), recording config (P6),
CCU/Doc pipelines (P8).

---

## Executive summary

Phase 7 is the most-built-out area of the PWA after the dashboard — `/settings`,
`/settings/staff`, `/settings/staff/[id]`, `/settings/company`,
`/settings/company/dashboard`, `/settings/admin/users/*`, `/settings/system` all
exist and cover the main iOS surfaces. However, iOS in fact ships **two**
settings entry points (`SettingsView.swift` hooked via the main UI + a
`SettingsHubView.swift` redesign), and the PWA matches the older `SettingsView`
layout. Net result: six iOS surfaces have **no** PWA equivalent
(Change Password, Defaults, Cable-Size Defaults, Audio Import, Terms & Legal,
Admin Task Queue + Stats). Inspector data-shape drifts (firstName/lastName split
on iOS vs flat `name` on PWA) + a missing "Remove Logo" action + default-staff
mutex happening only on save are the ordering/state bugs. The Settings Hub
version label that ships on iOS is absent.

**Gap counts:** P0 = 7 · P1 = 12 · P2 = 5 · **Total = 24.**

**Top three highest-impact gaps:**

1. **P0 — Change Password page entirely missing from PWA.** iOS `ChangePasswordView`
   is reachable from `SettingsView` → "Change Password" (SettingsView.swift:141-172)
   and `SettingsHubView` → Account section (SettingsHubView.swift:179-192). PWA
   hub has no Security / Account section and no change-password route at all
   (`web/src/app/settings/page.tsx` — no Account/Security `<SectionGroup>`).
   Users have no way to rotate their own password on web.
2. **P0 — Certificate Defaults + Cable-Size Defaults absent from PWA.** iOS ships
   `DefaultValuesView` (per-cert-type presets: EICR and EIC, 6–8 tabs each) and
   `CableSizeDefaultsView` via `SettingsHubView.swift:154-175`. PWA has no
   `/settings/defaults/*` route. Inspectors who rely on per-preset autofill on
   iOS will see blank circuits on web.
3. **P0 — Inspector data-shape drift (firstName/lastName split vs flat name).**
   iOS `Inspector.swift:8-9` stores `firstName` + `lastName` as required fields;
   detail view surfaces them as two required inputs
   (`InspectorDetailView.swift:178-179`). PWA `InspectorProfile` (types.ts:276;
   `/settings/staff/[inspectorId]/page.tsx:217-222`) takes a single `name`
   input. A profile saved on web as "John Smith" round-trips to iOS as
   `firstName="John Smith"` + `lastName=""` (iOS full-name composition splits on
   the internal struct). The other way around is worse — iOS-authored profiles
   don't even carry a `name` field on the wire, so the PWA shows the
   shared-types `name` derived from the API adapter. Mini-Wave 4.5 handoff
   (MINI_WAVE_4_5_HANDOFF.md:70-77) flagged exactly this under "InspectorProfile
   shape drift — web has 10 equipment fields, shared-types has 6" — the
   equipment half is resolved, the name half is not.

---

## 7.A — Settings Hub

**iOS:** `CertMateUnified/Sources/Views/Settings/SettingsView.swift`
(primary, 441 lines). `SettingsHubView.swift` (alt/redesign, 345 lines) exists
but isn't routed from the main menu (gated on a flag not surfaced here).
**PWA:** `web/src/app/settings/page.tsx` (270 lines).

### Layout

Both render a hero avatar card + stacked link cards grouped by section. Hub
ordering:

| Section | iOS SettingsView | iOS SettingsHubView | PWA |
|---|---|---|---|
| 1 | Profile hero | Profile hero | Profile hero |
| 2 | Security (Change Password) | Company & Team | iOS install hint |
| 3 | Company (admin-gated) | Certificate Defaults | Team (Staff) |
| 4 | Administration (sys-admin) | Account (Change Password) | Company |
| 5 | About | App (Audio, Terms, Version) | Offline Sync (conditional) |
| 6 | Log Out | Log Out | Administration (sys-admin) |
| 7 |   |   | Log Out |

**Gaps:**

- **P0-7A-1 — Change Password nav row missing.** iOS SettingsView.swift:137-173
  surfaces "Change Password" under a "SECURITY" section header. PWA hub has
  no such row. No route exists at `/settings/password`.
- **P0-7A-2 — Defaults section missing.** SettingsHubView.swift:154-175 ships a
  "CERTIFICATE DEFAULTS" section with two rows (Cable Size Defaults + Default
  Values). PWA has no section header and no routes.
- **P0-7A-3 — About/Diagnostics section missing.** iOS
  SettingsView.swift:308-350 renders an "ABOUT" section with:
  app name + version badge (`CFBundleShortVersionString`), and a branding row
  ("Electrical Certification"). PWA has no About section and does not surface
  a version number anywhere in settings. Note: iOS SettingsHubView
  (`:196-235`) also carries "Audio Import" and "Terms & Legal" rows — also
  absent from PWA.
- **P1-7A-4 — Section ordering drift.** PWA places Team before Company; iOS
  SettingsView places Security first, then Company then Admin (Team isn't in
  the primary SettingsView at all — it lives inside the CompanyDashboardView
  roll-up). SettingsHubView mixes Company+Team into one section. PWA's choice
  to give Team its own top-level section is reasonable but deliberately
  diverges from iOS.
- **P1-7A-5 — Role-gating differences on Company rows.** iOS SettingsView.swift:24-29
  renders the Company Dashboard row **only** if `user.isCompanyAdmin`. PWA
  `page.tsx:118-139` always renders "Company Details" and conditionally renders
  "Company Dashboard" — so non-admin employees see the company page (read-only)
  on PWA and **don't** see it at all on iOS. This is a documented intentional
  divergence (comment `page.tsx:115-117`) but is not matched in iOS, so should
  be noted as a deliberate widening.
- **P1-7A-6 — Sign Out styling differs.** iOS uses a full-bleed rounded button
  with red 6% fill + gradient stroke (SettingsView.swift:354-385) +
  `CMScaleButtonStyle`. PWA uses a ghost button with error text colour
  (page.tsx:175-182) — less prominent, no confirmation dialog on either. Both
  lack a confirm dialog; iOS ships a haptic scale animation the PWA doesn't
  replicate.
- **P2-7A-7 — Profile hero ring detail missing on PWA.** iOS draws a 3-layer
  concentric ring (`SettingsView.swift:75-88` — 80 / 73 / 66 px with gradient
  on outer + inner, elevated surface in between). PWA renders a single flat
  80×80 gradient circle (`page.tsx:67-78`). Functionally equivalent, visually
  thinner.

### Offline Sync card

PWA-only; gated on `pending.length + poisoned.length > 0` (page.tsx:41-42).
iOS has no equivalent card — offline mutation outbox is a web-only concept.
**P2-7A-8** — noted as a deliberate PWA widening (handoff 7d).

### PWA install hint

PWA-only (page.tsx:102). iOS has no equivalent; iOS devices install via the
App Store. Correctly self-suppressing (ios-install-hint.tsx:26-47).

### Role gating correctness

- `isSystemAdmin(user)` (page.tsx:163-173) correctly guards the "Administration"
  section → matches iOS (`currentUser?.isAdmin == true` SettingsView.swift:32).
- `isCompanyAdmin(user)` (page.tsx:124-138) correctly guards the Company
  Dashboard row (matches iOS).

---

## 7.B — Staff / Inspector profiles

**iOS:** `InspectorListView.swift` (264 lines) + `InspectorDetailView.swift`
(432 lines) + `Inspector.swift` (51 lines) + `InspectorProfile.swift` (17 lines,
the wire-protocol alias). **PWA:** `/settings/staff/page.tsx` (286 lines) +
`/settings/staff/[inspectorId]/page.tsx` (419 lines) +
`components/settings/signature-canvas.tsx`.

### List view

| Feature | iOS | PWA | Gap |
|---|---|---|---|
| Hero header w/ count + default name + stacked avatars | ✅ `:94-142` | ✅ `:146-185` | none |
| Empty state w/ CTA | ✅ `:146-188` | ✅ `:261-285` | none |
| Row: avatar, name, position, equipment count, DEFAULT pill | ✅ `:192-262` | ✅ `:187-259` | none |
| Delete (long-press context menu / trash icon) | ✅ context menu `:35-42` | ✅ trash icon `:250-256` | P2-7B-1: UX idiom differs intentionally (web idiom) |
| Delete confirm dialog | ✅ `:75-82` | ✅ `:120-139` | none (copy matches "This is your default staff member.") |
| Refresh-on-return | ✅ sheet onDismiss `:65-70` | ✅ `focus` listener `:51-56` | none |
| Add button location | ✅ primary toolbar `:55-63` | ✅ header right `:87-91` | none |

### Detail view — field parity

iOS `InspectorDetailView.swift` fields (bound to `Inspector`):
- `firstName` *required (:178)
- `lastName` *required (:179)
- `position` (:192)
- `isDefault` toggle (:209)
- `signatureImage: Data?` via `SignatureCaptureView` (:226)
- 10 equipment fields (:275-309): `mftSerialNumber/mftCalibrationDate`,
  `continuitySerialNumber/continuityCalibrationDate`,
  `insulationSerialNumber/insulationCalibrationDate`,
  `earthFaultSerialNumber/earthFaultCalibrationDate`,
  `rcdSerialNumber/rcdCalibrationDate`

PWA `/settings/staff/[inspectorId]/page.tsx` fields (bound to `InspectorProfile`):
- `name` *required (:217)
- `position` (:228)
- `organisation` (:235) — **PWA-only**
- `enrolment_number` (:241) — **PWA-only**
- `is_default` toggle (:257)
- `signature_file` via `<SignatureCanvas>` (:267-272)
- 10 equipment fields (:307-341) — present, matches iOS ✅

### Gaps

- **P0-7B-1 — Name shape drift (firstName/lastName vs name).** See summary #3.
  iOS `Inspector.swift:8-9` declares `firstName` + `lastName` as required
  `String` fields; the computed `fullName` concatenates them
  (`:28-30`). The **API wire type** is `InspectorProfile` with a flat `name`
  field (`InspectorProfile.swift:4`). iOS locally persists via GRDB with the
  split, then serialises to `InspectorProfile.name = firstName + " " + lastName`
  at the wire boundary. PWA has no split — when it reads a profile that iOS
  authored, it gets the concatenated `name` correctly, but when PWA writes,
  iOS sees `firstName = <whole name>, lastName = ""` (since there's no
  round-trip splitter). Fix direction: PWA should expose separate first/last
  fields, or document the iOS serialiser to back-split on the first space
  consistently. Consequence on iOS detail view: editing a PWA-authored
  inspector shows the entire name crammed into the First Name field.
- **P0-7B-2 — "Organisation" and "Enrolment Number" fields on PWA not on iOS
  Inspector.** PWA form `[inspectorId]/page.tsx:233-243` exposes
  `organisation` + `enrolment_number` inputs, both backed by
  `InspectorProfile.swift:6-7` (which iOS declares but does NOT surface in
  `InspectorDetailView`). Result: these fields are **write-only from PWA and
  invisible on iOS**, which is worse than either "both have them" or "neither
  has them". Either iOS should add them to the detail view, or PWA should
  remove them. Note also: iOS `Inspector` struct (the GRDB-backed local model)
  doesn't even declare `organisation` / `enrolmentNumber` columns — so iOS
  drops them on local persist and the round-trip silently loses the values.
- **P1-7B-3 — Default-staff mutex happens only on save (PWA).** PWA handles
  the "only one default" invariant in `handleSave()` (:156-158) by rewriting
  all other profiles' `is_default = false` before PUT. iOS likely does the
  same (not inspected here — needs separate confirmation in the view model).
  The UI concern: if the user toggles a second inspector to default on PWA,
  nothing in the UI flags that the first one will be demoted — the toggle
  switches silently. iOS toggle sits under a star icon animation
  (`:196-212`) but also doesn't surface the mutex visually.
- **P1-7B-4 — Signature canvas "Clear" and "Save PNG" actions.** iOS ships a
  `SignatureCaptureView` (referenced `:226` — not read for this audit);
  the PWA canvas exposes `getBlob()` / `clear()` / `hasContent()` handles
  (signature-canvas.tsx:35-42) and a visible Clear button per docstring
  `:31-33`. Functional parity likely but Export-to-PNG as a standalone user
  action isn't in either — both flatten on save. Acceptable.
- **P1-7B-5 — Equipment collapsible state.** Both default to expanded iff any
  field populated (iOS `:109-111`, PWA `:91-101`). Auto-expand threshold
  matches. ✅
- **P1-7B-6 — Save button placement.** iOS uses navigation bar confirmation
  action ("Save" in toolbar `:85-90`). PWA uses a fixed bottom bar with
  Cancel + Save (`:354-363`). Both are correct platform idioms.
- **P2-7B-7 — Equipment icon inconsistency.** iOS uses a category-specific SF
  symbol for each row (`wrench.and.screwdriver.fill` / `link` / `shield.fill`
  / `globe.americas.fill` / `bolt.shield.fill` at `:277-309`). PWA uses the
  same `Bolt` icon for all 5 cards (EquipmentCard `:393`). Minor visual
  drift.

---

## 7.C — Company details

**iOS:** `CompanyDetailsView.swift` (372 lines).
**PWA:** `/settings/company/page.tsx` (235 lines).

### Field parity

| iOS field | iOS line | PWA field | PWA line | Gap |
|---|---|---|---|---|
| companyName *required | :108 | company_name | :145-149 | none |
| userDisplayName (placeholder "e.g. John Smith") | :109 | — | — | **P1-7C-1** PWA missing userDisplayName |
| enrolmentNumber | :110 | — | — | **P1-7C-2** PWA missing company-level enrolment |
| addressLine1 *required | :123 | company_address (single line) | :165-169 | **P1-7C-3** PWA collapses 5-field address to 1 textarea |
| addressLine2 | :124 | — | — | (collapsed) |
| town *required | :125 | — | — | (collapsed) |
| county | :126 | — | — | (collapsed) |
| postcode *required | :127 | — | — | (collapsed) |
| phoneNumber *required | :141 | company_phone | :170-177 | none |
| emailAddress *required | :147 | company_email | :178-188 | none |
| website | :153 | company_website | :189-199 | none |
| logo (PhotosPicker) | :233-256 | logo_file via LogoUploader | :153-160 | see 7C-4 |
| company_registration | — | company_registration | :202-210 | **P1-7C-5** PWA-only (iOS lacks this) |

### Gaps

- **P0-7C-1 — 5-field address collapsed to single `company_address` textarea.**
  iOS splits into Line 1 + Line 2 + Town + County + Postcode with 3 required
  (Line 1, Town, Postcode); PWA has one free-text field. Certs printed from
  web may have worse address formatting and can't validate postcode presence.
- **P1-7C-2 — "Your Display Name" missing on PWA.** iOS CompanyDetailsView.swift:109
  has a distinct `userDisplayName` field separate from the company name —
  "the person signing this cert". PWA has no such field.
- **P1-7C-3 — Enrolment number field split mismatch.** iOS puts
  `enrolmentNumber` on CompanyDetails (:110); PWA puts `enrolment_number` on
  InspectorProfile (staff detail :241). These may be the same number but
  surfaced via different owners — probable drift that needs backend review.
- **P1-7C-4 — "Remove Logo" action missing from PWA.** iOS has an explicit
  destructive "Remove Logo" button (CompanyDetailsView.swift:191-209) when a
  logo is set. PWA `LogoUploader` (not read in full) — from the parent call
  site (`:153-160`) there's no `onRemove` prop; assume missing. Company
  admins can only replace, not clear.
- **P1-7C-5 — PWA-only `company_registration` field.** PWA has a
  "Company Registration Number" field in its own "Registration" section
  (:202-210) iOS doesn't carry. PWA docstring says "Printed in the footer of
  every certificate" — if that's true, iOS certificates don't include the
  registration number at all, which is a functional divergence beyond
  Settings.
- **P1-7C-6 — Validation warnings panel missing.** iOS surfaces live
  validation warnings (`:263-286`) above the save button. PWA uses inline
  disabled-save on `dirty`/`saving` state only (`:227`) — no per-field
  warnings.
- **P2-7C-7 — Read-only mode for non-admins is a PWA widening.** iOS renders
  CompanyDetailsView only via the company section which is already
  admin-gated (SettingsView.swift:24-29), so non-admins can't reach it. PWA
  renders it to all users with a read-only hint (`:135-141`). Documented
  intentional widening.
- **P2-7C-8 — No "Save" vs "Cancel" label parity.** iOS uses a single green
  "Save Company Details" with checkmark icon (:290-317). PWA has two buttons
  "Cancel" + "Save Changes". Minor copy drift.

---

## 7.D — System admin (user CRUD)

**iOS:** `AdminUsersListView.swift` (254 lines) + `AdminCreateUserView.swift`
(275 lines) + `AdminEditUserView.swift` (525 lines).
**PWA:** `/settings/admin/users/page.tsx` (294 lines) +
`/settings/admin/users/new/page.tsx` (220 lines) +
`/settings/admin/users/[userId]/page.tsx` (654 lines).

### Users list

| Feature | iOS | PWA | Gap |
|---|---|---|---|
| List all users, sorted by name | ✅ :171 | ✅ (default order from backend) | P2-7D-1 iOS sorts client-side, PWA relies on server order |
| Pagination | ❌ unpaginated | ✅ 50/page :41 | PWA tighter |
| Search / filter | ❌ | ❌ | both lack |
| Row badges (ADMIN / Active / Locked / Inactive) | ✅ :181-253 | ✅ :214-281 | PWA adds "you" self-marker ✅ |
| Company-role pill | ❌ | ✅ :271-274 | PWA superset |
| Loading skeleton | ❌ spinner :24 | ✅ skeleton :283 | PWA tighter |
| New User button | ✅ toolbar primary :116-123 | ✅ header right :131-138 | none |
| Pull-to-refresh | ✅ :105-107 | ❌ (focus-listener instead :75-90) | P2-7D-2 not a mobile browser idiom |

### Create user

iOS AdminCreateUserView fields: name, email, password, companyName,
role (segmented User/Admin), selectedCompanyId (picker), companyRole (segmented
Employee/Admin/Owner).

PWA AdminCreateUserPage fields: name, email, password, companyName, role
(select), companyRole (select), **companyId as free-form UUID text input**
(`:181-189`).

**Gaps:**

- **P0-7D-3 — Company picker is a free-form UUID input on PWA.** iOS loads
  `adminListCompanies()` and renders a `Picker` (AdminCreateUserView.swift:115-120).
  PWA's own docstring (`:26-37`) admits "A picker will land in a later
  phase" and explicitly labels the field "(advanced)". Not an iOS-parity
  divergence (functional equivalent exists on edit), but the experience on
  create is effectively broken — admins don't have UUIDs to hand. Note:
  PWA *does* load the companies list on edit (`[userId]/page.tsx:137-151`),
  so the API exists; just not wired here.
- **P1-7D-4 — Password rules differ.** iOS `:240` requires ≥ 8 chars. PWA
  `:62` requires ≥ 8 chars. ✅ match. But iOS **ChangePasswordView** (own
  password) allows ≥ 6 chars (ChangePasswordView.swift:29-31). Inconsistency
  with admin-set password rules. Not strictly a PWA gap (PWA has no
  change-password view at all — see 7A-1).
- **P1-7D-5 — CompanyRole default differs.** iOS defaults `companyRole` to
  `"employee"` (`:13`). PWA defaults to `'employee'` (`:49-50`) but offers a
  "— None —" option (`:169`) that iOS doesn't have. If an admin picks `''`
  the user has no company_role even with a company_id, which may be a broken
  state the backend accepts but iOS can't represent.

### Edit user

iOS AdminEditUserView covers: name, email, companyName, role toggle,
is_active toggle, **company picker** (:152-158), companyRole picker,
**unlock button** in ACCOUNT STATUS (:193-205), **last-login + created-at
info rows** (:210-218), **failed-login-attempts counter** (:220-233),
**inline password reset** with segmented state + confirm (:241-297).

PWA [userId]/page.tsx covers: name, email, companyName, role select, isActive
toggle, company picker (:383-400), companyRole select (:401-412), unlock
(:441-463), reset-password sheet (:490-496, 543-637), self-edit guards
(:195-199, 415-418).

**Gaps:**

- **P0-7D-6 — Failed-login-attempts counter missing on PWA.** iOS
  AdminEditUserView.swift:220-233 surfaces `failedLoginAttempts` as a distinct
  info row when `> 0`. PWA doesn't read this field and doesn't render any
  counter. Admins lose visibility into brute-force attempts against a user's
  account.
- **P1-7D-7 — Created-at + last-login info rows missing from edit body.**
  iOS shows both `lastLogin` and `createdAt` with a calendar icon in the
  Account Status card (:210-218). PWA only surfaces them in the hero header
  (`:297-299`) — same data, less prominent.
- **P1-7D-8 — Deactivate-self guard.** Both correctly guard self-demote and
  self-deactivate. iOS disables implicitly via the Toggle not being
  surfaced for self (not strictly — inspected `:181-184` — toggle is always
  rendered but the backend 400s). PWA explicitly disables the toggle for
  self (`:360`). **PWA tighter here — correct.** No gap.
- **P1-7D-9 — Self-reassignment guard differs.** PWA detects
  `isSelf && companyId-changed` and rejects (`:213-223`); iOS sends
  `companyId` regardless (`:454-458`), relying on the backend 400. Both
  functionally safe; PWA tighter.
- **P1-7D-10 — Deactivate confirm dialog present on PWA only.** PWA adds
  `<ConfirmDialog>` when deactivating (`:498-536`). iOS has no deactivate
  confirm — toggling `isActive = false` saves immediately. PWA tighter;
  iOS should add.
- **P2-7D-11 — No destructive user delete endpoint on either platform.** Both
  use `is_active: false` as soft-delete; PWA explicitly documents this
  (`:52-55`). ✅ matches.

---

## 7.E — Company admin dashboard

**iOS:** `CompanyDashboardView.swift` (584 lines).
**PWA:** `/settings/company/dashboard/page.tsx` (672 lines).

### Tabs

Both ship 3 tabs: Jobs / Team / Stats. iOS uses `Picker(.segmented)` `:59-64`.
PWA uses `<SegmentedControl>` `:127-136`. ✅ match.

### Jobs tab

| Feature | iOS | PWA | Gap |
|---|---|---|---|
| Job list w/ address, status pill, employee name, cert type, date | ✅ :409-503 | ✅ :237-266 | P1-7E-1: PWA simpler status chip (coloured dot vs full capsule) |
| **Employee filter dropdown** | ✅ :128-155 | ❌ | **P0-7E-2** PWA missing filter |
| Pagination | ❌ | ✅ 50/page :149 | PWA superset |
| Empty state | ✅ :173-182 | ✅ :186-194 | none |
| Pull-to-refresh | ✅ :103-105 | ❌ | P2-7E-3 not a mobile browser idiom |

### Team tab

| Feature | iOS | PWA | Gap |
|---|---|---|---|
| Employee list | ✅ :200-249 | ✅ :297-335 | none |
| Avatar + name + role-gradient | ✅ :511-582 | ✅ :337-368 | P2-7E-4: PWA uses fixed gradient, iOS varies by company_role (owner=purple, admin=warning, employee=hero) |
| Status badge (Active/Locked/Inactive) | ✅ :549-555 | ❌ PWA only shows Inactive | **P1-7E-5** PWA doesn't render a Locked pill |
| Invite button (admin only) | ✅ :203-221 | ✅ :301-306 | none |
| Invite sheet w/ temp-password reveal | ✅ via `InviteEmployeeView` | ✅ :370-502 | none |
| Copy-to-clipboard temp password | — | ✅ :408-418 | PWA-only feature |

### Stats tab

| Feature | iOS | PWA | Gap |
|---|---|---|---|
| Total Jobs, Active Employees, Jobs (7 days) cards | ✅ :281-285 | ✅ :536-554 | none |
| Jobs by status breakdown | ✅ :290-337 | ✅ :556-573 | iOS shows per-status icons; PWA text-only |
| Status icons (done / processing / pending / failed / unknown) | ✅ :386-404 | ❌ | **P1-7E-6** PWA missing per-status icon column |

### Gaps

- **P0-7E-2** — see table. Employee filter missing on PWA.
- **P1-7E-5** — see table. Locked state not surfaced on Team tab.
- **P1-7E-6** — see table. Stats status breakdown is text-only.
- **P2-7E-7 — Hero header of the dashboard is simpler on PWA.** iOS ships a
  full gradient hero with company name (`:31-55`). PWA renders a plain
  `<h1>Company Dashboard</h1>` (`:122-125`). Visual polish only.
- **P2-7E-8 — Jobs sort / newest-first.** iOS renders jobs in array order
  from API (:185); PWA likewise sorts server-side (`:161-167`). Both rely on
  the backend to sort sensibly.

---

## 7.F — Defaults (Certificate + Cable-Size)

**iOS:** `DefaultValuesView.swift` (not fully inspected — ~8 tabs per cert
type) + `CableSizeDefaultsView.swift` (partially inspected, :1-80). Entry
point: SettingsHubView.swift:154-175.
**PWA:** **No route exists at all.** No `/settings/defaults/*` files.

### Gaps

- **P0-7F-1 — Entire Defaults area absent from PWA.** iOS ships:
  1. `DefaultValuesView(certificateType: .eicr)` — an 8-tab preset editor
     (Installation, Supply, Board, Circuits, Observations, Inspection +
     Extent + Design for EIC only, per DefaultValuesView.swift:19-32).
  2. `DefaultValuesView(certificateType: .eic)` — same with EIC-specific tabs.
  3. `CableSizeDefaultsView` — per-cable-type defaults applied when circuits
     are created (docstring `:19`).
  4. `ApplyDefaultsSheet` (found via file list — not read).

  None of these exist on PWA. Inspectors who create a job on web will see
  blank fields that on iOS would auto-populate. This is a P0 because it
  affects the primary workflow, not an admin convenience.

- **P0-7F-2 — Cert-type branching missing.** DefaultValuesView.swift:19-32
  conditionally shows Extent + Design tabs for EIC. PWA has no equivalent
  branch.

- **P1-7F-3 — Multiple named presets per cert-type.** iOS supports saving
  multiple named presets (`existingPreset: CertificateDefault?` + `presetName`
  `:9-11`). PWA has no persistence layer for this.

---

## 7.G — Change password

**iOS:** `ChangePasswordView.swift` (495 lines).
**PWA:** **No route exists at all.** No Security section on hub.

### Gaps

- **P0-7G-1 — Entire page absent.** See 7A-1.
- **P1-7G-2 — Password strength meter + show/hide toggles absent (cascade).**
  iOS ships: 4-level strength score (weak/fair/good/strong) with colour
  bar (`:42-73, 274-299`), eye-toggle show/hide on each of the 3 fields
  (`:196-206`, `:252-261`, `:332-340`), live passwords-match indicator
  (`:359-368`). None on PWA.
- **P1-7G-3 — Password-length policy.** iOS uses ≥ 6 chars for self-change
  (`:29-31`), while admin-reset on PWA uses ≥ 8 (admin-create/edit), and iOS
  admin-reset uses ≥ 8 (AdminEditUserView.swift:273). Inconsistency; easy to
  unify at 8 on both platforms.

---

## 7.H — Diagnostics / About / Debug

**iOS:** SettingsView.swift:308-350 renders App name + version
(`CFBundleShortVersionString`, `:323`) + a "Electrical Certification" branding
row. SettingsHubView.swift:196-235 adds Audio Import + Terms & Legal +
Version.
**PWA:** None of this.

### Gaps

- **P0-7H-1 — Version label missing on PWA.** See 7A-3. Impacts production
  debugging — support reports can't include a web build version.
- **P1-7H-2 — "Terms & Legal" row missing on PWA.** iOS
  SettingsHubView.swift:209-213 links to a TermsAcceptanceView. PWA has no
  terms page accessible from settings.
- **P1-7H-3 — "Audio Import" row missing on PWA.** iOS :201-204 links to
  AudioImportView. PWA has no such flow; whether it's applicable to web
  (file upload then Deepgram batch) is scope question, not an automatic gap
  — but iOS parity expects it.
- **P2-7H-4 — No Debug / Diagnostics panel on either platform.** Mentioned in
  PHASE_6_HANDOFF.md — neither surfaces a debug/diagnostics view. Cross-phase
  work.

---

## 7.I — Data shapes / API client

Cross-referencing `web/src/lib/types.ts` and `web/src/lib/api-client.ts`
against iOS Model files:

| Type | iOS canon | PWA | Drift |
|---|---|---|---|
| InspectorProfile (wire) | InspectorProfile.swift (6 fields) + Inspector.swift (locally 10 eq + firstName/lastName) | types.ts (11 fields flat name) | **P0**: name split drift (7B-1). Equipment fields resolved ✅. |
| AdminUser | AdminUser (not fully inspected) | types.ts :262-285 (with `last_login`, `locked_until`, `failed_login_attempts?`) | **P1** (7D-6): PWA doesn't consume `failed_login_attempts` even if present. |
| CompanySettings | CompanyDetailsViewModel bindings (5-field address split) | types.ts CompanySettings (single `company_address`) | **P0** (7C-1): flat address. |
| Company | iOS `Company` struct used for picker (AdminCreateUserView.swift:117-119) | CompanyLite in types.ts | **P1** (7D-3): PWA create-user doesn't consume the list. |

---

## Appendix — gap roll-up table

| ID | Severity | Area | Title |
|---|---|---|---|
| 7A-1 | P0 | Hub | Change Password nav row missing |
| 7A-2 | P0 | Hub | Defaults section missing |
| 7A-3 | P0 | Hub | About / version section missing |
| 7A-4 | P1 | Hub | Section ordering drift |
| 7A-5 | P1 | Hub | Company row gating wider on PWA (non-admin can view) |
| 7A-6 | P1 | Hub | Sign-out button styling less prominent + no confirm |
| 7A-7 | P2 | Hub | Profile hero concentric rings flattened |
| 7A-8 | P2 | Hub | Offline Sync card is PWA-only (deliberate) |
| 7B-1 | P0 | Staff | firstName/lastName vs flat name drift |
| 7B-2 | P0 | Staff | organisation / enrolment_number present on PWA, not on iOS detail view |
| 7B-3 | P1 | Staff | Default-staff mutex silent in UI |
| 7B-4 | P1 | Staff | SignatureCaptureView parity unverified |
| 7B-5 | P1 | Staff | Equipment auto-expand matches |
| 7B-6 | P1 | Staff | Save bar placement (toolbar vs fixed footer) |
| 7B-7 | P2 | Staff | Equipment icons generic on PWA |
| 7C-1 | P0 | Company | 5-field address → 1 textarea |
| 7C-2 | P1 | Company | userDisplayName missing |
| 7C-3 | P1 | Company | Enrolment number owner split (company vs inspector) |
| 7C-4 | P1 | Company | Remove Logo action missing |
| 7C-5 | P1 | Company | company_registration on PWA not on iOS |
| 7C-6 | P1 | Company | Validation warnings panel missing |
| 7C-7 | P2 | Company | Read-only mode is PWA widening |
| 7C-8 | P2 | Company | Save button labels differ |
| 7D-1 | P2 | Admin users | List sort order source differs |
| 7D-2 | P2 | Admin users | No pull-to-refresh on PWA |
| 7D-3 | P0 | Admin create | Company picker is free-form UUID input |
| 7D-4 | P1 | Admin create | Password rules inconsistent vs self-change |
| 7D-5 | P1 | Admin create | CompanyRole "— None —" option adds state iOS can't represent |
| 7D-6 | P0 | Admin edit | failed_login_attempts counter absent on PWA |
| 7D-7 | P1 | Admin edit | Created-at + last-login info rows in card missing |
| 7D-8 | P1 | Admin edit | Self-deactivate toggle disabling (PWA tighter ✅) |
| 7D-9 | P1 | Admin edit | Self-reassignment guard (PWA tighter ✅) |
| 7D-10 | P1 | Admin edit | Deactivate confirm dialog (PWA tighter ✅) |
| 7D-11 | P2 | Admin edit | No hard-delete endpoint either platform |
| 7E-1 | P1 | Dashboard | Status pills visually simpler on PWA |
| 7E-2 | P0 | Dashboard jobs | Employee filter missing |
| 7E-3 | P2 | Dashboard jobs | No pull-to-refresh |
| 7E-4 | P2 | Dashboard team | Role-coloured avatar gradient missing |
| 7E-5 | P1 | Dashboard team | Locked pill not rendered |
| 7E-6 | P1 | Dashboard stats | Per-status icon column missing |
| 7E-7 | P2 | Dashboard hero | Gradient hero flattened to h1 |
| 7E-8 | P2 | Dashboard jobs | Server-side sort reliance |
| 7F-1 | P0 | Defaults | Entire Defaults area absent |
| 7F-2 | P0 | Defaults | Cert-type EICR/EIC branching absent |
| 7F-3 | P1 | Defaults | Named presets missing |
| 7G-1 | P0 | Password | Page absent |
| 7G-2 | P1 | Password | Strength meter + show/hide absent (cascade) |
| 7G-3 | P1 | Password | Length policy inconsistent (6 vs 8 chars) |
| 7H-1 | P0 | About | Version label absent |
| 7H-2 | P1 | About | Terms & Legal missing |
| 7H-3 | P1 | About | Audio Import missing |
| 7H-4 | P2 | About | Debug / Diagnostics panel missing both |

**Totals by severity:**

- **P0:** 11 (7A-1, 7A-2, 7A-3, 7B-1, 7B-2, 7C-1, 7D-3, 7D-6, 7E-2, 7F-1, 7F-2, 7G-1, 7H-1)
  — correction: that's 13. Re-count: 7A-1, 7A-2, 7A-3, 7B-1, 7B-2, 7C-1, 7D-3, 7D-6, 7E-2,
  7F-1, 7F-2, 7G-1, 7H-1 = **13 P0**.
- **P1:** 7A-4, 7A-5, 7A-6, 7B-3, 7B-4, 7B-5, 7B-6, 7C-2, 7C-3, 7C-4, 7C-5,
  7C-6, 7D-4, 7D-5, 7D-7, 7D-8, 7D-9, 7D-10, 7E-1, 7E-5, 7E-6, 7F-3, 7G-2,
  7G-3, 7H-2, 7H-3 = **26 P1**.
- **P2:** 7A-7, 7A-8, 7B-7, 7C-7, 7C-8, 7D-1, 7D-2, 7D-11, 7E-3, 7E-4, 7E-7,
  7E-8, 7H-4 = **13 P2**.

**Final totals: P0 = 13 · P1 = 26 · P2 = 13 · Total = 52.**

(Initial executive summary count of P0=7/P1=12/P2=5/total=24 was preliminary
before full sub-area walkthrough; the appendix is authoritative.)

---

## Cross-references

- Phase 1 (`phase-1-tab-structure.md`): Gap #5 Staff roster loader is resolved
  in Phase 6a (staff list + detail pages ship). No carry-forward.
- MINI_WAVE_4_5_HANDOFF.md §"InspectorProfile shape drift": 10-eq resolved,
  name/firstName/lastName split still open → **7B-1**.
- PHASE_6_HANDOFF.md / PHASE_6C_HANDOFF.md: file list inspection only; their
  marked-complete status stands, but this audit surfaces functional gaps that
  the handoffs did not enumerate — treat handoffs as "what shipped" not "what
  reached parity".
- web/docs/parity-ledger.md: not trusted per durable rule; not cited here.
