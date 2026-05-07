# Phase 5 — Slices 5.5 + 5.6 Handoff (post-2026-05-07 session)

**Read this first** when resuming Phase 5. The sprint-level [HANDOFF.md](HANDOFF.md)
is the entry point for the whole sprint; the original [PHASE5_HANDOFF.md](PHASE5_HANDOFF.md)
covers slices 5.1–5.6 design.

This file is the focused brief for the **two remaining slices** after the
2026-05-07 session shipped 5.1, 5.2, 5.3, and 5.4. Last updated 2026-05-07.

---

## What's already shipped (cold-start primer)

The 2026-05-07 session landed 4 of 6 Phase 5 slices on `main`. **Default-off**
in production — flag-on is feature-tested but not yet deployed.

| Slice | Commit | What |
|---|---|---|
| 5.1 | `3215e6f` | `ensureMultiBoardShape` helper + constructor wire-in. Every snapshot now carries `boards: [{id:'main', designation:'DB-1', board_type:'main'}]` and `currentBoardId: 'main'`. Idempotent — safe to call from any future hydration path. |
| 5.2 | `9fd646f` | 5 composite-key mutators in `stage6-snapshot-mutators.js`: `applyReadingMultiBoard`, `clearReadingMultiBoard`, `upsertCircuitMetaMultiBoard`, `renameCircuitMultiBoard`, `deleteCircuitMultiBoard`. Plus `findCircuitBucket`. Composite key shape: `${board_id}::${circuit}`. Bucket shape: `{circuit, board_id, ...fields}`. |
| 5.3 | `0876bed` | `STAGE6_MULTI_BOARD` env flag plumbed via `isMultiBoardFlagOn()`. 5 `*FlagAware` wrappers in mutators module. 4 validators in `stage6-dispatch-validation.js` updated to use `circuitExistsInSnapshot`. 7 dispatcher write sites in `stage6-dispatchers-circuit.js` migrated. 2 derived-script writes (`ring-continuity-script.js`, `insulation-resistance-script.js`) migrated. Legacy off-mode path in `eicr-extraction-session.js` migrated for consistency. |
| 5.4 | `cd43a50` | 2 reader helpers in `stage6-multi-board-shape.js`: `getCircuitBucket(snapshot, ref, boardId?)`, `listCircuitRefsInBoard(snapshot, boardId?)`. 4 reader sites in `stage6-dispatchers-circuit.js` migrated: `selectorRefs` (powers calc tools), per-circuit bucket lookups in calc dispatchers, iteration in `dispatchSetFieldForAllCircuits`, per-bucket fetch in same. Calc tools end-to-end round-trip works under flag-on. |

**Test counts:** 3033 passing + 3 skipped (was 2953 baseline). 80 new tests
across 4 new test files / extensions. Full backend suite green at HEAD `cd43a50`.

**Local commits not yet pushed to origin** at the time of writing —
verify with `git log @{u}..HEAD --oneline` and push when ready.

---

## What's NOT done

**Slice 5.5** — board-level migration. Write `record_board_reading` to
`snapshot.boards[currentBoardId][field]` instead of `circuits[0][field]`.
Migrate the snapshot serialiser to read board fields from the new
location. **This is the path-2 hotspot** — the auto-resolve hook
dispatches synthetic `record_board_reading` calls; touching this code
without coordinating risks regressing the 2026-04-27 path-2 fixes.

**Slice 5.6** — delete `circuits[0]` and the legacy `applyBoardReadingToSnapshot`
mutator. **Gated on a deploy cycle with `STAGE6_MULTI_BOARD=true`** —
DO NOT ship 5.6 in the same session as 5.5; the original PHASE5_HANDOFF.md
is explicit about this:

> 5.6 — Legacy `circuits[0]` removal. After 5.4 + 5.5 land and CI is
> green for ≥1 deploy cycle, delete the remaining `circuits[0]`
> references and the legacy mutator (`applyBoardReadingToSnapshot` at
> `stage6-snapshot-mutators.js:49-74`).

**Phase 7 deferrals from slice 5.4** (these are NOT slice 5.5):
- `ring-continuity-script.js` lines 936/939/986 — circuit iteration for
  ring-set finding (read-side, not write-side)
- `insulation-resistance-script.js` lines 446/473/476 — same pattern
- `ring-continuity-timeout.js:81`, `insulation-resistance-timeout.js:67` —
  partial-ring detection scans
- `dialogue-engine/helpers/circuit-resolution.js` lines 70/73/147 —
  designation-to-circuit lookup
- `stage6-dispatcher-ask.js:909` — `Object.entries(circuits)` for ask_user
  flows
