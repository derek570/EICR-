Return STRICT JSON ONLY (no markdown, no prose).
Shape:
{
  "installation_details": {
    "address": "Full address of the property being tested",
    "client_name": "Client/customer name if mentioned",
    "postcode": "Postcode if mentioned (UK format)",
    "premises_description": "Residential|Commercial|Industrial|Agricultural|Other",
    "installation_records_available": false,
    "evidence_of_additions_alterations": false,
    "next_inspection_years": 5,
    "extent": "Description of what was covered (e.g., Whole installation)",
    "agreed_limitations": "Any limitations agreed (e.g., No loft access)",
    "agreed_with": "Name of person who agreed to limitations",
    "operational_limitations": "Technical limitations encountered"
  },
  "supply_characteristics": {
    "earthing_arrangement": "TN-C-S|TN-S|TT|IT|TN-C",
    "live_conductors": "AC - 1-phase (2 wire)",
    "number_of_supplies": "1",
    "nominal_voltage_u": "230",
    "nominal_voltage_uo": "230",
    "nominal_frequency": "50",
    "prospective_fault_current": "PFC in kA (e.g., 2.5)",
    "earth_loop_impedance_ze": "Ze in ohms (e.g., 0.35)",
    "supply_polarity_confirmed": false,
    "spd_bs_en": "Main fuse standard",
    "spd_type_supply": "Main fuse type",
    "spd_short_circuit": "Breaking capacity kA",
    "spd_rated_current": "Main fuse rating A"
  },
  "board": {
    "name": "DB-1",
    "location": "",
    "manufacturer": "",
    "supplied_from": "",
    "phases": "1",
    "earthing_arrangement": "TN-C-S",
    "ze": "",
    "zs_at_db": "",
    "ipf_at_db": "",
    "rcd_trip_time": "N/A",
    "main_switch_bs_en": "60947-3",
    "main_switch_poles": "2",
    "voltage_rating": "230",
    "rated_current": "100",
    "ipf_rating": "N/A",
    "rcd_rating": "N/A",
    "tails_material": "Cu",
    "tails_csa": "25",
    "earthing_conductor_material": "Cu",
    "earthing_conductor_csa": "16",
    "bonding_conductor_material": "Cu",
    "bonding_conductor_csa": "10",
    "spd_type": "",
    "spd_status": "",
    "notes": "",
    "extent": "",
    "agreed_limitations": "",
    "agreed_with": "",
    "operational_limitations": ""
  },
  "rows": [ { {{HEADERS_PLACEHOLDER}} } ],
  "observations": [
    {
      "title": "short location/item",
      "text": "Thorough description of the fault ONLY - DO NOT suggest fixes or remedial action",
      "regulation": "544.1.1",
      "regs": ["BS 7671 reg reference"],
      "code": "C1|C2|C3|FI",
      "schedule_item": "3.6",
      "confidence": 0.0,
      "source_photo": "IMG_1234.jpg or null if from audio"
    }
  ],
  "missing": [
    { "item": "what is missing", "reason": "why" }
  ]
}

=== CABLE SIZE DEFAULTS (use these unless transcript specifies otherwise) ===
- Lighting circuits: live_csa_mm2="1.0", cpc_csa_mm2="1.0", typically 6A breaker
- Radial socket circuits (16A or 20A): live_csa_mm2="2.5", cpc_csa_mm2="1.5"
- Ring final circuits (32A sockets): live_csa_mm2="2.5", cpc_csa_mm2="1.5"
- Cooker/oven/hob circuits: live_csa_mm2="6.0", cpc_csa_mm2="2.5", typically 32A breaker
- Shower circuits: live_csa_mm2="10.0", cpc_csa_mm2="4.0", typically 40A or 45A breaker
- Immersion heater: live_csa_mm2="2.5", cpc_csa_mm2="1.5", typically 16A breaker

