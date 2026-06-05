/**
 * Voice-latency perceived-latency store unit tests.
 *
 * Plan: .planning-stage6-agentic/handoffs/voice-latency-correlation-fix
 *       -2026-06-05/PLAN-final.md §2.3 (Tests matrix).
 *
 * Test matrix locks the lifecycle rules:
 *   - Arrival-order combinations both emit turn_perceived_latency_ms once.
 *   - process_uptime_id mismatch → turn_perceived_latency_skipped.
 *   - Eligible zero-ack with late ack before TTL → emit on merge.
 *   - Eligible zero-ack at TTL → turn_perceived_latency_skipped
 *     (reason: 'no_audio_ack_at_ttl').
 *   - Ineligible zero-ack at TTL → SILENT DROP (no event at all).
 *   - Ineligible WITH ack → emit (store doesn't filter; dashboard does).
 *   - Late ack without prior summary → skipped with
 *     reason: 'late_ack_without_summary'.
 *   - TTL cleanup orphaned entries.
 *   - No-throw guarantee for all three intake hooks.
 *
 * Uses test-only helpers (_resetPerceivedLatencyStoreForTests,
 * _forceTtlExpiryForTests, _peekEntryCountForTests) to isolate each
 * case without bleed-over across the module-scope Map.
 */

import { jest } from '@jest/globals';

import {
  recordUtteranceEnd,
  recordTurnAudioSummary,
  recordLatePlaybackAck,
  _resetPerceivedLatencyStoreForTests,
  _forceTtlExpiryForTests,
  _peekEntryCountForTests,
} from '../extraction/voice-latency-perceived-latency.js';
import logger from '../logger.js';

const SESSION = 'session-abc';
const TURN = 'session-abc-turn-7';
const UTT = 'utt-xyz';
const PUID = 'pu-1';

// Captured logger.info calls. We spy on the real logger so we don't have
// to plumb a fake; reset between tests.
let infoSpy;
let warnSpy;

beforeEach(() => {
  _resetPerceivedLatencyStoreForTests();
  infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  _resetPerceivedLatencyStoreForTests();
});

function findEvents(name) {
  return infoSpy.mock.calls.filter(([n]) => n === name);
}

function utteranceEnd(overrides = {}) {
  return {
    sessionId: SESSION,
    turnId: TURN,
    utterance_id: UTT,
    monotonic_at_ms: 1000,
    at_ms: 1_780_000_000_000,
    process_uptime_id: PUID,
    source: 'deepgram_utterance_end',
    orphaned: false,
    ...overrides,
  };
}

function audioSummary(overrides = {}) {
  return {
    sessionId: SESSION,
    turnId: TURN,
    expected_acks: 1,
    expected_acks_eligible: 1,
    audio_finalizer_timeout_fired: false,
    ack_source: 'bundler',
    ios_playback_ack_at_ms: 1_780_000_001_500,
    ios_playback_ack_monotonic_at_ms: 2500, // 1500 ms after UE
    ios_playback_ack_process_uptime_id: PUID,
    ios_playback_ack_correlation_id: null,
    ...overrides,
  };
}

describe('recordUtteranceEnd → recordTurnAudioSummary (arrival order A)', () => {
  test('utterance_end then audio_summary → emit turn_perceived_latency_ms once', () => {
    recordUtteranceEnd(utteranceEnd());
    recordTurnAudioSummary(audioSummary());
    const events = findEvents('voice_latency.turn_perceived_latency_ms');
    expect(events).toHaveLength(1);
    const [, payload] = events[0];
    expect(payload).toMatchObject({
      sessionId: SESSION,
      turnId: TURN,
      utterance_id: UTT,
      perceived_latency_ms: 1500, // 2500 - 1000
      utterance_end_at_ms: 1_780_000_000_000,
      ios_playback_ack_at_ms: 1_780_000_001_500,
      ack_source: 'bundler',
      expected_acks_eligible: 1,
    });
    expect(_peekEntryCountForTests()).toBe(0); // entry cleared after emit
  });
});

