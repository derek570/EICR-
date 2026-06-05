# Flux focused-answer turn detection — PLAN (2026-05-24, pre-review)

## TL;DR

Inspector says "eight" after a focused TTS question; Flux holds the interim
for up to 5 seconds before finalising. Fix it by sending Deepgram's native
mid-stream `Configure` message on the existing Flux WebSocket when iOS
enters focused-answer mode — drop `eot_threshold` 0.7 → 0.5, drop
`eot_timeout_ms` 5000 → 1500, enable `eager_eot_threshold` 0.4, inject
question-specific keyterms (digits / yes / no), then restore defaults on
first final or 10s timeout. Wire the `EagerEndOfTurn` / `TurnResumed`
events that today are log-only so we can act on the fast path. No backend
changes, no vendor switch, no reconnect.

Target latency: focused-answer utterance-final → Sonnet dispatch **<800ms**
(today: up to 5000ms). Cost: ~0 runtime, ~2-3 days iOS engineering.

## Problem (one paragraph)

`DeepgramService.swift:679-723` connects to Flux with default config
`eot_threshold=0.7`, `eot_timeout_ms=5000`, `eager_eot_threshold` unset.
Flux's turn-detection model is acoustic + semantic. Single-word answers
("eight", "yes", "two") are low semantic content; the model rarely
crosses 0.7 confidence on them, so finalisation falls through to the
5000ms timeout backstop. Inspector sees grey/interim text in
`TranscriptBarView` for that whole window. The `inFlightQuestion` state
in `DeepgramRecordingViewModel.swift:2489-2509` already tells iOS when
we're awaiting a focused answer — we just don't tell Flux.

## Why the in-flight `voice-latency-2026-05-23` sprint doesn't solve this

That sprint targets **TTS-side** latency: stream Sonnet → stream
ElevenLabs → iOS PCM playback to cut "utterance-final to audible
confirmation" from ~3–4s to ~1.5–2s. It explicitly puts Flux STT
replacement out of scope (HANDOFF.md L34). Even if that sprint ships
fully, focused-answer turn-to-text is **upstream** of everything it
optimises — TTS streaming starts only after Flux commits the final
transcript. Today that commit takes up to 5000ms; the voice-latency
sprint can't reach its 1.5-2s audible-confirmation goal if STT
contributes >800ms on focused answers.

The two sprints compose: ship Flux focused-answer config + ship TTS
streaming, get utterance-end → "Got it, eight" in ~1.5-2s total.

## Three options compared

### Option A — Tune Flux URL params globally (no mid-stream swap)
Lower `eot_threshold` to 0.5 and `eot_timeout_ms` to 1500 in
`buildFluxURL()`, full stop. Single 5-line change.

| | |
|---|---|
| Engineering | ~½ day |
| Latency on "eight" | ~500-800ms |
| Risk to normal dictation | **HIGH** — inspector reads test readings 3-4 min at a stretch; mid-sentence pauses below 1500ms would chop ("Ze… is 0.13" splits into two turns) |
| Runtime cost | 0 |

Reject — the normal-dictation chop risk is unacceptable given how the
inspector actually works.

### Option B — Flux `Configure` mid-stream swap on ask_user lifecycle (recommended)
On `ask_user` TTS start, send a `Configure` JSON over the live Flux WS
with focused-mode params. On first final / 10s timeout, send another
`Configure` to restore defaults. Reuses existing `inFlightQuestion`
trigger. Wire EagerEndOfTurn / TurnResumed events so the speculative
fast path is available.

| | |
|---|---|
| Engineering | ~2-3 days iOS |
| Latency on "eight" | ~300-700ms (eager) / ~700-1500ms (final-only) |
| Risk to normal dictation | **LOW** — focused config only applies during ask_user window, restored automatically |
| Runtime cost | Eager dispatch may double-fire on ~5% of focused turns (TurnResumed cancellation); ~5% of focused turns is ~5% of ~5% of all turns ≈ 0.25% — trivial |

Recommended. Detail in §"Recommended path" below.

