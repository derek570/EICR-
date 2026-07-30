/**
 * PLAN-2B r10 — unmatched-description notices use the same effective-board
 * identity as the successful record_reading sibling.
 *
 * This is the full dispatcher→write-journal→partial-notice-drain seam. The
 * real ask dispatcher resolves "attic circuit and smoke alarm", the real
 * circuit dispatcher lands Smoke Alarm, and the real harness drain must speak
 * both the read-back and exactly one trusted ordinal notice. A unit test of the
 * staging spec alone cannot catch a raw null board id being suppressed against
 * the survivor journalled under the effective main id.
 */

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { activeSessions } from '../extraction/active-sessions.js';
import {
  makeLiveSession,
  makeLogger,
  makeOpenWs,
  toolUseRound,
  endTurnRound,
} from './helpers/f7-audibility-matrix.js';
import { mockClient } from './helpers/mockStream.js';

const ASK_ID = 'toolu_plan2b_effective_board';

function registerEntry(session) {
  activeSessions.set(session.sessionId, {
    session: { sessionId: session.sessionId },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: false } },
  });
}

function buildAskInput({ contextBoardId = null, pendingBoardId = null } = {}) {
  return {
    question: 'Which circuits was that Zs reading for?',
    reason: 'ambiguous_circuit',
    context_field: 'measured_zs_ohm',
    context_circuit: null,
    expected_answer_shape: 'circuit_ref',
    ...(contextBoardId == null ? {} : { context_board_id: contextBoardId }),
    pending_write: {
      tool: 'record_reading',
      field: 'measured_zs_ohm',
      value: '0.40',
      confidence: 0.95,
      source_turn_id: 'turn-plan2b-effective-board',
      ...(pendingBoardId == null ? {} : { board_id: pendingBoardId }),
    },
  };
}

function buildBoardAskInput({ field, value, contextBoardId = null, pendingBoardId = null } = {}) {
  return {
    question: 'Which circuit descriptions did that board reading apply to?',
    reason: 'ambiguous_circuit',
    context_field: field,
    context_circuit: null,
    expected_answer_shape: 'circuit_ref',
    ...(contextBoardId == null ? {} : { context_board_id: contextBoardId }),
    pending_write: {
      tool: 'record_board_reading',
      field,
      value,
      confidence: 0.95,
      source_turn_id: 'turn-plan2b-effective-board-reading',
      ...(pendingBoardId == null ? {} : { board_id: pendingBoardId }),
    },
  };
}

async function driveAnsweredAsk(
  session,
  askInput,
  userText = 'the attic circuit and the smoke alarm'
) {
  const pendingAsks = createPendingAsksRegistry();
  const logger = makeLogger();
  const ws = makeOpenWs();
  session.client = mockClient([
    toolUseRound([{ id: ASK_ID, name: 'ask_user', input: askInput }]),
    endTurnRound('done'),
  ]);
  registerEntry(session);

  const resultPromise = runShadowHarness(session, 'Zs was zero point four — which circuits?', [], {
    logger,
    pendingAsks,
    ws,
    confirmationsEnabled: true,
    chimeObserved: true,
    generationId: 'gen-plan2b-effective-board',
    utteranceId: 'u-plan2b-effective-board',
  });

  let answered = false;
  for (let attempt = 0; attempt < 100 && !answered; attempt += 1) {
    answered = pendingAsks.resolve(ASK_ID, {
      answered: true,
      user_text: userText,
    });
    if (!answered) await new Promise((resolve) => setImmediate(resolve));
  }
  if (!answered) throw new Error('PLAN-2B test ask never registered');

  return { result: await resultPromise, logger };
}

