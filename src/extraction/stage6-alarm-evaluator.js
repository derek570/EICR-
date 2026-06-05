/**
 * Stage 6 Phase 8 — Plan 08-01 SC #4 — pure-JS CloudWatch alarm evaluator.
 *
 * WHAT: `evaluateAlarm(alarmDef, dataPoints)` mirrors the subset of AWS
 * CloudWatch alarm semantics our 3 Stage 6 alarms (defined in
 * infra/cloudwatch-stage6-alarms.json) actually use. Returns one of
 * 'OK' | 'ALARM' | 'INSUFFICIENT_DATA' matching CloudWatch's wire
 * states for the same input.
 *
 * WHY ship this: Phase 8 ROADMAP §SC #4 explicitly says "alarms actually
 * fire on test data". Synthetic-breach test data run through this
 * evaluator (in src/__tests__/stage6-alarm-thresholds.test.js) proves
 * the alarm thresholds + evaluation logic are wired correctly WITHOUT
 * requiring an operational AWS account during CI. When the operator
 * later applies the alarm definitions via `aws cloudwatch put-metric-
 * alarm`, AWS evaluates the same data the same way — modulo statistic
 * pre-aggregation which the test's caller does explicitly.
 *
 * AWS subset modelled (intentionally narrow — extending the subset
 * requires test coverage for the extension):
 *   - ComparisonOperator: GreaterThanThreshold only
 *   - Statistic: Average — caller pre-aggregates to per-period averages
 *     before calling evaluateAlarm; evaluator treats `dataPoints` as
 *     the already-aggregated values
 *   - EvaluationPeriods + DatapointsToAlarm: M-of-N model. CloudWatch
 *     fires ALARM when at least DatapointsToAlarm of the trailing
 *     EvaluationPeriods data points breach the threshold. All 3 Stage 6
 *     alarms set DatapointsToAlarm = EvaluationPeriods (3-of-3) so the
 *     anti-flap discipline is consistent across the surface.
 *   - TreatMissingData = notBreaching: missing periods (null/undefined
 *     in dataPoints) count as OK, not as breaching. Stage 6 alarms all
 *     specify this.
 *
 * Out of subset (would require test coverage if added):
 *   - Other comparison operators (Less*, Equal, NotEqual)
 *   - Other statistics (Sum / Maximum / Minimum / SampleCount)
 *   - DatapointsToAlarm < EvaluationPeriods proper "M of N" mode
 *   - Other TreatMissingData modes (missing / breaching / ignore)
 *
 * Evaluator semantics — INSUFFICIENT_DATA path:
 *   When the caller provides fewer than EvaluationPeriods data points,
 *   AWS reports INSUFFICIENT_DATA. This is distinct from OK and matters
 *   to operators (it means "the metric isn't being emitted reliably",
 *   which is itself an operational concern for low-traffic periods).
 *   We surface the distinct state for parity with AWS.
 *
 * Plan 08-01 deliberate non-feature: this module does NOT integrate with
 * any AWS SDK. It's a pure-function evaluator over hand-typed data.
 * Real CloudWatch evaluation runs server-side once the operator deploys
 * the alarms; the local evaluator is the CI gate that the alarms WOULD
 * fire correctly when they reach AWS. If the alarms JSON ever gains
 * fields outside this subset, the unit tests fail loudly (the JSON
 * schema is part of the test fixture — same alarms.json file).
 */

/**
 * Evaluate a CloudWatch alarm definition against a series of pre-aggregated
 * data points and return the alarm state.
 *
 * @param {object} alarmDef — alarm definition object as serialised in
 *   `infra/cloudwatch-stage6-alarms.json`. Required fields:
 *     - Threshold: number
 *     - ComparisonOperator: 'GreaterThanThreshold'
 *     - EvaluationPeriods: integer >= 1
 *     - DatapointsToAlarm: integer >= 1, <= EvaluationPeriods
 *     - TreatMissingData: 'notBreaching'
 * @param {Array<number|null|undefined>} dataPoints — pre-aggregated values,
 *   one per period. null/undefined = missing data for that period.
 * @returns {'OK' | 'ALARM' | 'INSUFFICIENT_DATA'}
 *
 * @throws {Error} when alarmDef carries any field outside the modelled
 *   subset. Loud surface — additions to the subset require corresponding
 *   test coverage and a deliberate evaluator update.
 */
export function evaluateAlarm(alarmDef, dataPoints) {
  // Subset gate — fail loudly if the alarm uses semantics we haven't
  // modelled. Better to crash the test than to silently mis-evaluate.
  if (alarmDef.ComparisonOperator !== 'GreaterThanThreshold') {
    throw new Error(
      `evaluator subset: only GreaterThanThreshold supported, got ${alarmDef.ComparisonOperator}`
    );
  }
  if (alarmDef.Statistic !== 'Average') {
    throw new Error(`evaluator subset: only Average supported, got ${alarmDef.Statistic}`);
  }
  if (alarmDef.TreatMissingData !== 'notBreaching') {
    throw new Error(
      `evaluator subset: only notBreaching supported, got ${alarmDef.TreatMissingData}`
    );
  }
  const evalPeriods = alarmDef.EvaluationPeriods;
  const datapointsToAlarm = alarmDef.DatapointsToAlarm;
  const threshold = alarmDef.Threshold;
  if (
    !Number.isInteger(evalPeriods) ||
    evalPeriods < 1 ||
    !Number.isInteger(datapointsToAlarm) ||
    datapointsToAlarm < 1 ||
    datapointsToAlarm > evalPeriods
  ) {
    throw new Error(
      `evaluator: invalid EvaluationPeriods/DatapointsToAlarm: ${evalPeriods}/${datapointsToAlarm}`
    );
  }
  if (typeof threshold !== 'number' || Number.isNaN(threshold)) {
    throw new Error(`evaluator: invalid Threshold: ${threshold}`);
  }

  // INSUFFICIENT_DATA: caller hasn't provided enough data points to
  // evaluate the trailing window. Distinct state from OK so operators
  // can tell "metric quiet" from "metric healthy".
  if (!Array.isArray(dataPoints) || dataPoints.length < evalPeriods) {
    return 'INSUFFICIENT_DATA';
  }

  // Take the trailing EvaluationPeriods window — same as CloudWatch's
  // server-side evaluation which always operates on the most recent
  // EvaluationPeriods periods.
  const window = dataPoints.slice(-evalPeriods);

  // Count breaching points. Missing data (null/undefined) counts as
  // not-breaching per TreatMissingData=notBreaching.
  let breachingCount = 0;
  for (const point of window) {
    if (point === null || point === undefined) continue;
    if (typeof point !== 'number' || Number.isNaN(point)) {
      // Non-numeric, non-missing entries are caller error. Throw
      // rather than silently treat as not-breaching.
      throw new Error(`evaluator: dataPoint must be number|null|undefined, got ${typeof point}`);
    }
    if (point > threshold) breachingCount += 1;
  }

  return breachingCount >= datapointsToAlarm ? 'ALARM' : 'OK';
}
