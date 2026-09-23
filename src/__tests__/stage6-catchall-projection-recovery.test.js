/**
 * PLAN-B (feedback-2026-09-17, B-79) — marker-② splits by authoritative
 * mutation state before it ever apologises (acceptance 12).
 *
 * marker-②'s predicate counts speech-intent only, so it also fires when a
 * write LANDED but its confirmation did not survive to the net. "Did anything
 * land?" is decided by re-running the SAME canonical projection the bundler
 * ran (`bundleToolCallsIntoResult`, byte-identical options) over the final
 * journal: a non-empty projection's confirmations ARE the recovery
 * read-backs; only an empty projection lets the net-site helper say nothing
 * was recorded.
 *
 * Each journal category is driven through the REAL write dispatchers into a
 * real per-turn journal, then through `recoverLandedMutationConfirmations`,
 * and the recovered lines are compared to a fresh bundler projection — so the
 * test goes THROUGH the projection, never through a hand-kept table.
 */

import { jest } from '@jest/globals';

import {
  recoverLandedMutationConfirmations,
  runShadowHarness,
} from '../extraction/stage6-shadow-harness.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { mockClient } from './helpers/mockStream.js';
import {
  makeLogger,
  makeLiveSession,
  toolUseRound,
  endTurnRound,
} from './helpers/f7-audibility-matrix.js';

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

function makeSession() {
  return {
    sessionId: 'sess-b79',
    stateSnapshot: {
      circuits: {
        0: { earth_loop_impedance_ze: '0.35', manufacturer: 'Wylex' },
        1: {
          circuit_designation: 'Cooker',
          ocpd_bs_en: 'BS EN 60898',
          ocpd_rating_a: '32',
          r1_r2_ohm: '0.3',
        },
        2: { circuit_designation: 'Spare' },
        3: {
          circuit_designation: 'Sockets',
          measured_zs_ohm: '0.8',
          r1_r2_ohm: '0.4',
          ocpd_bs_en: 'BS EN 60898',
          ocpd_type: 'B',
          ocpd_rating_a: '32',
        },
        4: { circuit_designation: 'Lights' },
      },
      boards: [{ id: 'main', designation: 'Main', board_type: 'main' }],
      currentBoardId: 'main',
      observations: [
        {
          id: 'obs-1',
          code: 'C3',
          text: 'Cracked socket front',
          location: 'Kitchen',
        },
      ],
      pending_readings: [],
      validation_alerts: [],
    },
    extractedObservations: [
      { id: 'obs-1', code: 'C3', text: 'Cracked socket front', location: 'Kitchen' },
    ],
    activeWs: null,
  };
}

const BUNDLER_OPTIONS = { turnId: 'turn-b79', totalCircuitsInJob: 4 };

// One entry per journal category the bundler can speak (the plan's list).
const CATEGORIES = [
  [
    'readings — a circuit reading',
    {
      name: 'record_reading',
      input: {
        field: 'measured_zs_ohm',
        circuit: 4,
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't',
      },
    },
  ],
  [
    'boardReadings — a board reading',
    {
      name: 'record_board_reading',
      input: { field: 'address', value: '1 High Street', confidence: 0.9, source_turn_id: 't' },
    },
  ],
  [
    'cleared — a clear (not collapsed)',
    {
      name: 'clear_reading',
      input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
    },
  ],
  [
    'observations — an observation',
    {
      name: 'record_observation',
      input: {
        code: 'C3',
        location: 'Hall',
        text: 'Loose switch plate in the hall',
        circuit: null,
        suggested_regulation: '526.1',
        schedule_item: null,
        rationale: null,
        clarification_chain_id: null,
      },
    },
  ],
  [
    'deletedObservations — an observation deletion',
    { name: 'delete_observation', input: { observation_id: 'obs-1', reason: 'user_correction' } },
  ],
  ['circuitOps — a create (no designation)', { name: 'create_circuit', input: { circuit_ref: 7 } }],
  ['circuitOps — a rename', { name: 'rename_circuit', input: { from_ref: 4, circuit_ref: 5 } }],
  ['circuitOps — a delete', { name: 'delete_circuit', input: { circuit_ref: 4 } }],
  [
    'designationOps — a same-turn designation',
    {
      name: 'record_reading',
      input: {
        field: 'circuit_designation',
        circuit: 4,
        value: 'Landing lights',
        confidence: 0.9,
        source_turn_id: 't',
      },
    },
  ],
  [
    'boardOps — an add_board',
    { name: 'add_board', input: { designation: 'Garage', board_type: 'sub_distribution' } },
  ],
  [
    'calculator — a ::calc:: write',
    { name: 'calculate_zs', input: { circuit_ref: 1, all: false } },
  ],
  [
    'bulkOutcomes — applied plus spare-skipped',
    {
      name: 'set_field_for_all_circuits',
      input: { field: 'ref_method', value: 'C', confidence: 0.9, source_turn_id: 't' },
    },
  ],
];

