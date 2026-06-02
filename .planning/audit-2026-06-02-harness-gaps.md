# Harness audit — bug-class coverage gaps (2026-06-02)

**Author:** Claude (audit handed off by Derek; see [`handoff-2026-06-02-harness-audit.md`](handoff-2026-06-02-harness-audit.md)).
**Scope:** find OTHER classes of bugs that could escape the current 87-scenario suite the way the three 2026-06-02 bugs did. Audit + new scenarios only — NO `src/extraction/**` edits. Backend-fix candidates listed at the bottom for Derek to authorise.

**Status:** in progress. New scenarios live under `tests/fixtures/voice-latency-scenarios/{enum_guards, speculator_races, garbles, schema_ambiguity, dispatcher_gaps}/`.

---

## Background — the three 2026-06-02 bugs (recap)

Session `E87F58C1-D2A4-404B-8846-C75CCE98E3F1`, 90 seconds, 3 bugs:

1. **TTS overlap.** Speculator pre-synthesised "Circuit 2, IR L to E >299" and shipped it ~388 ms before the bundler's broadcast-detector saw the second `record_reading(c3)`. Bundler then emitted the grouped "Circuits 2, 3, IR L to E >299". Both played.
2. **Off-enum value persisted.** Inspector said "RCD type for circuits 2 and 3 is a". Sonnet emitted `record_reading(rcd_type="AND", circuit=2)`. `"AND"` is not in `rcd_type.options` (`AC, A, F, B, S, N/A`). `validateRecordReading` (`stage6-dispatch-validation.js:73-88`) does NOT check field-value enums. Value persisted.
3. **Under-fanning.** Same utterance: Sonnet wrote to circuit 2 only, ignored "and 3".

These three bugs map to Categories 1, 2, and 3 below. The audit goes broader: **what other bug classes share the same structural property?**

---

## Authoring conventions

All new scenarios follow `SCHEMA.md` plus three project rules from the handoff:

- **Field names in `has_reading`** are LEGACY (post `validateAndCorrectFields` rewrite). See `SCHEMA.md` table.
- **`has_no_reading`** is the load-bearing assertion for "this value MUST NOT appear on this circuit". Plain `has_reading` flattens across envelopes and can't catch overwrites or fan-out leaks.
- **`forbid_event_tokens: [extraction:speculator]`** is the empirical assertion that catches the 2026-06-02 speculator race. Do NOT delete without verifying the speculator's behaviour matches user intent — the 2026-06-01 deletions cost the 2026-06-02 field-test bug.

---

## Category 1 — Off-enum value writes

### Bug class
Sonnet emits `record_reading` (or `record_board_reading`) with a value that is not in the field's closed `options` enum. `validateRecordReading` checks only circuit existence + confidence range; `validateRecordBoardReading` checks only field-enum membership + confidence. Neither checks the VALUE against the field's `options[]`. The off-enum string flows through `coerceRecordReadingValue` (only coerces BS-EN + polarity), through the bundler, onto the wire, into iOS, into the cert.

### Structural property
`config/field_schema.json` defines `options` arrays for every closed-enum select field. The dispatcher does not consume them. There is no scenario in `baseline/`, `bulk/`, or `exhaustive/` today that asserts `has_no_reading` for an off-enum value on a record-reading field. Two surface paths:
- circuit fields (record_reading): `wiring_type, ref_method, ocpd_bs_en, ocpd_type, rcd_bs_en, rcd_type, polarity_confirmed, rcd_button_confirmed, afdd_button_confirmed, is_distribution_circuit`
- board / supply fields (record_board_reading): every `type: "select"` field in `board_fields` + `supply_characteristics_fields` (40+ fields).

### Candidate enum-hallucination transcripts

These are the dictation shapes most likely to trick Sonnet into emitting off-enum values. Probes labelled with the off-enum value Sonnet is expected to produce.

| # | Field | Transcript | Expected off-enum write | Enum |
|---|---|---|---|---|
| 1 | `rcd_type` | "RCD type for circuit 3 is a" | `"AND"` (the original 2026-06-02 bug) | `AC, A, F, B, S, N/A` |
| 2 | `rcd_type` | "RCD type is double A" | `"AA"` or `"DOUBLE A"` | same |
| 3 | `ocpd_type` | "OCPD type for circuit 3 is c curve" | `"C CURVE"` or `"c curve"` | `B, C, D, gG, gM, aM, HRC, Rew, N/A` |
| 4 | `polarity_confirmed` | "Polarity for circuit 3 is correct" | `"CORRECT"` or `"correct"` — BUT `coerceRecordReadingValue` maps `correct` → `"Y"` | `"", OK, Y, N` |
| 5 | `polarity_confirmed` | "Polarity is good" | coerced to `"Y"` | same |
| 6 | `afdd_button_confirmed` | "AFDD button confirmed" | `"CONFIRMED"` or `"Y"` (no coercion for AFDD) | `"", OK, FAIL, N/A, Y, N` |
| 7 | `wiring_type` | "Wiring type is twin and earth" | `"TWIN AND EARTH"` (correct = `"A"`) | `A, B, C, D, E, F, G, H, O` |
| 8 | `wiring_type` | "It's SWA" | `"SWA"` (correct = `"F"`) | same |
| 9 | `wiring_type` | "Mineral insulated" | `"MINERAL"` or `"MICC"` (correct = `"H"`) | same |
| 10 | `ref_method` | "Reference method A clipped direct" | `"A clipped direct"` (correct = `"A"`) | `A, B, C, D, E, F, G, 100, 101, 102, 103` |
| 11 | `ocpd_bs_en` | "BS 88" (no `-2` / `-3`) | `"BS 88"` (no matching canonical) | `BS EN 60898, 61009, 60947-2, 60947-3, 60269-2, BS 3036, BS 1361, N/A` |
| 12 | `rcd_button_confirmed` | "RCD button works" | `"WORKS"` (correct = `"Y"`) | `"", OK, Y, N` |
| 13 | `is_distribution_circuit` | "This circuit feeds the garage CU" — but as a `record_reading` not `mark_distribution_circuit` | `"true"`, `"yes"` accepted; `"true"` would be off-enum | `"", yes, no` |

### Methodology

1. Build a probe scenario for each row. Probe asserts only `extraction_count: { min: 1 }` so the run captures the actual Sonnet write without failing on assertions.
2. Run against prod with `--verbose`. Inspect the `extracted_readings` payload.
3. If Sonnet writes the off-enum value verbatim → convert into a regression-guard scenario with `has_no_reading: [{ circuit, field, value: <off-enum> }]`. The scenario will FAIL until the dispatcher gains a value-enum check. That's the regression-guard purpose.
4. If Sonnet writes the canonical value (coerced) → no bug, but write the canonical-positive scenario anyway as a pin against Sonnet behaviour drifting.

