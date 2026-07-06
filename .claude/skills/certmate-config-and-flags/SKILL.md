---
name: certmate-config-and-flags
description: >
  Catalog of every configuration axis in CertMate/EICR_Automation: backend ECS
  task-def env vars (prod value + code default + classification), source-literal
  constants (CONFIRMATION_MIN_CONFIDENCE, FINALIZER_TIMEOUT_MS), the CCU_* tuning
  family, web NEXT_PUBLIC_* build-time inlining trap, the DEEPGRAM_STT_MODEL
  runtime kill-switch mechanics, and the how-to-add-an-env-var checklist routed
  through the drift guards. LOAD when: adding/changing/removing any env var or
  feature flag; asking "what does flag X do / what is its default / is it live in
  prod?"; flipping a kill-switch; a behaviour differs between local and prod
  (suspect a task-def-vs-code-default gap); a NEXT_PUBLIC_* flag "doesn't work" in
  prod. Do NOT load for: how to deploy (certmate-run-and-operate), env setup from
  scratch (certmate-build-and-env), why a flag's policy exists
  (certmate-architecture-contract), or CCU pipeline behaviour beyond its env vars
  (certmate-ccu-pipeline).
---

# CertMate Configuration & Flags Catalog

All facts verified against the repo as of 2026-07-06. Paths are relative to the
repo root `/Users/derekbeckley/Developer/EICR_Automation`.

**Definitions (used throughout):**
- **task-def env** — an entry in `ecs/task-def-backend.json` or
  `ecs/task-def-frontend.json` `environment[]`. These files are the SOURCE OF
  TRUTH; CI re-registers the live ECS task definition from them on every deploy,
  silently stripping anything set live out-of-band (CLAUDE.md MANDATORY
  "Infrastructure changes must come from source").
- **code default** — the fallback the backend uses when the env var is absent.
  Two patterns: `=== 'true'` → default **OFF**; `!== 'false'` → default **ON**.
- **source-literal constant** — a value hardcoded in a `.js` file; changing it
  requires a code commit + full CI deploy (~30 min), not a task-def flip.
- **NEXT_PUBLIC_\*** — web client flags inlined into the JS bundle at
  `next build` time. NOT changeable at runtime.
- **runtime flag** — read from `process.env` at request time. The web app has
  exactly ONE: `DEEPGRAM_STT_MODEL`.

## When NOT to use this skill

| You actually want | Load instead |
|---|---|
| Deploy/rollback/ECS status commands, CI job anatomy | `certmate-run-and-operate` |
| Recreate dev environment, Node pin, .env vs Secrets Manager setup | `certmate-build-and-env` |
| WHY a flag policy exists (Audio-First invariants, iOS-canon) | `certmate-architecture-contract` |
| CCU pipeline stages/failure modes (not just its env vars) | `certmate-ccu-pipeline` |
| Latency tuning campaign using these flags | `certmate-latency-campaign` |
| Change-control rules governing a flag change | `certmate-change-control` |
| Measuring the effect of a flag flip | `certmate-diagnostics-and-tooling` |

## 1. Backend task-def env vars (`ecs/task-def-backend.json`, 27 vars)

Classifications: **PROD** (load-bearing production value) · **SAFETY** (kill-switch,
normally inert) · **EXPERIMENTAL** (bench/rollout gate) · **LEGACY-DEAD** (no reader
in `src/` — safe-to-remove candidate, via source commit only).

### Infrastructure (7)

| Var | Prod value | Class | Notes |
|---|---|---|---|
| `S3_BUCKET` | `eicr-files-production` | PROD | |
| `DATABASE_TYPE` | `postgresql` | PROD | Creds come from Secrets Manager `eicr/database` |
| `AWS_REGION` | `eu-west-2` | PROD | |
| `PORT` | `3000` | PROD | |
| `USE_AWS_SECRETS` | `true` | PROD | `true` → all API keys loaded from Secrets Manager `eicr/api-keys` at boot; local dev uses `.env` with `false` |
| `NODE_ENV` / `STORAGE_TYPE` | `production` / `s3` | PROD | |
| `REDIS_URL` | `redis://eicr-redis-prod...:6379` | PROD | |

