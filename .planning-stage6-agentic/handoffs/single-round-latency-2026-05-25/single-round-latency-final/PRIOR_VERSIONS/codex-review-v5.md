# Codex CLI review — PLAN v5 (round 5)

**Date:** 2026-05-25
**Reviewer:** Codex CLI
**Verdict:** 1 BLOCKER, 2 IMPORTANTs, 0 NITs — **DO NOT SHIP as written.** v5 closes the round-3 structural blockers and most of Claude's round-4 issues, but the cost-tracker fix still does not preserve cost integrity for pre-text aborts.

## BLOCKERs

### B-v5.1: `cancelledBeforeTextSent` does not actually remove pre-text chars from the billable ledger

**Where:** `PLAN_v5.md:28-52`; `src/extraction/cost-tracker.js:203-205`, `:224-233`, `:254-265`, `:297-298`; `src/extraction/loaded-barrel-speculator.js:182-190`, `:242-257`; `src/__tests__/cost-tracker.test.js:337-343`, `:439-441`; `src/__tests__/loaded-barrel-state-machine-fuzz.test.js:239-249`

v5 correctly reconciles the signature contradiction from Claude B-v4.1: `recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts = {})` keeps the terminal enum at `completed | cancelled | failed`, and `opts.reason` is separate telemetry. That part is sound.

The blocker is the pre-text cost attribution. v5 says:

> When `terminal === 'cancelled' AND opts.cancelledBeforeTextSent === true`: `charsCancelled` is NOT incremented (the speculator never sent text to ElevenLabs, so no chars were billed).

In the current codebase, skipping `charsCancelled` is not enough. `recordElevenLabsSpeculativeStarted()` already increments both:

- `elevenLabsSpeculative.charsStarted`
- the legacy billable aggregate `elevenLabsCharacters`

The speculator calls `recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)` at `loaded-barrel-speculator.js:182-183`, before API-key resolution, before the client is constructed, and before `client.synth(expandedText, ...)` at `:251-257`. Therefore an abort that happens before text is sent can already have inflated the billable counters.

If v5 only skips `charsCancelled`, the resulting ledger is wrong:

- `elevenLabsCost` still charges the chars because it derives from `elevenLabsCharacters`.
- `elevenLabsSpeculativeWastedChars` still counts the chars because it is `charsStarted - charsServed`.
- The existing invariant `charsCompleted + charsCancelled + charsFailed = charsStarted` breaks.
- The new test described in v5 only asserts `charsCancelled` is skipped; it does not assert `elevenLabsCharacters`, `elevenLabsCost`, `charsStarted`, `elevenLabsSpeculativeWastedChars`, or the invariant.

That leaves the cost surface v5 claims to close still open. It also breaks the "$0 vs Loaded-Barrel-on baseline" claim in exactly the abort race this pivot is meant to handle.

**Required fix:** pick one explicit ledger contract:

1. Preferable: move `recordElevenLabsSpeculativeStarted()` to the actual text-sent boundary, immediately before/inside the `client.synth()` call. If abort fires before that boundary, emit `voice_latency.speculative_terminal_reason` only and do not create a speculative Started ledger entry.
2. If Started must remain early, then `opts.cancelledBeforeTextSent === true` must reverse the Started accounting: subtract the correlation's chars from `charsStarted` and `elevenLabsCharacters`, and define how `_charsByCorrelationId`, `_seenCorrelationIds`, `_terminalCorrelationIds`, and the audit invariant behave afterward.

Tests need to assert the full cost shape for the pre-text path: `elevenLabsCharacters` unchanged, `elevenLabsCost` unchanged, `elevenLabsSpeculativeWastedChars` unchanged, and the speculative chars invariant still holds.

## Round-3 BLOCKER closure check

| Round-3 blocker | v5 status | Notes |
|---|---|---|
| B1 telemetry aggregator | **CLOSED** | v4's `turn_core_summary` + delayed `turn_audio_summary` model remains intact. v5's late ACK path emits a separate immutable `voice_latency.late_playback_ack` row keyed by `{sessionId, turnId, slot_key, source}`, which is compatible with CloudWatch Logs Insights conditional aggregation over shared scalar keys. Pivot 8.2 also removes the circular `fast_tts_outcome === 'ack_played'` expected-ACK formula. |
| B2 speculator two-entry-point skip | **CLOSED** | v4's guard remains in `_speculate()`. Code confirms `_speculate()` is the shared path: `onSnapshotPatch` calls it at `loaded-barrel-speculator.js:389`, `:401`, `:413`, `:425`; `onToolUseStreamed` calls it at `:510`. v5 does not regress this. |

## Claude round-4 closure check

