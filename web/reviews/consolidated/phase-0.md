# Phase 0 — Consolidated Review

**Commit:** `881d437` — feat(web): Phase 0 — ground-up rebuild foundation
**Branch:** `web-rebuild`
**Reviewers:** Claude (Opus 4), Codex CLI
**Consolidated by:** Claude (Opus 4), with repo verification against `git show 881d437:...`

---

## 1. Phase summary

Phase 0 archived the legacy `web/` app to `_archive/web-legacy/` and replaced it with a fresh Next.js 16 + React 19 + Tailwind 4 + TypeScript scaffold, a CertMate design-token layer (Tailwind `@theme` CSS vars + a mirrored TS module), three base UI primitives (`Logo`, `Button`, `Card`), a showcase `page.tsx`, and a Playwright visual-verification harness at `scripts/verify-visual.ts`. Scope is deliberately foundation-only; real screens land in Phase 1+. The implementation broadly matches the handoff/commit intent, but overstates two claims (single-source-of-truth tokens, collision-proof verify harness).

## 2. Agreed findings

- **P1 / a11y / `web/src/app/layout.tsx:20-27`** — Viewport zoom lock (`maximumScale: 1` + `userScalable: false`) is a WCAG 2.1 SC 1.4.4 failure on a data-entry-heavy inspector workflow. Both reviewers flagged.
- **P2 / quality / `web/scripts/verify-visual.ts:10` (header usage string)** — Script advertises `npm run verify [-- --keep-server]` in its doc header but does no argument parsing; the dev server is always killed in the `finally` block (`:127-130`). Misleading CLI contract. (Codex direct; Claude tangentially — merged.)
- **P2 / quality / `web/src/lib/design-tokens.ts` + `web/src/app/globals.css`** — "Single source of truth" for tokens claimed in the commit message is actually two hand-maintained copies with already-visible drift: TS uses `xxl`/`xxxl`, CSS uses `2xl`/`3xl`; TS hex literals are uppercase (`#0A0A0F`), CSS is lowercase (`#0a0a0f`). Normalise naming + hex case, or generate one from the other, or add a parity test. (Codex named the naming drift; Claude named the case drift — merged.)
- **P2 / quality / commit-message claim vs. reality** — Commit states the harness "spawns its own `next dev` on a free port so it never collides." The `freePort` → `close` → `spawn` sequence has a TOCTOU gap where another process can claim the port between probe and spawn. Low-probability in practice, but the "never collides" guarantee is technically false. (Codex direct.)

## 3. Disagreements

### 3.1 Default `PHASE` value in `verify-visual.ts`
- **Claude said:** `process.env.PHASE ?? '1'` at `:269` — running `npm run verify` without env "silently jumps to Phase 1 routes."
- **Codex said:** `PHASE` only changes the output folder; the script always uses `PHASE_0_ROUTES` (`:34`, `:97-104`).
- **Adjudication — Codex is correct; Claude is wrong on this one.** Verified at `881d437`: line 95 is `const phase = process.env.PHASE ?? '0';` (default is `'0'`, not `'1'`), and line 96 is `const routes = PHASE_0_ROUTES; // extend per-phase in a future patch`. So `PHASE` is only cosmetic (output-dir name) and the default is `0`, not `1`. Claude was reading a later version of the file.
- **Kept finding:** Codex's framing — "PHASE env affects output-dir but not route selection, so later phases will produce mislabeled artifacts" — **P2 / quality**.

### 3.2 `FAKE_JWT` / `seedAuth` in `verify-visual.ts`
- **Claude said:** `verify-visual.ts:41-44` constructs a three-segment `FAKE_JWT` with literal `"sig"`, and `:52-63` houses a `seedAuth` that writes `document.cookie = token=...` and `localStorage.setItem('cm_token', ...)`. Raised as P1 correctness + Low security.
- **Codex said:** No such code exists; no auth or security surface added in this phase.
- **Adjudication — Codex is correct.** Verified by dumping `git show 881d437:web/scripts/verify-visual.ts` in full (136 lines total, matching the diffstat). The file contains no `FAKE_JWT`, no `seedAuth`, no cookie/localStorage seeding, no references to `/login`. Claude was reviewing the HEAD version of the file (which grew to ~300 lines in later phases to handle auth). This is a Claude hallucination as far as Phase 0 is concerned.
- **Dropped** — see section 6.

