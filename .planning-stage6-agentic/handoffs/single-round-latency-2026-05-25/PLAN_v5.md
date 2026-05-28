# Single-Round Latency Sprint — Plan v5

**Date:** 2026-05-25
**Status:** DRAFT — pending round 5 review.
**Supersedes:** PLAN_v4.md. SURGICAL revision closing Claude round-4 BLOCKER (B-v4.1 cost-tracker signature contradiction) + 4 IMPORTANTs (I1 deferredTTS, I2 type normalization, I3 active-sessions helper, I4 late-ACK) + 5 NITs.

**Read PLAN_v3.md and PLAN_v4.md alongside this file.** v5 only describes deltas from v4.

---

## §A — v5 pivot deltas

### Pivot 11.1 — Cost-tracker signature reconciled (closes Claude B-v4.1)

v4 had two non-overlapping calling conventions for `recordElevenLabsSpeculativeTerminal`:
- Pivot 11 §A: `recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled_by_fast_tts_hint')` — adds new string enum.
- v4 §B: "v4 adds a `cancelledBeforeTextSent: bool` flag" — adds opts flag.

Current validator at `cost-tracker.js:256-258` accepts only `'completed' | 'cancelled' | 'failed'`. The first form would no-op silently.

**v5 design — option (c) from Claude's analysis: extend signature to accept opts.**

New signature:
```js
recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts = {})
```

Where `terminal` STAYS as the three legacy values (`'completed' | 'cancelled' | 'failed'`). The `opts` parameter carries:
```js
{
  reason?: string,                  // free-text WHY (telemetry only, not ledger affecting)
  cancelledBeforeTextSent?: boolean // if true, attributes 0 chars rather than recorded chars
}
```

Implementation diff at `cost-tracker.js:254-266`:
- Keep the existing enum check (back-compat: legacy callers pass `terminal` only).
- When `terminal === 'cancelled' AND opts.cancelledBeforeTextSent === true`: `charsCancelled` is NOT incremented (the speculator never sent text to ElevenLabs, so no chars were billed).
- When `opts.reason` is supplied: emit a SEPARATE telemetry event `voice_latency.speculative_terminal_reason` carrying `{correlationId, terminal, reason}` so dashboards can attribute the WHY without polluting the ledger.

Pivot 11 abort path becomes:
```js
recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled', {
  reason: 'cancelled_by_fast_tts_hint',
  cancelledBeforeTextSent: hadNotYetCalledSynth, // true if abort fired before client.synth()
});
```

This closes B-v4.1: the cost ledger uses the existing 3-value enum (no validator change required), the cancellation reason lives in a separate telemetry event, and the pre-text-sent attribution is a single boolean.

Tests:
- `src/__tests__/cost-tracker-opts-reason.test.js` (NEW) — asserts (a) legacy 2-arg call still works; (b) `opts.reason` emits `speculative_terminal_reason` event; (c) `opts.cancelledBeforeTextSent: true` skips `charsCancelled` increment; (d) opts both unset matches legacy behaviour.

### Pivot 10.1 — deferredTTS interaction pinned (closes Claude I1)

Pivot 10's 5-state machine (states: `idle`, `fastPending`, `fastPlayed`, `bundlerPlayed`, `resolved`) did not address `AlertManager`'s pre-existing `deferredTTS` mechanism. v5 adds explicit rules:

1. **Fast-tts playback bypasses `shouldDeferPlayback`.** When the fast-tts HTTP response yields 200 + audio, `AVAudioPlayer.play()` is invoked IMMEDIATELY without checking `shouldDeferPlayback`. Rationale: the entire premise of the audible-latency win is that the inspector hears confirmation at ~420ms; deferring it defeats the purpose. The inspector talking over their own confirmation is acceptable — it's already what happens when iOS plays via cache HIT (~400ms after the inspector stopped, well within the inspector-still-speaking window).

   Code location: new `playFastPathAudio(audioData, slot)` function on AlertManager. NOT routed through `speakWithTTS` (which honors deferredTTS at line 1136-1141).

