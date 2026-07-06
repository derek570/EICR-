---
name: bs7671-domain-reference
description: >-
  Load when a task touches electrical-domain MEANING in CertMate: any circuit/board/supply
  field name (measured_zs_ohm, r1_r2_ohm, ir_*_mohm, spd_*, surge_*, main_switch_*, ze, rcd_*),
  observation codes C1/C2/C3/FI, LIM or >200 sentinels, EICR-vs-EIC differences, BS EN device
  standards (60898/61009/61008/3036), earthing arrangements (TN-S/TN-C-S/PME/TT), inspection
  schedule items/outcomes, Zs = Ze + R1+R2 derivations, or editing config/field_schema.json.
  Also load before writing/reviewing any prompt, parser, or test that names one of these fields —
  the label traps here (main fuse -> spd_bs_en, ring r1 vs R1+R2) silently corrupt certificates.
  Do NOT load for pure infra/deploy work, WebSocket frame mechanics (certmate-voice-wire-protocol),
  CCU photo pipeline internals (certmate-ccu-pipeline), or latency work (certmate-latency-campaign).
---

# BS 7671 Domain Reference — as it applies in this repo

BS 7671 ("the Wiring Regulations", current edition 2018+A2:2022; prompts also cite A4:2026) is the UK
standard for electrical installations. CertMate produces two BS 7671 certificate types from an
inspector's dictation and photos. This skill gives a zero-electrical-background model exactly the
domain theory needed to work on THIS codebase — every claim is grounded in a repo file. It is not a
textbook: where BS 7671 and the code disagree, the code + `config/field_schema.json` win.

All facts verified against the repo as of 2026-07-06.

## When NOT to use this skill

| You are working on | Use instead |
|---|---|
| WebSocket frame shapes, capabilities, cancel_pending_tts | `certmate-voice-wire-protocol` |
| CCU photo extraction stages, slot enumeration, dewarp | `certmate-ccu-pipeline` |
| Dictate→confirm latency, TTS timing | `certmate-latency-campaign` |
| Why an extraction/apply bug happened | `certmate-debugging-playbook` |
| Env vars, flags, thresholds | `certmate-config-and-flags` |
| Change gating, backend-immutable rule, ledger rows | `certmate-change-control` |
| Design decisions / invariants overall | `certmate-architecture-contract` |
| Test evidence standards | `certmate-validation-and-qa` |
| Past incidents & dead ends | `certmate-failure-archaeology` |

## 1. EICR vs EIC

| | EICR | EIC |
|---|---|---|
| Full name | Electrical Installation Condition Report | Electrical Installation Certificate |
| Purpose | Periodic inspection of an EXISTING installation | Certifies NEW installation work |
| Observations (coded defects) | Yes — the core deliverable | **NO observations at all** |
| Inspection schedule | ~90 items, 7 sections (3 PDF pages) | 14 items (1 PDF page) |
| Extra schema sections | `observation_fields` | `eic_extent_and_type_fields` (extent, installation_type, comments), `eic_design_construction_fields` (departures) |
| Job field | `certificate_type: 'EICR'` | `certificate_type: 'EIC'` |

EIC-specific behaviour (do not "fix" as bugs):
- Backend state-snapshot prefix carries a `CERTIFICATE TYPE: EIC` line from turn 1; prompt RULE 0
  steers the model AWAY from `record_observation` on an EIC → defect talk is diverted to the EIC
  `comments` field (voice apply = newline-append; shipped 2026-07-02 WS3).
- Web defence-in-depth: `web/src/lib/recording/apply-extraction.ts` "M7" block drops observations
  and five EICR-only installation fields when `job.certificate_type === 'EIC'` (mirrors iOS
  `applySonnetObservations` early-return).
- Report outcome: any C1 or C2 observation makes an EICR **Unsatisfactory**. Under BPG4 Issue 7.3
  a sole FI no longer automatically does (the older 7.2 "or FI" clause was removed) — encoded in
  `src/extraction/observation-code-lookup.js:141-143`.

## 2. The measurements and how they relate

Definitions (used throughout the schema):
- **Ze** — external earth-fault loop impedance (ohms), measured at the origin/supply. Field:
  `earth_loop_impedance_ze` (supply) / `ze` (board), plus `ze_at_db` for "Ze at the distribution board".
