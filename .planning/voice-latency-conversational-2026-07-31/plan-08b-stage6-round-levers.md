# Plan 08B — Round-count levers

Status: **READY TO REFINE (2026-08-10).** Every item is evidenced from telemetry that has already
shipped or from a verified source read. **Needs no 08A data.**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

**Section numbers are deliberately unchanged by the split** — §2.0 and §2.1 keep the names they are
already referenced by elsewhere (INDEX.md, the 08A execution log). Do not renumber them to close
the gap left by the removed §1.

Split twice on 2026-08-10:

1. Out of a single Plan 08, so [08A](plan-08a-stage6-round-instrumentation.md) could ship
   immediately instead of waiting behind a review of levers nobody could yet choose between.
   **08A is now SHIPPED and LIVE (`eicr-backend:388`).**
2. Again, into this plan and [08C](plan-08c-per-round-cost.md), because 4 of the original 7 items
   (§1.1–1.4) were of the form *"if 08A's data shows X, then Y"* — and there is still no field
   session on `:388`. Refining them now would pay full reviewer cost every round to re-raise one
   finding: that the conclusions rest on measurements that do not exist. §2.2 went with them
   because its first hypothesis is settled by 08A's cached-token counts. **08C is parked until that
   session happens.**

**The seam is `how many rounds` versus `what each round costs`.** This plan reduces the *number* of
provider round-trips per turn — loop termination and validator acceptance. 08C reduces the *cost of
each* — reasoning effort, round-1 model, prompt snapshot size. Independently shippable, different
risk profiles, different evidence.

[Plan 07](plan-07-loaded-barrel-value-audit.md)'s verdict is in and it resolves **in favour** of
this plan. The worry was that Loaded Barrel already hides the extra rounds; it does not. The barrel
removes ≈298 ms and — decisively — its parked audio **cannot be advertised until the loop returns**
(`stage6-shadow-harness.js:1489-1492`: the audio is *"ready and waiting, just not advertised"*;
iOS learns of it via the canonical confirmation POST that `runLiveMode` emits *post*-`runToolLoop`).
Barrel and round count are therefore **additive**, not overlapping.

## The target

From four live Luna field sessions (2026-08-06/07), perceived latency is near enough
**round count × per-round stream time**:

| Measure | n | p50 | p95 | max |
|---|---|---|---|---|
| Per-round Luna `stream_ms` | 41 rounds | **3.22 s** | 5.46 s | 9.04 s |
| Turn perceived latency | 15 turns | **6.76 s** | 15.86 s | — |

Round histogram (28 turns): 2 ×21 (75 %), 3 ×5 (18 %), 4 ×2 (7 %).

The two levers here are **unequal in value**, and the ordering was **corrected on 2026-08-10** —
the original framing called round count a 25 % tail lever, which missed that *every* turn carries a
terminal round:

- **§2.0 the discarded terminal round attacks 100 % of turns** — 24 % of perceived latency,
  measured, and the largest single lever found anywhere in this wave.
- **§2.1 the `board_id` vocabulary gap attacks the tail** — two live rounds burned on validator
  rejections, and it is an open failure *class*, not one bug.

## §2.0 — The terminal round is discarded, and the inspector waits for it — **LEAD LEVER**

**From shipped telemetry (28 turns / 65 rounds, 4 live Luna sessions).** This is the largest
measured lever in the wave, by roughly an order of magnitude.

Every turn ends with an `end_turn` round that calls no tool. Measured:

| | |
|---|---|
| Turns ending in a no-tool `end_turn` round | **28 / 28 (100 %)** |
| Its `stream_ms` | p50 **1712 ms**, mean **1931 ms** |
| Share of all model-loop time | **28.0 %** (54.1 s of 193.4 s) |
| Share of perceived turn latency | **24 %** (mean turn 8124 ms) |
| Output tokens it produced, across all 28 turns | **208 total** (p50 **4** per round) |

Those tokens go nowhere:

- **Never spoken.** All 28 turns are `path_classification: bundler_only` — the spoken confirmation
  is server-authored by the bundler. The model is mute by design.
- **Never remembered.** Next-turn history is `JSON.stringify(toolUseBlock.input)`
  (`eicr-extraction-session.js:2874`) — the *tool call's arguments*, not the closing prose.
- **Not needed for the write.** The write is dispatched in the preceding round.
- **Not needed for the audio.** Loaded Barrel has already synthesised and parked it. This is the
  premise the whole section rests on, so it is measured directly rather than inferred: on **18 of
  18** turns where both timestamps exist, the audio-ready stamp **precedes** loop completion —
  no exceptions, no turns in the other direction. Median lead **1596 ms**, range **843 ms to
  12,628 ms**. That median independently reproduces the terminal round's p50 of 1712 ms from a
  different pair of clocks, and the 843 ms floor matters more than the median: even the *worst*
  measured turn had the audio parked and waiting for most of a second. The 12.6 s outlier is not
  evidence of a better win — it is a slow turn, and it belongs to the ~9 % barrel tail queued
  separately.

So its only function is to signal *"I have nothing more to do"* — and the inspector pays ~1.9 s of
silence to hear it, with the audio sitting ready and the reading already committed.

**Why this is not simply deletable, and what the plan must therefore decide.** The loop cannot know
in advance that the model is finished: **9 / 28 turns (32 %) did emit further tool calls** after
round 0, and Luna is not merely failing to batch — it emitted up to **4 tool calls in one round**,
so multi-round turns are genuine sequencing (e.g. `inspect_session_state` → `record_reading`), not
an artefact. Blindly stopping after the first tool round would truncate a third of turns. Three
candidate mechanisms, to be chosen in review, **not** pre-judged here:

1. **Terminal-by-contract** — the server ends the turn without another provider round when the
   dispatched tool set is known-terminal and nothing is pending. Cheapest; needs an explicit,
   defensible terminal set.
2. **Model-declared completion** — an optional `turn_complete` on the write tools; absent ⇒
   today's behaviour, so it fails safe. Cheap, but note the precedent that a model's self-report
   is not automatically trustworthy (CLAUDE.md is explicit about `confidence`).
3. **Speculative release** — emit the confirmation as soon as the write commits and let the
   termination round continue in the background, applying any late tool call as its own turn.
   Biggest win, biggest blast radius; must be argued against "read back exactly once".

**Non-negotiable in every option:** the audio-first invariants hold — every applied reading is
spoken exactly once, nothing speculative is spoken or written, and barge-in stays safe. A design
that speaks earlier by speaking twice is a regression, not a win.

## §2.1 — The `board_id` vocabulary gap — verified, same class as the shipped `'main'` fix

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

## Seam — what the split gives up, stated so it is not lost

08C reduces the cost of each round; this plan reduces how many there are. They **multiply**, so:

- **Neither plan's win may be claimed from a deploy containing both.** Whichever ships second
  re-baselines against the first, not against the pre-08B numbers. 08C carries the matching note.
- **§2.0 may remove the terminal round entirely; 08C §1.1 may make the model worse at deciding it
  is done** (a reasoning model with reasoning turned down cannot cleanly `end_turn` — see the
  documented hazard there). If this plan ships a mechanism that stops depending on the model's own
  termination signal, that hazard changes character. Re-read it rather than assuming it went away.
- Nothing else crosses the seam. No wire contract, no client half, and no deliverable is orphaned
  between the two plans — §2.0 and §2.1 are both server-side loop/validator concerns, and 08C is
  entirely config and prompt-size.

## What this plan is NOT

- **Not a cost-reduction plan.** Cache hit rate is 100 %; Plan 01 took the cost win. A token saving
  here is a side effect to report honestly, never a justification.
- **Not a licence to reduce rounds by making the model less careful.** A turn that finishes faster
  by skipping the round in which it verifies its own write is a correctness regression wearing a
  latency plan's clothes.
- **Not authorised to touch the audio-first invariants.** Every applied dictated reading is spoken
  exactly once; structurally complete readings are written regardless of confidence; speculative
  and cancelled work is never spoken or written; every rejection stays audible.
- **Not a per-round-cost plan.** Reasoning effort, round-1 model choice and prompt snapshot size all
  live in 08C. If refinement starts reaching for them, that is a signal the seam was drawn wrong —
  say so explicitly rather than quietly widening scope.

## Web companion

§2.0 is backend-only and wire-neutral — a shorter tool loop is invisible to both clients. It changes
*when* the existing confirmation is emitted, not its shape.

**§2.1 option (b) is not.** It changes which tool calls are accepted, therefore which spoken notices
a user hears, therefore client-visible behaviour. If (b) is chosen, this plan needs a real
Web-companion section or a dated `web/docs/parity-ledger.md` row **with a named owner** before it
converges. This paragraph is not that row.

## Acceptance

- Each lever flagged and rollback-able **independently**, so its effect stays attributable — the
  same rule Plan 03 imposes on connection reuse versus voice settings, for the same reason.
- Report p50/p75/p95 with sample counts, split by reading versus question and by round count.
  **Report sample size honestly**: the analysis behind this plan rests on 15–41 observations from
  four sessions — enough to locate a bottleneck, not enough to certify a 10 % improvement.
- **Hold the model era constant.** Filter on `round_usage` presence — it is the era discriminator
  (pre-Luna rows lack it). This is not hypothetical: Plan 07's retracted *"barrel is 35 % slower"*
  read came from a canonical arm that was 100 % pre-Luna traffic, so it measured the model swap.
- Tool-loop, reasoning-continuity, cancellation, usage-accounting and audibility suites green.
  Field-replay gate green.
- No conclusion rests on a `dispatch_ms` value that includes an `ask_user` human wait. 08A shipped
  `blocking_ask_user_dispatched` to label exactly those rounds — this plan must actually use it.
- If 08C has already shipped, the baseline is post-08C. Say which baseline every number is against.

## Reviewer pressure points

- §2.0 rests entirely on *"the audio is already parked"*. It is now measured 18/18 with an 843 ms
  floor — but does any turn shape exist where it is false? A barrel **miss** is the obvious
  candidate (22 % of turns) and the section does not currently distinguish them. If the premise
  fails on misses, does the lever shrink to 78 % of turns, or does it survive intact?
- Does any candidate mechanism speak the confirmation **twice**, or speak it for a write that a
  late tool call subsequently changes? Mechanism 3 (speculative release) is where to look hardest.
- Under mechanism 1, what exactly is the "known-terminal tool set", and what happens the first time
  the model emits a genuine follow-up after one of them?
- Does any §2.1 change make a rejection silent? Any path that turns `wrong_board` back into a
  silent drop re-creates the 2026-08-06 field bug and fails outright.
- Can `'*'` reach a gated mutator as anything other than a rejection?
- Are gains here separable from 08C, Loaded Barrel, Plan 02 and Plan 03, or would a combined deploy
  make all of them unattributable?
