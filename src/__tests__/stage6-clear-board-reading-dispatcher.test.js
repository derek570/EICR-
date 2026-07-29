/**
 * Plan A1a (2026-07-27, feedback id 101) — dispatchClearBoardReading unit +
 * integration tests: §5 rows 3, 4 (incl. the four hydration legs), 5, 19
 * (envelope half), 20 (validation order), the §3.3a scope-sweep trio, the
 * §3.5 rotation contract, and mechanism A (same-turn write→clear delete).
 *
 * RED discipline: on unfixed main every clear_board_reading call returns
 * `unknown_tool` (a hard rejection), so every row here asserts a SPECIFIC
 * error code or a SPECIFIC post-state that unknown_tool cannot satisfy.
 */

import { jest } from '@jest/globals';

// The four hydration legs construct a REAL EICRExtractionSession — mock the
// SDK so start()'s cache keepalive never fires a network call or arms timers
// (the eicr-extraction-session.test.js pattern).
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({ messages: { create: jest.fn(async () => ({ content: [] })) } })),
}));

const {
  dispatchClearBoardReading,
  dispatchRecordBoardReading,
  dispatchSelectBoard,
  dispatchAddBoard,
  BOARD_CLEAR_SCOPE_MAP,
  BOARD_CLEAR_NOTICE_FAMILIES,
  selectMandatoryNoticeText,
} = await import('../extraction/stage6-dispatchers-board.js');
const { createPerTurnWrites, EFFECTIVE_BOARD_SLOT, boardSlotKey, encodeBoardReadingKey } =
  await import('../extraction/stage6-per-turn-writes.js');
const { boardFieldAliasSet, clearBoardReadingFlagAware } =
  await import('../extraction/stage6-snapshot-mutators.js');
const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');

// A1b (2026-07-29) -- the dispatcher reads `board_clear_v1` LIVE from the
// active-sessions registry (never `ctx.hasBoardClearV1`), so the capable
// state is expressed by a REAL registry entry. The ctx flag remains in
// ctxFor as the (now ignored) turn-start snapshot the fence deliberately
// bypasses.
function setBoardClearCapability(on, sessionId = 'sess-cbr-unit') {
  activeSessions.set(sessionId, {
    voiceLatency: {
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports: on ? ['board_clear_v1'] : [] },
      }),
    },
  });
}

beforeEach(() => {
  setBoardClearCapability(true);
});

afterEach(() => {
  activeSessions.clear();
});

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(stateOverrides = {}, extra = {}) {
  return {
    sessionId: 'sess-cbr-unit',
    certType: 'eicr',
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      ...stateOverrides,
    },
    extractedObservations: [],
    ...extra,
  };
}

function ctxFor(session, perTurnWrites, extra = {}) {
  return {
    session,
    logger: makeLogger(),
    turnId: 'turn-1',
    perTurnWrites,
    round: 1,
    hasBoardClearV1: true,
    ...extra,
  };
}

function call(input, id = 'toolu_cbr') {
  return { tool_call_id: id, name: 'clear_board_reading', input };
}

function body(env) {
  return JSON.parse(env.content);
}

afterEach(() => {
  delete process.env.BOARD_CLEAR_DISABLED;
});

