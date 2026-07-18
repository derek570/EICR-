/**
 * F/U-4 (Codex review, 2026-07-18) — `job_state_update` frame-shape
 * normalisation, shared by the sonnet-stream WS handler and its tests
 * (sonnet-stream.js itself cannot be imported under jest — its storage
 * dependency uses import.meta.dirname).
 *
 * The PWA nests the job under `msg.jobState` (web sonnet-session.ts
 * `sendJobStateUpdate`: `{type:'job_state_update', jobState}`), while iOS
 * sends the job fields FLAT on the frame. `updateJobState` only reads
 * top-level circuits/supply/boards, so before this every PWA mid-session
 * job-state update was a silent NO-OP — the snapshot never refreshed for web
 * (manual edits during recording were invisible to the model). Unwrap the
 * nested shape; the flat iOS shape passes through untouched.
 */
function isPlainRecord(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Codex r2 — a PRESENT-but-malformed nested jobState (array, null,
 * primitive) returns the null sentinel: falling back to the envelope would
 * hand updateJobState a frame with no job fields, whose schedule rebuild
 * CLEARS the existing circuit schedule (probed). The handler skips the
 * update (with a warn log) on null.
 */
/** The job-state fields updateJobState actually consumes. A payload with
 *  NONE of them own-present is envelope noise, not a job state — passing it
 *  through would rebuild (i.e. CLEAR) the circuit schedule from nothing.
 *  An explicit own `circuits: []` remains the valid way to clear. */
const JOB_STATE_FIELDS = [
  'circuits',
  'boards',
  'supply',
  'supply_characteristics',
  'supplyCharacteristics',
];

function carriesJobStateFields(payload) {
  return JOB_STATE_FIELDS.some((k) => Object.hasOwn(payload, k));
}

/** Codex r5 — recognized fields must also be STRUCTURALLY valid when
 *  present: a non-array circuits (null/{}/42) would clear the schedule or
 *  throw in buildCircuitSchedule; boards must be an array (or the production
 *  null sentinel); supply containers must be plain records (or null). */
function jobStateFieldsValid(payload) {
  if (Object.hasOwn(payload, 'circuits') && !Array.isArray(payload.circuits)) return false;
  if (Object.hasOwn(payload, 'boards') && payload.boards != null && !Array.isArray(payload.boards))
    return false;
  for (const k of ['supply', 'supply_characteristics', 'supplyCharacteristics']) {
    if (Object.hasOwn(payload, k) && payload[k] != null && !isPlainRecord(payload[k])) return false;
  }
  return true;
}

export function unwrapJobStateFrame(msg) {
  // Codex r3 — the plain-record contract applies to the OUTER frame too
  // (an array/Date/custom-prototype envelope is malformed, not a flat job).
  if (!isPlainRecord(msg)) return null;
  if (Object.hasOwn(msg, 'jobState')) {
    const js = msg.jobState;
    // Codex r4 — {jobState:{}} (and any nested payload with no recognized
    // job-state field) must be SKIPPED, not passed through: updateJobState
    // on a field-less object clears the existing circuit schedule.
    return isPlainRecord(js) && carriesJobStateFields(js) && jobStateFieldsValid(js) ? js : null;
  }
  // Flat iOS shape: same guards — an envelope-only frame carries no job.
  return carriesJobStateFields(msg) && jobStateFieldsValid(msg) ? msg : null;
}
