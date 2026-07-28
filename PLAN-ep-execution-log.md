# /ep execution log — plan A2-multiboard (`replaces_cleared` multi-board hardening)

- **Session:** `20260728T155441Z-ep`
- **Plan:** `/Users/derekbeckley/.claude/handoffs/EICR_Automation--replaces-cleared-multiboard-2026-07-27/PLAN-final.md`
- **Repo:** `/Users/derekbeckley/Developer/EICR_Automation`
- **Worktree:** `/Users/derekbeckley/Developer/EICR_Automation-ep-20260728T155441Z-ep`
- **Branch:** `ep/replaces-cleared-multiboard-20260728T155441Z-ep`
- **Base:** `origin/main` @ `9bafeac9` (A2-core merge, PR #127)
- **Chain:** hop 6, batch `feedback-2026-07-25-batch-resume-20260727`

## Prerequisite gate — PASSED

A2-core (`PLAN-final.md` in `EICR_Automation--replaces-cleared-chain-a2-2026-07-26`) is a hard prerequisite: **merged AND deployed**.

- Merged: PR #127 → `9bafeac9` (`.ep-done` records `outcome=ALL PASSED`, iOS PR CertMateUnified#40 `d76eb887`).
- Deployed: CI run `30372616285` on `main` — job **"Deploy to AWS ECS (Production): completed/success"**.
- Live task def **`eicr-backend:350`** (was `:347` at A1a/#123) — the revision INCREMENTED, which per the deploy-verification rule is the trustworthy signal (rolloutState alone is stale).

Gate PASSED — proceeding.

## [PLAN-SIZE] warning

This plan bundles **10 top-level scope items** spanning THREE distinct surfaces (backend `src/extraction`, `web/src/lib/recording`, iOS `CertMateUnified`) and several high-interaction subsystems (the per-turn write accumulator, the event bundler's projection/collapse passes, the loaded-barrel speculator, and both clients' apply layers). Review effort scales with the interaction count, so a long Codex convergence is expected. Flagging per the `/ep` plan-size heuristic — this is a warning, not a gate; execution proceeds.

## Steps

All 10 plan items executed. 24 commits, 51 files, +9914/−1776. Nothing skipped, nothing blocked, no `[ASSUMED]` deviations.

| #   | Item                                                                                       | Commits                              |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| 9   | Append-only sequenced write JOURNAL (foundation for everything else)                        | `8cae1d3c`                           |
| 2   | Project per-turn writes LWW per EFFECTIVE slot; retire the ambiguous-projection decline     | `a1d3c24b`                           |
| 1   | Address every cross-board winner to its own board, end to end (asymmetric wire enrichment)  | `7301477d`                           |
| 5   | Derive `board_info` from the CANONICAL main board, never array index 0                      | `9d49fc3f`                           |
| 6   | Empty-string `board_id` normalisation at the dispatchers + per-reading row resolution (web) | `8f641062`, `ee326649`               |
| 3   | Circuit ops reach the clients on the board the server mutated, losslessly and in wire order | `f3fe028c`, `2e77806a`, `fd15cb28`   |
| 4   | Invalidate loaded-barrel speculations for same-turn collapsed replacements                  | `3adb5dc4`                           |
| 7   | `replaces_cleared` at BOARD scope (backend stamp + web two-leg preflight)                   | `50f193b1`, `dfbf636e`, `debcb0b5`   |
| 8   | Measure "All circuits" against the group's own board                                        | `17efeee1`                           |
| 10  | Fold board identity into the circuit confirmation dedupe keys                               | `625a7144`                           |
| —   | A1b dependency wording, archive §4 regression inventory, T10 fixture, docs                  | `b151c2c5`, `82f808d6`, `88744502`   |

### The load-bearing design decision

`record_reading`, `record_board_reading` and `start_dialogue_script` all carry **no schema `board_id`**, so two boards' writes for the same field collide on ONE raw accumulator key and `Map.set` destroys the first. Every defect in this plan is a consequence of that single ambiguity. The fix is one mechanism used everywhere: an append-only journal stamped with a monotonic `WRITE_SEQUENCE` Symbol at dispatch, projected to winners **per effective slot** at read time. Non-enumerable Symbols carry the effective slot/board, so `JSON.stringify` output — the wire — is untouched.

Single-board wire output is **byte-identical to pre-diff** by construction: an ORDINARY reading is enriched with `board_id` only when `distinctEffectiveBoards.size > 1`; a FLAGGED (`replaces_cleared`) reading is always enriched, because that is the class whose whole purpose is to overwrite an occupied cell.

### Item 7 round 2 — deliberately NOT implemented (`dfbf636e`)

The plan's item 7 round 2 is unreachable by construction after item 2: the projection makes the multi-candidate board case impossible, so there is nothing to disambiguate. A test locks the unreachability instead of implementing dead code. Logged here because "item present in plan, absent from diff" would otherwise read as an omission.

## Gates

| Gate                                     | Result                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Backend Jest (`src/__tests__/`)          | **6580 passed**, 19 skipped, 282 suites                           |
| Web vitest                               | green                                                             |
| Field-replay corpus (strict, recorded)   | **9/9**                                                           |
| eslint                                   | clean                                                             |
| prettier                                 | clean                                                             |
| `tsc --noEmit` (web)                     | at main's 17-error baseline, zero new                             |
| parity-ledger check                      | clean apart from one pre-existing unrelated blank-date warning     |

## Codex pre-merge diff review — PASSED at cycle 5

Model `gpt-5.5`, reasoning `high`, read-only sandbox. Cap 10; used 5 + one per-fix mini-review.

| Cycle               | Findings | Outcome                                                                                                    |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 1 (parallel 3-lens) | 5        | 1 real → script-backfill precedence guard re-keyed to the EFFECTIVE slot (`e76f8c8a`); 4 refuted/OOS         |
| 2                   | 2        | 1 BLOCKER → expanded designation read-backs addressed to the EFFECTIVE board (`8a65f0c7`); 1 refuted        |
| 3                   | 2        | 1 BLOCKER → #31 clear-suppression keyed on the EFFECTIVE circuit slot (`0aaba884`); 1 OOS → follow-up       |
| 4                   | 2        | 1 IMPORTANT → §3.5 notice drain reads PROJECTED board winners (`8054dd20`); 1 MINOR docs (`56da0682`)       |
| mini-review         | 1        | MINOR → retracted the A2-core fall-through claim at its two other sites (`74b48536`)                        |
| 5 (full)            | 1        | **refuted** — see below. No real findings.                                                                  |

Raw finding counts were flat at 2, but severity converged monotonically — BLOCKER → BLOCKER → IMPORTANT → MINOR-docs → none — and each cycle was directed at surface earlier cycles had not reached rather than re-churning patched code. The "two non-decreasing cycles ⇒ hold" rule was not triggered in substance.

### Cycle 5's single finding was a REPEAT false positive — worth not re-learning

Codex reported `boardRefKey` at `web/src/lib/recording/apply-extraction.ts:1078` as concatenating board id and circuit ref **with no delimiter**, so `(db-12, 3)` and `(db-1, 23)` would collide on `db-123`. Verified with `cat -v`: the separator is a literal **NUL** — exactly the unambiguous key Codex proposed as the fix. `rg`/`grep` silently strip it, and this is the **second** cycle to produce this same false positive on this same file, despite an explicit NUL warning in the review prompt. Any future review of `src/extraction/*.js` or `apply-extraction.ts` must verify suspicious string-concatenation findings with `cat -v` before acting.

### Fixes the review actually bought (all test-invisible before)

1. **`e76f8c8a`** — the dialogue-script backfill's precedence guard compared bare `field|circuit`, so a main-board write suppressed a sub-board script's backfill.
2. **`8a65f0c7`** — an expanded designation read-back ("circuits 1 to 3") was addressed to the session's current board rather than the group's own, so a cross-board expansion named the wrong board aloud.
3. **`0aaba884`** — #31's clear-suppression key was board-ambiguous: write Zs c1 on main, `select_board garage`, clear Zs c1 on garage → main's write ate garage's spoken "Zs cleared". Applied on the server AND the client, never heard. Audio-First #1.
4. **`8054dd20`** — the §3.5 mandatory-notice drain still read the raw `boardReadings` Map, so an earlier board's write was invisible and its `board_clear_already_empty` notice spoke **alongside its own write read-back** — "manufacturer already blank" then "manufacturer recorded as Wylex". Newly audible precisely because item 2's projection resurrects that write, so it belonged in this change rather than in a follow-up.

## Follow-ups (2 of a 5 cap; written to `~/obsidian-vault/active/todos-certmate.md`)

1. **The dialogue engine is board-blind in two ways** — `applyWrite` writes to the legacy bare-numeric circuit key regardless of `currentBoardId` (so a sub-board script backfill is silently skipped), and its `type:'extraction'` side-channel frames carry no `board_id` (so web routes them ref-only). Out of scope; found by cycle 3.
2. **Standalone circuit clears are board-blind on the wire** — the dispatcher resolves the effective board and stamps it non-enumerably, but the emitted `field_corrected` frame still carries `input.board_id ?? null`, so a cross-board clear can land on the wrong row client-side. Cross-client wave; the T10 corpus fixture pins the current shape and must be re-declared in the same change.

Plus the standing **iOS companion** item (CertMateUnified, separate repo/PR, rides a wave TestFlight build) — regenerated fixture literal, `CircuitUpdate.from_ref`/`'delete'`, item 5's tri-state board resolution, item 7's decoder, item 10's djb2 board fold.

## Outcome

**ALL PASSED** — gates green, Codex review PASSED at cycle 5. Proceeding to PR + merge + deploy.
