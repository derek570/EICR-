# Codex Angles: Voice Latency Sprint

## A. Race conditions & ordering

### 1. Fast-path audio can overtake an older Sonnet MP3 already queued.
Risk: iOS may play "Circuit 8..." from a previous Sonnet turn after the new regex-fast "Circuit 7..." starts or finishes.
Why: Stage 6 confirmations are currently bundled from writes in `stage6-event-bundler.js`, while fast-TTS will be a new side path with its own network timing and playback queue. Signal: CloudWatch shows fast-TTS success before an older `result.confirmations` MP3 delivery, and the inspector reports out-of-order readbacks.
Mitigation: Put every confirmation on a single per-session, monotonic playback lane with `source_turn_id`/sequence numbers; drop or demote stale Sonnet audio once a newer readback is accepted.

### 2. Suppression keyed only by field, circuit, and value can suppress the wrong turn.
Risk: A stale Sonnet confirmation can be suppressed because it happens to share `{field,circuit,value}` with a later regex hit, or a later Sonnet confirmation can be suppressed by an old fast-path hit.
Why: The codebase already uses `source_turn_id`, pending ask registries, and 120 s `heard_value` dedup because values repeat naturally during EICRs. Signal: suppressed confirmations cluster around common values such as points `1`, `7`, `N/A`, `LIM`, or repeated Zs values across a session.
Mitigation: Include `session_id`, `board_id`, canonical field, canonical value, circuit ref, and a bounded turn/window id in the suppression record; expire on confirmation delivery, correction, board switch, and session end.

### 3. Sonnet streaming text can be voiced before dispatcher validation rejects or rewrites it.
Risk: Piping `messages.stream` directly into ElevenLabs can make the user hear a confirmation that never survives `stage6-dispatch-validation.js` or the tool loop.
Why: Stage 6 intentionally treats tool calls as the data path; text deltas may be exploratory, may precede an `ask_user`, or may be followed by a rejected `record_reading`/`wrong_board` retry. Signal: audio says a value was recorded, but no matching `record_reading` event or bundled confirmation appears for that turn.
Mitigation: Only stream natural-language audio from text classes that are known safe, and keep confirmation readbacks tied to committed dispatcher records rather than arbitrary assistant text deltas.

### 4. `ask_user` and `pending_write` can be interrupted by a fast confirmation for the same spoken value.
Risk: The inspector hears a fast readback for an orphaned or ambiguous value while Stage 6 is still blocking on "Which circuit is that for?", causing them to answer a question that no longer sounds relevant.
Why: The prompt and `stage6-tool-schemas.js` rely on `pending_write` to resolve values after a clarification; regex-fast TTS skips that context unless it knows the value is fully anchored. Signal: `ask_user.answer_outcome` shifts toward `user_moved_on`, `timeout`, or mismatched circuit answers immediately after fast-TTS launches.
Mitigation: Allow fast readback only for fully resolved writes, and mark unresolved regex hits as visual-only until the pending ask resolves.

## B. Audio session & playback

### 5. Deepgram pause-during-TTS can hide the inspector's next utterance or feed back the readback.
Risk: If iOS pauses Deepgram while TTS plays, the next dictated value can be clipped; if it does not pause, the readback can be re-transcribed as user speech.
Why: The sprint changes TTS timing from a 3-4 s gap to near-immediate overlap with the inspector's normal rhythm, and the chitchat-pause wake rules already treat regex hits as wake-worthy. Signal: transcripts contain phrases matching readbacks, or the first value after a confirmation is missing from both regex and Sonnet paths.
Mitigation: Add explicit client state for `tts_playing`, `mic_paused_for_tts`, and `post_tts_resume_ms`; ignore transcript frames fingerprinted to recent TTS text.

### 6. MP3 streaming may not produce audible audio at 700 ms on iOS even if the server is fast.
Risk: The backend may receive ElevenLabs chunks quickly but AVFoundation may buffer enough MP3 before playback that perceived latency remains over target.
Why: The existing web has dedicated `elevenlabs-tts` tests, but iOS playback behavior for partial MP3 frames, audio session activation, and route warm-up is the real critical path. Signal: server `tts_first_byte_ms` is low while iOS `playback_started_ms` remains high or varies by device.
Mitigation: Measure server first byte, iOS first decoded frame, and first audible playback separately; consider a client playback primitive that supports incremental MP3 reliably before declaring the latency target met.

### 7. Bluetooth route changes can break both mic capture and single-voice perception mid-session.
Risk: Starting streamed TTS can move the audio session between HFP and A2DP routes, changing mic availability, latency, and perceived voice quality.
Why: Inspectors may use Bluetooth ear defenders or vehicle/headset audio; a route flip during the new fast readback can force Deepgram reconnects or make the "same voice" sound like a different speaker. Signal: iOS route-change notifications correlate with Deepgram reconnects, missing finals, or complaints that the voice changed.
Mitigation: Log route/category/mode before TTS, during playback, and after resume; test built-in speaker, AirPods, Bluetooth headset, and wired routes before rollout.

