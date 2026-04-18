#!/usr/bin/env bash
# Autonomous codex review runner for the web rebuild phase-by-phase audit.
# Runs sequentially (not in parallel) to minimise rate-limit exposure.
# On rate limit, sleeps 5h15m then retries the same phase.

set -u  # no -e: we want to keep going through phases even if one errors

export PATH="/opt/homebrew/bin:$PATH"

REPO_ROOT="/Users/derekbeckley/Developer/EICR_Automation"
WEB_ROOT="$REPO_ROOT/web"
PHASES_FILE="$WEB_ROOT/reviews/phases.tsv"
OUT_DIR="$WEB_ROOT/reviews/codex"
LOG_DIR="$WEB_ROOT/reviews/logs"
LOG="$LOG_DIR/codex.log"
STATE="$LOG_DIR/codex-state.log"

mkdir -p "$OUT_DIR" "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"
}

log "==== Codex review runner started (PID $$) ===="

# Parse phases (skip header)
PHASE_IDS=()
PHASE_COMMITS=()
PHASE_TITLES=()
while IFS=$'\t' read -r pid pcommit ptitle; do
  [ "$pid" = "PHASE_ID" ] && continue
  [ -z "$pid" ] && continue
  PHASE_IDS+=("$pid")
  PHASE_COMMITS+=("$pcommit")
  PHASE_TITLES+=("$ptitle")
done < "$PHASES_FILE"

log "Queued ${#PHASE_IDS[@]} phases for review."

