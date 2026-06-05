# Claude Plan-agent adversarial review — Round 6

> Run 2026-05-25 via Plan-agent. Verbatim agent response.

# CONVERGED

Round 6 adversarial verification of `PLAN_v6.md`.

## Verdict

PLAN_v6 closes the round-5 Codex D19 BLOCKER mechanically. The
force-reconnect path is now verifiable from local source alone: after
`cancel(with: .goingAway, ...)`, iOS proactively calls
`scheduleReconnect()` rather than waiting for `didCloseWith` to echo
the close code. The `isReconnectScheduled` guard in the existing path
(`DeepgramService.swift:1188`) absorbs the duplicate-callback case if
`didCloseWith` also fires reconnect.

**No new BLOCKERs found.** Two implementation-polish items below —
neither requires another plan revision.

## D19-v6 proactive reconnect — verified against source

`scheduleReconnect()` mid-close safety (`DeepgramService.swift:1187-1225`):
- No invariant requiring `webSocketTask == nil`. Only checks
  `shouldReconnect` and `!isReconnectScheduled`.
- Sets `isReconnectScheduled = true`, dispatches via `queue.async` to set
  `connectionState = .reconnecting`, increments `reconnectAttempt`, and
  queues a `DispatchWorkItem` via `queue.asyncAfter`.
- The work item later calls `_connect()` which calls `_disconnectImmediate()`
  (`:367` → `:493-497`) which cancels any remaining `webSocketTask` and
  tears down `urlSession` via `invalidateAndCancel()`.
- So calling `scheduleReconnect()` while WS is mid-close is safe —
  cleanup happens lazily inside the work item.

Race: scheduleReconnect first, didCloseWith with `.normalClosure` later:
1. `forceFocusedModeReset` calls `scheduleReconnect()`. State `.reconnecting`.
2. Server responds `.normalClosure`. `didCloseWith` gate
   `shouldReconnect && closeCode != .normalClosure` → false → falls into
   `else` → `connectionState = .disconnected` (`:1450`).
3. Work item later fires, calls `_connect()`, transitions
   `.connecting` → `.connected`.

Outcome: spurious `.reconnecting → .disconnected → .connecting → .connected`
UI flicker. The reconnect still happens. **Not a correctness blocker.**
Could be tightened (see polish notes below).

## D14-v6 dual-emit — verified against source

`sonnet-stream.js:2229-2235` (reconnect branch) and `:2695-2697`
(fresh-start branch). Both match PLAN_v6's claim. Preserving `status`
keeps `DeepgramRecordingViewModel.swift:7053-7057`'s existing check
intact. Back-compatible.

## D13-v6 safety claim — verified

Combined with iOS Case B (D20-v5) routing divergent finals through
`eager_discard` + legacy `ask_user_answered`, `handleEagerCommit` only
fires when EndOfTurn matches the eager text exactly. `classifyOvertake`
skip is safe.

**Doc-pinning gap (NIT):** PLAN_v6 cites the URL but does not pin a
fetched date. Add to implementation code comment.

## D21-v6 acknowledgement — partly imprecise (NIT)

PLAN_v6 says: "Bounded ≤32 entries per session (RECENT_EAGER_INTENT_CAP)"

This conflates two ledgers:
- `recentEagerIntents`: the 60s fallback ledger — has
  `RECENT_EAGER_INTENT_CAP = 32`.
- `eagerBuffer`: the main per-turn eager-intent buffer from PLAN_v3 S7
  — keyed by `fluxTurnId`, **does not have a documented hard cap**.

`deleteByToolCallId` iterates `eagerBuffer`, not `recentEagerIntents`.
So the cap claim should soften to "time-bounded by commit/discard,
reconnect clears, and the 30s purge timer" OR add explicit
`EAGER_BUFFER_CAP`. Codex round-6 made the same observation
independently.

## Polish items (non-blocking)

1. **`pendingForceReconnect` is dead code** in the v6 snippet (set but
   never read). Either remove it or wire it into `didCloseWith` to
   suppress the transient `.disconnected` state overwrite when the
   proactive reconnect is already scheduled. Implementer choice.

2. **Doc-fetched-date** for D13-v6's Flux state-machine guarantee
   should appear in the implementation code comment, not just in this
   review thread.

Neither requires a PLAN_v7.

## Convergence statement

Six rounds of adversarial review:
- Rounds 1-2: reshaped architecture.
- Round 3: introduced eager_intent buffer (stable since).
- Rounds 4-5: refined wire protocol + reconnect semantics.
- Round 6: closed close-code-echo BLOCKER with proactive scheduling.

Architecture stable since PLAN_v3. Wire protocol stable since PLAN_v4.
Force-reconnect mechanism now verifiably correct from local source
alone.

**TF#1: converged since PLAN_v3.** Ready to ship standalone.
**TF#2: converged at PLAN_v6.** Ready for implementation. Round 7 NOT
warranted — remaining items are implementer hygiene, not plan
substance.

Cross-reviewer agreement is strong: Codex round 6 arrived at the same
conclusions independently (CONVERGED, same two polish items, no new
BLOCKERs).
