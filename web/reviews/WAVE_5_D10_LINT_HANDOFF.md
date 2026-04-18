# Wave 5 D10 + Lint-Zero Handoff — Truthful Copy + Final Warning Burn-Down

**Branch:** `wave-5-d10-lint-polish`
**Worktree:** `/Users/derekbeckley/Developer/EICR_Automation/.claude/worktrees/agent-ab4a5631`
**Commits:** `5e2f404` (D10 copy) · `831e203` (lint-zero)
**Scope:** `WEB_REBUILD_COMPLETION §2.3` rows D10 + "Lint zero-warning".
**Status:** `npm run lint` → 0 errors, 0 warnings · `tsc --noEmit` clean · vitest 116/116 · backend jest 318 passing (3 skipped) · no new tests added (not required).

---

## Part A — D10 truthful-copy sweep (`5e2f404`)

Every user-facing string on the three surfaces was audited and rewritten where it overstated the app's actual contract. No behavioural changes; the outbox/replay/reload mechanics remain as Phase 7c/7d shipped them.

### Surface 1: `/offline` shell — `web/src/app/offline/page.tsx`

| Line | Old | New |
|---|---|---|
| `<h1>` | `You&rsquo;re offline` | `You appear to be offline` |
| `<p>` | `Reconnect to continue. Any changes you made before losing signal are still on this device and will sync automatically when the network returns.` | `This page needs a connection. Edits you made while signed in are kept on this device and we&rsquo;ll try to sync them once you&rsquo;re back online.` |

Why: `navigator.onLine` isn't consulted at render — the SW serves this page on navigation timeout, which fires on captive portals and weak-signal handovers where the device still thinks it's online. "Appear to be" is accurate. The old "will sync automatically" guaranteed delivery; the outbox retries with exponential backoff and can mark a row poisoned on 4xx, and the `/offline` shell is reachable from unauth'd routes (`/login`, `/legal` — see `PUBLIC_NAVIGATION_PATHS` in `sw.ts`), where there's no session for the replay worker to sync. "Edits you made while signed in … we'll try to sync" captures both constraints.

Block comment also extended with a "Copy policy (Wave 5 D10)" paragraph so the next copy sweep has a written baseline.

### Surface 2: Root error boundary — `web/src/app/error.tsx`

| Line | Old | New |
|---|---|---|
| `<p>` | `We&rsquo;ve logged this and will take a look. You can try again — if the problem persists after a reload, reopen the app.` | `Try again to reload this section. If the problem keeps happening, quote the reference below when you report it via Settings &rsaquo; System.` |

Why: the file's own block comment says "we don't have Sentry wired yet". The `console.error('[cm:root-error]', ...)` call fires, but no one is monitoring browser consoles. "We've logged this and will take a look" is a false promise. The replacement points the user at Phase 6c's Settings → System admin page and at the `error.digest` reference that's already rendered in the next `<p>`; the stale-server-action auto-reload path triggers before copy renders, so no claim of "automatic recovery" is needed (or made).

### Surface 3: `InstallButton` — `web/src/components/pwa/install-button.tsx`

| Attribute | Old | New |
|---|---|---|
| Visible label | `Install app` | `Install app` (unchanged — accurate, fits header cluster) |
| `aria-label` | `Install CertMate app` | `Add CertMate to your home screen` |

Why: no "Works offline" claim existed on this button (or anywhere near it), so nothing to qualify per the brief. The aria-label was tweaked to mirror `IOSInstallHint`'s h2 ("Add CertMate to your Home Screen") so screen-reader users hear the same outcome on every platform, and to describe the physical action rather than the marketing verb. Block comment extended with a copy-policy paragraph noting why no offline claim is made here (Serwist precache is warmed lazily; only `/offline` is guaranteed warm at install time — deeper pages rely on `NetworkFirst`).

No behavioural bug surfaced during the audit. `reloadOnOnline: true` is still global pending Wave 5 D7's scope-to-`/offline`-only change (per FIX_PLAN Q6); copy is forward-compatible with that.

---

## Part B — lint-zero burn-down (`831e203`)

`npm run lint` now lands **0 errors / 0 warnings** — the explicit `web-rebuild` → `main` acceptance gate (`WEB_REBUILD_COMPLETION §5` row 8).