- `filled-slots-filter.js:253` — schedule projection

These don't gate flag-on functional correctness for the basic
record_reading + calc round-trip. Migrate them when Phase 7 (prompt +
ask-user resolver migration) needs the dialogue engine multi-board-aware.

---

## Slice 5.5 — design decisions

### The path-2 invariant — read this BEFORE editing

`stage6-answer-resolver.js:351` is the auto-resolve write hook. When a
user replies to an `ask_user` with a `pending_write: {tool, field, value}`
attached, the resolver matches the reply to a circuit (or accepts a
broadcast) and dispatches a synthetic `record_reading` or
`record_board_reading` call via `createAutoResolveWriteHook` in
`stage6-dispatchers.js`. The synthetic call goes through the normal
dispatcher pipeline:

1. validator runs (already flag-aware — slice 5.3)
2. mutator runs (already flag-aware — slice 5.3 for record_reading)
3. perTurnWrites accumulator updates
4. log row emitted

The `record_board_reading` mutator path is the gap. Today it calls
`applyBoardReadingToSnapshot(snapshot, {field, value})` which writes to
`snapshot.circuits[0][field]`. Slice 5.5 needs to migrate this to write
to `snapshot.boards.find(b => b.id === currentBoardId)[field]`.

The path-2 resolver itself does NOT need to change — it just dispatches
through the normal pipeline. The pipeline's mutator end is what shifts.

**Required reading:** `memory/handoff_2026-04-27_path2_review_fixes.md`
for the resolver invariants the migration must preserve. The 6 bugs that
landed today's resolver were all about the contract between Sonnet's
`pending_write` shape and the synthetic dispatcher's behaviour. Don't
break that contract.

---

### Recommended slice 5.5 structure (3 commits)

#### 5.5.1 — `applyBoardReadingMultiBoard` mutator + flag-aware wrapper

**New code in** `src/extraction/stage6-snapshot-mutators.js`:

```js
// Phase 5.5 — board-level multi-board mutator. Writes to BoardInfo on
// the active board's `boards[]` entry rather than to `circuits[0]`.
// The board record is created on first write if it doesn't exist (the
// session constructor synthesises a default `main` board, but a future
// hydration path might restore partial state).
//
// Bucket shape: `{id, designation, board_type, ...fields}`. The first
// three are seeded by `ensureMultiBoardShape`; subsequent writes accrete
// supply / installation field names alongside.
//
// Why a separate mutator from `applyReadingMultiBoard`: the storage
// shape is different. Circuits live at `snapshot.circuits[`${id}::${ref}`]`;
// boards live at `snapshot.boards[].find(b => b.id === id)`.
export function applyBoardReadingMultiBoard(snapshot, { field, value, boardId }) {
  const id = boardId ?? snapshot?.currentBoardId ?? DEFAULT_BOARD_ID_FALLBACK;
  if (!Array.isArray(snapshot.boards)) {
    snapshot.boards = [];
  }
  let board = snapshot.boards.find((b) => b && b.id === id);
  if (!board) {
    // Defensive: ensureMultiBoardShape guarantees boards is non-empty,
    // but a writer may target a board id that doesn't yet exist (e.g.
    // a future `add_board` flow that pushes BEFORE the write). Synthesise
    // an empty record rather than silent-dropping the write.
    board = { id, designation: id, board_type: id === 'main' ? 'main' : 'sub-distribution' };
    snapshot.boards.push(board);
  }
  board[field] = value;
}
```

**New flag-aware wrapper:**

```js
export function applyBoardReadingFlagAware(snapshot, args) {
  if (isMultiBoardFlagOn()) {
    applyBoardReadingMultiBoard(snapshot, args);
  } else {
    applyBoardReadingToSnapshot(snapshot, args);
  }
}
```

**Tests** in `src/__tests__/stage6-snapshot-mutators-multi-board.test.js`:
- writes to `snapshot.boards[0]` when boardId is `'main'`
- creates BoardInfo on first write if missing
- explicit boardId scopes the write
- under flag-off, `applyBoardReadingFlagAware` writes to `circuits[0]`
- legacy + composite coexistence — flag-off `circuits[0].ze` and
  flag-on `boards[0].ze` live independently in the same snapshot

#### 5.5.2 — Migrate `stage6-dispatchers-board.js` to the wrapper

`src/extraction/stage6-dispatchers-board.js:50` — change import.

`src/extraction/stage6-dispatchers-board.js:133` — the actual write site
in `dispatchRecordBoardReading`:

