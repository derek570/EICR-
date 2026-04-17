#!/bin/bash
# CertMate Session Optimizer (v4 - plan-only mode)
# Polls S3 for session analytics AND debug reports. Pre-processes with
# analyze-session.js, invokes Claude Code in READ-ONLY mode to generate
# structured JSON recommendations. Builds HTML report, uploads to S3,
# sends Pushover URL.
#
# On accept, the optimizer writes a structured implementation plan
# (markdown) to ~/Developer/EICR_Automation/.optimizer-plans/ and notifies
# the user with a ready-to-paste `claude` command. It NEVER edits source
# files, commits, pushes, deploys to ECS, or uploads to TestFlight. All
# implementation happens in a fresh Claude Code session started by the
# user, reviewed in plan mode before any changes hit disk.
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
SCRIPTS_DIR="$CODEBASE/scripts"
IOS_DIR="$CODEBASE/CertMateUnified"
BACKEND_DIR="$CODEBASE"
PLANS_DIR="$CODEBASE/.optimizer-plans"
CLAUDE="$(command -v claude)"

# AWS region (S3 only - optimizer no longer deploys)
AWS_REGION="eu-west-2"

mkdir -p "$PLANS_DIR"

# Verify required tools are available
for cmd in node aws jq git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found in PATH ($PATH)" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$STATE_FILE")"

# Log rotation: rotate when > 10 MB
LOG_MAX_BYTES=10485760
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt "$LOG_MAX_BYTES" ]; then
    mv "$LOG_FILE" "${LOG_FILE}.1"
    : > "$LOG_FILE"
  fi
fi

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

# Migrate state file: add sweep timestamps if missing
if ! jq -e '.last_plan_sweep' "$STATE_FILE" > /dev/null 2>&1; then
  jq '. + {last_plan_sweep: 0}' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi
if ! jq -e '.last_weekly_summary' "$STATE_FILE" > /dev/null 2>&1; then
  jq '. + {last_weekly_summary: 0}' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# ── safe_hash ──
# Produce a short hex hash from stdin. Tries md5 (BSD/macOS at /sbin/md5),
# md5sum (GNU), then shasum as final fallback. Guarantees a non-empty line
# of output even if everything fails — important because this is used inside
# command substitutions under `set -euo pipefail`, where a failing pipeline
# would otherwise abort the entire script (this was the 2026-04-17 crash-loop
# cause: LaunchAgent PATH lacked /sbin, so md5 + md5sum both failed and the
# optimizer died inside send_pushover → restarted by KeepAlive → looped).
safe_hash() {
  local out=""
  if command -v md5 >/dev/null 2>&1; then
    out=$(md5 2>/dev/null || true)
  elif [ -x /sbin/md5 ]; then
    out=$(/sbin/md5 2>/dev/null || true)
  elif command -v md5sum >/dev/null 2>&1; then
    out=$(md5sum 2>/dev/null | cut -d' ' -f1 || true)
  elif command -v shasum >/dev/null 2>&1; then
    out=$(shasum 2>/dev/null | cut -d' ' -f1 || true)
  fi
  # BSD md5 prints just the hash; shasum/md5sum handled above. Strip any trailing
  # whitespace and guarantee non-empty output (fallback to epoch-seconds so dedup
  # still works per-call, just without cross-call dedup).
  out="${out//[[:space:]]/}"
  if [ -z "$out" ]; then
    out="nohash-$(date +%s)-$$"
  fi
  printf '%s\n' "$out"
}

# ── Poison session fingerprints ──
# When a session fails twice we write a marker to S3 so it's skipped even after
# a state-file reset. Without this, wiping optimizer_state.json would re-queue
# every known-bad session and re-exhaust their retries.

is_poison_session() {
  # Args: SESSION_PATH (e.g. session-analytics/USER/SESSION) or debug-reports/...
  local SP="$1"
  local BASENAME
  BASENAME=$(echo "$SP" | tr '/' '_')
  aws s3 ls "s3://${BUCKET}/optimizer-reports/poison/${BASENAME}.json" \
    --region "$AWS_REGION" > /dev/null 2>&1
}

