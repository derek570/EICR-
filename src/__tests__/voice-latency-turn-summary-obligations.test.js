/**
 * voice-latency-turn-summary-obligations.test.js — PLAN-D 2026-08-23
 * (feedback id 127, D4 — telemetry-only).
 *
 * The identity-matched audibility-obligation ledger in startAudioFinalizer:
 *   - twin collapse (canonical + its fast attempt = ONE obligation, BOTH
 *     board aliases retained) — a healthy fast-path turn reports NO unacked;
 *   - a 127-style missing canonical on an iOS-capable session reports the
 *     EXACT slot on the timeout row;
 *   - capability gating on `client_playback_telemetry` (the flag current iOS
 *     actually advertises): a web/legacy non-capable session classifies
 *     UNOBSERVABLE, never unacked, and expected_acks_eligible forces 0 so
 *     the canonical row and the perceived-latency store's derived rows agree
 *     (fixtures use the EXACT current iOS and web supports lists);
 *   - rejection identities preserved in BOTH orderings (pre-arm consumed set
 *     removes exact fast obligations before twin collapse; post-arm
 *     rejection updates the ARMED finalizer via correlationToTurn, removing
 *     only the fast leg of a twin);
 *   - same-slot multiplicity → AMBIGUOUS (never exact completion or loss);
 *   - completion from uniquely matched identities, never count arithmetic
 *     (duplicate ACKs cannot complete a turn);
 *   - circuit normalised `?? 0` (board-level obligations vs iOS circuit=0);
 *   - NO speech path exists from the finalizer (assert absence).
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const logSpy = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../logger.js', () => ({ default: logSpy }));

const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const turnSummary = await import('../extraction/voice-latency-turn-summary.js');

const SESS = 'OBS';
const TURN = 'T1';

/** EXACT current client supports lists (ServerWebSocketService.swift /
 *  web sonnet-session.ts VOICE_LATENCY_SUPPORTS — 2026-08-23). */
const IOS_SUPPORTS = [
  'regex_fast_v2',
  'client_playback_telemetry',
  'low_conf_readback_v1',
  'lim_ranged_write_v1',
  'board_clear_v1',
  'address_mirror_delivery_ack_v1',
];
const WEB_SUPPORTS = [
  'low_conf_readback_v1',
  'lim_ranged_write_v1',
  'board_clear_v1',
  'address_mirror_delivery_ack_v1',
];

function seedSession(supports, { correlations = [] } = {}) {
  const entry = {
    session: { sessionId: SESS },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(
      correlations.length ? [[TURN, new Set(correlations)]] : []
    ),
  };
  if (supports) {
    entry.voiceLatency = {
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports },
      }),
    };
  }
  activeSessions.set(SESS, entry);
  return entry;
}

function audioSummary() {
  const call = logSpy.info.mock.calls.find((c) => c[0] === 'voice_latency.turn_audio_summary');
  return call ? call[1] : null;
}

const canonical = (over = {}) => ({
  field: 'measured_zs_ohm',
  circuit: 1,
  wireBoardId: null,
  effectiveBoardId: 'board-main',
  fastCorrelationId: null,
  ...over,
});

beforeEach(() => {
  logSpy.info.mockReset();
  logSpy.warn.mockReset();
  logSpy.error.mockReset();
  activeSessions.clear();
  turnSummary._resetForTests();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  turnSummary._resetForTests();
  activeSessions.clear();
});

describe('D4 — twin collapse + healthy fast path', () => {
  test('healthy fast/canonical twin: ONE obligation, fast ACK completes, NO unacked, no timeout', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1,
      ackEligibleConfirmations: [canonical({ fastCorrelationId: 'corr-1' })],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
      ],
    });
    expect(audioSummary()).toBeNull(); // armed, waiting
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-1',
      at_ms: 1,
    });
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.audio_finalizer_timeout_fired).toBe(false);
    expect(row.ack_obligations_total).toBe(1);
    expect(row.ack_obligations_acked).toBe(1);
    // Codex cycle 1 — the PUBLIC counter derives from the ledger: a twin is
    // ONE heard clip, never the raw transport-leg count of 2.
    expect(row.expected_acks).toBe(1);
    expect(row.unacked_confirmations).toEqual([]);
    expect(row.observability).toBe('observable');
  });

  test('fast failure then ACKed canonical fallback (nil wire board vs effective ledger board) → no false unacked', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1,
      ackEligibleConfirmations: [canonical({ fastCorrelationId: 'corr-1' })],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
      ],
    });
    // The fallback canonical ACK carries the WIRE slot (boardId nil — iOS
    // ValueConfirmation.boardId is nil on selected-board traffic).
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      slot: { field: 'measured_zs_ohm', circuit: 1, boardId: null },
      at_ms: 5,
    });
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.unacked_confirmations).toEqual([]);
    expect(row.ack_obligations_acked).toBe(1);
  });
});

