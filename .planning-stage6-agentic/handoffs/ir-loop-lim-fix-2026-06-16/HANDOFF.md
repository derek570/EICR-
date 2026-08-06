# HANDOFF — ir-loop-lim-fix-2026-06-16

**Entry point for `/ep`**: `PLAN-final.md` in this directory.

**Status**: DONE
**Rounds**: 4
**Findings**: 21 applied (2 blocker, 12 important, 7 nit), 0 skipped
**Trajectory**: R1 14 (0B/9I/5N) → R2 5 (2B/2I/1N) → R3 2 (0I→1I/1N) → R4 0 (clean)
**Unresolved at termination**: 0

## Source

Definitive root-cause investigation of all 5 voice-feedback markers from field session `F1AC26FB` (job_1781607199550, EIC, 78 Meadow Close Thatcham, 2026-06-16): #1 earthing TN-S took ~6 tries, #2 "tails" mis-mapped to sub_main_cable_csa, #3 ring continuity couldn't resolve "the sockets"→circuit 2, #4 insulation-resistance loop refires on "LIM" (the original report; repeat of a 2026-02-18 request), #5 "swap circuits 3 and 4" left junk circuit 999 "(temp)". File:line root causes verified by 4 parallel deep-dives + direct log trace.

## What `/ep` should pick up

- `PLAN-final.md` — canonical execution target. Two waves: backend (BE-safe + one shared-prompt commit, push main → CI) then iOS (#1, TestFlight). Each fix tagged [BE-safe]/[shared-prompt]/[iOS]/[contract].
- `PLAN-conversation-context.md` — decisions (LIM→sentinel not >999; deliverable=plan) and constraints (backend shared/immutable; deploy via CI only) from the originating session.
- `PLAN-refine-log.md` — full /rp audit trail (4 rounds, 21 findings).

## Caveats

- **Do NOT execute the two [contract] items without surfacing to Derek first**: #3.4 (circuit designation never crosses the wire to the server snapshot — changes what iOS pushes) and #5.3 (atomic swap tool — needs an iOS op handler or it silently no-ops). The plan deliberately defers both.
- LIM decision is LOCKED to "store sentinel string LIM" — do NOT map to >999.
- iOS wave (#1) hits the known stale `TranscriptFieldMatcherTests` gate — do NOT blind-fix stale expectations.
- All file:line citations were verified against current code on 2026-06-16 but may drift — re-confirm at execution time.
- No Codex failures after round 1 (round-1 first Codex call failed on a JSON-schema `additionalProperties` requirement; corrected and re-run same round — not a content gap).
