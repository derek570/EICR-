# Handoff — "Work on Board" Phase B shipped (2026-05-08)

**Read this first** if you are picking up the "Work on Board" sprint.

## TL;DR

Phase B of the "Work on Board" sprint landed in a single commit on
`main` and was pushed to GitHub Actions for deploy. CI run
**25561866675** in flight at handoff time (HEAD `d783818`). Phase A's
preceding deploy (CI run **25560825421**) completed green earlier in the
same session.

The sprint's central rule — *cross-board writes only happen via an
explicit `select_board` switch* — is now structurally enforced at the
dispatcher contract, not just suggested in prose. Sonnet must call
`select_board` before recording on a different board; otherwise the
mutator returns `wrong_board` and the snapshot stays untouched.

If you only read one section: **[What's shipped](#whats-shipped) →
[How to verify](#how-to-verify) → [Next concrete step is Phase C](#next-step--phase-c)**.

---

## What's shipped

Single commit pushed to `main` in this session:

| Commit | Slice | What it does |
|---|---|---|
| `d783818` | Phase B | New `validateBoardScope` pure helper; wired into 5 circuit-mutator dispatchers (record_reading, clear_reading, create_circuit, rename_circuit, delete_circuit) + record_board_reading; SINGLE-BOARD FOCUS rule added to the agentic system prompt; 20 new regression tests in `stage6-work-on-board-phase-b-scope.test.js`; 2 pre-existing tests rewritten to honour the new contract; prompt token caps bumped (+150 combined / +200 base) for the new paragraph. |

Backend full suite: **3182 passing, 3 pre-existing skips, 0 failed.**
(Phase A finished at 3162; this commit added 20 net tests.)

The pre-push hook re-ran the suite before push — green there too.

---

## What changed structurally

### The contract (the load-bearing rule)

| Tool | Pre-Phase-B behaviour with explicit `board_id ≠ currentBoardId` | Post-Phase-B behaviour |
|---|---|---|
| `record_reading` | Wrote silently to the named board | Rejects `wrong_board`; snapshot untouched |
| `clear_reading` | Cleared silently on the named board | Rejects `wrong_board`; snapshot untouched |
| `create_circuit` | Created silently on the named board | Rejects `wrong_board`; snapshot untouched |
| `rename_circuit` | Renamed silently on the named board | Rejects `wrong_board`; snapshot untouched |
| `delete_circuit` | Deleted silently on the named board | Rejects `wrong_board`; snapshot untouched |
| `record_board_reading` | Wrote silently to the named board's BoardInfo | Rejects `wrong_board`; snapshot untouched |

Tools INTENTIONALLY exempt (cross-board explicit `board_id` still allowed):

- `calculate_zs`, `calculate_r1_plus_r2` — Phase 6.5 cross-board calc contract.
- `set_field_for_all_circuits` — supports the `'*'` cross-board sweep.
- `select_board` — the switch tool itself.
- `add_board` — creates new boards; `currentBoardId` doesn't apply.
- `mark_distribution_circuit` — `board_id` arg names the SOURCE board for
  the relationship, not a write target.

The exemptions are documented inline in `validateBoardScope`'s JSDoc and
pinned by a regression test that proves `calculate_zs` with explicit
cross-board `board_id` still succeeds, and that `select_board` itself
isn't gated.

### Rejection envelope shape

```js
{
  ok: false,
  error: {
    code: 'wrong_board',
    field: 'board_id',
    expected: 'main',          // the session's currentBoardId
    got: 'sub-1',              // the offending input
    hint: 'Call select_board to switch boards before recording on a different one.',
  },
}
```

Sonnet receives this via the `tool_result` envelope and the prompt
explicitly tells it to call `select_board(board_id)` first then retry.
The recovery loop is one extra tool call, not a re-prompt.

### Implementation note: why a pure helper

`validateBoardScope(input, snapshot)` lives in
`src/extraction/stage6-dispatch-validation.js` next to the existing
`validate*` family. Pure function, returns `null | {code, field?, …}`,
no logging, no async. This:

1. Mirrors the existing validator pattern — every dispatcher now has the
   shape `validate*() || validateBoardScope()` chained via `||`.
2. Lets the shadow comparator replay the gate identically (the
   comparator is a pure function of (input, state), and any non-pure
   helper would break that contract).
3. Fall-back to `getMainBoardId(snapshot)` when `currentBoardId` is
   absent, so a future caller that constructs a snapshot without
   running `ensureMultiBoardShape` still gets the right rejection
   instead of an undefined-`expected` silent accept.

### Prompt update

`config/prompts/sonnet_agentic_system.md` gains a SINGLE-BOARD FOCUS
paragraph immediately after the existing MULTI-BOARD ROUTING section.
Codifies the contract from Sonnet's perspective: do not pass `board_id`
on the gated tools; the server will reject and you must `select_board`
first; the calc / bulk tools remain free to take an explicit
`board_id` for cross-board ops on inspector request.

The paragraph is dense — ≈85 tokens. Token-cap regression tests bumped:

- `stage6-agentic-prompt.test.js` Group 1 (combined): `8600 → 8750` (+150).
- `stage6-agentic-prompt.test.js` Test F (base): `6100 → 6300` (+200).

Bumps are proportionate to the 2026-05-07 multi-board-routing addition
(+500 each); the smaller delta here reflects the smaller paragraph. Both
caps still preserve the ~100-token headroom convention.

---

## How to verify

### Check CI status

```bash
gh run view 25561866675 --json status,conclusion,url
gh run watch 25561866675 --exit-status   # one long-poll connection — no polling
```

Phase A's CI run **25560825421** completed `success` earlier in the
same session. Phase B's run was `in_progress` at handoff time.

### Local sanity check

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
git log --oneline origin/main~2..origin/main      # should show the Phase B commit + the prior Phase A handoff doc
npm test --silent | tail -5                       # 3182 passing, 3 skipped
```

### Replay the rejection contract

The new suite `src/__tests__/stage6-work-on-board-phase-b-scope.test.js`
exercises the contract end-to-end:

- Per-dispatcher omit / match / mismatch triple for all 6 gated tools.
- Snapshot + `perTurnWrites` untouched on rejection (every test asserts
  this — a half-applied write would leak through `perTurnWrites` even
  if the snapshot stayed clean).
- The recovery path: `record_reading` rejected → `select_board` flip →
  retry without `board_id` succeeds.
- Negative-space coverage: `calculate_zs` with explicit cross-board
  `board_id` still returns `is_error: false`.

### Field-test scenario

Same provoking incident as Phase A's gate (session **EEB8F9EA**,
2026-05-08 — "moving on to subboard, garage fed from circuit 11"), but
Phase B closes a different failure mode: the inspector says "moving on
to sub-board" but for whatever reason Sonnet sees a transcript fragment
("circuit 12 on the main board") and tries an explicit cross-board
write. Pre-Phase-B: silent main-board overwrite. Post-Phase-B: server
rejects, Sonnet calls `select_board` first.

---

## Decisions locked in this session

These are *additive* to the sprint's Phase 0 locks and the
Phase A decisions:

1. **Gated set is exactly six tools.** record_reading, clear_reading,
   create_circuit, rename_circuit, delete_circuit, record_board_reading.
   No others. Each one is a write that *targets one board*. Tools whose
   semantics are explicitly cross-board (calc / bulk) or board-system
   (select_board, add_board, mark_distribution_circuit) stay
   untouched.
2. **Single-source `validateBoardScope` over per-dispatcher inline
   checks.** A duplicated check across 6 dispatchers would drift. One
   helper, one error-shape, one place to update if the rejection prose
   needs a tweak.
3. **Helper falls back to `getMainBoardId(snapshot)` when
   `currentBoardId` is missing.** Without this, an undefined
   `expected` would silently accept any non-null `board_id` — the
   worst possible failure mode (corruption + no signal). Pinned by a
   unit test.
4. **Two pre-existing tests with cross-board explicit `board_id`
   were rewritten in place** (rather than deleted) so the schema
   thread-through coverage they provided survives. Each got a
   `currentBoardId='sub-1'` assignment so the explicit `board_id='sub-1'`
   matches scope. The single test that explicitly asserted the OLD
   permissive behaviour was rewritten to assert the new rejection
   envelope.
5. **No `select_board` auto-emit on `wrong_board` reject.** The error
   tells Sonnet what to do; Sonnet does it. Server-side auto-flip
   would mask the contract mismatch and complicate observability —
   we want every board switch to be a first-class tool call in the
   transcript log.

---

## Next step — Phase C

**Phase C: iOS voice command "Work on \[X\]" → `select_board`.**
iOS-only. Estimate **1 session.** Files to touch (audit pending):

1. `Sources/Processing/TranscriptFieldMatcher.swift` (or a sibling like
   `BoardSwitchCommand.swift` — TBD by what fits the existing
   detector pattern). Add a deterministic regex for "work on X",
   "switch to X", "now on X" patterns.
2. Substring-contains, longest-match-wins lookup against
   `job.boards.map { $0.designation }`. Ambiguity → TTS clarification.
3. On match: emit a `select_board` event over the existing
   `ServerWebSocketService` channel. Backend dispatches the existing
   `select_board` Stage 6 tool — no backend work needed.
4. Suppress the matched transcript from the Sonnet forward (control
   command, not a reading).
5. Tests in `TranscriptFieldMatcherTests.swift`: happy path, filler-
   word tail strip, ambiguity branch, no-match passthrough.

**Phase B is the foundation that makes Phase C correct.** When the
voice command flips `currentBoardId` server-side, every subsequent
dictated reading on the new board lands at the right composite-key
bucket (Phase A) and Sonnet can no longer accidentally cross-write
(Phase B).

---

## Phases D + E (queued, NOT in scope here)

Per the sprint's PLAN.md table:

| Phase | Layer | Estimate |
|---|---|---|
| D | iOS — red-banner UI on off-boards | 0.5 session |
| E | Backend + iOS — WS broadcast `current_board_changed` | 0.5 session |

D + E ship together (D's banner needs E's reactivity). Phase B doesn't
require them — sub-boards are storage-safe and write-scope-safe today.
D + E are the inspector-facing UX gate.

---

## Files touched in this session

Production:
- `src/extraction/stage6-dispatch-validation.js` — added
  `validateBoardScope` pure helper + JSDoc with exempt-tools rationale.
- `src/extraction/stage6-dispatchers-circuit.js` — wired the helper
  into the 5 circuit-mutator validators via `||` chaining.
- `src/extraction/stage6-dispatchers-board.js` — wired the helper into
  `dispatchRecordBoardReading` after the existing field-enum check.
- `config/prompts/sonnet_agentic_system.md` — added SINGLE-BOARD
  FOCUS paragraph after MULTI-BOARD ROUTING.

Tests rewritten (existing tests that asserted Phase A's permissive
cross-board behaviour):
- `src/__tests__/stage6-multi-board-flag-routing.test.js` — converted
  the "forward-compatible with explicit board_id" test to assert the
  Phase B rejection envelope.
- `src/__tests__/stage6-tool-schemas-board-id-thread.test.js` — three
  tests rewritten to set `currentBoardId='sub-1'` so the explicit
  `board_id='sub-1'` arg is in-scope; schema thread-through coverage
  preserved.
- `src/__tests__/stage6-agentic-prompt.test.js` — Group 1 + Test F
  token caps bumped (+150 / +200) with inline cap-history comments.

Tests added:
- `src/__tests__/stage6-work-on-board-phase-b-scope.test.js` (581
  lines, 20 tests). Six describe blocks: validateBoardScope unit
  tests; one block per gated dispatcher (omit / match / mismatch);
  the select_board recovery path; negative-space exemption coverage
  (calc + select_board pass-through).

Docs:
- This handoff. Sprint `HANDOFF.md` status header to be updated
  immediately after this commit.

---

## Cross-references

- Sprint plan: `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/PLAN.md`
- Sprint handoff (rolling): `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/HANDOFF.md`
- Phase A handoff: `.planning-stage6-agentic/handoffs/handoff_2026-05-08_work-on-board-phase-a-shipped.md`
- Parent multi-board sprint: `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/HANDOFF.md`
- Phase 5 re-key plan (eventual destination, not what this sprint took):
  `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PHASE5_HANDOFF.md`
- Provoking incident: session **EEB8F9EA** (2026-05-08)
- Phase A foundation commit: `382985e` (`feat(stage6): "Work on
  Board" Phase A — dual-shape circuit storage…`)
- Phase B commit: `d783818` (`feat(stage6): Work on Board Phase B —
  strict currentBoardId scope`)

---

## Things to watch in field test

1. **Recovery path is now a first-class signal.** When Sonnet receives
   `wrong_board`, it should call `select_board` then retry the write.
   The first time this fires in a real session, watch the dispatcher
   log row: outcome should be `'rejected'` with
   `validation_error: {code: 'wrong_board', …}`. If it shows up as
   `'ok'` or some other code, Phase B is failing silently — either
   the helper isn't firing or the rejection envelope is being swallowed
   upstream.
2. **No prompt drift on cross-board calc.** The prompt explicitly tells
   Sonnet that calc / bulk tools accept explicit `board_id`. If a
   future field test sees Sonnet refusing to call
   `calculate_zs(all: true, board_id: 'sub-1')` on a multi-board job,
   that's prompt regression — the SINGLE-BOARD FOCUS paragraph's
   final clause must remain intact.
3. **Tool-loop cap is still the ultimate failsafe.** A pathological
   loop where Sonnet keeps issuing cross-board writes and ignoring
   `select_board` would terminate at the existing 8-round cap. Worth
   confirming the cap fires cleanly if it ever happens — Phase A's
   retry harness covers this for `add_board` failure but not for
   `wrong_board` specifically.
4. **The error envelope's `hint` field is new.** The existing error
   shape across the dispatcher family is `{code, field}` with maybe
   `details`. `validateBoardScope` adds a `hint` — a plain-English
   sentence directing Sonnet's next action. If a future regression
   asserts strict-shape-only on the error envelope, the test will
   fail; treat that as a contract update, not a bug.
