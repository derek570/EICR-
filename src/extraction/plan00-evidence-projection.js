/**
 * Plan 00B-3 C0 — evidence_projection_v1: the executable derivability
 * contract's projector.
 *
 * `buildEvidenceProjectionV1` is an 00C-style completion-manifest builder
 * that consumes ONLY the five-key allowlisted completion snapshot
 * ({sessionId, boundary, counts, revisions, sub_records}) and reconstructs
 * the complete family evidence the 00C fold consumes. It never touches
 * `frozen.evidence`, live ledgers, or any mutable session state — the
 * reconstruction succeeding is the proof that `sub_records` alone carries
 * the contract.
 *
 * Layer boundary (schema-v1 `notes`): this is the 00B-owned
 * evidence_projection_v1 layer ONLY. The future 00C-owned manifest ENVELOPE
 * (trusted timestamps/status, deployment identity, content addressing,
 * publication receipts) is never reconstructed from sub_records.
 *
 * `projectFrozenLedgersV1` is the OTHER side of the three-way agreement
 * invariant: the same projection shape derived from the completion latch's
 * `frozen.evidence` ledger copies. Fields that exist ONLY in sub_records by
 * design are excluded from the comparable subset:
 *   - per-attempt rejected/idempotent audit arrays (ledger invalid latches
 *     are first-write-only — sub_records is deliberately the richer record);
 *   - round_usage (cost evidence rides sub_records, not frozen ledgers).
 * `comparableSubset` strips exactly those, so the agreement test compares
 * everything BOTH sides can honestly derive.
 *
 * Evaluation-only; production never imports this module.
 */

import {
  ASK_QUIESCENCE_FAMILIES,
  SEMANTIC_FAMILIES,
  NON_QUIESCENT_TERMINALS,
  REJECTION_REASONS,
} from './plan00-evidence-registry.js';

const PROJECTION_NAME = 'evidence_projection_v1';

function emptyAskFamily() {
  return {
    produced: 0,
    emitted: 0,
    reissued_attempts: 0,
    replaced: 0,
    join_expired: 0,
    resolved_terminals: {},
    rejected: [],
    open: 0,
  };
}

function groupByFamily(members) {
  const out = {};
  for (const m of members) out[m] = [];
  return out;
}

/**
 * Codex r1 (B-1) + mini-review M-4 — the reconstruction and the freeze-time
 * counts must AGREE, fail-CLOSED: a missing/invalid closed count key is a
 * contradiction (never silently zero), each family's counted open asks must
 * equal the row-derived count, and the aggregate `non_quiescent_at_stop`
 * outcome must equal what the in-flight counts themselves imply. Shared by
 * BOTH projection sides so the agreement invariant covers it.
 */
function collectCountContradictions(counts, askFamilies) {
  const contradictions = [];
  for (const family of ASK_QUIESCENCE_FAMILIES) {
    const counted = counts[`open_asks_${family}`];
    const derived = askFamilies[family].open;
    if (!Number.isInteger(counted) || counted < 0) {
      contradictions.push({ family, counted: counted ?? null, derived });
    } else if (counted !== derived) {
      contradictions.push({ family, counted, derived });
    }
  }
  const anyInFlight = Object.entries(counts).some(
    ([key, value]) =>
      key !== 'non_quiescent_at_stop' && key !== 'revision_instability' && value !== 0
  );
  const expectedAggregate = anyInFlight ? 1 : 0;
  const statedAggregate = counts.non_quiescent_at_stop;
  if (statedAggregate !== expectedAggregate) {
    contradictions.push({
      family: 'aggregate_non_quiescent',
      counted: statedAggregate ?? null,
      derived: expectedAggregate,
    });
  }
  // Cycle-2 (R2-3) — revision_instability is a CLOSED 0|1 outcome; a
  // missing/out-of-domain value must never read as "stable".
  const revInstability = counts.revision_instability;
  if (revInstability !== 0 && revInstability !== 1) {
    contradictions.push({
      family: 'aggregate_revision_instability',
      counted: revInstability ?? null,
      derived: null,
    });
  }
  return contradictions;
}

