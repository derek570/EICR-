/**
 * OCR Certificate Extraction Module
 *
 * Uses GPT-4o Vision to extract structured data from existing EICR/EIC
 * certificates (PDF or photo). Returns data in CertMate's standard format.
 */

import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import logger from "./logger.js";

const SUPPORTED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png"]);
const SUPPORTED_EXTS = new Set([".jpg", ".jpeg", ".png", ".pdf"]);

/**
 * Build the system prompt that tells GPT-4o how to read an EICR certificate.
 */
const OCR_SYSTEM_PROMPT = `You are an expert EICR (Electrical Installation Condition Report) data extraction system.
You are looking at a scanned or photographed EICR certificate, test results schedule, or electrical installation certificate.

Your task is to extract ALL visible data into a structured JSON object.

=== OUTPUT FORMAT ===
Return a JSON object with these top-level keys (include all, use empty strings/arrays for missing data):

{
  "installation_details": {
    "client_name": "",
    "address": "",
    "postcode": "",
    "premises_description": "",
    "installation_records_available": false,
    "evidence_of_additions_alterations": false,
    "next_inspection_years": 5,
    "extent": "",
    "agreed_limitations": "",
    "agreed_with": "",
    "operational_limitations": ""
  },
  "supply_characteristics": {
    "earthing_arrangement": "",
    "live_conductors": "",
    "number_of_supplies": "",
    "nominal_voltage_u": "",
    "nominal_voltage_uo": "",
    "nominal_frequency": "",
    "prospective_fault_current": "",
    "earth_loop_impedance_ze": "",
    "supply_polarity_confirmed": false,
    "spd_bs_en": "",
    "spd_type_supply": "",
    "spd_short_circuit": "",
    "spd_rated_current": ""
  },
  "board_info": {
    "name": "",
    "location": "",
    "manufacturer": "",
    "phases": "",
    "earthing_arrangement": "",
    "ze": "",
    "zs_at_db": "",
    "ipf_at_db": ""
  },
  "circuits": [
    {
      "circuit_ref": "1",
      "circuit_designation": "",
      "wiring_type": "",
      "ref_method": "",
      "number_of_points": "",
      "live_csa_mm2": "",
      "cpc_csa_mm2": "",
      "max_disconnect_time_s": "",
      "ocpd_bs_en": "",
      "ocpd_type": "",
      "ocpd_rating_a": "",
      "ocpd_breaking_capacity_ka": "",
      "ocpd_max_zs_ohm": "",
      "rcd_bs_en": "",
      "rcd_type": "",
      "rcd_operating_current_ma": "",
      "ring_r1_ohm": "",
      "ring_rn_ohm": "",
      "ring_r2_ohm": "",
      "r1_r2_ohm": "",
      "r2_ohm": "",
      "ir_test_voltage_v": "",
      "ir_live_live_mohm": "",
      "ir_live_earth_mohm": "",
      "polarity_confirmed": "",
      "measured_zs_ohm": "",
      "rcd_time_ms": "",
      "rcd_button_confirmed": "",
      "afdd_button_confirmed": ""
    }
  ],
  "observations": [
    {
      "code": "C2",
      "item_location": "",
      "observation_text": "",
      "schedule_item": ""
    }
  ]
}

=== FIELD EXTRACTION RULES ===

**Installation Details:**
- client_name: Look for "Occupier", "Client", name fields
- address: Full property address
- postcode: UK postcode (e.g., "SW1A 1AA")
- premises_description: "Residential", "Commercial", "Industrial"
- next_inspection_years: Number from "Recommended interval" or "Next inspection" fields

**Supply Characteristics:**
- earthing_arrangement: "TN-S", "TN-C-S", "TT", "IT" - look for tick boxes or written value
- live_conductors: "AC - 1-phase (2 wire)" for domestic
- nominal_voltage_u / nominal_voltage_uo: Usually "230"
- nominal_frequency: Usually "50"
- prospective_fault_current: PFC/Ipf value in kA (just the number, e.g., "2.5")
- earth_loop_impedance_ze: Ze value in ohms (just the number)
- spd_rated_current: Main fuse/supply protective device rating in A

**Board Info:**
- name: Board designation (DB-1, Main CU, etc.)
- location: Physical location of the consumer unit
- manufacturer: Make of the consumer unit
- ze: Ze reading at the board
- ipf_at_db: PFC at the distribution board

**Circuits (29 fields each):**
Extract ALL circuits visible in the schedule. Each row in the test results schedule is one circuit.
- circuit_ref: Sequential number or label
- circuit_designation: Description (e.g., "Lights GF", "Ring Final", "Cooker")
- wiring_type: Usually "A" for domestic
- ref_method: Usually "A" for domestic
- number_of_points: Count of outlets/points
- live_csa_mm2: Cable size (1.0, 2.5, 6.0, 10.0)
- cpc_csa_mm2: Earth cable size
- max_disconnect_time_s: Usually "0.4"
- ocpd_bs_en: Standard number (60898 for MCB, 61009 for RCBO)
- ocpd_type: "B", "C", "D", etc.
- ocpd_rating_a: Breaker rating in amps
- ocpd_breaking_capacity_ka: Usually "6" for domestic
- ocpd_max_zs_ohm: Maximum Zs from tables
- rcd_bs_en: RCD standard number
- rcd_type: "A", "AC", etc.
- rcd_operating_current_ma: Usually "30"
- ring_r1_ohm, ring_rn_ohm, ring_r2_ohm: Ring circuit end-to-end readings (blank for radials)
- r1_r2_ohm: R1+R2 continuity reading
- r2_ohm: R2 reading
- ir_test_voltage_v: Usually "500"
- ir_live_live_mohm: Insulation resistance L-L
- ir_live_earth_mohm: Insulation resistance L-E
- polarity_confirmed: "OK" or "Y"
- measured_zs_ohm: Zs loop impedance reading
- rcd_time_ms: RCD trip time in ms
- rcd_button_confirmed: "OK" or "Y"
- afdd_button_confirmed: "OK" or "Y" if AFDD fitted

**Observations:**
- Look for the observations/defects section
- code: C1 (Danger), C2 (Potentially dangerous), C3 (Improvement), FI (Further investigation)
- item_location: Where the defect was found
- observation_text: Description of the defect
- schedule_item: BS7671 regulation reference if given

=== IMPORTANT RULES ===
1. Extract ALL data visible on the certificate - do not skip any fields
2. Use empty string "" for fields that are not visible or not applicable
3. Use the exact numeric values shown (e.g., "0.52" not "0.5")
4. For readings shown as ">200" or "999", keep them as-is
5. For tick marks (checkboxes), interpret them as "OK" or "Y" for confirmed fields
6. For boolean fields, use true/false
7. If the image is blurry or text is unclear, use your best interpretation
8. Include ALL circuits shown in the schedule, even if some readings are empty
9. Return ONLY valid JSON - no markdown, no code blocks, no commentary`;

