# Phase 3 sprint plan — ascending circuits + retire rotation

> Sister plan to `Snapshot restructure final plan.md` §4. This document fills in the "(retained from v5)" gaps that didn't make the final committed plan.
> **Gate:** Phase 3 does not start until the Phase 1 canary in `canary-runbook.md` passes the §6.1 gates and the fleet has flipped to `SNAPSHOT_FORMAT=split_blocks` as the default.
> **Branch:** `snapshot-phase3-ascending`
> **Expected saving:** $0.05–$0.10/session on top of Phase 1.

---

## 1. What "rotation" is today

`src/extraction/eicr-extraction-session.js` maintains a `recentCircuitOrder: number[]` array (initialised at line 988, mutated at lines 2579–2581, 1385). Every time a reading lands on a circuit, that circuit moves to the end of the array. The snapshot renderer (line 3019) takes the **last N (= `SNAPSHOT_RECENT_CIRCUITS = 3`)** entries and renders them in full detail; everything else gets a one-line "3 earlier circuits (1,2,5) stored server-side" summary.

The prompt at `config/prompts/sonnet_extraction_system.md:581` documents the contract:
> Only the 3 most recently updated circuits are shown in detail — older circuits are listed by number only (values stored server-side, still valid, do NOT re-extract).

### Why this is a cache killer under split_blocks

Phase 1's split_blocks layout puts the EXTRACTED data in the **volatile tail**. The cache breakpoint is at the end of the tail; cache prefix hits require the tail's prefix to be byte-identical turn-to-turn.

The rotation set changes whenever the inspector moves to a different circuit. The text rendering reorders. The byte prefix of the tail diverges. The cache prefix hit collapses to wherever the divergence starts — which is near the top of the tail, since the recent-circuits block is the largest detailed section.

Result: most of the volatile tail is rewritten on each turn instead of cached.

## 2. What Phase 3 changes

### 2.1 Replace "rotation" with "ascending"

The snapshot renderer iterates circuits in ascending numeric order and renders ALL of them in full detail. The text becomes append-only across turns: new circuits extend the bottom; existing circuits' lines change only when their readings change (which already invalidates the cache on the affected lines and below — that's correct).

```
// before (today)
EXTRACTED CIRCUITS (most recent first):
  Circuit 3: {22: 0.35, 21: ">200"}
  Circuit 2: {22: 0.42, 23: 18}
  Circuit 5: {22: 0.61}
3 earlier circuits (1,4,6) stored server-side

// after (Phase 3, ascending)
EXTRACTED CIRCUITS (ascending order):
  Circuit 1: {22: 0.28}
  Circuit 2: {22: 0.42, 23: 18}
  Circuit 3: {22: 0.35, 21: ">200"}
  Circuit 4: {22: 0.55}
  Circuit 5: {22: 0.61}
  Circuit 6: {22: 0.47}
```

When the inspector then moves from Circuit 4 to Circuit 7, the new turn's tail is:
```
  Circuit 1: {22: 0.28}                         ← byte-identical to last turn
  Circuit 2: {22: 0.42, 23: 18}                 ← byte-identical
  Circuit 3: {22: 0.35, 21: ">200"}             ← byte-identical
  Circuit 4: {22: 0.55}                         ← byte-identical
  Circuit 5: {22: 0.61}                         ← byte-identical
  Circuit 6: {22: 0.47}                         ← byte-identical
  Circuit 7: {22: 0.39}                         ← NEW (extends the tail)
```

The cache prefix hit lands at the end of "Circuit 6", and only the Circuit 7 line is fresh. Under today's rotation, ALL of circuits 1–5's lines would have reordered and the cache prefix hit would have collapsed to the top of the tail.

### 2.2 Retire `recentCircuitOrder`

`recentCircuitOrder` becomes dead code under ascending order. Delete the field initialisation, every mutation site, and the slice in the renderer. Don't leave it dangling — the audit script doesn't catch dead instance fields and they'd accumulate.

### 2.3 Update the prompt contract

The prompt at line 581 is now wrong (no rotation; no "3 most recent"). Replace with a description that matches the new rendering. Use a placeholder so the substitution is mode-gated and the fallback to today's wording survives the feature flag.

