# Flux focused-answer turn detection — PLAN_v4 (2026-05-25, reconciled round 3)

> Supersedes PLAN_v3.md. Addresses every BLOCKER + IMPORTANT from
> `claude-review-v3.md` and `codex-review-v3.md`. **TF#1 (Layer 1)
> portion of PLAN_v3 is effectively converged** per Claude rd-3 verdict;
> v4 changes are TF#2-scope only plus IMPORTANT/NIT fixes.

## TL;DR (updated per Claude I7-v3)

Same two-TestFlight strategy as PLAN_v3. Layer 2 redesigned around
backend `eager_intent` buffer. **Layer 1 alone is a meaningful but
partial improvement** (~5000ms → ~1500ms median, saves 3-4s on a ~8.5s
end-to-end UX problem); **the substantive UX win lives in Layer 2**
(~300-700ms turn-to-dispatch when eager fires) which compounds with the
in-flight voice-latency TTS streaming sprint to reach ~1.5-2.3s total
"speech-end → audible confirmation". TF#1 worth shipping standalone as
a partial win even if TF#2 is paused for redesign rounds.

## Reading guide

Unchanged sections (still authoritative from PLAN_v3): Problem,
voice-latency sprint composition, Option A rejection, Validation
strategy, Rollback story, Costs.

This document modifies: D6-v3 (citation hygiene), D10-v3 (specifies
ledger stamping), D13-v3 (replaced by D13-v4 + D20-v4), D17-v3
(replaced by D17-v4 + D19-v4), D14-v3 (extends with session-continuation
signal), S6-v3, S7-v3, S8-v3, S10-v3, S11-v3.

## Round-3 BLOCKER closures

### D13-v4 (replaces D13-v3) — Separate per-session eager-control queue

**Was (D13-v3):** "Treat eager_intent / eager_commit / eager_discard as
members of the same queue family as transcripts — drained in arrival
order while `isExtracting=false`."

**Codex rd-3 BLOCKER 1**: deadlocks. `eager_commit` queued behind
`isExtracting=true` (which is held by the tool loop awaiting
`pendingAsks.resolve()`) cannot fire the resolve that would clear
`isExtracting`. Result: ask times out at 45s.

**Now (D13-v4):** Separate per-session `eagerControlQueue` on
`entry.eagerControlQueue` in `sonnet-stream.js`. **Drains independently
of `isExtracting`.** `pendingAsks.resolve()` is synchronous (wakes a
pending promise; doesn't await) and IS safe to call inline even while
the tool loop is mid-await — that's exactly the same mechanism today's
`ask_user_answered` handler uses.

Per Claude I4-v3 reading: `eager_intent` and `eager_discard` handlers
are pure inline (synchronous body, no awaits — single Map operation
each). `eager_commit` handler runs synchronously up to and including
`pendingAsks.resolve()`, but ledger writes (`recentAskAnswers.push`,
`consumedAskUtterances.add`) happen FIRST, before resolve, to close the
N1-v3 race. The serial queue exists ONLY to serialize multiple
eager_* messages against each other (e.g. eager_intent immediately
followed by eager_discard for the same turn). It does not block on
`isExtracting`.

```js
// pseudo-code, sonnet-stream.js handler stubs
function handleEagerIntent(msg) {
  entry.eagerBuffer.set(msg.fluxTurnId, {toolCallId: msg.toolCallId, answer: msg.text, utteranceId: msg.utteranceId, sentAt: Date.now()});
  // inline, no awaits, no isExtracting check
}

function handleEagerCommit(msg) {
  const buffered = entry.eagerBuffer.get(msg.fluxTurnId);
  if (!buffered) { logger.warn('eager_commit with no buffer'); return; }
  entry.eagerBuffer.delete(msg.fluxTurnId);
  // CLAUDE N1-v3 fix: mirror ask_user_answered ledger writes:
  entry.recentAskAnswers.push({normalisedText: normalise(buffered.answer), at: Date.now()});
  entry.consumedAskUtterances.add(buffered.utteranceId);
  // Run the same reverse-race guard ask_user_answered runs (see sonnet-stream.js:1547-1700)
  // ... reverse-race guard inline ...
  // Then resolve the pending ask. Synchronous wake of the awaiting dispatcher promise:
  entry.pendingAsks.resolve(buffered.toolCallId, {answer: buffered.answer, source: 'eager'});
}

function handleEagerDiscard(msg) {
  entry.eagerBuffer.delete(msg.fluxTurnId);
  // inline, no awaits
}
```

LOC estimate revised per Claude N1-v3 critique: S7 ~150 LOC + S8 ~150
LOC for ledger-stamping + reverse-race-guard mirror = total ~300 LOC
backend (was ~330 in v3 — net +~50 because the reverse-race guard is
genuinely additional code).

### D17-v4 (replaces D17-v3) — Layer 1 Configure semantics for eager_eot_threshold

**Was (D17-v3):** "Layer 1 Configure: `eager_eot_threshold` UNSET (omit
from `thresholds` object)."