2. **Bundler queue check happens at TOP of `speakBriefConfirmation`.** Before the existing `speakWithTTS` dispatch:
   ```swift
   func speakBriefConfirmation(_ text: String, expandedText: String? = nil, slot: SlotKey?, ...) {
     guard let slot = slot else {
       speakWithTTS(text, ...) // legacy path: no slot info → no dedup
       return
     }
     switch fastPathSlotStates[slot] ?? .idle {
       case .fastPending:
         // Queue; will be drained on fast-tts terminal
         pendingBundlerConfirmations[slot] = (text, expandedText, ctx)
         return
       case .fastPlayed, .bundlerPlayed, .resolved:
         // Suppress (already heard via fast-path OR a duplicate bundler arriving)
         return
       case .idle:
         speakWithTTS(text, ...) // play through standard path
         fastPathSlotStates[slot] = .bundlerPlayed
     }
   }
   ```

3. **deferredTTS 6s drop path transitions matching slot.** When `resumeDeferredTTSIfNeeded` (line 1178-1213) drops audio older than 6s, the dropped audio's source matters:
   - If the dropped audio originated from `speakBriefConfirmation` (carries a `SlotKey`), the matching state goes `bundlerPlayed → idle` (the drop means it was never spoken). Any subsequently-arriving fast-tts can still play.
   - If the dropped audio is unrelated (no SlotKey), no state machine impact.
   
   This is a defensive transition; in practice `bundlerPlayed` is only set AFTER `speakWithTTS` is dispatched (not after speech completes), so the deferred-and-dropped case sets the state prematurely. Reset to `idle` on drop keeps the queue logic honest.

4. **Late fast-tts arriving for slot in `bundlerPlayed`.** Per v4 spec: DO NOT play; transition `bundlerPlayed → resolved`. v5 explicitly notes the audio data is DISCARDED (free the buffer; do not stash for later). Resolved is terminal for this turn.

Race coverage matrix updated:

| Scenario | State sequence | Audible outcome |
|---|---|---|
| Fast succeeds, bundler arrives later | idle → fastPending → fastPlayed → (bundler suppressed) → resolved | ONE (fast) |
| Bundler arrives while fast pending, fast succeeds | idle → fastPending → (bundler queued) → fastPlayed → (drop queue) → resolved | ONE (fast) |
| Bundler arrives while fast pending, fast fails | idle → fastPending → (bundler queued) → idle → (drain queue) → bundlerPlayed | ONE (bundler) |
| Fast-tts deferred (impossible per Rule 1) | — | n/a |
| Bundler deferred and dropped (>6s old) | bundlerPlayed → idle → (subsequent late fast plays) → fastPlayed | ONE (fast, late) |
| Both arrive in idle (no fast-tts POST fired) | idle → bundlerPlayed | ONE (bundler) |

### Pivot 11.2 — abortBySlot type normalization (closes Claude I2)

v4 Pivot 11's matching predicate used strict-equal. v5 specifies normalization aligned with existing `loaded-barrel-cache.js:invalidateBySlot`:

```js
function slotMatches(stored, hint) {
  return (
    stored.field === hint.field &&
    Number(stored.circuit ?? -1) === Number(hint.circuit ?? -1) &&
    normalizeBoardId(stored.boardId) === normalizeBoardId(hint.boardId)
  );
}

function normalizeBoardId(b) {
  if (b == null) return null;
  const s = String(b);
  return s.length === 0 ? null : s;
}
```

Explicit semantics:
- `boardId: null` and `boardId: ''` are equivalent (both → `null`).
- `boardId: 'main'` and `boardId: null` are DIFFERENT (no fallback to currentBoardId at match time — the speculator stored what it stored).
- `circuit: 0` and `circuit: null` are DIFFERENT (board-level vs unset). Documented in code comment.
- `circuit: 1` and `circuit: '1'` are equivalent (both → `1`).

