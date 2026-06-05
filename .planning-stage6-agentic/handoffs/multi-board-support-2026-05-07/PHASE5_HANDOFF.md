# Phase 5 — Stage 6 State-Model Widening — Fresh-Context Handoff

**Read this first** when resuming Phase 5 in a new session. The sprint-level
[HANDOFF.md](HANDOFF.md) is the entry point for the whole sprint; this file
is the focused brief for the active phase.

Last updated 2026-05-07. Status: **Phases 1, 2, 2a, 3, 4, 4a all SHIPPED.
Phase 5 is next, no code written yet.**

---

## What this is

Widening the Stage 6 dictation pipeline so it can carry **multiple boards
per session** instead of the implicit single-board "circuits[0] is the
supply / board / installation namespace" model that's been baked into the
backend since the original recording pipeline.

Phases 1–4 closed the iOS / shared-types / PDF / CCU-attribution gaps as
back-compatible no-ops on existing single-board jobs. Phase 5 is the first
phase that touches the live extraction pipeline. It is also the **biggest
slice in the sprint — expect 2–3 sessions to land safely.**

The whisper / `finishRecordingSession` path is OUT OF SCOPE for Phase 5
(documented as single-board-only by Phase 4a — see `recording.js:1577`
docstring + the `logger.warn` at `recording.js:~1654`). Stage 6 (over the
WS at `/api/sonnet-stream`) is the multi-board path going forward.

---

## What's already shipped (cold-start primer)

| Phase | Repo | Commit(s) | What landed |
|---|---|---|---|
| 1 | `CertMateUnified` | `723b3f3` | Drop `subMainCableLength` from iOS BoardInfo (model + UI) |
| 2.1 | `EICR_Automation` | `1059f39` | `packages/shared-types/src/circuit.ts` mirrors iOS BoardInfo + `BoardType` union; Circuit gains `board_id`, `is_distribution_circuit`, `feeds_board_id` |
| 2.2 | `EICR_Automation` | `ebb6183` | `jobs.test.js` PUT/GET round-trip pin for multi-board fields in `extracted_data.json` |
| 2.3 | `EICR_Automation` | `ef56e25` | `validateBoardHierarchy(boards, circuits)` module + wired into `PUT /api/job` (gated on `if (boards)` so legacy single-board saves unaffected) |
| 2.4 | `EICR_Automation` | `c21820b` | `config/field_schema.json` extended by 9 entries (2 circuit, 7 board) |
| 2a | `EICR_Automation` | `ddde287` | `CIRCUIT_FIELD_ORDER` + `CIRCUIT_HEADERS` in `src/export.js` extended with `board_id` / `is_distribution_circuit` / `feeds_board_id`. Closes the CSV-round-trip Codex deal-breaker. Pinned by `src/__tests__/export.test.js` |
| 3 | `CertMateUnified` | `df4311c` | PDF "Distribution Circuit (Sub-Main)" section in `EICRHTMLTemplate.swift` (rendered when `boardType == .subMain || .subDistribution`) |
| 4 | `EICR_Automation` | `a40a9f3` | `/api/analyze-ccu` parses optional `board_id` + `board_index` and echoes both as `analysis.attribution` |
| 4 | `CertMateUnified` | `f9902cd` | iOS `.addNewBoard` extraction mode + `applyAddNewBoard(...)` + `BoardAttribution` decoding + `boardId` parameter on `analyzeCCU` |
| 4a | `EICR_Automation` | `7e588c8` | `recording.js` finish-handler explicitly scoped as single-board only + `logger.warn` on multi-board input. Closes the second Codex deal-breaker |

**The third Codex deal-breaker (Stage 6 board-ops wire protocol —
`board_ops` channel in `stage6-per-turn-writes.js` / `stage6-event-bundler.js`)
is part of Phase 5 / 6.0 and has NOT shipped yet.**

---

## What you need to know cold

### CRITICAL correction from Codex review — read this BEFORE editing PLAN.md

**The PLAN.md sketch for Phase 5.2 mutators is structurally wrong against
the current runtime.** PLAN.md shows array-style operations:

```js
// WRONG — PLAN.md style:
let bucket = snapshot.circuits.find(c => c.circuit === circuit && c.board_id === boardId);
if (!bucket) { bucket = { circuit, board_id: boardId }; snapshot.circuits.push(bucket); }
```

The actual shape on the wire is a **keyed object**:

- Initialised at `src/extraction/eicr-extraction-session.js:766`:
  `this.stateSnapshot = { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] };`
- Mutated at `src/extraction/stage6-snapshot-mutators.js:42-44`:
  `if (!snapshot.circuits[circuit]) snapshot.circuits[circuit] = {}; snapshot.circuits[circuit][field] = value;`
- Validated at `src/extraction/stage6-dispatch-validation.js`.

Codex's recommended **Option D** (locked 2026-05-07): keep the wire flat
(Option A) but key the in-memory object by composite string:

```js
// CORRECT — composite string key:
const key = `${board_id}::${circuit}`;
if (!snapshot.circuits[key]) snapshot.circuits[key] = { circuit, board_id };
snapshot.circuits[key][field] = value;
```

When serialising to iOS / persisting to `extracted_data.json`, flatten back
to an array of `{circuit, board_id, ...fields}` rows (which is what iOS
already expects). When deserialising, rebuild the composite-key object via
`ensureMultiBoardShape` (Phase 5.3).

### `circuits[0]` is the legacy supply / board / installation bucket

Confirmed via grep across `src/extraction/`:

| File:Line | Reads `circuits[0]` for |
|---|---|
| `eicr-extraction-session.js:343` | Documentation comment (authorship rules) |
| `eicr-extraction-session.js:1076` | Direct snapshot init at session start |
| `eicr-extraction-session.js:2240` | `supplyData = stateSnapshot.circuits[0]` |
| `stage6-snapshot-mutators.js:49,72-73` | `applyBoardReadingToSnapshot` writes here |
| `stage6-dispatchers-board.js:8,23,45,84,132,140` | Whole file targets `circuits[0]` |
| `stage6-dispatcher-ask.js:899` | Resolver looks here for legacy supply fields |
| `stage6-dispatchers-circuit.js:652` | `calculate_zs` reads `circuits[0].earth_loop_impedance_ze` |
| `stage6-event-bundler.js:126` | Bundler skips `circuits[0]` keys when emitting circuit events |
| `stage6-slot-comparator.js:72` | Comparator special-cases the legacy bucket |
| `stage6-per-turn-writes.js:42` | Per-turn writes filter this bucket |
| `stage6-tool-schemas.js:70,82,443,489,497` | Tool schemas document supply/board/installation routing through `circuits[0]` |
| `stage6-answer-resolver.js:351` | Auto-resolve writes land at `circuits[0]` regardless |

**This is more entrenched than PLAN.md captured.** Do NOT retire `circuits[0]`
in one pass — that's a strangler migration across 6+ files. The right move
in Phase 5 is to ADD the composite-key pathway alongside it, then migrate
readers one subsystem at a time in subsequent commits, then remove
`circuits[0]` only after parity tests pass.

The path-2 review work (`memory: handoff_2026-04-27_path2_review_fixes.md`)
explicitly funnelled supply fields through `circuits[0]` — touching this
namespace without coordinating with that flow risks regressing the
2026-04-27 fixes.

---

## Locked decisions (do NOT relitigate — see [HANDOFF.md](HANDOFF.md))

| Q | Decision | Why |
|---|---|---|
| 0.1 | Flat external API + composite-key internal | Less invasive than nested `boards[].circuits[]`; matches Codex Option D |
| 0.2 | `board_id` required when `boards.length > 1`, optional when single-board | Avoids contradicting "no implicit active circuit" prompt principle |
| 0.3 | Legacy snapshot synthesises `boards = [{ id: 'main', designation: 'DB-1', board_type: 'main' }]` and stamps legacy circuits with `board_id: 'main'` | Idempotent migration via `ensureMultiBoardShape` |
| Q5 | Inspector switches between boards via `select_board`. Each board's circuits start from 1. Composite key `${board_id}::${circuit}` handles collisions | |
| Q6 | Forward references in `mark_distribution_circuit` → `ask_user("add the missing board?")`. Server resolver chains `add_board` then re-runs `mark_distribution_circuit` on YES | |

