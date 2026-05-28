# Claude Plan-agent review — PLAN v1 (round 1)

**Date:** 2026-05-25
**Verdict:** 5 BLOCKERs, 9 IMPORTANTs, 7 NITs — DO NOT SHIP

## BLOCKERs (must be addressed before v2)

### B1: Phase 2's central premise — "single-round close" — is impossible under Anthropic's tool_use contract
**Where:** Phase 2 §"What", §"Why this saves time", ROUND-1 CLOSURE prompt change, G2.a/G2.c gates, TL;DR bullet 2, target architecture diagram.

**Issue:** The plan repeatedly claims Sonnet can emit `[text][tool_use][stop_reason: end_turn]` in a single round, and that `runToolLoop` "already supports this". This is wrong on two independent counts:

1. **Anthropic API contract:** `stop_reason` is set by Anthropic, not the model. When an assistant message ends with a `tool_use` content block, `stop_reason` is always `tool_use`. There is no API affordance for "I'm done, AND here's a tool to dispatch." The model literally cannot signal both.

2. **runToolLoop behaviour at line 441 of `src/extraction/stage6-tool-loop.js`:**
   ```js
   if (stop_reason !== 'tool_use') break;
   ```
   This break happens **BEFORE** the dispatcher runs. So if Sonnet somehow did emit `end_turn` with a tool_use block in the message, the loop would exit without dispatching it — the `record_reading` never lands, the bundler emits an empty extraction, the certificate gets no data. This is a data-correctness BLOCKER, not just a latency miss.

What the plan actually *wants* (and what would save the ~2.5s) is a server-side behaviour change: after round 1 dispatches the tool, **the server decides not to call Sonnet for round 2**. That requires modifying `runToolLoop` to short-circuit the re-invocation when a heuristic says round 2 is a no-op acknowledgement — it is NOT a prompt change. The prompt has zero leverage over whether round 2 fires.

**Fix:** Re-scope Phase 2 as a server-side change in `runToolLoop` (or a wrapper). The new contract should be:
- Round 1 dispatches `record_reading` as today.
- AFTER dispatch, instead of unconditionally calling Sonnet for round 2 with the tool_result, evaluate an "early-terminate" heuristic: single-value `record_reading`, no `is_error: true` tool_result, no `ask_user`, no observations — short-circuit and do NOT re-invoke Sonnet. The bundler runs with the round-1 dispatched data; the confirmation text comes from the friendly-name path (existing) or from a new round-1 text block (if you also adopt the text-before-tool prompt change as a SEPARATE, additive optimisation).

Two distinct techniques, two distinct gates. Today's plan conflates them.

### B2: "Sonnet's emitted text as audible confirmation" path breaks the Loaded Barrel cache key (mandatory cache MISS)
**Where:** Phase 2 §"Bundler changes", §"Speculator changes" + options 1/2/3, G2.d.

**Issue:** The Loaded Barrel cache key includes `expandedText` (see `loaded-barrel-cache.js:61-73`: `sha1(sessionId:turnId:boardId:field:circuit:expandedText)`). The plan's Option 3 says "friendly-name for cache key, Sonnet-text for the audible TTS text (when iOS POSTs the text from the bundler's result)" — and notes "iOS already does via `result.confirmations[].text`".

But the speculator hashes `expandForTTS(buildConfirmationText(field, value, circuit))` at speculate-time. iOS POSTs whatever `conf.text` it receives, expanded via iOS-side `expandForTTS` (AlertManager.swift:1003). If the bundler hands iOS Sonnet's text, iOS hashes Sonnet-text-expanded, backend hashed friendly-name-expanded — **guaranteed cache MISS on every single-round turn**. That defeats Loaded Barrel entirely on the exact turn shape Phase 2 optimises.

The plan acknowledges the open question but then says "Default to option 3 unless Codex flags a race." Option 3 as written is internally inconsistent.

