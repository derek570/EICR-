# Codex CLI review — PLAN v1 (round 1)

**Date:** 2026-05-25
**Reviewer:** Codex CLI (gpt-5.5, high reasoning)
**Verdict:** 10 BLOCKERs, 8 IMPORTANTs, 5 NITs

## BLOCKERs (must be addressed before v2)

### B1: The round-1-close path would currently skip the write entirely
**Where:** PLAN.md lines 276-280, 330-334
**Issue:** The load-bearing claim is false for the stated shape. `runToolLoop` finalizes records at `src/extraction/stage6-tool-loop.js:408`, pushes the assistant message at `src/extraction/stage6-tool-loop.js:421-422`, then immediately breaks when `stop_reason !== 'tool_use'` at `src/extraction/stage6-tool-loop.js:439-441`. The normal dispatch branch starts later at `src/extraction/stage6-tool-loop.js:514`. So if Sonnet emits `[text] + [tool_use] + stop_reason:end_turn`, the `record_reading` record is never dispatched and no state write happens. If Anthropic instead reports `stop_reason:'tool_use'` for any response containing a tool block, the current loop dispatches but then invokes round 2, so the latency win does not happen.
**Fix:** Phase 2 must be an architecture change, not a prompt-only change. Do not instruct Sonnet to produce `stop_reason:end_turn` with a tool. Keep the tool-use protocol, dispatch round-1 tools, append the required tool_result user message, and add an explicit early-terminate branch after dispatch only when all of these are true: exactly one successful `record_reading`, no `ask_user`, no dispatcher errors, and exactly one validated confirmation text block. If any tool_result is `is_error:true`, continue to round 2.

### B2: The default cache-parity option guarantees cache misses when Sonnet text differs
**Where:** PLAN.md lines 336-348
**Issue:** Option 3 says to keep the cache key on friendly-name text while iOS later POSTs Sonnet-derived bundler text. That cannot HIT with the current cache. `keys.js` builds the lookup key from `req.body.text` at `src/routes/keys.js:380-387`; the speculator builds its key from `buildConfirmationText(...)` and `expandForTTS(...)` at `src/extraction/loaded-barrel-speculator.js:148-172`. The prompt example includes a trailing period (`"Circuit 3, Zs 0.35."`, PLAN.md line 308), while `buildConfirmationText` returns no period (`src/extraction/confirmation-text.js:115-118`). That one-character difference is enough to make every HIT become a MISS.
**Fix:** Pick one cache text source and make it byte-identical end to end. The safest v2 option is: server remains canonical, Sonnet may emit text only if it matches `buildConfirmationText` exactly after trimming one optional trailing period, and the bundler/speculator/iOS POST all use the canonical server text. If Sonnet text is truly authoritative, the streamed speculator must receive that exact text before it starts TTS; otherwise do not claim Loaded Barrel parity.

### B3: The model-text plumbing is not actually wired to the bundler
**Where:** PLAN.md lines 324-334
**Issue:** The assembler currently discards text blocks by design: text block starts are no-ops at `src/extraction/stage6-stream-assembler.js:88-90`, and `text_delta` is ignored at `src/extraction/stage6-stream-assembler.js:122-123`. `runToolLoop` can still read text from `assistantMsg.content` after `stream.finalMessage()` at `src/extraction/stage6-tool-loop.js:421`, but it does not return or emit that text today (`src/extraction/stage6-tool-loop.js:746-776`). Live mode calls `bundleToolCallsIntoResult` with only `confirmationsEnabled` and `turnId` at `src/extraction/stage6-shadow-harness.js:372-379`; no `modelText` option reaches the bundler. Also, `onLoopComplete` is only supplied when Loaded Barrel is enabled (`src/extraction/stage6-shadow-harness.js:327-329`), so it cannot be the general text transport.
**Fix:** Add `assistant_text_by_round` or `modelTextBlocks` to the `runToolLoop` return value, then pass a validated single confirmation into `bundleToolCallsIntoResult(..., { modelText })`. Keep this independent of the speculator hook. Add a test that fails if `rounds:1` occurs but `perTurnWrites.readings.size === 0`.

