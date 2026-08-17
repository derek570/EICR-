# Plan 08B — Round-count levers

Status: **§2.1's code SHIPPED BY HAND 2026-08-11** (three commits; `/rp` hit the round-20 cap
without converging — a process failure, not an unresolved-risk signal; see INDEX.md for the full
account). **§2.0 (the terminal round) split fully out into [Plan 08D](plan-08d-terminal-round-release.md),
which closed docs-only 2026-08-11 with no runtime mechanism** (session `8B9B2BDD`,
`eicr-backend:392`). **This plan now owns only §2.1, whose code has already shipped** — see the
note at the top of §2.1 below for what landed; nothing here is queued for a future `/rp`.
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

**Section numbers are deliberately unchanged by the split** — §2.0 and §2.1 keep the names they are
already referenced by elsewhere (INDEX.md, the 08A execution log). Do not renumber them to close
the gap left by the removed §1.

Split three times, all on 2026-08-10 (08D, the plan the third split produced, went on to close
docs-only the following day, 2026-08-11):

1. Out of a single Plan 08, so [08A](plan-08a-stage6-round-instrumentation.md) could ship
   immediately instead of waiting behind a review of levers nobody could yet choose between.
   **08A is now SHIPPED and LIVE (`eicr-backend:388`).**
2. Again, into this plan and [08C](plan-08c-per-round-cost.md), because 4 of the original 7 items
   (§1.1–1.4) were of the form *"if 08A's data shows X, then Y"* — and at the time there was no
   field session on `:388`. Refining them now would have paid full reviewer cost every round to
   re-raise one finding: that the conclusions rest on measurements that do not exist. §2.2 went
   with them because its first hypothesis is settled by 08A's cached-token counts. **That field
   session has since run** (session `8B9B2BDD`, `eicr-backend:392`, 2026-08-11) — 08C is unparked,
   pending independent confirmation of its own three-item unblocking checklist before its `/rp`
   opens.
3. §2.0 split a third time, into its own plan [08D](plan-08d-terminal-round-release.md), after
   round 2 of **this plan's own `/rp`** produced six BLOCKERs against §2.0's proposed release
   mechanism — the *fourth* attempt at this lever — while §2.1 below drew zero findings from
   either reviewer. **08D closed docs-only on 2026-08-11**: the current transport has no
   trustworthy pre-completion no-tool signal, every proposed mechanism shape has now failed in
   production or review, and 08D ships no runtime early-release mechanism. The terminal round's
   shrink/eliminate-round lever transferred to 08C. **This plan now owns only §2.1.**

**The seam was `how many rounds` versus `what each round costs`.** This plan (now §2.1 only)
reduces provider round-trips wasted on validator rejections. 08C originally reduced the *cost of
each* round — reasoning effort, round-1 model, prompt snapshot size — and, since 08D's closure,
also owns the transferred shrink/eliminate-terminal-round lever, which may touch either round
count or round cost depending on what mechanism 08C eventually selects. Independently shippable
from this plan, different risk profiles, different evidence.

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
  measured, and the largest single lever found anywhere in this wave. (This lever has since moved
  to 08D, which closed docs-only 2026-08-11 with no runtime mechanism — see §2.0 below.)
- **§2.1 the `board_id` vocabulary gap attacks the tail** — two live rounds burned on validator
  rejections, and it is an open failure *class*, not one bug.

## §2.0 — The terminal round is discarded, and the inspector waits for it — **MOVED to Plan 08D, CLOSED**

This section split into its own plan after round 2 of this plan's own `/rp`, when two independent
reviewers produced six BLOCKERs against the release mechanism proposed here — the *fourth* attempt
at this lever — while §2.1 below drew zero findings from either reviewer. The three candidate
mechanisms originally sketched here were never implemented; they were superseded, before any
attempt, by 08D's own more thorough review of the same territory. [Plan 08D](plan-08d-terminal-round-release.md)
carries the full measurement, precedent record, and mechanism history, and it **closed docs-only
2026-08-11** (session `8B9B2BDD`, `eicr-backend:392`): the current transport has no trustworthy
pre-completion no-tool signal, every mechanism actually proposed and reviewed there has since
failed in production or review, and 08D ships no runtime early-release mechanism. The
shrink/eliminate-round lever transferred to [08C](plan-08c-per-round-cost.md), which now carries
08D's replication gate and acceptance preconditions verbatim. **This plan owns only §2.1 below.**

## §2.1 — The `board_id` vocabulary gap — verified, same class as the shipped `'main'` fix

**Code shipped by hand 2026-08-11** — see `docs/reference/changelog.md`'s 2026-08-11 `board_id`
entry for exactly what landed. The proposal text below (including the still-open (a)/(b) choice
and the reviewer pressure points) is retained as the design record this implementation came from,
not as a still-pending decision.

Two live rounds were spent on validator rejections of `board_id: 'current'` and `board_id: '*'`.
Mechanism verified in source:

- `validateBoardScope` (`stage6-dispatch-validation.js:719-731`) rejects any supplied `board_id`
  not string-equal to the expected id. There is no alias vocabulary. Note the expected id is
  `snapshot?.currentBoardId ?? getMainBoardId(snapshot)` (`:722`) — `currentBoardId` in practice,
  but do not write the fallback out of the design.
- `normaliseBoardScopeInput` (`stage6-multi-board-shape.js:121-140`) canonicalises exactly two
  things: the empty string (`:123-126`), and `'main'` under the three conjunctive conditions added
  2026-08-06 (`:127-137`). `'current'` is handled nowhere.
