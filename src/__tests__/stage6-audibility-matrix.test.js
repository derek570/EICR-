/**
 * stage6-audibility-matrix.test.js — F7 audibility-invariant sweep, FAST
 * MATRIX LANE (PLAN f7-hardening-2026-07 Item 1, task #17).
 *
 * Fabricated tool-loop sequences through the REAL `runShadowHarness` with a
 * MOCKED tool loop + mocked ask dispatcher (the existing fixture pattern from
 * stage6-shadow-harness-telemetry.test.js). This lane covers the scenario
 * FAMILIES, the read-back-exactly-once oracle (invariant c), the
 * one-telemetry-row-per-wire-confirmation invariant (b), and the wire-hygiene
 * invariants (d) no `_confidence` on the wire + (e) no `__`-sentinel in spoken
 * text — cheaply, because it drives the REAL post-loop bundler / nets / drain
 * without a real Anthropic stream. The pre-emission audibility RED→GREEN proof
 * lives in the integration lane (stage6-audibility-invariants.test.js) where a
 * REAL dispatcher provides the emission signal a mock cannot.
 *
 * ZERO production edits — mock modules only.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-f7-matrix';

// The mocked ask dispatcher — the fast lane never exercises the real one.
const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  {
    __tag: 'asks',
  }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

// Per-test: populate the harness-owned perTurnWrites + control tool_calls.
let populateWrites = null;
let toolCallsForTurn = [{ name: 'record_reading', input: {}, result: { is_error: false } }];

const runToolLoopSpy = jest.fn(async (opts) => {
  if (typeof populateWrites === 'function' && typeof opts.perTurnWritesRef === 'function') {
    populateWrites(opts.perTurnWritesRef());
  }
  return {
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: toolCallsForTurn,
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  };
});

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 45000,
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: jest.fn(() => ({
    onSnapshotPatch: jest.fn(),
    onLoopComplete: jest.fn(),
    onToolUseStreamed: jest.fn(),
    validateAgainstConfirmations: jest.fn(),
    abortBySlot: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const {
  makeLogger,
  makeOpenWs,
  iosSendAttempts,
  audibleConfirmations,
  anyConfidenceKeyOnWire,
  anySentinelInSpokenText,
} = await import('./helpers/f7-audibility-matrix.js');

function makeSession(overrides = {}) {
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
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    ...overrides,
  };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: makeOpenWs(),
    confirmationsEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  populateWrites = null;
  toolCallsForTurn = [{ name: 'record_reading', input: {}, result: { is_error: false } }];
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: false } },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

// ───────────────────────────────────────────────────────────────────────────
// Invariant (c) — read-back exactly once, respecting production grouping and
// the per-operation exceptions.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 matrix — invariant (c): read-back exactly once per applied reading', () => {
  test('grouped multi-circuit read-back — same field+value on 3 circuits → ONE grouped confirmation covering all 3', async () => {
    populateWrites = (w) => {
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
      w.readings.set('measured_zs_ohm::2', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
      w.readings.set('measured_zs_ohm::3', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
    };
    const result = await runShadowHarness(
      makeSession(),
      'zs for one two three is 0.62',
      [],
      baseOpts()
    );
    const zsConfs = (result.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm');
    expect(zsConfs).toHaveLength(1); // grouped, not three
    expect(Array.isArray(zsConfs[0].circuits)).toBe(true);
    expect(zsConfs[0].circuits.sort()).toEqual([1, 2, 3]);
    // No confirmation covers an absent slot.
    expect(
      (result.extracted_readings ?? []).filter((r) => r.field === 'measured_zs_ohm')
    ).toHaveLength(3);
  });

  test('same-slot overwrite on a NON-designation field collapses to ONE confirmation', async () => {
    populateWrites = (w) => {
      // Map is last-write-wins for (field, circuit) — a same-turn overwrite.
      w.readings.set('measured_zs_ohm::1', {
        value: '0.99',
        confidence: 0.9,
        source_turn_id: 't1',
      });
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
    };
    const result = await runShadowHarness(makeSession(), 'zs circuit 1 is 0.62', [], baseOpts());
    const zsConfs = (result.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm');
    expect(zsConfs).toHaveLength(1);
    expect(zsConfs[0].value ?? zsConfs[0].text).toBeDefined();
  });

  test('two designations on one circuit → one confirmation PER dictated operation (append-only designationOps)', async () => {
    populateWrites = (w) => {
      // The Map holds only the FINAL value; designationOps carries both ops.
      w.readings.set('circuit_designation::2', {
        value: 'Sockets',
        confidence: 1.0,
        source_turn_id: 't1',
      });
      w.designationOps.push({ circuit: 2, boardId: null, value: 'Cooker', confidence: 1.0 });
      w.designationOps.push({ circuit: 2, boardId: null, value: 'Sockets', confidence: 1.0 });
    };
    const result = await runShadowHarness(
      makeSession(),
      'circuit 2 is the cooker no the sockets',
      [],
      baseOpts()
    );
    const desigConfs = (result.confirmations ?? []).filter(
      (c) => c.field === 'circuit_designation'
    );
    expect(desigConfs).toHaveLength(2); // both dictated operations speak
  });

  test('derived write is EXEMPT — no confirmation for a derived reading', async () => {
    populateWrites = (w) => {
      w.readings.set('polarity::1', {
        value: 'Pass',
        confidence: 1.0,
        source_turn_id: 't1',
        derived: true,
      });
    };
    const result = await runShadowHarness(makeSession(), 'zs circuit 1 is 0.62', [], baseOpts());
    const polConfs = (result.confirmations ?? []).filter((c) => c.field === 'polarity');
    expect(polConfs).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Invariant (b) — one ios_send_attempt row per surviving wire confirmation.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 matrix — invariant (b): one ios_send_attempt per surviving wire confirmation', () => {
  test('grouped confirmation → exactly one telemetry row', async () => {
    populateWrites = (w) => {
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
      w.readings.set('measured_zs_ohm::2', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
    };
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'zs one two 0.62', [], opts);
    const rows = iosSendAttempts(opts.logger).filter((r) => r.field === 'measured_zs_ohm');
    expect(rows).toHaveLength(1);
    expect(audibleConfirmations(result).length).toBe((result.confirmations ?? []).length);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Invariants (d) + (e) — wire hygiene.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 matrix — invariants (d)+(e): no _confidence on the wire, no __-sentinel in spoken text', () => {
  test('no confirmation carries a _confidence key; no spoken text contains __', async () => {
    populateWrites = (w) => {
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
      w.designationOps.push({ circuit: 2, boardId: null, value: 'Cooker', confidence: 1.0 });
      w.designationOps.push({ circuit: 2, boardId: null, value: 'Sockets', confidence: 1.0 });
      w.readings.set('circuit_designation::2', {
        value: 'Sockets',
        confidence: 1.0,
        source_turn_id: 't1',
      });
    };
    const result = await runShadowHarness(makeSession(), 'multi write turn', [], baseOpts());
    expect(anyConfidenceKeyOnWire(result)).toBe(false);
    expect(anySentinelInSpokenText(result)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scenario families — A3 orphan, A4 drain, D2 net — driven by fabricated
// tool_call sequences + queued prompts.
// ───────────────────────────────────────────────────────────────────────────
describe('F7 matrix — scenario family: A3 orphan net', () => {
  test('zero-tool digit-bearing turn (confirmationsEnabled ON) → one clarifying prompt', async () => {
    toolCallsForTurn = []; // zero tool calls
    const result = await runShadowHarness(makeSession(), 'EFC is 0.86.', [], baseOpts());
    const prompts = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  test('mode-OFF: zero-tool digit turn does NOT fire the A3 orphan prompt', async () => {
    toolCallsForTurn = [];
    const opts = baseOpts({ confirmationsEnabled: false });
    const result = await runShadowHarness(makeSession(), 'EFC is 0.86.', [], opts);
    const prompts = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(prompts).toHaveLength(0);
  });
});

describe('F7 matrix — scenario family: A4 pending-voice-prompt drain', () => {
  test('a queued terminal apology drains into result.confirmations as a field-null prompt', async () => {
    const session = makeSession();
    session.pendingVoicePrompts = [
      { text: 'Sorry, I couldn’t place that reading — say it again?' },
    ];
    // A non-empty tool_calls list keeps the orphan net out of the way.
    toolCallsForTurn = [{ name: 'ask_user', input: {}, result: { is_error: false } }];
    const result = await runShadowHarness(session, 'okay then', [], baseOpts());
    const prompts = (result.confirmations ?? []).filter(
      (c) => c.field == null && c.expects_ios_ack === false
    );
    expect(prompts.length).toBeGreaterThanOrEqual(1);
  });

  // Item 2 applies the trimmed-non-empty predicate to the A4 drain (pre-fix it
  // guarded only on `!p.text`, so "   " slipped through). Use a NON-ask turn
  // (default record_reading tool calls) so the pre-emission net does not fire
  // — this isolates the drain's trim: a whitespace-only queued prompt is
  // dropped entirely, leaving zero field-null confirmations.
  test('a WHITESPACE-ONLY queued prompt does NOT reach the wire (trim predicate)', async () => {
    const session = makeSession();
    session.pendingVoicePrompts = [{ text: '   ' }];
    // default toolCallsForTurn = [record_reading] — no attempted ask_user, so
    // the pre-emission audibility net stays out of the way.
    const result = await runShadowHarness(session, 'okay then', [], baseOpts());
    const prompts = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(prompts).toHaveLength(0);
  });
});

describe('F7 matrix — scenario family: D2 observation_clarify post-answer net', () => {
  test('answered anchor + qualifying record_observation → NO D2 fallback', async () => {
    toolCallsForTurn = [
      {
        name: 'ask_user',
        input: { context_field: 'observation_clarify', clarification_chain_id: 'obsclr-1' },
        result: { is_error: false, content: JSON.stringify({ answered: true }) },
      },
      // D2 mutation-to-chain correlation (2026-07-15): a "successful"
      // record_observation requires a parsed body with ok===true (is_error
      // false alone is not enough), so the net can distinguish a real write
      // from a failed/malformed one.
      { name: 'record_observation', input: {}, result: { is_error: false, content: JSON.stringify({ ok: true }) } },
    ];
    const result = await runShadowHarness(makeSession(), 'crack is cosmetic', [], baseOpts());
    const apologies = (result.confirmations ?? []).filter(
      (c) => typeof c.text === 'string' && /didn.t record that observation/i.test(c.text)
    );
    expect(apologies).toHaveLength(0);
  });

  test('answered anchor + NO qualifying observation → exactly ONE D2 fallback', async () => {
    toolCallsForTurn = [
      {
        name: 'ask_user',
        input: { context_field: 'observation_clarify', clarification_chain_id: 'obsclr-1' },
        result: { is_error: false, content: JSON.stringify({ answered: true }) },
      },
      // an UNRELATED reading — Haiku recorded something else, dropped the obs
      { name: 'record_reading', input: {}, result: { is_error: false, content: '{}' } },
    ];
    const result = await runShadowHarness(makeSession(), 'crack severity', [], baseOpts());
    const apologies = (result.confirmations ?? []).filter(
      (c) => typeof c.text === 'string' && /didn.t record that observation/i.test(c.text)
    );
    expect(apologies).toHaveLength(1);
  });
});
