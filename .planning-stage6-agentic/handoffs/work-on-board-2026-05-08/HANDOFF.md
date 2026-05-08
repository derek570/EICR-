# "Work on [Board]" — Fresh-Context Handoff

**Read this first** in a new session. Full plan in sibling `PLAN.md` (~370 lines).
Last updated 2026-05-08 (Phase A FULLY SHIPPED — all three slices). Status: **Phase A landed across three commits on `main`: `382985e` (dual-shape helpers + mutator wrappers + 32 test rewrites), `d1ad05b` (`_seedStateFromJobState` dual-shape routing), `cc303bc` (`buildStateSnapshotMessage` dual-shape + `STAGE6_MULTI_BOARD` env flag retired). Backend full suite green (3162 passing, 3 pre-existing skips). NOT YET PUSHED/DEPLOYED. Phase B (server strict `currentBoardId` scoping + system-prompt hint) is the next backend slice — single commit, then push to deploy the full Phase A + B as one unit. Phases C/D/E ship the iOS-facing UX (voice command, banner, WS broadcast).**

---

## What this is

After commit `27a1b94` (`fix(stage6): add_board accepts legacy keyed-snapshot circuits`, on `main`), the inspector can _create_ a sub-board mid-recording. They can't safely _use_ it yet — storage is flat-keyed (sub-board circuit 1 clobbers main's circuit 1), and there's no UX signal for "which board is dictation landing on right now."

This sprint closes that. Spoken focus becomes the single source of truth: while the inspector is "working on" a board, every reading lands there; off-boards get a red banner; switching is a voice command ("Work on \[designation\]").

## What you need to know cold

### Provoking incident — session EEB8F9EA (2026-05-08)

Inspector said "moving on to subboard, garage fed from circuit 11". Sonnet asked the right disambiguation, got "circuit 11", tried `add_board(parent_board_id:'main', feed_circuit_ref:11)` three times — all rejected `hierarchy_invalid`. After 3 failures Sonnet flailed into `create_circuit(11)` and got `circuit_already_exists`. 8-round tool loop cap → session aborted.

Today's commit (`27a1b94`) fixes the `add_board` rejection. This sprint fixes everything that breaks _after_ a sub-board exists.

### Storage shape post-`27a1b94`

`stateSnapshot.circuits` is a keyed object. Today, all circuits live at bare numeric keys (`circuits[1]`, `circuits[11]`, …) regardless of board. Pre-fix, the validator demanded `c.board_id === parent_board_id` per circuit, but the seeded buckets carried no `board_id`; the dispatcher now adapts the shape before validation, so legacy snapshots accept `add_board`.

What's still wrong: there's no per-board namespace. Sub-1's circuit 1 has no key it can live at without overwriting main's circuit 1. **Phase A widens the storage to dual-shape** — main keeps legacy bare keys, non-main boards get composite keys (`'sub-1::1'`).

### Why dual-shape, not full Phase 5 re-key

The 2026-05-07 multi-board sprint queued a full Phase 5 widening (composite keys for **everything**, retire `circuits[0]`). It's the architecturally clean answer but a 2-3 session sweep across 6+ files.

This plan takes the smaller path:
- **Main board → legacy bare keys** (every existing reader keeps working).
- **Non-main boards → composite keys**, buckets self-identify via `bucket.board_id`.
- Existing iterators that filter `Number.isInteger(n) && n >= 1` naturally skip composite keys → safe coexistence.

Tradeoff: dual-shape is a known foot-gun. Mitigated by funnelling every read through the `getCircuitBucket` / `circuitExistsInSnapshot` / `listCircuitRefsInBoard` helpers (already in `stage6-multi-board-shape.js`). Phase 5.6 of the older sprint can retire the legacy half later as a clean-up.

### `STAGE6_MULTI_BOARD` env flag is dying

Today's flag-on path uses composite keys for **everything**, but it can't ship — `_seedStateFromJobState` writes legacy keys, so flag-on existence checks become invisible to seeded circuits. The flag is therefore stuck off in production.

This plan replaces the flag with a per-call rule: **composite when `boardId` is non-main, legacy otherwise.** The flag becomes dead code; remove after one deploy cycle.

---

## Locked decisions (do NOT relitigate)

