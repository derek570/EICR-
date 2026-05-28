# BLOCKER

## Configure payload is still wrong: PLAN_v2 uses non-existent threshold names

PLAN_v2 D6/S1 says the nested keys are `eot_confidence` and `eager_eot_confidence`. Official Deepgram Flux Configure docs say the nested object is correct, but the keys are still `eot_threshold`, `eager_eot_threshold`, and `eot_timeout_ms`: https://developers.deepgram.com/docs/flux/configure. The same page's `ConfigureSuccess` example echoes `eager_eot_threshold` / `eot_threshold` / `eot_timeout_ms`, and validation explicitly says `eager_eot_threshold` must be <= `eot_threshold`. As written, S1 is not executable and the JSON encoder unit test would bless the wrong contract.

## Focused keyterms can exceed Flux Configure's hard cap

Deepgram's Configure docs cap `keyterms` at 100 terms and say a Configure `keyterms` array replaces the entire list. Current iOS generation already caps at 100 before URL filtering (`KeywordBoostGenerator.maxKeyterms`) and the production URL path then hard-stops around ~89 keyterms (`DeepgramService.buildFluxURL`). S2 adds digits 1-50 plus "main/spare/none/yes/no/live/neutral/earth" etc. Appending that to the cached session list can easily send ~140-160 keyterms, causing `ConfigureFailure`. D7's "post URL-length filter" also answers the wrong constraint for Configure JSON: URL length no longer applies, but the 100-keyterm API cap does. The plan must define a deterministic <=100 prioritized focused list, not "canonical session list + focused list".

## `amend_ask_user_answered` is specified against state that does not exist

S7 says "look up the just-applied answer" and replace it if `pendingAsks.history` has not been flushed. Current `stage6-pending-asks-registry.js` has no history API. `resolve()` clears the timeout, deletes the Map entry, then wakes the dispatcher. After that, `stage6-dispatcher-ask.js` logs, builds the tool_result body, may auto-resolve writes into live session state, and `stage6-tool-loop.js` appends that tool_result into `messages` before the next Sonnet call. There is no mutable "answer value" left to replace.

The "turn still in progress" check is also not serialised. `sonnet-stream.js` handles each websocket message in an async `ws.on('message')` callback. Transcripts have an `isExtracting`/`pendingTranscripts` queue, but `ask_user_answered` does not go through a per-session serial command queue; it directly calls `pendingAsks.resolve`. An amend arriving while the dispatcher is between `resolve()` and the next Sonnet stream has no well-defined interlock. "pendingAsks contains the id" is too early, "pendingAsks does not contain the id" is already too late, and the plan never introduces the missing in-between ledger.

## Auto-resolved writes make amend more than a text replacement

For many Stage 6 asks, the answer dispatcher does not merely pass text back to Sonnet. `buildResolvedBody()` runs board/enum/value/circuit resolvers and calls `autoResolveWrite`, mutating the live extraction state before the turn ends. If eager "eight" auto-writes a value and final says "eight point five", S7 cannot fix this by replacing a tool_result string. It must either support compensating writes keyed by `tool_call_id`, defer auto-resolve until final, or avoid eager dispatch for resolver-backed asks. PLAN_v2 specifies none of that.

## `amend_ack.accepted=false` fallback is impossible after eager dispatch

Rollback says the backend can set `VOICE_AMEND_ASK_USER_DISABLED=true`, return `amend_ack.accepted=false`, and iOS will "fall back to the next final dispatch as if Layer 2 weren't there." That is not true once eager has fired. The eager `sendAskUserAnswered` has already resolved the backend pending ask, may have mutated state, and may have started confirmation TTS. A later final cannot simply be sent through the normal path: the same `tool_call_id` is now stale, and a duplicate `ask_user_answered` logs unresolved. The plan needs a pre-enable capability/health gate for amend, or Layer 2 must be disabled when amend is disabled. Rejecting amends after accepting eager answers is not a rollback path; it preserves the corruption and disables the repair.

