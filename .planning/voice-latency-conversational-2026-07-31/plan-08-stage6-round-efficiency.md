# Plan 08 — Stage-6 round efficiency

Status: **TIER B, RUNS FIRST (2026-08-10). Analysis complete; authored on measured evidence.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Dependency: none. No formal Plan 00 evidence gate (dropped 2026-08-07 for sole-user field testing).
Supersedes nothing; **created 2026-08-10** because Tier A proved the latency is upstream of the
speech vendors and no existing plan owned that ground.

## Why this plan exists

Plan 03's bench measured the entire ElevenLabs contribution to perceived latency at **≈ 215 ms**
(66 ms handshake + 147 ms synthesis) and the best available tuning arm at **35 ms**. Against a
dictate→read-back loop whose p50 is **6.76 s**, the speech vendors are noise. The wave as
authored had four plans aimed at ~5 % of the budget and none aimed at the other ~90 %.

This plan owns the ~90 %.

## The evidence

From CloudWatch telemetry on four live Luna field sessions (2026-08-06/07), read directly —
no new cohort apparatus was built, per the 2026-08-10 re-scope.

**Model rounds ARE the latency.** On all nine two-round turns where both numbers exist:

```
summed round stream_ms ÷ perceived_latency_ms = 0.91 – 0.97
```

TTS is 3–9 % of the turn. Everything else — Deepgram, dispatch, bundling, network, playback —
shares what is left of that 3–9 %.

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| Per-round Luna `stream_ms` | 41 rounds | **3.22 s** | 5.46 s | 9.04 s |
| Turn perceived latency | 15 turns | **6.76 s** | 15.86 s | — |

Round-count histogram (28 turns, 4 sessions): **2 rounds ×21 (75 %)**, 3 ×5 (18 %), 4 ×2 (7 %).
p50 = 2, p95 = 4.

The arithmetic closes: `2 rounds × 3.22 s = 6.44 s` against a measured p50 of `6.76 s`. Perceived
latency is, to a first approximation, **round count × per-round stream time**. That gives exactly
two levers, and their value is not equal:

- **Per-round stream time attacks 100 % of turns** and is the whole of the p50 story.
- **Round count attacks the 25 % tail** and is most of the p95 story.

**The prompt is NOT the bottleneck — do not attack it.** Cache hit rate was **100 %**: one
`cache_write` of 35,293 tokens on session open, then 40 of 41 subsequent rounds read exactly
35,293 cached tokens, with a volatile tail of 55–1,309 tokens. Plan 01 already won this. Any
proposal in this plan that amounts to "make the prompt smaller to save cost" is out of scope and
should be rejected on sight; the only prompt-size question that survives is the *latency* one in
§2.4, which is a different claim and needs its own measurement.

## The blocking problem: we cannot yet see inside a round

Three measurement faults make every lever below unevaluable as things stand. **They are Phase 1
and they ship alone, before anything is tuned.**

### 1.1 `reasoning_tokens` is discarded

`mapUsage()` (`src/extraction/openai-responses-adapter.js:424-434`) reads
`input_tokens_details.cached_tokens` and `.cache_write_tokens`, but never
`output_tokens_details.reasoning_tokens`. Reasoning tokens are folded invisibly into
`output_tokens`. `src/extraction/openai-vision-adapter.js:136` already reads the equivalent field
on the Chat Completions shape, so the omission is an oversight in one adapter, not a platform
limit.

Consequence: **we cannot say what fraction of a 3.22 s round is reasoning.** That single number
decides between the levers in §2 — so measure it before choosing.

### 1.2 There is no first-token timestamp

`stage6-tool-loop.js:1093-1098` stamps `started_ns`, `stream_complete_ns` and
`dispatch_complete_ns`. `stream_ms` is therefore *round start → stream complete* with nothing in
between. A round that spends 3.0 s silent and then emits in 0.2 s is indistinguishable from one
that streams steadily for 3.2 s.

That distinction is decisive for the whole wave, not just this plan:

- **Front-loaded reasoning silence** → the lever is effort/model (§2.1, §2.2). Loaded Barrel
  cannot help, because there is no streamed tool call to speculate on until the silence ends —
  and **Plan 02 (iOS incremental TTS) is attacking a much smaller prize than it thinks.**
- **Steady streaming** → Loaded Barrel and Plan 02 are already the right attack, and §2 is worth
  less.

The adapter docstring at `openai-responses-adapter.js:39` already asserts the first reading
("the dominant cost (reasoning time before the FIRST tool_use appears)"), but **it is an
assertion, not a measurement.** Prove it.

