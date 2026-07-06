---
name: certmate-proof-and-analysis-toolkit
description: >-
  Load when you need to PROVE something in the CertMate/EICR repo instead of eyeballing it:
  decompose the dictate→confirm latency budget into component hops; prove a field actually
  crosses the WebSocket wire end-to-end (backend emit → wire → client dispatch); design ONE
  experiment that separates two competing hypotheses; account for AI cost per model/tier;
  score VLM/CV accuracy on the CCU photo corpus; run an A/B via the runtime kill-switch with
  instant rollback; or smoke-test a tool schema against the REAL Anthropic API. Each recipe
  is a method + a worked example from this repo's history. Do NOT load for tool-catalog
  lookups (certmate-diagnostics-and-tooling), the executable latency campaign itself
  (certmate-latency-campaign), symptom triage (certmate-debugging-playbook), or what counts
  as merge evidence (certmate-validation-and-qa).
---

# CertMate Proof-and-Analysis Toolkit

Seven first-principles analysis recipes. Each: **when to use → method → exact commands → what a conclusive result looks like**, with a worked example from this repo's own history. All paths repo-relative to the repo root (`EICR_Automation/`). Volatile facts date-stamped **as of 2026-07-06**.

Doctrine underlying all seven: **a claim without an instrument reading is a hypothesis, not a result.** This repo's most expensive failures (5+ blind TestFlight builds, 4 days of "Safari BFC quirk" commits, a week-long unsyncable job) all came from acting on plausible stories instead of measurements.

## When NOT to use this skill

| You actually want | Load instead |
|---|---|
| Catalog of every diagnostic script/endpoint and its flags | `certmate-diagnostics-and-tooling` |
| The numbered, decision-gated latency campaign (phases, gates, solution menu) | `certmate-latency-campaign` |
| Symptom → known-root-cause triage table | `certmate-debugging-playbook` |
| What evidence gates a merge/deploy; test-harness footguns | `certmate-validation-and-qa` |
| The `/api/sonnet-stream` frame shapes themselves | `certmate-voice-wire-protocol` |
| CCU pipeline internals and tuning vars | `certmate-ccu-pipeline` |
| Hypothesis→accepted-result lifecycle and evidence bar | `certmate-research-methodology` |
| Env-var / flag inventory | `certmate-config-and-flags` |

---

## Recipe 1 — Latency budget decomposition

**When:** any "voice feels slow" report, before proposing ANY fix. Audio-First invariant #3 makes latency a first-class bug; but the dictate→confirm loop crosses five components, and a fix aimed at the wrong hop is wasted work.

**The component chain** (dictate→confirm perceived latency):

```
inspector stops speaking
  → Deepgram end-of-turn detection      (Flux: eot_threshold=0.7, eot_timeout_ms=5000 — web/src/lib/recording/deepgram-service.ts:636)
  → transcript over WS to backend
  → Sonnet/Haiku extraction TTFT + tool loop rounds
  → confirmation synthesis (bundler)
  → ElevenLabs TTS time-to-first-byte
  → client audio decode + playback start
```

**Method:** measure each hop with its own instrument; attribute the budget; only then pick a target.

### Instruments, per hop

| Hop | Instrument | Pass criterion baked into script |
|---|---|---|
| Sonnet TTFT (cached) | `node scripts/voice-latency-bench/sonnet-ttft-bench.mjs` (needs `ANTHROPIC_API_KEY`; `--iters=N`, default 20; skips iter 1 from cached aggregate as warm-up) | P50 cached TTFT ≤ 900 ms |
| ElevenLabs TTFB | `ELEVENLABS_API_KEY=... node scripts/voice-latency-bench/elevenlabs-ttfb-bench.mjs --iters=20` | P50 BOS→first-audio ≤ 250 ms |
| ElevenLabs pooled-WS viability | `scripts/voice-latency-bench/elevenlabs-multi-stream` bench: `elevenlabs-multi-context-bench.mjs` (7 operational pass criteria; decides warm-pool vs one-shot WS) | aggregate verdict in output |
| Whole pipeline, scenario-driven | `npm run voice-test` → `scripts/voice-latency-bench/transcript-replay.mjs` — replays YAML transcript scenarios over the real `/api/sonnet-stream` WS as if it were iOS; asserts `expect.*` blocks; exit 0/1/2 | per-scenario pass + per-turn wall-clock |
| Regression sweep + cost | `npm run voice-regression` → report at `voice-regression-report.md` (pass/fail per scenario, per-turn wall-clock, Loaded Barrel hit/miss rate, token cost) | exit 0 |
| Production per-turn perceived latency | CloudWatch rows (below) | dashboard percentiles |

