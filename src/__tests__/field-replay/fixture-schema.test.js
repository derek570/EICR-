/**
 * fixture-schema.test.js — structural + cross-field validation and the
 * gate_state machine (plan Item 1). Covers: gate-state field requirements,
 * ask_answers obligations + bounded answered offsets (just-before /
 * exactly-at / just-after ASK_USER_TIMEOUT_MS), backend reduced-tuple
 * matcher rule, postcode-hint prohibition, empty_fallback prohibitions,
 * prestate fail-closed, reconstructed_reviewed keystone restriction,
 * recent_circuit_order >3-circuits rule, legal/illegal transitions, and the
 * immutable projection (hash excludes gate_state + active
 * expected_failure_id, covers purpose + red_proof_failure_id).
 */

import {
  validateFixtureDocument,
  legalTransition,
  immutableProjection,
  FIXTURE_ERROR_CODES,
  ASK_USER_TIMEOUT_MS,
  CAPABILITY_EXCLUSIONS,
} from '../../../scripts/field-replay/lib/fixture-schema.mjs';
import { attestationPayloadHash } from '../../../scripts/field-replay/lib/canonical-crypto.mjs';

const CID = 'frc_0123456789abcdef0123456789abcdef';

function baseTurn(overrides = {}) {
  return {
    turn_index: 1,
    at_ms: 0,
    transcript: 'zed s naught point three five on circuit two',
    regex_results: [],
    confirmations_enabled: { value: true, provenance: 'recorded_full' },
    in_response_to: { value: false, provenance: 'recorded_full' },
    ws_mode: 'open',
    chime_observed: true,
    model_rounds: [
      {
        stop_reason: 'tool_use',
        tool_calls: [
          {
            id: 'sym_tc_1',
            name: 'record_reading',
            input: { field: 'measured_zs_ohm', circuit: 2, value: '0.35' },
            schema_expectation: 'accept',
            dispatcher_expectation: 'accept',
          },
        ],
      },
      { stop_reason: 'end_turn', text: '' },
    ],
    expected_operations: [
      {
        operation_id: 'op_1',
        kind: 'reading',
        tool: 'record_reading',
        field: 'measured_zs_ohm',
        circuit: 2,
        value: '0.35',
        audibility: 'exactly_once',
      },
    ],
    expected_audible_outputs: [
      {
        output_id: 'out_1',
        kind: 'reading_confirmation',
        operation_ref: 'op_1',
        count: 1,
        match: { field: 'measured_zs_ohm', circuit: 2, value: '0.35' },
      },
    ],
    ...overrides,
  };
}

function baseFixture(overrides = {}) {
  return {
    schema_version: 1,
    corpus_id: CID,
    purpose: 'regression',
    gate_state: 'expected_red',
    expected_failure_id: 'audibility.output.out_1',
    red_proof_failure_id: 'audibility.output.out_1',
    owner: 'Derek Beckley',
    introduced_at: '2026-07-16T00:00:00Z',
    fix_reference: 'fix_fedcba9876543210fedcba9876543210',
    expires_at: '2026-08-15T00:00:00Z',
    initial_state_fidelity: 'hand_authored',
    job_state: {
      certificateType: 'eicr',
      boards: [{ board_id: 'sym_board_main' }],
      circuits: [{ circuit_ref: '2' }],
    },
    turns: [baseTurn()],
    ...overrides,
  };
}

