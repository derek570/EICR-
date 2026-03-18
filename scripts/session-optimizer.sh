#!/bin/bash
# CertMate Session Optimizer (v3)
# Polls S3 for session analytics AND debug reports. Pre-processes with
# analyze-session.js, invokes Claude Code in READ-ONLY mode to generate
# structured JSON recommendations. Builds HTML report, uploads to S3,
# sends Pushover URL. User accepts/rejects via report page. Accept writes
# a command to S3 which this script polls for, then applies changes and commits.
#
# Git-based rollback: every change is committed with revert instructions.
#
# Install:
#   cp scripts/com.certmate.session-optimizer.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.certmate.session-optimizer.plist
#
# Logs:
#   tail -f ~/.certmate/session_optimizer.log

set -euo pipefail

BUCKET="eicr-files-production"
SESSION_PREFIX="session-analytics/"
DEBUG_PREFIX="debug-reports/"
STATE_FILE="$HOME/.certmate/optimizer_state.json"
LOG_FILE="$HOME/.certmate/session_optimizer.log"
POLL_INTERVAL=120

# Pushover notifications
PUSHOVER_USER="uexvmxgxpccjgvjzjk2qnqrnyrncgb"
PUSHOVER_TOKEN="adcgd8wx7t6ct7fhz9dyeyt1ne3gcn"

# Project paths
CODEBASE="$HOME/Developer/EICR_Automation"
SCRIPTS_DIR="$CODEBASE/EICR_App/scripts"
IOS_DIR="$CODEBASE/CertMateUnified"
BACKEND_DIR="$CODEBASE/EICR_App"
CLAUDE="$(command -v claude)"

# AWS deploy config
ECR_REPO="196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend"
ECS_CLUSTER="eicr-cluster-production"
ECS_SERVICE="eicr-backend"
AWS_REGION="eu-west-2"

# Verify required tools are available
for cmd in node aws jq git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found in PATH ($PATH)" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$STATE_FILE")"

if [ ! -f "$STATE_FILE" ]; then
  echo '{"processed_sessions": [], "processed_debug_reports": [], "processed_feedback": {}, "retry_counts": {}}' > "$STATE_FILE"
fi

# Migrate old state file format if needed
if jq -e '.processed' "$STATE_FILE" > /dev/null 2>&1; then
  jq '{processed_sessions: .processed, processed_debug_reports: []}' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Migrate state file: add processed_feedback if missing
if ! jq -e '.processed_feedback' "$STATE_FILE" > /dev/null 2>&1; then
  jq '. + {processed_feedback: {}}' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Migrate state file: add retry_counts if missing
if ! jq -e '.retry_counts' "$STATE_FILE" > /dev/null 2>&1; then
  jq '. + {retry_counts: {}}' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Migrate state file: add first_seen if missing (tracks when sessions without debug_log were first discovered)
if ! jq -e '.first_seen' "$STATE_FILE" > /dev/null 2>&1; then
  jq '. + {first_seen: {}}' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

notify() {
  local TITLE="$1"
  local MESSAGE="$2"
  local PRIORITY="${3:-0}"  # 0=normal, 1=high (bypasses quiet hours)
  local SAFE_TITLE="${TITLE//\"/\\\"}"
  local SAFE_MESSAGE="${MESSAGE//\"/\\\"}"

  # macOS notification
  osascript -e "display notification \"$SAFE_MESSAGE\" with title \"CertMate\" subtitle \"$SAFE_TITLE\"" 2>/dev/null || true

  # Pushover (phone notification)
  curl -s -X POST https://api.pushover.net/1/messages.json \
    -d "token=$PUSHOVER_TOKEN" \
    -d "user=$PUSHOVER_USER" \
    -d "title=CertMate: $TITLE" \
    -d "message=$MESSAGE" \
    -d "priority=$PRIORITY" > /dev/null 2>&1 || true

  log "  Notification: $TITLE — $MESSAGE"
}

send_pushover_message() {
  # Send a single Pushover message with optional URL attachment.
  # Args: TITLE, MESSAGE, PRIORITY, FEEDBACK_URL (optional)
  local TITLE="$1"
  local MESSAGE="$2"
  local PRIORITY="${3:-0}"
  local FEEDBACK_URL="${4:-}"

  log "  Pushover: title='$TITLE' url='$FEEDBACK_URL'"

  local CURL_ARGS=(
    -s -X POST https://api.pushover.net/1/messages.json
    -d "token=$PUSHOVER_TOKEN"
    -d "user=$PUSHOVER_USER"
    --data-urlencode "title=CertMate: $TITLE"
    --data-urlencode "message=$MESSAGE"
    -d "html=1"
    -d "priority=$PRIORITY"
  )

  if [ -n "$FEEDBACK_URL" ]; then
    CURL_ARGS+=(--data-urlencode "url=$FEEDBACK_URL")
    CURL_ARGS+=(--data-urlencode "url_title=View Report")
  else
    log "  WARNING: No URL provided for Pushover message"
  fi

  local PUSHOVER_RESPONSE
  PUSHOVER_RESPONSE=$(curl "${CURL_ARGS[@]}" 2>&1) || true
  log "  Pushover API response: $PUSHOVER_RESPONSE"
}