**Fix:** Three honest paths:
- (a) **Backend overrides Sonnet's text with friendly-name at bundle time** when Loaded Barrel is enabled. iOS receives friendly-name text; Sonnet's text is dropped (used only for latency-shaping, not for the audible). Defeats half the rationale ("use Sonnet's text verbatim").
- (b) **Speculator subscribes to assembler text blocks** in addition to `onToolUseStreamed`. When Sonnet emits text BEFORE a `record_reading` in the same round, the speculator uses that text for the cache key. Requires extending `createAssembler` to expose text-block records and adding a new `onTextBlockStreamed` hook in `runToolLoop`. This is a structural change in `stage6-tool-loop.js` and `stage6-stream-assembler.js`, not a prompt change.
- (c) **Disable Loaded Barrel on single-round-close turns.** The friendly-name pre-synth is wasted; bundler emits Sonnet's text; iOS lives-synthesises. Loses the ~440ms Loaded Barrel win on exactly the turns where Phase 2 saves the most. Roughly break-even net.

Pick one. Document the trade-off. The plan as written promises both Loaded Barrel HIT AND Sonnet-text fidelity and you can't have both without (b).

### B3: Phase 1.1's `/regex-fast-write` endpoint emits a wire shape that conflicts with bundler invariants
**Where:** Phase 1.1 §"Server logic" step 5, §"Files".

**Issue:** The plan says the endpoint must "emit the same WS extraction message the Sonnet bundler would have emitted, with `source: "regex_fast_path"` so iOS can dedup if Sonnet ALSO fires." But:

1. The extraction WS message today is emitted by `runShadowHarness`/`runLiveMode` from `bundleToolCallsIntoResult(perTurnWrites, ...)` — keyed off the session's perTurnWrites. If the fast-write endpoint emits a parallel extraction message OUTSIDE the tool-loop turn, iOS's `handleServerExtraction` (`DeepgramRecordingViewModel.swift:7354`) sees TWO extraction envelopes for one turn — neither carries the `turn_id` the other expects (the Sonnet one will have a turnId; the fast-write one would need to mint a separate turnId or share one). The `applySonnetReadings` pipeline doesn't anticipate two envelopes for the same dictation. iOS would either double-apply or race on snapshot.

2. The bundler's wire shape includes `confirmations`, `circuit_updates`, `board_ops`, `observations`, `turn_id` — the fast-write endpoint synthesising "the same shape" requires reimplementing the bundler. It cannot just call `bundleToolCallsIntoResult` because there's no per-turn writes accumulator for the fast-path turn.

3. There's no `source` field on the extraction envelope today. The `confirmations[]` entries don't carry `source` either. The plan invents a field that doesn't exist in the wire (compare Loaded Barrel review B1's near-identical finding for `req.body.source` on TTS POST).

**Fix:** Choose ONE of:
- (a) The fast-write endpoint does NOT emit a WS extraction message. It only writes to `session.stateSnapshot` and to `session.regexResolvedSlots`. The Sonnet round (which still runs in parallel — see B5) emits the canonical extraction. iOS sees one envelope. The drift detector compares the fast-write's INTENDED bundler output against Sonnet's actual.
- (b) Define a new WS message type `regex_fast_extraction` with explicit schema. iOS adds a separate handler. Sonnet's later extraction merges/dedups via the `regex_resolved` flag on its readings. Substantially more iOS work.

Pick one. The current "emit the same shape" wording will silently produce a wire-collision bug.

### B4: Phase 1.3's "Sonnet sees the hint and suppresses its own duplicate" is not implementable as described
**Where:** Phase 1.3.

**Issue:** Two layered problems:

1. **Hint plumbing.** The plan says iOS "MUST also flag the same transcript in its concurrent Sonnet stream with a `regex_resolved: true` hint." iOS sends transcripts via the existing WS `transcript` message. There's no `regex_resolved` field today on that message. Adding it requires (a) iOS-side schema work, (b) sonnet-stream.js parsing, (c) routing the hint into the prompt or into the session.regexResolvedSlots set. The plan only says "the dispatcher checks `session.regexResolvedSlots`" — but the hint flows via WS, and there's a race between the WS hint arriving and the Sonnet stream actually being kicked off for that turn (sonnet-stream.js batches transcripts on Flux pauses; the hint and the transcript-batch trigger live on different ws messages).

