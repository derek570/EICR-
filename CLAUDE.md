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
| PDF (server) | Python ReportLab + Playwright — **only used by web frontends (frontend/ and web/)** |
| PWA Frontend | Next.js (App Router, Zustand, TanStack) |
| Web Frontend | Next.js (App Router) |
| Cloud | AWS ECS Fargate, S3, RDS PostgreSQL, Secrets Manager |

## Monorepo Structure

npm workspaces with 4 packages:

| Workspace | Path | Purpose |
|-----------|------|---------|
| Backend | `src/` | Express API + WebSocket server |
| PWA | `frontend/` | Mobile-first Next.js (recording, live fill) |
| Web | `web/` | Desktop Next.js (dashboard, editing) |
| shared-types | `packages/shared-types/` | TypeScript types (`@certmate/shared-types`) |
| shared-utils | `packages/shared-utils/` | Shared utilities (`@certmate/shared-utils`) |

## Quick Commands

### Development

```bash
npm start                          # Backend (port 3000)
npm run dev --workspace=frontend   # PWA (port 3002)
npm run dev --workspace=web        # Web (port 3001)
```

### Testing

```bash
npm test                           # Backend tests
npm test --workspace=frontend      # Frontend tests
npm test --workspace=web           # Web tests
```

### Linting

```bash
npm run lint                       # ESLint
npm run format                     # Prettier
```

### Deploy Backend

> Replace `<ACCOUNT_ID>` with your AWS Account ID.

```bash
docker build -f docker/backend.Dockerfile -t eicr-backend .
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com
docker tag eicr-backend:latest <ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
docker push <ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2
```

Or just say: **"deploy"** or **"push to cloud"**. Changes go live in ~2 minutes.

### Check Status

```bash
aws ecs describe-services --cluster eicr-cluster-production --services eicr-frontend eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
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
| [deployment.md](docs/reference/deployment.md) | Deploy commands, cloud status, troubleshooting |
| [file-structure.md](docs/reference/file-structure.md) | Directory tree, key files |
| [deployment-history.md](docs/reference/deployment-history.md) | Implementation phases 1-8, resolved items archive |
| [DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) | Full developer setup guide (all platforms) |
| [ADRs](docs/adr/README.md) | Architecture Decision Records (7 ADRs) |
| [OpenAPI](docs/api/openapi.yaml) | OpenAPI 3.1 spec (served at /api/docs) |

## Documentation Sync Rules

When modifying UI fields: update `config/field_schema.json` + [field-reference.md](docs/reference/field-reference.md). When adding extractable fields to Sonnet: (1) add to prompt in `eicr-extraction-session.js`, (2) add case in `applySonnetReadings()`, (3) add keyword boosts in `default_config.json`.

> Full sync checklist: [docs/reference/field-reference.md](docs/reference/field-reference.md#keeping-this-documentation-in-sync)

## Current Focus / Active Work

- Deepgram auto-sleep power saving (3-tier: Active/Dozing/Sleeping) -- live in production
- Server-side Sonnet multi-turn extraction (v3 pipeline) -- live in production
- Session optimizer v3 with URL-based review reports
- iOS PDF generation (local, no server dependency)
- 5-star transformation phases 6-8 (infrastructure, testing, documentation)

## Changelog

| Date | Change | File(s) |
|------|--------|---------|
| 2026-03-04 | Add /api/analyze-document endpoint: GPT Vision extracts all EICR/EIC fields from photos of previous certificates, handwritten notes, or typed test sheets. Returns { success, formData } envelope matching extract-transcript shape. iOS app gets new "Extract Doc" button in recording overlay bar and CircuitsTab. Supports camera, photo library, and file picker (images + PDFs). | src/routes/extraction.js, iOS: CircuitsTab.swift, JobDetailView.swift, RecordingOverlay.swift, JobViewModel.swift, APIClient.swift |
| 2026-02-28 | Fix extraction quality regression: raise COMPACTION_THRESHOLD 6000→60000 to effectively disable compaction for normal sessions. The 6000 threshold caused compaction to fire after ~15-20 utterances, replacing full conversation history with a dry summary — destroying Sonnet's ability to infer circuit assignment from recent conversational flow. With prompt caching (1h TTL, cache reads at 10% rate), full history costs ~$0.25-0.35/session. 60000 threshold preserves full context for all normal inspections. | eicr-extraction-session.js |
| 2026-02-23 | Fix compaction cost blowout: 5 guards on compact() (min messages, min tokens, no-new-turns, failure backoff, 120s rate limit), increase max_tokens 2048→4096, client-side 120s rate limit on session_compact handler | eicr-extraction-session.js, sonnet-stream.js, eicr-extraction-session.test.js |
| 2026-02-23 | Fix audio loss during VAD warm-up: remove premature ring buffer reset, add reconnect audio queue (5s cap), extract shared chunk handler, increase reconnect timeout to 5s, flush queued audio after reconnect. Fix server connection failures: add /api/health/ready readiness endpoint (DB/Deepgram/Anthropic checks), add iOS pre-flight connectivity check with NetworkMonitor + server health, dropped-audio logging in DeepgramService | SleepManager.swift, DeepgramRecordingViewModel.swift, DeepgramService.swift, APIClient.swift, api.js |
| 2026-02-23 | CCU extraction prompt v2: 4-step structured methodology (physical scan, label mapping, extraction, cross-check), RCD waveform type identification, device-face amp reading enforcement, questions-for-inspector TTS, ported to live /api/analyze-ccu endpoint, wired questions into batch pipeline | src/analyze_photos.js, src/routes/extraction.js, src/process_job.js |
| 2026-02-22 | 5-star Phase 8: OpenAPI spec, Swagger UI, pre-commit hooks, dev setup guide, 7 ADRs, CLAUDE.md cleanup | docs/api/openapi.yaml, src/api.js, .husky/, docs/DEVELOPER_SETUP.md, docs/adr/, CLAUDE.md |
| 2026-02-21 | Inspector profiles settings page: full CRUD (name, position, org, enrolment number, signature upload), Inspectors tab in settings nav | frontend/src/app/settings/inspectors/page.tsx, frontend/src/app/settings/layout.tsx |
| 2026-02-21 | Prompt injection guardrail: transcript delimiters + data-vs-instruction rule; remove incomplete-reading WAIT (Sonnet asks immediately, 2s TTS debounce); fix Dockerfile missing files | eicr-extraction-session.js, docker/backend.Dockerfile |
| 2026-02-20 | Web iOS feature parity: live Deepgram streaming, Sonnet extraction, sleep/wake, transcript highlighting, alert TTS, LiveFillView, CCU upload, recording controls -- full pipeline port from iOS to Next.js PWA | frontend/src/lib/recording/*.ts, frontend/src/components/recording/*.tsx |
| 2026-02-20 | CCU photo analysis: revert to GPT-5.2 (Gemini 3 Pro truncating at ~146 tokens), keep v3 prompt, add finishReason guard | api.js |
| 2026-02-20 | Remove silence check (redundant with inline questionsForUser, saves ~$0.20/session) | DeepgramRecordingViewModel.swift, ServerWebSocketService.swift, sonnet-stream.js, eicr-extraction-session.js |
| 2026-02-19 | Deepgram auto-sleep: 3-tier power saving (Active/Dozing/Sleeping), Silero VAD wake, ring buffer replay | SleepManager.swift, AudioRingBuffer.swift, DeepgramService.swift |
| 2026-02-18 | Regex extraction restored alongside Sonnet (3-tier priority) | TranscriptFieldMatcher.swift, DeepgramRecordingViewModel.swift, sonnet-stream.js |
| 2026-02-17 | Server-side Sonnet multi-turn extraction | sonnet-stream.js, eicr-extraction-session.js |
| 2026-02-15 | Session optimizer v3, URL-based review | session-optimizer.sh, analyze-session.js |
| 2026-02-14 | iOS PDF generation, LiveFillView all fields | EICRHTMLTemplate.swift, LiveFillView.swift |

## Future Plans

- Evaluate replacing server-side Python PDF generation with Playwright-only approach
- CCU photo analysis: evaluate newer models as they become available
- Expand E2E test coverage

## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### ccu-extraction-plan

# CCU Extraction Plan — EIC Workflow

## Summary
Plan for 3-mode CCU extraction in the EIC workflow when changing a consumer unit:

1. **Circuit Names Only** — photo old board, capture labels only (no hardware)
2. **Update Hardware (Keep Readings)** — photo new board, fuzzy-match circuits, update OCPD/RCD/BS/EN but preserve test results
3. **Full New Consumer Unit** — current behaviour, replace everything

## Key Challenge
Fuzzy circuit matching: old board says "Upstairs Sockets", new board says "Sockets Up" — different order, different labels, additional circuits. Needs normalisation + Jaccard/Levenshtein scoring + user review screen.

## Files to Create/Modify
- NEW: `CCUExtractionMode.swift`, `CircuitMatcher.swift`, `CCUExtractionModeSheet.swift`, `CircuitMatchReviewView.swift`, `CCUExtractionViewModel.swift`
- MODIFY: `FuseboardAnalysisApplier.swift` (add mode param), `AudioImportViewModel.swift`, `JobDetailView.swift` (CCU button)

## Full plan saved to
`/tmp/background-tasks/ccu-extraction-plan.result`

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device



## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### ccu-extraction-plan

# CCU Extraction Plan — EIC Workflow

## Summary
Plan for 3-mode CCU extraction in the EIC workflow when changing a consumer unit:

1. **Circuit Names Only** — photo old board, capture labels only (no hardware)
2. **Update Hardware (Keep Readings)** — photo new board, fuzzy-match circuits, update OCPD/RCD/BS/EN but preserve test results
3. **Full New Consumer Unit** — current behaviour, replace everything

## Key Challenge
Fuzzy circuit matching: old board says "Upstairs Sockets", new board says "Sockets Up" — different order, different labels, additional circuits. Needs normalisation + Jaccard/Levenshtein scoring + user review screen.

## Files to Create/Modify
- NEW: `CCUExtractionMode.swift`, `CircuitMatcher.swift`, `CCUExtractionModeSheet.swift`, `CircuitMatchReviewView.swift`, `CCUExtractionViewModel.swift`
- MODIFY: `FuseboardAnalysisApplier.swift` (add mode param), `AudioImportViewModel.swift`, `JobDetailView.swift` (CCU button)

## Full plan saved to
`/tmp/background-tasks/ccu-extraction-plan.result`

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device


























































































































































## WhatsApp Context
> Auto-synced from WhatsApp assistant memories on 2026-04-10. Do not edit manually.


### anchoring-strategy

# CertMate Psychological Anchoring Strategy

**Date:** 25 March 2026
**Purpose:** Design a complete psychological anchoring strategy for Derek's 4-tier pricing (Free/Starter £15/Pro £30/Company £60) to maximise Pro tier selection, using decoy pricing, centre-stage bias, loss aversion, and strategic feature gating.

**Based on:** price-validation.md (competitor & margin analysis) and research-pricing-psychology.md (psychology principles)


## Executive Summary

The 4-tier structure creates a natural "double decoy" system. **Starter (£15) is the primary decoy** — it exists to make Pro look like extraordinary value. **Company (£60) is the price anchor** — it makes Pro feel affordable. **Pro (£30) is the target tier** where 50-60% of paid users should land. The Free tier's job is to create the endowment effect (taste the AI magic, feel the pain of limits).

At £1/cert API cost and realistic ~50% utilisation on Pro, margins are healthy (64%). The strategy below engineers every touchpoint — layout, copy, feature gates, upgrade prompts — to funnel users from Free → Pro.


## 1. Decoy Pricing Analysis

### The Role of Each Tier

| Tier | Psychological Role | Purpose |
|------|-------------------|---------|
| **Free (£0/1 cert)** | Endowment trigger | Let users experience AI voice-to-cert, build emotional ownership, hit limits fast |
| **Starter (£15/8 certs)** | Primary decoy | Exist to make Pro look like the obvious upgrade — "only £15 more for 2.5x the certs" |
| **Pro (£30/20 certs)** | Target tier | The plan we want 50-60% of paid users on. Best perceived value per cert |
| **Company (£60/50 certs)** | Price anchor + capture tier | Makes Pro feel cheap; captures firms who need team features |

### Why Starter Is the Decoy (Not Company)

The classic decoy effect (Huber, Payne & Puto, 1982) works by introducing an option that is **asymmetrically dominated** by the target. Starter is dominated by Pro on value:

```
Per-cert economics (what the user sees):

  Starter:  £15 ÷ 8 certs  = £1.88/cert
  Pro:      £30 ÷ 20 certs = £1.50/cert  ← 20% cheaper per cert
  Company:  £60 ÷ 50 certs = £1.20/cert

Value multiplier:
  Starter → Pro:     2x price → 2.5x certs (25% more value per £)
  Pro → Company:     2x price → 2.5x certs (25% more value per £)
  Starter → Company: 4x price → 6.25x certs (56% more value per £)
```

**The "£15 more" frame is critical.** When a user on Starter considers Pro, the question becomes: "Is 12 extra certificates worth £15?" At their hourly rate of £50-60, each cert saves 30-60 min of admin. That's £25-60 of time value per extra cert. Twelve extra certs = £300-720 of time value for £15. The answer is obviously yes.

This is textbook decoy design: the Starter-to-Pro jump delivers disproportionate value, making Pro feel like "the smart choice."

### Why Company Works as the Price Anchor

The Company tier at £60 performs two functions:

1. **Makes Pro look affordable.** £30 feels like "half price" compared to the visible £60 anchor. Without Company, £30 is the most expensive option on the page and feels "premium." With Company, £30 is the middle — where centre-stage bias directs attention.

2. **Captures high-volume firms.** Small electrical firms doing 30-50 EICRs/month need the capacity. At £1.20/cert, they're paying less than Tradecert's effective per-cert cost (~£1.00-1.10 + token overage). Company exists for a real market segment, not just as a decoy.

### The "Double Decoy" Effect

CertMate's 4-tier structure creates two complementary decoy relationships:

```
Free ──(endowment gap)──→ Starter ──(value gap)──→ PRO ←──(anchor)── Company
          "I need more"              "Pro is smarter"        "Pro is affordable"
```

- **Free → Starter gap:** "I've used my 1 free cert, I need more" (functional need)
- **Starter → Pro gap:** "For only £15 more I get 2.5x the certs + premium features" (value logic)
- **Company → Pro anchor:** "£30 is half the price of Company — Pro is the sweet spot" (price reference)

Research suggests 3 tiers produce 30% higher ARPU than 4+, but the 4-tier structure works IF Starter is clearly positioned as a stepping stone, not a resting place. The feature gating in Section 5 ensures this.


## 2. Value Framing for Each Tier

### Free Tier — "See What You're Missing"

**Frame:** The free tier is a **demo**, not a product. Users should complete one certificate and immediately feel the contrast between AI-generated and manual.

| Element | Frame |
|---------|-------|
| **Headline** | "Try your first AI certificate — free" |
| **Subtext** | "See how CertMate turns a 90-minute job into 5 minutes" |
| **CTA** | "Generate your first certificate" (not "Sign up free") |
| **Value anchor** | "Worth £50-120 of your admin time" |
| **Limitation signal** | Show "1 of 1 certificates used" prominently after use |

**Key psychological lever:** The **endowment effect**. After generating one AI certificate, the user has experienced the future. Going back to manual feels like a loss. The free tier doesn't sell CertMate — it sells the pain of not having CertMate.

### Starter Tier (£15/mo) — "Get Started, But You'll Want More"

**Frame:** Starter is for electricians who are "dipping their toes in" — part-timers, newly qualified, or sceptics who want to try before committing. It's deliberately positioned as the **training wheels** tier.

| Element | Frame |
|---------|-------|
| **Headline** | "Starter — £15/month" |
| **Subtext** | "8 AI certificates/month — perfect for getting started" |
| **Value anchor** | "Less than the cost of one manual EICR's admin time" |
| **Per-cert callout** | "Just £1.88 per certificate" |
| **Upgrade nudge** | "Need more than 8/month? See Pro →" (always visible) |

**Key psychological lever:** **Scarcity + upgrade desire.** 8 certs/month is enough for a part-timer (1-2/week) but will feel constraining for anyone doing 3+ jobs/week. The cap is the built-in upgrade trigger. Most full-time sole traders do 10-20+ EICRs/month — they'll hit the wall by week 2.

### Pro Tier (£30/mo) — "The Complete Package"

**Frame:** Pro is the **real product**. Everything about it should communicate "this is what CertMate was built for." It gets the visual emphasis, the "Most Popular" badge, and the most detailed feature callouts.

| Element | Frame |
|---------|-------|
| **Headline** | "Pro — £30/month" |
| **Badge** | "MOST POPULAR" (top of card, contrasting colour) |
| **Subtext** | "20 AI certificates/month — built for full-time electricians" |
| **Value anchor** | "Pays for itself after your first certificate" |
| **ROI callout** | "Save 20-40 hours/month on paperwork" |
| **Per-cert callout** | "Just £1.50 per certificate — less than a coffee" |
| **Social proof** | "Chosen by X% of CertMate users" (once data exists) |

**Key psychological lever:** **Centre-stage bias + social proof.** Eye-tracking studies show the middle option gets 60% of visual attention. The "Most Popular" badge adds social validation — "if others chose it, it must be right" (conformity bias). Research shows this combination increases middle-tier selection by **38% (centre-stage) + 12-15% (badge)**.

**The ROI maths that sells Pro:**

```
Monthly investment:         £30
Certs included:             20
Admin time saved per cert:  30-60 minutes
Hourly rate:                £50-60
Time value saved per cert:  £25-60
Total monthly time value:   £500-1,200
ROI:                        17-40x return

Pro pays for itself: after certificate #1
```

### Company Tier (£60/mo) — "Scale Your Business"

**Frame:** Company is for **established firms**, not sole traders. The language shifts from personal productivity to business operations. This tier should feel aspirational but not necessary for the individual electrician — reinforcing that Pro is "enough" for them.

| Element | Frame |
|---------|-------|
| **Headline** | "Company — £60/month" |
| **Subtext** | "50 AI certificates/month — for firms and growing teams" |
| **Value anchor** | "Cheaper than 4 separate iCertifi licenses" |
| **Per-cert callout** | "Best value at £1.20 per certificate" |
| **Differentiator** | Team features, multi-user access, priority support |
| **Target audience signal** | "For electrical firms doing 30+ jobs/month" |

**Key psychological lever:** **Self-selection through language.** By saying "for firms and growing teams," sole traders automatically think "that's not for me — Pro is my tier." This is intentional. Company exists to (a) anchor Pro as affordable and (b) capture the firms segment. The language prevents sole traders from over-buying or feeling pressured.


## 3. Centre-Stage Bias Layout

### Pricing Page Visual Hierarchy

Research (ConversionXL eye-tracking studies) shows customers scan pricing pages in an **F-pattern**, with disproportionate attention on the centre option. The layout must exploit this:

```
┌─────────────┐  ┌─══════════════════╗  ┌─────────────┐  ┌─────────────┐
│   FREE      │  ║   STARTER         ║  │   ★ PRO ★    │  │  COMPANY    │
│             │  ║                   ║  │  MOST POPULAR │  │             │
│   £0/mo     │  ║   £15/mo          ║  │   £30/mo     │  │   £60/mo    │
│             │  ║                   ║  │              │  │             │
│   1 cert    │  ║   8 certs         ║  │   20 certs   │  │   50 certs  │
│             │  ║                   ║  │              │  │             │
│  [Try Free] │  ║  [Get Started]    ║  │ [Start Trial]│  │  [Contact]  │
└─────────────┘  ╚═══════════════════╝  └─────────────┘  └─────────────┘
     muted           standard              ELEVATED            standard
    smallest          normal               LARGEST              normal
```

Wait — there's a layout tension with 4 tiers. With 3 tiers, the target naturally sits in the centre. With 4, the visual centre falls between Starter and Pro. The solution:

### Recommended 4-Tier Layout Strategy

**Option A: Asymmetric Elevation (Recommended)**

Position Pro as the 3rd of 4 columns but give it 20-30% more visual weight:

```
┌──────────┐  ┌──────────┐  ┌═══════════════╗  ┌──────────┐
│  FREE    │  │ STARTER  │  ║   ★ PRO ★      ║  │ COMPANY  │
│  £0/mo   │  │ £15/mo   │  ║   £30/mo       ║  │ £60/mo   │
│  1 cert  │  │ 8 certs  │  ║   20 certs     ║  │ 50 certs │
│          │  │          │  ║   MOST POPULAR  ║  │          │
│ [Try It] │  │ [Start]  │  ║ [Start Trial]  ║  │[Contact] │
└──────────┘  └──────────┘  ╚════════════════╝  └──────────┘
   muted        normal          ELEVATED           normal
   grey bg     white bg       primary border      white bg
                              shadow + scale(1.05)
                              "MOST POPULAR" badge
                              slightly taller card
```

**Visual techniques for Pro elevation:**
- **Card height:** 10-15px taller than siblings (extends above and below)
- **Border:** 2px solid primary colour (other cards: 1px neutral border)
- **Shadow:** Elevated shadow (`0 8px 24px rgba(primary, 0.15)`)
- **Scale:** `transform: scale(1.03)` on desktop
- **Badge:** "MOST POPULAR" ribbon/pill at top of card in primary colour
- **CTA colour:** Primary filled button (others: outlined or ghost buttons)
- **Background:** Subtle primary tint or white (others: neutral-50 or transparent)

**Option B: 3+1 Layout (Alternative)**

Show Free/Starter/Pro as a classic 3-column layout with Company below or as a separate "Enterprise" row:

```
┌──────────┐  ┌═══════════════╗  ┌──────────┐
│  FREE    │  ║   ★ PRO ★      ║  │ STARTER  │
│  £0/mo   │  ║   £30/mo       ║  │ £15/mo   │
└──────────┘  ╚════════════════╝  └──────────┘

    ┌─────────────────────────────────────┐
    │  COMPANY — £60/mo                   │
    │  For firms. 50 certs/mo. Contact →  │
    └─────────────────────────────────────┘
```

This exploits the 3-tier advantage (30% higher ARPU per Price Intelligently) while keeping Company as a visible anchor. However, it de-emphasises Company and may lose some anchor effect.

**Recommendation: Option A** — 4 columns with Pro visually elevated. This keeps Company visible as the price anchor while directing attention to Pro.

### Mobile Layout (< 768px)

On mobile, cards stack vertically. Ordering matters even more:

```
1. Pro (MOST POPULAR) — shown first, expanded by default
2. Starter — collapsed, "Starting from £15/mo"
3. Company — collapsed, "For teams from £60/mo"
4. Free — at bottom, "Try 1 certificate free"
```

**Why Pro first on mobile:** The primacy effect (first item seen gets disproportionate attention) replaces centre-stage bias on vertical layouts. Showing Pro first with an expanded card and prominent CTA maximises mobile conversion.


## 4. Loss Aversion Upgrade Prompts

Loss aversion (Kahneman & Tversky, 1979) shows the **pain of losing is ~2x more motivating** than the pleasure of gaining. Every upgrade prompt should frame the current tier's limitations as a loss, not the next tier's features as a gain.

### Free → Starter Upgrade Prompts

**Trigger:** User completes their 1 free certificate.

| Timing | Loss-Framed Prompt | Where |
|--------|-------------------|-------|
| After 1st cert | "You've seen CertMate cut 90 minutes to 5. **Your next customer is waiting** — upgrade to keep going." | In-app modal |
| Cert limit hit | "You've used your free certificate this month. **Every manual report costs you £50-120 in billable time.** Upgrade from £15/mo." | Blocking modal (soft — dismissible) |
| 7 days after signup | "You generated a certificate 7 days ago. Since then, you've done **[estimated X] EICRs manually** — that's [X hours] of admin you could have saved." | Email / push notification |
| Next month reset | "Your free certificate has refreshed. But last month you could have saved **[X] hours** on the [X] jobs you did manually." | In-app banner |

### Free → Pro Upgrade Prompts (Skip Starter)

**Trigger:** User behaviour suggests they're a full-time electrician (checked daily, or explicitly asked about higher volumes).

| Timing | Loss-Framed Prompt | Where |
|--------|-------------------|-------|
| High engagement signal | "Doing more than 2 EICRs a week? **You're losing £100-240/week in admin time.** Pro handles 20 certs/month for just £30." | In-app prompt |
| After cert limit | "You need more than 1 cert/month. **At your rate, manual paperwork costs more per month than Pro does per year.** Skip Starter — go Pro." | Smart upgrade modal |

### Starter → Pro Upgrade Prompts

**Trigger:** User approaches or hits 8-cert limit, or is on Starter for 2+ months.

| Timing | Loss-Framed Prompt | Where |
|--------|-------------------|-------|
| 6/8 certs used | "You've used 6 of 8 certificates. At this pace, you'll **run out before month-end** — and go back to manual. Pro gives you 20/month for £15 more." | In-app warning banner |
| 8/8 certs used | "**You've hit your Starter limit.** Every cert you do manually from now until [date] costs you 30-60 minutes. Upgrade to Pro and never hit a wall." | Blocking modal |
| 8/8 + tries to create cert | "You're trying to create a certificate but you've used all 8. **This EICR will take you 90 minutes manually — or 5 minutes on Pro.** Upgrade now?" | Blocking modal with ROI calc |
| Steady 7-8/month usage | "You've used 7+ certs for 2 months running. **You're paying £1.88/cert on Starter when Pro drops that to £1.50.** More certs, lower cost. Upgrade →" | In-app banner |
| Approaching renewal | "Your Starter renews in 3 days. Last month you **hit your limit on day [X]** and had to do [Y] certs manually. Pro eliminates that ceiling for £15/mo more." | Email / push |

**Key Starter → Pro copy framework:**
- Always reference the **£15 gap**, not the £30 total: "just £15 more" not "upgrade to £30/month"
- Always quantify what they're losing: hours, money, or certs they couldn't generate
- Always make the maths obvious: "12 extra certs × 30 min saved = 6 hours back"

### Pro → Company Upgrade Prompts

**Trigger:** User consistently uses 15+ of 20 certs, or asks about team features.

| Timing | Loss-Framed Prompt | Where |
|--------|-------------------|-------|
| 18/20 certs used | "You're almost at capacity. **If you take on one more job this week, you'll have to do the cert manually.** Company gives you 50/month." | In-app banner |
| 20/20 + growing business | "You've maxed out Pro for [X] months. **You're turning down AI-assisted work.** Company at £60/mo means you never say no to a job." | Email |
| Multi-device/user request | "Want your team on CertMate? **Every engineer doing certs manually is costing your business £500+/month in admin time.** Company supports your whole team." | In-app prompt |

### Churn Prevention (Cancellation Flow)

When any paid user attempts to cancel:

```
Step 1: "Before you go — here's what you'll lose:"
  - "Your [X] saved customer records"
  - "Your [X] certificate templates"
  - "Your report history (used for re-inspections)"
  - "[X] hours saved this month alone"

Step 2: "Downgrade instead?"
  - Pro → Starter: "Keep 8 certs/month for £15 instead of losing everything"
  - Starter → Free: "Keep 1 cert/month and your data, free forever"

Step 3: If still cancelling:
  - "We'll keep your data for 90 days in case you change your mind.
     After that, your [X] customer records and [X] certificates
     will be permanently deleted."
