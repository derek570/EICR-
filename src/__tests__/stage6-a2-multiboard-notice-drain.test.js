/**
 * A2-multiboard (2026-07-28) — the mandatory-notice drain's `survivingSlots`
 * set is built from the PROJECTED board-write winners, not the raw
 * `perTurnWrites.boardReadings` Map.
 *
 * `record_board_reading` carries no schema `board_id`, so two boards' writes
 * for the SAME field collide on one raw Map key and `Map.set` keeps only the
 * last. The drain's §3.5 same-slot suppression therefore could not see an
 * EARLIER board's write at all: its `board_clear_already_empty` notice was not
 * suppressed and spoke alongside that same board's own write read-back —
 * "manufacturer is already blank" immediately followed by "manufacturer
 * recorded as Wylex", a flat contradiction about one field on one board.
 *
 * The contradiction is NEWLY AUDIBLE because of this plan: pre-A2 the earlier
 * board's write lost the same Map collision downstream too, so it never
 * reached `extracted_readings` and never got a read-back. Item 2's journal
 * projection correctly resurrects it — which is exactly what makes fixing this
 * drain part of the same change rather than a follow-up.
 *
 * `projectBoardReadingWinners` is the one authoritative answer to "which
 * effective board slots did this turn write?" — the same source the collapse
 * and the #31 gate already use. The stamp-only guard is kept, so a Symbol-less
 * legacy entry still contributes nothing and the new set is a strict SUPERSET
 * of the old one: single-board turns are unchanged.
 *
 * Found by the Codex pre-merge diff review, cycle 4.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-a2mb-notice-drain';

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

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const { BOARD_CLEAR_NOTICE_FAMILIES } = await import('../extraction/stage6-dispatchers-board.js');
const { CONFIRMATION_FRIENDLY_NAMES, deriveFriendlyName } =
  await import('../extraction/confirmation-text.js');

/** The rendered inventory of one notice family for one field. */
function familyTexts(family, field) {
  const friendly = CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);
  return BOARD_CLEAR_NOTICE_FAMILIES[family].map((f) => f(friendly));
}

const ALREADY_EMPTY_MANUFACTURER = familyTexts('board_clear_already_empty', 'manufacturer');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(boards, currentBoardId) {
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
      currentBoardId,
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

function registerEntry() {
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: {
      flags: { loadedBarrel: false },
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports: ['board_clear_v1'] },
      }),
    },
  });
}

function baseOpts() {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    chimeObserved: true,
  };
}

/** Dispatch the given calls through the REAL composed dispatcher. */
function loopDispatching(calls, { between } = {}) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    const toolCalls = [];
    for (let i = 0; i < calls.length; i += 1) {
      if (typeof between === 'function') between(i, opts);
      const c = calls[i];
      const env = await opts.dispatcher(
        { tool_call_id: c.id, name: c.name, input: c.input },
        opts.ctx
      );
      toolCalls.push({ tool_call_id: c.id, name: c.name, input: c.input, result: env });
    }
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: toolCalls,
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

/** A board write with `board_id` OMITTED — the shape the model actually emits. */
const writeManufacturer = (value, id) => ({
  name: 'record_board_reading',
  input: { field: 'manufacturer', value, confidence: 0.9, source_turn_id: 't1' },
  id,
});

const clearManufacturer = (id) => ({
  name: 'clear_board_reading',
  input: { field: 'manufacturer', reason: 'user_correction' },
  id,
});

const audibleConfs = (result) =>
  (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );

const alreadyEmptyConfs = (result) =>
  audibleConfs(result).filter((c) => ALREADY_EMPTY_MANUFACTURER.includes(c.text));

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  registerEntry();
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('A2-multiboard — the notice drain sees EVERY effective board write', () => {
  test('DISCRIMINATING: a later board colliding on the raw key no longer un-suppresses an earlier board own already-empty notice', async () => {
    // main: clear manufacturer (already blank -> notice staged) then write it.
    // Same effective slot, so the notice must yield to the write read-back.
    // garage: write manufacturer too — same raw Map key, `board_id` omitted on
    // both, so pre-fix garage's entry DESTROYED main's and the drain saw only
    // garage's slot.
    const session = makeSession(
      [
        { id: 'main', board_type: 'main' },
        { id: 'garage', board_type: 'sub_distribution' },
      ],
      'main'
    );
    loopDispatching(
      [
        clearManufacturer('toolu_c'),
        writeManufacturer('Wylex', 'toolu_w1'),
        writeManufacturer('Hager', 'toolu_w2'),
      ],
      {
        // `select_board garage` before the third call — the dispatcher mutates
        // `currentBoardId`, the only input to effective-board resolution.
        between: (i) => {
          if (i === 2) session.stateSnapshot.currentBoardId = 'garage';
        },
      }
    );

    const opts = baseOpts();
    const result = await runShadowHarness(session, 'cross-board manufacturer', [], opts);
    const speakers = audibleConfs(result);

    // Both writes survive projection and are read back (item 2) — that is what
    // makes the un-suppressed notice a CONTRADICTION rather than merely noise.
    const manufacturerReadbacks = speakers.filter((c) => c.field === 'manufacturer');
    expect(manufacturerReadbacks).toHaveLength(2);

    // Pre-fix this was length 1: "manufacturer is already blank" spoke beside
    // main's own "manufacturer recorded as Wylex".
    expect(alreadyEmptyConfs(result)).toHaveLength(0);
    expect(speakers).toHaveLength(2);
  });

  test('single-board: an already-empty notice is still suppressed by a same-slot write', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }], 'main');
    loopDispatching([clearManufacturer('toolu_c'), writeManufacturer('Wylex', 'toolu_w')]);

    const opts = baseOpts();
    const result = await runShadowHarness(session, 'clear then set manufacturer', [], opts);

    expect(alreadyEmptyConfs(result)).toHaveLength(0);
    expect(audibleConfs(result)).toHaveLength(1);
    expect(audibleConfs(result)[0].field).toBe('manufacturer');
  });

  test('a genuinely different board still PRESERVES the notice — suppression stays same-slot', async () => {
    // The mirror image of the discriminating case: the clear is on main and the
    // ONLY write is on garage. Nothing occupies main's slot, so main's notice
    // must still speak. This is what proves the fix widened the surviving set
    // without collapsing it back into whole-turn suppression.
    const session = makeSession(
      [
        { id: 'main', board_type: 'main' },
        { id: 'garage', board_type: 'sub_distribution' },
      ],
      'main'
    );
    loopDispatching([clearManufacturer('toolu_c'), writeManufacturer('Hager', 'toolu_w')], {
      between: (i) => {
        if (i === 1) session.stateSnapshot.currentBoardId = 'garage';
      },
    });

    const opts = baseOpts();
    const result = await runShadowHarness(session, 'cross-board manufacturer', [], opts);

    expect(alreadyEmptyConfs(result)).toHaveLength(1);
    expect(audibleConfs(result)).toHaveLength(2);
  });
});
