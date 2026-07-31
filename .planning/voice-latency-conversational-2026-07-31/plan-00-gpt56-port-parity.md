# Plan 00 — complete the Haiku-to-GPT-5.6 Luna port

Status: **DRAFT — not RP-reviewed**
Priority: prerequisite
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

## Outcome

Make provider selection, prompt rendering, tool-result behaviour and captured-field correctness explicit and provider-safe. At the end, every effective model is sent through its matching SDK, Luna receives the same logically separated system content that Haiku receives, and the known IR miss is either fixed or recorded as an explicit release blocker with evidence.

This plan does not change the live model, Fast tier, end-of-turn policy, client wire shapes or TTS behaviour.

## Verified starting point

- `ecs/task-def-backend.json` and live ECS revision 363 both select Luna + Fast.
- `src/extraction/openai-responses-adapter.js` correctly uses Responses, low reasoning, real SSE streaming and encrypted reasoning continuity.
- `src/__tests__/openai-responses-adapter.test.js`, `stage6-tool-loop.test.js` and `stage6-observation-tier-routing.test.js` pass (52 tests on 2026-07-31).
- `flattenSystem()` joins blocks with `join('')`. The three-block snapshot builders do not guarantee a trailing delimiter, so the logical block boundary can disappear.
- `EICRExtractionSession` creates `session.client` once from `SONNET_EXTRACT_MODEL`. `runLiveMode` and `runToolLoop` can later change the model string via `OBSERVATION_EXTRACT_MODEL` or `VOICE_LATENCY_ROUND1_MODEL` without changing that client.
- Those cross-provider cases are dormant live: observation routing is off and the round-one override is empty. They must be fixed before either flag can be safely used.
- The nine-fixture A/B is 8/9 for each provider. Luna alone missed `Downstairs Socket, circuit 3, IR L to L 100`; the corpus is insufficient for a broad quality claim.

Official implementation references:

- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6)
- [Responses API create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

## Scope

### 1. Golden prompt rendering

- Replace boundary-free flattening with one named system-rendering function.
- Preserve block order and exact text inside each block.
- Insert an explicit, documented separator between non-empty blocks. Use a stable delimiter that cannot fuse the final sentinel of one block to the heading of the next.
- Add golden tests covering the actual `base + stable prefix + volatile tail` output, empty blocks, string input, and flag-on/flag-off prompt variants.
- Test the dangerous boundary directly: the final token of stable user text must not abut `EXTRACTED`, `PENDING`, or another volatile heading.
- Record pre/post token counts and inspect the rendered prompt; a correctness fix may change a handful of tokens but must not silently reorder or drop content.

Likely files:

- `src/extraction/openai-responses-adapter.js`
- `src/extraction/eicr-extraction-session.js`
- `src/__tests__/openai-responses-adapter.test.js`
- a new focused prompt-render parity test if the existing adapter suite becomes too broad

### 2. Resolve client per effective model

- Add one canonical `providerForModel(model)` classifier and one session-owned client resolver.
- Lazily construct/reuse the Anthropic and OpenAI clients only when their provider is requested; do not recreate SDK clients each round.
- Change `runToolLoop` to resolve `{client, model}` together for every round after applying `VOICE_LATENCY_ROUND1_MODEL`. Preserve a default resolver so unrelated tests/callers remain simple.
- Change observation-tier routing to pass the resolver, not a default-model-latched client.
- Apply the same resolver to any legacy `callWithRetry` path that selects `OBSERVATION_EXTRACT_MODEL`.
- Fail closed before an API call when a model has no matching key/client. Never send a `claude-*` identifier to OpenAI or a `gpt-*` identifier to Anthropic.
- Keep telemetry PII-free and add `provider` beside the already recorded effective model/tier.

Required test matrix:

- Luna default, no override → OpenAI on all rounds.
- Haiku default, no override → Anthropic on all rounds.
- Luna default + Haiku round-one override → Anthropic round one, OpenAI later rounds.
- Luna default + Sonnet observation route → Anthropic for the entire observation loop.
- missing provider key → deterministic failure/fallback policy, asserted before network dispatch.
- override changes mid-session → model/client pair remains internally consistent.
- cost tracker attributes usage to the actual model returned by each provider.

Likely files:

- `src/extraction/eicr-extraction-session.js`
- `src/extraction/stage6-tool-loop.js`
- `src/extraction/stage6-shadow-harness.js`
- `src/__tests__/stage6-tool-loop.test.js`
- `src/__tests__/stage6-observation-tier-routing.test.js`
- new provider-routing tests

### 3. Tool-result parity audit

- Build a table of every dispatcher terminal: success, retryable validation error, non-retryable rejection, thrown dispatcher error, invalid JSON, loop cap and cancellation.
- Verify the serialized `function_call_output` contains enough structured error information for Luna even though Responses has no Anthropic `tool_result.is_error` field.
- Add discriminating two-round tests. Only add a server-owned error marker/wrapper if the current payload loses behaviour; do not duplicate `{ok:false, code}` unnecessarily.
- Ensure model-controlled raw text remains absent from logs.

### 4. Correctness closure and paced A/B

- Promote the Luna IR miss into a permanent captured/replay fixture with expected `ir_live_live_mohm=100`, board and circuit.
- Root-cause whether the miss is prompt wording, field schema, detector context, Responses translation or model variance. Fix the narrowest deterministic layer.
- Widen the provider comparison beyond nine utterances using existing trusted field-replay captures, including corrections, asks, clears, multi-board routing, observations, mixed question+reading turns and all common test types.
- Run calls at conversational spacing and report throttled samples separately. The known 200k TPM pool and ~33k raw prompt make burst tests unrepresentative.
- Compare semantic writes/asks/answers, not prose or tool-call order alone.

Release gate:

- zero Luna-only safety/certificate mutation regressions in the trusted set;
- the pinned IR case passes repeatedly at the chosen reasoning/service tier;
- any accepted non-safety mismatch is named, quantified and explicitly approved rather than averaged away;
- p50/p95 latency and cache usage are reported with rate-limit samples excluded and included.

## Verification

Run at minimum:

```bash
npm test -- --runInBand src/__tests__/openai-responses-adapter.test.js src/__tests__/stage6-tool-loop.test.js src/__tests__/stage6-observation-tier-routing.test.js
npm run replay:field-corpus:prepush
npm test
```

Run the paced live A/B only when model credit is available. Save redacted lane artefacts and a reproducible report under `scripts/model-ab/`; do not commit API keys or raw PII.

## Rollout and rollback

- Ship prompt/provider fixes behind no new behaviour flag; they restore the intended provider contract.
- Keep `OBSERVATION_TIER_ROUTING=false` and `VOICE_LATENCY_ROUND1_MODEL=""` until the cross-provider matrix is green in CI and a live canary proves the correct provider.
- Rollback is the normal PR revert. Do not mutate ECS directly.
- Update `docs/reference/architecture.md`, `docs/reference/deployment.md`, `docs/reference/changelog.md`, and the A/B report. Commit each logical fix with its tests and rationale.

## Reviewer pressure points

- Can a provider override occur anywhere that bypasses the new resolver?
- Does the prompt fix preserve snapshot sentinels and caching boundaries under every snapshot format?
- Is a missing OpenAI key currently described as “fallback” even though an Anthropic client cannot call a GPT model? The implementation must make that state truthful.
- Does any new wrapper change the model-visible tool result enough to cause a retry loop?
- Is the quality conclusion based on independent repeats rather than one sample per utterance?
