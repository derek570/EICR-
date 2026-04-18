# Phase 1 — Context

**Commit:** `21a82b9`

## Commit message

```
commit 21a82b934796166efb0df456307603639415a892
Author:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
AuthorDate: Fri Apr 17 11:39:16 2026 +0100
Commit:     Derek Beckley <derekbeckley@Dereks-Mac-mini.broadband>
CommitDate: Fri Apr 17 11:39:16 2026 +0100

    feat(web): Phase 1 — auth + dashboard with visual verification
    
    Adds the first authenticated surfaces of the ground-up rebuild:
    
    What
    - /login page: glass card over triple ambient orbs (brand-blue / brand-green /
      violet), CertMate wordmark, email+password form with inline error card,
      useTransition pending state. ~420px card, works on iPhone and desktop.
    - /dashboard page: sticky top-nav app shell, 3-up hero stats with animated
      counters (0→value, ease-out cubic, 700ms, prefers-reduced-motion aware),
      New EICR / New EIC quick actions, Recent jobs list with skeleton loading
      and empty state, Setup tiles grid.
    - Route guard middleware — decodes JWT payload via atob() and checks exp
      claim; missing/expired token → /login?redirect=<path>.
    - auth.ts + api-client.ts + types.ts — localStorage+cookie token storage,
      thin typed fetch wrapper, Bearer+credentials dual-auth, retries only
      idempotent methods (avoids legacy duplicate-POST bug).
    - AppShell, JobRow, AnimatedCounter, Input/Label primitives.
    
    Why
    - Need a working entry + dashboard so later phases (job detail, recording)
      have something to navigate from, and so we can visually diff against iOS
      reference screenshots as early as possible.
    - JWT-in-cookie middleware (vs server-side session) lets us keep the
      backend unchanged while still blocking unauth'd navigation at the edge.
    - Animated counter mirrors iOS DashboardView's hero metric animation —
      small detail but critical for "looks exactly like the iOS app" parity.
    
    Why this approach
    - Tailwind 4 @theme tokens + inline CSS vars (var(--color-brand-blue)) for
      brand colours — lets us tweak the palette in one place and keeps
      components readable. (The max-w-* Tailwind 4 wrap bug from Phase 0 taught
      us to prefer inline styles for width caps.)
    - localStorage + mirrored cookie (not httpOnly) chosen deliberately: the
      app-shell needs the user object client-side for the greeting and the
      dashboard needs the user.id to key the jobs fetch. Cookie is only used
      by the Edge middleware for the gate — session still lives in
      localStorage, matching the legacy behaviour and the iOS keychain shape.
    - Retries restricted to GET/HEAD/OPTIONS because the legacy client retried
      POSTs and caused duplicate job creation under flaky 4G — lesson brought
      forward from transcript-standalone.
    - Auth seeding in verify-visual.ts uses a 2099-exp fake JWT so the
      middleware's exp check passes without touching the real backend; Jobs
      API is mocked with page.route so the dashboard snapshots in its empty
      state deterministically.
    
    Visual verification
    - Extended scripts/verify-visual.ts with PHASE_1_ROUTES (/login, /dashboard)
      and a seedAuth helper. All 4 shots (mobile + desktop × login + dashboard)
      captured cleanly — see _screenshots/phase-1-*.
    
    Follow-ups (Phase 2+)
    - Replace the animated counter with iOS's exact spring curve when we get
      the iOS reference screenshots.
    - Wire /settings/* tiles through once Phase 6 lands.
```

## Files changed

```
 package-lock.json                                 | 12697 +++++++-------------
 web/scripts/verify-visual.ts                      |    89 +-
 web/src/app/dashboard/layout.tsx                  |     5 +
 web/src/app/dashboard/page.tsx                    |   244 +
 web/src/app/login/page.tsx                        |   155 +
 web/src/app/page.tsx                              |   136 +-
 web/src/components/dashboard/animated-counter.tsx |    48 +
 web/src/components/dashboard/job-row.tsx          |    64 +
 web/src/components/layout/app-shell.tsx           |    84 +
 web/src/components/ui/input.tsx                   |    44 +
 web/src/lib/api-client.ts                         |   114 +
 web/src/lib/auth.ts                               |    43 +
 web/src/lib/types.ts                              |    40 +
 web/src/middleware.ts                             |    52 +
 14 files changed, 5409 insertions(+), 8406 deletions(-)
```