| Q | Decision | Why |
|---|---|---|
| **0.1** Default board on session start | **Always main.** | Predictable; avoids restoring a stale last-active that the inspector forgot. |
| **0.2** Banner placement | **Overview cards + CircuitsTab section headers.** | Both surfaces signal off-board. |
| **0.3** Fuzzy match for "Work on X" | **Substring contains, longest match wins.** Ambiguity → TTS clarification. | Conversational ("the garage") without auto-guessing. |
| **0.4** Cross-board readings | **No auto-route.** All writes scope to `currentBoardId`. If circuit ref is new, create it. | Inspector's framing: "if they want to give a reading for the other board they will have to switch over first." |

---

## Phase order

| # | Phase | Layer | Estimate |
|---|---|---|---|
| **A** | Dual-shape storage — main legacy, subs composite | Backend | 1 session |
| **B** | Server strict `currentBoardId` scoping + system prompt | Backend | 0.5 session |
| **C** | iOS voice command "Work on X" → `select_board` | iOS | 1 session |
| **D** | iOS red-banner UI on off-boards | iOS | 0.5 session |
| **E** | Backend → iOS WS broadcast `current_board_changed` | Backend + iOS | 0.5 session |

**Total: 3-4 sessions.** Ship in two increments:
- **A + B** is a backend-only deploy. Sub-boards become storage-safe; model can't accidentally cross-write.
- **C + D + E** is the inspector-facing UX gate. D + E ship together (D's banner needs E's reactivity).

---

## Out of scope

- **Tap-to-switch UI** — voice-first this sprint. Tap is a follow-up if Derek asks.
- **Phase 5.6 legacy bucket retirement** — defer; dual-shape is intentional.
- **Web frontend** — backend round-trip works for web (composite keys serialise fine), but voice + banner is iOS-only.
- **Auto-routing cross-board readings** — explicitly Q0.4-rejected.

---

## How to start a fresh session

1. `cat HANDOFF.md` (this file).
2. Skim `PLAN.md` Phase A only — implementation detail per file.
3. Verify base commit: `git log --oneline -5 | grep 27a1b94`.
4. Branch (or work on `main` for solo flow): start with `stage6-multi-board-shape.js` helpers; run the targeted test file after each edit.
5. Auto-commit per phase per the project rule (CLAUDE.md "auto-commit after each logical unit").
6. Verify Phase A "Acceptance" — replay EEB8F9EA scenario in a fixture session.

---

## Cross-references

- `../multi-board-support-2026-05-07/HANDOFF.md` — parent sprint that introduced multi-board iOS + Phase 5/6 backend.
- `../multi-board-support-2026-05-07/PHASE5_HANDOFF.md` — full re-key plan; not what this sprint takes, but the eventual destination.
- Commit `27a1b94` — today's `add_board` legacy-snapshot fix; this sprint builds on top. Deployed to prod via the `f159057` CI run.

---

## Session log — 2026-05-08 (Phase A exploration)

This section captures everything learned during the first Phase A attempt so a fresh session resumes from a known position rather than repeating the design work.

### What's on `main` (already deployed)

- `27a1b94` `fix(stage6): add_board accepts legacy keyed-snapshot circuits` — closes the EEB8F9EA `hierarchy_invalid` repro. Deployed via the `f159057` CI run (~13:28 UTC).
- `bfed5ed` `docs(stage6): plan + handoff for "Work on [Board]" single-board-focus sprint` — this directory.
- Phase A production-side edits were drafted then **reverted**. Working tree clean.

### Phase A production-side changes (drafted, reverted, ready to re-apply)

The change is mechanical: replace the `STAGE6_MULTI_BOARD` flag-on/off branch in helpers + mutator wrappers with a per-call "is target the main board?" check. The existing flag-on path (composite keys via `applyReadingMultiBoard`, `upsertCircuitMetaMultiBoard`, etc.) is already correct — just needs to fire when `boardId !== mainBoardId`, regardless of the flag.

**File 1 — `src/extraction/stage6-multi-board-shape.js`**

Add helper (after `DEFAULT_MAIN_BOARD_TYPE`):

```js
export function getMainBoardId(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.boards) || snapshot.boards.length === 0) {
    return DEFAULT_MAIN_BOARD_ID;
  }
  const main = snapshot.boards.find((b) => b && (!b.board_type || b.board_type === 'main'));
  return main?.id ?? snapshot.boards[0]?.id ?? DEFAULT_MAIN_BOARD_ID;
}
```

