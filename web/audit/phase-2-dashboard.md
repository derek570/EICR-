# Phase 2: Dashboard & Job List — Parity Audit
_Generated: 2026-04-24   Web branch: stage6-agentic-extraction_

## Summary
Gaps found: 17  (P0: 7  P1: 7  P2: 3)
Exceptions (intentional divergence, documented): 0

> Scope note: iOS has two jobs surfaces — `DashboardView` (primary, hero +
> job list + setup grid) and `JobListView` (secondary, unused in the
> default flow via `MainTabView`). The PWA has only `/dashboard`, so this
> audit compares iOS `DashboardView` to PWA `/dashboard`. Phase 1 covered
> job-detail tab structure and is not restated.

## Side-by-side surface map

| # | iOS surface | PWA equivalent | Status |
|---|-------------|----------------|--------|
| 1 | RootView auth gate | `src/middleware.ts` + `/login` | Partial (no terms gate, see Gap #1) |
| 2 | TermsAcceptanceView (post-login) | — | **Missing** (Gap #1) |
| 3 | OfflineBanner above list | `<OfflineIndicator>` pill in header | Divergent placement/treatment (Gap #2) |
| 4 | Hero card: brand logo + ACTIVE/DONE/EXP | `<HeroCard>` same three counters | OK (see Gap #3 re. EXP) |
| 5 | Quick Actions: Start EICR / Start EIC | `<StartTile>` x2 | OK |
| 6 | Search bar (hidden when list empty) | Always-visible search input | Minor divergence (Gap #4) |
| 7 | Recent Jobs list | `recent.slice(0,8)` list | Divergent cap (Gap #5) |
| 8 | Job row: colour stripe + type icon + date + status pill + swipe-to-delete | `<JobRow>` mostly same — NO swipe/delete | Divergent (Gap #6) |
| 9 | Setup & Tools: Defaults, Company, Staff, Settings, Tour, Log Out | Company, Staff, Settings, Log Out | Divergent (Gaps #7, #8) |
| 10 | Toolbar: Alerts + Settings icons | Sign-out + Install button in header | Divergent (Gap #9) |
| 11 | Pull-to-refresh | — | **Missing** (Gap #10) |
| 12 | Preset picker modal on job create | — | **Missing** (Gap #11) |
| 13 | Delete confirmation alert | — (no delete entry point) | **Missing** (Gap #6) |
| 14 | Error alert on `viewModel.errorMessage` | Inline `role="alert"` banner | OK |
| 15 | Hero only shows stats when jobs exist | Hero always shows 0/0/0 stats | Polish divergence (Gap #12) |
| 16 | Navigation push on tap | `<Link>` to `/job/[id]` | OK |
| 17 | Recent Jobs count badge next to heading | Count badge present | OK |

---

## Gap #1 — PWA has no Terms & Conditions gate after login  [P0]
**Area:** Entry point / auth gate
**iOS behaviour:** After `AuthService.checkExistingSession()` resolves and `auth.isLoggedIn == true`, `RootView` checks `TermsAcceptanceView.hasAcceptedCurrentVersion`; if false, the user is blocked at the terms screen (scroll each document, tick three professional confirmations, sign) before `MainTabView` is shown — `CertMateUnified/Sources/Views/Launch/RootView.swift:13-24`, `CertMateUnified/Sources/Views/Launch/TermsAcceptanceView.swift:40-55`, `:395-412`. Acceptance is version-stamped (`currentVersion = "1.0"`) so bumping the version re-prompts.
**PWA behaviour:** Middleware only checks `token` expiry and role claims — it never checks a terms-accepted flag — `web/src/middleware.ts:204-213`. No `/terms` route exists (`grep "terms" web/src -r` returns only inspection-schedule copy and the legal-document pages which are just static `/legal` content). The dashboard mounts immediately after login.
**Evidence:** `web/src/middleware.ts:19` `const PUBLIC_PREFIXES = ['/login', '/legal', '/offline']` — no `/terms`; `web/src/app/login/page.tsx:59-61` pushes `redirect` (defaults `/dashboard`) immediately on success with no intermediate gate.
**User impact:** Inspectors using the PWA never acknowledge the professional qualifications / insurance / AI-disclaimer confirmations that iOS treats as a compliance pre-condition. Legal exposure — the iOS flow records a timestamped signature to UserDefaults; the PWA stores nothing equivalent. Audit trail divergence: a web-only inspector is not on record as having accepted the T&Cs at all.
**Proposed fix:** Add a `/terms` route + server-side acceptance flag; mount an AppShell-level or middleware-level gate that redirects authenticated-but-unaccepted users to `/terms`; record `terms_accepted_version` on the user record so a version bump re-prompts.
**Touchpoints:** `web/src/app/terms/page.tsx` (new), `web/src/middleware.ts`, backend `src/models/UserModel.js`, `web/src/lib/auth.ts` (expose `terms_accepted_version` on `User`).

## Gap #2 — Offline banner placement + treatment diverges significantly  [P1]
**Area:** Layout / offline surfacing
**iOS behaviour:** A full-width banner appears ABOVE the list when `networkMonitor.isConnected == false`, with warning-colour left stripe and copy `"Offline — changes will sync when connected"` — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:42-46`, `CertMateUnified/Sources/Views/Components/OfflineBanner.swift:3-20`.
**PWA behaviour:** Offline state is a small pill in the top-right header cluster (`<OfflineIndicator>`) that reads `Offline` — `web/src/components/layout/app-shell.tsx:91-92`, `web/src/components/pwa/offline-indicator.tsx:84-107`. The dashboard content has no inline banner.
**Evidence:** iOS `DashboardView.swift:43` `OfflineBanner()`; PWA `app-shell.tsx:92` `<OfflineIndicator />`.
**User impact:** Offline state is less prominent on PWA. A pill in the corner is easy to miss compared to a full-width banner over the content. iOS copy ("changes will sync when connected") tells inspectors the sync behaviour; PWA copy ("Offline — showing cached data") tells them nothing about mutation outcome. In a van-in-a-basement scenario the inspector may keep typing without understanding whether edits are being retained.
**Proposed fix:** Keep the header pill (useful at-a-glance) but also render an iOS-parity banner above the hero when `isOnline === false` — with copy matching iOS (`Offline — changes will sync when connected`).
**Touchpoints:** `web/src/app/dashboard/page.tsx` (add banner), `web/src/components/pwa/offline-banner.tsx` (new component), or expand `<OfflineIndicator>` to render both forms.

## Gap #3 — "EXP" (expiring) stat is hard-coded to 0 on PWA  [P1]
**Area:** Hero stats — computation
**iOS behaviour:** `expiringJobCount` filters done jobs whose `lastModified` is older than 4 years and displays the count — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:383-387` + stat wiring at `:466-467`. Labelled by iOS as "Placeholder until the API exposes nextInspectionDate on Job list." Still renders a real non-zero count on any installation older than 4 years.
**PWA behaviour:** `exp = 0` unconditionally — `web/src/app/dashboard/page.tsx:134`. Inline comment admits parity drift: "matches iOS placeholder behaviour pre-Phase 7", but the iOS code it cites actually computes a real value.
**Evidence:** `web/src/app/dashboard/page.tsx:128-135`:
```
const active = list.filter((j) => j.status !== 'done').length;
const done = list.filter((j) => j.status === 'done').length;
const exp = 0;
```
**User impact:** Inspectors coming from iOS will see their "EXP" counter drop to 0 on web. For inspectors managing a book of periodic re-inspections, this counter is the canonical "how many jobs are overdue re-inspection" hint.
**Proposed fix:** Match the iOS filter — `done` jobs whose `updated_at` is older than 4 years — until a true `next_inspection_due` is exposed by the backend (matches iOS placeholder intent verbatim).
**Touchpoints:** `web/src/app/dashboard/page.tsx` (stats useMemo).

## Gap #4 — Search bar visibility differs from iOS  [P2]
**Area:** Search UX
**iOS behaviour:** Search bar section renders only when `!viewModel.jobs.isEmpty` — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:77`.
**PWA behaviour:** Search input renders unconditionally above the Recent Jobs list — `web/src/app/dashboard/page.tsx:192-205`.
**Evidence:** `web/src/app/dashboard/page.tsx:192` renders the search input with no `jobs?.length > 0` guard.
**User impact:** Minor — a disabled-looking search input with no jobs to search is slightly confusing on a fresh account; iOS hides it for cleaner empty-state UX.
**Proposed fix:** Gate the search input on `(jobs?.length ?? 0) > 0`.
**Touchpoints:** `web/src/app/dashboard/page.tsx`.

## Gap #5 — PWA caps Recent Jobs at 8; iOS shows all jobs  [P0]
**Area:** Job list
**iOS behaviour:** `ForEach(filteredJobs)` — renders EVERY job the viewmodel has (limited only by user search text), scrollable — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:134,373-378`. No cap. Header badge shows `filteredJobs.count` which matches the displayed count — `:173`.
**PWA behaviour:** `recent = filtered.slice(0, 8)` — hard cap at 8 — `web/src/app/dashboard/page.tsx:143`. But the badge shows `jobs?.length ?? 0` (total) — `:213`, so a user with 50 jobs sees `Recent Jobs 50` but only 8 rows and no pagination / "view all" affordance.
**Evidence:** `web/src/app/dashboard/page.tsx:138-144`:
```
const recent = React.useMemo(() => {
  const list = jobs ?? [];
  const filtered = query.trim()
    ? list.filter((j) => (j.address ?? '').toLowerCase().includes(query.trim().toLowerCase()))
    : list;
  return filtered.slice(0, 8);
}, [jobs, query]);
```
**User impact:** The 9th job onwards is unreachable from the dashboard. There is no `/jobs` surface to fall back to (iOS's secondary `JobListView` is not ported). An inspector with > 8 jobs cannot navigate to their older jobs from any route short of deep-linking `/job/[id]` directly.
**Proposed fix:** Remove the slice — render the full list (or keep the 8-cap but add a "View all" link to a `/jobs` page that doesn't exist yet). iOS renders everything, so matching iOS = remove the slice.
**Touchpoints:** `web/src/app/dashboard/page.tsx` (recent useMemo).

## Gap #6 — No swipe-to-delete / delete affordance on PWA job rows  [P0]
**Area:** Job row actions
**iOS behaviour:** `.swipeActions(edge: .trailing)` with destructive "Delete" button that opens a confirmation alert, calls `viewModel.deleteJob(job)` — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:153-160,294-308`. Optimistic UI with rollback on failure — `JobListViewModel.swift:173-190`. `api.deleteJob(userId:jobId:)` backend call.
**PWA behaviour:** `<JobRow>` is a `<Link>` with no destructive action, no context menu, no swipe/long-press, no overflow menu — `web/src/components/dashboard/job-row.tsx:46-101`. The whole row is a nav link.
**Evidence:** `web/src/components/dashboard/job-row.tsx:47-50` — entire row is a click target; no secondary action UI surface at all. `api.deleteJob` exists (`api-client.ts`) but is not wired.
**User impact:** Inspectors cannot delete a mistakenly-created job from the PWA. The only path to clean up is via API/backend — there is no UX route to remove stale test/duplicate jobs. iOS inspectors will expect swipe-left to work and find it doesn't.
**Proposed fix:** Add a long-press / overflow menu (mobile swipe requires complex gesture code; simplest parity is an overflow `⋯` button on each row with Delete + confirmation). Wire through `api.deleteJob` + optimistic removal + rollback.
**Touchpoints:** `web/src/components/dashboard/job-row.tsx`, `web/src/app/dashboard/page.tsx` (delete handler), `web/src/lib/api-client.ts` (verify `deleteJob` exists).

## Gap #7 — Setup & Tools grid is missing Defaults and Tour  [P0]
**Area:** Dashboard → Setup & Tools section
**iOS behaviour:** Six Setup & Tools tiles: **Defaults**, Company, Staff, Settings, **Tour** (toggle on/off), Log Out — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:584-668`.
**PWA behaviour:** Four tiles only: Company, Staff, Settings, Log Out — `web/src/app/dashboard/page.tsx:265-271`. The inline comment at `:249-260` admits the trim: "The old set linked to `/settings/defaults`, `/settings/inspectors`, and `/tour` — none of those pages ship in this build". Staff tile points at `/settings/staff` (OK). Defaults + Tour are simply absent.
**Evidence:** `web/src/app/dashboard/page.tsx:265-271`:
```
<SetupTile icon={Building2} label="Company" href="/settings/company" />
<SetupTile icon={UserCheck} label="Staff" href="/settings/staff" />
<SetupTile icon={Settings} label="Settings" href="/settings" />
<SetupTile icon={LogOut} label="Log Out" variant="destructive" onClick={signOut} />
```
**User impact:** **Defaults** — a core iOS workflow (preset-apply on job create; see Gap #11) — has no entry point at all in the PWA. Inspectors can't create, review, or edit certificate defaults from the dashboard. **Tour** — the first-session onboarding that teaches the UI — has no entry point either, so inspectors who dismiss the default-on tour have no way to re-run it.
**Proposed fix:** Build `/settings/defaults` (Defaults manager) and a Tour mechanism (toggle + replay). The existing stub comment suggests these were explicitly deferred; this is an iOS-canon gap, not an architectural choice.
**Touchpoints:** `web/src/app/settings/defaults/page.tsx` (new), `web/src/app/dashboard/page.tsx` (add SetupTiles), tour infra (no existing parallel).

## Gap #8 — Setup & Tools layout: iOS uses 3x 2-col rows; PWA uses a 2-col grid  [P2]
**Area:** Setup & Tools visual layout
**iOS behaviour:** Three explicit `HStack`s: (Defaults, Company), (Staff, Settings), (Tour, Log Out) — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:592-668`. Tour button has distinctive ON/OFF right-aligned badge with brand-green tint; Log Out has red icon.
**PWA behaviour:** Single `grid gap-2 sm:grid-cols-2` rendering four tiles — `web/src/app/dashboard/page.tsx:265-271`. No Tour toggle state, Log Out colours via `variant="destructive"`.
**Evidence:** See Gap #7 source refs.
**User impact:** None directly (purely visual); flagged for hygiene once Gap #7 is fixed so the added Defaults + Tour tiles adopt a layout matching iOS.
**Proposed fix:** Once Defaults + Tour are added, preserve iOS's 3x2 ordering and the Tour on/off badge pattern.
**Touchpoints:** `web/src/app/dashboard/page.tsx`.

## Gap #9 — Top-right toolbar has no Alerts / Settings shortcut (iOS toolbar pattern not ported)  [P1]
**Area:** Top-nav chrome
**iOS behaviour:** Dashboard toolbar trailing cluster: **bell (Alerts)** + **gearshape (Settings)** — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:200-221`. Tapping bell opens `AlertsView`; tapping gear opens `SettingsHubView`.
**PWA behaviour:** AppShell header has: offline pill, user name, Install button, Sign-out button — `web/src/components/layout/app-shell.tsx:84-109`. No alerts icon. No settings gear icon. Settings is only reachable through the bottom "Setup & Tools" section of the dashboard.
**Evidence:** `web/src/components/layout/app-shell.tsx:84-109` trailing cluster contains no bell or gear icon.
**User impact:** (a) No Alerts surface at all on PWA — iOS has `AlertsView` for push-like notifications; PWA has no equivalent route (`grep -r alerts web/src/app` returns zero matches). (b) Settings is one extra scroll away for PWA users. Neither is a hard blocker, but it's a visible iOS-canon gap.
**Proposed fix:** Add `/alerts` route + bell icon in header (even if initially an empty state). Add a gear icon linking to `/settings` in the header cluster.
**Touchpoints:** `web/src/app/alerts/page.tsx` (new), `web/src/components/layout/app-shell.tsx`.

## Gap #10 — No pull-to-refresh on PWA job list  [P1]
**Area:** Job list refresh
**iOS behaviour:** `.refreshable { await viewModel.loadJobs(forceRefresh: true) }` — pull-down triggers a force-refresh — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:188-190`.
**PWA behaviour:** Mount-time fetch only; no pull-to-refresh, no manual refresh affordance. `api.jobs(user.id)` runs once on mount — `web/src/app/dashboard/page.tsx:86-96`.
**Evidence:** `web/src/app/dashboard/page.tsx:46-124` — `useEffect` with `[router]` dep; no refresh-handler.
**User impact:** Inspector with a stale list (created a job on another device; status updated by backend) has no way to refresh short of a full page reload. iOS's pull-to-refresh is muscle memory for this app.
**Proposed fix:** Add a pull-to-refresh component (or a small refresh icon button in the header / next to "Recent Jobs" count) that re-runs the `api.jobs(user.id)` fetch.
**Touchpoints:** `web/src/app/dashboard/page.tsx`, optionally a shared pull-to-refresh hook.

## Gap #11 — No preset picker on job creation; iOS auto-applies defaults  [P0]
**Area:** Create-job flow — defaults application
**iOS behaviour:** On `createAndNavigate(type:)`, the viewmodel tries `autoApplyDefaults(jobId:, certificateType:)` — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:708-724`. Logic (`JobListViewModel.swift:200-215`): 0 presets → apply standard defaults; 1 preset → apply automatically; 2+ presets → show `PresetPickerSheet` (medium detent). User selects a preset → applied to job → navigate.
**PWA behaviour:** `createJob(kind)` is `api.createJob(userId, kind)` + `router.push('/job/'+id)` only — `web/src/app/dashboard/page.tsx:146-158`. No preset discovery, no picker, no application of standard defaults on the client. Server may or may not seed defaults; iOS's client-side preset-apply layer is absent.
**Evidence:** `web/src/app/dashboard/page.tsx:146-158`:
```
async function createJob(kind: 'EICR' | 'EIC') {
  const user = getUser();
  if (!user) return;
  setCreating(true);
  try {
    const { id } = await api.createJob(user.id, kind);
    router.push(`/job/${id}`);
```
**User impact:** Inspectors who have saved named defaults on iOS (e.g. "Landlord EICR — BS 7671:2018", "New Build EIC — 32A MCB supply") see NONE of those defaults pre-populate on the web new-job. Every job starts blank. This silently erases a core productivity feature.
**Proposed fix:** After `api.createJob`, fetch `api.defaults(userId, kind)`, branch 0/1/many, and either apply standard, apply the preset, or open a `<PresetPickerDialog>`. Navigate after apply.
**Touchpoints:** `web/src/app/dashboard/page.tsx`, `web/src/components/dashboard/preset-picker.tsx` (new), `web/src/lib/api-client.ts` (add `defaults` + `applyPreset` endpoints if missing), backend contract alignment with `CertificateDefaultsService` on iOS.

## Gap #12 — Hero card always shows stat row; iOS hides it when no jobs exist  [P1]
**Area:** Hero card — conditional stats
**iOS behaviour:** Stat row (`ACTIVE / DONE / EXP`) renders only when `!viewModel.jobs.isEmpty` — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:455-471`. Empty-state heroes show just the brand logo + "Electrical Certification" strapline.
**PWA behaviour:** `<HeroCard>` unconditionally renders `0 0 0` — `web/src/app/dashboard/page.tsx:311-316`.
**Evidence:** `web/src/app/dashboard/page.tsx:311-315` always renders `<HeroStat>` x3; `DashboardView.swift:455` `if !viewModel.jobs.isEmpty { ... }` gate.
**User impact:** Minor — first-time-user polish. A fresh account's dashboard shows three redundant 0s under "CertMate Electrical Certification"; iOS's empty-state hero is cleaner.
**Proposed fix:** Hide the `<HeroStat>` row when `(jobs?.length ?? 0) === 0`.
**Touchpoints:** `web/src/app/dashboard/page.tsx` (`<HeroCard>`).

## Gap #13 — Recent Jobs badge shows total jobs count, not filtered count  [P1]
**Area:** Job list header badge
**iOS behaviour:** Header badge shows `filteredJobs.count` — reflects the active search filter — `CertMateUnified/Sources/Views/Dashboard/DashboardView.swift:172-179`.
**PWA behaviour:** Header badge shows `jobs?.length ?? 0` — total, ignores filter AND ignores the 8-job slice cap — `web/src/app/dashboard/page.tsx:212-214`.
**Evidence:** `web/src/app/dashboard/page.tsx:212-214`:
```
<span ...>
  {jobs?.length ?? 0}
</span>
```
**User impact:** Badge lies in two ways: shows jobs that aren't rendered (beyond the 8-cap) and doesn't update when the user filters. "Recent Jobs 50" next to 8 rows is confusing.
**Proposed fix:** Badge should show `recent.length` (matches the iOS semantics of `filteredJobs.count` once the slice cap is removed per Gap #5).
**Touchpoints:** `web/src/app/dashboard/page.tsx`.

## Gap #14 — JobRow displays `certificate_type` with no fallback handling vs iOS Label pattern  [P2]
**Area:** Job row — cert-type display
**iOS behaviour:** Label view (icon + `type.rawValue`) rendered only when `job.certificateType` is present; no fallback to a default — `CertMateUnified/Sources/Views/Dashboard/JobRowView.swift:27-37`.
**PWA behaviour:** Defaults `cert = job.certificate_type ?? 'EICR'` — silent default — `web/src/components/dashboard/job-row.tsx:36`.
**Evidence:** `web/src/components/dashboard/job-row.tsx:36` `const cert = job.certificate_type ?? 'EICR';`
**User impact:** An ambiguous job (type unknown) is shown as EICR in blue on PWA, but as no-label/no-icon on iOS. If the backend ever returns a job with null `certificate_type`, platforms diverge on what the user sees.
**Proposed fix:** Match iOS — hide the label when `certificate_type` is missing (rather than silently defaulting).
**Touchpoints:** `web/src/components/dashboard/job-row.tsx`.

## Gap #15 — Status pill label for `processing` is "IN PROGRESS" on PWA, "Processing" on iOS  [P2]
**Area:** Job row — status pill copy
**iOS behaviour:** `case .processing: StatusBadge(text: "Processing", …)` — `CertMateUnified/Sources/Views/Dashboard/JobRowView.swift:68-70`.
**PWA behaviour:** `processing: 'IN PROGRESS'` — `web/src/components/dashboard/job-row.tsx:23`.
**Evidence:** `web/src/components/dashboard/job-row.tsx:21-26`:
```
const STATUS_LABEL: Record<Job['status'], string> = {
  pending: 'PENDING',
  processing: 'IN PROGRESS',
  done: 'DONE',
  failed: 'FAILED',
};
```
**User impact:** Copy drift — a developer cross-platform-testing sees different strings for the same state. iOS also uses sentence case for Done/Failed/Processing; PWA uses uppercase with letter-spacing. Minor, but a real visible divergence.
**Proposed fix:** Align to iOS sentence-case copy ("Pending", "Processing", "Done", "Failed") or document the uppercase-ALL-CAPS as an intentional design-system rule.
**Touchpoints:** `web/src/components/dashboard/job-row.tsx`.

## Gap #16 — Date format on job row differs from iOS `dateTime` formatter  [P1]
**Area:** Job row — date display
**iOS behaviour:** `Formatters.dateTime.string(from: job.lastModified)` — includes both date AND time-of-day — `CertMateUnified/Sources/Views/Dashboard/JobRowView.swift:39-41`.
**PWA behaviour:** Date-only: `toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })` — `web/src/components/dashboard/job-row.tsx:39-43`.
**Evidence:** `web/src/components/dashboard/job-row.tsx:38-43`.
**User impact:** Inspector who created two jobs for the same address on the same day can't tell them apart on the PWA — iOS shows the time component. Minor but a real info-density gap.
**Proposed fix:** Include a time component (`{ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }`) or alternatively use a relative-time formatter consistent with `Formatters.dateTime`.
**Touchpoints:** `web/src/components/dashboard/job-row.tsx`.

## Gap #17 — Fallback job title diverges (iOS uses `generateDefaultJobName(from:)`, PWA hard-codes "Untitled job")  [P1]
**Area:** Job row — address fallback copy
**iOS behaviour:** `job.address ?? generateDefaultJobName(from: job.createdAt)` — deterministic "Job YYYY-MM-DD" style name keyed off the creation date — `CertMateUnified/Sources/Views/Dashboard/JobRowView.swift:21`.
**PWA behaviour:** `{job.address || 'Untitled job'}` — `web/src/components/dashboard/job-row.tsx:69`.
**Evidence:** `web/src/components/dashboard/job-row.tsx:67-69`.
**User impact:** Multiple addressless jobs all read "Untitled job" on the PWA — the user can't distinguish them until they tap through. iOS's date-based default makes them distinguishable at a glance.
**Proposed fix:** Port `generateDefaultJobName(from:)` semantics (a simple `Job YYYY-MM-DD` based on `created_at` is a 2-line helper).
**Touchpoints:** `web/src/components/dashboard/job-row.tsx`, potentially a shared util in `@certmate/shared-utils`.

---

## Exceptions / intentional divergence
**None documented.** Searched handoff/review files in `web/` for `dashboard|hero|setup.*tools|tour|defaults|pull.*refresh|terms|alerts|offline banner|swipe|preset|picker`. The only in-code acknowledgement of a divergence is the inline block at `web/src/app/dashboard/page.tsx:249-260` (Setup & Tools trim) which frames the Defaults / Tour absence as "routes don't ship in this build" — that is a TODO note, not an authorised exception. All 17 gaps above are treated as drift per the 2026-04-24 user directive.

Noted adjacent context (**not exceptions, just pre-existing**):
- Phase 1 surfaced tab-bar and cert-type-gating drift (Observations / Extent / Design) — see `web/audit/phase-1-tab-structure.md`. Phase 2 does not restate those.
- Install/PWA entry points (`<InstallButton>`, `<IOSInstallHint>`) have no iOS equivalent — iOS is a native app. These are PWA-specific additions, not divergences from iOS canon.
- AppShell is a single-stack navigation (no bottom tab bar) — matches iOS `MainTabView`'s primary NavigationStack per the docstring at `app-shell.tsx:18-20`. OK.

## Open questions for the user

1. **Terms & Conditions (Gap #1):** Does the backend already carry a `terms_accepted_version` column on users? If not, Phase 2.5 needs a schema migration before the gate can be wired. iOS stores acceptance local-only (`UserDefaults`) which is weak evidence — for a web audit trail, we'd want it server-side.
2. **"View all" vs uncapped list (Gap #5):** Should the PWA build a `/jobs` secondary route (matching iOS's unused `JobListView.swift`) as the "view all" landing, or drop the 8-cap and render the full list inline on `/dashboard`? iOS renders everything inline on the dashboard and does not present `JobListView` from the primary flow.
3. **Alerts surface (Gap #9):** iOS has `AlertsView` (not read in this audit). Confirm what iOS Alerts actually shows before porting — the route may be vestigial on iOS and not worth porting if there's no backing data model.
4. **Defaults parity (Gap #7 / Gap #11):** These are intertwined (Defaults UI entry + create-job preset-apply). Confirm backend endpoints for `GET /defaults`, `POST /defaults`, `POST /jobs/:id/apply-preset` — if iOS-only today, Phase 2.5 must port them before the PWA UI can consume them.
