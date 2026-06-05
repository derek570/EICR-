NOT CONVERGED

Round 5 adversarial review of `PLAN_v5.md`.

## Verdict

PLAN_v5 closes the round-4 backend race shape. D20-v5's reversed wire order is correct against the current `handleTranscript` path, and D13-v5's shared helper direction fixes the ledger-shape/timing bug from v4.

There is still one remaining BLOCKER in D19-v5: the force-reconnect proof relies on `didCloseWith` receiving the locally requested `.goingAway` close code. The Apple API docs do not guarantee that. The callback reports the server's close frame, while `cancel(with:reason:)` sends the local close frame. This is a small mechanical fix, but the current plan has not made the reconnect path verifiably reliable.

## BLOCKER 1: D19-v5 still relies on unproven close-code echo semantics

`PLAN_v5` says:

1. `webSocketTask?.cancel(with: .goingAway, reason: Data("focused_mode_reset".utf8))`
2. `didCloseWith` fires with `closeCode == .goingAway`
3. Existing gate `shouldReconnect && closeCode != .normalClosure` schedules reconnect

The current source does confirm the gate:

- `CertMateUnified/Sources/Services/DeepgramService.swift:1432-1453` sets `isListening = false`, clears `webSocketTask`, and calls `scheduleReconnect()` only when `closeCode != .normalClosure`.
- `.goingAway` would pass that gate if it is the close code delivered to the delegate.

The missing proof is the callback value. Apple's `URLSessionWebSocketTask.cancel(with:reason:)` documentation says the method sends a close frame with the supplied code. Apple's `URLSessionWebSocketDelegate.didCloseWith` documentation says the delegate is told when the task received a close frame from the server endpoint, with the code from that server frame. That means the plan proves the client sends 1001, but not that `didCloseWith` receives 1001. Deepgram will likely echo or reciprocate with the same code, but the current plan needs a reconnect mechanism that does not depend on that remote behavior.

Why this matters: if the server responds with `.normalClosure`, and if the receive failure callback does not schedule first, the current delegate branch lands in `connectionState = .disconnected` and does not reconnect. `receiveNextMessage()` may save this in practice because its `.failure` branch schedules when `shouldReconnect` is true (`DeepgramService.swift:825-830`), but D19-v5 explicitly relies on `didCloseWith`; it should not need a timing race between callbacks.

Required fix: make the force-reconnect path proactive or reason-aware. For example:

- Set a private `shouldForceFocusedReset` / `forceReconnectPending` flag.
- Call `cancel(with: .goingAway, reason: ...)`.
- Immediately call `scheduleReconnect()` on the service queue, or update `didCloseWith` to schedule when `reason == "focused_mode_reset"` regardless of close code.
- Keep `isReconnectScheduled` as the duplicate-callback guard.

With that tweak, D19 becomes verifiably correct from local source alone.

References used:

- Apple `cancel(with:reason:)`: https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/cancel%28with%3Areason%3A%29
- Apple `URLSessionWebSocketDelegate.didCloseWith`: https://developer.apple.com/documentation/foundation/urlsessionwebsocketdelegate/urlsession%28_%3Awebsockettask%3Adidclosewith%3Areason%3A%29

## Closure Check

Codex BLOCKER 1, `handleEagerCommit` does not mirror `ask_user_answered`: structurally closed. D13-v5 now requires a shared `commitAskAnswer` helper and correctly gates `consumedAskUtterances` / `recentAskAnswers` writes on `resolve() === true`, with the current row shape `{ normalisedText, expiresAt, toolCallId }` and the existing caps. This matches the important mutations in `sonnet-stream.js:1451-1888`.

Codex BLOCKER 2, force-reconnect via close-code 1000 incompatible: partly closed. Switching from `.normalClosure` to `.goingAway` fixes the specific gate incompatibility, but see BLOCKER 1 above. The plan still needs a source-verifiable reconnect trigger.

Codex IMPORTANT 1, `soft_reconnect` does not exist: closed. Current `handleSessionStart` has fresh `status: "started"` at `sonnet-stream.js:2695-2697` and reconnect `status: "reconnected"` at `sonnet-stream.js:2229-2234`, and every reconnect rejects pending asks at `sonnet-stream.js:2181-2187`. Binary `continuous | reconnected` is the right contract.

Codex IMPORTANT 3, D21 callback hook does not exist: closed in direction. D21-v5 uses call-site sweeps instead of inventing a registry callback. `stage6-pending-asks-registry.js:88-99` has only synchronous `resolve()` and no subscriber API, so call-site wrapping is the right fit.

## New Scrutiny Results

### 1. D20-v5 wire-order reversal

Verified correct against current `handleTranscript`.

Current ordering:

- `handleTranscript` starts at `sonnet-stream.js:3069`.
- `consumedAskUtterances.has(msg.utterance_id)` is checked at `sonnet-stream.js:3112-3123`.
- The content-anchor fallback is next at `sonnet-stream.js:3141-3164`.
- `classifyOvertake` is much later at `sonnet-stream.js:3555-3557`.
- Shadow-harness fall-through is after the classifier path.