describe('D4 — 127-style missing canonical (iOS-capable)', () => {
  test('timeout row names the exact unacked slot', () => {
    seedSession(IOS_SUPPORTS);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
      ackEligibleConfirmations: [canonical()],
      fastAttempts: [],
    });
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.audio_finalizer_timeout_fired).toBe(true);
    expect(row.expected_acks_eligible).toBe(1);
    expect(row.observability).toBe('observable');
    expect(row.unacked_confirmations).toEqual([
      {
        kind: 'canonical',
        field: 'measured_zs_ohm',
        circuit: 1,
        board_id: 'board-main',
        correlation_id: null,
      },
    ]);
  });

  test('ACKed board-level confirmation (backend circuit null, iOS ACK circuit 0) → no unacked obligation', () => {
    seedSession(IOS_SUPPORTS);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
      ackEligibleConfirmations: [
        canonical({ field: 'earth_loop_impedance_ze', circuit: null, effectiveBoardId: null }),
      ],
      fastAttempts: [],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      slot: { field: 'earth_loop_impedance_ze', circuit: 0, boardId: null },
      at_ms: 3,
    });
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.unacked_confirmations).toEqual([]);
  });

  test('selected non-main board: ACK against EITHER alias (wire null OR effective board) matches', () => {
    seedSession(IOS_SUPPORTS);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
      ackEligibleConfirmations: [canonical({ effectiveBoardId: 'db-2' })],
      fastAttempts: [],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      slot: { field: 'measured_zs_ohm', circuit: 1, boardId: 'db-2' },
      at_ms: 2,
    });
    expect(audioSummary().unacked_confirmations).toEqual([]);
  });
});

describe('D4 — capability gating (web/legacy = UNOBSERVABLE, never unacked)', () => {
  test('web supports list → expected_acks_eligible 0, observability unobservable, no unacked slots; canonical + derived rows agree', () => {
    seedSession(WEB_SUPPORTS);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
      ackEligibleConfirmations: [canonical()],
      fastAttempts: [],
    });
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.observability).toBe('unobservable');
    expect(row.expected_acks_eligible).toBe(0);
    expect(row.unacked_confirmations).toEqual([]);
    expect(row.unobservable_obligations).toBe(1);
  });

  test('session with NO parsed capabilities → observability unknown, legacy eligibility preserved', () => {
    seedSession(null);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
    });
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.observability).toBe('unknown');
    expect(row.expected_acks_eligible).toBe(1);
  });
});

