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

## Stage 6 Agentic Extraction (live recording path)

Live recording flows through the Stage 6 agentic extraction pipeline. `config/field_schema.json` is the single source of truth for every extractable field; the tool schemas (`src/extraction/stage6-tool-schemas.js`) generate `record_reading.field` / `record_board_reading.field` enums from it at module load.

Sonnet's `ask_user` tool carries an OPTIONAL `pending_write` property. When the inspector says a value without enough context (e.g. "Number of points is 4" with no circuit), Sonnet attaches the buffered write to its ask. The server then:

1. Holds the user's reply.
2. Runs the deterministic answer resolver (`src/extraction/stage6-answer-resolver.js`) against the pending write + available circuits.
3. **High-confidence match** → server auto-emits the write through the normal write path (`createAutoResolveWriteHook` in `src/extraction/stage6-dispatchers.js`). Tool result body: `match_status: "auto_resolved", resolved_writes: [...]`. Sonnet doesn't write again.
4. **Low-confidence / ambiguous** → tool result echoes back `pending_write` + `available_circuits` + `parsed_hint`. Sonnet writes itself in the next turn.

iOS apply parity is enforced by `scripts/check-ios-field-parity.mjs`, which walks `field_schema.json` and asserts every entry has a matching `case` in `applySonnetReadings`. CI exit-1 on drift.

Shared value-rule semantics live in `src/extraction/value-normalise.js` (`acceptsAsWrite`, `isValidSentinel`, `isEvasionMarker`). iOS mirrors the gate; tests pin equivalence so "N/A" is treated identically on both sides.

Full design rationale: [ADR-008](../adr/008-schema-driven-tools-and-server-resolved-asks.md).

## CCU Photo Extraction Pipeline

`POST /api/analyze-ccu` (route: `src/routes/extraction.js`) runs a per-slot crop-and-classify VLM pipeline. The single-shot Sonnet prompt that previously ran in parallel as a "second opinion" was retired 2026-04-29 — its only unique outputs were the five board-level metadata fields, all of which now come from the (extended) classifier.

Sequence:

1. **Board classifier (Stage 1, board-level metadata)** — one VLM call (`claude-sonnet-4-6`, ~400 max tokens, ~5 s). Returns `{board_technology, main_switch_position, board_manufacturer, board_model, main_switch_rating, spd_present, confidence}`. Cost: ~$0.01. Source: `classifyBoardTechnology` in `src/routes/extraction.js`. Extending this prompt to cover board-level metadata replaced the 46 s single-shot call without adding a new round-trip.
2. **Geometric pipeline** — three-stage per-slot extraction, dispatched on `board_technology`:
   - **Modern** (MCB/RCBO boards): `src/extraction/ccu-geometric.js`. Stage 1 finds the DIN-rail bbox (uses iOS `railRoiHint` if provided, else 3 parallel VLM samples → median). Stage 2 chunks the bbox into modules using CV-based pitch detection (Sobel-X + autocorrelation; `src/extraction/ccu-cv-pitch.js`); falls back to the 44.5 mm DIN-43880 face-height anchor if the CV peak is low confidence. The Stage 2 prompt now returns only the rail bbox (`{rail_bbox: {…}}`) — `main_switch_width`/`main_switch_center_x` were dropped 2026-04-29 because CV pitch is more reliable than the VLM's main-switch estimate. Stage 3 crops each slot and classifies (`mcb|rcbo|rcd|main_switch|spd|blank|unknown`) in batches of 4 crops per VLM call.
   - **Rewireable fuse** (BS 3036): `src/extraction/ccu-geometric-rewireable.js`. Stage 1 finds the carrier-bank panel bbox (no DIN rail); Stage 2 counts the carrier slots within that bank; Stage 3 classifies each crop as `rewireable|cartridge|blank`, reads the carrier body colour, and applies the BS 3036 colour code (white=5A, blue=15A, yellow=20A, red=30A, green=45A).
   - **Cartridge fuse / mixed** — routed to the rewireable pipeline; Stage 3 tags BS 1361 / BS 88-2 carriers as `cartridge` and reads the printed rating directly.
3. **Stage 4 label pass** — `extractSlotLabels` (`src/extraction/ccu-label-pass.js`) crops a wider Y-band around each slot and reads the strip / sticker / handwritten label by VLM. Runs in parallel with Stage 3 via `Promise.all`. The merger filters `main_switch`/`spd`/`blank` out of `circuits[]` so labels read on those positions never surface.
4. **Merge** — `slotsToCircuits` in `extraction.js` builds `circuits[]` from Stage 3 classifications + Stage 4 labels. Circuit 1 is nearest the main switch (BS 7671); side comes from (1) Stage 3's `main_switch` slot index, (2) rewireable Stage 2's `mainSwitchOffset` for inline-mains boards, (3) Stage 1 classifier's `main_switch_position`. SPD presence is derived from Stage 3 (any slot classified `spd`); the classifier's `spd_present` is a pre-merger fallback only.
5. **Post-merge enrichment** — `applyBsEnFallback`, `normaliseCircuitLabels`, `lookupMissingRcdTypes` (web-search for RCD waveform type via `gpt-5-search-api` when Stage 3 missed it and the board manufacturer is known); main-switch BS-EN/poles/voltage defaults; SPD-from-main-switch fallback for the supply-characteristics block.
6. **Response shape** — `circuits[]` (primary), `slots[]` (per-slot classifications + base64 crops for iOS tap-to-correct UI), `geometric` (panel/rail geometry, pitch source, CV diagnostics), `board_classification` (mirror of classifier output), `extraction_source: "geometric-merged" | "classifier-only"` (the latter only when Stage 3/4 produced no slots[]), plus the pre-existing top-level fields.

| Pipeline Step | Model | Wall-clock | Cost |
|---|---|---|---|
| Classifier (board metadata) | `claude-sonnet-4-6` | ~5 s | ~$0.01 |
| Geometric Stage 1 (rails/panel) | `claude-sonnet-4-6` ×3 | parallel ~3 s | ~$0.02 |
| Geometric Stage 2 (rail bbox) | `claude-sonnet-4-6` | ~3 s | ~$0.01 |
| Geometric Stage 3 (classify N slots) | `claude-sonnet-4-6` ×ceil(N/4) | ~10–15 s | ~$0.02 |
| Stage 4 label pass | `claude-sonnet-4-6` | ~20 s (long pole) | ~$0.01 |
| **Total per extraction** | | **~21 s** | **~$0.04** |

Compare with pre-2026-04-29 totals (~47 s, ~$0.10) — the saving comes entirely from removing single-shot, which was the wall-clock long pole running in parallel with the per-slot pipeline.

**Failure mode**: classifier or `prepareGeometry` failure now returns 502 (no single-shot safety net). Stage 3 / Stage 4 failures are non-fatal — `extraction_source: "classifier-only"` is shipped with empty `circuits[]` plus the board metadata.

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
