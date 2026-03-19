> Last updated: 2026-02-18
> Related: [Architecture](architecture.md) | [iOS Pipeline](ios-pipeline.md) | [Deployment](deployment.md) | [File Structure](file-structure.md) | [Deployment History](deployment-history.md)
> Hub: [../../CLAUDE.md](../../CLAUDE.md)

# Complete UI Field Reference (Single Source of Truth)

**IMPORTANT:** This document lists ALL fields in the PWA UI. When the UI changes, update both this document AND `config/field_schema.json`. The AI extraction (`src/extract.js`) reads the field schema to know exactly what fields to extract from audio transcripts.

## How to Keep AI in Sync with UI Changes

1. When you add/modify a UI field, update `config/field_schema.json`
2. The schema includes `ai_guidance` for each field telling the AI how to extract it
3. Update the relevant table below to document the change
4. The AI will automatically use the updated schema for extraction

## Installation Details Tab (`/job/[id]/installation`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `client_name` | text | - | Name of client/property owner. Listen for "Mrs Smith", "Mr Jones", etc. |
| `address` | text | - | Full property address. Listen for street, house number, town. |
| `postcode` | text | - | UK postcode like "RG1 1AA" |
| `premises_description` | select | Residential, Commercial, Industrial, Agricultural, Other | Usually "Residential" for houses |
| `installation_records_available` | boolean | - | True if previous certificates/records available |
| `evidence_of_additions_alterations` | boolean | - | True if unrecorded work found |
| `next_inspection_years` | select | 1, 2, 3, 4, 5, 10 | Typically 5 years domestic, 3 for rented |
| `extent` | text | - | What was inspected: "Whole installation", "Main CU only" |
| `agreed_limitations` | text | - | What couldn't be accessed: "No loft access", "Floor boxes not lifted" |
| `agreed_with` | text | - | Who agreed to limitations: "Mrs Smith", "The tenant" |
| `operational_limitations` | text | - | Technical issues: "Could not isolate supply" |

## Supply Characteristics Tab (`/job/[id]/supply`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `earthing_arrangement` | select | TN-S, TN-C-S, TT, IT, TN-C | Listen for "PME", "TN-C-S", "earth rod" (TT), "separate earth" (TN-S) |
| `live_conductors` | select | AC - 1-phase (2 wire), AC - 3-phase (4 wire), etc. | Usually "AC - 1-phase (2 wire)" domestic |
| `number_of_supplies` | select | 1, 2, 3, 4, 5, N/A | Usually "1" for domestic |
| `nominal_voltage_u` | select | 230, 400, 110, N/A, Other | 230V single-phase, 400V three-phase |
| `nominal_voltage_uo` | select | 230, 400, 110, N/A, Other | 230V for UK domestic |
| `nominal_frequency` | select | 50, 60, N/A | Always 50Hz in UK |
| `prospective_fault_current` | text | - | Listen for "PFC", "prospective fault current". Format: "2.5" |
| `earth_loop_impedance_ze` | text | - | Listen for "Ze", "external earth". TN-C-S typical <0.35 |
| `supply_polarity_confirmed` | boolean | - | True if origin polarity confirmed correct |
| `spd_bs_en` | text | - | DNO supply cutout fuse standard: "88-2.2", "1361" (NOT the main switch) |
| `spd_type_supply` | text | - | DNO supply cutout fuse type: "gG" (NOT the main switch) |
| `spd_short_circuit` | text | - | Supply cutout breaking capacity kA |
| `spd_rated_current` | text | - | DNO supply cutout fuse rating: "60", "80", "100" (NOT the main switch rating) |

## Board Info Tab (`/job/[id]/board`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `name` | text | - | Board designation: "DB-1", "Main CU" |
| `location` | text | - | Physical location: "Under stairs", "Garage" |
| `manufacturer` | text | - | CU make: "Hager", "MK", "Wylex", "Crabtree", "BG" |
| `phases` | select | 1, 3 | Usually "1" for domestic single-phase |
| `earthing_arrangement` | select | TN-C-S, TN-S, TT | Same as supply - duplicated for board-specific |
| `ze` | text | - | Ze reading at board |
| `zs_at_db` | text | - | Zs reading at board. Should be Ze + R1+R2 |
| `ipf_at_db` | text | - | PFC at board. Domestic typically 1-6kA |

