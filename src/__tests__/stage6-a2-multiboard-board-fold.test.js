/**
 * A2-multiboard item 7 (2026-07-28) — the REAL-HARNESS pin for the board
 * `replaces_cleared` twin.
 *
 * The bundler unit tests (stage6-clear-board-reading-bundler.test.js) prove the
 * flag lands on `extracted_board_readings[0]`. That slot NEVER reaches a
 * client: `runShadowHarness` folds every board reading into `extracted_readings`
 * as a synthesised `circuit: 0` copy (iOS Build 282's Codable decoder rejects
 * the `extracted_board_readings` slot) and then STRIPS the real slot before the
 * frame leaves the server. So the folded copy is the ONLY shape a client ever
 * sees for a board write — and if the fold dropped the flag, a collapsed board
 * replacement would arrive as a BARE write against a still-populated cell and
 * web's fill-only apply gate would silently skip it: spoken, never written
 * (P5's ordering wipe, at board scope).
 *
 * This suite drives the REAL harness with the REAL board dispatchers and the
 * REAL bundler, so the fold is exercised end-to-end rather than asserted
 * against a hand-built `result`. `runToolLoop` is mocked ONLY to stand in for
 * the model: the mock invokes the dispatcher the harness composed, with the ctx
 * the harness built, so every write below is produced by production code.
 *
 * Mock pattern mirrors stage6-orphan-net.test.js.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-a2-board-fold';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));

const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: jest.fn(),
  abortBySlot: jest.fn(),
  shutdown: jest.fn(),
}));

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 20000,
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: createSpeculatorSpy,
}));

// `sonnet-stream.js` imports storage at module load. The PLAN-2D tests below
// need only its pure final-egress validator, so keep the existing harness
// isolated from filesystem/S3 side effects.
jest.unstable_mockModule('../storage.js', () => ({
  getJobPrefix: jest.fn(() => ''),
  uploadFile: jest.fn(async () => {}),
  uploadBytes: jest.fn(async () => {}),
  uploadText: jest.fn(async () => {}),
  uploadJson: jest.fn(async () => {}),
  downloadFile: jest.fn(async () => {}),
  downloadBytes: jest.fn(async () => null),
  downloadText: jest.fn(async () => null),
  downloadJson: jest.fn(async () => null),
  fileExists: jest.fn(async () => false),
  deleteFile: jest.fn(async () => {}),
  copyObject: jest.fn(async () => {}),
  deletePrefix: jest.fn(async () => {}),
  listFiles: jest.fn(async () => []),
  listDirectories: jest.fn(async () => []),
  listJobFolders: jest.fn(async () => []),
  getFileUrl: jest.fn(async () => ''),
  getJobFiles: jest.fn(async () => []),
  uploadJobFile: jest.fn(async () => {}),
  downloadJobFile: jest.fn(async () => null),
  isUsingS3: jest.fn(() => false),
  getBucketName: jest.fn(() => 'test-bucket'),
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { _test_validateAndCorrectFields } = await import('../extraction/sonnet-stream.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const twoBoards = () => [
  { id: 'main', designation: 'Main DB', board_type: 'main' },
  { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution', manufacturer: 'Hager' },
];

function makeSession(boards = twoBoards()) {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    certType: 'eicr',
    turnCount: 0,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards,
      currentBoardId: 'main',
    },
    extractedObservations: [],
    activeTurnTranscript: null,
    _snapshot: null,
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
  };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    ...overrides,
  };
}

/**
 * Stand in for the model: replay `calls` through the dispatcher the harness
 * composed. Every write is therefore produced by the production dispatchers
 * against the production perTurnWrites, so the bundler + fold downstream see
 * exactly what a live turn would produce.
 */
function driveToolCalls(calls) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    for (const c of calls) {
      await opts.dispatcher(
        { tool_call_id: c.tool_call_id, name: c.name, input: c.input },
        opts.ctx
      );
    }
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: calls.map((c) => ({
        tool_call_id: c.tool_call_id,
        name: c.name,
        input: c.input,
        is_error: false,
      })),
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

