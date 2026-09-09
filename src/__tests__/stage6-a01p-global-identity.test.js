/**
 * A01P (2026-09-08) — `client_name` is an installation-GLOBAL identity field.
 * It bypasses board resolution end to end: record, clear, and inspect. The
 * defect: with a sub-board selected, "the client is Mrs Smith" was rejected
 * `wrong_board` (or landed on the sub-board record), a client-name clear
 * returned `board_clear_scope_unclassified`, and "what is the client's name?"
 * came back `not_found` — while the saved name sat in circuits[0].
 *
 * Fixed set: `GLOBAL_IDENTITY_FIELDS = {client_name}` in
 * stage6-snapshot-mutators.js. Never derived from BOARD_READING_SCOPE_MAP /
 * BOARD_CLEAR_SCOPE_MAP — Ze/PFC are 'global' there too and keep their
 * unconditional wrong_board on a mismatched or empty board_id (controls
 * below).
 *
 * `[invariant]` rows are red on the original backend (37dfde39):
 *   - record with garage selected + board_id 'main'/'unknown' → wrong_board
 *   - record with garage selected + absent/'garage' → boards[garage].client_name
 *   - clear client_name → board_clear_scope_unclassified (enum-admitted, unclassified)
 *   - inspect field client_name with an unknown board → not_found
 */

import { jest } from '@jest/globals';

const { dispatchRecordBoardReading, dispatchClearBoardReading, BOARD_CLEAR_SCOPE_MAP } =
  await import('../extraction/stage6-dispatchers-board.js');
const { createInspectDispatcher } = await import('../extraction/stage6-dispatchers-answer.js');
const { GLOBAL_IDENTITY_FIELDS, isGlobalIdentityField, applyBoardReadingFlagAware } =
  await import('../extraction/stage6-snapshot-mutators.js');
const { createPerTurnWrites, EFFECTIVE_BOARD_SLOT, projectBoardReadingWinners } =
  await import('../extraction/stage6-per-turn-writes.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const { CLEAR_BOARD_READING_FIELD_ENUM } = await import('../extraction/stage6-tool-schemas.js');

const SESSION_ID = 'sess-a01p-identity';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Garage SELECTED, main + garage boards, a name already saved in circuits[0]. */
function makeSession(stateOverrides = {}) {
  return {
    sessionId: SESSION_ID,
    certType: 'eicr',
    stateSnapshot: {
      circuits: { 0: {} },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution' },
      ],
      currentBoardId: 'garage',
      ...stateOverrides,
    },
    extractedObservations: [],
  };
}

function ctxFor(session, perTurnWrites) {
  return { session, logger: makeLogger(), turnId: 'turn-1', perTurnWrites, round: 1 };
}

function body(env) {
  return JSON.parse(env.content);
}

beforeEach(() => {
  activeSessions.set(SESSION_ID, {
    voiceLatency: {
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports: ['board_clear_v1'] },
      }),
    },
  });
});

afterEach(() => {
  activeSessions.clear();
});

describe('[invariant] GLOBAL_IDENTITY_FIELDS — the fixed set', () => {
  test('is exactly {client_name}, frozen, and the predicate canonicalises', () => {
    expect([...GLOBAL_IDENTITY_FIELDS]).toEqual(['client_name']);
    expect(Object.isFrozen(GLOBAL_IDENTITY_FIELDS)).toBe(true);
    expect(isGlobalIdentityField('client_name')).toBe(true);
    expect(isGlobalIdentityField('ze')).toBe(false);
    expect(isGlobalIdentityField('earth_loop_impedance_ze')).toBe(false);
    expect(isGlobalIdentityField('client_address')).toBe(false);
    expect(isGlobalIdentityField(undefined)).toBe(false);
  });

  test('BOARD_CLEAR_SCOPE_MAP classifies client_name global, but the set is not derived from it', () => {
    expect(BOARD_CLEAR_SCOPE_MAP.client_name).toBe('global');
    // ze/pfc are 'global' in the map and are NOT identity fields.
    expect(isGlobalIdentityField('pfc')).toBe(false);
    expect(CLEAR_BOARD_READING_FIELD_ENUM).toContain('client_name');
  });

  test('the mutator wrapper writes circuits[0] with a sub-board selected or named', () => {
    const { stateSnapshot } = makeSession();
    applyBoardReadingFlagAware(stateSnapshot, {
      field: 'client_name',
      value: 'Mrs Smith',
      boardId: 'garage',
    });
    expect(stateSnapshot.circuits[0].client_name).toBe('Mrs Smith');
    expect(stateSnapshot.boards[1]).not.toHaveProperty('client_name');
  });
});

