# Codex CLI review — PLAN v2 (round 2)

**Date:** 2026-05-25
**Reviewer:** Codex CLI (gpt-5.5, xhigh reasoning)
**Verdict:** 2 BLOCKERs, 6 IMPORTANTs, 5 NITs — DO NOT SHIP

## BLOCKERs (must be addressed before v3)

### B1: `turn_summary` is emitted before the audio facts it claims to contain exist
**Where:** PLAN_v2.md:109-141, 249-257, 338-347; `src/extraction/stage6-shadow-harness.js:372-379`, `src/extraction/stage6-shadow-harness.js:625-643`, `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:7438-7446`, `CertMateUnified/Sources/Recording/AlertManager.swift:1109-1116`, `src/routes/keys.js:390-397`, `src/routes/keys.js:434-443`, `src/routes/keys.js:510-519`, `src/routes/keys.js:560-598`, `src/routes/voice-latency-fast-tts.js:112-122`
**Issue:** Phase 0 says `runLiveMode` emits one `turn_summary` row "at end-of-turn" with `audible_first_byte_ms`, `audible_first_byte_source`, `fast_path_outcome`, and later `ios_playback_first_frame_ms`. In the current architecture, the normal confirmation audio is not requested until after the WS extraction has reached iOS: `runLiveMode` bundles and returns the extraction, iOS then calls `AlertManager.speakBriefConfirmation`, and only then does `/api/proxy/elevenlabs-tts` write the first audio bytes. A row emitted from `runLiveMode` cannot already know the first-byte result from `keys.js`. The fast-TTS route is a separate HTTP path as well, and v2 does not specify a turn/correlation aggregator that joins it back to the Sonnet turn before summary emission.

That makes G1/G2/G3's headline latency gates unmeasurable as written. This is still Codex v1 B10 at blocker severity, despite the improved row shape.
**Fix:** Add an explicit telemetry aggregator keyed by `{sessionId, turnId}` plus fast-path `correlationId`. Start the turn record in `handleTranscript`/`runLiveMode`, update it from `keys.js` and `voice-latency-fast-tts.js` when the first audio byte is written, update it again from iOS playback ACK when available, and emit the final summary after either audio terminal/ACK or a bounded timeout. Alternatively split it into `turn_core_summary` and `turn_audio_summary`, then make the gates join those rows by key.

### B2: Rejected fast-TTS candidates must not fall back to local/native speech
**Where:** PLAN_v2.md:184-185, 216-223, 243; `CertMateUnified/Sources/Recording/AlertManager.swift:1158-1164`
**Issue:** v2 says `wrong_board`, `unknown_circuit`, kill-switch, and 4xx/5xx cases fall back via the "existing AlertManager retry path". The existing AlertManager behavior on proxy failure is to speak the same text with Apple native TTS. That is unsafe for fast-TTS eligibility failures: if the backend rejects a stale board or unknown circuit, iOS must not confirm that candidate through another audio path.

Mode A removes certificate-write risk, but this would still ship a correctness bug in the spoken UX: the inspector can hear a confident confirmation for a value the backend explicitly rejected as unsafe.
**Fix:** Define fast-TTS failure handling separately from generic TTS fallback. For `wrong_board`, `unknown_circuit`, `not_eligible`, kill switch, stale session, timeout, and 5xx, iOS should abandon the fast path, not mark the slot as played, and wait for the normal Sonnet/bundler confirmation. Only a successful fast-TTS response may be played.

## IMPORTANTs

### I1: Fast-path suppression has an unresolved turnId vs correlationId mismatch
**Where:** PLAN_v2.md:177, 191-193, 205-220; `src/extraction/stage6-shadow-harness.js:197-203`, `src/routes/voice-latency-fast-tts.js:92`
**Issue:** The backend state is specified as `fastPathConfirmationsByTurn: Map<turnId, Set<slot>>`, but the fast-TTS endpoint does not know the `turnId`; `runLiveMode` mints it later from `session.turnCount + 1`. The race catalogue then switches to a correlation-id keyed set. Current code also server-mints the fast-path correlation id, which iOS cannot attach to the parallel WS transcript without waiting for the HTTP response.
**Fix:** Make the correlation id client-minted for this path, send it in both the fast-TTS POST and the WS transcript, parse it in `sonnet-stream.js`, and have `runLiveMode` map `{correlationId -> turnId}` before bundling. Keep the suppression ledger keyed consistently.

### I2: Suppression is based on server synth completion, not iOS playback
**Where:** PLAN_v2.md:191, 213-220, 255-256; `CertMateUnified/Sources/Recording/AlertManager.swift:1127-1156`
**Issue:** v2 populates the suppression set when the endpoint completes TTS streaming. iOS can still fail to create/play the `AVAudioPlayer`, defer past usefulness, or lose the audio session after that point. If the backend suppresses the Sonnet confirmation based only on server completion, the inspector may hear nothing.
**Fix:** Prefer an iOS ACK such as `fast_tts_playback_started` for the same `{correlationId, field, circuit, boardId}`. If no ACK has arrived by bundler time, emit the normal Sonnet confirmation; duplicate audio is less damaging than silent loss.

