---
name: certmate-ccu-pipeline
description: >
  Deep reference for the CCU (consumer-unit) photo extraction pipeline behind
  POST /api/analyze-ccu. Load this when: debugging a wrong/missing circuit from a
  board photo (mis-count in identical-MCB runs, label on the wrong MCB, wrong
  rcd_type/rcd_protected, phantom "Spare"), reasoning about retake_required /
  HTTP 422 / 409 idempotency responses, tuning any CCU_* env var, running the
  local CCU harnesses or the ccu-cv-corpus, or changing anything in
  src/extraction/ccu-*.js or the /analyze-ccu route. Do NOT load for voice
  extraction (certmate-voice-wire-protocol), document/certificate photo
  extraction (/api/analyze-document is a different route), or general deploy
  questions (certmate-run-and-operate).
---

# CertMate CCU Photo Extraction Pipeline

All paths repo-relative to the EICR_Automation repo root. All line numbers and prod values verified 2026-07-06; re-verify per the Provenance section before trusting after a refactor.

**Definitions (used throughout):**
- **CCU** — consumer unit (UK fuseboard). **DIN rail** — the horizontal mounting rail the devices clip to. **Module slot** — one standard device-width position on the rail; a 2-pole device occupies 2 slots.
- **VLM** — vision language model (gpt-5.5 or Claude Sonnet with an image input).
- **Pitch** — the pixel width of one module slot; **CV pitch** = pitch estimated locally by computer vision (Sobel-X + autocorrelation, `src/extraction/ccu-cv-pitch.js`), no API call.
- **Dewarp** — perspective-rectifying the rail quadrilateral into a flat strip before the VLM sees it (`src/extraction/ccu-rail-dewarp.js`).
- **MCB/RCBO/RCD/SPD** — breaker / combined breaker+RCD / residual-current device / surge protection device. **BS 3036 rewireable** — old fuse-wire carriers, colour-coded (white=5A, blue=15A, yellow=20A, red=30A, green=45A).

## 1. Which pipeline is live (as of 2026-07-06)

**LIVE = single-shot gpt-5.5 over the whole (cropped, dewarped) rail image.** No per-slot cropping in the live path.