describe('[invariant] record_board_reading client_name with the garage selected', () => {
  test.each([
    ['absent', undefined],
    ['current (garage)', 'garage'],
    ['main (non-current)', 'main'],
    ['unknown', 'shed'],
    ['empty string', ''],
  ])(
    'board_id %s → circuits[0] only, null effective slot, one journal winner',
    async (_l, boardId) => {
      const session = makeSession();
      const ptw = createPerTurnWrites();
      const input = { field: 'client_name', value: 'Mrs Smith', confidence: 0.9 };
      if (boardId !== undefined) input.board_id = boardId;
      const env = await dispatchRecordBoardReading(
        { tool_call_id: 'toolu_rec', name: 'record_board_reading', input },
        ctxFor(session, ptw)
      );
      expect(env.is_error).toBe(false);
      expect(body(env).ok).toBe(true);
      expect(session.stateSnapshot.circuits[0].client_name).toBe('Mrs Smith');
      expect(session.stateSnapshot.boards[0]).not.toHaveProperty('client_name');
      expect(session.stateSnapshot.boards[1]).not.toHaveProperty('client_name');
      // Exactly one journal winner, board-insensitive.
      const winners = projectBoardReadingWinners(ptw);
      expect(winners).toHaveLength(1);
      const entry = winners[0].value;
      expect(entry.value).toBe('Mrs Smith');
      expect(entry.boardId).toBeUndefined();
      expect(entry[EFFECTIVE_BOARD_SLOT]).toEqual({ field: 'client_name', boardId: null });
    }
  );

  test('control: a Ze write naming the non-current main board is still wrong_board with no mutation', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    const env = await dispatchRecordBoardReading(
      {
        tool_call_id: 'toolu_ze',
        name: 'record_board_reading',
        input: { field: 'ze', value: '0.35', confidence: 0.9, board_id: 'main' },
      },
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(true);
    expect(body(env).error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(projectBoardReadingWinners(ptw)).toHaveLength(0);
  });

  test('every other validation still runs: an address-shaped client_name is rejected regardless of board', async () => {
    const session = makeSession();
    const env = await dispatchRecordBoardReading(
      {
        tool_call_id: 'toolu_addr',
        name: 'record_board_reading',
        input: { field: 'client_name', value: '71 Hexham Road', confidence: 0.9, board_id: 'main' },
      },
      ctxFor(session, createPerTurnWrites())
    );
    expect(env.is_error).toBe(true);
    expect(body(env).error.code).toBe('client_name_looks_like_address');
  });
});

describe('[invariant] clear_board_reading client_name — global sweep from any board spelling', () => {
  /** A name persisted under every backend bucket a stale write could have reached. */
  function seeded() {
    return makeSession({
      circuits: { 0: { client_name: 'Mrs Smith', ze: '0.35' } },
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main', client_name: 'Mrs Smith' },
        {
          id: 'garage',
          designation: 'Garage CU',
          board_type: 'sub_distribution',
          client_name: 'Mrs Smith',
        },
      ],
    });
  }

  test.each([
    ['absent', undefined],
    ['current (garage)', 'garage'],
    ['unknown', 'shed'],
    ['mismatched existing (main)', 'main'],
    ['empty string', ''],
  ])(
    'board_id %s → every bucket cleared, one board-insensitive frame, one read-back frame',
    async (_l, boardId) => {
      const session = seeded();
      const ptw = createPerTurnWrites();
      const input = { field: 'client_name', reason: 'user_correction' };
      if (boardId !== undefined) input.board_id = boardId;
      const env = await dispatchClearBoardReading(
        { tool_call_id: 'toolu_clr', name: 'clear_board_reading', input },
        ctxFor(session, ptw)
      );
      expect(env.is_error).toBe(false);
      // Red on the original backend: `board_clear_scope_unclassified` (enum-admitted, unclassified).
      expect(body(env)).toEqual({ ok: true });
      expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('client_name');
      for (const b of session.stateSnapshot.boards) expect(b).not.toHaveProperty('client_name');
      // Ze untouched by a client-name clear.
      expect(session.stateSnapshot.circuits[0].ze).toBe('0.35');
      // Exactly one clear frame (the one read-back), routed to both clients:
      // circuit null + a REAL board id discriminator (the current board, never
      // the unknown/empty spelling), effective slot board-insensitive.
      expect(ptw.fieldCorrections).toHaveLength(1);
      const frame = ptw.fieldCorrections[0];
      expect(frame).toMatchObject({
        type: 'field_corrected',
        circuit: null,
        field: 'client_name',
        previous_value: 'Mrs Smith',
        reason: 'clear_reading',
        board_id: 'garage',
      });
      expect(frame[EFFECTIVE_BOARD_SLOT]).toEqual({ field: 'client_name', boardId: null });
      expect(ptw.mandatoryNotices).toHaveLength(0);
    }
  );

  test('control: a Ze clear naming the non-current main board is still wrong_board — no mutation, no notice, no frame', async () => {
    const session = seeded();
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      {
        tool_call_id: 'toolu_zeclr',
        name: 'clear_board_reading',
        input: { field: 'ze', reason: 'user_correction', board_id: 'main' },
      },
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(true);
    expect(body(env).error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.35');
    expect(ptw.mandatoryNotices).toHaveLength(0);
    expect(ptw.fieldCorrections).toHaveLength(0);
  });

  test('control: a Ze clear with an empty-string board_id is still wrong_board', async () => {
    const session = seeded();
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      {
        tool_call_id: 'toolu_zeclr2',
        name: 'clear_board_reading',
        input: { field: 'ze', reason: 'user_correction', board_id: '' },
      },
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(true);
    expect(body(env).error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.35');
  });

  test('an already-empty client_name clear is the spoken already-empty notice, not silence', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      {
        tool_call_id: 'toolu_empty',
        name: 'clear_board_reading',
        input: { field: 'client_name', reason: 'user_correction', board_id: 'shed' },
      },
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true, noop: true, reason: 'field_not_set' });
    expect(ptw.mandatoryNotices).toHaveLength(1);
    expect(ptw.mandatoryNotices[0].family).toBe('board_clear_already_empty');
  });
});

