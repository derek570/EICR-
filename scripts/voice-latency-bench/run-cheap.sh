#!/usr/bin/env bash
# run-cheap.sh — fast, low-cost scenario replay for dev iteration.
#
# Wraps transcript-replay.mjs (HTTP/WS against local backend) with:
#   SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001   # ~10× cheaper than Sonnet 4.6
#   SONNET_CACHE_TTL=1h                              # 1h cache reuse across the whole suite
#                                                    # (one cache write at 2× base, then 0.1×
#                                                    #  per read — recouped after ~10 turns)
#
# Cost ballpark per scenario at Haiku 4.5 with 1h cache reuse:
#   - 1st run of the suite: ~$0.005 per scenario (cache write)
#   - Subsequent runs within 1h: ~$0.0005 per scenario (cache read only)
#   - Same suite on Sonnet 4.6 with 5m cache: ~$0.05 / $0.025
# 34 existing scenarios: ~$0.18 first run, ~$0.02 subsequent runs.
#
# IMPORTANT: the backend (npm start) must inherit these env vars too — the
# harness sends transcripts over WS to your localhost:3000 backend, and the
# backend reads SONNET_EXTRACT_MODEL / SONNET_CACHE_TTL from its own process
# env. Restart `npm start` with these env vars set, OR add them to a .env.dev
# file your local backend loads.
#
# Two ways to run:
#
#   # (1) Run against an already-running local backend (you set env vars
#   #      when you started it):
#   ./scripts/voice-latency-bench/run-cheap.sh --suite=baseline
#
#   # (2) Restart your local backend with the right env then run the suite
#   #      in one shot — uncomment the backend-start block below.
#
# Defaults: --base-url=http://localhost:3000, --suite=baseline.

set -euo pipefail

export SONNET_EXTRACT_MODEL="${SONNET_EXTRACT_MODEL:-claude-haiku-4-5-20251001}"
export SONNET_CACHE_TTL="${SONNET_CACHE_TTL:-1h}"

echo "── harness:cheap ──"
echo "  SONNET_EXTRACT_MODEL=$SONNET_EXTRACT_MODEL"
echo "  SONNET_CACHE_TTL=$SONNET_CACHE_TTL"
echo "  base-url=${BASE_URL:-http://localhost:3000}"
echo "  args: $*"
echo "  NOTE: the backend must run with the same env vars or the cache will"
echo "        miss every turn (the cache key includes the model)."
echo "──────────────────"

# Forward all args to the harness so --suite, --scenario, --output, --token
# etc. work as-is.
exec node "$(dirname "$0")/transcript-replay.mjs" \
  "--base-url=${BASE_URL:-http://localhost:3000}" \
  "$@"