run_one_phase() {
  local PID="$1"
  local COMMIT="$2"
  local TITLE="$3"
  local OUT_FILE="$OUT_DIR/phase-${PID}.md"
  local RAW_FILE="$OUT_DIR/phase-${PID}.raw.txt"
  local CONTEXT_FILE="$WEB_ROOT/reviews/context/phase-${PID}.md"

  log "---- Phase ${PID} (${COMMIT}) — ${TITLE} ----"

  if [ -s "$OUT_FILE" ]; then
    log "Skipping phase ${PID}: output already exists ($OUT_FILE)."
    return 0
  fi

  local PROMPT
  PROMPT=$(cat <<EOF
You are performing a rigorous code review of a single phase of a Next.js 16 / React 19 PWA frontend rebuild for an electrical-certificate automation tool (EICR / EIC). The repo root is at /Users/derekbeckley/Developer/EICR_Automation and the web package is at web/. Branch: web-rebuild.

TARGET: ${TITLE}
COMMIT: ${COMMIT}

Context for this phase (original intent, handoff doc, commit message, files changed) is in this repo at: reviews/context/phase-${PID}.md — READ THAT FILE FIRST.

Use shell commands to:
  git show --stat ${COMMIT}
  git show ${COMMIT}
to inspect the full diff. Then read any files you need from the working tree (they may have evolved since this commit — note any later changes).

Your output must be a well-structured markdown review with these sections:
  1. Summary of the phase (2-3 sentences — what it did).
  2. Alignment with original plan (does the implementation match the handoff doc / commit intent? Any missing objectives?).
  3. Correctness issues (bugs, race conditions, missing error handling, incorrect semantics). Prioritise P0/P1/P2.
  4. Security issues (XSS, auth, CSRF, injection, leaked secrets, PII, CORS). Each item tagged with severity.
  5. Performance issues (re-renders, N+1, large bundles, memory leaks, blocking work on main thread).
  6. Accessibility issues (semantic HTML, keyboard nav, ARIA, colour contrast, focus management).
  7. Code quality (duplication, dead code, type-safety holes, naming, convention drift vs. rest of repo).
  8. Test coverage gaps.
  9. Suggested fixes — each as a numbered item with: file:line, what to change, why. Be concrete.
  10. Overall verdict (ship / ship with fixes / needs rework) and top 3 priority fixes.

Be specific — cite file paths and line numbers. Avoid generic advice. If the code is good, say so with evidence. Do NOT modify files; this is review only.
EOF
)

  local ATTEMPT=0
  local MAX_ATTEMPTS=3
  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))
    log "Phase ${PID}: attempt ${ATTEMPT}/${MAX_ATTEMPTS} (codex exec, sandbox=read-only)."

    # Run codex exec with the prompt via stdin; capture exit code.
    # macOS has no `timeout`; use a background + watchdog pattern.
    local EXIT_CODE=0
    (
      printf '%s\n' "$PROMPT" | codex exec \
        --sandbox read-only \
        -C "$REPO_ROOT" \
        -o "$OUT_FILE" \
        - > "$RAW_FILE" 2>&1
    ) &
    local CODEX_PID=$!
    local WATCH=0
    while kill -0 "$CODEX_PID" 2>/dev/null; do
      sleep 30
      WATCH=$((WATCH + 30))
      if [ $WATCH -ge 2400 ]; then  # 40 min hard cap
        log "Phase ${PID}: watchdog killing codex (pid=${CODEX_PID}) after ${WATCH}s."
        kill -TERM "$CODEX_PID" 2>/dev/null
        sleep 5
        kill -KILL "$CODEX_PID" 2>/dev/null
        EXIT_CODE=124
        break
      fi
    done
    if [ $EXIT_CODE -eq 0 ]; then
      wait "$CODEX_PID" 2>/dev/null || EXIT_CODE=$?
    fi

    # Detect rate-limit / quota exhaustion in the LAST 40 lines of raw output
    # (where codex prints errors). Tight patterns to avoid matching content
    # inside review bodies.
    LAST_LINES=$(tail -40 "$RAW_FILE" 2>/dev/null || true)
    if printf '%s\n' "$LAST_LINES" | grep -qiE 'rate[- ]?limit(ed)?|quota (exceeded|exhausted)|usage limit reached|HTTP[/ ]?429|Status: 429|error[^\n]*429|too many requests|retry.?after|try again (in|later)|Reset at [0-9]|limit will reset'; then
      log "Phase ${PID}: rate-limit detected (exit=${EXIT_CODE}). Sleeping 5h15m before retry."
      echo "RATE_LIMIT phase=${PID} attempt=${ATTEMPT} at=$(date -u +%FT%TZ)" >> "$STATE"
      echo "--- TAIL at rate-limit detection ---" >> "$STATE"
      printf '%s\n' "$LAST_LINES" | tail -20 >> "$STATE"
      echo "--- END TAIL ---" >> "$STATE"
      sleep $((5*3600 + 15*60))
      continue
    fi

    if [ $EXIT_CODE -eq 124 ]; then
      log "Phase ${PID}: codex timed out after 30m. Retrying after 60s."
      sleep 60
      continue
    fi

    if [ $EXIT_CODE -ne 0 ]; then
      log "Phase ${PID}: codex exited ${EXIT_CODE}. Retrying after 2m."
      sleep 120
      continue
    fi

    # Success — if the output file is empty (codex didn't write -o), copy raw into it.
    if [ ! -s "$OUT_FILE" ]; then
      log "Phase ${PID}: -o file empty; salvaging from raw output."
      cp "$RAW_FILE" "$OUT_FILE"
    fi

    log "Phase ${PID}: codex review complete ($(wc -l < "$OUT_FILE") lines)."
    return 0
  done

  log "Phase ${PID}: FAILED after ${MAX_ATTEMPTS} attempts. Moving on."
  return 1
}

for i in "${!PHASE_IDS[@]}"; do
  run_one_phase "${PHASE_IDS[$i]}" "${PHASE_COMMITS[$i]}" "${PHASE_TITLES[$i]}"
  # brief courtesy pause between phases to smooth out rate-limit curves
  sleep 5
done

log "==== Codex review runner finished ===="
touch "$LOG_DIR/codex.DONE"
