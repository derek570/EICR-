#!/usr/bin/env bash
#
# audit-env-var-source.sh — second layer of the task-def source-of-truth
# enforcement (the first is scripts/check-task-def-env-drift.sh).
#
# This script catches the OTHER drift direction: env vars referenced by
# CODE (`process.env.X`) but NOT defined in the source task-def template.
# Without it, a new flag landed in code can silently default to its
# fallback in production because ECS never injected it — the bug is then
# invisible until the inspector triggers the code path and notices the
# fallback behaviour.
#
# Both directions matter:
#   - check-task-def-env-drift.sh   → LIVE has var, SOURCE missing it
#                                     (out-of-band hotfix that next CI
#                                     deploy would silently drop).
#   - audit-env-var-source.sh       → CODE reads var, SOURCE missing it
#                                     (new flag added without task-def
#                                     update; defaults in prod).
#
# Wire into .github/workflows/deploy.yml AND optionally as a pre-push
# hook (it runs in ~1 second on the current src/ tree).
#
# Usage:
#   ./scripts/audit-env-var-source.sh               # default (backend)
#   ./scripts/audit-env-var-source.sh ecs/task-def-backend.json
#
# Exit codes:
#   0 — every env var read by code is either in the task-def or on the
#       allowlist below
#   1 — at least one env var is missing from both
#   2 — usage error

set -euo pipefail

SOURCE_FILE="${1:-ecs/task-def-backend.json}"

if [ ! -f "$SOURCE_FILE" ]; then
  echo "ERROR: source template not found at $SOURCE_FILE" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not installed" >&2
  exit 2
fi

# Allowlist — env vars legitimately sourced from outside the task-def
# environment[] block. Keep this list ordered alphabetically and add a
# one-line comment explaining the source whenever you add an entry.
#
# Three sources are legitimate:
#   1. Secrets Manager (task-def's `secrets[]` block, not `environment[]`)
#   2. AWS-managed (set by Fargate or the runtime, not by us)
#   3. Test/local-dev only (never read in a prod code path that matters)
read -r -d '' ALLOWLIST <<'EOF' || true
# --- Secrets Manager (loaded by loadSecretsFromAWS at boot) ---
ANTHROPIC_API_KEY
DEEPGRAM_API_KEY
DEEPGRAM_MASTER_KEY
DATABASE_URL
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID
GEMINI_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
JWT_SECRET
OPENAI_API_KEY
PUSHOVER_TOKEN
PUSHOVER_USER
SENTRY_DSN
SMTP_HOST
SMTP_PASS
SMTP_PORT
SMTP_USER
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER

# --- AWS-managed / runtime-injected ---
AWS_LAMBDA_FUNCTION_NAME
AWS_REGION
AWS_SECRET_NAME
AWS_DEFAULT_REGION
ECS_CONTAINER_METADATA_URI_V4
HOSTNAME
HOME
PATH
USER

# --- Build / runtime ambient ---
APP_PORT
DATABASE_TYPE
ENABLE_DEBUG_AUDIO
FROM_EMAIL
FRONTEND_URL
LOG_FILE
LOG_LEVEL
NODE_ENV
PORT
REDIS_URL
REQUIRE_SSL
S3_BUCKET
SENTRY_RELEASE
STORAGE_TYPE
USE_AWS_SECRETS

# --- Test-only env vars (never read in prod code paths) ---
JEST_WORKER_ID
NODE_OPTIONS
CI

# --- Pre-existing unsourced vars (allowlisted 2026-05-27 as part of
# Phase 0 of the snapshot-restructure sprint). Each was added to code
# before this audit existed; the entries below capture the existing
# choice rather than retroactively forcing a task-def write. ---
SONNET_SESSION_TTL_MS              # test-only override; src/__tests__/sonnet-session-store.test.js
STRIPE_SECRET_KEY                  # billing not enabled in prod; src/billing.js gates entire feature on its presence
STRIPE_WEBHOOK_SECRET              # same as above; webhook handler skipped when unset
VAPID_PRIVATE_KEY                  # web push keys; PWA push notifications not yet enabled in prod
VAPID_PUBLIC_KEY                   # web push keys; PWA push notifications not yet enabled in prod
VOICE_LATENCY_TOOL_CHOICE_ANY_ROUND1   # voice-latency sprint kill-switch; in-code default is the prod behaviour
VOICE_MID_STREAM_FILTER            # Loaded Barrel mid-stream canonical-emit filter; in-code default OFF (field-test rollback 2026-05-29 — re-enable when iOS preliminary-receive path verified)
VOICE_PRE_LLM_GATE                 # sonnet-stream.js gates on `!== 'false'`; in-code default ON matches prod
WHATSAPP_PHONE_NUMBER_ID           # WhatsApp integration not used by EICR (lives in a different repo)
WHATSAPP_TOKEN                     # WhatsApp integration not used by EICR