describe('structural + gate-state validation', () => {
  test('a well-formed expected_red regression fixture validates', async () => {
    const r = await validateFixtureDocument(baseFixture());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('expected_red missing expiry/owner/fix_reference fields rejects', async () => {
    const doc = baseFixture();
    delete doc.expires_at;
    delete doc.fix_reference;
    const r = await validateFixtureDocument(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.EXPECTED_RED_MISSING_FIELDS)).toBe(
      true
    );
  });

  test('active expected_failure_id must equal red_proof_failure_id', async () => {
    const doc = baseFixture({ expected_failure_id: 'some.other.assertion' });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.EXPECTED_FAILURE_ID_MISMATCH)).toBe(
      true
    );
  });

  test('a triage fixture is never expected_red', async () => {
    const doc = baseFixture({ purpose: 'triage' });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.TRIAGE_WITH_FAILURE_ID)).toBe(true);
  });

  test('triage fixture admitted directly required_green (no failure ids) validates', async () => {
    const doc = baseFixture({
      purpose: 'triage',
      gate_state: 'required_green',
    });
    delete doc.expected_failure_id;
    delete doc.red_proof_failure_id;
    const r = await validateFixtureDocument(doc);
    expect(r.errors).toEqual([]);
  });

  test('regression fixture admitted directly required_green needs red_proof_failure_id (dual-proof rule)', async () => {
    const doc = baseFixture({ gate_state: 'required_green' });
    delete doc.expected_failure_id;
    delete doc.red_proof_failure_id;
    const r = await validateFixtureDocument(doc);
    expect(
      r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.GREEN_REGRESSION_MISSING_RED_PROOF)
    ).toBe(true);
    // With the red proof present it validates.
    const doc2 = baseFixture({ gate_state: 'required_green' });
    delete doc2.expected_failure_id;
    const r2 = await validateFixtureDocument(doc2);
    expect(r2.errors).toEqual([]);
  });

  test('required_green with an ACTIVE expected_failure_id rejects', async () => {
    const doc = baseFixture({ gate_state: 'required_green' });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.EXPECTED_FAILURE_ID_MISMATCH)).toBe(
      true
    );
  });

  test('unsupported_pending requires exclusion/owner/followup/transcript/expectations but allows absent model_rounds', async () => {
    const doc = {
      schema_version: 1,
      corpus_id: CID,
      purpose: 'regression',
      gate_state: 'unsupported_pending',
      owner: 'Derek Beckley',
      capability_exclusion: 'loaded_barrel',
      named_followup: 'field-replay-hardening-followups',
      sanitized_transcript: ['some sanitized turn text'],
      human_expectations: 'should read back once when Loaded Barrel replay exists',
    };
    const r = await validateFixtureDocument(doc);
    expect(r.errors).toEqual([]);
    const missing = { ...doc };
    delete missing.named_followup;
    const r2 = await validateFixtureDocument(missing);
    expect(
      r2.errors.some((e) => e.code === FIXTURE_ERROR_CODES.UNSUPPORTED_PENDING_MISSING_FIELDS)
    ).toBe(true);
  });

  test('superseded and privacy_quarantined require tombstones; quarantine may not claim erasure', async () => {
    const sup = baseFixture({ gate_state: 'superseded' });
    delete sup.expected_failure_id;
    const r = await validateFixtureDocument(sup);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.TOMBSTONE_MISSING_FIELDS)).toBe(
      true
    );

    const q = baseFixture({
      gate_state: 'privacy_quarantined',
      tombstone: {
        quarantine_reason: 'post-merge discovery of sensitive content',
        reviewer: 'Derek Beckley',
        replacement_corpus_id: 'frc_fedcba9876543210fedcba9876543210',
        prior_attestation_hash: 'a'.repeat(64),
        note: 'sensitive payload deleted from git history and gone forever',
      },
    });
    delete q.expected_failure_id;
    const r2 = await validateFixtureDocument(q);
    expect(r2.errors.some((e) => e.code === FIXTURE_ERROR_CODES.QUARANTINE_CLAIMS_ERASURE)).toBe(
      true
    );
  });

  test('bad corpus id and inadmissible fix_reference reject', async () => {
    const doc = baseFixture({
      corpus_id: 'field-2026-07-16-f1',
      fix_reference: '~/.claude/handoffs/plan/PLAN.md',
    });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.BAD_CORPUS_ID)).toBe(true);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.BAD_FIX_REFERENCE)).toBe(true);
  });
});

