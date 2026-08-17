# Plan 08D — The discarded terminal round, and releasing the inspector from it

Status: **CLOSED docs-only 2026-08-11 — the park condition was discharged by measured field
evidence (12 turns, session `8B9B2BDD`, `eicr-backend:392`; see §2), and the refine cycle
converged on a no-runtime-mechanism closure (§7): 08D ships nothing to `src/`/`web`/iOS; the
terminal round's shrink/eliminate-round lever transfers to 08C.**
Review lane: **full dual-reviewer loop — internal Sonnet high (`certmate-plan-reviewer`), external
Codex `gpt-5.6-sol` high. Do not downgrade: a lesser reviewer model has twice scored 0/9 on known
findings in this codebase.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

**This was §2.0 of Plan 08B.** It was split out after round 2 of `/rp`, when two independent
reviewers produced six BLOCKERs against a mechanism that was itself the *fourth* attempt at this
lever — while the other half of the plan (§2.1, the `board_id` vocabulary gap) drew **zero findings
from either reviewer**. Derek's own splitting rule applies verbatim: *"split the churning one into
its own plan and ship the converged one now."*

**Nothing here is abandoned.** The lever is real, large, and measured. The *mechanism choice* was
parked on the identical criterion that parked 08C
(`/Users/derekbeckley/Developer/EICR_Automation/.planning/voice-latency-conversational-2026-07-31/plan-08c-per-round-cost.md`):
it depended on 08A telemetry that no field session had yet produced. **That session has now run** —
the telemetry it produced resolves §2's fork and unparks 08D outright. It very likely discharges
08C's park too (session `8B9B2BDD` is on `:392`, past 08C's `:388+` revision gate), but 08C's own
three-item unblocking checklist (revision `:388+`, split on `round_usage[].api_transport` before
computing, key on `round_idx` not array position) must be independently confirmed against this
session before 08C's `/rp` opens — updating 08C's stale `PARKED` status line is a deliverable of
this plan (§7).

---

## 1. The lever is real — closing 08D is not abandonment

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

## 2. The fork, resolved — the fact is now measured, and the answer is NEITHER branch

Four mechanisms have now been proposed for this lever. Three were already shipped and reverted in
production; the fourth failed review. They fail for **one shared structural reason**:

> **A round cannot be known to be the last tool round until the *next* round returns.** The loop
> continues on `tool_use` and breaks on `end_turn`. Any release before the loop returns is therefore
> a *bet that the turn is over* — which is exactly what every reverted design got wrong.

That is not a patchable defect. It is the premise.

### The "safe door" — believed not to be a bet, now DISPROVEN in source (round-1 review, 2026-08-11)

Earlier drafts proposed one variant claimed not to gamble: *release at the moment the terminal round
begins streaming and reveals no `tool_use`*, on the theory that the reveal is an observation, not a
speculation. **Two independent reviewers killed this against the shipped transport code, and the
verification stands:**

1. **The reveal is not observable at all on the live transport.** `translateStreamingEvents`
   (`src/extraction/openai-responses-adapter.js:352-415`) surfaces ONLY `function_call` item events
   to the assembler; reasoning/message items are *"intentionally NOT surfaced"* (`:376-379`) and
   `response.output_text.*` events are *"intentionally ignored on the live-translation path"*
   (`:409`). `content_block_start` fires only for `tool_use`. The tool loop's own comment
   (`stage6-tool-loop.js:472-484`) states an `end_turn` round's *"interior stays opaque"* —
   `first_tool_use_ns` is the *only* honest first-content marker precisely because no text-start
   signal exists. `stop_reason` is derived only at `response.completed`. There is no "moment the
   terminal round begins streaming" to release on today — terminality is known only
   retrospectively, after the round completes with zero `tool_use` events.
2. **Even with adapter work to surface text events, the door stays a bet.** Text arriving first
   does not prove no later `function_call` item follows in the same response — the Responses output
   array can interleave, and precedent 1 (`tool_choice:any`, §3) exists precisely because natural
   ordering is not guaranteed. An ordering guarantee would have to be proven against mixed
   text/function-call outputs, and no such guarantee is on offer from the provider contract.