---

## Phase 5 sub-slices — recommended commit order

Each is ~1 commit. The whole phase is **2–3 sessions** because the
`circuits[0]` strangler in 5.5 / 5.6 is the long pole.

### 5.1 — `ensureMultiBoardShape` migration helper

**New file:** `src/extraction/stage6-multi-board-shape.js`

Idempotent migration that turns any snapshot into the multi-board shape:

```js
export function ensureMultiBoardShape(snapshot) {
  if (!snapshot.boards) snapshot.boards = [];
  if (snapshot.boards.length === 0) {
    snapshot.boards.push({ id: 'main', designation: 'DB-1', board_type: 'main' });
  }
  if (!snapshot.currentBoardId) {
    snapshot.currentBoardId = snapshot.boards[0].id;
  }
  // Re-key circuits to composite keys ${board_id}::${circuit}, defaulting board_id='main'.
  const newCircuits = {};
  for (const [oldKey, fields] of Object.entries(snapshot.circuits ?? {})) {
    if (oldKey.includes('::')) {
      newCircuits[oldKey] = fields;       // already composite — no-op
    } else {
      const boardId = fields?.board_id ?? 'main';
      const circuit = fields?.circuit ?? oldKey;
      newCircuits[`${boardId}::${circuit}`] = { ...fields, circuit, board_id: boardId };
    }
  }
  snapshot.circuits = newCircuits;
  return snapshot;
}
```

**Critical:** preserve `circuits[0]` as a special-case key throughout
this migration. Legacy snapshots store the supply bucket under
literal `0` — that key must NOT be re-keyed to `'main::0'` because
no code that reads `snapshot.circuits[0]` will then find it. The
migration should leave numeric/integer keys alone in this pass and
let Phase 5.5 retire the bucket explicitly.

Tests: empty snapshot → fully populated default; partially-stamped
snapshot → mix of original + re-keyed; already-multi-board snapshot
→ no-op (idempotent); legacy `circuits[0]` bucket survives untouched.

Call site: `eicr-extraction-session.js` constructor (after line 766
where `stateSnapshot` is initialised) and `extract-loop` reload paths.
Find the latter via grep `stateSnapshot = ` outside the constructor.

### 5.2 — Composite-key mutator helpers

**Edit:** `src/extraction/stage6-snapshot-mutators.js`

Add a new helper API alongside the existing flat-key mutators (do NOT
replace them yet — that breaks every reader at once). Pattern:

```js
export function findCircuitBucket(snapshot, circuit, boardId) {
  const id = boardId ?? snapshot.currentBoardId ?? 'main';
  const key = `${id}::${circuit}`;
  return { key, bucket: snapshot.circuits[key] };
}

export function applyReadingMultiBoard(snapshot, { circuit, field, value, boardId }) {
  const id = boardId ?? snapshot.currentBoardId ?? 'main';
  const key = `${id}::${circuit}`;
  if (!snapshot.circuits[key]) snapshot.circuits[key] = { circuit, board_id: id };
  snapshot.circuits[key][field] = value;
}
```

Tests: mutator finds existing bucket; mutator creates new bucket on miss;
`board_id` defaulting works when `currentBoardId` is unset; legacy flat
keys (no `::`) coexist with composite keys (no key collision because
`'1'` and `'main::1'` are distinct strings).

### 5.3 — Wire the new mutators behind a feature flag

**Edit:** `src/extraction/stage6-dispatchers-circuit.js`

`record_reading` dispatcher currently calls the flat mutator. Add a
branch:

```js
if (process.env.STAGE6_MULTI_BOARD === 'true') {
  applyReadingMultiBoard(snapshot, { ...args, boardId: args.board_id });
} else {
  applyReadingToSnapshot(snapshot, args);   // legacy
}
```

