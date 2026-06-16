# EICR-oMatic 3000

> **MANDATORY — Every code change must update docs and be committed.**
> - Changed a pipeline step, field, or architecture? Update the matching [reference file](docs/reference/).
> - Hub CLAUDE.md is an **index only** — add detail to reference files, not here.
> - Add a row to the [Changelog](#changelog) for any user-facing or architectural change.
> - Delete stale content rather than commenting it out. Keep every file under its target line count.
> - **Commit automatically after each logical unit of work — do NOT wait to be asked.** Small, focused commits with detailed messages explaining both what changed and WHY the code exists.

> **MANDATORY — Backend (`src/`, `config/prompts/`, `packages/shared-types`, `packages/shared-utils`, RDS, S3) is SHARED with iOS and IMMUTABLE during PWA-only work.**
> - PWA bug fixes / parity work / UI tweaks land in `web/` ONLY. Do NOT touch `src/`, `config/prompts/*.md`, or shared-types/shared-utils without an explicit cross-platform mandate.
> - **Why:** iOS already runs against the current backend shape; any backend change risks iOS regression and a TestFlight cycle. iOS is canon for the data contract.
> - **How to apply:** before editing anything outside `web/`, stop and ask: "is this fix changing behaviour that iOS sees?" If yes, surface it to the user before touching it. If a PWA gap really cannot be closed without a backend change, escalate — do not bundle a backend tweak into a PWA fix.
> - **Pure-frontend state** (anything that doesn't traverse the WS / HTTP boundary) is not covered by this rule.

> **MANDATORY — Infrastructure changes must come from source.**
> - If a fix requires editing an ECS task definition, IAM policy, secret, env var, or any other live AWS resource, the canonical change goes into the corresponding source-controlled file (`ecs/task-def-backend.json`, `ecs/task-def-frontend.json`, `.github/workflows/deploy.yml`, etc.) AND is committed in the same session.
> - **Direct `aws ecs register-task-definition`, AWS console edits, or any out-of-band CLI action is never the canonical change.** At most it's an emergency stopgap, and MUST be followed by a source commit before the session ends. If you're tempted to apply something live without a commit, stop and update the source instead.
> - **Why:** any subsequent CI deploy re-registers the task def from the source template. Live-only fixes get silently dropped on the next deploy, with no warning. This has bitten us twice — `CCU_DEWARP_OUTPUT_WIDTH=2048` (2026-05-13, dropped 2026-05-14) and `JWT_SECRET` (2026-04-19, see changelog). Both cost field-test time + a re-investigation that traced the regression back to a missing commit.
> - **How to apply:** before running any `aws ecs ...`, `aws iam ...`, or AWS-console mutating action, ask: "does this change persist to source?" If no, stop and fix the source first. If yes, run it AND commit the source change.
> - **Guardrail:** `scripts/check-task-def-env-drift.sh` runs in CI before every `register-task-definition` call and fails the deploy if any env var exists on the live task def but not in the source template. Bypass via `[skip-drift-check]` in the commit message only for emergencies, and follow up with a real source commit immediately after.

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

**ALWAYS deploy via GitHub Actions.** Push to `main` → CI runs tests, builds ARM64 Docker images, pushes to ECR, deploys to ECS (~30 min end-to-end). Monitor with `gh run watch <run-id> --exit-status` (single long-poll connection — no polling). Run history: https://github.com/derek570/EICR-/actions

**Auto-push backend to `main` at the end of a work session — do NOT wait to be asked.** When backend changes are committed locally on `main` (or a feature branch that has been merged via PR) and `npm test` is green, push to `origin/main` automatically before wrapping up. CI handles the rest.

**When NOT to auto-push:**
- `npm test` is failing — fix first; do not ship red.
- The work is on a feature branch awaiting PR / review.
- A pre-push hook (e.g. secrets scan, full test suite) fails — investigate; do not bypass with `--no-verify`.
- The user explicitly said "don't push" for THIS task.
- Schema / migration changes that need coordination with an iOS TestFlight cycle — push the backend FIRST and wait for ECS rollout (`gh run watch`) before kicking off iOS auto-push, so iOS hits a backend with the new shape live.

Default is auto-push; the exclusions above are the only reasons to hold.

Do **not** use the local `./deploy.sh` quick-deploy script even though it exists in the repo. Docker Desktop is not kept running on the dev Mac, so the script fails immediately, and its `tee`-wrapped invocation masks the failure as exit 0. CI is the only deploy path that works reliably.

iOS TestFlight: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh` — same auto-push-at-end-of-work policy applies; see `CertMateUnified/CLAUDE.md` § TestFlight Deployment.

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
| Domain | certmate.uk |
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

- **⚡ CCU pipeline (live):** single-shot `gpt-5.5` over the whole image via `src/extraction/ccu-single-shot.js`. **No per-slot cropping.** Stage-3/Stage-4 per-slot pipeline (`ccu-geometric.js`, `ccu-label-pass.js`) is LEGACY FALLBACK only, gated behind `CCU_USE_SINGLE_SHOT=false`. In-scope failure modes: gpt-5.5 mis-counts in long identical-MCB runs, label-column mis-alignment, post-merge enrichment overrides, `slotsToCircuits` phase-walking heuristics. NOT in scope: CV crop accuracy / slot crop boundaries (not in live path). Full details: [docs/reference/architecture.md#ccu-photo-extraction-pipeline](docs/reference/architecture.md#ccu-photo-extraction-pipeline).
- **Web rebuild in production** since 2026-04-18 (PR #1, merge `9202351c`). certmate.uk serves Next 16 / React 19 PWA client from `web/`.
- **Live in production:** Deepgram auto-sleep (3-tier Active/Dozing/Sleeping), server-side Sonnet v3 multi-turn extraction.
- **Next candidates:** wire `queueSaveJob` into JobProvider's save path (outbox plumbed, no production caller yet); Playwright E2E coverage for offline-sync.
- **PARKED 2026-05-28:** PWA observation-photo auto-link sprint (Phases 3–6, 4 commits + 33 tests) on `origin/pwa-observation-photo-autolink-2026-05-13`. Awaiting rebase against post-2026-05-13 main (heavy collision in `web/src/lib/recording-context.tsx`). Playbook: [.planning-stage6-agentic/handoffs/pwa-observation-photo-autolink-2026-05-13/HANDOFF.md](.planning-stage6-agentic/handoffs/pwa-observation-photo-autolink-2026-05-13/HANDOFF.md).
- **OPEN FOLLOWUP 2026-06-05 — voice-latency Phase 2.2 (deferred from PR #52, merged).** Surface proactively on any voice-latency or field-test discussion. Pick server `FINALIZER_TIMEOUT_MS` widen vs iOS Apple-native `local_fallback` emit once 1–2 field sessions hit the deployed code. Runbook: [CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md](../CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md).

## Changelog

Recent changes — one line each. **Full commit-body-level detail in [docs/reference/changelog.md](docs/reference/changelog.md)**; use `git log` for everything else.

| Date | Summary |
|------|---------|
| 2026-06-16 | Voice-feedback fixes (field session F1AC26FB, 5 markers, /rp→/ep, 6 backend commits — PR #55): `LIM` now a first-class IR sentinel (`megaohms.js` parser + legacy twin + IR-field coercion) + per-slot no-progress cap in `engine.js` closing the IR re-ask loop (repeat of 2026-02-18); designation filler-strip (`stripDesignationFiller`) + clean retry echo in the dialogue engine; `implausible_circuit_ref` guard in `validateCreateCircuit` (stops scratch circuit 999); `sub_main_cable_csa` dispatcher guard on single-board jobs; shared-prompt tails + swap/reorder + earthing-garble steering. iOS companion (Defect #1 feedback dual-route + 20s capture timeout + loosened earthing regex) on CertMateUnified PR #17. `[contract]` #3.4 (designation not crossing wire) + #5.3 (atomic swap tool) deferred. |
| 2026-06-12 | PUT board-hierarchy gate rearchitected: invalid hierarchies are now deterministically REPAIRED (cleared dangling pointers, demoted duplicate mains) + persisted + echoed as `hierarchy_repairs`, never rejected — the reject gate had made job_1778443465217 permanently unsyncable for a week. Strict validation stays on the interactive add_board path. `repairBoardHierarchy` in `board-hierarchy-validator.js`. |
| 2026-06-12 | Voice-feedback fixes (session 15B88D6B, 4 field reports + /rp-style retrospective review, 11 backend commits): gate cert-identity weak triggers + 2-word identity threshold (`pre-llm-gate.js`, mirrored on iOS) so spoken client-name corrections forward; bonding check-field PASS coercion + `bonding_conductor_continuity` mirror derivation + early-terminate parity fix; `rename_circuit` `source_not_found` recovery hint; prompt MAIN PROTECTIVE BONDING + MERGED/STUTTERED NAMING sections. Companion iOS commits `27ca1d2`..`06376de`. |
| 2026-06-04 | iOS Fix D (`a62000e` + `b54cb75`) — voice path reconciled with backend Fix B's `spd_*` canonicalisation; legacy `main_fuse_*` aliases dropped from `applySonnetReadings`; supply-side regex split SPD-vs-main-switch. iOS-only. |
| 2026-06-03 | Voice fix (PR #47, three F03B590C defects): FIELD-AMBIGUITY menu dropped, `"main fuse"` routes to `spd_*`, speculator skips off-enum round-1 synth. 4459 backend tests. |
| 2026-05-31 | Voice fix: RCBO walk-through "BS number?" loop closed via unconditional mirror derivation + Deepgram-garble defer triggers. Commits `104735e2` + `684d7ffa`. |
| 2026-05-31 | Voice fix: RCD focus loop swallowed observations + blocked "later" defer. Engine observation guard + dialogue-script gate bypass. Commits `45662e0c` + `4725afbb`. |
| 2026-05-29 | Prod fix: `cert_attestations` table missing in prod — migrations 010/011 never applied. Permanent fix: CI-gate Fargate one-off task runs `node-pg-migrate up` before every service update. |
| 2026-05-28 | Voice latency: widened early-terminate predicate + Loaded Barrel `onToolUseStreamed` to cover `record_board_reading` (~500-1000 ms pre-synth lead recovered). Commits `ba7d8e21` + `b604e7a6`. |
| 2026-05-28 | PWA fix: Circuits tab silently empty for legacy single-board jobs. Shared `isUnscopedBoardId(id)` helper across 8 call sites treats `null`/`undefined`/`''` as unscoped. |
| 2026-05-27 | Prod data-corruption fix: address etc. silently flipping to `[REDACTED]` on every job open. `redactPiiInPlace` in `src/logger.js` was mutating the live ref; rewritten copy-on-write (`5bf304ac` + `d5adb2e3`). |
| 2026-05-22 | CCU dewarp output width restored to 2048-fixed (env-var regression dropped by next CI deploy). Default moved into `src/extraction/ccu-single-shot.js`; `scripts/check-task-def-env-drift.sh` wired into CI. Commit `01c081e`. |
| 2026-05-20 | CCU single-shot prompt hardened: explicit vertical-column rule, tie-break to null, multi-slot label rule. Architecture docs corrected to describe live 2026-05-08+ pipeline. |
| 2026-05-13 | PWA `observation_confirmation` brought to iOS parity — AlertCard render dropped, voice-answer auto-dismiss, 500 ms client burst buffer. Commit `34e3972`. |
| 2026-05-09 | `ask_user.context_field` enum widened to full union of circuit/board/supply/installation fields + sentinels. Unblocks sub-board creation focus-asks. |
| 2026-05-07 | Multi-board sprint Phases 2a + 4a — CSV header round-trip (`ddde287`); recording.js single-board scope warning (`7e588c8`). |
| 2026-05-07 | Multi-board sprint Phase 4 — `/api/analyze-ccu` board attribution + iOS `.addNewBoard` extraction mode. `a40a9f3` + iOS `f9902cd`. |
| 2026-05-07 | Multi-board sprint Phase 3 — PDF sub-main section (iOS-only) at `EICRHTMLTemplate.swift`. Commit `df4311c`. |
| 2026-05-07 | Multi-board sprint Phase 2 — backend schema parity + `board-hierarchy-validator.js`. `1059f39` / `ebb6183` / `ef56e25` / `c21820b`. |
| 2026-05-07 | Multi-board sprint Phase 1 — `sub_main_cable_length` dropped from iOS `BoardInfo` (not required by BS 7671). Commit `723b3f3`. |
| 2026-05-06 | BS-EN canonical aligned to Option B (prefixed form, no `-1` suffix) across schema/lookup/parser/picker/migration. Backend `4611a2e`; iOS `d4d6db1`. |
| 2026-05-06 | Chitchat pause — backend stops forwarding after 10 zero-engagement turns; four wake triggers + 30 s replay buffer. Backend `b0d977a` / `c580f42` / `663c135`; iOS `f6a29f0`. |
| 2026-05-06 | Stage 6 BS-code parser gains Lev-1 fuzzy fallback to break OCPD/RCD re-ask loop. Commit `c36f75a`. |
| 2026-04-30 | Prod hotfix: CCU extraction 502 on every request — `extractJson` brace heuristic choked on concatenated VLM JSON. Replaced with balanced-brace walker. 44/44 ccu-geometric + 157/157 CCU tests green. |
| 2026-04-29 | CCU pipeline cleanup — legacy Stage 2 path retired (branch `ccu-drop-single-shot`). `populated_area_*` Stage 2 prompt + body deleted; `CCU_STAGE2_GROUPS` env var retired. −359 lines, 2407 tests. |
| 2026-04-29 | CCU single-shot Sonnet retired; per-slot is the only path. `classifyBoardTechnology` extended to cover 5 board-level metadata fields. Wall ~21 s vs 47 s; cost ~$0.04 vs $0.10. 2391 tests. |
| 2026-04-22 | CCU per-slot crop-and-classify shipped to prod (HEAD `613d54b`, CI `24805037373`). 10 commits including rewireable pipeline + Stage 4 label pass + Codex P1+P2. iOS companion `f812061`. 464 tests. |
| 2026-04-22 | CCU per-slot primary (`ccu-per-slot-primary`, superseded above). `slotsToCircuits` merger over Stage 3 slots; flag `CCU_GEOMETRIC_V1` defaults ON. Commits `94bf88d` + `ab195b0` + `1301110`. |
| 2026-04-22 | CCU extraction — rewireable fuse board support (`8da2292`). board_technology classification + per-position fuse-carrier branch (BS 3036). |
| 2026-04-19 | Prod fix: web Deepgram WebSocket subprotocol switched from `['token', apiKey]` → `['bearer', apiKey]` for JWT auth (`248953b` removed master-key bypass). Tests unchanged via jest-websocket-mock echo. |
| 2026-04-19 | Prod hotfix #2: PWA login bounce recurrence — local `deploy.sh` re-registered without `JWT_SECRET`. Permanent fix added secret to `ecs/task-def-frontend.json` (`9b5b809`). |
| 2026-04-19 | Prod hotfix: PWA login bouncing — `JWT_SECRET` missing from `eicr-pwa` task def; added via `eicr-pwa:32` + execution-role IAM grant on the SM ARN. Pre-flight check added to `deploy-runbook.md`. |
| 2026-04-18 | Web Phase 8 — production cutover (PR #1, merge `9202351c`). Three pre-flight fixes: `4b77316` CI build flag, `4cef21f` `output: 'standalone'`, `07f79e6` @next/swc lockfile patch. **Closes web rebuild.** |
| 2026-04-18 | Web Wave 2a — vitest test harness + D12 ApiError JSON-envelope parsing + 32 regression tests. |
| 2026-04-18 | Web Phase 7d — offline-sync UI (pending/failed pills, `/settings/system` admin page, discard/requeue, BroadcastChannel). **Closes Phase 7.** |
| 2026-04-17 | Web Phase 7c — offline mutation outbox + replay worker (IDB v2, exp backoff, FIFO). |
| 2026-04-17 | Web Phase 7b — iOS Add-to-Home-Screen hint on `/settings`. **Closes Phase 7b.** |
| 2026-04-17 | Web Phase 7b — AppShell offline indicator. |
| 2026-04-17 | Web Phase 7b — IDB read-through cache (`certmate-cache`). |
| 2026-04-17 | Web Phase 7b kickoff — SW update handoff (sonner toast + `SKIP_WAITING`). |
| 2026-04-17 | Web Phase 7a — PWA foundation (Serwist, manifest, icons, offline boundary, `InstallButton`). |
| 2026-04-17 | Web Phase 6c — system-admin user management. **Closes Phase 6.** |
| 2026-04-17 | Web Phase 6b — company settings + company-admin dashboard. |
| 2026-04-17 | Fix `next build` on `/login` (wrap `useSearchParams` in `<Suspense>`). |
| 2026-04-17 | Web Phase 6a — `/settings` hub + Staff. |
| 2026-04-17 | Web Phase 5d — LiveFillView (brand-blue flash). |
| 2026-04-17 | Web Phase 5c — observation photos (auth'd blob fetch, camera+library pickers). |
| 2026-04-17 | Web Phase 5b — document extraction on Circuits tab. |
| 2026-04-17 | Web Phase 5a — CCU photo capture + GPT Vision on Circuits tab. |
| 2026-04-17 | Start ground-up web rebuild on `web-rebuild`. Phase 0: Next 16 + React 19 scaffold. |
| 2026-03-04 | Add `/api/analyze-document` (GPT Vision for EICR/EIC fields from photos/PDFs). |
| 2026-02-28 | Raise `COMPACTION_THRESHOLD` 6000→60000 — preserves Sonnet's conversational context. |
| 2026-02-23 | Compaction cost guards (5 checks) + `max_tokens` 2048→4096 + 120 s rate limit. |
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
