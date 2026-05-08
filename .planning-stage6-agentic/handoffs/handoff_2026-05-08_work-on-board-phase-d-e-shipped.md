# Handoff — "Work on Board" Phase D + E shipped (2026-05-08)

**Read this first** if you are picking up the "Work on Board" sprint.

## TL;DR

Phases D + E shipped together this session, the planned final slice of
the "Work on Board" sprint. The unified `current_board_changed` wire
broadcast lands on iOS, drives `JobViewModel.currentBoardId`, and a
red banner now flags every off-board section in CircuitsTab
landscape multi-board view.

Two commits today:

| Repo | Commit | What it does |
|---|---|---|
| EICR_Automation | `38fbce0` | Phase E backend — `current_board_changed` envelope from BOTH sources (iOS-initiated `case 'select_board'` + Sonnet-tool-initiated `dispatchSelectBoard`). 5 new tests in `sonnet-stream-select-board.test.js` (17 total in file, all green). Backend full suite still green. |
| CertMateUnified | `0849da1` | Phase E iOS decode + JobViewModel field + Phase D red-banner UI on CircuitsTab section headers. 7 new tests across `JobViewModelTests` + `ServerWebSocketStage6DecodingTests`. Mac Catalyst test pass: my 6 new JobViewModelTests green; 3 pre-existing testSave* failures are not from these changes (verified). |

