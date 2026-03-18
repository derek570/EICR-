/**
 * Merge numeric salvage into CSV rows safely.
 * Rules:
 * - Never overwrite existing values
 * - Only fill empty cells
 * - Only merge when circuit_ref matches
 */

/**
 * Try to match a salvage note to a circuit designation.
 * Returns the matching circuit_ref or null.
 */
function matchNoteToCircuit(notes, rows) {
  if (!notes) return null;
  const noteLower = notes.toLowerCase();

  // Common circuit name patterns and their variations
  const patterns = [
    { keywords: ["downstairs", "down", "front", "socket"], circuit: ["sockets", "down", "front"] },
    { keywords: ["downstairs", "down", "rear", "socket"], circuit: ["sockets", "down", "rear"] },
    { keywords: ["upstairs", "up", "socket"], circuit: ["sockets", "up"] },
    { keywords: ["upstairs", "up", "light"], circuit: ["lights", "up"] },
    { keywords: ["downstairs", "down", "light"], circuit: ["lights", "down"] },
    { keywords: ["boiler"], circuit: ["boiler"] },
    { keywords: ["cooker", "oven"], circuit: ["cooker"] },
    { keywords: ["shower"], circuit: ["shower"] },
    { keywords: ["immersion"], circuit: ["immersion"] },
  ];

  for (const pattern of patterns) {
    const matchCount = pattern.keywords.filter(kw => noteLower.includes(kw)).length;
    if (matchCount >= 2 || (pattern.keywords.length === 1 && matchCount === 1)) {
      // Find matching circuit
      for (const row of rows) {
        const designation = (row.circuit_designation || "").toLowerCase();
        const allMatch = pattern.circuit.every(kw => designation.includes(kw));
        if (allMatch) {
          return row.circuit_ref;
        }
      }
    }
  }
  return null;
}

export function mergeSalvageIntoRows(rows, salvage) {
  const merged = rows.map(r => ({ ...r }));
  const unresolved = [];

  for (const val of salvage?.values || []) {
    const { circuit_ref, test, value, unit, confidence, notes } = val;

    if (!test || !value) {
      unresolved.push({ ...val, reason: "Missing test or value" });
      continue;
    }

    // Try to match by circuit_ref first, then by notes
    let effectiveCircuitRef = circuit_ref;
    if (!effectiveCircuitRef && notes) {
      effectiveCircuitRef = matchNoteToCircuit(notes, merged);
    }

    if (!effectiveCircuitRef) {
      unresolved.push({ ...val, reason: "Missing circuit_ref or test" });
      continue;
    }

    const row = merged.find(r =>
      String(r.circuit_ref || "").trim() === String(effectiveCircuitRef).trim()
    );

    if (!row) {
      unresolved.push({ ...val, reason: "Circuit not found in CSV" });
      continue;
    }

    // Map salvage test → CSV column (supports both old and new column naming schemes)
    let column = null;
    switch (test) {
      case "r1_r2":
        column = row.r1_r2_ohm !== undefined ? "r1_r2_ohm" : "r1_r2";
        break;
      case "r2":
        column = "r2_ohm";
        break;
      case "zs":
        column = row.measured_zs_ohm !== undefined ? "measured_zs_ohm" : "zs";
        break;
      case "ir":
      case "ir_live_earth":
        column = row.ir_live_earth_mohm !== undefined ? "ir_live_earth_mohm" : "ir_500v_mohm";
        break;
      case "ir_live_live":
        column = "ir_live_live_mohm";
        break;
      case "rcd_trip_time":
        column = row.rcd_time_ms !== undefined ? "rcd_time_ms" : "rcd_trip_times_ms";
        break;
      case "rcd_rating":
        column = row.rcd_operating_current_ma !== undefined ? "rcd_operating_current_ma" : "rcd_rating_ma";
        break;
      case "ocpd_rating":
        column = "ocpd_rating_a";
        break;
      case "ring_r1":
        column = "ring_r1_ohm";
        break;
      case "ring_rn":
        column = "ring_rn_ohm";
        break;
      case "ring_r2":
        column = "ring_r2_ohm";
        break;
      case "live_csa":
        column = "live_csa_mm2";
        break;
      case "cpc_csa":
        column = "cpc_csa_mm2";
        break;
      case "max_zs":
        column = "ocpd_max_zs_ohm";
        break;
      case "breaking_capacity":
        column = "ocpd_breaking_capacity_ka";
        break;
      default:
        unresolved.push({ ...val, reason: "Unknown test type" });
        continue;
    }

    if (!column || row[column]) {
      unresolved.push({ ...val, reason: "Target cell already filled or unknown" });
      continue;
    }

    // Fill safely
    row[column] = unit ? `${value} ${unit}` : value;
  }

  return { merged, unresolved };
}

