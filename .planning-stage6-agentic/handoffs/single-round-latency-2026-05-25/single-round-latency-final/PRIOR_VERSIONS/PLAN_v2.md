# Single-Round Latency Sprint — Plan v2

**Date:** 2026-05-25
**Status:** DRAFT — pending round 2 review.
**Supersedes:** PLAN.md (v1). Addresses 5 BLOCKERs from Claude review + 10 BLOCKERs from Codex review by making three structural pivots locked in §A.
**Revision history:** see end of file.

---

## §A — Pivots locked in v2 (each closes multiple BLOCKERs)

### Pivot 1 — Phase 2 is a SERVER-SIDE `runToolLoop` early-terminate, NOT a prompt change.

Closes Claude B1, Codex B1, Codex I5.

Anthropic's API sets `stop_reason` based on response content. The model cannot emit `[text][tool_use][stop_reason: end_turn]` — when a `tool_use` block is present, `stop_reason` is always `tool_use`. Telling the prompt to do so is wishful thinking AND would make `runToolLoop` skip the dispatch path (line 441 — `if (stop_reason !== 'tool_use') break;`), losing the write entirely.

**New design:** after round 1's dispatch loop runs to completion, evaluate a new `shouldEarlyTerminate(records, toolResults, perTurnWrites)` predicate. When TRUE, `runToolLoop` synthesises a virtual "round 2 acknowledgement" (matches the legacy two-round wire shape via the existing assistant-message append + an empty user tool_results array), but skips the round-2 `client.messages.stream` invocation entirely. The bundler runs as today.

`shouldEarlyTerminate` returns TRUE iff ALL hold:
- Exactly one `record_reading` dispatched with `outcome: 'ok'`.
- No `record_board_reading`, `record_observation`, `clear_reading`, `create_circuit`, `rename_circuit`, `delete_circuit`, `ask_user`, `start_dialogue_script`, `add_board`, `select_board`, `mark_distribution_circuit`, `set_field_for_all_circuits`, `calculate_zs`, `calculate_r1_plus_r2`, `delete_observation` in the round-1 records.
- No `tool_result.is_error: true` (the dispatcher rejected nothing).
- `session.currentBoardId === main` (multi-board sessions stay safe — pivot to round 2 to let Sonnet handle).

If FALSE, the loop continues normally — Sonnet round 2 fires as today.

**Latency saving:** ~2-2.5s per turn that satisfies `shouldEarlyTerminate`. Field-test traces show ~70% of routine `record_reading` turns satisfy it.

**Cost saving:** Sonnet round 2 input + output dropped on eligible turns. ~50% Sonnet cost reduction on the dominant turn shape.

**Risk:** if `shouldEarlyTerminate` returns TRUE on a turn that actually needed round 2 (e.g. a model that wanted to emit a corrective `ask_user` in round 2), the bundler ships without it. Mitigation: predicate is intentionally CONSERVATIVE — single, clean, single-board record_reading only. Anything else fails the predicate and Sonnet runs round 2 as today. Multi-value, corrections, observations, board ops, errors all keep the existing two-round contract.

### Pivot 2 — Phase 1 is Mode A ONLY (fast AUDIO, Sonnet remains authoritative for writes).

Closes Codex B4, B5, B6, B7, B8, B9 + Claude B3, B4, B5.

The v1 plan tried to do two things at once: (a) audible-latency win via the fast-TTS path; (b) Sonnet-bypass via paired fast-write. (b) was the source of every Phase 1 BLOCKER — race catalogue gaps, dispatcher-contract breakage, designation drift, boardId omission, etc.

**v2 drops (b) entirely.** Phase 1 only ships the fast-TTS endpoint (already exists as Stage 4 PoC at `src/routes/voice-latency-fast-tts.js`). Every reading still goes through Sonnet's normal `record_reading` path for the actual data write. The fast-TTS endpoint produces audible confirmation in ~420ms; Sonnet's normal flow writes the data over the same ~4.7s as today.

**What inspectors hear:** confirmation TTS lands at ~420ms (vs ~4.7s today on the same turn). The DATA still takes ~4.7s to reach the certificate, but the audible UX feels instant.