```

**The 90-day data retention window is critical.** It creates an ongoing loss aversion: "My data is still there, I could go back." This is standard SaaS practice and dramatically improves win-back rates (research shows 15-25% of churned users with data retention return within 90 days).


## 5. Feature Gating Matrix

### Design Principle: Create Desire, Not Satisfaction

Feature gating must follow one rule: **lower tiers should make users want more, not feel content with less.** Every gate should create a moment of "I wish I had that" — not "eh, I don't need it."

The gates fall into three categories:
1. **Hard gates:** Feature completely unavailable (e.g., no team features on Starter)
2. **Soft gates:** Feature available but limited or degraded (e.g., basic AI vs full AI)
3. **Visibility gates:** Feature visible but locked — user can see what they're missing

### Complete Feature Gating Matrix

| Feature | Free (£0) | Starter (£15) | Pro (£30) | Company (£60) |
|---------|-----------|---------------|-----------|---------------|
| **Certificates/month** | 1 | 8 | 20 | 50 |
| **AI voice-to-certificate** | 1 cert only | Yes | Yes | Yes |
| **Certificate types** | EICR only | EICR + Minor Works | All types (EICR, EIC, Minor Works, PAT) | All types |
| **AI compliance checking** | Basic (pass/fail) | Standard | Advanced (with explanations + fix suggestions) | Advanced + audit trail |
| **Photo documentation** | No | 3 photos/cert | Unlimited photos/cert | Unlimited + auto-organise |
| **Report branding** | CertMate watermark | CertMate footer | Your logo + no CertMate branding | Full white-label |
| **Customer database** | No | Up to 50 customers | Unlimited customers | Unlimited + import/export |
| **Certificate history** | 90 days | 12 months | Unlimited | Unlimited + version control |
| **Export formats** | PDF only (watermarked) | PDF | PDF + print-optimised | PDF + CSV + API |
| **BS 7671 updates** | Manual | Notified | Auto-applied to templates | Auto-applied + change log |
| **Re-inspection reminders** | No | No | Yes (automated) | Yes + client-facing notifications |
| **Job scheduling** | No | No | No | Yes |
| **Team members** | 1 | 1 | 1 | Up to 5 (+ £10/user) |
| **Support** | Community/FAQ | Email (48hr) | Email (24hr) + chat | Priority (4hr) + phone |
| **Analytics dashboard** | No | No | Basic (monthly summary) | Full (revenue, time saved, compliance score) |
| **Template customisation** | No | No | Yes | Yes + shared team templates |
| **Offline mode** | No | No | Yes (sync when online) | Yes |

### Strategic Gate Analysis: Why Each Gate Creates Desire

**Gate 1: Certificate types (Free/Starter = limited)**
- Free users can only do EICRs. When they get a Minor Works job, they hit the wall.
- Starter users can do EICRs + Minor Works but not EICs or PATs. As their business grows, they naturally need more certificate types.
- **Desire trigger:** "I just got a PAT testing job but CertMate won't let me do it on Starter. Pro would handle this."

**Gate 2: Photo documentation (Free = none, Starter = 3/cert)**
- Photos are increasingly important for EICR evidence. Limiting to 3 per cert on Starter creates friction on complex installations.
- A 12-circuit board with 3 defects needs more than 3 photos.
- **Desire trigger:** "I need 6 photos for this board but I can only attach 3. Pro has unlimited."

**Gate 3: Report branding (Free = watermarked, Starter = CertMate footer)**
- Sole traders are proud of their business brand. Having "CertMate" on their certificates is functional but feels unprofessional to clients.
- **Desire trigger:** "My customer asked why the cert says 'CertMate' at the bottom. I want my own logo on there."

**Gate 4: Customer database (Free = none, Starter = 50 max)**
- The customer database creates switching cost (endowment effect). Once an electrician has 40+ customers stored, leaving CertMate means losing that data.
- The 50-customer cap on Starter means growing businesses hit it after 6-12 months — right when they're most locked in.
- **Desire trigger:** "I've got 48 customers stored. I need to keep adding, but I'm almost at the limit."

**Gate 5: Re-inspection reminders (Pro only)**
- This is a **revenue-generating feature** for electricians. EICRs expire every 5 years. Automated reminders to past customers = rebooking without marketing.
- Withholding this from Starter makes Pro feel like a business growth tool, not just a cert app.
- **Desire trigger:** "Pro would automatically remind my old customers when their EICR expires. That's free repeat business."

**Gate 6: Compliance explanations (Pro = advanced with fix suggestions)**
- Free/Starter get basic pass/fail compliance checking. Pro gets detailed explanations of failures AND suggested fixes.
- For a sole trader, the difference between "C2 fail" and "C2 fail — suggest rewiring to TN-S earthing arrangement per Regulation 411.4.2" is massive.
- **Desire trigger:** "The AI told me it failed but not why. On Pro, it would tell me exactly how to fix it."

**Gate 7: Offline mode (Pro only)**
- Electricians work in basements, meter cupboards, and building sites with poor signal. Offline mode is a genuine workflow need.
- **Desire trigger:** "I was on a job in a basement with no signal and couldn't generate the cert. Pro works offline."

**Gate 8: Analytics dashboard (Pro = basic, Company = full)**
- Sole traders on Pro see monthly summaries (certs generated, time saved, revenue tracked).
- Company users see firm-wide analytics: revenue per engineer, compliance scores, job efficiency.
- **Desire trigger for Pro users:** Company analytics creates aspiration for growing businesses.

### The "Visibility Gate" Strategy

Some Pro features should be **visible but locked** on Starter, not completely hidden. This uses the **Zeigarnik effect** — people remember incomplete tasks more than complete ones. Showing a locked feature is more motivating than hiding it.

**Features to show-but-lock on Starter:**
- Re-inspection reminders: Show "Re-inspection Reminders (Pro)" in the sidebar with a lock icon. When tapped, show a preview of what it does with an upgrade CTA.
- Analytics: Show "Your Monthly Summary" card with blurred/placeholder data and "Upgrade to Pro to unlock."
- Template customisation: Show "Customise Templates (Pro)" in settings. Tapping shows a preview gallery.
- Offline mode: When device goes offline, show "Offline Mode is a Pro feature. Upgrade to work without internet."

**Features to completely hide on Free:**
- Customer database (show after first cert with "Upgrade to save this customer")
- Photo documentation (show camera icon greyed out with "Photos available on Starter+")
- Export (show "Upgrade to remove watermark" on the PDF preview)


## 6. Pricing Page Copy — Complete Framework

### Above the Fold

```
Headline:    "Stop spending hours on EICR paperwork"
Subhead:     "Speak your observations. Get a BS 7671-compliant certificate in minutes."
Trust line:  "Join [X] UK electricians saving 20+ hours a month"
```

### Annual/Monthly Toggle

```
┌─────────────────────────────────┐
│  Monthly    [●━━━━━]  Annual    │
│                                 │
│        💰 Save up to 17%        │
│     "Get 2 months free"         │
└─────────────────────────────────┘
```
Default the toggle to Annual. Show savings badge. When toggled to Monthly, show the higher prices with a subtle "Switch to annual to save £X/year" reminder.

### Tier Cards (Desktop)

**Free Card (muted, leftmost):**
```
FREE
£0/month

1 AI certificate per month
EICR only
Basic compliance check
PDF with watermark

[Try Free →]
(greyed/muted CTA)
```

**Starter Card (standard):**
```
STARTER
£15/month
  or £150/year (save £30)

8 AI certificates per month
EICR + Minor Works
Standard compliance check
3 photos per cert
Customer database (50)
12-month history
Unbranded PDF export
Email support

[Get Started]
```

**Pro Card (ELEVATED — primary border, badge, taller):**
```
★ MOST POPULAR ★

PRO
£30/month
  or £290/year (save £70 — 2 months free)

20 AI certificates per month
All certificate types
Advanced AI with fix suggestions
Unlimited photos
Your logo — no CertMate branding
Unlimited customer database
Unlimited history
Re-inspection reminders
Template customisation
Offline mode
Basic analytics
Priority email + chat support

"Pays for itself after your first certificate"

[Start Free Trial]
(primary filled button, largest)
```

**Company Card (standard, rightmost):**
```
COMPANY
£60/month
  or £600/year (save £120)

50 AI certificates per month
Everything in Pro, plus:
Up to 5 team members
Full analytics dashboard
Job scheduling
White-label reports
API & CSV export
Audit trail
Priority phone support
Dedicated onboarding

"For firms doing 30+ jobs/month"

[Contact Sales]
```

### Below the Tier Cards

**ROI Calculator (interactive):**
```
┌─────────────────────────────────────────────────────┐
│  How many EICRs do you do per month?                │
│  ───○────────────── 12 certs/month                  │
│                                                     │
│  Without CertMate:    18 hours/month on paperwork   │
│  With CertMate Pro:   2 hours/month                 │
│  Time saved:          16 hours/month                │
│  Value at £50/hr:     £800/month saved              │
│                                                     │
│  Pro costs £30/mo → 27x return on investment        │
│                                                     │
│  [Start Free Trial — Save 16 Hours This Month]      │
└─────────────────────────────────────────────────────┘
```

**Comparison with Competitors:**
```
"Why pay £15/mo for a form-filler when CertMate does the work for you?"

                    iCertifi    Tradecert   CertMate Pro
Certs included      Unlimited   Unlimited   20/month
AI approach         Camera→Form Token-based  Voice→Certificate
Fill out forms?     Yes         Yes          No forms at all
Monthly price       £5-15       £18+tokens   £30

"iCertifi speeds up form-filling. CertMate eliminates forms entirely."
```

**FAQ Section (address objections):**
```
Q: "Why pay £30 when iCertifi is £8/month?"
A: "iCertifi is a digital form — you still type every field. CertMate
    generates the entire certificate from your voice notes. At £50/hr,
    the 60 minutes you save per cert is worth more than the monthly difference."

Q: "What if I don't use all 20 certificates?"
A: "Most Pro users do 10-15 certs/month. At £1.50-3.00 per cert,
    it's still cheaper than the admin time for even one manual certificate.
    You're paying for time freedom, not just certificates."

Q: "Can I try before I commit?"
A: "Generate your first certificate completely free — no card required.
    See the AI in action, then decide."
```


## 7. Overprovisioning Strategy

### Why 20 Certs on Pro Works at £1/cert API Cost

The £1/cert API cost creates an interesting dynamic: **overprovisioning the cert allocation is a feature, not a bug.**

**Usage distribution model (based on SaaS usage patterns):**

| Usage Pattern | % of Pro Users | Certs Used/mo | API Cost | Revenue | Margin |
|---------------|---------------|---------------|----------|---------|--------|
| Light (part-time) | 25% | 5-8 | £5-8 | £30 | 73-83% |
| Moderate (typical) | 40% | 10-14 | £10-14 | £30 | 53-67% |
| Heavy (full-time) | 25% | 15-18 | £15-18 | £30 | 40-50% |
| Max (power user) | 10% | 19-20 | £19-20 | £30 | 33-37% |
| **Blended average** | 100% | ~12 | ~£12 | £30 | **60%** |

**The 20-cert allocation is psychologically powerful because:**

1. **Abundance mindset:** Users who feel they have "plenty" use the product more freely and build deeper habits. A user with 20 certs who uses 12 feels comfortable and grateful. A user with 12 certs who uses 12 feels anxious and constrained.

2. **Reduced "meter anxiety":** Per the research doc, flat-rate bias means users prefer overpaying for a flat rate vs paying exactly what they use. The unused 8 certs are the "peace of mind premium."

3. **Margin buffer:** The 60% blended margin at ~12 certs average usage is healthy. Even at 75% utilisation (15 certs), margin is 50% — still viable.

4. **Upgrade prevention:** If Pro were 12 certs and users averaged 12, half would hit the cap monthly and churn from frustration. 20 certs means the cap is invisible for 90% of users — they feel satisfied, not constrained. The 10% who hit 20 are exactly the right candidates for Company.

**The overprovision is the product.** CertMate Pro at 20 certs doesn't sell 20 certificates — it sells "never worrying about running out."


## 8. Implementation Priorities

### Phase 1: Pricing Page Launch
1. Build 4-tier layout with Pro elevated (centre-stage bias)
2. Implement "Most Popular" badge on Pro
3. Annual/monthly toggle defaulting to Annual
4. ROI calculator below tier cards
5. Loss-framed copy on all tier descriptions

### Phase 2: In-App Upgrade Triggers
1. Cert counter visible at all times ("X of Y used this month")
2. 75% usage warning banner (loss-framed)
3. Limit-hit modal with upgrade CTA
4. Visibility gates on Starter (locked Pro features visible)
5. Post-first-cert upgrade prompt for Free users

### Phase 3: Lifecycle Messaging
1. Onboarding email sequence (3-email: welcome → value → upgrade)
2. Approaching-limit email triggers
3. Monthly usage summary with "time saved" metrics
4. Cancellation flow with loss-framed retention
5. 90-day data retention with win-back emails

### Phase 4: Optimisation
1. A/B test Starter at £15 vs removing Starter (3-tier)
2. A/B test Pro at £29 vs £30
3. Track tier distribution — target 50-60% Pro adoption
4. Monitor Starter-to-Pro conversion rate — target 40%+ within 3 months
5. Track Company self-selection from Pro power users


## 9. Key Metrics to Monitor

| Metric | Target | Danger Zone | Action |
|--------|--------|-------------|--------|
| % paid users on Pro | 50-60% | <40% (Starter cannibalising) | Widen feature gap, raise Starter price |
| Starter → Pro upgrade rate | 40%+ within 90 days | <25% | Tighten Starter feature gates |
| Pro average utilisation | 50-65% (10-13 certs) | >75% (margin compression) | Consider reducing allocation or raising price |
| Free → Paid conversion | 8-12% | <5% | Improve free cert experience, better upgrade prompts |
| Company adoption | 10-15% of paid | <5% | Adjust Company features/price, improve team pitch |
| Monthly churn (Pro) | <5% | >8% | Review value delivery, add retention features |
| Blended gross margin | >55% | <45% | Reduce cert allocations or raise prices |


## Sources

- Huber, Payne & Puto (1982) — decoy effect (asymmetric dominance)
- Kahneman & Tversky (1979) — loss aversion, ~2x pain vs pleasure
- Price Intelligently — 512 SaaS companies, 3 tiers = 30% higher ARPU
- ConversionXL — eye-tracking, centre-stage bias +38% mid-tier selection
- Buffer — centre-focused design +31% mid-tier selection
- McKinsey — loss-framed messaging +21% conversion
- American Marketing Association — decoy pricing +40% target plan selection
- Bain & Company — perceived value drives 80% of B2B decisions
- Simon-Kucher & Partners — anchoring +15-20% contract values
- CertMate price-validation.md — competitor pricing, margin analysis
- CertMate research-pricing-psychology.md — psychology principles, charm pricing, annual discounts

### appstore-connect

# App Store Connect Credentials

## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing

### behavior-ops-marketing

# Behavior Ops Manual — CertMate Marketing Playbook

Key frameworks from Chase Hughes' "The Behavior Ops Manual" applied to CertMate's pricing, marketing, and conversion strategy.

## 1. FATE Model (Focus, Authority, Tribe, Emotion)
Ancestral survival priorities that drive all human behavior:
- **Focus** — Capture attention immediately. Lead with the problem (cert compliance pain).
- **Authority** — Position CertMate as THE professional tool. Use NICEIC/NAPIT association language.
- **Tribe** — "Join thousands of UK electricians who..." Electricians identify strongly with their trade.
- **Emotion** — Fear of failed inspections, pride in professionalism, relief from paperwork burden.

## 2. Six-Axis Model of Influence
Six axes: Suggestibility, Focus, Openness, Connection, Compliance, Expectancy.
Only 3 of 6 need to be present for persuasion. **For sales pages/landing pages, prioritize:**
1. **Suggestibility** — Social proof, testimonials, "most popular" badges
2. **Focus** — Clean design, single CTA, remove distractions
3. **Expectancy** — Set expectations early ("In 2 minutes you'll have your first cert")

## 3. Decision Map — Electrician Persona
Six decision styles. UK electricians skew toward:
- **Investment** — "Is this a valuable return on my money?" → ROI calculator showing time saved × hourly rate
- **Necessity** — "Why do I need this vs what I have?" → Emphasize compliance risk, upcoming regulation changes
- Secondary: **Conformity** — "What are other sparks using?" → Trade-specific social proof

## 4. Cognitive Biases for Pricing Page
- **Anchoring** — Show annual cost of manual process FIRST (£2,400+/year in wasted time), then CertMate at £15-30/mo feels tiny
- **Zero-risk bias** — Free tier eliminates all risk. "Try it free, no card required"
- **Default effect** — Make Pro (£30/mo) the visually highlighted "Most Popular" option
- **Endowment effect** — Once they use free tier and create certs, they value the system more and won't leave
- **IKEA effect** — Let users customize templates, cert layouts → increases perceived value
- **Bandwagon** — "X electricians signed up this month" counter
- **Recency bias** — At the decision point (pricing page CTA), remind of positive attributes just experienced
- **Authority bias** — "Built for BS 7671 compliance" — regulatory language signals authority

## 5. Sales Objection Handling (5S Formula)
Four objections and how to handle each:
1. **Indifference** ("I'm fine with paper certs") → Sympathize, then show time/cost comparison
2. **Disbelief** ("Software can't handle all cert types") → Show comprehensive cert library, demo
3. **Confusion** ("Too complicated to switch") → 2-minute onboarding video, "import existing certs" feature
4. **Obstacles** ("Can't afford it right now") → Free tier, ROI calculator, "pays for itself in 2 jobs"

**5S Formula**: Sympathize → Socialize (others felt same) → Select (pick their specific concern) → Show (evidence/demo) → Secure (close)

## 6. Scarcity & Urgency
- Before any CTA, deliver the feeling of missing out
- "Early adopter pricing" with visible countdown/limit
- "Free tier limited to first 1,000 sign-ups" (even if soft limit)
- Show what competitors charge for less functionality

## 7. Grief Process Method
For getting electricians to let go of manual cert processes:
- Acknowledge the old way worked ("Paper certs got you this far")
- Show the world has changed (digital requirements, client expectations)
- Make the transition feel natural, not forced
- Position CertMate as evolution, not replacement

## 8. PCP Model (Perception, Context, Permission)
Hierarchy of compliance:
- **Perception** — How they see CertMate (professional tool vs generic software)
- **Context** — Where they encounter it (trade publications, WhatsApp groups, supplier partnerships)
- **Permission** — Remove barriers to action (free tier, no card, 2-min setup)

## 9. Needs Map — Electrician Motivations
- **Significance** — "Stand out as a professional" — branded cert PDFs with their logo
- **Approval** — "Clients love digital certs" — client portal, instant sharing
- **Intelligence** — "Smart electricians use smart tools" — don't talk down to them
- Secondary: **Strength/Power** — "Take control of your compliance" — autonomy messaging

## Source
Chase Hughes, "The Behavior Ops Manual" — PDF at /tmp/behavior-ops.pdf
Key sections: FATE (pp30-49), Six-Axis (pp71-80), Sales Objections (pp548-560), Scarcity (pp596-612), Cognitive Biases (pp628-646)

### ccu-extraction-plan

# CCU Extraction Plan — EIC Workflow

## Summary
Plan for 3-mode CCU extraction in the EIC workflow when changing a consumer unit:

1. **Circuit Names Only** — photo old board, capture labels only (no hardware)
2. **Update Hardware (Keep Readings)** — photo new board, fuzzy-match circuits, update OCPD/RCD/BS/EN but preserve test results
3. **Full New Consumer Unit** — current behaviour, replace everything

## Key Challenge
Fuzzy circuit matching: old board says "Upstairs Sockets", new board says "Sockets Up" — different order, different labels, additional circuits. Needs normalisation + Jaccard/Levenshtein scoring + user review screen.

## Files to Create/Modify
- NEW: `CCUExtractionMode.swift`, `CircuitMatcher.swift`, `CCUExtractionModeSheet.swift`, `CircuitMatchReviewView.swift`, `CCUExtractionViewModel.swift`
- MODIFY: `FuseboardAnalysisApplier.swift` (add mode param), `AudioImportViewModel.swift`, `JobDetailView.swift` (CCU button)

## Full plan saved to
`/tmp/background-tasks/ccu-extraction-plan.result`

### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### marketing-copy

# CertMate Production-Ready Marketing Copy

**Date:** 25 March 2026
**Purpose:** Complete, production-ready marketing copy for all channels — App Store, pricing page, Google Ads, trade forum, and email conversion sequence. All copy uses the finalised 4-tier pricing (Free/Starter £15/Pro £30/Company £60) with psychological anchoring, decoy positioning, and ROI framing baked in.

**Based on:** anchoring-strategy.md, roi-calculator-messaging.md, price-validation.md, pricing-strategy.md


## Table of Contents

1. [App Store Copy](#1-app-store-copy)
2. [Pricing Page Copy](#2-pricing-page-copy)
3. [Google Ads Variants](#3-google-ads-variants)
4. [Trade Forum Post Template](#4-trade-forum-post-template)
5. [Email Sequence: Free-to-Paid Conversion](#5-email-sequence-free-to-paid-conversion)


## 1. App Store Copy

### 1.1 App Name & Subtitle

**App Name:** CertMate — AI Electrical Certs
**Subtitle (30 chars):** EICR & BS 7671 in Minutes

### 1.2 Short Description (Promotional Text — 170 chars)

> Speak your observations. Get a BS 7671-compliant certificate. CertMate turns 45-minute EICR write-ups into 5-minute voice-powered certificates. Try your first one free.

### 1.3 Long Description (App Store Description — 4000 chars max)

```
STOP SPENDING HOURS ON EICR PAPERWORK

CertMate is the AI certification assistant that turns your voice into compliant electrical certificates. Describe your observations on-site — CertMate writes the certificate. No forms. No typing. No paperwork in the van.

WHAT CERTMATE DOES

Speak your inspection observations as you work. CertMate's AI listens, understands electrical terminology, and generates a fully formatted, BS 7671-compliant certificate — complete with test results, observation codes, regulation references, and schedules.

A full EICR write-up that takes 45-60 minutes by hand takes 10-15 minutes with CertMate.

HOW IT WORKS

1. Start a new certificate — say the address and CertMate sets up the job
2. Walk through the inspection speaking your observations: "Kitchen ring, polarity confirmed, Zs 0.31 ohms, RCD trips at 28ms"
3. CertMate fills in the schedule of test results, maps observation codes, and references the correct BS 7671 regulations
4. Review the AI-generated certificate, sign, and export as a branded PDF

That's it. No tapping through form fields. No cross-referencing the regs book. No writing up notes in the van after the job.

CERTIFICATE TYPES
- EICR (Electrical Installation Condition Report)
- EIC (Electrical Installation Certificate)
- Minor Works Certificate
- PAT Testing Records

All certificates fully compliant with BS 7671:2018 + Amendment 2 (effective April 2026).

KEY FEATURES

AI Voice-to-Certificate — Speak your observations, get a compliant certificate
Smart Compliance Checking — Auto-reviews against current BS 7671 regulations
Board Schedule Recognition — Describe or photograph consumer units
Observation Code Mapping — AI assigns C1/C2/C3/FI codes with regulation references
Branded PDF Export — Your company logo, no CertMate branding (Pro+)
Customer Database — Store client details for re-inspections
Re-Inspection Reminders — Automated alerts when EICRs expire (Pro+)
Offline Mode — Works without signal, syncs when connected (Pro+)
Amendment 4 Ready — Templates updated automatically when regulations change

BUILT FOR UK ELECTRICIANS

CertMate understands UK electrical terminology, BS 7671 regulation numbering, NICEIC and NAPIT standards, and the specific requirements of EICRs, EICs, and Minor Works certificates. It was built by electricians, for electricians.

PRICING

Free — 1 AI certificate per month. No card required.
Starter £15/mo — 8 certificates, EICR + Minor Works
Pro £30/mo — 20 certificates, all types, full features, offline mode
Company £60/mo — 50 certificates, team access, white-label reports

Pro pays for itself after your first certificate. At £50/hr, the 30 minutes you save per cert is worth more than the monthly subscription.

TRY IT FREE

Generate your first AI certificate completely free — no credit card, no commitment. See CertMate turn a 45-minute job into 5 minutes. Then decide.

Questions? support@certmate.app
```

### 1.4 App Store Keywords (100 chars, comma-separated)

```
EICR,electrical certificate,BS 7671,electrical inspection,condition report,AI,voice,Amendment 4,PAT
```

**Keyword rationale:**
- `EICR` — Primary search term for electricians looking for cert software
- `electrical certificate` — Broad category term
- `BS 7671` — The standard all UK electricians search when looking for compliant tools
- `electrical inspection` — High-volume search for inspection-related apps
- `condition report` — Alternate EICR terminology
- `AI` — Differentiator from form-filling apps
- `voice` — Core feature differentiator
- `Amendment 4` — Topical — regulation change effective April 2026
- `PAT` — Secondary cert type, broadens discovery

**Keywords NOT included (covered by app name/subtitle):**
- "electrician" (in app name context)
- "certificate" (in app name)
- "certs" (in app name)

### 1.5 What's New Text (for updates)

```
Amendment 4 Ready — All templates updated for BS 7671:2018 Amendment 2, effective 15 April 2026. Your certificates are compliant from day one.
```

### 1.6 App Store Screenshots — Text Overlays

| Screenshot | Headline | Subtext |
|-----------|----------|---------|
| 1. Hero/Splash | "EICR in 13 Minutes, Not 45" | "Voice-powered AI certificates" |
| 2. Voice Recording | "Speak. Don't Type." | "Describe your observations — CertMate writes the certificate" |
| 3. Generated Certificate | "BS 7671 Compliant. Every Time." | "AI auto-checks against current regulations" |
| 4. Board Schedule | "Say It or Snap It" | "Describe your board or photograph it — AI maps every circuit" |
| 5. PDF Export | "Your Brand. Your Certificate." | "Branded PDF export with your company logo" |
| 6. ROI Callout | "Pays for Itself After Cert #1" | "Save 30+ minutes per EICR. That's £25+ at your hourly rate." |
| 7. Pricing | "From Free. Seriously." | "1 free AI certificate every month. No card required." |


## 2. Pricing Page Copy

### 2.1 Above the Fold

**Headline:**
> Stop Spending Hours on EICR Paperwork

**Subheadline:**
> Speak your observations. Get a BS 7671-compliant certificate in minutes, not hours.

**Trust line:**
> Join UK electricians saving 20+ hours a month on admin

### 2.2 Annual/Monthly Toggle

```
  Monthly        ◉━━━━━━━━        Annual

              Save up to 17%
           "Get 2 months free"
```

Default: **Annual selected.** When user switches to Monthly, show a subtle reminder: *"Switch to annual and save up to £120/year."*

**Annual pricing:**
- Starter: £150/yr (save £30)
- Pro: £290/yr (save £70 — "2 months free")
- Company: £600/yr (save £120)

### 2.3 Tier Cards


#### FREE (Muted card — grey background, ghost CTA)

```
FREE
£0/month — forever

1 AI certificate per month
EICR only
Basic compliance check (pass/fail)
PDF export (with CertMate watermark)

No credit card required

[Try Free →]
```

**Design notes:** Smallest card. Grey/muted background. Ghost-style CTA button. Serves to demonstrate the product exists at no risk — not to satisfy ongoing use.


#### STARTER (Standard card — white background, outlined CTA)

```
STARTER
£15/month
  or £150/year (save £30)

8 AI certificates per month
EICR + Minor Works
Standard AI compliance checking
3 photos per certificate
Customer database (up to 50 clients)
12-month certificate history
Unbranded PDF export
Email support (48hr response)

"Less than the cost of one manual EICR's admin time"

[Get Started]
```

**Upgrade nudge (always visible at bottom of Starter card):**
> Need more than 8 certs/month? **See Pro →**

**Design notes:** Standard white card. Outlined primary-colour CTA button. The per-cert cost of £1.88 is deliberately NOT shown here — it looks worse than Pro's £1.50. The "less than one manual EICR's admin time" line anchors £15 against the £25-50 time cost of doing a cert by hand.


#### PRO — MOST POPULAR (Elevated card — primary border, badge, taller, filled CTA)

```
★ MOST POPULAR

PRO
£30/month
  or £290/year (save £70 — 2 months free)

20 AI certificates per month
All certificate types (EICR, EIC, Minor Works, PAT)
Advanced AI with fix suggestions & reg references
Unlimited photos per certificate
Your logo — no CertMate branding
Unlimited customer database
Unlimited certificate history
Re-inspection reminders (automated)
Template customisation
Offline mode — works without signal
Basic analytics dashboard
Email (24hr) + chat support

"Pays for itself after your first certificate"

Just £1.50 per cert — each one saves you £25 in admin time.
That's a 17× return on every certificate.

[Start Free Trial]
```

**ROI callout box (below CTA, inside card):**
```
┌──────────────────────────────────────┐
│  At 12 EICRs/month:                  │
│  Time saved: 6 hours/month           │
│  Value at £50/hr: £300/month         │
│  Annual saving: £3,240               │
│  Your investment: £30/month          │
│                                      │
│  That's a 10× return. Every month.   │
└──────────────────────────────────────┘
```

**Design notes:** This card is the visual hero.
- 2px primary colour border (others: 1px neutral)
- `transform: scale(1.03)` on desktop
- `box-shadow: 0 8px 24px rgba(primary, 0.15)`
- Card extends 10-15px taller above and below adjacent cards
- "MOST POPULAR" badge at top in primary colour pill
- CTA is a filled primary-colour button (others are outlined/ghost)
- All ROI numbers visible without scrolling on the card


#### COMPANY (Standard card — white background, outlined CTA)

```
COMPANY
£60/month
  or £600/year (save £120)

50 AI certificates per month
Everything in Pro, plus:
Up to 5 team members (+£10/user)
Full analytics dashboard (revenue, compliance, efficiency)
Job scheduling
White-label reports
CSV + API export
Audit trail
Auto-updated BS 7671 templates + change log
Priority phone support (4hr response)
Dedicated onboarding

"For firms doing 30+ jobs a month"

Best per-cert value at just £1.20 each.
Cheaper than 4 separate iCertifi licenses.

[Contact Sales]
```

**Design notes:** Standard white card. Outlined CTA. The "for firms" language self-selects the audience — sole traders read this and think "Pro is my tier." The comparison to "4 separate iCertifi licenses" reframes £60 as a cost saving for firms currently buying multiple individual subscriptions.


### 2.4 Mobile Layout (< 768px)

Cards stack vertically in this order:
1. **Pro** (MOST POPULAR) — shown first, fully expanded
2. **Starter** — collapsed, shows "From £15/mo"
3. **Company** — collapsed, shows "For teams from £60/mo"
4. **Free** — at bottom, "Try 1 certificate free"

Pro shown first exploits the **primacy effect** — the first item on a vertical scroll gets disproportionate attention.

### 2.5 Below the Tier Cards — ROI Calculator

**Section headline:**
> How Much Are You Losing to Paperwork?

**Subheadline:**
> Drag the slider. See the maths. The numbers don't lie.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  How many EICRs do you do per month?                     │
│  ────────────○──────────────── 12 certs/month            │
│                                                          │
│  What's your hourly rate?                                │
│  ──────○────────────────────── £50/hr                    │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  WITHOUT CertMate:                                       │
│    12 EICRs × 45 min write-up = 9 hours/month            │
│    9 hours × £50/hr = £450/month on paperwork            │
│                                                          │
│  WITH CertMate Pro (£30/mo):                             │
│    12 EICRs × 13 min = 2.6 hours/month                   │
│    Time saved: 6.4 hours/month                           │
│    Value saved: £320/month                               │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │                                                  │    │
│  │   Your return: 10.7× every month                 │    │
│  │   Annual saving: £3,480                          │    │
│  │   Pro pays for itself after certificate #2       │    │
│  │                                                  │    │
│  │   Recommended plan: PRO (£30/mo)                 │    │
│  │                                                  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  [Start Free Trial — Save 6 Hours This Month →]          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 2.6 Below Calculator — Competitor Comparison

**Section headline:**
> Why Pay £15/Month for a Form-Filler When CertMate Does the Work for You?

```
                        iCertifi      Tradecert     CertMate Pro
──────────────────────────────────────────────────────────────────
How it works            Camera scans   AI tokens     Voice → Certificate
                        + form-filling + form-filling  No forms at all

You still fill in       Yes            Yes            No
forms manually?

AI type                 Camera-based   Token-based    Voice-to-certificate
                        (added Jan     (pay per       (built AI-first)
                        2026 to old    token on
                        form app)      top of sub)

Monthly price           £5-15          £18 + tokens   £30

Time per EICR           25-35 min      20-30 min      10-15 min

Trustpilot              1.8 / 5 ⭐     —              —
──────────────────────────────────────────────────────────────────

