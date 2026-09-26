/**
 * PLAN-W2 (Decision 7 wrong-value wave) — the routing table for a recognised
 * apply-field command that web does NOT execute locally.
 *
 * A command executes locally only when the job has 0–1 boards, the value
 * contract (`config/apply-field-value-vectors.json`) accepted its value, and
 * the field is not a W2.7 measured reading or cable size. Every other command
 * is DECLINED and takes the first matching row:
 *
 * | # | Condition                          | Route                                 |
 * |---|------------------------------------|---------------------------------------|
 * | 1 | feedback capture open              | lag line, capture tail                |
 * | 2 | no Sonnet session                  | lag line, session tail                |
 * | 3 | unresolved, 0–1 boards, ask live   | lag line, ask tail (Decision 15)      |
 * | 4 | unresolved, 0–1 boards             | hand-off, CD1 authority               |
 * | 5 | 2+ boards                          | forward, gate-only authority (W-1.4)  |
 * | 6 | W2.7 field, 0–1 boards             | forward, no authority (W-1.3)         |
 *
 * Rows 1 and 2 come first because a forward there is lost: the capture
 * swallows it, and `sonnetRef.current?.sendTranscript` is a no-op on a null
 * session after the chime has played. Pure, so every row is unit-testable —
 * including row 2, which a mounted harness cannot reach (the session is only
 * null while Deepgram is also torn down).
 */

export type DeclinedApplyFieldKind = 'accepted' | 'unresolved' | 'forwarded_field';

export type ApplyFieldRoute =
  | { route: 'execute' }
  | { route: 'lag'; tail: 'capture' | 'session' | 'ask' }
  | { route: 'handoff' }
  | { route: 'forward_multi_board' }
  | { route: 'forward_field' };

export function routeApplyFieldCommand(input: {
  kind: DeclinedApplyFieldKind;
  boardCount: number;
  capturing: boolean;
  hasSession: boolean;
  /** Read only on row 3's branch — the authority read is non-consuming, but
   *  it is still skipped where the table does not need it. */
  askLive: () => boolean;
}): ApplyFieldRoute {
  const { kind, boardCount, capturing, hasSession } = input;
  if (boardCount <= 1 && kind === 'accepted') return { route: 'execute' };
  if (capturing) return { route: 'lag', tail: 'capture' };
  if (!hasSession) return { route: 'lag', tail: 'session' };
  if (boardCount > 1) return { route: 'forward_multi_board' };
  if (kind === 'unresolved') {
    return input.askLive() ? { route: 'lag', tail: 'ask' } : { route: 'handoff' };
  }
  return { route: 'forward_field' };
}
