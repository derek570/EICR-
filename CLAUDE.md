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

> **MANDATORY — Web companion required for every client-visible change.**
> - *Every* plan/wave that changes voice UX, wire shapes, or client-visible behaviour MUST contain a **"Web companion"** section: either the web change ships in the same wave, or a dated `web/docs/parity-ledger.md` row **with an owner** + a todo records the deliberate lag. "Deferred with no owner" is not an allowed state.
> - **Why:** the iOS+backend ship loop (field feedback → plan → TestFlight + ECS) had no web step; between 2026-06-17 and 2026-07-01 ~8 voice waves shipped backend+iOS companions and ZERO web companions, leaving MANDATORY audio-first behaviour (universal read-back) dormant for web users. This rule is the WS1 drift-stop of the iOS↔Web Full-Parity Program.
> - **How to apply:** when writing or reviewing a plan, ask "does a web user see this change?" (new wire fields, changed frames, spoken UX, visible behaviour). If yes and the plan has no Web-companion section, add one — or add the dated ledger row + todo — before the plan converges. CI warns on PRs touching files whose ledger rows are >30 days unverified (`scripts/check-parity-ledger.mjs`).

Automated EICR/EIC certificate creation for electrical inspectors using an iOS-first workflow.

## Project Overview

1. **Photo Capture** - Inspector photographs consumer unit (CCU) via iOS app
2. **CCU Analysis** - GPT Vision extracts circuit data from consumer unit photos
3. **Document Extraction** - GPT Vision extracts certificate data from previous certificates, handwritten notes, or photos
4. **Voice Recording** - Inspector dictates test readings and observations into iOS app
4. **Live Transcription** - Deepgram Flux transcribes speech in real time (direct from iOS; `flux-general-en` on `/v2/listen`). Web still uses Nova-3 until the WS4 Flux migration lands
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
| Transcription | Deepgram Flux `flux-general-en` (direct WebSocket from iOS, `/v2/listen`); web remains Nova-3 `/v1/listen` until WS4 |
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
- **Next candidates:** Playwright E2E coverage for offline-sync. (`queueSaveJob` IS wired into JobProvider's save path at `web/src/lib/job-context.tsx:159` — verified 2026-07-02; the earlier "no production caller yet" note was stale.)
- **SHIPPED 2026-07-02 (WS2), awaiting iPad field smoke:** PWA observation-photo auto-link — the parked 2026-05-13 branch was rebased onto main and merged. Ledger row `observations/obs-photo-autolink` stays `partial` until the iPad Safari device smoke passes (todo in vault `todos-certmate.md`); two dated deliberate divergences on the row (no CCU picker source — zero-backend; web-extra camera/library chooser).
- **OPEN FOLLOWUP 2026-06-05 — voice-latency Phase 2.2 (deferred from PR #52, merged).** Surface proactively on any voice-latency or field-test discussion. Pick server `FINALIZER_TIMEOUT_MS` widen vs iOS Apple-native `local_fallback` emit once 1–2 field sessions hit the deployed code. Runbook: [CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md](../CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md).

## Changelog

Recent changes — one line each. **Full commit-body-level detail in [docs/reference/changelog.md](docs/reference/changelog.md)**; use `git log` for everything else.

| Date | Summary |
|------|---------|
| 2026-07-02 | **Parity WS6 — workflow completion shipped (web-only, zero backend).** All six WS6 items: (1) CCU **Add Off-Peak Board** mode, full path — 6th mode-sheet tile (iOS copy/visibility), `applyAddOffPeakBoardMode` via a shared appended-board applier (`board_type='off_peak'`, designation "Off-Peak Board", sibling of main, supply untouched), localStorage last-mode guard 5→6, circuits-page hint/success/post-apply selection, Board tab `off_peak` option + parent-clear on type flip (`off_peak` already in the wire `BoardType` union — no backend). (2) **Pending-CCU queue** — IDB `pending-ccu-extraction` store (`certmate-cache` v5), persist-before-upload, ONE idempotency key per capture reused on every retry (`analyzeCCU` sends `X-Idempotency-Key`; backend `withIdempotency('ccu')` already live), 409-inflight honours `Retry-After: 5`, **terminal 422 retake** (entry dropped + retake card — web previously had zero `retake_required` handling), circuits-page banner (thumbnails, Retry/Retry-All, auto-retry on `online`) + Overview "photos waiting to upload" pill; CCU photos ONLY (doc path test-pinned queue-free). (3) **Tour v11** — 2+9=11 steps incl. new `job-tone` "conversational + tone" step playing a sample-accurate `makeChimeWAVData` port synthesised LOCALLY in `lib/tour/tour-chime.ts` (WS3 unmerged at ship — symbol-checked; WS3 item 7 owns the switch to `playSentForProcessingChime()`); Defaults narration shortened + Observations step de-staled per the 2026-06-30 iOS revision. (4) **Offline dirty-guard** audited: guard pre-existed (`job-context.tsx:121-138`); newer-`updated_at`-while-dirty regression tests added. (5) **Doc-extraction parity VERIFIED** (12-file cap, image+PDF, whole-batch failure surfacing) — no code change. (6) **Job-creation defaults ladder** — after `createJob`: fetch detail → 0 presets: literal `applyStandardDefaults` port / 1: auto-apply / 2+: `PresetPickerSheet` with Skip → persist (`queueSaveJob` + cache warm) → navigate. Ledger: 10 WS6 rows → `match` (dated), INDEX-2026-07 WS6 gaps closed, parity file-map extended; parent program §7 WS6 → DONE. |
| 2026-07-02 | **Parity WS0 item 4 — visual baseline captured (tests-e2e/audit only, zero backend, zero web/src).** Web COMPLETE: all 14 screens ×2 viewports vs production via authenticated `web/tests-e2e/visual-baseline-capture.mjs` (programmatic login; T&Cs/tour gates pre-seeded device-locally). iOS EICR set captured on simulator via temporary XCUITest driver (reverted; pbxproj regen = CertMateUnified #31). 10 iOS EIC screens still blocked: `deduplicateApiJobs` drops same-address jobs — EIC fixture invisible on iOS (bug logged, not fixed). 3 bugs recorded: iOS address-dedupe; web login rejects `company_id:null` (schema `.nullable()` missing); all web dialogs double-offset (Tailwind v4 `translate` + `.cm-dialog-content` transform). Evidence for WS6 off-peak + WS3 obs-wording gaps. `web/audit/visual-baseline-2026-07/MANIFEST.md`; PR #72. |
| 2026-07-02 | **Parity WS2 — PWA observation-photo auto-link rebased + shipped (web-only, zero backend).** The parked 2026-05-13 branch (4 commits `e880043d` forward-link / `efe7449b` capture handler + image-resize / `b0730325` Photo button / `577f8107` unassigned pool + From-Job picker, substance preserved via cherry-pick) replayed onto main. Real conflict set was ONE keep-both hunk in `recording-context.tsx` (the old HANDOFF's heavy-collision prediction was stale; `apply-extraction.ts` merged clean). Two contract fixes vs the current backend wire: `unassigned_photos` declared in strip-mode `JobDetailSchema` (`adapters/job.ts` — was silently dropped by `api.job()`) and retyped `string[] \| null` in `types.ts` (GET emits `null` on blank-slate jobs); + duplicate-toast-import and unused-import rebase cleanups. iOS canon re-verified against CURRENT refs (`DeepgramRecordingViewModel.swift:1094/2257/7262`); two dated deliberate divergences on ledger row `observations/obs-photo-autolink` (no CCU picker source — no web-persisted `ccu_photo_path`, zero-backend rule; web-extra camera/library chooser). Gates: 1099 web + 4952 backend tests, build green; typecheck/lint at main baseline (zero new). Ledger row `partial` + INDEX-2026-07 gap open pending iPad Safari device smoke (upload-during-resize race is runtime-only); todo in vault todos-certmate.md. |
| 2026-07-02 | **Parity WS0+WS1 (docs/CI only, zero backend).** WS0 audit refresh: tab gating re-verified vs `JobDetailView.swift:472-536` (no re-drift); wire-shape audit of PRs #58–#70 → `web/audit/ws3-checklist-2026-07.md`; ledger sweep adds stable `id` + `last-verified` columns (367→396 rows, 29 program gap rows WS2–WS9, `backend` status retired, backend-defaults claims rewritten frontend-only); `web/audit/INDEX-2026-07.md` supersedes `INDEX.md`; parked obs-photo branch pushed to origin; Flux/queueSaveJob doc fixes. WS1 governance: MANDATORY web-companion rule (hub + CertMateUnified `9a91c5d`, which also fixes invariant #2 + domain + `../EICR_App/` paths); warn-only `parity-ledger-warn` CI job (PR-only, `continue-on-error`, no dependants) + `scripts/check-parity-ledger.mjs` + `web/docs/parity-ledger-files.json`; fixture dry-runs prove all warn conditions exit 0; drift-check/JWT_SECRET/IAM merge-gate verifications passed. Reviewer checklist + quarterly re-audit todo in user-level agent + vault. |
| 2026-06-26 | **ElevenLabs model consolidation A + A2 (backend, live).** A: non-streaming TTS proxy (`POST /api/proxy/elevenlabs-tts`, `keys.js`) switched `eleven_turbo_v2_5` → `eleven_flash_v2_5` — the streaming WS path already ran Flash, so every live TTS path is now one model. Contract-preserving for iOS/web (same Archer voice, same default `mp3_44100_128`, same `voice_settings`); audio bytes unchanged, no client rebuild. Flash & Turbo bill identically (both 0.5 credits/char since ElevenLabs' Aug-2024 Turbo cut), so live cost is unchanged — the win is lower first-byte latency. A2: `cost-tracker.js` ElevenLabs accounting made per-model — `ELEVENLABS_RATE_PER_CHAR_BY_MODEL` map (Flash/Turbo $0.00005/char, Multilingual-v2/v3 $0.0001/char), `ELEVENLABS_RATE_PER_CHAR` kept as the unknown-model fallback, `DEFAULT_ELEVENLABS_MODEL_ID = eleven_flash_v2_5`. Single `elevenLabsCharacters` scalar replaced by per-model `elevenLabsCharsByModel` buckets; `elevenLabsCharacters` is now a derived getter (sum of buckets, back-compat for `toCostUpdate`); `elevenLabsCost` getter sums each bucket × its rate. `modelId` threaded through all three char accumulators (`addElevenLabsUsage`, `recordElevenLabsStreamingStarted`, `recordElevenLabsSpeculativeStarted`), their `active-sessions.js` wrappers, and the call sites (`keys.js:650` proxy → flash, `keys.js:259` streaming → `client.modelId`, `loaded-barrel-speculator.js` → `client.modelId`), each defaulting to Flash. Fast-TTS route (`voice-latency-fast-tts.js`) has no cost attribution today — left out of scope. 4952 backend tests green (+8 new per-model cost tests). v3 is the offline tour-audio model (item B, iOS) and is NOT session-attributed. |
| 2026-06-25 | **Observation-feedback follow-ups (#49 + #52 Fix B, obs-followups-2026-06-23 plan).** #49 — EIC observation-handling made PROACTIVE: the state-snapshot prefix now carries a `CERTIFICATE TYPE: EIC` line (`_computeSnapshotParts`, emitted UNCONDITIONALLY for EIC even on an empty session — before the `isEmpty` early-return, so the steer is present from turn 1; flips empty-EIC `buildStateSnapshotMessage` null→non-null), and RULE 0 in `sonnet_agentic_system.md` gains a proactive clause keyed off it (don't call `record_observation` on an EIC → go straight to the comments ask; reactive reject path stays as defence-in-depth). EICR path byte-unchanged (line is EIC-only → cache untouched). #52 Fix B — canonical BS 7671 `regulation_title`/`regulation_description` now carried END-TO-END on every `observation_update` path: `renameObservationsForLegacyWire` + both refinement (BPG4) payloads + the RULE-6 edit payload (`dispatchObservationUpdates`), each running its own `lookupRegulation(ref)` (import added to `sonnet-stream.js`), null-fallback on a table MISS. Backend-only this cycle; iOS card render (`SonnetObservation`/`JobObservation`/`ObservationUpdate` + `ObservationCardView`) ships next TestFlight. 4904 backend tests green. |
| 2026-06-18 | **Universal read-back + conversational correction (Option B, never-clear)** — backend Phase A. (1) FINAL read-back no longer gates on the model's self-reported confidence; every applied reading is read back (`stage6-event-bundler.js`); `CONFIRMATION_MIN_CONFIDENCE` is now only the loaded-barrel speculator gate. (2) Confirmation debounce re-keyed field+circuit+board+value (was field-only, which dropped same-field different-circuit second read-backs). (3) Auto-derivations (`::calc::` / `derived:true` mirror) exempt from read-back. (4) Prompt CONFIDENCE SCORING rewritten to diagnostic-only — structurally complete readings WRITE at any confidence (supersedes the "low-confidence ASK" invariant 2 stance). (5) bare-`no`/`nope`/`nah` forward through the pre-LLM gate. (6) Rolling ~3-turn context window fed to the live model so it resolves a bare "no" from the read-backs it spoke; bare "no" after a read-back → apologetic re-ask, NEVER `clear_reading` (value persists until a clear replacement overwrites). (7) `low_conf_readback_v1` capability PRE-APPLY gate on `< 0.5` writes; `context_board_id` threaded through `ask_user` schema + all 3 auto-resolve write sites + ask-budget key. NOTE: the §6 round-1 `tool_choice:any` no-op allowance was dropped during the PR #60 rebase — PR #60 removed the round-1 tool_choice force entirely, so the model already no-ops by default. iOS Phase B (drop `< 0.5` client filter, relax `TranscriptGate`, advertise capability) is a follow-on TestFlight cycle. |
| 2026-06-18 | **Audio-First Design Principles** added to hub + iOS CLAUDE.md — product direction shift to hands-free AirPods use (no eyes on screen). Three MANDATORY invariants: (1) every dictated reading read back aloud exactly once, never silently entered into the UI — all apply paths, with auto-derivations (polarity tick, mirrors) exempt by design; (2) low-confidence readings ASK rather than silently drop (supersedes the `CONFIRMATION_MIN_CONFIDENCE` suppress stance); (3) latency is first-class. Supersedes older screen-first / minimise-TTS-chatter guidance. Spans backend extraction/confirmation synthesis + iOS TTS. |
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