describe('ask_answers obligations', () => {
  function fixtureWithAsk(askAnswers, askCall = {}) {
    const turn = baseTurn();
    turn.model_rounds[0].tool_calls.push({
      id: 'sym_tc_ask',
      name: 'ask_user',
      input: { question: 'Which circuit was that reading for?' },
      schema_expectation: 'accept',
      dispatcher_expectation: 'accept',
      ...askCall,
    });
    turn.ask_answers = askAnswers;
    return baseFixture({ turns: [turn] });
  }

  test('an injected blocking ask with NO declaration fails validation BEFORE execution', async () => {
    const r = await validateFixtureDocument(fixtureWithAsk([]));
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.ASK_UNANSWERED)).toBe(true);
  });

  test('a deterministic answer satisfies the obligation', async () => {
    const r = await validateFixtureDocument(
      fixtureWithAsk([
        {
          match: { tool_call_id: 'sym_tc_ask' },
          answer_channel: 'pending_registry',
          answer: { answered: true, user_text: 'Circuit two.' },
          at_ms_after_ask: 1200,
        },
      ])
    );
    expect(r.errors).toEqual([]);
  });

  test('answered offsets bounded: just-before passes, exactly-at and just-after reject (timeout-wins)', async () => {
    const mk = (offset) =>
      fixtureWithAsk([
        {
          match: { tool_call_id: 'sym_tc_ask' },
          answer_channel: 'pending_registry',
          answer: { answered: true, user_text: 'Circuit two.' },
          at_ms_after_ask: offset,
        },
      ]);
    const before = await validateFixtureDocument(mk(ASK_USER_TIMEOUT_MS - 1));
    expect(before.errors).toEqual([]);
    const at = await validateFixtureDocument(mk(ASK_USER_TIMEOUT_MS));
    expect(
      at.errors.some((e) => e.code === FIXTURE_ERROR_CODES.ASK_ANSWER_OFFSET_OUT_OF_RANGE)
    ).toBe(true);
    const after = await validateFixtureDocument(mk(ASK_USER_TIMEOUT_MS + 1));
    expect(
      after.errors.some((e) => e.code === FIXTURE_ERROR_CODES.ASK_ANSWER_OFFSET_OUT_OF_RANGE)
    ).toBe(true);
  });

  test('terminal channel requires a bounded terminal_outcome', async () => {
    const r = await validateFixtureDocument(
      fixtureWithAsk([{ match: { tool_call_id: 'sym_tc_ask' }, answer_channel: 'terminal' }])
    );
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.ASK_BAD_TERMINAL)).toBe(true);
  });

  test('a declared-rejected ask needs no answer (immediate tool-result outcome)', async () => {
    const r = await validateFixtureDocument(
      fixtureWithAsk([], {
        dispatcher_expectation: 'reject',
        dispatcher_reject_code: 'validation_error',
      })
    );
    expect(r.errors).toEqual([]);
  });

  test('backend-generated asks may match ONLY on the reduced tuple', async () => {
    const turn = baseTurn();
    turn.ask_answers = [
      {
        match: {
          origin: 'backend',
          reason: 'observation_confirmation',
          context_field: 'observation_clarify',
        },
        answer_channel: 'pending_registry',
        answer: { answered: true, user_text: 'It was the socket by the sink.' },
      },
    ];
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.ASK_BACKEND_RICH_MATCHER)).toBe(
      true
    );
    // Reduced tuple passes.
    turn.ask_answers[0].match = { origin: 'backend', context_field: 'observation_clarify' };
    const r2 = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r2.errors).toEqual([]);
  });
});

