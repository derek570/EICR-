# Plan 01 — explicit GPT-5.6 prompt caching

Status: **TIER A (2026-08-10) — core cache shipped; one retention probe + a decision remain**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: none. No formal Plan 00 evidence gate (dropped 2026-08-07 for sole-user field testing).

> **2026-08-10 re-scope.** This plan is no longer an `/rp` candidate. Sections 1–4 of the
> original shipped on 2026-08-02 and their audit checklist has no remaining consumer; they
> are compressed to the shipped-state record below. The original §4 mandate to compare
> "at least 30 warm production-like turns per cohort" is **cut** — production telemetry
> already separates cache reads from writes, so the question is answered by reading it.
> What is left is one probe and one decision.

## Outcome

Give Luna a stable explicit cache boundary for the large Stage-6 prompt and snapshot prefix,
with per-turn state outside the cached prefix — fewer cache-write tokens, lower warm-turn
cost, possibly lower first-round latency, and no change to any model-visible instruction,
tool or client response.

This does **not** address the 200k TPM ceiling: OpenAI counts cached input toward that limit.
Rate-limit work is a separate problem and must not be conflated with cache savings.

## Shipped state (2026-08-02, PR #150 `94f56eea`) — record only, do not re-implement

- `buildSystemBlocks()` produces base, stable snapshot prefix and volatile snapshot tail
  blocks, carrying Anthropic `cache_control` markers.
- `openai-responses-adapter.js` maps those logical blocks to an explicit Responses cache
  breakpoint, derives a stable cache key, and sends `prompt_cache_options.mode="explicit"`.
  Anthropic rendering is unchanged; the breakpoint sits after the stable prefix, with the
  volatile tail, current user turn, reasoning continuation and tool results all after it.
- The cache key is a versioned manifest digest (model, base-prompt digest, tool-schema
  digest, certificate type, stable snapshot identity). No session IDs, user text, board
  values or PII in the key or in telemetry.
- Production telemetry separates cache reads from cache writes. The last measured field
  session saved `$0.11456114` of GPT-5.6 model cost (`44.4189%`) via explicit caching under
  the corrected 2026-07-30 prices.

## The one open question — Terra retention

`prompt_cache_options.ttl` is omitted, so the documented default minimum lifetime is
30 minutes, and OpenAI does **not** document an ordinary cache read as renewing that
lifetime. A separate `prompt_cache_retention` policy exists whose `"24h"` setting can keep
an eligible prefix active for up to 24 hours.

The original plan proposed a 25-minute forced Terra re-warm timer. **That proposal is a
hypothesis, and an expensive one:** the Terra stable prefix is 35,276 tokens, so one forced
rewrite costs ≈ `$0.08819` at `$2.50/M`. Two unconditional rewrites (≈ `$0.17638`) already
exceed a complete cold-equivalent observation turn, and any rewrite followed by no Terra use
wastes the full amount.

### Do this

1. Probe `prompt_cache_retention: "24h"` against the live Terra request shape and stable
   cache key. Non-production, under `scripts/model-ab/`. Log only model/tier, usage buckets,
   request hash and timings — never prompt text or keys.
2. Run one controlled same-key sequence across the 30-minute boundary and read the provider
   cache-read/cache-write tokens. This settles whether a read renews the lifetime; until
   token telemetry shows it, a 25-minute read **may not be called a keep-alive**.

### Then decide

- **If 24-hour retention holds** → close the 25-minute timer proposal as unnecessary and
  record that outcome. This is the expected and preferred result. Stop here.
- **If retention does not hold** → do *not* implement the timer on that basis alone. Compute
  projected savings from **observed** Terra intervals in real field sessions, not a synthetic
  always-active workload, and only proceed if they exceed the `$0.08819`-per-rewrite cost.
  Any such re-warm stays default-off behind a source-controlled flag, may run only while a
  recording session is active, and must never enter the tool loop, mutate session state,
  emit a client event, trigger TTS, or race a live Luna/Terra turn.

## Acceptance

- no change to conversation behaviour, model-visible content, tool calls, field writes,
  questions, or exactly-once TTS;
- no PII in the cache key or telemetry;
- tool-loop, reasoning-continuity, cancellation and usage-accounting suites stay green;
- field replay stays semantically identical;
- retain only if warm p50/p95 or cost improves materially — a cost-only improvement is
  acceptable if it is named honestly as cost-only.

```bash
npm test -- --runInBand src/__tests__/openai-responses-adapter.test.js
npm run replay:field-corpus:prepush
npm test
```

## Rollout and rollback

Flags live in `ecs/task-def-backend.json` and the replay-environment pins — never edited on
the live task definition. Rollback is a source change merged through CI. Update
`docs/reference/architecture.md`, `deployment.md` and `changelog.md` if anything ships.

## Pressure points that still matter

- Can volatile board state leak ahead of the breakpoint?
- Can two sessions with incompatible stable snapshots collide on one key?
- Does encrypted reasoning continuity move ahead of the breakpoint or force a rewrite?
- Are cache savings being confused with TPM savings?
- Has "a read renews the TTL" been *proven from token telemetry*, or assumed?