| Claude round-4 item | v5 status | Notes |
|---|---|---|
| B-v4.1 cost-tracker signature contradiction | **PARTIALLY CLOSED / STILL BLOCKED** | The enum/signature contradiction is closed. The cost-integrity claim is not closed because `cancelledBeforeTextSent` only skips the terminal bucket while the billable Started aggregate was already incremented. See B-v5.1. |
| I1 deferredTTS interaction | **CLOSED IN DESIGN** | Pivot 10.1 pins the insertion sites: fast-path audio bypasses `shouldDeferPlayback`, bundler queueing happens at the top of `speakBriefConfirmation`, and the deferred-drop transition is specified. This aligns with current AlertManager deferral at `AlertManager.swift:1136-1141` and drop path at `:1178-1213`. |
| I2 abortBySlot type normalization | **CLOSED** | Pivot 11.2 aligns slot matching with the cache's board/circuit normalization and explicitly distinguishes `circuit: 0` from `null`. |
| I3 active-session helper | **CLOSED** | Current `active-sessions.js` exports the raw `activeSessions` Map but no helper. Pivot 12.1 correctly adds `getActiveSessionEntry(sessionId)` and uses it from the fast-TTS endpoint. |
| I4 late ACK behaviour | **CLOSED** | Pivot 8.1 emits a separate late-ACK row and returns 204 for both on-time and late ACKs. This preserves CloudWatch immutability. |

## IMPORTANTs

### I-v5.1: `decrementExpectedAcks(sessionId, turnId)` needs a resolvable current-turn key

**Where:** `PLAN_v5.md:253-259`; `src/routes/voice-latency-fast-tts.js:63-82`; `src/extraction/stage6-shadow-harness.js:197-200`

Pivot 8.2 says the fast-TTS endpoint decrements expected ACKs on 409/422 rejection by calling `decrementExpectedAcks(sessionId, turnId)`, stashing a deferred decrement if the audio finalizer is not armed yet.

The current fast-TTS route body has `sessionId`, `transcript`, and `candidate`; it does not have `turnId`. The server-side `turnId` is minted inside `runLiveMode()` from `session.turnCount`, after the transcript enters the Stage 6 turn. In the fast path, the HTTP POST can reject before that turn ID is available to the endpoint.

This is fixable, but the plan must pin the correlation route. Options:

- include a client-minted turn key in both fast-TTS POST and the WS transcript, then map it to the server turn;
- stash rejected fast-TTS decrements by `regex_fast_correlation_id` and apply them when the transcript creates the server `turnId`;
- explicitly accept the timeout path for rejected fast-TTS attempts and remove the decrement refinement.

As written, the decrement helper is underspecified and may never find the finalizer entry it is meant to adjust.

### I-v5.2: The G0 `speculative_terminal_reason` gate is paired with the wrong event

**Where:** `PLAN_v5.md:292-293`; `PLAN_v4.md:48-50`, `:101-106`

v5 says `voice_latency.speculative_terminal_reason` rows are "gated at ≥1 row per `loaded_barrel_skipped_fast_tts_hint` event."

That pairs a terminal-reason row with the pure `_speculate()` preflight skip event. A preflight skip intentionally returns before cache/ELEVEN work and should not have a speculative Started or Terminal ledger entry. Requiring a terminal-reason row for every skip would either fail the gate or encourage fake terminal events for speculations that never started.

The gate should be tied to actual abort/cancel events, e.g. `loaded_barrel_aborted_by_fast_tts_hint` or `terminal='cancelled' AND reason='cancelled_by_fast_tts_hint'`, not `loaded_barrel_skipped_fast_tts_hint`.

## Things I verified in the codebase

| Claim | Status |
|---|---|
| `recordElevenLabsSpeculativeTerminal` currently accepts only the 3 legacy terminal strings | VERIFIED (`cost-tracker.js:254-258`) |
| `recordElevenLabsSpeculativeStarted` increments `charsStarted` and `elevenLabsCharacters` | VERIFIED (`cost-tracker.js:224-233`) |
| Speculator calls Started before `client.synth()` | VERIFIED (`loaded-barrel-speculator.js:182-183` vs `:251-257`) |
| `_speculate()` is shared by streamed-tool and snapshot-patch paths | VERIFIED (`loaded-barrel-speculator.js:389`, `:401`, `:413`, `:425`, `:510`) |
| `active-sessions.js` exports `activeSessions`, not `getActiveSession` | VERIFIED (`active-sessions.js:14-15`, `:92-96`) |
| `voice-latency-turn-summary.js` does not exist yet | VERIFIED; Pivot 8 creates it |
| AlertManager's existing deferral/drop insertion points match Pivot 10.1 | VERIFIED (`AlertManager.swift:906-921`, `:1136-1141`, `:1178-1213`) |

## Recommended verdict

**DO NOT SHIP v5 as written.**

The convergence direction is otherwise good: the telemetry emission model and `_speculate()` two-entry-point fix remain closed, and v5 resolves most of Claude's round-4 precision gaps. But the remaining cost-tracker issue is not cosmetic. The plan currently says "0 chars billed" while the existing ledger path still increments the billable aggregate before text is sent. That must be reconciled before execution, or the implementation will either overstate ElevenLabs cost or break the cost-tracker invariants.