```markdown
COMPACT STATE SNAPSHOT FIELD IDS:
{{CIRCUIT_FORMAT_DESCRIPTION}}
1=circuit_designation 2=wiring_type 3=ref_method 4=number_of_points ...
```

The substitution happens in the `EICRExtractionSession` constructor (mirroring `_resolveSnapshotFormat` / `_resolveToolCallsMode`), using the escape-safe `replace(regex, () => v)` helper from §4.4 of the parent plan.

| `CIRCUIT_ORDER` | Substitution |
|---|---|
| `recent_3` (default) | "The EXTRACTED READINGS snapshot uses numeric IDs for circuit-level fields to reduce token cost. Circuit 0 (supply) uses full field names. Only the 3 most recently updated circuits are shown in detail — older circuits are listed by number only (values stored server-side, still valid, do NOT re-extract)." |
| `ascending` | "The EXTRACTED READINGS snapshot uses numeric IDs for circuit-level fields to reduce token cost. Circuit 0 (supply) uses full field names. All circuits in this board are shown in detail, listed in ascending numeric order. A circuit absent from this list has no extracted readings yet (the inspector has not reported any) — when they do, the circuit will appear here." |

## 3. Code surfaces

### 3.1 New env var + resolver

`ecs/task-def-backend.json`: add a new env var

```json
{ "name": "CIRCUIT_ORDER", "value": "recent_3" }
```

`src/extraction/eicr-extraction-session.js`: new `_resolveCircuitOrder` mirroring `_resolveSnapshotFormat`, with the same warn-and-fallback contract on unknown values.

### 3.2 Renderer branch

`buildCompactEicrSnapshot` (around line 2974, where "Most recent N circuits included with compact numeric field IDs" is written today): branch on `this.circuitOrder === 'ascending'`:

- `ascending`: iterate `listCircuitRefsInBoard(...).sort((a, b) => a - b)`, render all in full detail. Drop the "X earlier circuits stored server-side" line entirely (no longer needed; nothing is hidden).
- `recent_3` (default): existing path unchanged.

### 3.3 Retirement

Behind `circuitOrder === 'ascending'`:

- `recentCircuitOrder` mutation sites (lines 2579–2581, 1385) become no-ops (guard with `if (this.circuitOrder === 'recent_3')`).
- `recentCircuitOrder.slice(...)` at line 3019 unreachable.

After fleet flip, a follow-up cleanup commit can delete `recentCircuitOrder` entirely once `recent_3` is no longer reachable. Do not delete in the same PR — the flag exists for rollback and recent_3 must remain wire-identical to today's main.

### 3.4 Prompt placeholder substitution

`config/prompts/sonnet_extraction_system.md:581`: wrap the explanatory line in `{{CIRCUIT_FORMAT_DESCRIPTION}}` per §2.3.

`src/extraction/eicr-extraction-session.js` constructor: add `_substitutePromptPlaceholders(template, { CIRCUIT_FORMAT_DESCRIPTION: this._circuitFormatDescription() })` using the escape-safe helper from the parent plan's §4.4.

## 4. Cost model

Phase 3 expected saving on top of Phase 1 split_blocks:

| Component | Before Phase 3 | After Phase 3 | Delta |
|---|---|---|---|
| Volatile-tail cache write per turn | Avg ~600 tokens (whole tail rewritten when rotation set changes — happens ~every 2–3 turns) | Avg ~80 tokens (only NEW readings extend the tail; existing lines stable) | ~520 tokens saved per affected turn |
| Volatile-tail size | Capped at 3 circuits' worth of detail | Grows with circuit count (typ. 6–14 per board) | +200–500 tokens read per turn |

Net at typical session shape (15–25 turns, 8 circuits): plan §4 estimate **$0.05–$0.10 per session**. The read-cost increase is offset by cache hits on the prefix; the write-cost saving dominates because cache_creation is $3.75/M vs cache_read $0.30/M (12.5× ratio).

## 5. Test plan

Mirrors Phase 1's test catalogue.

