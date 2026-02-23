# Sonnet Extraction Pipeline Improvements Design

**Date**: 2026-02-18
**Goal**: Make Sonnet extraction robust enough to work without regex pre-processing, fix critical bugs in orphan/pending readings handling, support multi-field and bulk extraction, improve circuit assignment, and ensure no readings are ever silently dropped.

---

## 1. Current State Assessment

### What Works
- Sonnet prompt is thorough (~3,600 words, cached at $0.30/M tokens)
- Multi-turn conversation preserves full dialogue history
- iOS `applySonnetReadings()` handles ~45 field names with aliases
- Multi-field extraction in single response already works on iOS side
- QuestionGate holds questions during speech, auto-resolves when filled
- Conversation compaction preserves structured summary at ~6000 tokens

### What's Broken

#### Critical Bugs (readings silently lost)
1. **Pending readings buffer never drains**: `askAboutPendingReadings()` creates alerts with `suggestedAction: nil`. When user answers "circuit 5", there's no value to apply — the reading is lost forever.
2. **Orphaned readings for unknown circuits dropped silently**: When Sonnet returns `circuit: 3` but circuit 3 doesn't exist on iOS, the reading is logged as `"orphaned_reading"` and dropped. NOT added to pending buffer.
3. **Global dedup key for disambiguation**: `"circuit_disambiguation_pending_nil"` is used for ALL pending readings. After 2 total asks, all future orphans are silently ignored.
4. **Circuit redirect does nothing with nil suggestedAction**: `resolveWithCircuitMove()` speaks "Moved to circuit N" but applies no data.
5. **Field priority broken**: `applySonnetValue()` overwrites pre-existing (CCU/manual) values despite documented 3-tier priority.
6. **Two dead fields**: `max_disconnection_time` and `circuit_type` are in the Sonnet prompt but have no iOS handler — extracted values vanish silently.

#### Design Gaps
7. **Circuit schedule incomplete**: Only ~10 of ~28 circuit fields shown to Sonnet. It cannot tell what's missing.
8. **Schedule sent once**: After first transcript, Sonnet doesn't see field changes unless iOS sends `job_state_update`.
9. **No bulk operations**: "All circuits are wiring type A" has no mechanism.
10. **No active circuit carry-forward**: Every utterance must name its circuit or reading gets circuit: -1.
11. **Queued transcripts lose regex hints**: Only raw text survives the pending queue.
12. **Common electrician shorthands not in prompt**: "lives 200 earths 200", "lim on the loop", etc.
13. **`wiring_type` ambiguity**: Conflates cable construction ("Twin & Earth") with single-letter codes ("A").

---

## 2. Design: Prompt Improvements

### 2.1 Remove Dead Fields
Remove from CIRCUIT FIELDS list:
- `max_disconnection_time` — electricians don't dictate this; it's looked up from tables
- `circuit_type` — already derived from description matching in the schedule; no iOS handler

This saves Sonnet attention and ~40 words of prompt.

### 2.2 Clarify Ambiguous Fields
**`wiring_type`**: Change description from "cable type (e.g., 'Twin & Earth', 'SWA', 'MICC')" to:
```
wiring_type: cable/wiring type (e.g., "Twin & Earth", "T&E", "SWA", "MICC", "FP200", "Flex", "Armoured").
NOT the reference method letter — that is ref_method.
```

**`ref_method`**: Clarify:
```
ref_method: BS7671 installation reference method code (e.g., "A", "B", "C", "100", "101", "102", "103").
NOT the cable/wiring type — that is wiring_type. "Method C" or "ref method C" = ref_method.
```

**`r2` vs `ring_continuity_r2`**: Add explicit disambiguation:
```
r2: standalone R2 earth continuity reading in ohms (radial circuits).
For RING circuits, use ring_continuity_r2 instead.
ring_continuity_r2: ring circuit end-to-end R2/CPC resistance in ohms.
Only for ring/socket circuits. "Earths" on a ring = this field.
```

### 2.3 Add Common Electrician Speech Patterns
Add to the Deepgram-specific guidance section:
```
COMMON SPEECH PATTERNS:
- "lives 200 earths 200" = insulation_resistance_l_l: ">200" AND insulation_resistance_l_e: ">200" (TWO readings)
- "IR 200 both ways" / "insulation 200 200" = both IR fields >200
- "lim on the loop" / "lim on continuity" = r1_plus_r2: "LIM" or zs: "LIM" (use context)
- "that's good" / "that's fine" / "pass" after a test = IGNORE, not a value
- "all good on polarity" = polarity: "correct"
- "type B 32" = TWO readings: ocpd_type: "B" AND ocpd_rating: 32
- "2.5 and 1.5" for cable = cable_size: "2.5" AND cable_size_earth: "1.5"
- "5 points" / "6 points on this" = number_of_points
- Numbers alone after a field name: "Zs... 0.35" = zs: 0.35 (field from recent context OK within same utterance)
```