**What this gives up vs Mode B:** no Sonnet cost reduction on fast-path turns (Sonnet still runs). Acceptable — the latency goal is audible UX, not cost.

**Mode B (paired fast-write) is explicitly deferred to a hypothetical v3-of-this-plan, gated on Phase 2 + Mode A failing to close the 2.5s gap.**

### Pivot 3 — Cache parity: friendly-name is the SINGLE source of truth across speculator, bundler, and iOS POST.

Closes Claude B2, Codex B2, Codex B3.

The v1 plan's "Sonnet's text drives the audible" promise inherently conflicts with the Loaded Barrel cache key, which hashes `expandForTTS(friendly-name-text)` at speculate-time. If iOS later POSTs Sonnet's-text, the hash differs and every HIT becomes a MISS.

**v2 locks:** `confirmation-text.js:buildConfirmationText(field, value, circuit)` is the SINGLE source of confirmation text everywhere — speculator (cache key), bundler (`confirmations[].text` wire field), iOS POST body (which iOS reads from `confirmations[].text`). Sonnet's emitted text is NOT used for the audible confirmation, ever. The bundler also ships a new `confirmations[].expanded_text` field carrying the server's `expandForTTS` output, so iOS uses the expanded text verbatim instead of re-running expansion (eliminates any iOS-vs-backend expandForTTS drift on the cache-key path too).

This means Phase 2's prompt does NOT need a text-before-tool addition. The early-terminate happens server-side regardless of what Sonnet emits in round 1 text blocks; round-1 text blocks (if any) are simply discarded by the assembler as today.

**Trade-off accepted:** any expressiveness Sonnet would bring to the confirmation text ("Recorded the cooker's R1+R2 as 0.7 ohms — that looks good") is dropped in favour of friendly-name's "Circuit 1, R1 plus R2 0.7". Inspectors get less colour; they get instant + deterministic audio. v1 reviewer Codex I2 also flagged that letting Sonnet's text reach the audible is a prompt-injection / verbosity-drift surface — friendly-name closes that hole.

---

## TL;DR (updated)

Three sequential phases, each independently shippable behind env flags:

| Phase | Effort | What | Latency saving | Cost |
|---|---|---|---|---|
| **0 — Telemetry** | 1-2 days backend | `turn_summary` row per turn with full protocol+dispatch+cache+playback facts | enables measurement | ~0 |
| **1 — Mode-A fast-TTS** | 3-5 days backend + 8-10 days iOS | iOS regex matcher widened to 5 more patterns; fast-TTS endpoint productionised with MP3-only output, boardId scoping, eligibility whitelist; Sonnet still runs in parallel for the data write | ~420ms audible on covered turns | +$0.0025/covered turn (ElevenLabs synth pre-paid) |
| **2 — Server-side early-terminate** | 5-8 days backend (incl. review) | `runToolLoop` `shouldEarlyTerminate(records, toolResults, perTurnWrites)` skips round-2 invocation on single-clean-record_reading turns | ~2-2.5s on eligible turns | −50% Sonnet cost on eligible turns |

**Combined effect on the dominant turn shape (single-value record_reading, fast-path-eligible):** audible drops from ~4.7s → ~420ms. **NOT eligible turns (multi-value, corrections, observations, ask_user):** stay at ~4.7s — Sonnet's reasoning room preserved.

**Phase 3 — Haiku-on-round-2 — explicitly OUT of v2.** Codex I6 + the conditional-trigger ambiguity made it unsuitable for this sprint. If Phases 0+1+2 don't hit 2.5s on the eligible distribution, a separate v3 sprint handles Phase 3.

---

## §B — Phase ordering invariant

Closes Claude I1.

Phases land on `main` in this STRICT order with explicit gates between:

```
Phase 0 deploys → wait 24h, verify `turn_summary` rows in CloudWatch (gate G0) →
Phase 1 backend deploys → iOS TestFlight build with regex extension + fast-TTS POST →
   wait for ≥80% iOS adoption via readiness probe (gate G1.iOS) →
Phase 1 prod flag flip → 1-week field test (gate G1) →
Phase 2 deploys behind flag `VOICE_LATENCY_ROUND1_EARLY_TERMINATE=false` →
   harness adoption rate ≥90% on canonical scenarios (gate G2.harness) →
Phase 2 prod flag flip 1% → 10% → 50% → 100% over 1 week (gate G2) →
1-week field-test convergence (gate G3) →
sprint complete
```

