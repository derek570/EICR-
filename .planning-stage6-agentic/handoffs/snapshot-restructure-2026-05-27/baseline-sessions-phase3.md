# Paired baseline(s) for the Phase 3 canary

Pulled 2026-05-28 from `s3://eicr-files-production/session-analytics/.../cost_summary.json`.

**Honest caveat:** there's only ONE post-Phase-1 production session to use as baseline. The Phase 1 fleet flip went live 2026-05-27 ~20:30 UTC; the only real-EICR session that ran on `SNAPSHOT_FORMAT=split_blocks` + `CIRCUIT_ORDER=recent_3` is the Phase 1 canary's session 2. Single-point comparison — interpret cautiously.

If you want a paired pair before flipping the Phase 3 canary, do one more 15–25 min real session on the current live task def (`:236` carries `SNAPSHOT_FORMAT=split_blocks`; PR #38's CI deploy will replace it with another `recent_3` task def — same code path either way). That session becomes Baseline B.

## Baseline A (only)

| Field | Value |
|---|---|
| sessionId | `C61473FD-8976-4ACE-94BF-EF3993A28481` |
| timestamp (UTC) | 2026-05-27 19:30–19:46 |
| job | `job_1779910571868` |
| turns | 24 |
| cacheReads | 841,594 |
| **cacheWrites** | **18,658** |
| input | 17,397 |
| output | 4,078 |
| sonnet cost | $0.4358 |
| total job cost | $0.5833 |
| readings extracted | 21 |
| questions asked | 0 |

Per-turn rates:

| | Baseline A |
|---|---|
| cacheWrites/turn | 778 |
| cacheReads/turn | 35,066 |
| sonnet $/turn | $0.0182 |
| total $/turn | $0.0243 |

## Proportional pass thresholds (per turn × N)

If the Phase 3 canary session runs N turns:

| Metric | Threshold | Reasoning |
|---|---|---|
| cacheWrites | ≤ N × 778 × 0.80 = N × 622 tokens | Phase 3 expected per-turn write reduction is modest (Phase 1 already squeezed writes hard — the floor is low) |
| cacheReads | ≤ N × 35,066 × 1.50 = N × 52,599 tokens | Ascending renders MORE circuits in detail per turn; some read growth is expected; > 50% means the volatile tail blew up |
| total $ | ≤ N × $0.0243 × 0.90 = N × $0.0219 | Modest absolute saving on top of Phase 1 |
| `missing_context` asks | ≤ 3 | Baseline had 0; allow some headroom for the inspector dictation style |

## What "win" looks like

For a 24-turn canary session (matching Baseline A):

| | Baseline | Canary target (lower bound) | Canary target (upper bound) |
|---|---|---|---|
| cacheWrites | 18,658 | < 14,927 | (no upper bound on improvement) |
| cacheReads | 841,594 | (no lower bound) | < 1,262,391 |
| total $ | $0.5833 | < $0.5249 | — |

Best-case from the plan's model: cacheWrites collapse to near-zero on turns that don't add new circuits (purely revisits to circuits already in the EXTRACTED block produce no new lines, so the prefix is fully cached and only the EXTRACTED's bottom changes). Worst-case: cacheReads grow proportional to circuit count, eroding the gain.

## How to re-pull

```bash
aws s3 cp s3://eicr-files-production/session-analytics/82b54893-220d-49f5-8c55-d677a009787b/C61473FD-8976-4ACE-94BF-EF3993A28481/cost_summary.json - \
  | jq .
```