So the "safe door" was never a door: it is a **bet plus unshipped adapter work plus an unproven
ordering guarantee**, and it does NOT clear the §3 precedents. The plan previously posed its value
as a fork — "mostly **streaming**" (door captures most of the dead time) vs "mostly **thinking**"
(door captures almost nothing) — and said nobody could tell which. The measurement below answers
the fork anyway, and the answer moots the door from a second, independent direction.

### The measurement — 2026-08-11, session `8B9B2BDD`, `eicr-backend:392`, 12 turns

The 08A telemetry (`reasoning_tokens` via `openai-responses-adapter.js:442` →
`attributeRoundUsage`'s allowlist at `round-usage-attribution.js:208`; terminal rounds identified by
`first_tool_use_ns` null-by-construction, `stage6-tool-loop.js:666`) produced its first field
corpus. Terminal rounds, 12/12 turns, all `gpt-5.6-luna` at `reasoning_effort: low`:

| Measure | Value |
|---|---|
| mean `stream_ms` | **1497** (range 789–3477) |
| share of ALL round stream time in the corpus | **34.0 %** |
| output tokens | **10 of 12 turns emit exactly 4**, with **0 reasoning tokens** |
| the other 2 turns | 17 and 35 output tokens, with **11 and 29 reasoning tokens** |

`reasoning_tokens` **is discriminating, not unpopulated**: non-terminal rounds in the same corpus
report 14–70. Zero means zero.

**The answer to the fork is NEITHER.** The typical terminal round neither thinks nor emits — ~1.3 s
buys four discarded tokens. That is round-trip floor: prefill a small delta against a ~35 k cached
prefix, wait for first token, receive 4 tokens, discard. **Dead time by construction.**

Two consequences this plan now carries:

1. **The lever is CLEANER than §1 assumed — dead time by construction, not a streaming tail that
   must be waited out.** On size, quote the two figures as the NON-COMPARABLE measures they are:
   the new corpus's **34.0 %** is a share of *round stream time only* (denominator = Σ round
   `stream_ms`, excluding dispatch and all non-round overhead), while §1's 28.3 % / 08B's 24 % are
   shares of the *whole wall-clock turn*. Round-stream-time is a strict subset of turn time, so the
   same terminal round always reads larger against the narrower denominator — 34 % vs 24–28 % is a
   denominator switch, not evidence the lever grew. The honest headline is the character change
   (round-trip floor, 4 discarded tokens), not a bigger percentage.
2. **~17 % of terminal rounds (2/12) genuinely think** — 11 and 29 reasoning tokens. A safe door
   that silences those rounds is a **correctness regression, not a latency win**. This is the
   binding constraint on any future terminal-round optimisation (08C's track).

### The two findings compose — release-before-completion is closed, and the lever moves to 08C

Even granting the door its two missing preconditions (a live text-start signal, a proven ordering
guarantee), the measured shape bounds its capture at the **post-first-token tail**: a
round-trip-floor round spends most of its ~1.5 s waiting for the first token, and only the 4-token
tail follows any conceivable reveal. Both branches of the old fork assumed the value lay *after*
the reveal; the measurement says most of it lies *before* — where only §3's forbidden bets can
reach it.

**Conclusion this plan now commits to: 08D implements NO release-before-loop-completion mechanism.**
The current Responses transport has no trustworthy pre-completion no-tool signal
(`openai-responses-adapter.js:352-415`, `stage6-tool-loop.js:472-484, 588-605`), and
`reasoning_tokens` is likewise post-completion telemetry. That position changes only if a future
provider/adapter contract supplies an **explicit terminal event that is structurally incapable of
being followed by a tool call**, proven by tests against mixed text/function-call outputs — an
owner-approved successor plan, not an amendment here. The recoverable dead time belongs to
**08C's track — shrink or eliminate the terminal round itself** (fewer round-trips, cheaper
terminal round), which the same measurement strengthens: a round that neither thinks nor emits is
the ideal candidate for *not existing*, rather than for being *released around*.

