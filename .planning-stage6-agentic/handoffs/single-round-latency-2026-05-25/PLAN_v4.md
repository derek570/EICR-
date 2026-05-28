# Single-Round Latency Sprint — Plan v4

**Date:** 2026-05-25
**Status:** DRAFT — pending round 4 review.
**Supersedes:** PLAN_v3.md. This is a SURGICAL revision — v3 is correct as a whole. v4 closes Codex's 3 remaining BLOCKERs (B1 turn_summary emission too early; B2 Pivot 7 only covers one speculation entry point; B3 iOS-side suppression misses bundler-arrives-while-fast-pending race) + Claude's 2 round-3 IMPORTANTs (pendingFastTtsSlots cleanup; speculator abortBySlot API surface).

**Read PLAN_v3.md alongside this file.** v4 only describes the deltas from v3.

---

## §A — v4 PIVOTS (delta from v3)

### Pivot 8 — `turn_summary` splits into TWO immutable rows + delayed finalizer (closes Codex B1)

v3 had a single `turn_summary` row drained at `runLiveMode` end-of-turn. iOS playback ACKs for bundler / local_fallback audio cannot land before the WS extraction has even reached iOS, let alone before iOS has tried to play it. Codex correctly flags: CloudWatch log rows are immutable; you can't update them post-emission.

**v4 design — two-row emission:**

1. `turn_core_summary` — emitted at `runLiveMode` end-of-turn as today's plan describes. Carries protocol facts, dispatch facts, predicate result, server-side audible_first_byte timestamp. **Immutable. Emitted exactly once per turn.**

2. `turn_audio_summary` — emitted by a **delayed finalizer** in `voice-latency-turn-summary.js` after either:
   - All expected ACKs arrive (count derived from `bundler_emitted_confirmations.length + (fast_tts_outcome === 'ack_played' ? 1 : 0)`).
   - Bounded 8s timeout fires (existing Loaded Barrel TTL is 15s; 8s is conservative enough that iOS playback should complete in normal conditions).

Both rows share `{sessionId, turnId, correlation_id}` keys so CloudWatch Insights can join.

`turn_audio_summary` carries: `ios_playback_ack[]` (array, one per ACK), `bundler_confirmations_observed_played` (subset of bundler emissions that ACKed), `audio_finalizer_timeout_fired: bool`.

The "audio_played_but_ack_dropped" enum value in v3 was overclaimed (Codex B1 third paragraph). v4 drops it. The new audio row carries:
- `ack_observed: true` → audio definitely played.
- `ack_observed: false AND finalizer_timeout_fired: true` → could be "iOS bytes received and playback failed" OR "ACK POST failed in transit". Not distinguishable; reported as `unknown_playback_outcome`.

Schema in `src/extraction/voice-latency-turn-summary.js`:
- New `pendingAudioFinalizers: Map<turnId, {timer, expected_acks, received_acks, observed_bundler_emitted}>`.
- `emitTurnSummary` becomes `emitTurnCoreSummary` + `startAudioFinalizer`.
- `startAudioFinalizer(turnId, expected_acks)` arms a `setTimeout(8000)` that emits `turn_audio_summary` with whatever ACKs accumulated.
- `recordPlaybackAck(turnId, ack)` checks if all expected ACKs received → if yes, clears the timer + emits immediately.

**Gate G0 verifies both rows present.** G1/G2 latency gates use `turn_audio_summary.ios_playback_ack[].at_ms` when available, falling back to `turn_core_summary.audible_first_byte_ms` (server-side) only when finalizer timed out.

### Pivot 9 — Pre-synth skip moves INTO `_speculate()` (closes Codex B2)

v3 said the speculator's `onToolUseStreamed` hook reads `session.pendingFastTtsSlots` and skips. Codex correctly points out: the speculator ALSO fires from `onSnapshotPatch` (after dispatcher mutation). If only `onToolUseStreamed` skips, `onSnapshotPatch` still fires `_speculate()` and opens a wasted synth.

**v4 design:** the skip check moves into `_speculate()` itself, where BOTH entry paths converge. The function reads the slot tuple from its arguments and, if present in `session.pendingFastTtsSlots`, returns early before any cache or ElevenLabs work.