### Option C — Bypass Flux EOT with iOS-side VAD finalisation (Codex Ideas 1/2/11)
On focused-mode entry, when Silero VAD reports 300ms silence after
speech, send `{"type": "Finalize"}` over the Flux WS to force-commit the
current interim regardless of model confidence.

| | |
|---|---|
| Engineering | ~1-2 days iOS |
| Latency on "eight" | ~400-600ms |
| Risk to normal dictation | **LOW** (gated on `inFlightQuestion != nil`) |
| Risk in focused mode | **MEDIUM** — VAD is acoustic-only and can't tell "eight…" (still thinking) from "eight." (done). Multi-word answers like "circuit eight" might commit after "circuit" if there's a thinking pause. |
| Runtime cost | 0 |

Useful as a **fallback layer** under Option B, not as the primary fix —
Flux's native Configure + eager events are the cleaner, less brittle
mechanism per the web research. Use Option C as the safety net if
Option B doesn't close the gap.

## Recommended path: Option B with a Layer 3 safety net

Three layers, independent, ship in order. Each is independently
testable and reversible.

### Layer 1 — Flux `Configure` mid-stream swap (primary, ~1.5 days)

The default behaviour change. When entering focused-answer mode, send a
JSON control message over the existing Flux WS:

```json
{
  "type": "Configure",
  "eot_threshold": 0.5,
  "eot_timeout_ms": 1500,
  "eager_eot_threshold": 0.4,
  "keyterms": ["one","two","three",...,"twenty-four","main","spare","none","yes","no"]
}
```

When leaving focused mode (first final received, OR ask_user timeout
fires, OR `inFlightQuestion` cleared by other path), send the
restore-defaults Configure:

```json
{
  "type": "Configure",
  "eot_threshold": 0.7,
  "eot_timeout_ms": 5000,
  "eager_eot_threshold": null,
  "keyterms": [<session-default keyterms from KeywordBoostGenerator>]
}
```

