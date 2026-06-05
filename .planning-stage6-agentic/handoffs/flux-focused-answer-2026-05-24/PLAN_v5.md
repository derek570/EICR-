# Flux focused-answer turn detection — PLAN_v5 (2026-05-25, reconciled round 4)

> Supersedes PLAN_v4.md. Addresses every BLOCKER + IMPORTANT from
> `claude-review-v4.md` and `codex-review-v4.md`. Convergent BLOCKERs:
> 3 (wire order, soft_reconnect myth, close-code-1000). All fixes are
> mechanical at this point — no architectural redesign.

## TL;DR (unchanged from v4)

Two-TestFlight strategy. Layer 2 redesigned around backend `eager_intent`
buffer. **Layer 1 alone is a meaningful but partial improvement**
(~5000ms → ~1500ms median); the substantive UX win lives in Layer 2.
TF#1 worth shipping standalone as a partial win even if TF#2 is paused.

**TF#1 has been converged since PLAN_v3.** Every round 4 BLOCKER is
TF#2-scope. Derek can ship TF#1 now and address remaining TF#2 BLOCKERs
in parallel.

## Reading guide

This document modifies only TF#2-affecting sections from PLAN_v4:

- **D20-v5** (replaces D20-v4 Case A) — reverse wire order
- **D13-v5** (replaces D13-v4 pseudo-code) — factor shared helper from `ask_user_answered`
- **D14-v5** (replaces D14-v4) — binary `session_continuity: continuous | reconnected`
- **D19-v5** (replaces D19-v4) — close code 1001 (`.goingAway`) not 1000
- **D21-v5** (refines D21-v4) — wrap resolve() at call sites
- **D22-v5** (NEW) — iOS `FluxAnswerNormaliser` Swift mirror
- **D17-v5 addendum** — `hasEverEnabledLayer2InThisSession` cleared on every WS connect
- **S6-v5 LOC update** — bump for `parseFocusedAnswerCapabilities` + iOS delegate migration

All other sections from PLAN_v3 / PLAN_v4 remain authoritative.

## Round-4 BLOCKER closures

### D20-v5 (replaces D20-v4 Case A) — reverse wire order

**Codex rd-4 BLOCKER 1 + Claude N1-v4 fix.** Case A becomes:

**Case A — matching commit:**
1. iOS sends `sendEagerCommit(turnId, utteranceId)` FIRST.
2. iOS sends `sendTranscript(finalText, utteranceId)` SECOND.
3. iOS marks ask consumed locally (`firedAskUserAnsweredToolCallIds.insert`,
   `inFlightQuestion = nil`, `dismissCurrentAlert()`).
4. iOS does NOT call `sendAskUserAnswered`.

ServerWebSocketService's serial WS send queue guarantees wire order.

Backend timeline:
1. `handleEagerCommit` runs first → invokes shared helper (D13-v5) which
   stamps `consumedAskUtterances.add(buffered.utteranceId)` + pushes
   to `recentAskAnswers` (after `resolve()` succeeds) + resolves the
   pending ask.
2. `handleTranscript` runs second → `consumedAskUtterances.has(utterance_id)` → HIT (set by step 1)
   → fast-paths via `seenTranscriptUtterances`-style suppression (the
   existing path in `handleTranscript` that bypasses extraction when
   an utterance has been consumed by an ask).
3. Result: ONE Sonnet round (resolved by eager). NO transcript-overtake
   race. NO extra shadow-harness extraction. Cost claim restored.

Case B (diverging) and Case C (no-eager) unchanged from D20-v4: iOS
sends transcript + ask_user_answered (or eager_discard + transcript +
ask_user_answered) in the existing legacy order.

### D13-v5 (replaces D13-v4 pseudo-code) — factor shared resolution helper

**Codex rd-4 BLOCKER 1 + Claude N1-v4/I7-v4 fix.** Don't duplicate
`ask_user_answered`'s ~250 LOC of resolution semantics. Factor into a
shared backend function:

```js
// New helper in src/extraction/stage6-ask-resolution.js (or near sonnet-stream.js)
async function commitAskAnswer(entry, {
  toolCallId,
  userText,
  consumedUtteranceId,
  source,             // 'user' (default, today's ask_user_answered path)
                       // or 'eager' (handleEagerCommit path)
}) {
  // Drop guard (no active session, srv- tool id, isStopping)
  // Sanitise userText via existing sanitiseUserText
  // Conditional reverse-race guard:
  //   source === 'user' → run guard against seenTranscriptUtterances/recentTranscripts;
  //                        may demote to user_moved_on
  //   source === 'eager' → SKIP guard. The wire order in D20-v5 Case A
  //                        guarantees handleTranscript hasn't run yet,
  //                        so seenTranscriptUtterances cannot already have
  //                        this utterance_id.
  // Conditional classifyOvertake new-command guard:
  //   source === 'user' → run today's guard
  //   source === 'eager' → SKIP. EagerEndOfTurn fired BEFORE the user could
  //                        have said something divergent — by Flux's
  //                        state machine, that's a TurnResumed event,
  //                        which iOS handles by sending eager_discard
  //                        (not eager_commit).
  // resolved = entry.pendingAsks.resolve(toolCallId, {
  //   answer: sanitisedText,
  //   wait_duration_ms: …,
  //   source,
  // })
  // Stamp ledgers ONLY if resolved (matches today's gate):
  //   entry.consumedAskUtterances.add(consumedUtteranceId)
  //   entry.recentAskAnswers.push({normalisedText, expiresAt, toolCallId})  // correct shape
  //   apply CONSUMED_UTTERANCE_CAP / RECENT_ASK_ANSWER_CAP eviction
  // Log if !resolved
  return resolved;
}
```

`ask_user_answered` handler refactored to call `commitAskAnswer(entry,
{...payload, source: 'user'})`. `handleEagerCommit` calls
`commitAskAnswer(entry, {toolCallId, userText: buffered.answer,
consumedUtteranceId: buffered.utteranceId, source: 'eager'})`.

The skip-guard rules for `source === 'eager'` are safe because of the
wire-order guarantee in D20-v5. If a future refactor changes the wire
order, the safety property breaks — add a code comment + test to enforce.

LOC: ~100 LOC for the helper extraction (mostly refactor of existing
code) + ~30 LOC for handleEagerCommit. Net new code is small; most of
S8-v5 is moving existing code into the helper.

### D14-v5 (replaces D14-v4) — binary session_continuity

**Codex rd-4 IMPORTANT 1 + Claude N2-v4 fix.** Backend `handleSessionStart`
reconnect path doesn't distinguish "soft" from "hard" today — every
reconnect runs `rejectAll('session_reconnected')`. Collapse to binary:

```json
{
  "type": "session_ack",
  "status": "ok",
  "session_continuity": "continuous" | "reconnected"
}
```

