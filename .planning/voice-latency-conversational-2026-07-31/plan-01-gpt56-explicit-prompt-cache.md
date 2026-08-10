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

### Step 1 — CLOSED 2026-08-10 by the vendor documentation, not by a probe

`prompt_cache_retention: "24h"` **is not available to us.** OpenAI's prompt-caching guide
states the field "is deprecated for GPT-5.6 models and later model families", and both
`gpt-5.6-luna` and `gpt-5.6-terra` are in that family. The same page pins the replacement:
"All breakpoints use the request-wide `prompt_cache_options.ttl`, which currently defaults to
`30m` and is the only supported value", and "a cached prefix remains eligible for reuse for at
least 30 minutes, but OpenAI may retain it longer."

So the plan's preferred fork — *24-hour retention holds, stop here* — is not merely unproven,
it is **unavailable**. Probing for it would have spent an API call to be told the field is
deprecated. Documentation that names our exact model family is the stronger and cheaper
answer, and it is recorded here in place of the probe.

Two secondary facts confirmed while checking: cache writes on GPT-5.6+ bill at 1.25× the
uncached input rate, and `src/extraction/cost-tracker.js:55-66` already models exactly that
(Terra `input: 2.0` / `cacheWrite: 2.5`). The `$0.08819` figure below is therefore correct
as written and is not understating the write premium.

### Step 2 — the only surviving question: does a READ renew the 30-minute lifetime?

This is what decides the 25-minute re-warm timer, and the economics are one-sided enough that
the answer is the whole decision:

- **If a read renews** → a keep-alive is a *read*. Terra reads bill at `$0.20/M`, so
  refreshing the 35,276-token stable prefix costs ≈ `$0.0071` per tick, ≈ `$0.017/hour`. It
  needs to prevent one cold Terra turn per hour to break even (cold write ≈ `$0.08819`
  at `$2.50/M` vs ≈ `$0.0071` warm — a `$0.0811` swing). Plausibly worth building.
- **If a read does not renew** → a keep-alive must be a *write*: ≈ `$0.08819` every 30
  minutes, ≈ `$0.212/hour`, paid whether or not Terra is used again. That is **strictly
  dominated** by simply paying the cold write on the next real Terra turn, which costs the
  same and only when a turn actually happens. In that world the timer can never pay for
  itself and must be closed permanently.

The docs are silent on renewal, so this one is genuinely empirical.

### Do this

Run `scripts/model-ab/cache-ttl-renewal-probe.mjs` (added 2026-08-10). Non-production;
synthetic filler only; logs model/tier, usage buckets, timings and a truncated key digest —
never prompt text, inspection data or keys. It runs two independent cache keys:

| Arm | T+0 | T+25 | T+50 |
|---|---|---|---|
| TEST | write | **read** | check |
| CONTROL | write | — | check |

The control arm is the point: a warm TEST at T+50 proves nothing on its own, because the
vendor explicitly reserves the right to retain a prefix past the 30-minute floor. Only
*TEST warm + CONTROL cold* isolates renewal. Both-warm is `INCONCLUSIVE` — rerun with a
larger `--check-at`, do not read it as a pass.

It probes `gpt-5.6-luna` by default: the behaviour is a platform property of the GPT-5.6
family and Luna bills the same shape at ~1/10th of Terra's rate, so the probe costs ≈ `$0.02`
instead of ≈ `$0.20`. **The Luna→Terra generalisation is an assumption** — pass
`--model gpt-5.6-terra` to confirm it on the model that actually motivated the question if
the verdict comes back `RENEWS` and the timer is going to be built.

### Then decide

- **`NO_RENEW`** → close the 25-minute timer proposal permanently and record it. Given the
  cost asymmetry above this is the outcome that needs no further work.
- **`RENEWS`** → still do *not* implement on that basis alone. Compute projected savings from
  **observed** Terra gaps in real field sessions, not a synthetic always-active workload, and
  only proceed if they exceed the `$0.08819`-per-cold-turn they avoid. Any such re-warm stays
  default-off behind a source-controlled flag, may run only while a recording session is
  active, and must never enter the tool loop, mutate session state, emit a client event,
  trigger TTS, or race a live Luna/Terra turn.
- **`INCONCLUSIVE` / `ANOMALOUS`** → rerun before concluding anything.

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
