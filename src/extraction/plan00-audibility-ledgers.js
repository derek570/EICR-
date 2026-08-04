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

/**
 * Plan 00B-2 C2 — evaluation-only per-turn emission observer Symbols.
 *
 * Both are stamped PER-TURN beside the production `ASK_STARTED_OBSERVER`
 * (assign at turn start, identity-compare delete at turn end) by
 * runLiveMode's entry-resolution seam and by handleTranscript's Tier-2
 * dialogue wrapper region. `safeSend` (dialogue engine) and the dispatcher
 * emission sites read them via a single dormant optional-chain lookup —
 * nothing is stamped, read or allocated outside an evaluation run.
 *
 * PLAN00_ASK_EMIT_OBSERVER receives every `ask_user_started` payload whose
 * `expected_answer_shape !== 'none'` (the ask-ledger admission rule — a
 * `'none'` frame is dialogue speech, not an ask, and routes through the
 * delivery observer instead).
 *
 * PLAN00_DELIVERY_EMIT_OBSERVER is the prepare/commit/abort seam for
 * dialogue audible payloads carrying a PLAN00_AUDIBILITY_DESCRIPTOR (an
 * ordered list of the mutation slot identities the spoken prose
 * acknowledges) — and the classification sink for descriptor-less
 * non-mutating speech.
 */
export const PLAN00_ASK_EMIT_OBSERVER = Symbol('plan00.askEmitObserver');
export const PLAN00_DELIVERY_EMIT_OBSERVER = Symbol('plan00.deliveryEmitObserver');

/**
 * Plan 00B-2 C2.5 — evaluation-only audibility descriptor. Attached
 * NON-ENUMERABLY to the actual SPOKEN dialogue payload (never the UI-only
 * extraction payload) by the producer that knows which receipts its prose
 * acknowledges. Shape: { operations: [{field, circuit, board_id, value}] }
 * in spoken-acknowledgement order.
 */
export const PLAN00_AUDIBILITY_DESCRIPTOR = Symbol('plan00.audibilityDescriptor');

/**
 * Plan 00B-2 C2.5 — replay-stable frame binding registry, stamped
 * NON-ENUMERABLY on the RAW RESULT object at first bundle-to-frames. Keys
 * are `${frameIndex}:${frameKind}` (the ledger rebuild is deterministic
 * from the result, so the key is stable across resume replays); values are
 * { bindingId, attempts } and survive until the result's durable terminal.
 */
export const PLAN00_FRAME_BINDING_REGISTRY = Symbol('plan00.frameBindingRegistry');

/**
 * Attach an audibility descriptor to a spoken payload. Dormant unless the
 * caller has already proven an evaluation observer is present (the callers
 * guard on ws[PLAN00_DELIVERY_EMIT_OBSERVER] — a single Symbol lookup — so
 * production never allocates here).
 */
export function attachAudibilityDescriptor(payload, operations) {
  if (!payload || typeof payload !== 'object') return payload;
  Object.defineProperty(payload, PLAN00_AUDIBILITY_DESCRIPTOR, {
    value: Object.freeze({
      operations: Object.freeze(
        (operations ?? []).map((op) =>
          Object.freeze({
            field: op.field ?? null,
            circuit: op.circuit ?? null,
            board_id: op.board_id ?? null,
            value: op.value == null ? null : String(op.value),
          })
        )
      ),
    }),
    enumerable: false,
    configurable: true,
  });
  return payload;
}