describe('recordTurnAudioSummary → recordUtteranceEnd (arrival order B)', () => {
  test('audio_summary then utterance_end → emit turn_perceived_latency_ms once', () => {
    recordTurnAudioSummary(audioSummary());
    recordUtteranceEnd(utteranceEnd());
    const events = findEvents('voice_latency.turn_perceived_latency_ms');
    expect(events).toHaveLength(1);
    const [, payload] = events[0];
    expect(payload.perceived_latency_ms).toBe(1500);
    expect(_peekEntryCountForTests()).toBe(0);
  });
});

describe('process_uptime_id mismatch', () => {
  test('both halves present but UIDs differ → skipped with mismatch reason; no perceived_latency_ms', () => {
    recordUtteranceEnd(utteranceEnd({ process_uptime_id: 'pu-A' }));
    recordTurnAudioSummary(audioSummary({ ios_playback_ack_process_uptime_id: 'pu-B' }));
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    const skipped = findEvents('voice_latency.turn_perceived_latency_skipped');
    expect(skipped).toHaveLength(1);
    const [, payload] = skipped[0];
    expect(payload.reason).toBe('process_uptime_id_mismatch');
    expect(payload.utterance_end_process_uptime_id).toBe('pu-A');
    expect(payload.audio_summary_process_uptime_id).toBe('pu-B');
  });
});

