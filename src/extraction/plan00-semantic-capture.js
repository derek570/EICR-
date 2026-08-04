/**
 * Plan 00B §B2 — authoritative semantic mutation capture.
 *
 * The trusted semantic oracle judges models at authoritative boundaries, and
 * for certificate state that boundary is the snapshot-mutation ATOM layer in
 * `stage6-snapshot-mutators.js` — never a staging/journal helper
 * (`recordReadingWrite`/`recordBoardReadingWrite` stage per-turn WIRE state;
 * they are an ordering/provenance OVERLAY here, nothing more).
 *
 * Production dormancy: the observer lives on a non-enumerable Symbol on the
 * evaluated session/snapshot. Every production-path helper below is a single
 * optional property lookup when no observer is attached; nothing allocates,
 * nothing serialises, no branch order changes. Only the evaluation harness
 * attaches observers.
 *
 * Verdict discipline: capture is behaviour-isolated but verdict-fatal. Any
 * copy/normalisation/provenance/lifecycle error marks the observer
 * INVALID/HOLD (`markInvalid`) — a partially-captured sample is never
 * compared or accepted.
 */

export const MUTATION_OBSERVER = Symbol('plan00.mutationObserver');

/** Semantic origins a producer boundary may declare (§B2). */
export const SEMANTIC_ORIGINS = Object.freeze([
  'model_direct',
  'ask_auto_resolve',
  'calculator',
  'silent_deterministic',
  'dialogue_script_direct',
  'dialogue_script_derived',
]);

/**
 * Attach a mutation observer to an evaluated target (session AND/OR its
 * stateSnapshot — atoms receive one or the other, so the harness attaches to
 * both). Non-enumerable; double-attach throws (double-counted evidence).
 */
export function attachMutationObserver(target, observer) {
  if (!target || typeof target !== 'object')
    throw new Error('attachMutationObserver: target required');
  if (!observer || typeof observer !== 'object')
    throw new Error('attachMutationObserver: observer required');
  if (target[MUTATION_OBSERVER])
    throw new Error('attachMutationObserver: observer already attached');
  Object.defineProperty(target, MUTATION_OBSERVER, {
    value: observer,
    enumerable: false,
    configurable: true,
  });
}

export function getMutationObserver(target) {
  return (target && target[MUTATION_OBSERVER]) || null;
}

/**
 * Emit one commit receipt for a REAL state change at an atom. Dormant no-op
 * (single Symbol lookup) without an observer. The atom passes only facts it
 * proved itself: kind, canonical slot identity, normalized stored value and
 * any previous value. Ordering, operation ids and origin/provenance are the
 * observer's job.
 */
export function emitMutationCommit(target, payload) {
  const observer = target && target[MUTATION_OBSERVER];
  if (!observer) return null;
  return observer.commit(payload);
}

/**
 * Producer-boundary origin frame. Producers (tool dispatch, ask
 * auto-resolve, calculators, dialogue engine, deterministic derivations)
 * declare WHAT is about to mutate and WHY — never inferred from stack
 * inspection. Dormant no-op without an observer.
 */
export function setMutationOriginFrame(target, frame) {
  const observer = target && target[MUTATION_OBSERVER];
  if (!observer) return;
  observer.setOriginFrame(frame);
}

export function clearMutationOriginFrame(target) {
  const observer = target && target[MUTATION_OBSERVER];
  if (!observer) return;
  observer.clearOriginFrame();
}

/**
 * The evaluation-side observer. Owns operation ids, total ordering, origin
 * frames, derived-parent provenance, the journal ordering/provenance overlay
 * join and the INVALID/HOLD latch.
 */
