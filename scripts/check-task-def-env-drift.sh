#!/usr/bin/env bash
#
# check-task-def-env-drift.sh — detect out-of-band env-var drift between
# the live ECS task definition and its source template, BEFORE the next
# `register-task-definition` silently strips it.
#
# Run as a pre-deploy step in .github/workflows/deploy.yml. Fails the
# build if any env var name exists on the live task def but is missing
# from the source template — the same failure mode that lost
# `CCU_DEWARP_OUTPUT_WIDTH=2048` between 2026-05-13 and 2026-05-14, and
# `JWT_SECRET` on 2026-04-19. See CLAUDE.md "MANDATORY — Infrastructure
# changes must come from source" for the full story.
#
# Usage:
#   ./scripts/check-task-def-env-drift.sh <service-name> <source-template-path>
#
# Examples:
#   ./scripts/check-task-def-env-drift.sh eicr-backend  ecs/task-def-backend.json
#   ./scripts/check-task-def-env-drift.sh eicr-pwa      ecs/task-def-frontend.json
#
# Environment overrides:
#   ECS_CLUSTER             default: eicr-cluster-production
#   AWS_REGION              default: eu-west-2
#   ALLOW_TASKDEF_DRIFT     when set non-empty: warn but exit 0. Reserve
#                           for emergency deploys where a source commit
#                           genuinely cannot be made in the same session.
#                           CI surfaces this via [skip-drift-check] in the
#                           commit message.
#
# Exit codes:
#   0 — no drift, OR drift detected and ALLOW_TASKDEF_DRIFT was set
#   1 — drift detected (env on live but not in source); CI should fail
#   2 — usage error or upstream AWS / jq failure

set -euo pipefail

SERVICE="${1:-}"
SOURCE_FILE="${2:-}"

if [ -z "$SERVICE" ] || [ -z "$SOURCE_FILE" ]; then
  echo "Usage: $0 <service-name> <source-template-path>" >&2
  echo "Example: $0 eicr-backend ecs/task-def-backend.json" >&2
  exit 2
fi

CLUSTER="${ECS_CLUSTER:-eicr-cluster-production}"
REGION="${AWS_REGION:-eu-west-2}"

if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: source template not found at $SOURCE_FILE" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not installed" >&2
  exit 2
fi

# --- 1. Find the currently-deployed task def for this service ---
TASK_ARN=$(aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --region "$REGION" \
  --query 'services[0].taskDefinition' \
  --output text 2>/dev/null || true)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ] || [ "$TASK_ARN" = "null" ]; then
  echo "INFO: no running task def found for service '$SERVICE' on cluster '$CLUSTER'."
  echo "INFO: skipping drift check (first deploy of a new service, or service not yet provisioned)."
  exit 0
fi

# --- 2. List env var NAMES on the live task def's primary container ---
# We only compare names, not values: name drift catches the silent-strip
# failure mode. Value drift is much less common and harder to disambiguate
# from intentional environment-specific overrides.
LIVE_ENV_NAMES=$(aws ecs describe-task-definition \
  --task-definition "$TASK_ARN" \
  --region "$REGION" \
  --query 'taskDefinition.containerDefinitions[0].environment[].name' \
  --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' | sort -u)

# --- 3. List env var NAMES in the source template ---
SOURCE_ENV_NAMES=$(jq -r '.containerDefinitions[0].environment[]?.name // empty' "$SOURCE_FILE" 2>/dev/null | sort -u)

# --- 4. Set difference: in LIVE but not in SOURCE ---
# These are the variables that the next register-task-definition call
# will silently drop.
DRIFT=$(comm -23 <(printf '%s\n' "$LIVE_ENV_NAMES") <(printf '%s\n' "$SOURCE_ENV_NAMES") || true)

if [ -z "$DRIFT" ]; then
  echo "✓ $SERVICE: no env-var drift detected — live task def env names match $SOURCE_FILE"
  exit 0
fi

# --- 5. Drift detected. Report loudly. ---
echo ""
echo "╭────────────────────────────────────────────────────────────────────╮"
echo "│  TASK-DEF ENV-VAR DRIFT DETECTED                                   │"
echo "╰────────────────────────────────────────────────────────────────────╯"
echo ""
echo "Service:         $SERVICE"
echo "Live task def:   $TASK_ARN"
echo "Source template: $SOURCE_FILE"
echo ""
echo "The following env vars exist on the LIVE task def but are MISSING from"
echo "the source template. The next \`aws ecs register-task-definition\` from"
echo "the source will SILENTLY DROP them:"
echo ""
while IFS= read -r var; do
  [ -z "$var" ] && continue
  printf "  - %s\n" "$var"
  echo "::error title=Task-def env drift::Env var '$var' is on live $SERVICE task def but not in $SOURCE_FILE"
done <<< "$DRIFT"
echo ""
echo "Likely cause: an out-of-band hotfix was applied via 'aws ecs"
echo "register-task-definition' or the AWS console, without a corresponding"
echo "commit to the source template. This is the exact failure mode that"
echo "lost CCU_DEWARP_OUTPUT_WIDTH=2048 on 2026-05-14 and JWT_SECRET on"
echo "2026-04-19. See CLAUDE.md 'MANDATORY — Infrastructure changes must"
echo "come from source'."
echo ""
echo "To resolve (pick ONE):"
echo "  1. INTENDED: add the env vars to $SOURCE_FILE and commit."
echo "     The deploy will then re-register them as part of the new task def."
echo "  2. EXPERIMENT: remove the env vars from the live task def by"
echo "     registering a new revision without them (and update the service"
echo "     to use it) before re-running this deploy."
echo "  3. EMERGENCY: include [skip-drift-check] in the commit message AND"
echo "     follow up with the source commit immediately after the deploy."
echo "     This is a last resort — do not normalise it."
echo ""

if [ -n "${ALLOW_TASKDEF_DRIFT:-}" ]; then
  echo "::warning::Drift bypass active (ALLOW_TASKDEF_DRIFT set). Continuing despite drift."
  echo "REMEMBER: follow up with a source commit, otherwise this drift returns next deploy."
  exit 0
fi

exit 1
