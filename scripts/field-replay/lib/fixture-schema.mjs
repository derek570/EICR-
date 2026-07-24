/**
 * fixture-schema.mjs — structural schema + cross-field validation for
 * field-replay corpus fixtures (plan Item 1 "Fixture schema per turn" +
 * gate_state machine + v1 capability exclusions).
 *
 * Layers:
 *   1. Ajv structural schema (Ajv 8, `{allErrors:true, strict:false,
 *      allowUnionTypes:true}` — the REAL production tool schemas contain
 *      union types like `type: ['integer','null']`, which Ajv-8 strict
 *      defaults reject; the same constructor config is used everywhere).
 *   2. Named cross-field rules (bounded error codes) that Ajv can't express:
 *      gate-state requirements, ask_answers obligations, capability
 *      exclusions, empty_fallback prohibitions, state-dependency checks,
 *      provenance restrictions.
 *
 * The gate_state machine is ONE state machine (see legalTransition):
 *   expected_red → required_green
 *   unsupported_pending → expected_red          (payload-changing promotion)
 *   unsupported_pending → required_green        (dual RED+GREEN proof only)
 *   required_green → superseded                 (policy change)
 *   * → privacy_quarantined                     (execution containment)
 * `superseded` and `privacy_quarantined` are validate-but-never-execute
 * states with required tombstone fields.
 */

import { OPAQUE_REF_CLASSES } from './identity-constants.mjs';
import { validateFixReference, validateOpaqueRef } from './id-validation.mjs';

/** Production ask timeout — answered `at_ms_after_ask` must be < this
 *  (at/beyond, the earlier-registered production timeout fires FIRST, so an
 *  "answered" annotation would silently exercise a timeout; exact equality
 *  is defined TIMEOUT-WINS, matching timer registration order). */
export const ASK_USER_TIMEOUT_MS = 45000;

export const GATE_STATES = Object.freeze([
  'expected_red',
  'required_green',
  'unsupported_pending',
  'superseded',
  'privacy_quarantined',
]);

/** v1 capability exclusions — fixtures depending on any of these are
 *  non-executable (`unsupported_pending`) until the named follow-up lands. */
export const CAPABILITY_EXCLUSIONS = Object.freeze([
  'ingress', // pre-harness: pre-LLM gate, queue/overtake, regex fallback, envelope derivation
  'post_harness_egress', // sonnet-stream validateAndCorrectFields / extraction envelope / field_corrected ordering
  'loaded_barrel', // speculator disabled in BOTH lanes (v1 fidelity exclusion)
  'postcode_lookup', // lookupPostcode network path — prohibition, no stub in v1
  'watchdog_cancellation', // fixture-controlled cancellation triggers do not exist in v1
  'dialogue_answer_ingress', // srv-* ANSWER processing lives in excluded ingress
]);

export const TERMINAL_ASK_OUTCOMES = Object.freeze([
  'timeout',
  'session_terminated',
  'session_stopped',
  'session_reconnected',
]);

export const ANSWER_CHANNELS = Object.freeze([
  'pending_registry',
  'next_transcript',
  'terminal',
]);

export const PROVENANCE_KINDS = Object.freeze([
  'recorded_full',
  'reconstructed',
  'reconstructed_reviewed',
  'canonical',
]);

export const WS_MODES = Object.freeze(['open', 'closed', 'throw_on_send']);

export const AUDIBLE_OUTPUT_KINDS = Object.freeze([
  'reading_confirmation',
  'state_confirmation',
  'ask_user',
  'field_null_fallback',
]);

export const ADVISORY_LIFECYCLES = Object.freeze(['known_red', 'monitor', 'green_evidence']);

/** Bounded cross-field error codes (tests pin these). */
export const FIXTURE_ERROR_CODES = Object.freeze({
  SCHEMA: 'schema_invalid',
  BAD_CORPUS_ID: 'bad_corpus_id',
  BAD_FIX_REFERENCE: 'bad_fix_reference',
  EXPECTED_RED_MISSING_FIELDS: 'expected_red_missing_fields',
  EXPECTED_FAILURE_ID_MISMATCH: 'expected_failure_id_mismatch',
  TRIAGE_WITH_FAILURE_ID: 'triage_with_failure_id',
  GREEN_REGRESSION_MISSING_RED_PROOF: 'green_regression_missing_red_proof',
  UNSUPPORTED_PENDING_MISSING_FIELDS: 'unsupported_pending_missing_fields',
  TOMBSTONE_MISSING_FIELDS: 'tombstone_missing_fields',
  QUARANTINE_CLAIMS_ERASURE: 'quarantine_claims_erasure',
  ASK_UNANSWERED: 'ask_missing_answer_or_terminal',
  ASK_ANSWER_OFFSET_OUT_OF_RANGE: 'ask_answer_offset_out_of_range',
  ASK_BACKEND_RICH_MATCHER: 'ask_backend_generated_rich_matcher',
  ASK_BAD_TERMINAL: 'ask_bad_terminal_outcome',
  CAPABILITY_EXCLUDED: 'capability_excluded_dependency',
  POSTCODE_HINT_FORBIDDEN: 'postcode_hint_forbidden',
  EMPTY_FALLBACK_STATE_ASSERTION: 'empty_fallback_state_dependent_assertion',
  STATE_DEP_MISSING: 'state_dependency_missing',
  PRESTATE_UNKNOWN: 'prestate_unknown',
  PROVENANCE_RESTRICTED: 'provenance_reconstructed_reviewed_restricted',
  PROVENANCE_MISSING: 'provenance_missing',
  SCHEMA_EXPECTATION_MISSING_CODE: 'schema_expectation_missing_code',
  DUPLICATE_OPERATION_ID: 'duplicate_operation_id',
  DUPLICATE_OUTPUT_ID: 'duplicate_output_id',
  RECENT_ORDER_MISSING: 'recent_circuit_order_missing',
  ORPHAN_NET_UNATTESTED: 'orphan_net_dependency_unattested',
  CLEAR_THEN_WRITE_BAD_SHAPE: 'clear_then_write_bad_shape',
});

