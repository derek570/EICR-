/**
 * Tests for src/extraction/voice-latency-turn-summary.js
 *
 * Single-round latency sprint Phase 0 (PLAN_v8 §A Pivots 8, 8.1, 8.2,
 * 8.3, 8.4). Pins:
 *   - emitTurnCoreSummary logs the row with the right event name
 *   - startAudioFinalizer emits turn_audio_summary on ACK completion
 *   - 8s timeout fires the row with timeout flag
 *   - recordPlaybackAck on-time path appends to received_acks
 *   - late-ACK path emits separate late_playback_ack row
 *   - decrementExpectedAcksByCorrelation pre-finalizer stash + drain
 */

import { jest } from '@jest/globals';

// Mock logger so we can capture emissions without console noise.
const logSpy = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../logger.js', () => ({
  default: logSpy,
}));

const { activeSessions } = await import('../extraction/active-sessions.js');
const turnSummary = await import('../extraction/voice-latency-turn-summary.js');

const SESS = 'TS';
const TURN = 'T1';

beforeEach(() => {
  logSpy.info.mockReset();
  logSpy.warn.mockReset();
  logSpy.error.mockReset();
  activeSessions.clear();
  turnSummary._resetForTests();
  activeSessions.set(SESS, {
    session: { sessionId: SESS },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
  });
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  turnSummary._resetForTests();
  activeSessions.clear();
});

function findEmit(eventName) {
  return logSpy.info.mock.calls.find((c) => c[0] === eventName);
}

describe('emitTurnCoreSummary', () => {
  test('emits the turn_core_summary event with the supplied fields', () => {
    turnSummary.emitTurnCoreSummary({
      sessionId: SESS,
      turnId: TURN,
      rounds: 2,
      terminal_reason: 'end_turn',
    });
    const call = findEmit('voice_latency.turn_core_summary');
    expect(call).toBeDefined();
    expect(call[1]).toMatchObject({ sessionId: SESS, turnId: TURN, rounds: 2 });
  });

  test('warns on missing required keys (sessionId / turnId)', () => {
    turnSummary.emitTurnCoreSummary({ turnId: TURN });
    expect(logSpy.warn).toHaveBeenCalledWith(
      'voice_latency.turn_summary_emit_error',
      expect.objectContaining({ reason: 'missing_required_keys' })
    );
  });
});

describe('startAudioFinalizer — on-time ACK path', () => {
  test('expected_acks=0 → emits audio_summary immediately', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 0,
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].expected_acks).toBe(0);
    expect(call[1].audio_finalizer_timeout_fired).toBe(false);
  });

  test('ACKs received before timeout → audio_summary with timeout=false', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 2,
      attemptedFastTtsCount: 0,
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      slot: { field: 'measured_zs_ohm', circuit: 1, boardId: null },
      source: 'bundler',
      at_ms: Date.now(),
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      slot: { field: 'r1_r2_ohm', circuit: 1, boardId: null },
      source: 'bundler',
      at_ms: Date.now(),
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].audio_finalizer_timeout_fired).toBe(false);
    expect(call[1].ios_playback_ack).toHaveLength(2);
  });
});

describe('startAudioFinalizer — 8s timeout path', () => {
  test('no ACKs in 8s → audio_summary with timeout=true', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
    });
    jest.advanceTimersByTime(8000);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].audio_finalizer_timeout_fired).toBe(true);
    expect(call[1].ios_playback_ack).toHaveLength(0);
  });
});

describe('late-ACK path (after finalizer already fired)', () => {
  test('emits separate late_playback_ack row', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
    });
    jest.advanceTimersByTime(8000); // finalize via timeout
    logSpy.info.mockClear();
    turnSummary.recordPlaybackAck(SESS, TURN, {
      slot: { field: 'measured_zs_ohm', circuit: 1, boardId: null },
      source: 'bundler',
      at_ms: Date.now() - 100,
    });
    const call = findEmit('voice_latency.late_playback_ack');
    expect(call).toBeDefined();
    expect(call[1].source).toBe('bundler');
  });
});

