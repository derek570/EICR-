/**
 * designation-hygiene-oracle.test.js — PLAN-B (feedback ids 128+131,
 * 2026-08-23): the atomic `designation_hygiene` expected-operation type.
 *
 * The corpus previously could NOT express the designation-hygiene fixture:
 * fixture-schema rejected `create_circuit` expected operations as
 * unsupported, replay-assertions latched them INFRASTRUCTURE, and a naive
 * per-concern decomposition (reading op + audible-output matcher) REDs on
 * pre-fix code with MULTIPLE independent failure ids — violating the
 * corpus's exact `expected_failure_id` contract. The new type is a JOINT
 * oracle with ONE stable failure id (`designation_hygiene.<operation_id>`)
 * covering: cleaned designation projection (exactly once, zero dirty
 * variants), cleaned legacy-shape circuit_updates projection, cleaned
 * post-turn AUTHORITATIVE stored state (via the INJECTED
 * readCircuitDesignation — same dynamic-injection rule as toClearWireField;
 * absent → INFRASTRUCTURE), exactly one byte-exact circuit_op confirmation,
 * and (when declared) zero forbidden clarification asks.
 *
 * Pinned here:
 *   - schema: valid shape accepted; every malformed shape rejected
 *     fail-closed (incl. a DIRTY declared expectation — a hygiene fixture
 *     must never lock the defect it exists to prevent); the v1 rejection of
 *     clear/rename/create_circuit kinds is UNTOUCHED (gate not weakened);
 *     the op registers its created circuit ref for later ops.
 *   - oracle: GREEN on the post-fix shape; the PRE-FIX shape (dirty write +
 *     dirty confirmation + which-circuit ask) REDs with EXACTLY ONE
 *     distinct failure id across the WHOLE turn evaluation; each leg fails
 *     individually under the same single id; missing injected state reader
 *     latches INFRASTRUCTURE (which can never satisfy an expected_red).
 *   - gate-state semantics: expected_red RED-confirmed / XPASS / the
 *     required_green proof-mode bypass.
 *   - END-TO-END through the REAL harness: the committed corpus fixture
 *     frc_6600a62a… (required_green, red_proof designation_hygiene.op_desig_cc)
 *     validates AND passes on the fixed tree; a mismatched-expectation
 *     variant fails with exactly the single joint id (the single-id RED
 *     shape, proven against real harness output); a modules set lacking the
 *     injected reader resolves infrastructure_error.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  matchOperations,
  evaluateTurn,
  evaluateGateState,
  OUTCOME,
} from '../../../scripts/field-replay/lib/replay-assertions.mjs';
import {
  validateFixtureDocument,
  FIXTURE_ERROR_CODES,
} from '../../../scripts/field-replay/lib/fixture-schema.mjs';
import { runFixture } from '../../../scripts/field-replay/lib/replay-runner-core.mjs';

import { EICRExtractionSession } from '../../extraction/eicr-extraction-session.js';
import { activeSessions } from '../../extraction/active-sessions.js';
import { createPendingAsksRegistry } from '../../extraction/stage6-pending-asks-registry.js';
import { createAskBudget } from '../../extraction/stage6-ask-budget.js';
import {
  snapshotFlagsForSession,
  parseVoiceLatencyCapabilities,
} from '../../extraction/voice-latency-config.js';
import { createFilledSlotsShadowLogger } from '../../extraction/stage6-filled-slots-shadow.js';
import { runShadowHarness } from '../../extraction/stage6-shadow-harness.js';
import { getCircuitBucket } from '../../extraction/stage6-multi-board-shape.js';
import { processInsulationResistanceTurn } from '../../extraction/dialogue-engine/index.js';
import { FIELD_CORRECTIONS } from '../../extraction/field-name-corrections.js';

// Mirrors the CLI's importExtractionModules readCircuitDesignation exactly
// (transcript-replay-direct-runner.mjs) — both bucket spellings, null board
// falls back to the snapshot's current board.
const readCircuitDesignation = (session, circuitRef, boardId) => {
  const bucket = getCircuitBucket(session?.stateSnapshot, Number(circuitRef), boardId ?? null);
  const v = bucket?.circuit_designation ?? bucket?.designation ?? null;
  return typeof v === 'string' ? v : null;
};

const readCircuitField = (session, circuitRef, boardId, field) => {
  const bucket = getCircuitBucket(session?.stateSnapshot, Number(circuitRef), boardId ?? null);
  const v = bucket?.[field];
  return v == null ? null : String(v);
};

const toReadingWireField = (raw) => FIELD_CORRECTIONS[raw] ?? raw;

const modules = {
  EICRExtractionSession,
  activeSessions,
  createPendingAsksRegistry,
  createAskBudget,
  snapshotFlagsForSession,
  parseVoiceLatencyCapabilities,
  createFilledSlotsShadowLogger,
  runShadowHarness,
  readCircuitDesignation,
  readCircuitField,
  toReadingWireField,
  dialogueScriptIngress: { insulation_resistance: processInsulationResistanceTurn },
};

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/fixtures/field-replay-corpus/frc_6600a62a7807c94766e10288526f733d/fixture.yaml'
);
const loadCommittedFixture = () => yaml.load(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const CLEAN = 'Upstairs lighting';
const DIRTY = 'Upstairs lighting circuit';
const CLEAN_CONF = 'Circuit 2 is now the Upstairs lighting';
const DIRTY_CONF = 'Circuit 2 is now the Upstairs lighting circuit';

function hygieneOp(overrides = {}) {
  return {
    operation_id: 'op_x',
    kind: 'designation_hygiene',
    circuit: 2,
    value: CLEAN,
    confirmation_text_exact: CLEAN_CONF,
    no_ask_question_contains: 'which circuit',
    audibility: 'exactly_once',
    ...overrides,
  };
}

/** Minimal executable fixture document around one designation_hygiene op. */
function schemaDoc(op = hygieneOp(), extraTurnProps = {}) {
  return {
    schema_version: 1,
    corpus_id: 'frc_00000000000000000000000000000011',
    purpose: 'regression',
    gate_state: 'required_green',
    red_proof_failure_id: `designation_hygiene.${op.operation_id}`,
    owner: 'Derek Beckley',
    initial_state_fidelity: 'hand_authored',
    job_state: {
      certificateType: 'eicr',
      boards: [{ id: 'main', board_type: 'main' }],
      circuits: [],
    },
    client_capabilities: { value: ['low_conf_readback_v1'], provenance: 'recorded_full' },
    fallback_to_legacy: { value: false, provenance: 'recorded_full' },
    turns: [
      {
        turn_index: 1,
        at_ms: 0,
        transcript: 'Circuit number 2 is a upstairs lighting circuit.',
        regex_results: [],
        confirmations_enabled: { value: true, provenance: 'recorded_full' },
        in_response_to: { value: false, provenance: 'recorded_full' },
        ws_mode: 'open',
        chime_observed: false,
        model_rounds: [
          {
            stop_reason: 'tool_use',
            tool_calls: [
              {
                id: 'sym_tc_dh',
                name: 'create_circuit',
                input: { circuit_ref: 2, designation: DIRTY },
                schema_expectation: 'accept',
                dispatcher_expectation: 'accept',
              },
            ],
          },
          { stop_reason: 'end_turn', text: '' },
        ],
        expected_operations: [op],
        ...extraTurnProps,
      },
    ],
  };
}