Concretely:
- `createSpeculator(opts)` gains new param: `opts.pendingFastTtsSlotsRef: () => Map<turnId, Set<slotKey>>`. Closure over a function so the speculator can read the LIVE map without holding a stale reference.
- `_speculate({field, circuit, boardId, value, confidence, turnId})` calls `pendingFastTtsSlotsRef?.()?.get(turnId)?.has(slotKey({field, circuit, boardId}))`. If true → emit `loaded_barrel_skipped_fast_tts_hint` event + return early.
- BOTH `onToolUseStreamed` and `onSnapshotPatch` already call `_speculate()` as the speculation entry point (verified per Codex B2's code refs). One check, two coverages.

`stage6-shadow-harness.js:294-300` wire-up: pass `pendingFastTtsSlotsRef: () => session.pendingFastTtsSlots` when creating the speculator.

Test: `loaded-barrel-speculator-fast-tts-skip.test.js` asserts skip fires from BOTH entry paths against the same slot.

### Pivot 10 — iOS suppression upgrades to a 4-state machine per slot (closes Codex B3)

v3's `playedFastPathSlots` Set only suppresses bundler confirmations AFTER fast-path playback has started. Codex correctly identifies the race: bundler confirmation can arrive at iOS WHILE fast-path POST is still in flight (or audio decoding) → Set empty → iOS plays bundler → fast-path completes later → user hears two audibles.

**v4 design:** iOS-side per-slot state machine, replacing the Set:

```swift
enum FastPathSlotState {
  case idle               // no fast-tts POST in flight
  case fastPending        // POST sent, response not yet received
  case fastPlayed         // AVAudioPlayer.play() returned true
  case bundlerPlayed      // bundler confirmation already played for this slot
  case resolved           // both paths considered closed (one played, other suppressed)
}
```

Storage: `var fastPathSlotStates: [SlotKey: FastPathSlotState] = [:]` on `AlertManager`. Keyed by `(field, circuit, boardId)`.

Transitions:
- iOS regex matcher fires → set `idle → fastPending` + dispatch fast-tts POST.
- fast-tts POST 200 → `AVAudioPlayer.play()`. On success: `fastPending → fastPlayed` (state machine).
- fast-tts POST 409/422/503/error/timeout → `fastPending → idle`. State cleared; bundler confirmation, when it arrives, plays as normal.
- Bundler confirmation arrives for slot in `idle` → play it; set `idle → bundlerPlayed`.
- Bundler confirmation arrives for slot in `fastPending` → DO NOT play yet. Queue it on `pendingBundlerConfirmations: [SlotKey: ValueConfirmation]`. When fast-tts state transitions:
  - to `fastPlayed`: drop the queued bundler confirmation. Set → `resolved`.
  - to `idle` (fast-tts failed): drain the queued bundler confirmation → play it → `bundlerPlayed`.
- Bundler confirmation arrives for slot in `fastPlayed` → DO NOT play. Suppress (existing v3 behaviour).
- Bundler confirmation arrives for slot in `bundlerPlayed` or `resolved` → DO NOT play. Defensive suppression.

Clear `fastPathSlotStates` + `pendingBundlerConfirmations` when `turnId` changes (mirrors v3 set lifetime).

Race coverage:
- Fast-tts succeeds first, bundler arrives later → bundler suppressed (v3 already covered).
- Bundler arrives first while fast pending → queued, drained on fast-tts terminal (NEW v4 — Codex B3 fix).
- Fast-tts fails before bundler arrives → state clears, bundler plays normally (v3 already covered, v4 makes explicit via state transitions).
- Fast-tts succeeds AFTER bundler queue drained → state machine prevents replay (`bundlerPlayed` → fast-tts arrives → drop fast audio, set state `resolved`).

Files: `Sources/Recording/AlertManager.swift` — new state machine + queue. ~80 LOC additional vs v3's simpler Set.

### Pivot 11 — Speculator `abortBySlot` API (closes Claude NI2)

v3 said "controller.abort()" but the `pendingControllers` Set is opaque. v4 adds explicit API:

`loaded-barrel-speculator.js` gains:
- New internal `Map<correlationId, {slot, controller, cacheKey}>` — `pendingByCorrelation`.
- New exported method `speculator.abortBySlot({sessionId, turnId, boardId, field, circuit})`:
  - Walks `pendingByCorrelation` for entries whose `slot.field === field AND slot.circuit === circuit AND (slot.boardId === boardId OR (slot.boardId == null AND boardId == null))`.
  - For each match: `controller.abort()` + `cache.invalidateBySlot(sessionId, slot)` + `recordOutcome('loaded_barrel_aborted_by_fast_tts_hint')`.
  - Returns count of aborted speculations.

Called from `eicr-extraction-session.js` at the same point `pendingFastTtsSlots.add()` fires, after the WS handler routes the transcript's `regex_fast_correlation_id` payload.

Cost tracker: `recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled_by_fast_tts_hint')` is called as part of the abort path so cost accounting tracks the cancellation.

Test: `loaded-barrel-speculator-abort-by-slot.test.js` covers (a) abort fires on matching slot, (b) abort no-ops on non-matching slot, (c) controller actually aborts in-flight synth, (d) cost-tracker records cancellation.

### Pivot 12 — `pendingFastTtsSlots` cleanup contract pinned (closes Claude NI1)

v3 said cleared on `endTurn` + LRU-capped at 100 entries. v4 pins:
- **endTurn definition:** the point in `runLiveMode` AFTER `emitTurnCoreSummary` runs AND AFTER `startAudioFinalizer` arms (so the audio finalizer can still consult the slot if needed).
- **WS close:** all entries for the disconnecting session cleared via existing session-cleanup hook in `sonnet-stream.js`.
- **Inner Set cap:** 32 slots per turnId. Overflow logged as `pending_fast_tts_overflow` with the dropped slot. Realistic turns have ≤4 slots; 32 is generous safety.
- **`finally` placement:** the `endTurn` cleanup wraps the entire `runLiveMode` body in `try { ... } finally { sessionState.pendingFastTtsSlots.delete(turnId) }` so error paths AND queue-drain paths AND happy paths all clean up.

Files: `eicr-extraction-session.js` (Map declaration + cleanup), `stage6-shadow-harness.js` (finally block around runLiveMode body), `sonnet-stream.js` (WS-close hook).

---

## §B — Other v3 review IMPORTANTs addressed

### `/playback-ack` endpoint security + validation (Codex round-3 I1, Claude round-3 NN2)

`src/routes/voice-latency-playback-ack.js` (NEW):
- `auth.requireAuth` middleware (matching all other voice-latency routes).
- Session ownership check: `req.user.id === session.userId`.
- Body schema (Joi or manual):
  - `sessionId: string` (must match an active session).
  - `turnId: string` (must match a turnId currently in the `pendingAudioFinalizers` map for that session).
  - `slot: { field: string (must be in CONFIRMATION_FRIENDLY_NAMES keys OR set_field_for_all_circuits eligibility), circuit: integer (>=0 and <=99), boardId: string|null }`.
  - `source: enum('fast_tts', 'bundler', 'local_fallback')`.
  - `at_ms: number (finite, > 0, < Date.now() + 1000)`.
- Rate limit: 20 ACKs/turn per sessionId (existing voice-latency-rate-limit.js pattern). Excess returns 429 silently.
- Returns 204 No Content on success.

### Speculator abort: text-not-yet-sent attribution (Codex round-3 I2)

When `abortBySlot` aborts BEFORE `client.synth()` has pushed text, the existing `recordElevenLabsSpeculativeStarted` may have already counted chars. v4 adds a `cancelledBeforeTextSent: bool` flag on the abort-terminal cost-tracker call. Cost-tracker's `recordElevenLabsSpeculativeTerminal` accepts the flag and adjusts the speculative-spend ledger accordingly. Test: `cost-tracker-pre-text-abort.test.js`.

### Fast-TTS endpoint uses active-session board state (Codex round-3 I4)

v4 amends §I Phase 1 file list:
- `src/routes/voice-latency-fast-tts.js` board validation reads `entry.session.stateSnapshot.currentBoardId` (or `getMainBoardId(entry.session.stateSnapshot)` fallback) instead of relying on `getVoiceLatencyForSession` to surface the board id. Helper `getActiveSession(sessionId)` already exists in `active-sessions.js`.

### `bundler_confirmations_suppressed_by_ios` is explicit, not inferred (Codex round-3 I5)

v4 amends Pivot 6:
- The field becomes `bundler_confirmations_observed_played` (NOT `_suppressed_by_ios`). Computed from received ACK list, not from absence.
- Suppression is implicit: a bundler confirmation that fired but did NOT generate a `source=bundler` ACK is shown in `turn_audio_summary` as `playback_unknown`. Dashboards reading "was it suppressed?" do so by checking `fast_tts_outcome === 'ack_played' AND slot in bundler_emitted_confirmations AND slot NOT in bundler_confirmations_observed_played`.

### `regex_fast_v2` capability — full plumbing (Codex round-3 I6)

v4 §I Phase 1 file list explicitly adds:
- `src/extraction/voice-latency-config.js:139-177` — add `regex_fast_v2` to `KNOWN_SUPPORTS`; extend `parseVoiceLatencyCapabilities` return shape with `hasRegexFastV2`; extend startup log.
- `src/__tests__/voice-latency-config.test.js` — expected-arrays updated to include the new bit.

### Race A iOS-queue-while-pending (Claude round-3 NN3)

Pivot 10's state machine + `pendingBundlerConfirmations` queue handles this directly. Already covered in Pivot 10.

---

## §C — Updated verification gates (deltas from v3)

| Gate | v4 delta |
|---|---|
| **G0** | Add: `turn_audio_summary` rows present for ≥99% of turns within 24h (new row). `audio_finalizer_timeout_fired` rate <10% (high rate would mean ACK delivery is broken). |
| **G1.b** | Latency uses `ios_playback_ack[0].at_ms` when present; falls back to `audible_first_byte_ms`. Pass criteria unchanged at P50 ≤500ms / P95 ≤800ms. |
| **G1.c** | iOS suppression correctness verified via state-machine states surfaced in ACK: `bundler` source ACK + matching `fast_tts` slot in `playedFastPathSlots` (now state `fastPlayed` or `resolved`) → CONTRADICTION. Should never happen. |
| **G1.d** | iOS no-fallback correctness: `source=local_fallback` ACKs for slots where `fast_tts_outcome IN (eligibility_rejected_*)` should be ZERO. |
| **G1.e** | NEW: queued-bundler drain correctness — when fast-tts fails AND iOS reports `source=bundler` ACK for the same slot in the same turn → state machine drained correctly. |
| **G2.unit** | Add `stage6-early-terminate.test.js` boards-array-undefined null-safety case. |
| **G2.integration** | Add: speculator-fast-tts-skip integration test for BOTH `onToolUseStreamed` AND `onSnapshotPatch` entry paths (closes B2 verification surface). |

---

## §D — Cumulative Things NOT to break (v4 totals)

(Carried forward from v2/v3 + v4 additions in **bold**.)

1. Sonnet's normal write path — totally untouched in Mode A.
2. Loaded Barrel cache key derivation: stays `expandForTTS(buildConfirmationText(...))`.
3. `applyReadingToSnapshot` and dispatcher invariants — unchanged.
4. The 12-tool agentic prompt — unchanged.
5. `addSonnetUsage` per-turn idempotency — unchanged.
6. The cap-hit branch — unchanged; predicate ordering ensures it wins on `rounds === maxRounds`.
7. Existing `voice_latency.outcome` events — unchanged.
8. Existing `stage6_live_extraction` log row — unchanged.
9. `onLoopComplete` speculator hook payload — unchanged shape; `terminal_reason` is a new field on the `runToolLoop` return value, not added to the hook payload.
10. **`AlertManager.swift:1158-1164` local fallback** — unchanged for non-fast-tts POST paths. ONLY the fast-tts POST handler skips this fallback.
11. **`loaded-barrel-cache.js` invalidateBySlot semantics** — unchanged; Pivot 11's abortBySlot uses it as the cleanup surface.
12. **`auth.requireAuth` shared middleware** — unchanged; `/playback-ack` reuses it without forking.

---

## §E — Files to touch (v4 totals)

(Diff vs v3 §I.)

**v4 additions:**
- `src/extraction/voice-latency-turn-summary.js` — REVISED for Pivot 8 two-row split + delayed finalizer.
- `src/routes/voice-latency-playback-ack.js` — NEW endpoint per §B.
- `src/extraction/loaded-barrel-speculator.js` — add `pendingByCorrelation` Map + `abortBySlot` method + pre-synth skip moved into `_speculate()`.
- iOS `Sources/Recording/AlertManager.swift` — state machine + `pendingBundlerConfirmations` queue.
- `src/extraction/cost-tracker.js` — accept `cancelledBeforeTextSent` flag on terminal.

**v4 test files:**
- `src/__tests__/loaded-barrel-speculator-fast-tts-skip.test.js` — both entry paths skip.
- `src/__tests__/loaded-barrel-speculator-abort-by-slot.test.js` — abort API.
- `src/__tests__/voice-latency-turn-summary-finalizer.test.js` — 8s timeout + ACK-driven emit.
- `src/__tests__/cost-tracker-pre-text-abort.test.js` — pre-text-sent cost attribution.
- `src/__tests__/voice-latency-playback-ack-route.test.js` — auth, validation, rate limit.

---

## §F — Open question carry-forward (none new)

All round-3 open questions either resolved in v4 or carried to executor's discretion (polarity_confirmed re-add; `headline_metric_is_server_side` gating; speculator-skip count granularity).

---

## §G — Revision history

- **v1 (early)** — 5+10 BLOCKERs.
- **v2 (late)** — 0+4 BLOCKERs. 3 structural pivots.
- **v3 (night)** — 0+3 BLOCKERs. 4 new pivots (iOS-side suppression, no-local-fallback, telemetry expansion, speculator-skip).
- **v4 (after round 3)** — 5 new pivots (split telemetry; in-`_speculate()` skip; 4-state iOS machine; abortBySlot API; cleanup contract pinned) + 6 §B IMPORTANTs. Target: zero BLOCKERs from both reviewers.
