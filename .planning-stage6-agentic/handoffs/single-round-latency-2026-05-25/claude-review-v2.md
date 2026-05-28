# Claude Plan-agent review — PLAN v2 (round 2)

**Date:** 2026-05-25
**Verdict:** 0 BLOCKERs, 4 IMPORTANTs, 4 NITs — **SHIP (after IMPORTANTs addressed in v3 draft)**

## BLOCKERs (must be addressed before v3)

**None.** v2's three structural pivots correctly close every round-1 BLOCKER:

- **Round-1 Claude B1** (Phase 2 prompt-change misunderstands Anthropic tool_use contract): closed by Pivot 1's server-side `runToolLoop` early-terminate. The predicate runs AFTER the round-1 dispatch loop completes (line 514+ in `stage6-tool-loop.js`) and AFTER the `messages.push({ role: 'user', content: toolResults })` at line 743, then skips the next iteration's `client.messages.stream`. Wire-shape correct; no protocol violation.
- **Round-1 Claude B2** (cache-key vs Sonnet-text trilemma): closed by Pivot 3's friendly-name single source of truth. The speculator (`loaded-barrel-speculator.js:148-172`) hashes `expandForTTS(buildConfirmationText(...))` and Sonnet's text is explicitly NOT used for audible. The new `confirmations[].expanded_text` field eliminates the iOS-re-expansion drift surface.
- **Round-1 Claude B3, B4, B5** (fast-write wire shape / hint plumbing / race catalogue): closed by Pivot 2's "Mode A ONLY" — Sonnet still owns the data write, fast-tts is audio-only, no `regex_resolved` hint, no `applyReadingToSnapshot` bypass.
- **Round-1 Codex B1, B4-B9**: same pivots address the same root causes.
- **Round-1 Codex B2, B3** (cache parity / model-text plumbing): closed by Pivot 3 + by the explicit decision in §E that "the assembler discards text (existing behaviour)" — no text-plumbing change is needed.
- **Round-1 Codex B10** (telemetry can't measure new paths): closed by §C's `turn_summary` row carrying every fact each gate references.

I verified the central code claims:
- `stage6-tool-loop.js:441` early-break on non-tool_use stop_reason — confirmed; the plan's understanding is correct.
- `stage6-tool-loop.js:743` always pushes the tool_results user message in the normal dispatch branch — confirmed; predicate evaluation after that point satisfies Anthropic's tool_use↔tool_result pairing invariant.
- `getMainBoardId` lives at `stage6-multi-board-shape.js:50` — predicate is callable as written.
- `perTurnWrites` is fresh per turn (`stage6-shadow-harness.js:203` via `createPerTurnWrites()`) — predicate's `.size !== 1` check is well-defined.
- `boardReadings`, `cleared`, `observations`, `circuitOps`, `boardOps`, `fieldCorrections` all exist on the accumulator (`stage6-per-turn-writes.js:78-101`) with the asserted shapes.

The plan would execute as written without a wire-shape collision, a dropped write, or an unmeasurable gate.

## IMPORTANTs (should be addressed in v3 before execution)

### I1: `streaming_http_audio` capability gate on the fast-TTS endpoint will reject every Mode-A client
**Where:** PLAN_v2.md §D lines 181-186; `src/routes/voice-latency-fast-tts.js:80-82`.

**Issue:** Today's PoC endpoint gates on `vl.capabilities?.hasStreamingHttpAudio !== true` and returns 412 if missing. The plan switches output to MP3 + AVAudioPlayer (closing Codex I5) and introduces a new `regex_fast_v2` capability bit, but does not state that the `hasStreamingHttpAudio` gate is removed/relaxed. If left in place, every iOS client that advertises only `regex_fast_v2` (not `streaming_http_audio`) will receive 412 and fall back to live synth — defeating Phase 1 in production.

**Fix:** Specify in §D explicitly: "Remove the `hasStreamingHttpAudio` precondition check from the endpoint; gate on `hasRegexFastTts` OR `hasRegexFastV2` (capability handshake set produced by `parseVoiceLatencyCapabilities` in `voice-latency-config.js:147`). Note that `regex_fast_v2` must be added to `KNOWN_SUPPORTS` at `voice-latency-config.js:139-145`."

### I2: Suppression-set key shape is inconsistent across §D
**Where:** PLAN_v2.md §D lines 191-194 (slot-keyed: `"field::circuit::boardId"`) vs lines 219-220 (correlation_id-keyed with 5s TTL) vs G1.c at line 256 (slot-based duplicate detection).

**Issue:** Race A description says the bundler suppresses via `fastPathConfirmationsByTurn: Map<turnId, Set<"field::circuit::boardId">>`. Race C description says "Set is keyed by correlation_id with a SHORT TTL (5s)". These are two different keys; the bundler can only consult ONE of them. If the bundler is keyed by slot but the endpoint populates by correlation_id, race A's suppression never fires.

**Fix:** Pick one. Recommend slot-keyed (matches the bundler's natural iteration over `extracted_readings[].field/circuit/board_id`). Make the endpoint write `slot = (field, circuit, boardId)` into the set on `terminal === 'completed'`. Correlation_id can ALSO be stored as a value alongside slot for log correlation, but the LOOKUP key the bundler uses is the slot tuple. Specify TTL semantics: cleared when the bundler finalises that turn's confirmations, not after 5s wall-clock (the bundler is the only consumer, so race C's 5s grace is unnecessary if you tie the set lifetime to `turnId`).

### I3: iOS-side `expanded_text` consumption is unspecified
**Where:** PLAN_v2.md §A Pivot 3 line 54; §D iOS files at lines 196-210 (no AlertManager change listed).

**Issue:** Pivot 3 introduces `confirmations[].expanded_text` so iOS "uses the expanded text verbatim instead of re-running expansion (eliminates any iOS-vs-backend expandForTTS drift on the cache-key path too)." But today's iOS code at `AlertManager.swift:1058` unconditionally does `let expanded = Self.expandForTTS(text)` before POSTing. The plan's §D iOS file list does NOT include an AlertManager change to consume `expanded_text`. Without that change, the cache parity claim is not realised — iOS will continue running `expandForTTS` on `confirmations[].text` and the cache key will continue to depend on the iOS expander's idempotency under double-application.

**Fix:** Add to §D iOS files: "`Sources/Recording/AlertManager.swift:speakWithTTS` — when `loadedBarrelContext` carries `expandedText` from the bundler's new `confirmations[].expanded_text`, POST it directly as the `text` field; skip the local `expandForTTS` call." Add a verification step to G2 that asserts cache-key bytes match between speculator and iOS POST.

### I4: Cost claim "net cost is break-even" on fast-path turns is incorrect when Loaded Barrel is on
**Where:** PLAN_v2.md §D Cost section, lines 261-264; "Things NOT to break" line 272.

**Issue:** The plan acknowledges at line 272 that the Loaded Barrel speculator still fires per `record_reading` from Sonnet's stream, AND its cache entry goes unclaimed (cleaned up via TTL). That means on every fast-path turn with LB enabled, you pay:
- 1× ElevenLabs fast-TTS synth (Mode A audible) — $0.0025
- 1× ElevenLabs speculator pre-synth (wasted) — $0.0025
- 0× ElevenLabs live-synth (suppressed)

Net is **+1 wasted ElevenLabs synth per fast-path turn**, not break-even. The "replacing one ElevenLabs synth with another, just earlier" framing only holds if LB is OFF.

**Fix:** Two options: (a) honest cost statement "+$0.0025/turn vs today when LB is on; break-even when LB is off"; or (b) the Mode-A iOS POST sets a backend hint (e.g. `regex_fast_correlation_id`) that the speculator's `onSnapshotPatch` hook reads to SKIP pre-synth for that slot. Option (b) is the cheaper architecture but requires the correlation_id to land on the session before the Sonnet stream emits `content_block_stop` for the matching `record_reading` — feasible since fast-tts POST is sent in parallel with the WS transcript and the speculator fires mid-Sonnet-stream ~1-2s later. Specify which.

## NITs

### N1: §H Phase 0 file ref `src/extraction/sonnet-stream.js:runLiveMode` is stale
`runLiveMode` is defined in `src/extraction/stage6-shadow-harness.js:197`, not `sonnet-stream.js` (the latter is the WS handler module). Correct the file reference for the executor.

### N2: §B "scripts/check-phase-ordering.sh" is named but not specified
The phase-ordering invariant relies on a new CI script, but the plan doesn't say what the script actually checks (env-var existence? CloudWatch query? Git tag presence?). Either drop the script reference and rely on commit-message discipline, or specify the check.

### N3: §E G2.adoption claim "rounds:1 ratio ≥ 99%" is right-ish but undercounts cap-hit safety
The predicate runs before the cap-hit check, but if `maxRounds === 1` (a test fixture or pathological config), the cap-hit branch would fire AFTER the predicate evaluates TRUE. Behaviour is still correct (the cap-hit appends abort tool_results and breaks; the predicate's synthetic-end_turn branch never gets hit because the cap-hit `break` runs first). Worth a one-liner clarification in §E so the executor doesn't accidentally re-order the two checks.

### N4: §C `turn_summary` row's `path = "early_terminate"` enum overlaps with `rounds = 1`
The `path` enum includes `early_terminate` AND the schema also has `rounds: 1 | 2`. An end_turn turn with no tool calls (small talk) ALSO has `rounds: 1` but is NOT `early_terminate`. Specify whether `path = "early_terminate"` is set only when the predicate fired (not for ordinary end_turn round-1 turns) so G2.adoption's denominator is unambiguous.

## Recommended verdict

**SHIP after v3 closes the 4 IMPORTANTs.** No blocking architectural issues remain. v2's pivots are sound and the predicate is implementable as written against the current `stage6-tool-loop.js`. The IMPORTANTs are all narrow specification gaps (capability gate; suppression key shape; iOS expanded_text consumption; cost accounting on LB-on path) that take ~30 minutes each to nail down in a v3 doc edit. No code re-architecture required for any of them.

The plan correctly identifies that the central latency win comes from the server-side early-terminate (Phase 2's ~2.5s saving) and that Mode-A Phase 1 is additive audio-only redundancy. The non-goals in §F are well-chosen (Mode B / Haiku / designation matching deferred to v3-of-this-plan, not this sprint).

## Open questions for the executing session

1. **Should the bundler's suppression set lifetime be tied to turn finalisation or to a wall-clock TTL?** I1's fix recommends turn-finalisation; confirm before implementation so the per-session state cleanup is deterministic.

2. **Is Derek willing to ship the iOS `expanded_text` consumption in the same TestFlight cycle as Phase 1, or should §A Pivot 3 fall back to "bundler runs `expandForTTS` server-side and ships ONLY the expanded text on the wire" (dropping the `text` field entirely on speculator-eligible confirmations)?** The latter would close I3 without an iOS change but trades off iOS's ability to use the unexpanded text for any UI display.

3. **Should Phase 1's fast-tts endpoint emit a backend session-state hint that the LB speculator reads to SKIP pre-synth for the matching slot?** That would close I4's cost issue but couples the two subsystems. Alternative: accept the +$0.0025/turn cost and document it.

4. **G2.adoption's "≥ 99%" floor on the early-terminate hit ratio for eligible turns** — is that calibrated against actual `record_reading`-only round-1 dispatches in production today, or against the harness canon? If the former, has it been measured?

### Critical Files for Implementation

- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-tool-loop.js` (insert `shouldEarlyTerminate` post-dispatch check; ~lines 514-744)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-shadow-harness.js` (`runLiveMode` at line 197; bundler call at line 372; emitTurnSummary hookup)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-event-bundler.js` (suppression set consumption in `synthesiseConfirmations`; add `expanded_text` field)
- `/Users/derekbeckley/Developer/EICR_Automation/src/routes/voice-latency-fast-tts.js` (productionise; remove `streaming_http_audio` gate; reuse `buildConfirmationText`; add boardId validation)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/voice-latency-config.js` (add `VOICE_LATENCY_ROUND1_EARLY_TERMINATE` to SNAPSHOTTED_FLAGS; add `regex_fast_v2` to KNOWN_SUPPORTS)
