# EICR-oMatic 3000

> **MANDATORY — Every code change must update docs and be committed.**
> - Changed a pipeline step, field, or architecture? Update the matching [reference file](docs/reference/).
> - Hub CLAUDE.md is an **index only** — add detail to reference files, not here.
> - Add a row to the [Changelog](#changelog) for any user-facing or architectural change.
> - Delete stale content rather than commenting it out. Keep every file under its target line count.
> - **Commit after each logical unit of work.** Small, focused commits with clear messages — not one giant commit at the end.

Automated EICR/EIC certificate creation for electrical inspectors using an iOS-first workflow.

## Project Overview

1. **Photo Capture** - Inspector photographs consumer unit (CCU) via iOS app
2. **CCU Analysis** - GPT Vision extracts circuit data from consumer unit photos
3. **Voice Recording** - Inspector dictates test readings and observations into iOS app
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

Cloud keys loaded automatically from AWS Secrets Manager: `eicr/api-keys`, `eicr/deepgram-api-key`, `eicr/anthropic-api-key`, `eicr/database`. No local `.env` needed for cloud deploys.

> Full details: [docs/reference/architecture.md](docs/reference/architecture.md#environment-variables)

## Certificate Types

- **EICR** - Electrical Installation Condition Report (periodic inspection)
- **EIC** - Electrical Installation Certificate (new installations)

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