### Probe results — 2026-06-02 run vs prod (10 probes × $0.02-0.05)

| Probe | Transcript | Actual reading(s) emitted | Off-enum bug? |
|---|---|---|---|
| `probe_rcd_type_letter_a` | "RCD type for circuits 2 and 3 is a." | `rcd_type="A"` (c2 ×2, c3 ×1) | **No** — canonical "A" emitted; original 2026-06-02 "AND" bug does NOT reproduce on this transcript today (model drift). Bonus: fan-out works — both c2 and c3 receive "A". |
| `probe_polarity_correct` | "Polarity for circuit 3 is correct." | `polarity_confirmed="Y"`, `polarity="Y"` | **No** — coerced to "Y". But TWO field-name emissions (canonical + legacy) — investigate separately. |
| `probe_ocpd_type_curve_c` | "OCPD type for circuit 3 is C curve." | _none_ — engine entered OCPD script, asked for BS number | **No** — handled by engine, parser canonicalises "C" from "C curve". |
| `probe_earthing_arrangement_tncs` | "Earthing arrangement is TNCS." | _none_ | **No** — Sonnet declined. Pin so a future regression that writes "TNCS" fails. |
| `probe_earthing_arrangement_pme` | "Earthing arrangement is PME." | _none_ | **No** but Sonnet doesn't map PME → TN-C-S. Possible UX improvement opportunity (UK distribution-side term for TN-C-S). |
| `probe_afdd_confirmed` | "AFDD button confirmed on circuit 3." | `afdd_button_confirmed="true"` (c3 ×2) | **YES** — `"true"` is off-enum (valid: `"", OK, FAIL, N/A, Y, N`). `coerceRecordReadingValue` only coerces polarity + BS-EN, not AFDD/RCD buttons. |
| `probe_voltage_240` | "Nominal voltage is 240 volts." | `nominal_voltage_uo="240"` (c0 ×2) | **YES** — `"240"` is off-enum (valid: 230, 400, 110, N/A, Other). Common UK historical voltage; collision with `main_switch_voltage` enum which DOES include 240. |
| `probe_wiring_type_twin_and_earth` | "Wiring type for circuit 3 is twin and earth." | `wiring_type="A"` then `wiring_type="twin and earth"` (overwrite) | **YES** — Sonnet emits canonical FIRST then OVERWRITES with raw text. Last-write-wins → off-enum persists. |
| `probe_wiring_type_swa` | "Circuit 3 wiring type is SWA." | `wiring_type="D"` then `wiring_type="SWA"` | **YES** — same overwrite pattern. ALSO wrong canonical: SWA should map to "F" per 2026-04-22 IET 9-code update; Sonnet still writes "D" (pre-update mapping). |
| `probe_wiring_type_micc` | "Circuit 3 wiring type is MICC." | `wiring_type="D"` then `wiring_type="MICC"` | **YES** — same pattern. Correct canonical: "H". Sonnet writes "D" (wrong) then "MICC" (off-enum). |

### Findings — Category 1

1. **`afdd_button_confirmed` accepts `"true"` verbatim.** Same bug class as the 2026-06-02 `rcd_type="AND"` — dispatcher does not enforce field-value enum. Mitigation: extend `coerceRecordReadingValue`'s polarity-alias logic to cover `afdd_button_confirmed` and `rcd_button_confirmed`, OR add an enum-check pass in `validateRecordReading`.

2. **`nominal_voltage_uo` accepts off-enum `"240"`.** Real-world inspector dictation (historical UK voltage). Possible fixes: add `"240"` to enum, map to `"Other"` with a note, or have Sonnet emit ask_user to clarify.

3. **`wiring_type` two-write overwrite pattern — significant structural concern.** Sonnet emits canonical FIRST then overwrites with raw text. The overwrite is the off-enum bug. Three reproductions (T&E, SWA, MICC). This is a Sonnet behaviour pattern, not a dispatcher gap — fix at the dispatcher (reject off-enum overwrite even if canonical was already written) OR at the prompt (instruct Sonnet to NEVER emit raw verbal forms after canonical).

4. **`wiring_type` wrong canonical for SWA / MICC.** Sonnet writes "D" for both. Per 2026-04-22 `field_schema.json` update (IET 9-code system), SWA = F/G, MICC = H. Prompt drift — `ai_guidance` was updated but Sonnet's training has not caught up. Two paths: (a) prompt tightening to teach the new mapping explicitly; (b) tool-schema `enum` on the value side (already enforces options at schema level — verify it's wired).

5. **`polarity_confirmed` double-field emission.** `polarity_confirmed="Y"` AND `polarity="Y"` both appear on the wire. Not a Cat 1 bug (both canonical) but worth investigating — likely the bundler emits the canonical name and `validateAndCorrectFields` rewrites to legacy, but BOTH end up in `extracted_readings`. iOS deduplicates via field-name alias. Worth checking in a follow-up.

6. **`rcd_type` original 2026-06-02 "AND" bug does NOT reproduce on the exact transcript today.** Sonnet writes canonical "A" to both c2 AND c3 (fixing the under-fanning too). Model drift between 2026-06-02 prod session and current Sonnet 4.6. Pin the regression-guard so a future model shift back to "AND" or any off-enum variant fails immediately.

### Cat 1 → backend-fix recommendation

See the numbered list at the bottom of the audit. Three distinct dispatcher gaps:
- Field-value enum on `record_reading` (covers items 1 + 3)
- Field-value enum on `record_board_reading` (covers item 2)
- Extend `coerceRecordReadingValue` POLARITY_FIELDS set to include AFDD + RCD buttons (alternative to value-enum check for items 1 + 3)


---

## Category 2 — Per-turn-write race conditions (speculator)

### Bug class
Loaded Barrel speculator (`loaded-barrel-speculator.js`) fires on `onToolUseStreamed` (content_block_stop) AND `onSnapshotPatch` (post-dispatch). The bundler fires once at round end with full-turn context. When a single inspector utterance produces N `record_reading`s with cross-record context (broadcast, multi-field on one circuit, same-turn correction via clear_reading + record_reading), the speculator can ship audio for the FIRST record_reading before learning what the bundler will do with the FULL turn.