### B4: Phase 1 is internally inconsistent about whether Sonnet is skipped or runs in parallel
**Where:** PLAN.md lines 15, 85, 157, 210-216, 263
**Issue:** The plan says fast-path turns "skip Sonnet entirely" and have negative Sonnet cost (PLAN.md lines 15, 157, 263). The same phase also says Sonnet still runs in parallel for the actual data write (line 85) and spends a full race catalogue on suppressing Sonnet duplicates (lines 210-216). Those are different products with different latency, cost, risk, and verification gates. G1.b's "fast-write vs bundler's would-be output" also requires some Sonnet/bundler path to exist, which conflicts with the "skip Sonnet entirely" claim.
**Fix:** Split the design into two explicit modes. Mode A: fast audio only, Sonnet remains authoritative for writes, no Sonnet cost savings, race suppression is mandatory. Mode B: fast audio plus backend fast-write, Sonnet is bypassed for eligible turns, race suppression is mostly about late duplicate transcripts/retries, and drift is measured by sampled shadow replays rather than a parallel production Sonnet turn. Pick one for v2 and update cost/gates accordingly.

### B5: The proposed fast-write bypasses the dispatcher contract
**Where:** PLAN.md lines 180-186, 229-235
**Issue:** The plan tells the new endpoint to call `applyReadingToSnapshot`, but the real `record_reading` path is not just that atom. `dispatchRecordReading` validates board scope and circuit existence at `src/extraction/stage6-dispatchers-circuit.js:105-121`, coerces values at `src/extraction/stage6-dispatchers-circuit.js:123-132`, writes through the flag-aware mutator at `src/extraction/stage6-dispatchers-circuit.js:133-138`, populates `perTurnWrites.readings` at `src/extraction/stage6-dispatchers-circuit.js:156-168`, updates ring/IR timeout trackers at `src/extraction/stage6-dispatchers-circuit.js:177-185`, and logs the dispatcher outcome at `src/extraction/stage6-dispatchers-circuit.js:188-199`. Raw `applyReadingToSnapshot` only assigns `snapshot.circuits[circuit][field] = value` (`src/extraction/stage6-snapshot-mutators.js:43-46`), so the endpoint would drift from Stage 6 behavior and leave the bundler without its normal accumulator.
**Fix:** Implement fast-write by reusing `createWriteDispatcher` or a new shared `commitRecordReadingTurn` helper with a synthetic `tool_call_id`, fresh `perTurnWrites`, and the normal bundler projection. Then reuse the same live-mode post-processing that folds board readings/circuit updates and strips Stage 6-only slots before emitting the WS extraction.

### B6: Decoupled TTS and write can audibly confirm an uncommitted value
**Where:** PLAN.md lines 188, 210-216, 241
**Issue:** The plan deliberately lets `regex-fast-tts` and `regex-fast-write` race independently. The current TTS endpoint validates almost nothing about the candidate, sets response headers, and streams audio at `src/routes/voice-latency-fast-tts.js:63-122`; it has no paired write or reservation. If TTS succeeds but fast-write later rejects due to invalid circuit, stale board, duplicate slot, Sonnet already writing a different value, or client retry disorder, the inspector hears a confident confirmation for a value that did not land. "iOS shrugs" is not a correctness policy for a certificate write.
**Fix:** Add an atomic backend reservation/write gate before audio is allowed to play. The cleanest shape is a single endpoint that validates, writes or reserves idempotently, then streams TTS. If two endpoints remain, both must share a `fastPathId` state machine (`reserved`, `written`, `tts_started`, `cancelled`, `failed`) and the TTS endpoint must refuse to stream unless the reservation is valid for the same slot/value/board/turn.

