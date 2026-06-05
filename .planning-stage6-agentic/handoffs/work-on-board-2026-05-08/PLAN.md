# "Work on [Board]" — Single-Board-Focus Workflow

**Author:** Claude (drafted 2026-05-08 after the EEB8F9EA field test)
**Status:** Phase 0 decisions LOCKED 2026-05-08. Ready to start Phase A.
**Effort estimate:** 3-4 sessions (~6-9 hours), shippable in two increments — Phase A+B (server-side correctness) then Phase C+D+E (iOS UX gate).
**Depends on:** commit `27a1b94` (`fix(stage6): add_board accepts legacy keyed-snapshot circuits`) — already on `main`. That patch unblocks `add_board` for legacy snapshots; this plan handles everything that comes _after_ a sub-board exists.
**Risk class:** **Medium** — touches Stage 6 storage and the iOS recording UI, but each phase is independently testable.

---

## Goal

After today's `add_board` fix, the inspector can create a sub-board mid-recording. They cannot _safely use it_:

- The storage layer is flat-keyed, so dictating "circuit 1" while focused on `sub-1` clobbers main's circuit 1.
- The model has no concept of "the inspector is currently focused on board X" — every reading is global.
- The iOS UI doesn't show which board is active, so the inspector can't tell where dictation will land.

Goal of this sprint: **make the inspector's spoken focus the single source of truth.** While "working on" a board, every reading lands there; other boards are visually muted with a red banner; the inspector says "Work on \[designation]" to switch.

---

## Locked decisions (2026-05-08)

| Q | Decision |
|---|---|
| **0.1** Default board on session start | **Always main.** Don't restore last-active. |
| **0.2** Banner placement | **Overview landscape cards AND CircuitsTab section headers.** Both surfaces signal off-board. |
| **0.3** Fuzzy match for "Work on X" | **Yes — substring contains, longest match wins.** "Garage" matches "DB-2 (Garage)"; if both "Garage" and "Garage Annex" exist, pick whichever has the longer overlap with the spoken phrase. |
| **0.4** Cross-board readings | **No auto-route, no clarifying prompt.** All writes go to `currentBoardId`. If circuit ref doesn't exist on the active board, create it. Inspector is responsible for switching boards before dictating cross-board. |

These match the user's explicit framing: "treat it like you were the main board, create the circuit. If the user wants to give a reading for the other board they will have to switch over first."

---

## Phase order

| # | Phase | Layer | Risk | Estimate | Ships |
|---|---|---|---|---|---|
| **A** | Dual-shape storage — main legacy, subs composite | Backend (Stage 6) | Medium | 1 session | After A: sub-board readings persist without clobbering main |
| **B** | Server strict `currentBoardId` scoping + system prompt rule | Backend (Stage 6) | Low | 0.5 session | After B: model can't accidentally write cross-board |
| **C** | iOS voice command "Work on X" → `select_board` | iOS | Low | 1 session | After C: inspector can switch boards by voice |
| **D** | iOS red-banner UI on off-boards | iOS | Low | 0.5 session | After D: inspector sees which board is live |
| **E** | Backend → iOS WS broadcast `current_board_changed` | Backend + iOS | Low | 0.5 session | After E: banner flips reactively |

**Total: 3-4 sessions.** Phase A+B is a backend-only deploy and self-sufficient — sub-boards become storage-safe without any iOS work. Phase C+D+E is the inspector-facing UX gate.

---

## Why dual-shape, not full Phase 5 re-key

The 2026-05-07 multi-board sprint queued a full Phase 5 widening (composite keys for **every** circuit, retire `circuits[0]` legacy bucket entirely — see `../multi-board-support-2026-05-07/PHASE5_HANDOFF.md`). It's the architecturally clean answer but a 2-3 session sweep across 6+ files entrenched on `circuits[0]`.

This plan takes the smaller path:

- **Main board stays at legacy bare-numeric keys** (`circuits[1]`, `circuits[11]`, …). Every existing reader in the codebase keeps working.
- **Non-main boards use composite keys** (`circuits['sub-1::1']`, `circuits['sub-1::5']`, …). Buckets self-identify with `bucket.board_id` so the validator and serialiser can attribute them.
- **Iteration safety**: existing iterators that do `Number(key)` and filter `Number.isInteger(n) && n >= 1` (the dominant pattern) naturally skip composite keys — they don't accidentally pull sub-board circuits into main-board operations.

