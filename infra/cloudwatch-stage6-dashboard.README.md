# Stage 6 Agentic — CloudWatch Dashboard

Sibling metadata for [`cloudwatch-stage6-dashboard.json`](./cloudwatch-stage6-dashboard.json). The JSON file itself MUST remain a valid AWS CloudWatch dashboard body (no underscore-prefixed top-level keys, no comments, no trailing commas) so that

```bash
aws cloudwatch put-dashboard \
  --region eu-west-2 \
  --dashboard-name "Stage6-Agentic" \
  --dashboard-body file://infra/cloudwatch-stage6-dashboard.json
```

succeeds without modification.

## Purpose

Stage 6 Agentic Extraction CloudWatch dashboard. Defines widgets for the 5 STO-03 metrics + tool-call histogram. Designed to be the operator's first-stop view of Stage 6 health post-cutover (Phase 7 §"Cutover Plan").

## Metric namespace

`EICR/Stage6` — every metric the dashboard reads is emitted to this namespace by the backend. Sources:

| Metric | Emitter |
|---|---|
| `stage6.divergence_rate` | `src/extraction/stage6-divergence-evaluator.js` |
| `stage6.ask_user_per_session_p50` | `src/extraction/stage6-dispatcher-logger.js` |
| `stage6.ask_user_per_session_p95` | `src/extraction/stage6-dispatcher-logger.js` |
| `stage6.restrained_mode_rate` | `src/extraction/stage6-dispatcher-ask.js` |
| `stage6.tool_loop_cap_hit_rate` | `src/extraction/stage6-tool-loop.js` |
| `stage6.tool_call.count` | `src/extraction/stage6-dispatcher-logger.js` |

## Threshold rationale (Phase 8 SC #3)

Inline annotations on each alarm-bearing widget make threshold values visible at a glance. Threshold values match the alarm definitions in [`cloudwatch-stage6-alarm-divergence-rate.json`](./cloudwatch-stage6-alarm-divergence-rate.json), [`cloudwatch-stage6-alarm-restrained-mode-rate.json`](./cloudwatch-stage6-alarm-restrained-mode-rate.json), and [`cloudwatch-stage6-alarm-tool-loop-cap-hit-rate.json`](./cloudwatch-stage6-alarm-tool-loop-cap-hit-rate.json) verbatim:

| Metric | Target | Alarm threshold |
|---|---|---|
| `stage6.divergence_rate` | ≤ 5% | > 10% |
| `stage6.restrained_mode_rate` | ≤ 2% | > 5% |
| `stage6.tool_loop_cap_hit_rate` | 0% | > 0.5% |
| `stage6.ask_user_per_session_p50` | ≤ 1 | (no alarm — soft target) |
| `stage6.ask_user_per_session_p95` | ≤ 4 | (no alarm — soft target) |

**Strict `>` wording is intentional.** Every alarm body uses `ComparisonOperator: GreaterThanThreshold` (CloudWatch's strict greater-than). A datapoint of EXACTLY `0.10` does NOT alarm. The dashboard annotations + this table must use strict `>` (not the "or-equal-to" form) so the operator's mental model matches the alarm contract — Codex r4-#2 (MINOR) flagged the previous "or-equal-to" wording as misleading; CI now locks the contract via `src/__tests__/stage6-dashboard-wording.test.js`.

## Region

`eu-west-2` (London). Hard-coded in every widget's `properties.region`.

## Phase 8 SC #3 review burden

Every STO-03 metric is represented in a dedicated widget. Tool-call histogram widget visualises STO-01 traffic stacked by tool name (Sum stat, 5-min period). All threshold values quoted in widget titles match the alarm thresholds in the per-alarm JSON files.

## CI lock

[`src/__tests__/stage6-dashboard-cloudwatch-shape.test.js`](../src/__tests__/stage6-dashboard-cloudwatch-shape.test.js) parses this JSON on every test run and asserts:

1. Body parses cleanly via `JSON.parse`.
2. NO top-level key starts with `_` (the lock against re-introducing metadata-side-channels here).
3. Top-level keys are a subset of `{widgets, start, end, periodOverride}` + every widget has `type` + `properties`.

A future contributor accidentally adding metadata back into the JSON gets caught by a failing test before the change reaches review.

## History

Originally Plan 08-01 (commit `2f760f9`) shipped the metadata as 3 underscore-prefixed top-level keys inside the JSON. Codex r1-#1 (BLOCK) flagged the AWS deploy-blocker; Plan 08-02 r1-#1 GREEN moved the metadata here.
