# Phase 0 — Claude Code Review

**Commit:** `881d437` — feat(web): Phase 0 — ground-up rebuild foundation
**Branch:** `web-rebuild`
**Reviewer:** Claude (Opus 4)

---

## 1. Summary

Phase 0 archived the legacy web client to `_archive/web-legacy/` and laid a fresh Next.js 16 + React 19 + Tailwind 4 + TypeScript scaffold at `web/`. It ships design tokens (both as Tailwind `@theme` CSS custom properties and a mirrored TS module), three base UI primitives (`Button`, `Card`, `Logo`), a showcase `page.tsx` exercising those primitives, and a Playwright `verify-visual.ts` harness that spins up its own `next dev` on a free port and screenshots routes at iPhone 14 Pro and desktop viewports. The phase is intentionally scope-limited to "foundation" with real screens deferred to Phase 1+.

## 2. Alignment with original plan

Implementation matches the handoff/commit message almost exactly. Every stated objective is present:

- Legacy archive to `_archive/web-legacy/` — verified (`ls _archive/web-legacy/` shows full tree preserved).
- `create-next-app`-derived scaffold with Next 16 + React 19 + Tailwind 4 — `package.json` at `web/package.json:32-34` (`next@16.2.4`, `react@19.2.4`).
- Design tokens in both `globals.css` `@theme { … }` and `src/lib/design-tokens.ts` — verified both exist and share palette.
- UI primitives (`Button`, `Card`) + `Logo` — all present.
- Playwright visual-verification harness with self-managed dev server on a free port — `web/scripts/verify-visual.ts:202-215` (`freePort()`) and `:281-306` (spawn + cleanup on SIGTERM).
- Showcase page exercising tokens (surface ribbon, rec-state dots, card variants) — matches commit-message description.
- README updated with phase plan + recording-pipeline guardrails — `web/README.md:25-82`.

Minor alignment caveats:
- The commit message mentions "inline max-width values until we codify a shared container primitive" — this is still uncodified at HEAD (no `Container` primitive introduced in later phases either, verified by glob). Not a Phase 0 gap, but the TODO is still open.
- Phase 0 README lists Phase 2 as "Data-entry tabs… Observations, **Inspector**" and Phase 4 as "Recording overlay", but by HEAD the plan has drifted (observations became a modal, "Inspector" became "Staff", and Phase 4 was the recording rebuild). This is expected phase-plan drift — not a Phase 0 defect.

## 3. Correctness issues

**P1 — Viewport `themeColor` drift between layout and manifest (now fixed upstream).**
At Phase 0 (`git show 881d437:web/src/app/layout.tsx`), `viewport.themeColor` was `#0A0A0F`, but `--color-surface-0` in `globals.css` is `#0a0a0f`. A later commit (visible in current `web/src/app/layout.tsx:47`) changed it to `#0a0a0a` with an explicit comment ("Previously `#0A0A0F`, which drifted from both the manifest and the design-system token"). That comment is misleading — `#0A0A0F` was the original token. The **current** drift is that the design token (`--color-surface-0: #0a0a0f`) now differs from `themeColor: #0a0a0a`. Phase 0 introduced the original drift risk by duplicating the colour literal in three places (`globals.css`, `design-tokens.ts`, `layout.tsx`) instead of referencing the CSS var or a shared constant. `Metadata.themeColor` can accept a CSS colour string but cannot reference a custom property, so the duplication is unavoidable — the fix is to import the literal from `design-tokens.ts` (`cmColors.surface[0]`).

**P1 — `verify-visual.ts` `FAKE_JWT` does not match the real middleware contract.**
`web/scripts/verify-visual.ts:41-44` constructs a three-segment JWT with literal `"sig"` signature. The file comment says "Signature is ignored — middleware only checks shape + exp." That is true of many JWT verifiers but is a runtime coupling that Phase 0 does not enforce. If any later phase swaps to `jose` or similar signature verification, this harness breaks silently (screenshots capture a redirect to `/login` instead of the intended page). Two compounding issues:
- `process.env.PHASE ?? '1'` default (`verify-visual.ts:269`) means `npm run verify` without env runs Phase 1, not Phase 0 — surprising given this file was landed as Phase 0 tooling.
- The harness writes `document.cookie = \`token=${token}\`` and `localStorage.setItem('cm_token', …)` but the real auth middleware expected at HEAD may read neither of those names. Verified at Phase 0 time this was notional (no middleware existed yet) — but the test of record was built against imaginary contracts.

