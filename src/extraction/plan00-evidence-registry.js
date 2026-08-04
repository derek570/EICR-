/**
 * Plan 00B-3 C2/C3 — the closed evidence-producer registry and the closed
 * quiescence/semantic-family enums, mirroring (and drift-tested against)
 * the pre-authored contract schema at
 * tests/fixtures/test-contracts/plan00-evidence-contract/schema-v1.json.
 *
 * Evaluation-only: production never imports this module on any live code
 * path (the lifecycle hooks import it, but every hook is dormant without an
 * evaluation context — the import itself allocates only frozen constants).
 *
 * Why ONE registry backs BOTH enums (C3): enums alone don't make bypass
 * fail loudly — a new producer passing a free-form family string would be
 * invisible to a table test that iterates only registered members. Every
 * ask/delivery/playback recording API accepts REGISTRY IDs, never family
 * strings; an unknown id appends an uncreditable `producer_unknown` row and
 * marks the owning ledger invalid.
 *
 * The asynchronous PRODUCER_KINDS counter registry
 * (plan00-lifecycle-hooks.js) is a SEPARATE contract, deliberately not
 * replaced by this registry (Plan 00B-3 C0).
 */

/** C2 — the closed ask families that participate in completion quiescence. */
export const ASK_QUIESCENCE_FAMILIES = Object.freeze([
  'dispatcher',
  'dialogue_script',
  'address_mirror',
]);

/**
 * C3 — the closed SEMANTIC family vocabulary stamped on delivery and
 * playback sub-records (transport is a SEPARATE field, never overloaded).
 * Members derived from 00C's family gates: the ordinary confirmation
 * channel, the two Tier-2 families, and the fast-TTS path.
 */
export const SEMANTIC_FAMILIES = Object.freeze([
  'ordinary_confirmation',
  'dialogue_script',
  'address_mirror',
  'fast_tts',
]);

/** C3 — the closed transport/channel vocabulary. */
export const EVIDENCE_TRANSPORTS = Object.freeze([
  'ws_extraction',
  'ws_vcr',
  'dialogue_ws',
  'fast_tts',
  'http_playback_ack',
  'ws_ack',
  'ws_question',
]);

/**
 * C2 — the CLOSED non-quiescent terminal set. The dispatcher's terminal
 * vocabulary is open-ended, so quiescence compatibility is defined by this
 * closed set: an entry terminal-resolved with one of these still counts in
 * its family's open_asks_* key (an ask open AT the stop boundary renders
 * that freeze ineligible even after stop-expiry resolves it); ANY other
 * terminal closes the entry as quiescence-compatible.
 */
export const STOP_BOUNDARY_TERMINALS = Object.freeze([
  'session_stopped',
  'session_terminated',
  'connection_loss_at_stop',
]);

/**
 * Codex r1 (B-5) — quiescence-counted terminal classification is otherwise
 * fail-OPEN for `unknown_terminal` (the dispatcher's explicit fallback when
 * an outcome carries no reason): a genuinely unknown outcome must not
 * quietly close an ask as quiescence-compatible. The full non-quiescent set
 * is the three stop-boundary terminals PLUS this explicit unknown fallback.
 */
export const NON_QUIESCENT_TERMINALS = Object.freeze([
  ...STOP_BOUNDARY_TERMINALS,
  'unknown_terminal',
]);

/**
 * Cycle-7 (R7-1) — the EXECUTABLE lifecycle transition grammar, byte-compared
 * against schema-v1.json's `lifecycle_transition_grammar.transitions` and
 * CONSUMED by the evidence projector (one table, never two derivations).
 * Prior-state classes: absent | produced | emitted | terminal (closed or
 * open_at_stop — terminals never reopen). join_expired rows carry no runtime
 * and live outside the grammar.
 */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  absent: Object.freeze(['produced']),
  produced: Object.freeze(['emitted', 'replaced']),
  emitted: Object.freeze(['reissued_attempt', 'resolved', 'replaced']),
  terminal: Object.freeze([]),
});

/**
 * Codex r1 (A-4) — the EXECUTABLE per-reason rejection-regime table,
 * byte-compared against schema-v1.json's `rejection_reasons` by the
 * contract test. `structural_latch` reasons latch the owning ledger invalid
 * AND appear as the rejected audit row; the ONE `transition_rejection`
 * (answered_without_full_proof) produces ONLY the audit row and leaves the
 * entry open; `pre_admission` reasons are telemetry — no row, no latch.
 */