The flag is `STAGE6_MULTI_BOARD` (per Phase 8.2 of PLAN.md). Default
`"false"` — Phase 5 lands the *capability* behind the flag; flipping it
on is a Phase 8.4 field-test gate. Same pattern at every other
mutator-calling dispatcher.

Tests: flag-off path identical to current behaviour (regression
suite); flag-on path runs the new mutator and reads via the new
`findCircuitBucket` helper.

### 5.4 — `circuits[0]` strangler — readers first

Migrate readers one subsystem at a time. Order:

1. **`stage6-event-bundler.js:126`** — bundler currently skips
   `circuits[0]` keys when emitting circuit events. Under the
   composite-key model, the equivalent filter is "skip keys whose
   `board_id` is `'main'` AND whose `circuit === 0`" (which should
   be empty in practice — circuits are numbered from 1, not 0).
   Replace with `Object.values(snapshot.circuits).filter(c => Number(c.circuit) > 0)`.

2. **`stage6-slot-comparator.js:72`** — comparator special-cases the
   legacy bucket. Update to filter by `board_id === currentBoardId`
   AND `circuit > 0` (or per-board comparison if the comparator
   expands to multi-board).

3. **`stage6-per-turn-writes.js:42`** — per-turn writes filter. Same
   pattern.

Each migration is its own commit so the diff stays auditable. Run the
full `npm test` after each — if anything regresses, the bisect points
straight at the offending mutator change.

### 5.5 — `circuits[0]` strangler — writers + dispatchers-board

**Edit:** `src/extraction/stage6-dispatchers-board.js` (existing file —
**do NOT create a sibling**, contrary to my self-review's S2 finding;
this file already handles `record_board_reading`).

The whole file currently writes to `snapshot.circuits[0]`. Migrate to:

```js
const board = snapshot.boards.find(b => b.id === (boardIdArg ?? snapshot.currentBoardId));
board[field] = value;
```

Cross-reference with `eicr-extraction-session.js:1076` (`circuits[0] = { ...fields }`
on session start) and `:2240` (`supplyData = stateSnapshot.circuits[0]`).
The session-start init becomes a no-op once `boards[]` is populated
properly by `ensureMultiBoardShape`. The `supplyData` read at :2240 should
look up `snapshot.boards.find(b => b.id === snapshot.currentBoardId)`
instead — supply data lives on the main board's `BoardInfo`, not on
`circuits[0]`.

**Risk**: this is the structural shift the path-2 review (2026-04-27)
explicitly funnelled supply fields through. Read that handoff first
(memory `handoff_2026-04-27_path2_review_fixes.md`) before touching
this slice — there's a server-side ask-resolver that depends on the
`circuits[0]` shape.

### 5.6 — Legacy `circuits[0]` removal

After 5.4 + 5.5 land and CI is green for ≥1 deploy cycle, delete the
remaining `circuits[0]` references and the legacy mutator
(`applyBoardReadingToSnapshot` at `stage6-snapshot-mutators.js:49-74`).

Move every doc-comment from "the legacy supply / board / installation
namespace" to "the main board's BoardInfo (boards[currentBoardId])".

---

## What NOT to retire in one pass

1. **`circuits[0]` namespace** — see above, 6+ files, strangler over 2 commits min.
2. **The `applyReadingToSnapshot` / `applyBoardReadingToSnapshot` flat-key mutators**
   — keep alongside the composite-key versions until 5.6 lands and the
   flag has been on for at least one deploy.
3. **`stage6-dispatchers-board.js`** is an EXISTING file (PLAN.md
   incorrectly called for a new file). Extend it; don't create a sibling.
4. **The `circuits` keyed-object initialisation at session-start** —
   line 1076 of `eicr-extraction-session.js` IS the legacy supply
   bucket init. Migrating it eagerly breaks every dispatcher that
   depends on `circuits[0]` existing before any reading is recorded.
5. **`set_field_for_all_circuits`** — default scope after Phase 6
   should be CURRENT BOARD only (per S5 in self-review), not all
   boards. Don't change this default in Phase 5.

---

## Files the auditor confirmed exist (use these line refs verbatim)

