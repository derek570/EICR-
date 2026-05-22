# Phase 6 + Phase 7 — Autonomous Overnight Handoff

**Status as of write-time (2026-05-07 ~22:30):** Derek is going to bed. Phase
6.0 (`board_ops` wire channel) shipped backend + iOS earlier this evening.
TestFlight build 349 is uploading. This document is the brief for an
autonomous agent to push Phase 6 + Phase 7 as far as is safely possible
overnight, with explicit stop-gates at every place a judgment call would
otherwise be needed.

**THE ONLY HARD RULES** — violate these and Derek wakes to a broken prod:

1. **NEVER `git push origin main`** on either repo. Local commits only. Derek pushes after morning review.
2. **NEVER run `./deploy.sh` or `./deploy-testflight.sh`.** Both repos.
3. **NEVER `git rebase`, `git reset --hard`, `git push --force`, `git checkout --`.** If you get into a state you don't understand, leave it alone and write a `BLOCKED.md` next to this file describing exactly where you stopped.
4. **NEVER touch the `src/routes/extraction.js` file** unless this doc explicitly tells you to. Derek and a parallel session are actively iterating on the CCU pipeline; conflicts there are noisy.
5. **NEVER edit `Sources/Info.plist`.** Build numbers are bumped by the deploy script. Hands off.
6. **If `npm test` ever drops the green count below 3058**, stop. Do not commit. Write `BLOCKED.md`.
7. **If `xcodebuild ... build` ever fails**, stop. Do not commit. Write `BLOCKED.md`.

If you hit a stop-gate and there's no clean recovery, your job is to leave
clean state for Derek's morning review, not to plough on. A half-finished
slice on a clean branch is fine; a half-finished slice with a broken
working tree is not.

---

## Cold-start orientation (~5 min)

You are picking up the multi-board sprint from Phase 6.0 SHIPPED. The
sprint plan is at `PLAN.md` (sibling); Phase 0 decisions are locked in
`HANDOFF.md` (sibling) and re-summarised below for fresh context.

### Where we are

| Phase | Status | Commits |
|---|---|---|
| 1 — drop sub_main_cable_length (iOS) | SHIPPED | `723b3f3` (iOS) |
| 2 — backend schema parity + hierarchy validator | SHIPPED | `1059f39` `ebb6183` `ef56e25` `c21820b` |
| 2a — CSV header hardening | SHIPPED | `ddde287` |
| 3 — PDF sub-main section (iOS) | SHIPPED | `df4311c` (iOS) |
| 4 — `/api/analyze-ccu` board attribution + iOS `.addNewBoard` | SHIPPED | `a40a9f3` (BE) + `f9902cd` (iOS) |
| 4a — recording.js single-board scope | SHIPPED | `7e588c8` |
| 5.1–5.5 — Stage 6 state-model widening | SHIPPED | `3215e6f` `9fd646f` `0876bed` `cd43a50` `afd928f` `4df60ee` `68d7b6e` |
| 5.6 — legacy `circuits[0]` removal | **HELD** — gated on `STAGE6_MULTI_BOARD=true` production soak |
| **6.0 — `board_ops` wire channel** | **SHIPPED** | `2706123` (BE) + `3734b67` (iOS) |
| **6 — new tools + extending existing** | **YOU ARE HERE** |
| 7 — system prompt + ask-user resolver | next |
| 8 — tests, telemetry, rollout | last |

### Locked decisions (do NOT relitigate)

| Q | Decision |
|---|---|
| 0.1 | Composite-key `circuits['${board_id}::${ref}']` + sibling `boards[]` array |
| 0.2 | `board_id` **required when `boards.length > 1`**, optional when single-board |
| 0.3 | Legacy snapshots get synthetic `boards=[{id:'main', designation:'DB-1', board_type:'main'}]` |
| Q4 | iOS already has `.addNewBoard` mode; Phase 4 shipped this |
| Q5 | Inspector switches between boards via `select_board`. Each board's circuits start from 1 |
| Q6 | Forward references in `mark_distribution_circuit` → `ask_user` to add the missing board. Server resolver chains. |
| Q7 | Each sub-board gets its own page in PDF schedule (Phase 3 shipped this) |

### Repo geography

- **Backend** — `/Users/derekbeckley/Developer/EICR_Automation` (origin/main = `4a31a27`).
- **iOS** — `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` (separate git repo nested inside backend; iOS HEAD = `3734b67`, NOT pushed).
- The iOS repo has 16 unpushed commits stacked beneath HEAD that go to TestFlight via `deploy-testflight.sh`. **Do not push iOS to origin.**

### Key files for Phase 6/7