```js
// before:
applyBoardReadingToSnapshot(session.stateSnapshot, {
  field: input.field,
  value: input.value,
});

// after:
applyBoardReadingFlagAware(session.stateSnapshot, {
  field: input.field,
  value: input.value,
  boardId: input.board_id, // optional; may be undefined (Sonnet doesn't yet emit it — Phase 6)
});
```

The auto-resolve hook (`createAutoResolveWriteHook` in
`stage6-dispatchers.js`) builds the synthetic call. It does NOT need to
change — the synthetic call goes through `dispatchRecordBoardReading`
which now uses the flag-aware wrapper.

**Tests** — extend `stage6-multi-board-flag-routing.test.js`:
- end-to-end `record_board_reading` round-trip under flag-on:
  Sonnet emits → dispatcher → applyBoardReadingMultiBoard →
  `boards[0][field] === value`
- path-2 ask_user with `pending_write: {tool: 'record_board_reading'}` +
  user reply triggers auto-resolve → synthetic write lands at
  `boards[currentBoardId][field]` (NOT at `circuits[0]`) under flag-on
- flag-off path identical to current behaviour (regression)

#### 5.5.3 — Migrate the snapshot serialiser

This is the critical reader migration. The serialiser builds the snapshot
TEXT that's sent to Sonnet at every turn (cached via `cache_control: ephemeral 5m`).

`eicr-extraction-session.js:2240` — supply data read:

```js
// before:
const supplyData = this.stateSnapshot.circuits[0];

// after — flag-aware:
const currentBoard = isMultiBoardFlagOn()
  ? this.stateSnapshot.boards?.find(b => b.id === this.stateSnapshot.currentBoardId)
  : null;
const supplyData = isMultiBoardFlagOn()
  ? (currentBoard ? currentBoard : null)
  : this.stateSnapshot.circuits[0];
```

`eicr-extraction-session.js:2270` — non-supply circuit iteration:

```js
// before:
const allNonSupply = Object.keys(this.stateSnapshot.circuits)
  .map(Number)
  .filter((n) => n !== 0);

// after — flag-aware:
const allNonSupply = listCircuitRefsInBoard(this.stateSnapshot);
```

`eicr-extraction-session.js:2315` — per-ref bucket fetch in the per-circuit
emission loop:

```js
// before:
const fields = this.stateSnapshot.circuits[num];

// after — flag-aware:
const fields = getCircuitBucket(this.stateSnapshot, num);
```

`eicr-extraction-session.js:2550` — same pattern in another iteration.

**Watch out for:** the snapshot TEXT format Sonnet sees. Today the format
is approximately `0:{ze:0.42, pfc:1.5}\n1:{circuit_designation: ...}\n...`
where `0:` is the supply line. Under flag-on with the new shape, the
supply line should still emit a `0:` prefix (because that's what Sonnet's
prompt expects) but the source data comes from `boards[currentBoardId]`,
not `circuits[0]`. The line itself doesn't change shape — just where
the data comes from.

**Tests** — extend or add to `eicr-extraction-session.snapshot-refactor.test.js`:
- under flag-on, snapshot TEXT includes the supply line synthesised from
  `boards[0]` BoardInfo
- under flag-on, snapshot TEXT includes per-circuit lines synthesised
  from composite-key buckets, ordered correctly by `recentCircuitOrder`
- byte-equivalence under flag-off (the most important regression guard)

---

### Slice 5.5 deviations from the literal plan

The original PHASE5_HANDOFF.md slice 5.5 sketches a different file edit
pattern. Specifically:

> **Edit:** `src/extraction/stage6-dispatchers-board.js` (existing file —
> **do NOT create a sibling**, contrary to my self-review's S2 finding;
> this file already handles `record_board_reading`).

**That guidance is correct.** Edit the existing file; don't create a sibling.

> The whole file currently writes to `snapshot.circuits[0]`. Migrate to:
> ```js
> const board = snapshot.boards.find(b => b.id === (boardIdArg ?? snapshot.currentBoardId));
> board[field] = value;
> ```

**This guidance is also correct in spirit but the right place is the new
`applyBoardReadingMultiBoard` mutator (slice 5.5.1), not the dispatcher
itself.** The dispatcher should call the flag-aware wrapper, the wrapper
calls the mutator, and the mutator does the BoardInfo write. Same shape
as record_reading, just for board-level fields.

---

## Slice 5.6 — gated on a deploy cycle

**Do NOT ship slice 5.6 in the same session as 5.5.**

The original PHASE5_HANDOFF.md is explicit:

> 5.6 — Legacy `circuits[0]` removal. After 5.4 + 5.5 land and CI is
> green for ≥1 deploy cycle, delete the remaining `circuits[0]`
> references and the legacy mutator (`applyBoardReadingToSnapshot` at
> `stage6-snapshot-mutators.js:49-74`).

