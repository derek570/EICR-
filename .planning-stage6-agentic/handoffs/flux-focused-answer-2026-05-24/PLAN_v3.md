# Flux focused-answer turn detection — PLAN_v3 (2026-05-25, reconciled round 2)

> Supersedes PLAN_v2.md. Addresses every BLOCKER + IMPORTANT from
> `claude-review-v2.md` and `codex-review-v2.md`. Derek decision Q1 escalated:
> Layer 2 redesigned around backend `eager_intent` buffer pattern (option (b))
> rather than client-side amend (which was structurally infeasible against the
> current `pendingAsks` registry / `runToolLoop` architecture).

## TL;DR

Two-TestFlight strategy as PLAN_v2, but Layer 2 rebuilt from scratch around
a **backend `eager_intent` buffer** that holds the eager answer WITHOUT
calling `pendingAsks.resolve()` until `EndOfTurn` matches it. This puts the
race-state machine on the layer that owns the writes (backend), where the
existing serial-queue patterns can wrap it. Layer 1 unchanged in shape but
with 5 BLOCKER fixes (correct Flux field names, 100-keyterm cap math,
ConfigureFailure state-clear, restore Configure retry, honest latency
floor). Total scope: ~3 days iOS for TF#1, then ~2-3 weeks backend + iOS
for TF#2.

## Problem (unchanged)

`DeepgramService buildFluxURL` connects to Flux with `eot_threshold=0.7`,
`eot_timeout_ms=5000`, `eager_eot_threshold` unset. Flux's turn-detection
model is acoustic + semantic; single-word answers ("eight", "yes", "two")
rarely cross 0.7 confidence quickly, so finalisation falls through to the
5000ms backstop. The `InFlightQuestion` state in
`DeepgramRecordingViewModel` (`handleAlertTTSStarted` call site) already
tells iOS when we're awaiting a focused answer — we just don't tell Flux.

## Why the in-flight `voice-latency-2026-05-23` sprint doesn't solve this

(Unchanged — Flux STT is upstream of TTS streaming. See PLAN_v2 §3.)

## Architectural decisions (changes vs PLAN_v2)