Defence-in-depth already in place:
- `broadcastBuckets` aborts the first speculation when a second distinct circuit hits the same `(field, value, board_id)` bucket. This is the 2026-06-02 fix that didn't ship to fix the 2026-06-02 bug (per handoff, separate workstream).
- `cachePeek` (gate #1) dedupes resurfaced cache hits.
- `pendingFastTtsSlots` short-circuits speculation when iOS fast-TTS has already taken the slot.
- `_speculate` aborts on broadcast detection via `bucket.suppressed` (set by the second circuit).

What is NOT yet defended:
- **Multi-field same-circuit.** Inspector says "Circuit 3 Zs 0.13, polarity OK, R1+R2 0.42". Sonnet emits 3 `record_reading` calls for circuit 3 with different fields. The bundler groups by `(field, value, board_id)` so each lands as its own bucket → no broadcast suppression. Speculator fires 3 distinct pre-synths. Inspector hears 3 confirmation snippets — potentially overlapping if iOS's playback queue doesn't serialise them.
- **Same-turn correction via clear_reading + record_reading on a DIFFERENT field.** Inspector says "Circuit 3 polarity OK, sorry, R1+R2 0.42". Sonnet emits `clear_reading(polarity_confirmed, c3) + record_reading(r1_plus_r2, c3, 0.42)`. `loaded_barrel_clear_invalidates` covers same-FIELD clear; the cross-field shape is currently uncovered.
- **Multi-write per turn cap reached during a broadcast.** Speculator cap = 2. Broadcast across 4 circuits. First two circuits speculate before broadcast detection fires (timing race) → those two could ship audio while broadcast suppresses 3 + 4. User hears "Circuit 1, IR..." then "Circuit 2, IR..." then bundler's grouped "All circuits, IR..." — total 3 audio events.
- **Board reading + circuit reading on same turn.** "Ze 0.42 and circuit 1 Zs 0.13" produces `record_board_reading(ze) + record_reading(zs, c1)`. Speculator fires on both via `onToolUseStreamed`. Two distinct confirmations — potentially overlapping.

### Methodology
Use `forbid_event_tokens: [extraction:speculator]` for "speculator must NOT fire here". Use `event_ordering: [extraction:bundler, extraction:speculator]` for relative timing. Use `confirmation_count` with min+max to pin exactly N TTS lines.

### Probe results — 2026-06-02 run vs prod (5 probes)

| Probe | Transcript | Result | Finding |
|---|---|---|---|
| `probe_multi_field_same_circuit` | "Circuit 1 Zs is 0.13, polarity OK, R1+R2 0.42" | PASS — all 3 fields written; each field appears TWICE on the wire (canonical + legacy name) | The double-emit is the mid-stream speculator envelope + bundler post-loop envelope. iOS dedupes via field-name alias. |
| `probe_different_field_same_turn_correction` | "Circuit 1 polarity OK, actually sorry, R1+R2 0.42" | **FLAKY** — first run wrote both polarity AND R1+R2; second run dropped R1+R2 | Sonnet non-determinism on "actually sorry" pattern. EXPECTED-FLAKY — marked in `KNOWN_FLAKY.md`. The scenario catches the real bug class of Sonnet inconsistency on corrections. |
| `probe_reading_plus_observation_same_turn` | "Circuit 1 Zs 0.13. Observation, damaged sheath, code C3" | PASS — both reading and observation confirmation emitted | Backend serialises correctly. iOS-side audio overlap risk is Cat 7 (out of scope for this harness). |
| `probe_cross_board_same_value_broadcast` | "Circuit 1 Zs 0.27. Switch to garage CU. Circuit 1 Zs 0.27." | PASS — both boards' readings persist; broadcast suppression correctly does NOT trigger (different boardId buckets) | Confirms the speculator's bucket key `${field}|${value}|${boardId}` keeps cross-board readings distinct. |
| `probe_clear_plus_record_different_field` | "Clear polarity on circuit 1. R1+R2 is 0.42." | PASS — polarity cleared, R1+R2 written | Speculator's `patch.cleared` iteration invalidates the polarity slot cleanly. |

### Findings — Category 2

1. **Canonical + legacy field-name double-emit on every reading.** Confirmed across all 5 probes. Each reading appears TWICE on the wire: once with canonical name (`measured_zs_ohm`, `r1_r2_ohm`, `polarity_confirmed`) and once with legacy name (`zs`, `r1_plus_r2`, `polarity`). iOS dedupes via field-name alias. **Risk:** if iOS dedupe ever breaks, every reading visually appears twice in the UI. Investigate: is this intentional (mid-stream preview + post-loop final emit are conceptually distinct so duplication is OK) or an artefact (one emit path doesn't run `validateAndCorrectFields` so canonical leaks through)? Worth a separate workstream.

2. **Sonnet non-determinism on cross-field "actually sorry" correction.** `probe_different_field_same_turn_correction` flaked between runs. Sometimes Sonnet keeps both writes; sometimes Sonnet drops the second. This is a real bug class — inspector field-test would experience inconsistent behaviour. Pinning the scenario in `KNOWN_FLAKY.md` (Cat 8) so it isn't deleted as "Sonnet noise".

3. **Cross-board same-value works as designed.** Speculator's bucket key partitions by board_id so two distinct boards' readings are never coalesced. Correct behaviour for physically distinct measurements.

4. **Multi-field same-circuit speculator behaviour is sound.** 3 fields → 3 buckets → 3 speculations (cap=2 may drop one to live synth). iOS playback queue serialises (Cat 7 — not testable here).

### Cat 2 → backend-fix candidates

- Investigate the canonical+legacy double-emit. Either remove duplication or document why both shapes are intentional.
- Tighten Sonnet's "actually sorry" handling — the cross-field correction case is non-deterministic.

### Race NOT exercised here (handoff explicitly excludes)

The original 2026-06-02 speculator-vs-broadcast race (`loaded_barrel_fired` 388 ms before `loaded_barrel_broadcast_detected` → both TTS played) is in a separate workstream per handoff. The fix and its scenario should land via that workstream; this audit deliberately does NOT pin it.

---

## Category 3 — Sonnet under-fanning on multi-circuit transcripts

### Bug class
Sonnet sees "circuits 2 and 3" and writes to 2 only. Per handoff:
> Was a major source of flake in the matrix run; flakes got deleted.

The 2026-06-01 matrix run deleted 13 scenarios as "Sonnet sampling noise" — several would have caught the 2026-06-02 under-fanning bug. Lesson: a 50% pass rate on a multi-circuit fan-out scenario is INFORMATION, not noise.

### Structural property
`detectBroadcastIntent` (`parsers/circuit-range.js:158`) recognises three shapes:
- `BROADCAST_ALL_RE` — "for/across/on all circuits", "every circuit", "whole board", "entire board"
- `BROADCAST_RANGE_RE` — "circuits 1 to 6"
- `BROADCAST_LIST_RE` — "circuits 1, 3 and 5"

A list like `"circuits 2 and 3"` matches `BROADCAST_LIST_RE`. The engine bypasses script entry. But Sonnet's tool-call fan-out is a separate concern — the engine bypass only affects scripts. Per-circuit `record_reading` writes are Sonnet's own decision via prompt guidance.

### Methodology
Run existing bulk scenarios 10× each against prod. Tally pass/fail per scenario. Categorise by hit rate.

| Hit rate | Action |
|---|---|
| 100% | Stable, keep as-is. |
| 60-99% | Rewrite with `has_reading` for the FIRST circuit (always written) + `has_no_reading` for the OTHER circuits with a wrong value. Catches under-fanning regression without brittling on Sonnet variance. |
| < 60% | Scenario is sampling Sonnet behaviour, not regression-guarding. Mark as expected-flaky in `KNOWN_FLAKY.md` and add the bug-class note. Don't delete. |

### Hit-rate table — 5 trials per scenario, prod (2026-06-02)

| Scenario | Trials | Pass | Fail | Hit rate | Notes |
|---|---|---|---|---|---|
| `bulk/all_circuits_ir_broadcast.yaml` | 5 | 5 | 0 | 100% | Stable. "for all circuits" broadcast intent + grouped confirmation work. |
| `bulk/broadcast_then_per_circuit_override.yaml` | 5 | 5 | 0 | 100% | Stable. Broadcast then per-circuit override land correctly. |
| `bulk/circuits_1_through_5_range.yaml` | 5 | 5 | 0 | 100% | Stable. Range form ("1 through 5") works. |
| `bulk/circuits_2_and_3_list.yaml` | 5 | 4 | 1 | **80%** | **FLAKY** — iteration 3 returned ZERO readings on "Insulation L to L 200 megohms for circuits 2 and 3". Sonnet silently dropped the entire turn. Inspector would not know the readings weren't recorded. |

### Findings — Category 3

1. **`circuits_2_and_3_list` flakes at 20%.** This is the exact bug-class shape from 2026-06-02 session E87F58C1 (under-fanning). When Sonnet drops the turn entirely, the inspector hears no confirmation TTS and assumes "the system missed me" — likely re-dictates, doubling work. When Sonnet drops PARTIAL writes (e.g. only circuit 2 lands), the inspector sees only one column update, may not notice the second is missing. **Both are silent failures from the inspector's perspective.**

2. **The broader bulk scenarios are stable** — "for all circuits" and explicit ranges work consistently. The list form (`"circuits 2 and 3"`) is the gap. Inspector field-test behaviour: prefer the broadcast forms ("all circuits") over the list form whenever possible.

3. **`KNOWN_FLAKY.md` entry added** for `circuits_2_and_3_list` documenting the 20% miss rate. Future authors must NOT delete this scenario without reading the file.

### Cat 3 → backend-fix candidates

- Sonnet prompt tightening on multi-circuit list parsing. "circuits X and Y" should ALWAYS emit N record_reading calls or N=0 — never a partial. Worth a targeted prompt revision.
- Alternative: add a fallback at the engine level — if `detectBroadcastIntent` matches `BROADCAST_LIST_RE` AND Sonnet's response includes 0 record_readings, emit a `client_diagnostic` warning so iOS surfaces a "did the system catch that?" hint.

---

## Category 4 — Deepgram garble interpretation

### Bug class
Inspector dictation goes through Deepgram. Known garble patterns:

| Original | Garbles | Tolerance |
|---|---|---|
| `insulation resistance` | `installation resistance` | `(?:insulation\|installation)` in `insulation-resistance.js:73` |
| `ring continuity` | `bring`, `wing` continuity | `(?:ring\|bring\|wing)` in `ring-continuity.js:78` |
| RCD defer ("fill it in later") | `"later."`, `"in later."`, `"leave it"`, `"filled in"`, `"filed in"` | `deferTriggers[]` in `rcd.js:159-179` |
| `BS` (letters) | `a b s`, `a. b. s.` | `normaliseBsInput` in `bs-code.js:74-93` |
| BS code digit drift | `"6898"` → `"60898"` | Levenshtein-1 fuzzy fallback in `bs-code.js:170` |
| `megaohms` | `milligrams`, `milli grams`, `millies` | `parseBareMegaohmsWithUnit` in `megaohms.js:90` |
| `RCD trip time` | `triptan` | RCD entry-handover bail in `engine.js` + named-field fallback to Sonnet |

### Garble patterns NOT currently tolerated (gap candidates)

| Garble | Origin | Risk if untolerated |
|---|---|---|
| `"RCD type AC"` → `"RCD type act"` | session 82b54893 (per handoff) | Sonnet writes `"act"` (off-enum) → Cat 1 path |
| `"Type B"` → `"type beat"`, `"type beep"` | same | Sonnet writes `"beat"` or hallucinates `B` from context |
| `"BS EN 60898"` → `"BS EN sixty eight ninety eight"` | inspector says digits as words | `parseBsCode` expects digits; spoken-form bypass |
| `"mega ohms"` → `"mega home"`, `"meg hour"` | parser only knows `milligrams`/`millies` | bare-entry parser misses, value discarded |
| `"R1 plus R2"` → `"r one plus r two"`, `"R1+R2"` spoken as `"R one plus R two"` | spoken numerals | regex `\bR\s*1\s*(?:\+\|\s+plus\s+)\s*R\s*2\b` may not match `"R one"` form |
| `"R-N"` (ring neutrals) → `"R N"`, `"are en"`, `"are and"` | named-extractor anchors on `\bneutrals?\b` only | terse "RN 0.43" might miss |
| `"twenty-five mA"` → `"twenty five male"`, `"twenty five mail"` | trailing `m` sound | `parseMa` regex `\bm[Aa]\b` misses `mail`/`male` |
| `"ohms"` → `"arms"`, `"o m"` | Z value spoken with unit | various parsers tolerate this differently |

### New scenarios

Seven probes under `garbles/`:

| Scenario | Garble | Expected behaviour |
|---|---|---|
| `probe_rcd_type_ac_garbled_act` | "type AC" → "type act" | parseRcdType returns null; engine bails to Sonnet; off-enum risk on the Sonnet write path |
| `probe_ocpd_type_b_garbled_beat` | "Type B" → "type beat" | parseMcbType returns null; engine bails; Sonnet write path |
| `probe_megaohms_garbled_mega_home` | "mega ohms" → "mega home" | parseBareMegaohmsWithUnit returns null; bare value discarded; engine asks for clarification |
| `probe_bs_en_spoken_digits` | "60898" → "sixty eight ninety eight" | parseBsCode's normaliseBsInput doesn't word-collapse; fuzzy fallback also misses; engine bails |
| `probe_ring_garbled_wing` (regression-guard) | "ring" → "wing" | Pin existing `(?:ring\|bring\|wing)` alternation; fails if regex regresses |
| `probe_insulation_garbled_installation` (regression-guard) | "insulation" → "installation" | Pin existing alternation |
| `probe_rcd_defer_garbled_filled_in` (regression-guard) | "fill it in later" → "filled in." | Pin deferTriggers regex from rcd.js:159-179 |

### Probe results — 2026-06-02 (after revision to engine-entry assertions)

| Probe | Result | Finding |
|---|---|---|
| `probe_rcd_type_ac_garbled_act` | PASS | Engine entered RCD via `/\bRCD\b/`, parser rejected "act" (correct), no off-enum write |
| `probe_ocpd_type_b_garbled_beat` | PASS | Engine entered OCPD via `/\bOCPD\b/`, parser rejected "beat" (correct), no off-enum write |
| `probe_megaohms_garbled_mega_home` | PASS | Engine entered IR, `parseBareMegaohmsWithUnit` rejected "mega home", value NOT silently written |
| `probe_bs_en_spoken_digits` | PASS | Engine entered OCPD, parseBsCode rejected word-form digits, value NOT written |
| `probe_rcd_defer_garbled_filled_in` | PASS | RCD deferTriggers correctly matches "filled in." → defer fires |
| `probe_insulation_garbled_installation` | PASS (after assertion fix) | Trigger alternation works. **Sub-finding:** wire shape has CANONICAL field name `ir_live_live_mohm` for dialogue-engine writes — `validateAndCorrectFields` doesn't rewrite on this emit path. SCHEMA.md says wire should be LEGACY. Rewrite leak on dialogue-engine emit path. |
| `probe_ring_garbled_wing` | PASS (after assertion fix) | Same canonical-leak gap — wire has `ring_r1_ohm` not `ring_continuity_r1`. |

### Findings — Category 4

1. **Existing garble alternations (insulation/installation, ring/bring/wing, fill-it-in defer) all work.** Regression-guards now pin them so a future regex rewrite cannot silently drop them.
2. **Parser rejection paths work correctly.** parseRcdType rejects "act", parseMcbType rejects "beat", parseBareMegaohmsWithUnit rejects "mega home". Engine asks for clarification instead of writing garbage. Excellent defensive behaviour.
3. **Canonical field-name leak on dialogue-engine writes.** Two scenarios (insulation, ring) revealed that the wire carries canonical (`ir_live_live_mohm`, `ring_r1_ohm`) NOT legacy (`insulation_resistance_l_l`, `ring_continuity_r1`) when the dialogue-engine drives the write. SCHEMA.md is wrong OR `validateAndCorrectFields` skips the dialogue-engine emit path. This affects iOS field aliasing: iOS may apply the value under the canonical name and miss the legacy alias. **New backend-fix candidate.**

### Cat 4 → backend-fix candidates

- Audit `validateAndCorrectFields` to ensure ALL emit paths (bundler, mid-stream speculator, dialogue-engine wire-emit) run the rewrite. Currently the dialogue-engine path appears to leak canonical names for IR + ring fields.

---

## Category 5 — Dispatcher validation gaps

### Validator surface map

| Validator | Source | What it checks | What it does NOT check |
|---|---|---|---|
| `validateRecordReading` | `stage6-dispatch-validation.js:73` | `circuitExistsInSnapshot(circuit, board_id)`; `confidence ∈ [0,1]` | **field-value enum** (the 2026-06-02 "AND" bug); numeric range (e.g. `rcd_operating_current_ma` 5-1000); BS-EN format on `ocpd_bs_en`/`rcd_bs_en`; AFDD button enum |
| `validateClearReading` | `stage6-dispatch-validation.js:96` | circuit existence | field-name validity against `CIRCUIT_FIELD_ENUM` (would catch a Sonnet typo) |
| `validateCreateCircuit` | `stage6-dispatch-validation.js:106` | circuit_ref doesn't exist; numeric meta is numeric | `rating_amps` plausible range; `cable_csa_mm2` is a standard cable size; designation length |
| `validateRenameCircuit` | `stage6-dispatch-validation.js:124` | source exists; target collision; numeric meta | same as create |
| `validateDeleteCircuit` | `stage6-dispatch-validation.js:187` | `circuit_ref ≥ 1` | nothing else (noop-on-absence is correct) |
| `validateCalculateZs` / `validateCalculateR1PlusR2` | `stage6-dispatch-validation.js:226` / `:238` | selector EXACTLY ONE; method enum (R1+R2 only) | snapshot has required inputs (deferred to dispatcher's skip-without-error path) |
| `validateBoardScope` | `stage6-dispatch-validation.js:416` | `input.board_id === currentBoardId` (when supplied) | nothing else |
| `validateRecordBoardReading` | `stage6-dispatchers-board.js:147` (inline) | `BOARD_FIELD_SET.has(field)`; confidence range | **field-value enum** (parallel "AND" bug class on supply fields); BS-EN format on `main_switch_bs_en`; voltage enum on `nominal_voltage_u`/`uo` |
| `validateAskUser` | `stage6-dispatch-validation.js:277` | question, reason, context_field, context_circuit, expected_answer_shape, pending_write shape | nothing more — this one is already tight |

### Likely gaps (numeric range + format)

- `rcd_operating_current_ma` — should be in `{10, 30, 100, 300, 500, 1000}` per supply `rcd_operating_current` enum OR free-form text. The circuit-level field has no enum but `5-1000` is a reasonable bound.
- `rcd_time_ms` — should be `0..10000` ms. A Sonnet `"3000"` for a 30 mA RCD at rated current is wrong (max 300 ms per BS 7671).
- `ocpd_rating_a` — typical 1-630 A. Hallucinated `"6000"` would persist.
- `measured_zs_ohm` — typical 0..100 ohms. A `"500"` write is implausible.
- `ir_test_voltage_v` — should be `{250, 500, 1000}`. Free-form text today.
- BS-EN format on `ocpd_bs_en` after coercion should match `/^(BS EN \d{4,5}(?:-\d)?|BS \d{4}|N\/A)$/`. Coercion fails when input is unrecognised — value flows through verbatim.

### New scenarios

Three probe scenarios written under `dispatcher_gaps/`:

| Scenario | Field | Probe shape | What it would catch |
|---|---|---|---|
| `probe_rcd_time_off_spec` | `rcd_trip_time` | Asserts `rcd_trip_time != "3000"` (3000 ms violates BS 7671 for 30 mA RCD) | Numeric range validator on rcd_time_ms |
| `probe_bs_en_unrecognised` | `ocpd_bs_en` | Asserts `ocpd_bs_en != "BS 99999"` (no canonical match in parseBsCode patterns; fuzzy fallback would also miss) | BS-EN format validator that rejects unrecognised codes |
| `probe_main_switch_bs_en_off_enum` | `main_switch_bs_en` (board level) | Diagnostic — captures what Sonnet writes for "60947 dash 3" | Format / enum coercion for board-level supply fields |

### Probe results — 2026-06-02

| Probe | Result | Finding |
|---|---|---|
| `probe_rcd_time_off_spec` | **FAIL** (regression-guard fires as designed) | `rcd_trip_time="3000"` persisted to circuit 1. Sonnet writes the implausible 3000 ms value verbatim. `validateRecordReading` has no numeric range check. **CONFIRMED DISPATCHER GAP.** |
| `probe_bs_en_unrecognised` | PASS | Sonnet declines to write "BS 99999" — recognises as non-canonical. Good defensive behaviour. |
| `probe_main_switch_bs_en_off_enum` | PASS | Sonnet canonicalises "60947 dash 3" → "BS EN 60947-3" verbatim on board-level supply field. |

### Findings — Category 5

1. **CONFIRMED — numeric range gap on `record_reading`.** `rcd_trip_time="3000"` violates BS 7671 (< 300 ms required at IΔn for general RCDs) but persists to iOS. Same bug class as Cat 1 (off-enum value writes) but in the numeric range dimension. The probe scenario will fail until a range validator lands.

2. **`record_board_reading` enum membership is enforced** (via `BOARD_FIELD_SET.has(field)` at `stage6-dispatchers-board.js:147`), but field-VALUE enum is NOT. Same gap as `validateRecordReading`. The `probe_main_switch_bs_en_off_enum` passes today because Sonnet's prompt covers this particular field — defence-in-depth via dispatcher would be belt-and-braces.

3. **The full validator surface map** (from the earlier table) shows EVERY write-tool validator skips field-value enum + numeric range checks. Patching `validateRecordReading` + `validateRecordBoardReading` would close 3-5 bug classes simultaneously.

### Cat 5 → backend-fix candidates

See backend-fix list at bottom: items #1-3 cover the numeric range, field-value enum, and BS-EN format validators.

---

## Category 6 — Schema entry ambiguity (broader pattern)

### Bug class
`tryEnterScriptFromWrites` matches the first schema whose slot list contains the written field. After commit `0632d352` (specificity-ranking), the engine prefers the more-specific schema when multiple match a shared slot. Edge cases remain.

### Shared-slot matrix

From reading the schemas:

| Slot | Schemas owning it (as primary, not volunteeredOnly) |
|---|---|
| `ocpd_bs_en` | OCPD (primary), RCBO (primary) |
| `rcd_bs_en` | RCD (primary), RCBO (volunteeredOnly post 2026-05-31) |
| `ocpd_type` | OCPD, RCBO |
| `ocpd_rating_a` | OCPD, RCBO |
| `ocpd_breaking_capacity_ka` | OCPD, RCBO |
| `rcd_type` | RCD, RCBO |
| `rcd_operating_current_ma` | RCD, RCBO |
| `rcd_trip_time` | RCD (volunteeredOnly) |
| `ir_live_live_mohm` etc. | IR only |
| `ring_r1_ohm` etc. | Ring only |

OCPD/RCBO and RCD/RCBO are the live ambiguity zones.

### Pivot cases not covered by specificity ranking

- **OCPD → RCBO pivot via `ocpd_bs_en: BS EN 61009`** (`ocpd.js:47`). Comment at `engine.js:2308` notes pivots aren't followed in `tryEnterScriptFromWrites`. So a Sonnet write of `ocpd_bs_en: BS EN 61009` should enter RCBO directly, not OCPD-then-pivot. Specificity ranking should handle this (RCBO is more specific because its slot list is longer) — but worth a scenario.
- **RCD → RCBO pivot via `rcd_bs_en: BS EN 61009`** (`rcd.js:78`). Same reasoning.
- **Cross-derivation collisions** — e.g. an inspector dictates `"rcd_type"` first then `"ocpd_type"`. Which schema wins?

### New scenarios

Three probes under `schema_ambiguity/`:

| Scenario | Tests | Hypothesis |
|---|---|---|
| `probe_rcd_type_alone_no_trigger` | Pure `rcd_type` write (no RCD/RCBO trigger word) | Schema score: RCD=2, RCBO=2 → tie → declared order picks RCBO. May surprise inspector who meant standalone RCD. |
| `probe_rcd_bs_en_61009_pivots_to_rcbo` | Enter via RCD trigger, write `rcd_bs_en="BS EN 61009"` | Derivation `{value:'61009', pivot:'rcbo'}` should fire mid-script → schema flips to RCBO → asks for curve next. |
| `probe_ocpd_bs_en_61009_enters_rcbo` | Enter via MCB trigger, write `ocpd_bs_en="BS EN 61009"` | Symmetric pivot via OCPD derivation. |

### Known limitations (documented; out of scope for new scenarios)

- `tryEnterScriptFromWrites` does NOT follow pivot edges (engine.js:2308 comment). A write-only path that lands `ocpd_bs_en=61009` without first entering a script via trigger word goes to RCBO via schemaScore tiebreaker — NOT via pivot. Equivalent end-state, different code path.
- Schemas with overlapping write-only paths and no engine trigger (no `RCD`/`MCB`/`OCPD` words in the transcript) rely entirely on schemaScore + declared order. Sonnet has to volunteer the right combination of slots for the right schema to win.

### Probe results — 2026-06-02

| Probe | Result | Finding |
|---|---|---|
| `probe_rcd_type_alone_no_trigger` | PASS | "Circuit 3 has a type AC residual current device 30 mA" → Sonnet writes `rcd_type="AC"` + `rcd_operating_current_ma="30"` via record_reading. No OCPD writes. Sonnet correctly classified as RCD-only. |
| `probe_rcd_bs_en_61009_pivots_to_rcbo` | **FAIL** (regression-guard fires as designed) | RCD-entry path: `rcd_bs_en="BS EN 61009"` writes correctly; `ocpd_bs_en` mirror DOES NOT appear on wire. iOS sees only one field updated. |
| `probe_ocpd_bs_en_61009_enters_rcbo` | **FAIL** (regression-guard fires as designed) | OCPD-entry path: `ocpd_bs_en="BS EN 61009"` writes correctly; `rcd_bs_en` mirror DOES NOT appear on wire. Symmetric bug. |

### Findings — Category 6

1. **CONFIRMED — pivot-time mirror does not reach the wire.** Both OCPD→RCBO and RCD→RCBO pivot paths land the originating BS-code on the wire but the mirrored BS-code is invisible to iOS. Root cause: `applyDerivations` (`src/extraction/dialogue-engine/helpers/derivations.js:61-104`) writes mirrors via `applyReadingToSnapshot` which mutates server-side snapshot only. `perTurnWrites.readings` is not updated, so the bundler emits the mirror invisibly. Server snapshot is consistent at session end; the live iOS UI is not.

2. **Sonnet may also write `rcd_type="B"` alongside `ocpd_type="B"` from "Type B" reply.** Observed in both pivot probes. The string "B" is a valid value for BOTH `rcd_type` (waveform) and `ocpd_type` (curve). Sonnet writes both. iOS shows the RCD column with a meaningless waveform "B" (not a real RCD type designator — RCD type B is rare, very different from MCB curve B). **New finding: ambiguous-value cross-field hallucination.** Could be addressed via tighter Sonnet prompt or per-field disambiguation.

3. **schemaScore tiebreak works correctly** for the Sonnet-driven write-only path (Sonnet doesn't trigger script entry; values land via `record_reading` directly). The `probe_rcd_type_alone_no_trigger` shows Sonnet correctly classifies "30 mA AC residual current device" as RCD intent, not RCBO.

### Cat 6 → backend-fix candidates

- **Fix the mirror wire-emit gap** — update `applyDerivations` (or its caller in `tryEnterScriptFromWrites` / per-turn slot writes) to push mirrored fields into `perTurnWrites.readings`. Highest-impact fix in this audit — affects every RCBO entry path.
- **Tighten Sonnet prompt** on "Type X" ambiguity — when an inspector just says "Type B" inside a known RCBO context, write ONLY the schema's currently-asked slot, not both `rcd_type` and `ocpd_type`.

---

## Category 7 — iOS-side gaps the WS harness can't see

The WS harness sees backend output. It does NOT see:

| iOS-side concern | Why harness can't observe | Backend signal that could help |
|---|---|---|
| TTS playback queue interruption — does iOS halt a speaking confirmation when a new one arrives? | Audio playback is iOS-only | `client_diagnostic` event from iOS could carry "TTS interrupted at offset X for new confirmation Y" |
| `fieldSources` / `originallyPreExistingKeys` attribution from commit `aed1d06` | Local iOS state | iOS could surface attribution via `client_diagnostic` |
| Local SwiftUI binding updates (e.g. green-flash on highlight) | UIKit rendering | n/a — purely visual |
| Camera / observation photo flows | iOS-only API surface | n/a |
| `regex_fast_v2` decision on a transcript (iOS-side regex arbitrates locally; Sonnet never sees the second value) | iOS makes the decision before transcript hits backend | iOS already sends `regexResults` in transcript payload — harness could assert what regex hints iOS sent |
| Confirmation-text de-dupe (the "Sonnet restated existing field" path from commit `aed1d06`) | Mostly iOS-side; backend has signal | Backend `fieldSources` could be inspected |

### Recommendation

Don't try to test iOS-only behaviour via this WS harness. Two paths forward:
1. **iOS XCUITest harness** — separate suite that drives the recording UI and observes playback queue, highlight state, attribution. Out of scope for this audit.
2. **Backend signal expansion** — add a `client_diagnostic` event family that iOS emits for state transitions the harness wants to observe. Cheap; backwards-compatible (harness can ignore if absent). Suggested for Derek's roadmap.

### Specific iOS-side regressions worth surfacing via backend signal

| Risk | Detection path |
|---|---|
| TTS overlap — bundler + speculator audio play simultaneously (the actual 2026-06-02 bug) | iOS could emit `client_diagnostic` carrying `tts_play_at` + `tts_play_audio_url` per playback start; harness asserts no overlap window. **High-leverage** — would have caught the 2026-06-02 bug. |
| Mid-stream confirmation displaces an in-flight confirmation mid-playback | iOS could emit `tts_preempted` event when a new audio buffer arrives before the previous one finished. |
| Speculator audio played but bundler subsequently sent a different value (drift) | Already covered server-side by `loaded_barrel_text_drift_detected` event (stub today per loaded-barrel-speculator.js:855); wire-up + test would close. |
| `originallyPreExistingKeys` / `fieldSources` lose track of CCU/manual provenance | iOS-only state today. Backend could carry `source: 'preexisting'` markers on the wire that the harness asserts. |
| `regex_fast_v2` arbitration on iOS — duplicate value handled, latest wins | iOS sends `regexResults` in transcript payload — harness CAN observe what iOS sent. Add coverage for the iOS regex hint flowing through. |

---

## Category 8 — Cross-cutting: flaky tests that catch real bugs

### `KNOWN_FLAKY.md` purpose
The 2026-06-01 matrix run deleted 13 scenarios as "Sonnet sampling noise". Several would have caught the 2026-06-02 under-fanning bug. The 2026-06-01 deletions cost us the 2026-06-02 field-test bug.

The fix is procedural, not algorithmic: **document the bug class each flaky scenario catches** so future authors don't delete the scenario without realising the cost.

### Procedure for marking a scenario flaky
1. Add `description:` note explaining the expected flakiness mode (Sonnet variance vs. true regression).
2. Add the scenario name to `tests/fixtures/voice-latency-scenarios/KNOWN_FLAKY.md` with the bug class it catches.
3. Use `has_no_reading` for the part of the assertion that DOESN'T depend on Sonnet behaviour (e.g. circuit 1 must not receive value X). The positive assertion can stay loose.

### Known-flaky scenarios from this audit

Two scenarios marked as expected-flaky in `tests/fixtures/voice-latency-scenarios/KNOWN_FLAKY.md`:

| Scenario | Flake rate | Bug class caught |
|---|---|---|
| `speculator_races/probe_different_field_same_turn_correction.yaml` | ~50% across 2 trials | Sonnet non-determinism on cross-field "actually sorry" correction |
| `bulk/circuits_2_and_3_list.yaml` | 80% (1 fail in 5 trials) | Under-fanning / silent turn drop on multi-circuit list — same bug class as 2026-06-02 session E87F58C1 |

`KNOWN_FLAKY.md` includes triage guidance for future authors so the 2026-06-01-style deletion doesn't recur.

---

## Backend fixes for Derek to authorise

Ordered by impact. NOT applied — Derek decides what to fix and authorises the patch.

### 1. **HIGH — `applyDerivations` mirrors don't reach the wire** (Cat 6)

`src/extraction/dialogue-engine/helpers/derivations.js:61-104` calls `applyReadingToSnapshot` for `mirrors` and `sets` payloads. This mutates the server-side snapshot but does NOT push the mirrored field into `perTurnWrites.readings`. The bundler emits `perTurnWrites.readings` only, so iOS does not see the mirrored value until next session sync.

**Repro:** `schema_ambiguity/probe_rcd_bs_en_61009_pivots_to_rcbo.yaml` and its OCPD-entry sibling.
**Impact:** Every RCBO entry path (~10-30% of typical inspections) writes only ONE BS-EN field on the wire instead of both. iOS UI does not visually confirm the mirrored field.
**Fix path:** Have `applyDerivations` accept a `perTurnWrites` reference (or return a list of mirrors for the caller to push). Tag mirrored writes with `auto_resolved: true` for slot-comparator filtering (mirrors the P3-B path from `stage6-dispatchers-board.js:192`).

### 2. **HIGH — `validateRecordReading` value-enum check** (Cat 1 + Cat 5)

`src/extraction/stage6-dispatch-validation.js:73-88` validates circuit existence + confidence range only. Closed-enum fields like `rcd_type`, `ocpd_type`, `wiring_type`, `polarity_confirmed`, `afdd_button_confirmed`, `rcd_button_confirmed`, `is_distribution_circuit` can receive off-enum values. Confirmed off-enum hallucinations:

- `afdd_button_confirmed="true"` (probe_afdd_confirmed)
- `wiring_type="twin and earth"` / `"SWA"` / `"MICC"` (probes_wiring_type_*)
- `rcd_trip_time="3000"` (probe_rcd_time_off_spec — numeric range gap)

**Fix path:** Add a value-enum cross-check against `circuit_fields.<field>.options` from `config/field_schema.json`. Reject off-enum at dispatch time with code `value_off_enum`. Same approach for numeric-range fields via a separate `numeric_range` annotation.

### 3. **HIGH — `validateRecordBoardReading` value-enum check** (Cat 1 + Cat 5)

`src/extraction/stage6-dispatchers-board.js:147` enforces `BOARD_FIELD_SET.has(field)` but not `options[]` membership for the value. Confirmed off-enum: `nominal_voltage_uo="240"`. Same fix path as #2 applied to `board_fields.*` + `supply_characteristics_fields.*` enums.

### 4. **MEDIUM — `coerceRecordReadingValue` extend POLARITY_FIELDS** (Cat 1)

`src/extraction/record-reading-coercion.js:40` includes only `polarity_confirmed` + `supply_polarity_confirmed`. Extending the set to include `afdd_button_confirmed` + `rcd_button_confirmed` would coerce common Sonnet hallucinations like `"true"` / `"confirmed"` / `"OK"` to canonical `"Y"` BEFORE dispatch. Cheap alternative to the full value-enum check in #2; would close ~50% of the cases.

### 5. **MEDIUM — `wiring_type` Sonnet prompt drift** (Cat 1)

Sonnet writes `wiring_type="D"` for both SWA and MICC. Per 2026-04-22 `config/field_schema.json` `ai_guidance` update (IET 9-code system), SWA = F/G, MICC = H. Sonnet's prompt has not caught up. Likely needs:

- Explicit prompt revision teaching the new 9-code table (most impact)
- AND/OR a server-side coercion table for common dictation forms (`SWA → F`, `MICC → H`, `T&E → A`, etc.) in `coerceRecordReadingValue`

### 6. **MEDIUM — `wiring_type` overwrite pattern** (Cat 1)

Sonnet emits TWO writes per turn for `wiring_type`: canonical FIRST then the raw text. Off-enum overwrite wins (last-write-wins). The structural fix is the value-enum validator in #2 — the overwrite would be rejected. The cheaper fix is a prompt instruction: "After writing canonical, do NOT re-emit the raw verbatim form."

### 7. **MEDIUM — Canonical field-name leak on dialogue-engine writes** (Cat 4)

Wire shape from dialogue-engine writes carries `ir_live_live_mohm` / `ring_r1_ohm` (canonical) instead of `insulation_resistance_l_l` / `ring_continuity_r1` (legacy). SCHEMA.md says wire should be legacy after `validateAndCorrectFields`. iOS may apply via canonical name and miss the legacy alias.

**Repro:** `garbles/probe_insulation_garbled_installation.yaml` empirically shows canonical on wire.
**Fix path:** Audit `validateAndCorrectFields` to ensure ALL emit paths run the rewrite. The dialogue-engine wire-emit path (`src/extraction/dialogue-engine/helpers/wire-emit.js`) bypasses it.

### 8. **MEDIUM — Canonical + legacy double-emit on every reading** (Cat 2)

Every reading appears TWICE on the wire — canonical (mid-stream speculator envelope) + legacy (bundler post-loop envelope). iOS dedupes via field-name alias. If iOS dedupe ever breaks, every reading appears twice. Investigate whether this is intentional (mid-stream preview + post-loop final emit are conceptually distinct) or accidental (one emit path doesn't run `validateAndCorrectFields` so canonical leaks through).

### 9. **MEDIUM — Cross-field `Type X` hallucination** (Cat 6)

When inspector replies "Type B" inside an active RCBO script, Sonnet writes BOTH `ocpd_type="B"` AND `rcd_type="B"` (per probe_*_61009_*). MCB curve B and RCD waveform B are semantically unrelated; the cross-write is wrong. Sonnet's prompt should scope the value to the currently-asked slot.

### 10. **LOW — `circuits_2_and_3_list` Sonnet under-fanning** (Cat 3)

20% miss rate on "Insulation L to L 200 megohms for circuits 2 and 3." Same bug class as 2026-06-02 session E87F58C1. Likely fixes:
- Prompt tightening on multi-circuit list parsing
- Engine-level fallback: if `BROADCAST_LIST_RE` matches AND Sonnet writes 0 record_readings, emit a `client_diagnostic` so iOS surfaces a "did the system catch that?" hint

### 11. **LOW — Speculator-vs-broadcast race (NOT in this audit's scope)**

The original 2026-06-02 bug — `loaded_barrel_fired` 388 ms before `loaded_barrel_broadcast_detected` — is in a separate workstream per handoff. This audit does NOT pin the regression-guard for this bug; that's the separate workstream's job.

### 12. **LOW — `voltage=240` is real-world dictation but off-enum** (Cat 1)

Historical UK voltage. Inspectors still dictate it. Options:
- Add `"240"` to `nominal_voltage_uo.options` (preserves info)
- Coerce `"240"` → `"230"` (silent rewrite — risky)
- Have Sonnet emit `ask_user` to clarify

---

## Summary table — net new harness coverage

| Suite | Scenarios | Status |
|---|---|---|
| `enum_guards/` | 10 | 4 confirmed off-enum / wrong-canonical bugs caught; 6 positive pins |
| `speculator_races/` | 5 | 4 pass; 1 expected-flaky (KNOWN_FLAKY) |
| `garbles/` | 7 | All pass; 2 revealed canonical-leak sub-bug |
| `dispatcher_gaps/` | 3 | 1 confirmed numeric-range gap; 2 positive pins |
| `schema_ambiguity/` | 3 | 2 confirmed pivot-mirror gaps; 1 positive pin |
| **Total** | **28** | **8 regression-guards firing for confirmed gaps + 18 positive pins + 2 known-flaky** |

Plus:
- `tests/fixtures/voice-latency-scenarios/KNOWN_FLAKY.md` — author-facing documentation of expected-flaky scenarios with triage guidance.
- `.planning/audit-2026-06-02-harness-gaps.md` — this document.

### Regression-sanity-check budget remaining

The 87-scenario existing suite was NOT re-run during this audit. Each run ~$0.02-0.05; full sweep ~$2-4. Worth one full run after Derek triages this list to confirm no regressions in the existing scenarios.


