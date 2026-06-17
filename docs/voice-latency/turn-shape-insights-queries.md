# Loaded Barrel — turn-shape CloudWatch Insights queries (Plan B B3)

Log group: `/ecs/eicr/eicr-backend` (region `eu-west-2`).

These queries split Loaded Barrel speculation outcomes and perceived latency by
**turn shape**, so the Plan B trade-off is observable rather than a silent
regression: single-call (clean) turns should keep a high HIT rate, while
multi-call / multi-round turns are EXPECTED to MISS (speculation discarded →
fresh synth). Run them against 1–2 field sessions after the A+B deploy (B5).

`turn_shape` is emitted on `voice_latency.turn_core_summary`
(`single_call | multi_call | multi_round`); the Loaded Barrel outcomes
(`voice_latency.loaded_barrel_*` via `recordOutcome`) share `{sessionId, turnId}`
so the queries correlate the two row families.

> Drift outcomes carry `meta.reason` (`text_drift` | `turn_aborted`) on
> `loaded_barrel_text_drift_detected`. The mid-stream preview is suppressed (B1a),
> so there is no longer a `mid_stream_emit` row — HITs come from the canonical
> confirmation POST claiming the parked MP3.

---

## 1. Turn-shape distribution (sanity: how often does round 2 actually fire?)

```
fields turn_shape, rounds
| filter @message like /turn_core_summary/
| stats count(*) as turns by turn_shape
| sort turns desc
```

## 2. Agency metrics (Plan A loop restoration — is the model reasoning across rounds?)

```
fields rounds
| filter @message like /turn_core_summary/
| stats count(*) as turns,
        avg(rounds) as avg_rounds,
        sum(rounds >= 2) as multi_round_turns,
        (sum(rounds >= 2) * 100.0 / count(*)) as pct_multi_round
```

## 3. HIT / MISS / discarded / drift by turn_shape (the core trade-off view)

Correlates the per-turn shape to the speculation outcome. Run as two steps and
join on `{sessionId, turnId}` in the dashboard, or use this single-pass form that
keys off the outcome rows and pulls turn_shape via a self-join surrogate
(Insights has no JOIN — emit both keyed by sessionId+turnId and merge client-side,
or filter one shape at a time):

```
fields @timestamp, sessionId, turnId, outcome
| filter @message like /voice_latency/
        and (outcome like /loaded_barrel_hit/
          or outcome like /loaded_barrel_fired/
          or outcome like /loaded_barrel_discarded/
          or outcome like /loaded_barrel_text_drift_detected/)
| stats count(*) as n by outcome
| sort n desc
```

To split by shape without a JOIN, first list the `turnId`s of each shape:

```
fields turnId, turn_shape
| filter @message like /turn_core_summary/
| filter turn_shape = 'single_call'
| stats count(*) by turnId
```

then re-run query (3) with an added `| filter turnId in [ ... ]`. (For a durable
dashboard, prefer emitting `turn_shape` onto the outcome meta in a follow-up — see
note below — so a single `stats ... by outcome, turn_shape` works.)

## 4. Drift rate + reason (text_drift vs turn_aborted)

```
fields meta.reason as reason
| filter @message like /loaded_barrel_text_drift_detected/
| stats count(*) as drift_events by reason
```

## 5. Perceived latency by turn_shape

Requires the `voice_latency.turn_perceived_latency_ms` store (Phase 2.3, PR #52)
keyed by `{sessionId, turnId}`; correlate to turn_shape as in (3).

```
fields turn_shape, run_live_duration_ms
| filter @message like /turn_core_summary/
| stats avg(run_live_duration_ms) as avg_run_live_ms,
        pct(run_live_duration_ms, 50) as p50_ms,
        pct(run_live_duration_ms, 90) as p90_ms
    by turn_shape
| sort turn_shape
```

---

## Targets / interpretation

- **single_call HIT rate stays high** — the clean fast path still parks + serves
  the MP3 (now via the canonical POST, not the suppressed preview).
- **multi_call / multi_round MISS is expected** — per-slot speculations don't match
  the grouped / corrected final confirmation, so they're invalidated (drift) and
  the bundler synthesises fresh. Visible MISS here = the trade-off working, NOT a
  regression.
- **avg rounds ~1 on multi-field utterances** would mean Haiku rarely gets its
  round-2 "second look" — that's a prompt follow-up (separate sprint), per plan §5.

## Follow-up (optional, not in Plan B scope)

For a single-pass `by outcome, turn_shape` query, stamp `turn_shape` onto the
Loaded Barrel outcome `meta` at `recordOutcome` time. Plan B keeps turn_shape on
`turn_core_summary` only (one authoritative row per turn) to avoid threading the
shape — known only post-loop — back into the mid-turn speculator outcomes.
