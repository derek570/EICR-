/**
 * PLAN-E2 — the delivery-token ledger's state machine (test 2e (a)–(d),
 * (g); the terminal definition; join timing; session scoping; the
 * `disclosed` counter at ASSOCIATION).
 */
import { describe, expect, it } from 'vitest';
import {
  UplinkLossDisclosureLedger,
  type DisclosureToken,
} from '@/lib/recording/uplink-loss-disclosure';
import { lossSourceIdKey, type LossSourceId } from '@/lib/recording/uplink-loss-ledger';

const episode = (id: number): LossSourceId => ({ kind: 'episode', id });
const staged = (id: number): LossSourceId => ({ kind: 'stagedLoss', id });
const window = (id: number): LossSourceId => ({ kind: 'preOpenWindow', id });

function harness() {
  const minted: DisclosureToken[] = [];
  const disclosed: string[] = [];
  const ledger = new UplinkLossDisclosureLedger({
    onMint: (t) => minted.push(t),
    telemetry: (event, payload) => {
      if (event === 'uplink_loss_episode_disclosed') disclosed.push(String(payload.source));
    },
  });
  return { ledger, minted, disclosed };
}

describe('UplinkLossDisclosureLedger — mint / join / await (2e)', () => {
  it('(a) a pre-open window AND an episode at one moment → ONE token carrying both ids', () => {
    const { ledger, minted, disclosed } = harness();
    const r = ledger.request('S', [window(1), episode(1)]);
    expect(r.action).toBe('minted');
    expect(minted).toHaveLength(1);
    expect(minted[0].coveredLossSourceIds.map(lossSourceIdKey)).toEqual([
      'preOpenWindow:1',
      'episode:1',
    ]);
    expect(disclosed).toEqual(['preOpenWindow:1', 'episode:1']);
  });

  it('(b)/(d) a second source arriving while the token is still PENDING (queued/parked/re-parked) JOINS it — one utterance total', () => {
    const { ledger, minted, disclosed } = harness();
    ledger.request('S', [episode(1)]);
    // preempted + re-parked: still pending, still outstanding
    expect(ledger.onNonNaturalTerminal(1)?.state).toBe('pending');
    const r = ledger.request('S', [episode(2)]);
    expect(r.action).toBe('joined');
    expect(minted).toHaveLength(1);
    expect(minted[0].coveredLossSourceIds.map(lossSourceIdKey)).toEqual(['episode:1', 'episode:2']);
    expect(disclosed).toEqual(['episode:1', 'episode:2']);
  });

  it('(c) two outages where the first disclosure COMPLETED before the second → TWO tokens, both delivered', () => {
    const { ledger, minted } = harness();
    ledger.request('S', [episode(1)]);
    ledger.onPlaybackStarted(1);
    ledger.onNaturalCompletion(1);
    const r = ledger.request('S', [episode(2)]);
    expect(r.action).toBe('minted');
    expect(minted.map((t) => t.id)).toEqual([1, 2]);
    expect(ledger.naturalCompletionCount).toBe(1);
  });

  it('a source arriving while the token is PLAYING stays UNASSOCIATED and is disclosed by the SUCCESSOR minted at natural completion', () => {
    const { ledger, minted, disclosed } = harness();
    ledger.request('S', [episode(1)]);
    ledger.onPlaybackStarted(1);
    const r = ledger.request('S', [episode(2)]);
    expect(r.action).toBe('awaiting');
    expect(disclosed).toEqual(['episode:1']); // NOT yet associated
    expect(ledger.awaitingSourceCount).toBe(1);
    const successor = ledger.onNaturalCompletion(1);
    expect(successor?.id).toBe(2);
    expect(minted[1].coveredLossSourceIds.map(lossSourceIdKey)).toEqual(['episode:2']);
    expect(disclosed).toEqual(['episode:1', 'episode:2']);
  });

  it('race: episode 1 completes while episode 2 awaits → completion resolves ONLY episode 1', () => {
    const { ledger, minted } = harness();
    ledger.request('S', [episode(1)]);
    ledger.onPlaybackStarted(1);
    ledger.request('S', [episode(2)]);
    ledger.onNaturalCompletion(1);
    expect(minted[0].coveredLossSourceIds.map(lossSourceIdKey)).toEqual(['episode:1']);
    expect(minted[1].coveredLossSourceIds.map(lossSourceIdKey)).toEqual(['episode:2']);
  });

  it('every LossSourceId variant joins/awaits identically (stagedLoss joins PENDING; awaits PLAYING)', () => {
    const { ledger } = harness();
    ledger.request('S', [episode(1)]);
    expect(ledger.request('S', [staged(1)]).action).toBe('joined');
    ledger.onPlaybackStarted(1);
    expect(ledger.request('S', [staged(2)]).action).toBe('awaiting');
  });

  it('`disclosed` fires once per source even if the same id is re-requested', () => {
    const { ledger, disclosed } = harness();
    ledger.request('S', [episode(1)]);
    ledger.request('S', [episode(1)]);
    expect(disclosed).toEqual(['episode:1']);
  });
});