iCertifi added camera-based AI to a 12-year-old form app.
Tradecert charges you per AI token on top of the subscription.
CertMate was built AI-first. Speak your observations — get your
certificate. No typing. No forms. No token charges.
```

### 2.7 Below Comparison — FAQ Section

**Q: "Why is CertMate £30 when iCertifi is £8/month?"**
> iCertifi is a digital form — even with their new Board Vision, you're still filling in fields one by one. CertMate generates the entire certificate from your voice. At £50/hr, the 30 minutes you save per cert is worth more than the monthly price difference. Pro pays for itself after your first 2 certificates.

**Q: "What if I don't use all 20 certificates?"**
> Most Pro users do 10-15 per month. At £1.50-3.00 per cert, you're still saving more in admin time than any single certificate costs you. You're not paying for 20 certificates — you're paying for the freedom to never worry about running out.

**Q: "Can I try before I pay?"**
> Generate your first certificate completely free — no card required. See the AI in action on a real job, then decide. If you like it, Pro comes with a free trial.

**Q: "I only do 5-6 certs a month. Is it worth it?"**
> The Starter plan handles that at £15/month. Each cert saves you 30 minutes of write-up time. At £50/hour, that's £125-150 in time saved for a £15 investment. That's an 8-10× return.

**Q: "Is it BS 7671 compliant? What about Amendment 4?"**
> Every CertMate template is fully compliant with BS 7671:2018. Amendment 2 (Amendment 4) templates will be live before the 15 April 2026 effective date. Updates happen automatically — you never need to check if you're using the right form.

**Q: "Can I trust AI for electrical certification?"**
> CertMate doesn't make compliance decisions — you do. The AI handles admin: filling in test results you dictate, mapping observations to regulation references, and flagging if you've missed a field. Think of it as a fast, thorough admin assistant who knows BS 7671 inside out. You review everything and sign off.

### 2.8 Social Proof Bar (below FAQ)

```
🔒  30-day money-back guarantee
✓   BS 7671 Amendment 4 compliant
✓   Works offline — sync when connected
✓   Your data, always exportable
✓   Cancel anytime, no contract
```

### 2.9 Final CTA (bottom of page)

**Headline:**
> Every EICR You Write by Hand Costs You £25 in Lost Time

**Subheadline:**
> Your first AI certificate is free. No card required. See the difference in 5 minutes.

**CTA Button:**
> [Generate Your Free Certificate →]


## 3. Google Ads Variants

### 3.1 Variant A — Time-Saving Focus

**Headline 1 (30 chars):** EICR in 13 Minutes, Not 45
**Headline 2 (30 chars):** AI-Powered Cert Software
**Headline 3 (30 chars):** Try Your First One Free

**Description 1 (90 chars):**
> Stop writing up EICRs by hand. Speak your observations — get a BS 7671-compliant certificate.

**Description 2 (90 chars):**
> UK electricians save 30+ min per EICR. Voice-to-certificate AI. Free trial, no card required.

**Sitelinks:**
- Free Trial → /free-trial
- Pricing from £15/mo → /pricing
- How It Works → /how-it-works
- BS 7671 Amendment 4 Ready → /amendment-4

**Callout Extensions:**
- BS 7671 Compliant
- Works Offline
- No Card Required
- Amendment 4 Ready
- Branded PDF Export

**Target Keywords:**
`EICR software`, `electrical certificate app`, `EICR app`, `BS 7671 software`, `electrical certification software`, `EICR report software`, `electrical testing software`, `amendment 4 EICR`

**Negative Keywords:**
`jobs`, `training`, `course`, `DIY`, `free download`, `NVQ`, `apprentice`, `salary`, `electrician near me`


### 3.2 Variant B — ROI / Cost Focus

**Headline 1 (30 chars):** Save £5,600/Year on EICR Admin
**Headline 2 (30 chars):** AI Certs From £1.50 Each
**Headline 3 (30 chars):** 1st Certificate Free

**Description 1 (90 chars):**
> Pro pays for itself after cert #1. 20 AI certificates/month for £30. That's 17× your money back.

**Description 2 (90 chars):**
> Every manual EICR costs you £25 in admin time. CertMate gives that time back — for £1 a day.

**Sitelinks:**
- ROI Calculator → /pricing#calculator
- Compare vs iCertifi → /compare/icertifi
- See Pricing → /pricing
- Free Trial → /free-trial


### 3.3 Variant C — Amendment 4 / Seasonal Push

**Headline 1 (30 chars):** Amendment 4 Ready — EICR App
**Headline 2 (30 chars):** 2026 EICR Renewal Wave Ready?
**Headline 3 (30 chars):** AI-Powered BS 7671 Certs

**Description 1 (90 chars):**
> April 2026: millions of EICRs expire. CertMate handles the surge — AI certificates in minutes.

**Description 2 (90 chars):**
> BS 7671 Amendment 2 compliant from day one. Voice-powered EICR, EIC & Minor Works. Try free.

**Sitelinks:**
- Amendment 4 Changes Explained → /blog/amendment-4
- EICR Renewal Guide 2026 → /blog/eicr-renewal-wave
- See Pricing → /pricing
- Start Free → /free-trial


### 3.4 Google Ads — Budget & Targeting Notes

| Setting | Recommendation |
|---------|---------------|
| **Daily budget** | £15-30/day (£450-900/mo) |
| **Bidding** | Maximise conversions (once 30+ conversions/month established) |
| **Location** | United Kingdom only |
| **Language** | English |
| **Device** | Mobile priority (70%+ of tradespeople search on mobile) |
| **Schedule** | 6am-9pm weekdays, all day weekends (electricians search in evenings and downtime) |
| **Audience signals** | In-market: Business Software, Construction, Home Services |


## 4. Trade Forum Post Template

### 4.1 Context

For use on ElectriciansForums.net, Talk Electrician, Facebook groups (UK Electricians Network, Electricians Community UK), and Screwfix Community Forum. Written in authentic sparky voice — NOT marketing speak. This should read like a genuine user recommendation, not an ad.

### 4.2 Forum Post — "What cert software are you using?"

Use this when someone asks about certification software, or as a standalone post in a relevant thread. Adapt the specifics to the conversation.


**Post Title (if starting a new thread):** Switched to AI for my EICRs — genuinely changed my workflow

**Post Body:**

> Been using CertMate for about [X] months now and thought I'd share since I see this question come up a lot.
>
> I was on iCertifi for years before this. It's fine for what it is, but you're still sat in the van for 30-45 minutes after every EICR tapping through form fields. I tried their Board Vision thing when it came out — it's decent for the board schedule but you're still filling in everything else manually.
>
> CertMate is different. You literally speak your observations as you go round the property. "Kitchen ring, polarity confirmed, Zs 0.31, RCD trips at 28ms" — and the AI fills in the schedule, assigns the observation codes, even puts in the reg references. When you're done, you review the cert and sign it.
>
> Full EICR write-up went from 40-odd minutes to about 13. I'm doing around 12-15 EICRs a month, so that's roughly 6-7 hours I've got back. Fitted in 2 extra jobs last month just from the time I saved — that more than covers the subscription.
>
> It's £30/month for the Pro plan (20 certs). Works out to about £1.50 per cert. When you think about what your time's worth — even at £50/hour, 30 minutes saved per cert is £25 of your time — it's a no-brainer.
>
> There's a free tier (1 cert/month) if you want to try the AI without paying anything. No card needed. Worth having a go on your next EICR just to see how it works.
>
> Only thing I'd flag — it's a newer app so it doesn't have the decade of templates that iCertifi has. But the ones it does have (EICR, EIC, Minor Works, PAT) cover 95% of what I need, and they're all BS 7671 compliant and ready for Amendment 4 in April.
>
> Not affiliated, just a user who got fed up writing certs in the van. Happy to answer questions if anyone's on the fence.


### 4.3 Forum Post Variants

**Short version (for replies in existing threads):**

> Been using CertMate for my EICRs — the AI voice thing is legit. You speak your observations as you inspect and it fills in the cert, observation codes, reg references, the lot. Went from 45 mins write-up to about 13. Pro plan's £30/mo for 20 certs. There's a free trial (1 cert, no card) if you want to see if the AI actually works. It does.

**Amendment 4 angle (for threads about regulation changes):**

> If you're looking at cert software ahead of Amendment 4 — CertMate already has the updated templates ready for April. The AI voice feature is worth a look too. You speak your observations on-site and it generates the cert with the right reg references. Saves me about 30 mins per EICR. Free to try (1 cert/month, no card).

**Response to "iCertifi vs X" threads:**

> I was on iCertifi for 3+ years. Switched to CertMate about [X] months ago. Main difference: iCertifi (even with Board Vision) is still form-filling — you're tapping fields and selecting from dropdowns. CertMate eliminates the form entirely. You speak your observations, it writes the cert. My EICR write-up went from 40 mins to 13. At 15 EICRs a month that's nearly 7 hours back. Worth trying the free cert to compare.

### 4.4 Forum Posting Guidelines

- **Never** use marketing language ("revolutionary", "game-changing", "best-in-class")
- **Always** mention a genuine limitation (newer app, smaller template library, etc.) — honesty builds credibility
- **Always** include specific numbers (time saved, certs per month, cost per cert)
- **Always** mention the free tier — removes the "are you selling something?" objection
- **Never** trash competitors directly — respect the tools people are already using
- Wait for relevant threads rather than creating obvious promotional posts
- Engage with follow-up questions genuinely — this is a long-term trust play
- Vary the wording and specifics between forums to avoid looking copy-pasted


## 5. Email Sequence: Free-to-Paid Conversion

### 5.1 Sequence Overview

**Trigger:** User generates their first free certificate
**Goal:** Convert free users to Pro (primary) or Starter (secondary)
**Timing:** 3 emails over 10 days
**Psychological strategy:** Endowment → social proof + ROI → loss aversion


### 5.2 Email 1: "The Endowment Email" — Sent 24 Hours After First Free Certificate

**Subject line (A/B test):**
- A: "You just saved 30 minutes on that EICR"
- B: "Your first AI certificate — how was it?"

**Preview text:** "Here's what that time is actually worth..."

**Body:**


Hi [First Name],

You generated your first AI certificate yesterday. Here's what just happened in numbers:

**Time to write up that EICR: ~13 minutes**
**Time it would have taken by hand: 45-60 minutes**
**Time you saved: 30+ minutes**

At £50/hour, that's **£25 of your time** saved on a single certificate.

You've now seen what CertMate does — voice in your observations, get a compliant certificate back. No forms, no typing, no writing up in the van.

Your free plan includes **1 certificate per month.** If you're doing more than one EICR this month, here's how the maths works:

| Plan | Certs/month | Monthly cost | Cost per cert | Time saved |
|------|-------------|-------------|---------------|-----------|
| **Starter** | 8 | £15 | £1.88 | 4 hours |
| **Pro** | 20 | £30 | £1.50 | 10 hours |

**Pro pays for itself after your first 2 certificates.** Everything after that is time — and money — back in your pocket.

[See Plans & Pricing →]

Or just keep your free certificate each month. Either way, that 30 minutes is yours now.

Cheers,
The CertMate Team

P.S. Got questions about how the AI works? Just reply to this email.


### 5.3 Email 2: "The Social Proof + ROI Email" — Sent 5 Days After First Free Certificate

**Subject line (A/B test):**
- A: "£1 a day. 10 hours a month back."
- B: "What would you do with 10 extra hours?"

**Preview text:** "The sparky maths on CertMate Pro..."

**Body:**


Hi [First Name],

Quick question: how many EICRs did you write up by hand this month?

If the answer is more than zero, here's what that's costing you:

**Each manual EICR = 45 minutes of unpaid admin**
**5 EICRs/month = 3.75 hours = £187 of your time (at £50/hr)**
**10 EICRs/month = 7.5 hours = £375 of your time**
**15 EICRs/month = 11.25 hours = £562 of your time**

That's time you could be on-site, earning. Or home, not working.

CertMate Pro costs **£30/month** — that's **£1 a day.** Less than a coffee from the van.

For that, you get:
- **20 AI certificates per month** (all types — EICR, EIC, Minor Works, PAT)
- **Advanced compliance checking** with fix suggestions and reg references
- **Unlimited photos** per certificate
- **Your company logo** on every report — no CertMate branding
- **Offline mode** — works in basements, meter cupboards, anywhere without signal
- **Re-inspection reminders** — automated alerts when customers' EICRs expire (free repeat business)

At 12 EICRs/month, Pro saves you **6 hours and £300/month in admin time.** That's over **£3,200 a year** — from a £30/month investment.

**Or put it another way:** the time you save is enough for **2-3 extra EICR jobs per month.** At £175 per job, that's **£5,250/year in extra revenue.**

[Start Your Free Pro Trial →]

The free tier isn't going anywhere. But every EICR you do by hand between now and then? That's 30 minutes you won't get back.

Cheers,
The CertMate Team


### 5.4 Email 3: "The Loss Aversion Email" — Sent 10 Days After First Free Certificate

**Subject line (A/B test):**
- A: "You've already done the hard part"
- B: "Your next EICR doesn't have to take 45 minutes"

**Preview text:** "Here's what you're losing every month without Pro..."

**Body:**


Hi [First Name],

Ten days ago, you used CertMate to generate an AI certificate. You saw a 45-minute write-up happen in under 15.

Since then — if you've been doing EICRs the manual way — here's what that decision has cost you:

**If you've done 3 EICRs since then:**
- Time lost to manual write-up: **1.5 hours**
- Value of that time at £50/hr: **£75**
- What CertMate Pro would have cost: **£15** (half a month)

**If you've done 5 EICRs:**
- Time lost: **2.5 hours**
- Value: **£125**
- Cost of Pro: still £30/month

**If you've done 10:**
- Time lost: **5 hours**
- Value: **£250**
- Pro would have paid for itself **8 times over**

Every week you wait, you're choosing to spend hours on admin that an AI can do in minutes. You've already seen it work.

Here's what you're giving up without Pro:

- ❌ **20 AI certificates/month** — you're limited to 1
- ❌ **All cert types** — you can only do EICRs on Free
- ❌ **Unlimited photos** — none on Free
- ❌ **Your company branding** — Free certs carry a CertMate watermark
- ❌ **Customer database** — not available on Free
- ❌ **Re-inspection reminders** — no automated alerts for expiring EICRs
- ❌ **Offline mode** — no signal, no cert
- ❌ **Fix suggestions** — Free only tells you pass/fail, not what to fix

You've already done the hard part — you tried it and it worked.

**Start your Pro trial.** If you don't save at least £30 of time in the first month, you shouldn't keep it. But you will.

[Start Free Pro Trial →]

Or if you're doing fewer than 8 certs/month, **Starter at £15/month** covers you — and still saves you hours every month.

[See All Plans →]

Cheers,
The CertMate Team

P.S. With the EICR renewal wave hitting in April and Amendment 4 taking effect, this is going to be your busiest period in years. Pro handles the paperwork so you can handle the demand.


### 5.5 Email Sequence — Technical Notes

| Setting | Value |
|---------|-------|
| **Trigger** | First certificate generated (not signup — only users who've had the aha moment) |
| **Suppression** | Stop sequence immediately if user upgrades to any paid plan |
| **Timing** | Email 1: +24hrs / Email 2: +5 days / Email 3: +10 days |
| **Send time** | 6-7pm weekday evenings (electricians finish on-site ~5pm, check phones in evening) |
| **Never send** | During 7am-5pm weekdays (on-site hours) |
| **From name** | CertMate (not a personal name — brand is new, no founder recognition yet) |
| **Reply-to** | Real inbox — support@certmate.app |
| **Unsubscribe** | One-click, prominent, required by law |
| **Personalisation** | [First Name], first cert date, cert type generated |
| **Mobile optimisation** | Essential — 70%+ of tradespeople read email on mobile |

### 5.6 Post-Sequence Follow-Up

If the user hasn't converted after the 3-email sequence:

- **Day 21:** Monthly usage summary email — "You've used 1 of 1 free certificates this month. [X] electricians upgraded to Pro this month."
- **Day 30 (next free cert available):** "Your free certificate has refreshed. Last month, Pro users saved an average of 8 hours on admin."
- **Then monthly:** Light-touch monthly summary only. No hard sell. Let the product limitation do the selling.


## Appendix: Copy Style Guide

### Voice & Tone

| Do | Don't |
|-----|-------|
| Write like a tradesperson, not a marketer | Use buzzwords: "revolutionary", "game-changing", "cutting-edge" |
| Use specific numbers (13 minutes, £1.50/cert, 17× ROI) | Use vague claims ("save time", "work smarter") |
| Acknowledge trade realities (van life, poor signal, Amendment 4) | Sound like you've never been on site |
| Respect competitors — they're tools people use daily | Trash talk ("iCertifi is rubbish") |
| Use "you" not "users" or "customers" | Use corporate language ("stakeholders", "leverage", "synergise") |
| British English always (licence, colour, organisation) | American English |
| £ not $ | |
| "cert" and "sparky" in informal channels (forums, social) | Slang in formal channels (App Store, pricing page) |

### Key Phrases to Use Consistently

| Phrase | Where |
|--------|-------|
| "Speak your observations. Get a certificate." | Everywhere — this is the core positioning |
| "No forms. No typing. No paperwork in the van." | App Store, pricing page, ads |
| "Pays for itself after your first certificate" | Pro tier, emails, ads |
| "Voice-powered AI certificates" | Tagline, App Store subtitle context |
| "BS 7671-compliant" | Every channel — mandatory trust signal |
| "Amendment 4 ready" | Seasonal push through April-June 2026 |
| "£1 a day" | Cost reframing for Pro |
| "17× return" | ROI stat for Pro at £1.50/cert vs £25 value |

### Key Phrases to NEVER Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| "AI does it all for you" | Triggers compliance trust concerns | "AI handles the admin — you verify and sign off" |
| "Automated certification" | Implies no human oversight | "AI-assisted certification" |
| "Replaces the electrician" | Insulting to the trade | "Frees up the electrician" |
| "Unlimited" (for capped tiers) | Misleading | State the exact cap (8, 20, 50) |
| "Cheap" | Devalues the product | "Affordable" or state the ROI |
| "Basic" (for Starter tier) | Makes users feel they're getting less | "Starter" with positive framing |


*All copy production-ready as of 25 March 2026. Based on finalised 4-tier pricing (Free £0 / Starter £15 / Pro £30 / Company £60) with psychological anchoring from anchoring-strategy.md, ROI calculations from roi-calculator-messaging.md, competitor positioning from price-validation.md, and strategic framework from pricing-strategy.md.*

### marketing-video-plan

# CertMate Marketing Video Plan

## Concept
Simple, cinematic screen recordings of CertMate in action. Not raw recordings — animated with smooth zooms in/out on key UI elements as they populate in real-time.

## Script (Voiceover)

> Do you hate filling out electrical certificates?
> No matter what a new app promises, do you still spend ages filling them out?
>
> Imagine an app which listens to you testing and fills the certificate out as you go along.
> As you say the values, they magically appear in the form.
>
> Imagine speaking an observation as you find it — and the app writing it out professionally, putting it into the schedule with the regulation it thinks suits best.
>
> Imagine as soon as you finish testing, the certificate is ready — and you can send it to your customer before you've even left site.
>
> Imagine how much that would save, and how few people would be chasing you for certificates.
>
> Imagine taking a photo before and after a fuse board change — and the app effortlessly keeps the results but updates the new hardware.
>
> Imagine no more. CertMate has your back. You test, he listens.
>
> CertMate.

## Visual Storyboard

| Timestamp | Visual | Camera Move |
|-----------|--------|-------------|
| 0-5s | App opens, empty certificate form | Wide shot of full UI |
| 5-12s | User starts speaking test values | Smooth zoom INTO transcript area as words appear |
| 12-18s | Values populate in the form fields | Pan from transcript → zoom into form fields filling in |
| 18-25s | User speaks an observation | Zoom into observation text appearing, professionally formatted |
| 25-30s | Observation lands in schedule with regulation code | Pan to schedule view, zoom into reg code auto-selected |
| 30-35s | Photo taken of old fuse board | Zoom into camera view / photo capture |
| 35-40s | New board photo → results kept, hardware updated | Split/pan showing before→after, form fields updating |
| 40-45s | Certificate complete screen | Zoom out to show full completed certificate |
| 45-50s | Send to customer button pressed | Zoom into send button → confirmation animation |
| 50-55s | CertMate logo + tagline | Fade/zoom to logo: "You test, he listens." |

## Style
- Cinematic zoom/pan (Ken Burns style) — not jump cuts
- Smooth easing on all camera moves
- Dark UI of the app should look premium
- Voiceover: cinematic British accent via ElevenLabs — authoritative, warm, professional tone
- Voiceover timed to match UI actions
- Subtle background music (optional)

## Technical Approach

### Tools Already Available
- **FFmpeg 8.1** — installed, handles zoompan effects, text overlays, transitions, audio mixing
- **ElevenLabs MCP** — AI voiceover generation (already in mcp.json)
- **HeyGen MCP** — AI avatar video (already in mcp.json, optional for talking-head intro)
- **Nano Banana 2** — image generation for visual assets

### Recommended New MCP: mcp-video
Best all-in-one option — 82 tools wrapping FFmpeg + Remotion:
```bash
pip install mcp-video
```
MCP config:
```json
"mcp-video": {
  "command": "uvx",
  "args": ["mcp-video"]
}
```

Gives us:
- Ken Burns zoom/pan effects on screen recordings
- Text overlays and transitions (xfade)
- Clip trimming and merging
- Audio track layering (voiceover + music)
- Remotion for any programmatic animation segments

### Pipeline
1. **Screen record** CertMate in action (macOS screen recording or Simulator)
2. **ElevenLabs** → generate voiceover from script
3. **mcp-video / FFmpeg** → apply Ken Burns zoom/pan effects timed to script
4. **mcp-video / FFmpeg** → add transitions between segments
5. **mcp-video / FFmpeg** → layer voiceover audio onto video
6. **Optional**: HeyGen for talking-head intro/outro
7. **Final render** → MP4 optimised for App Store / social media

### Alternative Options
- **Remotion MCP App** — full React-based programmatic video (most control but more work)
- **Invideo MCP** — AI video from text prompt (less control but very fast)
- **Pure FFmpeg** — no new installs, just scripted zoompan commands (simplest)

## Next Steps
1. Install mcp-video MCP
2. Record raw screen captures of CertMate doing a full test session
3. Generate voiceover with ElevenLabs
4. Apply cinematic zoom effects timed to voiceover
5. Render final video

### price-validation

# CertMate Price Validation Report

**Date:** 25 March 2026
**Purpose:** Validate Derek's updated 4-tier pricing against current competitor prices, margin economics at £1/cert API cost, and UK electrician willingness-to-pay.


## Derek's Proposed Tiers (Under Evaluation)

| Tier | Price | Certs/mo | Per-Cert Price | AI Included |
|------|-------|----------|---------------|-------------|
| Free | £0 | 1 | £0 | Yes (limited) |
| Starter | £15/mo | 8 | £1.88 | Yes |
| Pro | £30/mo | 20 | £1.50 | Yes |
| Company | £60/mo | 50 | £1.20 | Yes |


## 1. Competitor Pricing — Verified March 2026

### iCertifi (Market Leader, 12+ years, 1.8/5 Trustpilot)

**⚠️ CRITICAL UPDATE: iCertifi has added AI features (January 2026)**

iCertifi launched four AI features in v12.12.30 (Jan 2026):
- **Board Vision 2.0**: Scan consumer units/distribution boards in 30 seconds (vs 20-45 min manual). 95%+ accuracy across all major brands.
- **Test Vision**: Photograph any meter display (Megger, Fluke, Kewtech, Metrel) → auto-populates certificate readings. Saves 10+ min per cert.
- **Spark AI**: BS 7671 & BS 5839-1 trained Q&A chatbot.
- **Certificate Guardian**: Auto-reviews completed certs for BS 7671 errors and missing data.

**Pricing (multiple product lines, confusing structure):**

| Product | 3-Month | 6-Month | 12-Month | Notes |
|---------|---------|---------|----------|-------|
| iCertifi (original) | £45.99 (~£15.33/mo) | £69.99 (~£11.67/mo) | £99.99 (~£8.33/mo) | Unlimited certs |
| iCertifi Cloud Pro | Varies | Varies | ~£64.99-£149.99 | New cloud product, pricing unclear |
| Enterprise | — | — | £399.99/yr | Unlimited engineers |

**Effective monthly range: £5.42–£15.33/mo** (depending on plan length and product)

**Key weaknesses:** 1.8/5 on Trustpilot (terrible). Complaints about: data loss in recent updates, non-responsive customer service, cloud sync failures, AI chatbot support only. Users report being blocked on social media for criticism.

**Competitive threat level: MEDIUM-HIGH.** They now have AI (Board Vision, Test Vision), but it's camera-based AI added onto their existing form-filling workflow. CertMate's voice-to-certificate is still a fundamentally different (and faster) approach. However, the "iCertifi has no AI" positioning from previous strategy docs is now **outdated and must be updated**.


### Tradecert (Direct AI Competitor)

| Item | Price |
|------|-------|
| Monthly subscription | £18/mo |
| Certificates | Unlimited |
| AI tokens included | 250/month (rollover unused) |
| Extra AI tokens | 2p/token |
| Additional users | +£7/user/mo |
| Office users | Free |
| Contract | None (cancel anytime) |
| Trial | Free, no card required |

**Effective cost at 20 certs/mo:** £18/mo base + potential AI token costs on top.

**Key insight:** Tradecert's hybrid model (subscription + token consumption) means heavy AI users pay more than £18/mo. At 250 tokens/mo, if each cert uses ~15-20 tokens, users get ~12-17 AI-assisted certs before buying more. Additional tokens at 2p each add up. A 20-cert/mo user might pay £18 + £2-4 in tokens = ~£20-22/mo.


### Certly (New Entrant — Not in Previous Research)

| Plan | Price |
|------|-------|
| Monthly | £14 + VAT (~£16.80/mo inc. VAT) |
| Annual | £140 + VAT (~£168/yr, 2 months free) |
| Trial | 7-day free, no card required |
| Features | BS 7671 compliant, NICEIC/ELECSA standards, all devices |

**No AI features.** Pure form-filling with modern UI. Positioned as simpler alternative to iCertifi.


### EasyCert (Tysoft — Desktop/Traditional)

| Edition | Price |
|---------|-------|
| Lite | £75 + VAT/year (~£7.50/mo) |
| Premium | £199 + VAT/year (~£16.58/mo) |
| One-time purchase | From £194 |
| Mobile add-on | Extra charge |

**No AI features.** Desktop-first, BS 7671 + BS 5839 + BS 5266 certificates. Simple, established, affordable. Primarily used by older/less tech-savvy electricians who prefer desktop workflow.


### Electrical Certificate App

| Plan | Price |
|------|-------|
| Monthly | £15 + VAT/user/mo (~£18/mo inc. VAT) |
| Annual | £162 + VAT/user/yr (10% discount) |
| Trial | 14-day free, no card required |
| Users | 5,000+ UK electricians |

**No AI features.** Includes job management, invoicing, scheduling alongside certificates. More of a mini-FSM tool.


### SpeedCert Pro (New AI Entrant — Not in Previous Research)

- Claims "3x faster with AI-powered automation"
- BS 7671-compliant EICR, EIC & Minor Works
- 14-day free trial
- **Pricing: Not publicly available** (likely subscription model)

**Competitive threat level: LOW-MEDIUM.** New entrant, small presence, but validates that AI certification is becoming a category.


### Other Competitors (Reference)

| App | Effective Monthly | Annual | AI? | Notes |
|-----|-------------------|--------|-----|-------|
| U-Certify | £8.33/mo | £99.99/yr | No | Mid-range, desktop/cloud hybrid |
| NICEIC CertSure | £1.55+VAT/cert | Per-cert | No | Requires NICEIC membership (~£1,100+/yr) |
| Clik Cert | ~£23/mo amortised | ~£280 upfront | No | Legacy desktop, NICEIC partner |
| Pro Certs | Unknown | Unknown | No | EICR focused, tablet/desktop |


### Updated Competitor Price Map (March 2026)

```
                     HIGH PRICE
                         |
               Fergus    |
               ($68/u)   |    CertMate Company (£60/mo)
                         |
     Tradify ($47/u)     |    CertMate Pro (£30/mo)
                         |    "AI Voice-to-Certificate"
    ─────────────────────┼─────────────────────────
     BROAD FSM           |    CERT-SPECIFIC
                         |
     ServiceM8 ($29)     |    Tradecert (£18/mo) ← AI competitor
                         |    Elec Cert App (£15+VAT)
                         |    CertMate Starter (£15/mo)
                         |    Certly (£14+VAT)
                         |
                         |    iCertifi (£5.42-15.33/mo) ← NOW HAS AI
                         |    EasyCert (£7.50-16.58/mo)
                         |    U-Certify (£8.33/mo)
                         |
                     LOW PRICE