| File | Role |
|---|---|
| `src/extraction/stage6-tool-schemas.js` | Tool-schema array; new tools added to TOOL_SCHEMAS at L795+ |
| `src/extraction/stage6-dispatchers-board.js` | Existing file (`dispatchRecordBoardReading`); EXTEND, don't sibling |
| `src/extraction/stage6-dispatchers.js` | Barrel that wires tool name → dispatcher fn (the `createWriteDispatcher` factory) |
| `src/extraction/stage6-dispatch-validation.js` | Validators that run before dispatchers |
| `src/extraction/stage6-multi-board-shape.js` | Phase 5.1+ helpers: `ensureMultiBoardShape`, `getCircuitBucket`, etc. |
| `src/extraction/stage6-snapshot-mutators.js` | Phase 5.2+ mutators: `applyReadingMultiBoard`, `applyBoardReadingMultiBoard`, etc. |
| `src/extraction/stage6-per-turn-writes.js` | Phase 6.0 added `boardOps: []` slot |
| `src/extraction/stage6-event-bundler.js` | Phase 6.0 added `board_ops` wire emit |
| `src/extraction/board-hierarchy-validator.js` | `validateBoardHierarchy(boards, circuits)` — use for Phase 6.1 cycle check |
| `src/extraction/stage6-answer-resolver.js` | **PATH-2 territory — DANGER**. Read `memory/handoff_2026-04-27_path2_review_fixes.md` before touching. |
| `config/prompts/sonnet_agentic_system.md` | System prompt; CIRCUIT ROUTING at L49, add MULTI-BOARD ROUTING after it |
| `Sources/Services/ClaudeService.swift` | Phase 6.0 added `BoardOp` Codable + `RollingExtractionResult.boardOps` |

### Test pre-flight

Before starting any slice, run:

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS=--experimental-vm-modules npx jest --silent 2>&1 | tail -3
```

Expected: `Tests: 3 skipped, 3058 passed, 3061 total`. If anything else, **stop**: write `BLOCKED.md` describing the unexpected baseline, do not start the slice.

---

## Slice plan

Each slice = one self-contained commit (or two for split concerns).
Run the test pre-flight, edit, run the relevant suite, run the full
suite, commit. Move to the next slice only if the full suite is green.

| Slice | Scope | Risk | Auto-OK? |
|---|---|---|---|
| **6.1** | `add_board` tool schema + dispatcher (no fuzzy match, no ask_user) | Med | YES |
| **6.2** | `select_board` tool schema + dispatcher (id-only match, NO designation fuzzy match) | Low | YES |
| **6.3** | `mark_distribution_circuit` tool schema + dispatcher (NO forward-ref ask_user) | Med | YES |
| **6.4** | Extend `record_reading` / `clear_reading` / `create_circuit` / `rename_circuit` / `delete_circuit` with optional `board_id` | Low | YES |
| **6.5** | Extend `calculate_zs` / `calculate_r1_plus_r2` / `set_field_for_all_circuits` with optional `board_id` | Low | YES |
| **6.6** | Wire 3 new dispatchers into `stage6-dispatchers.js` barrel + add `BOARD_OP_*` enums | Low | YES |
| **6.7** | iOS — unit-test JSON decoders for new ops (already in place from 6.0 — extend only if needed) | Low | YES |
| **7.1** | System prompt MULTI-BOARD ROUTING block (verbatim from PLAN.md L626-649) | Med | YES |
| **STOP** | Phase 7.2 (resolver multi-board awareness) — DO NOT ATTEMPT autonomously | High | **NO** |
| **STOP** | `mark_distribution_circuit` forward-ref `ask_user` flow — DO NOT ATTEMPT | High | **NO** |
| **STOP** | `select_board` designation fuzzy match — DO NOT ATTEMPT (would need designation indexing across boards, judgment call on case-sensitivity, Levenshtein floor, ambiguity-vs-pick rule) | Med | **NO** |
| **STOP** | iOS UI handlers that consume `boardOps` and mutate JobViewModel — DO NOT ATTEMPT (product decisions: where in UI does selection feedback show? Animate? Toast?) | Med | **NO** |

**Goal-state for the morning:** slices 6.1 → 7.1 are 7 local commits on
backend `main`, full suite green, iOS unchanged unless 6.7 finds a real
gap. Derek reviews, decides what to push, and tackles the STOPped slices
in a normal session.

---

## Slice 6.1 — `add_board` tool schema + dispatcher

### Scope

- New tool schema appended to `TOOL_SCHEMAS` in `src/extraction/stage6-tool-schemas.js`.
- New dispatcher `dispatchAddBoard` exported from `src/extraction/stage6-dispatchers-board.js` (extending the existing file, NOT a sibling).
- Wire-in: add to the barrel in `src/extraction/stage6-dispatchers.js` (the `createWriteDispatcher` factory).
- New validator in `src/extraction/stage6-dispatch-validation.js` for the schema's hierarchy invariants (don't duplicate `validateBoardHierarchy` — call it).
- Tests in a new file `src/__tests__/stage6-tool-schemas-add-board.test.js` mirroring the structure of `stage6-tool-schemas-board.test.js` (which covers `record_board_reading`).

### Schema (verbatim — paste in)

```js
const addBoard = makeTool({
  name: 'add_board',
  description:
    'Add a new consumer unit / distribution board to the job. Use when the inspector mentions a NEW consumer unit, sub-distribution board, or sub-main. The new board becomes the current board for subsequent reads/writes. Do NOT call for the main board — the session always starts with one main board already.',
  properties: {
    designation: {
      type: 'string',
      description: 'Inspector-facing designation (e.g. "DB-2", "Garage CU"). 1-32 chars.',
    },
    board_type: {
      type: 'string',
      enum: ['main', 'sub_distribution', 'sub_main'],
      description:
        'Board type. Use "sub_main" for boards fed by a single distribution circuit (typical sub-main); "sub_distribution" for multi-feed; "main" only for the primary CU on the job (rarely correct from this tool — main is implicit).',
    },
    parent_board_id: {
      type: 'string',
      description:
        'ID of the parent board this is fed from. REQUIRED for sub_main; optional for sub_distribution; ignored for main.',
    },
    feed_circuit_ref: {
      type: 'integer',
      description:
        'Circuit ref on the parent board that feeds this one (e.g. 4). Required when parent_board_id is set.',
    },
  },
  required: ['designation', 'board_type'],
});
```

Then **append `addBoard` to the `TOOL_SCHEMAS` array** at the end (before the closing `]`). The registry `getToolByName` derives from this array, so order matters only for the index pin in `stage6-tool-schemas-board.test.js:74` — extend that test to expect the new tool at the new index.

### Dispatcher (extend the existing file)

In `src/extraction/stage6-dispatchers-board.js`, after `dispatchRecordBoardReading`:

```js
import { validateBoardHierarchy } from './board-hierarchy-validator.js';

