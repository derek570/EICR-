/**
 * Held-fragment clarification obligation (A02D, 2026-09-09).
 *
 * When a same-epoch final is HELD (its confirmed onset precedes a manual
 * clear/replacement tap on that epoch, or it is `unbounded` while such a
 * cutoff applies) the client forwards nothing, writes nothing, runs no local
 * command and consumes no ask — and speaks EXACTLY ONCE, through the
 * confirmation FIFO, one clarification line naming the destinations cleared
 * or replaced manually since that epoch's last accepted final:
 *
 *   "I heard something just as you cleared circuit 4 Zs. Say it again if it
 *    should apply."                                       (one destination)
 *   "… just as you cleared circuit 4 Zs and client name. …"         (two)
 *   "… just as you cleared circuit 4 Zs, circuit 3 R1 plus R2, and Ze. …"
 *                                                                  (three)
 *   "I heard something just as you cleared those fields. Say it again if it
 *    should apply."                                        (four or more)
 *
 * This is a distinct obligation with PLAN-E2's token lifecycle
 * (`uplink-loss-disclosure.ts`), plus a TEXT-FREEZE boundary E2 never
 * needed because its line is constant while this one names destinations:
 *
 *  - identity `{session, epoch, final_sequence}` — duplicate callbacks of the
 *    same final dedupe to one token, before AND after that token played
 *    (the provider reuses the FinalWindowV1 record for a re-delivered
 *    provider final, so the key coincides; the ledger remembers disclosed
 *    keys, bounded, until session teardown);
 *  - at most ONE outstanding token per session;
 *  - a second held final MERGES its destinations into the outstanding token
 *    only while that token's text is still unfrozen (unsynthesised and
 *    unenqueued); once frozen, the later fragment stays unassociated, its
 *    destinations join an AWAITING set, and a SUCCESSOR token with its own
 *    wording is minted at the current token's natural completion — a
 *    fragment is only ever counted as disclosed by wording that actually
 *    played;
 *  - terminal only on natural playback completion; re-parked (back to
 *    `pending`, text kept) on preemption, overflow, TTS unavailability,
 *    playback failure and discard; abandoned at session teardown.
 *
 * Held audio is NOT a PLAN-E2 loss (it was transcribed and specifically
 * disclosed) and is charged to no E2 counter; this obligation has its own
 * counters (held, spoken). Templates are pinned byte-equal to
 * `config/regex-freshness-vectors.json` `clarification_templates`.
 */

export const HELD_FRAGMENT_CLARIFICATION_NAMED_TEMPLATE =
  'I heard something just as you cleared {destinations}. Say it again if it should apply.';
export const HELD_FRAGMENT_CLARIFICATION_MANY_TEXT =
  'I heard something just as you cleared those fields. Say it again if it should apply.';
export const HELD_FRAGMENT_CLARIFICATION_MAX_NAMED = 3;