export function createMutationObserver({ sessionId = null } = {}) {
  let seq = 0;
  let opCounter = 0;
  const receipts = [];
  let originFrame = null;
  let invalid = null;

  const observer = {
    sessionId,
    get receipts() {
      return receipts;
    },
    get invalid() {
      return invalid;
    },

    markInvalid(reason, detail) {
      if (!invalid) invalid = Object.freeze({ reason, detail: detail ?? null });
    },

    setOriginFrame(frame) {
      if (!frame || typeof frame !== 'object' || typeof frame.origin !== 'string') {
        this.markInvalid('origin_frame_malformed', { frame });
        return;
      }
      if (!SEMANTIC_ORIGINS.includes(frame.origin)) {
        this.markInvalid('origin_unknown', { origin: frame.origin });
        return;
      }
      // Derived origins MUST carry real parent provenance at the producer
      // boundary (§B2): parent_operation_id + derivation_kind + exact source
      // slot. A derived frame without them is a capture error, not a guess.
      if (
        (frame.origin === 'dialogue_script_derived' || frame.origin === 'silent_deterministic') &&
        (!frame.parent_operation_id || !frame.derivation_kind || !frame.source_slot)
      ) {
        this.markInvalid('derived_provenance_missing', {
          origin: frame.origin,
          parent_operation_id: frame.parent_operation_id ?? null,
          derivation_kind: frame.derivation_kind ?? null,
          source_slot: frame.source_slot ?? null,
        });
        return;
      }
      originFrame = frame;
    },

    clearOriginFrame() {
      originFrame = null;
    },

    commit(payload) {
      try {
        if (!payload || typeof payload.kind !== 'string') {
          this.markInvalid('commit_malformed', { payload });
          return null;
        }
        // A commit with NO declared producer origin is an unattributed
        // mutation — the exact class the oracle exists to catch. It is
        // still recorded (the receipt stream must be complete) but the
        // sample is INVALID/HOLD unless the harness declared the frame.
        const frame = originFrame;
        if (!frame) this.markInvalid('commit_without_origin_frame', { kind: payload.kind });
        seq += 1;
        opCounter += 1;
        const receipt = Object.freeze({
          operation_id: `evalop-${opCounter}`,
          seq,
          kind: payload.kind,
          field: payload.field ?? null,
          board_id: payload.board_id ?? null,
          circuit: payload.circuit ?? null,
          value: payload.value ?? null,
          previous_value: payload.previous_value ?? null,
          detail: payload.detail ?? null,
          origin: frame?.origin ?? null,
          origin_meta: frame?.meta ?? null,
          parent_operation_id: frame?.parent_operation_id ?? null,
          derivation_kind: frame?.derivation_kind ?? null,
          source_slot: frame?.source_slot ?? null,
          // Filled by the journal overlay join, never at commit time.
          write_sequence: null,
          journal_source: null,
        });
        receipts.push(receipt);
        return receipt;
      } catch (err) {
        this.markInvalid('commit_threw', { message: err?.message });
        return null;
      }
    },

    /**
     * §B2 journal overlay — join the per-turn write journal's WRITE_SEQUENCE
     * and source metadata onto ALREADY-EXISTING commit receipts. A journal
     * row may legitimately have no receipt only when its declared source is
     * in `nonMutatingSources` (address-mirror source-ledger cloning stages
     * wire state without any snapshot mutation — it must emit ZERO commits).
     * Any other unmatched overlay row, or any receipt-slot double-claim,
     * makes capture INVALID/HOLD. Never creates a commit from a journal row.
     */
    joinJournalOverlay({ rows, writeSequenceOf, slotOf, nonMutatingSources = [] }) {
      try {
        const claimed = new Set();
        for (const row of rows) {
          const slot = slotOf(row);
          const source = row?.source ?? row?.journal_source ?? null;
          const match = receipts.find(
            (r) =>
              !claimed.has(r) &&
              r.write_sequence == null &&
              r.field === (slot.field ?? null) &&
              (r.circuit ?? null) === (slot.circuit ?? null) &&
              (slot.board_id == null || r.board_id == null || r.board_id === slot.board_id)
          );
          if (!match) {
            if (source && nonMutatingSources.includes(source)) continue;
            this.markInvalid('journal_overlay_unmatched', { slot, source });
            return;
          }
          claimed.add(match);
          // Receipts are frozen — the overlay is recorded as a parallel,
          // immutable annotation keyed by operation id.
          overlay.set(match.operation_id, {
            write_sequence: writeSequenceOf(row) ?? null,
            journal_source: source,
          });
        }
      } catch (err) {
        this.markInvalid('journal_overlay_threw', { message: err?.message });
      }
    },

    overlayFor(operationId) {
      return overlay.get(operationId) ?? null;
    },
  };

  const overlay = new Map();
  return observer;
}