```
src/extraction/eicr-extraction-session.js:343          # Authorship doc-comment
src/extraction/eicr-extraction-session.js:766          # snapshot init: circuits: {}
src/extraction/eicr-extraction-session.js:1076         # circuits[0] = { ...fields }
src/extraction/eicr-extraction-session.js:2240         # supplyData = circuits[0]
src/extraction/stage6-snapshot-mutators.js:35-44       # applyReadingToSnapshot
src/extraction/stage6-snapshot-mutators.js:49-74       # applyBoardReadingToSnapshot (legacy)
src/extraction/stage6-snapshot-mutators.js:106-145     # upsertCircuitMeta + rename
src/extraction/stage6-dispatchers-board.js:1-200       # entire file targets circuits[0]
src/extraction/stage6-dispatch-validation.js:73        # snapshot.circuits[circuit] validation
src/extraction/stage6-event-bundler.js:126             # bundler skip-circuits[0] filter
src/extraction/stage6-slot-comparator.js:72            # comparator special case
src/extraction/stage6-per-turn-writes.js:42,58         # per-turn filter
src/extraction/stage6-dispatcher-ask.js:899            # ask-resolver lookup
src/extraction/stage6-dispatchers-circuit.js:652,678   # calculate_zs, et al
src/extraction/stage6-tool-schemas.js:70,82,443,489,497  # supply/board doc-comments
src/extraction/stage6-answer-resolver.js:351           # auto-resolve always lands here
```

---

## Open Codex deal-breakers — STATUS

| # | Codex deal-breaker | Status |
|---|---|---|
| 1 | CSV export drops new fields (`src/export.js:42` fixed `CIRCUIT_FIELD_ORDER`) | **CLOSED** by Phase 2a (`ddde287`) |
| 2 | recording.js collapses to `boards[0]` (`src/routes/recording.js:1655`) | **CLOSED** by Phase 4a (`7e588c8`) — explicitly scoped as single-board only with `logger.warn` on multi-board input |
| 3 | No `board_ops` wire channel in Stage 6 (`stage6-per-turn-writes.js:58`, `stage6-event-bundler.js:38`) | **OPEN — this is Phase 6.0**, must land BEFORE the new tools (`add_board`, `select_board`, `mark_distribution_circuit`) so iOS can persist board mutations |

Phase 5 unblocks Phase 6.0 by providing the composite-keyed snapshot
shape that `board_ops` events will reference. Once Phase 5 ships, the
first slice of Phase 6 should be the wire-protocol piece — implementing
`add_board` before its event channel exists is silent-data-loss waiting
to happen.

---

## Test strategy

### Phase 5-specific tests

- `src/__tests__/stage6-multi-board-shape.test.js` — `ensureMultiBoardShape`
  idempotence, partial migration, legacy-bucket preservation, already-multi
  no-op.
- `src/__tests__/stage6-snapshot-mutators-multi-board.test.js` — composite-
  key `findCircuitBucket` and `applyReadingMultiBoard`. Coexistence with
  flat keys (no collision).
- `src/__tests__/stage6-dispatchers-circuit-multi-board.test.js` — flag-on
  path runs through composite-key dispatcher; flag-off path is byte-
  identical to current behaviour (snapshot regression suite).
- Each `circuits[0]` strangler commit (5.4, 5.5, 5.6) gets its own
  regression test pinning the new reader behaviour.

### Existing test sweeps to run after each slice

- `npx jest src/__tests__/eicr-extraction-session.test.js` — the big
  integration suite. Will be slow (~3000 lines) but is the canary for any
  snapshot shape regression.
- `npx jest src/__tests__/stage6-*.test.js` — every Stage 6 unit.
- `npx jest src/__tests__/dialogue-engine*.test.js` — the path-2 review
  work depends on the supply bucket.
- iOS-parity script (Phase 8.1 — confirm location at impl time): backend
  schema vs iOS Codable keys = 100/100 after Phase 2.4.

### Background test infrastructure note

