# Round 3 adversarial review — PLAN_v3

**BLOCKERs found. PLAN_v3 is not converged.**

## Round-2 closure check

Closed from Codex v2:

- Configure field names/nesting: closed. Deepgram's current Configure docs specify `{"type":"Configure","thresholds":{"eot_threshold":...,"eager_eot_threshold":...,"eot_timeout_ms":...}}`, with thresholds nested under `thresholds`, `eager_eot_threshold <= eot_threshold`, and keyterms capped at 100. See https://developers.deepgram.com/docs/flux/configure.
- iOS-side `amend_ask_user_answered` against nonexistent `pendingAsks.history`: closed by removal. D10-v3 no longer tries to amend a resolved ask.
- Auto-resolved writes before amend: closed by D10-v3 in the non-reconnect/non-queue-deadlock path. The eager text is buffered and does not call `pendingAsks.resolve()` until commit.
- `amend_ack.accepted=false` rollback impossibility: closed in shape by D14-v3's pre-flight capability gate, but re-opened below for reconnect/task-death and session_ack schema issues.
- Repeated eager/final idempotency with a single `pendingEagerToolCallId`: partially closed by D11-v3's per-`fluxTurnId` map, but S10 still fails to say how the existing final transcript path is suppressed on commit. See BLOCKER 3.
- Stacked asks: partially closed by per-Flux-turn binding if Flux `turn_index` is actually threaded through. Deepgram docs do show `turn_index` on `EagerEndOfTurn`, `TurnResumed`, and `EndOfTurn`. See https://developers.deepgram.com/docs/flux/state.

Closed / addressed from Codex v2 IMPORTANT:

- Layer 1 latency claim: closed. D16-v3 now states median ~1500ms and removes the old 700ms guarantee.
- iOS reconnect buffering for new eager messages: S11 mentions it, but the backend reconnect path makes the replay ineffective. See BLOCKER 4.
- TurnResumed `answer:nil` ambiguity: closed by replacing amend with discard.

Closed from Claude v2:

- B1/B2 amend lookup/history infeasible: closed by D10-v3 architecture.
- B3 ConfigureFailure wrong-state lie: closed for entry failure by D8-v3.
- B4 two-finals race: mostly closed by Deepgram's current state contract: docs say `EndOfTurn` matches the immediately preceding `EagerEndOfTurn`, and a changed transcript must emit `TurnResumed` first. D11/S10 also key by `turn_index`.
- B6 flag in-flight behavior: addressed by D12-v3.
- I1/I4 Configure shape + success echo: closed by D6/D9.
- I2 latency arithmetic: closed by D16/D17.
- I7 restore Configure failure: addressed by D8-v3 retry/reconnect, but restore success can still leave eager enabled. See BLOCKER 2.
- I8 telemetry path: addressed by D15-v3.
- I9 extra Sonnet round from amend: closed by removing amend, assuming BLOCKER 3 is fixed.

## BLOCKER

### 1. D13-v3 deadlocks `eager_commit` if it really reuses `isExtracting` / `pendingTranscripts`

D13-v3 says to treat `eager_intent`, `eager_commit`, and `eager_discard` as "members of the same queue family as transcripts" drained only while `isExtracting=false`.

That is incompatible with the current ask lifecycle. In `stage6-dispatcher-ask.js`, `ask_user` registers `pendingAsks` and then awaits the promise until `pendingAsks.resolve()` fires. While that tool loop is blocked, `sonnet-stream.js` is still inside `handleTranscript()` with `entry.isExtracting = true`. This is exactly why today's `ask_user_answered` handler bypasses the transcript queue and calls `entry.pendingAsks.resolve(...)` directly.

If `eager_commit` is queued behind `entry.isExtracting`, the commit cannot call `pendingAsks.resolve()` until `handleTranscript()` finishes. But `handleTranscript()` cannot finish until the pending ask resolves. The result is a circular wait until `ASK_USER_TIMEOUT_MS` fires (`45000` ms in `stage6-dispatcher-ask.js`), at which point the ask resolves as `timeout` and the buffered eager answer is stale.

