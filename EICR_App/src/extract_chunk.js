import OpenAI from "openai";
import logger from "./logger.js";

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `Extract EICR data from transcript. Return STRICT JSON ONLY. Extract ONLY what is spoken — never invent values. Empty arrays for no data: "circuits":[],"observations":[].
{"circuits":[],"observations":[],"board":{},"installation":{},"supply_characteristics":{}}

circuit_ref must be a number (1,2,3...). Interpret "first/second/third" or "number one/two" as 1/2/3.
Circuit: circuit_ref, circuit_designation, wiring_type, ref_method, number_of_points, live_csa_mm2, cpc_csa_mm2, max_disconnect_time_s, ocpd_bs_en, ocpd_type, ocpd_rating_a, ocpd_breaking_capacity_ka, ocpd_max_zs_ohm, rcd_bs_en, rcd_type, rcd_operating_current_ma, ring_r1_ohm, ring_rn_ohm, ring_r2_ohm, r1_r2_ohm, r2_ohm, ir_test_voltage_v, ir_live_live_mohm, ir_live_earth_mohm, polarity_confirmed, measured_zs_ohm, rcd_time_ms, rcd_button_confirmed, afdd_button_confirmed
Board: name, location, manufacturer, phases, earthing_arrangement, ze, zs_at_db, ipf_at_db
Installation: client_name, address, postcode, premises_description, next_inspection_years, extent, agreed_limitations, agreed_with, operational_limitations
Supply: earthing_arrangement, live_conductors, nominal_voltage_u, nominal_frequency, prospective_fault_current, earth_loop_impedance_ze, spd_type_supply, spd_rated_current, bonding_conductor_csa, earthing_conductor_csa, main_switch_conductor_csa
Observations: code(C1/C2/C3/FI), item_location, observation_text, schedule_item, regulation
Rewrite observation_text in professional BS7671 language. Include the regulation reference breached (e.g. "544.1.1"). Set schedule_item to the inspection schedule section (e.g. "5.4" for bonding, "4.4" for enclosure fire rating).
Observations must always have a code (C1/C2/C3/FI — default C2 if unsure) and schedule_item (BS7671 section number — e.g. "5.4" for bonding, "4.4" for enclosures, "4.9" for labelling). Never leave code or schedule_item empty.

=== BONDING & EARTHING SIZE EXTRACTION ===
Listen for these phrases and extract to supply_characteristics:
- "earth bonding size", "bonding size", "bonding is X mil", "main bonding" → bonding_conductor_csa (just the number, e.g. "10" for 10mm²)
- "earthing conductor size", "main earth size", "earthing is X mil" → earthing_conductor_csa (just the number)
- "meter tails size", "tails are X mil" → main_switch_conductor_csa (just the number)
- "Ze", "external earth", "earth loop impedance" → earth_loop_impedance_ze
- "PFC", "prospective fault current", "PSCC" → prospective_fault_current

=== DELTA EXTRACTION FROM TRANSCRIPT WINDOW ===
You will receive:
1. ALREADY EXTRACTED DATA — JSON of what has been captured so far. Do NOT re-extract values already present.
2. TRANSCRIPT WINDOW — the last ~2 minutes of the recording. Extract ONLY values NOT already present in the existing data.

RULES:
- Return ONLY values NOT already present in the existing data. If a circuit already has measured_zs_ohm, do NOT return it again unless the transcript states a DIFFERENT value.
- If existing data already has a value for a field, do NOT return it again unless the transcript states a different value.
- The transcript window contains enough context to determine which circuit is active. Look for "circuit 3", "sockets", "lights" etc. to determine context.
- If existing data has circuits 1-5 and the transcript mentions "circuit 6", create a new circuit.
- Zs readings belong to the circuit being discussed, NOT to board.zs_at_db unless explicitly "Zs at the board".
- Ze is ALWAYS supply-level: supply_characteristics.earth_loop_impedance_ze.
- RCD trip times with circuit context go to that circuit's rcd_time_ms.`;

const EMPTY_RESULT = {
  circuits: [],
  observations: [],
  board: {},
  installation: {},
  supply_characteristics: {},
  usage: { prompt_tokens: 0, completion_tokens: 0 },
};

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if an error is retryable (transient server/network issue).
 */
function isRetryableError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const status = error?.status || error?.statusCode || error?.response?.status;

  // HTTP 429 (rate limit), 500, 502, 503, 504 are retryable
  if ([429, 500, 502, 503, 504].includes(status)) return true;

  // Network-level failures
  if (msg.includes("fetch failed") || msg.includes("econnreset") ||
      msg.includes("etimedout") || msg.includes("socket hang up") ||
      msg.includes("network") || msg.includes("timeout")) return true;

  // OpenAI-specific transient errors
  if (msg.includes("rate limit") || msg.includes("overloaded") ||
      msg.includes("server error") || msg.includes("bad gateway")) return true;

  return false;
}

