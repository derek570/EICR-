/**
 * PLAN-W2 — the web apply-field routing table, row by row. The mounted
 * harness (`harness/planw2-apply-field-handoff.test.tsx`) proves the wiring of
 * each route; this file proves the table itself, including row 2 (no Sonnet
 * session), which no mounted final can reach because the session is only null
 * while Deepgram is torn down too.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  routeApplyFieldCommand,
  type DeclinedApplyFieldKind,
} from '@/lib/recording/apply-field-routing';

const base = {
  kind: 'accepted' as DeclinedApplyFieldKind,
  boardCount: 1,
  capturing: false,
  hasSession: true,
  askLive: () => false,
};

describe('routeApplyFieldCommand', () => {
  it('an accepted value on a 0–1 board job executes, whatever else is true', () => {
    for (const boardCount of [0, 1]) {
      for (const capturing of [false, true]) {
        for (const hasSession of [false, true]) {
          expect(
            routeApplyFieldCommand({
              ...base,
              boardCount,
              capturing,
              hasSession,
              askLive: () => true,
            })
          ).toEqual({ route: 'execute' });
        }
      }
    }
  });

  it('row 1 — a capture wins over every other decline', () => {
    for (const kind of ['accepted', 'unresolved', 'forwarded_field'] as const) {
      expect(
        routeApplyFieldCommand({ ...base, kind, boardCount: 2, capturing: true, hasSession: false })
      ).toEqual({ route: 'lag', tail: 'capture' });
    }
    expect(routeApplyFieldCommand({ ...base, kind: 'unresolved', capturing: true })).toEqual({
      route: 'lag',
      tail: 'capture',
    });
  });

  it('row 2 — no session speaks the session lag line (W2-4)', () => {
    for (const kind of ['accepted', 'unresolved', 'forwarded_field'] as const) {
      expect(routeApplyFieldCommand({ ...base, kind, boardCount: 2, hasSession: false })).toEqual({
        route: 'lag',
        tail: 'session',
      });
    }
    expect(routeApplyFieldCommand({ ...base, kind: 'forwarded_field', hasSession: false })).toEqual(
      { route: 'lag', tail: 'session' }
    );
  });

  it('rows 3 and 4 — an unresolved value on 0–1 boards: lag line with an ask live, hand-off without', () => {
    expect(routeApplyFieldCommand({ ...base, kind: 'unresolved', askLive: () => true })).toEqual({
      route: 'lag',
      tail: 'ask',
    });
    expect(routeApplyFieldCommand({ ...base, kind: 'unresolved' })).toEqual({ route: 'handoff' });
  });

  it('row 5 — two or more boards forward whether or not an ask is live, and never read the ask', () => {
    const askLive = vi.fn(() => true);
    for (const kind of ['accepted', 'unresolved', 'forwarded_field'] as const) {
      expect(routeApplyFieldCommand({ ...base, kind, boardCount: 3, askLive })).toEqual({
        route: 'forward_multi_board',
      });
    }
    expect(askLive).not.toHaveBeenCalled();
  });

  it('row 6 — a W2.7 field on 0–1 boards forwards (gate-only authority in the wiring), ask live or not', () => {
    for (const askLive of [() => true, () => false]) {
      expect(routeApplyFieldCommand({ ...base, kind: 'forwarded_field', askLive })).toEqual({
        route: 'forward_field',
      });
    }
  });
});
