# Execution Handoff — Single-Round Latency Sprint

**Date:** 2026-05-25
**Convergence:** ZERO BLOCKERs from Claude Plan-agent AND Codex CLI (gpt-5.5, xhigh reasoning) over 8 rounds.
**Plan file:** `SINGLE_ROUND_LATENCY_PLAN_FINAL.md` (this folder, content of PLAN_v8 + convergence header).
**Review history:** `REVIEW_HISTORY.md` (this folder, all 16 reviews).
**Prior drafts:** `PRIOR_VERSIONS/` (v1 → v8 plans + 16 review files).

## Start here

1. **Read the plans IN ORDER.** PLAN_v8 is a SURGICAL revision; each plan from v2 onward is a delta on its predecessor. Read in this order:
   - `PRIOR_VERSIONS/PLAN_v2.md` — three foundational pivots (server-side early-terminate; Mode A only; friendly-name canonical).
   - `PRIOR_VERSIONS/PLAN_v3.md` — four expansion pivots (iOS-side suppression; no-native-fallback; expanded telemetry; speculator-skip).
   - `PRIOR_VERSIONS/PLAN_v4.md` — five surgical pivots (split telemetry; shared `_speculate` skip; 4-state iOS machine; abortBySlot; cleanup contract).
   - `PRIOR_VERSIONS/PLAN_v5.md` — eight pivot deltas (cost-tracker opts; deferredTTS; type normalization; active-sessions helper; late-ACK row; misc fixes).
   - `PRIOR_VERSIONS/PLAN_v6.md` — three pivot deltas (Started moved to text-sent boundary; decrement keyed by correlation_id; G0 gate pairing).
   - `PRIOR_VERSIONS/PLAN_v7.md` — four pivot deltas (durable Set; fastPathCorrelationIdByTurn lifecycle; signature change; test-only invariant).
   - `SINGLE_ROUND_LATENCY_PLAN_FINAL.md` (= PLAN_v8 content) — three final pivot deltas (Set scoped INSIDE createSpeculator closure; direct logger.info telemetry; dual-dedup documentation).

2. **Goal:** close the 4.7s → ~2.5s audible-latency gap on the dominant `record_reading` turn shape, AND close the 4.7s → ~420ms gap on the regex-fast-eligible subset.

3. **Three phases, strict ordering invariant (v3 §G):**

   ```
   Phase 0 deploys → 24h G0 + content-quality gates pass →
   Phase 1 backend deploys (flag-off) → iOS TestFlight build →
      G1.iOS gate (Derek's iPad ready) →
   Phase 1 prod flag flip → 1-week field test (G1.a-e all pass) →
   Phase 2 deploys (flag-off) → G2.unit + G2.integration pass →
   Phase 2 flag flip 1% → 10% → 50% → 100% over 1 week →
   G2.adoption + G2.latency + G2.correctness + G2.parity all pass →
   sprint complete.
   ```

4. **Phase 0 — Telemetry (1-2 days backend + 1 day iOS).** Two immutable log rows per turn: `voice_latency.turn_core_summary` (Sonnet + dispatch facts; emitted at runLiveMode end) and `voice_latency.turn_audio_summary` (cache + playback facts; emitted by delayed finalizer 8s after turn end OR when all expected ACKs received). New `/api/voice-latency/playback-ack` endpoint. New direct `logger.info` events `voice_latency.speculative_terminal_reason` and `voice_latency.speculative_terminal_skipped` (NOT through `recordOutcome` — see Pivot 11.10).

5. **Phase 1 — Mode A fast-TTS (4-6 days backend + 10-12 days iOS).** Productionise `/api/voice-latency/regex-fast-tts` (MP3 output, eligibility whitelist, boardId validation, accepts client-minted `correlationId`). NEW iOS function `playFastPathAudio()` that bypasses `shouldDeferPlayback` and DOES NOT fall back to native TTS on 4xx. iOS 5-state machine in AlertManager (`idle | fastPending | fastPlayed | bundlerPlayed | resolved`) with `pendingBundlerConfirmations` queue. Speculator skips pre-synth when `regex_fast_correlation_id` present (via `_speculate()` shared preflight). Sonnet remains authoritative for all snapshot writes.