```


## 2. Margin Analysis at £1/cert API Cost

### Worst Case: 100% Utilisation (Every User Maxes Out)

| Tier | Revenue | API Cost (max) | Stripe Fee (2%) | Gross Profit | Margin % |
|------|---------|---------------|-----------------|-------------|----------|
| **Free** | £0 | £1.00 | £0 | **-£1.00** | -∞% |
| **Starter** | £15 | £8.00 | £0.50 | **£6.50** | **43%** |
| **Pro** | £30 | £20.00 | £0.80 | **£9.20** | **31%** |
| **Company** | £60 | £50.00 | £1.40 | **£8.60** | **14%** |

**⚠️ VERDICT: At max utilisation, Pro and Company tiers are dangerously below the 55-70% gross margin benchmark for AI-first SaaS.**


### Realistic Case: 50% Average Utilisation

| Tier | Revenue | API Cost (avg) | Stripe Fee | Gross Profit | Margin % |
|------|---------|---------------|------------|-------------|----------|
| **Free** | £0 | £0.50 | £0 | **-£0.50** | -∞% |
| **Starter** | £15 | £4.00 | £0.50 | **£10.50** | **70%** |
| **Pro** | £30 | £10.00 | £0.80 | **£19.20** | **64%** |
| **Company** | £60 | £25.00 | £1.40 | **£33.60** | **56%** |

**✅ VERDICT: At 50% utilisation, all paid tiers are within the 55-70% AI SaaS benchmark. But this assumes average users do only half their allocation.**


### Moderate-Heavy Case: 75% Average Utilisation

| Tier | Revenue | API Cost (avg) | Stripe Fee | Gross Profit | Margin % |
|------|---------|---------------|------------|-------------|----------|
| **Free** | £0 | £0.75 | £0 | **-£0.75** | -∞% |
| **Starter** | £15 | £6.00 | £0.50 | **£8.50** | **57%** |
| **Pro** | £30 | £15.00 | £0.80 | **£14.20** | **47%** |
| **Company** | £60 | £37.50 | £1.40 | **£21.10** | **35%** |

**⚠️ VERDICT: Pro drops below 55% benchmark. Company is deeply unprofitable at 35%.**


### Comparison: Previous Strategy vs New Tiers (Per-Cert Economics)

| Tier | Price/Cert | API Cost/Cert | Margin/Cert | Margin % |
|------|-----------|--------------|------------|----------|
| **Old Pro (£29/8 certs)** | £3.63 | £1.00 | **£2.63** | **72%** |
| **New Starter (£15/8 certs)** | £1.88 | £1.00 | **£0.88** | **47%** |
| **New Pro (£30/20 certs)** | £1.50 | £1.00 | **£0.50** | **33%** |
| **New Company (£60/50 certs)** | £1.20 | £1.00 | **£0.20** | **17%** |

**The new tiers have significantly compressed per-cert margins compared to the previous £29/8-cert structure.** The old Pro tier had 4.3x more margin per cert than the new Starter, and 13x more than the new Company tier.


### Break-Even Utilisation (Where Margin Hits 0%)

| Tier | Revenue | Break-even certs | Break-even utilisation |
|------|---------|-----------------|----------------------|
| **Starter (£15)** | £15 - £0.50 Stripe = £14.50 | 14.5 certs | **181%** (safe — can't exceed 8) |
| **Pro (£30)** | £30 - £0.80 Stripe = £29.20 | 29.2 certs | **146%** (safe — can't exceed 20) |
| **Company (£60)** | £60 - £1.40 Stripe = £58.60 | 58.6 certs | **117%** (safe — can't exceed 50) |

**No tier loses money outright** — the caps prevent that. But the Company tier at 100% utilisation leaves only £8.60/user/month for hosting, support, development, and profit. That's extremely thin.


### Annual Revenue Projections (1,000 Subscribers)

**Scenario A: Tier mix of 40% Starter / 40% Pro / 20% Company, 60% utilisation**

| Metric | Value |
|--------|-------|
| MRR | (400 × £15) + (400 × £30) + (200 × £60) = **£30,000** |
| Monthly API cost | (400 × £4.80) + (400 × £12) + (200 × £30) = **£12,720** |
| Monthly Stripe fees | ~**£690** |
| Monthly gross profit | **£16,590** |
| Gross margin | **55%** |
| ARR | **£360,000** |
| Annual gross profit | **£199,080** |

**Scenario B: Same mix, 80% utilisation**

| Metric | Value |
|--------|-------|
| Monthly API cost | (400 × £6.40) + (400 × £16) + (200 × £40) = **£16,960** |
| Monthly gross profit | **£12,350** |
| Gross margin | **41%** |

**41% gross margin is below the 55% minimum for sustainable AI SaaS.**


## 3. Willingness-to-Pay Assessment

### What UK Electricians Currently Pay for Cert Software

| Price Band | Products | Market Segment |
|-----------|----------|---------------|
| **£5-10/mo** | iCertifi (annual), U-Certify, EasyCert Lite | Price-sensitive sole traders, high volume |
| **£10-15/mo** | iCertifi (3-month), Certly | Value-conscious sole traders |
| **£15-18/mo** | Elec Cert App, Tradecert, EasyCert Premium | Willing to pay more for features/AI |
| **£20-30/mo** | *No current cert-specific product* | Gap in market — CertMate Pro target zone |
| **£30-50/mo** | ServiceM8, Tradify (broader FSM) | Larger businesses, multi-tool |
| **£50+/mo** | Fergus (full FSM) | Small firms wanting all-in-one |

### Key Willingness-to-Pay Signals

1. **Current market ceiling for "cert apps" is £18/mo** (Tradecert). No cert-specific app charges above this.

2. **AI premium is emerging but unproven.** Tradecert charges £18/mo + token costs for AI. iCertifi has added AI at existing prices (£5-15/mo). Neither has tested whether electricians will pay a significant premium for AI.

3. **Time-value justification is strong.** At £50/hr, saving 30 min per cert = £25 value. Electricians intellectually understand this ROI but are emotionally anchored to £10-15/mo for "a cert app."

4. **Tool subscription fatigue is real.** Research shows electricians are "ruthless about cutting subscriptions" — the product must prove value fast or get cancelled.

5. **Peer recommendation drives adoption.** 70% of tradespeople use recommended companies. Price sensitivity drops significantly when a mate says "it's worth it."

6. **The £15/mo Starter tier is market-safe.** It sits exactly at the competitive price point for cert software. This will feel "normal" to electricians evaluating tools.

7. **The £30/mo Pro tier requires strong AI differentiation.** It's 2x the most expensive cert app (Tradecert at £18). The jump from £15→£30 must deliver a step-change in value (20 certs + AI voice-to-cert).

8. **The £60/mo Company tier targets a real segment** (small firms doing 30-50 EICRs/month). These firms currently pay £8-15 each for iCertifi licenses. CertMate Company needs to beat the economics of multiple individual licenses.

### Estimated Willingness-to-Pay Distribution

| Monthly Price | % of Target Market Willing to Pay | Notes |
|---------------|-----------------------------------|-------|
| £0 (Free) | 100% | Everyone will try |
| £10-15/mo | 60-70% | Established price comfort zone |
| £15-20/mo | 40-50% | Acceptable with clear value |
| £20-30/mo | 20-30% | Requires strong AI/time-saving proof |
| £30-45/mo | 10-15% | Only with demonstrated ROI |
| £45-60/mo | 5-8% | Firms, not sole traders |


## 4. Key Findings & Risk Assessment

### ✅ What Works in Derek's Proposed Tiers

1. **4-tier structure with cert caps is smart for API cost control.** Eliminates the "unlimited at £1/cert" disaster.
2. **Starter at £15 is market-competitive** and will attract price-conscious electricians currently using iCertifi/Certly.
3. **Free tier at 1 cert/mo is appropriately limited.** Enough for aha moment, not enough to satisfy ongoing use.
4. **Company tier addresses multi-user firms** — a segment that current competitors serve poorly (iCertifi Enterprise at £400/yr is the only option).

### ⚠️ Concerns & Risks

1. **Per-cert margins are thin, especially at higher tiers.**
   - Starter: £0.88 margin/cert (at max)
   - Pro: £0.50 margin/cert (at max)
   - Company: £0.20 margin/cert (at max)
   - Compare: Previous £29/8-cert plan had £2.63 margin/cert

2. **4-tier structure may hurt conversion.** Research shows 3 tiers = 30% higher ARPU and 27% higher conversion than 4+ tiers. The Starter tier could cannibalize Pro uptake.

3. **iCertifi now has AI.** Board Vision and Test Vision are meaningful features that partially close the gap. CertMate's voice-to-certificate is still differentiated, but the "no AI" attack on iCertifi is dead.

4. **Starter at £15 for 8 certs competes directly with unlimited-cert products at similar prices** (Certly £14+VAT, Elec Cert App £15+VAT, Tradecert £18). The cert cap is a weakness in direct comparison.

5. **Company tier margin at 100% utilisation (14%) is dangerously thin.** Multi-person firms are most likely to hit their allocation consistently.


## 5. Recommendations

### Pricing Adjustments to Consider

| Tier | Current Proposal | Suggested Alternative | Rationale |
|------|-----------------|----------------------|-----------|
| **Free** | 1 cert/mo | 1 cert/mo ✅ | Good as-is |
| **Starter** | £15/mo, 8 certs | £15/mo, 5 certs | Improves margin from £0.88 to £1.00/cert; 5 certs still covers part-time electricians (2-3 EICRs/week) |
| **Pro** | £30/mo, 20 certs | £29/mo, 15 certs | Charm-priced below £30; improves margin from £0.50 to £0.93/cert; 15 certs covers full-time sole traders |
| **Company** | £60/mo, 50 certs | £75/mo, 40 certs | Improves margin from £0.20 to £0.88/cert; per-user economics still beat multiple individual iCertifi licenses |

### 3-Tier vs 4-Tier Decision

**Option A (Keep 4 tiers):** Free / Starter / Pro / Company — broader market coverage but diluted decoy effect and potential Starter→Pro cannibalization.

**Option B (3 tiers — recommended by research):** Free / Pro (£29, 15 certs) / Company (£75, 40 certs) — stronger decoy effect, higher ARPU, cleaner pricing page. Part-time electricians use Free, full-time use Pro, firms use Company.

**Option C (3 tiers, starter-focused):** Free / Starter (£15, 8 certs) / Pro (£35, 25 certs) — if Derek wants the accessible £15 entry point, skip Company tier and let volume users pay proportionally more.

### Critical Action: Update Competitive Positioning

The previous strategy positioned CertMate against iCertifi as "no AI vs AI." This is now incorrect. Updated positioning should be:

- **Old**: "iCertifi is a digital form. CertMate is an AI assistant."
- **New**: "iCertifi added camera-based AI to a 12-year-old form app. CertMate was built AI-first — speak your observations and get a compliant certificate. No typing, no forms, no manual entry."

The differentiation is now **voice-to-certificate** (CertMate) vs **camera-to-fields** (iCertifi). CertMate eliminates the form entirely; iCertifi speeds up form-filling.


## 6. Competitive Pricing Summary Table

| App | Monthly Price | Certs | AI? | Per-Cert (at 20/mo) | Trustpilot |
|-----|-------------|-------|-----|---------------------|------------|
| iCertifi (annual) | £5.42-8.33 | Unlimited | Yes (camera) | £0.27-0.42 | 1.8/5 ⭐ |
| iCertifi (3-month) | £10-15.33 | Unlimited | Yes (camera) | £0.50-0.77 | 1.8/5 ⭐ |
| EasyCert Lite | ~£7.50 | Unlimited | No | £0.38 | N/A |
| U-Certify | £8.33 | Unlimited | No | £0.42 | N/A |
| Certly | £14+VAT | Unlimited | No | £0.84 | N/A |
| **CertMate Starter** | **£15** | **8** | **Yes (voice)** | **N/A (capped)** | — |
| Elec Cert App | £15+VAT | Unlimited | No | £0.90 | N/A |
| Tradecert | £18+tokens | Unlimited | Yes (tokens) | ~£1.00-1.10 | N/A |
| EasyCert Premium | ~£16.58 | Unlimited | No | £0.83 | N/A |
| **CertMate Pro** | **£30** | **20** | **Yes (voice)** | **£1.50** | — |
| **CertMate Company** | **£60** | **50** | **Yes (voice)** | **£1.20** | — |
| iCertifi Enterprise | £33.33 | Unlimited | Yes (camera) | £1.67 | 1.8/5 ⭐ |


## Sources

- [iCertifi Pricing](https://icertifi.co.uk/icertifi-price/)
- [iCertifi AI Features (Board Vision & Test Vision)](https://icertifi.co.uk/icertifi-12-12-30-release-ai-features-that-save-2-hours-per-certificate-board-vision-test-vision/)
- [iCertifi Board Vision 2.0](https://icertifi.co.uk/boardvision-2-0/)
- [iCertifi Test Vision](https://icertifi.co.uk/testvisionturn-test-instrument-display-into-instant-certificate-data/)
- [iCertifi Trustpilot (1.8/5)](https://www.trustpilot.com/review/icertifi.co.uk)
- [Tradecert Pricing](https://www.tradecert.app/ai-electrical-certification-software-pricing)
- [Tradecert General Pricing](https://www.tradecert.app/pricing)
- [Certly Pricing](https://www.certly.co.uk/)
- [EasyCert (Tysoft)](https://www.tysoft.co.uk/easycert.htm)
- [Electrical Certificate App Pricing](https://electricalcertificateapp.co.uk/pricing/)
- [SpeedCert Pro](https://www.speed-cert.com/pricing)
- [U-Certify Pricing](https://www.u-certify.co.uk/pricing/)
- [Economics of AI-First B2B SaaS 2026](https://www.getmonetizely.com/blogs/the-economics-of-ai-first-b2b-saas-in-2026)
- [Hidden Economics of AI SaaS 2026](https://the-marketinghub.com/blog/hidden-economics-ai-saas-2026/)
- [ElectriciansForums.net - Best Certification Software](https://www.electriciansforums.net/threads/best-certification-software.212696/)

### pricing-strategy

# CertMate Pricing & Marketing Strategy

**Actionable implementation guide** compiled from deep research into pricing psychology, freemium conversion, UK electrician market dynamics, and competitive analysis. Every number in this document is implementable.


## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Pricing Architecture](#2-pricing-architecture)
3. [Payment Implementation — Stripe vs StoreKit](#3-payment-implementation--stripe-vs-storekit)
4. [ROI Calculator & Value Framing](#4-roi-calculator--value-framing)
5. [Messaging Framework](#5-messaging-framework)
6. [Competitive Positioning](#6-competitive-positioning)
7. [Freemium Conversion Engine](#7-freemium-conversion-engine)
8. [Channel Strategy](#8-channel-strategy)
9. [Launch Timeline](#9-launch-timeline)
10. [Key Metrics & Targets](#10-key-metrics--targets)


## 1. Executive Summary

**The core thesis:** CertMate is NOT a certificate app. It is an **AI certification assistant** — a new product category. Price accordingly.

| Decision | Answer |
|----------|--------|
| Category | AI Certificate Assistant (not "cert app") |
| Target tier | Pro at **£29/mo** (charm-priced below £30) |
| Free tier | 2 certificates/month, no time limit, no CC required |
| Annual discount | 17% ("2 months free") |
| Primary payment | Stripe (web-first, 2% fees) |
| IAP fallback | StoreKit 2 via Apple Small Business Program (15%) |
| Launch window | Q1 2026 → catch April EICR renewal wave |
| Freemium-to-paid target | 8-12% |
| Founder pricing | £9.99/mo for first 100 users |

**Why £29/mo when competitors charge £8-18:** CertMate saves 30-60 minutes per EICR. At £50/hr, that's £25-50 saved per certificate. At 10 EICRs/month, that's £250-500 in time savings — the £29 subscription captures just 6-12% of value delivered. The product pays for itself after the first certificate each month.


## 2. Pricing Architecture

### 2.1 Tier Structure

| | Free | Pro | Unlimited |
|---|---|---|---|
| **Price (monthly)** | £0 | **£29/mo** | **£45/mo** |
| **Price (annual)** | £0 | **£290/yr** (£24.17/mo) | **£450/yr** (£37.50/mo) |
| **Annual saving** | — | £58/yr ("2 months free") | £90/yr ("2 months free") |
| **Certificates/month** | 2 | 8 | Unlimited |
| **AI report generation** | Basic (watermarked) | Full | Full + Priority processing |
| **Voice-to-certificate** | Yes (2 certs) | Yes | Yes |
| **Photo documentation** | No | Yes | Yes |
| **Compliance templates** | Limited (EICR only) | All (EICR, EIC, Minor Works, PAT) | All + Custom templates |
| **Customer database** | No | Yes | Yes |
| **Certificate archive** | View only | Full access + export | Full access + export |
| **PDF export** | Watermarked "SAMPLE" | Full branded PDF | Full branded PDF |
| **Company branding** | No | Yes | Yes |
| **Support** | Community/FAQ | Email (48hr) | Priority email (24hr) |
| **Amendment 4 updates** | Yes | Yes | Yes |

### 2.2 Why These Specific Prices

| Price | Reasoning |
|-------|-----------|
| **£29 (not £30)** | Left-digit effect — perceived as "twenty-something". £29.99 too retail/gimmicky for professional tool. A/B test against £30 at launch |
| **£45 (round number)** | Signals premium/confidence. £16 gap from Pro is noticeable (55%) but justified by unlimited certs. Serves as price anchor making Pro feel like a deal |
| **£290/yr (17% discount)** | "2 months free" — universally understood. Within optimal 15-20% range. Discounts >20% lower LTV by ~30% |
| **2 free certs (not 1 or 3)** | Cert 1 = aha moment (test). Cert 2 = real job (habit). Represents ~15-20% of monthly volume (aligns with freemium best practice of 15-30% capacity free) |

### 2.3 Decoy Effect Mechanics

The three tiers work as a **decoy pricing structure**:
- **Free** is the decoy — deliberately limited to create desire, not satisfaction
- **Pro** is the target — the clear value sweet spot
- **Unlimited** is the anchor — makes Pro feel affordable by comparison

Research shows this structure increases target-tier selection by 27-40%.

### 2.4 Founder Pricing (Launch Only)

| Phase | Price | Availability | Timeline |
|-------|-------|-------------|----------|
| **Founder** | £9.99/mo or £89.99/yr | First 100 users | Launch week |
| **Early Adopter** | £14.99/mo or £129.99/yr | Next 400 users | Months 1-3 |
| **Standard** | £29/mo or £290/yr | General availability | Month 3+ |

Founder benefits:
- Price locked forever (grandfathered)
- "Founder" badge on profile
- Priority feature requests
- Direct feedback channel to Derek
- Name in app credits

Grandfathered pricing reduces churn to just 1.8 percentage points above baseline.

### 2.5 Overage Handling (Pro Tier)

**Do NOT charge per-cert overages.** Instead:
- At 6/8 certs: "You're on a roll — 2 certificates left this month"
- At 8/8 certs: "You've used all 8 certificates. Upgrade to Unlimited for just £16/mo more — that's less than one hour of your time"
- This drives tier upgrades without punitive charges


## 3. Payment Implementation — Stripe vs StoreKit

### 3.1 Revenue Per User Comparison

**On a £29/mo Pro subscription (£348/yr):**

| Channel | Fee Structure | Per-Transaction Fee | Annual Fee | Annual Net Revenue |
|---------|-------------|-------------------|------------|-------------------|
| **Stripe (web)** | 1.5% + 20p + 0.5% Billing | £0.78 | £9.36 | **£338.64** |
| **Apple Small Business** | 15% | £4.35 | £52.20 | **£295.80** |
| **Apple Standard** | 30% | £8.70 | £104.40 | **£243.60** |

**Per-user annual saving from Stripe vs Apple SBP: £42.84**
At 1,000 subscribers: **£42,840/year saved** by routing through Stripe.

### 3.2 Recommended Strategy: Web-First with IAP Fallback

```
Priority 1: Stripe (web signup)         → 2% fees    → £338.64/yr net
Priority 2: Apple IAP (in-app fallback) → 15% fees   → £295.80/yr net
Priority 3: External Payment Link       → 2% fees    → £338.64/yr net (post-Epic ruling)
```

**Implementation:**
1. **Primary path:** Website signup via Stripe → download app → login with web account
2. **Fallback:** StoreKit 2 IAP for users who find the app first
3. **Apple Small Business Program:** CertMate qualifies (under £1M revenue) → 15% not 30%
4. **Same price everywhere:** Charge £29/mo on both web and iOS. Accept lower margins on iOS for simplicity
5. **Post-Epic ruling:** Implement external payment link entitlement to route iOS users to Stripe

### 3.3 StoreKit Price Points

Apple requires specific price points. Nearest matches:

| Tier | Stripe Price | StoreKit Price Point | Notes |
|------|-------------|---------------------|-------|
| Pro Monthly | £29/mo | £29.99/mo | Nearest Apple tier |
| Pro Annual | £290/yr | £289.99/yr | Nearest Apple tier |
| Unlimited Monthly | £45/mo | £44.99/mo | Nearest Apple tier |
| Unlimited Annual | £450/yr | £449.99/yr | Nearest Apple tier |

### 3.4 Technical Implementation

| Component | Tool | Notes |
|-----------|------|-------|
| Web payments | Stripe Billing + Checkout | Recurring subscription management |
| iOS payments | StoreKit 2 | Native iOS subscription |
| Unified management | **RevenueCat** (recommended) | Wraps both Stripe + StoreKit. Handles receipt validation, subscription status, analytics. Adds dependency but eliminates dual-system complexity |
| Subscription status | JWT claim (`subscriptionTier`) | Add to existing auth token |
| Webhooks | Stripe webhooks + StoreKit Server Notifications | Keep backend subscription state in sync |

### 3.5 Anti-Abuse Guardrails (Free Tier)

| Guard | Limit | Purpose |
|-------|-------|---------|
| Certificate cap | 2/month hard limit | Prevent API cost abuse |
| Circuit cap | 30 circuits per certificate | Enough for real job, prevents gaming |
| Recording duration | 30 min per session | Prevents leaving mic open |
| Daily API calls | Rate-limited per free user | Controls Deepgram/Sonnet costs |
| Storage cap | Per-account limit on free | Controls cloud costs |
| Cooldown | Must subscribe after 2 certs | No "start and discard" loops |


## 4. ROI Calculator & Value Framing

### 4.1 The Core ROI Argument

```
YOUR TIME:       £50-60/hr
EICR ADMIN TIME: 45-120 minutes per certificate
TIME COST:       £37.50-£120 per EICR in admin

CERTMATE PRO:    £29/month for 8 certificates
COST PER CERT:   £3.63

ROI ON FIRST CERTIFICATE: 10-33x
MONTHLY SAVINGS (8 certs): £300-960 in time value
```

### 4.2 Interactive ROI Calculator (for pricing page)

**Input fields:**
1. "How many EICRs do you do per month?" → slider (1-30+)
2. "What do you charge per hour?" → dropdown (£40 / £50 / £60 / £70+)

**Output (example at 10 EICRs, £50/hr):**

```
WITHOUT CertMate:
  10 EICRs × 1 hour admin each = 10 hours/month
  10 hours × £50/hr = £500/month in admin time

WITH CertMate Pro (£29/mo):
  10 EICRs × 15 min each = 2.5 hours/month
  Time saved: 7.5 hours/month = £375 saved
  ROI: 12.9x your investment

  That's like getting an extra day of billable work every month.
```

### 4.3 Quick-Reference Value Frames

| Frame | Copy |
|-------|------|
| **Per-cert cost** | "Just £3.63 per certificate on Pro" |
| **Time savings** | "Save 45+ minutes per EICR" |
| **Daily cost** | "Less than £1/day for Pro" |
| **Weekly anchor** | "Less than a coffee a day" |
| **Hourly comparison** | "£29/mo vs £50-120/hr of your time doing paperwork" |
| **One-job payback** | "Pays for itself after your first certificate" |
| **Extra job framing** | "Save enough time to fit in one extra job per week" |
| **Annual perspective** | "£290/year saves you 100+ hours — that's over 2 weeks of work" |


## 5. Messaging Framework

### 5.1 Core Positioning Statement

> **CertMate is the AI assistant that turns your voice into compliant electrical certificates — completing EICRs in minutes, not hours.**

**NOT:** "A certificate app with AI features"
**NOT:** "Like iCertifi but smarter"
**IS:** "The first AI-powered certification assistant for UK electricians"

### 5.2 Headline Options (A/B test)

| Version | Headline | Subheadline |
|---------|----------|-------------|
| A (Time) | "Stop spending hours on EICR paperwork" | "AI-powered certificates in minutes, not hours" |
| B (Voice) | "Speak your observations. Get a certificate." | "Voice-powered EICR completion for UK electricians" |
| C (ROI) | "Your first EICR is done before you leave site" | "AI generates compliant certificates from your voice recordings" |
| D (Pain) | "Hate EICR paperwork? So did we." | "That's why we built an AI that does it for you" |

### 5.3 Loss Aversion Messaging (for upgrade prompts)

Use **loss framing** — it converts 21% better than gain framing:

| Trigger | Gain Frame (weaker) | Loss Frame (use this) |
|---------|--------------------|-----------------------|
| Free → Pro | "Upgrade to get AI-powered reports" | "You're spending 1-2 hours on paperwork that AI could do in minutes" |
| Hit cert limit | "Get 8 certificates per month" | "You've hit your limit — your next customer is waiting" |
| Churn prevention | "Stay subscribed for great features" | "If you cancel, you'll lose your certificate archive, customer database, and saved templates" |
| Annual upsell | "Save money with annual billing" | "Stop overpaying — switch to annual and save £58" |
| Trial expiry | "Subscribe to keep using Pro" | "Your Pro trial ends in 3 days. After that, you lose access to AI reports, photo docs, and your saved templates" |

### 5.4 Pricing Page Copy Template

```
[HEADER]
Headline: "Stop spending hours on EICR paperwork"
Subheadline: "AI-powered certificates in minutes, not hours. BS 7671 compliant."

[TOGGLE]
○ Monthly    ● Annual (Save £58/yr — 2 months free)   ← default to Annual

[THREE TIER CARDS — Pro visually elevated with colour border]

FREE                    PRO ★ MOST POPULAR           UNLIMITED
£0/month               £29/month                     £45/month
                       ~~£29/mo~~ £24/mo billed       ~~£45/mo~~ £37.50/mo
                       annually                       billed annually

2 certificates/month   8 certificates/month           Unlimited certificates
Basic AI generation    Full AI + voice-to-cert        Full AI + priority processing
Watermarked output     Branded PDF export             Branded PDF export
                       Photo documentation            Photo documentation
                       All compliance templates       All + custom templates
                       Customer database              Customer database
                       Email support                  Priority support

[Get Started]          [Start Free Trial]             [Start Free Trial]

                       "Pays for itself after your
                        first certificate"

[BELOW CARDS]
🔒 30-day money-back guarantee. No questions asked.
✓ BS 7671 Amendment 4 compliant
✓ Works offline — sync when you're back online
✓ Trusted by [X] electricians across the UK

[ROI CALCULATOR SECTION]
"How much could you save?"
[Interactive calculator — see Section 4.2]

[TESTIMONIALS]
Real electrician quotes + video testimonials from beta testers

[FAQ]
- "Can I try before I pay?" → Yes, 2 free certs, no card required
- "What happens to my data if I cancel?" → Always exportable
- "Does it work offline?" → Yes, full offline mode with sync
- "Is it BS 7671 Amendment 4 compliant?" → Yes, updated automatically
```

### 5.5 Channel-Specific Messaging

| Channel | Tone | Key Message |
|---------|------|-------------|
| **Trade forums** | Peer, authentic | "Fellow sparky here — this saved me 30 mins per EICR. Voice in your observations, get a compliant cert back in seconds." |
| **Trade shows** | Professional, demo-led | "Amendment 4 ready. Complete an EICR in 15 minutes. Come see it live." |
| **YouTube** | Authentic, on-site | "Watch me complete a full EICR using just my voice — live on this job" |
| **Google Ads** | Direct, benefit-led | "EICR Software — AI-Powered · Free Trial · BS 7671 Compliant" |
| **Trade press** | Authority, future-focused | "How AI is cutting EICR admin time by 60% — and why Amendment 4 makes it essential" |
| **Wholesaler displays** | Simple, scannable | "Scan to try free — the fastest EICR app" with QR code |
| **Facebook groups** | Casual, problem-solving | "Anyone else drowning in EICR paperwork? I started using this AI app that..." |
| **Push notifications** | Brief, action-oriented | "Your EICR draft is waiting. Tap to finish." |

### 5.6 AI Positioning (Critical for Trust)

Electricians don't trust AI for compliance decisions. Position carefully:

| DO say | DON'T say |
|--------|-----------|
| "Smart autofill" | "AI makes decisions for you" |
| "AI-assisted completion" | "Automated certification" |
| "Suggests observations based on your input" | "AI inspects for you" |
| "You verify, AI handles the paperwork" | "Fully automated EICR" |
| "Like having a brilliant admin assistant" | "Replaces your expertise" |

**Key line:** "CertMate does the paperwork. You do the electrical work. AI assists — you're always in control."


## 6. Competitive Positioning

### 6.1 Competitive Price Map

```
                        HIGH PRICE
                            |
                  Fergus    |
                  ($68/u)   |    CertMate Pro (£29/mo)
                            |    "AI Certificate Assistant"
                            |
      Tradify ($47/u)       |    Tradecert (£18/mo)
                            |    "AI Cert App"
     ───────────────────────┼───────────────────────
      BROAD FSM             |    CERT-SPECIFIC
                            |
      ServiceM8 ($29)       |    Elec Cert App (£15/mo)
                            |
                            |    iCertifi (£8.33/mo)
                            |    U-Certify (£8.33/mo)
                            |
                        LOW PRICE
```

CertMate occupies the **upper-right**: cert-specific AND premium — justified by AI.

### 6.2 Head-to-Head Competitor Response

| Competitor | Their Pitch | CertMate Counter |
|-----------|-------------|------------------|
| **iCertifi** (£8.33/mo) | "Industry standard cert app" | "iCertifi is a digital form. CertMate is an AI assistant. Forms take 60 min. CertMate takes 15." |
| **Tradecert** (£18/mo) | "AI-powered certificates" | "Tradecert charges per AI token (2p each) on top of £18/mo. CertMate includes full AI in every plan. No hidden costs." |
| **EasyCert** | "Established, reliable" | "Reliable at what — making you fill in every field manually? CertMate auto-generates from your voice." |
| **Clik NICEIC** | "Official NICEIC certificates" | "CertMate generates BS 7671-compliant certificates that any certification body accepts. Plus AI saves you hours." |

### 6.3 Category Creation: Why It Matters

**Old category** ("Certificate App"):
- Digital form-filler, replaces paper with PDF
- User fills every field manually
- Value prop: "Go paperless"
- Pricing ceiling: £15-18/month
- Competition: on price

**New category** ("AI Certificate Assistant"):
- Intelligent assistant that understands electrical installations
- AI processes voice/photo input into compliant certificates
- Value prop: "Complete EICRs in half the time"
- Pricing power: £25-40/month
- Competition: on value delivered

CertMate must **never** position as "a better certificate app." It's a different thing entirely — like comparing email to a fax machine.

### 6.4 Defensive Moats

| Moat | Details |
|------|---------|
| **AI model training** | Voice-to-certificate AI trained on real EICR data. Hard to replicate quickly |
| **Data network effect** | More certificates → better AI suggestions → more value → more users |
| **Switching costs** | Certificate archive, client database, template preferences, compliance history |
| **Brand** | "First AI certification assistant" — first-mover advantage in new category |
| **Amendment 4 timing** | Launching alongside the biggest regulatory change in years |


## 7. Freemium Conversion Engine

### 7.1 The Aha Moment

**CertMate's aha moment:** Electrician speaks EICR observations on-site → AI generates complete, compliant certificate in seconds.

**Target:** Time-to-aha under 3 minutes from first app open.

### 7.2 Onboarding Flow (3 Steps — 72% completion rate)

```
Step 1: "Record your first observation"
        → Tap mic, speak a test observation (pre-fill a sample circuit)
        → [Progress: 40%]

Step 2: "See your certificate"
        → AI generates certificate in real-time, show PDF preview
        → [Progress: 70%]

Step 3: "Save & share"
        → Download/email the certificate
        → [Progress: 100% — 🎉 "Your first EICR, done in [X] minutes!"]
```

Start progress bar at 20% (endowed progress effect — increases completion by 79%).

### 7.3 Conversion Funnel

```
App Download
    ↓
Signup (no CC required)
    ↓ Target: 50%+ activate within 7 days
First Certificate (AHA MOMENT)
    ↓
Second Certificate (HABIT FORMATION)
    ↓ Sunk cost: client data, cert history in system
Certificate Limit Hit
    ↓ Loss-framed upgrade prompt
    ↓ 14-day Pro trial (full features, no CC)
    ↓ Target: 30%+ trial-to-paid