Cheap iteration: `./scripts/voice-latency-bench/run-cheap.sh --suite=baseline` routes the suite to Haiku 4.5 + 1h cache (`SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001`, `SONNET_CACHE_TTL=1h`; ~$0.18 first run, ~$0.02 repeats for 34 scenarios). The backend process must inherit the same env vars — restart `npm start` with them set. Full economics: `scripts/voice-latency-bench/HARNESS_COST_NOTES.md`. Final pre-commit check re-runs on prod-default model/TTL.

### Production telemetry (the field-truth instrument)

`src/extraction/voice-latency-turn-summary.js` emits per turn, joined on `{sessionId, turnId}`:

- `voice_latency.turn_core_summary` — Sonnet rounds, stop reasons, dispatch counts, server-side audible-first-byte timestamp (emitted synchronously at end of `runLiveMode`).
- `voice_latency.turn_audio_summary` — playback ACKs; emitted when all expected ACKs arrive OR the `FINALIZER_TIMEOUT_MS = 8000` finalizer fires (`voice-latency-turn-summary.js:119` — this constant is the open Phase-2.2 tuning target; see `certmate-latency-campaign`).
- `voice_latency.turn_perceived_latency_ms` — the canonical stopped-talking→audio-played row, paired in `src/extraction/voice-latency-perceived-latency.js` from `voice_latency.utterance_end` + the audio summary. Skipped-turn reasons emit as `voice_latency.turn_perceived_latency_skipped` with a `reason` field (`process_uptime_id_mismatch`, `no_audio_ack_at_ttl`, …) — read these too; they tell you which turns you are NOT measuring.

Query pattern (CloudWatch Logs Insights, log group `/ecs/eicr/eicr-backend`, region `eu-west-2`):

```
filter message = "voice_latency.turn_perceived_latency_ms" and expected_acks_eligible = 1
| stats avg(perceived_latency_ms), pct(perceived_latency_ms, 90) by bin(1h)
```

The logger serialises the event name as the JSON `message` field — `filter message = "..."` is the house convention. Insights has no SQL join; the split rows are designed for conditional aggregation over the shared scalar keys.

Per-session forensics: pull `s3://eicr-files-production/session-analytics/<userId>/<sessionId>/` (must contain `debug_log.jsonl`, `field_sources.json`, `manifest.json`) and run `node scripts/analyze-session.js <dir>` → `analysis.json` with `average_latency_ms` per event class.

**Conclusive result looks like:** a table attributing the P50/P90 budget per hop, with one hop clearly dominant, measured under both bench and field telemetry. NOT conclusive: "the whole loop took ~4s and Sonnet is probably it." If two hops trade dominance across turns, you have a variance problem, not a mean problem — report percentiles, never means alone.

---

## Recipe 2 — End-to-end wire contract testing

**When:** adding/renaming ANY field that crosses the `/api/sonnet-stream` WebSocket, or investigating "backend says it wrote it, client never shows it."

**The doctrine (born from Bug-I):** a wire field is not "done" until a test proves the full chain **backend emit → wire frame → client dispatch → model/state mutation**. Backend-only tests and client-only tests can BOTH be green while the field silently drops in the middle.

### Worked example: Bug-I (field session FA361D70, 2026-04-26)

- Backend Stage 6 emitted schema-canonical names (`measured_zs_ohm`, `r1_r2_ohm`, `ir_live_live_mohm`, `polarity_confirmed`, `rcd_time_ms`) straight from `config/field_schema.json`.
- iOS `applyExtractedReadings` dispatched on pre-Stage-6 legacy aliases (`zs`, `r1_r2`, `ir_live_live`, `polarity`, `rcd_trip_time`). Switch hit no case → **silent no-op**. Field truth: 6 successful backend tool calls; board-scoped readings landed; all 4 circuit readings vanished on iOS Build 302.
- Interim fix `e83a6017` added a bundler-side rename bridge; final state `17470ada` REVERTED the bridge once iOS Build 304 accepted canonical names natively — one vocabulary, zero translation layers, `field_schema.json` as the single source end-to-end. Lesson inside the lesson: a translation bridge is contract debt; converge the vocabulary instead.

