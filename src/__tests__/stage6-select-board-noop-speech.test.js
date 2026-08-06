/**
 * A no-op `select_board` must not claim it switched (2026-08-06).
 *
 * PROVENANCE — the first live Plan-00 field session, backend log turn-10 of
 * session 10A27714-B5F5-44EA-A75A-35EFAEA1577E:
 *
 *   record_reading  {field: measured_zs_ohm, circuit: 2, board_id: "main"}
 *     -> rejected  wrong_board
 *   select_board    {board_id: "8C436C74-…"}   (the board ALREADY current)
 *     -> ok         iOS logged board_op_select_board_noop
 *
 * The inspector, hands-free in AirPods, heard exactly one thing: a confident
 * "Switched board". A turn that lost a dictated Zs and changed nothing at all
 * SOUNDED like it had recovered. That is the worst possible failure mode for
 * an audio-first tool — worse than silence, because it actively misleads.
 *
 * THIS IS A WORDING FIX, NOT A SUPPRESSION. A fired processing-chime is a
 * promise: the turn always answers, and gating "should we speak?" on content
 * is the F7 invariant breach. The only lever for not-responding is suppressing
 * the chime upstream. So a re-selection still speaks — it just stops lying.
 *
 * The `changed` flag is ADDITIVE. Only an explicit `false` changes the
 * wording, so every producer and fixture that predates it keeps its exact
 * bytes; the `current_board_changed` broadcast is unaffected, and the wire op
 * still carries "the model called the tool" as its documented contract says.
 */

import { jest } from '@jest/globals';
import { dispatchSelectBoard } from '../extraction/stage6-dispatchers-board.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MAIN = '8C436C74-EC77-47C0-8629-2D033C03F31F';
const SUB = 'B1E0A2D9-1111-4444-9999-2D033C03F31F';

function makeSession(currentBoardId = MAIN) {
  return {
    sessionId: 'select-board-noop',
    certType: 'eicr',
    stateSnapshot: {
      circuits: {},
      boards: [
        { id: MAIN, designation: 'DB-1', board_type: 'main' },
        { id: SUB, designation: 'Garage', board_type: 'sub_distribution', parent_board_id: MAIN },
      ],
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
  };
}

async function select(session, boardId, perTurnWrites) {
  return dispatchSelectBoard(
    {
      tool_call_id: 'sb1',
      name: 'select_board',
      input: { board_id: boardId, source_turn_id: 't1' },
    },
    {
      session,
      logger: mockLogger(),
      turnId: 't1',
      perTurnWrites,
      round: 0,
    }
  );
}

/**
 * The spoken board-op lines the bundler synthesises for a turn.
 * `confirmationsEnabled` is the client opt-in that gates the whole read-back
 * channel — without it the bundler returns no confirmations at all.
 */
function boardOpTexts(perTurnWrites, designations) {
  const result = bundleToolCallsIntoResult(
    perTurnWrites,
    {},
    { confirmationsEnabled: true, boardDesignations: designations }
  );
  return (result.confirmations ?? []).filter((c) => c.field === 'board_op').map((c) => c.text);
}

const DESIGNATIONS = new Map([
  [MAIN, 'DB-1'],
  [SUB, 'Garage'],
]);

// ───────────────────────────────────────────────────────────────────────────
describe('dispatchSelectBoard — the `changed` transition flag', () => {
  test('a REAL switch records changed:true', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    const env = await select(session, SUB, p);

    expect(JSON.parse(env.content).ok).toBe(true);
    expect(session.stateSnapshot.currentBoardId).toBe(SUB);
    expect(p.boardOps).toHaveLength(1);
    expect(p.boardOps[0]).toMatchObject({ op: 'select_board', board_id: SUB, changed: true });
  });

  test('re-selecting the CURRENT board records changed:false — the field shape', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    const env = await select(session, MAIN, p);

    // Still ok, still one wire op, still on the same board. The documented
    // idempotency contract ("the wire carries that the model called the tool")
    // is deliberately unchanged — only the new fact is added.
    expect(JSON.parse(env.content).ok).toBe(true);
    expect(session.stateSnapshot.currentBoardId).toBe(MAIN);
    expect(p.boardOps).toHaveLength(1);
    expect(p.boardOps[0]).toMatchObject({ op: 'select_board', board_id: MAIN, changed: false });
  });

  test('the flag is captured BEFORE the mutation, not after it', async () => {
    // Reading it after `setCurrentBoardInSnapshot` would make every call a
    // tautological no-op, silencing genuine switches. This is the ordering pin.
    const session = makeSession(SUB);
    const p = createPerTurnWrites();
    await select(session, MAIN, p);
    expect(p.boardOps[0].changed).toBe(true);
  });

  test('a REJECTED select emits no op at all — nothing to word', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    const env = await select(session, 'no-such-board', p);
    expect(JSON.parse(env.content).ok).toBe(false);
    expect(p.boardOps).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the spoken line — a no-op never claims a switch', () => {
  test('a real switch still speaks the shipped bytes', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    await select(session, SUB, p);
    expect(boardOpTexts(p, DESIGNATIONS)).toEqual(['Switched to the Garage board']);
  });

  test('the field turn now says "Already on the DB-1 board"', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    await select(session, MAIN, p);

    const texts = boardOpTexts(p, DESIGNATIONS);
    expect(texts).toEqual(['Already on the DB-1 board']);
    // The specific lie is gone.
    expect(texts.some((t) => t.includes('Switched'))).toBe(false);
  });

  test('a no-op with NO known designation still speaks, and still truthfully', async () => {
    // Chime-is-a-promise: the absence of a designation is never a reason to
    // fall silent — it only costs us the board's name.
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    await select(session, MAIN, p);
    expect(boardOpTexts(p, null)).toEqual(['Already on that board']);
  });

  test('a real switch with no designation keeps its shipped fallback', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    await select(session, SUB, p);
    expect(boardOpTexts(p, null)).toEqual(['Switched board']);
  });

  test('BACKWARD COMPATIBILITY — an op with no `changed` key words as a switch', () => {
    // Every fixture and producer that predates the flag must be byte-identical.
    // Only an explicit `false` may change the wording.
    const p = createPerTurnWrites();
    p.boardOps.push({ op: 'select_board', board_id: SUB });
    expect(boardOpTexts(p, DESIGNATIONS)).toEqual(['Switched to the Garage board']);

    const q = createPerTurnWrites();
    q.boardOps.push({ op: 'select_board', board_id: SUB, changed: undefined });
    expect(boardOpTexts(q, DESIGNATIONS)).toEqual(['Switched to the Garage board']);
  });

  test('every board-op line is non-empty — a no-op turn is never silent here', async () => {
    const session = makeSession(MAIN);
    const p = createPerTurnWrites();
    await select(session, MAIN, p);
    const texts = boardOpTexts(p, DESIGNATIONS);
    expect(texts).toHaveLength(1);
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(0);
  });
});
