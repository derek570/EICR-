/**
 * Plan 00B §B3 — evaluation-only ask + audibility + playback ledgers.
 *
 * Three separate fact streams, deliberately never conflated:
 *   1. ASK ledger — produced (full semantic key, pre-projection) → emitted
 *      (same runtime id, only after a successful send) → answered/terminal
 *      (matching resolution from the real ingress).
 *   2. DELIVERY ledger — immutable operation-bound `delivery_attempt` rows
 *      for every successful server emission of an audibility-mandatory
 *      confirmation. Server delivery is NEVER treated as playback.
 *   3. PLAYBACK ledger — `playback_start` rows created only when an
 *      authenticated client ACK resolves uniquely to ONE authoritative
 *      operation that has at least one compatible delivery_attempt.
 *
 * The durable logical identity everywhere is the OPERATION:
 * original extractionTurnId + canonical effective slot identity + operation
 * ordinal/digest — never a result envelope, confirmation_ref,
 * result.turn_id, address-mirror resolution token or client dedupe token
 * (those are transport aliases only).
 *
 * All state here is evaluation-owned; production never constructs these.
 */

import { createHash } from 'node:crypto';

/** Canonical operation identity key. */
export function operationIdentityKey({ extractionTurnId, field, circuit, boardId, ordinal }) {
  return JSON.stringify({
    turn: extractionTurnId ?? null,
    field: field ?? null,
    circuit: circuit ?? null,
    board_id: boardId ?? null,
    ordinal: ordinal ?? 0,
  });
}

/**
 * §B3 — the exact normalized live ask key: origin, purpose, reason, context
 * field, board, scalar or sorted plural circuits, expected answer shape,
 * observation clarification kind, normalized pending-write identity and
 * semantic chain role. NO generated ids.
 */
export function buildLiveAskKey({
  origin,
  purpose,
  reason,
  contextField,
  boardId,
  circuits,
  expectedAnswerShape,
  observationClarificationKind,
  pendingWrite,
  chainRole,
}) {
  const circuitList = Array.isArray(circuits)
    ? [...circuits].map((c) => String(c)).sort()
    : circuits != null
      ? [String(circuits)]
      : [];
  const pending = pendingWrite
    ? {
        field: pendingWrite.field ?? null,
        circuit: pendingWrite.circuit ?? null,
        board_id: pendingWrite.board_id ?? null,
        value: pendingWrite.value == null ? null : String(pendingWrite.value),
      }
    : null;
  return JSON.stringify({
    origin: origin ?? null,
    purpose: purpose ?? null,
    reason: reason ?? null,
    context_field: contextField ?? null,
    board_id: boardId ?? null,
    circuits: circuitList,
    expected_answer_shape: expectedAnswerShape ?? null,
    observation_clarification_kind: observationClarificationKind ?? null,
    pending_write: pending,
    chain_role: chainRole ?? null,
  });
}

/**
 * The evaluation ask ledger. Declarations are keyed by liveAskKey;
 * runtime-id binding requires exactly ONE unmatched declaration.
 */
