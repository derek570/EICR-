# PLAN-A2 (ring open circuit, ids 141/142) `/ep` execution log

> Not to be confused with `PLAN-A2-ep-execution-log.md`, which is a DIFFERENT
> PLAN-A2 — the 2026-08-12 run for feedback id 117. Same stem, different wave.

- **Plan:** `PLAN-A2-v10.md` (sha256[0:16] `889e73a1dd45e194`; `PLAN-A2.md` byte-compared equal),
  converged at targeted round 9, ledger round 9, zero open design issues.
- **Wave:** `feedback-2026-09-17` · **Chain:** `--chain`, hop 2 (hop 1 = PLAN-CC v29, `CODEX_HELD`).
- **Session:** `claunch-opus-high-89043` · Claude Opus 5, effort high · claimed 2026-09-23T09:18:04Z.
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-a2-ep-20260923`
- **Branch:** `ep/plan-a2-ring-open-circuit-20260923` off `origin/main` @ `c9f2c60d`
- **Outcome:** **HELD.** Implementation complete and independently reviewed; delivery blocked on a
  prerequisite the plan itself names. See § Why this is held.

## Step 1 — Parser, spoken helper, ring read-back, prompt

- Status: applied · Commit `d1cf1366`
- `parseOhms` returns `∞` (U+221E) for `infinite | infinity | open | open circuit | open ring |
  discontinuous`, after the LIM branch and before the numeric one, as the plan pins.
- `confirmation-text.js` gains `INFINITY_SENTINEL` and `speakSentinelValue`; `buildValueSpokenTail`
  renders the sentinel as the word "infinity" between the LIM branch and the clamp-correction clause.
  `buildRingContinuityConfirmation` renders every leg through the same helper. One helper, both
  producers — the id-100(b) lesson (the correction clause drifting between exactly these two paths)
  applied up front rather than after the fact.
- Prompt: `:151` deleted from VALUE NORMALISATION and re-authored as the last bullet of RING
  CONTINUITY CARRYOVER, routing ring vs radial instead of listing five fields flat.
- `confirmation-text.js` remains a leaf module (zero imports); `ohms.js` imports the constant from it,
  a direction the dialogue engine already depends on.

## Step 2 — Independent review (Codex gpt-5.6-sol, effort high, two concurrent lanes)

Coverage chosen per the EP policy's risk rule: one comprehensive lane, plus one specialist because the
diff changes what a hands-free inspector hears. The specialist's second boundary — adjudicating the
live acceptance evidence — was named before dispatch as what it adds beyond lane 1.

- Lane 1 (comprehensive): 1 BLOCKER, 6 IMPORTANT, 4 NIT. All four declared deviations `WITHIN_INTENT`.
- Lane 2 (specialist, audibility + acceptance 4): 1 BLOCKER, 2 IMPORTANT.
- Raw outputs and prompts: `PLAN-A2-ep-reviews/` in the handoff directory.

### One reviewer claim I checked and found wrong — and one I wrongly called wrong

- **Lane 2's count was wrong, its conclusion was not.** It reported "both arms produced zero expected
  continuity writes across their three samples of cases (a)-(e)". The raw JSON says otherwise: branch
  case (c) produced the expected `ring_r2_ohm = ∞` in 2 of 3 runs, and `main` case (e) produced the
  expected `r1_r2_ohm = ∞` in 1 of 3. Corrected tally: **branch 2/15, main 1/15.** Its conclusion —
  acceptance 4 unmet, no demonstrated regression, plan-owner amendment needed — holds on the
  corrected numbers.
- **Lane 1's mutation A: I tested the wrong mutation and wrongly called the finding wrong.** Lane 1
  said inserting "Only for observation-shaped utterances, " immediately BEFORE the write-case clause
  leaves every assertion green. I ran a mutation that REPLACED the clause, which made the exact
  substring vanish and failed the test for an unrelated reason, and concluded the finding was
  mistaken. The verification lane disputed that; re-run with the clause left byte-intact, the
  mutation passes **88/88**. Lane 1 was right. The slice now starts at the END of the leg-answered
  clause so the whole gap is inspected, and the mutation fails exactly one test. The lesson is the
  one this wave keeps re-learning: a mutation test proves nothing unless the mutation is the one that
  was actually claimed.

## Step 3 — Fixes applied

- Status: applied · Commit `33c72e18` · One fix cycle.

| Finding | Disposition |
|---|---|
| Specialist BLOCKER — `computeUncoveredReadback` speaks the raw character on a cancelled/deferred ring walk | **FIX.** Red-proved first: with the fix reverted the walk emits "Also got lives ∞."; it now says "infinity". Amendment breadcrumb given the same treatment as defence in depth (continuity fields don't opt into it today, and that is said in-source). |
| Comprehensive IMPORTANT 2 — anywhere-match writes `∞` from ordinary speech | **FIX.** Matcher anchored to a bare/near-bare reply, modelled on the sibling `parseLimSlot`. Field-qualified speech still writes via the named extractor. |
| Comprehensive IMPORTANT 3 — LIM-vs-sentinel precedence was a false claim | **FIX**, by the same anchoring: neither matcher can fire on a mixed reply, which now re-asks. |
| Comprehensive IMPORTANT 5 — structural tests pass material mutations | **FIX.** Mutation lock on the complete five-field routing mapping; verified failing on the mutation and only on it. |
| Comprehensive NIT 11 — "+45 tokens" | **FIX.** The delta is +145 (25206→25351, 19957→20102). Caps were already right. |
| Comprehensive IMPORTANT 4 — rewritten test over-claims | **PARTIAL.** Title narrowed to what it proves. The two neighbouring gaps (numeric-only `pendingValuePattern`; `RING_VALUE_GROUP` capturing only "open") are named in-source as follow-ups, not widened — outside this plan's stated file scope, and widening the grammars without re-checking them against the false-positive class just closed would reopen it. |
| Comprehensive IMPORTANT 6 — acceptance 4 not evidenced | **EVIDENCE EXISTS**; lane 1 wasn't given it (lane 2 was). Its second point was right and acted on: the repo's `PLAN-A2-ep-execution-log.md` is a different wave, so this log is named distinctly. |
| Comprehensive IMPORTANT 7 — docs not in the candidate | **FIX.** Committed in `33c72e18`. |
| Comprehensive NITs 8-10 | All four deviations `WITHIN_INTENT`. No action. |
| Specialist IMPORTANT 2 — probe unfair for case (g) | **ACCEPTED, not fixed.** Correct: production calls `processRingContinuityTurn` before `runShadowHarness`, and "The ring continuity is open" is a deterministic ring trigger, so the probe records a model result for a turn production consumes earlier. Recorded as a limitation of the evidence rather than papered over. |
| Specialist IMPORTANT 3 — acceptance 4 needs a plan amendment | **ACCEPTED.** See § Why this is held. |

### One deliberate deviation created by the fixes

`parseOhms` is now strictly NARROWER than the legacy twin on non-bare text, where the plan asked for a
byte-copy. Recorded in-source and pinned by its own test. The three-grammar parity the plan's
acceptance actually requires — the six forms, numerics, plain non-values — still holds exactly. The
twin is not in the live path (`sonnet-stream.js` imports the dialogue engine), and narrower is the safe
direction: a missed sentinel re-asks, a false one corrupts a certificate.

## Step 4a — Fix-verification round (Codex gpt-5.6-sol/high, fresh context)

Cycle 2. The lane received the fix diff, the complete candidate diff, both prior lanes' findings and
the live evidence, and was asked to return CONFIRMED or DISPUTED per disposition.

- **CONFIRMED (4):** the terminal read-back fix, including that nothing is now spoken twice and that
  reverting the one line genuinely fails the test; the +145 correction; the deliberate divergence from
  the legacy twin as `WITHIN_INTENT`, having verified the twin really is out of the production path;
  and the semantic-oracle digest, recomputed independently across all 42 rows with zero mismatches.
- **DISPUTED (4), and it was right on each:**
  1. **Mutation A was still not caught.** Fixed — see above. My error, not the reviewer's.
  2. **The anchoring loses legitimate answers.** *"The circuit is open"* and *"we've got an open
     circuit"* are structurally complete answers to "What's the CPC?" that now re-ask. Note these
     never wrote on `main` either — they wrote only in the intermediate commit `d1cf1366`, so this is
     not a regression against shipped behaviour — but it is the id-141 dead end surviving for a
     phrasing variant, which is the thing this plan exists to remove.
  3. **The LIM-versus-sentinel inconsistency is not fully closed.** `parseOhms` now re-asks on a mixed
     reply, but `resolveValueAnswer` still scans broadly, checks LIM first, and writes `LIM` for the
     same words. Two paths, two answers, no test covering the seam.
  4. **The three deferred gaps are deferred defects, not settled behaviour** — the numeric-only
     pending-slot pattern, the value-first grammar reaching only four of six forms, and
     *"open circuit on the 2.5"* writing `2.5`.
- **Documentation: DISPUTED, and this was the worst of them.** The changelog still described the
  PRE-FIX parser — "byte-copying the twin's word-anchored pattern", "the weaker claim wins when a
  reply carries both", and a claim that ordering prevents *"open circuit on the 2.5"* becoming `2.5`.
  All three were false of the shipped code, and the same paragraph later described the narrower
  matcher, so it contradicted itself. Rewritten rather than appended to, per the reviewer's
  instruction, along with the field-reference note and the hub row.

### Why items 2, 3 and 4 above are NOT patched here

They are one gap, not four. A coherent "an open circuit is a first-class ring answer" behaviour has to
move four paths together behind one shared sentinel grammar: the bare-value fallback, the two named
extractors, the confirmation pending-slot pattern, and `stage6-answer-resolver.js`. **The plan scoped
exactly one of them** — `parseOhms` plus the confirmation text — and patching the other three
piecemeal, inside a plan that is already held and cannot merge, is how a subsystem gets four rounds of
rewording instead of one design decision. Each widening also needs its own false-positive matrix
against the class just closed, and "the window is open" is structurally identical to "the circuit is
open", so the discriminator is a subject allowlist, which is a design choice and not a patch.

Recorded as a plan-level amendment for the owner, with the reviewer's evidence attached. This is the
same call the specialist lane made on acceptance 4: `OUT_OF_INTENT` to change semantics the approved
wording does not authorize.

## Step 4 — Tests and gates

- Backend Jest: **9,612 passed, 19 skipped, 0 failed** (390 suites).
- `npm run lint`: 0 errors (178 pre-existing warnings, unchanged).
- `scripts/check-hub-size.mjs`: OK, 44,023/45,000 chars. The oldest hub row (2026-08-26, PLAN-E1) was
  dropped to stay in budget, its full detail already in `changelog.md` — the documented maintenance
  action, not a budget raise.
- `plan00-expectation-manifest` drift gate: `engine.js` is an enumerated semantic-oracle input, so the
  digest was regenerated in the same commit (`ecdf487b…` → `bb7d9a3c…`). Two lines changed.
- Two existing tests changed MEANING rather than gaining cases, both deliberately: the correction-paths
  test that pinned "sentinel words parse to null and remain MODEL-bound (documented pre-existing
  limitation)" — that limitation is what this plan closes — and the two prompt token caps.

## Acceptance

| Item | State |
|---|---|
| 1 — six forms → `∞`; numerics/LIM unchanged; three-grammar parity; IR regressions | **PASS** |
| 2 — the recorded `CC9E0915` walk end to end | **PASS.** `ring_r2_ohm = ∞`, one CPC ask (was three plus a hint plus a timed-out model question), one `confirm_ring_continuity` whose text is *"R1 0.43, Rn 0.43, R2 infinity. All correct?"*, positive reply → *"Got it."* |
| 3 — combined with PLAN-A's handoff tombstone | **CANNOT BE VERIFIED.** The tombstone is not in the base. This is the delivery gate, not a defect in this work. |
| 4 — seven live model cases | **FAIL.** See `PLAN-A2-acceptance4-live-evidence.md`. |
| 5 — structural prompt tests green; caps re-pinned | **PASS** |

## Why this is held

Two independent reasons, either of which alone prevents merge.

1. **The plan's own delivery gate is unsatisfied.** PLAN-A2 "ships no earlier than, or in the same
   merge window as, PLAN-A's handoff-tombstone PR". PLAN-A has no `.ep-claimed` and no `.ep-done`, and
   no handoff tombstone exists in the codebase. Until it lands, a model write after a first-miss
   handoff can re-enter a stale script and speak this plan's `∞` a second time — the double read-back
   Audio-First invariant #1 forbids. The comprehensive reviewer reached the same conclusion
   independently and located the unfenced call sites.
2. **Acceptance 4 fails and needs a decision only the plan owner can make.** The live model does not
   reliably follow the prompt's routing rule, on this branch or on `main`. The shortfall is model
   compliance, not a missing code branch — the mandated wording is present and pinned. Two of the
   expectations also look under-specified: case (d) assumes a circuit designated "Sockets" is radial,
   when a ring-versus-radial ask is arguably the safer certificate behaviour, and case (e) names no
   circuit. Forcing these writes in code would exceed the approved wording; the specialist reviewer
   returned `OUT_OF_INTENT` on doing so, and I agree.

**Concrete next action:** execute PLAN-A, then rebase this branch onto its tombstone, re-run the
combined acceptance for item 3, and put acceptance 4's cases (d) and (e) to Derek as an amendment —
either give them explicit circuit and topology scope, or accept one clarification ask as the pass
condition.

## Follow-ups recorded, not done here

**The first four are one plan-level amendment, not four patches — see § Why items 2, 3 and 4 are NOT
patched here.**

1. `pendingValuePattern` in the ring schema is numeric-only, so after selecting a slot — "R2" →
   "What should R2 be?" — the answer "open circuit" is still rejected and re-asked. Same dead end as
   id 141, on the correction path.
2. `RING_VALUE_GROUP` captures only the head word "open", so the value-first form "open circuit on the
   lives" reaches no connector and takes no amend path. Value-first reaches four of the six forms.
3. A field-less, non-bare answer — "the circuit is open" — re-asks. Closing it needs an answer-shaped
   grammar with a subject allowlist, since "the window is open" has the same shape.
4. `stage6-answer-resolver.js` answers `LIM` for a mixed "limitation … open" reply where `parseOhms`
   re-asks. One shared sentinel parser across both paths, with identical-vector tests, is the fix.
5. A non-bare reply mixing a sentinel with a digit ("open circuit on the 2.5") writes `2.5`.
3. The live probe should drive case (g) through the production ingress order
   (`processRingContinuityTurn` before `runShadowHarness`) and persist authoritative per-round response
   model/tier/effort rather than reconstructing them from the routing row and environment.
4. Cases (f) and (g) have one sample each; the other five have three.

---

# Attempt 2 — authorized recovery, 2026-09-23 (afternoon)

- **Authority:** the RECOVERY DISPATCH block in `PLAN-A2-v10.md.ep-queue`, written by the wave coordinator
  (`eicr-automation-a7`), under `lifecycle-records.md` § Outcome records rule 4. Attempt 1's `.ep-done` and
  HELD outcome are preserved as history. New claim generation `attempt: 2`, claimed 2026-09-23T14:48:06Z.
- **Session:** `claunch-opus-high-80620`, Claude Opus 5 at claim; the session was resumed after a host
  disk-full outage and continued on Opus 5.5, effort high. Recorded in the claim's `runtime_events`.
- **Hold reason 1 (PLAN-A tombstone) resolved:** PR #227 merged as `7dc4cd94` and deployed (`eicr-backend:439`).
- **Hold reason 2 (acceptance 4) settled by Decision 29** (Derek, 2026-09-23): the deterministic gates are the
  gate; the seven live cases are dated evidence; the model-side rule is a follow-up plan.

## Rebase onto `7dc4cd94`

Four conflicts, all resolved by hand:

- `engine.js`: an import line. PLAN-A's three imports kept; `speakSentinelValue` added to the
  `confirmation-text.js` import.
- `CLAUDE.md` and `docs/reference/changelog.md`: both plans added a top row. Both kept, A2 above PLAN-A.
- `plan00-expectation-manifest.json`: taken from the base, then regenerated with
  `computeSemanticOracleDigest` (only the `engine.js` row and the combined digest move).

The hub then sat 582 chars over budget; the oldest row (2026-08-27 PLAN-E1B2 + PLAN-E1B) was dropped, its detail
already in `changelog.md`.

## Acceptance 3, now checkable

New tests show a model `∞` write after the first-miss handoff returns `handed_off` from the entry hook, emits no
script frame, and is read back once by the bundler as "Circuit 1, ring r2 infinity". Red-proved by
short-circuiting the entry-hook fence.

## Review cycle 3 (Codex gpt-5.6-sol/high) — one BLOCKER, real

The first attempt of this lane died on `No space left on device` during the host outage and produced no verdict;
it was retried with the identical prompt and bundle (log kept as `ep-r3-rebase-verify.attempt1-enospc.log`).

Items 1, 2, 4 and 5 CONFIRMED (conflict resolutions, drift digest, no other A2/PLAN-A collision, no cycle-1/2
regression). Item 3 DISPUTED as a BLOCKER: PLAN-A's second tombstone reader fences `start_dialogue_script` only
when the circuit is known. With `circuit: null` nothing checked the tombstone when the answer resolved it, so a
handed-off ring circuit walked to its own "R2 infinity. All correct?" — a second audible `∞` when the model had
also written it the ordinary way.

**Reproduced independently before fixing**, with the exact sequence the reviewer described.

**Fix (`engine.js`):** `enterScriptByName` marks a model-started, circuit-less episode
(`state.deferred_model_entry`); `runActivePath` checks the tombstone the moment the circuit resolves and, if the
circuit was handed off, ends the walk through `terminateWithHandoff` with a new `deferred_entry` note kind.
Queued values are abandoned, never written by the script. Any not already on the certificate return to the model
under `unapplied`, so a dictated reading is never silently dropped; one that IS already there (a same-turn
ordinary write, already read back) is left out, so it is not written or spoken twice.

**Deliberately not fenced:** an inspector's named trigger with no circuit that resolves to a handed-off circuit.
PLAN-A lets an inspector's explicit request override a handoff; the fence is scoped to model starts.

**Tests:** four cases — same-turn write plus deferred start (the bundler line is the only "infinity"), deferred
start alone (value returned under `unapplied`, nothing written by the script), and the two scope controls.
Red-proved: with the fence disabled the two write cases fail and the two controls pass.

This fix changes PLAN-A's shipped code. It is within A2's intent because acceptance 3 states the tombstone
"fences both re-entry paths", and A2 cannot pass that item while one path is open.
