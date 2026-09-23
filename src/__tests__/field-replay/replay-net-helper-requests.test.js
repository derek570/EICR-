/**
 * PLAN-B (feedback-2026-09-17, B3) — the recorded client and the net-site
 * helper. The recorded lane answers the helper's one retry call with an empty
 * round ("helper frozen empty") outside strict round consumption, but ONLY for
 * a request that is unmistakably the helper's, and at most twice per turn.
 */
import {
  makeTurnClient,
  netHelperAccountingViolation,
  netHelperExpectationMismatch,
  loadNetHelperExpectations,
} from '../../../scripts/field-replay/lib/replay-runner-core.mjs';

const NET_TOOL = { name: 'net_response', input_schema: { type: 'object' } };
const helperArgs = () => ({
  tools: [NET_TOOL],
  messages: [{ role: 'user', content: '[Server note: retry. Your turn produced…] {}' }],
});
const client = (violations) =>
  makeTurnClient({
    baseRounds: [{ stop_reason: 'end_turn', text: '' }],
    branches: [],
    turnState: { backendAsksObserved: [], backendAsksAnswered: [], toolResultBindings: new Map() },
    violations,
    corpusId: 'frc_test',
    turnIndex: 0,
  });

describe('recorded client — net-site helper requests', () => {
  test('a helper request gets an empty round and does not consume a declared round', () => {
    const violations = [];
    const c = client(violations);
    c.messages.stream(helperArgs());
    expect(c._netHelperRequests).toBe(1);
    expect(c._consumed).toBe(0);
    c.messages.stream({ tools: [{ name: 'record_reading' }], messages: [] });
    expect(c._consumed).toBe(1);
    c.assertFullyConsumed();
    expect(violations).toEqual([]);
  });

  test('a net_response-only request WITHOUT the retry marker stays under strict consumption', () => {
    const violations = [];
    const c = client(violations);
    c.messages.stream({ tools: [NET_TOOL], messages: [{ role: 'user', content: 'hello' }] });
    expect(c._netHelperRequests).toBe(0);
    expect(c._consumed).toBe(1);
    expect(() => c.messages.stream({ tools: [NET_TOOL], messages: [] })).toThrow(
      /strict round consumption/
    );
    expect(violations).toHaveLength(1);
  });

  test('a request that also carries another tool is never treated as the helper', () => {
    const violations = [];
    const c = client(violations);
    const args = helperArgs();
    args.tools = [NET_TOOL, { name: 'record_reading' }];
    c.messages.stream(args);
    expect(c._netHelperRequests).toBe(0);
    expect(c._consumed).toBe(1);
  });

  test('a third helper request in one turn is a violation', () => {
    const violations = [];
    const c = client(violations);
    c.messages.stream(helperArgs());
    c.messages.stream(helperArgs());
    expect(() => c.messages.stream(helperArgs())).toThrow(/net helper over-request/);
    expect(violations).toHaveLength(1);
  });
});

describe('net helper accounting (Codex cycle 2 #3)', () => {
  const row = { name: 'stage6.noop_retry_round' };
  const other = { name: 'stage6.turn_summary' };
  test('served rounds equal to logged helper rows → no violation', () => {
    expect(
      netHelperAccountingViolation({
        served: 1,
        turnRows: [other, row],
        turnIndex: 2,
        corpusId: 'frc_x',
      })
    ).toBeNull();
    expect(
      netHelperAccountingViolation({
        served: undefined,
        turnRows: [other],
        turnIndex: 2,
        corpusId: 'frc_x',
      })
    ).toBeNull();
  });
  test('a free round the harness never logged is a violation', () => {
    expect(
      netHelperAccountingViolation({ served: 2, turnRows: [row], turnIndex: 2, corpusId: 'frc_x' })
    ).toMatch(/net helper accounting: turn 2 of frc_x served 2 helper round\(s\) but logged 1/);
  });
  test('a logged helper row with no served round is a violation', () => {
    expect(
      netHelperAccountingViolation({ served: 0, turnRows: [row], turnIndex: 0, corpusId: 'frc_x' })
    ).toMatch(/served 0 helper round\(s\) but logged 1/);
  });
});

describe('declared net helper expectations (Codex cycle 3)', () => {
  const expectations = { frc_a: { 1: ['noop'] } };
  test('observed calls equal to the declaration → no mismatch', () => {
    expect(
      netHelperExpectationMismatch({
        corpusId: 'frc_a',
        helperLog: [{ turn: 1, nets: ['noop'] }],
        expectations,
      })
    ).toBeNull();
    expect(
      netHelperExpectationMismatch({ corpusId: 'frc_other', helperLog: [], expectations })
    ).toBeNull();
  });
  test('a spurious call on an undeclared turn fails even though served == logged', () => {
    expect(
      netHelperExpectationMismatch({
        corpusId: 'frc_a',
        helperLog: [
          { turn: 1, nets: ['noop'] },
          { turn: 2, nets: ['catchall'] },
        ],
        expectations,
      })
    ).toMatch(/turn 2: expected \[\], observed \["catchall"\]/);
  });
  test('a declared call that no longer happens fails', () => {
    expect(
      netHelperExpectationMismatch({ corpusId: 'frc_a', helperLog: [], expectations })
    ).toMatch(/turn 1: expected \["noop"\], observed \[\]/);
  });
  test('the wrong net on the right turn fails', () => {
    expect(
      netHelperExpectationMismatch({
        corpusId: 'frc_a',
        helperLog: [{ turn: 1, nets: ['catchall'] }],
        expectations,
      })
    ).toMatch(/turn 1/);
  });
  test('the checked-in declaration loads and names only corpus ids', () => {
    const doc = loadNetHelperExpectations();
    for (const id of Object.keys(doc)) expect(id).toMatch(/^frc_[0-9a-f]{32}$/);
  });
});
