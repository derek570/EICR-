# PLAN-A2 execution log

- Session: 20260812T180113Z-ep
- Claimed: 2026-08-12T18:01:13Z
- Worktree: /Users/derekbeckley/Developer/EICR_Automation-ep-20260812T180113Z-ep
- Branch: ep/PLAN-A2-20260812T180113Z-ep

## [PLAN-SIZE] warning

This plan touches one high-interaction subsystem (dialogue-engine's script state machine) with
8 applyWriteWithDerivations call sites, 17 clearScriptState exits, and a dispatcher-resolved
ownership handoff. It is a single feature group (not a multi-feature bundle) per planning.md's
seam-split rule — already the product of a mid-run split from PLAN-A. Proceeding as one unit per
the plan's own structure. Expect a long Codex convergence given the interaction surface.

## Read-first notes

- Conversation-context: EVIDENCE.md-derived wave (13 feedback ids), PLAN-A2 owns only id 117.
- Refine-log: PLAN-A2 converged at round 4 (0/0) after inheriting PLAN-A rounds 2-7 group-2
  history. Design premise validated twice by both reviewers at PLAN-A round 5 — do not re-litigate
  the provenance-ledger mechanism itself.
- EVIDENCE.md file:line cites verified against main `e7f8b428` — WILL drift; this run re-verifies
  every anchor against its own tip before editing.

## Implementation

All §A2.1–§A2.5 mechanisms implemented per plan: the per-run `state.operations` ledger with
`markDictated`/`markWritten`/`markSatisfiedExisting`/`markRejected`/`markAbandoned`, canonicalise-
and-compare seeded-value skip, the dispatcher-resolved ownership triad, and the shared
`computeUncoveredReadback`/`renderTerminalReadback` terminal-sink helper across all 17
`clearScriptState` sites plus `runPivot`. Commits `0b7b4414`/`c6037823`/`94ae7f38`.

## Codex diff-review loop — 4 rounds, 3 lenses each (12 calls total, plus 1 final single-lens
## convergence check)

Per the `/ep` skill's independent-diff-review gate. Each round built a fresh full diff against
`main` and ran 3 (round 4: 1) parallel `mcp__codex-cli__ask-codex` calls (`gpt-5.6-sol`, high
reasoning, read-only sandbox), each with a distinct lens, findings merged and applied before the
next round. One structural issue recurred across rounds: `outputSchema` needed
`additionalProperties:false` at every object level and every property (including nullable ones)
listed in `required`, or OpenAI's structured-output endpoint 400s before any review runs — every
lens hit this on its first call and self-corrected on retry from round 2 onward. One lens (cycle-2
lens B) returned only interim streaming narration with empty findings on its first call — a
dead-lens signature per the dead-reviewer-lens-detection memory — and was re-run with
`outputLastMessage` to capture the genuine final message, which surfaced 5 BLOCKERs + 1 IMPORTANT.

**Round 1** (lenses: wire-contract faithfulness / silent-path hunt / edge interactions) found and
fixed: 3 previously-missed terminal sites (mid-script broadcast-abort, both hard-timeout sweeps)
now instrumented; `bulk_apply_done`'s incorrect pre-cover loop removed (it suppressed the one place
BS/type/mA would ever be spoken on the bulk-accept path); `finishScript` coverage made mirror-aware
for RCBO; **the ownership-triad's "same effective slot" precedence REVERSED** — all 3 lenses
independently flagged the original "any prior winner wins unconditionally" draft as the SAME class
of bug id 117 exists to fix (a genuinely different same-turn value silently discarded), reversing
`stage6-a2-multiboard-script-backfill.test.js`'s prior "defensive dedupe always wins" expectation;
`ownershipResolver` gated to `null` when the caller has no backfill guarantee; `correctionBreadcrumb`
made operation-aware; scope-conflict `priorPending` upsert-with-abandon; `findCoveringOp` made
latest-wins + circuit-scoped; circuit-qualification added to `computeUncoveredReadback`/
`transitionToConfirmation`; label captured at dictation time (survives a post-pivot schema change).
Commits `1e03a37e`, `e12ed33c` (post-commit-hook digest re-regen — recurred every round; lint-staged's
`eslint --fix`/`prettier --write` reformats `engine.js` on commit, invalidating the pre-commit digest).

