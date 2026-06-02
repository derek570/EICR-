# Handoff — Harness audit for bug-class gaps (2026-06-02)

**Read this entire file before starting. It is self-contained — you don't need conversation history.**

You are doing an AUDIT of the voice-extraction regression harness. The goal is to find OTHER classes of bugs that could slip through to production the way three real bugs did on 2026-06-02. You are NOT fixing those three bugs (separate handoff covers that) and you are NOT modifying `src/extraction/**` unless explicitly authorized later. Your output is a structured findings document plus new harness scenarios that close the gaps.

## Why this audit exists

Derek did a TestFlight smoke test on 2026-06-02 against prod (session `E87F58C1-D2A4-404B-8846-C75CCE98E3F1`). Three discrete bugs surfaced in 90 seconds:

1. **TTS overlap.** Inspector said "Live to earth IR on circuits 2 and 3 is >299 MΩ". The Loaded Barrel speculator pre-synthesised "Circuit 2, IR L to E >299" and shipped it to iOS. ~388 ms later the bundler's broadcast detector noticed the second `record_reading` for circuit 3 and emitted the grouped "Circuits 2, 3, IR L to E >299". Both TTS payloads played on top of each other. Backend log proof: `loaded_barrel_fired` at 09:35:26.132 → `loaded_barrel_broadcast_detected` at 09:35:26.520 → `mid_stream_emit` already sent.

2. **Off-enum value persisted to cert.** Inspector said "RCD type for circuits 2 and 3 is a". Sonnet emitted `record_reading(rcd_type="AND", circuit=2)`. The string `"AND"` is not in the rcd_type enum (valid: `AC, A, F, B, S, N/A` per `config/field_schema.json:circuit_fields.rcd_type.options`). `validateRecordReading` in `src/extraction/stage6-dispatch-validation.js:73-88` only checks circuit existence + confidence range — there is NO field-value enum guard. iOS accepted the value and persisted it.

3. **Sonnet under-fanning.** Same RCD utterance: Sonnet wrote to circuit 2 only, ignored circuit 3 despite explicit "circuits 2 and 3" phrasing. This was the same Sonnet-behaviour pattern that caused multi-circuit batch matrix scenarios to flake during the 2026-06-01 harness rollout.

**The audit question:** what OTHER bug classes have the same structural property — i.e. could occur in production, would not be caught by the current 87-scenario suite?

Three categories already-known-incomplete that you should NOT spend time on (they have separate fixes/scenarios queued — search `.planning/handoff-2026-06-02-fixes.md` or `git log --oneline -20` for any new commits since this handoff was written):
- Postcode lookup wiring in live mode (commit 1fae7def, deployed 2026-06-02).
- RCD vs RCBO schema-order ambiguity in `tryEnterScriptFromWrites` (commit 0632d352, deployed 2026-06-02).
- The three specific bugs from session E87F58C1 above — Derek wants those fixed in a separate workstream.

Your output is gap COVERAGE for other classes, not patches.

## Repos and working directories

