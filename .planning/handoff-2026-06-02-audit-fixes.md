# Handoff — 2026-06-02 audit residual fixes (4 phases, plan-vetted by Codex)

**Read this entire file before starting. It is self-contained — you don't need conversation history.**

You are shipping FOUR backend fixes that close the residual gaps left by the 2026-06-02 audit after Fix B (`a078edf7`) and Fix C2 (`747ab2b6`) shipped earlier the same day. The plan has been adversarially reviewed by Codex across 5 passes; all blockers resolved. Plan source: `/Users/derekbeckley/.claude/plans/quirky-moseying-bentley.md` (mirror below).

A sibling handoff (`.planning/handoff-2026-06-02-fixes.md`) covers the 3 fixes Derek shipped earlier today (Fix A speculator-broadcast race; Fix B value-enum validator + coercion extension; Fix C2 speculator board-coercion routing). Together these handoffs close every actionable item from `.planning/audit-2026-06-02-harness-gaps.md`.

## Repos and working directories

- **Backend (all the work):** `/Users/derekbeckley/Developer/EICR_Automation`
- **iOS (CertMate):** `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified` — own `.git`, **NOT touched** by this session (Fix B/C2 already covered the schema/picker work).
- **Harness:** `scripts/voice-latency-bench/transcript-replay.mjs`
- **Plan source (mirror of body below):** `/Users/derekbeckley/.claude/plans/quirky-moseying-bentley.md`

## Current state — what already shipped today (2026-06-02)

```bash
cd /Users/derekbeckley/Developer/EICR_Automation && git log --oneline -5
```
- `747ab2b6` (16:39 BST) — Fix C2 — speculator board-coercion routing + 5 fixes_2026_06_02/ probes.
- `a078edf7` (16:14 BST) — Fix B — per-field value-enum validator + coercion extensions (button fields, voltage 240→230) + wiring_type prompt rule.
- `15bfdd80` — audit landing (this handoff is the follow-up to that audit).
- `f2ec12a0` — Fix A — speculator-vs-broadcast race suppressed.

Branch: `main` (synced with `origin/main`). Working tree clean.

## Audit findings — status table

| Audit finding | Status |
|---|---|
| #1 — `applyDerivations` mirrors don't reach the wire | **Pending — this handoff, Phase 2** |
| #2 — `validateRecordReading` value-enum check | Shipped (Fix B) |
| #3 — `validateRecordBoardReading` value-enum check | Shipped (Fix B) |
| #4 — Extend coercion to button fields | Shipped (Fix B) |
| #5 — `wiring_type` Sonnet prompt drift | Shipped (Fix B) |
| #6 — `wiring_type` overwrite pattern | Shipped (Fix B) |
| #7 — Canonical field-name leak on dialogue-engine wire emits | **Pending — this handoff, Phase 3** |
| #8 — Canonical+legacy double-emit investigation | **Out of scope** (separate workstream — research-heavy, iOS-side context needed) |
| #9 — Cross-field "Type B" writes both `ocpd_type` + `rcd_type` | **Pending — this handoff, Phase 4** |
| #10 — `circuits_2_and_3_list` 20% under-fanning | **Out of scope** (separate workstream — Sonnet prompt + engine fallback) |
| #11 — Speculator-vs-broadcast race | Shipped (Fix A — commit `f2ec12a0`) |
| #12 — `nominal_voltage_uo="240"` | Shipped (Fix B — coerced to 230) |

**Plus one explicit Fix-B gap** noted at `stage6-dispatch-validation.js:71`:
> "numeric ranges, BS-EN format checks, etc. are NOT constrained here"

That leaves the audit's `dispatcher_gaps/probe_rcd_time_off_spec.yaml` (Sonnet writes `rcd_time_ms="3000"` — implausible per BS 7671) still uncovered. **Pending — this handoff, Phase 1.**

## What this session does

