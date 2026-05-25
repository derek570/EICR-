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
