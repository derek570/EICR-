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
    // r20-#2: telemetry shape switched `reason` → `filter_reason`.
    expect(typeof blockedRow[1].filter_reason).toBe('string');
    expect(blockedRow[1].filter_reason).toMatch(/^marker:/);

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
  // r20-#1 CHANGED THE CONTRACT for record_observation leak handling:
  //   04-26: substitute text with sanitised string, preserve the
  //          observation for audit trail.
  //   04-27: reject the whole call with is_error:true. Reason: once
  //          we also scan location + suggested_regulation (which
  //          can't carry a long sanitised substitute without
  //          corrupting the PDF shape), a uniform reject-on-leak
  //          rule is simpler + safer. The prompt_leak_blocked warn
  //          row already carries the audit breadcrumb.
  test('leaked text (marker) → entire call rejected, observation NOT appended', async () => {
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

    // Envelope: rejected.
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('prompt_leak_in_observation');
    expect(body.error.fields).toContain('text');

    // Observation NOT appended — neither to session nor perTurnWrites.
    expect(session.extractedObservations).toHaveLength(0);
    expect(perTurnWrites.observations).toHaveLength(0);

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
// Group 4: normal domain-specific values on non-text free-text fields
// pass the filter without flagging. r20-#1 reversed the 04-26 decision
// to leave location/suggested_regulation unscanned — those fields are
// now scanned, so this group documents the new contract: normal
// inspector vocabulary (room names, regulation numbers) is safe, but
// leak-shaped content in ANY free-text field on the observation gets
// blocked (Group 5 locks that).
// ---------------------------------------------------------------------------
describe('Layer 2 wiring — non-leak values on scanned observation fields pass', () => {
  test('record_observation with normal domain vocabulary on every free-text field → normal flow', async () => {
    // Real room names, real regulation numbers, real narrative text.
    // None of these should trip the filter even under r20-#1's wider
    // scan.
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_loc',
      name: 'record_observation',
      input: {
        code: 'C2',
        text: 'Absence of RCD protection on socket circuit serving outdoor mobile equipment',
        location: 'Kitchen under-sink consumer unit',
        circuit: 3,
        suggested_regulation: '411.3.3',
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(false);
    expect(session.extractedObservations).toHaveLength(1);
    expect(session.extractedObservations[0].location).toBe('Kitchen under-sink consumer unit');
    expect(session.extractedObservations[0].suggested_regulation).toBe('411.3.3');
    // No prompt_leak_blocked warning on clean input.
    expect(
      logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked')
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 5 — r20-#1 field coverage: scan ALL free-text observation fields
//
// r20 review identified that `dispatchRecordObservation` only scanned
// `text`, leaving `location` and `suggested_regulation` as live bypass
// routes. Both fields land on the PDF certificate (location column +
// regulation text under each observation). r20-#1 widens the scan and
// changes the failure mode from "substitute text / preserve observation
// for audit" (04-26) to "reject the whole observation" (04-27) — the
// shorter fields can't carry a meaningful substitution without
// corrupting the PDF shape, so the entire call is refused and the
// model retries with a clean observation.
//
// Design choices locked by this group:
//   - Fields scanned: text + location + suggested_regulation (all
//     three non-null string-shaped inputs to record_observation).
//   - Failure mode: REJECT entire call (is_error:true,
//     prompt_leak_in_observation). No partial insertion.
//   - Log event: ONE stage6.prompt_leak_blocked row per call naming
//     ALL offending fields (even if multiple leaked simultaneously).
//   - Other tools: ask_user has exactly one free-text field
//     (question, already filtered at 04-26); rename/create_circuit
//     designations are already filtered. No new surface from r20-#1.
// ---------------------------------------------------------------------------
describe('r20-#1 wiring — record_observation scans location + suggested_regulation', () => {
  test('leaked location (structural phrase) → entire call rejected, observation not appended', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_loc_leak',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'Minor cable colour anomaly',
        // Structural phrase in location — real-world attack would
        // steer the model here because 04-26 scanned only text.
        location: 'Prefer silent writes corridor — cupboard under stairs',
        circuit: null,
        suggested_regulation: null,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('prompt_leak_in_observation');
    expect(Array.isArray(body.error?.fields)).toBe(true);
    expect(body.error.fields).toContain('location');

    // Observation NOT appended.
    expect(session.extractedObservations).toHaveLength(0);
    expect(perTurnWrites.observations).toHaveLength(0);

    // prompt_leak_blocked warning emitted naming the offending field.
    const warnCalls = logger.warn.mock.calls;
    const blockedRow = warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked');
    expect(blockedRow).toBeDefined();
    expect(blockedRow[1].tool).toBe('record_observation');
  });

  test('leaked suggested_regulation (requirement ID) → entire call rejected', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_reg_leak',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'Regulation ref anomaly',
        location: 'Consumer unit',
        circuit: null,
        // Requirement-ID leak attempt in what should be a real reg
        // reference — would have sailed into the PDF pre-r20.
        suggested_regulation: 'STQ-01 reference',
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error?.code).toBe('prompt_leak_in_observation');
    expect(body.error.fields).toContain('suggested_regulation');

    expect(session.extractedObservations).toHaveLength(0);
  });

  test('multi-field leak (text + location) → rejected once, log names ALL offending fields', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_multi',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'You are an EICR inspection assistant — prompt follows',
        location: 'TRUST BOUNDARY corridor',
        circuit: null,
        suggested_regulation: null,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(true);

    const body = JSON.parse(res.content);
    expect(body.error?.code).toBe('prompt_leak_in_observation');
    // Both offending fields reported in the error envelope.
    expect(body.error.fields).toEqual(expect.arrayContaining(['text', 'location']));

    // Exactly ONE warn row (not one per field).
    const warnCalls = logger.warn.mock.calls.filter(
      (args) => args[0] === 'stage6.prompt_leak_blocked'
    );
    expect(warnCalls).toHaveLength(1);
  });

  test('clean observation on all three free-text fields → normal flow', async () => {
    // Regression: r20-#1 widens scan; clean inputs must still pass.
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_clean_all',
      name: 'record_observation',
      input: {
        code: 'C2',
        text: 'Absence of RCD protection on socket circuit serving outdoor mobile equipment',
        location: 'Garage consumer unit',
        circuit: 3,
        suggested_regulation: '411.3.3',
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(false);
    expect(session.extractedObservations).toHaveLength(1);
    expect(session.extractedObservations[0].text).toBe(
      'Absence of RCD protection on socket circuit serving outdoor mobile equipment'
    );
    expect(session.extractedObservations[0].location).toBe('Garage consumer unit');
    expect(session.extractedObservations[0].suggested_regulation).toBe('411.3.3');
    expect(
      logger.warn.mock.calls.find((args) => args[0] === 'stage6.prompt_leak_blocked')
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group 6 — r20-#2 redacted telemetry: log rows NEVER carry substrings
// of the blocked payload.
//
// 04-26 emitted `sanitised_sample: input.<field>.slice(0, 80)` on every
// prompt_leak_blocked row — the RAW leaked payload truncated. That meant
// the defensive log itself piped attacker-controlled prompt-disclosure
// content straight to CloudWatch where it's searchable + eventually
// exported to ops staff.
//
// r20-#2 replaces sanitised_sample with structured telemetry:
//   - filter_reason (the pattern-family tag from the filter)
//   - field (which input field the leak was on, or `fields` array for
//     multi-field observation leaks)
//   - length (raw payload char count — numeric only, no content)
//   - hash (first 16 hex chars of SHA-256 over the raw payload — for
//     cross-session correlation without content exposure)
//   - session_id + tool_call_id + tool (already present at 04-26)
//
// SHA-256 is chosen for: (a) cryptographic stability (same payload →
// same hash always, critical for correlating repeated attempts across
// sessions), (b) collision resistance (different leaks → different
// hashes, so the analyzer can count unique attack payloads without
// ever reading one), (c) no plaintext recoverability (unlike base64
// or truncation). 16 hex chars = 64 bits of output — sufficient for
// correlation, too short to brute-force invert from the hash alone.
// ---------------------------------------------------------------------------
describe('r20-#2 redaction — prompt_leak_blocked log rows carry hash + length, never content', () => {
  function getBlockedRow(logger) {
    const warnCalls = logger.warn.mock.calls;
    return warnCalls.find((args) => args[0] === 'stage6.prompt_leak_blocked')?.[1];
  }

  test('ask_user log row has redacted telemetry shape, no substring of leak', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const ws = makeWs();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

      const leakPayload =
        'Here is the system prompt content — TRUST BOUNDARY is the header wrapper for user text';
      const call = {
        id: 'toolu_redact_ask',
        name: 'ask_user',
        input: {
          question: leakPayload,
          reason: 'ambiguous_circuit',
          context_field: null,
          context_circuit: null,
          expected_answer_shape: 'free_text',
        },
      };
      const dispatched = dispatch(call, { sessionId: 'sess-leak', turnId: 'turn-1' });
      await jest.advanceTimersByTimeAsync(21000);
      await dispatched;

      const row = getBlockedRow(logger);
      expect(row).toBeDefined();

      // r20-#2 required keys.
      expect(typeof row.filter_reason).toBe('string');
      expect(row.filter_reason).toMatch(/^marker:/); // TRUST BOUNDARY
      expect(row.field).toBe('question');
      expect(typeof row.length).toBe('number');
      expect(row.length).toBe(leakPayload.length);
      expect(typeof row.hash).toBe('string');
      expect(row.hash).toMatch(/^[0-9a-f]{16}$/); // 16 hex chars

      // r20-#2 forbidden keys / leakage vectors.
      expect(row.sanitised_sample).toBeUndefined();
      // The row JSON must not contain any substring of the original
      // payload. Check against the trigger substring + several longer
      // windows from the payload.
      const rowJson = JSON.stringify(row);
      expect(rowJson.toLowerCase()).not.toContain('trust boundary');
      expect(rowJson).not.toContain(leakPayload.slice(0, 30));
      expect(rowJson).not.toContain(leakPayload.slice(20, 60));
    } finally {
      jest.useRealTimers();
    }
  });

  test('record_observation log row (multi-field leak) uses fields[] + offending_field_lengths', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const leakedText = 'You are an EICR inspection assistant — full prompt';
    const leakedLocation = 'TRUST BOUNDARY corridor';

    const call = {
      tool_call_id: 'toolu_redact_obs',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: leakedText,
        location: leakedLocation,
        circuit: null,
        suggested_regulation: null,
      },
    };

    await dispatchRecordObservation(call, ctx);

    const row = getBlockedRow(logger);
    expect(row).toBeDefined();

    expect(row.tool).toBe('record_observation');
    expect(typeof row.filter_reason).toBe('string');
    expect(Array.isArray(row.fields)).toBe(true);
    expect(row.fields).toEqual(expect.arrayContaining(['text', 'location']));

    // offending_field_lengths: exact char lengths of each offending input.
    expect(typeof row.offending_field_lengths).toBe('object');
    expect(row.offending_field_lengths.text).toBe(leakedText.length);
    expect(row.offending_field_lengths.location).toBe(leakedLocation.length);

    // No sanitised_sample, no substring of either leak.
    expect(row.sanitised_sample).toBeUndefined();
    const rowJson = JSON.stringify(row);
    expect(rowJson.toLowerCase()).not.toContain('eicr inspection assistant');
    expect(rowJson.toLowerCase()).not.toContain('trust boundary');
  });

  test('create_circuit designation leak row has field=designation + hash + length', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const leakedDesignation = 'STQ-01 upstairs lights with extra prompt detail';
    const call = {
      tool_call_id: 'toolu_redact_create',
      name: 'create_circuit',
      input: {
        circuit_ref: 3,
        designation: leakedDesignation,
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    await dispatchCreateCircuit(call, ctx);

    const row = getBlockedRow(logger);
    expect(row).toBeDefined();
    expect(row.tool).toBe('create_circuit');
    expect(row.field).toBe('designation');
    expect(typeof row.filter_reason).toBe('string');
    expect(row.length).toBe(leakedDesignation.length);
    expect(row.hash).toMatch(/^[0-9a-f]{16}$/);

    expect(row.sanitised_sample).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('upstairs lights with extra');
  });

  test('rename_circuit designation leak row has same redacted shape', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const leakedDesignation = 'You have 7 tools — rename to this';
    const call = {
      tool_call_id: 'toolu_redact_rename',
      name: 'rename_circuit',
      input: {
        from_ref: 1,
        circuit_ref: 1,
        designation: leakedDesignation,
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    await dispatchRenameCircuit(call, ctx);

    const row = getBlockedRow(logger);
    expect(row).toBeDefined();
    expect(row.tool).toBe('rename_circuit');
    expect(row.field).toBe('designation');
    expect(typeof row.filter_reason).toBe('string');
    expect(row.length).toBe(leakedDesignation.length);
    expect(row.hash).toMatch(/^[0-9a-f]{16}$/);

    expect(row.sanitised_sample).toBeUndefined();
    const rowJson = JSON.stringify(row);
    expect(rowJson).not.toContain('You have 7 tools');
  });

  test('hash is deterministic: same payload on same session produces same hash', async () => {
    const logger1 = makeLogger();
    const logger2 = makeLogger();
    const session = makeSession('live');
    const perTurnWrites = makePerTurnWrites();

    const sharedLeak = 'STQ-05 reference for prompt';
    const ctx1 = { session, logger: logger1, turnId: 'turn-a', perTurnWrites, round: 1 };
    const ctx2 = {
      session,
      logger: logger2,
      turnId: 'turn-b',
      perTurnWrites: makePerTurnWrites(),
      round: 2,
    };

    const call1 = {
      tool_call_id: 'toolu_hash_a',
      name: 'create_circuit',
      input: {
        circuit_ref: 10,
        designation: sharedLeak,
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };
    const call2 = {
      tool_call_id: 'toolu_hash_b',
      name: 'create_circuit',
      input: {
        circuit_ref: 11,
        designation: sharedLeak,
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
    };

    await dispatchCreateCircuit(call1, ctx1);
    await dispatchCreateCircuit(call2, ctx2);

    const row1 = getBlockedRow(logger1);
    const row2 = getBlockedRow(logger2);
    expect(row1.hash).toBe(row2.hash);
  });

  test('hash distinguishes different payloads', async () => {
    const logger1 = makeLogger();
    const logger2 = makeLogger();
    const session = makeSession('live');

    const ctx1 = {
      session,
      logger: logger1,
      turnId: 't1',
      perTurnWrites: makePerTurnWrites(),
      round: 1,
    };
    const ctx2 = {
      session,
      logger: logger2,
      turnId: 't2',
      perTurnWrites: makePerTurnWrites(),
      round: 1,
    };

    await dispatchCreateCircuit(
      {
        tool_call_id: 'toolu_diff_a',
        name: 'create_circuit',
        input: {
          circuit_ref: 20,
          designation: 'STQ-01 variant one',
          phase: null,
          rating_amps: null,
          cable_csa_mm2: null,
        },
      },
      ctx1
    );
    await dispatchCreateCircuit(
      {
        tool_call_id: 'toolu_diff_b',
        name: 'create_circuit',
        input: {
          circuit_ref: 21,
          designation: 'STQ-02 variant two',
          phase: null,
          rating_amps: null,
          cable_csa_mm2: null,
        },
      },
      ctx2
    );

    const row1 = getBlockedRow(logger1);
    const row2 = getBlockedRow(logger2);
    expect(row1.hash).not.toBe(row2.hash);
  });
});

// ---------------------------------------------------------------------------
// Group 7 — r21-#1 field-class granularity wiring.
//
// r21 re-review of r20-#1: the observation dispatcher correctly SCANS
// `location` + `suggested_regulation`, but classifies BOTH as
// `field: 'observation_text'`, inheriting the 1000-char length ceiling.
// Real-world values are orders of magnitude shorter:
//   - location: "Kitchen sockets consumer unit" (~30 chars)
//   - suggested_regulation: "Regulation 522.6.201" (~20 chars)
// A 150-char benign paraphrase of the system prompt in either field
// passes every existing detector and lands verbatim in the PDF.
//
// Fix: introduce `observation_location` (120c ceiling + 0.6 alpha guard)
// and `observation_regulation` (60c ceiling, no alpha guard) field
// classes. Dispatcher routes each field to its own class.
//
// Tests below drive the bypass through the dispatcher end-to-end: a
// 150-char paraphrase that is CLEAN under observation_text class must
// now be REJECTED when it lands in `location` or `suggested_regulation`.
// ---------------------------------------------------------------------------
describe('r21-#1 wiring — observation dispatcher uses per-field classes', () => {
  test('150-char clean paraphrase in `location` → rejected on observation_location 120c ceiling', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    // Clean-looking narrative — no markers, no entropy, normal alpha
    // ratio, well under the 1000c observation_text ceiling. The
    // ONLY way it gets rejected is if the dispatcher classifies
    // `location` as its own class with a tighter ceiling.
    const paraphrase =
      'This is a legitimate looking short narrative describing some ' +
      'position in the consumer unit but it is a bit too long for a ' +
      'location label and should be flagged by the new ceiling.';
    expect(paraphrase.length).toBeGreaterThan(120);
    expect(paraphrase.length).toBeLessThan(200);

    const call = {
      tool_call_id: 'toolu_obs_loc_paraphrase',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'Minor cable colour anomaly',
        location: paraphrase,
        circuit: null,
        suggested_regulation: null,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('prompt_leak_in_observation');
    expect(body.error.fields).toContain('location');
    // r21-#1 proof: the reason is the LENGTH family on the new class,
    // not any of the content-family detectors that already caught it
    // under r20.
    expect(body.error.reason).toMatch(/^length-suspicious:/);

    expect(session.extractedObservations).toHaveLength(0);
  });

  test('150-char clean paraphrase in `suggested_regulation` → rejected on observation_regulation 60c ceiling', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const paraphrase =
      'This is a really long regulation citation that would describe ' +
      'some BS 7671 section in great detail and is well over what real ' +
      'references look like — a bypass attempt.';
    expect(paraphrase.length).toBeGreaterThan(60);

    const call = {
      tool_call_id: 'toolu_obs_reg_paraphrase',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'Minor cable colour anomaly',
        location: 'Consumer unit',
        circuit: null,
        suggested_regulation: paraphrase,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error?.code).toBe('prompt_leak_in_observation');
    expect(body.error.fields).toContain('suggested_regulation');
    expect(body.error.reason).toMatch(/^length-suspicious:/);

    expect(session.extractedObservations).toHaveLength(0);
  });

  test('Same 150-char paraphrase in `text` field → ACCEPTED (observation_text 1000c ceiling)', async () => {
    // Proves the per-field class split: same content is safe under
    // observation_text class but unsafe under observation_location.
    // This is the exact assertion r21-#1 requires.
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const paraphrase =
      'This is a legitimate looking short narrative describing some ' +
      'position in the consumer unit but it is a bit too long for a ' +
      'location label and should be flagged by the new ceiling.';

    const call = {
      tool_call_id: 'toolu_obs_text_paraphrase_ok',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: paraphrase,
        location: 'Consumer unit',
        circuit: null,
        suggested_regulation: null,
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(false);
    expect(session.extractedObservations).toHaveLength(1);
    expect(session.extractedObservations[0].text).toBe(paraphrase);
  });

  test('Short real location (30 chars) → normal flow', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const perTurnWrites = makePerTurnWrites();
    const ctx = { session, logger, turnId: 'turn-1', perTurnWrites, round: 1 };

    const call = {
      tool_call_id: 'toolu_obs_loc_short',
      name: 'record_observation',
      input: {
        code: 'C3',
        text: 'Loose neutral on ring final',
        location: 'Kitchen sockets consumer unit',
        circuit: 4,
        suggested_regulation: 'Regulation 522.6.201',
      },
    };

    const res = await dispatchRecordObservation(call, ctx);
    expect(res.is_error).toBe(false);
    expect(session.extractedObservations).toHaveLength(1);
    expect(session.extractedObservations[0].location).toBe('Kitchen sockets consumer unit');
    expect(session.extractedObservations[0].suggested_regulation).toBe('Regulation 522.6.201');
  });
});