Tradeoff: dual-shape storage is a known foot-gun. Any future iterator must know about both shapes. We mitigate this by funnelling every read through the existing `getCircuitBucket` / `circuitExistsInSnapshot` / `listCircuitRefsInBoard` helpers (already in `stage6-multi-board-shape.js`) and removing all direct `snapshot.circuits[ref]` reads. The Phase 5 plan from 2026-05-07 can land later as a clean-up that retires the legacy half once dual-shape has soaked.

---

## Phase A — Dual-shape storage (composite keys for non-main boards)

### Files to edit

**`src/extraction/stage6-multi-board-shape.js`**

The flag-aware helpers already have flag-on (composite) and flag-off (legacy) branches. Today both branches are reachable via `STAGE6_MULTI_BOARD`. Replace the flag-on/off check with a per-call decision: **composite when `boardId` is supplied AND it's not the main board id; legacy otherwise.**

- `circuitExistsInSnapshot(snapshot, circuit, boardId)` — drop the `isMultiBoardFlagOn()` gate. Resolve `boardId` (default to `currentBoardId` then `'main'`). If the resolved id is the main board, check `circuit in snapshot.circuits`. Otherwise check `\`${id}::${circuit}\` in snapshot.circuits`.
- `getCircuitBucket(snapshot, ref, boardId)` — same rule.
- `listCircuitRefsInBoard(snapshot, boardId)` — same rule. Legacy path filters numeric keys; composite path scans values for `bucket.board_id === id`.

The `STAGE6_MULTI_BOARD` env flag becomes unused. Leave it readable for one deploy cycle for safety, then delete.

**`src/extraction/stage6-snapshot-mutators.js`**

- `upsertCircuitMeta` — accept a `boardId` arg. If non-main, write to `snapshot.circuits[\`${boardId}::${circuit_ref}\`]` and stamp `bucket.board_id = boardId`. Else legacy path.
- `applyReadingToSnapshot` (or whichever the record_reading mutator is) — same boardId arg + same routing.
- `renameCircuit` — preserve scope on rename: a `from_ref` on a sub board renames the composite bucket, not the legacy bucket.
- `clearReading` — same routing rule.
- Drop the `applyXxxFlagAware` wrappers (the flag is dead). Inline the boardId routing into the canonical mutator.

Identify the "main board id" by reading `snapshot.boards[]` and finding the first board with `board_type === 'main'` or `board_type` unset. Helper: `getMainBoardId(snapshot)` in `stage6-multi-board-shape.js`. Cached on snapshot construction since `boards[0]` rarely changes.

**`src/extraction/eicr-extraction-session.js` `_seedStateFromJobState` (line 1077)**

Today writes `this.stateSnapshot.circuits[num] = { ...fields }` for every legacy circuit. Add: stamp `fields.board_id = mainBoardId` on every bucket. Backwards-compatible — the existing patch (commit `27a1b94`) already accepts circuits with no `board_id` when the parent is main, so this is belt-and-braces. After this change every bucket self-identifies.

For circuits coming in from a multi-board iOS PUT (where each circuit already has `board_id`): if `board_id !== mainBoardId`, write the bucket at the composite key `${board_id}::${num}` instead of bare `circuits[num]`.

**`src/extraction/stage6-dispatchers-circuit.js` (createCircuit, recordReading, clearReading, renameCircuit)**

Each dispatcher's input schema already accepts `board_id` (added in Phase 6.1). They currently pass it to validators but the writers don't honour it under flag-off. After Phase A's mutator changes, just remove the flag-aware indirection and pass `board_id` straight through.

If `input.board_id` is omitted, default to `session.stateSnapshot.currentBoardId`. Phase B will tighten this further.

**`src/extraction/stage6-dispatchers-board.js` `dispatchAddBoard`**

Already adapts the snapshot for the validator (commit `27a1b94`). After Phase A, every bucket should self-identify natively, so the adapter becomes a no-op — but leave it in for legacy-snapshot tolerance during migration. Remove the adapter once no production session has a pre-Phase-A snapshot in flight.

**Wire emission — `src/extraction/stage6-event-bundler.js`**

