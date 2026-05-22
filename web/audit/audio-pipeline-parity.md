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

## 2. Confirmed divergences

### D1 — PWA does not send `in_response_to` (MEDIUM)

**iOS:** `DeepgramRecordingViewModel.swift:1942` attaches an `in_response_to`
payload (the most recent TTS question text + question type) to any transcript
that arrives inside an answer window. `ServerWebSocketService.swift:498-518`
adds it to the outbound `transcript` frame.

**Backend:** `src/extraction/sonnet-stream.js:3193-3243` reads
`msg.in_response_to.question` + `.type` and prepends them to Sonnet's
user-turn context as
> CONTEXT: This is in response to the question "<Q>" (type: <T>).

so bare replies like `"yes"`, `"no"`, `"code 2"`, `"FI"` get disambiguated
against the question they actually answer.

**PWA:** `web/src/lib/recording/sonnet-session.ts:951` `sendTranscript()` only
accepts `{confirmationsEnabled, utteranceId, regexResults}`. No
`inResponseTo` option, no caller plumbing. Sonnet receives the bare reply
text with no question context → may mis-route, may re-ask, may apply to the
wrong field.

**Repro shape:** TTS asks "Should I log that as an observation?" → user says
"yes" → PWA sends `{type:'transcript', text:'yes', ...}` with no
`in_response_to`. iOS would send `{..., in_response_to:{question:'Should
I log…', type:'observation_confirmation'}}`.

**Fix scope:** add `inResponseTo?: {question, type}` to `SonnetSession`,
track most-recent-TTS-question slot in `recording-context.tsx` (parallel to
the existing `pendingQuestionForResponse` slot on iOS), thread it into the
dispatch path. Backend change: zero — the receive path already exists.

### D2 — PWA does not send `timestamp` (LOW)

**iOS:** `ServerWebSocketService.swift:504` always stamps
`"timestamp": Formatters.iso8601.string(from: Date())` on every transcript
frame.

**PWA:** No `timestamp` on outbound transcript.

**Backend usage:** grep `src/extraction/sonnet-stream.js` — backend logs and
de-dup uses `utterance_id`, not `timestamp`. No functional impact today, but
it's a behavioural divergence worth either matching (one line) or
documenting as deliberate.

**Fix scope:** one-line add in `sendTranscript`. Decide and ship.

### D3 — `confirmations_enabled` always-present on PWA, conditional on iOS (TRIVIAL)

**iOS:** only adds the key when `confirmationsEnabled == true`.
**PWA:** always emits `confirmations_enabled: false` (truthy or falsy).

Backend reads it as a truthy check, so behaviour is identical. Cosmetic
wire-shape difference only. Leave as-is or align — preference call.

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
