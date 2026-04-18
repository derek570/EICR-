# Phase 2 Review — Job detail shell with 10 tabs

Target commit: `83b0863` (Phase 2 shell) + `27283fd` (dashboard iOS-parity) + `90bd238` (job shell iOS-parity rework). Reviewed against working-tree state on `web-rebuild` (current HEAD).

## 1. Summary

Phase 2 lands the navigable skeleton for every `/job/[id]/...` route: a JobProvider context, a shared layout with header + tab nav + scroll container + (post-rework) floating action bar, nine `TabStub` placeholder pages plus the overview index, and a Playwright visual-verification harness that screenshots all 10 × 2 cert types × 2 viewports. `90bd238` then significantly reshapes the shell to match the iOS JobDetailView (horizontal-only nav, unified cert-agnostic tab set, `FloatingActionBar`, iOS-style centred header with < Back / ··· menu, Inspector → Staff rename). The dashboard rework in `27283fd` is orthogonal (separate files, outside the job shell) and tracks to a different review.

The shell code is clean, idiomatic, and the auth/loading/error branches are handled correctly in the layout. The follow-up reworks mostly improve parity but **reverted a number of Phase 2 commit-message claims** (desktop sidebar, cert-type-aware tab sets, date pill in header) and introduced some contradictions noted below. A few correctness issues sit around router `back()`, accessibility of placeholder stubs, and a broken overview→observations link path that still exists after the tab-reshuffle. No P0 security issues.

## 2. Alignment with plan

Matches the Phase 2 commit message:

- JobProvider context with `updateJob(partial)` + dirty/saving flags — `src/lib/job-context.tsx:19-73`. Debounced save deferred, as stated.
- Layout fetches once, wraps children, header + nav + scroll container, skeleton + error card — `src/app/job/[id]/layout.tsx:36-165`.
- `TabStub` + 9 tab pages + overview index — all present.
- API `api.job` and `api.saveJob` — `src/lib/api-client.ts:132-136, 272-281`.
- Types: `JobDetail`, `CircuitRow`, `ObservationRow`, `InspectorInfo` — `src/lib/types.ts:192-239`.
- `verify-visual.ts` PHASE=2 routes — `scripts/verify-visual.ts:97-200`.

**Reverted / contradicted by 90bd238 (not reflected in Phase 2 commit message, which is still the canonical Phase 2 record):**

- Commit body says *"Two tab sets — EICR (Overview, Installation, Supply, Board, Circuits, Observations, Inspection, Inspector, PDF) and EIC (Overview, Installation, Extent, Supply, Board, Circuits, Inspection, Design, Inspector, PDF) — matching the iOS JobDetailView enum."* — `90bd238` replaced this with a **unified, cert-agnostic** set that *also* claims to match iOS. One of these statements is wrong; the `certificateType` prop is now dead weight (`src/components/job/job-tab-nav.tsx:65-69` retains it "for API compatibility" but never reads it).
- Commit body says *"Desktop: vertical sidebar (~220px)"* — sidebar removed entirely in `90bd238`. Skeleton loader still retains the vertical-sidebar visual in the pre-rework diff but the rework also dropped that branch; current `JobShellLoading` at `src/app/job/[id]/layout.tsx:143-165` no longer matches what the rest of the shell looks like, which is fine but the original "Skeleton shimmer while loading" spot check is no longer representative.
- Observations is described in the Phase 2 message as a top-level tab on EICR; `90bd238` removed it from the nav and routed users to it via the `Obs` floating button — but the route file still exists at `src/app/job/[id]/observations/page.tsx` and is reachable directly (see §3 P1 finding).
- `inspector/page.tsx` → renamed to `staff/page.tsx` by `90bd238`. The Phase 2 message still refers to `inspector` throughout.

This is not a bug per se but a caller reading the codebase in 6 months will have no quick way to tell which of the three commits represents "Phase 2 as it stands". Suggest the Phase 2 context doc (`reviews/context/phase-2.md`) be annotated with the reworks' divergences.

## 3. Correctness

### P0
None.

### P1

1. **Overview → Observations broken link (EICR)** — `src/app/job/[id]/page.tsx:22-32` no longer includes an Observations card in the unified sections list (the pre-rework EICR branch had `{ slug: '/observations', label: 'Observations', desc: 'C1/C2/C3/FI findings.' }`). After `90bd238`, users reach observations only via the FloatingActionBar's `Obs` button — but that button is a `console.log` stub (`src/components/job/floating-action-bar.tsx:85`). Result: there is **no working path from the UI to `/observations`** even though the route file exists, is linted, and is exercised by the Phase 5c photo flow. The route is effectively undiscoverable until the `Obs` handler is wired.