### Method

1. **Name the emit site and the dispatch site by file:line before writing anything.** Backend emit: `src/extraction/sonnet-stream.js` + `src/extraction/stage6-event-bundler.js`. Web decode: `web/src/lib/recording/sonnet-session.ts` → `apply-extraction.ts`. iOS decode: `CertMateUnified/.../DeepgramRecordingViewModel.swift` `applySonnetReadings`. (Frame shapes: `certmate-voice-wire-protocol`.)
2. **Write the contract test at the WEAKEST link** — usually client dispatch. Assert the exact emitted string constant appears as a handled case, and that an unhandled name FAILS LOUDLY in the test (the production bug was precisely that unhandled = silent).
3. **Run the standing schema-parity gate:** `npm run check:ios-parity` (= `node scripts/check-ios-field-parity.mjs`, `--json` for machine output). It diffs every `field_schema.json` field against iOS `applySonnetReadings` `case` literals; MISSING = error, ORPHAN legacy alias = info. Born from session 6FF8A837: 6 × `ir_test_voltage_v` writes Sonnet made and iOS dropped. Requires the sibling `CertMateUnified/` checkout.
4. **For ported algorithms (not just names), pin cross-platform vectors:** `web/tests/confirmation-dedupe-key.test.ts` hard-codes hash vectors *generated by executing the backend module* (`src/extraction/ios-dedupe-key.js`), so web's TS port of the djb2-UInt64 dedupe key can never silently diverge. Copy this pattern for any backend↔client mirrored computation.
5. **Exercise the real wire when in doubt:** a `transcript-replay.mjs` scenario (Recipe 1) speaks the actual WS protocol and asserts on real frames — the only layer-skipping-proof harness in the repo.

**Conclusive result looks like:** one failing test BEFORE the fix that reproduces the silent drop, green after; plus `check:ios-parity` clean. NOT conclusive: "backend unit test shows the frame contains the field." The wire has three implementations kept in sync socially — as of 2026-07-06 there is no shared codegen; tests are the only enforcement.

---

## Recipe 3 — Discriminating-experiment design

**When:** two (or more) hypotheses explain the same symptom, and you're tempted to fix the more plausible one. Design ONE observation whose outcome differs between the hypotheses. Cost: usually minutes. Cost of skipping: this repo's record is 5 blind builds and 4 days of wrong CSS commits.

**Template:** H1 predicts observation O = X; H2 predicts O = Y; X ≠ Y; O is cheap to read. Run O first. Refuse to write a fix until O discriminates.

### Worked example A — WS7 storage shim (green-local / red-CI)

Symptom: web persist-failure tests passed locally, failed on CI, order-dependently.
- H1: CI flakiness / test-order interaction.
- H2: the environment differs — jsdom's real `Storage` silently IGNORES per-instance overrides (`localStorage.setItem = () => { throw }`), so quota-failure simulation never fired where the real Storage survived the install guard.
- Discriminator: does an overridden `setItem` actually throw when called on each environment's storage object? One log line per environment. Result: locally the guard had installed a Map shim (overridable) → tests "worked"; on CI the real Storage survived the `hasWorkingGetItem` guard → overrides were no-ops.
- Fix: install the Map-backed shim UNCONDITIONALLY (`web/tests/setup.ts:54-94`, comment block documents the whole proof). Regression guard: `web/tests/harness-leak-lock.test.ts`.

### Worked example B — redactPiiInPlace copy-on-write (prod data corruption)

Symptom (P0, 2026-05-27): address/postcode/client-name flipped to `[REDACTED]` in the DB and S3 after a job was opened.
- H1: a client (iOS/PWA) writes redacted values.
- H2: the backend logger's PII scrub mutates the live object it logs, and the handler then serialises the mutated object; clients faithfully persist what they received.
- Discriminator: does an object passed to `logger.info(..., { foo: liveObj })` come back mutated? A one-assert unit test — no client involved. It did: `redactPiiInPlace` in `src/logger.js` walked into caller-owned sub-objects. The GET handler in `src/routes/jobs.js` logged `installation_details` directly → response already redacted → clients persisted corruption on next auto-save.
- Fix: copy-on-write clone before recursing (`5bf304ac`) + stop logging live refs (`d5adb2e3`), with the discriminating test kept as the permanent regression pin ("caller-owned objects passed via logger meta come back unchanged"). Note the rejected alternative recorded in the commit: `structuredClone` at the format boundary also fixes it but allocates on every log call.

