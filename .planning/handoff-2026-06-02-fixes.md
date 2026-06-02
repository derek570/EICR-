# Handoff — Three voice-extraction fixes from 2026-06-02 field test

**Read this entire file before starting. It is self-contained — you don't need conversation history.**

You are shipping three backend fixes that close bugs surfaced during Derek's 2026-06-02 TestFlight smoke test against prod. The bugs are all real, all reproduced empirically, and have CloudWatch event evidence. Each fix has an explicit recommended implementation; one (Fix C2) requires a probe pass against prod BEFORE you commit to an approach because Sonnet's actual behaviour on edge cases hasn't been observed yet.

A parallel handoff (`.planning/handoff-2026-06-02-harness-audit.md`) covers a broader harness audit; don't duplicate scenarios this handoff prescribes, but if the audit handoff runs concurrently, coordinate so the audit picks up classes BEYOND the three this handoff covers.

## What this session does

Ships fixes for three bugs from session `E87F58C1-D2A4-404B-8846-C75CCE98E3F1` (Derek's 2026-06-02 09:34:48–09:36:11 BST smoke test):

1. **Fix A — Speculator vs broadcast race** (`src/extraction/loaded-barrel-speculator.js` + `src/extraction/sonnet-stream.js`)
2. **Fix B — Off-enum value validation gap** (`src/extraction/stage6-dispatch-validation.js`)
3. **Fix C2 — Multi-circuit fan-out forcing** (architectural design first; implementation TBD per probe results)

For each fix you also write the regression-guard harness scenarios so future field tests can't re-surface the same class.

## Repos and working directories

- **Backend (all the work):** `/Users/derekbeckley/Developer/EICR_Automation`
- **iOS (CertMate):** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` — own `.git`, NOT touched by this session
- **Harness:** `scripts/voice-latency-bench/transcript-replay.mjs` (WS-based, hits prod via `run-harness-against-prod.sh`)
- **Scenarios:** `tests/fixtures/voice-latency-scenarios/` — 87 currently passing; add new ones to existing subdirs or `tests/fixtures/voice-latency-scenarios/fixes_2026_06_02/`

Both repos auto-sync to GitHub; `git push origin main` works normally.

## Current state — what already shipped today (2026-06-02)

In flight at the start of this session: CI run `26802646728` (and the chain after) deploying the two fixes from earlier today:

- `1fae7def` — `fix(extraction): wire postcode lookup into runLiveMode` — closed Codex round 5's "postcode unwired in live mode" finding.
- `0632d352` — `fix(dialogue-engine): specificity-rank schemas in tryEnterScriptFromWrites` — closed the RCD→RCBO mis-route finding.
- `6069f041` — `test(harness): tighten postcode + new RCD-recovery scenario after fixes` — pinned both.

Check CI status before running any harness probes: `gh run list --limit 3`. The deploy must be complete (ECS `eicr-backend` rolloutState `COMPLETED`) before harness scenarios for the postcode+specificity fixes will pass. If CI is still in flight, do non-harness work first (read code, write tests).

The newer push from your session (this handoff itself) is on `main` as commit `07cd5939` or similar — see `git log --oneline -5`.

## Empirical evidence — session E87F58C1 timeline

You need these timestamps to ground every fix decision. CloudWatch query:

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 24h 2>&1 \
  | grep -E "E87F58C1" | head -60
```

Session debug log (iOS-side):

```bash
aws s3 cp s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/E87F58C1-D2A4-404B-8846-C75CCE98E3F1/debug_log.jsonl /tmp/E87F58C1.jsonl --region eu-west-2
```

Three transcript turns:

**Turn 1 (09:35:05) — clean broadcast (worked correctly):**
- Transcript: `"Test voltage for all circuits is two hundred and fifty volts."` (Deepgram-normalised: `"Test voltage for all circuits is 250 volts."`)
- iOS: `voice_command_apply_field {field: ir_test_voltage, scope: all, updated: 3, value: '250'}` — Sonnet used `set_field_for_all_circuits` correctly.
- TTS: `"Done. Set insulation test voltage on 3 circuits."` (one TTS, no overlap)
- **No bug.** Establishes that Sonnet CAN fan out correctly with explicit "for all circuits" phrasing.

**Turn 2 (09:35:22) — TTS overlap (Fix A):**
- Transcript: `"Live to earth insulation resistance on circuits 2 and 3 is greater than 299 MΩ"`
- Sonnet emitted 2 `record_reading` calls (per-circuit), one for circuit 2 and one for circuit 3 — correct.
- BUT the Loaded Barrel speculator fired on the FIRST `record_reading` (circuit 2 only) and shipped per-circuit TTS to iOS:
```
09:35:25.693  loaded_barrel_started  field=ir_live_earth_mohm circuit=2
09:35:26.132  loaded_barrel_fired    bytes=19585 → mid_stream_emit → iOS plays "Circuit 2, IR L to E >299"
09:35:26.166  loaded_barrel_hit      iOS POST received cached audio (cache was warm from prior session)
09:35:26.520  loaded_barrel_broadcast_detected  first=2 second=3 (388 ms after first emit)
09:35:26.667  stage6_tool_call      record_reading circuit 2 + record_reading circuit 3
09:35:26.667  broadcast_suppressed  (twice — but speculator already shipped)
09:35:26.667  bundler emits grouped "Circuits 2, 3, IR L to E >299"
09:35:26.979  ElevenLabs TTS bytes=47691 for the grouped text → iOS plays second TTS on top
```
- **The user heard two TTS payloads overlap.** Both confirmations have different text ("Circuit 2..." vs "Circuits 2, 3..."), so iOS played both.

**Turn 3 (09:35:50) — off-enum value + missing fan-out (Fixes B + C2):**
- Transcript: `"RCD type for circuits 2 and 3 is a."` (Deepgram-normalised exact)
- iOS log: `voice_command_apply_field {field: 'rcd_type', scope: 'specific', updated: 1, value: 'AND'}`
- Two distinct bugs:
  - **B:** Sonnet wrote `rcd_type = "AND"` — the string "AND". `rcd_type`'s enum (per `config/field_schema.json:circuit_fields.rcd_type.options`) is `["", "AC", "A", "F", "B", "S", "N/A"]`. `"AND"` is not valid. `validateRecordReading` (`src/extraction/stage6-dispatch-validation.js:73-88`) only checks circuit existence + confidence range — no field-value enum guard exists. The bad value persisted to iOS state and would have been written to the cert PDF.
  - **C2:** Sonnet only wrote to circuit 2, missed circuit 3, despite the explicit "circuits 2 and 3" phrasing.
- TTS: `"Done. Set R C D type on 1 circuit."` (the "1 circuit" gives away the under-fanning)

The full debug log has 174 events. Use it to ground any other decision.

## Authoring rules (recap — see `tests/fixtures/voice-latency-scenarios/SCHEMA.md` for full table)

- Circuit-level field names in `has_reading`: LEGACY (post `validateAndCorrectFields` rewrite) — `zs`, `insulation_resistance_l_l`, `polarity`, etc.
- Board-level field names (`circuit: 0`): also LEGACY — `ze`, `pfc`. NOT `earth_loop_impedance_ze`.
- Dialogue-engine reply turns emit via `buildExtractionPayload` (`src/extraction/dialogue-engine/helpers/wire-emit.js:163`) which carries the schema slot's `field` verbatim (canonical for IR/RCBO, legacy for RCD).
- `has_no_reading` for negative-control assertions ("X must NOT be written on circuit Y"). Load-bearing.
- `forbid_event_tokens: [extraction:speculator]` for "speculator must NOT fire here." Do NOT delete this assertion without verifying speculator behaviour matches user intent — its prior deletion is exactly what let Fix A's bug ship.

---

## Fix A — Speculator vs broadcast race

### Symptom
Multi-circuit `record_reading` writes from a single Sonnet turn result in TWO overlapping TTS payloads on iOS: the speculator's per-circuit form ("Circuit 2, IR L to E >299") AND the bundler's grouped form ("Circuits 2, 3, IR L to E >299"). User hears them on top of each other.

### Root cause
`src/extraction/loaded-barrel-speculator.js:onToolUseStreamed` (line ~903) fires on EVERY `record_reading` streamed by Sonnet. Per-circuit broadcast suppression (`broadcastBuckets`, lines 348-403) only triggers when the SECOND `record_reading` for the same `(field, value, board_id)` arrives. By that time the speculator has already:

1. Opened the cost-ledger correlation (`recordOutcome(correlationId, 'loaded_barrel_started')`, line ~582)
2. Kicked off the ElevenLabs synth (line ~597)
3. Fired the WS `mid_stream_emit` event to iOS via `onSlotAudioReady` (line ~629)
4. iOS has POSTed `/api/proxy/elevenlabs-tts`, fetched bytes, and started playback

The `broadcast_suppressed` log line + `controller.abort()` (line 374) fire AFTER iOS has the bytes. Aborting the synth is irrelevant by then.

In session E87F58C1, the gap between `loaded_barrel_fired` (09:35:26.132) and `loaded_barrel_broadcast_detected` (09:35:26.520) was 388 ms — wide enough for iOS to have received and started playing the speculator's per-circuit TTS.

### Proposed implementation (recommended approach)

**Use upstream broadcast-intent detection to skip the speculator entirely on broadcast turns.** The dialogue engine already has `detectBroadcastIntent(text)` in `src/extraction/dialogue-engine/parsers/circuit-range.js:158` that pattern-matches the transcript BEFORE Sonnet runs. Three regexes:

- `BROADCAST_ALL_RE` — "for/across/on/to all circuits", "every circuit", "whole board"
- `BROADCAST_RANGE_RE` — "circuits 1 to 6", "circuits 1 through 5"
- `BROADCAST_LIST_RE` — "circuits 2 and 3", "circuits 2, 3, 5"

Wire this signal into the active session entry so the speculator can read it:

**Step 1** — extend the activeSessionEntry shape. `src/extraction/active-sessions.js` documents the entry contract in JSDoc; the actual `new Map()` initialisations live in `src/extraction/sonnet-stream.js` where `activeSessions.set(sessionId, {...})` is built (search for `pendingFastTtsSlots: new Map()` — that's the sibling line, currently around `sonnet-stream.js:2564`). Add `broadcastIntentByTurn: new Map(),` adjacent to it. Update the JSDoc shape in `active-sessions.js` to document the new map's purpose + lifecycle (per-turn keyed by turnId, cleared in the same place `pendingFastTtsSlots` is cleared).

**Step 2** — `src/extraction/sonnet-stream.js handleTranscript`: import `detectBroadcastIntent` from `./dialogue-engine/parsers/circuit-range.js`. The function `handleTranscript` is the WS-message handler for `type: 'transcript'`. Search for the call chain `handleTranscript` → eventually `runShadowHarness(entry.session, transcriptText, regexResults, {...})` (this call is around `sonnet-stream.js:3793`). After the `entry = activeSessions.get(sessionId)` resolve (which precedes the `runShadowHarness` await) and AFTER `turnId` has been minted by `runLiveMode`, set `entry.broadcastIntentByTurn.set(turnId, true)` if `detectBroadcastIntent(transcriptText)` returns true. CAVEAT: turnId is minted INSIDE `runLiveMode` (`stage6-shadow-harness.js:213`), not in `handleTranscript`. Two options:
  - Option (a): call `detectBroadcastIntent(transcriptText)` in `handleTranscript`, pass the boolean result down through `runShadowHarness` `options`. `runLiveMode` then stamps the per-turn map with the minted `turnId`. Cleanest signal flow, but requires plumbing.
  - Option (b): do the detection AND the map write inside `runLiveMode` itself, right after `turnId` is built (around `stage6-shadow-harness.js:213`). Less code surface, tighter to the existing `entry.fastPathCorrelationIdByTurn` pattern (`stage6-shadow-harness.js:230-234`).
  - Recommend (b) — mirrors the existing per-turn-map pattern. Read both files first then decide.

**Step 3** — clear the map entry in the same `finally` block that already does per-turn cleanup. `runLiveMode` has a `try/finally` (search for "finally" + "session.activeTurnTranscript = null"). Add `entry?.broadcastIntentByTurn?.delete(turnId);` to that block.

**Step 4** — `src/extraction/loaded-barrel-speculator.js`. The check goes in the `_speculate` helper (called by both `onToolUseStreamed` and `onSnapshotPatch`). `_speculate` does the broadcast bucket detection at `loaded-barrel-speculator.js:348-403`. Insert the new check BEFORE that bucket logic so the cheap skip happens first. Resolve the activeSessionEntry via `getActiveSessionEntry(sessionId)` (already imported on line 74; existing usages at lines 418-419 for `pendingFastTtsSlots`). If `Number.isInteger(circuit) && circuit > 0` AND `entry?.broadcastIntentByTurn?.get(turnId) === true`, return early. Log `voice_latency.loaded_barrel_skipped_broadcast_intent` with `{sessionId, turnId, field, circuit, boardId}` — mirrors the existing `loaded_barrel_skipped_fast_tts_hint` log shape (line ~421).

### Why this approach (vs alternatives considered)

- **Alternative: holdoff timer before synth.** Wait 250-500 ms before firing the synth, cancel if broadcast detected during the window. Adds latency to EVERY per-circuit confirmation. Speculator's whole purpose is to win the latency race against the bundler (~535 ms advantage in Derek's session); a 250-500 ms holdoff erases most of that.
- **Alternative: debounce streamed `record_reading` calls.** Reset a "fire when stream goes idle" timer on each call. More complex state machine; needs per-slot timer tracking. Same latency cost as holdoff for the common single-circuit case.
- **Alternative: iOS-side TTS interruption.** Backend ships speculator + bundler confirmations; iOS plays the latest only. Touches iOS code (out of scope this session) AND ships wasted bytes.

The chosen approach is zero-latency-cost on single-circuit turns (the common case), 100% correct on broadcast turns (no race window), and uses an existing helper (`detectBroadcastIntent`) rather than inventing new detection logic. Defence in depth pairs naturally with the existing post-detect bucket suppression — if `detectBroadcastIntent` ever misses a broadcast pattern, the bucket suppression still aborts; the user just hears the (still-correct) per-circuit form first and the grouped form second, which is no worse than today's bug.

### Test surface

Targeted unit tests:

- `src/__tests__/loaded-barrel-speculator-broadcast-intent.test.js` (new): mock activeSessionEntry with `broadcastIntentByTurn` set for `turnId`; call `onToolUseStreamed` with a `record_reading` for circuit 2; assert no synth fires, telemetry emits the skip log.
- `src/__tests__/sonnet-stream-broadcast-intent-wiring.test.js` (new): exercise `handleTranscript` with a "circuits 2 and 3" transcript; assert `entry.broadcastIntentByTurn` is set during the turn, cleared after.

Existing tests to re-run: anything matching `/loaded-barrel|sonnet-stream/i`. Today's `npm test` baseline is 2368 tests across 98 suites — all pass. Your fix must keep that green.

### Harness scenario to add

`tests/fixtures/voice-latency-scenarios/fixes_2026_06_02/speculator_broadcast_race_suppressed.yaml` (new):

- Job state: 4 circuits.
- Transcript: `"Live to earth insulation resistance on circuits 2 and 3 is greater than 299 megohms."` (exact phrasing from session E87F58C1 to match the actual repro).
- Assertions:
  - `has_reading` for circuits 2 + 3 with `insulation_resistance_l_e=">299"`
  - `has_no_reading` for circuits 1 + 4 with that value
  - `confirmation_count: { min: 1, max: 1 }` — exactly ONE confirmation (the grouped form). Pre-fix this would be 2.
  - `forbid_event_tokens: [extraction:speculator]` — speculator must not fire on this broadcast turn. THIS is the assertion whose deletion let the bug ship; pin it permanently here.
  - `confirmation_text_contains: ["Circuits 2, 3"]` or similar (verify the grouped text shape against your first prod run).

### Risks / rollback

- **Risk:** `detectBroadcastIntent` over-matches → kills the speculator on a turn where it would have been correct. Telemetry tag `loaded_barrel_skipped_broadcast_intent` makes this debuggable post-hoc.
- **Risk:** dialogue engine's broadcast-intent regex needs widening for a new phrasing the user invents → speculator misses suppression and old race reappears. Mitigated by retaining the existing bucket-suppression as fallback.
- **Rollback:** set `entry.broadcastIntentByTurn` map writes to no-op (a feature flag env var `VOICE_LATENCY_BROADCAST_INTENT_SUPPRESS=false` would work). Speculator falls back to today's bucket-only behaviour. 2-minute ECS env-var change.

---

## Fix B — Off-enum value validation gap

### Symptom
Sonnet can write any string to any field via `record_reading`. The dispatcher accepts it. iOS persists it. The cert PDF would contain it.

In session E87F58C1 turn 3, `rcd_type = "AND"` made it all the way through. The valid enum (per `config/field_schema.json:circuit_fields.rcd_type.options`) is `["", "AC", "A", "F", "B", "S", "N/A"]`.

### Root cause
`src/extraction/stage6-dispatch-validation.js:validateRecordReading` (lines 73-88) only checks:
1. Circuit exists in snapshot (`circuit_not_found`)
2. Confidence is a finite number in [0, 1] (`confidence_out_of_range`)

It does NOT consult `config/field_schema.json` to check whether the field has a closed enum and whether `input.value` is in it. The downstream `applyReadingToSnapshot` writes the value verbatim. iOS likewise stores the wire value with no per-field-type validation.

### Proposed implementation

**Step 1** — `src/extraction/stage6-dispatch-validation.js`. NOTE: the existing `CIRCUIT_FIELD_ENUM` in `stage6-tool-schemas.js:143-146` is an array of field NAMES (the closed namespace of which fields exist) — NOT a map of field→allowed-values. You're building something different: a per-field value enum. At module-load time, import `fieldSchema from '../../config/field_schema.json'` (or wherever the existing import path resolves to from this file — `stage6-tool-schemas.js:130` is the reference). Then build:

```js
const CIRCUIT_FIELD_VALUE_ENUMS = (() => {
  const out = new Map();
  const fields = fieldSchema.circuit_fields ?? {};
  for (const [name, spec] of Object.entries(fields)) {
    if (name.startsWith('_ui_')) continue;
    if (spec?.type === 'select' && Array.isArray(spec.options)) {
      out.set(name, new Set(spec.options.map(String)));
    }
  }
  return out;
})();
```

**Step 2** — extend `validateRecordReading` after the existing confidence check:

```js
const allowed = CIRCUIT_FIELD_VALUE_ENUMS.get(input.field);
if (allowed && typeof input.value === 'string') {
  // Empty string is always allowed (clear/unset semantics — matches
  // the empty option already in every select field's enum).
  const v = input.value;
  if (v !== '' && !allowed.has(v)) {
    return { code: 'value_not_in_enum', field: 'value' };
  }
}
return null;
```

EDGE CASES to handle in tests:
- Field is `type: "select"` but value is non-string (e.g. boolean true → coerce check). Decision: reject as invalid type OR coerce per existing dispatcher coercion (look at `coerceRecordReadingValue` in `src/extraction/loaded-barrel-speculator.js` — there's a coercion for `polarity_confirmed` true → "Y"). Apply the SAME coercion BEFORE the enum check so this fix doesn't reject values the dispatcher would have coerced into the enum.
- Field is NOT in CIRCUIT_FIELD_VALUE_ENUMS (numeric / text / no closed enum) → skip the check, return null. Default-allow.
- `input.field` is itself off-namespace (not in CIRCUIT_FIELD_ENUM at all). That's caught by upstream field-name validation; if not, defence in depth says treat as invalid_field.

**Step 3** — `src/extraction/stage6-dispatchers-circuit.js` (the dispatcher caller of `validateRecordReading`, around line 105): the existing `validation_error` log path will surface the new code. Verify the tool_result returned to Sonnet on rejection is structured enough that Sonnet retries with a valid value rather than panicking — look at how other validation_error codes are formatted (`circuit_not_found` is the template).

**Step 4** — parallel work for `record_board_reading`. The board-side validator lives in `src/extraction/stage6-dispatchers-board.js` (search for `validateRecordBoardReading` or the per-board enum check). Same pattern: build `BOARD_FIELD_ENUMS` and reject off-enum values.

### Why this approach

The dispatcher boundary is the right layer for enum enforcement:

- The schema is closed and authoritative (`config/field_schema.json` is single source of truth, already consumed by `BOARD_FIELD_ENUM` builder at `stage6-tool-schemas.js:130`).
- Sonnet sees the rejection as a `validation_error` tool_result and can self-correct mid-loop (same pattern as today's `circuit_not_found`).
- iOS doesn't need any change — the bad write never leaves the backend.
- Defence in depth: even if a future prompt tweak makes Sonnet emit off-enum more often, the dispatcher rejects.

The alternative (iOS-side validation) was rejected: iOS already has the enum (in `Constants.swift`) but uses it only for UI dropdowns, not for write filtering. Centralising in the backend dispatcher keeps the contract single-sourced.

### Test surface

- `src/__tests__/stage6-dispatch-validation-enum.test.js` (new): cases for each enum field with a valid value (pass), with an empty string (pass — clear semantics), with an obviously-bad value like `"AND"` for `rcd_type` (rejected with `value_not_in_enum`).
- Existing dispatcher tests must still pass — anything with `validateRecordReading` in the path.

### Harness scenario to add

`tests/fixtures/voice-latency-scenarios/fixes_2026_06_02/rcd_type_off_enum_rejected.yaml` (new):

- Job state: 1 circuit (cooker, circuit 3, no RCD fields).
- Transcript: `"RCD type for circuit 3 is a."` (exact repro phrasing — should yield Sonnet writing `"AND"` pre-fix).
- Assertions:
  - `has_no_reading: [{ circuit: 3, field: rcd_type, value: "AND" }]` — value MUST be rejected.
  - `has_no_reading: [{ circuit: 3, field: rcd_type, value: "and" }]` — also any lowercase variant.
  - Optional positive assertion: if Sonnet retries with `"A"` after the validation error, `has_reading: [{ circuit: 3, field: rcd_type, value: "A" }]`. Verify this against your first prod run — Sonnet may or may not retry.

### Risks / rollback

- **Risk:** legitimate Sonnet writes get rejected because the enum is out of date with reality. Mitigation: enum is auto-loaded from `field_schema.json`; updating the schema fixes both validator and UI in one place.
- **Risk:** dispatcher rejection causes Sonnet to retry-loop within the turn, stalling. Mitigation: validation_error already returns a structured envelope Sonnet handles — confirm this in test.
- **Rollback:** feature flag `STAGE6_VALIDATE_VALUE_ENUMS=false` on task def to bypass the new check. 2-minute ECS env-var change.

---

## Fix C2 — Multi-circuit fan-out forcing

### Symptom
Sonnet sees "circuits 2 and 3" in a transcript and writes to only circuit 2. Same Sonnet-behaviour class that made the multi-circuit batch matrix scenarios flake during the 2026-06-01 harness rollout.

### Root cause (this one needs you to PROBE before you implement)

Sonnet's tool-use behaviour on multi-circuit transcripts is non-deterministic:

- "for all circuits" / "every circuit" → almost always uses `set_field_for_all_circuits` (turn 1 of session E87F58C1 confirms).
- "circuits 2 and 3" / "circuits 1 through 5" → sometimes emits N parallel `record_reading` calls (correct), sometimes emits 1 `record_reading` for the first circuit only (under-fanning bug).

The transcript shape that fails is the explicit-list / explicit-range form. The dialogue-engine's `detectBroadcastIntent` already recognises these patterns (BROADCAST_LIST_RE + BROADCAST_RANGE_RE in `circuit-range.js`) but doesn't propagate the signal anywhere that influences Sonnet's tool choice.

### BEFORE implementing — run a probe pass

Three transcript shapes, run each 10× against prod, tally the outcomes:

1. `"RCD type for circuits 2 and 3 is A."` — the exact repro phrasing
2. `"Polarity confirmed for circuits 2 and 3."` — different field, same shape
3. `"Insulation resistance L to L for circuits 1 through 4 is greater than 200 megohms."` — range shape

For each run, capture:
- How many `record_reading` calls did Sonnet emit? (parse `stage6_tool_call` events)
- Did Sonnet use `set_field_for_all_circuits` at all? (extremely rare for list/range scopes)
- Which circuits got the write?

This empirical baseline determines which implementation approach is safe.

### Three candidate approaches (decide based on probe results)

**Approach 1 — Prompt change.** Edit `config/prompts/sonnet_extraction_system.md` to make Sonnet's BULK OPERATIONS section more explicit: "when the inspector says 'circuits N and M' or 'circuits X through Y', you MUST emit one `record_reading` per circuit in the list/range. Do not emit a single `record_reading` for only the first circuit." Test against the 3 probes; verify hit rate jumps to ≥90%.

- **Pros:** smallest blast radius, no new dispatcher logic, immediately reversible.
- **Cons:** prompt tweaks can have unrelated side effects on other turn shapes. Sonnet may still flake on edge phrasings. Hit rate may not reach 100%.

**Approach 2 — Pre-LLM intercept that rewrites tool guidance.** In `sonnet-stream.js handleTranscript`, before runShadowHarness, call `detectBroadcastIntent(transcriptText)`. If true, prepend a per-turn system message (or inject into the user message) explicitly listing the circuit numbers + reminding Sonnet to emit per-circuit `record_reading`s OR use `set_field_for_all_circuits` with `scope: 'specific'`.

- **Pros:** turn-scoped, doesn't change baseline prompt for non-broadcast turns. More targeted.
- **Cons:** requires plumbing through `runLiveMode` → `runToolLoop` → message build. More code surface. Cache key behaviour with per-turn system additions needs verification (currently `system` is cached at 5m; per-turn injection could invalidate cache).

**Approach 3 — Post-Sonnet rejection.** Detect at the dispatcher boundary: if `detectBroadcastIntent(activeTurnTranscript) === true` AND Sonnet emitted only 1 `record_reading` for a field with multiple circuits implied, reject with a synthesised error and let runToolLoop retry. The retry sees the rejection + the original transcript and (hopefully) emits the right tool call.

- **Pros:** no prompt change, no per-turn message injection. Pure validator change.
- **Cons:** could stall turns if Sonnet doesn't recover on retry. Requires knowing the implied circuit count ahead of time (parse the transcript with `parseCircuitList` from `circuit-range.js`). Higher latency on misfires.

**Recommended decision tree based on probe results:**

- If Approach 1's prompt change gets ≥90% hit rate on all 3 probes → ship Approach 1, monitor.
- If Approach 1 hit rate plateaus at 60-80% → ship Approach 2 (pre-LLM intercept) for the explicit-list/range patterns only.
- If Approach 2 also flakes → escalate to Derek before shipping Approach 3 (the rejection-retry path is the most invasive).

### Implementation skeletons (only fill in after probe)

For Approach 1 (prompt change), search `config/prompts/sonnet_extraction_system.md` for "BULK OPERATIONS" or "multi-circuit" and reinforce the per-circuit-emit rule there. Make a one-paragraph change. Commit message must explain the probe data that drove the wording choice.

For Approach 2 (pre-LLM intercept), parse the transcript via `parseCircuitList` (in `circuit-range.js`) when `detectBroadcastIntent` returns true and the pattern is list/range (not "all circuits"). Build a per-turn message fragment like:

```
The inspector mentioned circuits 2 and 3 in this utterance. Emit one
`record_reading` per circuit (2 and 3) for any field they specified.
```

Inject into `userMessage` before `runToolLoop` (`stage6-shadow-harness.js:runLiveMode`). Verify Anthropic prompt-caching contract still holds — the cached `system` should remain identical; only the `messages[]` per-turn content changes.

For Approach 3 (post-Sonnet rejection), in `stage6-dispatchers-circuit.js:dispatchRecordReading` (around line 105), after the existing `validateRecordReading` call, add a check: if `session.activeTurnTranscript` matches a list/range broadcast pattern, capture the implied circuit set; track per-turn which circuits got `record_reading` for the field; if the set is incomplete at end-of-round, reject with `multi_circuit_incomplete` so Sonnet retries.

### Test surface

For all three approaches: probe-driven. Write tests AFTER the probe runs and you know what Sonnet does.

For Approach 1 (prompt change) specifically: there's no unit test for prompt content. The only test is the harness scenario hit rate.

For Approaches 2 + 3: unit tests for the new logic (the per-turn intercept or the rejection path).

### Harness scenarios to add

`tests/fixtures/voice-latency-scenarios/fixes_2026_06_02/multi_circuit_list_rcd_type.yaml` (new):

- Job state: 4 circuits.
- Transcript: `"RCD type for circuits 2 and 3 is A."`
- Assertions:
  - `has_reading: [{ circuit: 2, field: rcd_type, value: "A" }, { circuit: 3, field: rcd_type, value: "A" }]`
  - `has_no_reading: [{ circuit: 1, field: rcd_type }, { circuit: 4, field: rcd_type }]` (with `value` omitted = match any)

`tests/fixtures/voice-latency-scenarios/fixes_2026_06_02/multi_circuit_range_polarity.yaml` (new):

- Transcript: `"Polarity confirmed for circuits 1 through 4."`
- Assertions: 4 circuits get `polarity = "Y"`, circuit 5+ (if any in job state) get `has_no_reading`.

`tests/fixtures/voice-latency-scenarios/fixes_2026_06_02/multi_circuit_list_ir_ll.yaml` (new):

- Transcript: `"Insulation resistance L to L for circuits 2 and 3 is greater than 200 megohms."`
- Tests the IR field path (different from rcd_type which has the "AND" issue).

These scenarios will pre-fix flake at the same rate the probe showed. Post-fix they should pass ≥90% of runs (if Approach 1) or 100% (if Approach 2/3). Document the expected hit rate in each scenario's `description` so future authors don't delete a 95%-flaky test as "noise" the way the 2026-06-01 deletions did.

If the chosen approach has <100% hit rate, also mark each scenario in `tests/fixtures/voice-latency-scenarios/KNOWN_FLAKY.md` (which the audit handoff creates).

### Risks / rollback

- **Approach 1 (prompt):** prompt regressions on unrelated turn shapes. Rollback = `git revert` of the prompt commit.
- **Approach 2 (intercept):** per-turn message injection breaks Anthropic prompt cache → cost explosion. Mitigation: verify cache hit rate via `voice_latency.startup_log.usage_cache_read` before/after on the probe runs. Rollback = feature flag `STAGE6_BROADCAST_INTERCEPT=false`.
- **Approach 3 (rejection):** stall turns when Sonnet doesn't retry. Rollback = feature flag.

---

## Things NOT to do

- **Don't ship Fix C2 without the probe pass.** The whole choice between approaches depends on Sonnet's empirical behaviour. Guessing wrong here is how prompt tweaks cause cascading regressions.
- **Don't delete harness scenarios because they're flaky.** The 2026-06-01 deletions caused the 2026-06-02 field-test bugs. Use `KNOWN_FLAKY.md` instead.
- **Don't touch iOS (`CertMateUnified`).** All fixes are backend-only. Bug 1 (TTS overlap) was tempting to fix iOS-side via TTS queue management; reject — backend should not ship wrong-text TTS in the first place.
- **Don't bundle fixes into one commit.** A + B + C2 are three logically separate concerns. One commit each (plus harness scenarios), so individual reverts are clean.
- **Don't skip pre-commit hooks** (`--no-verify`). If lint fails, fix the lint.

## Order of operations

1. Read this whole file. Read `.planning/handoff-2026-06-02-harness-audit.md` for context on the parallel work.
2. **Status check.** `git log --oneline -10` to see what's on `main` since this handoff was written. `gh run list --limit 5` to confirm earlier CI deploys completed. `aws ecs describe-services --cluster eicr-cluster-production --services eicr-backend --region eu-west-2 --query "services[*].deployments[0].rolloutState" --output text` — must be `COMPLETED` before any harness probe.
3. **Sanity smoke** with one existing scenario to confirm prod is healthy: `./scripts/voice-latency-bench/run-harness-against-prod.sh` against `tests/fixtures/voice-latency-scenarios/scripts/rcbo_bs_via_sonnet_write.yaml` — should PASS.
4. **Fix A — Speculator vs broadcast race.**
   - Read `src/extraction/loaded-barrel-speculator.js` end-to-end. ~30 min.
   - Read `src/extraction/sonnet-stream.js handleTranscript` (~line 3700-3900). ~15 min.
   - Implement per the recommended approach. ~30 min.
   - Write the two unit tests. ~30 min.
   - Run `npm test -- --testPathPattern="loaded-barrel|sonnet-stream"`. Must be green.
   - Write the harness scenario. Run it against prod (will FAIL until deploy lands).
   - One commit. Push. Watch CI.
5. **Fix B — Off-enum value validation gap.** (Smaller, fewer surfaces.)
   - Read `src/extraction/stage6-dispatch-validation.js` + `stage6-tool-schemas.js:120-146` (existing enum extraction).
   - Implement per the proposal. ~30 min.
   - Write unit tests. ~30 min.
   - Run targeted tests + full backend tests.
   - Write the harness scenario. Run against prod.
   - One commit. Push. Watch CI.
6. **Fix C2 — Probe pass FIRST.** Do not implement until you've run the 3 probe transcripts × 10 each (30 runs, ~$2 cost) and have the empirical data.
   - Make probe decision per the decision tree.
   - Implement the chosen approach.
   - Write tests.
   - Write the 3 harness scenarios. Run each 10× to establish post-fix hit rate.
   - Document hit rates in scenario descriptions.
   - One commit (or two if prompt + scenarios are clearly separable). Push. Watch CI.
7. **Final verification.** Run the full 87-scenario suite against prod after all fixes deploy. Should be 87/87 + the 5 new scenarios from this session = 92/92.
8. **Push, surface.** Final summary to Derek with: which fixes deployed, hit rates on each, link to CloudWatch session for the probe pass, list of follow-up items (anything you found but didn't fix).

## Useful commands

```bash
# Mint a harness JWT against prod
JWT_SECRET=$(aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 \
  --query SecretString --output text | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['JWT_SECRET'])")
TOKEN=$(curl -sf -X POST https://api.certmate.uk/api/test/harness-mint-jwt \
  -H "Content-Type: application/json" -H "X-Bench-Secret: $JWT_SECRET" \
  -d '{"email":"derek@beckleyelectrical.co.uk"}' | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")

# Run one scenario
node scripts/voice-latency-bench/transcript-replay.mjs \
  --base-url=https://api.certmate.uk --token="$TOKEN" \
  --scenario=<path> --verbose

# Run a scenario 10× for hit-rate measurement
for i in $(seq 1 10); do
  node scripts/voice-latency-bench/transcript-replay.mjs \
    --base-url=https://api.certmate.uk --token="$TOKEN" \
    --scenario=<path> 2>&1 | tail -1
done | sort | uniq -c

# Pull session debug log
aws s3 cp s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/<SESSION>/debug_log.jsonl /tmp/ --region eu-west-2

# Tail CloudWatch for a session
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 1h 2>&1 | grep "<SESSION>"

# Full backend test run
npm test  # 2368 tests, 98 suites, ~8s

# Watch CI deploy
gh run watch <run-id> --exit-status

# ECS rollout status
aws ecs describe-services --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2 --query "services[*].deployments[0].rolloutState" --output text
```

## Architectural notes the next session should know

### `detectBroadcastIntent` is the universal broadcast signal
Used by `dialogue-engine/engine.js processDialogueTurn` to bail script entry on broadcast. Used by `dialogue-engine/engine.js tryEnterScriptFromWrites` to bail recovery hook on multi-circuit writes. Fix A wires it into the speculator. The same function is canonical truth for "this turn is a broadcast intent."

If a future bug surfaces a NEW broadcast phrasing the regex doesn't catch (e.g. "for circuits 2, 4, and 7"), widen the regex in `parsers/circuit-range.js` and ALL three call sites benefit.

### Speculator's purpose is latency
The Loaded Barrel speculator exists to ship TTS bytes to iOS BEFORE the bundler completes. In Derek's session, the speculator's `mid_stream_emit` fired ~535 ms before the bundler's. On a typical turn that's 50% latency reduction. Fix A's design preserves this for the single-circuit case while eliminating the race on broadcasts. Any alternative that adds latency to single-circuit confirmations defeats the speculator's reason for existing.

### Enum enforcement isn't just rcd_type
`config/field_schema.json` has ~15 circuit fields with `type: "select"`. Fix B's enum loading should cover all of them automatically. Spot-check post-fix: `ocpd_type` (B/C/D), `polarity` (Y/N/OK), `wiring_type` (A-H + O), `ref_method` (similar), `afdd_button_confirmed` (Y/N), `rcd_button_confirmed` (Y/N). Plus the `_supply` parallels in `board_fields`.

### iOS doesn't validate the wire value
Per session E87F58C1's iOS log, `voice_command_apply_field` happily wrote `value: 'AND'` into the rcd_type slot. iOS trusts the wire. The backend dispatcher is the right gatekeeper.

### Anthropic prompt cache is fragile
Any change to the system prompt or per-turn system message breaks the 5-minute cache. Cost-per-turn jumps 10-20× on a cache miss. If you ship Fix C2 Approach 2, verify cache hit rate stays high — `voice_latency.startup_log` logs `usage_cache_read` per turn. A drop from 5-figure cache reads to 0 means you broke it.

### Test discipline reminder
2026-06-01 lesson: a 50-80% flake rate on a multi-circuit scenario is INFORMATION, not noise. The scenarios I deleted as "noise" were exactly the ones that would have caught Derek's 2026-06-02 bugs. `KNOWN_FLAKY.md` (created by the audit handoff) is the discipline that prevents repeats. Every scenario you write with <100% expected hit rate goes in that file with a one-line note on what bug class the flake catches.

## Expected deliverable

- 3-5 commits on `origin/main`:
  - Fix A backend + tests + harness scenario (1-2 commits)
  - Fix B backend + tests + harness scenario (1-2 commits)
  - Fix C2 probe-driven implementation + tests + 3 harness scenarios (1 commit per approach)
- Final session summary to Derek with:
  - Which fixes deployed (link to commit SHAs + CI runs)
  - Hit rates for Fix C2 probes (pre + post)
  - The post-fix harness suite count (should be 92+/92+)
  - Any follow-up items surfaced during the work
