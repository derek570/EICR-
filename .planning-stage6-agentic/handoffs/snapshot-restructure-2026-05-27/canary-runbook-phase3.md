# Phase 3 Day-2 canary runbook

> Step-by-step for the `CIRCUIT_ORDER=ascending` field test.
> Source-controlled task-def: `ecs/task-def-backend.canary.json` (only delta vs main: `CIRCUIT_ORDER` value).
> Plan reference: `phase3-sprint-plan.md` §6.
> Sister runbook: Phase 1 canary used the same scaffold; see `canary-runbook.md` for the longer-form rationale on the desiredCount=1 implications.

---

## 0. Prerequisites

- AWS CLI configured for account 196390795898, region eu-west-2.
- iPad with CertMate signed into a real inspector account.
- A test job (or willingness to create one).
- Phase 3 implementation deployed to prod (PR #38 / commit `c2d00c2f`). The live `eicr-backend` task def must already carry `CIRCUIT_ORDER=recent_3` (post-PR #38 CI deploy). If it doesn't, the canary task def will register fine but the deploy gate that audits against source will fail.

## 1. Apply the canary task-def

```bash
cd /Users/derekbeckley/Developer/EICR_Automation

# 1a. Verify the canary file diffs cleanly from main (one line: CIRCUIT_ORDER)
diff ecs/task-def-backend.json ecs/task-def-backend.canary.json

# 1b. Source-of-truth check
./scripts/audit-env-var-source.sh ecs/task-def-backend.canary.json

# 1c. Register the new revision
CANARY_REV=$(aws ecs register-task-definition \
  --cli-input-json file://ecs/task-def-backend.canary.json \
  --region eu-west-2 \
  --query 'taskDefinition.revision' --output text)
echo "Registered canary revision: eicr-backend:$CANARY_REV"

# 1d. Capture the current revision (revert target) BEFORE updating
CURRENT_REV=$(aws ecs describe-services \
  --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2 \
  --query 'services[0].taskDefinition' --output text | awk -F: '{print $NF}')
echo "Revert target: eicr-backend:$CURRENT_REV"
# WRITE THIS DOWN.

# 1e. Roll the service
aws ecs update-service \
  --cluster eicr-cluster-production \
  --service eicr-backend \
  --task-definition eicr-backend:$CANARY_REV \
  --region eu-west-2 \
  --query 'service.{Service:serviceName,TaskDef:taskDefinition,Status:deployments[0].rolloutState}' \
  --output table

# 1f. Wait for stable
aws ecs wait services-stable \
  --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2
echo "Canary task is serving traffic."
```

## 2. Verify the flag took effect

```bash
aws ecs describe-task-definition --task-definition eicr-backend:$CANARY_REV \
  --region eu-west-2 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`CIRCUIT_ORDER`]'
# Expect: [{ "name": "CIRCUIT_ORDER", "value": "ascending" }]
```

Live verification via logs comes from the session itself — under `ascending` the EXTRACTED block will NOT contain the "X earlier circuits (a,b,c) stored server-side" line, even when more than 3 circuits exist.

## 3. iPad session — same shape as Phase 1 canary

- Same job for both sessions.
- **Session 1 (warm-up, throwaway):** ~3–4 circuits, hit done. Don't measure.
- **Session 2 (the real one):** 6–10 circuits, ≥1 observation, ≥1 manual edit, 15–25 minutes.
- Back-to-back — don't wait > 3 minutes between sessions.

Phase 3 specifically benefits when the inspector moves between circuits, because that's the scenario where the old rotation reshuffled the EXTRACTED block. Aim to dictate readings across **at least 4 distinct circuits** so the cache-stability contract is actually exercised — pure linear circuit-1-through-circuit-N dictation doesn't trigger the rotation in the first place.

## 4. Read out the canary signals

| Signal | Where | Pass |
|---|---|---|
| `cacheWrites` per turn | S3 `cost_summary.json` | ≤ 80% of baseline avg (Phase 3 saving is smaller than Phase 1) |
| `cacheReads` per turn | S3 `cost_summary.json` | ≤ 150% of baseline avg (read offset expected; this just catches runaway growth) |
| total $ per turn | S3 `cost_summary.json` | ≤ 90% of baseline avg |
| `missing_context` asks | CloudWatch — `stage6.ask_user` | ≤ 3 (no spike vs Phase 1 baseline) |
| EXTRACTED block has "stored server-side"? | S3 `cost_summary.json` is silent on this — grep CloudWatch for snapshot text if needed | **NO line** under ascending |

S3 pull command:
```bash
aws s3 ls s3://eicr-files-production/session-analytics/ --recursive \
  | grep "cost_summary.json" \
  | sort -k1,2 -r \
  | head -5

aws s3 cp s3://eicr-files-production/session-analytics/<userId>/<sessionId>/cost_summary.json - \
  | jq '{turns:.sonnet.turns, cacheWrites:.sonnet.cacheWrites, cacheReads:.sonnet.cacheReads, sonnetCost:.sonnet.cost, totalJobCost:.totalJobCost}'
```

## 5. Decide

### 5a. Gates green → fleet flip

```bash
# Edit ecs/task-def-backend.json CIRCUIT_ORDER value: recent_3 → ascending
# Delete ecs/task-def-backend.canary.json
# Commit + push. CI deploys the new default.
```

### 5b. Gates red → revert

```bash
aws ecs update-service \
  --cluster eicr-cluster-production \
  --service eicr-backend \
  --task-definition eicr-backend:$CURRENT_REV \
  --region eu-west-2

aws ecs wait services-stable \
  --cluster eicr-cluster-production --services eicr-backend \
  --region eu-west-2
```

## 6. Why a single baseline (vs Phase 1's paired pair)

Phase 1's canary had two paired single_block baselines (`065BDA7F`, `835BCDF9` from 2026-05-26) because there were weeks of single_block production sessions to choose from.

Phase 3 only has ONE post-Phase-1 baseline session: `C61473FD-8976-4ACE-94BF-EF3993A28481` (24 turns, ran during the Phase 1 canary). Everything earlier was on single_block and isn't comparable. Per-turn baselines are derived from this single session — see `baseline-sessions-phase3.md` for the numbers and the honest caveat about a sample size of one.

If you want a better baseline before the canary, run one more 15–25 min session on the CURRENT live task def (`CIRCUIT_ORDER=recent_3`, post-PR-#38) and we'll have a paired pair just like Phase 1.

## 7. Honest risks during the canary

- **Read offset eats the write saving.** Ascending renders ALL circuits in detail vs recent_3's 3. For a session with 8 circuits, the cached prefix is ~5 extra circuit lines (~400 tokens) larger. Each turn rereads that. The 12.5× price ratio between cache_write ($3.75/M) and cache_read ($0.30/M) means even doubling cache_reads is dominated by halving cache_writes — but the headline saving in absolute terms will be smaller than Phase 1's was.
- **First session post-flip is still cache-cold.** Same as Phase 1 — run two sessions, measure the second.
- **The cache-stability contract requires moving between circuits.** A session that linearly dictates circuit 1→2→3→4→… without revisiting earlier ones won't exercise Phase 3's main benefit (which is preserving the prefix when the inspector jumps around). For the canary, deliberately revisit at least one earlier circuit so the test mirrors realistic inspector behaviour.