notify_full_report() {
  local TITLE="$1"
  local ANALYSIS_FILE="$2"
  local OPTIMIZATION_JSON="$3"
  local PRIORITY="${4:-0}"
  local FEEDBACK_SESSION_ID="${5:-}"

  # Build feedback URL
  local FEEDBACK_URL=""
  if [ -n "$FEEDBACK_SESSION_ID" ]; then
    FEEDBACK_URL="https://certomatic3000.co.uk/api/feedback/$FEEDBACK_SESSION_ID"
  fi

  # ── Extract session metadata ──
  local ADDRESS DURATION COST REGEX_FIELDS SONNET_FIELDS DISCREPANCIES CIRCUIT_COUNT
  ADDRESS=$(echo "$ANALYSIS_FILE" | jq -r '.session_meta.address // "Unknown"' 2>/dev/null)
  DURATION=$(echo "$ANALYSIS_FILE" | jq -r '.session_meta.durationSeconds // 0' 2>/dev/null)
  # Prefer server-side cost_summary if available, fall back to manifest
  COST=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.totalJobCost // .session_meta.sonnetCostUSD // 0' 2>/dev/null)
  REGEX_FIELDS=$(echo "$ANALYSIS_FILE" | jq -r '.session_meta.regexFieldsSet // 0' 2>/dev/null)
  SONNET_FIELDS=$(echo "$ANALYSIS_FILE" | jq -r '.session_meta.sonnetFieldsSet // 0' 2>/dev/null)
  DISCREPANCIES=$(echo "$ANALYSIS_FILE" | jq -r '.session_meta.discrepancyCount // 0' 2>/dev/null)
  CIRCUIT_COUNT=$(echo "$ANALYSIS_FILE" | jq -r '.session_meta.circuitCount // 0' 2>/dev/null)

  local DURATION_MIN=$((DURATION / 60))
  local DURATION_SEC=$((DURATION % 60))

  # ── Count key metrics ──
  local FIELD_COUNT EMPTY_COUNT MISSED_SPOKEN_COUNT DEBUG_COUNT OPT_APPLIED MISSED_FIXED_COUNT
  FIELD_COUNT=$(echo "$ANALYSIS_FILE" | jq '.field_report | length' 2>/dev/null || echo 0)
  EMPTY_COUNT=$(echo "$ANALYSIS_FILE" | jq '.empty_fields | length' 2>/dev/null || echo 0)
  MISSED_SPOKEN_COUNT=$(echo "$ANALYSIS_FILE" | jq '[.empty_fields[] | select(.reason == "regex_missed_sonnet_missed")] | length' 2>/dev/null || echo 0)
  DEBUG_COUNT=$(echo "$ANALYSIS_FILE" | jq '.debug_issues.issues | length' 2>/dev/null || echo 0)
  OPT_APPLIED=$(echo "$OPTIMIZATION_JSON" | jq -r '.changes_applied // false' 2>/dev/null || echo "false")
  MISSED_FIXED_COUNT=$(echo "$OPTIMIZATION_JSON" | jq '.missed_values_fixed | length' 2>/dev/null || echo 0)

  local MSG_NUM=1

  # Helper: send a message with auto-numbering and feedback link
  send_report_msg() {
    local MSG_TITLE="$1"
    local MSG_BODY="$2"
    local MSG_LEN=${#MSG_BODY}
    if [ "$MSG_LEN" -gt 1024 ]; then
      MSG_BODY="${MSG_BODY:0:990}\n\n<i>... continued next msg</i>"
    fi
    send_pushover_message "$MSG_TITLE" "$MSG_BODY" "$PRIORITY" "$FEEDBACK_URL"
    log "  Report msg ${MSG_NUM} sent: $MSG_TITLE (${MSG_LEN} chars)"
    MSG_NUM=$((MSG_NUM + 1))
  }

  # ── MSG 1: Session Overview ──

  local MSG1=""
  MSG1+="<b>${ADDRESS}</b>\n\n"
  MSG1+="Recording: ${DURATION_MIN}m ${DURATION_SEC}s\n"
  MSG1+="Circuits: ${CIRCUIT_COUNT}\n"
  MSG1+="Fields filled: ${FIELD_COUNT} total\n"
  MSG1+="  Regex (instant): ${REGEX_FIELDS}\n"
  MSG1+="  Sonnet (AI): ${SONNET_FIELDS}\n"
  if [ "$DISCREPANCIES" -gt 0 ]; then
    MSG1+="  Sonnet corrected regex: ${DISCREPANCIES}\n"
  fi
  # Show detailed cost breakdown if server-side data available
  local HAS_SERVER_COST
  HAS_SERVER_COST=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary != null' 2>/dev/null || echo "false")
  if [ "$HAS_SERVER_COST" = "true" ]; then
    local DG_COST SONNET_COST_VAL TURNS COMPACTIONS
    DG_COST=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.deepgram.cost // 0' 2>/dev/null)
    SONNET_COST_VAL=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.sonnet.cost // 0' 2>/dev/null)
    TURNS=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.extraction.turns // 0' 2>/dev/null)
    COMPACTIONS=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.extraction.compactions // 0' 2>/dev/null)
    ELEVENLABS_COST=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.elevenlabs.cost // 0' 2>/dev/null)
    SONNET_INPUT=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.sonnet.input // 0' 2>/dev/null)
    SONNET_OUTPUT=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.sonnet.output // 0' 2>/dev/null)
    SONNET_CACHE_READ=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.sonnet.cacheReads // 0' 2>/dev/null)
    SONNET_CACHE_WRITE=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.sonnet.cacheWrites // 0' 2>/dev/null)
    DG_MINS=$(echo "$ANALYSIS_FILE" | jq -r '.cost_summary.deepgram.minutes // 0' 2>/dev/null)
    MSG1+="Total cost: \$${COST}\n"
    MSG1+="  Deepgram: \$${DG_COST} (${DG_MINS} mins)\n"
    MSG1+="  Sonnet: \$${SONNET_COST_VAL} (${TURNS} turns, ${COMPACTIONS} compactions)\n"
    MSG1+="    Input: ${SONNET_INPUT} | Output: ${SONNET_OUTPUT} tokens\n"
    MSG1+="    Cache read: ${SONNET_CACHE_READ} | Cache write: ${SONNET_CACHE_WRITE} tokens\n"
    if [ "$ELEVENLABS_COST" != "0" ]; then
      MSG1+="  TTS: \$${ELEVENLABS_COST}\n"
    fi
  else
    MSG1+="Sonnet cost: \$${COST}\n"
  fi

  if [ "$MISSED_SPOKEN_COUNT" -gt 0 ] || [ "$EMPTY_COUNT" -gt 0 ] || [ "$DEBUG_COUNT" -gt 0 ]; then
    MSG1+="\n"
    [ "$MISSED_SPOKEN_COUNT" -gt 0 ] && MSG1+="⚠ ${MISSED_SPOKEN_COUNT} values spoken but missed\n"
    [ "$EMPTY_COUNT" -gt 0 ] && MSG1+="${EMPTY_COUNT} fields still empty\n"
    [ "$DEBUG_COUNT" -gt 0 ] && MSG1+="${DEBUG_COUNT} debug issues reported\n"
  else
    MSG1+="\nAll spoken values captured successfully.\n"
  fi

  send_report_msg "Session: ${ADDRESS}" "$MSG1"

  # ── MSG 2: What Was Missed (only if there are issues) ──

  if [ "$MISSED_SPOKEN_COUNT" -gt 0 ] || [ "$DEBUG_COUNT" -gt 0 ]; then
    local MSG2=""

    if [ "$MISSED_SPOKEN_COUNT" -gt 0 ]; then
      MSG2+="<b>Values you said but weren't captured:</b>\n\n"
      while IFS= read -r line; do
        local MKEY
        MKEY=$(echo "$line" | jq -r '.key')
        # Make field names readable: circuit.1.zs -> Circuit 1 Zs
        local READABLE
        READABLE=$(echo "$MKEY" | sed 's/circuit\.\([0-9]*\)\.\(.*\)/Circuit \1 \2/' | sed 's/supply\.\(.*\)/Supply \1/')
        MSG2+="  - ${READABLE}\n"
      done < <(echo "$ANALYSIS_FILE" | jq -c '[.empty_fields[] | select(.reason == "regex_missed_sonnet_missed")][:12][]' 2>/dev/null)
      if [ "$MISSED_SPOKEN_COUNT" -gt 12 ]; then
        MSG2+="  <i>+ $((MISSED_SPOKEN_COUNT - 12)) more</i>\n"
      fi
    fi

    if [ "$DEBUG_COUNT" -gt 0 ]; then
      MSG2+="\n<b>Your debug reports:</b>\n\n"
      while IFS= read -r line; do
        local ISSUE_TEXT RESOLVED
        ISSUE_TEXT=$(echo "$line" | jq -r '.issue_text' | head -c 100)
        RESOLVED=$(echo "$line" | jq -r '.resolved_by_sonnet')
        if [ "$RESOLVED" = "true" ]; then
          MSG2+="  Handled by Sonnet: ${ISSUE_TEXT}\n"
        else
          MSG2+="  Needs fix: ${ISSUE_TEXT}\n"
        fi
      done < <(echo "$ANALYSIS_FILE" | jq -c '.debug_issues.issues[:5][]' 2>/dev/null)
    fi

    # Unmatched speech
    local UNMATCHED_COUNT
    UNMATCHED_COUNT=$(echo "$ANALYSIS_FILE" | jq '.regex_performance.unmatched_transcript_segments | length' 2>/dev/null || echo 0)
    if [ "$UNMATCHED_COUNT" -gt 0 ]; then
      MSG2+="\n<b>Electrical terms spoken but not matched (${UNMATCHED_COUNT}):</b>\n"
      while IFS= read -r segment; do
        local SEG_TEXT
        SEG_TEXT=$(echo "$segment" | jq -r '.' | head -c 80)
        MSG2+="  \"${SEG_TEXT}\"\n"
      done < <(echo "$ANALYSIS_FILE" | jq -c '.regex_performance.unmatched_transcript_segments[:4][]' 2>/dev/null)
      if [ "$UNMATCHED_COUNT" -gt 4 ]; then
        MSG2+="  <i>+ $((UNMATCHED_COUNT - 4)) more</i>\n"
      fi
    fi

    send_report_msg "Issues Found" "$MSG2"
  fi

  # ── MSG 3: Code Changes ──

  local MSG3=""

  if [ "$OPT_APPLIED" = "true" ]; then
    local OPT_SUMMARY
    OPT_SUMMARY=$(echo "$OPTIMIZATION_JSON" | jq -r '.summary // "No details"' 2>/dev/null | head -c 250)
    MSG3+="<b>Code changes applied:</b>\n${OPT_SUMMARY}\n"

    # Files modified
    local FILES_CHANGED
    FILES_CHANGED=$(echo "$OPTIMIZATION_JSON" | jq -r '
      if .files_modified then
        [.files_modified[] | "  \(.file | split("/") | last): \(.summary // .change_type)"] | join("\n")
      else empty end' 2>/dev/null || true)
    if [ -n "$FILES_CHANGED" ]; then
      MSG3+="\n<b>Files changed:</b>\n${FILES_CHANGED}\n"
    fi

    # Values that were fixed
    if [ "$MISSED_FIXED_COUNT" -gt 0 ]; then
      MSG3+="\n<b>What was fixed (${MISSED_FIXED_COUNT}):</b>\n"
      while IFS= read -r line; do
        local FXFIELD FXFIX FXSPOKEN
        FXFIELD=$(echo "$line" | jq -r '.field')
        FXFIX=$(echo "$line" | jq -r '.fix' | head -c 80)
        FXSPOKEN=$(echo "$line" | jq -r '.spoken_as // empty' | head -c 40)
        MSG3+="  <b>${FXFIELD}</b>: ${FXFIX}\n"
        if [ -n "$FXSPOKEN" ]; then
          MSG3+="    You said: \"${FXSPOKEN}\"\n"
        fi
      done < <(echo "$OPTIMIZATION_JSON" | jq -c '.missed_values_fixed[:8][]' 2>/dev/null)
    fi

    # Debug issues addressed
    local DEBUG_FIXES
    DEBUG_FIXES=$(echo "$OPTIMIZATION_JSON" | jq -r '
      if .debug_issues_addressed then
        [.debug_issues_addressed[] | "  \(.issue) → \(.fix)"] | join("\n") | .[0:300]
      else empty end' 2>/dev/null || true)
    if [ -n "$DEBUG_FIXES" ]; then
      MSG3+="\n<b>Debug fixes:</b>\n${DEBUG_FIXES}\n"
    fi

    # Deployment status
    MSG3+="\n"
    local BACKEND_DEPLOY IOS_REBUILD
    BACKEND_DEPLOY=$(echo "$OPTIMIZATION_JSON" | jq -r 'if .files_modified then [.files_modified[].file] | any(contains("EICR_App") or contains("src/")) else false end' 2>/dev/null || echo "false")
    IOS_REBUILD=$(echo "$OPTIMIZATION_JSON" | jq -r 'if .files_modified then [.files_modified[].file] | any(contains("CertMateUnified") or contains("Sources/")) else false end' 2>/dev/null || echo "false")
    if [ "$BACKEND_DEPLOY" = "true" ]; then
      MSG3+="Backend: auto-deployed\n"
    fi
    if [ "$IOS_REBUILD" = "true" ]; then
      MSG3+="iOS: rebuild needed in Xcode\n"
    fi

    MSG3+="\nSend feedback to undo these changes."
  else
    local OPT_REASON
    OPT_REASON=$(echo "$OPTIMIZATION_JSON" | jq -r '.reason // .summary // "All fields captured correctly"' 2>/dev/null | head -c 300)
    MSG3+="<b>No code changes needed</b>\n\n${OPT_REASON}\n"
  fi

  send_report_msg "Optimizer Result" "$MSG3"

  # ── MSG 4: Sonnet Corrections (only if there were corrections) ──

  local OVERWRITE_COUNT
  OVERWRITE_COUNT=$(echo "$ANALYSIS_FILE" | jq '[.field_report[] | select(.was_overwritten == true)] | length' 2>/dev/null || echo 0)
  if [ "$OVERWRITE_COUNT" -gt 0 ]; then
    local MSG4=""
    MSG4+="<b>Where Sonnet corrected regex (${OVERWRITE_COUNT}):</b>\n\n"
    MSG4+="These values were first set by regex, then Sonnet changed them:\n\n"
    while IFS= read -r line; do
      local OKEY OREGEX OSONNET
      OKEY=$(echo "$line" | jq -r '.key')
      OREGEX=$(echo "$line" | jq -r '.regex_value // "?"')
      OSONNET=$(echo "$line" | jq -r '.sonnet_value // .final_value')
      local READABLE
      READABLE=$(echo "$OKEY" | sed 's/circuit\.\([0-9]*\)\.\(.*\)/Cct \1 \2/' | sed 's/supply\.\(.*\)/Supply \1/')
      MSG4+="  ${READABLE}: ${OREGEX} → ${OSONNET}\n"
    done < <(echo "$ANALYSIS_FILE" | jq -c '[.field_report[] | select(.was_overwritten == true)][:10][]' 2>/dev/null)
    if [ "$OVERWRITE_COUNT" -gt 10 ]; then
      MSG4+="  <i>+ $((OVERWRITE_COUNT - 10)) more</i>\n"
    fi

    send_report_msg "Sonnet Corrections" "$MSG4"
  fi
}

# ── Git Helpers ──

record_git_state() {
  # Record current HEAD in both repos
  cd "$BACKEND_DIR"
  BACKEND_HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "none")
  cd "$IOS_DIR"
  IOS_HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "none")
  cd "$CODEBASE"
}

commit_changes() {
  local SESSION_ID="$1"
  local SUMMARY="$2"

  IOS_COMMIT=""
  BACKEND_COMMIT=""
  IOS_CHANGED=false
  BACKEND_CHANGED=false

  # Check and commit iOS changes
  cd "$IOS_DIR"
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git add -A
    git commit -m "$(cat <<EOF
optimizer: $SESSION_ID — $SUMMARY

Applied by session-optimizer. Revert: git revert <hash>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
    )" 2>&1 | tee -a "$LOG_FILE"
    IOS_COMMIT=$(git rev-parse HEAD)
    IOS_CHANGED=true
    log "  iOS commit: $IOS_COMMIT"
  fi

  # Check and commit backend changes
  cd "$BACKEND_DIR"
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git add -A
    git commit -m "$(cat <<EOF
optimizer: $SESSION_ID — $SUMMARY

Applied by session-optimizer. Revert: git revert <hash>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
    )" 2>&1 | tee -a "$LOG_FILE"
    BACKEND_COMMIT=$(git rev-parse HEAD)
    BACKEND_CHANGED=true
    log "  Backend commit: $BACKEND_COMMIT"
  fi

  cd "$CODEBASE"
}

deploy_backend() {
  log "  Deploying backend to ECS..."

  cd "$BACKEND_DIR"

  docker build -f Dockerfile.backend -t eicr-backend . 2>&1 | tail -5 | tee -a "$LOG_FILE"
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$ECR_REPO" 2>&1 | tee -a "$LOG_FILE"
  docker tag eicr-backend:latest "${ECR_REPO}:latest"
  docker push "${ECR_REPO}:latest" 2>&1 | tail -3 | tee -a "$LOG_FILE"
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
    --force-new-deployment --region "$AWS_REGION" > /dev/null 2>&1

  log "  Backend deployed successfully"
  cd "$CODEBASE"
}

deploy_testflight() {
  log "  Deploying iOS to TestFlight..."

  cd "$IOS_DIR"

  if [ ! -f "./deploy-testflight.sh" ]; then
    log "  ERROR: deploy-testflight.sh not found in $IOS_DIR"
    return 1
  fi

  ./deploy-testflight.sh 2>&1 | tee -a "$LOG_FILE"
  local EXIT_CODE=${PIPESTATUS[0]}

  if [ "$EXIT_CODE" -eq 0 ]; then
    log "  TestFlight deploy succeeded"
    send_pushover_message "TestFlight Build" "New build uploaded after optimizer changes" 0
  else
    log "  ERROR: TestFlight deploy failed (exit $EXIT_CODE)"
    send_pushover_message "TestFlight FAILED" "Auto-deploy after optimizer changes failed — check log" 1
  fi

  cd "$CODEBASE"
}

generate_change_report() {
  local SESSION_ID="$1"
  local S3_PATH="$2"
  local SUMMARY="$3"
  local DEBUG_REPORTS_JSON="$4"  # JSON array of addressed debug report paths

  # Build revert commands
  local REVERT_CMDS="[]"
  if [ -n "$IOS_COMMIT" ]; then
    REVERT_CMDS=$(echo "$REVERT_CMDS" | jq ". + [\"cd CertMateUnified && git revert $IOS_COMMIT\"]")
  fi
  if [ -n "$BACKEND_COMMIT" ]; then
    REVERT_CMDS=$(echo "$REVERT_CMDS" | jq ". + [\"cd EICR_App && git revert $BACKEND_COMMIT\"]")
  fi

  # Build files_modified from git diffs
  local FILES_MODIFIED="[]"
  if [ "$IOS_CHANGED" = true ]; then
    cd "$IOS_DIR"
    while IFS= read -r f; do
      FILES_MODIFIED=$(echo "$FILES_MODIFIED" | jq --arg file "$f" --arg change "modified" \
        '. + [{"file": $file, "change_type": $change}]')
    done < <(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)
    cd "$CODEBASE"
  fi
  if [ "$BACKEND_CHANGED" = true ]; then
    cd "$BACKEND_DIR"
    while IFS= read -r f; do
      FILES_MODIFIED=$(echo "$FILES_MODIFIED" | jq --arg file "$f" --arg change "modified" \
        '. + [{"file": $file, "change_type": $change}]')
    done < <(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)
    cd "$CODEBASE"
  fi

  local REPORT
  REPORT=$(jq -n \
    --arg session_id "$SESSION_ID" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson changes_applied true \
    --arg ios_commit "${IOS_COMMIT:-null}" \
    --arg backend_commit "${BACKEND_COMMIT:-null}" \
    --argjson revert_commands "$REVERT_CMDS" \
    --argjson files_modified "$FILES_MODIFIED" \
    --argjson backend_deployed "$BACKEND_CHANGED" \
    --argjson ios_needs_rebuild "$IOS_CHANGED" \
    --argjson debug_reports_addressed "$DEBUG_REPORTS_JSON" \
    --arg summary "$SUMMARY" \
    '{
      session_id: $session_id,
      timestamp: $timestamp,
      changes_applied: $changes_applied,
      ios_commit: (if $ios_commit == "null" then null else $ios_commit end),
      backend_commit: (if $backend_commit == "null" then null else $backend_commit end),
      revert_commands: $revert_commands,
      files_modified: $files_modified,
      backend_deployed: $backend_deployed,
      ios_needs_rebuild: $ios_needs_rebuild,
      debug_reports_addressed: $debug_reports_addressed,
      summary: $summary
    }')

  echo "$REPORT" | aws s3 cp - "s3://${BUCKET}/${S3_PATH}/change_report.json" \
    --region "$AWS_REGION" --content-type "application/json"

  # Generate human-readable markdown report
  local MD_REPORT="# Session Optimizer Change Report

**Session:** $SESSION_ID
**Timestamp:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Summary:** $SUMMARY

## Commits
"
  if [ -n "$IOS_COMMIT" ]; then
    MD_REPORT+="- **iOS (CertMateUnified):** \`$IOS_COMMIT\` — revert: \`git revert $IOS_COMMIT\`
"
  fi
  if [ -n "$BACKEND_COMMIT" ]; then
    MD_REPORT+="- **Backend (EICR_App):** \`$BACKEND_COMMIT\` — revert: \`git revert $BACKEND_COMMIT\`
"
  fi
  MD_REPORT+="
## Deployment
- Backend deployed: $BACKEND_CHANGED
- iOS needs Xcode rebuild: $IOS_CHANGED

## Files Modified
$(echo "$FILES_MODIFIED" | jq -r '.[] | "- \(.file) (\(.change_type))"')
"

  echo "$MD_REPORT" | aws s3 cp - "s3://${BUCKET}/${S3_PATH}/change_report.md" \
    --region "$AWS_REGION" --content-type "text/markdown"

  log "  Change report uploaded to s3://${BUCKET}/${S3_PATH}/change_report.json"
}

