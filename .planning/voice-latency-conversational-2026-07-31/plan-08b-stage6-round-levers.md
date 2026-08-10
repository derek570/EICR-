# Plan 08B — Stage-6 round-efficiency levers

Status: **HELD (2026-08-10). Do not open `/rp` on this yet.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
Blocked on **both**:

1. **[08A](plan-08a-stage6-round-instrumentation.md) shipped, deployed, and one field session run
   on it.** Every lever below is selected by data 08A produces. Reviewing them now would spend
   rounds arguing about unmeasured quantities.
2. **[Plan 07](plan-07-loaded-barrel-value-audit.md)'s keep/narrow/retire verdict.** If Loaded
   Barrel genuinely hides round 2 from the inspector, §2 below is worth materially less than the
   round histogram suggests.

Split from a single Plan 08 on 2026-08-10 so 08A could ship immediately instead of waiting behind
a review of levers nobody could yet choose between.

## The target

From four live Luna field sessions (2026-08-06/07), perceived latency is near enough
**round count × per-round stream time**:

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| Per-round Luna `stream_ms` | 41 rounds | **3.22 s** | 5.46 s | 9.04 s |
| Turn perceived latency | 15 turns | **6.76 s** | 15.86 s | — |

Round histogram (28 turns): 2 ×21 (75 %), 3 ×5 (18 %), 4 ×2 (7 %).

Two levers, **unequal in value**:

- **§1 per-round stream time attacks 100 % of turns** — the whole p50 story.
- **§2 round count attacks the 25 % tail** — most of the p95 story.

## §1 — Per-round stream time

### 1.1 Reasoning effort

`reasoning.effort` resolves to `'low'` (`openai-responses-adapter.js:540-542`), and
`OPENAI_EXTRACT_REASONING_EFFORT` is **unset** in `ecs/task-def-backend.json` — so `'low'` is a
default that fell out, not a considered choice.

If 08A shows reasoning tokens dominate output tokens, this is the largest lever in the plan and
costs one env var.

**Hazard, recorded so nobody rediscovers it the hard way.** The adapter docstring
(`openai-responses-adapter.js:9-18`) documents that forcing `reasoning='none'` on the Chat
Completions adapter produced *"a reasoning model with its reasoning switched off"* — Luna looped
on tool calls instead of emitting a clean `end_turn`, **because a reasoning model without
reasoning cannot decide it is done.** A loop that never terminates is worse than a slow one: it
burns the round cap, costs more, and delays the read-back further.

Therefore: probe any effort below `'low'` against the **real tool schema** on the Responses API,
and require clean `end_turn` on **multi-round** shapes — not just the trivial single-call turn. If
termination degrades at all, stop. The shipped `'low'` is then correct and should be recorded as
a considered choice rather than left as an unexamined default.

### 1.2 `VOICE_LATENCY_ROUND1_MODEL` — shipped, wired, currently empty

`stage6-tool-loop.js:431` and `:481-488` implement a live-read round-1 model override; the task def
sets it to `""` (`ecs/task-def-backend.json:49`). It was built 2026-05-28 for Sonnet 4.6 → Haiku,
on the same diagnosis this plan reaches for Luna: round 1 is the dominant cost.

Constraints already enforced in code, which bound what may be proposed:

- `assertSameProvider(model, configuredRound1Override)` at `:433` — an OpenAI base model may only
  be overridden by another OpenAI model. Cross-provider is rejected before the first dispatch,
  **deliberately**: OpenAI's encrypted reasoning blocks would otherwise reach an SDK that cannot
  read them. Do not design a path around this fence.
- Observation-tier turns pass `allowRound1ModelOverride: false`
  (`stage6-shadow-harness.js:1645-1647`), pinning a deliberate Terra escalation across all rounds.

The open question is narrow and empirical: **is there a same-provider model materially faster than
Luna Fast at emitting one correct `record_reading`?** Luna is already the fast tier. If the answer
is no, say so and close the item.

### 1.3 Output size is not a lever; actual tokens are

