# Plan 08D — The discarded terminal round, and releasing the inspector from it

Status: **PARKED (2026-08-10), pending one ordinary field session on `eicr-backend:388`.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

**This was §2.0 of Plan 08B.** It was split out after round 2 of `/rp`, when two independent
reviewers produced six BLOCKERs against a mechanism that was itself the *fourth* attempt at this
lever — while the other half of the plan (§2.1, the `board_id` vocabulary gap) drew **zero findings
from either reviewer**. Derek's own splitting rule applies verbatim: *"split the churning one into
its own plan and ship the converged one now."*

**Nothing here is abandoned.** The lever is real, large, and measured. What is parked is the
*mechanism choice*, and it is parked on the identical criterion that parked
[08C](plan-08c-per-round-cost.md): it depends on 08A telemetry that no field session has yet
produced.

---

## 1. The lever is real — this is not why it is parked

From four live Luna field sessions (2026-08-06/07), 28 turns / 65 rounds:

| Measure | Value |
|---|---|
| Turns ending in a no-tool `end_turn` round | **28 / 28 (100 %)** |
| Dead wait — last tool dispatch → loop completion, p50 | **1710 ms** |
| min, across all 28 turns | **1207 ms** |
| p95 | 3760 ms |
| median share of the whole turn | **28.3 %** |
| Output tokens that round produced, all 28 turns | **208 total** (p50 **4** per round) |

Every turn carries at least 1.2 s of wait after its last write committed, for a round whose output
is never spoken — all 28 turns are `path_classification: bundler_only`, so the spoken confirmation
is server-authored by the bundler and the model's closing prose never reaches TTS.

**The dead wait *is* the terminal round.** Terminal-round `stream_ms` p50 is **1710 ms** — the same
number, not a correlated one. They are the same object measured two ways.

---

## 2. Why it is parked — the design space collapses onto one unmeasured fact

Four mechanisms have now been proposed for this lever. Three were already shipped and reverted in
production; the fourth failed review. They fail for **one shared structural reason**:

> **A round cannot be known to be the last tool round until the *next* round returns.** The loop
> continues on `tool_use` and breaks on `end_turn`. Any release before the loop returns is therefore
> a *bet that the turn is over* — which is exactly what every reverted design got wrong.

That is not a patchable defect. It is the premise.

### The one door that is not a bet

There is a variant that does not gamble: **release at the moment the terminal round begins streaming
and reveals no `tool_use`.** At that instant the model has already *committed* to terminating — this
is an observation, not a speculation. It skips no round, speaks nothing pre-validation, and leaves
the model's context untouched, so it clears all four precedents in §3 outright.

Its value is bounded by how much of the terminal round's 1710 ms falls *after* that reveal:

| If the terminal round is mostly… | …then |
|---|---|
| **streaming** (tokens emitted slowly after a fast first token) | the safe door captures most of the 1710 ms — a clean win, no precedent risk |
| **thinking** (long pre-first-token reasoning, then 4 tokens) | the safe door captures almost nothing, and the only remaining levers are the forbidden speculative ones or 08C's reasoning-effort work |

**Nobody can currently tell which.** All 28 measured turns carry only
`started_ns / stream_complete_ns / dispatch_complete_ns / dispatch_ms / round_idx` — there is **no
first-content marker on any terminal round in the existing corpus**.

### The unblock condition — precise, and already owed for another reason

Plan 08A shipped exactly the discriminator, and it is wired end-to-end:

- `reasoning_tokens` — `openai-responses-adapter.js:442`
  (`usage.output_tokens_details.reasoning_tokens`) → named in `attributeRoundUsage`'s explicit
  allowlist at `round-usage-attribution.js:208`.
- `first_tool_use_ns` — `stage6-tool-loop.js:666`. **Null by construction on a terminal round** (no
  tool use), so it identifies the terminal round rather than timing it. `reasoning_tokens` is the
  field that answers the question.

Both are live only on `:388`. **One ordinary field session unblocks this plan and 08C together.**

---

## 3. Binding precedents — four reverted or disabled designs, verified in git and in source

Treat these as constraints, not history. The first three were verified during round 1; the fourth
was found during round 2 and **is the most dangerous of them.**

| # | Commit / gate | What it did | Why it was killed |
|---|---|---|---|
| 1 | `83e8bf69` | `tool_choice:{type:'any'}` forced a tool on the **first token** | *"bought streamed-speculation lead time at the cost of the agent's ability to **think before acting**"* |
| 2 | `1db6230a` | Round-1 early-terminate predicate skipped round 2 on a clean write | *"removed the agent's **second look** / self-correction / follow-up"* and **"ruined the feel of the app" (owner)**. Deleted, **not** flag-gated, by explicit owner decision |
| 3 | `285711f0` | Loaded Barrel advertised speculative audio **mid-stream** | On a turn that then took a second tool call, *"iOS had already played the now-wrong per-slot confirmation"*; *"a post-hoc `invalidateBySlot` cannot un-play served audio."* Still enforced by `onSlotAudioReady: null` (`stage6-shadow-harness.js:1503-1507`) |
| 4 | `VOICE_MID_STREAM_FILTER` (default off) | Suppressed already-emitted slots from the canonical bundle, so an early-spoken reading was not spoken twice | Field session **36602959**: a `record_reading` succeeded but **the value never landed in the UI** — the filter removed it from the canonical bundle assuming iOS already had it from a mid-stream preview that never arrived. `stage6-shadow-harness.js:2496-2545` |

