# Harness cost notes — running scenarios cheaply during dev

The transcript-replay harness exercises the real Sonnet extraction pipeline.
Run cost is dominated by Sonnet 4.6 API tokens. Two knobs (added 2026-06-01)
collapse the per-iteration cost without giving up coverage of the bugs we
actually care about catching.

## Two env vars

`SONNET_EXTRACT_MODEL` (default `claude-sonnet-4-6`)
  Routes every Sonnet call in the extraction pipeline — keepalive,
  main extraction, and the stage6 tool loop — to the chosen model.
  Cache key includes the model, so all three sites read the same env
  var: a split would silently kill cache reuse.

`SONNET_CACHE_TTL` (default `5m`, accepts `1h`)
  Ephemeral-cache TTL on every `cache_control` block the extraction
  emits (system prompt, snapshot, last user turn). Prod default `5m`
  is optimal for live sessions because writes are 1.25× base. For
  back-to-back harness runs `1h` pays the 2× write once and recoups
  it after ~10 cache reads — the whole 34-scenario suite then runs
  with the cached prefix surviving across every replay.

Both vars also need to be set in the **backend** process the harness
hits (transcript-replay.mjs talks WS → localhost:3000 → backend reads
the env). Restart `npm start` with them set, or pre-export.

## Pre-baked wrapper

```
./scripts/voice-latency-bench/run-cheap.sh --suite=baseline
```

Sets `SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001` and
`SONNET_CACHE_TTL=1h`, forwards everything else to
`transcript-replay.mjs`. Drop-in replacement for direct invocation.

## What Haiku safely covers

The current 34 scenarios are mostly **routing / mechanics tests**: did
the dispatcher fire? Did the script enter? Did the cache populate?
Did the tool emit the right shape? Haiku 4.5 handles all of these
because the prompt is heavily structured (tool schemas, system prompt
explicit on every rule). Haiku does worse on:

- Ambiguous natural-language → field mapping ("the cable is two and a
  half square" → live_csa_mm2 vs 2.5 vs "2.5")
- Multi-field utterances where order matters
- Subtle re-asks ("oh actually that's circuit 3" mid-utterance)

For those cases run the same scenario on Sonnet by unsetting the env
var. The pattern:

```bash
# Fast iteration during dev — Haiku, 1h cache
./scripts/voice-latency-bench/run-cheap.sh --suite=baseline

# Final check before commit — Sonnet, 5m cache (prod defaults)
node scripts/voice-latency-bench/transcript-replay.mjs --suite=baseline
```

## Scenario tagging (future)

A future change adds `requires_model: sonnet | haiku | either` to the
scenario YAML schema. Default `either`. The wrapper would then filter
out `requires_model: sonnet` entries when running on Haiku, so the
Sonnet-only quality checks don't false-fail under the cheap config.
Until that lands, the wrapper runs everything and you read the
diff yourself.

## What the wrapper is NOT

It does NOT route Sonnet API calls through your Claude Max OAuth
subscription. That requires the Claude Agent SDK (`@anthropic-ai/
claude-agent-sdk`), which doesn't currently expose the raw Messages
API surface the extraction pipeline depends on (streaming tool_use,
`cache_control` blocks, multi-turn `tool_result` arrays). Re-routing
would be a larger refactor — Option A in the plan, deferred until
the SDK lands the required primitives or the cost target needs
another order of magnitude beyond what B+C buys.

## Anchor: typical cost

| Config | per-scenario | 34-scenario suite | Notes |
|---|---:|---:|---|
| Sonnet 4.6, 5m cache (prod) | ~$0.05 | ~$1.70 | Live-session pattern. |
| Sonnet 4.6, 1h cache | ~$0.025 (warm) | ~$0.20–0.85 | After 1st run within 1h. |
| Haiku 4.5, 5m cache | ~$0.005 | ~$0.17 | First run, cache write. |
| **Haiku 4.5, 1h cache (the wrapper)** | **~$0.0005 (warm)** | **~$0.02 / $0.17** | Subsequent / first within 1h. |

Numbers based on 2026-06-01 published per-1M-token pricing and the
current extraction prompt size (~30 KB system, ~5–20 KB snapshot,
~200 tokens output per scenario). Re-measure when prompt size shifts.
