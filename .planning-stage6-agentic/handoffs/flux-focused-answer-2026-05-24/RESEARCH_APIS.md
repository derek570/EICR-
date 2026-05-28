# Web research — how other voice agents handle short focused answers

> general-purpose agent run 2026-05-24. Verbatim agent output, lightly
> reformatted.

## Stack-by-stack findings

### 1. LiveKit Agents
- **Dynamic endpointing** (Python only):
  `EndpointingOptions(mode="dynamic", min_delay, max_delay)` adapts
  within bounds using EMA of session pause stats. Node.js is
  fixed-only.
- **No mid-session `stt.update_options()` yet** — open feature request
  [agents-js#369](https://github.com/livekit/agents-js/issues/369).
  Workaround in Python: **agent handoff**
  (`Agent(turn_detection=..., min_endpointing_delay=..., stt=...)`);
  when the agent returns a new `Agent` instance from a tool call, the
  whole turn-handling stack is swapped. This is the canonical "change
  per dialogue state" path.
- Pattern A via handoff; no pattern B / C / E.
- Sources:
  [Turn handling options](https://docs.livekit.io/reference/agents/turn-handling-options/),
  [Turns overview](https://docs.livekit.io/agents/build/turns/),
  [Agents and handoffs](https://docs.livekit.io/agents/build/agents-handoffs/).

### 2. Pipecat
- `LocalSmartTurnAnalyzerV3` ML turn-stop runs over the user's audio
  (≤8s, ~65ms inference). **Documented open bug
  [pipecat#3643](https://github.com/pipecat-ai/pipecat/issues/3643):
  "Sure"/"Yes" hangs 5s — exactly our symptom.** VAD doesn't fire on
  the short utterance, falls back to timeout. No public fix yet,
  assigned to `markbackman`.
- **Pattern D shipping**: `filter_incomplete_user_turns` /
  `UserTurnCompletionConfig` — LLM prepends a completion marker
  (`✓ complete`, `○ incomplete short`, `◐ incomplete long`); incomplete
  turns are suppressed and re-prompted. Semantic-completion signal
  sourced from the LLM itself
  ([llm_response_universal](https://reference-server.pipecat.ai/en/stable/api/pipecat.processors.aggregators.llm_response_universal.html)).
- `user_idle_timeout` on `LLMUserAggregatorParams` can be set per
  dialogue point (docs: *"useful when you want to enable idle
  detection only at certain points in the conversation, or adjust the
  timeout based on context"*) —
  [user-idle docs](https://docs.pipecat.ai/guides/fundamentals/detecting-user-idle).

### 3. Vapi
- Strongest in-class pattern A: `customEndpointingRules` accept
  **regex on user transcript or assistant prompt**. Real examples from
  their docs:

  ```json
  { "type": "user", "regex": "\\d{3}-\\d{3}-\\d{4}", "timeoutSeconds": 2.0 }
  { "type": "assistant", "regex": "(spell|define|explain)", "timeoutSeconds": 4.0 }
  ```

  Plus `transcriptionEndpointingPlan.onPunctuationSeconds: 0.1` vs
  `onNoPunctuationSeconds: 1.5`. This is exactly the "after I asked
  the focused question, shorten the timeout" knob we want,
  declarative. Sources:
  [Voice pipeline configuration](https://docs.vapi.ai/customization/voice-pipeline-configuration),
  [pipeline blog part 2](https://vapi.ai/blog/how-we-built-vapi-s-voice-ai-pipeline-part-2).

### 4. Retell AI
- Only global knobs: `interruption_sensitivity ∈ [0,1]`,
  `end_call_after_silence_ms`, `reminder_trigger_ms`,
  `custom_stt_config.endpointing_ms`. **No per-turn / state-dependent
  endpointing** — confirmed from
  [update-agent API](https://docs.retellai.com/api-references/update-agent).
  Skip.

### 5. OpenAI Realtime API
- `server_vad.silence_duration_ms` (default 500ms) **is mutable
  mid-session** via `session.update` — change
  `audio.input.turn_detection.silence_duration_ms` at any time. Most
  direct analog to what we want for Flux. Also supports `semantic_vad`
  type which uses a model to decide turn end. Source:
  [Realtime VAD guide](https://platform.openai.com/docs/guides/realtime-vad).
  Keyword steering exists but is documented as a transcription
  accuracy aid, not an endpointing accelerator.

### 6. Deepgram Flux (the one we run)
- **Pattern A native**: `Configure` WebSocket message changes
  `eot_threshold`, `eot_timeout_ms`, and `keyterms` **mid-stream
  without reconnect** (we already have this lever — just not using it
  dynamically). Their own docs cite "loosen during authentication /
  OTP entry, tighten after" as the canonical use case
  ([on-the-fly config](https://deepgram.com/learn/flux-on-the-fly-configuration)).
- **Pattern B native**: `EagerEndOfTurn` event fires on
  medium-confidence; recipe is
  `prepareDraftResponse → cancel on TurnResumed → finalize on EndOfTurn`.
  Exact code in
  [eager EOT docs](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot).
- Keyterm boosting is in-model on Nova-3 / Flux and zero-latency.
  Useful for accuracy on "circuit", "RCBO", BS numbers but does not
  accelerate EOT
  ([adapting keyterm boosting](https://deepgram.com/learn/adapting-keyterm-boosting-for-flux)
  — explicitly does NOT discuss EOT interaction).

### 7. AssemblyAI Universal-3 Pro + Speechmatics
- AAI native pattern A: `UpdateConfiguration` WebSocket message
  mutates `min_turn_silence` (default 100ms), `max_turn_silence`
  (default 1000ms), `continuous_partials` mid-stream. Same pattern as
  Deepgram. Source:
  [Universal-3 Pro turn detection](https://www.assemblyai.com/docs/streaming/universal-3-pro/turn-detection-and-partials).
- Speechmatics has `end_of_utterance_silence_trigger` (0-2s) set in
  `StartRecognition`; **no mid-stream update message documented**
  ([Speechmatics EOT docs](https://docs.speechmatics.com/speech-to-text/realtime/end-of-turn)).

### 8. Cartesia / Ultravox
- Cartesia: latency-first single-vendor stack, no documented
  context-dependent endpointing. Skip.
- Ultravox v1.5 (Mar/Apr 2026): "Dynamic Endpointing with EMA-based
  adaptive pause detection" — same statistical-EMA model as LiveKit,
  not state-dependent. Skip.

## Patterns A-E summary table

| Pattern | Stacks implementing | Reference |
|---|---|---|
| **A. Dynamic per-state endpointing config** | **Deepgram Flux** (`Configure` msg, mid-stream, no reconnect); **AssemblyAI U-3 Pro** (`UpdateConfiguration` msg); **OpenAI Realtime** (`session.update` → `silence_duration_ms`); **Vapi** (declarative `customEndpointingRules` matching regex on assistant prompt — closest to our "after focused question shorten" use case); **LiveKit** (only via agent handoff, no mid-session STT mutation in JS) | [Flux](https://deepgram.com/learn/flux-on-the-fly-configuration), [AAI](https://www.assemblyai.com/docs/streaming/universal-3-pro/turn-detection-and-partials), [OpenAI](https://platform.openai.com/docs/guides/realtime-vad), [Vapi](https://docs.vapi.ai/customization/voice-pipeline-configuration) |
| **B. Speculative LLM dispatch on interim** | **Deepgram Flux** ships this as first-class — `EagerEndOfTurn` → draft → `TurnResumed` cancels → `EndOfTurn` finalises. Only stack with documented event model for it. | [Eager EOT](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot) |
| **C. Grammar / phrase-list constrained recognition** | **Nobody in the production voice-agent stacks does this for EOT acceleration.** Deepgram keyterms / OpenAI keyword steering / Speechmatics dictionaries all exist for *accuracy* on rare terms — they don't change endpointing. Closest is OpenAI's CFG-constrained *tool output* (LLGuidance), but that's on the LLM side, not STT. | [Deepgram keyterms](https://developers.deepgram.com/docs/keyterm) |
| **D. Semantic completion signal from LLM** | **Pipecat** ships this: `filter_incomplete_user_turns` / `UserTurnCompletionConfig` — LLM emits `complete`/`incomplete short`/`incomplete long` marker, aggregator suppresses incompletes and re-prompts. OpenAI's `semantic_vad` is the same idea baked into the STT side. | [Pipecat](https://reference-server.pipecat.ai/en/stable/api/pipecat.processors.aggregators.llm_response_universal.html), [OpenAI semantic_vad](https://platform.openai.com/docs/guides/realtime-vad) |
| **E. Lookahead / two-stage STT** | **Not publicly published** by any of the eight stacks. Closest documented behaviour is Flux's eager/final two-event model (same model, two confidence levels) — pattern B, not E. | — |

## Concrete takeaway for our fix

We already have pattern A's mechanism (Flux `Configure` msg) and pattern
B's mechanism (`EagerEndOfTurn`); neither needs an STT migration. Vapi's
`customEndpointingRules` is the cleanest *declarative shape* to copy
when wiring "Sonnet emitted a focused question → drop `eot_threshold`
to ~0.5 and `eot_timeout_ms` to ~1500ms until first final, then
restore". Pipecat's completion-marker trick is the structural
alternative if we want the model itself to commit unilaterally — useful
as a belt-and-braces signal but a much bigger refactor than just
sending a `Configure` message.
