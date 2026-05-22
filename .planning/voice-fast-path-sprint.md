# Voice fast-path sprint — 2026-04-26

## Goal
Make the ask_user round-trip feel **conversational** — sub-second from the inspector saying "yes" to Sonnet acting on it — and make grey transcript text uncommon enough that it stops registering as a problem. Closes the three deferred tasks from the Bug-H sprint:

- **#20** server: resolve in-flight ask_user from a transcript when iOS doesn't send `ask_user_answered` (or sends it late)
- **#21** iOS: fire `ask_user_answered` on the first **stable interim** rather than waiting for `is_final=true`
- **#23** iOS: backup silence gate (AVAudioEngine RMS) for the case Deepgram fails to commit a final at all

These together are the "real" fix that lets `ASK_USER_TIMEOUT_MS` come back down from 45s → 20s (the Bug-H workaround).

## Why
Field test 2026-04-26 (sessions reported by Derek): inspector answered "yes" / "two" within ~500ms of the question and the 20s timeout still fired. Two contributors:

1. **Deepgram silent-room final delay** — in a quiet room (HVAC off, no body-noise mic floor) Deepgram's endpointer can't see a clean speech→silence transition, so `speech_final=true` never fires and `is_final=true` doesn't commit until `utterance_end_ms` expires. We've already lowered `utterance_end_ms` 1500→1000ms (Build 303) and bumped the server timeout 20→45s, but that's a workaround — short answers still feel sluggish.
2. **iOS only fires `ask_user_answered` on FINAL** — interims arrive ~150-300ms after the inspector starts speaking but are ignored for ask resolution, even when an in-flight Stage 6 ask is open and the interim text already matches the expected answer shape.

The deeper architectural piece is: **the answer doesn't need to wait for Deepgram to commit a final.** As soon as iOS has a settled interim that matches the in-flight ask's expected shape, that's the answer.

