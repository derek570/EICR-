# Plan 08C-B — Terminal-round shrink/eliminate lever

Status: **CLOSED docs-only 2026-08-17 — deliverable 1 (feasibility) resolved to NO VIABLE
MECHANISM; see the dated closure section at the end.** Split out of the combined 08C at the
round-1 walkthrough (Derek, 2026-08-11, Option A). This chunk was the sole owner of the
terminal-round shrink/eliminate lever
transferred from Plan 08D's docs-only closure (08D §7 deliverable 3), together with its
replication gate, the four acceptance preconditions, the honesty limit, and the §9 invariants.
It chains SECOND in the batch: [08C-A](plan-08c-a-per-round-cost.md) (config probes + prefix/snapshot pair) ships
first, and every number this plan claims re-baselines against post-A, never pre-08B.
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`

**Mechanism status: UNSELECTED — and FEASIBILITY IS THE FIRST GATE, before any build (round-3
restructure).** Five release-before-completion shapes are dead (four historical precedents, 08D
§3, plus 08D's own "safe door" hypothesis, disproved at the transport level within 08D's refine
cycle: the transport has no trustworthy pre-completion no-tool signal — terminality is knowable
only post-completion, verified in source). The round-3 review sharpened the problem to its core
causal contradiction: **a terminal round can be classified zero-reasoning only AFTER its response
completes — when its latency is already spent.** Any decision to *skip* or *suppress* the round
must precede that observation and is therefore a predicted-terminality shortcut that can touch
the thinking cohort — banned by constraints 1 and 3. What is NOT automatically banned is a
mechanism that changes the round's COST without conditioning on its content (e.g. transport-level
acceleration applied to every terminal-position call equally, harming neither cohort) — whether
any such mechanism exists with material headroom is exactly the feasibility question.
**Deliverable 1 below is that feasibility decision; nothing is built before it resolves.** "No
viable mechanism — close docs-only" is an acceptable, precedented converged answer (08D), and if
feasibility fails, the audio-ready telemetry does NOT ride along as a dead prerequisite — it
either ships under its own separately-argued observability justification or not at all.

## Review protocol (binding for this plan's refine + execution cycle)

Identical to [08C-A](plan-08c-a-per-round-cost.md)'s Review protocol section — Sonnet `certmate-plan-reviewer` +
Codex `gpt-5.6-sol` high, never downgraded; Codex prompt hygiene (read-only preamble, no
refine-skill token, `outputLastMessage`); dead-lens detection; cap → report, never force;
three-BLOCKER churn circuit-breaker (it fired on 08D and simplified the plan — expect it to be
the most likely outcome here too if mechanism design churns). Sibling cross-referencing: every
review round receives PLAN-A as an input; round 1 must ask *"what did the split lose — which
deliverable does NO sibling own?"*

## What the lever is

From the confirmed session `8B9B2BDD` data (post-08B baseline, `eicr-backend:392` — the `:393`
label in older docs is a proven mislabel, see PLAN-A's Status; 12 turns / 26 rounds, single
session, all ratios provisional):

- Every turn in the corpus ends with a terminal round whose ONLY job is to let the model observe
  its tool results and emit `end_turn`.
- On 10/12 turns that terminal round emitted **zero reasoning tokens and exactly 4 output
  tokens** with 0 tool calls, yet cost `stream_ms` p50 **1,267 ms** (min 789, max 3,477) — a
  round-trip floor, not generation. Same-denominator shares, this corpus: terminal rounds are
  **34.0 % of summed round `stream_ms`** across the 12-turn session, and the zero-reasoning
  subset alone is **24.4 %** — round-stream time spent discarding 4 tokens. (The earlier
  "~24 % of every turn" phrasing came from the older 28-turn corpus with a broader whole-turn
  denominator; do not mix the two.)
- On 2/12 turns (**17 %, provisional**) the terminal round genuinely thinks (turn 3: 11
  reasoning / 17 output tokens; turn 9: 29 / 35). **These turns must never be silenced,
  truncated, or made inaudible** — the thinking-terminal cohort is where corrections and
  summaries live.

The lever: **shrink the terminal round's cost, or eliminate the round, for the ~83 %
zero-reasoning cohort — without releasing, skipping, suppressing, or classifying any output
before completion, and provably without touching the thinking cohort.** (A content-independent
treatment that acts before/during the call — e.g. transport-level acceleration applied equally to
every terminal-position call — is not automatically banned; conditioning on the round's CONTENT
before completion is. See constraint 1.)

## Constraint space (all binding; a mechanism violating any one is dead on arrival)

1. **No output decision before completion (reframed round 4 for precision).** No output may be
   released, skipped, suppressed, truncated, or classified as terminal before the response
   completes: no early TTS release, no mid-stream filtering, no predicted-terminality shortcuts.
   `VOICE_MID_STREAM_FILTER`'s machinery exists and looks finished
   (`stage6-shadow-harness.js:1385`, `:2504-2545`) — a production-failure remnant of a closed
   alternative, **not an implementation asset**. What this constraint does NOT ban: a
   **content-independent pre-call/transport treatment** applied uniformly to the ENTIRE eligible
   post-tool-call cohort, provided it is proven semantically and audibly inert on both cohorts —
   that is the only candidate class deliverable 1's feasibility gate may pass.
2. **The audio-first invariants override any latency win** (verbatim apparatus below): exactly
   -once read-back; structurally complete readings always written; a fired chime ALWAYS gets a
   TTS response; every rejection audible.
3. **Thinking-terminal rounds stay correct and audible.** Any mechanism must be provably inert on
   the ~17 % cohort — not "unlikely to fire", inert.
4. **Wire-shape honesty.** 08D §9 warns a corrective follow-up after any early release would very
   likely need a NEW wire shape — a MANDATORY Web-companion trigger. Whether a selected mechanism
   is wire-neutral must be assessed at selection, never assumed.
5. **Same-slot overwrite honesty limit** (verbatim below): the telemetry cannot see same-slot
   overwrite corrections; no zero-event bound may be claimed for that category.
6. **`stage6_tool_call.round` is a per-dispatcher-closure call counter, NOT the loop round**
   (`stage6-dispatchers.js:139,330`) — no join against it can recover round-attributed detail.
   This cost 08D's refine cycle four rounds; do not re-learn it.
7. **Plan 06 interaction:** Plan 06 (conversational lane,
   `.planning/voice-latency-conversational-2026-07-31/plan-06-general-conversational-lane.md`)
   has a GO and touches the same tool loop — 06 changes what the model is expected to *say*;
   this lever changes when the human stops waiting for it. **Re-read 06 BEFORE selecting or
   detailing a mechanism, not after.**
8. **PLAN-A §1.1 interaction:** a reasoning model with reasoning turned down may fail to cleanly
   `end_turn`; under any terminal-round design that failure must stay at least audible. Re-read
   PLAN-A §1.1 against any selected mechanism before probing effort below `'low'` in
   combination.

## Ordered deliverables (round-3 restructure: feasibility BEFORE any build)

1. **Feasibility decision — the gate everything else waits on.** Name ONE candidate mechanism
   with: (a) a **predicate available BEFORE the prospective terminal call is issued** (or a
   demonstration that the mechanism needs no content predicate at all — e.g. it applies equally
   to every terminal-position call), and (b) a **proof it cannot suppress, truncate, or alter any
   thinking or corrective terminal response** — inert on that cohort by construction, not by
   likelihood. Reconcile the predicate explicitly against the predicted-terminality prohibition
   (constraint 1). **If no candidate survives, close this plan docs-only IMMEDIATELY** — record
   the disproof alongside 08D's five dead shapes, and do NOT proceed to deliverables 2–4. The
   audio-ready telemetry then does not ride along as a prerequisite to an impossible mechanism;
   if it is still wanted, it must be argued as its own observability follow-up.
2. **Audio-ready telemetry (only if deliverable 1 passes) — no saving may be claimed before this
   populates.** `audible_first_byte_ms` is null on 100 % of turns today.

   > **Circuit-breaker note (round 5).** This spot produced BLOCKERs in refine rounds 3, 4 AND 5
   > — each time a prose line-map of `routes/keys.js` control flow drifted from source in a new
   > way (and the 08D-era recipe before it was wrong twice). The premise was wrong: a plan
   > document must not carry a normative line-site map of live control flow. What follows is the
   > **normative CONTRACT**; stamp PLACEMENT is delegated to implementation time against the
   > then-current source, and the contract is enforced by TESTS, not by citations.

   **The contract:**
   - **Separate named fields per event** — speculative-audio-ready, server-response first write
     (`server_first_write_ns`), vendor first byte (`vendor_first_audio_ns`), actual playback.
     Never conflate them; never rename an existing field's meaning.
   - **Two INDEPENDENT dimensions on every row:** `delivery_mode ∈ {hit_write, streaming,
     buffered}` (how the response bytes were produced) and `cache_outcome ∈ {hit, miss,
     pending_timeout, claim_lost, ineligible_or_bypass, lookup_error}` — and `cache_outcome` is
     set from the ACTUAL cache-lookup path, **never inferred from the response-write site** (the
     fresh-synthesis paths also serve requests that never did a barrel lookup: non-confirmation
     sources, missing identifiers, streaming-ineligible requests, setup fallbacks).
     `lookup_error` is its own value because the cache block catches import/build/peek/claim
     errors and falls through to fresh synthesis — a FAILED lookup is neither a `miss` nor
     `ineligible_or_bypass` and must not be folded into either; test it through both the
     streaming and buffered fallbacks.
   - **One-shot latch:** a request-local `serverFirstWriteNs = null` latch, set exactly once
     immediately before the FIRST response write and never restamped — the streaming path's
     `onAudio` fires once per audio frame, so an unlatched at-the-write stamp emits multiple
     "first" stamps. No write ⇒ no stamp. This latch behaviour gets its own test.
   - **Identifier scoping:** the metric is scoped to requests carrying `sessionId` + `turnId`
     (identifiers nullable on legacy/backward-compatible requests, which are excluded from the
     metric rather than mislabelled). Carry `{sessionId, turnId, correlationId, source}` where
     present.
   - **Publication:** through a delayed, correlated audio-summary event that may land AFTER the
     iOS TTS POST — the immutable `turn_core_summary` row is emitted before that POST, so **do
     not promise a non-null `audible_first_byte_ms` in the core row**; cancelled turns skip the
     core summary entirely. Actual audibility stays anchored to the iOS playback-start ACK (the
     Loaded Barrel Plan 07 machinery) — the sole actual-audibility boundary.
   - **Known-wrong sources, do not use:** `loaded_barrel_fired` (fires after the full
     speculative MP3 buffer is assembled, not at first byte); `recordOutcome` alone (log-only;
     returns no state); the streaming path's existing post-hoc `firstByteMs` (derived from
     resolved synth timings, not a write stamp).

   *Informative, verify-at-implementation-time site pointers (NOT normative, and deliberately
   WITHOUT cache classification — the lookup path, not the write site, determines
   `cache_outcome`; note the lookup is skipped entirely when `sessionId` or `turnId` is
   absent):* candidate response-write locations currently sit at `routes/keys.js` `:446`,
   `:499`, `:275`, and the buffered/legacy path's vendor first-byte capture at `:676-683` with
   the terminal `res.send(buffer)` afterwards.
3. **Dark build** — implemented behind its own flag, independently rollback-able, OFF by
   default; all suites green; field-replay corpus pins moved in the same commit as any config
   default change.
4. **Replication before activation** (gate below): a second independent ordinary field session on
   a compatible revision reproducing the qualitative TTFT-dominated terminal-round shape, with
   cohorts reported at the granularity the deliverable-2 contract defines — **every populated
   `delivery_mode × cache_outcome` cell, including zero counts; streaming and buffered stay
   separate; no permitted rollup may blend them, and activation may never rest on a binary
   HIT-vs-everything-else blend** — and every observed thinking-terminal round correct and
   audible. Only then may the flag flip or a saving be claimed.

## Inherited apparatus (verbatim from 08D — binding)

**Replication gate — quoted verbatim from 08D §2** (the self-references to "08C" below are 08D's
own wording; 08D §2's closing sentence explicitly names this transfer: *"This gate transfers into
08C's acceptance section as part of §7's deliverables"* — that acceptance obligation now lives in
THIS plan per the 2026-08-11 A/B split):

> **Replication gate — decided (round 1), ✅ owner-confirmed 2026-08-11:** the single session is
> sufficient for THIS plan's no-runtime closure (§7). Any *future* behaviour-changing
> terminal-round optimisation (e.g. under 08C) may be implemented dark, but must not be
> **activated** — nor claim a latency saving — until at least one independent ordinary field
> session on a compatible revision reproduces the qualitative TTFT-dominated terminal-round shape.
> Exact 17 % / 34 % replication is NOT required; what is required is that all observed
> thinking-terminal rounds remain correct and audible. This gate transfers into 08C's acceptance
> section as part of §7's deliverables.

("THIS plan" above refers to 08D, whose no-runtime closure needed only the single session
`8B9B2BDD` / `eicr-backend:392`, 12 turns — 08D's own text says `:393`, a proven mislabel; the
activation bar the quote states binds *this* plan.)

**Four acceptance preconditions — quoted verbatim from 08D §8** ("08C" below is 08D's own
self-reference; "08C §1.1" is now [08C-A](plan-08c-a-per-round-cost.md) §1.1 under the split):

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

(§5 point 3 above is 08D §5's round-2 finding on the barrel-miss cohort.)

> **Dated refinement to the second precondition (HIT/MISS separation) — 2026-08-11, round 6.**
> The quote's binary HIT/MISS split is preserved verbatim but is now the FLOOR, not the
> reporting granularity: deliverable 2's contract supersedes it with the two independent
> dimensions (`delivery_mode`, 3-valued; `cache_outcome`, 6-valued), reported per populated cell with
> zero counts, streaming and buffered never blended. "Never blended" binds a fortiori at the
> finer granularity.

> **Dated correction to the first precondition — 2026-08-11, round 3 of this plan's refine,
> verified against source.** The quote above is preserved verbatim, but its "real sites" recipe
> (`recordOutcome`'s `meta` + the harness `null` literal) is ALSO wrong — it cannot populate the
> promised metric: `loaded_barrel_fired` fires only after the entire speculative MP3 buffer is
> assembled (not at first audio byte); `recordOutcome` is log-only and returns no state to the
> harness; the immutable `turn_core_summary` row is emitted BEFORE the iOS TTS POST in which
> HIT/MISS response bytes are actually written; and cancelled turns skip the core summary
> entirely. The four `routes/keys.js` sites split into two HIT and two MISS classes (corrected
> round 4 — `:275` is NOT a HIT site): **HIT** = `:446` (ready-cache hit) and `:499`
> (pending-race winner, inside the `winner.type === 'spec'/'spec_late'` branch at `:496-512`) —
> both need a new stamp immediately before `res.write`. **MISS** = `:275` (STREAMING-eligible
> fresh synthesis via `streamConfirmationViaElevenLabs`, reachable only AFTER both HIT branches
> have returned — needs a NEW synchronous first-byte stamp, since its current `firstByteMs` is
> derived post-hoc from the resolved synth timings, not stamped at the write) and `:676-683`
> (BUFFERED/legacy fresh synthesis — already captures `firstByteNs` as vendor-first-byte, but no
> HTTP byte reaches iOS until the later `res.send(buffer)`, which needs its own stamp). **Round 5
> then retired site-maps as normative content altogether** — the response-write site does not
> determine the cache outcome (fresh-synthesis paths also serve never-looked-up requests), and
> the streaming write needs a one-shot latch — so the binding specification is now the CONTRACT
> in Ordered deliverable 2 (fields, two independent dimensions, latch, scoping, tests); the line
> numbers in this note are historical. The binding spirit of the precondition — a populated
> nanosecond audio-ready stamp before any saving is claimed — is unchanged throughout.

**Honesty limit — quoted verbatim from 08D §4** (binds any terminal-round measurement this plan
performs):

> **Honesty limit (carried into 08C per §7 deliverable 3):** same-slot overwrite corrections (a later `record_reading` /
> `record_board_reading` / calculator write silently rewriting an earlier same-turn write to the
> same field) are **not recoverable from this telemetry** — `tool_names_per_round` records tool
> identity, not which slot a given call targeted, and `stage6_tool_call.round` is a
> per-dispatcher-closure call counter, not the loop round (`stage6-dispatchers.js:139,330`), so no
> join against it can recover round-attributed slot detail. **No zero-event bound is claimed for
> that category, on either corpus.**

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

## Web companion

Whether any selected mechanism is wire-neutral must be assessed at selection time — never assumed.
The 08D §9 corrective-follow-up warning above is a standing MANDATORY Web-companion trigger for
any mechanism that can ever produce a post-release correction. If the plan closes with no
mechanism (an allowed outcome), no web companion and no parity-ledger row are needed. If
deliverable 1 DOES select a mechanism that is not wire-neutral (tightened round 7): a new wire
shape that an older client could misinterpret is exactly the case the shared-backend invariant
exists for — the wave must END with every client correct, and a parity-ledger row is
documentation, not protection. So the mechanism must either **ship all affected web/iOS changes
in the same wave**, or **stay dark behind a capability gate until those clients ship** — a
ledger-row-only closure is NOT an allowed state for a wire-shape change. (The ledger-row path
remains valid only for client-visible-but-wire-neutral lag, per the repo rule.)

## Acceptance

- **Conditional on the feasibility gate:** deliverable 1 alone — resolved to a documented
  no-mechanism close — fully satisfies this plan. Deliverables 2–4 run, in order, ONLY if
  deliverable 1 passes; **activation and any claimed saving strictly behind the replication
  gate.**
- Every number names its baseline (post-A once PLAN-A ships; never pre-08B).
- The mechanism (if any) independently flagged and rollback-able; thinking-terminal cohort
  provably inert; cohort reporting per populated `delivery_mode × cache_outcome` cell (zero
  counts included) — never a binary HIT/non-HIT blend.
- Tool-loop, reasoning-continuity, cancellation, usage-accounting and audibility suites green;
  field-replay gate green with corpus pins in the same commit as any config default change.
- An explicit "no viable mechanism — closed" outcome satisfies this plan (with the constraint
  space and disproofs recorded), exactly as 08D's docs-only closure did.

## Delivery

Batch mode, chained after PLAN-A: this plan's `/ep` execution begins only after PLAN-A's merge
completes (shared-test-file rule — no parallel merges into one repo). PR-only; deploy confirmed
by task-definition revision increment + the "Deploy to AWS ECS" JOB conclusion, never
`rolloutState`. Backend service `eicr-backend`; web service `eicr-pwa` (touched only if a
Web-companion trigger fires). Canonical repo artifact per PLAN-A's Delivery step 3
(`plan-08c-b-terminal-round.md`).

**Conditional branch — non-wire-neutral mechanism only (added round 8, closing the gap between
the Web-companion rule and this section):** if deliverable 1 selects a mechanism that changes the
wire shape, Delivery additionally requires, IN ORDER: (1) the backend half ships dark behind its
capability gate — old builds must be structurally unable to receive the new shape; (2) the web
half ships with parity verification; (3) the iOS half is built and distributed via the repo's
TestFlight workflow (`CertMateUnified/deploy-testflight.sh`); (4) **activation waits until the
sole user confirms the compatible iOS build is INSTALLED** — an uninstalled TestFlight build is
not a shipped client; (5) only then may the capability gate flip. A wave that ends before step 4
completes has not ended — the shared-backend invariant (every client correct at wave end) binds
this plan's Delivery, not just its Web-companion prose.

## Reviewer pressure points

- **Does the framed constraint space contain ANY viable mechanism?** If not, say so and converge
  on an explicit close — do not invent machinery to justify the plan's existence (the 08D
  circuit-breaker lesson).
- Does every proposed mechanism satisfy constraint 1 (no output decision before completion;
  content-independent whole-cohort treatments only), provably inert on thinking-terminal rounds,
  and honest about its wire shape?
- Does the deliverable-2 implementation satisfy the CONTRACT — named fields, one-shot latch
  (tested), `cache_outcome` from the lookup path (incl. `lookup_error`), identifier scoping,
  delayed correlated publication, per-cell reporting — and is it sequenced strictly after
  deliverable 1 passes and before any saving claim? (Do not re-litigate stamp line numbers; the
  site map is informative only.)
- **What did the A/B split lose?** Is there a deliverable, wire contract, or measurement that
  neither sibling now owns?

## PROPOSED closure — 2026-08-17: deliverable 1 argued to NO VIABLE MECHANISM — **HELD IN CODEX REVIEW, not confirmed**

> **⚠️ HOLD (2026-08-17, `/ep` run `20260817T001655Z-ep`, Codex diff review cycle 1 — all
> three lenses).** The four-axis inventory below is INCOMPLETE: it omits **Responses API
> WebSocket mode / `previous_response_id` state chaining** — documented by the provider as a
> low-latency continuation path for exactly this loop shape (connection-local prior-response
> cache; requires `store:true`, which the production adapter currently does not set). It is
> content-independent, available before the call, and applies uniformly to every post-tool
> round, so it belongs in deliverable 1's inventory and could not be disproved from
> documentation alone on the night. Whether it has MATERIAL headroom against the ~1.27 s
> floor is unknowable without measurement — 08C-A §1.4 deliberately left cached-prefix
> latency attribution unowned. **Until this candidate is either disproved or selected (which
> would re-open deliverables 2–4 as a dark build), the closure below is a PROPOSAL, not a
> confirmed outcome, and the 08-series is NOT complete.** Decision queued to Derek via the
> `/ep` digest.

Executed by `/ep` run `20260817T001655Z-ep`, chained after 08C-A's merge (PR #189,
`e087492b`), re-baselined on post-A `main`. Deliverables 2–4 did NOT run, per the plan's own
gate: nothing is built when feasibility fails, and the audio-ready telemetry does not ride
along as a dead prerequisite. (The cross-record of this disproof alongside 08D's dead shapes
in `plan-08d-terminal-round-release.md` is deliberately deferred until the hold above
resolves — a contested disproof must not propagate into a settled catalogue.)

### The disproof as argued (four axes — held incomplete by review, see banner)

The only candidate class constraint 1 permits — a **content-independent pre-call/transport
treatment applied uniformly to every terminal-position call** — decomposes into exactly four
provider/transport axes, and all four are exhausted or unavailable:

1. **Service-tier acceleration — already at maximum.** Production ordinary turns run Luna
   Fast; the adapter resolves and sends an explicit `service_tier`
   (`openai-responses-adapter.js:588–593`), and every round in the 2026-08-16 90-rep bench —
   terminal rounds included — came back `response_tier: "priority"`. There is no faster tier
   to move the terminal-position cohort onto.
2. **Prompt-prefix caching — already engaged.** 1,331/1,332 of the bench's completed
   multi-round terminal rows read a ~35.7–35.8k-token cached prefix
   (`cache_read_input_tokens` ∈ {35,659, 35,699, 35,833}); one zero-reasoning terminal row
   cold-wrote 35,833 tokens. Plan 01 §5's Tier-A probe detected **no prefill-latency cost
   above noise** in its small matched-round sample (cold n=4, cold 89 ms faster than warm) —
   evidence that prefill is not obviously where the terminal round's cost lives, though the
   sample is small and cached-prefix latency attribution remains deliberately unowned
   (08C-A §1.4).
3. **Connection warmness — partially present, reuse unmeasured.** The session reuses one
   adapter per provider (`createOpenAIResponsesAdapter`, one SDK client per session) and the
   installed SDK routes requests through a keep-alive connection pool — but that proves
   client-object reuse, not that consecutive rounds share a socket or skip a handshake;
   actual socket reuse is unmeasured. This axis is *plausibly* mostly-warm, not proven
   exhausted.
4. **Predicted outputs (speculative-decoding hint) — structurally unavailable AND immaterial.**
   It is a Chat-Completions-only parameter (`prediction: {type:"content"}`); the gpt-5.x
   model pages list predicted outputs as unsupported, and the production loop is the
   Responses API on a reasoning model. Even were it available, prediction accelerates
   DECODE — and the zero-reasoning terminal round decodes exactly **4 tokens**. Decode is
   ~0 of its cost.

Every other mechanism shape fails constraints 1/3 by construction, not by tuning: per-round
reasoning-effort reduction (the ladder below `'low'` is `'none'`, a documented Luna looping
regression — 08C-A §1.1 — and any effort change can alter the thinking cohort's output);
`tool_choice: "none"` or `max_output_tokens` clamps on post-tool rounds (truncate legitimate
multi-tool-round turns and thinking-terminal responses); a different/faster model for
post-tool rounds (not provably inert on the thinking cohort); and round elimination (requires
predicted terminality — the transport has no trustworthy pre-completion no-tool signal, 08D,
verified in source).

**Conclusion: the zero-reasoning terminal round's ~1.27 s p50 is the round-trip floor (TTFT)
of a protocol-mandatory round whose transport is already fully accelerated.** Within this
plan's constraint space the remaining headroom is zero. What could ever remove it sits
OUTSIDE the space and is recorded here for honesty, not as a proposal: a provider-side
protocol change letting a model emit tool calls and a final terminal decision in one round,
or a Plan-06-era behaviour change that makes terminal-position content productive often
enough that the "wasted round" framing stops applying.

### Fresh corroborating evidence — the shape replicates at scale (bench, not field)

The 2026-08-16 08C-A production-path benchmark (90 reps, 3 fixtures × 3 arms × 10 blocks,
`evidence-08c-a-analysis-2026-08-17.json` + results manifest in this directory) contains
**1,332 completed multi-round turns** — a ~110× larger sample than the 12-turn corpus this
lever was measured on:

| Metric | 12-turn corpus (`8B9B2BDD`, `:392`) | 90-rep bench (2026-08-16) |
|---|---|---|
| Zero-reasoning terminal share | 10/12 (~83 %) | 1,163/1,332 (**87.3 %**) |
| Thinking-terminal share | 2/12 (17 %, provisional) | 169/1,332 (**12.7 %**) |
| Zero-reasoning terminal `stream_ms` p50 | 1,267 ms | **1,266 ms** |
| Terminal output tokens (zero-reasoning) | exactly 4 | p50 = max = **4** |
| Share of summed round `stream_ms` | 34.0 % all terminal rounds (24.4 % zero-reasoning subset) | **35.3 %** (zero-reasoning subset ÷ all rounds of the 1,332 multi-round turns; 35.0 % if the 18 completed single-round turns join the denominator) |

The p50 agreement to within 1 ms across 110× the sample confirms a stable floor, not a
session artifact. **Caveat, stated deliberately:** these are benchmark sessions on the
production path, not an independent *ordinary field session* — so this does NOT discharge
the inherited replication gate, which binds ACTIVATION and is moot on a no-mechanism close.
It is corroboration of the shape, recorded because it existed on the day of closure.

### Dispositions

- **Audio-ready telemetry (deliverable 2):** NOT shipped, per the round-3 restructure — it
  does not ride along on a failed feasibility gate. The deliverable-2 CONTRACT text above
  (fields, two independent dimensions, one-shot latch, identifier scoping, delayed correlated
  publication) remains the binding specification should it ever be argued as its own
  observability follow-up. Unowned as of this closure; queued in the vault todo file.
- **Web companion:** none needed — no mechanism selected, so no wire change (the plan's own
  "no mechanism → no ledger row" rule).
- **Inherited apparatus:** the replication gate, four acceptance preconditions, honesty limit
  and §9 invariants remain binding on any FUTURE reopening of this lever; a reopening must
  also re-run deliverable 1 against the then-current transport, since this closure's axis
  inventory is dated 2026-08-17.