### Worked example C — data-vs-rendering: log at the assignment site

Standing house rule (from a 5-TestFlight-build incident chasing a "SwiftUI won't insert the saved message" bug that was actually an API returning `body: null`): **when two similar bindings driven by the same code path behave differently, the difference is in the value going in, not the rendering layer.** Log the value at the assignment site FIRST. Corollaries enforced here:
- 3+ builds/commits on the same symptom without new data → STOP fixing, START instrumenting. On this project that means `sendClientDiagnostic` (web: `web/src/lib/recording/client-diagnostic.ts`) over the WS → CloudWatch, or a scenario replay.
- CSS/layout version: pull `getComputedStyle` from the live DOM BEFORE naming a framework quirk — the `max-w-3xl` collapse was 4 days of "Safari BFC" hypotheses until one computed-style read showed Tailwind v4 `--spacing-*` tokens hijacking `max-w-*` (fix `e9a7cf92`).

**Conclusive result looks like:** the observation lands on exactly one hypothesis AND becomes a committed regression test. If the discriminator's outcome is compatible with both hypotheses, it wasn't a discriminator — redesign it, don't "lean" on it.

---

## Recipe 4 — Cost accounting per model/tier

**When:** adding any AI call site, changing a model, or validating margin claims (~£1/cert target). Also whenever a cost report shows a zero.

**THE ZEROS RULE:** a cost bucket reading 0 for a tier you KNOW ran is a **wire-up bug, not "no traffic."** Worked example: field session 2D391936 (2026-04-28) showed `"sonnet": { turns: 0, cost: 0 }` despite 8 `server_extraction_received` events — the Stage 6 tool loop never read `stream.finalMessage().usage`, so every live extraction since the cutover was billed by Anthropic but invisible to margin tracking. Fix `50445eb8` sums per-round usage into `CostTracker.addSonnetUsage`, once per loop (NOT per round — `turns` must keep meaning "user utterances processed", the key dashboards join on).

### Where the numbers live (as of 2026-07-06)

| Surface | Source | Notes |
|---|---|---|
| Live voice-session costs | `src/extraction/cost-tracker.js` (`CostTracker`) | Deepgram $0.0077/min; Anthropic `MODEL_RATES` keyed sonnet/haiku/opus with cacheRead 0.1× and cacheWrite 1.25× base input; ElevenLabs **per-model char buckets** `elevenLabsCharsByModel` — Flash/Turbo $0.00005/char, Multilingual-v2/v3 $0.0001/char, `ELEVENLABS_RATE_PER_CHAR` only as unknown-model fallback. `elevenLabsCharacters` is a derived getter (sum of buckets). `totalCost` getter = deepgram + sonnet + elevenLabs + gptVision. |
| Wire to client | `cost_update` frames on `/api/sonnet-stream` | via `toCostUpdate` |
| Session forensics | `analysis.json` from `scripts/analyze-session.js` | consumes CostTracker output in the session dump |
| Legacy document pipeline | `src/token_logger.js` → `token_usage.csv` | GPT/Gemini doc-extraction accounting ONLY (headers: `gemini_tokens,gemini_cost,gpt_tokens,gpt_cost,...`). NOT voice costs — do not read voice margin from this file. Last local row 2026-04-10. |
| Harness/bench spend | `scripts/voice-latency-bench/HARNESS_COST_NOTES.md` + the `run-cheap.sh` header ballparks | Haiku+1h-cache ≈ 10× cheaper per scenario than Sonnet+5m |

### Method for a new call site

1. Identify the tier (Anthropic model family / ElevenLabs model / Deepgram / GPT Vision) and thread `usage` (or char count + `modelId`) into the matching `CostTracker` accumulator — never a new ad-hoc counter.
2. For streamed Anthropic calls, the usage lives on `finalMessage().usage` — the exact read the zeros bug missed.
3. Prove it end-to-end: run one real session/scenario, then assert the bucket is NON-ZERO in `cost_update` / `analysis.json`. A green unit test on the accumulator alone does not prove the call site feeds it.
4. Known scope gap (open, as of 2026-07-06): the fast-TTS route `src/routes/voice-latency-fast-tts.js` has no cost attribution — deliberately out of scope in the 2026-06-26 consolidation. Don't "discover" it as a bug; do route any fix through change control.

