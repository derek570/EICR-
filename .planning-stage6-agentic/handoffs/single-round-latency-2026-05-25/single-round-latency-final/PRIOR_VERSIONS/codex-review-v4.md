# Codex CLI review - PLAN v4 (round 4)

**Date:** 2026-05-25
**Reviewer:** Codex CLI
**Verdict:** 0 BLOCKERs - SHIP PLAN v4

## BLOCKERs

None. The three round-3 blockers are closed, and I found no genuinely new v4 blocker.

## Round-3 BLOCKER closure check

| Round-3 BLOCKER | Status | v4 evidence |
|---|---|---|
| B1: `turn_summary` emitted too early for bundler/local-fallback playback ACKs | CLOSED | v4 splits the row and delays the audio facts: "`turn_core_summary` - emitted at `runLiveMode` end-of-turn" and "`turn_audio_summary` - emitted by a **delayed finalizer** ... after either: All expected ACKs arrive ... [or] Bounded 8s timeout fires." It also states: "Both rows share `{sessionId, turnId, correlation_id}` keys so CloudWatch Insights can join." The overclaim is removed: "The `audio_played_but_ack_dropped` enum value in v3 was overclaimed ... v4 drops it." |
| B2: Pivot 7 skip only covered one Loaded Barrel speculation entry point | CLOSED | v4 moves the guard to the shared path: "the skip check moves into `_speculate()` itself, where BOTH entry paths converge" and "`_speculate(...)` calls `pendingFastTtsSlotsRef...has(slotKey(...))`. If true -> emit `loaded_barrel_skipped_fast_tts_hint` event + return early." It also adds the missing live state plumbing: "`createSpeculator(opts)` gains new param: `opts.pendingFastTtsSlotsRef: () => Map<turnId, Set<slotKey>>`." |
| B3: iOS suppression missed bundler-arrives-while-fast-pending duplicate audio | CLOSED | v4 replaces the Set with a per-slot state machine and queue: "iOS-side per-slot state machine, replacing the Set" and "Bundler confirmation arrives for slot in `fastPending` -> DO NOT play yet. Queue it on `pendingBundlerConfirmations`." The terminal behavior is explicit: "to `fastPlayed`: drop the queued bundler confirmation" and "to `idle` (fast-tts failed): drain the queued bundler confirmation -> play it." |

## Round-3 IMPORTANT closure check

| Round-3 IMPORTANT | Status | v4 evidence |
|---|---|---|
| I1: `/playback-ack` needs auth, ownership checks, validation, bounded write path | CLOSED | §B adds "`auth.requireAuth` middleware", "Session ownership check: `req.user.id === session.userId`", a bounded body schema for `sessionId`, `turnId`, `slot`, `source`, and `at_ms`, plus "Rate limit: 20 ACKs/turn per sessionId." |
| I2: Pre-text abort cost attribution | CLOSED | §B says: "v4 adds a `cancelledBeforeTextSent: bool` flag on the abort-terminal cost-tracker call" and "Cost-tracker's `recordElevenLabsSpeculativeTerminal` accepts the flag and adjusts the speculative-spend ledger accordingly." |
| I3: `pendingFastTtsSlots` lifecycle / cleanup semantics | CLOSED via Pivot 12 | Although not in §B, v4 pins this in Pivot 12: "`WS close`: all entries for the disconnecting session cleared", "`Inner Set cap`: 32 slots per turnId", and "`finally` placement: the `endTurn` cleanup wraps the entire `runLiveMode` body ... so error paths AND queue-drain paths AND happy paths all clean up." |
| I4: Fast-TTS board validation referenced wrong current-board path | CLOSED | §B says board validation reads "`entry.session.stateSnapshot.currentBoardId` (or `getMainBoardId(entry.session.stateSnapshot)` fallback) instead of relying on `getVoiceLatencyForSession` to surface the board id." |
| I5: `bundler_confirmations_suppressed_by_ios` was unsafe inference | CLOSED | §B changes the field: "The field becomes `bundler_confirmations_observed_played` (NOT `_suppressed_by_ios`). Computed from received ACK list, not from absence." It also marks non-ACKed bundler playback as "`playback_unknown`." |
| I6: `regex_fast_v2` capability parser/log/test plumbing | CLOSED | §B explicitly adds "`regex_fast_v2` to `KNOWN_SUPPORTS`; extend `parseVoiceLatencyCapabilities` return shape with `hasRegexFastV2`; extend startup log" and updates "`voice-latency-config.test.js` expected-arrays." |

## New v4 BLOCKERs

None.

## Code verification

No code implementation was reviewed in this round. This was a plan-only review against `PLAN_v4.md` and the prior `codex-review-v3.md`.

## Recommended verdict

SHIP PLAN v4. It closes the three remaining structural blockers from round 3 without introducing a new ship-stopper.