Add `first_token_ns` (first streamed event of any kind) and `first_tool_use_ns` (first
`content_block_start` of type `tool_use`) to the per-round `timing` object. Both are nullable —
an `end_turn`-only round has no tool use.

### 1.3 `dispatch_ms` conflates compute with waiting for a human

One observed round reported `dispatch_ms = 10,427 ms`. That was the loop parked on the
inspector's answer to an `ask_user`, not 10 s of server work. Any before/after comparison that
includes `ask_user` turns is currently reading human reaction time as backend latency.

Split the human wait out, or exclude those rounds from the latency series explicitly. Do not
"fix" it by quietly dropping `ask_user` turns — that hides the very turns most likely to be slow.

### Phase 1 acceptance

Zero behaviour change. No model-visible content, tool call, field write, question or spoken
output differs. Additive telemetry only. This phase ships and deploys on its own so that one
field session produces the data that selects Phase 2's work.

## §2 — Per-round stream time (attacks 100 % of turns)

**Do not start this before Phase 1 has produced one field session's data.** The ranking below is
a hypothesis ordering, not an execution order.

### 2.1 Reasoning effort

Live config: `reasoning.effort` resolves to `'low'`
(`openai-responses-adapter.js:540-542`); `OPENAI_EXTRACT_REASONING_EFFORT` is unset in
`ecs/task-def-backend.json`, so `'low'` is the default, not a considered choice.

If §1.1 shows reasoning tokens dominate output tokens, a lower effort is the single largest lever
in this plan and costs one env var.

**Known hazard, recorded so a reviewer does not have to rediscover it.** The adapter docstring
(`openai-responses-adapter.js:9-18`) documents that forcing `reasoning='none'` on the Chat
Completions adapter produced *"a reasoning model with its reasoning switched off"* — Luna looped
on tool calls instead of ever emitting a clean `end_turn`, **because a reasoning model without
reasoning cannot decide it is done.** A loop that never terminates is worse than a slow one: it
burns the round cap, costs more, and delays the read-back further.

So: probe any effort below `'low'` against the real tool schema on the Responses API before
believing it, and require a clean `end_turn` on multi-round shapes — not just on the trivial
single-call turn. If termination degrades at all, stop; the shipped `'low'` is correct.

### 2.2 `VOICE_LATENCY_ROUND1_MODEL` — shipped, wired, currently empty

`stage6-tool-loop.js:431` / `:481-488` implement a live-read round-1 model override; the task def
sets it to `""` (`ecs/task-def-backend.json:49`). It was built in 2026-05-28 for Sonnet 4.6 →
Haiku, when round 1 was the dominant cost — the same diagnosis this plan reaches for Luna.

Constraints already enforced in code, which bound what can be proposed:

- `assertSameProvider(model, configuredRound1Override)` at `:433` — an OpenAI base model may only
  be overridden by another OpenAI model. Cross-provider is rejected before the first dispatch,
  deliberately, because OpenAI's encrypted reasoning blocks would reach an SDK that cannot read
  them.
- Observation-tier turns pass `allowRound1ModelOverride: false`
  (`stage6-shadow-harness.js:1645-1647`), so a deliberate Terra escalation is never swapped back.

The open question is empirical and narrow: **is there a same-provider model materially faster
than Luna Fast at emitting one correct `record_reading`?** Luna is already the fast tier. If the
answer is no, say so and close this item — do not invent a cross-provider path around the fence.

### 2.3 Output size

`max_output_tokens` is `max((max_tokens||4096) * 4, 8192)` (`:532`) — a ceiling, not a cost. It is
not a latency lever and should not be presented as one. *Actual* emitted tokens are, and §1.1 is
what makes them attributable between reasoning and visible output.

### 2.4 Does a 35 k cached prefix still cost latency?

Cache hit rate is 100 % and cost is solved, but a cached prefix is not a free prefill. If §1.2
shows a large fixed floor on every round independent of output size, this becomes a real
question. It is explicitly **not** a cost question — Plan 01 closed that — and must not be allowed
to reopen one.

## §3 — Round count (attacks the 25 % tail)

### 3.1 The `board_id` vocabulary gap — verified, same class as the shipped `'main'` fix

Two live rounds were spent on validator rejections of `board_id: 'current'` and `board_id: '*'`.
Mechanism verified in source:

- `validateBoardScope` (`stage6-dispatch-validation.js:719-731`) rejects any supplied `board_id`
  that is not string-equal to `currentBoardId`. There is no vocabulary of accepted aliases.
- `normaliseBoardScopeInput` (`stage6-multi-board-shape.js:121-140`) canonicalises exactly two
  things: the empty string, and `'main'` under the three conjunctive conditions added 2026-08-06.
  `'current'` is handled nowhere. `'*'` is explicitly passed through untouched (`:80-81`) because
  it is the `set_field_for_all_circuits` broadcast — which means it is only correct on the tools
  exempt from `validateBoardScope` (`:704-705`), and is a guaranteed rejection anywhere else.
- The tool schema (`stage6-tool-schemas.js:254`) tells the model *"There is no board id 'main'"*
  — a fix for the previous instance of this exact class, phrased as one blocked spelling rather
  than as the accepted vocabulary.

This is the **same failure class as the 2026-08-06 field bug**: the model reaches for a natural
word for "the board I am on", the validator rejects it, and a round is burned. The 2026-08-06
wave fixed one word. The class is still open.

Preferred shape: state the accepted vocabulary positively rather than enumerating blocked
spellings one field incident at a time. Two candidate mechanisms, and a reviewer should pick
between them rather than doing both:

- **(a) Schema/prompt only.** Say what IS accepted ("omit it, or the exact id from the BOARDS
  section"). Cheapest, zero mutation risk, but relies on the model complying.
- **(b) Normaliser alias.** Extend `normaliseBoardScopeInput` to canonicalise `'current'` the way
  `''` is canonicalised — to ABSENT, which every downstream reader already agrees means
  `currentBoardId`. Deterministic, but it widens a security-adjacent surface and must inherit the
  `'main'` fix's conjunctive discipline. **`'*'` must NOT be aliased on gated tools** — a
  broadcast silently retargeted at one board would corrupt the certificate, and rejecting it is
  correct. It should merely reject *audibly*, which the `wrong_board` partial-failure family
  (2026-08-06) already provides.

Either way the invariant is unchanged: **`wrong_board` speaks.** Whatever is not accepted must be
audible, never silently dropped — that is the whole lesson of 2026-08-06 and this plan must not
regress it.

### 3.2 `SNAPSHOT_RECENT_CIRCUITS = 3` — confirmed to cause re-derivation

`SNAPSHOT_RECENT_CIRCUITS = 3` (`eicr-extraction-session.js:111`) with
`CIRCUIT_ORDER = 'recent_3'` (`ecs/task-def-backend.json:54`) renders only the last three
circuits in detail and summarises the rest as *"N earlier circuits (…) stored server-side"*
(`:4149-4157`).

Confirmed from model reasoning summaries in live telemetry — the model said so itself:

> turn-11: *"only snapshot information for servers 1 and 2 is visible"*

and on turns 12–13 it re-derived and re-emitted an identical
`record_reading{circuit:1, r1_r2_ohm:0.22}` after the inspector re-dictated it, because the
earlier write had rotated out of its view.

**The fix already exists and is unused.** `CIRCUIT_ORDER = 'ascending'`
(`eicr-extraction-session.js:1501-1510`, renderer at `:4146-4148`) iterates every circuit on the
active board in full detail with no hidden-summary line. Its docstring claims a second benefit:
under `split_blocks` it makes the EXTRACTED block **append-only**, so the volatile tail stops
reshuffling as the inspector moves between circuits.

**Both claims are untested.** Treat them as hypotheses:

1. *Cache-prefix preservation* — plausible from the code, never benched or field-tested. §1's
   telemetry can settle it directly: cached-token counts per round under each mode.
2. *Token growth* — `ascending` renders **every** circuit in full detail, so the snapshot grows
   linearly with installation size. On a 30-circuit board that is a large volatile tail on every
   round. Against §2.4's open question about prefill cost, a bigger prompt could **cost more
   latency than the round it saves.** This must be measured on a realistic circuit count, not on
   a 4-circuit fixture.

There is also a middle option nobody has priced: **raise `SNAPSHOT_RECENT_CIRCUITS`** and keep
`recent_3`'s rotating window. It gets most of the visibility for a bounded token cost and does
not depend on the append-only claim being true.

Note for whoever executes: `CIRCUIT_ORDER` is pinned in the field-replay environment loader
(`scripts/field-replay/replay-environment.mjs:49`) precisely because *config divergence is prompt
divergence*. Changing the default changes replay semantics; the corpus pins must move with it, in
the same commit.

## What this plan is NOT

- **Not a cost-reduction plan.** Plan 01 already took the cost win; cache hit rate is 100 %. If a
  change here happens to cut tokens, that is a side effect to report honestly, not a
  justification.
- **Not a prompt-shrinking exercise.** See the evidence section.
- **Not a licence to reduce rounds by making the model less careful.** A turn that finishes faster
  by skipping the round in which it verifies its own write is a correctness regression wearing a
  latency plan's clothes.
- **Not authorised to touch the audio-first invariants.** Every applied dictated reading is spoken
  exactly once; structurally complete readings are written regardless of confidence; speculative
  and cancelled work is never spoken or written; `wrong_board` and every other rejection stays
  audible.

## Interaction with Plan 07 and Plan 02

**Plan 07's verdict changes this plan's value and must land first.** Loaded Barrel starts TTS
from the streamed round-0 tool call, which — if it works — already hides much of round 2 from the
inspector. If it genuinely hides it, §3's round-count work is worth materially less than the
histogram suggests. If it does not, §3 rises. The Plan 07 within-turn counterfactual is
outstanding at the time of writing; **do not execute §3 before reading it.**

**Phase 1 re-scopes Plan 02 either way.** Incremental TTS pays only for time the model spends
*streaming*. If §1.2 shows the round is mostly front-loaded silence, Plan 02's ceiling is far
lower than the wave assumed, and it should be re-argued before it gets a full dual-reviewer
cycle. This is the strongest argument for running Plan 08 Phase 1 before Plan 02, which is the
order Derek set on 2026-08-10.

## Web companion

**No web companion required for Phase 1** (additive backend telemetry; nothing crosses the WS or
HTTP boundary, no wire shape changes, no user-visible behaviour on either client).

Phases 2 and 3 are also expected to be backend-only and wire-neutral — a faster or shorter tool
loop is invisible to both clients. **But §3.1 option (b) changes which tool calls are accepted**,
which changes which spoken notices a user hears, and that IS client-visible behaviour. If §3.1(b)
is chosen, this plan needs a real Web-companion section or a dated `web/docs/parity-ledger.md`
row with a named owner before it converges. Do not let it converge with this paragraph as the
answer.

## Acceptance

- **Phase 1:** zero behaviour change, proven by the field-replay corpus staying semantically
  identical and full backend Jest green. New telemetry fields carry no prompt text, transcript,
  address, board value or other PII — round-scoped ids, counts and timings only.
- **Phase 2/3:** each lever flagged and rollback-able **independently**, so its effect is
  attributable — the same rule Plan 03 imposes on connection reuse versus voice settings, and for
  the same reason.
- Report p50/p75/p95 with sample counts, split by reading versus question and by round count.
  **Report the sample size honestly** — the analysis behind this plan rests on 15–41 observations
  from four sessions, which is enough to locate the bottleneck and not enough to certify a 10 %
  improvement.
- Tool-loop, reasoning-continuity, cancellation, usage-accounting and audibility suites stay
  green. Field-replay gate green, with corpus pins updated in the same commit as any config
  default change.

```bash
npm test -- --runInBand src/__tests__/stage6-tool-loop.test.js
npm test -- --runInBand src/__tests__/openai-responses-adapter.test.js
npm run replay:field-corpus:prepush
npm test
```

## Rollout and rollback

Every flag lives in `ecs/task-def-backend.json` and the replay-environment pins — **never edited
on the live task definition** (hub rule; `scripts/check-task-def-env-drift.sh` fails the deploy
otherwise). Rollback is a source change merged through CI. Update
`docs/reference/architecture.md` and `changelog.md` if anything ships.

## Reviewer pressure points

- Is §1.2's front-loaded-silence hypothesis actually measured, or has the adapter docstring's
  assertion been quietly promoted to a fact?
- Does any effort below `'low'` degrade `end_turn` termination on **multi-round** shapes, not just
  the single-call fast path?
- Does `CIRCUIT_ORDER=ascending` preserve the cache prefix in practice, and does its token growth
  on a realistic circuit count cost more latency than the round it saves?
- Does any §3.1 change make a rejection silent? Any path that turns `wrong_board` back into a
  silent drop re-creates the 2026-08-06 field bug and fails outright.
- Can `'*'` reach a gated mutator as anything other than a rejection?
- Are latency gains from this plan separable from Loaded Barrel, Plan 02 and Plan 03, or would a
  combined deploy make all three unattributable?
- Is any conclusion resting on `dispatch_ms` values that include an `ask_user` human wait?