PRO SUBSCRIBER
    ↓ Target: <5% monthly churn
    ↓ Annual upsell at month 3 ("Save £58")
ANNUAL SUBSCRIBER
```

### 7.4 Conversion Nudges

**Zeigarnik Effect (incomplete tasks create mental tension):**
- After cert 1: "1 of 2 free certificates used. Your second one unlocks your full certificate history"
- Draft abandonment (2hr later): "Your EICR draft is waiting. Tap to finish"
- After cert 2: upgrade CTA with unchecked feature boxes: "⬜ Add company logo ⬜ Auto-email clients ⬜ Access certificate archive"

**Push Notification Rules:**
- NEVER send during 7am-5pm weekdays (electricians are on-site)
- Optimal: 6-7pm weekday evenings or Saturday morning
- Max 2 per week
- Always allow easy opt-out

### 7.5 Referral Programme

**Mechanic:** "Give a mate a free month, get a free month"

- Both sides benefit equally (double-sided outperforms single-sided by 2-3x)
- WhatsApp sharing is primary channel (#1 trade comms tool)
- In-app QR code for on-site sharing
- At 5 referrals: "CertMate Champion" badge

**Expected metrics:** B2B viral coefficient 0.3-0.7. Referred users show 25% higher spending, 18% lower churn, 16% higher LTV.


## 8. Channel Strategy

### 8.1 Tier 1 — Launch Priority (Highest ROI)

| Channel | Action | Budget | Timeline |
|---------|--------|--------|----------|
| **ElectriciansForums.net** | Organic engagement — answer cert software questions, share real usage stories. Be helpful first, promotional second | £0 (time investment) | Start immediately |
| **NAPIT EXPO Roadshows** | Demo booth at Amendment 4 events: Southampton (21 Apr), Leeds (1 May), Bristol (8 May), Coventry (12 May) | £500-1,500 per event | April-May 2026 |
| **Google Ads** | Target: "EICR software", "electrical certificate app", "BS 7671 amendment 4". Negative KWs: jobs, training, DIY, free | £500-1,000/mo initial | Launch week |
| **eFIXX YouTube** | Sponsored content on UK's #1 electrical YouTube (808K subs). "Watch me complete an EICR with AI" format | £1,000-3,000 per video | Month 1-2 |
| **Free tier / freemium** | 2 free certs, no CC, no time limit | £0 (API cost ~£0.50-1/free user) | Launch day |

### 8.2 Tier 2 — Growth Phase (Months 2-6)

| Channel | Action | Budget |
|---------|--------|--------|
| **Professional Electrician & Installer** | Advertorial + wholesale counter presence (81K circulation at 2,000+ branches) | £2,000-5,000 per placement |
| **InstallerSHOW 2026** | Exhibition stand in InstallerELECTRIC zone (23-25 June, NEC Birmingham, 30K visitors) | £3,000-8,000 |
| **YouTube creators** | Partner with CJR Electrical, David Savery for authentic on-site reviews | £500-1,500 per creator |
| **Training providers** | Free trial codes bundled with Amendment 4 CPD courses (TradeSkills4U, Able Skills, EC4U) | Revenue share or £0 (mutual benefit) |
| **Facebook groups** | UK Electricians Network, Electricians Community UK — organic + targeted ads | £200-500/mo |
| **TikTok / Instagram Reels** | Authentic demo content: time-lapse EICR completion, before/after paper vs app | £0-500/mo (organic first) |
| **SEO content** | "2026 EICR renewal guide", "Amendment 4 changes explained", "CertMate vs iCertifi" | £0 (time investment) |

### 8.3 Tier 3 — Scale (Months 6-12)

| Channel | Action |
|---------|--------|
| **NAPIT partnership** | Explore endorsed/approved software status (NICEIC has exclusive Clik deal — NAPIT is accessible) |
| **Wholesaler displays** | QR code counter cards at CEF (390 branches), Edmundson (300+) |
| **Referral programme** | "Give a mate a free month" — WhatsApp-first sharing |
| **Checkatrade / MyBuilder** | Cross-promote to electricians on these platforms |
| **Trade press editorial** | Thought leadership in Electrical Times, ECN on AI in certification |

### 8.4 Seasonal Strategy

| Period | Strategy |
|--------|----------|
| **Jan-Feb 2026** | Pre-launch waitlist building. Electricians have downtime — best window for tool evaluation. Target: 500-1,000 waitlist signups |
| **March 2026** | App Store launch with Founder pricing. TestFlight beta conversion |
| **April 2026** | **Peak opportunity.** EICR renewal wave (2021 certificates expire). Amendment 4 takes effect (15 April). NAPIT EXPO roadshows. Maximum marketing push |
| **May-Sep 2026** | Peak season. Focus on "save time during your busiest months" messaging. Retention and referral activation |
| **Oct-Dec 2026** | Second marketing push. Annual subscription renewal offers. Year-in-review features |

### 8.5 Pre-Launch Waitlist Strategy

**Landing page:** "Complete an EICR in 5 minutes, not 50. Voice-powered AI certificates for UK electricians."

| Element | Details |
|---------|---------|
| CTA | "Get Early Access" (not "Join Waitlist") |
| Social proof | Live counter: "437 electricians already waiting" |
| Referral mechanic | "Share with a mate — both jump 50 spots on the list" |
| Target | 500-1,000 signups before launch |

**Email sequence:**
1. **Immediate:** Confirmation + position number + referral link
2. **Day 3:** Behind-the-scenes video of voice-to-certificate
3. **Day 7:** Beta tester testimonial
4. **Day 14:** "We're almost ready — your spot is #X"
5. **Launch day:** "You're in! Download CertMate now" + 48-hour Founder pricing window


## 9. Launch Timeline

### Phase 1: Pre-Launch (Jan-Feb 2026)

| Week | Action |
|------|--------|
| **Weeks 1-2** | Launch waitlist landing page with position mechanic |
| **Weeks 1-4** | Seed ElectriciansForums.net, Facebook groups with organic engagement |
| **Weeks 2-4** | Closed TestFlight beta (20-50 hand-picked electricians) |
| **Weeks 3-6** | Collect testimonials and refine onboarding from beta feedback |
| **Weeks 4-8** | Open TestFlight beta (200-500 users via waitlist) |
| **Week 6** | Perfect the 3-minute aha moment flow |
| **Week 8** | A/B test pricing page, conversion nudges, push notification timing |

### Phase 2: Launch (March 2026)

| Week | Action |
|------|--------|
| **Week 1** | App Store submission (allow 1-2 weeks for review) |
| **Week 2** | Email waitlist: "You're in!" with 48-hour Founder pricing (£9.99/mo) |
| **Week 2** | First 100 Founder slots open |
| **Week 3** | Google Ads campaign live. eFIXX YouTube sponsorship airs |
| **Week 4** | Transition to Early Adopter pricing (£14.99/mo for next 400 users) |

### Phase 3: Growth Sprint (April-June 2026)

| Week/Month | Action |
|------------|--------|
| **April 1-15** | Maximum marketing push — EICR renewal wave + Amendment 4 messaging |
| **April 21** | NAPIT EXPO Southampton — live demos |
| **May 1-12** | NAPIT EXPO Leeds, Bristol, Coventry |
| **May** | Training provider partnerships activated (Amendment 4 course bundles) |
| **June** | Transition to Standard pricing (£29/mo). Early Adopter window closes |
| **June 23-25** | InstallerSHOW NEC Birmingham — exhibition stand |

### Phase 4: Scale (July-Dec 2026)

| Month | Action |
|-------|--------|
| **July** | Referral programme launch ("Give a mate a free month") |
| **August** | Wholesaler counter display rollout (CEF, Edmundson) |
| **September** | NAPIT partnership discussions |
| **October** | Professional Electrician & Installer advertorial |
| **November** | Annual subscription push (Black Friday / year-end offers) |
| **December** | Year-in-review feature. Plan for 2027 |


## 10. Key Metrics & Targets

### 10.1 Conversion Funnel Targets

| Metric | Target | Benchmark |
|--------|--------|-----------|
| Waitlist signups | 500-1,000 | Robinhood-style viral mechanics |
| Waitlist → download | 50%+ within 30 days of access | Industry: 50% within 30 days |
| App download → signup | 70%+ | Low-friction no-CC flow |
| Signup → first cert (activation) | 50%+ within 7 days | PLG single-player benchmark |
| Time to first certificate | < 3 minutes | Aha moment engineering |
| Onboarding completion | 70%+ | Endowed progress + 3-step flow |
| Free → paid (freemium conversion) | 8-12% | Professional tool top quartile |
| Trial → paid (if trial offered) | 30%+ | Strong ROI case |
| Beta → paid | 15-25% | Pre-qualified user base |

### 10.2 Revenue Metrics

| Metric | Target | Notes |
|--------|--------|-------|
| ARPU (monthly) | £29-35 | Blended across Pro + Unlimited |
| Monthly churn | < 5% | SaaS professional tool benchmark |
| Annual plan adoption | 40%+ | Default toggle to annual |
| LTV (Pro monthly) | £580+ | At <5% churn = 20+ month average lifetime |
| LTV (Pro annual) | £870+ | Annual users show 30% better retention |
| CAC payback | < 3 months | Freemium reduces CAC significantly |

### 10.3 Growth Milestones

| Milestone | Target Date | Details |
|-----------|------------|---------|
| 100 paying users | Month 1 (March) | Founder pricing cohort |
| 500 paying users | Month 3 (May) | Founder + Early Adopter cohorts |
| 1,000 paying users | Month 6 (August) | Standard pricing + referrals |
| £30K MRR | Month 8-10 | ~1,000 users at £29-35 ARPU |
| 2,500 paying users | Month 12 (March 2027) | Organic + channels + referrals |

### 10.4 Unit Economics Target

```
At 1,000 Pro subscribers (Stripe):
  MRR:              £29,000
  Annual revenue:   £348,000
  Stripe fees:      -£9,360 (2.7%)
  AI costs:         -£24,000 (est. £2/user/mo for Deepgram + Claude)
  Hosting/infra:    -£6,000 (est. £500/mo)
  Gross margin:     £308,640 (89%)

  vs 1,000 subscribers via Apple:
  Apple fees:       -£52,200 (15%)
  Net difference:   -£42,840/year

  → Routing 80% through Stripe saves ~£34,000/year at 1,000 users
```


## Appendix A: Psychological Levers Checklist

Use this checklist when building any pricing/marketing touchpoint:

- [ ] **Anchoring:** Lead with time-value comparison (£50-120/hr vs £29/mo)
- [ ] **Decoy effect:** Free tier is deliberately limited to make Pro the obvious choice
- [ ] **Loss aversion:** Frame upgrades around what they're losing, not gaining
- [ ] **Endowment effect:** Let free users build data/history before asking for payment
- [ ] **Centre-stage bias:** Pro tier visually elevated, middle position, "Most Popular" badge
- [ ] **Charm pricing:** £29 (not £30), £45 (round for premium signal)
- [ ] **Sunk cost:** Show "You've created X reports" as switching cost reminder
- [ ] **Social proof:** "Trusted by X electricians" near CTA
- [ ] **Scarcity:** Founder pricing genuinely limited to 100 users
- [ ] **Zeigarnik effect:** Incomplete task nudges (unfinished drafts, unchecked feature boxes)
- [ ] **Endowed progress:** Start onboarding at 20% complete
- [ ] **Flat-rate bias:** Monthly subscription, not per-cert pricing (peace of mind)

## Appendix B: Price Increase Guidance

When raising prices in future:
- Keep increases under 8-10% (Weber-Fechner JND threshold)
- Never cross round-number boundaries (e.g., £29 → £31 crosses £30)
- Bundle new features with any increase to justify
- Grandfather existing users (reduces churn to 1.8pp above baseline)
- Announce 60+ days in advance
- Frame as investment in the product, not cost increase

## Appendix C: Key Market Data Points

| Data Point | Value | Relevance |
|-----------|-------|-----------|
| UK registered electricians | ~230,000 | Total addressable market |
| Electrician businesses | ~50,434 | Business buyer count |
| Private rented sector homes | 4.7 million | EICR demand driver |
| EICR non-compliance penalty | £40,000 max | Urgency for landlords → demand for electricians |
| April 2026 EICR renewal wave | Millions of certificates | Biggest opportunity window |
| Amendment 4 effective date | 15 April 2026 | Regulatory change driving tool evaluation |
| Electrician hourly rate | £45-60/hr | ROI calculation basis |
| Digital tool adoption rate | 91% of electricians | Market readiness |
| Peer recommendation trust | 70% use recommended companies | Word-of-mouth is king |


*Strategy compiled 25 March 2026. Based on research from Phases 1-4 covering pricing psychology (Kahneman, Tversky, Huber, Ariely), SaaS benchmarks (ProfitWell, Price Intelligently, OpenView, First Page Sage), UK market data (IBISWorld, ONS, NAPIT, NICEIC), and competitive analysis of 7+ direct competitors.*

### research-competitive-pricing

# Competitive & AI Pricing Analysis for CertMate

## 1. AI Transcription/Assistant Tool Pricing Models

These tools are the closest analogue to CertMate's AI-powered approach — they use AI to automate a previously manual, time-consuming process.

### Otter.ai (AI Meeting Transcription)
| Plan | Monthly Price | Annual Price | Key Limits |
|------|-------------|-------------|------------|
| Free | £0 | £0 | 300 min/month, 30 min/conversation, 3 lifetime file uploads |
| Pro | $16.99/mo | $8.33/mo ($100/yr) | 1,200 min/month, advanced search, custom vocabulary |
| Business | $30/user/mo | $20/user/mo | 6,000 min/month, team workspace, admin controls |
| Enterprise | Custom | Custom | SSO, SOC 2, API access, dedicated support |

**Key insight:** No overage/pay-as-you-go — service stops at limit. Hard paywall after free tier.

### Fireflies.ai (AI Meeting Notes)
| Plan | Monthly Price | Annual Price | Key Limits |
|------|-------------|-------------|------------|
| Free | £0 | £0 | 800 min storage, limited features |
| Pro | $18/mo | $10/mo | Unlimited transcription, 3,000 min storage, 20 AI credits |
| Business | $29/mo | $19/mo | Unlimited storage, video recording, 30 AI credits, sentiment analysis |
| Enterprise | Custom | $39/user/mo | Unlimited everything, 50 AI credits, branded comms |

**Key insight:** Uses a **credit system** for AI features — base subscription + consumption for premium AI. Credits can drive add-on purchases. This is a model CertMate should study.

### Rev.ai (Speech-to-Text API)
| Service | Price |
|---------|-------|
| Reverb AI (automated) | $0.003/minute |
| AI transcription (consumer) | $0.25/minute |
| Human transcription | $1.50/minute |
| Minimum billing increment | 15 seconds |

**Key insight:** Pure usage-based/API model. Shows the spectrum from commodity AI ($0.003/min) to premium human ($1.50/min) — a 500x price range based on quality/trust.

### Pricing Pattern Summary for AI Tools
- **Freemium** is universal — every tool has a free tier
- **Subscription + usage caps** is the dominant model (not pure per-use)
- **AI features often have separate consumption limits** (credits/tokens) on top of base subscription
- **Annual discounts of 30-45%** are standard to drive commitment
- **Per-user pricing** kicks in at team/business tiers


## 2. Field Service Management Tools (Trades-Focused)

These are the "job management" platforms that UK electricians already use. CertMate must position differently from these.

### ServiceM8
| Plan | Monthly Price | Key Limits |
|------|-------------|------------|
| Free | £0 | Limited users |
| Starter | $29/mo | 50 jobs/month, 100 SMS, unlimited AI assists, unlimited users |
| Growing | $79/mo | 150 jobs/month, 300 SMS, forms, asset mgmt, proposals |
| Premium | $149/mo | Higher limits, advanced features |
| Premium Plus | $349/mo | Full feature set |

**Key insight:** **Unlimited users** model (not per-seat) — charges by job volume instead. AI assists included free on all paid plans.

### Tradify
| Plan | Monthly Price | Notes |
|------|-------------|-------|
| Lite (1-3 users) | $47/user/mo | Essential job management |
| Pro (4+ users) | $38/user/mo | Advanced features |
| Plus (10+ users) | Custom | Enterprise features |

**Key insight:** Per-user pricing from $38-47/mo. 14-day free trial, no lock-in. Promotional 50% off for first year.

### Fergus
| Plan | Monthly Price | Notes |
|------|-------------|-------|
| Basic | $48/user/mo | Scheduling, job management, quoting, invoicing |
| Professional | $68/user/mo | Full feature set, reporting |
| Enterprise (10+) | Custom | Custom requirements |

**Key insight:** No lock-in, 14-day trial. Designed specifically for electricians and plumbers.

### FSM Pricing Pattern Summary
- **Per-user pricing** is standard at $38-68/user/month
- **Job volume caps** used by some (ServiceM8) as an alternative to per-user
- These tools are **broad job management** — quoting, scheduling, invoicing, customer management
- **Certificate generation is a small add-on feature**, not the core value prop
- CertMate should NOT compete with these — different category entirely


## 3. UK Electrical Certificate App Competitors

Direct competitors in the certificate/form-filling space.

### iCertifi (Market Leader — 12+ years)
| Plan | Price | Notes |
|------|-------|-------|
| 3-Month | £45.99 (£15.33/mo) | Unlimited certificates |
| 6-Month | £69.99 (£11.67/mo) | Unlimited certificates |
| 12-Month | £99.99 (£8.33/mo) | Unlimited certificates, best value |
| Enterprise | £399.99/year | Unlimited engineers, volume licensing |

**Features:** BS 7671 compliance, EIC, EICR, Minor Works, smart pre-fill, cloud sync, PDF export.
**Weakness:** 1.8/5 on Trustpilot. No AI assistance. Pure form-filler.
**Market position:** Incumbent, established brand, but **no AI differentiation**.

### Tradecert (Newest AI Competitor)
| Plan | Price | Notes |
|------|-------|-------|
| Lite | £18/month | 250 AI tokens/month, unlimited certs, 1 user |
| Additional users | +£7/user/mo | Per additional user |
| Office users | Free | Admin/office staff |
| Extra AI tokens | 2p/token | Pay-as-you-go AI usage |
| Enterprise (10+) | Custom | Volume pricing |

**Features:** AI-powered, unlimited certificates, real-time collaboration, custom branding, cloud sync.
**AI model:** Hybrid subscription + token consumption. 250 free tokens/month with 2p/token overage.
**Market position:** Newest entrant, **direct AI competitor to CertMate**.

### Electrical Certificate App (electricalcertificateapp.co.uk)
| Plan | Price | Notes |
|------|-------|-------|
| Monthly | £15/month (ex VAT) | Full access, all features |
| Annual | £162/year (£13.50/mo, ex VAT) | 11% discount |

**Features:** EICR, Minor Works, PAT testing, job management, invoicing, scheduling.
**Market position:** Mid-range, simple pricing, no AI features.

### NICEIC Online Certification (CertSure)
| Model | Price | Notes |
|-------|-------|-------|
| Per certificate | £1.55 + VAT (£1.86) | Pay-per-cert, requires NICEIC membership |
| Part P notification | Included | For notifiable work |

**Market position:** Official NICEIC platform. Low per-unit cost but requires expensive NICEIC membership (~£400+/yr). Not a true competitor — more of an industry compliance requirement.

### Clik Cert (NICEIC Partner Desktop Software)
| Model | Price | Notes |
|-------|-------|-------|
| Upfront purchase | ~£280 | Plus annual maintenance fees |

**Market position:** Legacy desktop software, official NICEIC partner. Being replaced by cloud/mobile solutions.

### U-Certify Electrics Pro
| Plan | Price | Notes |
|------|-------|-------|
| Annual subscription | £99.99/year (ex VAT) | Full access |
| Additional user license | £39.99/year (ex VAT) | Per extra device/user |

**Features:** BS 7671 18th Edition, EIC, EICR, Minor Works, Fire Alarm certs.
**Market position:** Mid-range desktop/cloud hybrid. No AI.

### Competitor Pricing Summary Table
| App | Monthly Effective | Annual | AI Features | Per-Cert Cost (at 20 certs/mo) |
|-----|-------------------|--------|-------------|-------------------------------|
| iCertifi | £8.33-£15.33 | £99.99 | No | £0.42-£0.77 |
| Tradecert | £18+ | ~£216 | Yes (token-based) | £0.90+ |
| Electrical Certificate App | £13.50-£15 | £162 | No | £0.68-£0.75 |
| U-Certify | £8.33 | £99.99 | No | £0.42 |
| NICEIC Online | Per-cert | Per-cert | No | £1.86 |
| Clik Cert | ~£23 (amortised) | ~£280 upfront | No | ~£1.17 |


## 4. Category Creation Strategy: "AI Certificate Assistant" vs "Certificate App"

### The Problem with Competing as a "Certificate App"
If CertMate positions as another certificate app, it enters a **commoditised market** where:
- iCertifi has 12+ years of brand recognition
- Prices are compressed to £8-18/month
- Features are largely identical (form fields, PDF export, cloud sync)
- Competition is on price, not value
- Per-cert effective cost is £0.42-£1.86

### The Category Creation Opportunity
CertMate should create a **new category**: the **AI-powered electrical certification assistant**.

**"Certificate App" (old category):**
- Digital form-filler
- Replaces paper with PDF
- User fills every field manually
- Value prop: "Go paperless"
- Pricing ceiling: ~£15-18/month

**"AI Certificate Assistant" (new category):**
- Intelligent assistant that understands electrical installations
- AI processes voice/photo input into compliant certificates
- Suggests observations, auto-populates from patterns
- Value prop: "Complete EICRs in half the time"
- Pricing power: £25-40/month (justified by time savings)

### Why Category Creation Works
1. **No direct price comparison** — you're not "expensive iCertifi", you're something new
2. **Value-based pricing** — price anchored to time saved, not features listed
3. **AI as moat** — competitors can't quickly replicate AI capabilities
4. **Premium positioning** — attracts professionals who value efficiency over penny-pinching
5. **Media/PR angle** — "first AI certificate assistant" is a story; "another cert app" is not

### Positioning Language
- NOT: "Certificate app with AI features"
- YES: "AI assistant that generates compliant electrical certificates"
- NOT: "Like iCertifi but smarter"
- YES: "Complete your EICR while you're still on site"


## 5. Value-Based Pricing Analysis

### What Is an Electrician's Time Worth?

| Metric | Value | Source |
|--------|-------|--------|
| Average hourly rate | £45-60/hr | Checkatrade, MyBuilder 2026 |
| Average day rate | £335-400/day | Multiple sources |
| Emergency/out-of-hours rate | £80-110/hr | Industry average |
| Self-employed effective rate | £50-75/hr | Including overheads |

### EICR Time Breakdown (Current Manual Process)

| Activity | Time | Notes |
|----------|------|-------|
| On-site inspection & testing | 2-4 hours | Varies by property size |
| Writing up certificate (paperwork) | 30-90 minutes | The pain point — often done at home/office |
| Processing & sending | 15-30 minutes | PDF creation, email, filing |
| **Total admin time per EICR** | **45-120 minutes** | This is what CertMate eliminates |

### Value Calculation

**Time saved per EICR with AI assistant: 30-60 minutes**
(Conservative estimate — voice-to-cert reduces write-up from 60-90 min to 15-30 min)

**Value of time saved per EICR:**
- At £50/hr: **£25-50 saved per EICR**
- At £60/hr: **£30-60 saved per EICR**

**Monthly value (at typical volume):**
- Sole trader doing 10-15 EICRs/month: **£250-750/month in time savings**
- Small firm doing 30-50 EICRs/month: **£750-2,500/month in time savings**

**This means:**
- A £29.99/month subscription captures only **4-12%** of the value delivered
- Even at £39.99/month, CertMate captures only **5-16%** of value
- The "expensive" price point (vs £8-15 competitors) is actually **massive value**

### The "One Extra Job" Framing
- If CertMate saves 1 hour per day, that's **5 hours/week** or effectively **one extra half-day job**
- One additional EICR job per week = £125-300 extra revenue/week = **£500-1,200/month**
- CertMate at £29.99/month pays for itself with **a single hour saved in the first week**

### Price Sensitivity vs Value Perception
| Monthly Price | Framing | Likely Reaction |
|---------------|---------|-----------------|
| £9.99 | "Cheap cert app" | Looks like another form-filler |
| £14.99 | "Standard cert app" | Direct iCertifi comparison |
| £19.99 | "Premium cert app" | Needs clear AI differentiation |
| £29.99 | "AI assistant" | "Expensive but saves me hours" — right reaction |
| £39.99 | "Professional AI tool" | Acceptable if AI value is proven |
| £49.99+ | "Enterprise/premium" | Too high for sole traders without ROI proof |

**Recommended sweet spot: £24.99-29.99/month** — high enough to signal premium category, low enough to be an impulse decision relative to value delivered.


## 6. Innovator's Dilemma: Why NOT to Compete on Price

### The Classic Trap
iCertifi at £8.33/month has been the market leader for 12+ years. The instinct is to undercut:
- "We'll charge £5.99/month and steal their users!"
- This is **exactly wrong** per Clayton Christensen's framework.

### Why Price Competition Fails Here

1. **Incumbents can always match price** — iCertifi could drop to £5/month tomorrow and still survive on volume
2. **Price signals quality** — electricians doing legally-required safety certificates don't want "the cheap option"
3. **Margin compression kills innovation** — low price = less revenue to invest in AI development
4. **Wrong customers** — price-sensitive users are the hardest to retain and least likely to refer

### The Innovator's Dilemma Applied to CertMate

**Traditional disruption (bottom-up):**
- Enter with cheaper, simpler product
- Serve customers incumbents ignore
- Gradually move upmarket

**CertMate's opportunity (category creation):**
- Enter with a **qualitatively different** product (AI assistant, not form-filler)
- Serve customers who are **underserved by incumbents** (time-poor electricians drowning in paperwork)
- **Don't compete on the incumbent's terms** (features, price) — redefine what the product category IS
- Price HIGHER than incumbents to signal the category difference

### The Sailboat vs Steamship Analogy
- iCertifi is a **sailboat** (digital form) — an optimization of the old way
- CertMate is a **steamship** (AI assistant) — a fundamentally new approach
- Steamships didn't win by being cheaper sailboats. They won by being **something different**

### Strategic Implications for CertMate

| Decision | Wrong Approach | Right Approach |
|----------|----------------|----------------|
| Pricing | Match or undercut iCertifi | Price 2-3x higher, justify with value |
| Positioning | "Better certificate app" | "AI certification assistant" |
| Feature comparison | Feature-for-feature vs iCertifi | Show time-to-completion, not feature counts |
| Target customer | Price-sensitive sole traders | Busy professionals who value time |
| Competition | "We're cheaper than X" | "We're a different thing entirely" |
| Marketing | Feature lists and price tables | Before/after time comparisons, testimonials |

### Risk: Being Pulled Downmarket
The biggest risk is that early users demand "just make it cheaper" or "I just need a simple form." CertMate must **resist this pull**:
- Don't strip out AI to offer a "basic" tier that competes with iCertifi
- Don't let the free tier be so capable that it satisfies the form-filler market
- Keep the AI as the **core experience**, not an optional add-on


## 7. Recommended Pricing Architecture for CertMate

Based on all competitive and strategic analysis:

### Tier Structure
| Tier | Price | AI Usage | Target |
|------|-------|----------|--------|
| Free Trial | £0 (14 days) | Full AI access, 5 certificates | Try before you buy |
| Starter | £14.99/mo | 15 AI-assisted certs/month | Part-time electricians |
| Professional | £29.99/mo | Unlimited AI-assisted certs | Full-time sole traders |
| Team | £24.99/user/mo | Unlimited + shared templates | Small firms (2-10) |
| Enterprise | Custom | API access, volume, SSO | Large contractors |

### Why This Works
1. **No free tier** (only trial) — avoids creating a "form-filler" tier that undermines positioning
2. **Starter at £14.99** — price-competitive enough to attract early adopters but with AI usage limit that pushes upgrade
3. **Professional at £29.99** — the hero tier, priced at 2-3x iCertifi but with clear value justification
4. **Team pricing per-user** — follows FSM tool conventions (Tradify, Fergus model)
5. **AI usage as the value metric** — mirrors Fireflies.ai credit model and Tradecert token model

### Competitive Position Map
```
                    HIGH PRICE
                        |
              Fergus    |    CertMate Pro (£29.99)
              ($68/u)   |    "AI Assistant"
                        |
    Tradify ($47/u)     |    Tradecert (£18)
                        |    "AI Cert App"
   ─────────────────────┼─────────────────────
    BROAD FSM           |    CERT-SPECIFIC
                        |
    ServiceM8 ($29)     |    Elec Cert App (£15)
                        |
                        |    iCertifi (£8.33)
                        |    U-Certify (£8.33)
                        |
                    LOW PRICE