**Codex rd-3 BLOCKER 2**: Deepgram docs explicit — "omitted parameters
retain their current values." Once Layer 2's S12 Configure has SET
`eager_eot_threshold=0.4`, a later Layer-1-only Configure that omits
the field does NOT clear it.

**Now (D17-v4):** Layer 1's restore-defaults path branches on session
state:
- **If `hasEverEnabledLayer2InThisSession == false`** (first ask of the
  session, or Layer 2 flag has been off the entire session): Configure
  omits `eager_eot_threshold`. Flux had no prior eager-mode value to
  retain, so omission is safe.
- **If `hasEverEnabledLayer2InThisSession == true`** (Layer 2 was active
  earlier in this session): Configure-omission cannot clear the value;
  trigger a **D19-v4 force-reconnect** (defined below) instead of
  sending the restore Configure.

For TF#1 alone (no Layer 2), `hasEverEnabledLayer2InThisSession` is
permanently `false` → omission path used → no force-reconnect ever
needed → TF#1 unaffected. **TF#1 stays simple.**

For TF#2, the iOS `DeepgramService` tracks `hasEverEnabledLayer2InThisSession`
as a Bool set on first S12 invocation and cleared on session start.

### D19-v4 (NEW) — Force-reconnect path specification

**Codex rd-3 BLOCKER 2 + Claude I6-v3 fix.** Triggered by D17-v4 in the
`hasEverEnabledLayer2InThisSession == true && restore-needed` case AND
by D8-v3's restore-Configure-failure 3-strikes path.

Mechanism: cancel the URLSessionWebSocketTask's `receive()` loop in a
way that triggers the existing `.failure` branch at
`DeepgramService.swift:825-830`, which calls `scheduleReconnect()`.
This is NOT `webSocketTask?.cancel(with: .normalClosure)` (which triggers
full teardown including `urlSession?.invalidateAndCancel()` per line
493). Instead: set `shouldReconnect = true` then close the WS frame
with code 1000 + a special reason string `"focused_mode_reset"`, and
have the receive() callback recognize the close code and route to the
`.failure` branch deliberately.

iOS state on force-reconnect: `enterFocusedAnswerMode()` /
`exitFocusedAnswerMode()` state is cleared. `pendingEagerByFluxTurnId`
is cleared. The next Configure on the new connection uses the URL-
default Flux config — no eager_eot_threshold.

### D20-v4 (NEW) — iOS final-event routing in TF#2 (S10-v4 specification)

