/**
 * Gemini audio extraction for EICR chunked recording mode.
 *
 * Receives audio (base64 FLAC/WAV) + context text from iOS,
 * sends to Gemini 2.5 Flash for combined transcription + structured extraction.
 *
 * Returns: { transcript, circuits, supply, installation, board, orphaned_values, usage }
 */

import { getGeminiKey } from "./services/secrets.js";
import logger from "./logger.js";

const GEMINI_MODEL = (process.env.GEMINI_EXTRACT_MODEL || "gemini-2.5-flash").trim();
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ── System prompt (ported from GeminiTranscriptTest EICRSystemPrompt) ──

const SYSTEM_PROMPT = `You may receive 1 or 2 audio segments. If 2, the FIRST is context from the previous chunk — use it to understand continuity (e.g. if current audio starts mid-sentence). Only extract NEW data from the LAST audio segment. Do NOT re-extract data from the context audio.

You will receive audio from an electrician on site. First transcribe the audio verbatim, then extract structured EICR data.

You are an expert EICR (Electrical Installation Condition Report) data extractor.

=== TRANSCRIPT ARTEFACTS (handle gracefully) ===
- REPEATED SECTIONS: The same sentence may appear 2-5 times with slight variations. Extract from the BEST/MOST COMPLETE version.
- HOMOPHONES: "light to earth" = "live to earth" (IR test), "dress" = "address",
  "Earth-In" / "Earthen" = "Earthing", "mil" / "ml" = "mm" (millimetres),
  "mHg" / "m/h" / "Mg/m/s" / "Mg/mV" = "megohms" (insulation resistance unit)
- NOISE MARKERS: Ignore (sighs), (footsteps), (birds chirping), (sniffing), [BLANK_AUDIO]
- BROKEN NUMBERS: "nought point eight seven" = 0.87, "point nine nine" = 0.99
- NUMBER-WORD MIX: "1.66 kiloamps" = 1.66 kA, "greater than 299 mega ohms" = ">299"

=== OUTPUT JSON STRUCTURE ===
{
  "transcript": "verbatim transcription of the audio",
  "circuits": [{ "circuit_ref": "1", "circuit_designation": "Sockets", ...test_fields }],
  "supply": {
    "earthing_arrangement": "", "earth_loop_impedance_ze": "", "prospective_fault_current": "",
    "live_conductors": "", "nominal_voltage_u": "", "nominal_frequency": "",
    "supply_polarity_confirmed": "", "main_switch_current": "", "main_switch_bs_en": "",
    "main_switch_poles": "", "earthing_conductor_csa": "", "main_bonding_csa": "",
    "bonding_water": "", "bonding_gas": ""
  },
  "installation": { "client_name": "", "address": "", "postcode": "", "premises_description": "" },
  "board": { "manufacturer": "", "location": "", "zs_at_db": "", "ipf_at_db": "" },
  "orphaned_values": [{ "field": "", "value": "", "context": "" }]
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

3. ORPHANED VALUES: If test values appear without a circuit ref, return them in
   orphaned_values with context so the next call can resolve them.

4. INSULATION RESISTANCE:
   - "greater than 200" / "greater than 299" / "infinity" → ">200" or ">299"
   - "live to live" / "L to L" / "L-L" → ir_live_live_mohm
   - "live to earth" / "light to earth" / "L to E" / "L-E" → ir_live_earth_mohm
   - "megohms" / "mega ohms" / "mHg" / "m/h" / "Mg/mV" all mean MΩ

5. SUPPLY-LEVEL FIELDS (never put these on circuits):
   - Ze / external loop impedance → earth_loop_impedance_ze
   - PFC / PSCC / prospective fault current → prospective_fault_current
   - "PME" = TN-C-S earthing arrangement

6. DEDUPLICATION: DO NOT create duplicate circuits. Each unique circuit ref appears once.
   Use the LAST (most refined) version of any repeated data.

7. OBSERVATIONS: Only extract if explicitly described. code: C1/C2/C3/FI.

8. Match orphaned values to most likely circuit based on context.

9. RETURN ALL VALUES — the caller handles merge priorities.`;

