/**
 * Plan 00B (live-lane follow-ups) C3 — the bounded capture/row budget.
 *
 * Every per-session evidence collection in the Plan-00 lane is append-only and
 * grows with the SESSION rather than with a turn, so a long production session
 * had no upper bound on evidence memory. C3 puts ONE shared counter in front of
 * every one of those growth sites, with capacity reserved for exactly one
 * overflow marker row.
 *
 * These tests prove the two halves the plan asks for, PER COLLECTION:
 *
 *  1. MEMORY BOUNDEDNESS — past the budget the collection stops growing, while
 *     the production verdict / return contract of the call is byte-identical
 *     (an evidence-side skip must never be visible to the inspector).
 *  2. ZERO FAMILY CREDIT AFTERWARDS — the first refusal latches every evidence
 *     role INVALID and mints the one reserved `capture_budget_overflow` row, so
 *     a truncated evidence stream can never fold as complete.
 *
 * The `staged_acks` case gets its own block because it is the site a row count
 * could never have seen: repeated ACKs against ONE correlation id grow a NESTED
 * array without adding a single top-level row.
 */

import {
  PLAN00_CAPTURE_SITES,
  PLAN00_CAPTURE_ROW_BUDGET,
  CAPTURE_BUDGET_OVERFLOW_KIND,
  createCaptureBudget,
  makeBudgetHolder,
} from '../extraction/plan00-capture-budget.js';
import {
  createAskLedger,
  createDeliveryLedger,
  buildLiveAskKey,
} from '../extraction/plan00-audibility-ledgers.js';
import { createMutationObserver } from '../extraction/plan00-semantic-capture.js';
import {
  normaliseEvaluationContext,
  attachEvaluationContext,
  freezeEvidenceCompletion,
  getLifecycleLedger,
} from '../extraction/plan00-lifecycle-hooks.js';
import {
  buildEvidenceProjectionV1,
  projectFrozenLedgersV1,
} from '../extraction/plan00-evidence-projection.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const askKey = (n) =>
  buildLiveAskKey({
    origin: 'dispatcher',
    purpose: `p_${n}`,
    reason: null,
    contextField: null,
    boardId: null,
    circuits: [],
    expectedAnswerShape: 'number',
    observationClarificationKind: null,
    pendingWrite: null,
    chainRole: null,
  });

const op = (n) => ({
  extractionTurnId: `turn_${n}`,
  field: 'measured_zs_ohm',
  circuit: n,
  boardId: null,
  ordinal: 0,
});

/** A role wired to a deliberately tiny shared budget. */
function withBudget(role, limit) {
  const budget = createCaptureBudget({ limit });
  role.adoptCaptureBudget(budget);
  return budget;
}