const CLEAR_MANUFACTURER = {
  tool_call_id: 'toolu_c_fold',
  name: 'clear_board_reading',
  input: { field: 'manufacturer', reason: 'user_correction' },
};
const WRITE_MANUFACTURER = {
  tool_call_id: 'toolu_w_fold',
  name: 'record_board_reading',
  input: { field: 'manufacturer', value: 'Wylex', confidence: 0.9, source_turn_id: 't1' },
};
const SELECT_GARAGE = {
  tool_call_id: 'toolu_sel_fold',
  name: 'select_board',
  input: { board_id: 'garage' },
};

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: false }, capabilities: { hasBoardClearV1: true } },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('item 7 — the collapse flag survives the circuit:0 compatibility fold', () => {
  test('sub-board manufacturer clear→write: the folded circuit:0 copy carries replaces_cleared AND board_id, and the extracted_board_readings slot is stripped', async () => {
    const session = makeSession();
    driveToolCalls([SELECT_GARAGE, CLEAR_MANUFACTURER, WRITE_MANUFACTURER]);

    const result = await runShadowHarness(
      session,
      'No, the garage board is a Wylex.',
      [],
      baseOpts()
    );

    // The forward-compat slot never reaches a client.
    expect(result.extracted_board_readings).toBeUndefined();

    const folded = (result.extracted_readings ?? []).filter((r) => r.field === 'manufacturer');
    expect(folded).toHaveLength(1);
    expect(folded[0].circuit).toBe(0);
    expect(folded[0].value).toBe('Wylex');
    // The two halves the client needs: "this REPLACES a cleared value" and
    // "on WHICH board". Without either, a fill-only apply gate skips it.
    expect(folded[0].replaces_cleared).toBe(true);
    expect(folded[0].board_id).toBe('garage');

    // The stale clear collapsed — no "cleared" correction rides alongside.
    expect(
      (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading')
    ).toHaveLength(0);
  });

  test('NEGATIVE — a plain board write (no clear) folds WITHOUT the flag', async () => {
    const session = makeSession();
    driveToolCalls([SELECT_GARAGE, WRITE_MANUFACTURER]);

    const result = await runShadowHarness(session, 'The garage board is a Wylex.', [], baseOpts());

    const folded = (result.extracted_readings ?? []).filter((r) => r.field === 'manufacturer');
    expect(folded).toHaveLength(1);
    expect(folded[0].circuit).toBe(0);
    // A spurious flag here would tell the client to overwrite on a turn that
    // cleared nothing — the inverse defect.
    expect(folded[0]).not.toHaveProperty('replaces_cleared');
  });
});

describe('PLAN-2D — folded board correction keys reach their final client wire names', () => {
  test.each([
    ['earth_loop_impedance_ze', 'ze', '0.35'],
    ['prospective_fault_current', 'pfc', '2.1'],
  ])('%s folds raw, then final egress rewrites it to %s', async (rawField, wireField, value) => {
    const session = makeSession();
    driveToolCalls([
      {
        tool_call_id: `toolu_plan2d_${rawField}`,
        name: 'record_board_reading',
        input: {
          field: rawField,
          value,
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
    ]);

    const result = await runShadowHarness(
      session,
      `${rawField} is ${value}.`,
      [],
      baseOpts()
    );

    // The compatibility fold is deliberately raw. This is the exact seam
    // where accidentally enrolling the raw correction key in KNOWN_FIELDS
    // would disable the rewrite below.
    expect(result.extracted_board_readings).toBeUndefined();
    expect(result.extracted_readings).toEqual([
      expect.objectContaining({ field: rawField, circuit: 0, value }),
    ]);

    _test_validateAndCorrectFields(result, 'plan2d-board-fold');
    expect(result.extracted_readings).toEqual([
      expect.objectContaining({ field: wireField, circuit: 0, value }),
    ]);
  });
});
