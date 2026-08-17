# Plan 08C-A — Per-round cost levers (config probes + prefix/snapshot pair)

Status: **SHIPPED 2026-08-17 (PR #189) — §2.1 verdict: NO ARM WINS, keep `recent_3`** (ascending
+0.9 %, window_6 +3.7 %, both under the +10 % bar; eviction duplicate-write causality REFUTED;
benchmark harness + analyzer delivered dark, `SNAPSHOT_RECENT_CIRCUITS` unchanged). Split out of
the combined 08C at the round-1 walkthrough (Derek, 2026-08-11, Option A). This chunk owned the
config-lever probes (§1.1 effort — CLOSED on documented evidence; §1.2 round-1 model — CLOSED)
and the §1.4+§2.1 prefix/snapshot pair. The inherited terminal-round shrink/eliminate lever, its
replication gate, and the 08D acceptance apparatus live in the sibling
[08C-B](plan-08c-b-terminal-round.md), which chained after this plan's merge (its `/ep` ran
2026-08-17; closure proposed and HELD — see its banner).
The /rp-opening gate was discharged 2026-08-11: the three-item checklist was independently
confirmed against session `8B9B2BDD`'s CloudWatch telemetry (12 `voice_latency.turn_core_summary`
rows, log group `/ecs/eicr/eicr-backend`). One correction from that confirmation: **the session
ran on `eicr-backend:392`, not `:393`** as previously recorded here and in the changelog — the
task log stream (`ecs/eicr-backend/ce6745e5…`) was created 05:55:03 UTC, two minutes after
`:392`'s registration (05:53:10 UTC) and 1 h 41 m before `:393`'s (07:36:41 UTC), and all 12
turns ran 06:09:07–06:13:08 UTC on that task. `:392 ≥ :388`, so the revision gate passes
unchanged; every future reference to this session should say `:392`.
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

## Review protocol (binding for this plan's refine + execution cycle)

- **Internal reviewer:** Claude **Sonnet** at high effort, agent type `certmate-plan-reviewer`.
  **External reviewer:** Codex `gpt-5.6-sol` at high reasoning effort. **Never downgrade either**
  — a lesser model scored 0/9 on known findings, twice. No Claude-only rounds: a Codex hard
  failure aborts the run; a Codex usage limit waits for reset.
- **Codex prompt hygiene (learned on 08D, two burned attempts):** reviewer prompts must open with
  a read-only / do-not-load-local-skills-or-workflows instruction, must not contain the literal
  refine-skill invocation token, and must pass `outputLastMessage` so the final JSON survives log
  overflow. An empty-findings return wrapped in narration is a dead lens, not a clean round.
- **Sibling cross-referencing (batch mode):** every review round receives [08C-B](plan-08c-b-terminal-round.md) as
  an input; round 1 of each chunk must ask *"what did the split lose — which deliverable does NO
  sibling own?"*
- **Cap behaviour:** if the round cap is reached, report back — do **not** force execution.
- **Churn circuit-breaker:** three consecutive rounds of BLOCKERs concentrated in one subsystem →
  stop patching and attack the premise.

## Resolved decisions (round-1 walkthrough, Derek, 2026-08-11)

- **Split ✅ Confirmed 2026-08-11 (Option A):** this chunk (config probes + prefix/snapshot pair)
  ships first; the terminal-round mechanism is PLAN-B, chained second, re-baselining against
  whatever this chunk ships. §1.4+§2.1 stay together (see § Seam).
- **§1.1 ✅ Confirmed 2026-08-11 — bounded probe → terminated at step zero, CLOSED (round 3).**
  Derek confirmed a bounded probe; round 3 then surfaced that the only below-`'low'` candidate,
  Responses `'none'`, is ALREADY documented in-repo as a production regression
  (`stage6-shadow-harness.js:1618-1631` and `src/__tests__/plan00-reasoning-effort.test.js:14-19`
  both state *"'none' on Responses reproduces the documented Luna reasoning-off looping"*, pinned
  by the unset-env default-parity tests). The probe's own predeclared bar — *"if termination
  degrades at all, stop and record `'low'` as the considered choice"* — resolves on that
  documented evidence without a run. §1.1 is CLOSED: `'low'` (via the unset default) is the
  considered choice. See §1.1 for the surviving hardening deliverable.
- **§1.2 ✅ Confirmed 2026-08-11 — CLOSED:** no candidate bench this wave. The 5-part validation
  bar below stays recorded as the ready gate for any future candidate.
- **§2.1 ✅ Confirmed 2026-08-11 — all 3 benchmark arms:** `recent_3`, `ascending`, and the
  bounded-window middle option as an offline-only arm (no env wrapper is built unless it wins).

## Data foundation — checklist CONFIRMED 2026-08-11 (independent re-derivation from CloudWatch)

One ordinary dictation walk on a build at **`eicr-backend:388` or later**. Session `8B9B2BDD`
(full id `8B9B2BDD-22FB-45B0-91A9-C2C83CDA16AD`) satisfies it. Each item below carries its
confirmation, derived directly from the 12 `voice_latency.turn_core_summary` rows — not from
08D's analysis:

