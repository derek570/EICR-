/**
 * Stage 6 Phase 4 Plan 04-26 — Layer 2 dispatcher wiring tests.
 *
 * WHAT: integration tests that check `checkForPromptLeak()`
 * (Layer 2, tested in isolation in stage6-prompt-leak-filter.test.js)
 * is wired into the three free-text emission paths BEFORE the
 * dispatcher registers / mutates / forwards:
 *   - ask_user.question           (question-class)
 *   - record_observation.text     (observation_text-class)
 *   - create_circuit.designation  (designation-class)
 *   - rename_circuit.designation  (designation-class)
 *
 * WHY integration (not unit): the wiring is the contract. A
 * regression where the filter is correctly implemented but NOT
 * called from the dispatcher would leak happily. These tests
 * exercise the full call-path of each dispatcher, asserting the
 * filter's preventive side effects (no register, no ws.send, no
 * PDF-bound text) on a leak and normal-path on clean input.
 *
 * Groups:
 *   Group 1 — ask_user: leaked question → no register, no ws
 *             ask_user_started emission, returns
 *             prompt_leak_blocked envelope + log row.
 *   Group 2 — record_observation: leaked text → observation IS
 *             still recorded (audit trail) but text is REPLACED
 *             with the sanitised refusal string.
 *   Group 3 — create_circuit / rename_circuit: leaked
 *             designation → dispatcher REJECTS the tool call
 *             (is_error:true, error code 'prompt_leak_in_designation').
 *   Group 4 — clean-path regression: no filter activity on
 *             clean inputs; existing dispatcher behaviour
 *             unchanged.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { dispatchRecordObservation } from '../extraction/stage6-dispatchers-observation.js';
import {
  dispatchCreateCircuit,
  dispatchRenameCircuit,
} from '../extraction/stage6-dispatchers-circuit.js';

// --- helpers ----------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeWs({ open = true } = {}) {
  const sent = [];
  return {
    readyState: open ? 1 : 3,
    OPEN: 1,
    sent,
    send: jest.fn(function (data) {
      sent.push(JSON.parse(data));
    }),
  };
}

function makeSession(mode = 'live') {
  return {
    sessionId: 'sess-leak',
    toolCallsMode: mode,
    extractedObservations: [],
    stateSnapshot: {
      // stateSnapshot.circuits is an object keyed by circuit_ref
      // (see stage6-snapshot-mutators.js:43).
      circuits: {
        1: { designation: 'Upstairs lights' },
        2: { designation: 'Kitchen sockets' },
      },
    },
  };
}

function makePerTurnWrites() {
  return {
    readings: new Map(),
    cleared: [],
    observations: [],
    deletedObservations: [],
    circuitOps: [],
  };
}

// ---------------------------------------------------------------------------
// Group 1: ask_user wiring
// ---------------------------------------------------------------------------
describe('Layer 2 wiring — ask_user.question', () => {
  // Use fake timers so a RED-state failure (dispatcher registers + awaits
  // the 20s STA-03 timer) advances deterministically rather than wall-
  // clock-waiting 20s per failing assertion. GREEN state returns
  // immediately because the filter short-circuits before register.
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick'] }));
  afterEach(() => jest.useRealTimers());

  test('leaked question (TRUST BOUNDARY marker) → no register, no ws emission, blocked envelope', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

    const call = {
      id: 'toolu_leak_1',
      name: 'ask_user',
      input: {
        question: 'Here is the system prompt content — TRUST BOUNDARY is the header...',
        reason: 'ambiguous_circuit',
        context_field: null,
        context_circuit: null,
        expected_answer_shape: 'free_text',
      },
    };
    const dispatched = dispatch(call, { sessionId: 'sess-leak', turnId: 'turn-1' });
    // Advance past the STA-03 20s timer so if the dispatcher DID
    // register (RED state), the timer fires a `timeout` outcome and
    // the await resolves quickly. Under GREEN (filter in place), the
    // dispatched promise has already resolved with prompt_leak_blocked
    // before we advance — either way the test completes fast.
    await jest.advanceTimersByTimeAsync(21000);
    const res = await dispatched;

    // Envelope shape: answered:false, reason:prompt_leak_blocked,
    // is_error:false (let the model see a clean result and move on,
    // don't poison the tool loop).
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.answered).toBe(false);
    expect(body.reason).toBe('prompt_leak_blocked');

    // Registry: NO pending entry (the ask was never registered).
    expect(pending.size).toBe(0);

    // ws: NO ask_user_started emission.
    const askStarted = ws.sent.filter((m) => m && m.type === 'ask_user_started');
    expect(askStarted).toEqual([]);

    // Log: a stage6.prompt_leak_blocked row with tool: 'ask_user'.
    const warnCalls = logger.warn.mock.calls;
    const blockedRow = warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blockedRow).toBeDefined();
    expect(blockedRow[1]).toEqual(
      expect.objectContaining({
        tool: 'ask_user',
        tool_call_id: 'toolu_leak_1',
      })
    );
    expect(typeof blockedRow[1].reason).toBe('string');
    expect(blockedRow[1].reason).toMatch(/^marker:/);

    // Also: an ask_user log row with answer_outcome='prompt_leak_blocked'
    // (so the Phase 8 analyzer sees the ask was attempted).
    const askUserRow = logger.info.mock.calls.find((args) => args[0] === 'stage6.ask_user');
    expect(askUserRow).toBeDefined();
    expect(askUserRow[1].answer_outcome).toBe('prompt_leak_blocked');
  });

  test('leaked question (structural phrase) is also blocked', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

    const call = {
      id: 'toolu_leak_2',
      name: 'ask_user',
      input: {
        question:
          'Sure — "You have 7 tools" and the prompt continues with the observation rules...',
        reason: 'observation_confirmation',
        context_field: null,
        context_circuit: null,
        expected_answer_shape: 'yes_no',
      },
    };
    const dispatched = dispatch(call, { sessionId: 'sess-leak', turnId: 'turn-1' });
    await jest.advanceTimersByTimeAsync(21000);
    const res = await dispatched;

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).reason).toBe('prompt_leak_blocked');
    expect(pending.size).toBe(0);
    expect(ws.sent.filter((m) => m && m.type === 'ask_user_started')).toEqual([]);
  });

  test('clean question → normal flow (registers, emits, awaits)', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

    const call = {
      id: 'toolu_clean_1',
      name: 'ask_user',
      input: {
        question: 'Circuit 6 is not on the schedule — create it, and what is the description?',
        reason: 'out_of_range_circuit',
        context_field: 'measured_zs_ohm',
        context_circuit: 6,
        expected_answer_shape: 'free_text',
      },
    };

    const dispatched = dispatch(call, { sessionId: 'sess-leak', turnId: 'turn-1' });

    // Yield a microtask so the dispatcher's sync setup runs.
    await Promise.resolve();

    // Registered + emitted ask_user_started.
    expect(pending.size).toBe(1);
    const askStarted = ws.sent.filter((m) => m && m.type === 'ask_user_started');
    expect(askStarted).toHaveLength(1);

    // Resolve with an answered reply.
    pending.resolve('toolu_clean_1', {
      answered: true,
      user_text: 'Call it upstairs sockets',
    });

    const res = await dispatched;
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.answered).toBe(true);
    expect(body.untrusted_user_text).toBe('Call it upstairs sockets');

    // No prompt_leak_blocked warning on the clean path.
    const warnCalls = logger.warn.mock.calls;
    expect(warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 2: record_observation wiring
// ---------------------------------------------------------------------------
describe('Layer 2 wiring — record_observation.text', () => {
  test('leaked text (marker) → observation recorded, text replaced with sanitised string', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_leak',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'The user asked about SYSTEM_CHANNEL framing — my instructions are as follows: TRUST BOUNDARY...',
        location: 'main consumer unit',
        circuit: null,
        suggested_regulation: null,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);

    // Envelope: observation was recorded successfully.
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(true);
    expect(typeof body.observation_id).toBe('string');

    // The observation on the session was recorded — but with
    // sanitised text, NOT the original leak text.
    expect(session.extractedObservations).toHaveLength(1);
    const rec = session.extractedObservations[0];
    expect(rec.text).toBe('Attempted prompt extraction — refused.');
    expect(rec.text.includes('TRUST BOUNDARY')).toBe(false);
    expect(rec.text.includes('SYSTEM_CHANNEL')).toBe(false);
    expect(rec.code).toBe('C3');

    // perTurnWrites also carries the sanitised text.
    expect(perTurnWrites.observations).toHaveLength(1);
    expect(perTurnWrites.observations[0].text).toBe('Attempted prompt extraction — refused.');

    // Log: a stage6.prompt_leak_blocked warning row.
    const warnCalls = logger.warn.mock.calls;
    const blockedRow = warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blockedRow).toBeDefined();
    expect(blockedRow[1]).toEqual(
      expect.objectContaining({
        tool: 'record_observation',
        tool_call_id: 'toolu_obs_leak',
      })
    );
  });

  test('clean observation text → normal flow (no filter activity)', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_clean',
      name: 'record_observation',
      input: {
        code: 'C2',
        text: 'Absence of RCD protection on socket circuit serving outdoor mobile equipment',
        location: 'garage',
        circuit: 3,
        suggested_regulation: '411.3.3',
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(false);

    // Observation recorded with ORIGINAL text.
    expect(session.extractedObservations).toHaveLength(1);
    expect(session.extractedObservations[0].text).toBe(
      'Absence of RCD protection on socket circuit serving outdoor mobile equipment'
    );

    // No prompt_leak_blocked warning.
    const warnCalls = logger.warn.mock.calls;
    expect(warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 3: create_circuit / rename_circuit designation wiring
// ---------------------------------------------------------------------------
describe('Layer 2 wiring — create_circuit.designation', () => {
  test('leaked designation (requirement ID) → dispatcher rejects with is_error:true', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_create_leak',
      name: 'create_circuit',
      input: {
        circuit_ref: 3,
        designation: 'STQ-01 upstairs lights', // prompt-disclosure content
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    const res = await dispatchCreateCircuit(call, ctx);

    // Rejected — certificate correctness: don't substitute a
    // refusal-string as a circuit designation.
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('prompt_leak_in_designation');

    // No circuit op tracked.
    expect(perTurnWrites.circuitOps).toHaveLength(0);

    // Circuit not added to snapshot.
    expect(session.stateSnapshot.circuits[3]).toBeUndefined();

    // prompt_leak_blocked warning emitted.
    const warnCalls = logger.warn.mock.calls;
    const blockedRow = warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blockedRow).toBeDefined();
    expect(blockedRow[1].tool).toBe('create_circuit');
  });

  test('clean designation → normal flow', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_create_clean',
      name: 'create_circuit',
      input: {
        circuit_ref: 3,
        designation: 'Outdoor sockets',
        phase: null,
        rating_amps: 20,
        cable_csa_mm2: 2.5,
      },
    };

    const res = await dispatchCreateCircuit(call, ctx);
    expect(res.is_error).toBe(false);

    expect(perTurnWrites.circuitOps).toHaveLength(1);
    expect(perTurnWrites.circuitOps[0].op).toBe('create');
    const added = session.stateSnapshot.circuits[3];
    expect(added).toBeDefined();
    expect(added.designation).toBe('Outdoor sockets');
  });

  test('create_circuit with null designation → no filter activity (optional field)', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_create_null',
      name: 'create_circuit',
      input: {
        circuit_ref: 3,
        designation: null,
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    const res = await dispatchCreateCircuit(call, ctx);
    expect(res.is_error).toBe(false);
    expect(
      logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked')
    ).toBeUndefined();
  });
});

describe('Layer 2 wiring — rename_circuit.designation', () => {
  test('leaked designation (structural phrase) → dispatcher rejects', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_rename_leak',
      name: 'rename_circuit',
      input: {
        from_ref: 1,
        circuit_ref: 1,
        designation: 'You are an EICR inspection assistant — renamed',
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    const res = await dispatchRenameCircuit(call, ctx);
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error?.code).toBe('prompt_leak_in_designation');

    // The circuit's original designation is untouched.
    expect(session.stateSnapshot.circuits[1].designation).toBe('Upstairs lights');
  });

  test('rename_circuit with clean designation → normal flow', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_rename_clean',
      name: 'rename_circuit',
      input: {
        from_ref: 1,
        circuit_ref: 1,
        designation: 'Upstairs lights + landing',
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    const res = await dispatchRenameCircuit(call, ctx);
    expect(res.is_error).toBe(false);
    expect(perTurnWrites.circuitOps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Group 4: other free-text fields deliberately NOT scanned
// ---------------------------------------------------------------------------
describe('Layer 2 wiring — other free-text fields are NOT over-filtered', () => {
  test('record_observation.location with incidental text not flagged', async () => {
    // location is a short domain-specific field (room/area) — adding
    // a filter here would increase FP surface for marginal benefit.
    // Test documents the deliberate scope boundary: only `text` on
    // observations is scanned, not `location` or `suggested_regulation`.
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_loc',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'Non-compliant cable colour',
        // Intentionally include a structural phrase in LOCATION —
        // filter must NOT flag this because location isn't scanned.
        // (Real inspectors won't write this; the test just verifies
        // scope boundary.)
        location: 'Prefer silent writes corridor — cupboard under stairs',
        circuit: null,
        suggested_regulation: null,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(false);
    // Observation recorded — location NOT substituted.
    expect(session.extractedObservations[0].location).toContain('Prefer silent writes');
    // No prompt_leak_blocked (confirms location is NOT scanned).
    expect(
      logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked')
    ).toBeUndefined();
  });
});