- `'*'` is untouched **by omission** — it simply matches neither branch. The docstring at `:80-81`
  records that as deliberate (*"NOT a board id and is passed through untouched"*), but it is a
  comment, not the mechanism. The mechanism is that the function has no third branch.
- **The exempt surface is wider than the `'*'` case, and it constrains option (b).**
  `validateBoardScope` exempts five tool families (`:701-710`), and the normaliser separately
  refuses to touch `select_board`, `clear_board_reading` and `record_board_reading`
  (`stage6-multi-board-shape.js:83-86`) precisely so an injected empty id keeps REJECTING rather
  than silently retargeting a destructive write. **`mark_distribution_circuit` is the sharp
  one:** its `board_id` names the *source* board of the distribution relationship, so it means
  something different by the argument (`:708-710`). Any alias added to the shared normaliser is
  applied to whatever flows through it — an alias meaning "the board I am on" is not obviously
  correct for an argument meaning "the board this circuit comes from".
- The tool schema (`stage6-tool-schemas.js:254`) already says *"There is no board id 'main'"*, and
  already prefers omission — it opens *"PREFER OMITTING THIS"* and names the `wrong_board`
  consequence. So the schema is not silent; it enumerates one blocked spelling and one blocked
  category ("not a designation … and not a board TYPE") without ever stating what IS accepted
  beyond "the EXACT board id copied from the BOARDS section". Whether `'current'` failed *despite*
  that wording or *because* the wording is a list of prohibitions is the question option (a)
  turns on, and it is not yet answered.

**This is the same failure class as the 2026-08-06 field bug** — the model reaches for a natural
word meaning "the board I am on", the validator rejects it, a round burns. That wave fixed one
word. The class is open.

Preferred shape: state the accepted vocabulary **positively** instead of enumerating blocked
spellings one field incident at a time. Two candidate mechanisms; pick one, do not do both:

- **(a) Schema/prompt only** — say what IS accepted ("omit it, or the exact id from the BOARDS
  section"). Cheapest, zero mutation risk, relies on model compliance.
- **(b) Normaliser alias** — extend `normaliseBoardScopeInput` to canonicalise `'current'` the way
  `''` is canonicalised, to ABSENT, the one unscoped spelling every downstream reader already
  agrees means `currentBoardId`. Deterministic, but the normaliser is **shared**, so the alias
  lands on every tool that flows through it — including `mark_distribution_circuit`, whose
  `board_id` means the *source* board. It must inherit the `'main'` fix's conjunctive discipline
  and the existing refusal to touch `select_board` / `clear_board_reading` /
  `record_board_reading`. If it cannot be scoped to destination-`board_id` tools only, that is an
  argument for (a), not a detail to paper over.
  **`'*'` must NOT be aliased on gated tools** — a broadcast silently retargeted at one board would
  corrupt the certificate. Rejecting it is correct; it need only reject *audibly*, which the
  `wrong_board` partial-failure family (2026-08-06) already provides.

Invariant either way: **`wrong_board` speaks.** Whatever is not accepted must be audible, never
silently dropped. That is the entire lesson of 2026-08-06 and this plan must not regress it.

## Seam — what the split gives up, stated so it is not lost

08C originally reduced the cost of each round; this plan (now §2.1 only) reduces how many are
wasted on validator rejections. They **multiply**, so:

- **Neither plan's win may be claimed from a deploy containing both.** Whichever ships second
  re-baselines against the first, not against the pre-08B numbers. 08C carries the matching note.
- **§2.0 moved to 08D and closed docs-only (2026-08-11) — it does not remove the terminal round.**
  08C §1.1's termination hazard (a reasoning model with reasoning turned down cannot cleanly
  `end_turn`) is therefore undiluted by any since-abandoned §2.0 mechanism; it stays exactly as
  sharp as documented there, unchanged by this split.
- Nothing else crosses the seam. No wire contract, no client half, and no deliverable is orphaned
  between the two plans — §2.1 is a server-side validator concern; 08C's original scope was config
  and prompt-size only, but it has since also inherited 08D's shrink/eliminate-terminal-round
  lever (08D §7 deliverable 3), which may touch round count as well as cost.

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

§2.0 moved to 08D and closed docs-only with no client-visible change (08D ships nothing to the
wire). This plan's own web-companion exposure is §2.1's alone.

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

- §2.0's mechanism-choice pressure points (the audio-already-parked premise, whether a candidate
  mechanism speaks a confirmation twice, the "known-terminal tool set" question) moved to 08D with
  the section and are now moot: 08D closed docs-only 2026-08-11 with no runtime mechanism, so
  there is no candidate to pressure-test here. See 08D §3/§5 for the full record of every
  mechanism actually proposed and reviewed there, and why each one failed.
- Does any §2.1 change make a rejection silent? Any path that turns `wrong_board` back into a
  silent drop re-creates the 2026-08-06 field bug and fails outright.
- Can `'*'` reach a gated mutator as anything other than a rejection?
- **`normaliseBoardScopeInput` is shared.** Under option (b), enumerate every tool whose input
  reaches it and say what `'current'` would mean for each — specifically
  `mark_distribution_circuit`, where `board_id` is the *source* board, not the destination.
  An alias that is right for a write is not automatically right for a relationship argument.
- Is the §2.1 problem even a prompt problem? The schema already opens *"PREFER OMITTING THIS"*.
  If the model read that and still sent `'current'`, option (a) is proposing more of what already
  failed — say so rather than shipping another sentence.
- Are gains here separable from 08C, Loaded Barrel, Plan 02 and Plan 03, or would a combined deploy
  make all of them unattributable?