2. **Suppression mechanism.** The plan says "Sonnet's session sees the hint and suppresses its own duplicate `record_reading` for the same (field, circuit) pair if and only if [the dispatcher rejects it]." This is contradictory: if the suppression is purely dispatcher-side (the model still emits the tool_use, dispatcher rejects with `regex_already_resolved`), then Sonnet has NOT suppressed anything — it has spent its output tokens on a doomed tool call. Latency cost is the same. The model needs to be TOLD (via prompt or system message) not to emit the call. That's a prompt change the plan doesn't mention.

   Worse, the dispatcher rejecting with `regex_already_resolved` returns `is_error: true` in the tool_result, which under current behaviour will trigger Sonnet to retry / explain in round 2 — adding latency, not saving it.

**Fix:** Specify the full hint plumbing chain end-to-end:
- (a) New `transcript.regex_resolved_slots: Array<{field, circuit, boardId}>` field on the WS transcript message.
- (b) sonnet-stream.js merges these into `session.regexResolvedSlots` BEFORE building the Sonnet messages array for the turn.
- (c) The cached prompt prefix renders the resolved slots as already-filled (same mechanism as the existing schedule/snapshot prefix). Sonnet sees the slot as populated → "Do NOT re-write values already in the prefix" (existing rule line 46) suppresses the call entirely.
- (d) Dispatcher's `regex_already_resolved` rejection becomes a belt-and-braces invariant, NOT the primary suppression mechanism. Mark the response with `is_error: false` to prevent retry-storm; payload `{noop: true, reason: 'already_resolved'}` so Sonnet treats it as a no-op like the existing `start_dialogue_script` noop.

Without this end-to-end specification, the plan promises 20-40% Sonnet bypass but delivers a dispatcher rejection that increases multi-round behaviour.

### B5: Race catalogue (Phase 1.3) is incomplete — at least 4 missing races
**Where:** Phase 1.3, Open question 1.

**Issue:** The plan enumerates two outcomes (regex-first vs Sonnet-first) and claims "last-write-wins on the snapshot." Missing or undertreated:

