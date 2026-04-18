# Wave 5 Integration Handoff — PWA Hardening + A11y Chrome + Polish

**Branch:** `web-rebuild` (post-merge)
**Scope:** `web/reviews/WEB_REBUILD_COMPLETION.md` §2.3 — combined landing of D7 (outbox robustness), D8 (`<IconButton>` primitive), D9 (viewport + reduced-motion), D10 (truthful copy), and the lint-zero acceptance gate.
**Status:** 155/155 vitest · 318/318 jest · `tsc --noEmit` clean · `npm run lint --workspace=web` = **0 errors / 0 warnings** (acceptance gate met).

| Merge | HEAD | Sub-handoff |
|---|---|---|
| D7 | `60f2c82` | [WAVE_5_D7_HANDOFF.md](./WAVE_5_D7_HANDOFF.md) |
| D8 + D9 | `754d94c` | [WAVE_5_D8_D9_HANDOFF.md](./WAVE_5_D8_D9_HANDOFF.md) |
| D10 + lint-zero | `888aa67` | [WAVE_5_D10_LINT_HANDOFF.md](./WAVE_5_D10_LINT_HANDOFF.md) |

---

## Aggregate quality gates

```
$ cd web && ./node_modules/.bin/vitest run
 Test Files  16 passed (16)
      Tests  155 passed (155)

$ ../node_modules/.bin/tsc --noEmit
# clean

$ npm run lint --workspace=web
# 0 problems (0 errors, 0 warnings)

$ npm test
Test Suites: 1 skipped, 16 passed, 16 of 17 total
Tests:       3 skipped, 318 passed, 321 total
```

Test-count delta from Wave 4 close: **+39 web** (116 → 155).

| Contributor | Count | Scope |
|---|---:|---|
| D7 new vitest | 28 | `outbox.test.ts` (+), `job-cache-overlay.test.ts` (new), `job-context.test.tsx` (new), `dashboard-cache-race.integration.test.tsx` (new), `login-redirect.integration.test.tsx` (new), `outbox-replay.integration.test.tsx` (+) |
| D8 + D9 new vitest | 11 | `icon-button.test.tsx` (new — 11 specs covering aria-label enforcement, touch-target size, asChild, prefers-reduced-motion integration) |
| D10 + lint-zero | 0 | Copy changes + useMemo wraps — no new tests; lint-0/0 is the acceptance gate |

---

## What shipped

### D7 — strict IDB wrappers + cache overlay + 4xx poison

- Outbox readers parse IDB rows through zod at the boundary (`parseOrThrow` on stored shape) — malformed rows now fail loud instead of silently corrupting the replay worker.
- Job cache read-through now overlays pending outbox patches at read time, so the dashboard and job detail render optimistic post-mutation state during replay. Invariant: **outbox is the source of truth for pending state; cache is never mutated on write.**
- Replay worker: 4xx short-circuits to a structured poison error *except* 408 (timeout) and 429 (rate-limit), which stay transient. Prevents infinite 422-loops; keeps 429 backoff honouring `Retry-After`.
- +28 vitest tests across 6 files — E1 (JobProvider.updateJob), E2 (dashboard cache race + login redirect integration).

### D8 — `<IconButton>` primitive + call-site sweep

- New primitive at `web/src/components/ui/icon-button.tsx`:
  - 44×44 minimum touch target (WCAG 2.5.5).
  - `type` attribute required at the type level (prevents accidental form submits).
  - `aria-label` required via TS union — compile-time enforcement, not lint.
  - `asChild` (Radix Slot) for wrapping Link / DropdownMenuTrigger without nested buttons.
- 17 call sites swept across JobHeader three-dot, AppShell nav, PWA install, observation sheet close, IOSInstallHint dismiss, settings admin/company/staff/system pages, recording overlay controls, job circuits toolbar.

### D9 — viewport + global reduced-motion

