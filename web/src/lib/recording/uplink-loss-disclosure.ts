/**
 * PLAN-E2 — the disclosure DELIVERY ledger: one operation token per
 * disclosure moment, exactly-once spoken, independent of the 30s text
 * dedupe (every disclosure is the SAME string, so two outages in one
 * session must both be heard).
 *
 * Rules (the plan's single definition of terminal):
 *  - At most ONE token OUTSTANDING per recording session. A token is
 *    TERMINAL only on NATURAL COMPLETION; discard, preemption, barge-in,
 *    interruption and playback failure all return it to `pending` — it
 *    stays outstanding and REPLAYS.
 *  - A new source reaching its disclosure moment JOINS the outstanding
 *    token only if that token has NOT started playback (`pending`); if it
 *    is `playing`, the source stays UNASSOCIATED and joins-or-mints a
 *    successor at the active token's natural completion.
 *  - Session-scoped: every token is stamped with the session id current at
 *    MINT; a token from an earlier session is dropped the first time it is
 *    observed, so a frozen `stop()` can never leave the slot occupied.
 *  - `uplink_loss_episode_disclosed` is emitted idempotently per
 *    `LossSourceId` at ASSOCIATION (mint or later join) — never at playback.
 *
 * The queue mechanics (protected enqueue, re-park scheduling, parking gate)
 * live in `tts.ts`; this module is the pure state machine so the matrix is
 * unit-testable on its own. Swift twin: `UplinkLossDisclosure.swift`.
 */

import { lossSourceIdKey, type LossSourceId } from './uplink-loss-ledger';

export const UPLINK_LOSS_DISCLOSURE_TEXT =
  "Some recent audio may not have been transcribed. Check your recent readings and repeat only anything that's missing.";

export type DisclosureTokenState = 'pending' | 'playing' | 'completed';

export interface DisclosureToken {
  readonly id: number;
  readonly sessionId: string;
  state: DisclosureTokenState;
  /** PLAN-E-TERM iterates this at completion; this plan only appends on join. */
  readonly coveredLossSourceIds: LossSourceId[];
  /** PLAN-E-TERM — true once real audio began. A `completed` that never
   *  passed through `playing` (an entry-cancel `onEnd` before playback) is
   *  NOT evidence the inspector heard anything: E2's completion accounting
   *  runs unchanged, but the durable record and the source-cardinal counter
   *  only honour a completion that played. */
  hasPlayed: boolean;
}

export type DisclosureRequestOutcome =
  | { readonly action: 'minted'; readonly token: DisclosureToken }
  | { readonly action: 'joined'; readonly token: DisclosureToken }
  | { readonly action: 'awaiting'; readonly token: DisclosureToken };

export type UplinkLossDisclosureTelemetryEvent =
  | 'uplink_loss_episode_disclosed'
  /** PLAN-E-TERM — SOURCE-cardinal: once per covered `LossSourceId` at a
   *  token's NATURAL completion (never at mint — minting is not evidence
   *  the inspector heard anything). */
  | 'uplink_loss_episode_disclosure_completed';

export interface UplinkLossDisclosureLedgerOptions {
  /** A token was minted (fresh or successor) — the caller must deliver it. */
  readonly onMint: (token: DisclosureToken) => void;
  readonly telemetry?: (
    event: UplinkLossDisclosureTelemetryEvent,
    payload: Record<string, unknown>
  ) => void;
  /** PLAN-E-TERM — a token reached NATURAL completion; `token.
   *  coveredLossSourceIds` is the set the durable record resolves. Fired
   *  BEFORE any successor is minted. */
  readonly onCompleted?: (token: DisclosureToken) => void;
}

export class UplinkLossDisclosureLedger {
  private outstanding: DisclosureToken | null = null;
  /** Sources that reached their moment while the token was PLAYING. */
  private awaiting: LossSourceId[] = [];
  private nextTokenId = 1;
  private readonly disclosedKeys = new Set<string>();
  private readonly completedKeys = new Set<string>();
  private completedCount = 0;

  constructor(private readonly options: UplinkLossDisclosureLedgerOptions) {}

  /** A disclosure moment for `sourceIds` in `sessionId`. */
  request(sessionId: string, sourceIds: LossSourceId[]): DisclosureRequestOutcome {
    this.dropStaleIfAny(sessionId);
    if (!this.outstanding) {
      const token = this.mint(sessionId, sourceIds);
      return { action: 'minted', token };
    }
    if (this.outstanding.state === 'pending') {
      this.associate(this.outstanding, sourceIds);
      return { action: 'joined', token: this.outstanding };
    }
    this.awaiting.push(...sourceIds);
    return { action: 'awaiting', token: this.outstanding };
  }

