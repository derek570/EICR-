NOT CONVERGED

Round 4 adversarial review of `PLAN_v4.md`.

## Verdict

PLAN_v4 closes the original D13 deadlock shape: `pendingAsks.resolve()` is synchronous in `stage6-pending-asks-registry.js` (`clearTimeout` -> `asks.delete` -> `entry.resolve(...)` -> return bool; no `await`). A separate eager-control path can safely call it inline while the tool loop is awaiting the pending ask.

However, TF#2 is still not converged. I found 2 BLOCKERs and 3 IMPORTANT corrections.

## BLOCKER 1: D13/D20 eager_commit still does not mirror `ask_user_answered`; the pseudo-code stamps the ledgers incorrectly

`PLAN_v4` says `handleEagerCommit` mirrors `ask_user_answered` ledger writes, but the pseudo-code only mirrors a subset and gets the current ledger contract wrong.

Current `ask_user_answered` state mutations in `src/extraction/sonnet-stream.js`:

- Drops if no active session, malformed payload, `srv-` tool id, or `entry.isStopping`.
- Computes reverse-race status from `seenTranscriptUtterances` and `recentTranscripts`.
- Mutates `entry.recentTranscripts` by evicting expired rows, and `splice()` removes the matched content row on reverse-race hit.
- Builds `resolvePayload`; on normal path sanitises via `sanitiseUserText`.
- Runs the shape-aware `classifyOvertake` guard for expected answer shape.
- Runs the imperative / bulk-scope "new command" guard. On hit, it calls `pendingAsks.resolve(... user_moved_on ...)`, then fire-and-forget re-injects a synthetic transcript through `handleTranscript(...)`.
- Calls `entry.pendingAsks.resolve(...)` and stores the boolean.
- Only if `resolved && !alreadySeenAsTranscript`, adds `consumed_utterance_id` to `entry.consumedAskUtterances`.
- Caps `consumedAskUtterances` to `CONSUMED_UTTERANCE_CAP`.
- Logs unresolved/malformed/legacy-anchor cases.
- Only if `resolved && !alreadySeenAsTranscript`, pushes to `entry.recentAskAnswers`.
- The `recentAskAnswers` row shape is `{ normalisedText, expiresAt, toolCallId }`.
- Caps `recentAskAnswers` to `RECENT_ASK_ANSWER_CAP`.

D13-v4 pseudo-code does this instead:

```js
entry.recentAskAnswers.push({normalisedText: normalise(buffered.answer), at: Date.now()});
entry.consumedAskUtterances.add(buffered.utteranceId);
entry.pendingAsks.resolve(buffered.toolCallId, {answer: buffered.answer, source: 'eager'});
```

That is not equivalent:

- It pushes `recentAskAnswers` before knowing whether `resolve()` succeeded.
- It uses the wrong row shape (`at` instead of `expiresAt` + missing `toolCallId`), so `handleTranscript`'s `expiresAt > nowTs` filter will discard the anchor.
- It stamps `consumedAskUtterances` before knowing whether the ask resolved. The current handler deliberately gates this on `resolved === true` to avoid suppressing a legitimate transcript after an unknown/stale tool id.
- It does not cap either ledger.
- It does not sanitise the eager answer before resolving.
- It bypasses the current ask-channel new-command guard, so a user who answers an in-flight prompt with a new command can be incorrectly burned as an ask answer instead of `user_moved_on` + transcript reinjection.

This is a correctness regression, not just pseudo-code detail. Required fix: factor the existing `ask_user_answered` resolution semantics into a shared helper, or specify `handleEagerCommit` as calling the same helper with `{ tool_call_id, user_text, consumed_utterance_id, source: 'eager' }`. Ledger stamping must happen only after a successful resolve, with the existing row shapes/caps, unless the plan explicitly proves a different pre-resolve stamp is safe and rolls it back on `resolve() === false`.

## BLOCKER 2: D19-v4 force-reconnect is specified against the wrong iOS callback path

Deepgram Configure docs do support the D17 premise. Exact line from https://developers.deepgram.com/docs/flux/configure:

> "All parameters are optional in a Configure message. Omitted parameters retain their current values."

The Apple API also has the required close-code + reason method: `URLSessionWebSocketTask.cancel(with:reason:)`.

But the PLAN_v4 mechanism is not structurally sound against the current `DeepgramService.swift`:

- Current receive loop schedules reconnect only in `receive()` `.failure` when `shouldReconnect` is true (`DeepgramService.swift:825-830`).
- The close code and reason are exposed to `urlSession(_:webSocketTask:didCloseWith:reason:)`, not to the `receive()` failure callback.
- Current `didCloseWith` explicitly does **not** reconnect on `.normalClosure`: `if self.shouldReconnect && closeCode != .normalClosure { self.scheduleReconnect() } else { self.connectionState = .disconnected }`.
- D19 says to close with code `1000` / `.normalClosure` and special reason `"focused_mode_reset"`, then "have the receive() callback recognize the close code". That callback does not receive the close code. The current delegate path will likely classify this as disconnected, not reconnecting.