### 2.4 Add Multi-Field Extraction Guidance
Add explicit instruction:
```
MULTI-FIELD EXTRACTION:
- Extract ALL values from a single utterance. If the user says "Zs 0.35, insulation 200,
  R1 plus R2 0.47", return THREE extracted_readings in one response.
- Each reading gets its own circuit assignment. If the utterance says "circuit 3" once,
  all readings in that utterance are for circuit 3.
- Common multi-field patterns: "type B 32" (2 fields), "2.5 and 1.5 cable" (2 fields),
  "lives and earths both 200" (2 fields), a string of test readings for one circuit.
```

### 2.5 Add Bulk Operation Support
Add instruction:
```
BULK OPERATIONS:
- "All circuits are [value]" / "every circuit [field] is [value]" / "same for all":
  Return one extracted_reading PER circuit in the schedule with the same field and value.
  Use each circuit's actual number. Example: if schedule has circuits 1-6 and user says
  "all circuits wiring type twin and earth", return 6 readings.
- "Circuits 1 through 4 are [value]": Return readings for circuits 1, 2, 3, 4 only.
- "Same as circuit 3" / "copy from circuit 3": Copy ALL filled fields from circuit 3
  to the target circuit. Return individual readings for each copied field.
```

### 2.6 Remove `context_update` from Output Schema
The `context_update.active_circuit` field is returned by Sonnet but never used on iOS. Remove it from the output schema to save tokens:
```json
// REMOVE this from the JSON schema:
// "context_update": { "active_circuit": int|null, "active_test_type": str|null }
```

---

## 3. Design: Circuit Schedule Completeness

### 3.1 Include All Circuit Fields
Expand `buildCircuitSchedule()` to include every field that has a value:

```
Circuit 1: Kitchen Ring Final [Ring, ocpd=B/32A, cable=2.5/1.5mm, zs=0.35,
  r1r2=0.47, ringR1=0.15, ringRn=0.16, ringR2=0.18, irLE=>200, irLL=>200,
  polarity=OK, rcd=28ms/30mA, points=6, wiring=T&E, ref=C]
```

New fields to add to schedule builder:
- `insulation_resistance_l_l` (irLL)
- `r2` (r2Ohm)
- `rcd_trip_time` + `rcd_rating_a` (combined as `rcd=28ms/30mA`)
- `polarity` (polarityConfirmed)
- `number_of_points`
- `wiring_type`
- `ref_method`
- `cable_size_earth` (cpcCsaMm2)
- `rcd_button_confirmed` / `afdd_button_confirmed`

Also expand supply fields:
- `main_earth_conductor_csa`
- `main_bonding_conductor_csa`
- `bonding_water` / `bonding_gas`
- `earth_electrode_type` / `earth_electrode_resistance`
- `zs_at_db`
- `supply_polarity_confirmed`

### 3.2 Schedule Resend Strategy
The fields on the form never change — the EICR form is always the same. The schedule only needs to be sent once at session start (already happens) and after `job_state_update` (already happens). No periodic resend needed.

However, after compaction the schedule should be resent (already happens via `circuitScheduleIncluded` reset at line 465). No changes needed here beyond expanding the schedule content in 3.1.

---

## 4. Design: Circuit Assignment Improvements

### 4.1 Limited Carry-Forward (Within-Utterance Only)
The current "no active circuit" rule is too strict. Proposal: **within a single utterance, a circuit reference applies to all readings**.

This is already partially in the prompt but needs reinforcement:
```
CIRCUIT REFERENCE SCOPE:
- A circuit reference in an utterance applies to ALL readings in that SAME utterance.
- "Circuit 3, Zs 0.35, insulation 200, R1+R2 0.47" → all three readings are circuit 3.
- Between utterances: NO carry-forward. Each new utterance needs its own circuit reference.
- If the user says readings without any circuit reference → circuit: -1 + ask which circuit.
```

### 4.2 Smarter Circuit Matching (by number OR name)
Circuits should be identifiable by their number OR their description name. The user may say "circuit 3" or "upstairs lights" interchangeably.

Enhance the prompt's circuit matching guidance:
```
CIRCUIT MATCHING:
- Match by number: "circuit 3" / "number 3" / "three" → circuit 3
- Match by name/description: "upstairs lights" / "the cooker" / "kitchen sockets" → match
  against circuit descriptions in the schedule. "reading for upstairs lights is 0.76" → match
  "upstairs lights" to the circuit named "Upstairs Lighting".
- Partial matches: "the ring" → if only one ring circuit exists, use it. If multiple, ask.
- Match by recent context: "same circuit" / "and also" / "that one" → circuit: -1 + ask
- NEVER guess. If unsure, use circuit: -1 and ask. Accuracy over speed.
```

