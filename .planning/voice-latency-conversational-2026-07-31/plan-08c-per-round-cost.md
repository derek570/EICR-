# Plan 08C — Per-round cost levers

Status: **UNPARKED 2026-08-11 — the blocking field session has run (session `8B9B2BDD`,
`eicr-backend:393`, past the `:388+` revision gate below). Its three-item unblocking checklist
still needs independent confirmation before this plan's `/rp` opens — see below.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

**Do not open this plan's `/rp` until the checklist below is independently confirmed against
session `8B9B2BDD`.** Every item below is a hypothesis of the form *"if 08A's data shows X, then
Y"*, and 08A's data now exists — but confirming the checklist (revision, `api_transport` split,
`round_idx` keying) is a precondition for trusting it, not a formality. This is a `/rp`-opening
gate, not a re-park: with the checklist confirmed, 08C also inherits 08D's closure (§7
deliverable 3 of [Plan 08D](plan-08d-terminal-round-release.md)) — 08D ships no runtime
early-release mechanism, and the terminal round's shrink/eliminate-round lever now belongs
entirely to this plan. See the "Inherited from 08D" subsection under Acceptance below.

Split out of [Plan 08B](plan-08b-stage6-round-levers.md) on 2026-08-10 so 08B's §2.0/§2.1 could be
refined immediately instead of waiting behind four items nobody can yet evaluate. See § Seam below
for what the split deliberately keeps together and what it gives up.

## Unblocking condition — precise, so it is checkable

One ordinary dictation walk on a build at **`eicr-backend:388` or later**. No special script and no
protocol; an ordinary session is exactly the right shape. Then confirm, before trusting any of it:

1. **The revision is right.** A session on `:387` or earlier simply has no `reasoning_tokens` /
   `first_tool_use_ns` keys. That reads as *"the field didn't populate"* when it actually means
   *"the build predates the field"* — an easy and expensive misreading.
2. **Split on `round_usage[].api_transport` before computing anything.** The streaming Responses
   adapter and the buffered chat-completions adapter mean different things by `first_tool_use_ns`:
   a first-emission stamp on one, an approximate response-*completion* stamp on the other. Pooling
   them reads a transport artefact as a model regression.
3. **Do not zip the per-round arrays by position.** `toolCallCountPerRound` /
   `toolErrorCountPerRound` are not in lockstep with `actualStopReasonPerRound`
   (`stage6-tool-loop.js`). They were already out of lockstep before 08A, so nothing is broken —
   but 08A's timing rows carry `round_idx` deliberately. Key on that.

## The target

From four live Luna field sessions (2026-08-06/07):

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| Per-round Luna `stream_ms` | 41 rounds | **3.22 s** | 5.46 s | 9.04 s |

Round 0 spends ~3.8 s to emit ~101 output tokens over a prefix that costs nothing to load (Plan 01:
a cold 34,794-token prefill is **89 ms faster** than a warm one). So the time is going somewhere
inside the round that we could not see — which is exactly what 08A was built to expose.

## §1 — Per-round stream time

### 1.1 Reasoning effort

`reasoning.effort` resolves to `'low'` (`openai-responses-adapter.js:545-554`), and
`OPENAI_EXTRACT_REASONING_EFFORT` is **unset** in `ecs/task-def-backend.json` — so `'low'` is a
default that fell out, not a considered choice.

If 08A shows reasoning tokens dominate output tokens, this is the largest lever in the plan and
costs one env var.

**Corrected 2026-08-10 (08B round-1 cross-check): it is not one env var, and the adapter is not the
authority.** The adapter's `?? process.env.OPENAI_EXTRACT_REASONING_EFFORT ?? 'low'` is a *fallback
for callers that thread nothing* (the cache-keepalive `create()` path). The live authority is
`resolveOpenAIReasoningEffort` (`stage6-shadow-harness.js:338-349`), threaded at `:1640`. It
resolves three ways, and a change aimed at one leaves the others untouched:

| Path | Source | Default |
|---|---|---|
| Responses, ordinary turn | `OPENAI_EXTRACT_REASONING_EFFORT` | `'low'` |
| Responses, **observation** turn | `OPENAI_OBSERVATION_REASONING_EFFORT` | `'low'` |
| **chat_completions** (any turn) | `OPENAI_EXTRACT_REASONING_EFFORT` | `'none'` |

So: the ordinary-turn conclusion stands, observation turns need the *second* variable, and the
chat-completions path is pinned to `'none'` by design — function tools plus any non-`'none'` effort
draw an HTTP 400 there (`openai-responses-adapter.js:9-12`). Any probe must state which of the
three it moved, and 08A's `api_transport` split is what makes that checkable.

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

> **Interaction with Plan 08D — settled 2026-08-11.** Both touch termination, and this item makes
> the model worse at deciding it is done. [Plan 08D](plan-08d-terminal-round-release.md) closed
> docs-only: it ships **no** runtime early-release mechanism (the transport has no trustworthy
> pre-completion no-tool signal, and four prior mechanism shapes already died in production or
> review), so the terminal round is **not** being removed by 08D. The hazard above therefore
> stays exactly as sharp as it reads — any effort-below-`'low'` probe under this item still owns
> the full termination risk, undiluted by a since-abandoned 08D mechanism.