- **Race A — iOS regex matches but loses connectivity mid-write.** iOS POSTs to `/regex-fast-write`; the request hangs or the iOS app moves to background mid-transit. iOS's local TTS fires (assuming the regex-fast-tts call returned 200 successfully). User hears confirmation; certificate never gets the value. Today's Sonnet path would have lost the write too if iOS lost WS — but iOS has Reachability + retry that the new endpoint doesn't.
- **Race B — fast-write succeeds but Sonnet's round-2 ask_user fires for the same field+circuit.** The plan's Open question 1 acknowledges this but doesn't catalogue it. The ask_user races the fast-write — Sonnet's round 1 saw the unmodified prefix, decided to ask, gets dispatched. By the time `ask_user` reaches iOS, the value is already in the snapshot. iOS TTS-speaks "Which circuit is the X for?" pointlessly. The plan's `regex_resolved` hint (B4) only suppresses Sonnet's WRITE; an ask for the missing circuit context would still fire from round 1.
- **Race C — fast-write rejection but Sonnet's correction in flight.** If iOS posts `regex-fast-write` for `(measured_zs_ohm, circuit=2, value="0.4")` but the eligibility validator rejects because circuit 2 doesn't exist in snapshot, fast-write returns 4xx. Meanwhile Sonnet's round 1 emits `create_circuit(2) + record_reading(measured_zs_ohm, 2, 0.4)`. Sonnet succeeds; iOS doesn't get confirmation audio (fast-tts also fails or fails silently after the write failed). User stares.
- **Race D — concurrent multi-board switch.** iOS regex matches against the wrong board because the snapshot iOS uses is stale (`select_board` happened on a recent Sonnet turn but iOS hasn't yet decoded the board_ops envelope). Fast-write succeeds against current backend board, iOS's confirmation matches the user's belief about which board, snapshot and certificate diverge.
- **Race E — kill switch flipped after fast-tts started but before fast-write fires.** The plan says "kill switch active" returns 503. But the fast-tts call and fast-write call go to separate endpoints. iOS's "proceed when either returns 202" means the user can hear audio while the data write was killed mid-flight.

**Fix:** Either explicitly catalogue each race with deterministic resolution + add to G1 tests, or document each as known limitation gated by Phase 7 field assessment.

## IMPORTANTs (should be addressed)

### I1: Phase 0 (telemetry) is the dependency for Phase 1 and Phase 2 verification — but the plan ships them in parallel
**Where:** TL;DR, Phase 0, Phase 1 §1.5, G1.c, G2.c.

**Issue:** G1.c, G1.d, G2.c, G2.d all require Phase 0's `turn_summary` row to be live in CloudWatch. G1.c says "Measured via Phase 0 telemetry." But there's no phase-ordering invariant in the plan. The total-budget breakdown "10-15 days backend + 3-5 days iOS + 2 weeks field testing" doesn't show Phase 0 as a critical-path predecessor — it just appears first.

If Phase 1 ships in parallel with Phase 0, the verification gates G1.c/G1.d cannot be measured for the first 24h.

**Fix:** Add an explicit ordering invariant: "Phase 0 lands and produces `turn_summary` rows in a deployed task-def BEFORE any Phase 1 or Phase 2 code lands on main." Same gate structure Loaded Barrel used (`Phase 1` → `Phase 4a` iOS TestFlight → `Phase 2`).

### I2: Phase 0's per-round timing claim doesn't acknowledge today's `runToolLoop` signature
**Where:** Phase 0 §"Files".

**Issue:** `onLoopComplete` today fires AFTER the loop terminates with payload `{perTurnWrites, tool_calls, rounds, stop_reason, aborted, usage}` (see `stage6-tool-loop.js:752-759`). Per-round timestamps aren't currently captured anywhere — the loop doesn't track round start/end wall times. Adding them is straightforward but requires:
- Per-round `started` timestamp captured before `client.messages.stream`.
- Per-round `streamComplete` timestamp captured after `stream.finalMessage()`.
- A new array on the return value: `round_timings: [{round_idx, started_ms, stream_complete_ms, dispatch_complete_ms}]`.
- The shadow harness extending the payload it passes to the speculator's `onLoopComplete` AND to the new `emitTurnSummary`.

The plan's "extend `voice-latency-telemetry.js` and pass them out via `onLoopComplete`" understates this — `onLoopComplete` is a speculator hook today, not a telemetry hook. Either reuse it (and the speculator now has to ignore timing data it doesn't need) OR add a separate `onTurnSummary` hook.

**Fix:** Specify the new return-value field shape AND that `runShadowHarness` is the call site that materialises the telemetry row, not the loop itself. Add a unit test that asserts `round_timings.length === rounds` and that `sonnet_round1_ms = round_timings[0].stream_complete_ms - round_timings[0].started_ms`.

### I3: Phase 2's "synthesiseConfirmations(perTurnWrites, options)" data-plumbing for `options.modelText` is undefined for multi-value rounds
**Where:** Phase 2 §"Bundler changes".

**Issue:** The bundler builds `confirmations[]` by iterating `extracted_readings` and `extracted_board_readings` (see `stage6-event-bundler.js:50-82`). Each entry produces ONE confirmation via `buildConfirmationText`. The plan says: "if `options.modelText` is non-empty, treat it as the authoritative confirmation text for the single-value case AND skip the friendly-name lookup for that slot."

What if Sonnet's round 1 emits text + ONE record_reading + ONE record_observation? Or text + create_circuit + record_reading? Or text + two record_readings (the prompt explicitly allows this — Example 4 at line 143-145)? The plan's "scoped to single-value turns only" doesn't say what the bundler does when modelText IS provided but readings.length > 1. Use the text for which reading? All of them? None?

