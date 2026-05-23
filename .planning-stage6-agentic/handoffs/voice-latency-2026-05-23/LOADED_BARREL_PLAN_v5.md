# Loaded Barrel v5 — Honest-Scope Sonnet-Path Streaming

**Date:** 2026-05-24
**Supersedes:** LOADED_BARREL_PLAN_v4.md (5 NEW BLOCKERs from Codex).
**Scope:** the FULL scope, not the optimistic v4 scope.

## TL;DR

v4 was right architecturally but underestimated the surface area by
4×. v5 is the honest plan:

- **6 backend + iOS sub-projects** that must all land together
- **~30 backend days + 7 iOS days (TestFlight cycle) + 1-2 weeks field**
- Hits **~1.5-2.5s audible** on natural-language Sonnet path for the
  common case (single-value transcripts), **~4.5s** on multi-value /
  ambiguous turns (unchanged)
- All v4 BLOCKERs resolved by acknowledging the work, not by sleight
  of hand

If the scope is too big: do **Workstream A alone** (prompt-only
single-round preference) as the 3-day interim that gets audible from
4.55s → ~3.05s. Below the 2-2.5s target but a meaningful win at <10%
of v5's effort.

## v4 BLOCKER closure (no hand-waving this time)

### v4-B1: `tool_choice` shape + target wrong

