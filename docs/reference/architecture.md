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
| PDF Generation | CLIENT-SIDE on both apps since 2026-07-02: iOS `EICRHTMLTemplate.swift`→WKWebView; web `web/src/lib/pdf/` (TS port of the iOS template + foreignObject capture + pdf-lib Blob). Server Python ReportLab + Playwright (Chromium) is FALLBACK/DEBUG-ONLY (web "Generate on server (fallback)" action; flips behind the debug page after field validation) |
| Cloud Storage | AWS S3 |
| Secrets | AWS Secrets Manager |

## Backend Container Architecture

The backend Docker container (`Dockerfile.backend`) includes:
- **Node.js 20** - Job processing pipeline
- **Python 3 + pip** - PDF generation scripts (fallback path only since 2026-07-02 — the web PWA renders certificates client-side)
- **Playwright + Chromium** - Browser-based PDF rendering (same fallback path)
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

### Pre-LLM transcript gate (`src/extraction/pre-llm-gate.js`)

Every iOS transcript runs through `shouldForwardToSonnet(text, opts)` before the Sonnet round + TTS cost commits. The gate is a sequential pass with bypass and forward reasons emitted as `voice_latency.gate_blocked` (block) / `voice_latency.gate_forwarded_complaint` (positive) for ops dashboards.

`GATE_REASONS` enum (full list): `EMPTY`, `HAS_DIGIT`, `HAS_OBSERVATION_PREFIX`, `HAS_STRONG_TRIGGER`, `HAS_WEAK_TRIGGER`, `HAS_TRIGGER` (legacy, retained for back-compat), `HAS_REGEX_HINT`, `HAS_COMPLAINT_OR_NEGATION`, `LOW_CONTENT`, `FALLBACK_FORWARD`, plus bypasses `BYPASS_PENDING_ASK`, `BYPASS_DIALOGUE_SCRIPT_ACTIVE`, `BYPASS_IN_RESPONSE_TO`, `BYPASS_DRAINED_RETRY`, `BYPASS_DISABLED`.

`HAS_COMPLAINT_OR_NEGATION` (PLAN-backend-final.md §5.1) runs BEFORE `HAS_DIGIT` so complaints that accidentally contain digits ("you set it to 0.45 but I said 0.55") log with intent reason. The regex deliberately requires a continuation pronoun after a bare "no" so "no problem" / "no signal" / "no spare" still block via `LOW_CONTENT`.

### Dialogue engine (`src/extraction/dialogue-engine/`)

Schemas: `rcd`, `ocpd`, `rcbo`, `ring_continuity`, `insulation_resistance`. Each is a script-style walk-through with entry triggers, per-slot prompts + parsers, defer / skip / cancel verbs, and a `toolCallIdPrefix` (`srv-rcd-` / `srv-ocpd-` / `srv-rcbo-` / `srv-irs-` / `srv-rcs-`).

Per-session state outside the transient `session.dialogueScriptState`:

- **`session.dialogueScriptDeferredSlots: Map<string, Set<string>>`** (Phase 6.2) — keyed by `${schemaName}:${circuit_ref ?? 'none'}`. Survives `clearScriptState` so a script re-entry doesn't re-ask a slot the inspector deferred earlier. Volunteered writes to a deferred slot ("the BS code is 60898" / "set BS number") clear the entry via the named-field-extraction loop. Plumbed through `nextMissingSlot(values, slots, skippedSet, deferredSet)`.
- **RCD entry guard** (Phase 6.1) — when transcript contains `\bRCD\b` AND a corrective imperative (delete/undo/cancel/fix/why/stop/remove/clear) OR a denial phrase (what are you / i didn't / that's wrong / that's not), the RCD schema's entry is skipped; the loop continues to other schemas, ultimately falling through to Sonnet. Scoped to RCD only — the other four schemas don't exhibit the re-entry loop pattern.
- **Cancel-drain WS frame** (Phase 6.3) — on any `*_script_cancelled`, the engine emits `{type:"cancel_pending_tts", prefix:"srv-{script}-", sessionId}` so iOS's AlertManager queue (slice 7.1) can purge in-flight script TTS in the same namespace.

## CCU Photo Extraction Pipeline

> ⚡ **CURRENT STATE (2026-05-08 onwards)** — `POST /api/analyze-ccu` runs a **whole-image single-shot `gpt-5.5`** call via `src/extraction/ccu-single-shot.js`. **No per-slot cropping is performed in the live pipeline.** The Stage 3 / Stage 4 per-slot Sonnet pipeline described in earlier versions of this doc is LEGACY FALLBACK, gated behind `CCU_USE_SINGLE_SHOT=false`. Production runs single-shot ON. When reasoning about CCU failures, do not consider CV crop accuracy or slot-crop boundary alignment — they are not in the live path.

Sequence (current pipeline):

1. **Board classifier (board-level metadata)** — one Sonnet VLM call (`claude-sonnet-4-6`, ~400 max tokens, ~5 s). Returns `{board_technology, main_switch_position, board_manufacturer, board_model, main_switch_rating, spd_present, confidence}`. Cost: ~$0.01. Source: `classifyBoardTechnology` in `src/routes/extraction.js`. Drives technology dispatch (modern vs rewireable prompt) and seeds the response with board-level fields the single-shot doesn't return directly.
2. **Geometric prep** — `prepareGeometry` finds the rail bbox + CV pitch (Sobel-X + autocorrelation; `src/extraction/ccu-cv-pitch.js`). The rail bbox crops the image down before single-shot sees it; the CV pitch + module count is kept for post-hoc cross-checks against the single-shot's slot count (logged on disagreement). The image is dewarped to a flat strip if `CCU_DEWARP_MAX_WIDTH` is set.
3. **Single-shot enumeration** — one OpenAI VLM call (`gpt-5.5` via `src/extraction/openai-vision-adapter.js`, ~4096 max tokens, ~15-20 s). Prompt: `MODERN_PROMPT` (DIN-rail boards) or `REWIREABLE_PROMPT` (BS 3036) in `src/extraction/ccu-single-shot.js`. The model receives the whole cropped rail image plus the prompt, and returns one entry per visible module slot in strict left-to-right order: `{device_kind, ocpd_rating_a, ocpd_curve, ocpd_bs_en, rcd_type, rcd_rating_ma, label}`. A 2-pole device returns two identical entries. Blanks return `device_kind:"blank"`. Labels are returned as a SEPARATE `labels[]` array with normalised `position_x` — the prompt forbids the model from assigning labels to devices itself; the code-side position matcher (`CCU_VLM_POSITION_MATCHER`, since 2026-05-21) does the label↔device assignment.
4. **Merge** — `slotsToCircuits` in `extraction.js` builds `circuits[]` from the single-shot entries: filters out `main_switch` / `spd` / `blank` so labels read on those positions never surface, and walks the slot order to attribute RCD-upstream relationships. Circuit 1 is nearest the main switch (BS 7671); side comes from (1) the single-shot's `main_switch` entry index, (2) rewireable `mainSwitchOffset`, (3) classifier's `main_switch_position`. SPD presence is derived from single-shot entries (any `device_kind:"spd"`); the classifier's `spd_present` is a pre-merger fallback only.
5. **Post-merge enrichment** — `applyBsEnFallback`, `normaliseCircuitLabels`, `lookupMissingRcdTypes` (web-search for RCD waveform type via `gpt-5-search-api`, fill-nulls-only, fires only when single-shot left it null AND both board manufacturer and model are known; the `uniform_low_conf` override trigger was REMOVED 2026-05-21 after clobbering correct AC reads on Crabtree Starbreakers); main-switch BS-EN/poles/voltage defaults. The SPD-from-main-switch supply fallback was removed 2026-06-17 — `spd_*` is the DNO cutout, a different physical device.
5b. **Quality gate** — `evaluateQualityGate` (`src/extraction/ccu-quality-gate.js`); fail ⇒ HTTP 422 `{status:'retake_required', reason, message, diagnostic}`. Hard signals: `poor_quad_fit` (rectNormCorr < 0.20), `too_many_nulls` (> 50% of OCPD circuits with unreadable rating — the OCPD filter understands both slot-shaped rows and live merged rows since 2026-07-08), and `classifier_low_confidence`. Since 2026-07-08 classifier confidence is a **soft** signal above a 0.65 hard floor: between 0.65 and 0.85 the gate passes anyway when the extraction corroborates itself (≥ 3 OCPD circuits, ≤ 50% null ratings). Rationale: Stage-1 confidence is a property of the board, not the photo (a Contactum board pinned 0.82 across three retakes with a perfect 13-circuit extraction), so a sub-0.85 score alone rejected every retake forever. Below 0.65 the gate still hard-fails regardless — the classifier may have routed the photo down the wrong prompt (modern vs rewireable). Deliberately NOT solved by improving board-model identification: model numbers have too much internal hardware variance to be a trustworthy signal.
6. **Response shape** — `circuits[]` (primary), `slots[]` (per-slot single-shot output reshaped for iOS LiveFillState consumption — crop bboxes are empty `{x:0,y:0,w:0,h:0}` and base64 is `""` because no per-slot crops exist), `geometric` (rail geometry + CV pitch diagnostics), `board_classification` (mirror of classifier output), `extraction_source: "geometric-merged"` (`"classifier-only"` only when single-shot produced no entries), plus the pre-existing top-level fields.

| Pipeline Step | Model | Wall-clock | Cost |
|---|---|---|---|
| Board classifier | `claude-sonnet-4-6` | ~5 s | ~$0.01 |
| Geometric prep (rail bbox + CV pitch) | local CV + 1 Sonnet call | ~3 s | ~$0.01 |
| Single-shot enumeration | `gpt-5.5` | ~15-20 s | ~$0.03-0.04 |
| Post-merge enrichment (RCD lookup, BS-EN, etc.) | `gpt-5-search-api` (conditional) | ~4 s when fired | ~$0.005 |
| **Total per extraction** | | **~25-30 s** | **~$0.05-0.06** |

**Failure mode**: classifier or `prepareGeometry` failure returns 502. Single-shot failure (timeout, JSON parse, validation) first re-runs the request through the legacy per-slot path (`extraction.js` catch, logged as "falling back to per-slot"); `extraction_source: "classifier-only"` with empty `circuits[]` only when that also yields nothing.

**Legacy per-slot pipeline (LEGACY FALLBACK ONLY)**: `src/extraction/ccu-geometric.js`, `src/extraction/ccu-geometric-rewireable.js`, `src/extraction/ccu-label-pass.js` still exist and can be activated by setting `CCU_USE_SINGLE_SHOT=false`. They run a 4-stage Sonnet pipeline (rail bbox → CV pitch → per-slot crop+classify in batches of 4 → wider per-slot label-zone crop). Pre-2026-05-08 the live pipeline; retained for emergency rollback if single-shot regresses. **Do not reason about its behaviour as a current failure mode unless the env override is confirmed set.**

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
