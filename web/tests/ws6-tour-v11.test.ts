/**
 * WS6 — Tour v11 refresh (iOS build 417 / TourManager 2026-06-30).
 *
 * Pins:
 *   - step counts: 2 dashboard + 9 job = 11 overall (was 10);
 *   - the NEW "conversational + tone" step (iOS jobSteps[3]) exists at
 *     job index 3 with `chime: true` and the verbatim iOS narration;
 *   - the Defaults step carries the revised (shortened) narration —
 *     the cable-size worked examples + OCPD guidance are GONE;
 *   - the Observations step no longer claims read-backs need the
 *     voice button (read-backs are automatic — Audio-First inv. 1);
 *   - the chime synth is a sample-accurate port of iOS
 *     `makeChimeWAVData` (960 Hz / 80 ms / 10 ms linear attack /
 *     exp(-(t-a)*20) decay / 0.5 amplitude).
 */

import { describe, expect, it } from 'vitest';
import { DASHBOARD_TOUR_STEPS, JOB_TOUR_STEPS, OVERALL_TOUR_TOTAL } from '@/lib/tour/steps';
// WS3 item 7 (2026-07-02): the chime synthesis moved from the WS6
// interim tour-local module (lib/tour/tour-chime.ts, deleted) into the
// canonical lib/recording/tones.ts — same waveform, one copy in web/.
import {
  CHIME_AMPLITUDE,
  CHIME_ATTACK_S,
  CHIME_DURATION_S,
  CHIME_SAMPLE_RATE,
  synthesiseChimeSamples,
  playSentForProcessingChime,
  __resetTonesForTests,
} from '@/lib/recording/tones';

describe('tour v11 step structure', () => {
  it('has 2 dashboard + 9 job = 11 steps overall (iOS TourManager v11)', () => {
    expect(DASHBOARD_TOUR_STEPS).toHaveLength(2);
    expect(JOB_TOUR_STEPS).toHaveLength(9);
    expect(OVERALL_TOUR_TOTAL).toBe(11);
  });

  it('inserts the conversational+tone step at job index 3 with the chime flag', () => {
    const tone = JOB_TOUR_STEPS[3];
    expect(tone.id).toBe('job-tone');
    expect(tone.chime).toBe(true);
    // iOS jobSteps[3] narration, verbatim anchors:
    expect(tone.narration).toContain('CertMate is conversational.');
    expect(tone.narration).toContain("you'll hear a short tone");
    expect(tone.narration).toContain('nothing was sent');
    // It is the ONLY chiming step.
    expect(JOB_TOUR_STEPS.filter((s) => s.chime).map((s) => s.id)).toEqual(['job-tone']);
    expect(DASHBOARD_TOUR_STEPS.some((s) => s.chime)).toBe(false);
  });

  it('keeps the surrounding v10 steps in iOS order around the insertion', () => {
    expect(JOB_TOUR_STEPS.map((s) => s.id)).toEqual([
      'job-overview',
      'job-ccu',
      'job-readings',
      'job-tone',
      'job-multi',
      'job-observations',
      'job-obs-photo',
      'job-queries',
      'job-pdf',
    ]);
  });

  it('Defaults narration is the revised short form (worked examples stripped)', () => {
    const defaults = DASHBOARD_TOUR_STEPS[1];
    expect(defaults.narration).toContain('standard default cable sizes for each circuit type');
    // The 2026-06-30 revision removed the cable-size worked examples
    // and the OCPD-rating guidance:
    expect(defaults.narration).not.toContain('two point five mil');
    expect(defaults.narration).not.toContain('OCPD');
    expect(defaults.narration).not.toContain('thirty two amp');
  });

  it('Observations step dropped the stale "press the voice button" read-back line', () => {
    const obs = JOB_TOUR_STEPS[5];
    expect(obs.id).toBe('job-observations');
    expect(obs.narration).toContain("just say 'observation'");
    expect(obs.narration).not.toContain('press the voice button');
  });
});

describe('tour chime synthesis (iOS makeChimeWAVData port)', () => {
  it('produces exactly 80 ms of samples at 22.05 kHz', () => {
    const samples = synthesiseChimeSamples();
    expect(samples.length).toBe(Math.floor(CHIME_SAMPLE_RATE * CHIME_DURATION_S));
    expect(samples.length).toBe(1764);
  });

  it('ramps linearly over the 10 ms attack, then decays exponentially', () => {
    const sr = CHIME_SAMPLE_RATE;
    const samples = synthesiseChimeSamples(sr);
    const attackSamples = Math.floor(sr * CHIME_ATTACK_S);

    // Envelope at a peak-phase sample inside the attack is below the
    // post-attack peak; overall peak never exceeds the 0.5 amplitude.
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeLessThanOrEqual(CHIME_AMPLITUDE);
    expect(peak).toBeGreaterThan(CHIME_AMPLITUDE * 0.8);

    // Exponential decay: envelope at t=attack+40ms must match
    // exp(-0.04*20) ≈ 0.449 of the post-attack level. Compare local
    // maxima over one carrier period to sidestep sine phase.
    const periodSamples = Math.ceil(sr / 960);
    const localMax = (centre: number) => {
      let m = 0;
      for (let i = centre; i < centre + periodSamples && i < samples.length; i++) {
        m = Math.max(m, Math.abs(samples[i]));
      }
      return m;
    };
    const early = localMax(attackSamples);
    const late = localMax(attackSamples + Math.floor(sr * 0.04));
    expect(late / early).toBeGreaterThan(0.35);
    expect(late / early).toBeLessThan(0.55);
  });

  it('playSentForProcessingChime is fail-quiet without an AudioContext (jsdom)', () => {
    __resetTonesForTests(); // fresh lazy-init path, no cached context
    expect(() => playSentForProcessingChime()).not.toThrow();
  });
});
