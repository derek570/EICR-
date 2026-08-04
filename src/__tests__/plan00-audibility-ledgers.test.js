/**
 * Plan 00B §B3 — ask / delivery / playback ledgers: the full RED matrix.
 * Server delivery, client playback-start and manual hearing stay DISTINCT
 * facts; identity is always the authoritative operation (turn + slot +
 * ordinal), never a transport alias.
 */

import { describe, test, expect } from '@jest/globals';
import {
  buildLiveAskKey,
  createAskLedger,
  createDeliveryLedger,
  operationIdentityKey,
} from '../extraction/plan00-audibility-ledgers.js';

const KEY = buildLiveAskKey({
  origin: 'dispatcher',
  purpose: 'clarify',
  reason: 'missing_value',
  contextField: 'measured_zs_ohm',
  boardId: 'main',
  circuits: [3],
  expectedAnswerShape: 'number',
});

const OP = {
  extractionTurnId: 'turn-1',
  field: 'measured_zs_ohm',
  circuit: 3,
  boardId: 'main',
  ordinal: 1,
};
const OTHER_OP = {
  extractionTurnId: 'turn-1',
  field: 'r1_r2_ohm',
  circuit: 3,
  boardId: 'main',
  ordinal: 2,
};

describe('liveAskKey', () => {
  test('is generated-id-free, sorts plural circuits, normalizes pending writes', () => {
    const a = buildLiveAskKey({ circuits: [5, 3], pendingWrite: { field: 'x', value: 7 } });
    const b = buildLiveAskKey({ circuits: [3, 5], pendingWrite: { field: 'x', value: '7' } });
    expect(a).toBe(b);
    expect(a).not.toContain('tool_call');
  });
});

describe('ask ledger — produced → emitted → answered', () => {
  test('happy path binds one runtime id and requires FULL answered proof', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY, { source: 'dispatcher' });
    ledger.emitted(KEY, 'toolu_1');
    ledger.resolved('toolu_1', 'answered', {
      answer_frame_id: 'toolu_1',
      transcript_resolved: true,
    });
    expect(ledger.entries[0].state).toBe('answered');
    expect(ledger.invalid).toBeNull();
  });

  test('RED: emitted without a produced declaration fails', () => {
    const ledger = createAskLedger();
    ledger.emitted(KEY, 'toolu_1');
    expect(ledger.invalid?.reason).toBe('emitted_without_produced');
  });

  test('RED: multiple unmatched declarations for one key is ambiguous', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    ledger.produced(KEY);
    ledger.emitted(KEY, 'toolu_1');
    expect(ledger.invalid?.reason).toBe('ambiguous_produced_match');
  });

  test('RED: a runtime id can never bind twice', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    ledger.emitted(KEY, 'toolu_1');
    ledger.produced(KEY);
    ledger.emitted(KEY, 'toolu_1');
    expect(ledger.invalid?.reason).toBe('runtime_id_already_bound');
  });

  test('RED: wrong-id answer / reverse arrival resolves nothing', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    // Reverse arrival: the answer lands before any successful send.
    ledger.resolved('toolu_1', 'answered', {
      answer_frame_id: 'toolu_1',
      transcript_resolved: true,
    });
    expect(ledger.invalid?.reason).toBe('resolution_without_emitted');
  });

  // Plan 00B-3 C1 (SANCTIONED ledger change): answered_without_full_proof
  // is a TRANSITION REJECTION, not a structural contradiction — resolved()
  // returns {accepted:false, reason} WITHOUT latching invalid, and the
  // entry stays 'emitted' (open, so it counts non-quiescent at stop).
  test('answered without the paired transcript is REJECTED without an invalid latch', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    ledger.emitted(KEY, 'toolu_1');
    const verdict = ledger.resolved('toolu_1', 'answered', {
      answer_frame_id: 'toolu_1',
      transcript_resolved: false,
    });
    expect(verdict).toEqual({ accepted: false, reason: 'answered_without_full_proof' });
    expect(ledger.invalid).toBeNull();
    expect(ledger.entries[0].state).toBe('emitted');
    expect(ledger.open()).toHaveLength(1);
  });

  test('a transcript without the matching answer frame id is REJECTED without an invalid latch', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    ledger.emitted(KEY, 'toolu_1');
    const verdict = ledger.resolved('toolu_1', 'answered', {
      answer_frame_id: 'toolu_OTHER',
      transcript_resolved: true,
    });
    expect(verdict).toEqual({ accepted: false, reason: 'answered_without_full_proof' });
    expect(ledger.invalid).toBeNull();
    expect(ledger.entries[0].state).toBe('emitted');
    // a later FULL-proof resolution still succeeds (the rejection was not terminal)
    const accepted = ledger.resolved('toolu_1', 'answered', {
      answer_frame_id: 'toolu_1',
      transcript_resolved: true,
    });
    expect(accepted).toEqual({ accepted: true, reason: null });
    expect(ledger.entries[0].state).toBe('answered');
  });

  test('closed/throwing send never reaches emitted; the ask stays open (produced)', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    // The send failed — the harness records nothing. The declaration is
    // still open, which is exactly what reconnect/outbox replay preserves.
    expect(ledger.open()).toHaveLength(1);
    expect(ledger.open()[0].state).toBe('produced');
  });

  test('non-answered terminals close an emitted ask without full-proof rules', () => {
    const ledger = createAskLedger();
    ledger.produced(KEY);
    ledger.emitted(KEY, 'toolu_1');
    ledger.resolved('toolu_1', 'user_moved_on', {});
    expect(ledger.entries[0].state).toBe('user_moved_on');
    expect(ledger.invalid).toBeNull();
  });
});

