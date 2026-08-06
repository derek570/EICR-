# HANDOFF — surge-protection-box

**Entry point for `/ep`**: `PLAN-final.md` in this directory.

**Status**: DONE (clean — both reviewers zero BLOCKER/IMPORTANT for a full round)
**Rounds**: 9
**Findings**: 37 applied (5 blocker, 27 important, 5 nit), 0 skipped
**Trajectory** (B/I/N per round): R1 3/9/3 → R2 2/4/1 → R3 1/5/2 → R4 0/1/0 → R5 0/1/0 → R6 0/2/0 → R7 1/1/0 → R8 0/8/1 → R9 0/0/0
**Unresolved at termination**: 0

## Source

Closes a field-test issue (session F1AC26FB, 2026-06-16): an inspector said "the main fuse" and it landed in the on-screen "Supply Protective Device (SPD)" box. Routing was correct, but the `(SPD)` label reads as *Surge Protection Device* and there was no box for an actual surge device. The plan (1) relabels the misleading box, (2) splits the conflated picker, and (3) adds a real Surge Protection Device (`surge_*`) box — across backend Node, web Next.js, iOS SwiftUI, Python PDF + Streamlit editor. Root cause documented in §0: `spd_*` was a live semantic collision (voice/PDF/schema = supply protective device; web/doc-prompts = surge). Resolution = Option A (`spd_*` stays = supply protective device; additive `surge_*` = surge).

## ⚠️ Execution preflight (critical)

Invoke `/ep` from `/Users/derekbeckley/Developer/EICR_Automation` (the HUB repo), NOT from `CertMateUnified` — this handoff folder is parent-repo-relative, so a CWD inside `CertMateUnified` makes `/ep`'s scan miss it.

## What `/ep` should pick up

- `PLAN-final.md` — canonical execution target. Sliced A→D; backend (Slice B) ships via CI and rolls out on ECS BEFORE the iOS TestFlight build (Slice C). 3a-CCU is a cross-platform precondition that gates the relabel release.
- `PLAN-conversation-context.md` — decisions/constraints/gotchas from the originating session.
- `PLAN-refine-log.md` — full 9-round /rp audit trail.

## Caveats

- No Codex failures after round 1 (round-1 first Codex call retried once for a schema `additionalProperties` error, then succeeded). All 9 rounds had both reviewers.
- The plan deliberately uses general instructions (the §3a grep-ALL across `config/prompts/*.md` + `src/**/*.js`, "derive allowlists from `field_schema.json`", "verify-or-document-legacy") to catch residual instances at execution time rather than enumerating every line — `/ep` should honour those sweeps, not skip them.
- Several `/api/recording/*` extraction prompts + `eicr_editor.py` are flagged as LIKELY-LEGACY (current iOS/web record via `/api/sonnet-stream`): `/ep` must VERIFY live-vs-dead, then fix-for-completeness OR document as dead — do not silently skip.
- Backend changes are SHARED with iOS (immutable-without-mandate rule); this IS the user's explicit cross-platform mandate. Ship backend first.
