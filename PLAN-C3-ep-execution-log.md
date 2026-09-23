# PLAN-C3 `/ep` execution log — feedback-2026-09-17 wave

- **Session:** `eicr-automation-ed [aaf7b4]` (tmux `claunch-opus-high-54678`, pane `%111`)
- **Plan:** `PLAN-C3-v19.md` (sha256 `b6f65671b26faeb6dc43a56e583e9415d5ba98a2b1dea9e7018b93e3917ecfb3`); `PLAN-C3.md` byte-identical (`cmp`)
- **Convergence:** `PLAN-C3-ledger.json` — `status: CONVERGED`, `converged_round: 13`, `open_design_issues: []`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-c3-ep-20260923`
- **Branch:** `ep/plan-c3-no-silent-clear-20260923` off `origin/main` @ `7dc4cd94`
- **Chain:** `--chain`, hop 4 (Decision 27). Successor: PLAN-B-v31 (corrected from PLAN-C2, which the hop-4 dispatch note named — see [Successor](#successor)).
- **Executor runtime:** Claude Opus 5, high effort (`claude-opus-5`), then Claude Opus 5.5 (`claude-opus-5-5`) after the session was resumed following the 2026-09-23 disk-full outage. Reviewer lane: Codex `gpt-6-sol`, high.

## Prerequisite

PLAN-C3's own queue note makes it "ships WITH or AFTER PLAN-A". PLAN-A is
MERGED and DEPLOYED: PR #227, merge `7dc4cd94`, live as `eicr-backend:439` and
`eicr-pwa:267` (`PLAN-A-v53.md.ep-success.json`). The worktree is based on
`origin/main`, not on the plan's pinned commit `02106091`, per the dispatch
note.

## Citation verification at the pin, then at `origin/main`

The dispatch note's executor-first obligation. `origin/main` is 41 commits
ahead of the plan's pinned revision `02106091`, with 2,626 insertions across
23 in-scope extraction files, so every line number in the plan has moved. Each
construct was opened by NAME at `origin/main` before it was touched.

Verified present and behaving as the plan describes:

- `validateRecordReading` runs BEFORE `stageStructuralReadingRefusal` in
  `dispatchRecordReading` (plan: `:546` / `:591`; actual `:545` / `:590`) — the
  ordering the exemption set exists for.
- `validateSetFieldForAllCircuits` returns before the selector, spare policy,
  exclusions and `resolveBulkCandidates` are computed — the reason
  `resolveBulkTargets` had to be hoisted.
- The pre-finalizer seam exists and its comment block names this plan's flag:
  PLAN-A's fence → PLAN-C3 notice reconciliation → `ANSWER_FALLBACK_TEXT`.
  `fallbackSuppressedByNotice` was NAMED there and deliberately unset.
- `computeAnswerFence(handoff, perTurnWrites)` in `stage6-per-turn-writes.js`
  is the single definition of PLAN-A's predicate; `options.handoff` carries
  `{boardId, schema, circuit_ref}`.
- The net-0 drain's outer guard was `chimeObserved && !cancelled`.
- The informative inventory reproduces: `B_STAGED_POOLS` has 13 route keys
  and `BOARD_CLEAR_NOTICE_FAMILIES` adds `board_clear_already_empty` — 14
  registered keys, 12 distinct non-C3 family strings (`model_contract` owns
  three routes, `observation_integrity` one). Asserted in the cancelled-path
  parameterized test rather than left as prose.

### One plan claim that does NOT hold at source

Acceptance 7 predicts `mark_distribution_circuit {feeds_board_id: ""}` →
`feeds_board_not_found`. The shipped code rejects one step EARLIER, at the
non-empty-string shape gate in `dispatchMarkDistributionCircuit`
(`invalid_feeds_board_id`), so a blank never reaches the board lookup. The
plan's CONCLUSION is correct and is what the test defends — out of scope by
construction, no blank-write rule needed on this tool — only the code it named
was wrong. Asserted against source, with the discrepancy recorded in the test
comment.

## Implementation

Three commits, each a coherent unit.

### `0ff0e45b` — Reject every blank write, and say so out loud

- **The predicate.** `src/extraction/blank-write-policy.js`, a leaf with ZERO
  imports. The zero-import property is load-bearing, not tidiness: one of the
  six boundaries is `dialogue-engine/helpers/dialogue-slot-normalise.js`, and
  the dialogue engine cannot import `stage6-tool-schemas.js` (that module
  imports `dialogue-engine/index.js` and uses the binding at top level — the
  cycle PLAN-A's `circuit-value-descriptors.js` note already documents).
- **Six boundaries**, all returning `empty_write_not_allowed` and naming the
  clear tool that can legitimately empty that field. An omitted or `null`
  argument is untouched.
- **Exemptions** are the IMPORTED union of `STRUCTURAL_READING_FIELDS` and
  `CLEAR_READING_EXCLUDED_FIELDS` (newly exported from the schemas module).
  `BLANK_WRITE_ALLOWED_FIELDS` is committed empty.
- **Audibility**: six families over nine routes in `refusal-notices.js`, plus
  `C3_NOTICE_FAMILIES` (the normative cancelled-path allowlist),
  `C3_NOTICE_ROUTES` and `VALUE_BEARING_NOTICE_FAMILIES`. Composition,
  slot identity and the journal live in `stage6-blank-write-notices.js`.
- **`resolveBulkTargets`** hoists the side-effect-free scope resolution above
  validation; the apply loop consumes it rather than re-deriving it.
- **`clear_field_for_all_circuits`** in `stage6-dispatcher-bulk-clear.js`,
  registered in `WRITE_DISPATCHERS`, with the bundler's grouped-clear branch
  keyed on `BULK_OUTCOME_CALL_ID`.
- **Answer reconciliation** in `stage6-shadow-harness.js`, one step before the
  answer finalizer, on both the normal and the cancelled path.
- **Cancelled path**: the `!cancelled` term moved from the outer net-0 guard
  into the staged filter as a positive allowlist.
- **Prompt**: the `""` instruction deleted; the one-ask flow, the
  `rejection_ref` rule and the bulk-clear edge case added. The `answer_user`
  half is inside the `A1:ON` block so the flag-off render still never names
  the tool.

### `78d9f9c2` — Acceptance tests

Five new files (86 tests) plus the deliberately inverted baselines. See the
commit body for what each file answers and why.

**One implementation defect the tests found and fixed in the same commit:**
`clear_field_for_all_circuits` counted a circuit carrying `''` as cleared,
because the property existed to delete. That put a `field_corrected` on the
wire for a cell that did not change and named the circuit in a spoken line
saying something happened to it. Already-empty is now decided on the VALUE.

### `55654b26` — Documentation

`field-reference.md` (bulk-clear parameter table + the "No silent clear"
section), `architecture.md` (a dated Stage 6 paragraph), `changelog.md` (the
full entry) and one hub row. The hub's two oldest rows were dropped to stay
inside the enforced 45,000-char budget — both verified present in
`changelog.md` first. `check-hub-size`: 43,200/45,000.

## Deviations

None. Every change is inside the plan's stated scope. Three routine
implementation choices are recorded because a reviewer will meet them:

1. **The bulk scope descriptor always renders the spare qualifier**, rather
   than only when it differs from a default. Selector `all` is reached from
   three raw scopes (`all`, legacy `non_spare`, omitted) whose defaults
   disagree, and `bulkScopeKey` carries the RESOLVED policy, not the raw
   scope — so a qualifier that appeared "only when not the default" would have
   to consult something outside the key and could render two strings for one
   slot, breaking the injectivity the plan requires. Always rendering it keeps
   the descriptor a pure function of the key and states what happened. The
   plan's two literal quoted strings for the `all` include/exclude pair are
   satisfied exactly.
2. **A bulk rejection stages NOTHING when the call's own `scope` or
   `spare_policy` is off-schema.** The descriptor would otherwise be a guess.
   This is the shipped trusted-discriminator contract that
   `stageCircuitPartialFailure` and the `unsupported_clear` branch already
   apply, and it is safe because such a call is rejected anyway and marker-2's
   catch-all still speaks.
3. **The post-ask BULK line makes no held-value claim** ("… unchanged"),
   because each circuit in a scope holds its own value and "still `<x>`" would
   be false for most of it. The plan's template offers both forms; the
   truthful one is used.

## Test gate

- Backend Jest: **9,822 passed, 0 failed, 19 skipped** (405 suites, 1 skipped).
- `npm run lint`: **0 errors** (180 pre-existing warnings, unchanged).
- `scripts/check-hub-size.mjs`: OK, 43,200/45,000.
- Prettier: the three new test files formatted; the rest of the tree is
  unchanged (the repo is not prettier-clean at rest, and lint-staged formats
  only staged files).

## Live lane (acceptance 8)

Probe: `PLAN-C3-live-probe.mjs` in the plan's handoff directory; results in
`PLAN-C3-live-probe-results-2026-09-23.json` beside it. It drives
`runShadowHarness` on a real `EICRExtractionSession` against the real vendor
endpoint with the live task-def environment pinned, and a real pending-ask
registry, so a blocking `ask_user` really blocks and is answered from the
probe. That is the only way to reach the post-ask rejection site.

**The first run found a real defect no unit test had caught.** On the exact
September-17 shape, the model did the right thing — one rejected write, one ask
with the options — but after the inspector's second off-enum answer the turn
spoke "I've lost that reply, I'm afraid", the P4 dropped-value apology. The
covering-ask reconciliation had swallowed `enum_rejected_after_ask`, because
that notice is staged BY the same ask's own resolution, so the ask always
matches its slot. Every drain test had staged a notice and an ask separately, so
nothing exercised an ask that produces its own refusal. Fixed in `88133d52`.

After the fix, and again on the final candidate (`bbdd5dd9`, 16:22 UTC),
`gpt-6-luna` Fast:

| Case | Tool calls | Asks | Post-ask refusal spoken | Field after | `narration_requires_rejection_ref` drops |
|---|---|---|---|---|---|
| `ocpd_bs_en` = "BS 3871", answered "BS 3871." | 1 `record_reading`, rejected | 1 | once | unset | 0 |
| `rcd_type` = "type Z", answered "Type Z." | 1 `record_reading`, rejected | 1 | once | unset | 0 |
| "set the reference method to nothing" | 1 `clear_reading`, ok | 0 | — | cleared, read back | 0 |

No second ask, no `""` write, no guessed option in any case. The spoken refusal:
"OCPD BS/EN on circuit 3 on board 1, still blank. That answer isn't one of the
options either, so I've left it."

## Codex diff review

Reviewer: Codex `gpt-6-sol`, high, read-only, schema-constrained, fresh
context per lane. Outputs in `PLAN-C3-ep-reviews/` in the handoff directory.

| Cycle | Lane | Result |
|---|---|---|
| 1 | c1 comprehensive | **Died on ENOSPC** mid-review (disk-full outage). Provider failure, not a verdict; log kept as `c1-comprehensive.ENOSPC-dead.log`. Re-run as c1b. |
| 1 | c2 specialist (spoken boundary) | 3 BLOCKER + 1 IMPORTANT. |
| 2 | c1b comprehensive (re-run on `bf2e28d0`) | 1 BLOCKER + 3 IMPORTANT. |
| 2 | c3 fix-verify of cycle 1 | **Clean.** All fixes hold; the finding-4 rejection upheld. |
| 3 | c4 fix-verify of cycle 2 | 1 BLOCKER + 1 IMPORTANT. |
| 4 | c5 fix-verify of cycle 3 | **Clean.** Fix holds; the rejection upheld. |

Dispositions, all with source evidence, all in commit bodies:

- c2-1 BLOCKER — an answered ask retired its own post-ask refusal. **FIXED**
  `88133d52` (the live lane had found it first; independent confirmation).
- c2-2 BLOCKER — an ask registered but never sent retired a refusal. **FIXED**
  `bf2e28d0`: only asks in `emittedAskToolCallIds` cover.
- c2-3 BLOCKER — bulk descriptors dropped the ref list above six, so two slots
  rendered one string. **FIXED** `bf2e28d0`: compressed runs, still exact.
- c2-4 IMPORTANT — extend answer ownership to non-C3 notices. **REJECTED**: the
  plan scopes the rule by the `rejection_ref` contract; extending it drops
  unrelated answers the model had no way to mark. **Upheld by c3.**
- c1b-1 IMPORTANT — a global field's refusal (`ze`, main) never matched the
  write's (`ze`, null) slot, and aliases never matched. **FIXED** `bbdd5dd9`:
  `boardNoticeSlot` derives the identity exactly as the write path stamps it.
- c1b-2 BLOCKER — a `'*'` sweep spoke two identical grouped lines with one
  token. **FIXED** `bbdd5dd9`: multi-board calls name the board in text and
  token; single-board unchanged.
- c1b-3 IMPORTANT — an unknown `board_id` returned `{ok:true, cleared:[]}`.
  **FIXED** `bbdd5dd9`: `board_not_found`.
- c1b-4 IMPORTANT — the cancelled-path sweep could not fail for label-less
  routes. **FIXED** `bbdd5dd9`: asserts on emission telemetry, routes staged
  under their real families.
- c4-1 BLOCKER — two board fields share "main earth". **REJECTED**: the alias is
  not in `BOARD_FIELD_ENUM`, so no refusal is ever keyed on it; a test now
  enumerates all 84 reachable board fields for label collisions, with a
  known-bad case. **Upheld by c5.**
- c4-2 IMPORTANT — one-circuit-per-board sweep lines lacked the board.
  **FIXED** `4caee4f8`.

Every code fix is pinned by a regression proven to FAIL against the pre-fix
source on the same path (stash the fix, run, fail; restore, pass).

Convergence: four cycles against a cap of ten. The findings narrowed each
cycle — each later one a refinement of the previous fix's edge, not a recurring
defect — and the final cycle is clean with both rejections independently
upheld.

## Observed and deliberately matched

On a single-board session every board-sensitive line renders " on board 1",
because `spokenBoardOrdinal` resolves the default main board. The plan says to
render the clause "exactly as `stageStructuralReadingRefusal` renders it", and
that shipped family does the same; diverging would make two families disagree
about one slot. Recorded rather than changed.

## Final gate at `4caee4f8`

- Backend Jest: **9,837 passed, 0 failed, 19 skipped** (405 suites).
- `npm run lint`: 0 errors.
- `scripts/check-hub-size.mjs`: OK, 43,200/45,000.
- No conflict markers in `HEAD` (`git grep -n -E '^(<<<<<<< |>>>>>>> )' HEAD`).
- `origin/main` has not moved since the branch point (`7dc4cd94`).

## Successor

Hop 5 is **PLAN-B-v31**, by the wave coordinator's decision
(`eicr-automation-a7`, cross-session message 2026-09-23, in reply to this
executor): PLAN-C2's own queue marker says it ships after PLAN-CC and PLAN-CS's
schema flip, and PLAN-CS has not shipped. PLAN-B's executor launches PLAN-D as
hop 6; PLAN-D launches nothing. PLAN-CS, PLAN-C2 and PLAN-CD stay queued for
the coordinator.