## C. Cost & quota

### 8. Regex false positives become paid ElevenLabs calls instead of cheap local UI mistakes.
Risk: A matcher that was tolerable for instant visual fill can become expensive when every hit sends fast-TTS to ElevenLabs.
Why: The current Sonnet path gates confirmations through confidence, dispatcher writes, and bundling; regex-fast TTS bypasses those filters and can fire on chitchat, duplicate finals, or Deepgram alternates like "Socket 1." Signal: ElevenLabs calls per certificate rise faster than committed writes per certificate.
Mitigation: Require a high-confidence regex class, idempotency key, and "committed local field write" before fast-TTS; track cost per accepted regex write, not just per session.

### 9. Silent fallback can double spend when fast-TTS fails late.
Risk: A failed, cancelled, or timed-out fast-TTS request may still consume ElevenLabs quota, then Sonnet later generates the normal confirmation and spends again.
Why: The locked fallback is silent, so the user will not notice; the system may count only successful playback while the vendor bills for started streams. Signal: vendor usage exceeds app-side `tts_success` events, especially around network drops or iOS backgrounding.
Mitigation: Add idempotency keys and terminal status logging for `requested`, `first_byte`, `cancelled`, `playback_started`, `playback_completed`, and `fallback_sonnet_spoke`.

### 10. Streaming Sonnet into ElevenLabs can synthesize tokens that are later obsolete.
Risk: If Sonnet starts a sentence and then emits tool calls or changes course, ElevenLabs may have already generated audio that should never be heard.
Why: The Stage 6 tool loop sorts `ask_user` to the end and commits writes before blocking, but text streaming has no equivalent finality unless you add one. Signal: TTS bytes generated per audible second climbs after Sonnet streaming is enabled.
Mitigation: Gate streaming TTS to explicit response segments or committed confirmations, and measure discarded audio bytes/tokens as a first-class cost metric.

## D. Wire format & compatibility

### 11. New fast-TTS wire messages can strand one side of the TestFlight/backend pair.
Risk: A backend that emits a new message type or expects a new client ack can break the current TestFlight build until `deploy-testflight.sh` ships the matching iOS app.
Why: This backend is shared with iOS and the repo already has protocol-version handshake tests for `sonnet-stream`; a voice-path change is still a wire-format change. Signal: unknown message type logs, no playback ack, or ALB-held WebSocket sessions with backend work continuing.
Mitigation: Put the fast path behind a protocol capability bit negotiated at session start, and keep the backend default off until the TestFlight build with that bit is live.

### 12. Suppression keys must include `board_id`, not just circuit ref.
Risk: In a multi-board certificate, "circuit 7 points 7" can exist on two boards, and suppressing by circuit number alone can hide the wrong confirmation.
Why: Production state is `boards[]` plus `circuits[]` with `board_id`, while many older paths and spoken readbacks still talk in circuit refs. Signal: duplicate suppression events appear after `select_board`/`add_board`, or board B writes are followed by board A audio suppression.
Mitigation: Canonicalise suppression and telemetry keys through the same multi-board resolver that Stage 6 uses, and include current board plus spoken board context when present.

## E. Telemetry & observability

### 13. Success-only latency telemetry will make silent fallback look good.
Risk: Dashboards can show a 700 ms fast path by excluding failures where Sonnet caught up at 3-4 s.
Why: The fallback is intentionally silent, which is good UX but dangerous for measurement; failed fast attempts still affect cost and trust. Signal: p50 fast latency improves while p95 audible confirmation latency or "no readback heard" reports do not.
Mitigation: Emit one correlation id per intended confirmation and record its final outcome: fast heard, Sonnet fallback heard, suppressed, dropped stale, failed before vendor, failed after vendor, or never played.

### 14. Mixed clocks can invent or hide latency regressions.
Risk: Combining iOS regex timestamps, backend receipt time, ElevenLabs first byte, and iOS playback time without clock discipline can produce meaningless latency numbers.
Why: The repo already distinguishes server-side CloudWatch events from iOS behavior; the sprint target is user-perceived audio, not server response. Signal: negative segment durations, impossible ordering, or device-specific latency deltas that vanish when measured with monotonic local spans.
Mitigation: Use per-hop monotonic spans with parent correlation ids, and compute end-to-end perceived latency on iOS from utterance-final receipt to playback start.

