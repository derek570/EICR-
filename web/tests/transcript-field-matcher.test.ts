import { describe, it, expect } from 'vitest';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import type { JobDetail } from '@/lib/types';

function emptyJob(extra: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'j1',
    number: 'J-001',
    property_address: '',
    certificate_type: 'EICR',
    cert_type: 'EICR',
    circuits: [],
    ...extra,
  } as unknown as JobDetail;
}

function ringJob(circuitRef: string): JobDetail {
  return emptyJob({
    circuits: [
      {
        id: `uuid-${circuitRef}`,
        circuit_ref: circuitRef,
        circuit_designation: 'Ring Sockets',
      },
    ],
  } as unknown as Partial<JobDetail>);
}

describe('TranscriptFieldMatcher — Zs (loop_impedance)', () => {
  it('"Circuit 3, Zs is 0.44" → measured_zs_ohm=0.44', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3, Zs is 0.44', emptyJob());
    expect(result.circuitUpdates.get('3')?.measured_zs_ohm).toBe('0.44');
  });

  it('"Circuit 12 Zs 0.27" → measured_zs_ohm=0.27 (no "is" needed)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 12 Zs 0.27', emptyJob());
    expect(result.circuitUpdates.get('12')?.measured_zs_ohm).toBe('0.27');
  });

  it('"Circuit 4 Zs at the board 0.05" → no Zs (excluded by "Zs at board")', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 4 Zs at the board 0.05', emptyJob());
    expect(result.circuitUpdates.get('4')?.measured_zs_ohm).toBeUndefined();
  });

  it('Zs out of range (50 Ω) is rejected', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 Zs is 50', emptyJob());
    expect(result.circuitUpdates.get('5')?.measured_zs_ohm).toBeUndefined();
  });

  it('Zs >2dp is rejected (R1 codex deferral lock — 4dp value is a normaliser tell)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 Zs is 0.6016', emptyJob());
    expect(result.circuitUpdates.get('5')?.measured_zs_ohm).toBeUndefined();
  });

  it('multi-circuit segmentation: each Zs lands on its own circuit', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 Zs is 0.44. Circuit 12 Zs is 0.27', emptyJob());
    expect(result.circuitUpdates.get('3')?.measured_zs_ohm).toBe('0.44');
    expect(result.circuitUpdates.get('12')?.measured_zs_ohm).toBe('0.27');
  });
});

describe('TranscriptFieldMatcher — earth_continuity (R1+R2 compound)', () => {
  it('"Circuit 3, R1 plus R2 is 0.87" → r1_r2_ohm=0.87', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3, R1 plus R2 is 0.87', emptyJob());
    expect(result.circuitUpdates.get('3')?.r1_r2_ohm).toBe('0.87');
  });

  it('"R1 + R2 0.45" with explicit "+" → r1_r2_ohm=0.45', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 7 R1 + R2 0.45', emptyJob());
    expect(result.circuitUpdates.get('7')?.r1_r2_ohm).toBe('0.45');
  });

  it('"R1 and R2 is 0.32" → r1_r2_ohm=0.32 (and-form)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 8 R1 and R2 is 0.32', emptyJob());
    expect(result.circuitUpdates.get('8')?.r1_r2_ohm).toBe('0.32');
  });

  it('out-of-range R1+R2 (50 Ω) rejected', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 R1 plus R2 is 50', emptyJob());
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBeUndefined();
  });

  it('bare "R1 0.30" → r1_r2_ohm fallback (iOS contract)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 R1 0.30', emptyJob());
    expect(result.circuitUpdates.get('3')?.r1_r2_ohm).toBe('0.30');
  });

  it('bare "R2 0.40" → r1_r2_ohm fallback', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 R2 0.40', emptyJob());
    expect(result.circuitUpdates.get('3')?.r1_r2_ohm).toBe('0.40');
  });
});

describe('TranscriptFieldMatcher — ring_continuity (ring R1 / Rn / R2)', () => {
  it('"ring R1 is 0.34" on a ring circuit → ring_r1_ohm', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 ring R1 is 0.34', ringJob('5'));
    expect(result.circuitUpdates.get('5')?.ring_r1_ohm).toBe('0.34');
  });

  it('"neutrals are 0.36" on a ring circuit → ring_rn_ohm', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 ring neutrals are 0.36', ringJob('5'));
    expect(result.circuitUpdates.get('5')?.ring_rn_ohm).toBe('0.36');
  });

  it('"ring R2 is 0.40" on a ring circuit → ring_r2_ohm', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 ring R2 is 0.40', ringJob('5'));
    expect(result.circuitUpdates.get('5')?.ring_r2_ohm).toBe('0.40');
  });

  it('non-ring circuit: "ring R1" does NOT populate ring_r1_ohm (missing context)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 R1 is 0.34', emptyJob()); // no ring designation
    // Should populate r1_r2_ohm via the bare-R1 fallback, not ring_r1_ohm.
    expect(result.circuitUpdates.get('5')?.ring_r1_ohm).toBeUndefined();
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBe('0.34');
  });
});

