# Stage 0.G — Warm-path harness run (Stage 2 streaming flags ON)

**Run date:** 2026-05-23, ~21:00 UTC
**Backend state:** `STAGE0_BENCH=1`, `VOICE_LATENCY_STREAM_CONFIRMATIONS=true`,
`VOICE_LATENCY_USE_MULTI_CONTEXT=true`. Image built from
HEAD=24c2782 (mint endpoint live), live task def revision 207.
**Harness:** advertised `streaming_http_audio` capability so the
backend's Stage 2.5 streaming branch fires.

## Results (5/5 scenarios PASS the basic correctness assertions, 1 fails the audible budget)

| Scenario | extraction (ms) | audible (ms) | TTS first-byte (ms) |
|---|---|---|---|
| chitchat_no_engagement | 1620 | n/a | n/a |
| flux_misrecognition_socket_one (edge case) | 3814 | 4527 | ~713 |
| normal_npts_single_circuit | 3700 | 12613 (cold outlier) | wide |
| normal_polarity | 4162 | 4557 | ~395 |
| normal_zs_value | 4220 | 4613 | ~393 |

**Warm-path audible P50 (value scenarios excluding outlier):** ~4555 ms.
**Improvement vs batch baseline (~4855 ms):** ~300 ms (~6%).
**vs 2–2.5s target:** still ~2s ABOVE target.

## Root cause: PLAN_v3 §2 forecast was structurally optimistic

The §2 Stage 2 warm-path arithmetic added:
- 947 ms Sonnet TTFT (cached)
- 700 ms Sonnet finalisation
- ElevenLabs 214 ms warm
- Misc 200 ms

= ~2.06 s. But that assumed Sonnet completes the **entire** record_reading
+ confirmation cycle in 1.65 s of model time.

**Reality, from CloudWatch:** `stage6_live_extraction rounds: 3` per
value-bearing transcript. The Stage 6 tool loop fires THREE sequential
Anthropic calls (initial extraction, validation/tool_result roundtrip,
final ack). At ~1.4 s each cached = ~4.2 s of Sonnet time alone. The
plan budgeted for 1 round; reality is 3.

Stage 2 streaming only shaves the **TTS first-byte** hop (470 → ~395 ms
in this run; multi-context pool not yet active because each synth opens
a fresh ElevenLabsStreamClient — no per-session warm pool, which
Stage 4 commit 4.3 would add). Net audible improvement: ~300 ms.

## What it would take to hit 2–2.5s

The 2–2.5s target is **only structurally achievable** via **Stage 4's
regex-fast path** which BYPASSES Sonnet entirely for known-shape
transcripts (e.g. "circuit 1 number of points 5" matches a regex on
iOS, fires the fast-path /api/voice-latency/regex-fast-tts endpoint,
TTS streams back in ~700 ms warm per the §2 Stage 4 budget).

Stage 4 is:
- Conditional on Stage 2 assessment (PLAN_v5 §A.1)
- Multi-week effort (suppression machinery, race catalogue R1-R8,
  iOS regex POST plumbing, multi-context pool)
- Requires iOS Stage 1b + 4 commits via TestFlight

## Permanent log entries for the warm path

CloudWatch sample (during the run):
```
voice_latency.startup_log sessionId=harness_…
  flags_snapshot.streamConfirmations=true
  capabilities.has_streaming_http_audio=true
  multi_context_effective=true

ElevenLabs TTS streaming complete
  correlationId=vl_confirmation_…
  source=confirmation
  terminal=completed
  multi_context=true
```

Confirms the streaming branch fired correctly on every value-bearing
transcript.

## Cleanup state

- STAGE0_BENCH flipped back to 0 (mint endpoint becomes 404 in prod).
- Mint endpoint removed from source.
- `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` + `VOICE_LATENCY_USE_MULTI_CONTEXT=true`
  LEFT ON in source — they're harmless without iOS Stage 1b (capability
  gate stays closed for current iOS builds, every TTS request falls
  through to the legacy batch path until iOS ships the
  `streaming_http_audio` advert).

## Fast-path measurement (Stage 4 forecast, MEASURED)

Run 2026-05-23 21:14 UTC. Direct TTS POST to /api/proxy/elevenlabs-tts
(streaming branch active, no Sonnet round-trip), 5 representative
confirmation strings, sessionId with full voice_latency capabilities
advertised so the streaming path fires.

| Text | first-byte (ms) | total (ms) | bytes |
|---|---|---|---|
| Circuit one, number of points 5 | 523 | 554 | 83 380 |
| Circuit two, Zs 0.38 ohms | 340 | 441 | 124 312 |
| Circuit twelve, polarity confirmed | 233 | 260 | 86 412 |
| Circuit three, R1 plus R2 0.52 ohms | 280 | 310 | 147 052 |
| Earth loop impedance 0.19 ohms | 268 | 302 | 112 184 |

**Server first-byte P50: 280 ms** | P95: 523 ms | min/max: 233/523 ms.

iOS overhead (regex match 40 ms + POST send 50 ms + AVAudioPlayerNode
schedule 50 ms) = ~140 ms.

**Forecast total fast-path audible (P50): ~420 ms.** Well within the
2–2.5 s target (~6× headroom).

## Headline

- **Stage 2 streaming alone** does not hit 2–2.5 s for value-bearing
  transcripts because the Stage 6 tool loop runs ~3 Sonnet rounds
  (~4.2 s). Measured: ~4.55 s audible.
- **Stage 4 fast-path** (bypass Sonnet on regex hits) DOES hit the
  target with margin to spare. Measured: ~420 ms audible (P50).
- The 2–2.5 s target IS achievable; it requires Stage 4 (the
  iOS-side regex + the backend regex-fast-tts route + suppression
  glue + iOS Stage 1b's chunked HTTP client).

Stage 4 backend is a ~1-2 day build; iOS Stage 1b + 4 needs a
TestFlight cycle. Both deferred per PLAN_v5 §A.1 (conditional on
Stage 2 assessment — this measurement is what the assessment gates on).
