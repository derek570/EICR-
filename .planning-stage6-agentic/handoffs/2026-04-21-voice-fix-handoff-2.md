# Handoff #2 — Voice-quality fixes (continued from 2026-04-21-voice-fix-handoff.md)

**Date:** 2026-04-21 (evening)
**Author:** Derek + Claude (Opus 4)
**Branch:** `stage6-agentic-extraction` (both `EICR_Automation` and `CertMateUnified`)
**Trigger:** Picked up Fix 2 from the morning handoff; Codex review caught a P1 regression; fixed. Fix 3 still untouched.

---

## What shipped this session (CertMateUnified)

### ✅ Fix 2 — `in_response_to` anchor at TTS-end + widen stale window

**Commit:** `b6fbd2f` on `stage6-agentic-extraction`

Files:
- `Sources/Services/ServiceProtocols.swift` — add `var onAlertTTSFinished: ((ValidationAlert) -> Void)?` to `AlertManagerProtocol`.
- `Sources/Recording/AlertManager.swift` — property + fire-site in `markTTSFinished` (see Fix 2a below for the corrected gating).
- `Sources/Recording/DeepgramRecordingViewModel.swift`:
  - `inFlightQuestionStaleWindow: TimeInterval = 4.0` → `10.0`.
  - New `handleAlertTTSFinished(_ alert:)` — re-stamps `inFlightQuestion.askedAt = Date()` when `current.question == alert.message`. Emits `inflight_question_reanchored_tts_end` debug log + `client_diagnostic inflight_reanchored_tts_end` with `preTTSAgeMs` so CloudWatch can see the widened budget in action.
  - Wired up `alertManager.onAlertTTSFinished = { [weak self] alert in self?.handleAlertTTSFinished(alert) }` in the VM's `start()` block next to the existing `onAlertTTSStarted`.
  - Cleared in the cleanup block.
- `Tests/CertMateUnifiedTests/Mocks/MockAlertManager.swift` — matching property + `simulateAlertTTSFinished(_ alert:)` helper symmetric to `simulateAlertTTSStarted`.
- `Tests/CertMateUnifiedTests/Recording/AlertManagerTests.swift` — `tearDown` clears new callback.

**Why the window moved 4 s → 10 s:** the 4 s limit (shortened on 2026-04-20 to kill the RG30 postcode bug) was anchored at TTS-*start*, so it counted down through the 2-12 s ElevenLabs fetch and playback. The real reply, arriving ~8-12 s after TTS-start, landed outside the window and lost its `in_response_to` context. Switching the anchor to TTS-end + widening to 10 s gives a conservative 10-second head-room measured from the moment the inspector actually hears the question finish.

### ✅ Fix 2a — P1 regression fix: gate re-anchor on natural playback completion

**Commit:** `cfe060d` on `stage6-agentic-extraction`

**What Codex caught in review of `b6fbd2f`:**

`AlertManager.markTTSFinished()` is reached from two kinds of call sites:
1. **Natural completion** — `AVAudioPlayer.audioPlayerDidFinishPlaying` and `AVSpeechSynthesizer.speechSynthesizer(_:didFinish:)`. Firing the callback here is correct.
2. **Forced stop** — `stopAllSpeech()` from `dismissCurrentAlert()`, `handleAutoDismiss()`, `presentAlert()`, `presentInformational()`, `clearAll()`, `stopTourSpeech()`. On all these paths `currentAlert` is still set AND `isResolving` is still false at the moment `markTTSFinished` runs (e.g. `dismissCurrentAlert` at `AlertManager.swift:547-560` calls `stopAllSpeech()` on line 551 *before* setting `currentAlert = nil` and `isResolving = false` on lines 554-556; `handleAutoDismiss` calls `dismissCurrentAlert` at line 699 *before* flipping `isResolving = true` on line 706).

So the `currentAlert && !isResolving` gate alone was insufficient — the callback fired on abandoned/timed-out questions and re-anchored `inFlightQuestion.askedAt` to the dismiss instant. The inspector's next unrelated sentence in the following 10 s would then inherit `in_response_to` for a question they never heard to completion. Exactly the RG30 misattribution shape.

**Fix:**
- Add `naturalCompletion: Bool = false` parameter to `markTTSFinished`.
- Pass `naturalCompletion: true` from both delegate-finish methods.
- Gate the callback on `naturalCompletion && currentAlert && !isResolving`.
- `!isResolving` retained to still suppress the response TTS ("Updated" / "Okay, keeping it") that plays during the 1.2 s resolve-animation window.

Build: `BUILD SUCCEEDED` on `generic/platform=iOS Simulator`.

---

## Remaining work (unchanged from morning handoff, re-stated)

### ⏳ Fix 3 — Question text + ElevenLabs logging (backend, `EICR_Automation`)

Still outstanding. Four call sites:

| Site | Current | Target |
|------|---------|--------|
| `src/extraction/question-gate.js:340-343` | `{count}` | add `questions: pendingQuestions.map(q => ({ type, field, circuit, question: q.question, heard_value }))` |
| `src/extraction/sonnet-stream.js:921, 1259` | `{questions: N}` | expand to include first 1-2 question objects' `{type, field, circuit, questionPreview}` |
| `src/routes/keys.js:267` (`ElevenLabs TTS success`) | `{bytes}` | add `{ sessionId, textPreview: text.slice(0,120), textLength: text.length, bytes }` |
| `src/routes/keys.js` proxy body | `{text}` only | accept optional `{text, sessionId}`, look up `CostTracker` by session, call `addElevenLabsUsage(text.length)` on 200 OK |

**iOS caller change:** `Sources/Services/APIClient.swift:684 proxyElevenLabsTTS(text:)` — add `sessionId:` parameter. Callers in `AlertManager` know the active session via `ServerWebSocketService.sessionId`.

**Web caller change:** `web/src/lib/recording/*` — parity only; iOS is the deployed path.

**Tests:** extend `src/__tests__/cost-tracker.test.js` with a proxy integration test (mock fetch, assert `addElevenLabsUsage` is called with the right character count when `sessionId` is supplied). Update `question-gate.test.js` to assert the richer log payload.

**Why:** Derek's original ask — "track Sonnet's response so we can see exactly what it asked, and track 11 Labs to see if it asked it." With these four log sites emitting `sessionId` + text, a single CloudWatch query reconstructs the full Sonnet-question → TTS-text-spoken chain per session. No iOS debug-log upload required.

### ⏳ Deeper Fix 1 test coverage (carried from morning handoff Codex review)

Fake-WebSocket harness needed in `DeepgramServiceTests` to feed `handleMessage(.string(...))` JSON payloads. Coverage gaps:
1. Deferred `speech_final` followed by real `UtteranceEnd` → exactly one turn-end call on the delegate.
2. Deferred `speech_final`, then resumed speech before 1500 ms → no premature turn-end.
3. Deferred hesitation final, then later non-hesitation `speech_final` → one turn-end from the later final.
4. `last_word_end == -1` dedupe still suppresses Deepgram's redundant `UtteranceEnd`.
5. `"On."` / `"It was."` false-positive regression through the full message-sequence path.

### 🆕 Minor follow-up noted in this session

`DeepgramRecordingViewModel.swift:1944` — the misattribution-suspicion heuristic fires at `replyAge > 5.0`. That threshold was set against the old 4 s stale window, so `>5 s` was already stale and the branch never ran in practice. With the new 10 s + TTS-end anchor, legitimate 6-9 s replies now trip the `reply_misattribution_suspected` log event. Behaviour unchanged (it only logs), so this is log-noise rather than a correctness bug. Raise to `~7.5 s` when next touching the file; not worth its own commit.

---

## Operational reminders

- **iOS debug-log upload is still broken** (see `memory/MEMORY.md`, `analytics_upload_cloudwatch_query.md`). Field forensics for the new re-anchor diagnostics must come via the `client_diagnostic` piggyback on the ServerWebSocket — grep CloudWatch for `"inflight_reanchored_tts_end"` once Build 75+ is on TestFlight.
- **ElevenLabs cost tracking is still zero per session** until Fix 3 lands.
- **Verifying Fix 2 / Fix 2a in the field:** CloudWatch should now show `inflight_reanchored_tts_end` events with `preTTSAgeMs` roughly matching the TTS fetch+play duration (typically 2000-8000 ms). Absence of `inflight_anchor_missed` on legitimate Sonnet questions is the positive signal. The re-anchor should NOT appear on dismissed/timed-out questions after `cfe060d`.

---

## Suggested next-session prompt

> Open `.planning-stage6-agentic/handoffs/2026-04-21-voice-fix-handoff-2.md`.
> Working directory: `/Users/derekbeckley/Developer/EICR_Automation` (NOT `CertMateUnified`).
> Pick up Fix 3 (backend question-text + ElevenLabs logging). Read
> `src/extraction/question-gate.js:320-360`,
> `src/extraction/sonnet-stream.js:900-940` and `1240-1280`, and
> `src/routes/keys.js:250-290` first. Start with the three log-payload
> expansions (question-gate + sonnet-stream + keys.js success log) as one
> commit, then the `sessionId` plumbing + `addElevenLabsUsage` call as a
> second commit with a matching iOS-side `APIClient` change as a third.
> Tests: extend `src/__tests__/cost-tracker.test.js` + `question-gate.test.js`.

---

## Commit trail

```
cfe060d fix(ios): only fire onAlertTTSFinished on natural playback completion
b6fbd2f fix(ios): anchor in_response_to at TTS-end and widen stale window to 10s
71e73cd fix(deepgram): defer speech_final turn-end on hesitation-conjunction tails   ← Fix 1 (morning)
```

Both this-session commits build clean on `generic/platform=iOS Simulator`. Pre-existing `MockAPIClient` protocol-conformance error in the test target is unrelated (verified via `git stash`).
