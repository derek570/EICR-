/**
 * PLAN-E1 — `UplinkScopeAllocator`: the recording-session-owned identity
 * source for the two scope kinds the uplink pipeline needs to attribute
 * PCM correctly across reconnects, pause/resume, and encoder generations.
 *
 * Two DELIBERATELY SEPARATE identity kinds (plan split-round-10 BLOCKER):
 * one handle cannot both (a) persist across a superseded/failed connect
 * for capture attribution, AND (b) resolve false-per-connect for
 * supersession — those are mutually incompatible lifetimes.
 *
 *  - `CaptureAttemptId` — the CAPTURE-scope identity. Reserved once before
 *    the mic tap can emit its first sample (idempotent via
 *    `reserveCaptureAttemptIfNeeded()`), retained across any number of
 *    superseded/failed connects, and retired only when an epoch is minted
 *    for it or capture ends.
 *  - `OpenAttemptHandle` — one per `connect()` invocation (E-WAKE's waiter
 *    identity: supersession, awaitOpen, the hold).
 *
 * A successful open maps its connection EPOCH back to the capture attempt
 * that was live when the socket was constructed (`mintEpoch`), so the
 * first socket epoch is parented by the capture attempt even when earlier
 * connects were superseded.
 *
 * Owned ONE-PER-RECORDING-SESSION by the session owner (NOT per
 * DeepgramService instance — a service is replaced on web pause/resume,
 * and an instance-local counter would restart and collide within one
 * session's ledger). Construct a fresh allocator at recording-session
 * start; ids never repeat within the lifetime of one instance.
 */

export type CaptureAttemptId = number & { readonly __brand: 'CaptureAttemptId' };
export type ConnectionEpoch = number & { readonly __brand: 'ConnectionEpoch' };

export interface OpenAttemptHandle {
  readonly id: number;
}

/**
 * The discriminated scope every captured (and synthetic) PCM range/report
 * carries. `epoch` — post-open, attributed to a minted connection epoch.
 * `preOpen` — before any epoch has been minted for the CURRENT capture
 * attempt (session start before first connect, pause/resume before the
 * reconnect completes, a capture-before-open transition). A preOpen range
 * is NEVER restamped with the epoch minted later — it is a permanent
 * historical record of "this audio arrived before any socket existed for
 * this capture attempt."
 */
export type EpochScope =
  | { readonly kind: 'epoch'; readonly id: ConnectionEpoch }
  | { readonly kind: 'preOpen'; readonly captureAttemptId: CaptureAttemptId };

export function epochScopeEquals(a: EpochScope, b: EpochScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'epoch' && b.kind === 'epoch') return a.id === b.id;
  if (a.kind === 'preOpen' && b.kind === 'preOpen')
    return a.captureAttemptId === b.captureAttemptId;
  return false;
}

export class UplinkScopeAllocator {
  private nextCaptureAttemptId = 1;
  private nextEpoch = 1;
  private nextOpenAttemptId = 1;

  // The currently-live capture attempt (retired the moment an epoch is
  // minted for it, or explicitly ended). `null` before the first
  // reservation of the session.
  private liveCaptureAttemptId: CaptureAttemptId | null = null;
  // The most recently minted epoch, if any is live for the CURRENT
  // connection. Cleared by the caller invalidating on disconnect is NOT
  // this allocator's job — it only mints; the service tracks "current".
  private lastMintedEpoch: ConnectionEpoch | null = null;

  /**
   * Idempotent reservation: returns the existing live CaptureAttemptId if
   * one hasn't been retired yet (no epoch minted against it, capture not
   * ended), otherwise mints a fresh one. Safe to call from every capture
   * start/resume site — double-calls are harmless.
   */
  reserveCaptureAttemptIfNeeded(): CaptureAttemptId {
    if (this.liveCaptureAttemptId === null) {
      this.liveCaptureAttemptId = this.nextCaptureAttemptId++ as CaptureAttemptId;
    }
    return this.liveCaptureAttemptId;
  }

  /** The currently live capture attempt, or null if none has been reserved
   *  (or the last one was retired by an epoch mint / explicit end). */
  currentCaptureAttemptId(): CaptureAttemptId | null {
    return this.liveCaptureAttemptId;
  }

  /** One per `connect()` invocation — the supersession/awaitOpen identity. */
  reserveOpenAttempt(): OpenAttemptHandle {
    return { id: this.nextOpenAttemptId++ };
  }

  /**
   * Called at the TOP of the platform's single socket-construction site
   * (web: `openSocket()`) on a SUCCESSFUL open. Mints a fresh epoch
   * parented by the given capture attempt (which may be the live one, or
   * — for a reconnect whose predecessor's epoch was already minted — a
   * freshly reserved one; callers reserve first via
   * `reserveCaptureAttemptIfNeeded()` if `currentCaptureAttemptId()` is
   * null). Retires the capture attempt (it is now epoch-scoped).
   */
  mintEpoch(captureAttemptId: CaptureAttemptId): ConnectionEpoch {
    const epoch = this.nextEpoch++ as ConnectionEpoch;
    this.lastMintedEpoch = epoch;
    if (this.liveCaptureAttemptId === captureAttemptId) {
      this.liveCaptureAttemptId = null;
    }
    return epoch;
  }

  /** Explicitly end the current capture attempt without minting an epoch
   *  (capture stopped before any connection succeeded). */
  endCaptureAttempt(): void {
    this.liveCaptureAttemptId = null;
  }

  /**
   * The scope PCM arriving RIGHT NOW should carry: `epoch(liveEpoch)` if a
   * connection is currently open, else `preOpen(captureAttemptId)` —
   * reserving a capture attempt if none is live yet.
   */
  currentScope(liveEpoch: ConnectionEpoch | null): EpochScope {
    if (liveEpoch !== null) {
      return { kind: 'epoch', id: liveEpoch };
    }
    return { kind: 'preOpen', captureAttemptId: this.reserveCaptureAttemptIfNeeded() };
  }

  /** Diagnostics only — the most recent epoch minted this session. */
  get lastEpoch(): ConnectionEpoch | null {
    return this.lastMintedEpoch;
  }
}
