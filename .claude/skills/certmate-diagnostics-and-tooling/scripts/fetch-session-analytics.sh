#!/usr/bin/env bash
# fetch-session-analytics.sh — one-liner to pull a field session's debug
# artefacts from S3 and (optionally) run the analyzer on them.
#
# Finds the session under s3://eicr-files-production/session-analytics/
# WITHOUT needing the userId (searches all user prefixes for the session id),
# downloads every artefact (debug_log.jsonl, field_sources.json, manifest.json,
# job_snapshot.json, cost_summary.json), ALSO pulls the realtime backend-relay
# log chunks from session-logs/<userId>/<sessionId>/realtime/ (the
# client_log_batch sink), then optionally runs scripts/analyze-session.js.
#
# Usage:
#   .claude/skills/certmate-diagnostics-and-tooling/scripts/fetch-session-analytics.sh <sessionId> [outDir] [--analyze]
#
# Examples:
#   fetch-session-analytics.sh sess_mr8qrvcm_20jn                      # download only
#   fetch-session-analytics.sh F1AC26FB /tmp/f1ac26fb --analyze        # download + analysis.json
#
# Requirements: aws CLI with creds for eu-west-2; node (for --analyze).
# Read-only against S3. Exit codes: 0 ok, 1 session not found, 2 usage.
set -euo pipefail

BUCKET="eicr-files-production"
REGION="eu-west-2"

SESSION_ID="${1:-}"
if [ -z "$SESSION_ID" ]; then
  echo "usage: $0 <sessionId> [outDir] [--analyze]" >&2
  exit 2
fi
OUT_DIR="${2:-}"
ANALYZE=0
for arg in "$@"; do
  [ "$arg" = "--analyze" ] && ANALYZE=1
done
if [ "$OUT_DIR" = "--analyze" ] || [ -z "$OUT_DIR" ]; then
  OUT_DIR="./session-${SESSION_ID}"
fi

# Repo root = four levels up from this script's dir (scripts/ -> skill -> skills -> .claude -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

echo "1/3 Locating session ${SESSION_ID} under s3://${BUCKET}/session-analytics/ ..." >&2
# `aws s3 ls --recursive` paginates internally, so this survives >1000 keys.
MATCHES="$(aws s3 ls "s3://${BUCKET}/session-analytics/" --recursive --region "$REGION" \
  | awk '{print $4}' | grep "/${SESSION_ID}/" || true)"

if [ -z "$MATCHES" ]; then
  echo "ERROR: no objects match session-analytics/*/${SESSION_ID}/ — check the session id" >&2
  echo "Hint: recent sessions:" >&2
  aws s3 ls "s3://${BUCKET}/session-analytics/" --recursive --region "$REGION" \
    | sort -k1,2 | tail -12 >&2
  exit 1
fi

SESSION_PREFIX="$(echo "$MATCHES" | head -1 | sed "s|\(session-analytics/[^/]*/${SESSION_ID}/\).*|\1|")"
USER_ID="$(echo "$SESSION_PREFIX" | cut -d/ -f2)"
echo "   found: s3://${BUCKET}/${SESSION_PREFIX} (userId=${USER_ID})" >&2

mkdir -p "$OUT_DIR"
echo "2/3 Downloading analytics artefacts to ${OUT_DIR}/ ..." >&2
aws s3 cp "s3://${BUCKET}/${SESSION_PREFIX}" "$OUT_DIR/" --recursive --region "$REGION" >&2

# Realtime relay chunks (client_log_batch → realtime-log-sink). Optional —
# only exists for sessions after the Phase 1.3 relay shipped.
REALTIME_PREFIX="session-logs/${USER_ID}/${SESSION_ID}/realtime/"
if aws s3 ls "s3://${BUCKET}/${REALTIME_PREFIX}" --region "$REGION" >/dev/null 2>&1; then
  mkdir -p "$OUT_DIR/realtime"
  aws s3 cp "s3://${BUCKET}/${REALTIME_PREFIX}" "$OUT_DIR/realtime/" --recursive --region "$REGION" >&2
  # If the multipart debug_log.jsonl is missing (the upload path iOS uses is
  # flaky), stitch the realtime chunks into one so analyze-session.js can run.
  if [ ! -f "$OUT_DIR/debug_log.jsonl" ] && ls "$OUT_DIR"/realtime/*.jsonl >/dev/null 2>&1; then
    cat "$OUT_DIR"/realtime/*.jsonl > "$OUT_DIR/debug_log.jsonl"
    echo "   note: debug_log.jsonl reconstructed from realtime chunks" >&2
  fi
fi

echo "   contents:" >&2
ls -la "$OUT_DIR" >&2

if [ "$ANALYZE" = "1" ]; then
  echo "3/3 Running analyzer ..." >&2
  if [ ! -f "$OUT_DIR/debug_log.jsonl" ] || [ ! -f "$OUT_DIR/field_sources.json" ] || [ ! -f "$OUT_DIR/manifest.json" ]; then
    echo "WARN: analyze-session.js needs debug_log.jsonl + field_sources.json + manifest.json; one is missing — skipping" >&2
  else
    node "$REPO_ROOT/scripts/analyze-session.js" "$OUT_DIR"
  fi
else
  echo "3/3 Skipped analysis (pass --analyze to produce analysis.json)" >&2
fi
