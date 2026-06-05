# Codex CLI review — PLAN v3 (round 3)

**Date:** 2026-05-25
**Reviewer:** Codex CLI (gpt-5.5, xhigh reasoning)
**Verdict:** 2 BLOCKERs, 7 IMPORTANTs, 5 NITs — DO NOT SHIP

## BLOCKERs

### B1: Telemetry B10 is still not closed as written
**Where:** PLAN_v3.md:46-66, 98-105, 107-115, 199-207, 342-346; `src/extraction/stage6-shadow-harness.js:372-379`, `src/extraction/stage6-shadow-harness.js:625-643`, `src/extraction/sonnet-stream.js:3909-3920`, `src/routes/keys.js:390-447`, `CertMateUnified/Sources/Recording/AlertManager.swift:1109-1164`

**Issue:** v3 adds the right *facts*, but not a workable emission model. The plan still says `/playback-ack` writes to a session-scoped pending map and `emitTurnSummary` drains that map at server end-of-turn. In the current architecture, `runLiveMode` builds the result, returns it, and only then does `sonnet-stream.js` send the WS extraction to iOS. iOS cannot request bundler confirmation audio, play it, or POST a playback ACK until after that WS message arrives. A `turn_summary` emitted from `runLiveMode` therefore cannot contain `ios_playback_ack(source=bundler)`, `ios_playback_ack(source=local_fallback)`, or reliable `bundler_confirmations_suppressed_by_ios`.

This leaves G0/G1/G2 partly unmeasurable. It also makes `audio_played_but_ack_dropped` unsafe as an inference: server synth completion plus missing ACK cannot distinguish "iOS played but ACK dropped" from "iOS received bytes and failed/deferred playback."

**CloudWatch join check:** a split-row model is implementable in CloudWatch Logs Insights, but v3 does not actually specify one. Logs Insights has no SQL join, so the rows must be queryable by conditional aggregation over shared scalar keys. Emit immutable rows such as `turn_core_summary`, `voice_latency.confirmation_emitted`, `voice_latency.audio_first_byte`, and `voice_latency.playback_ack`, all carrying `sessionId`, `turnId`, `slot_key`, `source`, and `event_type`. Then gates can `filter event_type in [...]` and `stats` by `{sessionId, turnId, slot_key}`. Do not rely on array fields like `bundler_emitted_confirmations[]` for the join.

**Fix:** Either:
- make `turn_summary` a delayed finalizer that emits after audio terminal/ACK or a bounded timeout, or
- use the immutable split rows above and define the CloudWatch aggregation queries as the gate source.

Until one of those is in PLAN_v3, Codex round-2 B1 remains open.

### B2: Pivot 7 misunderstands the Loaded Barrel speculator contract
**Where:** PLAN_v3.md:68-78, 133-137, 348-354; `src/extraction/loaded-barrel-speculator.js:144-219`, `src/extraction/loaded-barrel-speculator.js:335-433`, `src/extraction/loaded-barrel-speculator.js:490-517`, `src/extraction/stage6-shadow-harness.js:290-337`

**Issue:** v3 only says `onToolUseStreamed` consults `pendingFastTtsSlots`. Current Loaded Barrel speculation has two entry points:
- streamed tool hook: `onToolUseStreamed` calls `_speculate()` as soon as a streamed `record_reading` finalizes,
- dispatcher diff hook: `onSnapshotPatch` calls `_speculate()` again after the write mutates `perTurnWrites`.

If the streamed hook skips, no cache entry exists, so the later `onSnapshotPatch` call is not deduped by `cachePeek()` and will still synthesize. That breaks the stated "$0 cost vs LB-on baseline" and the `loaded_barrel_speculator_skipped_by_fast_tts_hint` gate.

There is also no current path for the speculator to read `session.pendingFastTtsSlots`. `createSpeculator()` receives `sessionId`, `apiKey`, `costTracker`, and `logger`; `onToolUseStreamed` receives only `{record, ctx}`. The `pendingControllers` Set is also not a slot-addressable abort surface because it stores controllers without slot metadata.