No phase ships before its predecessor's gate passes. Hard rule — flagged in commit messages, in the executor handoff doc, and in CI's deploy-precheck script (new `scripts/check-phase-ordering.sh`).

---

## §C — Phase 0 detailed (telemetry)

Closes Claude I2, Codex B10, Codex I4, Codex N5.

### What ships

**New module:** `src/extraction/voice-latency-turn-summary.js`
- Exports `emitTurnSummary({sessionId, turnId, ...})` — single function that takes the union of all required facts and emits one CloudWatch log row per turn with structured fields.

**New runToolLoop return field:** `round_timings: [{round_idx, started_ms, stream_complete_ms, dispatch_complete_ms, stop_reason}]`
- Captured in the for-await loop. One entry per round actually executed.
- Returned alongside existing `{stop_reason, rounds, tool_calls, ...}`.

**`runShadowHarness` extends `runLiveMode`** to call `emitTurnSummary` at end-of-turn with the full union of facts.

**New `turn_summary` log row shape (single CloudWatch event per turn):**

```json
{
  "sessionId": "...",
  "turnId": "...",
  "path": "fast_path" | "sonnet_lb_hit" | "sonnet_lb_miss" | "sonnet_no_lb" | "early_terminate",
  "rounds": 1 | 2,
  "stop_reason_per_round": ["tool_use", "end_turn"],
  "tool_call_count_per_round": [3, 0],
  "tool_error_count_per_round": [0, 0],
  "early_terminate_predicate": { "fired": true, "reason": "single_clean_record_reading" },
  "sonnet_round1_ms": 2014,
  "sonnet_round2_ms": null,
  "dispatch_total_ms": 5,
  "bundler_ms": 12,
  "audible_first_byte_ms": 2580,
  "audible_first_byte_source": "loaded_barrel_hit" | "loaded_barrel_pending_race" | "live_synth" | "fast_tts",
  "cache_key_text_source": "friendly_name",
  "fast_path_outcome": "n/a" | "tts_only_success" | "tts_only_skipped_multi_board" | "tts_only_failed",
  "ios_playback_first_frame_ms": 2630
}
```

`audible_first_byte_ms` is measured server-side as the timestamp when `res.write(mp3_first_chunk)` fires in `keys.js` or `voice-latency-fast-tts.js`, relative to the turn's `Extracting from transcript` timestamp.

`ios_playback_first_frame_ms` is measured client-side via a new iOS log emit (Phase 1 work) and POSTed back as a turn-end POST (gated on iOS capability). Until iOS ships that capability, the field is `null` and we use `audible_first_byte_ms` as the headline metric.

### Verification gate G0

- `turn_summary` rows present in CloudWatch for ≥99% of turns within 24h of Phase 0 deploy. Audited via a 1-line CloudWatch Insights query: `stats count() by sessionId | sort count desc`.
- The `early_terminate_predicate.fired` field is FALSE on all current production turns (Phase 2 not deployed yet — this is a baseline check).

### Things NOT to break

- Existing `voice_latency.outcome` events — unchanged.
- The cost-tracker ledger — unchanged.
- Existing `stage6_live_extraction` log row — unchanged. `turn_summary` is a SEPARATE row.
- `onLoopComplete` speculator hook — unchanged. The new `runToolLoop` return field is additive; the hook payload unchanged.

### Cost

~3 log rows per turn × ~500 bytes = ~1.5KB / turn × 1000 turns/day = ~1.5MB/day CloudWatch ingestion. Negligible.

### Rollback

Phase 0 is observation-only. No rollback needed except to revert the commit if the new log row malforms — `emitTurnSummary` wrapped in try/catch; any throw logs `turn_summary_emit_error` and continues.

---

## §D — Phase 1 detailed (Mode-A fast-TTS)

Closes Claude B3/B4/B5 + Codex B4/B5/B6/B7/B8/B9 (all eliminated by Mode-A restriction).

### Scope

