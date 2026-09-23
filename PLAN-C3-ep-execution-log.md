# PLAN-C3 `/ep` execution log — feedback-2026-09-17 wave

- **Session:** `eicr-automation-ed [aaf7b4]` (tmux `claunch-opus-high-54678`, pane `%111`)
- **Plan:** `PLAN-C3-v19.md` (sha256 `b6f65671b26faeb6dc43a56e583e9415d5ba98a2b1dea9e7018b93e3917ecfb3`); `PLAN-C3.md` byte-identical (`cmp`)
- **Convergence:** `PLAN-C3-ledger.json` — `status: CONVERGED`, `converged_round: 13`, `open_design_issues: []`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-c3-ep-20260923`
- **Branch:** `ep/plan-c3-no-silent-clear-20260923` off `origin/main` @ `7dc4cd94`
- **Chain:** `--chain`, hop 4 (Decision 27). Successor: PLAN-C2.
- **Executor runtime:** Claude Opus 5, high effort (`claude-opus-5`). Reviewer lane: Codex `gpt-6-sol`, high.

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

## Codex diff review

(appended below as cycles complete)

## Live lane (acceptance 8)

(appended below)