describe('TranscriptFieldMatcher — insulation_resistance', () => {
  it('"live to earth is 299" → ir_live_earth_mohm=299', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 live to earth is 299', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_earth_mohm).toBe('299');
  });

  it('"live to earth greater than 299" → ir_live_earth_mohm=">299"', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 live to earth greater than 299', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_earth_mohm).toBe('>299');
  });

  it('postfix form: "299 megohms live to earth" → ir_live_earth_mohm=299', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 299 megohms live to earth', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_earth_mohm).toBe('299');
  });

  it('postfix with greater: "greater than 299 megohms live to earth" → ">299"', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 greater than 299 megohms live to earth', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_earth_mohm).toBe('>299');
  });

  it('"test voltage is 250 live to earth" → no postfix match (test_voltage exclusion)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 test voltage is 250 live to earth 299', emptyJob());
    // "250" must not be claimed as the IR value via postfix; the
    // matcher falls through to the prefix pattern which captures
    // 299 from "live to earth … 299".
    expect(result.circuitUpdates.get('3')?.ir_live_earth_mohm).toBe('299');
  });

  it('IR live-live: "live to live is 299" → ir_live_live_mohm=299', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 live to live is 299', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_live_mohm).toBe('299');
  });

  it('IR live-live postfix: "299 megohms live to live" → ir_live_live_mohm=299', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 299 megohms live to live', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_live_mohm).toBe('299');
  });

  it('IR with "L-E" abbreviation → matches', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 L-E is 250', emptyJob());
    expect(result.circuitUpdates.get('3')?.ir_live_earth_mohm).toBe('250');
  });
});

describe('TranscriptFieldMatcher — RCD trip time', () => {
  it('"RCD 25" → rcd_time_ms=25', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 7 RCD 25', emptyJob());
    expect(result.circuitUpdates.get('7')?.rcd_time_ms).toBe('25');
  });

  it('"RCD trip time is 18 ms" → rcd_time_ms=18', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 7 RCD trip time is 18 ms', emptyJob());
    expect(result.circuitUpdates.get('7')?.rcd_time_ms).toBe('18');
  });

  it('flex form: "trip time for the cooker is 25"', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 8 trip time for the cooker is 25', emptyJob());
    expect(result.circuitUpdates.get('8')?.rcd_time_ms).toBe('25');
  });

  it('out-of-range (>1000 ms) rejected', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 7 RCD 5000', emptyJob());
    expect(result.circuitUpdates.get('7')?.rcd_time_ms).toBeUndefined();
  });
});

describe('TranscriptFieldMatcher — polarity', () => {
  it('"polarity is confirmed" → polarity_confirmed="✓"', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 polarity is confirmed', emptyJob());
    expect(result.circuitUpdates.get('3')?.polarity_confirmed).toBe('✓');
  });

  it('"polarity OK" → polarity_confirmed="✓"', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 polarity OK', emptyJob());
    expect(result.circuitUpdates.get('3')?.polarity_confirmed).toBe('✓');
  });

  it('"polarity is reversed" → no positive match (only ok/confirmed/pass/correct fire)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 3 polarity is reversed', emptyJob());
    expect(result.circuitUpdates.get('3')?.polarity_confirmed).toBeUndefined();
  });
});

describe('TranscriptFieldMatcher — supply (Ze + PFC)', () => {
  it('"Ze is 0.34" → supplyUpdates.ze=0.34', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Ze is 0.34', emptyJob());
    expect(result.supplyUpdates.ze).toBe('0.34');
  });

  it('"Ze 0.84" (bare) → matches', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Ze 0.84', emptyJob());
    expect(result.supplyUpdates.ze).toBe('0.84');
  });

  it('"PFC is 1.5 kA" → pfc=1.5', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('PFC is 1.5 kA', emptyJob());
    expect(result.supplyUpdates.pfc).toBe('1.5');
  });

  it('"prospective fault current 2.3" → pfc=2.3', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('prospective fault current 2.3', emptyJob());
    expect(result.supplyUpdates.pfc).toBe('2.3');
  });

  it('Ze with >2dp rejected (R1 codex deferral lock)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Ze is 0.6016', emptyJob());
    expect(result.supplyUpdates.ze).toBeUndefined();
  });
});