/**
 * Determine MIME type from file extension.
 */
function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".pdf":
      return "application/pdf";
    default:
      return "image/jpeg";
  }
}

/**
 * Extract structured data from an EICR certificate image or PDF.
 *
 * @param {string} filePath - Absolute path to the certificate file (PDF, JPG, PNG)
 * @returns {Promise<Object>} Extracted certificate data in CertMate format
 */
export async function extractFromCertificate(filePath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY - cannot perform OCR extraction");
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new Error(`Unsupported file type: ${ext}. Supported: .pdf, .jpg, .jpeg, .png`);
  }

  const openai = new OpenAI({ apiKey });
  const model = "gpt-4o";

  logger.info("Starting OCR certificate extraction", { filePath, ext, model });

  // Read file as base64
  const fileBytes = await fs.readFile(filePath);
  const base64 = Buffer.from(fileBytes).toString("base64");
  const mimeType = mimeFromExt(filePath);
  const dataUrl = `data:${mimeType};base64,${base64}`;

  // Build the content array for the vision request
  const content = [
    {
      type: "text",
      text: "Extract all data from this EICR/EIC certificate into the JSON format specified in your instructions. Include every circuit, every observation, and all installation details visible.",
    },
  ];

  if (ext === ".pdf") {
    // For PDFs, send as image_url with PDF data URI
    content.push({
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: "high",
      },
    });
  } else {
    // For images, send as image_url
    content.push({
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: "high",
      },
    });
  }

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: OCR_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_completion_tokens: 16000,
    });

    const rawText = response.choices?.[0]?.message?.content?.trim();
    if (!rawText) {
      throw new Error("Empty response from GPT-4o Vision");
    }

    const usage = response.usage || null;
    logger.info("OCR extraction complete", {
      tokens: usage?.total_tokens || 0,
      model,
    });

    // Parse and validate the JSON response
    let extracted;
    try {
      extracted = JSON.parse(rawText);
    } catch (parseErr) {
      logger.error("Failed to parse OCR JSON response", {
        error: parseErr.message,
        rawText: rawText.substring(0, 500),
      });
      throw new Error("Failed to parse extraction result as JSON");
    }

    // Ensure all expected top-level keys exist with defaults
    const result = {
      installation_details: extracted.installation_details || {
        client_name: "",
        address: "",
        postcode: "",
        premises_description: "Residential",
        installation_records_available: false,
        evidence_of_additions_alterations: false,
        next_inspection_years: 5,
        extent: "",
        agreed_limitations: "",
        agreed_with: "",
        operational_limitations: "",
      },
      supply_characteristics: extracted.supply_characteristics || {
        earthing_arrangement: "",
        live_conductors: "",
        number_of_supplies: "",
        nominal_voltage_u: "",
        nominal_voltage_uo: "",
        nominal_frequency: "",
        prospective_fault_current: "",
        earth_loop_impedance_ze: "",
        supply_polarity_confirmed: false,
        spd_bs_en: "",
        spd_type_supply: "",
        spd_short_circuit: "",
        spd_rated_current: "",
      },
      board_info: extracted.board_info || {
        name: "",
        location: "",
        manufacturer: "",
        phases: "",
        earthing_arrangement: "",
        ze: "",
        zs_at_db: "",
        ipf_at_db: "",
      },
      circuits: Array.isArray(extracted.circuits) ? extracted.circuits : [],
      observations: Array.isArray(extracted.observations)
        ? extracted.observations.map((obs) => ({
            code: obs.code || "C3",
            item_location: obs.item_location || obs.title || "",
            observation_text: obs.observation_text || obs.text || "",
            schedule_item: obs.schedule_item || "",
          }))
        : [],
    };

    // Ensure each circuit has all 29 fields (fill missing with empty string)
    const circuitFields = [
      "circuit_ref", "circuit_designation", "wiring_type", "ref_method",
      "number_of_points", "live_csa_mm2", "cpc_csa_mm2", "max_disconnect_time_s",
      "ocpd_bs_en", "ocpd_type", "ocpd_rating_a", "ocpd_breaking_capacity_ka",
      "ocpd_max_zs_ohm", "rcd_bs_en", "rcd_type", "rcd_operating_current_ma",
      "ring_r1_ohm", "ring_rn_ohm", "ring_r2_ohm", "r1_r2_ohm", "r2_ohm",
      "ir_test_voltage_v", "ir_live_live_mohm", "ir_live_earth_mohm",
      "polarity_confirmed", "measured_zs_ohm", "rcd_time_ms",
      "rcd_button_confirmed", "afdd_button_confirmed",
    ];

    result.circuits = result.circuits.map((circuit) => {
      const normalized = {};
      for (const field of circuitFields) {
        normalized[field] = circuit[field] != null ? String(circuit[field]) : "";
      }
      return normalized;
    });

    logger.info("OCR extraction validated", {
      circuits: result.circuits.length,
      observations: result.observations.length,
      hasAddress: !!result.installation_details.address,
    });

    return {
      data: result,
      usage,
      model,
    };
  } catch (err) {
    // Rethrow parse/validation errors as-is
    if (err.message.includes("parse") || err.message.includes("Empty response")) {
      throw err;
    }

    logger.error("OCR extraction API call failed", {
      error: err.message,
      status: err.status,
    });
    throw new Error(`OCR extraction failed: ${err.message}`);
  }
}