**Fix:** Drop the `tool_choice` change entirely from this plan. Stage
6 `runToolLoop` at `stage6-tool-loop.js:197` already omits
`tool_choice` (defaults to auto). The Stage 6 agentic prompt at
`config/prompts/sonnet_agentic_system.md` is the only thing that
needs editing. The legacy `record_extraction` path at
`eicr-extraction-session.js:1561,1811` stays untouched (it's not the
hot path for prod transcripts; that's Stage 6 live mode).

### v4-B2: ElevenLabsStreamClient needs incremental API — added

**Fix:** New module `src/extraction/elevenlabs-incremental-client.js`
(separate from the existing `ElevenLabsStreamClient` to avoid
breaking the deployed Stage 2.5 path).

```
class ElevenLabsIncrementalClient {
  open({apiKey, voiceId, modelId, outputFormat, voiceSettings,
        multiContext, contextId, signal})
    // Opens WS, sends BOS only. Does NOT send any text yet.
    // Resolves when BOS is acknowledged.

  pushTextDelta(text)
    // Sends {text, try_trigger_generation: false} per delta.
    // ElevenLabs buffers + synthesises when threshold reached.

  flushAndClose()
    // Sends {text:"", try_trigger_generation: true} EOS marker.
    // Resolves on isFinal.
    // multi-context variant sends {context_id, close_context: true}.

  onAudio(buf) callback — invoked per audio frame from ElevenLabs.
  abort() — closes WS, signals cancellation.
}
```

Effort: ~2 days for impl + 15 tests. Reuses the protocol shape work
from the existing client.

### v4-B3: runToolLoop is post-loop only — explicit API split

**Fix:** `runToolLoop` gains a `lifecycleHooks` option:

```
{
  onAssistantTextDelta(text)            // per-delta during a round
  onAssistantTextDone(fullText)         // content_block_stop on text
  onCompletedToolUse(toolUseBlock)      // content_block_stop on tool_use
  onRoundComplete({roundIdx, assistantMessage, stopReason, dispatchResults})
                                        // after a round's dispatchers ran
  onLoopComplete({allRounds, finalBundle, perTurnWrites})
                                        // after the whole loop terminates
}
```

The existing post-loop return remains the canonical path; hooks are
additive observers. Loaded Barrel's orchestrator subscribes to
`onAssistantTextDelta`, `onAssistantTextDone`, `onCompletedToolUse`,
`onRoundComplete` to drive its state machine.

Effort: ~2.5 days for the hook plumbing + tests + assembler
extension + assertions that the existing path is unchanged when no
hooks are passed.

### v4-B4: `extraction_supplement` not a wire type — use normal extraction

**Fix:** Loaded Barrel emits ONE extraction envelope at loop-complete
time (today's path, unchanged). The "fire" action does NOT emit an
extraction envelope early. Instead, the buffer's audio is streamed
to iOS via a SEPARATE WS message type that iOS already handles:
**`voice_command_response`** at
`ServerWebSocketService.swift:848-1009` is the closest existing
audio-bearing message but isn't quite right.

**Actually correct fix:** the audio rides on the EXISTING iOS-initiated
TTS POST path. The cache mechanism from v2 IS the delivery
mechanism. v5 brings it back — but with the v3-B2 race fixed by
NOT predicting from tool_use args (v4's win) AND delivering via the
existing route (v2's win).

Combined: speculator buffers audio, at round-1 message_stop runs
verdict, if FIRE → writes the buffered audio into a short-TTL cache
keyed by `(sessionId, hash(actualTextFromSonnet))`. When iOS POSTs
TTS with the bundler's final confirmation text, the cache hit
short-circuits.

**v3-B2 race comes back** unless the bundler's text matches the
speculator's text. v4 abandoned this; v5 reintroduces it with an
EXPLICIT MATCH RULE: the speculator captures `assistantText` from
the stream. At loop-complete the bundler builds confirmations from
the perTurnWrites. The cache is keyed by hash(bundler's final
text). The speculator must wait for `onLoopComplete` to know the
final text, hash it, then put the buffered audio under that key.

So the cache window is:
- t=0..1.65s: speculator streams Sonnet text to ElevenLabs;
  audio buffered server-side
- t=1.65s: round-1 message_stop. If FIRE verdict: hold buffered
  audio (don't cache yet)
- t=1.65..tEnd: rounds 2+3 run; bundler builds confirmations
- t=tEnd: cache.set(hash(bundlerText), bufferedAudio, ttl=2s)
- t=tEnd+~50ms: iOS POSTs TTS with bundlerText → cache hit
- audible at tEnd + ~80ms

Best case: tEnd ≈ 1.7s (single-round end_turn) → audible ~1.8s.
Worst case: tEnd ≈ 4.2s (three rounds) → audible ~4.3s + cache hit
shaves the 470ms TTS = audible ~3.8s.

### v4-B5: Double-speak — explicit suppression

**Fix:** The bundler builds confirmations as today. iOS receives
ONE extraction envelope with `confirmations: [{text}]`. iOS POSTs
TTS for each confirmation. ON THE SERVER, the TTS POST hits the
speculation cache. Cache hit serves the buffered audio.

**There is no double-speak because the buffered audio IS the
confirmation iOS would have synthesised live.** Same text source
(bundler), same speech.

The earlier concern was that the speculator might speak a different
text than the bundler. v5's contract: speculator's text is whatever
Sonnet's text stream emits in round 1; cache is keyed by hash of
BUNDLER's text. If they don't match, cache miss, iOS falls through
to live TTS, no double-speak (just no speedup).

## v4 IMPORTANT closures

| v4 IMP | v5 fix |
|---|---|
| `tool_choice:any` recovery prevents text-first | Recovery branch removed; if Sonnet emits text without tool_use, log + fall through to today's path (no early-fire, no retry). Acceptable — same latency as today, not worse. |
| 500ms drain is fantasy | Acknowledged; v5's cache approach removes the drain question entirely. iOS POST always arrives AFTER bundler emits, so cache timing is iOS-POST-latency-bounded, not Sonnet-loop-bounded. |
| Agentic prompt invariant ("don't acknowledge without record_reading") | v5 prompt change PRESERVES this: text-first is allowed ONLY when followed by a matching `record_reading` in the same assistant message. Prompt rule: "If you emit confirmation text, you MUST emit the matching record_reading immediately after." |
| DISCARD cost-tracking | Speculator always calls `recordElevenLabsStreamingStarted` before opening incremental client, and `…Terminal` in finally. Per-correlation, idempotent. |

## v5 design — the full system

### Workstream A: prompt change (3 days, low-risk)

`config/prompts/sonnet_agentic_system.md` revision:

Add at the end of the existing tool-instruction block:

```
TEXT-BEFORE-TOOL OPTIMISATION (new):

For SINGLE-VALUE record_reading turns (one reading, no ambiguity,
no other tool calls needed), emit a CONCISE confirmation text
BEFORE the record_reading tool_use call:

  Format: "Circuit N, <friendly_field> <value>."
  Examples:
    "Circuit 1, number of points 5."
    "Circuit 12, polarity confirmed."
    "Ze 0.19 ohms." (board reading)

You MUST follow the text immediately with the matching
record_reading tool call in the SAME assistant message. Do not
emit text without also emitting the tool call.

For multi-value turns, ask_user turns, observations, corrections,
or any other Stage 6 pattern: emit tool_use as before, NO
preceding text.
```

Cache invalidation cost: ~$0.06 one-time. Cost per turn:
+~30 output tokens × $0.000015 = +$0.00045 per single-value turn.

### Workstream B: incremental ElevenLabs client (2 days)

`src/extraction/elevenlabs-incremental-client.js` per §v4-B2 fix.
Tests cover: BOS-only open, push-text-delta with try_trigger_generation,
abort mid-stream, error handling, multi-context contextId,
deterministic timing fixtures.

### Workstream C: runToolLoop lifecycle hooks (2.5 days)

`src/extraction/stage6-tool-loop.js` + `stage6-stream-assembler.js`
extensions per §v4-B3 fix. Tests cover: hooks fire in correct
order, abort propagation, no-op when hooks not passed, multi-round
hook firing.

### Workstream D: Loaded Barrel orchestrator + cache (4 days)

`src/extraction/loaded-barrel.js`:
- Subscribes to lifecycle hooks
- Manages incremental ElevenLabs client lifecycle
- Buffers audio chunks
- At `onLoopComplete`, decides verdict + computes bundler-final-text
  hash + cache.set with TTL=2s
- AbortController per session, cancelled on session_stop

`src/extraction/loaded-barrel-cache.js`:
- In-process Map keyed by sha1(sessionId + normalisedText)
- TTL 2s (intentionally short — iOS POST is fast after bundle emit)
- Per-session LRU cap 10
- Global LRU cap 200
- `prune({sessionId})` called on session_stop

### Workstream E: keys.js cache short-circuit (1 day)

`streamConfirmationViaElevenLabs` top-of-function check:

```
const cached = loadedBarrelCache.consume(sessionId, text);
if (cached) {
  res.set('Content-Type', cached.contentType);
  res.set('X-Voice-Latency-Source', 'loaded_barrel_cache_hit');
  res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
  res.write(cached.audioBuffer);
  res.end();
  recordOutcome(cached.correlationId, 'loaded_barrel_hit', {...});
  return;
}
// existing streaming path unchanged
```

### Workstream F: telemetry + flags + env (1 day)

- `voice-latency-telemetry.js`: extend SERVER_OUTCOMES with
  `loaded_barrel_started`, `loaded_barrel_buffered`, `loaded_barrel_fired`,
  `loaded_barrel_discarded`, `loaded_barrel_hit`, `loaded_barrel_miss`,
  `loaded_barrel_aborted`. Extend KNOWN_SOURCES with `loaded_barrel`.
- `voice-latency-config.js`: add `'VOICE_LATENCY_LOADED_BARREL'` to
  SNAPSHOTTED_FLAGS + flag accessor.
- `ecs/task-def-backend.json`: add env var default false.

### Workstream G: cost-rate prep (0.25 days)

`cost-tracker.js`: `ELEVENLABS_RATE_PER_CHAR` `0.000030` →
`0.000050`. Update tests.

### Workstream H: prompt regression test infrastructure (3 days)

`tests/fixtures/historical-transcripts/` — 100+ anonymised
transcripts captured from production session-analytics S3.

`scripts/voice-latency-bench/replay-historical.mjs` — replays each
historical session against the current prompt and the new prompt,
diffs the tool_use sequence + the dispatched perTurnWrites. Reports:
- Tool-use emission rate per prompt
- Same-turn semantic-equivalence rate (record_reading args identical)
- ask_user emergence delta
- Cost delta per turn

### Workstream I: Stage 6 invariant test expansion (2 days)

`src/__tests__/stage6-invariants-loaded-barrel.test.js`:
- ask_user emergence still triggers correctly with text-first prompt
- board_op cross-references still fire on round 2
- observation auto-link to high-Zs still works
- clear_reading + re-record_reading round-trip still works
- multi-board context switches still work

These tests must pass identically with the prompt change applied.

### Workstream J: iOS minimal change — wire-type forward compat (3 days
iOS + TestFlight cycle)

iOS only needs ONE small change: handle a new optional
`fast_audible: true` field on the extraction envelope. When present,
iOS knows the confirmation TTS will be served from cache (latency
hint for the inspector telemetry). NO playback behaviour change —
iOS still POSTs `/api/proxy/elevenlabs-tts` and plays whatever audio
arrives. The hint is for telemetry parity only.

Without this iOS change, v5 still WORKS — the cache hit is
transparent to iOS. The iOS change is for telemetry only.

### Workstream K: harness scenarios + field assessment (3 days
backend + wall-clock 1-2 weeks field)

`tests/fixtures/voice-latency-scenarios/loaded_barrel/`:
- `loaded_barrel_fire_single_npts.yaml`
- `loaded_barrel_discard_multi_write.yaml`
- `loaded_barrel_discard_ask_user_in_round1.yaml`
- `loaded_barrel_discard_clear_then_re_record.yaml`
- `loaded_barrel_cache_miss_text_diverges.yaml`

Field assessment: 5-10 sessions over 2 weeks, captured per PLAN_v5
§A.5 field-test sheet. Rollback if FIRE rate <40% OR any audible
wrong-value report OR P95 audible (hit) >2.5s.

## Effort (full honest scope)

| Workstream | Days |
|---|---|
| A: prompt change | 3 |
| B: incremental ElevenLabs client | 2 |
| C: runToolLoop lifecycle hooks | 2.5 |
| D: Loaded Barrel orchestrator + cache | 4 |
| E: keys.js cache short-circuit | 1 |
| F: telemetry + flags + env | 1 |
| G: cost-rate prep | 0.25 |
| H: prompt regression infrastructure | 3 |
| I: Stage 6 invariant tests | 2 |
| J: iOS telemetry hint (optional) | 3 (iOS) |
| K: harness scenarios + field | 3 backend + wall-clock 2 weeks |
| **Total** | **~22 backend + 3 iOS + 2 wks wall-clock field** |

## Realistic latency outcome

| Scenario | FIRE/MISS | Audible (P50) |
|---|---|---|
| Single-value transcript, round-1 end_turn, cache hit | FIRE | **~1.8 s** |
| Single-value transcript, round-1 needs round 2 (rare), cache hit | FIRE | ~3 s |
| Single-value transcript, text diverges from bundler | MISS | ~4.55 s |
| Multi-value transcript | DISCARD | ~4.55 s (today) |
| ask_user-led transcript | DISCARD | ~4.55 s |
| Ambiguous / observation transcript | DISCARD | ~4.55 s |

Blended P50 estimate: **2.5-3.0 s** for the inspector mix.
**Hits the target on the common case but not as a blanket P50.**

## What v5 still doesn't solve

- Multi-value transcripts stay at ~4.55s. Mitigation: combine with
  Workstream A's single-round preference to flatten multi-value
  turns into multiple sequential single-value turns? Out of scope for
  v5.
- Observation extraction (high-Zs auto-linking) stays at ~4.55s.
- Dialogue-engine scripted flows (ring continuity, IR test) bypass
  the loaded barrel entirely — they're already separately optimised.

## Decision gate (before any code)

Pre-commit checks:
1. Read `config/prompts/sonnet_agentic_system.md` to confirm the
   text-first prompt change can be added cleanly (no contradiction
   with existing rules — Codex flagged line 182's "don't acknowledge
   without record_reading" which v5's rule preserves).
2. Run Workstream H's replay harness against the new prompt FIRST
   (before any code), in a throwaway branch. If tool-use emission
   rate drops below 95% → v5 is dead, revisit prompt.
3. Verify Anthropic's `stream-input` ElevenLabs WS supports
   incremental text deltas with the auto-buffering threshold
   behaviour assumed (Codex IMPORTANT note about 120-char threshold
   from ElevenLabs docs — incremental client must use `flush: true`
   or `try_trigger_generation: true` to bypass).

Three open questions for Derek:
1. **Sprint commitment:** 22 backend + 3 iOS + 2 wks field. Worth it
   vs the interim Workstream-A-only ~3.05s outcome?
2. **Multi-value & observation acceptance:** v5 leaves these on the
   4.55s path. Is that acceptable, or does v5 need to expand to
   cover them too (would add another ~10 days)?
3. **iOS telemetry hint (Workstream J):** worth a TestFlight cycle,
   or skip for v5 and add later?
