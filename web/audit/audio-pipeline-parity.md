# PWA ↔ iOS Audio Pipeline Parity — 2026-05-22

Ground-truth side-by-side audit of the live recording pipeline. Built from
direct file reads against `main` (commit `f2c9936`) — earlier audit-agent
summaries had casing errors and an out-of-date memory of the wire shapes.

**iOS canon:**
- `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`
- `CertMateUnified/Sources/Recording/TranscriptProcessor.swift`
- `CertMateUnified/Sources/Services/ServerWebSocketService.swift`
- `CertMateUnified/Sources/Services/DeepgramService.swift`

**PWA mirror:**
- `web/src/lib/recording-context.tsx`
- `web/src/lib/recording/sonnet-session.ts`
- `web/src/lib/recording/deepgram-service.ts`
- `web/src/lib/recording/transcript-field-matcher.ts`
- `web/src/lib/recording/number-normaliser.ts`

## 1. Confirmed alignments

| Surface | iOS | PWA | Status |
|---|---|---|---|
| Deepgram model (Nova-3 path) | `nova-3` | `nova-3` | ✓ |
| Deepgram URL params | `endpointing=300, utterance_end_ms=1000, vad_events=true, mip_opt_out=true, encoding=linear16, sample_rate=16000, channels=1, smart_format=true, punctuate=true, numerals=true, language=en-GB, interim_results=true` | identical | ✓ |
| Deepgram auth | `Authorization: Bearer <JWT>` header | `['bearer', <JWT>]` subprotocol *(headers stripped on WS upgrade in browsers)* | ✓ (functional parity) |
| Sample format on the wire | 16 kHz, mono, Int16 PCM binary frames | identical | ✓ |
| Sonnet WS URL | `wss://<backend>/api/sonnet-stream` | identical | ✓ |
| Sonnet WS auth | `Authorization: Bearer` header | `?token=<JWT>` query param *(per iOS-Safari WS-headers rule)* | ✓ (functional parity) |
| `session_start.jobState` | camelCase `jobState` | camelCase `jobState` | ✓ |
| `session_start.protocol_version` | `"stage6"` | `"stage6"` | ✓ |
| `transcript.regexResults` | camelCase `regexResults` (array of `{field, value?}`) | identical | ✓ |
| `transcript.utterance_id` | snake_case, optional | identical | ✓ |
| `ask_user_answered.consumed_utterance_id` | snake_case, optional | identical | ✓ |
| Number normaliser ordering | 21 ordered regex steps (load-bearing) | TS port mirrors 1:1 | ✓ |
| TranscriptFieldMatcher cumulative scan | full session transcript, sliding offset | identical | ✓ |
| Sleep state machine | 2-tier `active` ↔ `sleeping` (Stage 4c collapse) | identical | ✓ |
| Silero VAD wake gate | 512-sample frames, 12-of-30 accumulator, 2 s post-wake cooldown | identical | ✓ |
| Chitchat pause banner + WS contract | 2026-05-06 slice 4 | 2026-05-11 commit `680609f` | ✓ |
| Naming buffer (Bug K) | 3 s hold on trailing "Circuit N is" | identical | ✓ |
| ask_user UX | TTS-out + voice-in only (no AlertCard) | identical (AlertCard dropped 2026-05-13) | ✓ |
| 3-tier field priority | Pre-existing > Sonnet > Regex | identical | ✓ |
| Circuit creation | Sonnet-only (`create_circuit` tool); regex hints don't pre-create | identical | ✓ |
| `session_pause` / `session_resume` / `chitchat_resume` / `select_board` / `correction` | wire shapes match | identical | ✓ |
| `sendJobStateUpdate` debounced push | called on every applied mutation | 120 ms debounce on PWA, parity intent matches | ✓ |

## 2. Closed divergences

### D1 — PWA now sends `in_response_to` ✅ closed 2026-05-22

`sonnet-session.ts:sendTranscript` accepts an `inResponseTo` option
(`{type, question, field?, circuit?}`) attached as snake_case
`in_response_to` on the wire. `recording-context.tsx` owns a single
`InFlightQuestionTracker` instance (`web/src/lib/recording/in-flight-
question.ts`) that:
- enqueues on `onQuestion` (Sonnet emitted the question),
- promotes the matching FIFO entry into an active slot on TTS-start
  via the TTS lifecycle observer,
- re-anchors `askedAt` on TTS-end so the 10 s stale window counts from
  the moment the inspector could physically reply (iOS Fix 2 mirror),