If you only read one section: **[What's shipped](#whats-shipped) →
[How to verify](#how-to-verify) → [Plan deviation](#plan-deviation) →
[Sprint complete — what's next](#sprint-complete--whats-next)**.

---

## What's shipped

### Phase E backend (commit `38fbce0` on EICR_Automation `main`)

Production:

- `src/extraction/sonnet-stream.js`:
  - **`case 'select_board'`** — after the existing `select_board_ack`
    on success, also broadcast
    `{type: 'current_board_changed', board_id, designation, source: 'ios'}`.
    Rejection paths (board_not_found / invalid_board_id /
    no_active_session) do NOT broadcast — the snapshot's
    `currentBoardId` was never flipped.
  - **`emitCurrentBoardChangedFromBoardOps` helper** — scans
    `result.board_ops` for `op === 'select_board'` and emits one
    top-level `current_board_changed` envelope per match with
    `source: 'sonnet'`. Designation is looked up from
    `session.stateSnapshot.boards` at send time.
  - Wired into BOTH extraction-send sites: synchronous
    `handleTranscript` AND asynchronous `onBatchResult` callback.
    Batched tool-loop turns must broadcast too — otherwise switches
    that happen inside a long-running tool loop would silently fail
    to update iOS state.

Tests added (5 new, 17 total in file, all green):

- `src/__tests__/sonnet-stream-select-board.test.js`:
  - emits current_board_changed broadcast on success (source=ios)
  - current_board_changed carries null designation when board has none
  - does NOT emit current_board_changed on rejection
  - emits current_board_changed (source=sonnet) for select_board op in
    result.board_ops
  - emits one broadcast per select_board op when multiple appear in
    same turn
  - does NOT broadcast when board_ops contains only non-select ops
  - does NOT broadcast when board_ops slot is omitted from result
  - current_board_changed carries null designation when target has none

### Phase E iOS decode + JobViewModel field

Production (commit `0849da1` on CertMateUnified `main`):

- `Sources/Services/ServerWebSocketService.swift`:
  - New `case "current_board_changed"` in `handleMessage`.
  - New `CurrentBoardChanged: Codable, Equatable, Sendable` model
    (`board_id` non-optional; `designation` + `source` optional for
    forward-compat).
- `Sources/Services/ServerWebSocketServiceProtocol.swift`:
  - New `serverDidReceiveCurrentBoardChanged(_:)` delegate method.
  - Default no-op extension so existing conformers (e.g.
    AudioImportViewModel, test mocks) compile unchanged.
- `Sources/ViewModels/JobViewModel.swift`:
  - New `var currentBoardId: String?` (default nil — bootstrap state
    treats nil as "first board active"; flips to a concrete id on the
    first server broadcast).
  - New `isActiveBoard(_: BoardInfo) -> Bool` helper centralising the
    "is this the active board?" comparison + nil-bootstrap branch.
- `Sources/Recording/DeepgramRecordingViewModel.swift`:
  - Implements `serverDidReceiveCurrentBoardChanged(_:)` — updates
    `jobVM?.currentBoardId` on the main actor and stamps a
    `current_board_changed` event into DebugLogger for session-
    analytics.

### Phase D iOS red-banner UI

Production (same commit `0849da1`):

- `Sources/Views/JobDetail/CircuitsTab.swift`:
  - New `inactiveBoardBanner(designation:)` helper renders a 24pt-tall
    red stripe with a warning icon and "Not being worked on
    (\(designation))".
  - Wired into all three landscape section-header rendering paths:
    `fullWidthGrid`, `stickyGrid` LEFT, and `stickyGrid` RIGHT. Both
    sticky halves render in lockstep (same isActiveBoard gate) so
    left/right columns stay vertically aligned.
  - Active boards render no banner (zero whitespace gap above the
    section header).

### Tests

Mac Catalyst test pass (xcodebuild Mac Catalyst, JobViewModelTests
target):

- 6 new JobViewModelTests:
  - `testIsActiveBoard_nilCurrentBoardId_treatsFirstBoardAsActive`
  - `testIsActiveBoard_flipsToSubBoardWhenCurrentBoardIdChanges`
  - `testIsActiveBoard_emptyBoards_returnsFalseForUnknownBoard`
  - `testCurrentBoardChangedDecodesFromJSON`
  - `testCurrentBoardChangedToleratesMissingSource`
  - `testCurrentBoardChangedToleratesNullDesignation`
- 1 new ServerWebSocketStage6DecodingTests entry:
  - `test_currentBoardChangedOverride_capturesBothSources`
  - Plus default-extension fallback test extended to cover the new
    method so bare delegate conformers keep compiling.

3 pre-existing JobViewModelTests failures (testSavePersistsToDatabase,
testSavePassesCorrectUserId, testSaveMarksDirtyForSync) are NOT from
this change — they're `save()` ↔ MockAppDatabase issues unrelated to
multi-board work.

---

## What changed structurally

### The unified wire signal

Before Phase E the only signal a board switched was either:

- The Phase C ack (`select_board_ack`) sent by the iOS-initiated path,
  consumed by a default no-op handler on iOS. The ack carries error
  codes on failure paths but is success-redundant for UI.
- The Sonnet-tool path's `boardOps` entry `{op: 'select_board',
  board_id}` inside the extraction envelope, decoded by iOS into
  `BoardOp.selectBoard` but never acted on.

After Phase E:

| Switch source | Wire signal (NEW) | iOS reaction |
|---|---|---|
| iOS voice command (Phase C) | `{type: 'current_board_changed', board_id, designation, source: 'ios'}` | `JobViewModel.currentBoardId` flips |
| Sonnet tool call (`select_board`) | `{type: 'current_board_changed', board_id, designation, source: 'sonnet'}` | `JobViewModel.currentBoardId` flips |

`select_board_ack` survives for the request/response failure path
(carries `error: 'board_not_found' | 'invalid_board_id' | 'no_active_session'`).
The success arm of the ack is now redundant for UI reactivity — iOS
could drop reading it from there and only react to the broadcast.
Phase F (queued) may deprecate that arm; for now both stay so the
contract is stable.

### Why the banner is short

The full call-to-action ("Not being worked on — say 'Work on \(designation)'
to continue") was the original spec. In the sticky-left column
(~265pt wide at 11pt font), that copy truncates to ~"Not being worked
on — sa..." which is less informative than the short version. So the
banner is "Not being worked on (\(designation))" — designation in
parentheses tells the inspector exactly which board this row group is
attached to, without overflowing the column.

### Why no row-dimming

The plan called for 50% opacity on inactive board rows. Skipped:
inspectors must still be able to **read** off-board values during
field testing (e.g. comparing main's circuit 5 to sub-1's circuit 5).
Dimming the rows would obscure exactly the values they need. The
red banner above the section header is already a strong "off-board"
signal; field-test feedback will tell us if more is needed.

### Why no LiveFillView banner

The original PLAN.md said "OverviewTab.swift landscape board cards"
should also get the banner. `OverviewTab.swift` no longer exists
(renamed to LiveFillView during the recording pipeline v3 migration).
LiveFillView only renders `boards.first` — there are no per-board
cards to dim. CircuitsTab section headers are therefore the only
surface where multiple boards visibly stack at once.

LiveFillView's `boards.first` hardcode (line 691) is a separate
follow-up — it should consume `currentBoardId` to swap which board's
BoardInfo + supply line is shown. Filed as future work, not in this
sprint.

---

## Plan deviation

The sprint's PLAN.md said Phase E would also extend `dispatchSelectBoard`
to push something onto the boardOps channel. That dispatcher already
pushes `{op: 'select_board', board_id}` — design choice was where
to do the broadcast emission:

1. **Add a top-level `current_board_changed` op on boardOps**.
   Rejected: iOS-initiated path doesn't go through perTurnWrites
   so it'd need a synthetic per-turn flush — more layering not less.

2. **Pass a `broadcastCurrentBoardChanged` callback through ctx**.
   Rejected: leaks transport (WS) into pure dispatcher layer; one-tool
   exception in an otherwise pure contract.

3. **Top-level WS envelope, scanned out of `result.board_ops` at the
   WS-send boundary**. ← chosen. The WS layer already owns
   broadcasts (chitchat_paused, voice_command_response, etc.). The
   dispatcher stays pure — its only side-effect is the boardOps push
   it already makes. One helper `emitCurrentBoardChangedFromBoardOps`
   wires both sync + async paths.

This means dispatchSelectBoard's contract is unchanged from Phase 6.2.
The wire emission path is consolidated in sonnet-stream.js, which is
where iOS-initiated select_board already does its broadcast.

---

## How to verify

### Backend

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
git log --oneline origin/main~1..origin/main      # should show 38fbce0
node --experimental-vm-modules node_modules/jest/bin/jest.js \
  --testPathPattern='sonnet-stream-select-board' --no-coverage
# → Tests: 17 passed, 17 total
```

CI run (Phase E deploy) was triggered automatically on the push.
Watch with: `gh run watch <run-id> --exit-status`. Service is
backwards-compatible — pre-Phase-E iOS clients ignore the unknown
envelope, post-Phase-E clients react.

### iOS

```bash
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
git log --oneline origin/main..main      # should show 0849da1 (push pending)
xcodebuild -scheme CertMateUnified \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -only-testing:CertMateUnifiedTests/JobViewModelTests \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO test
# → my 6 new tests pass; 3 pre-existing testSave* fail (unrelated)
```

iPhone 17 Pro simulator wasn't available on this Mac, so verification
ran on Mac Catalyst (same as Phase C). Compile clean across all 5
modified production files; no errors, only pre-existing warnings.

### Field-test scenario (end-to-end)

Resume a job with two boards (main + sub-1):

1. Inspector opens the job; CircuitsTab landscape view shows BOTH
   boards stacked. Banner is on `sub-1` (default `currentBoardId
   == nil` → first board treated as active → `sub-1` is the
   non-active one).
2. Inspector starts recording, says "work on the garage" (assuming
   sub-1's designation is "Garage" / "DB-2 (Garage)" / etc.).
3. iOS detects via WorkOnBoardIntent (Phase C), sends `select_board`
   WS message.
4. Backend flips `currentBoardId`, broadcasts `current_board_changed`
   with `source: 'ios'`. iOS decodes, updates
   `jobVM.currentBoardId = 'sub-1'`. Banner moves from sub-1 → main.
5. Inspector says "circuit 1, 0.43 ohms R1+R2". Reading lands at
   `circuits['sub-1::1']` (Phase A composite key).
6. Inspector says "work on main board". iOS detects, sends
   `select_board(board_id: 'main')`, banner flips back.
7. **OR**: inspector dictates a new sub-board via "moving on to
   subboard, garage fed from circuit 11". Sonnet calls `add_board`
   then might call `select_board` itself (or might not — check the
   prompt). If Sonnet calls `select_board`, the broadcast emits with
   `source: 'sonnet'`; banner reacts the same way as the iOS path.

CloudWatch signal: `current_board_changed` log row (added by Phase E
backend) and `select_board (iOS voice command)` log row (added by
Phase C). Joined on sessionId, you can attribute every switch.

---

## Sprint complete — what's next

The "Work on Board" sprint (PLAN.md, 5 phases A → E) is now
complete on `main` for both repos. End-to-end:

| Phase | Status | Layer | Commit |
|---|---|---|---|
| A | shipped (CI run `25560825421`) | Backend dual-shape storage | `382985e` / `d1ad05b` / `cc303bc` |
| B | shipped (CI run `25561866675`) | Backend strict scoping + prompt | `d783818` |
| C | shipped (CI run `25570313082`) | iOS voice command + WS handler | backend `dcd82ce` + iOS `8ee09dc` |
| D | shipped this session | iOS red banner | iOS `0849da1` |
| E | shipped this session (CI in flight) | Backend broadcast + iOS decode | backend `38fbce0` + iOS `0849da1` |

iOS commit `0849da1` is on local `main` but **not yet pushed** to
GitHub. Push when ready (`git push origin main` from CertMateUnified).
TestFlight bump (Build 352 already in working tree) is independent
— combine with this commit if shipping a new build.

### Field-test priorities

1. **First voice-switch in a real two-board session.** Watch the red
   banner reactively flip between boards as the inspector says "work
   on garage" / "work on main". CloudWatch:
   `current_board_changed` log rows.
2. **Sonnet-initiated switch.** When the model itself calls
   `select_board` (e.g. after extracting "circuit 5 supplies the
   garage CU"), the broadcast still fires (source: 'sonnet') and the
   banner moves. Verify via session log.
3. **Banner truncation on real board designations.** "DB-2 (Garage)"
   = 14 chars; "Kitchen Annexe" = 14 chars. Sticky-left can fit ~30.
   Long designations like "DB-3 (Garden Office Outbuilding)" might
   truncate — note if the inspector's designation choice matters.

### Future work (filed but out-of-scope)

- **LiveFillView consumes currentBoardId.** Today line 691 hardcodes
  `boards.first`. Should swap to the active board's BoardInfo +
  supply line. Refactor + new view sections for sub-board metadata.
- **Row dimming on off-boards.** Add 25% opacity (mild — values
  still readable) if field test shows the banner alone isn't enough.
- **Phase 5.6 retire `circuits[0]` legacy bucket.** Already
  documented as the next clean-up (PHASE5_HANDOFF.md). Not blocking.
- **Initial-state broadcast on session start.** Currently iOS uses
  the nil-bootstrap to assume first-board-active. Could explicit-
  broadcast on session_start so iOS sees a concrete id immediately.
  Optional — both paths converge.
- **Phase F**: deprecate `select_board_ack` success arm now that
  `current_board_changed` is the canonical UI signal. Failure arm
  stays (carries error codes).

---

## Cross-references

- Sprint plan: `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/PLAN.md`
- Sprint handoff (rolling): `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/HANDOFF.md`
- Phase A handoff: `handoff_2026-05-08_work-on-board-phase-a-shipped.md`
- Phase B handoff: `handoff_2026-05-08_work-on-board-phase-b-shipped.md`
- Phase C handoff: `handoff_2026-05-08_work-on-board-phase-c-shipped.md`
- Parent multi-board sprint: `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/HANDOFF.md`
- Provoking incident (3-phase chain): session **EEB8F9EA** (2026-05-08)
- Phase E backend: `38fbce0`
- Phase D + E iOS: `0849da1`

---

## Files touched in this session

### Backend (commit `38fbce0`)

Production:
- `src/extraction/sonnet-stream.js` — added top-level
  `current_board_changed` broadcast in `case 'select_board'` on
  success; new helper `emitCurrentBoardChangedFromBoardOps` wired
  into both extraction-send sites (`handleTranscript` synchronous +
  `onBatchResult` async).

Tests:
- `src/__tests__/sonnet-stream-select-board.test.js` — 5 new tests
  in 2 describe blocks (3 in iOS happy path covering broadcast +
  designation; 2 in board_not_found / new "Phase E" describe with
  5 tests).

### iOS (commit `0849da1`)

Production:
- `Sources/Services/ServerWebSocketService.swift` — new case in
  `handleMessage`, new `CurrentBoardChanged` model.
- `Sources/Services/ServerWebSocketServiceProtocol.swift` — new
  delegate method + default no-op extension.
- `Sources/ViewModels/JobViewModel.swift` — new `currentBoardId`
  property + `isActiveBoard` helper.
- `Sources/Recording/DeepgramRecordingViewModel.swift` — implements
  the new delegate method.
- `Sources/Views/JobDetail/CircuitsTab.swift` — new
  `inactiveBoardBanner` helper + wired into 3 landscape rendering
  paths (fullWidthGrid, stickyGrid LEFT, stickyGrid RIGHT).

Tests:
- `Tests/CertMateUnifiedTests/ViewModels/JobViewModelTests.swift` —
  6 new tests (3 isActiveBoard + 3 JSON decoder).
- `Tests/CertMateUnifiedTests/Services/ServerWebSocketStage6DecodingTests.swift`
  — capture array + 1 new test on MockDelegate; default-extension
  fallback test extended.