describe('PLAN-2B — effective-board identity survives through the notice drain', () => {
  afterEach(() => {
    activeSessions.clear();
  });

  test.each([
    {
      label: 'omitted main-board scope',
      expectedBoardId: 'main',
      currentBoardId: 'main',
      askInput: buildAskInput(),
      circuits: {
        3: { circuit: 3, circuit_designation: 'Smoke Alarm' },
      },
    },
    {
      label: 'explicit sub-board scope',
      expectedBoardId: 'sub-1',
      currentBoardId: 'sub-1',
      askInput: buildAskInput({ contextBoardId: 'sub-1', pendingBoardId: 'sub-1' }),
      circuits: {
        3: { circuit: 3, circuit_designation: 'Main board smoke' },
        'sub-1::3': {
          circuit: 3,
          board_id: 'sub-1',
          circuit_designation: 'Smoke Alarm',
        },
      },
    },
  ])('$label speaks the sibling read-back plus one no-match notice', async (fixture) => {
    const session = makeLiveSession({
      sessionId: `sess-plan2b-${fixture.expectedBoardId}`,
      certType: 'eicr',
      stateSnapshot: {
        circuits: fixture.circuits,
        pending_readings: [],
        observations: [],
        validation_alerts: [],
        boards: [
          { id: 'main', designation: 'DB-1', board_type: 'main' },
          {
            id: 'sub-1',
            designation: 'Garage',
            board_type: 'sub_distribution',
            parent_board_id: 'main',
          },
        ],
        currentBoardId: fixture.currentBoardId,
      },
    });

    const { result, logger } = await driveAnsweredAsk(session, fixture.askInput);
    const confirmations = (result.confirmations ?? []).filter(
      (confirmation) =>
        typeof confirmation?.text === 'string' && confirmation.text.trim().length > 0
    );
    const readBacks = confirmations.filter(
      (confirmation) => confirmation.field === 'measured_zs_ohm'
    );
    const descriptionNotices = confirmations.filter(
      (confirmation) => confirmation.field == null && /circuit description/i.test(confirmation.text)
    );

    expect(readBacks).toHaveLength(1);
    expect(readBacks[0]).toMatchObject({ circuit: 3 });
    expect(descriptionNotices).toHaveLength(1);
    expect(
      logger.info.mock.calls.filter(([event]) => event === 'stage6.partial_failure_notice_emitted')
    ).toEqual([
      [
        'stage6.partial_failure_notice_emitted',
        expect.objectContaining({
          reason: 'designation_no_match',
          field: 'zs',
          board: fixture.expectedBoardId,
          spoken_ordinals: '1',
        }),
      ],
    ]);
  });

  test.each([
    {
      label: 'global Ze write from omitted main-board scope',
      sessionId: 'sess-plan2b-board-ze',
      currentBoardId: 'main',
      expectedReadbackField: 'earth_loop_impedance_ze',
      expectedNoticeField: 'ze',
      expectedNoticeBoardId: null,
      askInput: buildBoardAskInput({
        field: 'earth_loop_impedance_ze',
        value: '0.35',
      }),
    },
    {
      label: 'board-scoped manufacturer write on an explicit sub-board',
      sessionId: 'sess-plan2b-board-manufacturer',
      currentBoardId: 'sub-1',
      expectedReadbackField: 'manufacturer',
      expectedNoticeField: 'manufacturer',
      expectedNoticeBoardId: 'sub-1',
      askInput: buildBoardAskInput({
        field: 'manufacturer',
        value: 'Hager',
        contextBoardId: 'sub-1',
        pendingBoardId: 'sub-1',
      }),
    },
  ])('$label drains one sibling read-back plus one ordinal notice', async (fixture) => {
    const session = makeLiveSession({
      sessionId: fixture.sessionId,
      certType: 'eicr',
      stateSnapshot: {
        circuits: {
          3: { circuit: 3, circuit_designation: 'Main board smoke' },
          'sub-1::3': {
            circuit: 3,
            board_id: 'sub-1',
            circuit_designation: 'Smoke Alarm',
          },
        },
        pending_readings: [],
        observations: [],
        validation_alerts: [],
        boards: [
          { id: 'main', designation: 'DB-1', board_type: 'main' },
          {
            id: 'sub-1',
            designation: 'Garage',
            board_type: 'sub_distribution',
            parent_board_id: 'main',
          },
        ],
        currentBoardId: fixture.currentBoardId,
      },
    });

    // The exact sibling is circuit 3; "attic circuit" is the unmatched first
    // span and must survive as the server-owned ordinal, never raw user text.
    if (fixture.currentBoardId === 'main') {
      session.stateSnapshot.circuits[3].circuit_designation = 'Smoke Alarm';
    }
    const { result, logger } = await driveAnsweredAsk(session, fixture.askInput);
    const confirmations = (result.confirmations ?? []).filter(
      (confirmation) =>
        typeof confirmation?.text === 'string' && confirmation.text.trim().length > 0
    );
    const boardReadbacks = confirmations.filter(
      (confirmation) => confirmation.field === fixture.expectedReadbackField
    );
    const descriptionNotices = confirmations.filter(
      (confirmation) => confirmation.field == null && /circuit description/i.test(confirmation.text)
    );

    expect(boardReadbacks).toHaveLength(1);
    expect(descriptionNotices).toHaveLength(1);
    expect(
      logger.info.mock.calls.filter(([event]) => event === 'stage6.partial_failure_notice_emitted')
    ).toEqual([
      [
        'stage6.partial_failure_notice_emitted',
        expect.objectContaining({
          reason: 'designation_no_match',
          field: fixture.expectedNoticeField,
          board: fixture.expectedNoticeBoardId,
          spoken_ordinals: '1',
        }),
      ],
    ]);
  });
});