---

## 5. Design: Orphan Detection & Question Handling Fixes

### 5.1 Fix Pending Readings Buffer (CRITICAL BUG)
**Problem**: `askAboutPendingReadings()` creates alerts with `suggestedAction: nil`, so user's circuit answer loses the value.

**Fix**: Store the actual readings in the alert so they can be applied when answered:

```swift
// In askAboutPendingReadings():
let pendingValues = pendingReadings.map { "\($0.field)=\(String(describing: $0.value))" }.joined(separator: ", ")
let alert = AlertItem(
    type: .question,
    message: "Which circuit were those readings for? (\(pendingValues))",
    field: nil,  // multiple fields
    suggestedAction: nil,
    metadata: ["pendingReadings": pendingReadings]  // Store actual readings
)
```

Then in the circuit answer handler:
```swift
// When user says "circuit 5":
if let readings = alert.metadata?["pendingReadings"] as? [ExtractedReading] {
    let reassigned = readings.map { reading in
        ExtractedReading(circuit: answeredCircuit, field: reading.field,
                        value: reading.value, unit: reading.unit, confidence: reading.confidence)
    }
    applySonnetReadings(reassigned)
}
```

### 5.2 Fix Orphaned Readings for Unknown Circuits
**Problem**: Readings for circuit numbers that don't exist on iOS are dropped silently.

**Fix**: Auto-create the circuit (this already happens at line 1267-1275 for some paths) OR add orphaned readings to the pending buffer:

```swift
// In applySonnetReadings(), when circuitIdx is nil and circuit > 0:
// Instead of just logging "orphaned_reading" and continuing:
pendingReadings.append(reading)
debugLogger.debug(category: .sonnet, event: "orphaned_to_pending",
    data: ["field": field, "value": value, "circuit": reading.circuit])
```

### 5.3 Fix Dedup Key for Disambiguation
**Problem**: Single key `"circuit_disambiguation_pending_nil"` caps all disambiguation at 2 asks total.

**Fix**: Use per-reading keys:
```swift
// In askAboutPendingReadings():
let dedupKey = "circuit_disambiguation_\(reading.field)_\(String(describing: reading.value))"
```

### 5.4 Ensure `heard_value` Always Populated
**Backend prompt addition**:
```
When asking which circuit a reading belongs to, ALWAYS include heard_value with the actual
value you heard. Example: { "question": "Which circuit is that 0.35 ohms for?",
"field": "zs", "circuit": -1, "heard_value": "0.35", "type": "orphaned" }
```

### 5.5 Fix Circuit Redirect for Nil Values
In `AlertManager.resolveWithCircuitMove()`, if `suggestedAction` is nil but the pending reading has a value, use the stored value:
```swift
let valueToApply = alert.suggestedAction ?? alert.metadata?["heardValue"] as? String
guard let value = valueToApply, !value.isEmpty else {
    // Last resort: look up in pendingReadings buffer
    ...
}
```

---

## 6. Design: Field Priority Fix

### 6.1 Enforce 3-Tier Priority
**Problem**: `applySonnetValue()` overwrites everything including pre-existing values.

**Fix**: Check source before overwriting:
```swift
private func applySonnetValue(key: String, newValue: String, currentValue: String,
                               apply: () -> Void) -> Bool {
    let currentSource = fieldSources[key]

    // Pre-existing (CCU/manual) values are protected — Sonnet cannot overwrite
    if currentSource == .preExisting && !currentValue.isEmpty {
        debugLogger.debug(category: .sonnet, event: "sonnet_blocked_by_preexisting",
            data: ["key": key, "attempted": newValue, "kept": currentValue])
        return false
    }

    // Sonnet overwrites regex and empty fields
    if currentValue.isEmpty || currentSource == .regex || currentSource == .sonnet {
        apply()
        fieldSources[key] = .sonnet
        return true
    }
    return false
}
```

---

### 6.2 Allow Sonnet to Overwrite Circuit Names
Currently `circuit_description`/`designation` only fills if empty (line 1554 in DeepgramRecordingViewModel.swift). Change this to use `applySonnetValue()` so Sonnet can rename circuits when the user says things like "that's the upstairs lights" or "circuit 3 is the cooker". Circuit names from CCU photo analysis are often generic — Sonnet hearing the electrician's description should update them.

---

## 7. Design: Accuracy Safeguards

### 7.1 Never Silently Drop Readings
Add a catch-all at the end of `applySonnetReadings()`:

```swift
// After the switch statement default case:
default:
    // Instead of just logging, buffer as pending for review
    unmappedReadings.append(reading)
    debugLogger.debug(category: .sonnet, event: "unmapped_field_buffered",
        data: ["field": field, "value": value, "circuit": reading.circuit])
```