describe('D4 — rejection identities, both orderings', () => {
  test('PRE-ARM rejection: exact fast obligation removed before twin collapse; canonical sibling stays standalone and its ACK completes', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1'] });
    // Rejection stashes before the finalizer arms.
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-1');
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1,
      // Canonical does NOT carry the correlation (a rejected attempt never
      // commits an identity, so the bundler never stamps it).
      ackEligibleConfirmations: [canonical()],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
      ],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      slot: { field: 'measured_zs_ohm', circuit: 1, boardId: null },
      at_ms: 4,
    });
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.audio_finalizer_timeout_fired).toBe(false);
    expect(row.ack_obligations_total).toBe(1); // fast obligation never built
    expect(row.unacked_confirmations).toEqual([]);
  });

  test('POST-ARM rejection: armed finalizer updated via correlationToTurn — twin loses only its fast leg; canonical fallback ACK → no false unacked', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1,
      ackEligibleConfirmations: [canonical({ fastCorrelationId: 'corr-1' })],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
      ],
    });
    // Rejection arrives AFTER arm (the race the old stash-only path lost).
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-1');
    // Canonical fallback plays and ACKs with the wire slot.
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'bundler',
      slot: { field: 'measured_zs_ohm', circuit: 1, boardId: null },
      at_ms: 6,
    });
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.audio_finalizer_timeout_fired).toBe(false);
    expect(row.unacked_confirmations).toEqual([]);
  });

  test('POST-ARM rejection of a fast-only turn → obligation removed, completes to zero outstanding', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 1,
      ackEligibleConfirmations: [],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
      ],
    });
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-1');
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.audio_finalizer_timeout_fired).toBe(false);
    expect(row.ack_obligations_total).toBe(0);
    // Codex cycle 1 — the last obligation died: the turn owes nothing and
    // must not read as awaiting an ACK downstream.
    expect(row.expected_acks).toBe(0);
    expect(row.expected_acks_eligible).toBe(0);
  });

  test('two same-slot fast correlations — one rejected + one ACKed completes; two-ACK ordering completes by correlation', () => {
    // Ordering A: reject corr-1 pre-arm, ACK corr-2.
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1', 'corr-2'] });
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-1');
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 2,
      ackEligibleConfirmations: [],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
        { correlationId: 'corr-2', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
      ],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-2',
      at_ms: 2,
    });
    let row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.ack_obligations_total).toBe(1);
    expect(row.ack_obligations_acked).toBe(1);

    // Ordering B: both attempts live, both ACK by correlation.
    logSpy.info.mockReset();
    turnSummary._resetForTests();
    activeSessions.clear();
    seedSession(IOS_SUPPORTS, { correlations: ['corr-3', 'corr-4'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 2,
      ackEligibleConfirmations: [],
      fastAttempts: [
        { correlationId: 'corr-3', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
        { correlationId: 'corr-4', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
      ],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-3',
      at_ms: 1,
    });
    expect(audioSummary()).toBeNull(); // corr-4 still outstanding — no count-arithmetic completion
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-4',
      at_ms: 2,
    });
    row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.ack_obligations_acked).toBe(2);
  });
});

describe('D4 — same-slot multiplicity + duplicate ACKs', () => {
  test('two same-slot designation confirmations + a duplicate ACK → AMBIGUOUS, no false unacked, no false completion', () => {
    seedSession(IOS_SUPPORTS);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 2,
      attemptedFastTtsCount: 0,
      ackEligibleConfirmations: [
        canonical({ field: 'circuit_designation', circuit: 3, effectiveBoardId: null }),
        canonical({ field: 'circuit_designation', circuit: 3, effectiveBoardId: null }),
      ],
      fastAttempts: [],
    });
    const ack = {
      source: 'bundler',
      slot: { field: 'circuit_designation', circuit: 3, boardId: null },
      at_ms: 2,
    };
    turnSummary.recordPlaybackAck(SESS, TURN, ack);
    turnSummary.recordPlaybackAck(SESS, TURN, { ...ack, at_ms: 3 }); // duplicate
    // Neither slot-ambiguous obligation may claim exact completion — the
    // turn runs to timeout and reports AMBIGUOUS, not unacked.
    expect(audioSummary()).toBeNull();
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.audio_finalizer_timeout_fired).toBe(true);
    expect(row.unacked_confirmations).toEqual([]);
    expect(row.ambiguous_confirmations).toHaveLength(2);
    for (const a of row.ambiguous_confirmations) {
      expect(a).toMatchObject({ field: 'circuit_designation', circuit: 3 });
    }
  });

  test('duplicate correlation ACKs cannot complete a two-obligation turn (identity, not count)', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 1,
      ackEligibleConfirmations: [
        canonical({ field: 'wiring_type', circuit: 2, effectiveBoardId: null }),
      ],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
      ],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-1',
      at_ms: 1,
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-1',
      at_ms: 2,
    });
    // Legacy count arithmetic would flush at 2 acks >= 2 expected; the
    // identity ledger correctly keeps waiting for the canonical.
    expect(audioSummary()).toBeNull();
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.unacked_confirmations).toEqual([
      { kind: 'canonical', field: 'wiring_type', circuit: 2, board_id: null, correlation_id: null },
    ]);
  });

  test('mixed accepted/rejected correlations with a canonical: only live identities count', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-a', 'corr-b'] });
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-b');
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 2,
      ackEligibleConfirmations: [canonical({ fastCorrelationId: 'corr-a' })],
      fastAttempts: [
        { correlationId: 'corr-a', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
        { correlationId: 'corr-b', field: 'wiring_type', circuit: 2, boardId: 'board-main' },
      ],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-a',
      at_ms: 1,
    });
    const row = audioSummary();
    expect(row).not.toBeNull();
    expect(row.ack_obligations_total).toBe(1); // corr-b removed pre-collapse
    expect(row.unacked_confirmations).toEqual([]);
  });
});