### Sample-size caveat — stated, not waved away

12 turns from ONE session on one backend revision. This is **sufficient to discharge the park**: the
fork is resolved qualitatively — `reasoning_tokens` discriminates, and the typical terminal round is
a 4-token, 0-reasoning round-trip. It is **NOT sufficient to pin the ratios**: 2/12 thinking has a
95 % binomial interval of roughly 2–48 %, and the 34.0 % share reflects one session's mix of turn
shapes. Any mechanism must remain correct if the true think-rate is several times 17 %, and any
projected saving is provisional until a second ordinary session replicates these numbers.

**Replication gate — decided (round 1), ✅ owner-confirmed 2026-08-11:** the single session is sufficient for THIS plan's
no-runtime closure (§7). Any *future* behaviour-changing terminal-round optimisation (e.g. under
08C) may be implemented dark, but must not be **activated** — nor claim a latency saving — until at
least one independent ordinary field session on a compatible revision reproduces the qualitative
TTFT-dominated terminal-round shape. Exact 17 % / 34 % replication is NOT required; what is
required is that all observed thinking-terminal rounds remain correct and audible. This gate
transfers into 08C's acceptance section as part of §7's deliverables.

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

**Precedent 2 does not read directly onto 08D, and the distinction is load-bearing — state it,
don't let a reviewer collapse the two.** `1db6230a` removed a round that **did work**: the round-1
early-terminate skipped a genuine second look, and the loss was felt in the product ("ruined the
feel of the app"). 08D targets a round that **measurably does not work for the inspector**: 10/12
terminal rounds emit 4 discarded tokens with zero reasoning (§2), and the closing prose never
reaches TTS anyway (`bundler_only`, §1). Precedent 2 removed model agency; releasing the inspector
from a round that produces nothing removes none — **provided** the ~17 % thinking cohort (§2,
consequence 2) is preserved. Precedent 2 still binds in one respect: it proves Derek judges these
changes by feel, so any mechanism ships behind evidence, not cleverness.

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

**Churn circuit-breaker (binding process rule, encoded here so it survives session memory):** no
`/ep` execution under 08D may design or implement a fifth release mechanism. Any future refinement
that accumulates three consecutive BLOCKER-bearing rounds in terminal/release timing must stop
patching, re-test whether the defended pre-completion boundary exists at all, and either transfer
the optimisation to 08C or return an explicit owner decision — it must not proceed by adding
per-round bundling, canonical suppression, forced tool choice, or skipped-loop machinery. Four
mechanisms have already died on this lever; a fifth needing escalating machinery is the signature
of a wrong design, not a hard one.

**Cross-record 2026-08-17 (from 08C-B's confirmed closure — added once its Codex hold resolved
by measurement, per the deferral rule that a contested disproof must not enter this settled
catalogue):** the OTHER mechanism class — leaving the round in place and accelerating its
TRANSPORT — is now also dead, by measurement rather than precedent. 08C-B's five-axis
feasibility inventory (service tier already priority; prompt-prefix cache engaged; connection
warm; predicted outputs unavailable on gpt-5.x/Responses; and `previous_response_id`/
Responses-WS state chaining probed 2026-08-17 at ~13 ms p50 for a 205× smaller payload —
`evidence-08c-b-prid-probe-2026-08-17.json`) found zero material headroom: the ~1.27 s
zero-reasoning terminal round is provider-side fixed overhead. Between this plan's four dead
release shapes and 08C-B's five dead transport axes, BOTH halves of the lever are closed; what
could ever reopen it is a provider protocol change (tool calls + terminal decision in one
round) or a Plan-06-era behaviour change that makes terminal-position content productive.

---

## 4. What kind of follow-up actually occurs — the measurement that must survive the park

The decisive question was never *how many* follow-ups, but *what kind*. **7 of 28 turns (25 %)**
emitted tool calls after round 0 (9 additional rounds), and Luna emitted up to **4 tool calls in one
round**, so multi-round turns are genuine sequencing, not a batching failure. (The table's "Later
rounds" cells aggregate possibly-multiple rounds per turn, so the 4-calls-in-one-round maximum is
not directly readable from it — it comes from the underlying per-round telemetry, not a table row.)

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

Note also `t-12` and `t-13`: the write lands in a **later** round. Any release must key off the
write, not off round 0.

### The 12-turn corpus (`8B9B2BDD-22FB-45B0-91A9-C2C83CDA16AD`, `eicr-backend:392`) — names-only screen, §7 deliverable 1

Queried directly from `/ecs/eicr/eicr-backend`'s `voice_latency.turn_core_summary` rows for this
session (no join — `tool_names_per_round` is complete per row), applying the same multi-round
predicate as the 28-turn corpus: a turn is multi-round iff
`tool_names_per_round.slice(1).some(names => names.length > 0)` (the terminal `end_turn` round is
always pushed as a trailing empty array and is excluded from that test). All 12 turns are
`gpt-5.6-luna` at `reasoning_effort: low`, matching §2's measurement session exactly (same 12
rows).

