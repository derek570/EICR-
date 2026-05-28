# Claude Plan-agent adversarial review — Round 2

> Run 2026-05-25 via Plan-agent. Content captured verbatim from agent response.

**Closed from round 1 (verified):**
- Claude B2 (fictional `cancelAskUserAnswer`) — closed; PLAN_v2 replaces with `amend_ask_user_answered`.
- Claude B3 / Codex BLOCKER (ConfigureFailure tear-down) — closed via D8 (soft handling). New issues with D8 itself are escalated below.
- Claude B4 / Codex BLOCKER (no real 10s timer) — closed via S3 explicit `DispatchWorkItem`.
- Codex BLOCKER (Layer 3 `Finalize` is Nova-only) — closed via D2 (Layer 3 dropped).
- Claude I1 / Codex IMPORTANT (compile-time flag isn't a kill switch) — closed via D3 (UserDefaults runtime flag), modulo new issues below.
- Codex IMPORTANT (keyterms replacement vs append) — closed via D7 (cached canonical list).
- Claude N1 (line-number rot) — closed (PLAN_v2 uses symbol references).
- Claude I8 (single-chain risk) — closed via D5 (TF#1/TF#2 split).

Everything below is NEW or RE-OPENED.

---

## BLOCKER

### B1-v2. `amend_ask_user_answered` "turn still in progress" is undefined and structurally untestable

PLAN_v2 S7 says "if turn still in progress (`pendingAsks.history` not yet flushed), replaces the answer value and re-runs the resolver." There is no such thing as `pendingAsks.history` in the codebase — `pendingAsks` is the registry at `src/extraction/stage6-pending-asks-registry.js` which is a Map that gets a `Map.delete()` the instant `resolve()` fires (lines 88-99, "clearTimeout → delete → user resolve" is invariant Codex STG #3). Once the iOS eager dispatch has fired and the backend's `ask_user_answered` handler at `src/extraction/sonnet-stream.js:1778` has called `entry.pendingAsks.resolve(...)`, the entry is gone. There is NO lookup-by-tool_call_id afterwards because the dispatcher already awaited that promise and downstream `buildResolvedBody` (`src/extraction/stage6-dispatcher-ask.js:538-549`) has already:

1. Run the answer-resolver (e.g. `resolveValueAnswer`).
2. Called `autoResolveWrite(write, ...)` which actually fires the `record_reading` dispatcher.
3. The `record_reading` dispatcher has mutated `perTurnWrites.readings` Map.
4. Returned `tool_result` to `runToolLoop`.
5. `runToolLoop` has pushed a new user-message with that tool_result, called Sonnet again, and Sonnet has started streaming round N+1 (which usually contains a `speak_to_user` brief-confirmation block).

"Replaces the value and re-runs the resolver" handwaves all of that. By the time the amend arrives (~700-1500ms after the eager fired per PLAN_v2's own latency numbers), Sonnet has likely already emitted the confirmation `speak_to_user` and possibly even hit `end_turn`. The amend handler would need to:

- Find which `perTurnWrites.readings` entry was produced by the eager (the resolver does NOT stamp the entry with the tool_call_id; key shape is `${field}::${circuit}` per `stage6-per-turn-writes.js:43-44`).
- Mutate it in-place (the file's SHAPE LOCK comment at lines 17-39 explicitly forbids adding tool_call_id to the value).
- Decide what to do about the already-emitted Sonnet `speak_to_user` (which has already been streamed to iOS, played through Loaded Barrel, and may already be audible).
- Decide what to do if the model has already called `end_turn` — re-injecting a tool-result message to a closed turn requires either a new Sonnet round (an EXTRA `~$0.001` LLM hit per amend, contradicting the "trivial cost" claim) OR a separate "correction" code path that doesn't exist.

The plan calls this "~200 LOC + tests" in S7. It is more like a redesign of the per-turn-writes mutation semantics + a brand-new in-turn-correction state machine that needs to coordinate with `runToolLoop`'s rounds counter, the answer-resolver's pure-function contract, and the speak_to_user TTS-emission timing. **Re-escalates Codex's round-1 BLOCKER on the trust-and-accept path; the proposed amend path is just as structurally unsound.**

### B2-v2. Amend lands AFTER `pendingAsks.resolve()`; there is nothing left to amend against the registry

Follow-on to B1-v2 but distinct. PLAN_v2 S8 says the amend fires either on `TurnResumed` OR on `EndOfTurn` with a divergent final. Both of these happen AFTER the eager dispatch already sent `ask_user_answered`. The `ask_user_answered` arrives at the backend handler, hits line 1778 `entry.pendingAsks.resolve(msg.tool_call_id, resolvePayload)`, which:

1. `clearTimeout(entry.timer)` (line 91)
2. `asks.delete(toolCallId)` (line 92)
3. `entry.resolve({...})` — wakes the awaiting dispatcher promise

After step 2, the tool_call_id is no longer findable via `pendingAsks.entries()` (S7 says "Backend looks up the just-applied answer for that toolCallId"). The plan's lookup target doesn't exist. The implementer would need to add a side-channel "recently-resolved asks" buffer alongside `pendingAsks`, with its own TTL, FIFO cap, and concurrency-safe semantics — none of which appear in the LOC budget or test list.

### B3-v2. D8 "soft handling" of ConfigureFailure leaves iOS in a wrong-state lie

PLAN_v2 D8 says "Log, telemeter, do NOT trigger reconnect. Bail to whatever config Flux is currently running with." That's correct as a session-protection move but **leaves iOS state-machine internally inconsistent**. After `enterFocusedAnswerMode()` schedules the 10s timer and sets internal "focused-mode = active", iOS believes Flux is now running with `eot_confidence=0.4`, `eot_timeout_ms=1500`. If Flux rejects the Configure, Flux is actually still at `eot_confidence=0.7`, `eot_timeout_ms=5000`. The plan's iOS state machine then:

- Waits up to 10s for first final (the focused-mode exit trigger).
- Flux's real eot_timeout is 5000ms — first final won't come in the "1500ms floor" window.
- Inspector sees the same 5000ms latency they had before TF#1.
- Worse: if Layer 2 is also enabled, iOS waits for an `EagerEndOfTurn` that Flux is NEVER going to emit (eager_eot_confidence wasn't accepted), so the eager dispatch path silently dies, falling back to Layer 1 timing.

Plan needs explicit "on ConfigureFailure also clear iOS-side focused-mode state, cancel the 10s timer, and tell telemetry this is a wrong-state-lie scenario." That's an additional state-machine transition not in S1, S3, or S4. **Otherwise the kill-switch story for ConfigureFailure is "session-stable but silently slow with no observable signal."**

### B4-v2. Two-finals-in-1ms race (the original sprint bug) breaks the amend state machine

Plan S8 says: "On `TurnResumed`: send amend with null answer. On divergent `EndOfTurn`: send amend with corrected answer. On matching `EndOfTurn`: no-op." It does NOT handle the case proven in `tests/fixtures/voice-latency-scenarios/baseline/flux_misrecognition_socket_one.yaml`: **Flux emits TWO finals 1ms apart for the same audio**.

Apply the state machine to this case in Layer 2:
- Eager dispatch fires for the (anticipated) first final.
- First `EndOfTurn` arrives: text matches the eager → no-op (S8: "matching final is no-op"). `pendingEagerToolCallId` cleared? Plan doesn't say. `firedAskUserAnsweredToolCallIds.insert(toolCallId)` happens NOW per S8.
- Second `EndOfTurn` arrives 1ms later with DIFFERENT text. State machine has already cleared eager state. S8's "divergent final → amend with corrected answer" path requires `pendingEagerToolCallId` to still be set. It isn't. So the second final falls through to the legacy transcript path at `DeepgramRecordingViewModel.swift:2122-2138`, lands at the backend as a free-floating utterance against an empty pending-asks registry, gets classified as `no_pending_asks` overtake — **exactly the failure mode that motivated this entire sprint**.

Alternatively if the implementer reads the plan as "keep `pendingEagerToolCallId` until BOTH finals arrive," then the inverse race exists: a normal single-final case with `eot_confidence=0.4` could leave `pendingEagerToolCallId` set forever waiting for a second final that never comes, and the 10s timer-from-S3 doesn't cover this state field either (it covers entering focused-mode, not the amend state machine).

S8's state machine needs an explicit "guard window after first final" or "duplicate-final dedupe" path. Neither is specified. **Re-escalates Claude's round-1 B1.**

### B5-v2. No lock / serial queue around per-session state for the amend race

The amend handler is asynchronous (WebSocket message arrives), and so is the originating `ask_user_answered`, and so is the tool-loop iteration. Node.js's single-threaded event loop serializes between awaits, but the handler I sketched in B1-v2 (find write entry, mutate, re-emit) crosses multiple `await` boundaries (lookup is sync, but speak_to_user retraction would involve emitting a new WS message back to iOS, which awaits the WS send, etc). Between those awaits, another iOS message can be processed.

Concretely:
- iOS sends ask_user_answered (eager) at t=0.
- Backend handler line 1778 calls `pendingAsks.resolve(...)`; tool-loop continues asynchronously.
- iOS sends amend at t=500ms.
- Amend handler starts looking up the entry. **Has the tool loop finished round N+1 yet?** Could be either way.
- If tool loop is mid-write-dispatch (`autoResolveWrite` is async because the write dispatcher itself is async — see `stage6-dispatchers.js:260`), the amend could observe `perTurnWrites.readings` in an intermediate state.

There's no `entry.amendQueue` or `entry.isAmending` flag. Plan doesn't mention serialization at all. Codex's round-1 IMPORTANT on backend collision with voice-latency iOS work is a peripheral version of this same concern. **The amend handler needs the same isExtracting/pendingTranscripts queue treatment that handleTranscript has at `sonnet-stream.js:3249-3257`.**

### B6-v2. Runtime flag does not handle in-flight focused mode

PLAN_v2 D3/S5/S9 say "flag toggle takes effect on next ask_user." But what about NOW? Inspector turns off the flag DURING an active focused-mode window:
- 10s timer is still running.
- Flux is still configured at eot_confidence=0.4, eot_timeout_ms=1500.
- Layer 2's `pendingEagerToolCallId` might be set.
- Cached keyterms include focused-answer set.

Plan doesn't say whether toggling-off triggers an `exitFocusedAnswerMode()` immediately, or waits for the current ask to complete. If it waits: the inspector toggled OFF because focused-mode is misbehaving NOW, and they have to suffer through one more bad turn before relief. If it triggers immediate exit: the kill switch fires another Configure mid-stream, which has all the same failure surfaces as the entry Configure (ConfigureFailure → wrong-state lie per B3-v2). Neither path is specified.

Worse, S9 (Layer 2 flag) toggles off → does that ALSO trigger amend retraction for `pendingEagerToolCallId`? Almost certainly should, but plan is silent.

---

## IMPORTANT

### I1-v2. D6 "implementer must verify the Configure JSON shape" is the wrong layer to verify

The plan's D6 acknowledges the shape was wrong in round 1 (`eot_threshold` vs `eot_confidence`, top-level vs nested), then punts to the implementer to verify against `developers.deepgram.com/docs/flux/configure`. **This is exactly the kind of thing the plan should pin down**, because:

- The plan structures latency targets around this exact field's value (eot_confidence=0.5 → 700-1500ms claim).
- The plan structures Layer 2 around `eager_eot_confidence=0.4`.
- S1's "JSON encoder produces canonical shape" unit test cannot validate without knowing the canonical shape.
- iOS S1 sends actual Configure messages to live Flux, and the wrong field name fails silently (per D8 soft handling) — the implementer has zero CI signal that the field name is wrong.

PLAN_v2 should pull the verified shape inline (or commit to running a 10-min spike to confirm BEFORE S1 starts, with the spike output captured in the plan). "Implementer verifies" pushes a structural risk into the implementation phase where it'll be caught (if at all) only during TF#1 field testing, which then forces a re-rev. **At minimum, specify: field names to verify, whether keyterms replace-or-merge per docs (Codex round-1 IMPORTANT), and threshold-clear semantics (omit vs explicit null per Codex round-1 BLOCKER).**

### I2-v2. "1500ms Layer 1 floor accepted" arithmetic doesn't include Layer 1's actual minimum

The plan claims Layer 1 alone yields 700-1500ms. But Layer 1 (per S1-S5) sends Configure with `eot_confidence=0.5`, `eot_timeout_ms=1500`, AND `eager_eot_confidence=0.4`. The eager_eot_confidence parameter ENABLES `EagerEndOfTurn` event emission from Flux. In TF#1 (which does NOT do eager dispatch per S6 being TF#2), what happens when the `EagerEndOfTurn` arrives in iOS:

Looking at `DeepgramService.swift:1068-1075`, the existing code logs it and bails. PLAN_v2 doesn't add behavior to S4 for the eager event in Layer-1-only mode. So:

- Flux fires EagerEndOfTurn at ~300-500ms after speech end (low confidence threshold).
- iOS logs it, doesn't dispatch.
- Flux then waits to see if more speech comes.
- If silent, Flux fires EndOfTurn governed by eot_timeout_ms=1500 → final arrives at ~1500ms.
- If acoustic confidence rises, EndOfTurn arrives sooner (governed by `eot_confidence`, not the eager threshold).

So Layer 1's actual floor is `eot_timeout_ms=1500` for the silent-after-speech case (correct), but the "700ms" lower bound requires the EndOfTurn to fire on confidence alone before timeout. With `eot_confidence=0.5` on a single-word "eight", the semantic-low-content problem the plan opens with **still applies** to crossing 0.5. The plan should either:

- Stage the threshold lower for short-answer mode (e.g. eot_confidence=0.3 in focused-mode), OR
- Acknowledge Layer 1's realistic median is closer to 1500ms (the timeout floor) for the very class of utterances the sprint exists to fix.

The 700ms lower bound isn't justified by the math.

### I3-v2. `exitFocusedAnswerMode()` may double-fire across eager + final in Layer 2

PLAN_v2 S4 says "Exit on first final OR 10s timer OR alert dismissal." But in Layer 2 (S8), eager dispatch fires BEFORE the final. Does eager dispatch trigger `exitFocusedAnswerMode()`? Plan doesn't say.

### I4-v2. ConfigureSuccess echo isn't required by the plan — silent wrong-config risk

Codex's round-1 IMPORTANT-#1 asked for a smoke test that awaits ConfigureSuccess + asserts echoed thresholds + keyterm count. PLAN_v2 acknowledges D8 (soft-handle Failure) but does NOT acknowledge "verify Success echo content."

### I5-v2. Backend env-var kill-switch deploy timing is wrong

PLAN_v2 rollback section says "env var `VOICE_AMEND_ASK_USER_DISABLED=true` on backend task def, deploy via CI. ~30 min." Backend deploys at this org go via CI → infra-from-source which builds the task def, applies the ECS service update, and ECS does a rolling deploy. 30 min figure covers CI build only. ECS rolling deploy adds 5-10 min. Worse: PLAN_v2's iOS fallback for `amend_ack.accepted=false` is logically "silently wrong" — exactly what kill switches are supposed to prevent.

### I6-v2. Q7 "stacked asks" is open in PLAN_v2 but presented as non-blocking — it's a Layer 2 BLOCKER

iOS picks the toolCallId for the eager dispatch from `inFlightQuestion.toolCallId` (single-valued). If Q1's TTS finished, focused-mode entered, eager fired with Q1's toolCallId, then Q2's TTS started while inspector was still answering Q1 — the answer attributes to the wrong question on the iOS side, and backend dutifully resolves Q1's pendingAsk entry with the wrong text. PLAN_v2 hands this to the implementer to add a test fixture. That's offloading a Layer 2 BLOCKER as a "non-blocking" open question.

### I7-v2. Restore-defaults Configure may fail mid-restore, leaving Flux in focused mode forever

D8 soft-handling applies symmetrically to entry Configure AND restore Configure. If the restore Configure fails, iOS state machine clears focused-mode (10s timer fired, normal cleanup) but Flux is still at `eot_confidence=0.5`. **The next normal long dictation now runs under focused-mode thresholds** — that's the chop-risk on long dictation that Option A was rejected for.

### I8-v2. S10 telemetry as "graceful degrades" hides the failure mode this entire plan depends on observing

If S10 ships only as device logs, the field-test gate's pass criteria become un-measurable without manual export from a developer-build device. The "no dependency on voice-latency sprint" framing trades correctness for autonomy.

### I9-v2. Cost math undercount — amend handler may force an extra Sonnet round

If the amend arrives during/after Round 2's speak_to_user has emitted, Sonnet has already produced confirmation text. To honor an amend correctly, either re-emit writes + retract speak_to_user (no infrastructure exists), OR spin a new Sonnet turn — +1 turn at minimum, often +2 because Sonnet may decide to re-speak the confirmation.

---

## NIT

### N1-v2. PLAN_v2 mixes "eot_confidence" and "eager_eot_confidence" (D6) but tables still show "0.5" and "0.4" without naming the field.

### N2-v2. S7 LOC estimate ("~200 + tests") is implausible given B1-v2/B2-v2 scope. Closer to ~400-600.

### N3-v2. PLAN_v2's "two TestFlight chains" framing implies parallel chains but the field-test gate between them is sequential. Worth saying explicitly: TF#2 MUST NOT begin development until TF#1 field session passes.

### N4-v2. Q8 (app-backgrounding) handed to "implementer should add this in S3 or S4 as a single additional callback wiring" — verify the callback is actually reachable from `DeepgramService`, not just from the ViewModel.

### N5-v2. The composition table doesn't show "after TF#2 with divergent final + amend" case in the user-visible "TTS-end → Got it" row. If amend causes a corrective TTS, that row's number gets worse than the Layer-1 baseline.

---

## Verdict

**PLAN_v2 has gotten worse along one axis (S7 amend handler) while improving on others.** Round 1 closed the value-correction myth correctly by acknowledging the trust-and-accept path didn't exist. PLAN_v2's response — invent `amend_ask_user_answered` — looks like a one-line patch but is structurally a redesign of the per-turn-writes mutation model, the answer-resolver re-runnability contract, and the speak_to_user emission timing. B1-v2 through B5-v2 are all rooted in that single surface.

**Recommended round-3 path:** Either (a) ship TF#1 ONLY (drop Layer 2 entirely, accept the 700-1500ms floor as the final answer for this sprint), or (b) redesign Layer 2 to defer the eager `sendAskUserAnswered` to backend — iOS sends an `eager_intent` message that the backend buffers BEFORE calling `pendingAsks.resolve`, and only commits on EndOfTurn-match or amend-correction. That moves the race-prone state machine to the layer that owns the writes, where it belongs. Either path is much more honest than the current PLAN_v2 amend story.

The Q5 "drop Layer 3" decision was correct and well-reasoned. The Q6 runtime-flag decision was correct but underspecified (B6-v2). The Q1 "amend retract" decision is the round-2 hotspot — recommend either dropping or radically redesigning.
