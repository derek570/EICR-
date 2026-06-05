# Flux focused-answer turn detection — PLAN_v2 (2026-05-25, reconciled)

> Supersedes PLAN.md. Addresses every BLOCKER + IMPORTANT from
> `claude-review.md` and `codex-review.md`. Three Derek decisions
> incorporated (Q1=b retract, Q5=drop Layer 3, Q6=runtime flag). Resolved
> decisions table at the end.

## TL;DR

Two-TestFlight strategy. **TF#1 (Layer 1)** ships the safe-by-construction
half: mid-stream Flux `Configure` swaps on the `ask_user` lifecycle plus a
real cancellable timer plus a runtime kill switch — moves
focused-answer turn-to-text from ~5000ms to ~700-1500ms with zero
correctness risk. **TF#2 (Layer 2)** adds eager dispatch with a proper
backend retract path (`amend_ask_user_answered`), bringing the speculative
case to ~300-700ms when the inspector doesn't self-correct. Layer 3
(VAD-Finalize) is dropped: Flux does not document `Finalize` as a control
message, and the 1500ms `eot_timeout_ms` floor from Layer 1 is acceptable.

## Problem (one paragraph, unchanged from PLAN.md)

`DeepgramService.swift buildFluxURL` connects to Flux with
`eot_threshold=0.7`, `eot_timeout_ms=5000`, `eager_eot_threshold` unset.
Flux's turn-detection model is acoustic + semantic; single-word answers
("eight", "yes", "two") are low semantic content and rarely cross 0.7
confidence quickly, so finalisation falls through to the 5000ms backstop.
The `InFlightQuestion` state in `DeepgramRecordingViewModel`
(`handleAlertTTSStarted` call site) already tells iOS when we're awaiting
a focused answer — we just don't tell Flux.

## Why the in-flight `voice-latency-2026-05-23` sprint doesn't solve this

That sprint targets **TTS-side** latency: stream Sonnet → stream
ElevenLabs → iOS PCM playback, cutting "utterance-final → audible
confirmation" from ~3–4s to ~1.5–2s. Flux STT is explicitly out of scope
there. STT turn-to-text is **upstream** of everything that sprint
optimises — TTS streaming starts only after Flux commits the final
transcript. The two sprints compose.

## Architectural decisions (changes vs PLAN.md)

| # | Decision | Was (PLAN.md) | Now (PLAN_v2) | Driver |
|---|---|---|---|---|
| D1 | Eager dispatch model | Q1=(a) trust-and-accept | Q1=(b) eager + amend on divergence (proper retract path) | Codex B2 + Claude B1 — the value-correction flow doesn't exist on stage6 alerts; trust-and-accept loses corrected finals |
| D2 | Layer 3 (VAD-Finalize) | Silero silence → `Finalize` JSON | **Dropped.** Layer 1's `eot_timeout_ms=1500` is the worst-case floor. | Codex B5 — Flux only documents `Configure` + `CloseStream`; `Finalize` is Nova-only. KeepAlive JSON was already rejected as `UNPARSABLE_CLIENT_MESSAGE` in this codebase. |
| D3 | Kill switch mechanism | Compile-time `VOICE_FOCUSED_ANSWER_EAGER_DISPATCH` | UserDefaults runtime flag + Settings row | Claude I1 — TestFlight redeploy is 1-6+ hours best case, days if Apple holds review. Not an operational kill switch. |
| D4 | Backend immutability | "No backend changes" | One backend change: `amend_ask_user_answered` handler in `stage6-answer-resolver.js`. | D1 requires it. Sprint scope updated; HANDOFF.md `MANDATORY backend-immutable` rule escalation acknowledged. |
| D5 | TestFlight chain structure | Single chain S1-S8 | Two chains: TF#1 (S1-S4 + S5) Layer 1 + runtime flag scaffold; TF#2 (S6-S10) Layer 2 + backend amend + telemetry | Claude I8 — Layer 1 is low-risk, Layer 2 is the risk surface. Split lets us field-validate Layer 1 in isolation before adding eager speculation. |
| D6 | Configure JSON shape | `eot_threshold` top-level | `"thresholds": { "eot_confidence": ..., "eot_timeout_ms": ..., "eager_eot_confidence": ... }` | Codex B1 — Deepgram's Flux `Configure` docs nest thresholds under `thresholds`. Field names per docs are `eot_confidence` / `eager_eot_confidence`, NOT `eot_threshold` / `eager_eot_threshold`. **Implementer must verify against `developers.deepgram.com/docs/flux/configure` before S1.** |
| D7 | Restore-defaults Configure | Reconstruct keyterms from KeywordBoostGenerator | Cache the canonical keyterm list at session start (post URL-length filter); the restore Configure sends that cached list verbatim. | Codex IMPORTANT (keyterm replace) + Claude I5 (no cached "what was sent") |
| D8 | ConfigureFailure handling | Default — flows to `notifyError(connectionFailed)` → full WS teardown + reconnect | Soft warning only. Log, telemeter, do NOT trigger reconnect. Bail to whatever config Flux is currently running with. | Claude B3 — a single Configure typo kills the session for 1-30s; unacceptable on the focused-answer hot path. |

