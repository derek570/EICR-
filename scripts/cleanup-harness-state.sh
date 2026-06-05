#!/usr/bin/env bash
#
# One-shot cleanup for ~/.certmate/optimizer_state.json — purge harness_*
# session entries from first_seen + retry_counts maps. processed_sessions
# is intentionally left alone (append-only, bloat-tolerant, editing risks
# re-processing real sessions).
#
# Companion to the basename harness filter in session-optimizer.sh's poll
# + audit loops (commit 5be55ae3). The filter prevents future pollution;
# this script removes the backlog accumulated before the filter landed.
#
# Safe to re-run: jq idempotently rewrites only matching keys. Atomic-swap
# pattern (.tmp + mv) prevents a partial-write corrupting the state file
# if the script is interrupted.
#
# Usage:
#   ./scripts/cleanup-harness-state.sh
#
# Verification (should print nothing):
#   jq '.first_seen | keys[]' ~/.certmate/optimizer_state.json \
#     | grep -E '/[^/]*harness_[^/]*$'

set -euo pipefail

STATE_FILE="${HOME}/.certmate/optimizer_state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: $STATE_FILE not found" >&2
  exit 1
fi

BEFORE_FIRST_SEEN=$(jq '.first_seen | length' "$STATE_FILE")
BEFORE_RETRY_COUNTS=$(jq '.retry_counts | length' "$STATE_FILE")

jq '
  .first_seen   |= with_entries(select(.key | test("/harness_") | not))
  | .retry_counts |= with_entries(select(.key | test("/harness_") | not))
' "$STATE_FILE" > "${STATE_FILE}.tmp" \
  && mv "${STATE_FILE}.tmp" "$STATE_FILE"

AFTER_FIRST_SEEN=$(jq '.first_seen | length' "$STATE_FILE")
AFTER_RETRY_COUNTS=$(jq '.retry_counts | length' "$STATE_FILE")

REMOVED_FIRST_SEEN=$((BEFORE_FIRST_SEEN - AFTER_FIRST_SEEN))
REMOVED_RETRY_COUNTS=$((BEFORE_RETRY_COUNTS - AFTER_RETRY_COUNTS))

echo "first_seen:   ${BEFORE_FIRST_SEEN} -> ${AFTER_FIRST_SEEN} (removed ${REMOVED_FIRST_SEEN})"
echo "retry_counts: ${BEFORE_RETRY_COUNTS} -> ${AFTER_RETRY_COUNTS} (removed ${REMOVED_RETRY_COUNTS})"

LEAKED=$(jq -r '.first_seen | keys[]' "$STATE_FILE" | grep -E '/[^/]*harness_[^/]*$' || true)
if [ -n "$LEAKED" ]; then
  echo "WARNING: harness entries still present in first_seen after cleanup:" >&2
  echo "$LEAKED" >&2
  exit 2
fi

echo "Cleanup complete — no harness_* entries remain in first_seen."
