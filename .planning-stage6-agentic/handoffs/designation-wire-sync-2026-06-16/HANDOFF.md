# HANDOFF — designation-wire-sync-2026-06-16

**Entry point for `/ep`**: `PLAN-final.md` in this directory.

**Status**: DONE
**Rounds**: 4
**Findings**: 23 applied (6 blocker, 11 important, 6 nit), 0 skipped
**Trajectory**: R1 14 (4B/7I/3N) → R2 7 (2B/3I/2N) → R3 2 (0B/1I/1N) → R4 0 (clean)
**Unresolved at termination**: 0

## ⚠️ Execution prerequisites (read before `/ep`)
- **Invoke `/ep` from the PARENT repo** `/Users/derekbeckley/Developer/EICR_Automation` (or pass this handoff folder explicitly). This plan lives in the parent backend repo; `/ep` invoked from `CertMateUnified` will NOT find it by default.
- **Codex MCP** review/refine agents for this handoff must use `model: "gpt-5.5"`.
- **iOS TestFlight is gated**: `deploy-testflight.sh` builds from the original `/Users/.../CertMateUnified` checkout, currently dirty / on a stale `ep/` branch. Per the no-mutate-user-working-state rule, land + test the iOS code but HOLD the TestFlight push if that checkout isn't clean+on-main.

## Source
Resolves `[contract]` item #3.4 deferred from `ir-loop-lim-fix-2026-06-16` (F1AC26FB): a circuit's designation, known on iOS, never reaches the server snapshot, so server-side designation matching (ring-continuity / IR "which circuit?") fails. Two-pronged fix — iOS triggers the existing merge-aware `job_state_update` sync on designation change, plus two REQUIRED backend merge-correctness fixes (canonical-key normalisation scoped to circuit buckets; board_id-aware bucket keying with dual-shape skeleton) — and a SECONDARY shared-prompt negative-instruction.

## What `/ep` should pick up
- `PLAN-final.md` — canonical execution target. Backend wave (#3.4.4 + #3.4.5 [BE-safe] + #3.4.2 [shared-prompt]) → CI; iOS wave (#3.4.1) → TestFlight (gated, see above).
- `PLAN-conversation-context.md` — decisions/constraints/gotchas from the originating session.
- `PLAN-refine-log.md` — full /rp audit trail (4 rounds, 23 findings).

## Caveats
- Round 4 is a confirmed two-reviewer clean round: Codex returned zero findings, and the Claude reviewer (initially 529-overloaded) was re-run on PLAN-final.md and also returned zero findings, verifying every load-bearing file:line claim against both repos.
- #3.4.3 (reverse-direction server→iOS apply) is DEFERRED, not in execution scope.
- The 6 pre-existing stale `TranscriptFieldMatcherTests` failures are out of scope (separate `ios-test-suite-triage` handoff) — do NOT blind-fix when running `xcodebuild test`.
