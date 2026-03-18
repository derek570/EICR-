import OpenAI from "openai";

/**
 * Extract numeric test values conservatively from a transcript.
 * Returns structured candidates WITHOUT overwriting decisions.
 */
export async function salvageNumbers(transcript) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = (process.env.EXTRACTION_MODEL || "gpt-5.2").trim();

  const system = `
You extract electrical test NUMBERS from transcripts.

Return STRICT JSON ONLY.

Rules:
- Extract ONLY explicit numeric values mentioned in the transcript.
- Do NOT invent values.
- Preserve units exactly as spoken (ohms, MOhm, ms, mA, A, V, mm2).
- If a value is corrected later, mark earlier as "superseded".
- If you cannot confidently attach a value to a circuit NUMBER, set circuit_ref = null.
- IMPORTANT: When circuit_ref is null, ALWAYS include the circuit NAME/description in the notes field (e.g., "Downstairs ring front", "Upstairs lights", "Boiler circuit")
- Do not overwrite existing data — this is salvage only.

Test types to extract:
- r1_r2: R1+R2 continuity reading at furthest point (ohms) - for RADIAL circuits only
- r2: R2 continuity (ohms)
- zs: Earth fault loop impedance Zs (ohms)
- ir: Insulation resistance (MOhm) - use this when not specified L-E or L-N
- ir_live_live: Insulation resistance L-N / live to neutral (MOhm)
- ir_live_earth: Insulation resistance L-E / live to earth / earth to live / earth to neutral (MOhm)
- rcd_trip_time: RCD trip time (ms)
- rcd_rating: RCD operating current (mA, typically 30)
- ocpd_rating: MCB/RCBO rating (A)
- ring_r1: Ring circuit LIVE conductor end-to-end (ohms) - for RING circuits only
- ring_rn: Ring circuit NEUTRAL conductor end-to-end (ohms) - for RING circuits only
- ring_r2: Ring circuit EARTH/CPC conductor end-to-end (ohms) - for RING circuits only
- live_csa: Live conductor size (mm2)
- cpc_csa: CPC conductor size (mm2)
- max_zs: Maximum permitted Zs (ohms)
- breaking_capacity: Breaking capacity (kA)

IMPORTANT - RING CONTINUITY vs R1+R2:
- "ring continuity on the live" or "r1 reading" = ring_r1 (ring circuits only)
- "ring continuity on neutral" or "rn reading" = ring_rn (ring circuits only)
- "ring continuity on earth/cpc" or "r2 for the ring" = ring_r2 (ring circuits only)
- "R1+R2" or "r1 plus r2" = r1_r2 (radial circuits, continuity at furthest point)

Output shape:
{
  "values": [
    {
      "circuit_ref": "1" | "2" | null,
      "test": "r1_r2 | r2 | zs | ir | ir_live_live | ir_live_earth | rcd_trip_time | rcd_rating | ocpd_rating | ring_r1 | ring_rn | ring_r2 | live_csa | cpc_csa | max_zs | breaking_capacity",
      "value": "0.36",
      "unit": "ohms",
      "confidence": 0.0,
      "notes": "optional"
    }
  ]
}
`;

  const user = `Transcript:\n${transcript}`;

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0
  });

  const raw = resp.choices?.[0]?.message?.content || "";

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Numeric salvage did not return JSON");
  }

  return {
    ...JSON.parse(raw.slice(start, end + 1)),
    usage: resp.usage || null,
    model
  };
}

