/**
 * budget.mjs — the live-lane scheduled-cost envelope (plan Item 3 "Budget").
 *
 * Honest scoping: GitHub Actions runs are stateless, so this is a
 * conservative pre-run PROJECTION guard, not a durable cumulative monthly
 * ledger (deliberately deferred). Before any vendor call the nightly
 * workflow computes the projected cost of a COMPLETE shard rotation — the
 * SUM over every shard execution in one full rotation (rotating shards have
 * different fixture sets, so `this_run × runs_per_month` is not a valid
 * envelope) — from the versioned price table, using conservative
 * per-fixture token ceilings PER TOKEN CLASS. If
 * `rotation_cost × planned_rotations_per_month` exceeds the monthly GBP
 * target, the run STOPS and files the advisory issue instead of running.
 *
 * Currency policy: vendor prices are USD, the target is GBP — every
 * projection converts at the pinned (deliberately high) usd_to_gbp rate and
 * ROUNDS UP; rounding = ceil each cost component to the penny, then sum.
 */

const PENNY = 100;

function ceilToPennyGbp(usd, usdToGbp) {
  return Math.ceil(usd * usdToGbp * PENNY) / PENNY;
}

/** Deterministic shard selection for a run: day-of-rotation modulo shards. */
export function selectShard(runIndex, shards) {
  return ((runIndex % shards) + shards) % shards;
}

/**
 * Worst-case cost of ONE live fixture execution in USD, from its token
 * ceilings (per token class) and its model's price row, multiplied by the
 * retry-attempt policy.
 */
export function projectFixtureCostUsd(budget, fixture) {
  const modelId = fixture.model;
  const prices = budget.models[modelId];
  if (!prices) {
    throw new Error(`budget table has no price row for model "${modelId}" — refusing to project`);
  }
  const ceilings = fixture.token_ceilings ?? budget.per_fixture_token_ceiling;
  const required = ['uncached_input', 'cache_creation_input', 'cache_read_input', 'output'];
  for (const k of required) {
    if (typeof ceilings[k] !== 'number') {
      throw new Error(`fixture ${fixture.corpus_id}: token ceiling "${k}" missing — an {input, output} pair is NOT conservative (runToolLoop permits 8×4096 output and the captured session recorded 106k cache-read tokens on a three-round turn)`);
    }
  }
  const perAttempt =
    (ceilings.uncached_input / 1e6) * prices.input_usd_per_mtok +
    (ceilings.cache_creation_input / 1e6) * prices.cache_write_usd_per_mtok +
    (ceilings.cache_read_input / 1e6) * prices.cache_read_usd_per_mtok +
    (ceilings.output / 1e6) * prices.output_usd_per_mtok;
  return perAttempt * (budget.retry_attempts_multiplier ?? 1);
}

/**
 * Projected GBP cost of one COMPLETE rotation (every shard executed once —
 * i.e. every live fixture once), each component ceil'd to the penny.
 */
export function projectRotationCostGbp(budget, liveFixtures) {
  let total = 0;
  for (const f of liveFixtures) {
    total += ceilToPennyGbp(projectFixtureCostUsd(budget, f), budget.usd_to_gbp);
  }
  return Math.ceil(total * PENNY) / PENNY;
}

/**
 * The pre-run guard. Returns { ok, rotationCostGbp, monthlyProjectionGbp,
 * targetGbp } — ok=false means STOP and file the advisory issue instead of
 * running (no vendor call is made).
 */
export function evaluateBudgetEnvelope(budget, liveFixtures) {
  const rotationCostGbp = projectRotationCostGbp(budget, liveFixtures);
  const monthlyProjectionGbp =
    Math.ceil(rotationCostGbp * budget.planned_rotations_per_month * PENNY) / PENNY;
  return {
    ok: monthlyProjectionGbp <= budget.monthly_target_gbp,
    rotationCostGbp,
    monthlyProjectionGbp,
    targetGbp: budget.monthly_target_gbp,
  };
}

/**
 * planned_rotations_per_month must over-cover the month:
 * ceil(days_in_budget_month / shard_count). Validated against a 31-day
 * month (budget tests cover it).
 */
export function requiredRotationsForMonth(daysInMonth, shards) {
  return Math.ceil(daysInMonth / shards);
}

/** Structural validation of the budget table (schema pins). */
export function validateBudgetTable(budget) {
  const errors = [];
  if (budget.version == null) errors.push('version missing');
  if (!budget.models || Object.keys(budget.models).length === 0) errors.push('models missing');
  for (const [id, row] of Object.entries(budget.models ?? {})) {
    for (const k of ['input_usd_per_mtok', 'output_usd_per_mtok', 'cache_write_usd_per_mtok', 'cache_read_usd_per_mtok']) {
      if (typeof row[k] !== 'number' || row[k] <= 0) errors.push(`models.${id}.${k} invalid`);
    }
  }
  if (!(budget.usd_to_gbp >= 0.8)) {
    errors.push('usd_to_gbp must be deliberately HIGH (>= 0.8) so projections over-estimate GBP cost');
  }
  const c = budget.per_fixture_token_ceiling ?? {};
  for (const k of ['uncached_input', 'cache_creation_input', 'cache_read_input', 'output']) {
    if (typeof c[k] !== 'number' || c[k] <= 0) errors.push(`per_fixture_token_ceiling.${k} invalid`);
  }
  if (!(c.output >= 8 * 4096)) {
    errors.push('output ceiling must be >= max_rounds(8) × 4096');
  }
  if (budget.planned_rotations_per_month < requiredRotationsForMonth(31, budget.shards)) {
    errors.push('planned_rotations_per_month under-covers a 31-day month');
  }
  if (!(budget.hard_max_vendor_calls >= 1)) errors.push('hard_max_vendor_calls invalid');
  if (budget.rounding !== 'ceil_component_to_penny_then_sum') errors.push('rounding rule must be pinned');
  return { ok: errors.length === 0, errors };
}
