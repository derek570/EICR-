# "Work on [Board]" — Fresh-Context Handoff

**Read this first** in a new session. Full plan in sibling `PLAN.md` (~370 lines).
Last updated 2026-05-08. Status: **Phase 0 LOCKED, Phase A ready to start.**

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
- Commit `27a1b94` — today's `add_board` legacy-snapshot fix; this sprint builds on top.