### B7: `regexResolvedSlots` is the wrong lifetime and does not cover ask_user races
**Where:** PLAN.md lines 210-214, 233-234, 485
**Issue:** The plan calls `session.regexResolvedSlots` a per-turn set, but says it is cleared at session-start (PLAN.md line 234). If it is session-lifetime, a legitimate later correction to the same slot can be rejected forever. If it is per-turn, the plan must define when it is created, when it expires, and how it is associated with the Sonnet turn already in flight. A dispatcher-only `regex_already_resolved` check also does not suppress a same-slot `ask_user`; by the time the dispatcher sees the ask, iOS may already be speaking the question. Current sessions have no such field in the active-session setup (`src/extraction/sonnet-stream.js:2530-2654`), so this is new concurrency state, not a small validator tweak.
**Fix:** Define a bounded per-turn ledger keyed by `{turnId, fastPathId, boardId, field, circuit, value}` with TTL and terminal states. Apply it to both write and ask dispatchers: same-slot `record_reading` is rejected only for the matching turn/value, and same-slot `ask_user` is either suppressed before WS emission or converted into a no-op diagnostic. Add tests for late fast-write, late Sonnet write, Sonnet ask_user, same-slot different value, retry duplicate, and next-turn correction.

### B8: Backend designation matching is not exposed as a safe iOS implementation target
**Where:** PLAN.md lines 220-228, 486
**Issue:** The plan says iOS will reuse the prompt's DESCRIPTION MATCHING rules, but that is prose, not a versioned matcher. The current iOS matcher uses a static `designationMap` and exact lowercased equality against `circuitDesignation` for compound/designation matching (`CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:1323-1326` and `:1403-1406`). It does not implement backend/Sonnet-like fuzzy reasoning, and the backend does not currently expose a machine-readable designation resolver. This is exactly the sort of drift that can make fast-write land on the wrong circuit while Sonnet would have asked.
**Fix:** Make the backend authoritative for designation resolution. Have iOS POST `{spokenDesignation, optionalClientCircuitRef}` and have the backend re-resolve against the live snapshot with a shared, tested matcher. If iOS must match locally for latency, publish a versioned matcher/rules endpoint and require backend re-verification before TTS/write eligibility.

### B9: The fast-path candidate omits board identity
**Where:** PLAN.md lines 171-177, 210-212
**Issue:** The body schema has `{field, circuit, value, confidence}` but no `boardId`, while the race key includes `${field}::${circuit}::${boardId}` and the Stage 6 validators/mutators already route by `input.board_id` (`src/extraction/stage6-dispatchers-circuit.js:105-138`). Multi-board lookup falls back through `snapshot.currentBoardId` (`src/extraction/stage6-multi-board-shape.js:72-79` and `:129-137`). If iOS and backend disagree about current board, or a board switch is in flight, the same circuit number can mean a different row.
**Fix:** Include `boardId` and a current-board/session snapshot version in every fast candidate, and reject if it does not match the backend's live board state. Until that exists, disable regex fast-write for multi-board sessions and for turns near a board switch.

### B10: Phase 0 telemetry cannot prove the proposed gates
**Where:** PLAN.md lines 106-135, 244-251, 362-369, 431-439
**Issue:** The proposed `turn_summary` fields omit the data needed to diagnose the new paths: per-round `stop_reason`, tool-use count, tool-result error count, model text present/used/rejected, fast-write outcome, fastPathId, regex candidate slot/value/board, race outcome, cache lookup outcome, cache-key text source, and iOS playback/defer timing. Existing telemetry has hop/outcome primitives only (`src/extraction/voice-latency-telemetry.js:48-108`) and no `turn_summary`. On iOS, `proxyElevenLabsTTS` uses `responseData` and returns only full audio bytes, not first chunk/header timing (`CertMateUnified/Sources/Services/APIClient.swift:854-895`), so "audible_first_byte" is not currently measurable from the client side.
**Fix:** Make Phase 0 produce a single per-turn row that includes loop protocol facts, dispatch facts, fast-path write/TTS facts, Loaded Barrel cache facts, and client playback facts. Update G1/G2 to assert state mutation and audio source from those fields, not just `rounds` and perceived latency.

## IMPORTANTs

