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
export function unwrapJobStateFrame(msg) {
  if (msg == null || typeof msg !== 'object') return null;
  if (Object.hasOwn(msg, 'jobState')) {
    return isPlainRecord(msg.jobState) ? msg.jobState : null;
  }
  return msg;
}