6. **Phase 2 — Server-side round-1 early-terminate (5-8 days backend).** `runToolLoop` gains `shouldEarlyTerminate()` predicate (single-clean-record_reading on main board only). Skips round-2 invocation; pushes real (non-empty) tool_results user message; returns `terminal_reason: 'early_terminated'` while preserving Anthropic's actual `stop_reason: 'tool_use'`. ~2-2.5s saved per eligible turn.

7. **NOT in scope:** Mode B paired fast-write; Haiku-on-round-2; iOS designation matching; text-before-tool prompt change. See v2 §F + v3 §H.

## Critical files (verified against current code)

### Phase 0 — Telemetry
- `src/extraction/voice-latency-telemetry.js` — extend SERVER_OUTCOMES; add `emitTurnCoreSummary` + `emitTurnAudioSummary`. NEW telemetry events `voice_latency.speculative_terminal_reason` and `voice_latency.speculative_terminal_skipped` use direct `logger.info`, NOT `recordOutcome`.
- `src/extraction/voice-latency-turn-summary.js` (NEW) — per-row emit + delayed-finalizer + `pendingAckDecrements` (keyed by correlation_id, 60s expiry).
- `src/routes/voice-latency-playback-ack.js` (NEW) — POST endpoint, `auth.requireAuth`, body validation, late-ACK emits separate `voice_latency.late_playback_ack` row.
- `src/extraction/stage6-tool-loop.js:316-456` — capture per-round timestamps; add `round_timings[]`, `actual_stop_reason_per_round[]`, `terminal_reason`, `tool_names_per_round` to return value.
- `src/extraction/stage6-shadow-harness.js:197` (`runLiveMode`) + `:625-641` — `emitTurnCoreSummary` at end-of-turn; `startAudioFinalizer` arms the delayed `emitTurnAudioSummary`. Wrap body in `try/finally` to clear `session.pendingFastTtsSlots.delete(turnId)` AND `session.fastPathCorrelationIdByTurn.delete(turnId)`.
- iOS `Sources/Services/APIClient.swift` — new `postPlaybackAck(sessionId, turnId, slot, source, atMs)` method.