Predicate exported as `slotMatches` from `loaded-barrel-speculator.js` for reuse + testing. Test file `loaded-barrel-speculator-abort-by-slot.test.js` adds cases:
- empty-string vs null boardId match.
- numeric vs string circuit match.
- circuit:0 vs circuit:null do NOT match.
- different board, same circuit/field do NOT match.

### Pivot 12.1 — `getActiveSession` reference corrected (closes Claude I3)

v4 §B I4 falsely claimed `getActiveSession(sessionId)` exists in `active-sessions.js`. **Verified false** — only `activeSessions` (raw Map) + `getVoiceLatencyForSession` are exported.

**v5 design — direct Map access via new explicit helper:**

`src/extraction/active-sessions.js` gains:
```js
export function getActiveSessionEntry(sessionId) {
  return activeSessions.get(sessionId) ?? null;
}
```

Phase 1 fast-tts endpoint validation becomes:
```js
import { getActiveSessionEntry } from '../extraction/active-sessions.js';
import { getMainBoardId } from '../extraction/stage6-multi-board-shape.js';

const entry = getActiveSessionEntry(sessionId);
if (!entry) return res.status(404).json({ reason: 'session_not_found' });
const liveBoardId = entry.session?.stateSnapshot?.currentBoardId
  ?? getMainBoardId(entry.session?.stateSnapshot ?? {});
if (req.body.candidate.boardId !== liveBoardId) {
  return res.status(409).json({ reason: 'wrong_board' });
}
```

Reuses the existing exported `activeSessions` Map; adds one tiny helper to keep the call site readable.

### Pivot 8.1 — Late-ACK behaviour (closes Claude I4)

v4 Pivot 8 didn't specify what happens when `/api/voice-latency/playback-ack` arrives AFTER the audio finalizer has fired and `turn_audio_summary` is already emitted (immutable).

**v5 design — emit separate row:**

`voice-latency-turn-summary.js`:
```js
recordPlaybackAck(turnId, ack) {
  const pending = this.pendingAudioFinalizers.get(turnId);
  if (pending) {
    // On-time path (v4 spec, unchanged)
    pending.received_acks.push(ack);
    if (pending.received_acks.length >= pending.expected_acks) {
      clearTimeout(pending.timer);
      this.emitTurnAudioSummary(turnId, /*timeout=*/false);
    }
    return;
  }
  // Late-ACK path (NEW v5):
  this.emitLatePlaybackAck(turnId, ack);
}
```

`emitLatePlaybackAck` writes a single CloudWatch row:
```json
{
  "event": "voice_latency.late_playback_ack",
  "sessionId": "...",
  "turnId": "...",
  "slot_key": "field::circuit::boardId",
  "source": "fast_tts" | "bundler" | "local_fallback",
  "at_ms": 1234,
  "received_at_ms": 5678,
  "lag_ms": 4444
}
```

Dashboards can correlate by `{sessionId, turnId}` to the earlier `turn_audio_summary` row. Telemetry signal: high `lag_ms` indicates iOS-network or backend-processing delays worth investigating.

`/api/voice-latency/playback-ack` endpoint returns 204 No Content for both on-time and late ACKs. iOS does not distinguish.

Field `audio_finalizer_timeout_fired` in `turn_audio_summary` continues to flag the row that timed out; the late-ACK row that arrives afterward is its own provenance.

### Pivot 10.2 — Pivot 10 state count corrected (closes Claude N1)

v4 Pivot 10 header said "4-state" but listed 5. v5 keeps all 5 states (`idle | fastPending | fastPlayed | bundlerPlayed | resolved`) and corrects the header. `resolved` is NOT redundant with the play-terminal states: it specifically means "this turn's slot is closed; no further play attempts apply." Used by Race scenarios (5) and (4) where fast-tts arrives after bundler already played.

### Pivot 11.3 — pendingControllers preservation (closes Claude N2)

