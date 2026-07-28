/**
 * Plan A1a (2026-07-27) — bundler-level tests: §5 rows 6 / 6b / 6c / 6d
 * (both collapse mechanisms + the #31 effective-slot speech gate, with
 * SPEECH-COUNT assertions — frame/state-only assertions were the round-3
 * non-discriminating defect), 11-L1/11-L2 (unclassified legacy byte-identity),
 * and test 17's bundler half (post-canonicalisation wire names + the round-8
 * projected board_id fill).
 *
 * perTurnWrites is built by the REAL dispatchers (never hand-assembled), then
 * projected through the REAL bundleToolCallsIntoResult.
 */

import { jest } from '@jest/globals';

const { dispatchClearBoardReading, dispatchRecordBoardReading, dispatchSelectBoard } =
  await import('../extraction/stage6-dispatchers-board.js');
const { createPerTurnWrites, EFFECTIVE_BOARD_SLOT } =
  await import('../extraction/stage6-per-turn-writes.js');
const { bundleToolCallsIntoResult } = await import('../extraction/stage6-event-bundler.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(boards, currentBoardId = 'main') {
  return {
    sessionId: 'sess-cbr-bundler',
    certType: 'eicr',
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards,
      currentBoardId,
    },
    extractedObservations: [],
  };
}

function ctxFor(session, perTurnWrites) {
  return {
    session,
    logger: makeLogger(),
    turnId: 'turn-b1',
    perTurnWrites,
    round: 1,
    hasBoardClearV1: true,
  };
}

async function write(session, ptw, field, value, id = 'toolu_w') {
  const env = await dispatchRecordBoardReading(
    {
      tool_call_id: id,
      name: 'record_board_reading',
      input: { field, value, confidence: 0.9, source_turn_id: 't1' },
    },
    ctxFor(session, ptw)
  );
  expect(JSON.parse(env.content).ok).toBe(true);
  return env;
}

async function clear(session, ptw, field, id = 'toolu_c') {
  return dispatchClearBoardReading(
    { tool_call_id: id, name: 'clear_board_reading', input: { field, reason: 'user_correction' } },
    ctxFor(session, ptw)
  );
}

async function selectBoard(session, ptw, boardId, id = 'toolu_sel') {
  const env = await dispatchSelectBoard(
    { tool_call_id: id, name: 'select_board', input: { board_id: boardId } },
    ctxFor(session, ptw)
  );
  expect(JSON.parse(env.content).ok).toBe(true);
}

function bundle(ptw, opts = {}) {
  return bundleToolCallsIntoResult(ptw, null, {
    confirmationsEnabled: true,
    turnId: 'turn-b1',
    hasBoardClearV1: true,
    ...opts,
  });
}