=== EARTHING & BONDING VALUES (extract from transcript if mentioned) ===
Listen for mentions of:
- Earthing arrangement: TN-C-S (PME), TN-S, TT - set in "earthing_arrangement"
- Ze (external earth fault loop impedance): e.g. "Ze is 0.2 ohms" - set in "ze"
- Zs at DB (earth fault loop impedance at distribution board): e.g. "Zs at the board is 0.25 ohms" - set in "zs_at_db"
- Meter tails size: e.g. "25mm tails", "16mm squared tails" - set in "tails_csa"
- Earthing conductor size: e.g. "16mm earth", "10mm earthing conductor" - set in "earthing_conductor_csa"
- Main bonding size: e.g. "10mm bonding", "6mm bonds" - set in "bonding_conductor_csa"
- Main switch poles: "double pole", "2 pole", "DP" = "2"

Common defaults if not mentioned:
- tails_csa: "25" (for 100A supply)
- earthing_conductor_csa: "16" (for TN-C-S with 100A)
- bonding_conductor_csa: "10" (for TN-C-S with 100A)
- earthing_arrangement: "TN-C-S" (most common domestic)
- main_switch_poles: "2"
- zs_at_db: same as Ze unless explicitly stated differently (copy Ze value to zs_at_db if Zs at DB not mentioned)

=== EXTENT AND LIMITATIONS (extract from transcript if mentioned) ===
Listen for mentions of:
- Extent of installation: e.g. "covering the whole property", "main consumer unit only", "excluding outbuildings" - set in "extent"
- Agreed limitations: e.g. "no access to loft", "couldn't lift floors", "tenant refused access to bedroom" - set in "agreed_limitations"
- Agreed with: e.g. "agreed with the tenant", "agreed with Mrs Smith", "agreed with the landlord" - set in "agreed_with"
- Operational limitations: e.g. "isolators not accessible", "couldn't isolate circuits", "supply couldn't be turned off" - set in "operational_limitations"

Leave these fields empty if not specifically mentioned - defaults will be used.

=== INSPECTION SCHEDULE ITEMS (link observations to these) ===
Section 1 - Intake equipment:
- 1.1: Service cable, service head, earthing arrangement, meter tails
- 1.2: Consumer's isolator
- 1.3: Consumer's meter tails

Section 3 - Earthing/bonding:
- 3.1: Distributor's earthing arrangements
- 3.2: Earth electrode connection
- 3.3: Earthing/bonding labels
- 3.4: Earthing conductor size
- 3.5: Earthing conductor at MET
- 3.6: Main protective bonding conductor sizes (undersized bonding = C2)
- 3.7: Main protective bonding connections
- 3.8: Other protective bonding connections

Section 4 - Consumer unit/distribution board:
- 4.1: Working space/accessibility
- 4.3: IP rating of enclosure
- 4.4: Fire rating of enclosure (non-combustible = amendment requirement)
- 4.5: Enclosure condition
- 4.9: Circuit identification/labelling
- 4.10: RCD test notice
- 4.17: RCDs for fault protection
- 4.18: RCDs for additional protection
- 4.19: SPD functional indication
- 4.20: Conductor connections secure

Section 5 - Final circuits:
- 5.1: Conductor identification
- 5.3: Condition of insulation
- 5.6: Coordination between conductors and protective devices
- 5.8: Circuit protective conductors
- 5.12.1: RCD protection for sockets 32A or less
- 5.18: Condition of accessories

Section 6 - Special locations:
- 6.1: Additional protection by RCD (bathrooms)
- 6.4: Supplementary bonding conductors