2. **`router.back()` without a fallback** — `src/components/job/job-header.tsx:30`. If a user lands on `/job/<id>/circuits` directly (shared link, PWA deep link, back-from-Settings after login) `router.back()` will either do nothing or navigate off-origin. Standard pattern is to check `window.history.length <= 1` and fall back to `router.push('/dashboard')`.

3. **JobProvider's `useEffect([initial])` re-runs on every re-mount of the provider** — `src/lib/job-context.tsx:50-53`. Any time the parent re-renders and produces a new `JobDetail` object (identity change without content change), the effect runs `setJob(initial); setIsDirty(false)`, **silently discarding any in-flight local edits**. The Phase 7b stale-while-revalidate flow at `src/app/job/[id]/layout.tsx:65-78` now intentionally calls `setJob` twice (cache paint, then fresh fetch), so the second fetch will **reset `isDirty` to false and overwrite un-saved edits with server data**. This was a latent issue in 83b0863 but becomes a live problem post-7b because the cache-then-fetch sequence lands a second identity change ~a few seconds in. Fix: compare `initial.id` or a revision counter instead of reference identity, and don't clobber when `isDirty` is true.

4. **Non-interactive overflow "··· menu" button misleads users** — `src/components/job/job-header.tsx:44-55`. The button is visually identical to an iOS overflow menu but the `onClick` is `console.log('[job-header] overflow menu')`. Same for the MenuHandle and 5 of 6 `FloatingActionBar` buttons. An interactive control wired to nothing fails WCAG 2.1 SC 4.1.2 expectations and gives testers a false sense the shell is complete. Either disable with `aria-disabled="true"` + `disabled` styling, or at minimum surface a toast/tooltip ("Coming in Phase 6") — don't silently swallow the tap.

### P2

5. **Title truncation math is brittle** — `src/components/job/job-header.tsx:39` hardcodes `maxWidth: 'calc(100% - 200px)'` assuming Back+More take exactly 200px. Back renders "Back" text on every viewport (≈72px button) and More is 36px — total ~108px with padding. At 320px viewports (iPhone SE) this still overflows on long addresses. Better: flex layout with `min-w-0` on the title column rather than absolute centering.

6. **`pathname.startsWith(${href}/)` active-state match is over-eager when slugs share prefixes** — `src/components/job/job-tab-nav.tsx:84`. Currently safe (no tab slug is a prefix of another), but if the 5-dot-menu ever opens `/job/<id>/staff/invite` the Staff tab lights up — fine — but if a future tab lands at `/job/<id>/board-schedule`, Board will not. Either make the check `pathname === href` for leaf tabs or define an explicit `matchesPath` per tab.

7. **`createdLabel` code was removed by `90bd238` but was the only surface for cert type + created_at in the header** — previously `src/components/job/job-header.tsx` (pre-rework) showed `{certificateType} · {createdLabel}`. Post-rework that context disappeared from the visible chrome. The Phase 2 commit message still claims this pill exists.

8. **`sections` in the overview grid duplicates the tab set** — `src/app/job/[id]/page.tsx:22-32` hard-codes the same 9-tab order as `UNIFIED_TABS` in `job-tab-nav.tsx:50-61` minus Overview. Two sources of truth. Export a single `JOB_TABS` constant and filter.

9. **`FloatingActionBar` hit-area dead zone between buttons** — `src/components/job/floating-action-bar.tsx:50` sets the outer container to `pointer-events-none` and the inner rows to `pointer-events-auto`. This is correct for letting page content scroll under the bar, but the horizontal gap between MenuHandle and the ActionButton cluster (up to ~200px on desktop at `md:px-6`) is an accidental click-through zone. If any floating chrome ever sits there (e.g. a "Saved" toast), the layer order will be confusing.

10. **`JobBody` wraps everything in a single scroll container with `pb-28`** — `src/app/job/[id]/layout.tsx:139`. Fine for the floating bar, but iOS-safe-area-inset on iPhone 15 Pro Max adds another 34px at the bottom. Use `pb-[calc(theme(spacing.28)+env(safe-area-inset-bottom))]` or the bar will sit on top of the last tab row on home-indicator phones.

## 4. Security

