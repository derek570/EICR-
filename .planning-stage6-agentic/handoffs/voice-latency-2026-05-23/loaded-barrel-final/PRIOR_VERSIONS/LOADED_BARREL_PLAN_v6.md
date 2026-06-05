# Loaded Barrel v6 — Tool-Args Speculation, MP3, AlertManager Parity

**Date:** 2026-05-24
**Supersedes:** v5 (6 BLOCKERs incl. 2 NEW from Codex: AlertManager text expansion, PCM vs MP3 format mismatch).
**Strategy shift:** Abandon Sonnet-text streaming (v4/v5). Predict
confirmation text deterministically from tool_use args using the
SAME helper the bundler uses, render iOS AlertManager's text
expansion rules SERVER-SIDE, synth as MP3 (matching iOS's existing
AVAudioPlayer consumer), cache by `sessionId+turnId+expandedText`.

## v5 BLOCKER closure

| v5 BLOCKER | v6 fix |
|---|---|
| B1: bundler text ≠ Sonnet text | Drop Sonnet text source entirely. Speculator triggers on `onCompletedToolUse(record_reading|record_board_reading)` with COMPLETE input JSON. Renders confirmation text via SHARED `buildConfirmationText` from bundler. No prediction-vs-emission gap possible — same code path. |
| B2: no audio invalidation | AbortController per speculation. `onCompletedToolUse(clear_reading)` OR `onCompletedToolUse(record_reading)` with SAME (field,circuit,boardId) tuple in any round → controller.abort() + cache invalidate. Watcher subscribes to lifecycle hooks across all rounds. |
| B3: prompt rule unenforceable | No prompt change. Stage 6 agentic prompt untouched. Speculator works on whatever tool_use sequence Sonnet emits. |
| B4: cost double-record | Cache-hit path early-returns BEFORE `recordElevenLabsStreamingStarted` call in keys.js. Asserted by unit test that runs hit path against a spy CostTracker and verifies zero invocations. |
| B5: AlertManager text expansion | New shared module `src/extraction/tts-text-expander.js` that mirrors iOS `AlertManager.expandForTTS()` rules ("Ze" → "zed E", digit-by-digit decimals, etc). Speculator runs the expansion before synth + cache key. iOS unchanged. Phase 0 sub-task: capture every transform iOS AlertManager applies, write parity tests. |
| B6: PCM vs MP3 mismatch | Speculator uses `ElevenLabsIncrementalClient.openMp3({outputFormat: 'mp3_22050_32'})` (or just the existing `ElevenLabsStreamClient` configured for MP3). Cached buffer is MP3 bytes. iOS `AVAudioPlayer(data:)` consumes unchanged. |
| I1: TTL=2s too short | Bump to 15s. iOS DeepgramRecordingViewModel can defer TTS up to 8s; 15s gives comfortable headroom. Per-session LRU cap stays at 50; global at 500 to bound memory at ~20MB worst-case. |
| F1: multi-context strategy | Each speculation opens its own fresh single-shot ElevenLabsStreamClient (no pooling). Adds ~340ms cold BOS to each speculative synth but eliminates cross-turn audio bleed risk. Cost: 1 extra WS open per speculation; acceptable. Future v7 could add a per-session pool. |

## v6 design

### Phase 0 — RESEARCH (1 week, MANDATORY before any code)

Capture and document:
1. EVERY iOS `AlertManager` TTS-text transformation rule, with
   regression test fixtures (input text → expected expanded text).
   File: `src/__tests__/tts-text-expander-parity.test.js`.
2. The exact audio format iOS expects per route (`/api/proxy/elevenlabs-tts`
   batch path returns MP3; iOS uses `AVAudioPlayer(data:)`).
3. Full data flow doc: `LOADED_BARREL_DATAFLOW.md` covering every
   text/format/timing contract from "Sonnet emits tool_use" → "iOS plays
   audio".
4. Verify ElevenLabs `stream-input` WS supports `flush:true` to bypass
   the 120-char buffering threshold for short confirmations
   (~30-60 chars typical).

Output: deliverable docs. Gates Phase 2+.

### Phase 1 — incremental tests prove nothing breaks

A. Land cost-rate prep commit (`$0.000030` → `$0.000050/char`).

B. Export bundler helpers (`buildConfirmationText`,
   `CONFIRMATION_FRIENDLY_NAMES`, `CONFIRMATION_MIN_CONFIDENCE`) +
   move FRIENDLY_NAMES to leaf module `src/extraction/confirmation-text.js`.
   No behavioural change.