/** Ajv structural schema for fixture.yaml. */
export const FIXTURE_JSON_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'corpus_id', 'purpose', 'gate_state', 'owner'],
  additionalProperties: false,
  properties: {
    schema_version: { const: 1 },
    corpus_id: { type: 'string' },
    purpose: { enum: ['regression', 'triage'] },
    gate_state: { enum: [...GATE_STATES] },
    expected_failure_id: { type: 'string' },
    red_proof_failure_id: { type: 'string' },
    owner: { type: 'string', minLength: 1 },
    introduced_at: { type: 'string' },
    fix_reference: { type: 'string' },
    expires_at: { type: 'string' },
    capability_exclusion: { enum: [...CAPABILITY_EXCLUSIONS] },
    named_followup: { type: 'string' },
    sanitized_transcript: { type: 'array', items: { type: 'string' } },
    human_expectations: { type: 'string' },
    tombstone: {
      type: 'object',
      additionalProperties: false,
      properties: {
        replacement_corpus_id: { type: 'string' },
        policy_change_reference: { type: 'string' },
        quarantine_reason: { type: 'string' },
        reviewer: { type: 'string' },
        prior_attestation_hash: { type: 'string' },
        note: { type: 'string' },
      },
    },
    initial_state_fidelity: { enum: ['hand_authored', 'empty_fallback'] },
    job_state: {
      type: 'object',
      additionalProperties: true,
      properties: {
        boards: { type: 'array' },
        circuits: { type: 'array' },
        observations: { type: 'array' },
        certificateType: { enum: ['eicr', 'eic'] },
      },
    },
    prestate: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turn_count: { $ref: '#/$defs/provenancedScalar' },
        ask_budget: { $ref: '#/$defs/provenancedValue' },
        confirmation_debounce_state: { $ref: '#/$defs/provenancedValue' },
        obs_clarify_chains: { $ref: '#/$defs/provenancedValue' },
        readback_window: { $ref: '#/$defs/provenancedValue' },
        orphan_context: { $ref: '#/$defs/provenancedValue' },
        dialogue_state: { $ref: '#/$defs/provenancedValue' },
        warm_up_turns: { type: 'array' },
      },
    },
    client_capabilities: { $ref: '#/$defs/provenancedValue' },
    fallback_to_legacy: { $ref: '#/$defs/provenancedScalar' },
    recent_circuit_order: { $ref: '#/$defs/provenancedValue' },
    turns: { type: 'array', items: { $ref: '#/$defs/turn' } },
    input_provenance: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['provenance'],
        additionalProperties: false,
        properties: {
          provenance: { enum: [...PROVENANCE_KINDS] },
          ref: { type: 'string' },
        },
      },
    },
    live_lane: {
      type: 'object',
      required: ['enabled'],
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        assertions: { type: 'array', items: { type: 'object' } },
        hard_max_vendor_calls: { type: 'integer', minimum: 1 },
        warn_max_actual_tokens: { type: 'object' },
        advisory_lifecycle: { enum: [...ADVISORY_LIFECYCLES] },
        shard: { type: 'integer', minimum: 0 },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'role', 'commitment'],
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          role: { enum: ['primary', 'supporting'] },
          commitment: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          source_priority: { type: 'integer', minimum: 0 },
        },
      },
    },
    is_keystone: { type: 'boolean' },
    notes: { type: 'string' },
  },
  $defs: {
    provenancedScalar: {
      type: 'object',
      required: ['value', 'provenance'],
      additionalProperties: false,
      properties: {
        value: { type: ['string', 'number', 'boolean', 'null'] },
        provenance: { enum: [...PROVENANCE_KINDS] },
        ref: { type: 'string' },
      },
    },
    provenancedValue: {
      type: 'object',
      required: ['value', 'provenance'],
      additionalProperties: false,
      properties: {
        value: {},
        provenance: { enum: [...PROVENANCE_KINDS] },
        ref: { type: 'string' },
      },
    },
    toolCall: {
      type: 'object',
      required: ['id', 'name', 'input', 'schema_expectation', 'dispatcher_expectation'],
      additionalProperties: false,
      properties: {
        // Harness metadata are SIBLINGS of `input`, never inside it — the
        // production tool schemas are additionalProperties:false, so embedded
        // metadata would make valid calls schema-invalid and leak into the
        // dispatcher. ONLY `input` reaches toolUseRound / the mock stream.
        id: { type: 'string' },
        name: { type: 'string' },
        input: { type: 'object' },
        schema_expectation: { enum: ['accept', 'reject'] },
        schema_reject_code: { type: 'string' },
        dispatcher_expectation: { enum: ['accept', 'reject'] },
        dispatcher_reject_code: { type: 'string' },
        input_provenance_ref: { type: 'string' },
      },
    },
    modelRound: {
      type: 'object',
      required: ['stop_reason'],
      additionalProperties: false,
      properties: {
        stop_reason: { enum: ['tool_use', 'end_turn'] },
        text: { type: 'string' },
        tool_calls: { type: 'array', items: { $ref: '#/$defs/toolCall' } },
      },
    },
    branch: {
      type: 'object',
      required: ['branch_id', 'when', 'rounds'],
      additionalProperties: false,
      properties: {
        branch_id: { type: 'string' },
        when: { enum: ['no_interceptor_ask_observed', 'interceptor_ask_answered'] },
        rounds: { type: 'array', items: { $ref: '#/$defs/modelRound' } },
        substitutions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['bind', 'from', 'into'],
            additionalProperties: false,
            properties: {
              bind: { type: 'string' },
              from: { enum: ['ask_tool_call_id', 'ask_answer_text', 'tool_result_field'] },
              from_field: { type: 'string' },
              into: { type: 'string' }, // JSON Pointer into the reconstructed round
            },
          },
        },
      },
    },
    askAnswer: {
      type: 'object',
      required: ['match', 'answer_channel'],
      additionalProperties: false,
      properties: {
        match: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool_call_id: { type: 'string' },
            origin: { enum: ['model', 'backend'] },
            reason: { type: 'string' },
            context_field: { type: 'string' },
            context_circuit: { type: ['string', 'number'] },
            question_contains: { type: 'string' },
          },
        },
        answer_channel: { enum: [...ANSWER_CHANNELS] },
        answer: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answered: { type: 'boolean' },
            user_text: { type: 'string' },
          },
        },
        at_ms_after_ask: { type: 'integer', minimum: 0 },
        at_ms_after_ask_provenance: { enum: [...PROVENANCE_KINDS] },
        terminal_outcome: { enum: [...TERMINAL_ASK_OUTCOMES] },
      },
    },
    expectedOperation: {
      type: 'object',
      required: ['operation_id', 'kind', 'audibility'],
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string' },
        kind: {
          enum: [
            'reading',
            'board_reading',
            'observation',
            'observation_update',
            'clear',
            'rename',
            'create_circuit',
          ],
        },
        tool: { type: 'string' },
        field: { type: ['string', 'null'] },
        circuit: { type: ['string', 'number', 'null'] },
        circuits: { type: 'array', items: { type: ['string', 'number'] } },
        board_id: { type: ['string', 'null'] },
        // P5 (2026-07-23) — the stale-clear board identity for a
        // clear_then_write op (the replacement reading's board is `board_id`;
        // the collapsed correction's board is `clear_board_id`; they may
        // legitimately differ in spelling for the SAME effective board).
        clear_board_id: { type: ['string', 'null'] },
        value: {},
        // P5 — constrain the previously free-string state_transition to its
        // sole supported value. A clear_then_write op JOINTLY asserts the
        // replacement reading present AND zero same-slot clear_reading
        // field_corrections (the collapse). Cross-field shape is fail-closed
        // below; the empty_fallback prohibition (operationIsStateDependent)
        // is retained.
        state_transition: { enum: ['clear_then_write'] },
        dedupe_token_expected: { type: 'boolean' },
        wire_identity: { type: 'object' },
        audibility: { enum: ['exactly_once', 'derived_exempt'] },
      },
    },
    expectedAudibleOutput: {
      type: 'object',
      required: ['output_id', 'kind', 'count', 'match'],
      additionalProperties: false,
      properties: {
        output_id: { type: 'string' },
        kind: { enum: [...AUDIBLE_OUTPUT_KINDS] },
        operation_ref: { type: 'string' },
        count: { type: 'integer', minimum: 0 },
        // UNIQUE matcher — one-to-one bipartite matching; ambiguity FAILS.
        match: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: ['string', 'null'] },
            circuit: { type: ['string', 'number', 'null'] },
            circuits: { type: 'array' },
            board_id: { type: ['string', 'null'] },
            value: {},
            dedupe_token: { type: 'string' },
            expected_key: { type: 'string' },
            text_exact: { type: 'string' }, // trimmed BYTE-EXACT (field_null_fallback)
            tool_call_id: { type: 'string' },
            reason: { type: 'string' },
            context_field: { type: 'string' },
            context_circuit: { type: ['string', 'number'] },
            question_contains: { type: 'string' },
          },
        },
        cardinality_note: { type: 'string' }, // grouped/derived cardinality effect
      },
    },
    expectedAsk: {
      type: 'object',
      required: ['origin'],
      additionalProperties: false,
      properties: {
        origin: { enum: ['model', 'backend'] },
        tool_call_id: { type: 'string' },
        reason: { type: 'string' },
        context_field: { type: 'string' },
        context_circuit: { type: ['string', 'number'] },
        question_contains: { type: 'string' },
      },
    },
    turn: {
      type: 'object',
      required: ['turn_index', 'at_ms', 'transcript'],
      additionalProperties: false,
      properties: {
        turn_index: { type: 'integer', minimum: 1 },
        at_ms: { type: 'integer', minimum: 0 },
        at_ms_provenance: { enum: [...PROVENANCE_KINDS] },
        transcript: { type: 'string' },
        regex_results: { type: 'array' },
        confirmations_enabled: { $ref: '#/$defs/provenancedScalar' },
        in_response_to: { $ref: '#/$defs/provenancedScalar' },
        ws_mode: { enum: [...WS_MODES] },
        ws_mode_provenance: { enum: [...PROVENANCE_KINDS] },
        chime_observed: { type: 'boolean' },
        chime_provenance_ref: { type: 'string' },
        regex_fast_correlation_ids: { type: 'array', items: { type: 'string' } },
        regex_fast_correlation_provenance: { enum: [...PROVENANCE_KINDS] },
        model_rounds: { type: 'array', items: { $ref: '#/$defs/modelRound' } },
        branches: { type: 'array', items: { $ref: '#/$defs/branch' } },
        ask_answers: { type: 'array', items: { $ref: '#/$defs/askAnswer' } },
        expected_operations: { type: 'array', items: { $ref: '#/$defs/expectedOperation' } },
        expected_audible_outputs: {
          type: 'array',
          items: { $ref: '#/$defs/expectedAudibleOutput' },
        },
        expected_asks: { type: 'array', items: { $ref: '#/$defs/expectedAsk' } },
      },
    },
  },
};

