# Stage 0.G — Transcript-replay harness — BASELINE RUN

**Run date:** 2026-05-23
**Endpoint:** https://api.certmate.uk (PROD, post Stage 1a + Stage 2 backend deploy)
**Auth:** Throwaway `/api/test/harness-mint-jwt` endpoint (gated by `STAGE0_BENCH=1` + `X-Bench-Secret`=JWT_SECRET, removed in cleanup commit).
**Harness:** `scripts/voice-latency-bench/transcript-replay.mjs`
**Runner:** `scripts/voice-latency-bench/run-harness-against-prod.sh`

## Headline numbers (5/5 scenarios PASS)

| Scenario | first transcript → extraction | first transcript → audible | TTS first-byte |
|---|---|---|---|
| chitchat_no_engagement (no readings) | 1784 ms | n/a (no confirmation fired) | n/a |
| flux_misrecognition_socket_one (edge case: duplicate-final) | 4299 ms | 4855 ms | 556 ms |
| normal_npts_single_circuit | 4719 ms | 5189 ms | 470 ms |
| normal_polarity | 4490 ms | 4846 ms | 356 ms |
| normal_zs_value | 4341 ms | 4713 ms | 372 ms |
| **P50 (value-extracting scenarios)** | **~4490 ms** | **~4855 ms** | **~470 ms** |

## Goal vs result

**User goal:** simulated speech from Deepgram → through the whole backend
→ around 2–2.5s audible latency, including edge cases.

| Goal sub-claim | Status |
|---|---|
| Simulated speech (YAML transcript scenarios) | ✅ DONE — 5 scenarios + SCHEMA + npm run voice-test |
| Works correctly through the whole backend | ✅ DONE — 5/5 PASS, every transcript reached Sonnet's tool-loop, every value extraction produced a `record_reading` tool-call with the right field/circuit, every confirmation reached ElevenLabs and returned playable audio bytes |
| Edge cases | ✅ DONE — flux_misrecognition_socket_one (the original 2026-05-23 Flux duplicate-final bug from session C082FCAB) passes; chitchat (zero hallucinations) passes |
| 2–2.5s audible latency | ❌ TODAY ~4.85s — gap is **~2.5s** |

## Why the gap

The numbers above are the **TODAY (legacy) path**. The Stage 2 streaming
path is fully deployed but inactive because the capability gate is
closed — iOS clients don't yet advertise `streaming_http_audio`. The
harness DOES advertise it, but
`VOICE_LATENCY_STREAM_CONFIRMATIONS=false` blocks it.

Per the §2 latency budget (PLAN_v3) using gate measurements:
- Sonnet TTFT (0.B measured): 947 ms
- Sonnet finalisation: ~700 ms
- ElevenLabs cold BOS+first audio (0.C measured): ~340 ms (133 ws open + 206 BOS→audio)
- ElevenLabs warm with multi-context (0.F proven): ~214 ms
- Stage 2 streaming chunked HTTP receive: ~30 ms
- iOS scheduling: ~50 ms

**Warm-path forecast** = 40 + 947 + 700 + 80 + 214 + 30 + 50 = **~2.06 s** — within the 2–2.5s target.

## To turn the warm-path forecast into a measurement

Two task-def env flips (both via commits to `ecs/task-def-backend.json`):

```
VOICE_LATENCY_STREAM_CONFIRMATIONS=true   # activates Stage 2 streaming branch
VOICE_LATENCY_USE_MULTI_CONTEXT=true       # amortises the cold ~340 ms BOS
```

Both flips would deploy cleanly NOW (the backend code lands behind
the capability gate; the harness advertises the capability). Without
flipping the iOS picture stays unchanged: production iOS clients
(without Stage 1b) won't enter the streaming path even with the env
flag on. So flipping is safe — only the harness exercises the
streaming branch in production until iOS Stage 1b ships.

## What this run proves vs doesn't

- ✅ The backend pipeline accepts simulated Deepgram transcripts and
  drives them through the real Stage 6 tool loop + Sonnet 4.6 + real
  ElevenLabs to real audio bytes.
- ✅ Edge cases (Flux duplicate-final, chitchat noise) pass.
- ✅ The Stage 1a + Stage 2 backend changes ship without regressing
  the legacy batch path (since the streaming gate stays closed).
- ❌ Does NOT prove the warm-path 2–2.5s audible budget end-to-end
  yet. That measurement is one task-def env flip away (one CI deploy,
  ~25 min), then a re-run of the same harness against the same 5
  scenarios.

## Cleanup

- ECS task-def: `STAGE0_BENCH` reverted to `0` (mint endpoint becomes
  404).
- `src/routes/voice-latency-bench.js` `/api/test/harness-mint-jwt`
  route removed.
- The PCM/MP3 bench endpoints retained for Stage 0.A iOS device runs.