C. Land `src/extraction/tts-text-expander.js` with full iOS-parity
   test suite. Server-side `expandForTTS(text)` matches iOS
   `AlertManager.expandForTTS(text)` byte-for-byte across 50+ inputs.

D. Extend `voice-latency-telemetry.js` SERVER_OUTCOMES with
   `loaded_barrel_started/buffered/fired/discarded/hit/miss/aborted` +
   KNOWN_SOURCES with `loaded_barrel`.

E. Add `VOICE_LATENCY_LOADED_BARREL=false` to SNAPSHOTTED_FLAGS +
   task-def.

### Phase 2 — speculator + cache

A. New `src/extraction/loaded-barrel-cache.js`:
   - Key: `sha1(sessionId + ':' + turnId + ':' + expandedText)`
   - TTL: 15s
   - Per-session LRU cap 50, global 500
   - `consume(key)` is single-use
   - `invalidate(sessionId, turnId, field, circuit, boardId)` to drop
     entries matching tool_use coordinates (B2 fix)
   - `pruneForSession(sessionId)` on session_stop

B. New `src/extraction/loaded-barrel-speculator.js`:
   - Subscribed to `runToolLoop` lifecycle hooks
   - On `onCompletedToolUse(record_reading|record_board_reading)`:
     1. Compute predicted reading + predicted confirmation text via shared `buildConfirmationText`
     2. Apply `expandForTTS` → expandedText
     3. If `expandedText` is empty (e.g. polarity_confirmed=false) → skip
     4. If `(sessionId, turnId)` already has a pending speculation for this slot → abort it (B2)
     5. Mint correlationId, recordElevenLabsStreamingStarted(text.length, correlationId)
     6. Open `ElevenLabsStreamClient` with `outputFormat: 'mp3_22050_32'`, AbortController
     7. `client.synth(expandedText, {onAudio: (b) => buf.push(b)})`
     8. On success: cache.set(key, {mp3Buffer, correlationId, completeAt, ttlMs:15000}); recordElevenLabsStreamingTerminal('completed')
     9. On abort/error: recordElevenLabsStreamingTerminal('cancelled'|'failed'); cache nothing
   - On `onCompletedToolUse(clear_reading)` OR another
     `record_reading` with same (field, circuit, boardId) tuple later
     in the loop: `cache.invalidate(...)`, `controller.abort()`
   - On session_stop: `pruneForSession` + abort all pending

C. `runToolLoop` + `stage6-stream-assembler.js` gain lifecycle hooks
   (`onCompletedToolUse`, `onLoopComplete`). No-op when not passed.

### Phase 3 — keys.js cache short-circuit

`streamConfirmationViaElevenLabs` first line:

```
const turnId = req.body.turnId ?? null;
const cached = turnId ? loadedBarrelCache.consume(sha1(sessionId+':'+turnId+':'+text)) : null;
if (cached) {
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-store');
  res.set('X-Voice-Latency-Source', 'loaded_barrel_hit');
  res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
  res.write(cached.mp3Buffer);
  res.end();
  recordOutcome(cached.correlationId, 'loaded_barrel_hit', {meta: {sessionId, bytes: cached.mp3Buffer.length}});
  return;  // CRITICAL: skips ALL cost recorders (already attributed to speculator's correlationId)
}
// existing path unchanged
```

**Requires iOS to include `turnId` in the TTS POST body.** This is a
2-line iOS change in `AlertManager.swift` — add `turnId` field that
the iOS bundler-handler passes through from the received extraction
envelope's `result.turn_id` field.

Backend bundler emits `result.turn_id = perTurnWrites.turnId` (the
existing turnId from `runToolLoop` context).

### Phase 4 — iOS minimal change

Single iOS commit:
- `AlertManager.proxyElevenLabsTTS(text, sessionId, source, turnId?)` adds
  `turnId` param
- Caller passes through `extraction.result.turn_id` from the
  ServerWebSocketService dispatch

Backwards-compat: backend cache lookup keyed by turnId; if iOS POST
omits turnId, cache lookup skipped, falls to existing path. So old
iOS builds work unchanged.

### Phase 5 — Stage 6 invariant tests

`src/__tests__/stage6-invariants-with-loaded-barrel.test.js`:
- ask_user emergence unaffected (verdict-irrelevant)
- board_op cross-references unaffected
- observation auto-link unaffected
- clear_reading correctly invalidates speculation
- same-turn correction correctly invalidates
- multi-board context switches unaffected