/** Shared Ajv constructor config — the ONE config used everywhere (union
 *  types in the real tool schemas reject under strict defaults). */
export const AJV_OPTIONS = Object.freeze({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
});

let compiledFixtureValidator = null;

async function getAjvClass() {
  const mod = await import('ajv');
  return mod.default?.default ?? mod.default ?? mod.Ajv;
}

/** Compile (once) and return the Ajv validator for the fixture schema. */
export async function getFixtureValidator() {
  if (compiledFixtureValidator) return compiledFixtureValidator;
  const Ajv = await getAjvClass();
  const ajv = new Ajv({ ...AJV_OPTIONS });
  compiledFixtureValidator = ajv.compile(FIXTURE_JSON_SCHEMA);
  return compiledFixtureValidator;
}

const EXECUTABLE_STATES = new Set(['expected_red', 'required_green']);

function err(code, path, message) {
  return { code, path, message };
}

/** State-dependent blocking assertion kinds (prohibited under empty_fallback). */
function operationIsStateDependent(op) {
  return (
    op.kind === 'observation_update' ||
    op.kind === 'clear' ||
    op.kind === 'rename' ||
    op.state_transition != null
  );
}

/**
 * Full fixture-document validation: Ajv structural pass + the cross-field
 * rules. `opts.manifestFragments` is acceptance-time only.
 * Returns { ok, errors: [{code, path, message}] }.
 */