1. **The revision is right — ✅ CONFIRMED, with a label correction.** The session ran on
   **`:392`** (not `:393` — see Status for the log-stream/registration timeline). `:392 ≥ :388`,
   and the 08A keys (`reasoning_tokens`, `first_tool_use_ns`, `blocking_ask_user_dispatched`,
   `round_usage[].api_transport`) are present AND populated on all 26 rounds of all 12 turns —
   the "build predates the field" misreading cannot apply.
2. **Split on `round_usage[].api_transport` before computing anything — ✅ CONFIRMED, single
   stratum.** All 26 rounds report `api_transport: "responses"` (provider `openai`, model
   `gpt-5.6-luna` requested-fast/billed-priority, `reasoning_effort: "low"`). Every
   `first_tool_use_ns` in this corpus is therefore a streaming first-emission stamp; the buffered
   chat-completions caveat is real but unexercised in this session — no pooling occurred and none
   was possible.
3. **Do not zip the per-round arrays by position — ✅ CONFIRMED, keyed on `round_idx`.** Both
   `round_timings[]` and `round_usage[]` carry explicit `round_idx`, contiguous `0..rounds-1` on
   every turn; all joins in the confirmation were keyed on it. Integrity cross-check:
   `first_tool_use_ns` is non-null **iff** the round dispatched ≥ 1 tool call — 26/26 rounds
   consistent.