- consumes a payload on dispatch (`takePayload`) — attaches context
  whenever the slot is alive, burns the slot only on substantive
  transcripts (whitelist / ≥10 chars / ≥3 tokens / circuit-shape /
  single-token ≥4 chars — verbatim port of iOS
  `transcriptConsumesInFlight`),
- force-clears the slot when a Stage 6 `ask_user_answered` fires
  (legacy `in_response_to` is suppressed to avoid double-attribution,
  matching `DeepgramRecordingViewModel.swift:1955-1964`).

Covered by 36 unit tests in `web/tests/in-flight-question.test.ts` and
1 parity scenario in `web/tests/parity/inject-smoke.test.ts`. Backend
change: zero — the receive path at `sonnet-stream.js:3193-3243` was
already in place.

### D2 — PWA now sends `timestamp` ✅ closed 2026-05-22

`sonnet-session.ts:sendTranscript` always stamps `timestamp` as
`new Date().toISOString()` (iOS canon `ServerWebSocketService.swift:504`).
No backend consumer load-bears on it today, but the wire diff between
platforms is now zero.

### D3 — `confirmations_enabled` now conditional ✅ closed 2026-05-22

`sonnet-session.ts:sendTranscript` only emits `confirmations_enabled`
when truthy (iOS canon `ServerWebSocketService.swift:509-511`). One
sonnet-session.test.ts assertion updated from `.toBe(false)` to
`.toBeUndefined()` to pin the new shape.

## 3. Possible-divergence rows (need scenario coverage to confirm)

The static read couldn't fully prove these one way or the other — the
transcript-injection harness will be authoritative. Listed so the next
session can pin them down.

- **Pending-readings buffer behaviour** — both clients have a
  `pendingReadings` counter and a re-ask timeout. PWA's counter is exposed
  on the context state (`recording-context.tsx:628`). Need to verify the
  trigger window + the re-ask shape match iOS.
- **Burst-buffer separator** — PWA uses `' ... '` (server-legacy batching
  separator) on consecutive Deepgram finals within 500 ms.
  `recording-context.tsx:790-807` documents the rationale. iOS has no
  client-side burst buffer (kept off backend for the "backend immutable"
  rule, so this is a deliberate PWA-only addition). Confirm scenario
  scripts produce the documented `'A ... B'` shape and not just `'A B'`.
- **TTS-echo discard** — `recording-context.tsx:1561` runs `isTTSEcho()`
  on every final and drops it before any other gating. Need scenario
  coverage to verify the predicate matches iOS's analogous gate.
- **Barge-in path** — iOS uses on-device VAD + speaker isolation; PWA
  delegates to "Deepgram text-final-during-TTS triggers
  `cancelSpeech + sendBargeIn`" (`recording-context.tsx:951-967`).
  Functionally equivalent — confirm via scenario.

## 4. iOS-only paths (deliberate, not gaps)

- **Flux model pilot** — iOS has a parallel `model=flux-general-en` path
  (`DeepgramService.swift:673-724`). PWA stays on Nova-3 only.
- **Per-field Sonnet TTS confirmation** (`applySonnetValue` line
  5860-5911) — "Updated Zs to 0.62" voice announcement on overwrite. PWA
  has no equivalent. **CHECK** whether this should be ported.
- **iOS `pause/finalize` audio frame on TTS playback** — handled by iOS
  AVAudioSession voice-processing mode; web equivalent is the
  `ttsActiveRef` PCM gate which already mirrors the intent.

## 5. PWA-only paths (deliberate, not gaps)

- **Burst buffer (500 ms)** — added 2026-05-13 to mitigate Deepgram
  sub-utterance splits the client couldn't fix in the backend.
- **Heartbeat seq pipelineLog** — diagnoses iPad Safari foreground freezes.
  No iOS analogue needed.

## 6. Verification plan

The transcript-injection harness at `web/tests/parity/` drives the PWA's
audio→Sonnet pipeline with scripted Deepgram finals. Wire trace is
captured and compared to the expected iOS-canon shape.

- `inject-smoke.test.ts` — single utterance round-trip.
- `inject-in-response-to.test.ts` — D1 reproducer; fails pre-fix, passes
  post-fix.
- `inject-burst-buffer.test.ts` — confirms the `' ... '` separator and
  500 ms window.
- `inject-naming-buffer.test.ts` — confirms Bug K behaviour.

When the harness is green and the D1 fix lands, this doc is updated and
the divergence row moves to §1.