**Conclusive result looks like:** every tier that ran in a probe session shows a non-zero bucket, and the sum reconciles with the provider dashboard to within rounding. NOT conclusive: "the rate table looks right."

---

## Recipe 5 — VLM/CV accuracy evaluation on the CCU corpus

**When:** touching anything in the CCU photo-extraction path (`certmate-ccu-pipeline` has the pipeline itself), or evaluating a new model/prompt for it. Never judge a CCU change by one photo.

**THE SCORING DOCTRINE — blank beats guessed wrong (asymmetric loss).** Derek, 2026-05-05, after a majority-fill "fix" reached prod: *"I would rather it be blank than guessed wrong. They're often C-types mixed in with B-types for motors and things."* Board-majority guessing was reverted same day (`aa529115`). Consequence for ANY evaluation you run: score a wrong positive (wrong curve/rating/type on a slot) strictly worse than a null. An accuracy metric that rewards guessing (plain per-field accuracy) is the wrong metric here — report at minimum: correct / blank-but-present (miss) / wrong-value (fabrication), and treat fabrications as the headline number. This doctrine is also why the failed `EDGE_SEARCH_PAD` widening experiment was *documented* rather than silently dropped (`0dadcbbd`) — negative results are corpus knowledge.

### The corpus (as of 2026-07-06)

- `scripts/ccu-cv-corpus/raw/<extractionId>/` — 52 entry dirs; `manifest.json` says 48 valid entries, 32 unique photos (image-hash deduped). Each entry: `original.jpg` + `result.json` (prior pipeline output).
- `annotations.json` — hand-verified ground truth (`groundTruth` = total visible module slots; RCD=2, main switch=2, blanks=1 each). **Only 3 entries annotated** — the ground-truth set is thin; extend it before claiming corpus-level accuracy. Rebuild manifest after adding photos: `node scripts/ccu-cv-corpus/build-manifest.mjs`.

### Harnesses

| Command | What it exercises | Cost/network |
|---|---|---|
| `ANTHROPIC_API_KEY=... node scripts/ccu-local-run.mjs <photo.jpg> [--roi=x,y,w,h] [--dump-crops=DIR] [--dump-overlay=f.jpg]` | The **per-slot pipeline** end-to-end, no HTTP/S3/DB | ~$0.04/photo. **CAVEAT:** its header still says "per-slot is the only path" — STALE. The live prod path is single-shot `gpt-5.5` (`src/extraction/ccu-single-shot.js`, `CCU_USE_SINGLE_SHOT=true` in the task def); this harness exercises the LEGACY FALLBACK. No offline single-shot harness exists in `scripts/` as of 2026-07-06 — evaluate the live path via `POST /api/analyze-ccu` against a local backend, or write one. |
| `node scripts/ccu-cv-prototype.mjs [--id <extractionId>] [--stress]` | Pure-CV module-pitch detection vs `annotations.json` ground truth | zero API calls, ~50-100 ms/photo, debug PNGs to `scripts/ccu-cv-corpus/debug/` |
| `node scripts/ccu-box-tighten.mjs [--id <id>] [--stress]` | Rail-bbox correction from the user's RoI hint | zero API calls |
| `ANTHROPIC_API_KEY=... node scripts/ccu-sliding-window.mjs <photo> [--window-mod=5] [--stride-mod=2] [--dry-run]` | Exploratory sliding-window + clustering design (v5 mock) | experimental, not the live path |

### Method

1. Fix the photo set BEFORE running anything (list extractionIds); never cherry-pick after seeing results.
2. Run baseline (current live config) and candidate on the SAME set, same order.
3. Score per slot with the asymmetric rubric above; break out the known in-scope failure modes separately (long identical-MCB-run miscounts, label-column misalignment, phase-walking) so a candidate that fixes one doesn't hide regressing another.
4. `--stress` variants (loose/tight boxes) are part of the bar — field RoI hints are sloppy.
5. A candidate that only wins on annotated-count photos with n=3 has proven nothing; annotate more or say so.

**Conclusive result looks like:** candidate strictly reduces fabrications without increasing misses on a fixed, named photo set, including stress variants. NOT conclusive: "it got the Wylex board right now."

---