export function createAskLedger() {
  const entries = [];
  let invalid = null;
  const markInvalid = (reason, detail) => {
    if (!invalid) invalid = Object.freeze({ reason, detail: detail ?? null });
  };

  return {
    get entries() {
      return entries;
    },
    get invalid() {
      return invalid;
    },
    markInvalid,

    /** Stage 1 — semantic production, pre-wire, pre-lossy-projection. */
    produced(liveAskKey, meta = {}) {
      entries.push({
        key: liveAskKey,
        state: 'produced',
        runtime_id: null,
        meta,
        history: ['produced'],
      });
    },

    /**
     * Stage 2 — successful send. Binds the runtime id to exactly ONE
     * unmatched produced declaration with the same key. Zero or multiple
     * candidates, or an id already claimed, is a ledger failure.
     */
    emitted(liveAskKey, runtimeId) {
      if (entries.some((e) => e.runtime_id === runtimeId)) {
        markInvalid('runtime_id_already_bound', { runtimeId });
        return;
      }
      const candidates = entries.filter((e) => e.key === liveAskKey && e.state === 'produced');
      if (candidates.length !== 1) {
        markInvalid(
          candidates.length === 0 ? 'emitted_without_produced' : 'ambiguous_produced_match',
          {
            liveAskKey,
            candidates: candidates.length,
          }
        );
        return;
      }
      candidates[0].state = 'emitted';
      candidates[0].runtime_id = runtimeId;
      candidates[0].history.push('emitted');
    },

    /**
     * Stage 3 — terminal resolution from the REAL ingress. For `answered`,
     * the frame id must equal the outstanding emitted id; a logged prefix is
     * never proof. Non-answered terminals (timeout, user_moved_on,
     * session_stopped, superseded, reissued) close the entry with that class.
     */
    resolved(runtimeId, terminal, detail = {}) {
      const entry = entries.find((e) => e.runtime_id === runtimeId && e.state === 'emitted');
      if (!entry) {
        markInvalid('resolution_without_emitted', { runtimeId, terminal });
        return;
      }
      if (terminal === 'answered') {
        // §B3: answered requires BOTH the direct answer frame id match AND
        // the paired transcript reaching engine resolution.
        if (detail.answer_frame_id !== runtimeId || detail.transcript_resolved !== true) {
          markInvalid('answered_without_full_proof', {
            runtimeId,
            answer_frame_id: detail.answer_frame_id ?? null,
            transcript_resolved: detail.transcript_resolved === true,
          });
          return;
        }
      }
      entry.state = terminal;
      entry.terminal_detail = detail;
      entry.history.push(terminal);
    },

    /** Asks still open (produced-or-emitted) — reconnect must preserve them. */
    open() {
      return entries.filter((e) => e.state === 'produced' || e.state === 'emitted');
    },
  };
}

/**
 * Delivery + playback ledgers, bound to authoritative operation identity.
 */