function audible(result) {
  return (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
}

const twoBoards = () => [
  { id: 'main', designation: 'Main DB', board_type: 'main' },
  { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution' },
];

// ───────────────────────────────────────────────────────────────────────────
describe('test 6 — cross-board write→clear must NOT collapse AND both must SPEAK (manufacturer)', () => {
  test('write on A, select B, clear on B: A survives+speaks, switch speaks, B clear speaks — exactly three', async () => {
    const session = makeSession(twoBoards());
    const ptw = createPerTurnWrites();
    await write(session, ptw, 'manufacturer', 'Hager', 'toolu_wA');
    await selectBoard(session, ptw, 'garage');
    // Seed board B's manufacturer IMMEDIATELY before the clear (round-8: an
    // unseeded B is the already-empty case — a different contract).
    session.stateSnapshot.boards.find((b) => b.id === 'garage').manufacturer = 'Wylex';
    const env = await clear(session, ptw, 'manufacturer', 'toolu_cB');
    expect(JSON.parse(env.content)).toEqual({ ok: true });

    // Board A's write SURVIVES in perTurnWrites (the boardless raw key would
    // have collided and deleted it — the round-2 reversed defect).
    expect(ptw.boardReadings.size).toBe(1);
    // Board B's manufacturer was populated before and is absent after.
    expect(session.stateSnapshot.boards.find((b) => b.id === 'garage')).not.toHaveProperty(
      'manufacturer'
    );
    // Board A's value is still in the post-state (main-target write landed
    // in circuits[0] per the dual-shape write path).
    expect(session.stateSnapshot.circuits[0].manufacturer).toBe('Hager');

    const result = bundle(ptw, {
      boardDesignations: { main: 'Main DB', garage: 'Garage CU' },
    });
    // The clear frame survives the collapse (different slots).
    const clearFrames = (result.field_corrections ?? []).filter(
      (c) => c.reason === 'clear_reading'
    );
    expect(clearFrames).toHaveLength(1);
    expect(clearFrames[0].board_id).toBe('garage');

    // SPEECH: exactly THREE audible confirmations — the write read-back, the
    // select_board switch confirmation, and board B's clear. The clear leg is
    // the one the bare-field #31 gate silently swallowed.
    const speakers = audible(result);
    expect(speakers).toHaveLength(3);
    expect(speakers.some((c) => c.field === 'manufacturer')).toBe(true); // write read-back
    expect(speakers.filter((c) => c.field === 'board_op')).toHaveLength(1); // exactly one switch
    const clearSpeech = speakers.filter((c) => c.field === 'field_cleared');
    expect(clearSpeech).toHaveLength(1);
    expect(clearSpeech[0].text.toLowerCase()).toContain('cleared');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 6b — same-board clear→write collapse (mechanism B, the P5 mirror at board scope)', () => {
  test('clear ze then write ze in one turn: clear existed pre-projection, absent post-projection, write speaks once, the sweep really ran', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    // Leg (iv): seed a distinct OLD ze in circuits[0] AND the board record
    // under BOTH alias spellings so a no-op "clear" is detectable in the
    // window between the clear and the write.
    session.stateSnapshot.circuits[0] = { ze: '9.9', earth_loop_impedance_ze: '9.9' };
    session.stateSnapshot.boards[0].ze = '9.9';
    session.stateSnapshot.boards[0].earth_loop_impedance_ze = '9.9';
    const ptw = createPerTurnWrites();

    const cEnv = await clear(session, ptw, 'ze', 'toolu_c1');
    expect(JSON.parse(cEnv.content)).toEqual({ ok: true });
    // Leg (iv) — observable ONLY here: every bucket and alias is empty
    // between the clear and the write.
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('earth_loop_impedance_ze');
    expect(session.stateSnapshot.boards[0]).not.toHaveProperty('ze');
    expect(session.stateSnapshot.boards[0]).not.toHaveProperty('earth_loop_impedance_ze');
    // Leg (i) — the clear correction really exists pre-projection.
    expect(ptw.fieldCorrections.filter((c) => c.reason === 'clear_reading')).toHaveLength(1);

    await write(session, ptw, 'ze', '0.35', 'toolu_w1');

    const result = bundle(ptw);
    // Leg (ii) — the stale clear is collapsed off the wire.
    expect(
      (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading')
    ).toHaveLength(0);
    // Leg (iii) — the write survives and is spoken exactly once; no
    // "cleared" line accompanies it.
    const speakers = audible(result);
    const zeSpeech = speakers.filter((c) => c.field === 'ze');
    expect(zeSpeech).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'field_cleared')).toHaveLength(0);
    expect(result.extracted_board_readings).toHaveLength(1);
    expect(result.extracted_board_readings[0].value).toBe('0.35');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 6c — cross-board clear→write must NOT collapse; the CLEAR must speak (manufacturer)', () => {
  test('clear on A, select B, write on B: clear frame survives, both speak (+switch = three), A stays cleared, B holds only the new value', async () => {
    const session = makeSession(twoBoards());
    // Mutation-reality: A's manufacturer populated before the clear.
    session.stateSnapshot.circuits[0] = { manufacturer: 'Hager' };
    session.stateSnapshot.boards.find((b) => b.id === 'main').manufacturer = 'Hager';
    const ptw = createPerTurnWrites();

    const cEnv = await clear(session, ptw, 'manufacturer', 'toolu_cA');
    expect(JSON.parse(cEnv.content)).toEqual({ ok: true });
    // Round-8: A is ABSENT immediately after the clear…
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('manufacturer');
    expect(session.stateSnapshot.boards.find((b) => b.id === 'main')).not.toHaveProperty(
      'manufacturer'
    );

    await selectBoard(session, ptw, 'garage');
    await write(session, ptw, 'manufacturer', 'Wylex', 'toolu_wB');

    // …and still absent at turn end; B holds ONLY the new write.
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('manufacturer');
    expect(session.stateSnapshot.boards.find((b) => b.id === 'garage').manufacturer).toBe('Wylex');

    const result = bundle(ptw, { boardDesignations: { main: 'Main DB', garage: 'Garage CU' } });
    // The clear frame SURVIVES (different board-scoped slots — an over-eager
    // field-keyed collapse would swallow it).
    const clearFrames = (result.field_corrections ?? []).filter(
      (c) => c.reason === 'clear_reading'
    );
    expect(clearFrames).toHaveLength(1);
    expect(clearFrames[0].board_id).toBe('main');
    // The write survives too.
    expect(result.extracted_board_readings).toHaveLength(1);

    // SPEECH: exactly three — the clear, the switch, the write. A field-only
    // #31 gate keeps the frame but swallows the SPEECH (invisible to a
    // frame-only assertion — the round-4 finding).
    const speakers = audible(result);
    expect(speakers).toHaveLength(3);
    expect(speakers.filter((c) => c.field === 'field_cleared')).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'board_op')).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'manufacturer')).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 6d — GLOBAL field cross-board clear→write MUST collapse (ze)', () => {
  test('clear ze on main, select sub, write ze on sub: the clear is dropped, the write wins and speaks; buckets end correct', async () => {
    const session = makeSession(twoBoards());
    // Seed distinct OLD values everywhere under both aliases (leg 1).
    session.stateSnapshot.circuits[0] = { ze: '9.9', earth_loop_impedance_ze: '9.9' };
    for (const b of session.stateSnapshot.boards) {
      b.ze = '9.9';
      b.earth_loop_impedance_ze = '9.9';
    }
    const ptw = createPerTurnWrites();

    const cEnv = await clear(session, ptw, 'ze', 'toolu_cg');
    expect(JSON.parse(cEnv.content)).toEqual({ ok: true });
    // Prerequisite leg — the clear correction exists pre-projection (without
    // it every downstream assertion is exactly what unfixed main produces).
    expect(ptw.fieldCorrections.filter((c) => c.reason === 'clear_reading')).toHaveLength(1);
    // Leg 2 — after the clear and BEFORE the write, every location is empty.
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('earth_loop_impedance_ze');
    for (const b of session.stateSnapshot.boards) {
      expect(b).not.toHaveProperty('ze');
      expect(b).not.toHaveProperty('earth_loop_impedance_ze');
    }

    await selectBoard(session, ptw, 'garage');
    await write(session, ptw, 'ze', '0.42', 'toolu_wg');

    // Leg 3 — only the resolved (non-main) board record holds NEW, under
    // ONLY the raw spelling dictated; circuits[0] and the other board stay
    // absent under both spellings (asserting a broadcast post-state would
    // force the write-path normalisation §3.3a forbids).
    expect(session.stateSnapshot.circuits[0] ?? {}).not.toHaveProperty('ze');
    expect(session.stateSnapshot.boards.find((b) => b.id === 'garage').ze).toBe('0.42');
    expect(session.stateSnapshot.boards.find((b) => b.id === 'main')).not.toHaveProperty('ze');

    const result = bundle(ptw, { boardDesignations: { main: 'Main DB', garage: 'Garage CU' } });
    // Mechanism B: the stale global clear is DROPPED (same board-insensitive
    // slot as the surviving write). An over-precise (field, board) key would
    // keep it and blank the client's single Ze cell after the write — P5's
    // ordering wipe.
    expect(
      (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading')
    ).toHaveLength(0);
    // Leg 4 — the client-facing projection carries NEW.
    expect(result.extracted_board_readings).toHaveLength(1);
    expect(result.extracted_board_readings[0].value).toBe('0.42');

    // SPEECH: exactly TWO — the switch confirmation and the write. The clear
    // never speaks (it was collapsed).
    const speakers = audible(result);
    expect(speakers).toHaveLength(2);
    expect(speakers.filter((c) => c.field === 'board_op')).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'ze')).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'field_cleared')).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 11 sublegs — unclassified legacy writes flow byte-identically (stamp fallback)', () => {
  test('(11-L1) an UNCLASSIFIED ordinary board write: no stamp, unchanged enumerable shape, no board_id fill even when capability is on', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    const ptw = createPerTurnWrites();
    await write(session, ptw, 'nominal_voltage_u', '230', 'toolu_u1');
    const entry = [...ptw.boardReadings.values()][0];
    expect(entry[EFFECTIVE_BOARD_SLOT]).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual(
      ['value', 'confidence', 'source_turn_id', 'auto_resolved', 'boardId'].sort()
    );
    const result = bundle(ptw); // hasBoardClearV1: true
    expect(result.extracted_board_readings[0]).not.toHaveProperty('board_id');
    expect(result.extracted_board_readings[0]).toEqual({
      field: 'nominal_voltage_u',
      value: '230',
      confidence: 0.9,
      source: 'tool_call',
    });
  });

  test('(11-L2) the derived bonding-continuity producer stays symbol-less and byte-identical', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    const ptw = createPerTurnWrites();
    await write(session, ptw, 'bonding_water', 'PASS', 'toolu_bw');
    // The derived write landed…
    const derivedKey = [...ptw.boardReadings.keys()].find((k) =>
      k.startsWith('bonding_conductor_continuity')
    );
    expect(derivedKey).toBeDefined();
    const derived = ptw.boardReadings.get(derivedKey);
    // …with NO effective-slot stamp and the auto_resolved tag intact.
    expect(derived[EFFECTIVE_BOARD_SLOT]).toBeUndefined();
    expect(derived.auto_resolved).toBe(true);
    const result = bundle(ptw);
    const projected = result.extracted_board_readings.find(
      (r) => r.field === 'bonding_conductor_continuity'
    );
    expect(projected).toMatchObject({ auto_resolved: true });
    expect(projected).not.toHaveProperty('board_id');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('test 17 (bundler half) — post-canonicalisation wire names + projected board identity', () => {
  test('(a) model names prospective_fault_current → wire field is EXACTLY pfc (not the enum member)', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    session.stateSnapshot.circuits[0] = { prospective_fault_current: '2.3' };
    const ptw = createPerTurnWrites();
    const env = await clear(session, ptw, 'prospective_fault_current', 'toolu_pfc');
    expect(JSON.parse(env.content)).toEqual({ ok: true });
    // Mutation legs (c)+(d): populated before (seeded above), absent after.
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('prospective_fault_current');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('pfc');
    const result = bundle(ptw);
    const frames = (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading');
    expect(frames).toHaveLength(1);
    expect(frames[0].field).toBe('pfc');
    expect(frames[0].field).not.toBe('prospective_fault_current');
    expect(frames[0].circuit).toBeNull();
    expect(frames[0].board_id).toBe('main');
  });

  test('(b) model names ze → wire field is ze; frame matches the §3.4b contract byte for byte', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    session.stateSnapshot.circuits[0] = { ze: '0.35' };
    const ptw = createPerTurnWrites();
    await clear(session, ptw, 'ze', 'toolu_ze');
    expect(session.stateSnapshot.circuits[0]).not.toHaveProperty('ze');
    const result = bundle(ptw);
    const frames = (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: 'field_corrected',
      circuit: null,
      field: 'ze',
      previous_value: '0.35',
      reason: 'clear_reading',
      board_id: 'main',
    });
  });

  test('round-8 projected board identity: a CLASSIFIED board-scoped write after select_board carries the resolved board_id — capability-gated', async () => {
    const session = makeSession(twoBoards());
    const ptw = createPerTurnWrites();
    await selectBoard(session, ptw, 'garage');
    await write(session, ptw, 'manufacturer', 'Wylex', 'toolu_mfg');
    // Capability ON → the projected reading carries B even though the model
    // omitted board_id (extraction precedes current_board_changed on egress).
    const on = bundle(ptw);
    expect(on.extracted_board_readings[0].board_id).toBe('garage');
    // Capability OFF → byte-identical legacy projection (no board_id).
    const off = bundleToolCallsIntoResult(ptw, null, {
      confirmationsEnabled: true,
      turnId: 'turn-b1',
      hasBoardClearV1: false,
    });
    expect(off.extracted_board_readings[0]).not.toHaveProperty('board_id');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A2-multiboard item 7 (2026-07-28) — the BOARD `replaces_cleared` twin.
//
// Mechanism B (test 6b/6d above) already drops the stale board clear from the
// wire. Without a stamp on the SURVIVING board write, web receives a bare write
// against a still-populated cell and its fill-only apply gate silently skips
// it — P5's ordering wipe, at board scope: spoken but never written.
describe('item 7 — collapsed board clear→write stamps replaces_cleared on the survivor', () => {
  test('scoped field (manufacturer) on a sub-board: flag stamped AND board_id enriched, clear dropped, write speaks once', async () => {
    const session = makeSession(twoBoards());
    session.stateSnapshot.boards.find((b) => b.id === 'garage').manufacturer = 'Hager';
    const ptw = createPerTurnWrites();

    await selectBoard(session, ptw, 'garage');
    const cEnv = await clear(session, ptw, 'manufacturer', 'toolu_c7');
    expect(JSON.parse(cEnv.content)).toEqual({ ok: true });
    expect(ptw.fieldCorrections.filter((c) => c.reason === 'clear_reading')).toHaveLength(1);

    await write(session, ptw, 'manufacturer', 'Wylex', 'toolu_w7');

    const result = bundle(ptw, { boardDesignations: { main: 'Main DB', garage: 'Garage CU' } });
    // The stale clear collapsed (same effective board slot).
    expect(
      (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading')
    ).toHaveLength(0);
    // The survivor carries the flag AND the effective board it replaced on.
    expect(result.extracted_board_readings).toHaveLength(1);
    expect(result.extracted_board_readings[0].replaces_cleared).toBe(true);
    expect(result.extracted_board_readings[0].board_id).toBe('garage');
    // SPEECH unchanged by the flag: the switch + the write, no "cleared" line.
    const speakers = audible(result);
    expect(speakers.filter((c) => c.field === 'manufacturer')).toHaveLength(1);
    expect(speakers.filter((c) => c.field === 'field_cleared')).toHaveLength(0);
  });

  test('a FLAGGED board write is enriched with board_id even when hasBoardClearV1 is OFF (deliberate bypass of the ordinary capability gate)', async () => {
    const session = makeSession(twoBoards());
    session.stateSnapshot.boards.find((b) => b.id === 'garage').manufacturer = 'Hager';
    const ptw = createPerTurnWrites();
    await selectBoard(session, ptw, 'garage');
    await clear(session, ptw, 'manufacturer', 'toolu_c7b');
    await write(session, ptw, 'manufacturer', 'Wylex', 'toolu_w7b');

    const off = bundleToolCallsIntoResult(ptw, null, {
      confirmationsEnabled: true,
      turnId: 'turn-b1',
      hasBoardClearV1: false,
    });
    // The collapse manifest keys on the EFFECTIVE board, so a flag with no
    // board_id would tell the client "this replaces a cleared value" while
    // leaving it no way to decide WHICH board's — and a board-aware client that
    // fails closed on an unresolvable target would drop a SPOKEN replacement.
    // `board_id` on a board reading has been decoded since slice 1.1a, so the
    // extra key can only route the value to the right board.
    expect(off.extracted_board_readings[0].replaces_cleared).toBe(true);
    expect(off.extracted_board_readings[0].board_id).toBe('garage');
  });

  test('NEGATIVE — two ze writes in one turn (global scope, no clear) LWW under ONE null-board slot and carry NO flag', async () => {
    const session = makeSession(twoBoards());
    const ptw = createPerTurnWrites();
    // `ze` is scope:'global' in BOARD_CLEAR_SCOPE_MAP, so BOTH writes land on
    // the SAME (field, null-board) effective slot regardless of the board
    // selected between them. Last-write-wins is correct; a spurious
    // `replaces_cleared` here would tell the client to overwrite on a turn that
    // cleared nothing.
    await write(session, ptw, 'ze', '0.30', 'toolu_z1');
    await selectBoard(session, ptw, 'garage');
    await write(session, ptw, 'ze', '0.42', 'toolu_z2');

    const result = bundle(ptw, { boardDesignations: { main: 'Main DB', garage: 'Garage CU' } });
    expect(result.extracted_board_readings).toHaveLength(1);
    expect(result.extracted_board_readings[0].value).toBe('0.42');
    expect(result.extracted_board_readings[0]).not.toHaveProperty('replaces_cleared');
  });

  test('NEGATIVE — board write→CLEAR (mechanism A) leaves neither a stale write nor a flag', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    const ptw = createPerTurnWrites();
    await write(session, ptw, 'manufacturer', 'Wylex', 'toolu_wA7');
    const cEnv = await clear(session, ptw, 'manufacturer', 'toolu_cA7');
    expect(JSON.parse(cEnv.content)).toEqual({ ok: true });

    const result = bundle(ptw);
    // Item 9's `removeBoardReadingWrites` deleted the write from BOTH the
    // journal and the Map, so nothing survives to be stamped and the clear is
    // the turn's real outcome.
    expect(result.extracted_board_readings ?? []).toHaveLength(0);
    expect(
      (result.field_corrections ?? []).filter((c) => c.reason === 'clear_reading')
    ).toHaveLength(1);
    for (const r of result.extracted_board_readings ?? []) {
      expect(r).not.toHaveProperty('replaces_cleared');
    }
  });

  test('a DERIVED/mirror survivor is not a stamp candidate — nothing audible replaced the clear', async () => {
    const session = makeSession([{ id: 'main', board_type: 'main' }]);
    session.stateSnapshot.boards[0].manufacturer = 'Hager';
    const ptw = createPerTurnWrites();
    await clear(session, ptw, 'manufacturer', 'toolu_cd7');
    await write(session, ptw, 'manufacturer', 'Wylex', 'toolu_wd7');
    // Mark the survivor derived AFTER dispatch (the real derived producers are
    // the continuity mirror; this exercises the candidacy filter itself).
    for (const v of ptw.boardReadings.values()) v.derived = true;

    const result = bundle(ptw);
    expect(result.extracted_board_readings).toHaveLength(1);
    expect(result.extracted_board_readings[0]).not.toHaveProperty('replaces_cleared');
  });
});
