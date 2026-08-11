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
5. **Live Extraction** - Server-side Sonnet 4.5 extracts structured certificate data via multi-turn conversation
6. **Review & Edit** - Inspector reviews populated certificate in iOS app tabs
7. **PDF Generation** - Generate complete EICR/EIC PDF certificates

## Audio-First Design Principles

CertMate is evolving into an **audio-first, hands-free** tool. The inspector works in **AirPods**, walking the installation with the phone pocketed and **no eyes on the screen** — they dictate readings and hear them read back. Treat the spoken channel as the **primary UI**; the on-screen grid is the secondary/visual mirror.

The following are **MANDATORY** product invariants. They override older guidance that optimised for screen-first use or for minimising TTS chatter, and they span both backend (extraction/confirmation synthesis) and iOS (TTS playback):

1. **Every dictated reading is read back aloud — exactly once. Never silently entered into the UI.** A value that only appears on screen is invisible to a hands-free inspector, so every applied reading/correction MUST produce one spoken confirmation. *Exactly once* — not zero (silent entry) and not twice (the double-confirm bug). This holds for ALL apply paths, including client-initiated reassignments, not just server-extraction turns.
   - **Exception (by design):** automatic derivations and side-effect ticks — e.g. polarity auto-ticked from Zs, mirror-derived fields — are computed consequences, NOT dictated readings, and do **not** get a spoken confirmation.