describe('capability exclusions + fidelity rules', () => {
  test('the v1 exclusion set is pinned', () => {
    expect(CAPABILITY_EXCLUSIONS).toEqual([
      'ingress',
      'post_harness_egress',
      'loaded_barrel',
      'postcode_lookup',
      'watchdog_cancellation',
      'dialogue_answer_ingress',
    ]);
  });

  test('postcode-lookup hints are rejected before any extraction import', async () => {
    const turn = baseTurn({ regex_results: [{ field: 'install.postcode', value: 'ZZ99 9ZZ' }] });
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.POSTCODE_HINT_FORBIDDEN)).toBe(true);
  });

  test('empty_fallback prohibits state-dependent blocking assertions', async () => {
    const turn = baseTurn();
    turn.expected_operations = [
      { operation_id: 'op_upd', kind: 'observation_update', audibility: 'exactly_once' },
    ];
    turn.expected_audible_outputs = [];
    const doc = baseFixture({ initial_state_fidelity: 'empty_fallback', turns: [turn] });
    const r = await validateFixtureDocument(doc);
    expect(
      r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.EMPTY_FALLBACK_STATE_ASSERTION)
    ).toBe(true);
  });

  test('expected operations referencing circuits absent from job_state reject', async () => {
    const turn = baseTurn();
    turn.expected_operations[0].circuit = 7;
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.STATE_DEP_MISSING)).toBe(true);
  });

  test('outbound options must carry provenance; reconstructed_reviewed only on keystones', async () => {
    const turn = baseTurn();
    delete turn.confirmations_enabled;
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.PROVENANCE_MISSING)).toBe(true);

    const turn2 = baseTurn({
      confirmations_enabled: { value: true, provenance: 'reconstructed_reviewed' },
    });
    const nonKeystone = await validateFixtureDocument(baseFixture({ turns: [turn2] }));
    expect(
      nonKeystone.errors.some((e) => e.code === FIXTURE_ERROR_CODES.PROVENANCE_RESTRICTED)
    ).toBe(true);
    const keystone = await validateFixtureDocument(
      baseFixture({ turns: [turn2], is_keystone: true })
    );
    expect(keystone.errors).toEqual([]);
  });

  // ── P4 (ask-decline-ack-net 2026-07-23) — field_null_fallback relaxation ──
  // The §A4-drained field-null ack (marker-①/②/F7 apologies AND the P4
  // decline-ack) is TOKENLESS, so a non-empty trimmed text_exact is a
  // sufficient oracle on its own; a fabricated token would then FAIL the
  // runtime match against the tokenless wire ack. An empty/whitespace text_exact
  // still provides no meaningful oracle and stays rejected.
  function fnfTurn(match) {
    // A turn whose sole audible output is a field_null_fallback ack — no
    // expected_operations (the answered-decline produces no write), and the
    // ack is a declared-silence-adjacent field-nil confirmation.
    return baseTurn({
      model_rounds: [{ stop_reason: 'end_turn', text: '' }],
      expected_operations: [],
      expected_audible_outputs: [
        { output_id: 'out_ack', kind: 'field_null_fallback', count: 1, match },
      ],
    });
  }

  test('field_null_fallback with a non-empty trimmed text_exact ALONE (no token) VALIDATES', async () => {
    const turn = fnfTurn({ text_exact: 'No problem, moving on.' });
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    // No SCHEMA error for the field_null_fallback matcher (a token is no longer
    // required). Other structural checks are unaffected.
    expect(
      r.errors.some(
        (e) => e.code === FIXTURE_ERROR_CODES.SCHEMA && /field_null_fallback/.test(e.message ?? '')
      )
    ).toBe(false);
  });

  test('field_null_fallback with a token AND a non-empty text_exact still VALIDATES (token ignored, not required)', async () => {
    const turn = fnfTurn({ text_exact: 'Okay — leaving that one.', dedupe_token: 'tok_ignored' });
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(
      r.errors.some(
        (e) => e.code === FIXTURE_ERROR_CODES.SCHEMA && /field_null_fallback/.test(e.message ?? '')
      )
    ).toBe(false);
  });

  test('field_null_fallback with an EMPTY text_exact is REJECTED (no meaningful oracle)', async () => {
    const turn = fnfTurn({ text_exact: '' });
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(
      r.errors.some(
        (e) => e.code === FIXTURE_ERROR_CODES.SCHEMA && /field_null_fallback/.test(e.message ?? '')
      )
    ).toBe(true);
  });

  test('field_null_fallback with a WHITESPACE-ONLY text_exact is REJECTED (even with a token)', async () => {
    const turn = fnfTurn({ text_exact: '   ', dedupe_token: 'tok_present' });
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(
      r.errors.some(
        (e) => e.code === FIXTURE_ERROR_CODES.SCHEMA && /field_null_fallback/.test(e.message ?? '')
      )
    ).toBe(true);
  });

  test('field_null_fallback with a non-STRING text_exact is REJECTED', async () => {
    const turn = fnfTurn({ dedupe_token: 'tok_present' }); // no text_exact at all
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(
      r.errors.some(
        (e) => e.code === FIXTURE_ERROR_CODES.SCHEMA && /field_null_fallback/.test(e.message ?? '')
      )
    ).toBe(true);
  });

  test('Codex r1: field_null_fallback with a PADDED text_exact (leading/trailing whitespace) is REJECTED (unsatisfiable against the trimmed candidate)', async () => {
    // Runtime confirmationMatches trims the candidate confirmation text and
    // compares it to the RAW matcher, so a padded text_exact validates yet can
    // never turn green. Both leading- and trailing-padded values must reject.
    for (const padded of [
      ' No problem, moving on.',
      'No problem, moving on. ',
      '\tNo problem, moving on.',
    ]) {
      const turn = fnfTurn({ text_exact: padded });
      const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
      expect(
        r.errors.some(
          (e) =>
            e.code === FIXTURE_ERROR_CODES.SCHEMA && /field_null_fallback/.test(e.message ?? '')
        )
      ).toBe(true);
    }
  });

  test('executable fixture fails CLOSED on mid-session start OR any prestate block (prestate/warm-up are NOT applied)', async () => {
    // A mid-session first turn needs state the runner never fast-forwards.
    const midSession = await validateFixtureDocument(
      baseFixture({ turns: [baseTurn({ turn_index: 9 })] })
    );
    expect(midSession.errors.some((e) => e.code === FIXTURE_ERROR_CODES.PRESTATE_UNKNOWN)).toBe(
      true
    );

    // A prestate block — including warm_up_turns — is REJECTED, not satisfied:
    // the runner applies neither, so admitting it would replay against wrong
    // state. Seed via job_state + real preceding turns instead.
    const withPrestate = await validateFixtureDocument(
      baseFixture({
        turns: [baseTurn({ turn_index: 1 })],
        prestate: { warm_up_turns: [{ transcript: 'warm up', at_ms: 0 }] },
      })
    );
    expect(withPrestate.errors.some((e) => e.code === FIXTURE_ERROR_CODES.PRESTATE_UNKNOWN)).toBe(
      true
    );
  });

  test('>3 circuits requires provenance-backed recent order or warm-up turns', async () => {
    const doc = baseFixture({
      job_state: {
        certificateType: 'eicr',
        boards: [],
        circuits: [
          { circuit_ref: '1' },
          { circuit_ref: '2' },
          { circuit_ref: '3' },
          { circuit_ref: '4' },
        ],
      },
    });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.RECENT_ORDER_MISSING)).toBe(true);
    const withOrder = await validateFixtureDocument({
      ...doc,
      recent_circuit_order: { value: ['4', '2', '1'], provenance: 'recorded_full' },
    });
    expect(withOrder.errors).toEqual([]);
  });

  test('duplicate tool_call ids across rounds are rejected (unique-id invariant)', async () => {
    const turn = baseTurn();
    // A second round reusing the SAME tool_call id — the real model never does
    // this, and the matcher correlates evidence by id.
    turn.model_rounds.unshift({
      stop_reason: 'tool_use',
      tool_calls: [
        {
          id: 'sym_tc_1',
          name: 'record_reading',
          input: {},
          schema_expectation: 'accept',
          dispatcher_expectation: 'accept',
        },
      ],
    });
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r.errors.some((e) => /duplicate tool_call id/.test(e.message))).toBe(true);
  });

  test('schema/dispatcher reject expectations require bounded error codes', async () => {
    const turn = baseTurn();
    turn.model_rounds[0].tool_calls[0].schema_expectation = 'reject';
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(
      r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.SCHEMA_EXPECTATION_MISSING_CODE)
    ).toBe(true);
  });

  test('field_null_fallback outputs require byte-exact text + token/key', async () => {
    const turn = baseTurn();
    turn.expected_audible_outputs = [
      { output_id: 'out_fb', kind: 'field_null_fallback', count: 1, match: {} },
    ];
    const r = await validateFixtureDocument(baseFixture({ turns: [turn] }));
    expect(r.errors.some((e) => e.code === FIXTURE_ERROR_CODES.SCHEMA)).toBe(true);
  });
});