- **Backend:** `/Users/derekbeckley/Developer/EICR_Automation`
- **iOS (CertMate):** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` — own `.git`
- **Harness:** `scripts/voice-latency-bench/transcript-replay.mjs` (WS-based, hits prod via `run-harness-against-prod.sh`)
- **Scenarios:** `tests/fixtures/voice-latency-scenarios/` — 87 currently passing across `baseline/`, `scripts/`, `bulk/`, `confirmation/`, `address/`, `loaded_barrel/`, `exhaustive/`
- **Predicates:** documented in `tests/fixtures/voice-latency-scenarios/SCHEMA.md`

## Authoring rules (recap — see SCHEMA.md for full table)

- Circuit-level field names in `has_reading`: LEGACY (post `validateAndCorrectFields` rewrite) — `zs`, `insulation_resistance_l_l`, `polarity`, etc.
- Board-level field names (`circuit: 0`): also LEGACY — `ze`, `pfc`. NOT `earth_loop_impedance_ze` (Codex round 5 caught this — see `git log` for commit `60d7cea6`).
- Dialogue-engine reply turns emit via `buildExtractionPayload` (`wire-emit.js:163`) which carries the schema slot's `field` verbatim (canonical for IR/RCBO, legacy for RCD since the schema uses legacy form directly).
- Use `has_no_reading` for negative-control assertions ("X must not be written on circuit Y"). It's load-bearing — `has_reading` flattens across all envelopes so it can't catch overwrites or accidental fan-out.
- Use `forbid_event_tokens: [extraction:speculator]` when speculator firing is the regression to catch. **Do NOT delete this assertion without verifying the speculator's behaviour matches what the user actually wants** — Derek's 2026-06-02 TTS overlap bug exists because we deleted exactly this assertion in a bulk fix.

## Methodology

Run each category below in order. For each, produce a section in your findings document with:
- The bug class
- The structural property (why it could escape today's coverage)
- New harness scenario(s) you wrote
- Whether you found existing scenarios that should be strengthened
- Any backend fix candidates (flag for Derek; do NOT apply)

### Category 1 — Off-enum value writes

The "AND" bug. `validateRecordReading` doesn't check value-enum. Find every circuit field with a closed enum that Sonnet could plausibly hallucinate an off-enum value for.

1. Read `config/field_schema.json:circuit_fields`. Enumerate fields with a `type: "select"` and an `options` array. List them with their valid values.
2. For each enum field, audit `tests/fixtures/voice-latency-scenarios/` for scenarios that test off-enum Sonnet writes. Most likely answer: zero.
3. Write probe scenarios for the highest-risk fields. Suggested transcript shapes that have been known to fool Sonnet:
   - `"RCD type for circuit 3 is a"` (the original bug — "a" → "AND")
   - `"OCPD type for circuit 3 is c curve"` (could yield "C CURVE" or just "C")
   - `"Polarity for circuit 3 is correct"` (could yield "CORRECT" rather than "Y")
   - `"AFDD button confirmed"` (could yield "Y" or "TRUE" or "CONFIRMED")
4. For each probe, run against prod via `./scripts/voice-latency-bench/run-harness-against-prod.sh` and report what Sonnet actually writes. If off-enum, the scenario should assert via `has_no_reading` with `value: "<off-enum>"`.

Also worth: read `config/field_schema.json:board_fields` and `supply_characteristics_fields` for the equivalent enums (earthing_arrangement, supply_polarity_confirmed, etc.) and audit `record_board_reading` paths.

### Category 2 — Per-turn-write race conditions

The speculator race. Loaded Barrel fires per-`record_reading` and only learns about broadcasts when the second call arrives. Find other places where eager processing of streamed tool calls could ship the wrong data.

1. Read `src/extraction/loaded-barrel-speculator.js` end to end. List every emit path (the WS sends to iOS).
2. For each emit path, identify what state would change a streaming `record_reading` from "ship now" to "wait/suppress". Examples:
   - Multiple `record_reading` for the same (field, value) → broadcast (current behaviour: suppress AFTER second; before fix: race).
   - Multiple `record_reading` for different fields on same circuit → bundler will produce one combined confirmation; speculator's per-field emits could overlap.
   - `record_reading` for a field that's same-turn-corrected by `clear_reading` → speculator might pre-synthesise then be invalidated.
3. Look at `src/extraction/stage6-event-bundler.js` for the canonical "wait for the whole turn to complete" logic. Identify what assumptions it makes that the speculator doesn't replicate.
4. Write scenarios that exercise each race. Use `event_ordering` with the `extraction:bundler` / `extraction:speculator` compound tokens to assert relative timing, and `tts_fetch_count` to count distinct TTS proxy fetches.

The harness's existing `forbid_event_tokens: [extraction:speculator]` predicate is the right tool for "speculator must NOT fire here." Don't be afraid of it — it's the empirical assertion that caught Derek's bug. Pattern that should hold: any scenario where a single inspector utterance results in multiple `record_reading` calls (broadcasts, multi-field-same-circuit, same-turn corrections) should `forbid` the speculator OR assert exactly ONE speculator+bundler pair with the speculator's text matching the FINAL bundler text.

### Category 3 — Sonnet under-fanning on multi-circuit transcripts

Same bug as #3 in the 2026-06-02 session. Sonnet sees "circuits 2 and 3" and writes to 2 only. Was a major source of flake in the matrix run; flakes got deleted.

1. Read `src/extraction/dialogue-engine/parsers/circuit-range.js` — particularly `detectBroadcastIntent` (`circuit-range.js:158`). It detects three patterns: all-form, range, list.
2. Read `tests/fixtures/voice-latency-scenarios/bulk/circuits_2_and_3_list.yaml` for the seed pattern. Note: this scenario PASSES — Sonnet does sometimes fan out correctly. The bug is non-determinism.
3. Run the bulk scenarios 10× each against prod (loop in a shell) and tally pass/fail per scenario. Sonnet's hit rate on multi-circuit fan-out is the empirical signal.
4. Categorise scenarios by Sonnet hit rate:
   - 100% pass: stable, keep as-is.
   - 60-99% pass: write the scenario with `has_reading` for the FIRST circuit (always written) plus `has_no_reading` for the OTHER circuits with a wrong value — this catches the under-fanning regression class while tolerating Sonnet variance.
   - <60% pass: scenario is sampling Sonnet behaviour, not regression-guarding. Either drop it or convert to a "Sonnet behaviour smoke" test that's marked as expected-flaky.
5. Surface the hit-rate table to Derek as a record of WHERE prompt strengthening or regex-based fan-out forcing would have the biggest payoff.

The harness's existing `has_no_reading` predicate is load-bearing here. Use it.

### Category 4 — Deepgram garble interpretation

Inspector dictation goes through Deepgram. Deepgram has known garble patterns (the rcd.js schema has tolerance regexes for them — see `deferTriggers` in `src/extraction/dialogue-engine/schemas/rcd.js`). Audit whether the harness covers the realistic garbles.

1. Read the existing garble-tolerance regexes:
   - `src/extraction/dialogue-engine/schemas/rcd.js:deferTriggers` — defers garbled "fill it in later"
   - `src/extraction/dialogue-engine/schemas/insulation-resistance.js:triggers` — accepts "installation" as a garble of "insulation"
   - `src/extraction/dialogue-engine/schemas/ring-continuity.js:triggers` — accepts "bring" / "wing" as garbles of "ring"
2. For each tolerance, identify the failure mode if the tolerance regresses. Write a scenario whose transcript uses the garbled form and asserts the correct behaviour fires.
3. Surface garble patterns the codebase does NOT tolerate. Examples from past CloudWatch sessions (`grep "stage6.*field_corrected" /tmp/recent-sessions/*` after pulling some via `aws s3 cp s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/ /tmp/recent-sessions/ --recursive --region eu-west-2 --include "*debug_log.jsonl"`):
   - "RCD type AC" → "RCD type act"
   - "Type B" → "type beat" / "type beep"
   - "BS EN 60898" → "BS EN sixty eight ninety eight"
   - "mega ohms" → "mega home" / "meg hour"
4. New scenarios for each plausible garble; assert the parser handles it OR the engine bails to Sonnet gracefully.

### Category 5 — Dispatcher validation gaps

`validateRecordReading` is incomplete (no enum check). Audit every other validator in `src/extraction/stage6-dispatch-validation.js`:

- `validateRecordReading` (line 73)
- `validateClearReading` (line 96)
- `validateCreateCircuit` (line 106)
- `validateRenameCircuit` (line 124)
- `validateDeleteCircuit`
- `validateCalculateZs`
- `validateCalculateR1PlusR2`
- `validateBoardScope`
- `validateRecordBoardReading` (look in `stage6-dispatchers-board.js`)

For each, list what is checked AND what is NOT checked. Cross-reference with `config/field_schema.json` to find fields with closed enums, numeric ranges, or type constraints that the dispatcher doesn't enforce. Most likely gaps:

- Field-value enum on `record_reading` (the "AND" bug class — confirmed)
- Field-value enum on `record_board_reading` (parallel class — supply fields)
- Numeric range on `record_reading` (e.g. `rcd_operating_current_ma` should probably be 5-1000)
- BS-EN format validation (e.g. `ocpd_bs_en` should match `^BS\s*EN\s*\d{4,5}$`)

For each gap, write a scenario whose transcript triggers an off-spec write and asserts `has_no_reading` for the off-spec value. These scenarios will FAIL until the validator gains the check — that's the regression-guard purpose.

### Category 6 — Schema entry ambiguity (broader pattern)

The RCD→RCBO mis-route (fixed yesterday) is one instance of a broader pattern: `tryEnterScriptFromWrites` matches the first schema whose slot list contains the written field. With the specificity-ranking fix (commit `0632d352`), this is more robust — but there are still edge cases.

1. Read `src/extraction/dialogue-engine/index.js:ALL_DIALOGUE_SCHEMAS`. For each pair of schemas, identify shared slots.
2. For each shared-slot pair, write a scenario where Sonnet writes ONLY the shared field and verify the engine enters the more-specific schema (where the slot is primary, not volunteeredOnly).
3. Also: schemas that pivot via derivation (`{value: '61009', pivot: 'rcbo'}` in rcd.js). These don't fire in `tryEnterScriptFromWrites` (per comment at `engine.js:2308` — pivots aren't followed in the seed loop). Document the resulting "stuck in wrong schema" cases as known limitations + add scenarios.

### Category 7 — iOS-side behaviour the WS harness can't see

The WS harness sees backend output. It does NOT see:
- TTS playback queue management (does iOS interrupt a speaking confirmation when a new one arrives?)
- Field-source attribution (`fieldSources` / `originallyPreExistingKeys` from `aed1d06`)
- Local SwiftUI binding updates
- Camera / capture / observation photo flows

For each, identify what the BACKEND can do to surface a regression signal (e.g. a new `client_diagnostic` event from iOS that the WS captures). Write up a list of "iOS-side gaps the harness CAN'T close" for Derek's awareness. Don't try to test iOS-only behaviour via the harness.

### Category 8 — Cross-cutting: flaky tests that catch real bugs

In the 2026-06-01 matrix run, I deleted 13 scenarios as "Sonnet sampling noise." Several of them would have caught the 2026-06-02 under-fanning bug. The lesson: a 50% pass rate on a multi-circuit fan-out scenario is INFORMATION, not noise.

For any scenario you write that's expected-flaky:
- Mark it with a `description:` note explaining the expected flakiness and what bug class the flake catches.
- Add the scenario name to a known-flaky list in a new file `tests/fixtures/voice-latency-scenarios/KNOWN_FLAKY.md` so future authors don't delete it without realising what it catches.

## Suggested workflow

1. Read all of `tests/fixtures/voice-latency-scenarios/SCHEMA.md`, the 14 seed scenarios, and the 73 matrix scenarios to get the existing coverage in your head. Don't write anything yet.
2. Read `config/field_schema.json` end to end. This is the source of truth for what's a valid value for every field.
3. Read `src/extraction/loaded-barrel-speculator.js` end to end. This is where most of the race bugs live.
4. Read `src/extraction/stage6-dispatch-validation.js` end to end. This is where the enum-validation gap lives.
5. NOW start writing the audit document. Use `.planning/audit-2026-06-02-harness-gaps.md` as the output file. One section per Category 1-8.
6. Write new scenarios PROGRESSIVELY. For each one, run it against prod via `./scripts/voice-latency-bench/run-harness-against-prod.sh --scenario=<path>` and capture the actual prod behaviour. Tighten the assertions based on what you see.
7. At end-of-session, push the audit document + new scenarios. Surface a numbered list of recommended backend fixes for Derek to authorise.

## Mint a token / how to run

```bash
JWT_SECRET=$(aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 \
  --query SecretString --output text | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['JWT_SECRET'])")
TOKEN=$(curl -sf -X POST https://api.certmate.uk/api/test/harness-mint-jwt \
  -H "Content-Type: application/json" -H "X-Bench-Secret: $JWT_SECRET" \
  -d '{"email":"derek@beckleyelectrical.co.uk"}' | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")
node scripts/voice-latency-bench/transcript-replay.mjs \
  --base-url=https://api.certmate.uk --token="$TOKEN" \
  --scenario=tests/fixtures/voice-latency-scenarios/<your-new-scenario>.yaml --verbose
```

To re-run the loop-N-times for flake detection:

```bash
for i in $(seq 1 10); do
  node scripts/voice-latency-bench/transcript-replay.mjs --base-url=https://api.certmate.uk --token="$TOKEN" \
    --scenario=<path> 2>&1 | tail -1
done | sort | uniq -c
```

## Hard rules

- **No `src/extraction/**` edits.** Audit + scenarios only. If you find a backend bug, write it up for Derek. He decides what to fix and authorises the patch.
- **No deletion of "flaky" tests** without documenting in `KNOWN_FLAKY.md` what bug the flake catches. The 2026-06-01 deletions cost us the 2026-06-02 field-test bug.
- **No `git push --force`.** CI fires on every push.
- **Real cost:** each scenario run is ~$0.02-0.05 against prod Sonnet 4.6. A 1000-scenario flake-detection sweep is ~$30. Budget accordingly.

## Expected deliverable

- `.planning/audit-2026-06-02-harness-gaps.md` — your structured findings, ~500-1000 lines.
- 30-80 new scenarios across the 8 categories.
- A numbered list at the bottom of the audit doc with "Backend fixes for Derek to authorise" — proposed validator additions, speculator fixes, prompt changes, etc.

If you finish the audit with budget left, run the existing 87-scenario suite as a regression sanity check.