Required fix: specify the force-reconnect path in terms of the actual delegate surface. For example: call `webSocketTask?.cancel(with: .normalClosure, reason: Data("focused_mode_reset"...))` without `urlSession?.invalidateAndCancel()`, and update `didCloseWith` to schedule reconnect when `shouldReconnect && closeCode == .normalClosure && reason == focused_mode_reset`. Alternatively use a non-normal close code and prove Deepgram treats it safely. As written, the D17 restore-after-Layer-2 closure can leave iOS disconnected instead of reconnecting.

## Closure Check

Round-3 Codex BLOCKER 1, D13 deadlock: closed in architecture. `pendingAsks.resolve()` is synchronous and the separate eager-control path avoids the `isExtracting` circular wait. Reopened only for incorrect handler symmetry above.

Round-3 Codex BLOCKER 2, clearing `eager_eot_threshold`: partially closed. D17 correctly cites Configure omission semantics and force-reconnect is the right class of fix, but D19's iOS reconnect mechanism is wrong as specified. See BLOCKER 2.

Round-3 Codex BLOCKER 3, final `ask_user_answered` suppression: closed in iOS routing shape. D20 Case A explicitly sets `firedAskUserAnsweredToolCallIds`, clears `inFlightQuestion`, dismisses the alert, and suppresses `sendAskUserAnswered`.

Round-3 Codex BLOCKER 4, reconnect semantics: improved but not fully tight. D14/D18 define hard-reconnect filtering and pairing, but see IMPORTANT 1 and IMPORTANT 2 below.

Round-3 Codex IMPORTANT 1, D7 bucket: closed. `generateFocusedMerge(focusedEssentials:)` is an honest new API and no longer pretends a production "session-critical" bucket exists.

Round-3 Codex IMPORTANT 2, S6 handshake: closed in schema direction. Existing parsing accepts a nested `capabilities` object without rejecting unknown namespaces; adding `focused_answer` under that object is the right extension. New parsing is still needed because `parseVoiceLatencyCapabilities()` currently only reads `capabilities.voice_latency`.

Round-3 Codex IMPORTANT 3, D10 purge surfaces: not fully closed. See IMPORTANT 3.

## IMPORTANT 1: D14-v4 `soft_reconnect` is new backend behavior, not something `handleSessionStart` can detect today

Today `handleSessionStart` has only:

- fresh session -> sends `session_ack status: "started"`;
- active session reconnect -> unconditionally `existing.pendingAsks.rejectAll('session_reconnected')`, clears dedupe ledgers, then sends `status: "reconnected"`;
- `session_resume` rehydrate path -> also `rejectAll('session_reconnected')`.

There is no current backend state that preserves `pendingAsks` across WS rebind, so `soft_reconnect` is not detectable today. It is new behavior and must either be budgeted/tested, or removed from the contract with all reconnects classified as `hard_reconnect` under the current invariant.

## IMPORTANT 2: D18-v4 pairing needs one more concrete keying rule

The existing `reorderPendingForReplay` pairs `transcript(X)` + `ask_user_answered(X)` by `consumed_utterance_id`. The proposed v4 group key is `(toolCallId, utteranceId)`, but `eager_commit(turnId)` / `eager_discard(turnId)` as specified do not themselves carry that tuple.

This is implementable, but the plan should state the actual keying rule:

- build `turnId -> (toolCallId, utteranceId)` from buffered `eager_intent` and/or iOS `pendingEagerByFluxTurnId`;
- if a commit/discard has no local tuple, keep FIFO order and rely on backend `recentEagerIntents`;
- preserve the current transcript-before-answer invariant for Case B/C.

Without that, the algorithm is underspecified for `eager_commit` without paired buffered `eager_intent`.

## IMPORTANT 3: D21-v4 purge surface 3 names a callback hook that does not exist

`stage6-pending-asks-registry.js` currently exposes `resolve(toolCallId, outcome)` and `rejectAll(reason)`, but no callback/subscriber hook. Surface 3 says:

> `pendingAsks.resolve()` callback when `source !== 'eager'`

That callback does not exist today. This requires new registry API or explicit wrapper logic at every resolve call site. The plan should say which one, because `resolve()` is called from several paths (`ask_user_answered`, transcript overtake answer, validation error, new-command/user_moved_on, timeouts via dispatcher, etc.), and D21 says "all terminal paths".

## LOC Budget

The table arithmetic is honest: `80 + 150 + 150 + 80 + 200 + 100 + 30 + 60 + 40 + 80 = 970`.

The estimate is probably low if D14 `soft_reconnect` is real backend behavior and if D13 is fixed by extracting a shared ask-answer resolution helper instead of duplicating the handler. If all reconnects are treated as hard reconnects and eager commit reuses a helper, the budget is still plausible.

## New Issues Introduced by v4

- The D13 pseudo-code changed the shape/timing of the dedupe ledger writes relative to the existing handler. This is the most serious new issue.
- The D19 force-reconnect prose mixes up "avoid `_disconnectImmediate()` teardown" with "do not call `cancel(with:)`". The low-level API for sending a close frame is still `cancel(with:reason:)`; the important part is not calling the existing teardown path that invalidates the URLSession.
- D20 Case A says iOS does not need a new normaliser and can compare trim/case-folded strings. Backend dedupe uses `normaliseForAskMatch()` (lowercase, strip non-alphanumerics, collapse whitespace). If iOS uses weaker normalisation, near-identical punctuation differences will go to Case B more often. Not a blocker, but the plan should either accept that as telemetry or define a shared exact rule.
