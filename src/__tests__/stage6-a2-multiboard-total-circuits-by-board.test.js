/**
 * A2-multiboard item 8 (2026-07-28) — "All circuits" must be measured against
 * the board the confirmation is ABOUT.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `totalCircuitsInJob` is ONE session-wide scalar. The bundler hands it to
 * every fan-out group, and `buildGroupedConfirmationText` says "All circuits,
 * Zs recorded as X" the moment the group's circuit count equals it. Two things
 * were wrong with that on a multi-board job:
 *
 *   1. The scalar counted only BARE-numeric snapshot keys. Per
 *      `stage6-multi-board-shape.js`, only the legacy-namespace owner's
 *      circuits live under bare keys; every OTHER board's live under
 *      `${board_id}::${ref}`, and `Number('garage::3')` is NaN. So a sub-board
 *      circuit was never counted at ALL — a sub-board fan-out could not reach
 *      "All circuits" even when it genuinely covered the whole board.
 *
 *   2. The scalar is keyed to the SESSION'S selected board, but a confirmation
 *      GROUP belongs to whichever board the DISPATCHER resolved for its writes.
 *      Measuring a garage group against the main board's population is how
 *      "All circuits" comes to assert a completeness about a DIFFERENT board.
 *
 * Both directions matter, and they are not symmetric in cost. The under-claim
 * (leg 2) is a cosmetic loss — the inspector hears a range instead of "all".
 * The OVER-claim (leg 1) is an inaudible lie: a hands-free inspector working in
 * AirPods has no screen to check, and the one phrasing whose entire job is to
 * assert completeness is asserting it about circuits that were never written.
 *
 * ── What replaced it ───────────────────────────────────────────────────────
 *
 * The harness now builds `totalCircuitsByBoard` alongside the scalar (both key
 * namespaces folded in, each bucket counted under its own effective board id),
 * and the bundler resolves each GROUP's effective board — from the wire
 * `board_id` when present, else from the dispatcher-stamped
 * `EFFECTIVE_CIRCUIT_SLOT` WeakMap. That fallback is load-bearing: item 1
 * deliberately withholds wire enrichment on a single-board TURN of a
 * multi-board job, so the wire field alone would leave the common case
 * unattributable.
 *
 * Resolution is fail-closed at every step (legs 4-6): an unknown board, or a
 * group whose board cannot be resolved on a multi-board job, yields `null` and
 * therefore a range/list line — never "All".
 *
 * ── Vehicle ────────────────────────────────────────────────────────────────
 *
 * Legs 1-3 drive the REAL harness with the REAL circuit dispatchers and the
 * REAL bundler (the `runToolLoop` mock only stands in for the model, replaying
 * calls through the dispatcher the harness composed), so the census, the
 * grouping and the phrasing are exercised end-to-end. Legs 4-6 are bundler-unit
 * tests, because a group with NO resolvable board is precisely what a legacy
 * caller produces and cannot be staged through the dispatchers.
 *
 * Mock pattern mirrors stage6-a2-multiboard-board-fold.test.js.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-a2-total-by-board';

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
const { bundleToolCallsIntoResult } = await import('../extraction/stage6-event-bundler.js');
const { encodeReadingKey, EFFECTIVE_CIRCUIT_SLOT } =
  await import('../extraction/stage6-per-turn-writes.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const TWO_BOARDS = [
  { id: 'main', designation: 'Main DB', board_type: 'main' },
  { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution' },
];

/**
 * Build a snapshot `circuits` map across BOTH key namespaces: `mainRefs` under
 * bare numeric keys (the legacy-namespace owner) and `subRefs` under
 * `${subBoardId}::${ref}`. This split IS the bug's habitat — a fixture that
 * used only bare keys could not reproduce it.
 */
function makeCircuits({ mainRefs = [], subRefs = [], subBoardId = 'garage' } = {}) {
  const circuits = {};
  for (const ref of mainRefs) {
    circuits[String(ref)] = { circuit_ref: ref };
  }
  for (const ref of subRefs) {
    circuits[`${subBoardId}::${ref}`] = { circuit_ref: ref, board_id: subBoardId };
  }
  return circuits;
}