## Recipe 6 — A/B via runtime kill-switch with instant rollback

**When:** you need production truth about a risky behavioural change (model swap, provider config) and a lab bench can't settle it — AND a runtime flag already exists or is worth building.

### Worked example: the web STT Flux flip

Infrastructure (built WS4, 2026-07-03): `DEEPGRAM_STT_MODEL` is the web frontend's ONLY runtime flag (as of 2026-07-06: `"flux"`, flipped from `nova3` by `ff620997` after field-reported nova-3 partial-sentence sends). Fail-safe + route mechanics: **certmate-config-and-flags §5b** (single home). What matters for this recipe: the `SAFE_STT_MODEL` fail-safe means an A/B arm can never brick recording (worst case degrades to the safe model), and a task-def-only commit hits the CI `frontend-taskdef` fast path — **~3-5 min flip/rollback, no rebuild** (flip recipe: `certmate-run-and-operate` §4a).

### Method

1. **Pre-register the metric and the numbers** (see `certmate-research-methodology`): what CloudWatch row / session-forensic field decides the winner, and what value flips the decision. The Flux flip's trigger was a specific field defect (partial-sentence sends), not vibes.
2. Flip via source commit to the task-def + push to `main`; watch with `gh run watch <run-id> --exit-status`. **NEVER `aws ecs register-task-definition` by hand** — the MANDATORY infra-from-source rule exists because live-only edits were silently dropped by the next deploy twice (`CCU_DEWARP_OUTPUT_WIDTH`, `JWT_SECRET`). This recipe does not route around change control; the kill-switch's speed comes from the small diff, not from bypassing CI.
3. Collect N field sessions (1-2 minimum for behavioural flags — the project's convention for voice changes), reading the pre-registered metric from CloudWatch/`analyze-session.js`, not from memory of how it felt.
4. Decide: keep (flag value becomes the documented default; update `certmate-config-and-flags`' facts + changelog row) or revert (same 3-5 min path). Either way the outcome gets a changelog row — a reverted A/B with a recorded reason is a success of the method.
5. Sequential A/B (before/after across sessions) is the house pattern — there is no percentage-split infrastructure; don't claim "A/B test" statistics a sequential design can't support.

**Conclusive result looks like:** pre-registered metric read on both arms from production telemetry, decision recorded, rollback path proven unused-but-ready. NOT conclusive: "it sounded better in one AirPods session."

---

## Recipe 7 — Schema/API smoke against the REAL provider

**When:** authoring or changing any Anthropic tool `input_schema`, or adopting any provider feature your local toolchain merely *simulates* (JSON-Schema validation, strict mode, prefill behaviour).

**THE RULE: local validators lie about provider acceptance.** Worked example (`7f3a33ac`, 2026-04-26, "Bug A" of the 57 Overdown Road analysis):
- `record_reading.confidence` carried `minimum: 0, maximum: 1`. Every draft-07 validator locally: fine. Production: **every Stage 6 shadow turn 400-ed** with `tools.0.custom: For 'number' type, properties maximum, minimum are not supported` — Anthropic strict-mode tools reject numerical constraints on number/integer types at request time.
- Why dev never caught it: the SDKs auto-strip these keywords, but the raw-HTTP path ships them; AND the existing probe (`scripts/stage6-strict-mode-probe.js`) only exercised `delete_observation`, which has no numeric fields. A smoke test that doesn't cover the failing shape is a false green.
- Why a test pinned the bug: `expect(fromRef.minimum).toBe(1)` asserted the broken schema. Tests encode beliefs; when the provider disagrees, the test must flip.
- Fix pattern (copy it): remove the constraint from the schema; move the bound into the property `description` (model still sees the contract at prompt time) AND into the dispatcher-side validator (`validateRecordReading` — structured `validation_error.code` on violation). Contract visible, contract enforced, schema accepted. Live comment: `src/extraction/stage6-tool-schemas.js:218-226`.

### Method

1. Before merging a schema change, send ONE real request per changed tool to the live API with the exact production schema bytes. Template: `scripts/stage6-strict-mode-probe.js` (`ANTHROPIC_API_KEY=... node scripts/stage6-strict-mode-probe.js`; exit 0 = strict enforcement confirmed, 1 = hard failure, 3 = ambiguous — read its header, ambiguity is a documented outcome, not a pass).
2. Cover every JSON-Schema keyword you rely on (enum, minItems, pattern, const…), on the field TYPES you actually use — the probe's blind spot was type coverage, not keyword coverage.
3. Grep CloudWatch for `tools.` 400s after deploy — shadow-mode made this bug visible without user impact; prefer shadow/canary exposure for schema changes when available.
4. Related provider truths already paid for (as of 2026-07-06, re-verify before relying): assistant-message prefill is unreliable on current Sonnet — use `tool_choice` for structured output; `cache_control` blocks are limited to 4 — strip stale breakpoints before adding the newest or requests 400 after ~33 turns.

**Conclusive result looks like:** a real-API request/response transcript (status + error text or parsed `tool_use.input`) attached to the change. NOT conclusive: "ajv validates it" or "the SDK accepted it" (the SDK may be silently rewriting your schema).

---

## Provenance and maintenance

Re-verify before relying on drift-prone facts:

| Fact (as of 2026-07-06) | One-line re-verification |
|---|---|
| Bench scripts + npm aliases (`voice-test`, `voice-regression`) | `grep -n "voice-test\|voice-regression" package.json && ls scripts/voice-latency-bench/` |
| `FINALIZER_TIMEOUT_MS = 8000` | `grep -n "FINALIZER_TIMEOUT_MS = " src/extraction/voice-latency-turn-summary.js` |
| Telemetry row names (`turn_core_summary`, `turn_audio_summary`, `turn_perceived_latency_ms`) | `grep -rn "voice_latency\.turn" src/extraction/voice-latency-turn-summary.js src/extraction/voice-latency-perceived-latency.js \| head` |
| Flux eot params (web) | `grep -n "eot_threshold\|eot_timeout_ms" web/src/lib/recording/deepgram-service.ts \| head -4` |
| ElevenLabs per-model buckets in CostTracker | `grep -n "ELEVENLABS_RATE_PER_CHAR_BY_MODEL\|elevenLabsCharsByModel" src/extraction/cost-tracker.js \| head` |
| iOS field-parity gate | `npm run check:ios-parity` (needs sibling `CertMateUnified/` checkout) |
| Cross-platform hash vectors pattern | `grep -n "backend-mirror" web/tests/confirmation-dedupe-key.test.ts` |
| Storage shim still unconditional | `grep -n "Install UNCONDITIONALLY" web/tests/setup.ts` |
| CCU corpus size + annotation coverage | `python3 -c "import json;m=json.load(open('scripts/ccu-cv-corpus/manifest.json'));a=json.load(open('scripts/ccu-cv-corpus/annotations.json'));print(m['totalEntries'],m['uniquePhotos'],len(a['annotations']))"` |
| Live CCU path is single-shot (harness header is stale) | `grep -n "CCU_USE_SINGLE_SHOT" ecs/task-def-backend.json src/routes/extraction.js \| head -3` |
| `DEEPGRAM_STT_MODEL` current task-def value | `grep -n "DEEPGRAM_STT_MODEL" ecs/task-def-frontend.json` |
| `frontend-taskdef` fast path exists | `grep -n "frontend-taskdef" .github/workflows/deploy.yml \| head -3` |
| Anthropic strict-mode minimum/maximum rejection comment | `grep -n "minimum" src/extraction/stage6-tool-schemas.js \| head -3` |
| S3 session-analytics prefix | `grep -rn "session-analytics/" src/routes/recording.js \| head -1` |

**Labeled uncertainties (open — do not state as fact):**
- `run-harness-against-prod.sh` mints a JWT via `POST /api/test/harness-mint-jwt`, gated by `STAGE0_BENCH=1` + `X-Bench-Secret`; `STAGE0_BENCH=1` IS set in `ecs/task-def-backend.json:41` as of 2026-07-06 (see `certmate-config-and-flags`) — but re-check (`grep -n STAGE0_BENCH ecs/task-def-backend.json`) before relying on prod replay, as it is slated for removal when the latency sprint closes.
- The `turn_perceived_latency_ms` field coverage target (≥90% of ACK-eligible turns) was 0% at the 2026-06-05 plan date pre-fix; current live coverage is UNVERIFIED — read the dashboard before quoting a number.
- Bench pass criteria (TTFT ≤900ms P50 cached, TTFB ≤250ms P50) are the 2026-05 plan-era bars; whether they remain the campaign's current gates is owned by `certmate-latency-campaign`.
