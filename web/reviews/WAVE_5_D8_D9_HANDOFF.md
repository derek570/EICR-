# Wave 5 D8 + D9 Handoff — IconButton primitive + pinch-zoom + global reduced-motion

**Branch:** `wave-5-d8-d9-a11y-chrome`
**Worktree:** `/Users/derekbeckley/Developer/EICR_Automation/.claude/worktrees/wave-5-d8-d9`
**Commits:** `8c89c9a` (D8 — IconButton + sweep) · `183fade` (D9 — viewport + reduced-motion)
**Scope:** `FIX_PLAN.md §D D8` (touch targets < 44×44) and `§D D9` (viewport zoom lock + prefers-reduced-motion).
**Status:** 127/127 vitest green · `tsc --noEmit` clean · `eslint .` clean (0 errors, 6 pre-existing warnings) · backend 318/318 sanity check green.

---

## What was done

### D8 — `<IconButton>` primitive (`8c89c9a`)

New file: `web/src/components/ui/icon-button.tsx`.

| Prop | Behaviour |
|---|---|
| `aria-label` | **Required** — intersected into the type (`{ 'aria-label': string }`), not optional. TypeScript rejects any call site that omits it. |
| `size` | `sm` (36×36, desktop-only) / `md` (44×44, **DEFAULT**) / `lg` (48×48). `md` matches the WCAG 2.5.5 AA minimum + Apple HIG 44×44. |
| `variant` | `default` / `surface` / `destructive` / `overlay`. Mirrors the bespoke classNames the sweep sites previously used inline, so no visual regressions. |
| `asChild` | Slot-merges classes onto the single child element. Used for Next `<Link>` back-buttons in settings pages — the Link stays the actual element (keeps prefetch) while the IconButton enforces the 44×44 touch target. |
| `type` | Defaults to `"button"` so an IconButton inside a `<form>` doesn't submit on click. Explicit override (`type="submit"`) still honoured. |
| `iconClassName` | Optional extra classes for the built-in 24×24 glyph wrapper span. |

Design rationale in the file header — the salient bits:

- **Why a dedicated wrapper instead of extending `<Button>`:** IconButton's contract is narrower (no text children, required aria-label, glyph-only). Extending Button would either require making aria-label required globally (wrong for the many label+icon Buttons) or lose the type-level enforcement. Two primitives with focused invariants reads clearer than one with a larger conditional matrix.
- **Why aria-label is type-required:** a 44×44 tap target for a screen-reader-invisible button isn't a11y progress. Optional-but-strongly-suggested props drift out of documentation and into code review; type-required props fail at compile time.
- **Why a 24×24 glyph slot:** decouples visual weight from hit area. All sizes use the same inner glyph box; only the outer button grows. Consumer-owned icons (lucide h-4 w-4 etc.) keep their own sizing inside the slot.

### D8 — sweep (16 sites, same commit)

Every icon-only button/link in mobile chrome, with the previous and new hit area:

| # | File | Before | After | Notes |
|---|---|---|---|---|
| 1 | `components/layout/app-shell.tsx` | 40×40 (`h-10 w-10` Link) | 44×44 | asChild + Next Link, preserves SVG chevron |
| 2 | `components/job/job-header.tsx` | 36×36 (`h-9 w-9`) | 44×44 | variant="surface", preserves brand-blue text |
| 3 | `components/observations/observation-sheet.tsx` | 32×32 (`h-8 w-8`) | 44×44 | Close button |
| 4 | `components/observations/observation-sheet.tsx` | 24×24 (`h-6 w-6`) | 44×44 | Remove-photo overlay (thumbnail grid) |
| 5 | `components/pwa/ios-install-hint.tsx` | 32×32 (`h-8 w-8`) | 44×44 | Dismiss install hint |
| 6 | `components/recording/recording-overlay.tsx` | 24×24 (`h-6 w-6`) | 44×44 | Dismiss Sonnet question |
| 7 | `components/recording/recording-overlay.tsx` | 36×36 (`h-9 w-9`) | 44×44 | HeroIconButton helper (minimise/help) |
| 8 | `app/job/[id]/circuits/page.tsx` | 20×20 (`h-5 w-5`) | 44×44 | Dismiss CCU question pip |
| 9 | `app/job/[id]/circuits/page.tsx` | 32×32 (`h-8 w-8`) | 44×44 | Remove circuit, variant="destructive" |
| 10 | `app/settings/company/page.tsx` | 36×36 | 44×44 | Back to settings, asChild Link |
| 11 | `app/settings/company/dashboard/page.tsx` | 36×36 | 44×44 | Back to settings, asChild Link |
| 12 | `app/settings/staff/page.tsx` | 36×36 | 44×44 | Delete staff, variant="destructive" |
| 13 | `app/settings/staff/[inspectorId]/page.tsx` | 36×36 | 44×44 | Back to staff list, asChild Link |
| 14 | `app/settings/system/page.tsx` | 36×36 | 44×44 | Back to settings, asChild Link |
| 15 | `app/settings/admin/users/page.tsx` | 36×36 | 44×44 | Back to settings, asChild Link |
| 16 | `app/settings/admin/users/new/page.tsx` | 36×36 | 44×44 | Back to users list, asChild Link |
| 17 | `app/settings/admin/users/[userId]/page.tsx` | 36×36 | 44×44 | Back to users list, asChild Link |