describe('[invariant] inspect_session_state scope=field client_name — global, board_id null, before resolveBoard', () => {
  function inspect(session, input, id = 'toolu_insp') {
    const dispatch = createInspectDispatcher(
      session,
      makeLogger(),
      'turn-1',
      createPerTurnWrites()
    );
    return dispatch({ tool_call_id: id, name: 'inspect_session_state', input });
  }

  test.each([
    ['absent', undefined],
    ['current (garage)', 'garage'],
    ['main', 'main'],
    ['unknown', 'shed'],
  ])('board_id %s → {ok:true, board_id:null, recorded:true}', async (_l, boardId) => {
    const session = makeSession({ circuits: { 0: { client_name: 'Mrs Smith' } } });
    const input = { scope: 'field', field: 'client_name' };
    if (boardId !== undefined) input.board_id = boardId;
    const env = await inspect(session, input);
    expect(env.is_error).toBe(false);
    expect(body(env)).toMatchObject({
      ok: true,
      scope: 'field',
      board_id: null,
      circuit: null,
      field: 'client_name',
      recorded: true,
    });
    expect(body(env).value).toContain('Mrs Smith');
  });

  test('a boards-less snapshot (legacy) still answers the name with board_id null', async () => {
    const session = makeSession({
      boards: [],
      currentBoardId: undefined,
      circuits: { 0: { client_name: 'Mrs Smith' } },
    });
    const env = await inspect(session, { scope: 'field', field: 'client_name' });
    expect(body(env)).toMatchObject({ ok: true, board_id: null, recorded: true });
  });

  test('no name recorded → recorded:false, board_id null (never not_found)', async () => {
    const session = makeSession();
    const env = await inspect(session, { scope: 'field', field: 'client_name', board_id: 'shed' });
    expect(body(env)).toMatchObject({ ok: true, board_id: null, recorded: false, value: null });
  });

  test('control: a Ze lookup with an unknown board is still not_found', async () => {
    const session = makeSession({ circuits: { 0: { earth_loop_impedance_ze: '0.35' } } });
    const env = await inspect(session, {
      scope: 'field',
      field: 'earth_loop_impedance_ze',
      board_id: 'shed',
    });
    expect(env.is_error).toBe(true);
    expect(body(env)).toEqual({ ok: false, code: 'not_found' });
  });

  test('no mutation from any identity inspect', async () => {
    const session = makeSession({ circuits: { 0: { client_name: 'Mrs Smith' } } });
    const before = JSON.parse(JSON.stringify(session.stateSnapshot));
    await inspect(session, { scope: 'field', field: 'client_name', board_id: 'shed' });
    expect(session.stateSnapshot).toEqual(before);
  });
});