describe('Eligible zero-ack lifecycle', () => {
  test('audio_summary with no ack + eligible=1; late ack arrives → emit on merge', () => {
    // On-time summary arrives with eligible=1 but ack_source=null (timeout fired)
    recordTurnAudioSummary(
      audioSummary({
        ack_source: null,
        ios_playback_ack_at_ms: null,
        ios_playback_ack_monotonic_at_ms: null,
        ios_playback_ack_process_uptime_id: null,
        ios_playback_ack_correlation_id: null,
        audio_finalizer_timeout_fired: true,
      })
    );
    recordUtteranceEnd(utteranceEnd());
    // No emit yet — we're holding for late ack.
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    expect(findEvents('voice_latency.turn_perceived_latency_skipped')).toHaveLength(0);

    // Late ack arrives via the merge hook.
    recordLatePlaybackAck({
      sessionId: SESSION,
      turnId: TURN,
      ack_source: 'bundler',
      ios_playback_ack_at_ms: 1_780_000_002_000,
      ios_playback_ack_monotonic_at_ms: 3000, // 2000 ms after UE
      ios_playback_ack_process_uptime_id: PUID,
      ios_playback_ack_correlation_id: null,
    });

    const events = findEvents('voice_latency.turn_perceived_latency_ms');
    expect(events).toHaveLength(1);
    expect(events[0][1].perceived_latency_ms).toBe(2000);
  });

  test('TTL expires with no late ack → skipped with reason no_audio_ack_at_ttl', () => {
    recordTurnAudioSummary(
      audioSummary({
        ack_source: null,
        ios_playback_ack_at_ms: null,
        ios_playback_ack_monotonic_at_ms: null,
        ios_playback_ack_process_uptime_id: null,
        ios_playback_ack_correlation_id: null,
        audio_finalizer_timeout_fired: true,
      })
    );
    recordUtteranceEnd(utteranceEnd());
    _forceTtlExpiryForTests(SESSION, TURN);
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    const skipped = findEvents('voice_latency.turn_perceived_latency_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1].reason).toBe('no_audio_ack_at_ttl');
  });
});

describe('Ineligible (expected_acks_eligible = 0) lifecycle', () => {
  test('zero-ack + ineligible → silent drop at TTL (no event of either kind)', () => {
    recordTurnAudioSummary(
      audioSummary({
        expected_acks: 0,
        expected_acks_eligible: 0,
        ack_source: null,
        ios_playback_ack_at_ms: null,
        ios_playback_ack_monotonic_at_ms: null,
        ios_playback_ack_process_uptime_id: null,
        ios_playback_ack_correlation_id: null,
      })
    );
    // Note: no utterance_end — ineligible turns often don't pair.
    _forceTtlExpiryForTests(SESSION, TURN);
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    expect(findEvents('voice_latency.turn_perceived_latency_skipped')).toHaveLength(0);
  });

  test('ineligible WITH ack present + paired utterance_end → still emit perceived_latency_ms (store does NOT filter)', () => {
    recordTurnAudioSummary(audioSummary({ expected_acks_eligible: 0 }));
    recordUtteranceEnd(utteranceEnd());
    const events = findEvents('voice_latency.turn_perceived_latency_ms');
    expect(events).toHaveLength(1);
    expect(events[0][1].expected_acks_eligible).toBe(0);
    expect(events[0][1].perceived_latency_ms).toBe(1500);
  });
});

describe('Late ack without prior summary (diagnostic)', () => {
  test('recordLatePlaybackAck with no prior recordTurnAudioSummary → skipped with reason late_ack_without_summary', () => {
    recordLatePlaybackAck({
      sessionId: SESSION,
      turnId: TURN,
      ack_source: 'bundler',
      ios_playback_ack_at_ms: 1_780_000_002_000,
      ios_playback_ack_monotonic_at_ms: 3000,
      ios_playback_ack_process_uptime_id: PUID,
      ios_playback_ack_correlation_id: null,
    });
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    const skipped = findEvents('voice_latency.turn_perceived_latency_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1].reason).toBe('late_ack_without_summary');
    expect(_peekEntryCountForTests()).toBe(0); // no entry was created
  });
});

describe('orphaned utterance_end is ignored', () => {
  test('recordUtteranceEnd skips when orphaned: true (no entry, no emit)', () => {
    recordUtteranceEnd(utteranceEnd({ orphaned: true, turnId: null }));
    expect(_peekEntryCountForTests()).toBe(0);
    recordTurnAudioSummary(audioSummary());
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    // The audio_summary side creates an entry on its own.
    expect(_peekEntryCountForTests()).toBe(1);
  });
});

describe('TTL cleanup — utterance_end-only entry', () => {
  test('utterance_end without audio_summary → skipped with no_audio_ack_at_ttl on TTL', () => {
    recordUtteranceEnd(utteranceEnd());
    _forceTtlExpiryForTests(SESSION, TURN);
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    const skipped = findEvents('voice_latency.turn_perceived_latency_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1].reason).toBe('no_audio_ack_at_ttl');
  });
});

describe('TTL cleanup — audio_summary-only entry (eligible)', () => {
  test('audio_summary without utterance_end → skipped with no_utterance_end_at_ttl', () => {
    recordTurnAudioSummary(audioSummary());
    _forceTtlExpiryForTests(SESSION, TURN);
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(0);
    const skipped = findEvents('voice_latency.turn_perceived_latency_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1].reason).toBe('no_utterance_end_at_ttl');
  });
});

describe('No-throw guarantee', () => {
  test('recordUtteranceEnd with garbage payload does NOT throw, does NOT emit', () => {
    expect(() => recordUtteranceEnd(null)).not.toThrow();
    expect(() => recordUtteranceEnd(undefined)).not.toThrow();
    expect(() => recordUtteranceEnd({})).not.toThrow();
    expect(() => recordUtteranceEnd('string')).not.toThrow();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test('recordTurnAudioSummary with garbage payload does NOT throw', () => {
    expect(() => recordTurnAudioSummary(null)).not.toThrow();
    expect(() => recordTurnAudioSummary({})).not.toThrow();
  });

  test('recordLatePlaybackAck with garbage payload does NOT throw', () => {
    expect(() => recordLatePlaybackAck(null)).not.toThrow();
    expect(() => recordLatePlaybackAck({})).not.toThrow();
  });
});

describe('Multiple sessions / turns do not collide', () => {
  test('two sessions with same turnId-suffix get distinct entries', () => {
    recordUtteranceEnd(utteranceEnd({ sessionId: 'A', turnId: 'A-turn-1' }));
    recordUtteranceEnd(utteranceEnd({ sessionId: 'B', turnId: 'B-turn-1' }));
    expect(_peekEntryCountForTests()).toBe(2);
    recordTurnAudioSummary(audioSummary({ sessionId: 'A', turnId: 'A-turn-1' }));
    expect(findEvents('voice_latency.turn_perceived_latency_ms')).toHaveLength(1);
    expect(_peekEntryCountForTests()).toBe(1); // B still pending
  });
});
