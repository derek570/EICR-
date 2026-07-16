/**
 * budget.test.js — the live-lane cost envelope (plan Item 3). Pins the
 * versioned table's structure, the per-token-class ceilings (an
 * {input, output} pair is NOT conservative), the 106k-cache-read
 * three-round-turn replay, the eight-round output cap case, the 31-day
 * month coverage, currency rounding, and the STOP semantics.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  projectFixtureCostUsd,
  projectRotationCostGbp,
  evaluateBudgetEnvelope,
  requiredRotationsForMonth,
  validateBudgetTable,
  selectShard,
} from '../../../scripts/field-replay/lib/budget.mjs';

const budget = JSON.parse(
  fs.readFileSync(path.resolve('config/field-replay-budget.json'), 'utf8'),
);

describe('the committed budget table (config/field-replay-budget.json v1)', () => {
  test('validates structurally', () => {
    const v = validateBudgetTable(budget);
    expect(v.errors).toEqual([]);
  });
  test('pinned non-price values', () => {
    expect(budget.usd_to_gbp).toBe(0.85);
    expect(budget.shards).toBe(4);
    expect(budget.planned_rotations_per_month).toBe(8);
    expect(budget.hard_max_vendor_calls).toBe(40);
    expect(budget.rounding).toBe('ceil_component_to_penny_then_sum');
    expect(budget.retry_attempts_multiplier).toBe(3);
  });
  test('carries price rows for BOTH pinned routing models', () => {
    expect(budget.models['claude-haiku-4-5-20251001']).toBeDefined();
    expect(budget.models['claude-sonnet-4-6']).toBeDefined();
  });
  test('output ceiling >= 8 rounds × 4096 (hard-coded LOOP_CAP/max_tokens)', () => {
    expect(budget.per_fixture_token_ceiling.output).toBeGreaterThanOrEqual(8 * 4096);
  });
  test('planned rotations over-cover a 31-day month', () => {
    expect(requiredRotationsForMonth(31, budget.shards)).toBe(8);
    expect(budget.planned_rotations_per_month).toBeGreaterThanOrEqual(8);
  });
});

describe('projection mechanics', () => {
  const haikuFixture = (ceilings) => ({
    corpus_id: 'frc_0123456789abcdef0123456789abcdef',
    model: 'claude-haiku-4-5-20251001',
    token_ceilings: ceilings,
  });

  test('replays the captured 106k-cache-read THREE-round turn (cache reads dominate ceiling design)', () => {
    // The captured session recorded 106,126 cache-read tokens on a
    // three-round turn — a naive {input, output} ceiling would miss this
    // entire class. One attempt at Haiku rates: 106,126 × $0.10/MTok.
    const usd = projectFixtureCostUsd(
      { ...budget, retry_attempts_multiplier: 1 },
      haikuFixture({ uncached_input: 0, cache_creation_input: 0, cache_read_input: 106126, output: 0 }),
    );
    expect(usd).toBeCloseTo(0.0106126, 6);
  });

  test('the eight-round cap case: output ceiling 8×4096 at Haiku rates', () => {
    const usd = projectFixtureCostUsd(
      { ...budget, retry_attempts_multiplier: 1 },
      haikuFixture({ uncached_input: 0, cache_creation_input: 0, cache_read_input: 0, output: 8 * 4096 }),
    );
    expect(usd).toBeCloseTo((32768 / 1e6) * 5.0, 6);
  });

  test('the retry-attempt policy multiplies the envelope (SDK maxRetries 2 → 3 attempts)', () => {
    const single = projectFixtureCostUsd(
      { ...budget, retry_attempts_multiplier: 1 },
      haikuFixture({ uncached_input: 1000, cache_creation_input: 0, cache_read_input: 0, output: 1000 }),
    );
    const tripled = projectFixtureCostUsd(
      budget,
      haikuFixture({ uncached_input: 1000, cache_creation_input: 0, cache_read_input: 0, output: 1000 }),
    );
    expect(tripled).toBeCloseTo(single * 3, 9);
  });

  test('a missing token class refuses to project (an {input, output} pair is NOT conservative)', () => {
    expect(() =>
      projectFixtureCostUsd(budget, haikuFixture({ uncached_input: 1000, output: 1000 })),
    ).toThrow(/NOT conservative/);
  });

  test('an unpriced model refuses to project', () => {
    expect(() =>
      projectFixtureCostUsd(budget, { corpus_id: 'frc_x', model: 'claude-nonexistent' }),
    ).toThrow(/no price row/);
  });

  test('GBP conversion rounds UP per component (pinned 0.85 rate)', () => {
    // One fixture costing exactly $0.011 → ×0.85 = £0.00935 → ceil to £0.01.
    const fixtures = [
      haikuFixture({ uncached_input: 0, cache_creation_input: 0, cache_read_input: 0, output: 2200 / 3 }),
    ];
    const gbp = projectRotationCostGbp(budget, fixtures);
    expect(gbp).toBeGreaterThanOrEqual(0.01);
    expect(Number.isInteger(gbp * 100)).toBe(true); // penny-resolved
  });

  test('the guard STOPs (ok=false) when monthly projection exceeds the £10 target — no vendor call', () => {
    // Ten default-ceiling Haiku fixtures blow the envelope by design.
    const fixtures = Array.from({ length: 10 }, () => haikuFixture(undefined));
    const verdict = evaluateBudgetEnvelope(budget, fixtures);
    expect(verdict.monthlyProjectionGbp).toBeGreaterThan(verdict.targetGbp);
    expect(verdict.ok).toBe(false);
  });

  test('an empty live set projects £0 and passes', () => {
    const verdict = evaluateBudgetEnvelope(budget, []);
    expect(verdict).toMatchObject({ ok: true, rotationCostGbp: 0, monthlyProjectionGbp: 0 });
  });

  test('shard selection is deterministic — exactly one of 4 shards per run, never all four', () => {
    const picks = [0, 1, 2, 3, 4, 5].map((i) => selectShard(i, 4));
    expect(picks).toEqual([0, 1, 2, 3, 0, 1]);
  });
});

describe('table mutations reset the chain (fingerprint component)', () => {
  test('usd_to_gbp below the deliberately-high floor rejects', () => {
    const v = validateBudgetTable({ ...budget, usd_to_gbp: 0.74 });
    expect(v.ok).toBe(false);
  });
  test('under-covering rotations reject', () => {
    const v = validateBudgetTable({ ...budget, planned_rotations_per_month: 7 });
    expect(v.errors.some((e) => e.includes('31-day'))).toBe(true);
  });
  test('an output ceiling under 8×4096 rejects', () => {
    const v = validateBudgetTable({
      ...budget,
      per_fixture_token_ceiling: { ...budget.per_fixture_token_ceiling, output: 30000 },
    });
    expect(v.errors.some((e) => e.includes('4096'))).toBe(true);
  });
});