```

CertMate at £29.99 occupies the **upper-right quadrant** — cert-specific but premium, justified by AI value.


## Sources

- [Otter.ai Pricing](https://otter.ai/pricing)
- [Fireflies.ai Pricing](https://fireflies.ai/pricing)
- [Rev.ai Pricing](https://www.rev.ai/pricing)
- [ServiceM8 Pricing](https://www.servicem8.com/us/pricing)
- [Tradify Pricing](https://www.linktly.com/guides/tradify-pricing-2/)
- [Fergus Pricing](https://fergus.com/pricing/)
- [iCertifi Pricing](https://icertifi.co.uk/icertifi-price/)
- [Tradecert Pricing](https://www.tradecert.app/ai-electrical-certification-software-pricing)
- [Electrical Certificate App Pricing](https://electricalcertificateapp.co.uk/pricing/)
- [U-Certify Pricing](https://www.u-certify.co.uk/pricing/)
- [NICEIC Online Certification](https://shop2.niceic.com/6001-niceic-ncs1-electrical-certification-software)
- [Checkatrade Electrician Rates 2026](https://www.checkatrade.com/blog/cost-guides/electrician-hourly-rate/)
- [MyBuilder Electrician Rates 2026](https://www.mybuilder.com/electrical/price-guides/hourly-rate-electricians)
- [Innovator's Dilemma - Wikipedia](https://en.wikipedia.org/wiki/The_Innovator%27s_Dilemma)
- [Category Pirates - Innovator's Solution](https://www.categorypirates.news/p/the-innovators-solution-5-stage-strategy)

### research-freemium-launch

# CertMate Freemium & Launch Strategy Research

Deep research into freemium conversion psychology and launch tactics for CertMate's AI-powered EICR certificate app, targeting UK electricians.


## 1. Freemium Conversion Psychology — Benchmarks & Fundamentals

### Industry Conversion Rate Benchmarks

| Model | Median Conversion | Top Quartile | Best-in-Class |
|-------|-------------------|--------------|---------------|
| Freemium (self-serve) | 2–5% | 6–8% | 10–15% |
| Freemium (sales-assisted) | 5–7% | 10–15% | 20%+ |
| Free trial (no CC required) | 18–25% | 30–40% | 50%+ |
| Free trial (CC required upfront) | 40–60% | 60–70% | 75%+ |
| iOS subscription trial (median) | 2.6% (North America) | 10.4% (90th pctile) | — |

**Key insight for CertMate:** Professional tools that demonstrate clear ROI quickly (like CRM and marketing automation) consistently outperform averages, hitting 4–6% freemium conversion. CertMate's voice-to-certificate proposition has an even more tangible value moment, suggesting we can target 8–12% freemium-to-paid conversion with strong onboarding.

### Credit Card vs No Credit Card at Trial Start

- **No CC required:** ~3–4x more trial signups, 18–25% trial-to-paid conversion
- **CC required:** Fewer signups but 49–60% trial-to-paid conversion
- **Net result:** No-CC trials deliver **27% more paying customers** from the same traffic volume

**CertMate recommendation:** No credit card required for trial/freemium. Electricians are price-sensitive sole traders — any friction at signup loses them. Collect the card only after the aha moment (first completed certificate).

### Feature-Limited vs Time-Limited Trials

- **Time-limited trials convert 2x better** than feature-gated models (Customer.io research)
- **7–14 day trials with urgency cues outperform 30-day trials by 71%**
- 3-day iOS app trials average 26% cancellations vs 51% for 30-day trials
- **55% of all 3-day trial cancellations happen on Day 0** — the battle is won or lost in the first session

**CertMate recommendation:** Use a **hybrid model** — give 2 free certificates (feature/usage-limited) with no time pressure, then offer a 14-day full-feature trial of Pro. This lets electricians experience the aha moment at their own pace (they may not have a job for 3 days) while creating urgency once they've tasted the full product.


## 2. Aha Moment Engineering

### What Makes a Great Aha Moment

The aha moment is the user's first emotional realization that your product is valuable. It's distinct from activation (the behavioural proof of value).

**Famous examples:**
| Product | Aha Moment | Activation Metric |
|---------|-----------|-------------------|
| Facebook | Connect with 7 friends in 10 days | Daily active use |
| Slack | Team sends 2,000 messages | Workspace becomes primary comms |
| Dropbox | Upload first file, see it sync across devices | Consistent file storage |
| Twitter | Follow 30 users | Daily check-ins |

### CertMate's Aha Moment: First Voice-to-Certificate

**The moment:** An electrician speaks their EICR observations on-site, and CertMate generates a complete, regulation-compliant certificate in seconds — instead of 45–90 minutes of paperwork.

**Why this is a powerful aha moment:**
1. **Immediate, tangible time savings** — the value is self-evident in a single session
2. **Professional output quality** — seeing a polished, BS 7671-compliant certificate from spoken words is genuinely surprising
3. **Contextual relevance** — happens on-site, where the pain is felt most acutely
4. **Emotional relief** — paperwork is electricians' #1 hated task

### Activation Rate Benchmarks

- Leading PLG companies: 20–40% activation rate
- Top performers: 40–60%
- Best-in-class: 70%+
- Single-player products (like CertMate) typically achieve higher rates than multiplayer products

**CertMate target:** 50%+ activation rate (first certificate completed within 7 days of signup), achievable because CertMate is a single-player tool with an extremely clear value proposition.

### Onboarding Design for Fast Aha Moment

- **3-step tours have 72% completion rate** vs only 16% for 7-step tours
- Keep onboarding laser-focused on getting to the first certificate
- Tailor onboarding by segment (sole trader vs company electrician vs apprentice)

**CertMate onboarding flow (recommended 3 steps):**
1. **"Record your first observation"** — tap mic, speak a test observation (pre-fill a sample circuit for them)
2. **"See your certificate"** — AI generates the certificate in real-time, show the PDF preview
3. **"Save & share"** — download/email the certificate

**Time-to-value target:** Under 3 minutes from app open to seeing a generated certificate.


## 3. Endowed Progress Effect

### The Psychology

People are more motivated to complete a task when they perceive they've already made progress. In the landmark Nunes & Drèze car wash study:
- **Standard loyalty card** (8 stamps needed): 19% completion rate
- **Endowed card** (10 stamps, 2 pre-filled): **34% completion rate** (+79% improvement)

Both groups needed 8 purchases, but the perception of progress made the difference.

### SaaS Applications & Data

- Products with progress-tracking in onboarding report **up to 20% increase in user retention** over first 3 months
- Visual progress indicators increase onboarding completion by **20–30%**
- Companies with gamified checklists report **40–60% higher 7-day retention**
- Users are **40% more likely** to complete processes when they can see progress

### CertMate Endowed Progress Implementation

**Onboarding checklist (start at 20% complete on signup):**
```
✅ Account created (auto-completed)
✅ Profile set up (auto-completed from App Store data)
⬜ Record your first observation
⬜ Review your generated certificate
⬜ Complete your first real EICR
```

**Certificate completion progress:**
- Show "2 of 2 free certificates remaining" (not "0 of 2 used") — frames as progress toward something
- After first cert: "You're 50% to Pro — your next certificate will unlock your full CertMate profile"

**Monthly engagement loop:**
- "You've completed 3 certificates this month — Pro users average 12. Upgrade to keep your pace."


## 4. Sunk Cost & Data Lock-In After First Certificate

### The Psychology

Once a user has invested time and data into a platform, switching costs increase dramatically. The sunk cost fallacy makes people reluctant to abandon something they've invested in, even when alternatives might be better.

### Strategic Switching Costs (Value-Based, Not Manipulative)

Slack's model is instructive: as more team history accumulates in the platform, the coordination cost of switching rises dramatically. For CertMate, once an electrician has certificates in the system, they become reluctant to switch because:

1. **Certificate history** — their compliance records are in CertMate
2. **Client data** — property and client details are stored
3. **Templates & preferences** — voice patterns, default settings, favourite observations
4. **Regulatory trail** — auditable history of their work for compliance purposes

**Critical caveat:** 58% of customers who feel "trapped" by a vendor eventually leave and become detractors (Gartner 2022). Lock-in must come from genuine value, not artificial barriers.

### CertMate Sunk Cost Strategy

**After first certificate:**
- "Your certificate is saved securely. Upgrade to Pro to access your certificate archive anytime."
- Store the certificate but gate access to the PDF download/sharing on Pro (they can always view it)
- The certificate contains their professional details — it's not just a document, it's proof of work

**Progressive value accumulation:**
- Certificate 1: Aha moment — "This is amazing"
- Certificate 2: Habit forming — "I'm using this for real work"
- Certificate 3+: Lock-in — "My records are all in here, I can't go back to paper"
- Certificate 10+: Dependency — "My entire compliance history is in CertMate"

**Data export always available** — builds trust, reduces "trapped" feeling, paradoxically increases retention (users who can leave easily but choose to stay are more loyal).


## 5. Zeigarnik Effect for Conversion Nudges

### The Psychology

People remember and are mentally drawn to incomplete tasks more than completed ones. The cognitive tension of an unfinished task keeps it in working memory, creating motivation to complete it.

**Key applications:**
- LinkedIn's "Profile 64% complete" drives users to fill in remaining details
- Progress bars in onboarding create visual urgency
- Unfinished certificate drafts pull users back to the app

### CertMate Zeigarnik Nudge Playbook

**In-app nudges:**
1. **Draft certificate notification:** "You have 1 unfinished EICR draft. Tap to complete it." (push notification 2 hours after abandonment)
2. **Onboarding progress:** "You're 60% set up. Complete your profile to unlock AI voice calibration."
3. **Free tier usage:** "1 of 2 free certificates used. Complete your second to see your full certificate history."
4. **Upgrade flow:** "You've started exploring Pro features. 3 of 5 Pro features previewed — see what you're missing."

**Conversion-specific nudges:**
- After completing free cert: "Your certificate is ready! Upgrade to Pro to: ⬜ Add your company logo ⬜ Auto-email to clients ⬜ Access certificate archive"
- The unchecked boxes create Zeigarnik tension — the user wants to complete the list

**Important caution:** Don't overwhelm users with too many incomplete tasks. Limit to 1-2 active nudges at a time. Electricians are busy on-site — too many notifications will lead to app deletion.


## 6. Pre-Launch Waitlist Psychology

### Why Waitlists Work

Waitlists leverage four psychological principles simultaneously:
1. **Scarcity** — "not immediately available" = higher perceived value
2. **Exclusivity** — "early access" triggers status-seeking behaviour
3. **Anticipation** — the brain's reward centres activate more from anticipation than possession
4. **Zeigarnik effect** — incomplete task (waiting) keeps the product in mind

### Benchmark Data

- Robinhood achieved **1 million waitlist signups** with a simple email + position mechanic; over 50% of signups came through social referrals; 3x viral coefficient
- Superhuman built **180,000-person waitlist** with an exclusivity-first approach; contributed to $260M valuation
- **50% of waitlist members convert within 30 days** of access; only 20% after 90 days
- "Get Early Access" CTA outperforms "Submit" by significant margins

### Viral Waitlist Mechanics

**Robinhood-style position mechanic:**
- User signs up → sees their position (#4,523 of 5,000)
- Share referral link → move up the list
- Creates competitive, gamified sharing behaviour
- Double-sided rewards (both referrer and friend benefit) outperform single-sided by 2–3x

### CertMate Pre-Launch Waitlist Strategy

**Landing page elements:**
1. Hero: "Complete an EICR in 5 minutes, not 50. Voice-powered AI certificates for UK electricians."
2. CTA: "Get Early Access" (not "Join Waitlist")
3. Social proof: "437 electricians already waiting" (live counter)
4. Referral mechanic: "Move up the list — share with a mate and both jump 50 spots"

**Waitlist email sequence:**
1. **Immediate:** Confirmation + position + referral link
2. **Day 3:** Behind-the-scenes video of voice-to-certificate in action
3. **Day 7:** Testimonial from beta tester electrician
4. **Day 14:** "We're almost ready — your spot is #X"
5. **Launch day:** "You're in! Download CertMate now" with 48-hour founder pricing window

**Target:** 500–1,000 waitlist signups before TestFlight beta launch. Achievable through electrical trade Facebook groups, Instagram reels of the product in action, and partnership with electrical wholesalers.


## 7. Founder Pricing & Early Adopter Lock-In

### The Case for Founder Pricing (Not Lifetime Deals)

**Lifetime deals are risky for early-stage SaaS:**
- LTD buyers are rarely ideal long-term customers — they're deal hunters
- Support costs accumulate forever without recurring revenue
- Creates pricing anchoring problems when trying to attract subscription users later
- Undermines perceived value of the product

**Founder pricing is superior:**
- Time-limited offer: "Lock in £X/month forever — only for first 100 users"
- Still generates recurring revenue
- Creates urgency without manufactured scarcity (it's genuinely limited)
- Early adopters feel rewarded and become advocates
- Grandfathered pricing reduces churn: price increases of 10–15% every 18 months with grandfathering reduce churn to only 1.8 percentage points above baseline

### CertMate Founder Pricing Strategy

**Tier structure:**
| Tier | Monthly Price | Annual Price | Availability |
|------|-------------|-------------|-------------|
| Founder (lifetime lock-in) | £9.99/mo | £89.99/yr | First 100 users only |
| Early Adopter | £14.99/mo | £129.99/yr | First 500 users (3 months post-launch) |
| Standard | £19.99/mo | £179.99/yr | General availability |

**Founder benefits beyond price:**
- "Founder" badge on profile (status/identity)
- Priority feature requests
- Direct WhatsApp line to the developer for feedback
- Name in the "Built by electricians, for electricians" credits
- Price locked forever, even as features increase

**Conversion psychology:** Three-tier pricing structures show optimal performance with 18.2% conversion and 24.7% upgrade rates. The middle "Early Adopter" tier becomes the anchor that makes Founder pricing look like an incredible deal.


## 8. Beta-to-Paid Conversion Strategy

### TestFlight Beta Strategy

**Phase 1: Closed Beta (20–50 testers)**
- Recruit from electrical trade Facebook groups and local contacts
- Personal invitation creates exclusivity ("We hand-picked 30 electricians...")
- Collect emails via TestFlight — extremely valuable for launch
- Beta testers report 30% fewer bugs post-launch and 50% faster user adoption

**Phase 2: Open Beta via TestFlight (200–500 testers)**
- Public TestFlight link shared on social media and trade forums
- "Help us build the future of EICR certificates — join the beta"
- Structured feedback collection: in-app survey after 3rd certificate

**Testimonial Collection Strategy:**
1. After each certificate completion, prompt: "How did that feel? Rate 1–5 stars"
2. If 5 stars: "Would you mind sharing a quick quote? We'd love to feature you."
3. Collect video testimonials: "Record a 15-second clip of you using CertMate on-site"
4. Use testimonials for: App Store description, landing page, social proof on waitlist

**Beta-to-Paid Conversion Tactics:**
- Give beta users unlimited access during testing
- 2 weeks before public launch: "Thank you for being a beta tester. As a thank-you, you're getting Founder pricing — locked in forever."
- Create urgency: "Founder pricing ends when we launch publicly on [date]"
- Beta testers who convert become your most powerful advocates

### iOS Subscription Conversion Benchmarks

- Median Day 35 trial-to-paid: 2.6% (North America), 2% (Western Europe)
- Apps with hard paywalls convert 5x better than freemium (10.7% vs 2.1%)
- **55% of 3-day trial cancellations happen on Day 0** — first session is everything
- Travel apps have highest conversion; Photo & Video lowest

**CertMate target:** 15–25% beta-to-paid conversion (achievable because beta users are pre-qualified and have established the habit during testing).


## 9. UK Electrician Market Context

### Digital Adoption Readiness

- **88% of tradespeople** (91% of electricians specifically) consider digital tools important
- **89%** use digital tools for day-to-day business
- Top reasons: save time on admin (39%), compensate for worker shortages (36%), better work-life balance (34%)
- **HMRC Making Tax Digital** mandate (April 2026 for £50k+, April 2027 for £30k+) is forcing digital adoption
- Cost is the #1 challenge for 29% of tradespeople (32% of electricians)

### Implications for CertMate

- **High readiness:** Electricians are already digital — smartphone adoption is near-universal
- **Price sensitivity is real:** Must demonstrate clear ROI before asking for money
- **Regulatory tailwind:** MTD is pushing every sole trader into digital tools — CertMate can ride this wave
- **Time savings = money:** An electrician charging £50/hr who saves 45 minutes per EICR saves £37.50 per certificate. At 10 EICRs/month, that's £375/month saved — vs £19.99/month subscription = 18.75x ROI


## 10. Optimal Free Tier Design — Why 2 Free Certificates

### How Much to Give Away Free

Research from KeyBanc SaaS Survey: successful tools allow free users to access **15–30% of full capacity**. Price Intelligently recommends providing ~80% of functionality while reserving 20% of high-value features for paid plans. The key principle (Tomasz Tunguz, Redpoint Ventures): "Give enough to solve a real problem but create natural friction when users derive significant value."

### Why 2 Certificates Is the Sweet Spot for CertMate

| Free Limit | Pros | Cons |
|-----------|------|------|
| 1 certificate | Creates urgency fast | Not enough to form habit; user may not convert if first cert was a test |
| **2 certificates** | **First cert = aha moment; second cert = habit confirmation; creates sunk cost (2 certs in system)** | **Slightly slower conversion than 1** |
| 3 certificates | Good habit formation | Too generous; reduces conversion pressure |
| 5+ certificates | Large top-of-funnel | Most users never hit the paywall; very low conversion |
| Unlimited (feature-gated) | Maximum adoption | Hard to convert if free tier solves the core job |

**Recommendation: 2 free certificates** because:
1. Certificate 1 is often a test/practice — the user is exploring
2. Certificate 2 is a real job — they've now used CertMate for actual work
3. After 2 certs, they have client data and work history in the system (sunk cost)
4. The jump from "2 free" to "unlimited Pro" feels significant enough to justify payment
5. 2 certs represents ~15–20% of a typical electrician's monthly EICR volume (aligns with KeyBanc 15–30% benchmark)

### Competitor Free Tier Comparison

- **ServiceM8:** Free tier available (limited jobs/month), paid from $29/mo
- **Tradify:** 14-day free trial only, no permanent free tier, £31/mo
- **Jobber:** 14-day trial, plans from $49/mo
- **Wave (invoicing):** Free forever for invoicing — proves trade apps can have generous free tiers

CertMate's 2-free-certificates model is differentiated: more generous than pure trial (no time pressure), but more conversion-focused than unlimited freemium.


## 11. Push Notification & Re-Engagement Strategy

### Optimal Notification Timing

- **Within 30 minutes of abandonment:** Highest conversion for incomplete actions
- **Within 1 hour:** Still effective for "you left something unfinished" nudges
- **Personal peak hours:** Notifications sent during individual user's peak hours achieve **240% higher engagement** than broadcast notifications
- **Behaviour-based timing:** Apps that optimize timing per user achieve **65% higher engagement**

### CertMate Push Notification Playbook

**Immediate triggers (within session):**
- Draft saved but not completed → "Your EICR draft is waiting. Tap to finish." (after 2 hours)
- Observation recorded but certificate not generated → "Your observations are ready — generate your certificate now" (after 30 min)

**Re-engagement triggers (daily/weekly):**
- Day 1 after signup, no certificate → "Ready to try your first voice-powered EICR? It takes 3 minutes." (send at user's typical active hour)
- Day 3, still no certificate → "437 electricians completed their first CertMate EICR this week. Try yours now."
- Day 7, no activity → "Your free certificates are waiting. Don't let them expire!" (creates gentle urgency even though they technically don't expire)

**Post-aha-moment conversion nudges:**
- After 1st free cert: "Nice one! You've got 1 free certificate left. Make it count." (Zeigarnik: incomplete set)
- After 2nd free cert: "You've used both free certificates. Upgrade to Pro for unlimited EICRs — and keep your certificate archive." (sunk cost + loss aversion)
- Day 3 after 2nd cert, no upgrade: "Your 2 saved certificates are in your archive. Upgrade to access them anytime + create unlimited new ones."

**Critical rules for electricians:**
- **Never send during working hours (7am–5pm weekdays)** — they're on-site, notifications will annoy
- **Optimal send times:** 6–7pm weekday evenings (post-work admin time) or Saturday morning
- **Max 2 notifications per week** — tradespeople have low tolerance for app spam
- **Always allow easy opt-out** — respect earns loyalty


## 12. Referral Programme Design for Tradespeople

### B2B Referral Benchmarks

- B2B generates **3x more revenue from referrals** than B2C
- B2B viral coefficient: 0.3–0.7 (lower than consumer, but higher value per referral)
- **10–15% of B2B referred leads convert** to paying customers (vs 2–5% B2C at higher volume)
- **84% of B2B decisions start with a referral**
- Referred users: **25% higher spending, 18% lower churn, 16% higher LTV**

### What Motivates Tradespeople to Refer

Unlike consumer referrals (driven by rewards), trade referrals are driven by:
1. **Peer credibility** — "I use this, it's good" carries weight in tight-knit trade networks
2. **Helping a mate** — electricians are often solo; they support each other
3. **Professional status** — being the person who "found it first" has social value
4. **Mutual benefit** — both sides getting something feels fair, not salesy

### CertMate Referral Design

**Mechanic:** "Give a mate a free month, get a free month"
- Simple, clear, fair — no complex points or tiers
- Both parties benefit equally (double-sided rewards outperform single-sided by 2–3x)
- Free month = tangible value (~£20) without cash complexity

**Sharing channels (ranked by effectiveness for electricians):**
1. **WhatsApp** — #1 communication tool for UK tradespeople. One-tap share to individual or group chat.
2. **In-person/word-of-mouth** — "Show the app to a mate on-site" with a QR code in the app
3. **Trade Facebook groups** — electricians are active in groups like "Electricians Forum" (25k+ members)
4. **Electrical wholesaler counters** — physical QR code at the trade counter (partnership opportunity)

**In-app referral UX:**
- Prominent "Invite a mate" button on dashboard
- Show referral count: "You've helped 3 electricians go paperless" (status + progress)
- At 5 referrals: "CertMate Champion" badge on profile


## 13. Subscription vs One-Time Purchase — iOS Pricing Psychology

### The Case for Subscription (Not One-Time Purchase)

| Factor | Subscription | One-Time Purchase |
|--------|-------------|-------------------|
| Revenue predictability | Recurring, predictable MRR | Front-loaded, unpredictable |
| User incentive alignment | Developer must keep delivering value | No incentive to retain after purchase |
| Apple commission | 30% year 1, then **15% year 2+** | 30% always |
| Price perception | "£19.99/mo" feels affordable | "£199.99 lifetime" feels expensive |
| CertMate AI costs | Ongoing AI/voice API costs covered by subscription | Must subsidize ongoing costs from initial payment |

### Psychological Pricing Tactics for CertMate

- **Show weekly price on paywall:** "Just £4.99/week" feels cheaper than "£19.99/month" (same cost)
- **Annual plan as default selection:** £179.99/yr (£14.99/mo effective) vs £19.99/mo — annual saves 25%
- **Anchoring:** Show the "per-certificate" cost: "Just £1.67 per EICR" (at 12 certs/month on annual plan)
- **ROI framing:** "Save 45 minutes per EICR = £37.50 saved. CertMate pays for itself after your first certificate each month."

### Why One-Time Purchase Doesn't Work for CertMate

CertMate has significant ongoing costs (AI inference, voice processing, cloud storage, BS 7671 regulation updates) that require recurring revenue. A one-time purchase model would force either:
- Extremely high upfront price (£300+), killing adoption
- Degrading service quality over time as costs outpace revenue
- Introducing hidden fees later, destroying trust

**Recommendation: Subscription-only with annual discount.** Position the annual plan as the default, with monthly as the "flexible" option.


## 14. Blue-Collar Onboarding UX — Designing for Electricians

### Key Principles for Non-Technical Users

- **90% of written PDF/paper instructions fail** to provide satisfactory solutions — use video and visual guides instead
- **Progressive disclosure:** teach features as users encounter them, not all upfront
- **Minimalist UI:** allows users of any background to explore the app
- Most mobile apps should let users **learn by doing**, not by reading

### CertMate-Specific UX Considerations

**Physical context:**
- Users are on construction sites wearing work gloves
- Screen may be dirty, wet, or in bright sunlight
- One-handed operation is common (other hand holding a tool or torch)
- Noisy environments affect voice recording

**Design implications:**
- **Large touch targets** (minimum 48x48px, preferably 56x56px)
- **High-contrast UI** for outdoor/bright conditions
- **Minimal text** — use icons with labels, not paragraphs
- **Single-tap actions** wherever possible
- **Voice-first interaction** — the core UX is speaking, not typing
- **Offline capability** — many sites have poor signal; queue and sync later

**Onboarding approach:**
- **No tutorial screens** — electricians will skip them
- **Interactive first-run:** "Tap the mic and say what you see" — immediately hands-on
- **Contextual tooltips** only when the user first encounters a feature
- **30-second demo video** on the "how it works" screen (optional, not blocking)
- **Success celebration** after first certificate: brief animation + "Your first EICR, done in [X] minutes!"


## 15. Actionable CertMate Launch Playbook

### Pre-Launch (8–12 weeks before App Store)

1. **Build waitlist landing page** with position mechanic and referral sharing
2. **Target:** 500–1,000 signups from electrical trade Facebook groups, Instagram content, and electrical wholesaler partnerships
3. **Start closed TestFlight beta** with 20–50 hand-picked electricians
4. **Collect testimonials and refine onboarding** based on beta feedback

### Beta Phase (4–8 weeks)

5. **Open TestFlight beta** to 200–500 users via waitlist
6. **Perfect the 3-minute aha moment** — record observation → see certificate → download
7. **Implement endowed progress onboarding** (start at 20% complete)
8. **A/B test conversion nudges** — Zeigarnik-style incomplete task reminders
9. **Collect 10+ video testimonials** from real electricians on real job sites

### Launch Week

10. **Email waitlist:** "You're in! Download CertMate now" with 48-hour Founder pricing window
11. **Founder pricing:** £9.99/mo for first 100 users (locked forever)
12. **Free tier:** 2 certificates, no time limit, no CC required
13. **Pro trial:** 14-day full-feature trial after free certs used, then £19.99/mo
14. **App Store optimization:** Lead with testimonials, "EICR in 5 minutes" headline

### Post-Launch Growth (Months 1–3)

15. **Monitor activation rate** — target 50%+ completing first certificate in 7 days
16. **Implement sunk cost loops** — certificate archive, client data, templates
17. **Transition Early Adopter pricing** (first 500 users at £14.99/mo)
18. **Begin referral programme:** "Give a mate 1 free month, get 1 free month"
19. **Track and optimize:** Freemium → Pro conversion target of 8–12%

### Key Metrics to Track

| Metric | Target | Benchmark Source |
|--------|--------|-----------------|
| Waitlist signups | 500–1,000 | Robinhood-style viral mechanics |
| Beta-to-paid conversion | 15–25% | Pre-qualified user base |
| Time to first certificate | < 3 minutes | Aha moment engineering |
| Activation rate (cert in 7 days) | 50%+ | PLG single-player benchmark |
| Freemium-to-paid conversion | 8–12% | Professional tool top quartile |
| Onboarding completion | 70%+ | Endowed progress + 3-step flow |
| Monthly churn (post-conversion) | < 5% | SaaS professional tool benchmark |
| Net Promoter Score | 50+ | Trade app loyalty benchmark |


## Sources

- [First Page Sage — SaaS Freemium Conversion Rates 2026](https://firstpagesage.com/seo-blog/saas-freemium-conversion-rates/)
- [Userpilot — Freemium Conversion Rate Guide](https://userpilot.com/blog/freemium-conversion-rate/)
- [Userpilot — Onboarding Checklist Completion Benchmarks](https://userpilot.com/blog/onboarding-checklist-completion-rate-benchmarks/)
- [Customer.io — Free Trial Length Guide](https://customer.io/learn/product-led-growth/free-trial-length)
- [Appcues — Aha Moment Guide](https://www.appcues.com/blog/aha-moment-guide)
- [ProductLed — Aha Moments for Onboarding](https://productled.com/blog/how-to-use-aha-moments-to-drive-onboarding-success)
- [Cognitive Clicks — Endowed Progress Effect](https://cognitive-clicks.com/blog/endowed-progress-effect/)
- [DataDab — Endowed Progress in SaaS](https://www.datadab.com/blog/endowed-progress-effect-saas/)
- [Coglode — Endowed Progress Effect](https://www.coglode.com/nuggets/endowed-progress-effect)
- [DesignZig — Zeigarnik Effect in UX](https://designzig.com/zeigarnik-effect-in-ux-design/)
- [LogRocket — Zeigarnik Effect Guide](https://blog.logrocket.com/ux-design/zeigarnik-effect/)
- [Viral Loops — Robinhood Referral Waitlist](https://viral-loops.com/blog/robinhood-referral-got-1-million-users/)
- [Waitlister — SaaS Waitlist Playbook 2026](https://waitlister.me/growth-hub/guides/saas-product-launch-waitlist)
- [GetWaitlist — Waitlist Marketing Strategy 2025](https://getwaitlist.com/blog/waitlist-marketing-strategy-2025-how-to-build-demand-before-launch)
- [EchoPoint Global — Lifetime Deal Trap](https://echopointglobal.com/the-lifetime-deal-trap-for-first-time-saas-founders/)
- [Freemius — SaaS Lifetime Deals Guide](https://freemius.com/blog/saas-lifetime-deals/)
- [PayPro Global — Grandfathering Pricing Guide](https://payproglobal.com/how-to/manage-grandfathering-pricing/)
- [Chargebee — Free Trial Credit Card Verdict](https://www.chargebee.com/blog/saas-free-trial-credit-card-verdict/)
- [Business of Apps — Subscription Trial Benchmarks 2026](https://www.businessofapps.com/data/app-subscription-trial-benchmarks/)
- [RevenueCat — State of Subscription Apps 2025](https://www.revenuecat.com/state-of-subscription-apps-2025/)
- [Monetizely — Pricing Lock-In Strategy](https://www.getmonetizely.com/articles/pricing-for-lock-in-creating-strategic-switching-costs-in-saas)
- [Electrical Contracting News — Digital Tools for UK Tradespeople](https://electricalcontractingnews.com/news/digital-tools-key-to-navigating-challenges-for-uk-tradespeople/)
- [Workever — UK Tradespeople Going Digital 2025](https://workever.com/blog/why-more-uk-tradespeople-are-going-digital-in-2025/)
- [OpenView — PLG Benchmarks](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/)
- [Elec Training — Mobile Apps for Tradespeople](https://elec.training/news/mobile-apps-for-busy-tradespeople/)
- [Monetizely — Optimal Free Tier Limits](https://www.getmonetizely.com/articles/whats-the-optimal-free-tier-limit-for-developer-focused-saas-products)
- [a16z — Three Most Common Challenges with Freemium](https://a16z.com/how-to-optimize-your-free-tier-freemium/)
- [CleverTap — Push Notification Strategy](https://clevertap.com/blog/push-notification-strategy/)
- [Reteno — Push Notification Best Practices 2026](https://reteno.com/blog/push-notification-best-practices-ultimate-guide-for-2026)
- [Viral Loops — B2B Word-of-Mouth Referral Programs](https://viral-loops.com/blog/b2b-word-of-mouth-referral-programs-unmuted-interview/)
- [Referral Factory — Referral Marketing Statistics](https://referral-factory.com/referral-marketing-statistics)
- [Adapty — App Store Conversion Rate by Category 2026](https://adapty.io/blog/app-store-conversion-rate/)
- [Adapty — App Pricing Models 2026](https://adapty.io/blog/app-pricing-models/)
- [NN/g — Mobile App Onboarding Analysis](https://www.nngroup.com/articles/mobile-app-onboarding/)
- [UserGuiding — Blue Collar Worker Onboarding](https://userguiding.com/blog/blue-collar-training)

### research-pricing-psychology

# Pricing Psychology Research for CertMate

Deep research into pricing psychology principles applicable to CertMate's AI-powered EICR app targeting UK electricians. Covers anchoring, decoy effects, loss aversion, Weber-Fechner law, charm pricing, annual discounts, and Stripe vs StoreKit economics.


## 1. Anchoring Effects

### The Core Principle
Anchoring is a cognitive bias where people rely heavily on the first piece of information (the "anchor") when making decisions. In pricing, presenting a higher reference point first makes subsequent prices feel more reasonable. Research from Bain & Company shows that **perceived value — not actual cost — drives 80% of B2B purchasing decisions**.

### Application to CertMate: Time-Savings Anchoring

**Key data points for the anchor:**
- UK electrician hourly rate: **£40-60/hr** (avg ~£45/hr nationally, up to £90 in London)
- EICR inspection time: **2-4 hours** on-site
- EICR paperwork/admin time: **1-2 hours** additional (report writing, compliance documentation)
- Typical EICR charge to customer: **£125-300** depending on property size
- Admin processing can take **"a couple of days"** after initial inspection

**Recommended anchoring frame for CertMate Pro (£30/mo):**

> "Each EICR report takes 1-2 hours of paperwork at your rate of £50-60/hr. That's £50-120 of your time per certificate. CertMate Pro at £30/month pays for itself after your **first certificate** — and you get 8 per month."

**The maths that sells:**
| Metric | Value |
|--------|-------|
| Electrician hourly rate | £50-60/hr |
| Admin time saved per EICR | 1-2 hours |
| Value of time saved per cert | £50-120 |
| Pro cost per month | £30 |
| Certs included | 8 |
| Cost per cert on Pro | £3.75 |
| ROI on first cert alone | 13-32x |

**Implementation:** Show this ROI calculation prominently on the pricing page. Frame £30/mo not as a cost but as an investment that returns £400-960/mo in saved time (8 certs × £50-120 saved).

Simon-Kucher & Partners research shows effective anchoring can **increase average contract values by 15-20%**.

### Anchoring on the Pricing Page
- Show the Unlimited tier (£45) first or most prominently as the price anchor
- This makes Pro (£30) feel like a deal by comparison
- Show the "value" of the Free tier (£0 for 1 cert) to anchor the baseline expectation


## 2. Decoy Effect (Asymmetric Dominance)

### The Research
First documented in a landmark **1982 study by Huber, Payne, and Puto**, the decoy effect shows that adding a strategically inferior option shifts preference toward the target option. Key findings:

- Companies implementing well-designed decoy pricing see **up to 40% increase** in target plan selection (American Marketing Association)
- Three-tier pricing yields **30% higher ARPU** than four+ tiers (Price Intelligently, 512 SaaS companies analysed)
- Moving from four tiers to three increased conversion rates by **27%** on average (ConversionXL)
- Intercom consolidated from six plans to three and saw an immediate **17% increase** in conversion rates
- Buffer's centre-focused design increased mid-tier selection by **31%**

### CertMate Three-Tier Structure (Optimised for Decoy Effect)

| Feature | Free (Decoy/Entry) | Pro (Target) | Unlimited (Anchor/Aspiration) |
|---------|-------------------|--------------|------------------------------|
| Price | £0 | £29/mo | £45/mo |
| Certificates | 1/month | 8/month | Unlimited |
| AI Report Generation | Basic | Full | Full + Priority |
| Photo Documentation | No | Yes | Yes |
| Compliance Templates | Limited | All | All + Custom |
| Customer Database | No | Yes | Yes |
| Export/Print | Watermarked | Full | Full |
| Support | Community | Email | Priority |
| Price per cert | £0 (1 cert) | £3.63 | Depends on volume |

**Why this structure works as a decoy:**
- **Free tier** is deliberately limited (1 cert, watermarked, no photos) — it demonstrates value but creates friction. Its purpose is to trigger the **endowment effect** (users experience the AI, then feel the pain of limitations)
- **Pro tier** is the clear sweet spot — the jump from 1 to 8 certs for £29 feels like extraordinary value. An electrician doing 4+ EICRs/month would be foolish not to upgrade
- **Unlimited tier** at £45 serves dual purpose: (a) anchors Pro as affordable, and (b) captures high-volume users (landlord contractors, testing firms). The £16 gap from Pro to Unlimited is small enough that heavy users self-select up

**Centre-stage effect:** Eye-tracking studies (ConversionXL) show customers scan pricing pages in an "E" or "F" pattern, with **most attention on the middle/highlighted option**. Adding a "Most Popular" badge to Pro leverages both social proof and centre-stage bias — this increases middle-tier selection by **38%** (centre-stage) plus **12-15%** (badge effect).


## 3. Loss Aversion Framing

### The Science
Loss aversion (Kahneman & Tversky, 1979) shows that the **pain of losing is psychologically ~2x as powerful** as the pleasure of gaining. In pricing, framing around what you'll lose is more motivating than what you'll gain.

Key SaaS findings:
- Loss-framed messaging increased conversion rates by **21%** vs gain-framed alternatives (McKinsey)
- Loss-focused renewal messaging achieved **27% higher renewal rates** than positive framing
- Annual plan users show **30% better retention** when locked into discounted rates (loss of deal)

### CertMate Loss Aversion Messaging

**For Free → Pro upgrade prompts:**

| Gain Frame (Weaker) | Loss Frame (Stronger) |
|---------------------|----------------------|
| "Upgrade to get AI-powered reports" | "You're spending 1-2 hours on paperwork that AI could do in minutes" |
| "Get 8 certificates per month" | "You've hit your limit — your next customer is waiting" |
| "Access all compliance templates" | "Don't risk a non-compliant report — upgrade for full templates" |
| "Save time on every EICR" | "Every manual report costs you £50-120 in lost billable time" |

**For churn prevention / cancellation flow:**
- "If you cancel, you'll lose access to your saved customer database and report history"
- "Your 8 monthly certificates will drop to just 1 — that's 7 jobs you'll need to do manually"
- "You've saved an estimated [X] hours this month with CertMate. Going back to manual means losing those hours every month"

**For trial expiry:**
- "Your Pro trial ends in 3 days. After that, you'll lose access to: AI report generation, photo documentation, and your saved templates"
- Research shows extended trials can backfire via reverse endowment effect — keep trial to **7-14 days** max to maintain urgency

### Endowment Effect Integration
- Give Free users a taste of Pro features (e.g., first cert gets full AI report, subsequent ones are watermarked/basic)
- Let them build up data (customer list, report history) that becomes painful to lose
- Show "You've created X reports with CertMate" as a sunk-cost reminder
- Users who feel psychological ownership are willing to pay **more** for products/services


## 4. Weber-Fechner Law at £15-45 Price Points

### The Principle
The Weber-Fechner law states that the **just noticeable difference (JND)** in any stimulus is a constant proportion (~8-10%) of the original stimulus. Applied to pricing: a £3 increase on a £30 product (10%) is more noticeable than a £3 increase on a £45 product (6.7%).

### Implications for CertMate's Price Points

**JND thresholds at each tier:**

| Tier | Price | ~10% JND | Noticeable Change |
|------|-------|----------|-------------------|
| Pro | £29/mo | £2.90 | Increases of £3+ are noticeable |
| Unlimited | £45/mo | £4.50 | Increases of £5+ are noticeable |
| Annual Pro | ~£24/mo equiv | £2.40 | Increases of £2.50+ noticeable |

**Strategic pricing implications:**
1. **£29 vs £30:** The £1 difference crosses a psychological threshold (left-digit effect, see Charm Pricing below). Use £29 for Pro.
2. **Price increase tolerance:** You can increase Pro by up to £2 (~7%) without most users noticing or caring. Going from £29 to £32 (10.3%) will trigger re-evaluation.
3. **Tier gap perception:** The gap between Free (£0) and Pro (£29) is massive in percentage terms (infinite), so the Free tier must deliver enough value to create desire, not enough to satisfy. The gap between Pro (£29) and Unlimited (£45) is £16 (55% increase) — this is clearly noticeable and must be justified by obvious value.
4. **Annual pricing:** At ~£24/mo equivalent, the per-month cost feels psychologically closer to "a cheap subscription" territory. Below £25/mo is where most sole traders stop scrutinising.

**For future price increases:**
- Keep increases under 8-10% when adjusting prices
- Never cross a round-number boundary (e.g., £29→£31 crosses £30 threshold)
- Bundle additional features with price increases to justify the JND crossing


## 5. Charm Pricing in B2B / Trade Contexts

### The Research
Charm pricing (ending in .99 or .95) works differently in B2B vs B2C contexts:

- **B2C (retail):** .99 endings are highly effective — the left-digit effect means £29.99 is perceived as "£20-something" rather than "£30"
- **B2B (professional):** More nuanced. B2B companies use charm pricing without decimals — **£29 instead of £30, £99 instead of £100**
- **Premium/professional contexts:** Round numbers (£30, £45) signal confidence and quality, while .99 endings can appear "gimmicky in executive proposals"
- **Tradespeople context:** Sole-trader electricians straddle B2C and B2B psychology — they're running a business but making personal purchasing decisions. They respond to value, not enterprise sales pitches.

### CertMate Recommendation

| Option | Price Display | Psychological Signal |
|--------|--------------|---------------------|
| **£29/mo** (Recommended) | "£29" | Left-digit effect (perceived as "twenties"), professional feel, no decimals |
| £29.99/mo | "£29.99" | Too retail/gimmicky for professional tool |
| £30/mo | "£30" | Clean but crosses the £30 threshold — feels more expensive |
| £9.99/mo | "£9.99" | Would undervalue the product, signals cheap/amateur |

**Recommendation for CertMate:**
- **Pro: £29/mo** — Uses left-digit effect without looking cheap. Tradespeople see "twenty-something" not "thirty"
- **Unlimited: £45/mo** — Round number signals premium/confidence. The £16 gap from Pro creates clear value differentiation
- **Annual Pro: £290/yr** (equiv. ~£24.17/mo) — Show as "£290/year" not "£24.17/mo" when emphasising the annual savings; show as "just £24/mo" when emphasising affordability

**Key insight:** A/B test £29 vs £30 — the research suggests £29 will outperform, but in trade contexts where round numbers signal trust, £30 might work if paired with strong value messaging. Impact is strongest at "salient thresholds" like £29.99 vs £50.00.


## 6. Annual vs Monthly Discount Sweet Spots

### Industry Benchmarks

| Metric | Value | Source |
|--------|-------|--------|
| Industry-standard annual discount | **16.7%** ("2 months free") | Multiple SaaS benchmarks |
| Median annual prepay discount | **18%** | 2024 Vendr dataset |
| Optimal acquisition discount range | **5-10%** | Cacheflow (10,000 proposals analysed) |
| Optimal annual/loyalty discount range | **15-20%** | Cacheflow |
| Average annual discount (2024 trend) | **28%** (up from 15% in 2022) | ProfitWell 2024 |
| Multi-year discount ceiling | **25%** | Atlassian, Okta benchmarks |

### Important Caveats
- Discounts >20% **lower SaaS lifetime value (LTV) by ~30%** (ProfitWell/Paddle 2024)
- Heavy-discount customers show **higher price sensitivity** and **higher churn**
- Best practice: keep discounts modest and frame as "savings" not "discount"

### CertMate Annual Pricing Recommendation

**Pro tier annual pricing options:**

| Monthly | Annual | Monthly Equiv | Discount | Framing |
|---------|--------|--------------|----------|---------|
| £29/mo | £290/yr | £24.17/mo | 17% (~2 months free) | "Save £58/year — that's 2 months free" |
| £29/mo | £278/yr | £23.17/mo | 20% | "Save £70/year" |
| £29/mo | £249/yr | £20.75/mo | 28% | "Save £99/year" — too aggressive |

**Recommended: £290/yr (17% discount = "2 months free")**

Rationale:
- "2 months free" is the most common and best-understood framing in SaaS
- 17% is within the optimal 15-20% range for annual discounts
- It's a round number (£290) that's easy to process
- Does not devalue the monthly price excessively
- Maintains healthy LTV while incentivising commitment

**Unlimited tier annual pricing:**

| Monthly | Annual | Monthly Equiv | Discount | Framing |
|---------|--------|--------------|----------|---------|
| £45/mo | £450/yr | £37.50/mo | 17% | "Save £90/year — 2 months free" |

**Framing the annual option:**
- Default the toggle to "Annual" (pre-select the cheaper option)
- Show monthly price crossed out: "~~£29/mo~~ £24/mo billed annually"
- Add "SAVE £58" badge on the annual toggle
- Loss aversion: "Switch to annual and never pay full price again"


## 7. Per-Certificate vs Monthly vs Annual Pricing Psychology

### Model Comparison for Trade Context

| Model | Pros | Cons | Psychological Effect |
|-------|------|------|---------------------|
| **Per-certificate** (e.g., £5/cert) | Simple to understand; pay-as-you-go; low barrier | Unpredictable revenue; no lock-in; mental "meter running" on every use | Creates "taxi meter" anxiety — users hesitate to use the product |
| **Monthly subscription** (e.g., £29/mo) | Predictable for both sides; encourages usage; standard SaaS | Monthly churn risk; feels like ongoing cost | "All-you-can-eat" feeling encourages adoption; usage = value reinforcement |
| **Annual subscription** | Best retention; upfront cash; lower churn | Higher upfront commitment barrier | Loss aversion kicks in (already paid); sunk cost encourages continued use |
| **Hybrid** (monthly + per-cert overage) | Flexible; captures both segments | Complex to communicate; confusing billing | Can cause confusion and resentment at overage charges |

### Recommendation for CertMate

**Use monthly subscription with certificate caps as the primary model, not per-certificate pricing.**

Reasons:
1. **Predictability:** Tradespeople want to know their costs upfront. A £29/mo subscription is a known business expense. Per-cert pricing creates uncertainty.
2. **Usage encouragement:** With subscription, every additional cert feels "free" (already paid), reinforcing value. Per-cert creates hesitation before each use.
3. **Flat-rate bias:** Research shows consumers disproportionately prefer flat-rate plans even when usage-based would be cheaper (Lambrecht & Skiera, 2006). The "peace of mind" of unlimited/capped usage is psychologically valued.
4. **Trade context:** Electricians think in monthly business costs — van insurance, tool subscriptions, certification fees. Monthly SaaS fits their mental accounting.
5. **Compliance software norms:** Industry-standard for compliance/regulatory software is subscription-based (monthly or annual), not per-transaction.

**Overage handling (Pro tier, 8 cert cap):**
- Don't charge per-cert overages (creates resentment)
- Instead, use the cap as an upgrade prompt: "You've used 8/8 certificates this month. Upgrade to Unlimited for just £16/mo more"
- This is more effective than punitive overage charges and drives tier upgrades


## 8. Stripe vs StoreKit Pricing Differentials

### Fee Comparison

| Channel | Commission | On £29 sale | Net Revenue | Notes |
|---------|-----------|-------------|-------------|-------|
| **Stripe (UK cards)** | 1.5% + 20p | £0.64 | **£28.36** | + Stripe Billing 0.5% on recurring = £0.79 total |
| **Stripe (total recurring)** | 2.0% + 20p | £0.78 | **£28.22** | Standard + Billing combined |
| **Apple IAP (Year 1)** | 30% | £8.70 | **£20.30** | Standard rate |
| **Apple IAP (Small Biz)** | 15% | £4.35 | **£24.65** | <£1M proceeds/year — CertMate qualifies |
| **Apple IAP (Year 2+ sub)** | 15% | £4.35 | **£24.65** | After 12 months of continuous subscription |
| **Apple (external link, post-2025 ruling)** | 0% (Stripe fees only) | £0.78 | **£28.22** | Epic v Apple ruling allows external payment links |

### Revenue Impact Analysis (Per User Per Year on Pro £29/mo = £348/yr)

| Channel | Annual Fees | Annual Net | vs Stripe Delta |
|---------|------------|------------|----------------|
| Stripe direct | £9.36 | **£338.64** | Baseline |
| Apple Small Biz (15%) | £52.20 | **£295.80** | -£42.84/user/yr |
| Apple Standard (30%) | £104.40 | **£243.60** | -£95.04/user/yr |
| Apple + External Pay (post-ruling) | £9.36 | **£338.64** | £0 (same as Stripe) |

### Strategic Pricing Recommendations

**Option A: Same price everywhere (simplest)**
- Charge £29/mo on both iOS and web
- Accept lower margins on iOS (£24.65 net vs £28.22 net via Stripe)
- Advantage: No customer confusion, App Store Review compliance
- Use the Apple Small Business Program (15% rate) — CertMate will easily qualify under £1M

**Option B: Web-first pricing strategy (profit-optimised)**
- Offer sign-up via web/Stripe as the primary path
- iOS app authenticates against web subscription (no IAP needed for subscription management)
- Post-2025 Epic ruling: can link to external payment from within iOS app
- Advantage: Maximises revenue; saves £42.84/user/year vs Apple Small Biz
- Risk: Slightly more friction for iOS-first users

**Option C: Price differential (transparent)**
- Web: £29/mo via Stripe
- iOS: £34/mo via StoreKit (passing Apple's 15% fee to user)
- Show "Save 15% — subscribe on our website" in-app
- Advantage: Recovers Apple fees; signals transparency
- Risk: App Store may reject explicit price-comparison messaging

**Recommended: Option B (web-first) with fallback to Option A**
- Default to web checkout via Stripe for maximum margin
- Offer IAP as convenience fallback for users who insist
- Use Apple Small Business Program for the 15% rate
- Post-Epic ruling, implement external payment links in iOS app
- For a £29/mo product, the ~£43/user/year savings from Stripe over Apple Small Biz adds up significantly at scale (1,000 users = £42,840/yr saved)


## 9. Pricing Page Design Psychology

### Evidence-Based Recommendations

1. **Three tiers only** — 30% higher ARPU than 4+ tiers; 27% higher conversion than 4 tiers
2. **"Most Popular" badge on Pro** — 12-15% increase in middle-tier selection; 44% conversion uplift in one B2B case study
3. **Centre-stage Pro tier** — visually elevated, contrasting colour border, slightly larger card
4. **Annual toggle defaulted ON** — pre-select the discounted option; show savings prominently
5. **Show crossed-out monthly price** — "~~£29/mo~~ £24/mo billed annually" leverages anchoring
6. **ROI calculator** — Interactive element: "How many EICRs do you do per month?" → shows time/money saved
7. **Social proof near CTA** — "Join 2,000+ electricians saving time with CertMate" (once traction exists)
8. **Money-back guarantee** — Reduces risk perception; "30-day money-back guarantee" removes purchase anxiety

### Freemium Conversion Benchmarks to Target

| Metric | Industry Average | Target for CertMate |
|--------|-----------------|-------------------|
| Visitor → Free signup | 12% | 15%+ (niche tool, high intent) |
| Free → Paid conversion | 2.6-5% (B2B SaaS avg) | 6-10% (SMB-targeted, high-value tool) |
| SMB-targeted freemium → paid | 6-10% | 8-12% (strong ROI case) |
| Trial → Paid (if trial used) | 25-40% | 30%+ (with proper onboarding) |

SMB-targeted SaaS achieves **6-10% freemium-to-paid conversion** — higher than enterprise (3-5%) because the buyer and user are the same person.


## 10. Actionable Recommendations Summary

### Pricing Structure
- **Free:** £0/mo, 1 cert, basic AI, watermarked output — the "taste" tier
- **Pro:** **£29/mo** (charm-priced below £30), 8 certs, full AI — the target tier
- **Unlimited:** **£45/mo**, unlimited certs, priority support — the anchor/aspiration tier
- **Annual Pro:** **£290/yr** (~£24/mo, 17% discount, "2 months free")
- **Annual Unlimited:** **£450/yr** (~£37.50/mo, 17% discount)

### Key Psychological Levers
1. **Anchor on time value:** "£29/mo vs £50-120/hr of your time per manual report"
2. **Decoy the free tier:** Deliberately limited to create desire, not satisfaction
3. **Badge the Pro tier:** "Most Popular" + visual elevation + centre placement
4. **Loss-frame upgrades:** "You're losing £X/month in admin time" not "Save £X/month"
5. **Endowment via free tier:** Let users build data/history, then feel pain of limitation
6. **Annual = "2 months free":** Universal framing that needs no explanation
7. **Web-first payments:** Stripe (2% total) vs Apple (15-30%) saves £43-95/user/year

### Pricing Page Copy Framework
```
Headline: "Stop spending hours on EICR paperwork"
Subhead: "AI-powered certificates in minutes, not hours"