### I3: `expanded_text` is not wired through the iOS model or playback path
**Where:** PLAN_v2.md:54; `src/extraction/stage6-event-bundler.js:50-80`, `CertMateUnified/Sources/Services/ClaudeService.swift:291-317`, `CertMateUnified/Sources/Recording/AlertManager.swift:1057-1059`
**Issue:** v2 correctly makes friendly-name text canonical, but the new `confirmations[].expanded_text` field is only described in prose. Today the bundler emits no such field, `ValueConfirmation` does not decode it, and AlertManager always re-runs Swift `expandForTTS` on `text`.
**Fix:** Add explicit backend and iOS steps: import server `expandForTTS` in the bundler, emit `expanded_text`, decode it in `ValueConfirmation`, and pass it to the TTS proxy without double-expanding.

### I4: Early-terminate wiring needs to be independent of Loaded Barrel
**Where:** PLAN_v2.md:284-330; `src/extraction/stage6-tool-loop.js:338-360`, `src/extraction/stage6-shadow-harness.js:327-329`
**Issue:** `shouldEarlyTerminate` needs `session` and `perTurnWrites`. Current `runToolLoop` does not receive `session`, and `runLiveMode` only passes `perTurnWritesRef` when the Loaded Barrel speculator exists. Early termination must work with Loaded Barrel off.
**Fix:** Add explicit loop options such as `earlyTerminateEnabled`, `earlyTerminateSession`, and `perTurnWritesRef: () => perTurnWrites` from the live call site regardless of speculator state. Pin this in tests with Loaded Barrel disabled.

### I5: The synthetic `end_turn` should not erase the actual round-1 protocol fact
**Where:** PLAN_v2.md:284-290, 338-345; `src/extraction/stage6-tool-loop.js:408-443`, `src/extraction/stage6-tool-loop.js:743-776`
**Issue:** The executed Anthropic round still stops with `tool_use`; the server then terminates locally. Returning only `stop_reason: 'end_turn'` hides the real API protocol fact from telemetry and future debugging.
**Fix:** Return both values, e.g. `actual_stop_reason: 'tool_use'`, `terminal_reason: 'early_terminated'`, and `stop_reason: 'end_turn'` only if needed for back-compat. G2 should assert the actual round stop reason remains `tool_use`.

### I6: Fast-path cost is not break-even when Loaded Barrel is enabled
**Where:** PLAN_v2.md:261-263, 271-272; `src/extraction/loaded-barrel-speculator.js:490-517`, `src/extraction/loaded-barrel-speculator.js:385-433`
**Issue:** v2 says the net cost is break-even, but also says the speculator still fires and the cache entry goes unclaimed. Code confirms the speculator fires from streamed `record_reading` and snapshot patches before the bundler suppression decision. A fast-path turn can therefore pay for fast-TTS plus a wasted Loaded Barrel speculative synth.
**Fix:** Either suppress Loaded Barrel speculation for transcripts carrying `regex_fast_correlation_id`, or account for the wasted speculative synth in the Phase 1 cost model and telemetry.

## NITs

### N1: Several line refs are stale
**Where:** PLAN_v2.md:396-409; `src/extraction/stage6-tool-loop.js:552-743`, `src/extraction/stage6-shadow-harness.js:197`
**Issue:** Phase 0/2 references `stage6-tool-loop.js:316-456` for dispatch/early-terminate insertion, but the actual dispatch branch is around `:552-743`. It also points to `sonnet-stream.js:runLiveMode`; `runLiveMode` lives in `stage6-shadow-harness.js`.
**Fix:** Update the handoff refs before giving this to the executor.

### N2: The iOS TranscriptFieldMatcher path is wrong
**Where:** PLAN_v2.md:197, 404; `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift`
**Issue:** The plan says `Sources/Processing/TranscriptFieldMatcher.swift`; the current file is under `Sources/Recording`.
**Fix:** Correct the path.

### N3: `session.currentBoardId` should be `session.stateSnapshot.currentBoardId`
**Where:** PLAN_v2.md:24, 184, 226; `src/extraction/eicr-extraction-session.js:1027-1028`
**Issue:** The current board pointer is stored on `stateSnapshot`, not directly on the session.
**Fix:** Update the wording and pseudocode consistently.

### N4: `rcd_time_ms` is whitelisted but has no listed iOS regex pattern
**Where:** PLAN_v2.md:183, 197-203
**Issue:** The whitelist includes `rcd_time_ms`, but the five v2 regex patterns do not include RCD time.
**Fix:** Add the pattern or remove `rcd_time_ms` from v2 eligibility.

### N5: Loaded Barrel source names should match the code
**Where:** PLAN_v2.md:132; `src/routes/keys.js:436-440`
**Issue:** The row shape uses `loaded_barrel_pending_race`, while the route emits `loaded_barrel_hit_pending` and `loaded_barrel_hit_late`.
**Fix:** Use the existing source names or explicitly rename them in code and tests.

## Recommended verdict

DO NOT SHIP v2 as written.

The three structural pivots are directionally correct and close the major v1 architecture mistakes: Phase 2 is now a server-side post-dispatch short-circuit, Phase 1 no longer bypasses Sonnet writes, and cache text is friendly-name canonical. The remaining blockers are narrower but still execution-critical: telemetry cannot measure the promised gates yet, and rejected fast-TTS candidates must never be spoken through fallback.

## Open questions for the executing session

1. Should fast-path suppression require `playback_started` or `playback_completed` from iOS?
2. Is Phase 2 allowed to early-terminate when a multi-board job is currently on the main board, or should any `boards.length > 1` job force round 2?
3. Should Loaded Barrel speculation be disabled for turns carrying `regex_fast_correlation_id`?
4. Will `messages_final` ever be reused as Anthropic history after early termination, or is it diagnostic-only in live mode?
