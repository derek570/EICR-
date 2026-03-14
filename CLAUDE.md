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
| PDF (iOS) | WKWebView HTML->PDF (EICRHTMLTemplate.swift) |
| PDF (server) | Python ReportLab + Playwright |
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



## WhatsApp Context
> Auto-synced from WhatsApp assistant memories on 2026-03-14. Do not edit manually.


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


