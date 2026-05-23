# Loaded Barrel — Stream Sonnet round-1 to TTS with server-side hold

**Date:** 2026-05-23
**Author:** Claude (autonomous execution session)
**Goal:** Cut audible-confirmation latency from measured ~4.55s (Stage 2
warm) → ~1.85s, **without breaking Stage 6's tool-loop correctness
invariants** (validation, ask_user, same-turn correction), and
**without requiring iOS changes** (backend buffers, then chunked-streams
to iOS using the Stage 2 path that already ships).

## TL;DR

Today's pipeline waits for ALL three Sonnet rounds (~4.2s) before
synthesising audio. The Loaded Barrel pattern starts synthesising audio
**during** round 1 (in parallel with Sonnet's text generation) and
**holds** the audio server-side until round 2 confirms it's safe to
release. Net audible: ~1.85s when nothing goes wrong; correct fallback
to corrected-confirmation or ask_user TTS when round 2 says otherwise.

This is Stage 5 (PLAN_v3 §8) applied to record_reading instead of
ask_user. Same primitives: streaming-json-string-field extractor,
content_block_stop gate, ElevenLabs WS buffering.

## Architecture

```
t=0 ms      Inspector finishes utterance ("circuit 12 polarity confirmed")
t=40 ms     iOS regex matches → keep regex hint local (capability bit) + send transcript to backend WS
t=40 ms     Backend WS receives transcript → handleTranscript fires
t=80 ms     Backend opens Anthropic messages.stream call for round 1
                 │
                 ├── (parallel) Sonnet generates text_delta events:
                 │     "I'll record that. Circuit 12, polarity confirmed."
                 │
                 ├── (parallel) Sonnet generates tool_use:
                 │     {field: 'polarity_confirmed', circuit: 12, value: true}
                 │
                 └── content_block_stop → message_stop
                                         (~1.65s into round 1 = t=1730ms)
        ▲       ▲
        │       │
        │       └─ STREAMING TEXT EXTRACTOR (reused from Stage 5 §8.1)
        │           Parses partial_json on the assistant message.
        │           As tokens arrive, identifies the confirmation
        │           text portion ("Circuit 12, polarity confirmed.")
        │           and FORWARDS it as deltas to ElevenLabs stream-input WS.
        │
        └─ ELEVENLABS WS opens at t=160ms, BOS handshake completes,
            text deltas arrive, ElevenLabs starts synthesising. First
            audio frame at ~t=360ms (BOS amortised via Stage 0.F-proven
            multi-context). Audio frames buffered IN MEMORY server-side.
            NO bytes to iOS yet.

t=1730 ms   Round 1 message_stop. Now run dispatcher on the tool_use:
            • record_reading validates → ok / circuit_not_found / etc

t=1750 ms   "Verdict" decision based on dispatcher result + queued tool_use blocks:
            ┌─────────────────────────────────────────────────────────┐
            │ VERDICT TABLE — what to do with the loaded barrel        │
            ├─────────────────────────────────────────────────────────┤
            │ A. Round-1 tool_use only record_reading + dispatcher OK │
            │    AND no pending ask_user from prior turn              │
            │    AND no Sonnet text in round 1 contradicts the value  │
            │    → FIRE THE BARREL: chunked-stream buffered audio to  │
            │      iOS. Skip rounds 2 + 3.                            │
            │    → Audible at t≈1850 ms (Sonnet round 1 + ElevenLabs  │
            │      first frame + iOS scheduling, parallel pipelining) │
            │                                                          │
            │ B. Round-1 tool_use record_reading + validation_error   │
            │    (circuit_not_found, ocpd_mismatch, etc)              │
            │    → DISCARD THE BARREL.                                │
            │    → Continue to round 2, which will emit ask_user.     │
            │    → Round 2's ask_user streams live via Stage 5 path.  │
            │                                                          │
            │ C. Round-1 emits ask_user tool_use (no record_reading)  │
            │    → DISCARD THE BARREL.                                │
            │    → Stream the ask_user.question text directly.        │
            │                                                          │
            │ D. Round-1 emits record_reading + ask_user (mixed)      │
            │    → DISCARD THE BARREL.                                │
            │    → Process tool_use normally, let rounds 2+3 unfold.  │
            │    → Cost: ~1× extra ElevenLabs char usage (negligible) │
            │                                                          │
            │ E. Round-1 emits 2+ record_readings (multi-write)       │
            │    → DISCARD THE BARREL.                                │
            │    → Bundler will emit a multi-readings extraction;     │
            │      legacy synthesiseConfirmations builds the spoken  │
            │      summary; existing batch path delivers.             │
            │      (Loaded Barrel only optimises single-write turns.) │
            │                                                          │
            │ F. clear_reading or same-turn correction                │
            │    → DISCARD THE BARREL.                                │
            │    → Synth + stream corrected confirmation after round 2│
            └─────────────────────────────────────────────────────────┘

t=1850 ms   AUDIBLE (verdict A) — iOS plays first PCM frame.
            For verdicts B/C/D/F: audible ~3-4s, same as today.
```

## Where each piece lands in the codebase

| Piece | File | New / Modify |
|---|---|---|
| Streaming JSON string-field extractor | `src/extraction/streaming-json-string-field.js` | NEW (was PLAN_v3 §8.1 commit 5.1, scope = ask_user; reusable here) |
| Loaded-Barrel orchestrator | `src/extraction/loaded-barrel.js` | NEW — owns the parallel synth + verdict + fire/discard logic |
| Round-1 streaming integration | `src/extraction/eicr-extraction-session.js` `extractFromUtterance` | MODIFY — switch from `messages.create` to `messages.stream` when `loaded_barrel: true` per-session flag; wire text-delta callback into loaded-barrel orchestrator |
| Dispatcher hook | `src/extraction/stage6-tool-loop.js` | MODIFY — after round 1 tool dispatch completes, call `loadedBarrel.classifyVerdict(roundResult)` and `fire()` or `discard()` |
| Backend WS emission | `src/extraction/sonnet-stream.js` | MODIFY — when verdict=A fires, emit `extraction` envelope early (no rounds 2+3), then stream the buffered audio via chunked HTTP to iOS (reuses Stage 2.5 streaming-confirmations path) |
| Feature flag | `src/extraction/voice-latency-config.js` + `ecs/task-def-backend.json` | MODIFY — add `VOICE_LATENCY_LOADED_BARREL=false` snapshot flag |
| Tests | `src/__tests__/loaded-barrel.test.js` + new fixtures | NEW |

## Detailed design

### 1. Streaming text-delta capture

The Anthropic streaming API emits events of shape:

```
message_start
  → content_block_start (index 0: text)
    → content_block_delta (text_delta) × N
    → content_block_stop (text done)
  → content_block_start (index 1: tool_use)
    → input_json_delta (partial JSON) × N
    → content_block_stop (tool_use args done)
  → message_delta (usage)
message_stop
```

The loaded-barrel orchestrator subscribes to the stream:

- **On text_delta arrival**: append to a running `assistantText` buffer.
  - If `VOICE_LATENCY_LOADED_BARREL` is on AND we have an open
    ElevenLabsStreamClient AND the text doesn't already exceed a
    pre-set cap (e.g. 200 chars — guards against runaway), forward
    the delta to ElevenLabs immediately.
- **On input_json_delta arrival (tool_use args)**: stream into the
  streaming-json-string-field parser to identify tool name + extract
  fields as they emerge (mirror of Stage 5's pattern — gives us early
  signal about WHAT the tool_use will be).
- **On content_block_stop for the text block**: flush any trailing
  text delta + send ElevenLabs the EOS / flush marker. ElevenLabs
  begins synthesising. Audio frames arrive at ElevenLabsStreamClient's
  onAudio callback and are appended to `audioBuffer` (server-side,
  in-memory). NO bytes to iOS yet.

### 2. Verdict classification (after message_stop on round 1)

`loadedBarrel.classifyVerdict({toolUseBlocks, dispatchResults, sessionState})`:

```
function classifyVerdict({toolUseBlocks, dispatchResults, sessionState}) {
  if (toolUseBlocks.length === 0) return { fire: false, reason: 'no_tool_use' };

  // E. Multi-write — too risky for the optimistic confirmation. Let bundler run.
  const writeBlocks = toolUseBlocks.filter(b => b.name === 'record_reading');
  if (writeBlocks.length > 1) return { fire: false, reason: 'multi_write' };

  // C. ask_user in round 1 → answer the question, not the value
  const askBlocks = toolUseBlocks.filter(b => b.name === 'ask_user');
  if (askBlocks.length > 0 && writeBlocks.length === 0) {
    return { fire: false, reason: 'ask_user_only' };
  }

  // D. Mixed (write + ask_user) → discard, let normal path handle
  if (askBlocks.length > 0 && writeBlocks.length > 0) {
    return { fire: false, reason: 'mixed_write_and_ask' };
  }

  // B. Validation failure on the single write
  const writeRes = dispatchResults.find(r => r.toolName === 'record_reading');
  if (writeRes?.outcome !== 'ok') {
    return { fire: false, reason: `dispatcher_${writeRes?.outcome ?? 'missing'}` };
  }

  // F. Same-turn clear (record_reading + clear_reading both in round 1)
  if (toolUseBlocks.some(b => b.name === 'clear_reading')) {
    return { fire: false, reason: 'same_turn_clear' };
  }

  // (Also guard against any board_op / observation_op in round 1 — those need round 2+ to settle)
  const allowedToolNames = new Set(['record_reading']);
  if (toolUseBlocks.some(b => !allowedToolNames.has(b.name))) {
    return { fire: false, reason: 'unsupported_tool_in_round1' };
  }

  // A. CLEAN — fire the barrel.
  return { fire: true, reason: 'clean' };
}
```

### 3. Fire / discard semantics

**`loadedBarrel.fire()`** (verdict A):
1. Stop the Sonnet tool loop after round 1 (return early from `runToolLoop`).
2. Run `bundleToolCallsIntoResult(perTurnWrites, legacyResult)` as normal.
3. Emit the `extraction` envelope over WS (rounds 2+3 skipped — verdict A says round 1 already covered the contract).
4. Stream the buffered `audioBuffer` to iOS via the chunked HTTP path
   Stage 2.5 already wires. iOS sees identical wire shape to today's
   streaming-confirmation, just arriving ~2.7s earlier.
5. Emit telemetry: `voice_latency.loaded_barrel_fired` with `audible_ms`,
   `text_chars_streamed`, `audio_bytes_buffered`, `verdict_reason`.

**`loadedBarrel.discard()`** (verdicts B/C/D/E/F):
1. Close the ElevenLabsStreamClient (cancels in-flight synth — ElevenLabs
   still bills for accepted chars; tracked via Stage 2.6
   recordElevenLabsStreamingTerminal with terminal='cancelled').
2. Discard the buffered `audioBuffer`.
3. Continue the tool loop normally (rounds 2 + 3).
4. The final extraction emits via the existing batch / streaming path.
5. Emit telemetry: `voice_latency.loaded_barrel_discarded` with
   `reason`, `text_chars_wasted`, `audio_bytes_wasted`, `chars_billed`.

### 4. Failure modes + safety

| Failure | Detection | Handling |
|---|---|---|
| ElevenLabs WS errors during round-1 synth | `ElevenLabsStreamClient.onError` | discard barrel + telemetry; tool loop continues normally |
| Sonnet stream errors mid-round-1 | `messages.stream` rejects | discard barrel + propagate error to existing tool-loop error path |
| iOS WS disconnects between bundling and chunked-HTTP send | `ws.readyState !== OPEN` at send time | buffer the extraction in `entry.pendingExtractions` (existing reconnect path) + discard the audio (iOS will re-fetch via legacy TTS POST on reconnect) |
| Round 1 takes longer than `LOADED_BARREL_ROUND1_TIMEOUT_MS` (e.g. 5s) | wall-clock timer | discard barrel + emit voice_latency.loaded_barrel_round1_timeout; fall through to normal multi-round flow |
| ElevenLabs synth takes longer than text-delta arrival rate (rare) | onAudio backpressure | accumulate up to `LOADED_BARREL_MAX_BUFFER_BYTES` (~500KB ≈ 10s of PCM); over cap → discard, fall through |
| Cost accounting | recordElevenLabsStreamingStarted is called on text-sent; recordElevenLabsStreamingTerminal('cancelled') on discard | invariant `charsStarted = charsCompleted + charsCancelled + charsFailed` still holds |

### 5. Cost analysis

- **Verdict A (fire)** — identical to today's Stage 2 streaming cost (one
  ElevenLabs synth, one Anthropic round).
