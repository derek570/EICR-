// extract_session.js
// Extracts structured EICR data from a complete recording session transcript.
// Unlike extract_chunk.js which handles fragments, this sees the full context.
// This is the HEAVY LIFTER — regex on-device does quick snipes, GPT here unpicks messy audio.

import { getAnthropicKey } from './services/secrets.js';

const SONNET_MODEL = (process.env.EXTRACTION_MODEL || 'claude-sonnet-4-6').trim();

const SESSION_PROMPT = `You are an expert EICR (Electrical Installation Condition Report) data extractor.
You will receive a transcript from an electrician's recording session. The transcript comes from
on-device WhisperKit speech recognition on a busy job site — expect these artefacts:

=== TRANSCRIPT ARTEFACTS (handle gracefully) ===
- REPEATED SECTIONS: WhisperKit rewrites earlier text as it gains context. The same sentence
  may appear 2-5 times with slight variations. Extract from the BEST/MOST COMPLETE version.
- HOMOPHONES: "light to earth" = "live to earth" (IR test), "dress" = "address",
  "Earth-In" / "Earthen" = "Earthing", "mil" / "ml" = "mm" (millimetres),
  "mHg" / "m/h" / "Mg/m/s" / "Mg/mV" = "megohms" (insulation resistance unit)
- NOISE MARKERS: Ignore (sighs), (footsteps), (birds chirping), (sniffing), [BLANK_AUDIO]
- BROKEN NUMBERS: "nought point eight seven" = 0.87, "point nine nine" = 0.99
- NUMBER-WORD MIX: "1.66 kiloamps" = 1.66 kA, "greater than 299 mega ohms" = ">299"

=== OUTPUT JSON STRUCTURE ===
{
  "circuits": [{ circuit_ref, circuit_designation, ...test_fields }],
  "observations": [{ code, item_location, observation_text, schedule_item }],
  "board": { manufacturer, name, location, phases, earthing_arrangement, ze, zs_at_db, ipf_at_db },
  "installation": { client_name, address, postcode, premises_description, next_inspection_years,
                     extent, agreed_limitations, agreed_with, operational_limitations },
  "supply_characteristics": {
    earthing_arrangement, earth_loop_impedance_ze, prospective_fault_current,
    live_conductors, nominal_voltage_u, nominal_voltage_uo, nominal_frequency,
    number_of_supplies, supply_polarity_confirmed,
    main_switch_current, main_switch_bs_en, main_switch_poles, main_switch_voltage,
    earthing_conductor_csa, earthing_conductor_material,
    main_bonding_csa, main_bonding_material,
    bonding_water, bonding_gas, bonding_oil, bonding_structural_steel,
    spd_bs_en, spd_type_supply, spd_short_circuit, spd_rated_current
  }
}

=== CIRCUIT FIELDS (use ALL that apply) ===
circuit_ref, circuit_designation, wiring_type, ref_method, number_of_points,
live_csa_mm2, cpc_csa_mm2, max_disconnect_time_s, ocpd_bs_en, ocpd_type,
ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm, rcd_bs_en,
rcd_type, rcd_operating_current_ma, ring_r1_ohm, ring_rn_ohm, ring_r2_ohm,
r1_r2_ohm, r2_ohm, ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm,
polarity_confirmed, measured_zs_ohm, rcd_time_ms, rcd_button_confirmed,
afdd_button_confirmed

=== CRITICAL EXTRACTION RULES ===

1. CIRCUIT OWNERSHIP: Test values belong to the most recently mentioned circuit.
   "Circuit 1, R1+R2 is 0.89. Zs is 0.99" → both values belong to circuit 1.

2. RING CIRCUITS: Circuits with designation containing "socket", "ring", or "continuity"
   are ring final circuits. Their continuity values use ring_r1/rn/r2 fields:
   - "lives are 0.88" → ring_r1_ohm = "0.88"
   - "neutrals are 0.91" → ring_rn_ohm = "0.91"
   - "earths are 1.11" → ring_r2_ohm = "1.11"
   These values belong to the most recently mentioned RING circuit even if a non-ring
   circuit ref appears later in the transcript. Use context to route correctly.

3. ORPHANED VALUES: If test values appear without a circuit ref, route them to the
   most contextually appropriate circuit. Values after ring continuity data (lives/neutrals/earths)
   likely still belong to that ring circuit.

4. INSULATION RESISTANCE:
   - "greater than 200" / "greater than 299" / "infinity" → ">200" or ">299"
   - "live to live" / "L to L" / "L-L" → ir_live_live_mohm
   - "live to earth" / "light to earth" / "L to E" / "L-E" / "L2E" / "L2H" → ir_live_earth_mohm
   - "megohms" / "mega ohms" / "mHg" / "m/h" / "Mg/mV" / "Mg/m/s" all mean MΩ
   - Common pattern: "IR of circuit 1, live to live greater than 299, live to earth greater than 299"
     → ir_live_live_mohm=">299", ir_live_earth_mohm=">299" BOTH for circuit 1
   - When IR is stated as a decimal like "0.99" without "greater than", use the raw value

5. SUPPLY-LEVEL FIELDS (never put these on circuits):
   - Ze / external loop impedance → earth_loop_impedance_ze
   - PFC / PSCC / prospective fault current → prospective_fault_current
   - "PME" = TN-C-S earthing arrangement
   - "main earth is 16mm" → earthing_conductor_csa = "16"
   - "bonding is 10mm" → main_bonding_csa = "10"
   - "bonding to the water and gas" → bonding_water = true, bonding_gas = true

6. DEDUPLICATION: The transcript contains repeated sections from WhisperKit rewrites.
   DO NOT create duplicate circuits. Each unique circuit ref should appear once.
   Use the LAST (most refined) version of any repeated data.

7. OBSERVATIONS: Only extract if the electrician explicitly describes a defect or issue.
   code must be C1 (danger), C2 (potentially dangerous), C3 (improvement), or FI (further investigation).

8. If the user says a value but not which circuit it belongs to, and EXISTING_DATA shows
   circuits with empty fields, match the value to the most likely circuit based on context.

9. RETURN ALL VALUES you extract from the transcript, even for fields shown as populated in
   EXISTING_DATA. The caller handles merge priorities — your job is extraction, not filtering.
`;

