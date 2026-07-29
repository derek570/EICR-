/**
 * Plan A1b (2026-07-29) — board-clear client contract + the live-capability
 * fence.
 *
 * Three surfaces:
 *
 *  1. §2 contract gate, backend leg — the committed scope-keys fixture
 *     (`tests/fixtures/test-contracts/board-clear-scope-keys.json`) DEEP-
 *     EQUALS the live `BOARD_CLEAR_SCOPE_MAP` (keys AND values). The same
 *     fixture is committed byte-identical in CertMateUnified and mirrored by
 *     the web route map; each surface drift-tests LOCALLY and the cross-repo
 *     halves are reconciled by the delivery-time digest comparison recorded
 *     in the execution log. A scope-VALUE change alone must fail (not just a
 *     key add/remove).
 *
 *  2. §1 fence — `classifyBoardClear` reads `board_clear_v1` LIVE from the
 *     active-sessions registry at DISPATCH time (never the turn-start ctx
 *     snapshot). These tests register a REAL `activeSessions` entry and
 *     toggle the live value post-construction: a stubbed ctx capability
 *     would go green while production denies-all (round-8 IMPORTANT).
 *
 *  3. The `diffVoiceLatencyCapabilities` tripwire helper — pure diff used by
 *     the `stage6.capability_changed_on_reparse` telemetry (zero expected
 *     occurrences; see stage6-a1b-capability-reparse.test.js for the wire
 *     half).
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const { dispatchClearBoardReading, dispatchRecordBoardReading, BOARD_CLEAR_SCOPE_MAP } =
  await import('../extraction/stage6-dispatchers-board.js');
const { createPerTurnWrites } = await import('../extraction/stage6-per-turn-writes.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities, diffVoiceLatencyCapabilities } =
  await import('../extraction/voice-latency-config.js');

const FIXTURE_PATH = new URL(
  '../../tests/fixtures/test-contracts/board-clear-scope-keys.json',
  import.meta.url
);

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const SESSION_ID = 'sess-a1b-fence';

function makeSession(stateOverrides = {}) {
  return {
    sessionId: SESSION_ID,
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
  };
}

function ctxFor(session, perTurnWrites, extra = {}) {
  return {
    session,
    logger: makeLogger(),
    turnId: 'turn-1',
    perTurnWrites,
    round: 1,
    ...extra,
  };
}

/** Register a REAL registry entry advertising (or not) board_clear_v1. */
function registerEntry(sessionId, { boardClear }) {
  const supports = boardClear ? ['board_clear_v1'] : [];
  activeSessions.set(sessionId, {
    voiceLatency: {
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports },
      }),
    },
  });
  return activeSessions.get(sessionId);
}

function call(input, id = 'toolu_a1b') {
  return { tool_call_id: id, name: 'clear_board_reading', input };
}

function body(env) {
  return JSON.parse(env.content);
}

afterEach(() => {
  activeSessions.clear();
  delete process.env.BOARD_CLEAR_DISABLED;
});

