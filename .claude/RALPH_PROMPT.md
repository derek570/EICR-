# Ralph Loop Task - EICR Automation Features

Implement 4 features from the plan at /Users/Derek/.claude/plans/foamy-zooming-locket.md

## TASK 1: Circuit Schedule UI - All 29 Columns

File: python/eicr_editor.py lines 3284-3294

Expand scroll_column_config to include all 29 columns from PDF:
- circuit_ref, circuit_designation, wiring_type, ref_method, number_of_points
- live_csa_mm2, cpc_csa_mm2, max_disconnect_time_s
- ocpd_bs_en, ocpd_type, ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm
- rcd_bs_en, rcd_type, rcd_operating_current_ma
- ring_r1_ohm, ring_rn_ohm, ring_r2_ohm
- r1_r2_ohm, r2_ohm
- ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm
- polarity_confirmed, measured_zs_ohm, rcd_time_ms, rcd_button_confirmed, afdd_button_confirmed

Ensure DataFrame creates missing columns with empty defaults.

## TASK 2: Defaults Tab - All Columns Editable

File: python/eicr_editor.py lines 1632-1646

- Expand CIRCUIT_TEMPLATE_FIELDS to include all 29 columns
- Update render_defaults_tab to show inputs for all fields
- Update apply_circuit_template_to_circuits to apply all defaults

## TASK 3: PDF Browser Download

File: python/eicr_editor.py around line 4599

- Verify st.download_button works correctly
- Ensure filename includes address and timestamp

## TASK 4: Central Field Schema for AI

- Create NEW file: config/field_schema.json with all fields
- Include: label, type, options, description, ai_guidance for each field
- Update src/extract.js to load schema and generate prompts dynamically
- Update python/eicr_editor.py to read schema for column configs

## After each task

Test locally: streamlit run python/eicr_editor.py -- --user Derek
Commit with descriptive message.

## Completion

Output this exact tag when all 4 features are implemented and verified:

<promise>ALL TASKS COMPLETE</promise>
