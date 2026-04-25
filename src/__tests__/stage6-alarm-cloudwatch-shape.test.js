/**
 * Stage 6 Phase 8 — Plan 08-02 r1-#2 — Per-alarm CloudWatch JSON shape lock.
 *
 * Codex r1 raised BLOCK r1-#2: `infra/cloudwatch-stage6-alarms.json` ships
 * as a wrapper object containing an `alarms[]` array PLUS underscore-
 * prefixed metadata keys. AWS `put-metric-alarm --cli-input-json
 * file://...` expects ONE MetricAlarm body per call (a flat object with
 * `AlarmName` etc at top level), NOT a wrapper. Operators can't deploy
 * the alarms file as-is — they'd have to extract each entry to its own
 * file or pipe through `jq`, neither of which is captured in any infra
 * tooling shipped here.
 *
 * Plan 08-02 ships 3 standalone per-alarm JSON files alongside a sibling
 * `cloudwatch-stage6-alarms.README.md` carrying the metadata that
 * previously lived inside the wrapper. Each per-alarm file is then
 * directly deployable via:
 *
 *   aws cloudwatch put-metric-alarm \
 *     --region eu-west-2 \
 *     --cli-input-json file://infra/cloudwatch-stage6-alarm-<name>.json
 *
 * This test locks the 3 per-alarm files' AT-REST shape so a future
 * contributor can't accidentally re-introduce a wrapper or add
 * underscore-prefixed metadata back into the deployable JSON.
 *
 * 5 tests:
 *   1. All 3 per-alarm files exist on disk.
 *   2. Each parses via JSON.parse to a flat object (no wrapper).
 *   3. Each has the AWS put-metric-alarm required keys (AlarmName,
 *      MetricName, Namespace, Statistic, Period, EvaluationPeriods,
 *      DatapointsToAlarm, Threshold, ComparisonOperator,
 *      TreatMissingData).
 *   4. NO underscore-prefixed key appears at top level in any file.
 *   5. AlarmName values match the legacy wrapper's 3 alarm names
 *      verbatim (continuity with dashboard threshold annotations +
 *      REVIEW.md narrative).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');

const PER_ALARM_FILES = [
  'cloudwatch-stage6-alarm-divergence-rate.json',
  'cloudwatch-stage6-alarm-restrained-mode-rate.json',
  'cloudwatch-stage6-alarm-tool-loop-cap-hit-rate.json',
];

const EXPECTED_ALARM_NAMES = [
  'stage6-divergence-rate-high',
  'stage6-restrained-mode-rate-high',
  'stage6-tool-loop-cap-hit-rate-high',
];

const REQUIRED_AWS_KEYS = [
  'AlarmName',
  'MetricName',
  'Namespace',
  'Statistic',
  'Period',
  'EvaluationPeriods',
  'DatapointsToAlarm',
  'Threshold',
  'ComparisonOperator',
  'TreatMissingData',
];

describe('Plan 08-02 r1-#2 — per-alarm CloudWatch JSON shape lock', () => {
  test('all 3 per-alarm JSON files exist on disk', () => {
    for (const filename of PER_ALARM_FILES) {
      const fullPath = path.join(INFRA_DIR, filename);
      expect(existsSync(fullPath)).toBe(true);
    }
  });

  test('each per-alarm file parses to a flat object (NOT a wrapper)', () => {
    for (const filename of PER_ALARM_FILES) {
      const fullPath = path.join(INFRA_DIR, filename);
      const raw = readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Must be a flat object — NOT a wrapper with `alarms[]`.
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
      // Wrapper-shape detection: the legacy wrapper had `alarms` as the
      // ONE non-underscore key. If a contributor accidentally re-creates
      // the wrapper here, this assertion fires.
      expect(parsed.alarms).toBeUndefined();
    }
  });

  test('each per-alarm file has all AWS put-metric-alarm required keys', () => {
    for (const filename of PER_ALARM_FILES) {
      const fullPath = path.join(INFRA_DIR, filename);
      const alarm = JSON.parse(readFileSync(fullPath, 'utf8'));
      for (const requiredKey of REQUIRED_AWS_KEYS) {
        expect(alarm[requiredKey]).toBeDefined();
      }
    }
  });

  test('NO top-level key starts with `_` in any per-alarm file', () => {
    // The same anti-pattern lock as r1-#1 (dashboard) — underscore-
    // prefixed metadata belongs in the sibling .README.md, NOT inside
    // the deployable JSON.
    for (const filename of PER_ALARM_FILES) {
      const fullPath = path.join(INFRA_DIR, filename);
      const alarm = JSON.parse(readFileSync(fullPath, 'utf8'));
      const offendingKeys = Object.keys(alarm).filter((k) => k.startsWith('_'));
      expect(offendingKeys).toEqual([]);
    }
  });

  test('AlarmName values match the legacy wrapper names verbatim', () => {
    // Continuity check: dashboard threshold annotations + REVIEW.md
    // narrative refer to the alarms by these exact names. A rename
    // here would silently break the dashboard's visual cross-reference.
    const actualNames = [];
    for (const filename of PER_ALARM_FILES) {
      const fullPath = path.join(INFRA_DIR, filename);
      const alarm = JSON.parse(readFileSync(fullPath, 'utf8'));
      actualNames.push(alarm.AlarmName);
    }
    expect(actualNames.sort()).toEqual([...EXPECTED_ALARM_NAMES].sort());
  });
});