/** Render the line for an ordered, unique destination list. */
export function renderHeldFragmentClarification(destinations: readonly string[]): string {
  const unique = destinations.filter((d, i) => d && destinations.indexOf(d) === i);
  if (unique.length === 0 || unique.length > HELD_FRAGMENT_CLARIFICATION_MAX_NAMED) {
    return HELD_FRAGMENT_CLARIFICATION_MANY_TEXT;
  }
  let list: string;
  if (unique.length === 1) list = unique[0];
  else if (unique.length === 2) list = `${unique[0]} and ${unique[1]}`;
  else list = `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
  return HELD_FRAGMENT_CLARIFICATION_NAMED_TEMPLATE.replace('{destinations}', list);
}

export type ClarificationTokenState = 'pending' | 'playing' | 'completed';

export interface ClarificationToken {
  readonly id: number;
  readonly sessionId: string;
  state: ClarificationTokenState;
  /** Final keys (`session|epoch|sequence`) this token discloses. */
  readonly finalKeys: string[];
  /** Ordered unique destination phrases. */
  readonly destinations: string[];
  /** Non-null once the wording is frozen (prepared/enqueued/playing). */
  frozenText: string | null;
}

export type ClarificationRequestOutcome =
  | { readonly action: 'minted'; readonly token: ClarificationToken }
  | { readonly action: 'merged'; readonly token: ClarificationToken }
  | { readonly action: 'awaiting'; readonly token: ClarificationToken }
  /** The final was already disclosed (by the outstanding token, an awaiting
   *  set, or a token that PLAYED to completion): nothing is minted. `token`
   *  is the outstanding one when there is one. */
  | { readonly action: 'duplicate'; readonly token: ClarificationToken | null };

/** Bound on remembered final keys per session (a key is a few dozen bytes;
 *  a session holds far fewer finals than this). */
export const HELD_FRAGMENT_KNOWN_FINAL_KEYS_MAX = 512;

export interface HeldFragmentClarificationLedgerOptions {
  /** Deliver (or re-deliver) a token. */
  readonly onMint: (token: ClarificationToken) => void;
  readonly telemetry?: (event: string, payload: Record<string, unknown>) => void;
}

export class HeldFragmentClarificationLedger {
  private outstanding: ClarificationToken | null = null;
  private awaiting: { finalKeys: string[]; destinations: string[] } | null = null;
  /** Final keys already disclosed by a token that PLAYED to completion, or
   *  currently associated with the outstanding/awaiting sets. */
  private readonly knownFinalKeys = new Set<string>();
  private nextId = 1;
  private heldTotal = 0;
  private spokenTotal = 0;

  constructor(private readonly opts: HeldFragmentClarificationLedgerOptions) {}

  /** A held final. Mint-or-merge-or-await under the text-freeze rule. */
  request(
    sessionId: string,
    finalKey: string,
    destinations: readonly string[]
  ): ClarificationRequestOutcome {
    const current = this.outstanding;
    if (current && current.sessionId !== sessionId) {
      // A token from an earlier session can never be adopted: abandon it.
      this.abandonForSessionTeardown();
    }
    const token = this.outstanding;
    // Codex diff-review cycle 1, BLOCKER 3: a duplicate delivery is a
    // duplicate whether or not a token is outstanding — after natural
    // completion the key is still known, and re-minting would speak the
    // same final's clarification twice.
    if (this.knownFinalKeys.has(finalKey)) {
      this.opts.telemetry?.('a02d_clarification_duplicate_final', {
        token: token?.id ?? null,
        finalKey,
      });
      return { action: 'duplicate', token };
    }
    this.heldTotal += 1;
    this.knownFinalKeys.add(finalKey);
    while (this.knownFinalKeys.size > HELD_FRAGMENT_KNOWN_FINAL_KEYS_MAX) {
      const oldest = this.knownFinalKeys.values().next().value;
      if (oldest === undefined) break;
      this.knownFinalKeys.delete(oldest);
    }
    if (!token) {
      const minted: ClarificationToken = {
        id: this.nextId++,
        sessionId,
        state: 'pending',
        finalKeys: [finalKey],
        destinations: uniq(destinations),
        frozenText: null,
      };
      this.outstanding = minted;
      this.opts.telemetry?.('a02d_clarification_minted', {
        token: minted.id,
        destinations: minted.destinations.length,
      });
      this.opts.onMint(minted);
      return { action: 'minted', token: minted };
    }
    if (token.frozenText === null && token.state === 'pending') {
      token.finalKeys.push(finalKey);
      for (const d of uniq(destinations))
        if (!token.destinations.includes(d)) token.destinations.push(d);
      this.opts.telemetry?.('a02d_clarification_merged', {
        token: token.id,
        destinations: token.destinations.length,
      });
      return { action: 'merged', token };
    }
    // Frozen (prepared/enqueued/playing): the later fragment awaits a successor.
    const aw = this.awaiting ?? { finalKeys: [], destinations: [] };
    aw.finalKeys.push(finalKey);
    for (const d of uniq(destinations)) if (!aw.destinations.includes(d)) aw.destinations.push(d);
    this.awaiting = aw;
    this.opts.telemetry?.('a02d_clarification_awaiting', {
      token: token.id,
      awaitingFinals: aw.finalKeys.length,
    });
    return { action: 'awaiting', token };
  }

  /** The TEXT-FREEZE boundary: called when the wording is prepared for
   *  synthesis or enqueued. Idempotent; returns the frozen wording. */
  freezeText(tokenId: number): string | null {
    const token = this.outstanding;
    if (!token || token.id !== tokenId) return null;
    if (token.frozenText === null) {
      token.frozenText = renderHeldFragmentClarification(token.destinations);
      this.opts.telemetry?.('a02d_clarification_text_frozen', { token: token.id });
    }
    return token.frozenText;
  }

  onPlaybackStarted(tokenId: number): void {
    const token = this.outstanding;
    if (!token || token.id !== tokenId || token.state !== 'pending') return;
    if (token.frozenText === null) this.freezeText(tokenId);
    token.state = 'playing';
    this.opts.telemetry?.('a02d_clarification_playing', { token: token.id });
  }

  /** The ONLY terminal. Returns the successor token if fragments awaited. */
  onNaturalCompletion(tokenId: number): ClarificationToken | null {
    const token = this.outstanding;
    if (!token || token.id !== tokenId) return null;
    token.state = 'completed';
    this.outstanding = null;
    this.spokenTotal += 1;
    this.opts.telemetry?.('a02d_clarification_spoken', {
      token: token.id,
      finals: token.finalKeys.length,
      destinations: token.destinations.length,
    });
    const aw = this.awaiting;
    this.awaiting = null;
    if (!aw) return null;
    const successor: ClarificationToken = {
      id: this.nextId++,
      sessionId: token.sessionId,
      state: 'pending',
      finalKeys: aw.finalKeys,
      destinations: aw.destinations,
      frozenText: null,
    };
    this.outstanding = successor;
    this.opts.telemetry?.('a02d_clarification_successor_minted', {
      token: successor.id,
      finals: successor.finalKeys.length,
    });
    this.opts.onMint(successor);
    return successor;
  }

  /** Preemption / overflow / discard / playback failure: back to pending
   *  (wording kept — it names what it names). Returns the token to replay. */
  onNonNaturalTerminal(tokenId: number): ClarificationToken | null {
    const token = this.outstanding;
    if (!token || token.id !== tokenId) return null;
    token.state = 'pending';
    this.opts.telemetry?.('a02d_clarification_reparked', { token: token.id });
    return token;
  }

  abandonForSessionTeardown(): void {
    if (this.outstanding) {
      this.opts.telemetry?.('a02d_clarification_abandoned', { token: this.outstanding.id });
    }
    this.outstanding = null;
    this.awaiting = null;
    this.knownFinalKeys.clear();
  }

  get outstandingToken(): ClarificationToken | null {
    return this.outstanding;
  }
  get isPlaying(): boolean {
    return this.outstanding?.state === 'playing';
  }
  get awaitingFinalCount(): number {
    return this.awaiting?.finalKeys.length ?? 0;
  }
  /** Counters: held finals requested, clarifications spoken to completion. */
  get heldFinalCount(): number {
    return this.heldTotal;
  }
  get spokenCount(): number {
    return this.spokenTotal;
  }
}

function uniq(list: readonly string[]): string[] {
  return list.filter((d, i) => d && list.indexOf(d) === i);
}
