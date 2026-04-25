/**
 * Stage 6 Phase 8 — Plan 08-05 r4-#2 — CloudWatch dashboard wording lock.
 *
 * Codex r4-#2 (MINOR) flagged that the dashboard JSON's annotation
 * `label` strings + widget `title` strings + the alarm/dashboard
 * READMEs use "≥" (Unicode U+2265) wording — "Alarm ≥10%" / "≥5%" /
 * "≥0.5%" — while every alarm body in `infra/cloudwatch-stage6-alarm-*.json`
 * sets `ComparisonOperator: GreaterThanThreshold` (strict greater-than).
 *
 * The mismatch is operationally misleading: a metric value of EXACTLY
 * 0.10 will NOT alarm under GreaterThanThreshold, but the dashboard
 * annotation reads "Alarm ≥10%" and tells the operator otherwise. The
 * fix is wording-only — the JSON shape and the alarm bodies are both
 * already correct.
 *
 * This test file locks the contract:
 *   1. Dashboard JSON: NO annotation `label` and NO widget `title`
 *      contains the `≥` (U+2265) character.
 *   2. Every alarm file uses `ComparisonOperator: "GreaterThanThreshold"`
 *      (the contract anchor — locks the assumption that the dashboard
 *      wording must NOT include `≥`).
 *   3. Both READMEs (`cloudwatch-stage6-alarms.README.md` +
 *      `cloudwatch-stage6-dashboard.README.md`): no line in any
 *      threshold-related table contains the `≥` character (so a
 *      future contributor can't re-introduce the misleading wording
 *      via a docs-only edit either).
 *
 * Note on `≤`: target wording ("target ≤5%") is NOT subject to this
 * lock. Targets are descriptive (where we want the metric to live);
 * alarms are operational (where the alarm fires). Targets can use
 * `≤` freely — only alarm-related thresholds must use strict `>`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');
const DASHBOARD_PATH = path.join(INFRA_DIR, 'cloudwatch-stage6-dashboard.json');
const ALARMS_README = path.join(INFRA_DIR, 'cloudwatch-stage6-alarms.README.md');
const DASHBOARD_README = path.join(INFRA_DIR, 'cloudwatch-stage6-dashboard.README.md');

// Unicode "Greater-Than Or Equal To" character U+2265.
const GTE = '≥';

describe('Plan 08-05 r4-#2 — dashboard wording matches GreaterThanThreshold contract', () => {
  test('dashboard JSON annotation labels + widget titles MUST NOT contain `≥`', () => {
    // The lock against the wording-vs-operator mismatch Codex r4-#2
    // identified. CloudWatch's GreaterThanThreshold is strictly
    // greater-than: 0.10 does NOT alarm. Wording must be ">", never
    // "≥".
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8'));
    const offending = [];
    for (const widget of dashboard.widgets || []) {
      const props = widget.properties || {};
      // Widget title (operator's first-glance threshold context).
      if (typeof props.title === 'string' && props.title.includes(GTE)) {
        offending.push(`widget title: "${props.title}"`);
      }
      // Annotation labels (overlay strings on the timeseries chart).
      const horizontals = (props.annotations && props.annotations.horizontal) || [];
      for (const h of horizontals) {
        if (typeof h.label === 'string' && h.label.includes(GTE)) {
          offending.push(`annotation label: "${h.label}"`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  test('every alarm body uses ComparisonOperator: "GreaterThanThreshold"', () => {
    // The contract anchor. If a future alarm uses
    // GreaterThanOrEqualToThreshold, the wording-lock above is wrong
    // for that one alarm — this test forces the contributor to
    // update both the alarm body AND the dashboard wording in lockstep.
    const alarmFiles = readdirSync(INFRA_DIR).filter(
      (f) => f.startsWith('cloudwatch-stage6-alarm-') && f.endsWith('.json')
    );
    expect(alarmFiles.length).toBeGreaterThan(0);
    for (const f of alarmFiles) {
      const body = JSON.parse(readFileSync(path.join(INFRA_DIR, f), 'utf8'));
      expect(body.ComparisonOperator).toBe('GreaterThanThreshold');
    }
  });

  test('alarms README + dashboard README MUST NOT contain `≥` in any line (wording lock)', () => {
    // Defence-in-depth on the docs side. A docs-only edit that
    // reintroduces "≥" wording would re-create the mismatch even
    // though the JSON files stay clean. Both READMEs are CI-locked
    // to the strict-> wording.
    for (const readme of [ALARMS_README, DASHBOARD_README]) {
      const content = readFileSync(readme, 'utf8');
      const lines = content.split('\n');
      const offendingLines = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => line.includes(GTE));
      expect(offendingLines).toEqual([]);
    }
  });
});