describe('gate_state machine', () => {
  test('expected_red → required_green is legal', () => {
    expect(legalTransition('expected_red', 'required_green').ok).toBe(true);
  });
  test('unsupported_pending → expected_red requires a new attestation', () => {
    expect(legalTransition('unsupported_pending', 'expected_red', {}).ok).toBe(false);
    expect(
      legalTransition('unsupported_pending', 'expected_red', { newAttestation: true }).ok
    ).toBe(true);
  });
  test('unsupported_pending → required_green requires the dual RED+GREEN proof', () => {
    expect(
      legalTransition('unsupported_pending', 'required_green', { newAttestation: true }).ok
    ).toBe(false);
    expect(
      legalTransition('unsupported_pending', 'required_green', {
        newAttestation: true,
        redEvidenceAgainstPreFix: true,
        greenEvidenceAgainstFixingSubject: true,
      }).ok
    ).toBe(true);
  });
  test('required_green → superseded requires reviewed supersession', () => {
    expect(legalTransition('required_green', 'superseded', {}).ok).toBe(false);
    expect(legalTransition('required_green', 'superseded', { reviewedSupersession: true }).ok).toBe(
      true
    );
  });
  test('* → privacy_quarantined requires a governance event', () => {
    expect(legalTransition('expected_red', 'privacy_quarantined', {}).ok).toBe(false);
    expect(
      legalTransition('required_green', 'privacy_quarantined', { quarantineGovernanceEvent: true })
        .ok
    ).toBe(true);
  });
  test('everything else is illegal (incl. required_green → expected_red)', () => {
    expect(legalTransition('required_green', 'expected_red').ok).toBe(false);
    expect(legalTransition('expected_red', 'unsupported_pending').ok).toBe(false);
    expect(legalTransition('superseded', 'required_green').ok).toBe(false);
  });
});