## Circuits Tab (`/job/[id]/circuits`) - All 29 Columns

### Circuit Details Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `circuit_ref` | Sequential numbers: 1, 2, 3... |
| `circuit_designation` | Brief description: "Lights Kitchen", "Sockets Ring", "Cooker" |
| `wiring_type` | Usually "A" for domestic |
| `ref_method` | Usually "A" for domestic |
| `number_of_points` | Count of outlets: 1-12 lighting, 4-8 sockets |
| `live_csa_mm2` | Cable size: 1.0 (lights), 2.5 (sockets), 6.0 (cooker), 10.0 (shower) |
| `cpc_csa_mm2` | Earth size: 1.0, 1.5, 2.5, 4.0 |
| `max_disconnect_time_s` | Usually "0.4" for 230V circuits |

### OCPD Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `ocpd_bs_en` | "60898" (MCB), "61009" (RCBO) |
| `ocpd_type` | "B" domestic, "C" motors |
| `ocpd_rating_a` | 6A lights, 16/20A radial, 32A ring/cooker, 40A shower |
| `ocpd_breaking_capacity_ka` | Usually "6" domestic |
| `ocpd_max_zs_ohm` | Max Zs from BS7671 tables |

### RCD Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `rcd_bs_en` | "61008" (RCCB), "61009" (RCBO) |
| `rcd_type` | "A" most common, "AC" basic |
| `rcd_operating_current_ma` | Usually "30" for additional protection |

### Ring Final Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `ring_r1_ohm` | End-to-end r1 reading. Typical 0.2-0.8 |
| `ring_rn_ohm` | End-to-end rn reading. Similar to r1 |
| `ring_r2_ohm` | End-to-end r2 (CPC). Slightly higher than r1 |

### Continuity Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `r1_r2_ohm` | R1+R2 at furthest point. Typical 0.1-2.0 |
| `r2_ohm` | R2 only reading |

### Insulation Resistance Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `ir_test_voltage_v` | Usually "500" standard, "250" for electronics |
| `ir_live_live_mohm` | L-N reading. Must be >1M. Use ">200" if high |
| `ir_live_earth_mohm` | L-E reading. Must be >1M. Use ">200" if high |

### Test Results Group

| Field | AI Extraction Guidance |
|-------|----------------------|
| `polarity_confirmed` | "OK" or "Y" if passed |
| `measured_zs_ohm` | Zs reading. Typical 0.3-1.5 domestic |
| `rcd_time_ms` | Trip time at 1x. Must be <300ms. Typical 15-30ms |
| `rcd_button_confirmed` | "OK" or "Y" if test button works |
| `afdd_button_confirmed` | "OK" if AFDD fitted and tested |

## Observations Tab (`/job/[id]/observations`)

| Field | Type | Options | AI Extraction Guidance |
|-------|------|---------|----------------------|
| `code` | select | C1, C2, C3, FI | C1=Danger, C2=Potentially dangerous, C3=Improvement, FI=Investigate |
| `item_location` | text | - | Where found: "Kitchen socket", "Consumer unit" |
| `observation_text` | text | - | Clear defect description |
| `schedule_item` | text | - | BS7671 reference: "3.6", "4.4", "5.12.1" |
| `schedule_description` | text | - | Full description from schedule (auto-filled when linked) |
| `photos` | array | - | Array of photo filenames attached to this observation |

**Linked Observations (Phase 7F):**
- Observations can be created directly from the Inspection Schedule tab
- Clicking C1/C2/C3 on a schedule item auto-creates a linked observation
- The `schedule_item` and `schedule_description` are pre-filled
- Changing to tick/N/A deletes the linked observation
- Deleting an observation sets its schedule item back to tick
- Photos can be selected from job photos or uploaded directly

## Inspection Schedule Tab (`/job/[id]/inspection`) - EICR Only