/**
 * Cycle-2 (R2-2) — the executable REJECTION_REASONS regime table COMPOSES
 * into eligibility: a structural rejection row must be accompanied by its
 * owning ledger's freeze-time invalid row; a transition rejection must
 * reference an ask that exists in the stream; a pre_admission or
 * unregistered reason can never legitimately appear as a row. Sub-records-
 * only (the frozen ledgers cannot enumerate rejections) — stripped from
 * the comparable subset.
 */
function collectRegimeContradictions({
  askRejections,
  rejectedDeliveries,
  rejectedPlaybacks,
  ineligibleConditions,
  knownAskRuntimeIds,
}) {
  const contradictions = [];
  const hasCondition = (condition) => ineligibleConditions.some((c) => c.condition === condition);
  const reasonSpec = (reason) =>
    Object.prototype.hasOwnProperty.call(REJECTION_REASONS, reason)
      ? REJECTION_REASONS[reason]
      : null;

  for (const rej of askRejections) {
    const spec = reasonSpec(rej.reason);
    if (!spec || spec.regime === 'pre_admission') {
      contradictions.push({
        class: 'illegal_reason_row',
        kind: 'ask_transition_rejected',
        seq: rej.seq,
        reason: rej.reason ?? null,
      });
      continue;
    }
    if (spec.regime === 'structural_latch' && !hasCondition('ask_invalid')) {
      contradictions.push({
        class: 'structural_rejection_without_latch',
        kind: 'ask_transition_rejected',
        seq: rej.seq,
        reason: rej.reason,
      });
    }
    if (
      spec.regime === 'transition_rejection' &&
      rej.runtime_id != null &&
      !knownAskRuntimeIds.has(rej.runtime_id)
    ) {
      contradictions.push({
        class: 'orphan_transition_rejection',
        kind: 'ask_transition_rejected',
        seq: rej.seq,
        reason: rej.reason,
      });
    }
  }
  for (const [kind, list] of [
    ['delivery_rejected', rejectedDeliveries],
    ['playback_rejected', rejectedPlaybacks],
  ]) {
    for (const rej of list) {
      const spec = reasonSpec(rej.reason);
      if (!spec || spec.regime === 'pre_admission') {
        contradictions.push({
          class: 'illegal_reason_row',
          kind,
          seq: rej.seq,
          reason: rej.reason ?? null,
        });
        continue;
      }
      if (!hasCondition('delivery_invalid')) {
        contradictions.push({
          class: 'structural_rejection_without_latch',
          kind,
          seq: rej.seq,
          reason: rej.reason,
        });
      }
    }
  }
  return contradictions;
}

/**
 * Reconstruct the complete evidence_projection_v1 from the five-key
 * snapshot. Pure; deterministic; array order of `sub_records` is the global
 * event order (schema-v1 ordering rule).
 */