# --- Optional model / behaviour overrides with safe in-code defaults ---
# These all read via `process.env.X ?? <default>` — exposing them as
# tunable knobs is fine; not setting them in the task-def is intentional
# because the in-code default is the production value. List them here so
# the audit doesn't fire on every deploy.
CCU_BOX_TIGHTEN
CCU_CV_PITCH
CCU_DEWARP_ENABLED
CCU_DEWARP_MAX_WIDTH
CCU_DEWARP_OUTPUT_WIDTH
CCU_EXTRACTION_TIMEOUT_MS
CCU_GEOMETRIC_MODEL
CCU_GEOMETRIC_TIMEOUT_MS
CCU_LABEL_CONFIDENCE_MIN
CCU_LABEL_MATCHER_ALGORITHM
CCU_LABEL_MATCHER_DEVICE_SKIP_FACTOR
CCU_LABEL_MATCHER_LABEL_SKIP_FACTOR
CCU_LABEL_MATCHER_MAX_MATCH_FACTOR
CCU_LABEL_MODEL
CCU_LABEL_TIMEOUT_MS
CCU_MAX_UPLOAD_BYTES
CCU_MODEL
CCU_PROBE_V2
CCU_QUAD_GEOMETRY
CCU_REWIREABLE_MODEL
CCU_SINGLE_SHOT_MAX_TOKENS
CCU_SINGLE_SHOT_TIMEOUT_MS
CCU_SLIDING_WINDOW_TIMEOUT_MS
CCU_VLM_POSITION_MATCHER
CHITCHAT_COUNT_MISSING_CONTEXT
CHITCHAT_MISSING_CONTEXT_THRESHOLD
DOC_EXTRACT_MODEL
EXTRACTION_MODEL
GEMINI_CHUNK_MODEL
GEMINI_FALLBACK_MODEL
GEMINI_MODEL
SONNET_CACHE_TTL                   # ephemeral-cache TTL override for system + snapshot blocks; in-code default '5m' matches prod; harness sets '1h' for warm-cache across the scenario suite (eicr-extraction-session.js)
SONNET_EXTRACT_MODEL
SONNET_SESSION_MAX_ENTRIES
VOICE_REGEX_PRE_APPLY
EOF

# Strip blank lines, comment-only lines, and trailing inline comments
# (e.g. `WHATSAPP_TOKEN  # not used by EICR` → `WHATSAPP_TOKEN`). Then
# strip surrounding whitespace.
ALLOWLIST_NAMES=$(printf '%s\n' "$ALLOWLIST" \
  | sed 's/[[:space:]]*#.*$//' \
  | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
  | grep -v '^$' \
  | sort -u)

# --- 1. List every env var read by code in src/ ---
CODE_ENV_NAMES=$(grep -rEoh "process\.env\.[A-Z_][A-Z0-9_]+" src/ --include='*.js' 2>/dev/null \
  | sed 's/^process\.env\.//' \
  | sort -u)

# --- 2. List env var names declared in the source task-def ---
TASKDEF_ENV_NAMES=$(jq -r '.containerDefinitions[0].environment[]?.name // empty' "$SOURCE_FILE" 2>/dev/null | sort -u)
TASKDEF_SECRET_NAMES=$(jq -r '.containerDefinitions[0].secrets[]?.name // empty' "$SOURCE_FILE" 2>/dev/null | sort -u)

# Union: anything wired via environment[], secrets[], or the allowlist
# is considered "sourced".
SOURCED_NAMES=$(printf '%s\n%s\n%s\n' \
  "$TASKDEF_ENV_NAMES" \
  "$TASKDEF_SECRET_NAMES" \
  "$ALLOWLIST_NAMES" \
  | grep -v '^$' \
  | sort -u)

# --- 3. Set difference: in CODE but not SOURCED ---
UNSOURCED=$(comm -23 <(printf '%s\n' "$CODE_ENV_NAMES") <(printf '%s\n' "$SOURCED_NAMES") || true)

if [ -z "$UNSOURCED" ]; then
  echo "✓ audit-env-var-source: every process.env.X reference in src/ is either in $SOURCE_FILE or on the allowlist"
  exit 0
fi

# --- 4. Report ---
echo ""
echo "╭────────────────────────────────────────────────────────────────────╮"
echo "│  UNSOURCED ENV VARS — code reads them but task-def does not        │"
echo "│  inject them and they are not on the allowlist                     │"
echo "╰────────────────────────────────────────────────────────────────────╯"
echo ""
echo "Source template: $SOURCE_FILE"
echo ""
echo "The following env vars are read by code in src/ but are not defined"
echo "in the task-def environment[] or secrets[] blocks, and are not on"
echo "the allowlist at the top of this script:"
echo ""
while IFS= read -r var; do
  [ -z "$var" ] && continue
  printf "  - %s\n" "$var"
  # First file:line where it's referenced — helps reviewers locate it.
  HIT=$(grep -rn "process\.env\.${var}\b" src/ --include='*.js' 2>/dev/null | head -1 || true)
  if [ -n "$HIT" ]; then
    printf "      first reference: %s\n" "$HIT"
  fi
  echo "::error title=Unsourced env var::process.env.${var} is read by code but not defined in $SOURCE_FILE"
done <<< "$UNSOURCED"
echo ""
echo "To resolve (pick ONE):"
echo "  1. INTENDED FOR PRODUCTION: add the var to $SOURCE_FILE's"
echo "     environment[] (or secrets[] if it's loaded from Secrets Manager)"
echo "     in the SAME commit as the code that reads it."
echo "  2. INTENTIONAL DEFAULT-IN-CODE: add the name to the allowlist at"
echo "     the top of this script with a one-line comment explaining why"
echo "     the in-code default is sufficient. Reviewers will see both"
echo "     surfaces together."
echo ""
echo "This audit fires because of two production incidents: CCU_DEWARP_OUTPUT_WIDTH=2048"
echo "(dropped 2026-05-14) and JWT_SECRET (2026-04-19) — both were silent regressions"
echo "from env vars added in code without a matching task-def update."
echo ""

exit 1
