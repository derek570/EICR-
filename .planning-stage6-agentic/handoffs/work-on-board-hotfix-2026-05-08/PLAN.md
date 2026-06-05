# "Work on Board" Hotfix — fix the 10 review findings before field test

**Author:** Claude (drafted 2026-05-08 after the post-sprint code review)
**Status:** DRAFT v3 — v2 then amended again after Codex's v2 review (1 remaining BLOCKER on key-decode spec, 3 IMPORTANTs added: Sonnet correction path, ExtractedReading memberwise-init, AudioImportViewModel scope)
**Effort estimate:** 3-4 sessions across 6 slices
**Depends on:** the just-shipped phases A-E on `main` for both repos
**Risk class:** **Medium-high.** Slice 1 is data-correctness with no current safety net (no test reproduces the round-trip bug); the rest is contract polish.

## v2 → v3 amendments (second Codex review pass)

Codex reviewed v2 and confirmed BLOCKERs 1 and 3 closed; flagged BLOCKER 2 as PARTIALLY closed because the per-turn key encoding spec was underspecified. Three new IMPORTANTs landed:

- **Slice 1.1c key encoding** — replaced the bare `__main__` sentinel with NUL-bracketed ` __board__ <boardId> ` tag. Spec'd legacy 2-part key compat, `::`-in-boardId rejection, empty-string normalisation, and decoder edge cases. Added 4 explicit unit-test cases.
- **Slice 1.3** — added the Sonnet correction path (lines ~5616, ~5727) which has its own `boards[0]` hardcodes outside the main `applySonnetReadings` path.
- **Slice 1.2** — added explicit memberwise-init treatment for `ExtractedReading` and `CircuitUpdate` (Option A: property-level default `nil`).
- **New sub-slice 1.3b** — AudioImportViewModel boards[0] hardcodes (offline-import flow). Same fix pattern; deferred to follow-up if slice 1 inflates.

NIT acknowledgements:
- Slice 2.4 envelope naming convention left as-is — Codex flagged it might drift; specified by reference to existing `sonnet-stream-select-board.test.js` envelope helper rather than re-spelling each ack name.
- `sub-distribution` vs `sub_distribution` spelling normalised — backend uses `sub_distribution` as the canonical schema enum value (Phase 2.1, see `packages/shared-types/src/circuit.ts`); plan prose now uses that throughout.

## v1 → v2 amendments (post Codex review)

Codex caught three BLOCKERs in v1:

1. Slice 1 missed `stage6-shadow-harness.js`. The bundler is NOT the only
   thing that produces the iOS-bound wire shape — shadow-harness FOLDS
   `extracted_board_readings` and create/rename `circuit_updates` into
   `extracted_readings` with `circuit: 0` / circuit-ref entries, and STRIPS
   `cleared_readings` / `extracted_board_readings` / native
   `circuit_updates` / `observation_deletions` from the iOS-bound payload
   (`stage6-shadow-harness.js:318-462`). Both folds drop board scope today.
   **Slice 1.1 expanded — see new sub-slice 1.1b.**
2. Slice 1 left per-turn accumulator key collisions unresolved. The Map
   key in `stage6-per-turn-writes.js` is `${field}::${circuit}` (and
   `boardReadings` is keyed by `field` alone). A single-turn cross-board
   write — e.g. via `set_field_for_all_circuits('*')` — clobbers one
   write. **Slice 1.1c added.**
3. Slice 1.3 referenced `applySonnetClearings` (doesn't exist on iOS;
   shadow-harness STRIPS `cleared_readings` from the wire). Clearings
   never reach iOS today — that's a separate gap, out of scope here.
   **Slice 1.3 corrected to drop the reference and call out the existing
   shadow-harness `legacyShapeDeletes` path that DOES reach iOS.**

Codex IMPORTANTs also rolled in:

- Slice 1.4 — Swift `[String: Any]` does NOT skip nil keys; needs
  explicit `if let` to omit. **Amended.**
- Slice 1.5 — priority-chain branch 3 test missing. **Added.**
- Slice 2.4 — ordering tests missing (must assert `session_ack` arrives
  before initial `current_board_changed`). **Added.**