Per-turn writes (`circuitReadings`, `circuitOps`, `boardReadings`) need to carry `board_id`. The bundler currently emits `{circuit_ref, field, value, ...}`; extend to `{circuit_ref, board_id, field, value, ...}`. iOS already understands board_id on `boardOps` (Phase 6.0); extend the readings/ops decoders symmetrically (see iOS file list in Phase C).

### Tests

- `stage6-multi-board-shape.test.js` — add cases for the per-call resolution: same circuit ref on main vs sub stays in separate buckets; iteration over `listCircuitRefsInBoard('sub-1')` returns only sub-1's refs.
- `stage6-snapshot-mutators.test.js` — same circuit ref written twice with different boardIds produces two buckets; rename within sub-1 doesn't touch main's bucket of the same ref.
- `stage6-dispatchers-circuit.test.js` — `create_circuit({circuit_ref: 1, board_id: 'sub-1'})` succeeds even though `circuits[1]` already exists (main).
- New regression test replaying the EEB8F9EA shape: legacy main with circuits[1..13], add_board → write 5 readings on sub-1 → verify main's circuits 1..13 untouched.
- Full backend suite must stay green (3161+ tests).

### Acceptance

The EEB8F9EA scenario replayed end-to-end: inspector says "moving on to sub-board, garage fed from circuit 11", Sonnet calls `add_board`, then dictates 3 readings for sub-board circuit 1. After session close: main's circuit 1 is byte-identical to before; `extracted_data.json` carries both main's 11 circuits AND sub-1's 1 circuit; PUT /api/job round-trips without hierarchy errors.

---

## Phase B — Server strict `currentBoardId` scoping

After Phase A, writes _can_ be board-scoped. This phase makes scoping the **only** behaviour: writes implicitly go to `currentBoardId`, and Sonnet supplying a different `board_id` is rejected.

### Files to edit

**`src/extraction/stage6-dispatchers-circuit.js`**

For `record_reading`, `create_circuit`, `clear_reading`, `rename_circuit`:
- If `input.board_id` is omitted, set it to `session.stateSnapshot.currentBoardId` (already the Phase A default).
- If `input.board_id` is supplied AND `!== currentBoardId`, reject with `{code: 'wrong_board', field: 'board_id', expected: currentBoardId, got: input.board_id}`. Tells Sonnet to call `select_board` first.

**`src/extraction/stage6-dispatchers-board.js` `dispatchRecordBoardReading`**

Same rule for board-level readings (manufacturer, supply Ze, etc.) — `currentBoardId` is the only writable target.

**System prompt — `src/extraction/sonnet-stage6-system-prompt.md` (or wherever the prompt lives)**

Add an explicit rule near the top:

> ## Single-board focus
>
> The inspector is always working on exactly one board at a time. Every reading you record lands on `currentBoardId`. Do NOT supply a `board_id` argument to record_reading / create_circuit / record_board_reading — the server scopes implicitly. To switch boards, call `select_board(board_id: 'sub-X')`. The inspector will say "Work on \[designation]" or similar; map the designation to the board id you saw in `boardOps` events.

Drop any prior prompt language that suggests `board_id` is freely settable per call.

### Tests

- `stage6-dispatchers-circuit.test.js` — `record_reading({circuit:1, board_id: 'sub-1'})` while `currentBoardId === 'main'` → rejected `wrong_board`.
- `record_reading({circuit:1})` (no board_id) while `currentBoardId === 'sub-1'` → writes to sub-1's bucket.
- `select_board(board_id: 'sub-1')` → flips `currentBoardId`, subsequent writes go to sub-1.
- Cassette/integration test replaying a switch flow: 3 readings on main, `select_board sub-1`, 3 readings on sub-1, `select_board main`, 1 more reading on main. Verify final snapshot.

### Acceptance

Sonnet calling `record_reading` with an explicit cross-board `board_id` gets rejected and forced through `select_board`. Inspector dictation routes purely via `currentBoardId`.

---

## Phase C — iOS voice command "Work on X"

### Files to edit

**`Sources/Processing/TranscriptFieldMatcher.swift`** (or a new sibling file `BoardSwitchCommand.swift` — TBD by what fits the existing detector pattern)

Add a deterministic regex pass on every confirmed transcript:

```swift
// Loose pattern — accepts "work on X", "working on X", "now on X",
// "switch to X", "switching to X". Stops at filler tail words
// ("please", "now", "board", "CU", "consumer unit").
let pattern = #"^(?:(?:could you )?(?:please )?(?:now )?(?:work(?:ing)? on|switch(?:ing)? to)) (?:the )?(.+?)(?:\s+(?:please|now|board|CU|consumer unit|fuse box))?[\.,!?]?$"#
```

When a match is found, take the captured phrase and run a **substring contains, longest-match** lookup against `job.boards.map { $0.designation ?? "" }`:

1. Lowercase + strip punctuation on both sides.
2. For each board, count the longest contiguous overlap between the spoken phrase and the designation.
3. If exactly one board ties for longest with overlap ≥ 3 chars → match.
4. Ambiguous (two boards with equal longest overlap) → TTS clarification: *"Did you mean DB-1 or DB-2?"*; do not switch yet.
5. No match → silent drop (let normal extraction proceed).

On match: emit a `select_board` event over the existing ServerWebSocketService channel. Backend dispatches the existing `select_board` Stage 6 tool (skip the round-trip through Sonnet).

The fuzzy logic should also include the board's `boardType.localizedDescription` if non-trivial (e.g. "the garage sub-main") — TBD by what designations actually look like in field jobs.

### Voice-command suppression