At session end, report any unmapped readings so they can be investigated.

### 7.2 Validate Field Names at Backend
Before sending extraction results to iOS, validate that all field names in `extracted_readings` match the known field list. Log warnings for unknown fields:

```javascript
const KNOWN_FIELDS = new Set([
    'ze', 'pfc', 'earthing_arrangement', 'main_earth_conductor_csa', ...
    'zs', 'insulation_resistance_l_e', 'insulation_resistance_l_l', ...
]);

for (const reading of result.extracted_readings) {
    if (!KNOWN_FIELDS.has(reading.field)) {
        console.warn(`Unknown field from Sonnet: ${reading.field}`);
        // Attempt fuzzy match / auto-correct common variants
    }
}
```

### 7.3 Unfilled Field Reporting
No session-end summary needed in the app — all debug data (field_sources, debug log, transcripts) is already uploaded to the optimizer via `POST /api/session/:sessionId/analytics`. The optimizer handles analysis of missed/unfilled fields.

---

## 8. Design: Keeping the Prompt Lean

### 8.1 What Gets Cached vs What Doesn't
- **System prompt** (~3,600 words): Cached after first call. Cost is negligible after first turn.
- **User messages**: NOT cached (except latest). These should be lean.

### 8.2 Prompt Size Budget
Current: ~3,600 words (~4,800 tokens)
After changes:
- Remove dead fields (-40 words)
- Add speech patterns (+80 words)
- Add multi-field guidance (+60 words)
- Add bulk operations (+60 words)
- Clarify ambiguous fields (+30 words)
- Remove context_update from schema (-20 words)
- Net: ~3,770 words (~5,000 tokens)

This is still well within the cached system prompt. The increase is ~170 words — minimal impact since it's cached.

### 8.3 User Message Optimization
The user message (per-utterance) is NOT cached and sent every turn. Keep it lean:
- Regex hints: removed (no longer needed without regex)
- Circuit schedule: only every 5 turns (~200 bytes per circuit)
- Already-asked questions: capped at 30 entries (already done)
- Observations: truncated to 60 chars each (already done)

**Estimated user message size**: 50-200 tokens per turn (just the utterance + occasionally the schedule).

---

## 9. Implementation Priority

### Phase 1: Critical Bug Fixes (readings being lost)
1. Fix pending readings buffer drain (store readings in alert metadata)
2. Fix orphaned readings for unknown circuits (add to pending buffer)
3. Fix dedup key (per-field, not global)
4. Fix circuit redirect for nil suggestedAction
5. Fix field priority (enforce pre-existing protection)
6. Add iOS handler for `circuit_type` OR remove from prompt

### Phase 2: Prompt Improvements (better extraction without regex)
7. Remove dead fields from prompt
8. Clarify wiring_type vs ref_method
9. Clarify r2 vs ring_continuity_r2
10. Add common speech patterns
11. Add multi-field extraction guidance
12. Add bulk operation support
13. Remove context_update from output schema
14. Add "always include heard_value" instruction

### Phase 3: Context Improvements (Sonnet knows more)
15. Expand circuit schedule to include all fields
16. Expand supply fields in schedule
17. Backend field name validation
18. Allow Sonnet to overwrite circuit names

### Phase 4: Accuracy & Polish
19. Unmapped field buffering (never silently drop)
20. Queued transcript regex hint preservation (if regex restored)

---

## 10. Files to Modify

| File | Changes |
|------|---------|
| `EICR_App/src/eicr-extraction-session.js` | Prompt updates (fields, speech patterns, multi-field, bulk ops), circuit schedule expansion, schedule resend logic, field name validation |
| `EICR_App/src/sonnet-stream.js` | Schedule resend counter, queued transcript handling |
| `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` | Fix pending readings drain, fix orphaned readings buffer, fix dedup key, fix field priority, add unmapped field buffering, add circuit_type/max_disconnection_time handlers (or confirm removal) |
| `CertMateUnified/Sources/Recording/AlertManager.swift` | Fix circuit redirect for nil values, store pending readings in alert metadata |
| `CertMateUnified/Sources/Services/ClaudeService.swift` | Remove ContextUpdate from RollingExtractionResult (or mark unused) |

---

## 11. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Prompt changes cause regression | Test with real session transcripts from debug logs before deploying |
| Bulk operations create wrong data | Sonnet should confirm before applying bulk: "Setting wiring type T&E for all 6 circuits — correct?" |
| Schedule resend increases token cost | Only every 5 turns, and user message tokens are cheap vs system prompt |
| Pre-existing protection blocks legitimate corrections | Add a "force override" path via explicit correction ("actually the Zs is 0.40") |
| Larger schedule text | Compact format keeps it under 500 bytes for 10 circuits |
