/**
 * PLAN-D D6 — the voice-pause resume tone (Acceptance 14(v), web half).
 *
 * Records every scheduled Web Audio call through a stub AudioContext and
 * asserts:
 *   - the resume tone's constants equal the shared fixture's `resume_tone`
 *     object (parameters, never bytes — iOS renders PCM);
 *   - each note schedules `linearRampToValueAtTime(peak, when + 0.010)` from
 *     a zero gain, then the exponential decay to the fixture floor at the
 *     note's end;
 *   - the two existing oscillator tones keep today's schedule exactly: a 5 ms
 *     EXPONENTIAL attack from 0.0001 (the `ToneStep` defaults);
 *   - the tone notifies no TTS lifecycle observer (property 1 of D6).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  playVoiceResumeTone,
  playAttentionTone,
  playConfirmationChime,
  VOICE_RESUME_TONE_NOTES,
  __resetTonesForTests,
} from '@/lib/recording/tones';
import { setTtsLifecycleObserver } from '@/lib/recording/tts';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'config', 'voice-pause-vectors.json'), 'utf8')
) as {
  resume_tone: {
    notes: Array<{
      frequency_hz: number;
      duration_ms: number;
      attack_ms: number;
      attack_curve: string;
      decay_curve: string;
      decay_floor_gain: number;
      peak_amplitude: number;
      waveform: string;
    }>;
    attack_ms: number;
    attack_curve: string;
  };
};

type Call = { node: 'gain' | 'freq' | 'osc'; method: string; args: unknown[] };

class StubAudioContext {
  static calls: Call[] = [];
  static oscillators: Array<{ type: string }> = [];
  currentTime = 1;
  state: AudioContextState = 'running';
  destination = {};
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    const rec =
      (method: string) =>
      (...args: unknown[]) =>
        StubAudioContext.calls.push({ node: 'freq', method, args });
    const osc = {
      type: 'sine',
      frequency: {
        setValueAtTime: rec('setValueAtTime'),
        linearRampToValueAtTime: rec('linearRampToValueAtTime'),
      },
      connect: (g: unknown) => g,
      start: (...args: unknown[]) =>
        StubAudioContext.calls.push({ node: 'osc', method: 'start', args }),
      stop: (...args: unknown[]) =>
        StubAudioContext.calls.push({ node: 'osc', method: 'stop', args }),
    };
    StubAudioContext.oscillators.push(osc);
    return osc;
  }
  createGain() {
    const rec =
      (method: string) =>
      (...args: unknown[]) =>
        StubAudioContext.calls.push({ node: 'gain', method, args });
    const gainNode = {
      gain: {
        setValueAtTime: rec('setValueAtTime'),
        linearRampToValueAtTime: rec('linearRampToValueAtTime'),
        exponentialRampToValueAtTime: rec('exponentialRampToValueAtTime'),
      },
      connect: () => gainNode,
    };
    return gainNode;
  }
}

function gainCalls() {
  return StubAudioContext.calls.filter((c) => c.node === 'gain');
}

describe('PLAN-D D6 — resume tone (web)', () => {
  beforeEach(() => {
    StubAudioContext.calls = [];
    StubAudioContext.oscillators = [];
    __resetTonesForTests();
    vi.stubGlobal('AudioContext', StubAudioContext as unknown as typeof AudioContext);
    (window as unknown as { AudioContext: unknown }).AudioContext = StubAudioContext;
  });
  afterEach(() => {
    __resetTonesForTests();
    setTtsLifecycleObserver(null);
    vi.unstubAllGlobals();
  });

  it('constants equal the fixture resume_tone parameters', () => {
    expect(fixture.resume_tone.attack_ms).toBe(10);
    expect(fixture.resume_tone.attack_curve).toBe('linear');
    expect(VOICE_RESUME_TONE_NOTES).toHaveLength(fixture.resume_tone.notes.length);
    fixture.resume_tone.notes.forEach((note, i) => {
      const mine = VOICE_RESUME_TONE_NOTES[i];
      expect(mine.frequencyHz).toBe(note.frequency_hz);
      expect(Math.round(mine.durationS * 1000)).toBe(note.duration_ms);
      expect(Math.round(mine.attackS * 1000)).toBe(note.attack_ms);
      expect(mine.peakGain).toBe(note.peak_amplitude);
      expect(note.attack_curve).toBe('linear');
      expect(note.decay_curve).toBe('exponential');
      expect(note.waveform).toBe('sine');
    });
  });

  it('schedules a 10 ms linear attack from zero and an exponential decay per note', () => {
    const result = playVoiceResumeTone();
    expect(result.contextState).toBe('running');
    const g = gainCalls();
    let when = 1;
    fixture.resume_tone.notes.forEach((note, i) => {
      const [set, attack, decay] = g.slice(i * 3, i * 3 + 3);
      expect(set).toEqual({ node: 'gain', method: 'setValueAtTime', args: [0, when] });
      expect(attack.method).toBe('linearRampToValueAtTime');
      expect(attack.args[0]).toBe(note.peak_amplitude);
      expect(attack.args[1]).toBeCloseTo(when + note.attack_ms / 1000, 9);
      expect(decay.method).toBe('exponentialRampToValueAtTime');
      expect(decay.args[0]).toBe(note.decay_floor_gain);
      expect(decay.args[1]).toBeCloseTo(when + note.duration_ms / 1000, 9);
      when += note.duration_ms / 1000;
    });
    expect(StubAudioContext.oscillators.map((o) => o.type)).toEqual(['sine', 'sine']);
    const freqs = StubAudioContext.calls
      .filter((c) => c.node === 'freq' && c.method === 'setValueAtTime')
      .map((c) => c.args[0]);
    expect(freqs).toEqual(fixture.resume_tone.notes.map((n) => n.frequency_hz));
  });

  it('leaves the two existing oscillator tones on the 5 ms exponential attack', () => {
    playAttentionTone();
    playConfirmationChime();
    const g = gainCalls();
    // attention: 1 note; chime: 2 notes — each set / exp attack / exp decay.
    expect(g).toHaveLength(9);
    for (let i = 0; i < 3; i++) {
      const [set, attack, decay] = g.slice(i * 3, i * 3 + 3);
      expect(set.method).toBe('setValueAtTime');
      expect(set.args[0]).toBe(0.0001);
      expect(attack.method).toBe('exponentialRampToValueAtTime');
      expect(attack.args[1] as number).toBeCloseTo((set.args[1] as number) + 0.005, 9);
      expect(decay.method).toBe('exponentialRampToValueAtTime');
      expect(decay.args[0]).toBe(0.0001);
    }
    expect(g.some((c) => c.method === 'linearRampToValueAtTime')).toBe(false);
  });

  it('notifies no TTS lifecycle observer and fails quiet without a context', () => {
    const observer = vi.fn();
    setTtsLifecycleObserver(observer);
    playVoiceResumeTone();
    expect(observer).not.toHaveBeenCalled();
    __resetTonesForTests();
    vi.unstubAllGlobals();
    (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
    expect(playVoiceResumeTone()).toEqual({ contextState: 'unavailable' });
  });
});
