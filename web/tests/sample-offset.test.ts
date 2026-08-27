import { describe, it, expect } from 'vitest';
import { audioWindowEndToSampleOffset, UPLINK_SAMPLE_RATE_HZ } from '@/lib/recording/sample-offset';

describe('audioWindowEndToSampleOffset (PLAN-E1 shared parity helper)', () => {
  it('converts seconds to a floor-rounded 16kHz sample offset', () => {
    expect(audioWindowEndToSampleOffset(1)).toBe(16000);
    expect(audioWindowEndToSampleOffset(0.5)).toBe(8000);
    expect(audioWindowEndToSampleOffset(0)).toBe(0);
  });

  it('floor-rounds a partial-sample boundary', () => {
    // 1.00003125s * 16000 = 16000.5 -> floors to 16000
    expect(audioWindowEndToSampleOffset(1.00003125)).toBe(16000);
  });

  it('rejects negative input', () => {
    expect(() => audioWindowEndToSampleOffset(-0.1)).toThrow(RangeError);
  });

  it('rejects non-finite input', () => {
    expect(() => audioWindowEndToSampleOffset(NaN)).toThrow(RangeError);
    expect(() => audioWindowEndToSampleOffset(Infinity)).toThrow(RangeError);
  });

  it('the sample rate constant matches the uplink pipeline', () => {
    expect(UPLINK_SAMPLE_RATE_HZ).toBe(16000);
  });
});