### I1: The iOS scope is understated
**Where:** PLAN.md lines 237-243
**Issue:** Current `sendSessionStart` sends only `protocol_version`, `sessionId`, `jobId`, and `jobState` (`CertMateUnified/Sources/Services/ServerWebSocketService.swift:472-491`), while the backend capability parser expects a `capabilities.voice_latency.supports[]` block (`src/extraction/voice-latency-config.js:147-179`). `APIClient` has only `/api/proxy/elevenlabs-tts`, not the fast TTS/write endpoints (`CertMateUnified/Sources/Services/APIClient.swift:854-895`). The current regex path intentionally does not apply circuit-level writes, only forwards hints to Sonnet (`CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:3674-3678`). The plan's "3-5 days iOS in parallel" also omits TestFlight/review time and field adoption gating.
**Fix:** Split iOS into a real sub-plan: capability handshake update, fast endpoint clients, candidate/race/idempotency model, backend-verified designation matching, board identity, paired POST behavior, analytics, tests, and TestFlight rollout.

### I2: Using Sonnet text verbatim for audio is too broad
**Where:** PLAN.md lines 319-321
**Issue:** The prompt says the server uses model text verbatim. That lets a model formatting drift become spoken output, including verbose commentary that conflicts with "Do NOT comment on whether values are good or bad" (`config/prompts/sonnet_agentic_system.md:185`). It also creates a prompt-injection surface where untrusted transcript content could influence readback phrasing.
**Fix:** Treat model text as a candidate, not authority. Accept it only if it is short, single-sentence, has no newline/JSON/control tokens, and matches the committed slot/value after canonicalization. Otherwise fall back to `buildConfirmationText`.

### I3: The fast-path drift detector is not defined for a true Sonnet bypass
**Where:** PLAN.md lines 248-250, 263
**Issue:** G1.b compares fast-write WS extraction against "the bundler's would-be output", but if fast-path turns skip Sonnet there is no production Sonnet turn to produce a would-be bundler result. If Sonnet runs in parallel to provide that comparison, the cost and race model change.
**Fix:** Define drift detection as sampled shadow replay, offline replay, or production parallel Sonnet. Each has different cost and safety tradeoffs; pick one and wire telemetry separately from the write path.

### I4: Existing parity-mismatch telemetry is enum-only, not a working gate
**Where:** PLAN.md lines 369, 487
**Issue:** `loaded_barrel_parity_mismatch` exists in the telemetry enum (`src/extraction/voice-latency-telemetry.js:96-107`), and `keys.js` records whether `x-expand-version` was present for readiness (`src/routes/keys.js:347-351`), but the route does not compare the header to `EXPANDER_VERSION` or skip cache lookup on mismatch. iOS also does not currently send that header from `APIClient.proxyElevenLabsTTS` (`CertMateUnified/Sources/Services/APIClient.swift:854-895`).
**Fix:** Do not rely on `parity_mismatch` in G2 until the header, comparison, cache-skip, and iOS version source are implemented and tested.

### I5: G2 can pass while data is lost unless it asserts mutation
**Where:** PLAN.md lines 364-369
**Issue:** A harness that only asserts `rounds:1` would pass the broken B1 shape where no tool dispatch occurred. The current loop can return `rounds:1` after breaking on `end_turn` even with ignored records.
**Fix:** G2.a must assert `stage6.tool_call` outcome ok, `perTurnWrites.readings` has the expected key, `session.stateSnapshot` changed, `result.extracted_readings` contains the expected slot, and the confirmation text matches the committed value.

### I6: Phase 3 does not detect confidently wrong Haiku tool_use
**Where:** PLAN.md lines 398-405
**Issue:** "On Haiku error or unexpected behaviour, fall back to Sonnet" only catches explicit errors. If Haiku emits a syntactically valid but semantically wrong `tool_use`, the normal dispatcher may mutate state and return success, so there is no error to trigger fallback.
**Fix:** For round 2, either do not pass tools to Haiku when round 1 dispatched cleanly, or treat any Haiku `tool_use` as unexpected and discard it before dispatching, then rerun Sonnet. If tools must remain available, shadow Haiku against Sonnet before live mutation.