describe('delivery + playback ledgers', () => {
  test('one ACK after two compatible same-operation deliveries is ONE start', () => {
    const ledger = createDeliveryLedger();
    ledger.recordDeliveryAttempt(OP, { kind: 'confirmation' });
    ledger.recordDeliveryAttempt(OP, { kind: 'replay' });
    const ack = { sessionId: 's', turnId: 't-alias', source: 'bundler' };
    ledger.recordPlaybackAck(ack, [OP]);
    expect(ledger.playbacks).toHaveLength(1);
    expect(ledger.deliveries).toHaveLength(2); // both retained, never discarded
    expect(ledger.invalid).toBeNull();
  });

  test('a second DISTINCT accepted ACK body is a second start; a byte-identical duplicate is not', () => {
    const ledger = createDeliveryLedger();
    ledger.recordDeliveryAttempt(OP, {});
    ledger.recordPlaybackAck({ a: 1 }, [OP]);
    ledger.recordPlaybackAck({ a: 1 }, [OP]); // identical retransmission
    ledger.recordPlaybackAck({ a: 2 }, [OP]); // distinct body
    expect(ledger.playbacks).toHaveLength(2);
  });

  test('RED: an ACK matching multiple operations is INVALID/HOLD', () => {
    const ledger = createDeliveryLedger();
    ledger.recordDeliveryAttempt(OP, {});
    ledger.recordDeliveryAttempt(OTHER_OP, {});
    ledger.recordPlaybackAck({ a: 1 }, [OP, OTHER_OP]);
    expect(ledger.invalid?.reason).toBe('playback_ack_ambiguous');
    expect(ledger.playbacks).toHaveLength(0);
  });

  test('RED: an unmatched ACK and an ACK without any delivery both fail', () => {
    const ledger = createDeliveryLedger();
    ledger.recordPlaybackAck({ a: 1 }, []);
    expect(ledger.invalid?.reason).toBe('playback_ack_unmatched');
    const ledger2 = createDeliveryLedger();
    ledger2.recordPlaybackAck({ a: 1 }, [OP]);
    expect(ledger2.invalid?.reason).toBe('playback_without_delivery_attempt');
  });

  test('a successful server send NEVER synthesizes playback', () => {
    const ledger = createDeliveryLedger();
    ledger.recordDeliveryAttempt(OP, {});
    ledger.recordDeliveryAttempt(OP, {});
    expect(ledger.playbacks).toHaveLength(0);
  });

  test('cross-process claim lineage marks delivery_history_ambiguous, never reconstructs', () => {
    const ledger = createDeliveryLedger();
    ledger.markDeliveryHistoryAmbiguous(OP);
    expect(ledger.isDeliveryHistoryAmbiguous(OP)).toBe(true);
    expect(ledger.isDeliveryHistoryAmbiguous(OTHER_OP)).toBe(false);
    // Nothing was invented: no deliveries, no playbacks.
    expect(ledger.deliveries).toHaveLength(0);
    expect(ledger.playbacks).toHaveLength(0);
  });
});

