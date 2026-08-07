# Plan 01 — explicit GPT-5.6 prompt caching

Status: **DRAFT SUPPLEMENT — core explicit cache is live; retention/keep-warm work is not RP-reviewed or implemented**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: none — core cache is already live. No formal Plan 00 evidence-gate DONE required (2026-08-07, Derek: the gate was dropped for sole-user field testing); proceed once the informal Luna field test feels solid.

## Outcome

Give Luna an explicit, stable cache boundary for the large Stage-6 prompt and snapshot prefix, while leaving per-turn state outside the cached prefix. The intended result is fewer cache-write tokens, lower warm-turn cost and potentially lower first-round latency without changing any model-visible instruction, tool or client response.

This is not expected to solve the 200k TPM ceiling: OpenAI counts cached input toward that limit. Rate-limit work must be measured separately.

## Verified starting point

- `buildSystemBlocks()` already produces base, stable snapshot prefix and volatile snapshot tail blocks, with Anthropic `cache_control` markers.
- The core of this plan shipped on 2026-08-02: `openai-responses-adapter.js` now maps those logical blocks into an explicit Responses cache breakpoint, derives a stable cache key and sends `prompt_cache_options.mode="explicit"`.
- Production telemetry now separates cache reads and writes. The latest measured field session saved `$0.11456114` of GPT-5.6 model cost (`44.4189%`) through explicit caching under the corrected 2026-07-30 prices.
- The live request omits `prompt_cache_options.ttl`, so the documented default minimum lifetime is 30 minutes. OpenAI does not document an ordinary cache read as renewing that lifetime.
- The Responses API also exposes the independent `prompt_cache_retention` policy. Its `"24h"` setting can keep eligible cached prefixes active for up to 24 hours and must be evaluated before inventing timer traffic.

Official implementation references:

- [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Responses API create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

## Original core scope — live, retained as an audit checklist

Do not re-implement Sections 1–4. During RP, verify the shipped implementation against these requirements and turn any genuine mismatch into a separate corrective item. The only new implementation candidate introduced by this supplement is Section 5, and that section begins with measurement rather than a timer.

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

### 5. Terra retention before any 25-minute keep-alive

Treat the proposed 25-minute Terra keep-alive as a hypothesis, not as an implementation instruction. Do not add an unconditional timer during refinement.

1. **Evaluate 24-hour retention first.** Probe `prompt_cache_retention: "24h"` with the live Terra request shape and stable cache key. This is separate from `prompt_cache_options.ttl`: the latter remains the documented 30-minute minimum lifetime, while retention controls the maximum period for which an eligible prefix may remain active.
2. **Prove whether reads renew the cache.** Run a controlled same-key sequence around the 30-minute boundary and inspect provider cache-read/cache-write tokens. The documentation describes an earlier breakpoint as read-only and does not promise that a read restarts its lifetime, so a 25-minute read cannot be called a keep-alive without evidence.
3. **Only then evaluate forced re-warming.** If 24-hour retention is unavailable or does not retain reliably, test a forced cache rewrite behind a source-controlled, default-off flag. It may run only while a recording session is active and only after recent Terra/observation use. It must not enter the conversational tool loop, mutate session state, emit a client event, trigger TTS or race a live Luna/Terra turn.
4. **Apply a cost gate.** The measured Terra stable prefix is 35,276 tokens, so one forced rewrite costs approximately `$0.08819` at the current `$2.50/M` cache-write rate. Two unconditional rewrites already cost approximately `$0.17638`, more than the latest complete cold-equivalent observation turn; any rewrite followed by no Terra use wastes the entire amount.
5. **Instrument before deciding.** Record model, cache-key digest/version, scheduled/attempted/skipped status and reason, time since last Terra use/write, cache-read/write tokens, actual model cost, whether the next observation hit the cache, and the next observation's provider/first-audio latency. Never record prompt text or the raw key.

Retention acceptance gates:

- no change to conversation behaviour, model-visible content, tool calls, field writes, questions or exactly-once TTS;
- a controlled probe demonstrates either a genuine post-30-minute cache hit with 24-hour retention or an actual lifetime refresh rather than a normal read;
- projected field-use savings exceed added cache-write cost using observed Terra intervals, not a synthetic always-active workload;
- default remains off until field data demonstrates a worthwhile latency benefit, and rollback is a source-controlled config change;
- if 24-hour retention works, close the 25-minute timer proposal as unnecessary.

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
- Does `prompt_cache_retention: "24h"` eliminate the proposed keep-alive, and has any claim that a read renews TTL been proven from token telemetry rather than assumed?
- Can the proposal ever save more than its approximately `$0.08819` forced-write cost at the observed Terra-use cadence?