**Fix:** Put the fast-TTS hint check in a shared `_speculate()` preflight or a helper used by both entry points. Pass a `pendingFastTtsSlotsRef(turnId)` or equivalent into `createSpeculator`. Add a slot-addressable abort API, e.g. `abortBySlot({turnId, boardId, field, circuit})`, backed by a slot/correlation/controller map or by `loaded-barrel-cache.invalidateBySlot()`. Test both streamed and snapshot-patch paths.

## Round-2 blocker closure check

| Round-2 blocker | v3 status | Notes |
|---|---|---|
| B1 telemetry aggregator | **NOT CLOSED** | v3 has the fields and ACK endpoint, but the concrete spec is still a single end-of-turn drain. See B1. |
| B2 rejected fast-TTS must not fall back to native | **CLOSED IN DESIGN** | Pivot 5 explicitly says 409/422/503, network, timeout, and 5xx abandon silently, do not play, and do not mark the slot. It also says the AlertManager local fallback continues only for other POST paths. See I1 for a wording cleanup so execution stays separate. |

## IMPORTANTs

### I1: Keep fast-TTS failure handling out of the generic AlertManager fallback
**Where:** PLAN_v3.md:39-44, 161-169, 356-360; `CertMateUnified/Sources/Recording/AlertManager.swift:1057-1164`, `CertMateUnified/Sources/Services/APIClient.swift:854-895`

The design closes the unsafe fallback bug, but §I still points at `AlertManager.swift:1158-1164`, which is the generic `proxyElevenLabsTTS` catch that should keep falling back for normal bundler confirmations. The executor should add a separate `APIClient.proxyRegexFastTTS` plus dedicated fast-path playback handler that inspects HTTP status and never calls `speakWithTTS`/`speakWithAppleNative` on rejection or transport failure. The existing generic catch should remain for non-fast-TTS paths.

### I2: iOS suppression key includes a correlation id that bundler confirmations do not carry
**Where:** PLAN_v3.md:23-33, 72-74, 133-137; `CertMateUnified/Sources/Services/ClaudeService.swift:291-317`, `src/extraction/stage6-event-bundler.js:50-80`

v3 defines `playedFastPathSlots` as `${correlationId}::${field}::${circuit}::${boardId}`, but bundler confirmations currently carry `text`, `field`, `circuit`, and optional `board_id`; v3 adds `expanded_text`, not `regex_fast_correlation_id`. `result.turn_id` exists, but the bundler confirmation itself cannot be looked up by fast-path correlation id unless iOS also maintains a `{turnId, slot} -> correlationId` map.

Simpler: make the dedupe key per-turn slot-only, cleared by turn, e.g. `${field}::${circuit}::${boardId}`. If correlation id must stay in the key for telemetry, specify the turn/correlation mapping explicitly.

### I3: Bundler-first / fast-path-late ordering can still double-speak
**Where:** PLAN_v3.md:173-197; `CertMateUnified/Sources/Recording/AlertManager.swift:1136-1149`

The `playedFastPathSlots` set suppresses bundler only after fast-path playback has started. If fast-TTS is still pending, deferred, or decoding when the bundler confirmation arrives, iOS will play the bundler confirmation. The fast task can then complete and play the same slot later. That violates the "single audible" race guarantee.

Use a per-slot audio state machine: `fastPending`, `fastPlayed`, `bundlerPlayed`, `resolved`. If bundler playback starts while fast is pending, cancel or discard the late fast audio for that slot. If fast plays first, suppress bundler as v3 already specifies.

### I4: `expanded_text` needs explicit Swift signature plumbing
**Where:** PLAN_v3.md:139-145, 167; `CertMateUnified/Sources/Services/ClaudeService.swift:291-317`, `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:3299-3342`, `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:7364-7449`, `CertMateUnified/Sources/Recording/AlertManager.swift:906-922`, `CertMateUnified/Sources/Recording/AlertManager.swift:1057-1116`

v3 correctly requires `ValueConfirmation.expandedText`, but current `speakBriefConfirmation(_ text:, loadedBarrelContext:)` has no way to receive it, and `speakWithTTS()` always computes `let expanded = Self.expandForTTS(text)`. Execution needs an explicit API change such as `speakBriefConfirmation(_ text: String, expandedText: String? = nil, loadedBarrelContext: ...)`, and both inline and deferred confirmation paths must pass `conf.expandedText`. Otherwise the cache-key parity fix can be lost on the Swift side.