### Extraction models & Stage 6 (7)

"Stage 6" = the live server-side agentic tool-loop extraction over the
`/api/sonnet-stream` WebSocket.

| Var | Prod value | Code default (file:line) | Class |
|---|---|---|---|
| `SONNET_TOOL_CALLS` | `live` | `'live'` (`src/extraction/eicr-extraction-session.js:1164`) | PROD — agentic tool path |
| `SONNET_EXTRACT_MODEL` | `claude-haiku-4-5-20251001` | `'claude-sonnet-4-6'` (`eicr-extraction-session.js:1793,2469`) | PROD live extraction model. Prod runs Haiku 4.5 (~10× cheaper); code default is Sonnet — a local run without this var costs 10× more per turn |
| `OBSERVATION_EXTRACT_MODEL` | `claude-sonnet-4-6` | `''` → falls back to `SONNET_EXTRACT_MODEL` (`eicr-extraction-session.js:2470`) | PROD — observations stay on Sonnet even though live extraction is Haiku |
| `SNAPSHOT_FORMAT` | `split_blocks` | `'single_block'` (`eicr-extraction-session.js:1202`) | PROD — state-snapshot prompt shape |
| `CIRCUIT_ORDER` | `recent_3` | `'recent_3'` (`eicr-extraction-session.js:1238`) | PROD (matches default) |
| `CCU_STAGE2_GROUPS` | `true` | — **no reader anywhere in `src/`** | **LEGACY-DEAD** — the Stage-2 populated-area path was deleted 2026-04-29 (`83e337e6`); the var was never removed from the task-def. Do not "wire it up"; removal is a one-line source commit |
| `STAGE0_BENCH` | `1` | unset → bench routes 404 | EXPERIMENTAL — gates the throwaway voice-latency bench routes mounted early in `src/api.js:256` (incl. un-authed `X-Bench-Secret`-protected `/api/test/harness-mint-jwt`). Deliberately ON in prod for prod smoke runs; slated for removal "when the sprint closes" |

### CCU pipeline selectors (3 of the family; full family in §4)

| Var | Prod value | Code default | Class |
|---|---|---|---|
| `CCU_USE_SINGLE_SHOT` | `true` | `false` (`src/routes/extraction.js:2191`) | PROD — single-shot whole-image VLM call is the live path; `false` = legacy per-slot fallback |
| `CCU_SLIDING_WINDOW` | `true` | `false` (`extraction.js:2183`) | PROD — but when BOTH are true, **single-shot wins** (`extractFn = useSingleShot ? extractViaSingleShot : extractViaSlidingWindow`) |
| `CCU_SLIDING_WINDOW_MODEL` | `gpt-5.5` | falls back to `CCU_MODEL` (`extraction.js:2206`) | PROD — routes the single-shot/sliding VLM call; a `gpt-*` name wraps an OpenAI client in an Anthropic-shaped adapter |

### Voice-latency flags (10) — defined in `src/extraction/voice-latency-config.js`

All parse via `parseBool` (`true/1/yes/on`), **default false** when unset. Flags
are **per-session snapshotted** at `session_start` (frozen for the session; a
task-def flip only affects NEW sessions) — EXCEPT the kill switch, which is
read live on every check.

| Var | Prod value | Class | What it gates |
|---|---|---|---|
| `VOICE_LATENCY_STREAM_CONFIRMATIONS` | `true` | PROD | Mid-stream confirmation streaming |
| `VOICE_LATENCY_SUPPRESSION` | `false` | PROD | MUST stay `false` — `true` would suppress read-backs, violating Audio-First invariant #1/#2 (universal read-back). Never flip without an explicit cross-platform mandate |
| `VOICE_LATENCY_REGEX_FAST_TTS` | `true` | PROD | Server side of the regex fast-path TTS route (`src/routes/voice-latency-fast-tts.js`); also needs client capability `regex_fast_v2` — web does not consume it yet (WS3b item 4, open) |
| `VOICE_LATENCY_STREAM_ASK_USER` | `false` | EXPERIMENTAL-off | Streaming ask_user |
| `VOICE_LATENCY_USE_MULTI_CONTEXT` | `true` | PROD | ElevenLabs multi-context streaming |
| `VOICE_LATENCY_LOADED_BARREL` | `true` | PROD | Loaded-barrel speculator (pre-synthesises likely confirmations mid-stream) |
| `VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN` | `12` | PROD tunable | Per-turn speculation cap. Code default **2** (`voice-latency-config.js:79`); read fresh each call (tunable without redeploy semantics, but a persistent change still needs the task-def) |
| `VOICE_LATENCY_ROUND1_MODEL` | `""` | no-op | Empty = no round-1 model override (`src/extraction/stage6-tool-loop.js:395`) |
| `VOICE_LATENCY_KILL_SWITCH` | `false` | **SAFETY** | LIVE-read every call (`isKillSwitchActive()`): rejects new TTS at `/api/proxy/elevenlabs-tts`, aborts in-flight syntheses, tells iOS to drop queued audio. Flip via task-def + deploy (~5 min ECS roll) |