- Rollout — claim "close all 10" while gating only slices 1-3 was
  inconsistent. **Reframed: BLOCKERs (#1, #2) and IMPORTANTs that affect
  same-deploy correctness (#5, #7, #8) gated together; #4 and #6 added
  to the gate; #3 (#9, #10) follow-up.**
- Risk register — mixed-version client migration risk added.
- Closure matrix — added as `## Issue closure matrix` section.

---

## Goal

Close the 10 issues raised in the 2026-05-08 code review (Codex + Claude) so the "Work on Board" sprint can ship to the next field test without losing or misrouting readings on a 2-board job.

The sprint's invariant — *dictation lands on the active board* — currently breaks on the round-trip: backend correctly stores at composite-key buckets (Phase A), but the wire shape and iOS apply path both ignore `board_id`, so readings land on `boards.first` regardless of what the inspector said.

This plan is the smallest set of changes that closes that gap end-to-end and tightens the broadcast / error-contract surfaces.

---

## Issue closure matrix

Every issue has a single owning slice + sub-slice + the test that proves closure. All rows must be green before declaring the plan complete.

| # | Owning sub-slice | Files touched | Test that proves closure | Acceptance |
|---|---|---|---|---|
| 1 | 1.1a, 1.1b, 1.1c, 1.2, 1.3 | bundler, per-turn-writes, snapshot-mutators, shadow-harness, ClaudeService.swift, DeepgramRecordingViewModel.swift | EEB8F9EA round-trip in `stage6-shadow-harness.test.js` AND `DeepgramRecordingViewModelTests.swift` | Sub-1 reading lands at `(boardId='sub-1', circuitRef='1')` on iOS; main's circuit 1 untouched. |
| 2 | 2.1 | sonnet-stream `emitCurrentBoardChangedFromBoardOps` | `add_board op fires current_board_changed (source=sonnet_add)` in `sonnet-stream-select-board.test.js` | After Sonnet calls `add_board`, iOS banner moves to the new board within one extraction send. |
| 3 | 4.1 | dialogue-engine/helpers/circuit-resolution.js, dialogue-engine/engine.js | New tests in `dialogue-engine-circuit-resolution.test.js` | Designation match resolves sub-board circuits when `currentBoardId == 'sub-1'`. |
| 4 | 3.1 | stage6-dispatchers-circuit.js (5 dispatchers + record_board_reading) | New tests in dispatcher tests | Cross-board write returns `wrong_board` BEFORE `circuit_not_found`. |
| 5 | 1.4 | DeepgramRecordingViewModel.swift `buildJobStateForServer` | New test in DeepgramRecordingViewModelTests.swift | iOS-emitted boards array hydrates correctly server-side; `getMainBoardId` resolves to the iOS-flagged main. |
| 6 | 3.2 | DeepgramRecordingViewModel.swift `serverDidReceiveSelectBoardAck` | New test verifying TTS fires on `ok=false` | Inspector hears "That board isn't on this job" on `board_not_found`. |
| 7 | 2.2 | sonnet-stream `flushPendingExtractions` | New test in select-board test file | After reconnect with buffered select_board op, iOS receives `current_board_changed`. |
| 8 | 2.3 | sonnet-stream `session_start` + reconnect branch | New tests for ordering AND emission | iOS gets `current_board_changed` after `session_started` ack on every fresh start AND every reconnect. |
| 9 | 5.1 | LiveFillView.swift | New test for active-board supply rendering | LiveFillView's supply line shows sub-1's data when `currentBoardId == 'sub-1'`. |
| 10 | Slice 6 | n/a (manual) | Real recording session on iPad | Banner flips, log rows match, no data corruption observed. |

---

## Issue catalogue (numbered to match the review)

| # | Severity | Where | What |
|---|---|---|---|
| 1 | BLOCKER | bundler + iOS apply | Readings drop `board_id` on the wire; iOS pins to `boards.first` |
| 2 | BLOCKER | dispatcher + Phase E helper | `add_board` flips currentBoardId but no `current_board_changed` fires |
| 3 | IMPORTANT | dialogue-engine | Bare-numeric `snapshot.circuits[ref]` access bypasses dual-shape helpers |
| 4 | IMPORTANT | dispatchers | `validateBoardScope` runs after existence check; wrong error class |
| 5 | IMPORTANT | iOS jobState | `buildJobStateForServer` omits `board_type` / `designation` / hierarchy fields |
| 6 | IMPORTANT | iOS DeepgramRecordingViewModel | `select_board_ack` failure path unimplemented despite docstring |
| 7 | IMPORTANT | sonnet-stream `flushPendingExtractions` | Replays buffered extractions but skips broadcast scan |
| 8 | IMPORTANT | sonnet-stream session start/resume | No initial `current_board_changed` on session_start or session_resumed |
| 9 | NIT | LiveFillView | `boards.first` hardcode — supply line lies about active board |
| 10 | NIT | Phase D banner | Untested on real iPad / multi-split layouts |

---

## Slice ordering

Issues group into 6 slices by wire-contract / repo / risk. Slices 1-3 are the **hotfix gate** — must ship together to GitHub Actions before any TestFlight build for field test. Slice 4 (dialogue-engine) is correctness-relevant for sub-board script flows but not part of the round-trip gate, so it can ship in a fast-follow CI deploy. Slices 5-6 are UX/verification, not data-correctness.

| Slice | Issues | Layer | Risk | Estimate | Gate? |
|---|---|---|---|---|---|
| **1** | #1, #5 | Backend bundler + shadow-harness + per-turn writes + iOS Codable + iOS apply path + iOS jobState | High | 1.5 sessions | **GATE** |
| **2** | #2, #7, #8 | Backend broadcast helper + flush + session_start/resume | Low | 0.5 session | **GATE** |
| **3** | #4, #6 | Dispatcher ordering + iOS ack handler | Low | 0.5 session | **GATE** |
| **4** | #3 | Dialogue-engine dual-shape rollout | Medium | 0.5-1 session | Fast follow-up (within hotfix sprint) |
| **5** | #9 | LiveFillView active-board consumer | Low | 0.5 session | Follow-up |
| **6** | #10 | Field-test verification | n/a | manual | Verification (gates "sprint complete" declaration) |

**Total: 3-4 sessions.** Hotfix gate = slices 1-3 = ~2.5 sessions. Slice 4-5 = another 1-1.5 sessions. Slice 6 = a real recording + analysis afterwards.

The "claim closure on all 10 issues" wording is honest only AFTER slices 1-5 ship AND slice 6 verifies. Until then, treat #3 (#9) as known-but-unfixed in the round-trip data layer.

---

## Slice 1 — Board-scoped reading round-trip (BLOCKER #1 + IMPORTANT #5)

The wire contract gap. Backend stores correctly; the bridge to iOS loses board scope; iOS pins all readings to first board. Fixed atomically because all three layers share one wire shape.

**Codex caught that the wire shape is shaped TWICE — once by the bundler
(`stage6-event-bundler.js`) and again by the shadow-harness fold-and-strip
layer (`stage6-shadow-harness.js`). Both must carry board scope through
to iOS, AND the per-turn accumulator's collision keys must include
boardId so cross-board sweeps don't clobber each other.**

### 1.1a Backend bundler emits `board_id`

**File:** `src/extraction/stage6-event-bundler.js`

Today (line ~78-88) the readings projection emits `{field, circuit, value, confidence, source}` only. The `perTurnWrites.readings` Map's KEY is `${field}::${circuit}` — but the dispatcher writes carry `boardId`, lost in the projection.

**Change:**
- Extend the Map's value entry shape (`stage6-per-turn-writes.js`) to carry `boardId` alongside `value`/`confidence`/`source_turn_id`/`auto_resolved`.
- `applyReadingFlagAware` in `stage6-snapshot-mutators.js` already receives `boardId` — pass it through to the Map entry.
- Bundler reads `entry.boardId` and emits `reading.board_id = entry.boardId` (omit when null/undefined to keep wire shape stable for single-board sessions).

**Same shape for `extracted_board_readings`** — these are board-level (supply etc.) writes via `record_board_reading`. They need `board_id` too.

**Same shape for `circuit_updates`** — every per-circuit op (create/rename/delete) must carry `board_id`. Source: `dispatchCreateCircuit` / `dispatchRenameCircuit` / `dispatchDeleteCircuit` all already accept `input.board_id` (Phase B) and write to the resolved `currentBoardId`. Plumb it through `perTurnWrites.circuitOps.push({op, circuit_ref, board_id, ...})`.

**`cleared_readings` is dropped from this slice** — the shadow-harness STRIPS that slot from the iOS-bound payload (`stage6-shadow-harness.js:462`). Adding board_id to a slot that's deleted before send is a no-op. Track separately (clearings don't reach iOS today, period — that's an existing gap, NOT a regression we're introducing).

### 1.1b Shadow-harness folds preserve `board_id`

**File:** `src/extraction/stage6-shadow-harness.js`

The shadow-harness rewrites the bundler output for iOS Build 282-302 compatibility. Three fold paths drop board scope today:

- **Lines 323-330** — folds `extracted_board_readings` into `extracted_readings` with `circuit: 0` (the supply-line convention). Today: emits `{field, circuit: 0, value, confidence, source}`. **Change:** preserve `board_id` from the source `br.board_id` field added in 1.1a so iOS knows which board's supply line this is.
- **Lines 371-385** — folds `circuit_updates` create/rename `meta` fields into `extracted_readings` (e.g. `meta.designation` becomes a reading entry with `field: 'designation', circuit: ref`). **Change:** preserve `board_id` from `op.board_id` (added in 1.1a) on the synthesised reading entry.
- **Lines 436-447** — `legacyShapeDeletes` projects delete ops into iOS's `circuit_updates` legacy shape `{circuit, designation, action: 'delete'}`. **Change:** add `board_id` from `op.board_id`. iOS `CircuitUpdate` decoder (Sources/Services/ClaudeService.swift) needs the symmetric optional field — see slice 1.2.

After 1.1b, the iOS-visible wire shape is ONE place — `extracted_readings` + the legacy-shape `circuit_updates` for deletes — and BOTH carry `board_id`.

### 1.1c Per-turn accumulator collision keys include `boardId`

**File:** `src/extraction/stage6-per-turn-writes.js` + `src/extraction/stage6-event-bundler.js` (decoder).

Today:
```js
this.readings = new Map();              // key = `${field}::${circuit}`
this.boardReadings = new Map();         // key = `${field}` (one main board assumption)
```

A single-turn cross-board write — `set_field_for_all_circuits` with `board_id: '*'` is the canonical case, and any future tool that writes per-circuit across boards in one tool-loop iteration — collides on the existing key shape and one write overwrites the other.

**Encoding spec (full contract, must be implemented exactly as written):**

1. **Sentinel:** use ` __board__ <boardId> ` (NUL-bracketed) as the boardId tag, NOT bare `__main__`. NUL bytes never appear in field names, circuit refs, or any plausible board id, so the tag is unambiguous. Eliminates Codex's "real boardId == '__main__'" collision concern.
2. **Forbid `::` in boardId at write time** — `applyReadingFlagAware` (and equivalent mutators) MUST throw a TypeError if `boardId` contains `::`. Document at the dispatcher boundary so Sonnet input validation catches it before the mutator. Board ids today are UUIDs / `main` / `sub-N` — none contain `::`. This is defensive against future board-id schemes.
3. **Empty-string normalisation:** dispatcher and mutator wrappers treat `boardId === ''` as `boardId === undefined` — coerce at the boundary so the Map key never contains an empty boardId tag.
4. **`readings` Map key shape:**
   ```
   `${field}::${circuit} __board__ ${boardId ?? ''} `
   ```
   When `boardId` is null/undefined, the boardId segment between the two trailing NULs is empty, decoded as null (dispatcher main-board default).
5. **`boardReadings` Map key shape:**
   ```
   `${field} __board__ ${boardId ?? ''} `
   ```
6. **Decoder** in `stage6-event-bundler.js`:
   - Split on the literal ` __board__ ` separator (two-segment split, regardless of how many `::` exist in field/circuit). First segment = `${field}::${circuit}`, second segment = `${boardId} `.
   - Strip the trailing ` ` from segment 2; empty string → null.
   - Inside segment 1, find the LAST `::` (field names never contain `::`; circuit refs never contain `::` — both invariants asserted by the dispatcher's validators). Split there: prefix = field, suffix = circuit ref.
7. **Legacy fixture compat:** if a Map key contains NO ` __board__ ` separator (i.e. came from a pre-hotfix test fixture or older accumulator), decode with the OLD 2-part rule (`field::circuit`) and set `boardId = null`. Bundler emits `extracted_readings` entry with `board_id` field omitted (back-compat with single-board sessions).

**Tests in slice 1.5 must cover:**
- Round-trip a key with each of: `boardId === null`, `boardId === 'main'`, `boardId === 'sub-1'`, `boardId === '__main__'` (the literal string, not the sentinel — proves no collision with the historical sentinel).
- Reject `boardId === 'a::b'` at write time with TypeError.
- Decode a legacy 2-part key produces `boardId === null` and emits `extracted_readings` without `board_id`.

Add a regression test (slice 1.5) where a single tool-loop turn writes circuit 1 / field `zs` on BOTH main and sub-1 — verify both survive into `extracted_readings`.

### 1.2 iOS `ExtractedReading` + `CircuitUpdate` decode `board_id`

**File:** `Sources/Services/ClaudeService.swift`

`ExtractedReading` (line ~41 area) is a Codable struct. Add:
```swift
let boardId: String?
…
case boardId = "board_id"   // in CodingKeys
```

Use `decodeIfPresent` — older payloads omit the field (single-board sessions / pre-fix backends).

**Memberwise-init impact:** `ExtractedReading` has direct callers (e.g. `DeepgramRecordingViewModel.swift:3706` synthesises `ExtractedReading(circuit:..., field:..., value:..., unit:..., confidence:...)` for the comma-split fold). Adding a non-default `boardId` parameter would break every call site. Pick ONE:

- **Option A (preferred):** make `boardId` carry a default (`let boardId: String? = nil`) at the property level; Swift's synthesised memberwise init exposes it as a parameter with default value, so existing call sites compile unchanged.
- **Option B:** Keep an explicit custom init that defaults `boardId = nil`. More boilerplate but explicit.

Go with Option A. Add a test that asserts existing call sites still compile and that the comma-split fold preserves `reading.boardId` from the source reading on each synthetic clone.

`CircuitUpdate` is the legacy-shape `{circuit, designation, action}` decoder. Extend with optional `boardId` so iOS can route the delete to the right board (the only shape that flows into this slot post-shadow-harness; see 1.1b). Same memberwise-init treatment.

`ClearedReading` is NOT extended — the shadow-harness strips that slot from the iOS-bound payload, so iOS never decodes it. Out of scope here.

### 1.3 iOS apply path routes by `(boardId, circuitRef)`

**File:** `Sources/Recording/DeepgramRecordingViewModel.swift`

Today `applySonnetReadings` (line ~3614) does:
```swift
let defaultBoardId = job.boards.first?.id            // ← line 3619
…
var circuitIdx = job.circuits.firstIndex { $0.circuitRef == circuitRef }   // ← line 3687
```

**Change to:**
```swift
// Resolution priority:
//   1. reading.boardId (server told us)
//   2. jobVM.currentBoardId (Phase E mirror of server-side currentBoardId)
//   3. boards.first?.id (legacy single-board fallback; emits a debug log
//      so we can spot single-board mode in CloudWatch)
let targetBoardId = reading.boardId
                 ?? jobVM?.currentBoardId
                 ?? job.boards.first?.id

var circuitIdx = job.circuits.firstIndex {
  $0.circuitRef == circuitRef && $0.boardId == targetBoardId
}
```

When iOS creates a missing circuit (line ~3689), `newCircuit.boardId = targetBoardId` (not `defaultBoardId`).

The symmetric path that also pins to `boards.first` is the second copy at lines ~4855-4907 (`applySonnetReadings` reassigned-readings call site OR a sibling helper — verify exact name with grep before editing). Apply the same fix there.

For the iOS delete-circuit path (`applyCircuitUpdates` driven by the legacy-shape `circuit_updates` slot post-shadow-harness): when the update carries `board_id`, route the deletion to that board; when nil, fall back to the same priority chain.

**Board-level fields also hardcode `boards[0]` and need fixing in this slice.** The iOS apply switch has multiple branches that write to `job.boards[0]` directly:

- `applySonnetReadings` line ~4291: `job.boards[0].zeAtDb = normalised` for the `case "ze_at_db", "zs_at_db"` branch.
- `applyRegexValue` line ~3386: `job.boards[0].zeAtDb = v` for the regex-driven board-level write.
- **Sonnet correction path** lines ~5616, ~5727 (per Codex's grep): correction edits also write to `job.boards[0]` for board-level fields. These don't go through `applySonnetReadings` — they're triggered by `field_corrected` Stage 6 events. Each branch must use the same `boardIndex(for:)` helper.
- Likely siblings for board-level fields like `ipf`, `manufacturer`, `mainSwitchBsEn`, `ratedCurrent`, `spdType` (audit needed — grep `job.boards\[0\]` for the full list across `Sources/**/*.swift`).

Each of these reaches iOS via the shadow-harness fold of `extracted_board_readings` (synthesised as a reading with `circuit: 0`). Today the fold strips `board_id`; slice 1.1b restores it on the wire; slice 1.3 must use it on apply. Replace `job.boards[0]` with a helper:

```swift
private func boardIndex(for boardId: String?) -> Int? {
    let target = boardId ?? jobVM?.currentBoardId ?? job.boards.first?.id
    return job.boards.firstIndex(where: { $0.id == target })
}
```

Use everywhere `boards[0]` is currently hardcoded for a Sonnet-driven write. Skip read-only display paths (LiveFillView etc — that's slice 5).

Actor-boundary note: `applySonnetReadings` is called from a MainActor-hopped delegate callback (`serverDidReceiveExtraction` is `nonisolated` but immediately wraps in `Task { @MainActor in }`). Both the VM's `job.circuits` write and the `jobVM.currentBoardId` read happen on the main actor — safe. Same access pattern Phase E already uses for `serverDidReceiveCurrentBoardChanged`. No new sendability concerns.

### 1.4 iOS `buildJobStateForServer` carries hierarchy fields

**File:** `Sources/Recording/DeepgramRecordingViewModel.swift` (~line 6011-6023)

Add the missing fields to each board entry. **Swift `[String: Any]` does NOT skip nil values** — assigning `b["x"] = optional` where the optional is nil stores `NSNull`/`Optional.none`, which JSONSerialization either crashes on or serialises as `null`. Both are wrong: backend `_seedStateFromJobState` expects either the field present-with-value or absent (it spreads `{...b}` then reads `b.board_type` directly).

Use explicit `if let` for every optional:
```swift
if let v = board.designation { b["designation"] = v }
if let v = board.boardType?.rawValue { b["board_type"] = v }
if let v = board.parentBoardId { b["parent_board_id"] = v }
if let v = board.feedCircuitRef { b["feed_circuit_ref"] = v }
```

Use the **snake_case** keys the backend's `_seedStateFromJobState` already reads. Verify by grepping the seeder (`src/extraction/eicr-extraction-session.js:_seedStateFromJobState`) for the exact field names it consumes — the spread copies whatever key the iOS sender used.

Also: ensure the FIRST element of the boards array is the main board (board_type === 'main' or first-added-default). iOS `JobDetail.boards` insertion order matters since backend's `getMainBoardId` falls through to `boards[0]?.id` when no explicit `main` is found. Verify iOS preserves order on add via the BoardInfo.append path; if not, add a stable `sortByBoardType` step in `buildJobStateForServer`.

Add a serialization test that asserts the produced `[String: Any]` round-trips through `JSONSerialization` cleanly with a sub-board carrying nil hierarchy fields and a main board with non-nil fields.

### 1.5 Tests

Backend bundler (`src/__tests__/stage6-event-bundler.test.js`):
- `extracted_readings entries carry board_id when dispatcher wrote with explicit boardId`
- `extracted_readings.board_id is omitted when boardId was null/undefined (single-board session)`
- `extracted_board_readings carries board_id`
- `circuit_updates carries board_id`
- **Per-turn collision regression**: `same circuit ref, same field, written on main AND sub-1 in one turn — both survive into extracted_readings with distinct board_id`

Backend dispatchers (`src/__tests__/stage6-dispatchers-circuit.test.js`):
- `record_reading on sub-1 emits boardId on the bundled reading`
- `record_reading on main emits boardId == mainBoardId` (or null if conventions decide null = main)

Backend shadow-harness (`src/__tests__/stage6-shadow-harness.test.js` — extend or create):
- `extracted_board_readings fold preserves board_id on the synthesised circuit:0 reading`
- `circuit_updates create/rename fold preserves board_id on each synthesised reading`
- `legacyShapeDeletes carries board_id`
- **End-to-end EEB8F9EA wire-shape regression**: 2-board fixture, simulate Sonnet `record_reading(circuit:1)` while `currentBoardId == 'sub-1'`, run through bundler + shadow-harness, assert final iOS-bound payload's `extracted_readings[0].board_id === 'sub-1'`.

Backend session seeder (`src/__tests__/eicr-extraction-session.test.js` or similar):
- `iOS PUT with multi-board state hydrates boards[].board_type and getMainBoardId resolves correctly`
- `iOS PUT with main NOT first in array still resolves correctly via board_type === 'main'` (regression for the "boards reordered" risk)

iOS apply path (`Tests/CertMateUnifiedTests/Recording/DeepgramRecordingViewModelTests.swift` — new file or extend):
- Branch 1: `applySonnetReadings routes to sub-board when reading.boardId == sub-1` (server told us)
- Branch 2: `applySonnetReadings falls back to jobVM.currentBoardId when reading.boardId == nil`
- **Branch 3: `applySonnetReadings falls back to boards.first?.id when both reading.boardId AND jobVM.currentBoardId are nil`** (legacy single-board mode)
- **Edge case: `applySonnetReadings handles reading.boardId pointing to non-existent board (debug-log + drop OR fall back to currentBoardId — pick one and test it)`**
- Circuit-creation path: `applySonnetReadings creates new circuit with boardId == targetBoardId, NOT defaultBoardId`
- Delete path: `applyCircuitUpdates routes delete to reading.boardId when present`
- **EEB8F9EA round-trip regression**: 2-board fixture, simulate the full Sonnet reading-on-sub-1 flow, verify main's circuit 1 byte-identical.

iOS Codable (`Tests/CertMateUnifiedTests/Services/ClaudeServiceTests.swift`):
- `ExtractedReading decodes board_id` + `tolerates missing board_id`
- `CircuitUpdate decodes board_id` + `tolerates missing board_id`

iOS jobState builder (`Tests/CertMateUnifiedTests/Recording/DeepgramRecordingViewModelTests.swift` or extend):
- `buildJobStateForServer emits board_type, designation, parent_board_id, feed_circuit_ref when present`
- `buildJobStateForServer omits the keys (NOT NSNull) when the BoardInfo fields are nil`
- `buildJobStateForServer output round-trips through JSONSerialization without throwing`

### 1.6 Acceptance

Replay the 2-board scenario end-to-end (in a fixture session, not a live one):
- Job: main with circuits 1-13 + sub-1 with circuit 1.
- Inspector says "work on garage" → server flips, iOS banner moves to main.
- Sonnet: `record_reading` on circuit 1, no explicit board_id → backend writes to `circuits['sub-1::1']`. Bundler emits `{circuit: 1, board_id: 'sub-1', …}`. iOS receives, finds `job.circuits` entry where `boardId == 'sub-1' && circuitRef == "1"`, writes the value there. Main's circuit 1 is byte-identical to before.

---

## Slice 2 — Broadcast completeness (BLOCKER #2 + IMPORTANTs #7, #8)

Phase E set up the unified broadcast but missed three codepaths that flip `currentBoardId` without going through `case 'select_board'` or `dispatchSelectBoard`'s explicit boardOps push.

### 2.1 Widen `emitCurrentBoardChangedFromBoardOps` to fire on `add_board`

**File:** `src/extraction/sonnet-stream.js` (helper added in commit `38fbce0`).

Today: `if (op.op !== 'select_board') continue`.

**Change:** `if (op.op !== 'select_board' && op.op !== 'add_board') continue`. The boardOps `add_board` payload already carries `board_id` and `designation` (`stage6-dispatchers-board.js:373-378`), so the helper needs no new lookups — just add `'add_board'` to the discriminator allow-list. Source field gets a sub-discriminator: `source: 'sonnet_add'` vs `source: 'sonnet'` so logs / future analytics can tell add-board flips apart from select-board flips.

(Alternative considered: have `dispatchAddBoard` also push a `select_board` op — rejected because that breaks the boardOps shape's "one op per tool call" invariant.)

### 2.2 `flushPendingExtractions` runs the same broadcast scan

**File:** `src/extraction/sonnet-stream.js` (~line 2848-2858).

Today: each buffered extraction is sent verbatim with no broadcast scan.

**Change:** after `ws.send(JSON.stringify({type: 'extraction', result: …}))`, call `emitCurrentBoardChangedFromBoardOps(ws, entry.session.stateSnapshot, result.board_ops)`. Designation lookup is correct: the snapshot at flush time IS the post-flip snapshot, so designations are available.

### 2.3 Initial broadcast on session_start AND session_resumed

**File:** `src/extraction/sonnet-stream.js`.

After `_seedStateFromJobState` resets `currentBoardId` (Q0.1 lock — always main on fresh session), emit one `current_board_changed` with `source: 'session_start'`. Same for the reconnect branch (~line 2174) — emit with `source: 'session_resume'` carrying the preserved `currentBoardId`.

iOS consumes via the same delegate path it already has — no iOS changes needed.

### 2.4 Tests

Backend (`src/__tests__/sonnet-stream-select-board.test.js` extension):
- `add_board op in boardOps fires current_board_changed (source=sonnet_add)`
- `flushPendingExtractions on reconnect re-fires current_board_changed for any select_board / add_board op in buffered results`
- `flushPendingExtractions on reconnect with buffered add_board fires current_board_changed AFTER the buffered extraction envelope` (ordering matters for iOS — extraction landing before broadcast = banner-flips-then-rows-update which is fine; broadcast before extraction = banner-on-empty-board which is briefly confusing)
- `session_start emits initial current_board_changed AFTER the session_started ack` (ordering pin so iOS WS dispatch is in steady state when the broadcast arrives)
- `session_resumed (reconnect branch) emits initial current_board_changed with preserved currentBoardId AFTER the session_resumed ack`
- `session_start with currentBoardId == null in jobState (fresh job) emits the initial broadcast with the resolved main board id, NOT null`

### 2.5 Acceptance

CloudWatch query: every session that adds a sub-board has a `current_board_changed` log row with the new board id between the `add_board` log and the next `record_reading`.

---

## Slice 3 — Validation ordering + ack failure handler (IMPORTANTs #4, #6)

Two contract bugs Sonnet (#4) and the inspector (#6) currently see.

### 3.1 `validateBoardScope` runs first

**File:** `src/extraction/stage6-dispatchers-circuit.js` (lines 103-105, 195-197, 274-276; and the equivalent calls in `record_board_reading` / `delete_circuit` if they share the pattern — verify with grep).

Swap `validateRecordReading || validateBoardScope` to `validateBoardScope || validateRecordReading`. Same for `clear_reading`, `create_circuit`, `rename_circuit`, `delete_circuit`, `record_board_reading`.

(Question for Codex: are there existing tests pinning the OLD ordering, e.g. tests that assert `circuit_not_found` on a cross-board write to a non-existent circuit? Those tests need to flip to `wrong_board`.)

### 3.2 iOS `serverDidReceiveSelectBoardAck` reconciles `ok=false`

**File:** `Sources/Recording/DeepgramRecordingViewModel.swift`.

Add an override for `serverDidReceiveSelectBoardAck(_:)`:
- `ok == true`: log only — Phase E's `current_board_changed` has already moved the UI.
- `ok == false`: TTS the failure ("That board isn't available — please try a different name" / "No active session — please start recording first" depending on `ack.error`). Optionally roll back any optimistic local state — today there is no local flip, so the rollback is "speak the error".

### 3.3 Tests

Backend:
- For each affected dispatcher: `record_reading({circuit: 99, board_id: 'sub-1'})` while `currentBoardId == 'main'` and circuit 99 doesn't exist → returns `wrong_board`, NOT `circuit_not_found`.

iOS (`Tests/CertMateUnifiedTests/Recording/DeepgramRecordingViewModelTests.swift`):
- `serverDidReceiveSelectBoardAck(ok=false, error=board_not_found) speaks the error`.
- `serverDidReceiveSelectBoardAck(ok=true) does NOT speak (Phase E already updated UI)`.

### 3.4 Acceptance

Sonnet that calls `record_reading(circuit:1, board_id: 'sub-1')` while on main gets `wrong_board` and follows the prompt rule to call `select_board` first. Inspector saying "work on shed" (no shed exists) hears "That board isn't on this job" instead of being lied to about the switch.

---

## Slice 4 — Dialogue-engine dual-shape rollout (IMPORTANT #3)

Three sites in dialogue-engine still walk `snapshot.circuits` directly. Composite-key buckets are invisible.

### 4.1 Files to edit

**File:** `src/extraction/dialogue-engine/helpers/circuit-resolution.js`

- Designation matcher (line ~80-100): replace `Object.entries(snapshot.circuits)` walk + `Number.isInteger(ref)` filter with calls to `listCircuitRefsInBoard(snapshot, snapshot.currentBoardId)` + per-ref `getCircuitBucket(snapshot, ref, snapshot.currentBoardId)`.
- Field reader (line ~146-160): replace `circuits[circuit_ref] || circuits[String(circuit_ref)]` with `getCircuitBucket(snapshot, circuit_ref, snapshot.currentBoardId)`.

**File:** `src/extraction/dialogue-engine/engine.js` (line ~1245-1250)

Same fix — replace direct access with `circuitExistsInSnapshot(snapshot, circuit_ref, snapshot.currentBoardId)`.

### 4.2 Audit pass

Grep the entire backend for `snapshot.circuits[` and `stateSnapshot.circuits[` direct accesses. List every hit and either justify it (it's legacy supply at index 0) or convert to a helper call.

### 4.3 Tests

`src/__tests__/dialogue-engine-circuit-resolution.test.js` (extend if exists, else new):
- Designation match resolves `"shower circuit"` to sub-1's circuit when `currentBoardId == 'sub-1'`.
- Designation match returns no match for "shower" when only main has it and `currentBoardId == 'sub-1'`.
- Field reader returns sub-1's value when `currentBoardId == 'sub-1'`.

### 4.4 Acceptance

Dialogue engine resolves designations correctly when inspector is on a sub-board. No production paths still call `snapshot.circuits[ref]` for a circuit lookup.

---

## Slice 5 — LiveFillView active-board consumer (NIT #9)

**File:** `Sources/Views/Recording/LiveFillView.swift` (~line 691, plus the supply-line section at ~389).

Replace `job?.boards.first` with the active board:
```swift
let activeBoardId = jobVM?.currentBoardId ?? job?.boards.first?.id
let board = job?.boards.first(where: { $0.id == activeBoardId }) ?? job?.boards.first
```

Reorder rest of the view so the supply line + Ze@DB display the active board's data. If the active board is a sub-board with no separate supply (most installations), fall back to the parent board's supply or show "—" (TBD by Derek's preference).

(This is mostly a SwiftUI plumbing exercise. Risk: the LiveFillView's existing tests / snapshots might lock the "boards.first" assumption — check before editing.)

### 5.1 Tests

`Tests/CertMateUnifiedTests/Views/LiveFillViewTests.swift` (if exists):
- `landscape supply line shows active board's Ze when currentBoardId flips`.

### 5.2 Acceptance

Inspector switches to sub-1; the LiveFillView landscape header card shows sub-1's BoardInfo + (parent's) supply rather than main's.

---

## Slice 6 — Field-test verification (NIT #10)

Manual. Build a TestFlight from the slice-5-shipped `main`, run a real 2-board recording session, watch:

- Banner placement on iPad in landscape with 2 boards (Codex and I both flagged this is untested).
- Banner copy at typical designation lengths ("DB-1", "Garage", "Kitchen Annexe", "DB-3 (Garden Office Outbuilding)").
- Voice command latency end-to-end ≤ 200ms (Phase C target was 50ms in unit-test, untested live).
- `current_board_changed` log rows in CloudWatch match every observed banner flip.
- Round-trip data correctness: at the iOS UI layer, `job.circuits` entry where `boardId == 'main' && circuitRef == "1"` reads byte-identical to its pre-recording value when all readings were dictated while focused on sub-1. (Equivalent backend assertion: `snapshot.circuits[1]` legacy bucket unchanged; new readings live at `snapshot.circuits['sub-1::1']`.)

Document failures + open follow-up issues for any UX wrinkles.

---

## In scope but separately tracked: AudioImportViewModel

`Sources/ViewModels/AudioImportViewModel.swift` has the same `boards[0]` / `boards.first` assumptions (lines ~282, ~318, ~638 per Codex's grep) for the offline-audio-import flow. That flow is the secondary path: inspector records audio offline, replays it later through the same Sonnet extraction pipeline.

**Decision:** add as **Slice 1.3b**. Same fix pattern as the live recording VM — replace `boards[0]` and `boards.first` with the `boardIndex(for:)` helper, threading `reading.boardId` through. Tests parallel slice 1.5's iOS apply-path tests.

If the slice 1 estimate inflates beyond 1.5 sessions, defer 1.3b to a follow-up; flag the offline-import path as a known-bug-but-rarely-hit pre-fix in the field-test debrief.

---

## Out of scope (deliberately deferred)

- **Phase 5.6** — retire `circuits[0]` legacy bucket. The dual-shape storage is the foot-gun, but the slice-1 fix doesn't require retiring the legacy half. Track separately.
- **Web frontend** — `web/` isn't multi-board-aware. Out of scope here. Wire is **safe-decode but no board-scoped apply**: web ignores the new `board_id` field and routes by circuit ref alone, matching its pre-hotfix behaviour. CSV export already carries `board_id` per Phase 2a. A web-side multi-board apply path is a separate workstream.
- **Auto-routing cross-board readings** — explicitly Q0.4-rejected on the original sprint. Sonnet must call `select_board` first.
- **Phase F deprecation of `select_board_ack` success arm** — keep both arms until the failure handler in slice 3.2 is field-tested.
- **Multi-board > 2 boards** — test fixtures all use 2 boards. Slice 1.5 will add a 3-board fixture if convenient, otherwise documented as a future test gap.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Slice 1 wire shape change breaks an older iOS client mid-deploy | `board_id` is OMITTED on single-board sessions (back-compat); pre-fix iOS clients ignore unknown keys. New iOS reads with `decodeIfPresent`. |
| Slice 1's `applySonnetReadings` change introduces a subtle null-handling bug (boardId == nil falls through 3 levels) | Test the resolution priority explicitly (3 unit tests, one per branch); add a debug log when level-3 fallback fires so single-board mode is visible in CloudWatch. |
| Slice 2.1 add_board broadcast double-fires on `add_board` followed by Sonnet `select_board` (Sonnet might do both in one turn) | Idempotent on iOS — `jobVM.currentBoardId = sameValue` is a no-op @Observable write, no SwiftUI re-render. Test exists for this in Phase E suite. |
| Slice 2.3 initial broadcast on session_start fires BEFORE iOS finishes its session_start handshake | Order: backend already responds to `session_start` with `session_started` ack; emit `current_board_changed` AFTER that ack so iOS's WS dispatch is in steady state. **Tests pin this ordering (slice 2.4).** |
| Slice 4 grep audit misses a direct access tucked into a less-trafficked path (e.g. PDF builder) | Search includes `web/` + `frontend/` + `python/`; flag any non-circuit-related read as low-risk and document. |
| Slice 5 breaks LiveFillView's existing snapshot tests | Run the tests before editing; refactor the test fixtures to use a 2-board snapshot and assert active-board-driven content. |
| Slice 6 reveals a UX bug we can't fix in this sprint | Document and ship; the data-correctness fixes from slices 1-2 are the gate, not banner polish. |
| **Mixed-version client during rollout** — backend ships slice 1 first; pre-hotfix iOS in production decodes `extracted_readings` ignoring `board_id`, applies by ref-only (today's broken behaviour) | **Not a regression — pre-hotfix iOS already routes by ref-only.** Backend forward-tolerant with omitted board_id (new iOS uses currentBoardId fallback). Order: backend deploys first; iOS TestFlight build second; once iOS users update, full correctness reached. Document the rollout window in the field-test debrief. |
| **In-flight sessions during deploy** — a recording session active at the moment of backend deploy has buffered `extracted_readings` in its emit queue; mid-deploy buffer carries shape A, post-deploy emits carry shape B | iOS uses `decodeIfPresent` on `board_id`, so both shapes decode. The bug is iOS APPLYING shape A correctly — it can't, because shape A doesn't carry the field. **Mitigation: avoid deploying during active inspections** (CI deploy is push-triggered; coordinate with Derek's recording schedule). No code-level fix possible without longer rollout windows. |
| **Web frontend won't honour the new wire shape** | `web/` decodes `extracted_readings` and applies by circuit-ref alone (same as iOS pre-hotfix). Adding `board_id` to web's apply path is a separate workstream. Document that web is single-board until further notice; backend's omitted-board_id back-compat keeps web working. |
| **iOS BoardInfo serialization order vs backend `getMainBoardId`** — if iOS sends boards in any order other than main-first AND board_type is missing, backend resolves the wrong board as main (composite/legacy keys invert) | Slice 1.4 sends `board_type` explicitly, which short-circuits the order-dependent fallback. Tests pin this with both "main first" and "main NOT first" fixtures. |
| **`set_field_for_all_circuits('*')` cross-board sweep + per-turn key collision** | Slice 1.1c includes `boardId` in the Map key. Regression test in slice 1.5 covers this. |

---

## Rollout

Single CI deploy after slices 1-2-3 land on `main` (the hotfix gate). Slices 4-6 can ship in a follow-up CI deploy if not already on main when the gate ships.

iOS: separate commit per slice on CertMateUnified. Push when slice 3 lands so a TestFlight build can roll afterwards.

Slice 6 (field test) is the GATE for declaring the sprint done. Until field test confirms slice 1's round-trip works, treat the data layer as untested in production.

---

## Implementation order in a fresh session

1. Read this PLAN.md.
2. Read the parent sprint's PLAN.md + the per-phase shipped handoffs (cross-references at end).
3. Verify base commits: backend `4973d05`, iOS `0849da1`.
4. Slice 1 first — backend + iOS atomically (one backend commit + one iOS commit, paired).
5. Run backend full suite + iOS Mac Catalyst tests after each slice.
6. After slice 3, push backend (CI) + iOS, watch CI green, then slice 4 onwards.
7. After slice 5, build TestFlight and proceed to slice 6.

---

## Cross-references

- Parent sprint plan: `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/PLAN.md`
- Phase A handoff: `handoff_2026-05-08_work-on-board-phase-a-shipped.md`
- Phase B handoff: `handoff_2026-05-08_work-on-board-phase-b-shipped.md`
- Phase C handoff: `handoff_2026-05-08_work-on-board-phase-c-shipped.md`
- Phase D + E handoff: `handoff_2026-05-08_work-on-board-phase-d-e-shipped.md`
- Multi-board parent sprint: `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/HANDOFF.md`
- Phase 5 deferred plan: `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PHASE5_HANDOFF.md`