**Fix:** Specify the bundler behaviour explicitly:
- If `modelText` present AND `extracted_readings.length === 1` AND `extracted_board_readings.length === 0` → use `modelText` for the single confirmation.
- Otherwise → fall back to per-reading friendly-name (existing behaviour). Log `voice_latency.modelText_dropped_multivalue` for measurement.
- The loop must capture the round-1 text blocks and pass them via `runShadowHarness` → bundler `options.modelText`. Specify the round-1-only restriction: text from round 2+ is NEVER used because round 2 is the discard path.

### I4: The eligibility whitelist excludes fields that are already in the Stage 4 PoC's FRIENDLY table — silent drift
**Where:** Phase 1.2, `src/routes/voice-latency-fast-tts.js:39-50`.

**Issue:** The PoC endpoint's `FRIENDLY` table includes `earth_loop_impedance_ze` and `prospective_fault_current` — both EXCLUDED from the plan's `REGEX_FAST_ELIGIBLE_FIELDS` set (which lists only the 7 fields). If iOS today calls `regex-fast-tts` with `field: "earth_loop_impedance_ze"`, the PoC produces audio. After Phase 1, the new validation rejects with 4xx and iOS hears silence on a previously-working field.

Conversely the plan includes `polarity_confirmed` in eligibility, but `buildConfirmationText` returns NULL for false-y polarity values (`confirmation-text.js:105-108`) — fast-write succeeds with `value: "N"`, fast-tts speaks "Circuit X, polarity confirmed" (PoC's hardcoded text on line 56-58), bundler-drift detector flags it because the bundler would have emitted nothing.

**Fix:** Either (a) add Ze/PFC to `REGEX_FAST_ELIGIBLE_FIELDS`; or (b) explicitly document the migration: "PoC fast-tts callers requesting non-eligible fields receive 4xx; iOS today doesn't call this endpoint so no field regression possible." Verify the second clause via grep. Spoiler: today there are zero iOS callers — only `scripts/voice-latency-bench/transcript-replay.mjs`. So (b) is safe but the plan should state it. Also: drop `polarity_confirmed` from eligibility or coerce iOS to skip `polarity_confirmed=N` before posting.

### I5: iOS-side scope (Phase 1) is grossly under-estimated — there is NO iOS code today calling the fast-path
**Where:** Phase 1 §"iOS-side scope (3-5 days iOS, in parallel)", TL;DR budget.

**Issue:** Grep for `voice-latency/regex` / `RegexFast` / `regex-fast-tts` / `regex-fast-write` in iOS — zero hits. The endpoint today is exercised only by a Node bench script. The plan says iOS needs to:
1. Extend `TranscriptFieldMatcher` with 5 new patterns (1-2d).
2. Add designation matcher reusing snapshot's circuit schedule (1-2d — non-trivial; today's matcher matches by ref number, not designation).
3. Add POST plumbing for two new endpoints with parallel dispatch (1-2d).
4. Add capability handshake bit `regex_paired_write` (0.5d).
5. Handle the fast-tts streaming response and play it (this is NEW iOS code — today `proxyElevenLabsTTS` consumes an `audio/mpeg` response from `keys.js` and plays it via `AVAudioPlayer`; the fast-tts endpoint returns `audio/L16 PCM` chunked, which requires `AVAudioEngine` + a converter).

Item 5 is the big one. The PoC endpoint's response type is `contentTypeForFormat(client.outputFormat)` which depends on `ElevenLabsStreamClient.outputFormat` — typically PCM 16k or MP3 22050. iOS AlertManager today consumes MP3 only.

**Fix:** Lift iOS-side budget to ~10 days. Add an explicit "iOS Phase 1 audio decode strategy" sub-phase: either keep the PoC endpoint MP3-only (set the client output format to mp3_22050_32 — same as Loaded Barrel) or commit to the AVAudioEngine PCM path.

### I6: Phase 2.c verification gate ("≥70% adoption within 48h") has no behavioural floor
**Where:** Phase 2 G2.c.