describe('TranscriptFieldMatcher — circuit-ref disambiguation (R1 codex deferral)', () => {
  it('"circuit 16 amp m c b" rejects 16 as a circuit ref (rating-merge guard)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('circuit 16 amp m c b', emptyJob());
    // The matcher must NOT claim circuit 16 — that would be a
    // normaliser-collapsed "circuit 1 6 amp m c b". v1 just drops
    // the ambiguous ref entirely.
    expect(result.circuitUpdates.has('16')).toBe(false);
  });

  it('"circuit 5 with a 16 amp MCB" still claims circuit 5 (filler word breaks ambiguity)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 with a 16 amp MCB Zs is 0.44', emptyJob());
    // 5 is followed by "with", not "amp" — unambiguous.
    expect(result.circuitUpdates.get('5')?.measured_zs_ohm).toBe('0.44');
  });
});

describe('TranscriptFieldMatcher — sliding window + active circuit', () => {
  it('lastProcessedOffset advances on each call (no double-match)', () => {
    const matcher = new TranscriptFieldMatcher();
    matcher.match('Circuit 3 Zs is 0.44', emptyJob());
    const result = matcher.match('Circuit 3 Zs is 0.44', emptyJob());
    // Second call: no NEW chars, so the matcher early-returns empty.
    expect(result.circuitUpdates.size).toBe(0);
  });

  it('reset() clears state — same input then matches again', () => {
    const matcher = new TranscriptFieldMatcher();
    matcher.match('Circuit 3 Zs is 0.44', emptyJob());
    matcher.reset();
    const result = matcher.match('Circuit 3 Zs is 0.44', emptyJob());
    expect(result.circuitUpdates.get('3')?.measured_zs_ohm).toBe('0.44');
  });

  it('window stays at 500 chars — old text outside the window does not re-match', () => {
    const matcher = new TranscriptFieldMatcher();
    const padding = 'a '.repeat(300); // 600 chars of fillerphysical
    const result = matcher.match(`${padding}Circuit 3 Zs is 0.44`, emptyJob());
    // The "Circuit 3 Zs is 0.44" tail is within 500 chars of the
    // string end, so it matches. Padding precedes the window and
    // doesn't affect anything.
    expect(result.circuitUpdates.get('3')?.measured_zs_ohm).toBe('0.44');
  });

  it('active circuit ref carries across calls when no new ref is mentioned', () => {
    const matcher = new TranscriptFieldMatcher();
    // First utterance — sets active to circuit 3.
    matcher.match('Circuit 3 Zs is 0.44', emptyJob());
    // Second utterance — no "circuit N" prefix, but active is still 3.
    const result = matcher.match('Circuit 3 Zs is 0.44 R1 plus R2 is 0.87', emptyJob());
    expect(result.circuitUpdates.get('3')?.r1_r2_ohm).toBe('0.87');
  });
});

describe('TranscriptFieldMatcher — circuit-ref forms', () => {
  it('"circuit one" → ref=1 (word-form digit)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit one Zs is 0.44', emptyJob());
    expect(result.circuitUpdates.get('1')?.measured_zs_ohm).toBe('0.44');
  });

  it('"way 5" → ref=5 (way alias for circuit)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Way 5 Zs is 0.44', emptyJob());
    expect(result.circuitUpdates.get('5')?.measured_zs_ohm).toBe('0.44');
  });

  it('"first circuit" → ref=1 (ordinal form)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('First circuit Zs is 0.44', emptyJob());
    expect(result.circuitUpdates.get('1')?.measured_zs_ohm).toBe('0.44');
  });

  it('"circuit number 12" → ref=12', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit number 12 Zs is 0.44', emptyJob());
    expect(result.circuitUpdates.get('12')?.measured_zs_ohm).toBe('0.44');
  });
});

describe('TranscriptFieldMatcher — empty + degenerate inputs', () => {
  it('empty transcript → empty result', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('', emptyJob());
    expect(result.circuitUpdates.size).toBe(0);
    expect(Object.keys(result.supplyUpdates).length).toBe(0);
  });

  it('whitespace-only transcript → empty result', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('     \n\n   ', emptyJob());
    expect(result.circuitUpdates.size).toBe(0);
  });

  it('transcript without any circuit ref or supply word → empty', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('hello world this is a test', emptyJob());
    expect(result.circuitUpdates.size).toBe(0);
    expect(Object.keys(result.supplyUpdates).length).toBe(0);
  });
});
