# Single-Round Latency Sprint — Plan v3

**Date:** 2026-05-25
**Status:** DRAFT — pending round 3 review.
**Supersedes:** PLAN_v2.md. Closes all 4 Codex BLOCKERs (NB1 protocol wording, NB2 suppression-without-ACK, NB3 4xx-fallback speaks rejected, B10 telemetry sufficiency) + all 4 Claude IMPORTANTs (streaming_http_audio gate, suppression-key shape, iOS expanded_text, cost-on-LB-on).

---

## §A — Locked pivots (carried forward from v2)

1. **Phase 2** = server-side `runToolLoop` early-terminate AFTER round-1 dispatch. Pushes the **REAL non-empty `toolResults`** user message (NOT empty — Codex NB1 fix), synthesises terminal_reason='early_terminated' (NOT a fake stop_reason — Codex I1 fix), skips the round-2 `client.messages.stream` invocation.
2. **Phase 1** = Mode A only. Audio-only fast-TTS. Sonnet remains authoritative for all writes. No fast-write endpoint.
3. **Cache parity** = friendly-name canonical end-to-end. Bundler ships `confirmations[].expanded_text` field; iOS consumes it verbatim (skipping local re-expansion); speculator's cache key is byte-identical to iOS's POST.

---

## §B — NEW v3 pivots (close v2 BLOCKERs)

### Pivot 4 — Suppression moves from BACKEND to iOS (closes Codex NB2 + Claude NB1)

v2 had the bundler suppress its own emission via a backend-side `fastPathConfirmationsByTurn` set populated by the fast-tts endpoint on synth completion. Both reviewers flagged this as broken: backend doesn't know if iOS actually PLAYED the audio. Partial failures (ElevenLabs 200 but iOS playback failed) silently drop the audible.

**v3 design:** Bundler ALWAYS emits `confirmations[]` (no backend suppression). iOS maintains a local `playedFastPathSlots: Set<"${correlationId}::${field}::${circuit}::${boardId}">` keyed by the fast-path correlation_id + slot. iOS consults this set when handling bundler confirmations from the WS extraction message — if the slot was already played via fast-path TTS in this turn, iOS suppresses local re-playback. Otherwise iOS plays the bundler-emitted confirmation as today.

Why this is safer:
- iOS playback failure → set stays empty → bundler confirmation plays → user hears confirmation (correct).
- iOS playback success → set populated → bundler confirmation suppressed → user hears one confirmation (correct).
- iOS network failure on fast-tts → set stays empty → user hears Sonnet's bundler confirmation at ~4.7s baseline. Latency regression vs Mode-A-success but NEVER silent loss.

Specification:
- iOS's `playedFastPathSlots` Set is per-turn, cleared when `turnId` changes. iOS already tracks turnId via Phase 4a wire.
- iOS marks slot on `AVAudioPlayer.play()` returning success (NOT on POST 200). The "ack" is iOS's own playback start, not an HTTP signal.
- iOS dedup logic lives in `AlertManager.swift:speakBriefConfirmation` — early-return when slot in set.

### Pivot 5 — 4xx/kill-switch fallback path REJECTS local synthesis (closes Codex NB3)

v2 said "iOS falls back to live synth via the existing AlertManager retry path" on 4xx errors. Codex flagged this: AlertManager's `speakLocallyAsFallback` (`AlertManager.swift:1158-1164`) speaks the same text via Apple native TTS. For backend eligibility rejections (`wrong_board`, `unknown_circuit`, `not_eligible`, kill-switch), iOS would audibly confirm a candidate the backend just said is unsafe.

**v3 design:** iOS's fast-tts POST handling splits by HTTP status:
- **200 (audio success):** play audio, mark slot in `playedFastPathSlots`.
- **409 (wrong_board / unknown_circuit / slot_already_committed) / 422 (not_eligible) / 503 (kill_switch):** abandon fast-path silently. Do NOT play. Do NOT mark slot. Wait for Sonnet's bundler confirmation to fire at ~4.7s baseline.
- **5xx (server error) / network error / timeout:** abandon fast-path silently. Same as eligibility rejection.