- Gate: `CCU_USE_SINGLE_SHOT` — read at `src/routes/extraction.js:2191`, **code default `false`**, **prod task-def value `true`** (`ecs/task-def-backend.json`, alongside `CCU_SLIDING_WINDOW=true` and `CCU_SLIDING_WINDOW_MODEL=gpt-5.5`). When both sliding-window and single-shot flags are true, single-shot wins (`extractFn = useSingleShot ? extractViaSingleShot : extractViaSlidingWindow`, extraction.js:2288).
- The VLM model comes from `CCU_SLIDING_WINDOW_MODEL` (one var covers both pipelines); a `gpt-*` name routes through `src/extraction/openai-vision-adapter.js` (OpenAI client wrapped in an Anthropic-shaped adapter). Prod: `gpt-5.5`.
- **The legacy per-slot pipeline activates TWO ways** (this is broader than the hub's summary):
  1. Config: `CCU_USE_SINGLE_SHOT=false` (and `CCU_SLIDING_WINDOW=false`).
  2. **Runtime fallback**: any thrown error inside `extractViaSingleShot` (VLM timeout, JSON parse, network) is caught at extraction.js:2318 — logged as "CCU sliding-window extraction failed (falling back to per-slot)" — and the request re-runs through the legacy per-slot classify+label path for that one request. So a per-slot-shaped result in prod logs does NOT prove the env flag changed; check for that warn line first.

When reasoning about live failures, do NOT consider CV slot-crop accuracy or crop-boundary alignment — per-slot crops are not in the live path (hub CLAUDE.md "Current Focus", verbatim scope).

## 2. Live pipeline stage by stage

Route: `POST /api/analyze-ccu` — `src/routes/extraction.js:1805-3051`. Middleware order: `auth.requireAuth` → `upload.single('photo')` (multer) → `withIdempotency('ccu')`.

| # | Stage | Where | Model / cost | Notes |
|---|-------|-------|--------------|-------|
| 0 | Upload guards + hints | extraction.js:1815-1890 | — | 413 if > `CCU_MAX_UPLOAD_BYTES` (default 20 MB). Optional multipart fields: `rail_roi` (normalised 0-1 ROI from the iOS camera overlay — becomes the Stage-1 rail bbox, skipping VLM rail detection, saving ~$0.03/~17 s; malformed JSON silently ignored), `board_id`/`board_index` (multi-board attribution, echoed back in `analysis.attribution`), `sessionId` (keys S3 sidecars). |
| 0b | Two image buffers | extraction.js:1893-1949 | — | `apiBytes` = downsized (≤ ~3.7 MB raw; else sharp resize 2048×2048 fit-inside q80) for whole-image calls; `originalBytes` = full-quality source, fed to single-shot so crops keep text legibility. |
| 1 | Board classifier | `classifyBoardTechnology`, extraction.js:1393 | `CCU_MODEL` (default `claude-sonnet-4-6`), max_tokens 400, ~5 s, ~$0.01 | Returns `{board_technology: modern\|rewireable_fuse\|cartridge_fuse\|mixed, main_switch_position, board_manufacturer, board_model, main_switch_rating, spd_present, confidence}`. Model-prefix override: a recognised modern `board_model` (e.g. Wylex NHRS12SL) forces `modern` even if the fuzzy label said `mixed` (2026-05-01 mis-route fix). Classifier failure = 500-class error; no pipeline possible. |
| 2 | Geometric prep (CV) | extraction.js:2050-2128 | local CV + at most 1 Sonnet call | Fallback chain for modern boards with a `rail_roi` hint: `tightenAndChunkQuad` (`ccu-rail-quad.js`, perspective quad; gated `CCU_QUAD_GEOMETRY`, default true) → on error `tightenAndChunk` (`ccu-box-tighten.js`, axis-aligned; gated `CCU_BOX_TIGHTEN`, default true) → on error `prepareModernGeometry` (`ccu-geometric.js`, VLM rail detection). `rewireable_fuse`/`cartridge_fuse`/`mixed` → `prepareRewireableGeometry` (`ccu-geometric-rewireable.js`). Any prepare failure ⇒ **HTTP 502** "Could not detect device row in photo". Produces railQuad/railBbox, slotCentersX, CV pitch + `moduleCountFromCv`. |
| 3 | Single-shot enumeration | `extractViaSingleShot`, `src/extraction/ccu-single-shot.js:1016` | gpt-5.5, max_tokens `CCU_SINGLE_SHOT_MAX_TOKENS` (4096), timeout `CCU_SINGLE_SHOT_TIMEOUT_MS` (90 s), ~15-20 s | See §3. |
| 4 | Merge | `slotsToCircuits`, extraction.js:1563 | — | See §4. `mainSwitchSide` resolved first by `src/extraction/main-switch-resolver.js` (priority: Stage-3 `main_switch` slot cluster → rewireable `mainSwitchOffset` → Stage-1 classifier position; handles the 2026-05-08 Protek false-positive cluster by preferring the cluster whose label reads "Main Switch"/"Isolator"). |
| 5 | Post-merge enrichment | extraction.js:2606-2722 | table lookups + conditional `gpt-5-search-api` | See §5. |
| 6 | Quality gate | `evaluateQualityGate`, `src/extraction/ccu-quality-gate.js` | — | Fail ⇒ **HTTP 422 `{status:'retake_required', reason, message, diagnostic}`**. See §6. |
| 7 | Respond + sidecars | extraction.js:2861-2984 | — | `res.json(analysis)`, then fire-and-forget: training-data log to S3 (`logCcuTrainingData`; also logged on retake with `retakeRejection:true` — bad photos are training gold) and a geometric sidecar at `s3://…/ccu-geometric/{userId}/{sessionId}/{extractionId}/stage-outputs.json` (slot base64 stripped, bboxes kept). |

Error mapping in the route catch (extraction.js:2985-3040): timeout/abort → 504 `extraction_timeout` (route-level budget `CCU_EXTRACTION_TIMEOUT_MS`, default 180 s); `SyntaxError` → 502 `extraction_parse_error`; upstream 429 → 429 `rate_limited`; all retryable flags set accordingly.

## 3. Single-shot internals (`src/extraction/ccu-single-shot.js`)

1. **Crop/dewarp** (`cropToRailRegion`, :300): if modern + `railQuad` present + `CCU_DEWARP_ENABLED` (default true) → `dewarpRailQuad` with margins 200% rail-height above AND below (captures label strips + handwritten flaps), 10% horizontal; output width = `CCU_DEWARP_OUTPUT_WIDTH` → **code default 2048 fixed**. Dewarp error falls through to an axis-aligned bbox crop (5% x-margin, 200% y-margins, q92 re-encode); missing/degenerate bbox falls back to the full image. Rewireable boards never dewarp (panelBounds is axis-aligned).
   - **The 2048 default is the survivor of a documented saga** (full history in the file header, :56-118): 2048 → native (commit `10aabca4` 2026-05-13, "more px = better OCR"; the dewarp itself landed 2026-05-12 in `9fb0bd76`) → native regressed gpt-5.5 COUNTING on Wylex NHRS12SL (whole circuits dropped) → live env-var hotfix 2026-05-13 → hotfix silently lost to task-def env drift 2026-05-14 → same board failed again 2026-05-22 → default moved INTO CODE (`01c081e5`). Best theory: at ~5900 px the rail spans too many vision tiles and edge modules drop; at 2048 whole-rail attention holds and text stays legible. Do not flip to `native` in prod without re-running counting accuracy on the corpus.
2. **One VLM call** with `MODERN_PROMPT` (:149) or `REWIREABLE_PROMPT` (:223). Prompt contract: one entry per module slot, strict left-to-right; 2-pole devices = two identical entries; blanks are entries (`device_kind:"blank"`); an explicit toggle-counting procedure for runs of identical MCBs, with the rule *"if unsure between N and N+1 … prefer N+1"* (a phantom slot is recoverable, a missed slot is not); labels returned as a SEPARATE `labels[]` array with `position_x` 0-1 — the prompt explicitly forbids the model from assigning labels to devices itself.
3. **CV cross-check** (:1060-1064): `lowConfidence = (moduleCountFromCv !== entries.length)`. This is telemetry + a confidence dampener, NOT a gate — the VLM↔CV count-agreement retake gate was **dropped 2026-05-14** (`fb8cdccd`) because CV under-counts on non-standard rails (ADRBs, SPDs, multi-pole devices break the periodic signature) and was rejecting clean photos 3 retakes in a row.
4. **Position-based label matcher** (:1079, gated `CCU_VLM_POSITION_MATCHER`, default true, since 2026-05-21): code does the label↔device assignment from the reported `position_x` values. Failure mode it fixes: gpt-5.5 perceives positions reliably (±0.006 across runs) but sticks labels on the wrong ADJACENT MCB when asked to assign them itself. Algorithm selected by `CCU_LABEL_MATCHER_ALGORITHM` (`monotonic` default \| `nearest`), tunables `CCU_LABEL_MATCHER_{LABEL_SKIP,DEVICE_SKIP,MAX_MATCH}_FACTOR` (1.0 / 0.5 / 0.7 × pitch). Raw VLM arrays are preserved in the response (`vlm_labels_raw`, `vlm_entries_raw`, `vlm_label_matcher_diag`) so a matcher change can be replayed offline **without re-billing the VLM** — use this before touching matcher code.
5. **`entriesToSlots`** (:912): slot confidence is a flat baseline — **0.92 if VLM count == CV count, else 0.65**. This matters downstream: 0.65 < `minSlotConfidence` 0.7 in `slotsToCircuits`, so a count-disagreeing run emits every circuit `low_confidence:true`. Rewireable rating back-fills from carrier `body_colour` when the VLM left `ocpd_rating_a` null. `device_code` (printed part number, e.g. Crabtree "61/RB16/30AC") is kept — it is the highest-precision key for the RCD datasheet lookup.

## 4. Merge: `slotsToCircuits` (extraction.js:1563) — the "phase-walking" rules

Scan order = left-to-right, reversed when `mainSwitchSide === 'right'`, so **circuit 1 is always adjacent to the main switch** (BS 7671 numbering).

Walk rules (Derek's 2026-05-21 ruleset, verbatim in the code comment):
- `main_switch` / `spd` slots: never emitted as circuits; do not affect RCD attribution.
- `rcd` slots: never emitted; each new RCD **replaces** the "upstream RCD" reference (split-load boards: MCBs after bank 2 get bank 2's type/mA, between banks get bank 1's). Adjacent `rcd` slots are one physical 2-module device — the pair gap-fills nulls into one reference.
- `mcb`/`rcbo`/etc.: `rcd_protected = is_rcbo OR an RCD was seen EARLIER in scan order`. **No look-ahead.** The old "blank-as-phase-boundary + any-RCD-anywhere" heuristic was pulled 2026-05-21: it marked sub-feed MCBs sitting BETWEEN the main switch and the first RCD (Crabtree Starbreaker topology) as RCD-protected — a silent wrong cert. Accepted trade-off: the rare far-end-RCD topology now emits false-NEGATIVE `rcd_protected`, which the inspector can correct on the grid; false positives cannot be seen.
- Blanks emit label "Spare", `rcd_protected:false` always ("spares stay unprotected").
- `content:'partial'` slots (VLM saw half a device) are forced `low_confidence:true` + `is_partial_crop` — a half-RCD pattern-matches to "B32 MCB" with high confidence, so never trust it. **No board-majority guessing on partials** — removed `aa529115` 2026-05-05: *blank > guessed wrong*, because UK boards genuinely mix B/C curves and AC/A waveforms.
- BS-EN defaults per device class in `buildCircuitFromSlot` (:1755): RCBO→BS EN 61009, MCB→BS EN 60898 (+6 kA breaking capacity), rewireable→BS 3036 (`Rew`, no kA), cartridge→BS 1361 (`HRC`); upstream-RCD reference→BS EN 61008.

If the merger returns circuits, `extraction_source = 'geometric-merged'` and `applyBsEnFallback` + `normaliseCircuitLabels` run (extraction.js:301/:401 — local table normalisation, no API). SPD presence: any slot classified `spd` overrides the classifier's board-level guess in BOTH directions when slots exist (extraction.js:2580-2583).

## 5. Post-merge enrichment (extraction.js:2606-2722)

Order matters:
1. **`applyRcdTypeLookup`** (`src/extraction/rcd-type-lookup.js` + `config/rcd-type-lookup.json`) — (manufacturer, model) table. Confidence policy: `high` overrides every RCD-protected circuit's `rcd_type` (the sub-mm waveform glyph read is less reliable than a known datasheet); `medium` = default, a ≥0.95-confidence slot read wins; `low` = fill nulls only. Non-hits write a fire-and-forget "pending sighting" to S3 (`writeRcdPendingEntry`) so the table can be grown by a review CLI.
2. **`lookupMissingRcdTypes`** (extraction.js:488) — `gpt-5-search-api` web search, **fill-nulls-only**. Fires only when: ≥1 RCD-protected circuit has `rcd_type:null` AND `board_manufacturer` non-empty AND `board_model` non-empty (manufacturer-only searches return generic catalogue guesses — worse than nulls). Prompt demands an EXACT board-model or device-part-code datasheet hit (`match_kind` guard) and never overrides an existing read.
   - **⚠ The `uniform_low_conf` over-fire is FIXED, not open.** The `uniform_low_conf` trigger (override all same-value RCD reads when avg confidence < 0.85 via manufacturer-only search) was **REMOVED 2026-05-21** after it clobbered visually-correct AC reads to A on every Crabtree Starbreaker in a field test (code comment extraction.js:458-487). `docs/reference/architecture.md` §CCU step 5 still describes it as live-and-over-firing — that sentence is STALE; trust the code.
3. **`flagRcdWaveformOutliers`** (extraction.js:826) — detects one slot disagreeing with a same-manufacturer confident cluster (cluster floor 5, confidence floor 0.85), verifies against a datasheet search, then **flags only** (`low_confidence`, `rcd_type_outlier`, inspector question) — never auto-corrects. Load-bearing assumption: a genuine retrofit oddball is usually a different manufacturer, so it lands in its own tiny cluster below the floor.
4. **Main-switch defaults**: BS-EN `60947-3`, poles `DP`, voltage `230` filled when null (99%-of-UK-domestic defaults).
5. **No SPD-from-main-switch fallback.** Removed 2026-06-17 (Option A, comment extraction.js:2724-2731): `spd_*` fields are the DNO supply cutout / main fuse — a different physical device — and must never be derived from the CU main switch. (architecture.md step 5 also still lists this fallback: STALE.)

Steps 2-3 are skipped entirely when `OPENAI_API_KEY` is unset (dev/sandbox).

## 6. Quality gate, 422 retake, idempotency

**Quality gate** (`src/extraction/ccu-quality-gate.js`, pure function; design intent verbatim: *"never return wrong data silently"*). Hard signals only:

| Reason | Trigger | Threshold |
|---|---|---|
| `classifier_low_confidence` | Stage-1 confidence | < 0.85 (clean photos run 0.92-0.97) |
| `poor_quad_fit` | rectNormCorr from quad refinement | < 0.20 (good photos 0.35-0.55) |
| `too_many_nulls` | fraction of MCB/RCBO circuits with null rating | > 0.5 |

Fail ⇒ `422 {status:'retake_required', reason, message, diagnostic}`. Clients treat 422 as **terminal**: drop the queued photo, show a retake card, never auto-retry the same bytes (web: `web/src/lib/ccu/pending-extraction-queue.ts`; iOS canon `CCUExtractionViewModel.swift:464-470` in the separate CertMateUnified repo).

**Idempotency** (`src/middleware/idempotency.js`, `withIdempotency('ccu')`): client mints ONE UUID per capture and sends it as `X-Idempotency-Key` on the first attempt AND every retry. Redis key `idem:ccu:{userId}:{key}`, SET NX. Semantics:
- in-flight duplicate → **409 + `Retry-After: 5`** (wait, re-poll SAME key — never mint a new one);
- completed duplicate within 600 s → 200 cached body + `X-Idempotency-Replay: 1`;
- non-2xx → key deleted so the next retry re-attempts;
- missing header or Redis down → transparent no-op (older iOS builds).
Why it exists: iOS retry storms once fired the ~$0.07 pipeline 3-6× per single capture (2026-04-29 logs). Web queue additionally persists the photo Blob + key to IDB BEFORE upload (`pending-ccu-extraction` store, `certmate-cache` v5) so crash/offline loses nothing; retryable failures (network/5xx/429) stay queued with auto-retry on `online`.

## 7. Tuning env vars (all read in `src/` — complete list as of 2026-07-06)

Prod task-def (`ecs/task-def-backend.json`) sets ONLY: `CCU_STAGE2_GROUPS=true` (**dead** — no `src/` reference since `83e337e6` retired the Stage-2 path 2026-04-29; harmless), `CCU_SLIDING_WINDOW=true`, `CCU_SLIDING_WINDOW_MODEL=gpt-5.5`, `CCU_USE_SINGLE_SHOT=true`. Everything else runs on code defaults. Remember the MANDATORY rule: env changes go in the source task-def + commit, never live-only (`scripts/check-task-def-env-drift.sh` gates CI; this pipeline's dewarp width is the incident that created that rule).

| Var | Default (code) | Purpose |
|---|---|---|
| `CCU_USE_SINGLE_SHOT` | false (prod: true) | Live-path selector (§1) |
| `CCU_SLIDING_WINDOW` / `_MODEL` / `_TIMEOUT_MS` | false / `CCU_MODEL` / — | Legacy sliding-window; `_MODEL` also names the single-shot model |
| `CCU_MODEL` | `claude-sonnet-4-6` | Classifier + legacy per-slot model |
| `CCU_SINGLE_SHOT_TIMEOUT_MS` / `_MAX_TOKENS` | 90000 / 4096 | Single-shot VLM call budget |
| `CCU_DEWARP_ENABLED` | true | Dewarp kill-switch |
| `CCU_DEWARP_OUTPUT_WIDTH` | **2048 (in code — do not move back to env-only)** | `N` px, or `native` (OCR experiments only) |
| `CCU_DEWARP_MAX_WIDTH` | unset | Cost brake, native mode only |
| `CCU_VLM_POSITION_MATCHER` | true | false = trust VLM's own label assignment (rollback) |
| `CCU_LABEL_MATCHER_ALGORITHM` + 3 `_FACTOR` vars | `monotonic`; 1.0/0.5/0.7 | Label↔device matcher tuning |
| `CCU_QUAD_GEOMETRY` / `CCU_BOX_TIGHTEN` / `CCU_PROBE_V2` / `CCU_CV_PITCH` | true / true / true / (see ccu-cv-pitch.js) | Geometry-prep chain kill-switches |
| `CCU_GEOMETRIC_MODEL` / `_TIMEOUT_MS`, `CCU_LABEL_MODEL` / `_TIMEOUT_MS` / `_CONFIDENCE_MIN`, `CCU_REWIREABLE_MODEL` | sonnet-4-6 / 60 s ladder | Legacy per-slot path only |
| `CCU_EXTRACTION_TIMEOUT_MS` | 180000 | Route-level 504 budget |
| `CCU_MAX_UPLOAD_BYTES` | 20 MB | 413 guard |

## 8. Cost / latency (as of 2026-07-06)

Per `docs/reference/architecture.md` table + code headers: classifier ~5 s/~$0.01 · geometric prep ~3 s/~$0.01 · single-shot ~15-20 s/~$0.03-0.04 · conditional RCD search ~4 s/~$0.005 → **total ~25-30 s, ~$0.05-0.06 per extraction** (idempotency header says ~$0.07 — same ballpark). Benchmark that justified single-shot (module header, Wylex NHRS12SL 16-module field test 2026-05-07): sliding-window Sonnet 25 slots (wrong) / SW gpt-5.5 18 (wrong) / **single-shot gpt-5.5 16 (exact), 7.3 s VLM, $0.04**.

## 9. Local harnesses + corpus

- **Corpus**: `scripts/ccu-cv-corpus/` — `raw/` 52 photo dirs, `manifest.json` (48 entries / 32 unique photos, sha-deduped), `annotations.json` (ground-truth total slot counts; RCD=2, main switch=2, blanks=1 each; entries carry recount notes + `verifiedBy`). `build-manifest.mjs` regenerates.
- `node scripts/ccu-local-run.mjs <photo.jpg> [--roi=x,y,w,h] [--dump-crops=DIR] [--dump-overlay=f.jpg]` (needs `ANTHROPIC_API_KEY`) — end-to-end offline run, no HTTP/S3/DB. **⚠ Mirrors the LEGACY per-slot path only; its header ("single-shot was retired 2026-04-29; per-slot is the only path") predates the gpt-5.5 single-shot re-adoption and is stale. There is no committed harness that drives `extractViaSingleShot` off-route** — for live-path experiments either replay the saved `vlm_entries_raw`/`vlm_labels_raw` arrays from a prod response/sidecar (free), or write a throwaway driver importing `extractViaSingleShot`.
- `node scripts/ccu-cv-prototype.mjs [--id <extractionId>] [--stress]` — pure-CV pitch/count on the corpus, no API, ~50-100 ms/photo.
- `node scripts/ccu-box-tighten.mjs` — rail-bbox tightener in isolation.
- `node scripts/ccu-extract-via-tightener.mjs [--id X] [--classify]` — tightener → crops → optional Stage-3 classify (billed when `--classify`).
- Unit/integration tests: 13 `src/__tests__/ccu-*.test.js` files (merger, quality gate, label matcher, dewarp, quad, rcd lookup…). `npm test -- ccu` runs them.

## 10. Doctrine + thrash history (why the pipeline is shaped this way)

The CCU pipeline is the repo's highest-churn experimental zone (geometric → per-slot → sliding-window → single-shot in ~3 weeks). Full incident timeline lives in **certmate-failure-archaeology** — do not re-derive it; the operative doctrine is:

1. **Blank beats guessed wrong.** Never fill a device field by board-majority, manufacturer-generic search, or "probably the same as its neighbours". Every such mechanism that shipped was reverted after field evidence (`aa529115` board-majority; `uniform_low_conf` override). A null cell gets fixed by the inspector; a plausible wrong value on a safety certificate does not.
2. **Never return wrong data silently** — quality gate 422s instead (§6); low-confidence rows are marked, not dropped.
3. **Fill vs override is an explicit, per-source policy** (lookup-table confidence tiers; search = fill-only; outlier pass = flag-only).
4. **Document failed experiments in the tree** so they aren't re-run: EDGE_SEARCH_PAD widening (`0dadcbbd`, pad stays 0.03 in `ccu-rail-quad.js:73`), native dewarp width (header of ccu-single-shot.js), VLM↔CV count gate (`fb8cdccd` + ccu-quality-gate.js header), dewarp-margin 15% + undercount-retake gate (both reverted same day 2026-05-22: `fc2c8489`, `b98078ed`), phase-lock (added `03563576` → reverted `fc1602a5` → re-instated with bounded ±12% window `7f8ec5af`, all 2026-05-05).
5. **Prefer over-count to under-count at the VLM** (prompt's N+1 rule) — phantoms are visible and deletable; missing circuits are invisible.
6. **Keep raw VLM output in the response/sidecars** so matcher/merger changes replay offline without re-billing.
7. **Kill-switch every risky sub-stage** (dewarp, quad, box-tighten, position matcher, probe V2) — an algorithm regression must never block extraction in production; each falls through to the previous generation.

**In-scope live failure modes** (hub CLAUDE.md, verbatim): gpt-5.5 mis-counts in long identical-MCB runs; label-column mis-alignment; post-merge enrichment overrides; `slotsToCircuits` phase-walking heuristics. **Not in scope**: CV crop accuracy / slot-crop boundaries.

**Open items** (as of 2026-07-06, candidates not commitments): CCU training-loop review UI; box-tighten V2 Hager regression; Stage-1 VLM out-of-range coords on small images.

## 11. Known-stale docs (do not propagate)

| Claim | Where | Reality |
|---|---|---|
| `uniform_low_conf` trigger live and over-firing | `docs/reference/architecture.md` §CCU step 5 | Removed 2026-05-21 (extraction.js:458-487) |
| SPD-from-main-switch fallback | same | Removed 2026-06-17 (extraction.js:2724) |
| Single-shot failure → `classifier-only` | architecture.md "Failure mode" | Falls back to per-slot first (extraction.js:2318-2351); `classifier-only` only if that also yields nothing |
| Prompt "enforces same-vertical-column label alignment / tie-break null" | architecture.md step 3 | Superseded 2026-05-21 by the position matcher — the prompt now forbids VLM-side label assignment |
| "per-slot is the only path" | `scripts/ccu-local-run.mjs` header | Single-shot is live; harness covers legacy only |

If you touch the pipeline, fixing the matching architecture.md lines is part of the change (hub MANDATORY docs rule).

## When NOT to use this skill

- Voice/dictation extraction, `/api/sonnet-stream`, read-backs → **certmate-voice-wire-protocol** (protocol) or **certmate-latency-campaign** (latency).
- A CCU symptom you can't yet localise (is it even this pipeline?) → **certmate-debugging-playbook** first.
- The full incident chronicle behind §10 → **certmate-failure-archaeology**.
- Env-var mechanics, drift guard, how to add a var → **certmate-config-and-flags**.
- Deploying a CCU change / tailing prod logs → **certmate-run-and-operate**.
- What Ze/Zs/BS EN numbers mean on the cert → **bs7671-domain-reference**.
- What counts as evidence before promoting a CCU tuning change → **certmate-validation-and-qa** / **certmate-research-methodology**.

## Provenance and maintenance

Verified 2026-07-06 against the working tree. One-liners to re-verify the drift-prone facts:

```bash
# Live-path gate + prod values
grep -n "CCU_USE_SINGLE_SHOT" src/routes/extraction.js ecs/task-def-backend.json
# Dewarp width default still 2048-in-code
grep -n "return 2048" src/extraction/ccu-single-shot.js
# uniform_low_conf still removed (expect only comments)
grep -rn "uniform_low_conf" src/ | grep -v __tests__
# Quality-gate thresholds
grep -n "classifierMinConfidence\|rectNormCorrMinHard\|ratingNullFractionMax" src/extraction/ccu-quality-gate.js
# Full CCU env-var inventory
grep -rho "process\.env\.CCU_[A-Z_]*" src/ | sort -u
# Idempotency semantics (409 / Retry-After / TTLs)
sed -n '1,45p' src/middleware/idempotency.js
# 422 retake payload shape
grep -n "retake_required" src/routes/extraction.js web/src/lib/ccu/pending-extraction-queue.ts
# Merger rules current?
sed -n '1563,1610p' src/routes/extraction.js
# Corpus size
python3 -c "import json;m=json.load(open('scripts/ccu-cv-corpus/manifest.json'));print(m['totalEntries'],m['uniquePhotos'])"
# Cost/latency table + stale-doc check
sed -n '131,155p' docs/reference/architecture.md
```