| Turn | Round 0 | Later rounds | Kind |
|---|---|---|---|
| t-1 | `record_board_reading` | — | single-round |
| t-2 | 3× `record_board_reading` | — | single-round |
| t-3 | `record_board_reading` | — | single-round |
| t-4 | `create_circuit` | — | single-round |
| t-5 | `ask_user` | `record_reading` | additive |
| t-6 | `add_board` | — | single-round |
| t-7 | `rename_circuit` | `create_circuit` | additive |
| t-8 | `create_circuit` | — | single-round |
| t-9 | `ask_user` | — | single-round |
| t-10 | `ask_user` | — | single-round |
| t-11 | `select_board` | — | single-round |
| t-12 | `create_circuit` | — | single-round |

**Zero corrective follow-ups in this 12-turn corpus** — no `clear_reading`, `clear_board_reading`,
`delete_circuit` or `rename_circuit` appears in any later non-empty tool-name array. `t-7`'s
`rename_circuit` is in **round 0**, not a later round, so it does not count as corrective per the
stated definition (only later-round appearances of those four names count) — it is classified
additive on the strength of round 0's `rename_circuit` being followed by a later, unrelated
`create_circuit`. 2 of 12 turns are multi-round (`t-5`, `t-7`); the other 10 are single-round and
structurally cannot produce a later-round correction.

**Honesty limit (carried into 08C per §7 deliverable 3):** same-slot overwrite corrections (a
later `record_reading` / `record_board_reading` / calculator write silently rewriting an earlier
same-turn write to the same field) are **not recoverable from this telemetry** — `tool_names_per_round`
records tool identity, not which slot a given call targeted, and `stage6_tool_call.round` is a
per-dispatcher-closure call counter, not the loop round (`stage6-dispatchers.js:139,330`), so no
join against it can recover round-attributed slot detail. **No zero-event bound is claimed for
that category, on either corpus.**

### Combined 40-turn bounds — the number that survives the park

§4's original 28-turn result was itself a names-level screen (identical method to the 12-turn
screen above), so the two corpora combine directly with no classifier-consistency caveat:

- **Total turns: 28 + 12 = 40. Multi-round turns: 7 + 2 = 9. Corrective follow-ups: 0 + 0 = 0.**
- **≤ ~7.5 % of all turns** — rule of three on 0/40 (was ≤ 10 % on 0/28). This is the figure a
  design is tempted to quote.
- **≤ ~33 % of multi-round turns** — rule of three on 0/9 (was ≤ ~43 % on 0/7). A single-round turn
  (31/40) *structurally cannot* produce a corrective follow-up; there is no later round to correct
  anything. The multi-round subset is the only population where an early release is actually a
  bet, so **this is the number any "does it degrade gracefully?" argument must be evaluated
  against.**