describe('immutable projection', () => {
  test('excludes gate_state + active expected_failure_id; covers purpose + red_proof_failure_id', () => {
    const doc = baseFixture();
    const proj = immutableProjection(doc);
    expect(proj.gate_state).toBeUndefined();
    expect(proj.expected_failure_id).toBeUndefined();
    expect(proj.purpose).toBe('regression');
    expect(proj.red_proof_failure_id).toBe('audibility.output.out_1');
  });
  test('the GREEN flip does not change the immutable hash; a payload edit does', () => {
    const red = baseFixture();
    const green = baseFixture({ gate_state: 'required_green' });
    delete green.expected_failure_id;
    expect(attestationPayloadHash(immutableProjection(red))).toBe(
      attestationPayloadHash(immutableProjection(green))
    );
    const tampered = baseFixture();
    tampered.turns[0].transcript = 'edited transcript';
    expect(attestationPayloadHash(immutableProjection(red))).not.toBe(
      attestationPayloadHash(immutableProjection(tampered))
    );
  });
});

// ---------------------------------------------------------------------------
// P5 (2026-07-23) — clear_then_write op shape (marker T10)
// ---------------------------------------------------------------------------

describe('P5 — clear_then_write state_transition op validation', () => {
  // A fixture whose sole op is a clear_then_write reading. board_id must be
  // null or the seeded board (the STATE_DEP check gates board_id); clear_board_id
  // is not state-checked.
  function ctwFixture(opOverrides = {}, fixtureOverrides = {}) {
    const op = {
      operation_id: 'op_ctw',
      kind: 'reading',
      field: 'ir_live_live_mohm',
      circuit: '2',
      value: '100',
      board_id: null,
      clear_board_id: null,
      state_transition: 'clear_then_write',
      audibility: 'exactly_once',
      ...opOverrides,
    };
    return baseFixture({
      expected_failure_id: 'reading.op_ctw',
      red_proof_failure_id: 'reading.op_ctw',
      turns: [baseTurn({ expected_operations: [op], expected_audible_outputs: [] })],
      ...fixtureOverrides,
    });
  }

  test('a well-formed clear_then_write op validates', async () => {
    const r = await validateFixtureDocument(ctwFixture());
    expect(r.errors).toEqual([]);
  });

  test('null/null and explicit board spellings both validate (same effective board)', async () => {
    for (const [board_id, clear_board_id] of [
      [null, null],
      ['sym_board_main', null],
      [null, 'sym_board_main'],
      ['sym_board_main', 'sym_board_main'],
    ]) {
      const r = await validateFixtureDocument(ctwFixture({ board_id, clear_board_id }));
      expect(r.errors).toEqual([]);
    }
  });

  const badShapes = [
    ['kind not reading', { kind: 'board_reading' }],
    ['missing value', (op) => delete op.value],
    ['empty field', { field: '' }],
    ['null circuit', { circuit: null }],
    ['circuits[] present', { circuits: ['2', '3'] }],
    ['missing board_id', (op) => delete op.board_id],
    ['missing clear_board_id', (op) => delete op.clear_board_id],
  ];
  for (const [name, mut] of badShapes) {
    test(`rejects clear_then_write: ${name}`, async () => {
      const op = {
        operation_id: 'op_ctw',
        kind: 'reading',
        field: 'ir_live_live_mohm',
        circuit: '2',
        value: '100',
        board_id: null,
        clear_board_id: null,
        state_transition: 'clear_then_write',
        audibility: 'exactly_once',
      };
      if (typeof mut === 'function') mut(op);
      else Object.assign(op, mut);
      const doc = baseFixture({
        expected_failure_id: 'reading.op_ctw',
        red_proof_failure_id: 'reading.op_ctw',
        turns: [baseTurn({ expected_operations: [op], expected_audible_outputs: [] })],
      });
      const r = await validateFixtureDocument(doc);
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain(FIXTURE_ERROR_CODES.CLEAR_THEN_WRITE_BAD_SHAPE);
    });
  }

  test('rejects a non-string/non-null board_id or clear_board_id (schema type)', async () => {
    for (const key of ['board_id', 'clear_board_id']) {
      const r = await validateFixtureDocument(ctwFixture({ [key]: 5 }));
      expect(r.errors.length).toBeGreaterThan(0);
      // Ajv structural (type: [string, null]) rejects a number before the
      // cross-field check runs — either way it is not admitted.
      expect(r.errors.map((e) => e.code)).toContain(FIXTURE_ERROR_CODES.SCHEMA);
    }
  });

  test('an unknown state_transition value is rejected by the enum (schema)', async () => {
    const doc = ctwFixture({ state_transition: 'write_then_clear' });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.map((e) => e.code)).toContain(FIXTURE_ERROR_CODES.SCHEMA);
  });

  test('empty_fallback still prohibits a clear_then_write op (state-dependent)', async () => {
    const doc = ctwFixture({}, { initial_state_fidelity: 'empty_fallback' });
    const r = await validateFixtureDocument(doc);
    expect(r.errors.map((e) => e.code)).toContain(
      FIXTURE_ERROR_CODES.EMPTY_FALLBACK_STATE_ASSERTION
    );
  });
});
