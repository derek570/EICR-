/**
 * Real-time recording accumulator.
 * Merges extracted data from multiple audio chunks into a single job,
 * handles circuit deduplication, observation merging, and photo linking.
 */

/**
 * Create a new empty accumulator.
 */
export function createAccumulator() {
  return {
    circuits: [],
    observations: [],
    board: {},
    installation: {},
    supply: {},
    photos: [],
    _chunkTimestamps: [], // Track when each chunk's data arrived
  };
}

/**
 * Merge a field value, preferring non-empty values.
 */
function mergeField(existing, incoming) {
  if (!incoming || incoming === "") return existing || "";
  return incoming;
}

/**
 * Merge an object's fields, keeping existing non-empty values
 * and filling in new ones from incoming data.
 */
function mergeObject(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return existing;
  const result = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null && value !== "") {
      // Only overwrite if existing is empty
      if (!result[key] || result[key] === "") {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Check if two observations are likely duplicates.
 */
function isObservationDuplicate(existing, incoming) {
  // Same location and similar text
  if (existing.item_location && incoming.item_location) {
    const locMatch = existing.item_location.toLowerCase() === incoming.item_location.toLowerCase();
    if (locMatch) {
      // Check text similarity (simple: same first 50 chars)
      const existText = (existing.observation_text || existing.text || "").toLowerCase().substring(0, 50);
      const incomText = (incoming.observation_text || incoming.text || "").toLowerCase().substring(0, 50);
      if (existText === incomText) return true;
    }
  }
  // Same schedule item and code
  if (existing.schedule_item && incoming.schedule_item &&
      existing.schedule_item === incoming.schedule_item &&
      existing.code === incoming.code) {
    return true;
  }
  return false;
}

/**
 * Add extracted chunk data to the accumulator.
 * Handles circuit deduplication by circuit_ref and observation dedup.
 */
export function addChunk(accumulator, chunkData) {
  if (!chunkData) return;

  // Track chunk timestamp
  accumulator._chunkTimestamps.push(Date.now());

  // Merge circuits - deduplicate by circuit_ref OR circuit_designation (name)
  if (chunkData.circuits && chunkData.circuits.length > 0) {
    for (const incoming of chunkData.circuits) {
      const ref = incoming.circuit_ref;
      const name = (incoming.circuit_designation || "").toLowerCase().trim();

      // Find existing circuit by ref OR by name match
      let existingIdx = -1;
      if (ref) {
        existingIdx = accumulator.circuits.findIndex(c => c.circuit_ref === ref);
      }
      if (existingIdx < 0 && name) {
        existingIdx = accumulator.circuits.findIndex(c => {
          const existingName = (c.circuit_designation || "").toLowerCase().trim();
          if (!existingName) return false;
          // Match if either name contains the other (handles "cooker Downstairs" vs "downstairs cooker circuit")
          return existingName.includes(name) || name.includes(existingName) ||
            existingName.split(/\s+/).sort().join(" ") === name.split(/\s+/).sort().join(" ");
        });
      }
      // If no ref and no name, merge into the most recent circuit (test values for active circuit)
      if (existingIdx < 0 && !ref && !name && accumulator.circuits.length > 0) {
        existingIdx = accumulator.circuits.length - 1;
      }

      if (existingIdx >= 0) {
        // Merge: fill in missing values from incoming
        const existing = accumulator.circuits[existingIdx];
        for (const [key, value] of Object.entries(incoming)) {
          if (value !== undefined && value !== null && value !== "") {
            if (!existing[key] || existing[key] === "") {
              existing[key] = value;
            }
          }
        }
      } else {
        accumulator.circuits.push({ ...incoming });
      }
    }
  }

  // Merge observations - deduplicate, skip empty
  if (chunkData.observations && chunkData.observations.length > 0) {
    for (const incoming of chunkData.observations) {
      // Skip empty observation objects
      const hasContent = incoming.observation_text || incoming.text || incoming.item_location || incoming.title;
      if (!hasContent) continue;

      // Normalize field names (AI might return title/text instead of item_location/observation_text)
      const normalized = {
        ...incoming,
        item_location: incoming.item_location || incoming.title || "",
        observation_text: incoming.observation_text || incoming.text || "",
        code: incoming.code || "C3",
        schedule_item: incoming.schedule_item || "",
      };

      const isDuplicate = accumulator.observations.some(obs => isObservationDuplicate(obs, normalized));
      if (!isDuplicate) {
        accumulator.observations.push(normalized);
      }
    }
  }

  // Merge board details
  if (chunkData.board && Object.keys(chunkData.board).length > 0) {
    accumulator.board = mergeObject(accumulator.board, chunkData.board);
  }

  // Merge installation details
  if (chunkData.installation && Object.keys(chunkData.installation).length > 0) {
    accumulator.installation = mergeObject(accumulator.installation, chunkData.installation);
  }

  // Merge supply characteristics
  if (chunkData.supply_characteristics && Object.keys(chunkData.supply_characteristics).length > 0) {
    accumulator.supply = mergeObject(accumulator.supply, chunkData.supply_characteristics);
  }
}

/**
 * Field mapping from ring reading slot to accumulator circuit field.
 */
const RING_FIELD_MAP = {
  r1: "ring_r1_ohm",
  rn: "ring_rn_ohm",
  r2: "ring_r2_ohm",
};

/**
 * Inject a single ring continuity reading directly into the accumulator.
 * Finds the circuit by name (fuzzy match) or creates one if none exists.
 */
export function injectRingReading(accumulator, circuitName, field, value) {
  const accField = RING_FIELD_MAP[field];
  if (!accField) return false;

  const nameLower = (circuitName || "").toLowerCase().trim();

  // Find existing circuit by name (same fuzzy logic as addChunk)
  let existingIdx = -1;
  if (nameLower) {
    existingIdx = accumulator.circuits.findIndex(c => {
      const existingName = (c.circuit_designation || "").toLowerCase().trim();
      if (!existingName) return false;
      return existingName.includes(nameLower) || nameLower.includes(existingName) ||
        existingName.split(/\s+/).sort().join(" ") === nameLower.split(/\s+/).sort().join(" ");
    });
  }

  // If no name match, use the most recent circuit
  if (existingIdx < 0 && accumulator.circuits.length > 0) {
    existingIdx = accumulator.circuits.length - 1;
  }

  if (existingIdx >= 0) {
    // Only set if not already filled (don't overwrite GPT-extracted values)
    if (!accumulator.circuits[existingIdx][accField] || accumulator.circuits[existingIdx][accField] === "") {
      accumulator.circuits[existingIdx][accField] = String(value);
    }
  } else {
    // No circuit exists yet — create one with the circuit name
    const newCircuit = { circuit_designation: circuitName || "" };
    newCircuit[accField] = String(value);
    accumulator.circuits.push(newCircuit);
  }

  return true;
}

/**
 * Inject a common reading (Ze, Zs, R1+R2, IR, RCD, PFC) directly into the accumulator.
 * Generalized version of injectRingReading — works for both supply-level and circuit-level fields.
 *
 * @param {Object} accumulator - The chunk accumulator
 * @param {Object} reading - { name, target, field, value, circuitName }
 *   target: "supply" or "circuit"
 *   field: the accumulator field name (e.g. "earth_loop_impedance_ze", "measured_zs_ohm")
 *   circuitName: circuit name for circuit-level fields (null for supply)
 * @returns {boolean} true if value was injected
 */
export function injectReading(accumulator, reading) {
  const { target, field, value, circuitName } = reading;

  if (target === "supply") {
    // Supply-level field: set on accumulator.supply if empty
    if (!accumulator.supply[field] || accumulator.supply[field] === "") {
      accumulator.supply[field] = String(value);
      return true;
    }
    return false;
  }

  // Circuit-level field: find by name (fuzzy match) or most recent circuit
  const nameLower = (circuitName || "").toLowerCase().trim();

  let existingIdx = -1;
  if (nameLower) {
    existingIdx = accumulator.circuits.findIndex(c => {
      const existingName = (c.circuit_designation || "").toLowerCase().trim();
      if (!existingName) return false;
      return existingName.includes(nameLower) || nameLower.includes(existingName) ||
        existingName.split(/\s+/).sort().join(" ") === nameLower.split(/\s+/).sort().join(" ");
    });
  }

  // Fall back to most recent circuit
  if (existingIdx < 0 && accumulator.circuits.length > 0) {
    existingIdx = accumulator.circuits.length - 1;
  }

  if (existingIdx >= 0) {
    // Only fill empty fields — never overwrite
    if (!accumulator.circuits[existingIdx][field] || accumulator.circuits[existingIdx][field] === "") {
      accumulator.circuits[existingIdx][field] = String(value);
      return true;
    }
    return false;
  }

  // No circuit exists yet — create one with the circuit name and value
  const newCircuit = { circuit_designation: circuitName || "" };
  newCircuit[field] = String(value);
  accumulator.circuits.push(newCircuit);
  return true;
}

/**
 * Add a photo to the accumulator and attempt to link it to observations.
 * Links based on timestamp proximity (within 30 seconds).
 */
export function addPhoto(accumulator, filename, audioSeconds) {
  const photo = {
    filename,
    audioSeconds,
    linkedToObservation: null,
  };

  // Try to link to an observation by source_photo field
  for (let i = 0; i < accumulator.observations.length; i++) {
    const obs = accumulator.observations[i];
    if (obs.source_photo === filename) {
      photo.linkedToObservation = i;
      if (!obs.photos) obs.photos = [];
      if (!obs.photos.includes(filename)) obs.photos.push(filename);
      break;
    }
  }

  // If no direct match, try timestamp proximity
  // (Observations from nearby audio chunks are likely related to this photo)
  if (photo.linkedToObservation === null && accumulator._chunkTimestamps.length > 0) {
    // Find observations that were added in chunks close to this photo's timestamp
    // For now, link to the most recent observation if it's within 30 seconds window
    const recentObs = accumulator.observations[accumulator.observations.length - 1];
    if (recentObs && !recentObs.photos?.length) {
      photo.linkedToObservation = accumulator.observations.length - 1;
      if (!recentObs.photos) recentObs.photos = [];
      recentObs.photos.push(filename);
    }
  }

  accumulator.photos.push(photo);
}

/**
 * Get the current accumulated data in the format expected by the API.
 * Returns data ready for the frontend and for S3 storage.
 */
export function getFormData(accumulator) {
  // Build linked photos array
  const linked_photos = accumulator.photos
    .filter(p => p.linkedToObservation !== null)
    .map(p => ({
      filename: p.filename,
      observationIndex: p.linkedToObservation,
      audioSeconds: p.audioSeconds,
    }));

  return {
    circuits: accumulator.circuits,
    observations: accumulator.observations,
    board_info: accumulator.board,
    installation_details: accumulator.installation,
    supply_characteristics: accumulator.supply,
    photos: accumulator.photos,
    metadata: {
      linked_photos,
      chunksProcessed: accumulator._chunkTimestamps.length,
    },
  };
}

/**
 * Finalize the accumulator before saving.
 * Does a final pass for photo-observation linking and data cleanup.
 */
export function finalize(accumulator) {
  // Final pass: link any unlinked photos to observations by proximity
  for (const photo of accumulator.photos) {
    if (photo.linkedToObservation !== null) continue;

    // Check all observations for source_photo match
    for (let i = 0; i < accumulator.observations.length; i++) {
      const obs = accumulator.observations[i];
      if (obs.source_photo === photo.filename) {
        photo.linkedToObservation = i;
        if (!obs.photos) obs.photos = [];
        if (!obs.photos.includes(photo.filename)) obs.photos.push(photo.filename);
        break;
      }
    }
  }

  // Sort circuits by circuit_ref
  accumulator.circuits.sort((a, b) => {
    const refA = parseInt(a.circuit_ref, 10) || 999;
    const refB = parseInt(b.circuit_ref, 10) || 999;
    return refA - refB;
  });

  // Ensure all observations have required fields
  for (const obs of accumulator.observations) {
    obs.code = obs.code || "C3";
    obs.item_location = obs.item_location || obs.title || "";
    obs.observation_text = obs.observation_text || obs.text || "";
    obs.photos = obs.photos || [];
  }

  return getFormData(accumulator);
}