The "fall back to AlertManager local TTS" path is REMOVED from fast-tts POST handling. AlertManager local fallback continues to fire for OTHER POST paths (e.g. `proxyElevenLabsTTS` on bundler confirmations) — only fast-tts loses that fallback.

### Pivot 6 — Telemetry covers every fact needed to diagnose v3's paths (closes Codex B10 not-closed)

v2's `turn_summary` row was insufficient. v3 row adds:

| New field | Type | Purpose |
|---|---|---|
| `fast_tts_correlation_id` | string\|null | iOS-minted correlation_id for the fast-path POST (if any) |
| `fast_tts_slot` | `{field, circuit, boardId}` \| null | the slot iOS POSTed for |
| `fast_tts_outcome` | enum | `n/a` \| `ack_played` \| `eligibility_rejected_409` \| `eligibility_rejected_422` \| `kill_switch_503` \| `network_failed` \| `audio_played_but_ack_dropped` |
| `ios_playback_ack` | `{at_ms, source}` \| null | iOS-reported playback-start timestamp + source (`fast_tts` \| `bundler` \| `local_fallback`) |
| `bundler_emitted_confirmations` | array of `{field, circuit, board_id, text, expanded_text}` | what the bundler actually emitted (no backend suppression in v3) |
| `bundler_confirmations_suppressed_by_ios` | array of slot tuples | inferred from absence of `ios_playback_ack(source=bundler)` for slots the bundler emitted |
| `actual_stop_reason_per_round` | array of strings | Anthropic's real `stop_reason` (closes Codex I1) |
| `terminal_reason` | enum | `end_turn` \| `early_terminated` \| `cap_hit` \| `aborted` |
| `early_terminate_predicate_result` | `{fired: bool, reject_reason: string\|null}` | which branch of the predicate fired (or which guard rejected) |
| `loaded_barrel_speculator_skipped_by_fast_tts_hint` | bool | when speculator skipped pre-synth due to fast-tts hint (Pivot 7 below) |
| `tool_names_per_round` | `[['record_reading'], []]` | adoption-rate denominator filter (Claude NI5 fix) |

iOS-reported fields (`ios_playback_ack`) are POSTed via a new endpoint `POST /api/voice-latency/playback-ack` at iOS turn-end, with `{sessionId, turnId, slot, source, at_ms}`. Backend correlates by `turnId` into the corresponding `turn_summary` row before emit. Until iOS ships the ACK (Phase 1 work), the field is null and `audible_first_byte_ms` is server-side `res.write(mp3_first_chunk)` time, explicitly marked `headline_metric_is_server_side: true` so dashboards know it's an upper bound, not iOS-perceived audible time.

Codex Claude N1 fix: `audible_first_byte_ms_source` field also added with values `server_res_write` \| `ios_playback_ack` to disambiguate.

### Pivot 7 — Speculator gets `fast_tts_hint` to skip wasted pre-synth (closes Claude I4 cost-on-LB-on)

v2 acknowledged Loaded Barrel speculator still fires on every `record_reading` and its cache entry goes unclaimed when iOS already heard fast-path audio (+$0.0025/turn wasted synth). v3 closes:

iOS attaches `regex_fast_correlation_id` to the WS transcript message (v2 already specified this). v3 extends: sonnet-stream.js writes the correlation_id into a per-session `pendingFastTtsSlots: Set<"${field}::${circuit}::${boardId}">` BEFORE the runToolLoop is invoked for that turn. The Loaded Barrel speculator's `onToolUseStreamed` hook reads this set: when the streamed record_reading tool_use's slot is in the set, the speculator skips its pre-synth (emits `loaded_barrel_skipped_fast_tts_hint` event). Cache entry never opens, no wasted synth, $0 cost.

Bundler-emitted confirmation still fires for that slot (no backend suppression in v3 per Pivot 4) — iOS dedups it locally via `playedFastPathSlots`.