describe('UplinkLossDisclosureLedger — terminal definition', () => {
  it('discard / preemption / failure return the token to pending — it stays OUTSTANDING; only natural completion retires it', () => {
    const { ledger } = harness();
    ledger.request('S', [episode(1)]);
    ledger.onPlaybackStarted(1);
    expect(ledger.isPlaying).toBe(true);
    expect(ledger.onNonNaturalTerminal(1)?.state).toBe('pending');
    expect(ledger.outstandingToken?.id).toBe(1);
    expect(ledger.isPlaying).toBe(false);
    ledger.onPlaybackStarted(1);
    ledger.onNaturalCompletion(1);
    expect(ledger.outstandingToken).toBeNull();
  });

  it('a stale token id is ignored by every transition', () => {
    const { ledger } = harness();
    ledger.request('S', [episode(1)]);
    ledger.onPlaybackStarted(99);
    expect(ledger.isPlaying).toBe(false);
    expect(ledger.onNonNaturalTerminal(99)).toBeNull();
    expect(ledger.onNaturalCompletion(99)).toBeNull();
    expect(ledger.outstandingToken?.id).toBe(1);
  });
});

describe('UplinkLossDisclosureLedger — session scoping (2e g)', () => {
  it('a token still outstanding from session A does NOT occupy the slot in session B (red proof: without the stamp B is suppressed)', () => {
    const { ledger, minted } = harness();
    ledger.request('A', [episode(1)]);
    ledger.onPlaybackStarted(1); // playing when the inspector stops
    const r = ledger.request('B', [episode(2)]);
    expect(r.action).toBe('minted');
    expect(minted[1].sessionId).toBe('B');
    expect(minted[1].coveredLossSourceIds.map(lossSourceIdKey)).toEqual(['episode:2']);
  });

  it('session teardown abandons the outstanding token and any awaiting sources with no completion accounting', () => {
    const { ledger } = harness();
    ledger.request('A', [episode(1)]);
    ledger.onPlaybackStarted(1);
    ledger.request('A', [episode(2)]);
    ledger.abandonForSessionTeardown();
    expect(ledger.outstandingToken).toBeNull();
    expect(ledger.awaitingSourceCount).toBe(0);
    expect(ledger.naturalCompletionCount).toBe(0);
  });
});

describe('UplinkLossDisclosureLedger — Codex cycle-1 regressions', () => {
  it("the disclosed counter is per (session, source): session B's episode:1 counts again", () => {
    const { ledger, disclosed } = harness();
    ledger.request('A', [episode(1)]);
    ledger.onPlaybackStarted(1);
    ledger.onNaturalCompletion(1);
    ledger.request('B', [episode(1)]);
    expect(disclosed).toEqual(['episode:1', 'episode:1']);
  });

  it("PLAN-E-TERM's source-cardinal completion counter fires ONLY at natural completion, never at mint", () => {
    const events: string[] = [];
    const ledger = new UplinkLossDisclosureLedger({
      onMint: () => {},
      telemetry: (event) => events.push(event),
    });
    ledger.request('A', [episode(1)]);
    ledger.onPlaybackStarted(1);
    expect(events).toEqual(['uplink_loss_episode_disclosed']);
    ledger.onNaturalCompletion(1);
    expect(events).toEqual([
      'uplink_loss_episode_disclosed',
      'uplink_loss_episode_disclosure_completed',
    ]);
    expect(ledger.naturalCompletionCount).toBe(1);
  });

  it('a completion that never PLAYED emits no completion counter and no onCompleted (E2 accounting unchanged)', () => {
    const events: string[] = [];
    const completed: number[] = [];
    const ledger = new UplinkLossDisclosureLedger({
      onMint: () => {},
      telemetry: (event) => events.push(event),
      onCompleted: (t) => completed.push(t.id),
    });
    ledger.request('A', [episode(1)]);
    ledger.onNaturalCompletion(1); // entry-cancel onEnd before playback
    expect(events).toEqual(['uplink_loss_episode_disclosed']);
    expect(completed).toEqual([]);
    expect(ledger.naturalCompletionCount).toBe(1);
    expect(ledger.outstandingToken).toBeNull();
  });
});
