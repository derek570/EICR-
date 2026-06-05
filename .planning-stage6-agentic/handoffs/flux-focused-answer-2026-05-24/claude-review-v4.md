# Claude Plan-agent adversarial review — Round 4

> Run 2026-05-25 via Plan-agent. Read-only audit of PLAN_v4.md.
> Verbatim agent response.

## Verdict

**NOT converged.** Three new BLOCKERs introduced by v4 mechanisms that
don't match the existing source. **N1-v3 is NOT closed** — the v4 design
still produces the duplicate-Sonnet-round race it was meant to fix.

**TF#1 (Layer 1 alone) remains effectively converged** — none of the
round-4 findings touch TF#1. PLAN_v4 confirms (and source supports) that
Layer 1 alone is unaffected by all v4 mechanisms.

## NEW BLOCKER (round 4)

### N1-v4. D20-v4 Case A wire order still produces duplicate Sonnet round

D20-v4 Case A: "1. iOS sends `sendTranscript` ... 2. iOS sends
`sendEagerCommit`". This is the wrong order. Source trace at
`sonnet-stream.js`:

1. Backend receives `transcript` first → `handleTranscript` runs:
   - `consumedAskUtterances.has(utterance_id)` → MISS (eager_commit hasn't arrived).
   - `recentAskAnswers` content-anchor check → MISS (eager_commit hasn't pushed yet).
   - `classifyOvertake(text, regexResults, pendingAsks)`. If shape is
     yes_no/circuit_ref AND text matches: resolves with FINAL text via
     transcript-overtake (line 3639), stamps `seenTranscriptUtterances`,
     early-returns.
   - If free_text shape: falls through → `pendingAsks.rejectAll('user_moved_on')`
     + queues transcript for re-entry. **Free_text asks are explicitly
     rejected.**
2. Backend receives `eager_commit` second → `handleEagerCommit` runs:
   - Stamps ledgers (too late). Calls `pendingAsks.resolve(...)` returning
     `false` because ask was already resolved/rejected in step 1.

Net outcome:
- Shape-matching asks: ask resolves with FINAL text via transcript-overtake.
  Eager buffer structurally unused. Zero latency saving.
- Free_text asks: ask force-rejected with user_moved_on + transcript
  queued for shadow-harness re-extraction = **extra Sonnet round**. Exactly
  N1-v3.

Required fix options:
1. **Reverse wire order to eager_commit FIRST, transcript SECOND.** Then
   handleEagerCommit stamps `consumedAskUtterances.add(buffered.utteranceId)`
   BEFORE handleTranscript checks the fast-path Set. Eliminates the race.
2. Suppress transcript send entirely on Case A. Risk: TTS-echo / transcript
   dedupe machinery dependencies on `seenTranscriptUtterances`.
3. Add `eager_intent_pending(utteranceId)` guard at top of handleTranscript
   that defers shadow-harness processing.

PLAN_v4 picks none. The cost claim is unsubstantiated.

### N2-v4. D14-v4 `soft_reconnect` is invented infrastructure that does not exist on the backend

Verified at `sonnet-stream.js:2181-2235`. The existing reconnect path:

```js
existing.pendingAsks.rejectAll('session_reconnected');  // L2187
ws.send(JSON.stringify({
  type: 'session_ack',
  status: 'reconnected',
  sessionId: existing.rehydrateSessionId || null,
}));
```

**Only one reconnect status: `'reconnected'`.** Every reconnect
unconditionally rejects all pending asks AND clears dedupe ledgers. No
concept of a "soft reconnect" where backend state is intact.

PLAN_v4 D14-v4 tri-state (continuous | soft_reconnect | hard_reconnect)
requires either:
1. New code in `handleSessionStart` to conditionally preserve pendingAsks
   (Stage 6 STA-01 invariant change).
2. Collapse to binary `session_continuity: continuous | reconnected`.

The plan assumes (1) silently. LOC budget doesn't account for the
rejectAll-branching work.

### N3-v4. D19-v4 force-reconnect via close-code-1000 is incompatible with existing reconnect gate

Verified at `DeepgramService.swift:1432-1453`:

```swift
if self.shouldReconnect && closeCode != .normalClosure {  // ← EXCLUDES 1000
    self.scheduleReconnect()
} else {
    self.connectionState = .disconnected
}
```

`didCloseWith` **explicitly excludes `.normalClosure`** from reconnect.
PLAN_v4 D19-v4 prescribes code 1000 + special reason + "have receive()
recognize the close code". Two problems:
1. `.normalClosure` close fires `didCloseWith` with `closeCode == .normalClosure`,
   hits the gate, does NOT reconnect.
2. `receive()` does NOT receive close code or reason — only `didCloseWith` does.

Required fix:
1. Use `.goingAway` (code 1001) or `.protocolError` (1002) — the existing
   gate ALREADY treats these as reconnect-eligible.
2. Or update `didCloseWith` to recognize `focused_mode_reset` reason and
   schedule reconnect.

## IMPORTANT (round 4)

### I1-v4. D13-v4 pendingAsks.resolve() inline-safety claim needs caveat

`resolve()` body is synchronous. `entry.resolve()` is the Promise resolver
— calling it wakes any awaiter via the microtask queue. handleEagerCommit
completes before any microtask runs (good). But the next microtask runs
the awaiting `runToolLoop` continuation which calls further async machinery.
Plan should state: "synchronous body of handleEagerCommit completes
before any microtask runs, so ledger writes are visible to subsequent
transcript handler."

### I2-v4. S6-v4 needs new `parseFocusedAnswerCapabilities` infrastructure

Verified at `voice-latency-config.js:147-180`. Existing parser is
purpose-built for `voice_latency` namespace only. Not generic. S6-v4
requires:
1. New `parseFocusedAnswerCapabilities(capabilitiesObj)`.
2. New `entry.focusedAnswer = { capabilities: ... }` session entry namespace.
3. iOS `serverDidReceiveSessionAck(status:)` delegate extension to carry
   parsed server capabilities.
4. Test fixtures may break.

LOC budget ~80 LOC light. Estimate: ~120-150 LOC.

### I3-v4. S10-v4 text normalisation cannot reuse the backend function — iOS needs Swift mirror

`sonnet-stream.js:614-621` `normaliseForAskMatch`:

```js
return text
  .toLowerCase()
  .replace(/[^a-z0-9\s]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
}
```

iOS cannot import Node.js. Plan claim "iOS doesn't need a new normaliser
— trim and case-fold" is incorrect — backend ALSO strips non-alphanumerics
+ collapses whitespace. Divergence will cause Case A/B desync.

Fix: add Swift `FluxAnswerNormaliser` mirroring `normaliseForAskMatch`
byte-for-byte.

### I4-v4. D21-v4 Surface 3 callback hook does not exist

Registry's `resolve()` doesn't support callbacks. Two ways to close:
1. Modify registry: add optional `onResolve(toolCallId, outcome)` callback.
2. Sweep at CALL SITE (ask_user_answered handler explicitly purges).

Plan should specify which. As written, "callback" is misleading.

### I5-v4. D17-v4 `hasEverEnabledLayer2InThisSession` persistence undefined

Plan says "cleared on session start". Force-reconnect = session start?
If preserved across reconnects → restore-Configure keeps triggering
force-reconnect → infinite loop. If cleared on every WS connect →
safe.

Plan should explicitly say "cleared on every WS connect" and tie to D19-v4
state-clear.

### I6-v4. Backwards-compat risk for session_ack test fixtures

New `session_continuity` + `server_capabilities` fields. iOS reader
ignores unknowns (Swift Codable). But backend integration tests + iOS
test fixtures with hard-asserted shape may break.

### I7-v4. D13-v4 reverse-race guard mirror should NOT downgrade in eager_commit

handleEagerCommit running reverse-race guard verbatim would demote
itself to `{answered: false, reason: 'transcript_already_extracted'}` —
defeating Case A. Combine with N1-v4 fix option 1 (reverse wire order):
transcript hasn't been processed when eager_commit arrives, guard is a
no-op, eager wins cleanly.

## NIT (round 4)

- NIT-1-v4: D11-v4 quote Deepgram docs verbatim ("if transcript changes
  after eager, TurnResumed occurs first").
- NIT-2-v4: D8-v4 backoff duration not specified.
- NIT-3-v4: LOC budget likely ~1100-1200 total once N1-v4/N2-v4 fixes land.
- NIT-4-v4: TF#2 latency claim treats commit case as universal saving.
  Saving only exists for free_text asks; shape-matching asks already get
  the saving via classifyOvertake.
- NIT-5-v4: `eagerControlQueue` name suggests array/promise chain but
  pseudo-code shows inline handlers. Clarify.

## Convergence

Round-5 effort estimate: 1-2 days plan editing. No new architectural
redesign required — N1-v4 fix is wire-order swap; N2-v4 is tri-state
collapse to binary; N3-v4 is close-code swap.

**TF#1 remains converged.** All v4 BLOCKERs are TF#2-scope.