### Six warning sites fixed

| # | File | Warning | Fix |
|---|---|---|---|
| 1 | `web/src/app/job/[id]/design/page.tsx:28` | `react-hooks/exhaustive-deps` on `data` | `React.useMemo(() => (job.design ?? {}) as DesignShape, [job.design])` |
| 2 | `web/src/app/job/[id]/extent/page.tsx:38` | `react-hooks/exhaustive-deps` on `data` | same pattern, keyed on `job.extent` |
| 3 | `web/src/app/job/[id]/inspection/page.tsx:69` | `react-hooks/exhaustive-deps` on `insp` | same pattern, keyed on `job.inspection` |
| 4 | `web/src/app/job/[id]/installation/page.tsx:89` | `react-hooks/exhaustive-deps` on `details` | same pattern, keyed on `job.installation` |
| 5 | `web/src/app/job/[id]/supply/page.tsx:44` | `react-hooks/exhaustive-deps` on `supply` | same pattern, keyed on `job.supply` |
| 6 | `web/src/components/job/job-tab-nav.tsx:65` | `@typescript-eslint/no-unused-vars` on `_certificateType` | Drop prop + `CertificateType` import; update call site in `job/[id]/layout.tsx:113` |

### Why useMemo (not disable)

The `?? {}` fallback produced a fresh object identity on every render, defeating the downstream `useCallback` memoisation and forcing the whole tab subtree to reconcile. ESLint's warning pointed at a real bug, not a false positive. `useMemo` is the idiomatic fix and exactly what the rule suggests. A `// eslint-disable-next-line` would violate `WEB_REBUILD_COMPLETION §6` footgun 9 ("wrap the expr in useMemo; don't silence the lint").

Per-site inline comment links back to `DesignPage` so the pattern is discoverable for any future tab page that hits the same warning.

### Why drop (not rename) `_certificateType`

The prop was dead API surface. The tab set was unified across EICR + EIC in Phase 6a (per `memory/ios_design_parity.md §"Tab set (unified)"`); the prop hasn't been read in months. The underscore prefix didn't silence `@typescript-eslint/no-unused-vars` because it respects destructure-rename. Removing dead surface is strictly safer than renaming to a symbol ESLint will ignore. Only one call site (`layout.tsx:113`) — updated in the same commit.

### No stragglers

Parent-agent baseline listed exactly 6 warnings; `npm run lint` after the fix matches (0 output, exit 0). No new warnings surfaced that were missed in the baseline.

---

## Gate verification

Run from the worktree:

```
cd /Users/derekbeckley/Developer/EICR_Automation/.claude/worktrees/agent-ab4a5631
export PATH="/opt/homebrew/opt/node/bin:$PATH"

npm install                        # ✓ (262 packages)
cd web && npm run lint             # ✓ 0 errors, 0 warnings
cd web && npx tsc --noEmit         # ✓ clean
cd web && npm test                 # ✓ 116/116 passing (11 files)
cd .. && npm test                  # ✓ 318 passing, 3 skipped (backend jest)
```

Lint baseline before → after: **6 warnings → 0 warnings**.

---

## Stop conditions — none hit

- No behavioural bug surfaced during the copy sweep (the `reloadOnOnline: true` noted on `/offline`'s block comment is known and Wave 5 D7's scope; copy was drafted to be forward-compatible).
- No warning required a code refactor beyond Wave 5 scope.
- No `eslint-disable-next-line` was introduced.

---

## Unblocks

- `WEB_REBUILD_COMPLETION §2.3` D10 + lint-zero rows — land green.
- `§5` acceptance gate row 8 (ESLint 0/0) — land green.
- Feeds directly into `§2.3` Wave 5 row 4 ("Wave 5 PWA durability + polish shipped") alongside D7 / D8 / D9 (separately spawned).

## Recommended next

Merge all four Wave 5 sub-item branches (D7, D8, D9, D10+lint) back onto `web-rebuild`; write a unified `WAVE_5_HANDOFF.md`; run the combined Wave 5 gate (`vitest`, `tsc`, `lint`, Playwright offline flow); proceed to Phase 8 pre-flight (`WEB_REBUILD_COMPLETION §2.5`).