iOS POSTs the WS transcript with correlation_id BEFORE Sonnet's stream begins (transcript triggers Sonnet), so the speculator's hook reads a populated set at content_block_stop time. Race-free under normal timing.

Edge: if Deepgram-final + iOS-regex-match + WS transcript with correlation_id ALL arrive AFTER Sonnet's stream already started (rare — would require Sonnet to start on a non-finalised speech segment), the speculator may have already opened a synth. Mitigation: `pendingFastTtsSlots` add ALSO triggers `controller.abort()` on any in-flight speculator synth matching that slot. Existing `pendingControllers` Set in `loaded-barrel-speculator.js:130` is the abort surface.

---

## §C — Phase summary updated

| Phase | Effort | What | Latency saving | Cost vs LB-on baseline |
|---|---|---|---|---|
| **0 — Telemetry** | 2-3 days backend + 1 day iOS | `turn_summary` row + iOS `/playback-ack` endpoint | enables measurement | ~0 |
| **1 — Mode-A fast-TTS** | 4-6 days backend + 10-12 days iOS | iOS regex matcher widened + fast-TTS endpoint productionised + iOS-side suppression + 4xx-no-fallback + speculator-skip-on-hint | ~420ms audible on covered turns | **$0** (speculator-skip closes the wasted-synth surface) |
| **2 — Server-side early-terminate** | 5-8 days backend (incl. review) | `shouldEarlyTerminate` predicate skips round-2 invocation | ~2-2.5s on eligible turns | −50% Sonnet cost on eligible turns |

Combined target: ~4.7s → ~420ms on fast-path-eligible turns; ~4.7s → ~2.5s on Sonnet-only single-record_reading turns. Non-eligible turns (multi-value, corrections, observations, ask_user) stay at ~4-5s by design.

---

## §D — Phase 0 detailed (telemetry)

### What ships (additions vs v2)

**Module:** `src/extraction/voice-latency-turn-summary.js`
- `emitTurnSummary` takes the v2 union plus Pivot 6's new fields.

**iOS-side new endpoint POST:** `/api/voice-latency/playback-ack`
- Body: `{sessionId, turnId, slot: {field, circuit, boardId}, source: 'fast_tts'|'bundler'|'local_fallback', at_ms: number}`
- Backend stores per-turnId pending ACKs in a session-scoped Map; `emitTurnSummary` drains them at end-of-turn.

**runToolLoop return field:** `round_timings`, `actual_stop_reason_per_round`, `terminal_reason`, `tool_names_per_round` (all per Codex I1 + Claude NI5).

### Verification gate G0 (strengthened per Claude NB4)

- Row cardinality: `turn_summary` rows for ≥99% of turns within 24h.
- **Content-quality gates (new in v3):**
  - `audible_first_byte_ms != null` for ≥95% of fast_path turns AND ≥95% of sonnet_lb_hit turns.
  - `sonnet_round1_ms != null AND > 0 AND < 30000` for ≥99% of turns.
  - `round_timings.length === rounds` invariant holds.
  - `path` is a non-null enum value.
  - `tool_names_per_round` array shape matches `tool_call_count_per_round` (length-equal per round).

### Things NOT to break (carried forward + Codex I2 addition)

- Existing `voice_latency.outcome` events — unchanged.
- The `runToolLoop` signature changes are ADDITIVE: new optional opts `earlyTerminateEnabled`, `earlyTerminateSession`, `perTurnWritesRef` (now always passed, not gated on Loaded Barrel — Codex I2 fix). Existing callers that don't pass these get today's behaviour.

---

## §E — Phase 1 detailed (Mode-A fast-TTS) — v3 deltas

### `streaming_http_audio` gate REMOVED (closes Claude I1)

`src/routes/voice-latency-fast-tts.js:80-82` currently returns 412 if iOS doesn't advertise `hasStreamingHttpAudio`. v3 endpoint:
- REMOVES the `hasStreamingHttpAudio` check.
- ADDS gate on `regex_fast_v2` capability (new bit). Bit added to `KNOWN_SUPPORTS` in `voice-latency-config.js:139-145`.
- Existing `regex_fast_tts` flag continues to gate the endpoint at the per-session config layer.

