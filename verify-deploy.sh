#!/bin/bash
# Verify CertMate deployment is working correctly
# Run after any docker compose rebuild or ECS deploy
#
# Usage: ./verify-deploy.sh [--local | --production]
#   --local       Check local Docker containers (default)
#   --production  Check certmate.uk
#   --both        Check both local and production

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
WARN=0

MODE="${1:---local}"

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; ((WARN++)); }

# ── 1. Git state check ──────────────────────────────────────────────
echo "=== Git State ==="
LATEST_COMMIT=$(cd "$SCRIPT_DIR" && git rev-parse --short HEAD)
LATEST_MSG=$(cd "$SCRIPT_DIR" && git log -1 --format='%s')
echo "  Latest commit: $LATEST_COMMIT — $LATEST_MSG"

# Check for uncommitted changes
if (cd "$SCRIPT_DIR" && git diff --quiet && git diff --cached --quiet); then
  pass "No uncommitted changes"
else
  warn "Uncommitted changes present — deployed code may not match HEAD"
fi

# ── 2. Local Docker checks ──────────────────────────────────────────
if [[ "$MODE" == "--local" || "$MODE" == "--both" ]]; then
  echo ""
  echo "=== Local Docker Containers ==="

  # Check containers are running
  for SVC in pwa backend redis; do
    CONTAINER=$(cd "$SCRIPT_DIR" && docker compose ps --format '{{.Name}} {{.State}}' 2>/dev/null | grep "$SVC" || true)
    if [[ -n "$CONTAINER" && "$CONTAINER" == *"running"* ]]; then
      pass "$SVC container running"
    else
      fail "$SVC container NOT running"
    fi
  done

  # Check container build time vs latest commit
  PWA_CONTAINER=$(cd "$SCRIPT_DIR" && docker compose ps -q pwa 2>/dev/null || true)
  if [[ -n "$PWA_CONTAINER" ]]; then
    CONTAINER_CREATED=$(docker inspect --format='{{.Created}}' "$PWA_CONTAINER" 2>/dev/null | cut -d'T' -f1,2 | cut -d'.' -f1 || echo "unknown")
    COMMIT_TIME=$(cd "$SCRIPT_DIR" && git log -1 --format='%aI' | cut -d'T' -f1,2 | cut -d'+' -f1 || echo "unknown")

    # Compare timestamps (container should be AFTER latest commit)
    CONTAINER_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${CONTAINER_CREATED/T/ }" "+%s" 2>/dev/null || echo "0")
    COMMIT_EPOCH=$(cd "$SCRIPT_DIR" && git log -1 --format='%at' 2>/dev/null || echo "0")

    if [[ "$CONTAINER_EPOCH" -ge "$COMMIT_EPOCH" ]]; then
      pass "Container built AFTER latest commit ($CONTAINER_CREATED)"
    else
      fail "Container built BEFORE latest commit — needs rebuild! (container: $CONTAINER_CREATED, commit: $COMMIT_TIME)"
    fi
  fi

  # Health check endpoints
  echo ""
  echo "=== Health Checks (Local) ==="

  # Backend health
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    pass "Backend health endpoint (port 3000)"
  else
    fail "Backend health endpoint unreachable"
  fi

  # PWA reachable
  if curl -sf http://localhost:3002 > /dev/null 2>&1; then
    pass "PWA reachable (port 3002)"
  else
    fail "PWA unreachable on port 3002"
  fi

  # Web reachable
  if curl -sf http://localhost:3001 > /dev/null 2>&1; then
    pass "Web app reachable (port 3001)"
  else
    warn "Web app unreachable on port 3001 (may not be running locally)"
  fi

  # Redis
  if docker exec "$(cd "$SCRIPT_DIR" && docker compose ps -q redis 2>/dev/null)" redis-cli ping 2>/dev/null | grep -q PONG; then
    pass "Redis responding to PING"
  else
    fail "Redis not responding"
  fi

  # ── 3. Key page spot-checks ─────────────────────────────────────────
  echo ""
  echo "=== Page Spot Checks (Local PWA) ==="

  # Check that critical routes return 200
  for ROUTE in "/" "/login" "/jobs"; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3002${ROUTE}" 2>/dev/null || echo "000")
    if [[ "$STATUS" == "200" || "$STATUS" == "307" || "$STATUS" == "302" ]]; then
      pass "PWA ${ROUTE} → ${STATUS}"
    else
      fail "PWA ${ROUTE} → ${STATUS} (expected 200/302/307)"
    fi
  done
fi

# ── 4. Production checks ────────────────────────────────────────────
if [[ "$MODE" == "--production" || "$MODE" == "--both" ]]; then
  echo ""
  echo "=== Production (certmate.uk) ==="

  PROD_URL="https://certmate.uk"

  # Site reachable
  PROD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PROD_URL" 2>/dev/null || echo "000")
  if [[ "$PROD_STATUS" == "200" || "$PROD_STATUS" == "307" || "$PROD_STATUS" == "302" ]]; then
    pass "Production site reachable → ${PROD_STATUS}"
  else
    fail "Production site returned ${PROD_STATUS}"
  fi

  # SSL check
  if curl -s --head "$PROD_URL" 2>/dev/null | grep -qi "strict-transport-security"; then
    pass "HSTS header present"
  else
    warn "No HSTS header"
  fi

  # API health
  API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${PROD_URL}/health" 2>/dev/null || echo "000")
  if [[ "$API_STATUS" == "200" ]]; then
    pass "Production API health → 200"
  else
    warn "Production API health → ${API_STATUS}"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
echo -e "  ${GREEN}Passed:${NC}  $PASS"
[[ $WARN -gt 0 ]] && echo -e "  ${YELLOW}Warnings:${NC} $WARN"
[[ $FAIL -gt 0 ]] && echo -e "  ${RED}Failed:${NC}  $FAIL"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo -e "${RED}DEPLOY VERIFICATION FAILED${NC} — $FAIL check(s) need attention"
  exit 1
else
  echo ""
  echo -e "${GREEN}DEPLOY VERIFIED${NC}"
  exit 0
fi