# ── Session Summary Builder ──

build_session_summary() {
  local ANALYSIS_FILE="$1"
  local MANIFEST_FILE="$2"
  local OUTPUT_FILE="$3"

  node -e "
    const fs = require('fs');
    const path = require('path');
    const a = JSON.parse(fs.readFileSync('$ANALYSIS_FILE', 'utf8'));
    const m = fs.existsSync('$MANIFEST_FILE') ? JSON.parse(fs.readFileSync('$MANIFEST_FILE', 'utf8')) : {};
    // Fallback: read address from job_snapshot.json (survives crash_recovery manifests)
    const snapshotPath = path.join(path.dirname('$MANIFEST_FILE'), 'job_snapshot.json');
    const snap = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : {};
    const fr = a.field_report || [];
    const regex = fr.filter(f => f.final_source === 'regex').length;
    const sonnet = fr.filter(f => f.final_source === 'sonnet').length;
    const preExisting = fr.filter(f => f.final_source === 'preExisting').length;
    const missed = (a.empty_fields || []).filter(f => f.reason === 'regex_missed_sonnet_missed').length;
    const di = (a.debug_issues && a.debug_issues.issues || []).map(i => i.issue_text).join('; ');
    const ee = a.extraction_efficiency || {};
    const cs = a.cost_summary || {};
    const ua = a.utterance_analysis || [];
    const uncapturedCount = ua.reduce((sum, u) => sum + (u.uncaptured_values || []).length, 0);
    console.log(JSON.stringify({
      address: m.address || (a.session_meta && a.session_meta.address) || snap.address || 'Unknown',
      date: (m.timestamp || '').split('T')[0] || new Date().toISOString().split('T')[0],
      duration: m.duration || (a.session_meta && a.session_meta.durationSeconds ? Math.floor(a.session_meta.durationSeconds / 60) + 'm ' + (a.session_meta.durationSeconds % 60) + 's' : '?'),
      regexFields: regex,
      sonnetFields: sonnet,
      preExistingFields: preExisting,
      missedFields: missed,
      uncapturedValues: uncapturedCount,
      sonnetCalls: ee.sonnet_calls || 0,
      fieldsPerCall: ee.fields_per_call || 0,
      costPerField: ee.cost_per_field_usd || 0,
      debugIssues: di || null,
      totalCost: cs.totalJobCost || parseFloat(m.sonnetCostUSD || '0'),
      deepgramCost: cs.deepgram ? cs.deepgram.cost : null,
      deepgramMinutes: cs.deepgram ? cs.deepgram.minutes : null,
      sonnetCost: cs.sonnet ? cs.sonnet.cost : null,
      sonnetInput: cs.sonnet ? cs.sonnet.input : null,
      sonnetOutput: cs.sonnet ? cs.sonnet.output : null,
      sonnetCacheReads: cs.sonnet ? cs.sonnet.cacheReads : null,
      sonnetCacheWrites: cs.sonnet ? cs.sonnet.cacheWrites : null,
      elevenLabsCost: cs.elevenlabs ? cs.elevenlabs.cost : null,
      // Enhanced data from analysis.json for report HTML
      utterance_analysis: ua,
      cost_breakdown: a.cost_breakdown || null,
      field_report: fr,
      sonnet_prompt_audit: a.sonnet_prompt_audit || null,
      empty_fields: a.empty_fields || [],
      repeated_values: a.repeated_values || [],
      regex_opportunities: a.regex_opportunities || [],
      vad_analysis: a.vad_sleep_analysis || null
    }));
  " > "$OUTPUT_FILE"
}

# ── Fallback Session Processing (no debug_log.jsonl) ──
# When debug_log.jsonl is missing but manifest.json and job_snapshot.json exist,
# run a lighter analysis extracting field fill rates and cost data without
# the full debug log parsing / Claude analysis pipeline.

