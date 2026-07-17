# EICR-oMatic 3000

> **MANDATORY — Every code change must update docs and be committed.**
> - Changed a pipeline step, field, or architecture? Update the matching [reference file](docs/reference/).
> - Hub AGENTS.md is an **index only** — add detail to reference files, not here.
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
4. **Live Transcription** - Deepgram Nova-3 transcribes speech in real time (direct from iOS)
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
| Transcription | Deepgram Nova-3 (direct WebSocket from iOS) |
| Live Extraction | Codex Sonnet 4.5 (server-side multi-turn via WebSocket) |
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

**Auto-DELIVER at the end of a work session — do NOT wait to be asked. Delivery is PR-only: `main` is PR-protected (field-replay corpus gate, 2026-07-16 — Derek's repo-wide PR-only decision).** When changes are committed locally and `npm test` is green, open a PR and merge it via `gh pr merge --merge` after the required checks pass — for EVERY end-of-session delivery, backend AND web-only waves AND docs commits included. Never `git push origin main` directly. CI handles the deploy from the merge.

- Branch from `main` (`git switch -c <topic>`), commit per logical unit, `git push -u origin <branch>`, `gh pr create`, then `gh pr merge <branch> --merge` once `Test Backend (Node.js)` / `Test Frontend (Next.js)` / `npm Audit Security Scan` are green. Watch the post-merge deploy with `gh run watch <id> --exit-status`.
- **Why PR-only now:** the field-replay corpus gate is merge-blocking, and a merge-blocking gate is a `main` branch-protection ruleset — necessarily repo-wide (GitHub has no path-scoped PR enforcement). A direct push would bypass the gate. This is the WS5×WS7 parallel-merge drift-stop generalised.

**When NOT to auto-deliver:**
- `npm test` (backend Jest) or the web vitest suite is failing — fix first; do not ship red.
- A pre-push hook (secrets scan, full test suite, `replay:field-corpus:prepush`) fails — investigate; do not bypass with `--no-verify`.
- The user explicitly said "don't push/merge" for THIS task.
- Schema / migration changes that need coordination with an iOS TestFlight cycle — merge the backend FIRST and wait for ECS rollout (`gh run watch`) before kicking off iOS auto-push, so iOS hits a backend with the new shape live.

Default is auto-PR-then-merge; the exclusions above are the only reasons to hold.

Do **not** use the local `./deploy.sh` quick-deploy script even though it exists in the repo. Docker Desktop is not kept running on the dev Mac, so the script fails immediately, and its `tee`-wrapped invocation masks the failure as exit 0. CI is the only deploy path that works reliably.

iOS TestFlight: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh` — same auto-push-at-end-of-work policy applies; see `CertMateUnified/AGENTS.md` § TestFlight Deployment.

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
| [field-replay-corpus.md](docs/reference/field-replay-corpus.md) | Field-replay correctness gate: captured sessions as a merge-blocking regression corpus (two lanes, three-stage authoring, gate-state machine, trusted evidence, signed-commit governance, PII policy) |
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
| 2026-07-17 | **Field-replay correctness gate — FOUNDATION (backend test-infra + CI; ZERO backend-behaviour change, ZERO client runtime change).** The missing live-exercise gate: replays REAL captured field sessions through the REAL `runShadowHarness` and asserts audibility/write/clarification invariants as a MERGE gate, so a fix for a field bug must pass that bug's captured transcript before it can ship. Foundation ships the runner + tooling + CI wiring + docs with ZERO fixtures (empty corpus = PASS). **Item 1** (`scripts/field-replay/`): three-stage authoring (convert → accept → validate), the canonical crypto spec (RFC 8785/JCS via pinned `canonicalize`, domain-separated SHA-256 identities, HMAC keyed source commitments, random-only `frc_*`/`fix_*` refs), the fixture schema + ONE gate-state machine (expected_red/required_green/unsupported_pending/superseded/privacy_quarantined) + immutable projection, the schema-aware PII scanner (synthetic grammar, two-tier docs), CloudWatch+iOS+debug-report normalisation with total ordering + UTC parsing + exclusive 15s chime correlation + fail-closed freshness (100-char report-linkage), and trusted-run evidence acceptance (3 modes). **Item 2**: the deterministic runner — bootstrap/runner split of `transcript-replay-direct.mjs` (legacy `--scenario` byte-for-byte, new `--model-lane=recorded|live`), `f7-audibility-core` env-neutral refactor + jest adapters, exact-toFake fake clock + timer ledger + guarded pump (zero real waits), task-def env loader (SNAPSHOT_FORMAT/CIRCUIT_ORDER/routing pinned), production-parity session builder with machine-checked activeSessions classification (proven: low_conf_readback_v1 flips a sub-0.5 write; askBudget+restrainedMode compose the gate), the assertion engine (atomic audibility.output one-to-one matching, expected_red satisfied only by its exact failure id, XPASS fails, infrastructure distinct), recorded-lane AWS-credential + fetch deny (execSync-unreachable proof), live-lane explicit-key-only + outbound-host policy + vendor-call ceiling. **Items 3/4/5**: versioned budget table + £10 envelope guard, subject-path projection + pinned Node 20.20.2 + trusted-harness manifest, the immutable evidence workflow (anchored-blob verification, SHA-pinned actions), split nightly live lane (protected manual environment), signed-commit governance (byte-for-byte key binding, base-commit allowlist, rotation isolation, genesis), CI history checks inside `test-backend` (fetch-depth 0, dormant-until-marker ruleset guard) + the workflow_dispatch-bypass close (main-only manual gate) + the `.husky/pre-push` XPASS-tolerant backstop. Hub auto-push rule rewritten auto-push→auto-PR-then-merge (Derek's repo-wide PR-only decision, 2026-07-16). ~290 new field-replay/CI tests; 5496 backend tests green (was 5207 at `8fb95b7b`). Threat model = accident-class (malice hardening deferred to `field-replay-hardening-followups`). Full detail: [field-replay-corpus.md](docs/reference/field-replay-corpus.md) + [changelog.md](docs/reference/changelog.md). |
| 2026-07-15 | **F7 hardening wave (harness-first; backend-only, ZERO client) — audibility-invariant sweep + pre-emission ask-audibility net (#16) + extraction-watchdog re-arm & generation cancellation (#14).** Origin: field-feedback-2026-07-14 Codex out-of-scope findings. **Item 1 (#17):** two-lane Stage-6 audibility-invariant sweep (the class-killer for 28 review findings the PWA harness can't cover); NINE invariant-(a) suppression cases shipped `test.failing` (RED verified on the audibility assertion) → GREEN by Item 2 in one PR; enum-driven pre-emit vs emission-required classification DISJOINT + union == `ASK_USER_ANSWER_OUTCOMES`. **Item 2 (#16):** closes chime-then-silence — per-turn `emittedAskToolCallIds` fed by `onAskUserStarted` (successful-send only: initial / `pvr` / dialogue-engine `safeSend` via `ASK_STARTED_OBSERVER`); pre-emission net (after §D2, before A4 drain, `confirmationsEnabled`-gated) queues ONE fixed field-null apology when an ask was attempted, emitted-set empty, nothing audible survives; §D2 tightened to require continuation ∈ emitted set; step-3b FAST-FAIL of closed-WS/throwing-send/`fallbackToLegacy` (no 45s dead-air); `tool_call_id` on `toolLoopOut.tool_calls`; A4-drain trim; two telemetry rows + `generationId` on them + `ios_send_attempt`. **Item 3 (#14):** per-turn extraction-watchdog CONTROLLER — `askChainObserved` latch (via `onAskRegistered`) extends the 30s no-ask deadline to `EXTRACTION_WATCHDOG_ABSOLUTE_MS` (195000ms); REAL cancellation via one `AbortController` per generation threaded through `runShadowHarness`→`runToolLoop` (signal + `throwIfStage6Cancelled` + SDK abort canonicalisation) + `rejectAll('timeout')`, NEVER force-clearing `isExtracting`; one shared FATAL discriminator (`stage6-control-flow-errors.js`) rethrown before every generic recovery; on cancellation `runLiveMode` finalizes a partial (every applied write still read back once) via inline `cancelled` guards; two watchdog telemetry rows; comment sweep 20s→45s. 5207 backend tests green. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-15 | **D2 mutation-to-chain correlation (own wave; backend, ZERO client).** Closes the multi-observation beep-then-silence path (field-feedback-2026-07-14 Codex cycle-5 #4). The §D2 dropped-net evaluated only the globally-latest answered clarify chain and let ANY later `record_observation` qualify it, so in a two-answered-chain turn one write suppressed the whole fallback and the earlier chain never retired. Fix: `record_observation` now carries a nullable-required `clarification_chain_id` (schema + prompt echo, ONE cache-invalidating edit; `null`=direct); the net GROUPS answered clarify asks by chain id (latest anchor per chain) and correlates each successful write (`is_error!==true` AND body `ok===true`, internal-catch parser) to its chain. Mutation-id LENIENT on both edge cases (Derek): id-less (D-1a) / unknown-non-null (D-1b) qualifies every evaluated chain whose anchor precedes it (avoids false apology→re-dictation→duplicate); only a non-null id matching a DIFFERENT chain fails to qualify this one. COLLAPSED single count-aware fallback (per-chain identical texts client-swallowed by the A1(b) 30s field-nil TTL); every non-null chain retires once. Telemetry: extended `dropped_net` + new `lenient_qualification` INFO row; raw model-controlled id NEVER logged (leak-filter bypass) — only `mutation_id_kind` + server-minted ids. Shared pure `normaliseObsClarifyChainId`; net resolves against the turn's anchor map, never broker membership. Zero-client: dispatcher returns exactly `{ok:true, observation_id}`; chain id never enters extractedObservations/perTurnWrites/legacy wire/logs (pinned). Known-limitation D-2 (dated, ACCEPTED): same-wording D2 fallback repeated within 30s may client-dedupe. Test matrix 1-16. 5159 passed / 19 skipped (+28 over 5131 baseline). Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-15 | **Field-feedback 2026-07-14 WEB COMPANION (deliverable 3; web-only, ZERO backend).** A1(a) token-aware dedupe key (`DEDUPE_TOKEN_FIELDS`, `Confirmation.dedupe_token`; vectors regenerated from the backend mirror, Swift-identical) + A1(b) 30s field-nil apology TTL with AGELESS queue reservations + shared forget helper clearing all three stores (`confirmation-dedupe-store.ts`, tts-queue `onPlaybackStarted` hook — closes the F7/F10 swallowed-apology class on web); C4 `zedi`→Ze + `icd`→RCD trip-time aliases (matcher + backend-facing normaliser; keyword-boosts untouched, exact iOS 67ffb9d mirror); A2 replay-harness mock-lane pin (`field_corrected` canonical `r1_plus_r2` clears r1_r2_ohm / exempt `r2_ohm` arrives raw — RED-proofed); B1 verified NO web dual-address ask (no gap, ledger row); B2 observation-processing cue DEFERRED with owner Derek (`recording/observation-processing-cue` — base cue never ported, own wave). Ledger: 1 row updated + 4 new; files-map extended. 1431 web tests green. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-14 | **Field-feedback wave — session 6B6FE011 (10 reports F1–F10): five chime-then-silence paths closed, two wrong-writes fixed, garble aliases, two Derek-decided product changes (backend PR; iOS + web companions follow).** Headline invariant (Derek, F7): *"There should always be a follow-up TTS if there has been a beep."* (A1a) five text-op confirmation fields carry a backend `dedupe_token` (replay-stable operation identity) so identical-text repeats of DISTINCT operations stop client-deduping (F2 rename-correction, F7/F10 apologies); token-aware debounce; `ios_send_attempt` telemetry moved post-debounce covering all five fields. (A2) clear_reading wire canonicalised (F5 — "cleared" spoken, cell stayed populated) with `r2_ohm` exempt (canonical `r2` would MIS-clear R1+R2 on build-418) + a SEMANTIC clearer round-trip audit gating the deploy. (A3) orphan net catches digit-less observations (F3/F9) with an observation-flavoured apology. (A4) `context_field:"none"` inverted asks get a write-or-reask GUARANTEE (F8): pendingValue captured at registration, field-name replies resolved and dispatched through the normal read-back path, deterministic `pvr-*` broker re-asks (register-before-send), typed schema-aware fresh-reading detector guards both answer channels, audible apology terminal — never silence. (B3) leak filter sanitises `suggested_regulation` to its regulation token instead of rejecting the call (F6 ~9s retry). (C1) conservative fuzzy designation matching (length-aware Levenshtein + strict margin, ask-answer path only) + prompt designation-outranks-ambient/no-phantom-circuit steering. (C4) ICD→RCD, triptan, Zedi→Ze enumerated aliases (no broad fuzzy — §3E stands). (D1) observations professionally REWORDED (BS 7671 tone, fact-preserving) — Derek's F6 ask. (D2) ambiguous C2-vs-C3 → ONE targeted factual ask naming the deciding fact (never "C2 or C3?"), three-way outcomes, per-OBSERVATION clarification-chain ask budget + post-answer net. (INV-2) ElevenLabs bytes/char anomaly telemetry (F1 garbled synth). 5,100+ backend tests green. Full detail: [changelog.md](docs/reference/changelog.md). |
| 2026-07-06 | **Web TTS FIFO queue + `cancel_pending_tts` — iOS AlertManager Phase 7.1 → web (web-only, ZERO backend; deployed, `match` pending device ear-verify).** Root-caused from a live PWA session (`sess_mr8qrvcm_20jn`): a two-circuit turn read back only the LAST circuit (the second `speakConfirmation` cancelled the first 5ms in) and a deferred "which circuit?" question was stranded (phantom SpeechStarted cleared `isInspectorSpeakingRef` WITHOUT draining `deferredTtsRef`). Both are the unshipped iOS TTS FIFO (WS3-FU `parity-ws3b-voice-latency-2026-07` item 8). Fix = **two paths** mirroring iOS Phase 7.1 scope: (1) new `web/src/lib/recording/tts-queue.ts` — a framework-free confirmation FIFO pump (injected player, last-mile deferral gate re-checking `shouldDeferPlayback` POST-fetch/pre-`audio.play()` per iOS `playOrDeferQueueHead`, drop-oldest overflow MAX 6, `preemptFlush`/`purge(prefix)`/`reset`, synchronous `onDiscarded` un-record so a discarded-before-play confirmation is re-speakable — Audio-First #1); `elevenlabs-tts.ts` gains `prepareElevenLabs` (fetch/play split). (2) `tts.ts` split: `speakConfirmation()`→FIFO via a thin ElevenLabs-primary/native-fallback player; `speak()` stays DIRECT and PREEMPTS the FIFO (iOS `speakWithTTS`+`deferredTTS`); token-guarded `activeAudioOwner` so barge-in `cancelSpeech({resetQueue:false})` cuts only a direct-owned prompt, never a queue confirmation. (3) `recording-context.tsx`: shared `handleInspectorStoppedSpeaking` drains the deferred prompt (via `speakDirectPrompt`) AND resumes a deferred confirmation head from BOTH `onUtteranceEnd` and the phantom-reset (Symptom-2 fix). (4) `cancel_pending_tts` (iOS Phase 6.3) — backend already emitted it (`engine.js:1020-1024`), web had ZERO handling: `sonnet-session.ts` decode + `clearInFlightToolCallIdByPrefix`, `in-flight-question.ts removeByToolCallIdPrefix`, pure `tts-prompt-helpers.ts handleCancelPendingTts` (NOT gated on the audio window) clears ask state. Deliberate divergence: voice-command `spoken_response` stays on the FIFO. ~90 new tests; full web suite green. Ledger: `recording/tts-fifo`→`match`, new `recording/cancel-pending-tts`→`match`. |
| 2026-07-03 | **Test-harness hardening — make "green locally" mean "green in CI" (web-only test infra + CI hook + docs; ZERO backend).** Roots the WS7 CI-only failure class. (A) **Node pin** — root `.nvmrc`=20 + `web/package.json` `engines >=20 <21` + WARN-level `web/scripts/check-node.mjs` wired as web `pretest` (fires on every `npm test --workspace=web`), so a local web run on a non-20 major (dev box is v25) no longer goes silently green; scoped to `web/` (NOT `engine-strict`, which would block backend install on 25). (B) **Vitest hygiene** — `restoreMocks`/`clearMocks`/`unstubGlobals`/`unstubEnvs`/`isolate` on in `web/vitest.config.ts` + global `afterEach(vi.useRealTimers())` in `web/tests/setup.ts` (the flags don't restore fake timers) + a new `harness-leak-lock.test.ts` regression guard. (C) **Fragile overrides converted** — direct `localStorage.{setItem,getItem,removeItem}=fn` (the pattern a real jsdom Storage silently ignores → the WS7 bug) → `vi.spyOn`; `globalThis.fetch=fn` → `vi.stubGlobal` across terms-gate/terms-page/api-client/runtime-config/ws6-pending-ccu-queue. (D) **Local==CI gate** — `.husky/pre-push` now sources nvm best-effort + WARNs via check-node + runs BOTH backend Jest AND `npm test --workspace=web` (was backend-only, so the web suite that broke was never gated locally); keeps the load-bearing Homebrew-PATH fallback for GUI git. Governance MANDATORY rule added to both hubs: parallel workstreams over shared test files must re-run `main`'s full suite between merges (the WS5×WS7 gap that skipped WS7's deploy). 1319 web tests green, parallel + serial. Builds on PR #81's already-merged unconditional `setup.ts` shim. |
| 2026-07-03 | **Parity WS7 — mobile "indistinguishable" PWA chrome + T&Cs signature + circuit keyboard accessory shipped (web-only, ZERO backend; deployed, `partial` until iPhone A2HS device smoke).** (a) **Circuit-cell keyboard accessory bar** (LIM / N/A / prev / next / Done) across ALL THREE surfaces (card / sticky-table / desktop-schedule) via shared `circuit-keyboard-accessory.tsx` + `circuit-focus-fields.ts` — 13 iOS focusable fields (tokens on all but ref/designation) + 12 web-extra keyboard fields (dated divergence: prev/next but NO LIM/N/A, iOS renders them as dropdowns); `visualViewport` positioning, blur-survival `preventDefault`, cross-circuit prev/next wrap; card auto-expands collapsed cards on cross-circuit Next; LIM wires to WS3 `circuits/lim-sentinel-display` (PR #76). 34 tests. (b) **T&Cs acceptance-signature port** — 7th attestation, completion 6→7, Accept gated on a signature, `termsAcceptanceSignature` PNG data URL persisted signature-first/all-or-nothing (storage-throw rolls back all terms keys + blocks the redirect); `hasAcceptedCurrentTerms()` unchanged (existing users don't re-sign); client-side only. 27 tests. (c) **Haptics** — `haptic('heavy')` gate-pass + `haptic('light')` job tab-rail (the two live iOS `UIImpactFeedbackGenerator` sites; `AppTabBar` legacy → no app-shell haptic). (d) **Standalone chrome** — `globals.css` `overscroll-behavior:none` + tap-highlight transparent + scoped `user-select`/`touch-callout` (inputs kept selectable) + `.p*-safe` env helpers; AppShell header `pt-safe`+`min-h-14` notch clearance; pull-to-refresh suppressed. (e) **`BrandedSplash`** root `loading.tsx`. `manifest.ts`/`layout.tsx` audited already-correct. Deferred: view-transition push/pop (needs Next experimental `viewTransition` flag). Ledger: 6 rows → `partial` (`last-verified` 2026-07-03), then `match` after device smoke EXCEPT `crosscutting/uiimpactfeedbackgenerator` (permanent `partial` — no iPhone Safari Vibration API); 15 duplicate ledger IDs de-duped (shipped copies kept); parent §7 WS3 row corrected (was stale `NOT STARTED`); files-map extended. ~76 new tests; full web suite green. |
| 2026-07-02 | **Parity WS3 — voice behavioural catch-up shipped (web-only, zero backend).** Items 1/2/3/6/7/9: (1) web `session_start` now advertises `capabilities: { voice_latency: { version: 1, supports: ['low_conf_readback_v1'] } }` (exact parser shape pinned; verified NO client reading-confidence drop filter first) — activates universal read-back for web users after prod verification; `regex_fast_v2`/`client_playback_telemetry` deliberately NOT claimed. (2) Read-back dedupe re-keyed to the full iOS `buildConfirmationDedupeKey` (new `confirmation-dedupe-key.ts`, djb2-UInt64 BigInt, hash vectors generated from the backend mirror; `Confirmation` type +`circuits`/`board_id`). (3) Observation canonical BS 7671 wording end-to-end — `regulation_title`/`regulation_description`/`rationale` decoded (both paths; duplicate dead `observation_update` case deleted), persisted (update-MISS CLEARS stale wording), rendered in iOS card order. (6) LIM sentinel audit: web already iOS-identical — 9 regression tests added, zero runtime gaps. (7) **TranscriptGate full literal port** (`transcript-gate.ts`, all branches + trigger arrays) wired in `dispatchFinal` with non-mutating ask peeks (`peekPayloadForTranscript`/`clearExpiredSlot`), `playSentForProcessingChime()` (sample-accurate `makeChimeWAVData` port) on gate PASS only; tour switched to the shared helper, tour-local synth deleted. BEHAVIOUR CHANGE: web chitchat no longer reaches Sonnet. (9) `surge_*` sweep complete (voice-apply routing pinned; fallback-removal parity verified); EIC divert-to-comments voice apply added (EIC-only newline-append; form cell pre-existed); `ask_user.context_board_id` RECLASSIFIED backend-internal (neither client decodes it — checklist/ledger/files-map corrected). Items 4/5/8 (fast-path TTS, playback telemetry, TTS FIFO) NOT shipped — owned by named follow-up `parity-ws3b-voice-latency-2026-07` (dated ledger rows). Ledger: 7 rows → `match`, capability row `partial` pending post-deploy CloudWatch `voice_latency.startup_log` evidence (two-phase). |
| 2026-06-26 | **ElevenLabs model consolidation A + A2 (backend, live).** A: non-streaming TTS proxy (`POST /api/proxy/elevenlabs-tts`, `keys.js`) switched `eleven_turbo_v2_5` → `eleven_flash_v2_5` — the streaming WS path already ran Flash, so every live TTS path is now one model. Contract-preserving for iOS/web (same Archer voice, same default `mp3_44100_128`, same `voice_settings`); audio bytes unchanged, no client rebuild. Flash & Turbo bill identically (both 0.5 credits/char since ElevenLabs' Aug-2024 Turbo cut), so live cost is unchanged — the win is lower first-byte latency. A2: `cost-tracker.js` ElevenLabs accounting made per-model — `ELEVENLABS_RATE_PER_CHAR_BY_MODEL` map (Flash/Turbo $0.00005/char, Multilingual-v2/v3 $0.0001/char), `ELEVENLABS_RATE_PER_CHAR` kept as the unknown-model fallback, `DEFAULT_ELEVENLABS_MODEL_ID = eleven_flash_v2_5`. Single `elevenLabsCharacters` scalar replaced by per-model `elevenLabsCharsByModel` buckets; `elevenLabsCharacters` is now a derived getter (sum of buckets, back-compat for `toCostUpdate`); `elevenLabsCost` getter sums each bucket × its rate. `modelId` threaded through all three char accumulators (`addElevenLabsUsage`, `recordElevenLabsStreamingStarted`, `recordElevenLabsSpeculativeStarted`), their `active-sessions.js` wrappers, and the call sites (`keys.js:650` proxy → flash, `keys.js:259` streaming → `client.modelId`, `loaded-barrel-speculator.js` → `client.modelId`), each defaulting to Flash. Fast-TTS route (`voice-latency-fast-tts.js`) has no cost attribution today — left out of scope. 4952 backend tests green (+8 new per-model cost tests). v3 is the offline tour-audio model (item B, iOS) and is NOT session-attributed. |
| 2026-06-25 | **Observation-feedback follow-ups (#49 + #52 Fix B, obs-followups-2026-06-23 plan).** #49 — EIC observation-handling made PROACTIVE: the state-snapshot prefix now carries a `CERTIFICATE TYPE: EIC` line (`_computeSnapshotParts`, emitted UNCONDITIONALLY for EIC even on an empty session — before the `isEmpty` early-return, so the steer is present from turn 1; flips empty-EIC `buildStateSnapshotMessage` null→non-null), and RULE 0 in `sonnet_agentic_system.md` gains a proactive clause keyed off it (don't call `record_observation` on an EIC → go straight to the comments ask; reactive reject path stays as defence-in-depth). EICR path byte-unchanged (line is EIC-only → cache untouched). #52 Fix B — canonical BS 7671 `regulation_title`/`regulation_description` now carried END-TO-END on every `observation_update` path: `renameObservationsForLegacyWire` + both refinement (BPG4) payloads + the RULE-6 edit payload (`dispatchObservationUpdates`), each running its own `lookupRegulation(ref)` (import added to `sonnet-stream.js`), null-fallback on a table MISS. Backend-only this cycle; iOS card render (`SonnetObservation`/`JobObservation`/`ObservationUpdate` + `ObservationCardView`) ships next TestFlight. 4904 backend tests green. |
| 2026-06-18 | **Universal read-back + conversational correction (Option B, never-clear)** — backend Phase A. (1) FINAL read-back no longer gates on the model's self-reported confidence; every applied reading is read back (`stage6-event-bundler.js`); `CONFIRMATION_MIN_CONFIDENCE` is now only the loaded-barrel speculator gate. (2) Confirmation debounce re-keyed field+circuit+board+value (was field-only, which dropped same-field different-circuit second read-backs). (3) Auto-derivations (`::calc::` / `derived:true` mirror) exempt from read-back. (4) Prompt CONFIDENCE SCORING rewritten to diagnostic-only — structurally complete readings WRITE at any confidence (supersedes the "low-confidence ASK" invariant 2 stance). (5) bare-`no`/`nope`/`nah` forward through the pre-LLM gate. (6) Rolling ~3-turn context window fed to the live model so it resolves a bare "no" from the read-backs it spoke; bare "no" after a read-back → apologetic re-ask, NEVER `clear_reading` (value persists until a clear replacement overwrites). (7) `low_conf_readback_v1` capability PRE-APPLY gate on `< 0.5` writes; `context_board_id` threaded through `ask_user` schema + all 3 auto-resolve write sites + ask-budget key. NOTE: the §6 round-1 `tool_choice:any` no-op allowance was dropped during the PR #60 rebase — PR #60 removed the round-1 tool_choice force entirely, so the model already no-ops by default. iOS Phase B (drop `< 0.5` client filter, relax `TranscriptGate`, advertise capability) is a follow-on TestFlight cycle. |
| 2026-06-18 | **Audio-First Design Principles** added to hub + iOS AGENTS.md — product direction shift to hands-free AirPods use (no eyes on screen). Three MANDATORY invariants: (1) every dictated reading read back aloud exactly once, never silently entered into the UI — all apply paths, with auto-derivations (polarity tick, mirrors) exempt by design; (2) low-confidence readings ASK rather than silently drop (supersedes the `CONFIRMATION_MIN_CONFIDENCE` suppress stance); (3) latency is first-class. Supersedes older screen-first / minimise-TTS-chatter guidance. Spans backend extraction/confirmation synthesis + iOS TTS. |
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

- **PWA replay harness** (2026-07-08): composition-level web-pipeline replay + iOS differential + generated field sweep — see `docs/reference/pwa-replay-harness.md`; commands `npm run pwa-replay`, `pwa-replay:session`, `pwa-replay:sweep`.
