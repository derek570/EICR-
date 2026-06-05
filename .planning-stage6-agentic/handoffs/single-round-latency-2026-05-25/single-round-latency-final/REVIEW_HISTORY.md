# Review History — Single-Round Latency Sprint

8 rounds to converge. Locked plan: PLAN_v8 (cumulative pivots from v2 onward; see SINGLE_ROUND_LATENCY_PLAN_FINAL.md).

| Round | Plan | Claude Plan-agent | Codex CLI (gpt-5.5 xhigh) | Net BLOCKERs |
|---|---|---|---|---|
| 1 | PLAN.md (v1) | 5 BLOCKERs / 9 IMPORTANTs / 7 NITs — DO NOT SHIP | 10 BLOCKERs / 8 IMPORTANTs / 5 NITs — DO NOT SHIP | 15 |
| 2 | PLAN_v2.md | 0 BLOCKERs / 4 IMPORTANTs / 4 NITs — SHIP after IMPORTANTs | 2 BLOCKERs / 6 IMPORTANTs / 5 NITs — DO NOT SHIP | 2 |
| 3 | PLAN_v3.md | 0 BLOCKERs / 3 IMPORTANTs / 5 NITs — SHIP after IMPORTANTs | 2 BLOCKERs / 7 IMPORTANTs / 5 NITs — DO NOT SHIP | 2 |
| 4 | PLAN_v4.md | 1 BLOCKER / 4 IMPORTANTs / 5 NITs — DO NOT SHIP | (rate-limited until 11:01) | 1 (Claude only) |
| 5 | PLAN_v5.md | 0 BLOCKERs / 0 IMPORTANTs / 2 NITs — SHIP | 1 BLOCKER / 2 IMPORTANTs — DO NOT SHIP | 1 |
| 6 | PLAN_v6.md | 0 BLOCKERs / 2 IMPORTANTs / 1 NIT — SHIP after IMPORTANTs | 1 BLOCKER / 2 IMPORTANTs / 1 NIT — DO NOT SHIP | 1 |
| 7 | PLAN_v7.md | 0 BLOCKERs / 0 IMPORTANTs / 1 observation — SHIP (missed scope contradiction) | 1 BLOCKER / 1 IMPORTANT — DO NOT SHIP | 1 |
| **8** | **PLAN_v8.md** | **0 BLOCKERs / 0 IMPORTANTs / 1 NIT — SHIP** | **0 BLOCKERs / 0 IMPORTANTs / 1 NIT — SHIP** | **0 ✅ CONVERGED** |

## Round-by-round BLOCKER lifecycle

### Round 1 BLOCKERs (15 total)
- **Claude B1-B5:** prompt-change misunderstanding of Anthropic tool_use contract; Sonnet-text-vs-cache-key trilemma; fast-write WS shape conflicts; hint plumbing incomplete; race catalogue incomplete.
- **Codex B1-B10:** ditto B1; cache parity Option 3 inconsistent (period in Sonnet text); model-text plumbing not wired; Phase 1 internally inconsistent (skip vs parallel); fast-write bypasses dispatcher; decoupled TTS+write can confirm uncommitted; regexResolvedSlots lifetime wrong; designation matching not safe iOS target; candidate omits boardId; Phase 0 telemetry cannot prove gates.

### Round 2 (v2 — 3 pivots): closed 13/15
- Pivot 1: Phase 2 = server-side runToolLoop early-terminate (not prompt) → closed Claude B1, Codex B1.
- Pivot 2: Phase 1 = Mode A only (audio-only; Sonnet authoritative) → closed Codex B4-B9 + Claude B3-B5.
- Pivot 3: Cache parity = friendly-name canonical → closed Claude B2 + Codex B2, B3.
- **Remaining (Codex):** B-v2.1 telemetry emission model; B-v2.2 rejected fast-TTS must not native-fallback.

### Round 3 (v3 — 4 new pivots): same 2 Codex BLOCKERs remain
- Pivot 4: iOS-side suppression (not backend).
- Pivot 5: 4xx/kill-switch REJECTS local synthesis → closed Codex B-v2.2.
- Pivot 6: Telemetry expanded (12 new fields + /playback-ack endpoint).
- Pivot 7: Speculator skip on fast-tts hint.
- **Codex B-v3.1 (still):** telemetry single end-of-turn drain can't capture iOS ACKs in time.
- **Codex B-v3.2 (NEW):** Pivot 7 misunderstands speculator's two entry points (onToolUseStreamed + onSnapshotPatch).

### Round 4 (v4 — 5 new pivots): Codex rate-limited; Claude finds 1 new BLOCKER
- Pivot 8: turn_summary splits into core+audio with delayed finalizer → closes Codex B-v3.1.
- Pivot 9: skip moves into `_speculate()` covering both entry paths → closes Codex B-v3.2.
- Pivot 10: iOS 4-state machine for bundler-while-fast-pending race.
- Pivot 11: speculator `abortBySlot` API.
- Pivot 12: `pendingFastTtsSlots` cleanup contract.
- **Claude B-v4.1:** Pivot 11's cost-tracker contract self-contradictory (terminal enum value vs opts flag).

