# Codex Review - Voice Latency Suite Handoff

Date reviewed: 2026-05-26

## 1. Commit Table Diff

`git log --since="2026-05-26 00:00" --oneline` in `EICR_Automation` returned:

- `c8322c31` `docs(voice-latency-suite): session handoff + 3 drafted Phase 1 scenarios`
- `58ee9ce9` `feat(dialogue-engine): port end-of-loop confirmation from legacy ring script`
- `e1ae2913` `feat(sonnet-prompt): confirmations now cover every value + include circuit designation`
- `b588b6d1` `feat(ring-continuity): end-of-loop confirmation with overwrite-on-amend`
- `32659f83` `chore: trigger CI deploy of a63f1d4c (validator + cap-raise) via push event`
- `a63f1d4c` `fix: ask_user validator tolerates omitted context fields + raise Loaded Barrel cap to 12`
- `61e43df4` `feat(voice-latency): tool_choice:{type:"any"} on round-1 to suppress Sonnet preamble`
- `9590cea2` `fix(dialogue-engine): resolve field aliases in tryEnterScriptFromWrites`
- `b6075e59` `fix(dialogue-engine): hand value-bearing utterances to Sonnet when entry parser misses`

Section A's backend table is incomplete for code-path impact. It lists `b6075e59`, `9590cea2`, `61e43df4`, `a63f1d4c`, and `32659f83`, but the same-day log shows three later backend commits that touch dialogue/prompt/ring paths and can affect the proposed scenarios:

- `58ee9ce9` touches `src/extraction/dialogue-engine/engine.js`, `src/extraction/dialogue-engine/helpers/wire-emit.js`, and `src/extraction/dialogue-engine/schemas/ring-continuity.js`.
- `e1ae2913` touches `config/prompts/sonnet_extraction_system.md` and `config/prompts/sonnet_extraction_eic_system.md`.
- `b588b6d1` touches `src/extraction/ring-continuity-script.js` and ring tests.

It also misses `c8322c31`, which committed the handoff and the three drafted scenario files. That makes Section H's "3 drafted YAML scenarios ARE UNCOMMITTED" no longer accurate.

`git log --since="2026-05-26 00:00" --oneline` in `CertMateUnified` returned:

- `a2e02cd` `feat(tts): drop address-family suppression - confirm every value`
- `0aa85e4` `feat(recording): remove auto Zs/R1+R2 derivation; require explicit voice command`
- `5695ada` `fix(normaliser): skip digit-word conversion before a circuit designation`
- `294ca96` `fix(ios-ui): centre CCU shutter vertically on trailing edge`
- `07d9acf` `feat(ws): disconnect-reason telemetry - disconnect_intent + previous_disconnect`
- `1ed186e` `feat(voice-latency): wire iOS regex-fast-tts trigger in handleFinalTranscript`
- `182acc2` `feat(voice-latency): iOS bundler-emit playback-ack so Loaded Barrel end-to-end is measurable`

Confirmed accurate: the iOS table includes `182acc2`, `1ed186e`, and `07d9acf`, and the "Other notable iOS commits" list includes the remaining four. For task planning, `a2e02cd`, `0aa85e4`, and `5695ada` are not just noise: they touch recording/confirmation/normalisation paths relevant to the scenarios. `294ca96` is UI-only and not relevant to voice-latency or AlertManager.

## 2. Drafted YAML Scenario Validation

YAML parsing succeeds for:

- `tests/fixtures/voice-latency-scenarios/baseline/zs_without_circuit.yaml`
- `tests/fixtures/voice-latency-scenarios/baseline/value_correction.yaml`
- `tests/fixtures/voice-latency-scenarios/baseline/rcd_walkthrough_clean.yaml`

The top-level shapes match `tests/fixtures/voice-latency-scenarios/SCHEMA.md`: `name`, `suite`, `description`, optional `job_state`, `transcript[]`, `expect`, and `config`. The assertion shapes are syntactically accepted by `scripts/voice-latency-bench/transcript-replay.mjs`: `has_reading` is an array checked at lines 386-405, `ask_user_count` supports `{min,max}` at lines 408-416, and `audible_latency_ms_p50` supports `{min,max}` at lines 426-453. The three drafted scenarios do not use `audible_latency_ms_p50`.

