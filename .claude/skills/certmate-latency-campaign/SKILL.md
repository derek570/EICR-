---
name: certmate-latency-campaign
description: >
  Load this skill when the task is about the dictate->confirm voice latency loop:
  measuring, diagnosing, or reducing the time between an inspector finishing an
  utterance and hearing the spoken read-back. Triggers: "latency", "slow read-back",
  "perceived latency", "TTFT", "TTFB", "FINALIZER_TIMEOUT_MS", "fast-path TTS",
  "loaded barrel", "speculator", "playback telemetry", "voice-latency-bench",
  "Phase 2.2", "WS3b item 4/5", or any field report that the confirm loop "feels slow".
  Do NOT load for: general voice-pipeline bugs (wrong values, loops, mishears ->
  certmate-debugging-playbook), the WS frame catalogue (certmate-voice-wire-protocol),
  measurement-tool reference outside a latency campaign (certmate-diagnostics-and-tooling),
  or CCU photo extraction (certmate-ccu-pipeline).
---

# CertMate Latency Campaign — dictate->confirm loop

**Mission.** Reduce *perceived latency*: end-of-utterance (inspector stops talking) to first audible byte of the spoken read-back. This is Audio-First invariant #3 in `CLAUDE.md` ("latency is a first-class concern; regressions are bugs, not cosmetics"). This skill is an executable, decision-gated campaign: run Phase 0, then follow the gates. **Success is a measured number moving; never a judgement by ear alone.**

Definitions (used throughout):
- **Dictate->confirm loop**: inspector speaks a reading -> Deepgram transcribes -> backend Sonnet/Haiku tool-loop extracts -> confirmation text synthesised -> ElevenLabs TTS -> client plays audio.
- **TTFT**: time to first token from the extraction LLM. **TTFB**: time to first audio byte from ElevenLabs. **BOS**: begin-of-stream message on the ElevenLabs WS.
- **Loaded Barrel (speculator)**: `src/extraction/loaded-barrel-speculator.js` — pre-synthesises confirmation MP3s the moment a tool call streams in, before the turn completes, so playback can start on client claim.
- **Fast-path TTS (Mode A)**: `POST /api/voice-latency/regex-fast-tts` — client regex-extracts an eligible numeric reading and gets confirmation audio back WITHOUT waiting for the LLM turn.
- **Finalizer**: `src/extraction/voice-latency-turn-summary.js` — per-turn telemetry aggregator that waits `FINALIZER_TIMEOUT_MS = 8000` (line 119) for playback ACKs before emitting `voice_latency.turn_audio_summary`.

## Ground rules (non-negotiable, from CLAUDE.md change control)

1. **Backend is SHARED with iOS and IMMUTABLE during PWA-only work.** Most latency knobs are backend (`src/`, `ecs/task-def-backend.json`). Touching them requires an explicit cross-platform mandate — i.e. a plan that names the backend change, its iOS impact, and a Web-companion section. If your task arrived as "web parity" or "PWA fix", you may NOT tune backend latency knobs inside it. Escalate instead. See `certmate-change-control`.
2. **Infra/env changes from source only**: flag flips go in `ecs/task-def-backend.json` (or `-frontend.json`) + commit, deployed via CI. Never `aws ecs register-task-definition` by hand as the canonical change.
3. **Never suppress or double a read-back to save time.** Audio-First #1/#2: every dictated reading is read back exactly once. Any "optimisation" that drops, defers-forever, or repeats a confirmation is a product-invariant violation, not a latency win.
4. **All promotion routes through bench + field evidence** (see "Validation and promotion" below).

## The latency budget (where every millisecond lives)

As of 2026-07-06. Hops in wall-clock order; "knob location" = the file you would read first.

