> Last updated: 2026-02-18
> Related: [Architecture](architecture.md) | [iOS Pipeline](ios-pipeline.md) | [Deployment](deployment.md) | [Field Reference](field-reference.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# File Structure Reference

## Directory Structure

```
EICR_App/
├── src/                        # Node.js processing pipeline
│   ├── process_job.js          # Main job orchestrator
│   ├── transcribe.js           # Audio transcription (Gemini)
│   ├── extract.js              # Data extraction (GPT)
│   ├── analyze_photos.js       # Photo analysis (Vision)
│   ├── generate_pdf.js         # Test results PDF
│   ├── salvage_numbers.js      # Numeric value extraction
│   ├── merge_salvage.js        # Merge extracted numbers
│   └── scale_photos.js         # Photo resizing
│
├── python/                     # Python scripts
│   ├── eicr_editor.py          # Streamlit editor UI (main)
│   ├── eicr_pdf_generator.py   # EICR certificate PDF generator
│   ├── eic_pdf_generator.py    # EIC certificate PDF generator
│   └── generate_full_pdf.py    # Full certificate generation
│
├── config/                     # Configuration files
│   ├── inspector_profiles.json # Inspector profile settings
│   ├── baseline_config.json    # EICR baseline defaults
│   ├── eic_baseline_config.json# EIC baseline defaults
│   ├── field_schema.json       # Central field schema for AI + UI (all 29 circuit columns)
│   └── company_settings_*.json # Per-user company settings
│
├── assets/                     # Static assets
│   ├── logos/                  # Company logo images
│   ├── signatures/             # Inspector signature images
│   └── schema/                 # CSV schema definitions
│
├── data/                       # All job data
│   ├── INCOMING/               # Drop audio/photos here
│   ├── OUTPUT_Derek/           # Derek's processed output
│   ├── OUTPUT_Michael/         # Michael's processed output
│   ├── DONE_Derek/             # Derek's completed jobs
│   ├── DONE_Michael/           # Michael's completed jobs
│   ├── FAILED_Derek/           # Derek's failed jobs
│   └── FAILED_Michael/         # Michael's failed jobs
│
├── scripts/                    # Shell command scripts
│   ├── Open EICR Editor.command
│   ├── Process EICR.command
│   └── Run EICR-oMatic 3000.command
│
├── docs/                       # Documentation
│   ├── EICR-oMatic 3000 Field Guide.pdf
│   └── SETUP_GUIDE.md
│
├── run_all.js                  # Batch process all jobs
├── run_job.js                  # Process single job
├── package.json                # Node.js dependencies
├── requirements.txt            # Python dependencies
└── .env                        # Environment variables
```

## Job Processing Pipeline

1. **Input**: Place audio files (.m4a, .mp3, .wav) and/or photos in `../INCOMING/` (parent folder)
2. **Grouping**: Loose files auto-grouped into timestamped job folders
3. **Transcription**: Audio sent to Gemini for transcription
4. **Photo Scaling**: Photos resized for API efficiency
5. **Photo Analysis**: Vision API extracts consumer unit details
6. **Data Extraction**: GPT extracts circuits, observations, board info
7. **Numeric Salvage**: Secondary pass to capture missed values
8. **Merge**: Combine all extracted data
9. **PDF Generation**: Create test results PDF
10. **Output**: Results in `data/OUTPUT_<user>/` folder

## Key Files

| File | Purpose |
|------|---------|
| `src/api.js` | Backend HTTP + WebSocket server (job requests + Sonnet extraction stream) |
| `src/gemini_extract.js` | Gemini extraction: `geminiExtract()` (audio) + `geminiExtractFromText()` (text) |
| `src/process_job.js` | Main pipeline orchestrator |
| `src/extract.js` | GPT prompt engineering for data extraction |
| `src/transcribe.js` | Gemini transcription with retry logic |
| `src/secrets.js` | AWS Secrets Manager client (API keys + Deepgram key) |
| `src/sonnet-stream.js` | WebSocket session manager for Sonnet extraction |
| `src/eicr-extraction-session.js` | Multi-turn Sonnet conversation + compaction |
| `python/eicr_editor.py` | Full Streamlit UI (~2500 lines) |
| `python/eicr_pdf_generator.py` | EICR PDF with BS7671 formatting |
| `python/eic_pdf_generator.py` | EIC/Minor Works PDF generation |
| `python/generate_full_pdf.py` | Full certificate generation (called from Node.js) |

## Files Requiring Major Changes

| File | Changes |
|------|---------|
| `python/database.py` | PostgreSQL + connection pooling |
| `python/eicr_editor.py` | S3 file ops + mobile CSS |
| `python/auth.py` | JWT tokens + Secrets Manager |
| `src/process_job.js` | S3 integration + structured logging |
| `run_all.js` | S3 integration + env config |

## New Files Created (Cloud Deployment)

```
EICR_App/
├── Dockerfile.frontend       # Streamlit container (replaced by Next.js)
├── Dockerfile.backend        # Node.js + Python + Playwright container
├── Dockerfile.pwa            # Next.js PWA container (Phase 7D)
├── docker-compose.yml        # Local development
├── .gitignore               # Exclude .env, data/, node_modules/
├── .env.example             # Environment template
├── python/storage.py        # S3 storage abstraction
├── python/logging_config.py # Python structured logging
├── src/storage.js           # Node.js S3 integration
├── src/logger.js            # Node.js Winston logger
├── src/secrets.js           # Node.js Secrets Manager client
├── src/api.js               # Backend HTTP server with job endpoints
├── python/secrets_manager.py # Python Secrets Manager client
├── .github/workflows/deploy.yml  # CI/CD pipeline
├── infrastructure/setup-aws.sh   # AWS S3 + RDS setup script
├── infrastructure/setup-secrets.sh # AWS Secrets Manager setup
├── infrastructure/setup-ecs.sh   # AWS ECS Fargate + ALB setup
├── infrastructure/setup-monitoring.sh # CloudWatch alarms + dashboard
├── infrastructure/setup-domain.sh # Domain + SSL + Route 53 setup
├── pytest.ini                    # Python test configuration
├── jest.config.js                # Node.js test configuration
├── docs/plans/                   # Implementation plans
│   ├── 2026-01-24-pwa-replacement-design.md
│   ├── 2026-01-24-phase7a-job-editor.md
│   ├── 2026-01-24-phase7b-offline-support.md
│   ├── 2026-01-24-phase7c-pdf-generation.md
│   ├── 2026-01-24-phase7d-polish-deploy.md
│   └── 2026-01-25-linked-observations-design.md
├── frontend/                     # Next.js PWA (Phase 7)
│   ├── src/app/                  # App router pages
│   │   ├── dashboard/page.tsx    # Job list dashboard (with offline support)
│   │   ├── login/page.tsx        # Login page
│   │   ├── upload/page.tsx       # File upload page
│   │   ├── offline/page.tsx      # Offline fallback page
│   │   ├── settings/             # Settings pages (Phase 7C)
│   │   │   ├── layout.tsx        # Settings layout with tabs
│   │   │   ├── page.tsx          # Redirect to defaults
│   │   │   ├── defaults/page.tsx # Circuit defaults editor
│   │   │   └── company/page.tsx  # Company settings editor
│   │   └── job/[id]/             # Job editor pages (10 tabs EICR, 11 tabs EIC)
│   │       ├── layout.tsx        # Job layout with context + certificate type
│   │       ├── page.tsx          # Overview tab
│   │       ├── installation/page.tsx # Installation details
│   │       ├── supply/page.tsx   # Supply characteristics
│   │       ├── board/page.tsx    # Board info form
│   │       ├── circuits/page.tsx # Circuit grid editor
│   │       ├── observations/page.tsx # Observations editor (EICR only)
│   │       ├── inspection/page.tsx # EICR inspection schedule
│   │       ├── eic-inspection/page.tsx # EIC inspection schedule
│   │       ├── defaults/page.tsx # Apply defaults
│   │       ├── inspector/page.tsx # Inspector profile selection
│   │       ├── extent/page.tsx   # Extent & Type (EIC only)
│   │       ├── design/page.tsx   # Design & Construction (EIC only)
│   │       └── pdf/page.tsx      # PDF download page
│   ├── src/components/           # React components
│   │   ├── circuit-grid.tsx      # TanStack Table circuit editor
│   │   ├── error-boundary.tsx    # React error boundary
│   │   ├── job-tabs.tsx          # Tab navigation
│   │   ├── observation-card.tsx  # Observation display card
│   │   ├── inline-observation-form.tsx # Inline form for inspection schedule
│   │   ├── photo-picker.tsx      # Modal to select from job photos
│   │   ├── photo-upload.tsx      # Upload button with camera support
│   │   ├── offline-indicator.tsx # Expandable offline/sync status
│   │   ├── sync-provider.tsx     # Global sync listener provider
│   │   └── ui/
│   │       ├── select.tsx        # Radix Select component
│   │       └── textarea.tsx      # Textarea component
│   ├── src/lib/
│   │   ├── api.ts                # API client with types
│   │   ├── constants.ts          # Dropdown options, inspection items
│   │   ├── db.ts                 # Dexie IndexedDB schema
│   │   ├── store.ts              # Zustand job state store
│   │   └── sync.ts               # Sync service for offline
│   └── public/
│       ├── manifest.json         # PWA manifest
│       ├── icon-192.png          # PWA icon
│       └── icon-512.png          # PWA icon
├── python/tests/                 # Python test suite
│   ├── conftest.py               # Shared fixtures
│   ├── test_models.py            # Model tests
│   ├── test_auth.py              # Auth tests
│   ├── test_database.py          # Database tests
│   ├── test_secrets_manager.py   # Secrets tests
│   ├── test_generate_full_pdf.py # PDF generation tests
│   └── integration/              # Integration tests
│       ├── test_auth_flow.py
│       └── test_job_workflow.py
└── src/__tests__/                # Node.js test suite
    ├── merge_salvage.test.js     # Merge salvage tests
    └── storage.test.js           # Storage tests
```
