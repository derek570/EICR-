/**
 * Stage 6 Phase 8 — Plan 08-01 SC #4 — Alarm-firing threshold harness.
 *
 * WHY a JS-side test for alarms that ultimately run inside AWS CloudWatch:
 * Phase 8 ROADMAP §SC #4 says "alarms actually fire on test data" — we
 * need to prove the threshold logic is correct WITHOUT requiring an
 * operational AWS account / put-metric-data calls during CI. The pattern
 * is to ship a pure-JS evaluator (`stage6-alarm-evaluator.js`) that
 * mirrors the subset of CloudWatch alarm semantics our 3 alarms use,
 * then feed synthetic data points through it and assert the alarm
 * state is what we expect.
 *
 * AWS subset modelled (intentionally narrow — only what the 3 alarms need):
 *   - ComparisonOperator: GreaterThanThreshold only
 *   - Statistic: Average — caller pre-aggregates to 5-min averages
 *   - EvaluationPeriods: N consecutive breaching periods → ALARM
 *   - DatapointsToAlarm: N (matches EvaluationPeriods on all 3 alarms)
 *   - TreatMissingData: notBreaching (missing periods count as OK)
 *
 * Out of subset:
 *   - LessThanThreshold / LessThanOrEqualToThreshold (no Stage 6 alarm uses these)
 *   - Statistic: Sum / Maximum / Minimum (Stage 6 alarms are all Average)
 *   - DatapointsToAlarm < EvaluationPeriods ("M of N" mode — not used by us)
 *   - TreatMissingData: missing / breaching / ignore (notBreaching is the
 *     only Stage 6 setting per the alarms JSON)
 *
 * 9 tests = 3 alarms × 3 scenarios (clean / breach / sub-evaluation noise).
 *
 * The synthetic data values in each test name are quoted explicitly
 * (e.g. "0.12, 0.15, 0.11") so a reviewer can verify the values are
 * ACTUALLY above the threshold without re-deriving from the alarm JSON.
 * This is the explicit Claude-self-review hook from Plan 08-01.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateAlarm } from '../extraction/stage6-alarm-evaluator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');

// Plan 08-02 r1-#2 (BLOCK): the legacy wrapper file
// `infra/cloudwatch-stage6-alarms.json` has been split into 3 standalone
// per-alarm files (each directly deployable via `aws cloudwatch
// put-metric-alarm --cli-input-json file://...`). The loader below reads
// each per-alarm file and resolves by AlarmName so the rest of this test
// file (11 alarm-firing tests) is unchanged — they keep using
// `findAlarm(name)`, the AlarmName-keyed lookup.
const PER_ALARM_FILES = [
  'cloudwatch-stage6-alarm-divergence-rate.json',
  'cloudwatch-stage6-alarm-restrained-mode-rate.json',
  'cloudwatch-stage6-alarm-tool-loop-cap-hit-rate.json',
];

const alarmsByName = new Map();
for (const filename of PER_ALARM_FILES) {
  const fullPath = path.join(INFRA_DIR, filename);
  const alarm = JSON.parse(readFileSync(fullPath, 'utf8'));
  alarmsByName.set(alarm.AlarmName, alarm);
}

function findAlarm(name) {
  const a = alarmsByName.get(name);
  if (!a) throw new Error(`Alarm not found in per-alarm JSON files: ${name}`);
  return a;
}

describe('Plan 08-01 SC #4 — alarm-firing threshold harness', () => {
  describe('stage6-divergence-rate-high (threshold 0.10, EvaluationPeriods 3)', () => {
    const alarm = findAlarm('stage6-divergence-rate-high');

    test('fires ALARM when 3 consecutive 5-min averages are 0.12, 0.15, 0.11 (all > 0.10)', () => {
      // Synthetic breach: every value is strictly above 0.10. With
      // EvaluationPeriods=3 + DatapointsToAlarm=3, the alarm MUST fire.
      const dataPoints = [0.12, 0.15, 0.11];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('ALARM');
    });

    test('stays OK when 3 consecutive 5-min averages are 0.04, 0.05, 0.06 (all < 0.10)', () => {
      // Healthy clean run — all values below the alarm threshold.
      const dataPoints = [0.04, 0.05, 0.06];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });

    test('stays OK on sub-evaluation noise: 0.02, 0.15, 0.04 (1 spike, < EvaluationPeriods=3)', () => {
      // Anti-flap regression-lock: ONE breach in three periods is not
      // enough to fire (DatapointsToAlarm=3). This is the explicit
      // CloudWatch semantics the 3-of-3 evaluation enforces.
      const dataPoints = [0.02, 0.15, 0.04];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });
  });

  describe('stage6-restrained-mode-rate-high (threshold 0.05, EvaluationPeriods 3)', () => {
    const alarm = findAlarm('stage6-restrained-mode-rate-high');

    test('fires ALARM when 3 consecutive 5-min averages are 0.06, 0.08, 0.07 (all > 0.05)', () => {
      const dataPoints = [0.06, 0.08, 0.07];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('ALARM');
    });

    test('stays OK when 3 consecutive 5-min averages are 0.01, 0.02, 0.015 (all < 0.05)', () => {
      const dataPoints = [0.01, 0.02, 0.015];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });

    test('stays OK on sub-evaluation noise: 0.06, 0.02, 0.07 (2 spikes but not consecutive)', () => {
      // Note: DatapointsToAlarm=3 + EvaluationPeriods=3 means we need 3
      // CONSECUTIVE breaching periods. Non-consecutive breaches don't
      // accumulate — each evaluation window is the trailing
      // EvaluationPeriods. With this data the most recent 3 periods
      // contain 2 breaches, which is < DatapointsToAlarm=3, so OK.
      const dataPoints = [0.06, 0.02, 0.07];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });
  });

  describe('stage6-tool-loop-cap-hit-rate-high (threshold 0.005, EvaluationPeriods 3)', () => {
    const alarm = findAlarm('stage6-tool-loop-cap-hit-rate-high');

    test('fires ALARM when 3 consecutive 5-min averages are 0.006, 0.01, 0.008 (all > 0.005)', () => {
      const dataPoints = [0.006, 0.01, 0.008];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('ALARM');
    });

    test('stays OK when 3 consecutive 5-min averages are 0.000, 0.001, 0.002 (all < 0.005)', () => {
      // Target is 0.0 (any session hitting LOOP_CAP=8 is a problem).
      // Alarm fires only above 0.5% — values below stay OK.
      const dataPoints = [0.0, 0.001, 0.002];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });

    test('stays OK on sub-evaluation noise: 0.000, 0.01, 0.000 (1 spike < EvaluationPeriods=3)', () => {
      const dataPoints = [0.0, 0.01, 0.0];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });
  });

  describe('evaluator semantic correctness — TreatMissingData = notBreaching', () => {
    const alarm = findAlarm('stage6-divergence-rate-high');

    test('missing data points (null/undefined) count as OK, not breaching', () => {
      // 2 breaching values + 1 missing → only 2 breaching periods,
      // < DatapointsToAlarm=3, so OK. This locks the notBreaching
      // semantics our alarms JSON specifies.
      const dataPoints = [0.12, null, 0.15];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('OK');
    });

    test('INSUFFICIENT_DATA when fewer data points than EvaluationPeriods are present', () => {
      // < EvaluationPeriods data points provided → AWS reports
      // INSUFFICIENT_DATA. With notBreaching this still maps to a
      // non-fire state from an alerting perspective, but we surface
      // the distinct state for operator visibility.
      const dataPoints = [0.12, 0.15];
      const state = evaluateAlarm(alarm, dataPoints);
      expect(state).toBe('INSUFFICIENT_DATA');
    });
  });
});