export function buildEvidenceProjectionV1(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('buildEvidenceProjectionV1: snapshot required');
  }
  const rows = Array.isArray(snapshot.sub_records) ? snapshot.sub_records : [];
  const counts = snapshot.counts ?? {};
  const revisions = snapshot.revisions ?? {};

  const askFamilies = {};
  for (const family of ASK_QUIESCENCE_FAMILIES) askFamilies[family] = emptyAskFamily();
  // Per-runtime-id ask state machine: open until an accepted close.
  // key `${family}::${runtime_id}` -> 'open' | 'closed' | 'open_at_stop'
  const askStates = new Map();
  const askKey = (family, runtimeId) => `${family}::${runtimeId}`;
  // Cycle-2 (R2-2) — every runtime id that EXISTS in the stream (any
  // accepted lifecycle row naming it), for orphan-rejection detection.
  const knownAskRuntimeIds = new Set();

  const deliveries = groupByFamily(SEMANTIC_FAMILIES);
  const playbacks = groupByFamily(SEMANTIC_FAMILIES);
  const idempotentPlaybacks = [];
  const rejectedDeliveries = [];
  const rejectedPlaybacks = [];
  const unscopedRejectedAsks = [];
  const ambiguousOpKeys = [];
  const ineligibleConditions = [];
  const unknownProducers = [];
  const roundRows = [];
  const loopInvocationIds = new Set();

  for (let seq = 0; seq < rows.length; seq += 1) {
    const row = rows[seq];
    switch (row.kind) {
      case 'ask_lifecycle': {
        const family = ASK_QUIESCENCE_FAMILIES.includes(row.family) ? row.family : null;
        if (!family) break;
        if (row.runtime_id != null) knownAskRuntimeIds.add(row.runtime_id);
        const fam = askFamilies[family];
        switch (row.stage) {
          case 'produced':
            fam.produced += 1;
            if (row.runtime_id != null) askStates.set(askKey(family, row.runtime_id), 'open');
            break;
          case 'emitted':
            fam.emitted += 1;
            if (row.runtime_id != null && !askStates.has(askKey(family, row.runtime_id))) {
              askStates.set(askKey(family, row.runtime_id), 'open');
            }
            break;
          case 'reissued_attempt':
            fam.reissued_attempts += 1;
            break;
          case 'resolved': {
            const terminal = row.terminal ?? 'unknown_terminal';
            fam.resolved_terminals[terminal] = (fam.resolved_terminals[terminal] ?? 0) + 1;
            if (row.runtime_id != null) {
              // Stop-boundary terminals close the ledger entry but remain
              // non-quiescent for the freeze they race with (schema-v1
              // ask_terminals rule).
              askStates.set(
                askKey(family, row.runtime_id),
                NON_QUIESCENT_TERMINALS.includes(terminal) ? 'open_at_stop' : 'closed'
              );
            }
            break;
          }
          case 'replaced':
            fam.replaced += 1;
            if (row.runtime_id != null) askStates.set(askKey(family, row.runtime_id), 'closed');
            break;
          case 'join_expired':
            fam.join_expired += 1;
            break;
          default:
            break;
        }
        break;
      }
      case 'ask_transition_rejected': {
        const family = ASK_QUIESCENCE_FAMILIES.includes(row.family) ? row.family : null;
        const target = family ? askFamilies[family] : null;
        const rejection = {
          seq,
          stage_attempted: row.stage_attempted ?? null,
          reason: row.reason ?? null,
          terminal_attempted: row.terminal_attempted ?? null,
          runtime_id: row.runtime_id ?? null,
        };
        if (target) target.rejected.push(rejection);
        // Codex r1 (A-5) — a rejection whose family is unresolvable
        // (schema-legal null) stays VISIBLE instead of being dropped.
        else unscopedRejectedAsks.push(rejection);
        // A rejected transition never closes the entry — an open ask stays
        // open (the named fixture case's quiescence consequence).
        break;
      }
      case 'delivery_evidence': {
        const family = SEMANTIC_FAMILIES.includes(row.semantic_family) ? row.semantic_family : null;
        if (row.delivery_kind === 'delivery_history_ambiguous') {
          // Mini-review M-3 — ordered ambiguity records (seq preserved).
          for (const key of row.op_keys ?? []) ambiguousOpKeys.push({ seq, op_key: key });
          break;
        }
        if (!family) break;
        deliveries[family].push({
          // Codex r1 (A-1/B-7) — `seq` = sub_records array index, stamped at
          // projection, so grouped projections retain the cross-class event
          // interleaving the fold's ordering rules need.
          seq,
          delivery_ref: row.delivery_ref ?? null,
          at_seq: row.at_seq ?? null,
          producer_id: row.producer_id ?? null,
          transport: row.transport ?? null,
          delivery_kind: row.delivery_kind ?? null,
          op_keys: [...(row.op_keys ?? [])],
          claim_lineage: row.claim_lineage ?? null,
          delivery_claim_token: row.delivery_claim_token ?? null,
          wire_turn_id: row.wire_turn_id ?? null,
          dedupe_token: row.dedupe_token ?? null,
          correlation_id: row.correlation_id ?? null,
        });
        break;
      }
      case 'delivery_rejected':
        rejectedDeliveries.push({
          seq,
          producer_id: row.producer_id ?? null,
          reason: row.reason ?? null,
        });
        break;
      case 'playback_evidence': {
        const family = SEMANTIC_FAMILIES.includes(row.semantic_family) ? row.semantic_family : null;
        if (!family) break;
        playbacks[family].push({
          seq,
          op_key: row.op_key ?? null,
          ack_body_hash: row.ack_body_hash ?? null,
          source: row.source ?? null,
          producer_id: row.producer_id ?? null,
          transport: row.transport ?? null,
        });
        break;
      }
      case 'playback_idempotent':
        idempotentPlaybacks.push({
          seq,
          op_key: row.op_key ?? null,
          ack_body_hash: row.ack_body_hash ?? null,
          producer_id: row.producer_id ?? null,
        });
        break;
      case 'playback_rejected':
        rejectedPlaybacks.push({
          seq,
          producer_id: row.producer_id ?? null,
          reason: row.reason ?? null,
        });
        break;
      case 'freeze_invalid':
        ineligibleConditions.push({
          condition: row.condition ?? null,
          reason: row.reason ?? null,
          count: row.count ?? null,
        });
        break;
      case 'producer_unknown':
        unknownProducers.push({
          event_class: row.event_class ?? null,
          producer_id_raw: row.producer_id_raw ?? null,
        });
        break;
      case 'round_usage': {
        const r = { ...row };
        delete r.kind;
        delete r.revision;
        roundRows.push(r);
        if (row.loop_invocation_id != null) loopInvocationIds.add(row.loop_invocation_id);
        break;
      }
      default:
        break;
    }
  }

  for (const [key, state] of askStates) {
    if (state === 'closed') continue;
    const family = key.slice(0, key.indexOf('::'));
    if (askFamilies[family]) askFamilies[family].open += 1;
  }

  const quiescence = {
    non_quiescent_at_stop: counts.non_quiescent_at_stop ?? 0,
    revision_instability: counts.revision_instability ?? 0,
  };

  // Codex r1 (B-1) — the reconstruction and the freeze-time counts must
  // AGREE: a snapshot whose rows say an ask is open while its counts say
  // zero (or vice versa) is a contract contradiction, and a fold must HOLD
  // on it rather than trust either side.
  const countContradictions = collectCountContradictions(counts, askFamilies);
  const allAskRejections = [
    ...Object.values(askFamilies).flatMap((fam) => fam.rejected),
    ...unscopedRejectedAsks,
  ];
  const regimeContradictions = collectRegimeContradictions({
    askRejections: allAskRejections,
    rejectedDeliveries,
    rejectedPlaybacks,
    ineligibleConditions,
    knownAskRuntimeIds,
  });

  const eligible =
    quiescence.non_quiescent_at_stop === 0 &&
    quiescence.revision_instability === 0 &&
    ineligibleConditions.length === 0 &&
    unknownProducers.length === 0 &&
    countContradictions.length === 0 &&
    regimeContradictions.length === 0;

  const askComplete = (family) => {
    const fam = askFamilies[family];
    return fam.produced > 0 && fam.emitted > 0 && (fam.resolved_terminals.answered ?? 0) > 0;
  };
  const opBound = (family) => deliveries[family].some((d) => d.op_keys.length > 0);

  return {
    projection: PROJECTION_NAME,
    session_id: snapshot.sessionId ?? null,
    boundary: snapshot.boundary ?? null,
    quiescence,
    open_asks: {
      dispatcher: counts.open_asks_dispatcher ?? 0,
      dialogue_script: counts.open_asks_dialogue_script ?? 0,
      address_mirror: counts.open_asks_address_mirror ?? 0,
    },
    ineligible_conditions: ineligibleConditions,
    unknown_producers: unknownProducers,
    count_contradictions: countContradictions,
    rejection_regime_contradictions: regimeContradictions,
    eligible_for_family_credit: eligible,
    ask_families: askFamilies,
    unscoped_rejected_asks: unscopedRejectedAsks,
    deliveries,
    delivery_history_ambiguous_op_keys: ambiguousOpKeys,
    rejected_deliveries: rejectedDeliveries,
    playbacks,
    idempotent_playbacks: idempotentPlaybacks,
    rejected_playbacks: rejectedPlaybacks,
    round_usage: {
      rounds: roundRows,
      loop_invocations: loopInvocationIds.size,
      completed_rounds: roundRows.length,
      usage_revision: revisions.usage_revision ?? 0,
    },
    family_gates: {
      dialogue_script: {
        ask_lifecycle_complete: askComplete('dialogue_script'),
        operation_bound_delivery: opBound('dialogue_script'),
      },
      address_mirror: {
        ask_lifecycle_complete: askComplete('address_mirror'),
        operation_bound_delivery: opBound('address_mirror'),
        playback_ack_proof: playbacks.address_mirror.length > 0,
      },
    },
  };
}