**Precedent 4 is the one a future mechanism is most likely to walk into**, because its machinery
*already exists and looks finished*. `midStreamEmittedSlots` (`stage6-shadow-harness.js:1385`) plus
the canonical filter at `:2504-2545` implement precisely the "speak early, then suppress the
matching canonical duplicate" de-duplication that any release-early design needs. It is dormant, not
absent.

So the mid-stream path has failed in production **twice, for two independent reasons**: it played
*wrong* audio (precedent 3), and it *silently lost a reading entirely* (precedent 4). The second is
a direct violation of the audio-first invariant that a structurally complete reading is never
silently dropped. The code states its own gate: *"Until the mid-stream channel is verified
end-to-end, ALWAYS emit canonical… Re-enable with `VOICE_MID_STREAM_FILTER=true` when the mid-stream
path is debugged."*

**Any future mechanism that re-arms this path must treat "verify the mid-stream channel end-to-end"
as a precondition, and must be put to Derek explicitly** — re-enabling a twice-failed production
path is an owner decision, not a reviewer's.

The unifying principle all four express: **latency may never be bought by removing the model's
agency, nor by committing to an answer before the turn has validated it.** `83e8bf69` also records
the sanctioned alternative — *"the owner chose to recover that lead time the right way (Plan B's
`onToolUseStreamed` streaming hook) rather than by forcing the first token"* — i.e. pre-synthesise
during the stream, serve after validation. That is Loaded Barrel, and it still runs.

---

## 4. What kind of follow-up actually occurs — the measurement that must survive the park

The decisive question was never *how many* follow-ups, but *what kind*. **7 of 28 turns (25 %)**
emitted tool calls after round 0 (9 additional rounds), and Luna emitted up to **4 tool calls in one
round**, so multi-round turns are genuine sequencing, not a batching failure.

| Turn | Round 0 | Later rounds | Kind |
|---|---|---|---|
| t-1 | 3× `record_board_reading` | `ask_user` | additive |
| t-5 | `ask_user` | `inspect_session_state`, 2× `create_circuit` | additive |
| t-6 | 2× `create_circuit` | `select_board`, 2× `create_circuit` | additive (other board) |
| t-12 | `inspect_session_state` | `record_reading` | additive |
| t-13 | `inspect_session_state` | `record_reading` | additive |
| t-15 | `calculate_zs` | `calculate_zs` | additive |
| t-16 | `calculate_zs` | `answer_user` | additive |

**Zero corrective follow-ups in 28 turns** — no `clear_reading`, `clear_board_reading`,
`delete_circuit` or `rename_circuit`. The precedent-3 failure mode (a write retracted within the
same turn) did not occur once.

**Two bounds, and the second is the one that matters** (round-2 finding):

- **≤ 10 % of all turns** — rule of three on 0/28. This is the figure a design is tempted to quote.
- **≤ ~43 % of multi-round turns** — rule of three on 0/7. A single-round turn (21/28) *structurally
  cannot* produce a corrective follow-up; there is no later round to correct anything. The
  multi-round subset is the only population where an early release is actually a bet, so **this is
  the number any "does it degrade gracefully?" argument must be evaluated against.**

Note also `t-12` and `t-13`: the write lands in a **later** round. Any release must key off the
write, not off round 0.

---

## 5. Round-2 findings against the fourth mechanism — recorded so they are not re-derived

The mechanism reviewed was: *"release the confirmation when the write has COMMITTED and the audio is
READY — whichever is later — instead of when the loop returns."* Six BLOCKERs, two independent
reviewers, converging on four distinct defects:

1. **There is no commit point to release on.** `dispatch_complete_ns` fires **per-round**, after that
   round's tool calls finish dispatching (`stage6-tool-loop.js:1216-1217`) — before the loop knows
   whether another round follows. Individual dispatchers mutate `session.stateSnapshot` and stage
   `perTurnWrites` at different moments (e.g. `stage6-dispatchers-circuit.js:642-647` mutates,
   `:714-718` stages). A multi-tool round has N partial mutation points, and tool 1 can commit while
   tool 2 rejects.