export const REJECTION_REASONS = Object.freeze({
  duplicate_runtime_binding: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'produced',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  emitted_without_produced: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'emitted',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  ambiguous_produced_match: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'emitted',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  emitted_without_binding: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'emitted',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  runtime_id_already_bound: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'emitted',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  resolution_without_emitted: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'resolved',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  answered_without_full_proof: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'resolved',
    regime: 'transition_rejection',
    row_kind: 'ask_transition_rejected',
  }),
  reissue_without_emitted: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'reissued_attempt',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  replacement_predecessor_unknown: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'replaced',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  srv_answer_ambiguous: Object.freeze({
    source_ledger: 'ask',
    stage_attempted: 'resolved',
    regime: 'structural_latch',
    row_kind: 'ask_transition_rejected',
  }),
  confirmation_delivery_binding_unmatched: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  confirmation_delivery_binding_ambiguous: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  confirmation_delivery_binding_no_mutation_observer: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  dialogue_delivery_binding_unmatched: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  dialogue_delivery_binding_ambiguous: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  dialogue_delivery_binding_no_mutation_observer: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  mirror_terminal_receipt_binding: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  fast_provisional_without_owner_proof: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  fast_ack_without_provisional: Object.freeze({
    source_ledger: 'delivery',
    regime: 'pre_admission',
    row_kind: null,
  }),
  fast_promotion_without_provisional: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  fast_promotion_unmatched: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  fast_promotion_ambiguous: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
  fast_provisional_unconsumed: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'freeze_invalid',
  }),
  playback_ack_unmatched: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'playback_rejected',
  }),
  playback_ack_ambiguous: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'playback_rejected',
  }),
  playback_without_delivery_attempt: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'playback_rejected',
  }),
  unknown_rejection_reason: Object.freeze({
    source_ledger: 'delivery',
    regime: 'structural_latch',
    row_kind: 'delivery_rejected',
  }),
});

/**
 * C3 — ONE closed producer registry backing both enums. Every producer ID
 * maps to {event_class, quiescence_family, semantic_family, transport}.
 * Null semantic_family is legal ONLY for event_class 'ask' (pure ask
 * producers can never reach delivery/playback rows — table-asserted).
 */
export const PRODUCER_REGISTRY = Object.freeze({
  dispatcher_ask: Object.freeze({
    event_class: 'ask',
    quiescence_family: 'dispatcher',
    semantic_family: null,
    transport: 'ws_question',
  }),
  dialogue_script_ask: Object.freeze({
    event_class: 'ask',
    quiescence_family: 'dialogue_script',
    semantic_family: null,
    transport: 'dialogue_ws',
  }),
  address_mirror_ask: Object.freeze({
    event_class: 'ask',
    quiescence_family: 'address_mirror',
    semantic_family: null,
    transport: 'ws_question',
  }),
  result_frame_confirmation: Object.freeze({
    event_class: 'delivery',
    quiescence_family: null,
    semantic_family: 'ordinary_confirmation',
    transport: 'ws_extraction',
  }),
  dialogue_confirmation: Object.freeze({
    event_class: 'delivery',
    quiescence_family: null,
    semantic_family: 'dialogue_script',
    transport: 'dialogue_ws',
  }),
  address_mirror_terminal: Object.freeze({
    event_class: 'delivery',
    quiescence_family: null,
    semantic_family: 'address_mirror',
    transport: 'ws_vcr',
  }),
  fast_tts_promotion: Object.freeze({
    event_class: 'delivery',
    quiescence_family: null,
    semantic_family: 'fast_tts',
    transport: 'fast_tts',
  }),
  playback_ack_slot: Object.freeze({
    event_class: 'playback',
    quiescence_family: null,
    semantic_family: 'ordinary_confirmation',
    transport: 'http_playback_ack',
  }),
  fast_tts_staged_ack: Object.freeze({
    event_class: 'playback',
    quiescence_family: null,
    semantic_family: 'fast_tts',
    transport: 'http_playback_ack',
  }),
  address_mirror_delivery_ack: Object.freeze({
    event_class: 'playback',
    quiescence_family: null,
    semantic_family: 'address_mirror',
    transport: 'ws_ack',
  }),
});

/**
 * C3 — the SEPARATE closed allowlist of legitimate NON-producer row kinds
 * (rows that don't map to a semantic producer). The source-coverage scan
 * fails on any append that is neither a registered producer event nor one
 * of these.
 */
export const NON_PRODUCER_ROW_KINDS = Object.freeze([
  'successful_frame',
  'confirmation_delivery',
  'round_usage',
  'non_mutating_audible',
  'freeze_invalid',
  'producer_unknown',
]);

/** Row kinds appended by registered producer adapters. */
export const PRODUCER_ROW_KINDS = Object.freeze([
  'ask_lifecycle',
  'ask_transition_rejected',
  'delivery_evidence',
  'delivery_rejected',
  'playback_evidence',
  'playback_idempotent',
  'playback_rejected',
]);

/** Lookup helper — null for unknown ids (callers fail loud, never throw). */
export function producerEntry(producerId) {
  return Object.prototype.hasOwnProperty.call(PRODUCER_REGISTRY, producerId)
    ? PRODUCER_REGISTRY[producerId]
    : null;
}