export async function extractSession(fullTranscript, existingData = null) {
  const apiKey = await getAnthropicKey();
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  let userContent = `TRANSCRIPT (may be a rolling window or full session):\n\n${fullTranscript}`;

  if (existingData) {
    // Feed existing job data as context — Claude can fill gaps the regex missed
    const contextSummary = buildContextSummary(existingData);
    if (contextSummary) {
      userContent += `\n\n=== EXISTING_DATA (use for circuit routing context — extract ALL values from transcript) ===\n${contextSummary}`;
    }
  }

  const body = {
    model: SONNET_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: SESSION_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  };

  const MAX_RETRIES = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errBody = await res.text();
        if ((res.status === 529 || res.status === 429) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        throw new Error(`Anthropic HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      if (!text) throw new Error('Anthropic returned empty response');

      // Strip markdown code blocks if present
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
      const parsed = JSON.parse(jsonStr);

      return {
        ...parsed,
        circuits: parsed.circuits || [],
        observations: parsed.observations || [],
        board: parsed.board || {},
        installation: parsed.installation || {},
        supply_characteristics: parsed.supply_characteristics || {},
        usage: {
          input_tokens: json.usage?.input_tokens,
          output_tokens: json.usage?.output_tokens,
        },
      };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
    }
  }

  throw lastError;
}

/**
 * Build a concise context summary from existing job data so GPT knows
 * what's already populated and what gaps to fill.
 */
function buildContextSummary(data) {
  const parts = [];

  // Circuits: show ref, designation, and which test fields are empty
  const circuits = data.circuits || [];
  if (circuits.length > 0) {
    const circuitLines = circuits.map((c) => {
      const testFields = [
        'measured_zs_ohm',
        'r1_r2_ohm',
        'ring_r1_ohm',
        'ring_rn_ohm',
        'ring_r2_ohm',
        'ir_live_live_mohm',
        'ir_live_earth_mohm',
        'rcd_time_ms',
        'polarity_confirmed',
      ];
      const empty = testFields.filter((f) => !c[f]);
      const filled = testFields.filter((f) => c[f]).map((f) => `${f}=${c[f]}`);
      const isRing = /\b(socket|ring|continuity)\b/i.test(c.circuit_designation || '');
      return `  Circuit ${c.circuit_ref || '?'} "${c.circuit_designation || ''}"${isRing ? ' [RING]' : ''}: filled=[${filled.join(', ')}] empty=[${empty.join(', ')}]`;
    });
    parts.push(`CIRCUITS (${circuits.length} total):\n${circuitLines.join('\n')}`);
  }

  // Supply: show what's filled
  const supply = data.supply_characteristics || data.supply || {};
  if (Object.keys(supply).length > 0) {
    const filled = Object.entries(supply)
      .filter(([, v]) => v && v !== 'N/A')
      .map(([k, v]) => `${k}=${v}`);
    const empty = [
      'earthing_conductor_csa',
      'main_bonding_csa',
      'bonding_water',
      'bonding_gas',
    ].filter((k) => !supply[k]);
    parts.push(`SUPPLY: filled=[${filled.join(', ')}] empty=[${empty.join(', ')}]`);
  }

  // Installation
  const install = data.installation_details || data.installation || {};
  if (Object.keys(install).length > 0) {
    const filled = Object.entries(install)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`);
    parts.push(`INSTALLATION: [${filled.join(', ')}]`);
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}