/**
 * The frozen-ledger side of the three-way agreement: the same projection
 * shape derived from a completion latch's `frozen.evidence` ledger copies
 * (+ its counts). See the module docstring for the deliberate exclusions.
 */
export function projectFrozenLedgersV1(completionLatch) {
  if (!completionLatch || typeof completionLatch !== 'object') {
    throw new Error('projectFrozenLedgersV1: completion latch required');
  }
  const ev = completionLatch.evidence;
  if (!ev) throw new Error('projectFrozenLedgersV1: latch carries no evidence');
  const counts = completionLatch.counts ?? {};

  const askFamilies = {};
  for (const family of ASK_QUIESCENCE_FAMILIES) askFamilies[family] = emptyAskFamily();
  for (const entry of ev.ask_entries ?? []) {
    const family = ASK_QUIESCENCE_FAMILIES.includes(entry.meta?.family) ? entry.meta.family : null;
    if (!family) continue;
    const fam = askFamilies[family];
    const history = Array.isArray(entry.history) ? entry.history : [];
    for (const h of history) {
      if (h === 'produced') fam.produced += 1;
      else if (h === 'emitted') fam.emitted += 1;
      else if (h === 'reissued_attempt') fam.reissued_attempts += 1;
      else if (h === 'reissued') fam.replaced += 1;
      else {
        fam.resolved_terminals[h] = (fam.resolved_terminals[h] ?? 0) + 1;
      }
    }
    const open =
      entry.state === 'produced' ||
      entry.state === 'emitted' ||
      NON_QUIESCENT_TERMINALS.includes(entry.state);
    if (open) fam.open += 1;
  }

  const deliveries = groupByFamily(SEMANTIC_FAMILIES);
  for (const d of ev.deliveries ?? []) {
    const family = SEMANTIC_FAMILIES.includes(d.semantic_family) ? d.semantic_family : null;
    if (!family) continue;
    deliveries[family].push({
      delivery_ref: d.delivery_ref ?? null,
      at_seq: d.at_seq ?? null,
      producer_id: d.producer_id ?? null,
      transport: d.transport ?? null,
      delivery_kind: d.kind ?? null,
      op_keys: [...(d.op_keys ?? [])],
      claim_lineage: d.claim_lineage ?? null,
      delivery_claim_token: d.delivery_claim_token ?? null,
      wire_turn_id: d.wire_turn_id ?? null,
      dedupe_token: d.dedupe_token ?? null,
      correlation_id: d.correlation_id ?? null,
    });
  }

  const playbacks = groupByFamily(SEMANTIC_FAMILIES);
  for (const p of ev.playbacks ?? []) {
    const family = SEMANTIC_FAMILIES.includes(p.semantic_family) ? p.semantic_family : null;
    if (!family) continue;
    playbacks[family].push({
      op_key: p.op_key ?? null,
      ack_body_hash: p.ack_body_hash ?? null,
      source: p.source ?? null,
      producer_id: p.producer_id ?? null,
      transport: p.transport ?? null,
    });
  }

  const ineligibleConditions = [];
  if (ev.ask_invalid) {
    ineligibleConditions.push({
      condition: 'ask_invalid',
      reason: ev.ask_invalid.reason ?? null,
      count: null,
    });
  }
  if (ev.delivery_invalid) {
    ineligibleConditions.push({
      condition: 'delivery_invalid',
      reason: ev.delivery_invalid.reason ?? null,
      count: null,
    });
  }
  if (ev.producer_invalid) {
    ineligibleConditions.push({
      condition: 'producer_invalid',
      reason: ev.producer_invalid.reason ?? null,
      count: null,
    });
  }
  if (ev.mutation_invalid) {
    ineligibleConditions.push({
      condition: 'mutation_invalid',
      reason: ev.mutation_invalid.reason ?? null,
      count: null,
    });
  }
  if ((ev.delivery_prepared_outstanding ?? 0) > 0) {
    ineligibleConditions.push({
      condition: 'delivery_prepared_outstanding',
      reason: null,
      count: ev.delivery_prepared_outstanding,
    });
  }

  const quiescence = {
    non_quiescent_at_stop: counts.non_quiescent_at_stop ?? 0,
    revision_instability: counts.revision_instability ?? 0,
  };
  const countContradictions = collectCountContradictions(counts, askFamilies);
  const eligible =
    quiescence.non_quiescent_at_stop === 0 &&
    quiescence.revision_instability === 0 &&
    ineligibleConditions.length === 0 &&
    countContradictions.length === 0;

  const askComplete = (family) => {
    const fam = askFamilies[family];
    return fam.produced > 0 && fam.emitted > 0 && (fam.resolved_terminals.answered ?? 0) > 0;
  };
  const opBound = (family) => deliveries[family].some((d) => d.op_keys.length > 0);

  return {
    projection: PROJECTION_NAME,
    session_id: completionLatch.sessionId ?? null,
    boundary: completionLatch.boundary ?? null,
    quiescence,
    open_asks: {
      dispatcher: counts.open_asks_dispatcher ?? 0,
      dialogue_script: counts.open_asks_dialogue_script ?? 0,
      address_mirror: counts.open_asks_address_mirror ?? 0,
    },
    ineligible_conditions: ineligibleConditions,
    count_contradictions: countContradictions,
    eligible_for_family_credit: eligible,
    ask_families: askFamilies,
    deliveries,
    delivery_history_ambiguous_op_keys: [...(ev.ambiguous_op_keys ?? [])],
    playbacks,
    family_gates: {
      dialogue_script: {
        ask_lifecycle_complete: askComplete('dialogue_script'),
        operation_bound_delivery: opBound('dialogue_script'),
      },
      address_mirror: {
        ask_lifecycle_complete: askComplete('address_mirror'),
        operation_bound_delivery: opBound('address_mirror'),
        playback_ack_proof: playbacks.address_mirror.length > 0,
      },
    },
  };
}

