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
export function unwrapJobStateFrame(msg) {
  return msg?.jobState && typeof msg.jobState === 'object' ? msg.jobState : msg;
}