| # | Case | Assertion |
|---|---|---|
| 1 | `circuitOrder='recent_3'` (default) | Snapshot byte-identical to pre-Phase-3 main (regression lock) |
| 2 | `circuitOrder='ascending'` — empty session | Snapshot has no EXTRACTED CIRCUITS lines (no circuits yet) |
| 3 | `circuitOrder='ascending'` — 1 circuit | One detailed line for that circuit |
| 4 | `circuitOrder='ascending'` — 8 circuits dictated out of order | All 8 lines present, sorted 1→8 |
| 5 | `circuitOrder='ascending'` — sub-board active | Only that board's circuits listed (board scoping preserved from Phase 5.5.3) |
| 6 | `circuitOrder='ascending'` — `recentCircuitOrder` not mutated | After 10 record_reading calls, `this.recentCircuitOrder.length === 0` |
| 7 | `_resolveCircuitOrder` — unknown value | Warns + falls back to `recent_3` (regression lock) |
| 8 | Prompt placeholder substitution — `recent_3` | Prompt contains the legacy "3 most recently updated" wording |
| 9 | Prompt placeholder substitution — `ascending` | Prompt contains the new "ascending numeric order" wording |
| 10 | Prompt placeholder substitution — escape-safe | Substituted value containing `$1` literal renders as `$1`, not as a regex back-ref (re-uses Phase 1 §4.4 test) |
| 11 | **E2E cache stability** — replay 5 turns adding readings on circuits 3, 1, 5, 2, 4 in that order under `ascending` | Final tail's first `N-1` lines are byte-identical to turn N's first `N-1` lines (cache prefix preserved). Under `recent_3`, this assertion fails (rotation reorders) — included to document the contract Phase 3 buys us. |

## 6. Rollout

- **Day 1**: implementation + tests. Default `CIRCUIT_ORDER=recent_3` ships to main; no production behaviour change.
- **Day 2**: canary task-def revision with `CIRCUIT_ORDER=ascending`. Re-use the same scaffold as Phase 1: a `task-def-backend.phase3-canary.json` clone, runbook follows `canary-runbook.md` shape. Pull two paired baselines that are POST-Phase-1 split_blocks sessions (the Phase 1 baselines are no longer comparable — they're single_block).
- **Day 2 canary gates** (all four required):
  - Snapshot bytes per turn: average new-tail prefix-share across turns > 0.7 (proxy for cache prefix preservation; emit as new telemetry alongside `schedule_block_rebuild`)
  - `ask_user.missing_context` count: ≤ baseline (the new wording must not blind Sonnet to which circuits have readings)
  - `cacheWrites` tokens: ≤ 80% of paired baseline (looser than Phase 1 — Phase 3's saving is smaller)
  - `cacheReads` tokens: ≤ 150% of paired baseline (read offset is expected; this gate exists to catch runaway growth)
- **Day 3** (gated on Day 2 pass): fleet flip `CIRCUIT_ORDER=ascending`. Delete the canary task-def. Schedule the `recentCircuitOrder` removal cleanup commit for +1 week.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Prompt change blinds Sonnet to which circuits have readings | Test #11 + Day-2 canary gate on `missing_context`; the new wording explicitly says "absent from this list has no extracted readings yet" |
| Sub-board context regression | Test #5; renderer keeps using `listCircuitRefsInBoard` (already board-scoped from Phase 5.5.3) |
| Read offset eats the write saving | Day-2 cacheReads gate at ≤ 150%; the 12.5× write:read price ratio means even a 1.5× read multiplier is dominated by the write reduction |
| EXTRACTED block grows beyond the prompt cache's 1024-token minimum cacheable block | Won't happen — typical board is 8–14 circuits; even at 14 circuits × 80 tokens of detail = 1120 tokens, well below any practical limit |
| Phase 1 canary fails first → Phase 3 also held | This is the design. Don't start Phase 3 work until Phase 1's fleet flip is stable for ≥48h. |

## 8. Out of scope (deferred to Phase 3.1 or beyond)

- Multi-board EXTRACTED rendering (currently scoped to active board only; cross-board summary deferred).
- Compacting older circuits' readings into a denser format (e.g. `{22: 0.35}` → `Z:0.35` — token-count optimisation orthogonal to ordering).
- Removing `recentCircuitOrder` entirely (separate commit one week post-flip).
