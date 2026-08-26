import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { audioWindowEndToSampleOffset } from '@/lib/recording/sample-offset';

/**
 * PLAN-E1 (split-round-30 BLOCKER) — the shared parity fixture
 * (`config/sample-offset-parity-vectors.json`) asserts this web
 * implementation agrees with its Swift twin
 * (`CertMateUnified/Tests/CertMateUnifiedTests/SampleOffsetParityTests.swift`)
 * on every vector.
 */

interface ParityFixture {
  sample_rate_hz: number;
  valid_vectors: Array<{ seconds: number; expected_sample_offset: number }>;
  invalid_vectors: Array<{ seconds: number | string }>;
}

const fixturePath = path.resolve(__dirname, '../../config/sample-offset-parity-vectors.json');
const fixture: ParityFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function coerceSeconds(raw: number | string): number {
  if (raw === 'NaN') return NaN;
  if (raw === 'Infinity') return Infinity;
  return raw as number;
}

describe('audioWindowEndToSampleOffset — shared parity fixture', () => {
  it('the fixture pins 16kHz', () => {
    expect(fixture.sample_rate_hz).toBe(16000);
  });

  for (const vector of fixture.valid_vectors) {
    it(`seconds=${vector.seconds} -> ${vector.expected_sample_offset}`, () => {
      expect(audioWindowEndToSampleOffset(vector.seconds)).toBe(vector.expected_sample_offset);
    });
  }

  for (const vector of fixture.invalid_vectors) {
    it(`rejects invalid input: ${JSON.stringify(vector.seconds)}`, () => {
      expect(() => audioWindowEndToSampleOffset(coerceSeconds(vector.seconds))).toThrow();
    });
  }
});