Verify Deepgram accepts the no-reconnect path — their docs
([flux-on-the-fly-configuration](https://deepgram.com/learn/flux-on-the-fly-configuration))
explicitly say yes, but instrument the first build to confirm.

### Layer 2 — Eager event acted on (secondary, ~0.5 day)

`EagerEndOfTurn` is already parsed at `DeepgramService.swift:1068-1072`
but only logged. Wire it through to a new delegate method
`deepgramService(_:didReceiveEagerFinalTranscript:turnId:)`. In
`DeepgramRecordingViewModel`, when this fires AND
`inFlightQuestion != nil`:

1. Mark a `pendingEagerToolCallId = currentToolCallId`
2. Dispatch the answer to Sonnet via `sendAskUserAnswered()` immediately
   (same path as today's final, but tagged `eager: true`)
3. Start TTS playback of the confirmation optimistically

If `TurnResumed` fires before `EndOfTurn`:
- Send a retract via the existing `turnId` channel
  (`ServerWebSocketService.cancelAskUserAnswer(toolCallId:)`)
- Stop TTS playback (AlertManager has a stop API)

If `EndOfTurn` fires:
- If it matches the pending eager transcript → no-op (already dispatched)
- If it diverges → send a correction via the same retract+resend path

**Decision deferred to Derek**: is the retract path worth the
complexity, or do we just trust the eager event (and accept the
~5% false-positive rate where the inspector continues talking)?
See "Open questions" §1.

### Layer 3 — Silero VAD silence → `Finalize` safety net (~½ day)

If neither EagerEndOfTurn nor EndOfTurn fires within 1.5s of Silero VAD
reporting silence in focused-answer mode, send
`{"type": "Finalize"}` to force-commit. Belt-and-braces against Pipecat
#3643-style edge cases where Flux is still stuck.

This is independent of Layer 2 — if eager fires, Layer 3 never triggers.

## Slice-by-slice commits

| Slice | What | Files | LOC est. | Tests | Ships? |
|---|---|---|---|---|---|
| S1 | Add `sendConfigureMessage(eotThreshold:, eotTimeoutMs:, eagerEotThreshold:, keyterms:)` to DeepgramService. Pure encoder + WS send, no callers yet. | `DeepgramService.swift` | ~40 | Unit test serialising the JSON to expected string | Yes |
| S2 | Add `enterFocusedAnswerMode()` / `exitFocusedAnswerMode()` to DeepgramRecordingViewModel. Call S1 with focused / default config. No event wiring yet — proves the round-trip. | `DeepgramRecordingViewModel.swift` | ~60 | Unit test the state transitions; integration via mock WS | Yes |
| S3 | Hook S2 calls to `inFlightQuestion` lifecycle: enter on TTS start (line 2600), exit on first final (line 2078) or 10s timeout. | `DeepgramRecordingViewModel.swift` | ~30 | Integration test with mock TTS + transcript | Yes |
| S4 | Add focused-answer keyterm vocab (`Sources/Recording/FocusedAnswerKeyterms.swift`): digits 1–24, "main", "spare", "none", "yes", "no", "live", "neutral", "earth". Pass to S2. | new file + `DeepgramRecordingViewModel.swift` | ~50 | Unit test the vocab generator | Yes |
| S5 | Wire EagerEndOfTurn / TurnResumed delegate path. Add `didReceiveEagerFinalTranscript` to `DeepgramServiceDelegate`. ViewModel: log + telemetry. | `DeepgramService.swift`, `DeepgramRecordingViewModel.swift` | ~80 | Unit test event parsing → delegate; integration with mock Flux event | Yes |
| S6 | Layer 2 trust-and-accept dispatch (Q1=a, locked). On eager event in focused mode, dispatch answer to Sonnet immediately via existing `sendAskUserAnswered()`, tagged `eager: true`. No retract path — false positives ride the existing value-correction flow. Ships chained with S5; observe + tweak post-deploy. | `DeepgramRecordingViewModel.swift` | ~80 | Replay-harness scenarios: clean short answer + interrupted-answer-then-correction (verifies correction-flow path) | Yes, behind compile-time flag `VOICE_FOCUSED_ANSWER_EAGER_DISPATCH` (default ON; flip OFF + rebuild kills Layer 2 only, leaves Layer 1 + 3 intact) |
| S7 | Layer 3 VAD-silence Finalize watchdog. Sends `{"type":"Finalize"}` if no eager/final within 1.5s of Silero silence in focused mode. | `DeepgramRecordingViewModel.swift`, `DeepgramService.swift` | ~50 | Mock-VAD test | Yes (default ON, since it's idempotent) |
| S8 | Telemetry: record per-focused-answer (a) time from TTS-end to eager event, (b) time from TTS-end to final event, (c) whether VAD-Finalize was needed, (d) any TurnResumed retracts. Hook into voice-latency telemetry channel from `voice-latency-2026-05-23`. | `DeepgramService.swift`, `DeepgramRecordingViewModel.swift`, `voice-latency-telemetry.js` (read-only consumer) | ~40 | Visual inspection of CloudWatch | Yes |

Total: ~430-550 LOC across ~8 commits. S1-S8 ship as a single chain
(no Derek gate between slices); Layer 2 dispatch behaviour is observable
+ killable via the `VOICE_FOCUSED_ANSWER_EAGER_DISPATCH` compile-time
flag post-deploy.

## Validation strategy

### Pre-deploy

- **Unit tests per slice** as above. Hard requirement.
- **Replay harness** (`scripts/voice-latency-bench/transcript-replay.mjs`,
  shipped by the voice-latency sprint). Add new fixtures under
  `tests/fixtures/voice-latency-scenarios/focused-answer/`:
  - `single_digit_answer_eight.yaml`
  - `single_word_yes.yaml`
  - `multi_word_answer_circuit_eight.yaml`
  - `interrupted_answer_eight_then_correction.yaml`
  - `silent_room_short_answer.yaml` (Pipecat #3643 repro)
  - Pin today's baseline latency in `baseline/`, target ~800ms in
    expected-config branch.

### Field-test gate

After S1-S8 deploy and TestFlight build lands:
- Derek runs one field session with at least 5 ask_user moments,
  some intentionally short ("eight", "yes"), some longer ("circuit
  eight, two-pole"), and at least one intentionally interrupted
  ("eight ... point five") to exercise the trust-and-accept correction
  flow.
- Pass criteria:
  - Short-answer turn-to-text P50 < 800ms (Layer 1 + Layer 2 combined)
  - No chopped multi-word answers
  - No regressions in normal long dictation
  - Interrupted-answer case: eager dispatch fires, inspector says
    "no, eight point five", Sonnet's value-correction flow handles it
    without user-visible breakage
- If pass → done.
- If interrupted-answer case is too jarring → flip
  `VOICE_FOCUSED_ANSWER_EAGER_DISPATCH=false`, rebuild, ship. Layer 1
  + Layer 3 alone should still hit ~700-1500ms (acceptable fallback).
  Escalate to a Q1=(b) retract-path follow-up sprint only if Layer 1
  alone is insufficient.

## Rollback

- All changes behind iOS-side state — no backend deploy, no infra change.
- Hard rollback: revert the commits chain on iOS, ship a new TestFlight.
  Backend doesn't know any of this exists.
- Soft rollback: feature flag `VOICE_FOCUSED_ANSWER_MODE` (compile-time
  bool in `DeepgramService.swift` next to `sttModel`) — default ON,
  flip to OFF + rebuild if a regression surfaces. No restart needed
  between sessions because the focused-mode entry point is the
  Configure call, which simply becomes a no-op if the flag is off.

## Resolved decisions (Derek, 2026-05-24)

| # | Decision | Value | Notes |
|---|---|---|---|
| Q1 | Layer 2 dispatch model | **(a) trust-and-accept** | No retract path. Eager event → immediate dispatch via existing `sendAskUserAnswered()`. False positives ride the existing value-correction flow. Escalate to Q1=(b) only if field testing shows (a) is too jarring. |
| Q2 | `eager_eot_threshold` value | **0.4** | Telemetry-driven adjustment post-deploy if numbers warrant it. |
| Q3 | Focused-mode keyterms | **append** to session defaults | Keeps board-specific terms (manufacturer, OCPD types) active during focused answers like "MK two". |
| Q4 | S5 telemetry-only first? | **No — ship S5 + S6 together** | Faster iteration cycle. Telemetry from S8 still captures eager-vs-final timing for post-deploy tweaking. Compile-time flag `VOICE_FOCUSED_ANSWER_EAGER_DISPATCH` is the safety valve if eager dispatch needs to be killed without losing Layer 1 / 3. |

## Costs

- **Engineering**: ~2-3 days iOS, ~0 days backend (assuming Q1 = (a)).
- **Runtime**: ~0. The `Configure` message is a single small JSON
  every focused-answer entry + exit (≤4 per minute in worst case).
  Eager mode is locally scoped — no global LLM-call inflation.
- **Risk**: low. Focused-mode config is overlay-only; if it breaks,
  ship rollback flag, no backend touched.

## Composition with `voice-latency-2026-05-23` sprint

If/when that sprint's TTS streaming ships, the user experience for the
"eight" answer becomes:

| Stage | Today | After this sprint (S1-S5, S7) | + voice-latency TTS streaming |
|---|---|---|---|
| Audio "eight" arrives → Flux final | up to 5000ms | 300-800ms | 300-800ms |
| Final → Sonnet first token | ~700-900ms | ~700-900ms | ~700-900ms |
| Sonnet → ElevenLabs first byte | ~2000-3000ms | ~2000-3000ms | ~200-400ms |
| ElevenLabs → audible | ~250-500ms | ~250-500ms | ~100-200ms |
| **Total: TTS-end to "Got it, eight"** | **~8-9 s** | **~3-5 s** | **~1.3-2.3 s** |

Both sprints needed to hit the 1.5-2s target Derek raised.
