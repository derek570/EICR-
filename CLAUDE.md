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

Do **not** use the local `./deploy.sh` quick-deploy script even though it exists in the repo. Docker Desktop is not kept running on the dev Mac, so the script fails immediately, and its `tee`-wrapped invocation masks the failure as exit 0. CI is the only deploy path that works reliably.

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

- **⚡ CCU pipeline — CURRENT STATE as of 2026-05-08:** single-shot `gpt-5.5` over the whole image via `src/extraction/ccu-single-shot.js`. Returns slot enumeration + device classification + labels in ONE VLM call. **No per-slot cropping is performed in the current pipeline.** The Stage-3/Stage-4 per-slot Sonnet pipeline (`ccu-geometric.js`, `ccu-label-pass.js`) is LEGACY FALLBACK only, gated behind `CCU_USE_SINGLE_SHOT=false` (production runs with single-shot on). When reasoning about CCU extraction failures, do NOT consider CV crop accuracy or slot crop boundaries as failure modes — they're not in the live path. Failure modes that ARE in scope: gpt-5.5 mis-counting slots in long identical-MCB runs, gpt-5.5 mis-aligning labels to slot columns, post-merge enrichment overrides (e.g. RCD waveform web search), `slotsToCircuits` phase-walking heuristics. Full details: [docs/reference/architecture.md#ccu-photo-extraction-pipeline](docs/reference/architecture.md#ccu-photo-extraction-pipeline). Historical per-slot crop pipeline entries (changelog rows 2026-04-22, 2026-04-29, 2026-04-30 below) are RETAINED for git-archaeology but DO NOT describe the live system.
- **Web rebuild shipped to production 2026-04-18** via PR derek570/EICR-#1 (merge commit `9202351c`). `web-rebuild` merged into `main`; branch retained for reference. certmate.uk now serves the Next 16 / React 19 / PWA client from `web/`; `eicr-pwa` + `eicr-backend` ECS services updated (task defs `eicr-pwa:30`, `eicr-backend:27`), smoke tests green.
- Deepgram auto-sleep (3-tier Active/Dozing/Sleeping) + server-side Sonnet v3 multi-turn — live in production.
- Next candidates: debounced-save flush wiring `queueSaveJob` into JobProvider's save path (outbox is plumbed but has no production caller yet); Playwright E2E coverage for offline-sync flows.
- **PARKED 2026-05-28:** PWA observation-photo auto-link sprint (Phases 3–6, 4 commits + 33 tests) lives on `origin/pwa-observation-photo-autolink-2026-05-13`. Code complete, awaiting rebase against the 172 commits main has gained since 2026-05-13 (heavy collision in `web/src/lib/recording-context.tsx`). Full resumption playbook: [.planning-stage6-agentic/handoffs/pwa-observation-photo-autolink-2026-05-13/HANDOFF.md](.planning-stage6-agentic/handoffs/pwa-observation-photo-autolink-2026-05-13/HANDOFF.md).
- **OPEN FOLLOWUP 2026-06-05 — voice-latency Phase 2.2 (deferred from PR derek570/EICR-#52).** PR #52 ships server-side `utterance_id` envelope-echo + new `voice_latency.turn_perceived_latency_ms` store. Phase 2.2 (4/11 eligible-no-ack turns from driver session 84CE2125) was DEFERRED because the right shape — server `FINALIZER_TIMEOUT_MS` widening (8 s → 16 s) vs iOS Apple-native `local_fallback` emit (TestFlight) — needs post-deploy CloudWatch evidence from the new `voice_latency.turn_perceived_latency_skipped` event. **Future-session trigger:** on any voice-latency conversation, OR after Derek mentions a field session, OR if PR #52 has merged — run the decision tree at [CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md](../CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/FOLLOWUP.md) and surface the recommendation. Auto-archive when all 4 closure conditions in the followup file are met.

## Changelog

Recent changes (one line each). Full commit-body-level detail in [docs/reference/changelog.md](docs/reference/changelog.md); use `git log` for everything else.

| Date | Summary |
|------|---------|
| 2026-06-04 | **iOS Fix D — reconcile voice path with Fix B's `spd_*` canonicalisation (D1 + D2).** Post-Fix-B (`345648b0`) audit found two legacy iOS surfaces still routing inspector *"main fuse"* / *"supply fuse"* / *"cutout"* vocabulary onto the `mainSwitchBsEn` / `mainSwitchCurrent` slots — producing a dual-write where the regex / alias path sets the consumer-unit-isolator slot while Sonnet's canonical `spd_bs_en` write goes to the SPD slot, leaving both PDF cells populated with the same value (the DNO cutout is NOT the consumer-unit isolator). **D1 (`a62000e`):** drops `main_fuse_bs_en` / `main_fuse_type` / `main_fuse_rating` / `main_fuse_current` / `supply_fuse_rating` from the `applySonnetReadings` apply-switch case heads at `DeepgramRecordingViewModel.swift:5400/5407`; adds the five canonical `spd_*` keys to `Self.supplyFields` so Sonnet's `circuit == -1` writes via `record_board_reading` rescue through (silent-drop fix per the SUPPLY vs MAIN SWITCH DISAMBIGUATION prompt block — same bug class as the 2026-04-27 Ivydene Road `ir_test_voltage_v` drop); adds `Self.deprecatedSupplyAliases` static + drop guard around `:4748` that warns `deprecated_main_fuse_alias_dropped` + `continue`s instead of buffering (any backend regression now surfaces in CloudWatch instead of silently mirroring into the wrong slot); retargets the four `spd_*` apply-switch `displayKeyword` strings + adds four lowercase `keywordAliases` entries so transcript highlighting matches inspector vocabulary; appends a same-file (SE-0169) test seam at file bottom (`_test_applySonnetReadings`, `_test_applyRegexMatches`, `_test_pendingReadingsCount`). New `Tests/CertMateUnifiedTests/Recording/DeepgramRecordingViewModelAliasTests.swift` adds parameterised drop-guard tests across all 6 legacy keys (`(a)` no slot mutated, `(b)` not buffered, `(c)` warn payload preserves field name + circuit), per-slot rescue tests for the 5 spd_* additions, and a dual-write regression test feeding both `main_fuse_bs_en` and `spd_bs_en` in one batch (proves only `spdBsEn` populates). `SchemaCoverageRescueTests` adds 5 spd_* members to `mustBeRescued` and a `testDeprecatedAliasesDisjointFromSupplyFields` invariant lock that prevents a future contributor "tidying up" the deprecated list from silently moving an spd_* into the drop guard. Pre-existing test infra blockers also fixed in this commit (folded in to make D1's xcodebuild test gate work): `Tests/CertMateUnifiedTests/Mocks/MockAlertManager.swift` gains the three voice-latency Phase 1 protocol stubs (`markFastPathPending`, `markFastPathFailed`, `playFastPathAudio`) added on 2026-05-26; `project.yml` gains `SWIFT_OBJC_BRIDGING_HEADER: "Sources/CertMateUnified-Bridging-Header.h"` so XcodeGen regenerations don't lose the bridging header (the original pbxproj had it but project.yml didn't, so the first xcodegen of the session dropped it and AudioEngine.swift failed to compile). **D2 (`b54cb75`):** splits four supply-side regex patterns at `TranscriptFieldMatcher.swift:642/646/651/655` into SPD vs main-switch variants — `mainFuseBsEnPattern` widened to REQUIRE a `bs\s*(?:en\s*)?` prefix (no `?` after — preventing dual-write with the rating branch) + digit-anchored `[0-9][0-9A-Za-z\s\-]{0,30}?` capture (preserves *"88-2"* / *"88 type gG"* / *"60898"* verbatim per the prompt's strip-only-leading-BS rule) + value-verbatim assign (no enum-coerce for SPD path); `mainSwitchBsEnPattern` keeps the bare-number capture + bsEnMap enum-coerce for the closed-enum Constants picker; `mainFuseRatingPattern` / `mainSwitchRatingPattern` split with explicit anchor (the original generic `current rating` alternative dropped to prevent bare-utterance silent misrouting); `mainFuseBsEnLimPattern` / `mainFuseLimPattern` likewise split. `SupplyUpdates` struct gains `spdBsEn` + `spdRatedCurrent` staging slots + extended `isEmpty` gate (without the `isEmpty` extension, supply-only transcripts silently no-op the apply block). New apply-path consumer blocks in `DeepgramRecordingViewModel.swift` after line 4369 wire the staging slots into `supplyCharacteristics.spd*` via the existing `applyRegexValue` helper — without these the staging fills but never reaches the form during the ~1-2s pre-Sonnet window. 14 new positive + negative tests in `TranscriptFieldMatcherTests.swift` (CutoutVocabulary / ServiceFuseVocabulary / NoBsPrefixDoesNotMatchValueBranch / LimGuardFiresOnSupplyPath / BareCurrentRatingNoLongerMatches et al — REQUIRED dual-write negatives plus inspector-vocabulary coverage). 3 new regex-apply round-trip tests in `DeepgramRecordingViewModelAliasTests.swift` use D1's `_test_applyRegexMatches` seam. **D3 (locked D3-KEEP, no commit):** per-board PDF cell at `EICRHTMLTemplate.swift:1518` (`Main Switch BS (EN): {board.mainSwitchBsEn}`) stays unchanged — terminology is semantically correct (consumer-unit isolator); the SPD section at line 821 (and alternate at 1153) renders `supply?.spdBsEn` and already disambiguates via its prominent "Supply Protective Device" header. The voice-path dual-write Fix D1+D2 close affects the supply-row cells at lines 866 + 1196 (`supply?.mainSwitchBsEn`), NOT the per-board cell at 1518 (which is populated by the CCU pipeline + manual board-detail entry, not the voice path). **D4 (deferred):** `FuseboardAnalysis` naming divergence audit (`spdRatedCurrentA` / `spdShortCircuitKa` with units in CodingKey suffix vs live-voice-path `spd_rated_current` / `spd_short_circuit`) pending fresh CCU CloudWatch payload audit per Sequencing step 5. **iOS-only — no backend changes**, per Fix B's already-shipped server-side canonicalisation. **`xcodebuild build-for-testing` proven green during D1 commit;** D2 build verification blocked this session by CoreSimulatorService `POSIXErrorDomain 12 "Cannot allocate memory"` (system at ~57 MB free of 17 GB; D2 source changes are structurally minimal additions on the proven D1 base). User-to-rerun `xcodebuild test` after freeing memory + before merge. Concurrent session shipped `8b51418` (tts-dedup confirmation key) on the same branch in parallel — preserved cleanly via stash-pop. NOT yet pushed; NO TestFlight deploy without explicit user approval per standing rule. Plan: `.planning/plan-voice-correctness-d-ios-reconcile-2026-06-04-final.md`. |
| 2026-06-03 | **Voice fix: three F03B590C defects closed — FIELD-AMBIGUITY field menu dropped, "main fuse" routes to `spd_*`, speculator skips off-enum round-1 synth.** Field-test session `F03B590C-7BDA-41BB-AD99-5B27A9CBFF76` (2026-06-03 20:03-20:04 UTC) against the just-deployed observation-correctness sprint surfaced three distinct voice-side defects. Fix A (`e0d5da92`, prompt + test): turn 8 inspector said *"My net is 16 mil"* (Deepgram garble of "mains earth"); Sonnet asked *"…is it R1+R2, Zs, IR, polarity, or number of points?"* — the 5-field menu inside FIELD-AMBIGUITY RULE and inside RULE 5's allow-list example covered only 5 of ~25 circuit fields and ZERO board/supply fields, so the inspector's free-form *"Its main earth."* didn't fit. Canonical ask shape rewritten to a single open question (*"For circuit N, what was that reading for?"* / *"What was that '<value>' for?"*); RULE 5's duplicate menu deleted; prompt-wide regex regression-lock `/Zs.*R1.*IR.*polarity.*number of points/i` added in `stage6-agentic-prompt.test.js` Group 12 + new Group 13 Fix B coverage. Fix B (`345648b0`, prompt + confirmation table + tests): turn 9 inspector said *"Main fuse is BS 1361"* — Sonnet wrote `record_board_reading {field:"main_switch_bs_en", value:"BS 1361"}` (WRONG field — `spd_bs_en` is the canonical home; `field-name-corrections.js:105-108` already maps `main_fuse_bs_en` → `spd_bs_en` but the prompt never named the boundary) AND TTS spoke *"main switch BS EN BS 1361"* (doubled BS + wrong device vocabulary). New SUPPLY vs MAIN SWITCH DISAMBIGUATION prompt block (between ZE/ZS DISAMBIGUATION and OBSERVATIONS) teaches the boundary with explicit value-kind mapping (BS → spd_bs_en, amps → spd_rated_current, kA → spd_short_circuit, type-alone → spd_type_supply) plus the "strip the leading BS" rule that prevents the doubled-BS TTS. Five new `CONFIRMATION_FRIENDLY_NAMES` entries (`spd_bs_en` → "main fuse BS EN", `spd_rated_current` → "main fuse rating", `spd_short_circuit` → "main fuse breaking capacity", `spd_type_supply` → "main fuse type", `main_switch_bs_en` → "main switch BS EN") matching the inspector-vocabulary aliases iOS already uses in `DeepgramRecordingViewModel.swift:5232`. Token caps bumped per the plan's measured re-verification: standalone 7500 → 7850, combined 12500 → 12950. Fix C (`03feaece`, speculator gate + tests): also turn 9 — the dispatcher rejected the off-enum `"BS 1361"` at 20:04:24.366 but the Loaded Barrel speculator's `onToolUseStreamed` hook had already started ElevenLabs synth and shipped TTS *"main switch BS EN BS 1361"* at 20:04:24.812 before the round-2 canonical `"1361 type 1"` landed at 20:04:25.748. Round-2 bundler emit at 20:04:27.291 was correctly deduped at iOS but the act of dispatching it disturbed the audio session and truncated TTS #1 mid-speech (`audio_finalizer_timeout_fired:true`, empty `ios_playback_ack[]`). New gate in `loaded-barrel-speculator.js`'s `onToolUseStreamed` (just after the `coerceRecordReadingValue`/`coerceRecordBoardReadingValue` coercion, before `_speculate(...)`) checks `BOARD_FIELD_VALUE_ENUMS` / `CIRCUIT_FIELD_VALUE_ENUMS` from `stage6-dispatch-validation.js`; when the coerced value is off-enum, returns early after emitting `voice_latency.speculator_skipped_enum_field` to CloudWatch. Policy is VALUE-AWARE (not field-aware) so the speculator's latency win is preserved for legitimate enum values — only the round-1 values the dispatcher would reject are skipped. `makeSpeculator` test helper extended to thread a logger so tests can spy on the new log row. Schema-lock tests in `stage6-dispatch-validation-enum.test.js` pin `main_switch_bs_en` IN `BOARD_FIELD_VALUE_ENUMS`, `ocpd_bs_en`/`rcd_bs_en` IN `CIRCUIT_FIELD_VALUE_ENUMS`, and `spd_bs_en` INTENTIONALLY absent from the BOARD map (it's `type:"text"` — no enum constraint means no round-1/round-2 split for `spd_bs_en` writes; the speculator must keep firing pre-synth on `spd_bs_en` for the latency win). Fix D (iOS TTS echoes inspector's spoken term + form/PDF/code reconcile to `spd_*` namespace) deferred — requires TestFlight cycle. PR #47 merged via `27500d9d`; CI run 26916177650; deployed task def `eicr-backend:289`. 4459/4459 active backend tests passing (1 pre-existing CCU autocorr statistical flake unrelated). Plan: `.planning/plan-voice-correctness-2026-06-03b-final.md`. Manual field-test gate pending: (a) *"My net is 16 mil"* (Fix A — single open ask), (b) *"Main fuse is BS 1361 type 1"* (Fix B — routes to `spd_bs_en` with TTS *"main fuse BS EN 1361 type 1"*), (c) *"Main switch is BS 1361"* (Fix C — `voice_latency.speculator_skipped_enum_field` log row + no round-1 TTS leak + single round-2 TTS). |
| 2026-05-31 | **Voice fix: RCBO walk-through asked "What's the BS number?" twice for two distinct fields + Deepgram defer garbles ignored.** Field repro session E8C6B716-547A-454C-A507-5D3079F7E24D (~22:14 UTC): inspector auto-pivoted into the RCBO walk-through via "Our type is a c for circuits 4 to 7" → engine asked "What's the BS number?", inspector replied "61008" (the BS code for a stand-alone RCD). Engine wrote `ocpd_bs_en` = "BS EN 61008" but the existing mirror derivation on that slot was gated on `value: '61009'` only, so `rcd_bs_en` stayed empty; `nextMissingSlot` then picked it and the engine re-emitted the IDENTICAL TTS prompt "What's the BS number?" — same wording, different field, no audible distinction. Inspector reasonably concluded the system had lost their answer and tried four times in 12 s to defer with Deepgram-clipped phrasings ("you filled in.", "in later.") that the engine's `deferTriggers` regex set didn't recognise; the prompt looped every ~6 s and the session ended at "Oh, fuck off." then "I give up. Stop." (cancel, 3 of 7 RCBO slots saved). Two-part fix: (1) `applyDerivations` (`src/extraction/dialogue-engine/helpers/derivations.js`) gains "unconditional" semantics — a derivation with `value` omitted matches every write to that slot; rcbo.js's `ocpd_bs_en` mirrors to `rcd_bs_en` unconditionally (was `{ value: '61009', mirrors: ['rcd_bs_en'] }`); `rcd_bs_en` becomes `volunteeredOnly: true` so it's never auto-asked but the namedExtractor still harvests the volunteered "RCD BS code is 61009" form, with a symmetric unconditional mirror back to `ocpd_bs_en`; `rcd_bs_en.question` reworded to "What's the RCD's BS number?" as defence-in-depth. (2) `rcd.js` `deferTriggers` widened — leading-"later" anchor now tolerates ≤ 2 lead words so "in later.", "and later.", "uh later." defer (≥ 3 lead words still rejects to keep "I'll deal with that later" out of the defer path); new short-reply pattern (≤ 30-char prefix + 20-char tail) catches `leave it/that/them`, Deepgram garbles `filled in` / `filed in` / `fill it in`, and `skip for/until later`. Slot-level `acceptsDeferAnswer` gate still applies (only `rcd_bs_en` opts in). Two commits: `104735e2` RCBO mirror, `684d7ffa` defer-trigger widening. New test files `src/__tests__/dialogue-engine-rcbo-bs-mirror.test.js` (12 tests) + `src/__tests__/dialogue-engine-rcd-defer-garbles.test.js` (18 tests). Tracked-as-follow-up scope note (in defer test file): pre-existing verb-prefix patterns (`fill…later` / `do…later` / `(?:come\s+)?back…later`) still match anywhere in the utterance not just at the end, so "come back to it later but right now the BS is 60898" still defers today — separate fix. 4190/4190 backend tests green. |
| 2026-05-31 | **Voice fix: RCD focus loop swallowed observations + blocked "later" defer.** Two distinct bugs in the same field-test thread. (1) Inspector says "Observation: the RCD cover is cracked." intending to log a defect; RCD schema's trigger regex (`rcd.js:107` `\bRCD\b...`) matched the bare mid-sentence "RCD", `runEntry` captured the turn, and the engine emitted "What's the BS number?" — locking out `record_observation`. Fix in `processDialogueTurn` (`src/extraction/dialogue-engine/engine.js`): when no script is active AND `OBSERVATION_PATTERN` (`src/extraction/pre-llm-gate.js:147`) matches, short-circuit to `{handled: false}` so Sonnet records the observation. (2) Once in the RCD loop, inspector's reply "later" to "What's the BS number? Or do you want to fill that in later?" never reached the engine's `deferTriggers` (`rcd.js:148` matches bare `^\s*later[.!?]?\s*$`) — the pre-LLM gate blocked it `LOW_CONTENT` (1 content word, no weak trigger) because dialogue-engine server-side asks deliberately bypass `pendingAsks` (`sonnet-stream.js:~1429`, the `srv-*` toolCallIdPrefix path) so the gate had no signal that a question was on the wire. Fix surfaces `session.dialogueScriptState?.active` to the gate as a new bypass flag `hasActiveDialogueScript` (slotted between `hasPendingAsk` and `inResponseTo`, new `GATE_REASONS.BYPASS_DIALOGUE_SCRIPT_ACTIVE` for CloudWatch); when true the gate forwards unconditionally so the engine's defer/skip/cancel/topic-switch parsers all get a chance to fire on terse replies ("later", "AC", "skip", "blank"). Wired at the gate call site in `sonnet-stream.js`'s `handleTranscript` + added `had_active_dialogue_script` to the `gate_blocked` telemetry payload. Two commits: `45662e0c` gate bypass, `4725afbb` engine observation guard. New test file `src/__tests__/dialogue-engine-observation-prefilter.test.js` + 6 new tests in `src/__tests__/pre-llm-gate.test.js`. 4160/4160 backend tests green. |
| 2026-05-29 | **Prod fix: iOS "Issue certificate" failing with `failed to record attestations`.** Inspector tapped both attestation toggles and got the red error from `IssueCertificateSheet.swift:214`. CloudWatch showed `cert_attestations_accept_failed { error: 'relation "cert_attestations" does not exist' }` — migrations `010_account_consents.cjs` and `011_cert_attestations.cjs` (authored alongside the route code in commit `02e13380`) had never been applied to `eicr-db-production`. CI/CD had no migration step, so `npm run migrate:up` was a manual gate someone had to remember; nobody did. The consent endpoint was silently failing the same way (catch + warn lets the request through) but only cert-attestations surfaced a user-visible 500. Hotfixed by temporarily opening the RDS SG to my Mac IP, running `node-pg-migrate up` (applied 010 + 011), then revoking. Permanent fix: `scripts/migrate-from-secrets.js` fetches `eicr/database` from Secrets Manager and runs `node-pg-migrate up`; `docker/backend.Dockerfile` now `COPY`s `migrations/` and the script into the image; `.github/workflows/deploy.yml` runs the just-registered backend task-def as a one-off Fargate task with a `containerOverrides` command, waits for it to stop, and fails the deploy on non-zero exit before updating the service. Picked Fargate-task-with-override over GH-runner-public-access because the migration then runs from inside the VPC with the same IAM + network the backend already uses — no SG churn per deploy, no GH-runner IP-whitelisting. 11/11 routes-cert-attestations tests still green. |
| 2026-05-28 | **Voice latency: widen early-terminate + Loaded Barrel to cover board readings.** Field telemetry across DFE90C4F / A80BB3AF / BE8D791F (2026-05-27 → -28) showed clean single `record_board_reading` and multi-record turns paying ~1.4-2.5 s of round-2 Sonnet wall despite being structurally as safe as the single `record_reading` turns the predicate already early-terminated. Two commits: `ba7d8e21` widens `shouldEarlyTerminate` (`src/extraction/stage6-early-terminate.js`) to allow N≥1 records of `{record_reading, record_board_reading}` with per-tool bucket-size invariants (`perTurnWrites.readings.size` matches record_reading count, `boardReadings.size` matches record_board_reading count) and a record_reading-only multi-board guard; `b604e7a6` extends Loaded Barrel's Phase 2.D `onToolUseStreamed` hook (`src/extraction/loaded-barrel-speculator.js`) to also fire on `record_board_reading`, recovering the ~500-1000 ms pre-synth lead time board readings previously paid by waiting for `onSnapshotPatch` post-dispatch. Same coercion (`coerceRecordReadingValue`), same friendly-name gate (board fields like `earth_loop_impedance_ze`, `prospective_fault_current` are already in `CONFIRMATION_FRIENDLY_NAMES`). 4066 backend tests passing (44 in early-terminate, 31 in speculator). |
| 2026-05-28 | PWA fix: Circuits tab silently empty for legacy single-board jobs. `parseCSV` (`src/utils/jobs.js:48`) writes `''` for missing cells, so re-saved pre-multi-board CSVs come back with `board_id: ''` on every legacy circuit; the Circuits-tab filter at `web/src/app/job/[id]/circuits/page.tsx:185` used `c.board_id == null` which doesn't catch the empty string, so when `boards.length === 1` (selector chips hidden) all circuits silently vanish from the tab while still rendering on Overview. Repro: `36 Wittenham Ave` (formerly `34 Wittenham`, recorded Feb 23 before the multi-board `board_id` column existed). Same predicate was used at 7 other sites in `web/src/lib/recording/apply-ccu-analysis.ts` (names_only / full_capture / hardware_update / append_rail) — all swapped for a shared `isUnscopedBoardId(id)` helper that treats `null`/`undefined`/`''` as unscoped. Backend (`src/`) untouched per the iOS-shared-backend rule; CSV column round-trip stays as-is. 988 web tests pass. |
| 2026-05-27 | Prod data-corruption fix: address (+ postcode, client name/phone/email) silently flipping to `[REDACTED]` after every job open. `redactPiiInPlace` in `src/logger.js` was recursively mutating sub-objects in place on the live `extractedData.installation_details` ref passed via logger meta in `routes/jobs.js:507-513`; next auto-save persisted the redacted value to S3 + `jobs.address` DB column. Logger rewritten copy-on-write (`5bf304ac`) + call-site cleaned (`d5adb2e3`) + read-only recovery script `scripts/audit-redacted-job-addresses.js` (restores via `job_versions.data_snapshot` — pre-corruption snapshots are preserved because auto-version saves run BEFORE the PUT overwrite). |
| 2026-05-22 | CCU dewarp output width restored to 2048-fixed (silent env-var regression: an out-of-band hotfix was dropped by the next CI deploy). Permanent fix moves the default into `src/extraction/ccu-single-shot.js`; `scripts/check-task-def-env-drift.sh` guardrail wired into the deploy workflow. Commit `01c081e`. |
| 2026-05-20 | CCU single-shot prompt hardened on label-to-slot alignment (explicit vertical-column rule, tie-break to null, multi-slot label rule). Architecture docs corrected to describe the actual 2026-05-08+ gpt-5.5 single-shot pipeline (no per-slot crops). |
| 2026-05-13 | PWA `observation_confirmation` brought to iOS parity — AlertCard render dropped, voice-answer auto-dismiss wired, 500ms client burst buffer in `web/src/lib/recording-context.tsx` to coalesce Deepgram split finals. Commit `34e3972`. |
| 2026-05-09 | `ask_user.context_field` enum widened in `src/extraction/stage6-tool-schemas.js` to the full union of circuit/board/supply/installation fields + sentinels. Unblocks sub-board creation focus-asks (Sonnet could write board fields but not legally ask about them). |
| 2026-05-07 | Multi-board sprint Phases 2a + 4a shipped (`ddde287` CSV header round-trip in `src/export.js`; `7e588c8` recording.js single-board scope warning). Phase 5 handoff written; both Codex deal-breakers closed. |
| 2026-05-07 | Multi-board sprint Phase 4 — `/api/analyze-ccu` board attribution + iOS `.addNewBoard` extraction mode. Backend `a40a9f3`; iOS `f9902cd`. |
| 2026-05-07 | Multi-board sprint Phase 3 — PDF sub-main section (iOS-only): conditional 5-cell row in `EICRHTMLTemplate.swift` for `.subDistribution` / `.subMain` boards. Commit `df4311c`. |
| 2026-05-07 | Multi-board sprint Phase 2 — backend schema parity + hierarchy validator. Four commits: `1059f39` shared-types, `ebb6183` PUT/GET tests, `ef56e25` `board-hierarchy-validator.js` + jobs.js PUT wiring, `c21820b` `field_schema.json`. |
| 2026-05-07 | Multi-board sprint Phase 1 — `sub_main_cable_length` dropped from iOS `BoardInfo` (not required by BS 7671). Commit `723b3f3`. |
| 2026-05-06 | BS-EN canonical aligned to Option B (prefixed form, no `-1` suffix) across schema, lookup, parser, picker, and migration. Backend `4611a2e`; iOS `d4d6db1`; diagnostic `scripts/audit-bs-en-values.js` (`90cbc4d`). Prod migration deferred to next field test. |
| 2026-05-06 | Chitchat pause — backend stops forwarding to Sonnet after 10 zero-engagement turns; four wake triggers (wake-word regex, iOS regex hit, manual resume, Deepgram doze recovery) with a 30 s replay buffer. iOS banner + Resume button. Backend `b0d977a` / `c580f42` / `663c135`; iOS `f6a29f0`. |
| 2026-05-06 | Stage 6: BS-code parser gains Lev-1 fuzzy fallback to break OCPD/RCD re-ask loop ("BS 6898" → "BS EN 60898" via single insertion; ambiguous matches fall through). Commit `c36f75a`. |
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
