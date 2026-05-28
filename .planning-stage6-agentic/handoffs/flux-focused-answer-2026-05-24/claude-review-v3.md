# Claude Plan-agent adversarial review — Round 3

> Run 2026-05-25 via Plan-agent. Read-only audit of PLAN_v3.md against
> round-2 closures (claude-review-v2.md + codex-review-v2.md) plus new
> surfaces introduced in v3. Verbatim agent response.

## Verdict summary

**PLAN_v3 closes 22 of 25 round-2 findings structurally**, and the
eager_intent buffer redesign is the right move — it puts the race state
machine on the layer that owns the writes. However, **3 NEW BLOCKERs are
introduced by the v3 changes**, all rooted in the same gap: PLAN_v3
designed the wire protocol but did not finish wiring it into the existing
transcript-deduplication ledgers, the reconnect-buffer ordering
algorithm, and the `ask_user_answered` synchronisation that the legacy
path depends on. **Round 3 NOT converged.**

TF#1 (Layer 1 alone) IS close to converged at v3 — all round-3 BLOCKERs
are TF#2-scope.

## NEW BLOCKER (round 3)

### N1-v3. `eager_commit` does not stamp the existing `recentAskAnswers` / `consumedAskUtterances` ledgers, breaking transcript-vs-ask dedupe for Layer 2

When iOS resolves an ask today, the wire is:

1. `sendTranscript(text, utteranceId)` — backend stamps
   `seenTranscriptUtterances.add(utteranceId)` and pushes to
   `recentTranscripts` in `handleTranscript`.
2. `sendAskUserAnswered(toolCallId, userText, consumedUtteranceId)` —
   backend calls `pendingAsks.resolve` AND pushes the sanitised text
   into `recentAskAnswers` (sonnet-stream.js:1872-1885) and adds
   `consumedUtteranceId` to `consumedAskUtterances` (line 1830-1836).

These ledgers exist to defend against transcript-vs-ask cross-channel
duplication. The whole DeepgramRecordingViewModel:2078-2094 paired-emit
pattern depends on the backend stamping BOTH ledgers so a transcript
arriving 1ms before or after `ask_user_answered` for the same utterance
is correctly suppressed.

PLAN_v3 S8 says: "`handleEagerCommit(fluxTurnId)` looks up buffered
answer, calls existing `pendingAsks.resolve(toolCallId, {answer:
buffered, source: 'eager'})`."

The dispatcher path IS the same. But the wire-handler path at
sonnet-stream.js:1451-1888 does much more than call
`pendingAsks.resolve`: it stamps `consumedAskUtterances`,
`recentAskAnswers`, runs the reverse-race guard against
`seenTranscriptUtterances`/`recentTranscripts`, and runs sanitisation.
PLAN_v3 S8 specifies NONE of these.

Concretely: in the Layer 2 commit case, iOS sends `eager_intent` on
EagerEndOfTurn, then on the matching EndOfTurn sends `eager_commit`.
**PLAN_v3 S10 does not say what iOS does about `sendTranscript` on this
final**. Two readings:

**Reading A:** iOS still sends `sendTranscript(finalText, utteranceId)`
alongside `eager_commit`. Backend's `handleEagerCommit` calls
`pendingAsks.resolve` with the buffered eager text. Backend's
`handleTranscript` runs in parallel. The transcript handler does NOT
find a content-anchor match in `recentAskAnswers` (because
`handleEagerCommit` never pushed to it), does NOT find an utterance_id
match in `consumedAskUtterances` (because `handleEagerCommit` never
added the utterance), so the transcript falls through to a NORMAL
extraction of the same speech — producing a second Sonnet round for
"eight" extracted as a free-floating utterance.

**Reading B:** iOS suppresses `sendTranscript` on the matching-final
path when `eager_commit` is sent. Then `seenTranscriptUtterances` is
NOT populated for that utterance, so a LATER stray `ask_user_answered`
carrying `consumed_utterance_id = <that id>` cannot fast-path match.
Worse, the existing TTS-echo / transcript-dedupe machinery downstream
relies on every spoken utterance being represented in
`seenTranscriptUtterances`.