=== FIELD GUIDANCE FOR CIRCUIT ROWS ===
- circuit_ref: Circuit number (1, 2, 3...)
- circuit_designation: Description (e.g., "Lights Kitchen", "Sockets Ring")
- number_of_points: Number of points/outlets served
- wiring_type: Installation reference method - always use "A" (enclosed in conduit in thermally insulating wall)
- ref_method: Installation reference method - always use "A" (same as wiring_type)
- live_csa_mm2: Live conductor CSA - USE DEFAULTS ABOVE based on circuit type
- cpc_csa_mm2: CPC conductor CSA - USE DEFAULTS ABOVE based on circuit type
- max_disconnect_time_s: Usually "0.4" for 230V circuits
- ocpd_bs_en: "60898" for MCBs, "61009" for RCBOs
- ocpd_type: B, C, or D curve (usually "B" for domestic)
- ocpd_rating_a: MCB/RCBO rating in amps (6, 10, 16, 20, 32, 40...)
- ocpd_breaking_capacity_ka: Usually "6"
- ocpd_max_zs_ohm: Maximum permitted Zs for that device
- rcd_bs_en: "61008" for RCCBs, "61009" for RCBOs
- rcd_type: "A" or "AC" (usually "A" for modern installations)
- rcd_operating_current_ma: Usually "30"
- rcd_rating_a: Same as OCPD rating for RCBOs
- ring_r1_ohm, ring_rn_ohm, ring_r2_ohm: Ring final circuit end-to-end readings
- r1_r2_ohm: R1+R2 continuity value
- r2_ohm: R2 value if measured separately
- ir_test_voltage_v: "500" (standard) or "250" (for electronic equipment)
- ir_live_live_mohm: L-L or L-N insulation resistance - map "live to neutral" here (use ">200" or ">999" for high values)
- ir_live_earth_mohm: L-E insulation resistance - map "live to earth" OR "earth to live" OR "earth to neutral" here (same test, use ">200" or ">999" for high values)

=== CRITICAL: INSULATION RESISTANCE MAPPING ===
Electricians say IR values in various ways. Map them to these TWO fields:
- ir_live_live_mohm = L-N (live to neutral) - the reading between line and neutral conductors
- ir_live_earth_mohm = L-E (live to earth) - ALSO called "earth to live" or "earth to neutral" in speech
When the electrician says "earth to live" or "earth to neutral", put that value in ir_live_earth_mohm.
When the electrician says "live to neutral" put that value in ir_live_live_mohm.
High values like "over 200", "over 300", ">200" megohms should be written as ">200" or ">300".
If the reading is "limitation" or "limited", leave the field empty (it will be marked as LIM).
ALWAYS include the unit - values should be in megohms (MΩ)
- polarity_confirmed: "true" if polarity test passed
- measured_zs_ohm: Measured earth fault loop impedance
- rcd_time_ms: RCD trip time in ms (should be <300ms at 1x, <40ms at 5x)
- rcd_button_confirmed: "true" if test button works
- afdd_button_confirmed: "N/A" if no AFDD present

=== CRITICAL: CIRCUIT EXTRACTION FROM PHOTOS ===
The PHOTO ANALYSIS section is the PRIMARY source for the circuit list. You MUST:
1. FIRST: Extract ALL circuits visible in consumer unit photos (breaker ratings, labels, positions)
2. THEN: Match test values from the transcript to those circuits
3. Include circuits even if they have NO test values in the transcript - leave test fields blank

Example: If photo shows 9 circuits but transcript only mentions 5, you MUST create 9 rows in the CSV.
- Circuits with test data: Fill in the values from transcript
- Circuits without test data: Include them with breaker info from photo, leave test columns blank

The circuit_ref should match the POSITION shown in the photo (e.g., if photo shows circuit at position 4, use circuit_ref=4).
DO NOT skip circuits just because the electrician didn't test them or mention them in audio.

=== RULES ===
- Extract board details from PHOTO ANALYSIS section (manufacturer, SPD status, etc.)
- rows keys MUST match the headers exactly.
- Apply cable size defaults based on circuit type unless transcript specifies different sizes.
- For ring final circuits, include r1, rn, r2 values. For radials, just r1_r2_ohm.
- If insulation resistance is very high, use ">200" or ">999".