| # | Hop | Mechanism | Knob location | Measured / expected |
|---|-----|-----------|---------------|---------------------|
| 1 | Mic -> Deepgram | 16 kHz PCM over direct Deepgram WS. iOS + web both on Flux `flux-general-en` `/v2/listen` (web flipped 2026-07-03, runtime kill-switch `DEEPGRAM_STT_MODEL=flux` in `ecs/task-def-frontend.json:31`) | web: `web/src/lib/recording/deepgram-service.ts` (`buildFluxURL`, ~80 ms/1280-sample batcher) | Turn detect: `eot_threshold: '0.7'`, `eot_timeout_ms: '5000'` (deepgram-service.ts:636-637; defaults mirrored :1028-1029). The 0.7 threshold IS end-of-turn wait time — Flux fires EndOfTurn when confidence crosses it. |
| 2 | Pre-LLM gate | `src/extraction/pre-llm-gate.js` blocks filler/chitchat before it costs a Sonnet turn (born from a 2026-05-26 field session that burnt ~£0.30 on 14 junk transcripts). Web mirror: `web/src/lib/recording/transcript-gate.ts` | trigger word lists in `pre-llm-gate.js` | ~0 ms added; saves whole wasted turns. Not a tuning target for latency — it is a correctness/cost gate. |
| 3 | LLM extraction TTFT + completion | Server tool loop `src/extraction/stage6-tool-loop.js`. Live model `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001` (`ecs/task-def-backend.json:53`) | model via task-def; optional round-1 override `VOICE_LATENCY_ROUND1_MODEL` (currently `""` = off, `stage6-tool-loop.js:390-395`) | Recorded 2026-05-23 on **Sonnet 4.6** (`sonnet-ttft-bench-result.json`): cached TTFT p50 947 ms (missed the ≤900 ms gate), p95 1344 ms; completion p50 1611 ms; cold TTFT 1119 ms. **No recorded Haiku 4.5 baseline exists — record one in Phase 0.** |
| 4 | Speculator (Loaded Barrel) | `loaded-barrel-speculator.js` `onToolUseStreamed` (stage6-tool-loop.js:424-427) pre-synths confirmation audio mid-stream, parked in cache for client claim | `VOICE_LATENCY_LOADED_BARREL=true`, `_MAX_PER_TURN=12` prod (code default 2, `voice-latency-config.js`); pre-synth cost gate `CONFIRMATION_MIN_CONFIDENCE = 0.8` (`src/extraction/confirmation-text.js:193` — speculator gate ONLY, never a read-back gate) | Hides ElevenLabs synth time behind LLM completion. Hit/miss rate reported by `npm run voice-regression`. |
| 5 | Confirmation synthesis | `stage6-event-bundler.js` builds `confirmations[]` riding on the `extraction` frame; `buildConfirmationText` shared with speculator + fast-path so all three emit byte-identical text | `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` prod | Included in hop 3 completion. |
| 6 | ElevenLabs TTFB | Streaming WS, `eleven_flash_v2_5` | multi-context pool: `VOICE_LATENCY_USE_MULTI_CONTEXT=true` prod | Recorded 2026-05-23 (`elevenlabs-ttfb-bench-result.json`): BOS->first-audio p50 206 ms (PASS ≤250 gate), p95 1336 ms (first-iteration cold WS); WS open p50 133 ms. Multi-context probe 6/7 tests pass (`elevenlabs-multi-context-bench-result.json`, t6 voice-continuity failed — known). |
| 7 | Client playback | iOS AVAudioPlayer / web `tts.ts` FIFO queue (`web/src/lib/recording/tts-queue.ts`, shipped 2026-07-06 PR #85) | web: `tts.ts` two-path split (confirmations FIFO, prompts direct+preempt) | **Unmeasured on web** — no playback telemetry (menu item c). iOS measures via playback-ack. |
| 8 | Telemetry close-out | `POST /api/voice-latency/utterance-end` + `POST /api/voice-latency/playback-ack` paired on one iOS monotonic clock -> CloudWatch `voice_latency.turn_perceived_latency_ms` | `voice-latency-turn-summary.js`; `FINALIZER_TIMEOUT_MS = 8000` (line 119) | This is the ONLY end-to-end perceived-latency number. Web contributes nothing to it today. |

Prod flag block: `ecs/task-def-backend.json:41-50` (`STAGE0_BENCH=1`, `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`, `SUPPRESSION=false`, `REGEX_FAST_TTS=true`, `STREAM_ASK_USER=false`, `USE_MULTI_CONTEXT=true`, `LOADED_BARREL=true`, `LOADED_BARREL_MAX_PER_TURN=12`, `ROUND1_MODEL=""`, `KILL_SWITCH=false`). Flags snapshot per session at `session_start`; only `KILL_SWITCH` is read live (`src/extraction/voice-latency-config.js`).

## Phase 0 — Baseline measurement

Do NOT propose fixes before completing this phase. Each command is copy-pasteable from repo root.

### 0.1 Component benches (no backend needed)

```bash
# LLM TTFT/completion — defaults to claude-sonnet-4-6 in-script; 20 iters
ANTHROPIC_API_KEY=... node scripts/voice-latency-bench/sonnet-ttft-bench.mjs --iters=20 --output=/tmp/ttft.json

# ElevenLabs TTFB from this machine (representative of eu-west-2 within ~10ms per script header)
ELEVENLABS_API_KEY=... node scripts/voice-latency-bench/elevenlabs-ttfb-bench.mjs --iters=20 --output=/tmp/ttfb.json
```

Expected (recorded 2026-05-23, checked into `scripts/voice-latency-bench/*-result.json`):

| Bench | p50 | Gate | Status |
|---|---|---|---|
| Sonnet 4.6 cached TTFT | 947 ms | ≤900 ms | FAIL by ~5% |
| Sonnet 4.6 completion | 1611 ms | — | (sets ~12 s suppression TTL suggestion) |
| ElevenLabs flash_v2_5 BOS->audio | 206 ms | ≤250 ms | PASS |

**Gap you must fill: the live model is Haiku 4.5, and the TTFT bench has never been recorded against it.** The bench script hard-codes `claude-sonnet-4-6` — to measure the live config, edit a local copy of the model constant or record the number from harness per-turn wall-clocks (0.2). **Record the Haiku 4.5 TTFT/completion baseline here (in your campaign notes/plan) before proposing any hop-3 change.**

Gates:
- If ElevenLabs p50 > ~300 ms repeatedly -> network/vendor regression; check region + model id before touching anything else.
- If LLM completion p50 regressed >20% vs your recorded baseline -> prompt/snapshot growth is the suspect (`HARNESS_COST_NOTES.md`: ~30 KB system + 5-20 KB snapshot); diff prompt sizes before blaming the API.

### 0.2 Pipeline regression + per-turn wall-clock (in-process, real LLM)

```bash
npm run voice-regression            # all 26 baseline scenarios; report -> voice-regression-report.md
npm run voice-regression -- --filter=designation
```

Runs `transcript-replay-direct.mjs` (no HTTP/WS — imports the extraction pipeline in-process; auto-fetches `ANTHROPIC_API_KEY` from Secrets Manager `eicr/api-keys` if unset; forces `VOICE_LATENCY_LOADED_BARREL=true`, max-per-turn 2). Report includes pass/fail, per-turn wall-clock, Loaded Barrel hit/miss/absent rate, token cost. Exit 0 = all pass.

**Before treating any failure as a regression, read `tests/fixtures/voice-latency-scenarios/KNOWN_FLAKY.md`** — some scenarios are deliberately kept at ~50% pass because the flake IS the signal. Never delete a failing scenario; that file explains the 2026-06-01 deletion mistake that would have masked a real field bug.

### 0.3 Full WS-path replay (needs a running backend)

```bash
# Terminal 1: backend with cheap-model env (cache key includes model — backend MUST share these vars)
SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001 SONNET_CACHE_TTL=1h npm start
# Terminal 2:
./scripts/voice-latency-bench/run-cheap.sh --suite=baseline --user=<email> --password=<pw>
```

`run-cheap.sh` wraps `transcript-replay.mjs` (real WS to `/api/sonnet-stream`, replays YAML scenarios from `tests/fixtures/voice-latency-scenarios/`, evaluates `expect.*`). Cost anchors (`HARNESS_COST_NOTES.md`, based on 2026-06-01 pricing): Haiku+1h-cache ~$0.02/suite warm; Sonnet+5m-cache (prod-like) ~$1.70/suite. Exit codes: 0 pass, 1 scenario fail, 2 usage/connection error.

Against production (STAGE0_BENCH=1 is live in the prod task-def as of 2026-07-06, so the mint endpoint works):

```bash
./scripts/voice-latency-bench/run-harness-against-prod.sh   # mints JWT via /api/test/harness-mint-jwt using JWT_SECRET from Secrets Manager
```

### 0.4 Field truth — the only number that counts

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 24h --filter-pattern 'turn_perceived_latency_ms'
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 24h --filter-pattern 'turn_audio_summary'
```

Event vocabulary (all emitted by `voice-latency-turn-summary.js`): `voice_latency.utterance_end`, `voice_latency.turn_audio_summary`, `voice_latency.turn_core_summary`, `voice_latency.late_playback_ack`, `voice_latency.turn_perceived_latency_ms`, `voice_latency.turn_summary_emit_error`, `voice_latency.perceived_latency_emit_error`.

Per-session forensics: download a session-analytics dir from `s3://eicr-files-production/session-analytics/<userId>/<sessionId>/` (needs `debug_log.jsonl`, `field_sources.json`, `manifest.json`) then:

```bash
node scripts/analyze-session.js /path/to/session-dir/   # writes analysis.json: avg extraction latency_ms, per-utterance capture latencies
```

**Record here in your plan: current field p50/p95 `turn_perceived_latency_ms` over the last 1-2 field sessions.** No repo file records a current field number as of 2026-07-06 — the campaign's first deliverable is that recorded baseline.

## Phase 1 — Attribution (which hop is eating the time?)

Using Phase 0 outputs, attribute the perceived-latency p95 to hops. Gates:

| Observation | Branch to |
|---|---|
| `turn_audio_summary` rows show `ios_playback_ack: []` on a large fraction of eligible turns (the Phase-2.2 handoff measured ~47%) | Menu item (a) — the telemetry itself is broken/incomplete before latency can even be measured; fix measurement first |
| LLM completion (hop 3) dominates: harness per-turn wall-clock >> ElevenLabs TTFB + playback | Menu item (d) speculator coverage, then (b) fast-path for regex-eligible fields; consider `VOICE_LATENCY_ROUND1_MODEL` as an open experiment (labelled candidate — no recorded result) |
| Loaded Barrel miss/absent rate high in `voice-regression-report.md` | Menu item (d) — find why speculation didn't fire (confidence gate 0.8? slot invalidation? board transition prune?) before adding anything new |
| ElevenLabs TTFB p50 fine but p95 spiky with WS-open cost | Multi-context pool health — `VOICE_LATENCY_USE_MULTI_CONTEXT` already on; check `elevenlabs-multi-context-bench.mjs` t6-class failures |
| Web sessions feel slow but iOS fine | Items (b)+(c) — web lacks BOTH fast-path TTS and playback telemetry (ledger rows `recording/fast-path-tts`, `recording/playback-telemetry`, both `missing`, verified 2026-07-02); also check web TTS FIFO deferral (`tts-queue.ts` last-mile gate) isn't holding audio |
| Latency fine in harness, bad in field | Deepgram end-of-turn wait (hop 1) or client playback (hop 7) — neither is exercised by the replay harness (it injects transcripts, not audio) |

## Phase 2 — Ranked solution menu (with obligations)

Ranked by evidence-per-effort as of 2026-07-06. Each item lists what you MUST do before/with it.

**(a) The open Phase-2.2 decision: `FINALIZER_TIMEOUT_MS` widen vs iOS `local_fallback` ACK emit.** Status: OPEN, deliberately deferred from PR #52 (2026-06-05) until 1-2 field sessions run on the deployed correlation-fix code. The decision logic (from the converged plan in `CertMateUnified/.planning-stage6-agentic/handoffs/voice-latency-correlation-fix-2026-06-05/PLAN-final.md` — note: hub CLAUDE.md links a `FOLLOWUP.md` there that does not exist on disk; PLAN-final.md carries the content): default = make the iOS Apple-native fallback paths emit `source: 'local_fallback'` playback-acks (they currently cannot ACK at all), and widen the 8 s finalizer timeout ONLY if field evidence shows late ACKs arriving after 8 s on bundler/local_fallback paths. Obligations: pull the field evidence FIRST (`late_playback_ack` + `turn_audio_summary` CloudWatch rows); the iOS emit is a TestFlight cycle; the timeout widen is one backend constant (`voice-latency-turn-summary.js:119`) but is telemetry-accuracy work, not a user-perceived speedup — do not sell it as one.

**(b) WS3b item 4 — web fast-path TTS.** Backend is LIVE (`POST /api/voice-latency/regex-fast-tts`, route `src/routes/voice-latency-fast-tts.js:130`, prod flag `VOICE_LATENCY_REGEX_FAST_TTS=true`); web consumption is ABSENT (verified: zero hits in `web/src/`; ledger row `recording/fast-path-tts` = `missing`). This is the biggest single web perceived-latency win available: eligible numeric readings skip the whole LLM turn. Obligations (all pinned by the route header — read it before coding): hard whitelist only (`src/extraction/regex-fast-eligibility.js`; 422 on anything else), advertise capability `regex_fast_v2` ONLY after the client implements bypass-defer playback + playback-ack POST + **no native-TTS fallback on 4xx/5xx** (speaking a value the backend rejected is unsafe), client-minted UUIDv4 `correlationId`, MP3 `mp3_22050_32` only. The web TTS FIFO already pre-wired `purge(prefix)`/`cancelKey` hooks for this (`tts-queue.ts`, 2026-07-06). Web-only change -> allowed under parity rules; ledger row update mandatory.

**(c) WS3b item 5 — web playback telemetry.** Prerequisite for ever MEASURING web perceived latency; without it web is invisible to the `turn_perceived_latency_ms` dashboard. Port the iOS pattern: POST `/api/voice-latency/utterance-end` (source `deepgram_utterance_end`/Flux EndOfTurn) + `/api/voice-latency/playback-ack` (source `bundler`) with `monotonic_at_ms` from one clock (`performance.now()` equivalent) + `process_uptime_id`. Advertise `client_playback_telemetry` capability only after live. Ledger row `recording/playback-telemetry` = `missing`. Do (c) before or with (b) — otherwise the fast-path's win cannot be demonstrated in numbers.

**(d) Speculator / Loaded Barrel tuning.** Live and on (`_MAX_PER_TURN=12` prod). Levers, in order of safety: (1) diagnose misses via `voice-regression` hit/miss report and `speculative_terminal_reason` telemetry; (2) the `CONFIRMATION_MIN_CONFIDENCE=0.8` pre-synth gate — lowering it speculates on more slots (more ElevenLabs spend on discards; cost-integrity invariant `charsCompleted+charsCancelled+charsFailed === charsStarted` must keep holding, see speculator header); (3) per-turn cap. Obligations: any gate/cap change needs a before/after `voice-regression` hit-rate diff AND a cost delta from `cost-tracker` buckets. Remember this constant is NOT a read-back gate — read-backs are universal (2026-06-18 changelog); do not reintroduce confidence-gated speech.

**(e) Streaming knobs already ON — verify, don't re-add.** `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` (confirmations stream on the extraction frame), `USE_MULTI_CONTEXT=true` (ElevenLabs context pool). `STREAM_ASK_USER=false` remains experimental-off — flipping it is a candidate experiment, not a proven win; treat via the full validation protocol. `VOICE_LATENCY_ROUND1_MODEL` (empty = off) can route round-1 to a faster model — no recorded experiment as of 2026-07-06; label candidate.

## Fenced-off wrong paths (do not resurrect)

| Dead end | Evidence | Why it stays dead |
|---|---|---|
| Amplitude-based TTS barge-in (web) | reverted `6b55b58d` 2026-05-18 ("was killing every TTS via mic echo"), after two fix attempts (`cc4082e0`, `aca33275`) | Mic-level triggers cannot distinguish inspector speech from the device's own TTS echo. Echo-suppression fingerprinting is the replacement. |
| Round-1 early-terminate predicate | DELETED entirely `1db6230a` 2026-06-17 (module, flag `VOICE_LATENCY_ROUND1_EARLY_TERMINATE`, telemetry, tests) | Skipping round 2 removed the agent's self-correction pass and "ruined the feel of the app" (owner verdict). The 2026-05-28 changelog rows about widening it are historical. A latency idea that trades away extraction quality is a net loss. |
| Confidence-gated read-back suppression | `VOICE_LATENCY_SUPPRESSION=false` prod; universal read-back shipped 2026-06-18 | Violates Audio-First #1/#2 — a dropped read-back is invisible to a hands-free inspector. Never gate speech on Haiku's self-reported confidence. |
| Anything that speaks a value twice or zero times | Audio-First #1 ("exactly once"); the 2026-07-06 web TTS FIFO exists precisely to fix a read-back that was cancelled 5 ms in | Latency work touching TTS paths must preserve the exactly-once property; the FIFO's `onDiscarded` un-record is the pattern. |
| Fuzzy/edit-distance Deepgram garble correction | rejected project-wide 2026-06-24 | A false correction mis-filing a reading on a safety-critical certificate is worse than a miss. Curated equal-weight keyterms are the only sanctioned mechanism. |
| Backend latency tweaks smuggled into parity/PWA work | CLAUDE.md MANDATORY block | Backend is shared with iOS; needs an explicit cross-platform mandate and its own plan. |
| Fast-path native-TTS fallback on 4xx | route header Pivot 5, `voice-latency-fast-tts.js` | Client speaking a value the backend just rejected is unsafe; the no-fallback contract is documented in the route response body on purpose. |

## Validation and promotion protocol

A latency change is DONE only when all of these hold, in order:

1. **Bench regression green**: `npm run voice-regression` exit 0 (KNOWN_FLAKY.md consulted for any red), plus the relevant component bench re-run with before/after numbers in the commit body.
2. **Both test suites green**: `npm test` and `npm test --workspace=web` (pre-push runs both).
3. **Numbers, not ears**: commit/PR states the measured delta (e.g. "harness per-turn p50 X ms -> Y ms; ElevenLabs TTFB unchanged"). "Feels faster" is not evidence. Cost delta included whenever ElevenLabs/LLM spend changes.
4. **Flag-gated rollout where possible**: new behaviour behind a `VOICE_LATENCY_*` env var in `ecs/task-def-backend.json` (source + drift check pass), defaulting off; flip is its own commit.
5. **Field-session evidence before declaring victory**: 1-2 real field sessions on the deployed code, `turn_perceived_latency_ms` p50/p95 compared to the Phase-0 recorded baseline via CloudWatch. This is the same bar the open Phase-2.2 decision is waiting on.
6. **Docs of record**: hub changelog row + `docs/reference/changelog.md` body; web-visible changes get a parity-ledger row update; open experiments get an owner + dated row, never silent deferral. Deploy via CI only (`gh run watch <id> --exit-status`).

## When NOT to use this skill

- Wrong values / re-ask loops / mishears / silent drops in the voice pipeline -> `certmate-debugging-playbook`.
- What a WS frame looks like, capabilities negotiation, cancel_pending_tts shape -> `certmate-voice-wire-protocol`.
- General measurement-tool reference (analyze-session fields, stage6 harnesses, cost tracker) -> `certmate-diagnostics-and-tooling`.
- How to design the experiment / what counts as an accepted result in general -> `certmate-research-methodology`; worked decomposition recipes -> `certmate-proof-and-analysis-toolkit`.
- Whether you are allowed to touch the backend at all -> `certmate-change-control`.
- Hands-free/zero-touch product ambitions beyond latency -> `certmate-research-frontier`.

## Provenance and maintenance

Facts above dated 2026-07-06. One-line re-verification per drift-prone claim:

| Claim | Re-verify with |
|---|---|
| `FINALIZER_TIMEOUT_MS = 8000` | `grep -n "FINALIZER_TIMEOUT_MS" src/extraction/voice-latency-turn-summary.js` |
| `CONFIRMATION_MIN_CONFIDENCE = 0.8` (speculator-only gate) | `grep -n "CONFIRMATION_MIN_CONFIDENCE" src/extraction/confirmation-text.js` |
| Prod voice-latency flags incl. `STAGE0_BENCH=1`, barrel cap 12 | `grep -n "VOICE_LATENCY\|STAGE0_BENCH" ecs/task-def-backend.json` |
| Live extraction model Haiku 4.5 | `grep -n "SONNET_EXTRACT_MODEL" ecs/task-def-backend.json` |
| Web STT on Flux via runtime kill-switch | `grep -n "DEEPGRAM_STT_MODEL" ecs/task-def-frontend.json` |
| Flux eot 0.7 / 5000 ms | `grep -n "eot_threshold\|eot_timeout_ms" web/src/lib/recording/deepgram-service.ts` |
| Fast-path route exists + whitelist | `grep -n "regex-fast-tts" src/routes/voice-latency-fast-tts.js && ls src/extraction/regex-fast-eligibility.js` |
| Web fast-path/telemetry still missing | `grep -rn "regex-fast-tts\|playback-ack" web/src/ ; grep -n "recording/fast-path-tts\|recording/playback-telemetry" web/docs/parity-ledger.md` |
| Recorded bench numbers (947 ms / 206 ms) | `cat scripts/voice-latency-bench/sonnet-ttft-bench-result.json scripts/voice-latency-bench/elevenlabs-ttfb-bench-result.json \| grep -E "p50\|pass"` |
| Early-terminate still deleted | `git log --oneline -1 1db6230a && ls src/extraction/stage6-early-terminate.js 2>&1` (file should NOT exist) |
| Barge-in still reverted | `git -C web log --oneline -1 6b55b58d 2>/dev/null \|\| git log --oneline -1 6b55b58d` |
| 26 baseline scenarios | `ls tests/fixtures/voice-latency-scenarios/baseline/ \| wc -l` |
| Phase 2.2 still open | check hub `CLAUDE.md` "Current Focus" for the voice-latency Phase 2.2 bullet |
| perceived-latency event names | `grep -o "voice_latency\.[a-z_]*" src/extraction/voice-latency-turn-summary.js \| sort -u` |