## Three options now (re-grounded)

### Option A — Tune URL params globally (rejected as before)
HIGH chop risk on normal long dictation. Same verdict as PLAN.md.

### Option B — Layer 1 only (TF#1 standalone, fallback path)
Mid-stream Configure swap on ask_user lifecycle. No eager dispatch. No
backend changes. Latency target: 700-1500ms. Cleaner than PLAN.md's
Option B because Layer 3 is dropped.

| | |
|---|---|
| Engineering | ~3 days iOS |
| Latency on "eight" | 700-1500ms (vs 5000ms today) |
| Correctness risk | None — the corrected-final case never arises because we don't dispatch eagerly |
| Backend changes | Zero |

### Option C — Layer 1 + Layer 2 with proper retract (recommended)
Layer 1 as Option B, **plus** Layer 2: act on `EagerEndOfTurn`,
dispatch optimistically via `sendAskUserAnswered`. On `TurnResumed` OR
on divergent `EndOfTurn`, send `amend_ask_user_answered` to backend
which clears the previous answer in the same turn and applies the
corrected one. Runtime flag lets us kill Layer 2 without rebuild.

| | |
|---|---|
| Engineering | ~3 days iOS Layer 1 + ~2 days iOS Layer 2 + ~1 day backend = ~6 days |
| Latency on "eight" | 300-700ms (eager) / 700-1500ms (final, when eager fired but diverged) |
| Correctness risk | LOW — divergence handled by amend handler; flag kills eager dispatch if amend handler proves brittle |
| Backend changes | One handler in `stage6-answer-resolver.js` |

