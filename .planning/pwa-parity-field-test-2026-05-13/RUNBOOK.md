# PWA Behavioural-Parity Field Test Runbook

**Test target:** certmate.uk production after the 2026-05-12 → 2026-05-13
PWA parity push (21 gaps closed, ~13 commits) PLUS today's 2026-05-13
follow-ups (CCU picker tiles, narrative merge, L3 audit docstring).

**Inspector:** Derek. Run on the iPad against a real consumer unit, or
on a desktop browser with a microphone + a photo of a CCU. Allow ~20 min
for a full pass.

## What this pass is checking

The 2026-05-12 audit closed 21 cross-platform parity gaps (`706 → 838`
tests). The gaps were diff-shaped, not behaviour-shaped — so the
automated suite proves they're individually correct but doesn't prove
they compose correctly during a real recording. This runbook is the
behavioural smoke test.

The 2026-05-13 follow-ups added:
- **CCU picker M8 UX closure** (commit `2e61310`) — picker now shows 5
  tiles when the active board has circuits, 4 when empty, with the new
  `Add Another Rail` + `Add Sub-Board` tiles wired through to
  `applyAppendRailMode` / `applyAddNewBoardMode`.
- **L1 narrative-merge** (commit `0e18d4d`) — long dictations into
  `general_condition` / `reason_for_report` now append across multiple
  Deepgram chunks instead of overwriting.
- **L3 audit docstring** (commit `787adaa`) — no behaviour change.

## Pre-flight

- Confirm certmate.uk is on the latest deploy. Check
  https://github.com/derek570/EICR-/actions for a green run with HEAD ==
  `git log -1 --format=%H` from this branch.
- Sign in on the iPad as your test inspector account.
- Open Safari devtools (Mac connected) so you can grab console + network
  if something misfires.

## Test 1 — Single-board EICR end-to-end (~7 min)

1. **New job** → EICR → enter a test address.
2. **Supply tab** — dictate the supply readings via voice:
   - "Ze is 0.42, prospective fault current 1.5 kA, earthing arrangement
     TN-C-S, main switch is 100 amps."
   - **Expected:** values appear in LiveFillView during recording (the
     blue flash). Stop recording, swap to Supply tab — every value
     persists.
3. **Installation tab** — start a fresh recording.
   - Dictate: *"Installation is over 50 years old."* Wait 2 seconds.
   - Dictate: *"Walls are damp."* Wait 2 seconds.
   - Dictate: *"Sockets are still 1960s pattern."*
   - **Expected (L1 fix):** General Condition field contains *all three
     sentences* joined with `. ` separators, NOT just the last one.
   - **Pre-fix bug (what we're confirming is gone):** field would show
     only "Sockets are still 1960s pattern."
4. **Board tab** — dictate `"Wylex Amendment 3 main switch 100 amp single
   phase TN-C-S"`.
   - **Expected:** manufacturer / main switch / earthing land on the
     active board record AND mirror to `supply_characteristics`.
5. **Circuits tab — CCU photo, Full Capture mode.**
   - Tap CCU. **Expected:** mode picker opens with **4 tiles** (Names
     Only, Update Hardware, Full Capture, Add Sub-Board — `Add Another
     Rail` is hidden because the board has no circuits yet).
   - Pick Full Capture, photograph the CU (or attach a sample
     photo). Wait ~20 s.
   - **Expected:** circuits land in the table, hardware fields
     populated.
6. **Circuits tab — voice readings on a single circuit.**
   - Dictate: *"Circuit 1, Zs is 0.85, R1+R2 is 0.42, IR live-live 200
     megohms, polarity correct."*
   - **Expected:** values land on circuit 1, every cell visible.
7. **Inspection schedule** — dictate one observation: *"C2 observation
   on circuit 3 — exposed cable in cupboard."*
   - **Expected:** observation appears in the schedule with the right
     code + circuit + text.
8. **End recording** and review every tab. Every value from steps 2–7
   should still be visible.

## Test 2 — Append rail (~3 min)

Continuation of test 1, with the same board still selected.

1. **Circuits tab → tap CCU.** **Expected:** mode picker now shows
   **5 tiles** (Names Only, Update Hardware, Full Capture, Add Another
   Rail, Add Sub-Board).
2. Pick **Add Another Rail**. Photograph (or attach) a second consumer
   unit photo.
3. **Expected:** circuits from the new photo append to the existing
   schedule with continuing numbering (if board has circuits 1–6, new
   ones land as 7–N). Board manufacturer / main switch fields are NOT
   overwritten. SPD info OR-merges (only added if rail-2 found one and
   rail-1 hadn't).

## Test 3 — Multi-board EICR with a Garage sub-board (~7 min)

1. **Fresh new job**, EICR, address: "Garage sub-board test".
2. Take the main-board photo via CCU → Full Capture as in Test 1.
3. **Tap CCU again** → mode picker → pick **Add Sub-Board**. Photograph
   another CU.
4. **Expected:**
   - A new board entry appears with default designation `DB-2`.
   - The active-board selector jumps to the new board.
   - The new photo's circuits appear under DB-2, NOT mixed into DB-1.
   - DB-1's manufacturer / main switch / supply data is unchanged.
5. **Board tab** — switch to DB-2, fill in `Fed From` (DB-1), `Feed
   circuit` (some circuit number on DB-1), `Board type` = Sub-main or
   Sub-distribution, sub-main cable details.
6. **Circuits tab on DB-1** — for the circuit you nominated as the
   feed, dictate "Circuit N is a distribution circuit feeding DB-2" — or
   just confirm via the row's "Distribution circuit" toggle.
7. **End recording.** Open the certificate preview (PDF). Both boards
   should appear; the sub-board page should include the new "Distribution
   Circuit (Sub-Main)" section with feed details.

## Test 4 — LiveFillView during recording (~2 min)

This is checking a regression risk from today's narrative-merge change.

1. Start a recording on a new job.
2. While speaking, watch the LiveFillView panel (the floating live-fill
   summary that flashes blue as Sonnet writes land).
3. Dictate: *"Ze is 0.42."*
4. **Expected:** Ze flashes blue, value "0.42" appears in the panel
   under the supply section, persists for ~3 seconds.
5. Dictate: *"General condition is acceptable, building is over 50
   years old."*
6. **Expected (L1 fix):** LiveFillView shows the combined narrative as
   it lands. Confirm the field doesn't blink-replace as each chunk
   arrives.

## What to capture if something misfires

For each failure, grab:

- **Console log** from Safari devtools — filter for `apply_` events
  (`apply_section_reading_*`, `apply_narrative_field_*`,
  `apply_board_op_*`).
- **Network tab** — the `/api/sonnet-stream` WS frames around the
  failure (right-click → Save messages).
- **A screenshot** of the LiveFillView panel at the moment of the
  failure.
- **The job ID** from the URL (`/job/<id>`).

Open a handoff doc under
`.planning-stage6-agentic/handoffs/pwa-field-test-<date>/STATUS.md` with
that bundle. Easier than re-reproducing later.

## Automated coverage already in place

If you don't have time for a full field run, the following commits cover
the *logic* (just not the cross-tab behaviour):

| Commit | What it pins |
|--------|--------------|
| `2e61310` | CCU picker 5-tile contract (4 picker tests, +1 click each for new tiles) |
| `0e18d4d` | Narrative-merge: 8 pure-helper cases + 7 integration cases through `applyExtractionToJob` |
| `787adaa` | L3 audit docstring (no test change) |
| Prior 13 commits (2026-05-12) | 132 new tests covering the 21 parity gaps |

Full suite: **856/856 tests pass, tsc clean** as of 2026-05-13.