=== CRITICAL: STANDALONE NUMERIC VALUES AFTER CIRCUIT DEFINITIONS ===
Electricians often state test readings immediately after defining a circuit WITHOUT a field prefix.
A standalone float value (typically 0.01-10.0) appearing right after a circuit description
(e.g., "lighting number of points is 18 ... 0.77") should be treated as the measured_zs_ohm
(Earth Loop Impedance Zs) for that circuit, because Zs is the most commonly spoken standalone test value.

Examples:
- "lighting number of points is 18 [BLANK_AUDIO] 0.77" -> measured_zs_ohm = "0.77" for the lighting circuit
- "sockets ring 32 amp ... 0.45" -> measured_zs_ohm = "0.45" for the sockets circuit
- "cooker 6mm squared 32 amp B type 1.2" -> measured_zs_ohm = "1.2" for the cooker circuit

If a value is repeated (e.g., "0.77 [BLANK_AUDIO] 0.77"), treat it as one value -- the electrician
said it twice for clarity. Assign it to the most recently mentioned circuit's measured_zs_ohm.

This rule ONLY applies when no field name is given. If the electrician says "R1+R2 is 0.77",
that goes in r1_r2_ohm instead.

=== CRITICAL: Ring vs Radial Continuity Values ===
- "R1 is 1, R2 is 2" for a RING circuit -> ring_r1_ohm=1, ring_r2_ohm=2
- "R1+R2 is 0.5" for a RADIAL circuit -> r1_r2_ohm=0.5
- Separate R1/R2 values = ring continuity; combined R1+R2 = radial continuity
- Do NOT create observations for "observation of..." - require "the observation is..." or clear defect description
- Set polarity_confirmed and rcd_button_confirmed to "true" if tests passed.
- Link observations to schedule_item codes (e.g., "3.6" for bonding issues, "4.4" for non-fire-rated CU).
- If unsure of a value, leave blank and add to missing array.
- Keep observations concise and auditable with BS 7671 regulation references.

=== CRITICAL: CROSS-REFERENCE MULTIPLE PHOTOS ===
When there are multiple photos in the PHOTO ANALYSIS section:
- ALWAYS cross-reference information across ALL photos before generating observations
- If a wide shot shows something unclear, CHECK if a close-up photo shows it more clearly
- If one photo says "unclear" or "not visible", check if another photo shows that detail
- DO NOT generate observations about missing labels/markings if ANY photo shows them clearly
- Combine information from all photos - close-up photos override wide shots for detail
- Only generate observations when you are CERTAIN after reviewing ALL available evidence

=== PHOTO-TO-OBSERVATION LINKING (CRITICAL - ALWAYS SET source_photo) ===
For EVERY observation, you MUST set source_photo:

RULE 1: If the observation is about something VISIBLE in a photo (defect, missing label, condition issue):
  - Set source_photo to the EXACT filename from the photo analysis header
  - Example: If you saw it in "=== Photo 2: IMG_4570.jpg ===" then set "source_photo": "IMG_4570.jpg"
  - DO NOT omit this - it's required for the photo to appear in the report

RULE 2: If the observation is from AUDIO transcript only (e.g., "no bonding to gas meter"):
  - Set "source_photo": null

RULE 3: If the observation could apply to multiple photos (e.g., general CU condition):
  - Choose the BEST photo - the one that most clearly shows the issue
  - If one photo shows a close-up of the defect, use that one
  - If a wide shot shows the overall issue better, use that one

HOW TO FIND THE FILENAME:
- The PHOTO ANALYSIS section has headers like "=== Photo 1: IMG_4569.jpg ==="
- Extract the filename EXACTLY (including .jpg extension)
- Common patterns: IMG_1234.jpg, photo_001.jpg, 20260126_123456.jpg

=== TIMESTAMP-BASED PHOTO MATCHING ===
The transcript may include timestamps like [MM:SS] and a PHOTO CAPTURE TIMES section.
Use these to correlate audio observations with photos:

=== SYNCHRONIZED CAPTURE (HIGHLY ACCURATE - audio-relative timestamps) ===
If you see "SYNCHRONIZED PHOTO CAPTURE TIMES", photos were taken DURING the audio recording.
The timestamps show EXACTLY when each photo was taken relative to the audio:
- "Photo 1 (IMG_001.jpg): taken at 00:45 in the audio recording"
- "Photo 2 (IMG_002.jpg): taken at 01:30 in the audio recording"

HOW TO MATCH (synchronized capture):
1. Look at the audio timestamp in the transcript, e.g., "[01:25] the cable entry is damaged"
2. Find the photo taken CLOSEST to that time: Photo 2 at 01:30 is only 5 seconds later
3. Set source_photo to "IMG_002.jpg"
4. The photo taken RIGHT AFTER an audio mention usually shows what was being discussed

Rule: If electrician says something at [XX:XX] and a photo was taken within 30 seconds, USE THAT PHOTO.

=== EXIF-BASED CAPTURE (less accurate - clock timestamps) ===
If you see "PHOTO CAPTURE TIMES (from EXIF data)", photos have absolute clock times:
- "Photo 1 (IMG_4569.jpg): captured at 14:35:20"

For EXIF-based matching, correlate based on sequence and context since we don't know exact audio timing.

=== GENERAL RULES FOR BOTH ===
1. If the transcript says "[02:15] Taking a photo of the damaged screw now"
   - Look at PHOTO CAPTURE TIMES to find which photo was captured around that time
   - Match the audio timestamp to the closest photo capture time

2. If the transcript mentions "first photo", "second photo", etc.
   - The photos are numbered in chronological order (earliest first)
   - "First photo" = Photo 1, "second photo" = Photo 2, etc.

3. For observations mentioned at specific audio timestamps:
   - Find the photo captured closest to that moment
   - Set source_photo to that photo's filename

=== CONVERT PHOTO DEFECTS TO OBSERVATIONS (MUST SET source_photo) ===
When the PHOTO ANALYSIS section identifies defects or issues, you MUST:
1. Create an observation for each defect
2. Set source_photo to the EXACT filename of the photo that shows it

Defect -> Observation mapping (ALWAYS include the source_photo from that photo):
- "Open/unfinished cable entry" -> C3 observation (schedule_item: "4.3", regs: "522.8.1")
- "Missing grommet/gland" -> C3 observation (schedule_item: "4.3")
- "Damaged/chewed screw heads" -> C3 observation (schedule_item: "4.5")
- "Untidy finish around enclosure" -> C3 observation (schedule_item: "4.1")
- "Scorching/burn marks" -> C2 observation (schedule_item: "4.5")
- "No RCD protection visible" -> C2 observation IF required (schedule_item: "5.12.1")
- "Labels missing/unclear" -> C3 observation (schedule_item: "4.9")
- "IP rating compromised" -> C3 observation (schedule_item: "4.3")

Example: If "=== Photo 2: IMG_4570.jpg ===" shows "open cable entry", create:
{
  "title": "Consumer unit",
  "text": "Open cable entry observed at top of consumer unit enclosure",
  "code": "C3",
  "schedule_item": "4.3",
  "regs": ["522.8.1"],
  "confidence": 0.9,
  "source_photo": "IMG_4570.jpg"
}

DO NOT ignore defects just because the photo analysis says they are "aesthetic" or "minor".
If a photo shows ANY installation issue, create an observation with the appropriate code.

=== OBSERVATIONS QUALITY RULES ===
- Only include observations with confidence >= 0.6
- DO NOT assume something is missing just because one photo doesn't show it clearly
- If the audio transcript mentions something exists (e.g., "all circuits are labelled"), trust it over unclear photos
- Be CONSERVATIVE - it's better to miss an observation than to include a false one
- For "unlabelled circuit" observations: ONLY include if NO photo shows the label AND the transcript doesn't mention it

=== OBSERVATION CONTENT RULES (CRITICAL) ===
DO NOT suggest fixes or remedial actions in observations. ONLY describe the fault.