describe('D4 — Codex cycle-1 regressions', () => {
  test('two same-slot fast correlations: corr-1 ACKs, corr-2 times out → corr-2 reported as EXACT unacked, never ambiguous', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1', 'corr-2'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 0,
      attemptedFastTtsCount: 2,
      ackEligibleConfirmations: [],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
        { correlationId: 'corr-2', field: 'measured_zs_ohm', circuit: 1, boardId: 'b' },
      ],
    });
    turnSummary.recordPlaybackAck(SESS, TURN, {
      source: 'fast_tts',
      correlation_id: 'corr-1',
      at_ms: 1,
    });
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.audio_finalizer_timeout_fired).toBe(true);
    // A correlation-addressable obligation is uniquely identifiable — its
    // missing ACK is an exact loss, never same-slot ambiguity.
    expect(row.ambiguous_confirmations).toEqual([]);
    expect(row.unacked_confirmations).toEqual([
      {
        kind: 'fast',
        field: 'measured_zs_ohm',
        circuit: 1,
        board_id: 'b',
        correlation_id: 'corr-2',
      },
    ]);
  });

  test('LEGACY client shape (no capabilities block on session_start → version-0/all-false parse) classifies UNOBSERVABLE', () => {
    // parseVoiceLatencyCapabilities never returns null — a legacy client
    // that sends no capabilities at all still yields a parsed object with
    // hasClientPlaybackTelemetry false. Production session registration
    // always attaches it, so a real legacy session lands HERE, not on the
    // hand-built-test 'unknown' branch.
    const entry = {
      session: { sessionId: SESS },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      voiceLatency: { capabilities: parseVoiceLatencyCapabilities({}) },
    };
    activeSessions.set(SESS, entry);
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 1,
      attemptedFastTtsCount: 0,
      ackEligibleConfirmations: [canonical()],
      fastAttempts: [],
    });
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    expect(row.observability).toBe('unobservable');
    expect(row.expected_acks_eligible).toBe(0);
    expect(row.unacked_confirmations).toEqual([]);
  });
});

describe('D4 — Codex mini-review c1: post-arm ambiguity recompute', () => {
  test('two same-slot twins both rejected post-arm → converted canonicals classify AMBIGUOUS, never exact', () => {
    seedSession(IOS_SUPPORTS, { correlations: ['corr-1', 'corr-2'] });
    turnSummary.startAudioFinalizer(SESS, TURN, {
      bundlerEmittedCount: 2,
      attemptedFastTtsCount: 2,
      ackEligibleConfirmations: [
        canonical({ fastCorrelationId: 'corr-1' }),
        canonical({ fastCorrelationId: 'corr-2' }),
      ],
      fastAttempts: [
        { correlationId: 'corr-1', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
        { correlationId: 'corr-2', field: 'measured_zs_ohm', circuit: 1, boardId: 'board-main' },
      ],
    });
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-1');
    turnSummary.decrementExpectedAcksByCorrelation(SESS, 'corr-2');
    jest.advanceTimersByTime(9000);
    const row = audioSummary();
    // Both twins lost their fast legs — the surviving canonicals share a
    // slot and carry no correlation identity: genuinely indistinguishable
    // by iOS slot ACKs.
    expect(row.unacked_confirmations).toEqual([]);
    expect(row.ambiguous_confirmations).toHaveLength(2);
  });
});

describe('D4 — no speech path from the finalizer (assert absence)', () => {
  test('the module has no send/synthesis capability — telemetry only', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/extraction/voice-latency-turn-summary.js'),
      'utf8'
    );
    // No websocket sends, no confirmation synthesis, no TTS calls.
    for (const forbidden of [
      'ws.send',
      'sendConfirmation',
      'buildConfirmationText',
      'expandForTTS',
      'synthesise',
      'elevenlabs',
      'ElevenLabs',
    ]) {
      expect(src).not.toContain(forbidden);
    }
    // And every emission funnels through the logger only.
    expect(src).toContain("logger.info('voice_latency.turn_audio_summary'");
  });
});