## 2. Backend env vars read by code but NOT in the task-def

These run on their code defaults in prod. Adding any of them to the task-def is
how you'd flip them (see §7 checklist). Default-ON flags use the `!== 'false'`
pattern — setting them `false` is the rollback lever.

| Var | Code default | Where read |
|---|---|---|
| `VOICE_PRE_LLM_GATE` | ON | `src/extraction/sonnet-stream.js:84` — pre-LLM transcript gate |
| `VOICE_REGEX_PRE_APPLY` | ON | `eicr-extraction-session.js:2585` |
| `VOICE_ORPHAN_PROMPT` | ON | `src/extraction/stage6-shadow-harness.js:280` |
| `IR_ORPHAN_APPLY_COMPLETE` | ON | `stage6-shadow-harness.js:291` |
| `VOICE_MID_STREAM_FILTER` | OFF (`=== 'true'`) | `stage6-shadow-harness.js:1242` — deliberately disabled 2026-06 (`57f44498`: values were lost when speculator emits didn't reach iOS). Do not re-enable casually |
| `CHITCHAT_COUNT_MISSING_CONTEXT` | ON | `src/extraction/chitchat-pause.js:97` |
| `CHITCHAT_MISSING_CONTEXT_THRESHOLD` | numeric, parsed at `chitchat-pause.js:91` | chitchat pause tuning |
| `SONNET_SESSION_TTL_MS` / `SONNET_SESSION_MAX_ENTRIES` / `SONNET_CACHE_TTL` | in-code | session store tuning |
| `DOC_EXTRACT_MODEL` / `EXTRACTION_MODEL` / `ENABLE_DEBUG_AUDIO` | in-code | document extraction / debug |

Secrets (`JWT_SECRET`, `ANTHROPIC/OPENAI/GEMINI/DEEPGRAM/ELEVENLABS_API_KEY`,
`DATABASE_URL`, …) come from Secrets Manager via `USE_AWS_SECRETS=true`, NOT the
`environment[]` block — they are allowlisted in `scripts/audit-env-var-source.sh`.

## 3. Source-literal constants — and what they do NOT do

| Constant | Value | Location | What it IS | What it is NOT |
|---|---|---|---|---|
| `CONFIRMATION_MIN_CONFIDENCE` | `0.8` | `src/extraction/confirmation-text.js:193` | The loaded-barrel speculator's **pre-synth cost gate**: its ONLY consumer is `shouldGenerateConfirmation()` (same file, :458), imported solely by `src/extraction/loaded-barrel-speculator.js`. A sub-0.8 confidence just skips the speculative mid-stream pre-synthesis | **NOT a read-back gate.** Since 2026-06-18 the final end-of-turn read-back (`stage6-event-bundler.js`) is un-gated — every applied reading is read back regardless of confidence (Audio-First #1/#2). Do not re-introduce this threshold anywhere on the read-back path |
| `FINALIZER_TIMEOUT_MS` | `8000` | `src/extraction/voice-latency-turn-summary.js:119` | Timeout arming the `turn_audio_summary` finalizer — how long the server waits for iOS playback ACKs before emitting `audio_finalizer_timeout_fired: true` | **The OPEN Phase-2.2 tuning target** (deferred from PR #52): widen this server-side vs iOS emitting an Apple-native `local_fallback` ACK. Decision gated on 1–2 field sessions. Do not tune it casually; route through `certmate-latency-campaign` |
| Loaded-barrel per-turn cap | code default `2` | `voice-latency-config.js:79` | See §1 — prod overrides to 12 via env | |
| `COMPACTION_THRESHOLD` | **RETIRED** | removed in `839c9ac3` ("remove dead compaction code") | Changelog rows from 2026-02 still mention raising it 6000→60000 | It no longer exists in `src/` — do not chase it from changelog references |

## 4. CCU_* tuning family (all readers, with code defaults)

CCU = consumer unit (the fuse board photographed for circuit extraction). Live
path as of 2026-07-06: single-shot gpt-5.5 (`src/extraction/ccu-single-shot.js`).

| Var | Code default | Location | Purpose |
|---|---|---|---|
| `CCU_MODEL` | `claude-sonnet-4-6` | `src/routes/extraction.js:1832` | Base model for classifier/whole-image calls |
| `CCU_USE_SINGLE_SHOT` / `CCU_SLIDING_WINDOW` / `CCU_SLIDING_WINDOW_MODEL` | see §1 | `extraction.js:2183-2206` | Pipeline selectors; single-shot wins when both true |
| `CCU_SLIDING_WINDOW_TIMEOUT_MS` | `60000` | `ccu-sliding-window.js:60` | |
| `CCU_SINGLE_SHOT_TIMEOUT_MS` / `_MAX_TOKENS` | `90000` / `4096` | `ccu-single-shot.js:120-121` | |
| `CCU_DEWARP_ENABLED` | `true` | `ccu-single-shot.js:54` | Perspective dewarp pre-step; `false` = legacy raw-photo path |
| `CCU_DEWARP_OUTPUT_WIDTH` | `2048` (in code; `native` = pixel-density mode) | `ccu-single-shot.js:101-108` | Default moved INTO code after the value was lost twice to task-def re-registration (2026-05-13/14 incident that spawned the drift guard) |
| `CCU_DEWARP_MAX_WIDTH` | unset (null) | `ccu-single-shot.js:117` | Soft cap, only active in `native` mode |
| `CCU_VLM_POSITION_MATCHER` | `true` | `ccu-single-shot.js:131` | Position-array label matching; `false` = emergency rollback to per-entry labels |
| `CCU_BOX_TIGHTEN` / `CCU_QUAD_GEOMETRY` | `true` / `true` | `extraction.js:2062-2063` | Geometry prep toggles |
| `CCU_PROBE_V2` | `true` | `ccu-box-tighten.js:100` | |
| `CCU_CV_PITCH` | `true` | `ccu-geometric.js:34` | CV pitch cross-check |
| `CCU_GEOMETRIC_MODEL` / `_TIMEOUT_MS` | `claude-sonnet-4-6` / `60000` | `ccu-geometric.js:21,25` | Legacy per-slot pipeline (fallback only) |
| `CCU_LABEL_MODEL` | chain: `CCU_LABEL_MODEL` → `CCU_GEOMETRIC_MODEL` → `CCU_MODEL` | `ccu-label-pass.js:35-37` | Legacy label pass |
| `CCU_LABEL_TIMEOUT_MS` / `_CONFIDENCE_MIN` | `60000` / parsed float | `ccu-label-pass.js:41,312` | |
| `CCU_LABEL_MATCHER_*` (ALGORITHM, MAX_MATCH_FACTOR, LABEL_SKIP_FACTOR, DEVICE_SKIP_FACTOR) | in-code | grep `CCU_LABEL_MATCHER` | Label-matcher tuning |
| `CCU_REWIREABLE_MODEL` | chain: REWIREABLE → GEOMETRIC → CCU_MODEL | `ccu-geometric-rewireable.js:33-35` | BS 3036 rewireable boards |
| `CCU_EXTRACTION_TIMEOUT_MS` / `CCU_MAX_UPLOAD_BYTES` | `180000` / 20 MiB | `extraction.js:41-42` | Request-level limits |

## 5. Web config — build-time vs the ONE runtime flag

### 5a. NEXT_PUBLIC_* build-time inlining trap

`NEXT_PUBLIC_*` values are inlined into the client bundle at `next build`,
which runs inside `docker/nextjs.Dockerfile`. **Every such flag MUST be declared
as BOTH `ARG` and `ENV` in that Dockerfile, AND passed in the `build-args` block
of `.github/workflows/deploy.yml` (~line 329) — otherwise it is silently dropped**
(the 2026-05-15 incident: `NEXT_PUBLIC_REGEX_HINTS_ENABLED` was passed in
deploy.yml but never bridged to ENV, so regex hints — and separately the WS
auto-reconnect flag — sat dormant in prod while local dev worked).

Current CI-baked values (deploy.yml build-args, verified 2026-07-06):

| Var | CI value | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.certmate.uk` | Backend API base for `api-client.ts` |
| `NEXT_PUBLIC_REGEX_HINTS_ENABLED` | `1` | Regex hint tier |
| `NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED` | `true` | Sonnet WS auto-reconnect |
| `NEXT_PUBLIC_SILERO_VAD` | `0` | Silero VAD OFF — its ~30MB ONNX heap caused iPad Safari process reaps at ~40s (2026-05-17); RMS-gate fallback is the live wake path |

Also read in `web/src` but NOT CI-baked (build-info/debug only, default-unset):
`NEXT_PUBLIC_APP_VERSION`, `NEXT_PUBLIC_BUILD_ID`, `NEXT_PUBLIC_DEBUG_RECORDING`.

Changing any NEXT_PUBLIC value = full CI rebuild (~30 min). That is exactly why
the STT selector below is NOT a NEXT_PUBLIC var.

### 5b. `DEEPGRAM_STT_MODEL` — the runtime STT kill-switch (full mechanics)

Selects the web Deepgram model per recording session: `flux` (turn-detection
model, `/v2/listen`) vs `nova3` (legacy, `/v1/listen`).

| Piece | Fact |
|---|---|
| Where set | `ecs/task-def-frontend.json` env — **current value `flux`** since `ff620997` (2026-07-03, intentional: nova-3 shipped partial sentences at every ~400ms endpointing boundary; Flux only finalises on end-of-turn) |
| Server route | `web/src/app/runtime-config/route.ts` — serves `{ sttModel: <raw env> }`, `force-dynamic` + `Cache-Control: no-store`, reads `process.env` at REQUEST time |
| Route path | `/runtime-config` **top-level, deliberately NOT `/api/*`** — the prod ALB priority-10 rule forwards ALL `/api/*` to the backend target group (`infrastructure/setup-domain.sh:394-406`); an `/api/runtime-config` route would 404 and pin every session to the fail-safe. Never fetch it through `api-client.ts` either |
| Client resolver | `web/src/lib/runtime-config.ts` — normalises raw (`nova-3`/`Nova3`/`NOVA 3` → `nova3`); re-fetched with `{force:true}` on EVERY recording-session `start()` so an ECS flip lands without page reload |
| `DEFAULT_STT_MODEL` | `'nova3'` (`runtime-config.ts:37`) — used only when the env var is MISSING/blank. **Still `'nova3'` in code as of 2026-07-06**: the flux flip commit changed ONLY the task-def line, so live behaviour rides the explicit task-def value, not this constant. A "flux default" commit flipping this constant remains open/candidate |
| `SAFE_STT_MODEL` | `'nova3'` (`runtime-config.ts:40`) — fail-safe for UNRECOGNISED values and fetch/parse failures. **NEVER flips**, even after a flux default |
| SW pin | `web/src/app/sw.ts:50` — `NEVER_CACHE_PATHS = /^(?:\/_next\/app\/|\/runtime-config$)/` forces NetworkOnly so a stale service-worker cache can't mask a flip |
| Flip/rollback path | Edit ONLY `ecs/task-def-frontend.json` → commit → push. CI `detect-changes` sees the changed set is EXACTLY that file → `target=frontend-taskdef` → skips rebuild, re-registers the task def against the existing `:latest` image, rolls `eicr-pwa` only. **~3–5 min** end-to-end vs ~30 min full build |
| Auth note | The route sits behind the middleware JWT gate; an expired-token HTML redirect fails `.json()` → fail-safe nova3 (by design) |

### 5c. Frontend task-def (`ecs/task-def-frontend.json`) inventory

| Entry | Value | Class |
|---|---|---|
| `AWS_REGION` / `NODE_ENV` | `eu-west-2` / `production` | PROD |
| `DEEPGRAM_STT_MODEL` | `flux` | PROD runtime flag (§5b) |
| `BACKEND_URL` | `https://api.certmate.uk` | **LEGACY-DEAD** — zero readers anywhere in `web/` (verified by grep 2026-07-06); the client uses build-time `NEXT_PUBLIC_API_URL`. Removal candidate via source commit |
| `JWT_SECRET` | Secrets Manager `secrets[]` block (`eicr/api-keys...:JWT_SECRET::`) | PROD — consumed by `web/src/middleware.ts`, which FAILS CLOSED: missing secret = every login bounces (bit twice, 2026-04-19). Never remove; the execution role also needs `secretsmanager:GetSecretValue` |

## 6. iOS config — which `default_config.json` is canonical

The CLAUDE.md sync rule ("add keyword boosts in `default_config.json`") refers to
the **iOS** file, not anything in backend `config/` (no backend reader exists).
Two copies exist in the nested `CertMateUnified/` repo:

- **CANONICAL: `CertMateUnified/Sources/Resources/default_config.json`** — this
  is the copy bundled into the built app (verified 2026-07-06: the
  `CertMateUnified.app/default_config.json` build product's md5 matches it, and
  it is the newer file).
- TRAP: `CertMateUnified/Resources/default_config.json` is a **stale twin**
  (last touched 2026-04-09). Editing it does nothing to the shipped app.

The web twin of the iOS keyword boosts is
`web/src/lib/recording/keyword-boosts.ts` (e.g. `'trip time'` boosted to 2.5 on
2026-07-03 because at 1.5 it ranked ~107/120 and fell to web's 85-term cut).
Keep iOS and web Deepgram configs in sync as a SET (endpointing, keyterms,
model params) — drift here has produced garbage transcripts before.

## 7. How to add / change / remove an env var (checklist)

The two CI drift guards this routes through:
- `scripts/check-task-def-env-drift.sh <service> <template>` — fails the deploy
  if a var exists on the LIVE task def but not in the source template (i.e. an
  out-of-band hotfix the register step would silently strip). Bypass: commit
  message `[skip-drift-check]` (sets `ALLOW_TASKDEF_DRIFT`) — emergencies only,
  MUST be followed by a real source commit.
- `scripts/audit-env-var-source.sh ecs/task-def-backend.json` — the opposite
  direction: fails if backend code reads `process.env.X` and X is in neither the
  template nor the script's in-file allowlist (Secrets-Manager / AWS-managed /
  test-only vars). Backend-only in CI.

**Adding a backend var:**
1. Code: read it with an explicit safe default (`!== 'false'` for default-ON,
   `=== 'true'` for default-OFF; numbers via `Number(x || DEFAULT)`).
2. Add it to `ecs/task-def-backend.json` `environment[]` — even if the prod
   value equals the code default, so intent is explicit and the audit passes.
   If it's a secret, use the `secrets[]` block AND add it to the
   `audit-env-var-source.sh` allowlist with a one-line comment.
3. Run locally before pushing (needs AWS creds):
   `./scripts/audit-env-var-source.sh ecs/task-def-backend.json`
4. Commit code + task-def together (one concern, WHY-style body), push to
   `main`; CI runs drift check → audit → register → migrate → roll service.
5. NEVER `aws ecs register-task-definition` by hand as the canonical change —
   the next CI deploy re-registers from source and drops it (bit twice:
   `CCU_DEWARP_OUTPUT_WIDTH`, `JWT_SECRET`).

**Adding a web CLIENT flag:** prefer runtime (`/runtime-config` pattern, §5b)
if it must be flippable in the field. If build-time is acceptable, you must
touch THREE places or it silently no-ops: (1) read site in `web/src`,
(2) `ARG` + `ENV` in `docker/nextjs.Dockerfile`, (3) `build-args` in
`.github/workflows/deploy.yml`.

**Removing a var:** delete the code reader first, then remove the task-def
entry in the same or a follow-up commit. If you remove only the code reader,
the var lingers as LEGACY-DEAD (see `CCU_STAGE2_GROUPS`, `BACKEND_URL`).

**Change-control note:** backend task-def/env changes are BACKEND changes —
during PWA-only parity work they need an explicit cross-platform mandate
(`certmate-change-control`). The frontend-taskdef path (§5b) is the only
routine web-side task-def change.

## 8. Kill-switch quick reference

| Lever | Flip | Takes effect | Scope |
|---|---|---|---|
| `VOICE_LATENCY_KILL_SWITCH=true` | backend task-def + deploy | live-read (~50ms once env present); ECS roll ~5 min | Aborts the whole TTS streaming surface |
| `DEEPGRAM_STT_MODEL=nova3` | `ecs/task-def-frontend.json` one-line commit | ~3–5 min (frontend-taskdef path), next recording session | Web STT back to nova-3 |
| `CCU_USE_SINGLE_SHOT=false` | backend task-def | next deploy | Falls back to legacy per-slot CCU pipeline |
| `CCU_DEWARP_ENABLED=false` | backend task-def | next deploy | Raw-photo CCU path |
| `CCU_VLM_POSITION_MATCHER=false` | backend task-def | next deploy | Legacy per-entry label matching |
| `VOICE_MID_STREAM_FILTER` | leave OFF | — | Known-bad ON (values lost); OFF is the fix, not a temporary state |
| `VOICE_LATENCY_SUPPRESSION` | leave `false` | — | `true` violates Audio-First #1/#2 — not a usable lever |
| `NEXT_PUBLIC_SILERO_VAD` | already `0` | full rebuild (~30 min) | Do not re-enable without re-testing iPad Safari memory |

## Provenance and maintenance

Re-verify each drift-prone fact with one line (repo root):

| Fact | Verify |
|---|---|
| Backend task-def var list + values | `jq -r '.containerDefinitions[0].environment[] \| "\(.name)=\(.value)"' ecs/task-def-backend.json` |
| Frontend task-def (STT model, JWT_SECRET, BACKEND_URL) | `jq '.containerDefinitions[0]' ecs/task-def-frontend.json` |
| `CCU_STAGE2_GROUPS` still dead | `grep -rn CCU_STAGE2_GROUPS src/ \| grep -v __tests__` (expect empty) |
| `BACKEND_URL` still dead in web | `grep -rn BACKEND_URL web/src web/next.config.* 2>/dev/null` (expect empty) |
| `CONFIRMATION_MIN_CONFIDENCE` still speculator-only | `grep -rn shouldGenerateConfirmation src/ \| grep -v __tests__` (expect confirmation-text.js + loaded-barrel-speculator.js only) |
| `FINALIZER_TIMEOUT_MS` value | `grep -n FINALIZER_TIMEOUT_MS src/extraction/voice-latency-turn-summary.js` |
| Voice-latency flag defaults + snapshot semantics | `sed -n '1,50p' src/extraction/voice-latency-config.js` |
| CCU env reads (full family) | `grep -rhoE 'process\.env\.CCU_[A-Z0-9_]+' src/ --include='*.js' \| sort -u` |
| All backend env reads vs template | `./scripts/audit-env-var-source.sh ecs/task-def-backend.json` |
| NEXT_PUBLIC CI build-args | `grep -A8 'build-args' .github/workflows/deploy.yml \| head -12` |
| Dockerfile ARG+ENV bridge | `grep -n 'NEXT_PUBLIC' docker/nextjs.Dockerfile` |
| `/runtime-config` SW pin | `grep -n runtime-config web/src/app/sw.ts` |
| DEFAULT vs SAFE STT constants | `grep -n '_STT_MODEL' web/src/lib/runtime-config.ts` |
| Canonical iOS default_config.json | `md5 CertMateUnified/Sources/Resources/default_config.json CertMateUnified/build/Debug-iphoneos/CertMateUnified.app/default_config.json` (should match) |
| frontend-taskdef fast path | `grep -n 'frontend-taskdef' .github/workflows/deploy.yml` |
| Flux flip provenance | `git log --oneline -1 ff620997 -- ecs/task-def-frontend.json` |
