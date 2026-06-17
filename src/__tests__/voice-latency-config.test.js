/**
 * Voice-latency config — flag snapshot + kill-switch contract.
 */

import { jest } from '@jest/globals';

const flags = await import('../extraction/voice-latency-config.js');

const ENV_KEYS = [
  'VOICE_LATENCY_STREAM_CONFIRMATIONS',
  'VOICE_LATENCY_SUPPRESSION',
  'VOICE_LATENCY_REGEX_FAST_TTS',
  'VOICE_LATENCY_STREAM_ASK_USER',
  'VOICE_LATENCY_USE_MULTI_CONTEXT',
  'VOICE_LATENCY_LOADED_BARREL',
  'VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN',
  'VOICE_LATENCY_KILL_SWITCH',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('snapshotFlagsForSession', () => {
  test('all false by default (no env vars set)', () => {
    const snap = flags.snapshotFlagsForSession();
    expect(snap).toEqual({
      streamConfirmations: false,
      suppression: false,
      regexFastTts: false,
      streamAskUser: false,
      useMultiContext: false,
      loadedBarrel: false,
    });
  });

  test('parses true / 1 / yes / on case-insensitively', () => {
    process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS = 'true';
    process.env.VOICE_LATENCY_SUPPRESSION = '1';
    process.env.VOICE_LATENCY_REGEX_FAST_TTS = 'YES';
    process.env.VOICE_LATENCY_STREAM_ASK_USER = 'on';
    process.env.VOICE_LATENCY_USE_MULTI_CONTEXT = 'True';
    process.env.VOICE_LATENCY_LOADED_BARREL = 'on';
    const snap = flags.snapshotFlagsForSession();
    expect(snap).toEqual({
      streamConfirmations: true,
      suppression: true,
      regexFastTts: true,
      streamAskUser: true,
      useMultiContext: true,
      loadedBarrel: true,
    });
  });

  test('treats any other value as false (including "yes please", 2, false)', () => {
    process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS = 'false';
    process.env.VOICE_LATENCY_SUPPRESSION = '0';
    process.env.VOICE_LATENCY_REGEX_FAST_TTS = '2';
    process.env.VOICE_LATENCY_STREAM_ASK_USER = 'yes please';
    process.env.VOICE_LATENCY_USE_MULTI_CONTEXT = '';
    process.env.VOICE_LATENCY_LOADED_BARREL = 'maybe';
    const snap = flags.snapshotFlagsForSession();
    expect(snap).toEqual({
      streamConfirmations: false,
      suppression: false,
      regexFastTts: false,
      streamAskUser: false,
      useMultiContext: false,
      loadedBarrel: false,
    });
  });

  test('returned snapshot is frozen', () => {
    const snap = flags.snapshotFlagsForSession();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      snap.streamConfirmations = true;
    }).toThrow();
  });

  test('two snapshots taken sequentially with different env are independent', () => {
    process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS = 'true';
    const a = flags.snapshotFlagsForSession();
    delete process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS;
    const b = flags.snapshotFlagsForSession();
    expect(a.streamConfirmations).toBe(true);
    expect(b.streamConfirmations).toBe(false);
  });
});

describe('isKillSwitchActive', () => {
  test('false by default', () => {
    expect(flags.isKillSwitchActive()).toBe(false);
  });

  test('flips when env set to true', () => {
    process.env.VOICE_LATENCY_KILL_SWITCH = 'true';
    expect(flags.isKillSwitchActive()).toBe(true);
  });

  test('reads fresh on every call (live override)', () => {
    process.env.VOICE_LATENCY_KILL_SWITCH = 'false';
    expect(flags.isKillSwitchActive()).toBe(false);
    process.env.VOICE_LATENCY_KILL_SWITCH = '1';
    expect(flags.isKillSwitchActive()).toBe(true);
    process.env.VOICE_LATENCY_KILL_SWITCH = 'off';
    expect(flags.isKillSwitchActive()).toBe(false);
  });
});

describe('SNAPSHOT_FLAG_ENV_NAMES', () => {
  test('lists exactly the 6 snapshotted env-var names', () => {
    expect(flags.SNAPSHOT_FLAG_ENV_NAMES).toEqual([
      'VOICE_LATENCY_STREAM_CONFIRMATIONS',
      'VOICE_LATENCY_SUPPRESSION',
      'VOICE_LATENCY_REGEX_FAST_TTS',
      'VOICE_LATENCY_STREAM_ASK_USER',
      'VOICE_LATENCY_USE_MULTI_CONTEXT',
      'VOICE_LATENCY_LOADED_BARREL',
    ]);
  });

  test('does NOT include the kill switch (live override)', () => {
    expect(flags.SNAPSHOT_FLAG_ENV_NAMES).not.toContain('VOICE_LATENCY_KILL_SWITCH');
  });

  test('does NOT include the per-turn cap (live tunable, not snapshotted)', () => {
    expect(flags.SNAPSHOT_FLAG_ENV_NAMES).not.toContain('VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN');
  });
});

describe('getLoadedBarrelMaxPerTurn (Phase 1.E live tunable)', () => {
  test('returns 2 by default when env unset', () => {
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
  });

  test('returns 2 when env value is empty string', () => {
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
  });

  test('parses positive integer', () => {
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '5';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(5);
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '1';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(1);
  });

  test('defaults to 2 for non-integer / negative / zero values (defensive against config errors)', () => {
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '0';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '-1';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '2.5';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = 'not a number';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
  });

  test('reads fresh on every call (live override)', () => {
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '3';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(3);
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '7';
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(7);
    delete process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN;
    expect(flags.getLoadedBarrelMaxPerTurn()).toBe(2);
  });
});

