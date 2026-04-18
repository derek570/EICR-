# 1. Summary of the phase

Phase 0 cleanly archived the legacy `web/` app into `_archive/web-legacy/` and replaced `web/` with a fresh Next.js 16 / React 19 / Tailwind 4 scaffold. It also established the initial CertMate design-token layer, a small base UI set (`Logo`, `Button`, `Card`), and a Playwright-based screenshot harness for visual comparison.

Current branch note: `web/` has moved substantially since `881d437` (`layout.tsx`, `page.tsx`, `globals.css`, `verify-visual.ts`, `package.json`, `next.config.ts`, and many new routes/components changed later), so the findings below are anchored to commit `881d437`.

# 2. Alignment with original plan

The implementation broadly matches the handoff doc and commit intent:

- The legacy app was preserved rather than deleted.
- A fresh scaffold was created at `web/`.
- Design tokens were added in CSS and mirrored into TypeScript.
- A visual verification harness was added.

Two intent gaps remain:

- The commit message claims a “single source of truth; no drift” for tokens, but the implementation is actually two manually maintained copies: CSS in [web/src/app/globals.css](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/globals.css:7) and TS in [web/src/lib/design-tokens.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/design-tokens.ts:7). That is not a single source of truth.
- The commit message says the verify harness “spawns its own `next dev` on a free port so it never collides” and “cleans itself up on exit,” but the implementation has a port-selection race and only best-effort cleanup in a local `finally` block ([web/scripts/verify-visual.ts](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:36), [web/scripts/verify-visual.ts](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:127)).

# 3. Correctness issues

- `P2` Port allocation in the verify harness is racy. `freePort()` binds to port `0`, reads the assigned port, closes the socket, and only then starts `next dev` on that port ([web/scripts/verify-visual.ts:36-49](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:36), [web/scripts/verify-visual.ts:99-111](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:99)). Another process can claim the port in between, so the “never collides” guarantee is false.
- `P2` The script advertises `npm run verify [-- --keep-server]`, but there is no argument parsing and the server is always terminated in `finally` ([web/scripts/verify-visual.ts:10](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:10), [web/scripts/verify-visual.ts:127-130](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:127)). That is incorrect CLI behaviour and misleading docs.
- `P2` `PHASE` changes the output folder name but not the selected route set; the script always captures `PHASE_0_ROUTES` ([web/scripts/verify-visual.ts:34](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:34), [web/scripts/verify-visual.ts:97-104](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:97)). That can silently produce mislabeled artifacts.

# 4. Security issues

No concrete security issues were introduced in this phase.

- `[none identified]` No auth, secret handling, XSS surface, or unsafe request logic was added in `881d437`.

# 5. Performance issues

- `P2` The showcase page combines large blurred elements with continuous animation (`.cm-orb`) and glassmorphism blur (`.cm-glass`) ([web/src/app/globals.css:185-222](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/globals.css:185), [web/src/app/page.tsx:14-37](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/page.tsx:14)). On lower-end mobile GPUs this is a common source of unnecessary compositing cost for a page whose purpose is only token verification.
- `P2` Global `text-rendering: optimizeLegibility` on all text can add rendering cost without much value in an app UI ([web/src/app/globals.css:98-107](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/globals.css:98)).

# 6. Accessibility issues

- `P1` The root viewport disables zoom for the entire app via `maximumScale: 1` and `userScalable: false` ([web/src/app/layout.tsx:20-27](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/layout.tsx:20)). That is a WCAG 1.4.4 failure and a poor fit for a data-entry-heavy certificate workflow.
- `P2` The showcase’s status-state row is visually list-like but not marked up as a list ([web/src/app/page.tsx:87-109](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/page.tsx:87)). Minor, but semantic structure is cheap here and improves SR navigation.

# 7. Code quality

- The token system is duplicated, not shared. CSS variables live in [web/src/app/globals.css:7-89](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/globals.css:7) and TS constants in [web/src/lib/design-tokens.ts:7-76](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/design-tokens.ts:7), with naming already drifting (`--spacing-2xl/3xl` vs `xxl/xxxl`).
- `README` and comments overstate behaviour in the verify harness. The docs say “every route” and mention `--keep-server`, but the implementation is hardcoded to `/` and ignores CLI args ([web/README.md:43-47](/Users/derekbeckley/Developer/EICR_Automation/web/README.md:43), [web/scripts/verify-visual.ts:10](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:10)).
- `.cm-card` is introduced but unused in this commit ([web/src/app/globals.css:192-196](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/globals.css:192)). Minor dead code.

# 8. Test coverage gaps

There are no tests under `web/` in this phase.

Missing coverage that would have paid off immediately:

- Token parity tests between CSS and `design-tokens.ts`.
- A smoke test for root metadata/viewport settings.
- Harness tests for route selection, output naming, and cleanup behaviour.
- Visual baseline assertions beyond “write PNGs somewhere”.

# 9. Suggested fixes

1. `web/src/app/layout.tsx:20-27`  
   Remove `maximumScale: 1` and `userScalable: false`. Let users zoom.  
   Why: this is the highest-severity issue in the phase and blocks basic accessibility for inspectors on mobile.

2. `web/scripts/verify-visual.ts:36-49, 99-111`  
   Replace the close-then-reopen port flow with a retryable startup strategy. Either let the dev server choose a port and parse its output, or retry on bind failure instead of assuming the probed port stays free.  
   Why: current behaviour violates the commit’s “never collides” guarantee and makes `npm run verify` flaky.

3. `web/scripts/verify-visual.ts:10, 97-104, 127-130`  
   Either implement CLI parsing for `--keep-server` and phase-based route selection, or remove those claims from the usage/docs until they exist.  
   Why: the current interface is misleading and will produce confusing screenshots when `PHASE` is set.

4. `web/src/app/globals.css:60-67` and `web/src/lib/design-tokens.ts:52-60`  
   Move tokens to one canonical source and generate the other representation, or add a parity test that fails on drift. Also normalize naming (`2xl`/`3xl` vs `xxl`/`xxxl`).  
   Why: the current implementation does not meet the stated “single source of truth” objective.

5. `web/src/app/page.tsx:87-109`  
   Mark the recording-state items up as a semantic list (`ul`/`li`) and preserve the visible labels.  
   Why: improves screen-reader navigation for essentially no cost.

6. `web/src/app/globals.css:185-222` and `web/src/app/page.tsx:14-37`  
   Tone down or gate the orb/glass effects for visual verification pages, especially on mobile.  
   Why: avoids paying GPU cost for decoration on a non-production showcase.

# 10. Overall verdict

**Ship with fixes.**

The phase achieved its main foundation goals and is a reasonable base to build on, but it shipped with one real accessibility regression and a couple of harness/intent mismatches that should have been tightened before calling the foundation complete.

Top 3 priority fixes:

1. Re-enable pinch zoom in [web/src/app/layout.tsx](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/layout.tsx:20).
2. Make the verify harness robust against port collisions in [web/scripts/verify-visual.ts](/Users/derekbeckley/Developer/EICR_Automation/web/scripts/verify-visual.ts:36).
3. Eliminate token drift risk between [web/src/app/globals.css](/Users/derekbeckley/Developer/EICR_Automation/web/src/app/globals.css:7) and [web/src/lib/design-tokens.ts](/Users/derekbeckley/Developer/EICR_Automation/web/src/lib/design-tokens.ts:7).