### 3.3 Line numbers on `verify-visual.ts`
- **Claude cited** `:202-215`, `:281-306`, `:259`, `:269`, `:305` — none valid at `881d437` (file is 136 lines).
- **Codex cited** `:10`, `:34`, `:36-49`, `:97-111`, `:127-130` — all valid at `881d437`.
- **Adjudication** — Codex's anchoring is correct. All `verify-visual.ts` findings below use Codex's line numbers.

### 3.4 Theme-color / surface-0 literal drift
- **Claude said:** At HEAD, `themeColor` is `#0a0a0a`, differing from `--color-surface-0: #0a0a0f` — still drifted; Phase 0 introduced the duplication risk across three files.
- **Codex said:** No finding on this.
- **Adjudication — Claude's concern is valid, but the scope-to-Phase-0 framing matters.** At `881d437` itself, `themeColor: '#0A0A0F'` in `layout.tsx:26` matches `--color-surface-0: #0a0a0f` in `globals.css:15` (case only). There was no value drift at the time of this commit. The drift Claude describes happened in a later commit. For **Phase 0** the finding reduces to "literal duplicated across three files with already-inconsistent case — will drift" (quality, P2), not a correctness bug.

## 4. Claude-unique findings

- **P1 / a11y / `web/src/components/brand/logo.tsx:22-28`** — `aria-label="CertMate"` on a non-interactive `<span>` whose text content already says "CertMate" is redundant and may confuse screen readers. Either drop the `aria-label`, wrap in a link and move the label to the link, or mark the span `aria-hidden="true"` with a neighbouring heading. (Codex did not flag.)
- **P2 / a11y / `web/src/components/ui/button.tsx:15`** — `buttonVariants` base class has `focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]` but no `focus-visible:outline-offset-2`, so the ring hugs the fill on primary buttons (brand blue on brand blue). Add an offset or switch to `ring-*` utilities.
- **P2 / quality / `web/src/components/ui/card.tsx:12`** — `p-4 md:p-6` uses raw Tailwind spacing instead of `p-[var(--spacing-lg)] md:p-[var(--spacing-xl)]`. Drift hazard if spacing tokens change; cards won't follow.
- **P2 / quality / `web/src/components/ui/button.tsx:19,23,24`** — `hover:brightness-110` on `#0066FF`/`#FF453A`/`#00CC66` is barely perceptible on a dark surface. Swap to `hover:bg-[var(--color-brand-blue-soft)]` etc. for an iOS-native press response. Cosmetic.
- **P2 / a11y / `globals.css:115-119`** — Focus-ring `border-radius` on `:focus-visible` itself is honoured by Chrome but ignored by Safari — rounded buttons may have a square ring in Safari. Test before claiming fixed.
- **P2 / quality / iOS CMDesign spacing vs. user-rule spacing** — `--spacing-xs: 2px / sm: 4px / md: 8px / lg: 16px` is the iOS CMDesign scale, half of the 4/8/16/24 default in `~/.claude/rules/design-system.md`. Deliberate, but deserves a one-line note in `README.md` so the next contributor doesn't burn 10 minutes.
- **P2 / a11y / `web/src/components/ui/button.tsx` size `sm`** — `h-9` (36px) is below the 44px mobile minimum. Fine because nothing in Phase 0 uses `sm`, but note for Phase 1+ consumers.
- **P2 / test / no `typecheck` in CI** — `package.json:11` has a `typecheck` script but nothing invokes it.
- **P2 / test / `verify-visual.ts` no PNG-size sanity assertion** — Can silently screenshot a 404 or white background if `freePort` / `waitForHttp` misbehave.
- **Positive / a11y** — `prefers-reduced-motion` block at `globals.css:171-180` is comprehensive; `overscroll-behavior-y: none` is sensible for PWA; `:root { color-scheme: dark }` + forced `.dark` avoids FOUC.

## 5. Codex-unique findings

- **P2 / perf / `globals.css:185-222` + `page.tsx:14-37`** — `.cm-orb` (continuous animation, 60px blur, 420×420/520×520) combined with `.cm-glass` (saturate+blur backdrop-filter) on the showcase page is expensive compositing for a throwaway token-verification surface. Consider gating or toning down for verify runs on lower-end mobile GPUs. (Claude only flagged `cm-orb` as "correct GPU choice"; missed the combined compositing cost.)
- **P2 / perf / `globals.css:98-107`** — Global `text-rendering: optimizeLegibility` on all text adds cost without much visible benefit in app UI.
- **P2 / a11y / `page.tsx:87-109`** — Recording-states row is visually list-like but not marked up as `<ul>/<li>`. Minor semantic-HTML improvement for SR navigation.
- **P2 / quality / `globals.css:192-196` `.cm-card`** — Defined but unused in this commit (the `Card` component uses inline Tailwind utilities, not `.cm-card`). Minor dead code at Phase 0.
- **P2 / test / token-parity test** — Would catch the naming drift (`xxl` vs `2xl`) automatically.