`xcrun simctl create` hangs in "creation state" on this Mac (flag from
Phase 1 + 3 + 4). Mac Catalyst with `CODE_SIGNING_ALLOWED=NO` is the
working test path for iOS. Backend tests run cleanly under
`NODE_OPTIONS=--experimental-vm-modules` but big files (e.g.
`eicr-extraction-session.test.js`, `stage6-cached-prefix-trust-boundary.test.js`)
take 30-60s in jest startup before test execution begins — don't kill
them prematurely.

---

## Phase 5 deliverables checklist

Mark each as you go. Aim to keep this updated in the same delivery-log
style as the other phases (chitchat-pause-2026-05-06).

- [ ] 5.1 — `ensureMultiBoardShape` module + tests + wire into session init
- [ ] 5.2 — Composite-key mutator helpers + tests
- [ ] 5.3 — Feature-flag branch on `record_reading` dispatcher (and the other
      mutator-calling dispatchers — audit via grep `applyReadingToSnapshot|applyBoardReadingToSnapshot`)
- [ ] 5.4 — Strangler reader migration (event-bundler → comparator → per-turn-writes)
- [ ] 5.5 — Strangler writer migration (`stage6-dispatchers-board.js` →
      `eicr-extraction-session.js:2240` supplyData read)
- [ ] 5.6 — Remove `circuits[0]` references + legacy mutator (only after
      `STAGE6_MULTI_BOARD` has been on through one deploy cycle)
- [ ] PLAN.md delivery-log entry per slice (chitchat-pause style)
- [ ] CLAUDE.md changelog row when phase complete (one row per phase, not per slice)
- [ ] Memory entry update — set Phase 5 to DONE and re-point "next concrete step" to Phase 6.0

---

## Memory cross-refs

- `memory/multi_board_plan_2026-05-07.md` — sprint-level pointer.
  Update Status field as Phase 5 progresses.
- `memory/handoff_2026-04-27_path2_review_fixes.md` — REQUIRED READING
  before touching `circuits[0]` writers (slices 5.5 / 5.6). Contains the
  invariants the path-2 resolver relies on.
- `memory/architecture_2026-04-27_schema_driven_resolved_asks.md` — ADR
  for the schema-driven server-resolved ask_user flow. Phase 5's
  composite-key mutators must preserve the resolver's access patterns.

---

## Pre-flight checks before starting Phase 5

1. **Pull latest `main`.** Phases 2a / 4a may have landed locally only at
   the time of writing — confirm via `git log --oneline main -15` that
   `ddde287` and `7e588c8` are present.
2. **Read** `memory/handoff_2026-04-27_path2_review_fixes.md` end to end.
   Phase 5.5 is going to touch the same code paths.
3. **Run** `npm test` once against current `main` and capture the green/red
   baseline. Stage 6 has a few flaky tests independent of multi-board work
   (e.g. parts of `FuseboardAnalysisApplierTests` on iOS); knowing them
   in advance means they don't get blamed on Phase 5 churn.
4. **Confirm** `STAGE6_MULTI_BOARD` env var is plumbed into the task-def
   (not yet — Phase 8.2 work — but Phase 5.3 needs at least the read site
   in code so `process.env.STAGE6_MULTI_BOARD === 'true'` doesn't throw).

---

## Critical rules from past mistakes

- **NEVER use `./deploy.sh`** — Docker Desktop isn't running on this Mac.
  Always `git push main` + `gh run watch <run-id>`.
- **Auto-commit after each logical unit of work** — small focused commits
  with detailed messages. The strangler migration in 5.4–5.6 NEEDS this
  granularity so a future bisect can pinpoint the failing slice.
- **Build the iOS app from `CertMateUnified/`**, not the parent repo.
  Phase 5 is backend-only, but if anything iOS-side needs touching
  (it shouldn't), use `xcodebuild ... -destination 'generic/platform=iOS Simulator' build`.
- **Do not push to main without explicit user authorisation.** Phase 5
  ships behind a feature flag (default off), so the deploy is safe — but
  the flip from off to on is a field-test gate (Phase 8.4), not a
  routine push.
- **Long backend test suites take 30-60s in jest startup.** If a test
  appears to hang, give it 90 seconds before killing. Killing prematurely
  has caused multiple false-negative cycles in this sprint.
