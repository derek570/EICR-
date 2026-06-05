/**
 * Circuit-resolution helpers shared across all dialogue scripts.
 *
 * `findCircuitByDesignation` was previously copy-pasted in
 * ring-continuity-script.js and insulation-resistance-script.js, with
 * the same key-mismatch bug in both (`bucket.designation` vs the
 * canonical `bucket.circuit_designation` written by
 * `_seedStateFromJobState`). Lifting it into one helper means future
 * key-shape changes land once.
 *
 * "Work on Board" hotfix slice 4 (2026-05-08) — replaced direct
 * `snapshot.circuits[ref]` walks with the dual-shape helpers
 * `getCircuitBucket` and `listCircuitRefsInBoard` so designation /
 * field reads scope to the ACTIVE board (snapshot.currentBoardId)
 * rather than walking every circuit on every board. Pre-fix a
 * sub-board flow on currentBoardId='sub-1' would designation-match
 * against main's circuits too (the bare-numeric keys), giving
 * cross-board false matches when a label like "Cooker" appeared
 * on multiple boards.
 */

import { getCircuitBucket, listCircuitRefsInBoard } from '../../stage6-multi-board-shape.js';

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
 * Look up circuits whose designation matches a transcript fragment.
 *
 * Returns `{ matched, candidates, sharedDesignation }`:
 *   - `matched` is the circuit_ref ONLY when exactly one designation
 *     matches; null on zero matches AND on 2+ matches (ambiguous).
 *   - `candidates` is every ref whose designation matched the user's
 *     text (length 0 → no match; length 1 → unique; length ≥ 2 →
 *     ambiguous, caller should disambiguate).
 *   - `sharedDesignation` is the lowercased designation string when
 *     EVERY candidate's designation collapses to the same canonical
 *     form (e.g. three circuits all labelled "Sockets" by CCU). null
 *     when candidates differ in designation. Used by the engine to
 *     emit "Which 'sockets' — circuit 2, 4 or 7?".
 *
 * Match rules (unchanged from the original `findCircuitByDesignation`):
 *   - Lowercase + collapse whitespace on BOTH sides.
 *   - Bidirectional substring: user's text may be a longer sentence
 *     containing the designation, or a shorter prefix of it.
 *   - Skips circuit 0 — that bucket is the supply / installation slot.
 *
 * Optional `restrictToRefs` narrows the search to a specific candidate
 * set. Used by the active-path disambiguation handler when the
 * inspector replies to a "Which 'sockets' — circuit 2, 4 or 7?" prompt
 * with a designation rather than a digit ("the kitchen one") — we want
 * to match against ONLY the three candidate circuits' designations,
 * not the whole board.
 *
 * The canonical schema key is `circuit_designation` (matching
 * `field_schema.json.circuit_fields` and what
 * `_seedStateFromJobState` writes). Falls back to bare `designation`
 * for legacy in-memory shapes — the existing test suites use that
 * form, and keeping the fallback avoids re-flowing every fixture.
 */
export function findCircuitsByDesignation(session, text, opts = {}) {
  const empty = { matched: null, candidates: [], sharedDesignation: null };
  if (typeof text !== 'string' || !text) return empty;
  const snapshot = session?.stateSnapshot;
  if (!snapshot?.circuits) return empty;
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalised) return empty;

  // Hotfix slice 4 — designation matching scopes to the ACTIVE board so
  // a sub-board flow doesn't false-match against main's designations.
  // listCircuitRefsInBoard returns refs filtered to currentBoardId under
  // dual-shape, OR every numeric ref under flag-off (legacy single-board
  // behaviour preserved). getCircuitBucket reads the right composite-key
  // bucket per ref. Array-shape snapshots (legacy in-memory) fall through
  // to the legacy walk to keep older fixtures green.
  const restrict =
    Array.isArray(opts.restrictToRefs) && opts.restrictToRefs.length > 0
      ? new Set(opts.restrictToRefs.map(Number))
      : null;

  const matches = [];
  const designationsByRef = new Map();

  if (Array.isArray(snapshot.circuits)) {
    // Array-shape — walk verbatim (legacy fixture compat).
    for (const c of snapshot.circuits) {
      if (!c || typeof c !== 'object') continue;
      const ref = Number(c.circuit_ref);
      if (!Number.isInteger(ref) || ref <= 0) continue;
      if (restrict && !restrict.has(ref)) continue;
      const designation = c.circuit_designation || c.designation;
      if (typeof designation !== 'string' || !designation.trim()) continue;
      const normDes = designation.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!normDes) continue;
      if (normalised.includes(normDes) || normDes.includes(normalised)) {
        matches.push(ref);
        designationsByRef.set(ref, normDes);
      }
    }
  } else {
    // Dual-shape — use the active-board-aware helpers.
    const activeBoardId = snapshot.currentBoardId;
    const refs = listCircuitRefsInBoard(snapshot, activeBoardId);
    for (const ref of refs) {
      if (!Number.isInteger(ref) || ref <= 0) continue;
      if (restrict && !restrict.has(ref)) continue;
      const bucket = getCircuitBucket(snapshot, ref, activeBoardId);
      if (!bucket || typeof bucket !== 'object') continue;
      const designation = bucket.circuit_designation || bucket.designation;
      if (typeof designation !== 'string' || !designation.trim()) continue;
      const normDes = designation.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!normDes) continue;
      if (normalised.includes(normDes) || normDes.includes(normalised)) {
        matches.push(ref);
        designationsByRef.set(ref, normDes);
      }
    }
  }

  // Deduplicate (in case the iteration produced a circuit twice via
  // string + number key collision).
  const candidates = Array.from(new Set(matches)).sort((a, b) => a - b);

  // Shared designation: only meaningful when every candidate collapsed
  // to the same canonical text. The CCU label pass deliberately stamps
  // adjacent circuits with identical labels ("Sockets" × 3, "Lighting"
  // × 2) — the engine quotes that shared label back to the inspector
  // ("Which 'sockets' — circuit 2, 4 or 7?"). When candidates have
  // distinct designations, no single quote-back is honest.
  let sharedDesignation = null;
  if (candidates.length >= 1) {
    const first = designationsByRef.get(candidates[0]) ?? null;
    if (first && candidates.every((r) => designationsByRef.get(r) === first)) {
      sharedDesignation = first;
    }
  }

  return {
    matched: candidates.length === 1 ? candidates[0] : null,
    candidates,
    sharedDesignation,
  };
}

/**
 * Backwards-compatible single-result wrapper. Returns the ref on a
 * unique match or null otherwise (zero AND ambiguous both → null).
 *
 * Kept so the legacy ring-continuity-script.js / insulation-resistance
 * -script.js paths and their test suites stay byte-identical. The live
 * dialogue-engine path uses `findCircuitsByDesignation` directly so it
 * can act on ambiguity instead of swallowing it.
 */
export function findCircuitByDesignation(session, text) {
  return findCircuitsByDesignation(session, text).matched;
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
  if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  } else if (circuits && typeof circuits === 'object') {
    // Hotfix slice 4 — use the dual-shape lookup so the read scopes to the
    // active board's bucket rather than the bare numeric key (which would
    // hit main's circuit even when currentBoardId is sub-1).
    bucket = getCircuitBucket(snapshot, circuit_ref, snapshot.currentBoardId) ?? null;
  }
  if (!bucket) return out;
  for (const f of fields) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}