### Phase 1 — Mode A fast-TTS
- `src/routes/voice-latency-fast-tts.js:80-82` — REMOVE `hasStreamingHttpAudio` gate. Add `regex_fast_v2` capability check.
- `src/routes/voice-latency-fast-tts.js:39-50` — DELETE local `FRIENDLY` table; import `buildConfirmationText` from `confirmation-text.js`. Accept client-minted `correlationId` in request body.
- `src/extraction/voice-latency-config.js:139-145` — ADD `regex_fast_v2` to `KNOWN_SUPPORTS`. Add `VOICE_LATENCY_ROUND1_EARLY_TERMINATE` to `SNAPSHOTTED_FLAGS`.
- `src/extraction/active-sessions.js` — add `getActiveSessionEntry(sessionId)` helper. Allocate `session.pendingFastTtsSlots: Map<turnId, Set<slotKey>>` and `session.fastPathCorrelationIdByTurn: Map<turnId, Set<correlationId>>` in session-creation site.
- `src/extraction/loaded-barrel-speculator.js` — INSIDE `createSpeculator()` closure (alongside `pendingControllers` line 130 and `pendingByCorrelation`), add `costOpenByCorrelation: Set`. Move `recordElevenLabsSpeculativeStarted()` call from line 182-187 to AFTER key resolution + client construction + `controller.signal.aborted` guard, immediately before `client.synth()`. On Started success, `costOpenByCorrelation.add(correlationId)`. New `_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)` helper consults the Set; on terminal call, deletes the id (idempotency). Direct `logger.info('voice_latency.speculative_terminal_reason', ...)` and `('voice_latency.speculative_terminal_skipped', ...)` for telemetry. `shutdown()` adds sweep: `Array.from(costOpenByCorrelation)` snapshot, then loop `_maybeRecordTerminal(id, null, 'cancelled', {reason: 'speculator_shutdown'})` for each. Also add `abortBySlot({sessionId, turnId, boardId, field, circuit})` method with `slotMatches` predicate (normalize null vs "" boardId; coerce circuit via Number(); circuit:0 ≠ circuit:null).
- `src/extraction/loaded-barrel-speculator.js:onToolUseStreamed` AND `onSnapshotPatch` — skip check is in shared `_speculate()` preflight (both entry paths covered by one check).
- iOS `Sources/Recording/TranscriptFieldMatcher.swift` — 5 new numeric-circuit-ref regex patterns (NOT under `Sources/Processing/`).
- iOS `Sources/Services/APIClient.swift` — `proxyRegexFastTTS(...)` returns MP3 via existing AVAudioPlayer path. Mint UUIDv4 client-side for correlationId.
- iOS `Sources/Services/ClaudeService.swift:291-317` (`ValueConfirmation`) — add `let expandedText: String?` with `CodingKey "expanded_text"`.
- iOS `Sources/Recording/AlertManager.swift:906` (`speakBriefConfirmation`) — bundler-queue check at TOP via `fastPathSlotStates[slot]` state machine. Consume `expandedText` verbatim when present (skip local `expandForTTS`).
- iOS `Sources/Recording/AlertManager.swift` — NEW `playFastPathAudio(audioData, slot)` function. BYPASSES `shouldDeferPlayback`. On `AVAudioPlayer.play()` success → state `fastPending → fastPlayed` AND POST `playback-ack`.
- iOS `Sources/Services/ServerWebSocketService.swift:472-491` (`sendSessionStart`) — `capabilities.voice_latency.supports[]` adds `regex_fast_v2` + `client_playback_telemetry`.
- `src/extraction/stage6-event-bundler.js:50-82` (`synthesiseConfirmations`) — import `expandForTTS`; emit `confirmations[].expanded_text` = `expandForTTS(text)`.
- `src/extraction/cost-tracker.js` — extend `recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts={})`. Keep legacy enum `'completed' | 'cancelled' | 'failed'` for `terminal`. `opts.reason` and `opts.cancelledBeforeTextSent` accepted but vestigial post-v6 structural fix.

### Phase 2 — Server-side early-terminate
- `src/extraction/stage6-tool-loop.js:514-744` — NORMAL DISPATCH BRANCH; insertion site for predicate check AFTER `messages.push({role:'user', content: toolResults})` at line ~743. Insert BEFORE the next iteration's cap-hit check. Push REAL non-empty toolResults; set `terminalReason = 'early_terminated'`; keep `stopReason` as Anthropic-reported.
- `src/extraction/stage6-early-terminate.js` (NEW) — exports `shouldEarlyTerminate({records, toolResults, perTurnWrites, session})`. Hard guards: null-safety; `session.stateSnapshot.boards.length === 1`; `currentBoardId === mainBoardId`; exactly 1 record_reading; no other accumulator writes; no `is_error: true` tool_results.
- `src/extraction/stage6-multi-board-shape.js:50` — `getMainBoardId` (returns 'main' as default).
- `src/extraction/stage6-shadow-harness.js` — always pass `earlyTerminateEnabled`, `earlyTerminateSession`, `perTurnWritesRef` to `runToolLoop` (no longer LB-gated — v7 Pivot 11.6 / Codex I4 fix).

## Verification gates (per phase)