(17 call sites in 14 files — two buttons each in observation-sheet, recording-overlay, circuits.)

### D8 — sweep exclusions (intentional)

- **Dialog close button** (`components/ui/dialog.tsx`) — out of scope per handoff (D5 shipped). Left at `h-8 w-8`. If it matters, it should move in a follow-up that touches the D5 surface.
- **Buttons with visible text labels alongside icons** — already adequate hit area via the text width. Specifically skipped: `job-header.tsx` "Back", `transcript-bar.tsx` "Expand overlay", `floating-action-bar.tsx` ActionButton / MicButton (hero), `installation/page.tsx` "Records"/"Additions" toggles, `board/page.tsx` "Add board"/"Remove" pill, `observations/page.tsx` "Remove" pill, `settings/system/page.tsx` "Retry"/"Discard" pills, `company/dashboard/page.tsx` "Copy temporary password" (has visible "Copy"/"Copied" text).
- **Non-interactive icons** — the Lucide `<Share>` inline glyph inside install-hint step 1 is decorative and has `aria-label="Share"` only as alt text; no click handler. Not swept.
- **Buttons already >= 44×44** — `MicButton` (56×56), `ActionButton` rail entries (48×48+).

### D8 — tests (11 new in `web/tests/icon-button.test.tsx`)

All mounted via `createRoot` + `act` (avoids the React-instance dual-copy trap documented in `vitest.config.ts`).

1. Default size produces 44×44 (`h-11 w-11`).
2. `size="sm"` → 36×36 (`h-9 w-9`).
3. `size="lg"` → 48×48 (`h-12 w-12`).
4. `aria-label` propagates to the rendered element.
5. Defaults `type="button"` — regression guard for accidental form submission.
6. Allows `type="submit"` override.
7. `onClick` fires on click.
8. Renders a 24×24 glyph wrapper span.
9. Variant classes applied (`destructive` checked by token fragment).
10. `asChild` — no outer button, classes + aria merged onto the child (Link `<a>`); outer `button` is absent.
11. Focus-visible outline class is present.

### D9 — viewport (`183fade`)

`web/src/app/layout.tsx`: dropped two fields from the `viewport` export.

```diff
 export const viewport: Viewport = {
   width: 'device-width',
   initialScale: 1,
-  maximumScale: 1,
-  userScalable: false,
   viewportFit: 'cover',
   themeColor: '#0a0a0a',
   colorScheme: 'dark',
 };
```

**Why:** `maximumScale: 1` + `userScalable: false` is the textbook WCAG 1.4.4 failure — users cannot zoom to 200% text size. Low-vision inspectors trying to read small observation fields or schedule-of-works entries were blocked by this. The original excuse — "prevent iOS input auto-zoom on focus" — is already handled by our 16 px minimum input font-size, so no zoom lock is necessary.

**What stayed (and why):**
- `width: 'device-width'` + `initialScale: 1` — still required.
- `viewportFit: 'cover'` — load-bearing for the `safe-area-inset-*` CSS used in top-nav and bottom FAB. Removing it would clip under the iOS notch.
- `themeColor` — drives iOS status-bar tint and Chrome Android chrome-shade. PWA manifest points to the same `#0a0a0a`.
- `colorScheme: 'dark'` — force-dark colour scheme (the app is dark-only).

### D9 — globals.css prefers-reduced-motion

`web/src/app/globals.css` already had a global `@media (prefers-reduced-motion: reduce)` block at lines 171–180 from an earlier phase. The D9 work:

1. Added `scroll-behavior: auto !important` to the existing rule (missing from the original block — smooth-scroll defeats the reduced-motion guarantee).
2. Added a design-rationale comment explaining **why `!important` is used** (normally avoided) and how local `.cm-live-*` / `.cm-dialog-*` blocks coexist.

