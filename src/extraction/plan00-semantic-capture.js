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
  // Plan 00B-2 C2.5 — evaluation-only turn scope. Harness turns enter after
  // runShadowHarness mints `extractionTurnId` (cleared in its outer finally);
  // Tier-2 engine turns enter in handleTranscript's region-local bracket
  // with the server-minted generationId. Every receipt records the OPEN
  // turn's id + a monotonic per-turn ordinal.
  let currentTurn = null; // { turnId, ordinal }
  // Plan 00B-2 C2.5 — regex fast-path correlation binding: each normalized
  // correlation id binds exactly once to the server-minted turn BEFORE live
  // execution. Re-binding is a capture error.
  const fastCorrelationTurns = new Map();

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

    /**
     * Enter an evaluation turn scope. A second enter while one is open
     * THROWS (capture INVALID first) — overlapping turn scopes would make
     * receipt→turn attribution ambiguous, the exact class the oracle holds.
     */
    enterTurnScope(turnId) {
      if (currentTurn) {
        this.markInvalid('turn_scope_reentered', {
          open_turn_id: currentTurn.turnId,
          requested_turn_id: turnId ?? null,
        });
        throw new Error('plan00: enterTurnScope while a turn scope is open');
      }
      if (typeof turnId !== 'string' || turnId.length === 0) {
        this.markInvalid('turn_scope_id_malformed', { turnId: turnId ?? null });
        throw new Error('plan00: enterTurnScope requires a non-empty turn id');
      }
      currentTurn = { turnId, ordinal: 0 };
    },

    exitTurnScope() {
      currentTurn = null;
    },

    get openTurnId() {
      return currentTurn?.turnId ?? null;
    },

    /** Bind a normalized regex fast-path correlation id to the OPEN turn. */
    bindFastCorrelation(correlationId) {
      if (!correlationId) return;
      if (!currentTurn) {
        this.markInvalid('fast_correlation_outside_turn', { correlationId });
        return;
      }
      if (fastCorrelationTurns.has(correlationId)) {
        this.markInvalid('fast_correlation_rebound', { correlationId });
        return;
      }
      fastCorrelationTurns.set(correlationId, currentTurn.turnId);
    },

    fastCorrelationTurn(correlationId) {
      return fastCorrelationTurns.get(correlationId) ?? null;
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
      // Producers name their trigger by SLOT (field/board/circuit) — they
      // cannot know evaluation-owned operation ids. `parent_slot` is
      // resolved to the triggering receipt at commit time; a direct
      // `parent_operation_id` is also accepted (tests / replays).
      if (
        (frame.origin === 'dialogue_script_derived' || frame.origin === 'silent_deterministic') &&
        (!(frame.parent_operation_id || frame.parent_slot) ||
          !frame.derivation_kind ||
          !frame.source_slot)
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
        // Resolve a slot-named parent to the most recent matching receipt.
        // A derived commit whose declared trigger slot matches NO earlier
        // receipt is a provenance failure (§B2: missing/wrong parent is
        // semantic FAIL), latched as INVALID while the receipt still
        // records for completeness.
        let resolvedParentId = frame?.parent_operation_id ?? null;
        if (!resolvedParentId && frame?.parent_slot) {
          const ps = frame.parent_slot;
          const parent = [...receipts]
            .reverse()
            .find(
              (r) =>
                r.field === (ps.field ?? null) &&
                (r.circuit ?? null) === (ps.circuit ?? null) &&
                (ps.board_id == null || r.board_id == null || r.board_id === ps.board_id)
            );
          if (parent) resolvedParentId = parent.operation_id;
          else this.markInvalid('derived_parent_unresolved', { parent_slot: ps });
        }
        seq += 1;
        opCounter += 1;
        if (currentTurn) currentTurn.ordinal += 1;
        const receipt = Object.freeze({
          operation_id: `evalop-${opCounter}`,
          seq,
          // Plan 00B-2 C2.5 — turn-scoped operation identity. Null outside a
          // turn scope (constructor hydration / input_state_seed writes).
          extraction_turn_id: currentTurn?.turnId ?? null,
          turn_ordinal: currentTurn?.ordinal ?? null,
          kind: payload.kind,
          field: payload.field ?? null,
          board_id: payload.board_id ?? null,
          circuit: payload.circuit ?? null,
          value: payload.value ?? null,
          previous_value: payload.previous_value ?? null,
          detail: payload.detail ?? null,
          origin: frame?.origin ?? null,
          origin_meta: frame?.meta ?? null,
          parent_operation_id: resolvedParentId,
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
    joinJournalOverlay({
      rows,
      writeSequenceOf,
      slotOf,
      nonMutatingSources = [],
      extractionTurnId = null,
    }) {
      try {
        const claimed = new Set();
        for (const row of rows) {
          const slot = slotOf(row);
          const source = row?.source ?? row?.journal_source ?? null;
          const match = receipts.find(
            (r) =>
              !claimed.has(r) &&
              r.write_sequence == null &&
              // Plan 00B-2 C2.5 — turn-aware overlay: a per-turn journal may
              // only claim receipts committed inside the SAME server turn.
              (extractionTurnId == null || r.extraction_turn_id === extractionTurnId) &&
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
