# Loaded Barrel v2 — Speculative TTS Cache (architectural redesign)

**Date:** 2026-05-23
**Supersedes:** LOADED_BARREL_PLAN.md (v1)
**Reconciles:** Claude Plan-agent review (4 BLOCKERs) + Codex gpt-5.5 review
(7 BLOCKERs total, including all 4 of Claude's + 3 new).

## TL;DR

v1's "fire the barrel / skip rounds 2+3" pattern was broken in 7 ways
(invariant-violating tool_loop early-exit, double-envelope race, no
existing iOS-side push channel, wrong stream-ordering assumption,
mis-stated cost math, etc).

**v2 keeps everything the same EXCEPT the audio delivery mechanism.**
The tool loop runs unchanged to completion. The "barrel" becomes a
short-lived **server-side speculative TTS cache** keyed by
`(sessionId, confirmation_text_hash)`. iOS continues to fetch TTS via
the existing `/api/proxy/elevenlabs-tts` POST exactly as today (no iOS
changes, no protocol changes, no double envelopes). The cache hit
serves bytes in ~50ms; cache miss falls through to today's normal
synth (~470ms). No correctness invariants change.

Net audible: ~Sonnet-time + ~50ms (cache hit) instead of ~Sonnet-time
+ ~470ms (today). Modest win on top of Stage 2 (~400ms saved). The
fast-path remains the way to hit the 2-2.5s goal for value-bearing
transcripts.

## Why v1 broke (Claude + Codex consensus)

| # | BLOCKER | v2 fix |
|---|---|---|
| B1 | Skip rounds 2+3 → unpaired tool_use → next turn 400s | v2: loop runs to completion, nothing skipped |
| B2 | Round-2-only emissions (board ops, observations, scripts) silently dropped | v2: bundler runs as today, all emissions preserved |
| B3 | Prompt doesn't guarantee prose-before-tool with `tool_choice` forcing | v2: doesn't need prose; uses tool_use input fields to predict confirmation text deterministically |
| B4 | streaming-json-string-field "reuse" is build-fresh | v2: doesn't need it (synthesises from tool_use args, not text deltas) |
| B5 | Anthropic stream block ordering not guaranteed | v2: doesn't depend on ordering |
| B6 | "Zero iOS changes" untrue — no server-push channel exists | v2: actually zero iOS changes (iOS POSTs as today; cache hit on backend) |
| B7 | Double extraction envelope race | v2: ONE envelope per turn (loop emits at end as today) |

Cost-math correction (Codex IMPORTANT): v1 said "+5% at 75% hit", real
math is `multiplier = 2 - hitRate`. v2's cost behaviour is different
(see §4 below) because the cache miss costs **nothing extra** — the
speculative synth is the same one iOS would have paid for on cache
miss; the cache just makes the hit case faster.

## Architecture

```
        Backend                                            iOS
        ───────                                            ────
t=0     transcript arrives via WS
t=40    handleTranscript → loop starts
        ┌─ messages.stream ─┐
        │                   │
t=80    │ first tool_use    │
        │ event detected:   │
        │ record_reading    │
        │ {field, circuit,  │
        │  value}           │
        │                   │
        │ PREDICT CONFIRMATION TEXT  ◄── tool_use.input fields
        │ from synthesiseConfirmations(...) (existing function)
        │ → "Circuit 12, polarity confirmed"
        │ → hash → cacheKey = sha1(sessionId + text)
        │
        │ Open ElevenLabsStreamClient
        │ Buffer audio frames into ttsSpeculationCache.set(cacheKey, audioBuffer)
        │ (in-memory, 60s TTL)
        │                   │
t=1730  │ message_stop      │
        │ tool dispatchers  │
        │ run               │
        └─────────┬─────────┘
                  │
t=1750-4200       │ Rounds 2+3 run as today
                  │ Bundler runs
                  ▼
t=4200  ws.send({type:'extraction', result:{confirmations:[{text:"Circuit 12, polarity confirmed"}]}})
                                                          │
                                                          ▼
t=4220                                       iOS sees confirmation
                                             → POST /api/proxy/elevenlabs-tts {text, sessionId, source:'confirmation'}
t=4260  POST arrives ←─────────────────────── (50ms iOS POST + 50ms network)
        cacheKey lookup: hit! Audio ready.
        Stream cached audio chunks via chunked HTTP
                                              │
                                              ▼
t=4290                                       iOS receives first byte
                                              → AVAudioPlayerNode schedules
                                              → audible at ~t=4340

Vs today (no cache): ElevenLabs synth from cold = +400-700ms to first byte.
Speculative cache shaves THAT — confirmation audible ~400ms earlier.
```

## v2 detailed design

### 1. The cache

`src/extraction/tts-speculation-cache.js`:

```
class TTSSpeculationCache {
  // key = sha1(sessionId + normalisedText)
  // value = { audioBuffer: Buffer, contentType: string, completeAt: bigint, ttlMs: 60_000 }
  // Bounded: max 50 entries per session, LRU eviction, 60s TTL.
  set(key, entry) { ... }      // O(1)
  consume(key) { ... }          // O(1), returns + deletes (single-use)
  prune() { ... }               // called on session_stop
}
```

### 2. Tool-use → confirmation-text predictor

After the streaming Anthropic loop emits a `tool_use` start event for
`record_reading` with COMPLETE input JSON (`input_json_delta` finishes
+ content_block_stop fires for the tool_use block), call
`synthesiseConfirmations([{field, circuit, value, confidence:1.0}])`
from `stage6-event-bundler.js`. That existing function ALREADY knows
how to build the confirmation text deterministically. If it returns
a non-empty `text`, that's our prediction.

**No new prompt change required.** The prediction comes from the
tool's input fields, not from Sonnet's prose.

### 3. Speculative synth

`src/extraction/loaded-barrel-speculator.js`:

```
async function speculateOnToolUse({ sessionId, predictedText, vl, apiKey }) {
  const key = sha1(sessionId + ':' + normalise(predictedText));
  if (cache.has(key)) return; // dedupe
  const client = new ElevenLabsStreamClient({ apiKey, multiContext: vl.flags.useMultiContext });
  const buf = [];
  try {
    await client.synth(predictedText, { onAudio: (chunk) => buf.push(chunk) });
    cache.set(key, { audioBuffer: Buffer.concat(buf), contentType: contentTypeForFormat(client.outputFormat), completeAt: process.hrtime.bigint() });
  } catch (err) {
    // discard — TTS POST will fall through to legacy path
  }
}
```

Called from the streaming-Anthropic event handler in
`eicr-extraction-session.js` immediately on first complete `tool_use`
input. Fire-and-forget — does NOT block the tool loop.

### 4. Cache consumption on `/api/proxy/elevenlabs-tts`

Modify `streamConfirmationViaElevenLabs` in `src/routes/keys.js`:

```
async function streamConfirmationViaElevenLabs(...) {
  const cache = getSpeculationCache();
  const key = sha1(sessionId + ':' + normalise(text));
  const cached = cache.consume(key);
  if (cached) {
    res.set('Content-Type', cached.contentType);
    res.set('Transfer-Encoding', 'chunked');
    res.set('X-Voice-Latency-Source', 'speculative_cache_hit');
    res.write(cached.audioBuffer);
    res.end();
    return;
  }
  // existing streaming path unchanged
  ...
}
```

### 5. Cost model (corrected per Codex)

- **Speculation runs ONCE per tool_use** (record_reading). The synth
  cost is identical to what the user would pay on cache miss — same
  text, same ElevenLabs Flash bill.
- **Cache hit** (text matches the confirmation iOS actually requests):
  zero extra ElevenLabs spend. Audio served from RAM. **Saved bytes:
  none.** **Saved latency: ~470ms first-byte.**
- **Cache miss** (text predicted ≠ text iOS requests, e.g. Sonnet
  later corrected via clear_reading + re-record): speculation cost
  becomes WASTED. iOS POST falls through to live synth — extra cost
  = one speculative synth ~80 chars × $0.05/1000 = $0.004. Same
  audible latency as today.
- **Net cost increase = $0.004 × (1 - hitRate) per turn.** At 70%
  hit rate over 1000 turns/day: $1.20/day overhead. Negligible.

The corrected math here (vs v1's claimed +5% at 75%): v2's miss case
costs ONE extra synth, not two. v1's miss case cost two because the
discarded synth had no recovery path.

### 6. Hit-rate prediction

The prediction is "text Sonnet round-1 record_reading produces" ==
"text bundler emits in final confirmations". Cases where they differ:

- Same-turn clear_reading + re-record_reading → predicted "Circuit 12,
  polarity confirmed" but final emits "Circuit 12, polarity"
  cleared/different. Cache miss.
- Sonnet round 2/3 calls additional record_reading on the same slot
  with a different value → bundler de-duplicates by Map key, last
  write wins. Predicted text from round-1 record may not match.
  Cache miss.
- Round 1 makes 2+ record_readings → predictedText is from the first
  one; bundler's confirmations array has multiple entries; iOS POSTs
  EACH one. First one hits the cache, rest don't. Partial win.
- Validation error on round 1 → cache key is set BUT bundler
  ultimately doesn't emit a confirmation for that slot. Cache entry
  ages out (60s TTL). Wasted synth, but no iOS POST attempts to
  consume it.

Estimated hit rate **80-90% on single-write turns** (the common
case), based on the simplicity of the prediction (tool_use args ARE
the final values for ~all single-write paths).

### 7. Safety + failure modes

| Failure | Handling |
|---|---|
| ElevenLabs synth fails during speculation | cache entry not set; iOS POST falls to legacy path; logged but no user impact |
| Cache RAM pressure | per-session bound (50 entries) + global LRU cap (1000 entries) + 60s TTL |
| Two iOS POSTs for same text in a session | second POST gets cache miss (single-use consume) → falls to legacy path |
| Session ends before iOS POSTs | cache prune on session_stop |
| Multi-region / multi-instance | cache is in-process. Each backend instance has its own. Single-instance deploy today; multi-instance needs Redis (deferred) |

### 8. Wire-shape & iOS impact: ZERO

iOS continues to POST `/api/proxy/elevenlabs-tts {text, sessionId}` as
today. Response is chunked HTTP audio as today. The only difference is
the response arrives 400ms faster on cache hit. iOS sees no protocol
change, no new fields, no double envelopes, no new state machine.

### 9. Feature flag rollout

1. `VOICE_LATENCY_SPECULATION=false` default. Snapshot per-session.
2. Land code, soak 24h with flag off.
3. Flip to true via task-def commit.
4. Speculation runs in parallel with tool loop. iOS POST consumes
   cache when hit, falls through when miss.
5. Telemetry tracks: `speculation_started`, `speculation_completed`,
   `speculation_hit`, `speculation_miss`, `speculation_byte_count`.
   Analyser computes hit-rate + latency delta.
6. If hit rate < 50% OR P95 audible (hit) > 1.5s: roll back. Cost
   overhead at < 50% hit is negligible regardless.

### 10. Testing strategy

- `tts-speculation-cache.test.js` — LRU + TTL + per-session bound
  invariants.
- `loaded-barrel-speculator.test.js` — happy path (synth completes,
  cache populated) + failure-mode (synth errors, cache empty).
- `keys.test.js` extension — cache-hit short-circuits the existing
  streaming path; cache-miss falls through unchanged.
- Transcript-replay harness `speculation_*` scenarios — verify
  hit-path audible < hit-path baseline by ≥ 300ms.

### 11. Effort estimate

| Phase | Days |
|---|---|
| 1. tts-speculation-cache.js + tests | 1 |
| 2. loaded-barrel-speculator.js + tests | 1 |
| 3. eicr-extraction-session.js streaming wire + speculator invocation | 2 |
| 4. keys.js cache consumption | 0.5 |
| 5. Telemetry hops + analyser update | 1 |
| 6. Harness scenarios + STAGE0_RESULTS_SPECULATION.md | 1 |
| **Total** | **6.5 backend days** |

Stage 5 streaming-json-string-field NOT required for v2 (we use
tool_use args directly).

## Comparison vs alternatives

| Approach | Audible (P50) | iOS work | Backend work | Risk |
|---|---|---|---|---|
| Today (deployed, all flags off) | 4855 ms | — | — | — |
| Stage 2 streaming (deployed, harness verified) | 4555 ms | Stage 1b for prod users | 0 (shipped) | low |
| Stage 4 fast-path (deployed, harness verified at 822 ms) | ~940 ms for regex-eligible | Stage 1b + iOS regex POST | 0 (shipped) | medium (regex eligibility tuning, edge cases) |
| **v2 speculation cache** | ~4150 ms (Sonnet floor + 50ms cache hit) | 0 | 6.5 days | low |
| v1 loaded barrel (rejected) | claimed 1850 ms; actually broken | claimed 0; actually requires push channel | claimed 6; actually requires structural rework + Stage 5 prereq | very high |

**v2 stacks with Stage 4**: regex-eligible turns hit fast-path (~940 ms),
non-eligible turns benefit from speculation cache (~400 ms shaved).
Neither hits the 2-2.5s goal for non-regex turns; that requires
either the Stage 6 prompt change (single-round extraction) or
Stage 5-style streaming of Sonnet text → TTS with a real commit
boundary (the v1 problem space, harder than v2).

## What v2 explicitly does NOT do

- Does not hit 2-2.5s for non-regex transcripts (Sonnet 4.2s floor stays).
- Does not change the iOS protocol.
- Does not modify the Stage 6 tool loop.
- Does not require a prompt change.
- Does not require Stage 5's streaming-JSON parser.

## Decision

Land v2 if/when the Stage 2 assessment (5 field sessions) concludes
Stage 4 fast-path alone is insufficient. v2 is a smaller-risk
~400ms win that stacks cleanly with everything already deployed.