The **D5 dialog-scoped local override block** at the bottom of the file (lines ~328–333, keyed off `.cm-dialog-overlay` / `.cm-dialog-content`) is **untouched**. The two blocks coexist: the global block ensures no page animation exceeds 0.01ms, and the local blocks further downgrade specific surfaces to `transition: none` where Radix/our UX wants no animation at all (dialogs still need to fire open/close — Radix's state machine needs the transition cycle to complete, even if instantly).

---

## Gate counts (before → after)

| Gate | Before | After |
|---|---|---|
| Web vitest | 116 passing | **127 passing** (+11 IconButton tests) |
| Backend jest | 318 passing | **318 passing** (unchanged) |
| `tsc --noEmit` (web) | clean | **clean** |
| `eslint .` (web) | 0 errors / 6 warnings | **0 errors / 6 warnings** (unchanged; pre-existing) |

All six lint warnings are pre-existing in `job/[id]/design|extent|inspection|installation|supply/page.tsx` (all `react-hooks/exhaustive-deps` on `data`/`insp`/`details`/`supply` conditional init) and `job-tab-nav.tsx` (`_certificateType` never read). None introduced by this wave. Per the spec, not burned down here — the lint-zero agent owns those.

---

## Manual verification (D9)

D9 has no automated test — the only reliable check is Chromium devtools + (ideally) a real iOS device.

**Chromium devtools (after `next dev` or `next build && next start`):**

- **Elements panel** → head → `<meta name="viewport">`: content now reads `width=device-width,initial-scale=1`. No `maximum-scale` or `user-scalable` tokens.
- **Rendering panel** → "Emulate CSS media feature `prefers-reduced-motion: reduce`" → navigate to `/offline` (cm-orb drift should collapse to static), start a recording (mic pulse should be instant-on with no pulse animation), open `/settings` on a mobile viewport (ios-install-hint banner should appear without entrance animation).
- **Console**: `matchMedia('(prefers-reduced-motion: reduce)').matches === true` with devtools emulation enabled, and `getComputedStyle(document.querySelector('.cm-orb')).animationDuration === '0.01ms'`.

**iOS Safari real-device (not tested as part of this PR — flag for staged deploy):**

1. Pinch-zoom anywhere on the dashboard or a job detail page should now zoom the viewport — previously locked.
2. Double-tap-to-zoom on the dashboard job list row should work — previously locked.
3. Tapping a text input should NOT auto-zoom (the 16 px min input font-size prevents this). If it DOES, the fix is to bump input font-size, NOT to re-disable zoom.
4. No visible regression in the safe-area-inset behaviour (top nav still clears the notch; bottom FAB clears the home-bar).

If iOS real-device testing surfaces a regression, **do not** re-add `maximumScale`/`userScalable`. Follow up the specific input font-size offender.

---

## Scope boundaries observed

- **No Radix Dialog primitive changes** — D5 surface untouched.
- **No icon library changes** — used existing `lucide-react`; no `react-icons` added.
- **No backend changes** — backend jest run purely as sanity check (unchanged).
- **Viewport theme-color not touched** — pure PWA concern, outside D9 scope.
- **Lint warnings not burned down outside changed files** — lint-zero agent's job.

---

## Follow-ups / footguns for the next agent

1. **Dialog close button** (`components/ui/dialog.tsx`) is still 32×32. It's currently out of scope (D5 territory). If picked up, the sweep template is one-line: replace the manually-styled `DialogPrimitive.Close` with `IconButton asChild` wrapping it.
2. **iOS auto-zoom regression** — if real-device testing shows an input field auto-zooming on focus, the fix is to ensure that input's font-size is ≥ 16 px. Inputs below that threshold (often inherited 14 px from a parent) are the trigger. Do NOT re-add the viewport zoom lock.
3. **`h-6 w-6` glyph wrapper in IconButton** — a few call sites previously used `h-3 w-3` or `h-3.5 w-3.5` icons; they now centre inside the 24×24 wrapper. If any site wants a visibly larger or smaller icon, pass `iconClassName` to override the wrapper's own sizing or size the icon child directly — the wrapper does not shrink children.
4. **asChild type widening** — the `asChild` branch casts props to `HTMLAttributes<HTMLElement>` because the child might be a Link (`<a>`) not a button. Consumers attaching button-specific props (e.g. `type`, `disabled`, `form`) on an asChild render are not validated by TypeScript; document this in the design-system handoff if the pattern proliferates.

---

## Files touched

| File | D8 | D9 |
|---|---|---|
| `web/src/components/ui/icon-button.tsx` | new | — |
| `web/tests/icon-button.test.tsx` | new | — |
| `web/src/components/layout/app-shell.tsx` | ✓ | — |
| `web/src/components/job/job-header.tsx` | ✓ | — |
| `web/src/components/observations/observation-sheet.tsx` | ✓ | — |
| `web/src/components/pwa/ios-install-hint.tsx` | ✓ | — |
| `web/src/components/recording/recording-overlay.tsx` | ✓ | — |
| `web/src/app/job/[id]/circuits/page.tsx` | ✓ | — |
| `web/src/app/settings/company/page.tsx` | ✓ | — |
| `web/src/app/settings/company/dashboard/page.tsx` | ✓ | — |
| `web/src/app/settings/staff/page.tsx` | ✓ | — |
| `web/src/app/settings/staff/[inspectorId]/page.tsx` | ✓ | — |
| `web/src/app/settings/system/page.tsx` | ✓ | — |
| `web/src/app/settings/admin/users/page.tsx` | ✓ | — |
| `web/src/app/settings/admin/users/new/page.tsx` | ✓ | — |
| `web/src/app/settings/admin/users/[userId]/page.tsx` | ✓ | — |
| `web/src/app/layout.tsx` | — | ✓ |
| `web/src/app/globals.css` | — | ✓ |
