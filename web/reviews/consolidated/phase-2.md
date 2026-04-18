# Phase 2 — Consolidated Review

**Commits:** `83b0863` (Phase 2 shell) + `27283fd` (dashboard iOS parity, orthogonal) + `90bd238` (job shell iOS-parity rework). Reviewed against current working tree on `web-rebuild`.

## 1. Phase summary

Phase 2 lands the navigable skeleton for every `/job/[id]/...` route:

- `JobProvider` context (`web/src/lib/job-context.tsx`) holds a fetched `JobDetail` with `updateJob(patch)` / `setJob(next)` mutators and dirty/saving flags (debounced auto-save deferred to Phase 4).
- Shared job layout (`web/src/app/job/[id]/layout.tsx`) auth-gates, fetches once, wraps in `JobProvider` + `RecordingProvider`, renders `JobHeader` + `JobTabNav` + `TranscriptBar` + scroll container + `FloatingActionBar` + `RecordingOverlay`.
- `TabStub` placeholder + 9 per-tab pages (installation, supply, board, circuits, observations, inspection, extent, design, staff, pdf) plus the overview index.
- API client surface — `api.job(userId, jobId)` + `api.saveJob(userId, jobId, patch)`.
- Playwright-style visual harness (`web/scripts/verify-visual.ts`) renders every tab × both cert types × mobile/desktop.

`90bd238` reshaped the shell significantly: removed the desktop vertical sidebar, collapsed the two cert-type tab sets into one unified set, removed Observations from the nav in favour of a floating `Obs` button, renamed `inspector` → `staff`, added iOS-style centred header with Back / ··· menu and `FloatingActionBar`. `27283fd` is dashboard-only and outside the Phase 2 shell.

## 2. Agreed findings