Replace each of the three flag-gated helpers' body with the dual-shape pattern:

```js
export function getCircuitBucket(snapshot, ref, boardId) {
  if (!snapshot || !snapshot.circuits) return undefined;
  const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
  const mainId = getMainBoardId(snapshot);
  if (id === mainId) {
    return snapshot.circuits[ref];
  }
  return snapshot.circuits[`${id}::${ref}`];
}

export function listCircuitRefsInBoard(snapshot, boardId) {
  if (!snapshot || !snapshot.circuits) return [];
  const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
  const mainId = getMainBoardId(snapshot);
  if (id === mainId) {
    return Object.keys(snapshot.circuits)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
  }
  const refs = [];
  for (const bucket of Object.values(snapshot.circuits)) {
    if (bucket && bucket.board_id === id && Number.isInteger(bucket.circuit) && bucket.circuit >= 1) {
      refs.push(bucket.circuit);
    }
  }
  return refs.sort((a, b) => a - b);
}

export function circuitExistsInSnapshot(snapshot, circuit, boardId) {
  if (!snapshot || !snapshot.circuits) return false;
  const id = boardId ?? snapshot.currentBoardId ?? DEFAULT_MAIN_BOARD_ID;
  const mainId = getMainBoardId(snapshot);
  if (id === mainId) {
    return circuit in snapshot.circuits;
  }
  return `${id}::${circuit}` in snapshot.circuits;
}
```

Keep `isMultiBoardFlagOn()` exported. The only remaining reader is `eicr-extraction-session.js:buildStateSnapshotMessage` (line ~2126), which slice A.4 will flip; once that's done, the export and env var can both be deleted.

**File 2 — `src/extraction/stage6-snapshot-mutators.js`**

Swap the import: `import { getMainBoardId } from './stage6-multi-board-shape.js';` (drop `isMultiBoardFlagOn`).

Replace the six `*FlagAware` wrappers with the per-call rule:

```js
function isMainBoardTarget(snapshot, args) {
  const target = args?.boardId ?? snapshot?.currentBoardId ?? getMainBoardId(snapshot);
  return target === getMainBoardId(snapshot);
}

export function applyReadingFlagAware(snapshot, args) {
  if (isMainBoardTarget(snapshot, args)) applyReadingToSnapshot(snapshot, args);
  else applyReadingMultiBoard(snapshot, args);
}

// …same shape for clearReadingFlagAware, upsertCircuitMetaFlagAware,
// renameCircuitFlagAware, deleteCircuitFlagAware, applyBoardReadingFlagAware
```

The wrapper names stay (`*FlagAware`) so every dispatcher import keeps compiling.

### Test failure inventory (after re-applying the above)

Running the full suite yielded **32 failures across 4 suites**. All follow the same pattern: a flag-on test pre-seeds a composite key for the main board (`circuits['main::3']`) and asserts composite-path routing. Under dual-shape, `currentBoardId='main'` always routes to legacy bare keys, so those buckets become invisible to the validator.

| Suite | Failing tests | Pattern |
|---|---|---|
| `stage6-multi-board-flag-routing.test.js` | 25 | Tests both helpers and dispatchers under flag-on. Most "flag-on" tests need re-targeting to `currentBoardId='sub-1'` with composite seeds at `'sub-1::N'`. |
| `stage6-tool-schemas-mark-distribution-circuit.test.js` | 1 | `flag-on: marks composite-key bucket on the resolved board` — same pattern. |
| `stage6-tool-schemas-board-id-calc-sweep.test.js` | 3 | `default (no board_id)` / `board_id="*"` / `single-board response shape` — composite-key calc-sweep tests. |
| `eicr-extraction-session.snapshot-refactor.test.js` | 3 | `buildStateSnapshotMessage` flag-on tests — these will only pass after slice A.4 (the `buildStateSnapshotMessage` migration). May have to mark `.skip` until then. |

### Test rewrite recipe

For each failing test in `stage6-multi-board-flag-routing.test.js`:

1. **Delete** the `process.env.STAGE6_MULTI_BOARD = 'true'` (and the `delete process.env...` afterEach).
2. **Switch** the session helper from `makeMultiBoardSession` (currentBoardId='main') to a new `makeSubBoardSession` helper:
   ```js
   function makeSubBoardSession(circuitSeeds = {}) {
     const snapshot = {
       circuits: { ...circuitSeeds },
       pending_readings: [],
       observations: [],
       validation_alerts: [],
       boards: [
         { id: 'main', designation: 'DB-1', board_type: 'main' },
         { id: 'sub-1', designation: 'DB-2', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: 4 },
       ],
       currentBoardId: 'sub-1',
     };
     return { sessionId: 's-sub', stateSnapshot: snapshot, extractedObservations: [] };
   }
   ```