- **Verdict B/C/D/F (discard + recover)** — ~1.5× cost: one wasted
  ElevenLabs synth (~50-100 chars cancelled) + the normal multi-round
  Sonnet completion + a second ElevenLabs synth for the correct
  confirmation. At ElevenLabs Flash $0.00018/char, ~80 chars wasted =
  $0.014 per discard. With expected verdict-A hit rate of 75%+ (single
  write per transcript is the common case), net cost increase ~5%.

### 6. Feature-flag rollout

1. Land code with `VOICE_LATENCY_LOADED_BARREL=false`. Existing behaviour
   unchanged.
2. CI deploy. Soak 24h.
3. Flip to `true` via task-def commit. Loaded Barrel activates ONLY for
   sessions that ALSO have:
   - `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` (already on)
   - iOS capability `streaming_http_audio` (gate keeps current iOS
     clients on the legacy multi-round path)
4. Telemetry analyser reports verdict-A hit rate, P50 audible (fire),
   P50 audible (discard), cost delta.
5. If verdict-A hit rate < 60% OR P95 audible (fire) > 2.5s OR cost
   delta > 15%: roll back via flag flip.

## Test strategy

| Test | Scope |
|---|---|
| `loaded-barrel.classifyVerdict.test.js` | All 6 verdict branches (A-F) with synthetic tool_use + dispatch result fixtures |
| `loaded-barrel.fire.test.js` | Fire path: bundler runs, extraction emits, audio chunks stream |
| `loaded-barrel.discard.test.js` | Discard path: WS cancels, audioBuffer cleared, tool loop continues |
| `loaded-barrel.failure-modes.test.js` | Each row from §4 failure-modes table |
| `transcript-replay loaded_barrel scenarios` | 3 scenarios: clean fire (single record_reading), discard via validation error (circuit_not_found), discard via same-turn correction |

