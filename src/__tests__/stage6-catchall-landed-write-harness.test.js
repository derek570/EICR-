/**
 * PLAN-B (feedback-2026-09-17, B-79) acceptance 12 through the REAL harness:
 * a write LANDS but its confirmation is lost before marker-②. marker-② must
 * speak the bundler-identical read-back, make no helper call, and say nothing
 * about nothing being recorded.
 *
 * The loss is simulated at the one place it can be observed: the bundler's
 * FIRST projection for the turn returns no confirmations (as if they were
 * dropped downstream); every later call is the real projection, which is what
 * marker-²'s recovery re-runs.
 */
import { jest } from '@jest/globals';

const realBundler = await import('../extraction/stage6-event-bundler.js');
let dropNextProjection = false;
jest.unstable_mockModule('../extraction/stage6-event-bundler.js', () => ({
  ...realBundler,
  bundleToolCallsIntoResult: (...args) => {
    const out = realBundler.bundleToolCallsIntoResult(...args);
    if (dropNextProjection) {
      dropNextProjection = false;
      return { ...out, confirmations: [] };
    }
    return out;
  },
}));

const { runShadowHarness, CATCHALL_AUDIBILITY_PROMPTS } =
  await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { mockClient } = await import('./helpers/mockStream.js');
const { makeLogger, makeLiveSession, toolUseRound, endTurnRound } =
  await import('./helpers/f7-audibility-matrix.js');

const SID = 'sess-b79-landed';

beforeEach(() => {
  activeSessions.set(SID, {
    session: { sessionId: SID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: false } },
  });
});
afterEach(() => activeSessions.delete(SID));

test('a landed write whose confirmation was lost is read back by marker-②, never apologised for', async () => {
  const client = mockClient([
    toolUseRound([
      {
        id: 'w1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.4',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
    ]),
    endTurnRound(''),
    // Would be the helper's round; it must never be requested.
    toolUseRound([{ id: 'n1', name: 'net_response', input: { outcome_code: 'nothing_recorded' } }]),
  ]);
  const session = makeLiveSession({
    sessionId: SID,
    client,
    stateSnapshot: {
      circuits: { 3: { circuit_designation: 'Sockets' } },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  });
  const logger = makeLogger();
  dropNextProjection = true;
  const result = await runShadowHarness(session, 'Zs on circuit 3 is 0.4', [], {
    logger,
    chimeObserved: true,
    confirmationsEnabled: true,
    rawInspectorTranscript: 'Zs on circuit 3 is 0.4',
    canonicalInspectorTranscript: 'Zs on circuit 3 is 0.4',
    generationId: 'gen-b79',
  });
  const texts = (result.confirmations ?? []).map((c) => c.text).filter(Boolean);
  expect(texts).toHaveLength(1);
  expect(texts[0]).toMatch(/0\.4|nought point four/i);
  expect(texts[0]).not.toMatch(/^Nothing was recorded/);
  expect(CATCHALL_AUDIBILITY_PROMPTS).not.toContain(texts[0]);
  expect(client._callCount).toBe(2);
  const rows = logger.info.mock.calls;
  expect(rows.some(([n]) => n === 'stage6.catchall_landed_mutation_recovered')).toBe(true);
  expect(rows.some(([n]) => n === 'stage6.noop_retry_round')).toBe(false);
});
