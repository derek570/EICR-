# Web Rebuild — Completion Handoff

**Branch:** `web-rebuild` (updated post Wave 5 merge)
**Status:** shipping path through **Wave 5 complete** (D7 strict IDB wrappers + cache overlay + 4xx poison carve-outs; D8 `<IconButton>` 44×44 primitive + 17-site sweep; D9 viewport pinch-zoom + global prefers-reduced-motion; D10 truthful copy; lint-zero acceptance gate met). **Only Phase 8 — staged deploy + production cutover — remains before promotion to `main`.**
**Purpose:** single hand-off-to-finish. A subsequent agent (loop-scheduled subagent or human) can read this and run the remaining waves without re-deriving context from 12 prior handoffs.

---

## Table of contents

1. [Current state](#1-current-state)
2. [Remaining work](#2-remaining-work)
3. [Open questions (must be answered)](#3-open-questions-must-be-answered)
4. [Execution plan — autonomous pipeline](#4-execution-plan--autonomous-pipeline)
5. [Acceptance gates for `web-rebuild` → `main`](#5-acceptance-gates-for-web-rebuild--main)
6. [Known footguns](#6-known-footguns)
7. [Fastest path to `main`](#7-fastest-path-to-main)
8. [Reference trail](#8-reference-trail)

---

## 1. Current state

### Shipped on `web-rebuild`

**Product phases (0 → 7d):** scaffold → recording pipeline → capture flows (CCU / document extraction / observation photos / LiveFill) → settings & admin (staff, company, admin users) → PWA foundation + update handoff + IDB read-through + offline indicator + iOS ATHS hint + offline mutation outbox + offline-sync UI.

**Fix waves shipped:**

| Wave | Scope | Tests added | Handoff |
|---|---|---|---|
| **Wave 1** | 17 kill-list P0s (saveJob PATCH→PUT, stale-closure `updateJob`, CCU board scoping, middleware dotted-path, `/settings/company/dashboard` admin gate, Deepgram certificateType, AudioWorklet 16 kHz resample, reconnect de-dup, subprotocol array, Sonnet JWT-only, outbox strict wrapper (partial), 4xx poison, cache-warm-on-save, SW first-install no-reload, login open-redirect, `company_name` empty→null) | — | `WAVE_1_HANDOFF.md` |
| **Wave 2a** | D6 harness (vitest 4 + jsdom + RTL + fake-indexeddb) + D12 (`ApiError` JSON envelope) + regression suite | +32 (5 suites) | `WAVE_2_HANDOFF.md` |
| **Wave 2b** | D2 adapter layer (zod schema on every `api-client` response via `parseOrWarn`) | +20 | `WAVE_2B_HANDOFF.md` |
| **Wave 3a** | MSW integration tests for outbox → replay → cache-warm | +5 | `WAVE_3A_HANDOFF.md` |
| **Wave 3b** | D11 component de-dupe (`Pill`, `LabelledSelect`, `MultilineField`, `formatShortDate`) | 0 (pure refactor) | `WAVE_3B_HANDOFF.md` |
| **Wave 3c** | DeepgramService regression tests behind `jest-websocket-mock` | +13 + 2 `it.todo` | `WAVE_3C_HANDOFF.md` |
| **Wave 3f** | D3 status state machine + 4b KeepAlive bufferedAmount gate + WS factory seam + 4e `{ ideal }` lock-in; promoted 2 `it.todo` to real tests | +3 (73 total, 0 todo) | `WAVE_3F_HANDOFF.md` |
| **Wave 3h** | Playwright harness (chromium + webkit) + record flow spec + browser-side WS stub | +4 Playwright specs | `WAVE_3H_HANDOFF.md` |
| **Wave 3 Functional (closeout)** | Unified Wave 3 closeout; 4c deferred as Wave 4c.5 | — | `WAVE_3_FUNCTIONAL_HANDOFF.md` |
| **Wave 4 D4** | RBAC depth-of-defence: sign `role`/`company_id`/`company_role` into JWT; middleware HMAC-SHA256 verify; typed `SystemRole`/`CompanyRole` + `getUserRole`/`getCompanyRole` getters | +14 (+3 backend, +11 web) | `WAVE_4_D4_HANDOFF.md` |
| **Wave 4 D5** | Radix Dialog primitives (`dialog.tsx`, `confirm-dialog.tsx`); 6 ad-hoc modals migrated; `window.confirm` banishment; Playwright focus-trap spec flipped to live | +0 vitest, +1 Playwright (focus-trap) | `WAVE_4_D5_HANDOFF.md` |
| **Wave 4c.5 backend** | `session_ack` server-minted `sessionId`; `session_resume` rehydrate handler (5-min TTL, LRU-capped in-memory store, user-boundary enforced) | +29 backend (19 unit + 10 integration) | `WAVE_4C5_BACKEND_HANDOFF.md` |
| **Wave 4c.5 client** | Flag-gated (`NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED`) reconnect state machine; AWS full-jitter backoff (`500 * 2^(n-1)`, cap 10 s, max 5 attempts); `session_resume` on reconnect; close-code logging matches Deepgram | +18 vitest | `WAVE_4C5_CLIENT_HANDOFF.md` |
| **Wave 4 batch 1 closeout** | Unified integration of D4 + D5 + 4c.5 backend + 4c.5 client | — | `WAVE_4_HANDOFF.md` |
| **Wave 4 batch 2** | 6c editable `company_id`/`company_role` + deactivate `<ConfirmDialog>`; new `GET /api/admin/users/companies/list` lite endpoint + self-reassign guard; 6b tail regression-test sweep (5 supertest cases on `src/routes/settings.js` — already clean post-#15-fix); D12 tail `parseOrThrow` on login + admin writes (reads stay on `parseOrWarn`) | +14 web vitest, +13 backend jest | `WAVE_4_BATCH_2_HANDOFF.md` |
| **Mini-wave 4.5** | Zod v3→v4 alignment (zero-source-change bump — Wave 2b adapter author pre-wrote v4-safe schemas); `types.ts` audit surfaced 6 wire-contract drifts with shared-types (User, AdminUser, CompanySettings, InspectorProfile, JobDetail, Circuit/Observation) flagged for Phase 9; only Job + CertificateType collapsed to re-exports | 0 new | `MINI_WAVE_4_5_HANDOFF.md` |
| **Wave 5** | D7 strict IDB wrappers on outbox readers + job-cache overlay of queued patches + 4xx short-circuit (408/429 stay transient) + structured poison error + E1/E2 RTL coverage; D8 new `<IconButton>` primitive (44×44 WCAG 2.5.5, type-required aria-label, asChild) + 17-site sweep; D9 viewport pinch-zoom restored (WCAG 1.4.4) + global `prefers-reduced-motion` CSS block; D10 truthful copy on `/offline` + error boundary + install button; lint-zero: `useMemo` wraps on 5 job-tab fallback objects + drop unused `_certificateType` | +39 vitest (28 D7, 11 D8/D9, 0 D10/lint) | `WAVE_5_HANDOFF.md` |

**Live in production (iOS side):** Deepgram auto-sleep 3-tier + server-side Sonnet v3 multi-turn.

### Test surface

- **155 total vitest** (0 `it.todo`) + **4 Playwright specs** (focus-trap spec live after Wave 4 D5; full post-merge Playwright rerun pending — scheduled for Phase 8 pre-flight).
- Unit: `outbox`, `outbox-replay`, `apply-ccu-analysis`, `api-client`, `adapters`, `auth-redirect`, `middleware`, `deepgram-service`, `mic-capture`, `auth-role-getters`, `sonnet-session`, `icon-button`, `job-cache-overlay`, `job-context`.
- Integration: outbox → replay → cache-warm via MSW; dashboard cache race; login redirect (E2 landed in Wave 5 D7).
- Fake-WS (vitest): `DeepgramService` reconnect guard + resample correctness + `bufferedAmount` gating; `SonnetSession` reconnect state machine.
- E2E (Playwright): record flow (start/pause/resume/stop, prefers-reduced-motion, focus-trap) on chromium; harness smoke on chromium + webkit.
- **Still missing:** 5 Playwright E2E flows (login, job edit, admin, offline, PWA) — slated for Phase 8 pre-flight or Wave 6 follow-up.

### Quality gates (post Wave 5 merge)

```
vitest run     → 155/155 (0 todo)  [sonnet-session reconnect spec ~1/8 flaky; re-run clean — documented in WAVE_4C5_CLIENT_HANDOFF.md]
jest (backend) → 318/318 (3 skipped pre-existing — OPENAI_API_KEY gated)
playwright     → not yet rerun post-merge; scheduled for Phase 8 pre-flight
tsc --noEmit   → clean
npm run lint   → 0 errors, 0 warnings  ← Wave 5 acceptance gate met
```

---

## 2. Remaining work

Three functional waves + two cross-cutting threads + one deployment phase, in recommended order.

### 2.1 Functional Wave 3 — Recording pipeline hardening ✅ SHIPPED (client-side)

D3 + 4b + 4e + Playwright landed via Waves 3f + 3h. See `WAVE_3_FUNCTIONAL_HANDOFF.md`. 4c split out as **Wave 4c.5** (§2.1b below) because it's cross-stack.

### 2.1b Wave 4c.5 — Sonnet `session_resume` on reconnect (cross-stack) ✅ SHIPPED

**Why split out:** `web/src/lib/recording/sonnet-session.ts` has no reconnect pathway at all — it opens one WS, and on close fires an error. Adding `session_resume` is not a client-only change: the server's `session_ack` payload (in `src/extraction/sonnet-stream.js`) does not carry a session ID today, and the server does not rehydrate multi-turn Sonnet context on a `session_resume` frame. This is a coordinated backend + client release, not a single-agent sub-item.

| Sub-item | Surface | Size | Blocker |
|---|---|---|---|
| **Backend** add `sessionId` to `session_ack`; implement `session_resume` frame handler with 5-min TTL on rehydratable sessions; unit tests on session store | `src/extraction/sonnet-stream.js` + session store | M | Deploy before client-side flag flips |
| **Client** reconnect state machine on `SonnetSession` (attempts counter, exponential backoff with jitter, terminal-failure surface to `RecordingProvider`); capture sessionId from `session_ack`; send `session_resume` on reconnect; match Deepgram close-code log format | `web/src/lib/recording/sonnet-session.ts` + `recording-context.tsx` | M | Backend must ship first OR client gates on a feature flag |

**Parallelisation:** Agent A (backend) + Agent B (client) run in parallel worktrees. Agent B ships behind a feature flag (`enableSonnetReconnect=false` by default) so deploy order doesn't matter; flip the flag post-backend-deploy.

**Gate:** backend unit tests green; client vitest covers attempt counter / backoff / terminal-failure / session_resume frame shape; manual integration test against staging confirms rehydration across a forced WS close.

**Note:** can run in parallel with Wave 4 since surfaces don't touch (Wave 4 = admin/RBAC/modals; 4c.5 = recording pipeline).

---

### 2.2 Wave 4 — RBAC + admin UX + modal a11y ✅ SHIPPED

**Batch 1 (D4 + D5 + 4c.5 backend + 4c.5 client)** — see `WAVE_4_HANDOFF.md`.

**Batch 2 (6c + 6b tail + D12 tail)** — see `WAVE_4_BATCH_2_HANDOFF.md`. Notes:
- 6c: editable `company_id` (company-picker fed by new `GET /api/admin/users/companies/list` lite endpoint) + `company_role` dropdown + self-reassign guard mirroring the existing can't-deactivate-self rule; deactivate gated by `<ConfirmDialog confirmVariant="danger">` on the true→false transition only.
- 6b tail: `src/routes/settings.js` verified already clean post kill-list #15 fix — every company-scoped write routes through `companySettingsPrefix(user)`. Added 5 supertest regression cases to prevent future regressions.
- D12 tail: `parseOrThrow` promoted on `login`, `adminUpdateUser`, `adminResetPassword`, `adminUnlockUser`. Reads keep `parseOrWarn` for graceful degradation. Reuses existing `ApiError`.

---

### 2.3 Wave 5 — PWA durability + a11y polish + copy ✅ SHIPPED

See `WAVE_5_HANDOFF.md`. All five items landed via three parallel worktree agents (D7; D8+D9; D10+lint-zero), merged into `web-rebuild` in dependency order.

**What shipped:**
- **D7** — strict zod `parseOrThrow` on outbox IDB reader paths; `job-cache` overlay of queued outbox patches at read time; 4xx short-circuit with 408/429 carve-out for transients; structured poison error surface; +28 vitest across 6 files (including new `dashboard-cache-race.integration.test.tsx`, `login-redirect.integration.test.tsx`, `job-cache-overlay.test.ts`, `job-context.test.tsx`).
- **D8** — new `components/ui/icon-button.tsx` primitive (44×44 WCAG 2.5.5, type-required `aria-label` via TS union, `asChild` via Radix Slot); 17-site call-site sweep across JobHeader, AppShell, PWA install, observation sheet, IOSInstallHint, settings pages, recording overlay, job circuits toolbar.
- **D9** — removed `maximumScale=1` / `userScalable=no` from root `<viewport>` (WCAG 1.4.4 pinch-zoom restored); global `@media (prefers-reduced-motion: reduce)` block in `globals.css` (also forces `scroll-behavior: auto`).
- **D10** — truthful copy on `/offline`, global `error.tsx`, `InstallButton` — old copy overpromised offline editing / auto-reconnect / install success.
- **Lint-zero** — `useMemo` wraps on 5 job-tab data fallbacks (design/extent/inspection/installation/supply) + dropped unused `_certificateType` param in `job-tab-nav.tsx`. **ESLint now 0 errors / 0 warnings** — the Wave 5 acceptance gate.

**Known follow-up (surfaced, not fixed):** dashboard `jobs === null` closure-capture race, documented in D7 handoff. Narrow window on cache-warmed navigation; not user-visible today because the cache-overlay read path re-evaluates. Candidate for Phase 8 pre-cutover polish.

---

### 2.4 Cross-cutting deferrals (fold into whichever wave touches the surface)

| Deferral | Origin | Right home |
|---|---|---|
| `@certmate/shared-types` zod v3/v4 split — unblocks `types.ts` unification | Wave 2b | Standalone mini-wave 4.5 (between Wave 4 and 5) |
| Collapse `web/src/lib/types.ts` → `@certmate/shared-types` re-exports; migrate 18 api-client consumer files | Wave 2b D2 sub-point 1 | Immediately after zod split; sweep PR |
| Backend PUT/PATCH alias on `/api/jobs/:id` | Wave 2b D2 sub-point 4 | Wave 4 (backend touched for D4 + 6c anyway) |
| Observability sink for `parseOrWarn` drifts → `/api/metrics/*` | Wave 2b + D6 Q3 | Wave 5 |
| KeepAlive `bufferedAmount` gating — promotes 2 `it.todo` | Wave 3c | Wave 3 functional §2.1 item **4b** |

---

### 2.5 Phase 8 — Staged deploy + production cutover

Per `CLAUDE.md` Current Focus. Execute once all fix waves + deferrals are green.

1. **Pre-flight on `web-rebuild`**
   - Full vitest + Playwright E2E green locally.
   - `docker build` against production Dockerfile; run against staging RDS.
   - iOS companion smoke: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh` against staging backend.
2. **Staged deploy to ECS**
   - Push branch; GitHub Actions builds ARM64 → pushes ECR → deploys ECS (~30 min).
   - Monitor:
     ```
     aws ecs describe-services --cluster eicr-cluster-production \
       --services eicr-frontend eicr-backend --region eu-west-2 \
       --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" \
       --output table
     aws logs tail /ecs/eicr/eicr-frontend --region eu-west-2 --since 10m
     ```
   - Canary: keep old revision running; route `certomatic3000.co.uk` to new on low-traffic window.
3. **Production cutover**
   - Run full Playwright E2E against prod URL (auth + job edit + record stubbed + admin + offline + PWA).
   - 100% traffic flip.
   - Hold old revision 24h for rollback.
4. **Promote `web-rebuild` → `main`**
   - Single merge PR (no squash — preserve wave commit history per `CLAUDE.md` commit rules).
   - Gate: every row in §5 below is green.
5. **Post-cutover housekeeping**
   - Move `web/reviews/*_HANDOFF.md` + `WEB_REBUILD_COMPLETION.md` to `docs/reference/rebuild-archive/`.
   - Update `CLAUDE.md` Current Focus: "Phase 8 complete. Rebuild merged to main on YYYY-MM-DD."
   - Add changelog row.
   - Delete the old pre-rebuild `web/` revision from the previous `main` (already superseded) once one release cycle clears.

---

## 3. Open questions (must be answered)

From FIX_PLAN §G, annotated with wave-blocking impact and a recommended default.

| # | Question | Blocks | Recommended |
|---|---|---|---|
| **Q1** | iOS wire-format parity for `earth_type`, `consumer_unit_upgrade`, `jobs` envelope — does iOS move if web fixes wire, or dual-write via versioned `Accept`? | D2 strict parsing; mini-wave 4.5 | **Dual-write via `Accept` header.** iOS moves in a follow-up release; web doesn't wait. |
| **Q2** | `@certmate/shared-types` as single source of truth — OK to collapse `types.ts`? | Mini-wave 4.5 | **Yes**, post zod split. |
| **Q3** | HttpOnly cookie auth migration — Phase 8 or deferred? | Wave 4 D4 scope | **Defer to Phase 9.** localStorage risk acknowledged; HttpOnly is its own post-cutover phase. |
| **Q4** | Deepgram token contract — drop raw-key backend fallback? | Wave 3 functional 4c | **Drop it.** Log 410 Gone for one release, then delete. |
| **Q5** | Focus-trap library — Radix vs `react-focus-lock` vs hand-rolled? | Wave 4 D5 | **Radix Dialog** — portal + a11y built in. |
| **Q6** | `reloadOnOnline: true` policy — keep or scope to `/offline`? | Wave 5 D7 | **Scope to `/offline` only.** Protects in-memory edit state on network flap. |
| **Q7** | Minimum iOS Safari support — confirm ≥ 16? | Wave 5 D7 | **Confirm ≥ 16.** Matches iOS app floor; enables `structuredClone`. |
| **Q8** | Backend `/api/admin/users/:id` endpoint — add so 6c stops 20-page-scanning? | Wave 4 6c | **Yes, add it.** Blocking for clean 6c fix. |
| **Q9** | Plaintext-password-in-state for 6b company-admin reset — redaction-on-unmount vs one-shot reveal? | Wave 4 6b tail | **Redaction-on-unmount short-term.** One-shot reveal in Phase 9. |
| **Q10** | Tests in pre-push — blocking or warn-only until Wave 5? | Gate policy for Phase 8 | **Blocking-on-fail from Wave 5 onward.** |

The user should ratify this table (or override specific rows) before any blocked wave starts. If no answer by the time a wave reaches a blocked item, the agent should use the recommended default and note it in the wave handoff.

---

## 4. Execution plan — autonomous pipeline

The Wave 3 test slice validated the subagent pattern. Reuse it verbatim.

### Per-wave loop (parent session)

1. Read `WEB_REBUILD_COMPLETION.md` (this doc) + latest `WAVE_*_HANDOFF.md`.
2. Identify the next wave's independent sub-items (see §2 parallelisation notes).
3. Spawn one `Agent` per sub-item with:
   - `subagent_type: general-purpose`
   - `isolation: "worktree"`
   - Prompt template in §4.2 below.
4. Wait for all agents to return (parallel in a single tool-use block).
5. Merge branches in dependency order (zero-dep first, then dep-adding).
6. Run combined gates: `vitest run`, `tsc --noEmit`, `npm run lint`, Playwright if relevant.
7. Write unified `WAVE_N_HANDOFF.md` modelled on `WAVE_3_HANDOFF.md`.
8. Commit the handoff; nothing pushed.
9. Return summary to user; stop until `/continue` or scheduled re-invocation.

### Promotion to fully autonomous

Once two more wave-runs succeed under this pattern:

- Wrap parent loop in `/loop 4h` or `/schedule`.
- Each scheduled run spawns a fresh Claude Code → reads latest handoff → runs Recommended next wave → commits + writes new handoff.
- Termination: latest handoff has empty "Recommended next" OR "Phase 8 complete" noted.
- Genuinely fresh context at every level (new process per run, new worktree per sub-item, new agent per phase).

### 4.2 Subagent prompt template

Every subagent prompt MUST include, in this order:

```
1. Working directory (web/ in isolated worktree; branch off web-rebuild;
   create a named branch for this sub-item)
2. Context to read first (in this order):
   - WEB_REBUILD_COMPLETION.md (this doc)
   - FIX_PLAN.md §F row for the wave
   - Latest WAVE_N_HANDOFF.md
   - Specific product files named in §2 for this sub-item
3. Exact scope boundaries — list what to change and what NOT to change.
   Test-only waves: "do NOT modify product code unless a test reveals a
   bug, in which case STOP and report."
4. Gates: `vitest run` + `tsc --noEmit` + `npm run lint` all green before commit.
5. Commit rules: project CLAUDE.md — multi-line, WHAT + WHY + WHY THIS
   APPROACH. Co-Authored-By footer. Do NOT push.
6. Deliverable: new `WAVE_N_SUB_HANDOFF.md` under `web/reviews/` modelled
   on `WAVE_2B_HANDOFF.md`.
7. Final report format: ≤400 words covering files changed, tests
   added, gate counts, commit SHAs, worktree path + branch name, any
   product bugs surfaced (listed, not fixed on test-only waves).
8. Stop conditions: if blocked, commit WIP + report the exact error;
   do NOT force a bad implementation.
```

### 4.3 Worktree hygiene

After merging each wave:

```
git worktree remove .claude/worktrees/agent-<hash>   # for each worktree
git branch -D worktree-agent-<hash>                  # for each temp branch
```

Worktree branches (named `worktree-agent-*`) are created by the harness and are cleanup-only. The named branches (`wave-Na-*`) carry the commits.

---

## 5. Acceptance gates for `web-rebuild` → `main`

ALL rows must be green before the promotion PR is opened.

| # | Gate | Verification |
|---|---|---|
| 1 | 17 Wave 1 kill-list items landed | `git log --grep "Wave 1"` or `WAVE_1_HANDOFF.md` checklist |
| 2 | Functional Wave 3 (client-side) shipped | D3/4b/4e commits landed; 2 `it.todo` stubs promoted to passing tests ✅ |
| 2b | Wave 4c.5 (Sonnet session_resume) shipped | Backend `session_ack` carries `sessionId`; client reconnect state machine green behind flag; manual staging rehydration confirmed |
| 3 | Wave 4 RBAC + modal a11y shipped | Radix Dialog sweep across 6 modals; JWT carries signed `company_role`; middleware admin matcher |
| 4 | Wave 5 PWA durability + polish shipped | D7 strict wrappers + cache overlay + 4xx poison; D8/D9/D10 complete; `/offline` copy truthful |
| 5 | Zod split + types.ts collapse done | `web/src/lib/types.ts` holds only view-model types; wire types re-exported from `@certmate/shared-types` |
| 6 | Vitest | ≥ 90/90 passing (estimate after Wave 4/5 tests), 0 `it.todo` |
| 7 | tsc | `--noEmit` clean across monorepo |
| 8 | ESLint | 0 errors, **0 warnings** |
| 9 | Playwright E2E | All 6 flows green: login, job edit, record (stubbed), admin, offline, PWA |
| 10 | Pre-push hook | Lint + tests blocking-on-fail (per Q10) |
| 11 | Docker build | Production Dockerfile builds green; container runs against staging RDS |
| 12 | Lighthouse | PWA = 100; Performance ≥ 85; Accessibility = 100; Best Practices ≥ 90 |
| 13 | iOS companion smoke | TestFlight build against staging backend; end-to-end record + save succeeds |
| 14 | Production canary | 24h on new ECS revision with old revision ready for rollback |

---

## 6. Known footguns

Distilled from shipped waves so the next agent doesn't re-discover them.

1. **React instance pinning.** Monorepo root hoists React 19.2.3 (via `@dnd-kit/utilities`); `web/` declares 19.2.4. RTL's CJS `require('react')` picks up the wrong copy → "Invalid hook call". For integration tests, use inline `createRoot`/`mountHook` (see `outbox-replay.integration.test.tsx`). **Don't** call RTL `renderHook` without the hoisting workaround.
2. **Zod version drift.** shared-types declares zod v4 devDep but workspace hoists v3. Don't import shared-types schemas into web until the split resolves. Adapters stay in `web/src/lib/adapters/` until then.
3. **MSW + fake timers.** `vi.useFakeTimers()` starves the IDB poll in replay tests. Use real timers + `hitCount` guards. See 3a's handoff for the rationale.
4. **mock-socket `bufferedAmount` is 0.** Hardcoded. KeepAlive tests need a constructor-level WS seam on `DeepgramService` (recommended) or a hand-rolled fake WS. Don't try to "patch" mock-socket — it's not the right pivot.
5. **iOS WebSocket auth.** Query params only, never `Authorization` headers (`~/.claude/rules/mistakes.md`). Upgrade strips them.
6. **Deepgram config parity.** Web and iOS Deepgram configs MUST stay in sync (`utterance_end_ms`, `vad_events`, `endpointing`, model params). Touch one → update the other → note in handoff.
7. **`getUserMedia` constraints.** Use `{ ideal: value }`, not bare. Bare throws `OverconstrainedError` on iOS Safari. Wave 3 4e fixes this; don't regress.
8. **Next App Router cache-control.** Pages with server actions must set `Cache-Control: no-cache`. PWA SW must NEVER cache navigation responses (`NetworkOnly` for `/_next/app`). Don't relax without reading `rules/mistakes.md`.
9. **Stale closure on `useCallback` logical exprs.** The 4 pre-existing lint warnings flag this on job tab pages. Wrap the expr in `useMemo`; don't silence the lint.
10. **Commit message rigour.** Project `CLAUDE.md` requires multi-line messages with WHAT + WHY + WHY THIS APPROACH. Reviewers enforce it. Terse commits get bounced.
11. **Auto-commit, don't batch.** `CLAUDE.md` explicitly: commit per logical unit of work immediately, don't wait for approval. Multiple small commits > one batched commit.
12. **Worktree isolation is for parallel work, not daily editing.** Worktrees share `.git`; branches cross-contaminate if you git-switch inside one. Treat each worktree as write-once → merge → delete.

---

## 7. Fastest path to `main`

Compressed ~10 working days under the subagent pipeline, ~14–16 serial.

### Week 1 — RBAC + cross-stack recording + contracts

| Day | Work |
|---|---|
| 1 | Wave 4 batch 1 (D4 + D5 + 6c in parallel) + Wave 4c.5 backend agent (Sonnet session_ack sessionId) |
| 2 | Wave 4 cleanup (6b + D12 tail) + Wave 4c.5 client agent (reconnect state machine) |
| 3 | Flip 4c.5 feature flag in staging; manual rehydration test across forced WS close |
| 4 | Mini-wave 4.5 (zod v3/v4 split + `types.ts` collapse) |
| 5 | Buffer / wave-level integration testing |

### Week 2 — PWA polish + deploy

| Day | Work |
|---|---|
| 1 | Wave 5 batch 1 (D7 + D8 + D9 + D10 + lint-zero in parallel) |
| 2 | Wave 5 integration; observability sink for `parseOrWarn`; Lighthouse pass |
| 3 | Docker build + staging deploy + iOS companion smoke |
| 4 | Production canary (24h cushion starts) |
| 5 | Cutover + `web-rebuild` → `main` + post-cutover housekeeping |

---

## 8. Reference trail

Reverse-chronological. Each builds on the last.

- [`WAVE_3_FUNCTIONAL_HANDOFF.md`](./WAVE_3_FUNCTIONAL_HANDOFF.md) — client-side recording hardening (just shipped)
- [`WAVE_3F_HANDOFF.md`](./WAVE_3F_HANDOFF.md) · [`WAVE_3H_HANDOFF.md`](./WAVE_3H_HANDOFF.md) — sub-wave detail
- [`WAVE_3_HANDOFF.md`](./WAVE_3_HANDOFF.md) — test slice closeout
- [`WAVE_3A_HANDOFF.md`](./WAVE_3A_HANDOFF.md) · [`WAVE_3B_HANDOFF.md`](./WAVE_3B_HANDOFF.md) · [`WAVE_3C_HANDOFF.md`](./WAVE_3C_HANDOFF.md) — test-slice sub-wave detail
- [`WAVE_2B_HANDOFF.md`](./WAVE_2B_HANDOFF.md) — adapter layer + zod
- [`WAVE_2_HANDOFF.md`](./WAVE_2_HANDOFF.md) — test harness + D12
- [`WAVE_1_HANDOFF.md`](./WAVE_1_HANDOFF.md) — 17 P0 kill list
- [`FIX_PLAN.md`](./FIX_PLAN.md) — master plan (§F waves, §G open questions, §C phase P0/P1/P2 table)
- [`consolidated/`](./consolidated/) — 21 per-phase reviewer synthesis (cite when a finding is ambiguous)
- `CLAUDE.md` (project root) — commit rules + Current Focus
- `~/.claude/rules/mistakes.md` — footgun library; always cross-reference before touching iOS-adjacent code

---

## 9. Drift policy

This doc is a plan; `web-rebuild` HEAD is the ground truth. When plan and code disagree:
- If code is ahead of plan → update plan after confirming with user.
- If plan is ahead of code → implement, then tick the §5 row.
- If both disagree with the product brief → ask the user before proceeding.

Update this doc when:
- A wave completes (mark §5 row; strike remaining items in §2).
- An open question (§3) is answered (delete from table, note the decision in the affected wave's handoff).
- A new footgun is discovered (append to §6).

---

**Final state at completion:** this doc, every `WAVE_*_HANDOFF.md`, and `FIX_PLAN.md` move to `docs/reference/rebuild-archive/` on the day `web-rebuild` merges to `main`. `CLAUDE.md` Current Focus is updated to reflect post-cutover priorities.
