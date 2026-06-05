# Recording-Pipeline Audit — 2026-05-11

## Background

The field-test session **sess_mp0yyxew_egpx** (2026-05-11 08:58 UTC, private-browsing
reproducer on `job_1778489901552`) reported three blocking symptoms on the PWA:

1. **The page kept refreshing mid-recording** — "It still ref" after every test attempt.
2. **Only one circuit gets added to the schedule** despite dictating multiple.
3. **ElevenLabs TTS is silent on iPad Safari** — only native SpeechSynthesis plays audibly.

The user also mentioned the pattern *"keeps asking the same question only about the
very first part of an utterance"* — Sonnet appeared to re-ask the same question while
ignoring the inspector's continuing reply.

An earlier commit `4c26a4c` (same day, 07:18 UTC) tried to close two of these via
context-memo deps + ElevenLabs prime AbortError handling, but the field repro
demonstrated the symptoms persisted.

This handoff documents the comprehensive audit + the five subsequent fixes that
shipped during the day.

## Audit scope

| Layer | iOS canon | Web port | Status |
|---|---|---|---|
| Audio session / silent-switch override | `AudioSessionManager.swift`, `RecordingSessionCoordinator.swift` | `mic-capture.ts` | Read both; gap documented (Bug E) |
| Audio capture | `AudioEngine.swift` | `mic-capture.ts` | Reviewed |
| Ring buffer | `AudioRingBuffer.swift` | `audio-ring-buffer.ts` | Verified parity |
| VAD (Silero v5) | `SileroVAD.swift` | `silero-vad.ts`, `vad-accumulator.ts` | Verified parity |
| Sleep manager | `SleepManager.swift` | `sleep-manager.ts` | Verified parity; **Bug D** wiring gap |
| Deepgram WS | `DeepgramService.swift` | `recording/deepgram-service.ts` | URL params match; reconnect parity |
| Sonnet WS | `ServerWebSocketService.swift` | `recording/sonnet-session.ts` | Wire-shape parity; paired-replay reorder |
| Final-transcript handler | `DeepgramRecordingViewModel.swift:1589` | `recording-context.tsx` onFinalTranscript | **Bug F** missing; **Bug A** stale-ref |
| TTS dispatch | `AlertManager.swift:1030 (speakWithTTS)` | `recording/tts.ts`, `recording/elevenlabs-tts.ts` | **Bug B** prime AbortError; **Bug D** lifecycle |
| Apply readings | `DeepgramRecordingViewModel.applySonnetReadings:3656` | `recording/apply-extraction.ts` | Pure function correct; **Bug A** call-site |
| Tap accept/reject | `AlertManager.handleTapResponse:610` | `recording-context.tsx` acceptQuestion/rejectQuestion | Verified (post-`4c26a4c`) |
| PWA SW update flow | (n/a — iOS doesn't have a SW) | `app/sw.ts`, `components/pwa/sw-update-provider.tsx` | **Bug C** unconditional reload |
| Error boundary | (n/a) | `app/error.tsx` | Ruled out as crash source |

## Bugs found & fixed (5 commits, deployed to production)

### Bug A — Stale `jobRef.current` in onExtraction → "only one circuit added"
**Commit:** `5d46287`
**File:** `web/src/lib/recording-context.tsx` (`applyExtraction` callback, line 746)

The `applyExtraction` handler was the only apply-path in the file that did NOT mirror
the patch into `jobRef.current` after calling `updateJob(patch)`. Every other path —
voice-command (line 533), regex-apply (line 627), onFieldCorrected (line 893),
onCircuitCreated (line 920), onCircuitUpdated (line 948), onObservationDeleted (line
983), onObservationUpdate (line 1018) — already mirrored. This one was missed.

The useEffect at line 280 that syncs `jobRef.current = job` fires AFTER React commits
the patch, which is at least a microtask later. Two extractions landing inside the
same tick (a fast inspector moving from "Circuit 1 is a cooker" to "Circuit 2 is
sockets") both read `jobRef.current === { circuits: [] }` and each calls
`applyExtractionToJob` from that empty baseline. Each call produces a patch whose
`circuits` field is a FULL replacement array (apply-extraction.ts:170-236 always
rebuilds `circuits` from the input job's circuits array). When the second patch's
`circuits = [{id-B, "RCD"}]` lands via setJob's functional updater, it REPLACES the
first patch's `[{id-A, "Cooker"}]` rather than appending — Circuit 1 vanishes.

**Fix:** add the 3-line mirror that every other apply-path already does.

iOS analogue: `applySonnetReadings` (DeepgramRecordingViewModel.swift:3657) takes
`var job = jobVM?.job`, mutates in place across all readings, writes the whole job
back via `jobVM?.job = job`. Different architecture, same invariant: every write must
update what the next read sees.

### Bug B — ElevenLabs prime AbortError → permanent fallback to native TTS
**Commit:** `5d46287`
**File:** `web/src/lib/recording/elevenlabs-tts.ts` (`primeAudioElement`, line 206)

`primeAudioElement` flipped `audioGestureGranted` to `false` on ANY `play()` rejection.
iPad Safari rejects the prime with **AbortError** when the prime play() is
*cancelled* mid-flight — typically by a real `speakElevenLabs()` call landing before
the prime's promise resolves, which calls `cancelElevenLabs()` at its head and
`audio.pause()`s the shared element. The still-pending prime play() promise rejects
with AbortError but the browser HAS recorded the gesture grant (the play() started
before the pause). Flipping the flag false incorrectly downgraded every subsequent
speak() to native for the rest of the session.

CloudWatch trace from sess_mp0xbjcc_0l09 (08:12:37 UTC):
```
tts_speak_called               .349
tts_dispatch (elevenlabs)      .354
elevenlabs_speak_entered       .354
elevenlabs_fetch_start         .354
prime_audio_element_rejected   .400  ← cancelled by .354 dispatch
elevenlabs_fetch_ok            .602
elevenlabs_audio_playing       .776
                                    (user heard nothing per their report)
```

**Fix:** distinguish AbortError (supersede, harmless) from NotAllowedError (real
policy refusal). Only the latter flips the flag false.

iOS analogue: `audioSessionReady` (`RecordingSessionCoordinator.swift:151`) is only
flipped false on a real .playAndRecord configuration failure, never on a transient
supersede.

### Bug C — SW `controllerchange` triggered unconditional `location.reload()` → THE CRASH
**Commit:** `bd7f8a9`
**File:** `web/src/components/pwa/sw-update-provider.tsx`

**This was the root cause of the user's "the page keeps refreshing".**

The lifecycle log we collected from the diagnostics export contained 7
`sw-controllerchange-reload` events across 18 hours of usage — each one a forced
`window.location.reload()` triggered by a service-worker upgrade the user never opted
into.

Why this fired constantly:
- 5+ deploys today, each bumping the SW's runtime cache key (BUILD_ID)
- iOS Safari aggressively kills backgrounded PWAs → old SW's controlled-client count
  hits zero → waiting SW activates naturally (no skipWaiting required — it's only
  needed when clients ARE controlled)
- `clientsClaim: true` on activate → claims any new tab on next launch
- `controllerchange` fires on the freshly-loaded page; the listener saw
  `hadControllerAtMount === true` (the OLD SW was controlling at mount) and called
  `location.reload()` — no toast tap, no user input

Inspector lost their mic stream, Deepgram WS, Sonnet WS, and in-flight extractions
every time. Symptom field-reported as "crashes when dictating a circuit" because the
recording was the visible state at the moment of the reload.

**Fix:** add a `userInitiatedReloadRef` flag set to true ONLY inside the toast button
`onClick`. The controllerchange listener now ignores upgrades where that flag is
false, logging `sw-controllerchange-uninitiated` for telemetry but staying put. The
toast remains visible so the inspector can opt in when convenient.

iOS analogue: iOS apps don't have this class of bug at all — code updates land via
App Store / TestFlight install, which is its own gated UX. There is no canonical
equivalent to mirror; the fix is the right pattern for the web platform.

### Bug D — TTS-active gate not wired on web SleepManager → spurious sleep entry during TTS
**Commit:** `2e011e9`
**Files:** `web/src/lib/recording/tts.ts`, `web/src/lib/recording-context.tsx`

iOS's `SleepManager.onTTSStarted` / `onTTSFinished` (called from
`DeepgramRecordingViewModel.swift:813, 866`) suspend the 60s no-final-transcript timer
while TTS plays — the device speaker produces artificial silence on the mic stream,
so the lack of finals during TTS is not a signal of inspector inactivity.

Web's `SleepManager` exposed the symmetric method `setTtsActive(active)`
(`sleep-manager.ts:198`) but **nothing on the web side called it**.

Consequence: the 60s timer kept ticking through the 3-8s TTS audio + the inspector's
think-time. Cumulative >60s was common, so the timer fired sleep entry mid-
conversation — tearing down Deepgram + Sonnet exactly when the inspector started
their answer.

**Fix:** added a lifecycle-observer pattern in `tts.ts`:
- `setTtsLifecycleObserver(fn)` — registers a callback fired on `'start'` (audio
  begins flowing) and `'end'` (utterance ended / superseded / errored).
- `notifyTtsLifecycle('start' | 'end')` called from both dispatch paths (native
  SpeechSynthesis + ElevenLabs) at the matching iOS lifecycle moments.

In `recording-context.tsx` `start()`, we register an observer that forwards events
to `sleepManagerRef.current?.setTtsActive(event === 'start')`. Cleared in `stop()`.

This decouples `tts.ts` from SleepManager (so the tour controller can still use TTS
outside a recording session) while keeping the gate wired during recording.

### Bug F — TTS fingerprint echo gate missing → mic feedback re-feeding Sonnet
**Commit:** `6f86eb6` (+ regression test `b66f94a`)
**File:** `web/src/lib/recording/tts.ts` (+ `recording-context.tsx` consumer wire-in)

iOS keeps a 15-second list of recently-spoken TTS fingerprints (word Sets) and
discards any final transcript that matches above the echo threshold:
- short text (≤ 2 words): exact subset match either direction
- longer text: > 70% word-Set overlap

(`DeepgramRecordingViewModel.swift:156` recentTTSFingerprints, `:2776`
registerTTSFingerprint, `:2823` isTTSEcho).

Web had no equivalent. The only gate was the wall-clock `isWithinTtsWindow()` + 300ms
cooldown.

Why this matters: Deepgram processing latency can delay a final transcript by
500-1500ms after the audio arrived. By the time the final reaches the host, the
wall-clock TTS window has closed (audio ended + 300ms grace), but the text the mic
picked up — the speaker echoing the question — still matches the recently-dispatched
TTS fingerprint.

Pre-fix, those late-arriving echo finals fell straight through to Sonnet, which
processed the fragments as the inspector's reply. The field report "keeps asking the
same question only about the very first part of an utterance" matches this exactly:
the question's TTS audio landed in the transcript ~600ms after the audio finished,
Sonnet saw "what is the designation for circuit 2", failed to parse a designation
from it, and re-asked. Repeat indefinitely.

**Fix:** port iOS's algorithm exactly — 15s TTL, 70% overlap, subset match for short
text. Register on `dispatch()` (mirrors iOS lifecycle position). Consumer
(`recording-context.tsx` onFinalTranscript) calls `isTTSEcho(text)` after the
wall-clock gate and returns early if true.

11 regression tests in `tests/tts-fingerprint-echo.test.ts` pin all the thresholds.

## Bugs identified but NOT fixed in this audit

### Bug E — ElevenLabs `<audio>` element muted by iPhone silent switch
**Severity:** medium (degrades to native TTS, never silent)
**Platform limitation, not a code bug**

iOS's `AVAudioSession.setCategory(.playAndRecord, ...)` ignores the iPhone's silent
switch — this is why iOS ElevenLabs TTS works regardless of switch position. Web
`<audio>` elements use the iOS Safari media playback path, which respects the silent
switch. SpeechSynthesis uses a different audio path that doesn't respect the switch.

**The user heard native TTS but not ElevenLabs** — that combination is consistent
with the silent switch being on and the `<audio>` element output being muted.

**Possible fix (not implemented):** rewrite ElevenLabs playback to use Web Audio API
(`AudioContext.decodeAudioData` + `AudioBufferSourceNode`) instead of `<audio>`. The
AudioContext is already active (from mic capture) and runs through a path that
ignores the silent switch on iOS Safari. Estimated effort: 1-2 days. Risk: medium
(AudioContext lifecycle interactions with mic capture need careful handling).

### Bug G — `wakeForQuestion` not implemented on web
**Severity:** low
**Not needed in current architecture**

iOS calls `sleepManager.wakeForQuestion()` when a question arrives via TTS while
sleeping — forcing a wake before the question's audio plays. Web's `sleeping` state
tears down both Deepgram AND Sonnet WS, so no questions can arrive while sleeping.
No fix needed unless the web architecture changes to keep Sonnet open during sleep.

### Bug H — `WorkOnBoardIntent` not implemented on web
**Severity:** medium (blocks multi-board voice switching on web)
**Pending parity port**

iOS's `WorkOnBoardIntent.parse(normalised)` (called in
`DeepgramRecordingViewModel.swift:1725`) handles "Work on Garage" / "Switch to sub-1"
phrases — a local on-device intent that emits a `select_board` WS message bypassing
Sonnet. Web's `parseVoiceCommand` in `@certmate/shared-utils` covers
CalculateImpedanceIntent + ApplyFieldIntent but **not** WorkOnBoardIntent. Multi-board
sprint web parity is the natural place to add this.

### Bug I — Question gating (`fieldHasNonVoiceValue` / `fieldAlreadyHasValue`) missing on web
**Severity:** medium (UX polish — Sonnet asks questions about already-filled fields)

iOS's `flushPendingQuestions` (DeepgramRecordingViewModel.swift:2857) checks each
queued question against the local job state and suppresses asks for fields that
already have a value (except `out_of_range` / `tt_confirmation` which legitimately
re-confirm). Web forwards every question to TTS unconditionally — so the inspector
hears asks about fields they've already manually typed.

### Bug J — Word-timestamp-based TTS overlap detection missing on web
**Severity:** low (Bug F's fingerprint gate covers most cases)

iOS uses `estimateUtteranceWallClock(words)` to derive the utterance's actual start
time from Deepgram word timestamps, comparing against the TTS audio window with 300ms
grace. Web uses the simpler "is the TTS window currently open or within 300ms
cooldown" check. Less precise, but the fingerprint gate added in Bug F provides
similar coverage for the late-final-after-window class.

## Files changed (all on `main`)

| File | Commit | Lines |
|---|---|---|
| `web/src/lib/recording-context.tsx` | A, D, F | +37 |
| `web/src/lib/recording/elevenlabs-tts.ts` | B | +22 |
| `web/src/components/pwa/sw-update-provider.tsx` | C | +31 |
| `web/src/lib/recording/tts.ts` | D, F | +193 |
| `web/tests/tts-fingerprint-echo.test.ts` | F | +109 (new) |

## Commit chain

```
b66f94a test(web/recording): regression test for the TTS fingerprint echo gate
6f86eb6 fix(web/recording): add TTS fingerprint echo gate (iOS canon parity)
2e011e9 fix(web/recording): wire TTS lifecycle to SleepManager so the no-transcript timer is suspended during speech
bd7f8a9 fix(web/pwa): gate sw-controllerchange reload on user-initiated SKIP_WAITING
5d46287 fix(web/recording): plug stale-jobRef circuit overwrite + don't false-negative TTS gate on prime AbortError
4c26a4c fix(web/recording): close iOS-PWA parity gaps on ask_user TTS, tap-crash, voice barge-in  ← prior fix, baseline
```

## Test surface

- **Before audit:** 672 web tests + 3292 backend tests
- **After audit:** 683 web tests (11 new for Bug F) + 3292 backend tests
- All pass; tsc clean

## How the user should test post-deploy

The user kept testing in **private browsing** during the morning's repros, which wiped
localStorage on every reload and prevented the lifecycle log from capturing anything.
For the next field test:

1. Wait for CI to complete on `b66f94a` (last commit). Check via
   `gh run list --limit 1` or `aws ecs describe-services --cluster eicr-cluster-production --services eicr-pwa --region eu-west-2 --query "services[*].{TaskDef:taskDefinition,Rollout:deployments[0].rolloutState}"`
2. **Clear PWA cache** — Settings → Diagnostics → "Clear cache". This nukes the old
   service worker so the new gated reload code is in effect.
3. Open `certmate.uk` in **regular Safari** (NOT private — private wipes telemetry
   across reloads, which is what masked Bug C's pattern for the first 4 hours of
   debugging).
4. Try recording 2-3 circuits in sequence.
5. Expected behaviour now:
   - **No more silent page reloads** mid-session
   - **Multiple circuits all land** in the schedule
   - **No spurious sleep entry** during TTS playback
   - **No "keeps asking the same question"** loop from mic-feedback echo
   - ElevenLabs may STILL be silent on iPad if the iPhone silent switch is on (Bug E
     — platform limit). Native TTS audible.

If anything still misbehaves, collect the diagnostics export from
`/settings/diagnostics` — the lifecycle log will now persist across reloads in
regular Safari and tell us exactly what happened.

## Open items if work continues

Priority order:

1. **Field-verify all five fixes** with the user — biggest risk is that Bug C alone
   was the dominant cause and the other four were correct-but-unobservable. Confirm
   the lifecycle log no longer shows `sw-controllerchange-reload`.
2. **Bug E — Web Audio API path for ElevenLabs.** Highest-impact remaining quality-
   of-life issue. Architectural change to TTS playback layer.
3. **Bug I — Question gating.** Mid-effort UX polish, well-bounded. Mirror iOS's
   `flushPendingQuestions` gating exactly.
4. **Bug H — WorkOnBoardIntent on web.** Multi-board sprint scope. Port the iOS
   intent to `@certmate/shared-utils` so both clients can share the same parser.
5. **Bug J — Word-timestamp utterance estimation.** Low-priority precision
   improvement now that Bug F is in.
6. **Integration test for Bug A.** Currently no test mounts RecordingProvider with a
   simulated extraction sequence. A test that fires two `onExtraction` callbacks
   back-to-back and asserts both circuits land would lock in the jobRef-sync
   invariant. Worth the effort; recording-context is the heart of the system.
7. **Investigate the double-`provider-mount` pattern** observed in the lifecycle log
   (12ms apart, no intervening unmount). Likely a React 19 Concurrent re-rendering
   artefact, but worth confirming.

## Key insights captured

- **iOS canon for recording is `DeepgramRecordingViewModel.swift` + `AlertManager.swift`**
  — these two files (9347 lines combined) own the lifecycle. `RecordingSessionCoordinator`
  owns the audio session + sleep manager wiring. `SleepManager` owns the doze/sleep
  state machine.
- **Web's delta-patch architecture is structurally different from iOS's
  read-modify-write**. Both work, but every web apply-path MUST mirror jobRef.current
  manually because React state updates are async. Bug A was the single missed mirror;
  the pattern is otherwise consistent across the file.
- **The SW update flow is the only "iOS doesn't have this" subsystem.** Service
  workers are a pure web concept; the gating model needs careful design because the
  defaults are too aggressive for a recording app.
- **iPad Safari's silent switch is a real platform limitation** that web cannot fully
  work around through `<audio>` elements. Web Audio API is the escape hatch.
- **The user's testing in private browsing prevented telemetry capture** for the
  first half of the debug session. Without the regular-Safari lifecycle log we'd
  still be guessing at Bug C.