Both readings break existing correctness invariants. Plan needs to
specify:
1. Whether iOS sends `sendTranscript` paired with `eager_commit`.
2. Whether `handleEagerCommit` ALSO pushes to `recentAskAnswers` and
   stamps `consumedAskUtterances` (must yes).
3. Whether the eager text or the final text gets pushed.

PLAN_v3 S8 LOC estimate of ~80 lines is implausible. Closer to
~150-200 LOC.

### N2-v3. D18-v3 reconnect-buffer whitelist is insufficient — `reorderPendingForReplay` does not pair `eager_intent` with its matching transcript or `eager_commit`

PLAN_v3 D18-v3 says: "Replay order: transcripts first (existing), then
eager messages in arrival order."

But `ServerWebSocketService.swift:703-760` `reorderPendingForReplay` is
NOT "transcripts first then everything else". It pairs `transcript(X)`
with `ask_user_answered(X)` by **matching `consumed_utterance_id`**,
hoisting the transcript to immediately precede its paired ask. The
algorithm needs extension for:

- `eager_intent(turnId)` in buffer, `eager_discard(turnId)` in buffer,
  AND a paired `ask_user_answered(toolCallId, utteranceId)` (divergent-
  final case). Current algorithm pairs `ask_user_answered` with its
  matching `transcript` and hoists — does NOT keep
  `eager_intent`/`eager_discard` grouped relative to the pair.

- `eager_commit(turnId)` in buffer with no paired `eager_intent` (intent
  reached backend before disconnect, then disconnect happened before
  commit). On reconnect, commit replays against backend whose
  `eager_intent` buffer entry was purged at 30s or after task restart.
  `handleEagerCommit` finds nothing → does nothing → no
  `ask_user_answered` either → ask times out at 45s → speech lost.

Plan needs one of:
1. Paired emit algorithm that keeps `eager_intent`,
   `eager_commit`/`eager_discard`, and matching transcript/answered all
   in a single hoisted group.
2. Backend's `handleEagerCommit` falls back to looking up by
   `tool_call_id` from a recently-evicted ledger if the buffer is gone.
3. iOS always sends `ask_user_answered` as a fallback on the
   matching path too (contradicts the cost claim).

### N3-v3. "EndOfTurn arrives with no preceding EagerEndOfTurn for that turn" path is unspecified

Flux frequently emits EndOfTurn WITHOUT a preceding EagerEndOfTurn when
`end_of_turn_confidence` crosses `eot_threshold` quickly enough to skip
the eager phase entirely. With `eot_threshold=0.5` and
`eager_eot_threshold=0.4` (per S12), a single-word "eight" with
reasonable acoustic confidence could cross 0.5 directly.

In this case:
- iOS receives no EagerEndOfTurn event for turn N →
  `pendingEagerByFluxTurnId` has no entry for N.
- iOS receives EndOfTurn for turn N → lookup misses.

S10 does not specify what to do. **Fix required:** plan must say: "On
EndOfTurn for turn N where `pendingEagerByFluxTurnId[N]` is absent: send
normal `sendAskUserAnswered` (no eager_commit, no eager_discard)."

Frequency: possibly 20-50% of cases at the new threshold.

---

## IMPORTANT (round 3)

### I1-v3. D9-v3 ConfigureSuccess echo: 500ms timeout semantics not stated

D9-v3 says "wait for ConfigureSuccess echo within 500ms ... fail closed
if mismatch." Two failure modes need different handling:
- Arrives within 500ms with mismatched values → treat like
  ConfigureFailure (D8-v3 state-clear).
- No ConfigureSuccess arrives within 500ms → plan is silent.

Easy fix: explicitly say "no echo within 500ms → also failure".

### I2-v3. ConfigureFailure loop on every ask_user when Flux rejects focused-mode

D8-v3 abandons focused-mode for THIS answer; runtime flag still ON. Next
`ask_user` → another fail → log spam. Add in-session backoff or surface
as Settings yellow-banner.

### I3-v3. PLAN_v3 D14-v3 capability gate works for new sessions but not in-flight

