# Visual baseline — 2026-07 (WS0 item 4)

**Status: PARTIAL / BLOCKED.** This session ran autonomously (`/ep`, 2026-07-02) with **no dev-account credentials available**, so only the unauthenticated web surfaces could be captured. Every seeded/authenticated screen — which is the entire required list (dashboard, job tabs ×2 cert types, recording, settings hub, CCU mode sheet, observation card) on BOTH platforms — is BLOCKED below. This folder is the WS5 spec / WS8 acceptance reference once completed; do not mark the WS0 screenshot subtask complete until the blocked captures are added.

## Captured (2026-07-02)

| File | Screen | Viewport | Source |
|---|---|---|---|
| `web/login-iphone.png` | Login (`/login`) | iPhone 14 (390×844 @3x, dark) | local dev server |
| `web/login-desktop.png` | Login (`/login`) | 1440×900 desktop (dark) | local dev server |

- **Capture source:** local dev server `http://localhost:3001`, started with `(cd web && PORT=3001 npx next dev --turbopack)` per the repo Playwright config (`web/playwright.config.ts`); pages pointed at the production backend as configured, but no login was performed — no production data was read or mutated, no jobs/users created.
- **Capture tool/command:** `node web/tests-e2e/visual-baseline-capture.mjs` (committed alongside; Playwright chromium headless, `colorScheme: 'dark'`, full-page PNG, 750 ms animation settle).
- **Fixture / account:** NONE — see blocker. No checked-in fixture or non-production account was discoverable in the repo, env, or docs reachable by an autonomous session.
- **Compression:** Playwright PNG output as-is (~310 KB total for 2 files — far under the 25 MB folder cap; no downscaling needed at this count). When the blocked captures are added: PNG-optimise or ~80%-quality JPEG at device resolution (not @3x scale) and keep the folder under ~25 MB.

## BLOCKED — required screens not capturable this session

**Blocker (both platforms): no dev-account credentials + no safe data fixture available to an autonomous session.** Every required screen sits behind authentication, and the plan forbids creating/mutating production accounts or customer jobs for the baseline. The iOS simulator build was NOT attempted: even a green build yields zero required screens without login credentials (all listed screens are post-auth), so the ~45-min build budget was not spent. Fallback per plan: Derek supplies TestFlight/physical-device screenshots later, or a dev account + seeded EICR/EIC fixture is provided for a re-run of the capture script (extended with an authenticated flow).

| # | Screen | Platform(s) | Needs |
|---|---|---|---|
| 1 | Dashboard | iOS + web (iPhone + desktop) | dev account |
| 2 | Job — Overview tab (EICR + EIC) | iOS + web ×2 viewports | dev account + seeded jobs |
| 3 | Job — Installation tab (×2 cert types) | iOS + web | dev account + seeded jobs |
| 4 | Job — Supply tab (×2) | iOS + web | dev account + seeded jobs |
| 5 | Job — Board tab (×2) | iOS + web | dev account + seeded jobs |
| 6 | Job — Circuits tab (×2) | iOS + web | dev account + seeded jobs (non-empty circuits) |
| 7 | Job — Observations tab (EICR) / Extent + Design (EIC) | iOS + web | dev account + seeded jobs |
| 8 | Job — Inspection tab (×2) | iOS + web | dev account + seeded jobs |
| 9 | Job — Staff tab (×2) | iOS + web | dev account + seeded jobs |
| 10 | Job — PDF tab (×2) | iOS + web | dev account + seeded jobs |
| 11 | Recording (live session UI) | iOS + web | dev account + active session |
| 12 | Settings hub | iOS + web | dev account |
| 13 | CCU mode sheet | iOS + web | dev account + job |
| 14 | Observation card (populated, incl. canonical wording on iOS) | iOS + web | dev account + seeded observation |

**Seed guidance for the re-run:** same representative seeded EICR and EIC job on iOS and web, non-empty installation/supply/board/circuit/observation fields; record the job IDs / fixture source here. iOS build notes (from the plan, unused this session): `xcodegen generate` first if the project file is stale; build with `-derivedDataPath /tmp/certmate-dd` (the DerivedData symlink points at an unmounted external drive); run `git -C CertMateUnified status --short` before/after xcodegen and include only tracked generated project files in a build-enabling commit.

Visual deltas: none observed on the captured screens (login only — no iOS counterpart captured to compare). Per plan, any future deltas are RECORDED here / in the ledger only; no CSS diagnosis or styling edits (WS5 owns that, computed-styles-first per `rules/mistakes.md`).

Blocker also recorded in `web/audit/INDEX-2026-07.md` → "WS0 execution blockers". Parent-program §7 leaves WS0 as BLOCKED/PARTIAL until the iOS captures land.