Four commits on a single branch, single CI deploy, single TestFlight cycle. Phases ordered to minimise blast radius and respect dependencies between them.

### Phase 1 — Numeric range validator (audit Fix #5 partial)

**Files:**
- `src/extraction/stage6-dispatch-validation.js` — extend the existing `value_not_in_options` block in `validateRecordReading` with a numeric-range branch.
- `src/extraction/stage6-dispatchers-board.js` — add parallel numeric-range gate inside `dispatchRecordBoardReading` (same shape).
- `src/extraction/value-enum-validator.js` — small new module owning `CIRCUIT_FIELD_NUMERIC_RANGES` + `BOARD_FIELD_NUMERIC_RANGES` Maps. Keyed by **canonical Sonnet field names** (validator runs before `validateAndCorrectFields` rewrites to legacy). Also exposes a small predicate helper.
- `src/__tests__/stage6-dispatch-validation-numeric-range.test.js` — covers each new range entry + sentinel forms.
- `src/__tests__/value-enum-validator.test.js` — smoke tests for the helper.

**What changes:**

1. **Numeric range maps** (`value-enum-validator.js`). All keys are **canonical** schema names:
   - `rcd_time_ms`: `{min: 0, max: 1000}` — 0 ms is acceptable for the "didn't trip" edge case; 1000 ms ceiling covers 5× IΔn S-type test results.
   - `rcd_operating_current_ma`: `{min: 5, max: 1000}` — covers 10/30/100/300/500/1000 enum + non-standard.
   - `ocpd_rating_a`: `{min: 1, max: 630}`.
   - `ocpd_breaking_capacity_ka`: `{min: 1, max: 200}`.
   - `measured_zs_ohm`: `{min: 0, max: 100}` (orders-of-magnitude check, not strict).
   - `ir_test_voltage_v`: `{min: 100, max: 1000}`.