### I5: `pendingFastTtsSlots` lifecycle needs exact turn ownership and cleanup semantics
**Where:** PLAN_v3.md:72-78, 133-137, 353-354; `src/extraction/sonnet-stream.js:3761-3777`, `src/extraction/stage6-shadow-harness.js:197-203`

The plan says populate before `runToolLoop` and clear on `endTurn`, but current transcript handling can queue and replay messages. The slot must attach to the actual `turnId` minted by `runLiveMode`, including drained retries, and cleanup must run in a `finally` path on success, error, WS close, and session stop. Also cap the inner Set, not just the outer Map.

### I6: Fast-TTS board validation still names the wrong state path
**Where:** PLAN_v3.md:187-188; `src/extraction/eicr-extraction-session.js:1027`; `src/extraction/stage6-multi-board-shape.js:50-55`

Race E says validate `req.body.boardId === session.currentBoardId`. Current board focus lives at `session.stateSnapshot.currentBoardId`, not directly on the session, and `getVoiceLatencyForSession(sessionId)` returns the voice-latency snapshot rather than the full session object. The endpoint must fetch the active session entry and compare against `entry.session.stateSnapshot.currentBoardId`, with `getMainBoardId()` fallback for legacy state.

### I7: `/playback-ack` needs trust-boundary and bounds specs
**Where:** PLAN_v3.md:64, 101-103, 169

The new endpoint should be protected like the other voice-latency routes: `auth.requireAuth`, active-session ownership checks, finite `at_ms`, enum validation for `source`, bounded `field/circuit/boardId`, and per-session/turn caps so a bad client cannot grow telemetry maps indefinitely or poison another user's session metrics.

## NITs

### N1: Several line refs are stale
`stage6-tool-loop.js:316-456` no longer covers the dispatch insertion point; the relevant push is around `stage6-tool-loop.js:743`. `stage6-shadow-harness.js:625-641` is the current live extraction log, not an existing summary hook. Updating these refs will reduce executor drift.

### N2: `pendingFastTtsSlots` is described as both Set and Map
PLAN_v3.md:72 says `pendingFastTtsSlots: Set<slot>`, while PLAN_v3.md:137 says `Map<turnId, Set<slot>>`. Use the Map form everywhere.

### N3: Add a speculator skip count, not just a boolean
PLAN_v3.md:377 raises this already. Keep `loaded_barrel_speculator_skipped_by_fast_tts_hint`, but add `loaded_barrel_speculator_skipped_by_fast_tts_hint_count` so dashboards can distinguish one-slot from multi-slot turns.

### N4: Route comments and capability parser tests need updating
`src/routes/voice-latency-fast-tts.js` still documents `streaming_http_audio` as a gate. `voice-latency-config.js` currently only exposes `hasRegexFastTts`; adding `regex_fast_v2` also needs parser return-shape and test updates.

### N5: Resolve or explicitly defer `polarity_confirmed`
PLAN_v3.md:373 leaves this as an open question. Either add the small iOS coercion and include it in the whitelist, or state it remains out of Phase 1 so eligibility dashboards do not treat it as an accidental omission.

## Recommended verdict

DO NOT SHIP v3 as written.

v3 closes the unsafe native-fallback design and the early-terminate protocol wording. The remaining ship blockers are narrower but real: telemetry still cannot measure the gates if it is emitted as a single server end-of-turn row, and Pivot 7 does not actually suppress Loaded Barrel speculation under the current two-entry-point contract. Both are fixable with spec edits before implementation.

## Open questions for the executing session

1. Should Phase 0 use immutable split rows or a delayed final summary? I recommend split rows because it matches CloudWatch's strengths and avoids mutating a row after iOS playback.
2. Does iOS POST fast-path playback ACK immediately on `AVAudioPlayer.play()` success, or only at iOS turn-end? The plan currently says both.
3. Should fast-path audio be over-rejected for all multi-board sessions until endpoint board validation is fully threaded through the active session object?
4. What is the exact iOS per-slot audio state machine for `fastPending -> bundlerPlayed` and late fast audio cancellation?