describe('capture budget — the primitive', () => {
  test('the production constants are pinned (changing them is a reviewed decision)', () => {
    expect(PLAN00_CAPTURE_ROW_BUDGET).toBe(20000);
    expect(CAPTURE_BUDGET_OVERFLOW_KIND).toBe('capture_budget_overflow');
    expect(PLAN00_CAPTURE_SITES).toHaveLength(19);
    expect(Object.isFrozen(PLAN00_CAPTURE_SITES)).toBe(true);
    // no duplicate site names — two collections sharing one name would make
    // the structural completeness net below silently pass while a growth
    // site went un-enumerated.
    expect(new Set(PLAN00_CAPTURE_SITES).size).toBe(PLAN00_CAPTURE_SITES.length);
  });

  test('admits exactly `limit` writes, then refuses forever', () => {
    const budget = createCaptureBudget({ limit: 2 });
    expect(budget.limit).toBe(2);
    expect(budget.admit('lifecycle_row')).toBe(true);
    expect(budget.admit('lifecycle_row')).toBe(true);
    expect(budget.admitted).toBe(2);
    for (let i = 0; i < 50; i += 1) expect(budget.admit('lifecycle_row')).toBe(false);
    // the counter itself is bounded too — a refused admit never increments
    expect(budget.admitted).toBe(2);
    expect(budget.overflowed).toBe(true);
  });

  test('a non-positive / non-integer limit falls back to the production budget', () => {
    for (const limit of [0, -1, 1.5, null, 'many']) {
      expect(createCaptureBudget({ limit }).limit).toBe(PLAN00_CAPTURE_ROW_BUDGET);
    }
    expect(createCaptureBudget().limit).toBe(PLAN00_CAPTURE_ROW_BUDGET);
  });

  test('the overflow sink fires EXACTLY once, on the first refusal, with the refused site', () => {
    const budget = createCaptureBudget({ limit: 2 });
    const calls = [];
    budget.onFirstOverflow((detail) => calls.push(detail));
    budget.admit('ask_entry');
    budget.admit('ask_history');
    expect(calls).toEqual([]);
    budget.admit('staged_ack');
    for (let i = 0; i < 20; i += 1) budget.admit('delivery_row');
    expect(calls).toEqual([{ site: 'staged_ack', limit: 2, admitted: 2 }]);
  });

  test('sink registration is first-wins (a re-attached context cannot mint a second marker)', () => {
    const budget = createCaptureBudget({ limit: 1 });
    const first = [];
    const second = [];
    budget.onFirstOverflow(() => first.push(1));
    budget.onFirstOverflow(() => second.push(1));
    budget.onFirstOverflow('not a function');
    budget.admit('lifecycle_row');
    budget.admit('lifecycle_row');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test('a throwing sink is isolated — admit still returns false and never rethrows', () => {
    const budget = createCaptureBudget({ limit: 1 });
    budget.onFirstOverflow(() => {
      throw new Error('evidence sink blew up');
    });
    budget.admit('lifecycle_row');
    expect(() => expect(budget.admit('lifecycle_row')).toBe(false)).not.toThrow();
    expect(budget.admit('lifecycle_row')).toBe(false);
  });

  test('a non-string site degrades to null rather than leaking a value into the marker row', () => {
    const budget = createCaptureBudget({ limit: 1 });
    const calls = [];
    budget.onFirstOverflow((d) => calls.push(d));
    budget.admit('lifecycle_row');
    budget.admit({ secret: 'pii' });
    expect(calls).toEqual([{ site: null, limit: 1, admitted: 1 }]);
  });

  test('makeBudgetHolder starts private and adopts the shared budget first-wins', () => {
    const holder = makeBudgetHolder();
    const priv = holder.current;
    expect(priv.limit).toBe(PLAN00_CAPTURE_ROW_BUDGET);
    const shared = createCaptureBudget({ limit: 3 });
    holder.adopt(shared);
    expect(holder.current).toBe(shared);
    // a second adoption would RESET the ceiling mid-session — ignored
    holder.adopt(createCaptureBudget({ limit: 999 }));
    expect(holder.current).toBe(shared);
    // and a malformed / absent shared budget never displaces the private one
    const other = makeBudgetHolder();
    other.adopt(null);
    other.adopt({ nope: true });
    expect(other.current.limit).toBe(PLAN00_CAPTURE_ROW_BUDGET);
  });
});

describe('capture budget — structural completeness of the site enumeration', () => {
  // The enumeration only means anything if it is EXHAUSTIVE. A new unbounded
  // collection must declare a new site here rather than quietly borrowing an
  // existing name — and every declared site must actually be spent somewhere,
  // or the list is documenting a gate that does not exist.
  const FILES = [
    'src/extraction/plan00-lifecycle-hooks.js',
    'src/extraction/plan00-audibility-ledgers.js',
    'src/extraction/plan00-semantic-capture.js',
  ];

  const used = new Set();
  for (const rel of FILES) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const m of text.matchAll(/admit\('([a-z_]+)'\)/g)) used.add(m[1]);
  }

  test('every literal admit() site in production source is a registered member', () => {
    const unregistered = [...used].filter((s) => !PLAN00_CAPTURE_SITES.includes(s));
    expect(unregistered).toEqual([]);
  });

  test('every registered member is genuinely spent at a production site', () => {
    const unused = PLAN00_CAPTURE_SITES.filter((s) => !used.has(s));
    expect(unused).toEqual([]);
  });
});