/**
 * Call Gemini with audio + context and return structured extraction.
 *
 * @param {string} audioBase64 - Base64-encoded audio data
 * @param {string} audioMimeType - MIME type (audio/flac, audio/wav, etc.)
 * @param {string} contextText - Filled fields + orphans context
 * @param {string|null} previousAudioBase64 - Base64-encoded previous chunk audio (for continuity)
 * @param {string|null} previousAudioMimeType - MIME type of previous chunk audio
 * @returns {Promise<Object>} { transcript, circuits, supply, installation, board, orphaned_values, usage }
 */
export async function geminiExtract(audioBase64, audioMimeType, contextText, previousAudioBase64 = null, previousAudioMimeType = null) {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = [];
  if (previousAudioBase64 && previousAudioMimeType) {
    parts.push({ inlineData: { mimeType: previousAudioMimeType, data: previousAudioBase64 } });
  }
  parts.push({ inlineData: { mimeType: audioMimeType, data: audioBase64 } });
  parts.push({ text: contextText || "No previous context." });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errBody = await res.text();
        // 429 (rate limit) and 503 (overloaded) are retryable
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn("Gemini extract retryable error", { status: res.status, attempt, delay });
          await sleep(delay);
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text)
        ?.filter(Boolean)
        ?.join("\n")
        ?.trim();

      if (!text) throw new Error("Gemini returned empty response");

      const inputTokens = json?.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;

      // Parse the JSON response
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 200)}`);
      }

      // Calculate cost (model-aware pricing)
      const isFlash = GEMINI_MODEL.includes("flash");
      const inputRate = isFlash ? 0.15 : 1.25;
      const outputRate = isFlash ? 0.60 : 10.00;
      const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;

      logger.info("Gemini extract success", {
        model: GEMINI_MODEL,
        attempt,
        latencyMs,
        inputTokens,
        outputTokens,
        cost: cost.toFixed(6),
        transcriptLen: parsed.transcript?.length ?? 0,
        circuits: parsed.circuits?.length ?? 0,
        orphans: parsed.orphaned_values?.length ?? 0,
        hasPreviousAudio: !!previousAudioBase64,
      });

      return {
        transcript: parsed.transcript || "",
        circuits: parsed.circuits || [],
        supply: parsed.supply || {},
        installation: parsed.installation || {},
        board: parsed.board || {},
        orphaned_values: parsed.orphaned_values || [],
        usage: { inputTokens, outputTokens, cost: parseFloat(cost.toFixed(6)), latencyMs },
      };

    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && (err.name === "TimeoutError" || err.name === "AbortError")) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn("Gemini extract timeout, retrying", { attempt, delay });
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}

// ── Text-based extraction (for Deepgram+Gemini hybrid pipeline) ──

const GEMINI_TEXT_MODEL = (process.env.GEMINI_EXTRACT_TEXT_MODEL || "gemini-2.5-pro").trim();

const TEXT_SYSTEM_PROMPT = `You are an expert EICR (Electrical Installation Condition Report) data extractor.

You will receive a TRANSCRIPT from an electrician on site (already transcribed by Deepgram).
Extract structured EICR data from the transcript text.

=== TRANSCRIPT ARTEFACTS (handle gracefully) ===
- REPEATED SECTIONS: The same sentence may appear 2-5 times with slight variations. Extract from the BEST/MOST COMPLETE version.
- HOMOPHONES: "light to earth" = "live to earth" (IR test), "dress" = "address",
  "Earth-In" / "Earthen" = "Earthing", "mil" / "ml" = "mm" (millimetres),
  "mHg" / "m/h" / "Mg/m/s" / "Mg/mV" = "megohms" (insulation resistance unit)
- NOISE MARKERS: Ignore (sighs), (footsteps), (birds chirping), (sniffing), [BLANK_AUDIO]
- BROKEN NUMBERS: "nought point eight seven" = 0.87, "point nine nine" = 0.99
- NUMBER-WORD MIX: "1.66 kiloamps" = 1.66 kA, "greater than 299 mega ohms" = ">299"

