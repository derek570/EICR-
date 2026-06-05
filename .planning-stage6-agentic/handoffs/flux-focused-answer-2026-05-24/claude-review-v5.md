# Claude Plan-agent adversarial review — Round 5

> Run 2026-05-25 via Plan-agent. Verbatim agent response.

# CONVERGED

Round 5 read-only audit of PLAN_v5.md against source-of-truth files
(`sonnet-stream.js`, `DeepgramService.swift`, `ServerWebSocketService.swift`,
`stage6-pending-asks-registry.js`, `DeepgramRecordingViewModel.swift`) plus
verbatim Deepgram Flux state-machine docs at
https://developers.deepgram.com/docs/flux/state.

**No remaining BLOCKERs.** Every round-4 BLOCKER closed against source.
Sub-BLOCKER residual issues are pure implementation hygiene that can be
addressed during S6-S16 execution without further plan revision.

## Round-4 BLOCKER closure verification

### N1-v4 / Codex BLOCKER 1 — wire order + handleEagerCommit semantics — CLOSED

Wire-order reversal verified. ServerWebSocketService.swift:409-453
shows all `send()` calls dispatch through `queue.async` on a serial
DispatchQueue — wire order preserved.

Fast-path suppression verified. sonnet-stream.js:3112-3123:

```
if (typeof msg.utterance_id === 'string' &&
    entry.consumedAskUtterances &&
    entry.consumedAskUtterances.has(msg.utterance_id)) {
  logger.info('stage6.transcript_suppressed', {...});
  return;
}
```

`source === 'eager'` SKIP rules verified safe via Deepgram docs.
Fetched https://developers.deepgram.com/docs/flux/state directly:

> "The EndOfTurn transcript will always match the immediately preceding
> EagerEndOfTurn transcript. If the transcript changes after an
> EagerEndOfTurn, a TurnResumed event will occur first."

If user says anything that changes transcript after EagerEndOfTurn,
Flux is **contractually required** to fire TurnResumed first. iOS
handles TurnResumed by sending eager_discard (NOT eager_commit). So
divergent speech never reaches `handleEagerCommit` — it routes to
`handleEagerDiscard`.

### N2-v4 / Codex IMPORTANT 1 — binary collapse — CLOSED

Verified sonnet-stream.js:2229-2235 + 2187. Every reconnect rejects
all pending asks unconditionally. Binary collapse to
{continuous, reconnected} is clean 1:1 mapping.

### N3-v4 / Codex BLOCKER 2 — close code 1001 — CLOSED

Verified DeepgramService.swift:1432-1453. `.goingAway` (1001) is
`!= .normalClosure` → reconnect fires. Reason string 18 ASCII bytes,
well under RFC 6455 123-byte cap.

### D22-v5 FluxAnswerNormaliser — CLOSED

Backend regex semantics align with Swift NSRegularExpression. Unicode
edge cases (Turkish I, Greek sigma) flagged for unit test coverage.

### D21-v5 call-site wraps — RESIDUAL (not BLOCKER)

`pendingAsks.rejectAll` is called from FIVE sites. PLAN_v5 only
addresses one. Periodic 30s timer is adequate defence for the other
four. Implementation TODO.

## Residual non-blockers (implementation TODOs)

1. Apply D21-v5 buffer-clear wrap at remaining 4 rejectAll sites (or
   accept periodic timer cleanup).
2. D14-v5 filter MUST run inside `flushPendingMessages` before drain.
3. Implement eagerControlChain with `chain = chain.then()` not
   `await chain; chain = body()`.
4. D22-v5 unit tests must cover Turkish / Greek locale lowercase
   edge cases.
5. iOS `session_continuity` parsing falls back to `status` field if
   missing (back-compat with pre-deploy backends).

These belong in implementation TODO lists, not in further plan
revisions.

## Convergence statement

Five rounds of adversarial review. Round 1-2 reshaped the architecture
from polling-bounded to event-bounded. Round 3 introduced the
eager_intent buffer. Rounds 4-5 refined wire protocol and reconnect
semantics. Every round-4 BLOCKER closed against source-of-truth code
in PLAN_v5.

**TF#1 has been converged since PLAN_v3.** Confirmed unchanged by v4
and v5 modifications.

**TF#2 is structurally ready.** No further round needed. Proceed to
implementation.
