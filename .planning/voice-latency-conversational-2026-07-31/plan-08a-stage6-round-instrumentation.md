# Plan 08A — see inside a Stage-6 model round

Status: **TIER B, RUNS FIRST (2026-08-10). Small-plan lane: ONE reviewer (Codex `gpt-5.6-sol high`), round cap 5.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: none. No formal Plan 00 evidence gate (dropped 2026-08-07 for sole-user field testing).
Sibling: **08B — round-efficiency levers**, held until **both** (a) 08A is deployed and one ordinary
field session has produced its telemetry, and (b) the outstanding Plan-07 Loaded Barrel within-turn
A/B verdict is resolved. **08A itself is blocked by neither.** Split from a single Plan 08 on
2026-08-10 — see "Why this is split" below.

Review constraint: `--no-ship`; refinement must not launch `/ep`.
Canonical tracked source:
`.planning/voice-latency-conversational-2026-07-31/plan-08a-stage6-round-instrumentation.md`.
Before any execution or wave merge, copy the converged `PLAN-final.md` back to that tracked path and
verify it is still linked from `INDEX.md`. Resolve 08B at
`.planning/voice-latency-conversational-2026-07-31/plan-08b-stage6-round-levers.md`.

## Outcome

Additive telemetry that makes a Stage-6 model round legible. **Zero behaviour change**: no
model-visible content, tool call, field write, question, spoken output or wire shape differs.

Three fields, plus timing coverage on every completed round rather than only two of four exits.
That is the whole plan.

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

### 1. `reasoning_tokens` is discarded — twice

`mapUsage()` (`src/extraction/openai-responses-adapter.js:424-434`) reads
`input_tokens_details.cached_tokens` and `.cache_write_tokens` but never
`output_tokens_details.reasoning_tokens`. Reasoning is folded invisibly into `output_tokens`.

**And even if the adapter surfaced it, it would still not reach CloudWatch.**
`attributeRoundUsage()` (`src/extraction/round-usage-attribution.js:176-208`) returns an explicit
allowlist object — `output_tokens` and the input/cache buckets are copied field by field, and
anything not named is dropped. Both halves must change or the field silently never appears.

The Chat Completions vision adapter confirms the provider shape exists:
`callOpenAIChat()` reads `completion_tokens_details.reasoning_tokens` at
`src/extraction/openai-vision-adapter.js:136` — but **only inside the empty-content error branch**,
where it is interpolated into an exception message. The successful return at `:147-153` does not
surface it. There is no existing telemetry path to copy; this plan adds the first one.

**Consequence:** we cannot say what fraction of a 3.22 s round is reasoning — the single number
that selects between 08B's levers.

### 2. There is no honest first-content timestamp

`src/extraction/stage6-tool-loop.js:1093-1098` stamps `started_ns`, `stream_complete_ns` and
`dispatch_complete_ns`. `stream_ms` is *round start → stream complete* with nothing in between, so
a round that sits silent for 3.0 s and then emits in 0.2 s is indistinguishable from one streaming
steadily for 3.2 s.

**The obvious fix — "stamp the first streamed event" — does not work on this transport, and must
not be attempted.** `translateStreamingEvents()` (`openai-responses-adapter.js:353`) yields a
synthetic `{type:'message_start'}` **before** it begins iterating the provider SSE stream, and
deliberately suppresses reasoning, message and output-text events (`:376-379`, `:406-409`) because
the assembler only tracks `tool_use` blocks and final content is rebuilt from `finalResponse()`.
A "first event of any kind" stamp taken at the tool-loop seam would therefore record ≈ 0 ms on
every round — a precise, confident, meaningless number.

The honest marker on this transport is the **first `content_block_start` of type `tool_use`**,
which originates from a real provider `response.output_item.added` event. It yields exactly the
split this plan exists to produce:

- `started_ns → first_tool_use_ns` — dead air: queue, prefill and reasoning.
- `first_tool_use_ns → stream_complete_ns` — the streaming window, and the only span incremental
  playback could ever overlap.

**This is the most consequential of the three, and it reaches beyond 08B:**

- **Front-loaded silence** → the lever is effort/model. Loaded Barrel cannot help, because there is
  no streamed tool call to speculate on until the silence ends — and **Plan 02 (iOS incremental
  TTS) is attacking a far smaller prize than the wave assumed.**
- **Steady streaming** → Loaded Barrel and Plan 02 are already the right attack, and 08B's
  per-round work is worth less.

The adapter docstring at `openai-responses-adapter.js:39` already asserts the first reading — *"the
dominant cost (reasoning time before the FIRST tool_use appears)"*. **It is an assertion that has
never been measured.** Do not let this plan's review promote it to a fact; the point of the plan is
to test it.

**Stated limitation, not a gap to fix here:** an `end_turn` round emits no tool call, so it has no
`first_tool_use_ns` and its interior stays opaque. That is accepted. The rounds this plan needs to
see inside are the tool-emitting ones that make up the multi-round loop.

### 3. `dispatch_ms` conflates compute with waiting for a human

