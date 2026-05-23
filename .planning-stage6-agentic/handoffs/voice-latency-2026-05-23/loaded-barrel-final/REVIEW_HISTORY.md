# Loaded Barrel — Review History (audit trail)

9 review rounds across 9 plan revisions. Both reviewers (Claude
Plan-agent + Codex gpt-5.5) run in parallel on each revision.

| Rev | Plan-agent BLOCKERs | Codex BLOCKERs | Aggregate distinct | Notes |
|---:|:---:|:---:|:---:|---|
| v1 | 4 | 3 | 7 | First draft — fire-and-skip approach. Tool-call ordering, prompt unenforceable, billing race, no abort path. |
| v2 | 4 | 3 | 7 | Server-side cache w/ predicted text. NEW BLOCKERs: value normalisation drift, helpers unexported, multi-context contextId, cost double-count, no assembler hook, confidence threshold, no in-flight dedupe. |
| v3 | 3 | 2 | 5 | Shared `predictConfirmationText` helper. NEW: ESM cycle, pre/post-dispatch race, dispatcher verbatim values, hook only streaming path, pruneForSession can't cancel. |
| v4 | 3 | 2 | 5 | Prompt + speculator + late-commit buffer. NEW: tool_choice shape wrong, ElevenLabsStreamClient can't do incremental, runToolLoop post-loop only, extraction_supplement not a wire type, double-speak risk. |
| v5 | 4 | 3 | 6 | Dropped tool_choice change, new ElevenLabsIncrementalClient, lifecycleHooks. NEW: B5 iOS AlertManager text expansion, B6 PCM-vs-MP3 format, B1-B4 enumerated, I1 TTL too short. |
| v6 | 7 | 5 | 10 | Strategy shift: predict from tool_use args + iOS-parity expander. NEW: speculator-vs-dispatcher race (B-N1), multi-board key collision (B-N2), parity drift trap (B-N3+B-N4), N parallel speculations (B-N5), turnId rollout (B-N6), WASTED double-bill (B-N7) + Codex equivalents. |
| v7 | 3 | 3 | 5 | Wrapper-diff, pending-promise cache, parity-version gate. NEW: onDispatchedToolUse missing (B-V7-1), 1500ms HTTP timing (B-V7-2), iOS-first single-TestFlight unachievable (B-V7-3), boardId not on wire (Codex-2), build-time hash unreliable (Codex-3). |
| v8 | 1 | 1 | 1 | SAME blocker both reviewers: multi-board 1→2 transition leaves stale un-board-keyed cache entries (BL1 / Codex-1). |
| v9 | **0** | **0** | **0** | Both reviewers explicitly say "ship-ready". Adds prune-on-add_board, restricts diff scope, timer-race re-peek, state machine frozen. |
| **FINAL (v10)** | n/a | n/a | n/a | Integrates v9's IMPORTANT tightenings (board-switch prune, raw-patch in wrapper payload, ready→aborted arrow, select_board op name, ordering invariant on cached promise, claimed-removal-not-state-transition, cap on mismatched_samples). |

## Convergence pattern

```
BLOCKERs:  7  7  5  5  6 10  5  1  0
revision:  1  2  3  4  5  6  7  8  9
```

Non-monotonic until v6 — each round surfaced a deeper coupling layer
(prompt, ElevenLabs WS, runToolLoop API, iOS wire, AlertManager text
expansion, MP3 format). After v6 the strategy shift to wrapper-diff +
post-dispatch trigger was a one-way move: v7→v8→v9 all monotonically
decreased. The single v8 BLOCKER was found independently by both
reviewers (high signal-to-noise) and v9's fix is mechanical.

## Reviewer agreement

Of the ~50 findings across 9 rounds, both reviewers independently
flagged the same issue ~6 times. Most rounds had ≥1 cross-validated
finding. The v8 single BLOCKER was the only round where the only
BLOCKER was identically called out by both reviewers — strong signal
that v9 was right to close it as priority 1.

## What changed between v9 (approved) and FINAL (v10)

v9 was approved with ZERO BLOCKERs but 4-5 IMPORTANT findings per
reviewer. v10 FINAL integrates the following IMPORTANT tightenings,
none of which changed architecture:

1. **Plan I1** — Board-switch prune (not just board-add). On
   `select_board` op, drop cache entries where `slot.boardId !==
   snapshot.currentBoardId`.
2. **Plan I2** — Wrapper-diff payload carries both narrowed diff AND
   raw patch (so prune subscribers see boardOps).
3. **Plan I5 / Codex I3** — State-machine `ready → aborted`
   (board_transition) arrow added explicitly; claimed/aborted/
   ttl_expired are terminal; physical-removal isn't a state
   transition.
4. **Codex I1** — Op naming corrected: `select_board` (matches
   stage6 codebase), not `change_current_board`.
5. **Codex I2** — Lookup-side guard for hot-replace scenarios:
   if session requires board keying but client lacks 4b slot fields,
   skip cache lookup entirely.
6. **Codex I3 part 2** — Speculator's cached promise resolves ONLY
   after `markReady` CAS succeeds (ordering invariant asserted by
   fuzz test).
7. **Codex N1** — `loaded_barrel_text_drift` CloudWatch alert needs
   minimum-denominator threshold + cap on `mismatched_samples`
   array (don't fire on low volume; don't blow up CloudWatch
   payload).