The deploy cycle is the production safety check — if the path-2 resolver
or any downstream reader regresses under flag-on, we want to catch it
in production traffic with the legacy bucket still available as a
fallback (via the dual-write pattern, if 5.5 ends up implementing one).

**5.6 actions** (when ready, in a separate session):
1. Delete `applyBoardReadingToSnapshot` (`stage6-snapshot-mutators.js:71-74`).
2. Delete the legacy `applyReadingToSnapshot`, `clearReadingInSnapshot`,
   `upsertCircuitMeta`, `renameCircuit`, `deleteCircuit` direct exports
   (only the `*FlagAware` wrappers stay) — but ONLY if external callers
   no longer use them. Check via `grep`. Verified callers as of slice 5.4:
   - `eicr-extraction-session.js:11` — uses `applyReadingFlagAware` and
     `clearReadingFlagAware` (slice 5.3 already migrated)
   - `ring-continuity-script.js:67` — uses `applyReadingFlagAware`
   - `insulation-resistance-script.js:55` — uses `applyReadingFlagAware`
   - All dispatchers — use `*FlagAware` wrappers
   So the legacy direct exports CAN be deleted in 5.6.
3. Delete the `*FlagAware` wrappers themselves; replace dispatcher calls
   with direct calls to the multi-board mutators.
4. Delete `isMultiBoardFlagOn` + `circuitExistsInSnapshot` flag-off
   branches (reduce to multi-board-only behaviour).
5. Delete `STAGE6_MULTI_BOARD` from any task-def env config (when it
   gets added in Phase 8.2).
6. Delete every `circuits[0]` reference identified in the original
   handoff's audit list.

---

## Pre-flight checks before starting slice 5.5

1. **Pull latest `main`.** Verify these commits are present:
   ```
   cd43a50 feat(stage6): flag-aware reader helpers + calc-tool migration (Phase 5.4)
   0876bed feat(stage6): flag-aware routing at every circuit-level write site (Phase 5.3)
   9fd646f feat(stage6): add composite-key multi-board mutator helpers (Phase 5.2)
   3215e6f feat(stage6): add ensureMultiBoardShape migration helper (Phase 5.1)
   ```
   **Local-only** at the time of writing — push to origin if a CI run is
   needed to confirm deploy-shaped infra agrees with the local 3033/3036
   green count.

2. **Run baseline `npm test`** to capture green/red state. Expected:
   ```
   Test Suites: 1 skipped, 118 passed, 118 of 119 total
   Tests:       3 skipped, 3033 passed, 3036 total
   ```
   Anything different is a regression to investigate before slice 5.5.

3. **Read `memory/handoff_2026-04-27_path2_review_fixes.md` end to end.**
   The path-2 invariants are the highest-risk thing slice 5.5 can break.

4. **Read `memory/architecture_2026-04-27_schema_driven_resolved_asks.md`
   for the path-2 architectural rationale (ADR-008).** Slice 5.5 must
   preserve the resolver's access patterns.

5. **Verify the production task def does NOT carry `STAGE6_MULTI_BOARD`
   yet.** Phase 8.2 plumbs it; Phase 8.4 flips it on. As of slice 5.4,
   the env var isn't in `ecs/task-def-backend.json` — slice 5.5 doesn't
   add it either; that's still Phase 8.

---

## Pitfalls / gotchas

1. **Don't break the path-2 invariant.** The auto-resolve hook
   dispatches synthetic `record_board_reading` calls. Today those land
   at `circuits[0]`. Under slice 5.5, they land at `boards[currentBoardId]`.
   The path-2 resolver itself doesn't change; the dispatcher behaviour
   shifts. Test the auto-resolve round-trip end-to-end under flag-on
   BEFORE relying on flag-off green tests as proof.

2. **Snapshot TEXT format must stay byte-identical under flag-off.**
   The snapshot text is the `cache_control: ephemeral 5m` payload sent
   to Sonnet. Any byte change invalidates the cache — every session
   would re-tokenise the prompt for one turn. Pin via the existing
   `eicr-extraction-session.snapshot-refactor.test.js`'s "byte-identical
   to pre-r2 behaviour" tests.

3. **Watch for circular imports.** `stage6-snapshot-mutators.js` imports
   from `stage6-multi-board-shape.js` (for `isMultiBoardFlagOn` /
   `DEFAULT_MAIN_BOARD_ID`). The new `applyBoardReadingMultiBoard`
   stays inside `stage6-snapshot-mutators.js` — don't move it to
   `stage6-multi-board-shape.js` even though that's tempting (it would
   create a `mutators → shape → ?` cycle if shape ever needs to call a
   mutator).

