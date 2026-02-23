> Last updated: 2026-02-18
> Related: [iOS Pipeline](ios-pipeline.md) | [Deployment](deployment.md) | [Field Reference](field-reference.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Architecture Reference

## Tech Stack

| Component | Technology |
|-----------|------------|
| iOS App | SwiftUI (CertMateUnified) — primary user interface |
| Transcription | Deepgram Nova-3 (direct WebSocket from iOS) |
| Data Extraction | Claude Sonnet 4.5 (live rolling extraction) + OpenAI GPT (batch/CCU photo analysis) |
| Photo Analysis | OpenAI Vision API |
| Backend | Node.js (ES modules) — API server, job processing, S3 storage |
| Editor UI | Python Streamlit (legacy, replaced by iOS app) |
| PDF Generation | Python ReportLab + Playwright (Chromium) |
| Cloud Storage | AWS S3 |
| Secrets | AWS Secrets Manager |

## Backend Container Architecture

The backend Docker container (`Dockerfile.backend`) includes:
- **Node.js 20** - Job processing pipeline
- **Python 3 + pip** - PDF generation scripts
- **Playwright + Chromium** - Browser-based PDF rendering
- **Sharp/libvips** - Image processing
- **All Python dependencies** from `requirements.txt`

**Key environment variables (set automatically):**
- `USE_AWS_SECRETS=true` - Loads API keys from AWS Secrets Manager at startup
- `NODE_ENV=production`
- `PORT=3000`

**Health check:** ALB uses `/health` endpoint (not `/`)

## PWA Container Notes

- `Dockerfile.pwa` uses `node:20-alpine` (minimal image)
- Container health check removed (task definition revision 6+) - relies on ALB health check only
- ALB health check: `/login` endpoint

## API Data Loading

The processing pipeline outputs separate JSON files, but the API can load from either format:
- **Pipeline outputs:** `installation_details.json`, `board_details.json`, `observations.json`
- **API also accepts:** `extracted_data.json` (combined format, created by PUT endpoint)

**Data Transformation:** When loading from pipeline files, `api.js` uses `transformExtractedData()` to map extracted data to UI format:
- Splits `board_details.json` into `board_info` + `supply_characteristics` + `installation_details`
- Maps fields like `ze` → `earth_loop_impedance_ze`, `voltage_rating` → `nominal_voltage_u`
- Sets sensible defaults for missing UI fields (e.g., `premises_description: "Residential"`)

If job data appears empty in PWA, check that API is reading the correct file format.

## Environment Variables

### Cloud (AWS Secrets Manager)
The cloud app gets API keys automatically from AWS Secrets Manager:

| Secret | Contents |
|--------|----------|
| `eicr/api-keys` | OPENAI_API_KEY, GEMINI_API_KEY, TRADECERT_EMAIL, TRADECERT_PASSWORD |
| `eicr/deepgram-api-key` | Deepgram API key for Nova-3 real-time transcription (served to iOS via GET /api/keys) |
| `eicr/anthropic-api-key` | Anthropic API key for Claude Sonnet 4.5 rolling extraction (server-side only) |
| `eicr/database` | PostgreSQL host, port, database, username, password |

**No action needed** - cloud deployment works without local API keys.

### Local Testing (Optional)
Only needed if you want to test locally before deploying. Add to `.env`:
```
OPENAI_API_KEY=sk-...              # For GPT extraction + Vision
GEMINI_API_KEY=...                 # For audio transcription
GEMINI_MODEL=gemini-3-pro-preview  # Transcription model
```

**Note:** You can skip local testing and deploy changes directly to the cloud.

## AI Models Reference

Current models used by the backend processing pipeline:

| Purpose | File | Model | Env Var |
|---------|------|-------|---------|
| Chunk transcription | `transcribe.js:242` | `gemini-3-pro-preview` | `GEMINI_CHUNK_MODEL` |
| Full transcription | `transcribe.js:104` | `gemini-3-pro-preview` | `GEMINI_MODEL` |
| Transcription fallback | `transcribe.js:105` | `gemini-2.5-flash` | `GEMINI_FALLBACK_MODEL` |
| Data extraction | `extract.js:278` | `gpt-5.2` | `EXTRACTION_MODEL` |
| Chunk extraction | `extract_chunk.js:48` | `gpt-5.2` | `EXTRACTION_MODEL` |
| Photo analysis | `analyze_photos.js:132` | `gpt-5.2` | `EXTRACTION_MODEL` |
| Salvage numbers | `salvage_numbers.js:9` | `gpt-5.2` | `EXTRACTION_MODEL` |
| OCR certificates | `ocr_certificate.js:218` | `gpt-4o` | (hardcoded) |
| Legacy transcribe | `gemini_transcribe.js:39` | `gemini-2.5-flash` | `GEMINI_MODEL` |

**Note:** For recording, iOS fetches API keys from `GET /api/keys` and connects directly to Deepgram. Sonnet extraction runs server-side via WebSocket. For batch processing and CCU photo analysis, the backend calls AI APIs directly.

## AWS Configuration

| Resource | Value |
|----------|-------|
| Region | eu-west-2 (London) |
| Account ID | 196390795898 |
| Domain | certomatic3000.co.uk |
| ECS Cluster | eicr-cluster-production |
| Frontend Service | eicr-frontend |
| Backend Service | eicr-backend |
| ECR Frontend | 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-frontend |
| ECR Backend | 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend |
| RDS Database | eicr-db-production.cfo684yymx9d.eu-west-2.rds.amazonaws.com |
| Database Name | eicr_omatic |
| Load Balancer | eicr-alb-production |
| ALB Idle Timeout | 600 seconds |
| Backend Memory | 2048 MB |
| Backend CPU | 512 units |

## Multi-User Support

The system supports multiple users (Derek, Michael) with:
- Separate output directories (`data/OUTPUT_Derek/`, `data/OUTPUT_Michael/`)
- Separate done/failed directories
- Per-user company settings (`config/company_settings_Derek.json`)
- Inspector profile selection in editor

## Production Infrastructure Status

**Production URL:** https://certomatic3000.co.uk

| Component | Status | Details |
|-----------|--------|---------|
| Domain | LIVE | certomatic3000.co.uk (Route 53) |
| SSL Certificate | ACTIVE | AWS ACM (auto-renewing) |
| Load Balancer | RUNNING | AWS ALB (eu-west-2) |
| PWA Frontend | RUNNING | ECS Fargate (Next.js) - `eicr-pwa` service |
| Backend | RUNNING | ECS Fargate (Node.js) - `eicr-backend` service |
| Database | RUNNING | RDS PostgreSQL |
| Storage | CONFIGURED | S3 bucket |
| Secrets | CONFIGURED | AWS Secrets Manager |
| Streamlit | STOPPED | Replaced by PWA (can re-enable if needed) |

### Architecture Diagram (AWS)

```
Mobile Device (PWA) → AWS ALB (SSL) → ECS Containers
                                          ├── Next.js PWA Frontend (eicr-pwa)
                                          └── Node.js Backend (eicr-backend)
                                                 ↓
                                    PostgreSQL (RDS) + S3 Storage
```

## Estimated Costs

- **AWS Infrastructure:** $77-122/month
- **API Usage (OpenAI/Gemini):** $20-45/month
- **Total:** ~$100-170/month