export async function validateFixtureDocument(doc, opts = {}) {
  const errors = [];
  const validate = await getFixtureValidator();
  if (!validate(doc)) {
    for (const e of validate.errors ?? []) {
      errors.push(err(FIXTURE_ERROR_CODES.SCHEMA, e.instancePath || '/', e.message ?? 'schema error'));
    }
    // Structural failure: cross-field rules would throw on missing shapes.
    return { ok: false, errors };
  }

  // Corpus-ID validity.
  const idCheck = validateOpaqueRef('corpus', doc.corpus_id, opts.manifestFragments ?? []);
  if (!idCheck.ok) {
    errors.push(err(FIXTURE_ERROR_CODES.BAD_CORPUS_ID, '/corpus_id', `corpus_id rejected: ${idCheck.reason}`));
  }

  // Gate-state cross-field requirements.
  const gs = doc.gate_state;
  if (gs === 'expected_red') {
    const missing = ['expected_failure_id', 'red_proof_failure_id', 'owner', 'introduced_at', 'fix_reference', 'expires_at'].filter(
      (k) => doc[k] == null || doc[k] === '',
    );
    if (missing.length) {
      errors.push(err(FIXTURE_ERROR_CODES.EXPECTED_RED_MISSING_FIELDS, '/', `expected_red missing: ${missing.join(', ')}`));
    }
    if (doc.expected_failure_id != null && doc.red_proof_failure_id != null && doc.expected_failure_id !== doc.red_proof_failure_id) {
      errors.push(err(FIXTURE_ERROR_CODES.EXPECTED_FAILURE_ID_MISMATCH, '/expected_failure_id', 'active expected_failure_id must equal red_proof_failure_id'));
    }
    if (doc.purpose === 'triage') {
      errors.push(err(FIXTURE_ERROR_CODES.TRIAGE_WITH_FAILURE_ID, '/purpose', 'a triage fixture has no legitimate RED failure — it is admitted directly as required_green'));
    }
  }
  if (gs === 'required_green') {
    if (doc.expected_failure_id != null) {
      errors.push(err(FIXTURE_ERROR_CODES.EXPECTED_FAILURE_ID_MISMATCH, '/expected_failure_id', 'required_green must not carry an ACTIVE expected_failure_id'));
    }
    if (doc.purpose === 'triage' && doc.red_proof_failure_id != null) {
      errors.push(err(FIXTURE_ERROR_CODES.TRIAGE_WITH_FAILURE_ID, '/red_proof_failure_id', 'triage fixtures carry no red_proof_failure_id'));
    }
    // A REGRESSION fixture admitted directly as required_green (fix-wave-
    // lands-first contingency) must carry the immutable RED proof id; the
    // dual-evidence check itself is acceptance/history-level.
    if (doc.purpose === 'regression' && doc.red_proof_failure_id == null) {
      errors.push(err(FIXTURE_ERROR_CODES.GREEN_REGRESSION_MISSING_RED_PROOF, '/red_proof_failure_id', 'a regression fixture admitted required_green needs red_proof_failure_id (dual-proof rule)'));
    }
  }
  if (gs === 'unsupported_pending') {
    const missing = ['capability_exclusion', 'owner', 'named_followup', 'sanitized_transcript', 'human_expectations'].filter(
      (k) => doc[k] == null || (Array.isArray(doc[k]) && doc[k].length === 0) || doc[k] === '',
    );
    if (missing.length) {
      errors.push(err(FIXTURE_ERROR_CODES.UNSUPPORTED_PENDING_MISSING_FIELDS, '/', `unsupported_pending missing: ${missing.join(', ')}`));
    }
  }
  if (gs === 'superseded') {
    if (!doc.tombstone?.replacement_corpus_id || !doc.tombstone?.policy_change_reference) {
      errors.push(err(FIXTURE_ERROR_CODES.TOMBSTONE_MISSING_FIELDS, '/tombstone', 'superseded requires tombstone.replacement_corpus_id + policy_change_reference'));
    }
  }
  if (gs === 'privacy_quarantined') {
    const t = doc.tombstone ?? {};
    if (!t.quarantine_reason || !t.reviewer || !t.replacement_corpus_id || !t.prior_attestation_hash) {
      errors.push(err(FIXTURE_ERROR_CODES.TOMBSTONE_MISSING_FIELDS, '/tombstone', 'privacy_quarantined requires quarantine_reason, reviewer, replacement_corpus_id, prior_attestation_hash'));
    }
    // The tombstone must NEVER claim the sensitive bytes are gone — they
    // remain in git history; disclosure has a separate PII-incident path.
    const note = `${t.note ?? ''}`.toLowerCase();
    if (/\b(erased|deleted from history|gone|removed from git)\b/.test(note)) {
      errors.push(err(FIXTURE_ERROR_CODES.QUARANTINE_CLAIMS_ERASURE, '/tombstone/note', 'quarantine is execution containment, not erasure'));
    }
  }

  // fix_reference admissibility.
  if (doc.fix_reference != null) {
    const fr = validateFixReference(doc.fix_reference);
    if (!fr.ok) {
      errors.push(err(FIXTURE_ERROR_CODES.BAD_FIX_REFERENCE, '/fix_reference', `fix_reference inadmissible: ${fr.reason}`));
    }
  }

  // Executable-payload rules only apply to executable states.
  if (!EXECUTABLE_STATES.has(gs)) return { ok: errors.length === 0, errors };

  const turns = doc.turns ?? [];
  const provenanceMap = doc.input_provenance ?? {};
  const opIds = new Set();
  const outIds = new Set();
  // Production jobState circuits use `number` (voice-latency scenario
  // schema); accept the legacy aliases too.
  const jobCircuits = new Set(
    (doc.job_state?.circuits ?? []).map((c) => String(c.number ?? c.circuit_ref ?? c.ref ?? c.id ?? '')),
  );
  const jobBoards = new Set((doc.job_state?.boards ?? []).map((b) => String(b.board_id ?? b.id ?? '')));
  const jobObservations = new Set((doc.job_state?.observations ?? []).map((o) => String(o.observation_id ?? o.id ?? '')));
  const emptyFallback = doc.initial_state_fidelity === 'empty_fallback';
  const isKeystone = doc.is_keystone === true;

  for (const [ti, turn] of turns.entries()) {
    const tPath = `/turns/${ti}`;

    // Postcode PROHIBITION (v1): no deterministic fixture may carry
    // postcode-lookup hints — rejection happens BEFORE any extraction import.
    for (const [ri, r] of (turn.regex_results ?? []).entries()) {
      const fieldName = typeof r === 'object' && r !== null ? (r.field ?? r.name ?? '') : String(r);
      if (String(fieldName).includes('install.postcode') || String(fieldName) === 'postcode') {
        errors.push(err(FIXTURE_ERROR_CODES.POSTCODE_HINT_FORBIDDEN, `${tPath}/regex_results/${ri}`, 'postcode-lookup hints are forbidden in v1 deterministic fixtures (capability exclusion: postcode_lookup)'));
      }
    }

    // Outbound-option provenance: reconstructed_reviewed is legal ONLY on
    // keystone fixtures' confirmations_enabled / in_response_to.
    for (const key of ['confirmations_enabled', 'in_response_to']) {
      const v = turn[key];
      if (v == null) {
        errors.push(err(FIXTURE_ERROR_CODES.PROVENANCE_MISSING, `${tPath}/${key}`, `${key} must be supplied with provenance (fixtures may never invent or default it)`));
        continue;
      }
      if (v.provenance === 'reconstructed_reviewed' && !isKeystone) {
        errors.push(err(FIXTURE_ERROR_CODES.PROVENANCE_RESTRICTED, `${tPath}/${key}`, 'reconstructed_reviewed is admissible only on keystone fixtures (historical-capture exception)'));
      }
      if (v.provenance === 'reconstructed' || v.provenance === 'canonical') {
        errors.push(err(FIXTURE_ERROR_CODES.PROVENANCE_RESTRICTED, `${tPath}/${key}`, `${key} requires recorded_full (or reconstructed_reviewed on keystones)`));
      }
    }

    // reconstructed_reviewed in the provenance MAP is likewise restricted to
    // the two outbound options on keystones.
    // (Checked globally below.)

    // Tool-call expectations: reject requires a bounded error code.
    for (const [ri, round] of (turn.model_rounds ?? []).entries()) {
      for (const [ci, tc] of (round.tool_calls ?? []).entries()) {
        const cPath = `${tPath}/model_rounds/${ri}/tool_calls/${ci}`;
        if (tc.schema_expectation === 'reject' && !tc.schema_reject_code) {
          errors.push(err(FIXTURE_ERROR_CODES.SCHEMA_EXPECTATION_MISSING_CODE, cPath, 'schema_expectation: reject requires schema_reject_code'));
        }
        if (tc.dispatcher_expectation === 'reject' && !tc.dispatcher_reject_code) {
          errors.push(err(FIXTURE_ERROR_CODES.SCHEMA_EXPECTATION_MISSING_CODE, cPath, 'dispatcher_expectation: reject requires dispatcher_reject_code'));
        }
      }
    }

    // ask_answers obligation: every injected blocking ask_user AND every
    // expected backend-generated ask needs an answer or explicit terminal.
    const declaredAskIds = new Set();
    for (const [ai, aa] of (turn.ask_answers ?? []).entries()) {
      const aPath = `${tPath}/ask_answers/${ai}`;
      if (aa.match?.tool_call_id) declaredAskIds.add(aa.match.tool_call_id);
      if (aa.answer_channel === 'terminal') {
        if (!aa.terminal_outcome) {
          errors.push(err(FIXTURE_ERROR_CODES.ASK_BAD_TERMINAL, aPath, 'terminal channel requires terminal_outcome'));
        }
      } else if (aa.answer_channel === 'pending_registry') {
        if (!aa.answer?.user_text && !aa.terminal_outcome) {
          errors.push(err(FIXTURE_ERROR_CODES.ASK_UNANSWERED, aPath, 'pending_registry answer requires answer.user_text (or an explicit terminal_outcome)'));
        }
        // Bounded answered offsets: 0 <= at_ms_after_ask < ASK_USER_TIMEOUT_MS.
        if (aa.answer?.answered && aa.at_ms_after_ask != null && aa.at_ms_after_ask >= ASK_USER_TIMEOUT_MS) {
          errors.push(err(FIXTURE_ERROR_CODES.ASK_ANSWER_OFFSET_OUT_OF_RANGE, `${aPath}/at_ms_after_ask`, `answered offset must be < ASK_USER_TIMEOUT_MS (${ASK_USER_TIMEOUT_MS}); at/beyond requires terminal_outcome: timeout (timeout-wins at equality)`));
        }
      }
      // No-new-seam rule: a BACKEND-generated non-emitted ask may match ONLY
      // on the reduced tuple (toolCallId/context_field/context_circuit) — no
      // reason / question_contains matchers (the registry entry carries
      // neither, and the plan forbids a production DI seam).
      if (aa.match?.origin === 'backend' && (aa.match.reason || aa.match.question_contains)) {
        errors.push(err(FIXTURE_ERROR_CODES.ASK_BACKEND_RICH_MATCHER, `${aPath}/match`, 'backend-generated asks match on the reduced tuple only (tool_call_id/context_field/context_circuit)'));
      }
    }

    // Every INJECTED blocking ask_user tool call must carry a declaration.
    for (const [ri, round] of (turn.model_rounds ?? []).entries()) {
      for (const [ci, tc] of (round.tool_calls ?? []).entries()) {
        if (tc.name !== 'ask_user') continue;
        // Only dispatch-accepted asks block; declared-rejected ones resolve
        // as immediate tool-result outcomes.
        if (tc.dispatcher_expectation === 'reject' || tc.schema_expectation === 'reject') continue;
        const covered =
          declaredAskIds.has(tc.id) ||
          (turn.ask_answers ?? []).some((aa) => !aa.match?.tool_call_id && aa.match?.origin !== 'backend');
        if (!covered) {
          errors.push(err(FIXTURE_ERROR_CODES.ASK_UNANSWERED, `${tPath}/model_rounds/${ri}/tool_calls/${ci}`, `injected blocking ask_user ${tc.id} has no ask_answers declaration (deterministic answer or explicit terminal outcome)`));
        }
      }
    }

    // Expected operations: uniqueness + machine-checkable state dependencies.
    for (const [oi, op] of (turn.expected_operations ?? []).entries()) {
      const oPath = `${tPath}/expected_operations/${oi}`;
      if (opIds.has(op.operation_id)) {
        errors.push(err(FIXTURE_ERROR_CODES.DUPLICATE_OPERATION_ID, oPath, `duplicate operation_id ${op.operation_id}`));
      }
      opIds.add(op.operation_id);
      if (emptyFallback && operationIsStateDependent(op)) {
        errors.push(err(FIXTURE_ERROR_CODES.EMPTY_FALLBACK_STATE_ASSERTION, oPath, 'empty_fallback prohibits state-dependent blocking assertions'));
      }
      // P5 (2026-07-23) — fail-closed shape for a clear_then_write op. It
      // JOINTLY asserts (a) the replacement reading present AND (b) zero
      // same-slot clear_reading field_corrections. That only makes sense on a
      // singular circuit reading carrying both the replacement board identity
      // (`board_id`) and the stale-clear board identity (`clear_board_id`).
      // Reject every other shape so a malformed fixture can never GREEN a
      // half-checked expectation. `hasOwn` because a null value/board is a
      // legitimate, meaningful assertion (distinct from absent).
      if (op.state_transition === 'clear_then_write') {
        const bad = [];
        if (op.kind !== 'reading') bad.push('kind must be "reading"');
        if (!Object.hasOwn(op, 'value')) bad.push('own "value" required');
        if (typeof op.field !== 'string' || op.field === '') bad.push('non-empty string "field" required');
        if (op.circuit == null) bad.push('singular non-null "circuit" required');
        if (op.circuits != null) bad.push('"circuits[]" is not allowed (singular circuit only)');
        for (const k of ['board_id', 'clear_board_id']) {
          if (!Object.hasOwn(op, k)) bad.push(`own "${k}" required`);
          else if (!(typeof op[k] === 'string' || op[k] === null)) bad.push(`"${k}" must be string|null`);
        }
        if (bad.length) {
          errors.push(err(FIXTURE_ERROR_CODES.CLEAR_THEN_WRITE_BAD_SHAPE, oPath, `clear_then_write op malformed: ${bad.join('; ')}`));
        }
      }
      // Referenced circuits/boards must exist in job_state (unless the same
      // fixture creates them earlier — creation ops register their refs).
      if (op.kind === 'create_circuit' && op.circuit != null) {
        jobCircuits.add(String(op.circuit));
        continue;
      }
      const circuitRefs = op.circuits ?? (op.circuit != null ? [op.circuit] : []);
      for (const c of circuitRefs) {
        if (!jobCircuits.has(String(c))) {
          errors.push(err(FIXTURE_ERROR_CODES.STATE_DEP_MISSING, oPath, `referenced circuit ${c} not present in job_state (or created earlier in the fixture)`));
        }
      }
      if (op.board_id != null && jobBoards.size > 0 && !jobBoards.has(String(op.board_id))) {
        errors.push(err(FIXTURE_ERROR_CODES.STATE_DEP_MISSING, oPath, `referenced board ${op.board_id} not present in job_state`));
      }
      if (op.kind === 'observation_update') {
        const target = op.wire_identity?.observation_id ?? op.value?.observation_id ?? null;
        if (target != null && !jobObservations.has(String(target))) {
          errors.push(err(FIXTURE_ERROR_CODES.STATE_DEP_MISSING, oPath, `observation_update references unseeded observation ${target}`));
        }
      }
    }

    for (const [xi, out] of (turn.expected_audible_outputs ?? []).entries()) {
      const xPath = `${tPath}/expected_audible_outputs/${xi}`;
      if (outIds.has(out.output_id)) {
        errors.push(err(FIXTURE_ERROR_CODES.DUPLICATE_OUTPUT_ID, xPath, `duplicate output_id ${out.output_id}`));
      }
      outIds.add(out.output_id);
      if (out.kind === 'field_null_fallback') {
        // P4 (ask-decline-ack-net 2026-07-23) — a NON-EMPTY trimmed text_exact
        // is a sufficient oracle on its own. Historically this ALSO demanded a
        // dedupe_token / expected_key, but the §A4-drained field-null ack this
        // oracle targets (marker-①/②/F7 apologies AND the P4 decline-ack) is
        // TOKENLESS — field:null is outside DEDUPE_TOKEN_FIELDS, so the emitted
        // confirmation carries no token, and runtime `confirmationMatches` keys
        // on `text_exact` alone (no token needed). Demanding a token made a
        // field-null-fallback oracle impossible to express, and a FABRICATED
        // token would then fail the runtime match against the tokenless wire
        // ack (so it could never flip to required_green). An empty/whitespace
        // text_exact provides no meaningful oracle and stays REJECTED. The
        // field:null + circuit:null implication (enforced at match time in
        // replay-assertions.mjs) and the DUPLICATE_OUTPUT_ID check above are
        // unchanged. The value must be ALREADY trimmed (`=== .trim()`), not
        // merely trim-non-empty (Codex r1): runtime `confirmationMatches` trims
        // the CANDIDATE confirmation text and compares it to the RAW matcher
        // (replay-assertions.mjs), so a padded text_exact is byte-exact
        // UNSATISFIABLE — it would validate here yet never turn green.
        const te = out.match?.text_exact;
        const teValid = typeof te === 'string' && te.trim().length > 0 && te === te.trim();
        if (!teValid) {
          errors.push(err(FIXTURE_ERROR_CODES.SCHEMA, xPath, 'field_null_fallback requires a non-empty, already-trimmed byte-exact text_exact (no leading/trailing whitespace; implies field:null + circuit:null)'));
        }
      }
      if (out.operation_ref && !opIds.has(out.operation_ref)) {
        errors.push(err(FIXTURE_ERROR_CODES.STATE_DEP_MISSING, xPath, `operation_ref ${out.operation_ref} matches no expected_operation`));
      }
    }
  }

  // Provenance map: reconstructed_reviewed only on keystone outbound options.
  for (const [ptr, p] of Object.entries(provenanceMap)) {
    if (p.provenance !== 'reconstructed_reviewed') continue;
    const isOutboundOption = /\/(confirmations_enabled|in_response_to)$/.test(ptr);
    if (!isKeystone || !isOutboundOption) {
      errors.push(err(FIXTURE_ERROR_CODES.PROVENANCE_RESTRICTED, `/input_provenance`, `reconstructed_reviewed at ${ptr} is admissible only for keystone outbound options`));
    }
  }

  // Prestate: FAIL CLOSED. The schema admits a `prestate` block and
  // `warm_up_turns`, but the runner applies NEITHER — the session always
  // starts fresh and only `job_state` is seeded (Codex #3). Rather than run a
  // fixture against silently-wrong mid-session state (ask budget, clarify
  // chains, turn count, dialogue state), an EXECUTABLE fixture may not declare
  // a prestate block or start mid-session. Seed prior state via `job_state`
  // plus REAL preceding turns in `turns` (which DO execute), then assert the
  // target on the final turn. This support lands with the deferred prestate
  // work in field-replay-hardening-followups.
  const firstTurnIndex = turns[0]?.turn_index ?? 1;
  if (EXECUTABLE_STATES.has(doc.gate_state)) {
    if (doc.prestate && Object.keys(doc.prestate).length > 0) {
      errors.push(err(FIXTURE_ERROR_CODES.PRESTATE_UNKNOWN, '/prestate', `prestate is accepted by the schema but NOT applied by the runner — remove it and seed via job_state + real preceding turns (mid-session helper state is unsupported in v1)`));
    }
    if (firstTurnIndex > 1) {
      errors.push(err(FIXTURE_ERROR_CODES.PRESTATE_UNKNOWN, '/turns/0/turn_index', `executable fixture must start at turn_index 1 — the runner never fast-forwards mid-session; seed prior state with real preceding turns instead`));
    }
    // turn_index must be EXACTLY 1..N (sorted, unique, contiguous): the runner
    // executes turns in sorted order as session turns 1..N, so a gap like
    // [1,9] would silently run turn "9" as the 2nd session turn and mislabel
    // the state it represents (Codex #3 follow-up).
    if (turns.length > 0) {
      const idxs = turns.map((t) => t.turn_index).slice().sort((a, b) => a - b);
      if (!idxs.every((v, i) => v === i + 1)) {
        errors.push(err(FIXTURE_ERROR_CODES.PRESTATE_UNKNOWN, '/turns', `turn_index values must be exactly 1..N (unique, contiguous); got [${turns.map((t) => t.turn_index).join(', ')}]`));
      }
    }
    // Unsupported expected_operations kinds: clear / rename / create_circuit
    // have no faithful post-state oracle yet, so the runtime latches
    // infrastructure — reject them at validation too, for a clear author error
    // (Codex #1). Support returns with field-replay-hardening-followups.
    for (const [ti, t] of turns.entries()) {
      for (const [oi, op] of (t.expected_operations ?? []).entries()) {
        if (op.kind === 'clear' || op.kind === 'rename' || op.kind === 'create_circuit') {
          errors.push(err(FIXTURE_ERROR_CODES.SCHEMA, `/turns/${ti}/expected_operations/${oi}`, `operation kind '${op.kind}' has no faithful oracle yet — unsupported in v1`));
        }
      }
    }
  }

  // recentCircuitOrder: >3 circuits requires a complete provenance-backed
  // recent order OR warm-up turns (CIRCUIT_ORDER=recent_3 prompt selection).
  const circuitCount = (doc.job_state?.circuits ?? []).length;
  if (circuitCount > 3) {
    const hasOrder = Array.isArray(doc.recent_circuit_order?.value) && doc.recent_circuit_order.value.length > 0;
    const hasWarmup = Array.isArray(doc.prestate?.warm_up_turns) && doc.prestate.warm_up_turns.length > 0;
    if (!hasOrder && !hasWarmup) {
      errors.push(err(FIXTURE_ERROR_CODES.RECENT_ORDER_MISSING, '/recent_circuit_order', `job_state has ${circuitCount} circuits (>3): recent_3 prompt selection needs a complete provenance-backed recent order or deterministic warm-up turns`));
    }
  }

  // Tool-call ids must be UNIQUE across every model_round AND branch round.
  // The real model never reuses a tool_use_id, and the replay matcher
  // correlates dispatch/emission evidence by id — a duplicate id would let one
  // invocation's evidence (e.g. one emitted ask_user) satisfy another
  // invocation's expectation (Codex ask-branch false-pass). Fail closed.
  const seenToolIds = new Set();
  const collectRoundIds = (rounds, where) => {
    for (const r of rounds ?? []) {
      for (const tc of r.tool_calls ?? []) {
        if (tc?.id == null) continue;
        if (seenToolIds.has(tc.id)) {
          errors.push(err(FIXTURE_ERROR_CODES.SCHEMA, where, `duplicate tool_call id '${tc.id}' — ids must be unique across all rounds`));
        } else {
          seenToolIds.add(tc.id);
        }
      }
    }
  };
  for (const [ti, t] of turns.entries()) {
    collectRoundIds(t.model_rounds, `/turns/${ti}/model_rounds`);
    for (const [bi, b] of (t.branches ?? []).entries()) {
      collectRoundIds(b.rounds, `/turns/${ti}/branches/${bi}/rounds`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Gate-state machine — the ONLY legal transitions. `context` carries the
 * flags the payload-changing promotions require.
 */
export function legalTransition(fromState, toState, context = {}) {
  if (fromState === toState) return { ok: true, reason: 'no_change' };
  const key = `${fromState}→${toState}`;
  switch (key) {
    case 'expected_red→required_green':
      return { ok: true, reason: 'green_flip' };
    case 'unsupported_pending→expected_red':
      return context.newAttestation
        ? { ok: true, reason: 'promotion' }
        : { ok: false, reason: 'promotion_requires_new_attestation' };
    case 'unsupported_pending→required_green':
      return context.newAttestation && context.redEvidenceAgainstPreFix && context.greenEvidenceAgainstFixingSubject
        ? { ok: true, reason: 'dual_proof_promotion' }
        : { ok: false, reason: 'direct_green_promotion_requires_dual_red_green_proof' };
    case 'required_green→superseded':
      return context.reviewedSupersession
        ? { ok: true, reason: 'supersession' }
        : { ok: false, reason: 'supersession_requires_reviewed_governance_event' };
    default:
      if (toState === 'privacy_quarantined') {
        return context.quarantineGovernanceEvent
          ? { ok: true, reason: 'privacy_quarantine' }
          : { ok: false, reason: 'quarantine_requires_governance_event' };
      }
      return { ok: false, reason: 'illegal_transition' };
  }
}

/**
 * The IMMUTABLE projection of a fixture document: everything EXCEPT the
 * mutable `gate_state` and the ACTIVE `expected_failure_id` (validated
 * separately — only expected_red→required_green + removal of an active id
 * equal to the immutable red-proof id are legal). The hash COVERS `purpose`
 * and `red_proof_failure_id` when present.
 */
export function immutableProjection(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.gate_state;
  delete copy.expected_failure_id;
  return copy;
}