- JWT storage uses localStorage + a mirrored cookie (`src/lib/auth.ts:30-37`). Cookie is `SameSite=Lax`, no `Secure` flag, no `HttpOnly`. Not a Phase 2 change but the layout's auth gate depends on it. Production deploy must set `Secure` — noted in Phase 7 work but flagging here because the layout now reads `getUser()` on mount.
- `console.log('[bar] …')` stubs on every FloatingActionBar button — fine in dev, but they'll ship to production. Either gate on `process.env.NODE_ENV !== 'production'` or strip.
- No injection risks in the shell — all rendered strings go through JSX text nodes, no `dangerouslySetInnerHTML`, no `href` built from untrusted input.
- `encodeURIComponent` applied on all path segments in `api-client.ts` ✓.
- Visual-verification harness writes a fake JWT into localStorage (`scripts/verify-visual.ts:41-44`) — only run in dev, no shipped surface. Comment explains it.

## 5. Performance

- `JobProvider.useMemo` dep list omits `setJob` — `src/lib/job-context.tsx:60-70`. `setJob` from `useState` is stable so this is actually correct, but ESLint's exhaustive-deps would complain. No functional impact.
- `UNIFIED_TABS` is defined at module scope — good, no per-render allocation (`src/components/job/job-tab-nav.tsx:50`).
- `sections` array is re-created on every render in `src/app/job/[id]/page.tsx:22-32`. Trivial, but `React.useMemo` (or module-scope) would eliminate 9 object allocations per navigation.
- The cache-then-fetch sequence in `src/app/job/[id]/layout.tsx:65-93` fires two `setJob` calls which re-mount the entire `RecordingProvider` → `TranscriptBar` → `JobBody` tree. If the fetch lands while a recording is active, state in `RecordingProvider` would be lost. The current flow stops recording on unmount but this is worth an `AbortController` + revision check.
- `scrollbar-hide` class exists in `globals.css:225-231` and is applied — ✓.
- No unnecessary client boundaries; `TabStub` wrappers at each route file are `'use client'` only because they import `TabStub` (a client component). Each stub page could be a server component and render `<TabStub />` — negligible bundle saving but worth considering when real forms land.

## 6. Accessibility

1. **FocusVisible outline uses white** — `src/components/job/floating-action-bar.tsx:135, 152`. `focus-visible:outline-2 focus-visible:outline-white` — on a magenta/green/orange button, white-on-magenta has ~4.2:1 contrast (OK) but on the green Apply button it's ~2.4:1 (fails SC 1.4.11 3:1 non-text contrast). Use a 2-ring pattern (`ring-2 ring-white ring-offset-2 ring-offset-black`) to guarantee contrast on every button colour.

2. **Icon-only MoreHorizontal and MenuHandle rely on `aria-label`** — good for screen readers, but `<button>` has no visible label and no tooltip. On desktop mouse users this is an iOS-ism that translates poorly. Consider a `title` attribute as a minimum.

3. **MicButton uses `<span className="sr-only">` for "Recording in progress"** but the visible label is only "Record" via `aria-label` — no live region on state change (`src/components/job/floating-action-bar.tsx:148-149`). Screen-reader users won't hear "Recording started" unless they re-focus the button. Add `aria-live="polite"` on the text.

4. **Tab strip has no roving-tabindex** — `src/components/job/job-tab-nav.tsx:74-131`. All 10 tabs are `<Link>` → sequential Tab key press traverses all of them. iOS-style tab bars usually apply `role="tablist"` + `role="tab"` + arrow-key roving. Not required for nav-as-tabs, but the `aria-label="Job sections"` is ambiguous — it's a nav, not a tablist, so the current markup is semantically fine as a nav.

5. **`role="button" tabIndex={0}`** on the observation card in `src/app/job/[id]/observations/page.tsx:234-243` is a Phase 5c finding (not Phase 2), but the pattern *starts* here in `TabStub`/overview: overview cards are `<Link>` ✓. Ignore.

6. **No `aria-current="page"` on overview card when already on overview** — `src/app/job/[id]/page.tsx:55-71`. Less critical because each card leads elsewhere, but the "current section" chip ("Not started") is decorative and `aria-hidden` — ✓.

7. **`focus-visible:outline-2` with no `outline-offset`** on the Back button (`src/components/job/job-header.tsx:31`) — the outline will overlap the button's rounded corner at default offset. Add `focus-visible:outline-offset-2`.