- Removed `maximumScale=1` / `userScalable=no` from root `<viewport>` — pinch-zoom restored (WCAG 1.4.4).
- Global `@media (prefers-reduced-motion: reduce)` block in `globals.css`:
  - Clamps `animation-duration` + `transition-duration` to ~0.01ms.
  - Forces `scroll-behavior: auto` (overrides smooth-scroll).
  - Applies to third-party animations (Radix, sonner) without per-component edits.

### D10 — truthful copy

- `/offline` page, global `error.tsx`, `InstallButton`: rewrote misleading claims about offline editing / auto-reconnect / install success to describe actual behaviour.

### Lint-zero

- `useMemo` wraps on data fallbacks across `job/[id]/{design,extent,inspection,installation,supply}/page.tsx` — resolves 5 `react-hooks/exhaustive-deps` warnings carried since Wave 3f.
- Dropped unused `_certificateType` from `job-tab-nav.tsx` and `job/[id]/layout.tsx` callsite — dead since Phase 6 tab refactor.
- Net lint: 6 pre-existing warnings → **0 / 0**. This was the Wave 5 acceptance gate.

---

## Known follow-ups (not fixed this wave)

- **Dashboard `jobs === null` closure-capture race** — surfaced by the D7 agent during `dashboard-cache-race.integration.test.tsx` authoring. A narrow window on cache-warmed navigation where a closure holds `null` while the IDB hydration has already resolved. Not user-visible today because the cache-overlay read path re-evaluates; documented in D7 handoff. Fix candidate for Phase 8 pre-cutover polish or Wave 6 if we spin one.
- **Sonnet reconnect test flakiness** — documented in [WAVE_4C5_CLIENT_HANDOFF.md](./WAVE_4C5_CLIENT_HANDOFF.md) §"Known footguns". The `tests/sonnet-session.test.ts > reconnect flag ON > dirty close schedules a reconnect` spec shows ~1-in-8 timeout flakiness with real timers + `jest-websocket-mock`. Re-runs pass. Not blocking; CI should retry vitest once on failure (already configured).

---

## Phase 8 readiness

All Wave 1–5 acceptance gates met:

| Gate | Target | Actual |
|---|---|---|
| Vitest | green | 155/155 ✓ |
| Jest | green | 318/318 ✓ |
| `tsc --noEmit` | clean | clean ✓ |
| ESLint | 0 errors / 0 warnings | **0 / 0** ✓ |
| RBAC hardening (Wave 4 batch 1 + 2) | shipped | ✓ |
| Sonnet session resume (4c.5 cross-stack) | shipped behind flag | ✓ |
| zod v3/v4 unification | v4 everywhere | ✓ |
| `types.ts` drift audit | complete | ✓ (6 drift points flagged in MINI_WAVE_4_5_HANDOFF) |
| PWA outbox parse-time safety (D7) | strict readers | ✓ |
| A11y chrome (D8 + D9) | 44×44 + pinch + reduced-motion | ✓ |
| User-facing copy (D10) | truthful | ✓ |

The `web-rebuild` branch is ready for Phase 8 — staged deploy to the web ECS task definition via the existing GHA pipeline (push to `main`), followed by production cutover once the soak window (per §2.5 of the completion doc) clears.

---

## Recommended next

1. **Phase 8 §2.5.1** — merge `web-rebuild` → `main` via a single bundled PR (per the saved feedback memory: user prefers one bundled PR for refactor waves). PR body should link back to the 5 wave handoffs + completion doc.
2. **Phase 8 §2.5.2** — staged deploy via GHA; watch `aws logs tail /ecs/eicr/eicr-frontend` for the first 30 min.
3. **Phase 8 §2.5.3** — flip `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=true` on the task-def once the backend Wave 4c.5 deploy is live (see §"Production flip procedure" in [WAVE_4C5_CLIENT_HANDOFF.md](./WAVE_4C5_CLIENT_HANDOFF.md)).
4. **Post-cutover Wave 6 candidate work** — dashboard cache-race follow-up, remove the reconnect feature flag after soak, promote rehydration store to Redis (per §10 of [WAVE_4C5_BACKEND_HANDOFF.md](./WAVE_4C5_BACKEND_HANDOFF.md) if multi-instance backend lands).