Important harness defect: `ask_user_count` currently counts only WS messages where `msg.type === "question"` and `msg.question_type === "ask_user"` (`transcript-replay.mjs:244-246`). Stage 6 asks are emitted as `type: "ask_user_started"` in `src/extraction/stage6-dispatcher-ask.js:389-400`. Because the harness advertises `protocol_version: "stage6"` by default (`transcript-replay.mjs:271-275`), the drafted `ask_user_count` checks will miss the Stage 6 ask path. This affects `zs_without_circuit.yaml:47` and `rcd_walkthrough_clean.yaml:62`.

Field names: the drafted scenario intent is mostly canonical, but the actual WS/harness contract is muddy.

- `zs_without_circuit.yaml:50` uses `measured_zs_ohm`, which is canonical per `config/field_schema.json:253` and the agentic prompt at `config/prompts/sonnet_agentic_system.md:105-109`.
- `value_correction.yaml:37` uses `r1_r2_ohm`, canonical per `config/field_schema.json:203`.
- `rcd_walkthrough_clean.yaml:49` uses `rcd_trip_time`, but the Stage 6 canonical field is `rcd_time_ms` (`config/field_schema.json:261`). The dialogue-engine RCD schema deliberately uses legacy `rcd_trip_time` as its slot field (`src/extraction/dialogue-engine/schemas/rcd.js:30-58`), and `FIELD_CORRECTIONS` maps `rcd_time_ms -> rcd_trip_time` (`src/extraction/field-name-corrections.js:79`). So this is correct for the dialogue-engine script output, but not canonical in the Stage 6 tool-schema sense.

Potential scenario failure not captured in the handoff: `sonnet-stream.js` still rewrites unknown fields through `FIELD_CORRECTIONS` before sending the WS extraction (`src/extraction/sonnet-stream.js:823-833`). `KNOWN_FIELDS` includes legacy `zs`, `r1_plus_r2`, and `rcd_trip_time` (`src/extraction/sonnet-stream.js:735-748`), but not `measured_zs_ohm` or `r1_r2_ohm`. If `validateAndCorrectFields()` runs on these live results, `has_reading` assertions expecting `measured_zs_ohm` / `r1_r2_ohm` may fail against post-correction `zs` / `r1_plus_r2`. Existing `normal_zs_value.yaml:33-38` already expects canonical, so either the harness has been rotting or that correction path is not exercised the way the comments imply. Verify before adding more fixtures.

Timeouts are conservative but realistic: 30-60s `timeout_ms`, 15-25s `drain_ms`, and the 8s user pause in `zs_without_circuit.yaml:40` are plausible for an ask + TTS + reply path. They are not tight latency guards.

## 3. AlertManager Silent-Ask Code Paths

Confirmed inaccurate/incomplete: there is no `processNextAlert` method in current `CertMateUnified/Sources/Recording/AlertManager.swift`. The queue advancement method is `scheduleNextAlert()` at `AlertManager.swift:850-867`.

The handoff hypothesis that the queue simply "doesn't re-fire after the first alert resolves" is not directly supported by the code. `scheduleNextAlert()` is called after correction resolution (`AlertManager.swift:598-607`), circuit-move resolution (`637-646`), dismiss (`660-672`), and accept/reject resolution (`835-844`). It waits 1.5s, then dequeues if `currentAlert == nil` and `alertQueue` is non-empty (`850-864`).

Every route that can produce `question_enqueued` then queue an alert:

- `askQuestion(_:)` emits `question_enqueued` and calls `alertManager.queueAlert(...)` at `DeepgramRecordingViewModel.swift:2344-2386`.
- `askAlert(_:)` emits `question_enqueued` and calls `alertManager.queueAlert(...)` at `DeepgramRecordingViewModel.swift:2403-2452`.
- `askAlertWithToolCallId(...)` emits `question_enqueued` and calls `alertManager.queueAlert(...)` at `DeepgramRecordingViewModel.swift:2465-2500`.
- Stage 6 `ask_user_started` enters that path through `handleAskUserStarted()` at `DeepgramRecordingViewModel.swift:2518-2541`.