/**
 * Strip the sub-records-only fields from a buildEvidenceProjectionV1 result
 * so it can be deep-compared against projectFrozenLedgersV1's output (the
 * comparable subset of the three-way agreement invariant).
 */
export function comparableSubset(projection) {
  const {
    unknown_producers: _unknown,
    rejected_deliveries: _rd,
    rejected_playbacks: _rp,
    idempotent_playbacks: _ip,
    unscoped_rejected_asks: _ura,
    rejection_regime_contradictions: _rrc,
    round_usage: _ru,
    ...rest
  } = projection;
  // `seq` (sub_records array position) is sub-records-only precision — the
  // frozen ledgers cannot reconstruct cross-class interleaving.
  const stripSeq = ({ seq: _seq, ...ev }) => ev;
  rest.deliveries = Object.fromEntries(
    Object.entries(rest.deliveries).map(([f, list]) => [f, list.map(stripSeq)])
  );
  rest.playbacks = Object.fromEntries(
    Object.entries(rest.playbacks).map(([f, list]) => [f, list.map(stripSeq)])
  );
  // ambiguity: the build side carries ordered {seq, op_key} records, the
  // frozen side bare op_key strings — compare on the keys.
  rest.delivery_history_ambiguous_op_keys = rest.delivery_history_ambiguous_op_keys.map((e) =>
    typeof e === 'string' ? e : e.op_key
  );
  const askFamilies = {};
  for (const [family, fam] of Object.entries(rest.ask_families)) {
    // `rejected` (per-attempt audit) and `join_expired` (srv join state)
    // are deliberately sub-records-only — the ledger's invalid latch is
    // first-write-only and join state never enters the ask ledger.
    const { rejected: _rej, join_expired: _je, ...famRest } = fam;
    askFamilies[family] = famRest;
  }
  return { ...rest, ask_families: askFamilies };
}