function makeSession({ circuits, boards = TWO_BOARDS } = {}) {
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
      circuits,
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

/** Replay `calls` through the dispatcher the harness composed (see header). */
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

const selectBoard = (boardId) => ({
  tool_call_id: `toolu_sel_${boardId}`,
  name: 'select_board',
  input: { board_id: boardId },
});

/**
 * One value across N circuits — the shape that groups into a single fan-out
 * confirmation. `measured_zs_ohm` is deliberate: it is EXCLUDED from the Plan-D
 * impedance clamp, so the spoken value is the dictated one and the assertion
 * cannot be confounded by a clamp correction clause.
 */
const zsWrites = (refs) =>
  refs.map((ref) => ({
    tool_call_id: `toolu_zs_${ref}`,
    name: 'record_reading',
    input: { field: 'measured_zs_ohm', circuit: ref, value: '0.55', confidence: 0.9 },
  }));

const zsConfirmation = (result) =>
  (result.confirmations ?? [])
    .map((c) => c.text)
    .find((t) => typeof t === 'string' && /Zs/i.test(t));

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

// ---------------------------------------------------------------------------
// Legs 1-3 — real harness, real dispatchers, real bundler.
// ---------------------------------------------------------------------------

describe('item 8 — a fan-out is counted against ITS board, not the session scalar', () => {
  test('OVER-CLAIM: 3 of the garage’s 6 circuits never say "All circuits" (main happens to have 3)', async () => {
    // The trap, staged exactly: main has 3 circuits, so the legacy scalar is 3;
    // the garage has 6 and only 3 were written. Pre-item-8 the counts matched
    // by coincidence and the inspector heard a completeness claim about a board
    // that was half untouched.
    const session = makeSession({
      circuits: makeCircuits({ mainRefs: [1, 2, 3], subRefs: [1, 2, 3, 4, 5, 6] }),
    });
    driveToolCalls([selectBoard('garage'), ...zsWrites([1, 2, 3])]);

    const result = await runShadowHarness(
      session,
      'Zs on circuits one two and three is nought point five five.',
      [],
      baseOpts()
    );

    const text = zsConfirmation(result);
    expect(text).toBe('Circuits 1 to 3, Zs 0.55');
    expect(text).not.toContain('All circuits');
  });

  test('UNDER-CLAIM: covering ALL 3 of the garage’s circuits DOES say "All circuits" (main has 6)', async () => {
    // The mirror image, and the leg that proves composite `garage::N` buckets
    // are censused at all: before item 8 they were invisible (`Number()` → NaN),
    // so a genuinely complete sub-board fan-out could never qualify.
    const session = makeSession({
      circuits: makeCircuits({ mainRefs: [1, 2, 3, 4, 5, 6], subRefs: [1, 2, 3] }),
    });
    driveToolCalls([selectBoard('garage'), ...zsWrites([1, 2, 3])]);

    const result = await runShadowHarness(
      session,
      'Zs on circuits one two and three is nought point five five.',
      [],
      baseOpts()
    );

    expect(zsConfirmation(result)).toBe('All circuits, Zs 0.55');
  });

  test('GATE INTACT: a single-board job still reaches "All circuits" via the legacy scalar', async () => {
    // The scalar's own arithmetic is unchanged on purpose. A single-board job
    // has one census entry, so `jobIsMultiBoard` is false and the resolution
    // collapses to pre-item-8 behaviour.
    const session = makeSession({
      circuits: makeCircuits({ mainRefs: [1, 2, 3] }),
      boards: [{ id: 'main', designation: 'Main DB', board_type: 'main' }],
    });
    driveToolCalls(zsWrites([1, 2, 3]));

    const result = await runShadowHarness(
      session,
      'Zs on circuits one two and three is nought point five five.',
      [],
      baseOpts()
    );

    expect(zsConfirmation(result)).toBe('All circuits, Zs 0.55');
  });
});

// ---------------------------------------------------------------------------
// Legs 4-6 — bundler unit, for the groups the dispatchers cannot stage.
// ---------------------------------------------------------------------------

/**
 * Build a perTurnWrites `readings` Map of one field/value across `refs`.
 * `boardId === undefined` leaves the entry with NO effective-slot Symbol — the
 * legacy/unattributable shape leg 4 exists for.
 */
function readingsFor(refs, boardId) {
  const readings = new Map();
  for (const ref of refs) {
    const entry = {
      value: '0.55',
      confidence: 0.9,
      source_turn_id: 't1',
    };
    if (boardId !== undefined) {
      Object.defineProperty(entry, EFFECTIVE_CIRCUIT_SLOT, {
        value: { field: 'measured_zs_ohm', circuit: ref, boardId },
        enumerable: false,
      });
    }
    readings.set(encodeReadingKey('measured_zs_ohm', ref), entry);
  }
  return readings;
}

function bundle(readings, options) {
  return bundleToolCallsIntoResult(
    {
      readings,
      cleared: [],
      observations: [],
      deletedObservations: [],
      circuitOps: [],
      boardOps: [],
    },
    null,
    { confirmationsEnabled: true, ...options }
  );
}

describe('item 8 — resolution fails CLOSED whenever the group’s board is not knowable', () => {
  test('a boardless group on a MULTI-board job never claims "All circuits"', () => {
    // Three writes, three circuits in the census for `main` — pre-item-8 that
    // is an exact match and would have spoken "All circuits". With two boards
    // in the census and no attribution on the group, we cannot know which
    // population to measure against, so we decline to claim completeness.
    const result = bundle(readingsFor([1, 2, 3], undefined), {
      totalCircuitsInJob: 3,
      totalCircuitsByBoard: new Map([
        ['main', 3],
        ['garage', 6],
      ]),
    });

    expect(zsConfirmation(result)).toBe('Circuits 1 to 3, Zs 0.55');
  });

  test('a boardless group on a SINGLE-board job still uses the scalar', () => {
    const result = bundle(readingsFor([1, 2, 3], undefined), {
      totalCircuitsInJob: 3,
      totalCircuitsByBoard: new Map([['main', 3]]),
    });

    expect(zsConfirmation(result)).toBe('All circuits, Zs 0.55');
  });

  test('a group naming a board ABSENT from the census never claims "All circuits"', () => {
    // A stale or unknown board id. The scalar would match (3 === 3); an
    // unknown population must not borrow another board's count.
    const result = bundle(readingsFor([1, 2, 3], 'shed'), {
      totalCircuitsInJob: 3,
      totalCircuitsByBoard: new Map([
        ['main', 3],
        ['garage', 6],
      ]),
    });

    expect(zsConfirmation(result)).toBe('Circuits 1 to 3, Zs 0.55');
  });

  test('LEGACY CALLER: no census at all falls back to the scalar, byte-identical to pre-item-8', () => {
    // Hand-built fixtures and older call sites pass no `totalCircuitsByBoard`.
    // They must be completely unaffected.
    const result = bundle(readingsFor([1, 2, 3], undefined), { totalCircuitsInJob: 3 });

    expect(zsConfirmation(result)).toBe('All circuits, Zs 0.55');
  });
});