8. **Title `<h1>` is `pointer-events-none` and `absolute` centred** — `src/components/job/job-header.tsx:37-42`. Screen readers still read it (no `aria-hidden`) ✓, but landmark order matters: with the Back button first in DOM and the h1 after it, the "heading" reading order is correct. Fine.

9. **No `prefers-reduced-motion` guard on `animate-pulse` / `active:scale-95` / `transition`** across the shell. Global rule, not a shell-specific miss, but worth adding to `globals.css`.

## 7. Code quality

1. **Dead `certificateType` parameter** — `src/components/job/job-tab-nav.tsx:64-70` takes it and doesn't use it. Unused parameter suppression via underscore rename is clever but leaves the call site (`src/app/job/[id]/layout.tsx:111`) doing pointless work. Either remove the prop or use it (e.g. filter tabs by cert type and reinstate the two-set design).

2. **`<FilePlus className="sr-only" aria-hidden />`** — `src/components/job/floating-action-bar.tsx:165`. A screen-reader-only icon *that is also aria-hidden* is a no-op. The comment says "to echo iOS 'add' glyph" — but it's invisible to both sighted and SR users. Remove, or render visibly.

3. **`console.log` stubs should be a single `TODO(phase4)` helper** rather than 6 inline literals — `src/components/job/floating-action-bar.tsx:61-87, 100`. Centralising makes later grep-and-wire easier.

4. **Inline `style={{ maxWidth: '960px' }}`** repeated in `src/app/job/[id]/page.tsx:37`, `src/components/job/tab-stub.tsx:22`, and every Phase 3/5 tab. The Phase 2 commit message explains this is a Tailwind 4 workaround for `max-w-3xl` wrapping — fine as a workaround but at 3+ call sites a `JobContentFrame` component would dry this up.

5. **`JobDetail extends Job`** with `address: string` on the base and `address: string | null` on `CompanyJobRow` — `src/lib/types.ts:111-180`. Two overlapping shapes for the same concept. Worth unifying when the job tabs' real schemas land.

6. **Error message uses curly apostrophe** — `src/app/job/[id]/layout.tsx:152` (`Couldn't`). Fine in UI, but if this string ever flows through `JSON.stringify` for error tracking, `’` (U+2019) renders incorrectly in some log pipelines. Cosmetic.

7. **`observations` not in `sections`** — if Observations is intentionally floating-bar-only, the mock EICR job in `scripts/verify-visual.ts:115` still declares `observations: []` which is fine, but the screenshot harness never exercises `/observations` (it was dropped from `tabs` at `scripts/verify-visual.ts:167-178`). A dedicated regression screenshot would catch the "broken discovery path" issue from P1 #1.

8. **`_certificateType: _certificateType`** rename — `src/components/job/job-tab-nav.tsx:65`. TypeScript allows the leading-underscore convention to signal unused but ESLint `no-unused-vars` will still flag unless configured. Quick check of `.eslintrc` may show this needs `argsIgnorePattern`.

9. **Magic number `pb-28`** — `src/app/job/[id]/layout.tsx:139` to clear the floating bar. Make it a CSS variable (`--job-floating-bar-height`) tied to the bar's measured height so resize/redesign doesn't desync.

10. **`EICR_TABS`/`EIC_TABS` emoji icons dropped in favour of lucide icons** — a good change, but the original 83b0863 shipped emoji icons (`\u{1F3E0}` etc.) and the commit message *called them out specifically*. Changelog drift.

## 8. Test coverage gaps

No unit tests accompany the Phase 2 commit. Explicit gaps worth adding before Phase 3 forms land:

