# Web Rebuild — Completion Handoff

**Branch:** `web-rebuild` @ `2d6199c`
**Status:** shipping path through Wave 3 (test slice) complete. Functional Wave 3, Wave 4, Wave 5, cross-cutting deferrals, and Phase 8 remain before promotion to `main`.
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

**Live in production (iOS side):** Deepgram auto-sleep 3-tier + server-side Sonnet v3 multi-turn.

### Test surface

- **72 total** (70 passing + 2 intentional `it.todo`).
- Unit: `outbox`, `outbox-replay`, `apply-ccu-analysis`, `api-client`, `adapters`, `auth-redirect`, `middleware`.
- Integration: outbox → replay → cache-warm via MSW.
- Fake-WS: `DeepgramService` reconnect guard + resample correctness.
- **Still missing:** RTL component tests for `JobProvider.updateJob`, dashboard cache race, login redirect rules (FIX_PLAN §E E2). Playwright not stood up.

### Quality gates (as of `2d6199c`)

```
vitest run     → 72/72 (70 pass + 2 todo)
tsc --noEmit   → clean
npm run lint   → 0 errors, 6 pre-existing warnings (queued for Wave 5)
```

---

## 2. Remaining work

Three functional waves + two cross-cutting threads + one deployment phase, in recommended order.

### 2.1 Functional Wave 3 — Recording pipeline hardening

**Why next:** the test net shipped in the Wave 3 test slice is sharpest against this code right now. Land the fixes while the net is load-bearing; otherwise it rots.

| Item | Surface | Size | Notes |
|---|---|---|---|
| **D3** sessionId guards + explicit status state machine | `web/src/lib/recording-context.tsx`, `deepgram-service.ts` | M | `start()`/`stop()`/`pause()` must not interleave with in-flight reconnects |
| **4b** KeepAlive gated on `ws.bufferedAmount`; close-code logging | `deepgram-service.ts` | S | Promotes 2 `it.todo` stubs in `deepgram-service.test.ts`. **Blocker:** `mock-socket` hardcodes `bufferedAmount = 0`. Pick one in the fix PR: (a) hand-rolled fake WS (~60–80 lines) with mutable `bufferedAmount`, or (b) constructor-level WS seam on `DeepgramService`. Recommend (b) — smaller test surface, one-line product change. |
| **4c** `session_resume` on reconnect + exponential backoff + close-code logging | `sonnet-session.ts` | M | — |
| **4e** `getUserMedia` → `{ ideal: value }` per `~/.claude/rules/mistakes.md` | `recording-context.tsx` | S | iOS Safari `OverconstrainedError` fix |
| **Playwright E2E — record flow** behind Deepgram WS stub: start → pause → resume → stop; overlay keyboard-trapped; ATHS pulse respects `prefers-reduced-motion` | `web/tests-e2e/record.spec.ts` (new) | L | First Playwright harness stand-up |

**Parallelisation:**
- Batch 1 (parallel agents): D3, 4e, Playwright harness stand-up — different files.
- Batch 2 (serial on `deepgram-service.ts`): 4b → 4c.

**Gate:** recordings survive 2× start/stop tornado + network flap; no duplicate reconnects; vitest ≥ 74 (2 todos promoted); `record.spec.ts` green.

---

### 2.2 Wave 4 — RBAC + admin UX + modal a11y

| Item | Surface | Size | Blocker / decision |
|---|---|---|---|
| **D4** JWT carries `company_role`; middleware admin matcher; signature verify | `src/routes/keys.js` payload + `web/src/middleware.ts` + `web/src/lib/auth.ts` | M | Q3 — HttpOnly cookie migration (defer to Phase 9 recommended) |
| **D5** Radix Dialog sweep across 6 modal sites; replace `window.confirm` | 5c / 6a / 6b / 6c modals | M | Q5 — Radix vs react-focus-lock. Recommend Radix (portal + a11y). |
| **6c** admin-user edit: `company_id` / `company_role` editable; confirm modal on deactivate; new backend `/api/admin/users/:id` | `settings/admin/users/[userId]/page.tsx` + `src/routes/admin.js` | M | Q8 — endpoint approval |
| **6b** per-company settings key fix (kill-list #15 rider) | `src/routes/settings.js` + settings forms | S | — |
| **D12 tail** — promote `parseOrThrow` on login + admin writes | `api-client.ts` + affected adapters | S | — |

**Parallelisation:** D4, D5, 6c are three independent subagent scopes. 6b folds into whichever sub-agent touches `settings.js`. D12 tail folds in wherever adapters are touched.

**Gate:** WCAG 2.1 AA keyboard-only walk through all 6 modals; RBAC E2E green (dotted-path middleware; company-dashboard gating; forged-JWT `company_role` rejection).

---

### 2.3 Wave 5 — PWA durability + a11y polish + copy

**D11 already shipped (Wave 3b).** Remaining:

| Item | Surface | Size |
|---|---|---|
| **D7 (full)** strict wrappers on mutation IDB paths; overlay queued patch onto `job-detail` cache; 4xx short-circuit → `markMutationPoisoned`; E1/E2 tests per D6 | `outbox.ts`, `job-cache.ts`, `queue-save-job.ts`, `outbox-replay.ts` | M |
| **D8** `<IconButton size="md">` with 44×44 hit area + 24×24 glyph; sweep trash icons (3b, 5c) and back-link icons (6c) | new `components/ui/icon-button.tsx` + call sites | S |
| **D9** remove `maximumScale`/`userScalable`; global `prefers-reduced-motion` CSS block | `app/layout.tsx` viewport + `app/globals.css` | S |
| **D10** truthfulness-of-copy sweep on `/offline`, error boundary, install button | `/offline/page.tsx`, `error-boundary.tsx`, `InstallButton` | S |
| **Lint zero-warning** — 4 `useMemo` wraps on job tab pages + unused `_certificateType` | as tagged by ESLint | S |

**Parallelisation:** all five are independent subagents.

**Gate:** Playwright offline flow green (disconnect → edit → reload shows queued patch → reconnect → replay → cache warmed); vitest ≥ 80/80; `npm run lint` 0 warnings.

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
| 2 | Functional Wave 3 shipped | D3/4b/4c/4e commits; 2 `it.todo` stubs in `deepgram-service.test.ts` promoted to passing tests |
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

### Week 1 — recording + RBAC

| Day | Work |
|---|---|
| 1 | Functional Wave 3 batch 1 (D3 + 4e + Playwright harness in parallel) |
| 2 | Functional Wave 3 batch 2 (4b → 4c serial on `deepgram-service.ts`); promote 2 `it.todo` stubs; Playwright record.spec |
| 3 | Wave 4 batch 1 (D4 + D5 + 6c in parallel; 6b + D12 tail folded in) |
| 4 | Wave 4 cleanup + mini-wave 4.5 (zod v3/v4 split + `types.ts` collapse) |
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

- [`WAVE_3_HANDOFF.md`](./WAVE_3_HANDOFF.md) — test-focused slice (just shipped)
- [`WAVE_3A_HANDOFF.md`](./WAVE_3A_HANDOFF.md) · [`WAVE_3B_HANDOFF.md`](./WAVE_3B_HANDOFF.md) · [`WAVE_3C_HANDOFF.md`](./WAVE_3C_HANDOFF.md) — sub-wave detail
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