**Confirmed headline numbers** (baseline: post-08B code on `:392`; n = 12 turns / 26 rounds; all
`turn_kind: "reading"`; every turn multi-round and terminating `end_turn`; single session, so all
ratios stay provisional under PLAN-B's replication gate):

- **Terminal round:** 10/12 turns show `reasoning_tokens: 0`, **exactly 4 output tokens**, 0 tool
  calls; terminal `stream_ms` p50 **1,267 ms** (min 789, max 3,477) — a round-trip floor, not
  generation. **2/12 (17 %) genuinely think** (turn 3: 11 reasoning / 17 output tokens; turn 9:
  29 / 35) — the provisional thinking-terminal ratio reproduces exactly. *(The terminal-round
  lever itself is PLAN-B's; the numbers are recorded here because this session is the shared data
  foundation.)*
- **Round 0:** `stream_ms` p50 2,651 ms (min 1,249, max 3,943); `reasoning_tokens` 0–69 (median
  31) against `output_tokens` 40–183 (median 78).
- **§1.4's measure now has a first number:** `started_ns → first_tool_use_ns` on tool-emitting
  rounds is p50 **2,460 ms** (n = 14, min 1,087, max 3,065) — 74–97 % of round-0 `stream_ms`.
- **`blocking_ask_user_dispatched` labels correctly:** turns 5/9/10 round 0 dispatched `ask_user`
  and carry 8.3–12.9 s of human wait in `dispatch_ms`; every non-ask round's `dispatch_ms` is
  ≤ 4 ms (n = 23). No conclusion in this plan rests on an ask-inflated `dispatch_ms`.
- **Cache (corrected round 7 — the prefix was written THREE times, not once):** turn 1 round 0
  wrote 35,129 tokens (`key_id 32f2de4e922e`, read by turns 2–6); turn 7 round 0 wrote 35,262
  tokens under a NEW key (`40649a705adb`, read by turns 8–11 — a stable-snapshot content change,
  plausibly turn 6's board work, rotated the key); turn 12 round 0 wrote 35,262 tokens under a
  third key (`71dbca6e02bc`). `fresh_input_tokens` 14–310. So the in-session prefix hit rate was
  **9/12 turns** (3 write turns: 1, 7, 12; 9 read turns: 2–6, 8–11), not 100 % — mid-session
  stable-content changes rotate the explicit key and re-pay the cache write. Consequence for
  §2.1's invariant check: compare `key_id` across ARMS per-turn — same turn, same key expected
  across arms — never assume one key per session.

## The target

From four live Luna field sessions (2026-08-06/07):

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| Per-round Luna `stream_ms` | 41 rounds | **3.22 s** | 5.46 s | 9.04 s |

Round 0 spends ~3.8 s to emit ~101 output tokens over a prefix that has near-zero incremental
**billable** input cost after the cache write — while its **latency** cost remained unmeasured
(Plan 01: a cold 34,794-token prefill is **89 ms faster** than a warm one, evidence that cache
billing and prefill latency are separate questions). So the time is going somewhere inside the
round that we could not see — which is exactly what 08A was built to expose, and what the
confirmed numbers above now show: on session `8B9B2BDD`, 74–97 % of round-0 `stream_ms` elapses
**before the first tool-call token is emitted**.

## §1 — Per-round stream time

### 1.1 Reasoning effort — CLOSED round 3: `'low'` is the considered choice, on documented in-repo evidence

`reasoning.effort` resolves to `'low'` (`openai-responses-adapter.js:545-554`), and
`OPENAI_EXTRACT_REASONING_EFFORT` is **unset** in `ecs/task-def-backend.json` — so `'low'` is an
**in-code fallback rather than an explicit ordinary-turn task-def pin**. It was NOT wholly
unconsidered: the adapter docstring (`openai-responses-adapter.js:8-19`) records a 2026-07-31 live
probe of Luna at `reasoning='low'` against the exact `record_reading` schema that resolved cleanly
— but that validated **API compatibility and clean termination on a single-round shape only**.
What has never happened is a comparative latency benchmark of effort levels, or an explicit
deployment pin. Keep that distinction in the decision criteria: "validated at `'low'`" ≠
"benchmarked as the right choice".

**Decision from session `8B9B2BDD`'s confirmed numbers (post-08B baseline, single session,
`responses` stratum only): reasoning tokens do NOT dominate — this is NOT the largest lever.**
Keyed on `round_idx`: round-0 `reasoning_tokens` median 31 (range 0–69) against round-0
`output_tokens` median 78 (range 40–183), and 74–97 % of round-0 `stream_ms` elapses before the
first tool-call token (`started_ns → first_tool_use_ns` p50 2,460 ms of `stream_ms` p50
2,651 ms). **The span's composition is unknown** — it blends queue/service delay, cached-prefix
processing, hidden reasoning, and generation up to the first tool item, and token counts alone
cannot allocate wall time among those. What the counts DO bound is this lever's upside: ≤ 69
reasoning tokens make reasoning one addend of the span, not its whole. Derek confirmed a bounded
probe at the round-1 walkthrough — and the probe terminated at step zero: the only below-`'low'`
candidate on this ladder, Responses `'none'`, is already **documented in-repo as a production
regression** (see the closure paragraph below). §1.1's predeclared bar — *"if termination
degrades at all, stop and record `'low'`"* — resolves on that documented evidence without a run.
**No effort comparison runs; the reasoning contribution to the span stays unattributed** (recorded
honestly in §1.4). Do not build further machinery on this lever.

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

**Hazard — now documented on BOTH transports, which is what closes the item.** The adapter
docstring (`openai-responses-adapter.js:9-18`) documents that forcing `reasoning='none'` on the
Chat Completions adapter produced *"a reasoning model with its reasoning switched off"* — Luna
looped on tool calls instead of emitting a clean `end_turn`, **because a reasoning model without
reasoning cannot decide it is done.** And the Responses side is NOT untested either:
`stage6-shadow-harness.js:1618-1631` and `src/__tests__/plan00-reasoning-effort.test.js:14-19`
both record, as live-operative behaviour pinned by the unset-env default-parity tests, that
*"'none' on Responses reproduces the documented Luna reasoning-off looping — so a single default
in either direction is a production regression."* A loop that never terminates is worse than a
slow one: it burns the round cap, costs more, and delays the read-back further.

**Closure (round 3):** the effort ladder below `'low'` on this model family is `'none'`, and
`'none'` is documented looping on BOTH transports. §1.1's predeclared bar resolves without a run:
**`'low'` — reached via the deliberately-unset env default — is recorded as the considered
choice.** No env var changes; no probe runs; re-probing a documented production regression
without new cause is exactly what the research-methodology rules forbid. (For any FUTURE effort
work: `OPENAI_EXTRACT_REASONING_EFFORT` is SHARED by Responses ordinary turns AND the
chat-completions fallback — `resolveOpenAIReasoningEffort`, `stage6-shadow-harness.js:338-349`,
chat path `|| 'none'` — so an explicit `'low'` pin would flip the chat fallback to a 400-drawing
config; any explicit non-`'none'` Responses value needs a new Responses-specific
variable/resolver.)

**Surviving hardening deliverable (ships with this plan regardless):** production now runs a
GPT extraction model, so the `openai_trial` exclusion of `OPENAI_EXTRACT_REASONING_EFFORT` and
`OPENAI_EXTRACT_API` (`scripts/field-replay/replay-environment.mjs:132`) is no longer safe — a
developer-shell value for either would silently alter replay semantics. Both variables are unset
in production (`ecs/task-def-backend.json` carries neither), so both move to
**`DELETED_SO_DEFAULTS_APPLY`** (`replay-environment.mjs:85-96` — replay deletes them so the code
defaults `'low'`-responses/`'none'`-chat and `responses` apply, matching production exactly).
NOT to `PINNED_FROM_TASK_DEF` — a PIN absent from the task def makes the loader throw
(`replay-environment.mjs:168-175`). Same commit: `REPLAY_ENV_INVENTORY_VERSION` (currently 6,
`:35`) incremented, `src/__tests__/field-replay/replay-environment.test.js` extended to assert
the deleted-class behaviour for both variables.

> **Interaction with PLAN-B — settled 2026-08-11.** Both touch termination, and this item makes
> the model worse at deciding it is done. Plan 08D
> (`.planning/voice-latency-conversational-2026-07-31/plan-08d-terminal-round-release.md` in the
> repo) closed docs-only: it ships **no** runtime early-release mechanism (the transport has no
> trustworthy pre-completion no-tool signal, and five release-before-completion shapes are dead —
> four historical precedents (08D §3) plus the "safe door" hypothesis independently disproved at
> the transport level within 08D's own refine cycle), so the terminal round is **not** being
> removed by 08D. The terminal-round lever now lives in [08C-B](plan-08c-b-terminal-round.md); PLAN-B must re-read
> this §1.1 against any mechanism it selects BEFORE probing effort below `'low'` in combination —
> the hazard here stays exactly as sharp as it reads.

### 1.2 `VOICE_LATENCY_ROUND1_MODEL` — CLOSED (✅ confirmed 2026-08-11); validation bar recorded

`stage6-tool-loop.js:431` and `:511-518` implement a live-read round-1 model override; the task def
sets it to `""` (`ecs/task-def-backend.json:49`). It was built 2026-05-28 for Sonnet 4.6 → Haiku,
on the same diagnosis this plan reaches for Luna: round 1 is the dominant cost.

**Decision (Derek, 2026-08-11): CLOSED for this wave.** Luna is already the fast tier and no
same-provider candidate is plausibly faster at round 1 today; no bench is run. The item closes
with the validation bar below recorded, so any future candidate faces a ready gate instead of a
re-derivation.

Constraints already enforced in code, which bound what may ever be proposed:

- `assertSameProvider(model, configuredRound1Override)` at `:433` — an OpenAI base model may only
  be overridden by another OpenAI model. Cross-provider is rejected before the first dispatch,
  **deliberately**: OpenAI's encrypted reasoning blocks would otherwise reach an SDK that cannot
  read them. Do not design a path around this fence.
- Observation-tier turns pass `allowRound1ModelOverride: false`
  (`stage6-shadow-harness.js:1708`, `allowRound1ModelOverride: !round1OverrideLocked` — the lock
  is declared at `:1648`, `const round1OverrideLocked = routeToObservationTier;`), pinning a
  deliberate Terra escalation across all rounds.

**Validation bar for any future candidate** (recorded because "faster at emitting one correct
`record_reading`" is NOT sufficient — the override changes model mid-conversation while carrying
provider-private reasoning history, and the model-ab semantic lanes explicitly delete or reject
`VOICE_LATENCY_ROUND1_MODEL`, so nothing currently exercises real cross-model multi-round
continuity): a dedicated live Responses-API probe through the production `runToolLoop` —
candidate model on round 1, Luna on later rounds, the real production tool schema — over fixtures
covering at least: a simple write, a correction, a blocking `ask_user` continuation, a
no-op/rejection turn, and a cap/cancellation path. Require exact applied-result and
audible-response parity with the all-Luna baseline, clean `end_turn` on multi-round shapes,
preserved encrypted-reasoning continuity across the model switch, correct per-round model/tier
usage attribution, AND a material round-1 latency improvement — all five, before the task-def
value changes.

### 1.3 Output size is not a lever; actual tokens are

`max_output_tokens` is `max((max_tokens||4096) * 4, 8192)` (`:544`) — a **ceiling, not a cost**.
It must not be presented as a latency lever. *Emitted* tokens are, and 08A's `reasoning_tokens`
split is what makes them attributable.

### 1.4 Does a 35 k cached prefix still cost latency? — the floor is now measured

Cache economics are solved (Plan 01), and the observed in-session prefix hit rate is 9/12 turns
(three key-rotation writes — see the Cache bullet above), but a cached prefix is not a free
prefill even on a hit. **08A's data answers the conditional: the pre-first-tool span is real and
dominant.** On session
`8B9B2BDD` (post-08B baseline, `responses` stratum), `started_ns → first_tool_use_ns` on
tool-emitting rounds is p50 **2,460 ms** (n = 14, min 1,087, max 3,065) — 74–97 % of round-0
`stream_ms`. **Its composition is unknown**: the span blends queue/service delay, cached-prefix
processing, hidden reasoning, and generation up to the first tool item, and token counts alone
cannot allocate wall time among those. End-turn-only rounds stay opaque under 08A's stated
limitation. What is settled: *the span dominates*. What is NOT settled — and, stated honestly,
what this plan can no longer fully settle (round-3 correction): **attribution within the span.**
The §1.1 effort probe closed without running (documented `'none'` regression), so the reasoning
contribution stays unattributed. And because the explicit cache breakpoint sits after the STABLE
prefix on every §2.1 arm (see §2.1's invariant), the three-arm benchmark varies ONLY the volatile
tail — it measures the **marginal latency of volatile-tail growth**, not the cached prefix's own
processing cost. **Cached-prefix latency attribution is therefore UNRESOLVED and owned by
neither sibling**; it is recorded here as a possible separately-scoped follow-up (a controlled
run varying only warmed stable-prefix length, everything else held constant), NOT scheduled by
this plan. No text in this plan may describe the post-benchmark residual as a proven
provider-side fixed floor. It is explicitly **not** a cost question — Plan 01 closed that — and
must not be allowed to re-open one.

> Corrected 2026-08-10 at 08A review round 2: this section previously referenced a `first_token_ns`
> field. 08A **dropped** that field — the Responses adapter yields a synthetic `message_start`
> before reading provider SSE (`openai-responses-adapter.js:353`), so a first-event stamp would have
> read ≈0 ms every round. `first_tool_use_ns` is the honest marker.

## §2 — Prompt snapshot size

### 2.1 `SNAPSHOT_RECENT_CIRCUITS = 3` — observed alongside re-derivation; causality to be tested

*(Was §2.2 in Plan 08B. It moved here rather than staying with the round-count levers because its
first hypothesis is settled by 08A's cached-token counts, and its second is priced against §1.4
directly above — it belongs with the cost items, not the count items.)*

`SNAPSHOT_RECENT_CIRCUITS = 3` (`eicr-extraction-session.js:111`) with
`CIRCUIT_ORDER = 'recent_3'` (`ecs/task-def-backend.json:54`) renders only the last three circuits
in detail and summarises the rest as *"N earlier circuits (…) stored server-side"* (`:4149-4157`).

Observed in live telemetry, from the model's own reasoning summaries:

> turn-11: *"only snapshot information for servers 1 and 2 is visible"*

and on turns 12–13 it re-derived and re-emitted an identical
`record_reading{circuit:1, r1_r2_ohm:0.22}` after the inspector re-dictated it, consistent with
the earlier write having rotated out of view. **This is an observation, not a proven cause** — no
controlled counterfactual has shown the rotating window produced the duplicate write; the paired
benchmark below is what establishes (or refutes) causality.

**The candidate fix exists and is unused.** `CIRCUIT_ORDER = 'ascending'` (docstring
`eicr-extraction-session.js:1476-1500`, resolver `:1502-1510`, renderer `:4146-4148`) renders
every circuit on the active board in full detail with no hidden-summary line, and its docstring
claims a second benefit: under `split_blocks` the EXTRACTED block becomes **append-only**, so the
volatile tail stops reshuffling as the inspector moves between circuits.

**Both claims are untested. Treat them as hypotheses, and settle them with ONE paired benchmark
(✅ all 3 arms confirmed 2026-08-11):** identical transcripts, model and tier, run over
`CIRCUIT_ORDER='recent_3'`, `CIRCUIT_ORDER='ascending'`, and the bounded recent-window arm
**predeclared as `SNAPSHOT_RECENT_CIRCUITS=6`** (the bounded doubling of the current window), on
a **realistic circuit count** (target ≥ 20 circuits, not a 4-circuit fixture).

**Execution seam for the third arm:** `SNAPSHOT_RECENT_CIRCUITS` is a module constant consumed
directly by the renderer (`eicr-extraction-session.js:111`, used at `:3731`, `:4149`), so an
"offline arm" cannot run through the same loaded production path without a seam. The benchmark
adds a **benchmark/test-only constructor-latched `snapshotRecentCircuits` override that defaults
byte-identically to the exported production constant** — all three arms then run through the same
production path in the same build. The production env wrapper is built ONLY if this arm wins.

**Cache-key invariant, not evidence (corrected rounds 2 and 8):** on the production
explicit-cache lane the OpenAI breakpoint sits after base + stable snapshot prefix, never after
the turn-varying EXTRACTED tail (`eicr-extraction-session.js:3460-3462`), and the explicit cache
key derives from that stable text (`openai-responses-adapter.js:568-582`) — so **per-turn key-ID
equality across arms** is guaranteed by construction (equal stable text ⇒ equal key), but equal
keys do NOT guarantee equal cache OUTCOMES: keys rotate mid-session on stable-content changes
(observed 3 writes / 9 reads on session `8B9B2BDD`), and with interleaved arms sharing a key the
first arm to encounter a new or expired key pays the write while later arms hit it — a direct
confound of the paired latency comparison. Therefore: treat per-turn key-ID equality as the
wiring invariant; **require every measured paired block to have MATCHED cache outcomes and read
counts across arms** (pre-warm each deterministic rotated key, or reject/stratify blocks with
mismatched or expired-cache outcomes); report write rounds separately from warm comparisons. Do
NOT present stable cached-token counts as the append-only hypothesis "winning". If append-only
caching itself is ever to be tested, that is a separately-scoped transport/cache-mode experiment,
out of this plan's scope.

**Report per-arm** — ≥ 10 interleaved repetitions per fixture/arm, the first cache-write round
separated from warm rounds: rendered volatile-tail bytes/tokens, `fresh_input_tokens`, total
input tokens, `started_ns → first_tool_use_ns` (does a bigger volatile tail widen the span?),
total `stream_ms`, duplicate/re-derived write count (the causality claim), and round count.
**Winning condition (predeclared):** an arm wins only if — with FULL semantic and audio parity
against the `recent_3` baseline (identical intended final field state; no dropped
structurally-complete write; correct correction/rejection/question behaviour; no unexpected
duplicate write; exactly one audible terminal response where required) — it reduces total
per-turn round-stream time for semantically equivalent output. Any semantic, audibility,
cancellation, or clean-`end_turn` regression disqualifies the arm regardless of latency.
Otherwise close the losing branches explicitly and keep `recent_3`.

1. *Cache-prefix preservation* — on the explicit-cache lane this is an **invariant by
   construction** (see above), not a benchmark outcome. The production-relevant measure is
   volatile-tail size and its latency contribution. *(08A's field data confirms the
   instrumentation reports cache/usage counts reliably — the 08A dependency that previously
   parked this item is discharged; the benchmark itself is what remains.)*
2. *Token growth* — `ascending` renders **every** circuit in full detail, so the snapshot grows
   linearly with installation size. On a 30-circuit board that is a large volatile tail every
   round, and against §1.4 a bigger prompt could **cost more latency than the round it saves.**

**Shippability constraint for the window arm:** changing the compile-time constant satisfies
neither the independent-flag/rollback acceptance rule nor the replay-env closure. If (and only
if) the `=6` arm wins, the benchmark-only seam is replaced by a **constructor-latched,
source-controlled env setting** (same contract as `_resolveCircuitOrder` — env mutation
post-construction must not drift the mode), pinned in `replay-environment.mjs` with the inventory
version bumped, golden-divergence fixtures updated, and a rollback value independent of
`CIRCUIT_ORDER`.

Execution note: `CIRCUIT_ORDER` is pinned in the field-replay environment loader
(`scripts/field-replay/replay-environment.mjs:49`) precisely because *config divergence is prompt
divergence*. Changing the default changes replay semantics; the corpus pins move in the same
commit.

## Seam — what this split keeps and what it gives up

**Kept together deliberately.** §1.4 (what the pre-first-tool span costs) and §2.1 (a change that
grows the **volatile tail** the model re-reads every round) are the same question asked from two
directions. Splitting *those* apart would have been the wrong seam — one plan would propose
growing the rendered prompt while the other priced the latency of a grown prompt, and neither
would own the contradiction. *(Round-3 precision: §2.1's arms leave the CACHED stable prefix
byte-identical by construction — what grows is the uncached volatile tail, so the pair measures
tail-growth latency, not cached-prefix cost; see §1.4 for the explicitly-unresolved remainder.)*

**Sibling integration (the 2026-08-11 A/B split).** [08C-B](plan-08c-b-terminal-round.md) owns the terminal-round
shrink/eliminate lever, the 08D-inherited replication gate, the four acceptance preconditions,
the honesty limit, and the §9 invariants apparatus. What connects the two chunks:

- **§1.1 ↔ terminal-round termination:** PLAN-B must re-read this plan's §1.1 hazard against any
  mechanism it selects before any combined effort-below-`'low'` probe (the fourth inherited
  precondition, held in B).
- **Ship order and baselines:** this plan ships FIRST; PLAN-B re-baselines against post-A numbers,
  never against pre-08B. Neither plan's win may be claimed from a deploy containing both.
- **The shared data foundation** (session `8B9B2BDD`, `:392`) is recorded in both plans; the
  replication gate governing terminal-round activation is B's alone, but the "single session ⇒
  ratios provisional" caveat applies to every number in both.

**Given up by the earlier 08B split, and therefore restated here.** 08B (now shipped) reduces
provider round-trips wasted on validator rejections; this plan reduces the *cost of each* round.
They multiply, so: neither plan's win may be claimed from a deploy containing both — whichever
ships second re-baselines against the first. 08B's Seam section carries the matching note.

## What this plan is NOT

- **Not a cost-reduction plan.** Plan 01 took the cost win (explicit caching; in-session prefix
  hit rate 9/12 with key rotations re-paying writes — an economics detail, not a lever here). A
  token saving here is a side effect to report honestly, never a justification.
- **Not a prompt-shrinking exercise for its own sake.** The prompt's billable cost is solved
  (cached); whether its SIZE contributes latency inside the pre-first-tool span is precisely what
  §1.4+§2.1 measure — this plan neither assumes it does nor that it doesn't.
- **Not a licence to reduce latency by making the model less careful.** A turn that finishes faster
  by skipping the reasoning in which it verifies its own write is a correctness regression wearing
  a latency plan's clothes.
- **Not authorised to touch the audio-first invariants.** Every applied dictated reading is spoken
  exactly once; structurally complete readings are written regardless of confidence; speculative
  and cancelled work is never spoken or written; every rejection stays audible.
- **Not the owner of the terminal-round lever.** That is [08C-B](plan-08c-b-terminal-round.md) — including the
  prohibition on release-before-completion mechanisms (five dead shapes; `VOICE_MID_STREAM_FILTER`
  is a remnant, not an asset). Nothing in this plan may pre-empt B's mechanism selection.

## Web companion

This plan's scope (reasoning effort, round-1 model closure, prompt snapshot size) is backend-only
and wire-neutral throughout — all invisible to both clients. No web companion required, and no
parity-ledger row. (The terminal-round lever's Web-companion trigger analysis moved to
[08C-B](plan-08c-b-terminal-round.md) with the lever.)

## Acceptance

- Each lever flagged and rollback-able **independently**, so its effect stays attributable — the
  same rule Plan 03 imposes on connection reuse versus voice settings, for the same reason.
- Report p50/p75/p95 with sample counts, split by reading versus question and by round count.
  **Report sample size honestly**: the analysis behind this plan rests on 12–41 observations from
  five sessions — enough to locate a bottleneck, not enough to certify a 10 % improvement.
- Tool-loop, reasoning-continuity, cancellation, usage-accounting and audibility suites green.
  Field-replay gate green, with corpus pins updated in the same commit as any config default
  change.
- No conclusion rests on a `dispatch_ms` value that includes an `ask_user` human wait (08A fixes
  the metric; this plan must actually use the fixed one — `blocking_ask_user_dispatched` rounds
  excluded).
- Baseline is post-08B (08B's own §2.1 — validator-rejection round reduction, a different section
  from this plan's §2.1 — shipped 2026-08-11; the Data-foundation numbers already state it). Say
  which baseline every number is against. If PLAN-B ships anything before a number here is
  claimed, re-baseline against post-B.

## Ordered runtime deliverables

The probes above become an executable sequence here; Delivery's documentation/PR/deploy steps
come strictly AFTER these. The repo's latency-tail probe documents large same-input tail variance
— a single sample is never decisive, which is why every comparison below requires ≥ 10
interleaved repetitions per fixture/arm.

1. **Benchmark runner.** Extend (or create under `scripts/voice-latency-bench/`) ONE
   production-path live benchmark runner that drives the REAL full pipeline — through
   `runShadowHarness`/`runLiveMode` with the real nested `runToolLoop`, dispatcher, canonical
   bundler, ask continuation, cancellation finalizer, and the catch-all audibility path — NOT
   `runToolLoop` in isolation (bare `runToolLoop` never exercises the bundler, the audibility
   net, or the emitted wire frames where exactly-once speech is decided; and its `tool_calls`
   carry no `round_idx` and omit assembler/dispatcher failures and cap-held calls). Per
   repetition it persists a machine-readable evidence artifact: raw samples plus
   environment/build identity, `round_idx`-keyed timings and usage (the 08A shapes), provider
   call ids, AND a **complete per-attempt ledger** — round index, tool-call id, canonical
   destination, normalised value, dispatch outcome/result, applied mutation, and the emitted
   audible frame/correlation id. Duplicates, overwrites, drops, and exactly-once speech are
   counted from that ledger — never from final state (which hides repeated same-slot writes) and
   never from `stage6_tool_call.round` (a per-dispatcher-closure call counter). Fixture shapes
   required: a simple reading write, a correction, a blocking-question continuation, a
   no-op/rejection turn, a cancellation/cap path — AND, because the causality hypothesis needs
   its triggering condition actually exercised, at least one **eviction/re-dictation fixture**: a
   provenance-backed ≥ 20-circuit session that writes an early circuit, advances through enough
   distinct circuits to evict it from the `recent_3` window (and enough to ALSO distinguish the
   window-6 arm — i.e. evicted under window 3, still visible under window 6), then re-dictates
   the identical early-circuit value. **Pre-run decision table over the paired blocks (never a
   single event):** let `d(arm)` = the fraction of this fixture's blocks in which the arm's
   ledger shows a duplicate/re-derived write to the evicted slot.
   - **Supported:** `d(recent_3)` ≥ 0.5 AND `d(ascending)` = 0 AND `d(window_6)` = 0 — the
     duplicate follows visibility, in a majority of blocks, and vanishes whenever the circuit is
     still rendered.
   - **Refuted:** `d(ascending)` > 0 or `d(window_6)` > 0 at a rate comparable to
     `d(recent_3)` — duplicates occur even with the circuit visible, so visibility is not the
     cause.
   - **Untested:** `d = 0` in every arm — the trigger never fired; say so, do NOT claim
     refutation.
   - **Inconclusive:** anything else (e.g. `d(recent_3)` in a minority of blocks, or mixed
     window-6 behaviour) — keep `recent_3`, report the rates, no causal claim either way.
   Generic fixtures alone can produce zero duplicates in every arm without ever testing the
   claim.
2. **§2.1 three-arm snapshot benchmark** through that runner: ≥ 10 interleaved repetitions per
   fixture/arm in randomised sequential order, fresh identical session state per repetition,
   first cache-write round separated from warm rounds. **Predeclared decision rule:** each
   repetition belongs to an explicit randomised BLOCK (block ID recorded in the evidence
   artifact; each arm runs exactly once per block, order randomised within the block), so paired
   differences are computed only within the same fixture+block. Primary statistic, dimensionless:
   per fixture, the median across blocks of `(baseline_ms − candidate_ms) / baseline_ms` over
   total per-turn round-stream time (warm rounds only); then the unweighted mean of those
   per-fixture medians. Minimum effect = that mean ≥ **10 %** AND the per-fixture medians have a
   consistent sign on a majority of fixtures. Parity gates per §2.1 are pass/fail prerequisites
   before latency is even compared; anything else — mixed signs, sub-threshold means — is
   INCONCLUSIVE and keeps `recent_3`. If both non-baseline arms pass, ship the SIMPLER one
   (`ascending` = flip the existing pinned `CIRCUIT_ORDER`; window-6 requires new wrapper
   machinery) and record the other as available.
3. **Decision point — enumerate every shipping outcome explicitly:**
   - `recent_3` retained → no snapshot change; benchmark artifact + closure recorded.
   - `ascending` wins → change the existing `CIRCUIT_ORDER` value in `ecs/task-def-backend.json`
     (already `PINNED_FROM_TASK_DEF`), move the field-replay corpus pins in the SAME commit, and
     update the golden-divergence fixtures.
   - Window-6 wins → build the constructor-latched env wrapper per §2.1's shippability
     constraint (pin + inventory bump + fixtures + independent rollback), then ship it.
   - **No arm wins → close with NO snapshot/runtime-behaviour change**: an honest close is a
     success outcome, with the evidence artifact and the recorded considered-choice defaults as
     the deliverable. (Not "docs-only" — deliverable 4 below ships replay-closure code and tests
     in EVERY outcome, so the final diff always contains scripts/tests even when no runtime
     behaviour changes.)
4. **Replay-closure hardening (ships in every outcome):** the §1.1 `DELETED_SO_DEFAULTS_APPLY`
   reclassification of `OPENAI_EXTRACT_REASONING_EFFORT` + `OPENAI_EXTRACT_API`, inventory bump,
   and tests — see §1.1's surviving deliverable. As of this writing both variables still sit in
   `openai_trial`, so this has NOT already shipped.
5. Only then: the Delivery steps below.

## Delivery

Ordered; nothing here is optional:

1. **Gate-discharge branch: already reconciled — but SYNC before branching.** `docs/08c-rp-gate-discharge`
   (PR #174) **MERGED** 2026-08-11T16:40Z, merge commit `98efd63b`. The local checkout may still
   sit on the gate-discharge branch with a stale local `main` that does NOT contain that merge.
   Before creating any execution branch: `git fetch origin`, verify `98efd63b` is reachable from
   `origin/main`, switch to `main`, fast-forward it, and only then branch. Never branch from the
   stale local `main` or from the gate-discharge branch. Do not duplicate the
   checklist-confirmation fold PR #174 carried.
2. **Repo-wide `:392` sweep.** The mislabel is not confined to this file. In one commit, correct
   `eicr-backend:393` → `eicr-backend:392` wherever it refers to session `8B9B2BDD`:
   `plan-08b-stage6-round-levers.md` (3×), `plan-08d-terminal-round-release.md` (7×), `INDEX.md`
   (7×), the hub `CLAUDE.md` changelog row, and `docs/reference/changelog.md` — and update
   `INDEX.md`'s 08C row from "pending independent confirmation" to gate-discharged-and-split
   (08C-A + 08C-B).
3. **Canonical plan artifacts.** Copy the converged PLAN-A/PLAN-B finals back to
   `.planning/voice-latency-conversational-2026-07-31/` (as `plan-08c-a-per-round-cost.md` and
   `plan-08c-b-terminal-round.md`, with `plan-08c-per-round-cost.md` reduced to a pointer stub) so
   the repo copies and the handoff finals agree.
4. **Docs of record for every change that SHIPS — runtime/config or not.** Matching
   reference-file update, a full entry in `docs/reference/changelog.md`, and a one-line hub
   `CLAUDE.md` changelog row. This explicitly includes deliverable 4's replay-environment
   reclassification even when no snapshot arm wins: update
   `docs/reference/field-replay-corpus.md`'s environment-parity material for the
   `OPENAI_EXTRACT_REASONING_EFFORT` / `OPENAI_EXTRACT_API` move to `DELETED_SO_DEFAULTS_APPLY`
   and the inventory-version bump.
5. **Gates:** backend Jest, web vitest, field-replay gate (with corpus pins in the same commit as
   any config default change) — all green before merge. **npm audit is ADVISORY in CI, not a
   gate**: both workflow audit commands end `|| true` (`.github/workflows/deploy.yml:315,319`),
   so a green "npm Audit Security Scan" job is NOT evidence of a clean audit. Run
   `npm audit --audit-level=high` locally in both workspaces WITHOUT `|| true`, and record the
   exit status in the delivery notes.
6. **PR-only delivery** — never push `main` directly. Batch mode: this plan ships first via the
   chained `/ep`; PLAN-B queues behind it (`.ep-queue` marker) and re-baselines.
7. **Deploy confirmation:** task-definition revision increment + the "Deploy to AWS ECS" JOB
   conclusion — never `rolloutState` (it reads COMPLETED while stale). Backend service
   `eicr-backend`; web service `eicr-pwa` (functionally unaffected — this plan is wire-neutral.
   The final diff is never purely docs — deliverable 4's `scripts/`+tests changes ship in every
   outcome and match the backend path filter; in the no-runtime-change outcome the deploy
   redeploys behaviourally-identical images, which is expected, not a companion change).

## Reviewer pressure points

- **Is the checklist-confirmed data being used honestly?** All numbers must name the post-08B /
  `:392` baseline and the single-session caveat. If a claim has been promoted from hypothesis to
  fact on the strength of a docstring rather than a measurement, that is the finding.
- §1.1 closed on DOCUMENTED evidence (`'none'` loops on both transports) — is that closure and
  its in-repo citations stated accurately, and does no surviving text still schedule an effort
  probe?
- Does `CIRCUIT_ORDER=ascending` preserve the cache prefix in practice, and does its token growth
  on a realistic circuit count cost more than the round it saves?
- Are gains here separable from 08B, Loaded Barrel, Plan 02 and Plan 03, or would a combined deploy
  make all of them unattributable?
- **What did the A/B split lose?** Is there a deliverable, wire contract, or measurement that
  neither chunk now owns?
