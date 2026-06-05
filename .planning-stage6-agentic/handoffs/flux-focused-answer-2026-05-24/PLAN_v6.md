# Flux focused-answer turn detection — PLAN_v6 (2026-05-25, final)

> Supersedes PLAN_v5.md. Addresses the single remaining Codex BLOCKER
> (D19-v5 close-code echo) and 4 residual wording polishes. All other
> sections unchanged from PLAN_v5.

## Convergence status

- **Claude round 5: CONVERGED** (no BLOCKERs found against source).
- **Codex round 5: NOT CONVERGED — 1 BLOCKER** (D19-v5 force-reconnect
  relies on close-code echo). Mechanical fix below.

This v6 is the single-BLOCKER-fix revision intended to reach
"both reviewers converged".

## Round-5 BLOCKER closure

### D19-v6 (replaces D19-v5) — proactive force-reconnect

**Codex rd-5 BLOCKER 1 fix.** Apple's `URLSessionWebSocketDelegate.didCloseWith`
is documented as reporting the SERVER's close frame, not the locally-
sent one. PLAN_v5 relied on the close-code echo (1001 → 1001) being
propagated back through `didCloseWith` to trigger `scheduleReconnect()`.
Not guaranteed by spec.

Fix: be proactive. After sending the close frame, schedule reconnect
locally rather than waiting for the close round-trip.

iOS S15-v6 implementation:

```swift
// New private flag on DeepgramService
private var pendingForceReconnect = false

// New method on DeepgramService
private func forceFocusedModeReset() {
    queue.async { [weak self] in
        guard let self else { return }
        self.pendingForceReconnect = true
        // Clear iOS-side focused-mode state immediately
        self.exitFocusedAnswerMode(reason: .forceReconnect)
        // Send close frame (best-effort; server response code irrelevant)
        self.webSocketTask?.cancel(
            with: .goingAway,
            reason: Data("focused_mode_reset".utf8)
        )
        // PROACTIVE: schedule reconnect locally, guarded by
        // isReconnectScheduled to prevent double-schedule if didCloseWith
        // ALSO fires reconnect.
        if self.shouldReconnect && !self.isReconnectScheduled {
            self.scheduleReconnect()
        }
    }
}
```

`scheduleReconnect()` is the existing method at `DeepgramService.swift:1187`
which already has duplicate-call protection via `isReconnectScheduled`.
If `didCloseWith` happens to also fire reconnect, the second call
is a no-op.

`exitFocusedAnswerMode(reason:)` extended to accept a reason enum so
`forceReconnect` callers can skip the normal restore-Configure path
(connection is about to die anyway).

This makes the force-reconnect path **verifiably correct from local
source alone** — no dependency on remote close-code echo behaviour.

## Round-5 IMPORTANT closures

### D14-v6 wording fix (refines D14-v5) — preserve existing `status`, ADD `session_continuity`

**Codex rd-5 residual.** PLAN_v5's illustrative JSON used `"status": "ok"`
which would break existing iOS check at `DeepgramRecordingViewModel.swift:7053-7057`
(`status == "started" || status == "reconnected"`).

Corrected: backend `session_ack` PRESERVES existing `status` values and
ADDS `session_continuity` alongside:

```json
{
  "type": "session_ack",
  "status": "started",                        // existing field unchanged
  "session_continuity": "continuous",          // new field
  "sessionId": "..."
}
```

```json
{
  "type": "session_ack",
  "status": "reconnected",                     // existing field unchanged
  "session_continuity": "reconnected",         // new field
  "sessionId": "..."
}
```

Backend code sites (per Codex):
- `sonnet-stream.js:2229-2234` (reconnect branch): add
  `session_continuity: 'reconnected'` to the emitted object.
- `sonnet-stream.js:2695-2697` (fresh-start branch): add
  `session_continuity: 'continuous'`.

iOS implementation note: parse `session_continuity` if present;
**fall back to `status` field if missing** (back-compat with
pre-deploy backends). Map: `status='started'` → continuous,
`status='reconnected'` → reconnected.

### D13-v6 rationale clarification (refines D13-v5) — classifyOvertake skip safety argument

**Codex rd-5 residual.** PLAN_v5 said "EagerEndOfTurn fired BEFORE the
user could have said something divergent". That's wrong — the user
CAN continue speaking after EagerEndOfTurn.

Corrected rationale: classifyOvertake skip for `source === 'eager'`
is safe because of:

1. **Deepgram Flux state-machine guarantee** ([state docs](https://developers.deepgram.com/docs/flux/state)):
   > "The EndOfTurn transcript will always match the immediately
   > preceding EagerEndOfTurn transcript. If the transcript changes
   > after an EagerEndOfTurn, a TurnResumed event will occur first."

2. **iOS Case B branching** (D20-v5): if user says anything divergent,
   Flux fires TurnResumed before the new EndOfTurn → iOS handles via
   eager_discard + legacy `ask_user_answered`. handleEagerCommit
   NEVER fires with divergent text.

Therefore the only path that reaches handleEagerCommit is the
"user said the same thing in both EagerEndOfTurn and EndOfTurn" case,
where there's nothing for classifyOvertake to classify as a new
command.

Code comment in `commitAskAnswer`:

```js
// SAFETY: For source === 'eager', skipping classifyOvertake is safe
// because Flux's state machine guarantees TurnResumed fires before any
// divergent EndOfTurn (see https://developers.deepgram.com/docs/flux/state).
// iOS handles TurnResumed by sending eager_discard, not eager_commit, so
// handleEagerCommit only fires when EndOfTurn matches the eager text exactly.
// Wire order (eager_commit FIRST, transcript SECOND) further ensures
// handleTranscript hasn't run yet — see D20-v6.
```

### D21-v6 O(n) acknowledgement (refines D21-v5)

**Codex rd-5 residual.** `deleteByToolCallId(toolCallId)` iterates the
buffer (keyed by `fluxTurnId`). For typical session sizes (≤32 entries
in the bounded `recentEagerIntents` ledger, similar order for
`eagerBuffer`), O(n) scan is fine.

Code comment in the buffer module:

```js
// O(n) scan: buffer is keyed by fluxTurnId (per D11), so toolCallId
// lookup requires iteration. Bounded ≤32 entries per session
// (RECENT_EAGER_INTENT_CAP); call site is the ask resolution hot path,
// not the audio hot path, so O(n) is acceptable. Add an inverted index
// only if profiling shows it on the per-turn budget.
```

### NIT-5-v6 sharpening (refines D5-v5) — explicit Promise-chain pattern

**Codex rd-5 residual + Claude residual.** PLAN_v5 said "single
`entry.eagerControlChain = Promise.resolve()` that handlers await +
reassign. ~3 LOC."

Ambiguous wording. Correct pattern:

```js
entry.eagerControlChain = entry.eagerControlChain
  .then(() => handlerBody())
  .catch((err) => { logger.warn('stage6.eager_handler_error', { err }); });
```

Each handler reassigns the chain to the result of `.then()` so subsequent
messages in the same event-loop tick serialize behind the in-flight body.
Handlers may await the chain if they need to surface completion to the
WS message callback.

**Anti-pattern (do NOT use):**

```js
await entry.eagerControlChain;
// handlerBody — multiple messages in same tick all see same chain, race
entry.eagerControlChain = handlerBody();
```

Per Claude's analysis: since all three eager handlers are pure
synchronous (no awaits in their bodies — `pendingAsks.resolve()` is
synchronous), serialization is a defensive safety net, not a strict
correctness requirement. The chain pattern protects against future
changes that introduce awaits.

## Residual non-blockers (implementer TODOs)

Captured here so they don't get lost; do NOT require another plan
revision:

1. **D21 call-site wraps at all 5 `rejectAll` sites** (Claude v5
   finding): `pendingAsks.rejectAll` is called at sonnet-stream.js lines
   1941, 2187, 2972, 3733, 4179, 4251. PLAN_v6 D21-v5 only addresses
   line 2187. Other four can rely on Surface 5 periodic 30s timer, OR
   add a one-liner sweep at each call site. Implementer choice — both
   are acceptable.

2. **D14 filter inside `flushPendingMessages`** (Claude v5 finding):
   reconnect-buffer filter for eager_* messages MUST run inside
   `flushPendingMessages()` BEFORE buffer drain, not in a separate async
   path. iOS implementation note.

3. **D22 unicode edge-case tests** (Claude v5 finding): Swift unit tests
   for `FluxAnswerNormaliser` must include Turkish (I → ı) and Greek
   (Σ → ς vs σ) cases to prove parity with backend's locale-invariant
   `.toLowerCase()`.

4. **D14 backward-compat fallback** (Claude v5 finding): iOS parsing of
   `session_continuity` must fall back to `status` field if the new
   field is missing.

## Slice deltas (v6 vs v5)

| Slice | v5 LOC | v6 LOC | Delta |
|---|---|---|---|
| S15-v6 | ~80 | ~80 | unchanged total; internal restructure for proactive scheduling |
| S7-v6 | ~180 | ~180 | unchanged; D21 O(n) comment added |
| S8-v6 | ~180 | ~180 | unchanged; D13 rationale comment expanded |
| S6-v6 | ~150 | ~155 | +~5 LOC for status/continuity dual-emit |
| S10-v6 | ~220 | ~220 | unchanged |

**TF#2 v6 total: ~1155 LOC** (was ~1150 in v5). +5 LOC for D14 dual-emit.

## Convergence statement

PLAN_v6 closes the single Codex round-5 BLOCKER mechanically. Both
reviewers should now converge:

- Claude round 5: already converged at v5; v6's D19-v6 fix is a tighter
  version of the same mechanism.
- Codex round 5: D19-v6's proactive scheduling removes the unproven
  close-code-echo reliance.

If round 6 surfaces new BLOCKERs, they will be entirely new — round 6 is
NOT expected to find anything; the plan is now mechanically grounded
against source.

Architecture has been stable since PLAN_v3. Wire protocol stable since
PLAN_v4. Round 5 and 6 are pure refinement.

## Status

- **TF#1**: Effectively converged since PLAN_v3. Ready to ship standalone.
- **TF#2**: Mechanically converged at PLAN_v6 pending round-6 verification.
