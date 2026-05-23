# Codex review — PLAN.md (voice-latency-2026-05-23)

## Verdict
Do not execute this plan yet: the latency targets, duplicate-suppression/race model, and pooled ElevenLabs WebSocket design are not internally consistent enough for a production sprint.

## BLOCKERS
### B1. Latency budget does not add up to the stated targets
**Where:** PLAN.md §2, §3.A, §5.2, §7.6  
**Problem:** Stage 2 cannot honestly claim 1.2-1.8s from the numbers in the plan. Even using the optimistic column: 40 + 5 + 30 + 50 + 700 + 500 + 30 + 150 + 100 = 1,605ms. Using the research-backed Sonnet 4.6 P50 of 1.42s plus tool-use finalisation gives roughly 2.2-2.8s before audio is playable. The plan also treats ElevenLabs first byte as iOS first-audible, but §3.A says AVAudioPlayer cannot stream MP3; Strategy A accumulates the full response, so first-audible includes full synthesis time, not TTFB. Stage 4 also omits the cold 800ms BOS/model-load delay that §7.6 cites unless the pooled socket is already warm.  
**Fix:** Recompute budgets with separate rows for vendor TTFB, full MP3 completion, iOS first decoded frame, and iOS first audible. Gate Stage 2 targets on the actual Stage 0 playback strategy: Strategy A means "whole-blob streaming source" and should not use first-byte math. Include cold/warm fast-path budgets separately.

### B2. The suppression and race design does not prevent double or stale readbacks
**Where:** PLAN.md §6.2, §7.1, §7.4, §14  
**Problem:** The plan says an async mutex serialises eligibility check plus suppression write, but the suppression entry is written only on `isFinal`. If the mutex is released before synthesis completes, both Sonnet and fast-path can pass the check and both call ElevenLabs. If it is held until `isFinal`, it serialises the slow vendor call and still does not prove iOS heard the audio. This also misses the requested races: two regex-fast requests can complete out of order, Stage 2 confirmation audio can be arriving while Stage 4 fast audio for a different field arrives, and older Sonnet audio can remain queued after a newer accepted fast readback. The plan says "single playback lane", but it does not define monotonic sequence numbers, cancellation, stale-drop rules, or queue ownership across HTTP responses.  
**Fix:** Add a per-session audio arbiter with monotonic `utteranceId`/`turnId`/`audioSeq`, and use suppression entries with states like `reserved`, `synthesising`, `first_byte`, `client_queued`, `played`, `failed`. Reserve the key before calling ElevenLabs, share that reservation between `/api/proxy/elevenlabs-tts` and `/api/voice-latency/regex-fast-tts`, and require iOS playback acks before recording `fast_heard`. Define ordering for same-field and different-field audio explicitly.

### B3. Fast TTS can confirm a value that Sonnet later turns into an ask_user
**Where:** PLAN.md §7.2, §7.4, §7.5  
**Problem:** Checking current `pending_write`/`pending_ask` only catches ambiguity that already exists before the fast request. It does not catch the important case where iOS regex fast-confirms "Circuit 7, points 7", then Sonnet emits `ask_user` because the transcript was ambiguous or contests the target field/board. The proposed `field_corrected` recovery only covers later committed corrections; it does not cover "I need clarification" or rejected writes where no correction event fires. That leaves the inspector hearing a confident confirmation immediately followed by a contradiction or question.  
**Fix:** Treat fast-path audio as eligible only when the backend can prove the candidate is fully anchored from current session state and transcript context, not just field-schema valid. Reject multi-candidate turns, board/circuit ambiguity, answer-to-ask turns unless they map to the active ask, and any utterance where Sonnet could reasonably need a clarification. Add an explicit `fast_contested_by_ask_user` test and telemetry outcome.

### B4. Session-pooled ElevenLabs stream-input is not a safe abstraction
**Where:** PLAN.md §7.6  
**Problem:** The claim "same WS = same voice context = no inter-request voice drift" is undocumented in the research. More importantly, `stream-input` is a single audio stream with untagged audio frames. Reusing one WS for multiple logical HTTP requests creates routing and ordering problems: audio frames do not identify which confirmation they belong to, EOS closes the socket, and `flush` is not a documented request boundary with per-request finality. The transient-WS fallback for concurrent fast-paths narrows the problem but does not define safe ownership of the pooled socket.  
**Fix:** Remove the voice-continuity claim. Start with one ElevenLabs request per logical audio item, or use a deliberately pre-warmed idle socket that is exclusively leased to one item and then closed/replaced. If true multi-item pooling is desired, evaluate ElevenLabs' multi-context endpoint separately and prove audio-frame correlation in Stage 0 before adding it to the sprint.