// ───────────────────────────────────────────────────────────────────────────
describe('§2 contract gate — committed fixture deep-equals the live scope map', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  test('fixture deep-equals BOARD_CLEAR_SCOPE_MAP (keys AND scope values, both directions)', () => {
    // toEqual is a deep, both-direction comparison: a missing key, an extra
    // key, OR a changed scope value all fail.
    expect(fixture).toEqual({ ...BOARD_CLEAR_SCOPE_MAP });
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(BOARD_CLEAR_SCOPE_MAP).sort());
  });

  test('a scope-VALUE change alone fails the gate (round-2 — keys-only equality is insufficient)', () => {
    const valueDrift = { ...BOARD_CLEAR_SCOPE_MAP, manufacturer: 'global' };
    expect(valueDrift).not.toEqual(fixture);
    // Same keys — proving the failure above is value-driven, not key-driven.
    expect(Object.keys(valueDrift).sort()).toEqual(Object.keys(fixture).sort());
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('§1 fence — capability read LIVE from the active-sessions registry at dispatch', () => {
  test('capable happy path: registered board_clear_v1 entry → clear commits, ONE board frame with circuit:null + non-null board_id', async () => {
    registerEntry(SESSION_ID, { boardClear: true });
    const session = makeSession({
      circuits: { 0: { ze: '0.35', earth_loop_impedance_ze: '0.35' } },
    });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(call({ field: 'ze' }), ctxFor(session, ptw));
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[0].ze).toBeUndefined();
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBeUndefined();
    expect(ptw.fieldCorrections).toHaveLength(1);
    expect(ptw.fieldCorrections[0]).toMatchObject({
      type: 'field_corrected',
      circuit: null,
      field: 'ze',
      reason: 'clear_reading',
    });
    expect(ptw.fieldCorrections[0].board_id).toEqual(expect.any(String));
    expect(ptw.fieldCorrections[0].board_id.length).toBeGreaterThan(0);
  });

  test('live read WINS over a stale ctx snapshot: ctx.hasBoardClearV1=false is IGNORED when the registry says capable', async () => {
    registerEntry(SESSION_ID, { boardClear: true });
    const session = makeSession({ circuits: { 0: { ze: '0.35' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze' }),
      // The stale snapshot a turn-start harness construction would carry.
      ctxFor(session, ptw, { hasBoardClearV1: false })
    );
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[0].ze).toBeUndefined();
  });

  test('downgrade-before-dispatch: entry capable at construction, flipped OFF before dispatch → deny-first soft-skip, NO mutation', async () => {
    const entry = registerEntry(SESSION_ID, { boardClear: true });
    const session = makeSession({ circuits: { 0: { ze: '0.35' } } });
    const ptw = createPerTurnWrites();
    const ctx = ctxFor(session, ptw, { hasBoardClearV1: true }); // stale capable snapshot
    // The mid-turn mutation the reconnect re-parse would perform.
    entry.voiceLatency.capabilities = parseVoiceLatencyCapabilities({
      voice_latency: { version: 1, supports: [] },
    });
    const env = await dispatchClearBoardReading(call({ field: 'ze' }), ctx);
    expect(body(env)).toEqual({
      ok: true,
      skipped: true,
      reason: 'board_clear_capability_missing',
    });
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.35');
    expect(ptw.fieldCorrections).toHaveLength(0);
    expect(ptw.mandatoryNotices.length).toBeGreaterThan(0);
  });

  test('UNREGISTERED session (no activeSessions entry) → deny-first soft-skip', async () => {
    const session = makeSession({ circuits: { 0: { ze: '0.35' } } });
    const ptw = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      call({ field: 'ze' }),
      ctxFor(session, ptw, { hasBoardClearV1: true })
    );
    expect(body(env)).toEqual({
      ok: true,
      skipped: true,
      reason: 'board_clear_capability_missing',
    });
    expect(session.stateSnapshot.circuits[0].ze).toBe('0.35');
  });

  test('UPGRADE mid-turn is honoured live too: entry flipped ON post-construction → clear commits', async () => {
    const entry = registerEntry(SESSION_ID, { boardClear: false });
    const session = makeSession({ circuits: { 0: { ze: '0.35' } } });
    const ptw = createPerTurnWrites();
    const ctx = ctxFor(session, ptw, { hasBoardClearV1: false });
    entry.voiceLatency.capabilities = parseVoiceLatencyCapabilities({
      voice_latency: { version: 1, supports: ['board_clear_v1'] },
    });
    const env = await dispatchClearBoardReading(call({ field: 'ze' }), ctx);
    expect(body(env)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[0].ze).toBeUndefined();
  });

  test('same-turn write→clear still collapses under the live-read fence (eager-mutation semantics unchanged)', async () => {
    registerEntry(SESSION_ID, { boardClear: true });
    const session = makeSession();
    const ptw = createPerTurnWrites();
    const wEnv = await dispatchRecordBoardReading(
      {
        tool_call_id: 'toolu_w',
        name: 'record_board_reading',
        input: { field: 'ze', value: '0.42', confidence: 0.9 },
      },
      ctxFor(session, ptw)
    );
    expect(JSON.parse(wEnv.content).ok).toBe(true);
    const cEnv = await dispatchClearBoardReading(call({ field: 'ze' }), ctxFor(session, ptw));
    expect(body(cEnv)).toEqual({ ok: true });
    // Mechanism A: the parked same-slot write is gone from the journal/Map.
    expect(ptw.boardReadings.size).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('diffVoiceLatencyCapabilities — the tripwire diff', () => {
  const caps = (supports) =>
    parseVoiceLatencyCapabilities({ voice_latency: { version: 1, supports } });

  test('identical re-parse → empty diff (the expected-always case)', () => {
    expect(
      diffVoiceLatencyCapabilities(caps(['board_clear_v1']), caps(['board_clear_v1']))
    ).toEqual([]);
    expect(diffVoiceLatencyCapabilities(caps([]), caps([]))).toEqual([]);
  });

  test('a capability change diffs by flag name with from/to booleans', () => {
    const diff = diffVoiceLatencyCapabilities(caps(['board_clear_v1']), caps([]));
    expect(diff).toEqual([{ flag: 'hasBoardClearV1', from: true, to: false }]);
  });

  test('version change diffs; absent shapes are treated as the empty/deny shape', () => {
    const v0 = parseVoiceLatencyCapabilities(null);
    const diff = diffVoiceLatencyCapabilities(v0, caps(['board_clear_v1']));
    expect(diff).toEqual(
      expect.arrayContaining([
        { flag: 'version', from: 0, to: 1 },
        { flag: 'hasBoardClearV1', from: false, to: true },
      ])
    );
    expect(diffVoiceLatencyCapabilities(null, null)).toEqual([]);
  });

  test('never leaks raw supports strings — entries carry has* flag names only', () => {
    const diff = diffVoiceLatencyCapabilities(caps([]), caps(['board_clear_v1', 'regex_fast_v2']));
    for (const row of diff) {
      expect(row.flag === 'version' || row.flag.startsWith('has')).toBe(true);
    }
  });
});