iOS-side regex matcher widens to recognise 5 more dictation patterns. When a pattern matches AND the matched candidate satisfies a strict eligibility predicate, iOS:
1. POSTs `regex-fast-tts` (existing endpoint, productionised in this phase) for audio.
2. **In parallel, also continues to send the transcript via WS to the Sonnet path as normal.**

Sonnet's normal flow runs and writes the data. iOS gets fast TTS audio in ~420ms via the fast endpoint. The fast endpoint does NOT write to the snapshot.

This is intentionally a redundant-audio architecture: iOS will hear the fast confirmation FIRST, and may also hear Sonnet's normal confirmation later. Mitigation: iOS attaches the fast-path's `correlation_id` to the WS transcript message; backend's bundler at end-of-Sonnet-turn checks for "fast-path already played for this turn" and SUPPRESSES the bundler's confirmation emission for that slot. Single hint, single suppression.

### Files (backend)

- `src/routes/voice-latency-fast-tts.js` — productionise. Specifically:
  - **Force MP3 output** (`outputFormat: 'mp3_22050_32'`) so iOS uses its existing `AVAudioPlayer` path. Drop the PCM/streaming-HTTP-audio strategy (Codex I5).
  - **Add eligibility whitelist** (closed enum, exported from new `src/extraction/regex-fast-eligibility.js`): `measured_zs_ohm`, `r1_r2_ohm`, `ir_live_earth_mohm`, `ir_live_live_mohm`, `number_of_points`, `rcd_time_ms`. Polarity_confirmed REMOVED from v2 eligibility — Codex I7's checkmark drift is real.
  - **Validate boardId** on every request. If `req.body.boardId !== session.currentBoardId`, return 409 `wrong_board`. iOS falls back to live synth via the existing AlertManager retry path.
  - **Validate circuit_ref exists** in the snapshot — if not, return 409 `unknown_circuit`. iOS falls back.
  - **Reuse `buildConfirmationText`** from `confirmation-text.js` — DELETE the local `FRIENDLY` table in `voice-latency-fast-tts.js` (Codex N4).
  - **Reject non-eligible fields** with 4xx. iOS today doesn't call this endpoint so no field regression (Codex I4 spoiler confirmed by grep: zero iOS callers).

- `src/extraction/regex-fast-eligibility.js` (NEW) — exports `REGEX_FAST_ELIGIBLE_FIELDS` set + `isRegexFastEligible(field)` helper.

- `src/extraction/stage6-event-bundler.js` — bundler reads `session.fastPathConfirmationsByTurn: Map<turnId, Set<"field::circuit::boardId">>` (new per-session state). When emitting `confirmations[]`, suppresses any entry whose slot is in the set. Set is populated by the fast-tts endpoint on successful TTS stream completion.

- `src/extraction/eicr-extraction-session.js` — new `this.fastPathConfirmationsByTurn = new Map()`. Cleared at session-start. Per-turn entries auto-expire after the turn ends.

### Files (iOS)

- `Sources/Processing/TranscriptFieldMatcher.swift` — add 5 new regex patterns:
  - `"^Circuit (\d+) Zs (point )?(\S+)$"` → measured_zs_ohm
  - `"^Circuit (\d+) R1 plus R2 (point )?(\S+)$"` → r1_r2_ohm
  - `"^Circuit (\d+) number of points (\d+)$"` → number_of_points
  - `"^Circuit (\d+) insulation live (?:to )?earth (\S+)$"` → ir_live_earth_mohm
  - `"^Circuit (\d+) insulation live (?:to )?live (\S+)$"` → ir_live_live_mohm
  - All other patterns intentionally NOT covered in v2 — designation-based matches deferred per Codex B8.

- `Sources/Services/APIClient.swift` — new `proxyRegexFastTTS(sessionId, transcript, candidate, boardId, correlationId)` method posting to `/api/voice-latency/regex-fast-tts`. Returns audio bytes for AVAudioPlayer.

- `Sources/Services/ServerWebSocketService.swift` — sendTranscript adds optional `regex_fast_correlation_id: String?` field. Set when iOS already dispatched a fast-tts POST for this transcript.

- `Sources/Services/ServerWebSocketService.swift:sendSessionStart` — capability handshake adds `voice_latency.supports = [..., "regex_fast_v2"]` (Codex N2 — single new bit, not two).