4. **`record_board_reading` accepts no `circuit` field today.** The
   `pending_write.field` cross-validation in `validateAskUser`
   (`stage6-dispatch-validation.js:431-466`) uses
   `RECORD_BOARD_READING_FIELDS` — the enum derived from
   `BOARD_FIELD_ENUM` (supply + board + installation fields). Slice 5.5
   doesn't add `board_id` to this contract; that's a Phase 6 concern
   (the explicit `board_ops` wire channel — Codex deal-breaker #3).
   Until Phase 6 ships, board-id defaulting is `currentBoardId ??
   'main'` and Sonnet has no way to write to a sub-board.

5. **The `boards` array can carry multiple entries** (from the iOS
   `.addNewBoard` mode that Phase 4 shipped, or from a future `add_board`
   tool). `applyBoardReadingMultiBoard` finds the right entry via
   `find(b => b.id === id)`. Don't assume `boards[0]` is the active board.

6. **DON'T DELETE `circuits[0]` IN SLICE 5.5.** That's slice 5.6 (gated
   on a deploy cycle). Slice 5.5 makes the migration possible by
   moving the WRITES to the new location and the READS to the new
   location, but the legacy bucket stays empty (or with stale data
   from pre-flag-on state) until 5.6.

---

## Test strategy for slice 5.5

After each commit (5.5.1 → 5.5.2 → 5.5.3), run:

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS=--experimental-vm-modules npx jest --silent 2>&1 | tail -6
```

Expected progression:
- 5.5.1: ~3038 passed (+5 mutator unit tests)
- 5.5.2: ~3043 passed (+5 dispatcher round-trip tests)
- 5.5.3: ~3050 passed (+7 snapshot serialiser tests)

If ANY existing test fails, stop and investigate — the path-2 resolver
suite (`stage6-answer-resolver.test.js`, `stage6-dispatcher-ask-pending-write.test.js`)
is where regressions will most likely surface.

---

## Phase 5 deliverables checklist (current status)

- [x] 5.1 — `ensureMultiBoardShape` module + tests + wire into session init (`3215e6f`)
- [x] 5.2 — Composite-key mutator helpers + tests (`9fd646f`)
- [x] 5.3 — Feature-flag branch on every circuit-level write dispatcher (`0876bed`)
- [x] 5.4 — Strangler reader migration (calc tools + set_field_for_all_circuits) (`cd43a50`)
- [ ] 5.5 — Strangler writer migration (record_board_reading + supplyData read + snapshot serialiser)
- [ ] 5.6 — Remove `circuits[0]` references + legacy mutators (only after `STAGE6_MULTI_BOARD` has been on through one deploy cycle)
- [x] PLAN.md delivery-log entries for slices 5.1 / 5.2 / 5.3 / 5.4
- [ ] PLAN.md delivery-log entry for slice 5.5
- [ ] CLAUDE.md changelog row when phase complete (one row per phase, not per slice)
- [ ] Memory entry update — set Phase 5 to DONE and re-point "next concrete step" to Phase 6.0 (the `board_ops` wire channel)

---

## When you're done with slice 5.5

1. Run the full suite — expect ~3050 passing.
2. Update `PLAN.md` delivery log with the slice 5.5 entry (chitchat-pause-2026-05-06 style).
3. **Stop.** Don't proceed to slice 5.6 in the same session — that needs a deploy cycle of soak time first.
4. Push to origin so CI can validate the flag-default-off path on prod-shaped infra.
5. Update memory entry `multi_board_plan_2026-05-07.md` to reflect slice 5.5 ship.
6. Write the slice 5.6 handoff (or extend this one) for the legacy-bucket-removal session.

The phase isn't DONE until slice 5.6 ships, but slice 5.5 is the last
piece of net-new code. Slice 5.6 is pure deletion + reduce-flag-aware-to-flat —
mechanical, low-risk, but gated on production confirmation that flag-on
flag-off doesn't break anything.

---

## Phase 6.0 preview (the next concrete step AFTER slice 5.6)

Phase 6.0 is the **`board_ops` wire channel** — Codex deal-breaker #3.
It must land BEFORE any new tools (`add_board`, `select_board`,
`mark_distribution_circuit`) so iOS can persist board mutations.

Specifically, `stage6-event-bundler.js` and `stage6-per-turn-writes.js`
need a new `board_ops` accumulator + bundling slot. iOS needs a decoder
case for the new wire shape. Without this channel, board-mutation
events would be silent-dropped.

But that's after Phase 5 ships. Don't conflate.
