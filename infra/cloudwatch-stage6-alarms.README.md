# Stage 6 Agentic — CloudWatch Alarms

Sibling metadata for the 2 per-alarm JSON files:

- [`cloudwatch-stage6-alarm-divergence-rate.json`](./cloudwatch-stage6-alarm-divergence-rate.json)
- [`cloudwatch-stage6-alarm-tool-loop-cap-hit-rate.json`](./cloudwatch-stage6-alarm-tool-loop-cap-hit-rate.json)

Each file is a flat AWS MetricAlarm body (no underscore-prefixed metadata, no wrapper) directly deployable via:

```bash
aws cloudwatch put-metric-alarm \
  --region eu-west-2 \
  --cli-input-json file://infra/cloudwatch-stage6-alarm-<name>.json
```

## Purpose

Stage 6 Agentic Extraction CloudWatch alarms. 2 alarms covering the divergence-rate and tool-loop-cap-hit-rate failure surfaces. ROADMAP §Phase 8 SC #4 shipped a third, restrained-mode-rate alarm; it was retired with restrained mode (see [Retirement](#retirement)).

## Metric namespace

`EICR/Stage6` — every alarm reads from this namespace. Sources:

| Alarm | Metric | Emitter |
|---|---|---|
| `stage6-divergence-rate-high` | `stage6.divergence_rate` | `src/extraction/stage6-divergence-evaluator.js` |
| `stage6-tool-loop-cap-hit-rate-high` | `stage6.tool_loop_cap_hit_rate` | `src/extraction/stage6-tool-loop.js` |

## Threshold rationale (Phase 8 SC #4)

Thresholds match ROADMAP §SC #4 verbatim:

| Alarm | Target | Alarm threshold | Phase 8 SC #4 wording |
|---|---|---|---|
| `stage6-divergence-rate-high` | ≤ 5% | > 10% | "divergence_rate > 10%" |
| `stage6-tool-loop-cap-hit-rate-high` | 0% | > 0.5% | "tool_loop_cap_hit_rate > 0.5%" |

**Strict greater-than wording is intentional.** Every alarm body sets `ComparisonOperator: GreaterThanThreshold` (CloudWatch's strict greater-than operator), so a datapoint of EXACTLY `0.10` does NOT alarm on the divergence-rate alarm. The dashboard annotations + this README must use strict `>` (not the "or-equal-to" form) so the operator's mental model matches the alarm contract — Codex r4-#2 (MINOR) flagged the previous "or-equal-to" wording as misleading; CI now locks the contract via `src/__tests__/stage6-dashboard-wording.test.js`.

Per-alarm `Period: 300` (5-min) × `EvaluationPeriods: 3` × `DatapointsToAlarm: 3` means an alarm fires only after 15 contiguous breach minutes (anti-flap; one transient spike does not page the operator).

## Threshold-test evidence (Phase 8 SC #7 review burden)

Synthetic-breach harness in [`src/__tests__/stage6-alarm-thresholds.test.js`](../src/__tests__/stage6-alarm-thresholds.test.js) feeds breach data through [`src/extraction/stage6-alarm-evaluator.js`](../src/extraction/stage6-alarm-evaluator.js) and asserts each alarm WOULD fire if AWS evaluated this data. Closes the SC #7 review burden ("alarms actually fire on test data") at the JS level; AWS deployment of the alarms remains operator-deferred.

11 tests total at the threshold-evaluator level; 5 additional tests at the per-alarm-file shape level (this file's CI lock — see [`src/__tests__/stage6-alarm-cloudwatch-shape.test.js`](../src/__tests__/stage6-alarm-cloudwatch-shape.test.js)).

## Region

`eu-west-2` (London). Per-region default — no `Region` field in the alarm body itself; the `aws cloudwatch put-metric-alarm` call is region-bound via the CLI flag (or `AWS_DEFAULT_REGION`).

## Deploy command

2 separate calls (one per alarm). The calls are independently safe — alarms are idempotent on `AlarmName`:

```bash
for f in infra/cloudwatch-stage6-alarm-*.json; do
  aws cloudwatch put-metric-alarm \
    --region eu-west-2 \
    --cli-input-json file://"$f"
done
```

## CI lock

[`src/__tests__/stage6-alarm-cloudwatch-shape.test.js`](../src/__tests__/stage6-alarm-cloudwatch-shape.test.js) parses each per-alarm file on every test run and asserts:

1. Both per-alarm files exist on disk, and the retired restrained-mode alarm file does not.
2. Each parses to a flat object (NOT a wrapper).
3. Each has all AWS `put-metric-alarm` required keys.
4. NO top-level key starts with `_` in any per-alarm file.
5. AlarmName values match the 2 live names verbatim.

A future contributor accidentally re-introducing the wrapper or adding metadata back into the JSON gets caught by a failing test before the change reaches review.

## History

Originally Plan 08-01 (commit `9b7456f`) shipped a wrapper object `{_purpose, _review_burden, _metric_namespace, _threshold_test_evidence, alarms: [...]}` in `infra/cloudwatch-stage6-alarms.json`. Codex r1-#2 (BLOCK) flagged that AWS `put-metric-alarm --cli-input-json` rejects the wrapper shape. Plan 08-02 r1-#2 GREEN split the wrapper into 3 standalone files; the wrapper file was deleted and its metadata moved here.

## Retirement

### `stage6-restrained-mode-rate-high` (retired 2026-09-23, PLAN-B of the feedback-2026-09-17 wave)

Restrained mode and the per-key ask budget were removed from the backend (Derek's Decision 3, 2026-09-18: the model sees its own asks and can stop by itself; the cap dated from when it could not speak). Restrained mode had been an always-inactive stub since 2026-04-28, so `stage6.restrained_mode` rows stopped long before the mechanism was deleted. With it gone, nothing emits `stage6.restrained_mode_rate`, and an alarm on that metric can never fire. The alarm JSON, its dashboard widget and its rows in both READMEs are deleted. Historical CloudWatch rows stay as data.

Whether the alarm was ever deployed is not recorded in source: deployment of these alarms was operator-deferred and the only documented command was `put-metric-alarm`. Delivery checks the live state read-only:

```bash
aws cloudwatch describe-alarms \
  --alarm-names stage6-restrained-mode-rate-high \
  --region eu-west-2
```

If `MetricAlarms` is non-empty, delete it once and re-check that it is absent:

```bash
aws cloudwatch delete-alarms \
  --alarm-names stage6-restrained-mode-rate-high \
  --region eu-west-2
aws cloudwatch describe-alarms \
  --alarm-names stage6-restrained-mode-rate-high \
  --region eu-west-2
```

If it is already absent, the retirement is source-only. The delivering pull request records which case applied, with the command output.
