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
    });
  });

  test('parses true / 1 / yes / on case-insensitively', () => {
    process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS = 'true';
    process.env.VOICE_LATENCY_SUPPRESSION = '1';
    process.env.VOICE_LATENCY_REGEX_FAST_TTS = 'YES';
    process.env.VOICE_LATENCY_STREAM_ASK_USER = 'on';
    process.env.VOICE_LATENCY_USE_MULTI_CONTEXT = 'True';
    const snap = flags.snapshotFlagsForSession();
    expect(snap).toEqual({
      streamConfirmations: true,
      suppression: true,
      regexFastTts: true,
      streamAskUser: true,
      useMultiContext: true,
    });
  });

  test('treats any other value as false (including "yes please", 2, false)', () => {
    process.env.VOICE_LATENCY_STREAM_CONFIRMATIONS = 'false';
    process.env.VOICE_LATENCY_SUPPRESSION = '0';
    process.env.VOICE_LATENCY_REGEX_FAST_TTS = '2';
    process.env.VOICE_LATENCY_STREAM_ASK_USER = 'yes please';
    process.env.VOICE_LATENCY_USE_MULTI_CONTEXT = '';
    const snap = flags.snapshotFlagsForSession();
    expect(snap).toEqual({
      streamConfirmations: false,
      suppression: false,
      regexFastTts: false,
      streamAskUser: false,
      useMultiContext: false,
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
  test('lists exactly the 5 snapshotted env-var names', () => {
    expect(flags.SNAPSHOT_FLAG_ENV_NAMES).toEqual([
      'VOICE_LATENCY_STREAM_CONFIRMATIONS',
      'VOICE_LATENCY_SUPPRESSION',
      'VOICE_LATENCY_REGEX_FAST_TTS',
      'VOICE_LATENCY_STREAM_ASK_USER',
      'VOICE_LATENCY_USE_MULTI_CONTEXT',
    ]);
  });

  test('does NOT include the kill switch (live override)', () => {
    expect(flags.SNAPSHOT_FLAG_ENV_NAMES).not.toContain('VOICE_LATENCY_KILL_SWITCH');
  });
});
