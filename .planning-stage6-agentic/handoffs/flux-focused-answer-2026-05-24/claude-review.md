# Claude Plan-agent adversarial review

> Run 2026-05-25 via Plan-agent (read-only). Agent could not write to disk;
> content captured here verbatim from agent response.

## BLOCKER

### B1. `firedAskUserAnsweredToolCallIds` blocks the "follow-up" final after eager dispatch — value-correction path does NOT exist for stage6 alerts

PLAN.md S6 / Q1=(a) claims false positives "ride the existing value-correction
flow". Walk the path against `DeepgramRecordingViewModel.swift:2039-2120`. The
eager dispatch fires `sendAskUserAnswered("eight")` and immediately:
- Line 2049: `firedAskUserAnsweredToolCallIds.insert(toolCallId)` — gate slams shut
- Line 2074: `inFlightQuestion = nil`
- Line 2116-2117: `alertManager.dismissCurrentAlert()` for `stage6_ask_user`

When the final "eight point five" arrives ~700ms later, line 2041's
`!firedAskUserAnsweredToolCallIds.contains(toolCallId)` is FALSE →
`stage6Substantive = false` → falls to else branch at line 2122 → goes out as
a plain `serverWS.sendTranscript("eight point five", inResponseTo: nil, ...)`.
Meanwhile `AlertManager.processTranscriptForResponse` at AlertManager.swift:317
EARLY-RETURNS for `stage6_ask_user` alerts ("must NOT also try to interpret
the reply locally"), and `extractCorrectionValue` at AlertManager.swift:457
only runs when `currentAlert != nil && isAwaitingResponse` — but the alert was
dismissed at line 2117.

**There is no value-correction flow for stage6 ask_user replies.** The "eight
point five" transcript lands on the backend as a generic utterance against an
empty pending-asks registry (`classifyOvertake` returns `no_pending_asks`). It
may get extracted into the wrong field, or silently ignored — either way
Sonnet has already committed `8` and there is no correction.

### B2. `cancelAskUserAnswer(toolCallId:)` referenced by PLAN.md L148 does not exist

The plan describes the retract path as "Send a retract via the existing
`turnId` channel (`ServerWebSocketService.cancelAskUserAnswer(toolCallId:)`)".
`grep` across iOS + backend finds zero references to `cancelAskUserAnswer`,
`cancel_ask_user`, `ask_user_canceled`. `ServerWebSocketService.swift:581` has
only `sendAskUserAnswered` — no cancel verb. The plan's "Decision deferred to
Derek" is moot because the path the plan offered as an alternative is
fictional. Q1=(a) was locked, so this doesn't block the recommended path, but
it should be removed from the PLAN.md prose so it doesn't mislead the
implementer.

### B3. Configure mid-stream during `pauseAudioStream()` — semantics unverified and `ConfigureFailure` triggers a connection-failure tear-down

PLAN.md S3 fires `enterFocusedAnswerMode()` at `onAlertTTSStarted` (line 2600
trigger). Looking at the actual code path: `onTTSPlaybackStarted` at
DeepgramRecordingViewModel.swift:850-851 calls
`deepgramService.pauseAudioStream()` BEFORE `onAlertTTSStarted` fires. So the
Configure message is sent while the audio stream is paused. `pauseAudioStream`
at DeepgramService.swift:566 only flips `isStreamingPaused = true` — the WS
stays open, so the send is *technically* possible. But:

- The Deepgram blog post the plan cites talks about Configure during *active
  streaming* (OTP-entry use case). Nothing in the plan's web research verifies
  behaviour when zero audio frames are flowing — Flux's turn-detection model
  might not be in a settled state to accept a Configure.
- DeepgramService.swift:877-880 handles `ConfigureFailure` by calling
  `notifyError(DeepgramServiceError.connectionFailed("Flux ConfigureFailure"))`.
  With `shouldReconnect = true` (the default during a live session), this will
  trigger `scheduleReconnect()` at line 1187 — full WS teardown + key fetch +
  reconnect — exponential backoff starting at 1s. A single Configure typo or
  transient rejection during a focused answer kills the entire Deepgram
  session and the inspector is mute for 1-30s of backoff. S1 must change
  ConfigureFailure handling to NOT call `notifyError`; treat it as a soft
  warning instead.

### B4. No timer exists for "10s focused-mode exit timeout"

PLAN.md S3 says "exit on first final OR 10s timeout". The
`inFlightQuestionStaleWindow = 10.0` at DeepgramRecordingViewModel.swift:2540
is passive — only checked when a transcript happens to arrive
(`takeInResponseToPayload` line 2848-2853). There is no `DispatchWorkItem`
scheduled at TTS-start that fires "if nothing happened in 10s, restore
defaults." If the inspector says nothing at all, the focused-mode config
(eot_threshold=0.5, eot_timeout_ms=1500) persists until the next utterance,
or forever if the session goes idle. S3 must explicitly schedule a
`DispatchWorkItem` and cancel it on first final / EagerEndOfTurn — that's not
"reuse existing state", it's new lifecycle machinery.

## IMPORTANT

### I1. Compile-time "safety valve" is not actually a 30-second kill switch

PLAN.md S6 introduces `VOICE_FOCUSED_ANSWER_EAGER_DISPATCH` as a compile-time
flag, then S5+S6 ship together because the flag is the "safety valve". Per
`CertMateUnified/CLAUDE.md:110-122`, flipping this flag means: edit code →
`./deploy-testflight.sh` → bump build number → archive (5-15min) → patch
onnxruntime → upload (5-30min) → wait for App Store Connect processing
(15-60min) → add to Electricians external group → **beta review submission**
(Apple queue, 0-24h). The "safety valve" is a 1-6+ hour operation in the best
case, days if Apple holds review. If the eager dispatch is firing badly in
the field, the inspector eats that for hours before the rebuild lands. A
*runtime* flag (UserDefaults / launch arg / remote config) would be a real
safety valve. The plan's Q4 reasoning ("compile-time flag is the safety valve
if eager dispatch needs to be killed") underestimates this materially.

### I2. Barge-in race: focused-mode entry happens, then barge-in cuts TTS, but exit signal never fires

`onAlertTTSFinished` only fires on natural completion (AlertManager.swift:1292:
`if naturalCompletion, let alert = currentAlert, !isResolving`). On barge-in,
`stopAllSpeech(suppressCooldown: true)` calls `markTTSFinished(skipCooldown:
true)` with `naturalCompletion: false` — `onAlertTTSFinished` is suppressed
(line 1276-1294 comment explicitly documents this to prevent re-anchoring
`inFlightQuestion.askedAt`). PLAN.md says exit on "first final OR 10s
timeout" — but the more common case in the field is "Sonnet asks Q1, inspector
barges in mid-question with 'eight'", and the focused-mode entry never had a
clean TTS-start (barge-in fired BEFORE TTS finished or even started in some
cases). Either focused-mode never gets entered (TTS-start gate), or it gets
entered but never gets the natural-completion exit signal — relying on
Layer 3's 10s VAD timeout instead.

### I3. Stacked asks: two `ask_user_started` in flight, focused-mode state is single-valued

`pendingInFlightQuestions` is a FIFO (DeepgramRecordingViewModel.swift:2572)
and `inFlightQuestion` is a single Optional slot (line 2505). The plan's
`enterFocusedAnswerMode()` is implicitly stateful too. Scenario: Sonnet emits
Q1 ("which circuit"), TTS plays, focused-mode entered (Configure → eot=0.5).
Inspector ignores. Sonnet times out / emits Q2 ("did you check OCPD") before
any answer. Q2's TTS-start fires `handleAlertTTSStarted` again — what does the
plan do? Send another Configure with focused params (no-op, already there)?
Reset the 10s timer? When inspector finally answers "yes" — is that Q1 or Q2's
eager dispatch? `firedAskUserAnsweredToolCallIds` is keyed per-toolCallId so
the gate doesn't help here. The plan is silent on stacked asks.

### I4. Replay harness cannot validate the actual hypothesis

The plan claims fixtures under `tests/fixtures/voice-latency-scenarios/focused-answer/`
will validate "single_digit_answer_eight at <800ms." Confirmed by reading
`scripts/voice-latency-bench/transcript-replay.mjs:1-30,348` — the harness is
a "simulated Deepgram" that POSTs `type: 'transcript'` directly to the backend
session WS. It does NOT exercise Flux, does NOT send PCM, does NOT receive
`EagerEndOfTurn` events. The new fixtures can only validate iOS-state-machine
round-tripping (assuming the harness is also extended to drive the iOS app,
which it isn't today — it talks to the backend). The "<800ms" target requires
actual Flux at eot_threshold=0.5 processing actual PCM of someone saying
"eight" — none of which the existing harness does. Either (a) build a new
Flux-driving harness (much more work than implied), or (b) admit pre-deploy
validation is "tests prove S1-S8 wiring is plumbed" and the latency target is
only validated in Derek's field session.

### I5. The "restore-defaults" Configure needs canonical session keyterms, which aren't cached

PLAN.md L122-127 shows the restore Configure includes `"keyterms": [<session-default
keyterms from KeywordBoostGenerator>]`. Two problems:

1. The actual keyterms sent at session start are filtered by URL length at
   DeepgramService.swift:710-720 — iOS drops keyterms when the URL would
   exceed 2000 chars. There's no cached "what was actually sent" — only the
   input list. The restore would have to either re-run the URL-length filter
   (now meaningless since Configure is JSON) or send all keyterms (potentially
   more than originally accepted).
2. With Q3=(a) "append to session defaults", the focused-mode Configure adds
   ~31 question terms to existing ~80-90 board terms. Sending and immediately
   reverting these means two large JSON messages per focused answer. Not
   catastrophic, but the plan implies the restore is "the original list" —
   which is undefined.

### I6. Plan never specifies what happens if the inspector backgrounds the app mid-focused-answer

Audio session interrupt path tears the WS down. Focused-mode state on a Swift
singleton may persist across the interrupt — when the user returns and a new
WS connects, the URL is built fresh with eot_threshold=0.7 defaults. The state
machine flag still says "focused-mode active" but Flux doesn't know. No-op on
the next final-arrival? Sticks until the timer-that-doesn't-exist fires (see
B4)? Worth a sentence.

### I7. Layer 3 needs a third Silero instance — not "~½ day"

Looking at Silero usage: `SleepManager` runs Silero for long-silence wake
(RecordingSessionCoordinator.swift:419), `BargeInDetector` runs Silero during
TTS (BargeInDetector.swift:61). Both have their own LSTM state and the
BargeInDetector comment at line 12-13 explicitly says "Separate Silero
instance" because sharing would either corrupt or lag state. A Layer 3
"300ms silence after speech in focused mode" requires either a third instance
(memory, model load, state machine) or careful reuse of an existing one —
neither is "½ day." More like 1-1.5 days, plus barge-in/Layer 3 interaction
tests.

### I8. The "single dispatch chain S1-S8, no Derek gate" combined with compile-time-flag safety contradicts the rollback story

PLAN.md L182-185 says S1-S8 ship as one chain. Layer 1 (S1-S4) is the
actually-low-risk part — Configure mid-stream + keyterms. S6 (eager dispatch)
is the risk surface. Shipping everything in one chain means: if the field
session reveals the eager-dispatch correction case (B1) is bad, the "soft
rollback" is a recompile. The plan should ship S1-S4 as one chain, observe in
the field for at least one session, THEN ship S5-S8 as the second chain.
Otherwise the safety story is "Derek will catch it during 5 ask_user moments
in one field session" — which is too narrow to surface (B1) since it requires
the inspector to specifically self-correct mid-eager.

## NIT

### N1. Doc anchor drift — line numbers will rot

PLAN.md cites specific line numbers (e.g. "DeepgramRecordingViewModel.swift:2600",
":2489-2509", ":2078", ":2090"). These are accurate today but will drift the
moment the implementer touches the file. Prefer symbol references
(`handleAlertTTSStarted`, `InFlightQuestion` struct, `sendAskUserAnswered`
call site at end of stage6Substantive branch) so the plan stays usable across
edits.

### N2. LOC estimate (~430-550) plausible for S1-S5 only

S1 (~40), S2 (~60), S3 (~30 + new timer + cancellation = closer to ~60), S4
(~50), S5 (~80) totals ~290. S6 (~80 + delegate plumbing + eager-state field +
the proper "what happens on follow-up final" handling per B1 = closer to ~150).
S7 (~50 + Silero instance setup per I7 = ~120). S8 (~40). Realistic total is
more like ~580-720 LOC. Estimate isn't wildly off but is optimistic on S6/S7.

### N3. Telemetry hookup to `voice-latency-telemetry.js` (S8) assumes that file exists in the iOS sprint scope

PLAN.md S8 lists `voice-latency-telemetry.js` as "(read-only consumer)". That
file is part of the in-flight voice-latency-2026-05-23 sprint. If that sprint
hasn't merged yet (HANDOFF.md L57 implies it ships "alongside, not inside"),
S8 has an undocumented sequencing dependency.

### N4. Plan understates Loaded Barrel intersection

`AlertManager.swift:895` already passes `turnId` into TTS calls, and
`DeepgramRecordingViewModel.swift:7358` captures `extractionTurnId`. If the
eager dispatch + premature TTS confirmation lands a turnId-tagged cached MP3
in Loaded Barrel's cache (LRU=20, TTL=15s per LOADED_BARREL_PLAN_FINAL.md
L77), then "Got it, eight" is cached, then the corrected "actually, eight
point five" comes in and the new TTS has a different turnId → cache miss
(per the design at line 73). No corruption, but the optimistic cache
speculation Loaded Barrel does at this moment becomes pure waste for the
false-positive case. Worth noting in the composition table on PLAN.md L256.

### N5. PLAN.md L13 "No backend changes" not strictly true if eager dispatch is tagged

PLAN.md S6 says "tagged `eager: true`". The backend's `ask_user_answered`
handler at `src/extraction/sonnet-stream.js:1451-1494` doesn't read any
`eager` field. Either iOS sends an `eager` field and the backend ignores it
(harmless, but document it), or "tagged eager: true" is iOS-internal-only
telemetry (clarify the wording). The plan is ambiguous; the implementer might
add a backend change inadvertently.
