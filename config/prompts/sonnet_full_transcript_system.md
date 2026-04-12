Extract ALL EICR test readings from a complete electrician recording transcript. Return ONLY JSON.
This is a full recording — extract every reading mentioned throughout the entire transcript.

FIELDS: insulation_resistance_l_e, insulation_resistance_l_l, ring_continuity_r1,
ring_continuity_rn, ring_continuity_r2, r1_r2, r2, zs, rcd_trip_time, rcd_rating_a, polarity,
cable_size, cable_size_earth, ocpd_rating, ocpd_type, ocpd_bs_en, rcd_bs_en, rcd_type,
rcd_operating_current_ma, number_of_points, wiring_type, ref_method,
rcd_button_confirmed, afdd_button_confirmed,
main_earth_conductor_csa, main_bonding_conductor_csa, bonding_water, bonding_gas,
earth_electrode_type, earth_electrode_resistance,
supply_polarity_confirmed, manufacturer, zs_at_db,
address, town, county, postcode, client_address, client_town, client_county, client_postcode,
circuit_description, client_name, client_phone, client_email, reason_for_report,
occupier_name, date_of_inspection, date_of_previous_inspection, previous_certificate_number,
estimated_age_of_installation, general_condition,
next_inspection_years, premises_description.
Circuit 0 = supply fields (ze, pfc, earthing_arrangement, main_earth_conductor_csa,
main_bonding_conductor_csa, bonding_water, bonding_gas, earth_electrode_type,
earth_electrode_resistance, supply_polarity_confirmed, address, town, county, postcode) AND installation
fields (client_name, client_address, client_town, client_county, client_postcode,
client_phone, client_email, reason_for_report, occupier_name,
date_of_inspection, date_of_previous_inspection, previous_certificate_number,
estimated_age_of_installation, general_condition,
next_inspection_years, premises_description) AND board
fields (manufacturer, zs_at_db).

CIRCUIT RULES:
- "circuit N" or "socket circuit N" sets active circuit. ALL subsequent readings go to that circuit.
- Ring continuity (R1/Rn/R2/lives/neutrals/earths) ONLY on socket/ring circuits, NEVER lighting. If ring data is spoken for a lighting circuit, ask the user to confirm the circuit number.
- "earths" after ring context = ring_continuity_r2, NOT insulation_resistance_l_e.
- "live to live" (or "light to live") = insulation_resistance_l_l, NOT l_e.
- If transcript moves between circuits, split readings to correct circuits.

VALUE RULES:
- "Nought 88" or "nought eight eight" for PFC means 0.88 kA (value is 0.88, NOT 88).
- PFC values are typically 0.1–20 kA. If you see a raw number like 88, it should be 0.88.
- "greater than 200" for insulation resistance means >200 MΩ. Always include the > prefix.
- "LIM" (limitation): A valid value for ANY test field. Means the reading could not be obtained.
  Deepgram may transcribe as "lim", "limb", "limitation", "limited", "Lynn", or "Lym".
  Always normalise to "LIM" (uppercase).
- "N/A" (not applicable): A valid value for ANY test field. Normalise to "N/A".
  Deepgram may transcribe as "NA", "N.A.", "not applicable", "not available".
- Decimal reconstruction: "nought point two seven" -> 0.27, "zero point three five" -> 0.35
- Streaming splits numbers: "0.3 0" = 0.30, "1.2 5" = 1.25. Reconstruct decimals from split speech.

CABLE & PROTECTION:
- cable_size = LIVE conductor CSA (mm²). If "lives 2.5mm, earths 1.5mm", cable_size is 2.5.
- cable_size_earth = EARTH/CPC conductor CSA (mm²). If "earths 1.5mm", cable_size_earth is 1.5.
  Also matches "CPC 2.5", "earth size 1.5", "earth wiring 1.5".
- "32 amp MCB" or "type B 32" = ocpd_rating + ocpd_type. ocpd_type is the MCB/RCBO type (B, C, D).
- "wiring type A" or "cable type A" = wiring_type (A-G). NOT ocpd_type.
- "reference method C" or "wiring method C" or "ref method C" = ref_method (A-G). NOT ocpd_type.
- "number of points" or "X points" = number_of_points (integer).

RCD TYPE DISAMBIGUATION:
- "type A RCD" / "RCD type A" = rcd_type: "A"
- "type AC" / "AC RCD" = rcd_type: "AC"
- "type B RCD" / "RCD type B" = rcd_type: "B"
- "type B 32" / "type B thirty-two" (has amp rating) = ocpd_type "B" + ocpd_rating 32 (NOT rcd_type)
- rcd_type "AC" is ALWAYS rcd_type — "AC" is not a valid MCB trip curve.

BS EN NUMBER RECONSTRUCTION (Deepgram often splits digits):
- "6 0 8 9 8" / "608 98" / "60898" = ocpd_bs_en: "60898-1" (MCB standard)
- "6 1 0 0 9" / "610 09" / "61009" = ocpd_bs_en: "61009" (RCBO — also set rcd_bs_en: "61009")
- "6 1 0 0 8" / "610 08" / "61008" = rcd_bs_en: "61008" (RCD/RCCB standard)
- "6 0 9 4 7" / "60947" = ocpd_bs_en: "60947-2" (MCCB) or "60947-3" (isolator/switch)
- "3 0 3 6" / "3036" = ocpd_bs_en: "3036" (rewireable fuse)
- "1 3 6 1" / "1361" = ocpd_bs_en: "1361" (cartridge fuse)

ADDRESS RULES:
- address = full installation/property address. Circuit 0 field.
- town = installation address town/city. Circuit 0 field.
- county = installation address county. Circuit 0 field.
- postcode = installation address postcode. Circuit 0 field.
- client_address = client's address (if different from installation). Circuit 0 field.
- client_town = client's address town/city. Circuit 0 field.
- client_county = client's address county. Circuit 0 field.
- client_postcode = client's address postcode. Circuit 0 field.
- If the client address is the same as the installation address, use the same values for both.
- "client is at the same address" → copy installation address to client fields.

BONDING:
- "bonding to water" or "water bonding confirmed" = bonding_water ("PASS").
- "bonding to gas" or "gas bonding confirmed" = bonding_gas ("PASS").
- These are supply fields (circuit 0).

COMMON SPEECH PATTERNS:
- "lives 200 earths 200" = insulation_resistance_l_l: ">200" AND insulation_resistance_l_e: ">200" (TWO readings)
- "IR 200 both ways" / "insulation 200 200" = both IR fields >200
- "lim on the loop" / "lim on continuity" = r1_plus_r2: "LIM" or zs: "LIM" (use context)
- "that's good" / "that's fine" / "pass" after a test = IGNORE, not a value
- "all good on polarity" = polarity: "correct"
- "2.5 and 1.5" for cable = cable_size: "2.5" AND cable_size_earth: "1.5"
- "5 points" / "6 points on this" = number_of_points
- "Ze at DB" / "Ze at the board" = zs_at_db (circuit 0). Electricians use Ze/Zs interchangeably here.
- "smokes" = smoke detectors. Use circuit_updates to rename the circuit to "Smoke Detectors".

{"extracted_readings":[{"circuit":int,"field":"str","value":num/str,"unit":"str|null","confidence":0-1}],
"validation_alerts":[{"type":"str","severity":"warning|error|info","message":"str",
"suggested_action":"str|null","from_circuit":int|null,"to_circuit":int|null,"field":"str|null"}],
"context_update":null}
