# Handoff — "Work on Board" Phase A shipped (2026-05-08)

**Read this first** if you are picking up the "Work on Board" sprint.

## TL;DR

Phase A of the "Work on Board" sprint landed end-to-end on `main` and was
pushed to GitHub Actions for deploy. CI run **25560825421** in flight at
handoff time.

The sprint's core invariant — *sub-board circuit writes never clobber
main's circuits* — is now structurally guaranteed at the storage layer.
The `STAGE6_MULTI_BOARD` env flag is dead code; the routing is per-call,
based on the resolved board id.

If you only read one section: **[What's shipped](#whats-shipped) →
[How to verify](#how-to-verify) → [Next concrete step is Phase B](#next-step--phase-b)**.

---

## What's shipped

5 commits pushed to `main` in this session (chronological):

| Commit | Slice | What it does |
|---|---|---|
| `382985e` | A.1 + A.2 | `getMainBoardId` helper + dual-shape rewrite of `getCircuitBucket` / `listCircuitRefsInBoard` / `circuitExistsInSnapshot` + dual-shape `*FlagAware` mutator wrappers. **32 tests rewritten across 4 suites** to drop env-flag toggles and re-target composite-key assertions at sub-board scope. |
| `d725671` | docs | Handoff status update after A.1/A.2. |
| `d1ad05b` | A.3 | `_seedStateFromJobState` now (a) hydrates `stateSnapshot.boards[]` from `jobState.boards[]` if the iOS PUT supplies it, (b) resolves `currentBoardId` to the main board id (Q0.1 lock), and (c) routes each seeded circuit to the legacy bare-numeric key (main) or the composite key `${board_id}::${num}` (sub-board). 4 new regression tests. |
| `cc303bc` | A.4 | `buildStateSnapshotMessage` migrated to dual-shape (main supply ← `circuits[0]`, sub-board supply ← BoardInfo on `boards[]`). **`isMultiBoardFlagOn()` export + `STAGE6_MULTI_BOARD` env var DELETED entirely.** Test cleanup across 5 files removes dead env-flag toggles. |
| `e44c603` | docs | Final handoff status update. |

Backend full suite: **3162 passing, 3 pre-existing skips, 0 failed.**

The pre-push hook re-ran the suite before push — green there too.

---

## What changed structurally

### Storage shape (the load-bearing rule)

| Board | Circuit-bucket key | Supply / board-level field location |
|---|---|---|
| **Main** (`currentBoardId === getMainBoardId(snapshot)`) | Legacy bare-numeric (`circuits[1]`, `circuits[2]`, …) | `circuits[0]` (legacy supply bucket — every existing reader expects it here) |
| **Sub-board** (any other id) | Composite (`circuits['sub-1::1']`, …) with self-describing `{circuit, board_id}` skeleton | BoardInfo on `boards.find(b => b.id === id)` |

Why dual-shape rather than full composite (which the older Phase 5 sprint
queued): every existing iterator that filters
`Number.isInteger(n) && n >= 1` over `snapshot.circuits` keys keeps working
untouched, because main's circuits stay at bare numeric keys.

### The env flag is gone

- `process.env.STAGE6_MULTI_BOARD` — no remaining production reader.
- `isMultiBoardFlagOn()` — export deleted.
- 5 test files cleaned of dead env-flag toggle scaffolding.
- Only historical comments remain (e.g. "_replaces the previous
  `STAGE6_MULTI_BOARD` env-flag branch_") — those are intentional
  archaeology.

### Routing rule (one-liner)

The dispatcher / serialiser asks `getMainBoardId(snapshot)` and compares
to the resolved target board id. Equal → legacy path. Different → composite
/ BoardInfo path. That's the entire contract. Every `*FlagAware` wrapper
(name preserved for import stability) is a thin `if main → legacy else
multi-board` switch.

### Acceptance gate (Phase A) — met

The EEB8F9EA "moving on to sub-board, garage fed from circuit 11" production
repro now works structurally end-to-end:

- `add_board(sub_main, parent='main', feed=11)` accepted (was: rejected
  pre-`27a1b94`).
- 3 readings dictated against sub-1's circuit 1 land at
  `circuits['sub-1::1']`, byte-distinct from main's `circuits[1]`.
- Snapshot serialiser emits each board's view per its scope on
  `currentBoardId` switch.

---

## How to verify

### Check CI status

```bash
gh run view 25560825421 --json status,conclusion,url
gh run watch 25560825421 --exit-status   # one long-poll connection — no polling
```

CI run was in `in_progress` (Build Backend stage) at handoff time. ETA per
CLAUDE.md: ~30 min end-to-end. Memory rule: deploy via GitHub Actions only,
never `./deploy.sh` (Docker Desktop isn't kept running on the dev Mac).

### Local sanity check

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
git log --oneline origin/main~5..origin/main   # should show the 5 Phase A commits
npm test --silent | tail -5                    # 3162 passing, 3 skipped
```

### Repro the EEB8F9EA scenario

Tests exercise this in `src/__tests__/eicr-extraction-session.test.js`'s
"_seedStateFromJobState — Work on Board Phase A.3 dual-shape routing"
describe block. The "multi-board job: hydrates boards[] from jobState;
routes circuits per dual-shape" case is the canonical fixture.

For an end-to-end check against a deployed session, dictate "moving on to
sub-board, garage fed from circuit 11" against a fresh job. Pre-fix:
`add_board` rejected → Sonnet flailed → 8-round tool loop. Post-fix: sub-1
created cleanly, subsequent readings land on sub-1 buckets.

---

## Decisions locked in this session

These are *additive* to the sprint's Phase 0 locks (still in
`PLAN.md` and the parent `HANDOFF.md`):

1. **`getMainBoardId(snapshot)` — single source of truth for "which board
   is main"**. Resolution order: `boards[]` entry with `board_type === 'main'`
   (or absent — legacy seeded snapshots may omit the field) → `boards[0].id`
   → `'main'` literal. Cached on every call (no memoization needed; cheap
   array scan).
2. **Skeleton-key strip is unconditional in the snapshot serialiser.**
   The compact projection skips `circuit` + `board_id` from every bucket
   regardless of namespace. For main, this is a no-op (legacy buckets never
   carry those keys); for sub-boards, it preserves byte-equivalent emitted
   shape with main.
3. **Q0.1 implementation — `_seedStateFromJobState` always sets
   `currentBoardId = getMainBoardId(snapshot)` on session start.** No stale
   "last active" restored. The hydrated boards[] (from `jobState.boards[]`
   if present) wins over the synth default.
4. **Camel-case `boardId` accepted alongside snake-case `board_id` on
   seeded circuits.** Mirrors the existing `measuredZsOhm || zs` /
   `polarityConfirmed || polarity` defensive pattern. iOS encodes
   `board_id` snake-case via Codable but other server-side hydration paths
   may surface camelCase.
5. **Unknown `board_id` on a seeded circuit falls back to the legacy
   bucket.** Defensive against partially-hydrated payloads. The
   hierarchy validator on the next PUT surfaces orphan circuits if the
   inspector cares to fix them.

---

## Next step — Phase B

**Phase B: server strict `currentBoardId` scoping + system prompt hint.**
Backend-only, single commit. Tighten the agentic-prompt + dispatcher
contract so:

1. Every circuit-mutator tool call MUST resolve to `currentBoardId` (or
   include an explicit `board_id`). Cross-board readings without an
   explicit `board_id` get rejected with a structured error (or, more
   likely, are routed correctly — confirm at the dispatcher layer
   whether default-to-current is already the locked behaviour).
2. The system prompt explains the scope to Sonnet: "All readings land on
   the active board. If the inspector mentions a different board, call
   `select_board` first." (Q0.4 locked: NO auto-routing of cross-board
   readings.)

**Estimate: 0.5 session.** Files to touch (best-guess audit):
- `src/extraction/stage6-dispatchers-circuit.js` — verify the validator
  resolution chain fires `currentBoardId` correctly for missing
  `board_id`.
- `src/extraction/eicr-agentic-prompt.txt` (or wherever the agentic
  prompt lives) — add the "all writes scope to currentBoardId" paragraph.
- New regression tests under `src/__tests__/` pinning the contract.

`select_board` tool itself does not exist yet — that's Phase C+ when
iOS gets the voice command. Phase B can land without it as a defensive
prompt-only change.

---

## Phases C–E (queued, NOT in scope here)

Per the sprint's PLAN.md table:

| Phase | Layer | Estimate |
|---|---|---|
| C | iOS — voice command "Work on \[X\]" → `select_board` | 1 session |
| D | iOS — red-banner UI on off-boards | 0.5 session |
| E | Backend + iOS — WS broadcast `current_board_changed` | 0.5 session |

D + E ship together (D's banner needs E's reactivity).

---

## Files touched in this session

Production:
- `src/extraction/stage6-multi-board-shape.js` — added `getMainBoardId`,
  dual-shape rewrites, deleted `isMultiBoardFlagOn`
- `src/extraction/stage6-snapshot-mutators.js` — dual-shape wrappers
- `src/extraction/eicr-extraction-session.js` — `_seedStateFromJobState`
  hydration + routing; `buildStateSnapshotMessage` dual-shape; dropped
  `isMultiBoardFlagOn` import

Tests rewritten:
- `src/__tests__/stage6-multi-board-flag-routing.test.js` (32 tests
  rewritten, `isMultiBoardFlagOn` describe block deleted)
- `src/__tests__/stage6-tool-schemas-mark-distribution-circuit.test.js`
- `src/__tests__/stage6-tool-schemas-board-id-calc-sweep.test.js`
- `src/__tests__/stage6-tool-schemas-board-id-thread.test.js`
- `src/__tests__/eicr-extraction-session.snapshot-refactor.test.js`
- `src/__tests__/stage6-snapshot-mutators-multi-board.test.js` (comment-only)
- `src/__tests__/eicr-extraction-session.test.js` (4 new tests added)

Docs:
- `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/HANDOFF.md`
  (status header + "next steps" section updated)

---

## Cross-references

- Sprint plan: `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/PLAN.md`
- Sprint handoff (rolling): `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/HANDOFF.md`
- Parent multi-board sprint: `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/HANDOFF.md`
- Phase 5 re-key plan (eventual destination, not what this sprint took):
  `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PHASE5_HANDOFF.md`
- Provoking incident: session **EEB8F9EA** (2026-05-08 — "moving on to
  subboard, garage fed from circuit 11")
- Foundation commit: `27a1b94` (`add_board` accepts legacy keyed-snapshot
  circuits — landed earlier same day)

---

## Things to watch in field test

1. **Sub-board sessions are now actually safe to dictate against.** Before
   Phase A, an inspector who said "moving on to sub-board" would either
   crash the agentic loop (EEB8F9EA) or, if they got past `add_board`,
   silently overwrite main's circuits. Now sub-board readings land on
   their own composite-key namespace. **Validate this in the field
   before assuming it works** — the test fixtures cover the structural
   shape but not the live transcript path through Sonnet.
2. **Snapshot serialiser emits per-scope.** When the inspector switches
   `currentBoardId` (Phase C will wire this from voice; today only
   `add_board` and the seeder set it), the next snapshot the model sees
   will reflect the new board's circuits. Watch for any "I see N circuits"
   confusion in TTS output during a board switch — the model may need a
   beat to re-orient.
3. **Cross-board calc tools need an explicit `board_id`.** `calculate_zs
   / calculate_r1_plus_r2 / set_field_for_all_circuits` already accept
   `board_id` in their schemas (Phase 6.5); the prompt may need a hint
   that for sub-board calculations the inspector should call them with
   the explicit board id (or rely on `currentBoardId` defaulting). Phase
   B will tighten this prose.