async function journalFor(call) {
  const session = makeSession();
  const ptw = createPerTurnWrites();
  const d = createWriteDispatcher(session, logger(), 'turn-b79', ptw);
  const env = await d({ tool_call_id: 'tc-1', ...call }, {});
  return { ptw, env };
}

describe('acceptance 12 — a landed mutation is recovered through the projection, never apologised for', () => {
  test.each(CATEGORIES)('%s', async (_label, call) => {
    const { ptw, env } = await journalFor(call);
    expect(env.is_error).toBe(false);
    const recovery = recoverLandedMutationConfirmations({
      perTurnWrites: ptw,
      bundlerOptions: BUNDLER_OPTIONS,
    });
    expect(recovery.landed).toBe(true);
    // Bundler-identical: the recovered lines are exactly the projection's.
    const fresh = bundleToolCallsIntoResult(ptw, null, BUNDLER_OPTIONS).confirmations.filter(
      (c) => typeof c.text === 'string' && c.text.trim()
    );
    expect(recovery.confirmations.map((c) => c.text)).toEqual(fresh.map((c) => c.text));
    expect(recovery.confirmations.some((c) => /^Nothing was recorded/.test(c.text))).toBe(false);
  });

  test('fieldCorrections — a clear_board_reading field correction (board_clear_v1 session)', async () => {
    const session = makeSession();
    activeSessions.set(session.sessionId, {
      session,
      voiceLatency: { capabilities: { hasBoardClearV1: true } },
    });
    try {
      const ptw = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger(), 'turn-b79', ptw);
      const env = await d(
        {
          tool_call_id: 'cb-1',
          name: 'clear_board_reading',
          input: { field: 'manufacturer', reason: 'user_correction' },
        },
        {}
      );
      expect(env.is_error).toBe(false);
      expect(ptw.fieldCorrections.length).toBeGreaterThan(0);
      const recovery = recoverLandedMutationConfirmations({
        perTurnWrites: ptw,
        bundlerOptions: BUNDLER_OPTIONS,
      });
      expect(recovery.landed).toBe(true);
      const fresh = bundleToolCallsIntoResult(ptw, null, BUNDLER_OPTIONS).confirmations;
      expect(recovery.confirmations.map((c) => c.text)).toEqual(
        fresh.filter((c) => typeof c.text === 'string' && c.text.trim()).map((c) => c.text)
      );
    } finally {
      activeSessions.delete(session.sessionId);
    }
  });

  test('a grouped bulk write keeps its grouped, spare-amended read-back', async () => {
    const { ptw } = await journalFor(CATEGORIES.at(-1)[1]);
    const recovery = recoverLandedMutationConfirmations({
      perTurnWrites: ptw,
      bundlerOptions: BUNDLER_OPTIONS,
    });
    expect(recovery.confirmations.map((c) => c.text)).toEqual([
      'Circuits 1, 3, 4, reference method C, skipping 1 spare way',
    ]);
  });

  test('the zero-applied bulk disclosure is recovered verbatim', async () => {
    const session = makeSession();
    // Every circuit but a spare is gone, so the bulk call applies nothing.
    session.stateSnapshot.circuits = { 0: {}, 2: { circuit_designation: 'Spare' } };
    const ptw = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger(), 'turn-b79', ptw);
    await d(
      {
        tool_call_id: 'tc-bulk',
        name: 'set_field_for_all_circuits',
        input: { field: 'ref_method', value: 'C', confidence: 0.9, source_turn_id: 't' },
      },
      {}
    );
    const recovery = recoverLandedMutationConfirmations({
      perTurnWrites: ptw,
      bundlerOptions: BUNDLER_OPTIONS,
    });
    expect(recovery.landed).toBe(true);
    expect(recovery.confirmations.map((c) => c.text).join(' ')).toMatch(
      /No non-spare circuits were updated; skipped 1 spare way/
    );
  });

  test('a clear collapsed by a same-turn write recovers only the write (its carrier)', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger(), 'turn-b79', ptw);
    await d(
      {
        tool_call_id: 'c1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'c2',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.5',
          confidence: 0.9,
          source_turn_id: 't',
        },
      },
      {}
    );
    const recovery = recoverLandedMutationConfirmations({
      perTurnWrites: ptw,
      bundlerOptions: BUNDLER_OPTIONS,
    });
    expect(recovery.landed).toBe(true);
    expect(recovery.confirmations).toHaveLength(1);
    expect(recovery.confirmations[0].text).not.toMatch(/cleared/i);
  });

  test('zero landed rows → the projection is empty (the only condition for the catch-all helper)', () => {
    const recovery = recoverLandedMutationConfirmations({
      perTurnWrites: createPerTurnWrites(),
      bundlerOptions: BUNDLER_OPTIONS,
    });
    expect(recovery).toEqual({ landed: false, confirmations: [] });
  });

  test('with the mid-stream filter on, a slot already emitted mid-stream still counts as landed but is not spoken twice', async () => {
    const { ptw } = await journalFor(CATEGORIES[0][1]);
    const recovery = recoverLandedMutationConfirmations({
      perTurnWrites: ptw,
      bundlerOptions: BUNDLER_OPTIONS,
      midStreamFilterEnabled: true,
      midStreamEmittedSlots: new Set(['measured_zs_ohm::4::']),
    });
    expect(recovery.landed).toBe(true);
    expect(recovery.confirmations).toEqual([]);
  });
});

