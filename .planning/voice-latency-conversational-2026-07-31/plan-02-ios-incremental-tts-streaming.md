# Plan 02 — incremental ElevenLabs playback on iOS

Status: **DRAFT — not RP-reviewed**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
iOS repo: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
Dependency: Plan 00 complete

## Outcome

Start audible PCM playback when the first safe ElevenLabs chunks arrive instead of waiting for the complete HTTP body and constructing `AVAudioPlayer(data:)`. Preserve the single FIFO, user-speaking deferral, barge-in, echo suppression, playback acknowledgement and exactly-once read-back rules.

The backend streaming route already exists. The missing production half is iOS consumption and playback.

## Verified starting point

- `src/routes/keys.js::streamConfirmationViaElevenLabs` emits chunked `audio/L16` from `ElevenLabsStreamClient` and returns a correlation ID.
- The server gates this path on the client's `streaming_http_audio` capability.
- iOS does not currently advertise that capability.
- `APIClient.proxyElevenLabsTTS()` uses Alamofire `.responseData`, so it resolves after the full response.
- `AlertManager` creates `AVAudioPlayer(data:)`; it cannot play headerless PCM incrementally.
- The existing playback ACK is stamped after `AVAudioPlayer.play()` succeeds. Its semantic replacement must be the moment the first sample is actually scheduled/audible, not the first network byte.

## Scope

### 1. Streaming transport

- Add a dedicated streaming TTS method rather than changing every `.responseData` caller.
- Validate status and headers before passing bytes to the player.
- Parse `Content-Type` and sample rate; support the one negotiated format only at first (`pcm_22050`, signed 16-bit mono) and reject mismatches safely.
- Surface response correlation/source headers before the body completes.
- Define cancellation for queue eviction, session stop, barge-in, app backgrounding and network loss.
- Retain the buffered MP3 method as an immediate fallback and rollback path.

Likely iOS files:

- `Sources/Services/APIClient.swift`
- `Sources/Services/ServiceProtocols.swift`
- new focused streaming transport type under `Sources/Services/`

### 2. Production incremental PCM player

- Add a small `AVAudioEngine` + `AVAudioPlayerNode` owner for raw PCM chunks.
- Convert byte boundaries safely when an HTTP chunk ends on an odd byte.
- Use one serial scheduling queue, bounded buffer and backpressure policy.
- Prebuffer only the minimum empirically needed to avoid underruns; measure it.
- Expose lifecycle callbacks: ready, first sample scheduled/started, completed, cancelled, underrun and failed.
- Integrate with the existing `AlertManager` FIFO; do not create a second independent playback queue.
- Keep `markTTSStarted`/`markTTSFinished`, audio-session configuration, Deepgram pause/echo window, speaking deferral and cooldown behaviour aligned with the buffered route.

### 3. Exactly-once and ACK semantics

- Reserve/claim the existing confirmation key before synthesis exactly as today.
- Convert the reservation to heard only on actual playback start.
- On pre-play failure/cancellation, release it so the canonical fallback remains speakable.
- Send one playback ACK at first actual playback start with the backend correlation ID, turn ID and slot tuple.
- Never ACK first byte received, decoder ready or buffer scheduled if playback did not start.
- Ensure a stream that fails after partial audible playback does not replay the whole confirmation and cause double TTS. Define the audible-partial terminal explicitly.

### 4. Capability negotiation and client parity

- Advertise a versioned `streaming_http_audio` capability only when the production player is present.
- Backend selects chunked PCM only for that capability; older iOS and web continue receiving their existing formats.
- Add a remote/source kill switch so TestFlight can fall back to buffered MP3 without a binary rollback.
- Review the web client explicitly: no wire/default change may turn its response into unsupported PCM.

## Tests

iOS unit/integration cases:

- irregular chunks, odd byte boundary, empty final chunk and correct PCM ordering;
- status/header/format rejection before playback;
- prebuffer and first-sample callback occurs before full response;
- FIFO ordering for multiple confirmations;
- user-speaking deferral with chunks buffered but silent;
- barge-in before start, after first sample and during a later chunk;
- cancellation/network failure before start releases the key;
- failure after partial audio does not cause double speech;
- session stop/reconnect/app lifecycle cleanup;
- exactly one playback ACK and exactly one TTS-start/finish lifecycle;
- legacy buffered/native fallback remains green.

Backend cases:

- capability absent/present routing;
- content type/sample rate and headers;
- aborted client closes vendor work and cost attribution terminates once;
- old iOS and web fixtures retain MP3 behaviour.

## Acceptance and measurement

- first audible sample is measured locally and joins the existing turn/correlation telemetry;
- no new double-TTS, silent-write, FIFO reorder, echo ingestion or barge-in regression in scripted and field tests;
- streaming starts materially before full-body completion at p50 and p95;
- underrun and fallback rates are reported, with cellular split;
- keep only if mouth-stop-to-audio improves without audible clipping or robotic gaps.

## Delivery order and rollback

- Backend capability support is already backward compatible; any refinements ship first and reach steady ECS state.
- Then ship TestFlight with capability dark, enable for the field account, and verify playback ACKs.
- End the wave with both client and backend versions recorded. Rollback by disabling the capability/kill switch; buffered MP3 and Apple native remain available.
- Update backend `docs/reference/ios-pipeline.md`, `architecture.md`, `deployment.md`, `changelog.md`, iOS architecture/runbook docs, and parity ledger if applicable.

## Reviewer pressure points

- What event proves the inspector heard audio rather than merely received bytes?
- Who owns an item after partial audible failure, and can any fallback speak it twice?
- Can queued PCM grow without bound during a long speaking deferral?
- Does stopping Deepgram at playback start lose audio spoken during the network fetch?
- Are the backend response format and iOS `AVAudioFormat` byte order/sample rate identical?