### 1.2 `VOICE_LATENCY_ROUND1_MODEL` — shipped, wired, currently empty

`stage6-tool-loop.js:431` and `:511-518` implement a live-read round-1 model override; the task def
sets it to `""` (`ecs/task-def-backend.json:49`). It was built 2026-05-28 for Sonnet 4.6 → Haiku,
on the same diagnosis this plan reaches for Luna: round 1 is the dominant cost.

Constraints already enforced in code, which bound what may be proposed:

- `assertSameProvider(model, configuredRound1Override)` at `:433` — an OpenAI base model may only
  be overridden by another OpenAI model. Cross-provider is rejected before the first dispatch,
  **deliberately**: OpenAI's encrypted reasoning blocks would otherwise reach an SDK that cannot
  read them. Do not design a path around this fence.
- Observation-tier turns pass `allowRound1ModelOverride: false`
  (`stage6-shadow-harness.js:1708`, `allowRound1ModelOverride: !round1OverrideLocked` — the lock is
  *declared* around `:1645`, but `:1645-1647` is the comment, not the argument), pinning a
  deliberate Terra escalation across all rounds.

The open question is narrow and empirical: **is there a same-provider model materially faster than
Luna Fast at emitting one correct `record_reading`?** Luna is already the fast tier. If the answer
is no, say so and close the item.

### 1.3 Output size is not a lever; actual tokens are

`max_output_tokens` is `max((max_tokens||4096) * 4, 8192)` (`:544`) — a **ceiling, not a cost**.
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

## §2 — Prompt snapshot size

### 2.1 `SNAPSHOT_RECENT_CIRCUITS = 3` — confirmed to cause re-derivation

*(Was §2.2 in Plan 08B. It moved here rather than staying with the round-count levers because its
first hypothesis is settled by 08A's cached-token counts, and its second is priced against §1.4
directly above — it belongs with the cost items, not the count items.)*

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
   per-round cached-token counts settle it directly. **This is the 08A dependency that parks this
   item.**
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

## Seam — what the split keeps and what it gives up

**Kept together deliberately.** §1.4 (does a big cached prefix cost latency) and §2.1 (a change
that makes the prefix bigger) are the same question asked from two directions. Splitting *those*
apart would have been the wrong seam — one plan would propose growing the prompt while the other
priced the cost of a grown prompt, and neither would own the contradiction.

**Given up by the split, and therefore stated here.** 08B reduces the *number* of rounds; this plan
reduces the *cost of each*. They multiply, so:

- **Neither plan's win may be claimed from a deploy containing both.** Whichever ships second must
  re-baseline against the first, not against the pre-08B numbers. 08B's Seam section carries the
  matching note, and both plans' Acceptance sections require naming which baseline each number is
  against.
- **08D closed docs-only and ships no runtime mechanism (2026-08-11); §1.1's termination hazard is
  therefore undiluted, not moot.** The terminal round is not being removed by 08D — the
  shrink/eliminate-round lever transfers to this plan in full. §1.1's inline note carries the
  settled interaction; nothing here is still pending 08D.

## What this plan is NOT

- **Not a cost-reduction plan.** Cache hit rate is 100 %; Plan 01 took the cost win. A token saving
  here is a side effect to report honestly, never a justification.
- **Not a prompt-shrinking exercise.** The prompt is cached and is not the bottleneck.
- **Not a licence to reduce latency by making the model less careful.** A turn that finishes faster
  by skipping the reasoning in which it verifies its own write is a correctness regression wearing
  a latency plan's clothes.
- **Not authorised to touch the audio-first invariants.** Every applied dictated reading is spoken
  exactly once; structurally complete readings are written regardless of confidence; speculative
  and cancelled work is never spoken or written; every rejection stays audible.

## Web companion

Backend-only and wire-neutral throughout — reasoning effort, round-1 model choice and prompt
snapshot size are all invisible to both clients. No web companion required, and no parity-ledger
row. If any item mutates into something client-visible during refinement, that assessment must be
redone rather than inherited from this line.

## Acceptance

### Inherited from 08D (§7 deliverable 3 — transferred verbatim on 08D's docs-only closure, 2026-08-11)

[Plan 08D](plan-08d-terminal-round-release.md) closed with no runtime early-release mechanism; the
terminal round's shrink/eliminate-round lever, its replication gate, and the acceptance
preconditions the combined 08B plan originally carried for this lever all transfer here in full,
per 08D §7 deliverable 3.