describe('capture budget — ask ledger collections', () => {
  test('ask_entry: declarations stop being retained, the verdict is unchanged', () => {
    const ledger = createAskLedger();
    withBudget(ledger, 1);
    expect(ledger.produced(askKey(1), {})).toEqual({ accepted: true, reason: null });
    expect(ledger.produced(askKey(2), {})).toEqual({ accepted: true, reason: null });
    expect(ledger.produced(askKey(3), {})).toEqual({ accepted: true, reason: null });
    expect(ledger.entries).toHaveLength(1);
  });

  test('ask_history: the STATE transition still applies, only the trail is budgeted', () => {
    const ledger = createAskLedger();
    withBudget(ledger, 2); // 1 × ask_entry + 1 × ask_history
    ledger.produced(askKey(1), {});
    ledger.emitted(askKey(1), 'r1');
    expect(ledger.entries[0].history).toEqual(['produced', 'emitted']);

    // the reconnect/resume replay trail is the clearest per-entry growth site
    for (let i = 0; i < 25; i += 1) {
      expect(ledger.reissuedAttempt('r1')).toEqual({ accepted: true, reason: null });
    }
    expect(ledger.entries[0].history).toEqual(['produced', 'emitted']);

    // and a terminal still transitions the entry — the semantic content of the
    // ledger is never budgeted away, only the audit trail beside it
    expect(ledger.resolved('r1', 'session_stopped')).toEqual({ accepted: true, reason: null });
    expect(ledger.entries[0].state).toBe('session_stopped');
    expect(ledger.entries[0].history).toEqual(['produced', 'emitted']);
    expect(ledger.open()).toEqual([]);
  });
});

describe('capture budget — delivery ledger collections', () => {
  test('delivery_row: the row is still BUILT and RETURNED, just not retained', () => {
    const ledger = createDeliveryLedger();
    withBudget(ledger, 1);
    const first = ledger.recordDeliveryAttempt(op(1), { kind: 'confirmation' });
    const second = ledger.recordDeliveryAttempt(op(2), { kind: 'confirmation' });
    expect(ledger.deliveries).toHaveLength(1);
    // the caller's contract — sequence, delivery_ref, frozen shape — is intact
    expect(first.delivery_ref).toBe('d:1');
    expect(second.delivery_ref).toBe('d:2');
    expect(second.at_seq).toBe(2);
    expect(Object.isFrozen(second)).toBe(true);
  });

  test('ambiguous_op_key: the ambiguity set stops growing', () => {
    const ledger = createDeliveryLedger();
    withBudget(ledger, 1);
    ledger.markDeliveryHistoryAmbiguous(op(1));
    ledger.markDeliveryHistoryAmbiguous(op(2));
    expect(ledger.ambiguousOpKeys()).toHaveLength(1);
    expect(ledger.isDeliveryHistoryAmbiguous(op(1))).toBe(true);
    expect(ledger.isDeliveryHistoryAmbiguous(op(2))).toBe(false);
  });

  test('provisional: refusal is NOT a latch (the owner proof still passed)', () => {
    const ledger = createDeliveryLedger();
    withBudget(ledger, 1);
    for (let i = 0; i < 5; i += 1) {
      ledger.recordProvisionalFastDelivery({
        correlationId: `c${i}`,
        ownerVerified: true,
        candidate: { field: 'measured_zs_ohm', value: '0.5', circuit: i },
      });
    }
    expect(ledger.provisionals).toHaveLength(1);
    // the budget's own latch is claimed by the shared sink, not here — a
    // budget refusal must never masquerade as a missing-owner-proof failure
    expect(ledger.invalid).toBeNull();
  });

  test('playback_row: an authoritative verdict is returned even when the row is dropped', () => {
    const ledger = createDeliveryLedger();
    withBudget(ledger, 2); // 1 × delivery_row + 1 × playback_row
    ledger.recordDeliveryAttempt(op(1), { kind: 'confirmation' });
    const first = ledger.recordPlaybackAck({ ack: 1 }, [op(1)], {
      producerId: 'playback_ack_slot',
    });
    const second = ledger.recordPlaybackAck({ ack: 2 }, [op(1)], {
      producerId: 'playback_ack_slot',
    });
    expect(first.accepted).toBe('authoritative');
    expect(second.accepted).toBe('authoritative');
    expect(second.row).not.toBeNull();
    expect(ledger.playbacks).toHaveLength(1);
    expect(ledger.invalid).toBeNull();
  });
});