### Round 5 (v5 — 8 pivot deltas): Codex returns; finds 1 new BLOCKER
- Pivot 11.1: cost-tracker signature reconciled to `(correlationId, terminal, opts)` → closes Claude B-v4.1 structurally.
- Pivots 10.1, 11.2, 12.1, 8.1, 10.2, 11.3, 12.2, 8.2: deferredTTS interaction, type normalization, getActiveSessionEntry helper, late-ACK separate row, state-count correction, pendingControllers preservation, cleanup rationale correction, expected-ACK formula correction.
- **Codex B-v5.1:** `cancelledBeforeTextSent` only skips `charsCancelled` but `recordElevenLabsSpeculativeStarted` already incremented `charsStarted` AND `elevenLabsCharacters` BEFORE `client.synth()`. Cost integrity not preserved.

### Round 6 (v6 — 3 pivot deltas): Both reviewers find 1 BLOCKER each
- Pivot 11.4: move `recordElevenLabsSpeculativeStarted` to text-sent boundary (Codex's preferred Option 1).
- Pivot 8.3: decrementExpectedAcks keyed by `regex_fast_correlation_id` with deferred-stash.
- Pivot 11.5: G0 gate pairing split.
- **Claude I-v6.1:** `session.fastPathCorrelationIdByTurn` referenced but plumbing not pinned.
- **Claude I-v6.2:** `cacheKeyForCorrelation(correlationId)` helper does not exist.
- **Codex B-v6.1:** `_maybeRecordTerminal` uses cache entry as ledger-open guard, but cache deletes entries during supersede/prune/TTL/invalidate BEFORE deferred terminal handlers run → orphan `charsStarted` without matching terminal bucket.

### Round 7 (v7 — 4 pivots): Codex finds 1 new BLOCKER
- Pivot 11.6: durable `costOpenByCorrelation` Set outside cache (claimed module-level by code block, "speculator-local" by prose).
- Pivot 8.4: full `fastPathCorrelationIdByTurn` 6-step lifecycle → closes I-v6.1.
- Pivot 11.7: `_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)` signature with cacheKey diagnostic-only → closes I-v6.2.
- Pivot 11.8: cost-invariant assertion in test code only.
- **Codex B-v7.1:** v7's scope contradiction — `costOpenByCorrelation` declared module-level but described as speculator-local. Cross-session shutdown would close another session's correlation against wrong tracker.
- **Codex I-v7.1:** New telemetry events not in `SERVER_OUTCOMES` enum.

### Round 8 (v8 — 3 pivot deltas): **CONVERGED**
- Pivot 11.9: `costOpenByCorrelation` moved INSIDE `createSpeculator()` closure with snapshot-before-iteration → closes Codex B-v7.1.
- Pivot 11.10: direct `logger.info` for two new event names (NOT through `recordOutcome`) → closes Codex I-v7.1.
- Pivot 11.11: dual-dedup-gate documentation.

**Both reviewers independently confirm ZERO BLOCKERs at v8.**

## Cumulative pivot count

| Pivot | Introduced | Final status |
|---|---|---|
| 1 — Phase 2 = server-side runToolLoop early-terminate | v2 | LOCKED |
| 2 — Phase 1 = Mode A only (audio-only; Sonnet authoritative) | v2 | LOCKED |
| 3 — Cache parity = friendly-name canonical | v2 | LOCKED |
| 4 — Suppression moved BACKEND → iOS | v3 | LOCKED |
| 5 — 4xx/kill-switch REJECTS local synthesis | v3 | LOCKED |
| 6 — Telemetry expanded with /playback-ack endpoint | v3 | LOCKED |
| 7 — Speculator skip on fast-tts hint | v3 | LOCKED |
| 8 — Split telemetry rows + delayed finalizer | v4 | LOCKED (refined 8.1, 8.2, 8.3, 8.4) |
| 9 — Skip check inside `_speculate()` shared preflight | v4 | LOCKED |
| 10 — 4/5-state iOS state machine | v4 | LOCKED (refined 10.1, 10.2) |
| 11 — speculator `abortBySlot` + cost integrity | v4 | EVOLVED (11.1→11.4→11.6→11.9 final) |
| 12 — Cleanup contract pinned (try/finally) | v4 | LOCKED (refined 12.1, 12.2) |

## Files

- `SINGLE_ROUND_LATENCY_PLAN_FINAL.md` — the locked plan (v8 content + convergence header).
- `EXECUTION_HANDOFF.md` — orientation doc for the executor session.
- `PRIOR_VERSIONS/PLAN_v1.md` through `PLAN_v8.md` — all 8 draft versions.
- `PRIOR_VERSIONS/claude-review*.md` (8 files) — every Claude round verdict.
- `PRIOR_VERSIONS/codex-review*.md` (8 files) — every Codex round verdict.