v5 explicitly notes: the existing `pendingControllers: Set` in `loaded-barrel-speculator.js:130` STAYS unchanged. `shutdown()` (line 537-544) iterates it for graceful shutdown. v4's new `pendingByCorrelation: Map<correlationId, {slot, controller, cacheKey}>` is ADDED in parallel. Every speculator entry has identity in both: `pendingControllers.add(controller)` AND `pendingByCorrelation.set(correlationId, {slot, controller, cacheKey})`. Both are cleared on terminal (success/abort/error).

Comment in code:
```js
// pendingControllers (existing): used by shutdown() to abort all in-flight
//   synths on session-end. Set, not slot-addressable.
// pendingByCorrelation (NEW v4/v5): used by abortBySlot to selectively abort
//   in-flight synths whose slot matches an incoming fast-tts hint. Map keyed
//   by correlationId. Both structures mirror each other; both cleared on
//   terminal in the same code path.
```

### Pivot 12.2 — Cleanup rationale corrected (closes Claude N4)

v4 Pivot 12 explained the cleanup-after-startAudioFinalizer ordering as "the audio finalizer can still consult the slot if needed" — Claude correctly noted the finalizer consults `pendingAudioFinalizers`, not `pendingFastTtsSlots`. v5 corrects:

The real ordering reason: `startAudioFinalizer(turnId)` must create the `pendingAudioFinalizers` entry BEFORE any `/playback-ack` POST can find it. Cleanup of `pendingFastTtsSlots` is independent and unrelated to the finalizer; it just lives in the same `finally` block for convenience.

Rewritten comment in `stage6-shadow-harness.js`:
```js
try {
  // ... runLiveMode body ...
  emitTurnCoreSummary(turnId, /* facts */);
  startAudioFinalizer(turnId, expected_acks); // MUST happen before finally block
} finally {
  // Clean up the per-turn fast-tts hint set. Independent of the audio
  // finalizer; lives here to ensure cleanup on error / cap-hit / abort.
  session.pendingFastTtsSlots.delete(turnId);
}
```

### Pivot 8.2 — Expected-ACK count formula corrected (closes Claude N5)

v4 Pivot 8 said `expected_acks = bundler_emitted_confirmations.length + (fast_tts_outcome === 'ack_played' ? 1 : 0)`. The `fast_tts_outcome` is itself determined by the ACK; circular.

**v5 design — count by intent, not by outcome:**

```js
expected_acks = bundler_emitted_confirmations.length
              + (fast_tts_correlation_id != null ? 1 : 0);
```

Where `fast_tts_correlation_id != null` means the iOS client posted a fast-tts POST for this turn (regardless of HTTP outcome). The finalizer expects one ACK from each bundler-emitted confirmation AND one from the fast-tts playback (if attempted).