process_session_fallback() {
  local SESSION_DIR="$1"
  local SESSION_ID="$2"

  log "  Running fallback analysis (no debug_log.jsonl)..."

  # Read job_snapshot.json for field fill rates
  local JOB_SNAPSHOT="{}"
  if [ -f "$SESSION_DIR/job_snapshot.json" ]; then
    JOB_SNAPSHOT=$(cat "$SESSION_DIR/job_snapshot.json")
  else
    log "  ERROR: job_snapshot.json not found for fallback"
    return 1
  fi

  # Read cost_summary.json if available
  local COST_SUMMARY="{}"
  if [ -f "$SESSION_DIR/cost_summary.json" ]; then
    COST_SUMMARY=$(cat "$SESSION_DIR/cost_summary.json")
  fi

  # Read manifest.json for session metadata
  local MANIFEST="{}"
  if [ -f "$SESSION_DIR/manifest.json" ]; then
    MANIFEST=$(cat "$SESSION_DIR/manifest.json")
  fi

  # Read field_sources.json if available
  local FIELD_SOURCES="{}"
  if [ -f "$SESSION_DIR/field_sources.json" ]; then
    FIELD_SOURCES=$(cat "$SESSION_DIR/field_sources.json")
  fi

  # Build a lightweight session summary using node (no analysis.json dependency)
  local REPORT_WORK_DIR
  REPORT_WORK_DIR=$(mktemp -d)

  # Write inputs to temp files to avoid ARG_MAX limits on large snapshots
  echo "$MANIFEST" > "$REPORT_WORK_DIR/_manifest.json"
  echo "$JOB_SNAPSHOT" > "$REPORT_WORK_DIR/_job_snapshot.json"
  echo "$COST_SUMMARY" > "$REPORT_WORK_DIR/_cost_summary.json"
  echo "$FIELD_SOURCES" > "$REPORT_WORK_DIR/_field_sources.json"

  node -e "
    const fs = require('fs');
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const costs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const fieldSources = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));

    // Count filled vs empty fields from job_snapshot
    const fields = snapshot.fields || snapshot.formData || snapshot;
    let filledCount = 0;
    let emptyCount = 0;
    const filledFields = [];
    const emptyFields = [];

    function countFields(obj, prefix) {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, val] of Object.entries(obj)) {
        if (key.startsWith('_')) continue;
        const fullKey = prefix ? prefix + '.' + key : key;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          countFields(val, fullKey);
        } else if (val !== null && val !== undefined && val !== '' && val !== 0) {
          filledCount++;
          filledFields.push(fullKey);
        } else {
          emptyCount++;
          emptyFields.push(fullKey);
        }
      }
    }
    countFields(fields, '');

    // Count field sources if available
    let regexFields = 0;
    let sonnetFields = 0;
    let preExistingFields = 0;
    if (fieldSources && typeof fieldSources === 'object') {
      for (const [, src] of Object.entries(fieldSources)) {
        const source = (typeof src === 'string') ? src : (src && src.source) || '';
        if (source.includes('regex')) regexFields++;
        else if (source.includes('sonnet') || source.includes('ai')) sonnetFields++;
        else if (source.includes('preExisting') || source.includes('existing')) preExistingFields++;
      }
    }

    const fillRate = filledCount + emptyCount > 0
      ? ((filledCount / (filledCount + emptyCount)) * 100).toFixed(1)
      : '0.0';

    const summary = {
      address: manifest.address || snapshot.address || 'Unknown',
      date: (manifest.timestamp || '').split('T')[0] || new Date().toISOString().split('T')[0],
      duration: manifest.duration || '?',
      regexFields: regexFields,
      sonnetFields: sonnetFields,
      preExistingFields: preExistingFields,
      missedFields: 0,
      uncapturedValues: 0,
      totalCost: costs.totalJobCost || parseFloat(manifest.sonnetCostUSD || '0'),
      deepgramCost: costs.deepgram ? costs.deepgram.cost : null,
      deepgramMinutes: costs.deepgram ? costs.deepgram.minutes : null,
      sonnetCost: costs.sonnet ? costs.sonnet.cost : null,
      sonnetInput: costs.sonnet ? costs.sonnet.input : null,
      sonnetOutput: costs.sonnet ? costs.sonnet.output : null,
      sonnetCacheReads: costs.sonnet ? costs.sonnet.cacheReads : null,
      sonnetCacheWrites: costs.sonnet ? costs.sonnet.cacheWrites : null,
      elevenLabsCost: costs.elevenlabs ? costs.elevenlabs.cost : null,
      // Fallback-specific data
      fallback: true,
      fallbackReason: 'debug_log.jsonl not available',
      filledFields: filledCount,
      emptyFieldCount: emptyCount,
      fillRate: fillRate,
      filledFieldNames: filledFields.slice(0, 50),
      emptyFieldNames: emptyFields.slice(0, 50),
      field_report: [],
      utterance_analysis: [],
      empty_fields: [],
      repeated_values: [],
      cost_breakdown: null,
      sonnet_prompt_audit: null,
      vad_analysis: null
    };
    fs.writeFileSync(process.argv[5], JSON.stringify(summary));
  " "$REPORT_WORK_DIR/_manifest.json" "$REPORT_WORK_DIR/_job_snapshot.json" "$REPORT_WORK_DIR/_cost_summary.json" "$REPORT_WORK_DIR/_field_sources.json" "$REPORT_WORK_DIR/session-summary.json" >> "$LOG_FILE" 2>&1 || {
    log "  ERROR: fallback session summary generation failed"
    rm -rf "$REPORT_WORK_DIR"
    return 1
  }

  # No Claude analysis — empty recommendations with a summary noting fallback
  local FILL_RATE
  FILL_RATE=$(jq -r '.fillRate // "?"' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo "?")
  local FILLED_COUNT
  FILLED_COUNT=$(jq -r '.filledFields // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  local EMPTY_COUNT
  EMPTY_COUNT=$(jq -r '.emptyFieldCount // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)

  echo '[]' > "$REPORT_WORK_DIR/recommendations.json"

  # Generate report ID
  local REPORT_ID
  REPORT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

  # Generate HTML report
  node "$SCRIPTS_DIR/generate-report-html.js" \
    "$REPORT_WORK_DIR/recommendations.json" \
    "$REPORT_WORK_DIR/session-summary.json" \
    "$REPORT_ID" \
    "$REPORT_WORK_DIR/report.html" >> "$LOG_FILE" 2>&1 || {
    log "  ERROR: generate-report-html.js failed for fallback report"
    rm -rf "$REPORT_WORK_DIR"
    return 1
  }

  # Extract address for notification
  local ADDRESS
  ADDRESS=$(jq -r '.address // "Unknown"' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo "Unknown")

  # Extract userId from session path
  local SESSION_USER_ID
  SESSION_USER_ID=$(echo "$SESSION_ID" | cut -d'/' -f2)

  # Build meta.json — note type as fallback
  local META_JSON
  META_JSON=$(jq -n \
    --arg sessionPath "$SESSION_ID" \
    --arg userId "$SESSION_USER_ID" \
    --arg address "$ADDRESS" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg reportId "$REPORT_ID" \
    --arg status "pending" \
    '{
      sessionPath: $sessionPath,
      userId: $userId,
      address: $address,
      timestamp: $timestamp,
      reportId: $reportId,
      status: $status,
      type: "fallback",
      fallbackReason: "debug_log.jsonl not available"
    }')
  echo "$META_JSON" > "$REPORT_WORK_DIR/meta.json"

  # Upload report artifacts to S3
  local S3_REPORT_PREFIX="optimizer-reports/${REPORT_ID}"
  aws s3 cp "$REPORT_WORK_DIR/report.html" "s3://${BUCKET}/${S3_REPORT_PREFIX}/report.html" \
    --region "$AWS_REGION" --content-type "text/html"
  aws s3 cp "$REPORT_WORK_DIR/recommendations.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/recommendations.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$REPORT_WORK_DIR/session-summary.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/session-summary.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$REPORT_WORK_DIR/meta.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/meta.json" \
    --region "$AWS_REGION" --content-type "application/json"

  log "  Fallback report uploaded: s3://${BUCKET}/${S3_REPORT_PREFIX}/"

  # Send Pushover notification — clearly marked as fallback
  local REPORT_URL="https://certomatic3000.co.uk/api/optimizer-report/${REPORT_ID}"
  local TOTAL_COST
  TOTAL_COST=$(jq -r '.totalCost // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  local TOTAL_GBP
  TOTAL_GBP=$(echo "$TOTAL_COST" | awk '{printf "%.2f", $1 * 0.79}')

  local PUSHOVER_MSG=""
  PUSHOVER_MSG+="<b>Fallback report (no debug log)</b>\n"
  PUSHOVER_MSG+="Cost: £${TOTAL_GBP}\n"
  PUSHOVER_MSG+="Fields: ${FILLED_COUNT} filled / ${EMPTY_COUNT} empty (${FILL_RATE}% fill rate)\n"
  PUSHOVER_MSG+="\nNo code recommendations — debug_log.jsonl was not uploaded for this session."

  send_pushover_message \
    "Fallback: ${ADDRESS:0:50}" \
    "$PUSHOVER_MSG" \
    0 \
    "$REPORT_URL"

  log "  Fallback Pushover sent for report $REPORT_ID"

  rm -rf "$REPORT_WORK_DIR"
}

# ── Session Processing ──

process_session() {
  local SESSION_DIR="$1"
  local SESSION_ID="$2"
  local DEBUG_REPORTS_DIR="$3"  # Directory with downloaded debug reports (may be empty)

  log "  Pre-processing with analyze-session.js..."

  # Run the Node.js pre-processor
  if ! node "$SCRIPTS_DIR/analyze-session.js" "$SESSION_DIR" >> "$LOG_FILE" 2>&1; then
    log "  ERROR: analyze-session.js failed"
    return 1
  fi

  # Verify analysis.json was created
  if [ ! -f "$SESSION_DIR/analysis.json" ]; then
    log "  ERROR: analysis.json not generated"
    return 1
  fi

  local ANALYSIS
  ANALYSIS=$(cat "$SESSION_DIR/analysis.json")

  # Read current code context for Claude
  local REGEX_PATTERNS=""
  local KEYWORD_BOOSTS=""
  local SONNET_PROMPT=""

  if [ -f "$IOS_DIR/Sources/Recording/TranscriptFieldMatcher.swift" ]; then
    REGEX_PATTERNS=$(head -300 "$IOS_DIR/Sources/Recording/TranscriptFieldMatcher.swift" 2>/dev/null || echo "Could not read")
  fi
  if [ -f "$IOS_DIR/Resources/default_config.json" ]; then
    KEYWORD_BOOSTS=$(cat "$IOS_DIR/Resources/default_config.json" 2>/dev/null || echo "{}")
  fi
  # Compute current keyword count and estimated token usage for budget constraint
  local KEYWORD_COUNT=0
  local KEYWORD_TOKENS=0
  if command -v python3 &>/dev/null && [ -n "$KEYWORD_BOOSTS" ]; then
    read KEYWORD_COUNT KEYWORD_TOKENS < <(echo "$KEYWORD_BOOSTS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
kb=d.get('keyword_boosts',{})
base=kb.get('base_electrical',{})
board=kb.get('board_types',{})
count=0; tokens=0
for kw,boost in list(base.items())+list(board.items()):
    if kw.startswith('_'): continue
    count+=1
    words=len(kw.split())
    text_tok=max(words*2,1)
    boost_tok=4 if boost>=2.0 else 0
    tokens+=text_tok+boost_tok
print(count,tokens)
" 2>/dev/null || echo "0 0")
  fi
  local TOKEN_BUDGET=450
  local TOKEN_HEADROOM=$((TOKEN_BUDGET - KEYWORD_TOKENS))
  # Server-side Sonnet extraction session (primary prompt for optimization)
  if [ -f "$BACKEND_DIR/src/extraction/eicr-extraction-session.js" ]; then
    SONNET_PROMPT=$(head -200 "$BACKEND_DIR/src/extraction/eicr-extraction-session.js" 2>/dev/null || echo "Could not read")
  fi

  # Collect debug reports context
  local DEBUG_CONTEXT=""
  local DEBUG_REPORTS_LIST="[]"
  if [ -d "$DEBUG_REPORTS_DIR" ] && [ "$(ls -A "$DEBUG_REPORTS_DIR" 2>/dev/null)" ]; then
    for dr in "$DEBUG_REPORTS_DIR"/*.json; do
      [ -f "$dr" ] || continue
      local dr_content
      dr_content=$(cat "$dr")
      local dr_name
      dr_name=$(basename "$dr" .json)
      DEBUG_CONTEXT+="
--- Debug Report: $dr_name ---
$dr_content
"
      DEBUG_REPORTS_LIST=$(echo "$DEBUG_REPORTS_LIST" | jq --arg r "$dr_name" '. + [$r]')
    done
  fi

  log "  Running Claude Code (read-only) for recommendations..."

  # Record git state for potential later application
  record_git_state

  cd "$CODEBASE"

  # Check for user feedback (from a previous run that was reverted)
  local FEEDBACK_CONTEXT=""
  local FEEDBACK_FILE="/tmp/certmate_feedback_${SESSION_ID//\//_}.json"
  if [ -f "$FEEDBACK_FILE" ]; then
    local FEEDBACK_ITEMS
    FEEDBACK_ITEMS=$(cat "$FEEDBACK_FILE" | jq -r '.[].text' 2>/dev/null || cat "$FEEDBACK_FILE")
    FEEDBACK_CONTEXT="
USER FEEDBACK (HIGH PRIORITY — the user corrected the previous analysis)
The optimizer previously processed this session and got something wrong.
The user provided this feedback. FOLLOW IT EXACTLY:
${FEEDBACK_ITEMS}

Use this feedback to correct your analysis. The previous fix has been reverted.
Do NOT repeat the same mistake."
    rm -f "$FEEDBACK_FILE"
  fi

  # Check for re-run context (from report page re-run request)
  local RERUN_CONTEXT=""
  local RERUN_CONTEXT_FILE="/tmp/certmate_rerun_context_$(echo "$SESSION_ID" | tr '/' '_').txt"
  if [ -f "$RERUN_CONTEXT_FILE" ]; then
    RERUN_CONTEXT=$(cat "$RERUN_CONTEXT_FILE")
    rm "$RERUN_CONTEXT_FILE"
    log "  Re-run context loaded: ${RERUN_CONTEXT:0:100}..."
  fi

  # Extract data sections from analysis for Claude prompt
  local TRANSCRIPT_DATA SONNET_IO REGEX_DATA SONNET_DATA DEBUG_ISSUES FIELD_SOURCES_DATA UTTERANCE_DATA REPEATED_VALUES_DATA
  TRANSCRIPT_DATA=$(echo "$ANALYSIS" | jq -r '.utterance_analysis // [] | map(.text) | join("\n")' 2>/dev/null || echo "No transcript available")
  SONNET_IO=$(echo "$ANALYSIS" | jq -c '.sonnet_performance // {}' 2>/dev/null || echo "{}")
  REGEX_DATA=$(echo "$ANALYSIS" | jq -c '.regex_performance // {}' 2>/dev/null || echo "{}")
  SONNET_DATA=$(echo "$ANALYSIS" | jq -c '.field_report // []' 2>/dev/null || echo "[]")
  DEBUG_ISSUES=$(echo "$ANALYSIS" | jq -c '.debug_issues // {}' 2>/dev/null || echo "{}")
  UTTERANCE_DATA=$(echo "$ANALYSIS" | jq -c '[(.utterance_analysis // [])[] | select(.uncaptured_values | length > 0)]' 2>/dev/null || echo "[]")
  REPEATED_VALUES_DATA=$(echo "$ANALYSIS" | jq -c '.repeated_values // []' 2>/dev/null || echo "[]")

  # Load field_sources.json if available
  FIELD_SOURCES_DATA="{}"
  if [ -f "$SESSION_DIR/field_sources.json" ]; then
    FIELD_SOURCES_DATA=$(cat "$SESSION_DIR/field_sources.json" 2>/dev/null || echo "{}")
  fi

  # Write prompt to temp file using printf for data (safe from shell expansion)
  # and quoted heredocs for static text (no command substitution)
  local PROMPT_FILE
  PROMPT_FILE=$(mktemp)
  {
    cat <<'PROMPT_INTRO'
You are the CertMate Session Optimizer. You have READ-ONLY access to the codebase.
Your job is to analyze a recording session, find why values were missed, and produce
structured JSON recommendations for code changes. You do NOT apply changes yourself.

## Session Analysis (from analyze-session.js)
PROMPT_INTRO
    printf '%s\n\n' "$ANALYSIS"
    printf '%s\n' "=== FULL TRANSCRIPT ==="
    printf '%s\n\n' "$TRANSCRIPT_DATA"
    printf '%s\n' "=== SONNET INPUTS/OUTPUTS ==="
    printf '%s\n\n' "$SONNET_IO"
    printf '%s\n' "=== REGEX MATCHES ==="
    printf '%s\n\n' "$REGEX_DATA"
    printf '%s\n' "=== SONNET EXTRACTIONS ==="
    printf '%s\n\n' "$SONNET_DATA"
    printf '%s\n' "=== DEBUG ISSUES ==="
    printf '%s\n\n' "$DEBUG_ISSUES"
    printf '%s\n' "=== FIELD SOURCES ==="
    printf '%s\n\n' "$FIELD_SOURCES_DATA"
    cat <<'PROMPT_UNCAPTURED'
=== UTTERANCES WITH UNCAPTURED VALUES ===
These utterances contain number values that were NOT captured by regex or Sonnet.
Each entry has: timestamp, text, uncaptured_values (numbers spoken but not assigned to any field),
and any regex/sonnet captures that DID happen for that utterance.
Focus your recommendations on catching these missed values.
PROMPT_UNCAPTURED
    printf '%s\n\n' "$UTTERANCE_DATA"
    cat <<'PROMPT_REPEATED'
=== REPEATED VALUES ===
Values spoken 2+ times without being captured. The user is likely repeating themselves because
the system didn't acknowledge the value. High priority for regex improvements.
PROMPT_REPEATED
    printf '%s\n\n' "$REPEATED_VALUES_DATA"
    printf '%s\n' "## Current Regex Patterns (TranscriptFieldMatcher.swift — first 300 lines)"
    printf '%s\n\n' "$REGEX_PATTERNS"
    printf '%s\n' "## Current Remote Config (default_config.json — keyword boosts + regex overrides)"
    printf '%s\n\n' "$KEYWORD_BOOSTS"
    printf '%s\n' "### KEYWORD TOKEN BUDGET: ${KEYWORD_COUNT} entries using ~${KEYWORD_TOKENS}/${TOKEN_BUDGET} estimated tokens (${TOKEN_HEADROOM} tokens free)"
    cat <<'PROMPT_KEYWORDS'
Deepgram Nova-3 has a 500-TOKEN limit across all keyterms (BPE-style tokenization).
iOS KeywordBoostGenerator uses a two-tier token-budget strategy:
- **Tier 1 (boost >= 2.0)**: Sent WITH boost suffix (e.g. keyterm=circuit:3.0). Costs ~(words*2 + 4) tokens.
- **Tier 2 (boost < 2.0)**: Sent as PLAIN keyterm (e.g. keyterm=MCB). Costs ~(words*2) tokens. Still activates keyterm prompting but without priority boosting.
- Keywords with boost >= 2.0 are critical — they get Deepgram priority boosting.
- Keywords with boost < 2.0 still improve recognition but without priority weighting.
- New keywords at boost >= 2.0 cost ~6 tokens (text + boost suffix); at < 2.0 cost ~2 tokens (text only).
- NEVER add case-insensitive duplicates of existing keywords.
- keyword_removal is now LESS necessary since all keywords fit, but still useful for removing genuinely unhelpful terms.

PROMPT_KEYWORDS
    printf '%s\n' "## Current Sonnet Extraction (server-side eicr-extraction-session.js — first 200 lines)"
    printf '%s\n\n' "$SONNET_PROMPT"
    printf '%s\n' "## User Feedback (corrections from previous optimizer run)"
    printf '%s\n\n' "${FEEDBACK_CONTEXT:-No user feedback for this session.}"
    printf '%s\n' "## Debug Reports (user-reported issues from voice debug commands)"
    printf '%s\n' "${DEBUG_CONTEXT:-No debug reports for this session.}"
    if [ -n "$RERUN_CONTEXT" ]; then
      printf '\n%s\n' "=== USER FEEDBACK FOR RE-RUN (HIGH PRIORITY) ==="
      printf '%s\n' "The user reviewed the previous recommendations and provided this additional context:"
      printf '%s\n' "$RERUN_CONTEXT"
      printf '%s\n' "Take this feedback into account when making your recommendations."
    fi
    cat <<'PROMPT_INSTRUCTIONS'

## INSTRUCTIONS — READ CAREFULLY

### CORE PRINCIPLE: REGEX-FIRST
For every missed value, your FIRST question must be: "Can a regex pattern in TranscriptFieldMatcher.swift catch this?"
Regex is instant, free, and deterministic. Sonnet costs tokens, has latency, and can hallucinate.
Only recommend Sonnet prompt changes when the value GENUINELY requires AI understanding (e.g., inferring
context, resolving ambiguity, handling complex multi-field relationships). If the user said "Ze is 0.35"
and it was missed, that is ALWAYS a regex fix — never a Sonnet prompt change.

### 1. Scan utterance-level data for missed values
The UTTERANCES WITH UNCAPTURED VALUES section above lists every utterance where a number was spoken
but NOT captured by any field_set event. For EACH uncaptured value, determine:
- What field was the user likely providing this value for? (Use surrounding electrical terms as context.)
- Did regex have a pattern for this field? If not, write one.
- Did Sonnet extract it? If not, why? (Was the transcript sent? Was the field in the prompt?)

The REPEATED VALUES section lists values spoken 2+ times. These are HIGH PRIORITY — the user
repeated themselves because the system didn't acknowledge the value. Every repeated value should
result in a regex_improvement recommendation.

For EVERY empty field in the analysis, also check the full transcript for spoken values.
If a value was clearly spoken but not captured, classify the root cause using this priority order:
1. **Regex miss** (MOST LIKELY): The pattern in TranscriptFieldMatcher.swift doesn't match the phrasing.
   Check: Does a pattern exist for this field? Does it match the exact spoken form? Does NumberNormaliser
   convert the spoken numbers correctly? Would a Deepgram keyword boost help recognition?
2. **Number normalisation miss**: NumberNormaliser.swift doesn't handle the spoken form (e.g., "nought
   point three five" not converting to "0.35"). Fix in NumberNormaliser.swift.
3. **Keyword boost miss**: Deepgram misheard a technical term (e.g., "Zed S" → "said S"). Fix by adding
   a keyword boost in default_config.json or KeywordBoostGenerator.swift. Two-tier system: boost >= 2.0
   gets priority boosting, boost < 2.0 still activates keyterm prompting. All config keywords are sent.
4. **Config/mapping issue**: Field routing, model decode, or remote config problem in iOS code.
5. **Sonnet prompt issue** (LAST RESORT): Only if the value requires genuine AI reasoning that regex
   cannot handle — e.g., inferring earthing type from context, resolving contradictory readings,
   understanding that "the one in the kitchen" refers to circuit 3.

### 2. Read each debug report carefully
The user explicitly told you what's wrong. Investigate the root cause in the codebase.

### 3. Investigate the root cause
Use Read, Glob, and Grep to explore the codebase. Look at:
- **Regex patterns**: CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift
- **Number normaliser**: CertMateUnified/Sources/Recording/NumberNormaliser.swift
- **Keyword boosts**: CertMateUnified/Sources/Resources/default_config.json (primary — the optimizer auto-applies to the Resources/ copy too, so emit only ONE recommendation per change using this path)
- **Keyword generator**: CertMateUnified/Sources/Recording/KeywordBoostGenerator.swift
- **Sonnet extraction session**: EICR_App/src/extraction/eicr-extraction-session.js (EICR_SYSTEM_PROMPT — the main rolling extraction prompt)
- **Server WS handler**: EICR_App/src/sonnet-stream.js (WebSocket message routing)
- **iOS model fields**: CertMateUnified model files (RollingExtractionResult, etc.)
- **Alert/question logic**: CertMateUnified/Sources/Services/AlertManager.swift

### 4. Sonnet prompt audit
After analyzing missed values, audit the Sonnet system prompt in eicr-extraction-session.js (EICR_SYSTEM_PROMPT):
- Identify instructions that are REDUNDANT because regex now handles those fields reliably.
- Identify instructions that are overly verbose and could be trimmed without losing accuracy.
- Identify fields that Sonnet is told to extract but regex already catches >90% of the time — suggest
  removing those from the Sonnet prompt to reduce token cost.
- Estimate the token count of the current prompt and any suggested changes.

### 5. IMPORTANT CONSTRAINTS
- You are READ-ONLY. Do NOT attempt to edit, write, or run bash commands.
- For each recommended change, provide the EXACT old_code string to find and the EXACT new_code replacement.
- The old_code must be an EXACT match of existing code (copy it from the file).
- **Keep changes focused** — fix the specific issues found, don't refactor unrelated code.
- **Prefer regex over Sonnet** — if in doubt, write a regex pattern. Only touch Sonnet as last resort.
- **Sonnet prompt changes must REDUCE or maintain token count** — never bloat the prompt.

### 5b. REGEX SAFETY — READ THIS BEFORE WRITING ANY PATTERN
New regex patterns MUST NOT false-match existing patterns for different fields. Before writing a regex:
1. **Check for keyword collisions**: Search TranscriptFieldMatcher.swift for every keyword in your pattern.
   Example: "voltage" appears in IR test voltage context ("test voltage is 250"). A pattern matching
   "voltage is (\d+)" would false-match "test voltage is 250" as supply voltage. ALWAYS check.
2. **Require distinguishing context**: If a keyword is shared between fields, your pattern MUST require
   the distinguishing word. E.g., require "supply voltage" not just "voltage"; require "supply frequency"
   not just "frequency". Prefer precision over recall — a missed regex match falls back to Sonnet safely,
   but a false match writes the wrong value to the wrong field with no recovery.
3. **Handle Deepgram number splitting**: Deepgram often splits numbers into separate digits ("240" -> "2 40",
   "299" -> "2 9 9"). Your regex capture group MUST handle this — use (\d[\d\s]*\d) not (\d+) for
   multi-digit values, and strip spaces before validation. Check NumberNormaliser.swift for existing
   handling patterns.
4. **Validate ranges defensively**: Always validate captured numbers against realistic ranges for the field.
   Include BOTH lower and upper bounds. E.g., voltage 100-500V, frequency 45-65Hz, Ze 0.01-200 ohms.

### 6. Categorise every recommendation
Every recommendation MUST have a "category" from this list:
- **regex_improvement**: New or improved regex pattern in TranscriptFieldMatcher.swift
- **number_normaliser**: Fix in NumberNormaliser.swift for spoken number conversion
- **keyword_boost**: New keyword boost in default_config.json or KeywordBoostGenerator.swift. Two-tier: boost >= 2.0 gets Deepgram priority boosting (~6 tokens); boost < 2.0 still activates prompting (~2 tokens). All keywords fit within 450-token budget. Use boost >= 2.0 for critical terms only.
- **keyword_removal**: Remove a genuinely unhelpful or redundant keyword from default_config.json. Less critical now that all keywords fit, but still useful for decluttering. Use old_code with the line to remove and new_code as empty string.
- **sonnet_prompt_trim**: Removing redundant/verbose instructions from Sonnet prompt (saves tokens)
- **sonnet_prompt_addition**: Adding new Sonnet prompt instructions (costs tokens — justify why regex can't do it)
- **config_change**: Remote config or default_config.json change
- **bug_fix**: Code bug in iOS/backend logic (field routing, model decode, etc.)

### 7. Output format
Output ONLY a JSON object (no markdown fences, no explanation before or after) with this format:
{
  "recommendations": [
    {
      "title": "Short title of the change",
      "description": "Why this change is needed and what it fixes",
      "explanation": "Plain-English explanation of WHAT this change does and WHY, written for a non-technical user (e.g. 'Adds a pattern to recognise when you say Ze is followed by a number, so the app captures it instantly instead of waiting for AI'). 1-2 sentences max.",
      "category": "regex_improvement|number_normaliser|keyword_boost|keyword_removal|sonnet_prompt_trim|sonnet_prompt_addition|config_change|bug_fix",
      "token_impact": 0,
      "file": "/absolute/path/to/file.swift",
      "old_code": "exact string to find in the file",
      "new_code": "replacement string"
    }
  ],
  "sonnet_prompt_audit": {
    "current_estimated_tokens": 0,
    "suggested_trims": ["description of each trim opportunity"],
    "redundant_fields": ["fields that regex handles reliably and Sonnet doesn't need to extract"],
    "net_token_change": 0
  },
  "summary": "Brief human-readable summary of all recommendations"
}

Notes on fields:
- "explanation": REQUIRED. A user-facing plain-English summary of what this change does and why. No code, no jargon. Written as if explaining to the electrician using the app.
- "token_impact": Estimated token delta for Sonnet prompt changes. Positive = adds tokens, negative = saves tokens. 0 for non-prompt changes (regex, config, bug fixes).
- "category": MUST be one of the 8 categories listed above.
- "sonnet_prompt_audit": Always include this section, even if no trims are suggested.

If no changes are needed, output:
{
  "recommendations": [],
  "sonnet_prompt_audit": {
    "current_estimated_tokens": 0,
    "suggested_trims": [],
    "redundant_fields": [],
    "net_token_change": 0
  },
  "summary": "Session analyzed — no code changes needed. All fields captured correctly."
}
PROMPT_INSTRUCTIONS
  } > "$PROMPT_FILE"

  # Invoke Claude Code with read-only access
  local CLAUDE_OUTPUT
  CLAUDE_OUTPUT=$("$CLAUDE" -p "$(cat "$PROMPT_FILE")" \
    --allowedTools "Read,Glob,Grep" 2>&1) || true
  rm -f "$PROMPT_FILE"

  # Parse JSON recommendations from Claude's output (last JSON object)
  local JSON_OUTPUT
  JSON_OUTPUT=$(echo "$CLAUDE_OUTPUT" | perl -0777 -ne 'print $1 if /.*(\{[\s\S]*\})/m' 2>/dev/null)
  if [ -z "$JSON_OUTPUT" ]; then
    JSON_OUTPUT='{"recommendations":[],"summary":"Could not parse Claude output"}'
  fi

  local RECOMMENDATIONS
  RECOMMENDATIONS=$(echo "$JSON_OUTPUT" | jq -c '.recommendations // []' 2>/dev/null || echo "[]")
  local REC_COUNT
  REC_COUNT=$(echo "$RECOMMENDATIONS" | jq 'length' 2>/dev/null || echo 0)
  local SUMMARY
  SUMMARY=$(echo "$JSON_OUTPUT" | jq -r '.summary // "Analysis complete"' 2>/dev/null | head -c 200 || echo "Analysis complete")

  log "  Claude returned $REC_COUNT recommendations: $SUMMARY"

  # Generate report ID
  local REPORT_ID
  REPORT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

  # Save recommendations to temp dir
  local REPORT_WORK_DIR
  REPORT_WORK_DIR=$(mktemp -d)
  echo "$RECOMMENDATIONS" > "$REPORT_WORK_DIR/recommendations.json"

  # Build session summary
  build_session_summary "$SESSION_DIR/analysis.json" "$SESSION_DIR/manifest.json" "$REPORT_WORK_DIR/session-summary.json"

  # Generate HTML report
  node "$SCRIPTS_DIR/generate-report-html.js" \
    "$REPORT_WORK_DIR/recommendations.json" \
    "$REPORT_WORK_DIR/session-summary.json" \
    "$REPORT_ID" \
    "$REPORT_WORK_DIR/report.html" >> "$LOG_FILE" 2>&1 || {
    log "  ERROR: generate-report-html.js failed"
    rm -rf "$REPORT_WORK_DIR"
    return 1
  }

  # Extract address from session summary for notification
  local ADDRESS
  ADDRESS=$(jq -r '.address // "Unknown"' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo "Unknown")

  # Extract userId from session path (session-analytics/{userId}/{sessionId})
  local SESSION_USER_ID
  SESSION_USER_ID=$(echo "$SESSION_ID" | cut -d'/' -f2)

  # Build meta.json
  local META_JSON
  META_JSON=$(jq -n \
    --arg sessionPath "$SESSION_ID" \
    --arg userId "$SESSION_USER_ID" \
    --arg address "$ADDRESS" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg reportId "$REPORT_ID" \
    --arg status "pending" \
    '{
      sessionPath: $sessionPath,
      userId: $userId,
      address: $address,
      timestamp: $timestamp,
      reportId: $reportId,
      status: $status
    }')
  echo "$META_JSON" > "$REPORT_WORK_DIR/meta.json"

  # Upload report artifacts to S3
  local S3_REPORT_PREFIX="optimizer-reports/${REPORT_ID}"
  aws s3 cp "$REPORT_WORK_DIR/report.html" "s3://${BUCKET}/${S3_REPORT_PREFIX}/report.html" \
    --region "$AWS_REGION" --content-type "text/html"
  aws s3 cp "$REPORT_WORK_DIR/recommendations.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/recommendations.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$REPORT_WORK_DIR/session-summary.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/session-summary.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$SESSION_DIR/analysis.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/analysis.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$REPORT_WORK_DIR/meta.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/meta.json" \
    --region "$AWS_REGION" --content-type "application/json"

  # Also upload Claude's raw output for debugging
  echo "$CLAUDE_OUTPUT" | aws s3 cp - "s3://${BUCKET}/${S3_REPORT_PREFIX}/claude_output.md" \
    --region "$AWS_REGION" --content-type "text/markdown"

  log "  Report uploaded: s3://${BUCKET}/${S3_REPORT_PREFIX}/"

  # Build enhanced Pushover message with key stats
  local REPORT_URL="https://certomatic3000.co.uk/api/optimizer-report/${REPORT_ID}"
  local PUSHOVER_MSG=""

  # Extract stats from session-summary.json for notification
  local SS_REGEX SS_SONNET SS_MISSED SS_UNCAPTURED SS_TOTAL_COST SS_TOTAL_GBP
  SS_REGEX=$(jq -r '.regexFields // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  SS_SONNET=$(jq -r '.sonnetFields // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  SS_MISSED=$(jq -r '.missedFields // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  SS_UNCAPTURED=$(jq -r '.uncapturedValues // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  SS_TOTAL_COST=$(jq -r '.totalCost // 0' "$REPORT_WORK_DIR/session-summary.json" 2>/dev/null || echo 0)
  SS_TOTAL_GBP=$(echo "$SS_TOTAL_COST" | awk '{printf "%.2f", $1 * 0.79}')

  PUSHOVER_MSG+="<b>${REC_COUNT} recommendations</b>\n"
  PUSHOVER_MSG+="Cost: £${SS_TOTAL_GBP}\n"
  PUSHOVER_MSG+="Fields: ${SS_REGEX} regex / ${SS_SONNET} sonnet / ${SS_MISSED} missed\n"
  if [ "$SS_UNCAPTURED" -gt 0 ]; then
    PUSHOVER_MSG+="Uncaptured values: ${SS_UNCAPTURED}\n"
  fi
  # Add per-recommendation one-liner explanations
  if [ "$REC_COUNT" -gt 0 ]; then
    PUSHOVER_MSG+="\n"
    local REC_IDX=0
    while IFS= read -r rec_line; do
      local REC_EXPLAIN
      REC_EXPLAIN=$(echo "$rec_line" | jq -r '.explanation // .description // .title' | head -c 120)
      local REC_CAT
      REC_CAT=$(echo "$rec_line" | jq -r '.category // ""' | head -c 20)
      case "$REC_CAT" in
        regex_improvement) REC_CAT="Regex" ;;
        keyword_boost) REC_CAT="Keyword" ;;
        sonnet_prompt_trim) REC_CAT="Trim" ;;
        sonnet_prompt_addition) REC_CAT="Sonnet" ;;
        bug_fix) REC_CAT="Fix" ;;
        config_change) REC_CAT="Config" ;;
        number_normaliser) REC_CAT="Numbers" ;;
        keyword_removal) REC_CAT="Keyword" ;;
        *) REC_CAT="Change" ;;
      esac
      PUSHOVER_MSG+="• <b>${REC_CAT}:</b> ${REC_EXPLAIN}\n"
      REC_IDX=$((REC_IDX + 1))
      [ "$REC_IDX" -ge 6 ] && break  # Max 6 to fit Pushover limit
    done < <(echo "$RECOMMENDATIONS" | jq -c '.[]' 2>/dev/null)
  fi
  PUSHOVER_MSG+="\n${SUMMARY}"

  send_pushover_message \
    "Session: ${ADDRESS:0:50}" \
    "$PUSHOVER_MSG" \
    0 \
    "$REPORT_URL"

  log "  Pushover sent for report $REPORT_ID"

  rm -rf "$REPORT_WORK_DIR"
}

# ── Debug Report Processing (standalone, no matching session) ──
# Now uses URL-based review system (same as process_session)

process_standalone_debug_report() {
  local REPORT_DIR="$1"
  local REPORT_S3_PATH="$2"

  local REPORT_JSON
  REPORT_JSON=$(cat "$REPORT_DIR/debug_report.json")
  local CONTEXT_JSON
  CONTEXT_JSON=$(cat "$REPORT_DIR/context.json" 2>/dev/null || echo '{}')
  local TITLE
  TITLE=$(echo "$REPORT_JSON" | jq -r '.title // "Untitled"')
  local ADDRESS
  ADDRESS=$(echo "$CONTEXT_JSON" | jq -r '.address // "Debug Report"' 2>/dev/null)
  local USER_ID
  USER_ID=$(echo "$CONTEXT_JSON" | jq -r '.userId // "unknown"' 2>/dev/null)

  log "  Processing standalone debug report: $TITLE"

  cd "$CODEBASE"

  # Check for rerun context
  local RERUN_CONTEXT=""
  local RERUN_CONTEXT_FILE="/tmp/certmate_rerun_context_$(echo "$REPORT_S3_PATH" | tr '/' '_').txt"
  if [ -f "$RERUN_CONTEXT_FILE" ]; then
    RERUN_CONTEXT=$(cat "$RERUN_CONTEXT_FILE")
    rm "$RERUN_CONTEXT_FILE"
    log "  Re-run context loaded: ${RERUN_CONTEXT:0:100}..."
  fi

  local PROMPT_FILE
  PROMPT_FILE=$(mktemp)
  cat > "$PROMPT_FILE" <<PROMPT_EOF
You are the CertMate Session Optimizer (v3). You have READ-ONLY access to the codebase.
A user reported a bug via voice debug during a recording session.
Analyze the root cause and output structured JSON recommendations.

## Bug Report
$REPORT_JSON

## Job Context
$CONTEXT_JSON

${RERUN_CONTEXT:+
## USER FEEDBACK FOR RE-RUN (HIGH PRIORITY)
The user reviewed the previous recommendations and provided this additional context:
$RERUN_CONTEXT
Take this feedback into account when making your recommendations.
}

## INSTRUCTIONS

1. Read the bug report carefully. The user told you exactly what's wrong.
2. Investigate the root cause in the codebase:
   - Regex patterns: CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift
   - Sonnet extraction session: EICR_App/src/extraction/eicr-extraction-session.js (system prompt + extraction)
   - Server WS handler: EICR_App/src/sonnet-stream.js (message routing + question gate)
   - Backend extraction (batch): EICR_App/src/extract.js, EICR_App/src/api.js
   - Number normalisation: CertMateUnified/Sources/Recording/NumberNormaliser.swift
   - Keyword boosts: CertMateUnified/Resources/default_config.json
   - Any other relevant file
3. DO NOT edit files. Output recommendations as structured JSON.
4. IMPORTANT: Keep eicr-extraction-session.js system prompt changes MINIMAL.
5. Output ONLY a valid JSON object as the LAST thing in your response:
{
  "recommendations": [
    {
      "title": "Short description of the fix",
      "description": "Why this change is needed",
      "explanation": "Plain-English explanation of WHAT this change does and WHY, written for a non-technical user. 1-2 sentences max.",
      "file": "/absolute/path/to/file",
      "old_code": "exact string to find in file",
      "new_code": "replacement string"
    }
  ],
  "summary": "Brief overall summary"
}
PROMPT_EOF

  # Invoke Claude Code with read-only access
  local CLAUDE_OUTPUT
  CLAUDE_OUTPUT=$("$CLAUDE" -p "$(cat "$PROMPT_FILE")" \
    --allowedTools "Read,Glob,Grep" 2>&1) || true
  rm -f "$PROMPT_FILE"

  # Parse recommendations from Claude output
  local JSON_OUTPUT
  JSON_OUTPUT=$(echo "$CLAUDE_OUTPUT" | perl -0777 -ne 'print $1 if /.*(\{[\s\S]*\})/m' 2>/dev/null)
  if [ -z "$JSON_OUTPUT" ]; then
    JSON_OUTPUT='{"recommendations":[],"summary":"Could not parse output"}'
  fi

  local RECOMMENDATIONS
  RECOMMENDATIONS=$(echo "$JSON_OUTPUT" | jq -c '.recommendations // []' 2>/dev/null || echo '[]')
  local REC_COUNT
  REC_COUNT=$(echo "$RECOMMENDATIONS" | jq 'length' 2>/dev/null || echo 0)
  local SUMMARY
  SUMMARY=$(echo "$JSON_OUTPUT" | jq -r '.summary // "Analysis complete"' 2>/dev/null | head -c 200)

  log "  Debug report analyzed: $REC_COUNT recommendations"

  # Generate report ID and build HTML report
  local REPORT_UUID
  REPORT_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')

  local REPORT_WORK_DIR
  REPORT_WORK_DIR=$(mktemp -d)

  # Save recommendations
  echo "$RECOMMENDATIONS" > "$REPORT_WORK_DIR/recommendations.json"

  # Build session summary (debug report context)
  cat > "$REPORT_WORK_DIR/session-summary.json" <<EOF
{
  "address": "Debug: $(echo "$TITLE" | head -c 60)",
  "date": "$(date +%Y-%m-%d)",
  "duration": "Debug report",
  "regexFields": 0,
  "sonnetFields": 0,
  "debugIssues": $(echo "$REPORT_JSON" | jq -r '.description // .title // "Unknown issue"' | jq -Rs .)
}
EOF

  # Generate HTML report
  node "$SCRIPTS_DIR/generate-report-html.js" \
    "$REPORT_WORK_DIR/recommendations.json" \
    "$REPORT_WORK_DIR/session-summary.json" \
    "$REPORT_UUID" \
    "$REPORT_WORK_DIR/report.html" >> "$LOG_FILE" 2>&1 || {
    log "  ERROR: generate-report-html.js failed for debug report"
    rm -rf "$REPORT_WORK_DIR"
    return 1
  }

  # Build meta.json
  cat > "$REPORT_WORK_DIR/meta.json" <<EOF
{
  "sessionPath": "$REPORT_S3_PATH",
  "userId": "$USER_ID",
  "address": "$ADDRESS",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reportId": "$REPORT_UUID",
  "status": "pending",
  "type": "debug_report"
}
EOF

  # Upload to S3
  local S3_REPORT_PREFIX="optimizer-reports/${REPORT_UUID}"
  aws s3 cp "$REPORT_WORK_DIR/report.html" "s3://${BUCKET}/${S3_REPORT_PREFIX}/report.html" \
    --region "$AWS_REGION" --content-type "text/html"
  aws s3 cp "$REPORT_WORK_DIR/recommendations.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/recommendations.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$REPORT_WORK_DIR/session-summary.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/session-summary.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$REPORT_WORK_DIR/meta.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/meta.json" \
    --region "$AWS_REGION" --content-type "application/json"
  echo "$CLAUDE_OUTPUT" | aws s3 cp - "s3://${BUCKET}/${S3_REPORT_PREFIX}/claude_output.md" \
    --region "$AWS_REGION" --content-type "text/markdown"

  log "  Debug report uploaded: s3://${BUCKET}/${S3_REPORT_PREFIX}/"

  # Send Pushover with clickable report URL
  local REPORT_URL="https://certomatic3000.co.uk/api/optimizer-report/${REPORT_UUID}"
  send_pushover_message \
    "Debug: ${TITLE:0:50}" \
    "$REC_COUNT recommendations — $SUMMARY" \
    0 \
    "$REPORT_URL"

  log "  Pushover sent for debug report $REPORT_UUID"

  rm -rf "$REPORT_WORK_DIR"
}

# ── Apply Accepted Recommendations (from report page) ──

apply_accepted_recommendations() {
  local REPORT_ID="$1"
  local ACCEPTED_INDICES="$2"  # JSON array string like "[0,2,3]"

  log "  Applying accepted recommendations for report $REPORT_ID..."

  # Download recommendations.json and meta.json
  local WORK_DIR
  WORK_DIR=$(mktemp -d)
  aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/recommendations.json" "$WORK_DIR/recommendations.json" --region "$AWS_REGION"
  aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" "$WORK_DIR/meta.json" --region "$AWS_REGION"

  local SESSION_PATH
  SESSION_PATH=$(jq -r '.sessionPath' "$WORK_DIR/meta.json")

  # Record git state before applying
  record_git_state

  # Apply each accepted recommendation using node
  # Write accepted indices to file to avoid shell injection
  echo "$ACCEPTED_INDICES" > "$WORK_DIR/accepted_indices.json"
  local APPLY_OUTPUT
  APPLY_OUTPUT=$(node -e "
    const recs = JSON.parse(require('fs').readFileSync('$WORK_DIR/recommendations.json','utf8'));
    const accepted = JSON.parse(require('fs').readFileSync('$WORK_DIR/accepted_indices.json','utf8'));
    const fs = require('fs');
    let applied = 0;
    let failed = 0;
    for (const idx of accepted) {
      const rec = recs[idx];
      if (!rec) { console.error('Invalid index: ' + idx); failed++; continue; }
      try {
        const content = fs.readFileSync(rec.file, 'utf8');
        if (content.includes(rec.old_code)) {
          const updated = content.replace(rec.old_code, rec.new_code);
          fs.writeFileSync(rec.file, updated, 'utf8');
          applied++;
          console.log('Applied: ' + rec.title);
          // Auto-duplicate config changes to the Resources/ copy
          if (rec.file.includes('Sources/Resources/default_config.json')) {
            const mirrorPath = rec.file.replace('Sources/Resources/default_config.json', 'Resources/default_config.json');
            try {
              const mirrorContent = fs.readFileSync(mirrorPath, 'utf8');
              if (mirrorContent.includes(rec.old_code)) {
                fs.writeFileSync(mirrorPath, mirrorContent.replace(rec.old_code, rec.new_code), 'utf8');
                console.log('Auto-mirrored to Resources/ copy: ' + rec.title);
              } else {
                console.error('Mirror old_code not found in ' + mirrorPath);
              }
            } catch (e) {
              console.error('Mirror failed for ' + mirrorPath + ': ' + e.message);
            }
          }
        } else {
          console.error('old_code not found in ' + rec.file + ': ' + rec.title);
          failed++;
        }
      } catch (e) {
        console.error('Failed to apply ' + rec.title + ': ' + e.message);
        failed++;
      }
    }
    console.log('Applied ' + applied + '/' + accepted.length + ' recommendations (' + failed + ' failed)');
  " 2>&1) || true

  log "  $APPLY_OUTPUT"

  # Commit and deploy
  commit_changes "optimizer-report/${REPORT_ID}" "Applied accepted recommendations from report ${REPORT_ID:0:8}"

  if [ "$BACKEND_CHANGED" = "true" ]; then
    deploy_backend
  fi

  # Generate change report (needed for feedback revert flow)
  generate_change_report "optimizer-report/${REPORT_ID}" "$SESSION_PATH" \
    "Applied accepted recommendations from report ${REPORT_ID:0:8}" "[]"

  # Update meta.json status to "applied"
  jq '.status = "applied"' "$WORK_DIR/meta.json" | \
    aws s3 cp - "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" \
      --region "$AWS_REGION" --content-type "application/json"

  # Build notification message
  local NOTIFY_MSG="Report ${REPORT_ID:0:8}... — changes committed"
  if [ "$BACKEND_CHANGED" = "true" ]; then
    NOTIFY_MSG+=" and backend deployed"
  fi
  if [ "$IOS_CHANGED" = "true" ]; then
    NOTIFY_MSG+=". Deploying to TestFlight..."
    send_pushover_message "Changes Applied" "$NOTIFY_MSG" 0
    deploy_testflight
  else
    send_pushover_message "Changes Applied" "$NOTIFY_MSG" 0
  fi

  log "  Recommendations applied and committed for report $REPORT_ID"

  rm -rf "$WORK_DIR"
}

# ── Re-run with Context (from report page re-run request) ──

rerun_with_context() {
  local REPORT_ID="$1"
  local CONTEXT="$2"

  log "  Processing re-run request for report $REPORT_ID..."

  # Download meta.json to get original session path
  local WORK_DIR
  WORK_DIR=$(mktemp -d)
  aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" "$WORK_DIR/meta.json" --region "$AWS_REGION"

  local SESSION_PATH
  SESSION_PATH=$(jq -r '.sessionPath' "$WORK_DIR/meta.json")

  # Save context for injection into Claude prompt on next process_session run
  local CONTEXT_FILE="/tmp/certmate_rerun_context_$(echo "$SESSION_PATH" | tr '/' '_').txt"
  echo "$CONTEXT" > "$CONTEXT_FILE"

  # Remove from correct processed list based on report type
  local REPORT_TYPE
  REPORT_TYPE=$(jq -r '.type // "session"' "$WORK_DIR/meta.json")

  if [ "$REPORT_TYPE" = "debug_report" ]; then
    jq --arg s "$SESSION_PATH" '.processed_debug_reports -= [$s]' "$STATE_FILE" > "${STATE_FILE}.tmp" \
      && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  else
    jq --arg s "$SESSION_PATH" '.processed_sessions -= [$s]' "$STATE_FILE" > "${STATE_FILE}.tmp" \
      && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi

  # Update old report status
  jq '.status = "rerun_requested"' "$WORK_DIR/meta.json" | \
    aws s3 cp - "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" \
      --region "$AWS_REGION" --content-type "application/json"

  log "  Re-run queued for $SESSION_PATH with context: ${CONTEXT:0:100}..."

  rm -rf "$WORK_DIR"
  # Session will be re-processed on next poll cycle with context injected
}

# ── Main Loop ──

# ── Feedback Processing (revert + re-run) ──

process_feedback() {
  local SESSION_PATH="$1"
  local FEEDBACK_JSON="$2"

  log "  Processing user feedback for: $SESSION_PATH"

  # 1. Read the change_report.json for original commit hashes
  local CHANGE_REPORT
  CHANGE_REPORT=$(aws s3 cp "s3://${BUCKET}/${SESSION_PATH}/change_report.json" - --region "$AWS_REGION" 2>/dev/null || echo '{}')

  local IOS_COMMIT_TO_REVERT
  IOS_COMMIT_TO_REVERT=$(echo "$CHANGE_REPORT" | jq -r '.ios_commit // empty')
  local BACKEND_COMMIT_TO_REVERT
  BACKEND_COMMIT_TO_REVERT=$(echo "$CHANGE_REPORT" | jq -r '.backend_commit // empty')
  local BACKEND_WAS_DEPLOYED
  BACKEND_WAS_DEPLOYED=$(echo "$CHANGE_REPORT" | jq -r '.backend_deployed // false')

  # 2. Revert original commits
  if [ -n "$IOS_COMMIT_TO_REVERT" ]; then
    log "  Reverting iOS commit: $IOS_COMMIT_TO_REVERT"
    cd "$IOS_DIR"
    git revert --no-edit "$IOS_COMMIT_TO_REVERT" 2>&1 | tee -a "$LOG_FILE" || {
      log "  WARNING: iOS revert failed — may need manual intervention"
    }
    cd "$CODEBASE"
  fi

  if [ -n "$BACKEND_COMMIT_TO_REVERT" ]; then
    log "  Reverting backend commit: $BACKEND_COMMIT_TO_REVERT"
    cd "$BACKEND_DIR"
    git revert --no-edit "$BACKEND_COMMIT_TO_REVERT" 2>&1 | tee -a "$LOG_FILE" || {
      log "  WARNING: Backend revert failed — may need manual intervention"
    }
    cd "$CODEBASE"

    # Re-deploy backend with the revert
    if [ "$BACKEND_WAS_DEPLOYED" = "true" ]; then
      log "  Re-deploying backend after revert..."
      deploy_backend
    fi
  fi

  # 3. Remove old optimization artifacts from S3
  aws s3 rm "s3://${BUCKET}/${SESSION_PATH}/optimization_report.json" --region "$AWS_REGION" 2>/dev/null || true
  aws s3 rm "s3://${BUCKET}/${SESSION_PATH}/optimization_report.md" --region "$AWS_REGION" 2>/dev/null || true
  aws s3 rm "s3://${BUCKET}/${SESSION_PATH}/change_report.json" --region "$AWS_REGION" 2>/dev/null || true
  aws s3 rm "s3://${BUCKET}/${SESSION_PATH}/change_report.md" --region "$AWS_REGION" 2>/dev/null || true

  # 4. Remove session from processed list so it gets re-processed
  jq --arg s "$SESSION_PATH" '.processed_sessions = [.processed_sessions[] | select(. != $s)]' \
    "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

  # 5. Save feedback context for injection into the next process_session run
  echo "$FEEDBACK_JSON" > "/tmp/certmate_feedback_${SESSION_PATH//\//_}.json"

  log "  Revert complete. Session will be re-processed on next poll cycle with feedback context."
  notify "Feedback received — reverting" "Reverting previous changes and re-running optimizer with your corrections." 0
}

HEARTBEAT_COUNTER=0
HEARTBEAT_INTERVAL=15  # Log heartbeat every 15 cycles (~30 min)

log "Session optimizer (v3) started. Polling every ${POLL_INTERVAL}s."

while true; do

  # ── Periodic heartbeat so the log shows the optimizer is alive ──
  HEARTBEAT_COUNTER=$((HEARTBEAT_COUNTER + 1))
  if [ "$HEARTBEAT_COUNTER" -ge "$HEARTBEAT_INTERVAL" ]; then
    PROCESSED_COUNT=$(jq '.processed_sessions | length' "$STATE_FILE" 2>/dev/null || echo "?")
    log "Heartbeat: alive, ${PROCESSED_COUNT} sessions processed. Waiting for new uploads."
    HEARTBEAT_COUNTER=0
  fi

  # ── Poll for new session analytics ──

  SESSIONS=$(aws s3 ls "s3://${BUCKET}/${SESSION_PREFIX}" --recursive --region "$AWS_REGION" 2>/dev/null \
    | grep 'manifest.json' \
    | awk '{print $4}' || true)

  for MANIFEST_KEY in $SESSIONS; do
    SESSION_PATH="${MANIFEST_KEY%/manifest.json}"

    # Skip if already processed
    if jq -e ".processed_sessions | index(\"$SESSION_PATH\")" "$STATE_FILE" > /dev/null 2>&1; then
      continue
    fi

    # Skip if optimization report already exists
    if aws s3 ls "s3://${BUCKET}/${SESSION_PATH}/optimization_report.json" --region "$AWS_REGION" > /dev/null 2>&1; then
      jq ".processed_sessions += [\"$SESSION_PATH\"]" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      continue
    fi

    # Grace period: give 2.5 min for all files to finish uploading before processing
    FIRST_SEEN=$(jq -r ".first_seen.\"${SESSION_PATH}\" // empty" "$STATE_FILE" 2>/dev/null || true)
    NOW_GRACE=$(date +%s)

    if [ -z "$FIRST_SEEN" ]; then
      # First discovery of this session — record timestamp, skip this cycle
      log "New session discovered: $SESSION_PATH — starting 150s grace period"
      jq ".first_seen.\"${SESSION_PATH}\" = ${NOW_GRACE}" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      continue
    fi

    GRACE_ELAPSED=$((NOW_GRACE - FIRST_SEEN))
    if [ "$GRACE_ELAPSED" -lt 150 ]; then
      log "Grace period: waiting for files to finish uploading ($SESSION_PATH, ${GRACE_ELAPSED}s/150s)"
      continue
    fi

    log "New session analytics: $SESSION_PATH"

    # Download session files
    WORK_DIR=$(mktemp -d)
    SESSION_LOCAL="$WORK_DIR/session"
    DEBUG_REPORTS_LOCAL="$WORK_DIR/debug_reports"
    mkdir -p "$SESSION_LOCAL" "$DEBUG_REPORTS_LOCAL"

    aws s3 cp "s3://${BUCKET}/${SESSION_PATH}/manifest.json" "$SESSION_LOCAL/manifest.json" --region "$AWS_REGION"
    aws s3 cp "s3://${BUCKET}/${SESSION_PATH}/debug_log.jsonl" "$SESSION_LOCAL/debug_log.jsonl" --region "$AWS_REGION" 2>/dev/null || true
    aws s3 cp "s3://${BUCKET}/${SESSION_PATH}/field_sources.json" "$SESSION_LOCAL/field_sources.json" --region "$AWS_REGION" 2>/dev/null || true
    aws s3 cp "s3://${BUCKET}/${SESSION_PATH}/job_snapshot.json" "$SESSION_LOCAL/job_snapshot.json" --region "$AWS_REGION" 2>/dev/null || true
    aws s3 cp "s3://${BUCKET}/${SESSION_PATH}/cost_summary.json" "$SESSION_LOCAL/cost_summary.json" --region "$AWS_REGION" 2>/dev/null || true

    if [ ! -f "$SESSION_LOCAL/debug_log.jsonl" ]; then
      # Staleness check: don't permanently skip — allow retries until 1 hour has passed
      FIRST_SEEN=$(jq -r ".first_seen.\"${SESSION_PATH}\" // empty" "$STATE_FILE" 2>/dev/null || true)
      NOW=$(date +%s)

      if [ -z "$FIRST_SEEN" ]; then
        # First time seeing this session without debug_log — record timestamp and retry next cycle
        log "  No debug_log.jsonl — recording first_seen, will retry next cycle"
        jq ".first_seen.\"${SESSION_PATH}\" = ${NOW}" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      elif [ $((NOW - FIRST_SEEN)) -ge 3600 ]; then
        # Over 1 hour old — debug_log never arrived
        # Try fallback analysis if manifest.json and job_snapshot.json exist
        if [ -f "$SESSION_LOCAL/manifest.json" ] && [ -f "$SESSION_LOCAL/job_snapshot.json" ]; then
          log "  No debug_log.jsonl after 1+ hour — running fallback analysis with manifest + job_snapshot"
          if process_session_fallback "$SESSION_LOCAL" "$SESSION_PATH"; then
            log "  Fallback analysis succeeded for $SESSION_PATH"
            jq ".processed_sessions += [\"${SESSION_PATH}\"] | del(.first_seen.\"${SESSION_PATH}\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
              && mv "${STATE_FILE}.tmp" "$STATE_FILE"
          else
            log "  Fallback analysis failed for $SESSION_PATH — marking as processed anyway"
            notify "Session Skipped" "Session ${SESSION_PATH} — fallback analysis failed (no debug_log.jsonl)" 0
            jq ".processed_sessions += [\"${SESSION_PATH}\"] | del(.first_seen.\"${SESSION_PATH}\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
              && mv "${STATE_FILE}.tmp" "$STATE_FILE"
          fi
        else
          log "  SKIP: No debug_log.jsonl after 1+ hour and missing manifest/job_snapshot — marking as processed"
          notify "Session Skipped" "Session ${SESSION_PATH} skipped — no debug_log.jsonl or job_snapshot after 1+ hour" 0
          jq ".processed_sessions += [\"${SESSION_PATH}\"] | del(.first_seen.\"${SESSION_PATH}\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
            && mv "${STATE_FILE}.tmp" "$STATE_FILE"
        fi
      else
        ELAPSED=$((NOW - FIRST_SEEN))
        log "  No debug_log.jsonl — waiting (first seen ${ELAPSED}s ago, will skip after 3600s)"
      fi
      rm -rf "$WORK_DIR"
      continue
    fi

    # Look for matching debug reports (same userId)
    # SESSION_PATH is like: session-analytics/{userId}/{sessionId}
    SESSION_USER_ID=$(echo "$SESSION_PATH" | cut -d'/' -f2)
    if [ -n "$SESSION_USER_ID" ]; then
      # Download any unprocessed debug reports for this user that have ready_for_optimizer.json
      DEBUG_KEYS=$(aws s3 ls "s3://${BUCKET}/${DEBUG_PREFIX}${SESSION_USER_ID}/" --recursive --region "$AWS_REGION" 2>/dev/null \
        | grep 'ready_for_optimizer.json' \
        | awk '{print $4}' || true)

      for READY_KEY in $DEBUG_KEYS; do
        DR_PATH="${READY_KEY%/ready_for_optimizer.json}"
        # Skip if already processed (prevents duplicate attachments)
        if jq -e ".processed_debug_reports | index(\"$DR_PATH\")" "$STATE_FILE" > /dev/null 2>&1; then
          continue
        fi
        # Download the debug report
        aws s3 cp "s3://${BUCKET}/${DR_PATH}/debug_report.json" "$DEBUG_REPORTS_LOCAL/$(basename "$DR_PATH").json" --region "$AWS_REGION" 2>/dev/null || true
        aws s3 cp "s3://${BUCKET}/${DR_PATH}/context.json" "$DEBUG_REPORTS_LOCAL/$(basename "$DR_PATH")_context.json" --region "$AWS_REGION" 2>/dev/null || true
        log "  Attached debug report: $DR_PATH"

        # Mark this debug report as processed (it's being handled with this session)
        jq ".processed_debug_reports += [\"$DR_PATH\"]" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      done
    fi

    # Process the session (with any matching debug reports)
    if process_session "$SESSION_LOCAL" "$SESSION_PATH" "$DEBUG_REPORTS_LOCAL"; then
      log "  Done: $SESSION_PATH"
      jq ".processed_sessions += [\"$SESSION_PATH\"] | del(.retry_counts.\"$SESSION_PATH\") | del(.first_seen.\"$SESSION_PATH\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
    else
      # Track retry count — give up after 5 attempts
      RETRY_COUNT=$(jq -r ".retry_counts.\"$SESSION_PATH\" // 0" "$STATE_FILE" 2>/dev/null || echo 0)
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ "$RETRY_COUNT" -ge 5 ]; then
        log "  FAILED: $SESSION_PATH (giving up after $RETRY_COUNT attempts)"
        jq ".processed_sessions += [\"$SESSION_PATH\"] | del(.retry_counts.\"$SESSION_PATH\") | del(.first_seen.\"$SESSION_PATH\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      else
        log "  FAILED: $SESSION_PATH (attempt $RETRY_COUNT/5, will retry next cycle)"
        jq ".retry_counts.\"$SESSION_PATH\" = $RETRY_COUNT" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      fi
    fi

    rm -rf "$WORK_DIR"
  done

  # ── Poll for standalone debug reports (not matched to a session) ──

  DEBUG_REPORTS=$(aws s3 ls "s3://${BUCKET}/${DEBUG_PREFIX}" --recursive --region "$AWS_REGION" 2>/dev/null \
    | grep 'ready_for_optimizer.json' \
    | awk '{print $4}' || true)

  for READY_KEY in $DEBUG_REPORTS; do
    DR_PATH="${READY_KEY%/ready_for_optimizer.json}"

    # Skip if already processed
    if jq -e ".processed_debug_reports | index(\"$DR_PATH\")" "$STATE_FILE" > /dev/null 2>&1; then
      continue
    fi

    log "New standalone debug report: $DR_PATH"

    WORK_DIR=$(mktemp -d)
    DR_LOCAL="$WORK_DIR/report"
    mkdir -p "$DR_LOCAL"

    aws s3 cp "s3://${BUCKET}/${DR_PATH}/debug_report.json" "$DR_LOCAL/debug_report.json" --region "$AWS_REGION"
    aws s3 cp "s3://${BUCKET}/${DR_PATH}/context.json" "$DR_LOCAL/context.json" --region "$AWS_REGION" 2>/dev/null || true

    if process_standalone_debug_report "$DR_LOCAL" "$DR_PATH"; then
      log "  Done: $DR_PATH"
      jq ".processed_debug_reports += [\"$DR_PATH\"] | del(.retry_counts.\"$DR_PATH\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
    else
      # Track retry count — give up after 5 attempts
      DR_RETRY_COUNT=$(jq -r ".retry_counts.\"$DR_PATH\" // 0" "$STATE_FILE" 2>/dev/null || echo 0)
      DR_RETRY_COUNT=$((DR_RETRY_COUNT + 1))
      if [ "$DR_RETRY_COUNT" -ge 5 ]; then
        log "  FAILED: $DR_PATH (giving up after $DR_RETRY_COUNT attempts)"
        jq ".processed_debug_reports += [\"$DR_PATH\"] | del(.retry_counts.\"$DR_PATH\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      else
        log "  FAILED: $DR_PATH (attempt $DR_RETRY_COUNT/5, will retry next cycle)"
        jq ".retry_counts.\"$DR_PATH\" = $DR_RETRY_COUNT" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      fi
    fi

    rm -rf "$WORK_DIR"
  done

  # ── Poll for user feedback on already-processed sessions ──

  FEEDBACK_FILES=$(aws s3 ls "s3://${BUCKET}/${SESSION_PREFIX}" --recursive --region "$AWS_REGION" 2>/dev/null \
    | grep 'user_feedback.json' \
    | awk '{print $4}' || true)

  for FEEDBACK_KEY in $FEEDBACK_FILES; do
    FEEDBACK_SESSION_PATH="${FEEDBACK_KEY%/user_feedback.json}"

    # Only process if this session was already processed (feedback on a completed run)
    if ! jq -e ".processed_sessions | index(\"$FEEDBACK_SESSION_PATH\")" "$STATE_FILE" > /dev/null 2>&1; then
      continue
    fi

    # Check if we already processed this feedback (compare timestamp of newest entry)
    FEEDBACK_CONTENT=$(aws s3 cp "s3://${BUCKET}/${FEEDBACK_KEY}" - --region "$AWS_REGION" 2>/dev/null || echo '[]')
    LATEST_TS=$(echo "$FEEDBACK_CONTENT" | jq -r '.[-1].timestamp // ""' 2>/dev/null || echo "")

    # Track processed feedback timestamps in state
    PROCESSED_TS=$(jq -r --arg s "$FEEDBACK_SESSION_PATH" '.processed_feedback[$s] // ""' "$STATE_FILE" 2>/dev/null || echo "")

    if [ "$LATEST_TS" = "$PROCESSED_TS" ] || [ -z "$LATEST_TS" ]; then
      continue
    fi

    log "New user feedback for: $FEEDBACK_SESSION_PATH (latest: $LATEST_TS)"

    # Process the feedback (revert + mark for re-run)
    process_feedback "$FEEDBACK_SESSION_PATH" "$FEEDBACK_CONTENT"

    # Record that we've processed this feedback timestamp
    jq --arg s "$FEEDBACK_SESSION_PATH" --arg ts "$LATEST_TS" \
      '.processed_feedback[$s] = $ts' "$STATE_FILE" > "${STATE_FILE}.tmp" \
      && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  done

  # ── Poll for optimizer commands (accept/rerun from report page) ──

  REPORT_COMMANDS=$(aws s3 ls "s3://${BUCKET}/optimizer-reports/" --recursive --region "$AWS_REGION" 2>/dev/null \
    | grep -E '(accept_command|rerun_command|reject_command)\.json' \
    | awk '{print $4}' || true)

  for CMD_KEY in $REPORT_COMMANDS; do
    # Extract report ID from path: optimizer-reports/{reportId}/accept_command.json
    REPORT_ID=$(echo "$CMD_KEY" | sed 's|optimizer-reports/||;s|/[^/]*$||')
    CMD_TYPE=$(basename "$CMD_KEY" .json)  # accept_command or rerun_command

    CMD_WORK_DIR=$(mktemp -d)
    aws s3 cp "s3://${BUCKET}/${CMD_KEY}" "$CMD_WORK_DIR/command.json" --region "$AWS_REGION"

    if [ "$CMD_TYPE" = "accept_command" ]; then
      ACCEPTED=$(jq -c '.accepted' "$CMD_WORK_DIR/command.json")
      log "  Applying accepted recommendations for report $REPORT_ID: $ACCEPTED"
      apply_accepted_recommendations "$REPORT_ID" "$ACCEPTED"
    elif [ "$CMD_TYPE" = "rerun_command" ]; then
      CONTEXT=$(jq -r '.context' "$CMD_WORK_DIR/command.json")
      log "  Re-running analysis for report $REPORT_ID with context"
      rerun_with_context "$REPORT_ID" "$CONTEXT"
    elif [ "$CMD_TYPE" = "reject_command" ]; then
      log "  Recommendations rejected for report $REPORT_ID"
      # Update meta.json status to rejected
      REJECT_META=$(mktemp)
      aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" "$REJECT_META" --region "$AWS_REGION" 2>/dev/null || true
      if [ -s "$REJECT_META" ]; then
        jq '.status = "rejected"' "$REJECT_META" | \
          aws s3 cp - "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" \
            --region "$AWS_REGION" --content-type "application/json"
      fi
      rm -f "$REJECT_META"
    fi

    # Delete the command file after processing
    aws s3 rm "s3://${BUCKET}/${CMD_KEY}" --region "$AWS_REGION"

    rm -rf "$CMD_WORK_DIR"
  done

  # ── Missed sessions audit: catch any sessions that slipped through all tracking ──
  # List S3 sessions from last 24h, compare against state file, find gaps
  AUDIT_CUTOFF=$(date -v-24H +%Y-%m-%d 2>/dev/null || date -d '24 hours ago' +%Y-%m-%d 2>/dev/null || true)

  if [ -n "$AUDIT_CUTOFF" ]; then
    AUDIT_SESSIONS=$(aws s3 ls "s3://${BUCKET}/${SESSION_PREFIX}" --recursive --region "$AWS_REGION" 2>/dev/null \
      | grep 'manifest.json' \
      | awk -v cutoff="$AUDIT_CUTOFF" '$1 >= cutoff {print $4}' || true)

    MISSED_COUNT=0
    for AUDIT_MANIFEST in $AUDIT_SESSIONS; do
      AUDIT_PATH="${AUDIT_MANIFEST%/manifest.json}"

      # Skip if already processed
      if jq -e ".processed_sessions | index(\"$AUDIT_PATH\")" "$STATE_FILE" > /dev/null 2>&1; then
        continue
      fi

      # Skip if currently being tracked (grace period or staleness wait)
      if jq -e ".first_seen.\"${AUDIT_PATH}\"" "$STATE_FILE" > /dev/null 2>&1; then
        continue
      fi

      # Skip if in retry queue
      if jq -e ".retry_counts.\"${AUDIT_PATH}\"" "$STATE_FILE" > /dev/null 2>&1; then
        continue
      fi

      # Check if optimization_report.json already exists on S3
      if aws s3 ls "s3://${BUCKET}/${AUDIT_PATH}/optimization_report.json" --region "$AWS_REGION" > /dev/null 2>&1; then
        # Report exists but session not in processed list — fix state
        log "AUDIT: Session $AUDIT_PATH has report but was not in processed list — adding"
        jq ".processed_sessions += [\"$AUDIT_PATH\"]" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
        continue
      fi

      # Truly missed — no report, not tracked anywhere
      MISSED_COUNT=$((MISSED_COUNT + 1))
      log "AUDIT WARNING: Missed session detected — $AUDIT_PATH (not processed, no report, not tracked)"

      # Add to first_seen so the normal pipeline picks it up next cycle
      NOW_AUDIT=$(date +%s)
      jq ".first_seen.\"${AUDIT_PATH}\" = ${NOW_AUDIT}" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
    done

    if [ "$MISSED_COUNT" -gt 0 ]; then
      log "AUDIT: Found $MISSED_COUNT missed session(s) — added to tracking for next cycle"
      notify "Missed Sessions Detected" "$MISSED_COUNT session(s) from last 24h were not tracked — now queued for processing" 0
    fi
  fi

  sleep "$POLL_INTERVAL"
done