Both bounds tightened (not loosened) on the larger corpus — the null result strengthens, it does
not weaken. This does not alter §2's binding measurement or §7's decision; it is the corrective/
additive re-run §6 flagged as still open, now closed.

---

## 5. Round-2 findings against the fourth mechanism — recorded so they are not re-derived

The mechanism reviewed was: *"release the confirmation when the write has COMMITTED and the audio is
READY — whichever is later — instead of when the loop returns."* Six BLOCKERs, two independent
reviewers, converging on four distinct defects:

1. **There is no commit point to release on.** `dispatch_complete_ns` fires **per-round**, after that
   round's tool calls finish dispatching (`stage6-tool-loop.js:1215-1217`) — before the loop knows
   whether another round follows. Individual dispatchers mutate `session.stateSnapshot` and stage
   `perTurnWrites` at different moments (e.g. `stage6-dispatchers-circuit.js:642-647` mutates,
   `:714-718` stages). A multi-tool round has N partial mutation points, and tool 1 can commit while
   tool 2 rejects.
2. **The confirmation text is authored once, post-loop.** The bundler is a documented once-per-turn
   post-loop authority (`stage6-shadow-harness.js:14`, *"Pitfall #3 (bundler fires ONCE post-loop)"*;
   `stage6-event-bundler.js:4-11`). "Committed" therefore cannot mean "bundler-validated" without
   restructuring the bundler to run per-round.
3. **The barrel-miss cohort gets nothing.** (Miss-rate reconciliation, round 3: the wave's
   authoritative, doubly-reconfirmed figure is **78 % hit / 22 % miss** — Plan 07 + INDEX.md,
   re-confirmed 2026-08-10 by two independent re-analyses. The "37 %" this section originally
   quoted came from 08B's superseded round-1 sample (24 hit / 14 miss) and is NOT the
   wave-authoritative size; the qualitative claim below is unchanged.) On a miss there is no
   parked audio, and the client
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

## 6. The session landed — status of the three moves

The park condition was discharged 2026-08-11 by session `8B9B2BDD` on `eicr-backend:392` (12 turns).

1. **DONE — `reasoning_tokens` read on the terminal rounds.** The answer fits neither branch as
   posed: 0 on 10/12 (neither thinking nor meaningfully streaming — round-trip floor, §2). The
   "safe door" is additionally disproven at the transport level (§2); the 2/12 thinking cohort is
   the binding correctness constraint on any future 08C-side optimisation.
2. **DONE — §7 deliverable 1 executed:** the corrective/additive split of §4 re-run on session
   `8B9B2BDD` (names-only, no join — see §4). Zero correctives in the 12-turn corpus; the combined
   40-turn null result **tightens** both bounds (≤ ~7.5 % of all turns, ≤ ~33 % of multi-round
   turns).
3. **Mechanism decision TAKEN (round 1, per §2):** no fifth release mechanism under 08D. §2's
   measurement was exactly the evidence this step demanded, and it composes with the transport
   verification to close release-before-completion. The lever transfers to 08C.

## 7. Execution decision — what `/ep` ships (docs-only closure) — ✅ OWNER-CONFIRMED 2026-08-11

**Derek confirmed all three round-1 decisions at the walkthrough (2026-08-11): (a) docs-only
closure — no fifth mechanism, lever transfers to 08C; (b) the replication gate in §2's sample-size
caveat stands as written; (c) BOTH cross-plan edits (08C unpark, 08B §2.0 trim) ship in this
wave's diff.**

**08D ships NO runtime early-release mechanism.** The current transport has no safe pre-completion
terminal signal (§2), the measured dead time lies where only forbidden bets can reach it (§2), and
four mechanisms have already died here (§3, §5). The exploitable work — making the terminal round
cheaper or absent — moves to 08C's shrink/eliminate-round track. 08D closes as the measurement +
precedent + constraint record for the lever, so no future session re-derives or re-attempts it
blind.

