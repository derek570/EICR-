# Paired baselines for the Phase 1 canary

Pulled 2026-05-27 from `s3://eicr-files-production/session-analytics/.../cost_summary.json`. All sessions ran on `SNAPSHOT_FORMAT=single_block` (current prod default).

**Source of truth in live/stage6 mode is S3, NOT CloudWatch.** The per-turn `Session N Turn N cost` line in `eicr-extraction-session.js:2176` only fires from the legacy `_extractSingle` path which `SONNET_TOOL_CALLS=live` does not exercise. The Stage 6 path persists the final summary via `sonnet-stream.js:4241` (`logger.info('Cost summary saved', { s3Key })`) — the S3 object is the canonical record. The earlier draft of `canary-insights-queries.md` queried for `Turn N cost` and returned zero rows — superseded by the S3 pull below.

## Selected pair

Both sessions look like short EICR runs (6–8 turns, ~$0.25 total). They should be reasonable analogues for a 15–25 min canary session with 6–10 circuits dictated, assuming the canary doesn't go long.

| | Session A | Session B |
|---|---|---|
| sessionId | `065BDA7F-9220-48F8-BDC5-786C9380BED6` | `835BCDF9-3542-417A-B770-A3A2A778A1F5` |
| timestamp (UTC) | 2026-05-26 17:16 | 2026-05-26 11:24 |
| turns | 7 | 8 |
| cacheReads (tokens) | 287,598 | 271,208 |
| **cacheWrites (tokens)** | **23,494** | **16,636** |
| input | 6,142 | 5,964 |
| output | 1,191 | 895 |
| sonnet cost | $0.2107 | $0.1751 |
| total job cost | $0.2372 | $0.2525 |
| readings extracted | 7 | (full file in /tmp/baseline-sessions/) |

**Pair averages (canary thresholds key off these):**

| Metric | Avg(A,B) | 70% of avg (write target) | 120% of avg (read sanity) | 80% of avg ($ fallback) |
|---|---|---|---|---|
| cacheWrites tokens | 20,065 | **≤ 14,046** | — | — |
| cacheReads tokens | 279,403 | — | ≤ 335,283 | — |
| total cost | $0.2449 | — | — | **≤ $0.1959** |

Gate, per plan §6.1:
- Canary `cacheWrites` ≤ 14,046 tokens **OR** canary total cost ≤ $0.1959.
- Canary `cacheReads` ≤ 335,283 tokens (sanity — not a fail-only gate, but a > 1.2× spike is investigation-worthy).
- `identityRate` > 0.7.
- Canary `missing_context` asks ≈ 0–3 (baseline `questionsAsked` was 0; any 5+ is a red flag).

## Other recent candidates considered

For posterity / picking a different pair if Session A or B turns out to be unrepresentative.

| sessionId | turns | cacheWrites | cacheReads | total $ | Why not picked |
|---|---|---|---|---|---|
| `1B496E8A-F62B-4754-B064-F8AED744721F` | 1 | 1,646 | 20,225 | $0.032 | Too short — single-turn session, almost certainly a test or aborted run. |
| `33E6613D-49A7-4B42-A73B-1E2C6A82174D` | 86 | 189,250 | 3,044,073 | $2.657 | Too long — full inspection. Worth pulling as a "long session" comparison if the canary runs > 30 turns. |
| `87856B72-F920-4E12-AC09-68334CCD0ABC` | 6 | 23,814 | 142,381 | $0.189 | cacheWrite/turn (3,969) is high vs Sessions A & B (2,080–3,356), would pull the average artificially up. |

## Per-turn unit economics (paired pair only)

Useful if the canary lands at a different turn count.

| | Session A | Session B | Avg |
|---|---|---|---|
| cacheWrites / turn | 3,356 | 2,080 | **2,718** |
| cacheReads / turn | 41,085 | 33,901 | **37,493** |
| total $ / turn | $0.0339 | $0.0316 | **$0.0327** |

If the canary runs N turns, the proportional pass thresholds are:
- cacheWrites ≤ N × 2,718 × 0.7 = N × 1,903 tokens
- cacheReads ≤ N × 37,493 × 1.2 = N × 44,992 tokens
- total $ ≤ N × $0.0327 × 0.8 = N × $0.0262

## How to re-pull the baselines

```bash
# Cost summary objects are at session-analytics/<userId>/<sessionId>/cost_summary.json
aws s3 ls s3://eicr-files-production/session-analytics/ --recursive \
  | grep "cost_summary.json" \
  | sort -k1,2 -r \
  | head -20

# Pull a specific one:
aws s3 cp \
  s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/065BDA7F-9220-48F8-BDC5-786C9380BED6/cost_summary.json \
  - | jq .
```

A copy of each baseline `cost_summary.json` is in `/tmp/baseline-sessions/` for the duration of this session — copy them somewhere durable if you want them retained.