One observed round reported `dispatch_ms = 10,427 ms`. That was the loop parked on the inspector's
answer to an `ask_user`, not 10 s of server work. Any before/after latency series that includes
`ask_user` turns currently reads human reaction time as backend latency — which would make 08B's
own measurements untrustworthy in exactly the turns most likely to be slow.

### 3b. Five of the seven post-completion exits emit no timing at all

A provider response is **complete** once `stream.finalMessage()` resolves
(`stage6-tool-loop.js:564`); its attributed usage row is appended at `:626`. Everything after that
point is a round we have already paid for and should be able to measure. There are **seven** such
paths, and `roundTimings.push()` runs on only two:

| # | Path | Line | Timing today |
|---|---|---|---|
| 1 | non-tool-use / `end_turn` break | `:706` | pushed (`:702`) |
| 2 | cap-hit invariant break — zero abort results | `:767` | **none** |
| 3 | ordinary cap-hit break | `:777` | **none** |
| 4 | pre-dispatch cancellation rethrow | `:916` | **none** |
| 5 | fatal dispatcher / cancellation / ask-registration rethrow | `:1012` | **none** |
| 6 | no-tool-result invariant break | `:1082` | **none** |
| 7 | normal dispatched continuation | `:1103` | pushed (`:1099`) |

An earlier draft of this plan claimed four paths and treated the cap branch as a single exit. It is
two — `:767` and `:777` — and the draft missed both fatal-rethrow paths entirely.

The `finalMessage()` catch at `:565-571` is correctly **not** in this set: it fires before the
response completes, so there is no round to measure and it must contribute no row.

Paths 2–6 are silently unmeasured today, and they are by construction the pathological turns —
cap-outs, cancellations and protocol violations. A latency series that omits them is biased exactly
where it most needs to be honest, and paths 4–5 are what a **barge-in** produces, which is precisely
the interaction this wave is trying to make feel fast.

## Scope

1. **Surface `reasoning_tokens` end-to-end.** In `openai-responses-adapter.js:mapUsage()`, set
   `reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null`. In
   `round-usage-attribution.js:attributeRoundUsage()`, add
   `reasoning_tokens: usage?.reasoning_tokens ?? null` to the returned round row. **Keep
   `output_tokens` and every CostTracker input unchanged** — it keeps its current meaning and value,
   because billing depends on it and the Anthropic-shaped contract is consumed in several places.
   Add an adapter→`runToolLoop()` regression asserting a reported `25`, a reported `0`, and an
   unreported `null` all survive into `round_usage`.

2. **Add `first_tool_use_ns: string | null`** to the per-round `timing` object. Capture the BigInt
   with `process.hrtime.bigint()` immediately before `asm.handle(ev)` for the first
   `content_block_start` whose block type is `tool_use`, and **emit it as a decimal string** —
   `firstToolUseNs === null ? null : firstToolUseNs.toString()` — exactly as `started_ns`,
   `stream_complete_ns` and `dispatch_complete_ns` already do (`:696-698`, `:1093-1095`).
   **A raw BigInt in the timing object would crash the emitter**: production logging serialises
   metadata with `JSON.stringify` (`src/logger.js:97-100`), which throws
   `TypeError: Do not know how to serialize a BigInt`. That fires on the *common* path — any round
   that emits a tool call — so it would take down live turns, not just edge cases.
   **Do not add `first_token_ns`** — see fault 2; the Responses adapter emits a synthetic
   `message_start` before reading provider SSE and suppresses text/reasoning events, so that field
   would encode a false measurement. Derive `pre_tool_use_ms` and `post_tool_use_ms` downstream from
   `started_ns`, `first_tool_use_ns` and `stream_complete_ns`. Preserve the existing timing fields
   byte-for-byte; several consumers read them.

3. **Mark ask-bearing dispatch rounds without redefining existing timing.** Add
   `blocking_ask_user_dispatched: boolean` to every emitted timing object. **There is no existing
   round-scoped collection to read this from at finalisation time** — `sortedRecords` (`:792`) is the
   *candidate* set and still contains assembler-error records that are skipped at `:880-897`, while
   `allCalls` (`:397`) is loop-wide, not per-round, and only receives successful dispatcher returns
   (`:1000-1005`). `toolResults` does not retain the tool name.
   So: initialise a per-round `blockingAskUserDispatched = false` before the dispatch loop and set it
   to `true` immediately before the `dispatcher(...)` invocation at `:919-922` when
   `rec.name === 'ask_user'` (the exact tool name — `stage6-tool-schemas.js:626`). Do **not** set it
   for assembler-error records or for cap-held calls that were never dispatched.
   **Keep `dispatch_ms` byte-for-byte unchanged**; dashboards then split or exclude marked rounds
   while retaining them in the series. Do not copy question text, answer text or `input` into timing
   telemetry. **Do not "fix" this by silently dropping `ask_user` rounds** — that hides the slowest
   turns and would let 08B claim an improvement it did not make.