### I7: Polarity fast-path value normalization is underspecified
**Where:** PLAN.md lines 194-202, 220-225
**Issue:** Current iOS regex writes polarity as `"✓"` in multiple paths (`CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:1825-1828`, `DeepgramRecordingViewModel.swift:4032-4033`). `coerceRecordReadingValue` maps strings like `true`, `yes`, and `correct` to `Y`, but not `"✓"` (`src/extraction/record-reading-coercion.js:82-88`). `buildConfirmationText` confirms only truthy canonical/English forms, not the checkmark (`src/extraction/confirmation-text.js:105-110`).
**Fix:** Specify the wire value for `polarity_confirmed` in the fast candidate as `Y` or `OK`, and add backend rejection/coercion tests for checkmark input.

### I8: The prompt change needs worked examples that preserve existing edge cases
**Where:** PLAN.md lines 293-322, 371-376
**Issue:** The existing prompt examples are all tool-only (`config/prompts/sonnet_agentic_system.md:132-170`), and the anti-patterns only say not to verbally acknowledge without a write (`:177-185`). A new rule after examples may not be enough to overcome the first-line "act through TOOLS" framing (`:1`) without destabilizing multi-value, correction, auto-resolve, and create-circuit flows.
**Fix:** Add explicit positive and negative examples: one clean single `record_reading`; one `create_circuit + record_reading` decision; one correction; one `ask_user`; one multi-value; one dispatcher-error retry. Then run the 20-run harness against all of them.

## NITs

### N1: The Phase 3 model names do not match the code
**Where:** PLAN.md line 394
**Issue:** The live tool loop currently uses `SHADOW_MODEL = 'claude-sonnet-4-6'` (`src/extraction/stage6-shadow-harness.js:97-103`). The plan says `claude-opus-4-7` "or whatever the configured Sonnet model is", which will confuse implementation and cost tracking.
**Fix:** Refer to the configured Stage 6 model constant and add a separate config key for the optional round-2 model.

### N2: The output-token cost arithmetic is correct but should be scoped
**Where:** PLAN.md lines 350-352, 378-380
**Issue:** `30 * $15 / 1,000,000 = $0.00045`, so the arithmetic is fine. The wording should say "per eligible single-value turn that emits model text", not all turns.
**Fix:** Rephrase the cost row and keep the existing number.

### N3: "Proceeds when EITHER returns 202" is not true for the TTS endpoint
**Where:** PLAN.md line 241
**Issue:** The proposed write endpoint returns 202, but `regex-fast-tts` streams audio and returns an audio response, not 202 (`src/routes/voice-latency-fast-tts.js:104-122`).
**Fix:** Define the actual response contract for each endpoint.

### N4: Friendly-name wording differs across paths
**Where:** PLAN.md lines 152-155, 190-204, 303-304
**Issue:** The current PoC says `number_of_points: 'number of points'` (`src/routes/voice-latency-fast-tts.js:39-50`), while the shared confirmation table says `number_of_points: 'points'` (`src/extraction/confirmation-text.js:36-61`). Phase 2 examples add punctuation. These small differences matter because the cache key includes expanded text.
**Fix:** Use `src/extraction/confirmation-text.js` as the only backend text source for all confirmation paths.

### N5: The "1.75s saved per inspection" wording is off
**Where:** PLAN.md line 356
**Issue:** The calculation is per turn distribution, not per inspection. An inspection has many turns.
**Fix:** Say "~1.75s saved per average turn if 70% of turns are single-value and each saves ~2.5s", or recompute per inspection from turns/session.

## Recommended verdict
DO NOT SHIP

## Open questions for the executing session

1. Should Phase 1 be a true Sonnet bypass, or a fast-audio path with Sonnet still authoritative for writes?
2. Is Derek willing to combine fast-write and fast-TTS into one atomic endpoint, or is the separate-endpoint latency win worth a reservation state machine?
3. Should designation matching be backend-owned for v1, with iOS only sending the spoken designation and candidate hint?
4. Should Phase 3 remain in this sprint at all, or be split into a later plan after Phase 2 telemetry proves it is needed?
