import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load externalized system prompt at module init
const EXTRACTION_SYSTEM_PROMPT = fssync.readFileSync(
  path.join(__dirname, "..", "config", "prompts", "extraction_system.md"),
  "utf8"
);

/**
 * Load the central field schema for AI guidance.
 * Returns null if schema doesn't exist.
 */
async function loadFieldSchema() {
  const schemaPath = path.join(__dirname, "..", "config", "field_schema.json");
  try {
    const raw = await fs.readFile(schemaPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    // Schema doesn't exist or is invalid - fall back to hardcoded defaults
    return null;
  }
}

/**
 * Build field guidance text from the field schema.
 * Returns formatted string for inclusion in AI system prompt.
 * Now includes ALL field types: circuits, installation, supply, board, observations, EIC fields.
 */
function buildFieldGuidanceFromSchema(schema) {
  if (!schema) return "";

  const lines = ["\n=== COMPLETE FIELD SCHEMA (Single Source of Truth for UI Fields) ==="];
  lines.push("The following fields are EXACTLY what appears in the UI. Extract these precisely.\n");

  // Helper to format a field section
  const formatFieldSection = (sectionName, fields, tabInfo) => {
    if (!fields || typeof fields !== "object") return;

    // Skip metadata fields
    const fieldEntries = Object.entries(fields).filter(([k]) => !k.startsWith("_"));
    if (fieldEntries.length === 0) return;

    lines.push(`\n--- ${sectionName} ---`);
    if (tabInfo) lines.push(`UI Tab: ${tabInfo}`);

    for (const [fieldName, fieldDef] of fieldEntries) {
      if (!fieldDef || typeof fieldDef !== "object") continue;

      const typeInfo = fieldDef.type === "select"
        ? ` [OPTIONS: ${fieldDef.options?.join(", ") || "any"}]`
        : fieldDef.type === "boolean"
        ? " [true/false]"
        : "";

      lines.push(`- ${fieldName}: ${fieldDef.ai_guidance || fieldDef.description || ""}${typeInfo}`);

      if (fieldDef.default !== undefined) {
        lines.push(`  Default: ${fieldDef.default}`);
      }

      if (fieldDef.defaults_by_circuit) {
        const defaults = Object.entries(fieldDef.defaults_by_circuit)
          .map(([circuit, value]) => `${circuit}=${value}`)
          .join(", ");
        lines.push(`  By circuit type: ${defaults}`);
      }
    }
  };

  // Installation Details (from installation_details_fields)
  if (schema.installation_details_fields) {
    formatFieldSection(
      "INSTALLATION DETAILS",
      schema.installation_details_fields,
      schema.installation_details_fields._ui_tab
    );
  }

  // Supply Characteristics (from supply_characteristics_fields)
  if (schema.supply_characteristics_fields) {
    formatFieldSection(
      "SUPPLY CHARACTERISTICS",
      schema.supply_characteristics_fields,
      schema.supply_characteristics_fields._ui_tab
    );
  }

  // Board Info (from board_fields)
  if (schema.board_fields) {
    formatFieldSection("BOARD INFO", schema.board_fields, "Board Info Tab");
  }

  // Circuit Fields (all 29 columns)
  if (schema.circuit_fields) {
    lines.push("\n--- CIRCUIT SCHEDULE (All 29 Columns) ---");
    lines.push("UI Tab: Circuits");

    // Group by their group property
    const groups = {};
    for (const [fieldName, fieldDef] of Object.entries(schema.circuit_fields)) {
      const group = fieldDef.group || "Other";
      if (!groups[group]) groups[group] = [];
      groups[group].push({ name: fieldName, ...fieldDef });
    }

    for (const [groupName, fields] of Object.entries(groups)) {
      lines.push(`\n${groupName}:`);
      for (const field of fields) {
        const typeInfo = field.type === "select"
          ? ` [OPTIONS: ${field.options?.join(", ") || "any"}]`
          : "";
        lines.push(`- ${field.name}: ${field.ai_guidance || field.description}${typeInfo}`);

        if (field.default) {
          lines.push(`  Default: ${field.default}`);
        }

        if (field.defaults_by_circuit) {
          const defaults = Object.entries(field.defaults_by_circuit)
            .map(([circuit, value]) => `${circuit}=${value}`)
            .join(", ");
          lines.push(`  By circuit type: ${defaults}`);
        }
      }
    }
  }

  // Observations
  if (schema.observation_fields) {
    formatFieldSection("OBSERVATIONS", schema.observation_fields, "Observations Tab");
  }

  // Inspection Schedule guidance
  if (schema.inspection_schedule_fields) {
    lines.push("\n--- INSPECTION SCHEDULE ---");
    lines.push("UI Tab: Inspection Schedule (EICR only)");
    if (schema.inspection_schedule_fields._ai_guidance) {
      lines.push(schema.inspection_schedule_fields._ai_guidance);
    }
    if (schema.inspection_schedule_fields._outcome_options) {
      lines.push(`Outcome options: ${schema.inspection_schedule_fields._outcome_options.join(", ")}`);
    }
  }

  // EIC-specific fields
  if (schema.eic_extent_and_type_fields) {
    formatFieldSection(
      "EIC: EXTENT & TYPE",
      schema.eic_extent_and_type_fields,
      schema.eic_extent_and_type_fields._ui_tab
    );
  }

  if (schema.eic_design_construction_fields) {
    formatFieldSection(
      "EIC: DESIGN & CONSTRUCTION",
      schema.eic_design_construction_fields,
      schema.eic_design_construction_fields._ui_tab
    );
  }

  // Inspector profile
  if (schema.inspector_profile_fields) {
    formatFieldSection(
      "INSPECTOR PROFILE",
      schema.inspector_profile_fields,
      schema.inspector_profile_fields._ui_tab
    );
  }

  lines.push("\n=== END FIELD SCHEMA ===");

  return lines.join("\n");
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function toCsv(headers, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.map(esc).join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => esc(r?.[h] ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * BS/EN standard number lookup by device type
 * Used to fill in BS numbers when AI can't read them from the circuit breaker face
 */
const BS_EN_LOOKUP = {
  // MCBs - Type B, C, D circuit breakers
  MCB: "60898-1",
  B: "60898-1",
  C: "60898-1",
  D: "60898-1",

  // RCBOs - Combined MCB + RCD
  RCBO: "61009",

  // RCDs - Residual current devices (standalone)
  RCD: "61008",
  RCCB: "61008",

  // MCCBs - Moulded case circuit breakers
  MCCB: "60947-2",

  // Main switches / isolators
  SWITCH: "60947-3",
  ISOLATOR: "60947-3",

  // Fuses
  gG: "60269-2",
  HRC: "60269-2",
  REWIREABLE: "3036",
  CARTRIDGE: "1361",
};

/**
 * Apply fallback BS/EN numbers to circuit rows based on device type
 * Only fills in when the AI didn't detect a value
 */
function applyBsEnFallbackToRows(rows) {
  for (const row of rows) {
    // Skip if already has a BS number
    if (row.ocpd_bs_en) continue;

    // Determine device type from ocpd_type
    const ocpdType = (row.ocpd_type || "").toUpperCase();

    // Check if it's an RCBO based on type field or having both MCB type + RCD data
    const hasRcdData = row.rcd_operating_current_ma || row.rcd_bs_en;
    const isMcbType = ["B", "C", "D"].includes(ocpdType);
    const isRcbo = ocpdType === "RCBO" || (isMcbType && hasRcdData);

    if (isRcbo) {
      row.ocpd_bs_en = BS_EN_LOOKUP.RCBO;
      if (!row.rcd_bs_en) {
        row.rcd_bs_en = BS_EN_LOOKUP.RCBO; // Same standard for RCBOs
      }
    } else if (BS_EN_LOOKUP[ocpdType]) {
      // MCB type (B, C, D) or specific device type
      row.ocpd_bs_en = BS_EN_LOOKUP[ocpdType];
    } else if (ocpdType === "MCCB") {
      row.ocpd_bs_en = BS_EN_LOOKUP.MCCB;
    } else if (ocpdType === "GG" || ocpdType === "HRC") {
      row.ocpd_bs_en = BS_EN_LOOKUP.gG;
    }

    // If RCD protected but not RCBO, set RCD BS number
    if (hasRcdData && !row.rcd_bs_en && !isRcbo) {
      row.rcd_bs_en = BS_EN_LOOKUP.RCD;
    }
  }

  return rows;
}

/**
 * Robust extractor:
 * - transcript: required
 * - headersPath/schemaPath/etc: optional
 * If schema is missing, falls back to a minimal header set (so no fs.readFile(undefined)).
 */
export async function extractAll(input) {
  // Support both extractAll({ transcript, headersPath }) and extractAll(transcriptString)
  const transcript = typeof input === "string" ? input : (input?.transcript ?? "");

  // Allow empty transcript if we have photo analysis (photos-only mode)
  // Photo analysis will be included in the transcript/combinedContent by the caller
  if (!transcript.trim()) {
    throw new Error("extractAll: no content to extract from (no audio transcript and no photo analysis)");
  }

  // Accept multiple possible option names for schema path
  const headersPath =
    (typeof input === "object" && (
      input.headersPath ??
      input.schemaPath ??
      input.headers_file ??
      input.headers_path ??
      input.schema_path
    )) || null;

  // Default headers matching field_schema.json (all 29 circuit fields)
  // These must match the column names in the system prompt guidance
  let headers = [
    "circuit_ref",
    "circuit_designation",
    "wiring_type",
    "ref_method",
    "number_of_points",
    "live_csa_mm2",
    "cpc_csa_mm2",
    "max_disconnect_time_s",
    "ocpd_bs_en",
    "ocpd_type",
    "ocpd_rating_a",
    "ocpd_breaking_capacity_ka",
    "ocpd_max_zs_ohm",
    "rcd_bs_en",
    "rcd_type",
    "rcd_operating_current_ma",
    "ring_r1_ohm",
    "ring_rn_ohm",
    "ring_r2_ohm",
    "r1_r2_ohm",
    "r2_ohm",
    "ir_test_voltage_v",
    "ir_live_live_mohm",
    "ir_live_earth_mohm",
    "polarity_confirmed",
    "measured_zs_ohm",
    "rcd_time_ms",
    "rcd_button_confirmed",
    "afdd_button_confirmed"
  ];

  // If a schema path is provided AND is a string, try reading it
  if (typeof headersPath === "string" && headersPath.trim()) {
    const raw = await fs.readFile(headersPath, "utf8");
    const spec = JSON.parse(raw);
    if (Array.isArray(spec?.headers) && spec.headers.length) {
      headers = spec.headers;
    }
  }

  // Load field schema for AI guidance (all 29 circuit fields)
  const fieldSchema = await loadFieldSchema();
  const schemaGuidance = buildFieldGuidanceFromSchema(fieldSchema);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = (process.env.EXTRACTION_MODEL || "gpt-5.2").trim();

  // Build dynamic system prompt: replace headers placeholder and inject row template
  const headersRowTemplate = headers.map((h) => `"${h}": ""`).join(", ");
  const system = EXTRACTION_SYSTEM_PROMPT.replace(
    "{{HEADERS_PLACEHOLDER}}",
    headersRowTemplate
  );

  // Append schema-based field guidance if available
  const fullSystemPrompt = schemaGuidance
    ? system + schemaGuidance
    : system;

  const user = `Transcript:\n${transcript}`;

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: fullSystemPrompt },
      { role: "user", content: user }
    ],
    temperature: 0
  });

  const raw = resp.choices?.[0]?.message?.content || "";
  let parsed = extractFirstJsonObject(raw);

  // Track token usage
  let usage = resp.usage || null;

  // One repair attempt if the model outputs non-JSON
  if (!parsed) {
    const resp2 = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: fullSystemPrompt },
        { role: "user", content: user },
        { role: "user", content: "Your last output was not valid JSON. Output STRICT JSON ONLY in the required shape." }
      ],
      temperature: 0
    });

    const raw2 = resp2.choices?.[0]?.message?.content || "";
    parsed = extractFirstJsonObject(raw2);

    // Accumulate usage from retry
    if (resp2.usage) {
      if (usage) {
        usage = {
          prompt_tokens: (usage.prompt_tokens || 0) + (resp2.usage.prompt_tokens || 0),
          completion_tokens: (usage.completion_tokens || 0) + (resp2.usage.completion_tokens || 0),
          total_tokens: (usage.total_tokens || 0) + (resp2.usage.total_tokens || 0)
        };
      } else {
        usage = resp2.usage;
      }
    }
  }

  if (!parsed) throw new Error("Extractor did not return valid JSON.");

  let rows = (parsed.rows || []).map((r) => {
    const o = {};
    for (const h of headers) o[h] = r?.[h] ?? "";
    return o;
  });

  // Apply BS/EN fallback for any circuits missing BS numbers
  rows = applyBsEnFallbackToRows(rows);

  return {
    csv: toCsv(headers, rows),
    rows,
    observations: parsed.observations || [],
    missing: parsed.missing || [],
    board: parsed.board || {},
    // Support both old field name (installation) and new field name (installation_details)
    installation: parsed.installation_details || parsed.installation || {},
    installation_details: parsed.installation_details || parsed.installation || {},
    supply_characteristics: parsed.supply_characteristics || {},
    usage,
    model
  };
}