describe('decrementExpectedAcksByCorrelation', () => {
  test('stashes decrement BEFORE startAudioFinalizer runs', () => {
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'cid-aaa');
    expect(turnSummary._peekStateForTests().pendingAckDecrements).toBe(1);
  });

  test('startAudioFinalizer drains matching correlation ids', () => {
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'cid-x');
    // Seed the entry's correlation set so the finalizer drains it.
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set(['cid-x']));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1, // would expect 2, minus 1 decrement = 1
    });
    // expected_acks resolves to 1 (2-1). We'll fire one ACK and the
    // row should emit immediately with timeout=false.
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].decrements_applied).toBe(1);
  });

  test('stash expires after 60s', () => {
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'cid-stale');
    expect(turnSummary._peekStateForTests().pendingAckDecrements).toBe(1);
    // Burn past the 60s TTL.
    jest.advanceTimersByTime(61_000);
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set(['cid-stale']));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1,
    });
    // Finalizer armed for 2 ACKs (no decrement applied because stale).
    // Fire the timeout so we can read the emitted row.
    jest.advanceTimersByTime(8000);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].decrements_applied).toBe(0);
    expect(call[1].audio_finalizer_timeout_fired).toBe(true);
  });

  test('ignores missing sessionId / correlationId', () => {
    turnSummary.decrementExpectedAcksByCorrelation(null, 'cid-x');
    turnSummary.decrementExpectedAcksByCorrelation(SESS, null);
    expect(turnSummary._peekStateForTests().pendingAckDecrements).toBe(0);
  });
});

// Voice-latency plan 2026-06-03 final, Tier 1.3 — earliest-monotonic
// flatten + durable correlation index + pre-finalizer stash.
describe('Tier 1.3 — pickEarliestPlaybackAck flatten + row enrichment', () => {
  test('on-time single ACK with monotonic surfaces top-level flatten fields', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 12345.678,
      process_uptime_id: 'proc-A',
      correlation_id: null,
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBeCloseTo(12345.678);
    expect(call[1].ios_playback_ack_process_uptime_id).toBe('proc-A');
  });

  test('multi-ACK out-of-monotonic-order arrival picks the earliest', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 2,
      attemptedFastTtsCount: 0,
    });
    // Arrives first but is the LATER monotonic stamp.
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 999,
      process_uptime_id: 'proc-A',
    });
    // Arrives second but is the EARLIER stamp.
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 100,
      process_uptime_id: 'proc-A',
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBe(100);
  });

  test('mixed process_uptime_id — newer-process group wins by count', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 3,
      attemptedFastTtsCount: 0,
    });
    // proc-OLD: 1 ACK (force-killed mid-turn)
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 50,
      process_uptime_id: 'proc-OLD',
    });
    // proc-NEW: 2 ACKs — wins by count
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 800,
      process_uptime_id: 'proc-NEW',
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 600,
      process_uptime_id: 'proc-NEW',
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].ios_playback_ack_process_uptime_id).toBe('proc-NEW');
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBe(600); // earliest within NEW
  });

  test('timeout with 0 ACKs → flatten fields are null', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
    });
    jest.advanceTimersByTime(8000);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBeNull();
    expect(call[1].ios_playback_ack_process_uptime_id).toBeNull();
  });

  test('timeout with 1-of-2 ACKs → flatten fields surface the one ACK', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 2,
      attemptedFastTtsCount: 0,
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      at_ms: Date.now(),
      monotonic_at_ms: 42,
      process_uptime_id: 'proc-A',
    });
    jest.advanceTimersByTime(8000);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].audio_finalizer_timeout_fired).toBe(true);
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBe(42);
  });

  test('expected_acks_eligible projected as integer 1 when ack-eligible', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
    });
    jest.advanceTimersByTime(8000);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].expected_acks_eligible).toBe(1);
  });

  test('expected_acks_eligible projected as integer 0 when not ack-eligible', () => {
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0, // ineligible
      attemptedFastTtsCount: 0,
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].expected_acks_eligible).toBe(0);
  });
});