**Recommended.** Two-TestFlight rollout (TF#1 = Layer 1 only;
TF#2 = Layer 2 added after Layer 1 verified in one field session).

## Recommended path — slice by slice

### TF#1 chain (Layer 1 + runtime flag scaffold)

| Slice | What | Files (symbols, not line numbers) | LOC est. | Tests |
|---|---|---|---|---|
| **S1** | Add `sendConfigureMessage(eotConfidence:, eotTimeoutMs:, eagerEotConfidence:, keyterms:)` to `DeepgramService`. Serialises JSON with the correct `"thresholds": {...}` nesting per D6. Sends via `.string(json)` on existing WS. **D8: handle `ConfigureFailure` as soft warning** — log + telemeter; do NOT call `notifyError`. Cache the session-canonical keyterm list at first send (D7). | `DeepgramService` (`buildFluxURL` call site + new method + `handleFluxEvent` `ConfigureFailure` branch) | ~60 | Unit: JSON encoder produces the canonical shape from `developers.deepgram.com/docs/flux/configure`. Unit: `ConfigureFailure` does not trigger reconnect. |
| **S2** | Add `FocusedAnswerKeyterms.swift`: digits 1-50, "main", "spare", "none", "yes", "no", "live", "neutral", "earth". Cached static list. | new file | ~40 | Unit: list is non-empty + contains expected tokens. |
| **S3** | Add `enterFocusedAnswerMode()` / `exitFocusedAnswerMode()` to `DeepgramService` or `DeepgramRecordingViewModel`. Composes session-canonical keyterms (cached at S1) + focused-answer keyterms (S2) per Q3=append. Calls S1 with focused params. Exit calls S1 with restored params. **D7: restore uses cached canonical list, not regenerated.** **B4 fix: ENTER schedules a `DispatchWorkItem` for 10s that fires `exitFocusedAnswerMode()` if not cancelled. EXIT cancels the work item.** | `DeepgramService` (new methods + cached state) | ~100 | Unit: enter → exit cancels timer. Unit: timer fires after 10s if not cancelled. Unit: enter is idempotent (second call resets timer, no double-Configure). |
| **S4** | Wire S3 calls to `ask_user` lifecycle. Enter on `handleAlertTTSStarted` for `stage6_ask_user` alerts only. Exit on first final (`didReceiveFinalTranscript` for the matching toolCallId) OR on the 10s timer (S3) OR on alert dismissal. **I2 fix: barge-in case — `markTTSFinished(naturalCompletion: false)` must also call `exitFocusedAnswerMode()`** to avoid stuck focused-mode if inspector barges in then never answers. **I3 fix: stacked asks — second `enterFocusedAnswerMode()` is idempotent + resets the 10s timer (already handled by S3)**. | `DeepgramRecordingViewModel` (`handleAlertTTSStarted`, `didReceiveFinalTranscript`, `dismissCurrentAlert` callers), `AlertManager` (`markTTSFinished`) | ~80 | Unit: TTS-start triggers enter; TTS natural-finish triggers exit only after timer fires (NOT immediately — answer window remains open). Unit: barge-in triggers immediate exit. Unit: stacked asks reset timer. Integration: mock TTS + transcript round-trip. |
| **S5** | UserDefaults runtime flag `voiceFocusedAnswerLayer1Enabled` (default `true`) + Settings row in `Sources/Views/Settings/RecordingSettingsView.swift` (or equivalent). S3 enter/exit short-circuit to no-op when flag is `false`. **D3 fix: real operational kill switch.** | `Sources/Views/Settings/` (Settings row), `DeepgramService` (flag read) | ~50 | Unit: enter is no-op when flag false. Manual: Settings row toggles + verify. |

**TF#1 totals: ~330 LOC across 5 commits. iOS only. Zero backend
changes. Ships as one TestFlight build.**

### TF#1 field-test gate (between TF#1 and TF#2)

Derek runs one field session with at least 5 `ask_user` moments:
- 3 intentionally short ("eight", "yes", "two")
- 1 longer ("circuit eight, two-pole")
- 1 with a deliberate ~2s thinking pause mid-answer ("circuit... eight")

Pass criteria:
- Short-answer turn-to-text P50 ≤ 1500ms (Layer 1 floor)
- No chopped multi-word answers
- No regressions in normal long dictation
- Settings toggle visibly kills focused-mode behaviour when off

If pass → ship TF#2. If fail → diagnose via S8 telemetry (lands in
TF#2) or in-flight logging. Layer 1 alone is the fallback shipping
state — TF#2 is additive, not a fix.

### TF#2 chain (Layer 2 + backend amend + telemetry)

| Slice | What | Files | LOC est. | Tests |
|---|---|---|---|---|
| **S6** | Wire `EagerEndOfTurn` + `TurnResumed` Flux events through to delegate. Add `didReceiveEagerFinalTranscript(text:turnId:)` + `didReceiveTurnResumed(turnId:)` to `DeepgramServiceDelegate`. ViewModel: log + telemeter only (no dispatch yet). One commit; sets up the wire without behavioural change. | `DeepgramService` (`handleFluxEvent`), `DeepgramRecordingViewModel` (new delegate methods) | ~70 | Unit: parse `EagerEndOfTurn` / `TurnResumed` JSON → delegate fires with correct args. |
| **S7** | **Backend.** Add `amend_ask_user_answered` WS handler in `src/extraction/sonnet-stream.js` + `src/extraction/stage6-answer-resolver.js`. Semantics: the incoming amend carries `tool_call_id` + `answer`. Backend looks up the just-applied answer for that toolCallId; if found and current turn is still in progress (`pendingAsks.history` not yet flushed), replaces the answer value and re-runs the resolver. If the turn has already finalised, falls back to the existing classifyOvertake path (still better than dropping). Emits `amend_ack` over WS with `accepted: bool + reason`. | `src/extraction/sonnet-stream.js`, `src/extraction/stage6-answer-resolver.js`, new shared message-type schema | ~200 + tests | Unit: amend within turn replaces value. Unit: amend after turn falls back to overtake. Integration: replay harness scenario for amend acceptance. |
| **S8** | iOS Layer 2 dispatch. On `EagerEndOfTurn` in focused-mode + flag-enabled state: dispatch `sendAskUserAnswered(toolCallId, answer, eager: true)` immediately. Mark `pendingEagerToolCallId` + cache the eager text. Do NOT dismiss the alert. Do NOT insert into `firedAskUserAnsweredToolCallIds` yet. On `TurnResumed`: send `sendAmendAskUserAnswered(toolCallId, answer: nil, reason: "turn_resumed")` to backend (or just wait for the final and amend then). On divergent `EndOfTurn`: send `sendAmendAskUserAnswered(toolCallId, answer: final, reason: "eager_diverged")`. On matching `EndOfTurn`: no-op (already dispatched). **Now safe to insert into `firedAskUserAnsweredToolCallIds` + dismiss alert** at EndOfTurn time, not eager time. | `DeepgramRecordingViewModel`, `ServerWebSocketService` (new `sendAmendAskUserAnswered`) | ~150 | Unit: eager dispatch fires send. Unit: TurnResumed triggers amend with null answer. Unit: divergent final triggers amend with corrected answer. Unit: matching final is no-op. |
| **S9** | UserDefaults runtime flag `voiceFocusedAnswerLayer2Enabled` (default `true`) + Settings row. S8 dispatch short-circuits to no-op when flag is `false`, falling back to Layer 1 final-only behaviour. **D3 fix: independent kill switch for Layer 2.** | `Sources/Views/Settings/`, `DeepgramRecordingViewModel` | ~30 | Unit: flag-false short-circuits S8. Manual: Settings toggle. |
| **S10** | Telemetry hookup. Record per-focused-answer: TTS-end → eager event ms, TTS-end → final event ms, eager-vs-final agreement (match / diverge / TurnResumed), amend round-trip ms, `amend_ack.accepted` rate. Hook into existing `voice_latency.startup_log` channel if voice-latency-2026-05-23 has merged; otherwise inline structured `AppLogger` events. **N3 fix: no hard dep on voice-latency sprint.** | `DeepgramService`, `DeepgramRecordingViewModel`, optionally backend `voice-latency-telemetry.js` if available | ~50 | Manual: CloudWatch grep for the new event shape. |

**TF#2 totals: ~500 LOC across 5 commits (iOS + 1 backend). Ships as
second TestFlight.**

## Validation strategy (corrected for I4)

### Pre-deploy: plumbing-only

- All slices have unit tests as listed above. Hard requirement.
- Replay harness fixtures under `tests/fixtures/voice-latency-scenarios/focused-answer/`
  for **backend amend logic only** (S7). These do NOT validate Flux
  latency — they validate that the backend handler correctly
  supersedes a previous answer.
- iOS unit tests cover the state machine: enter/exit, timer
  scheduling/cancellation, idempotency, flag short-circuit, eager
  dispatch + amend round-trip with mock WS.

### Field-test gate: the only real latency validation

- **TF#1 field session** as described above. Latency target verified
  on actual Flux against actual inspector audio.
- **TF#2 field session** after TF#1 ships. Additional criteria:
  - Eager dispatch fires within 300-700ms of speech-end on short answers
  - Divergent-final amend round-trip completes within 200ms backend
    + 100ms iOS = <300ms total
  - No user-visible inconsistency on the "eight" → "eight point five"
    correction case (inspector hears confirmation update or hears the
    final value as the only confirmation, not a stale "eight" with no
    correction)

## Rollback story (corrected for I1)

- **Layer 1 (TF#1) misbehaving**: toggle Settings → "Focused-answer mode
  (Layer 1)" OFF. Takes effect on next `ask_user`. Inspector self-serves
  in seconds.
- **Layer 2 (TF#2) misbehaving**: toggle Settings → "Eager dispatch
  (Layer 2)" OFF. Layer 1 still active; speed degrades from 300-700ms
  back to 700-1500ms but correctness intact.
- **Backend amend handler misbehaving**: env var
  `VOICE_AMEND_ASK_USER_DISABLED=true` on backend task def, deploy via
  CI. Backend returns `amend_ack.accepted=false, reason="disabled"`
  for every amend. iOS sees the rejection and falls back to the next
  final dispatch as if Layer 2 weren't there. ~30 min infra-from-source
  deploy.
- **Catastrophic Layer 1 + 2 both bad**: both Settings toggles OFF →
  back to today's behaviour (5000ms floor). No code revert needed.

## Resolved decisions (Derek, 2026-05-24 and 2026-05-25)

| # | Decision | Value | Driver |
|---|---|---|---|
| Q1 (final) | Layer 2 dispatch model | **(b) Proper retract via `amend_ask_user_answered`** | Q1=(a) trust-and-accept was based on a wrong assumption — Codex B2 + Claude B1 proved the value-correction flow doesn't exist. Retract is the only safe path. |
| Q2 | `eager_eot_confidence` value | **0.4** | Unchanged. Telemetry-driven adjustment post-deploy. |
| Q3 | Focused-mode keyterms | **append to session defaults** | Unchanged in intent. **Mechanism updated**: cache canonical list at session start (D7) because Configure REPLACES the list per Codex IMPORTANT + Claude I5. |
| Q4 | S5 telemetry-only first? | **N/A — superseded by TF#1/TF#2 split (D5)** | Q4's premise (eager dispatch is the risk surface) is correctly addressed by shipping Layer 1 in TF#1 + Layer 2 in TF#2, validating each field session before the next. |
| Q5 | Layer 3 (VAD-Finalize) | **Dropped** | Codex B5 — Flux doesn't document `Finalize` as a control message. 1500ms Layer 1 floor accepted. |
| Q6 | Kill switch mechanism | **UserDefaults runtime flag + Settings row** | Claude I1 — compile-time = 1-6+ hour TestFlight cycle, not a real safety valve. |

## Costs (corrected from PLAN.md)

- **Engineering**: ~3 days iOS (TF#1) + ~3 days (TF#2: 2 iOS + 1 backend) = ~6 days total.
- **Runtime**: Layer 1: zero. Layer 2: each TurnResumed or divergent
  final fires one `amend_ask_user_answered` round-trip (~150-300ms
  backend; same single Sonnet turn — amend replaces in-turn, no
  re-extraction). Net LLM cost increase: zero on accepted amends, +1
  Sonnet turn only on the "amend after turn finalised" overtake
  fallback (rare). Per Codex IMPORTANT cost-math: on ask-heavy
  sessions with N=20 focused asks and r=5% TurnResumed rate, ~1 extra
  Sonnet turn per session — ~$0.001. Not zero, but trivial.
- **Risk**: low-medium. The amend handler is the new attack surface;
  thorough unit + replay tests + backend kill-switch env var mitigate.

## Composition with Loaded Barrel + voice-latency-2026-05-23 sprints

| Stage | Today | After TF#1 (Layer 1) | After TF#2 (Layer 2) | + voice-latency TTS streaming |
|---|---|---|---|---|
| Audio "eight" → Flux final | ≤5000ms | 700-1500ms | 300-700ms (eager) / 700-1500ms (final) | Same as TF#2 |
| Final → Sonnet first token | ~700-900ms | ~700-900ms | ~700-900ms (eager dispatch path equivalent) | ~700-900ms |
| Sonnet → ElevenLabs first byte | ~2000-3000ms | ~2000-3000ms | ~2000-3000ms | ~200-400ms |
| ElevenLabs → audible | ~250-500ms | ~250-500ms | ~250-500ms | ~100-200ms |
| **TTS-end → "Got it, eight"** | **~8-9s** | **~3.5-5.5s** | **~3.5-5s (eager) / ~3.7-5.5s (final)** | **~1.3-2.3s** |

**Loaded Barrel intersection (N4)**: Layer 2's optimistic TTS
confirmation passes `turnId` through `speakBriefConfirmation` as
existing Loaded Barrel does. On TurnResumed amend, the new TTS call
has a different `turnId` → cache miss → fresh ElevenLabs synth. Cache
waste, not corruption. Documented; no action needed.

**voice-latency-2026-05-23 intersection (I8 / N3)**: S10 telemetry
gracefully degrades if `voice-latency-telemetry.js` isn't merged yet
(uses inline `AppLogger` events as fallback). No sequencing
dependency on the voice-latency iOS TestFlight cycle.

## Doc-anchor discipline (N1)

This PLAN_v2 uses symbol references (e.g. `handleAlertTTSStarted`,
`InFlightQuestion` struct, `dispatchAskUserAnswered` call site) rather
than line numbers. The reviewer's line numbers in `claude-review.md` /
`codex-review.md` are evidence pointers for that review run only and
will rot; the implementer should re-`grep` for the symbols when
working a slice.

## Open questions (none blocking; flagged for implementer)

- **Q7** — Stacked-asks ordering on Layer 2: when Q1 has fired eager
  dispatch but no final yet, then Q2's TTS-start fires
  `enterFocusedAnswerMode()` (idempotent, no-op), and then EndOfTurn
  arrives — is it Q1's final or Q2's? `firedAskUserAnsweredToolCallIds`
  is per-toolCallId so the gate still works. But if the eager
  dispatch for Q1 was wrong and the answer was really Q2's first word,
  we have an attribution bug. Realistic mitigation: backend's
  `pendingAsks` FIFO already disambiguates by `tool_call_id` (the iOS
  send includes it). If the implementer hits ambiguity in S8, add a
  test fixture for the stacked case and let backend's existing
  attribution win.
- **Q8** — App backgrounding (Claude I6): on
  `AVAudioSession.interruptionNotification` + `.began`, call
  `exitFocusedAnswerMode()` to clear state and cancel the timer. On
  resume + WS reconnect, focused-mode starts fresh on the next
  `ask_user`. Implementer should add this in S3 or S4 as a single
  additional callback wiring.