2. **Structurally complete readings are WRITTEN regardless of self-reported confidence, and read back aloud — never silently dropped.** A structurally complete dictated reading (field + circuit/board scope + value) is written at whatever confidence and read back; the inspector verifies by ear and corrects by speaking. Ask ONLY for structural gaps, contradictions, invalid/out-of-range values, or true non-values. The live model is Haiku 4.5, whose self-reported `confidence` is not a trustworthy gate, so we do NOT gate behaviour on it (`CONFIRMATION_MIN_CONFIDENCE` is now only the loaded-barrel speculator's pre-synth cost gate; the `< 0.5` write decision is a capability-gated PRE-APPLY rollout step in the dispatcher, not a behavioural confidence threshold). This supersedes BOTH the older "suppress low-confidence confirmations to cut noise" stance AND the interim "low-confidence readings ASK" stance — a dropped reading is invisible to a hands-free user.
3. **Latency is a first-class concern.** The dictate→confirm loop is conversational; perceived latency between speaking and hearing the read-back directly shapes usability. Optimise for low perceived latency and treat regressions as bugs, not cosmetics.

## Tech Stack

| Component | Technology |
|-----------|------------|
| iOS App | SwiftUI (CertMateUnified) |
| Transcription | Deepgram Flux `flux-general-en` (`/v2/listen`, direct WebSocket) on BOTH clients — web live since 2026-07-03 via the `DEEPGRAM_STT_MODEL` runtime kill-switch (nova-3 = fail-safe fallback only) |
| Live Extraction | Claude Sonnet 4.5 (server-side multi-turn via WebSocket) |
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
aws ecs describe-services --cluster eicr-cluster-production --services eicr-frontend eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
gh run list --limit 5
```

## iOS Recording Pipeline (v3)

```
iOS (16kHz PCM) -> DeepgramService (direct Deepgram Flux WS, flux-general-en /v2/listen)
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

- **⚡ CCU pipeline (live):** single-shot `gpt-5.5` over the whole image via `src/extraction/ccu-single-shot.js`. **No per-slot cropping.** Stage-3/Stage-4 per-slot pipeline (`ccu-geometric.js`, `ccu-label-pass.js`) is LEGACY FALLBACK only, gated behind `CCU_USE_SINGLE_SHOT=false`. In-scope failure modes: gpt-5.5 mis-counts in long identical-MCB runs, label-column mis-alignment, post-merge enrichment overrides, `slotsToCircuits` phase-walking heuristics. NOT in scope: CV crop accuracy / slot crop boundaries (not in live path). Full details: [docs/reference/architecture.md#ccu-photo-extraction-pipeline](docs/reference/architecture.md#ccu-photo-extraction-pipeline).
- **Web rebuild in production** since 2026-04-18 (PR #1, merge `9202351c`). certmate.uk serves Next 16 / React 19 PWA client from `web/`.
- **Live in production:** Deepgram auto-sleep (3-tier Active/Dozing/Sleeping), server-side Sonnet v3 multi-turn extraction.
- **Next candidates:** Playwright E2E coverage for offline-sync. (`queueSaveJob` IS wired into JobProvider's save path at `web/src/lib/job-context.tsx:159` — verified 2026-07-02; the earlier "no production caller yet" note was stale.)
- **SHIPPED 2026-07-02 (WS2), awaiting iPad field smoke:** PWA observation-photo auto-link — the parked 2026-05-13 branch was rebased onto main and merged. Ledger row `observations/obs-photo-autolink` stays `partial` until the iPad Safari device smoke passes (todo in vault `todos-certmate.md`); two dated deliberate divergences on the row (no CCU picker source — zero-backend; web-extra camera/library chooser).
- **OPEN FOLLOWUP 2026-06-05 — voice-latency Phase 2.2 (deferred from PR #52, merged).** Surface proactively on any voice-latency or field-test discussion. Pick server `FINALIZER_TIMEOUT_MS` widen vs iOS Apple-native `local_fallback` emit once 1–2 field sessions hit the deployed code. Runbook: [CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md](../CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md).

## Changelog

Recent changes — one line each. **Full commit-body-level detail in [docs/reference/changelog.md](docs/reference/changelog.md)**; use `git log` for everything else.

| Date | Summary |
|------|---------|
| 2026-08-11 | **The `second`→`circuit` repair was disarming the pre-LLM gate — an ordinary sentence earned silence (both clients; ZERO wire change, ZERO backend change).** Derek asked whether `circuit`/`lights`/`sockets` should be trigger words: they already ARE (weak tier, deliberately), and `hasWeak` was TRUE on the utterances that went unanswered. The half that failed did so for a reason we manufactured. Flux hears "circuit" as "second", the normaliser repairs it unconditionally, and the gate's `distinctContent` is a **`Set`** — so on a sentence holding both words the repair eats a slot: `"Second circuit is lights."` (3 distinct, forwards) becomes `"circuit circuit is lights."` (2, dropped `low_content`). `NumberNormaliser.swift` had listed this exact input as an accepted trade-off — *"gibberish, no regex match, harmless"* — pricing the duplicate only as a failed downstream match; the gate counts words, it does not match regexes. Fixed on the NORMALISER: an adjacent literal `circuit` proves nothing was misheard there, so `\bsecond\b(?!\s+circuits?\b)`. Rejected the gate-side raw-OR-normalised alternative — only normalised text crosses the wire, so it needs a wire change, two fixes not one, and still feeds the model gibberish. NOT done: promoting the weak triggers (build 386's rule exists to stop *"the circuit breaker's in the cupboard"*) or moving the threshold. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-11 | **The ask-path playback-ACK blind spot — every question the inspector heard was invisible server-side (backend route + iOS; telemetry-only; ZERO behaviour change).** iOS gated the ACK on a loaded-barrel `turnId` at three sites and nothing threads one onto a question; had it posted anyway the route would have refused it, since the turnId exemption also required `source === 'fast_tts'` — the only turn-less producer known when Tier 1.3 wrote that rule. Asks are the second, and they are `bundler`. Both halves now identify the clip by `correlation_id`, which the handler already resolved on, so a played ask and one that never synthesised are no longer identical rows. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-11 | **Plan 08B — the `board_id` vocabulary gap: two places the model could not read a boundary the validator enforces (backend + prompt; ZERO client-wire change; ZERO runtime-behaviour change).** A field session burned three rounds on calls always destined to reject, and in both mechanisms the model was reasonable given what it could see. (1) The prompt says *"Do NOT pass `board_id` on these tools"* while the five mutator SCHEMAS went on offering the parameter — a schema is the model's map, so it won. Deleted; `select_board` has been the only working cross-board route since Phase B narrowed acceptance in May. Explicitly NOT a fence: `strict: true` is off (Bug-E), `validateBoardScope` still does the stopping, and dispatchers still read `input.board_id` **deliberately** — the server's own answer-resolver stamps it on every sub-board clarification write, so "reject any supplied `board_id`" would have broken production. The Phase 6.4 guard test is INVERTED, not deleted: it caught this very edit. (2) `'*'` was identified only positionally — *"on the last"* of three listed tools — while both calculators reject it silently; prompt and both descriptions now name the sole acceptor and state the rejection. Sizing stated honestly: 3.6–4.7 % over 2 of 28 turns; the 23.8 % lever is 08D, parked. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-10 | **Plan 08A — Stage-6 round instrumentation (backend-only; ZERO client-wire change; ZERO behaviour change).** Three additive fields let an ORDINARY session answer the wave's next latency question instead of one field session per hypothesis: `reasoning_tokens` — threaded through BOTH the adapter and `attributeRoundUsage`'s explicit ALLOWLIST, since the adapter alone would have been a silent no-op; `first_tool_use_ns` at the first `tool_use` `content_block_start`, the only honest first-content marker here because the adapter yields a SYNTHETIC `message_start` before it reads provider SSE (`first_token_ns` would have timed the adapter, not the model); and `blocking_ask_user_dispatched` to label the rounds whose `dispatch_ms` legitimately holds human wait. A timing row now lands on all SEVEN post-completion exits rather than two — the cap and error paths, the rounds most worth measuring, measured nothing — via one synchronous, non-throwing, idempotent finaliser that runs BEFORE `attachBillableUsage` on the fatal rethrows. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-06 | **The three DEFERRED board-routing fixes, shipped (backend-only; ZERO client-wire change; supersedes the "deferred to `/rp`" note below).** The prior wave fixed the prompt/schema contradiction that TAUGHT `board_id:"main"`; these close the mechanism, so the class cannot recur from another prompt path. Three surgically revertible commits: (1) `normaliseBoardScopeInput` deletes a `"main"` alias that provably denotes the already-selected board, under three CONJUNCTIVE conditions — no board literally has that id, the canonical main IS current, and the dispatcher passed a snapshot (which is what leaves the three exempt board dispatchers rejecting, unchanged); (2) `wrong_board` gets its OWN partial-failure notice family, because that class spoke NOTHING and `circuit_not_found`'s wording would be false about the installation; (3) a no-op `select_board` says *"Already on the DB-1 board"* — wording, not suppression, since the false *"Switched board"* is what disarmed both audibility nets. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-06 | **A dictated reading was silently lost to `board_id:"main"`, and the same field session produced ZERO usable evidence — one wave fixing both (backend + prompt; ZERO client-wire change).** The prompt AND the tool schema both taught `"main"`/*"the main board"*, but `"main"` is a board TYPE — the validator rejected `wrong_board`, that class speaks nothing, and the prescribed `select_board` recovery was a no-op that still said *"Switched board"*, so the turn looked productive and both audibility nets stood down. Schema descriptions now agree with the prompt and `wrong_board` recovery is a mandatory two-step; the three riskier board fixes are deferred to `/rp` because `multi_board_routing` is a named zero-coverage gap. Separately, three faults made the session evidence-ineligible: receipts bound by the response epoch not the loop-opening turn id, a `mirror_scope_conflict` guard that false-positived on ordinary turn pipelining (authored a day before the observer was wired into production), and a stop-race where noise at cancel opened a turn teardown killed — now a bounded settle. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-06 | **Plan 00 evidence gate: `REQUIRED_DAYS` 3 → 1 (operator scripts + tests + docs; ZERO backend-behaviour and ZERO client-wire change; Derek).** A gate "day" is the full ~10-requirement COVERAGE bundle landing inside ONE Europe/London day, so requiring it three times bought repetition — not coverage — while freezing the backend for three days (any relevant deploy voids the cohort). Coverage is unchanged and still enforced per day; `0` is refused structurally (module-load throw — at 0 the fold reaches DONE with zero evidence); DONE-walk tests made threshold-agnostic. Also de-staled `deployment.md`'s mock/replay-only runner note (retired by 00B-2/00B-3). Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-05 | **Plan 00B-4 — the live vendor lane actually dispatches, under a sealed capability and a gate that refuses before it allocates (backend + operator scripts; zero client-wire change; the sanctioned 00B successor, so `semantic_oracle_digest` is regenerated over 41 → 42 inputs).** `run-ir`/`run-corpus` previously refused unconditionally, so anything they appended would have been a mock verdict wearing a real verdict's shape. Dispatch authority against the durable store is now a frozen capability in a module-private `WeakSet`; exactly-once comes from the per-(requirement, generation) reservation, NOT the ordinal (a shared ordinal is resume, not a bug); one provider call per attempt is clamped in `callWithRetry`, where the retries actually live; provider call ids are surfaced through both OpenAI adapters ordered-and-undeduped so `fold.mjs`'s shipped single-use checks have something to bite on; and `assertRunPreconditions` refuses BEFORE allocating, including on the manifest's twice-stated lane-sha mirror. The self-consistent lie is closed — every earlier command compared the manifest to ITSELF, so the 00B `/ep` success record is now the anchor outside it, and cohort supersession is recorded atomically rather than inferred from recency. Plus `enterTurnScope` ownership at four production sites, an explicit `turn_kind`, one shared bounded capture budget, per-fixture safety metadata, and a stale dormancy comment. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-05 | **Plan 00C Stage A — three-day GPT-5.6 field-evidence gate: version-audited append-only evidence layer + server-authored session manifests (backend + operator scripts; zero client-wire change; no enumerated semantic-oracle input edited).** Every live session now registers the 00C manifest builder/publisher through 00B's frozen hook (`src/server.js` → `src/extraction/plan00-session-manifest.js`): a pure builder derives start/completion manifests from the five-key snapshot via `evidence_projection_v1` and a task-role-bounded conditional publisher writes them content-addressed to the versioned bucket — evidence fails closed per session, the live audible turn never fails. Operator commands at `scripts/plan00-evidence/` (publish-stage-a, TTY-gated attest/init/decide, bind-session, status) own the post-deploy fold: validation-precedence pairing, BLOCKED dominance, per-day IR/corpus/route/cache/family gates, STALE_DEPLOYMENT drift hold. 119 new tests; Stage B remains an operator runbook. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-04 | **Plan 00B-3 — the oracle-evidence CONTRACT (backend + scripts; ZERO client-wire change; completes the twice-CODEX-HELD 00B semantic-oracle delivery on PR #154).** The evidence contract the two held runs kept discovering one leak at a time is now an EXECUTABLE TEST authored FIRST (pre-pinned schema artifact + hand-authored two-sided fixture + 53-case contract suite, RED-proven 32-failing at the held tip): acceptance-gated sub-records derived from ledger verdicts (rejected transitions visible-but-uncreditable; `answered_without_full_proof` no longer latches invalid and stays open — sanctioned), per-family Tier-2 ask quiescence with the stop-boundary rule (plus the narrow windowed-judge carve-out that keeps the frozen corpus 9/9 while 00C's counts stay strict), ONE closed producer registry backing the semantic-family + transport split on delivery/playback rows (unknown id = uncreditable invalid row, source-scan enforced), parity-matrix observation UPDATE/RECODE legs, and the complete 00C projection (api_transport per round, delivery refs/aliases, ACK-body hashes, condition-gated freeze-time invalid rows incl. the unconsumed fast-TTS provisional fold). 00C's canonical plan carries the dated CONSUMER-half amendment; tracked bundle + expectation manifest regenerated. Full backend 7860+ green. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-02 | **July 30 GPT-5.6 price correction.** Backend telemetry now uses Luna's 80%-lower and Terra's 20%-lower official rates; an exact mixed-model field-session regression pins `$0.143350` model cost and `$0.185270` total job cost, with `$0.114561` saved by explicit caching. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-02 | **Address-mirror migration deploy fix.** JSONB object/array defaults now use raw node-pg-migrate SQL literals and text defaults omit literal quote characters; a rendered-SQL regression protects the cleanly rolled-back migration before retry. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-01 | **Terra observation trial activated.** Observation-shaped turns use `gpt-5.6-terra` Standard/low through the provider-safe Responses loop; ordinary readings remain Luna Fast. Sole-tester iOS trial only; the missing web processing cue remains a documented parity gap. Rollback is the source flag. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-01 | **GPT-5.6 provider-parity safety slice (independent Codex-reviewed; activation separate).** All live/shadow/legacy/keepalive extraction calls now resolve model + matching SDK atomically; missing keys, unknown providers and cross-provider round-one overrides fail before dispatch. OpenAI system blocks retain explicit boundaries, observation OpenAI tier/effort can override Luna Fast, routing telemetry names the provider, and current Luna/Terra/Sol Standard/Fast costs are tracked. Observation routing remains dark for this commit. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-01 | **Voice-address single authority.** Client regex no longer writes site/client addresses or owns same-address mirroring; strict current-utterance postcode hints feed backend-only locality enrichment, while trust-marked claims, CAS-owned delivery leases, provenance-safe recovery, and reconnect-replayable questions keep copies and terminal speech idempotent across reconnect/restart. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-08-01 | **Loaded Barrel completed-turn bookkeeping cleanup.** Later clips from an already-measured multi-reading turn retain their canonical playback evidence but no longer create false `late_ack_without_summary` failure rows; a bounded summary tombstone preserves the genuine missing-summary diagnostic. Telemetry-only. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-31 | **Loaded Barrel actual-playback telemetry (Plan 07 Phase 1).** Backend TTS correlation/source now survives the iOS FIFO/deferred head to the successful playback-start ACK; additive `audio_source`, flattened summary fields, and `playback_started/acked_by_ios` rows distinguish heard hits from canonical fallback without changing conversation behaviour. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-31 | **PLAN-2D client-release replay closure.** The generated 116-field PWA route sweep now uses a valid spoken inspection date for both date fields and compares it with the router's normalised ISO destination, so the strict invalid-date guard is tested with possible data. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-31 | **Standalone PLAN-2C/2D + PLAN-3 client ride-along release.** The cumulative reviewed web/iOS source now ships independently of deferred PLAN-4: postcode operation dedupe, the 134-field route contract, AFDD schedule item 5.22, and delayed observation-recode turn accounting. The temporary local 5.22 parity allowance is removed now both client sources agree. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-31 | **PLAN-3 — observation regulation integrity (feedback id 107).** AFDD↔SPD contradictions reject before append with a specific audible covered refusal; the AFDD table checks the ≤32 A socket-final-circuit predicate before its four premises categories through an exact-chain, server-owned ask/write/terminal lifecycle; refinements preserve valid citations and speak severity changes through durable reconnect-safe two-frame egress. EICR schedule item 5.22 is mirrored across all seven source copies. Held web/iOS branches ride PLAN-4's wave-end client delivery. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-31 | **PLAN-2D §3.6 — client-route manifest + structural rejection (backend/web/iOS source).** A committed 134-field destination contract gates every Stage-6 write before mutation, including legacy extraction; malformed sibling prose/history is replaced with server-owned read-backs/refusal text. Exact web/iOS destination tests cover canonical-main empty-board attribution, visible design comments, false supply polarity, and inspection years 1–10. Web+iOS source rides PLAN-4's wave-end client release. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-31 | **PLAN-2C §3.5 — postcode read-back dedupe token (feedback id 102; backend/web/iOS source).** A new six-field wire/client manifest and `secfield_` producer distinguish distinct same-text postcode amendments while replay stays idempotent; the candidate-1 backend debounce manifest remains the original five fields. Derived town/county stays designed-silent. Web+iOS source rides PLAN-4's wave-end client release. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-26 scalar-compatibility closure.** Registered grouped clarifications reuse the shipped bounded scalar circuit parser, so natural `Use/Choose/Pick/Go with circuit N` answers work on both live channels without widening negation, prose, or value-command acceptance. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-25 broker-lifecycle closure.** Collapsed board writes and their unmatched-description notices retain a genuinely selected census board across an `mdr-*` wait, while a server-owned generation latch prevents model-reformatted retries from reopening an abandoned ask. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-24 authority closure.** Frozen-board retention now requires the board to have been genuinely selected at census time; model-authored scope for an unselected board still fails the normal `wrong_board` gate and mutates nothing. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-23 lifecycle closure.** The effective circuit board is frozen across an in-flight grouped clarification, including writes/dedupe/notices, and `user_moved_on` abandons plus generation-fences the stale buffered ask so the replacement command can run exactly once. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-22 gate closure.** Wrapper-preserving raw exact matching keeps literal names such as `A` through *"the A circuit"* list/scalar/grouped answers; short destructive commands now require a non-filler target, so politeness preserves the blocked `mdr-*` ask. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-21 gate closure.** A true raw-exact designation pass preserves literal stop-word names such as `A` across list-wide resolution and grouped follow-ups; bounded short `delete|remove|clear` commands now release blocked `mdr-*` asks and traverse either client answer channel exactly once. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-20 gate closure.** Leading quantifiers now own terminal-`circuits` enumerations with pre-mutation total reconciliation; direct mdr overtakes reserve paired utterance-id/content anchors before one private synthetic reinjection, preventing direct/transcript double processing in either arrival order. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-30 | **PLAN-2B §3.3 round-19 gate closure.** Noun-less list-wide quantifiers now reconcile their total distinct ref count before any write; transcript commands release a blocked `mdr-*` ask and drain once through shared command evidence; and safe explicit-circuit scalar lead-ins remain compatible. Full detail: [changelog.md](docs/reference/changelog.md). |

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
