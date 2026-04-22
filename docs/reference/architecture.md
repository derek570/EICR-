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
| `eicr/api-keys` | Single JSON with ALL API keys: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, JWT_SECRET, etc. |
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

## CCU Photo Extraction Pipeline

`POST /api/analyze-ccu` (route: `src/routes/extraction.js`) runs a per-slot crop-and-classify VLM pipeline as the primary source of `circuits[]`, with the single-shot VLM prompt running in parallel as the authoritative source for labels and board-level metadata.

Sequence:

1. **Board-technology classifier** — one small VLM call (`claude-sonnet-4-6`, ~200 max tokens, ~3 s). Returns `{board_technology, main_switch_position}`. Routes the rest of the pipeline. Cost: ~$0.01. Source: `classifyBoardTechnology` in `src/routes/extraction.js`.
2. **Geometric pipeline** — three-stage per-slot extraction, dispatched based on classifier result:
   - **Modern** (MCB/RCBO boards): `src/extraction/ccu-geometric.js` — Stage 1 finds DIN-rail bbox (3 parallel VLM samples, median); Stage 2 derives module count from main-switch pitch; Stage 3 crops each slot and classifies (`mcb|rcbo|rcd|main_switch|spd|blank|unknown`) in batches of 4 crops per VLM call.
   - **Rewireable fuse** (BS 3036): `src/extraction/ccu-geometric-rewireable.js` — Stage 1 finds the carrier-bank panel bbox (no DIN rail); Stage 2 counts the carrier slots within that bank; Stage 3 classifies each crop as `rewireable|cartridge|blank`, reads the carrier body colour, and applies the BS 3036 colour code (white=5A, blue=15A, yellow=20A, red=30A, green=45A).
   - **Cartridge fuse / mixed** — routed to the rewireable pipeline; Stage 3 tags BS 1361 / BS 88-2 carriers as `cartridge` and reads the printed rating directly.
3. **Single-shot prompt** — the pre-existing ~11k-char 4-step-methodology prompt runs in parallel with Step 2. It is the authoritative source for circuit **labels**, main switch, SPD, board manufacturer/model, confidence message, and `questionsForInspector`.
4. **Merge** — `slotsToCircuits` in `extraction.js` builds `circuits[]` from the Stage 3 slot classifications: circuit 1 is nearest the main switch (BS 7671), labels are pasted in from single-shot by circuit number, and any slot with confidence < 0.7 (or `classification: "unknown"`) falls back to the single-shot value at that position.
5. **Post-processing** — `applyBsEnFallback`, `normaliseCircuitLabels`, `lookupMissingRcdTypes` (web-search for RCD waveform type via `gpt-5-search-api` when Stage 3 missed it and the board manufacturer is known), main-switch default fills.
6. **Response shape** includes `circuits[]` (primary), `slots[]` (per-slot classifications + base64 crops for iOS tap-to-correct UI), `geometric` (panel/rail geometry), `extraction_source: "geometric-merged" | "single-shot"`, plus the pre-existing fields.

| Pipeline Step | Model | Cost |
|---|---|---|
| Classifier | `claude-sonnet-4-6` | ~$0.01 |
| Geometric Stage 1 (rails/panel) | `claude-sonnet-4-6` ×3 | ~$0.02 |
| Geometric Stage 2 (count) | `claude-sonnet-4-6` | ~$0.01 |
| Geometric Stage 3 (classify N slots) | `claude-sonnet-4-6` ×ceil(N/4) | ~$0.02-0.03 |
| Single-shot prompt | `claude-sonnet-4-6` | ~$0.03 |
| **Total per extraction** | | **~$0.08–0.09** |

**Kill switch**: `CCU_GEOMETRIC_V1=false` on the task-def disables the per-slot path entirely — single-shot runs alone (pre-sprint behaviour). Default (env var unset or set to anything other than `false`) is **ON**. Flip the flag at the task-def to roll back without redeploying.

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