describe('capture budget — the NESTED staged_acks site', () => {
  // The plan names this one explicitly: repeated ACKs against ONE correlation
  // id grow `prov.staged_acks` without adding a provisional, delivery,
  // playback or lifecycle row — so no top-level row count could ever see it.
  function seed(limit) {
    const ledger = createDeliveryLedger();
    const budget = withBudget(ledger, limit);
    const fired = [];
    budget.onFirstOverflow((d) => fired.push(d));
    ledger.recordProvisionalFastDelivery({
      correlationId: 'c1',
      ownerVerified: true,
      candidate: { field: 'measured_zs_ohm', value: '0.5', circuit: 2 },
    });
    return { ledger, budget, fired };
  }

  test('memory is bounded, ACK handling is byte-identical, one overflow marker', () => {
    const { ledger, fired } = seed(3); // 1 × provisional + 2 × staged_ack
    const verdicts = [];
    for (let i = 0; i < 40; i += 1) verdicts.push(ledger.stageFastAck('c1', { ack: i }));

    // production handling is IDENTICAL for admitted and refused ACKs
    expect(verdicts).toHaveLength(40);
    for (const v of verdicts) expect(v).toEqual({ accepted: true, reason: null });

    // …but memory stopped growing
    expect(ledger.provisionals[0].staged_acks).toHaveLength(2);

    // …and exactly one overflow was signalled, naming the nested site
    expect(fired).toEqual([{ site: 'staged_ack', limit: 3, admitted: 3 }]);
  });

  test('no top-level collection grew — a row count alone could never have caught this', () => {
    const { ledger } = seed(3);
    for (let i = 0; i < 40; i += 1) ledger.stageFastAck('c1', { ack: i });
    expect(ledger.deliveries).toHaveLength(0);
    expect(ledger.playbacks).toHaveLength(0);
    expect(ledger.provisionals).toHaveLength(1);
  });

  test('an unknown correlation stays PRE-ADMISSION telemetry and spends no budget', () => {
    const { ledger, budget } = seed(10);
    const before = budget.admitted;
    expect(ledger.stageFastAck('nope', { ack: 1 })).toEqual({
      accepted: false,
      reason: 'fast_ack_without_provisional',
      preAdmission: true,
    });
    expect(budget.admitted).toBe(before);
    expect(ledger.invalid).toBeNull();
  });
});

describe('capture budget — mutation observer collections', () => {
  test('mutation_receipt: the receipt is still built and RETURNED, just not retained', () => {
    const obs = createMutationObserver({ sessionId: 'sess_budget' });
    withBudget(obs, 1);
    obs.setOriginFrame({ origin: 'model_direct' });
    const first = obs.commit({ kind: 'record_reading', field: 'measured_zs_ohm', circuit: 1 });
    const second = obs.commit({ kind: 'record_reading', field: 'measured_zs_ohm', circuit: 2 });
    expect(first.operation_id).toBe('evalop-1');
    expect(second.operation_id).toBe('evalop-2');
    expect(obs.receipts).toHaveLength(1);
    // a budget refusal must not be mistaken for an unattributed commit
    expect(obs.invalid).toBeNull();
  });

  test('fast_correlation_turn: the binding map stops growing, no latch, no return change', () => {
    const obs = createMutationObserver({ sessionId: 'sess_budget' });
    withBudget(obs, 1);
    expect(obs.enterTurnScope('t1')).toBe(true);
    obs.bindFastCorrelation('corr-1');
    obs.bindFastCorrelation('corr-2');
    expect(obs.fastCorrelationTurn('corr-1')).toBe('t1');
    expect(obs.fastCorrelationTurn('corr-2')).toBeNull();
    expect(obs.invalid).toBeNull();
  });

  test('journal_overlay: the receipt CLAIM still stands, only the annotation is budgeted', () => {
    const obs = createMutationObserver({ sessionId: 'sess_budget' });
    withBudget(obs, 1); // spent by the receipt below
    obs.setOriginFrame({ origin: 'model_direct' });
    const receipt = obs.commit({ kind: 'record_reading', field: 'measured_zs_ohm', circuit: 1 });
    obs.joinJournalOverlay({
      rows: [{ field: 'measured_zs_ohm', circuit: 1, write_sequence: 7, source: 'record_reading' }],
      writeSequenceOf: (r) => r.write_sequence,
      slotOf: (r) => ({ field: r.field, circuit: r.circuit, board_id: null }),
    });
    // the row MATCHED a receipt (so no `journal_overlay_unmatched` latch and no
    // double-claim window) — only the unbounded annotation map stopped growing
    expect(obs.invalid).toBeNull();
    expect(obs.overlayFor(receipt.operation_id)).toBeNull();
  });
});

