# Multi-Board / Sub-Main Support — Implementation Plan (2026-05-07)

**Author:** Claude (drafted 2026-05-07 after Derek's audit request)
**Status:** Phase 0 decisions LOCKED 2026-05-07. Ready to start Phase 1.
**Effort estimate:** 5-8 sessions (~12-18 hours), split across two milestones — "backend parity + PDF" (1-2 sessions) and "Stage 6 widening" (4-6 sessions)
**Depends on:** Nothing (Stage 6 Phase 2 closed)
**Risk class:** **Medium** — touches Stage 6 state model and prompt; backend half is mechanical

---

## Goal

Close the gap between the iOS app — which already supports multiple consumer units per job and "fed-from" sub-main relationships — and the rest of the stack, which silently drops or ignores those concepts. After this work:

1. Inspector adds a sub-board in the iOS UI → fields round-trip through cloud sync.
2. Sub-board cable details (material, live CSA, CPC CSA) render on the EICR PDF.
3. Inspector dictates *"add a sub-board fed from circuit 4"* → Stage 6 calls `add_board` + `mark_distribution_circuit` and the relationship is captured in state.
4. `/api/analyze-ccu` knows which board a CCU photo was for.
5. Server validates board hierarchy (no cycles, parent exists, feed circuit resolves).

**Also in scope:** drop the `sub_main_cable_length` field — not BS 7671 mandatory, never asked for in field tests, just visual noise on the BoardTab form.

---

## Out of scope

- Multi-job templates / shared sub-board definitions across jobs.
- Sub-board PDF as a separate certificate (it remains a section of the parent EICR/EIC; each sub-board gets its own page in the schedule per Q7 lock-in).
- Distribution-board diagrams / single-line drawings.
- Web frontend (`web/`) UI for sub-boards — backend round-trip only; **web UI deferred to a separate sprint** (Q2 lock-in). New fields will appear in payloads but won't render on web until that sprint lands.
- iOS LiveFillView showing "current board" indicator (deferred to a follow-up; Stage 6 manages it server-side).
- AFDD / SPD per-sub-board policy beyond what already exists on the main board.

## In scope additions (Q3 lock-in)

- **EIC certificates** — multi-board applies to EICs as well as EICRs. The EIC PDF template (likely `EICHTMLTemplate.swift` or shared with EICR) needs the same per-board pagination and sub-main section. New-installs that include a granny-annexe sub-main are in scope.

---

## Phase 0 — Decisions (LOCKED 2026-05-07)

Derek accepted all four recommendations. Each decision below is now binding for the implementation. The alternative options are kept as historical context only.

**Locked decisions summary:**
- **0.1 → Option A**: flat circuits keyed by `${board_id}::${circuit}` + sibling `boards[]` array.
- **0.2 → Option C** (Codex revision): `board_id` required when `boards.length > 1`, optional when single-board.
- **0.3**: Synthesise `boards = [{ id: 'main', designation: 'DB-1', board_type: 'main' }]` + stamp legacy circuits with `board_id: 'main'`. Idempotent.
- **0.4**: Remove `sub_main_cable_length` entirely (model + UI + wire format). No migration script — Codable.decodeIfPresent is tolerant of stale keys.

### 0.1 — Stage 6 state-model shape

**Option A — flat circuits with `board_id`** (recommended)
```js
snapshot.circuits = [
  { circuit: '1', board_id: 'main', designation: 'Lights', ... },
  { circuit: '4', board_id: 'main', designation: 'DB-2 sub-main', is_distribution_circuit: true, feeds_board_id: 'sub-1', ... },
  { circuit: '1', board_id: 'sub-1', designation: 'Kitchen', ... },
];
snapshot.boards = [
  { id: 'main', designation: 'DB-1', board_type: 'main', ... },
  { id: 'sub-1', designation: 'DB-2', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: '4', ... },
];
```

**Option B — nested boards**
```js
snapshot.boards = [
  { id: 'main', circuits: [...], ... },
  { id: 'sub-1', circuits: [...], parent_board_id: 'main', ... },
];
```

**Recommendation: Option A.** Less invasive — every Stage 6 dispatcher and mutator currently keys on `snapshot.circuits[circuit]`. Option A keeps that key shape; we just add a `board_id` discriminator and a sibling `boards[]` metadata array. Option B forces a full rewrite of `applyReadingToSnapshot`, `upsertCircuitMeta`, every test, every comparator. Cost-benefit doesn't justify Option B for the iOS-style cleanliness.

Open question: do circuit refs collide across boards? An inspector could legitimately have circuit `1` on main AND circuit `1` on sub-1. Option A handles this with the composite key `{board_id, circuit}`; Option B handles it natively. Either way, lookups change from `snapshot.circuits[circuit]` to a helper.

### 0.2 — Tool surface: implicit board context vs explicit board_id arg

**Option A — implicit (session-tracked).** Stage 6 session has a `currentBoardId`. `record_reading({circuit: 4, ...})` writes to `currentBoardId`'s circuit 4. New `select_board(board_id)` switches.

**Option B — explicit always.** Every circuit-write tool takes a required `board_id` arg. No session state.

**Option C — hybrid (recommended).** Tools take an OPTIONAL `board_id`; defaults to session's `currentBoardId`. Inspector switches with `select_board`. Inspector can still say "circuit 4 on the main board" → model sets explicit `board_id`.

Hybrid mirrors how inspectors actually dictate ("I'm on the kitchen sub-board now... OK circuit 1 is..." then occasional "back to the main board, circuit 12...").

### 0.3 — Default `board_id` for legacy snapshots

When Stage 6 loads a snapshot from a job created before this change (no `board_id` on circuits, no `boards[]`), what does it inject?

**Recommendation: synthesise** `boards = [{ id: 'main', designation: 'DB-1', board_type: 'main', ... }]` **and stamp every existing circuit with** `board_id: 'main'`. Idempotent — re-running the migration on already-stamped data is a no-op.

### 0.4 — `sub_main_cable_length` removal scope

**Recommendation: remove** from iOS model + UI + JSON wire format + (already-absent) backend schema. Existing data with the field set will be ignored on read (Codable.decodeIfPresent is tolerant) — no migration needed.

Alternative: **deprecate** rather than remove (keep the Codable key, drop the UI). Slightly safer if a future feature wants it back. Costs ~3 lines of model code.

If you want length kept anywhere (e.g. EIC certificates only?), say so before Phase 1.

---

## Phase 1 — Drop `sub_main_cable_length`

Smallest, safest, ships independently. Order it first so subsequent phases don't have to keep mentioning it.

### Files to edit

**iOS — `CertMateUnified/Sources/Models/BoardInfo.swift`**
- Line 60: delete `var subMainCableLength: String?`
- Line 91: delete `case subMainCableLength = "sub_main_cable_length"`
- Lines 107: drop `subMainCableLength: String? = nil` from `init` parameter list
- Lines 121-122: drop `self.subMainCableLength = subMainCableLength` from init body
- Custom `init(from decoder:)` (line 126+): drop the `decodeIfPresent` call for `subMainCableLength` (read-tolerant — old snapshots that still carry it are silently dropped)

**iOS — `CertMateUnified/Sources/Views/BoardTab.swift`**
- Lines 226-242: locate the "Sub-main cable section" — drop the cable-length input row. Keep material, live CSA, CPC CSA.

**iOS — tests**
- `Tests/` — grep for `subMainCableLength` and `sub_main_cable_length`; update any fixtures.

**Backend** — none. `shared-types` never had the field; `field_schema.json` never had it. Phase 2 won't add it either.

### Verification

1. iOS builds clean.
2. Open a job that previously had a length value — load is silent (the JSON key is ignored).
3. BoardTab no longer shows the length row.
4. Re-save the job; re-load; confirm payload no longer carries `sub_main_cable_length`.

### Commit

`refactor(BoardInfo): drop sub_main_cable_length — not required by BS 7671 and never used in field`

---

## Phase 2 — Backend schema parity + hierarchy validation

### 2.1 — `shared-types` widening

**File: `packages/shared-types/src/circuit.ts:38-55`**

Replace the existing `BoardInfo` (lines 38-47) and `Board` (lines 49-55) interfaces with versions that mirror iOS `BoardInfo.swift`:

```ts
export type BoardType = 'main' | 'sub_distribution' | 'sub_main';

export interface BoardInfo {
  // Existing
  name?: string;
  location?: string;
  manufacturer?: string;
  phases?: string;
  earthing_arrangement?: string;
  ze?: string;
  zs_at_db?: string;       // legacy alias, see CertMateUnified BoardInfo.swift comment
  ze_at_db?: string;       // canonical (renamed 2026-04-27)
  ipf_at_db?: string;
  // Already-present-on-iOS-but-missing-from-shared-types
  designation?: string;
  supplied_from?: string;
  polarity_confirmed?: string;
  phases_confirmed?: string;
  rcd_trip_time?: string;
  main_switch_bs_en?: string;
  voltage_rating?: string;
  rated_current?: string;
  ipf_rating?: string;
  rcd_rating_ma?: string;
  spd_type?: string;
  spd_status?: string;
  overcurrent_bs_en?: string;
  overcurrent_voltage?: string;
  overcurrent_current?: string;
  notes?: string;
  // Multi-board hierarchy (NEW)
  board_type?: BoardType;
  parent_board_id?: string;
  feed_circuit_ref?: string;
  sort_order?: number;
  // Sub-main cable (NEW, NO length per Phase 1)
  sub_main_cable_material?: string;
  sub_main_cable_csa?: string;
  sub_main_cpc_csa?: string;
}

export interface Board {
  id: string;
  designation?: string;
  location?: string;
  board_info: BoardInfo;
  circuits: Circuit[];
}
```

Add to `Circuit` (lines 8-36 of the same file): `is_distribution_circuit?: string;` and `feeds_board_id?: string;`.

### 2.2 — `jobs.js` round-trip — pass-through verification

**File: `src/routes/jobs.js:651-790`** (`PUT /api/job/:userId/:jobId`)

The handler at line 653-664 destructures `boards` and `circuits` then writes them straight to `extracted_data.json` at line 720-721. **No code change needed** — the pass-through already preserves the new fields. But add a regression test:

**File: `src/routes/__tests__/jobs.test.js`** (add new test)
```js
test('PUT /api/job preserves multi-board fields on round-trip', async () => {
  const payload = {
    boards: [
      { id: 'main', designation: 'DB-1', board_type: 'main', sub_main_cable_material: null },
      { id: 'sub-1', designation: 'DB-2', board_type: 'sub_main',
        parent_board_id: 'main', feed_circuit_ref: '4',
        sub_main_cable_material: 'Cu', sub_main_cable_csa: '16',
        sub_main_cpc_csa: '6' },
    ],
    circuits: [
      { circuit: '4', board_id: 'main', is_distribution_circuit: 'yes', feeds_board_id: 'sub-1' },
      { circuit: '1', board_id: 'sub-1', designation: 'Kitchen' },
    ],
  };
  await request(app).put(`/api/job/${userId}/${jobId}`).send(payload).expect(200);
  const got = await request(app).get(`/api/job/${userId}/${jobId}`).expect(200);
  expect(got.body.boards[1].parent_board_id).toBe('main');
  expect(got.body.boards[1].sub_main_cable_csa).toBe('16');
  expect(got.body.boards[1].sub_main_cable_length).toBeUndefined(); // Phase 1
  expect(got.body.circuits[0].feeds_board_id).toBe('sub-1');
});
```

This is the test that catches future schema regressions. The audit confirmed the data flows; the test pins it.

### 2.3 — Hierarchy validation middleware

New module: `src/extraction/board-hierarchy-validator.js` (~80 lines).

```js
export function validateBoardHierarchy(boards = [], circuits = []) {
  const errors = [];
  const ids = new Set(boards.map(b => b.id));

  // 1. Every parent_board_id resolves
  for (const b of boards) {
    if (b.parent_board_id && !ids.has(b.parent_board_id)) {
      errors.push({ code: 'parent_not_found', board_id: b.id, parent: b.parent_board_id });
    }
  }

  // 2. No cycles (DFS)
  for (const b of boards) {
    const seen = new Set([b.id]);
    let cur = b.parent_board_id;
    while (cur) {
      if (seen.has(cur)) {
        errors.push({ code: 'circular_reference', board_id: b.id });
        break;
      }
      seen.add(cur);
      cur = boards.find(x => x.id === cur)?.parent_board_id;
    }
  }

  // 3. Exactly one main board (or zero on a brand-new job)
  const mainCount = boards.filter(b => b.board_type === 'main' || !b.board_type).length;
  if (mainCount > 1) {
    errors.push({ code: 'multiple_main_boards', count: mainCount });
  }

  // 4. feed_circuit_ref resolves to a circuit on the parent board
  for (const b of boards) {
    if (!b.feed_circuit_ref || !b.parent_board_id) continue;
    const match = circuits.find(c =>
      c.board_id === b.parent_board_id && String(c.circuit) === String(b.feed_circuit_ref));
    if (!match) {
      errors.push({ code: 'feed_circuit_not_found',
        board_id: b.id, parent: b.parent_board_id, ref: b.feed_circuit_ref });
    }
  }

  return { ok: errors.length === 0, errors };
}
```

**Wire into `src/routes/jobs.js`** at line 651 (top of PUT handler):
```js
const { ok, errors } = validateBoardHierarchy(boards, circuits);
if (!ok) {
  return res.status(400).json({ error: 'invalid_board_hierarchy', details: errors });
}
```

Tests: `src/extraction/__tests__/board-hierarchy-validator.test.js` — all 4 codes + a happy-path single-main case + an empty-boards case.

### 2.4 — `field_schema.json` extension

**File: `config/field_schema.json`** — add to `board_fields`:

```jsonc
"board_type": { "type": "select", "options": ["", "main", "sub_distribution", "sub_main"] },
"parent_board_id": { "type": "text" },
"feed_circuit_ref": { "type": "text" },
"sort_order": { "type": "number" },
"sub_main_cable_material": { "type": "select", "options": ["", "Cu", "Al"] },
"sub_main_cable_csa": { "type": "select", "options": ["", "1.0", "1.5", "2.5", "4.0", "6.0", "10.0", "16.0", "25.0", "35.0", "50.0", "70.0", "95.0", "120.0"] },
"sub_main_cpc_csa":   { "type": "select", "options": ["", "1.0", "1.5", "2.5", "4.0", "6.0", "10.0", "16.0", "25.0", "35.0", "50.0"] }
```

Add to circuit fields:
```jsonc
"is_distribution_circuit": { "type": "select", "options": ["", "yes", "no"] },
"feeds_board_id": { "type": "text" }
```

(CSA option lists from `Constants.swift` — `circuitCsaOptions` and `cpcCsaOptions`. Verify exact lists when implementing.)

### Commits

1. `refactor(shared-types): mirror iOS BoardInfo + Board fields and add Circuit hierarchy fields`
2. `feat(jobs): add round-trip regression test for multi-board fields`
3. `feat(boards): add hierarchy validator + wire into PUT /api/job`
4. `feat(schema): add board hierarchy + sub-main cable fields to field_schema`

Each ships independently via CI.

---

## Phase 3 — PDF sub-main section

### File: `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift`

The per-board loop starts at line 1472 (`for board in job.boards`). The board details table renders `board.location`, `board.manufacturer`, etc. through line 1541. **Add a new conditional section** for sub-boards:

```swift
// Around line 1542 (after the existing board details table, inside the for-loop):
if board.boardType == .subDistribution || board.boardType == .subMain {
    let parent = job.boards.first { $0.id == board.parentBoardId }
    let parentDesignation = parent?.designation ?? parent?.name ?? "—"
    let feedCirc = board.feedCircuitRef ?? "—"
    html += """
    <h3>Distribution circuit (sub-main)</h3>
    <table class="board-details">
      <tr><td class="label">Fed from</td><td class="value">\(esc(parentDesignation))</td>
          <td class="label">Feed circuit</td><td class="value">\(esc(feedCirc))</td></tr>
      <tr><td class="label">Cable material</td><td class="value">\(esc(board.subMainCableMaterial ?? "—"))</td>
          <td class="label">Live conductor CSA (mm²)</td><td class="value">\(esc(board.subMainCableCsa ?? "—"))</td></tr>
      <tr><td class="label">CPC CSA (mm²)</td><td class="value">\(esc(board.subMainCpcCsa ?? "—"))</td>
          <td class="label"></td><td class="value"></td></tr>
    </table>
    """
}
```

**No length row** — Phase 1 dropped the field.

### Verification

1. Generate a PDF for a job with `boards = [main, sub]`, populate sub-main cable fields. Confirm the section renders only on the sub-board's page.
2. Generate a PDF for a single-main-board job. Confirm the section does not render.
3. Pixel-check: section sits below the board details table, above the circuit schedule, with consistent table styling.

### Commit

`feat(pdf): render sub-main distribution-circuit section on sub-boards`

---

## Phase 4 — `/api/analyze-ccu` board attribution

### Backend — `src/routes/extraction.js:1826-1891`

Add an optional `board_id` (or `board_index`) field to the multipart upload. Wire it into the response shape:

```js
// After parsing the multipart body
const boardId = req.body.board_id ?? null;
const boardIndex = req.body.board_index ? Number(req.body.board_index) : null;

// In the analysis response
return res.json({
  ...analysis,
  attribution: { board_id: boardId, board_index: boardIndex },
});
```

The route still returns the same `analysis` shape; clients that ignore `attribution` are unaffected. Backend logging picks up the attribution and tags S3 photo storage with the board id (`session-analytics/{userId}/{jobId}/ccu/{boardId}/{photoId}.jpg`).

### iOS — `CertMateUnified/Sources/Services/APIClient.swift:400-455`

`analyzeCCU(...)` gains an optional `boardId: String? = nil` parameter; appends it to the multipart form. The caller in `FuseboardAnalysisApplier.swift` already knows the boardIndex; pass through `job.boards[boardIndex].id`.

### iOS — Add new CCU extraction mode (Q4 lock-in)

**File: `CertMateUnified/Sources/Models/CCUExtractionMode.swift`**

Existing modes: `.circuitNamesOnly`, `.hardwareUpdate`, `.fullCapture`, `.appendRail`. **Add a fifth mode** alongside them in the picker:

```swift
case addNewBoard = "Add as New Board"
```

Subtitle: `"Photograph a separate consumer unit (sub-board)"`
Icon: `"square.split.2x1"` (or whichever symbol matches CCUExtractionModeSheet's visual language)

**Semantics**: extract the CCU photo, but instead of merging into the current board, **append a fresh `BoardInfo` to `job.boards`** and apply the circuits to that new board. The user is then prompted (in iOS UI, not via Stage 6) for board type (sub_main / sub_distribution) and parent / feed-circuit selection — same controls as the existing BoardTab "Fed From" picker. `boardIndex` for the upload = the index of the freshly appended board.

**File: `CertMateUnified/Sources/Processing/FuseboardAnalysisApplier.swift`**

Add a new case to the apply-mode switch — after creating the new board (with default `board_type: nil` and `parent_board_id: nil` to be filled by the user) and stamping circuits with the new board's id.

**File: `CertMateUnified/Sources/Views/CCUExtraction/CCUExtractionModeSheet.swift`**

Mode-picker UI — adding a new `CaseIterable` enum case automatically renders. Confirm visual order: circuitNamesOnly → hardwareUpdate → fullCapture → appendRail → addNewBoard.

### Commits

1. `feat(api): /api/analyze-ccu accepts optional board_id for attribution`
2. `feat(api-client): forward boardId on CCU upload`

---

## Phase 5 — Stage 6 state-model widening

**This is the biggest slice. Expect 2-3 sessions.** Per Phase 0.1, recommended shape is **flat circuits with `board_id` discriminator** plus a sibling `boards[]` array.

### 5.1 — Snapshot shape

**File: `src/extraction/stage6-snapshot.js` (or wherever the snapshot is initialised — confirm at impl time)**

Snapshot now carries:
```js
snapshot = {
  boards: [
    { id: 'main', designation: 'DB-1', board_type: 'main', /* ...board_info fields... */ },
    /* additional sub-boards added via add_board tool */
  ],
  circuits: [
    { circuit: '1', board_id: 'main', /* ...all existing circuit fields... */ },
    { circuit: '4', board_id: 'main', is_distribution_circuit: 'yes', feeds_board_id: 'sub-1' },
    { circuit: '1', board_id: 'sub-1', /* ... */ },
  ],
  observations: [ /* unchanged */ ],
  pendingWrite: null,
  currentBoardId: 'main', // Phase 0.2 hybrid — session context
};
```

### 5.2 — Mutators — `src/extraction/stage6-snapshot-mutators.js`

Every helper that currently keys on `snapshot.circuits[circuit]` needs to switch to a composite key. Lines noted from the audit:

- **Line 42-45 `applyReadingToSnapshot`**: change from `snapshot.circuits[circuit]` to:
  ```js
  const boardId = boardIdArg ?? snapshot.currentBoardId ?? 'main';
  let bucket = snapshot.circuits.find(c => c.circuit === circuit && c.board_id === boardId);
  if (!bucket) {
    bucket = { circuit, board_id: boardId };
    snapshot.circuits.push(bucket);
  }
  bucket[field] = value;
  ```
- **Line 71-74 `applyBoardReadingToSnapshot`**: today writes to `circuits[0]` (the legacy supply bucket). Change to write to `boards.find(b => b.id === boardIdArg ?? snapshot.currentBoardId)`. The "supply bucket" mental model retires.
- **Line 106-125 `upsertCircuitMeta`**: composite key.

**Single helper for board-scoped lookup** to keep call sites tidy:
```js
export function findCircuit(snapshot, circuit, boardId) {
  return snapshot.circuits.find(c =>
    String(c.circuit) === String(circuit) &&
    c.board_id === (boardId ?? snapshot.currentBoardId ?? 'main'));
}
```

### 5.3 — Legacy snapshot migration

When loading a snapshot that lacks `boards[]` or has circuits without `board_id`:

```js
export function ensureMultiBoardShape(snapshot) {
  if (!snapshot.boards) snapshot.boards = [];
  if (snapshot.boards.length === 0) {
    snapshot.boards.push({ id: 'main', designation: 'DB-1', board_type: 'main' });
  }
  for (const c of snapshot.circuits ?? []) {
    if (!c.board_id) c.board_id = 'main';
  }
  if (!snapshot.currentBoardId) {
    snapshot.currentBoardId = snapshot.boards[0].id;
  }
  return snapshot;
}
```

Run this idempotently on every snapshot load. Tests: empty snapshot, partially-stamped snapshot (some circuits have board_id, some don't), already-multi-board snapshot (no-op).

### 5.4 — Comparator updates

The Stage 6 path-2 review fixes (memory: `handoff_2026-04-27_path2_review_fixes.md`) introduced a comparator that filters by field. It now must filter by `(circuit, board_id)` composite key. Locate via grep `comparator` in `src/extraction/stage6-*` and update the keying.

### Commits

1. `refactor(stage6): introduce boards[] array on snapshot + ensureMultiBoardShape migration`
2. `refactor(stage6): mutators switch to (circuit, board_id) composite key`
3. `refactor(stage6): comparator filters on board_id`

Tests should cover legacy-snapshot migration, board switching, circuit-ref collisions across boards.

---

## Phase 6 — Stage 6 new + extended tools

### 6.1 — New tool: `add_board`

**File: `src/extraction/stage6-tool-schemas.js`** (TOOL_SCHEMAS array starts L795).

```js
{
  name: 'add_board',
  description: 'Add a new consumer unit / distribution board to the job. Use when the inspector says they are looking at an additional consumer unit, sub-board, or sub-main. The new board is automatically selected as the current board for subsequent reads/writes.',
  input_schema: {
    type: 'object',
    properties: {
      designation: { type: 'string', description: 'Board designation, e.g. "DB-2" or "Garage CU"' },
      board_type: { type: 'string', enum: ['main', 'sub_distribution', 'sub_main'] },
      parent_board_id: { type: 'string', description: 'ID of the parent board this is fed from. Required for sub_main; optional for sub_distribution.' },
      feed_circuit_ref: { type: 'string', description: 'Circuit ref on the parent board that feeds this one (e.g. "4"). Required when parent_board_id is set.' },
      location: { type: 'string' },
      manufacturer: { type: 'string' },
    },
    required: ['designation', 'board_type'],
  },
}
```

Dispatcher (`src/extraction/stage6-dispatchers-board.js` — new file):
- Generate `id`: short UUID or `sub-${n}`. Stable across the session.
- Validate: if `board_type !== 'main'`, require `parent_board_id`; that id must exist; no cycle introduced; if `feed_circuit_ref` provided, verify the circuit exists on the parent board (warn-only if not — inspector may dictate the board before the feed circuit).
- Append to `snapshot.boards`. Set `snapshot.currentBoardId` to the new id.
- Return `{ ok: true, result: { board_id, designation, currentBoardId } }`.

### 6.2 — New tool: `select_board`

```js
{
  name: 'select_board',
  description: 'Set the current board for subsequent circuit operations. Use when the inspector indicates they have moved to a different consumer unit or are about to discuss circuits on a specific board.',
  input_schema: {
    type: 'object',
    properties: {
      board_id: { type: 'string', description: 'ID of the board to make current. Use designations the inspector mentioned (e.g. "DB-1", "main", "garage").' },
    },
    required: ['board_id'],
  },
}
```

Dispatcher accepts either an id or a designation (case-insensitive match). Updates `snapshot.currentBoardId`. Returns the resolved id so the model knows which board it landed on.

### 6.3 — New tool: `mark_distribution_circuit`

```js
{
  name: 'mark_distribution_circuit',
  description: 'Flag an existing circuit as a distribution circuit feeding another board (sub-main). Use when the inspector says a circuit feeds a sub-board, e.g. "Circuit 4 feeds the kitchen sub-board".',
  input_schema: {
    type: 'object',
    properties: {
      circuit: { type: 'string' },
      board_id: { type: 'string', description: 'Board the circuit lives on. Defaults to current.' },
      feeds_board_id: { type: 'string', description: 'ID of the board this circuit feeds.' },
    },
    required: ['circuit', 'feeds_board_id'],
  },
}
```

Dispatcher (per Q6 lock-in — ask before assuming):
- Locate the circuit on the (board_id ?? currentBoardId).
- If `feeds_board_id` resolves to an existing board: set `is_distribution_circuit = 'yes'` + `feeds_board_id = <arg>`. Done.
- **If `feeds_board_id` does NOT exist yet** (forward reference — inspector said "feeds DB-2" before DB-2 has been added): **DO NOT silently add or reject.** Instead, emit an `ask_user` to the inspector:
  > *"Circuit 4 is being marked as feeding DB-2, but DB-2 isn't on the job yet. Would you like to add it as a sub-board fed from circuit 4?"*

  Resolution paths:
  - **Yes** → server-side resolver calls `add_board(designation: 'DB-2', board_type: 'sub_main', parent_board_id: <currentBoardId>, feed_circuit_ref: '4')` then re-runs `mark_distribution_circuit`. Inspector's flow continues uninterrupted.
  - **No** → reject the `mark_distribution_circuit` call; inspector clarifies (likely meant a different existing board).
  - **Cancel** → no write; back to listening.

The same "ask before adding" gate applies to `add_board` itself when the model triggers it from a weak cue (e.g. inspector says "another one" — model should ask "Did you mean another consumer unit, or another circuit?" rather than silently adding a board).

### 6.4 — Extending existing tools with optional `board_id`

Audit said the following tools currently lack any board parameter. Add **optional** `board_id` to:

| Tool | File:Line | Change |
|---|---|---|
| `record_reading` | stage6-tool-schemas.js:153 | Optional `board_id` in `input_schema.properties`; dispatcher passes through to `applyReadingToSnapshot` |
| `clear_reading` | (locate via grep) | Same |
| `create_circuit` | stage6-tool-schemas.js:227 | Optional `board_id`; circuits land on the chosen board |
| `rename_circuit` | (locate) | Optional `board_id` for disambiguation |
| `delete_circuit` | (locate) | Optional `board_id` for disambiguation |
| `record_board_reading` | stage6-tool-schemas.js:504 | Optional `board_id`; **changes default behaviour** — today writes to `circuits[0]`, after this writes to `boards.find(b => b.id === currentBoardId)` |
| `calculate_zs` / `calculate_r1_plus_r2` | (locate) | Optional `board_id` |
| `set_field_for_all_circuits` | (locate) | Add optional `board_id` to scope to a single board; if absent, applies across all boards (back-compat) |

### 6.5 — Tests

- Each new tool: dispatcher unit tests covering happy path, missing required fields, invalid hierarchy.
- `add_board` cycle prevention: attempt to make a board a parent of one of its ancestors → rejected.
- `mark_distribution_circuit` with a `feeds_board_id` that doesn't exist → flagged-but-applied (or rejected — decide at impl time, see open question 6 below).
- Migration test: legacy snapshot → tool flow → migrated snapshot still consistent.
- Regression: existing `record_reading` calls without `board_id` continue to work (default to currentBoardId = main on legacy snapshots).

### Commits (5 separate)

1. `feat(stage6): add add_board tool + dispatcher + cycle validation`
2. `feat(stage6): add select_board tool + dispatcher`
3. `feat(stage6): add mark_distribution_circuit tool + dispatcher`
4. `feat(stage6): existing tools accept optional board_id`
5. `refactor(stage6): record_board_reading writes to current board, not circuits[0]`

---

## Phase 7 — System prompt + ask-user resolver

### 7.1 — System prompt — `src/extraction/sonnet_agentic_system.md`

Add a new section after CIRCUIT ROUTING (audit located that at line 49):

```markdown
## MULTI-BOARD ROUTING

Most jobs have a single consumer unit ("the main board"). Some jobs have multiple — a sub-distribution board in the garage, a sub-main feeding a granny annexe, etc. When the inspector signals they are looking at or about to dictate from a different board, you have three tools:

- `add_board(designation, board_type, parent_board_id, feed_circuit_ref)` — when the inspector mentions a NEW consumer unit. Cues:
  - "There's another consumer unit in the garage"
  - "Right, I'm at the sub-board now"
  - "This is a sub-main fed from the main"
  Use `board_type: "sub_main"` for boards fed by a single distribution circuit (typical sub-main); `"sub_distribution"` for multi-feed; `"main"` only for the primary CU on the job.

- `select_board(board_id)` — when the inspector switches to a board they already added. Cues:
  - "Back to the main board"
  - "OK, on DB-2 now"
  - "I'm at the kitchen consumer unit"

- `mark_distribution_circuit(circuit, feeds_board_id)` — when the inspector says a circuit on the CURRENT board feeds another board. Cues:
  - "Circuit 4 feeds the garage CU"
  - "This one's the sub-main feed"

After `add_board` or `select_board`, all subsequent `record_reading`/`create_circuit` calls go to the new current board automatically. You only need to pass `board_id` explicitly if the inspector says something like "circuit 12 on the main board" while the current board is a sub-board.

When the inspector starts a session, assume there is one main board already. Do not call `add_board` for the main board.
```

### 7.2 — Ask-user resolver — `src/extraction/stage6-resolver.js` (or similar)

The path-2 review introduced a server-resolved `ask_user` flow. When ambiguity arises (e.g., inspector says "circuit 4" but there's a circuit 4 on both main and sub-1), the resolver should:

1. Generate an ask_user with options like:
   `["Circuit 4 on DB-1 (main)", "Circuit 4 on DB-2 (kitchen sub)"]`
2. Map the selected option back to `(circuit, board_id)` and apply.

Locate the resolver via grep `resolveEnumAnswer\|pendingAskUser` and add the board-disambiguation case.

### Commits

1. `feat(prompt): teach Sonnet multi-board routing`
2. `feat(stage6-resolver): disambiguate circuit refs by board on collision`

---

## Phase 8 — Tests, telemetry, rollout

### 8.1 — Test sweep

After all phases land:
- `npm test` (backend) — expect ~2400+ existing tests + ~80 new (validator, mutators, dispatchers, prompt regression).
- `xcodebuild test -scheme CertMateUnified -destination 'platform=iOS Simulator,name=iPhone 17 Pro'` — confirm BoardInfo encode/decode tests pass; FuseboardAnalysisApplier.test still green; PDF snapshot test (if it exists) updated to include the new section.
- **iOS-parity audit** (`scripts/check-ios-parity.js` or similar — confirm at impl time): backend schema must match iOS Codable keys for the new fields. Should be 100/100 after Phase 2.4.

### 8.2 — Feature flag

Wrap the Stage 6 changes (Phases 5-7) behind `STAGE6_MULTI_BOARD` task-def env var. Default `"false"` for the first deploy; flip to `"true"` after first field test. Phases 1-4 are unflagged — they're either iOS-only (Phase 1, 3) or schema-only (Phase 2) or attribution-only (Phase 4) and back-compatible.

The flag-off code path must:
- Synthesise the legacy `boards = [main]` shape on snapshot load (so the PDF still renders).
- Skip emitting the new tools to Sonnet (so the prompt-token cost is zero pre-flag-on).
- Reject calls to the new tools if the model somehow tries to use them (defence-in-depth).

### 8.3 — Token-cost measurement

Before flipping the flag on, log the prompt-token count for a sample session. Adding 3 new tools with their schemas adds roughly 600-900 tokens to the system prompt. At Sonnet 4.5 input pricing (~$3/MTok), and ~30-60 turns/session with prompt caching, the marginal cost is ~$0.005-0.010 per session. Acceptable but worth measuring vs. expected.

### 8.4 — Field test plan

Real inspector, real job, real sub-main:
1. Inspector starts a recording. Says "OK, this is a domestic install with a main consumer unit and a sub-board in the outbuilding."
2. Dictates main-board circuits.
3. Says "Circuit 4 is the sub-main to the outbuilding."
4. Dictates `mark_distribution_circuit(4, sub-1)` (model should issue this from the cue).
5. Inspector physically moves to the outbuilding.
6. Says "Right, I'm at the outbuilding sub-board now. Wylex, fed from circuit 4 on the main."
7. Model calls `add_board(designation: 'DB-2', board_type: 'sub_main', parent_board_id: 'main', feed_circuit_ref: '4')`.
8. Inspector dictates outbuilding circuits.
9. Closes session.
10. Verify in iOS:
    - Both boards appear in BoardTab.
    - Sub-board shows "Fed from DB-1".
    - Sub-board's circuits are scoped correctly.
    - Sub-main cable section can be filled in.
11. Generate PDF; verify both boards render with the sub-main section on DB-2.
12. Re-open the job; verify everything round-tripped.

### 8.5 — Rollout sequence

1. Phase 1 + 2 (backend parity + length removal): merge to main, CI deploy. iOS bumps to TestFlight when Phase 1 ready.
2. Phase 3 (PDF): TestFlight only — no backend change.
3. Phase 4 (analyze-ccu attribution): merge to main, CI deploy. iOS sends `boardId` from the next TestFlight.
4. Phase 5 + 6 + 7 (Stage 6): merge under `STAGE6_MULTI_BOARD=false`. Run automated tests. Flip flag to `true` after smoke-passing a single Derek-driven session.
5. Phase 8.4 field test with a real sub-main job. Iterate on prompt as needed.

---

## Risks

| Risk | Likelihood | Severity | Mitigation |
|------|------------|----------|------------|
| Stage 6 mutator rewrite introduces subtle regression on single-board jobs | Medium | High | `ensureMultiBoardShape` migration + comprehensive single-board test suite + feature flag gives 1-week monitoring window |
| Model issues `add_board` spuriously (e.g. when inspector says "another circuit" misheard as "another consumer unit") | Medium | Medium | System prompt cues are specific; ask-user disambiguation on `add_board` triggered by sparse input |
| Circuit ref `1` collision across main and sub-1 confuses the resolver | Medium | Medium | Composite-key lookup throughout; ask_user disambiguation when ambiguous; unit-test collision case |
| iOS LiveFillView doesn't surface "current board" → user dictates expecting main, lands on sub | Low | Medium | Out of scope for this plan, but flagged. Optional follow-up: tiny "Board: DB-2" pill in LiveFillView header |
| `record_board_reading` semantic shift (was `circuits[0]`, becomes `boards[currentBoardId]`) breaks downstream code that reads circuits[0] | Medium | Medium | Grep for `circuits[0]` + `circuits\[0\]` in src/ before implementing; comparator must be aware |
| Token cost balloons with 3 new tool schemas | Low | Low | Measured pre-rollout; cap effective cost at $0.01/session marginal |
| PDF section pushes circuit schedule onto a second page on long sub-board pages | Low | Low | Visual check during Phase 3; if it's an issue, collapse the new table to two rows |
| `feed_circuit_ref` validation rejects valid mid-dictation states (board added before feed circuit confirmed) | Medium | Low | Validator runs on save not on tool-call; intra-session state can be transiently inconsistent |
| `board_id = 'main'` collides if a real user-supplied designation happens to be the literal string "main" | Very low | Low | Use UUIDs not designations; the synthesis only uses `'main'` as a stable id, never as a user-facing label |
| Existing `boards` array in iOS uses UUID ids; new server-generated ids might mismatch | Low | High | iOS BoardInfo.id is `String = UUID().uuidString` — server should preserve whatever id iOS sends, only synthesise when nothing was sent |

---

## Definition of done

1. All 8 phases merged to `main` (backend) with green CI.
2. iOS TestFlight build available with Phase 1 + 3 (and Phase 4 client-side).
3. `STAGE6_MULTI_BOARD=true` in production task-def after smoke field test.
4. Phase 8.4 field test executed by Derek; observed:
   - Inspector dictates main + sub-main session end-to-end without manual UI fixup.
   - PDF renders both boards with sub-main section on the sub-board.
   - Job round-trips through cloud sync without losing any sub-main field.
5. CLAUDE.md changelog entry added describing the rollout + token cost measured.
6. `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/` archive contains: this PLAN.md, codex-review-{date}.md (Phase 0 review), per-slice delivery log appended at the bottom of this file (chitchat-pause style).
7. The `ios-parity` script reports 100/100 after Phase 2.4.

---

## Open questions

1. **Phase 0 decisions** — ✅ RESOLVED 2026-05-07. All recommendations accepted (see Phase 0 lock-in section above).

2. **Web frontend (`web/`) UI** — ✅ RESOLVED 2026-05-07: **defer to a separate sprint.** Web users see new fields in payloads but no UI to edit them until that sprint.

3. **EIC certificates** — ✅ RESOLVED 2026-05-07: **EICs in scope.** Multi-board applies to both EICR and EIC. EIC PDF template needs the same per-board pagination + sub-main section.

4. **Sub-board CCU photo UX** — ✅ RESOLVED 2026-05-07: **add a new mode to the CCU mode picker** alongside circuitNamesOnly / hardwareUpdate / fullCapture / appendRail. New mode: `.addNewBoard` ("Add as New Board"). Phase 4 updated.

5. **Circuit numbering on sub-boards** — ✅ RESOLVED 2026-05-07: **inspector switches between boards via `select_board`**. Each board's circuits start from 1. Composite-key approach (`${board_id}::${circuit}`) is correct.

6. **`mark_distribution_circuit` forward references** — ✅ RESOLVED 2026-05-07: **ask before adding.** If inspector says "circuit 4 feeds DB-2" before DB-2 exists, emit `ask_user` ("Would you like to add DB-2 as a sub-board fed from circuit 4?"). Server-resolver path on YES → calls `add_board` with sensible defaults then re-runs `mark_distribution_circuit`. Same ask-before-assume principle applies to `add_board` on weak cues.

7. **PDF page layout** — ✅ RESOLVED 2026-05-07: **sub-board gets its own page in the schedule** (existing default — per-board loop at `EICRHTMLTemplate.swift:1472` already does this). Sub-main section gets its own `<h3>` subsection header on that page (Phase 3 default).

---

## Status

**Drafted 2026-05-07 by Claude.** Awaiting:
- Derek's answers to Phase 0 (4 decisions)
- Codex CLI review of this plan
- Self-review summary appended below

### Codex review (2026-05-07, gpt-5.3-codex, high reasoning)

> **Verdict:** Codex would **not ship this plan as written**. Direction is right, but there are hidden data-loss paths and Stage 6 coupling gaps that will regress production.

**1 — Architectural soundness.**
Option A is directionally correct on the wire, but the implementation sketch is mismatched to current runtime shape. Stage 6 stores circuits as a **keyed object, not an array** (`eicr-extraction-session.js:766` initialises `circuits: {}`; `stage6-snapshot-mutators.js:42` writes via `snapshot.circuits[circuit] = {}`; `stage6-dispatch-validation.js:73`). My Phase 5 sketch using `snapshot.circuits.find(...)` and `.push()` is structurally wrong against the real shape.

Option B (nested boards[].circuits[]) is cleaner long-term but too invasive now. Codex's recommended **Option D** transition:
1. Keep external API flat (Option A) for iOS parity.
2. Internally key circuits by composite key (`${board_id}::${circuit_ref}`) in the existing keyed-object structure.
3. Introduce helpers first; avoid broad array rewrites.

**2 — Phase ordering.**
Splitting Phases 1-4 from 5-7 is good, but Phase 2 misses mandatory persistence work:
- `PUT /api/job` writes circuits to **CSV via fixed field order**, dropping new fields (`jobs.js:699`, `export.js:42`, `export.js:127`).
- `extracted_data.json` does NOT store circuits in that route (`jobs.js:714`).

So Phase 2's "no code change needed" claim is **false**. Add a **Phase 2a — persistence hardening** before validator/prompt work.

**3 — Stage 6 tool design (hybrid implicit/explicit board_id).**
Hybrid is risky as-is:
- Prompt currently says "no implicit active circuit across turns" (`config/prompts/sonnet_agentic_system.md:49`); adding implicit board context is a semantic shift contradicting an existing principle.
- Ask resolver is circuit-only and board-agnostic (`stage6-dispatcher-ask.js:905`).
- Auto-resolve synthetic writes don't carry `board_id` today (`stage6-dispatchers.js:219`).

Codex recommendation: **require explicit `board_id` whenever `boards.length > 1`**; keep implicit only in single-board sessions.

**4 — Risks the self-review missed (8th, 9th, 10th).**

**8 — Circuit field loss on save/clone/update via CSV** — fixed headers in `CIRCUIT_FIELD_ORDER` drop `board_id`, `is_distribution_circuit`, `feeds_board_id` (`export.js:42`, `jobs.js:1038`).

**9 — Recording pipeline collapses to single board** in whisper path (`boards[0]` only) and persists `board_info` not `boards[]` (`recording.js:1654` — `session.accumulator.board = { ...jobData.boards[0] }`; `recording.js:247`; `chunk_accumulator.js:351`).

**10 — No board-operation wire channel in Stage 6** — per-turn accumulator and bundler have no `board_ops`, so `add_board` / `select_board` mutations **won't reach iOS state** (`stage6-per-turn-writes.js:58`, `stage6-event-bundler.js:38`). This is the largest single miss: even if the model successfully calls `add_board`, the result has no plumbing to the iOS client.

**5 — `circuits[0]` retirement strategy.**
Strangler migration:
1. Add `snapshot.installation` + `snapshot.board_state[boardId]`; dual-write from existing mutators.
2. Migrate readers one subsystem at a time: calculators, comparator, bundler, prompt snapshot builder, ask resolver.
3. Remove `circuits[0]` only after parity tests pass; keep a read-through adapter for legacy snapshots.

Do not retire `circuits[0]` in one pass — too many touchpoints (`eicr-extraction-session.js:2240`, `stage6-dispatchers-circuit.js:678`, `stage6-slot-comparator.js:66`).

**6 — Cost / token estimate.**
Tool-schema payload is already large: 13 tools, ~23,915 JSON chars (~5,979 tokens by char/4). 3 new tools + extending 9 existing tools likely adds **~900-1,400 tokens** to system prompt. Marginal cost is closer to **~$0.003-$0.01/session**. Self-review's $0.002-$0.005 was optimistic. Update Phase 8.3.

**7 — Deal-breakers.**
Codex would block implementation until these are in plan:
1. Fix circuit persistence path (CSV headers / storage strategy) before any validator rollout.
2. Add Stage 6 board wire protocol (`board_ops`) so iOS can persist board mutations.
3. Define explicit board-scoping semantics for ask auto-resolve and synthetic writes.

---

### Synthesis: revisions required before sign-off

Combining Claude self-review (S1-S7) and Codex (1-7 + deal-breakers), the plan needs three additions and two corrections:

**Additions:**
- **Phase 2a — Persistence hardening.** Extend `CIRCUIT_FIELD_ORDER` in `src/export.js`. Audit all CSV/clone/export paths for field-loss. Decide whether CSV gets new columns or new fields are JSON-only. Block on this before Phase 5.
- **Phase 4a — Recording pipeline multi-board awareness.** `recording.js` collapses to `boards[0]`. Either fix to iterate, or document explicitly that whisper path is single-board only and routes accordingly. The Stage 6 path is the multi-board future, not the legacy whisper path.
- **Phase 6.0 — Stage 6 wire protocol for board operations.** Before any new tool is implemented, add `board_ops` to `stage6-per-turn-writes.js` and `stage6-event-bundler.js` so `add_board` / `select_board` / `mark_distribution_circuit` results actually reach iOS over the WS. Without this, the new tools are no-ops as far as the user is concerned.

**Corrections:**
- **Phase 5.1 — snapshot shape.** `stateSnapshot.circuits` is a **keyed object** `{circuit: {field: value}}`, not an array. Rewrite the sketch as composite-key keyed object: `snapshot.circuits['main::1'] = {...}`. The `find(...)` / `.push(...)` examples in Phase 5.2 are structurally wrong against current code.
- **Phase 0.2 / Phase 6 tool design.** Drop the "hybrid implicit" recommendation. Adopt Codex's rule: **`board_id` is required when `boards.length > 1`, optional when `=== 1`**. Eliminates the contradiction with the existing "no implicit active circuit" prompt principle. Update `select_board` to clarify that it does not establish implicit context — it's an aid for `boards.length === 1` sessions only.

**Re-scoped delivery order (post-revision):**

1. **Phase 1** — drop `sub_main_cable_length` (unchanged; iOS-only).
2. **Phase 2** — shared-types + field_schema + validator (unchanged).
3. **Phase 2a — NEW** — persistence hardening (CSV headers + audit all serialisation paths).
4. **Phase 3** — PDF sub-main section (unchanged).
5. **Phase 4** — `/api/analyze-ccu` board attribution (unchanged).
6. **Phase 4a — NEW** — recording.js multi-board awareness (or explicit single-board scope decision).
7. **Phase 5** — Stage 6 state model with corrected keyed-object shape + `circuits[0]` strangler migration plan.
8. **Phase 6.0 — NEW** — Stage 6 board-ops wire protocol (per-turn accumulator + bundler + iOS receiver).
9. **Phase 6** — Stage 6 new + extended tools, with `board_id` required when boards.length > 1.
10. **Phase 7** — system prompt + ask-user resolver (with board-aware disambiguation).
11. **Phase 8** — tests, telemetry, rollout.

Each new phase adds ~0.5-1 session. Revised total estimate: **7-11 sessions** (was 5-8).

The plan's structure remains valid. The revisions don't change Phase 0 decisions — they make the implementation honest about what each phase has to touch.

### Claude self-review (2026-05-07)

Self-review against the actual codebase surfaced **6 issues** — three substantive, three corrections — that the plan above should be amended to address before Phase 0 sign-off.

**S1 — `circuits[0]` is more entrenched than Phase 5 captured.** Grep for `circuits[0]` returns hits in `eicr-extraction-session.js:1076` (direct snapshot init), `eicr-extraction-session.js:2240` (supplyData read), `stage6-event-bundler.js:126`, `stage6-slot-comparator.js:72`, `stage6-dispatcher-ask.js:899`, plus multiple comment blocks calling it the "legacy supply / board / installation namespace". This isn't a single mutator change. Phase 5 must:
- List every `circuits[0]` site as an explicit edit point.
- Decide whether the "supply bucket" mental model retires entirely (cleaner; replace with `boards[currentBoardId]` for board-level fields) or continues for installation-level fields that aren't actually board-scoped (e.g. earthing arrangement on a TT install applies to the whole job).
- The path-2 review work (`handoff_2026-04-27_path2_review_fixes.md`) explicitly funnelled supply fields through `circuits[0]` — touching this is touching path-2's resolver. Coordinate.

**S2 — `stage6-dispatchers-board.js` already exists.** Phase 6.1 said "new file"; it's not. The existing file at `src/extraction/stage6-dispatchers-board.js` (referenced from `stage6-dispatchers-circuit.js:133`) handles `record_board_reading`. `add_board` / `select_board` should EXTEND this file, not create a sibling. Correct the plan: phase 6.1 dispatcher = additions to existing file.

**S3 — Tool line refs missing for tools targeted by Phase 6.4.** Confirmed via grep:
- `clear_reading` — `stage6-tool-schemas.js:198`
- `rename_circuit` — `stage6-tool-schemas.js:271`
- `record_observation` — `stage6-tool-schemas.js:316`
- `delete_observation` — `stage6-tool-schemas.js:372`
- `delete_circuit` — `stage6-tool-schemas.js:588`
- `calculate_zs` — `stage6-tool-schemas.js:614`
- `calculate_r1_plus_r2` — `stage6-tool-schemas.js:654`
- `start_dialogue_script` — `stage6-tool-schemas.js:682`
- `set_field_for_all_circuits` — `stage6-tool-schemas.js:760`

Phase 6.4 should embed these directly so the implementer doesn't re-grep.

**S4 — Observations not yet board-aware.** `record_observation` (L316) and `delete_observation` (L372) aren't in my Phase 6.4 extension list. Observations sometimes are board-level ("Main switch obscured" on DB-2) and sometimes circuit-level ("C2 on circuit 4 of DB-2"). They should accept an optional `board_id`. Add to Phase 6.4. The PDF rendering of observations in `EICRHTMLTemplate.swift` already groups by-circuit; will it group by `(board_id, circuit)` correctly post-change? Worth a check in Phase 3.

**S5 — `set_field_for_all_circuits` default scope is wrong.** Plan said back-compat default = all boards. Re-think: an inspector saying "set all circuits to TPN" probably means *the current board's* circuits, not the entire job. Default should be **current board**; explicit `board_id: '*'` (or a separate `apply_across_all_boards: true` flag) for cross-board. Safer + matches inspector mental model.

**S6 — CCU pipeline circuits don't carry `board_id` yet.** `/api/analyze-ccu` returns `circuits[]` that flow through `FuseboardAnalysisApplier.swift` and end up in `job.circuits`. Phase 4 adds attribution to the upload but doesn't stamp `board_id` on the returned circuits. iOS applier currently stamps board ownership client-side via `boardIndex`, but if a job is created via web upload (CCU photo only, no recording session), circuits land with no `board_id` — Phase 5's `ensureMultiBoardShape` migration covers this on the next snapshot load, but the gap is worth calling out. Add to Phase 4: optional response-side stamping if `board_id` is supplied in the request.

**S7 — Prompt cost claim is hand-waved.** "600-900 tokens" was a guess. Real Anthropic tool-use overhead per tool is ~150-300 tokens depending on schema verbosity. 3 new tools + extending 9 existing tools with an optional `board_id` arg adds ~700-1100 tokens to system prompt. With 5-min ephemeral cache and ~30 turns/session, marginal cost is closer to ~$0.002-0.005/session, not $0.005-0.010. Update Phase 8.3.

**Overall verdict:** the plan is structurally sound but Phases 5 and 6 underestimate the entrenchment of the legacy `circuits[0]` namespace and miss observation tooling. The mechanical fixes (Phases 1-4) are accurate. Recommend Derek treats the backend parity work (Phases 1-4 = ~2 sessions) as a near-term sprint, and the Stage 6 widening (Phases 5-7) as a separate decision once S1's `circuits[0]` retirement strategy is settled.

**No structural problem with Phase 0 decisions.** The recommendations stand.

### Delivery log

(Per-slice commits appended here as work lands, chitchat-pause-2026-05-06 style.)

#### 2026-05-07 — Phase 1: drop `sub_main_cable_length` (iOS-only) — SHIPPED

**Commit `723b3f3` on `CertMateUnified` `main`.** Removed
`subMainCableLength` from `BoardInfo.swift` (model property, CodingKeys
case, init parameter, init body assignment, custom decoder line, custom
encoder line) and the "Cable Length" `CMUnitTextField` row in
`BoardTab.swift` sub-main cable section. Material + Live CSA + CPC CSA
remain.

`Codable.decodeIfPresent` is tolerant of stale `sub_main_cable_length`
keys in any old job snapshots persisted before this commit — no
migration script needed. The backend
`packages/shared-types/src/circuit.ts` `BoardInfo` interface never
carried the field, so there is no wire-format break to coordinate.

Build verified: `xcodebuild -scheme CertMateUnified -destination
'generic/platform=iOS Simulator' build` → `BUILD SUCCEEDED`. (Note: the
`name:iPhone 17 Pro` destination pinned in `CertMateUnified/CLAUDE.md`
no longer resolves on this Mac — `xcrun simctl list devices` reports no
installed iOS simulators. The generic `iphonesimulator` destination was
substituted; CLAUDE.md's pinned destination should be updated or made
adaptive in a future cleanup.)

Diff size: 2 files changed, 2 insertions(+), 7 deletions(-).

**Deferred to a later sprint:** TestFlight build with this change. The
field deletion is invisible to existing users (the input row simply
disappears from Sub-Main Cable section on sub-boards), so it can ship
bundled with the next functional change.

**Next:** Phase 2 (backend `shared-types` parity + `field_schema` +
hierarchy validator) is the next concrete step. It crosses into
`EICR_Automation/` (different repo) and has a wider blast radius —
worth treating as its own session.

#### 2026-05-07 — Phase 2: backend schema parity + hierarchy validation — SHIPPED

Four commits on `EICR_Automation` `main`, all pre-CI green:

- **2.1 `1059f39`** `refactor(shared-types): mirror iOS BoardInfo + Board fields and add Circuit hierarchy fields`. `packages/shared-types/src/circuit.ts` widened to mirror the iOS shape: new `BoardType` union, 18 `BoardInfo` fields (existing iOS-only set + multi-board hierarchy + sub-main cable trio), three new `Circuit` fields (`board_id`, `is_distribution_circuit`, `feeds_board_id`), `Board.designation` / `Board.location` made optional, canonical `ze_at_db` added alongside the legacy `zs_at_db` alias. Diff: +48 / -2. Verified via `npx tsc --noEmit` on `packages/shared-types`, `packages/shared-utils`, and `web/` — all green.

- **2.2 `ebb6183`** `test(jobs): pin multi-board round-trip in PUT/GET extracted_data.json`. Three new tests in `src/__tests__/jobs.test.js`: PUT-side intercepts `mockUploadText` to assert the JSON-serialised boards array carries the hierarchy + sub-main cable fields; GET-side stubs `mockDownloadText` to confirm the response includes them; `test.todo` for the circuit-CSV round-trip pinned as the Phase 2a regression target. Phase 1's `sub_main_cable_length` deletion is also pinned (`expect(...).toBeUndefined()`).

- **2.3 `ef56e25`** `feat(boards): add hierarchy validator + wire into PUT /api/job`. New module `src/extraction/board-hierarchy-validator.js` (~95 lines) with `validateBoardHierarchy(boards, circuits) → { ok, errors }`. Four error codes: `parent_not_found`, `circular_reference`, `multiple_main_boards`, `feed_circuit_not_found`. Wired into `src/routes/jobs.js` PUT handler immediately after the auth check, gated on `if (boards)` so legacy single-board saves are unaffected. Failure returns 400 with `{ error: 'invalid_board_hierarchy', details: [...] }`. 13 unit tests + 1 route-level wire test (asserts no S3 upload happens on validator rejection). Tolerant of `circuit` vs `circuit_ref` keying, numeric `feed_circuit_ref` coercion, and missing `board_type` (counts as main for legacy snapshots).

- **2.4 `c21820b`** `feat(schema): add board hierarchy + sub-main cable + distribution-circuit fields`. `config/field_schema.json` gains 9 entries: 2 in `circuit_fields` (`is_distribution_circuit`, `feeds_board_id`) and 7 in `board_fields` (`board_type`, `parent_board_id`, `feed_circuit_ref`, `sort_order`, `sub_main_cable_material`, `sub_main_cable_csa`, `sub_main_cpc_csa`). CSA fields typed as `text` to match the iOS `CMUnitTextField` UI; `sub_main_cable_material` matches iOS `Constants.conductorMaterials` exactly. `sub_main_cable_length` intentionally absent (Phase 1).

**Phase 2 deviations from the literal plan (in commit messages):**
- Added `board_id?: string` to `Circuit` in 2.1 (the literal plan only listed `is_distribution_circuit` + `feeds_board_id`). Foundation of the multi-board model; the validator and the Phase 2.2 test both reference it.
- The plan's snippet placed tests at `src/extraction/__tests__/board-hierarchy-validator.test.js`; this repo doesn't use nested `__tests__` directories, so I followed the existing flat `src/__tests__/<name>.test.js` convention.
- The plan's `sub_main_cable_material` options were `["", "Cu", "Al"]`; I matched iOS exactly (`["", "Copper", "Aluminium", "Steel", "N/A"]`) so the picker and the schema can't drift.
- The plan's `sub_main_cable_csa` was a select; I made it `text` because the iOS UI is a `CMUnitTextField`, not a picker. A future tightening to a constrained select would need a paired iOS picker — not in scope here.
- Hooked the validator on `if (boards)` rather than always — keeps it a no-op for single-board legacy saves.

**Test counts post-Phase 2:** 1 todo + 29 passed in the two suites I touched (was 1 todo + 16 passed mid-phase). Stage6-cached-prefix-trust-boundary suite (3000-line, schema-aware) was kicked off as a sanity check — still running at commit time, expected unaffected because the schema additions are purely additive and don't collide with the field names that test verifies.

**Phase 3 (PDF sub-main section) is the next concrete step.** Like Phase 1, it is iOS-only — operates on `EICRHTMLTemplate.swift` to render a per-sub-board `<h3>` block. Lower blast radius than Phase 2; a single session.

#### 2026-05-07 — Phase 3: PDF sub-main section (iOS-only) — SHIPPED

**Commit `df4311c` on `CertMateUnified` `main`.** Inside the per-board landscape page loop in `Sources/PDF/EICRHTMLTemplate.swift` (line 1472, `for board in job.boards`), the existing 4-row Board Details table is now followed (when `board.boardType == .subDistribution || .subMain`) by a single-row "Distribution Circuit (Sub-Main)" section. Cells: Fed from (parent designation, looked up via `job.boards.first { $0.id == board.parentBoardId }`), Feed circuit (`board.feedCircuitRef`), Cable material (`board.subMainCableMaterial`), Live conductor CSA (`board.subMainCableCsa`), CPC CSA (`board.subMainCpcCsa`). Length is intentionally omitted (Phase 1 dropped the field at the model layer — a length cell here would not type-check).

The implementation splits the existing single `html += """..."""` multi-line literal into two heredocs around the new conditional block, keeping the rendered HTML byte-identical for non-sub-boards. Used the existing `red-bar-small` heading + 1×N `board-detail-table` layout exactly, so the new section blends into the page styling. Bare `esc(...)` rather than `EICRHTMLTemplate.esc(...)` to match the surrounding code style (it's a private static member of the same type).

Tests: 4 new XCTests in `Tests/CertMateUnifiedTests/PDF/EICRHTMLTemplateTests.swift`:
- `testSubMainSectionRendersOnSubBoard` — happy path; asserts heading + parent designation + material + both CSAs.
- `testSubMainSectionAbsentOnSingleMainBoard` — pins that the section is the load-bearing signal that a page belongs to a downstream board.
- `testSubMainSectionRendersOnSubDistributionToo` — covers `.subDistribution` so a typo narrowing the conditional to `.subMain` only would fail.
- `testSubMainSectionDoesNotRenderCableLength` — Phase 1 cross-check; a future regression that re-introduces a cable-length row would need to be deliberate.

Build verified: `xcodebuild ... -destination 'generic/platform=iOS Simulator' build` → BUILD SUCCEEDED. Tests verified via `xcodebuild test -destination 'platform=macOS,variant=Mac Catalyst' -only-testing:.../EICRHTMLTemplateTests CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY=""` → 25/25 pass (was 21/21 pre-Phase 3; the 4 new tests are additive). Used the Catalyst destination because `xcrun simctl create` hangs in "creation state" on this Mac, so the iPhone Simulator boot path is broken — flagged but not in scope. The Catalyst test runs are equivalent for these tests because they only exercise pure-string HTML output (no WKWebView, no PDF rendering).

**Phase 4 (`/api/analyze-ccu` board attribution + iOS `.addNewBoard` mode) is the next concrete step.** Backend + iOS, single session, low blast radius — but Phase 4a (recording.js single-board scope decision) is also unblocked and could land in parallel.

#### 2026-05-07 — Phase 4: CCU board attribution + `.addNewBoard` mode — SHIPPED

Two commits, one per repo:

**Backend `a40a9f3`** (`EICR_Automation` `main`) — `feat(api): /api/analyze-ccu accepts optional board_id for attribution`. `src/routes/extraction.js` now parses two new optional multipart fields (`board_id` string, `board_index` non-negative integer with defensive `Number.isInteger` guard), logs them on every request, and echoes both back in the response under `analysis.attribution = { board_id, board_index }`. Always present (both fields possibly null) so iOS has a single decode path. Defensive parsing matches the existing `rail_roi` precedent — bad input becomes null, never 4xx. 3 new tests in `src/__tests__/ccu-route-merger.test.js` (happy, missing-fields back-compat, malformed-board_index dropped).

**iOS `f9902cd`** (`CertMateUnified` `main`) — `feat(api-client,ccu): forward boardId on CCU upload + add .addNewBoard mode`. Fifth `CCUExtractionMode` case `.addNewBoard` (icon `square.split.2x1`, subtitle "Photograph a separate consumer unit (sub-board)"). `FuseboardAnalysis` gains optional `attribution: BoardAttribution?` decoding. `APIClient.analyzeCCU(...)` and `JobViewModel.analyzeCCUPhoto(...)` grow `boardId: String?` + `boardIndex: Int?` parameters with nil defaults. `APIClientProtocol.analyzeCCU` updated; `MockAPIClient` matches; existing call sites pass nil explicitly. `FuseboardAnalysisApplier` gains private `applyAddNewBoard(...)` that appends a fresh `BoardInfo` (designation `"DB-N"`, hierarchy fields left nil for inspector to set), stamps circuits with the new board's id, and runs `applyBoardInfo` with `overwrite: true` — the `idx == 0` guard means supply characteristics stay attached to the main board (not retroactively claimed by a sub-board photo). 4 new XCTests covering the mode in isolation; all pass on Mac Catalyst. The 46 pre-existing failures in `FuseboardAnalysisApplierTests` (`testHardwareUpdateUsesNewBoardLayoutOrder` and similar) were verified via `git stash` round-trip to fail identically on pre-Phase-4 main — not introduced by this commit, not in scope.

**Phase 4 deviations from the literal plan:**
- Plan said `analyzeCCU` "gains an optional `boardId` parameter"; I added `boardIndex: Int?` too because the backend echoes both and iOS callers may have either available (the `boardIndex` is what `FuseboardAnalysisApplier.apply(..., boardIndex:)` already takes). Backend parses both independently; passing one without the other is fine.
- Plan said the new mode would "create the new board (with default `board_type: nil` and `parent_board_id: nil` to be filled by the user)". I went further: ALSO left `feedCircuitRef`, `subMainCableMaterial`, `subMainCableCsa`, `subMainCpcCsa` nil. The CCU photo can't infer any of these — they're all inspector judgement. Pinned via `testAddNewBoardLeavesHierarchyFieldsNilForUserToFill`.
- Plan said the protocol method's new parameters could be added with default values; Swift protocols don't carry defaults across the protocol boundary, so I made the protocol method require all five and added concrete-level defaults on `APIClient` only. Trade-off explained in the commit message.

**Phase 5 (Stage 6 state-model widening) is the next concrete step** — the heaviest slice in the sprint, expected 2-3 sessions. Phase 2a (CSV-header hardening) and Phase 4a (recording.js single-board scope decision) remain unblocked backend-only items that could land in parallel.

#### 2026-05-07 — Phase 2a: CSV header hardening — SHIPPED

**Commit `ddde287` on `EICR_Automation` `main`.** `src/export.js` `CIRCUIT_FIELD_ORDER` (the array driving CSV header row + per-row column extraction in both `circuitsToCSV` and `jobToExcel`) now appends `board_id`, `is_distribution_circuit`, `feeds_board_id`. `CIRCUIT_HEADERS` (Excel human-label map) gains matching keys ("Board ID", "Distribution Circuit", "Feeds Board ID"). New entries are at the END of the order on purpose — `parseCSV` in `src/utils/jobs.js` maps by header NAME, not position, so legacy 29-column CSVs continue to parse cleanly (the new fields read as undefined for legacy rows; iOS's "first board wins" orphan-fixup at `JobViewModel.swift:88-91` catches those).

New file `src/__tests__/export.test.js` with 4 unit tests: header-line check, 3-row multi-board fixture round-trip (main + sub-board feed + sub-board final circuit), legacy 29-column CSV reads cleanly, vanilla single-board exporter round-trips empty hierarchy strings. Test does NOT import `parseCSV` from `utils/jobs.js` because that module transitively imports `storage.js` which uses `import.meta.dirname` (broken under jest `--experimental-vm-modules`); inlined a 12-line copy of the parser algorithm instead. The `test.todo` placeholder pinned to Phase 2a in `jobs.test.js` (commit `ebb6183`) is replaced by a comment cross-referencing `export.test.js` — the route-level test would only re-test the mocked `circuitsToCSV` since `jobs.test.js` mocks the export module wholesale.

**Closes Codex deal-breaker #1** (CSV export silently dropping new fields). Test results post-change: `npx jest src/__tests__/export.test.js src/__tests__/jobs.test.js src/__tests__/board-hierarchy-validator.test.js` → 33/33 green.

#### 2026-05-07 — Phase 4a: recording.js single-board scope decision — SHIPPED

**Commit `7e588c8` on `EICR_Automation` `main`.** `src/routes/recording.js` `POST /api/recording/:sessionId/finish` (the legacy whisper / `finishRecordingSession` path) gains a new docstring explicitly declaring the route as SINGLE-BOARD ONLY. The existing `boards[0]` collapse at line 1654 (single-board accumulator extraction from `jobData.boards`) gets a structural comment explaining why this collapse is correct (`session.accumulator.board` is a flat object — not array — and downstream `extractSession()` returns a single `result.board`), plus a `logger.warn` that fires when `jobData.boards.length > 1`, logging the dropped sub-board ids so silent data loss is visible in CloudWatch. The multi-board future routes through Stage 6 (`/api/sonnet-stream` WS, Phase 5+); iOS picks the right path based on whether the job has marked any sub-boards. Any multi-board payload arriving on the whisper route is now framed as a client-side routing bug.

No tests added — the change is structurally documentation + a logger call, and the route is heavily stateful (sessions / S3 / extractSession). Writing a finish-handler harness from scratch to assert one log line is more risk than the change deserves. The existing `recording.test.js` was run as a sanity check post-change → 15/15 green.

**Closes Codex deal-breaker #2** (recording.js silent multi-board drop).

#### 2026-05-07 — Phase 5 fresh-context handoff written

**Sibling `PHASE5_HANDOFF.md` (≈340 lines).** Comprehensive brief for the next session resuming Phase 5. Covers:
- Cold-start primer summarising every shipped commit by phase (1, 2.1-2.4, 2a, 3, 4, 4a).
- The CRITICAL Codex correction: `snapshot.circuits` is a keyed object (`{circuit: {field: value}}`) with init at `eicr-extraction-session.js:766`, NOT an array. PLAN.md Phase 5.2 sketch using `.find(...)` and `.push(...)` is structurally wrong — the right shape is composite-string keys (`'main::1'`, `'sub-1::1'`).
- Audit of `circuits[0]` entrenchment across 6+ files with verbatim line refs (`stage6-snapshot-mutators.js:49,72-73`, `stage6-dispatchers-board.js`, `stage6-dispatcher-ask.js:899`, `stage6-event-bundler.js:126`, `stage6-slot-comparator.js:72`, `stage6-per-turn-writes.js:42,58`, `stage6-tool-schemas.js:70,82,443,489,497`, `stage6-answer-resolver.js:351`, `eicr-extraction-session.js:343,1076,2240`).
- Recommended 6-slice commit order: 5.1 `ensureMultiBoardShape` migration helper → 5.2 composite-key mutator helpers → 5.3 feature-flag branch on `record_reading` dispatcher → 5.4 reader strangler (event-bundler, comparator, per-turn-writes) → 5.5 writer strangler (`stage6-dispatchers-board.js`, `eicr-extraction-session.js:2240` supplyData read) → 5.6 legacy `circuits[0]` removal (only after `STAGE6_MULTI_BOARD` has been on through one deploy).
- Explicit "do NOT retire in one pass" list (5 items).
- Open Codex deal-breaker tracker: #1 CLOSED by 2a, #2 CLOSED by 4a, #3 (`board_ops` wire channel) is Phase 6.0, must land BEFORE the new tools.
- Test strategy with feature-flag-aware regression suite + iOS-parity script (Phase 8.1).
- Pre-flight checks before starting: pull main, read path-2 review handoff, run baseline `npm test`, confirm `STAGE6_MULTI_BOARD` env plumbing.

The sprint-level `HANDOFF.md` was updated to point at `PHASE5_HANDOFF.md` for the active phase. The phase-specific handoff is self-contained — a fresh session resuming Phase 5 can read just `PHASE5_HANDOFF.md` and have everything it needs.

**This concludes the documentation+ infrastructure work for Phases 1-4a.** Phase 5 is the next concrete step; Phase 6.0 (Stage 6 board-ops wire protocol) follows it before any new tool can be implemented usefully.

#### 2026-05-07 — Phase 5: Stage 6 state-model widening — IN PROGRESS

Per-slice delivery log (chitchat-pause-2026-05-06 style). The phase ships behind feature flag `STAGE6_MULTI_BOARD` (default off — flip is a Phase 8.4 field-test gate, NOT a routine push).

- **Slice 5.1 — `ensureMultiBoardShape` migration helper.** New module `src/extraction/stage6-multi-board-shape.js` (~85 lines) exporting `ensureMultiBoardShape(snapshot)`, `buildDefaultMainBoard()`, and the `DEFAULT_MAIN_BOARD_*` constants. Idempotent migration that synthesises `boards: [{id:'main', designation:'DB-1', board_type:'main'}]` and `currentBoardId: 'main'` on any snapshot lacking them. **Critical**: the `circuits` keyed object is intentionally NOT re-keyed in this slice — legacy numeric keys (0 = supply / 1+ = circuit refs) survive untouched so the 8+ files that read `snapshot.circuits[0]` keep working until slice 5.5 retires them. Wired into the session constructor at `eicr-extraction-session.js:766` immediately after `this.stateSnapshot = { ... }` (only assignment site for `stateSnapshot` in the codebase — no other reload paths). 18 unit tests in `src/__tests__/stage6-multi-board-shape.test.js` covering empty / partial / already-multi-board / legacy-bucket-survives / corrupt-input / idempotent-double-call. One existing snapshot-shape pin in `eicr-extraction-session.snapshot-refactor.test.js:66` updated to expect the new keys (was: 4 keys; now: 6 keys). Test counts: 2974 total (was 2956 baseline) → 2971 passed + 3 skipped, all the new growth from slice 5.1 itself. Commit `3215e6f`.

- **Slice 5.2 — composite-key multi-board mutator helpers.** Extended `src/extraction/stage6-snapshot-mutators.js` (~155 new lines, +5 exports) with composite-key variants of every flat-key mutator currently called by a circuit-level dispatcher: `findCircuitBucket`, `applyReadingMultiBoard`, `clearReadingMultiBoard`, `upsertCircuitMetaMultiBoard`, `renameCircuitMultiBoard`, `deleteCircuitMultiBoard`. Helpers share a private `resolveBoardId(snapshot, explicit)` chain (`explicit ?? snapshot.currentBoardId ?? 'main'`) and a private `compositeKey(boardId, circuit)` formatter (`${board_id}::${circuit}`). Bucket shape on creation is `{ circuit: number, board_id: string, ...fields }` — the self-describing `circuit` + `board_id` keys let the slice 5.5 / 5.6 serialiser flatten composite-keyed snapshots back to the iOS array shape without extra bookkeeping. The board-reading equivalent (`applyBoardReadingMultiBoard`) is INTENTIONALLY deferred to slice 5.5 because it requires the structural shift to writing into `snapshot.boards.find(b => b.id === id)` BoardInfo rather than into a circuit bucket. 27 unit tests in `src/__tests__/stage6-snapshot-mutators-multi-board.test.js` covering: composite-key resolution + boardId fallback chain; create-vs-merge semantics; explicit-boardId-wins-over-currentBoardId; null-meta-skip semantics on upsert; rename idempotency / source_not_found / target_exists / per-board scoping; delete noop-vs-actual; per-board namespace isolation; AND the load-bearing slice-5.3 prerequisite invariant — legacy numeric keys (`'1'`) and composite keys (`'main::1'`) coexist in the same `snapshot.circuits` map without collision (string-keyed JS objects make `'1' !== 'main::1'`). Test counts: 3001 total → 2998 passed + 3 skipped, all the new growth from slice 5.2 itself. Commit `9fd646f`.

- **Slice 5.3 — flag-aware routing wired into every circuit-level write site.** Added `isMultiBoardFlagOn()` and `circuitExistsInSnapshot(snapshot, circuit, boardId)` to `src/extraction/stage6-multi-board-shape.js` — the single seam for the env-var lookup so a future rename / removal in slice 5.6 has one grep target. Added 5 thin `*FlagAware` wrappers to `stage6-snapshot-mutators.js` (`applyReadingFlagAware`, `clearReadingFlagAware`, `upsertCircuitMetaFlagAware`, `renameCircuitFlagAware`, `deleteCircuitFlagAware`) — each routes to the legacy mutator under flag-off and the slice-5.2 multi-board mutator under flag-on. Updated 4 validators in `stage6-dispatch-validation.js` (`validateRecordReading`, `validateClearReading`, `validateCreateCircuit`, `validateRenameCircuit`) to use `circuitExistsInSnapshot` so existence checks honour the active flag. Updated 7 dispatcher call sites in `stage6-dispatchers-circuit.js` (record_reading, clear_reading, create_circuit, rename_circuit's rename + meta-upsert, delete_circuit, applyCalculatedReading helper for calculate_zs / calculate_r1_plus_r2, set_field_for_all_circuits's per-circuit write). Updated 2 derived-script call sites: `ring-continuity-script.js:437` and `insulation-resistance-script.js:420` — synthesised computed-value writes flow through the same wrapper so they land in the same bucket shape as the inspector-dictated readings that triggered the script. Updated the legacy `off`-mode path in `eicr-extraction-session.js:2039,2067` (`updateStateSnapshot`'s `extracted_readings` + `field_clears` processing) for consistency — production runs `live` mode (Stage 6 tool calls), so this branch is dormant, but flag-threading prevents split-brain if off-mode runs with the flag on. Set scoping for `set_field_for_all_circuits` is intentionally unchanged (per Phase 5 handoff S5: current-board-only scoping is a Phase 6 concern). 22 new unit tests in `src/__tests__/stage6-multi-board-flag-routing.test.js` covering: env-var plumbing (only literal `'true'` enables; `'1'`/`'TRUE'`/`'yes'` do NOT — defence against typos in task-def env config); `circuitExistsInSnapshot` flag-on / flag-off branching; per-wrapper flag-routing; end-to-end dispatcher round-trip under flag-on for record_reading / clear_reading / create_circuit / rename_circuit / delete_circuit / record_reading-with-circuit-not-found-rejection. Test counts: 3023 total → 3020 passed + 3 skipped, all the new growth from slice 5.3 itself. **The flag is default-off in production** — slice 5.4 has to migrate the readers (event-bundler / comparator / per-turn-writes) before the flag can be flipped on for a real session. Commit `0876bed`.

- **Slice 5.4 — flag-aware reader helpers + circuit-iteration migration.** Added 2 reader helpers to `src/extraction/stage6-multi-board-shape.js`: `getCircuitBucket(snapshot, ref, boardId)` (replaces inline `snapshot.circuits[ref]` reads) and `listCircuitRefsInBoard(snapshot, boardId)` (replaces inline `Object.keys(snapshot.circuits).map(Number).filter(...)` iteration). Both flag-aware: under flag-off they hit legacy numeric keys; under flag-on they hit composite-key buckets scoped to the active board (`bucket.board_id === currentBoardId AND bucket.circuit >= 1`). Migrated 4 reader sites in `stage6-dispatchers-circuit.js`: `selectorRefs` (powering calculate_zs / calculate_r1_plus_r2 with `'all'` scope), the per-circuit `circuits?.[ref]` lookups in both calc dispatchers (replaceAll → `getCircuitBucket(...)`), the iteration in `dispatchSetFieldForAllCircuits` (`Object.keys(...).map(Number).filter(...)` → `listCircuitRefsInBoard`), and the per-circuit bucket fetch in the same dispatcher. **Important deviation from the literal handoff:** the handoff identified `stage6-event-bundler.js:126`, `stage6-slot-comparator.js:72`, and `stage6-per-turn-writes.js:42` as the readers to migrate. Audit revealed those line refs point at COMMENTS, not code paths — none of the three files iterate `snapshot.circuits` directly; they all read from `perTurnWrites.readings` (Map) or `result.extracted_readings` (wire shape). The actual readers that need migration to handle composite-keyed buckets are the calc-tool dispatchers + set_field_for_all_circuits, which is what shipped here. The snapshot serialiser (`eicr-extraction-session.js:2270, 2315, 2550`) is the other significant reader — DEFERRED to slice 5.5 because it's tightly coupled to the `circuits[0]` supply read that slice 5.5 covers anyway. Other reader sites (`ring-continuity-script.js`, `insulation-resistance-script.js`, `ring-continuity-timeout.js`, `insulation-resistance-timeout.js`, `dialogue-engine/helpers/circuit-resolution.js`, `stage6-dispatcher-ask.js`, `filled-slots-filter.js`) are deferred to Phase 7 — they're synthesis / dialogue paths that don't gate flag-on functional correctness for the basic record_reading + calc round-trip. 13 new unit tests in `stage6-multi-board-flag-routing.test.js`: `getCircuitBucket` flag-on / flag-off / explicit-boardId / defensive on null; `listCircuitRefsInBoard` flag-on / flag-off / per-board scoping / sort order / legacy-bucket-ignored under flag-on / currentBoardId fallback / defensive; end-to-end `calculate_zs` round-trip under flag-on (composite-keyed `r1_r2_ohm` input → composite-keyed `measured_zs_ohm` output, Ze still read from legacy `circuits[0]` until slice 5.5); `set_field_for_all_circuits` walks current-board only (no spill onto sibling boards). Test counts: 3036 total → 3033 passed + 3 skipped.