Each schedule item (1.1, 1.2, 3.1, 3.6, 4.4, etc.) gets an outcome:
- **tick** = Inspected and satisfactory
- **N/A** = Not applicable
- **C1** = Danger present
- **C2** = Potentially dangerous
- **C3** = Improvement recommended
- **LIM** = Limitation - unable to inspect

Common items to flag:
- **3.6** - Main bonding conductor sizes (undersized bonding = C2)
- **4.4** - Fire rating of enclosure (non-combustible CU required)
- **4.9** - Circuit identification/labelling
- **5.12.1** - RCD protection for socket outlets 32A or less

## EIC-Only Tabs

**Extent & Type (`/job/[id]/extent`):**

| Field | Type | Options |
|-------|------|---------|
| `extent` | text | What work was done |
| `installation_type` | select | new_installation, addition, alteration |
| `comments` | text | Additional notes |

**Design & Construction (`/job/[id]/design`):**

| Field | Type | Notes |
|-------|------|-------|
| `departures_from_bs7671` | text | Usually "None" |
| `departure_details` | text | Explanation if departures exist |

## Inspector Profile (Home Page Modal)

| Field | Type | Notes |
|-------|------|-------|
| `name` | text | Inspector's full name |
| `organisation` | text | Company name |
| `enrolment_number` | text | NICEIC/NAPIT registration |
| `position` | text | Job title |
| `signature_file` | file | Uploaded signature image |

---

## Circuit CSV Column Mapping

The extraction pipeline (`extract.js`) outputs CSV with these columns, which the editor maps to different names:

| CSV Column (extract.js) | Editor Column (eicr_editor.py) |
|-------------------------|-------------------------------|
| `circuit_ref` | `circuit_ref` (no change) |
| `description` | `circuit_designation` |
| `protective_device` | `ocpd_type` |
| `zs` | `measured_zs_ohm` |
| `ir_500v_mohm` | `ir_live_earth_mohm` |
| `rcd_rating_ma` | `rcd_operating_current_ma` |
| `rcd_trip_times_ms` | `rcd_time_ms` |

This mapping is handled by `map_circuit_columns()` in `eicr_editor.py`.

## Central Field Schema (config/field_schema.json)

The field schema is the single source of truth for all circuit schedule fields. It defines:
- Field names, labels, and types (text, select)
- Options for dropdown fields
- AI guidance for extraction
- Default values and circuit-specific defaults

**All 29 Circuit Schedule Columns (matching PDF output):**

| Group | Fields |
|-------|--------|
| Circuit Details | circuit_ref, circuit_designation, wiring_type, ref_method, number_of_points, live_csa_mm2, cpc_csa_mm2, max_disconnect_time_s |
| OCPD | ocpd_bs_en, ocpd_type, ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm |
| RCD | rcd_bs_en, rcd_type, rcd_operating_current_ma |
| Ring Final | ring_r1_ohm, ring_rn_ohm, ring_r2_ohm |
| Continuity | r1_r2_ohm, r2_ohm |
| Insulation Resistance | ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm |
| Test Results | polarity_confirmed, measured_zs_ohm, rcd_time_ms, rcd_button_confirmed, afdd_button_confirmed |

The schema is loaded by:
- `extract.js` - Builds AI extraction prompts dynamically
- `eicr_editor.py` - Uses `CIRCUIT_TEMPLATE_FIELDS` for UI column configs and defaults

### Circuit Defaults

All 29 circuit fields can have default values set in the Defaults tab. These are saved to `config/user_defaults_{user}.json` and applied when loading new jobs.

---

## Keeping This Documentation in Sync

When you modify the iOS app or backend:

1. **Add a new field to a form?**
   - Add it to `config/field_schema.json` with `ai_guidance`
   - Add it to the relevant table in this document
   - The AI extraction will automatically pick it up

2. **Change dropdown options?**
   - Update the `options` array in field_schema.json
   - Update the iOS app constants/model files
   - Update the table in this document

3. **Remove a field?**
   - Remove from field_schema.json
   - Remove from this document
   - The AI will stop extracting it

4. **Change field name?**
   - Update everywhere: schema, iOS model files, backend API
   - Update the tables in this document
