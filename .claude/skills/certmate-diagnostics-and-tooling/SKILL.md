---
name: certmate-diagnostics-and-tooling
description: >
  Inventory + interpretation guide for every measurement tool in the CertMate/EICR
  repo. Load this when you need to MEASURE instead of eyeball: analysing a field
  session (analyze-session.js, S3 debug_log.jsonl), replaying voice scenarios or
  benchmarking latency (scripts/voice-latency-bench/*), running Stage 6 or CCU
  harnesses, checking cost accounting (cost-tracker zeros), verifying prod health
  (/api/health/ready, CloudWatch tailing), or instrumenting a client via the
  sendClientDiagnostic WS channel (the 3-builds rule). Do NOT load this for
  symptom→root-cause triage (certmate-debugging-playbook), for pass/fail evidence
  standards and test-suite footguns (certmate-validation-and-qa), or for the
  latency-campaign decision tree itself (certmate-latency-campaign).
---

# CertMate Diagnostics & Tooling

All paths repo-relative to the EICR_Automation repo root. All facts verified against the working tree **as of 2026-07-06**. Rule zero, from the mistakes log: **3+ builds/attempts on the same symptom → STOP fixing, START instrumenting.** This skill is the instrument catalogue.

Jargon used below (defined once):
- **Stage 6** — the server-side agentic tool-call extraction loop (Sonnet/Haiku calling `record_reading`, `create_circuit`, … over the `/api/sonnet-stream` WebSocket).
- **Loaded Barrel** — the speculative TTS pre-synthesiser: pre-synthesises a confirmation MP3 while the model is still streaming, so playback starts the moment the turn resolves.
- **TTFT / TTFB** — time-to-first-token (Anthropic stream) / time-to-first-byte (ElevenLabs audio).
- **CCU** — consumer unit (the fuse board photographed for circuit extraction).
- **Session analytics** — the per-recording-session artefact bundle iOS/web uploads to S3 (debug log, field sources, manifest, job snapshot).

## Tool chooser

| You need to know… | Tool | Section |
|---|---|---|
| What actually happened in a field session | `scripts/analyze-session.js` + S3 fetch | §1 |
| Did my change break voice extraction behaviour | `npm run voice-regression` (offline, direct) | §2 |
| Full WS-protocol replay incl. auth/persistence | `npm run voice-test` (transcript-replay vs a running backend) | §2 |
| Raw model/vendor latency floor | `sonnet-ttft-bench.mjs`, `elevenlabs-ttfb-bench.mjs`, `elevenlabs-multi-context-bench.mjs` | §3 |
| Stage 6 pipeline divergence / over-ask regression | `stage6-golden-divergence.js`, `stage6-over-ask-exit-gate.js` | §4 |
| Second-opinion Codex review of a phase | `scripts/stage6-review.sh` | §4 |
| CCU extraction behaviour on a local photo | `scripts/ccu-local-run.mjs` + corpus harnesses (LEGACY-path caveat!) | §5 |
| Whether AI spend numbers are real | `src/extraction/cost-tracker.js` + `cost_summary.json` | §6 |
| Backend↔iOS field-name drift | `npm run check:ios-parity` | §7 |
| Is prod alive / what is it logging | `/api/health/ready`, `aws logs tail` | §8 |
| Client-side event that never reaches a screen you can see | `sendClientDiagnostic` → CloudWatch | §9 |

## 1. Session forensics — analyze-session.js

The single most valuable diagnostic loop in this repo: field bugs are found by replaying what the session logs say happened, not by re-testing by hand.

**Where the raw data lives** (S3 bucket `eicr-files-production`, region `eu-west-2`):

| S3 key | Producer | Content |
|---|---|---|
| `session-analytics/{userId}/{sessionId}/debug_log.jsonl` | client multipart upload `POST /api/session/:sessionId/analytics` (`src/routes/recording.js:1428`) | per-event JSONL from the client DebugLogger |
| `…/field_sources.json`, `…/manifest.json`, `…/job_snapshot.json` | same upload | which tier wrote each field; session metadata; final job state |
| `…/cost_summary.json` | backend, written at session close (`src/extraction/sonnet-stream.js:4483`) | server-authoritative cost breakdown |
| `session-logs/{userId}/{sessionId}/realtime/{ts}-{uuid}.jsonl` | backend `client_log_batch` relay (`src/extraction/realtime-log-sink.js:129`) | same JSONL entries streamed live over the Sonnet WS every ~2s, flushed every ~30s / 100KB |

The realtime relay exists because the iOS multipart analytics upload has been unreliable (noted broken since Mar 2026 in `sonnet-stream.js` comments) — if `debug_log.jsonl` is missing, stitch the `realtime/` chunks.

**One-liner fetch** (this skill ships it; read-only against S3):

```bash
.claude/skills/certmate-diagnostics-and-tooling/scripts/fetch-session-analytics.sh <sessionId> [outDir] [--analyze]
# e.g. …/fetch-session-analytics.sh sess_mr8qrvcm_20jn /tmp/sess --analyze
```

It locates the session across user prefixes, downloads all artefacts + realtime chunks (reconstructing `debug_log.jsonl` from chunks if absent), and with `--analyze` runs:

```bash
node scripts/analyze-session.js /path/to/session-dir/   # needs debug_log.jsonl + field_sources.json + manifest.json
```

**Output: `analysis.json` in the same dir.** Key sections and how to read them (top-level keys verified at `scripts/analyze-session.js:1812-1861`):

| Section | What it tells you |
|---|---|
| `field_report` / `empty_fields` / `unmapped_readings` | which fields were written, by which tier, and which spoken readings never landed — a non-empty `unmapped_readings` is a dropped-reading bug (Audio-First invariant #1 violation candidate) |
| `regex_performance` / `sonnet_performance` / `extraction_efficiency` | per-tier hit rates; `fields_per_call` for prompt-efficiency regressions |
| `utterance_analysis` / `full_transcript` / `transcript_issues` | utterance→event latency (`latency_ms` per utterance), Deepgram garbles |
| `tool_call_traffic` | per-tool histogram of Stage 6 tool calls incl. validation errors — always emitted (`.enabled=true` even on legacy sessions) |
| `dialogue_engine_transitions` / `stage6_tool_calls` / `focused_mode_timeline` | script/focus-mode state machine walk; degrade to `[]` when the `backend_events.jsonl` sidecar is absent |
| `bug_signature_hits` | registry of known bug signatures auto-detected in this session — check FIRST, it may name your bug |
| `cost_breakdown` / `cost_summary` | client-estimated vs server-authoritative cost (server wins when present) |
| `warnings` | malformed/truncated JSONL lines — non-empty means the log was cut off, distrust absence-of-evidence |
| `vad_sleep_analysis`, `observation_capture_quality`, `repeated_values`, `tts_discarded` | sleep-tier behaviour, obs quality, dedupe candidates, confirmations discarded before playback |

**Downstream renderer:** `node scripts/generate-report-html.js <recommendations.json> <session-summary.json> <report-id> <output.html>` — used by the automated session-optimizer pipeline (`scripts/session-optimizer.sh`, launchd); rarely needed by hand.

## 2. Voice-latency bench — scenario replay (the workhorses)

Scenario fixtures: `tests/fixtures/voice-latency-scenarios/<suite>/*.yaml` (schema in `SCHEMA.md` there; suites as of 2026-07-06: `baseline`, `address`, `bulk`, `confirmation`, `dispatcher_gaps`, `enum_guards`, `exhaustive`, `fixes_2026_06_02`, `garbles`, `loaded_barrel`, `schema_ambiguity`, `scripts`, `speculator_races`; 160 scenario YAMLs across the 13 suites, 26 in `baseline` — the default voice-regression sweep). `KNOWN_FLAKY.md` lists tolerated flakes. Auto-generated probes, when produced, are written under `auto-generated/` and excluded unless `--include-auto-generated` (none committed as of 2026-07-06).

**Two replay harnesses — different bug surfaces, same scenarios:**

| Harness | Path | Exercises | Skips |
|---|---|---|---|
| WS replay ("simulated Deepgram") | `scripts/voice-latency-bench/transcript-replay.mjs` (`npm run voice-test`) | full HTTP/WS stack: auth, `session_start` capabilities, live Sonnet extraction, optional ElevenLabs proxy timing | nothing server-side; needs a running backend |
| Direct (no-HTTP) | `scripts/voice-latency-bench/transcript-replay-direct.mjs` | Stage 6 tool loop + Loaded Barrel in-process (real Anthropic calls; auto-fetches `ANTHROPIC_API_KEY` from Secrets Manager `eicr/api-keys` if unset); per-turn wall-clock breakdown; `ask_user_responses`, `expect.loaded_barrel`, `expect.tool_call_sequence`, `expect.forbid_tools` | HTTP/WS/auth/persistence; real audio |

```bash
# WS replay against local backend (npm start must be running on :3000)
npm run voice-test -- --user=<email> --password=<pw> --suite=baseline --output=/tmp/results
# or --token=<JWT>; exit 0 all passed / 1 failures / 2 usage-or-connection

# Direct replay, one scenario
node scripts/voice-latency-bench/transcript-replay-direct.mjs \
  --scenario=tests/fixtures/voice-latency-scenarios/baseline/new_circuit_then_readings.yaml
```

**Regression orchestrator** (runs the DIRECT harness over baseline, verified at `voice-regression.mjs:96`):

```bash
npm run voice-regression                        # all baseline → voice-regression-report.md
npm run voice-regression -- --filter=designation --output=/tmp/report.md
```

Report shows pass/fail per scenario, per-turn + cumulative wall-clock, **Loaded Barrel hit/miss/absent rate**, and estimated Sonnet token cost. Exit 0 only when every scenario passes — gateable. Interpretation: a wall-clock regression localised to one turn stage = your change added latency there; Loaded Barrel `miss_ttl_expired` growth = pre-synth is firing but playback claims arrive too late.

**Cost control** (read `scripts/voice-latency-bench/HARNESS_COST_NOTES.md` before big sweeps):

```bash
./scripts/voice-latency-bench/run-cheap.sh --suite=baseline   # Haiku 4.5 + 1h cache: ~$0.02 warm suite
node scripts/voice-latency-bench/transcript-replay.mjs --suite=baseline  # Sonnet, prod defaults: ~$1.70 suite
```

`SONNET_EXTRACT_MODEL` / `SONNET_CACHE_TTL` must be set on the **backend process** too (the harness only talks WS to it). Haiku covers routing/mechanics scenarios; re-run ambiguous-language scenarios on Sonnet before trusting a pass.

**Against prod:** `./scripts/voice-latency-bench/run-harness-against-prod.sh` — mints a JWT via `POST /api/test/harness-mint-jwt` (route gated on `STAGE0_BENCH=1`, which IS set in `ecs/task-def-backend.json:41` as of 2026-07-06; secret = live `JWT_SECRET` sent as header `X-Bench-Secret`, fetched from Secrets Manager by the script), then replays the 5 baseline scenarios against `https://api.certmate.uk`. Prod runs spend real tokens against the live account and create real session traffic; prefer local, use prod only to reproduce prod-only behaviour.

## 3. Voice-latency bench — vendor-floor micro-benches

These measure the physics floor of the dictate→confirm loop. Result JSONs from previous runs sit next to each script (`*-result.json`) — compare against those, not against gut feel.

| Script | Measures | Pass criterion (from headers) | Invocation |
|---|---|---|---|
| `sonnet-ttft-bench.mjs` | Anthropic TTFT + completion (P50/P95/p99), prod-shaped cached prompt | P50 cached TTFT ≤ 900 ms | `ANTHROPIC_API_KEY=… node scripts/voice-latency-bench/sonnet-ttft-bench.mjs --iters=20 [--output=x.json]` |
| `elevenlabs-ttfb-bench.mjs` | ElevenLabs stream-input BOS→first-audio (single-shot WS, `eleven_flash_v2_5`) | P50 ≤ 250 ms | `ELEVENLABS_API_KEY=… node scripts/voice-latency-bench/elevenlabs-ttfb-bench.mjs --iters=20` |
| `elevenlabs-multi-context-bench.mjs` | multi-stream-input (pooled/warm WS): 7 operational pass criteria → warm-vs-cold ship decision | aggregate verdict | `ELEVENLABS_API_KEY=… node scripts/voice-latency-bench/elevenlabs-multi-context-bench.mjs` |
| `voice-ab-samples.mjs` | generates 40 audio samples (2 models × 2 formats) for human ear A/B | human pick | `ELEVENLABS_API_KEY=… node scripts/voice-latency-bench/voice-ab-samples.mjs` |

ElevenLabs key fetch: `ELEVENLABS_API_KEY=$(aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text | python3 -c "import sys,json;print(json.load(sys.stdin)['ELEVENLABS_API_KEY'])")`. Bench voice is hardcoded (Archer, `Fahco4VZzobUeiPqni1S`).

## 4. Stage 6 harnesses

| Script | Purpose | Invocation | Exit contract |
|---|---|---|---|
| `scripts/stage6-golden-divergence.js` | deterministic offline replay of golden-session fixtures through legacy vs tool-call pipelines; measures post-canonicalisation divergence. Offline (canned SSE, no API calls). Its point: if this is 0% and a live shadow diverges, the divergence is MODEL behaviour, not pipeline. | `node scripts/stage6-golden-divergence.js` (see `--help`/header for fixture-dir flags) | 0 = rate ≤ threshold, 1 = breach |
| `scripts/stage6-over-ask-exit-gate.js` | replays 12 over-ask fixtures through the real ask-gate/budget/restrained-mode composition; computes median / p95 ask counts + restrained-activation rate | `node scripts/stage6-over-ask-exit-gate.js [--json]` | 0 pass, 1 ANY threshold breach (conjunctive), 2 runtime error |
| `scripts/stage6-strict-mode-probe.js` | ad-hoc probe: does the Anthropic API enforce tool-schema enums strictly? | `ANTHROPIC_API_KEY=… node scripts/stage6-strict-mode-probe.js` | 0 conclusive-strict, 1 hard fail, 2 no key, 3 AMBIGUOUS (deliberately loud — investigate, don't treat as pass) |
| `scripts/stage6-review.sh` | Codex second-reviewer half of the dual-reviewer phase gate: bundles PROJECT.md + REQUIREMENTS.md + phase PLANs + git diff vs base, pipes into `codex exec -s read-only --skip-git-repo-check -` (frozen invocation, verified 2026-04-21 vs codex-cli 0.116.0) | `./scripts/stage6-review.sh <phase-dir>`; env: `STAGE6_BASE_BRANCH` (default `main`), `PLANNING_TREE`, `STAGE6_SKIP_CODEX` | 0 review ran (or manual fallback), 2 bad phase-dir, 3 missing planning artefact |

Full rationale + dry-run evidence for the review wrapper: `scripts/README-stage6-review.md`. Note the wrapper handles the two-repo layout (iOS `CertMateUnified/` is a nested separate git repo) by diffing BOTH repos.

## 5. CCU harnesses + corpus

**⚠ Trap first:** `scripts/ccu-local-run.mjs`'s header says "Single-shot was retired 2026-04-29; per-slot is the only path" — that comment is STALE. As of 2026-07-06 the LIVE prod path is single-shot gpt-5.5 (`src/extraction/ccu-single-shot.js`, `CCU_USE_SINGLE_SHOT=true` in `ecs/task-def-backend.json`); per-slot is the legacy fallback. **`ccu-local-run.mjs` therefore exercises the LEGACY per-slot pipeline, not the live path.** Use it for fallback-path work; for live-path failures reproduce via the route (`POST /api/analyze-ccu`) or read `certmate-ccu-pipeline`.

| Script | Purpose | Invocation |
|---|---|---|
| `ccu-local-run.mjs` | end-to-end LEGACY per-slot pipeline on a local photo — no HTTP/S3/DB; mirrors classifier → geometry → Stage 3 ‖ Stage 4 → merge → enrichers; deliberately omits `lookupMissingRcdTypes`, S3 training upload, idempotency | `ANTHROPIC_API_KEY=… node scripts/ccu-local-run.mjs <photo.jpg> [--roi=x,y,w,h] [--dump-crops=DIR] [--dump-overlay=f.jpg]` |
| `ccu-box-tighten.mjs` | rail-bbox corrector for the user's RoI hint (Sobel edge bands, ±15% search); pure CV, no API | `node scripts/ccu-box-tighten.mjs [--id <id>] [--stress] [--icloud]` |
| `ccu-cv-prototype.mjs` | module-count via autocorrelation pitch detection; no network, ~50-100 ms/photo | `node scripts/ccu-cv-prototype.mjs [--id <id>] [--stress]` |
| `ccu-sliding-window.mjs` | exploratory v5 mock: pixel-space sliding windows + positional clustering (ignores CV module count) | `ANTHROPIC_API_KEY=… node scripts/ccu-sliding-window.mjs <photo> [--window-mod=5] [--stride-mod=2] [--dry-run]` |
| `ccu-extract-via-tightener.mjs` | box-tightener → crops → optional Stage 3 classify | `node scripts/ccu-extract-via-tightener.mjs [--id <id>] [--classify]` |
| `dump-quad-overlay.mjs` | visualises exactly what quad-geometry sends the VLM per slot (overlay.png + slot crops + diagnostics JSON) | `node scripts/dump-quad-overlay.mjs <photo> <out-dir> [--roi x,y,w,h]` |

**Corpus:** `scripts/ccu-cv-corpus/` — `raw/` photos keyed by extractionId, `manifest.json` + `annotations.json` (ground truth + user boxes), `debug/` outputs, `build-manifest.mjs` to regenerate. Harnesses with `--id` resolve photos/boxes from this corpus. Use the corpus for before/after accuracy comparisons — never a single photo.

## 6. Cost accounting — zeros are a bug, not "no traffic"

- **Live per-session tracker:** `src/extraction/cost-tracker.js` (class `CostTracker`) — Anthropic rates per model family (sonnet/haiku/opus incl. cache read/write multipliers), Deepgram per-minute, ElevenLabs **per-model char buckets** (`elevenLabsCharsByModel`; `elevenLabsCharacters` is a derived back-compat getter). Emitted to clients as `cost_update` WS frames and persisted at session close to `session-analytics/{userId}/{sessionId}/cost_summary.json`.
- **Standing rule (mistakes log):** a zero for any tier you know was used = **wire-up bug**. Historical incident: `messages.stream()` cost silently zero because `.usage` was never read off `finalMessage`. When adding any new model call site, prove the tracker moves before trusting any cost number.
- Fast-TTS route (`src/routes/voice-latency-fast-tts.js`) has **no cost attribution** (known gap, noted 2026-06-26 changelog) — its ElevenLabs chars won't appear in `cost_summary.json`.
- **Legacy:** `src/token_logger.js` + root `token_usage.csv` — old per-JOB (doc/CCU extraction) GPT/Gemini accounting. The CSV's last row is 2026-01-24 and the file was last touched 2026-04-10; treat as historical, not a live diagnostic.

## 7. Cross-repo field parity

```bash
npm run check:ios-parity          # exit 0/1
node scripts/check-ios-field-parity.mjs --json
```

Diffs every field in `config/field_schema.json` against the `case "…"` arms in iOS `applySonnetReadings` (`CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`). MISSING = backend can emit a field iOS silently drops (the 6×`ir_test_voltage_v` session-6FF8A837 bug class); ORPHAN = legacy alias, info-only. Run it whenever `field_schema.json` or the iOS switch changes.

## 8. Live prod observation

```bash
# Readiness (DB SELECT 1 + Deepgram key + Anthropic key; 200 ready / 503 degraded with per-check booleans)
curl -s https://api.certmate.uk/api/health/ready | python3 -m json.tool

# ECS rollout state (PWA service is eicr-pwa; eicr-frontend is the desired-count-0 legacy
# Streamlit service — NOT the PWA, see certmate-run-and-operate §1)
aws ecs describe-services --cluster eicr-cluster-production --services eicr-pwa eicr-backend \
  --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table

# Log tailing (CloudWatch)
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m --follow
aws logs tail /ecs/eicr/eicr-pwa     --region eu-west-2 --since 10m
```

Useful CloudWatch grep targets in the backend group: `"Client diagnostic"` (see §9), `"Client log batch entry"` (relayed client JSONL), `voice_latency` (capability/startup logs). `/health` and `/api/health` are liveness-only; `/api/health/ready` is the one that proves the backend can actually run a recording session (`src/api.js:199`).

One-off operator probe: `node scripts/probe-loaded-barrel-readiness.mjs` — mints a JWT from the live `JWT_SECRET` and prints the Loaded Barrel adoption snapshot from `GET /api/voice-latency/loaded-barrel-readiness` (used for prod-flag flip gates).

## 9. sendClientDiagnostic — the WS→CloudWatch instrumentation channel

**When to reach for it (the 3-builds rule):** after 3+ builds/deploys chasing the same client-side symptom without a confirmed mechanism, stop patching and instrument. History: 5+ blind TestFlight builds were burned on "framework bugs" that were actually missing data — instrumentation would have named the culprit on build 1.

**Mechanics** (verified in code):
- Web: `clientDiagnostic(category, payload)` from `web/src/lib/recording/client-diagnostic.ts` — always `console.info('[client-diagnostic] …')`, and forwards to the active SonnetSession sink (`SonnetSession.sendClientDiagnostic`, `web/src/lib/recording/sonnet-session.ts:1176`) which emits a `client_diagnostic` WS frame; frames fired while the WS is down are buffered (`pendingDiagnostics`, FIFO-capped) and replayed with `replayed_from_pending: true` + original `captured_at_iso` on reconnect — so death-of-session events survive.
- iOS mirror: `ServerWebSocketService.sendClientDiagnostic` (same frame shape).
- Backend: `case 'client_diagnostic'` in `src/extraction/sonnet-stream.js:1057` logs at info as message **`Client diagnostic`** with server-authoritative `userId`/`sessionId` (client-supplied identity fields are stripped). Query it:

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 1h --filter-pattern '"Client diagnostic"'
```

- Sibling channel `client_log_batch` (iOS streams whole DebugLogger JSONL over the same WS every ~2s): each entry gets a `Client log batch entry` CloudWatch row AND lands in the S3 realtime sink (§1). Per-session cost cap: 20 000 lines → downsampling (all error/warn, 1/10 info, 1/100 debug) rather than going dark.

**Usage pattern:** add a `clientDiagnostic('<category>', {…})` at each candidate drop point along the suspect chain (decode → handler → speak → fetch), deploy ONCE, reproduce, read CloudWatch. Categories are free-form strings; existing precedents: `analytics_backlog`, `question_enqueued`, `inflight_anchored`, `inflight_anchor_missed`.

## When NOT to use this skill

- Deciding WHAT to try on the dictate→confirm latency loop, gates and expected numbers → **certmate-latency-campaign** (it consumes the tools catalogued here).
- Symptom→cause triage of a known failure class (login bounce, [REDACTED], empty circuits…) → **certmate-debugging-playbook**.
- What counts as pass/fail evidence, test-harness footguns, parity-ledger process → **certmate-validation-and-qa**.
- First-principles analysis recipes (latency budget decomposition, wire-contract test design, A/B methodology) → **certmate-proof-and-analysis-toolkit**.
- Deploy/rollback/ECS operations themselves → **certmate-run-and-operate**.
- CCU pipeline internals and tuning → **certmate-ccu-pipeline**. Wire-frame shapes → **certmate-voice-wire-protocol**. Env-var meanings → **certmate-config-and-flags**.

## Provenance and maintenance

Every claim above was verified against the working tree on 2026-07-06. Re-verify before relying on drift-prone facts:

| Fact | Re-verify with |
|---|---|
| npm aliases `voice-test`, `voice-regression`, `check:ios-parity` exist | `grep -n "voice-test\|voice-regression\|check:ios-parity" package.json` |
| voice-regression drives the DIRECT harness | `grep -n "transcript-replay" scripts/voice-latency-bench/voice-regression.mjs` |
| analysis.json section list | `grep -n "const analysis = {" -A 50 scripts/analyze-session.js` |
| S3 analytics prefix + cost_summary + realtime key shapes | `grep -rn "session-analytics/\|session-logs/" src/routes/recording.js src/extraction/sonnet-stream.js src/extraction/realtime-log-sink.js` |
| `client_diagnostic` / `client_log_batch` backend arms | `grep -n "case 'client_diagnostic'\|case 'client_log_batch'" src/extraction/sonnet-stream.js` |
| ccu-local-run still legacy-per-slot only (stale-header trap) | `grep -n "CCU_USE_SINGLE_SHOT" ecs/task-def-backend.json src/routes/extraction.js && head -30 scripts/ccu-local-run.mjs` |
| `/api/health/ready` checks | `grep -n "health/ready" -A 8 src/api.js` |
| CloudWatch log-group names | `grep -n "awslogs-group" ecs/task-def-*.json` |
| Scenario suite dirs | `ls tests/fixtures/voice-latency-scenarios/` |
| Harness cost numbers (re-measure when prompt size shifts) | `cat scripts/voice-latency-bench/HARNESS_COST_NOTES.md` |
| Prod-mint endpoint still enabled (`STAGE0_BENCH=1` in task def) | `grep -n "STAGE0_BENCH" ecs/task-def-backend.json` |
| ElevenLabs per-model cost buckets | `grep -n "elevenLabsCharsByModel" src/extraction/cost-tracker.js` |

## PWA replay harness (added 2026-07-08)

The web-pipeline counterpart to the backend voice bench — replays recorded/authored
sessions through the REAL `RecordingProvider` (mock backend by default, zero tokens).
Full doc: `docs/reference/pwa-replay-harness.md`.

| Task | Command |
|------|---------|
| Replay the session-fixture corpus (mock) | `npm run pwa-replay` |
| One-command iOS-session differential (fetch→convert→replay→diff) | `npm run pwa-replay:session -- --session=<UUID>` |
| 116-field generated sweep | `npm run pwa-replay:sweep` |
| Dump behavioural traces | `npm run pwa-replay -- --trace-out=<dir>` |
| Regenerate/verify the sweep vs field_schema.json | `node scripts/pwa-replay/generate-field-sweep.mjs [--check]` |

Key facts: web sessions have NO `debug_log.jsonl` in S3 (ledger
`crosscutting/session-analytics-upload`) — hand-author them from CloudWatch
`client_diagnostic` while fresh (`tests/fixtures/pwa-replay-sessions/sess_mrbnds2d_jczh.yaml`
is the template). iOS conversions are `empty_fallback` fidelity unless you pass
`--initial-state=` (final `job_snapshot.json` minus session-applied fields). Mock frames
reconstruct from SERVER-ORIGIN (`sonnet/`) log events ONLY — never regex-category events.