## S8 has no idempotency for repeated eager/final events

S8 says eager dispatch should not insert into `firedAskUserAnsweredToolCallIds` until `EndOfTurn`. That reopens the double-dispatch gate the current code intentionally closes before wire emit. If Flux or iOS delivers a second eager for the same `tool_call_id`, iOS can dispatch the same answer twice and start duplicate optimistic confirmations. If a duplicate final arrives after the first final inserted the fired id, the current final path falls into the non-Stage-6 branch; because eager did not send the paired transcript/utterance-id dedupe that today's final path sends, the duplicate final can be treated as a normal transcript. The state key must include at least `(toolCallId, Flux turn_index, eager/final phase)` and define terminal states for eager_sent, resumed, final_matched, final_diverged, amend_pending, amend_rejected.

## Stacked asks are blocking, not an open non-blocking question

PLAN_v2 Q7 says backend FIFO can disambiguate stacked asks, but iOS chooses the `tool_call_id` before the backend sees anything. Current iOS has one `inFlightQuestion` slot. `handleAlertTTSStarted` for Q2 overwrites the slot that Q1 used, while S8 also proposes a single `pendingEagerToolCallId`. If Q1 has eager-dispatched and Q2 TTS starts before Q1 final/TurnResumed, the next eager/final attribution depends on whichever "current" slot the ViewModel reads at that instant. Backend FIFO cannot repair a frame sent with the wrong `tool_call_id`; it will faithfully resolve the wrong ask. Layer 2 needs an explicit per-Flux-turn to per-tool-call binding and a stacked-ask test before TF#2.

# IMPORTANT

## Round-1 closures verified

Closed: Layer 3 `Finalize` was dropped.

Closed: compile-time rollback was replaced by runtime iOS flags for Layer 1 and Layer 2.

Closed: `ConfigureFailure` is now specified as soft warning/no reconnect.

Closed: the passive stale-window bug is addressed by a real cancellable 10s timer.

Closed: replay harness claims were narrowed to backend amend plumbing, with real latency pushed to field validation.

Closed: TF#1 is intended as iOS-only Layer 1. I did not find a backend contract dependency in S1-S5 beyond existing server WS traffic.

Closed: Loaded Barrel and voice-latency interactions are acknowledged rather than assumed as hard dependencies.

Not closed: Configure payload shape. Nesting was fixed, field names are now wrong.

Not closed: keyterm replacement. Replacement is acknowledged, but the combined list can violate Configure's 100-keyterm cap.

## Layer 1 latency remains a field hypothesis, not a plan guarantee

With Layer 1 only, `eot_timeout_ms=1500` provides a worst-case silence floor for non-empty speech if Flux does not cross `eot_threshold=0.5` earlier. It does not prove "eight" finalises in 700-1500ms in pre-deploy tests. Deepgram docs describe threshold direction and timeout behavior; they do not quantify single-word latency at 0.5. Keep the 700-1500ms target as a field gate, not an advertised deterministic outcome.

## `amend_ask_user_answered` must be added to iOS reconnect buffering

`ServerWebSocketService.send(_:)` currently buffers only `transcript`, `correction`, and `ask_user_answered` while disconnected. A new `sendAmendAskUserAnswered` built on `send(_:)` will be dropped during reconnect unless the whitelist/replay ordering is updated. That is exactly the bad case for mobile: eager answer is already committed, final correction arrives while backend WS is down, amend is dropped, stale value remains.

## TurnResumed with `answer: nil` is underspecified

S8 says TurnResumed sends `sendAmendAskUserAnswered(toolCallId, answer: nil)` "or just wait for the final." Those are different semantics. `nil` as "retract but do not replace" needs an explicit backend outcome, iOS UI/TTS cancellation behavior, and a state transition for the later final. Waiting for final avoids null handling but leaves stale optimistic TTS/state active longer. The plan currently leaves the implementer to choose inside the riskiest state transition.

# NIT

None.