Every route that can queue but never produce `inflight_anchored`:

- Queued behind a non-cleared `currentAlert`: `queueAlert()` appends when `currentAlert != nil` (`AlertManager.swift:241-249`). If the active alert never dismisses, later queued questions never reach `presentAlert()`.
- TTS fetch/playback deferred before `markTTSStarted()`: `speakWithTTS()` stores `deferredTTS` and returns when `shouldDeferPlayback?() == true` (`AlertManager.swift:1350-1354`). Until `resumeDeferredTTSIfNeeded()` runs and plays it (`1431-1460`), `onAlertTTSStarted` does not fire, so no `inflight_anchored`.
- Deferred audio dropped as too old: `resumeDeferredTTSIfNeeded()` drops audio older than 6s (`AlertManager.swift:1435-1438`). It returns without starting TTS, while the interactive alert may still have `isAwaitingResponse = true`.
- Native fallback dropped while user is speaking: `speakWithAppleNative()` returns at `AlertManager.swift:1629-1633` and explicitly leaves `isAwaitingResponse` as-is.
- TTS task cancellation before playback: `speakWithTTS()` cancels any existing `ttsTask` (`AlertManager.swift:1281-1285`). A cancelled task exits before `markTTSStarted()`, producing no anchor.
- Send path without a matching FIFO entry: `markTTSStarted()` calls `onAlertTTSStarted` only if `currentAlert != nil && !isResolving` (`AlertManager.swift:1493-1495`). If it fires with no matching `pendingInFlightQuestions` entry, the VM logs `inflight_anchor_missed`, not `inflight_anchored` (`DeepgramRecordingViewModel.swift:2946-2965`).
- Alert cleared or session stopped after `question_enqueued`: `clearAll()` removes queued alerts and dismisses current (`AlertManager.swift:739-745`), and `dismissCurrentAlert()` stops speech and clears state (`660-672`).

State toggles and dequeue blockers:

- `isAwaitingResponse = true`: `presentAlert()` (`AlertManager.swift:749-757`).
- `isAwaitingResponse = false`: correction resolution (`592`), circuit-move resolution (`618`), dismiss (`668`), informational/visual presentation (`779`, `796`), accept/reject (`823`).
- `isTTSSpeaking = true`: `markTTSStarted()` (`AlertManager.swift:1468-1478`).
- `isTTSSpeaking = false`: `markTTSFinished(skipCooldown: true)` (`1557-1559`) or after cooldown (`1566-1577`).
- `fastPathSlotStates`: `.fastPending` in `markFastPathPending()` (`1106-1108`), `.fastPlayed` in `playFastPathAudio()` (`1052-1058`), `.idle` on fast failure/reject (`1086-1090`, `1113-1115`), `.resolved` when a bundler confirmation is suppressed after fast-path playback (`984-987`), `.bundlerPlayed` when a bundler confirmation proceeds (`988-993`).
- Dequeue guard: `scheduleNextAlert()` requires `currentAlert == nil` and non-empty queue after the 1.5s delay (`857-858`).
- Confirmation guard: `speakBriefConfirmation()` returns without speaking while `isAwaitingResponse` is true (`AlertManager.swift:996-1006`), but that affects confirmations, not ask playback.

The handoff's proposed instrumentation is directionally correct, but add explicit probes for `scheduleNextAlert` entry/guard-fail/dequeue, `deferredTTS` set/drop/reheld/resume, and `ask_user_started -> askAlertWithToolCallId -> queueAlert` correlation. The observed absence of `tts_playback_deferred`, `tts_deferred_dropped`, and `tts_audioplayer_failed` in the handoff narrows the likely cause to "current alert never dismissed / schedule guard did not pass / pending FIFO mismatch" rather than a simple TTS-fetch failure.

