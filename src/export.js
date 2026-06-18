/**
 * Export utilities for CSV and Excel generation.
 * Converts job data (circuits, observations, board info, etc.) into downloadable formats.
 */

import XLSX from 'xlsx';

// Human-readable column headers for circuit fields
const CIRCUIT_HEADERS = {
  circuit_ref: 'Circuit Ref',
  circuit_designation: 'Circuit Designation',
  wiring_type: 'Wiring Type',
  ref_method: 'Reference Method',
  number_of_points: 'No. of Points',
  live_csa_mm2: 'Live CSA (mm²)',
  cpc_csa_mm2: 'CPC CSA (mm²)',
  max_disconnect_time_s: 'Max Disconnect Time (s)',
  ocpd_bs_en: 'OCPD BS EN',
  ocpd_type: 'OCPD Type',
  ocpd_rating_a: 'OCPD Rating (A)',
  ocpd_breaking_capacity_ka: 'OCPD Breaking Capacity (kA)',
  ocpd_max_zs_ohm: 'OCPD Max Zs (Ohm)',
  rcd_bs_en: 'RCD BS EN',
  rcd_type: 'RCD Type',
  rcd_operating_current_ma: 'RCD Operating Current (mA)',
  ring_r1_ohm: 'Ring r1 (Ohm)',
  ring_rn_ohm: 'Ring rn (Ohm)',
  ring_r2_ohm: 'Ring r2 (Ohm)',
  r1_r2_ohm: 'R1+R2 (Ohm)',
  r2_ohm: 'R2 (Ohm)',
  ir_test_voltage_v: 'IR Test Voltage (V)',
  ir_live_live_mohm: 'IR Live-Live (MOhm)',
  ir_live_earth_mohm: 'IR Live-Earth (MOhm)',
  polarity_confirmed: 'Polarity Confirmed',
  measured_zs_ohm: 'Measured Zs (Ohm)',
  rcd_time_ms: 'RCD Time (ms)',
  rcd_button_confirmed: 'RCD Button Confirmed',
  afdd_button_confirmed: 'AFDD Button Confirmed',
  // Phase 2a of the multi-board / sub-main support sprint
  // (.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md):
  // multi-board hierarchy markers must round-trip through `test_results.csv`,
  // not just `extracted_data.json`. Without these headers the CSV reader
  // (utils/jobs.js parseCSV) silently drops the columns on every save→load
  // cycle and the iOS UI's `boardId` discriminator goes blank.
  board_id: 'Board ID',
  is_distribution_circuit: 'Distribution Circuit',
  feeds_board_id: 'Feeds Board ID',
};

// Ordered list of circuit fields (matches the PDF column order)
const CIRCUIT_FIELD_ORDER = [
  'circuit_ref',
  'circuit_designation',
  'wiring_type',
  'ref_method',
  'number_of_points',
  'live_csa_mm2',
  'cpc_csa_mm2',
  'max_disconnect_time_s',
  'ocpd_bs_en',
  'ocpd_type',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ocpd_max_zs_ohm',
  'rcd_bs_en',
  'rcd_type',
  'rcd_operating_current_ma',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
  'r1_r2_ohm',
  'r2_ohm',
  'ir_test_voltage_v',
  'ir_live_live_mohm',
  'ir_live_earth_mohm',
  'polarity_confirmed',
  'measured_zs_ohm',
  'rcd_time_ms',
  'rcd_button_confirmed',
  'afdd_button_confirmed',
  // Multi-board hierarchy (Phase 2a). Appended at the END of the order so
  // existing CSVs with the old column count still parse — parseCSV maps by
  // header name, not position, so old files just won't have these columns
  // and the new fields read as undefined for legacy rows.
  'board_id',
  'is_distribution_circuit',
  'feeds_board_id',
];

const OBSERVATION_HEADERS = {
  code: 'Code',
  item_location: 'Location',
  observation_text: 'Observation',
  schedule_item: 'Schedule Item',
  schedule_description: 'Schedule Description',
};

const BOARD_INFO_HEADERS = {
  name: 'Board Name',
  location: 'Location',
  manufacturer: 'Manufacturer',
  phases: 'Phases',
  earthing_arrangement: 'Earthing Arrangement',
  ze: 'Ze (Ohm)',
  zs_at_db: 'Zs at DB (Ohm)',
  ipf_at_db: 'Ipf at DB (kA)',
};

const INSTALLATION_HEADERS = {
  client_name: 'Client Name',
  address: 'Address',
  postcode: 'Postcode',
  premises_description: 'Premises Description',
  installation_records_available: 'Installation Records Available',
  evidence_of_additions_alterations: 'Evidence of Additions/Alterations',
  next_inspection_years: 'Next Inspection (Years)',
  extent: 'Extent of Installation Covered',
  agreed_limitations: 'Agreed Limitations',
  agreed_with: 'Agreed With',
  operational_limitations: 'Operational Limitations',
};

const SUPPLY_HEADERS = {
  earthing_arrangement: 'Earthing Arrangement',
  live_conductors: 'Live Conductors',
  number_of_supplies: 'Number of Supplies',
  nominal_voltage_u: 'Nominal Voltage U (V)',
  nominal_voltage_uo: 'Nominal Voltage Uo (V)',
  nominal_frequency: 'Nominal Frequency (Hz)',
  prospective_fault_current: 'Prospective Fault Current (kA)',
  earth_loop_impedance_ze: 'Earth Loop Impedance Ze (Ohm)',
  supply_polarity_confirmed: 'Supply Polarity Confirmed',
  // Option A (surge-protection-box 2026-06-17): spd_* = the DNO supply cutout /
  // main fuse (NOT surge). Renamed from the misleading "SPD" headers; the real
  // Surge Protection Device gets its own surge_* columns below.
  spd_bs_en: 'Main Fuse BS EN',
  spd_type_supply: 'Main Fuse Type',
  spd_short_circuit: 'Main Fuse Short Circuit (kA)',
  spd_rated_current: 'Main Fuse Rated Current (A)',
  surge_spd_present: 'Surge Protection Fitted',
  surge_spd_type: 'Surge Protection Type',
  surge_spd_bs_en: 'Surge Protection BS EN',
  surge_status_indicator: 'Surge Status Indicator',
};