**Closes Claude N1-v3 (eager_commit ledger stamping) + Codex rd-3
BLOCKER 3 (S10 doesn't suppress final ask_user_answered) + Claude
N3-v3 (no-eager EndOfTurn path).**

Three cases when iOS receives `EndOfTurn(turnId, finalText, utteranceId)`
inside `inFlightQuestion` window:

**Case A — matching commit:** `pendingEagerByFluxTurnId[turnId]` exists
AND `normalise(finalText) == normalise(buffered.text)`.
1. iOS sends `sendTranscript(finalText, utteranceId)` — backend stamps
   `seenTranscriptUtterances` and `recentTranscripts` as today.
2. iOS sends `sendEagerCommit(turnId, utteranceId)` — backend
   `handleEagerCommit` mirrors `ask_user_answered` ledger writes per
   D13-v4 code stub above, then calls `pendingAsks.resolve()`.
3. iOS marks the ask consumed using existing helpers:
   `firedAskUserAnsweredToolCallIds.insert(toolCallId)`,
   `inFlightQuestion = nil`, `alertManager.dismissCurrentAlert()`.
4. iOS does NOT call `sendAskUserAnswered`. The legacy stage6Substantive
   path in `appendToTranscriptAndExtract` is short-circuited by the
   `firedAskUserAnsweredToolCallIds` gate (line 2041) once step 3
   completes.

**Case B — diverging final:** `pendingEagerByFluxTurnId[turnId]` exists
AND `normalise(finalText) != normalise(buffered.text)`.
1. iOS sends `sendEagerDiscard(turnId)` — backend just removes the
   buffer entry.
2. iOS sends `sendTranscript(finalText, utteranceId)` + the existing
   paired `sendAskUserAnswered(toolCallId, finalText, utteranceId)` —
   the legacy stage6Substantive path. No new logic needed; same as
   Layer 1 dispatching the final.

**Case C — no-eager EndOfTurn:** `pendingEagerByFluxTurnId[turnId]`
absent (Flux's confidence crossed `eot_threshold` directly without
emitting EagerEndOfTurn first).
1. iOS sends `sendTranscript(finalText, utteranceId)` +
   `sendAskUserAnswered(toolCallId, finalText, utteranceId)` — identical
   to Layer 1 path. **No eager_commit, no eager_discard.**

All three cases share the existing dedupe-ledger contract on the backend
(transcript + ask answer both stamp the ledgers). Case A's eager commit
mirrors that contract via D13-v4. Cases B and C just use the legacy path
verbatim.

For text normalisation comparison (Case A vs B): reuse the same
normalisation function the existing reverse-race guard uses at
`sonnet-stream.js` (sanitisation per Stage 6 invariants). iOS doesn't
need a new normaliser — the comparison is "did the EndOfTurn text equal
the EagerEndOfTurn text, character for character after trim and case-
fold". If close-but-not-equal counts as match for some inspector accent
cases, telemeter the divergence rate; if too high in field, tighten
match.

### D18-v4 (replaces D18-v3) — Reconnect-buffer pairing for eager messages

**Codex rd-3 BLOCKER 4 + Claude N2-v3 fix.** PLAN_v3 D18-v3 only added
the whitelist; v4 extends `reorderPendingForReplay` (iOS
ServerWebSocketService.swift:703-760).

Algorithm extension:

```
group buffered messages by (toolCallId, utteranceId) tuple
  members of a group, in canonical replay order:
    transcript(utteranceId)  [existing]
    eager_intent(turnId, toolCallId, utteranceId)  [NEW]
    eager_commit(turnId) | eager_discard(turnId)  [NEW]
    ask_user_answered(toolCallId, utteranceId)  [existing — only present in Case B/C]
output: groups in arrival order, each group emitted atomically
```

Plus a **D14-v4 backend-side resolution** for the edge case where
`eager_intent` reached backend pre-disconnect, buffer was purged or
session reconnected, then `eager_commit` replays:

`handleEagerCommit` change: if `entry.eagerBuffer.get(turnId)` returns
undefined, **fall back to looking up the `tool_call_id` and `utteranceId`
from a new short-lived `recentEagerIntents` ledger** (TTL 60s, sized
≤32 entries, written by `handleEagerIntent` in addition to the buffer
write). If found, treat the commit as Case A and use the answer text
from the ledger. If the ledger ALSO doesn't have it, log
`eager_commit_orphan` and drop — iOS will have paired a `sendTranscript`
on the same final, which backend's existing pending-asks 45s timeout
will eventually resolve via the fallback path.

### D14-v4 (extends D14-v3) — Session-continuation signal + iOS state reset on hard reconnect

**Codex rd-3 BLOCKER 4 partial + Claude reconnect concern.** PLAN_v3
D14-v3 capability gate prevents NEW sessions from sending eager_*
messages when env-var OFF. Doesn't address mid-session reconnects.

Extension: backend `handleSessionStart` already runs
`pendingAsks.rejectAll('session_reconnected')` on certain reconnect
paths. v4 adds a new field in the `session_ack` response:

```json
{
  "type": "session_ack",
  "status": "ok",
  "session_continuity": "continuous" | "soft_reconnect" | "hard_reconnect"
}
```

- `continuous` — same WS, no break.
- `soft_reconnect` — WS dropped + restored, backend session state intact,
  pendingAsks still alive.
- `hard_reconnect` — backend's `rejectAll('session_reconnected')` was
  called; pendingAsks gone.

iOS handling:
- On `continuous` or `soft_reconnect`: iOS reconnect buffer (D18-v4)
  drains normally. `pendingEagerByFluxTurnId` preserved.
- On `hard_reconnect`: iOS clears `pendingEagerByFluxTurnId` AND
  filters reconnect buffer to drop any `eager_intent` / `eager_commit`
  / `eager_discard` entries (since their backend buffer is gone). Lets
  paired `transcript` + `ask_user_answered` messages through if any
  are still present.

iOS extends `serverDidReceiveSessionAck(status:)` delegate signature
to include the new `sessionContinuity` enum. Defaults to `continuous`
if backend sends `session_ack` without the field (back-compat with
older backends — won't happen post-deploy since the new wire is gated
on capability handshake).

### S6-v4 (replaces S6-v3) — Capability handshake extends existing structure

**Codex rd-3 IMPORTANT 2 fix.** PLAN_v3 S6 invented `supports_eager_intent`
top-level + new `session_capabilities` response. Backend already has
`msg.capabilities` parsing for voice-latency-2026-05-23 capabilities
under `entry.voiceLatency.capabilities`.

v4: extend existing `capabilities` object. iOS sends:

```json
{
  "type": "session_start",
  "protocol_version": "stage6",
  "capabilities": {
    "voice_latency": { ... existing voice-latency fields ... },
    "focused_answer": {
      "supports_eager_intent": true
    }
  }
}
```

Backend responds:

```json
{
  "type": "session_ack",
  "status": "ok",
  "session_continuity": "continuous",
  "server_capabilities": {
    "focused_answer": {
      "eager_intent_enabled": true|false  // gated by VOICE_FOCUSED_EAGER_INTENT_ENABLED env
    }
  }
}
```

iOS `serverDidReceiveSessionAck` delegate signature extended to carry
both `sessionContinuity` and `serverCapabilities` (the latter as a
parsed struct with optional fields per known capability namespace).

### D7-v4 (refines D7-v3) — Keyterm priority bucket implementation

**Codex rd-3 IMPORTANT 1 fix.** Current `KeywordBoostGenerator.generate(from:)`
returns one flat list sorted by boost. There's no "session-critical"
bucket today.

v4 implementation:
- `KeywordBoostGenerator` gains a new public method
  `generateFocusedMerge(focusedEssentials: [String]) -> [(String, Double)]`
  that:
  1. Generates the standard session list (existing behaviour).
  2. Takes `focusedEssentials` as a flat list (e.g. digits + yes/no
     from `FocusedAnswerKeyterms`).
  3. Merges with priority: focusedEssentials first, then session list
     in boost-descending order, deduped.
  4. Caps at 100.
- "Session-critical" isn't a new bucket — it's just "session list
  sorted by boost descending, included only if there's room after
  focused essentials and dedup." The existing boost is the priority
  signal.

S3-v4 calls this on focused-mode entry; cached canonical (un-focused)
list is still kept for restore per D7-v3.

### D21-v4 (NEW) — Backend buffer purge on all terminal paths

**Codex rd-3 IMPORTANT 3 fix.** PLAN_v3 D10-v3 mentioned `purge(olderThanMs)`
but didn't list trigger surfaces. v4 explicit:

`entry.eagerBuffer.delete(turnId)` is called from:
1. `handleEagerCommit` (after lookup) — existing in D13-v4.
2. `handleEagerDiscard` — existing in D13-v4.
3. `pendingAsks.resolve()` callback when `source !== 'eager'` (legacy
   `ask_user_answered` resolution path) — sweeps any eager buffer
   entries that share the same toolCallId. Stale-entry defence.
4. `pendingAsks.rejectAll()` — sweeps all buffer entries for the
   session. Already triggered by `handleSessionStart` reconnect path
   and by `session_terminated`.
5. Periodic timer (per-session, 30s interval) — purges entries older
   than 30s. Defends against the "ask died at backend, but no terminal
   event fired".

LOC budget: ~30 LOC added to existing terminal-event paths +
~20 LOC for the periodic timer.

## IMPORTANT closures (round 3)

| ID | Was | Fix in v4 |
|---|---|---|
| Claude I1-v3 | D9-v3 silent on "no ConfigureSuccess echo within 500ms" | **D9-v4:** treat timeout-without-echo identically to ConfigureFailure (D8-v3 state-clear). Add this single sentence to D9. |
| Claude I2-v3 | ConfigureFailure loop on every ask_user | **D8-v4:** in-session backoff after 3 consecutive ConfigureFailures, escalate to a one-time "Settings → focused-mode disabled this session" yellow-banner. Reset on session restart. |
| Claude I3-v3 | D14 capability gate works for new sessions but not in-flight; ECS rolling deploy semantics implicit | **Rollback section addendum:** explicit statement that ECS service `minimumHealthyPercent` ≥ 100 (verify in `ecs/task-def-backend.json`) is required for the "in-flight stays on old task" guarantee. Add as pre-deploy infrastructure check. |
| Claude I4-v3 | "Eager_* in same queue family" ambiguous | **D13-v4** explicit: eager_intent + eager_discard are inline synchronous (no queue), eager_commit goes through `eagerControlQueue` which is independent of `isExtracting`. Code stub above is authoritative. |
| Claude I5-v3 | reorderPendingForReplay extension is more than whitelist | **D18-v4** explicit pairing algorithm above. |
| Claude I6-v3 | "force WS reconnect via webSocketTask.cancel()" understated | **D19-v4** explicit: use receive() `.failure` branch path with close-code-1000 + reason-string `focused_mode_reset`. Do NOT call `urlSession?.invalidateAndCancel()`. |
| Claude I7-v3 | TL;DR understates Layer 1 alone being partial | **TL;DR v4** rewrote with the explicit "meaningful but partial" framing. |
| Claude I8-v3 | Cost claim conditional on N1-v3 | **D20-v4** closes N1-v3; cost claim now unconditional. |
| Codex rd-3 NIT 1 | D6 doc quote should include omission semantics | **D17-v4** quotes the "omitted parameters retain their current values" rule inline as the driver of D19-v4. |
| Codex rd-3 NIT 2 | D11 can cite Flux state-machine guarantee directly | **D11-v4:** cite Deepgram state docs explicitly — "EndOfTurn matches the immediately preceding EagerEndOfTurn unless TurnResumed intervened." Simplifies the Case A/B branching in D20-v4. |

## NIT closures (round 3)

| ID | Fix |
|---|---|
| Claude NIT-1-v3 | Cost-claim wording softened to "conditional on D20-v4 ledger stamping" → now unconditional after D20-v4. |
| Claude NIT-2-v3 | Q3 cite extended to include Claude rd-1 IMPORTANT. |
| Claude NIT-3-v3 | D8-v3 retry intervals: footnote — chosen as 50/100/200ms (sum ~350ms, fits within the perceptual budget for "Configure round-trip" tail latency on cellular networks). |
| Claude NIT-4-v3 | S9-v4: `typealias FluxTurnIndex = Int`; field name `fluxTurnIndex` on iOS, `flux_turn_index` on wire. |
| Claude NIT-5-v3 | D21-v4 lists all five trigger surfaces explicitly. |

## Slice-by-slice (TF#2 changes only — TF#1 chain S1-S5 unchanged from PLAN_v3)

| Slice | What | LOC | Tests |
|---|---|---|---|
| **S6-v4** | Capability handshake extension (D7-v4 / S6-v4 spec above). Backend adds `focused_answer.eager_intent_enabled` to `session_ack`. iOS reads + caches per-session. **NEW iOS field `serverCapabilities.focusedAnswer.eagerIntentEnabled`.** | ~80 (backend ~40 + iOS ~40) | Unit: handshake echoes flag. Integration: env-var off → echoes false. |
| **S7-v4** | Backend eager_intent buffer module + `recentEagerIntents` 60s ledger (D14-v4 fallback). Includes D21-v4 purge surfaces. | ~150 | Unit: buffer/commit/discard happy paths. Unit: ledger lookup on missing buffer entry. Unit: purge on all 5 surfaces. |
| **S8-v4** | Backend handleEagerCommit with D13-v4 mirror of `ask_user_answered` ledger stamping + reverse-race guard (Claude N1-v3 fix). | ~150 | Integration: eager_commit creates identical ledger state to `ask_user_answered` with same text. Integration: reverse-race guard fires correctly. |
| **S9-v4** | iOS EagerEndOfTurn / TurnResumed parsing (D11-v4 explicit `turn_index` field). | ~80 | Unit: parse Flux JSON → delegate fires with correct `FluxTurnIndex`. |
| **S10-v4** | iOS Layer 2 dispatch implementing D20-v4 three-case routing. Includes Case A (matching), Case B (diverging), Case C (no-eager). | ~200 | Unit: Case A → sends transcript + eager_commit, no ask_user_answered. Case B → sends eager_discard + transcript + ask_user_answered. Case C → sends transcript + ask_user_answered, no eager_*. Unit: text-normalisation match comparison. |
| **S11-v4** | iOS reorderPendingForReplay extension per D18-v4. | ~100 | Unit: paired-group emit. Unit: hard-reconnect filter drops eager_*. |
| **S12-v4** | Layer 1 Configure conditionally includes `eager_eot_threshold=0.4` when Layer 2 enabled (S3-v3 method gets new param). | ~30 | Unit: param flips Configure shape. |
| **S13-v4** | iOS UserDefaults flag + Settings row (per PLAN_v3 S13). Plus `hasEverEnabledLayer2InThisSession` tracking. | ~60 | Unit: flag-false short-circuits S10. Unit: hasEver flag stays true after Layer 2 entry. |
| **S14-v4** | Backend per-turn `eager_state_log` event (per PLAN_v3 S14). | ~40 | Manual CloudWatch verification. |
| **S15-v4 (NEW)** | iOS force-reconnect path (D19-v4). Plus session_ack handling for D14-v4 `session_continuity` field. | ~80 | Unit: force-reconnect triggers receive().failure branch. Unit: hard_reconnect clears pendingEagerByFluxTurnId. |

**TF#2 v4 totals: ~970 LOC (was ~790 in v3). +180 LOC for ledger
stamping + reverse-race guard mirror + force-reconnect path +
recentEagerIntents ledger + session-continuity wire.** Backend split:
~340 LOC. iOS split: ~630 LOC.

## Open questions

**None blocking.** All round-1 / round-2 / round-3 BLOCKERs addressed.
All IMPORTANTs and NITs closed.

## Sections unchanged from PLAN_v3

For convenience: Validation strategy (PLAN_v3 line 175-200), Rollback
story (line 202-220 — extended slightly per Claude I3-v3 ECS note),
Resolved decisions table (Q1-Q9), Costs (line 230-245), Composition
table (line 248-260, updated to reference D20-v4 cases A/B/C).