If fast-tts was rejected (409/422) by the backend, the ACK count drops by 1 — handled by another small refinement: `regex-fast-tts` endpoint, when rejecting, calls `decrementExpectedAcks(sessionId, turnId)`. Endpoint can do this because by-that-point the `pendingAudioFinalizers` entry may not yet exist (the WS extraction hasn't returned yet); in that case `decrementExpectedAcks` stashes a deferred decrement in `session.pendingAckDecrements: Map<turnId, number>` that the finalizer subtracts when it arms.

This makes the timeout less aggressive (won't wait for ACKs that can't arrive) without introducing the circular dependency.

---

## §B — Updated files (v5 deltas vs v4)

| File | v5 change |
|---|---|
| `src/extraction/cost-tracker.js` | extend `recordElevenLabsSpeculativeTerminal` to accept `opts`; emit `speculative_terminal_reason` event |
| `src/extraction/loaded-barrel-speculator.js` | export `slotMatches` predicate; `pendingByCorrelation` doc comment |
| `src/extraction/active-sessions.js` | add `getActiveSessionEntry(sessionId)` helper |
| `src/routes/voice-latency-fast-tts.js` | use `getActiveSessionEntry`; call `decrementExpectedAcks` on 4xx |
| `src/extraction/voice-latency-turn-summary.js` | add `recordPlaybackAck` late-row path; `emitLatePlaybackAck`; `decrementExpectedAcks` |
| `src/extraction/stage6-shadow-harness.js` | corrected cleanup-rationale comment; expected_acks formula fix |
| iOS `Sources/Recording/AlertManager.swift` | `playFastPathAudio` bypasses `shouldDeferPlayback`; bundler-queue check at top of `speakBriefConfirmation`; deferredTTS-drop state transition |

---

## §C — Updated tests (v5 deltas)

- `src/__tests__/cost-tracker-opts-reason.test.js` (NEW): 4 cases for the new opts signature.
- `src/__tests__/loaded-barrel-speculator-abort-by-slot.test.js` (UPDATED): add type-normalization cases (empty-string boardId, numeric vs string circuit, circuit:0 vs circuit:null distinction).
- `src/__tests__/voice-latency-turn-summary-late-ack.test.js` (NEW): assert late-ACK emits separate row; on-time path unchanged.
- `src/__tests__/voice-latency-turn-summary-decrement.test.js` (NEW): rejected fast-tts decrements expected_acks correctly.
- iOS `Tests/CertMateUnifiedTests/Recording/AlertManagerStateMachineTests.swift` (NEW): 6 race scenarios from the matrix above.

---

## §D — Verification gate deltas (vs v4)

| Gate | v5 delta |
|---|---|
| **G0** | Add: `voice_latency.late_playback_ack` row count tracked; high lag (P95 > 5s) flagged for investigation but not gate-blocking. |
| **G0** | Add: `voice_latency.speculative_terminal_reason` rows emitted for cancellations; gated at ≥1 row per `loaded_barrel_skipped_fast_tts_hint` event. |
| **G1.e** (queued bundler drain) | Strengthened: when iOS reports `bundler` source ACK following a `fast_tts_outcome NOT IN (ack_played)` in the same turn AND iOS's state machine logs show `pendingBundlerConfirmations` was non-empty during fast-pending → CORRECT BEHAVIOUR. Track via new iOS telemetry log `alert_manager.bundler_queue_drained`. |
| **G1.f** (deferredTTS interaction) | NEW: zero events of `alert_manager.fast_tts_deferred` (which would indicate fast-tts went through `speakWithTTS` instead of `playFastPathAudio` — a bug). |

---

## §E — Things NOT to break (v5 deltas vs v4)

13. **`recordElevenLabsSpeculativeTerminal` legacy 2-arg signature** — back-compat preserved. The new `opts` param is optional with default `{}`.
14. **`pendingControllers` Set in speculator** — unchanged. `shutdown()` continues to work as today.
15. **`shouldDeferPlayback` on the normal bundler TTS path** — unchanged. ONLY `playFastPathAudio` bypasses it.
16. **`speakWithTTS` line 1003+ existing behaviour** — unchanged. New code path is `playFastPathAudio` and the new dedup check at top of `speakBriefConfirmation`.
17. **CloudWatch immutability** — preserved. v5's late-ACK is a separate row, not a row mutation.

---

## §F — Revision history

- **v1** — 5+10 BLOCKERs.
- **v2** — 0+4 BLOCKERs. 3 structural pivots.
- **v3** — 0+3 BLOCKERs. 4 new pivots.
- **v4** — Codex round 3 surfaced 2 NEW BLOCKERs (telemetry emission model + speculator two-entry); v4 added 5 new pivots to close them. Claude round 4: 1 NEW BLOCKER (cost-tracker signature contradiction) + 4 IMPORTANTs (deferredTTS race, type normalization, active-sessions getter, late-ACK).
- **v5** — closes Claude round-4 BLOCKER (Pivot 11.1 cost-tracker opts) + all 4 IMPORTANTs (Pivots 10.1, 11.2, 12.1, 8.1) + all 5 NITs (10.2, 11.3, 12.2, 8.2, plus N3 explicit cite). Target: zero BLOCKERs from both reviewers.

---

## §G — Open question carry-forward

No new open questions. v5 is intended as the convergence draft.