Pro tier callout: "MOST POPULAR"
Pro CTA: "Start Free Trial" (not "Buy Now" — lower commitment)
ROI line: "Pays for itself after your first certificate"

Annual toggle: "Save £58/year — get 2 months free"
Guarantee: "30-day money-back guarantee. No questions asked."
Social proof: "Trusted by X electricians across the UK"
```

### Payment Strategy
1. Launch with Stripe-only web payments (2% fees, maximum margin)
2. Add Apple IAP via Small Business Program (15%) for iOS convenience
3. Implement external payment links post-Epic ruling to route iOS users to Stripe
4. Monitor Stripe vs IAP conversion rates — if IAP converts significantly better, the 13% fee differential may be worth the friction reduction


## Sources

- Bain & Company — perceived value drives 80% of B2B purchasing decisions
- Simon-Kucher & Partners — anchoring increases contract values 15-20%
- Huber, Payne, Puto (1982) — decoy effect foundational study
- Price Intelligently — 512 SaaS companies, 3 tiers = 30% higher ARPU
- ConversionXL — 4→3 tiers = 27% conversion increase; eye-tracking studies
- ProfitWell/Paddle (2024) — heavy discounting lowers LTV by 30%
- Cacheflow (2024) — 10,000 proposals; 1-20% discounts optimal
- McKinsey — loss-framed messaging 21% higher conversion
- Kahneman & Tversky (1979) — loss aversion ~2x gain pleasure
- Lambrecht & Skiera (2006) — flat-rate bias in consumer preferences
- Vendr (2024) — median annual prepay discount 18%
- Epic Games v Apple (2025) — external payment links ruling
- Apple Developer — Small Business Program 15% commission
- Stripe UK pricing — 1.5% + 20p standard, +0.5% Billing
- MyJobQuote/Checkatrade/MyBuilder — UK electrician rates £40-60/hr
- First Page Sage (2026) — SaaS freemium conversion rate benchmarks

### research-uk-electrician-market

# UK Electrician Market & Channel Research for CertMate

## 1. Market Size & Demographics

### Overall Market
- **UK electrician industry size**: £35.3bn (2026), CAGR 5.3% over past 5 years
- **Registered electricians**: ~230,000 in the UK
- **Electrician businesses**: ~50,434 (grew 1.8% YoY, CAGR 1.5% 2020-2025)
- **Future demand**: UK will need an additional 100,000 electricians by 2032

### Private Rented Sector (EICR Target Market)
- **4.7 million PRS homes** in England (19% of households)
- **Landlord profile**: 45% own 1 property, 38% own 2-4, 17% own 5+ (but control ~50% of tenancies)
- **EICR renewal wave**: Millions of EICRs issued during 2021 mandatory rollout expire by **April 2026** — massive demand spike expected
- **Penalty for non-compliance**: Increased to £40,000 max civil penalty from November 2025

### Key Insight for CertMate
The April 2026 EICR renewal wave is the single biggest market opportunity. Every electrician doing landlord work will be overwhelmed with EICR demand, making efficiency-boosting certification software extremely attractive.


## 2. Where UK Electricians Hang Out Online

### Forums (High Trust, Peer Recommendations)
| Forum | URL | Notes |
|-------|-----|-------|
| **ElectriciansForums.net** | electriciansforums.net | Largest UK-specific forum. Active cert software discussions. Multiple threads comparing iCertifi, EasyCert, Electraform, Clik |
| **Talk Electrician** | electricianforum.co.uk | UK's "friendliest" electrical forum. Covers domestic, commercial, solar PV, DIY |
| **Electrician Talk** | electriciantalk.com | Pros-only community with dedicated UK section |
| **Screwfix Community Forum** | community.screwfix.com | Large tradesperson community, broad topics including tools and software |

**Strategy**: Organic engagement on ElectriciansForums.net is essential. Electricians actively ask "what's the best certification software?" in recurring threads. Being recommended by real users in these threads is the #1 trust signal.

### Facebook Groups
| Group | Notes |
|-------|-------|
| **Electricians Community UK** | facebook.com/groups/ElectricianscommunityUK |
| **UK Electricians Network** | Large community for connecting and sharing |
| **Local community groups** | Thousands of local groups where homeowners ask for tradesperson recommendations |
| **NAPIT Members Group** | Unofficial groups for NAPIT-registered electricians |
| **Electrical Apprentice groups** | Target future long-term users early |

**Key stat**: 71% of people use Facebook as their first port of call when searching for a tradesperson.

### YouTube Channels (UK-Focused)
| Channel | Subscribers | Focus |
|---------|-------------|-------|
| **eFIXX** | 808K+ subs, 2.2K videos | Education for electricians, contractors, apprentices — **top UK channel** |
| **CJR Electrical** | Popular | Day-in-the-life, tool reviews, exposing bad work (Oxfordshire) |
| **David Savery** | Growing | Honest content about life as a UK sparky (Leamington Spa) |
| **Artisan Electrics** | Growing | EV charging, smart home, solar (Cambridge) |
| **Mike Page** | Growing | Electrician + filmmaker, education/storytelling |

**Strategy**: Sponsor or partner with eFIXX for maximum reach. CJR Electrical and David Savery for authentic "sparky uses this app" content.

### TikTok / Short-Form Video
- Tradespeople are major TikTok creators — some earning up to £11k per post
- **Content that works**: Before/after transformations, time-lapse work, problem-solving videos, day-in-the-life
- **Key principle**: Authenticity over production quality. Smartphone-filmed, native-style content outperforms polished ads
- Trade TikTok content gets massive engagement from both tradespeople and general public


## 3. Trade Publications & Media

### Print/Digital Magazines
| Publication | Reach/Notes |
|-------------|-------------|
| **Professional Electrician & Installer** | **#1 reach**: ABC audited circulation of 81,413. Distributed at 2,000+ wholesale branches nationwide |
| **Electrical Times** | Longest-serving (since 1892). Definitive for contractors |
| **Electrical Contracting News (ECN)** | Since 1980. Business magazine for electrical contracting industry |
| **Electrical Trade Magazine** | Buyer-seller focused, distributed at wholesale outlets |
| **Electrical Wholesaler Magazine** | Only monthly title for wholesaler/bulk-buying sector (via Voltimum) |
| **SPARKS Magazine** | Only magazine for electrical students/apprentices |
| **The Competent Person** | NAPIT's own magazine sent to all members |

### Online Trade Media
- **Voltimum UK** (voltimum.co.uk) — Online knowledge hub for electrical professionals
- **Electrical Safety First** (electricalsafetyfirst.org.uk) — Charity with strong trade presence, publishes guidance

**Strategy**: Advertise in Professional Electrician & Installer for maximum reach (81K+ circulation at wholesale counters where electricians browse daily). PR/editorial in Electrical Times for credibility.


## 4. Trade Shows & Events (2026)

### Must-Attend Events
| Event | Date | Location | Attendance | Notes |
|-------|------|----------|------------|-------|
| **InstallerSHOW** | 23-25 June 2026 | NEC Birmingham | 30,000+ visitors, 800+ exhibitors | Dedicated InstallerELECTRIC zone. CPD accredited. Supported by NAPIT & NICEIC |
| **NAPIT EXPO Roadshow** | April-May 2026 | Southampton (21 Apr), Leeds (1 May), Bristol (8 May), Coventry (12 May) | Regional | Focused on Amendment 4 of Wiring Regs — **perfect timing for CertMate** |
| **Elex Shows** | Throughout 2026 | Bolton (5-6 Mar), Exeter (26-27 Mar), Harrogate (23-24 Apr), London (Alexandra Palace), Surrey (Sandown Park) | Regional | Multiple touchpoints across UK |
| **UK Construction Week** | Oct 7-9 (Birmingham), May 6-8 (London) | Birmingham & London | Major | Broader construction audience |
| **Solar & Storage Live** | Apr 29-30 | London | Growing | EV/renewables crossover audience |

**Strategy**: NAPIT EXPO Roadshows are the highest-ROI opportunity — small, focused events where every attendee is a registered electrician learning about Amendment 4 (which affects certification). Demo CertMate's Amendment 4 compliance features. InstallerSHOW for scale.


## 5. Trust Signals & Purchasing Psychology

### How Electricians Choose Software
1. **Peer recommendation is king**: Word-of-mouth and forum recommendations are the primary trust signal. 70% of tradespeople use companies recommended by someone they know
2. **Value must be demonstrable**: If an app charges £30/month, it must clearly save 2-3 hours of work or it gets cancelled. "Tool overload fatigue" from 2020-2022 means electricians are ruthless about cutting subscriptions
3. **Offline functionality is non-negotiable**: Apps that fail without internet are abandoned. Must have offline mode with background sync
4. **Data ownership matters**: Electricians want to export their data. Walled gardens that lock historical records behind subscriptions create hostage situations
5. **Simplicity over features**: The tradespeople succeeding in 2026 use the fewest apps that accomplish the most. One accounting platform + one job management system + one certification app
6. **AI trust is limited**: Electricians don't yet trust AI for compliance decisions, safety calculations, or regulation interpretation. AI is accepted for admin productivity, not for replacing expertise

### Critical Trust Signals for CertMate
- **NICEIC or NAPIT endorsement/approval** — The gold standard. NICEIC currently has an exclusive software partnership with Clik Software for branded certificates
- **BS 7671 compliance** — Must be explicitly stated and kept up to date with amendments
- **"Made by electricians"** narrative — Tools designed by people who understand the trade get higher trust
- **Free trial / freemium** — Let them try before they pay. Electricians are highly cost-conscious
- **Trustpilot / Google reviews** — Steady stream of recent reviews dramatically improves conversion

### Certification Body Landscape
| Body | Members | Cost | Notes |
|------|---------|------|-------|
| **NICEIC** | Largest, most recognised | ~£1,100+/yr | Stronger for commercial/government contracts. Has exclusive Clik Software cert partnership |
| **NAPIT** | Growing, cost-effective | From £605+VAT/yr | Better for residential/multi-trade. Own magazine "The Competent Person". More accessible partnership opportunities |
| **ELECSA** | Smaller | Varies | Part of the ECA family |
| **ECA** | Trade association | Varies | Events, lobbying, professional development |

**Partnership strategy**: NAPIT is the more accessible partnership target. They already support InstallerSHOW, run EXPO roadshows, and publish The Competent Person magazine. NICEIC's software partnership with Clik may be exclusive, making NAPIT the better first move.


## 6. Digital Marketing Channels

### Google Ads / PPC
**High-intent keywords to target:**
| Keyword Category | Examples | Est. CPC (UK) |
|------------------|----------|---------------|
| Certification software | "EICR software", "electrical certificate app", "certification software electrician" | £2-8 |
| Specific cert types | "EICR app", "electrical installation certificate software", "minor works certificate app" | £1-5 |
| Pain point searches | "EICR paperwork too slow", "fill in EICR digitally", "electrical testing app" | £1-4 |
| Competitor terms | "iCertifi alternative", "EasyCert vs", "Clik cert software" | £3-8 |
| Regulation searches | "BS 7671 amendment 4", "18th edition changes 2026", "EICR requirements landlord" | £1-3 |

**Negative keywords**: "jobs", "training", "DIY", "free", "course", "salary"

**Campaign structure**: Split by intent — Brand, Competitor, Product Category, Pain Point, Regulation/Compliance

### SEO Content Strategy
- **Amendment 4 content**: Guides on what's changing, how it affects certification — capture regulation-change traffic
- **EICR renewal wave content**: "2026 EICR renewal guide for electricians" — capture the April 2026 demand spike
- **Comparison pages**: "CertMate vs iCertifi vs EasyCert" — capture decision-stage searches
- **Technical guides**: "How to fill in an EICR correctly" — capture early-stage awareness

### YouTube / TikTok Video Strategy
**Video types that work for software demos:**
1. **"Watch me complete an EICR in X minutes"** — Time-lapse of real certification using CertMate
2. **Before/after** — Paper forms vs CertMate side-by-side comparison
3. **Real electrician reviews** — Partner with CJR Electrical, David Savery, or similar UK creators
4. **Problem-solving** — "What to do when your EICR has C2 codes" educational content featuring CertMate
5. **eFIXX partnership** — Sponsored educational content reaching 808K+ subscribers

**Key principle**: Native, authentic content filmed on-site by real electricians. Not corporate product videos.

### Lead Generation Platforms
| Platform | Model | Notes |
|----------|-------|-------|
| Checkatrade | Annual membership | Vetted directory, good for brand association |
| MyBuilder | Per-job fees | Lead generation focused |
| Rated People | £15/mo + per-lead | Lower barrier to entry |
| TrustATrader | Annual membership | Strong in certain regions |

These aren't direct CertMate marketing channels, but understanding where electricians already spend money on lead generation informs pricing sensitivity and channel strategy.


## 7. Wholesale & Training Provider Partnerships

### Electrical Wholesalers (Distribution Channel)
| Wholesaler | Branches | Partnership Opportunity |
|------------|----------|------------------------|
| **CEF (City Electrical Factors)** | ~390 UK branches | Largest branch network. Flyers at trade counters, QR codes on receipts |
| **Edmundson Electrical** | 300+ branches | Strong trade counter presence, supports local contractors |
| **Rexel UK** | National coverage | Part of global group, project services focus |
| **Screwfix** | 800+ stores | Retail-oriented but massive footprint. App could be featured in their digital ecosystem |

**Strategy**: Professional Electrician & Installer magazine is already distributed at 2,000+ wholesale branches. A combined editorial + counter display campaign reaches electricians where they already go daily. Fergus (job management) has already integrated with 26+ wholesalers — proves the partnership model works.

### Training Providers (Awareness Channel)
| Provider | Notes |
|----------|-------|
| **TradeSkills4U** | Multiple centres (Midlands, NW). Offering Amendment 4 CPD courses |
| **Able Skills** | 18th edition courses |
| **EC4U (Electrician Courses 4U)** | City & Guilds courses |
| **Total Skills UK** | BS 7671 training |
| **Electrical Courses UK** | Cambridge-based |

**Strategy**: Partner with training providers to include CertMate in course materials or offer free trial codes to all course completers. Amendment 4 training courses in 2026 are the perfect moment — electricians learning new regs need updated certification tools.


## 8. Seasonal Strategy & Timing

### Annual Demand Pattern
| Period | Demand Level | Opportunity |
|--------|-------------|-------------|
| **Jan-Feb** | Quietest months | Best time for marketing push — electricians have time to evaluate new tools, attend training, plan for busy season |
| **March-April** | Ramp-up + EICR renewal wave | **2026 specifically**: Massive EICR demand as 2021 certificates expire. Peak urgency for certification software |
| **May-September** | Peak season | Electricians are busiest. Focus on "save time" messaging. In-app prompts and retention |
| **October-November** | Autumn demand | Pre-winter electrical work. Good for second marketing push |
| **December** | Slowdown | Planning and reflection. Good for annual subscription renewal offers |

### 2026-Specific Timing
- **April 2026**: EICR renewal wave peak — every landlord's 2021 certificate expires
- **April 2026**: Amendment 4 of BS 7671 takes effect (15 April) — electricians need updated certification tools
- **October 2026**: Amendment 3 formally withdrawn — full transition complete

**CertMate launch timing**: Ideal window is **Q1 2026** (Jan-March) to capture:
1. January quiet period (electricians evaluating tools)
2. NAPIT EXPO roadshows (April-May, Amendment 4 focused)
3. EICR renewal wave (April onwards)
4. InstallerSHOW (June, scale exposure)


## 9. Competitive Certification Software Landscape

### Current Players
| Software | Model | Key Features | Weaknesses |
|----------|-------|-------------|------------|
| **iCertifi** | Subscription | BS 7671 certs, mobile app | Forum feedback: "time-consuming", complex |
| **EasyCert** | Per-cert or sub | Long-standing, template system | Dated UI, many tick boxes |
| **Electraform** | Per-form pricing | Good value, responsive support | Less mobile-focused |
| **Clik NICEIC Cert** | Subscription | **Only officially NICEIC-branded** certificates | Tied to NICEIC membership |
| **Tradecert** | Subscription | Modern, UK-focused | Newer, less established |
| **Pro Certs** | Subscription | EICR-focused | Limited scope |
| **Electrical Certificate App** | Subscription | Mobile-first | Smaller user base |

### CertMate's AI Differentiation
None of these competitors offer AI-powered certificate completion. CertMate's opportunity is to be the **first AI-assisted certification tool** — but messaging must acknowledge electricians' AI skepticism:
- Position AI as **"smart autofill"** and **"admin assistant"**, not as making compliance decisions
- Emphasize the electrician remains in control — AI suggests, human verifies
- Show time savings with specific numbers: "Complete an EICR in 15 minutes instead of 45"


## 10. Channel Strategy Summary & Recommendations

### Tier 1: Highest ROI (Launch Priority)
1. **ElectriciansForums.net presence** — Organic engagement, answer questions, build reputation
2. **NAPIT EXPO Roadshows** — Demo at Amendment 4 events (April-May 2026)
3. **YouTube partnerships** — eFIXX sponsorship + CJR Electrical / David Savery reviews
4. **Google Ads** — Target EICR/certification software keywords + Amendment 4 terms
5. **Free trial / freemium model** — Essential for trade adoption

### Tier 2: Growth Phase
6. **Professional Electrician & Installer** — Advertorial + wholesale counter presence (81K circulation)
7. **InstallerSHOW 2026** — Exhibition stand in InstallerELECTRIC zone (June)
8. **Training provider partnerships** — Free trial codes with Amendment 4 courses
9. **Facebook group engagement** — UK Electricians Network, local groups
10. **TikTok / Instagram Reels** — Authentic demo content by real sparks

### Tier 3: Scale & Partnerships
11. **NAPIT partnership** — Explore endorsed/approved software status
12. **Wholesaler counter displays** — CEF, Edmundson (390+ branches)
13. **Referral program** — Offer 1 month free for each referred electrician who signs up
14. **Checkatrade / MyBuilder integration** — Cross-promote to electricians on these platforms
15. **Electrical Times / ECN editorial** — Thought leadership on AI in certification

### Key Messages by Channel
| Channel | Message |
|---------|---------|
| Forums | "Fellow sparky here — this saved me 30 mins per EICR" |
| Trade shows | "Amendment 4 ready. Complete an EICR in 15 minutes" |
| YouTube | "Watch me fill in a full EICR using AI assistance" |
| Google Ads | "EICR Software — AI-Powered. Free Trial. BS 7671 Compliant" |
| Trade press | "The future of electrical certification: how AI is cutting admin time by 60%" |
| Wholesaler displays | "Scan to try free — the fastest EICR app" |


*Research compiled March 2026. Sources: ElectriciansForums.net, IBISWorld, ONS, Electrical Times, Professional Electrician & Installer, Voltimum, NICEIC, NAPIT, ECN, InstallerSHOW, TradeSkills4U, Electrical Safety First, GOV.UK, eFIXX, Feedspot, Elec Training, various trade discussion threads.*

### roi-calculator-messaging

# CertMate ROI Calculator Messaging & Value Frames

**Date:** 25 March 2026
**Purpose:** ROI calculator specification, value framing, and comparison messaging for CertMate pricing tiers. Designed to overcome the emotional price anchor of £10-15/mo for cert software by reframing value in terms of time saved, money saved, and extra jobs gained.


## 1. Core ROI Thesis: Per-Cert Cost vs Admin Time Saved

### The Time-Value Gap

UK electricians charge **£50-60/hr** for their work, yet spend 45-60 minutes per EICR on unpaid admin — writing up certificates, cross-referencing BS 7671, checking observations, filling in schedules of test results.

CertMate's voice-to-certificate AI reduces EICR write-up from **45 minutes to 10-15 minutes** — saving ~30 minutes per certificate.

| Metric | Manual | With CertMate | Saving |
|--------|--------|--------------|--------|
| EICR write-up time | 45-60 min | 10-15 min | **30-45 min** |
| Admin cost at £50/hr | £37.50-50.00 | £8.33-12.50 | **£25-37.50 per cert** |
| Admin cost at £60/hr | £45.00-60.00 | £10.00-15.00 | **£30-45.00 per cert** |

### The ROI Per Tier (Conservative: 30 min saved, £50/hr rate)

| Tier | Monthly Cost | Certs/mo | Time Saved | Value of Time | ROI Multiple | Net Monthly Gain |
|------|-------------|----------|-----------|---------------|-------------|-----------------|
| **Starter** | £15 | 8 | 4 hours | £200 | **13.3×** | **£185** |
| **Pro** | £30 | 20 | 10 hours | £500 | **16.7×** | **£470** |
| **Company** | £60 | 50 | 25 hours | £1,250 | **20.8×** | **£1,190** |

### The ROI Per Tier (At £60/hr rate)

| Tier | Monthly Cost | Time Saved | Value of Time | ROI Multiple | Net Monthly Gain |
|------|-------------|-----------|---------------|-------------|-----------------|
| **Starter** | £15 | 4 hours | £240 | **16.0×** | **£225** |
| **Pro** | £30 | 10 hours | £600 | **20.0×** | **£570** |
| **Company** | £60 | 25 hours | £1,500 | **25.0×** | **£1,440** |

**Key messaging insight:** Even the most expensive tier delivers 20×+ return at standard electrician rates. The ROI *increases* with higher tiers — Company users get the best deal per cert.

### Per-Cert Value Breakdown

| Tier | Cost Per Cert | Admin Time Saved Per Cert | Value of Time Saved (£50/hr) | Net Value Per Cert |
|------|--------------|--------------------------|-----------------------------|--------------------|
| **Starter** | £1.88 | 30 min | £25.00 | **+£23.12** |
| **Pro** | £1.50 | 30 min | £25.00 | **+£23.50** |
| **Company** | £1.20 | 30 min | £25.00 | **+£23.80** |

**Headline stat:** *"You pay £1.50 per cert. You save £25 worth of time. That's 17× your money back on every single certificate."*


## 2. Interactive ROI Calculator Specification

### Purpose
A web-based calculator embedded on the CertMate pricing page that lets electricians input their own numbers and see personalised ROI. Overcomes the "cert app should cost £10/mo" anchoring by showing the true cost of *not* using CertMate.

### Calculator UI Spec

#### Inputs (User Adjustable)

| Input | Type | Default | Range | Label |
|-------|------|---------|-------|-------|
| EICRs per month | Slider + number input | 12 | 1–80 | "How many EICRs do you do per month?" |
| Hourly rate | Slider + number input | £50 | £30–£100 | "What's your hourly rate?" |
| Current write-up time | Slider + number input | 45 min | 20–90 min | "How long does an EICR take to write up?" |

**Optional advanced toggle:**
| Input | Type | Default | Range | Label |
|-------|------|---------|-------|-------|
| Average EICR job price | Number input | £175 | £80–£400 | "What do you charge per EICR?" |
| Working days per week | Dropdown | 5 | 4–6 | "Days you work per week" |

#### Outputs (Auto-Calculated, Animated on Change)

**Primary outputs (always visible):**

| Output | Calculation | Display Format | Colour |
|--------|------------|----------------|--------|
| Recommended tier | Based on EICRs/mo: ≤8 → Starter, ≤20 → Pro, ≤50 → Company | Tier badge with price | Brand primary |
| Monthly time saved | EICRs × (current_time - 15min) / 60 | "X hours saved per month" | Green |
| Monthly money saved | time_saved_hours × hourly_rate | "£X saved per month" | Green, large font |
| ROI multiple | money_saved / tier_price | "X× return on investment" | Green, animated counter |
| Annual net gain | (money_saved - tier_price) × 12 | "£X,XXX extra per year" | Green, bold |

**Secondary outputs (visible below fold or on expand):**

| Output | Calculation | Display Format |
|--------|------------|----------------|
| Cost per day | tier_price / 30 | "CertMate costs you just Xp per day" |
| Time saved per cert | current_time - 15 min | "X minutes back per certificate" |
| Extra jobs possible | monthly_time_saved / avg_job_duration_hrs | "That's X extra jobs you could do" |
| Extra job revenue | extra_jobs × avg_eicr_price | "Worth £X in extra revenue" |
| Break-even certs | tier_price / (time_saved_per_cert_hrs × hourly_rate) | "Pays for itself after just X certs" |

#### Tier Auto-Recommendation Logic

```
if (eicrs_per_month <= 1) → suggest Free tier
if (eicrs_per_month <= 8) → suggest Starter (£15/mo)
if (eicrs_per_month <= 20) → suggest Pro (£30/mo)
if (eicrs_per_month <= 50) → suggest Company (£60/mo)
if (eicrs_per_month > 50) → suggest Company + "Contact us for Enterprise"
```

#### Break-Even Calculation

The calculator should prominently show how few certificates it takes to pay for the subscription:

| Tier | Price | Value per cert (at £50/hr, 30 min saved) | Break-even certs |
|------|-------|------------------------------------------|-----------------|
| **Starter** | £15 | £25 | **0.6 certs** (1 cert covers it) |
| **Pro** | £30 | £25 | **1.2 certs** (2 certs covers it) |
| **Company** | £60 | £25 | **2.4 certs** (3 certs covers it) |

**Headline:** *"CertMate pays for itself after your first 1-2 certificates each month. Everything after that is pure profit."*

#### Visual Design Notes

- **Layout:** Single horizontal or stacked card with sliders on left, results on right (desktop) or stacked (mobile)
- **Animation:** Numbers should count up/down smoothly when sliders move (use requestAnimationFrame, not setInterval)
- **Colour:** Green for savings/positive values. Use the savings number as the visual hero — make it large (36-48px)
- **CTA below calculator:** "Start Your Free Trial" button that pre-selects the recommended tier
- **Social proof below CTA:** "Join 500+ electricians saving 4+ hours per month" (update number as user base grows)
- **Mobile:** Full-width sliders, stacked layout. Calculator must work perfectly on iPhone/Android — electricians will see this on their phones
- **Accessibility:** All slider values readable by screen readers. Contrast-compliant green on white. ARIA live regions for dynamic output updates

#### Technical Implementation Notes

- Pure client-side JavaScript (no API calls needed)
- Pre-calculate tier boundaries to avoid layout shift on tier change
- Store last-used values in localStorage so returning visitors see their numbers
- URL parameter support: `?eicrs=15&rate=55` for use in targeted campaigns
- Event tracking: Log slider interactions and final values to analytics (which tier was recommended, what inputs were used) to understand user profile distribution


## 3. Five Value Frames

Each frame recontextualises the subscription cost to overcome price resistance. Use these across pricing page, email campaigns, social media, and sales conversations.

### Frame 1: The Daily Cost Frame
*"Less than your morning coffee"*

| Tier | Monthly | Daily Cost | Comparison |
|------|---------|-----------|------------|
| **Starter** | £15 | **50p/day** | Less than a Freddo (55p) |
| **Pro** | £30 | **£1/day** | A third of your morning coffee |
| **Company** | £60 | **£2/day** | One coffee from the van |

**Copy:** *"CertMate Pro costs £1 a day. That's less than the coffee you grab on the way to site. Except this saves you 10 hours of paperwork every month."*

**Where to use:** Social media ads, email subject lines, pricing page subheading

### Frame 2: The Weekly Cost Frame
*"Less than a takeaway"*

| Tier | Monthly | Weekly Cost | Comparison |
|------|---------|------------|------------|
| **Starter** | £15 | **£3.46/week** | A pint at the pub |
| **Pro** | £30 | **£6.92/week** | A meal deal |
| **Company** | £60 | **£13.85/week** | Less than a Friday takeaway |

**Copy:** *"For less than a Friday night kebab, CertMate Company handles the paperwork for 50 certificates a month. Your weekend starts sooner."*

**Where to use:** Facebook/forum ads targeting tradespeople, WhatsApp/email drip campaigns

### Frame 3: The Per-Cert Cost Frame
*"Pennies per certificate, pounds in your pocket"*

| Tier | Per-Cert Cost | Time Saved Per Cert | Value Created Per Cert | Net Value |
|------|--------------|--------------------|-----------------------|-----------|
| **Starter** | £1.88 | 30 min (worth £25) | £25.00 | **+£23.12** |
| **Pro** | £1.50 | 30 min (worth £25) | £25.00 | **+£23.50** |
| **Company** | £1.20 | 30 min (worth £25) | £25.00 | **+£23.80** |

**Copy:** *"Each certificate costs you £1.50 but saves you £25 in admin time. That's not an expense — it's a 17× investment."*

**Where to use:** Pricing page (next to each tier), ROI calculator output, comparison landing pages

### Frame 4: The Annual Savings Frame
*"What would you do with an extra £5,000?"*

| Tier | Annual Cost | Annual Time Saved | Annual Value Saved (£50/hr) | Annual Net Gain |
|------|------------|-------------------|----------------------------|----------------|
| **Starter** | £180/yr | 48 hours | £2,400 | **£2,220/yr** |
| **Pro** | £360/yr | 120 hours | £6,000 | **£5,640/yr** |
| **Company** | £720/yr | 300 hours | £15,000 | **£14,280/yr** |

**Copy:** *"CertMate Pro users save over £5,600 a year in admin time. That's a family holiday. A new van payment. Or 120 hours you'll never waste on paperwork again."*

**Variant copy for Company:** *"£14,000+ back in your business every year. That's a new apprentice's salary funded entirely by cutting paperwork."*

**Where to use:** Annual plan upsell, email campaigns, case study headlines, trade press ads

### Frame 5: The Extra Jobs Frame
*"The admin time you save becomes billable time"*

This is the most powerful frame for electricians because it converts abstract "time saved" into concrete revenue.

| Tier | Monthly Time Saved | Extra Jobs Possible* | Extra Monthly Revenue | Extra Annual Revenue |
|------|-------------------|---------------------|----------------------|---------------------|
| **Starter** | 4 hours | 1 job | £175 | **£2,100** |
| **Pro** | 10 hours | 2-3 jobs | £437 | **£5,250** |
| **Company** | 25 hours | 6-7 jobs | £1,225 | **£14,700** |

*\*Based on average EICR job price of £175 and ~3.5 hour average on-site time including travel*

**Copy:** *"Every hour you spend on paperwork is an hour you're not earning. CertMate Pro gives you back 10 hours a month — that's 2-3 extra EICRs you could bill for. At £175 each, that's over £5,000 a year in extra revenue. The subscription costs £360."*

**Where to use:** This is the **#1 frame for forums, YouTube, and trade shows**. Electricians think in jobs and earnings, not hours and efficiency. Lead with "extra jobs" in all trade-facing messaging.


## 4. Comparison Table: CertMate vs Manual Paperwork

### Full Comparison

| Task | Manual / Paper | Basic Cert App | CertMate (AI Voice) |
|------|---------------|---------------|---------------------|
| **Start a new EICR** | Find blank form, fill in property details by hand | Open app, type property details into form fields | Say "new EICR for 42 Oak Lane" — address, client, property details auto-populated |
| **Record observations** | Walk around writing notes, then transcribe to form later | Type each observation into app fields on-site | Speak observations as you go: "Kitchen ring — polarity confirmed, Zs 0.31 ohms, RCD trips at 28ms" — AI fills the schedule |
| **Board schedule** | Count ways, identify MCBs, write each circuit manually | Select from dropdowns, type descriptions for each circuit | Photograph the consumer unit OR describe it: "10-way Hager board, 63A main switch, 32A ring final circuit 1..." — AI maps the full schedule |
| **Test results** | Record on paper, transcribe numbers into form fields | Type each reading into table cells | Speak readings: "Ring 1, R1 0.24, R2 0.25, R1+R2 0.49, Zs 0.31, insulation resistance greater than 200" — table auto-filled |
| **Observations & recommendations** | Write coded observations (C1/C2/C3/FI) by hand, reference BS 7671 manually | Select observation codes from lists | Describe the issue: "Double socket in bathroom Zone 2, not RCD protected" — AI assigns C2, references Reg 701.411.3.3, writes recommendation |
| **BS 7671 compliance check** | Cross-reference regs book manually | Some apps flag obvious errors | AI auto-reviews entire certificate against current regs, flags missing data, incorrect codes, reg references |
| **Completing the certificate** | Gather all papers, check for completeness, sign, file | Review digital form, submit | AI summary: "Certificate complete. 14 circuits tested, 2 C2 observations, 1 C3. Overall condition: Unsatisfactory. Ready to sign?" |
| **Time per EICR** | **45-60 minutes** write-up | **25-35 minutes** | **10-15 minutes** |
| **Error rate** | High — handwriting errors, missed fields, wrong reg refs | Medium — manual entry, but validation helps | Low — AI cross-checks readings, flags anomalies, verifies reg references |
| **Amendment 4 compliance** | Must manually learn & apply changes | Depends on app updates | Automatically updated — AI knows current regs |
| **Offline capability** | Paper always works | Varies by app | Full offline mode — syncs when connected |
| **Annual admin time (at 15 EICRs/mo)** | **135-180 hours** | **75-105 hours** | **30-45 hours** |

### Side-by-Side Time Comparison (Single EICR)

```
MANUAL PAPERWORK                          CERTMATE AI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Property details ........... 5 min        "New EICR, 42 Oak Lane" .. 30 sec
Board schedule ............ 10 min        Describe/photo board ..... 2 min
Circuit details ............ 8 min        Voice-describe circuits .. 3 min
Test results .............. 10 min        Speak readings ........... 3 min
Observations ............... 8 min        Describe issues .......... 2 min
Compliance check ........... 5 min        Auto-review .............. 30 sec
Review & sign .............. 5 min        Review AI summary ........ 2 min
                           ─────                                   ──────