**Issue:** "P50 `total_rounds == 1` ratio rises from ~0% (today) to ≥70% within 48h of prompt deploy." But:
- The "today ~0%" claim conflates "Sonnet ends turn in round 1" (theoretically possible if there's no tool_use at all — `ask_user` rounds, no-op rounds) with "single-value record_reading turns". A field-test session likely has SOME no-op turns (small talk) that already total_rounds=1 today. Need to filter.
- 70% is unweighted by turn shape. If Sonnet adopts the new rule 100% on `record_reading` but multi-value turns continue at 2 rounds (correct behaviour), the population denominator includes multi-value turns and 70% is unreachable.

**Fix:** Filter the metric: "Of all turns where extracted_readings.length === 1, board_readings.length === 0, observations.length === 0, questions.length === 0, AND no `is_error: true` tool_results, the rounds=1 ratio is ≥X%."

### I7: Phase 3 (Haiku) cost-rate fallback fires from a flag named `claude-opus-4-7`
**Where:** Phase 3 §"What".

**Issue:** "When `runToolLoop` enters round 2 (...) route round 2 to `claude-haiku-4-5-20251001` instead of `claude-opus-4-7` (or whatever the configured Sonnet model is)." But `stage6-shadow-harness.js:102` pins `SHADOW_MODEL = 'claude-sonnet-4-6'` — there's no `claude-opus-4-7` in the runtime today. Suggests the plan was drafted without verifying the production model.

**Fix:** S/`claude-opus-4-7`/`claude-sonnet-4-6`/. Add a note: Sonnet-4-6 production at $3/1M input + $15/1M output. Haiku-4-5 at $0.80/1M input + $4/1M output. Net per-turn delta on a 2-round end_turn no-op: ~$0.0012 savings.

### I8: Open question 4's edge case (create_circuit + record_reading) breaks the "single-value" classifier
**Where:** Open Q 4, Phase 2 §"Do this ONLY for the single-value clean path".

**Issue:** The prompt rule lists exclusions but doesn't address:
- `create_circuit` + `record_reading` (Example 3): one record_reading present, but also a circuit creation. Should the text be emitted?
- `start_dialogue_script` with `pending_writes` (common per the existing prompt line 27): the script runs and writes one slot, no record_reading at all.
- `record_board_reading` (Ze, PFC): single-value board readings. The prompt rule says "record_reading" specifically.

**Fix:** Either extend the prompt's "single-value clean path" enumeration to cover the equivalent shapes for `create_circuit + record_reading`, `record_board_reading`, and `start_dialogue_script(pending_writes=[1])`; OR explicitly exclude them with a one-liner.

### I9: Cost model claim "negative cost — fast-path turns skip Sonnet entirely" is overstated
**Where:** Phase 1 §"Cost", TL;DR.

**Issue:** The plan says "Sonnet: negative cost — fast-path turns skip Sonnet entirely." But:
- iOS regex matching runs IN PARALLEL with the WS transcript send to Sonnet — both fire. Until B4 is resolved end-to-end, Sonnet WILL run for every turn that takes the fast path, AND the cost of running Sonnet is on top of the cost of running the fast-path.
- Even with prompt suppression, Sonnet's round 1 still reads the prefix and emits ~50 output tokens of acknowledgement. Not free.

**Fix:** Honestly state: "Sonnet runs in parallel for every fast-path turn today (Phase 1.0 ships). Per-turn Sonnet output drops to ~50 tokens (no tool_use to emit) after the prompt suppression in Phase 1.3, saving ~80% of per-turn Sonnet output cost."

## NITs (clarity / consistency improvements)

### N1: Phase 0 telemetry adds `audible_ms` span but doesn't specify "first frame" measurement source
On the LB HIT path the first-byte event is server-side (the `res.write(cached.mp3Buffer)` moment in `keys.js`), which is ~30ms before iOS actually plays a frame. For consistency with the 2.5s target's wording, specify which event terminates the span.

### N2: Phase 1's `regex_paired_write` capability bit overlaps with the existing `regex_fast_tts` bit
`voice-latency-config.js:142` already declares `regex_fast_tts` as a known support — and the existing PoC endpoint doesn't even check it (gates on `streaming_http_audio` instead). Untangle: either rename `regex_paired_write` → `regex_fast_v2` to subsume both endpoints, OR document why two bits are needed and what the transitional state means.

### N3: Phase 2.D speculator hook (`onToolUseStreamed`) is referenced but not mentioned in Phase 2's bundler change
The existing `onToolUseStreamed` fires PRE-dispatch on every record_reading. If Phase 2 introduces text-before-tool, the speculator's streamed hook fires at the tool_use's `content_block_stop` — AFTER the text block has already streamed. Specify whether the speculator should defer the pre-synth by N ms to wait for a possible text block in the same response.

### N4: Phase 3's A/B gate `VOICE_LATENCY_HAIKU_ROUND2=true` isn't declared in voice-latency-config.js's SNAPSHOTTED_FLAGS list
The plan says Phase 3 is conditional, but if it fires it needs the flag in the snapshotted-per-session config. Add it to `SNAPSHOTTED_FLAGS` with default false.

### N5: Phase 0's `total_rounds` field already exists in `stage6_live_extraction.rounds`
Duplicating an existing field into the new `turn_summary` row is fine for query convenience but the plan should be explicit that this is a re-emission for analyser ergonomics, not new data capture.

### N6: "Friendly-name fallback" wording in Phase 2 is ambiguous between two distinct fallback levels
Specify which: (a) Bundler-level fallback when `modelText` absent; (b) Sonnet-level — the prompt instructs Sonnet to emit text with friendly mapping. Phase 2.d drift detector wouldn't catch the divergence unless it compares modelText against `buildConfirmationText(field, value, circuit)`.

### N7: Verification gate G4 ("≥70% of routine `record_reading` turns hit ≤ 2.5s P50 audible") has no denominator definition
"Routine" is undefined. Suggest: "Of all turns where `extracted_readings.length === 1`, `extracted_board_readings.length === 0`, no observations, no questions, no errors, no Phase 2 round-2 fired — measure P50 of `audible_ms`."

## Recommended verdict

**DO NOT SHIP.** Five BLOCKERs, the most serious of which (B1) means Phase 2's central architectural premise is mistaken. v2 should:
1. Re-scope Phase 2 as a server-side `runToolLoop` short-circuit, not a prompt change. The prompt change is an additive optimisation, not the core latency lever.
2. Resolve the cache-key-vs-Sonnet-text trilemma (B2) explicitly.
3. Specify the fast-write WS emission contract (B3) and the regex-hint plumbing (B4) end-to-end.
4. Extend the race catalogue (B5) and the iOS-side budget (I5).

Loaded Barrel went through 9 rounds to reach zero BLOCKERs; this plan is at v1 with structurally larger architectural confusion than Loaded Barrel v1 had. Expect 4-6 more rounds.

## Open questions for the executing session

1. **Phase 2 architecture decision:** Is the latency win primarily from "don't call Sonnet for round 2" (server-side short-circuit) or from "Sonnet's text drives the audible" (text-before-tool prompt change)? They're two distinct wins. The plan conflates them. Derek's intent matters here — if the former is acceptable for v1 with friendly-name confirmations preserved, Phase 2 becomes ~2x simpler.

2. **Phase 1 fast-write parity contract:** Is the fast-write endpoint expected to be wire-equivalent to a Sonnet record_reading (full extraction envelope, turn_id, board_ops, confirmations) OR a side-channel write that doesn't emit a public extraction? Today's PoC implies the latter; Phase 1.1 step 5 implies the former. Pick one before any iOS work starts.

3. **Sonnet-text fidelity vs Loaded Barrel HIT rate:** Which matters more for the 2.5s target? If Loaded Barrel HIT (cache parity) wins, drop Phase 2's "Sonnet's text verbatim" claim and accept friendly-name. If Sonnet-text wins, disable Loaded Barrel on single-round-close turns and accept the ~440ms regression on those turns.

4. **iOS-side regex matcher confidence threshold:** Plan says 0.9. Without a 30-day audit, that's a guess. Lower would broaden coverage but raise drift risk.

5. **Phase 3 trigger ambiguity:** "Only triggered if G2 misses 2.5s target" — but if G2 passes, has Phase 3 been validated against Haiku model availability for tool-use streaming?
