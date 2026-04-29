# EICR-oMatic 3000

> **MANDATORY — Every code change must update docs and be committed.**
> - Changed a pipeline step, field, or architecture? Update the matching [reference file](docs/reference/).
> - Hub CLAUDE.md is an **index only** — add detail to reference files, not here.
> - Add a row to the [Changelog](#changelog) for any user-facing or architectural change.
> - Delete stale content rather than commenting it out. Keep every file under its target line count.
> - **Commit automatically after each logical unit of work — do NOT wait to be asked.** Small, focused commits with detailed messages explaining both what changed and WHY the code exists.

Automated EICR/EIC certificate creation for electrical inspectors using an iOS-first workflow.

## Project Overview

1. **Photo Capture** - Inspector photographs consumer unit (CCU) via iOS app
2. **CCU Analysis** - GPT Vision extracts circuit data from consumer unit photos
3. **Document Extraction** - GPT Vision extracts certificate data from previous certificates, handwritten notes, or photos
4. **Voice Recording** - Inspector dictates test readings and observations into iOS app
4. **Live Transcription** - Deepgram Nova-3 transcribes speech in real time (direct from iOS)
5. **Live Extraction** - Server-side Sonnet 4.5 extracts structured certificate data via multi-turn conversation
6. **Review & Edit** - Inspector reviews populated certificate in iOS app tabs
7. **PDF Generation** - Generate complete EICR/EIC PDF certificates

## Tech Stack

| Component | Technology |
|-----------|------------|
| iOS App | SwiftUI (CertMateUnified) |
| Transcription | Deepgram Nova-3 (direct WebSocket from iOS) |
| Live Extraction | Claude Sonnet 4.5 (server-side multi-turn via WebSocket) |
| CCU Photo AI | GPT Vision (consumer unit analysis) |
| Document Extraction AI | GPT Vision (certificate/notes data extraction) |
| Backend | Node.js (ES modules) — API, WebSocket, S3 |
| PDF (iOS) | WKWebView HTML->PDF (EICRHTMLTemplate.swift) — **iOS app uses this, NOT the server generators** |
| PDF (server) | Python ReportLab + Playwright — **only used by web frontend (web/)** |
| Web Frontend | Next.js (App Router, PWA) |
| Cloud | AWS ECS Fargate, S3, RDS PostgreSQL, Secrets Manager |

## Monorepo Structure

npm workspaces with 3 packages:

| Workspace | Path | Purpose |
|-----------|------|---------|
| Backend | `src/` | Express API + WebSocket server |
| Web | `web/` | Next.js frontend (PWA, dashboard, recording, editing) |
| shared-types | `packages/shared-types/` | TypeScript types (`@certmate/shared-types`) |
| shared-utils | `packages/shared-utils/` | Shared utilities (`@certmate/shared-utils`) |

## Quick Commands

### Development

```bash
npm start                          # Backend (port 3000)
npm run dev --workspace=web        # Web (port 3001)
```

### Testing

```bash
npm test                           # Backend tests
npm test --workspace=web           # Web tests
```

### Linting

```bash
npm run lint                       # ESLint
npm run format                     # Prettier
```

### Deploy

Push to `main` → GitHub Actions runs tests, builds ARM64 Docker images, pushes to ECR, deploys to ECS (~30 min end-to-end). Monitor: https://github.com/derek570/EICR-/actions

Local quick-deploy (bypasses CI): `./deploy.sh` (web) / `./deploy.sh --backend` (web + backend).

iOS TestFlight: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`.

> Full details: [docs/reference/deployment.md](docs/reference/deployment.md) (AWS), [docs/reference/deploy-testflight.md](docs/reference/deploy-testflight.md) (iOS)

### Check Status

```bash
aws ecs describe-services --cluster eicr-cluster-production --services eicr-frontend eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
gh run list --limit 5
```

## iOS Recording Pipeline (v3)

```
iOS (16kHz PCM) -> DeepgramService (direct Nova-3 WS)
    -> transcript -> NumberNormaliser -> TranscriptFieldMatcher (instant regex)
    -> ServerWebSocketService (wss://backend/api/sonnet-stream) + regex hints
    -> Backend: multi-turn Sonnet 4.5 extraction (with regex context)
    -> results + questions + cost updates back to iOS
```

**Field priority (3-tier):** Pre-existing (CCU/manual) > Sonnet > Regex
**Dual extraction:** Regex provides instant ~40ms field fill; Sonnet overwrites with higher accuracy 1-2s later. Regex hints (field names only) sent to backend as Sonnet context.

> Full details: [docs/reference/ios-pipeline.md](docs/reference/ios-pipeline.md)

## AWS Configuration

> Replace `<ACCOUNT_ID>` with your AWS Account ID.

| Resource | Value |
|----------|-------|
| Region | eu-west-2 (London) |
| Domain | certomatic3000.co.uk |
| ECS Cluster | eicr-cluster-production |
| ECR Backend | `<ACCOUNT_ID>`.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend |
| RDS Database | eicr-db-production.cfo684yymx9d.eu-west-2.rds.amazonaws.com |
| Backend Memory | 2048 MB / 512 CPU |

> Full table: [docs/reference/architecture.md](docs/reference/architecture.md)

## Environment Variables

Cloud keys loaded automatically from AWS Secrets Manager: `eicr/api-keys` (all API keys as a single JSON object) and `eicr/database` (DB credentials). No local `.env` needed for cloud deploys.

> Full details: [docs/reference/architecture.md](docs/reference/architecture.md#environment-variables)

## Certificate Types

- **EICR** - Electrical Installation Condition Report (periodic inspection)
- **EIC** - Electrical Installation Certificate (new installations)

## Commit Rules
- **Auto-commit after every logical unit of work.** Do NOT wait for the user to ask — commit immediately when a meaningful change is complete (a bug fix, a feature addition, a refactor, a config change, etc.). Multiple small commits are always better than one large commit.
- **Commit messages must be detailed and explain the WHY, not just the WHAT.** Every commit message should answer:
  1. **What** changed (a brief summary line)
  2. **Why** the change was needed (what problem existed, what was broken, what feature was missing)
  3. **Why this approach** (why the code is written the way it is — design decisions, trade-offs, alternatives considered)
  4. **Context** — flag any deliberate UI/layout decisions, note if a change fixes a problem caused by a previous refactor, mention if a pattern was chosen for consistency with existing code
- Use multi-line commit messages: a short subject line, then a blank line, then a detailed body paragraph.
- If a change touches multiple concerns, split into separate commits — one per concern.
- Never batch unrelated changes into a single commit.

## Development Notes

- All Node.js uses ES modules (`"type": "module"` in package.json)
- Backend routes split into 14 modules in `src/routes/`
- Route registry: `src/api.js` (197 lines) mounts all routes + legacy aliases
- API documentation: Swagger UI at `/api/docs`
- Pre-commit hooks: eslint + prettier via lint-staged, secrets detection
- Pre-push hooks: full test suite

## Reference Documentation

Detailed docs split into focused reference files:

| Document | Contents |
|----------|----------|
| [architecture.md](docs/reference/architecture.md) | Tech stack, containers, AWS config, environment vars, AI models, costs |
| [ios-pipeline.md](docs/reference/ios-pipeline.md) | Recording pipeline v3, debug runbook (7-step), S3 paths, common issues |
| [field-reference.md](docs/reference/field-reference.md) | All UI fields (29 circuit columns), CSV mapping, field schema, sync rules |
| [deployment.md](docs/reference/deployment.md) | AWS deploy commands, cloud status, troubleshooting |
| [deploy-runbook.md](docs/reference/deploy-runbook.md) | Quick AWS ECS deploy reference (env, secrets, steps) |
| [deploy-testflight.md](docs/reference/deploy-testflight.md) | iOS TestFlight deploy script, ASC credentials, onnxruntime patch |
| [vad-investigation.md](docs/reference/vad-investigation.md) | Dated journal: VAD sleep/wake investigation + hybrid VAD decisions |
| [changelog.md](docs/reference/changelog.md) | Verbatim commit-body-level changelog (full history beyond hub summary) |
| [file-structure.md](docs/reference/file-structure.md) | Directory tree, key files |
| [deployment-history.md](docs/reference/deployment-history.md) | Implementation phases 1-8, resolved items archive |
| [DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) | Full developer setup guide (all platforms) |
| [ADRs](docs/adr/README.md) | Architecture Decision Records (7 ADRs) |
| [OpenAPI](docs/api/openapi.yaml) | OpenAPI 3.1 spec (served at /api/docs) |

## Documentation Sync Rules

When modifying UI fields: update `config/field_schema.json` + [field-reference.md](docs/reference/field-reference.md). When adding extractable fields to Sonnet: (1) add to prompt in `eicr-extraction-session.js`, (2) add case in `applySonnetReadings()`, (3) add keyword boosts in `default_config.json`.

> Full sync checklist: [docs/reference/field-reference.md](docs/reference/field-reference.md#keeping-this-documentation-in-sync)

## Current Focus / Active Work

- **CCU single-shot retired — branch `ccu-drop-single-shot` (2026-04-29)**, 5 commits, ready for review/merge. Single-shot Sonnet (130-line, 46 s, $0.06) replaced by an extended classifier returning board metadata (5 s, $0.01). Stage 2 prompt slimmed to rail-bbox-only; Stage 2 `main_switch_*` fields dropped (CV pitch is more reliable). SPD presence now derived from Stage 3. Expected wall-clock ~21 s (~2× faster) and cost ~$0.04 (~60 % cheaper). 2391 tests green. iOS API contract unchanged. Failures now 502 instead of falling back to single-shot.
- **CCU per-slot extraction — SHIPPED 2026-04-22** via 10 commits fast-forwarded onto `main` (HEAD `613d54b`). Crop-and-classify VLM pipeline is the primary source of `circuits[]` for `/api/analyze-ccu`. Full details in [docs/reference/architecture.md#ccu-photo-extraction-pipeline](docs/reference/architecture.md#ccu-photo-extraction-pipeline).
- **Web rebuild shipped to production 2026-04-18** via PR derek570/EICR-#1 (merge commit `9202351c`). `web-rebuild` merged into `main`; branch retained for reference. certmate.uk now serves the Next 16 / React 19 / PWA client from `web/`; `eicr-pwa` + `eicr-backend` ECS services updated (task defs `eicr-pwa:30`, `eicr-backend:27`), smoke tests green.
- Deepgram auto-sleep (3-tier Active/Dozing/Sleeping) + server-side Sonnet v3 multi-turn — live in production.
- Next candidates: debounced-save flush wiring `queueSaveJob` into JobProvider's save path (outbox is plumbed but has no production caller yet); Playwright E2E coverage for offline-sync flows.

## Changelog

Recent changes (one line each). Full commit-body-level detail in [docs/reference/changelog.md](docs/reference/changelog.md); use `git log` for everything else.

| Date | Summary |
|------|---------|
| 2026-04-30 | **Prod hotfix: CCU extraction failing for every user with "Unexpected non-whitespace character after JSON at position 70".** Production was returning 502 to iOS on every `/api/analyze-ccu` request (observed against a Wylex NHRS12SL retried 7+ times in ~7 min). Stage 2's VLM was emitting its primary `{"rail_bbox":{...}}` object plus trailing content (whitespace + a second JSON object — likely a follow-up `{"main_switch_center_x":...}` block from prior prompt conditioning even though those fields were dropped from the schema in `84dc97e`). The old `extractJson` in `src/extraction/ccu-geometric.js` sliced from first `{` to last `}` and handed both objects to `JSON.parse`, which threw at position 70 — the start of the second concatenated object. With single-shot retired (`3087553`) the per-slot pipeline is the only path, so a parser failure now bubbles up as 502 with no safety net. **Fix:** replaced the brace heuristic with a balanced-brace walk that tracks string + escape state and stops at the matching close brace, ignoring all trailing content. Also accepts a bare ` ``` ` fence (not just ` ```json `) and includes a truncated raw-text excerpt in any future parse error so the next failure is self-diagnosing. The same brittle slice in `classifySlots`'s array parser was replaced by the shared `extractJson` walker. Added a regression test that feeds the exact production failure shape (object + `\n\n` + second object); reproduces the V8 error on the old code. 44/44 ccu-geometric tests + 157/157 CCU tests green. |
| 2026-04-29 | **CCU pipeline cleanup — legacy Stage 2 path retired** (branch `ccu-drop-single-shot`, follow-up commit). Now that tighten-and-chunk has been the sole runtime path for a day, the legacy `populated_area_start_x` / `populated_area_end_x` Stage 2 prompt + body have been deleted (`MODULE_COUNT_PROMPT` constant, the dispatch `if (isCcuStage2GroupsEnabled())`, and ~280 lines of populated-area chunking logic). The `getModuleCountFromGroups` function was renamed back to `getModuleCount` (no disambiguation needed). `CCU_STAGE2_GROUPS` env var retired (no longer read anywhere — removed from task-def is a follow-up deploy task). Dead return fields dropped: `mcbGroups`, `upstreamRcds`, `populatedAreaStartX/EndX`, `stage2Source`. `lowConfidence` now also surfaces Stage 2's CV-vs-bbox count drift gate (was previously orphaned). Net: −359 lines, 2407 tests green. |
| 2026-04-29 | **CCU single-shot Sonnet retired; per-slot is the only path** (branch `ccu-drop-single-shot`, 5 commits). 2026-04-29 production audit on a Wylex NHRS12SL showed total wall-clock 47.1 s with single-shot the long pole at 46.5 s — running in parallel with the per-slot pipeline only to produce 5 board-level metadata fields the per-slot pipeline didn't already cover. Extended `classifyBoardTechnology` (`src/routes/extraction.js`) prompt+parser to also return `board_manufacturer`, `board_model`, `main_switch_rating`, `spd_present` (max_tokens 200→400, ~5 s, ~$0.01). Dropped `main_switch_width` + `main_switch_center_x` from the Stage 2 `MODULE_COUNT_PROMPT_GROUPS` (CV-based pitch detection has been more reliable than the VLM's main-switch estimate since 2026-04-29; the prod cross-check disagreement was 42-67 % every retry). Pitch cross-check rewritten to compare CV's own `moduleCountFromCv` against bbox-derived `moduleCount` (lowConfidence on drift > 1). Ripped out the 130-line single-shot prompt + `singleShotPromise` + AbortController + JSON parser + max-tokens handler + `CCU_GEOMETRIC_V1` kill switch. `analysis` now built directly from classifier output + `slotsToCircuits` over Stage 3/4 merged slots. SPD presence promoted to Stage 3 authority (any `cls === 'spd'` slot). `mainSwitchSide` chain rewritten — Stage 3 `main_switch` slot index → rewireable `mainSwitchOffset` → Stage 1 `mainSwitchPosition`. New `extraction_source: "classifier-only"` for Stage 3/4-empty fallbacks. Failures in classifier or `prepareGeometry` now return 502 (no safety net). Expected wall-clock ~21 s (Stage 4 long pole), cost ~$0.04 vs ~$0.10. iOS API contract unchanged — same response keys. 2391 tests green. |
| 2026-04-22 | **CCU per-slot crop-and-classify shipped to prod** (main HEAD `613d54b`, CI run `24805037373`). 10 commits fast-forwarded: `94bf88d` rewireable pipeline module → `ab195b0` main-switch force-tag → `1301110` route-handler wiring → `dba8098` architecture docs → `54ab93b` merger unit tests → `778e907` Stage 4 label pass + drop single-shot fallback in merger → `1ba46e4` label-confidence gate → `11f40e4` rewireable reliability pass (Stage 1 samples 3→5, Stage 2 retry, Stage 3 crop 1024→1536 + colour disambiguation) → `f2e304d` Codex P1+P2 fixes (modern coord space, `mainSwitchOffset` inline-edge numbering, post-merge enrichment) → `613d54b` Stage 3/4/classifier/single-shot parallelism (~10-15s + ~3s saved). 464 tests passing. Cost ~$0.10-0.12/extraction (3-4% of £3/cert margin). iOS TestFlight companion on main `f812061` — adds `slots[]`, `extraction_source`, `boardTechnology` decoding on FuseboardAnalysis. Reviews: Claude (`.planning/ccu-per-slot-claude-review.md`) + Codex (`.planning/ccu-per-slot-codex-review.md`). Training-data-loop plan at `.planning/ccu-review-training-loop-plan.md`. Stage 6 kept out of this deploy as requested. |
| 2026-04-22 | **CCU extraction — per-slot crop-and-classify primary (branch `ccu-per-slot-primary`, superseded above).** `/api/analyze-ccu` runs a cheap `board_technology` classifier first (~3s, ~$0.01), routes to either the existing DIN-rail-targeted `extractCcuGeometric` or the new bakelite-carrier `extractCcuRewireable` (`src/extraction/ccu-geometric-rewireable.js`, 820 lines, 31 unit tests). Both return per-slot classifications; a new `slotsToCircuits` merger builds `circuits[]` from Stage 3 slots, using single-shot's labels by circuit number, with per-slot confidence fallback (<0.7 → defer to single-shot at that position). Stage 3 output was previously computed-then-dropped (Phase C never wired) — this sprint made it authoritative. Verified E2E on the 2026-04-22 Wylex photo: pre-fix single-shot returned 5 circuits with Shower on the wrong carrier; new pipeline returns 6 circuits with all ocpd_type="Rew" / ocpd_bs_en="BS 3036". Flag `CCU_GEOMETRIC_V1` defaults ON; set to "false" on the task-def to kill-switch back to pure single-shot. Cost: ~$0.03 → ~$0.08-0.09 per extraction (1.5-2.5% of £3/cert margin). Three commits: `94bf88d` rewireable module, `ab195b0` main-switch force-tag fix, `1301110` route handler. iOS `FuseboardAnalysis` gains `slots[]` + `extraction_source` decoding (additive, no UI wiring yet — tap-to-correct grid is future iOS work). Sprint plan: `.planning/ccu-per-slot-sprint.md`. |
| 2026-04-22 | **CCU extraction — rewireable fuse board support (shipped prod, commit `8da2292`).** Single-shot CCU prompt in `/api/analyze-ccu` previously forced every position into MCB/RCBO and rejected BS 3036 rewireable fuses. Added board_technology classification (Step 1b), per-position fuse-carrier branch (Step 2b, colour→rating mapping white/blue/yellow/red/green), and widened output schema to accept `ocpd_type: Rew\|HRC` + `ocpd_bs_en: BS 3036\|BS 1361\|BS 88-2`. `BS_EN_LOOKUP` gets `REW → BS 3036` fallback. `field_schema.json` `ocpd_type` options aligned with iOS `Constants.swift`. iOS `FuseboardAnalysis` gets `boardTechnology` decode field (commit `4bed04a` on `stage6-agentic-extraction`). CI run `24799705740` green. |
| 2026-04-19 | **Prod fix: web recording failed with "Deepgram WebSocket error".** Backend mints Deepgram credentials via `/v1/auth/grant` (JWT access tokens) as of `248953b` (2026-04-18, P0-10 — master-key fallback was correctly removed). The web client (`web/src/lib/recording/deepgram-service.ts:107`) was still advertising `['token', apiKey]` as the WS subprotocol — that scheme is valid only for raw master API keys; Deepgram 401s the upgrade for JWTs and browsers surface it as a generic `WebSocket error` with no body. iOS already fixed this path (`DeepgramService.swift:228-230` comment: "JWT+Token=401, JWT+Bearer=connected"). Fixed by switching the subprotocol to `['bearer', apiKey]` and expanding the comment block at the call site so the next migration can't re-trip it. The 2026-03-31 hotfix `550278e` (return master key directly) masked this; correctly removing that bypass in `248953b` re-surfaced it on web. `jest-websocket-mock` echoes any subprotocol the client offers, so the 15 existing deepgram-service tests still pass without change. |
| 2026-04-19 | **Prod hotfix #2: same PWA login bounce, recurrence.** Local `./deploy.sh` re-registered `eicr-pwa` from `ecs/task-def-frontend.json` (revs 33 & 34) — the morning's fix only lived in the registered task def, not in the source template, so the secret was dropped again. Hotfixed live by registering `eicr-pwa:35` = rev 34 + JWT_SECRET. **Permanent fix (commit `9b5b809`):** added the `secrets: [JWT_SECRET]` block to `ecs/task-def-frontend.json` itself (shared by `deploy.sh:93` + `.github/workflows/deploy.yml:442`), so every future register-task-definition emits the secret. No CI guard added — template is small, fields stable; revisit if a third regression occurs. |
| 2026-04-19 | **Prod hotfix: PWA login bouncing back to /login.** Rebuilt PWA middleware (Wave 4 D4) HMAC-verifies the JWT and fail-closes when `NODE_ENV=production` AND `JWT_SECRET` is unset — every authenticated nav 307'd to `/login` with no error. Phase 8 cutover shipped the new middleware but never injected `JWT_SECRET` into the `eicr-pwa` task def (old frontend didn't need it). Fixed by registering `eicr-pwa:32` with a `secrets` entry referencing `eicr/api-keys:JWT_SECRET::`, + attaching inline policy `eicr-exec-secrets-access` to `eicr-ecs-execution-role` granting `secretsmanager:GetSecretValue` on that one ARN (the execution role — which ECS uses for secrets-to-env injection — had no SM perms; the task role did, because backend fetches secrets at runtime from Node). Rollout clean after the IAM add. Pre-flight check added to `deploy-runbook.md`. |
| 2026-04-18 | **Web Phase 8 — production cutover.** PR derek570/EICR-#1 merged `web-rebuild` (154 commits) into `main` (merge commit `9202351c`). CI deploy pipeline built/pushed ECR images, registered ARM64 task defs, force-new-deployment on `eicr-pwa` (rev 30) + `eicr-backend` (rev 27); services-stable + smoke green (certmate.uk/ → 307 /login, /api/health 200, /manifest.webmanifest + /sw.js served). Three pre-flight fixes shipped in the PR: `4b77316` CI `npm run build` (webpack flag via package.json not bare next build), `4cef21f` `output: 'standalone'` in next.config.ts (Dockerfile needs `.next/standalone` to exist), `07f79e6` Next 16 @next/swc platform-binary lockfile patch. **Closes the web rebuild.** |
| 2026-04-18 | Web Wave 2a — test harness (vitest 4 + jsdom + RTL + fake-indexeddb) stood up; D12 ApiError JSON-envelope parsing (lifts `{error: "..."}` to `.message`, preserves `.body`; 401 classifiers switched from regex to `.status`); 32 regression tests (5 suites) backfilling Wave 1 fix surfaces. Wave 2b (D2 adapters) deferred. |
| 2026-04-18 | Web Phase 7d — offline-sync UI (OfflineIndicator pending/failed pills, JobRow Pending chip, `/settings/system` admin page, discard/requeue helpers, BroadcastChannel change notifier). **Closes Phase 7.** |
| 2026-04-17 | Web Phase 7c — offline mutation outbox + replay worker (IDB v2, exp backoff, FIFO). |
| 2026-04-17 | Web Phase 7b — iOS Add-to-Home-Screen hint on `/settings`. **Closes Phase 7b.** |
| 2026-04-17 | Web Phase 7b — AppShell offline indicator (amber pill via `navigator.onLine`). |
| 2026-04-17 | Web Phase 7b — IDB read-through cache (offline dashboard + job detail via `certmate-cache`). |
| 2026-04-17 | Web Phase 7b kickoff — user-initiated SW update handoff (sonner toast + `SKIP_WAITING`). |
| 2026-04-17 | Web Phase 7a — PWA foundation (Serwist, manifest, icons, offline/error boundary, `InstallButton`). |
| 2026-04-17 | Web Phase 6c — system-admin user management. **Closes Phase 6.** |
| 2026-04-17 | Web Phase 6b — company settings + company-admin Jobs/Team/Stats dashboard. |
| 2026-04-17 | Fix `next build` on `/login` (wrap `useSearchParams` in `<Suspense>`). |
| 2026-04-17 | Web Phase 6a — `/settings` hub + Staff (inspector profiles, signatures). |
| 2026-04-17 | Web Phase 5d — LiveFillView (brand-blue flash as Sonnet fields populate). |
| 2026-04-17 | Web Phase 5c — observation photos (auth'd blob fetch, camera+library pickers). |
| 2026-04-17 | Web Phase 5b — document extraction on Circuits tab (`/api/analyze-document`). |
| 2026-04-17 | Web Phase 5a — CCU photo capture + GPT Vision on Circuits tab. |
| 2026-04-17 | Start ground-up web rebuild on branch `web-rebuild`. Phase 0: Next 16 + React 19 scaffold. |
| 2026-03-04 | Add `/api/analyze-document` (GPT Vision for EICR/EIC fields from photos/PDFs). |
| 2026-02-28 | Raise `COMPACTION_THRESHOLD` 6000→60000 — preserves Sonnet's conversational context. |
| 2026-02-23 | Compaction cost guards (5 checks) + `max_tokens` 2048→4096 + 120s rate limit. |
| 2026-02-23 | Fix audio loss during VAD warm-up; add `/api/health/ready`; iOS pre-flight check. |
| 2026-02-23 | CCU prompt v2 (4-step methodology, RCD waveforms, device-face amp enforcement). |
| 2026-02-22 | 5-star Phase 8: OpenAPI spec, Swagger UI, pre-commit hooks, ADRs. |

Older entries (before 2026-02-22) are in [docs/reference/changelog.md](docs/reference/changelog.md) and `git log`.

## Future Plans

- Evaluate replacing server-side Python PDF generation with Playwright-only approach
- CCU photo analysis: evaluate newer models as they become available
- Expand E2E test coverage

## iOS Deploy (TestFlight)

See [docs/reference/deploy-testflight.md](docs/reference/deploy-testflight.md) for the deploy script, ASC credentials, TestFlight group IDs, and the onnxruntime `MinimumOSVersion` patch.
