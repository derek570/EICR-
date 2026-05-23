#!/usr/bin/env bash
# Run the transcript-replay harness against PROD.
# Mints a JWT via the throwaway /api/test/harness-mint-jwt endpoint
# (gated by STAGE0_BENCH=1 + X-Bench-Secret == JWT_SECRET).
# Runs the 5 baseline scenarios and writes per-scenario JSON results.

set -euo pipefail

BASE_URL="${BASE_URL:-https://api.certmate.uk}"
EMAIL="${BENCH_EMAIL:-derek@beckleyelectrical.co.uk}"
OUTPUT_DIR="${OUTPUT_DIR:-.planning-stage6-agentic/handoffs/voice-latency-2026-05-23/stage0-results/harness-baseline}"

mkdir -p "$OUTPUT_DIR"

echo "1/4 Fetching JWT_SECRET from AWS Secrets Manager..."
JWT_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id eicr/api-keys \
  --region eu-west-2 \
  --query SecretString \
  --output text | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['JWT_SECRET'])")
if [ -z "$JWT_SECRET" ]; then
  echo "ERROR: JWT_SECRET fetch returned empty"
  exit 1
fi
echo "  ok, length=${#JWT_SECRET}"

echo "2/4 Minting harness JWT via $BASE_URL/api/test/harness-mint-jwt..."
MINT_RESPONSE=$(curl -sf -X POST "$BASE_URL/api/test/harness-mint-jwt" \
  -H "Content-Type: application/json" \
  -H "X-Bench-Secret: $JWT_SECRET" \
  -d "{\"email\":\"$EMAIL\"}")
if [ -z "$MINT_RESPONSE" ]; then
  echo "ERROR: mint endpoint returned empty (deploy not complete? STAGE0_BENCH not 1?)"
  exit 1
fi
TOKEN=$(echo "$MINT_RESPONSE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['token'])")
USER_ID=$(echo "$MINT_RESPONSE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['userId'])")
echo "  ok, userId=$USER_ID, token_len=${#TOKEN}"

echo "3/4 Running transcript-replay harness against 5 baseline scenarios..."
node scripts/voice-latency-bench/transcript-replay.mjs \
  --base-url="$BASE_URL" \
  --token="$TOKEN" \
  --output="$OUTPUT_DIR" \
  | tee "$OUTPUT_DIR/run.log"

echo "4/4 Done. Results in $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR"
