# Phase 0 — Context

**Commit:** `881d437`

## Commit message

```
commit 881d437d327b2363f087a185fa2ec79813318dd2
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 11:31:32 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 11:31:32 2026 +0100

    feat(web): Phase 0 — ground-up rebuild foundation
    
    WHAT
    - Archive the previous `web/` app to `_archive/web-legacy/` for reference.
    - Fresh Next.js 16 + React 19 + Tailwind 4 + TypeScript scaffold at `web/`
      created via `create-next-app`, then extended with design tokens, base UI
      primitives, and a Playwright visual-verification harness.
    
    WHY
    - The legacy web client had several compounding audio-pipeline issues
      flagged in `AUDIO_PIPELINE_AUDIT.md` / `PARITY_DIFF.md` / `POST_MORTEM.md`:
      ring-buffer replay without resampling, silent proxy-fallback degradation
      to Nova-2, stale `jobRef.current` racing Sonnet extraction, transcript
      state lost on nav. A tactical fix list kept growing. User opted for a
      clean-slate rebuild with the working patterns from
      `../transcript-standalone/` carried forward.
    - iOS CertMate app remains the ground truth for look-and-feel; this build
      is a visual + behavioural port, not a reinvention.
    
    WHY THIS APPROACH
    - Build in parallel first so production deploys from `web/` were never at
      risk. At user direction (answer to "archive vs keep untouched"), moved
      legacy out of the way to claim the `web/` name back for the new build.
      Production deploys will be re-enabled in Phase 8 once the rebuild
      reaches parity.
    - Design tokens encoded in CSS custom properties via Tailwind 4's
      `@theme { … }` block, mirrored in TypeScript (`src/lib/design-tokens.ts`)
      so Playwright and data-layer code have named access to the same palette
      the UI uses. Single source of truth; no drift.
    - Verify harness spawns its own `next dev` on a free port so it never
      collides with an in-progress dev session and cleans itself up on exit.
    
    CONTEXT
    - Branch: `web-rebuild`. `main` still holds the legacy web client; this
      branch is not merged until Phase 8 approval.
    - iOS reference screenshots live in `web/_reference/ios-screenshots/` and
      are pasted in-chat (user's stated preference).
    - Phase 0 paragraph-wrap bug on the showcase page was Tailwind-4's changed
      `max-w-*` scale; swapped `max-w-4xl` / `max-w-xl` for explicit inline
      max-width values until we codify a shared container primitive.
    
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Files changed

```
 CLAUDE.md                                          |   1 +
 _archive/web-legacy/.gitignore                     |  41 ++++
 _archive/web-legacy/README.md                      |  36 ++++
 .../web-legacy}/app/(app)/admin/layout.tsx         |   0
 .../web-legacy}/app/(app)/admin/page.tsx           |   0
 .../web-legacy}/app/(app)/admin/system/page.tsx    |   0
 .../web-legacy}/app/(app)/admin/users/page.tsx     |   0
 .../web-legacy}/app/(app)/analytics/page.tsx       |   0
 .../web-legacy}/app/(app)/calendar/page.tsx        |   0
 .../web-legacy}/app/(app)/clients/[id]/page.tsx    |   0
 .../web-legacy}/app/(app)/clients/page.tsx         |   0
 .../web-legacy}/app/(app)/dashboard/page.tsx       |   0
 .../web-legacy}/app/(app)/defaults/page.tsx        |   0
 {web => _archive/web-legacy}/app/(app)/error.tsx   |   0
 .../web-legacy}/app/(app)/job/[id]/board/page.tsx  |   0
 .../app/(app)/job/[id]/circuits/page.tsx           |   0
 .../app/(app)/job/[id]/defaults/page.tsx           |   0
 .../web-legacy}/app/(app)/job/[id]/design/page.tsx |   0
 .../app/(app)/job/[id]/eic-inspection/page.tsx     |   0
 .../web-legacy}/app/(app)/job/[id]/error.tsx       |   0
 .../web-legacy}/app/(app)/job/[id]/extent/page.tsx |   0
 .../app/(app)/job/[id]/history/page.tsx            |   0
 .../app/(app)/job/[id]/inspection/page.tsx         |   0
 .../app/(app)/job/[id]/inspector/page.tsx          |   0
 .../app/(app)/job/[id]/installation/page.tsx       |   0
 .../web-legacy}/app/(app)/job/[id]/layout.tsx      |   0
 .../web-legacy}/app/(app)/job/[id]/loading.tsx     |   0
 .../app/(app)/job/[id]/observations/page.tsx       |   0
 .../web-legacy}/app/(app)/job/[id]/page.tsx        |   0
 .../web-legacy}/app/(app)/job/[id]/pdf/page.tsx    |   0
 .../web-legacy}/app/(app)/job/[id]/photos/page.tsx |   0
 .../web-legacy}/app/(app)/job/[id]/record/page.tsx |   0
 .../web-legacy}/app/(app)/job/[id]/supply/page.tsx |   0
 {web => _archive/web-legacy}/app/(app)/layout.tsx  |   0
 {web => _archive/web-legacy}/app/(app)/loading.tsx |   0
 {web => _archive/web-legacy}/app/(app)/page.tsx    |   0
 .../app/(app)/settings/billing/page.tsx            |   0
 .../app/(app)/settings/company/page.tsx            |   0
 .../web-legacy}/app/(app)/settings/page.tsx        |   0
 .../web-legacy}/app/(app)/staff/page.tsx           |   0
 {web => _archive/web-legacy}/app/favicon.ico       | Bin
 {web => _archive/web-legacy}/app/global-error.tsx  |   0
 {web => _archive/web-legacy}/app/globals.css       |   0
 {web => _archive/web-legacy}/app/layout.tsx        |   0
 .../web-legacy}/app/legal/eula/page.tsx            |   0
 {web => _archive/web-legacy}/app/legal/layout.tsx  |   0
 {web => _archive/web-legacy}/app/legal/page.tsx    |   0
 .../web-legacy}/app/legal/privacy/page.tsx         |   0
 .../web-legacy}/app/legal/terms/page.tsx           |   0
 {web => _archive/web-legacy}/app/login/page.tsx    |   0
 {web => _archive/web-legacy}/app/mic/page.tsx      |   0
 {web => _archive/web-legacy}/app/offline/page.tsx  |   0
 {web => _archive/web-legacy}/app/page.tsx          |   0
 .../web-legacy}/app/test-recording/page.tsx        |   0
 .../web-legacy}/components/brand/certmate-logo.tsx |   0
 .../web-legacy}/components/ccu/ccu-results.tsx     |   0
 .../web-legacy}/components/ccu/ccu-upload.tsx      |   0
 .../components/circuits/circuit-table.tsx          |   0
 .../components/dashboard/animated-counter.tsx      |   0
 .../components/dashboard/create-job-dialog.tsx     |   0
 .../web-legacy}/components/dashboard/job-table.tsx |   0
 .../components/dashboard/metric-card.tsx           |   0
 .../components/dashboard/quick-action-button.tsx   |   0
 .../components/dashboard/recent-job-row.tsx        |   0
 .../components/dashboard/setup-tool-card.tsx       |   0
 .../web-legacy}/components/job/job-header.tsx      |   0
 .../web-legacy}/components/job/job-tab-nav.tsx     |   0
 .../web-legacy}/components/layout/app-header.tsx   |   0
 .../web-legacy}/components/layout/app-shell.tsx    |   0
 .../web-legacy}/components/layout/app-sidebar.tsx  |   0
 .../web-legacy}/components/layout/breadcrumbs.tsx  |   0
 .../web-legacy}/components/layout/header.tsx       |   0
 .../web-legacy}/components/layout/mobile-menu.tsx  |   0
 .../components/layout/mobile-tab-bar.tsx           |   0
 .../components/layout/offline-banner.tsx           |   0
 .../web-legacy}/components/layout/sidebar.tsx      |   0
 .../components/layout/sync-provider.tsx            |   0
 .../components/layout/theme-provider.tsx           |   0
 .../web-legacy}/components/layout/theme-script.tsx |   0
 .../web-legacy}/components/legal/legal-content.tsx |   0
 .../observations/inline-observation-form.tsx       |   0
 .../components/observations/observation-card.tsx   |   0
 .../components/photos/photo-gallery.tsx            |   0
 .../web-legacy}/components/photos/photo-picker.tsx |   0
 .../web-legacy}/components/photos/photo-upload.tsx |   0
 .../components/recording/alert-card.tsx            |   0
 .../components/recording/debug-dashboard.tsx       |   0
 .../components/recording/live-circuit-grid.tsx     |   0
 .../components/recording/recording-controls.tsx    |   0
 .../components/recording/recording-strip.tsx       |   0
 .../components/recording/transcript-display.tsx    |   0
 .../web-legacy}/components/ui/button.tsx           |   0
 .../web-legacy}/components/ui/card.tsx             |   0
 .../web-legacy}/components/ui/checkbox.tsx         |   0
 .../web-legacy}/components/ui/dialog.tsx           |   0
 .../web-legacy}/components/ui/dropdown-menu.tsx    |   0
 .../web-legacy}/components/ui/form.tsx             |   0
 .../web-legacy}/components/ui/glass-card.tsx       |   0
 .../web-legacy}/components/ui/input.tsx            |   0
 .../web-legacy}/components/ui/label.tsx            |   0
 .../web-legacy}/components/ui/radio-group.tsx      |   0
 .../web-legacy}/components/ui/select.tsx           |   0
 .../web-legacy}/components/ui/status-badge.tsx     |   0
 .../web-legacy}/components/ui/textarea.tsx         |   0
 .../web-legacy}/components/ui/toggle.tsx           |   0
 _archive/web-legacy/eslint.config.mjs              |  18 ++
 {web => _archive/web-legacy}/hooks/use-job.ts      |   0
 .../web-legacy}/hooks/use-keyboard-shortcuts.ts    |   0
 .../web-legacy}/hooks/use-recording.ts             |   0
 {web => _archive/web-legacy}/hooks/use-theme.ts    |   0
 .../lib/__tests__/number-normaliser.test.ts        |   0
 .../lib/__tests__/transcript-field-matcher.test.ts |   0
 {web => _archive/web-legacy}/lib/alert-manager.ts  |   0
 {web => _archive/web-legacy}/lib/api-client.ts     |   0
 {web => _archive/web-legacy}/lib/apply-defaults.ts |   0
 {web => _archive/web-legacy}/lib/audio-capture.ts  |   0
 {web => _archive/web-legacy}/lib/auth.ts           |   0
 {web => _archive/web-legacy}/lib/claude.ts         |   0
 {web => _archive/web-legacy}/lib/constants.ts      |   0
 {web => _archive/web-legacy}/lib/db.ts             |   0
 {web => _archive/web-legacy}/lib/debug-logger.ts   |   0
 {web => _archive/web-legacy}/lib/deepgram.ts       |   0
 {web => _archive/web-legacy}/lib/design-tokens.ts  |   0
 .../web-legacy}/lib/keyword-boost-generator.ts     |   0
 {web => _archive/web-legacy}/lib/max-zs-lookup.ts  |   0
 .../web-legacy}/lib/number-normaliser.ts           |   0
 .../web-legacy}/lib/recording-session-store.ts     |   0
 {web => _archive/web-legacy}/lib/sleep-detector.ts |   0
 {web => _archive/web-legacy}/lib/sort-circuits.ts  |   0
 {web => _archive/web-legacy}/lib/store.ts          |   0
 {web => _archive/web-legacy}/lib/sync.ts           |   0
 .../web-legacy}/lib/transcript-field-matcher.ts    |   0
 {web => _archive/web-legacy}/lib/types.ts          |   0
 {web => _archive/web-legacy}/lib/utils.ts          |   0
 {web => _archive/web-legacy}/middleware.ts         |   0
 _archive/web-legacy/next.config.ts                 |  66 ++++++
 {web => _archive/web-legacy}/package-lock.json     |   0
 _archive/web-legacy/package.json                   |  59 ++++++
 _archive/web-legacy/postcss.config.mjs             |   7 +
 .../web-legacy}/public/debug-recording.html        |   0
 {web => _archive/web-legacy}/public/file.svg       |   0
 {web => _archive/web-legacy}/public/globe.svg      |   0
 {web => _archive/web-legacy}/public/icon-192.png   | Bin
 {web => _archive/web-legacy}/public/icon-512.png   | Bin
 {web => _archive/web-legacy}/public/logo-icon.svg  |   0
 {web => _archive/web-legacy}/public/logo-white.svg |   0
 {web => _archive/web-legacy}/public/logo.svg       |   0
 {web => _archive/web-legacy}/public/manifest.json  |   0
 {web => _archive/web-legacy}/public/next.svg       |   0
 {web => _archive/web-legacy}/public/vercel.svg     |   0
 {web => _archive/web-legacy}/public/window.svg     |   0
 _archive/web-legacy/tsconfig.json                  |  34 ++++
 web/.gitignore                                     |   4 +
 web/README.md                                      |  87 ++++++--
 web/_reference/ios-screenshots/README.md           |  28 +++
 web/next.config.ts                                 |  63 +-----
 web/package.json                                   |  40 ++--
 web/scripts/verify-visual.ts                       | 136 +++++++++++++
 web/src/app/globals.css                            | 222 +++++++++++++++++++++
 web/src/app/layout.tsx                             |  42 ++++
 web/src/app/page.tsx                               | 135 +++++++++++++
 web/src/components/brand/logo.tsx                  |  35 ++++
 web/src/components/ui/button.tsx                   |  50 +++++
 web/src/components/ui/card.tsx                     |  48 +++++
 web/src/lib/design-tokens.ts                       |  82 ++++++++
 web/src/lib/utils.ts                               |   6 +
 web/tsconfig.json                                  |   2 +-
 167 files changed, 1135 insertions(+), 107 deletions(-)
```
