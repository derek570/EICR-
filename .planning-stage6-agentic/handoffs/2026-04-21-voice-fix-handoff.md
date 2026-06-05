# Handoff — Voice-quality fixes from session B4A72D77

**Date:** 2026-04-21
**Author:** Derek + Claude (Opus 4)
**Branch:** `stage6-agentic-extraction` (both `EICR_Automation` and `CertMateUnified`)
**Trigger session:** `B4A72D77-1C2C-4BDE-A23C-6D8AC36651E7` — user reported TTS questions fired twice and Sonnet ignored the answer.

---

## Root-cause summary (from CloudWatch + source)

Three independent defects stacked on the same job:

1. **Transcript truncation.** Deepgram `endpointing=300` fires `speech_final` on a 300 ms
   silence. When the inspector paused mid-sentence after `"…and it was"` the fragment was
   shipped as a completed turn, with no chance for the 1500 ms `utterance_end_ms` fallback
   to rescue it.

2. **`in_response_to` stale window is too short (4 s).** The anchor is set at TTS‑start
   time (`DeepgramRecordingViewModel.handleAlertTTSStarted`, `swift:1743`). With a real
   round‑trip of 8-12 s, most replies land outside the window, so `in_response_to` is
   never attached. Sonnet sees the reply with no question context → either extracts
   nothing or writes to the wrong field → re-asks.

3. **Observability blind spots.**
   - `question-gate.js:340` logs only `count`, never the question payload.
   - `sonnet-stream.js:921, :1259` same — count only.
   - `src/routes/keys.js:267` logs only `bytes`, never the text or a session id.
   - `addElevenLabsUsage()` (`cost-tracker.js:107`) exists but is **never called from
     production code** — only from tests. `cost_summary.json.elevenlabs = 0` while
     CloudWatch shows 6 real TTS calls in B4A72D77.

---

## What's already shipped in this session

### ✅ Fix 1 — Deepgram conjunction-hesitation deferral (iOS, `CertMateUnified`)

Files:
- `Sources/Services/DeepgramService.swift` — new `endsWithHesitationConjunction(_:)`
  static helper and a new `SPEECH_FINAL_DEFERRED` code path in `handleResults`.
- `Tests/CertMateUnifiedTests/Services/DeepgramServiceTests.swift` — 4 new tests.

Behaviour: when a `speech_final=true` final arrives and the transcript ends on a
conjunction / linking verb / article / short preposition, we do **not** fire the early
turn-end and we do **not** set `firedTurnEndForCurrentUtterance`. Deepgram's own 1500 ms
`utterance_end_ms` then decides. If the inspector resumes speaking, the next final
supersedes. If they don't, `UtteranceEnd` fires normally (the dedupe flag is still false,
so it's not swallowed).

Word set (final, after Codex review):

```
conjunctions: and, but, or, so, plus, because, cause, if, when, while, then, than
linking verbs: is, was, are, were, be, been, being
articles: the, a, an
prepositions: to, for, with, of, from, into, onto
```

**Deliberately EXCLUDED:** `on`, `by`, `in`, `at` — all valid short answers on site
("Is the switch on?" → "On.", "Tested by?" → "By me.").

**Latency cost:** ≤ ~1.5 s on any final that lands on a listed word and is genuinely the
end of the thought. The five cases currently in tests (`testHesitationConjunctionIgnoresNormalSentenceEndings`)
represent the typical inspector utterance shape — none of them are in the set.

**Build:** `xcodebuild -scheme CertMateUnified -destination 'generic/platform=iOS Simulator' build` → **BUILD SUCCEEDED**.

**Codex review:** correctness clean, state machine is sound; narrowed the set per its false-positive
call-outs; test-coverage gaps captured below.

---

## Remaining work

### ⏳ Fix 2 — Extend `in_response_to` anchor window (iOS)

**File:** `Sources/Recording/DeepgramRecordingViewModel.swift`

Two complementary changes:

1. **Switch anchor from TTS-start to TTS-end.** `AlertManager` already tracks
   `ttsAudioEndAt` (set in `markTTSFinished`, `AlertManager.swift:1143`). Add an
   `onAlertTTSFinished` callback (symmetric to the existing `onAlertTTSStarted`) and
   have `handleAlertTTSFinished` re-stamp `inFlightQuestion.askedAt = ttsAudioEndAt`.
   The user can only realistically answer once TTS finishes.

2. **Widen the stale window.** `inFlightQuestionStaleWindow: TimeInterval = 4.0` at line 1710.
   Raise to **10–12 s** measured from TTS-end. The code comment already admits the real
   round-trip is 8-12 s; the 4 s was an over-correction for the RG30 postcode bug.
   Combined with the anchor-at-TTS-end change above, 10 s is conservative.