4. **Instrument every completed provider response.** The post-stream phase begins only once
   `finalMessage()` has resolved (`:564`) and the attributed `roundUsage` row exists (`:626`).
   Centralise timing finalisation in one **synchronous, non-awaiting, non-throwing, per-round
   idempotent** helper and invoke it on all seven paths in the fault-3b table: `:706`, `:767`,
   `:777`, `:916`, `:1012`, `:1082` and the normal continuation at `:1103`.
   On the two fatal rethrows (`:916`, `:1012`) finalise **before** `attachBillableUsage(...)`, so
   `error.billableUsage.round_usage` carries the timing of the round that was actually paid for.
   A stream or `finalMessage()` failure *before* response completion (`:565-571`) contributes no row.
   Assert **exactly one** timing row per completed provider response, and no duplicate
   `roundTimings` entry on the paths that return normally.

Files:

- `src/extraction/openai-responses-adapter.js` (`mapUsage`)
- `src/extraction/round-usage-attribution.js` — retain nullable `reasoning_tokens` in each
  attributed row. **This is the file the original draft missed**, and without it item 1 is a no-op.
- `src/extraction/stage6-tool-loop.js` — the timing helper, the per-round ask flag, and all seven
  post-completion paths
- focused unit tests for each

**No production edit is needed in the emitters** — they already forward the complete attributed row:
`stage6-shadow-harness.js:4184-4206` emits it as `stage6_live_extraction.prompt_cache_rounds`, and
`:4258-4274` passes it through `emitTurnCoreSummary()` (`voice-latency-turn-summary.js:212-221`) as
`voice_latency.turn_core_summary.round_usage`. Add assertions covering **both** emitted field paths.

## Tests and acceptance

- **Zero behaviour change**, proven rather than asserted: the field-replay corpus stays
  semantically identical, and the tool-loop, reasoning-continuity, cancellation and
  usage-accounting suites stay green.
- Cost attribution is unchanged — `round_usage` is still ingested exactly once, and
  `output_tokens` still bills what it billed before.
- New fields carry **no** prompt text, transcript, address, board value or any other PII —
  round-scoped ids, counts, booleans and timings only.
- **Null contract:** every unavailable measurement is present as explicit JSON `null`; a
  provider-reported numeric `0` remains `0`. Use `?? null`, never `|| 0`, for `reasoning_tokens` and
  the nullable timestamp. `src/logger.js:97-100` serialises via `JSON.stringify`, so an explicit
  `null` survives to CloudWatch while an `undefined` property vanishes silently.
- **Serialisation assertion, in production format, on both emitted round arrays**, covering all
  three shapes that can actually reach it: an explicit `null`, a provider-reported `0`, and a
  non-null `first_tool_use_ns` as a **decimal string**. The last of these is the one that catches a
  BigInt leaking through — `JSON.stringify` throws on BigInt, so a test that only checks the null
  case would pass while production crashes on the first tool-emitting round.
- Exactly one timing row per completed provider response, across all seven paths — with a focused
  test per path, including **both** cap subpaths (`:767`, `:777`) and a fatal dispatcher
  cancellation, and asserting no duplicate `roundTimings` entry on the paths that return normally.
- Update `docs/reference/architecture.md` to document the new `round_usage` fields, add the detailed
  row to `docs/reference/changelog.md`, and add the required one-line hub changelog entry.
- Sync the converged plan back to its tracked path, and carry the sibling correction with it:
  **08B §1.4 has been updated** in the same wave directory to read the front-loaded-silence result
  off `started_ns → first_tool_use_ns` rather than the dropped `first_token_ns`.

```bash
npm test -- --runInBand src/__tests__/stage6-tool-loop.test.js
npm test -- --runInBand src/__tests__/openai-responses-adapter.test.js
npm run replay:field-corpus:prepush
npm test
npm test --workspace=web
```

## Web companion

**None required.** Additive backend telemetry; nothing crosses the WS or HTTP boundary, no wire
shape changes, and no user-visible behaviour changes on either client. This is a genuine
zero-client-surface change, not a deferral — there is nothing for a parity-ledger row to track.

## Rollout

Ship it, deploy it, then run **one ordinary field session** — no special protocol, no cohort. The
data is the deliverable. 08B is written from it.

Commit each logical unit with its rationale, push a topic branch, merge only through a green PR, and
watch the post-merge deployment. Never push directly to `main`.

## Reviewer pressure points

- Does `output_tokens` still mean exactly what CostTracker thinks it means?
- Is `reasoning_tokens` `null` (not `0`) when the provider does not report it — and does it survive
  `attributeRoundUsage()`'s allowlist rather than being dropped there?
- Are all **seven** post-completion paths instrumented, with exactly one timing row per completed
  response — and does the finalisation helper stay non-throwing, so it can never convert a
  telemetry bug into a failed turn?
- Could `first_tool_use_ns` be stamped from anything other than a genuine provider event, and is it
  a decimal string rather than a BigInt everywhere it can reach `JSON.stringify`?
- Can any new field carry inspector content, a board value, or anything else PII-shaped?
- Does the `ask_user` marking hide slow turns rather than label them?
- Has anything here quietly changed what the model sees, or when a dispatcher runs?