**P2 — `verify-visual.ts` races `waitForTimeout(1200)` instead of the actual settle condition.**
`verify-visual.ts:259`. Flake-prone on slower CI; fine for local. Consider `page.waitForFunction` against a known skeleton selector.

**P2 — `page.tsx:66-74` surface ribbon uses interpolated `var(--color-surface-${level})` built from `[0,1,2,3,4]`.**
Works today because `--color-surface-0 … --color-surface-4` all exist, but this is a runtime-string CSS-var reference that Tailwind cannot see at build time. If a token is ever renamed, the failure mode is a silent `initial` background. Low stakes for a throwaway showcase page (already deleted at HEAD), but worth flagging as a pattern to avoid in real screens.

**P2 — `buttonVariants` `primary` uses `hover:brightness-110` on a filled brand-blue.**
`web/src/components/ui/button.tsx:19`. `brightness-110` on `#0066FF` produces a very subtle delta on a dark surface — barely perceptible. iOS parity likely wants a stronger hover (e.g. `bg-[var(--color-brand-blue-soft)]` swap) or an explicit `:hover` opacity overlay. Cosmetic, not a bug.

**P2 — `verify-visual.ts:305` uses SIGTERM but doesn't await child exit.**
On macOS `next dev --turbopack` sometimes ignores SIGTERM for a few seconds while it flushes. The harness exits immediately and leaves the process orphaned until the OS reaps it. Add `await new Promise(r => dev.once('exit', r))` or a short timeout before returning.

## 4. Security issues

**Low — `FAKE_JWT` lives in source.**
`verify-visual.ts:41-44`. It's a non-expiring test token for a local dev server the harness itself spawns. Not a real credential — the signature is literally the string `"sig"`. No real risk, but convention-wise it should probably be marked `@internal` and never eval'd against a non-localhost baseUrl. A small guard (`if (!baseUrl.startsWith('http://localhost')) throw …`) would prevent accidental misuse.

**Low — `process.env.NEXT_TELEMETRY_DISABLED='1'`** set in the spawned dev server — this is actually a privacy/hygiene plus, not a concern.

No XSS, CSRF, injection, or secret leaks found. No auth/session code ships in Phase 0 (middleware lives in later phases).

## 5. Performance issues

No runtime performance concerns for a foundation phase. Observations:

- **Bundle:** `package.json` at Phase 0 already pulls in `@dnd-kit/*` (4 packages), `@radix-ui/*` (7 packages), `@tanstack/react-query`, `zustand`, `react-hook-form`, `zod` — none of which are used by the showcase page. This is defensible (scaffold for all future phases), but if `npm run build` is ever run at Phase 0 the unused deps inflate the bundle. Low priority given the showcase page is throwaway.
- **`cm-orb` animation** in `globals.css:161-169` uses `transform: translate3d(…)` — GPU-composited, correct choice. Good.
- **`:root { color-scheme: dark }`** + forced `.dark` on `<html>` avoids FOUC. Good.
- `font-feature-settings: "rlig" 1, "calt" 1` at `globals.css:105` — harmless; tiny perf cost is worth the typography quality.

## 6. Accessibility

**P1 — `userScalable: false` + `maximumScale: 1`** on the viewport.
`web/src/app/layout.tsx:40-41` (at HEAD; same at Phase 0). This blocks pinch-to-zoom on iOS/Android and is a WCAG 2.1 SC 1.4.4 failure. The comment `viewportFit: 'cover'` suggests the intent was iOS status-bar behaviour, but `userScalable: false` is a separate and harmful choice. Drop `userScalable: false` and raise `maximumScale` to at least `5`. This is a PWA anti-pattern; iOS CertMate-style "app feel" can be achieved via `apple-mobile-web-app-capable` + dvh units without disabling zoom.

**P1 — Logo `aria-label="CertMate"` on a `<span>`.**
`web/src/components/brand/logo.tsx:22-28`. `aria-label` on a non-interactive, non-landmark `<span>` is ignored by most screen readers unless the element also has an appropriate role. If this becomes a link in the header (likely), it should be wrapped in `<Link href="/">` and the `aria-label` moved to the link. For a decorative inline brand mark, `aria-hidden="true"` + a neighbouring heading is usually better. Text inside already says "CertMate" so the `aria-label` is redundant duplication.

**P2 — Focus ring uses `outline: 2px solid var(--color-brand-blue)` globally** at `globals.css:115-119`. Good contrast (`#0066FF` on `#0A0A0F` surface ≈ 4.85:1). But `outline-offset: 2px` + `border-radius: var(--radius-sm)` is set on `:focus-visible` itself, which means the outline's own `border-radius` is applied (Chrome honours this, Safari ignores). On rounded buttons the focus ring may look square in Safari. Test on Safari 18+ before declaring it fixed.