### Race catalogue (v2-complete)

**Race A — iOS fast-tts succeeds; Sonnet ALSO emits its confirmation later.**
Resolution: bundler suppresses via `fastPathConfirmationsByTurn` set. iOS hears one audible (the fast one).

**Race B — iOS fast-tts FAILS (timeout, 5xx); Sonnet succeeds.**
Resolution: iOS catches the fast-tts error and does NOT mark the slot as "fast-played". Sonnet's bundler emits the confirmation normally. iOS hears Sonnet's confirmation at ~4.7s (today's baseline). No audible loss.

**Race C — iOS fast-tts fails AFTER iOS sent the WS transcript with `regex_fast_correlation_id`.**
Resolution: bundler's suppression set is keyed by correlation_id with a SHORT TTL (5s). If the fast-tts endpoint NEVER calls `recordFastPathConfirmation(correlationId, slot)`, the set stays empty for that correlation_id and the bundler's confirmation fires. Backend doesn't need to know fast-tts failed — only succeeded.

**Race D — kill-switch flipped after iOS POST but before fast-tts route processes.**
Resolution: fast-tts endpoint checks kill-switch at request entry. Returns 503. iOS falls back to live synth. (Codex's race E from v1 was about decoupled TTS+write; Mode A's lack of fast-write means no certificate-data risk here.)

**Race E — concurrent multi-board switch.**
Resolution: fast-tts endpoint validates `req.body.boardId === session.currentBoardId` BEFORE streaming. iOS POSTs boardId from its currently-rendered snapshot. Drift → 409 → fallback.

**Race F — iOS connectivity drops mid-fast-tts stream.**
Resolution: server-side ElevenLabs WS continues; iOS's HTTP socket closes; bytes go to /dev/null. No certificate impact (no write was attempted). iOS's AlertManager retry logic doesn't fire on the fast path — the fast path is best-effort.

**Race G — Same-turn fast-tts called multiple times (Deepgram emits two finalised segments for one utterance).**
Resolution: iOS-side dedup via the existing AlertManager dedup queue (`dismissTimersRef`). Backend doesn't need to handle.

### iOS scope (revised honest estimate)

Codex I1 + I5 + Claude I5: iOS work was under-estimated.

Honest v2 iOS budget: **~8-10 days** (vs v1's "3-5 days"):
- 2d: regex matcher extension + designation-matcher path (deferred, just ref-number for v2 — 1d)
- 1.5d: APIClient.proxyRegexFastTTS + AVAudioPlayer playback path
- 1d: capability handshake bit + readiness probe sync
- 1d: transcript WS correlation_id field
- 1d: race-D/E/F handling + fallback to live synth on 4xx/5xx
- 1.5d: unit tests + UI tests
- 1d: TestFlight cycle + field validation prep

NO new audio decode path required (MP3 only — Codex I5 fix). NO designation matcher in v2 (deferred to v3 — Codex B8 fix). Both reduce iOS scope considerably from v1's hidden complexity.

### Verification gate G1

| Sub-gate | Pass criteria |
|---|---|
| G1.iOS | iOS readiness probe reports `regex_fast_v2: true` from Derek's iPad post-TestFlight. (Single-user prod — Derek is the adoption gate.) |
| G1.a | Phase 0 telemetry shows `path = "fast_path"` for ≥30% of single-value record_reading turns on patterns the matcher covers. |
| G1.b | P50 `audible_first_byte_ms` on `fast_path` turns ≤ 500ms. P95 ≤ 800ms. |
| G1.c | Bundler suppression: 0 turns in 1 week where iOS receives BOTH a fast-path TTS AND a bundler confirmation for the same slot (measured via dual-audio alerts in iOS analytics, sampled to 100% for the first week). |
| G1.d | Cert correctness: cert-row-error rate unchanged week-over-week. (Sonnet still owns the writes — should be tautologically true, gate is a sanity check.) |

### Cost

Per fast-path turn: +$0.0025 ElevenLabs synth pre-paid + $0 Sonnet cost change (Sonnet runs as before). Net: +$0.0025/covered turn vs today's baseline.

Suppression saves the Sonnet-bundler-driven ElevenLabs synth on the same turn (the existing live-synth path). So actually net cost is **break-even** — replacing one ElevenLabs synth with another, just earlier.

### Rollback

`VOICE_LATENCY_REGEX_FAST_TTS=false` env flip (existing flag). Both the endpoint and iOS's POST guard on this. Zero source change.

### Things NOT to break

- Sonnet's normal write path — totally untouched in Mode A. Cert correctness comes from Sonnet exactly as today.
- Loaded Barrel — fast-path turns SKIP Loaded Barrel speculation because Sonnet's bundler suppresses the confirmation. (Speculator still fires per `record_reading` tool call from Sonnet's stream, but its cache entry goes unclaimed because iOS already heard the fast-path audio. Speculator gracefully cleans up via existing TTL.)
- The 12-tool documentation in the agentic prompt — unchanged.
- `applyReadingToSnapshot` and dispatcher invariants — unchanged (no fast-write in Mode A).

---

## §E — Phase 2 detailed (server-side early-terminate)

Closes Claude B1, Codex B1, Codex I5.

### Scope

`runToolLoop` gains a `shouldEarlyTerminate({records, toolResults, perTurnWrites, session})` predicate that runs AFTER round 1's dispatch loop completes. When TRUE, the loop:
1. Pushes the tool_results user message (required by Anthropic protocol — same as cap-hit branch).
2. Sets `stopReason = 'end_turn'` (synthetic).
3. Breaks out of the while loop BEFORE invoking round 2's `client.messages.stream`.
4. Returns to caller with the same shape as a real end_turn (rounds: 1, stop_reason: 'end_turn').

The bundler runs in the caller AS TODAY, building confirmations from `perTurnWrites.readings` via `buildConfirmationText`. No prompt change. No assembler text-block extraction.

### `shouldEarlyTerminate` predicate

```js
function shouldEarlyTerminate({ records, toolResults, perTurnWrites, session }) {
  // Reject if any error from dispatch
  if (toolResults.some((r) => r.is_error === true)) return false;
  // Reject if multi-board session
  const mainBoardId = getMainBoardId(session.stateSnapshot);
  if (session.stateSnapshot.currentBoardId !== mainBoardId) return false;
  // Reject if any non-record_reading tool was emitted
  const allRecordReading = records.every((r) => r.name === 'record_reading');
  if (!allRecordReading) return false;
  // Reject if more than one record_reading
  const recordReadings = records.filter((r) => r.name === 'record_reading');
  if (recordReadings.length !== 1) return false;
  // Reject if perTurnWrites didn't actually accept the write
  if (perTurnWrites.readings.size !== 1) return false;
  // Reject if any clear / observation / circuit-op / board-op accumulated
  if (perTurnWrites.cleared.length > 0) return false;
  if (perTurnWrites.observations.length > 0) return false;
  if (perTurnWrites.circuitOps.length > 0) return false;
  if (perTurnWrites.boardOps.length > 0) return false;
  if (perTurnWrites.fieldCorrections.length > 0) return false;
  if (perTurnWrites.boardReadings.size > 0) return false;
  return true;
}
```

Conservative. Designed for the dominant 70%+ turn shape only. Anything outside the predicate runs round 2 as today.

### Files

- `src/extraction/stage6-tool-loop.js` — add `shouldEarlyTerminate` import + post-dispatch check + synthetic-end_turn branch. New env flag `VOICE_LATENCY_ROUND1_EARLY_TERMINATE` (default `false`). Predicate only consulted when flag is `true`.

- `src/extraction/stage6-early-terminate.js` (NEW) — exports `shouldEarlyTerminate`. Pure function, easy to test.

- `src/extraction/voice-latency-config.js` — add `VOICE_LATENCY_ROUND1_EARLY_TERMINATE` to SNAPSHOTTED_FLAGS list (Codex N4 generalised).

- Tests: `src/__tests__/stage6-early-terminate.test.js` — closed-set tests for every TRUE / FALSE path of the predicate. ~30 cases. Plus 4 runToolLoop integration tests asserting `rounds: 1` when predicate fires AND `rounds: 2` when it doesn't (Codex I5 — assert state mutation AND rounds AND confirmation text).

### Prompt change?

**None required.** The early-terminate happens server-side regardless of what Sonnet emits. Sonnet's behaviour in round 1 stays as today — it can emit text-before-tool, text-after-tool, or just tool. Whatever it emits, the assembler discards text (existing behaviour). Bundler reads `perTurnWrites.readings` via `buildConfirmationText` as today.

If a future v3 plan adds text-before-tool, the assembler extraction would feed bundler-text — but that's NOT in v2 scope.

### Verification gate G2

| Sub-gate | Pass criteria |
|---|---|
| G2.unit | `stage6-early-terminate.test.js` 30+ predicate tests pass. |
| G2.integration | 4 runToolLoop integration tests pass: (a) single-clean-record_reading → rounds:1 → state-mutation-asserted (Codex I5). (b) multi-record_reading → rounds:2. (c) record_reading + error → rounds:2. (d) record_reading + ask_user → rounds:2. |
| G2.adoption | After Phase 2 deploys, Phase 0 telemetry shows: of turns where `record_reading_count_round1 == 1 AND no other tools AND no errors`, `rounds == 1` ratio ≥ 99%. (Not 70% — this is a SERVER-SIDE early-terminate, not a prompt nudge, so adoption is deterministic.) |
| G2.latency | P50 `audible_first_byte_ms` on `path = "early_terminate"` turns ≤ 2500ms. P95 ≤ 3500ms. |
| G2.correctness | Cert-row-error rate week-over-week within ±5% (no regression). |

### Things NOT to break

- Any non-eligible turn shape — predicate rejects → round 2 fires as today.
- The cap-hit branch (`if (rounds >= maxRounds)`) — predicate runs BEFORE cap check; only fires on rounds < maxRounds.
- The legacy `ask_user`-last sort hook — predicate rejects any turn with `ask_user`, so the sort hook's role is unchanged.
- The cost-tracker turn boundary — `addSonnetUsage` is called once per turn from `runShadowHarness` regardless of early-terminate.
- The `Anthropic API contract` — the tool_results user message is still appended (required for protocol correctness on a possible next user turn). Only the round-2 `client.messages.stream` invocation is skipped.

### Cost

Sonnet round 2 input + output dropped on eligible turns. Estimated 50% of routine `record_reading` turns are eligible (single-board, single-value, no errors). Net Sonnet cost reduction: ~25% of total Sonnet cost.

### Rollback

`VOICE_LATENCY_ROUND1_EARLY_TERMINATE=false` env flip. Source change unaffected.

---

## §F — Hard non-goals (do NOT extend scope)

1. **Conversational / multi-value / ask_user turns staying at ~4-5s.** Sonnet floor preserved by design — `shouldEarlyTerminate` rejects them.
2. **Mode B paired fast-write.** Explicitly deferred to a v3-of-this-plan, gated on Phases 0+1+2 failing to hit 2.5s.
3. **Haiku-on-round-2.** Out of v2. Codex I6's silent-correctness regression risk + ambiguous trigger make it unsuitable for this sprint.
4. **iOS-side designation matching.** Codex B8 — backend-owned for v1. iOS regex matcher uses circuit-number-only patterns. Designation matching deferred to v3.
5. **Text-before-tool prompt change.** Out of v2. Either useful (with assembler text extraction — large scope) or harmful (cache parity break). v2 keeps the prompt as today.
6. **Multi-context ElevenLabs WS pooling.** v11 candidate of Loaded Barrel; out of v2.
7. **Reducing Sonnet's per-round wall-clock below 2s.** Anthropic-side constraint.

---

## §G — Verification gates summary (cross-phase)

| Gate | Trigger | Pass condition |
|---|---|---|
| **G0** | Phase 0 deploy + 24h | `turn_summary` rows ≥ 99% of turns; CloudWatch Insights query returns clean P50/P95 per `path` value. |
| **G1.iOS** | iOS TestFlight build with regex extension | Derek's iPad reports `regex_fast_v2` capability. |
| **G1** | Phase 1 flag flip + 1 week field | `path = "fast_path"` ≥30% of eligible turns; P50 audible ≤500ms; 0 dual-audio events. |
| **G2.unit** | Phase 2 PR | Predicate unit tests + 4 integration tests pass. |
| **G2.integration** | Phase 2 staging | Harness shows `rounds:1` on eligible scenarios; state-mutation asserted (Codex I5). |
| **G2** | Phase 2 flag flip 100% + 1 week | P50 audible ≤2500ms on `early_terminate` turns; cert correctness within ±5%. |
| **G3** | Sprint complete | ≥70% of routine record_reading turns hit P50 ≤2.5s audible (combination of Phase 1's 420ms and Phase 2's ~2.5s). |

---

## §H — Files to read before starting (per phase)

### Phase 0
- `src/extraction/voice-latency-telemetry.js` — extend SERVER_OUTCOMES enum + add `emitTurnSummary` consumer.
- `src/extraction/stage6-tool-loop.js:316-456` — capture per-round wall-clock timestamps.
- `src/extraction/sonnet-stream.js:runLiveMode` — end-of-turn hook to call `emitTurnSummary`.

### Phase 1
- `src/routes/voice-latency-fast-tts.js` — existing PoC, productionise per §D.
- `src/extraction/confirmation-text.js` — single source of confirmation text (delete the local FRIENDLY in voice-latency-fast-tts.js per Codex N4).
- `src/extraction/eicr-extraction-session.js` — add `fastPathConfirmationsByTurn` field.
- `src/extraction/stage6-event-bundler.js:synthesiseConfirmations` — add suppression check.
- iOS `Sources/Processing/TranscriptFieldMatcher.swift` — 5 new regex patterns.
- iOS `Sources/Services/APIClient.swift` — `proxyRegexFastTTS` method.
- iOS `Sources/Services/ServerWebSocketService.swift` — capability handshake + correlation_id on transcript.

### Phase 2
- `src/extraction/stage6-tool-loop.js:316-456` — insert early-terminate check after dispatch loop.
- `src/extraction/stage6-per-turn-writes.js` — predicate reads `readings.size`, `cleared.length`, etc.
- `src/extraction/stage6-multi-board-shape.js:getMainBoardId` — predicate's multi-board guard.

---

## §I — Open questions (for round-2 review)

1. **Phase 2 cap-hit interaction.** If `maxRounds === 1` (unlikely but possible in test fixtures), does the early-terminate path interact correctly with the cap-hit synthesis? Predicate runs before cap check — should be safe but worth a test case.

2. **Phase 1 dual-audio detection.** G1.c says "0 dual-audio events" — measured by iOS analytics. Is iOS willing to instrument this for the 1-week gate? If not, we proxy via backend-only: count turns where `path = "fast_path"` AND `bundler_confirmation_emitted = true` for the same slot. The latter is the new bundler-suppression's pre-suppression count.

3. **Phase 2 multi-board safety net.** Predicate hard-rejects `currentBoardId !== mainBoardId`. Is that too conservative? Could safely allow single-board sub-board sessions (where currentBoardId is the only sub-board). v2 chose hard-reject for safety; review to confirm.

4. **Phase 0 client playback timing.** Codex B10 mentions iOS's `proxyElevenLabsTTS` doesn't currently expose first-chunk timing. v2 defers iOS-side `ios_playback_first_frame_ms` to Phase 1's iOS work — acceptable per the phase ordering (Phase 1 iOS is required before Phase 2 launches anyway). Until then, `audible_first_byte_ms` (server-side) is the proxy.

5. **Phase 1 polarity_confirmed removal.** v2 dropped polarity from the eligibility whitelist due to Codex I7 (`"✓"` value drift). Is that acceptable? Polarity confirmations are a meaningful UX wins on routine inspections. If we want them back: add coercion of `"✓"` → `"Y"` in `record-reading-coercion.js` AND make iOS POST normalise before send.

---

## Revision history

- **v1 (2026-05-25 early)** — initial draft. 5 BLOCKERs from Claude, 10 from Codex. See `claude-review.md` + `codex-review.md`.
- **v2 (2026-05-25 late)** — three structural pivots locked in §A: Phase 2 → server-side early-terminate (not prompt change); Phase 1 → Mode A only (audio-only, no fast-write); cache parity → friendly-name canonical (Sonnet text dropped). 11 BLOCKERs from v1 reviews directly addressed. iOS scope honestly re-budgeted. Phase 3 explicitly OUT.