/** POST-FIX-shaped captured turn evidence (the world with B1 landed). */
function greenCaptured(overrides = {}) {
  return {
    result: {
      extracted_readings: [
        { field: 'designation', circuit: 2, value: CLEAN, confidence: 1.0, source: 'tool_call' },
      ],
      confirmations: [{ text: CLEAN_CONF, field: 'circuit_op', circuit: 2 }],
    },
    wsFrames: [],
    logRows: [{ name: 'ios_send_attempt', meta: {} }],
    askOrigins: new Map(),
    infrastructureViolations: [],
    validateToolInput: null,
    toClearWireField: null,
    readCircuitDesignation: () => CLEAN,
    ...overrides,
  };
}

/** PRE-FIX-shaped captured turn evidence (the dirty world this fixture
 *  RED-proves): dirty projection, dirty stored state, dirty read-back, AND
 *  a which-circuit ask — every leg wrong at once. */
function dirtyCaptured() {
  return greenCaptured({
    result: {
      extracted_readings: [
        { field: 'designation', circuit: 2, value: DIRTY, confidence: 1.0, source: 'tool_call' },
      ],
      confirmations: [{ text: DIRTY_CONF, field: 'circuit_op', circuit: 2 }],
    },
    wsFrames: [
      {
        type: 'ask_user_started',
        tool_call_id: 'sym_srv_which_1',
        question: 'Which circuit is the insulation resistance for?',
      },
    ],
    readCircuitDesignation: () => DIRTY,
  });
}