So if backend receives `eager_commit` message A first and `commitAskAnswer` stamps `consumedAskUtterances` before returning, message B's transcript hits the fast path before `classifyOvertake`, overtake resolution, or shadow extraction.

Caveat for implementation: the eager commit path must not contain an `await` before the ledger stamp. `pendingAsks.resolve()` is synchronous (`stage6-pending-asks-registry.js:88-99`), and Promise wake-up happens after the current stack, so stamping immediately after `resolve()` is safe.

### 2. D13-v5 SKIP rules

Reverse-race guard skip for `source === "eager"` is safe only under D20-v5 Case A wire order. The plan states that; add a regression test that sends `eager_commit` then `transcript` and asserts the transcript does not reach `classifyOvertake` or the shadow harness.

The `classifyOvertake` skip is safe, but the rationale should be tightened. Deepgram's Flux state docs say `EndOfTurn` matches the immediately preceding `EagerEndOfTurn`; if the transcript changes after eager, `TurnResumed` occurs before the final. See https://developers.deepgram.com/docs/flux/state and https://developers.deepgram.com/docs/flux/voice-agent-eager-eot.

So the safety argument is:

- If no `TurnResumed` occurs and final text normalises equal to eager text, iOS sends `eager_commit`.
- If a divergent final occurs, iOS Case B sends `eager_discard` plus legacy transcript / `ask_user_answered`.
- Therefore `source === "eager"` is only used when the final still agrees with the eager answer.

The current plan wording says eager fired before the user could say something divergent. That is not the right reason; the user can continue after eager. The state-machine plus iOS Case B branching is the reason this is safe.

### 3. D19-v5 close code 1001

Not fully verified. See BLOCKER 1.

The local reconnect gate is compatible with `.goingAway`, but the plan should not rely on server close-code echo. Add proactive scheduling or reason-aware scheduling.

### 4. D14-v5 `session_continuity`

Direction is correct, but the plan should pin the exact source edits:

- In the reconnect branch, change the `session_ack` at `sonnet-stream.js:2229-2234` to preserve `status: "reconnected"` and add `session_continuity: "reconnected"`.
- In the fresh-start branch, change the `session_ack` at `sonnet-stream.js:2695-2697` to preserve `status: "started"` and add `session_continuity: "continuous"`.

Do not implement the illustrative JSON's `status: "ok"` literally; existing iOS checks `status == "started" || status == "reconnected"` in `DeepgramRecordingViewModel.swift:7053-7057`. Adding a new field is back-compatible, changing `status` is not.

### 5. D21-v5 `deleteByToolCallId`

Acceptable. The buffer is keyed by Flux turn id (`PLAN_v3` D11/S7), so `deleteByToolCallId(toolCallId)` has to scan entries. That is fine for the intended size: the related recent-intent ledger is bounded at <=32 in v4, and pending eager entries should be smaller in normal STA-01 operation. The plan should acknowledge this is intentionally O(n), not O(1).

### 6. D17-v5 lifecycle reset

Resetting `hasEverEnabledLayer2InThisSession` on every `DeepgramService._connect()` is the right reset point for the Deepgram-side flag.

`_connect()` starts at `DeepgramService.swift:360`, calls `_disconnectImmediate()` at `:367`, builds a fresh URL at `:379-384`, creates a new `URLSession` at `:396-407`, and resumes a new task at `:408`. A fresh WS has no retained mid-stream `eager_eot_threshold`, so the flag should be false for both cold start and warm transport reconnect. Force-reconnect from D19 also lands here, so the restore-Configure omit path becomes safe again.

### 7. NIT-5-v4 promise-chain serialization

Still ambiguous enough to fix in prose. The correct pattern is:

```js
entry.eagerControlChain = entry.eagerControlChain
  .then(() => handlerBody())
  .catch((err) => { logger.warn(...); });
```

Handlers may await the resulting chain if they need to surface completion, but they must not do `await entry.eagerControlChain; entry.eagerControlChain = handlerBody()`. Because `ws.on('message', async ...)` is not awaited by the EventEmitter, multiple eager messages could all pass the same already-resolved chain and then race if implemented that way.

### 8. Helper extraction LOC realism

The ask handler spans roughly `sonnet-stream.js:1451-1900` physically, but a large fraction is explanatory comments. The executable logic to factor is closer to the plan's estimate, though I would budget S8 as ~180-220 changed lines rather than "~100 LOC helper + ~30 LOC handleEagerCommit" if comments/tests are kept at the current codebase's standard. This is not a convergence blocker.

## Residual Non-Blockers

- D14-v5 should explicitly say "preserve existing `status`, add `session_continuity`".
- D13-v5 should reword the eager `classifyOvertake` skip rationale to cite the Flux state-machine guarantee plus iOS Case B, not "before the user could have said something divergent".
- D21-v5 should state `deleteByToolCallId` is O(n) over a bounded buffer.
- NIT-5 should replace "handlers await + reassign" with the exact `.then(() => handlerBody())` chain pattern.

## Convergence

TF#2 is one small D19 correction away from convergence. The architecture and D20/D13 race closure now hold against the current backend source. After the force-reconnect path schedules reconnect independently of remote close-code echo, I would expect the next review to converge.
