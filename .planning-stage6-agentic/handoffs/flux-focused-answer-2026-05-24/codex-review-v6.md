CONVERGED

Round 6 adversarial verification of `PLAN_v6.md`.

## Verdict

PLAN_v6 closes the round-5 D19 blocker. The force-focused reset path no longer depends on `URLSessionWebSocketDelegate.didCloseWith` echoing the locally sent `.goingAway` close code; it schedules reconnect locally immediately after the close request.

No new BLOCKERs found.

There are two non-blocking implementation cautions:

- `didCloseWith(.normalClosure)` can still transiently set `connectionState = .disconnected` while the proactively scheduled reconnect is pending. This does not cancel the reconnect, but it can briefly show the wrong UI status.
- D21-v6's proposed comment says `eagerBuffer` is bounded `<=32` by `RECENT_EAGER_INTENT_CAP`. That cap applies to `recentEagerIntents`, not to the main `eagerBuffer` specified in PLAN_v3 S7. Either soften the comment or add a real hard cap.

## D19-v6 proactive reconnect

Verified against `CertMateUnified/Sources/Services/DeepgramService.swift`.

`scheduleReconnect()` starts with:

```swift
guard shouldReconnect, !isReconnectScheduled else { return }
isReconnectScheduled = true
```

Then it queues the actual scheduling work on the same serial queue, sets `connectionState = .reconnecting`, increments `reconnectAttempt`, and installs a delayed `DispatchWorkItem`. The work item later resets `isReconnectScheduled = false`, fetches a fresh key, and calls `_connect(apiKey:keywords:)`, which first cancels any pending reconnect and calls `_disconnectImmediate()` before building the fresh URL/session/task.

### Mid-close call safety

Calling `scheduleReconnect()` while `webSocketTask` is mid-close is acceptable with the current implementation. `scheduleReconnect()` does not require `webSocketTask == nil`; it only schedules a delayed reconnect. The old socket is cleaned up either by `didCloseWith` setting `webSocketTask = nil`, or by the later `_connect()` path calling `_disconnectImmediate()`.

### Duplicate scheduling

For the normal D19-v6 timing, yes: `isReconnectScheduled` prevents double scheduling when `didCloseWith` or `receiveNextMessage` also tries to schedule reconnect before the delayed work item fires.

There is a pre-existing narrow window after the work item fires, because it resets `isReconnectScheduled = false` before the async fresh-key fetch completes. A very late old-session callback with a reconnect-eligible close/error during that key-fetch window could schedule a second reconnect. That window already exists for any reconnect initiated by `receiveNextMessage` followed by a late delegate callback; D19-v6 does not introduce it. Once `_connect()` swaps `urlSession`, the existing `session === self.urlSession` guard drops stale old-session callbacks.

### `.normalClosure` state overwrite

The exact race shape in the prompt is partly real but not fatal:

- `scheduleReconnect()` does not build the new URL/session immediately; it schedules delayed reconnect work.
- If `didCloseWith` later reports `.normalClosure`, the current delegate branch falls into `connectionState = .disconnected`.
- That does not clear `shouldReconnect`, cancel `reconnectWorkItem`, or reset `isReconnectScheduled`, so the proactive reconnect still executes.

So this is not a correctness blocker for reconnect. It is a transient state/reporting issue. If the implementer wants cleaner UI state, `didCloseWith` can avoid setting `.disconnected` when `isReconnectScheduled` or `pendingForceReconnect` is true.

One cleanup note: the v6 snippet sets `pendingForceReconnect = true` but does not show any reader/clearer. If the flag is only documentary, drop it. If it is kept, use it to suppress the transient `.disconnected` close callback and clear it on `_connect()` / successful `didOpenWithProtocol`.

## D14-v6 dual emit

Verified against `src/extraction/sonnet-stream.js`.

Reconnect branch currently emits:

```js
{
  type: 'session_ack',
  status: 'reconnected',
  sessionId: existing.rehydrateSessionId || null,
}
```

Adding `session_continuity: 'reconnected'` here is structurally clean and preserves the existing `status` contract.

Fresh-start branch currently emits a one-line object:

```js
{ type: 'session_ack', status: 'started', sessionId: rehydrateSessionId }
```

Expanding that to include `session_continuity: 'continuous'` is also clean. This directly addresses the round-5 concern: iOS currently checks `status == "started" || status == "reconnected"`, so preserving `status` and adding a field is the right back-compatible change.

## D13-v6 safety comment

The safety argument is now the right one: the eager skip is justified by Flux's state-machine guarantee plus iOS Case B, not by assuming the user cannot continue speaking after eager.

Pin this in the implementation comment/test:

- Deepgram state-machine doc: https://developers.deepgram.com/docs/flux/state
- Fetched: 2026-05-25
- Relevant guarantee: the final `EndOfTurn` matches the immediately preceding `EagerEndOfTurn`; if transcript changes after eager, `TurnResumed` occurs first.
- Supporting eager-EOT doc: https://developers.deepgram.com/docs/flux/voice-agent-eager-eot
- Fetched: 2026-05-25

With D20-v6 wire order and iOS Case B (`TurnResumed` / divergent final sends `eager_discard` plus legacy `ask_user_answered`), `handleEagerCommit` only runs for the same-answer case.

## D21-v6 cap check

PLAN_v6's O(n) conclusion is acceptable, but the proposed comment is not exactly true.

PLAN_v3 S7 defines the eager-intent buffer as a `Map` keyed by `fluxTurnId` with `bufferIntent`, `commit`, `discard`, and `purge(olderThanMs)`. It does not specify a hard `<=32` cap for the main `eagerBuffer`.

PLAN_v4 later adds a separate `recentEagerIntents` fallback ledger with TTL 60s and size `<=32`. That cap applies to the fallback ledger, not automatically to `eagerBuffer`.

Suggested corrected comment:

```js
// O(n) scan: buffer is keyed by fluxTurnId (per D11), so toolCallId lookup
// requires iteration. The main eagerBuffer is time-bounded by commit/discard,
// reconnect clears, and the 30s purge timer; recentEagerIntents has its own
// RECENT_EAGER_INTENT_CAP. This call site is ask resolution, not the audio
// hot path, so O(n) is acceptable. Add an inverted index only if profiling
// shows it on the per-turn budget.
```

If the implementation wants the stronger `<=32` statement, add an explicit `EAGER_BUFFER_CAP` to S7's buffer module and test eviction. I do not think that is required for convergence.

## Round-5 IMPORTANT closure

- D14 wording: addressed. `status` is preserved; `session_continuity` is additive.
- D13 rationale: addressed. Add the fetched doc date above in the final code comment/test note.
- D21 O(n): addressed in direction, but the `<=32` wording needs the correction above.
- Promise-chain serialization: addressed. The v6 `.then(() => handlerBody()).catch(...)` pattern is the correct one for same-tick handler serialization.

## New issues

No new blockers introduced by v6.

The `pendingForceReconnect` flag and transient `.disconnected` state are polish items. The D21 cap statement is a documentation precision issue. None changes the round-5 blocker closure: proactive local `scheduleReconnect()` makes D19 source-verifiable without relying on remote close-code behavior.
