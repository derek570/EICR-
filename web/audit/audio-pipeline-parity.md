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

## WS4 update (2026-07-03) — Flux path shipped behind the runtime kill-switch

The web STT path is no longer nova-3-only. `web/src/lib/recording/deepgram-service.ts`
now carries BOTH models behind an `sttModel: 'nova3' | 'flux'` selector:

| Surface | iOS (Flux) | PWA Flux path | Status |
|---|---|---|---|
| Model / endpoint | `flux-general-en` `/v2/listen` | `buildFluxURL` → `flux-general-en` `/v2/listen` | ✓ (behind selector) |
| Turn detection | `eot_threshold=0.7`, `eot_timeout_ms=5000` | identical | ✓ |
| GDPR | `mip_opt_out=true` | identical (per-connection) | ✓ |
| Turn events | `TurnInfo`/{Update,StartOfTurn,EndOfTurn} | mapped onto the SAME delegate API (onInterim/onSpeechStarted/onFinal/onUtteranceEnd) — no parallel forwarder | ✓ |
| Configure | echo-validated, RTT logged | `sendConfigure` → ConfigureResult, echo-validated, RTT, `onConfigureResult` | ✓ |
| Message robustness | Error/ConfigureFailure surfaced | Error/Fatal/ConfigureFailure surfaced, never dropped | ✓ |
| Keyterms | equal-weight, no `:boost`, 20–50 curated | `generateFluxKeyterms` equal-weight, no suffix (PROVISIONAL curated ~40 pending iOS half-1 list) | partial |
| Audio batching | 80ms / 1280-sample frames | identical batcher | ✓ |
| KeepAlive | none on Flux (idle-close → reconnect) | Flux skips the nova-3 KeepAlive | ✓ |

**But web still runs nova-3 by DEFAULT.** `DEFAULT_STT_MODEL='nova3'` and
`ecs/task-def-frontend.json` sets `DEEPGRAM_STT_MODEL=nova3`. Flux is selected
only when the runtime kill-switch resolves `flux`, which is NOT the product
default this cycle: the Phase-0 probe was only partially conclusive (LIM
corrected; insulation/trip-time inconclusive) and the iOS `default_config.json`
curation + TestFlight gate is unmet. So this is **Flux-CAPABLE-vs-Flux**, not
yet **Flux-DEFAULT-vs-Flux**. The nova-3 rows below remain the LIVE web path
(kill-switch fallback) until the flip. Full Flux-vs-Flux is reached by one
commit flipping `DEFAULT_STT_MODEL` + the task-def value to `flux` after the
curated iOS list ships via TestFlight and a real-audio spot check passes. See
`~/.claude/handoffs/EICR_Automation--parity-ws4-flux-wave-2026-07-02/phase0-probe-results.md`.

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

### D4 — Pending-readings auto-re-ask system ✅ closed 2026-05-22

`web/src/lib/recording/pending-readings-buffer.ts` is the pure port of
iOS `TranscriptProcessor.swift:52-287`. `recording-context.tsx`:
- Detects orphan readings in `onExtraction` (`circuit < 1`) and routes
  them to `pendingReadingsBufferRef.addAll(orphans)`.
- Routes resolved readings (`circuit >= 1`) to `removeResolved` so
  Sonnet's later turn drops a previously-orphaned entry.
- Wires the 2 s timeout to:
    1. `buildPendingReadingsQuestion(readings)` — singular/plural
       phrasing identical to iOS canon (
       `DeepgramRecordingViewModel.swift:5422-5426`).
    2. `inFlightQuestionRef.enqueue({type: 'circuit_disambiguation',
       question, field})` so the inspector's "circuit 3" reply gets
       `in_response_to` context.
    3. `playAttentionTone()` then `speak(question)` — same TTS path
       as Sonnet-emitted questions.
- `suppressSelfRetry(field)` is called on `onQuestion` when the server
  emits an orphaned-shape question (matches iOS's
  `TranscriptProcessor.suppressSelfRetry` for the sess_80723FDE
  duplicate-TTS regression).
- Buffer reset on session start + on stop teardown.

`friendlyFieldName` ported verbatim from iOS (Zs, R1+R2, ring R1/RN/R2,
IR L-E / L-L, RCD trip time, polarity, OCPD rating, pass-through
fallback for unmapped fields).

Covered by 23 unit tests in `web/tests/pending-readings-buffer.test.ts`
(scheduler-injected; pins timer restart / removeResolved /
clearResolved / suppressSelfRetry / reset / friendly names / question
phrasing).

**Known gap remaining (lower priority):** the iOS canon also implements
a `snapshot → apply-to-named-circuit` resolve path so the inspector's
reply directly mutates the named circuit without a Sonnet round-trip.
The MVP shipped here relies on Sonnet's normal extraction with
`in_response_to` context to land the buffered values, which is one
extra ~1 s round-trip but functionally equivalent. iOS-canon snapshot
resolve is tracked as a follow-up.

### D5 — Barge-in wire emit ✅ closed (no divergence)

Initially suspected from the audit, but `sendBargeIn` mirrors iOS exactly
(see §3 above).

### D6 — Per-field Sonnet TTS confirmation ✅ closed 2026-05-22

Re-examined: D6's audit-doc spec was incomplete. iOS's per-field TTS
confirmation flows through the SERVER-EMITTED `confirmations[]` array
on the extraction envelope, not a separate client-side path
(`DeepgramRecordingViewModel.swift:3290-3317 flushPendingConfirmations`
iterates the array, deduping via `confirmedFieldKeys: Set<String>`
keyed `<field>_<circuit>`, then calls `speakBriefConfirmation`).

PWA pre-fix only spoke the FIRST entry per turn
(`recording-context.tsx:1886` — "Only the first is spoken so stacked
readings don't backlog stale news") and had no dedup. On a multi-
reading turn (especially after a burst-buffer merge) the inspector
lost audio feedback on every reading after the first.

**Fix:**
- Added `confirmedFieldKeysRef: React.useRef<Set<string>>` —
  per-session dedup keyed `<field>_<circuit>` exactly like iOS line
  3307. Reset on session start + on stop teardown.
- `onExtraction` now iterates the full `result.confirmations` array,
  builds the dedup key, skips on hit (`onExtraction_confirmation_
  deduped` diagnostic), otherwise `speakConfirmation(sentence)` and
  adds the key to the set.
- Confirmation-mode user toggle still gates speech via
  `speakConfirmation` (the existing `confirmations_enabled` wire flag
  belt-and-braces the server-side gate).

Tests: 988/988 still pass — D6 is an in-place flow change with no new
unit-test surface (logic lives inside the React-bound onExtraction
callback; would require provider mount to drive). The behaviour
change is verifiable in the field on the next session.

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