const VALID_BOARD_TYPES = new Set(['main', 'sub_distribution', 'sub_main']);

export async function dispatchAddBoard(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  // 1. Validate board_type enum.
  if (!VALID_BOARD_TYPES.has(input.board_type)) {
    const err = { code: 'invalid_board_type', field: 'board_type' };
    logToolCall(logger, {
      sessionId: session.sessionId, turnId,
      tool_use_id: call.tool_call_id, tool: 'add_board', round,
      is_error: true, outcome: 'rejected', validation_error: err,
      input_summary: { board_type: input.board_type ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 2. Validate designation: non-empty string, ≤ 32 chars.
  if (typeof input.designation !== 'string' || input.designation.trim() === '' || input.designation.length > 32) {
    const err = { code: 'invalid_designation', field: 'designation' };
    logToolCall(logger, { /* ...same shape... */ });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 3. parent_board_id required for sub_main.
  if (input.board_type === 'sub_main' && !input.parent_board_id) {
    return envelope(call.tool_call_id, {
      ok: false,
      error: { code: 'parent_required', field: 'parent_board_id' },
    }, true);
  }

  // 4. parent_board_id, if provided, must reference an existing board.
  const snapshot = session.stateSnapshot;
  ensureMultiBoardShape(snapshot);
  if (input.parent_board_id) {
    const parent = (snapshot.boards ?? []).find((b) => b.id === input.parent_board_id);
    if (!parent) {
      return envelope(call.tool_call_id, {
        ok: false,
        error: { code: 'parent_not_found', field: 'parent_board_id' },
      }, true);
    }
  }

  // 5. feed_circuit_ref required when parent_board_id is set.
  if (input.parent_board_id && (input.feed_circuit_ref == null || !Number.isInteger(input.feed_circuit_ref))) {
    return envelope(call.tool_call_id, {
      ok: false,
      error: { code: 'feed_circuit_ref_required', field: 'feed_circuit_ref' },
    }, true);
  }

  // 6. Synthesise the new board id. Stable across the session: `sub-${n}`
  //    where n = max existing sub-N + 1 (or 1 if none).
  const existingIds = (snapshot.boards ?? []).map((b) => b.id);
  let nextN = 1;
  for (const id of existingIds) {
    const m = /^sub-(\d+)$/.exec(id);
    if (m) nextN = Math.max(nextN, Number(m[1]) + 1);
  }
  const newId = input.board_type === 'main' ? `main-${nextN}` : `sub-${nextN}`;
  // Defensive: id collision (shouldn't happen, but if a board called
  // `sub-${nextN}` somehow exists, bail rather than overwrite).
  if (existingIds.includes(newId)) {
    return envelope(call.tool_call_id, {
      ok: false,
      error: { code: 'board_id_collision', field: null },
    }, true);
  }

  // 7. Build the new board record. Skeleton + payload.
  const newBoard = {
    id: newId,
    designation: input.designation.trim(),
    board_type: input.board_type,
  };
  if (input.parent_board_id) newBoard.parent_board_id = input.parent_board_id;
  if (input.feed_circuit_ref != null) newBoard.feed_circuit_ref = input.feed_circuit_ref;

  // 8. Hierarchy validation BEFORE mutating snapshot.
  const provisionalBoards = [...(snapshot.boards ?? []), newBoard];
  const provisionalCircuits = Object.values(snapshot.circuits ?? {});
  const { ok, errors } = validateBoardHierarchy(provisionalBoards, provisionalCircuits);
  if (!ok) {
    return envelope(call.tool_call_id, {
      ok: false,
      error: { code: 'hierarchy_invalid', field: null, details: errors },
    }, true);
  }

  // 9. Mutate snapshot: append board, flip currentBoardId.
  snapshot.boards.push(newBoard);
  snapshot.currentBoardId = newId;

  // 10. Push the wire op for iOS (Phase 6.0 channel).
  perTurnWrites.boardOps.push({
    op: 'add_board',
    board_id: newId,
    designation: newBoard.designation,
    board_type: newBoard.board_type,
    parent_board_id: newBoard.parent_board_id ?? null,
    feed_circuit_ref: newBoard.feed_circuit_ref ?? null,
  });

  // 11. Log success.
  logToolCall(logger, {
    sessionId: session.sessionId, turnId,
    tool_use_id: call.tool_call_id, tool: 'add_board', round,
    is_error: false, outcome: 'ok', validation_error: null,
    input_summary: {
      designation: newBoard.designation,
      board_type: newBoard.board_type,
      parent_board_id: newBoard.parent_board_id ?? null,
    },
  });
  return envelope(call.tool_call_id, { ok: true, board_id: newId, currentBoardId: newId }, false);
}
```

You'll need to import `ensureMultiBoardShape` from `./stage6-multi-board-shape.js`.

### Tests (new file)

```js
// src/__tests__/stage6-tool-schemas-add-board.test.js
import { jest } from '@jest/globals';
import { TOOL_SCHEMAS, getToolByName } from '../extraction/stage6-tool-schemas.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() { return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; }

function makeSession() {
  const snapshot = { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] };
  ensureMultiBoardShape(snapshot);
  return { sessionId: 's-test', stateSnapshot: snapshot, extractedObservations: [] };
}
```

Tests to write (one each):

1. **Schema shape** — `getToolByName('add_board')` returns the tool; required fields are exactly `['designation', 'board_type']`; `board_type` enum is exactly `['main', 'sub_distribution', 'sub_main']`.
2. **Happy path: add sub_distribution** — dispatch with valid input; board appended to `snapshot.boards`; `currentBoardId` flips; `boardOps` accumulator gains one entry with `op: 'add_board'`; envelope returns `{ ok: true, board_id, currentBoardId }`.
3. **Happy path: add sub_main with parent + feed_circuit_ref** — same as above but parent_board_id + feed_circuit_ref must round-trip into the snapshot board record AND the boardOps entry.
4. **Reject: invalid board_type** — `'invalid'` → `{ ok: false, error: { code: 'invalid_board_type' } }`; snapshot unchanged; `boardOps` empty.
5. **Reject: empty designation** — `''` and `'   '` and 33-char string → `invalid_designation`.
6. **Reject: sub_main without parent_board_id** — `parent_required`.
7. **Reject: parent_board_id pointing at non-existent board** — `parent_not_found`.
8. **Reject: parent set, feed_circuit_ref missing or non-integer** — `feed_circuit_ref_required`.
9. **Reject: cycle** — set up `boards=[main, sub-1{parent:main}, sub-2{parent:sub-1}]` then try to add `sub-3{parent:sub-2}` BUT also try to add a board with `parent_board_id: sub-3` after creation in a way that creates a cycle. (Actually `validateBoardHierarchy` covers cycle detection; just verify the call is wired correctly: e.g. a board with `parent_board_id: <id-not-yet-existing>` triggers `hierarchy_invalid`.)
10. **boardOps ordering** — multiple `add_board` calls in one turn produce multiple entries in insertion order.

After writing tests, run:

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS=--experimental-vm-modules npx jest --silent stage6-tool-schemas-add-board 2>&1 | tail -3
```

Expect all 10 passing. Then:

```bash
PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS=--experimental-vm-modules npx jest --silent 2>&1 | tail -3
```

Expect 3068+ passing (was 3058, +10 from this slice). If less than 3068 OR any test fails OR full-suite count drops, **stop**.

### Wire-in to the barrel

In `src/extraction/stage6-dispatchers.js` (the `createWriteDispatcher` factory), add a case for `'add_board'`:

```js
case 'add_board':
  return dispatchAddBoard(call, ctx);
```

You'll need to import `dispatchAddBoard` at the top of the file.

### Commit

```
feat(stage6): add add_board tool + dispatcher (Phase 6.1)

WHAT: New `add_board` tool in TOOL_SCHEMAS; new `dispatchAddBoard` in
stage6-dispatchers-board.js (extending the existing file rather than
creating a sibling, per PLAN.md S2). Wired into the barrel; emits
`{op: 'add_board', ...}` onto the boardOps wire channel landed in 6.0.

WHY: Phase 6.1 of the multi-board sprint. The wire channel went live
in 6.0; this commit is the first dispatcher to push onto it. Inspector
flow: "There's another consumer unit in the garage" → Sonnet calls
`add_board(designation: 'Garage CU', board_type: 'sub_distribution')`,
backend synthesises a stable id, mutates the snapshot, emits the op
to iOS. iOS receiver lands in a follow-up slice.

WHY id synthesis on the server: the model can't reliably invent stable
non-colliding ids across sessions; the server already knows the full
boards[] state and can pick `sub-${n}` deterministically. The model
only needs to provide a designation.

WHY validate hierarchy via the existing validateBoardHierarchy helper
(Phase 2.3 module): single source of truth for cycle/orphan/duplicate-
main rules. Dispatcher passes provisional boards[] (current + new)
into the validator BEFORE mutating snapshot, so a rejected call leaves
the snapshot untouched.

TESTS: 10 new unit tests in stage6-tool-schemas-add-board.test.js
covering schema shape, happy paths (sub_distribution + sub_main),
every rejection code, and boardOps ordering. Full backend suite
3068/3071 green (was 3058 baseline + 10).

Phase 6.2 (select_board) and 6.3 (mark_distribution_circuit) follow
in separate commits. select_board fuzzy designation match and
mark_distribution_circuit forward-reference ask_user are deferred
to a supervised session (path-2 resolver entanglement risk).
```

---

## Slice 6.2 — `select_board` tool + dispatcher (id-only)

### Scope

- New tool schema (id-only — NO designation fuzzy match; designation match is a STOP slice).
- Dispatcher: validate `board_id` exists in `snapshot.boards`; flip `currentBoardId`; emit `boardOps` entry.
- Tests.

### Schema (verbatim)

```js
const selectBoard = makeTool({
  name: 'select_board',
  description:
    'Set the current board for subsequent circuit operations. Use when the inspector indicates they have moved to a different consumer unit. Pass the EXACT board_id (e.g. "main", "sub-1", "sub-2"). The server returns the resolved id; if the model passes a designation by mistake, the call is rejected and the model should retry with the id.',
  properties: {
    board_id: {
      type: 'string',
      description: 'Exact board id (e.g. "main", "sub-1"). Designations like "DB-2" or "Garage CU" are NOT accepted by this version — pass the id from the most recent add_board response or the snapshot.',
    },
  },
  required: ['board_id'],
});
```

> NOTE: this is a deliberate scoping decision. The PLAN.md description
> says "Dispatcher accepts either an id or a designation (case-insensitive
> match)", but designation fuzzy match is a STOP slice — Levenshtein floor,
> ambiguity rule, case sensitivity all need product input. Ship id-only;
> Derek can add fuzzy match in a supervised session.

### Dispatcher

```js
export async function dispatchSelectBoard(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  if (typeof input.board_id !== 'string' || input.board_id.trim() === '') {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'invalid_board_id', field: 'board_id' },
    }, true);
  }

  const snapshot = session.stateSnapshot;
  ensureMultiBoardShape(snapshot);
  const target = (snapshot.boards ?? []).find((b) => b.id === input.board_id);
  if (!target) {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'board_not_found', field: 'board_id' },
    }, true);
  }

  snapshot.currentBoardId = target.id;
  perTurnWrites.boardOps.push({ op: 'select_board', board_id: target.id });

  logToolCall(logger, {
    sessionId: session.sessionId, turnId,
    tool_use_id: call.tool_call_id, tool: 'select_board', round,
    is_error: false, outcome: 'ok', validation_error: null,
    input_summary: { board_id: target.id },
  });
  return envelope(call.tool_call_id, { ok: true, currentBoardId: target.id }, false);
}
```

### Tests (5 minimum)

1. Schema shape; required = `['board_id']`.
2. Happy path: `select_board('sub-1')` flips `currentBoardId`; `boardOps` gains `{op: 'select_board', board_id: 'sub-1'}`; envelope `{ok: true, currentBoardId: 'sub-1'}`.
3. Reject `board_not_found` for unknown id.
4. Reject `invalid_board_id` for empty / whitespace / non-string.
5. Idempotency: `select_board('main')` when already on main flips nothing semantically but still emits one `boardOps` entry (wire shape is "the model called the tool"; suppression isn't this layer's job).

### Wire-in + commit

Add `case 'select_board'` to the barrel; commit with the message body adapted from 6.1.

---

## Slice 6.3 — `mark_distribution_circuit` (no forward-ref ask_user)

### Scope

- Schema for `mark_distribution_circuit(circuit, board_id?, feeds_board_id)`.
- Dispatcher: locate circuit on `(board_id ?? currentBoardId)`; verify `feeds_board_id` exists; write `is_distribution_circuit: 'yes'` + `feeds_board_id` to the bucket; emit `boardOps`.
- **STOP-SLICE branch** — if `feeds_board_id` does NOT resolve, REJECT with `feeds_board_not_found`. Do NOT trigger the ask_user resolver flow described in PLAN.md. That's a supervised slice (path-2 territory).
- Tests.

### Schema (verbatim)

```js
const markDistributionCircuit = makeTool({
  name: 'mark_distribution_circuit',
  description:
    'Flag an existing circuit as a distribution circuit feeding another board (sub-main). Use when the inspector says a circuit feeds a sub-board, e.g. "Circuit 4 feeds the kitchen sub-board". The fed-from board MUST already exist (call add_board first if it does not).',
  properties: {
    circuit: {
      type: 'integer',
      description: 'Circuit ref on the (board_id ?? currentBoardId).',
    },
    board_id: {
      type: 'string',
      description: 'Board the circuit lives on. Defaults to currentBoardId when omitted.',
    },
    feeds_board_id: {
      type: 'string',
      description: 'ID of the board this circuit feeds. MUST already exist on the job — call add_board first if it does not.',
    },
  },
  required: ['circuit', 'feeds_board_id'],
});
```

### Dispatcher

```js
export async function dispatchMarkDistributionCircuit(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  // 1. circuit must be a positive integer.
  if (!Number.isInteger(input.circuit) || input.circuit < 1) {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'invalid_circuit', field: 'circuit' },
    }, true);
  }

  // 2. feeds_board_id required + non-empty string.
  if (typeof input.feeds_board_id !== 'string' || input.feeds_board_id.trim() === '') {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'invalid_feeds_board_id', field: 'feeds_board_id' },
    }, true);
  }

  const snapshot = session.stateSnapshot;
  ensureMultiBoardShape(snapshot);

  // 3. Resolve the source board (board_id ?? currentBoardId).
  const sourceBoardId = input.board_id ?? snapshot.currentBoardId ?? 'main';
  const sourceBoard = (snapshot.boards ?? []).find((b) => b.id === sourceBoardId);
  if (!sourceBoard) {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'source_board_not_found', field: 'board_id' },
    }, true);
  }

  // 4. Resolve the target board. NO forward-ref ask_user — this slice
  //    intentionally rejects unknown targets so the dispatcher can ship
  //    without entangling the path-2 resolver.
  const targetBoard = (snapshot.boards ?? []).find((b) => b.id === input.feeds_board_id);
  if (!targetBoard) {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'feeds_board_not_found', field: 'feeds_board_id' },
    }, true);
  }

  // 5. Locate the circuit bucket on the source board (composite key under flag-on,
  //    legacy numeric key under flag-off). Use getCircuitBucket so flag-state is centralised.
  const bucket = getCircuitBucket(snapshot, input.circuit, sourceBoardId);
  if (!bucket) {
    return envelope(call.tool_call_id, {
      ok: false, error: { code: 'circuit_not_found', field: 'circuit' },
    }, true);
  }

  // 6. Mutate the bucket: mark as distribution circuit + record fed board.
  bucket.is_distribution_circuit = 'yes';
  bucket.feeds_board_id = targetBoard.id;

  // 7. Emit wire op.
  perTurnWrites.boardOps.push({
    op: 'mark_distribution_circuit',
    circuit_ref: input.circuit,
    feeds_board_id: targetBoard.id,
    // Include the source board id explicitly so iOS doesn't have to assume
    // currentBoardId at wire-receive time.
    source_board_id: sourceBoardId,
  });

  logToolCall(logger, {
    sessionId: session.sessionId, turnId,
    tool_use_id: call.tool_call_id, tool: 'mark_distribution_circuit', round,
    is_error: false, outcome: 'ok', validation_error: null,
    input_summary: { circuit: input.circuit, source_board_id: sourceBoardId, feeds_board_id: targetBoard.id },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}
```

You'll need to import `getCircuitBucket` from `./stage6-multi-board-shape.js`.

### Tests (8 minimum)

1. Schema shape; required = `['circuit', 'feeds_board_id']`.
2. Happy path under flag-off (legacy bucket): seed `circuits[3]={designation:'Cooker'}`, `boards=[main, sub-1]`, `currentBoardId='main'`. Call with `{circuit: 3, feeds_board_id: 'sub-1'}`. Verify `circuits[3].is_distribution_circuit === 'yes'`, `feeds_board_id === 'sub-1'`. boardOps entry with all 4 fields.
3. Happy path under flag-on (composite bucket): same as above with composite-key seed.
4. Reject `invalid_circuit` for circuit < 1 or non-integer.
5. Reject `invalid_feeds_board_id` for empty/non-string.
6. Reject `source_board_not_found` for explicit `board_id` pointing at unknown board.
7. Reject `feeds_board_not_found` for unknown `feeds_board_id` (the explicit STOP-SLICE deviation from PLAN.md — no forward-ref ask_user).
8. Reject `circuit_not_found` when the circuit bucket is absent on the source board.

### Wire-in + commit

Same pattern as 6.1.

**Important commit-message addition**: explicitly call out the deviation from PLAN.md (no forward-ref ask_user) so Derek's morning review knows what's deferred:

> NOTE: PLAN.md L577-583 specifies an `ask_user` flow when `feeds_board_id`
> does not yet exist. This slice REJECTS instead with
> `feeds_board_not_found`. The ask_user flow is path-2 resolver
> territory and was deferred to a supervised session — see
> PHASE6_PHASE7_AUTONOMOUS.md for rationale.

---

## Slice 6.4 — Extend mutating tools with optional `board_id`

### Scope

For each of these tools, add an optional `board_id` property to the
`input_schema.properties` block, and thread it through the dispatcher
to the existing flag-aware mutator (which already accepts `boardId`):

| Tool | Schema file:line | Dispatcher file |
|---|---|---|
| `record_reading` | stage6-tool-schemas.js (find via grep — `name: 'record_reading'`) | stage6-dispatchers-circuit.js |
| `clear_reading` | stage6-tool-schemas.js | stage6-dispatchers-circuit.js |
| `create_circuit` | stage6-tool-schemas.js | stage6-dispatchers-circuit.js |
| `rename_circuit` | stage6-tool-schemas.js | stage6-dispatchers-circuit.js |
| `delete_circuit` | stage6-tool-schemas.js | stage6-dispatchers-circuit.js |

### Mechanical pattern

Each schema gets:

```js
board_id: {
  type: 'string',
  description: 'Board the circuit lives on. Defaults to currentBoardId when omitted.',
},
```

added to `properties`. Do NOT add to `required`.

Each dispatcher needs:

1. Pass `boardId: input.board_id` into the existing flag-aware mutator (`applyReadingFlagAware`, `clearReadingFlagAware`, `upsertCircuitMetaFlagAware`, `renameCircuitFlagAware`, `deleteCircuitFlagAware`). The mutator's contract already accepts the optional `boardId` (slice 5.2/5.3 wired this) — you're just exposing the field.

2. Update the validator (`validateRecordReading` / `validateClearReading` / etc.) to pass `board_id` to `circuitExistsInSnapshot` so the existence check honours the explicit board scope:

```js
// before
if (!circuitExistsInSnapshot(snapshot, input.circuit)) { /* reject */ }
// after
if (!circuitExistsInSnapshot(snapshot, input.circuit, input.board_id)) { /* reject */ }
```

### Tests

- Add 1-2 tests per tool to the existing test files (`stage6-dispatchers-circuit.test.js` etc.) covering: explicit `board_id` is honoured under flag-on; omitted `board_id` falls back to `currentBoardId`; invalid `board_id` (board doesn't exist) results in either `circuit_not_found` (because the lookup misses) or a dedicated `board_not_found` — pick `circuit_not_found` to keep the contract simple.
- Run the full suite. Expect ~3088+ green.

### Commit

Single commit, body explains: "5 existing circuit-mutator tools accept optional `board_id`; default-to-currentBoardId behaviour preserved for back-compat with sessions that pre-date Phase 6 routing."

---

## Slice 6.5 — Extend calc + sweep tools with optional `board_id`

### Scope

| Tool | Notes |
|---|---|
| `calculate_zs` | Already uses `getCircuitBucket(snapshot, ref, boardId?)` per slice 5.4; just expose `board_id` on the schema and thread through |
| `calculate_r1_plus_r2` | Same |
| `set_field_for_all_circuits` | Already uses `listCircuitRefsInBoard(snapshot, boardId?)` per slice 5.4; expose `board_id` on the schema and thread through |

For `set_field_for_all_circuits`, add the schema field but **default behaviour stays current-board-only** (the locked S5 decision from PLAN.md self-review: "Default should be current board; explicit `board_id: '*'` for cross-board"). Add a special-case handler: if `board_id === '*'`, iterate every board's circuits; otherwise iterate the resolved board's circuits.

### Tests

- Expose the schema for each tool; test that explicit `board_id` works.
- For `set_field_for_all_circuits`: test `board_id: '*'` cross-board sweep; test default = currentBoardId.

### Commit

Single commit; body calls out the `'*'` cross-board contract.

---

## Slice 6.6 — Wire-in audit + barrel

### Scope

Sanity-check the barrel (`stage6-dispatchers.js`) routes every new tool to the right dispatcher:

- `add_board` → `dispatchAddBoard`
- `select_board` → `dispatchSelectBoard`
- `mark_distribution_circuit` → `dispatchMarkDistributionCircuit`

Add a `BOARD_OP_NAMES` constant in `stage6-tool-schemas.js`:

```js
export const BOARD_OP_NAMES = ['add_board', 'select_board', 'mark_distribution_circuit'];
```

iOS doesn't strictly need this, but a backend test pinning the constant prevents a future tool addition from drifting the wire shape.

Add a single test pinning the constant + the wire-in (every name in `BOARD_OP_NAMES` resolves to a dispatcher via the barrel; missing wires throw a descriptive error).

### Commit

Small. Body: "Pins board-op surface for forward audit safety."

---

## Slice 6.7 — iOS unit-test extension (only if needed)

### Scope

iOS already has 6 BoardOp decoder tests from Phase 6.0 (commit `3734b67`).
Audit them against the schemas you wrote in 6.1 / 6.2 / 6.3:

- Phase 6.0 tests cover: `add_board`, `select_board`, `mark_distribution_circuit`, mixed-array, unknown-op forward-compat. Should already cover everything.
- IF the schemas you wrote include payload fields not yet covered by the iOS Codable struct (e.g. a new field on `add_board`), extend `BoardOp` Codable + add a regression test.

If the audit shows the iOS side is already complete, **do not commit anything to the iOS repo**. Skip 6.7 entirely.

If you DO need to extend, run the test via Mac Catalyst:

```bash
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
xcodebuild test -scheme CertMateUnified -destination 'platform=macOS,variant=Mac Catalyst' \
  -only-testing:CertMateUnifiedTests/ClaudeServiceTests \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO 2>&1 | tail -10
```

Expect "TEST SUCCEEDED" with the new test count + 1 (or +N).

---

## Slice 7.1 — System prompt MULTI-BOARD ROUTING

### Scope

Edit `config/prompts/sonnet_agentic_system.md`. Anchor: `CIRCUIT ROUTING:` at L49. Insert the MULTI-BOARD ROUTING block AFTER the CIRCUIT ROUTING section (which ends just before `ORPHANED VALUES — never silently drop:` at L54).

### Block to insert (verbatim, modulo the `select_board` designation note)

```markdown
MULTI-BOARD ROUTING:
Most jobs have one consumer unit ("the main board"). Some jobs have multiple — a sub-distribution board in the garage, a sub-main feeding a granny annexe, etc. When the inspector signals they are looking at or about to dictate from a different board, you have three tools:

- `add_board(designation, board_type, parent_board_id, feed_circuit_ref)` — when the inspector mentions a NEW consumer unit. Cues:
  - "There's another consumer unit in the garage"
  - "Right, I'm at the sub-board now"
  - "This is a sub-main fed from the main"
  Use `board_type: "sub_main"` for boards fed by a single distribution circuit; `"sub_distribution"` for multi-feed; do NOT call with `board_type: "main"` — the session always starts with one main board already.

- `select_board(board_id)` — when the inspector switches to a board they already added. Cues:
  - "Back to the main board" → `select_board("main")`
  - "OK, on DB-2 now" → `select_board("sub-1")` (use the EXACT id from the most recent add_board response or from the snapshot — designations are not accepted by select_board today)

- `mark_distribution_circuit(circuit, feeds_board_id)` — when the inspector says a circuit on the CURRENT board feeds another board. Cues:
  - "Circuit 4 feeds the garage CU"
  - "This one's the sub-main feed"
  The fed-from board MUST already exist on the job — call `add_board` first if it doesn't.

After `add_board` or `select_board`, all subsequent `record_reading` / `create_circuit` calls go to the new current board automatically. You only need to pass `board_id` explicitly if the inspector says something like "circuit 12 on the main board" while the current board is a sub-board.

When the inspector starts a session, assume there is one main board already. Do not call `add_board` for the main board.
```

> NOTE: This is slightly modified from PLAN.md L626-649 — the
> `select_board` cue explicitly tells the model to use the id, not a
> designation, because slice 6.2 ships id-only. Update if/when the
> fuzzy-match supervised slice lands.

### Tests

`src/__tests__/stage6-agentic-prompt.test.js` likely has a regression
guard. Read it; if there's an "exact-bytes" match on the prompt, update
the expectation. If there's a structural assertion (sections present,
BoardInfo mentioned), add a check that "MULTI-BOARD ROUTING" is present.

Run the prompt-related tests:

```bash
PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS=--experimental-vm-modules npx jest --silent stage6-agentic-prompt 2>&1 | tail -3
```

Expect green.

### Commit

```
feat(prompt): teach Sonnet multi-board routing (Phase 7.1)

Adds MULTI-BOARD ROUTING section to sonnet_agentic_system.md after the
CIRCUIT ROUTING block. Documents the three new tools shipped in
Phase 6 (add_board / select_board / mark_distribution_circuit) plus
the implicit currentBoardId routing for record_reading / create_circuit.

Deviation from PLAN.md L626-649: the select_board cue tells the model
to pass the EXACT board_id (not a designation), because slice 6.2 of
Phase 6 ships id-only resolution. Designation fuzzy match is deferred
to a supervised session — when that slice lands, this prompt block
should be updated to allow designations.

Phase 7.2 (resolver multi-board awareness) is NOT in this commit —
it's a supervised slice (path-2 resolver entanglement risk).
```

---

## STOP slices — summary for Derek's morning review

These slices need supervised work. Do NOT attempt autonomously. Each
needs Derek to either pair on it or explicitly authorise.

### `mark_distribution_circuit` forward-reference ask_user (Phase 6.3 part 2)

PLAN.md L577-583 specifies an `ask_user` when `feeds_board_id` doesn't
exist. This requires:

1. Generating an `ask_user` payload from the dispatcher (today the dispatcher only emits envelopes; ask_user is a separate tool the model itself emits).
2. Wiring the resolver to recognise the answer and chain `add_board` then re-run `mark_distribution_circuit`.
3. Pinning the path-2 invariants from `memory/handoff_2026-04-27_path2_review_fixes.md` against the new flow.

Why supervised: path-2 is the highest-risk regression surface in the
codebase. The 2026-04-27 path-2 review fixed 6 bugs. Touching it without
a fresh review of those invariants is reckless.

### `select_board` designation fuzzy match (Phase 6.2 part 2)

Needs:
- Designation indexing across all boards.
- Case sensitivity rule (probably case-insensitive).
- Levenshtein floor for fuzzy match (probably 1).
- Ambiguity rule (multiple matches → ask_user).
- Disambiguation when boards share designations (shouldn't happen, but defensive).

Each is a judgment call. Ship id-only first; gather product feedback;
revisit.

### Phase 7.2 — resolver multi-board awareness

PLAN.md L651-659. The path-2 resolver needs to disambiguate circuit
refs when the same number exists on multiple boards (e.g. circuit 4 on
main vs circuit 4 on sub-1). This requires:

1. Detection: when the resolver sees a `pending_write` whose `circuit` ref exists in more than one board.
2. Generating an `ask_user` with the candidate options.
3. Mapping the answer back to `(circuit, board_id)` and applying.
4. Invariants from path-2 review (no auto-resolve regression, no synthetic-write tag drift).

Same path-2 risk as `mark_distribution_circuit`. Supervised.

### iOS UI handlers for boardOps

Phase 6.0 wired the Codable. Routing the decoded ops into JobViewModel
mutations (push BoardInfo for `add_board`, set `activeBoardIndex` for
`select_board`, set `feedsBoardId` on the relevant Circuit for
`mark_distribution_circuit`) needs:

- Animation/UI feedback decisions (does the BoardTab swipe? Toast?).
- Conflict resolution (what if iOS already has a board with that id from a previous photo upload?).
- Test plan against the emulator.

Product call, not autonomy-safe.

---

## Per-slice progress log

Maintain `PHASE6_PHASE7_PROGRESS.md` next to this doc. Append after
each slice:

```
### Slice 6.X — <commit hash> — <DD/MM/YYYY HH:MM>
- Files changed: <list>
- Tests added: <count>
- Full suite count: <NNNN passed>
- Notes: <any decisions / minor deviations>
```

If a slice fails:

```
### Slice 6.X — BLOCKED — <DD/MM/YYYY HH:MM>
- Failure mode: <what happened>
- Last clean commit: <hash>
- State of working tree: <git status -s>
- Recovery action taken: <reverted to clean / wrote BLOCKED.md and stopped>
```

---

## Final-state expectations

If the autonomous run gets through 6.1 → 6.6 + 7.1 cleanly, expect:

- 7 new commits on backend `main` (`add_board` schema+dispatcher / `select_board` / `mark_distribution_circuit` / extend-mutators / extend-calc-sweep / barrel-audit / system-prompt).
- Possibly 1 commit on iOS `main` if 6.7 finds an audit gap. Otherwise iOS unchanged.
- Backend test count: ~3110 passing (was 3058; +~52 across slices).
- No pushes. No deploys. Working tree clean. PHASE6_PHASE7_PROGRESS.md populated.

If something blocks earlier, the partial state is fine — Derek picks up
from the last clean commit.

---

## One more reminder, in case it scrolls off-screen

**You do not push. You do not deploy. You do not edit Info.plist. If
in doubt, you commit locally and write a note. Derek will be back in
the morning.**
