# Plan 01 — explicit GPT-5.6 prompt caching

Status: **DRAFT — not RP-reviewed**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: Plan 00 complete

## Outcome

Give Luna an explicit, stable cache boundary for the large Stage-6 prompt and snapshot prefix, while leaving per-turn state outside the cached prefix. The intended result is fewer cache-write tokens, lower warm-turn cost and potentially lower first-round latency without changing any model-visible instruction, tool or client response.

This is not expected to solve the 200k TPM ceiling: OpenAI counts cached input toward that limit. Rate-limit work must be measured separately.

## Verified starting point

- `buildSystemBlocks()` already produces base, stable snapshot prefix and volatile snapshot tail blocks, with Anthropic `cache_control` markers.
- `openai-responses-adapter.js` discards those markers and sends a single top-level `instructions` string.
- Recent production usage showed approximately 34k cache-write tokens followed by approximately 34k cache-read tokens on multi-round turns, consistent with a changing implicit boundary being written on round one.
- OpenAI's current prompt-caching guide supports explicit `prompt_cache_breakpoint` blocks, a stable `prompt_cache_key`, and `prompt_cache_options.mode="explicit"`. The exact Responses request shape must be probed against the installed SDK and official schema before implementation; do not assume a top-level `instructions` string can carry breakpoints.

Official implementation references:

- [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Responses API create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

## Scope

### 1. Prove the supported request shape

- Add a non-production probe under `scripts/model-ab/` that sends a minimal developer/system prefix, volatile user suffix and one tool through Responses.
- Test the official explicit mode and breakpoint shape using the currently pinned OpenAI SDK.
- Capture only response model/tier, usage buckets, request hash and timings. Never log prompt text or keys.
- Confirm a cold call writes the stable prefix, a changed volatile tail reads that prefix, and changing the stable prefix produces a new write.
- If explicit breakpoints are unavailable for this request shape/model, stop the implementation phase and record the result; do not invent undocumented fields.

### 2. Map existing logical blocks without semantic drift

- Introduce an OpenAI request builder that consumes logical system blocks rather than flattening them prematurely.
- Preserve Plan 00's exact block order and separators.
- Mark only the end of the stable prefix. The volatile snapshot tail, current user turn, assistant reasoning continuation and tool results must remain after the breakpoint.
- Keep Anthropic rendering unchanged.
- Produce a model-visible golden string before and after the transport refactor; they must match exactly apart from provider transport metadata.

Candidate files:

- `src/extraction/openai-responses-adapter.js`
- `src/extraction/eicr-extraction-session.js`
- `src/__tests__/openai-responses-adapter.test.js`
- `scripts/model-ab/prompt-cache-probe.mjs` (new)

### 3. Stable cache identity

- Compute `prompt_cache_key` from a versioned manifest containing model, rendered base-prompt digest, tool-schema digest, certificate type and stable snapshot identity/version.
- Do not include session IDs, user text, board values, PII or volatile state in logs or the key.
- Specify invalidation: prompt/tool/schema changes must create a new key; ordinary turns in the same compatible session must not.
- Use explicit mode only when the configured model supports it. Feature-gate with a source-controlled task-definition flag, default dark for the first deploy.
- Fail closed on invalid config, then fall back to current implicit caching without breaking extraction.

### 4. Telemetry and comparison

Add PII-safe per-round fields:

- cache mode and breakpoint enabled;
- cache-key version/digest prefix, never the raw key;
- fresh, cache-read and cache-write tokens;
- provider latency and effective model/tier;
- round index and single/multi-round classification.

Compare at least 30 warm production-like turns per cohort. Report total and per-round p50/p75/p95. Separate first turn after deployment, first turn in session and warm turns.

## Tests and acceptance gates

- golden prompt equivalence for every snapshot format and answer-feature flag;
- breakpoint is after stable prefix and before volatile content;
- same stable prefix + changed user/state tail keeps one cache key;
- prompt/tool/schema change invalidates it;
- no PII appears in key or telemetry;
- tool-loop, reasoning-continuity, cancellation and usage accounting suites remain green;
- field replay is semantically identical;
- after warm-up, cache-read tokens replace most of the current first-round ~34k write, with no sustained write churn;
- no quality/ask/write/read-back regression;
- retain only if warm p50/p95 or cost improves materially. A cost-only improvement is acceptable if it is named honestly.

Commands:

```bash
npm test -- --runInBand src/__tests__/openai-responses-adapter.test.js
npm run replay:field-corpus:prepush
npm test
```

## Rollout and rollback

- Add the source-controlled env flag to `ecs/task-def-backend.json` and replay-environment pins.
- Deploy dark, run the cache probe, then enable for one-user field canary.
- Rollback by setting the flag false in source and merging through CI. Never edit the live task definition directly.
- Update `docs/reference/architecture.md`, `deployment.md`, `ios-pipeline.md` if its timing model changes, and `changelog.md`.

## Reviewer pressure points

- Does the chosen Responses payload actually support explicit cache markers for GPT-5.6 Luna?
- Can volatile board state leak before the breakpoint?
- Can two sessions with incompatible stable snapshots collide on a key?
- Does encrypted reasoning continuity accidentally move ahead of the breakpoint or force a rewrite?
- Are cache savings being confused with TPM savings?