## 6. Dropped / downgraded findings

- **[Claude P1] `verify-visual.ts:41-44` `FAKE_JWT` doesn't match middleware contract** → **DROPPED**. Does not exist at `881d437`. File is 136 lines, no auth-seeding code. Claude was reading a later version.
- **[Claude P1] `verify-visual.ts:52-63` `seedAuth` writes cookie+localStorage against imaginary contracts** → **DROPPED**. Same as above — not in this commit.
- **[Claude Low] `FAKE_JWT` lives in source, no localhost guard** → **DROPPED**. Nothing to guard; file is auth-free at Phase 0.
- **[Claude P2] `verify-visual.ts:259` `waitForTimeout(1200)`** → **DROPPED**. At `881d437` the actual wait is `waitForTimeout(400)` at line ~85 inside `captureRoute`. 400 ms for CSS-settle is mild and not flake-prone at the same level Claude described. The underlying "prefer `waitForFunction`" suggestion still has merit as a future improvement — kept as low-priority advisory only.
- **[Claude P2] `verify-visual.ts:305` SIGTERM not awaited** → **DOWNGRADED to advisory**. Actual code at `:130` is `dev.kill('SIGTERM')` in `finally` — Codex already flagged the broader cleanup weakness (best-effort only). Claude's "orphan process" concern is real but minor; fold into Codex's cleanup item rather than keeping as a separate finding.
- **[Claude P2] `verify-visual.ts:269` default PHASE=`'1'` jumps to Phase 1 routes** → **DROPPED (factual error)**. Default is `'0'`, and routes are hardcoded to `PHASE_0_ROUTES` regardless. See disagreement 3.1.
- **[Claude P2] `page.tsx:66-74` runtime-string CSS-var interpolation** → **DOWNGRADED to note**. The showcase page is explicitly throwaway ("gets replaced with a `/login` redirect in Phase 1"); Tailwind 4's JIT-without-seeing-the-var risk applies only if a token is renamed, which isn't a realistic Phase 0 hazard. Keep as a pattern-to-avoid in future screens but drop from the Phase-0 defect list.
- **[Claude P1] Theme-color / `--color-surface-0` drift at HEAD** → **DOWNGRADED to P2 quality**. No value drift exists at `881d437` — only case inconsistency (`#0A0A0F` vs `#0a0a0f`). The HEAD drift Claude described is a separate, later-commit issue and should be raised on that phase's review, not Phase 0.

## 7. Net verdict

**Ship with fixes** (note: already shipped months ago and has held up across Phases 1–7c with minimal rework; these fixes are backport candidates, not blockers).

### Top 3 priorities

1. **Re-enable pinch zoom** — `web/src/app/layout.tsx:20-27`: drop `userScalable: false`, raise `maximumScale` to `5`. WCAG 2.1 SC 1.4.4 failure; one-line fix. (Agreed P1.)
2. **Align the token-duplication story** — `web/src/lib/design-tokens.ts` + `web/src/app/globals.css`: normalise `xxl`/`xxxl` → `2xl`/`3xl`, normalise hex case to lowercase, and either generate one from the other or add a parity test (e.g. a Vitest that fails on drift). Commit-message claims "single source of truth"; make that true. (Agreed P2 — elevated because it touches an explicit commit-message claim.)
3. **Fix the verify-harness truthfulness gap** — `web/scripts/verify-visual.ts`: (a) honour or delete the `--keep-server` usage claim at `:10`; (b) either wire `PHASE` to a real routes map or hard-strip it so later phases can't produce mislabeled artifacts (`:34`, `:97-104`); (c) replace the probe-close-spawn port dance with retry-on-bind so "never collides" is actually true. (Agreed P2 cluster.)

Everything else (logo aria, button focus offset, card padding tokens, cm-orb/glass perf on showcase, list semantics, unused `.cm-card`) is polish — worth a single cleanup commit but not a ship-blocker.
