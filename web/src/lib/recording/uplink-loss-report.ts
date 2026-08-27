/**
 * PLAN-E1 — the `onUndispatchedLoss` seam.
 *
 * The sender owns audio from raw-PCM acceptance through transport dispatch.
 * On an unexpected teardown (socket failure, reconnect, stale delayed
 * callback), any samples accepted but not yet handed off to the socket —
 * generation-bound input pending inside the encoder/container, or a
 * queued-but-unsent frame — are CONFIRMED local loss, charged via this
 * seam BEFORE the reset.
 *
 * The payload is ONE IMMUTABLE struct (split-round-3 BLOCKER): an OWNED
 * raw-PCM snapshot (copied at report time — never a live/mutable buffer
 * reference), the recording-session id, the CONNECTION EPOCH — narrowed to
 * the `epoch` discriminant only (encoder residue is necessarily post-open;
 * there is no such thing as pre-open encoder residue), and the capture
 * sample range that produced it. Default-bound to a no-op + telemetry
 * counter (`uplink_encoder_loss_unbound`) until PLAN-E2 binds it as ledger
 * entry type (d) in its own PR — the land-a-seam-then-bind pattern.
 */

import type { ConnectionEpoch } from './uplink-scope-allocator';
import type { CaptureSampleRange } from './tagged-pcm-segment';

export interface UndispatchedLossReport {
  /** Owned snapshot — copied at report time, never a live/mutable ref. */
  readonly samples: Int16Array;
  readonly recordingSessionId: string;
  /** Narrowed to `epoch` — encoder residue is necessarily post-open. */
  readonly epoch: ConnectionEpoch;
  readonly captureSampleRange: CaptureSampleRange;
}

export type UndispatchedLossHandler = (report: UndispatchedLossReport) => void;

let unboundLossCount = 0;

/** Diagnostics-only counter for the default no-op path (telemetry, not a
 *  ledger — PLAN-E2 supplies the real binding). Exposed for tests; reset
 *  between test files via `resetUnboundLossTelemetry()`. */
export function unboundLossTelemetryCount(): number {
  return unboundLossCount;
}

export function resetUnboundLossTelemetry(): void {
  unboundLossCount = 0;
}

/**
 * The default no-op + telemetry handler. `onUndispatchedLoss` on a
 * DeepgramService instance is initialised to this and may be REPLACED
 * (never removed) by a consumer — PLAN-E2 replaces it with the real
 * ledger-binding handler in its own PR.
 */
export const defaultUndispatchedLossHandler: UndispatchedLossHandler = (_report) => {
  unboundLossCount += 1;
};

// ── Graceful-stop residue telemetry (separate from the ledger-adjacent
// onUndispatchedLoss seam above) ──────────────────────────────────────────
//
// On a graceful pause/stop, unflushable encoder residue is COUNTED and
// telemetered ONLY — it creates NO episode, NO token, NO clip, and NO
// carried ledger entry this wave (round-25: disclosure of this residue is
// a precondition of the Opus default-flip, recorded as a named follow-up,
// not shipped here). This counter is dark in production while the Opus
// flag ships default-OFF.

let gracefulResidueCount = 0;

export function chargeGracefulResidueTelemetry(residueFrameCount: number): void {
  gracefulResidueCount += residueFrameCount;
}

export function gracefulResidueTelemetryCount(): number {
  return gracefulResidueCount;
}

export function resetGracefulResidueTelemetry(): void {
  gracefulResidueCount = 0;
}