`/ep` deliverables, in order — **the final diff must contain ONLY planning/reference/changelog
files** (explicitly out of scope: `src/`, `web/`, iOS clients, wire shapes, feature flags, ECS
configuration, TestFlight):

**Canonical plan artifact:** every deliverable below that edits or copies "this plan" means ONE
exact file — `PLAN-final.md` in this handoff folder (the file `/ep` is launched with). Deliverable
1 edits that file; deliverable 2 copies that same file. No other plan artifact is canonical.

1. **Run the §4 reclassification as a NAMES-ONLY corrective screen over the FULL 40-turn corpus
   (28 earlier + 12 from `8B9B2BDD`), with ONE consistent classifier — FIRST, before any other
   deliverable is committed.** (This SUPERSEDES the per-slot join recipe drafted in review rounds
   3-5: four consecutive review rounds each found a new defect in that machinery — wrong row
   semantics, a per-closure counter masquerading as the loop round, classifier inconsistency
   across the two corpora — so the churn circuit-breaker (§3) retired the premise rather than
   patching a fifth time. §4's original 28-turn result was itself a names-level screen, so
   names-only is the ONLY classifier that can be applied consistently to all 40 turns.)
   **Method:** query CloudWatch log group `/ecs/eicr/eicr-backend` for
   `voice_latency.turn_core_summary` rows whose session id matches `8B9B2BDD`. Each row's
   `tool_names_per_round` is COMPLETE for every dispatched tool including `ask_user` (populated
   once per loop iteration from the model's own tool records — `stage6-tool-loop.js:392,696`,
   emitted at `stage6-shadow-harness.js:~4269`) and needs NO join with any other row.
   **Multi-round predicate — the terminal `end_turn` round is pushed as an EMPTY array
   (`stage6-tool-loop.js:696`, pushed on EVERY round incl. `end_turn`), and 100 % of turns end
   with one, so `length > 1` would falsely classify every ordinary turn as multi-round and
   deflate the bound.** A turn is multi-round iff it has at least one NON-EMPTY tool-name array
   after index 0 — `tool_names_per_round.slice(1).some(names => names.length > 0)` — matching
   §4's population ("turns that emitted tool calls after round 0"). CORRECTIVE (the observable
   category) = any of `clear_reading` / `clear_board_reading` / `delete_circuit` /
   `rename_circuit` appearing in a later NON-EMPTY tool-bearing array; the 12-row table must
   distinguish or omit the trailing empty terminal array. Names count ATTEMPTS — a rejected corrective attempt still
   evidences the model correcting — which over-counts correctives; that is the conservative
   direction for any future release argument. Produce the 12-row table for `8B9B2BDD` (round-0
   names, later-round names, additive/corrective), write it + the updated bounds into §4 of
   `PLAN-final.md`, and recompute §4's two bounds over the combined 40-turn corpus **for this
   observable category only**. If ANY corrective is found, report the exact count and turn id(s),
   state plainly that the rule-of-three bound no longer applies to that population, and report
   the raw fraction instead — never silently apply the zero-case formula or omit the finding.
   This step does NOT re-derive or alter §2's binding measurements.
   **Honesty limit — state it in the table's caption AND carry it into 08C via deliverable 3:**
   same-slot overwrite corrections (a later `record_reading`/`record_board_reading`/calculator
   write silently rewriting an earlier same-turn write) are NOT recoverable from current
   telemetry — `stage6_tool_call.round` is a per-dispatcher-closure call counter, not the loop
   round (`stage6-dispatchers.js:139,330`, `stage6-dispatchers-answer.js:130,201,258`; the
   dispatcher ctx carries only `{sessionId, turnId}`, `stage6-shadow-harness.js:1715`), and
   round-attributed slot detail would need NEW runtime telemetry — outside this plan's docs-only
   scope (a separately approved plan if 08C wants it). **NO zero-event bound is claimed for that
   category, on either corpus.** iOS `debug_log.jsonl` is secondary corroboration ONLY.
   Fall back to the dated "not recoverable" note ONLY if the `turn_core_summary` rows themselves
   are missing or expired; do not fabricate the table.