describe('Tier 1.3 — fast-path correlation_id index + pre-finalizer stash', () => {
  const CORR = 'corr-abc';

  test('ACK arrives BEFORE finalizer armed → stashed → drained on arm + emit fires', () => {
    // Step 1: iOS fires fast-path ACK before runLiveMode has armed.
    turnSummary.recordPlaybackAck(SESS, '', {
      source: 'fast_tts',
      at_ms: Date.now(),
      monotonic_at_ms: 250,
      process_uptime_id: 'proc-A',
      correlation_id: CORR,
    });
    expect(turnSummary._peekStateForTests().pendingFastPathAcksByCorrelation).toBe(1);
    // Step 2: runLiveMode arms with the correlationId in the per-turn set.
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set([CORR]));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 1,
    });
    // Stash drained, emit fired with the ACK present.
    expect(turnSummary._peekStateForTests().pendingFastPathAcksByCorrelation).toBe(0);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].audio_finalizer_timeout_fired).toBe(false);
    expect(call[1].ios_playback_ack).toHaveLength(1);
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBe(250);
  });

  test('ACK arrives AFTER finalizer armed → resolves via durable correlationToTurn index', () => {
    // Step 1: arm finalizer with correlationId in the per-turn set.
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set([CORR]));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 1,
    });
    // Step 2: simulate runLiveMode's finally cleanup deleting the per-turn
    // map entry — the durable correlationToTurn index must outlive this.
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.delete(TURN);
    expect(turnSummary._peekStateForTests().correlationToTurn).toBe(1);
    // Step 3: fast-path ACK arrives with the correlationId — resolves to turn.
    turnSummary.recordPlaybackAck(SESS, '', {
      source: 'fast_tts',
      at_ms: Date.now(),
      monotonic_at_ms: 333,
      process_uptime_id: 'proc-A',
      correlation_id: CORR,
    });
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call).toBeDefined();
    expect(call[1].ios_playback_ack_monotonic_at_ms).toBe(333);
  });

  test('fast-path ACK arrives AFTER finalizer fires → late_playback_ack with monotonic fields', () => {
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set([CORR]));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 1,
    });
    jest.advanceTimersByTime(8000); // finalizer fires via timeout
    // correlationToTurn index keeps the resolution alive.
    logSpy.info.mockClear();
    turnSummary.recordPlaybackAck(SESS, '', {
      source: 'fast_tts',
      at_ms: Date.now() - 100,
      monotonic_at_ms: 700,
      process_uptime_id: 'proc-A',
      correlation_id: CORR,
    });
    const call = findEmit('voice_latency.late_playback_ack');
    expect(call).toBeDefined();
    expect(call[1].monotonic_at_ms).toBe(700);
    expect(call[1].process_uptime_id).toBe('proc-A');
    expect(call[1].correlation_id).toBe(CORR);
  });

  test('pre-finalizer stash expires after 30s', () => {
    turnSummary.recordPlaybackAck(SESS, '', {
      source: 'fast_tts',
      at_ms: Date.now(),
      monotonic_at_ms: 100,
      process_uptime_id: 'proc-A',
      correlation_id: CORR,
    });
    expect(turnSummary._peekStateForTests().pendingFastPathAcksByCorrelation).toBe(1);
    jest.advanceTimersByTime(31_000);
    // Now arm — the stash is expired, ACK is discarded.
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set([CORR]));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 1,
    });
    // Stash entry cleaned up; nothing drained → finalizer is armed but
    // received_acks stays empty.
    expect(turnSummary._peekStateForTests().pendingFastPathAcksByCorrelation).toBe(0);
    jest.advanceTimersByTime(8000);
    const call = findEmit('voice_latency.turn_audio_summary');
    expect(call[1].ios_playback_ack).toHaveLength(0);
    expect(call[1].audio_finalizer_timeout_fired).toBe(true);
  });

  test('durable correlationToTurn entry expires after 60s — late ACK falls through', () => {
    activeSessions.get(SESS).fastPathCorrelationIdByTurn.set(TURN, new Set([CORR]));
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 1,
    });
    jest.advanceTimersByTime(8000); // finalize via timeout
    jest.advanceTimersByTime(61_000); // burn past 60s correlation TTL (timer + 60s)
    logSpy.info.mockClear();
    turnSummary.recordPlaybackAck(SESS, '', {
      source: 'fast_tts',
      at_ms: Date.now() - 100,
      monotonic_at_ms: 800,
      process_uptime_id: 'proc-A',
      correlation_id: CORR,
    });
    // Expired durable index — neither pending lookup nor index resolves.
    // Without a turnId, the ACK is silently dropped (no late_playback_ack
    // because we can't attribute it). pendingFastPathAcksByCorrelation
    // stash isn't a fallback for post-finalizer late arrivals either.
    expect(findEmit('voice_latency.late_playback_ack')).toBeUndefined();
  });

  test('bundler ACK (no correlation_id) on missing turnId falls through to nowhere', () => {
    // No finalizer armed, no correlationId — bundler ACK with empty turnId
    // has nothing to attach to. Treated as silently-discarded (validateBody
    // on the route enforces turnId required for non-fast-path; this test
    // pins the internal contract).
    turnSummary.recordPlaybackAck(SESS, '', {
      source: 'bundler',
      at_ms: Date.now(),
    });
    expect(turnSummary._peekStateForTests().pendingFastPathAcksByCorrelation).toBe(0);
  });
});