describe('parseVoiceLatencyCapabilities (1a.3 handshake)', () => {
  test('missing capabilities → version 0, supports empty', () => {
    const c = flags.parseVoiceLatencyCapabilities(undefined);
    expect(c.version).toBe(0);
    expect(c.supports.size).toBe(0);
    expect(c.hasStreamingHttpAudio).toBe(false);
  });

  test('null capabilities → version 0', () => {
    const c = flags.parseVoiceLatencyCapabilities(null);
    expect(c.version).toBe(0);
  });

  test('non-object capabilities → version 0', () => {
    expect(flags.parseVoiceLatencyCapabilities('string').version).toBe(0);
    expect(flags.parseVoiceLatencyCapabilities(42).version).toBe(0);
    expect(flags.parseVoiceLatencyCapabilities([]).version).toBe(0);
  });

  test('capabilities without voice_latency → version 0', () => {
    const c = flags.parseVoiceLatencyCapabilities({ other_namespace: { version: 1 } });
    expect(c.version).toBe(0);
    expect(c.supports.size).toBe(0);
  });

  test('voice_latency.version=0 → supports forced empty even if supports[] populated', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: { version: 0, supports: ['streaming_http_audio'] },
    });
    expect(c.version).toBe(0);
    expect(c.supports.size).toBe(0);
    expect(c.hasStreamingHttpAudio).toBe(false);
  });

  test('voice_latency.version=2 (future) → supports empty for safety', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: { version: 2, supports: ['streaming_http_audio'] },
    });
    expect(c.version).toBe(2);
    expect(c.supports.size).toBe(0);
    expect(c.hasStreamingHttpAudio).toBe(false);
  });

  test('valid v1 + all supports → predicates all true', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: {
        version: 1,
        supports: [
          'streaming_http_audio',
          'source_field_in_tts_post',
          'regex_fast_tts',
          'voice_latency_ack',
          'kill_switch_drop_queue',
          'regex_fast_v2',
          'client_playback_telemetry',
        ],
      },
    });
    expect(c.version).toBe(1);
    expect(c.hasStreamingHttpAudio).toBe(true);
    expect(c.hasSourceFieldInTtsPost).toBe(true);
    expect(c.hasRegexFastTts).toBe(true);
    expect(c.hasVoiceLatencyAck).toBe(true);
    expect(c.hasKillSwitchDropQueue).toBe(true);
    expect(c.hasRegexFastV2).toBe(true);
    expect(c.hasClientPlaybackTelemetry).toBe(true);
  });

  // Single-round latency sprint Phase 1 — regex_fast_v2 is a NEW
  // capability marker iOS sets in addition to the legacy regex_fast_tts.
  // The fast-TTS route handler gates on hasRegexFastV2 specifically so
  // older iOS clients (which only have regex_fast_tts) take the path
  // without the v2 contract guarantees.
  test('regex_fast_v2 and client_playback_telemetry default false when absent', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: { version: 1, supports: ['regex_fast_tts'] },
    });
    expect(c.hasRegexFastTts).toBe(true);
    expect(c.hasRegexFastV2).toBe(false);
    expect(c.hasClientPlaybackTelemetry).toBe(false);
  });

  test('regex_fast_v2 alone (without legacy regex_fast_tts) trips only hasRegexFastV2', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: { version: 1, supports: ['regex_fast_v2'] },
    });
    expect(c.hasRegexFastV2).toBe(true);
    expect(c.hasRegexFastTts).toBe(false);
  });

  test('valid v1 + partial supports → matching predicates only', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: {
        version: 1,
        supports: ['streaming_http_audio', 'voice_latency_ack'],
      },
    });
    expect(c.hasStreamingHttpAudio).toBe(true);
    expect(c.hasVoiceLatencyAck).toBe(true);
    expect(c.hasSourceFieldInTtsPost).toBe(false);
    expect(c.hasRegexFastTts).toBe(false);
    expect(c.hasKillSwitchDropQueue).toBe(false);
  });

  test('supports non-array → supports empty', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: { version: 1, supports: 'streaming_http_audio' },
    });
    expect(c.supports.size).toBe(0);
  });

  test('non-string entries inside supports are dropped', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: {
        version: 1,
        supports: ['streaming_http_audio', 42, null, { x: 1 }, 'voice_latency_ack'],
      },
    });
    expect(c.supports.size).toBe(2);
    expect(c.hasStreamingHttpAudio).toBe(true);
    expect(c.hasVoiceLatencyAck).toBe(true);
  });

  test('unknown support string is preserved in supports Set but not exposed as a predicate', () => {
    const c = flags.parseVoiceLatencyCapabilities({
      voice_latency: { version: 1, supports: ['future_feature_x', 'streaming_http_audio'] },
    });
    expect(c.supports.has('future_feature_x')).toBe(true);
    expect(c.hasStreamingHttpAudio).toBe(true);
  });

  test('preserves raw payload for startup log', () => {
    const raw = {
      voice_latency: { version: 1, supports: ['streaming_http_audio'], extra_field: 'ignored' },
    };
    const c = flags.parseVoiceLatencyCapabilities(raw);
    expect(c.raw).toBe(raw);
  });
});

describe('VOICE_LATENCY_KNOWN_SUPPORTS', () => {
  test('lists exactly the 7 known support strings', () => {
    expect([...flags.VOICE_LATENCY_KNOWN_SUPPORTS]).toEqual([
      'streaming_http_audio',
      'source_field_in_tts_post',
      'regex_fast_tts',
      'voice_latency_ack',
      'kill_switch_drop_queue',
      'regex_fast_v2',
      'client_playback_telemetry',
    ]);
  });
});