| # | Decision | Was (PLAN_v2) | Now (PLAN_v3) | Driver |
|---|---|---|---|---|
| D6-v3 | Configure JSON field names | `eot_confidence` / `eager_eot_confidence` (wrong) | **`eot_threshold` / `eager_eot_threshold` / `eot_timeout_ms`** (verified against `developers.deepgram.com/docs/flux/configure`), nested under `"thresholds": {…}`, validation requires `eager_eot_threshold <= eot_threshold` | Codex v2 BLOCKER — PLAN_v2's correction went the wrong direction. Field names are canonical and pinned here, NOT punted to implementer. |
| D7-v3 | Focused-mode keyterm composition | "Append focused terms to cached session list" → ~140-160 terms = `ConfigureFailure` | **Cap at ≤100 terms via priority merge.** Algorithm: take first 100 of `[focused-mode-essential ∪ session-critical ∪ session-other]` in that priority order. Focused-mode-essential = digits 1-50, "main", "spare", "none", "yes", "no", "live", "neutral", "earth" (~58 terms). Session-critical = top 30 board-specific terms from `KeywordBoostGenerator` (manufacturer, OCPD types, RCD ratings). Drop session-other to fit ≤100 cap. | Codex v2 BLOCKER — Flux Configure caps at 100 keyterms; "append" can't be naïve. |
| D8-v3 | ConfigureFailure handling | Soft warning, do not reconnect | **Soft warning + clear iOS focused-mode state + cancel 10s timer + telemeter "wrong-state-lie".** On ConfigureFailure for ENTRY: iOS abandons focused-mode immediately, behaves as if entry never fired, inspector sees default-Flux latency for this answer. On ConfigureFailure for RESTORE: retry up to 3x with exp backoff (50/100/200ms); if all 3 fail, force WS reconnect (`scheduleReconnect()`) to reset to URL-default Flux config. | Claude v2 B3-v2 + I7-v2 — without state-clear, iOS lies internally; without restore-retry, Flux stays in focused-mode forever and chops normal dictation. |
| D9-v3 (new) | ConfigureSuccess echo verification | Not specified | **S1 explicitly waits for `ConfigureSuccess` echo and asserts echoed `eot_threshold` / `eot_timeout_ms` / `eager_eot_threshold` / keyterms count match request.** Echo mismatch → telemeter as "config drift" + clear iOS focused-mode state (treat like ConfigureFailure). | Codex v1 IMPORTANT-#1 + Codex v2 NIT — Flux can silently coerce values; iOS needs a positive confirmation, not just absence-of-failure. |
| D10-v3 (new) | Layer 2 architecture | iOS-side `amend_ask_user_answered` after eager `sendAskUserAnswered` | **Pre-commit `eager_intent` buffer in backend.** iOS sends new `eager_intent` message on `EagerEndOfTurn` (NOT `ask_user_answered`). Backend buffers the (toolCallId, fluxTurnId, answer text) tuple WITHOUT calling `pendingAsks.resolve()`. On Flux `EndOfTurn`: iOS sends new `eager_commit` (text matches eager) OR `eager_discard` (text diverges or TurnResumed fired) message. Backend acts: commit → call existing `pendingAsks.resolve()` with the BUFFERED answer (the eager text); discard → call `pendingAsks.resolve()` with the FINAL answer normally. **`autoResolveWrite`, `speak_to_user`, and Sonnet round N+1 NEVER fire on the eager text alone** — they always fire on whatever wins between commit/discard. No state mutation happens before commit. No amend protocol needed. | Claude v2 B1-v2/B2-v2 + Codex v2 BLOCKERs 3/4/5 + reviewers' explicit recommended path (b). The race state machine moves to the backend where it can be wrapped in the existing `handleTranscript` `isExtracting`/`pendingTranscripts` serial-queue pattern (sonnet-stream.js:3249-3257). |
| D11-v3 (new) | Per-Flux-turn binding for eager state | Single-valued `pendingEagerToolCallId` | **Map `pendingEagerByFluxTurnId: [FluxTurnId: PendingEagerState]`** where each entry holds (toolCallId, answerText, sentAt). Eliminates stacked-asks attribution bug + two-finals-1ms-apart race (each Flux turn has its own id). On `EndOfTurn`: lookup by turnId. On Flux Configure restore: clear stale entries older than 30s. | Claude v2 B4-v2 + I6-v2 + Codex v2 BLOCKERs 6/7 — single-valued state is the root of multiple races. |
| D12-v3 (new) | Runtime flag in-flight behaviour | "Takes effect next ask_user" | **Toggle-OFF immediately triggers `exitFocusedAnswerMode()` if active.** Sends restore Configure (subject to D8-v3 retry/reconnect). Also discards any pending eager state (calls `eager_discard` for each entry in `pendingEagerByFluxTurnId`). Flag toggle is a single observable event in `UserDefaults.didChange`; not a sticky-until-next-event. | Claude v2 B6-v2 — flag is supposed to be kill switch; deferred-effect doesn't kill anything. |
| D13-v3 (new) | Backend serial queue for eager state | Implicit, none specified | **Reuse existing per-session `isExtracting` + `pendingTranscripts` queue from `sonnet-stream.js:3249-3257`.** Treat `eager_intent`, `eager_commit`, `eager_discard` messages as members of the same queue family as transcripts — drained in arrival order while `isExtracting=false`. Eager buffer mutations only happen between awaits inside this drain loop. | Claude v2 B5-v2 — no lock = race. Don't invent new infrastructure; extend the proven pattern. |
| D14-v3 (new) | Backend kill switch story | Env var `VOICE_AMEND_ASK_USER_DISABLED` + iOS rejection fallback (logically broken) | **Capability-gate the new wire format.** iOS advertises `supports_eager_intent: true` in `session_start` handshake; backend's env var `VOICE_FOCUSED_EAGER_INTENT_ENABLED` (default `true` once TF#2 ships) gates whether backend honours the new messages. If backend env var off: iOS sees `session_capabilities.eager_intent_enabled: false` in handshake response → Layer 2 dispatch short-circuits to no-op at iOS, never sends `eager_intent`. Layer 1 unaffected. **No mid-session rejection / corruption-after-the-fact path.** | Codex v2 BLOCKER #5 — `amend_ack=false` post-eager was logically incoherent. Pre-flight capability gate is the only sound rollback. |
| D15-v3 (new) | Telemetry shipping path | Inline `AppLogger` fallback when voice-latency-telemetry.js absent | **Backend per-turn `eager_state_log` event** emitted from existing `sonnet-stream.js` structured-log path. Carries (sessionId, turnId, toolCallId, eagerSentAt, commitOrDiscardAt, finalAt, agreementClass). Lands in CloudWatch via the standard `eicr-backend` log group. P50 measurable via existing CloudWatch Insights queries. No dependency on voice-latency sprint's telemetry channel. | Claude v2 I8-v2 — device-log-only hides the metric this sprint exists to track. |
| D16-v3 (new) | Layer 1 latency claim honesty | "700-1500ms range" | **"Median ~1500ms (the `eot_timeout_ms` floor); can fire earlier if Flux's confidence on the utterance crosses `eot_threshold=0.5` first. No guarantee under 1500ms; 700ms is the floor of the *eager event* timing, which Layer 1 explicitly does NOT act on."** Restated honestly. | Claude v2 I2-v2 + Codex v2 IMPORTANT — Layer 1 latency claim was conflating eager-event-arrival with final-arrival timing. |
| D17-v3 (new) | Layer 1 vs Layer 2 Configure params | Both use `eager_eot_threshold=0.4` in their Configure | **Layer 1 Configure: `eager_eot_threshold` UNSET** (omit from `thresholds` object). Eliminates `EagerEndOfTurn` event emission from Flux entirely in Layer-1-only mode → no logged-but-dropped event → no I2-v2 latency confusion. Layer 2 Configure (TF#2) adds `eager_eot_threshold=0.4` to enable eager events at that time. | Claude v2 I2-v2 — Layer 1 enabling eager events that get dropped is wasted bandwidth and confusing telemetry. |
| D18-v3 (new) | iOS reconnect buffer whitelist | Buffers transcript/correction/ask_user_answered | **Extend `ServerWebSocketService.send(_:)` reconnect buffer to include `eager_intent`, `eager_commit`, `eager_discard`.** Replay order: transcripts first (existing), then eager messages in arrival order. Without this, eager messages dropped during WS reconnect = stale answer committed when reconnect succeeds. | Codex v2 IMPORTANT — same bad-case as the original amend message had. |

## Three options now (re-grounded again)

### Option A — Tune URL params globally (still rejected)
HIGH chop risk. Same verdict.

### Option B — Layer 1 only (TF#1 standalone, fallback if TF#2 slips)
With all PLAN_v3 fixes. Latency: median ~1500ms; lower when Flux's
own confidence kicks in faster.

| | |
|---|---|
| Engineering | ~3 days iOS |
| Latency on "eight" | ~1500ms median, occasional faster |
| Correctness risk | None |
| Backend changes | Zero |

### Option C — Layer 1 (TF#1) + Layer 2 eager_intent buffer (TF#2, recommended)

Layer 1 as Option B. Then TF#2 adds the eager_intent buffer + commit/
discard wire protocol. Eager fires at ~300-700ms after speech-end;
backend buffers; on EndOfTurn commit (~1000-1500ms), the buffered
answer flows through the existing resolver — no second Sonnet round,
no `speak_to_user` retraction, no state mutation rollback.

Latency win: speech-end → Sonnet-dispatch ≈ 300-700ms (eager
event-to-commit dominated by Flux's own EagerEndOfTurn timing minus
iOS round-trip).

| | |
|---|---|
| Engineering | ~3 days iOS TF#1 + ~5 days backend + ~3 days iOS TF#2 = ~11 days total |
| Latency on "eight" | ~300-700ms (Layer 2 commit) / ~1500ms (Layer 2 discard fallback) |
| Correctness risk | LOW — buffer commits ONLY on EndOfTurn match; no state mutation before commit; capability-gated kill switch via D14-v3 |
| Backend changes | New eager_intent / eager_commit / eager_discard message handlers + buffer module + capability flag |

**Recommended.** Phased rollout: TF#1 in week 1; TF#2 development
weeks 2-3; TF#2 ships week 4 after TF#1 field session passes.

## Recommended path — slice by slice

### TF#1 chain (Layer 1 + runtime flag scaffold)

| Slice | What | Files (symbols, not line numbers) | LOC est. | Tests |
|---|---|---|---|---|
| **S1** | `sendConfigureMessage(eotThreshold:, eotTimeoutMs:, eagerEotThreshold:, keyterms:)` on `DeepgramService`. **D6-v3: canonical Flux Configure shape** (`{"type":"Configure","thresholds":{"eot_threshold":0.5,"eot_timeout_ms":1500},"keyterms":[…]}`). `eagerEotThreshold:` is optional; if non-nil add to `thresholds` map. **D9-v3: wait for `ConfigureSuccess` echo within 500ms (Combine future or async/await), verify echoed values match request, fail closed if mismatch.** **D8-v3: ConfigureFailure → no reconnect; raise `didReceiveConfigureFailure(reason:)` delegate event.** Cache canonical session keyterms at first send. | `DeepgramService` (`buildFluxURL` call site, new method, `handleFluxEvent` ConfigureSuccess/ConfigureFailure branches), `DeepgramServiceDelegate` (new method) | ~120 | Unit: JSON encoder produces D6-v3 canonical shape verbatim. Unit: ConfigureSuccess echo with matching values → no error. Unit: ConfigureSuccess echo with diverging values → triggers config-drift event. Unit: ConfigureFailure → no reconnect call. |
| **S2** | `FocusedAnswerKeyterms.swift` static list (digits 1-50 + "main", "spare", "none", "yes", "no", "live", "neutral", "earth"). | new file | ~50 | Unit: list size + content. |
| **S3** | `enterFocusedAnswerMode()` / `exitFocusedAnswerMode()` on `DeepgramService` or ViewModel. **D7-v3 keyterm merge: priority-capped at ≤100 (essentials > session-critical > session-other; drop overflow).** S1 invocation: focused params (`eot_threshold=0.5`, `eot_timeout_ms=1500`, **D17-v3: NO `eager_eot_threshold` in TF#1**). Restore: cached canonical keyterms + URL-default thresholds. **B4-v2 fix: real cancellable `DispatchWorkItem` for 10s, cancelled on first final / EagerEndOfTurn / alert dismissal / explicit exit.** **D8-v3 restore-failure handling: retry 3x with 50/100/200ms backoff, then `webSocketTask?.cancel()` to force reconnect.** Enter is idempotent; second call resets timer and re-applies focused config (defends I3-v2 from PLAN_v2). | `DeepgramService` (new methods + cached state + timer), `DeepgramServiceDelegate` (didReceiveConfigureFailure consumer) | ~180 | Unit: enter/exit cancels timer. Unit: timer fires at 10s if not cancelled. Unit: enter is idempotent. Unit: ConfigureFailure on entry clears state. Unit: ConfigureFailure on restore retries then reconnects. Unit: keyterm priority cap at 100. |
| **S4** | Hook S3 to `ask_user` lifecycle. Enter on `handleAlertTTSStarted` for `stage6_ask_user` alerts only. Exit on first final (matching toolCallId), 10s timer, alert dismissal (any path), or barge-in (`markTTSFinished(naturalCompletion: false)`). **I2-v2 fix (Claude rd 1): on `AVAudioSession.interruptionNotification` `.began`, exit + cancel timer.** | `DeepgramRecordingViewModel`, `AlertManager` | ~100 | Unit: TTS-start triggers enter. Unit: TTS natural-finish + first final triggers exit. Unit: barge-in triggers immediate exit. Unit: stacked asks reset timer (idempotent enter). Unit: AVAudioSession interrupt triggers exit. |
| **S5** | UserDefaults runtime flag `voiceFocusedAnswerLayer1Enabled` + Settings row. **D12-v3: toggle-OFF mid-flight calls `exitFocusedAnswerMode()` immediately.** S3 enter is no-op when flag false. | `Sources/Views/Settings/`, `DeepgramService` | ~60 | Unit: enter no-op when flag false. Unit: toggle-OFF mid-active triggers exit. Manual: Settings row. |

**TF#1 totals: ~510 LOC across 5 commits. iOS only, zero backend.**

### TF#1 field-test gate (between TF#1 and TF#2)

Derek runs one field session with ≥5 `ask_user` moments:
- 3 short ("eight", "yes", "two")
- 1 longer ("circuit eight, two-pole")
- 1 with ~2s thinking pause mid-answer

Pass criteria:
- **Short-answer turn-to-text median ≤ 1500ms** (Layer 1 floor)
  — note: NOT P50 ≤ 800ms as PLAN/v2 said; D16-v3 honest claim
- No chopped multi-word answers (long dictation unaffected)
- ConfigureSuccess echo arrives on every entry/restore (CloudWatch verified)
- Settings toggle visibly clears focused-mode behaviour mid-session

If pass → green-light TF#2 dev. If fail → diagnose via CloudWatch
config-drift / wrong-state-lie events.

### TF#2 chain (Layer 2 eager_intent buffer)

| Slice | What | Files | LOC est. | Tests |
|---|---|---|---|---|
| **S6** | **Backend: capability handshake.** Extend `session_start` handler to read `supports_eager_intent` from iOS; respond with `session_capabilities.eager_intent_enabled` (gated by `VOICE_FOCUSED_EAGER_INTENT_ENABLED` env, default `true` post-deploy, false during initial deploy). | `src/extraction/sonnet-stream.js`, `ecs/task-def-backend.json` | ~60 | Unit: handshake echoes flag. Integration: env var off → echoes false. |
| **S7** | **Backend: eager_intent buffer module.** New `src/extraction/stage6-eager-intent-buffer.js`. Exports: `bufferIntent({toolCallId, fluxTurnId, answer})`, `commit(fluxTurnId) → answer or null`, `discard(fluxTurnId)`, `purge(olderThanMs)`. Map keyed by fluxTurnId. **D13-v3 serial queue: buffer mutations called only from within `handleEagerIntent`/`handleEagerCommit`/`handleEagerDiscard` which are queued via the existing `isExtracting`/`pendingTranscripts` pattern from `sonnet-stream.js:3249-3257`.** | new file + `sonnet-stream.js` (3 new handlers) | ~250 | Unit: buffer/commit/discard happy paths. Unit: discard returns null commit. Unit: purge removes stale entries. Unit: serial queue ordering preserved. |
| **S8** | **Backend: eager_intent → resolve wiring.** `handleEagerCommit(fluxTurnId)` looks up buffered answer, calls existing `pendingAsks.resolve(toolCallId, {answer: buffered, source: "eager"})`. This is the SAME path `ask_user_answered` uses today, so `buildResolvedBody` + `autoResolveWrite` + Sonnet round N+1 fire NORMALLY. **No new write semantics, no in-turn mutation.** `handleEagerDiscard(fluxTurnId)` simply removes the buffer entry; the subsequent `ask_user_answered` from iOS (which it sends on EndOfTurn-discard path) drives the normal resolve. | `sonnet-stream.js`, `stage6-pending-asks-registry.js` | ~80 | Integration: eager_intent + eager_commit → identical state to `ask_user_answered` with same text. Integration: eager_intent + eager_discard + ask_user_answered with diverged text → state matches the ask_user_answered path. |
| **S9** | **iOS: wire EagerEndOfTurn + TurnResumed delegate path.** Add `didReceiveEagerFinalTranscript(text:fluxTurnId:)` and `didReceiveTurnResumed(fluxTurnId:)` to `DeepgramServiceDelegate`. Pass through Flux's actual `turn_index` as `fluxTurnId`. | `DeepgramService` (`handleFluxEvent`), delegate protocol | ~80 | Unit: parse EagerEndOfTurn / TurnResumed JSON → delegate fires with correct turnId. |
| **S10** | **iOS: `pendingEagerByFluxTurnId` state + dispatch logic.** **D11-v3: Map keyed by Flux `turn_index`** (per-Flux-turn binding). On EagerEndOfTurn in focused-mode + flag-enabled state: insert into map, send `eager_intent` over WS via new `sendEagerIntent(toolCallId, fluxTurnId, text)`. On TurnResumed: remove from map, send `eager_discard`. On EndOfTurn: lookup by turnId; if buffered text matches → send `eager_commit`; if diverges → send `eager_discard` + normal `sendAskUserAnswered` with the final text. | `DeepgramRecordingViewModel`, `ServerWebSocketService` (3 new send methods), `pendingEagerByFluxTurnId` state | ~180 | Unit: eager event inserts map entry + sends intent. Unit: matching final sends commit. Unit: diverging final sends discard + answered. Unit: TurnResumed sends discard, no commit. Unit: two-finals-1ms-apart for same turn → second is a no-op. |
| **S11** | **iOS: extend `ServerWebSocketService.send(_:)` reconnect whitelist** to buffer `eager_intent`, `eager_commit`, `eager_discard`. Replay order: existing transcript/correction first, then eager messages in arrival order. | `ServerWebSocketService` | ~30 | Unit: send while disconnected enqueues. Unit: reconnect drains in arrival order. |
| **S12** | **iOS: Layer 1 Configure now includes `eager_eot_threshold=0.4`.** Layer 1's `enterFocusedAnswerMode()` from S3 takes a `withEagerEnabled: Bool` param (default false in TF#1, true once Layer 2 ships). S12 flips the call site default to `true`. **D17-v3: only when Layer 2 dispatch flag also enabled.** | `DeepgramService` (S3 method signature update) | ~20 | Unit: param flips Configure shape. |
| **S13** | **iOS: UserDefaults runtime flag `voiceFocusedAnswerLayer2Enabled` + Settings row.** S10 dispatch short-circuits to no-op when flag false. **D12-v3: toggle-OFF immediately sends `eager_discard` for every entry in `pendingEagerByFluxTurnId`.** | `Sources/Views/Settings/`, `DeepgramRecordingViewModel` | ~50 | Unit: flag-false short-circuits S10. Unit: toggle-OFF mid-flight discards pending. |
| **S14** | **Backend telemetry per-turn `eager_state_log` event** in `sonnet-stream.js`. Fields: sessionId, turnId, toolCallId, fluxTurnId, eagerSentAt (ms since session start), commitOrDiscardAt, finalAt, agreementClass ∈ {match, divergence, turn_resumed, no_eager}. **D15-v3: CloudWatch-shipped via standard backend log group.** | `sonnet-stream.js` | ~40 | Manual: CloudWatch grep verifies the new event. CloudWatch Insights query for P50 lands. |

**TF#2 totals: ~790 LOC across 9 commits (4 backend + 5 iOS). Ships
as second TestFlight (iOS) + same-deploy backend.**

### TF#2 field-test gate

After TF#2 deploys + TestFlight build lands:
- Derek runs one field session with ≥5 `ask_user` moments + at least
  1 deliberately interrupted ("eight ... point five")
- Pass criteria:
  - Short-answer median turn-to-Sonnet-dispatch ≤ 800ms (Layer 2
    commit path; D16-v3 honest claim)
  - Interrupted-answer case: eager_intent sent + eager_discard fired
    on divergence + final answer "eight point five" lands as Sonnet's
    received value (verifiable in CloudWatch)
  - No user-visible inconsistency on the correction case
  - Capability-gate works: backend env-var OFF → iOS doesn't send
    eager_intent → falls back to Layer 1 timing cleanly

## Validation strategy

### Pre-deploy

- **Unit tests** per-slice as above. Hard requirement.
- **Backend integration tests** for S7+S8 using existing
  `transcript-replay.mjs` framework — drives backend WS directly with
  synthesised eager_intent/eager_commit/eager_discard sequences, asserts
  resulting `perTurnWrites.readings` state matches the equivalent
  ask_user_answered path. Validates backend wiring; does NOT validate
  Flux latency (admitted limitation per Claude I4-v2).
- **Real-Flux latency proof**: requires Derek field session. Pre-deploy
  cannot validate it.

### Field-test gates (both TFs)

See TF#1 and TF#2 sections.

## Rollback story

- **Layer 1 (TF#1) misbehaving**: Settings → toggle OFF. Immediate
  effect (D12-v3). Sends restore Configure; if restore fails per
  D8-v3, force-reconnects to URL-default Flux. No corruption possible
  because Layer 1 never bypassed any backend state.
- **Layer 2 (TF#2) misbehaving in the field**: Settings → toggle
  Layer 2 OFF. Immediate effect — sends `eager_discard` for every
  pending entry. Layer 1 still active. Layer 2 dispatch silently
  no-ops thereafter.
- **Layer 2 (TF#2) misbehaving server-side**: ECS env-var
  `VOICE_FOCUSED_EAGER_INTENT_ENABLED=false` → 30 min CI deploy + 5-10
  min ECS rolling deploy. Existing in-flight sessions stay on old task
  (still serve `eager_intent`); new sessions get capability-OFF in
  handshake → iOS Layer 2 silently no-ops. **No mid-session corruption
  because the gate is at handshake time, not request time.**
- **Catastrophic both layers bad**: both Settings toggles OFF → back
  to today's behaviour (5000ms floor). No code revert needed.

## Resolved decisions (Derek, all)

| # | Decision | Value | Driver |
|---|---|---|---|
| Q1 (rd 1) | Layer 2 dispatch model | (b) proper retract via amend | Q1 (rd 2, this round) supersedes |
| Q1 (rd 2) | Layer 2 architecture | **(b') eager_intent buffer in backend** (NOT iOS-side amend) | Round-2 reviewers identified amend-against-`pendingAsks` as structurally infeasible. eager_intent buffer is the layer-correct fix. |
| Q2 | `eager_eot_threshold` value | 0.4 | Unchanged. Tuned post-deploy via D15-v3 telemetry. |
| Q3 | Focused-mode keyterms | **D7-v3 priority-capped merge at ≤100** | Codex v2 BLOCKER — "append" can't be naïve. |
| Q4 | S5 telemetry-only first? | N/A — TF#1/TF#2 split is the answer | Per D5. |
| Q5 | Layer 3 (VAD-Finalize) | Dropped | Unchanged. |
| Q6 | Kill switch mechanism | Runtime UserDefaults flag + **D12-v3 immediate-effect on toggle** + **D14-v3 capability gate for backend kill** | Codex v2 BLOCKER on rollback semantics. |
| Q7 (was open) | Stacked asks | **D11-v3 per-Flux-turn binding via `pendingEagerByFluxTurnId` Map** | Codex v2 BLOCKER — single-valued state was the bug source. |
| Q8 (was open) | App backgrounding | **S4 wires `AVAudioSession.interruptionNotification` `.began` to `exitFocusedAnswerMode()`** | Round 1 Claude I6 — explicit wire. |
| Q9 (new) | Layer 1 latency claim | **D16-v3 honest median ~1500ms, no 700ms guarantee** | Claude v2 I2-v2 — original claim conflated eager-event-arrival with final-arrival. |

## Costs (re-done honestly per Claude v2 I9-v2)

- **Engineering**:
  - TF#1: ~3 days iOS
  - TF#2 backend: ~5 days (handlers, buffer module, capability handshake, telemetry, tests, env-var plumbing)
  - TF#2 iOS: ~3 days (delegate wiring, state map, dispatch logic, reconnect buffer, two new Settings rows)
  - **Total: ~11 days across two TestFlight cycles + 1 backend deploy**
- **Runtime**:
  - Layer 1: zero. Configure is one small JSON per focused-answer entry + exit.
  - Layer 2 commit case: zero net change vs Layer 1 (same Sonnet round count; eager_intent is held, commit fires the same `pendingAsks.resolve` that `ask_user_answered` fires today).
  - Layer 2 discard case: identical to Layer 1 baseline (eager buffered then discarded → followed by normal `ask_user_answered`).
  - **No extra Sonnet rounds in either case** because the buffer NEVER triggers `autoResolveWrite` / `speak_to_user`. Claude v2 I9-v2 cost-undercount concern resolved by the architectural change (D10-v3).
- **Risk**: low-medium. The buffer module (S7) is new infrastructure but
  small + serial-queue-wrapped + unit-tested + capability-gated.

## Composition table (corrected for D10-v3)

| Stage | Today | After TF#1 (Layer 1) | After TF#2 (Layer 2, commit case) | After TF#2 (Layer 2, discard case) | + voice-latency TTS streaming |
|---|---|---|---|---|---|
| Audio "eight" → Flux event ready for action | ≤5000ms (final) | ~1500ms median (final) | ~300-700ms (eager) | ~1500ms (final, eager discarded) | Same |
| Event ready → Sonnet first token | ~700-900ms | ~700-900ms | ~700-900ms | ~700-900ms | ~700-900ms |
| Sonnet → ElevenLabs first byte | ~2000-3000ms | ~2000-3000ms | ~2000-3000ms | ~2000-3000ms | ~200-400ms |
| ElevenLabs → audible | ~250-500ms | ~250-500ms | ~250-500ms | ~250-500ms | ~100-200ms |
| **TTS-end → "Got it, eight"** | **~8-9s** | **~5-5.5s** | **~3.7-5s** | **~5-5.5s** | **~1.5-2.3s (commit) / ~2.3-3s (discard)** |

**Discard case is no worse than Layer 1** because the eager buffer
costs ~0 ms (held server-side, no LLM call).

## Open questions

**None blocking.** All round 1 + round 2 BLOCKERs addressed; all
round 1 + round 2 IMPORTANTs addressed except:

- N3-v2 (Claude) and N4-v2 (Claude) NITs preserved as implementer
  notes — `AVAudioSession` callback layer-reachability and TF#1→TF#2
  sequential ordering, both already implicit in S4 / TF gates above.
- N1-v2 closed (D6-v3 explicit on field names).
- N2-v2 closed (LOC estimates re-done per slice with the redesigned
  backend handler scope: S7 = ~250 LOC + S8 = ~80 LOC ≈ ~330 LOC total
  for the backend wire — Claude v2 N2 estimated ~400-600 for the OLD
  amend handler; the eager_intent path is simpler).
- N5-v2 closed (composition table now shows both commit + discard
  cases).