### Suppression-key shape locked to SLOT (closes Claude I2)

`session.fastPathConfirmationsByTurn` REMOVED entirely — Pivot 4 moves suppression to iOS. Backend has no suppression map.

`session.pendingFastTtsSlots: Map<turnId, Set<"${field}::${circuit}::${boardId}">>` ADDED — populated when WS transcript carries `regex_fast_correlation_id` + slot. Consumed by the Loaded Barrel speculator's `onToolUseStreamed` hook for Pivot 7. Cleared on `endTurn` lifecycle hook + LRU-capped at 100 entries (closes Claude NI1).

### iOS-side `expanded_text` consumption SPECIFIED (closes Claude I3 + Codex I3)

`Sources/Services/ClaudeService.swift` `ValueConfirmation` struct — add `let expandedText: String?` with `CodingKey "expanded_text"`. `decodeIfPresent` for back-compat.

`Sources/Recording/AlertManager.swift:speakBriefConfirmation` (line ~1057) — when the source confirmation has `expandedText` non-empty, POST it directly as the `text` field to `/api/proxy/elevenlabs-tts`; do NOT call `Self.expandForTTS(text)` to re-expand. Backwards-compat: when `expandedText` is nil (older bundler builds before v3 ships), fall through to today's local expansion.

Backend bundler change in `src/extraction/stage6-event-bundler.js:synthesiseConfirmations` (line 50-80): import `expandForTTS` from `src/extraction/tts-text-expander.js`; set `expanded_text: expandForTTS(text)` on each emitted confirmation. Same function the speculator uses for cache key (`loaded-barrel-speculator.js:148-150`). Contract test (NEW) `src/__tests__/loaded-barrel-bundler-parity.test.js` asserts byte-identity between speculator's cache-key expandedText and bundler's `expanded_text` for the same `(field, circuit, value)` triple (closes Claude NB2).

### Cost honest statement (closes Claude I4)

With Pivot 7 (speculator skip on fast-tts hint), per fast-path turn:
- 1× ElevenLabs fast-TTS synth ($0.0025) — the new audible.
- 0× ElevenLabs speculator pre-synth (skipped via hint).
- 0× ElevenLabs live-synth from bundler-driven path (iOS-side suppression).
- Sonnet still runs (no Sonnet cost saving — Mode A is audio-only).

Net vs LB-on baseline (1× speculator + 0-1× live synth depending on HIT): **$0** (replacing speculator synth with fast-tts synth — same cost surface). Net vs pre-LB baseline (1× live synth): **break-even**.

Race C carried over (correlation_id never causes a `recordFastPathConfirmation` call): speculator pre-synth happens normally since the set was never populated. iOS dedups locally. Net cost: 1× speculator + 1× fast-tts (transient when fast-tts failed) — same as today's failure-fallback path.

### iOS scope v3 (revised)

