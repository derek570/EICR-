/**
 * §A1a (field-feedback-2026-07-14) — ios_send_attempt telemetry MOVED from
 * the bundler into runShadowHarness, immediately after the token-aware
 * applyConfirmationDebounce. These are END-TO-END live-path regressions
 * (through runShadowHarness, not bundler-only) pinning:
 *
 *   1. telemetry rows cover ALL FIVE allowlisted text-op fields (the old
 *      bundler-internal loop ran before stateChanges/obsAndClears merged, so
 *      circuit_op / observation / field_cleared never got a row — the
 *      forensic contract this wave's F2/F7/F10 diagnosis used was silently
 *      false for exactly those ops);
 *   2. a reading-confirmation row carries non-null confidence; state-change/
 *      obs/clear rows carry null;
 *   3. expected_dedupe_key is token-aware ({field}_{dedupe_token}) for
 *      allowlisted ops;
 *   4. two same-text deletions in ONE turn both reach the wire and carry
 *      DISTINCT tokens (the token-aware debounce lets both through);
 *   5. identical clears in SEPARATE turns both reach the wire (distinct
 *      turnIds → distinct tokens survive the cross-turn debounce window);
 *   6. a debounce-suppressed confirmation produces NO ios_send_attempt row;
 *   7. no `_confidence` sidecar in any emitted confirmation (live path).
 *
 * Mock pattern mirrors stage6-orphan-net.test.js; per-turn writes are
 * populated through the harness's own perTurnWritesRef so everything
 * downstream (bundle → mid-stream filter → debounce → telemetry → strip)
 * runs the REAL code.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-a1a-telemetry';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

// Each test assigns a writer that mutates the harness-owned perTurnWrites.
let populateWrites = null;

const runToolLoopSpy = jest.fn(async (opts) => {
  if (typeof populateWrites === 'function' && typeof opts.perTurnWritesRef === 'function') {
    populateWrites(opts.perTurnWritesRef());
  }
  return {
    stop_reason: 'end_turn',
    rounds: 1,
    // A non-empty tool_calls list keeps the orphan net out of the way.
    tool_calls: [{ name: 'record_reading', input: {}, result: { is_error: false } }],
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  };
});

const validateSpy = jest.fn();
const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: validateSpy,
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

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession() {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    turnCount: 0,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
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

function makePendingAsks(size = 0) {
  return { __tag: 'pending-asks-registry', size, entries: () => [] };
}

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: makePendingAsks(),
    ws: makeWs(),
    confirmationsEnabled: true,
    ...overrides,
  };
}

function attemptsOf(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'ios_send_attempt').map((c) => c[1]);
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  validateSpy.mockClear();
  populateWrites = null;
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: true } },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('§A1a — ios_send_attempt emitted post-debounce in the harness, covering all five text-op fields', () => {
  test('one row per surviving confirmation; token-aware keys; reading row carries confidence; no _confidence on the wire', async () => {
    populateWrites = (writes) => {
      writes.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.92,
        source_turn_id: 't1',
      });
      writes.readings.set('circuit_designation::2', {
        value: 'Sockets',
        confidence: 0.95,
        source_turn_id: 't1',
      });
      writes.circuitOps.push({
        op: 'rename',
        circuit_ref: 4,
        from_ref: 3,
        meta: { designation: 'Lights' },
      });
      writes.observations.push({
        id: 'obs-1',
        code: 'C2',
        text: 'Cracked socket front upstairs bedroom',
        circuit: 3,
      });
      writes.deletedObservations.push({ id: 'obs-old-1', reason: 'user_request' });
      writes.fieldCorrections.push({
        field: 'r1_r2_ohm',
        circuit: 3,
        previous_value: '0.86',
        reason: 'clear_reading',
      });
    };
    const opts = baseOpts();
    const session = makeSession();
    const result = await runShadowHarness(session, 'telemetry coverage turn', [], opts);

    const attempts = attemptsOf(opts.logger);
    // One row per confirmation that reached the wire.
    expect(attempts.length).toBe(result.confirmations.length);

    // ALL FIVE allowlisted text-op fields have telemetry rows now.
    const rowFields = new Set(attempts.map((a) => a.field));
    for (const f of [
      'circuit_op',
      'observation',
      'observation_deletion',
      'field_cleared',
      'circuit_designation',
    ]) {
      expect(rowFields.has(f)).toBe(true);
    }

    // Token-aware expected_dedupe_key: {field}_{dedupe_token}, byte-equal to
    // what a token-aware client computes from the wire entry.
    for (const f of [
      'circuit_op',
      'observation',
      'observation_deletion',
      'field_cleared',
      'circuit_designation',
    ]) {
      const row = attempts.find((a) => a.field === f);
      const wire = result.confirmations.find((c) => c.field === f);
      expect(typeof wire.dedupe_token).toBe('string');
      expect(row.expected_dedupe_key).toBe(`${f}_${wire.dedupe_token}`);
      // Non-reading rows carry null confidence (no _confidence stamping on
      // state-change/obs/clear entries — deliberate, §A1a). circuit_designation
      // is the exception: it IS a record_reading and carries real confidence.
      if (f === 'circuit_designation') {
        expect(row.confidence).toBe(0.95);
      } else {
        expect(row.confidence).toBeNull();
      }
    }

    // Reading row: VALUE-AWARE key {field}_{circuit}_{djb2(text)} (id-84
    // correction-swallow fix) + non-null confidence. The text is
    // bundler-synthesized end-to-end, so assert the shape rather than a
    // brittle hash of the exact synthesized line.
    const zsRow = attempts.find((a) => a.field === 'measured_zs_ohm');
    expect(zsRow.expected_dedupe_key).toMatch(/^measured_zs_ohm_1_\d+$/);
    expect(zsRow.confidence).toBe(0.92);

    // No _confidence leaks onto the wire (strip runs unconditionally after
    // telemetry, on the live harness path).
    for (const c of result.confirmations) {
      expect(c).not.toHaveProperty('_confidence');
    }
  });

  test('two same-text deletions in ONE turn → both reach the wire, distinct tokens, both get telemetry rows', async () => {
    populateWrites = (writes) => {
      writes.deletedObservations.push({ id: 'obs-a', reason: 'user_request' });
      writes.deletedObservations.push({ id: 'obs-b', reason: 'user_request' });
    };
    const opts = baseOpts();
    const session = makeSession();
    const result = await runShadowHarness(session, 'delete both observations', [], opts);

    const dels = result.confirmations.filter((c) => c.field === 'observation_deletion');
    expect(dels).toHaveLength(2);
    expect(dels[0].text).toBe(dels[1].text); // byte-identical spoken text
    expect(dels[0].dedupe_token).not.toBe(dels[1].dedupe_token);

    const delRows = attemptsOf(opts.logger).filter((a) => a.field === 'observation_deletion');
    expect(delRows).toHaveLength(2);
    expect(delRows[0].expected_dedupe_key).not.toBe(delRows[1].expected_dedupe_key);
  });

  test('identical clears in SEPARATE turns → both survive the cross-turn debounce (distinct turn tokens)', async () => {
    const clearWriter = (writes) => {
      writes.fieldCorrections.push({
        field: 'r1_r2_ohm',
        circuit: 3,
        previous_value: '0.86',
        reason: 'clear_reading',
      });
    };
    const session = makeSession();
    const opts = baseOpts();

    populateWrites = clearWriter;
    const r1 = await runShadowHarness(session, 'clear r1 r2 on circuit 3', [], opts);
    expect(r1.confirmations.filter((c) => c.field === 'field_cleared')).toHaveLength(1);

    // Second, byte-identical clear inside the 1.5 s debounce window — the
    // OLD value/text-composite key would have suppressed it server-side.
    populateWrites = clearWriter;
    const r2 = await runShadowHarness(session, 'clear r1 r2 on circuit 3 again', [], opts);
    const clears2 = r2.confirmations.filter((c) => c.field === 'field_cleared');
    expect(clears2).toHaveLength(1);

    const rows = attemptsOf(opts.logger).filter((a) => a.field === 'field_cleared');
    expect(rows).toHaveLength(2);
    expect(rows[0].expected_dedupe_key).not.toBe(rows[1].expected_dedupe_key);
  });

  test('a debounce-suppressed confirmation produces NO ios_send_attempt row', async () => {
    // Same reading (same field+circuit+value → same composite debounce key)
    // in two back-to-back turns within the 1.5 s window: turn 2's
    // confirmation is suppressed server-side and must NOT produce a row.
    const readingWriter = (writes) => {
      writes.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't',
      });
    };
    const session = makeSession();
    const opts = baseOpts();

    populateWrites = readingWriter;
    const r1 = await runShadowHarness(session, 'Zs circuit 1 0.62', [], opts);
    expect((r1.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm')).toHaveLength(1);

    populateWrites = readingWriter;
    const r2 = await runShadowHarness(session, 'Zs circuit 1 0.62 repeat', [], opts);
    expect((r2.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm')).toHaveLength(0);

    const rows = attemptsOf(opts.logger).filter((a) => a.field === 'measured_zs_ohm');
    expect(rows).toHaveLength(1);
  });
});

describe('Codex r8-#2 — safety-net confirmations get telemetry rows (emission runs AFTER all appenders)', () => {
  test('A4 terminal-apology drain: the field-null prompt reaches the wire WITH exactly one ios_send_attempt row', async () => {
    const session = makeSession();
    session.pendingVoicePrompts = [
      {
        text: "Sorry — I couldn't place that reading — could you say the field and value together again?",
      },
    ];
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'okay then', [], opts);
    const apologies = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(apologies).toHaveLength(1);
    const rows = attemptsOf(opts.logger).filter((a) => a.field == null);
    expect(rows).toHaveLength(1);
    for (const c of result.confirmations ?? []) {
      expect('_confidence' in c).toBe(false); // the strip moved with the block
    }
  });

  test('A3 orphan net: the orphan prompt on a digit-bearing zero-output turn gets a row', async () => {
    runToolLoopSpy.mockImplementationOnce(async () => ({
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [], // zero output → orphan net fires
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession();
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], opts);
    const orphan = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(orphan).toHaveLength(1);
    expect(attemptsOf(opts.logger).filter((a) => a.field == null)).toHaveLength(1);
  });
});