In-flight sessions on old task get capability ON; new sessions on new
task get OFF. ECS rolling deploy semantics rely on
`minimumHealthyPercent>=100`. Plan should state this explicitly.

### I4-v3. The `ask_user_answered` handler is NOT a member of the `isExtracting`/`pendingTranscripts` queue

D13-v3 says "treat eager_intent, eager_commit, eager_discard messages as
members of the same queue family as transcripts — drained in arrival
order while `isExtracting=false`." But `ask_user_answered` does NOT
consult `entry.isExtracting`. It runs inline.

If PLAN_v3 wants eager_* "in the same queue family", it needs to ALSO
route `ask_user_answered` through `isExtracting`/`pendingTranscripts` —
non-trivial Stage 6 invariant change.

Alternative reading: eager_* sit inline like ask_user_answered does
today, relying on Node.js single-threadedness. Defensible for
`eager_intent` (pure buffer push) and `eager_discard` (pure buffer
delete). NOT defensible for `eager_commit` because it calls
`pendingAsks.resolve` → awaits buildResolvedBody + autoResolveWrite →
crosses await boundaries.

Plan must be explicit. Currently isn't.

### I5-v3. PLAN_v3 D18-v3 reconnect-buffer ordering is more than a whitelist update

Even if eager_* gets full pairing in `reorderPendingForReplay`,
algorithm assumes one ask per transcript per `consumed_utterance_id`.
Pairing across `(eager_intent, eager_commit | eager_discard,
ask_user_answered, transcript)` for the same utterance + tool_call_id
is more complex than the current pair-of-two algorithm.

### I6-v3. PLAN_v3 D8-v3 "force WS reconnect via `webSocketTask?.cancel()`" understates the existing reconnect contract

`webSocketTask?.cancel()` is part of a teardown sequence that ALSO does
`urlSession?.invalidateAndCancel()`. The natural cancel that drives
`scheduleReconnect()` is the `receive(...)` callback's `.failure`
branch. Plan should specify "cancel the receive task to trigger the
`.failure` branch, NOT the full teardown."

### I7-v3. Layer 1 alone is meaningful-but-partial; TL;DR should say so

Composition table shows TF#1 saves ~3-4s on ~8.5s problem. Layer 2 is
where the substantive UX win lives. TL;DR currently says "Layer 1
unchanged in shape" which understates the value-per-effort tradeoff.

### I8-v3. PLAN_v3 cost claim "no extra Sonnet rounds in either case" is correct IFF N1-v3 ledger gap is closed

If N1-v3 unfixed, an extracted-as-free-floating-utterance transcript
triggers ADDITIONAL Sonnet round on commit case. Cost claim depends on
closing N1-v3 first.

---

## NIT (round 3)

### NIT-1-v3. Cost-claim wording at line 217 sounds axiomatic; conditional on N1-v3 closure.

### NIT-2-v3. Citation hygiene — Q3 references Codex BLOCKER but missed Claude IMPORTANT round 1.

### NIT-3-v3. D8-v3 retry intervals (50/100/200ms) not justified.

### NIT-4-v3. Commit a name in iOS for fluxTurnId: `typealias FluxTurnIndex = Int`. `turn_index` is documented as 0-indexed integer per Deepgram docs.

### NIT-5-v3. D11-v3 "purge stale entries older than 30s" — trigger should be explicit: timer + restore + session end.

---

## Verdict (final)

**NOT converged.** PLAN_v3 substantially improved over PLAN_v2. The
eager_intent buffer architecture is correct. **3 new BLOCKERs (N1-v3,
N2-v3, N3-v3) need round-4 resolution before TF#2 development should
start.** None require a v4 architectural redesign — they are wire-
protocol completeness issues — but each requires concrete prose in the
plan.

**TF#1 (Layer 1 alone) IS effectively converged at v3.** Derek could
ship TF#1 standalone with high confidence and address the round-3
BLOCKERs before committing TF#2 development.

The Q1 (rd 2) decision to adopt eager_intent buffer pattern was correct.
PLAN_v3 is one round away from converged.