Total ~10-12 days (vs v2's 8-10):
- 2d: regex matcher extension (5 new patterns, ref-number only).
- 1.5d: APIClient.proxyRegexFastTTS + AVAudioPlayer playback.
- 1.5d: capability handshake + `regex_fast_v2` bit.
- 1d: transcript WS correlation_id field.
- 2d: iOS-side `playedFastPathSlots` dedup in AlertManager (NEW v3 scope — was backend).
- 1.5d: `expanded_text` consumption in AlertManager + ValueConfirmation decoding.
- 0.5d: 4xx-no-fallback handler (NEW v3 — no local TTS on eligibility rejection).
- 1d: playback-ack endpoint client.
- 1.5d: unit tests + UI tests.
- 1d: TestFlight cycle.

### Race catalogue v3 (revised)

**Race A — fast-tts succeeds, bundler ALSO emits.**
Resolution: bundler emits as usual; iOS's `playedFastPathSlots` (populated when fast-tts AVAudioPlayer.play() succeeds) suppresses local playback of the bundler's confirmation. Single audible (the fast one).

**Race B — fast-tts fails before bundler emits.**
Resolution: iOS doesn't populate playedFastPathSlots. Bundler emits at ~4.7s, iOS plays Sonnet's confirmation. Single audible (Sonnet's), at baseline latency. No silent loss.

**Race C — fast-tts succeeds but iOS playback fails post-AVAudioPlayer.**
Resolution: `playedFastPathSlots` populated only when `AVAudioPlayer.play()` returns `true`. If it returns false (audio session conflict, decode error), set stays empty, bundler's confirmation plays. Single audible.

**Race D — eligibility rejection (409/422).**
Resolution: iOS DOES NOT play local fallback (Pivot 5). DOES NOT mark slot. Bundler's confirmation plays at baseline. Single audible.

**Race E — concurrent multi-board switch.**
Resolution: fast-tts endpoint validates `req.body.boardId === session.currentBoardId`. Drift → 409 → Race D handling. (Closes Codex B9.)

**Race F — iOS network drops mid-fast-tts.**
Resolution: iOS catches timeout, abandons silently. `playedFastPathSlots` empty. Bundler confirmation plays. Single audible.

**Race G — Deepgram emits two finalised segments for one utterance.**
Resolution: iOS dedup at the transcript layer (existing). At most one fast-tts POST per logical utterance. Backend never sees the dup.

**Race H (NEW v3) — fast-tts AVAudioPlayer.play() success but no playback-ack POST reaches backend (network drop after audio played).**
Resolution: backend `turn_summary` shows `fast_tts_outcome: audio_played_but_ack_dropped` (inferred from synth-completion telemetry + absence of ACK). iOS heard audio; cert was written normally by Sonnet. Telemetry distinguishes from genuine play failure.

### Verification gate G1 (strengthened per Claude NI6 + Codex Claude I1 IMPORTANTS)

| Sub-gate | Pass criteria |
|---|---|
| G1.iOS | Derek's iPad reports `regex_fast_v2` capability + sends playback-ack POSTs. |
| G1.a | `path = "fast_path"` ≥30% of eligible turns AND `fast_tts_outcome === "ack_played"` ≥95% of fast_path turns. |
| G1.b | P50 `audible_first_byte_ms` (preferring `ios_playback_ack` source) ≤500ms on `fast_path` turns. P95 ≤800ms. |
| G1.c | iOS suppression correctness: when `fast_tts_outcome === "ack_played"`, `ios_playback_ack(source=bundler)` for the SAME slot is NEVER present in the same turn_summary. (Positive verification of iOS-side dedup.) |
| G1.d | iOS no-fallback correctness: when `fast_tts_outcome IN (eligibility_rejected_409, eligibility_rejected_422, kill_switch_503, network_failed)`, iOS does NOT POST `ios_playback_ack(source=local_fallback)` for that slot — verified by absence in 100% of rejection cases. |
| G1.e | Cert correctness: cert-row-error rate unchanged. |

---

## §F — Phase 2 detailed (server-side early-terminate) — v3 deltas

### Predicate null-safety (closes Claude NB3 + Codex I4)

```js
function shouldEarlyTerminate({ records, toolResults, perTurnWrites, session }) {
  // Hard-null defence — predicate must never throw
  if (!session?.stateSnapshot) return false;
  const snapshot = session.stateSnapshot;
  if (!snapshot.circuits) return false;
  if (!Array.isArray(records) || !Array.isArray(toolResults)) return false;
  if (!perTurnWrites || typeof perTurnWrites !== 'object') return false;

  // Reject on any error
  if (toolResults.some((r) => r.is_error === true)) return false;

  // Multi-board guard — REJECT if more than one board OR currentBoardId not main
  const mainBoardId = getMainBoardId(snapshot); // returns 'main' as default for legacy
  if (!mainBoardId) return false; // unknown state → conservative
  const boards = Array.isArray(snapshot.boards) ? snapshot.boards : [];
  if (boards.length > 1) return false; // any multi-board session → round 2
  if (snapshot.currentBoardId && snapshot.currentBoardId !== mainBoardId) return false;

  // All tool_use blocks in this round must be record_reading
  const allRecordReading = records.every((r) => r.name === 'record_reading' && !r.error);
  if (!allRecordReading) return false;
  // Exactly one record_reading
  if (records.filter((r) => r.name === 'record_reading').length !== 1) return false;
  // Exactly one perTurnWrites entry (handles idempotent rewrite — Claude NI4)
  if (perTurnWrites.readings.size !== 1) return false;
  // Nothing else accumulated
  if (perTurnWrites.cleared.length > 0) return false;
  if (perTurnWrites.observations.length > 0) return false;
  if (perTurnWrites.circuitOps.length > 0) return false;
  if (perTurnWrites.boardOps.length > 0) return false;
  if (perTurnWrites.fieldCorrections.length > 0) return false;
  if (perTurnWrites.boardReadings.size > 0) return false;
  return true;
}
```

Predicate exports both result and `reject_reason: string|null` so `turn_summary.early_terminate_predicate_result` field is populated (closes Codex Claude NI5).

### Protocol-correct early-terminate path (closes Codex NB1)

`runToolLoop` early-terminate branch (after the normal dispatch loop at line ~743 has built `toolResults`):

```js
// runs AFTER `messages.push({ role: 'user', content: toolResults })` at line 743
if (earlyTerminateEnabled && earlyTerminateSession && rounds === 1) {
  const ptw = typeof perTurnWritesRef === 'function' ? perTurnWritesRef() : null;
  if (ptw) {
    const result = shouldEarlyTerminate({
      records,
      toolResults,
      perTurnWrites: ptw,
      session: earlyTerminateSession,
    });
    if (result === true) {
      // Synthesise terminal_reason (NOT a fake stop_reason — Codex I1 fix).
      // stopReason stays as Anthropic-reported 'tool_use' for round 1.
      // The new terminal_reason field on the return value carries the early-terminate signal.
      terminalReason = 'early_terminated';
      // The tool_results user message is ALREADY pushed at line 743.
      // No empty array, no protocol violation.
      break; // exit the while loop without invoking round 2
    }
  }
}
```

Loop return value adds `terminal_reason: 'end_turn' | 'early_terminated' | 'cap_hit' | 'aborted'`. Existing `stop_reason` field stays exactly as Anthropic-reported (Codex I1 fix).

### Cost-tracker idempotency (closes Codex Claude I2 IMPORTANT, Codex Claude open Q 2)

`addSonnetUsage` is called from `runShadowHarness` once per turn regardless of `terminal_reason`. The cap-hit branch and the early-terminate branch both fall through to the same end-of-turn `usage` accumulation. Verified safe: `usage` is summed across rounds in the loop body BEFORE the break; the cap-hit and early-terminate breaks exit AFTER usage was added for the just-completed round. End-of-turn `addSonnetUsage(toolLoopOut.usage)` runs exactly once per turn.

Integration test `src/__tests__/stage6-early-terminate-cost.test.js` asserts: a 1-round early-terminate turn calls `addSonnetUsage` exactly once with `usage.input_tokens + usage.output_tokens > 0`.

### Predicate vs cap-hit ordering (closes Codex Claude NN3)

`maxRounds` defaults to 8. The cap-hit branch fires when `rounds >= maxRounds` AND `stop_reason === 'tool_use'` (line 419). The early-terminate check runs AFTER the normal dispatch branch (which only runs when `rounds < maxRounds`). So early-terminate can ONLY fire on `rounds < maxRounds`. Test fixtures with `maxRounds === 1` would hit cap-hit FIRST (rounds becomes 1, dispatch loop runs, line 419 sees rounds >= 1 = maxRounds, cap-hit branch fires). Early-terminate never evaluates. Behaviour: cap-hit pushes synthetic abort results, breaks. Correct.

Integration test `src/__tests__/stage6-early-terminate-cap-interaction.test.js` covers `maxRounds: 1` with a single clean record_reading: cap-hit fires, early-terminate does not, message_final ends with abort tool_results.

### Verification gate G2 (strengthened per Claude NI5 + Codex Claude I5)

| Sub-gate | Pass criteria |
|---|---|
| G2.unit | `stage6-early-terminate.test.js` ≥30 predicate cases pass including null-safety branches. |
| G2.integration | 6 runToolLoop integration tests: clean-record_reading → terminal_reason='early_terminated' + rounds=1 + state-mutation-asserted + addSonnetUsage-once. Multi-record_reading → terminal_reason='end_turn' + rounds=2. Record_reading + error → rounds=2. Record_reading + ask_user → rounds=2. Multi-board session → rounds=2. Cap-hit with maxRounds=1 → cap_hit branch wins, early-terminate not evaluated. |
| G2.adoption | Filter denominator: `tool_names_per_round[0] === ['record_reading'] AND tool_error_count_per_round[0] === 0 AND board_count === 1`. In this denominator, `terminal_reason === 'early_terminated'` ratio ≥99% (deterministic — server-side predicate, not Sonnet-adoption). |
| G2.latency | P50 `audible_first_byte_ms` on `terminal_reason === 'early_terminated'` turns ≤2500ms. P95 ≤3500ms. |
| G2.correctness | Cert-row-error rate week-over-week within ±5%. |
| G2.parity | `loaded-barrel-bundler-parity.test.js` passes (closes Claude NB2). |

---

## §G — Phase ordering invariant (carried forward, strengthened)

```
Phase 0 deploys → 24h G0 + content-quality gates pass →
Phase 1 backend deploys (flag-off) → iOS TestFlight build →
   G1.iOS gate (Derek's iPad ready) →
Phase 1 prod flag flip → 1-week field test (G1.a-e all pass) →
Phase 2 deploys (flag-off) → G2.unit + G2.integration pass →
Phase 2 flag flip 1% → 10% → 50% → 100% over 1 week →
G2.adoption + G2.latency + G2.correctness + G2.parity all pass →
1-week post-Phase-2 field test under combined Phase 1 + Phase 2 conditions (re-verify Race A under wider race window per Claude open Q1) →
G3 sprint complete.
```

The post-Phase-2 re-verification of Phase 1 race conditions (Claude open Q1) is now an explicit gate, not an open question.

---

## §H — Hard non-goals (carried forward)

1. Conversational / multi-value / ask_user turns stay at ~4-5s.
2. Mode B paired fast-write.
3. Haiku-on-round-2.
4. iOS-side designation matching (deferred to v3-of-this-plan).
5. Text-before-tool prompt change (deferred — assembler text-block extraction would be a separate sprint).
6. Multi-context ElevenLabs WS pooling.
7. Reducing Sonnet's per-round wall-clock below 2s.

---

## §I — Files to read (per phase, verified against current paths)

### Phase 0
- `src/extraction/voice-latency-telemetry.js` — extend SERVER_OUTCOMES.
- `src/extraction/stage6-tool-loop.js:316-456` — capture per-round timestamps + new return fields.
- `src/extraction/stage6-shadow-harness.js:197` (`runLiveMode`) + `:625-641` — end-of-turn `emitTurnSummary` hookup (note path correction — `runLiveMode` lives here, NOT `sonnet-stream.js` — closes Claude NN1).
- iOS `Sources/Services/APIClient.swift:854-895` — new `postPlaybackAck` method.

### Phase 1
- `src/routes/voice-latency-fast-tts.js:80-82` — REMOVE `hasStreamingHttpAudio` gate.
- `src/routes/voice-latency-fast-tts.js:39-50` — REMOVE local `FRIENDLY` table; import `buildConfirmationText`.
- `src/extraction/voice-latency-config.js:139-145` — ADD `regex_fast_v2` to `KNOWN_SUPPORTS`.
- `src/extraction/voice-latency-config.js:SNAPSHOTTED_FLAGS` — ADD `VOICE_LATENCY_ROUND1_EARLY_TERMINATE` (closes Claude NN4).
- `src/extraction/eicr-extraction-session.js` — ADD `pendingFastTtsSlots: Map<turnId, Set>` per-session; clear on endTurn; LRU cap 100.
- `src/extraction/loaded-barrel-speculator.js:onToolUseStreamed` — consult `session.pendingFastTtsSlots`; skip + emit `loaded_barrel_skipped_fast_tts_hint`.
- iOS `Sources/Recording/TranscriptFieldMatcher.swift` (NOT `Sources/Processing/` — closes Claude NN3) — 5 new regex patterns.
- iOS `Sources/Services/APIClient.swift` — `proxyRegexFastTTS`.
- iOS `Sources/Services/ClaudeService.swift:291-317` (`ValueConfirmation` struct) — add `expandedText` field.
- iOS `Sources/Recording/AlertManager.swift:1057-1059` — consume `expandedText` when present; skip local expansion.
- iOS `Sources/Recording/AlertManager.swift:speakBriefConfirmation` — add `playedFastPathSlots` dedup.
- iOS `Sources/Recording/AlertManager.swift:1158-1164` — guard local-fallback to ONLY non-eligibility-rejection failures (Pivot 5).

### Phase 2
- `src/extraction/stage6-tool-loop.js:316-456` — insert early-terminate branch after dispatch loop AND after `messages.push({role:'user', content: toolResults})` at line 743.
- `src/extraction/stage6-tool-loop.js` — extend return shape with `terminal_reason`, `actual_stop_reason_per_round`, `tool_names_per_round`.
- `src/extraction/stage6-multi-board-shape.js:50-55` — `getMainBoardId` already returns 'main' for missing boards array (Codex I4 confirmed defensive).
- `src/extraction/stage6-shadow-harness.js:327-329` — always pass `perTurnWritesRef` (no longer LB-gated — closes Codex I2).
- `src/extraction/stage6-early-terminate.js` (NEW) — exports `shouldEarlyTerminate`.

---

## §J — Open questions for round 3

1. **Polarity_confirmed reinstatement.** v2 dropped from eligibility. v3 leaves dropped. The fix (iOS-side "✓" → "Y" coercion before POST) is small. Should v3 add it back? Risk: low; reward: UX win on a common turn shape. Recommendation: add to v3 §E iOS list. Awaiting reviewer judgement.

2. **`headline_metric_is_server_side` marker.** v3 §B Pivot 6 adds this field for the transitional period before iOS playback-ack ships. Should the field also gate downstream Phase 1/2 sub-gate evaluations (i.e. don't compute G1.b until ACK shipping rate > 80%)? Currently not — gates use whichever timestamp is available with the source field as context.

3. **Speculator-skip telemetry granularity.** Pivot 7 emits `loaded_barrel_skipped_fast_tts_hint` per skipped slot. Should this also bubble up to the turn-summary's `loaded_barrel_speculator_skipped_by_fast_tts_hint` boolean (any-slot-skipped) AND a count? Current v3 says boolean only. Suggest adding count for richer dashboarding.

4. **Phase ordering re-verification.** §G makes post-Phase-2 race re-verification an explicit gate. Is the 1-week field window enough, or should we extend to 2 weeks given the wider race window Phase 2 introduces?

---

## Revision history

- **v1 (early 2026-05-25)** — initial draft. 5 BLOCKERs Claude / 10 BLOCKERs Codex.
- **v2 (late 2026-05-25)** — three structural pivots (server-side early-terminate, Mode A only, friendly-name canonical). Closed 15 of 15 v1 BLOCKERs. Codex round 2: 4 new BLOCKERs (NB1 wording, NB2 suppression, NB3 4xx-fallback, B10 not-closed). Claude round 2: 0 new BLOCKERs, 4 IMPORTANTs.
- **v3 (2026-05-25 night)** — four NEW pivots: iOS-side suppression (Pivot 4); no-local-fallback on eligibility rejection (Pivot 5); expanded telemetry (Pivot 6); speculator-skip on fast-tts hint (Pivot 7). Closes all v2 BLOCKERs from Codex + all v2 IMPORTANTs from Claude. Predicate hardened with null-safety + actual_stop_reason preservation.
