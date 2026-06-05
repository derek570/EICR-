/**
 * Stage 6 Phase 8 — Plan 08-02 r1-#1 — CloudWatch dashboard JSON shape lock.
 *
 * Codex r1 raised BLOCK r1-#1: `infra/cloudwatch-stage6-dashboard.json`
 * carries top-level `_purpose` / `_review_burden` / `_metric_namespace`
 * keys that are NOT valid CloudWatch dashboard body fields. The dashboard
 * body schema (https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/CloudWatch-Dashboard-Body-Structure.html)
 * permits a constrained set of top-level keys ONLY: `widgets`, `start`,
 * `end`, `periodOverride`. Any underscore-prefixed key is a deployment
 * blocker because `aws cloudwatch put-dashboard --dashboard-body file://...`
 * rejects bodies with unrecognised top-level keys.
 *
 * This test file locks the JSON's shape AT REST so a future contributor
 * can't accidentally re-introduce metadata-side-channels inside the
 * deployable JSON. The metadata previously inside the JSON has been
 * relocated to `infra/cloudwatch-stage6-dashboard.README.md` (sibling
 * file) where it belongs.
 *
 * 3 tests:
 *   1. Parses cleanly via JSON.parse (no comments, no trailing commas).
 *   2. NO top-level key starts with `_` (the explicit lock against the
 *      anti-pattern Codex r1 identified).
 *   3. Every widget is a well-formed CloudWatch widget object.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const DASHBOARD_PATH = path.join(REPO_ROOT, 'infra', 'cloudwatch-stage6-dashboard.json');

describe('Plan 08-02 r1-#1 — CloudWatch dashboard JSON shape lock', () => {
  test('dashboard JSON parses cleanly via JSON.parse', () => {
    const raw = readFileSync(DASHBOARD_PATH, 'utf8');
    // Throws if the JSON has comments, trailing commas, or any other
    // non-RFC-8259 deviation. AWS rejects the same way at deploy time.
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  test('NO top-level key starts with `_` (Codex r1-#1 lock)', () => {
    // The explicit anti-pattern lock. AWS dashboard bodies are validated
    // against a fixed schema; underscore-prefixed keys (which only make
    // sense as developer-facing metadata) get the body rejected wholesale.
    // If a reviewer wants to leave a breadcrumb inside the file, they
    // belong in the sibling .README.md, not the JSON body.
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8'));
    const offendingKeys = Object.keys(dashboard).filter((k) => k.startsWith('_'));
    expect(offendingKeys).toEqual([]);
  });

  test('top-level keys subset {widgets, start, end, periodOverride} + every widget well-formed', () => {
    // Hardens the lock further: the AWS dashboard body schema permits
    // only these 4 top-level fields. We only ship `widgets` (start/end
    // are static-only and `periodOverride` is rarely useful for our
    // metric-only dashboard) but allow them in case a future widget
    // wants the time-range pin. Then asserts every widget itself is a
    // valid CloudWatch widget object (type + properties required).
    const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8'));
    const allowed = new Set(['widgets', 'start', 'end', 'periodOverride']);
    const actualKeys = Object.keys(dashboard);
    for (const key of actualKeys) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(Array.isArray(dashboard.widgets)).toBe(true);
    expect(dashboard.widgets.length).toBeGreaterThan(0);
    // Every widget must have CloudWatch-required `type` + `properties`.
    for (const widget of dashboard.widgets) {
      expect(typeof widget.type).toBe('string');
      expect(widget.type.length).toBeGreaterThan(0);
      expect(typeof widget.properties).toBe('object');
      expect(widget.properties).not.toBeNull();
    }
  });
});
