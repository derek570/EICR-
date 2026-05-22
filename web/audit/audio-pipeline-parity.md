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

## 3. Verification pass — 2026-05-22

Re-audited the four rows previously flagged "needs scenario coverage."

- **Burst-buffer separator** ✅ verified by `inject-burst-buffer.test.ts`.
  Three scenarios pin the `' ... '` separator, the 500 ms window, and
  the timeout-dispatch path. iOS has no client-side burst buffer — this
  is a deliberate PWA-only addition tied to the "backend immutable"
  rule (2026-05-13 sess_mp4jg2mt_231n fix). Behaviour matches the
  production code at `recording-context.tsx:790-807`.

- **TTS-echo discard** ✅ aligned. iOS `isTTSEcho`
  (`DeepgramRecordingViewModel.swift:2940`) and PWA `isTTSEcho`
  (`web/src/lib/recording/tts.ts:291`) share the 15 s fingerprint window
  contract. PWA docstring explicitly cites the iOS line.

- **Barge-in path** ✅ aligned. PWA emits
  `{type: 'tts_cancelled_by_user', reason, vad_probability?}` via
  `SonnetSession.sendBargeIn` (`sonnet-session.ts:1224`). iOS emits the
  same frame via `notifyBargeInFired` at
  `RecordingSessionCoordinator.swift:741-772`. Backend accepts both
  paths at `sonnet-stream.js:1387` as telemetry-only — no server action
  required. PWA decision to use Deepgram-text-final-during-TTS as the
  detector (vs iOS's on-device VAD) is platform-driven (web AEC is
  software-only and self-trips on speaker bleed-through — see
  `recording-context.tsx:951-967` comment) and produces an identical
  wire frame.

## 4. New divergences surfaced 2026-05-22

### D4 — Pending-readings auto-re-ask system (MEDIUM, open)

**iOS:** complete buffer + 2 s timer + auto-question system. When Sonnet
returns a reading with `circuit == 0` (orphaned — inspector said the
value without a circuit reference), iOS:
1. Buffers it in `transcriptProcessor.pendingReadings`
   (`TranscriptProcessor.swift:213-218`).
2. Starts a 2 s timer
   (`TranscriptProcessor.swift:279-287 startPendingReadingsTimer`).
3. On timeout, fires `askAboutPendingReadings`
   (`DeepgramRecordingViewModel.swift:5417-5459`) which:
   - Dedup-checks via `questionAskCounts[key] < maxAsksPerQuestion`.
   - Snapshots the pending readings for resolution.
   - Builds a question: "Which circuit was that Zs 0.3 reading for?".
   - Routes via `askAlert` → TTS + in-flight slot → `in_response_to`
     on the inspector's reply.

Also has cross-system hooks:
- `removeResolvedReadings` (line 266) — drops pending entries when
  Sonnet later returns the same reading with a resolved circuit.
- `suppressSelfRetry` (line 259) — cancels the iOS timer when the
  server has already asked an equivalent disambiguation question (per
  the 2026-04-21 sess_80723FDE incident).

**PWA:** only `pendingReadings: number` state counter
(`recording-context.tsx:629`). No buffer, no timer, no auto-question.
The UI bumps a badge but the inspector never hears "which circuit?".

**Severity rationale:** users sometimes dictate a Zs/R1+R2 reading
expecting Sonnet to figure out the circuit from context. iOS handles
this gracefully by prompting. PWA silently drops the reading until the
inspector re-dictates with circuit attribution or types it manually.
Not a wire bug — a UX gap.

**Fix scope:** ~150 lines plus tests.
- New `web/src/lib/recording/pending-readings-buffer.ts` (pure
  module, port of `TranscriptProcessor.swift:54-287`).
- Apply-extraction integration: detect orphaned readings on the
  extraction envelope, route them into the buffer instead of dropping.
- Wire timeout callback into the existing
  `inFlightQuestionRef.enqueue` + `speak` path so the re-ask gets
  `in_response_to` context on the reply.
- Parity scenarios for the buffer + timeout + dedup + cancellation
  paths (similar shape to `inject-in-flight-question` + the buffer
  tests).

### D5 — Barge-in wire emit ✅ closed (no divergence)

Initially suspected from the audit, but `sendBargeIn` mirrors iOS exactly
(see §3 above).

### D6 — Per-field Sonnet TTS confirmation (MEDIUM, open)

**iOS:** complete system. `confirmedFieldKeys: Set<String>` per session
(`DeepgramRecordingViewModel.swift:303`). When `applySonnetValue`
overwrites a field that previously had a different value, iOS:
1. Builds a dedup key (line 3308).
2. Calls `alertManager.speakBriefConfirmation(conf.text)` (line 3316)
   to TTS "Updated Zs to 0.62".
3. Inserts the key into `confirmedFieldKeys` so repeat overwrites
   don't re-announce.
4. Resets the set on session start (line 799).

**PWA:** stub at `recording-context.tsx:3123` (`speak('Updated')`).
No `confirmedFieldKeys` equivalent. No per-field announcement system
inside `applyExtraction`. The inspector loses the audio signal that
Sonnet just corrected a field.

**Severity rationale:** medium UX. Inspectors who develop the habit
of glancing at the screen instead of relying on audio feedback won't
notice (and that's most inspectors after a session or two), but
hands-free workflows lose feedback parity.

**Fix scope:** ~80 lines plus tests.
- Add `sessionConfirmedKeysRef` to `recording-context.tsx`.
- Inside `applyExtraction` (currently `apply-extraction.ts`), call a
  new `announceFieldUpdate(key, newValue, prevValue)` helper when a
  Sonnet value overwrites a different non-empty prior value AND the
  dedup key hasn't fired yet this session.
- Helper formats "Updated <friendlyFieldName(key)> to <value>" and
  calls `speak` (which already routes through the in-flight tracker
  bridge so the announcement TTS won't accidentally anchor a question
  slot).
- Reset the Set on session start alongside other state.

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