Pass criteria for the loaded_barrel suite:
- Verdict A: end-to-end audible P50 ≤ 2500 ms against PROD.
- Verdict B/C/D/F: end-to-end audible matches Stage 2 streaming
  baseline (~4.55s) within ±200 ms — proves the discard path doesn't
  add latency beyond the wasted parallel synth.

## What this does NOT solve

- Multi-write turns (e.g. inspector says "circuit 1 polarity confirmed,
  Zs 0.38 ohms") still take the full 3-round path. Verdict E discards.
- Ask_user-led turns still take the full path; Stage 5 (separate work)
  optimises those.
- Sonnet TTFT floor (947ms measured) is the irreducible floor — verdict
  A's ~1850ms = 947ms TTFT + 700ms finalisation + 200ms ElevenLabs first
  frame + ~3ms iOS chunk + ~50ms scheduling, all happening in parallel.

## Estimated effort

| Phase | Work |
|---|---|
| 1. streaming-json-string-field.js (new module) | ~150 lines + 20 tests = 1 day |
| 2. loaded-barrel.js orchestrator (new module) | ~300 lines + classifyVerdict + 30 tests = 2 days |
| 3. eicr-extraction-session.js stream integration | switch to messages.stream, route deltas = 1 day |
| 4. stage6-tool-loop.js integration + WS emission | 1 day |
| 5. Tests + harness scenarios + STAGE0_RESULTS_LOADED_BARREL.md | 1 day |
| **Total** | **~6 days backend** |

Zero iOS work required. Zero Stage 1b dependency. Stage 2.5's chunked-
HTTP path is reused as-is.

## Decision gate

Land Loaded Barrel only if BOTH:
- This plan passes review (Claude + Codex).
- Stage 2 field-test assessment (PLAN_v5 §A.1, 5 sessions) concludes
  the ~300ms saving from Stage 2 alone is insufficient (which the
  measured ~4.55s already strongly suggests).

Skip Loaded Barrel and proceed to Stage 4 ONLY IF:
- The PLAN_v3 §7 case for regex-fast carrying enough traffic is more
  compelling than fixing the Sonnet path. Per Derek 2026-05-23: the
  inspector's common case IS short value-bearing utterances that
  Stage 4 handles, BUT some utterances need Sonnet (chitchat parsing,
  ambiguity, observation extraction), so a Sonnet-path fix benefits
  THOSE while regex-fast handles the simple values.

The two paths are not mutually exclusive — Loaded Barrel + Stage 4 fast-path
cover different transcript classes and stack cleanly.
