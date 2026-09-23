/**
 * PLAN-B (feedback-2026-09-17, B3) acceptance 15 — the net-site helper's
 * replay-stable dedupe token on the web client. No web code changed for it:
 * the backend stamps `p4ack_<turnId>_net_<netKind>` on every model-authored
 * net line, and the web builder already keys the `p4ack_` family structurally.
 *
 * The helper's templates are byte-identical across turns when no quotation
 * is chosen ("Nothing was recorded."). Without a turn-scoped token, the
 * field-null 30 s TTL would swallow the second of two rapid lines — the class
 * the canned families rotate their wording to avoid. This drives seven such
 * lines through the REAL key builder and the REAL TTL store, as
 * recording-context.tsx does for a field-null confirmation.
 */
import { describe, expect, it } from 'vitest';
import { buildConfirmationDedupeKey } from '@/lib/recording/confirmation-dedupe-key';
import { ConfirmationDedupeStore } from '@/lib/recording/confirmation-dedupe-store';

function playThrough(store: ConfirmationDedupeStore, frames: Array<Record<string, unknown>>) {
  const played: string[] = [];
  for (const conf of frames) {
    const key = buildConfirmationDedupeKey(conf as never);
    const fieldIsNil = conf.field == null;
    if (store.isLive(key, fieldIsNil)) continue;
    store.reserve(key, fieldIsNil);
    played.push(key);
  }
  return played;
}

const line = (turn: number, netKind = 'noop') => ({
  text: 'Nothing was recorded.',
  field: null,
  circuit: null,
  expects_ios_ack: false,
  dedupe_token: `p4ack_sess-b-turn-${turn}_net_${netKind}`,
});

describe('PLAN-B acceptance 15 — seven identical net lines inside 30 s', () => {
  it('seven turns → seven playbacks and seven distinct keys', () => {
    let now = 1_000_000;
    const store = new ConfirmationDedupeStore(() => now);
    const frames = [1, 2, 3, 4, 5, 6, 7].map((t) => line(t));
    const played: string[] = [];
    for (const frame of frames) {
      played.push(...playThrough(store, [frame]));
      now += 2_000; // all seven inside one 30 s window
    }
    expect(played).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((t) => `unknown_p4ack_sess-b-turn-${t}_net_noop`)
    );
    expect(new Set(played).size).toBe(7);
  });

  it('a replayed frame with the SAME token plays once', () => {
    const store = new ConfirmationDedupeStore(() => 1_000_000);
    expect(playThrough(store, [line(3), line(3)])).toEqual([
      'unknown_p4ack_sess-b-turn-3_net_noop',
    ]);
  });

  it('control: the same seven lines WITHOUT a token collapse to one — the class the token prevents', () => {
    const store = new ConfirmationDedupeStore(() => 1_000_000);
    const untokened = [1, 2, 3, 4, 5, 6, 7].map((t) => {
      const { dedupe_token: _drop, ...rest } = line(t);
      return rest;
    });
    expect(playThrough(store, untokened)).toHaveLength(1);
  });
});