## IMPORTANT
### I1. Several Codex angles are marked addressed but are only logged or partially handled
**Where:** PLAN.md §5.4, §7.4, §8.1, §14  
**Problem:** Coverage is overstated. #1 lacks monotonic queue/stale-drop semantics. #2 omits the bounded turn/window id from the suppression key. #5 is mostly "unchanged from today" despite faster TTS changing the mic-collision risk. #7 is telemetry only, not mitigation. #9 idempotency does not prevent vendor billing once a stream starts. #10 is still present in Stage 5. #13 records `fast_heard` server-side before client playback. #18 says Deepgram FINAL means the inspector paused, which is not enough for batch dictation. #20 treats correction-after-wrong-audio as acceptable, but that is still a false confirmation. The risk register also collapses multiple ordering bugs into one "Sonnet vs fast-path" row.  
**Fix:** Add a 22-row traceability table with concrete mechanism, tests, and remaining risk for each Codex angle. Do not count telemetry-only items as mitigated.

### I2. The 60s suppression TTL is a guess and likely too broad
**Where:** PLAN.md §6.2, §12, §14  
**Problem:** The duplicate window only needs to cover Sonnet lag plus audio queue delay for the same utterance. A fixed 60s TTL can suppress legitimate repeats, retests, or "say it again" behaviour for the same circuit/field/value during an inspection. Stage 3's claim that suppression rate should be 0% before Stage 4 is also unsafe because repeated same-value Sonnet confirmations within 60s would now be suppressible.  
**Fix:** Derive TTL from measured p99 Sonnet completion plus playback queue p99, probably closer to 10-15s unless Stage 0 says otherwise. Better: include `utteranceId`/turn window in the suppression record and expire once the matching Sonnet duplicate is seen or the next relevant turn begins.

### I3. Silent fallback and idempotency do not prevent double spend
**Where:** PLAN.md §5.1, §5.2, §9.3  
**Problem:** "Cancel WS, charge no second call via idempotency" is not a safe billing assumption. If ElevenLabs has accepted text or emitted bytes, the vendor may bill even if the app later destroys the response. A Sonnet fallback uses a different path/text/key, so a 30s in-memory idempotency cache will not de-duplicate it.  
**Fix:** Track `requested`, `text_sent`, `first_audio`, `cancelled`, `client_played`, and `fallback_spoke` separately. Do not immediately batch-fallback inside the same endpoint after a streaming call has started unless the product explicitly accepts possible double spend.

### I4. Capability negotiation conflicts with the "no iOS code change" Stage 2 story
**Where:** PLAN.md §4.3, §5.2, §9.1  
**Problem:** §4.3 says features are AND-gated against iOS capabilities and old builds without `msg.capabilities` get current behaviour. §5.2 says Stage 2 needs no iOS code change and streams confirmations through the existing endpoint. Both cannot be true if `stream_confirmations`/`chunked_mp3` capability is required. The plan also relies on `req.body.source === 'confirmation'`, which old iOS callers likely do not send.  
**Fix:** Specify exact effective behaviour when `msg.capabilities` is undefined: `supports=[]`, all capability-gated features false. Then decide whether Stage 2 intentionally requires the TestFlight build or is endpoint-only and safe for old iOS. Add tests for missing `capabilities`, missing `source`, unknown capability strings, and mismatched server flag/client capability.

### I5. Stage 5 partial-JSON streaming is probably the wrong implementation target
**Where:** PLAN.md §8.1, §10.1  
**Problem:** For Sonnet tool inputs, Research APIs §B.2 says without `eager_input_streaming` you may not receive useful partial key/value content early, and for these small `ask_user` JSON objects the block may be essentially complete by the time `.question` is extractable. A general streaming JSON parser adds dependency and complexity, while the useful field could be found with a small state machine over the accumulated `partial_json` buffer. The 500ms holdback also does not eliminate half-question playback unless all audio is withheld until `content_block_stop`.  
**Fix:** Prototype first. Prefer accumulating `partial_json` and extracting `.question` with a focused string-field extractor that handles escapes, or skip Stage 5 unless measured savings remain after holding audio until `content_block_stop`.

### I6. The fast-eligibility whitelist needs field-schema verification
**Where:** PLAN.md §7.3  
**Problem:** The whitelist appears both too tight and slightly risky. Obvious high-value, regex-friendly supply fields such as Ze and PFC are missing. Ring-final values (`ring_r1_ohm`, `ring_r2_ohm`, `ring_rn_ohm`) are deferred but likely common enough to decide explicitly. `polarity_confirmed` may be too loose if an inspector says a batch phrase such as "polarity confirmed" without a specific circuit anchor. `r1_r2_ohm` vs `r1_plus_r2` must be checked against `field_schema.json` and actual iOS regex output names.  
**Fix:** Build the whitelist from canonical schema keys and production regex telemetry. For each field, document accepted transcript shape, required circuit/board anchor, validation rule, and known false-positive phrases.

