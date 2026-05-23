# Codex review v2 — PLAN_v2.md

## Verdict
Do not execute PLAN_v2 yet: it is much more honest than v1, but several v1 issues are only partially fixed, and v2 adds a new Strategy-C transport blocker that would still buffer the full MP3 on iOS.

## Counts
- v1 BLOCKERs verified fixed: 1 of 4
- v1 IMPORTANTs verified fixed: 5 of 10
- v1 NITs verified fixed: 3 of 5
- NEW BLOCKERs in v2: 1
- NEW IMPORTANTs in v2: 5
- NEW NITs in v2: 2

## v1 findings re-verified

| Finding | Status | Verification |
|---|---|---|
| B1. Latency budget | FIXED | §2 now includes the 800 ms cold BOS in Stage 2 and Stage 4, separates cold/warm and first-byte/first-audible, and the arithmetic checks out. Stage 2 cold audible is correctly ~2,980–3,480 ms; Stage 4 cold is ~1,150–1,250 ms; warm is ~350–450 ms. |
| B2. Suppression/race design | PARTIAL | §6.1 now reserves before vendor calls and handles the concrete same-key fast-vs-Sonnet race. It still does not provide the monotonic `turnId/audioSeq` lane v1 asked for, and §16 row #1 explicitly leaves "sequence-number ordering across HTTP responses" as monitored, not prevented. `sent_to_client` plus no ack also cannot truly "cancel old" audio already delivered to iOS. |
| B3. Fast TTS contests later `ask_user` | PARTIAL | §7.2 adds context anchoring, multi-candidate rejection, server validators, and active-ask checks. But `transcriptContext.pendingAskMatches` only describes an ask already known to iOS. It cannot predict the key v1 failure: Sonnet later deciding this same utterance needs `ask_user`. For active asks, iOS has `inFlightQuestion.contextField`, but that is stale/absent for future asks. |
| B4. Pooled WS unsafe | PARTIAL | Default `stream-input` pooling is removed, which is the right move. Multi-context is conditional on Stage 0.F, but the pass criterion "per-context audio frame routing works deterministically" is not operational enough: it needs exact assertions for tagged audio frames, tagged finality, untagged-frame rejection, concurrent interleaving, close-one-context survival, sample count, and failure disablement. |
| I1. Telemetry-only mitigations | PARTIAL | §16 improves traceability. Rows #13, #14, #15, and #20 now have real mechanisms. Row #7 is still telemetry plus field test only, not mitigation. Row #5 moves `pauseAudioStream`, but the residual admits long readbacks can still clip speech. |
| I2. 60 s TTL too broad | PARTIAL | §6.3 lowers TTL to 12 s, but it is still mostly asserted. Stage 0.B measures Sonnet TTFT, not p99 Sonnet completion plus playback queue/ack delay. There is still no bounded turn/window id in the suppression key. |
| I3. Double spend on late fail | WORDED-AWAY | 5 s in-flight dedupe prevents identical concurrent requests sharing a WS, but it does not solve late fast-path failure followed by normal Sonnet confirmation. Different path/text/key can still bill twice, and timeout/client-abort cleanup is not specified. |
| I4. Capability handshake vs no-iOS-change | FIXED | v2 no longer claims iOS-free Stage 2. Stage 1 adds capability/source fields, Stage 2 includes Strategy C iOS work, and missing capabilities fall back to accumulate-then-respond. |
| I5. Stage 5 partial JSON parser | FIXED | The dependency is dropped. An accumulating string-field extractor can handle `\u00XX` split across `partial_json` chunks if it keeps state over the accumulated buffer; §10.1 should add an explicit split-unicode fixture, but the implementation target is sound. |
| I6. Eligibility whitelist schema verification | PARTIAL | The claim is not fully true. Actual `field_schema.json` has `r1_r2_ohm`, not canonical `r1_plus_r2`; it has `ir_live_live_mohm` and `ir_live_earth_mohm`, not `iso_l_pe`, `iso_l_n`, or `iso_n_pe`. Ze/PFC and ring fields are present. |
| I7. Transport inconsistency | FIXED | §3.E now clearly chooses chunked HTTP for audio and says "NOT the existing WS." I did not find the alleged §0 "chunked MP3 over existing iOS WS" wording in PLAN_v2. |
| I8. Telemetry overstating | FIXED | §4.1 splits server outcomes from iOS outcomes and reserves `fast_heard` for iOS playback ack. The ack is sent over the existing WS after playback completion with monotonic hrtimes. |
| I9. Live trace fixtures brittle | FIXED | §10.5 now uses synthetic MP3 frames and synthetic JSON protocol sequences only. `mock-elevenlabs-protocol` can be hand-authored from documented BOS/text/audio/isFinal shapes with fake audio payloads; no vendor traces are needed. |
| I10. Kill-switch semantics | PARTIAL | The desired runtime behavior is specified, but §9.4 contradicts it: "no deploy needed" while also admitting env-var reload requires container restart/redeploy. Unless the kill switch is backed by a polled dynamic config/source, operator flip to WS close cannot be deterministic within ~50 ms. |
| N1. Wrong section reference | FIXED | The Stage 4 sections were restructured and the stale xref is gone. |
| N2. Wrong reconnect citation | FIXED | Reconnect-and-replay was removed for single-shot synth; the bad citation is gone. |
| N3. "N/A - only one path" misleading | PARTIAL | §5.4 is clearer, but still marks several ordering risks as N/A in Stage 2 while overlapping HTTP responses and queued confirmations remain possible. |
| N4. Single-backend-instance assumption unsourced | WORDED-AWAY | §12/§14 say to reference source-controlled `desiredCount: 1`, but I found no `desiredCount` in `ecs/` with `rg`. ECS task definitions do not normally carry service desired count. |
| N5. iOS paths inconsistent | FIXED | Paths are repo-rooted as `CertMateUnified/Sources/...`. |