### 15. Suppression telemetry can undercount duplicates and overcount savings.
Risk: A "suppressed Sonnet TTS" metric can claim savings even when Sonnet audio was never going to be generated, or miss duplicates already queued on iOS.
Why: `stage6-event-bundler.js` only creates confirmations under specific conditions, and iOS has its own confirmation-mode dedupe/suppression layer. Signal: suppression counts do not reconcile with bundled confirmation counts, playback queue drops, or ElevenLabs request counts.
Mitigation: Log suppression at the decision point with the candidate confirmation payload, whether audio had been requested, and whether any client-side audio was dropped.

## F. Rollout & rollback

### 16. Mid-session feature-flag flips can create half-fast, half-slow certificates.
Risk: A flag change while a certificate is active can reset suppression state, alter playback ordering, or change what the inspector expects within the same inspection.
Why: This app has long live sessions with WebSocket state, chitchat-pause state, pending asks, and doze heartbeat behavior; a session-level invariant matters more than an instant global toggle. Signal: logs show `fast_tts_enabled` changing for the same `sessionId` or cert after first audio.
Mitigation: Snapshot voice-latency flags at session start and include them in every telemetry event; allow emergency server kill switches only to disable new requests while preserving in-flight ordering.

### 17. Backend ENV flags can drift from source and from the iOS build.
Risk: A flag default in code, `ecs/task-def-backend.json`, and the TestFlight build can disagree, producing behavior that cannot be reproduced locally.
Why: The handoff explicitly calls out task-def env drift and `scripts/check-task-def-env-drift.sh`; this sprint adds multiple flags that must be inspected together. Signal: staging/prod behavior differs despite the same commit, or fast-TTS appears enabled without the iOS capability bit.
Mitigation: Land flag reads, task-def values, and protocol capability names in the same commit; add a startup log summarising effective voice-latency flags.

## G. UX edge cases

### 18. A 700 ms readback can collide with the inspector's next dictated value.
Risk: The current 3-4 s delay is bad, but it also gives the inspector time to stop speaking; near-immediate audio can interrupt their natural batch dictation.
Why: EICR readings often come in runs, and Flux emits finals on pauses; a fast readback between two values may be captured as noise or cause the inspector to repeat themselves. Signal: after enabling fast-TTS, duplicate corrections and "no, ..." utterances increase even though latency improves.
Mitigation: Add a short client-side debounce or barge-in policy: delay readback while speech activity is present, or duck/cancel readback when the inspector resumes.

### 19. Corrections need a different audio contract from first writes.
Risk: If the inspector says "no, make that 17", suppressing or fast-confirming like a normal write can leave them unsure whether the correction replaced the prior value.
Why: Stage 6 has same-turn correction and last-occurrence-wins machinery; regex-fast TTS may only see the latest local hit without understanding correction semantics. Signal: local state changes from `7` to `17` while the audio heard was only "Circuit 7, points 17" or, worse, no correction readback because `{field,circuit,value}` matched stale state.
Mitigation: Treat corrections as their own confirmation class, e.g. "Circuit 7 points changed to 17", and invalidate prior suppression entries for that field/circuit.

## H. Data correctness

### 20. iOS regex state and backend Sonnet state can diverge silently.
Risk: The inspector may hear a fast confirmation for the iOS-local value while the backend later writes a different canonical value or rejects the write.
Why: The brief says regex fills at about 40 ms on iOS, but Stage 6 still owns backend writes, board focus, validations, and final certificate state. Signal: client-visible values differ from `stateSnapshot` after the Sonnet turn, especially for `LIM`, `N/A`, decimal normalisation, and circuit descriptors misheard as numbers.
Mitigation: Send the regex write intent to the backend with canonical field/value/board context and reconcile it against Stage 6 writes; surface conflicts as correction prompts instead of quiet overwrites.

### 21. Fast-TTS can bypass filled-slot, cached-prefix, and validation guards.
Risk: The system can audibly confirm a value for a field that Stage 6 would have refused to ask about, refused to overwrite, or scoped to a different board.
Why: `filled-slots-filter.js`, the cached-prefix rule, and dispatcher validation exist because naive confirmations caused repeated asks and bad writes; a new endpoint can reintroduce that class of bug outside the tool loop. Signal: fast readbacks occur for already-filled slots, wrong-board writes, out-of-range circuits, or values later classified as `validation_error`.
Mitigation: Move fast-TTS eligibility to the server or mirror the exact server validators in a shared module; never read back before the candidate write passes the same no-clobber and board checks.

## I. Anything else

### 22. Same ElevenLabs voice ID is not enough to guarantee the same voice.
Risk: The fast path can sound different from the Sonnet path if it uses a different ElevenLabs model, stability/similarity settings, punctuation, text normalisation, or streaming endpoint.
Why: The constraint is "single voice", but users perceive model/prosody drift as a voice change even with the same clone ID, especially on short UK technical readbacks. Signal: field reports say the voice changes mid-session while logs show the same voice ID.
Mitigation: Pin model, voice settings, text normaliser, and pronunciation format for both paths; log them per request and run A/B audio samples before rollout.
