# Plan 08A — see inside a Stage-6 model round

Status: **TIER B, RUNS FIRST (2026-08-10). Small-plan lane: ONE reviewer (Codex `gpt-5.6-sol high`), round cap 5.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: none. No formal Plan 00 evidence gate (dropped 2026-08-07 for sole-user field testing).
Sibling: **[08B — round-efficiency levers](plan-08b-stage6-round-levers.md)**, which is HELD until
this ships and one field session runs on it. Split from a single Plan 08 on 2026-08-10 — see
"Why this is split" below.

## Outcome

Additive telemetry that makes a Stage-6 model round legible. **Zero behaviour change**: no
model-visible content, tool call, field write, question, spoken output or wire shape differs.

Three fields and one metric split. That is the whole plan.

## Why this exists

Tier A measured the entire ElevenLabs contribution to perceived latency at **≈ 215 ms** (66 ms
handshake + 147 ms synthesis) against a dictate→read-back p50 of **6.76 s**. The wave had four
plans aimed at the speech vendors and none aimed at the model loop. Live Luna telemetry from four
2026-08-06/07 field sessions closed the arithmetic:

```
summed round stream_ms ÷ perceived_latency_ms = 0.91 – 0.97   (all 9 two-round turns)
```

**Model rounds are ~90 %+ of the loop. TTS is 3–9 %.**

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| Per-round Luna `stream_ms` | 41 rounds | **3.22 s** | 5.46 s | 9.04 s |
| Turn perceived latency | 15 turns | **6.76 s** | 15.86 s | — |

Round-count histogram (28 turns): 2 rounds ×21 (75 %), 3 ×5 (18 %), 4 ×2 (7 %).
`2 × 3.22 s = 6.44 s` against a measured p50 of `6.76 s` — perceived latency is, near enough,
**round count × per-round stream time**.

And **the prompt is not the bottleneck**: cache hit rate measured **100 %** — one `cache_write` of
35,293 tokens at session open, then 40 of 41 rounds reading exactly 35,293 cached tokens, with a
volatile tail of 55–1,309 tokens. Plan 01 already won that. Nothing in this plan or 08B should
re-open it.

So the bottleneck is located. What is *inside* those 3.22 s is not, and cannot currently be
found out.

## Why this is split from 08B

08B chooses between levers — reasoning effort, a round-1 model override, snapshot windowing,
validator vocabulary. **Every one of those choices is decided by data this plan produces.**
Reviewing them together would spend rounds arguing about levers whose value is unmeasured, which
is the churn the planning rules exist to prevent. This half is small, mechanical and
independently shippable; it ships, one field session runs, and 08B is then written against
numbers instead of hypotheses.

## The three faults — all verified in source

### 1. `reasoning_tokens` is discarded

`mapUsage()` (`src/extraction/openai-responses-adapter.js:424-434`) reads
`input_tokens_details.cached_tokens` and `.cache_write_tokens` but never
`output_tokens_details.reasoning_tokens`. Reasoning is folded invisibly into `output_tokens`.

This is a one-adapter oversight, not a platform limit: `src/extraction/openai-vision-adapter.js:136`
already reads the equivalent field on the Chat Completions shape.

**Consequence:** we cannot say what fraction of a 3.22 s round is reasoning — the single number
that selects between 08B's levers.

### 2. There is no first-token timestamp

`src/extraction/stage6-tool-loop.js:1093-1098` stamps `started_ns`, `stream_complete_ns` and
`dispatch_complete_ns`. `stream_ms` is *round start → stream complete* with nothing in between, so
a round that sits silent for 3.0 s and then emits in 0.2 s is indistinguishable from one streaming
steadily for 3.2 s.

**This is the most consequential of the three, and it reaches beyond 08B:**

- **Front-loaded reasoning silence** → the lever is effort/model. Loaded Barrel cannot help,
  because there is no streamed tool call to speculate on until the silence ends — and **Plan 02
  (iOS incremental TTS) is attacking a far smaller prize than the wave assumed.**
