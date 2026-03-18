#!/bin/bash
# CertMate Debug Report Watcher
# Polls S3 for new debug reports, logs them, notifies Derek, and signals
# the session optimizer to pick them up on its next pass.
#
# NO auto-fixing — all code changes are handled by the session optimizer
# with proper git tracking and rollback support.
#
# Install:
#   cp scripts/com.certmate.debug-watcher.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.certmate.debug-watcher.plist
#
# Logs:
#   tail -f ~/.certmate/debug_watcher.log

set -euo pipefail

BUCKET="eicr-files-production"
PREFIX="debug-reports/"
STATE_FILE="$HOME/.certmate/debug_watcher_state.json"
LOG_FILE="$HOME/.certmate/debug_watcher.log"
POLL_INTERVAL=60

# Pushover notifications
PUSHOVER_USER="uexvmxgxpccjgvjzjk2qnqrnyrncgb"
PUSHOVER_TOKEN="adcgd8wx7t6ct7fhz9dyeyt1ne3gcn"

mkdir -p "$(dirname "$STATE_FILE")"

if [ ! -f "$STATE_FILE" ]; then
  echo '{"processed": []}' > "$STATE_FILE"
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

notify_derek() {
  local TITLE="$1"
  local MESSAGE="$2"
  local FEEDBACK_URL="${3:-}"

  # macOS notification
  local SAFE_TITLE="${TITLE//\"/\\\"}"
  local SAFE_MESSAGE="${MESSAGE//\"/\\\"}"
  osascript -e "display notification \"$SAFE_MESSAGE\" with title \"CertMate\" subtitle \"$SAFE_TITLE\"" 2>/dev/null || true

  # Pushover (phone notification)
  local CURL_ARGS=(
    -s -X POST https://api.pushover.net/1/messages.json
    -d "token=$PUSHOVER_TOKEN"
    -d "user=$PUSHOVER_USER"
    --data-urlencode "title=CertMate: $TITLE"
    --data-urlencode "message=$MESSAGE"
    -d "priority=0"
  )

  if [ -n "$FEEDBACK_URL" ]; then
    CURL_ARGS+=(--data-urlencode "url=$FEEDBACK_URL")
    CURL_ARGS+=(--data-urlencode "url_title=View Report")
  fi

  curl "${CURL_ARGS[@]}" > /dev/null 2>&1 || true

  log "  Notification: $TITLE"
}

# ── Main Loop ──

log "Debug report watcher started. Polling every ${POLL_INTERVAL}s."

while true; do
  # List all debug_report.json files in S3
  REPORTS=$(aws s3 ls "s3://${BUCKET}/${PREFIX}" --recursive --region eu-west-2 2>/dev/null \
    | grep 'debug_report.json' \
    | awk '{print $4}' || true)

  for REPORT_KEY in $REPORTS; do
    # Extract the report directory (everything before /debug_report.json)
    REPORT_ID="${REPORT_KEY%/debug_report.json}"

    # Skip if already processed
    if jq -e ".processed | index(\"$REPORT_ID\")" "$STATE_FILE" > /dev/null 2>&1; then
      continue
    fi

    log "New debug report: $REPORT_KEY"

    # Download report to read metadata
    WORK_DIR=$(mktemp -d)
    REPORT_LOCAL="$WORK_DIR/report"
    mkdir -p "$REPORT_LOCAL"

    aws s3 cp "s3://${BUCKET}/${REPORT_ID}/debug_report.json" "$REPORT_LOCAL/debug_report.json" --region eu-west-2

    # Read report fields
    SEVERITY=$(jq -r '.severity // "unknown"' "$REPORT_LOCAL/debug_report.json")
    TIER=$(jq -r '.tier // "unknown"' "$REPORT_LOCAL/debug_report.json")
    TITLE=$(jq -r '.title // "Untitled bug"' "$REPORT_LOCAL/debug_report.json")
    DESCRIPTION=$(jq -r '.description // .issue_text // ""' "$REPORT_LOCAL/debug_report.json" | head -c 400)

    log "  Title: $TITLE | Severity: $SEVERITY | Tier: $TIER"

    # Download context.json if available (contains sessionId for feedback link)
    SESSION_ID=""
    if aws s3 cp "s3://${BUCKET}/${REPORT_ID}/context.json" "$REPORT_LOCAL/context.json" --region eu-west-2 2>/dev/null; then
      SESSION_ID=$(jq -r '.sessionId // ""' "$REPORT_LOCAL/context.json")
    fi

    # Upload ready_for_optimizer.json marker so the session optimizer picks this up
    echo "{\"report_id\":\"$REPORT_ID\",\"title\":\"$TITLE\",\"severity\":\"$SEVERITY\",\"tier\":\"$TIER\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
      | aws s3 cp - "s3://${BUCKET}/${REPORT_ID}/ready_for_optimizer.json" --region eu-west-2

    # No immediate Pushover — the session optimizer will include this debug report
    # in the full job analysis and send a proper report URL when ready.
    log "  Queued for optimizer (no immediate notification)"

    # Mark as processed
    jq ".processed += [\"$REPORT_ID\"]" "$STATE_FILE" > "${STATE_FILE}.tmp" \
      && mv "${STATE_FILE}.tmp" "$STATE_FILE"

    # Clean up temp files
    rm -rf "$WORK_DIR"
    log "  Done: $REPORT_ID — queued for optimizer"
  done

  sleep "$POLL_INTERVAL"
done
