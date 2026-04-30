/**
 * Circuit-resolution helpers shared across all dialogue scripts.
 *
 * `findCircuitByDesignation` was previously copy-pasted in
 * ring-continuity-script.js and insulation-resistance-script.js, with
 * the same key-mismatch bug in both (`bucket.designation` vs the
 * canonical `bucket.circuit_designation` written by
 * `_seedStateFromJobState`). Lifting it into one helper means future
 * key-shape changes land once.
 */

/**
 * Try the digit-form regex against a transcript. Recognises:
 *   - "circuit 13" / "circuit 13."
 *   - bare "13" / "13." (whole-utterance form, e.g. an answer to
 *     "Which circuit?")
 *
 * Returns the integer or null. Excludes 0 and negatives.
 */
export function parseCircuitDigit(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(/\bcircuit\s*(\d{1,3})\b|^\s*(\d{1,3})\s*\.?\s*$/i);
  if (!m) return null;
  const ref = Number(m[1] ?? m[2]);
  return Number.isInteger(ref) && ref > 0 ? ref : null;
}

/**
 * Look up a circuit by its designation in the snapshot. Used when the
 * inspector says or answers with the circuit name ("downstairs sockets")
 * instead of a number.
 *
 * The canonical schema key is `circuit_designation` (matching
 * `field_schema.json.circuit_fields` and what
 * `_seedStateFromJobState` writes). Falls back to bare `designation` for
 * legacy in-memory shapes — the existing test suites use that form, and
 * keeping the fallback avoids re-flowing every fixture.
 *
 * Match rules:
 *   - Lowercase + collapse whitespace on BOTH sides.
 *   - Bidirectional substring: user's text may be a longer sentence
 *     containing the designation, or a shorter prefix of it.
 *   - Returns the circuit_ref if exactly ONE designation matches.
 *   - Returns null if zero or two-plus circuits match (ambiguous).
 *   - Skips circuit 0 — that bucket is the supply / installation slot.
 */
export function findCircuitByDesignation(session, text) {
  if (typeof text !== 'string' || !text) return null;
  const snapshot = session?.stateSnapshot;
  if (!snapshot?.circuits) return null;
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalised) return null;

  const circuits = snapshot.circuits;
  const entries = Array.isArray(circuits)
    ? circuits.map((c) => [c?.circuit_ref, c])
    : Object.entries(circuits);

  const matches = [];
  for (const [refKey, bucket] of entries) {
    if (!bucket || typeof bucket !== 'object') continue;
    const ref = Number(refKey);
    if (!Number.isInteger(ref) || ref <= 0) continue;
    const designation = bucket.circuit_designation || bucket.designation;
    if (typeof designation !== 'string' || !designation.trim()) continue;
    const normDes = designation.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normDes) continue;
    if (normalised.includes(normDes) || normDes.includes(normalised)) {
      matches.push(ref);
    }
  }
  // Deduplicate (in case the iteration produced a circuit twice via
  // string + number key collision).
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Read whatever values for a given list of fields already exist on the
 * snapshot for a circuit. Used at script-entry time to seed the values
 * map from the persisted state (so the first ask skips slots that are
 * already filled from a prior session or manual entry).
 *
 * Tolerant of `circuits` being either Object or Array — the snapshot
 * shape can vary across mutators.
 */
export function readExistingValues(session, circuit_ref, fields) {
  const out = {};
  const snapshot = session?.stateSnapshot;
  if (!snapshot) return out;
  const circuits = snapshot.circuits;
  let bucket = null;
  if (circuits && typeof circuits === 'object' && !Array.isArray(circuits)) {
    bucket = circuits[circuit_ref] || circuits[String(circuit_ref)] || null;
  } else if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  }
  if (!bucket) return out;
  for (const f of fields) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}