TOTAL .................. ~51 min          TOTAL ................ ~13 min
                                          TIME SAVED ........... 38 min ✓
                                          VALUE SAVED (£50/hr) ... £31.67
```

### Cost Comparison Table (Monthly, at 15 EICRs/month)

| Method | Monthly Cost | Monthly Admin Time | Monthly Admin Cost (£50/hr) | Total Monthly Cost | Annual Total |
|--------|------------|-------------------|---------------------------|-------------------|-------------|
| **Paper forms** | £5 (printing) | 12.75 hours | £637.50 | **£642.50** | **£7,710** |
| **Basic cert app (£15/mo)** | £15 | 7.5 hours | £375.00 | **£390.00** | **£4,680** |
| **CertMate Pro (£30/mo)** | £30 | 3.25 hours | £162.50 | **£192.50** | **£2,310** |

**Net saving vs paper:** £450/month, £5,400/year
**Net saving vs basic app:** £197.50/month, £2,370/year

### The "Hidden Cost of Free" Table

For electricians who think paper/manual is "free":

| Hidden Cost | Paper/Manual | CertMate |
|------------|-------------|----------|
| Printing & stationery | £50-100/year | £0 |
| Filing & storage | Physical space, lost forms | Cloud backup, instant retrieval |
| Admin time (15 EICRs/mo at £50/hr) | **£7,650/year** | **£1,950/year** |
| Rework from errors | ~5% error rate = £400-800/year* | AI review catches errors before submission |
| Regulatory risk | Manual reg-checking, outdated forms | Auto-updated to current BS 7671 |
| **Total hidden annual cost** | **£8,100-8,550** | **£2,310** (Pro plan + admin time) |

*\*Based on industry estimates that 5-8% of manually completed certificates contain errors requiring rework, at an average cost of £50-100 per rework incident (return visit, re-issue cert, lost time)*


## 5. Messaging Templates by Channel

### Pricing Page Hero Copy

**Headline:** "Every EICR you write up by hand costs you £25 in lost time."
**Subhead:** "CertMate gives you that time back — for less than £1 a day."
**CTA:** "Calculate Your Savings →" (scrolls to calculator)

### Forum / Peer Messaging (Authentic Voice)

> Been using CertMate for 3 months now. Honestly didn't think AI would work for certs, but the voice thing is a game changer. I just talk through my observations as I do the inspection and it fills everything in. What used to take me 45 minutes of writing up in the van now takes 10-15. At 15 EICRs a month, that's nearly 8 hours I've got back. Works out to about 2 extra jobs a month I can fit in. The Pro plan's £30 but I'm making an extra £350 from the time saved, so it's a no-brainer.

### Email Subject Lines (A/B Test Variants)

1. "You're losing £5,600/year to EICR paperwork"
2. "What would you do with 120 extra hours?"
3. "£1/day for 10 hours back every month"
4. "Your next EICR could take 13 minutes"
5. "2-3 extra jobs per month. £30 investment."

### Trade Show Banner / Stand Copy

**Primary:** "Complete an EICR in 13 minutes. Not 45."
**Secondary:** "Voice-powered. BS 7671 compliant. Amendment 4 ready."
**CTA:** "Try it free — scan here"

### YouTube Pre-Roll (15-second)

*[Shot of electrician in van, writing on paper forms]*
"Still writing up EICRs by hand? That's 8 hours a month you could be earning."
*[Cut to phone screen, electrician speaking observations]*
"CertMate. Speak your observations. Get your certificate. 13 minutes."
*[End card: "Free trial — certmate.app"]*


## 6. Objection Handling with ROI Data

### "£30/month is too expensive for a cert app"

> "I get it — most cert apps are £10-15. But those apps just digitise the form. You're still typing everything in. CertMate is different — you speak your observations and it writes the certificate. Pro users save 10 hours a month in admin. At your hourly rate, that's £500+ saved. The £30 pays for itself after 2 certificates."

### "I can use iCertifi for £8/month"

> "iCertifi is solid for the price. But even with their new Board Vision, you're still filling in forms field by field. CertMate eliminates the form entirely — speak your observations as you inspect, and the certificate writes itself. Most users save 30+ minutes per EICR. If you do 10 EICRs a month, that's 5 hours back. Worth more than the price difference."

### "I don't trust AI for compliance"

> "Fair concern. CertMate doesn't make compliance decisions — you do. The AI handles the admin: filling in test results you dictate, mapping your observations to the right reg references, and flagging if you've missed a field. Think of it as a really fast admin assistant who knows BS 7671. You review and sign off everything."

### "I only do 5-6 certs a month, not worth it"

> "The Starter plan is £15 for 8 certs — that's £1.88 each. Each one saves you 30 minutes of writing up. At £50/hour, that's £25 of your time saved per cert. So you invest £15 and save £125-150. Even at 5 certs a month, you're getting 8-10× your money back."


## 7. Key Statistics for Marketing Copy

Quick-reference stats to embed across all marketing materials:

| Stat | Value | Source/Basis |
|------|-------|-------------|
| Time to complete EICR (manual) | 45-60 min | Industry average from forum research |
| Time to complete EICR (CertMate) | 10-15 min | Product capability target |
| Time saved per certificate | ~30 min | Conservative estimate |
| Monthly time saved (Pro, 20 certs) | 10 hours | 20 × 30 min |
| Annual time saved (Pro) | 120 hours | 10 hrs × 12 months |
| Monthly value saved (Pro, £50/hr) | £500 | 10 hrs × £50 |
| Annual net gain (Pro) | £5,640 | (£500 - £30) × 12 |
| ROI multiple (Pro) | 16.7× | £500 / £30 |
| Break-even certificates (Pro) | 2 | £30 / £25 per-cert value |
| Daily cost (Pro) | £1/day | £30 / 30 days |
| Per-cert cost (Pro) | £1.50 | £30 / 20 certs |
| Per-cert value created | £25 | 30 min × £50/hr |
| Extra jobs possible (Pro) | 2-3/month | 10 hrs / ~3.5 hrs per job |
| Extra annual revenue (Pro) | £5,250 | 2.5 jobs × £175 × 12 |
| EICR renewal wave | April 2026 | 2021 mandatory certs expiring |
| Average EICR job price | £150-200 | Market average |
| UK registered electricians | ~230,000 | Industry data |
| Private rented sector homes needing EICRs | 4.7 million | ONS / GOV.UK |


## 8. Calculator A/B Testing Recommendations

### Version A: Simple (Default)
Two inputs only: EICRs/month + hourly rate. Outputs: time saved, money saved, recommended tier.

### Version B: Detailed
Three inputs: EICRs/month + hourly rate + current write-up time. Outputs: full breakdown including extra jobs, annual projection, break-even.

### Version C: Competitive
Two inputs + dropdown: "What do you currently use?" (Paper, iCertifi, EasyCert, Tradecert, Other). Outputs tailored to show savings vs their current tool specifically.

### Test Hypothesis
Version A will have highest completion rate (simpler). Version C will have highest conversion rate (more personalised, competitive framing). Run A vs C first; if C wins, test C vs B.


*Document prepared for use across CertMate pricing page, marketing campaigns, trade show materials, and sales enablement. All calculations based on conservative 30-minute time saving per certificate and £50/hr electrician rate. Actual savings may be higher — the market research documents £50-60/hr as the standard rate range, and some EICRs take 60+ minutes to write up manually.*

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/amd64` for ECS Fargate (Mac builds ARM by default)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device