/** The evaluateTurn turn payload matching the captured shapes (no model
 *  rounds — the pure-engine tests assert the ORACLE, not the harness). */
function bareTurn(op = hygieneOp()) {
  return { turn_index: 1, at_ms: 0, transcript: 'x', expected_operations: [op] };
}

afterEach(() => {
  for (const [id] of activeSessions) {
    if (String(id).startsWith('frsess_')) activeSessions.delete(id);
  }
});

describe('fixture-schema: designation_hygiene shape (fail-closed)', () => {
  test('a well-formed designation_hygiene op validates', async () => {
    const res = await validateFixtureDocument(schemaDoc());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test('the COMMITTED corpus fixture document validates', async () => {
    const res = await validateFixtureDocument(loadCommittedFixture());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  test.each([
    ['dirty expected value locks the defect', { value: DIRTY }],
    ['leading banned token in expected value', { value: 'Circuit upstairs lighting' }],
    ['punctuated trailing banned token', { value: 'Upstairs lighting circuit.' }],
    ['padded expected value', { value: ' Upstairs lighting ' }],
    ['empty expected value', { value: '' }],
    ['missing value', { value: undefined }],
    ['missing confirmation_text_exact', { confirmation_text_exact: undefined }],
    ['padded confirmation_text_exact', { confirmation_text_exact: ` ${CLEAN_CONF} ` }],
    ['null circuit', { circuit: null }],
    ['circuits[] not allowed', { circuits: [2, 3] }],
    ['state_transition not allowed', { state_transition: 'clear_then_write' }],
    ['field not allowed', { field: 'designation' }],
    ['audibility must be exactly_once', { audibility: 'derived_exempt' }],
    ['empty no_ask_question_contains', { no_ask_question_contains: '   ' }],
  ])('rejects malformed shape: %s', async (_label, overrides) => {
    const res = await validateFixtureDocument(schemaDoc(hygieneOp(overrides)));
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(
      FIXTURE_ERROR_CODES.DESIGNATION_HYGIENE_BAD_SHAPE
    );
  });

  test('hyphen-adjacent and interior tokens are NOT banned edges (delimiter grammar, not \\b)', async () => {
    for (const value of ['Short-circuit tester', 'Ring circuit sockets']) {
      const conf = `Circuit 2 is now the ${value}`;
      const res = await validateFixtureDocument(
        schemaDoc(hygieneOp({ value, confirmation_text_exact: conf }))
      );
      expect(res.errors).toEqual([]);
    }
  });

  test('gate NOT weakened: clear / rename / create_circuit expected ops stay rejected in v1', async () => {
    for (const kind of ['clear', 'rename', 'create_circuit']) {
      const doc = schemaDoc();
      doc.turns[0].expected_operations = [
        { operation_id: `op_${kind}`, kind, circuit: 2, audibility: 'exactly_once' },
      ];
      const res = await validateFixtureDocument(doc);
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.message.includes('no faithful oracle yet'))).toBe(true);
    }
  });

  test('the op REGISTERS its created circuit ref for later operations', async () => {
    const doc = schemaDoc();
    doc.turns[0].expected_operations.push({
      operation_id: 'op_follow_reading',
      kind: 'reading',
      field: 'measured_zs_ohm',
      circuit: 2, // NOT in job_state.circuits — created by the hygiene op's turn
      value: '0.35',
      audibility: 'exactly_once',
    });
    const res = await validateFixtureDocument(doc);
    expect(res.errors.filter((e) => e.code === FIXTURE_ERROR_CODES.STATE_DEP_MISSING)).toEqual([]);
  });
});

describe('replay-assertions: the designation_hygiene JOINT oracle', () => {
  test('GREEN on the post-fix shape (all legs clean)', () => {
    const failures = evaluateTurn(bareTurn(), greenCaptured());
    expect(failures).toEqual([]);
  });

  test('the PRE-FIX shape REDs with EXACTLY ONE distinct failure id across the whole turn', () => {
    const failures = evaluateTurn(bareTurn(), dirtyCaptured());
    expect(failures.length).toBeGreaterThan(0);
    const ids = [...new Set(failures.map((f) => f.id))];
    expect(ids).toEqual(['designation_hygiene.op_x']);
    expect(failures.every((f) => f.outcome === OUTCOME.FAIL)).toBe(true);
    // The joint message names every failing leg (dirty projection, stored
    // state, confirmation text, forbidden ask).
    const msg = failures[0].message;
    expect(msg).toMatch(/designation projection/);
    expect(msg).toMatch(/stored designation/);
    expect(msg).toMatch(/confirmation text/);
    expect(msg).toMatch(/forbidden question fragment/);
  });

  test.each([
    [
      'dirty projection alone',
      (c) => {
        c.result.extracted_readings[0].value = DIRTY;
      },
    ],
    [
      'missing clean projection',
      (c) => {
        c.result.extracted_readings = [];
      },
    ],
    [
      'duplicate clean projection',
      (c) => {
        c.result.extracted_readings.push({ ...c.result.extracted_readings[0] });
      },
    ],
    [
      'raw circuit_designation name space scanned too',
      (c) => {
        c.result.extracted_readings.push({
          field: 'circuit_designation',
          circuit: 2,
          value: DIRTY,
        });
      },
    ],
    [
      'dirty legacy-shape circuit_updates projection',
      (c) => {
        c.result.circuit_updates = [{ circuit: 2, designation: DIRTY, action: 'create' }];
      },
    ],
    [
      'dirty post-turn stored state',
      (c) => {
        c.readCircuitDesignation = () => DIRTY;
      },
    ],
    [
      'missing stored state (null)',
      (c) => {
        c.readCircuitDesignation = () => null;
      },
    ],
    [
      'zero confirmations',
      (c) => {
        c.result.confirmations = [];
        c.logRows = [];
      },
    ],
    [
      'two confirmations',
      (c) => {
        c.result.confirmations.push({ ...c.result.confirmations[0] });
        c.logRows.push({ name: 'ios_send_attempt', meta: {} });
      },
    ],
    [
      'confirmation text mismatch (substring would false-pass)',
      (c) => {
        c.result.confirmations[0].text = DIRTY_CONF;
      },
    ],
    [
      'forbidden which-circuit ask emitted',
      (c) => {
        c.wsFrames = [
          { type: 'ask_user_started', tool_call_id: 'sym_srv_w', question: 'Which circuit is it?' },
        ];
      },
    ],
  ])('each corrupted leg fails under the SAME single id: %s', (_label, corrupt) => {
    const captured = greenCaptured();
    corrupt(captured);
    const failures = evaluateTurn(bareTurn(), captured);
    const ids = [...new Set(failures.map((f) => f.id))];
    expect(ids).toEqual(['designation_hygiene.op_x']);
  });

  test('board-scoped op compares the projection board; unscoped op ignores board', () => {
    const captured = greenCaptured();
    captured.result.extracted_readings[0].board_id = 'main';
    // Unscoped (board_id omitted) — matches regardless of projection board.
    expect(evaluateTurn(bareTurn(), captured)).toEqual([]);
    // Scoped to a DIFFERENT board — the clean projection no longer matches.
    const scoped = hygieneOp({ board_id: 'db-1' });
    const capturedScoped = greenCaptured();
    capturedScoped.result.extracted_readings[0].board_id = 'main';
    const failures = matchOperations([scoped], capturedScoped);
    expect(failures.map((f) => f.id)).toEqual(['designation_hygiene.op_x']);
  });

  test('missing injected state reader latches INFRASTRUCTURE — never a spurious pass/fail', () => {
    const captured = greenCaptured({ readCircuitDesignation: null });
    const failures = evaluateTurn(bareTurn(), captured);
    expect(failures).toHaveLength(1);
    expect(failures[0].outcome).toBe(OUTCOME.INFRASTRUCTURE);
    expect(failures[0].id).toBe('designation_hygiene.op_x');
    // INFRASTRUCTURE can never satisfy an expected_red.
    const fixture = {
      gate_state: 'expected_red',
      expected_failure_id: 'designation_hygiene.op_x',
    };
    expect(evaluateGateState(fixture, failures).verdict).toBe('infrastructure_error');
  });

  test('gate-state semantics: RED confirmed / XPASS / proof-mode bypass', () => {
    const redFixture = {
      gate_state: 'expected_red',
      expected_failure_id: 'designation_hygiene.op_x',
    };
    const dirtyFailures = evaluateTurn(bareTurn(), dirtyCaptured());
    expect(evaluateGateState(redFixture, dirtyFailures).verdict).toBe('pass'); // RED confirmed
    expect(evaluateGateState(redFixture, []).verdict).toBe('xpass'); // healed → must flip
    expect(evaluateGateState(redFixture, [], { proofState: 'required_green' }).verdict).toBe(
      'pass'
    );
    const greenFixture = { gate_state: 'required_green' };
    expect(evaluateGateState(greenFixture, []).verdict).toBe('pass');
    expect(evaluateGateState(greenFixture, dirtyFailures).verdict).toBe('fail');
  });
});

describe('END-TO-END through the REAL harness (committed fixture, fixed tree)', () => {
  test('frc_6600a62a… passes required_green: the dispatcher canonicalises the dirty create', async () => {
    const fixture = loadCommittedFixture();
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    expect(run.allFailures).toEqual([]);
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('pass');
  });

  test('a mismatched expectation REDs with EXACTLY the single joint id against real harness output', async () => {
    // Every leg disagrees with what the fixed dispatcher actually produced
    // ("Upstairs lighting") — yet the failure surface stays ONE id, which is
    // the entire reason the atomic type exists (a naive decomposition
    // produced a multi-id baseline that violated expected_failure_id).
    const fixture = loadCommittedFixture();
    fixture.turns[0].expected_operations[0].value = 'Upstairs lights';
    fixture.turns[0].expected_operations[0].confirmation_text_exact =
      'Circuit 2 is now the Upstairs lights';
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    const ids = [...new Set(run.allFailures.map((f) => f.id))];
    expect(ids).toEqual(['designation_hygiene.op_desig_cc']);
    expect(run.allFailures.every((f) => f.outcome === OUTCOME.FAIL)).toBe(true);
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('fail');
  });

  test('modules without the injected reader resolve infrastructure_error (fail-closed)', async () => {
    const fixture = loadCommittedFixture();
    const { readCircuitDesignation: _omit, ...withoutReader } = modules;
    const run = await runFixture({ fixture, modules: withoutReader, wallClockNowMs: Date.now() });
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('infrastructure_error');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Codex pre-merge additions: schema delimiter parity (item 3), oracle
// board-scoping (item 2), and the executable id-131 ingress lane (item 1).
// ───────────────────────────────────────────────────────────────────────────

describe('fixture-schema: banned-edge delimiter parity with the production canonicaliser', () => {
  test.each([
    ['comma-joined trailing token', 'lighting,circuit'],
    ['comma-joined leading token', 'Circuit,lighting'],
    ['period-joined trailing token', 'lighting.circuit'],
    ['parenthesised leading token', '(circuit) lighting'],
    ['bracketed trailing token', 'lighting [circuits]'],
  ])('rejects dirty expectation the whitespace split used to miss: %s', async (_label, value) => {
    const res = await validateFixtureDocument(
      schemaDoc(hygieneOp({ value, confirmation_text_exact: `Circuit 2 is now the ${value}` }))
    );
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(
      FIXTURE_ERROR_CODES.DESIGNATION_HYGIENE_BAD_SHAPE
    );
  });

  test('hyphen and slash stay NON-delimiters (compounds tokenise whole, matching production)', async () => {
    for (const value of ['Short-circuit tester', 'Ring/circuit sockets']) {
      const res = await validateFixtureDocument(
        schemaDoc(hygieneOp({ value, confirmation_text_exact: `Circuit 2 is now the ${value}` }))
      );
      expect(res.errors).toEqual([]);
    }
  });
});

describe('designation_hygiene oracle: board-scoping (same ref on two boards)', () => {
  // Ref 2 exists on BOTH boards with DISTINCT designations; the op targets
  // db-1. Every artefact carries its board so the exact predicate can bite.
  const DB1_CLEAN = 'Garage lighting';
  function twoBoardCaptured() {
    return greenCaptured({
      result: {
        extracted_readings: [
          { field: 'designation', circuit: 2, value: CLEAN, board_id: 'main' },
          { field: 'designation', circuit: 2, value: DB1_CLEAN, board_id: 'db-1' },
        ],
        circuit_updates: [
          { circuit: 2, designation: CLEAN, action: 'create', board_id: 'main' },
          { circuit: 2, designation: DB1_CLEAN, action: 'create', board_id: 'db-1' },
        ],
        confirmations: [
          {
            text: `Circuit 2 is now the ${CLEAN}`,
            field: 'circuit_op',
            circuit: 2,
            board_id: 'main',
          },
          {
            text: `Circuit 2 is now the ${DB1_CLEAN}`,
            field: 'circuit_op',
            circuit: 2,
            board_id: 'db-1',
          },
        ],
      },
      logRows: [
        { name: 'ios_send_attempt', meta: {} },
        { name: 'ios_send_attempt', meta: {} },
      ],
      readCircuitDesignation: (ref, boardId) => (boardId === 'db-1' ? DB1_CLEAN : CLEAN),
    });
  }

  test('a db-1-scoped op inspects ONLY db-1 artefacts — green despite main-board twins', () => {
    const op = hygieneOp({
      board_id: 'db-1',
      value: DB1_CLEAN,
      confirmation_text_exact: `Circuit 2 is now the ${DB1_CLEAN}`,
    });
    const failures = matchOperations([op], twoBoardCaptured());
    expect(failures).toEqual([]);
  });

  test('the OTHER board dirty does not leak into a scoped op; a scoped op DOES catch its own board dirty', () => {
    // main board dirty, db-1 clean → db-1-scoped op stays green.
    const captured = twoBoardCaptured();
    captured.result.circuit_updates[0].designation = DIRTY;
    captured.result.extracted_readings[0].value = DIRTY;
    captured.result.confirmations[0].text = DIRTY_CONF;
    const scoped = hygieneOp({
      board_id: 'db-1',
      value: DB1_CLEAN,
      confirmation_text_exact: `Circuit 2 is now the ${DB1_CLEAN}`,
    });
    expect(matchOperations([scoped], captured)).toEqual([]);
    // db-1 itself dirty → the scoped op fails under its single id.
    const captured2 = twoBoardCaptured();
    captured2.result.circuit_updates[1].designation = `${DB1_CLEAN} circuit`;
    const failures = matchOperations([scoped], captured2);
    expect([...new Set(failures.map((f) => f.id))]).toEqual(['designation_hygiene.op_x']);
  });

  test('confirmation counting is board-exact for a scoped op (no cross-board double-count)', () => {
    // Without the predicate BOTH same-ref confirmations would be counted
    // (count 2 → spurious fail) or a same-text twin could satisfy the wrong
    // board. With it, exactly db-1's one confirmation matches.
    const op = hygieneOp({
      board_id: 'db-1',
      value: DB1_CLEAN,
      confirmation_text_exact: `Circuit 2 is now the ${DB1_CLEAN}`,
    });
    const captured = twoBoardCaptured();
    // Same designation on both boards — the classic false-pass shape.
    captured.result.confirmations[0].text = `Circuit 2 is now the ${DB1_CLEAN}`;
    const failures = matchOperations([op], captured);
    // db-1's own confirmation still matches exactly once → no failure from
    // the count leg (the main twin is excluded by board, not by luck).
    expect(failures.filter((f) => f.message.includes('exactly one circuit_op'))).toEqual([]);
  });
});

describe('script_entry_resolution: schema shape (fail-closed)', () => {
  function irOp(overrides = {}) {
    return {
      operation_id: 'op_ir',
      kind: 'script_entry_resolution',
      family: 'insulation_resistance',
      circuit: 2,
      field: 'ir_live_live_mohm',
      value: 'LIM',
      next_ask_context_field: 'ir_live_earth_mohm',
      audibility: 'exactly_once',
      ...overrides,
    };
  }
  function irDoc(op = irOp(), turnOverrides = {}) {
    return {
      schema_version: 1,
      corpus_id: 'frc_00000000000000000000000000000012',
      purpose: 'regression',
      gate_state: 'required_green',
      red_proof_failure_id: `script_entry_resolution.${op.operation_id}`,
      owner: 'Derek Beckley',
      initial_state_fidelity: 'hand_authored',
      job_state: {
        certificateType: 'eicr',
        boards: [{ id: 'main', board_type: 'main' }],
        circuits: [{ number: 2, designation: 'Upstairs lighting circuit' }],
      },
      client_capabilities: { value: ['low_conf_readback_v1'], provenance: 'recorded_full' },
      fallback_to_legacy: { value: false, provenance: 'recorded_full' },
      turns: [
        {
          turn_index: 1,
          at_ms: 0,
          transcript: 'insulation resistance for upstairs lighting live to live is LIM.',
          regex_results: [],
          confirmations_enabled: { value: true, provenance: 'recorded_full' },
          in_response_to: { value: false, provenance: 'recorded_full' },
          ws_mode: 'open',
          chime_observed: true,
          dialogue_ingress: { family: 'insulation_resistance' },
          expected_operations: [op],
          ...turnOverrides,
        },
      ],
    };
  }

  test('the COMMITTED id-131 fixture document validates', async () => {
    const doc = yaml.load(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'tests/fixtures/field-replay-corpus/frc_db9ad2a81993be17a38cc196c7ac8ec5/fixture.yaml'
        ),
        'utf8'
      )
    );
    const res = await validateFixtureDocument(doc);
    expect(res.errors).toEqual([]);
  });

  test('a well-formed script_entry_resolution op on a dialogue_ingress turn validates', async () => {
    const res = await validateFixtureDocument(irDoc());
    expect(res.errors).toEqual([]);
  });

  test.each([
    ['missing family', { family: undefined }],
    ['missing field', { field: undefined }],
    ['missing value', { value: undefined }],
    ['missing next_ask_context_field', { next_ask_context_field: undefined }],
    ['circuits[] not allowed', { circuits: [2] }],
    ['null circuit', { circuit: null }],
    ['state_transition not allowed', { state_transition: 'clear_then_write' }],
    ['confirmation_text_exact not allowed', { confirmation_text_exact: 'x' }],
    ['audibility must be exactly_once', { audibility: 'derived_exempt' }],
  ])('rejects malformed shape: %s', async (_label, overrides) => {
    const res = await validateFixtureDocument(irDoc(irOp(overrides)));
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(
      FIXTURE_ERROR_CODES.SCRIPT_ENTRY_RESOLUTION_BAD_SHAPE
    );
  });

  test('op family must match the turn dialogue_ingress family', async () => {
    const doc = irDoc();
    delete doc.turns[0].dialogue_ingress;
    const res = await validateFixtureDocument(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(
      FIXTURE_ERROR_CODES.SCRIPT_ENTRY_RESOLUTION_BAD_SHAPE
    );
  });

  test('a dialogue_ingress turn must not declare model_rounds (the engine consumes the turn)', async () => {
    const doc = irDoc(irOp(), {
      model_rounds: [{ stop_reason: 'end_turn', text: '' }],
    });
    const res = await validateFixtureDocument(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(FIXTURE_ERROR_CODES.DIALOGUE_INGRESS_BAD_TURN);
  });

  test('entry resolution is state-dependent: prohibited under empty_fallback', async () => {
    const doc = irDoc();
    doc.initial_state_fidelity = 'empty_fallback';
    const res = await validateFixtureDocument(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain(
      FIXTURE_ERROR_CODES.EMPTY_FALLBACK_STATE_ASSERTION
    );
  });
});

describe('END-TO-END: the id-131 fixture through the REAL pre-harness engine (dialogue_ingress lane)', () => {
  const IR_FIXTURE_PATH = path.join(
    process.cwd(),
    'tests/fixtures/field-replay-corpus/frc_db9ad2a81993be17a38cc196c7ac8ec5/fixture.yaml'
  );
  const loadIrFixture = () => yaml.load(fs.readFileSync(IR_FIXTURE_PATH, 'utf8'));

  test('frc_db9ad2a8… passes required_green: entry resolves ref 2 through the dirty stored designation', async () => {
    const fixture = loadIrFixture();
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    expect(run.allFailures).toEqual([]);
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('pass');
  });

  test('a mismatched expectation REDs with EXACTLY the single joint id against real engine output', async () => {
    const fixture = loadIrFixture();
    fixture.turns[0].expected_operations[0].value = '299';
    fixture.turns[0].expected_operations[0].next_ask_context_field = 'ir_test_voltage_v';
    const run = await runFixture({ fixture, modules, wallClockNowMs: Date.now() });
    const ids = [...new Set(run.allFailures.map((f) => f.id))];
    expect(ids).toEqual(['script_entry_resolution.op_ir_entry']);
    expect(run.allFailures.every((f) => f.outcome === OUTCOME.FAIL)).toBe(true);
  });

  test('modules without the ingress runner resolve infrastructure_error (fail-closed, never a RED)', async () => {
    const fixture = loadIrFixture();
    const { dialogueScriptIngress: _omit, ...withoutIngress } = modules;
    const run = await runFixture({ fixture, modules: withoutIngress, wallClockNowMs: Date.now() });
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('infrastructure_error');
  });

  test('modules without readCircuitField/toReadingWireField latch INFRASTRUCTURE on the oracle', async () => {
    const fixture = loadIrFixture();
    const { readCircuitField: _a, toReadingWireField: _b, ...without } = modules;
    const run = await runFixture({ fixture, modules: without, wallClockNowMs: Date.now() });
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('infrastructure_error');
  });

  test('an ingress runner returning undefined (no throw) latches INFRASTRUCTURE — never RED (mini-review M5)', async () => {
    // A null/undefined return reports NOTHING about the turn: without the
    // latch, the semantic oracle would emit ordinary FAILs over the empty
    // capture and an invalid ingress premise could masquerade as the
    // expected RED. The sole classification must be infrastructure.
    const fixture = loadIrFixture();
    const withNullIngress = {
      ...modules,
      dialogueScriptIngress: { insulation_resistance: () => undefined },
    };
    const run = await runFixture({ fixture, modules: withNullIngress, wallClockNowMs: Date.now() });
    expect(run.allFailures.length).toBeGreaterThan(0);
    expect(run.allFailures.some((f) => f.outcome === OUTCOME.INFRASTRUCTURE)).toBe(true);
    expect(evaluateGateState(fixture, run.allFailures).verdict).toBe('infrastructure_error');
    // Never satisfiable as an expected_red — the RED-masquerade this closes.
    const asRed = {
      ...fixture,
      gate_state: 'expected_red',
      expected_failure_id: fixture.red_proof_failure_id,
    };
    expect(evaluateGateState(asRed, run.allFailures).verdict).toBe('infrastructure_error');
  });
});