1. **`JobProvider` state retention** — confirm `updateJob` sets `isDirty` true, confirm `useEffect([initial])` re-reset behaviour is what we want (see P1 #3). A 10-line RTL test would catch the cache-paint regression.
2. **`JobTabNav` active-state matching** — verify `/job/x/board` lights Board, `/job/x/board/` (trailing slash) lights Board, `/job/x` (overview) lights Overview only.
3. **Overview card set matches tab nav set** — would prevent drift now that we have two sources of truth (§7 #4).
4. **FloatingActionBar Mic button** — recording/idle aria-pressed state flip. Important because this is the primary action of the whole page.
5. **`api.job` / `api.saveJob` URL escaping** — a job id with `/` or `%` characters would exercise `encodeURIComponent`.
6. **`verify-visual.ts` Phase 2 screenshot set** — currently the only "test" that gates this code. Screenshot diffs aren't committed anywhere I can find; without a baseline, this is a smoke check at best.
7. **Observations discoverability** — an E2E test that clicks the Obs button and asserts navigation, which would have caught P1 #1.

## 9. Suggested fixes

1. `src/components/job/floating-action-bar.tsx:85` — wire the `Obs` button to `router.push('/job/<id>/observations')` or at least gate behind `disabled` + a tooltip. Addresses P1 #1.
2. `src/components/job/job-header.tsx:30` — replace `onClick={() => router.back()}` with `onClick={() => { if (window.history.length > 1) router.back(); else router.push('/dashboard'); }}`. Addresses P1 #2.
3. `src/lib/job-context.tsx:50-53` — compare `initial.id` (or a `version` field) rather than reference identity, and guard on `isDirty === false` before clobbering. Addresses P1 #3.
4. `src/components/job/floating-action-bar.tsx:61-87, 100` and `src/components/job/job-header.tsx:47-51` — add `disabled` + visual dimming to all handlers that are `console.log` stubs, and an `aria-describedby` toast/tooltip saying "Available in Phase 6". Addresses P1 #4.
5. `src/components/job/job-header.tsx:37-42` — convert absolute-centred h1 to a flex row with `flex-1 min-w-0 truncate` so it shrinks predictably at 320px. Addresses P2 #5.
6. `src/components/job/job-tab-nav.tsx:65-70` — either remove the `certificateType` prop entirely (and its `string` import) or use it; don't carry dead state. Addresses §7 #1.
7. `src/components/job/floating-action-bar.tsx:135` — change `focus-visible:outline-white` to `focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black` to guarantee 3:1 on coloured buttons. Addresses A11y #1.
8. `src/app/job/[id]/layout.tsx:139` — change `pb-28` to `style={{ paddingBottom: 'calc(7rem + env(safe-area-inset-bottom))' }}` or a CSS variable. Addresses P2 #10 + §7 #9.
9. `src/app/job/[id]/page.tsx:22-32` + `src/components/job/job-tab-nav.tsx:50-61` — extract a single `JOB_TABS` constant in `src/lib/constants/job-tabs.ts` and import from both. Addresses P2 #8 + §7 #4.
10. `src/components/job/floating-action-bar.tsx:163-165` — delete the `<FilePlus className="sr-only" aria-hidden />` no-op. Addresses §7 #2.
11. `src/components/job/job-header.tsx:31` — add `focus-visible:outline-offset-2`. Addresses A11y #7.
12. `scripts/verify-visual.ts:167-178` — add `{ slug: '/observations', name: 'observations' }` back to the tabs array so the screenshot set covers the (still-reachable) route. Addresses §8 #6 + §7 #7.
13. `reviews/context/phase-2.md` — annotate the Phase 2 commit body with deltas from `90bd238` (sidebar removed, unified tabs, Inspector→Staff, Observations off-tab). Addresses §2.
14. `src/components/job/floating-action-bar.tsx:100` — make the 5-dot menu handle explicitly `aria-disabled="true"` until the overflow sheet lands (Phase 4), or remove the hover affordance so it doesn't promise interaction. Addresses §3 P1 #4 + §6.

## 10. Overall verdict + top 3 priorities

**Verdict: Ship-ready as a shell skeleton; three must-fix items before Phase 3 forms start writing to the context.**

The scaffolding is clean, the typing is tidy, the verification harness is a genuine asset, and the iOS-parity rework is a net improvement. But the combination of (a) a silent-clobber race in `JobProvider` that becomes live under Phase 7b's cache-paint sequence, (b) the Observations route being undiscoverable via the UI, and (c) a cluster of `console.log`-stub interactive controls means this shell isn't a safe foundation for Phase 3 yet. Fix the three priorities and it is.

**Top 3 priorities (in order):**

1. **Fix `JobProvider` clobber-on-re-fetch** (P1 #3 / Suggested fix #3). This is the only finding that can cause real user data loss, and it gets more likely the more phases land that re-provide the job (7b already; 7c outbox replay next).
2. **Wire Observations discoverability** (P1 #1 / Suggested fix #1, #12). Either route the Obs button or re-add the overview card. Right now a user can create a C1 observation via voice but then has no way to audit/edit it from the UI.
3. **Disable or toast the stub controls** (P1 #4 / Suggested fix #4). Six interactive controls that look live but silently do nothing is both an a11y failure and a QA hazard — testers are already reporting "I tapped Defaults and nothing happened" as a bug.