2. **The confirmation text is authored once, post-loop.** The bundler is a documented once-per-turn
   post-loop authority (`stage6-shadow-harness.js:14`, *"Pitfall #3 (bundler fires ONCE post-loop)"*;
   `stage6-event-bundler.js:4-11`). "Committed" therefore cannot mean "bundler-validated" without
   restructuring the bundler to run per-round.
3. **The 37 % barrel-miss cohort gets nothing.** On a miss there is no parked audio, and the client
   does not receive the extraction frame until the harness returns (`sonnet-stream.js:6956-7133`);
   the iOS TTS route only falls through to ordinary synthesis after finding neither ready nor pending
   audio (`src/routes/keys.js:402-548`). Starting synthesis earlier on a miss requires a
   pre-loop-complete delivery path — i.e. precedents 3 and 4.
4. **The instrumentation recipe pointed at the wrong subsystem.** `audible_first_byte_ms` /
   `audible_first_byte_source` are not unpopulated allowlist fields — they are a **hardcoded `null`
   literal** at the single `emitTurnCoreSummary()` call site (`stage6-shadow-harness.js:4285-4286`),
   commented *"Server-side audible-first-byte is null in this path — fast-path audio is iOS-driven."*
   Adding the field to `attributeRoundUsage`'s allowlist would land a plausible-looking diff in a
   place that cannot affect it. The real sites are `recordOutcome`'s `meta` in
   `loaded-barrel-speculator.js:~1010` and the harness literal itself.

Also recorded: **this lever does not reduce round count or provider spend.** Letting the loop run to
completion means no round is removed and no tokens are saved; the win is *perceived* latency only.
Any successor plan must not inherit 08B's round-count framing.

---

## 6. When the `:388` session lands — the next cycle's first three moves

1. **Read `reasoning_tokens` on the terminal round.** High ⇒ the round is thinking, the safe door is
   shut, and this lever likely belongs to 08C's reasoning-effort work rather than to a release-timing
   change. Low ⇒ the round is streaming, and the safe door in §2 is worth planning in full.
2. **Re-run the corrective/additive split on the new sessions** and update both bounds in §4. The
   0/28 result is a null result on a small sample; more turns either strengthen it or kill the design.
3. **Do not re-propose a mechanism before step 1.** Four have been proposed on the strength of the
   1710 ms figure alone; all four failed. The figure justifies *investigating* the lever, never a
   specific mechanism.

## 7. Acceptance preconditions this plan OWNS — inherited from the split

These were acceptance criteria of the combined 08B plan. They belong to the release-timing lever,
not to the board-scope lever, so they move here rather than being dropped. **08B's round-3 review
caught them as orphaned — after the split, no sibling owned them.** Each one guards a distinct way
this lever could claim a saving it did not make.

- **A nanosecond audio-ready stamp exists and is populated before any saving is claimed.**
  `audible_first_byte_ms` is null on 100 % of turns today. **Do not implement it from the combined
  plan's original recipe — that recipe was wrong** (round-2 BLOCKER #4): the field is a hardcoded
  `null` literal at `stage6-shadow-harness.js:4285-4286`, not an unpopulated allowlist entry, so
  adding it to `attributeRoundUsage`'s allowlist would change nothing while looking correct. The
  real sites are `recordOutcome`'s `meta` in `loaded-barrel-speculator.js:~1010` and the harness
  literal itself.
- **Barrel HIT and MISS cohorts reported separately, never blended.** The mechanism differs (serve
  parked audio vs start synthesis earlier) and so does the win. Measured 37 % miss — and round 2
  established the MISS cohort may get *nothing* from this lever through the current wire path, so
  blending the two would manufacture a saving that does not exist for over a third of turns.
- **Plan 06 (conversational lane) has a GO and touches the same tool loop.** 06 changes what the
  model is expected to *say*; this lever changes when the human stops waiting for it. **Re-read 06
  against the chosen mechanism before this plan is detailed, not after** — and whichever ships
  second re-baselines against the first, not against the pre-08B numbers.
- **The 08C §1.1 interaction is SHARPER here, not moot.** A reasoning model with reasoning turned
  down may fail to cleanly `end_turn`; under a release-before-loop-return design it then burns round
  cap and cost *after* the inspector has been released and moved on. Today that failure is at least
  audible as a long silence. Re-read 08C §1.1 against any chosen mechanism before probing effort
  below `'low'`.

## Non-negotiable, whatever mechanism eventually wins

The audio-first invariants hold: every applied dictated reading is spoken **exactly once** — not
zero, not twice; structurally complete readings are written regardless of self-reported confidence;
speculative and cancelled work is never spoken or written; every rejection stays audible. A design
that speaks earlier by speaking twice is a regression wearing a latency plan's clothes. A corrective
follow-up arriving after release would have to be spoken as an **explicit correction** that
references and supersedes what was already said — which is very likely a **new wire shape**, and
therefore a MANDATORY Web-companion trigger, not a backend-only change.