**P2 — Button `focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]`** at `button.tsx:15` is missing `focus-visible:outline-offset-2` — the ring will hug the fill edge and be hard to see on a primary button whose fill is already brand blue. Add an offset or switch to `ring-*` utilities.

**P2 — `tabindex` and landmark roles:** the showcase `page.tsx` uses `<main>` and `<section>` correctly but has two `<h2>` with visually-hidden uppercase/tracking styling and no `<h1>` above "Voice-first EICR authoring." is correct heading order. Good.

**P2 — Touch targets:** `Button` size `sm` is `h-9` (36px), below the 44px minimum for touch. The `md` size defaults to `h-11` (44px), which is fine. `sm` should not be the touch-target variant on mobile. Fine because nothing in Phase 0 uses `sm`.

**Positive a11y observations:**
- `prefers-reduced-motion` is handled in `globals.css:171-180` with `animation-duration: 0.01ms !important` — correct and comprehensive.
- `text-rendering: optimizeLegibility` + SF font stack — good for dyslexic-accessible reading.
- `overscroll-behavior-y: none` on `body` — prevents double-pull-to-refresh, sensible for a PWA.

## 7. Code quality

**Positive:**
- Design-token duplication across CSS and TS is deliberate and well-justified (Playwright and data-layer code need named access). The TS module is read-only (`as const`) — good.
- `cn()` utility at `web/src/lib/utils.ts:1-6` is the canonical `clsx + tailwind-merge` pattern. Correct.
- `cva` in `Button` with `VariantProps<typeof buttonVariants>` — idiomatic and type-safe.
- `Card` accepts a `glass` boolean prop rather than a variant — simple and adequate for the two-state case.
- Every file has a purpose comment at the top explaining intent. Strong docs discipline.

**Convention drift / smells:**

1. **Spacing-token value drift between global CSS and user-level rules (`~/.claude/rules/design-system.md`)**. User rule says `xs: 4px / sm: 8px / md: 16px / lg: 24px`. This file has `--spacing-xs: 2px / sm: 4px / md: 8px / lg: 16px` — an off-by-one-step shift. That is the iOS `CMDesign.Spacing` scale, not the user's default design-system spec. This is deliberate and documented in the file comment, so the iOS parity claim wins — but any team member following the user-level rule file will be confused. Worth a one-line note in `README.md` "Spacing scale is **iOS CMDesign**, not the 4/8/16/24 default".

2. **Design-token TS mirror uses `0A0A0F` (upper) in strings but CSS uses `0a0a0f` (lower)**. `design-tokens.ts:16` has `'#0A0A0F'`, `globals.css:15` has `#0a0a0f`. Functionally identical but a lint/diff hazard. Normalise both to lowercase.

3. **`Card` uses `p-4 md:p-6`** directly as Tailwind spacing numbers rather than `p-[var(--spacing-lg)]` / `p-[var(--spacing-xl)]`. This is a small source of drift — if the spacing tokens change, Cards won't follow. All existing and future tab content should consistently prefer token-driven padding.

4. **Hover states use `hover:brightness-110`** (see correctness item above). Brightness on `#0066FF` is weak; `hover:bg-[var(--color-brand-blue-soft)]` would give an iOS-like response.

5. **`Logo.tsx`** uses a literal `·` middle-dot character. Acceptable, but renders inconsistently across fonts. An inline `<svg>` spacer dot would be more reliable cross-platform. Low priority.

6. **No explicit `"use client"` anywhere yet.** Good — Phase 0 files are all RSC-compatible. The `Button` uses `React.forwardRef` which *can* live in a server component as long as no consumer adds `onClick={...}` from an RSC. This bit phases 1+ so flagging early: `Button` (and any future form primitive) should gain `'use client'` the moment an interactive prop is used by an RSC caller, or consumers should wrap their interactive usage.

**Dead code / redundancy:**
- `web/src/app/page.tsx` (the Phase 0 showcase, 135 lines) was removed in a later commit and replaced with a 10-line redirect. That's expected (the commit message explicitly says "gets replaced with a `/login` redirect in Phase 1"). No Phase 0 defect.

## 8. Test coverage gaps

