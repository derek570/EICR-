# Loaded Barrel v7 — Post-Dispatch Trigger, Pending-Promise Cache, Parity-Version Gate

**Date:** 2026-05-24
**Supersedes:** v6 (10 BLOCKERs across Plan-agent + Codex).
**Read order:** v6 first, then this as the delta. Sections labelled
**[CHANGE]** replace v6; sections **[NEW]** are additions; v6
content not mentioned here is retained verbatim.

## v6 BLOCKER closure

| v6 BLOCKER | v7 fix |
|---|---|
| **B-N1** speculator fires from raw `tool_use.input` before dispatcher runs → predicted text diverges from bundler text | **[CHANGE]** Phase 2.B: speculator subscribes to `onDispatchedToolUse(toolName, dispatchResult)` hook, NOT `onCompletedToolUse`. Triggers ONLY when `dispatchResult.applied === true` AND `dispatchResult.snapshotPatch` is non-empty. Computes predicted text by calling `buildConfirmationText` against `perTurnWrites + snapshotPatch` (same args the bundler will receive). Same code path is now actually true. |
| **B-N2** cache-key collides across boards | **[CHANGE]** Cache key: `sha1(sessionId + ':' + turnId + ':' + boardId + ':' + field + ':' + circuit + ':' + expandedText)`. Lookup-side: keys.js needs `boardId/field/circuit` from POST. Phase 4 iOS adds those to the proxy POST body (already on the dispatched event the iOS bundler-handler receives). |
| **Codex-1** pending-synth race causes double-spend | **[NEW]** Cache entry is a `Promise<{mp3Buffer, correlationId}>` (not raw buffer). On `cache.set(key, pendingPromise)` BEFORE synth starts. iOS POST `consume(key)` awaits the pending promise (with 1500ms deadline; on timeout falls through to live POST, marks entry `superseded` to suppress speculator cache-write on completion). |
| **B-N3** iOS expandForTTS parity drift | **[NEW]** Runtime parity gate. iOS computes `sha1(rulesTable + version)` from its `AlertManager.swift` rules at build time, embeds as `Bundle.expandForTTSVersion`, sends in session_start capability handshake AND in every TTS POST as `x-expand-version` header. Backend `expandForTTS` ships the same hash from `tts-text-expander.js`. Mismatch → cache lookup skipped + telemetry `loaded_barrel_parity_mismatch` + alert. Single-source-of-truth attempt deferred to v8 (would need iOS-side code-gen from JS table). |
| **B-N4** expander rule ORDERING is load-bearing | **[NEW]** Phase 0 deliverable: ordered rule fixture file `tts-expander-rules.json` (50+ inputs) MUST include: each regex applied, expected intermediate after each, final `expandNumbers` output. Test asserts step-by-step parity, not just final output. Catches reordering regressions. |
| **B-N5** N parallel speculations per round | **[NEW]** Per-turn speculation cap = 2 (configurable env `VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN`). Picks first 2 by dispatch order. Excess emits telemetry `loaded_barrel_skipped_cap`. Justification: iOS plays one audio at a time, cancels prior on next; 2 covers the typical "value confirmed + immediate follow-up ask" pattern. |
| **B-N6** turnId rollout sequencing | **[CHANGE]** Phase order revised: iOS Phase 4 ships FIRST. Backend Phases 1-3 ship with flag default OFF for 1 TestFlight cycle. Phase 1.A "rollout-readiness probe": new endpoint `/api/voice-latency/loaded-barrel-readiness` returns adoption-% (count distinct iOS clients sending `turnId` over last 1h / total). Flag flip to ON gated on ≥80% adoption. |
| **B-N7** WASTED path double-bills | **[NEW]** New cost-tracker method `recordElevenLabsSpeculativeStarted(chars, correlationId)` writes under a sub-ledger `speculativeStreaming` (separate from `streaming`). Cache-hit promotes the speculative cost to canonical via `promoteSpeculativeToCanonical(correlationId)`. Cancelled/wasted stays in speculative sub-ledger, reported separately. Live-POST cache-miss path records under canonical `streaming` with its own correlationId. No two `streaming` starts per turn possible. |
| **Codex-2** invalidate needs slot metadata in cache | **[CHANGE]** Cache stores `{key, slot:{boardId,field,circuit}, promise, controller}` per entry. New `invalidateBySlot(sessionId, turnId, slot)` walks per-session index and aborts + drops matching entries. |
| **Codex-3** generation guard on abort race | **[NEW]** Speculator's synth-complete handler checks `if (controller.signal.aborted || entry.superseded) return;` BEFORE resolving the pending promise into a buffer entry. Aborted-after-complete is a no-op (entry already removed). |
| **Codex-4** feature flag not enforced at speculator | **[CHANGE]** Phase 2.B step 0 (new): `if (!session.voiceLatency.flags.VOICE_LATENCY_LOADED_BARREL) return;` early-return in the `onDispatchedToolUse` handler. Asserted by a unit test that sets flag false and verifies zero `recordElevenLabsSpeculativeStarted` calls under a multi-write transcript. |
| **I-N1** flush:true needs WS client change | **[CHANGE]** Phase 0 §4 expanded: if `synth(text)` already sends EOS-on-complete (it does for ≤120 char strings — verified during Phase 0), no client change needed. If buffering observed, Phase 1.B.5 adds `flushOnEosShort` mode. |
| **I-N2** memory math wrong | **[CHANGE]** Confirmed: 50ch synth × ~6KB MP3 × 50/session × 500 sessions ≈ 150MB worst case. Cap revised: per-session 20, global 200 = ~24MB. Rationale: speculator is per-turn, sessions rarely accumulate 50 unconsumed entries. |
| **I-N3** same-round sequential record→clear | **[NEW]** Phase 6 scenario `loaded_barrel_same_round_record_then_clear.yaml`. Test asserts cache contains 0 entries for that slot after both dispatches. |
| **I-N4** field detection of audibly-wrong | **[NEW]** Phase 5 invariant test: per turn, assert `bundler.confirmations[].text` set is a SUPERSET of speculator-cached texts for that turn. Field telemetry emits `loaded_barrel_text_drift_detected` when not. Goes to CloudWatch metric. |
| **I-N5** retry-after-consume falls to live | accepted — minor, not a blocker; pin a follow-up in v7.1 |
| **I-N6** single source for confidence threshold | **[CHANGE]** Phase 1.B export adds explicit unit test: speculator and bundler call same `shouldGenerateConfirmation(reading)` predicate from leaf module; mutation in one fails test for other. |
| **Codex-5** pending-miss row missing from cost table | **[CHANGE]** Cost table adds row: PENDING (POST arrives during synth) — speculator cost $0.0025 / live cost $0 (POST awaits, no live synth fires). 5th category in scenario mix. |