export function getAudibilityDescriptor(payload) {
  return (payload && payload[PLAN00_AUDIBILITY_DESCRIPTOR]) || null;
}

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

    /**
     * Stage 1 — semantic production, pre-wire, pre-lossy-projection.
     * Plan 00B-3 C1 — every transition method returns an explicit VERDICT
     * `{accepted, reason}` and the caller derives the sub-record from it
     * (one derivation, never a parallel append beside the ledger).
     */
    produced(liveAskKey, meta = {}) {
      entries.push({
        key: liveAskKey,
        state: 'produced',
        runtime_id: null,
        meta,
        history: ['produced'],
      });
      return { accepted: true, reason: null };
    },

    /**
     * Stage 2 — successful send. Binds the runtime id to exactly ONE
     * unmatched produced declaration with the same key. Zero or multiple
     * candidates, or an id already claimed, is a ledger failure.
     */
    emitted(liveAskKey, runtimeId) {
      if (entries.some((e) => e.runtime_id === runtimeId)) {
        markInvalid('runtime_id_already_bound', { runtimeId });
        return { accepted: false, reason: 'runtime_id_already_bound' };
      }
      const candidates = entries.filter((e) => e.key === liveAskKey && e.state === 'produced');
      if (candidates.length !== 1) {
        const reason =
          candidates.length === 0 ? 'emitted_without_produced' : 'ambiguous_produced_match';
        markInvalid(reason, {
          liveAskKey,
          candidates: candidates.length,
        });
        return { accepted: false, reason };
      }
      candidates[0].state = 'emitted';
      candidates[0].runtime_id = runtimeId;
      candidates[0].history.push('emitted');
      return { accepted: true, reason: null };
    },

    /**
     * Stage 3 — terminal resolution from the REAL ingress. For `answered`,
     * the frame id must equal the outstanding emitted id; a logged prefix is
     * never proof. Non-answered terminals (timeout, user_moved_on,
     * session_stopped, superseded, reissued) close the entry with that class.
     *
     * Plan 00B-3 C1 (SANCTIONED ledger change, schema-v1 rejection_reasons):
     * `answered_without_full_proof` is a TRANSITION REJECTION, not a
     * structural contradiction — it returns `{accepted:false}` WITHOUT
     * latching invalid and leaves the entry 'emitted' (still open, so it
     * counts non-quiescent at stop). Invalid latches are reserved for
     * structural contradictions (`resolution_without_emitted`,
     * `runtime_id_already_bound`, ...).
     */
    resolved(runtimeId, terminal, detail = {}) {
      const entry = entries.find((e) => e.runtime_id === runtimeId && e.state === 'emitted');
      if (!entry) {
        markInvalid('resolution_without_emitted', { runtimeId, terminal });
        return { accepted: false, reason: 'resolution_without_emitted' };
      }
      if (terminal === 'answered') {
        // §B3: answered requires BOTH the direct answer frame id match AND
        // the paired transcript reaching engine resolution.
        if (detail.answer_frame_id !== runtimeId || detail.transcript_resolved !== true) {
          return { accepted: false, reason: 'answered_without_full_proof' };
        }
      }
      entry.state = terminal;
      entry.terminal_detail = detail;
      entry.history.push(terminal);
      return { accepted: true, reason: null };
    },

    /**
     * Plan 00B-2 C2.3 — deterministic reissue, SAME runtime id. The only
     * production same-id re-send is the reconnect/resume replay of the
     * address-mirror direct question: the emission attempt appends to the
     * SAME open entry's history — no second produced row, no terminal.
     */
    reissuedAttempt(runtimeId) {
      const entry = entries.find((e) => e.runtime_id === runtimeId && e.state === 'emitted');
      if (!entry) {
        markInvalid('reissue_without_emitted', { runtimeId });
        return { accepted: false, reason: 'reissue_without_emitted' };
      }
      entry.history.push('reissued_attempt');
      return { accepted: true, reason: null };
    },

    /**
     * Plan 00B-2 C2.3 — REPLACEMENT ask linkage (new runtime id, e.g. every
     * `pvr-*`/`mdr-*` broker re-ask). An OPEN predecessor terminal-resolves
     * as `reissued` with a successor link; an already-terminal predecessor
     * only gains the link (never re-opened — `transitioned:false`, so the
     * caller appends no transition row for a link-only annotation).
     */
    linkReplacement(predecessorRuntimeId, successorRuntimeId) {
      const entry = entries.find((e) => e.runtime_id === predecessorRuntimeId);
      if (!entry) {
        markInvalid('replacement_predecessor_unknown', {
          predecessorRuntimeId,
          successorRuntimeId,
        });
        return { accepted: false, reason: 'replacement_predecessor_unknown', transitioned: false };
      }
      if (entry.state === 'emitted' || entry.state === 'produced') {
        entry.state = 'reissued';
        entry.terminal_detail = { successor_runtime_id: successorRuntimeId };
        entry.history.push('reissued');
        return { accepted: true, reason: null, transitioned: true };
      }
      entry.terminal_detail = {
        ...(entry.terminal_detail ?? {}),
        successor_runtime_id: successorRuntimeId,
      };
      return { accepted: true, reason: null, transitioned: false };
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
     *
     * Plan 00B-2 C2.5 — a single spoken frame genuinely acknowledging
     * MULTIPLE writes (the address-mirror collapsed terminal, bulk/grouped
     * dialogue lines) passes an ARRAY of op identities and forms ONE
     * multi-operation audibility unit: `op_key` stays the first identity
     * (back-compat), `op_keys` carries the ordered full set.
     */
    recordDeliveryAttempt(
      opIdentity,
      {
        kind,
        transport = null,
        claimLineage = null,
        text = null,
        wireTurnId = null,
        dedupeToken = null,
        // Plan 00B-3 C3 — the registry producer id + its derived semantic
        // family, stamped on the LEDGER row too so the frozen-ledger
        // projection can derive families identically to sub_records.
        producerId = null,
        semanticFamily = null,
        correlationId = null,
      } = {}
    ) {
      seq += 1;
      const identities = Array.isArray(opIdentity) ? opIdentity : [opIdentity];
      const opKeys = identities.map((op) => operationIdentityKey(op));
      const row = Object.freeze({
        op_key: opKeys[0] ?? null,
        op_keys: Object.freeze(opKeys),
        kind: kind ?? 'confirmation',
        transport,
        producer_id: producerId,
        semantic_family: semanticFamily,
        claim_lineage: claimLineage,
        // Plan 00B-2 C4 — the SPOKEN text of the delivery (evaluation-only
        // judging surface for text_exact matchers; null for producers that
        // carry no prose). NEVER copied onto sub-records (00C PII rule).
        text,
        // Codex r2 finding 7 — the WIRE turn id (result.turn_id) the
        // client echoes on its playback ACK, so ACK resolution can bind
        // turn-exactly instead of crediting a stale/other-turn ACK.
        wire_turn_id: wireTurnId,
        // Mini-review r2 finding 5 — the wire dedupe_token (for a
        // field_cleared confirmation it is `clear_<field>_…`, the only
        // structured carrier of WHICH field was cleared).
        dedupe_token: dedupeToken,
        correlation_id: correlationId,
        at_seq: seq,
        // Plan 00B-3 C5 — the stable, replay-stable delivery ref the
        // dialogue_hearing_attestation event and the fold's exactly-once
        // rules resolve against (deterministic from the ledger sequence).
        delivery_ref: `d:${seq}`,
      });
      deliveries.push(row);
      return row;
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

    /** Plan 00B-2 C3 — freeze-time evidence projection of the ambiguous set. */
    ambiguousOpKeys() {
      return [...ambiguousOps];
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

    /**
     * Plan 00B-2 C2.7 — remove a fast-TTS reservation with NO delivery
     * evidence: close-before-finish, synthesis failure or owner
     * disappearance. Withdrawing an unknown correlation id is a no-op (the
     * reservation may never have been created on a declined route).
     */
    withdrawProvisional(correlationId) {
      const idx = provisionals.findIndex((p) => p.correlation_id === correlationId);
      if (idx >= 0) provisionals.splice(idx, 1);
    },

    /** Stage an early ACK beside the provisional it correlates to. */
    stageFastAck(correlationId, ackBody) {
      const prov = provisionals.find((p) => p.correlation_id === correlationId);
      if (!prov) {
        markInvalid('fast_ack_without_provisional', { correlationId });
        return { accepted: false, reason: 'fast_ack_without_provisional' };
      }
      prov.staged_acks.push(ackBody);
      return { accepted: true, reason: null };
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
        return { accepted: false, reason: 'fast_promotion_without_provisional' };
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
        const reason =
          matches.length === 0 ? 'fast_promotion_unmatched' : 'fast_promotion_ambiguous';
        markInvalid(reason, {
          correlationId,
          matches: matches.length,
        });
        return { accepted: false, reason };
      }
      const op = matches[0];
      prov.resolved_op_key = operationIdentityKey(op);
      const deliveryRow = this.recordDeliveryAttempt(op, {
        kind: 'fast_tts',
        transport: 'fast_tts',
        producerId: 'fast_tts_promotion',
        semanticFamily: 'fast_tts',
        correlationId,
      });
      // Mini-review r2 finding 2 — count AUTHORITATIVE playback rows (a
      // byte-identical retry ACK dedupes to one row; counting staged
      // BODIES would hand 00C contradictory evidence). Plan 00B-3 C5 — the
      // per-ACK authoritative rows (with their body hashes) are returned so
      // the caller can append one playback sub-record PER start.
      const playbackRows = [];
      for (const ack of prov.staged_acks) {
        const verdict = this.recordPlaybackAck(ack, [op], {
          producerId: 'fast_tts_staged_ack',
          semanticFamily: 'fast_tts',
          transport: 'http_playback_ack',
          source: 'fast_tts',
        });
        if (verdict.accepted === 'authoritative') playbackRows.push(verdict.row);
      }
      prov.staged_acks = [];
      // Codex r2 finding 2 — the caller's lifecycle sub-record needs the
      // resolved identity + the authoritative playback starts recorded, so
      // the frozen builder snapshot carries real op_keys/playback evidence.
      return {
        accepted: true,
        reason: null,
        op,
        playback_count: playbackRows.length,
        playback_rows: playbackRows,
        delivery_row: deliveryRow,
      };
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
    recordPlaybackAck(
      ackBody,
      matchingOps,
      { producerId = null, semanticFamily = null, transport = null, source = null } = {}
    ) {
      const ops = matchingOps ?? [];
      if (ops.length !== 1) {
        const reason = ops.length === 0 ? 'playback_ack_unmatched' : 'playback_ack_ambiguous';
        markInvalid(reason, {
          matches: ops.length,
        });
        return { accepted: false, reason, matches: ops.length, row: null, existing: null };
      }
      const opKey = operationIdentityKey(ops[0]);
      if (!deliveries.some((d) => d.op_key === opKey)) {
        markInvalid('playback_without_delivery_attempt', { opKey });
        return {
          accepted: false,
          reason: 'playback_without_delivery_attempt',
          matches: 1,
          row: null,
          existing: null,
        };
      }
      const hash = ackBodyHash(ackBody);
      const existing = playbacks.find((p) => p.op_key === opKey && p.ack_body_hash === hash);
      if (existing) {
        // Plan 00B-3 C1 ternary — byte-identical retransmission: an
        // accepted-IDEMPOTENT verdict keyed to the EXISTING authoritative
        // event; never a second start, never invalidating.
        return { accepted: 'idempotent', reason: null, row: null, existing };
      }
      const row = Object.freeze({
        op_key: opKey,
        ack_body_hash: hash,
        producer_id: producerId,
        semantic_family: semanticFamily,
        transport,
        source,
      });
      playbacks.push(row);
      return { accepted: 'authoritative', reason: null, row, existing: null };
    },
  };
}