## NEW BLOCKERs

### NB1. Stage 2 still lacks an iOS streaming HTTP client path

§5.1 says `StreamingAudioPlayer.ingest(_:)` receives MP3 chunks as they arrive from `URLSession`, and §3.E selects chunked HTTP. But the current iOS call site, `APIClient.proxyElevenLabsTTS`, uses Alamofire `.responseData` and returns a completed `Data` buffer. Stage 1 only adds `source` to that request, and Stage 2's commit table adds `StreamingAudioPlayer`/`AlertManager` work but does not explicitly replace the buffering API with `URLSessionDataDelegate`, `URLSession.bytes`, or Alamofire `DataStreamRequest`.

If this is implemented literally, Strategy C only decodes after the full MP3 response has arrived, recreating the v1 first-byte/first-audible bug. Add a Stage 2 commit and tests for a streaming HTTP client surface: chunk arrival callback, cancellation on timeout/kill-switch, correlation id extraction from headers, and direct feed into `StreamingAudioPlayer`.

## NEW IMPORTANTs

### NI1. Timing constants are still mostly guesses

The plan now has 3 s in-flight wait, 1.5 s pending-ack wait, 12 s suppression TTL, 120 s pool TTL, 5 s in-flight dedupe, and 1.5 s iOS fast-path timeout. Only the 12 s TTL has a derivation story, and even that measures the wrong thing unless Stage 0 records p99 Sonnet completion plus iOS playback ack delay. Stage 0 should explicitly measure or justify each constant, or mark it as a tunable with telemetry-driven adjustment.

### NI2. Rolling a Swift MP3 frame parser is a high-risk implementation choice

§5.1 proposes an internal MPEG frame parser plus `AVAudioConverter` for MP3 frames. That is a lot of low-level audio surface for a latency sprint, and AVFoundation compressed-buffer handling is easy to get subtly wrong. Stage 0.A should compare `pcm_16000`/`pcm_22050` over the same `AVAudioPlayerNode` path and strongly prefer PCM if quality is acceptable. If MP3 stays, use Apple streaming primitives (`AudioFileStream`/AudioQueue or equivalent) rather than a bespoke parser unless the prototype proves it.

### NI3. Stage 0.F is under-scoped for an undocumented multi-context protocol

Half a day is optimistic for reverse-engineering protocol shape, concurrency, finality, close semantics, BOS amortisation, audio routing, and voice continuity. The gate also needs operational pass criteria: number of trials, two-context interleaving with deterministic context tags, per-context `isFinal`, no untagged audio, close-one-context survival, and fallback behavior when a frame cannot be routed.

### NI4. Stage 1 has become a foundation mini-sprint

Stage 1 is now seven commits spanning telemetry, flags, capability negotiation, source fields, backend `field_corrected` emission, iOS ack messaging, and startup logging. That is no longer scaffolding; it is a cross-platform protocol phase. Split the verification gate so backend-only protocol work, iOS ack/source work, and `field_corrected` behavior can be validated independently before Stage 2 depends on all of it.

### NI5. Streaming cost and client-abort accounting remain under-specified

Research notes that current ElevenLabs cost tracking records usage after the full batch response completes. With streaming, the billable moment should be tied to text sent/request accepted, not successful `isFinal` or iOS ack. The plan says cost tracker reports correct count, but there is no commit describing where streaming character usage is recorded, how client disconnects are counted, or how cancelled/first-byte/fallback outcomes reconcile with vendor usage.

## NEW NITs

### NN1. The `synthesising` transition is defined but not wired in §5.2

§6.1 defines `reserved → synthesising → first_byte`, but §5.2 only mentions `reserved → first_byte` and then `sent_to_client`. Add the explicit transition when text is sent to ElevenLabs.

### NN2. `fast_heard` wording is slightly overloaded

§4.1 defines `fast_heard` as `playback_started + playback_completed`, but the hop list uses `ios_dataPlayedBack` and `ios_playback_complete`. Prefer a single precise outcome name such as `playback_completed` plus source metadata, or define exactly which ack payload maps to `fast_heard`.

## Recommendation
Revise.