describe('capture budget — full evidence context, zero family credit after overflow', () => {
  function composeOverflowedSession({ sessionId = 'sess_overflow', limit = 2 } = {}) {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
    };
    // Adopt the tiny budget into every role BEFORE normalisation, so the
    // roles' first-wins adoption lands on it rather than the default.
    const budget = createCaptureBudget({ limit });
    const askLedger = createAskLedger();
    const deliveryLedger = createDeliveryLedger();
    const mutationObserver = createMutationObserver({ sessionId });
    for (const role of [askLedger, deliveryLedger, mutationObserver]) {
      role.adoptCaptureBudget(budget);
    }
    const ctx = normaliseEvaluationContext(
      {
        observer: { buildCandidate: (snap) => snap, publish: () => {} },
        mutationObserver,
        askLedger,
        deliveryLedger,
      },
      { sessionId }
    );
    ctx.captureBudget = budget;
    attachEvaluationContext(entry, ctx);
    return { entry, ctx, budget, askLedger, deliveryLedger, mutationObserver };
  }

  test('the first refusal appends exactly ONE reserved marker row and nothing after it', () => {
    const { entry, ctx } = composeOverflowedSession();
    // call 1 spends both slots (the mirror push + its lifecycle row)
    ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });
    // call 2 overflows: no mirror entry, no lifecycle row — just the marker
    ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });
    // …and everything after it stays silent
    for (let i = 0; i < 10; i += 1) {
      ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });
    }

    const ledger = getLifecycleLedger(entry);
    expect(ledger.subRecords.map((r) => r.kind)).toEqual([
      'non_mutating_audible',
      CAPTURE_BUDGET_OVERFLOW_KIND,
    ]);
    expect(ctx.nonMutatingAudible).toHaveLength(1);

    const marker = ledger.subRecords[1];
    expect(marker).toMatchObject({
      kind: CAPTURE_BUDGET_OVERFLOW_KIND,
      revision: 1,
      capture_site: 'non_mutating_audible',
      row_limit: 2,
      admitted_rows: 2,
    });
    expect(ledger.revisions[CAPTURE_BUDGET_OVERFLOW_KIND]).toBe(1);
  });

  test('every evidence role is latched INVALID with the TRUE reason', () => {
    const { entry, ctx, askLedger, deliveryLedger, mutationObserver } = composeOverflowedSession();
    ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });
    ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });

    // The sink latches FIRST-WINS before any downstream code can see a
    // collection that merely stopped growing and latch a misleading reason
    // (`emitted_without_produced`, `playback_without_delivery_attempt`, …).
    expect(getLifecycleLedger(entry).producerInvalid.reason).toBe(CAPTURE_BUDGET_OVERFLOW_KIND);
    expect(askLedger.invalid.reason).toBe(CAPTURE_BUDGET_OVERFLOW_KIND);
    expect(deliveryLedger.invalid.reason).toBe(CAPTURE_BUDGET_OVERFLOW_KIND);
    expect(mutationObserver.invalid.reason).toBe(CAPTURE_BUDGET_OVERFLOW_KIND);

    // and the downstream misleading latch really is pre-empted: an ask that
    // was never RETAINED as produced would otherwise latch its own reason
    askLedger.emitted(askKey(9), 'ghost');
    expect(askLedger.invalid.reason).toBe(CAPTURE_BUDGET_OVERFLOW_KIND);
  });

  test('BOTH projector paths grant zero family credit after an overflow', () => {
    const { entry, ctx } = composeOverflowedSession({ sessionId: 'sess_overflow_proj' });
    ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });
    ctx.recordNonMutatingAudible({ channel: 'tts', kind: 'catchall_apology' });

    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 'sess_overflow_proj',
      boundary: 'session_stopped',
    });
    // the session is QUIESCENT — nothing is open — so the freeze latch itself
    // is eligible. The refusal of family credit comes from the marker alone,
    // which is exactly the distinction the plan is drawing.
    expect(frozen.eligible).toBe(true);

    const fromSnapshot = buildEvidenceProjectionV1(frozen.candidate);
    expect(fromSnapshot.eligible_for_family_credit).toBe(false);
    expect(fromSnapshot.ineligible_conditions).toContainEqual({
      condition: CAPTURE_BUDGET_OVERFLOW_KIND,
      reason: 'non_mutating_audible',
      count: 2,
    });

    const fromLedgers = projectFrozenLedgersV1(frozen);
    expect(fromLedgers.eligible_for_family_credit).toBe(false);
  });
});