`max_output_tokens` is `max((max_tokens||4096) * 4, 8192)` (`:532`) — a **ceiling, not a cost**.
It must not be presented as a latency lever. *Emitted* tokens are, and 08A's `reasoning_tokens`
split is what makes them attributable.

### 1.4 Does a 35 k cached prefix still cost latency?

Cache hit rate is 100 % and cost is solved, but a cached prefix is not a free prefill. If 08A's
`started_ns → first_tool_use_ns` span shows a large fixed floor on tool-emitting rounds independent
of output size, this becomes real. End-turn-only rounds stay opaque under 08A's stated limitation.
It is explicitly **not** a cost question — Plan 01 closed that — and must not be allowed to re-open
one.

> Corrected 2026-08-10 at 08A review round 2: this section previously referenced a `first_token_ns`
> field. 08A **dropped** that field — the Responses adapter yields a synthetic `message_start`
> before reading provider SSE (`openai-responses-adapter.js:353`), so a first-event stamp would have
> read ≈0 ms every round. `first_tool_use_ns` is the honest marker.

## §2 — Round count

### 2.1 The `board_id` vocabulary gap — verified, same class as the shipped `'main'` fix

Two live rounds were spent on validator rejections of `board_id: 'current'` and `board_id: '*'`.
Mechanism verified in source:

- `validateBoardScope` (`stage6-dispatch-validation.js:719-731`) rejects any supplied `board_id`
  not string-equal to `currentBoardId`. There is no alias vocabulary.
- `normaliseBoardScopeInput` (`stage6-multi-board-shape.js:121-140`) canonicalises exactly two
  things: the empty string, and `'main'` under the three conjunctive conditions added 2026-08-06.
  `'current'` is handled nowhere. `'*'` is passed through untouched (`:80-81`) because it is the
  `set_field_for_all_circuits` broadcast — correct only on the tools exempt from
  `validateBoardScope` (`:704-705`), and a guaranteed rejection anywhere else.
- The tool schema (`stage6-tool-schemas.js:254`) says *"There is no board id 'main'"* — a fix for
  the previous instance of this class, phrased as one blocked spelling rather than as the accepted
  vocabulary.

**This is the same failure class as the 2026-08-06 field bug** — the model reaches for a natural
word meaning "the board I am on", the validator rejects it, a round burns. That wave fixed one
word. The class is open.

Preferred shape: state the accepted vocabulary **positively** instead of enumerating blocked
spellings one field incident at a time. Two candidate mechanisms; pick one, do not do both:

- **(a) Schema/prompt only** — say what IS accepted ("omit it, or the exact id from the BOARDS
  section"). Cheapest, zero mutation risk, relies on model compliance.
- **(b) Normaliser alias** — extend `normaliseBoardScopeInput` to canonicalise `'current'` the way
  `''` is canonicalised, to ABSENT, the one unscoped spelling every downstream reader already
  agrees means `currentBoardId`. Deterministic, but widens a security-adjacent surface and must
  inherit the `'main'` fix's conjunctive discipline.
  **`'*'` must NOT be aliased on gated tools** — a broadcast silently retargeted at one board would
  corrupt the certificate. Rejecting it is correct; it need only reject *audibly*, which the
  `wrong_board` partial-failure family (2026-08-06) already provides.

Invariant either way: **`wrong_board` speaks.** Whatever is not accepted must be audible, never
silently dropped. That is the entire lesson of 2026-08-06 and this plan must not regress it.

### 2.2 `SNAPSHOT_RECENT_CIRCUITS = 3` — confirmed to cause re-derivation

`SNAPSHOT_RECENT_CIRCUITS = 3` (`eicr-extraction-session.js:111`) with
`CIRCUIT_ORDER = 'recent_3'` (`ecs/task-def-backend.json:54`) renders only the last three circuits
in detail and summarises the rest as *"N earlier circuits (…) stored server-side"* (`:4149-4157`).

Confirmed from the model's own reasoning summaries in live telemetry:

> turn-11: *"only snapshot information for servers 1 and 2 is visible"*

and on turns 12–13 it re-derived and re-emitted an identical
`record_reading{circuit:1, r1_r2_ohm:0.22}` after the inspector re-dictated it, because the earlier
write had rotated out of view.

**The fix exists and is unused.** `CIRCUIT_ORDER = 'ascending'`
(`eicr-extraction-session.js:1501-1510`, renderer `:4146-4148`) renders every circuit on the active
board in full detail with no hidden-summary line, and its docstring claims a second benefit: under
`split_blocks` the EXTRACTED block becomes **append-only**, so the volatile tail stops reshuffling
as the inspector moves between circuits.

**Both claims are untested. Treat them as hypotheses:**

1. *Cache-prefix preservation* — plausible from the code, never benched or field-tested. 08A's
   per-round cached-token counts settle it directly.
2. *Token growth* — `ascending` renders **every** circuit in full detail, so the snapshot grows
   linearly with installation size. On a 30-circuit board that is a large volatile tail every
   round, and against §1.4 a bigger prompt could **cost more latency than the round it saves.**
   Measure on a realistic circuit count, not a 4-circuit fixture.

There is also a middle option nobody has priced: **raise `SNAPSHOT_RECENT_CIRCUITS`** and keep
`recent_3`'s rotating window. Most of the visibility, bounded token cost, and no dependence on the
append-only claim being true.

Execution note: `CIRCUIT_ORDER` is pinned in the field-replay environment loader
(`scripts/field-replay/replay-environment.mjs:49`) precisely because *config divergence is prompt
divergence*. Changing the default changes replay semantics; the corpus pins move in the same
commit.

## What this plan is NOT

- **Not a cost-reduction plan.** Cache hit rate is 100 %; Plan 01 took the cost win. A token saving
  here is a side effect to report honestly, never a justification.
- **Not a prompt-shrinking exercise.** The prompt is cached and is not the bottleneck.
- **Not a licence to reduce rounds by making the model less careful.** A turn that finishes faster
  by skipping the round in which it verifies its own write is a correctness regression wearing a
  latency plan's clothes.
- **Not authorised to touch the audio-first invariants.** Every applied dictated reading is spoken
  exactly once; structurally complete readings are written regardless of confidence; speculative
  and cancelled work is never spoken or written; every rejection stays audible.

## Web companion

§1 and §2.2 are backend-only and wire-neutral — a faster or shorter tool loop is invisible to both
clients.

**§2.1 option (b) is not.** It changes which tool calls are accepted, therefore which spoken
notices a user hears, therefore client-visible behaviour. If (b) is chosen, this plan needs a real
Web-companion section or a dated `web/docs/parity-ledger.md` row **with a named owner** before it
converges. This paragraph is not that row.

## Acceptance

- Each lever flagged and rollback-able **independently**, so its effect stays attributable — the
  same rule Plan 03 imposes on connection reuse versus voice settings, for the same reason.
- Report p50/p75/p95 with sample counts, split by reading versus question and by round count.
  **Report sample size honestly**: the analysis behind this plan rests on 15–41 observations from
  four sessions — enough to locate a bottleneck, not enough to certify a 10 % improvement.
- Tool-loop, reasoning-continuity, cancellation, usage-accounting and audibility suites green.
  Field-replay gate green, with corpus pins updated in the same commit as any config default
  change.
- No conclusion rests on a `dispatch_ms` value that includes an `ask_user` human wait (08A fixes
  the metric; this plan must actually use the fixed one).

## Reviewer pressure points

- Is 08A's data actually in hand, or has the front-loaded-silence hypothesis been promoted to a
  fact on the strength of a docstring?
- Does any effort below `'low'` degrade `end_turn` termination on **multi-round** shapes?
- Does `CIRCUIT_ORDER=ascending` preserve the cache prefix in practice, and does its token growth
  on a realistic circuit count cost more than the round it saves?
- Does any §2.1 change make a rejection silent? Any path that turns `wrong_board` back into a
  silent drop re-creates the 2026-08-06 field bug and fails outright.
- Can `'*'` reach a gated mutator as anything other than a rejection?
- Are gains here separable from Loaded Barrel, Plan 02 and Plan 03, or would a combined deploy make
  all of them unattributable?