**Tests to add** (`CertMateUnifiedTests/Recording/`):
- A unit test for the new TTS-end anchor helper.
- An integration-ish test with `MockAlertManager` that simulates `onAlertTTSStarted` → 6 s delay → transcript → asserts `in_response_to` is attached.

### ⏳ Fix 3 — Question text + ElevenLabs logging (backend, `EICR_Automation`)

Four call sites:

| Site | Current | Target |
|------|---------|--------|
| `src/extraction/question-gate.js:340-343` | `{count}` | add `questions: pendingQuestions.map(q => ({ type, field, circuit, question: q.question, heard_value }))` — full payload. |
| `src/extraction/sonnet-stream.js:921, 1259` | `{questions: N}` | expand to include first 1-2 question objects' `{type, field, circuit, questionPreview}` |
| `src/routes/keys.js:267` (`ElevenLabs TTS success`) | `{bytes}` | add `{ sessionId, textPreview: text.slice(0,120), textLength: text.length, bytes }` |
| `src/routes/keys.js` proxy body | only `{text}` | accept optional `{text, sessionId}` from iOS, look up the CostTracker for that session, call `addElevenLabsUsage(text.length)` on 200 OK |

**iOS caller change:** `Sources/Services/APIClient.swift:684 proxyElevenLabsTTS(text:)` —
add a `sessionId:` parameter, pass it in the request body. Callers in `AlertManager` already
know the active session via `ServerWebSocketService.sessionId` (or similar — verify on the way in).

**Web caller change:** `web/src/lib/recording/*` — same parameter addition. Not critical for
the bug since iOS is the deployed path, but worth parity.

**Tests:** extend `src/__tests__/cost-tracker.test.js` with a proxy integration test
(mock fetch, assert `addElevenLabsUsage` is called with the right character count when
a `sessionId` is supplied). Update `question-gate.test.js` to assert the richer log payload.

**Why this matters:** Derek's direct ask was "track Sonnet's response so we can see
exactly what it asked in a question, and then track 11 labs to see if it asked it." With
these four log sites emitting `sessionId` + text, you can grep CloudWatch for a session and
reconstruct the full Sonnet-question → TTS-text-spoken chain. No iOS debug-log upload
required.

### ⏳ Deeper Fix 1 test coverage (carried from Codex review)

Codex called out that the new tests only exercise the pure string helper. For the
state-machine behaviour of the deferral, add to `DeepgramServiceTests`:

1. Deferred `speech_final` followed by real `UtteranceEnd` → exactly one turn-end call on the delegate.
2. Deferred `speech_final`, then resumed speech before 1500 ms → no premature turn-end.
3. Deferred hesitation final, then later non-hesitation `speech_final` → one turn-end
   from the later final.
4. `last_word_end == -1` dedupe still suppresses Deepgram's redundant `UtteranceEnd`.
5. `"On."` / `"It was."` false-positive regression (partly covered by
   `testHesitationConjunctionAllowsLegitShortAnswers` but without the message-sequence path).

These need a fake WebSocket harness that feeds `handleMessage(.string(...))` JSON
payloads — `DeepgramServiceTests` currently has no such harness; grep existing tests for
any `URLSessionWebSocketTask.Message` feeders before adding one.

---

## Operational reminders

- **iOS debug-log upload is still broken** (see `memory/MEMORY.md`, `analytics_upload_cloudwatch_query.md`).
  Until that's fixed, all iOS-side TTS / TTS-gate forensics require reading the
  `client_diagnostic` piggyback on the ServerWebSocket. The B4A72D77 session logged
  `pendingAnalyticsUploads: 4` on connect — i.e. four prior sessions' debug logs are
  queued and stuck.
- **ElevenLabs cost tracking is currently zero for every session.** Until Fix 3 lands,
  `cost_summary.json.elevenlabs` is not a reliable number — grep CloudWatch for
  `"ElevenLabs TTS success"` instead.
- **Commit rules (project `CLAUDE.md`):** one concern per commit, detailed body
  explaining the WHY (prior incident, design trade-off). Auto-commit after each logical
  unit of work.

---

## Suggested next-session prompt

> Open this handoff doc. Pick up Fix 2 (iOS `in_response_to` anchor window). Read
> `Sources/Recording/DeepgramRecordingViewModel.swift:1687-1810` and
> `Sources/Recording/AlertManager.swift:1133-1150` first. Add the `onAlertTTSFinished`
> callback, re-anchor `inFlightQuestion.askedAt` on TTS-end, and widen the stale window
> to 10 s. Build, test, Codex review, commit as its own commit, then move to Fix 3.