### I7. Transport references are inconsistent
**Where:** PLAN.md §0, §3.E, §5.2, §7.1  
**Problem:** The executive summary says chunked MP3 goes over the existing iOS WS, Stage 0.E tests iOS WS chunk throughput, but §5.2 and §7.1 use HTTP responses for audio. These have different buffering, cancellation, auth, and ordering behaviours. Testing WS chunk jitter does not prove chunked HTTP playback works, and vice versa.  
**Fix:** Pick the transport per stage and make Stage 0 tests match it. If confirmations remain HTTP, test `URLSession` chunk receipt and playback. If audio is moved onto the recording WS, define new message types, backpressure, binary/text framing, and capability negotiation.

### I8. Telemetry names overstate what is actually observed
**Where:** PLAN.md §4.1, §6.2, §7.2  
**Problem:** The backend records `fast_heard` on ElevenLabs `isFinal`, but that only means the vendor finished and the server wrote bytes. It does not mean iOS received, queued, started, or completed playback. This can recreate the success-only telemetry problem the plan is trying to avoid. The mandatory hops also omit a clear `utterance_final` origin; `regex_match` is not always the same thing.  
**Fix:** Rename server-side outcomes to `synth_complete`/`sent_to_client` and reserve `fast_heard` for an iOS ack from `ios_first_audible_frame` or playback start. Add an explicit utterance-final timestamp/span on iOS.

### I9. Live ElevenLabs traces are brittle unit-test fixtures
**Where:** PLAN.md §10.5  
**Problem:** Capturing real `stream-input` BOS-to-isFinal traces for unit tests locks tests to vendor frame shapes, base64 audio details, and current voice/model behaviour. That is fine for a small contract fixture, but poor as the core unit-test substrate. It may also accidentally commit paid/generated voice data from a real inspection phrase.  
**Fix:** Use synthetic protocol fixtures for unit tests and one or two sanitized live traces for contract/integration tests only. Assert parser behaviour, state transitions, and error handling rather than exact audio payload bytes.

### I10. Kill switch semantics conflict with session-snapshotted flags
**Where:** PLAN.md §4.2, §9.2  
**Problem:** The plan says all flags are snapshotted so mid-session flips are inert, then says `VOICE_LATENCY_KILL_SWITCH=true` immediately disables every path mid-session. That can be correct only if the kill switch bypasses the snapshot and every in-flight path checks it at cancellation-safe points. The current wording does not specify what happens to already-open ElevenLabs streams, queued iOS audio, or suppression reservations.  
**Fix:** Define kill switch as a live global override separate from session flags. Specify that it blocks new synth requests, cancels or drains in-flight streams according to source, clears/resolves reservations, and tells iOS to drop queued fast audio if needed.

## NITs
### N1. Section reference for eligibility is wrong
**Where:** PLAN.md §7.1  
**Problem:** It says "see §7.4 eligibility", but the whitelist is in §7.3 and the server eligibility gate is in §7.2.  
**Fix:** Correct the cross-reference.

### N2. Research citation for reconnect-and-replay is off
**Where:** PLAN.md §5.1  
**Problem:** It cites "Research APIs §E" for reconnect-and-replay, but the resumption limitation is in RESEARCH_APIS.md §A.5; §E is the failure catalogue.  
**Fix:** Cite §A.5 and the relevant failure row if both are intended.

### N3. "N/A - only one path" is misleading
**Where:** PLAN.md §5.4  
**Problem:** Stage 2 may have only one logical TTS source, but it can still have multiple queued confirmations and overlapping HTTP responses. Ordering and stale-drop concerns do not disappear entirely.  
**Fix:** Rephrase as "fast-vs-Sonnet duplicate is N/A in Stage 2" and keep generic playback queue ordering in scope.

### N4. The single-backend-instance assumption should be sourced
**Where:** PLAN.md §6.4, §12, §14  
**Problem:** The plan says ECS is pinned at one backend instance, but does not cite the service/task source that makes this true.  
**Fix:** Reference the source-controlled desired count or deployment config, and add a CI/deploy note that scaling past one backend requires shared suppression state.

### N5. iOS file paths are inconsistent in commit tables
**Where:** PLAN.md §4.5, §7.7  
**Problem:** Some rows use `Sources/...` while the repo-root path is `CertMateUnified/Sources/...`.  
**Fix:** Use repo-root paths throughout so implementation agents edit the right tree.
