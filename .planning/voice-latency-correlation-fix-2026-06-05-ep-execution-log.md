# /ep Execution Log — voice-latency-correlation-fix-2026-06-05

**Session ID:** 20260605T135029Z-ep
**Started:** 2026-06-05T13:50:29Z
**Plan:** `PLAN-final.md` in this directory
**Backend worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260605T135029Z-ep`
**Backend branch:** `ep/voice-latency-correlation-fix-2026-06-05-20260605T135029Z-ep` (cut from backend `main @ ab4ed4d2`)
**iOS worktree:** none (torn down — server-only default per Phase 2.1 Hypothesis B)
**Parallel /ep session:** voice-feedback-2026-06-05 (SID 20260605T134858Z-ep, backend worktree at `EICR_Automation-ep-20260605T134858Z-ep-backend`)

## Start-of-execution user decisions (one allowed prompt per plan §"Repo layout")

- **Backend branch base:** `ab4ed4d2` (local main HEAD, includes unpushed `fix(cost-tracker): bill Sonnet/Haiku/Opus tokens at correct per-model rates` from 2026-06-05 12:10). PR will ship cost-tracker fix alongside this work. User confirmed.
- **Server-only execution:** iOS worktree torn down. Phase 2.1 default Hypothesis B (server-side echo gap) drives the work; if Phase 1.1 disproves it, /ep STOPs and surfaces per Execution constraints. User confirmed.

---

## Step log

### Phase 1.1 — Diagnose 100% orphan rate
- **Status:** applied (root cause confirmed: Hypothesis B)
- **Decision:** rule 1 (verbatim execution of plan diagnostic steps).
- **Files inspected (no edits):**
  - `src/extraction/sonnet-stream.js` — confirmed the three `{type:'extraction', result}` emit sites at lines 2308, 3070, 4069 use `{ ...rest } = result; { readings: extracted_readings, ...rest }` — so `result.utterance_id` would auto-propagate if the bundler wrote it.
  - `src/extraction/sonnet-stream.js:3895` — the `runShadowHarness` call from `handleTranscript` does NOT pass `consumedUtteranceId` in options (no `utteranceId` field in the options object).
  - `src/extraction/stage6-shadow-harness.js:735` — `runLiveMode`'s `bundleToolCallsIntoResult` call passes `{ confirmationsEnabled, turnId, circuitDesignations, boardDesignations, totalCircuitsInJob }` — NO `utteranceId`.
  - `src/extraction/stage6-event-bundler.js:467-741` — `bundleToolCallsIntoResult` reads `options.turnId` and writes `result.turn_id = _turnId` (line 550), but has NO `options.utteranceId` reader and NO `result.utterance_id` write.
  - `Sources/Services/ClaudeService.swift:376-425` — iOS DOES decode `utterance_id` via `RollingExtractionResult.utteranceId` (decodeIfPresent String?, CodingKey `"utterance_id"`). Comment explicitly says this is Tier 1.3 wiring.
  - `Sources/Recording/DeepgramRecordingViewModel.swift:8592-8628` — iOS DOES read `result.utteranceId`, look it up in `pendingUtteranceEnds`, and fire the non-orphan `postUtteranceEnd(...)`. Comment says "backend's sonnet-stream.js attached the LAST utterance_id consumed by this turn onto result.utteranceId" — but the implementation never does.
- **Root cause:** server's bundler never writes `result.utterance_id` because the field is not threaded through `handleTranscript → runShadowHarness → runLiveMode → bundleToolCallsIntoResult`. iOS path is wired and functional; the binding never arrives, so the 30s TTL fires on every utterance_end and 100% of POSTs are `orphaned: true`.
- **Implication for Phase 2.1:** plan's default fix is correct verbatim. Server-only change. No iOS modification needed for the extraction-envelope scope.
- **Commit:** none (diagnosis only).

### Phase 1.2 — Classify timeout/empty-ack turns (CloudWatch-only)
- **Status:** applied (mixed evidence found)
- **Decision:** rule 1 (verbatim CloudWatch queries per plan §1.2).
- **Evidence (session 84CE2125, 14 turn_audio_summary rows, 3 late_playback_ack rows):**

  | Turn | expected_acks | eligible | timeout_fired | late_ack_arrived | Failure mode |
  |---|---|---|---|---|---|
  | 1  | 1 | 1 | 1 | none | iOS never emitted (Apple-native fallback OR silent drop) |
  | 2  | 1 | 1 | 0 | — | clean |
  | 3  | 1 | 1 | 0 | — | clean |
  | 4  | 2 | 1 | 0 | — | clean (multi-slot bundle, both acks landed in window) |
  | 5  | 1 | 1 | 0 | — | clean |
  | 6  | 1 | 1 | 1 | none | iOS never emitted (same as turn-1) |
  | 7  | 1 | 1 | 1 | yes, bundler | window too short — ack landed after 8 s finalizer |
  | 8  | 1 | 1 | 0 | — | clean |
  | 9  | 0 | 0 | 0 | — | ineligible (chitchat, no expected audio) |
  | 10 | 1 | 1 | 1 | yes, bundler | window too short |
  | 11 | 1 | 1 | 0 | — | clean |
  | 12 | 1 | 1 | 0 | — | clean |
  | 13 | 0 | 0 | 0 | yes (eligible=0, not counted) | ineligible |
  | 14 | 0 | 0 | 0 | — | ineligible |

- **Eligible turns with no ack:** 4 (turns 1, 6, 7, 10) of 11 eligible.
- **Two distinct failure modes:**
  - **Server-fixable (turns 7, 10):** ack arrived; current 8 s `FINALIZER_TIMEOUT_MS` was too short. Widening to e.g. 12-16 s would catch them. Plan §2.2 path (a).
  - **iOS-fixable (turns 1, 6):** no ack ever recorded. Most likely the `speakWithAppleNative` fallback path (no `postPlaybackAck` call in code). Closing this requires iOS edits to AlertManager.swift's Apple-native paths to emit `source: 'local_fallback'` from AVSpeechSynthesizer's didStart boundary. Plan §2.2 path (b). This is a **TestFlight cycle** per Execution constraints.
- **Late-ack arrival times** (raw): turn-7 late ack at 10:41:07.248, summary at 10:41:15.610 (Δ ≈ 8.4 s); turn-10 late ack at 10:42:44.996, summary at 10:42:53.505 (Δ ≈ 8.5 s). Both arrive ~8 s *after* the finalizer fires — so the underlying ack arrival is ~16 s after TTS dispatch. Widening to 16 s would have caught both.

### Phase 2.2 — Playback-ack timeout fix
- **Status:** skipped (ambiguity ladder rule 3 + TestFlight gate)
- **Decision rationale:**
  - The iOS-side fix (Apple-native `local_fallback` emit) is **TestFlight-gated** per the plan's Execution constraints (which explicitly say "STOP and surface for user decision before any TestFlight cycle"). /ep should NOT ship this autonomously.
  - The server-side widening (FINALIZER_TIMEOUT_MS 8 s → 16 s) is technically simple but materially impacts turn-pacing: a doubled finalizer keeps each turn's bind window open for an extra 8 s, which can delay the dispatcher's progression to the next turn in chains where the finalizer is on the critical path. Plan §"Risks" already flags this as Medium risk. Given Phase 2.3's new `voice_latency.turn_perceived_latency_skipped` event will SURFACE the missing-ack failure for both shapes (eligible-no-ack-at-ttl), the dashboard signal post-deploy will tell us whether widening is genuinely needed OR whether the missing acks are all iOS-side (Apple-native, true fix is the iOS emit).
  - **Defer rationale:** ship 2.1 + 2.3 first; the new dashboard will distinguish "widen helps" from "iOS Apple-native is the real culprit" on the first post-deploy field test. The current 4/11 eligible-no-ack rate (36%) is severe but the perceived-latency dashboard's per-turn skipped-events are exactly the observability the user needs to make the 2.2 shape decision empirically.
- **Follow-up for user:** after this PR ships and the dashboard reports skipped-reasons for a real session, decide between (a) widen FINALIZER_TIMEOUT_MS to 16 s server-side, or (b) cut TestFlight build with Apple-native `local_fallback` emit in AlertManager.swift, or (c) both. Track in TODO.
- **Files inspected (no edits):** none.
- **Commit:** none.

### Phase 2.1 — Thread utterance_id through extraction envelope
- **Status:** applied
- **Decision:** rule 1 (verbatim execution of plan §2.1 default path).
- **Files edited:**
  - `src/extraction/stage6-event-bundler.js` — add `options.utteranceId` reader; emit `result.utterance_id` when truthy (mirrors `turn_id` emit-when-truthy at line 550, preserving the iOS-parity regression test's strict 3-key empty-input contract).
  - `src/extraction/stage6-shadow-harness.js` — thread `options.utteranceId` into `runLiveMode`'s `bundleToolCallsIntoResult` call (line 735).
  - `src/extraction/sonnet-stream.js` — capture `consumedUtteranceId` at `handleTranscript` line ~3895 from `msg.utterance_id` (priority) or `msg.consumed_utterance_id` (defensive fallback). Pass into `runShadowHarness` options.
  - `src/__tests__/stage6-event-bundler.test.js` — 6 new unit tests in "utterance_id echo" describe block (emit-on-string, omit-on-missing/null/empty, coexistence with turn_id, defensive type rejection).
- **Test result:** 45/45 stage6-event-bundler tests pass (6 new + 39 existing).
- **Limitation documented in commit:** question-only turns continue to orphan (iOS UserQuestion Codable doesn't decode utterance_id, handleServerQuestion has no postUtteranceEnd path). Closing requires coordinated iOS release per Execution constraints — explicitly out of scope.
- **Commit:** `5eb59913 fix(voice-latency): thread iOS utterance_id through extraction envelope`

### Phase 2.3 — Build voice-latency-perceived-latency.js store + unified row
- **Status:** applied
- **Decision:** rule 1 (verbatim execution of plan §2.3 with all defaults: additive scope, monotonic-clock subtraction, no `turn_text_preview` in v1).
- **Files added:**
  - `src/extraction/voice-latency-perceived-latency.js` (new — 419 lines including the docstring + test seam helpers). Three intake hooks (`recordUtteranceEnd`, `recordTurnAudioSummary`, `recordLatePlaybackAck`); two emit shapes (`voice_latency.turn_perceived_latency_ms` + `voice_latency.turn_perceived_latency_skipped` with structured `reason` codes). Leaf-only module — no import from `voice-latency-turn-summary.js` (avoids ESM circular dep).
  - `src/__tests__/voice-latency-perceived-latency.test.js` (new — 15 tests).
- **Files edited:**
  - `src/routes/voice-latency-utterance-end.js` — wire `recordUtteranceEnd` hook AFTER the canonical `logger.info('voice_latency.utterance_end', …)` (own try/catch).
  - `src/extraction/voice-latency-turn-summary.js` — import store hooks; wire `recordTurnAudioSummary` AFTER the canonical `logger.info('voice_latency.turn_audio_summary', enriched)` (own try/catch + early-return on canonical-emit throw so the store never sees half-baked fields); wire `recordLatePlaybackAck` AFTER the canonical `logger.info('voice_latency.late_playback_ack', …)` (own try/catch).
- **Test result:** 15/15 new tests pass; 23/23 existing voice-latency-turn-summary tests still green; 17/17 existing voice-latency-utterance-end-route tests still green.
- **Lifecycle invariants locked in tests:**
  - Arrival-order A + B both emit `turn_perceived_latency_ms` exactly once.
  - `process_uptime_id` mismatch emits `turn_perceived_latency_skipped(process_uptime_id_mismatch)` and NOT `turn_perceived_latency_ms`.
  - Eligible zero-ack + late-ack-before-TTL → merge + emit `turn_perceived_latency_ms`.
  - Eligible zero-ack at TTL → `turn_perceived_latency_skipped(no_audio_ack_at_ttl)`.
  - Ineligible zero-ack at TTL → SILENT DROP (no event of either kind).
  - Ineligible WITH ack → still emit `turn_perceived_latency_ms` (store does NOT filter; dashboard query does).
  - Late ack without prior summary → `turn_perceived_latency_skipped(late_ack_without_summary)` (diagnostic).
  - All three hooks are no-throw against garbage payloads.
- **Commit:** `c2a50057 feat(voice-latency): voice_latency.turn_perceived_latency_ms unified row`

### Phase 3.1 — Pre-deploy verification
- **Status:** applied
- **Decision:** rule 1 (run full backend suite).
- **Test result:** 4670 passed, 19 skipped (pre-existing), 0 failed. New tests confirmed in output. Worker exit warning is non-fatal (perceived-latency store timers all `.unref()`).
- **Commit:** none.

---

## Completed 2026-06-05T14:30:00Z

**Outcome header:** PARTIAL — 1 skipped (Phase 2.2), 6 applied (Phases 1.1, 1.2, 2.1, 2.3, 3.1, wrap-up).

**Commits on branch `ep/voice-latency-correlation-fix-2026-06-05-20260605T135029Z-ep`:**
- `5eb59913 fix(voice-latency): thread iOS utterance_id through extraction envelope` (Phase 2.1)
- `c2a50057 feat(voice-latency): voice_latency.turn_perceived_latency_ms unified row` (Phase 2.3)
- Plus the inherited `ab4ed4d2 fix(cost-tracker): bill Sonnet/Haiku/Opus tokens at correct per-model rates` from the chosen base (user-confirmed at startup, will ship in the same PR).

**Files touched (backend repo only):**
- `src/extraction/stage6-event-bundler.js` (modified — +25 / -0)
- `src/extraction/stage6-shadow-harness.js` (modified — +10 / -0)
- `src/extraction/sonnet-stream.js` (modified — +18 / -0)
- `src/extraction/voice-latency-turn-summary.js` (modified — +69 / -1)
- `src/extraction/voice-latency-perceived-latency.js` (new — 419 lines)
- `src/routes/voice-latency-utterance-end.js` (modified — +16 / -0)
- `src/__tests__/stage6-event-bundler.test.js` (modified — +67 / -0)
- `src/__tests__/voice-latency-perceived-latency.test.js` (new — 270 lines)

**Assumed decisions (sanity-check these):**
- `_utteranceId` emit-when-truthy in `bundleToolCallsIntoResult` (matches `turn_id` pattern; preserves iOS-parity regression test's strict 3-key empty-input contract instead of changing it).
- `consumedUtteranceId` priority order in `handleTranscript`: `msg.utterance_id` first, `msg.consumed_utterance_id` as defensive fallback (the latter is for ask_user_answered branches that don't reach this code path; cost-free safety net).
- `handleTtlExpiry`'s "both halves present" branch refined: if audio side has no actual ack, emit `no_audio_ack_at_ttl` rather than `process_uptime_id_mismatch` (which would only apply when both stamps exist and clearly differ).
- Returned-early on canonical emit throw in `emitTurnAudioSummary` so the new store never sees zombie half-baked fields (introduces a 1-line behavioural change: previously catch-and-continue, now catch-and-return).

**Skipped (Phase 2.2):**
- Reason: iOS-side fix is TestFlight-gated per Execution constraints; server-side widening is materially impactful on turn-pacing and the better signal comes from the post-deploy dashboard (Phase 2.3's new `no_audio_ack_at_ttl` skipped-event distinguishes iOS-missing-ack from window-too-short on the first real session).
- Follow-up: after this PR ships and one field session runs, decide (a) widen `FINALIZER_TIMEOUT_MS` from 8 s to 16 s, (b) cut TestFlight with Apple-native `local_fallback` emit in `AlertManager.swift`, or (c) both. Track in CertMate todos.

**Stashes left behind:** none.

**Tests run + result:** Full backend suite — 4670 passed, 19 skipped (pre-existing), 0 failed. 21 new tests added (6 bundler + 15 perceived-latency store). Worker exit warning is non-fatal (store timers all `.unref()`).

**Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260605T135029Z-ep`. Will be removed on clean exit.

**iOS:** untouched (server-only execution per the user's startup decision). No TestFlight cycle proposed.