- **R1+R2** — combined resistance of line conductor (R1) + circuit protective conductor/earth (R2)
  for one circuit. Field: `r1_r2_ohm`. **R2** alone = `r2_ohm`.
- **Zs** — total earth-fault loop impedance for a circuit. **Zs = Ze + (R1+R2)** — the load-bearing
  identity. Field: `measured_zs_ohm`. Must be below the OCPD's max Zs (`ocpd_max_zs_ohm`).
- **ring r1 / rn / r2** (lowercase!) — end-to-end loop resistances of a RING FINAL circuit
  (line / neutral / cpc legs). Fields: `ring_r1_ohm`, `ring_rn_ohm`, `ring_r2_ohm`. For a healthy
  ring, R1+R2 ≈ (r1 + r2) / 4.
- **PFC / Ipf** — prospective fault current (kA): `prospective_fault_current` (supply), `ipf_at_db` (board).
- **OCPD** — overcurrent protective device (MCB / RCBO / fuse) protecting a circuit.
- **RCD** — residual current device (trips on earth-leakage). **RCBO** = RCD + MCB in one device.

Where the identity is implemented (all skip-don't-overwrite — a meter reading always wins):
- Backend tools `calculate_zs` (Zs = Ze + R1+R2, batch via `all:true`) and `calculate_r1_plus_r2`
  (`method:"zs_minus_ze"` → R1+R2 = Zs − Ze, or `method:"ring_continuity"` → (r1+r2)/4; if BOTH ring
  values and Zs exist the model must `ask_user` which method) — `config/prompts/sonnet_agentic_system.md:28-29`.
- Shared TS: `packages/shared-utils/src/circuit-derivations.ts` (`recomputeAll`) +
  `impedance.ts`; run as pass "H4" in `web/src/lib/recording/apply-extraction.ts:1723`. Mirrors iOS
  `CircuitDerivations.swift`. Only fills EMPTY targets.
- Max-Zs ceiling: `ocpd_max_zs_ohm` auto-computed from `ocpd_type` + `ocpd_rating_a` +
  `max_disconnect_time_s` via BS 7671 tables (`packages/shared-utils/src/max-zs-lookup.ts`; iOS
  `Circuit.recalculateMaxZs()`); pass "H3" in apply-extraction.

**Polarity auto-tick** (the canonical example of a silent auto-derivation — exempt from the
Audio-First "read back every reading" invariant, by design):
- A valid numeric Zs (or R1+R2) reading proves L→E loop continuity, which is only measurable with
  correct polarity → `polarity_confirmed` is ticked "✓" when empty. iOS:
  `DeepgramRecordingViewModel.swift:5639` (Zs) and `:8018` (R1+R2), mirroring `autoPolarityIfTestResult`
  in CircuitsTab. Numeric values only — "LIM"/"N/A"/garbled text never trip it.
- Web has the SUPPLY-level mirror: numeric Ze → `supply_polarity_confirmed = true` +
  `earthing_conductor_continuity = 'PASS'` (apply-extraction.ts "M3", ~line 1296). A web
  circuit-level Zs→polarity tick was NOT found in `apply-extraction.ts` as of 2026-07-06 —
  treat as a possible parity gap to verify against the ledger, not as established behaviour.
- `polarity_confirmed` enum is exactly `["", "OK", "Y", "N"]` in the schema; spoken "all good on
  polarity" maps to a pass value per the prompt.

Impedance sanity ("H5", apply-extraction ~line 777): Deepgram drops decimals
("zero point four four" → "44"); a clean ÷10 or ÷100 back into the 0.01–2.0 Ω continuity band is
recovered silently; out-of-range values still WRITE (very-high-Ze TT sites are legitimate).

## 3. Insulation resistance (IR), the sentinels, and LIM

IR test: megaohm (MΩ) resistance between conductors at `ir_test_voltage_v` (usually 250/500 V).
Fields: `ir_live_live_mohm` (L-N) and `ir_live_earth_mohm` (L+N to E combined). Healthy ≥ 1 MΩ
(below 1 MΩ between N and E is a C2 per WRAG Q2.26); typical 50–200+ MΩ; meters saturate.

Parser: `src/extraction/dialogue-engine/parsers/megaohms.js` (`parseMegaohms`), which MUST stay
byte-identical in behaviour with `parseValue()` in `src/extraction/insulation-resistance-script.js`
(replay-corpus mirror rule stated in both headers). Accepted shapes, most specific first:

| Spoken | Stored |
|---|---|
| "greater than 200" / "over 999" / ">200" | `>200` etc. (verbatim, leading-zero normalised) |
| "infinite" / "off scale" / "OL" / "out of range" / "maxed out" | `>999` (canonical saturation) |
| "LIM" and garbles: limb, limp, limit(ation/ed), Lynn, Lym | `LIM` |
| bare numeric "200", ".43" | `200`, `0.43` |

**LIM** = "limitation": the test could not be performed (access/safety). It is a FIRST-CLASS valid
value for ANY IR field (reversed 2026-06-16 after field session F1AC26FB — rejecting it looped the
IR ask forever; the same loop was first fixed 2026-02-18 and recurred). LIM also appears as:
an inspection-schedule outcome, a select option on bonding/continuity fields
(`PASS/FAIL/LIM/N/A`), and on `surge_spd_present` (`Yes/No/N/A/LIM`).

**Why fuzzy garble correction is BANNED.** Project-wide decision (recorded in
`web/audit/INDEX-2026-07.md:36`, "parent §3E"): NO fuzzy/edit-distance correction of Deepgram
transcript garbles anywhere. A false correction that mis-files a reading on a safety-critical
certificate is worse than a miss. The ONLY sanctioned corrections are:
1. **Curated garble lists** — the explicit word-anchored LIM variants above (word-anchored so "OL"
   never fires inside "isolation"/"tolerance" — see the `MEGAOHMS_VALUE_GROUP` comment).
2. **Curated equal-weight Deepgram keyterms** (Flux) / keyword boosts (Nova-3) — fix upstream at
   the STT layer (the WS4 probe showed `keyterm=` corrects "lion"→"LIM").
3. **Scoped Lev-1 matching against a CLOSED enum** — `dialogue-engine/parsers/bs-code.js` and
   `stage6-answer-resolver.js:1407` allow Levenshtein-distance-1 on BS-code DIGITS against the
   canonical device-standard list ("6898"→"60898"). This is enum snapping, not free-text correction.
Do not add a general fuzzy matcher, ever, without explicit user mandate.

## 4. Observation codes C1/C2/C3/FI and the auto-classification flow

Codes (per Electrical Safety First Best Practice Guide 4 — **BPG4 Issue 7.3, May 2026** — the
industry coding guide; schema enum also has `NC`):

| Code | Meaning (as encoded in `observation-code-lookup.js:125-146`) |
|---|---|
| C1 | Danger present NOW — can hurt someone as-is. → report Unsatisfactory |
| C2 | Potentially dangerous — ONE foreseeable fault/contact/change makes it dangerous (missing earthing/bonding/RCD where required). → Unsatisfactory |
| C3 | Improvement recommended — non-compliant with current edition but safe as it stands. Older-edition compliance is usually C3, not C2 (over-coding is the most common error — WRAG Q2.27) |
| FI | Further investigation — genuine reasonable doubt only; BPG4 7.3 has NO domestic FI examples; if C1/C2/C3 can be attributed, FI is wrong. Sole FI no longer auto-Unsatisfactory |
| NC | Non-conformity, "not recorded on EICR" per schema ai_guidance |

Two-stage app flow (the product's USP — dictation → properly coded, regulation-cited observation):
1. **Immediate first pass** — the live extraction model emits `record_observation`
   (`stage6-tool-schemas.js:385`) with candidate code/text; the UI row appears in ~200 ms.
2. **Background refinement** (~2 s) — `src/extraction/observation-code-lookup.js` calls
   `gpt-5-search-api` to produce 4 things: professional BS 7671-language rewrite, reasoned code,
   regulation citation, and a `schedule_item` picked VERBATIM from the full server-side schedule
   (the whole schedule is inlined — a "common mappings" seed list was removed 2026-05-01 because
   the model anchored on it). Result patches the row in place via an `observation_update` WS frame.
   Refinement ALWAYS runs (no gate). Ambiguity rule: prefer the LESS severe code.
3. **Canonical wording** — `src/extraction/regulation-lookup.js` (`lookupRegulation(ref)`) replaces
   model wording with authoritative title/description on a table HIT against
   `config/bs7671-regulations.json` (**only 68 entries**, versioned 2018+A2:2022 — table-MISS is
   the COMMON case; model wording survives on a miss, by design). Same table serves
   `/api/regulations` search (`src/routes/settings.js`).
4. **WRAG** (Wiring Regulations Advisory Group — IET/ESF joint Q&As, equal authority to BPG4,
   more-specific-wins): coding-relevant subset inlined from `config/prompts/wrag-bs7671-eicr.md`.

## 5. The 29 circuit columns (7 groups)

Source of truth: `config/field_schema.json` → `circuit_fields` (31 keys = the 29 UI columns +
2 Hierarchy fields `is_distribution_circuit`/`feeds_board_id` used for multi-board wiring).
The 7 groups in `field_groups` cover 27 columns; `circuit_ref` + `circuit_designation` sit outside
groups. Full per-column guidance: `docs/reference/field-reference.md` §"All 29 Columns" and each
field's `ai_guidance` in the schema.

| Group | Columns | Meaning / typical values |
|---|---|---|
| Circuit Details | `circuit_ref`, `circuit_designation`, `wiring_type`, `ref_method`, `number_of_points`, `live_csa_mm2`, `cpc_csa_mm2`, `max_disconnect_time_s` | ref = "1","2"…; designation = "Sockets Ring"; CSA = conductor cross-section mm² (1.0 lights, 2.5 sockets, 6–10 cooker/shower); disconnect time usually 0.4 s |
| OCPD | `ocpd_bs_en`, `ocpd_type`, `ocpd_rating_a`, `ocpd_breaking_capacity_ka`, `ocpd_max_zs_ohm` | type = curve B/C/D or fuse class gG/gM/aM/HRC/Rew; rating 6A lights → 32A ring; breaking capacity usually 6 kA domestic; max Zs auto-computed (H3) |
| RCD | `rcd_bs_en`, `rcd_type`, `rcd_operating_current_ma` | IΔn usually 30 mA for additional protection |
| Ring Final | `ring_r1_ohm`, `ring_rn_ohm`, `ring_r2_ohm` | lowercase end-to-end legs, typical 0.2–0.8 Ω |
| Continuity | `r1_r2_ohm`, `r2_ohm` | R1+R2 measured at furthest point, 0.1–2.0 Ω |
| Insulation Resistance | `ir_test_voltage_v`, `ir_live_live_mohm`, `ir_live_earth_mohm` | §3 above; `>200` / `LIM` sentinels valid |
| Test Results | `polarity_confirmed`, `measured_zs_ohm`, `rcd_time_ms`, `rcd_button_confirmed`, `afdd_button_confirmed` | rcd_time = trip time in ms; AFDD = arc-fault detection device |

**Canonical vs legacy wire names.** Stage 6 tools use the schema names above, but the iOS wire
contract uses LEGACY aliases; `validateAndCorrectFields` (sonnet-stream.js) rewrites via
`src/extraction/field-name-corrections.js` before frames leave the backend. Most-confused pairs:
`measured_zs_ohm`↔`zs`, `r1_r2_ohm`↔`r1_plus_r2`, `rcd_time_ms`↔`rcd_trip_time`,
`ir_live_live_mohm`↔`insulation_resistance_l_l`, `ir_live_earth_mohm`↔`insulation_resistance_l_e`,
`earth_loop_impedance_ze`↔`ze`. Any new wire field needs an END-TO-END contract test (Bug-I lesson:
backend emitted `measured_zs_ohm`, iOS dispatched on `zs` → silent drop).

## 6. Label traps — read BEFORE routing any spoken phrase to a field

The rule behind all of these: **trace natural language to the schema LABEL, not to the field name.**

### 6a. The side-of-the-meter trap (`spd_*` ≠ surge protection!)

Three device families live around the origin of the installation:

| Family | What it physically is | Spoken triggers |
|---|---|---|
| `spd_*` (`spd_bs_en`, `spd_type_supply`, `spd_short_circuit`, `spd_rated_current`) — schema label "**Supply Protective Device**" | The DNO's supply CUT-OUT fuse, BEFORE the meter. NOT in the consumer unit | "main fuse", "supply fuse", "DNO fuse", "cutout", "service fuse" |
| `surge_*` (`surge_spd_present`, `surge_spd_type`, `surge_spd_bs_en`, `surge_status_indicator`) | The actual Surge Protection Device (transient overvoltage, BS 7671 §443/534, Type 1/2/3) | "surge protection", "SPD", "Type 2 surge" |
| `main_switch_*` (`main_switch_bs_en`, `_poles`, `_current`, …) | The consumer-unit main isolator, AFTER the meter | "main switch" |

Rules (verbatim from `config/prompts/sonnet_agentic_system.md:138-154`): "main fuse is BS 1361
type 1" → `spd_bs_en: "1361 type 1"` (strip the leading BS/BS EN prefix — TTS re-adds it); a fuse
type spoken WITHOUT a BS number → `spd_type_supply`; NEVER route surge talk to `spd_*`;
"main fuse" and "main switch" in one utterance = TWO writes. `main_switch_bs_en` is NOT "main
fuse" — this exact confusion caused field defects (session F03B590C, PR #47). When
`surge_spd_present` = "No", the other surge fields are "N/A" — never backfill from main-switch data.

### 6b. Sibling-field traps

| Trap | Discriminator |
|---|---|
| `ze` vs `zs` | Ze = supply/origin; Zs = per-circuit. Bare "Ze" → `earth_loop_impedance_ze` (board reading, no ask); "Ze at the board/DB" → `ze_at_db` |
| `ring_r1_ohm`/`ring_rn_ohm`/`ring_r2_ohm` (little r) vs `r1_r2_ohm`/`r2_ohm` (big R) | "ring r1" = end-to-end leg; "R1 plus R2" = combined continuity. Related by (r1+r2)/4 |
| `ocpd_rating_a` (A) vs `ocpd_breaking_capacity_ka` (kA) | Numeric ranges OVERLAP (6A rating vs 6kA capacity) — a unit or the words "rating"/"breaking capacity" is mandatory; bare numbers must trigger `ask_user`, never a guess (prompt "missing_field" rule, sonnet_agentic_system.md:100) |
| RCD vs RCBO dialogue scripts | `ALL_DIALOGUE_SCHEMAS` order is ring-continuity, insulation-resistance, **RCBO, OCPD, RCD** (`dialogue-engine/index.js:42`) and script entry is first-match-wins (`engine.js:276`). Both RCBO and RCD schemas list `rcd_bs_en`; a specificity-ranking fix (2026-06-02, `engine.js:~2913`) scores schemas per-turn, but residual RCD-writes-landing-in-RCBO mis-routes remain a known OPEN item — check before "fixing" order |
| `rcd_operating_current_ma` (circuit column) vs `rcd_operating_current` (supply select) | circuit-level free text vs supply-level select `10/30/100/…` |
| `insulation_resistance_le` vs `_l_e` etc. | legacy alias soup — always go through `FIELD_CORRECTIONS` |

Bare-value discipline: a number with a circuit ref but NO field cue is NEVER written — the model
must ask one open question ("For circuit N, what was that reading for?"), no option menus.

## 7. BS EN device standards and RCD types

BS/BS EN numbers identify the device standard; inspectors dictate digits only ("sixty zero eight
nine eight"). Canonicalised by `parseBsCode` (dictation) and `BS_EN_LOOKUP` at
`src/routes/extraction.js:278` (CCU pipeline; a second definition exists in
`src/extract.js:221`). Schema option lists are the closed enums.

| Standard | Device |
|---|---|
| BS EN 60898 | MCB (miniature circuit breaker — the standard "breaker") |
| BS EN 61009 | RCBO (combined MCB + RCD, one per circuit) |
| BS EN 61008 | RCCB (standalone RCD, protects a group of circuits) |
| BS EN 62423 | Type F / B RCDs |
| BS EN 60947-2 / -3 | MCCB / switch-disconnector (isolator) |
| BS EN 60269-2 | HRC fuse (historically "BS 88-2/88-3") |
| BS 3036 | Rewireable (semi-enclosed) fuse — old boards, colour-coded fuse-wire carriers |
| BS 1361 | Cartridge fuse (also the classic DNO cut-out fuse) |

RCD types = which fault WAVEFORM the device can detect (schema enum on `rcd_type`:
`AC, A, F, B, S, A-S, B-S, B+, N/A`): **AC** = AC sinusoidal only (oldest); **A** = AC + pulsating
DC (modern default — most common answer); **F** = adds high-frequency (variable-speed drives);
**B** = adds smooth DC (EV chargers, PV); **S** / `-S` suffix = selective/time-delayed for
discrimination; **B+** = enhanced B. The CCU pipeline can't reliably read the sub-millimetre
waveform glyph, so `config/rcd-type-lookup.json` + `src/extraction/rcd-type-lookup.js` override
per-slot VLM reads from a manufacturer/model table (confidence `high` overrides unconditionally,
`medium` yields to per-slot reads ≥0.95, `low` fills nulls only; e.g. all current Elucian RCBOs
are Type A at `high`).

## 8. Earthing arrangements

`earthing_arrangement` enum: `TN-S, TN-C-S, TT, IT, TN-C` (supply + board sections).

| Arrangement | Meaning | App-relevant consequences |
|---|---|---|
| TN-S | DNO provides a separate earth (cable sheath) | Typical Ze ≤ 0.8 Ω |
| TN-C-S (= **PME**, protective multiple earthing) | DNO combines neutral+earth in the supply, split at the origin | Typical Ze ≤ 0.35 Ω; PME has special rules for EV chargers (WRAG Q2.47 → C3 without open-PEN protection) |
| TT | NO DNO earth — local earth electrode | High Ze is NORMAL (why out-of-range Ze still writes); fault protection depends on RCDs; electrode fields become relevant |
| TN-C / IT | Rare (combined N+E throughout / isolated) | Enum-complete, rarely dictated |

TT mirror (silent auto-derivation, "M1" in apply-extraction.ts ~1252, iOS
`SupplyTab.setEarthingArrangement`): setting `earthing_arrangement='TT'` auto-sets
`means_earthing_electrode=true`, `means_earthing_distributor=false`, and
`inspection_schedule.is_tt_earthing=true` (when unset). Bonding PASS synonyms ("yes", "confirmed",
"installed"…) normalise to `PASS` and derive `main_bonding_continuity='PASS'` ("M2").

## 9. Inspection schedules (~90 EICR + 14 EIC) and outcomes

Three synchronized copies — **change one, change all in the same commit** (mandate stated in the
server prompt header):
1. Server canonical: `config/prompts/schedule-of-inspection-bs7671-eicr.md` (92 dotted refs,
   `1.1` … `7.53`, incl. sub-items, 7 sections; feeds `record_observation.schedule_item`).
2. iOS PDF template: `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift` (`InspectionItem2` rows).
3. Web: `web/src/lib/constants/inspection-schedule.ts` — `EICR_SCHEDULE` (7 sections, ~90 items)
   + `EIC_SCHEDULE` (14 items), ported verbatim from iOS `Constants.swift`.

Sections: 1 intake equipment (visual only) · 2 other sources/microgenerators · 3 earthing/bonding ·
4 consumer unit(s) — the BOARD itself, NOT accessories · 5 final circuits (accessories live here,
e.g. 5.18 condition of accessories) · 6 location(s) containing bath/shower · 7 other Part 7
special installations or locations.

Outcomes per item (`inspection_schedule_fields._outcome_options`): `tick` (inspected,
satisfactory) / `N/A` / `C1` / `C2` / `C3` / `LIM` (unable to inspect).

Observation ↔ schedule linkage (both directions):
- Picking C1/C2/C3 on a schedule row with no linked observation auto-creates one
  (`web/src/app/job/[id]/inspection/page.tsx:182`; changing/deleting prompts about the link).
- An observation carrying `schedule_item` auto-stamps that schedule row's outcome with the code
  (iOS `ObservationScheduleLinker`; web mirror in apply-extraction).

## 10. `config/field_schema.json` — the single source of truth

Version 2.0. Sections and real-field counts (keys starting `_` are UI metadata):
`circuit_fields` 31 · `board_fields` 15 · `installation_details_fields` 21 ·
`supply_characteristics_fields` 49 · `inspector_profile_fields` 5 · `eic_extent_and_type_fields` 3 ·
`eic_design_construction_fields` 2 · `inspection_schedule_fields` (meta: `_outcome_options`,
`_outcome_meanings`, `_ai_guidance`) · `observation_fields` 7 · `field_groups` (the 7 circuit groups).
133 fields carry `ai_guidance` — free-text steering injected into extraction prompts. When editing
a field, edit its `ai_guidance` too; it IS product behaviour.

Consumers that regenerate from it at module load (no build step — restart picks it up):
- `src/extraction/stage6-tool-schemas.js:42` — `record_reading.field` enum = `circuit_fields` keys;
  `record_board_reading.field` enum = supply + board + installation keys (one merged enum, matching
  the legacy KNOWN_FIELDS shape); `ask_user.context_field` enum = the union + sentinels. The
  Anthropic API then rejects off-enum names before our code sees them; dispatchers re-validate
  (defence in depth). Every OTHER enum lives in `config/stage6-enumerations.json`.
- iOS parity gate: `scripts/check-ios-field-parity.mjs` — every schema entry must have a matching
  case in iOS `applySonnetReadings`.

Sync checklist when adding an extractable field (per hub CLAUDE.md, do not route around it):
1. Add to `config/field_schema.json` with `label`, `type`, `options` (if select), `ai_guidance`.
2. Add prompt coverage in `src/extraction/eicr-extraction-session.js` / relevant prompt file.
3. Add the iOS `applySonnetReadings()` case (separate repo `CertMateUnified/` — iOS is canon).
4. Add keyword boosts in iOS `default_config.json` / web `keyword-boosts.ts`.
5. Update `docs/reference/field-reference.md`. Backend changes are gated by the backend-immutable
   rule during parity work — see `certmate-change-control` FIRST.

## Provenance and maintenance

Grounded 2026-07-06 against the working tree (branch `main`). One-line re-verification commands:

| Fact | Re-verify with |
|---|---|
| circuit_fields = 31 keys / groups / options | `python3 -c "import json;d=json.load(open('config/field_schema.json'));print(len(d['circuit_fields']),[g['name'] for g in d['field_groups']])"` |
| LIM garble set + sentinels | `sed -n 1,70p src/extraction/dialogue-engine/parsers/megaohms.js` |
| Fuzzy-correction ban wording | `grep -n "fuzzy" web/audit/INDEX-2026-07.md` |
| Scoped Lev-1 BS-code exception | `grep -rn "levenshtein" src/extraction/dialogue-engine/parsers/bs-code.js src/extraction/stage6-answer-resolver.js` |
| C1/C2/C3/FI criteria + BPG4 issue | `sed -n 110,150p src/extraction/observation-code-lookup.js` |
| Regulation table size (68) + caveat | `sed -n 1,30p src/extraction/regulation-lookup.js` |
| main-fuse → spd_* routing rules | `sed -n 130,160p config/prompts/sonnet_agentic_system.md` |
| calculate_zs / calculate_r1_plus_r2 contracts | `sed -n 25,32p config/prompts/sonnet_agentic_system.md` |
| Zs=Ze+R1+R2 shared impl | `grep -n "Zs = Ze" packages/shared-utils/src/*.ts` |
| iOS polarity auto-tick sites | `grep -n "polarity_auto_ticked" CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift` |
| Schedule item counts (92 / 14) | `grep -cE "^- [0-9]+\." config/prompts/schedule-of-inspection-bs7671-eicr.md && grep -n "EIC_SCHEDULE" web/src/lib/constants/inspection-schedule.ts` |
| Tool-enum generation from schema | `sed -n 1,20p src/extraction/stage6-tool-schemas.js` |
| Dialogue schema order / first-match | `sed -n 42,49p src/extraction/dialogue-engine/index.js && grep -n "first matching schema" src/extraction/dialogue-engine/engine.js` |
| RCD manufacturer lookup semantics | `python3 -c "import json;print(json.load(open('config/rcd-type-lookup.json'))['_doc']['confidence_levels'])"` |
| Legacy wire-name map | `sed -n 38,60p src/extraction/field-name-corrections.js` |

Open/uncertain items (do not state as fact): residual RCBO/RCD script mis-routing (open);
web circuit-level Zs→polarity tick not found in `apply-extraction.ts` (possible deliberate
iOS-only divergence — check `web/docs/parity-ledger.md` before acting); BPG4 version string in
`field_schema.json` `observation_fields.code.description` still says "Issue 7.1" while the live
refinement prompt says 7.3 — the prompt is current, the schema description is stale.
