/**
 * WS3 item 6 — LIM sentinel regression coverage (2026-07-02).
 *
 * AUDIT OUTCOME (implement-only-confirmed-gaps rule): web LIM support
 * already exists and mirrors iOS byte-for-byte —
 *   - regex: IR L-E / L-L LIM patterns (transcript-field-matcher.ts:466-468,
 *     identical to iOS irLiveEarthLimPattern/irLiveLiveLimPattern),
 *     supply-fuse + main-switch rating/BS-EN LIM (:365-390);
 *   - apply: apply-extraction.ts / apply-regex-match.ts store raw string
 *     values (no numeric coercion on IR fields), so "LIM" lands as-is;
 *   - display: circuits grid cells are type="text" (inputMode is only a
 *     keyboard hint), so a stored "LIM" renders and can be typed.
 * The confirmed gap was ZERO regression tests pinning any of it. These
 * tests pin the regex + apply paths so a future numeric-coercion or
 * pattern refactor can't silently drop the sentinel (backend PR #55 made
 * LIM first-class server-side; a client that drops it re-opens the
 * 2026-06-16 IR re-ask loop).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail, CircuitRow } from '@/lib/types';

function makeJob(circuits: Array<{ ref: string; designation: string }> = []): JobDetail {
  const rows: CircuitRow[] = circuits.map((c, i) => ({
    id: `r${i}`,
    circuit_ref: c.ref,
    circuit_designation: c.designation,
  }));
  return {
    id: 'test',
    user_id: 'test',
    folder_name: 'test',
    certificate_type: 'EICR' as const,
    created_date: new Date(0).toISOString(),
    circuits: rows,
  } as unknown as JobDetail;
}

describe('LIM sentinel — regex paths (iOS TranscriptFieldMatcher parity)', () => {
  let matcher: TranscriptFieldMatcher;

  beforeEach(() => {
    matcher = new TranscriptFieldMatcher();
  });

  // The canonical hands-free flow: circuit context is established by a
  // prior utterance, then the bare LIM phrase applies to that circuit.
  // (A digit-prefixed single utterance like "circuit 1 live to earth is
  // LIM" hits the NUMERIC postfix pattern first and captures the circuit
  // digit as the value — a quirk shared byte-for-byte with iOS, whose
  // patterns and ordering are identical; matching it is deliberate
  // iOS-canon parity, and the server-side Sonnet pass overwrites the
  // regex tier 1-2 s later regardless.)
  it('"live to earth is LIM" with prior circuit context → ir_live_earth_mohm = "LIM"', () => {
    const job = makeJob([{ ref: '1', designation: 'Sockets' }]);
    matcher.match('circuit 1 zs is 0.4', job);
    const result = matcher.match('live to earth is LIM', job);
    expect(result?.circuit_updates['1']?.ir_live_earth_mohm).toBe('LIM');
  });

  it('"live to earth is a limitation" (Deepgram long form) → LIM', () => {
    const job = makeJob([{ ref: '1', designation: 'Sockets' }]);
    matcher.match('circuit 1 zs is 0.4', job);
    const result = matcher.match('live to earth is a limitation', job);
    expect(result?.circuit_updates['1']?.ir_live_earth_mohm).toBe('LIM');
  });

  it('"live to live is limb" (Deepgram garble variant) → ir_live_live_mohm = "LIM"', () => {
    const job = makeJob([{ ref: '2', designation: 'Lights' }]);
    matcher.match('circuit 2 zs is 0.3', job);
    const result = matcher.match('live to live is limb', job);
    expect(result?.circuit_updates['2']?.ir_live_live_mohm).toBe('LIM');
  });

  it('word boundary holds: "climbing" does not fire the LIM branch', () => {
    const result = matcher.match(
      'circuit 1 live to earth is climbing',
      makeJob([{ ref: '1', designation: 'Sockets' }])
    );
    expect(result?.circuit_updates?.['1']?.ir_live_earth_mohm).not.toBe('LIM');
  });

  // P3 (2026-07-23) — exact four-form policy on the client instant-regex.
  it('"live to earth is limp" (fourth form, previously missed) → LIM', () => {
    const job = makeJob([{ ref: '1', designation: 'Sockets' }]);
    matcher.match('circuit 1 zs is 0.4', job);
    const result = matcher.match('live to earth is limp', job);
    expect(result?.circuit_updates['1']?.ir_live_earth_mohm).toBe('LIM');
  });

  it('near-match "limited" no longer writes LIM (client obeys the four-form policy)', () => {
    const job = makeJob([{ ref: '1', designation: 'Sockets' }]);
    matcher.match('circuit 1 zs is 0.4', job);
    const result = matcher.match('live to earth is limited', job);
    expect(result?.circuit_updates?.['1']?.ir_live_earth_mohm).not.toBe('LIM');
  });

  it('numeric IR still wins where dictated: "live to earth greater than 299" is not LIM', () => {
    const result = matcher.match(
      'circuit 1 IR live to earth greater than 299 megohms',
      makeJob([{ ref: '1', designation: 'Sockets' }])
    );
    const value = result?.circuit_updates?.['1']?.ir_live_earth_mohm;
    expect(value).toBeDefined();
    expect(value).not.toBe('LIM');
  });

  it('"main fuse is a limitation" → spd_rated_current = "LIM" (supply path)', () => {
    const result = matcher.match('main fuse is a limitation', makeJob());
    expect(result?.supply_updates?.spd_rated_current).toBe('LIM');
  });

  it('"main switch is a limitation" → main_switch_current = "LIM"', () => {
    const result = matcher.match('main switch is a limitation', makeJob());
    expect(result?.supply_updates?.main_switch_current).toBe('LIM');
  });
});

describe('LIM sentinel — Sonnet apply path stores the raw string', () => {
  it('reading value "LIM" on ir_live_earth_mohm lands on the circuit row untouched', () => {
    const job = makeJob([{ ref: '1', designation: 'Sockets' }]);
    const result: ExtractionResult = {
      readings: [
        {
          field: 'ir_live_earth_mohm',
          value: 'LIM',
          circuit: 1,
        } as ExtractionResult['readings'][number],
      ],
      observations: [],
    };
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const circuits = applied!.patch.circuits as CircuitRow[];
    const row = circuits.find((c) => c.circuit_ref === '1');
    expect(row?.ir_live_earth_mohm).toBe('LIM');
  });

  it('reading value "LIM" on ir_live_live_mohm lands untouched', () => {
    const job = makeJob([{ ref: '1', designation: 'Sockets' }]);
    const result: ExtractionResult = {
      readings: [
        {
          field: 'ir_live_live_mohm',
          value: 'LIM',
          circuit: 1,
        } as ExtractionResult['readings'][number],
      ],
      observations: [],
    };
    const applied = applyExtractionToJob(job, result);
    const circuits = applied!.patch.circuits as CircuitRow[];
    expect(circuits.find((c) => c.circuit_ref === '1')?.ir_live_live_mohm).toBe('LIM');
  });
});
