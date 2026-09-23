# EICR-oMatic 3000

> **MANDATORY — Every code change must update docs and be committed.**
> - Changed a pipeline step, field, or architecture? Update the matching [reference file](docs/reference/).
> - Hub CLAUDE.md is an **index only** — add detail to reference files, not here.
> - **This file has a hard budget, enforced by `scripts/check-hub-size.mjs` in CI: 45,000 chars total, 35 changelog rows, 1,600 chars per row.** It is auto-loaded into every session, subagent, `/rp` reviewer and `/ep` run, so its cost is paid per-context. It reached 134 rows / ~180,000 chars (single rows over 11,000) before 2026-08-05 because "index only" was a claim nothing checked. When the guard fails, **move detail into [changelog.md](docs/reference/changelog.md) — never raise the budget.**
> - Add a row to the [Changelog](#changelog) for any user-facing or architectural change. **One line each**, ending with `Full detail: [changelog.md](docs/reference/changelog.md).` — write the full commit-body-level entry there.
> - Delete stale content rather than commenting it out. Keep every file under its target line count.
> - **Commit automatically after each logical unit of work — do NOT wait to be asked.** Small, focused commits with detailed messages explaining both what changed and WHY the code exists.

> **MANDATORY — Backend (`src/`, `config/prompts/`, `packages/shared-types`, `packages/shared-utils`, RDS, S3) is SHARED with iOS and web. Changing it is ALLOWED in any wave — no separate mandate, no permission step. The ONE invariant is that the wave ENDS with every client correct.**
> - **Transient mid-wave breakage on either client is fine.** A wave that leaves one client wrong when the work stops is not. Do not gate a backend change on "but iOS sees this" — ship it, then ship the client half in the same wave.
> - **Never leave a cross-client wave half-shipped when Derek next goes out to inspect.** Backend deploys in ~30 min; iOS needs a TestFlight build he actually installs. Before declaring a wave done, confirm the client halves are on the shipped versions — that check is the whole of the remaining risk.
> - **Capability gates (`board_clear_v1`, `lim_ranged_write_v1`, `low_conf_readback_v1`) are a judgement call, not ceremony.** Reach for one when a wave will realistically end with clients on different versions, or when a new wire shape would confuse an older build. Skip it when both halves ship together — a gate you flip in the same wave is pure overhead.
> - **Why (2026-07-26, Derek — supersedes the 2026-04 freeze):** the old rule froze the backend behind an explicit per-wave mandate because a regression would hit iOS users mid-inspection. **Derek is the only user, and he runs these waves over a weekend and does not touch the app until the whole batch is finished.** The harm the freeze priced in does not exist; the coordination tax it charged on every cross-platform fix was real, and it stranded genuine fixes (feedback id 101 — a bogus `ze` that voice could not clear, persisting into a legally-significant certificate — sat behind an ungranted mandate).
> - **Still binding, and unchanged:** infra changes come from source (separate rule below); `main` is PR-only; iOS remains canon for the DATA CONTRACT when the two clients disagree about shape — that is a design tiebreak, not a permission gate.
> - **Pure-frontend state** (anything that doesn't traverse the WS / HTTP boundary) was never covered by this rule and still isn't.

> **MANDATORY — Infrastructure changes must come from source.**
> - If a fix requires editing an ECS task definition, IAM policy, secret, env var, or any other live AWS resource, the canonical change goes into the corresponding source-controlled file (`ecs/task-def-backend.json`, `ecs/task-def-frontend.json`, `.github/workflows/deploy.yml`, etc.) AND is committed in the same session.
> - **Direct `aws ecs register-task-definition`, AWS console edits, or any out-of-band CLI action is never the canonical change.** At most it's an emergency stopgap, and MUST be followed by a source commit before the session ends. If you're tempted to apply something live without a commit, stop and update the source instead.
> - **Why:** any subsequent CI deploy re-registers the task def from the source template. Live-only fixes get silently dropped on the next deploy, with no warning. This has bitten us twice — `CCU_DEWARP_OUTPUT_WIDTH=2048` (2026-05-13, dropped 2026-05-14) and `JWT_SECRET` (2026-04-19, see changelog). Both cost field-test time + a re-investigation that traced the regression back to a missing commit.
> - **How to apply:** before running any `aws ecs ...`, `aws iam ...`, or AWS-console mutating action, ask: "does this change persist to source?" If no, stop and fix the source first. If yes, run it AND commit the source change.
> - **Guardrail:** `scripts/check-task-def-env-drift.sh` runs in CI before every `register-task-definition` call and fails the deploy if any env var exists on the live task def but not in the source template. Bypass via `[skip-drift-check]` in the commit message only for emergencies, and follow up with a real source commit immediately after.

> **MANDATORY — Web companion required for every client-visible change.**
> - *Every* plan/wave that changes voice UX, wire shapes, or client-visible behaviour MUST contain a **"Web companion"** section: either the web change ships in the same wave, or a dated `web/docs/parity-ledger.md` row **with an owner** + a todo records the deliberate lag. "Deferred with no owner" is not an allowed state.
> - **Why:** the iOS+backend ship loop (field feedback → plan → TestFlight + ECS) had no web step; between 2026-06-17 and 2026-07-01 ~8 voice waves shipped backend+iOS companions and ZERO web companions, leaving MANDATORY audio-first behaviour (universal read-back) dormant for web users. This rule is the WS1 drift-stop of the iOS↔Web Full-Parity Program.
> - **How to apply:** when writing or reviewing a plan, ask "does a web user see this change?" (new wire fields, changed frames, spoken UX, visible behaviour). If yes and the plan has no Web-companion section, add one — or add the dated ledger row + todo — before the plan converges. CI warns on PRs touching files whose ledger rows are >30 days unverified (`scripts/check-parity-ledger.mjs`).

> **MANDATORY — Parallel workstreams over shared test files: re-run `main`'s full suite between merges.**
> - When two or more PRs/workstreams run in parallel and touch OVERLAPPING test files (or the shared test harness — `web/tests/setup.ts`, `web/vitest.config.ts`), do NOT merge each on green-in-isolation. After a merge to `main`, re-run the FULL suite on `main` (backend Jest AND `npm test --workspace=web`) BEFORE the next PR merges.
> - **Why:** WS5 and WS7 both touched the terms tests; each PR was green in isolation, but their interaction only surfaced on the post-merge `main` run — which then SKIPPED the deploy (deploy jobs depend on `Test Frontend` passing). Green-in-isolation ≠ green-after-merge when the shared harness is what changed.
> - **How to apply:** the local gate is `.husky/pre-push` (now runs both suites on a Node warned to match CI's 20 — see [docs/reference/deployment.md](docs/reference/deployment.md) § Local Node version). After any merge into `main` that touched test infra or shared test files, watch the `main` CI run to green before merging the next; if it goes red, fix-forward before the next merge — don't stack.

Automated EICR/EIC certificate creation for electrical inspectors using an iOS-first workflow.

## Project Overview

1. **Photo Capture** - Inspector photographs consumer unit (CCU) via iOS app
2. **CCU Analysis** - GPT Vision extracts circuit data from consumer unit photos
3. **Document Extraction** - GPT Vision extracts certificate data from previous certificates, handwritten notes, or photos
4. **Voice Recording** - Inspector dictates test readings and observations into iOS app
4. **Live Transcription** - Deepgram Flux transcribes speech in real time on BOTH clients (`flux-general-en` on `/v2/listen`, direct WebSocket). Web flipped to Flux in production 2026-07-03 (`ff620997`, `DEEPGRAM_STT_MODEL=flux` runtime kill-switch — nova-3 remains the fail-safe fallback only)
5. **Live Extraction** - Server-side `gpt-6-luna` extracts structured certificate data via multi-turn conversation
6. **Review & Edit** - Inspector reviews populated certificate in iOS app tabs
7. **PDF Generation** - Generate complete EICR/EIC PDF certificates

## Audio-First Design Principles

CertMate is evolving into an **audio-first, hands-free** tool. The inspector works in **AirPods**, walking the installation with the phone pocketed and **no eyes on the screen** — they dictate readings and hear them read back. Treat the spoken channel as the **primary UI**; the on-screen grid is the secondary/visual mirror.

The following are **MANDATORY** product invariants. They override older guidance that optimised for screen-first use or for minimising TTS chatter, and they span both backend (extraction/confirmation synthesis) and iOS (TTS playback):

1. **Every dictated reading is read back aloud — exactly once. Never silently entered into the UI.** A value that only appears on screen is invisible to a hands-free inspector, so every applied reading/correction MUST produce one spoken confirmation. *Exactly once* — not zero (silent entry) and not twice (the double-confirm bug). This holds for ALL apply paths, including client-initiated reassignments, not just server-extraction turns.
   - **Exception (by design):** automatic derivations and side-effect ticks — e.g. polarity auto-ticked from Zs, mirror-derived fields — are computed consequences, NOT dictated readings, and do **not** get a spoken confirmation.
2. **Structurally complete readings are WRITTEN regardless of self-reported confidence, and read back aloud — never silently dropped.** A structurally complete dictated reading (field + circuit/board scope + value) is written at whatever confidence and read back; the inspector verifies by ear and corrects by speaking. Ask ONLY for structural gaps, contradictions, invalid/out-of-range values, or true non-values. The live model is `gpt-6-luna` (Haiku 4.5 when this rule was written; OpenAI since 2026-08-11, `gpt-6-luna` since 2026-09-22), and no live model's self-reported `confidence` has proved a trustworthy gate, so we do NOT gate behaviour on it (`CONFIRMATION_MIN_CONFIDENCE` is now only the loaded-barrel speculator's pre-synth cost gate; the `< 0.5` write decision is a capability-gated PRE-APPLY rollout step in the dispatcher, not a behavioural confidence threshold). This supersedes BOTH the older "suppress low-confidence confirmations to cut noise" stance AND the interim "low-confidence readings ASK" stance — a dropped reading is invisible to a hands-free user.
3. **Latency is a first-class concern.** The dictate→confirm loop is conversational; perceived latency between speaking and hearing the read-back directly shapes usability. Optimise for low perceived latency and treat regressions as bugs, not cosmetics.

## Tech Stack

| Component | Technology |
|-----------|------------|
| iOS App | SwiftUI (CertMateUnified) |
| Transcription | Deepgram Flux `flux-general-en` (`/v2/listen`, direct WebSocket) on BOTH clients — web live since 2026-07-03 via the `DEEPGRAM_STT_MODEL` runtime kill-switch (nova-3 = fail-safe fallback only) |
| Live Extraction | OpenAI `gpt-6-luna` (server-side multi-turn via WebSocket; `SONNET_EXTRACT_MODEL`) |
| CCU Photo AI | GPT Vision (consumer unit analysis) |
| Document Extraction AI | GPT Vision (certificate/notes data extraction) |
| Backend | Node.js (ES modules) — API, WebSocket, S3 |
| PDF (iOS) | WKWebView HTML->PDF (EICRHTMLTemplate.swift) — **iOS app uses this, NOT the server generators** |
| PDF (web) | CLIENT-SIDE since 2026-07-02 (WS9): TS port of the iOS template + foreignObject capture + pdf-lib Blob (`web/src/lib/pdf/`) — **any EICRHTMLTemplate.swift change needs a web-template companion** (ledger row `pdf/pdf-fidelity`) |
| PDF (server) | Python ReportLab + Playwright — **FALLBACK/DEBUG-ONLY** (web "Generate on server (fallback)" action; flips behind the debug page after field validation) |
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

**Auto-DELIVER at the end of a work session — do NOT wait to be asked. Delivery is PR-only: `main` is PR-protected (field-replay corpus gate, 2026-07-16 — Derek's repo-wide PR-only decision).** When changes are committed locally and `npm test` is green, open a PR and merge it via `gh pr merge --merge` after the required checks pass — for EVERY end-of-session delivery, backend AND web-only waves AND docs commits included. Never `git push origin main` directly. CI handles the deploy from the merge.

- Branch from `main`, commit per logical unit, `git push -u origin <branch>`, `gh pr create`, then `gh pr merge <branch> --merge` once `Test Backend (Node.js)` / `Test Frontend (Next.js)` / `npm Audit Security Scan` are green. Watch the post-merge deploy with `gh run watch <id> --exit-status`.
- **Why PR-only now:** the field-replay corpus gate is merge-blocking, and a merge-blocking gate is a `main` branch-protection ruleset — necessarily repo-wide (GitHub has no path-scoped PR enforcement). A direct push would bypass the gate.

**When NOT to auto-deliver:**
- `npm test` (backend Jest) or the web vitest suite is failing — fix first; do not ship red.
- A pre-push hook (secrets scan, full test suite, `replay:field-corpus:prepush`) fails — investigate; do not bypass with `--no-verify`.
- The user explicitly said "don't push/merge" for THIS task.
- Schema / migration changes that need coordination with an iOS TestFlight cycle — merge the backend FIRST and wait for ECS rollout (`gh run watch`) before kicking off iOS auto-push, so iOS hits a backend with the new shape live.

Default is auto-PR-then-merge; the exclusions above are the only reasons to hold.

Do **not** use the local `./deploy.sh` quick-deploy script even though it exists in the repo. Docker Desktop is not kept running on the dev Mac, so the script fails immediately, and its `tee`-wrapped invocation masks the failure as exit 0. CI is the only deploy path that works reliably.

iOS TestFlight: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh` — same auto-push-at-end-of-work policy applies; see `CertMateUnified/CLAUDE.md` § TestFlight Deployment.

> Full details: [docs/reference/deployment.md](docs/reference/deployment.md) (AWS), [docs/reference/deploy-testflight.md](docs/reference/deploy-testflight.md) (iOS)

### Check Status

```bash
aws ecs describe-services --cluster eicr-cluster-production --services eicr-pwa eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
gh run list --limit 5
```

## iOS Recording Pipeline (v3)

```
iOS (16kHz PCM) -> DeepgramService (direct Deepgram Flux WS, flux-general-en /v2/listen)
    -> transcript -> NumberNormaliser -> TranscriptFieldMatcher (instant regex)
    -> ServerWebSocketService (wss://backend/api/sonnet-stream) + regex hints
    -> Backend: multi-turn `gpt-6-luna` extraction (with regex context)
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
| [field-replay-corpus.md](docs/reference/field-replay-corpus.md) | Field-replay correctness gate: captured sessions as a merge-blocking regression corpus (lanes, authoring, gate-state machine, trusted evidence, governance, PII) |
| [deploy-runbook.md](docs/reference/deploy-runbook.md) | Quick AWS ECS deploy reference (env, secrets, steps) |
| [deploy-testflight.md](docs/reference/deploy-testflight.md) | iOS TestFlight deploy script, ASC credentials, onnxruntime patch |
| [pwa-replay-harness.md](docs/reference/pwa-replay-harness.md) | Web-pipeline replay harness: seams, trace, iOS differential, generated field sweep, CI lanes, corpus process |
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

- **⚡ CCU pipeline (live):** single-shot `gpt-6-astra` (since 2026-09-18; `gpt-5.5` before) over the whole image via `src/extraction/ccu-single-shot.js`. **No per-slot cropping.** Stage-3/Stage-4 per-slot pipeline (`ccu-geometric.js`, `ccu-label-pass.js`) is LEGACY FALLBACK only, gated behind `CCU_USE_SINGLE_SHOT=false`. In-scope failure modes: VLM mis-counts in long identical-MCB runs, label-column mis-alignment, post-merge enrichment overrides, `slotsToCircuits` phase-walking heuristics. NOT in scope: CV crop accuracy / slot crop boundaries (not in live path). Full details: [docs/reference/architecture.md#ccu-photo-extraction-pipeline](docs/reference/architecture.md#ccu-photo-extraction-pipeline).
- **Web rebuild in production** since 2026-04-18 (PR #1, merge `9202351c`). certmate.uk serves Next 16 / React 19 PWA client from `web/`.
- **Live in production:** Deepgram auto-sleep retired by DEFAULT since 2026-08-12 (PLAN-C, id 120) — both clients now stream continuously while recording; the retired Sleeping-tier machinery is retained behind a session-latched, default-off `autoSleepEnabled` flag (hidden, no Settings UI) rather than deleted. Server-side Sonnet v3 multi-turn extraction.
- **Next candidates:** Playwright E2E coverage for offline-sync. (`queueSaveJob` IS wired into JobProvider's save path at `web/src/lib/job-context.tsx:159` — verified 2026-07-02; the earlier "no production caller yet" note was stale.)
- **SHIPPED 2026-07-02 (WS2), awaiting iPad field smoke:** PWA observation-photo auto-link — the parked 2026-05-13 branch was rebased onto main and merged. Ledger row `observations/obs-photo-autolink` stays `partial` until the iPad Safari device smoke passes (todo in vault `todos-certmate.md`); two dated deliberate divergences on the row (no CCU picker source — zero-backend; web-extra camera/library chooser).
- **OPEN FOLLOWUP 2026-06-05 — voice-latency Phase 2.2 (deferred from PR #52, merged).** Surface proactively on any voice-latency or field-test discussion. Pick server `FINALIZER_TIMEOUT_MS` widen vs iOS Apple-native `local_fallback` emit once 1–2 field sessions hit the deployed code. Runbook: [CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md](../CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md).

## Changelog

Recent changes — one line each. **Full commit-body-level detail in [docs/reference/changelog.md](docs/reference/changelog.md)**; use `git log` for everything else.

| Date | Summary |
|------|---------|
| 2026-09-23 | **A dictated open circuit is written, not dropped, and speaks as "infinity" (ids 141/142; backend only; ZERO wire/client change).** The ring grammar captured all six forms and the legacy twin wrote `∞`; only the engine's `parseOhms` returned null, so *"Open circuit."* was asked three times and lost. Storing the character is not enough — TTS reads a bare `∞` as silence — so one shared helper speaks it as a word on every read-back path, the cancelled-walk-through one included. The parser accepts a sentinel only as a near-bare or field-qualified answer, narrower than the plan's requested byte-copy of the dead legacy twin, because the engine parses the whole utterance when no field word matched. The prompt rule moves into RING CONTINUITY CARRYOVER and routes ring vs radial instead of listing five fields flat. Also closes one PLAN-A tombstone gap: a model restart with no circuit could walk a handed-off circuit and speak the value twice; it is now refused in the same turn. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-23 | **`ocpd_bs_en` is free text on both clients, and max Zs keys on the standard as well as the type (web + iOS + two `src/export.js` entries).** A `BS 3871` breaker was undictatable, and with legacy type `2` it printed a BS 1361 figure. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-23 | **PLAN-C3 — no silent clear: a blank write is rejected at every model-controlled mutation boundary and the refusal is SPOKEN (backend only; ZERO wire change).** Twice rejected on `BS 3871`, the model wrote `ocpd_bs_en = ""` because the prompt told it to; the dispatcher accepted it and a certificate value emptied with nothing read back. One predicate in a zero-import leaf now rejects an explicit blank on six boundaries (an OMITTED argument still means leave-unchanged), with two imported exemptions so a structural field keeps the refusal that names the route that works. Six new families on the EXISTING notice channel say what the slot STILL holds and survive a cancelled turn, alone among the channel's families. The empty bulk write gets a REPLACEMENT — server-iterated `clear_field_for_all_circuits`, one grouped line — because it existed to stop a truncated 14-circuit burst. `answer_user` journals instead of staging; one pre-finalizer reconciliation makes the spoken outcome independent of emission order, and a staged refusal is authoritative — only `rejection_ref: "unrelated"` co-speaks. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-23 | **PLAN-A — a walk-through hands off on the FIRST miss instead of re-asking, and breaking capacity is recorded rather than gated (ids 140, 141, 143; backend only; ZERO wire/client change).** *"There is no RCBI"* answered *"What RCD type?"*, and the script re-asked twice more before handing the model the bare utterance with no note of the question. The first miss now ENDS the walk for that circuit and gives the model the question, what was captured, non-clearable pre-existing values, and what is still missing with each slot's live acceptance rules. The trigger is the ASKED slot's own outcome, so a compound reply answering a different slot no longer hides the unanswered ask; a session tombstone keyed on ONE board normalisation stops both re-entry paths restarting it. Decision 9 removes the kA ladder — a silent drop plus a re-ask is the dead end Decision 7 forbids — for one spoken advisory on all three read-back producers; Decision 16 replaces it with one researched 21-value `suggestions` list; Decision 17 stops the completion summary re-speaking what the bundler already said. A cross-board walk no longer writes the main board, and a derivation that overwrote a pre-existing value now says what it replaced. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-22 | **`npm run lint` had been failing on its own arguments, and three docs named the wrong model or tier (no runtime change).** The script passed `packages/`, which the ESLint config ignores, so ESLint 9 exited 2 before linting anything — hiding one real error (an undocumented empty `catch` in `src/routes/pdf.js`) since the flat-config migration. CI never ran it. The hub's Audio-First invariant 2 still named Haiku 4.5 as the live model, wrong since 2026-08-11. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-22 | **Live extraction moved to `gpt-6-luna` (infra-from-source + adapter; backend only; ZERO wire/client change).** Half the price of `gpt-5.6-luna` on input and both cache buckets, 2.4x cheaper on output; the route is otherwise untouched. Three model-family tests were too narrow and every one fails SILENTLY — explicit prompt caching, cost rates, usage attribution. Measured on the real endpoint before merge: median turn 4,494 ms to 3,354 ms, corpus cost 55% lower, 12 of 13 fixtures byte-identical. Mechanism corrected later the same day — per API call the models are the SAME speed; Luna 6 wins by generating 50% fewer output tokens and no reasoning tokens at `low`. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-18 | **CCU: an empty way at either end of the rail is counted, and a manufacturer RCD default can no longer overwrite a read from the device (backend only; prompt + lookup policy; ZERO wire/client change).** Derek's second job on Astra "nailed it" except a 10-way Wylex came back as 9: the label strip's way 5 was bare rail before the first breaker, and the prompt never said an empty END way is a blank entry — 3 of 3 re-runs now return 16 modules with the blank first, GE stays exactly 14. Same board: every model read the WRS80/2 RCDs as Type AC and the Wylex manufacturer default (A/medium) overwrote it because single-shot pins slot confidence at 0.92/0.65, below the 0.95 escape — manufacturer defaults are now fill-null only. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-18 | **Job save response frozen at `{success:true}` — a repaired board hierarchy wedged iOS sync (backend only; ZERO wire-shape change for the success case).** Since 2026-06-12 a PUT whose hierarchy was repaired echoed `hierarchy_repairs` + `boards` in the body; iOS decodes that body as `[String: Bool]`, so the decode threw, the job stayed dirty, never fetched again, and re-pushed its stale copy on every save (nine PUTs in three minutes on Derek's two-board job; "the iPad still shows the old values"). Repairs now travel in the `X-Hierarchy-Repairs` header. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-18 | **CCU single-shot model switched to `gpt-6-astra` at reasoning effort `low` (infra-from-source + adapter; backend only; ZERO wire/client change).** Derek's call after a same-photo A/B (2 boards × 3 runs, real prompt, capped crop): gpt-5.5 misread the GE EP61 MCBs as RCBOs in 2 of 3 runs, marking four non-RCD circuits protected; gpt-6-astra 0 of 3, and the only model with the exact module count on both boards. Astra rejects `reasoning_effort:none` (HTTP 400), so the adapter's reasoning family now covers gpt-6 with a `low` default (~15 s per board vs ~25-30 s at vendor default, same counts, same labels; ~$0.10 per photo), overridable via `OPENAI_VISION_REASONING_EFFORT`. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-18 | **CCU single-shot: the VLM never sees a full-size picture on any crop path (backend only; ZERO wire/client change).** The 2048 px width cap only ever applied to the dewarp path; a quad-fit failure (Wylex NHRS10SSLHI, `1789724736752-5boxmu`) sent a 3,447 px bbox crop at 2.4× the tokens, the native-density regime recorded as unreliable for counting since 2026-05-13. One shared cap now covers the bbox crop, the rewireable panel crop and both full-image fallbacks; five per-path tests. Model-side re-check pending: the OpenAI account ran out of credits mid-verification. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-14 | **PLAN-F — the long free-text fields grow with what you dictate (web + iOS; ZERO backend/wire change).** *"The text box does not grow with the text and you have to slide along"*, and in landscape *"I can only see the first few words."* Both clients grew the BOX and not the INPUT: iOS wrapped a single-line `TextField` in `.frame(minHeight: 100)`, web rendered a fixed `rows={4}` textarea with `resize-none`. New `CMFloatingTextEditor` (vertical axis, `lineLimit(3...12)`, every property of the single-line component kept) and an opt-in `autoGrow` `MultilineField` with the same 3–12-line bounds, applied to the same four fields — Extent, Comments, Departures, Departure Details. Web re-fits on WIDTH change, not just on input — review caught that fitting on `value` alone lets a rotation restore the reported bug. A separate type, not a `multiline` flag, because `CMFloatingTextField` has 40 mostly single-line call sites. Bounds are inline styles: Tailwind v4 emits nothing for an interpolated arbitrary value, so the cap would silently not exist. The observation fields already grow and are untouched; the five Installation callers become dated `partial` divergences (owner: Derek). Neither unit runner can assert a rendered height, so structure is pinned on both clients — including a guard failing any future `CMFloatingTextField` + `.frame(minHeight:)` — and layout by red-proofed Playwright cases at phone viewports, both orientations plus rotation. Device smoke still outstanding. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-14 | **PLAN-C — the poor-signal advisory no longer fires on a healthy link (web + iOS; ZERO backend/wire change).** Three "transcription is running slowly" advisories in a 25-minute session on home Wi-Fi, at exact cooldown spacing, while transcription was fast. The state machine was right; its input was not — capture stays live through the TTS echo pause, so the phone's own read-back armed an onset that no interim could resolve until resume, and the sample charged playback + pause + think time as network latency. A sample is now admitted only when its whole onset→interim window sits inside one open, unpaused uplink epoch (dropped, never censored — a censored stand-in still moves the median), on a pause generation bumped at every pause AND resume because a socket epoch does not change across a TTS pause; and censored samples are excluded from the ARM decision entirely, with the count gate moved to observed samples. Both clients also correlate the onset with its socket; only iOS carries the pause half, its detector being starved during TTS — the dated divergence on new ledger row `recording/poor-signal-probe`. Shared synthetic checksum-pinned fixture arms 3× on `origin/main` and 0× now. Three Codex review lanes found nine defects, all fixed before merge and all pointing at FALSE SILENCE: censored entries evicting observed evidence; nothing proving the socket was OPEN; and nova-3 plus final-only Flux turns never resolving the probe at all. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-14 | **Feedback ids 138 + 139 — a polite "yes" now copies the site address to the customer, and an explicitly numbered second "sockets down" circuit is accepted (backend + prompt; ZERO wire/client change).** Id 138: the server-owned mirror ask heard *"Yes, please."*, parsed it as unclear (bare yes/no grammar), copied nothing, and the tool result never told the model — silence. Grammar now takes a yes/no head plus a politeness tail; an unresolved answer returns `address_mirror:"unclear"` and the prompt re-asks once. Id 139: the same-board duplicate-designation guard on `create_circuit` rejected *"Circuit three sockets down too"*, two clarification rounds followed, and the garble *"Sock it down too"* became circuit 3's name. The guard now accepts a duplicate when the active transcript names the new circuit's number explicitly; readings dictated by name alone still reject. **Same-day follow-ups from 139's first attempt (turn-4):** Derek's rule — same-name circuits are legitimate — so any designation announcement with no reading in it is also accepted; and the P4 answered-ask net gains a DROPPED-VALUE family so an answered value ask that the turn then writes nowhere is read back as a loss, never as "Noted — carrying on." Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-11 | **PLAN-D post-merge follow-ups (iOS only; ZERO backend/web change).** Four defects the review rounds surfaced but scoped out of the plan itself. A board the server never addressed can no longer fill Section J after an OFFLINE save: the missing-wire-id provenance now persists to the LOCAL snapshot only (gated on `encoder.userInfo[.localSnapshot]`, never sent to the API), and clears naturally once a real id syncs. `CertificateMerger`'s supply block honours `onlyFillEmpty` across all 46 fields, so the DOCUMENT path stops overwriting an inspector-entered Section J value where web preserved it. `decodeStringOrNumber` no longer TRAPS on a finite number outside Int's range — that crashed job decoding for any field carrying `1e20`. And `A01PLocalCalculateTests`'s intermittent two-board failure was a RACE, not a timeout: the helper waited for any frame rather than the transcript frame. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-11 | **PLAN-D — a consumer-unit photo fills the Supply tab's main-switch box (id 136a; web + iOS; ZERO backend change).** The model forms carry exactly ONE main-switch box, at installation level, and with a single CU that unit's integral main switch IS the installation main switch — so the photo path now promotes the OBSERVED rating to supply, matching the document path it used to disagree with. Identical rule on both clients: SINGLE-board jobs only (Derek's call — the model-forms argument is the single-CU case and iOS has no board selector, so multi-board fails closed), canonical main-board IDENTITY (never array position), empty-only whatever the caller's `overwrite` (a photo must never replace an inspector-entered certificate particular), and the rating alone. BS(EN), poles and voltage stay OFF supply — they are unconditional backend defaults, not observations, and Section J would present them as inspected findings. Covers iOS's two apply paths and web's `buildSupplyPatch`, which gains the board identity and the post-patch board list it lacked. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-09 | **A02D RegexFreshOccurrenceV1 + FinalWindowV1 (backend + web + iOS; ONE additive optional `utterance_id` on standalone `field_corrected` frames).** Client regex writes are fresh by transcript OCCURRENCE, not value equality: every final keeps a thin `{epoch, final_sequence, speech_start, window_end}` record, clears and replacements record cutoffs (manual taps sample the stream offset on the tap's tick; server clears via the echoed `utterance_id`), a dispatch whose onset precedes a manual cutoff is held whole with one clarification line, old speech never restores a cleared value, sleep-wake replay is retired (ring audio is charged as PLAN-E2 staged loss), iOS's 500-character stall is gone, retention is bounded. Shared raw-final vectors pinned on both clients with a fail-closed TestFlight preflight; evidence document with baseline red proof. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-08 | **A01P — Ze corrections and client-name answers stay consistent (backend + web + iOS; one additive optional transcript field `client_command`).** Accepted Ze/PFC writes reconcile the alias sibling already present in their bucket; a recorded-but-unusable Ze (LIM/N/A) skips the calculators as `ze_unreadable`, never "missing"; `client_name` is installation-global for record, clear, and inspect on every board; recognised Calculate runs locally on single-board jobs on both clients (three-state Ze, FIFO speech) and forwards as an ordinary transcript with the marker on multi-board jobs; web's implicit voice recompute is removed. Shared job-state fixtures, replay narration oracle, evidence document. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-09-07 | **A04P DictatedReadbackPolicyV1.** Accepted dictated readings, corrections, requested calculations and reassignments speak exactly once in both extra-prompt states across backend/web/iOS; shared policy bytes, truthful outcomes, atomic address carriers, playback-start evidence and matched cues are pinned. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-29 | **Time-bounded local-speaking TTS gate (web + iOS; ZERO backend change).** Two field sessions in a noisy room: the raw-PCM VAD's fixed 0.015 RMS threshold held `isLocalSpeaking` true for minutes and PLAN-E2's last-mile FIFO gate deferred every read-back forever. The raw read used for gating now expires 2.5 s after onset unless Deepgram confirms speech, and a held gate arms a one-shot retry that re-runs the resume paths. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-29 | **ElevenLabs runaway-clip cap on the streaming synth path (backend only; ZERO wire change).** First Opus-ON field test (session 3387D15C) got a 108 KB / 27 s clip for a 28-char read-back — the vendor's stochastic "phrase then silence" fault (third occurrence; reproduced 1-in-10 via REST). `synth()` now derives a byte budget from text length + format, cuts the stream there, and resolves `capped` — every caller keeps its completed path. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-28 | **Opus uplink ON in production (`DEEPGRAM_UPLINK_CODEC=opus`; infra-from-source; iOS-only effect — web stays `linear16` by design).** Derek's build-444 live probe passed on cellular (176 clean 20 ms packets, correct transcript, `TurnInfo`); he chose to flip without the Wi-Fi run. Accepted limitation: encoder residue at a graceful Stop is counted, not disclosed (graceful-stop drain todo). Rollback = set `linear16` in the task def. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-28 | **PLAN-E1B item 11 follow-up — the in-app live Opus/Deepgram probe now reports to the backend (backend + iOS; additive REST only, ZERO recording-wire change).** Results previously stayed in the device-local JSONL; iOS now fire-and-forgets each run to `POST /api/live-probe-result` (S3 `live-probe-results/{userId}/…` + CloudWatch row, server-derived `succeeded`, new `networkCondition` label) and `GET /api/live-probe-results` lists the caller's own runs newest-first. iOS build 443. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-28 | **PLAN-E-TERM (feedback-2026-08-23 wave) — loss PLAN-E2 counted as MATERIAL but never spoke (an episode still open at Stop) becomes a PERSISTED, VISIBLE record, not a spoken one (web + iOS; ZERO backend/wire change; not a byte added to the stop path).** One durable tombstone row per material `LossSourceId` (web IDB v6; iOS file-backed store) written mid-session via two additive ledger seams + the source-cardinal `disclosure_completed` counter; CAPTURE-time windows through a piecewise sample→wall-clock map; cause-neutral banner only once the session is inactive; PDF-success clear skips active sessions; reconciliation equation pinned on both clients. Full detail: [changelog.md](docs/reference/changelog.md). |

**Only the most recent ~30 entries live here, one line each.** Everything older — and the full
commit-body-level detail for every entry above — is in
[docs/reference/changelog.md](docs/reference/changelog.md); use `git log` for the rest.
Do not re-expand this table: `scripts/check-hub-size.mjs` enforces the limits (see the
MANDATORY block at the top of this file).

## Future Plans

- Evaluate replacing server-side Python PDF generation with Playwright-only approach
- CCU photo analysis: evaluate newer models as they become available
- Expand E2E test coverage

## iOS Deploy (TestFlight)

See [docs/reference/deploy-testflight.md](docs/reference/deploy-testflight.md) for the deploy script, ASC credentials, TestFlight group IDs, and the onnxruntime `MinimumOSVersion` patch.