sweep_old_plans() {
  # Archive plan files older than 30 days to $PLANS_DIR/archive/. Runs at most
  # once per 24 hours (tracked via state.last_plan_sweep). Safe to call every
  # poll — it'll no-op if not due.
  local NOW LAST_SWEEP ELAPSED
  NOW=$(date +%s)
  LAST_SWEEP=$(jq -r '.last_plan_sweep // 0' "$STATE_FILE" 2>/dev/null || echo 0)
  ELAPSED=$((NOW - LAST_SWEEP))
  if [ "$ELAPSED" -lt 86400 ]; then
    return 0
  fi

  local ARCHIVE_DIR="$PLANS_DIR/archive"
  mkdir -p "$ARCHIVE_DIR"
  local MOVED=0
  # find -mtime +30 matches files older than 30 days
  while IFS= read -r -d '' PLAN; do
    mv "$PLAN" "$ARCHIVE_DIR/" 2>/dev/null && MOVED=$((MOVED + 1))
  done < <(find "$PLANS_DIR" -maxdepth 1 -type f -name 'plan-*.md' -mtime +30 -print0 2>/dev/null)

  if [ "$MOVED" -gt 0 ]; then
    log "Plan sweep: archived $MOVED plan file(s) older than 30 days → $ARCHIVE_DIR"
  fi
  jq --arg ts "$NOW" '.last_plan_sweep = ($ts|tonumber)' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

send_weekly_summary() {
  # Once every 7 days, post a single Pushover summary of optimizer activity.
  # Tracked via state.last_weekly_summary. Safe to call on every poll — no-ops
  # if not due. Dedup key is the ISO week so a crash/restart doesn't double-post.
  local NOW LAST_SUMMARY ELAPSED
  NOW=$(date +%s)
  LAST_SUMMARY=$(jq -r '.last_weekly_summary // 0' "$STATE_FILE" 2>/dev/null || echo 0)
  ELAPSED=$((NOW - LAST_SUMMARY))
  # 604800s = 7 days
  if [ "$ELAPSED" -lt 604800 ]; then
    return 0
  fi

  log "Weekly summary: due (${ELAPSED}s since last). Aggregating..."

  # Totals from state file (lifetime counts — cheap).
  local SESSIONS_TOTAL DRS_TOTAL RETRY_PENDING GRACE_PENDING
  SESSIONS_TOTAL=$(jq -r '.processed_sessions | length' "$STATE_FILE" 2>/dev/null || echo 0)
  DRS_TOTAL=$(jq -r '.processed_debug_reports | length' "$STATE_FILE" 2>/dev/null || echo 0)
  RETRY_PENDING=$(jq -r '.retry_counts | length' "$STATE_FILE" 2>/dev/null || echo 0)
  GRACE_PENDING=$(jq -r '.first_seen | length' "$STATE_FILE" 2>/dev/null || echo 0)

  # Active report count — reports produced in last 7 days on S3. Uses last-modified
  # timestamp from aws s3 ls. Catch failures gracefully; summary should never block.
  local WEEK_AGO_EPOCH REPORTS_WEEK
  WEEK_AGO_EPOCH=$((NOW - 604800))
  REPORTS_WEEK=$(
    { aws s3 ls "s3://${BUCKET}/optimizer-reports/" --region "$AWS_REGION" 2>/dev/null || true; } \
    | awk -v cutoff="$WEEK_AGO_EPOCH" '
        /PRE / {
          cmd = "date -j -f \"%Y-%m-%d %H:%M:%S\" \"" $1 " " $2 "\" +%s 2>/dev/null"
          cmd | getline ts
          close(cmd)
          if (ts+0 >= cutoff) count++
        }
        END { print count+0 }
      '
  )

  local POISON_COUNT
  POISON_COUNT=$({ aws s3 ls "s3://${BUCKET}/optimizer-reports/poison/" --region "$AWS_REGION" 2>/dev/null || true; } | wc -l | tr -d ' ')

  # Plan files on disk (active + archived).
  local PLANS_ACTIVE PLANS_ARCHIVED
  PLANS_ACTIVE=$(find "$PLANS_DIR" -maxdepth 1 -type f -name 'plan-*.md' 2>/dev/null | wc -l | tr -d ' ')
  PLANS_ARCHIVED=$(find "$PLANS_DIR/archive" -maxdepth 1 -type f -name 'plan-*.md' 2>/dev/null | wc -l | tr -d ' ')

  local MSG=""
  MSG+="<b>Optimizer weekly summary</b>\n"
  MSG+="Reports this week: ${REPORTS_WEEK:-0}\n"
  MSG+="Lifetime: ${SESSIONS_TOTAL} sessions, ${DRS_TOTAL} debug reports\n"
  MSG+="Plans: ${PLANS_ACTIVE} active, ${PLANS_ARCHIVED} archived\n"
  if [ "${RETRY_PENDING:-0}" -gt 0 ] || [ "${GRACE_PENDING:-0}" -gt 0 ]; then
    MSG+="In flight: ${GRACE_PENDING} grace, ${RETRY_PENDING} retrying\n"
  fi
  if [ "${POISON_COUNT:-0}" -gt 0 ]; then
    MSG+="Poisoned (skipped): ${POISON_COUNT}\n"
  fi

  # Dedup by ISO week number so retries on the same week don't re-notify.
  local WEEK_KEY
  WEEK_KEY=$(date -u +%Y-W%V)
  send_pushover_message "Optimizer weekly summary" "$MSG" 0 "" "weekly|${WEEK_KEY}"

  jq --arg ts "$NOW" '.last_weekly_summary = ($ts|tonumber)' "$STATE_FILE" > "${STATE_FILE}.tmp" \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"

  log "Weekly summary sent."
}

mark_poison_session() {
  # Args: SESSION_PATH, REASON (short string), RETRY_COUNT
  local SP="$1"
  local REASON="${2:-unknown}"
  local RETRY_COUNT="${3:-0}"
  local BASENAME
  BASENAME=$(echo "$SP" | tr '/' '_')
  local TMP
  TMP=$(mktemp)
  jq -n \
    --arg path "$SP" \
    --arg reason "$REASON" \
    --arg retries "$RETRY_COUNT" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg host "$(hostname -s 2>/dev/null || echo unknown)" \
    '{path: $path, reason: $reason, retries: ($retries|tonumber), poisoned_at: $ts, host: $host}' > "$TMP"
  aws s3 cp "$TMP" "s3://${BUCKET}/optimizer-reports/poison/${BASENAME}.json" \
    --region "$AWS_REGION" --content-type "application/json" > /dev/null 2>&1 || true
  rm -f "$TMP"
  log "  Poison fingerprint written: s3://${BUCKET}/optimizer-reports/poison/${BASENAME}.json"
}

notify() {
  local TITLE="$1"
  local MESSAGE="$2"
  local PRIORITY="${3:-0}"  # 0=normal, 1=high (bypasses quiet hours)
  # DEDUP_KEY: optional caller-provided dedup key. Pass e.g. "sessionId|kind" to
  # dedup per-session rather than per-title. Defaults to "TITLE|MESSAGE" — risk
  # is that two genuinely different sessions share the same title+message shape
  # and the second notification is silently dropped.
  local DEDUP_KEY="${4:-${TITLE}|${MESSAGE}}"
  local SAFE_TITLE="${TITLE//\"/\\\"}"
  local SAFE_MESSAGE="${MESSAGE//\"/\\\"}"

  # ── Deduplication: skip if same dedup key was sent within last 10 minutes ──
  local DEDUP_DIR="$HOME/.certmate/pushover_dedup"
  mkdir -p "$DEDUP_DIR"
  local MSG_HASH
  MSG_HASH=$(printf '%s' "$DEDUP_KEY" | safe_hash)
  local DEDUP_FILE="$DEDUP_DIR/$MSG_HASH"
  local NOW
  NOW=$(date +%s)
  if [ -f "$DEDUP_FILE" ]; then
    local LAST_SENT
    LAST_SENT=$(cat "$DEDUP_FILE" 2>/dev/null || echo 0)
    local ELAPSED=$(( NOW - LAST_SENT ))
    if [ "$ELAPSED" -lt 600 ]; then
      log "  Notification DEDUP: Skipping '$TITLE' — same message sent ${ELAPSED}s ago (< 600s)"
      return 0
    fi
  fi
  echo "$NOW" > "$DEDUP_FILE"

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
  # Args: TITLE, MESSAGE, PRIORITY, FEEDBACK_URL (optional), DEDUP_KEY (optional)
  # DEDUP_KEY defaults to TITLE|MESSAGE. Pass "sessionId|kind" to dedup per
  # session so two similarly-worded reports for different sessions don't collide.
  local TITLE="$1"
  local MESSAGE="$2"
  local PRIORITY="${3:-0}"
  local FEEDBACK_URL="${4:-}"
  local DEDUP_KEY="${5:-${TITLE}|${MESSAGE}}"

  # ── Deduplication: skip if same dedup key was sent within last 10 minutes ──
  local DEDUP_DIR="$HOME/.certmate/pushover_dedup"
  mkdir -p "$DEDUP_DIR"
  local MSG_HASH
  MSG_HASH=$(printf '%s' "$DEDUP_KEY" | safe_hash)
  local DEDUP_FILE="$DEDUP_DIR/$MSG_HASH"
  local NOW
  NOW=$(date +%s)
  if [ -f "$DEDUP_FILE" ]; then
    local LAST_SENT
    LAST_SENT=$(cat "$DEDUP_FILE" 2>/dev/null || echo 0)
    local ELAPSED=$(( NOW - LAST_SENT ))
    if [ "$ELAPSED" -lt 600 ]; then
      log "  Pushover DEDUP: Skipping '$TITLE' — same message sent ${ELAPSED}s ago (< 600s)"
      return 0
    fi
  fi
  echo "$NOW" > "$DEDUP_FILE"
  # Clean up dedup files older than 1 hour
  find "$DEDUP_DIR" -type f -mmin +60 -delete 2>/dev/null || true

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
    FEEDBACK_URL="https://api.certmate.uk/api/feedback/$FEEDBACK_SESSION_ID"
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
    BACKEND_DEPLOY=$(echo "$OPTIMIZATION_JSON" | jq -r 'if .files_modified then [.files_modified[].file] | any(contains("src/") or contains("config/") or contains("scripts/")) else false end' 2>/dev/null || echo "false")
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

# Git/deploy helpers intentionally removed in v4.
# The optimizer no longer commits, deploys to ECS, or uploads to TestFlight.
# Accepted recommendations are written to a plan file and implemented by the
# user starting a fresh Claude Code session. See generate_implementation_plan().

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

# ── Shared Claude + S3 helpers (used by process_session + standalone debug) ──
#
# Both session analysis and standalone debug reports share the same shape:
#   1. Build a rendered prompt from a template + vars file.
#   2. Invoke Claude Code read-only with that prompt.
#   3. Parse the last JSON object out of Claude's stdout.
#   4. Upload the canonical artifacts (report.html, recommendations.json,
#      session-summary.json, meta.json, claude_output.md) to S3 under
#      optimizer-reports/<REPORT_ID>/.
#
# These helpers centralise that shared pipeline so the two callers only build
# their own context (prompt vars + session-summary + meta + pushover message)
# and don't re-implement the Claude/S3 plumbing.

# run_claude_and_parse PROMPT_FILE OUTDIR
#
# Invokes Claude Code read-only, stores raw output at $OUTDIR/claude_output.md,
# writes the parsed recommendations JSON array to $OUTDIR/recommendations.json,
# and writes REC_COUNT + SUMMARY (separated by a newline) to $OUTDIR/parse_status
# so the caller can read them back without relying on bash indirect assignment.
run_claude_and_parse() {
  local PROMPT_FILE="$1"
  local OUTDIR="$2"

  cd "$CODEBASE"
  local CLAUDE_OUTPUT
  CLAUDE_OUTPUT=$("$CLAUDE" -p "$(cat "$PROMPT_FILE")" \
    --allowedTools "Read,Glob,Grep" 2>&1) || true

  printf '%s' "$CLAUDE_OUTPUT" > "$OUTDIR/claude_output.md"

  # Parse Claude's JSON block via the dedicated Node helper
  # (parse-optimizer-output.cjs). The helper:
  #   1. Extracts the LAST ```json fenced block, or falls back to the old
  #      greedy {...} match.
  #   2. Repairs literal \n / \r / \t bytes found INSIDE string literals
  #      (the DAEF3165 failure mode where multi-line old_code snippets
  #      contained raw newlines that jq rejected).
  #   3. Fails LOUDLY on truly broken JSON — no more silent `|| echo "[]"`
  #      fallback that turns real recommendations into "no recommendations".
  #
  # On parse failure we write a $OUTDIR/parse_error marker so the caller
  # (process_session / process_standalone_debug_report) can escalate via
  # Pushover and upload the raw Claude output to S3 for post-mortem.
  local JSON_OUTPUT
  local RECOMMENDATIONS REC_COUNT SUMMARY
  if JSON_OUTPUT=$(node "$SCRIPTS_DIR/parse-optimizer-output.cjs" < "$OUTDIR/claude_output.md" 2>>"$LOG_FILE"); then
    RECOMMENDATIONS=$(echo "$JSON_OUTPUT" | jq -c '.recommendations // []' 2>/dev/null || echo "[]")
    REC_COUNT=$(echo "$RECOMMENDATIONS" | jq 'length' 2>/dev/null || echo 0)
    SUMMARY=$(echo "$JSON_OUTPUT" | jq -r '.summary // "Analysis complete"' 2>/dev/null | head -c 200 || echo "Analysis complete")
  else
    log "  PARSE ERROR: parse-optimizer-output.cjs failed — see $OUTDIR/claude_output.md"
    RECOMMENDATIONS="[]"
    REC_COUNT=0
    SUMMARY="PARSE ERROR: could not extract recommendations from Claude output"
    echo "PARSE_FAILED" > "$OUTDIR/parse_error"
  fi

  echo "$RECOMMENDATIONS" > "$OUTDIR/recommendations.json"
  printf '%s\n%s\n' "$REC_COUNT" "$SUMMARY" > "$OUTDIR/parse_status"
}

# upload_report_artifacts WORK_DIR REPORT_ID [EXTRA_FILE]
#
# Uploads the canonical set of report files to S3 under
# optimizer-reports/<REPORT_ID>/ — report.html, recommendations.json,
# session-summary.json, meta.json, and claude_output.md if present.
# Optionally uploads an EXTRA_FILE (e.g. analysis.json for full session runs).
upload_report_artifacts() {
  local WORK_DIR="$1"
  local REPORT_ID="$2"
  local EXTRA_FILE="${3:-}"

  local S3_REPORT_PREFIX="optimizer-reports/${REPORT_ID}"
  aws s3 cp "$WORK_DIR/report.html" "s3://${BUCKET}/${S3_REPORT_PREFIX}/report.html" \
    --region "$AWS_REGION" --content-type "text/html"
  aws s3 cp "$WORK_DIR/recommendations.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/recommendations.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$WORK_DIR/session-summary.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/session-summary.json" \
    --region "$AWS_REGION" --content-type "application/json"
  aws s3 cp "$WORK_DIR/meta.json" "s3://${BUCKET}/${S3_REPORT_PREFIX}/meta.json" \
    --region "$AWS_REGION" --content-type "application/json"
  if [ -n "$EXTRA_FILE" ] && [ -f "$EXTRA_FILE" ]; then
    aws s3 cp "$EXTRA_FILE" "s3://${BUCKET}/${S3_REPORT_PREFIX}/$(basename "$EXTRA_FILE")" \
      --region "$AWS_REGION" --content-type "application/json"
  fi
  if [ -f "$WORK_DIR/claude_output.md" ]; then
    aws s3 cp "$WORK_DIR/claude_output.md" "s3://${BUCKET}/${S3_REPORT_PREFIX}/claude_output.md" \
      --region "$AWS_REGION" --content-type "text/markdown"
  fi

  log "  Report uploaded: s3://${BUCKET}/${S3_REPORT_PREFIX}/"
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
  local REPORT_URL="https://api.certmate.uk/api/optimizer-report/${REPORT_ID}"
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
    "$REPORT_URL" \
    "fallback|${SESSION_ID}"

  log "  Fallback Pushover sent for report $REPORT_ID"

  rm -rf "$REPORT_WORK_DIR"
}

# ── Session Processing ──

process_session() {
  local SESSION_DIR="$1"
  local SESSION_ID="$2"
  local DEBUG_REPORTS_DIR="$3"  # Directory with downloaded debug reports (may be empty)

  # Short-session guard — skip trivial sessions without wasting a Claude call.
  # Trigger: session was a re-open/check-in (user opens the job, no dictation).
  # The 7 Maylands Way F1926EED case (6s, 0 utterances, 0 transcript) is the
  # canonical example — processing it produced a useless "no recommendations"
  # Pushover that cost ~$0.02 and added noise. If duration is very short AND
  # transcript is empty AND no debug reports are attached, mark processed
  # silently and return success.
  local HAS_DEBUG_REPORTS=0
  if [ -d "$DEBUG_REPORTS_DIR" ] && [ "$(ls -A "$DEBUG_REPORTS_DIR" 2>/dev/null)" ]; then
    HAS_DEBUG_REPORTS=1
  fi
  if [ -f "$SESSION_DIR/manifest.json" ] && [ "$HAS_DEBUG_REPORTS" -eq 0 ]; then
    local MF_DUR MF_TLEN MF_TURNS MF_REGEX MF_SONNET
    MF_DUR=$(jq -r '.durationSeconds // 0' "$SESSION_DIR/manifest.json" 2>/dev/null || echo 0)
    MF_TLEN=$(jq -r '.transcriptLength // 0' "$SESSION_DIR/manifest.json" 2>/dev/null || echo 0)
    MF_TURNS=$(jq -r '.sonnetTurns // 0' "$SESSION_DIR/manifest.json" 2>/dev/null || echo 0)
    MF_REGEX=$(jq -r '.regexFieldsSet // 0' "$SESSION_DIR/manifest.json" 2>/dev/null || echo 0)
    MF_SONNET=$(jq -r '.sonnetFieldsSet // 0' "$SESSION_DIR/manifest.json" 2>/dev/null || echo 0)
    MF_ADDR=$(jq -r '.address // "Unknown"' "$SESSION_DIR/manifest.json" 2>/dev/null || echo "Unknown")
    # Skip if EVERYTHING is minimal — duration < 30s AND no transcript AND no extraction activity.
    # If any of those signals is non-zero the user actually did something meaningful.
    if [ "$MF_DUR" -lt 30 ] && [ "$MF_TLEN" -eq 0 ] && [ "$MF_TURNS" -eq 0 ] && \
       [ "$MF_REGEX" -eq 0 ] && [ "$MF_SONNET" -eq 0 ]; then
      log "  SKIP (trivial session): $SESSION_ID — address='$MF_ADDR' dur=${MF_DUR}s, no transcript, no extraction activity"
      return 0
    fi
  fi

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

  # Compute current keyword count and estimated token usage for budget constraint.
  # We no longer pre-load full source files into the prompt — Claude fetches them
  # via Read/Glob/Grep. But the keyword budget numbers are dynamic and cheap, so
  # we still compute them here and inject them as placeholders.
  local KEYWORD_COUNT=0
  local KEYWORD_TOKENS=0
  local KEYWORD_BOOSTS_JSON=""
  if [ -f "$IOS_DIR/Resources/default_config.json" ]; then
    KEYWORD_BOOSTS_JSON=$(cat "$IOS_DIR/Resources/default_config.json" 2>/dev/null || echo "{}")
  fi
  if command -v python3 &>/dev/null && [ -n "$KEYWORD_BOOSTS_JSON" ]; then
    read KEYWORD_COUNT KEYWORD_TOKENS < <(echo "$KEYWORD_BOOSTS_JSON" | python3 -c "
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

  # Render the prompt from the template. All dynamic data goes into a JSON vars
  # file and render-prompt.js performs {{PLACEHOLDER}} substitution. This keeps
  # the massive instruction block out of this shell script and makes the prompt
  # itself diff-reviewable.
  local PROMPT_FILE VARS_FILE
  PROMPT_FILE=$(mktemp)
  VARS_FILE=$(mktemp)

  local RERUN_BLOCK=""
  if [ -n "$RERUN_CONTEXT" ]; then
    RERUN_BLOCK=$(printf '=== USER FEEDBACK FOR RE-RUN (HIGH PRIORITY) ===\nThe user reviewed the previous recommendations and provided this additional context:\n%s\nTake this feedback into account when making your recommendations.\n' "$RERUN_CONTEXT")
  fi

  jq -n \
    --arg ANALYSIS "$ANALYSIS" \
    --arg TRANSCRIPT_DATA "$TRANSCRIPT_DATA" \
    --arg SONNET_IO "$SONNET_IO" \
    --arg REGEX_DATA "$REGEX_DATA" \
    --arg SONNET_DATA "$SONNET_DATA" \
    --arg DEBUG_ISSUES "$DEBUG_ISSUES" \
    --arg FIELD_SOURCES_DATA "$FIELD_SOURCES_DATA" \
    --arg UTTERANCE_DATA "$UTTERANCE_DATA" \
    --arg REPEATED_VALUES_DATA "$REPEATED_VALUES_DATA" \
    --arg KEYWORD_COUNT "$KEYWORD_COUNT" \
    --arg KEYWORD_TOKENS "$KEYWORD_TOKENS" \
    --arg TOKEN_BUDGET "$TOKEN_BUDGET" \
    --arg TOKEN_HEADROOM "$TOKEN_HEADROOM" \
    --arg FEEDBACK_CONTEXT "${FEEDBACK_CONTEXT:-No user feedback for this session.}" \
    --arg DEBUG_CONTEXT "${DEBUG_CONTEXT:-No debug reports for this session.}" \
    --arg RERUN_BLOCK "$RERUN_BLOCK" \
    '{
      ANALYSIS: $ANALYSIS,
      TRANSCRIPT_DATA: $TRANSCRIPT_DATA,
      SONNET_IO: $SONNET_IO,
      REGEX_DATA: $REGEX_DATA,
      SONNET_DATA: $SONNET_DATA,
      DEBUG_ISSUES: $DEBUG_ISSUES,
      FIELD_SOURCES_DATA: $FIELD_SOURCES_DATA,
      UTTERANCE_DATA: $UTTERANCE_DATA,
      REPEATED_VALUES_DATA: $REPEATED_VALUES_DATA,
      KEYWORD_COUNT: $KEYWORD_COUNT,
      KEYWORD_TOKENS: $KEYWORD_TOKENS,
      TOKEN_BUDGET: $TOKEN_BUDGET,
      TOKEN_HEADROOM: $TOKEN_HEADROOM,
      FEEDBACK_CONTEXT: $FEEDBACK_CONTEXT,
      DEBUG_CONTEXT: $DEBUG_CONTEXT,
      RERUN_BLOCK: $RERUN_BLOCK
    }' > "$VARS_FILE"

  if ! node "$SCRIPTS_DIR/render-prompt.cjs" \
      "$SCRIPTS_DIR/optimizer-prompt-session.md" \
      "$VARS_FILE" \
      "$PROMPT_FILE" 2>>"$LOG_FILE"; then
    log "  ERROR: render-prompt.js failed for session prompt"
    rm -f "$VARS_FILE" "$PROMPT_FILE"
    return 1
  fi
  rm -f "$VARS_FILE"

  # Invoke Claude Code + parse output via shared helper. Writes
  # recommendations.json, claude_output.md, parse_status into REPORT_WORK_DIR.
  local REPORT_WORK_DIR
  REPORT_WORK_DIR=$(mktemp -d)
  run_claude_and_parse "$PROMPT_FILE" "$REPORT_WORK_DIR"
  rm -f "$PROMPT_FILE"

  local REC_COUNT SUMMARY
  REC_COUNT=$(sed -n '1p' "$REPORT_WORK_DIR/parse_status" 2>/dev/null || echo 0)
  SUMMARY=$(sed -n '2p' "$REPORT_WORK_DIR/parse_status" 2>/dev/null || echo "Analysis complete")
  local RECOMMENDATIONS
  RECOMMENDATIONS=$(cat "$REPORT_WORK_DIR/recommendations.json")

  log "  Claude returned $REC_COUNT recommendations: $SUMMARY"

  # Generate report ID
  local REPORT_ID
  REPORT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

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

  # Upload all report artifacts + analysis.json via shared helper.
  upload_report_artifacts "$REPORT_WORK_DIR" "$REPORT_ID" "$SESSION_DIR/analysis.json"

  # Build enhanced Pushover message with key stats
  local REPORT_URL="https://api.certmate.uk/api/optimizer-report/${REPORT_ID}"
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
    "$REPORT_URL" \
    "session|${SESSION_ID}"

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

  local PROMPT_FILE VARS_FILE
  PROMPT_FILE=$(mktemp)
  VARS_FILE=$(mktemp)

  local RERUN_BLOCK=""
  if [ -n "$RERUN_CONTEXT" ]; then
    RERUN_BLOCK=$(printf '## USER FEEDBACK FOR RE-RUN (HIGH PRIORITY)\nThe user reviewed the previous recommendations and provided this additional context:\n%s\nTake this feedback into account when making your recommendations.\n' "$RERUN_CONTEXT")
  fi

  jq -n \
    --arg REPORT_JSON "$REPORT_JSON" \
    --arg CONTEXT_JSON "$CONTEXT_JSON" \
    --arg RERUN_BLOCK "$RERUN_BLOCK" \
    '{REPORT_JSON: $REPORT_JSON, CONTEXT_JSON: $CONTEXT_JSON, RERUN_BLOCK: $RERUN_BLOCK}' > "$VARS_FILE"

  if ! node "$SCRIPTS_DIR/render-prompt.cjs" \
      "$SCRIPTS_DIR/optimizer-prompt-debug.md" \
      "$VARS_FILE" \
      "$PROMPT_FILE" 2>>"$LOG_FILE"; then
    log "  ERROR: render-prompt.js failed for debug prompt"
    rm -f "$VARS_FILE" "$PROMPT_FILE"
    return 1
  fi
  rm -f "$VARS_FILE"

  # Invoke Claude Code + parse output via shared helper. Writes
  # recommendations.json, claude_output.md, parse_status into REPORT_WORK_DIR.
  local REPORT_WORK_DIR
  REPORT_WORK_DIR=$(mktemp -d)
  run_claude_and_parse "$PROMPT_FILE" "$REPORT_WORK_DIR"
  rm -f "$PROMPT_FILE"

  local REC_COUNT SUMMARY
  REC_COUNT=$(sed -n '1p' "$REPORT_WORK_DIR/parse_status" 2>/dev/null || echo 0)
  SUMMARY=$(sed -n '2p' "$REPORT_WORK_DIR/parse_status" 2>/dev/null || echo "Analysis complete")

  log "  Debug report analyzed: $REC_COUNT recommendations"

  # Generate report ID and build HTML report
  local REPORT_UUID
  REPORT_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')

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

  # Upload all report artifacts via shared helper (no analysis.json for debug).
  upload_report_artifacts "$REPORT_WORK_DIR" "$REPORT_UUID"

  # Send Pushover with clickable report URL
  local REPORT_URL="https://api.certmate.uk/api/optimizer-report/${REPORT_UUID}"
  send_pushover_message \
    "Debug: ${TITLE:0:50}" \
    "$REC_COUNT recommendations — $SUMMARY" \
    0 \
    "$REPORT_URL" \
    "debug|${REPORT_S3_PATH}"

  log "  Pushover sent for debug report $REPORT_UUID"

  rm -rf "$REPORT_WORK_DIR"
}

# ── Apply Accepted Recommendations (from report page) ──

generate_implementation_plan() {
  # v4: Instead of editing/committing/deploying, write a markdown plan file that
  # the user can feed into a fresh Claude Code session. Plan mode reviews it,
  # the user approves, then Claude Code does the work under supervision.
  local REPORT_ID="$1"
  local ACCEPTED_INDICES="$2"  # JSON array string like "[0,2,3]"

  log "  Generating implementation plan for report $REPORT_ID..."

  local WORK_DIR
  WORK_DIR=$(mktemp -d)
  aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/recommendations.json" "$WORK_DIR/recommendations.json" --region "$AWS_REGION"
  aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" "$WORK_DIR/meta.json" --region "$AWS_REGION"
  # analysis.json is produced by analyze-session.js and uploaded alongside the report
  aws s3 cp "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/analysis.json" "$WORK_DIR/analysis.json" --region "$AWS_REGION" 2>/dev/null || true

  local SESSION_PATH
  SESSION_PATH=$(jq -r '.sessionPath // empty' "$WORK_DIR/meta.json")
  local REPORT_URL
  REPORT_URL=$(jq -r '.reportUrl // empty' "$WORK_DIR/meta.json")

  echo "$ACCEPTED_INDICES" > "$WORK_DIR/accepted_indices.json"

  local PLAN_PATH="$PLANS_DIR/plan-${REPORT_ID}.md"

  # Render the plan via node so we can use the structured recommendation fields.
  node -e "
    const fs = require('fs');
    const path = require('path');
    const recs = JSON.parse(fs.readFileSync('$WORK_DIR/recommendations.json','utf8'));
    const accepted = JSON.parse(fs.readFileSync('$WORK_DIR/accepted_indices.json','utf8'));
    let analysis = null;
    try { analysis = JSON.parse(fs.readFileSync('$WORK_DIR/analysis.json','utf8')); } catch (e) {}

    const reportId = '$REPORT_ID';
    const sessionPath = '$SESSION_PATH';
    const reportUrl = '$REPORT_URL';
    const timestamp = new Date().toISOString();

    const selected = accepted
      .map((i) => ({ idx: i, rec: recs[i] }))
      .filter((x) => x.rec);

    const lines = [];
    lines.push('# Optimizer implementation plan');
    lines.push('');
    lines.push('- Report ID: ' + reportId);
    lines.push('- Session: ' + (sessionPath || 'n/a'));
    lines.push('- Generated: ' + timestamp);
    if (reportUrl) lines.push('- Original report: ' + reportUrl);
    lines.push('- Accepted recommendations: ' + selected.length + ' of ' + recs.length);
    lines.push('');
    lines.push('## How to use this plan');
    lines.push('');
    lines.push('1. Start a fresh Claude Code session in the repo root:');
    lines.push('   \`\`\`');
    lines.push('   cd ~/Developer/EICR_Automation && claude');
    lines.push('   \`\`\`');
    lines.push('2. Paste this plan and ask Claude to enter plan mode before editing anything.');
    lines.push('3. Review each change. Reject anything that looks wrong.');
    lines.push('4. Claude will run tests and commit. You deploy manually (./deploy.sh, ./deploy-testflight.sh).');
    lines.push('');
    lines.push('**The optimizer did NOT apply any of these changes. It only wrote this plan.**');
    lines.push('');

    if (analysis) {
      lines.push('## Session evidence (from analyze-session.js)');
      lines.push('');
      const fr = analysis.field_report || [];
      const overwritten = fr.filter((f) => f.was_overwritten).length;
      const regexOnly = fr.filter((f) => f.source === 'regex').length;
      const sonnetOnly = fr.filter((f) => f.source === 'sonnet').length;
      lines.push('- Fields captured: ' + fr.length);
      lines.push('- Sonnet overwrites of regex: ' + overwritten);
      lines.push('- Regex-only captures: ' + regexOnly);
      lines.push('- Sonnet-only captures: ' + sonnetOnly);
      const cost = analysis.cost_breakdown || {};
      if (cost.total_usd != null) lines.push('- Session cost: $' + Number(cost.total_usd).toFixed(4));
      const uncap = (analysis.utterance_analysis && analysis.utterance_analysis.uncaptured_values) || [];
      if (uncap.length) lines.push('- Uncaptured spoken values: ' + uncap.length);
      const repeated = (analysis.repeated_values && analysis.repeated_values.length) || 0;
      if (repeated) lines.push('- Values spoken 2+ times without capture: ' + repeated);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('## Accepted changes (' + selected.length + ')');
    lines.push('');

    selected.forEach(({ idx, rec }, i) => {
      const n = i + 1;
      lines.push('### ' + n + '. ' + (rec.title || 'Untitled recommendation'));
      lines.push('');
      lines.push('- **Category:** ' + (rec.category || 'unknown').replace(/_/g, ' '));
      if (rec.file) lines.push('- **File:** \`' + rec.file + '\`');
      if (rec.token_impact) lines.push('- **Est. token impact:** ' + rec.token_impact);
      lines.push('- **Recommendation index in source:** ' + idx);
      lines.push('');

      if (rec.explanation) {
        lines.push('**Why (plain English):**');
        lines.push('');
        lines.push(rec.explanation);
        lines.push('');
      }

      if (rec.description) {
        lines.push('**Technical description:**');
        lines.push('');
        lines.push(rec.description);
        lines.push('');
      }

      const oldCode = rec.old_code || rec.code_before;
      const newCode = rec.new_code || rec.code_after;
      if (oldCode && newCode) {
        lines.push('**Proposed change (suggested diff - verify against current file before applying):**');
        lines.push('');
        lines.push('\`\`\`');
        lines.push('--- BEFORE ---');
        lines.push(oldCode);
        lines.push('--- AFTER ---');
        lines.push(newCode);
        lines.push('\`\`\`');
        lines.push('');
      }

      lines.push('**Implementation guidance for Claude Code:**');
      lines.push('');
      lines.push('- Read the current file before editing - the snippet above is from when the report was generated.');
      lines.push('- If the file has changed, adapt the change to the new structure.');
      lines.push('- Run the relevant tests after editing (see success criteria below).');
      lines.push('- Make a focused commit following the repo CLAUDE.md commit rules.');
      lines.push('- Do NOT deploy - the user will run ./deploy.sh / ./deploy-testflight.sh manually.');
      lines.push('');

      lines.push('**Success criteria:**');
      lines.push('');
      if (rec.category === 'regex_improvement' || rec.category === 'number_normaliser') {
        lines.push('- \`npm test\` passes (TranscriptFieldMatcher / NumberNormaliser tests).');
        lines.push('- Re-run \`node scripts/analyze-session.js <session-dir>\` - \`uncaptured_values\` drops.');
      } else if (rec.category === 'keyword_boost' || rec.category === 'keyword_removal' || rec.category === 'config_change') {
        lines.push('- JSON remains valid (both Sources/Resources and Resources copies if applicable).');
        lines.push('- Deepgram keyword boost budget stays under 450 tokens.');
      } else if (rec.category === 'sonnet_prompt_trim' || rec.category === 'sonnet_prompt_addition') {
        lines.push('- Backend tests pass (\`npm test\` in repo root).');
        lines.push('- Token count of EICR_SYSTEM_PROMPT does not increase (measure before/after).');
      } else if (rec.category === 'bug_fix') {
        lines.push('- The original bug described in the explanation can no longer be reproduced.');
        lines.push('- Add a regression test if one does not exist.');
      } else {
        lines.push('- All existing tests still pass.');
      }
      lines.push('');

      lines.push('**Rollback:**');
      lines.push('');
      lines.push('- Single-file change: \`git checkout HEAD -- <file>\` before committing.');
      lines.push('- After commit: \`git revert <hash>\`.');
      lines.push('');
      lines.push('---');
      lines.push('');
    });

    lines.push('## After all changes land');
    lines.push('');
    lines.push('- Verify combined diff: \`git log --oneline -n ' + selected.length + '\`');
    lines.push('- Backend: \`./deploy.sh --backend\` (or push to main for CI).');
    lines.push('- iOS: \`./deploy-testflight.sh\` from CertMateUnified/ when ready.');
    lines.push('');

    fs.writeFileSync('$PLAN_PATH', lines.join('\n'));
    console.log('PLAN_BYTES:' + fs.statSync('$PLAN_PATH').size);
  " 2>&1 | tee -a "$LOG_FILE"

  if [ ! -s "$PLAN_PATH" ]; then
    log "  ERROR: plan file is empty or missing: $PLAN_PATH"
    notify "Optimizer plan FAILED" "Report ${REPORT_ID:0:8} - could not write plan file" 1
    rm -rf "$WORK_DIR"
    return 1
  fi

  log "  Plan written: $PLAN_PATH ($(wc -c < "$PLAN_PATH") bytes)"

  # Upload a copy to S3 for archival
  aws s3 cp "$PLAN_PATH" "s3://${BUCKET}/optimizer-plans/plan-${REPORT_ID}.md" \
    --region "$AWS_REGION" --content-type "text/markdown" 2>/dev/null || true

  # Update meta.json status to "plan_ready"
  jq --arg p "$PLAN_PATH" '.status = "plan_ready" | .planPath = $p' "$WORK_DIR/meta.json" | \
    aws s3 cp - "s3://${BUCKET}/optimizer-reports/${REPORT_ID}/meta.json" \
      --region "$AWS_REGION" --content-type "application/json"

  # Build Pushover message with paste-ready command.
  # Use ~/ form in the path so the command is short and readable.
  local N_SELECTED
  N_SELECTED=$(echo "$ACCEPTED_INDICES" | jq 'length')
  local PLAN_DISPLAY="${PLAN_PATH/#$HOME/~}"
  local CLAUDE_CMD="cd ~/Developer/EICR_Automation && claude \"Implement ${PLAN_DISPLAY}\""

  local MSG="Plan ready: ${N_SELECTED} change(s) from report ${REPORT_ID:0:8}. Run: ${CLAUDE_CMD}"
  notify "Optimizer plan ready" "$MSG" 0

  log "  Plan uploaded, meta updated, notification sent."
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
  # v4: no git revert, no re-deploy. Just clear artefacts and let the session
  # re-run on next poll with the feedback context injected. Since the optimizer
  # never applied anything autonomously, there is nothing to revert.
  local SESSION_PATH="$1"
  local FEEDBACK_JSON="$2"

  log "  Processing user feedback for: $SESSION_PATH (plan-only mode - no revert needed)"

  # Remove old optimization artifacts from S3 so the re-run produces fresh ones
  aws s3 rm "s3://${BUCKET}/${SESSION_PATH}/optimization_report.json" --region "$AWS_REGION" 2>/dev/null || true
  aws s3 rm "s3://${BUCKET}/${SESSION_PATH}/optimization_report.md" --region "$AWS_REGION" 2>/dev/null || true

  # Remove session from processed list so it gets re-processed
  jq --arg s "$SESSION_PATH" '.processed_sessions = [.processed_sessions[] | select(. != $s)]' \
    "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"

  # Save feedback context for injection into the next process_session run
  echo "$FEEDBACK_JSON" > "/tmp/certmate_feedback_${SESSION_PATH//\//_}.json"

  log "  Session will be re-processed on next poll cycle with feedback context."
  notify "Feedback received" "Re-running optimizer with your corrections (no changes were applied previously)." 0
}

# ── Subcommand dispatch ──
# `status` prints a one-shot status snapshot and exits without polling.
if [ "${1:-}" = "status" ]; then
  echo "CertMate Session Optimizer — status"
  echo "==================================="

  # LaunchAgent state
  AGENT_LABEL="com.certmate.session-optimizer"
  AGENT_LINE=$(launchctl list 2>/dev/null | grep "$AGENT_LABEL" || true)
  if [ -n "$AGENT_LINE" ]; then
    AGENT_PID=$(echo "$AGENT_LINE" | awk '{print $1}')
    AGENT_EXIT=$(echo "$AGENT_LINE" | awk '{print $2}')
    if [ "$AGENT_PID" != "-" ]; then
      echo "LaunchAgent : loaded, running (PID $AGENT_PID)"
    else
      echo "LaunchAgent : loaded, NOT running (last exit $AGENT_EXIT)"
    fi
  else
    echo "LaunchAgent : not loaded"
  fi

  # Log freshness
  if [ -f "$LOG_FILE" ]; then
    LOG_BYTES=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    LOG_MTIME=$(stat -f%m "$LOG_FILE" 2>/dev/null || stat -c%Y "$LOG_FILE" 2>/dev/null || echo 0)
    LOG_AGE=$(( $(date +%s) - LOG_MTIME ))
    echo "Log file    : $LOG_FILE (${LOG_BYTES} bytes, last write ${LOG_AGE}s ago)"
    LAST_LINE=$(tail -n 1 "$LOG_FILE" 2>/dev/null || echo "(empty)")
    echo "Last log    : $LAST_LINE"
  else
    echo "Log file    : MISSING ($LOG_FILE)"
  fi

  # State counts
  if [ -f "$STATE_FILE" ]; then
    SESSIONS_DONE=$(jq -r '.processed_sessions | length' "$STATE_FILE" 2>/dev/null || echo "?")
    DRS_DONE=$(jq -r '.processed_debug_reports | length' "$STATE_FILE" 2>/dev/null || echo "?")
    RETRY_PENDING=$(jq -r '.retry_counts | length' "$STATE_FILE" 2>/dev/null || echo "?")
    GRACE_PENDING=$(jq -r '.first_seen | length' "$STATE_FILE" 2>/dev/null || echo "?")
    LAST_SWEEP=$(jq -r '.last_plan_sweep // 0' "$STATE_FILE" 2>/dev/null || echo 0)
    LAST_WEEKLY=$(jq -r '.last_weekly_summary // 0' "$STATE_FILE" 2>/dev/null || echo 0)
    echo "State       : $SESSIONS_DONE sessions / $DRS_DONE debug reports processed"
    echo "Pending     : $RETRY_PENDING in retry queue, $GRACE_PENDING in grace period"
    if [ "$LAST_SWEEP" != "0" ]; then
      SWEEP_AGE=$(( $(date +%s) - LAST_SWEEP ))
      echo "Plan sweep  : last run ${SWEEP_AGE}s ago"
    else
      echo "Plan sweep  : never run"
    fi
    if [ "$LAST_WEEKLY" != "0" ]; then
      WK_AGE=$(( $(date +%s) - LAST_WEEKLY ))
      echo "Weekly sum  : last sent ${WK_AGE}s ago"
    else
      echo "Weekly sum  : never sent"
    fi
  else
    echo "State       : $STATE_FILE missing"
  fi

  # Plans on disk
  if [ -d "$PLANS_DIR" ]; then
    PLAN_COUNT=$(find "$PLANS_DIR" -maxdepth 1 -type f -name 'plan-*.md' 2>/dev/null | wc -l | tr -d ' ')
    echo "Plans       : $PLAN_COUNT pending in $PLANS_DIR"
  else
    echo "Plans       : (no plans dir yet)"
  fi

  # Poison count in S3 (aws ls exits 1 if prefix is empty — tolerate that)
  POISON_COUNT=$( { aws s3 ls "s3://${BUCKET}/optimizer-reports/poison/" --region "$AWS_REGION" 2>/dev/null || true; } | wc -l | tr -d ' ')
  echo "Poisoned    : $POISON_COUNT fingerprints in S3"

  exit 0
fi

HEARTBEAT_COUNTER=0
HEARTBEAT_INTERVAL=15  # Log heartbeat every 15 cycles (~30 min)

log "Session optimizer (v4 plan-only) started. Polling every ${POLL_INTERVAL}s."

while true; do

  # ── Periodic maintenance (no-ops unless due) ──
  sweep_old_plans
  send_weekly_summary

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

    # Skip if poisoned (failed twice previously, even across state wipes)
    if is_poison_session "$SESSION_PATH"; then
      jq ".processed_sessions += [\"$SESSION_PATH\"]" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
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
      if [ "$RETRY_COUNT" -ge 2 ]; then
        log "  FAILED: $SESSION_PATH (marking poison after $RETRY_COUNT attempts - will NOT retry)"
        mark_poison_session "$SESSION_PATH" "retry_exhausted" "$RETRY_COUNT"
        notify "Optimizer poison session" "Session ${SESSION_PATH##*/} failed twice - skipped to avoid blocking queue. Check log." 0 "poison|${SESSION_PATH}"
        jq ".processed_sessions += [\"$SESSION_PATH\"] | del(.retry_counts.\"$SESSION_PATH\") | del(.first_seen.\"$SESSION_PATH\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      else
        log "  FAILED: $SESSION_PATH (attempt $RETRY_COUNT/2, will retry next cycle)"
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

    # Skip if poisoned
    if is_poison_session "$DR_PATH"; then
      jq ".processed_debug_reports += [\"$DR_PATH\"]" "$STATE_FILE" > "${STATE_FILE}.tmp" \
        && mv "${STATE_FILE}.tmp" "$STATE_FILE"
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
      if [ "$DR_RETRY_COUNT" -ge 2 ]; then
        log "  FAILED: $DR_PATH (marking poison after $DR_RETRY_COUNT attempts - will NOT retry)"
        mark_poison_session "$DR_PATH" "retry_exhausted" "$DR_RETRY_COUNT"
        notify "Optimizer poison debug report" "Debug report ${DR_PATH##*/} failed twice - skipped." 0 "poison|${DR_PATH}"
        jq ".processed_debug_reports += [\"$DR_PATH\"] | del(.retry_counts.\"$DR_PATH\")" "$STATE_FILE" > "${STATE_FILE}.tmp" \
          && mv "${STATE_FILE}.tmp" "$STATE_FILE"
      else
        log "  FAILED: $DR_PATH (attempt $DR_RETRY_COUNT/2, will retry next cycle)"
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

    # Delete the command file BEFORE processing to prevent crash-restart loops.
    # The command is safely saved in CMD_WORK_DIR/command.json for local processing.
    aws s3 rm "s3://${BUCKET}/${CMD_KEY}" --region "$AWS_REGION"

    if [ "$CMD_TYPE" = "accept_command" ]; then
      ACCEPTED=$(jq -c '.accepted' "$CMD_WORK_DIR/command.json")
      log "  Generating implementation plan for report $REPORT_ID: $ACCEPTED"
      generate_implementation_plan "$REPORT_ID" "$ACCEPTED"
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