// ───────────────────────────────────────────────────────────────────────────
describe('boardFieldAliasSet (§3.2 dual-slot obligation)', () => {
  test("ze's alias set carries BOTH spellings; pfc's carries both; a plain field is a singleton-plus-canonical", () => {
    expect(boardFieldAliasSet('ze')).toEqual(new Set(['ze', 'earth_loop_impedance_ze']));
    expect(boardFieldAliasSet('earth_loop_impedance_ze')).toEqual(
      new Set(['ze', 'earth_loop_impedance_ze'])
    );
    expect(boardFieldAliasSet('prospective_fault_current')).toEqual(
      new Set(['pfc', 'prospective_fault_current'])
    );
    expect(boardFieldAliasSet('manufacturer')).toEqual(new Set(['manufacturer']));
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 3 — alias-set clearing (round-5 BLOCKER)', () => {
  test('write under earth_loop_impedance_ze, clear via ze → NO value survives under EITHER key', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    // Write via the REAL write dispatcher under the RAW alias spelling —
    // record_board_reading stores the raw key (canonicalisation is
    // outbound-only at the bundler).
    const wEnv = await dispatchRecordBoardReading(
      {
        tool_call_id: 'toolu_w',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.35',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      ctxFor(session, ptw)
    );
    expect(body(wEnv).ok).toBe(true);
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.35');

    // Clear in a FRESH turn (no same-turn collapse) via the advertised
    // spelling 'ze'.
    const clearPtw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, clearPtw)
    );
    expect(body(env)).toEqual({ ok: true });
    // The discriminating post-state: a literal-key implementation clears
    // only 'ze', reports success, and the value re-asserts from the
    // untouched alias on the next snapshot.
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('earth_loop_impedance_ze');
    // The §3.4b wire entry: circuit null + non-null board_id + literal reason.
    expect(clearPtw.fieldCorrections).toHaveLength(1);
    expect(clearPtw.fieldCorrections[0]).toMatchObject({
      type: 'field_corrected',
      circuit: null,
      field: 'ze',
      previous_value: '0.35',
      reason: 'clear_reading',
      board_id: 'main',
    });
    // Stamped with the CANONICAL, board-INSENSITIVE slot (ze is global).
    expect(clearPtw.fieldCorrections[0][EFFECTIVE_BOARD_SLOT]).toEqual({
      field: 'ze',
      boardId: null,
    });
  });

  test('reverse leg: write ze, clear ze → both alias keys empty', async () => {
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('earth_loop_impedance_ze');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§3.3a — backend storage-scope sweep (the round-6 BLOCKER trio)', () => {
  test('(i) ze written with MAIN selected, cleared while a SUB-board is selected → circuits[0] emptied under both aliases; global cell gone', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    // Seed everywhere a global value could live, under BOTH aliases, so a
    // partial sweep fails.
    session.stateSnapshot.circuits[0] = { ze: '0.3', earth_loop_impedance_ze: '0.3' };
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main', ze: '0.3' },
      { id: 'sub-1', board_type: 'sub_distribution', earth_loop_impedance_ze: '0.3' },
    ];
    session.stateSnapshot.currentBoardId = 'sub-1';
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('earth_loop_impedance_ze');
    for (const b of session.stateSnapshot.boards) {
      expect(b).not.toHaveProperty('ze');
      expect(b).not.toHaveProperty('earth_loop_impedance_ze');
    }
  });

  test('(ii) mirror: ze written on a sub-board, cleared with MAIN selected → boards[sub] emptied too', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_distribution', ze: '0.5' },
    ];
    session.stateSnapshot.currentBoardId = 'main';
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.boards.find((b) => b.id === 'sub-1')).not.toHaveProperty('ze');
  });

  test('(iii) board-scoped control: manufacturer on board A stays intact when cleared while board B is selected', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main', manufacturer: 'Hager' },
      { id: 'sub-1', board_type: 'sub_distribution', manufacturer: 'Wylex' },
    ];
    session.stateSnapshot.currentBoardId = 'sub-1';
    const env = await dispatchClearBoardReading(
      call({ field: 'manufacturer', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    // The sweep did NOT over-reach into the per-board field on board A.
    expect(session.stateSnapshot.boards.find((b) => b.id === 'main').manufacturer).toBe('Hager');
    expect(session.stateSnapshot.boards.find((b) => b.id === 'sub-1')).not.toHaveProperty(
      'manufacturer'
    );
    // Board-scoped stamp carries the resolved board id.
    expect(ptw.fieldCorrections[0][EFFECTIVE_BOARD_SLOT]).toEqual({
      field: 'manufacturer',
      boardId: 'sub-1',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 4 — multi-board targeting via select_board (+ the four hydration legs)', () => {
  test('clear after select_board targets the selected board only; the other board manufacturer untouched', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main', manufacturer: 'Hager' },
      { id: 'garage', board_type: 'sub_distribution', manufacturer: 'Wylex' },
    ];
    await dispatchSelectBoard(
      { tool_call_id: 'toolu_sel', name: 'select_board', input: { board_id: 'garage' } },
      ctxFor(session, ptw)
    );
    expect(session.stateSnapshot.currentBoardId).toBe('garage');
    const env = await dispatchClearBoardReading(
      call({ field: 'manufacturer', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.boards.find((b) => b.id === 'garage')).not.toHaveProperty(
      'manufacturer'
    );
    expect(session.stateSnapshot.boards.find((b) => b.id === 'main').manufacturer).toBe('Hager');
  });

  // The four PRODUCTION-HYDRATION legs (§3.3a canonical-main caveat): drive
  // the REAL EICRExtractionSession.start/_seedStateFromJobState seam — never
  // a hand-built raw snapshot — then dispatch the clear against the hydrated
  // session and assert the canonical-main target resolution.
  const hydrated = [];
  function hydratedSession(boards) {
    // A1b — the live-read fence keys on THIS session's id.
    setBoardClearCapability(true, 'sess-hydra');
    const s = new EICRExtractionSession('k', 'sess-hydra', 'eicr');
    s.start({
      circuits: [{ circuit_ref: 1, circuit_designation: 'Lights' }],
      ...(boards === undefined ? {} : { boards }),
    });
    hydrated.push(s);
    return s;
  }
  afterEach(() => {
    // stop() tears down the keepalive timer so jest can exit.
    while (hydrated.length) {
      try {
        hydrated.pop().stop();
      } catch {
        /* already stopped */
      }
    }
  });

  test('(4h-i) reordered [sub, main]: canonical main is the main-typed record, not boards[0]', async () => {
    const s = hydratedSession([
      { id: 'sub-1', board_type: 'sub_distribution', manufacturer: 'Wylex' },
      { id: 'main', board_type: 'main', manufacturer: 'Hager' },
    ]);
    expect(s.stateSnapshot.currentBoardId).toBe('main');
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'manufacturer', reason: 'user_correction' }),
      ctxFor(s, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    // The clear hit the CANONICAL main, never the reordered sub at index 0.
    expect(s.stateSnapshot.boards.find((b) => b.id === 'sub-1').manufacturer).toBe('Wylex');
    expect(s.stateSnapshot.boards.find((b) => b.id === 'main')).not.toHaveProperty('manufacturer');
  });

  test('(4h-ii) sub-only payload: the synthesized {id:main} identity is retained as canonical main', async () => {
    const s = hydratedSession([
      { id: 'sub-1', board_type: 'sub_distribution', manufacturer: 'Wylex' },
    ]);
    // Production hydration prepends/retains a main-shaped record.
    expect(s.stateSnapshot.currentBoardId).toBe('main');
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'manufacturer', reason: 'user_correction' }),
      ctxFor(s, ptw)
    );
    // Main-target board-scoped clear over an empty main → already-empty
    // notice path; the SUB board is untouched.
    expect(body(env)).toEqual({ ok: true, noop: true, reason: 'field_not_set' });
    expect(s.stateSnapshot.boards.find((b) => b.id === 'sub-1').manufacturer).toBe('Wylex');
  });

  test('(4h-iii) id-less junk + sub: junk dropped, synth main retained, clear targets canonical main', async () => {
    const s = hydratedSession([{}, { id: 'sub-1', board_type: 'sub_distribution', ze: '0.9' }]);
    expect(s.stateSnapshot.currentBoardId).toBe('main');
    const ptw = createPerTurnWrites();
    // Global ze clear sweeps the sub record too (board-insensitive).
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(s, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(s.stateSnapshot.boards.find((b) => b.id === 'sub-1')).not.toHaveProperty('ze');
  });

  test('(4h-iv) no boards payload: synth default main; clear resolves against it', async () => {
    const s = hydratedSession(undefined);
    expect(s.stateSnapshot.currentBoardId).toBe('main');
    // Seed a supply Ze the way the seeder would have (circuits[0] bucket).
    s.stateSnapshot.circuits[0] = { ...(s.stateSnapshot.circuits[0] ?? {}), ze: '0.29' };
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(s, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(s.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 5 — same-board write→clear (mechanism A), six legs + the global twin', () => {
  test('board-scoped manufacturer: write then clear in ONE turn — all six legs', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    const ctx = ctxFor(session, ptw);
    await dispatchRecordBoardReading(
      {
        tool_call_id: 'toolu_w1',
        name: 'record_board_reading',
        input: { field: 'manufacturer', value: 'Hager', confidence: 0.9, source_turn_id: 't1' },
      },
      ctx
    );
    // Leg 0 — the write really landed in perTurnWrites BEFORE the clear.
    const writeKey = encodeBoardReadingKey('manufacturer', undefined);
    expect(ptw.boardReadings.has(writeKey)).toBe(true);
    // Leg 0b — write-side stamp equals the slot the clear will resolve.
    const writeSym = ptw.boardReadings.get(writeKey)[EFFECTIVE_BOARD_SLOT];
    expect(writeSym).toEqual({ field: 'manufacturer', boardId: 'main' });
    // Leg 1b precondition — the snapshot holds the value pre-clear.
    const mainBoard = session.stateSnapshot.boards.find((b) => b.id === 'main');
    const preClearValue =
      session.stateSnapshot.circuits[0]?.manufacturer ?? mainBoard?.manufacturer;
    expect(preClearValue).toBe('Hager');

    const env = await dispatchClearBoardReading(
      call({ field: 'manufacturer', reason: 'user_correction' }),
      ctx
    );
    expect(body(env)).toEqual({ ok: true });
    // Leg 0b (clear side): identical slot.
    expect(boardSlotKey(writeSym.field, writeSym.boardId)).toBe(
      boardSlotKey('manufacturer', 'main')
    );
    // Leg 1 — no surviving write entry for the slot.
    expect(ptw.boardReadings.has(writeKey)).toBe(false);
    // Leg 1b — THE FIELD IS ACTUALLY GONE FROM THE SNAPSHOT (a dispatcher
    // that books-keeps without calling the mutator passes every other leg).
    expect(session.stateSnapshot.circuits[0] ?? {}).not.toHaveProperty('manufacturer');
    expect(session.stateSnapshot.boards.find((b) => b.id === 'main')).not.toHaveProperty(
      'manufacturer'
    );
    // Leg 2 — the field_corrected clear entry IS produced.
    const clears = ptw.fieldCorrections.filter((c) => c.reason === 'clear_reading');
    expect(clears).toHaveLength(1);
    expect(clears[0].circuit).toBeNull();
    // Leg 3 (speech) is pinned at the bundler/seam suites — here we assert
    // the #31 precondition: the write was DELETED, so writtenSlots cannot
    // suppress the clear.
  });

  test('sixth leg — global ze: slot is field-only in BOTH stamps; the delete fires across a board switch', async () => {
    const session = makeSession();
    session.stateSnapshot.boards = [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_distribution' },
    ];
    const ptw = createPerTurnWrites();
    const ctx = ctxFor(session, ptw);
    await dispatchRecordBoardReading(
      {
        tool_call_id: 'toolu_w2',
        name: 'record_board_reading',
        input: { field: 'ze', value: '0.31', confidence: 0.9, source_turn_id: 't1' },
      },
      ctx
    );
    const writeKey = encodeBoardReadingKey('ze', undefined);
    const writeSym = ptw.boardReadings.get(writeKey)[EFFECTIVE_BOARD_SLOT];
    // A global field that acquires a board component is the §3.4
    // over-precise identity bug (P5's ordering wipe) reappearing.
    expect(writeSym).toEqual({ field: 'ze', boardId: null });

    // select_board is a NO-OP on a global slot: the write on main and the
    // clear on sub-1 are one and the same slot — the delete fires, the
    // clear survives, the single global cell ends empty (last-intent-wins).
    await dispatchSelectBoard(
      { tool_call_id: 'toolu_sel', name: 'select_board', input: { board_id: 'sub-1' } },
      ctx
    );
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctx
    );
    expect(body(env)).toEqual({ ok: true });
    expect(ptw.boardReadings.has(writeKey)).toBe(false);
    const clears = ptw.fieldCorrections.filter((c) => c.reason === 'clear_reading');
    expect(clears).toHaveLength(1);
    expect(clears[0][EFFECTIVE_BOARD_SLOT]).toEqual({ field: 'ze', boardId: null });
    expect(session.stateSnapshot.circuits[0] ?? {}).not.toHaveProperty('ze');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 20 — the pinned validation order (enum → capability → cert-type → mutator)', () => {
  test('(20) off-enum field + capability ABSENT + kill-switch ENABLED → hard invalid_field WINS; no notice, no mutation, no frame', async () => {
    process.env.BOARD_CLEAR_DISABLED = 'true';
    setBoardClearCapability(false);
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'not_a_field', reason: 'user_correction' }),
      ctxFor(session, ptw, { hasBoardClearV1: false })
    );
    expect(env.is_error).toBe(true);
    expect(body(env).error.code).toBe('invalid_field');
    expect(ptw.mandatoryNotices).toHaveLength(0);
    expect(ptw.fieldCorrections).toHaveLength(0);
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
  });

  test('(20b) UPPERCASE-EICR comments + capability ABSENT → board_clear_capability_missing (denial precedes the cert-type refusal)', async () => {
    setBoardClearCapability(false);
    const session = makeSession({}, { certType: 'EICR' });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'comments', reason: 'user_correction' }),
      ctxFor(session, ptw, { hasBoardClearV1: false })
    );
    expect(env.is_error).toBe(false);
    expect(body(env)).toEqual({
      ok: true,
      skipped: true,
      reason: 'board_clear_capability_missing',
    });
    expect(ptw.mandatoryNotices).toHaveLength(1);
    expect(ptw.mandatoryNotices[0].family).toBe('board_clear_capability_missing');
  });

  test('(20c) the same with capability PRESENT → field_not_applicable_on_eicr (casing-defended: certType authored UPPERCASE)', async () => {
    const session = makeSession({ circuits: { 0: { comments: 'seeded' } } }, { certType: 'EICR' });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'comments', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(false);
    expect(body(env)).toEqual({ ok: true, skipped: true, reason: 'field_not_applicable_on_eicr' });
    // State untouched, no frame, refusal family staged.
    expect(session.stateSnapshot.circuits[0].comments).toBe('seeded');
    expect(ptw.fieldCorrections).toHaveLength(0);
    expect(ptw.mandatoryNotices[0].family).toBe('field_not_applicable_on_eicr');
  });

  test('(20d) capable + applicable + classified field → mutation reached only after ALL guards', async () => {
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
  });

  test('empty-string board_id → HARD wrong_board, no mutation, no notice, no frame (never normalised to the current board)', async () => {
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction', board_id: '' }),
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(true);
    expect(body(env).error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(ptw.mandatoryNotices).toHaveLength(0);
    expect(ptw.fieldCorrections).toHaveLength(0);
  });

  test('EIC session: the EICR refusal does NOT fire for comments — the next gate (scope classification) owns the outcome', async () => {
    // In A1a `comments` is not in the minimal scope map, so on an EIC the
    // clear falls through the cert-type gate (correct: the refusal is
    // EICR-only) and fails CLOSED at scope classification. A1b's full sweep
    // classifies it; this leg pins that the cert-type gate never
    // mis-fires on an EIC.
    const session = makeSession({ circuits: { 0: { comments: 'old note' } } }, { certType: 'eic' });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'comments', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({
      ok: true,
      skipped: true,
      reason: 'board_clear_scope_unclassified',
    });
    expect(body(env).reason).not.toBe('field_not_applicable_on_eicr');
    expect(session.stateSnapshot.circuits[0].comments).toBe('old note');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 19 (envelope half) — unknown scope fails CLOSED', () => {
  test('a valid-enum member absent from the pinned scope map → soft skip board_clear_scope_unclassified, no mutation, no frame, one staged notice', async () => {
    // earthing_arrangement is a real enum member with NO A1a scope entry.
    const session = makeSession({ circuits: { 0: { earthing_arrangement: 'TN-C-S' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'earthing_arrangement', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(false);
    expect(body(env)).toEqual({
      ok: true,
      skipped: true,
      reason: 'board_clear_scope_unclassified',
    });
    expect(session.stateSnapshot.circuits[0].earthing_arrangement).toBe('TN-C-S');
    expect(ptw.fieldCorrections).toHaveLength(0);
    expect(ptw.mandatoryNotices).toHaveLength(1);
    expect(ptw.mandatoryNotices[0].family).toBe('board_clear_scope_unclassified');
  });

  test('the pinned A1a scope map is exactly the minimal literal (ze/pfc global, manufacturer board)', () => {
    expect(BOARD_CLEAR_SCOPE_MAP).toEqual({ ze: 'global', pfc: 'global', manufacturer: 'board' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('tests 9/10 (dispatcher half) — deny-first capability gate + kill-switch', () => {
  test('capability absent → soft skip board_clear_capability_missing; field still populated; no frame', async () => {
    setBoardClearCapability(false);
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw, { hasBoardClearV1: false })
    );
    expect(env.is_error).toBe(false);
    expect(body(env)).toEqual({
      ok: true,
      skipped: true,
      reason: 'board_clear_capability_missing',
    });
    // Explicitly NOT unknown_tool — the non-discrimination guard.
    expect(env.content).not.toContain('unknown_tool');
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(ptw.fieldCorrections).toHaveLength(0);
  });

  test('kill-switch denies a CAPABLE client with the DISTINCT board_clear_disabled code + distinct family', async () => {
    process.env.BOARD_CLEAR_DISABLED = 'true';
    const session = makeSession({ circuits: { 0: { ze: '0.4' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(body(env)).toEqual({ ok: true, skipped: true, reason: 'board_clear_disabled' });
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.4');
    expect(ptw.mandatoryNotices[0].family).toBe('board_clear_disabled');
    // The two spoken families are string-distinct (field-report separability).
    const capTexts = BOARD_CLEAR_NOTICE_FAMILIES.board_clear_capability_missing.map((f) => f('Ze'));
    const killTexts = BOARD_CLEAR_NOTICE_FAMILIES.board_clear_disabled.map((f) => f('Ze'));
    for (const t of killTexts) expect(capTexts).not.toContain(t);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§3.5 — notice families + rotation contract', () => {
  test('all five families exist, each with ≥3 variants, all pairwise string-distinct for a fixed field', () => {
    const familyKeys = Object.keys(BOARD_CLEAR_NOTICE_FAMILIES);
    expect(familyKeys.sort()).toEqual(
      [
        'board_clear_capability_missing',
        'board_clear_disabled',
        'board_clear_already_empty',
        'field_not_applicable_on_eicr',
        'board_clear_scope_unclassified',
      ].sort()
    );
    const all = [];
    for (const key of familyKeys) {
      const variants = BOARD_CLEAR_NOTICE_FAMILIES[key].map((f) => f('Ze'));
      expect(variants.length).toBeGreaterThanOrEqual(3);
      all.push(...variants);
    }
    expect(new Set(all).size).toBe(all.length);
    // Never a "didn't catch that" / "say it again" — the request WAS
    // understood; that wording is the infinite-retry invitation.
    for (const text of all) {
      expect(text.toLowerCase()).not.toContain('catch that');
      expect(text.toLowerCase()).not.toContain('say it again');
      expect(text.toLowerCase()).not.toContain('say that again');
    }
  });

  test('staging is METADATA-ONLY and never consumes a rotation variant; duplicate stagings dedupe on (family+slot)', async () => {
    // Codex diff-review r1: text selection moved to the harness DRAIN so a
    // later-suppressed notice can never consume a variant. Staging must
    // therefore carry no text and never touch the rotation cursor.
    const session = makeSession();
    const ptw = createPerTurnWrites();
    for (let i = 0; i < 3; i += 1) {
      await dispatchClearBoardReading(
        call({ field: 'ze', reason: 'user_correction' }, `toolu_dup${i}`),
        ctxFor(session, ptw, { turnId: 'turn-dup' })
      );
    }
    // Three identical stagings in ONE turn → one retained metadata entry…
    expect(ptw.mandatoryNotices).toHaveLength(1);
    expect(ptw.mandatoryNotices[0]).toMatchObject({
      family: 'board_clear_already_empty',
      friendly: 'Ze',
      field: 'ze',
      reason: 'field_not_set',
    });
    expect(ptw.mandatoryNotices[0]).not.toHaveProperty('text');
    // …and ZERO cursor consumption (selection happens only at the drain).
    expect(session._mandatoryNoticeRotation).toBeUndefined();
  });

  test('selectMandatoryNoticeText: strict monotonic cycle — consecutive selections always distinct, even for turn-ids that COLLIDE under the rejected djb2 selector', () => {
    const family = 'board_clear_already_empty';
    const len = BOARD_CLEAR_NOTICE_FAMILIES[family].length;
    const djb2 = (s) => {
      let h = 5381;
      for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      return h % len;
    };
    // Re-derive colliding ids against the REAL modulus (the §3.5 sample
    // arrays are turnId-format-dependent and deliberately not copied):
    // for each of ≥5 prefixes, find two ids with EQUAL djb2 index — the
    // rejected hash selector would repeat the same string on them.
    for (const prefix of ['sess', 'turn', 'F1AC26FB', 'gen', 'live']) {
      let a = null;
      let b = null;
      outer: for (let i = 0; i < 200; i += 1) {
        for (let j = i + 1; j < 200; j += 1) {
          if (djb2(`${prefix}-${i}`) === djb2(`${prefix}-${j}`)) {
            a = `${prefix}-${i}`;
            b = `${prefix}-${j}`;
            break outer;
          }
        }
      }
      expect(a).not.toBeNull();
      const session = makeSession();
      const first = selectMandatoryNoticeText(session, family, a, 'Ze');
      const second = selectMandatoryNoticeText(session, family, b, 'Ze');
      // djb2(a) === djb2(b), so a hash selector returns the SAME string —
      // the real monotonic cycle must not.
      expect(second).not.toBe(first);
    }
    // Three consecutive selections are three distinct strings; every family
    // now carries FIVE variants so five consecutive fires stay distinct
    // (Codex r1 — a fourth retry must not wrap into the 30 s client dedupe).
    const session = makeSession();
    const five = [];
    for (let i = 0; i < 5; i += 1) {
      five.push(selectMandatoryNoticeText(session, family, `t-${i}`, 'Ze'));
    }
    expect(new Set(five).size).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('already-empty clear (dispatcher half of test 7)', () => {
  test('soft-skip noop envelope + already-blank family staged; NO cleared[] push, NO frame', async () => {
    const session = makeSession();
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze', reason: 'user_correction' }),
      ctxFor(session, ptw)
    );
    expect(env.is_error).toBe(false);
    expect(body(env)).toEqual({ ok: true, noop: true, reason: 'field_not_set' });
    expect(ptw.fieldCorrections).toHaveLength(0);
    expect(ptw.cleared).toHaveLength(0);
    expect(ptw.mandatoryNotices).toHaveLength(1);
    // Metadata-only staging (drain-time selection): family + telemetry
    // dimensions, no text.
    expect(ptw.mandatoryNotices[0]).toMatchObject({
      family: 'board_clear_already_empty',
      friendly: 'Ze',
      field: 'ze',
      boardId: 'main',
      reason: 'field_not_set',
    });
    expect(ptw.mandatoryNotices[0]).not.toHaveProperty('text');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('mechanism A raw-fallback + mutator scope contract', () => {
  test('clearBoardReadingFlagAware with unknown scope arg clears via the board-scoped branch only when told so — dispatcher owns the scope', () => {
    // The mutator trusts the passed scope: this pins the dependency
    // inversion (no import, no re-derivation).
    const snapshot = {
      circuits: { 0: { ze: '0.4' } },
      boards: [{ id: 'main', board_type: 'main', ze: '0.4' }],
      currentBoardId: 'main',
    };
    const res = clearBoardReadingFlagAware(snapshot, { field: 'ze', scope: 'global' });
    expect(res.cleared).toBe(true);
    expect(snapshot.circuits[0]).not.toHaveProperty('ze');
    expect(snapshot.boards[0]).not.toHaveProperty('ze');
  });
});
