# Phase 1 Day-3 canary runbook

> Step-by-step for the SNAPSHOT_FORMAT=split_blocks field test.
> Source-controlled task-def: `ecs/task-def-backend.canary.json` (only delta vs main: `SNAPSHOT_FORMAT` value).
> Plan reference: `Snapshot restructure final plan.md` §6.1.
> **Note on environment:** prod runs eicr-backend at desiredCount=1. The "canary" is the SOLE backend task for the duration — there's nowhere else for the WebSocket to land. This is faster than scaling up + traffic-routing, but it means the canary IS production while the flag is flipped. If anything looks wrong, revert immediately (commands below).

---

## 0. Prerequisites

- AWS CLI configured for account 196390795898, region eu-west-2.
- `gh` CLI logged in.
- An iPad with CertMate signed into a real inspector account.
- A test job already created (or willingness to create one mid-session).
- Two baseline session IDs captured (see `baseline-sessions.md` in this folder once §3's pull is done).

## 1. Apply the canary task-def

```bash
cd /Users/derekbeckley/Developer/EICR_Automation

# 1a. Verify the canary file diffs cleanly from main (should be one line: SNAPSHOT_FORMAT)
diff ecs/task-def-backend.json ecs/task-def-backend.canary.json

# 1b. Source-of-truth check — should print the "every process.env.X reference" success line
./scripts/audit-env-var-source.sh ecs/task-def-backend.canary.json

# 1c. Register the new revision (returns revision number — capture it)
CANARY_REV=$(aws ecs register-task-definition \
  --cli-input-json file://ecs/task-def-backend.canary.json \
  --region eu-west-2 \
  --query 'taskDefinition.revision' --output text)
echo "Registered canary revision: eicr-backend:$CANARY_REV"

# 1d. Capture the CURRENT (single_block) revision number so the revert is one command
CURRENT_REV=$(aws ecs describe-services \
  --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2 \
  --query 'services[0].taskDefinition' --output text | awk -F: '{print $NF}')
echo "Current single_block revision (revert target): eicr-backend:$CURRENT_REV"
# WRITE THIS DOWN before continuing.

# 1e. Roll the service to the canary
aws ecs update-service \
  --cluster eicr-cluster-production \
  --service eicr-backend \
  --task-definition eicr-backend:$CANARY_REV \
  --region eu-west-2 \
  --query 'service.{Service:serviceName,TaskDef:taskDefinition,Status:deployments[0].rolloutState}' \
  --output table

# 1f. Wait for the canary task to be healthy (force-poll the deployment until COMPLETED)
aws ecs wait services-stable \
  --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2
echo "Canary task is now serving traffic."
```

## 2. Verify the flag flipped

```bash
# Tail the backend logs and confirm the new session-end line carries split_blocks
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 5m --follow \
  | grep -E 'snapshot|SNAPSHOT'
```

You won't see anything until a session starts. The signal you want at session end is:

```
"message":"snapshot.schedule_block_rebuild" ... "snapshotFormat":"split_blocks"
```

If it says `"single_block"` instead, the env var didn't take — abort and check the task-def revision.

## 3. Run the iPad session

- Open CertMate on the iPad.
- Start an EICR (new or existing job).
- Dictate readings on **at least 6–10 circuits** (Zs, R1+R2, IR, polarity).
- Hit **at least one observation** (e.g. "code 2 — RCBO label missing").
- Do at least **one manual edit** to a populated field (forces a fresh `updateJobState`).
- Realistic duration: 15–25 minutes.
- End the session cleanly (close the inspection or hit done).

**Write down:** start time (UTC), end time (UTC), the job ID. The `sessionId` is generated server-side and pulled in §4.

## 4. Read out the canary signals

Read-out is split across two sources — see `canary-insights-queries.md` for the exact commands and queries:

- **S3** — `cost_summary.json` for the canary session has the cache totals and total cost. The `Session ... Turn N cost` CloudWatch line does NOT fire in Stage 6 live mode (verified empirically 2026-05-27); the canonical record is the S3 summary written from `sonnet-stream.js:4241`.
- **CloudWatch Logs Insights** — `snapshot.schedule_block_rebuild` carries `identityRate`; `stage6.ask_user` carries the missing-context asks.

Gates per plan §6.1, with concrete thresholds derived in `baseline-sessions.md`:

| Signal | Pass | Source |
|---|---|---|
| `identityRate` | > 0.7 | CloudWatch — snapshot.schedule_block_rebuild |
| `ask_user.missing_context` count | ≤ 3 (baseline pair had 0) | CloudWatch — stage6.ask_user |
| `cacheWrites` tokens per session | ≤ 14,046 OR total $ ≤ $0.1959 | S3 — cost_summary.json |
| `cacheReads` tokens per session | ≤ 335,283 (sanity) | S3 — cost_summary.json |

## 5. Decide

### 5a. All gates green → fleet flip

```bash
# Promote split_blocks to the default in source
# Edit ecs/task-def-backend.json — change SNAPSHOT_FORMAT to "split_blocks"
# Commit + push to main; CI deploys the new default.
```

After the source flip is merged, delete `ecs/task-def-backend.canary.json` — it's no longer the special revision.

### 5b. Any gate red → revert

```bash
# Roll the service back to the pre-canary revision
aws ecs update-service \
  --cluster eicr-cluster-production \
  --service eicr-backend \
  --task-definition eicr-backend:$CURRENT_REV \
  --region eu-west-2 \
  --query 'service.{Service:serviceName,TaskDef:taskDefinition,Status:deployments[0].rolloutState}' \
  --output table

aws ecs wait services-stable \
  --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2
echo "Reverted to single_block (eicr-backend:$CURRENT_REV)."
```

Then investigate which gate failed against the captured CloudWatch data, fold the fix back into Phase 1 (per plan §6.1's movable-Day-3 escape hatch), and reschedule the canary.

## 6. Cleanup after a green canary

- `git rm ecs/task-def-backend.canary.json` once `ecs/task-def-backend.json` carries `split_blocks`.
- Commit + push.
- Update plan §6.1 with the actual Day-3 outcome + dated note.
- Begin Phase 3 work (ascending circuits + retire rotation) on a new branch.

## 7. Honest risks during the session

- **iPad ALB sticky session.** Should be irrelevant at desiredCount=1, but if you see the new task come up and the old task hang around longer than expected (rolling deploy), the iPad's existing WebSocket could still be on the old task. Force-close CertMate and reopen AFTER §1f reports services-stable.
- **WebSocket reconnects mid-session.** Each reconnect creates a new sessionId. The query in §4 sums per-session; if reconnects fragmented the run, you'll need to OR the query across sessionIds. Pull all `Session ... Started` lines in the window and reason from there.
- **Cache key changes ≠ cache flush.** First session after the flag flip has cold cache for the new layout regardless. Treat the FIRST canary session as a warm-up; the second is the real signal. Easiest pattern: run two back-to-back sessions on the iPad and report the second.