**Round 2** (same 3 lenses, fresh diff) found and fixed: circuit-scoped coverage —
`dictatedIntersectsBulkAsk`/`scriptOwnedDictatedFields` accepted a stale REPLACEMENT-carried
operation from a DIFFERENT circuit; a validation-REJECTED write now gets an actual `disposition:
'rejected'` ledger entry (previously dropped before `initScriptState` ran); 2 literal NUL bytes in a
template-literal key (made `engine.js` register as binary to `file`/`rg`) replaced with `::`; stale
ownership-contract documentation (JSDoc comment, `ios-pipeline.md`, `changelog.md`) updated to match
the round-1 reversal. A second lens pass on the same round (edge-interactions) additionally found and
fixed: `correctionBreadcrumb` tracking the field name only, not the operation (now uses the LATEST
matching operation's own `effective_circuit_ref`); a duplicate-field-in-one-`pending_writes`-array
ownership gap (`writtenThisLoopFields` tracking added). Commits `b692d1ce`, `002947c4`.

**Then, independently:** re-examining a delayed cycle-1 finding (dispatcher lens B, initially
processed as a dead/duplicate delivery but later found genuinely new via a fresh re-run) plus a fresh
cycle-2 lens A2 finding **converged 2/3 lenses on reversing round-1's `computeUncoveredReadback`
"latest operation per (field,circuit) only" supersession filter** — cross-checked against the plan's
own literal test (l) wording ("two same-field dictations → two operations, each spoken per its own
coverage — distinguish two APPLIED values from an overwritten QUEUED value") and its refine-log
round-2 rationale ("per-operation coverage, not field-level"), confirming the filter contradicted a
DELIBERATE design decision reached during `/rp`'s own review, not an accidental phrasing. Reverted;
`findCoveringOp`/`transitionToConfirmation` (unchanged — they already mark only the latest matching
operation covered) mean a superseded APPLIED correction is separately named via the terminal-sink
append, never doubled, while a superseded QUEUED write (never landed) stays silently `abandoned`.
Commit `67fe708c`.

**A second independent cycle-2 lens (b2, initially returned as a dead lens too, re-run with
`outputLastMessage`)** found and fixed 3 more real, production-reachable bugs: (1) a **severe
cross-wrapper isolation gap** — the broadcast-intent pre-filter had no "does this wrapper own the
active schema" check (unlike the active-path handler a few lines below it, which already has one,
with a comment noting "the legacy two-wrapper call pattern in sonnet-stream.js depends on this
isolation"); confirmed via `sonnet-stream.js` that production calls all three domain wrappers
(ring/IR/protective-device) in sequence on EVERY turn — a broadcast utterance while RCD was active
would hit the ring wrapper first and silently clear the active RCD episode with zero read-back, no
schema in ring's own `schemas` list to render the read-back with, before the owning wrapper ever saw
it; (2) an ordinary (non-scope-conflict) unresolved episode's same-field follow-up silently dropped
via `if (alreadyQueued) continue` — **this exact bug had been raised and deferred in round 1**,
citing the 361A638D replay fixture as a pin; re-checked while investigating this independent
re-flagging, that fixture dictates each field only ONCE while unresolved and actually pins a
DIFFERENT decision (whether to re-ask the which_circuit question) — the round-1 deferral was a
citation error, not a considered scope call; fixed with the same upsert-with-abandon pattern already
used in the adjacent scope-conflict branch; (3) the dispatcher's ownership-resolver comparison used
raw `String(a) === String(b)` instead of canonicalising through the slot parser — a record_reading's
canonical form ("BS EN 61008") vs. a same-turn seed's raw form ("61008") false-negatived, producing a
double-speak; fixed by exporting `engine.js`'s `valuesCanonicallyEqual` for the dispatcher to reuse.
Two test files that `jest.unstable_mockModule` the whole `dialogue-engine/index.js` module needed the
new export added to their mocks. Commits `b5b52c82`, `accf249c`, `6fc0e1b3`.

**Round 3** (fresh 3-lens pass against the accumulated diff) found and fixed 2 more real bugs, both
in the SAME ownership/coverage mechanism, independently converged by 2 of 3 lenses: `priorWinnerOwnsIt`
consulted the dispatcher's FROZEN pre-call resolver on every seed-loop iteration without checking
`writtenThisLoopFields` — a later same-loop duplicate matching the stale pre-call winner was wrongly
treated as already-spoken, silently discarding an intervening write (gated with the existing
`writtenThisLoopFields` Set); `scriptOwnedDictatedFields` credited a field from ANY historical
matching operation rather than the latest, letting a stale earlier script-owned op make
`allCoveredScriptOwned` true even when the current operation was bundler-owned (rederived from
`findCoveringOp`'s latest-per-field lookup). A third finding (1 lens) further tightened
`correctionBreadcrumb` to restrict its scan to the CURRENT circuit only, installing no breadcrumb
when nothing matches there (a carried older-circuit reading is not what the inspector just heard). A
fourth lens finding (wire-contract) was correctly left unaddressed — Codex itself marked it
OUT_OF_INTENT, citing the plan's own "ZERO wire change, ZERO client work" text; client-side handling
of `expected_answer_shape:'none'` frames is recorded as a follow-up for a future client-parity plan.
Commit `44f708e6`.

**Round 4** (final convergence check, single lens re-tracing the whole ownership/coverage mechanism
end-to-end) found ONE remaining instance of the same "latest operation, not any" pattern already
fixed 3 times in prior rounds: `transitionToConfirmation` marked EVERY matching operation for a field
covered, not just the latest — since the confirmation message renders only the CURRENT value, an
earlier same-field correction made during ring/IR collection (before the confirmation fires) was
wrongly marked covered by a message that never actually named it, permanently losing that reading.
Fixed with the same latest-per-field, circuit-scoped principle as `findCoveringOp`. The lens
explicitly confirmed rounds 1-3's fixes trace consistently and found no other issues (wire-contract
and source-integrity checks also clean). Commit `54085077`. **Loop converged — 4 rounds, 0 remaining
findings.**

## Deviations from the plan

- **`computeUncoveredReadback`'s supersession filter was added then reverted** (see round 2 above) —
  net diff from the plan is zero on this point, but it's worth flagging as the one place this run's
  own initial implementation choice was wrong and had to be corrected by review, not just refined.
- **The ownership-triad's "any prior winner wins unconditionally" draft was similarly added then
  reversed** within round 1 itself before the round-1 commit — same pattern, caught before it ever
  shipped.
- **A round-1 finding (ordinary unresolved-queue dedup) was incorrectly deferred citing a
  misapplied replay-fixture pin**, then correctly fixed after an independent round-2 re-flagging
  prompted re-verification of the citation. Documented above as a specific citation error, not a
  reasoned scope call that was later overturned.

## Follow-ups (not fixed — recorded for a future plan)

1. **Sub-board bundler-ownership gap.** `applyWrite` writes to the main-board bucket regardless of a
   seeding call's resolved sub-board, so the bundler-ownership guarantee is false on a sub-board
   (reproduced: `currentBoardId='sub'`, an RCD trip-time seed mutated the MAIN board's circuit while
   the sub-board bucket stayed unchanged and `perTurnWrites` stayed empty — no spoken frame at all).
   Confirmed OUT OF SCOPE by the reviewing lens itself: correct handling needs every dialogue-engine
   write/derivation path to resolve and retain the effective board, well beyond this plan's
   provenance-ledger surface.
2. **Bundler-speech-guarantee under `confirmationsEnabled:false` / `applyConfirmationDebounce`.** A
   `spoken_owner:'bundler'` operation's guarantee assumes the final bundler frame actually reaches the
   wire; when confirmations are disabled or the debounce removes an exact repeated reading, that
   assumption can be false. Cross-cutting into `stage6-event-bundler.js`, beyond this plan's ledger
   surface.
3. **A 4-site `pending_writes`-abandon-marking finding (IMPORTANT).** At least one of the four cited
   sites (`engine.js:2243`, the ring/IR `confirmation_delete_exit` branch) appears structurally
   unreachable on inspection — `state.pending_writes` can only hold entries during the UNRESOLVED
   phase, before a circuit is known, but this site only fires once a circuit is already resolved
   (confirmation implies a resolved episode). The other three sites need the same case-by-case
   reachability verification before a fix is safe to apply.
4. **The full §(w) exhaustive parameterized provenance-lifecycle matrix.** Not built — the
   concretely-identified gaps it exists to catch (the 3 originally-missed terminal sites) are covered
   by targeted regression tests instead, and building 17-sites × multiple-subcases of parameterized
   coverage under time pressure risked more churn than the marginal safety benefit justified once
   those specific gaps were already closed and re-verified clean by 2 further review rounds.
5. **Client-side `expected_answer_shape:'none'` handling.** Web ignores the field and presents a
   standalone terminal read-back as an interactive question (latching a synthetic tool ID); iOS
   correctly speaks it non-blockingly but still inserts every `srv-*` id into
   `activeServerScriptToolCallIds`, deferring subsequent single-token finals until session reset.
   Codex's own verdict: OUT_OF_INTENT — the plan states "ZERO wire change, ZERO client work" — a
   follow-up for a future client-parity plan (`web/src/lib/recording/sonnet-session.ts`,
   `CertMateUnified/Sources/Services/ServerWebSocketService.swift`).

## Verification

Full backend Jest suite green after every commit (final: 8534/8554 tests, 19 pre-existing skips, 1
flaky-unrelated timing test in `loaded-barrel-keys-route.test.js` that passes in isolation per the
original round-1 note). `npm run replay:field-corpus` green after every commit. Semantic-oracle
digest regenerated whenever `engine.js` changed (an enumerated `plan00-expectation-manifest.json`
input) — including twice per several rounds, since the pre-commit `lint-staged` hook's
`eslint --fix`/`prettier --write` reformats `engine.js` on commit and invalidates a pre-commit
digest; this is now a documented recurring gotcha for future `/ep` runs touching this file.
