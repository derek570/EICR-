# Handoff — "Work on Board" Phase C shipped (2026-05-08)

**Read this first** if you are picking up the "Work on Board" sprint.

## TL;DR

Phase C of the "Work on Board" sprint shipped today. Two commits
across both repos (backend + iOS), both pushed to their respective
GitHub remotes. CI run **25570313082** in flight at handoff time
(backend HEAD `dcd82ce`). Phase B's deploy (CI run **25561866675**)
completed green earlier in the session.

The inspector's voice command — "Work on [board]" / "Switch to
[board]" / "Now on [board]" — now resolves to a board id on-device
(substring-contains, longest match, ≥3-char overlap) and flips the
server-side `currentBoardId` directly via a new
`case 'select_board'` WS handler. No Sonnet round-trip, no
tool-loop. Acceptance round-trip is **≤ 50 ms** in happy path
(measured on local Mac Catalyst), well under the plan's 200 ms
target.

If you only read one section: **[What's shipped](#whats-shipped) →
[How to verify](#how-to-verify) → [Plan deviation](#plan-deviation)
→ [Next concrete step is Phase D + E](#next-step--phases-d--e)**.

---

## What's shipped

Two commits across the two repos in this session:

| Repo | Commit | Slice | What it does |
|---|---|---|---|
| Backend (EICR_Automation) | `dcd82ce` | Phase C backend | New `case 'select_board'` in sonnet-stream.js. Mutates `session.stateSnapshot.currentBoardId` directly (mirrors `chitchat_resume` precedent). Replies with `select_board_ack` envelope. 9 new tests in `sonnet-stream-select-board.test.js`. |
| iOS (CertMateUnified) | `8ee09dc` | Phase C iOS | New `Sources/Recording/WorkOnBoardIntent.swift` parser+matcher. Wired into `DeepgramRecordingViewModel.processTranscriptText` BEFORE the existing intent detectors. New `sendSelectBoard(boardId:)` on the WS protocol + new `serverDidReceiveSelectBoardAck(_:)` delegate hook + new `SelectBoardAck: Codable` model. 27 new tests in `WorkOnBoardIntentTests.swift`. |

Backend full suite: **3191 passing, 3 pre-existing skips, 0 failed.**
(Phase B finished at 3182; this commit added 9 net tests.)

iOS Mac Catalyst test pass: **27/27** in the new
`WorkOnBoardIntentTests` suite.

---

## What changed structurally

### The contract (the load-bearing rule)

Before Phase C, even after Phases A + B, the inspector had no way to
USE a sub-board they'd added. Every dictated reading landed on
`currentBoardId` (Phase B), but `currentBoardId` was permanently
stuck at `'main'` because nothing flipped it mid-recording without
going through Sonnet's tool loop.

After Phase C:

| Inspector says | What happens |
|---|---|
| "Work on the garage" (designation matches sub-1 unambiguously) | iOS emits `{type: 'select_board', board_id: 'sub-1'}` → backend flips `currentBoardId` → ack `ok=true` → TTS "Switching to Garage". Subsequent dictation lands on sub-1. |
| "Work on the kitchen" (designation matches two boards by ≥3-char overlap) | iOS emits no WS message → TTS "Did you mean Kitchen or Kitchen Annexe?" → inspector retries with the disambiguator. |
| "Work on Foo" (no board with ≥3-char designation overlap) | iOS falls through to Sonnet — the phrase reads like a switch but resolves nowhere; let the model have its chance (it might be the inspector's first utterance about a yet-to-be-added board, or a designation Sonnet recognises better than our normaliser). |
| "Switch to DB-2" / "Now on DB-3" | Same as the first row, alternative verbs. |
| "Working on garage" / "Switching to DB-2" | Continuous-form verbs, same as base. |

### The matcher rule

Both phrase and each board's `designation` are alphanumeric-
normalised: lowercase + drop non-letter / non-digit. So:
- "DB-1" → "db1"
- "DB 1" → "db1"
- "DB-2 (Garage)" → "db2garage"

Then we compute the longest common substring length between the
normalised phrase and each normalised designation. A board
qualifies when the LCS ≥ 3. Among qualifiers, the highest LCS wins.
Ties branch to `.ambiguous`; zero qualifiers → `.noMatch`.

The 3-char floor keeps "DB" alone (2 chars after norm) from
matching, while "DB-1" / "DB-2" / "Garage" / "Kitchen" / etc. all
qualify.

### Verb list

Locked in `WorkOnBoardIntent.parse`:
- "work on" / "working on"
- "switch to" / "switching to"
- "now on"

Optional leading politeness stripped: "could you", "can you",
"please". (Not "now" — it's a verb prefix, not politeness.)

Optional trailing fillers stripped from the captured phrase:
"please", "now", "board"/"boards", "cu", "consumer unit",
"fuse box", "sub-board" / "sub board".

"Moving on to X" was considered (it's the EEB8F9EA repro phrase) but
deliberately rejected — that phrase is the inspector ADDING a
board, not switching to one. Including it would create false-fires
on "moving on to circuit 5".

### Wire-format additions

iOS → backend (new):
```json
{ "type": "select_board", "board_id": "sub-1" }
```

Backend → iOS (new):
```json
{ "type": "select_board_ack",
  "ok": true,
  "board_id": "sub-1",
  "designation": "Garage" }
```

Or on rejection:
```json
{ "type": "select_board_ack",
  "ok": false,
  "error": "board_not_found",  // or invalid_board_id / no_active_session
  "board_id": "sub-99" }       // echoed when known
```

The iOS-side ack handler is a default no-op extension on
`ServerWebSocketServiceDelegate` — no existing conformer needs a
same-PR refactor. The view model could override it later if Phase D
needs a reactive UI signal beyond what the optimistic local flip
already gives.

### Implementation note: why a new WS handler instead of dispatchSelectBoard

`dispatchSelectBoard` (the existing Stage 6 tool dispatcher) writes
to `perTurnWrites.boardOps` — the per-Sonnet-turn channel that's
flushed at the end of each tool-loop iteration. Calling it from
outside a turn would silently lose the side-effect, since the
per-turn writes structure isn't bound to anything outside the loop.

The chosen path mirrors the existing `chitchat_resume` precedent:
small, surgical mutation of session state in the WS handler with no
tool-loop involvement. Phase E (queued) adds the proper boardOps
broadcast for `current_board_changed`; until then the iOS client
already knows the new id (it sent it) and only needs the ack.

---

## Plan deviation

The sprint's PLAN.md said Phase C was iOS-only ("Backend dispatches
the existing select_board Stage 6 tool — no backend work needed").
That turned out to be wishful thinking — the existing Stage 6
dispatcher only fires inside Sonnet's tool-call loop, and there was
no client-initiated dispatch path. Three alternatives considered
mid-implementation, with the user explicitly approving option 1:

1. **Add a small backend WS handler** (chosen). 30 lines of code +
   tests. Ships in the same session as iOS work, one CI deploy.
   Meets the acceptance criteria.
2. **iOS-only suppression now, defer server flip to Phase E**. Stays
   inside the literal "iOS-only" scope but ships an inert Phase C
   — the inspector says "work on garage" and nothing changes
   server-side until E lands. Rejected.
3. **Inject a synthetic transcript** so Sonnet's tool loop calls
   select_board itself. Avoids backend code change but loses the
   determinism + low latency the on-device parser was supposed to
   give us, and re-introduces the Sonnet round-trip we wanted to
   skip. Rejected.

The deviation is small — two commits, one CI deploy — and the
implementation pattern (`case 'select_board'` mirroring
`chitchat_resume`) is established. Future Phase C-style "iOS
detects something local, server flips state directly" features can
follow the same pattern.

---

## How to verify

### Check CI status

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
gh run view 25570313082 --json status,conclusion,url
gh run watch 25570313082 --exit-status   # one long-poll connection
```

Phase B's CI run **25561866675** completed `success` earlier in the
session. Phase C's run was `in_progress` at handoff time.

### Local sanity check

```bash
# Backend
cd /Users/derekbeckley/Developer/EICR_Automation
git log --oneline origin/main~2..origin/main      # should show dcd82ce + Phase B handoff
npm test --silent | tail -5                       # 3191 passing, 3 skipped

# iOS
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified
git log --oneline origin/main~1..origin/main      # should show 8ee09dc
xcodebuild -scheme CertMateUnified \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -only-testing:CertMateUnifiedTests/WorkOnBoardIntentTests \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO test
# → 27 tests passed
```

### Replay the contract

The new suites exercise the contract end-to-end:

- **Backend** `src/__tests__/sonnet-stream-select-board.test.js` —
  9 tests: happy path (3, including idempotency), board_not_found
  (2), invalid_board_id (3), no_active_session (1).
- **iOS** `Tests/CertMateUnifiedTests/Recording/WorkOnBoardIntentTests.swift`
  — 27 tests: parser happy paths (6), politeness/filler stripping
  (5), parser rejections (4), matcher happy paths (4), ambiguity
  branch (1), no-match (4), end-to-end parse→match (2), helper
  internals (2).

### Field-test scenario (end-to-end)

Resume the EEB8F9EA-style flow from Phases A + B:

1. Job has a single main board with circuits 1..13.
2. Inspector: "Moving on to sub-board, garage fed from circuit 11."
   → Sonnet calls `add_board` (Phase A foundation; commit
   `27a1b94` and the Phase A composite-key storage).
3. Inspector: "Work on the garage." → iOS detects, emits
   `select_board(board_id: 'sub-1')`, backend flips, ack received,
   TTS "Switching to Garage".
4. Inspector: "Circuit 1, 0.43 ohms R1+R2." → reading lands at
   `circuits['sub-1::1']` (Phase A composite key).
5. Inspector: "Work on the main board." → flips back to `'main'`,
   subsequent dictation lands on main's legacy bare-numeric keys.

The above is reproducible in the simulator via the local handler
flow without a live backend; the WS round-trip is a thin layer.

---

## Decisions locked in this session

These are *additive* to the sprint's Phase 0 locks and the
Phase A + B decisions:

1. **Substring-contains, longest-match, ≥3-char overlap** — picked
   over Levenshtein. Designations are short; substring overlap is
   the right signal. The 3-char floor keeps "DB" alone (2 chars
   after norm) from matching; "DB-1" → "db1" → 3 chars.
2. **Verb list deliberately tight**. "moving on to" was rejected
   because it overloads the "ADD a board" phrase from the
   EEB8F9EA repro. The inspector can always fall back to
   "switch to X" if "moving on to X" doesn't fire. Acceptable
   false-negative for Phase C.
3. **Ambiguity branches to TTS, does NOT auto-pick**. Original plan
   said "first ≥3-char tie wins" but that produces a silent failure
   when the inspector meant the OTHER one. TTS "Did you mean A or
   B?" matches the rest of the recording flow's bias-to-asking.
4. **Backend WS handler over Sonnet tool loop**. Plan deviation —
   see [Plan deviation](#plan-deviation) above.
5. **Default no-op delegate extension for `serverDidReceiveSelectBoardAck`**
   — same precedent as the Stage 6 hooks. Existing test mocks +
   AudioImportViewModel get the default; `DeepgramRecordingViewModel`
   can override later if Phase D needs the ack to drive UI.
6. **No retry on `wrong_board` ack**. Phase B already rejects
   cross-board writes with `wrong_board`, but Phase C's flow
   doesn't make those writes — the iOS client is the one driving
   the flip, so the cases that fail (`board_not_found` /
   `no_active_session`) are not transient. TTS the failure to the
   inspector, don't retry.

---

## Next step — Phases D + E

Per the sprint's PLAN.md table:

| Phase | Layer | Estimate |
|---|---|---|
| D | iOS — red-banner UI on off-boards | 0.5 session |
| E | Backend + iOS — WS broadcast `current_board_changed` | 0.5 session |

D + E ship together (D's banner needs E's reactivity). Specifically:

- **Phase E backend**: When `case 'select_board'` flips
  `currentBoardId`, also broadcast a
  `{type: 'current_board_changed', board_id, designation}` event
  to all listeners. Same source-of-truth across Sonnet-initiated
  switches (the existing `dispatchSelectBoard` tool path) and
  iOS-initiated switches (the Phase C handler). The
  `boardOps`-driven Phase E broadcast eventually subsumes Phase
  C's optimistic ack path — once Phase E ships, the iOS client
  could drop the optimistic local flip and just react to the
  broadcast.
- **Phase E iOS**: Decode `current_board_changed`, update
  `JobViewModel.currentBoardId` (new field) on the main actor,
  trigger SwiftUI re-render.
- **Phase D iOS**: In `OverviewTab.swift` landscape board cards
  AND `CircuitsTab.swift` section headers, render a red banner
  overlay on every board whose `id != currentBoardId`. Copy:
  `"Not currently being worked on — say "Work on \(designation)" to continue"`.
  Mute card content (50% opacity body, slight grayscale on
  thumbnails). Active board stays full-colour, no banner.

Phase C (this commit) is the foundation that makes Phase D
correct: when the voice command flips `currentBoardId`, the banner
needs to flip with it. Without Phase C, the banner could only be
driven by Sonnet-emitted select_board events, which aren't reliable
mid-recording.

---

## Phase F (queued, NOT in scope here)

Per the sprint's plan:
- `current_board_changed` broadcast unification — single
  authoritative wire event, optimistic ack deprecated.
- Phase 5.6 legacy bucket retirement — `circuits[0]` survives.
  Dual-shape storage is intentional (see "Why dual-shape" in
  PLAN.md). Phase 5.6 can land later as a separate clean-up.
- Web frontend — `web/` Inspect/Recording views don't get this
  UX. Backend changes are web-safe (composite keys round-trip,
  `select_board` WS message ignored by older clients).
- Auto-routing cross-board readings — explicitly rejected per
  Phase 0 Q4 lock. Inspector switches first.

---

## Files touched in this session

### Backend (commit `dcd82ce`)

Production:
- `src/extraction/sonnet-stream.js` — added `import` of
  `ensureMultiBoardShape` from `stage6-multi-board-shape.js`; new
  `case 'select_board'` block in the WS dispatch switch (between
  `chitchat_resume` and the default-fallthrough). The `case` block
  validates input, looks up the board, mutates `currentBoardId`,
  logs structured event, and replies with `select_board_ack`.

Tests added:
- `src/__tests__/sonnet-stream-select-board.test.js` (271 lines,
  9 tests). Five describe blocks: happy path (with idempotency +
  flip-back), board_not_found, invalid_board_id (missing /
  non-string / empty), no_active_session.

### iOS (commit `8ee09dc`)

Production:
- `Sources/Recording/WorkOnBoardIntent.swift` — new file (228
  lines). Pure parser + matcher. Mirrors the
  `CalculateImpedanceIntent` / `ApplyFieldIntent` shape.
- `Sources/Recording/DeepgramRecordingViewModel.swift` — wired
  `WorkOnBoardIntent.parse` + `WorkOnBoardIntent.matchBoard` into
  `processTranscriptText` BEFORE the existing intent detectors.
  Added `handleLocalSelectBoard` (match path) and
  `handleLocalSelectBoardAmbiguous` (ambiguity path).
- `Sources/Services/ServerWebSocketServiceProtocol.swift` — added
  `func sendSelectBoard(boardId: String)` to the protocol.
- `Sources/Services/ServerWebSocketService.swift` — concrete impl
  of `sendSelectBoard`; added `case "select_board_ack"` to the
  inbound dispatch; new `SelectBoardAck: Codable, Equatable, Sendable`
  model; new `serverDidReceiveSelectBoardAck(_:)` delegate method
  with default no-op extension.

Tests added:
- `Tests/CertMateUnifiedTests/Recording/WorkOnBoardIntentTests.swift`
  (256 lines, 27 tests). Six describe blocks: parser happy paths
  (6), politeness + filler stripping (5), parser rejections (4),
  matcher happy paths (4), ambiguity (1), no-match (4), end-to-end
  (2), helpers (2).

Mocks updated:
- `Tests/CertMateUnifiedTests/Mocks/MockServerWebSocketService.swift`
  — added `selectBoardCalls: [String]` capture array + impl.

Project file:
- `CertMateUnified.xcodeproj/project.pbxproj` — registered the new
  source file in the Recording group + app target's
  PBXSourcesBuildPhase, and the new test file in the test target's
  Recording group + PBXSourcesBuildPhase. Generated UUIDs follow
  the precedent from VoiceCommandExecutor / ApplyFieldIntentTests.

### Docs

- This handoff. Sprint `HANDOFF.md` status header to be updated
  immediately after this commit.

---

## Cross-references

- Sprint plan: `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/PLAN.md`
- Sprint handoff (rolling): `.planning-stage6-agentic/handoffs/work-on-board-2026-05-08/HANDOFF.md`
- Phase A handoff: `.planning-stage6-agentic/handoffs/handoff_2026-05-08_work-on-board-phase-a-shipped.md`
- Phase B handoff: `.planning-stage6-agentic/handoffs/handoff_2026-05-08_work-on-board-phase-b-shipped.md`
- Parent multi-board sprint: `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/HANDOFF.md`
- Phase 5 re-key plan (eventual destination, not what this sprint took):
  `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PHASE5_HANDOFF.md`
- Provoking incident: session **EEB8F9EA** (2026-05-08)
- Phase A foundation: backend `382985e`
- Phase B contract: backend `d783818`
- Phase C backend: backend `dcd82ce`
- Phase C iOS: iOS `8ee09dc`

---

## Things to watch in field test

1. **First voice-switch in a real session.** The signal in
   CloudWatch is `select_board (iOS voice command)` log row with
   `board_id`, `designation`, `previous_board_id`. Followed by the
   inspector dictating a reading; verify the reading lands at the
   composite-key bucket (Phase A) and not on `circuits[ref]` legacy.
2. **Ambiguity TTS firing on a real two-board job.** Most jobs
   have one main + one sub, so the first time this fires will be
   on a job with similar designations ("Kitchen" + "Kitchen
   Annexe", or two boards both designated "DB" with different
   numbers). The TTS clarification should be intelligible and not
   trigger another false-fire on the disambiguator. Worth noting if
   the inspector ever says "the kitchen one" or "the bigger one"
   instead of the literal designation.
3. **No-match fall-through.** When the inspector says "work on the
   shower circuit" (a CIRCUIT, not a board), our matcher returns
   `.noMatch` and falls through to Sonnet. Sonnet should NOT
   interpret this as a board switch — verify with a transcript +
   Sonnet trace. If Sonnet ever calls `select_board` based on a
   passthrough phrase, that's a prompt drift to flag.
4. **Suppression boundary on ambiguity.** When the matcher returns
   `.ambiguous`, the matched transcript is suppressed from Sonnet
   (the inspector's next utterance is meant to be the
   disambiguator, not new dictation). If the inspector instead says
   something completely unrelated, the next transcript falls
   through normally — no permanent suppression. Worth confirming
   in a session log: a `select_board_local_ambiguous` event NOT
   followed by a second `select_board_local` (or
   `select_board_local_ambiguous`) within ~5 seconds, but
   immediately followed by a normal `transcript_utterance`, is the
   expected pattern.