2. **Sentinel-form tolerance + non-numeric rejection** for IR readings. Ranged fields like `rcd_time_ms` / `measured_zs_ohm` are NOT in `CIRCUIT_FIELD_VALUE_ENUMS` (they're free-form text per the schema), so the enum gate won't catch garbage like `rcd_time_ms="three thousand"`. The range gate MUST reject non-numeric for ranged fields:
   ```js
   function isWithinRange(field, value) {
     const range = NUMERIC_RANGES.get(field);
     if (!range) return { ok: true };
     if (typeof value !== 'string') return { ok: false, code: 'invalid_type', field, value };
     if (value === '') return { ok: true }; // blank is clear semantics
     // IR-style sentinel: ">200" / ">999" — strip the prefix before numeric check.
     // Sentinel form only valid on fields whose schema allows it (IR fields).
     const sentinel = /^>\s*(\d+(?:\.\d+)?)$/.exec(value);
     const numeric = sentinel ? Number(sentinel[1]) : Number(value);
     if (!Number.isFinite(numeric)) {
       return { ok: false, code: 'value_out_of_range', field, value, min: range.min, max: range.max };
     }
     if (numeric < range.min || numeric > range.max) {
       return { ok: false, code: 'value_out_of_range', field, value, min: range.min, max: range.max };
     }
     return { ok: true };
   }
   ```
   - Empty string passes (clear semantics belong to `clear_reading`).
   - Sentinel `">200"` parsed numerically by stripping the prefix.
   - Non-numeric values on ranged fields REJECTED with `value_out_of_range` (Sonnet's tool-loop sees one rejection code and retries).

3. **Wire in the validator** (`stage6-dispatch-validation.js`) after the existing `CIRCUIT_FIELD_VALUE_ENUMS` branch (line ~176-188), before `return null`:
   ```js
   const rangeVerdict = isWithinRange(input.field, input.value);
   if (!rangeVerdict.ok) {
     return { code: rangeVerdict.code, field: 'value', value: input.value, min: rangeVerdict.min, max: rangeVerdict.max };
   }
   ```

4. **Parallel wire-in** in `dispatchRecordBoardReading` (stage6-dispatchers-board.js) after Fix B's enum block.

5. **UX feedback for the new rejection code.** Fix B's rejection envelope is `{code: 'value_not_in_options', valid_options: [...]}`. Sonnet receives the error envelope and self-corrects via the tool loop. The new `value_out_of_range` follows the same path (Sonnet retries). No TTS-side change needed.

**Reuses:**
- `CIRCUIT_FIELD_VALUE_ENUMS` (location set by Fix B — verify on edit).
- `coerceRecordReadingValue` ordering (already runs before validator per Fix B's comment at `stage6-dispatchers-circuit.js:122`).

**Tests:**
- `dispatcher_gaps/probe_rcd_time_off_spec.yaml` — Sonnet writes `rcd_time_ms="3000"`. Range check rejects. Probe asserts `has_no_reading: rcd_trip_time value:"3000"` → flips from FAIL to PASS.
- New scenario `dispatcher_gaps/probe_zs_implausible.yaml` (write a `measured_zs_ohm="500"` — implausible — verify rejection).
- 4242 existing tests pass + new tests.

**Risk + mitigation:**
- An unexpected legitimate value lands in the range. **Mitigation:** 24h CloudWatch sanity sweep for `value_out_of_range` rejections; widen the range or remove that field's entry if any look legitimate.
- Numeric-range is opt-in per field — only fields with HIGH confidence of bounds get an entry.

**Acceptance:**
- Both probe scenarios PASS.
- Backend test suite green (~4242 + new tests).
- 87 existing + 5 fixes_2026_06_02 scenarios still pass.

---

### Phase 2 — Mirror wire-emit fix (audit Fix #1)

**Constraint discovered (codified during the plan review):** the dialogue engine has NO `perTurnWrites` reference in scope (0 references in `engine.js`). The engine writes directly to `session.stateSnapshot` via `applyWrite` and emits to iOS via `safeSend(ws, buildExtractionPayload(...))`. There is no shared accumulator to push into.

**Files:**
- `src/extraction/dialogue-engine/helpers/derivations.js` — `applyDerivations` returns `{pivotTo, mirrorWrites, setWrites}` instead of `{pivotTo}`.
- `src/extraction/dialogue-engine/engine.js` — `applyWriteWithDerivations` returns the same shape (passes mirrors through). Each engine caller that builds a `buildExtractionPayload` prepends any returned mirrors/sets to the writes array.
- `src/extraction/stage6-shadow-harness.js` (OR `sonnet-stream.js` — pick the seam) — appends mirror writes returned by `tryEnterScriptFromWrites` to `result.extracted_readings` so they ship in the SAME extraction envelope.
- `src/extraction/dialogue-engine/helpers/wire-emit.js` — `buildExtractionPayload` propagates an optional `auto_resolved: true` flag on each write payload (current mapper at lines 167-173 explicitly enumerates keys; extend to spread `auto_resolved` when present, conditional so back-compat decoders see no change when absent).
- `src/__tests__/dialogue-engine-derivation-mirror-wire-emit.test.js` — new unit tests.

**What changes:**

1. `applyDerivations` builds `mirrorWrites` and `setWrites` arrays as it processes derivation entries, in addition to the existing `applyReadingToSnapshot` calls (snapshot writes stay for forward-compat).

2. Engine call sites that already destructure `{pivotTo}` from `applyDerivations` / `applyWriteWithDerivations` (5+ call sites in engine.js — every `safeSend(ws, buildExtractionPayload(circuitRef, writes, source))` that follows an `applyWriteWithDerivations`) build their writes array as:
   ```js
   const writes = [
     { field: slot.field, value },
     ...mirrorWrites.map(m => ({ ...m, auto_resolved: true })),
     ...setWrites.map(s => ({ ...s, auto_resolved: true })),
   ];
   safeSend(ws, buildExtractionPayload(circuitRef, writes, source));
   ```

3. **Seed-loop ordering fix.** The call site at `engine.js:2370` inside `tryEnterScriptFromWrites` runs inside `stage6-shadow-harness.js` BEFORE the Sonnet `result.extracted_readings` is returned to `sonnet-stream.js` and emitted. A supplemental `safeSend` from inside the seed loop would arrive on the wire BEFORE Sonnet's originating extraction — wrong order from iOS's perspective.

   **Solution:** `tryEnterScriptFromWrites` returns a `mirrorWrites: [{field, circuit, value}]` array (alongside its existing `entered/finished/...` shape). The shadow-harness (or sonnet-stream — the seam after the bundler emits but before WS send) appends mirror writes to `result.extracted_readings` with `auto_resolved: true` and `source: 'rcbo_pivot_mirror'` so they ship in the SAME extraction envelope as the originating Sonnet writes. iOS sees one wire event with both fields.

4. **Return shape compatibility.** Always return `{mirrorWrites: [], setWrites: []}` (never `undefined`) so destructuring is safe at every call site, including callers that don't yet use the mirrors.

5. **TTS confirmation behaviour — verified path.** The dialogue-engine path doesn't go through `synthesiseConfirmations` — script-driven TTS comes from `buildScriptInfo` and the finish/cancel messages, not `confirmation-text.js`. The schema's `finishMessage` reads values from `state.values`, which already includes the mirror after the seed loop. No double-speak. No dedupe needed — this phase only patches the data path.

**Reuses:**
- `applyReadingToSnapshot` — keeps writing to snapshot for forward-compat.
- `buildExtractionPayload`, `safeSend` — existing helpers.
- The schema's `finishMessage` builder.

**Tests:**
- `schema_ambiguity/probe_rcd_bs_en_61009_pivots_to_rcbo.yaml` → PASS (ocpd_bs_en mirror now on wire).
- `schema_ambiguity/probe_ocpd_bs_en_61009_enters_rcbo.yaml` → PASS (rcd_bs_en mirror now on wire).
- New unit tests:
  - `applyDerivations` returns mirror writes on a matching derivation.
  - `applyDerivations` returns empty mirror array on no-match.
  - `tryEnterScriptFromWrites` propagates seed-loop mirrors via its return value (not via a supplemental emit).

**Risk:**
- iOS rendering: an extra `extracted_readings[]` entry appears for every RCBO pivot. iOS column for the mirrored field flashes update — that IS the desired behaviour.

**Acceptance:**
- Both pivot scenarios PASS.
- TestFlight smoke: dictate "RCBO on circuit 2 BS EN 61009" → both BS-EN columns visually update on the same audible confirmation.
- No regression in `script_slot_write_no_speculator.yaml` or other loaded-barrel/script scenarios.

---

### Phase 3 — Canonical name leak fix (audit Fix #7)

**Codex blocker (resolved):** put the field-name correction helper in `field-name-corrections.js` (leaf module), NOT in `sonnet-stream.js` (root of WS handler graph). Both `sonnet-stream.js` and `wire-emit.js` import from the leaf — no circular-import risk.

**Files:**
- `src/extraction/field-name-corrections.js` — add small pure helper `applyFieldNameCorrection(reading, sessionId, logger)` that mutates `reading.field` per `FIELD_CORRECTIONS` lookup. Module already imports nothing else — clean leaf.
- `src/extraction/sonnet-stream.js` — `validateAndCorrectFields` (line 834) refactored to call the helper per reading. `KNOWN_FIELDS` (line 675) stays here (still needed for the warn branch).
- `src/extraction/dialogue-engine/helpers/wire-emit.js` — `buildExtractionPayload` imports the helper and applies it to each emitted reading.
- `src/__tests__/wire-emit-field-name-correction.test.js` — new unit test.

**What changes:**

1. New helper in `field-name-corrections.js`:
   ```js
   export function applyFieldNameCorrection(reading, sessionId, logger) {
     if (!reading?.field) return reading;
     // KNOWN_FIELDS lives in sonnet-stream.js. We DON'T import it here
     // to avoid the circular dep; we rely on FIELD_CORRECTIONS being a
     // strict map — fields not present pass through unchanged.
     const corrected = FIELD_CORRECTIONS[reading.field];
     if (corrected) {
       logger?.info?.('Field corrected', { sessionId, from: reading.field, to: corrected });
       reading.field = corrected;
     }
     return reading;
   }
   ```

2. `validateAndCorrectFields` in sonnet-stream.js refactored to use the helper:
   ```js
   for (const reading of result.extracted_readings) {
     if (!reading.field) continue;
     if (KNOWN_FIELDS.has(reading.field)) continue;
     applyFieldNameCorrection(reading, sessionId, logger);
     if (!FIELD_CORRECTIONS[reading.field] && !KNOWN_FIELDS.has(reading.field)) {
       logger.warn('Unknown field name from Sonnet', { sessionId, field: reading.field, circuit: reading.circuit, value: reading.value });
     }
   }
   ```
   (Wiring_type normalisation block stays — verify at edit time whether Fix B's coercion fully replaces it; remove only if redundant.)

3. `buildExtractionPayload` calls the helper inline on each write:
   ```js
   import { applyFieldNameCorrection } from '../../field-name-corrections.js';
   // ...
   readings: writes.map((w) => {
     const reading = { field: w.field, circuit: circuit_ref, value: w.value, confidence: 1.0, source };
     if (w.auto_resolved) reading.auto_resolved = true;
     applyFieldNameCorrection(reading, /* sessionId */ null, /* logger */ null);
     return reading;
   }),
   ```

4. Result: every `safeSend(ws, buildExtractionPayload(...))` in engine.js (~15 call sites) emits LEGACY field names — same as the bundler path.

**Reuses:**
- `FIELD_CORRECTIONS` (field-name-corrections.js) — module already has the table.

**Tests:**
- `garbles/probe_insulation_garbled_installation.yaml` — update expected field to LEGACY `insulation_resistance_l_l` (currently asserts canonical `ir_live_live_mohm` because rewrite leaks).
- `garbles/probe_ring_garbled_wing.yaml` — update expected field to LEGACY `ring_continuity_r1`.
- New unit test verifies `applyFieldNameCorrection` mutates field name in place.

**Risk:**
- iOS aliasing: iOS may already handle both names from dialogue-engine writes via `applySonnetReadings` switch (per the field-name-corrections.js comment block referencing Bug-H repro). **Verify before edit:** read `DeepgramRecordingViewModel.swift` in CertMateUnified to confirm iOS accepts legacy names for the IR/ring fields. If iOS only handles canonical from this path, defer this phase to a follow-up after iOS catches up.

**Acceptance:**
- Both garbles probes PASS with LEGACY assertions.
- TestFlight smoke: dialogue-engine-driven IR + ring readings land in the correct iOS columns.

---

### Phase 4 — Engine-level scoping for ambiguous "Type B" replies (audit Fix #9)

**Why engine-level, not prompt-only (Codex catch):** the dialogue engine's active-path `extractNamedFieldValues()` runs ALL slot `namedExtractor` regexes and writes every match. For RCBO, the `rcd_type` namedExtractor `/\btype\s*(AC|[AFB]|S)\b|\b(AC)\b/i` matches "Type B" because "B" is in `[AFB]`. The `ocpd_type` namedExtractor also matches "Type B" via `[BCD]`. Both writes land server-side BEFORE Sonnet is consulted. A prompt-only fix would not stop the engine from writing both.

**Files:**
- `src/extraction/dialogue-engine/helpers/extraction.js` — widen `extractNamedFieldValues` to read the first non-null capture group (`m[1] ?? m[2] ?? m[3]`). Backward-compatible: single-group regexes still work (m[2]/m[3] are undefined).
- `src/extraction/dialogue-engine/schemas/rcbo.js` — tighten the `rcd_type` slot's `namedExtractor` to require an RCD-context anchor for the bare-letter forms (A, F, B, S). Anchor the standalone-AC form to "type AC" or one-word-reply patterns.
- `src/extraction/dialogue-engine/schemas/rcd.js` — same tightening on the standalone RCD schema's `rcd_type` slot.
- `config/prompts/sonnet_extraction_system.md` — defence-in-depth bullet for the Sonnet-driven write path.
- `src/__tests__/dialogue-engine-rcbo-type-b-scoping.test.js` — new unit test covering each branch.

**What changes:**

1. **`extraction.js` widen contract** (line 24):
   ```js
   // Before:
   if (m && m[1] !== undefined) {
     const val = slot.parser(m[1]);
   // After:
   if (m) {
     // Take the first non-null capture group. Lets a slot regex use
     // multiple alternations with different value-capture positions
     // without contortions. Backward-compatible: single-group regexes
     // still take m[1].
     const captured = m[1] ?? m[2] ?? m[3];
     if (captured === undefined) continue;
     const val = slot.parser(captured);
   ```
   Existing schemas (ring, IR, OCPD, etc.) all use single-group regexes — `m[1]` is the only non-undefined value — so behaviour stays identical for them.

2. **rcbo.js `rcd_type` slot — tighten namedExtractor.**
   - **Current:** `/\btype\s*(AC|[AFB]|S)\b|\b(AC)\b/i`
   - **New:** `/\b(?:RCD\s+(?:waveform\s+)?type|residual(?:\s+current)?\s+(?:device\s+)?type|waveform\s+type)\s*(AC|[AFB]|S)\b|\btype\s*(AC)\b|^\s*(AC)\s*\.?\s*$/i`

   Three alternations, three capture groups (read via the widened extractor):
   - **Group 1:** bare letter (A/F/B/S/AC) preceded by an RCD/residual/waveform context anchor. Catches "RCD type A", "residual current device type AC", "waveform type B", etc.
   - **Group 2:** "type AC" form. AC is unambiguous (no OCPD value uses AC) so we accept it without the RCD anchor.
   - **Group 3:** Standalone "AC" as the whole reply (one-word answer). Full-string anchored so "AC supply" / "AC mains" don't false-match.

   Behaviour trace:
   - `"Type B"` (inside RCBO walkthrough, ocpd_type asked) → none of the three arms match. `rcd_type` no longer written. **Bug fixed.**
   - `"Type AC"` → group 2 captures `"AC"`. Writes `rcd_type="AC"`. ✓
   - `"RCD type A"` → group 1 captures `"A"`. ✓
   - `"AC"` (one-word reply) → group 3 captures `"AC"`. ✓
   - `"AC supply"` → no match (group 3 needs whole-reply, groups 1+2 need the type anchor). No false positive. ✓
   - `"Type AC supply"` → group 2 captures `"AC"`. ✓

3. **rcd.js `rcd_type` slot — same regex.** Apply the same tightening for consistency across schemas.

4. **Prompt bullet** added after the "ONE-SHOT BS-EN DICTATION" bullet (config/prompts/sonnet_extraction_system.md) — defence-in-depth for the Sonnet-driven write path (which doesn't go through the engine's namedExtractor):
   ```
   - INSIDE AN RCBO walkthrough: when the inspector replies with a single
     curve letter (e.g. "Type B", "Type C", "Type D") as the value for the
     asked ocpd_type slot, this fills ocpd_type ONLY. Do NOT also write
     rcd_type from the same reply. ocpd_type (MCB curve) and rcd_type
     (RCD waveform) are semantically distinct. Inspector dictates each
     separately when the engine asks for it. RCD type writes require
     explicit RCD context ("RCD type A", "waveform type AC").
   ```

**Reuses:**
- Existing `namedExtractor` parsing pipeline in engine.js — no engine-layer changes needed beyond the helper widening.
- Existing prompt structure.

**Tests:**
- New unit test for the contract widening: existing single-group schemas (ring r1, IR L-L, ocpd_type, etc.) continue to extract correctly through the widened helper.
- New unit tests:
  - `extractNamedFieldValues("Type B", rcboSchema.slots)` returns `[{field: 'ocpd_type', value: 'B'}]` ONLY — no rcd_type entry.
  - `extractNamedFieldValues("Type AC", rcboSchema.slots)` → group 2 captures `rcd_type="AC"`.
  - `extractNamedFieldValues("RCD type A", rcboSchema.slots)` → `rcd_type="A"`.
  - `extractNamedFieldValues("AC", rcboSchema.slots)` → `rcd_type="AC"` (standalone).
  - `extractNamedFieldValues("AC supply", rcboSchema.slots)` → no rcd_type write (false-positive guard).
- **Pre-edit verification:** grep `tests/fixtures/voice-latency-scenarios/exhaustive/rcd_*` and `exhaustive/rcbo_*` for any "Type B/F/S" entry utterances WITHOUT RCD anchor as legitimate rcd_type writes. If found, the regex needs further widening (per Risk below). Existing fixture `exhaustive/rcd_regex_all-but-one_single.yaml` uses "type AC" entry — the tightened regex still captures via group 2.
- `schema_ambiguity/probe_rcd_bs_en_61009_pivots_to_rcbo.yaml` + `probe_ocpd_bs_en_61009_enters_rcbo.yaml` — after Phase 2 mirror lands, the "Type B" reply fills `ocpd_type` ONLY. Strengthen assertions: `has_no_reading: [{circuit:3, field:rcd_type, value:"B"}]`.
- 87 + 5 fixes_2026_06_02 + 28 audit scenarios → 1× sweep, all PASS.

**Risk + mitigation:**
- Tightening the regex could regress inspector dictation that legitimately uses bare "Type A" / "Type F" in an unambiguous RCD context where the inspector OMITS the "RCD" anchor (e.g. inside an active RCD walkthrough, "Type F" is unambiguously the asked slot). **Mitigation:** the exhaustive/ fixture grep above + 5× sweep on RCD/RCBO scenarios. If any legitimate case fails, add a question-context-aware lookup: when the engine just asked `rcd_type` directly, additionally accept the bare letter from the previous loose regex.
- Schema parsers/tests outside dialogue-engine that hand-roll the rcd_type regex. **Mitigation:** grep `rcd_type.*regex|namedExtractor.*type` across `src/` before editing; align any duplicates.

**Acceptance:**
- All new unit tests pass.
- Pivot scenarios PASS with strengthened negative-control assertions.
- 87-scenario sweep stable; no new flakes on RCBO/RCD families.

---

## Verification

End-to-end after all 4 phases land on `audit-2026-06-02-fixes`:

1. **Backend tests:** `npm test` from `/Users/derekbeckley/Developer/EICR_Automation`. Existing ~4242 + new (~15-20 from Phases 1/2/3/4) → all pass.

2. **Voice-latency harness — full sweep:**
   ```bash
   cd /Users/derekbeckley/Developer/EICR_Automation
   JWT_SECRET=$(aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['JWT_SECRET'])")
   TOKEN=$(curl -sf -X POST https://api.certmate.uk/api/test/harness-mint-jwt -H "Content-Type: application/json" -H "X-Bench-Secret: $JWT_SECRET" -d '{"email":"derek@beckleyelectrical.co.uk"}' | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")
   echo -n "$TOKEN" > /tmp/harness.token
   node scripts/voice-latency-bench/transcript-replay.mjs \
     --base-url=https://api.certmate.uk --token="$TOKEN" \
     --output=/tmp/audit-fix-verify
   ```
   - `dispatcher_gaps/probe_rcd_time_off_spec.yaml` → PASS (was FAIL).
   - `schema_ambiguity/probe_rcd_bs_en_61009_pivots_to_rcbo.yaml` + `probe_ocpd_bs_en_61009_enters_rcbo.yaml` → PASS (were FAIL).
   - `garbles/probe_insulation_garbled_installation.yaml` + `probe_ring_garbled_wing.yaml` → PASS with LEGACY field-name assertions.
   - All other 28 audit scenarios + 5 fixes_2026_06_02 + 87 existing → continue PASSING.

3. **TestFlight smoke** (after CI backend deploy + iOS TestFlight cycle):
   - Dictate "RCBO on circuit 2 BS EN 61009, type B" → both BS-EN columns populate, `ocpd_type=B`, `rcd_type` stays empty. (Phases 2 + 4)
   - Dictate ring continuity / insulation values via the dialogue engine → iOS columns populate cleanly. (Phase 3)
   - Dictate "trip time three thousand milliseconds" → reading rejected; inspector re-dictates. (Phase 1)

4. **CloudWatch sanity** (first 24h post-deploy):
   - Volume of `value_out_of_range` rejections should be very low (< 0.1% of writes).
   - No spike in dialogue-engine `safeSend` error logs.
   - `field_corrected` log lines for canonical → legacy on the dialogue-engine path should be > 0 (proves Phase 3 wired).

## Commit structure

Four commits on branch `audit-2026-06-02-fixes`, one per phase. Each commit body explains WHY (audit finding) + WHY THIS APPROACH (per CLAUDE.md commit rules). After Phase 4 merges to `main`, CI deploys backend (~30 min) and TestFlight cycle follows for iOS validation.

```bash
cd /Users/derekbeckley/Developer/EICR_Automation
git checkout -b audit-2026-06-02-fixes origin/main
# … per-phase edits + commits …
git push -u origin audit-2026-06-02-fixes
gh pr create --title "..." --body "..."
```

## Hard rules

- **No `git push --force`.** CI fires on every push.
- **No edits to `CertMateUnified/`** in this session (Fix B/C2 already covered the iOS-side picker/schema work).
- **No `--no-verify` on commits.** Pre-commit hooks must pass.
- **One concern per commit** (per `EICR_Automation/CLAUDE.md` rules) — don't bundle multiple phases.
- **Out-of-scope items** (audit Fixes #8 + #10) stay out. If you spot something you want to fix that's NOT in this handoff, write a new handoff or escalate to Derek before touching it.

## Plan history (vetted by Codex 4 passes + 1 self-review)

Plan was iteratively refined through 5 review passes; all blockers resolved in-place. Full audit trail at `/Users/derekbeckley/.claude/plans/quirky-moseying-bentley.md` "Review log" section. Headline findings:

- **Pass 1 (self-review):** 14 blockers caught — wrong field-name table location, dialogue-engine has no `perTurnWrites`, wrong phase ordering, etc.
- **Pass 2 (Codex):** 5 blockers + 1 near-blocker — circular import in field-name helper, numeric-range keyed on wrong (legacy) names, empty-string handling, voltage 240 already shipped, rejection-TTS via wrong transport, Phase C dedupe on wrong path.
- **Pass 3 (Codex):** 1 blocker + 2 near-blockers — Phase 4 prompt-only was the wrong layer (engine writes both before Sonnet sees it); Phase 1 missed non-numeric rejection for ranged fields; Phase 2 seed-loop emit had wrong wire ordering.
- **Pass 4 (Codex):** 1 blocker — `extractNamedFieldValues` reads `m[1]` only; my multi-group regex would silently fail. Also bare `\b(AC)\b` false-matches "AC supply".
- **Pass 5 (Codex):** **PLAN APPROVED, NO BLOCKERS.**

Net plan: 4 phases, single CI deploy, single TestFlight cycle. Backend-only. Closes audit Fixes #1, #5 (partial — numeric range), #7, #9.