2. **Sync the converged plan back into the repo:** copy `PLAN-final.md` (as updated by
   deliverable 1) over
   `.planning/voice-latency-conversational-2026-07-31/plan-08d-terminal-round-release.md`.
3. **Update the tracked 08C plan** (`plan-08c-per-round-cost.md`): flip its stale `PARKED —
   blocked on … :388` status to unparked, recording session `8B9B2BDD` / `eicr-backend:392` as the
   discharging evidence and noting its three-item checklist (revision `:388+`, `api_transport`
   split, `round_idx` keying) still needs independent confirmation when 08C's `/rp` opens.
   **Replace BOTH stale 08C passages that describe 08D as parked / possibly removing the round /
   choosing a mechanism** with the settled result (08D ships no runtime mechanism; the
   shrink/eliminate-round lever belongs to 08C). **08C's acceptance section must explicitly
   receive: the replication gate (§2), ALL FOUR §8 acceptance preconditions, and the §9
   audible-invariants block verbatim.**
4. **Trim 08B's superseded §2.0** (`plan-08b-stage6-round-levers.md`): replace the full section
   with a one-paragraph pointer at this plan (mirroring how the §1→08A and §1.1-1.4/2.2→08C splits
   are documented) and record the §2.0→08D split in 08B's split-provenance note. **Also strike or
   rewrite every OTHER 08B passage that presupposes a §2.0 mechanism will ship** — the 'Seam'
   section ("§2.0 may remove the terminal round entirely…"), the 'Web companion' §2.0 sentence,
   and the §2.0-specific 'Reviewer pressure points' bullets (candidate mechanisms 1-3, the
   audio-already-parked premise, the termination-signal hazard) — replacing each with a one-line
   pointer to 08D's closure, so 08B owns only §2.1 and a future 08B session cannot re-review the
   dead fourth mechanism. **Also update 08B's Status line** (currently `READY TO REFINE
   (2026-08-10)`) and any 08B wording claiming no `:388` field session has run or that 08C/08D
   are parked — reconcile every occurrence with session `8B9B2BDD` on `:392` and the docs-only
   closure. **Sweep rule for deliverables 3-5:** grep all three cross-plan files (08B, 08C,
   INDEX.md) for `PARKED`, `READY TO REFINE`, "field session", and future-session wording, and
   reconcile EVERY occurrence — including BOTH 08C rows in INDEX.md and the stale 08A Tier-B row
   claiming its telemetry fields are still empty pending a future session.
5. **Update the wave index** (`INDEX.md` in the same `.planning` folder): flip BOTH 08D rows (the
   Tier B table row and the 'Remaining latency plans' row) from `PARKED` to closed/docs-only
   status pointing at this plan, update the 2026-08-10 re-scope note ("08C and 08D are both
   parked…") to reflect the discharge, and update the 08C row per deliverable 3's outcome
   (unparked, pending independent checklist confirmation).
6. **Docs of record:** add the one-line hub `CLAUDE.md` changelog row (ending with the standard
   full-detail pointer) + the commit-body-level entry in `docs/reference/changelog.md`, stating the
   decision (no runtime mechanism; lever → 08C), the evidence (12-turn measurement), and its limits
   (single session; ratios provisional). **Hub-budget guard:** `CLAUDE.md` is at ~44,686/45,000
   chars — a new row WILL breach the CI-enforced budget (`scripts/check-hub-size.mjs`, blocking
   inside `Test Backend (Node.js)`, no path filter). Before committing, run
   `node scripts/check-hub-size.mjs`; drop the oldest 1-2 hub changelog rows as needed to stay
   under the 45,000-char / 35-row caps (their full detail already lives in
   `docs/reference/changelog.md` — follow the `4f313750` pattern).
7. **Commit per logical unit, open a PR, merge via the normal checks** (`main` is PR-only). Note:
   this docs-only diff still falls through `detect-changes` to `target=both`
   (`.github/workflows/deploy.yml:152` — unmatched paths deploy both services, defensively), so
   the post-merge push WILL run the normal frontend + backend build/deploy. Watch that run to
   completion through the standard delivery path (task-def revision increment + "Deploy to AWS
   ECS" job conclusion); do not trigger any additional manual deployment.

## 8. Acceptance preconditions this lever OWNS — inherited from the split, transferring to 08C

These were acceptance criteria of the combined 08B plan. They belong to the release-timing lever,
not to the board-scope lever, so they move here rather than being dropped. **08B's round-3 review
caught them as orphaned — after the split, no sibling owned them.** Each one guards a distinct way
this lever could claim a saving it did not make. **With §7's decision, they bind any FUTURE
optimisation of the terminal round (i.e. 08C's track), and §7 deliverable 3 carries them into 08C
so they survive the transfer:**

- **A nanosecond audio-ready stamp exists and is populated before any saving is claimed.**
  `audible_first_byte_ms` is null on 100 % of turns today. **Do not implement it from the combined
  plan's original recipe — that recipe was wrong** (round-2 BLOCKER #4): the field is a hardcoded
  `null` literal at `stage6-shadow-harness.js:4285-4286`, not an unpopulated allowlist entry, so
  adding it to `attributeRoundUsage`'s allowlist would change nothing while looking correct. The
  real sites are `recordOutcome`'s `meta` in `loaded-barrel-speculator.js:~1010` and the harness
  literal itself.
- **Barrel HIT and MISS cohorts reported separately, never blended.** The mechanism differs (serve
  parked audio vs start synthesis earlier) and so does the win. Authoritative miss-rate: **22 %**
  (Plan 07's doubly-reconfirmed 78/22; an earlier 08B round-1 sample read 37 % — superseded, see
  §5 point 3) — and 08B's round 2 established the MISS cohort may get *nothing* from this lever
  through the current wire path, so blending the two would manufacture a saving that does not
  exist for roughly a fifth of turns.
- **Plan 06 (conversational lane, `.planning/voice-latency-conversational-2026-07-31/plan-06-general-conversational-lane.md`)
  has a GO and touches the same tool loop.** 06 changes what the
  model is expected to *say*; this lever changes when the human stops waiting for it. **Re-read 06
  before 08C selects or details a terminal-round mechanism, not after** — and whichever ships
  second re-baselines against the first, not against the pre-08B numbers.
- **The 08C §1.1 interaction is SHARPER here, not moot.** A reasoning model with reasoning turned
  down may fail to cleanly `end_turn`; under a release-before-loop-return design it then burns round
  cap and cost *after* the inspector has been released and moved on. Today that failure is at least
  audible as a long silence. Re-read 08C §1.1 against any terminal-round mechanism 08C selects
  before probing effort below `'low'`.

## 9. Non-negotiable, whatever optimisation eventually ships

The audio-first invariants hold: every applied dictated reading is spoken **exactly once** — not
zero, not twice; structurally complete readings are written regardless of self-reported confidence;
speculative and cancelled work is never spoken or written; every rejection stays audible. **Every
forwarded turn for which the processing chime fired receives exactly one audible terminal response
— including no-write, no-op, rejection, timeout, cancellation, cap-hit, reconnect, and
thinking-terminal paths; no early release or terminal-round optimisation may ever cancel or
suppress that fallback.** A design that speaks earlier by speaking twice is a regression wearing a
latency plan's clothes. A corrective follow-up arriving after release would have to be spoken as an
**explicit correction** that references and supersedes what was already said — which is very likely
a **new wire shape**, and therefore a MANDATORY Web-companion trigger, not a backend-only change.
This block transfers into 08C verbatim with §7 deliverable 3.

## Web companion

N/A — this plan ships no runtime change; the final diff is restricted to
planning/reference/changelog files (§7). No client-visible behaviour changes, so no parity-ledger
row is required.