## End-state (success criteria)
- p50 ask round-trip latency (question audio end → server-side `pendingAsks.resolve` time) < 800ms on a "yes" answer in a quiet room.
- p95 < 1.5s.
- `ASK_USER_TIMEOUT_MS` back down to 20s with zero false-timeouts in a 30-cert field test.
- `wait_duration_ms` distribution in `stage6.ask_user` log rows shifts left (median ~600ms, today's median is ~2.5s).
- Zero double-attribution: every ask resolves exactly once, whether via interim-fire, final-fire, or transcript-fallback.

## Out of scope
- Reworking Deepgram itself (model swap, language pack tuning) — the constraint we can't move.
- Cost optimisation on Anthropic side — separate sprint.
- Anything touching the live extraction main-flow path beyond what's needed for ask resolution.

---

## Architecture overview

```
                     ┌─────────────────────────────────────────────────────┐
                     │ iOS  CertMateUnified                                │
                     │                                                     │
                     │ AudioEngine ──► RMS gate (NEW #23) ──┐              │
                     │       │                              ▼              │
                     │       └─► DeepgramService ──► interim ──► debounce  │
                     │                                            (NEW #21)│
                     │                                  │                  │
                     │                                  ▼                  │
                     │                            inFlightQuestion?        │
                     │                            ┌────yes────┐            │
                     │                            │           │            │
                     │                  fire ask_user_answered             │
                     │                  with interim_fire=true             │
                     │                            │                        │
                     │                            ▼                        │
                     │                     ServerWebSocketService          │
                     └────────────────────────────│────────────────────────┘
                                                  ▼ wss://.../sonnet-stream
                     ┌────────────────────────────│────────────────────────┐
                     │ Backend  EICR_App                                   │
                     │                            ▼                        │
                     │ sonnet-stream.js ──► handleAskUserAnswered          │
                     │                       │  (existing)                 │
                     │                       │                             │
                     │ sonnet-stream.js ──► handleTranscript ──► transcript│
                     │                       │  fallback (NEW #20)         │
                     │                       │                             │
                     │                       ▼                             │
                     │                  pendingAsks.resolve(toolCallId)    │
                     │                       │                             │
                     │                       ▼                             │
                     │                  createAskDispatcher Promise wakes  │
                     │                       │                             │
                     │                       ▼                             │
                     │                  Sonnet round 2 (with answer)       │
                     └─────────────────────────────────────────────────────┘
```

Three layers of resolution with strict precedence:

1. **iOS interim-fire** (#21) — fastest path, ~150-400ms after speech ends.
2. **iOS final-fire** (today's path) — happens when Deepgram commits the final, ~500ms-3s.
3. **Server transcript-fallback** (#20) — safety net if iOS sent the transcript but never fired `ask_user_answered`.

#23 (RMS silence gate) is orthogonal: it forces a Deepgram final faster in silent-room conditions so the existing final-fire path becomes the primary resolver again. It also lets interim-fire (#21) run on a fresher interim rather than one that's been growing for 1500ms.

---

## Per-task breakdown

### Task #20 — Server-side: resolve ask_user from transcript path

**Where:** `src/extraction/sonnet-stream.js`, `handleTranscript` function.

**Today's behaviour:**
- iOS sends `ask_user_answered` with `tool_call_id` and `consumed_utterance_id`.
- Backend at `sonnet-stream.js:943` looks up the pending ask by `tool_call_id` and resolves it.
- Backend at `sonnet-stream.js:1013` does fast-path dedupe via `seenTranscriptUtterances` Set.
- If iOS never sends `ask_user_answered` (older client, network hiccup, race condition), the ask sits open until `ASK_USER_TIMEOUT_MS` fires.

**Goal:** when a transcript arrives and there's an in-flight ask that matches by context, resolve the ask using the transcript text.

**Approach — match-by-shape:**
For each pending ask, the registry already carries `expectedAnswerShape` (`yes_no`, `circuit_ref`, `free_text`). When a transcript arrives:

1. Iterate `pendingAsks.entries()` for asks where `(now - askStartedAt) < FALLBACK_WINDOW_MS` (e.g. 8000ms — wider than the typical answer window, narrower than the ask timeout).
2. For each candidate, run `classifyTranscriptAsAnswer(transcript, expectedAnswerShape)`:
   - `yes_no`: regex against `/^(yes|yeah|yep|no|nope|correct|right|wrong)\b/i`
   - `circuit_ref`: regex `/(?:circuit\s+)?(\d{1,2})\b/i` — bounded 1-30
   - `free_text`: any non-empty trimmed text > 1 char
3. If classify returns a match, resolve the pending ask:
   - Use the transcript's `utterance_id` as `consumed_utterance_id` if present
   - Set `wait_duration_ms` from `Date.now() - askStartedAt`
   - Add `answer_outcome: 'transcript_fallback'` to the log row so the analyzer can distinguish this path

**Double-attribution defence:**
- The fast-path resolver (`handleAskUserAnswered`) already calls `pendingAsks.resolve(toolCallId, ...)` which returns `false` if the entry was already resolved.
- Order doesn't matter: whichever path calls `resolve` first wins; the second is a no-op.
- The existing `seenTranscriptUtterances` Set logic stays — that's about transcript dedupe, not ask dedupe.

**Edge case — transcript dedupe vs ask resolution:**
The existing fuzzy fallback at `sonnet-stream.js:1042` is about NOT double-counting the same transcript text across `transcript` + `ask_user_answered.user_text`. The new fallback path here is about resolving asks that never got an explicit answer message. They don't conflict — but the transcript-fallback path MUST NOT also attempt to dedupe-against-itself (since there's only one transcript involved).

**Files to touch:**
- `src/extraction/sonnet-stream.js` — add `tryResolveFromTranscript()` helper called inside `handleTranscript` after the existing dedupe block, before the Sonnet-round-2 trigger
- `src/extraction/stage6-pending-asks-registry.js` — no API change; existing `entries()` and `resolve()` are sufficient
- New file `src/extraction/stage6-classify-transcript-answer.js` — pure-function classifier, easy to unit-test

**Tests to add (`src/__tests__/stage6-transcript-fallback.test.js`):**
1. `yes_no` shape, transcript = "yes" → resolves with `transcript_fallback`
2. `yes_no` shape, transcript = "the cooker is on circuit four" → does NOT resolve (no yes/no match)
3. `circuit_ref` shape, transcript = "circuit three" → resolves with circuit_ref=3
4. `circuit_ref` shape, transcript = "the kitchen lights" → does NOT resolve (no number)
5. `free_text` shape, transcript = "we'd call it spare two" → resolves
6. Outside `FALLBACK_WINDOW_MS` → does NOT resolve even if shape matches
7. Two pending asks (race), transcript answers the one matching context_field → only that one resolves
8. Pending ask already resolved by `handleAskUserAnswered` → transcript fallback is a no-op (no double-resolve)
9. Log row carries `answer_outcome: 'transcript_fallback'` (analyzer surface)

**Risk / rollback:** new code path only fires when ask is in-flight AND transcript matches AND fast path didn't already resolve. Worst case = false-positive resolution on misclassified transcript (e.g. "yes I think the cooker is on three" matched as `yes_no`). Mitigation: classifier is conservative (only resolves on clear short answers), and `expectedAnswerShape` already constrains the model. Kill switch via env `STAGE6_TRANSCRIPT_FALLBACK=false`.

---

### Task #21 — iOS: fire ask_user_answered on first stable interim

**Where:** `Sources/Recording/DeepgramRecordingViewModel.swift` — new state on `handleInterimTranscript`.

**Today's behaviour:**
- `handleInterimTranscript(text)` updates `interimTranscript` for UI display only.
- `appendToTranscriptAndExtract` (the path that fires `ask_user_answered`) only runs from `handleFinalTranscript`.

**Goal:** when an in-flight ask is open and an interim arrives that matches the expected shape, debounce briefly to confirm stability, then fire `ask_user_answered` immediately.

**Approach — debounced interim watcher:**

```swift
// Pseudo-code
private var interimAskWatchTask: Task<Void, Never>?
private var lastInterimTextForAsk: String = ""

func handleInterimTranscript(_ text: String) {
    interimTranscript = text  // existing UI behaviour

    // NEW: interim-fire path for in-flight Stage 6 asks
    guard let inFlight = inFlightQuestion,
          let toolCallId = inFlight.toolCallId,
          inFlight.consumedByInterim == false  // only fire once per ask
    else { return }

    // Shape check: does this interim already plausibly answer the ask?
    guard transcriptPlausiblyAnswers(text, shape: inFlight.expectedAnswerShape) else {
        return
    }

    // Cancel any previous debounce — stability is judged on the LATEST interim
    interimAskWatchTask?.cancel()
    lastInterimTextForAsk = text

    interimAskWatchTask = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 350_000_000)  // 350ms debounce
        guard let self, !Task.isCancelled else { return }
        guard text == self.lastInterimTextForAsk else { return }  // unchanged
        guard self.inFlightQuestion?.toolCallId == toolCallId else { return }  // still same ask

        // Fire — mark interim-consumed so a later final doesn't re-fire
        self.inFlightQuestion?.consumedByInterim = true
        self.fireAskUserAnsweredFromInterim(toolCallId: toolCallId, text: text)
    }
}
```

**Wire-shape changes:**
- Add `interim_fire: bool` field to the `ask_user_answered` ws message (additive — backend ignores if absent).
- Mint a synthetic `consumed_utterance_id` for the interim fire (UUID). This won't be in `seenTranscriptUtterances` since no final has stamped it yet → backend's fast-path dedupe will MISS — falls through to fuzzy fallback at `sonnet-stream.js:1042` which is the right behaviour.
- Better: pass `consumed_utterance_id: null` and let backend skip the dedupe altogether on `interim_fire=true` messages.

**The "later final" problem:**
After interim-fire, Deepgram will eventually commit the final. `handleFinalTranscript` will run, then `appendToTranscriptAndExtract`, which today fires `ask_user_answered` for the same toolCallId. We need to suppress that.

Solution: `inFlightQuestion.consumedByInterim` boolean. When the substantive-transcript path checks `stage6Substantive`, it ALSO checks `!inFlight.consumedByInterim`. If interim already fired, the final path skips the second `sendAskUserAnswered` AND drops the in-flight slot via `takeInResponseToPayload`.

**Backend dedupe for safety:**
Even if iOS bug causes a double-fire, backend's `pendingAsks.resolve()` returns `false` on the second call (entry already gone). Add a log row `stage6.ask_user_answered.duplicate_after_interim` so we can spot iOS regressions in the analyzer.

**Stability heuristics — when to fire:**
- 350ms debounce (no change to interim text in 350ms)
- AND interim text non-empty after trim
- AND interim text matches expected shape (yes/no, number, free-text non-trivial)
- AND TTS is not currently speaking (can't be the inspector — would be echo)
- AND interim hasn't already grown past 30 chars for `yes_no` asks (suggests inspector said more than just yes/no — wait for the final to get full context)

**Files to touch:**
- `Sources/Recording/DeepgramRecordingViewModel.swift` — interim watcher, fireAskUserAnsweredFromInterim, dedupe flag on `inFlightQuestion`
- `Sources/Services/ServerWebSocketService.swift` — `sendAskUserAnswered` gains `interimFire: Bool` param (default false)
- `Sources/Recording/InFlightQuestion.swift` (or wherever the struct lives) — add `consumedByInterim: Bool`

**Tests to add (`Tests/CertMateUnifiedTests/Recording/`):**
1. Interim arrives matching `yes_no` shape, no further changes for 350ms → `sendAskUserAnswered` called with `interimFire=true`
2. Interim arrives, then changes within 350ms → debounce resets, no fire until stable
3. Interim arrives matching shape but TTS is speaking → no fire (echo)
4. Interim fires; later final arrives same content → final path detects `consumedByInterim` and does NOT re-send `sendAskUserAnswered`
5. Interim fires; later final arrives DIFFERENT content (inspector continued past yes) → suppress final-path send (interim is the answer of record)
6. No in-flight ask → interim watcher is a no-op

**Risk / rollback:** wrong-shape match could fire the ask too early. Mitigation: per-shape classifier is the same one used server-side (#20), so behaviour is consistent on both sides. Hidden via `STAGE6_INTERIM_FIRE` build flag in `Info.plist` — default ON, can ship a build with it OFF if field testing reveals issues.

---

### Task #23 — iOS: client-side silence gate via AVAudioEngine RMS

**Where:** `Sources/Audio/AudioEngine.swift` — new tap on the audio buffer alongside the existing Deepgram-feed tap.

**Today's behaviour:**
- AVAudioEngine captures 16kHz PCM, taps to `DeepgramService.sendAudio(_:)` and to the Silero VAD chunk processor (used for sleep/wake).
- Deepgram does its own server-side VAD for endpointing.

**Goal:** independent of Deepgram, detect when the inspector has stopped speaking, and use that signal to:
- Force a final commit on the current interim (treat as if `speech_final=true` had fired)
- Optionally: send a `Finalize` JSON message to Deepgram (Deepgram supports this — the docs call it "Finalize" message — to force a commit)

**Approach — sliding-window RMS:**

```swift
// Pseudo-code
final class SilenceGate {
    private let sampleRate: Double = 16000
    private let windowMs: Double = 200
    private var energySamples: [Float] = []  // ring buffer of windowed energies
    private var silenceStartedAt: Date?
    private let silenceTriggerMs: TimeInterval = 0.8  // 800ms

    /// Calibrated threshold — set to 1.5× the long-term floor.
    /// Recalibrated on session start during the first 3s of audio while
    /// inspector hasn't spoken.
    private var silenceThreshold: Float = 0.005

    func processBuffer(_ buffer: AVAudioPCMBuffer) -> SilenceEvent? {
        let rms = computeRMS(buffer)
        energySamples.append(rms)
        if energySamples.count > 5 { energySamples.removeFirst() }  // 1s window

        let avg = energySamples.reduce(0, +) / Float(energySamples.count)
        let isSilent = avg < silenceThreshold

        if isSilent {
            if silenceStartedAt == nil { silenceStartedAt = Date() }
            else if Date().timeIntervalSince(silenceStartedAt!) > silenceTriggerMs {
                silenceStartedAt = nil  // one event per silence
                return .silenceDetected(durationMs: Int(silenceTriggerMs * 1000))
            }
        } else {
            silenceStartedAt = nil
        }
        return nil
    }
}
```

**What to do on `silenceDetected`:**
The choice is which signal to feed into the existing pipeline:

**Option A — fire `deepgramServiceDidReceiveUtteranceEnd` synthetically.** Treats it like Deepgram's UtteranceEnd. Triggers existing final-fire path if there's a pending interim. **Simpler, but** the "current final" may not exist yet — handleUtteranceEnd guards on `firedTurnEndForCurrentUtterance`.

**Option B — send `{type: "Finalize"}` to Deepgram WS.** Forces Deepgram to commit a final immediately. Deepgram-supported, returns a real `is_final=true` message which goes through `handleFinalTranscript` normally. **Cleaner integration, no synthetic events,** and the final transcript is Deepgram's actual output (not iOS guessing).

**Recommendation: Option B.** Send `Finalize` to Deepgram, let the normal pipeline do the rest. RMS gate is just an *upstream signal that pokes Deepgram when its server-side endpointer is stuck.*

**Calibration:**
- First 1.5s of session, before any speech (use `isSpeaking == false` from existing speech-start detection), accumulate RMS samples.
- Set `silenceThreshold = max(percentile(samples, 95) * 1.5, 0.003)` — adapts to mic floor without going below a hard floor.
- Recalibrate every 30s if `isSpeaking == false`.

**Coordination with TTS:**
- Don't fire silence-detected during TTS playback (echo would be misclassified, plus we don't want to Finalize the inspector's prior utterance during TTS).
- Existing `alertManager.isTTSSpeaking` flag is the source of truth.

**Coordination with Silero VAD (sleep/wake):**
- They're separate — Silero is used for sleep/wake gating (silence > 60s → doze). RMS gate is for in-conversation silence (< 1s → finalize).
- They share the AVAudioEngine tap but consume independently.

**Files to touch:**
- New file `Sources/Audio/SilenceGate.swift` — the RMS class with calibration
- `Sources/Audio/AudioEngine.swift` — wire SilenceGate into the existing tap callback (alongside Silero + Deepgram feed)
- `Sources/Services/DeepgramService.swift` — new `sendFinalize()` method that sends `{type: "Finalize"}` JSON
- `Sources/Recording/RecordingSessionCoordinator.swift` — owns the SilenceGate instance, hooks `silenceDetected` → `deepgramService.sendFinalize()`

**Tests to add:**
1. Pure-silence buffer → triggers after 800ms, calibrated threshold
2. Buffer with speech then silence → triggers 800ms after speech end
3. Continuous low-amplitude noise (mic floor) → does NOT trigger (calibration adapts)
4. TTS playing → all silence ignored, no fire
5. Deepgram disconnected → don't try to send Finalize

**Risk / rollback:** false-positive Finalize could chop the inspector's mid-sentence pause. Mitigation:
- 800ms silence requirement is conservative (longer than typical word-finding pauses)
- Hesitation-conjunction detection from `DeepgramService.endsWithHesitationConjunction` should suppress Finalize if interim ends in a continuer ("...and", "...because")
- Build flag `STAGE6_RMS_FINALIZE` defaults ON; turn off for a build if field tests show truncation

---

## Sequencing & dependencies

```
              ┌─────── #20 server transcript-fallback ────────┐
              │  (independent, ships solo)                    │
              │                                               │
              ├─────── #23 iOS RMS finalize ──────────────────┤  ──► Field test
              │  (independent of #21, but enhances it)        │      (build N)
              │                                               │
              └─────── #21 iOS interim-fire ──────────────────┘
                  (depends on #20 OR existing fuzzy fallback
                   to handle the synthetic-utterance-id case)
```

**Recommended order:**

1. **Week 1 — #20 server transcript-fallback** (smallest, lowest risk, can ship to prod independently). Adds defence-in-depth before iOS work lands. Opens the door for #21 (which relies on #20 to handle the synthetic-utterance-id case cleanly).

2. **Week 1 — #23 iOS RMS finalize** (independent of server). Quickest win for the silent-room case. Ships in TestFlight build N.

3. **Week 2 — #21 iOS interim-fire**. Largest behavioural change. Ships in TestFlight build N+1 after #20 is baked in prod for a few days.

4. **Week 2-3 — Bring `ASK_USER_TIMEOUT_MS` back down** to 20s once iOS Build N+1 is on TestFlight and analyzer shows median `wait_duration_ms` < 1.5s.

---

## Field test plan

Per stage, before flipping defaults / lowering timeout:

1. **Lab test** (Derek, on his desk, quiet room) — speak 10 questions, time the gap between voice-end and TTS-next using session log. Expect median < 1s after #21 lands.
2. **Real cert test** — one full EICR cert in TestFlight. Watch for:
   - Any `answer_outcome: 'timeout'` rows in `stage6.ask_user` log
   - Any `wait_duration_ms > 5000` outliers
   - Any `duplicate_after_interim` rows (iOS regression)
3. **Analyzer regression sweep** — run `analyze-session.js` against last 5 cert sessions and confirm:
   - No new error categories
   - `transcript_fallback` count is non-zero (proves #20 is firing on real data)
   - `interim_fire` count rises after #21 ships, `final_fire` count falls

If field test passes, lower `ASK_USER_TIMEOUT_MS` to 20s in a single follow-up commit (no other changes) so any regression bisects cleanly.

---

## Open questions

1. **Should the server transcript-fallback (#20) also handle the case where iOS sends `ask_user_answered` AFTER the transcript?** Today there's a wire-ordering invariant (`r4-#1`, transcript first). If iOS interim-fire ships, the order may invert (interim-fire could land before the transcript final). Need to confirm `seenTranscriptUtterances` Set logic doesn't reject the later-arriving transcript.

2. **What's the right `FALLBACK_WINDOW_MS` for #20?** 8s is a guess. Should be ≤ `ASK_USER_TIMEOUT_MS` and > typical answer time. Depends on what real-world data shows; calibrate after first week of `transcript_fallback` log rows.

3. **Should `interimFire=true` skip `seenTranscriptUtterances` Set lookup entirely on the backend?** Or use the synthetic id and accept a guaranteed Set miss? Cleaner to skip, but means the "final arrives later, dedupe via Set" path can't run for this path. Probably fine — the `consumedByInterim` flag on iOS is the dedupe authority.

4. **Should #23 also send Finalize for the main extraction path** (not just ask resolution)? Same logic applies: any in-flight interim, any 800ms silence → Finalize. Bigger blast radius but equally beneficial. Defer to a follow-up sprint after the ask path is solid.

5. **Calibration storage** — should the RMS threshold persist across sessions in `UserDefaults`? Or recalibrate every session? Recommend per-session for safety (different mic, different room).

---

## Pointers

- Bug-H workaround commit: `38ef901` (server, ASK_USER_TIMEOUT_MS 20→45s)
- Build 303 utterance_end_ms commit: `8491b0a` (iOS, 1500→1000ms)
- General-condition regex bound commit: `1b02db5` (iOS)
- Backend ask dispatcher: `src/extraction/stage6-dispatcher-ask.js`
- Backend pending-asks registry: `src/extraction/stage6-pending-asks-registry.js`
- iOS final-fire path: `DeepgramRecordingViewModel.swift:1561 appendToTranscriptAndExtract`
- iOS interim handling (today): `DeepgramRecordingViewModel.swift:1411 handleInterimTranscript`
- Wire-ordering invariant: `Plan 06-05 r4-#1` block comment in `appendToTranscriptAndExtract`
- Deepgram silent-room reference: https://github.com/orgs/deepgram/discussions/409
- Deepgram Finalize message: https://developers.deepgram.com/docs/finalize