WRONG (includes fix suggestion):
"Cable not clipped. Recommend installing clips at 300mm intervals."
"Missing earth bond. Install 10mm bonding conductor."
"RCD not functioning. Replace RCD."

RIGHT (describes fault only):
"Cable lacks adequate support along its entire run, with sections unsecured and hanging loosely."
"Main protective bonding conductor absent from gas installation pipework at point of entry."
"RCD failed to trip within required time when tested at rated residual operating current."

For each observation, thoroughly explain:
- WHAT exactly is wrong
- WHERE it is located
- WHY it's a problem (safety implication)
- SEVERITY/extent of the issue

=== REGULATION FIELD (REQUIRED) ===
Every observation MUST include a "regulation" field with the specific BS7671 regulation it contravenes.

Common regulation references:
| Issue | Regulation |
|-------|------------|
| Missing main bonding | 544.1.1 |
| Undersized bonding conductor | 544.1.1, Table 54.8 |
| No RCD protection (sockets <=32A) | 411.3.3 |
| No RCD protection (bathrooms) | 701.411.3.3 |
| Lack of supplementary bonding | 415.2 |
| Cable not adequately supported | 522.8.5 |
| Incorrect IP rating | 416.2 |
| No mechanical protection | 522.6 |
| Missing circuit identification | 514.8.1 |
| Enclosure not IP4X or better | 421.1.201 |
| RCD not tested | 514.12.2 |
| Inadequate working space | 132.12 |
| Non-fire-rated consumer unit | 421.1.201 |
| Damaged insulation | 416.1 |
| Incorrect polarity | 612.6 |
| Missing earthing labels | 514.13.1 |
| Ring circuit too long/oversized | 433.1.1, 523.1 |
| Zs exceeds maximum for device | 411.4.4 |

=== CRITICAL: VERBAL OBSERVATIONS FROM ELECTRICIAN ===
The electrician may verbally flag issues during testing. You MUST create observations when they say:

TRIGGER PHRASES (create observation when you hear these):
- "it's a fail" / "fail on the report" / "that's a fail"
- "observation" / "that's an observation"
- "too big" / "too long" / "too high" / "exceeds" / "over the limit"
- "not acceptable" / "out of spec" / "doesn't comply"
- "needs replacing" / "needs attention" / "needs work"
- "dangerous" / "potentially dangerous" / "safety issue"

COMMON VERBAL OBSERVATIONS TO CATCH:

1. Ring circuit too long/oversized:
   - Electrician says: "ring is too big", "ring is huge", "over 0.7 ohms", "exceeds 100 meters"
   - Create observation: Ring final circuit exceeds recommended maximum length. Measured resistance of [X] ohms indicates circuit length exceeds 100m limit (max 0.7ohm for 2.5mm2 T&E).
   - Code: C3 (or C2 if severely oversized)
   - Regulation: 433.1.1, 523.1
   - Schedule item: 5.6

2. Zs exceeds maximum permitted:
   - Electrician says: "Zs too high", "won't disconnect in time", "over the max Zs"
   - Create observation: Earth fault loop impedance (Zs) of [X]ohm exceeds maximum permitted value of [Y]ohm for the protective device, compromising disconnection time.
   - Code: C2
   - Regulation: 411.4.4
   - Schedule item: 5.6

3. Insulation resistance low:
   - Electrician says: "IR is low", "insulation failing", "below 1 megohm"
   - Create observation: Insulation resistance of [X] Mohm is below minimum acceptable value, indicating insulation deterioration.
   - Code: C2 (if <1Mohm) or C3 (if marginal)
   - Regulation: 643.3.2
   - Schedule item: 5.3

4. Missing test/unable to test:
   - Electrician says: "couldn't test", "no access", "limitation"
   - Add to "missing" array with reason, OR create FI observation if safety-critical

IMPORTANT: When the electrician explicitly states something "is a fail" or "goes on the report",
you MUST create an observation for it. Do not ignore verbal observations just because
they don't match photo defects. Audio observations are equally valid.