- `continuous` — fresh session start (today's `status: "started"` path).
- `reconnected` — any reconnect (today's `status: "reconnected"` path,
  including `rejectAll` and ledger clearing).

iOS handling:
- On `continuous`: normal. `pendingEagerByFluxTurnId` empty (new session).
- On `reconnected`: iOS clears `pendingEagerByFluxTurnId` AND filters
  reconnect buffer to drop any `eager_intent` / `eager_commit` /
  `eager_discard` entries. Lets paired `transcript` + `ask_user_answered`
  through.

Backend change is just adding the new field to `session_ack` response
(map `'started' → 'continuous'` and `'reconnected' → 'reconnected'`).
iOS new delegate signature accepts the new field as an enum, defaults
to `'continuous'` if missing (back-compat with older backends, won't
happen post-deploy due to capability gate).

S6-v5 backend handler change: ~10 LOC. iOS: ~50 LOC (delegate signature
extension + filter logic on reconnect).

### D19-v5 (replaces D19-v4) — close code 1001 (.goingAway), not 1000

**Codex rd-4 BLOCKER 2 + Claude N3-v4 fix.** Use `.goingAway` (close
code 1001) for the force-reconnect. The existing `didCloseWith` gate
at `DeepgramService.swift:1432-1453`:

```swift
if self.shouldReconnect && closeCode != .normalClosure {
    self.scheduleReconnect()
} else {
    self.connectionState = .disconnected
}
```

ALREADY treats `.goingAway` as reconnect-eligible (the gate excludes
ONLY `.normalClosure`).

iOS S15-v5 (replaces S15-v4):
1. Set `shouldForceFocusedReset = true` (private flag on `DeepgramService`).
2. `webSocketTask?.cancel(with: .goingAway, reason: Data("focused_mode_reset".utf8))`.
3. **Do NOT** call `urlSession?.invalidateAndCancel()` — that would
   tear down the URLSession too. The cancel(with:) call is sufficient
   to close the WS frame.
4. `didCloseWith` fires → gate condition `shouldReconnect && closeCode != .normalClosure` → true → `scheduleReconnect()`.
5. Reconnect builds fresh Flux URL (no `eager_eot_threshold`). iOS
   focused-mode state cleared per D17-v5 addendum.

No new code in `didCloseWith` is required — the existing path handles
it.

Backend side: WS close with code 1001 looks like any other dropped
connection to backend. Per D14-v5 binary semantics, backend treats
this as a `reconnected` event (because the next session-start message
from iOS will trigger the reconnect path). iOS handles `reconnected`
per D14-v5: clears `pendingEagerByFluxTurnId` + filters buffer.

### D17-v5 addendum to D17-v4 — `hasEverEnabledLayer2InThisSession` lifecycle

**Claude I5-v4 fix.** Explicitly:

- **Set:** in S12-v4 on first invocation per session.
- **Cleared:** on every `DeepgramService` WS connect (including reconnects).
  This includes the force-reconnect from D19-v5.

Code site: `DeepgramService._connect()` resets the flag to false at
the same point the URL is built. Force-reconnect → new connect → flag
reset → restore Configure on next focused-mode exit uses the omit path
again (because the new WS has no prior `eager_eot_threshold` set).

This prevents the infinite-loop interpretation Claude I5-v4 raised.

### D21-v5 (refines D21-v4) — wrap resolve() at call sites, not in registry

**Codex rd-4 IMPORTANT 3 + Claude I4-v4 fix.** The `pendingAsks` registry
doesn't support callbacks. PLAN_v4 D21-v4 Surface 3 implied otherwise.

PLAN_v5 D21-v5 simpler: in `sonnet-stream.js`'s `ask_user_answered`
handler, after `commitAskAnswer` returns, call
`entry.eagerBuffer.deleteByToolCallId(toolCallId)` to sweep any stale
eager buffer entries for the same tool. Pure call-site wrap; no
registry change. ~5 LOC at the one call site (the existing
`ask_user_answered` handler).

`entry.eagerBuffer.deleteByToolCallId(toolCallId)` is a new method on
the buffer module from S7 — iterates entries, deletes those matching
the toolCallId. ~10 LOC + unit test.

Surface 4 (`rejectAll`) handled by extending `rejectAll` itself OR
by call-site wrap in `handleSessionStart` reconnect path. PLAN_v5
picks call-site wrap (consistency with Surface 3): after
`existing.pendingAsks.rejectAll('session_reconnected')`, call
`existing.eagerBuffer.clear()`. ~3 LOC.

Surface 5 (periodic 30s timer): unchanged from D21-v4. Lives in the
buffer module per S7. ~20 LOC.

### D22-v5 (NEW) — iOS Swift `FluxAnswerNormaliser`

**Claude I3-v4 fix.** New helper in
`Sources/Recording/FluxAnswerNormaliser.swift`:

```swift
enum FluxAnswerNormaliser {
    static func normalise(_ text: String) -> String {
        return text
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9\s]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}
```

Byte-for-byte mirror of backend's `normaliseForAskMatch`. ~20 LOC + 5
unit tests (empty, simple, with-punctuation, with-multiple-whitespace,
unicode-edge-case).

S10-v5 Case A comparison uses this normaliser:

```swift
if FluxAnswerNormaliser.normalise(finalText) ==
   FluxAnswerNormaliser.normalise(buffered.answer) {
    // Case A
} else {
    // Case B
}
```

## IMPORTANT closures (round 4)

| ID | Fix |
|---|---|
| Claude I1-v4 | D13-v5 helper code-comment to make the inline-safety claim explicit. ~2 LOC. |
| Claude I2-v4 / Codex IMPORTANT 2 (S6 extension) | S6-v5 LOC budget revised to ~150 LOC (was ~80). Includes new `parseFocusedAnswerCapabilities` module + iOS delegate signature migration + 1 day of test-fixture audit. |
| Claude I3-v4 | D22-v5 above. |
| Claude I4-v4 / Codex IMPORTANT 3 | D21-v5 above (call-site wraps). |
| Claude I5-v4 | D17-v5 addendum above. |
| Claude I6-v4 | Pre-deploy step: audit `transcript-replay.mjs` fixtures + iOS test mocks for hard-coded `session_ack` shape. ~½ day of test review. Add to TF#2 pre-deploy checklist. |
| Codex IMPORTANT 2 (D18-v4 keying rule) | D18-v5 addendum: keying rule explicit. The reorder algorithm builds `turnId -> (toolCallId, utteranceId)` from buffered `eager_intent` messages in the reconnect buffer. If `eager_commit` or `eager_discard` arrives without its paired `eager_intent` in the same buffer batch (intent was sent pre-disconnect and reached backend), the algorithm falls back to FIFO order — backend's `recentEagerIntents` 60s ledger handles the lookup. |

## NIT closures (round 4)

| ID | Fix |
|---|---|
| Claude NIT-1-v4 | D11-v4 docstring updated to verbatim Deepgram quote. |
| Claude NIT-2-v4 | D8-v4 backoff: 1s linear between in-session retries (max 3 retries, then sticky-disable until session restart). ~5 LOC. |
| Claude NIT-3-v4 | LOC budget update: TF#2 ~1100 LOC total (was 970 in v4). Mostly from helper extraction (D13-v5) and `parseFocusedAnswerCapabilities`. Honest. |
| Claude NIT-4-v4 | Composition table TF#2 column updated to note: "Layer 2 saving universal for free_text asks; shape-matching asks already get the saving via classifyOvertake but with the same eager-buffer wire — no regression." Telemetry should distinguish ask-shape categories. |
| Claude NIT-5-v4 | `eagerControlQueue` renamed to `eagerControlSerial` to convey it's a Promise.resolve-chained micro-task serializer, not an array queue. Implementation: a single `entry.eagerControlChain = Promise.resolve()` that handlers await + reassign. ~3 LOC. |

## Slice deltas (v5 vs v4)

| Slice | v4 LOC | v5 LOC | Delta |
|---|---|---|---|
| S6-v5 | ~80 | ~150 | +~70 (parseFocusedAnswerCapabilities + iOS delegate migration) |
| S7-v5 | ~150 | ~180 | +~30 (D21-v5 deleteByToolCallId method + Surface 4 call-site sweep) |
| S8-v5 | ~150 | ~180 | +~30 (shared helper extraction; net code may be smaller post-refactor but counting the lines of change is higher) |
| S9-v5 | ~80 | ~80 | unchanged |
| S10-v5 | ~200 | ~220 | +~20 (D22-v5 normaliser usage + reversed wire-order in Case A) |
| S11-v5 | ~100 | ~100 | unchanged |
| S12-v5 | ~30 | ~30 | unchanged |
| S13-v5 | ~60 | ~60 | unchanged |
| S14-v5 | ~40 | ~40 | unchanged |
| S15-v5 | ~80 | ~80 | unchanged (just close-code change, not LOC) |
| **S16-v5 (NEW)** | — | ~30 | iOS `FluxAnswerNormaliser` + 5 unit tests |

**TF#2 v5 total: ~1150 LOC** (was ~970 in v4). Backend split: ~370 LOC.
iOS split: ~780 LOC. Honest estimate per Claude NIT-3-v4.

## Open questions

**None blocking.** All round 1-4 BLOCKERs addressed.

Items deferred to implementation:
- Exact normalisation edge cases for `FluxAnswerNormaliser` (unicode,
  apostrophes) — covered by D22-v5 unit tests.
- `parseFocusedAnswerCapabilities` location (new module vs extending
  `voice-latency-config.js`) — implementer choice.
- `entry.eagerControlChain` initialisation site (per-session entry
  in `sonnet-stream.js`) — implementer.

## Composition table (no changes vs PLAN_v4)

Layer 1 alone (TF#1): ~5-5.5s TTS-end → "Got it, eight".
Layer 2 commit case (TF#2): ~3.7-5s.
Layer 2 commit case + voice-latency TTS streaming: ~1.5-2.3s.

## Convergence

Three rounds of structural redesign (v1 → v3) plus two rounds of
wire-protocol refinement (v3 → v5). The eager_intent buffer
architecture has held since v3; v4 and v5 are pure refinement.

Next round (round 5) should converge — all remaining issues are
mechanical detail. If round 5 still finds BLOCKERs, the structural
shape is likely the wrong fit and TF#2 should be scoped out as a
separate sprint with its own design phase.