3. **Rename** `'main::3'` references to `'sub-1::3'` in seeds and assertions.
4. **Rename** the describe block / test name from `flag-on: …` to `sub-board: …`.

The flag-off tests (testing main-board legacy behaviour) need only describe-block renames — their behaviour stays identical under dual-shape because main always routes legacy.

### What still needs to happen after the test rewrites

Slice A.3 (touched only briefly in this session):
- `eicr-extraction-session.js:_seedStateFromJobState` (line ~1077) — when seeding from a multi-board iOS PUT, route circuits with `board_id !== mainBoardId` to composite keys instead of flat keys. Today everything writes to `circuits[num]` regardless of the circuit's `board_id`.

Slice A.4:
- `eicr-extraction-session.js:buildStateSnapshotMessage` (line ~2118) — replace `isMultiBoardFlagOn()` branch with dual-shape: main board renders supply line from `circuits[0]`, sub-boards render supply from their BoardInfo. Fixes the 3 snapshot-refactor test failures. After this lands, `isMultiBoardFlagOn` and the `STAGE6_MULTI_BOARD` env var are dead — delete both.

### Acceptance gate (Phase A)

Replay the EEB8F9EA scenario in a fixture: legacy main with `circuits[1..13]`, `add_board(sub_main, parent='main', feed=11)`, then 3 readings on sub-1 circuit 1 (which doesn't conflict with main's circuit 1). Verify:
- `snapshot.circuits[1..13]` byte-identical to before add_board.
- `snapshot.circuits['sub-1::1']` carries the new readings.
- `boardOps` event channel emits `add_board` then 3 reading events with `board_id: 'sub-1'`.

### How a fresh session should pick up

Phase A is fully landed across three commits on `main` (2026-05-08). The
session log above is preserved as a record of the original design work.

**Phase A commits:**
1. `382985e` — dual-shape helpers (`getMainBoardId`) + mutator wrappers +
   32 test rewrites across 4 suites.
2. `d1ad05b` — `_seedStateFromJobState` board hydration + per-circuit
   dual-shape routing + 4 new regression tests.
3. `cc303bc` — `buildStateSnapshotMessage` dual-shape supply/iteration +
   `STAGE6_MULTI_BOARD` env flag and `isMultiBoardFlagOn()` helper
   deleted entirely.

**Acceptance gate (Phase A) — met:**
- Full backend suite green (3162 passing, 3 pre-existing skips).
- EEB8F9EA "moving on to sub-board, garage fed from circuit 11" repro
  now works end-to-end: composite-key writes ship for every non-main
  board; main-board behaviour byte-identical to legacy.
- `STAGE6_MULTI_BOARD` env var is dead. No production reader. The only
  remaining grep hits are historical comments.

**Next steps:**

1. **Phase B — server strict `currentBoardId` scoping + system prompt.**
   Backend-only. Tighten the agentic-prompt + dispatcher contract so
   that:
   - Every circuit-mutator tool call MUST resolve to `currentBoardId`
     (or include an explicit `board_id`). Cross-board readings without
     an explicit board_id get rejected with a structured error rather
     than silently writing to the wrong board.
   - The system prompt explains the scope to Sonnet: "All readings
     land on the active board; if the inspector mentions a different
     board, call `select_board` first." (Q0.4 locked: NO auto-routing
     of cross-board readings.)
   Estimate: 0.5 session.
2. **Phase C — iOS voice command "Work on \[X\]" → `select_board` tool.**
   iOS-only. New voice intent parsed by `TranscriptFieldMatcher`:
   substring match on `boards[].designation`, longest match wins,
   ambiguity → TTS clarification. Sends `select_board` over WS.
   Estimate: 1 session.
3. **Phase D + E — iOS red-banner UI + backend WS broadcast.** Ships
   together because the banner needs the WS reactivity. Estimate: 0.5
   session each.

Phase A + Phase B can ship as a single backend deploy if you want to
gate the iOS-facing work behind a complete server-side foundation.