export function createDeliveryLedger() {
  const deliveries = []; // { op_key, kind, transport, at_seq, claim_lineage }
  const provisionals = []; // fast-TTS: { correlation_id, user_ok, candidate, staged_acks:[], resolved_op_key }
  const playbacks = []; // { op_key, ack_body_hash }
  const ambiguousOps = new Set();
  let seq = 0;
  let invalid = null;
  const markInvalid = (reason, detail) => {
    if (!invalid) invalid = Object.freeze({ reason, detail: detail ?? null });
  };

  const ackBodyHash = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

  return {
    get deliveries() {
      return deliveries;
    },
    get provisionals() {
      return provisionals;
    },
    get playbacks() {
      return playbacks;
    },
    get invalid() {
      return invalid;
    },
    markInvalid,

    /**
     * One immutable operation-bound delivery_attempt per successful send /
     * replay / dialogue confirmation / VCR spoken_response. Multiple
     * deliveries for one operation are all retained — never discarded, never
     * presented as proof the client suppressed playback.
     */
    recordDeliveryAttempt(opIdentity, { kind, transport = null, claimLineage = null } = {}) {
      seq += 1;
      deliveries.push(
        Object.freeze({
          op_key: operationIdentityKey(opIdentity),
          kind: kind ?? 'confirmation',
          transport,
          claim_lineage: claimLineage,
          at_seq: seq,
        })
      );
    },

    /**
     * §B3 outbox recovery — a recovery running under a prior/different claim
     * lineage whose successful-send observation is absent from THIS process
     * observer marks the operation delivery-history-ambiguous. It never
     * reconstructs a missing pre-crash delivery or playback.
     */
    markDeliveryHistoryAmbiguous(opIdentity) {
      ambiguousOps.add(operationIdentityKey(opIdentity));
    },

    isDeliveryHistoryAmbiguous(opIdentity) {
      return ambiguousOps.has(operationIdentityKey(opIdentity));
    },

    /**
     * Fast-TTS pre-operation exception: a provisional delivery exists only
     * after the active-session OWNER check passed. Client turnId is never
     * identity — only the correlation id + normalized candidate.
     */
    recordProvisionalFastDelivery({ correlationId, ownerVerified, candidate }) {
      if (ownerVerified !== true) {
        markInvalid('fast_provisional_without_owner_proof', { correlationId });
        return;
      }
      provisionals.push({
        correlation_id: correlationId,
        candidate: {
          field: candidate?.field ?? null,
          value: candidate?.value == null ? null : String(candidate.value),
          board_id: candidate?.board_id ?? null,
          circuit: candidate?.circuit ?? null,
        },
        staged_acks: [],
        resolved_op_key: null,
      });
    },

    /** Stage an early ACK beside the provisional it correlates to. */
    stageFastAck(correlationId, ackBody) {
      const prov = provisionals.find((p) => p.correlation_id === correlationId);
      if (!prov) {
        markInvalid('fast_ack_without_provisional', { correlationId });
        return;
      }
      prov.staged_acks.push(ackBody);
    },

    /**
     * Atomic promotion: transcript correlation + the authoritative mutation
     * receipt resolve the provisional to EXACTLY one operation (server turn
     * + canonical slot + normalized value). Zero/multiple/mismatched
     * bindings make session evidence INVALID; process loss before binding is
     * never reconstructed.
     */
    promoteProvisional(correlationId, candidateOps) {
      const prov = provisionals.find((p) => p.correlation_id === correlationId);
      if (!prov) {
        markInvalid('fast_promotion_without_provisional', { correlationId });
        return;
      }
      const matches = (candidateOps ?? []).filter(
        (op) =>
          (op.field ?? null) === prov.candidate.field &&
          (op.value == null ? null : String(op.value)) === prov.candidate.value &&
          ((op.circuit ?? null) === prov.candidate.circuit ||
            prov.candidate.circuit == null ||
            op.circuit == null)
      );
      if (matches.length !== 1) {
        markInvalid(
          matches.length === 0 ? 'fast_promotion_unmatched' : 'fast_promotion_ambiguous',
          {
            correlationId,
            matches: matches.length,
          }
        );
        return;
      }
      const op = matches[0];
      prov.resolved_op_key = operationIdentityKey(op);
      this.recordDeliveryAttempt(op, { kind: 'fast_tts', transport: 'fast_tts' });
      for (const ack of prov.staged_acks) this.recordPlaybackAck(ack, [op]);
      prov.staged_acks = [];
    },

    /** Any provisional never consumed by a promotion invalidates evidence. */
    assertNoUnconsumedProvisionals() {
      const unconsumed = provisionals.filter((p) => p.resolved_op_key == null);
      if (unconsumed.length > 0) {
        markInvalid('fast_provisional_unconsumed', { count: unconsumed.length });
      }
      return unconsumed.length === 0;
    },

    /**
     * §B3 playback — an authenticated ACK becomes a playback_start only when
     * it resolves uniquely to ONE operation with ≥1 compatible
     * delivery_attempt. Byte-identical retransmissions dedupe by canonical
     * full-body hash; DISTINCT accepted bodies for the same operation are
     * distinct playback starts. A successful server send never synthesizes
     * playback.
     */
    recordPlaybackAck(ackBody, matchingOps) {
      const ops = matchingOps ?? [];
      if (ops.length !== 1) {
        markInvalid(ops.length === 0 ? 'playback_ack_unmatched' : 'playback_ack_ambiguous', {
          matches: ops.length,
        });
        return null;
      }
      const opKey = operationIdentityKey(ops[0]);
      if (!deliveries.some((d) => d.op_key === opKey)) {
        markInvalid('playback_without_delivery_attempt', { opKey });
        return null;
      }
      const hash = ackBodyHash(ackBody);
      if (playbacks.some((p) => p.op_key === opKey && p.ack_body_hash === hash)) {
        return null; // byte-identical retransmission — one start
      }
      const row = Object.freeze({ op_key: opKey, ack_body_hash: hash });
      playbacks.push(row);
      return row;
    },
  };
}