/**
 * Generate CSV string from circuits array.
 * Uses field names as headers (machine-readable).
 */
export function circuitsToCSV(circuits) {
  if (!circuits || circuits.length === 0) {
    return CIRCUIT_FIELD_ORDER.join(',') + '\n';
  }

  const headerLine = CIRCUIT_FIELD_ORDER.join(',');
  const rows = circuits.map((circuit) => {
    return CIRCUIT_FIELD_ORDER.map((field) => {
      const value = circuit[field] ?? '';
      // Escape values containing commas, quotes, or newlines
      const strValue = String(value);
      if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
        return `"${strValue.replace(/"/g, '""')}"`;
      }
      return strValue;
    }).join(',');
  });

  return [headerLine, ...rows].join('\n') + '\n';
}

/**
 * Convert an object to a single-row array of [{header: value}] using a header map.
 * Used for board info, installation details, supply characteristics sheets.
 */
function objectToRow(obj, headerMap) {
  if (!obj || typeof obj !== 'object') return [{}];
  const row = {};
  for (const [field, header] of Object.entries(headerMap)) {
    const value = obj[field];
    row[header] = value !== undefined && value !== null ? String(value) : '';
  }
  return [row];
}

/**
 * Generate an Excel workbook buffer from full job data.
 * Creates multiple sheets:
 *   - Circuit Schedule
 *   - Observations
 *   - Board Info
 *   - Installation Details
 *   - Supply Characteristics
 */
export function jobToExcel(jobData) {
  const wb = XLSX.utils.book_new();

  // --- Circuit Schedule sheet ---
  const circuits = jobData.circuits || [];
  if (circuits.length > 0) {
    const circuitRows = circuits.map((c) => {
      const row = {};
      for (const field of CIRCUIT_FIELD_ORDER) {
        row[CIRCUIT_HEADERS[field]] = c[field] ?? '';
      }
      return row;
    });
    const circuitsWs = XLSX.utils.json_to_sheet(circuitRows);
    // Set column widths for readability
    circuitsWs['!cols'] = CIRCUIT_FIELD_ORDER.map((f) => ({
      wch: Math.max((CIRCUIT_HEADERS[f] || f).length + 2, 12),
    }));
    XLSX.utils.book_append_sheet(wb, circuitsWs, 'Circuit Schedule');
  } else {
    const emptyWs = XLSX.utils.aoa_to_sheet([CIRCUIT_FIELD_ORDER.map((f) => CIRCUIT_HEADERS[f])]);
    XLSX.utils.book_append_sheet(wb, emptyWs, 'Circuit Schedule');
  }

  // --- Observations sheet ---
  const observations = jobData.observations || [];
  if (observations.length > 0) {
    const obsRows = observations.map((o) => {
      const row = {};
      for (const [field, header] of Object.entries(OBSERVATION_HEADERS)) {
        row[header] = o[field] ?? '';
      }
      return row;
    });
    const obsWs = XLSX.utils.json_to_sheet(obsRows);
    obsWs['!cols'] = Object.values(OBSERVATION_HEADERS).map((h) => ({
      wch: Math.max(h.length + 2, 20),
    }));
    XLSX.utils.book_append_sheet(wb, obsWs, 'Observations');
  } else {
    const emptyWs = XLSX.utils.aoa_to_sheet([Object.values(OBSERVATION_HEADERS)]);
    XLSX.utils.book_append_sheet(wb, emptyWs, 'Observations');
  }

  // --- Board Info sheet ---
  const boardInfo = jobData.board_info || {};
  const boardRows = objectToRow(boardInfo, BOARD_INFO_HEADERS);
  const boardWs = XLSX.utils.json_to_sheet(boardRows);
  boardWs['!cols'] = Object.values(BOARD_INFO_HEADERS).map((h) => ({
    wch: Math.max(h.length + 2, 15),
  }));
  XLSX.utils.book_append_sheet(wb, boardWs, 'Board Info');

  // --- Installation Details sheet ---
  const installation = jobData.installation_details || {};
  const installRows = objectToRow(installation, INSTALLATION_HEADERS);
  const installWs = XLSX.utils.json_to_sheet(installRows);
  installWs['!cols'] = Object.values(INSTALLATION_HEADERS).map((h) => ({
    wch: Math.max(h.length + 2, 20),
  }));
  XLSX.utils.book_append_sheet(wb, installWs, 'Installation Details');

  // --- Supply Characteristics sheet ---
  const supply = jobData.supply_characteristics || {};
  const supplyRows = objectToRow(supply, SUPPLY_HEADERS);
  const supplyWs = XLSX.utils.json_to_sheet(supplyRows);
  supplyWs['!cols'] = Object.values(SUPPLY_HEADERS).map((h) => ({
    wch: Math.max(h.length + 2, 20),
  }));
  XLSX.utils.book_append_sheet(wb, supplyWs, 'Supply Characteristics');

  // Write workbook to buffer
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