## [NEW] Phase ordering revision (v7)

| Phase | Lands on | When | Flag |
|---|---|---|---|
| 0 Research | n/a | week 1 | n/a |
| 1.A cost-rate prep | main | week 2 day 1 | n/a |
| 1.B-D bundler exports + expander + telemetry | main | week 2 day 2 | n/a |
| 1.E flag declaration (OFF) | main | week 2 day 3 | OFF |
| 1.F readiness probe endpoint | main | week 2 day 3 | n/a |
| **4 iOS** — turnId + boardId/field/circuit + parity-version | TestFlight | week 2 day 4 | n/a |
| 2 Speculator + cache + lifecycle hooks | main | week 3 day 1 | OFF |
| 3 keys.js short-circuit | main | week 3 day 2 | OFF |
| **gate** — adoption ≥80% on readiness probe | n/a | wait | n/a |
| flag flip to ON for 1% sessions | live | week 4 | 1% |
| ramp 1% → 10% → 50% → 100% | live | week 4-5 | up |
| 5/6/7 invariant tests + harness + field | continuous | weeks 3-7 | n/a |

## [CHANGE] Effort revision

| Item | Days |
|---|---|
| Phase 0 (expanded with ordered fixtures + version-hash spec) | 6 |
| Phase 1 (A-F, 6 sub-tasks) | 3 |
| Phase 2 (post-dispatch hook + pending-promise cache + per-turn cap + speculative cost ledger) | 7 |
| Phase 3 (keys.js short-circuit + await semantics) | 1 |
| Phase 4 iOS (turnId + slot fields + parity-version) | 2 backend + 2 iOS + TestFlight cycle |
| Phase 5 invariants (incl. text-drift detector) | 3 |
| Phase 6 harness (10 scenarios incl. drift, race, multi-board) | 3 |
| Phase 7 field assessment | 0 (2 wks wall) |
| **Total** | **25 backend + 2 iOS + 2 wks field** |

## Open issues acknowledged (NOT blockers, deliberately deferred)

- **OD1.** Single-source-of-truth for expandForTTS rules. v7 ships parity-version gate (mismatch → skip). v8 should consider code-gen.
- **OD2.** Multi-context ElevenLabs WS pooling. v7 opens fresh client per speculation (cold BOS ~340ms). v8 could pool per session.
- **OD3.** "Loaded Barrel" name overlaps with sprint naming convention (Plan N1). Cosmetic.
- **OD4.** Cost-model HIT rate assumption (70%) vs rollback gate (50%) gap. Phase 7 measures; if rate consistently <70%, cost rises — re-evaluate.

## What v7 is still NOT solving

- **Multi-round Sonnet latency floor**. Loaded Barrel saves ~470ms on the FINAL synthesis step. Sonnet's 3-round tool loop (≈3.5s) is unchanged. To hit 2-2.5s on multi-round turns requires the prompt-side single-round-preference work (v5 Workstream A). That is a SEPARATE sprint and is documented as such.

## Decision gate (re-stated)

Three pre-code checks (UNCHANGED from v6):
1. iOS `AlertManager.expandForTTS` rules captured + parity tests pass
2. ElevenLabs WS short-text behaviour verified
3. `turnId` + slot metadata + parity-version round-trip verified on TestFlight build

PLUS new v7 fourth check:
4. Readiness-probe endpoint reports ≥80% iOS adoption of `turnId` before flag flips to ON.