/**
 * Extract structured data from a single audio transcript chunk.
 *
 * @param {string} transcript - The transcribed text from this audio chunk
 * @param {number} chunkIndex - Which chunk this is (0, 1, 2...)
 * @param {number} chunkStartSeconds - When this chunk starts in the recording
 * @param {Object} context - Optional context from EICR buffer state (kept for backward compatibility)
 * @param {Object|null} existingFormData - Cumulative formData extracted so far (circuits, board, etc.)
 * @returns {Promise<Object>} Extracted data with circuits, observations, board, installation, supply_characteristics, usage
 */
export async function extractChunk(transcript, chunkIndex, chunkStartSeconds, context = {}, existingFormData = null) {
  if (!transcript || !transcript.trim()) {
    return { ...EMPTY_RESULT };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = (process.env.EXTRACTION_MODEL || "gpt-5.2").trim();

  // Build context-aware user message
  let userMessage = "";

  // 1. Include existing formData as context (if available)
  if (existingFormData && (existingFormData.circuits?.length > 0 ||
      Object.keys(existingFormData.board_info || {}).length > 0 ||
      Object.keys(existingFormData.installation_details || {}).length > 0 ||
      Object.keys(existingFormData.supply_characteristics || {}).length > 0)) {
    userMessage += `=== ALREADY EXTRACTED DATA (do NOT re-extract these values) ===\n`;
    userMessage += JSON.stringify(existingFormData, null, 0) + "\n\n";
  }

  // 2. The transcript window to extract from
  userMessage += `=== TRANSCRIPT WINDOW (last ~2 minutes of recording — extract NEW values only) ===\n`;
  userMessage += transcript;

  logger.info('Sending to GPT for extraction', {
    chunkIndex,
    transcriptLength: transcript.length,
    existingCircuits: existingFormData?.circuits?.length || 0,
  });
  logger.debug('extractChunk transcript', { transcript });

  let lastError = null;
  let delay = INITIAL_RETRY_DELAY_MS;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
      });

      const raw = resp.choices?.[0]?.message?.content || "";
      const parsed = extractFirstJsonObject(raw);
      const usage = resp.usage || { prompt_tokens: 0, completion_tokens: 0 };
      totalUsage = {
        prompt_tokens: (totalUsage.prompt_tokens || 0) + (usage.prompt_tokens || 0),
        completion_tokens: (totalUsage.completion_tokens || 0) + (usage.completion_tokens || 0),
      };

      logger.info('GPT extraction response', {
        chunkIndex,
        attempt,
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        circuits: parsed?.circuits?.length || 0,
        observations: parsed?.observations?.length || 0,
      });
      logger.debug('GPT raw response', { raw });

      if (!parsed) {
        // Got a response but couldn't parse JSON — retry if we have attempts left
        if (attempt < MAX_RETRIES) {
          logger.warn('extractChunk JSON parse failed, retrying', { chunkIndex, attempt });
          await sleep(delay);
          delay = Math.min(delay * 2, 5000);
          continue;
        }
        // Exhausted retries, return empty
        return {
          ...EMPTY_RESULT,
          usage: totalUsage,
        };
      }

      // Filter out empty objects ({} or objects with only empty string values)
      const isEmptyObj = (obj) => !obj || Object.keys(obj).length === 0 ||
        Object.values(obj).every(v => v === "" || v === null || v === undefined);

      return {
        circuits: Array.isArray(parsed.circuits) ? parsed.circuits.filter(c => !isEmptyObj(c)) : [],
        observations: Array.isArray(parsed.observations) ? parsed.observations.filter(o => !isEmptyObj(o)) : [],
        board: parsed.board || {},
        installation: parsed.installation || {},
        supply_characteristics: parsed.supply_characteristics || {},
        usage: totalUsage,
      };
    } catch (error) {
      lastError = error;
      logger.error('extractChunk attempt failed', { chunkIndex, attempt, maxRetries: MAX_RETRIES, error: error.message });

      // Only retry on transient errors
      if (!isRetryableError(error)) {
        logger.error('Non-retryable error, giving up', { chunkIndex });
        break;
      }

      if (attempt < MAX_RETRIES) {
        logger.info('Retrying extractChunk', { chunkIndex, delay });
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  // All retries exhausted
  logger.error('All extractChunk attempts failed', { chunkIndex, maxRetries: MAX_RETRIES, error: lastError?.message });
  return {
    ...EMPTY_RESULT,
    usage: totalUsage,
  };
}