This also answers the specific timeout question: the timeout is not 1-2s; it is currently 45s. But with D13-v3's queue placement, the timeout still wins because the commit is blocked behind the turn it must unblock.

Required fix: eager control messages cannot use the transcript `isExtracting` gate. They need a separate per-session command queue that allows the one unblock operation (`commit` / normal `ask_user_answered`) to run while a transcript turn is awaiting `pendingAsks`, while still serialising buffer mutation against other eager messages.

### 2. D17-v3 cannot disable `eager_eot_threshold` by omitting it once Layer 2 has enabled it

Deepgram's Configure docs are explicit:

- "All parameters are optional in a Configure message. Omitted parameters retain their current values."
- The Exclusion vs Clearing table says omitting a threshold property means "No change to other thresholds."
- The docs define clearing behavior for keyterms and language hints, but not for thresholds.

Source: https://developers.deepgram.com/docs/flux/configure.

D17-v3 is safe for TF#1 only because the initial Flux URL currently has no `eager_eot_threshold`. Sending a Layer-1 Configure without `eager_eot_threshold` keeps eager disabled in that initial state.

It is not safe after TF#2. Once S12 sends a Configure with `eager_eot_threshold=0.4`, a later Layer-1/restore Configure that omits `eager_eot_threshold` does not clear it. Flux keeps eager mode enabled. That breaks:

- D12-v3 Layer 2 toggle-off: iOS may stop dispatching eager messages, but Flux still emits `EagerEndOfTurn` / `TurnResumed`.
- D17-v3's "Layer 1 Configure omits eager_eot_threshold" guarantee after any prior Layer 2 entry.
- Restore-to-default semantics after focused-mode exit. A successful restore Configure can still leave eager mode active.

Required fix: define a documented way to clear eager threshold. If Deepgram has no threshold-clear control, restore/toggle-off must force a Flux reconnect, not a Configure omission.

### 3. S10 does not explicitly suppress the existing final `ask_user_answered` path in the commit case

The current iOS final path in `DeepgramRecordingViewModel.appendToTranscriptAndExtract()` does all of this when `inFlightQuestion?.toolCallId` is present:

1. Inserts the tool id into `firedAskUserAnsweredToolCallIds`.
2. Clears `inFlightQuestion`.
3. Sends `transcript` first.
4. Sends `ask_user_answered` second with the same utterance id.
5. Dismisses the stage6 alert.

PLAN_v3 S10 says matching `EndOfTurn` sends `eager_commit`; it does not say that this existing final handler is bypassed, or that `inFlightQuestion` / `firedAskUserAnsweredToolCallIds` are updated before `appendToTranscriptAndExtract()` can send the normal `ask_user_answered`.

If the existing handler also runs, the commit case becomes:

- `eager_commit` resolves `pendingAsks` with buffered eager text, then
- final path sends normal `ask_user_answered` for the same tool id, producing duplicate resolve / unresolved logs.

If the final path's `transcript` is still sent before `eager_commit`, the backend can also route the transcript through `classifyOvertake` while the ask is still pending, resolving or rejecting the ask before the commit arrives.

This re-opens the cost/correctness claim. "No extra Sonnet rounds in commit case" is only true if the S10 commit branch owns the final event and explicitly prevents the current final transcript-to-ask route from firing. The plan needs to state the exact final-event routing and state mutations.

### 4. S11/D14 miss backend reconnect semantics: buffered eager messages replay after `pendingAsks` has already been rejected

S11 adds iOS reconnect buffering for `eager_intent`, `eager_commit`, and `eager_discard`. That is necessary but not sufficient.

On backend reconnect, `handleSessionStart()` finds the existing session and unconditionally runs:

```js
existing.pendingAsks.rejectAll('session_reconnected');
```

It also clears the ask/transcript dedupe ledgers before sending `session_ack`. iOS flushes buffered messages only after `session_ack`. So the replay order in a mid-ask reconnect is:

1. Backend rejects the pending ask as `session_reconnected`.
2. Backend acks reconnect.
3. iOS flushes buffered `eager_intent` / `eager_commit`.
4. There is no pending ask left to resolve.

For an ECS task death, the in-memory eager buffer disappears entirely. New task/session startup has no buffered eager tuple and no original pending ask. Replaying `eager_commit` cannot reconstruct the answer. This is not "no mid-session corruption"; it is at minimum mid-session answer loss, and depending on the surrounding tool loop, it can produce a re-ask/default timeout path.

This also means D14's rollback story is incomplete. The handshake gate prevents new sessions from sending eager messages, but it does not make in-flight buffered eager state durable across reconnect, rebind, or task termination. PLAN_v3 must define one of:

- eager messages are not replayed across reconnect; iOS falls back to sending normal `ask_user_answered` on final if reconnect happened, or
- backend preserves pending asks + eager buffer across reconnect instead of `rejectAll`, or
- backend makes `eager_commit` self-sufficient enough to resolve/recreate the pending ask safely.

Without one of those, the mobile reconnect case remains broken.

## IMPORTANT

### 1. D7-v3's "session-critical" bucket does not exist in current `KeywordBoostGenerator`

`KeywordBoostGenerator.generate(from:)` returns one flat list of `(String, Double)`, deduped case-insensitively, sorted by boost descending, capped at 100. It does not return `session-critical` versus `session-other`.

The plan's proposed bucket is also not available at the current call site. `DeepgramRecordingViewModel` currently calls:

```swift
let keywords = KeywordBoostGenerator.generate(from: nil)
```

So manufacturer / OCPD types / RCD ratings from `FuseboardAnalysis` are not in the current session list at all. There is a test-only `criticalKeyterms` set in `DeepgramServiceTests`, but it is not production API and it does not include the "top 30 board-specific terms" concept from D7-v3.

The 100-cap part is closed, but the priority-merge plan requires new production code to either:

- expose buckets from `KeywordBoostGenerator`, or
- define criticality from the existing flat sorted list, or
- persist/pass `FuseboardAnalysis` into the recording path.

### 2. S6 invents a second capability handshake instead of extending the existing one

There is already session-start capability structure:

- iOS sends `protocol_version: "stage6"` in `sendSessionStart`.
- Backend parses `msg.capabilities` for voice-latency capabilities and stores it under `entry.voiceLatency.capabilities`.
- Backend responds with `session_ack`; iOS currently reads only `status` and ignores additional fields.

S6 adds top-level `supports_eager_intent` and a new `session_capabilities.eager_intent_enabled` response. That is additive, but it is a new parallel schema. It also requires iOS `session_ack` decoding to retain the new field; current `serverDidReceiveSessionAck(status:)` discards everything except status.

This should either be folded into the existing `capabilities` object / `protocol_version` story, or the plan should explicitly bump/extend the session_ack schema and update the delegate signature.

### 3. D10-v3 should specify stale-buffer purge on all pending-ask terminal paths

D10/S7 mention `purge(olderThanMs)` and D11 says stale iOS entries clear after 30s, but the backend buffer also needs deterministic cleanup when:

- `pendingAsks.resolve()` returns false because the ask already timed out or was rejected.
- `pendingAsks.rejectAll()` runs for `session_stopped`, `session_terminated`, or `session_reconnected`.
- `ask_user_answered` resolves the same tool id through the normal fallback path.

Otherwise stale `fluxTurnId -> toolCallId` entries can survive past the ask they were meant to answer and later `commit` against a recycled/mis-associated client state.

## NIT

### 1. D6-v3 doc quote should include omission semantics, not only validation

The plan correctly pins names/nesting/ranges, but D17 depends on omitted-field behavior. The relevant Configure doc line is: omitted parameters retain current values. That should be quoted in the plan because it changes restore semantics.

### 2. D11-v3 can cite the Flux state-machine guarantee directly

Deepgram's state docs currently state that `EndOfTurn` matches the immediately preceding `EagerEndOfTurn`, and if the transcript changes after eager, `TurnResumed` occurs first. That materially simplifies S10 and should be cited directly.