**Replication gate — quoted verbatim from 08D §2** (the self-references to "08C" below are 08D's
own wording; 08D §2's closing sentence explicitly names this transfer: *"This gate transfers into
08C's acceptance section as part of §7's deliverables"*):

> **Replication gate — decided (round 1), ✅ owner-confirmed 2026-08-11:** the single session is
> sufficient for THIS plan's no-runtime closure (§7). Any *future* behaviour-changing
> terminal-round optimisation (e.g. under 08C) may be implemented dark, but must not be
> **activated** — nor claim a latency saving — until at least one independent ordinary field
> session on a compatible revision reproduces the qualitative TTFT-dominated terminal-round shape.
> Exact 17 % / 34 % replication is NOT required; what is required is that all observed
> thinking-terminal rounds remain correct and audible. This gate transfers into 08C's acceptance
> section as part of §7's deliverables.

("THIS plan" above refers to 08D, whose no-runtime closure needed only the single session
`8B9B2BDD` / `eicr-backend:393`, 12 turns; the activation bar the quote states binds *this* plan.)

**Four acceptance preconditions — quoted verbatim from 08D §8** (again, "08C" below is 08D's own
self-reference — these bullets were authored anticipating exactly this transfer):

> - **A nanosecond audio-ready stamp exists and is populated before any saving is claimed.**
>   `audible_first_byte_ms` is null on 100 % of turns today. **Do not implement it from the
>   combined plan's original recipe — that recipe was wrong** (round-2 BLOCKER #4): the field is a
>   hardcoded `null` literal at `stage6-shadow-harness.js:4285-4286`, not an unpopulated allowlist
>   entry, so adding it to `attributeRoundUsage`'s allowlist would change nothing while looking
>   correct. The real sites are `recordOutcome`'s `meta` in `loaded-barrel-speculator.js:~1010`
>   and the harness literal itself.
> - **Barrel HIT and MISS cohorts reported separately, never blended.** The mechanism differs
>   (serve parked audio vs start synthesis earlier) and so does the win. Authoritative miss-rate:
>   **22 %** (Plan 07's doubly-reconfirmed 78/22; an earlier 08B round-1 sample read 37 % —
>   superseded, see §5 point 3) — and 08B's round 2 established the MISS cohort may get *nothing*
>   from this lever through the current wire path, so blending the two would manufacture a saving
>   that does not exist for roughly a fifth of turns.
> - **Plan 06 (conversational lane, `.planning/voice-latency-conversational-2026-07-31/plan-06-general-conversational-lane.md`)
>   has a GO and touches the same tool loop.** 06 changes what the
>   model is expected to *say*; this lever changes when the human stops waiting for it. **Re-read
>   06 before 08C selects or details a terminal-round mechanism, not after** — and whichever ships
>   second re-baselines against the first, not against the pre-08B numbers.
> - **The 08C §1.1 interaction is SHARPER here, not moot.** A reasoning model with reasoning
>   turned down may fail to cleanly `end_turn`; under a release-before-loop-return design it then
>   burns round cap and cost *after* the inspector has been released and moved on. Today that
>   failure is at least audible as a long silence. Re-read 08C §1.1 against any terminal-round
>   mechanism 08C selects before probing effort below `'low'`.

(§5 point 3 above is 08D §5's round-2 finding on the barrel-miss cohort; "08C §1.1" and "08C
selects" above are 08D's own self-references — these bullets already anticipated landing here,
since "08C §1.1" is §1.1 of *this* document.)

**Non-negotiable invariants (08D §9), verbatim, binding whatever this plan eventually ships:**

> The audio-first invariants hold: every applied dictated reading is spoken **exactly once** — not
> zero, not twice; structurally complete readings are written regardless of self-reported
> confidence; speculative and cancelled work is never spoken or written; every rejection stays
> audible. **Every forwarded turn for which the processing chime fired receives exactly one
> audible terminal response — including no-write, no-op, rejection, timeout, cancellation,
> cap-hit, reconnect, and thinking-terminal paths; no early release or terminal-round optimisation
> may ever cancel or suppress that fallback.** A design that speaks earlier by speaking twice is a
> regression wearing a latency plan's clothes. A corrective follow-up arriving after release would
> have to be spoken as an **explicit correction** that references and supersedes what was already
> said — which is very likely a **new wire shape**, and therefore a MANDATORY Web-companion
> trigger, not a backend-only change.

### This plan's own acceptance

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
- If 08B has already shipped, the baseline is post-08B. Say which baseline every number is against.

## Reviewer pressure points

- **Is 08A's data actually in hand, and has the three-item checklist been independently confirmed
  against it?** Session `8B9B2BDD` (`:393`) discharged the field-session precondition, but the
  checklist (revision `:388+`, `api_transport` split, `round_idx` keying) is a separate,
  still-open confirmation step (see Status). If a claim here has been promoted from hypothesis to
  fact on the strength of a docstring rather than a measurement, that is the finding.
- Was the data split on `api_transport` before any distribution was computed?
- Does any effort below `'low'` degrade `end_turn` termination on **multi-round** shapes?
- Does `CIRCUIT_ORDER=ascending` preserve the cache prefix in practice, and does its token growth
  on a realistic circuit count cost more than the round it saves?
- Are gains here separable from 08B, Loaded Barrel, Plan 02 and Plan 03, or would a combined deploy
  make all of them unattributable?