## 4. Bundler Emitted Count Zero Paths

Confirmed inaccurate/incomplete: iOS fast-path state and Loaded Barrel speculator skip do not directly explain `bundler_emitted_count: 0`. The count is computed on the backend immediately after `bundleToolCallsIntoResult()` from `result.confirmations.length` (`src/extraction/stage6-shadow-harness.js:772-794`). iOS suppression in `AlertManager.speakBriefConfirmation()` and fast-path slot state happens after the extraction envelope reaches iOS, so it cannot lower this backend count.

The actual backend paths from `readings_count: 1` to `bundler_emitted_count: 0` are:

- Confirmations disabled: live mode passes `confirmationsEnabled: msg.confirmations_enabled || false` into `runShadowHarness()` (`src/extraction/sonnet-stream.js:3724-3725`), and the bundler synthesises only when `options.confirmationsEnabled === true` (`src/extraction/stage6-event-bundler.js:321-330`).
- Confidence below threshold: `synthesiseConfirmations()` skips readings with numeric `confidence < 0.8` (`src/extraction/stage6-event-bundler.js:59-61`, threshold at `src/extraction/confirmation-text.js:63-67`).
- Field not in the friendly-name table: `buildConfirmationText()` returns null when `CONFIRMATION_FRIENDLY_NAMES[field]` is absent (`src/extraction/confirmation-text.js:36-61`, `84-88`). This is especially relevant after `e1ae2913`: the legacy prompt now says confirmations cover every value/free text, but the agentic bundler still only covers the friendly-name whitelist.
- Empty/null value: `buildConfirmationText()` trims `String(value ?? '')` and returns null if empty (`confirmation-text.js:87-88`).
- `polarity_confirmed` false/unknown: `buildConfirmationText()` suppresses falsey polarity values (`confirmation-text.js:105-110`).
- Legacy confirmations branch: if a legacy result has `confirmations.length > 0`, those are copied (`stage6-event-bundler.js:321-322`). In live mode this is not relevant because live mode passes `legacyResultShape = null` (`stage6-shadow-harness.js:442-458`).
- Empty `perTurnWrites.readings`: impossible if `readings_count: 1`, because both the count and confirmation synthesis are derived from the same `extracted_readings` array in the bundler (`stage6-event-bundler.js:166-205`, `327`).

Loaded Barrel/speculator skip is a separate path: `loaded_barrel_skipped_fast_tts_hint` is emitted in `loaded-barrel-speculator.js:315-326`, before speculative ElevenLabs cost is opened. It can explain no cache pre-synth, but not no bundler text. Rolling back `61e43df4` should not be the first response to `bundler_emitted_count: 0`; that commit changes Anthropic `tool_choice` in `stage6-tool-loop.js`, while confirmation synthesis is deterministic after tool dispatch.

For session `065BDA7F` turn 6, the first thing to verify is whether the transcript message had `confirmations_enabled: true`. iOS sends that key only when `confirmationModeEnabled` is true (`CertMateUnified/Sources/Services/ServerWebSocketService.swift:563-580`), and the toggle defaults from `UserDefaults.standard.bool(...)` (`DeepgramRecordingViewModel.swift:200-204`), which defaults false unless previously set.

## 5. Phase 1 Scenario Coverage

CloudWatch verification could not be completed from this sandbox. The attempted command targeted `/ecs/eicr/eicr-backend` in `eu-west-2` for 2026-05-19 through 2026-05-26 and failed with:

`Could not connect to the endpoint URL: "https://logs.eu-west-2.amazonaws.com/"`

So I cannot confirm repeated last-7-day failure modes from CloudWatch here. Treat this as an open verification gap, not as evidence that the list is complete.

Cross-check against existing baseline fixtures:

- Existing coverage already includes normal Zs by number (`normal_zs_value.yaml`), known designation routing (`existing_circuit_by_designation.yaml`), unknown designation ask (`unknown_circuit_designation.yaml`), new circuit by designation (`create_circuit_by_designation.yaml`, `new_circuit_then_readings.yaml`), multi-circuit dictation (`multi_circuit_dictation.yaml`), bulk polarity (`bulk_polarity_confirm.yaml`), a simple chitchat non-engagement negative control (`chitchat_no_engagement.yaml`), OCPD full spec (`ocpd_full_spec.yaml`), and phone gap recovery (`phone_call_gap_recovery.yaml`).
- The proposed `designation_disambiguation.yaml` is not duplicate; existing designation tests do not cover multiple matching candidates with a follow-up answer.
- The proposed `bulk_ir_all_circuits.yaml` overlaps structurally with `bulk_polarity_confirm.yaml` but targets a different tool/capacity risk, so it is justified.
- The proposed `ir_walkthrough.yaml`, `rcd_garbled_trigger.yaml`, and `ring_continuity_full.yaml` are justified by `sonnet_agentic_system.md:26-29` and `81-87`, which explicitly describe ask_user pending writes, dialogue scripts, IR/ring triggers, and ring carryover.
- The proposed `chitchat_recovery_ask.yaml` should be carefully framed because `chitchat_no_engagement.yaml` already asserts no engagement for ordinary chatter. The new case should specifically pin `a63f1d4c` by triggering a scope-less `ask_user` with omitted/null context fields; otherwise it duplicates the negative control.

Prompt cross-check:

- `sonnet_agentic_system.md:20` says corrections are `clear_reading` + `record_reading`, never questions. `value_correction.yaml` is a good guard, but it should probably assert a `clear_reading` event or final overwritten value if the harness can expose tool calls.
- `sonnet_agentic_system.md:26` says missing circuit context should use `ask_user` with `pending_write`; `zs_without_circuit.yaml` is appropriate, but the harness must count `ask_user_started`.
- `sonnet_agentic_system.md:27` says IR/ring trigger phrases should use `start_dialogue_script`, not isolated `record_reading`. The IR/ring planned scenarios are appropriate.
- `sonnet_agentic_system.md:81-87` says ring continuity has carryover and accumulation across an in-flight ask; planned ring coverage should include the new confirmation gate after `58ee9ce9`/`b588b6d1`.

One correction to the Phase 1 list: `ring_continuity_full.yaml` should not expect automatic `r1_r2_ohm` derivation unless the transcript explicitly asks to calculate it. iOS commit `0aa85e4` removed auto Zs/R1+R2 derivation and requires an explicit voice command. Backend tool docs also say `calculate_r1_plus_r2` runs when the inspector asks to derive it (`src/extraction/stage6-tool-schemas.js:724-748`). The scenario should either expect only the three ring values plus the end-of-loop confirmation, or include "calculate R1 plus R2" as a later utterance.

## 6. Re-Prioritised Task List

Recommended order:

1. Fix/extend the replay harness before trusting Phase 1 results. `transcript-replay.mjs` should count `ask_user_started` as an ask for Stage 6 scenarios, and the canonical-vs-legacy `has_reading` issue needs a decision. Without this, scenarios can pass/fail for harness reasons rather than product reasons.
2. Investigate #14 `bundler_emitted_count: 0` on session `065BDA7F` turn 6. This is a backend observability/product defect and is faster to isolate than a TestFlight cycle. Start by checking `confirmations_enabled` on the transcript and the field/confidence/value in `perTurnWrites`.
3. Continue #11 Phase 1 scenarios after harness fixes, not blocked by iOS #10. The backend replay suite will not reproduce AlertManager queue stalls, but it can lock down the backend behaviours that caused the session to stack failures.
4. #10 iOS silent-ask remains high user-impact, but the next step is instrumentation and TestFlight. It can proceed in parallel with backend harness work, but it should not block writing backend replay scenarios once the harness is corrected.
5. #12 diagnostic report mode after the scenario assertions are reliable.
6. #13 stretch scenarios after Phase 1 and the report mode.

Specific answers:

- Is iOS silent-ask higher than bundler suppression? For field UX, yes: a spoken ask that never plays blocks the inspector. For immediate engineering leverage, #14 is higher because it is backend-only and can be verified without TestFlight.
- Should Phase 1 block on either? It should block on harness correctness, not on #10. It should not strictly block on #14, but the Zs/confirmation scenarios should not assert audible latency until #14 is understood.
- Could bundler suppression be a Loaded Barrel regression from `61e43df4`? Unlikely. `61e43df4` can change model tool-call timing and Loaded Barrel hit rate, but `bundler_emitted_count` is computed from deterministic post-dispatch result synthesis (`stage6-shadow-harness.js:772-794`). Loaded Barrel skip (`loaded-barrel-speculator.js:315-326`) does not suppress bundler text. Use the env flag `VOICE_LATENCY_TOOL_CHOICE_ANY_ROUND1=false` only as a controlled diagnostic after checking `confirmations_enabled`, confidence, field whitelist, and value shape.

## 7. Environmental Landmines And Gotchas

- The three drafted scenarios are committed in `c8322c31`; Section H is stale. Do not treat them as uncommitted work.
- The harness is stale for Stage 6 asks: it counts only `type: "question"` messages, not `type: "ask_user_started"` (`transcript-replay.mjs:244-246` versus `stage6-dispatcher-ask.js:389-400`).
- The harness/schema documentation says `transcript-replay.js` in `SCHEMA.md:4`, but the actual file is `transcript-replay.mjs`.
- `expect.loaded_barrel` appears in existing baseline fixtures such as `loaded_barrel_fires_on_reading.yaml:39-42`, but `transcript-replay.mjs` does not evaluate that assertion. Loaded Barrel assertions appear to belong to the direct/local harness, not this WS replay harness.
- Ring-continuity confirmation work after the voice-latency commits changes expected flow. `src/extraction/dialogue-engine/schemas/ring-continuity.js:141-150` now emits a confirmation ask before finish, and `src/extraction/ring-continuity-script.js` was updated in `b588b6d1` for overwrite-on-amend. Any ring scenario must expect that ask/answer step.
- The `e1ae2913` prompt change says confirmations cover every value, including free text (`config/prompts/sonnet_extraction_system.md:288-295`), but the agentic bundler still whitelists only `CONFIRMATION_FRIENDLY_NAMES` (`src/extraction/confirmation-text.js:36-61`). Scenarios that expect free-text confirmations in Stage 6 will fail unless the bundler is widened.
- iOS `a2e02cd` removed address-family suppression, but backend `confirmation-text.js:29-35` still documents address fields as suppressed/omitted. That is another legacy-vs-agentic mismatch.
- iOS `0aa85e4` removed automatic Zs/R1+R2 derivation in the recording pipeline. Any scenario expecting derived `r1_r2_ohm` or `measured_zs_ohm` from raw components must include an explicit calculate utterance.
- iOS `5695ada` changes digit-word conversion before circuit designations. This can affect designation scenarios where circuit labels include numbers or homophones.
- GitHub Actions outage residue is real. Official GitHub Status shows a May 26 "Incident with Actions and Pages" and recent Actions delays; `32659f83` exists because a push trigger was swallowed. Before assuming deploy success, check the workflow run and ECS task definition. Source: https://www.githubstatus.com/history
- iOS Build 375 status was not verified from App Store Connect here. The handoff says it was in beta review at 12:30 BST on 2026-05-26; confirm before assuming field testers have `182acc2`/`1ed186e`/`07d9acf`.
- Test files likely needing updates after same-day commits: `src/__tests__/dialogue-engine-handover.test.js` (`b6075e59`, `9590cea2`), `src/__tests__/stage6-tool-loop.test.js` (`61e43df4`), `src/__tests__/stage6-dispatch-validation.test.js` (`a63f1d4c`), `src/__tests__/dialogue-engine.test.js` / `src/__tests__/dialogue-engine-replay.test.js` (`58ee9ce9`), and `src/__tests__/ring-continuity-script.test.js` (`b588b6d1`). The replay harness itself also needs tests for `ask_user_started` and post-correction field names.