| Gate | Source | Pass condition |
|---|---|---|
| **G0** | Phase 0 deploy + 24h | Both `turn_core_summary` AND `turn_audio_summary` rows present for ≥99% of turns; CloudWatch JOIN query produces clean chart per `path_classification`. |
| **G1.iOS** | iOS TestFlight build with regex extension | Derek's iPad reports `regex_fast_v2` capability + sends playback-ack POSTs. |
| **G1.a** | Phase 1 flag on + 1 week field | Fast-path adoption ≥30% of eligible numeric-circuit-ref turns; `fast_tts_outcome === "ack_played"` ≥95% of fast_path turns. |
| **G1.b** | Phase 1 flag on + 1 week field | P50 `audible_first_byte_ms` on fast_path turns ≤500ms. P95 ≤800ms. (Prefer ACK-source over server-side first-byte when available.) |
| **G1.c** | Phase 1 flag on + 1 week field | iOS suppression correctness: 0 dual-audio events. |
| **G1.d** | Phase 1 flag on + 1 week field | No `local_fallback` ACKs for slots where `fast_tts_outcome IN (eligibility_rejected_*)`. |
| **G1.e** | Phase 1 flag on + 1 week field | Cert correctness: cert-row-error rate unchanged week-over-week. |
| **G2.unit** | Phase 2 PR | 30+ predicate tests + 7 integration tests pass (including cross-session shutdown isolation per Pivot 11.9). |
| **G2.adoption** | Phase 2 flag on | Of turns where `tool_names_per_round[0] === ['record_reading'] AND tool_error_count === 0 AND board_count === 1`, `terminal_reason === 'early_terminated'` ratio ≥99%. |
| **G2.latency** | Phase 2 flag on + 1 week | P50 `audible_first_byte_ms` on `terminal_reason === 'early_terminated'` turns ≤2500ms. P95 ≤3500ms. |
| **G2.correctness** | Phase 2 flag on + 1 week | Cert-row-error rate week-over-week within ±5%. |

## CloudWatch query examples (correct field name)

NIT note: Codex round-8 N-v8.1 — production logger serializes the first `logger.info()` arg as `message`, NOT `event`. Use `message =` in queries:

```
filter message = "voice_latency.speculative_terminal_reason"
| stats count() by reason
```

```
filter message = "voice_latency.turn_audio_summary" and audio_source = "fast_path"
| stats pct(audible_first_byte_ms, 50) as p50, pct(audible_first_byte_ms, 95) as p95
```

## Rollback per phase

- Phase 0: revert telemetry commits (observation-only; no rollback risk).
- Phase 1: `VOICE_LATENCY_REGEX_FAST_TTS=false` env flip on task-def.
- Phase 2: `VOICE_LATENCY_ROUND1_EARLY_TERMINATE=false` env flip on task-def.

## CRITICAL pre-Phase-1 gotchas (drift surface)

- **`pendingFastTtsSlots` cleanup:** `finally` block around `runLiveMode` body MUST delete BOTH `pendingFastTtsSlots.get(turnId)` AND `fastPathCorrelationIdByTurn.get(turnId)` per Pivot 12.2 + Pivot 8.4. Without finally, error paths leak per-turn state.
- **`costOpenByCorrelation` scope:** MUST be inside `createSpeculator()` closure (NOT module-level). Cross-session contamination is a real risk if you put it at file scope. See v8 Pivot 11.9.
- **`recordElevenLabsSpeculativeStarted` placement:** MUST be AFTER `_resolveApiKey + clientFactory + abort-already-fired guard`, immediately before `client.synth()`. Moving it back to its current position (line 182-183) re-opens v5/v6's pre-text cost inflation BLOCKER.
- **`_maybeRecordTerminal` cacheKey:** parameter is DIAGNOSTIC ONLY — never use it for the cost decision. The cost decision is `costOpenByCorrelation.has(correlationId)`.
- **iOS fast-tts path MUST bypass `shouldDeferPlayback`:** `playFastPathAudio` is a SEPARATE function from `speakWithTTS`. If you route fast audio through `speakWithTTS`, deferredTTS will stash it and the 6s drop can silently lose audio.
- **iOS fast-tts MUST NOT fall back to native TTS** on 4xx/5xx/timeout. Speaking a value the backend just rejected is unsafe. The existing `AlertManager:1158-1164` catch is UNCHANGED for normal bundler TTS; fast-tts gets its OWN handler.

## Commit / deploy

Per project CLAUDE.md: auto-commit after each logical unit of work (each pivot is a unit). Push to main → CI runs tests → deploys to AWS ECS in eu-west-2. `gh run watch <run-id> --exit-status` for status. iOS via `./deploy-testflight.sh`.
