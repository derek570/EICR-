/**
 * Shared job utilities — resolveJob, loadJobData, parseCSV, data transformers
 */

import * as db from "../db.js";
import * as storage from "../storage.js";
import logger from "../logger.js";

/**
 * Resolve a job by ID or address. Returns the job record or null.
 */
export async function resolveJob(userId, jobId) {
  let job = await db.getJob(jobId);
  if (!job) {
    job = await db.getJobByAddress(userId, jobId);
  }
  return job;
}

/**
 * Get the S3 output prefix for a job.
 */
export function getJobOutputPrefix(userId, job, jobId) {
  const folderName = job?.address || jobId;
  return `jobs/${userId}/${folderName}/output/`;
}

/**
 * Parse a CSV string into an array of row objects.
 */
export function parseCSV(csvContent) {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim().replace(/"/g, ""));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Transform observations from pipeline format to UI format.
 */
export function transformObservations(pipelineObservations) {
  if (!Array.isArray(pipelineObservations)) return [];

  return pipelineObservations.map(obs => {
    let photos = obs.photos || [];
    if (obs.photo && typeof obs.photo === "string") {
      const filename = obs.photo.split("/").pop();
      photos = [filename];
    }

    return {
      code: obs.code || "C3",
      item_location: obs.item_location || obs.title || "",
      observation_text: obs.observation_text || obs.text || "",
      schedule_item: obs.schedule_item || "",
      schedule_description: obs.schedule_description || "",
      photos,
    };
  });
}

/**
 * Transform extracted data from pipeline format to UI format.
 */
export function transformExtractedData(extractedInstallation, extractedBoard) {
  const installation = extractedInstallation || {};
  const board = extractedBoard || {};

  const installation_details = {
    client_name: installation.client_name || "",
    address: installation.address || "",
    postcode: installation.postcode || "",
    town: installation.town || "",
    county: installation.county || "",
    premises_description: installation.premises_description || board.premises_description || "",
    installation_records_available: installation.installation_records_available ?? board.installation_records_available ?? false,
    evidence_of_additions_alterations: installation.evidence_of_additions_alterations ?? board.evidence_of_additions_alterations ?? false,
    next_inspection_years: installation.next_inspection_years || board.next_inspection_years || "",
    extent: installation.extent || board.extent || "",
    agreed_limitations: installation.agreed_limitations || board.agreed_limitations || "",
    agreed_with: installation.agreed_with || board.agreed_with || "",
    operational_limitations: installation.operational_limitations || board.operational_limitations || "",
  };

  const supply_characteristics = {
    earthing_arrangement: board.earthing_arrangement || "",
    live_conductors: board.live_conductors || "",
    number_of_supplies: board.number_of_supplies || "",
    nominal_voltage_u: board.voltage_rating || board.nominal_voltage_u || "",
    nominal_voltage_uo: board.nominal_voltage_uo || "",
    nominal_frequency: board.nominal_frequency || "",
    prospective_fault_current: board.ipf_at_db || board.prospective_fault_current || "",
    earth_loop_impedance_ze: board.ze || board.earth_loop_impedance_ze || "",
    supply_polarity_confirmed: board.supply_polarity_confirmed ?? false,
    spd_bs_en: board.spd_bs_en || "",
    spd_type_supply: board.spd_type || board.spd_type_supply || "",
    spd_short_circuit: board.spd_short_circuit || "",
    spd_rated_current: board.spd_rated_current || board.rated_current || "",
  };

  const board_info = {
    name: board.name || "",
    location: board.location || "",
    manufacturer: board.manufacturer || "",
    phases: board.phases || "",
    earthing_arrangement: board.earthing_arrangement || "",
    ze: board.ze || "",
    zs_at_db: board.zs_at_db || "",
    ipf_at_db: board.ipf_at_db || "",
    main_switch_bs_en: board.main_switch_bs_en || "",
    main_switch_poles: board.main_switch_poles || "",
    main_switch_voltage: board.voltage_rating || "",
    main_switch_current: board.rated_current || "",
    rcd_rating: board.rcd_rating || "",
    rcd_trip_time: board.rcd_trip_time || "",
    tails_material: board.tails_material || "",
    tails_csa: board.tails_csa || "",
    earthing_conductor_material: board.earthing_conductor_material || "",
    earthing_conductor_csa: board.earthing_conductor_csa || "",
    bonding_conductor_material: board.bonding_conductor_material || "",
    bonding_conductor_csa: board.bonding_conductor_csa || "",
    notes: board.notes || "",
  };

  return {
    installation_details,
    supply_characteristics,
    board_info,
  };
}

/**
 * Load full job data from S3.
 * Returns { address, circuits, observations, board_info, installation_details, supply_characteristics }
 */
export async function loadJobData(userId, jobId) {
  const job = await resolveJob(userId, jobId);

  const folderName = job?.address || jobId;
  const s3Prefix = `jobs/${userId}/${folderName}/output/`;

  let circuits = [];
  try {
    const csvContent = await storage.downloadText(`${s3Prefix}test_results.csv`);
    if (csvContent) {
      circuits = parseCSV(csvContent);
    }
  } catch (e) {
    logger.warn("No circuits CSV found for export", { jobId });
  }

  let extractedData = {};

  const combinedJsonContent = await storage.downloadText(`${s3Prefix}extracted_data.json`).catch(() => null);

  if (combinedJsonContent) {
    extractedData = JSON.parse(combinedJsonContent);
  } else {
    try {
      const [installationJson, boardJson, observationsJson, supplyJson] = await Promise.all([
        storage.downloadText(`${s3Prefix}installation_details.json`).catch(() => null),
        storage.downloadText(`${s3Prefix}board_details.json`).catch(() => null),
        storage.downloadText(`${s3Prefix}observations.json`).catch(() => null),
        storage.downloadText(`${s3Prefix}supply_characteristics.json`).catch(() => null),
      ]);

      const rawInstallation = installationJson ? JSON.parse(installationJson) : null;
      const rawBoard = boardJson ? JSON.parse(boardJson) : null;
      const rawSupply = supplyJson ? JSON.parse(supplyJson) : null;

      const transformed = transformExtractedData(rawInstallation, rawBoard);
      extractedData.installation_details = transformed.installation_details;
      extractedData.supply_characteristics = rawSupply || transformed.supply_characteristics;
      extractedData.board_info = transformed.board_info;

      if (observationsJson) {
        extractedData.observations = transformObservations(JSON.parse(observationsJson));
      }
    } catch (innerError) {
      logger.warn("Failed to load extracted data files for export", { jobId, error: innerError.message });
    }
  }

  if (!job && circuits.length === 0 && Object.keys(extractedData).length === 0) {
    return null;
  }

  return {
    address: job?.address || extractedData.address || jobId,
    circuits,
    observations: extractedData.observations || [],
    board_info: extractedData.board_info || {},
    installation_details: extractedData.installation_details || {},
    supply_characteristics: extractedData.supply_characteristics || {},
  };
}

/**
 * Per-route timeout middleware for long-running routes
 */
export const routeTimeout = (ms) => (req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({ error: "Request timed out" });
    }
  }, ms);
  res.on("finish", () => clearTimeout(timer));
  next();
};