=== OUTPUT JSON STRUCTURE ===
{
  "circuits": [{ "circuit_ref": "1", "circuit_designation": "Sockets", ...test_fields }],
  "supply": {
    "earthing_arrangement": "", "earth_loop_impedance_ze": "", "prospective_fault_current": "",
    "live_conductors": "", "nominal_voltage_u": "", "nominal_frequency": "",
    "supply_polarity_confirmed": "", "main_switch_current": "", "main_switch_bs_en": "",
    "main_switch_poles": "", "earthing_conductor_csa": "", "main_bonding_csa": "",
    "bonding_water": "", "bonding_gas": ""
  },
  "installation": { "client_name": "", "address": "", "postcode": "", "premises_description": "" },
  "board": { "manufacturer": "", "location": "", "zs_at_db": "", "ipf_at_db": "" },
  "orphaned_values": [{ "field": "", "value": "", "context": "" }]
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

3. ORPHANED VALUES: If test values appear without a circuit ref, return them in
   orphaned_values with context so the next call can resolve them.

4. INSULATION RESISTANCE:
   - "greater than 200" / "greater than 299" / "infinity" → ">200" or ">299"
   - "live to live" / "L to L" / "L-L" → ir_live_live_mohm
   - "live to earth" / "light to earth" / "L to E" / "L-E" → ir_live_earth_mohm
   - "megohms" / "mega ohms" / "mHg" / "m/h" / "Mg/mV" all mean MΩ

5. SUPPLY-LEVEL FIELDS (never put these on circuits):
   - Ze / external loop impedance → earth_loop_impedance_ze
   - PFC / PSCC / prospective fault current → prospective_fault_current
   - "PME" = TN-C-S earthing arrangement

6. DEDUPLICATION: DO NOT create duplicate circuits. Each unique circuit ref appears once.
   Use the LAST (most refined) version of any repeated data.

7. OBSERVATIONS: Only extract if explicitly described. code: C1/C2/C3/FI.

8. Match orphaned values to most likely circuit based on context.

9. RETURN ALL VALUES — the caller handles merge priorities.

10. CONTEXT AWARENESS: The caller provides already-filled fields. Use these to understand
    which circuits already exist and what values have been set. Focus on extracting NEW
    data that isn't already in the context.`;

/**
 * Call Gemini with transcript TEXT (no audio) + context and return structured extraction.
 * Used by the Deepgram+Gemini hybrid pipeline where Deepgram handles transcription
 * and Gemini handles structured extraction from the transcript text.
 *
 * @param {string} transcriptText - Rolling window of transcript text (~5000 chars)
 * @param {string} contextText - Filled fields + orphans context
 * @returns {Promise<Object>} { circuits, supply, installation, board, orphaned_values, usage }
 */
export async function geminiExtractFromText(transcriptText, contextText) {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const model = GEMINI_TEXT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const userMessage = `=== TRANSCRIPT ===
${transcriptText}

=== CONTEXT (already filled fields) ===
${contextText || "No previous context."}

Extract structured EICR data from the transcript above. Only extract NEW values not already present in the context.`;

  const body = {
    systemInstruction: { parts: [{ text: TEXT_SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errBody = await res.text();
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn("Gemini text extract retryable error", { status: res.status, attempt, delay });
          await sleep(delay);
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text)
        ?.filter(Boolean)
        ?.join("\n")
        ?.trim();

      if (!text) throw new Error("Gemini text extract returned empty response");

      const inputTokens = json?.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Gemini text extract returned invalid JSON: ${text.slice(0, 200)}`);
      }

      // Calculate cost (Gemini 2.5 Pro pricing)
      const isFlash = model.includes("flash");
      const inputRate = isFlash ? 0.15 : 1.25;
      const outputRate = isFlash ? 0.60 : 10.00;
      const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;

      logger.info("Gemini text extract success", {
        model,
        attempt,
        latencyMs,
        inputTokens,
        outputTokens,
        cost: cost.toFixed(6),
        circuits: parsed.circuits?.length ?? 0,
        orphans: parsed.orphaned_values?.length ?? 0,
        transcriptLen: transcriptText.length,
      });

      return {
        circuits: parsed.circuits || [],
        supply: parsed.supply || {},
        installation: parsed.installation || {},
        board: parsed.board || {},
        orphaned_values: parsed.orphaned_values || [],
        usage: { inputTokens, outputTokens, cost: parseFloat(cost.toFixed(6)), latencyMs },
      };

    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && (err.name === "TimeoutError" || err.name === "AbortError")) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn("Gemini text extract timeout, retrying", { attempt, delay });
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