describe('fast-TTS provisional binding', () => {
  const CANDIDATE = { field: 'measured_zs_ohm', value: '0.63', circuit: 3, board_id: null };

  test('RED: a provisional without the owner proof is INVALID', () => {
    const ledger = createDeliveryLedger();
    ledger.recordProvisionalFastDelivery({
      correlationId: 'c1',
      ownerVerified: false,
      candidate: CANDIDATE,
    });
    expect(ledger.invalid?.reason).toBe('fast_provisional_without_owner_proof');
  });

  test('a pre-operation fast ACK stages, then promotes atomically with the authoritative op', () => {
    const ledger = createDeliveryLedger();
    ledger.recordProvisionalFastDelivery({
      correlationId: 'c1',
      ownerVerified: true,
      candidate: CANDIDATE,
    });
    ledger.stageFastAck('c1', { source: 'fast_tts', correlation_id: 'c1' });
    const op = { ...OP, field: 'measured_zs_ohm', value: '0.63' };
    ledger.promoteProvisional('c1', [op]);
    expect(ledger.invalid).toBeNull();
    expect(ledger.deliveries.map((d) => d.kind)).toEqual(['fast_tts']);
    expect(ledger.playbacks).toHaveLength(1);
    expect(ledger.assertNoUnconsumedProvisionals()).toBe(true);
  });

  test('RED: zero-match and multi-match promotions are INVALID', () => {
    const ledger = createDeliveryLedger();
    ledger.recordProvisionalFastDelivery({
      correlationId: 'c1',
      ownerVerified: true,
      candidate: CANDIDATE,
    });
    ledger.promoteProvisional('c1', [{ ...OP, field: 'other_field', value: '9' }]);
    expect(ledger.invalid?.reason).toBe('fast_promotion_unmatched');

    const ledger2 = createDeliveryLedger();
    ledger2.recordProvisionalFastDelivery({
      correlationId: 'c1',
      ownerVerified: true,
      candidate: CANDIDATE,
    });
    const op = { ...OP, value: '0.63' };
    ledger2.promoteProvisional('c1', [op, { ...op, ordinal: 9 }]);
    expect(ledger2.invalid?.reason).toBe('fast_promotion_ambiguous');
  });

  test('RED: an unconsumed provisional invalidates session evidence', () => {
    const ledger = createDeliveryLedger();
    ledger.recordProvisionalFastDelivery({
      correlationId: 'c1',
      ownerVerified: true,
      candidate: CANDIDATE,
    });
    expect(ledger.assertNoUnconsumedProvisionals()).toBe(false);
    expect(ledger.invalid?.reason).toBe('fast_provisional_unconsumed');
  });

  // Plan 00B-3 (Codex r1 C-2, sanctioned reclassification): a wrong/stale/
  // unknown fast correlation is PRE-ADMISSION telemetry per the C1 ternary
  // (schema-v1 regime pre_admission) — no latch, no row; a later valid ACK
  // succeeds. The old pin latched the ledger invalid here.
  test('a fast ACK with no provisional to correlate to is pre-admission telemetry (no latch)', () => {
    const ledger = createDeliveryLedger();
    const verdict = ledger.stageFastAck('c-unknown', { x: 1 });
    expect(verdict).toEqual({
      accepted: false,
      reason: 'fast_ack_without_provisional',
      preAdmission: true,
    });
    expect(ledger.invalid).toBeNull();
  });
});

describe('operation identity', () => {
  test('identity is turn + slot + ordinal — transport aliases play no part', () => {
    const a = operationIdentityKey(OP);
    const b = operationIdentityKey({ ...OP });
    expect(a).toBe(b);
    expect(a).not.toContain('confirmation_ref');
    expect(operationIdentityKey({ ...OP, ordinal: 2 })).not.toBe(a);
  });
});