describe('acceptance 12 — the projection covers every per-turn journal key (B-79/B-90/B-99)', () => {
  // Every key createPerTurnWrites() returns must be classified. A new journal
  // category that is not classified here fails, so it cannot silently fall
  // outside the "a mutation landed" predicate.
  const PROJECTION_OWNED = new Set([
    'readings',
    'boardReadings',
    'readingJournal',
    'boardReadingJournal',
    'cleared',
    'observations',
    'deletedObservations',
    'circuitOps',
    'boardOps',
    'designationOps',
    'fieldCorrections',
    'bulkOutcomes',
  ]);
  const OWNED_BY_ANOTHER_AUDIBLE_PATH = {
    // Drained into session.pendingVoicePrompts by the harness (net-0 and the
    // partial-failure drain), never into bundleToolCallsIntoResult; marker-②
    // counts them through survivingPromptCount.
    mandatoryNotices: 'net-0 drain → pendingVoicePrompts',
    partialFailureNotices: 'partial-failure drain → pendingVoicePrompts',
    // marker-②'s own specific-first notices branch.
    voiceNotices: 'marker-② notices branch',
    // Feeds result.spoken_response, covered by the !isAudibleText predicate.
    answer: 'result.spoken_response',
  };
  const NOT_SPOKEN = {
    // PLAN-C3 bookkeeping: rejection refs, the answer journal and ask
    // registrations are reconciliation inputs, not mutations.
    rejections: 'PLAN-C3 rejection journal (not a mutation)',
    answers: 'PLAN-C3 answer journal (reconciled into `answer`)',
    askRegistrations: 'PLAN-C3 covering-ask registry (not a mutation)',
  };

  test('every key is classified exactly once', () => {
    const keys = Object.keys(createPerTurnWrites());
    const classified = [
      ...PROJECTION_OWNED,
      ...Object.keys(OWNED_BY_ANOTHER_AUDIBLE_PATH),
      ...Object.keys(NOT_SPOKEN),
    ];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...keys].sort()).toEqual([...classified].sort());
  });

  test('the drained notice arrays are never read by the bundler', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../extraction/stage6-event-bundler.js', import.meta.url),
      'utf8'
    );
    expect(src).not.toMatch(/\bmandatoryNotices\b/);
    expect(src).not.toMatch(/\bpartialFailureNotices\b/);
  });
});

describe('acceptance 12 — the harness: nothing landed → the catch-all helper; a calculator with no result is the canonical case', () => {
  const SID = 'sess-b79-harness';
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

  test('calculate_zs with nothing computable → one nothing-was-recorded line from the helper', async () => {
    const client = mockClient([
      toolUseRound([{ id: 'calc_1', name: 'calculate_zs', input: { circuit_ref: 4, all: false } }]),
      endTurnRound(''),
      toolUseRound([
        {
          id: 'net_1',
          name: 'net_response',
          input: { outcome_code: 'nothing_recorded', question: 'what_value' },
        },
      ]),
    ]);
    const session = makeLiveSession({
      sessionId: SID,
      client,
      stateSnapshot: {
        circuits: { 4: { circuit_designation: 'Lights' } },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    });
    const log = makeLogger();
    const result = await runShadowHarness(session, 'Zs for circuit 4.', [], {
      logger: log,
      chimeObserved: true,
      rawInspectorTranscript: 'Zs for circuit 4.',
      canonicalInspectorTranscript: 'Zs for circuit 4.',
      generationId: 'gen-b79',
    });
    const texts = (result.confirmations ?? []).map((c) => c.text).filter(Boolean);
    expect(texts).toEqual(['Nothing was recorded. What was the value?']);
    expect(log.info.mock.calls.find(([n]) => n === 'stage6.noop_retry_round')?.[1]).toMatchObject({
      netKind: 'catchall',
      outcome: 'answered',
    });
    expect(
      log.info.mock.calls.some(([n]) => n === 'stage6.catchall_landed_mutation_recovered')
    ).toBe(false);
  });
});