### Phase 6 — harness scenarios

`tests/fixtures/voice-latency-scenarios/loaded_barrel/`:
- `loaded_barrel_single_npts_hit.yaml`
- `loaded_barrel_clear_invalidates.yaml`
- `loaded_barrel_same_slot_overwrite_invalidates.yaml`
- `loaded_barrel_polarity_false_skipped.yaml`
- `loaded_barrel_low_confidence_skipped.yaml`
- `loaded_barrel_multi_write_first_caches.yaml`

### Phase 7 — field assessment (2 weeks)

5-10 inspector sessions. Capture per PLAN_v5 §A.5 sheet + new
columns:
- HIT rate by transcript class
- INVALIDATE rate
- Wasted synth count per session
- Inspector "audible was correct" (boolean per confirmation)

Rollback criteria:
- HIT rate < 50%
- Any audibly-wrong confirmation
- P95 audible (hit) > 2.5s
- Cost overhead > 20%

## Effort (full scope)

| Phase | Days |
|---|---|
| 0 — Research (AlertManager parity, dataflow doc) | 5 |
| 1 — Cost-rate + helper exports + telemetry + flag | 2 |
| 2 — Speculator + cache + lifecycle hooks | 5 |
| 3 — keys.js short-circuit | 0.5 |
| 4 — iOS turnId pass-through (1 commit + TestFlight) | 1 + cycle |
| 5 — Stage 6 invariant tests | 2 |
| 6 — Harness scenarios + results doc | 2 |
| 7 — Field assessment | 0 (wall-clock 2 wks) |
| **Total** | **17.5 backend + 1 iOS + 2 wks field** |

Smaller than v5 (22+3+2wks) because:
- No prompt change (drops Workstream A, ~3 days)
- No incremental ElevenLabsStreamClient (drops Workstream B, ~2 days)
- No runToolLoop API split (lifecycle hooks are additive)

## Realistic latency outcome

For value-bearing single-write transcripts (the common case):
- Bundler emits extraction at t=Tloop_end (≈1.7-4.2s depending on rounds)
- iOS POSTs TTS at t=Tloop_end + ~250ms (network + dispatch)
- Cache hit serves MP3 in ~30ms write+end → audible ~Tloop_end + 280ms

For single-round end_turn (lightest case):
- Tloop_end ≈ 1.7s
- Audible ≈ 1.98s
- **Within 2-2.5s target**

For 3-round common case:
- Tloop_end ≈ 4.2s
- Audible ≈ 4.48s
- Above target (same as today's batch path — no regression, but no improvement either)

**Net win:** ~470ms shaved off audible latency by skipping live ElevenLabs synth on cache hit. Stage 6 round-count is the dominant cost — Loaded Barrel doesn't fix that. To get round-count down requires prompt-side single-round preference (v5 Workstream A); that work is **NOT in v6** and is genuinely a separate sprint.

## What v6 explicitly does NOT do

- Does not change the Sonnet prompt
- Does not modify runToolLoop's loop structure (only adds observer hooks)
- Does not assume Sonnet streams text first
- Does not require new ElevenLabs API client
- Does not hit 2-2.5s on multi-round turns

## Cost analysis

ElevenLabs Flash $0.000050/char (post cost-rate prep).
Average confirmation: 50 chars × $0.000050 = $0.0025/synth.

| Scenario | Speculator cost | Live POST cost | Net |
|---|---|---|---|
| HIT (cache hit) | $0.0025 | $0 | $0.0025 (same as today's batch path) |
| MISS (cache empty) | $0 | $0.0025 | $0.0025 (today's batch) |
| WASTED (invalidated) | $0.0025 | $0.0025 | $0.0050 (1× extra) |
| TTL EXPIRY | $0.0025 | $0.0025 | $0.0050 (1× extra) |

At 70% HIT rate / 20% MISS / 10% WASTED:
- Average cost/turn: 0.7×$0.0025 + 0.2×$0.0025 + 0.1×$0.0050 = $0.00275
- vs today's $0.0025 → +10% TTS cost overhead
- 1000 turns/day = +$2.50/day

## Decision gate

Three pre-code checks:
1. iOS `AlertManager.expandForTTS` rules captured + parity tests pass
2. ElevenLabs WS `flush:true` confirmed working for ~30-char texts
3. `turnId` round-trip verified (backend emits → iOS receives → iOS sends back)

If any of those fail → revise v6 before any production code lands.
