/**
 * A02D — held-fragment clarification token lifecycle (PLAN-E2's token
 * contract plus the TEXT-FREEZE boundary): one outstanding token per
 * session, duplicate finals dedupe, merge-before-freeze, await-after-freeze
 * with a successor at natural completion, re-park on every non-natural
 * terminal, abandon at teardown, and the two counters.
 */
import { describe, expect, it } from 'vitest';
import {
  HeldFragmentClarificationLedger,
  renderHeldFragmentClarification,
  type ClarificationToken,
} from '@/lib/recording/held-fragment-clarification';

function ledger() {
  const minted: ClarificationToken[] = [];
  const events: string[] = [];
  const l = new HeldFragmentClarificationLedger({
    onMint: (t) => minted.push(t),
    telemetry: (e) => events.push(e),
  });
  return { l, minted, events };
}

describe('rendering', () => {
  it('one, two, three named; four → those fields; duplicates collapse', () => {
    expect(renderHeldFragmentClarification(['circuit 4 Zs'])).toBe(
      'I heard something just as you cleared circuit 4 Zs. Say it again if it should apply.'
    );
    expect(renderHeldFragmentClarification(['a', 'b'])).toContain('cleared a and b.');
    expect(renderHeldFragmentClarification(['a', 'b', 'c'])).toContain('cleared a, b, and c.');
    expect(renderHeldFragmentClarification(['a', 'b', 'c', 'd'])).toContain(
      'cleared those fields.'
    );
    expect(renderHeldFragmentClarification(['a', 'a'])).toContain('cleared a.');
  });
});

describe('token lifecycle', () => {
  it('mint → merge (unfrozen) → freeze → await → successor at natural completion', () => {
    const { l, minted } = ledger();
    const r1 = l.request('S', 'S|1|1', ['circuit 4 Zs']);
    expect(r1.action).toBe('minted');
    expect(minted).toHaveLength(1);
    const r2 = l.request('S', 'S|1|2', ['Ze']);
    expect(r2.action).toBe('merged');
    expect(r2.token.destinations).toEqual(['circuit 4 Zs', 'Ze']);
    // Duplicate callback of the same final: one token.
    expect(l.request('S', 'S|1|2', ['Ze']).action).toBe('duplicate');
    const text = l.freezeText(r1.token.id);
    expect(text).toContain('circuit 4 Zs and Ze');
    // After the freeze a third held final AWAITS a successor with its own wording.
    const r3 = l.request('S', 'S|1|3', ['client name']);
    expect(r3.action).toBe('awaiting');
    expect(l.awaitingFinalCount).toBe(1);
    expect(r1.token.frozenText).toBe(text); // unchanged by the later fragment
    l.onPlaybackStarted(r1.token.id);
    expect(l.isPlaying).toBe(true);
    const successor = l.onNaturalCompletion(r1.token.id);
    expect(successor).not.toBeNull();
    expect(successor!.destinations).toEqual(['client name']);
    expect(successor!.finalKeys).toEqual(['S|1|3']);
    expect(minted).toHaveLength(2);
    expect(l.spokenCount).toBe(1);
    expect(l.heldFinalCount).toBe(3);
    expect(l.outstandingToken?.id).toBe(successor!.id);
  });

  it('a non-natural terminal re-parks the same token (wording kept); teardown abandons', () => {
    const { l } = ledger();
    const t = l.request('S', 'S|1|1', ['Ze']).token;
    l.freezeText(t.id);
    l.onPlaybackStarted(t.id);
    const reparked = l.onNonNaturalTerminal(t.id);
    expect(reparked?.id).toBe(t.id);
    expect(reparked?.state).toBe('pending');
    expect(reparked?.frozenText).toContain('Ze');
    expect(l.onNonNaturalTerminal(999)).toBeNull();
    l.abandonForSessionTeardown();
    expect(l.outstandingToken).toBeNull();
    expect(l.spokenCount).toBe(0);
    // A new request after teardown mints afresh — and a previous session's
    // final key is not treated as a duplicate.
    expect(l.request('S2', 'S|1|1', ['Ze']).action).toBe('minted');
  });

  it('a token from an earlier session is abandoned when a new session requests', () => {
    const { l } = ledger();
    const old = l.request('S1', 'S1|1|1', ['Ze']).token;
    const fresh = l.request('S2', 'S2|1|1', ['PFC']);
    expect(fresh.action).toBe('minted');
    expect(fresh.token.id).not.toBe(old.id);
    expect(l.outstandingToken?.sessionId).toBe('S2');
  });

  it('playback-started freezes the text if nothing else did; completion of a stale id is a no-op', () => {
    const { l } = ledger();
    const t = l.request('S', 'S|1|1', ['Ze']).token!;
    l.onPlaybackStarted(t.id);
    expect(t.frozenText).not.toBeNull();
    expect(l.onNaturalCompletion(42)).toBeNull();
    expect(l.outstandingToken?.id).toBe(t.id);
  });

  it('[invariant] a duplicate final key is a duplicate BEFORE and AFTER the token played: nothing is re-minted, counters unchanged; teardown forgets the keys', () => {
    const { l, minted } = ledger();
    const t = l.request('S', 'S|1|7', ['circuit 4 Zs']).token!;
    expect(l.request('S', 'S|1|7', ['circuit 4 Zs'])).toEqual({ action: 'duplicate', token: t });
    l.onPlaybackStarted(t.id);
    l.onNaturalCompletion(t.id);
    expect(l.outstandingToken).toBeNull();
    expect(l.spokenCount).toBe(1);
    // After natural completion the key is still known: no second token.
    expect(l.request('S', 'S|1|7', ['circuit 4 Zs'])).toEqual({ action: 'duplicate', token: null });
    expect(minted).toHaveLength(1);
    expect(l.heldFinalCount).toBe(1);
    expect(l.spokenCount).toBe(1);
    // A genuinely new final mints again.
    expect(l.request('S', 'S|1|8', ['Ze']).action).toBe('minted');
    expect(minted).toHaveLength(2);
    // Teardown forgets every key (a new session may reuse sequences).
    l.abandonForSessionTeardown();
    expect(l.request('S2', 'S|1|7', ['circuit 4 Zs']).action).toBe('minted');
  });
});
