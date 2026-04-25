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

  it('codex P2 R3: radial circuit (NO row in job) + transcript saying "ring R1" → drops the reading', () => {
    // The job has no row for circuit 5 at all (so designation is
    // effectively undefined). Empty-job → no row → fallback path.
    // The strict P2 guarantee (don't populate ring fields without
    // a clear ring signal) is held by the labelled-radial test
    // below; this case is a no-row degenerate where neither side
    // can decide, so we drop the reading rather than guess.
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 R1 is 0.34', emptyJob());
    // With no row, there's no designation. The inline "R1" form
    // is bare (no "ring" prefix), so it falls through to the bare-
    // R1 → r1_r2_ohm fallback which IS allowed (no explicit ring
    // marker in the segment).
    expect(result.circuitUpdates.get('5')?.ring_r1_ohm).toBeUndefined();
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBe('0.34');
  });

  it('codex P1 R3 follow-up: unlabeled circuit + explicit "ring R1" populates ring_r1_ohm (no designation yet)', () => {
    // The common live-fill case: a row freshly created with
    // circuit_designation: ''. We can't yet know if it's a ring,
    // but the inspector's explicit "ring R1" form is unambiguous
    // and trustworthy. Without this branch the reading would drop
    // entirely until the user named the circuit.
    const matcher = new TranscriptFieldMatcher();
    const job = emptyJob({
      circuits: [{ id: 'uuid-5', circuit_ref: '5', circuit_designation: '' }],
    } as unknown as Partial<JobDetail>);
    const result = matcher.match('Circuit 5 ring R1 is 0.34', job);
    expect(result.circuitUpdates.get('5')?.ring_r1_ohm).toBe('0.34');
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBeUndefined();
  });

  it('codex P2 R3 still locks: labelled radial + transcript "ring R1" does NOT populate ring fields', () => {
    // Cooker is unambiguously a radial; trust the user's
    // designation over the transcript wording.
    const matcher = new TranscriptFieldMatcher();
    const job = emptyJob({
      circuits: [{ id: 'uuid-5', circuit_ref: '5', circuit_designation: 'Cooker' }],
    } as unknown as Partial<JobDetail>);
    const result = matcher.match('Circuit 5 ring R1 is 0.34', job);
    expect(result.circuitUpdates.get('5')?.ring_r1_ohm).toBeUndefined();
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBeUndefined();
  });

  it('codex P1 R3 follow-up #2: active-circuit follow-up keeps ring classification across utterances', () => {
    // After the inspector says "Circuit 5 ring R1 is 0.34" against
    // an unlabeled circuit, the matcher caches circuit 5 as a ring.
    // A follow-up utterance like "neutrals are 0.36" (no "circuit"
    // prefix, no "ring" word) lands on circuit 5 via the active-
    // circuit-ref fallback — and now correctly hits ring_rn_ohm
    // because the cache survives across calls.
    const matcher = new TranscriptFieldMatcher();
    const job = emptyJob({
      circuits: [{ id: 'uuid-5', circuit_ref: '5', circuit_designation: '' }],
    } as unknown as Partial<JobDetail>);
    // Recording-context passes the full accumulated transcript; the
    // matcher slides its 500-char window internally.
    const turn1 = 'Circuit 5 ring R1 is 0.34';
    matcher.match(turn1, job);
    expect(matcher._knownRingCircuitsForTest().has('5')).toBe(true);
    const turn2 = `${turn1} neutrals are 0.36`;
    const result = matcher.match(turn2, job);
    expect(result.circuitUpdates.get('5')?.ring_rn_ohm).toBe('0.36');
  });

  it('codex P2 R3 follow-up #3: rename to non-ring designation drops the sticky cache', () => {
    // Inspector says "Circuit 5 ring R1 is 0.34" against a blank
    // row → cache marks 5 as ring. They then rename circuit 5 to
    // "Cooker" (a radial). A follow-up "neutrals are 0.36" must
    // NOT populate ring_rn_ohm — the authoritative designation
    // overrides the stale cache entry.
    const matcher = new TranscriptFieldMatcher();
    const turn1Job = emptyJob({
      circuits: [{ id: 'uuid-5', circuit_ref: '5', circuit_designation: '' }],
    } as unknown as Partial<JobDetail>);
    const turn1 = 'Circuit 5 ring R1 is 0.34';
    matcher.match(turn1, turn1Job);
    expect(matcher._knownRingCircuitsForTest().has('5')).toBe(true);

    const turn2Job = emptyJob({
      circuits: [{ id: 'uuid-5', circuit_ref: '5', circuit_designation: 'Cooker' }],
    } as unknown as Partial<JobDetail>);
    const turn2 = `${turn1} neutrals are 0.36`;
    const result = matcher.match(turn2, turn2Job);
    expect(result.circuitUpdates.get('5')?.ring_rn_ohm).toBeUndefined();
    // Cache also dropped:
    expect(matcher._knownRingCircuitsForTest().has('5')).toBe(false);
  });

  it('codex P2 R3 follow-up #2: missing circuit row → not treated as unlabeled ring', () => {
    // Job has NO row for circuit 22. An utterance "Circuit 22 ring
    // R1 is 0.34" must NOT populate ring_r1_ohm — that would be
    // inventing a ring classification for a circuit the user has
    // never registered. Falls through to bare-R1 fallback (which is
    // also blocked by hasExplicitRingForm), so the reading drops.
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 22 ring R1 is 0.34', emptyJob());
    expect(result.circuitUpdates.get('22')?.ring_r1_ohm).toBeUndefined();
    expect(result.circuitUpdates.get('22')?.r1_r2_ohm).toBeUndefined();
  });

  it('codex P1 R3: explicit "ring R1" on a ring circuit populates ring_r1_ohm ONLY (not r1_r2_ohm)', () => {
    // Without the hasExplicitRingForm guard the same value would be
    // double-written into both ring_r1_ohm AND r1_r2_ohm.
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 ring R1 is 0.34', ringJob('5'));
    expect(result.circuitUpdates.get('5')?.ring_r1_ohm).toBe('0.34');
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBeUndefined();
  });

  it('codex P1 R3: explicit "ring R2" on a ring circuit populates ring_r2_ohm ONLY (not r1_r2_ohm)', () => {
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match('Circuit 5 ring R2 is 0.40', ringJob('5'));
    expect(result.circuitUpdates.get('5')?.ring_r2_ohm).toBe('0.40');
    expect(result.circuitUpdates.get('5')?.r1_r2_ohm).toBeUndefined();
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

  it('codex P3 R3: later flex-form correction wins over earlier short-form RCD reading', () => {
    // "RCD 25" early in the segment, then "trip time ... 30" later
    // (the inspector correcting their first reading). Pre-fix the
    // ?? chain returned 25; the lastCaptureAcross helper now picks
    // the latest match across both patterns.
    const matcher = new TranscriptFieldMatcher();
    const result = matcher.match(
      'Circuit 7 RCD 25 ms, sorry, trip time is actually 30',
      emptyJob()
    );
    expect(result.circuitUpdates.get('7')?.rcd_time_ms).toBe('30');
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
