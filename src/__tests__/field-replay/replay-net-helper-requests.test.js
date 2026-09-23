/**
 * PLAN-B (feedback-2026-09-17, B3) — the recorded client and the net-site
 * helper. The recorded lane answers the helper's one retry call with an empty
 * round ("helper frozen empty") outside strict round consumption, but ONLY for
 * a request that is unmistakably the helper's, and at most twice per turn.
 */
import { makeTurnClient } from '../../../scripts/field-replay/lib/replay-runner-core.mjs';

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