| # | Severity | Area | File:line | Finding |
|---|----------|------|-----------|---------|
| A1 | P1 | Correctness / contract | `web/src/lib/types.ts:192-207` vs backend `src/routes/jobs.js:575-592` | `JobDetail` declares `installation`, `supply`, `board`, `inspection`, `extent`, `design`, `inspector` but the backend returns `installation_details`, `supply_characteristics`, `board_info`/`boards`, `inspection_schedule`, `extent_and_type`, `design_construction`, `inspector_id`. Tab pages will read empty fields. The Phase 2 visual mocks use the frontend shape, masking the break. (Codex P1; Claude §7 #5 notes overlapping shapes.) |
| A2 | P2 | Code quality / drift | `web/src/components/job/job-tab-nav.tsx:50-61`, `web/src/app/job/[id]/page.tsx:22-32`, `web/scripts/verify-visual.ts` | Tab metadata is duplicated across nav, overview grid, and harness. Already drifted — overview lists 9 tabs, nav has 10, harness originally had cert-specific sets. Both reviews recommend extracting a single `JOB_TABS` constant. |
| A3 | P2 | A11y | `web/src/components/job/job-header.tsx:65-87` + `web/src/app/job/[id]/layout.tsx:143-163` | No `role="status"` / `aria-live` on SaveStatus pill; loading shimmer has no `aria-busy` or SR text. (Both reviews.) |
| A4 | P2 (Phase 2 record-keeping) | Docs/drift | commit message `83b0863` vs current tree | Phase 2 commit message still claims two cert-type tab sets, desktop sidebar, and cert-type pill in header; `90bd238` silently reverted all three. (Both reviews flag the drift.) |
| A5 | P2 | Tests | n/a | No unit/integration tests ship with the shell; only the `verify-visual.ts` harness exists, and its baseline screenshots aren't committed. Both reviews recommend tests for `JobProvider` retention, `api.job`/`api.saveJob` contract, tab metadata consistency, and auth-expiry redirect. |

## 3. Disagreements + adjudication

| # | Disagreement | Adjudication |
|---|-------------|--------------|
| D1 | Codex says `saveJob` uses `PATCH` while backend only implements `PUT` → "hard integration failure" (Codex P1). Claude did not flag this. | **Codex is correct.** Verified: `web/src/lib/api-client.ts:278` uses `method: 'PATCH'`; `src/routes/jobs.js:651` only registers `router.put('/job/:userId/:jobId', ...)` (no patch handler). **Elevated to P0-adjacent P1** — this blocks every form-save flow in later phases. |
| D2 | Codex says the harness covers 19 routes (9 EICR + 10 EIC), contradicting the commit's claim of 18 (P2-ish). Claude did not address. | **Codex correct on the mismatch**, though this has since been superseded by `90bd238`'s unified tab set. Keep as a minor §7 docs-drift item rather than a correctness issue. |
| D3 | Claude P1 #1: Observations route is undiscoverable post-`90bd238` because the `Obs` button is a `console.log` stub. Codex P2: wrong-cert routes (`/extent`, `/design`, `/observations`) are reachable directly for the wrong cert type. | **Both issues are real and complementary, not contradictory.** Codex caught that `/extent` /`/design` open on EICR and `/observations` opens on EIC with no guard. Claude caught that even when Observations is the _right_ route, there's no wired UI path to reach it. Merge both into a "route-guard + wire-up" P1 item. Verified: `web/src/app/job/[id]/observations/page.tsx` exists; `observations` no longer in `UNIFIED_TABS`; Obs button handler is `console.log('[bar] obs')` at `floating-action-bar.tsx:85`. |
| D4 | Claude P1 #3: `JobProvider`'s `useEffect([initial])` silently clobbers local edits when the parent re-provides a new object (now happening via Phase 7b cache-then-fetch). Codex did not flag. | **Claude correct and verified.** `web/src/lib/job-context.tsx:50-53` calls `setJob(initial); setIsDirty(false)` on every `initial` identity change; `web/src/app/job/[id]/layout.tsx:65-93` now calls `setJob` twice in sequence (cache paint, fresh fetch). Becomes a live data-loss risk post-7b. **Elevated to P1.** |
| D5 | Codex P2: auth-expiry uses `/401/.test(err.message)` (brittle string match). Claude did not flag. | **Codex correct and verified.** `web/src/app/job/[id]/layout.tsx:82` does regex on the error message; `api-client.ts` throws `ApiError(status, body)` where body may be `"Unauthorized"`. Should use `err instanceof ApiError && err.status === 401`. **Keep as P2.** |
| D6 | Claude flags `router.back()` without history fallback (P1 #2). Codex did not flag. | **Claude correct.** `web/src/components/job/job-header.tsx:30` calls `router.back()` unconditionally; deep links / PWA resumes will leave Back doing nothing or navigating off-origin. **Keep as P1 for parity with iOS Back-to-list behaviour.** |
| D7 | Claude flags 6 `console.log`-only stub controls as a11y / QA hazard (P1 #4). Codex did not address. | **Claude correct** — verified at `floating-action-bar.tsx:61-87, 100` and `job-header.tsx:47-51`. Buttons look live and have valid `aria-label`s but silently swallow activations. **P1** given how visible these are. |

## 4. Claude-unique findings

- **C-1 (P1):** `router.back()` without `window.history.length` fallback (D6 above).
- **C-2 (P1):** `JobProvider` silently resets `isDirty` and overwrites local edits on every `initial`-prop identity change — live risk with Phase 7b cache-paint (D4 above).
- **C-3 (P1):** Six interactive controls wired only to `console.log` (Defaults, Apply, CCU, Doc, Obs, overflow menu, MenuHandle) — a11y SC 4.1.2 concern, QA hazard (D7 above).
- **C-4 (P2):** Title truncation math hard-codes `calc(100% - 200px)` in absolute-centred `<h1>`; overflows at 320px on long addresses (`job-header.tsx:39`).
- **C-5 (P2):** `pathname.startsWith(${href}/)` active-state check could misfire if future slugs share prefixes (`job-tab-nav.tsx:84`).
- **C-6 (P2):** `createdLabel`/date pill in header was dropped by `90bd238` but is still claimed in the Phase 2 commit message.
- **C-7 (P2):** `pb-28` on `JobBody` ignores `env(safe-area-inset-bottom)` — floating bar can overlap last row on iPhone with home indicator (`layout.tsx:139`).
- **C-8 (A11y):** `focus-visible:outline-white` on coloured ActionButtons fails 3:1 on green Apply button (`floating-action-bar.tsx:135`).
- **C-9 (A11y):** MicButton `sr-only` "Recording in progress" has no `aria-live`; state change isn't announced.
- **C-10 (A11y):** Back button `focus-visible:outline-2` missing `outline-offset` — overlaps rounded corner.
- **C-11 (Code quality):** `<FilePlus className="sr-only" aria-hidden />` is invisible to both sighted and SR users — a no-op; remove or render.
- **C-12 (Code quality):** `certificateType` prop on `JobTabNav` retained "for API compatibility" but never read; dead weight (`job-tab-nav.tsx:65-69`).
- **C-13 (Perf):** Cache-then-fetch fires two `setJob` calls → remounts `RecordingProvider` + `TranscriptBar`; an active recording would be stopped. Needs revision-guard.
- **C-14 (Perf/nit):** `sections` array re-created on every render in overview page.
- **C-15 (Security/nit):** `console.log('[bar] …')` stubs ship to production unless gated.
- **C-16 (FAB nit):** `pointer-events-none` outer container + gap between MenuHandle and ActionButton cluster creates a click-through dead zone (cosmetic).

## 5. Codex-unique findings

- **X-1 (P1):** `api.saveJob` uses `PATCH` but backend only registers `PUT` (D1 above). Hardest Phase-2-era integration break.
- **X-2 (P1):** `JobDetail` UI type vs backend wire format mismatch (A1; Codex named and sourced the specific key differences; Claude only noted overlap in `§7 #5`).
- **X-3 (P2):** Auth-expiry regex `/401/.test(err.message)` is brittle — should use `ApiError.status` (D5 above).
- **X-4 (P2):** Wrong-cert tab routes (`/extent`, `/design`, `/observations`) reachable by direct URL with no guard/redirect/`notFound()` (D3, route-guard half).
- **X-5 (Perf):** Every field update re-renders all `useJobContext()` consumers — acceptable for stubs, noticeable once real tabs land (`job-context.tsx:55-70`).
- **X-6 (Harness):** Commit message says 18 routes / 36 screenshots; code generates 19 (D2).
- **X-7 (Suggested fix):** Introduce explicit `ApiJobDetail` ↔ `UiJobDetail` adapter rather than claiming both are the same shape.

## 6. Dropped / downgraded

- **Claude §6 #5** (role="button" tabIndex=0 on observations page) — Claude self-identifies this as a Phase 5c issue, not Phase 2. **Dropped** from Phase 2 scope.
- **Claude §4 JWT localStorage / missing `Secure` cookie** — acknowledged as not a Phase 2 change, Phase 7 territory. **Dropped** from Phase 2 consolidated set.
- **Claude §7 #8 `_certificateType` ESLint warning** — speculative ("may flag unless configured"); the leading-underscore is already a valid convention. **Downgraded** to nit footnote.
- **Claude §6 #8 `pointer-events-none` on h1** — Claude's own conclusion is "Fine." Not a finding. **Dropped.**
- **Claude §6 #4 roving-tabindex on tab strip** — Claude concludes nav-as-tabs is semantically fine. **Dropped.**
- **Claude §6 #6** (missing `aria-current` on overview card) — Claude self-marks as "Less critical". **Downgraded** to style nit.
- **Claude §7 #6** (curly apostrophe in error text) — cosmetic, belongs in a lint rule not a review. **Downgraded** to nit.
- **Codex §7 "Type naming drift"** — largely restates X-2; no independent finding. **Merged** into A1/X-2.
- **Claude §5 `UNIFIED_TABS` at module scope** — Claude marks as "good, no per-render allocation." Not a finding. **Dropped.**
- **Claude §6 #9** (no `prefers-reduced-motion` guard) — Claude self-marks as global rule, not shell-specific. **Downgraded** to global-backlog.

## 7. Net verdict + top 3

**Verdict: Needs rework before Phase 3 tabs start writing to the shell.**

The scaffolding is clean and the iOS-parity rework is a net visual improvement, but three integration-layer issues make this shell unsafe as a foundation:

1. **The GET payload shape and the TypeScript model disagree** (A1 / X-2). Every tab that reads `job.installation` instead of `job.installation_details` will render blank, and every UI test against the harness's frontend-shape mocks will pass while the real app breaks.
2. **`api.saveJob` uses PATCH; backend only accepts PUT** (X-1). Any form save from Phase 3 onward is an integration failure in production.
3. **`JobProvider` silently clobbers `isDirty` on every `initial` identity change** (C-2), which becomes a live data-loss path now that Phase 7b re-provides the job after cache paint + fresh fetch.

### Top 3 priority fixes

1. **Align the client/server `JobDetail` contract** — either rename UI fields to match the wire format (`installation_details`, `supply_characteristics`, etc.) or introduce an explicit `ApiJobDetail` → `UiJobDetail` adapter in `api-client.ts`. Update `verify-visual.ts` mocks to use the real wire shape.
2. **Fix `saveJob` to `PUT`** (or add a `PATCH` route + tests on the backend); swap the brittle `/401/.test(err.message)` check for `err instanceof ApiError && err.status === 401`.
3. **Harden `JobProvider` against re-provide**: compare `initial.id` (or a revision counter), and don't reset `isDirty` when there are un-flushed local edits. Add a minimal RTL test covering the cache-paint → fresh-fetch sequence.

Secondary (should land before Phase 3 ships): wire Obs button + add cert-type guards on `/extent`/`/design`/`/observations`; disable or toast the five `console.log`-only FAB buttons and the header overflow menu; extract a single `JOB_TABS` constant consumed by nav, overview, and harness.