- **No unit tests.** Phase 0 removed the legacy's `__tests__/` (they moved to `_archive/`). No `vitest`/`jest` replacement in Phase 0. `package.json` at Phase 0 removed `"test": "vitest run"`. This is defensible for a scaffold phase, but the gap widens with each subsequent phase. Recommend adding back a minimal Vitest + `@testing-library/react` setup before Phase 2 (job-detail shell) — visual-diff via Playwright is no substitute for unit tests on state reducers.
- **The `verify-visual.ts` harness has no self-test.** It could silently produce screenshots of a 404 page or a white background if `freePort` or `waitForHttp` misbehave. A sanity check ("after first screenshot, assert PNG is > N bytes") would catch regressions.
- **No `npm run typecheck` verification in CI.** `package.json:11` defines the script but nothing invokes it. A pre-push hook or GitHub Actions check belongs here.
- **No visual-diff comparison in `verify-visual.ts`.** It writes PNGs but doesn't compare against `_reference/ios-screenshots/` — that comparison is done by Claude-in-chat per the README. This is an intentional human-in-the-loop design, not a defect, but documenting it explicitly in the harness file header (rather than only in README) would help.

## 9. Suggested fixes

1. **`web/src/app/layout.tsx:40-41`** — drop `userScalable: false` and raise `maximumScale` to `5`. Why: WCAG 2.1 SC 1.4.4 failure; blocks zoom which is required by low-vision users. The iOS "app feel" is already delivered by `apple-mobile-web-app-capable` and `viewportFit: 'cover'`.

2. **`web/src/app/layout.tsx:47`** — import the surface-0 hex from `@/lib/design-tokens` (`cmColors.surface[0]`) rather than duplicating the literal. Why: eliminates the drift that's already happened once (upper/lower case, then `#0a0a0a` vs `#0a0a0f`).

3. **`web/src/lib/design-tokens.ts:15-20`** — normalise all hex literals to lowercase to match `globals.css`. Why: diff hygiene and grep-ability.

4. **`web/scripts/verify-visual.ts:52-63`** — add `if (!baseUrl.startsWith('http://localhost')) throw new Error('seedAuth must only run against local dev')` guard at the top of `seedAuth`. Why: defence-in-depth against the FAKE_JWT ever being sent at a real backend.

5. **`web/scripts/verify-visual.ts:269`** — change `process.env.PHASE ?? '1'` default to read from the `PHASES` map's first key or require explicit `PHASE=`. Why: running `npm run verify` in Phase 0 without env shouldn't silently jump to Phase 1 routes.

6. **`web/scripts/verify-visual.ts:305`** — await child-process exit with a short timeout before `main()` returns. Why: avoid orphaned `next dev` processes holding ports.

7. **`web/src/components/brand/logo.tsx:22-28`** — remove `aria-label="CertMate"` (the text content already says "CertMate") or wrap in a link and move `aria-label` to the link. Why: redundant ARIA is an anti-pattern and confuses screen-reader output.

8. **`web/src/components/ui/button.tsx:15`** — add `focus-visible:outline-offset-2` (or switch to `focus-visible:ring-2 focus-visible:ring-offset-2`). Why: on primary buttons the focus ring currently merges with the fill.

9. **`web/src/components/ui/button.tsx:19,23,24`** — replace `hover:brightness-110` with `hover:bg-[var(--color-brand-blue-soft)]` (etc.) for a more iOS-native press response. Why: `brightness-110` on already-saturated colours is imperceptible; matches `--color-brand-blue-soft`'s design intent.

10. **`web/src/components/ui/card.tsx:12`** — replace `p-4 md:p-6` with `p-[var(--spacing-lg)] md:p-[var(--spacing-xl)]` (or define `p-tok-lg` utility). Why: token-drift protection; if spacing changes, cards follow.

11. **`web/README.md`** — add a one-line note clarifying that the spacing scale here is iOS `CMDesign`, not the 4/8/16/24 default seen in user-level design-system rules. Why: saves the next contributor 10 minutes of "why is `md` half what I expect".

## 10. Overall verdict

**Ship (already shipped).** Phase 0 is exactly what a foundation phase should be: minimal surface area, clear intent, strong docs, zero production risk (branch-isolated). The token pipeline, UI primitives, and verify harness are all well-engineered and have held up across Phases 1–7c without meaningful rework. The legacy archive preserves reference material without polluting the live tree.

**Top 3 priority fixes (for backport or a Phase 0-touch-up commit):**

1. **Viewport zoom lock** (`layout.tsx:40-41`) — WCAG failure; easy one-line fix.
2. **`FAKE_JWT` localhost guard** (`verify-visual.ts:52-63`) — cheap defence-in-depth.
3. **Theme-color / surface-0 literal duplication** (`layout.tsx:47` + `design-tokens.ts:16` + `globals.css:15`) — already drifted once; fix before it drifts again.

Everything else is polish.