  /** The token's clip began real audio. */
  onPlaybackStarted(tokenId: number): void {
    const t = this.outstanding;
    if (!t || t.id !== tokenId || t.state !== 'pending') return;
    t.state = 'playing';
    t.hasPlayed = true;
  }

  /** NATURAL completion — the SOLE terminal exit. Mints a successor for
   *  anything that awaited while this one played. */
  onNaturalCompletion(tokenId: number): DisclosureToken | null {
    const t = this.outstanding;
    if (!t || t.id !== tokenId) return null;
    t.state = 'completed';
    this.completedCount += 1;
    this.outstanding = null;
    // PLAN-E-TERM — the SOURCE-cardinal completion counter: once per
    // covered `LossSourceId` (idempotent per session|source, like
    // `disclosed`), so two episodes covered by one token count 2. E2's own
    // three counters are untouched. The binder resolves each covered
    // source's durable record from `onCompleted`. ONLY a completion that
    // actually PLAYED counts (Codex E-TERM cycle-1: an entry-cancel
    // `onEnd` can reach a still-pending token; E2's accounting above is
    // unchanged, but an unheard clip must not resolve the record).
    if (!t.hasPlayed) return this.mintSuccessorIfAwaiting(t);
    for (const id of t.coveredLossSourceIds) {
      const sessionKey = `${t.sessionId}|${lossSourceIdKey(id)}`;
      if (this.completedKeys.has(sessionKey)) continue;
      this.completedKeys.add(sessionKey);
      this.options.telemetry?.('uplink_loss_episode_disclosure_completed', {
        source: lossSourceIdKey(id),
        token: t.id,
      });
    }
    this.options.onCompleted?.(t);
    return this.mintSuccessorIfAwaiting(t);
  }

  private mintSuccessorIfAwaiting(t: DisclosureToken): DisclosureToken | null {
    if (this.awaiting.length === 0) return null;
    const ids = this.awaiting;
    this.awaiting = [];
    return this.mint(t.sessionId, ids);
  }

  /** Any NON-natural terminal (pre-start discard, preemption of a playing
   *  head, playback failure, interruption): atomically back to `pending`.
   *  Still outstanding; the caller replays it. Returns the token iff it
   *  transitioned. */
  onNonNaturalTerminal(tokenId: number): DisclosureToken | null {
    const t = this.outstanding;
    if (!t || t.id !== tokenId || t.state === 'completed') return null;
    t.state = 'pending';
    // The NEXT attempt must prove its own playback (Codex mini-review).
    t.hasPlayed = false;
    return t;
  }

  /** Session teardown — abandon queue ownership: no replay, no completion
   *  accounting. The next session's slot is immediately free. */
  abandonForSessionTeardown(): void {
    this.outstanding = null;
    this.awaiting = [];
  }

  get outstandingToken(): DisclosureToken | null {
    return this.outstanding;
  }

  get isPlaying(): boolean {
    return this.outstanding?.state === 'playing';
  }

  get awaitingSourceCount(): number {
    return this.awaiting.length;
  }

  get naturalCompletionCount(): number {
    return this.completedCount;
  }

  private dropStaleIfAny(sessionId: string): void {
    if (this.outstanding && this.outstanding.sessionId !== sessionId) {
      this.outstanding = null;
      this.awaiting = [];
    }
  }

  private mint(sessionId: string, sourceIds: LossSourceId[]): DisclosureToken {
    const token: DisclosureToken = {
      id: this.nextTokenId++,
      sessionId,
      state: 'pending',
      coveredLossSourceIds: [],
      hasPlayed: false,
    };
    this.outstanding = token;
    this.associate(token, sourceIds);
    this.options.onMint(token);
    return token;
  }

  private associate(token: DisclosureToken, sourceIds: LossSourceId[]): void {
    for (const id of sourceIds) {
      const key = lossSourceIdKey(id);
      if (token.coveredLossSourceIds.some((c) => lossSourceIdKey(c) === key)) continue;
      token.coveredLossSourceIds.push(id);
      // Idempotency is per (session, source): every session's loss ledger
      // restarts its ids at 1, so a bare source key would suppress the
      // counter for every session after the first.
      const sessionKey = `${token.sessionId}|${key}`;
      if (this.disclosedKeys.has(sessionKey)) continue;
      this.disclosedKeys.add(sessionKey);
      this.options.telemetry?.('uplink_loss_episode_disclosed', { source: key, token: token.id });
    }
  }
}