- **Steady streaming** → Loaded Barrel and Plan 02 are already the right attack, and 08B's
  per-round work is worth less.

The adapter docstring at `openai-responses-adapter.js:39` already asserts the first reading — *"the
dominant cost (reasoning time before the FIRST tool_use appears)"*. **It is an assertion that has
never been measured.** Do not let this plan's review promote it to a fact; the point of the plan is
to test it.

### 3. `dispatch_ms` conflates compute with waiting for a human

One observed round reported `dispatch_ms = 10,427 ms`. That was the loop parked on the inspector's
answer to an `ask_user`, not 10 s of server work. Any before/after latency series that includes
`ask_user` turns currently reads human reaction time as backend latency — which would make 08B's
own measurements untrustworthy in exactly the turns most likely to be slow.

## Scope

1. **Surface `reasoning_tokens`.** Extend `mapUsage()` to read
   `output_tokens_details.reasoning_tokens`. It must be *additive*: `output_tokens` keeps its
   current meaning and value, because CostTracker bills on it and the Anthropic-shaped contract is
   consumed in several places. Absent/undefined on providers or responses that do not report it —
   never defaulted to 0 in a way that reads as "measured zero reasoning".

2. **Add `first_token_ns` and `first_tool_use_ns`** to the per-round `timing` object in
   `stage6-tool-loop.js`. `first_token_ns` = first streamed event of any kind; `first_tool_use_ns`
   = first `content_block_start` of type `tool_use`. **Both nullable** — an `end_turn`-only round
   has no tool use, and a round that errors before streaming has neither. Preserve the existing
   fields byte-for-byte; several consumers read them.

3. **Separate the `ask_user` human wait from `dispatch_ms`.** Either split it into its own field or
   mark the round so the wait is excludable downstream. **Do not "fix" it by silently dropping
   `ask_user` rounds from the series** — that hides the slowest turns and would let 08B claim an
   improvement it did not make.

Likely files:

- `src/extraction/openai-responses-adapter.js` (`mapUsage`)
- `src/extraction/stage6-tool-loop.js` (per-round `timing`, both push sites — note there are
  **two**: the `end_turn` early-break at `:696-702` and the main loop at `:1093-1099`; a fix that
  only updates one leaves `end_turn` rounds unmeasured)
- whichever emitter surfaces `round_usage` / turn-core summary to CloudWatch
- focused unit tests for each

## Tests and acceptance

- **Zero behaviour change**, proven rather than asserted: the field-replay corpus stays
  semantically identical, and the tool-loop, reasoning-continuity, cancellation and
  usage-accounting suites stay green.
- Cost attribution is unchanged — `round_usage` is still ingested exactly once, and
  `output_tokens` still bills what it billed before.
- New fields carry **no** prompt text, transcript, address, board value or any other PII —
  round-scoped ids, counts and timings only.
- Nullable fields are genuinely nullable in the emitted payload; no sentinel that a dashboard
  would average.
- Both `timing.push` sites updated.

```bash
npm test -- --runInBand src/__tests__/stage6-tool-loop.test.js
npm test -- --runInBand src/__tests__/openai-responses-adapter.test.js
npm run replay:field-corpus:prepush
npm test
```

## Web companion

**None required.** Additive backend telemetry; nothing crosses the WS or HTTP boundary, no wire
shape changes, and no user-visible behaviour changes on either client. This is a genuine
zero-client-surface change, not a deferral — there is nothing for a parity-ledger row to track.

## Rollout

Ship it, deploy it, then run **one ordinary field session** — no special protocol, no cohort. The
data is the deliverable. 08B is written from it.

## Reviewer pressure points

- Does `output_tokens` still mean exactly what CostTracker thinks it means?
- Is `reasoning_tokens` absent (not `0`) when the provider does not report it?
- Are BOTH `timing.push` sites updated, including the `end_turn` early-break?
- Can any new field carry inspector content, a board value, or anything else PII-shaped?
- Does the `ask_user` split hide slow turns rather than label them?
- Has anything here quietly changed what the model sees, or when a dispatcher runs?