The "work on …" transcript MUST NOT be passed to Sonnet for normal extraction (it's a control command, not a reading). Strip it from the transcript before forwarding to `ServerWebSocketService.sendTranscript()`. Mirrors how existing iOS-side commands (e.g. observation triggers) are consumed before reaching the model.

### Tests

- `TranscriptFieldMatcherTests.swift` — happy paths: "work on DB-1", "work on the garage", "switch to DB-2 please".
- Filler-word tail strip: "work on DB-1 board now" → designation "DB-1".
- Ambiguity: two boards "Kitchen Annexe" / "Kitchen", spoken "kitchen" → ambiguity branch (no switch).
- No match: "circuit 11 is 0.21 ohms" → no command fire, transcript passes through.

### Acceptance

Inspector says "work on the garage", iOS detects, switches `currentBoardId` server-side via `select_board`, the transcript is suppressed from Sonnet. Round-trip ≤ 200 ms.

---

## Phase D — iOS red-banner UI on off-boards

### Files to edit

**`Sources/Views/JobDetail/OverviewTab.swift`** — landscape board cards

For every board card whose `id != currentBoardId`:
- Render a red banner overlay across the top of the card.
- Copy: `"Not currently being worked on — say "Work on \(designation)" to continue"`.
- Mute the card content: 50% opacity on body, slight grayscale on photo thumbnails.
- The active board's card stays full-colour, no banner.

**`Sources/Views/JobDetail/CircuitsTab.swift`** — section headers when scrolling through multiple boards

Each board's section in the CircuitsTab gets the same banner above its rows when `id != currentBoardId`. The active board's rows are editable; off-board rows are visually muted (read-only is enforced server-side already by Phase B, but iOS should also disable the input fields to prevent silent-drop confusion).

### Where does iOS know `currentBoardId`?

Today: nowhere. The Stage 6 dispatcher tracks it server-side, but iOS doesn't see it. Phase E adds the WS broadcast. Until E ships, this phase can poll `JobDetail.currentBoardId` from job state — but cleanest is to wire D after E.

**Recommendation: ship D and E together as one PR.** D depends on E for reactivity.

### Tests

- `OverviewTabTests.swift` — snapshot test: a 2-board job with `currentBoardId == 'main'` shows banner on the sub-1 card and not on main; flipping `currentBoardId` reverses.
- `CircuitsTabTests.swift` — same snapshot test for section headers.
- VoiceOver test: banner is announced as a header so accessibility users hear "currently working on DB-1, say work on DB-2 to switch".

### Acceptance

Inspector glances at iPad screen mid-recording and immediately sees which board is live without scrolling or hunting for an indicator.

---

## Phase E — Backend → iOS WS broadcast `current_board_changed`

### Files to edit

**`src/extraction/stage6-event-bundler.js`** (or wherever `boardOps` events are emitted)

When `dispatchSelectBoard` flips `snapshot.currentBoardId`, push a new bundler event:

```js
perTurnWrites.boardOps.push({
  op: 'current_board_changed',
  board_id: newBoardId,
  designation: <looked up from snapshot.boards>,
});
```

The existing `boardOps` wire channel (Phase 6.0, commit `2706123`) already plumbs this to iOS — no new transport code.

**iOS — `Sources/Services/ServerWebSocketService.swift`** + `BoardOp` decoder

The existing `BoardOp.Codable` from commit `3734b67` (per memory) covers `add_board`, `select_board`, `mark_distribution_circuit`. Extend with `current_board_changed`. On receipt: update `JobViewModel.currentBoardId` (new field) on the main actor; SwiftUI-bound views (Overview + CircuitsTab from Phase D) re-render automatically.

**Initial snapshot on session start**

When a session opens, the backend should emit a `current_board_changed` event for `boards[0]` so iOS knows the starting state. Already free if the bundler is called from the session-start path; verify.

### Tests

- `stage6-event-bundler.test.js` — `select_board` produces a `current_board_changed` op in `boardOps`.
- iOS `ServerWebSocketServiceTests.swift` — receives `current_board_changed`, updates `JobViewModel.currentBoardId`.
- E2E in a fixture session: 2 boards, session starts → Overview shows banner on sub-1; iOS sends `select_board sub-1` → Overview banner moves to main.

### Acceptance

Banner reactively flips within 500 ms of any board switch from any source (voice command, manual TTS-driven select_board, or future tap-to-switch UI).

---

## Out of scope (deliberately deferred)

- **Tap-to-switch UI** — inspector tapping a board card to switch. Voice-first is the workflow; UI tap is a follow-up if requested.
- **Phase 5.6 legacy bucket retirement** — `circuits[0]` survives. Dual-shape storage is intentional (see "Why dual-shape" above). Phase 5.6 of the multi-board sprint can land later as a separate clean-up.
- **Web frontend** — `web/` Inspect/Recording views don't get this UX. Backend changes are web-safe (composite keys serialise round-trip), but voice command + banner UI is iOS-only this sprint.
- **Auto-routing cross-board readings** — explicitly rejected per Q4 lock. Inspector switches first.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Dual-shape storage drifts apart from Phase 5 plan | Keep `getCircuitBucket` / `circuitExistsInSnapshot` / `listCircuitRefsInBoard` helpers as the **only** read paths. Grep audit at end of Phase A for direct `snapshot.circuits[ref]` accesses; fix all. |
| iOS regex misfires on non-command transcript | Anchor with `^…$`, require trailing punctuation or end-of-utterance, narrow the verb list. False-fire rate must be < 1% on a 100-utterance corpus before ship. |
| `current_board_changed` event lost in flight (WS reconnect) | iOS should also fall back to polling `JobViewModel.currentBoardId` from the next reading event's payload. Reading events carry `board_id` after Phase A; iOS infers `currentBoardId = lastReading.boardId` as a sanity check. |
| Sonnet ignores the prompt rule and keeps trying cross-board writes | Phase B's rejection envelope feeds the rejection back into the model's tool-result; Sonnet learns within the same turn. Tool-loop cap protects from runaway. |
| Inspector says "work on X" but X isn't a board yet | TTS clarification: *"There's no board called X. Say 'add a sub-board' to create one first."* Don't auto-create. |

---

## Non-decisions (open, ask before implementing)

1. **Designation pluralisation in banner copy** — "Work on **DB-1**" or "Work on **the kitchen**"? Pick the inspector's spoken form vs the persisted designation. Defer until Phase D draft and check with Derek on copy.
2. **Phase C suppression scope** — does the "work on …" transcript suppression apply to the displayed transcript bar (greys out / removes the command) or only to the Sonnet forward? Cosmetic, no correctness impact.
3. **Telemetry** — should every `current_board_changed` event log to CloudWatch with the trigger source (voice command vs Sonnet vs manual)? Useful for tuning fuzzy match later. Cheap to add.

---

## Implementation order in a fresh session

1. Read `HANDOFF.md` (sibling file).
2. Verify `27a1b94` is on `main` (`git log --oneline | grep 27a1b94`).
3. Start Phase A: edit `stage6-multi-board-shape.js` first (helpers); run tests after each helper change.
4. Phase A → B → C → D+E order. Commit per phase per the project's auto-commit rule.
5. Each phase has an "Acceptance" section — verify before moving on.
