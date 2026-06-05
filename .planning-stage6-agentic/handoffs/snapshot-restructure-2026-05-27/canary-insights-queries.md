# Canary read-out — Phase 1 Day-3

**Important:** in production (`SONNET_TOOL_CALLS=live`), per-turn cache totals are NOT in CloudWatch. They live in the session's `cost_summary.json` in S3. CloudWatch carries `schedule_block_rebuild` (identity rate) and `stage6.ask_user` (missing-context counts) but cost totals come from S3.

> Verified empirically 2026-05-27: a Logs Insights query for `Session ... Turn N cost` over the last 7 days returned 0 rows out of 8,377 scanned. The line at `eicr-extraction-session.js:2176` only fires from `_extractSingle` (legacy off-mode). Stage 6's tool-loop path doesn't log per-turn, only the final summary via `sonnet-stream.js:4241`.

The read-out is therefore:

| Signal | Where | How |
|---|---|---|
| `cacheWriteTokens`, `cacheReadTokens`, total $ | S3 `cost_summary.json` | aws s3 cp + jq |
| `identityRate`, `total`, `identical`, `snapshotFormat` | CloudWatch | Q1 below |
| `missing_context` ask count | CloudWatch | Q2 below |

---

## S3 — pull the canary cost summary

After the iPad session ends cleanly, the cost summary lands in S3 within ~1s.

```bash
# 1. Find the most recent cost summary (last 1h is usually enough)
aws s3 ls s3://eicr-files-production/session-analytics/ --recursive \
  | grep "cost_summary.json" \
  | sort -k1,2 -r \
  | head -5

# 2. Pull and view
aws s3 cp s3://eicr-files-production/session-analytics/<userId>/<sessionId>/cost_summary.json - | jq .

# 3. Just the numbers we care about (replace key with your canary's path)
aws s3 cp s3://eicr-files-production/session-analytics/<userId>/<sessionId>/cost_summary.json - \
  | jq '{turns:.sonnet.turns, cacheWrites:.sonnet.cacheWrites, cacheReads:.sonnet.cacheReads, sonnetCost:.sonnet.cost, totalJobCost:.totalJobCost}'
```

Compare against `baseline-sessions.md` thresholds.

---

## CloudWatch Logs Insights

Log group: `/ecs/eicr/eicr-backend` (region `eu-west-2`).
Console: https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#logsV2:logs-insights

Set the date range to bracket the iPad session (start ~5 min before, end ~10 min after).

### Q1 — Identity rate for the canary session(s)

Pulls every session-end `schedule_block_rebuild` row where the new layout was active.

```
fields @timestamp, sessionId, snapshotFormat, identityRate, total, identical
| filter message = "snapshot.schedule_block_rebuild"
| filter snapshotFormat = "split_blocks"
| sort @timestamp desc
```

Gate: `identityRate > 0.7`.

### Q2 — Missing-context ask count

Replace `CANARY_SESSION_ID` with the sessionId from Q1.

```
fields @timestamp, sessionId, reason, context_field, question
| filter message = "stage6.ask_user"
| filter sessionId = "CANARY_SESSION_ID"
| filter reason = "missing_context"
| sort @timestamp asc
```

Aggregate count:

```
fields sessionId, reason
| filter message = "stage6.ask_user"
| filter sessionId = "CANARY_SESSION_ID"
| stats count(*) as totalAsks, sum(reason = "missing_context") as missingContextAsks
```

Gate: baseline sessions A and B had `questionsAsked: 0`. Anything > 3 is a red flag for the schedule strip blinding Sonnet.

### Q3 — Sanity: identity-rate distribution across single_block sessions

If the canary identity-rate looks odd, compare against the last 24h of single_block sessions to see whether the per-session rebuild rate is normally this jittery.

```
fields @timestamp, sessionId, snapshotFormat, identityRate, total
| filter message = "snapshot.schedule_block_rebuild"
| filter total >= 3
| sort @timestamp desc
| limit 50
```

> Caveat: `snapshot.schedule_block_rebuild` is brand new (landed today via PR #37). Until enough single_block sessions emit it post-deploy, Q3 will look sparse. Use as soon as the deploy of `:234` is stable + a few real sessions have run.

### Q4 — Sanity: confirm SNAPSHOT_FORMAT actually flipped

```
fields @timestamp, sessionId, snapshotFormat
| filter message = "snapshot.schedule_block_rebuild"
| sort @timestamp desc
| limit 10
```

If the canary task was healthy and a session ran on it, you'll see `"snapshotFormat":"split_blocks"`. If you only see `single_block`, the canary task either didn't take the env var or the session landed on a different task — abort and re-check §1c of the runbook.

---

## Pass/fail at a glance

| Metric | Canary | Baseline avg | Threshold | Pass? |
|---|---|---|---|---|
| `cacheWrites` tokens (S3) | _____ | 20,065 | ≤ 14,046 | ⬜ |
| `cacheReads` tokens (S3) | _____ | 279,403 | ≤ 335,283 | ⬜ |
| total job cost $ (S3) | _____ | $0.2449 | ≤ $0.1959 | ⬜ |
| `identityRate` (Q1) | _____ | — | > 0.7 | ⬜ |
| `missing_context` asks (Q2) | _____ | 0 | ≤ 3 | ⬜ |
| `snapshotFormat` (Q4) | _____ | — | == "split_blocks" | ⬜ |

Plan §6.1 says EITHER the cacheWrite token gate OR the $ gate passing is acceptable — the $ gate is the practical fallback if turn count diverges from baseline.

---

## Followup: telemetry parity for future canaries

Today's canary can be measured because the S3 cost_summary exists. A future improvement worth considering (NOT a Phase 1 blocker): emit a structured log line at session-stop that mirrors the S3 summary, so Logs Insights queries can drive future canary read-outs without an S3 join. Logged for follow-up; not part of the snapshot-restructure sprint.
