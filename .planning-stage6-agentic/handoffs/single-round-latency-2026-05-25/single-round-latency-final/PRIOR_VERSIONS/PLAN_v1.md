# Single-Round Latency Sprint — Plan v1

**Date:** 2026-05-25
**Status:** DRAFT — pending Claude Plan-agent + Codex CLI review (round 1).
**Goal:** Close the 4.7s → ~2.5s audible-confirmation-latency gap on the routine `record_reading` path. Loaded Barrel Phase 2.D (shipped 2026-05-25 commit `f3f50d4`) saved ~440ms on the TTS leg; the dominant remaining cost is Sonnet's multi-round tool loop (~4.5s of every turn). This plan addresses that.

---

## TL;DR

Three phased changes, each independently shippable, that collectively get audible latency on the dominant turn shape from ~4.7s to ~2.5s:

1. **Phase 0 (1 day) — Latency telemetry.** Instrument every turn with rounds-broken-down spans so we can measure each phase's effect numerically rather than by perception. Pre-req for the rest.

2. **Phase 1 (3-5 days) — Stage 4 regex fast-path productionisation + coverage widening.** Stage 4 (`src/routes/voice-latency-fast-tts.js`) exists as a measurement-only PoC that delivered ~420ms audible in earlier benchmarks. Productionise it (eligibility whitelist, paired write, race catalogue, observability) AND widen the iOS-side regex matcher to cover the dictation patterns the inspector actually uses. This is the highest-ROI lever — turns that pass through the fast path skip Sonnet entirely.

3. **Phase 2 (5-8 days incl. review) — Single-round preference + text-before-tool (Workstream A).** Modify `config/prompts/sonnet_agentic_system.md` so Sonnet emits the confirmation text BEFORE the `record_reading` tool call in the same assistant message, AND ends the turn in round 1 rather than emitting a redundant round-2 text reply. Stage 6's `runToolLoop` already supports this — it's a prompt change, not an architecture change.

Phase 3 — Haiku-on-round-2 — is a **conditional fallback**, only executed if Phases 1+2 measurement shows we're still above the 2.5s gate.

**Total budget:** ~10-15 days backend + 3-5 days iOS + 2 weeks field testing.

**Non-goal:** the conversational / multi-value / ask-user turn shape will still hit Sonnet and stay at ~4-5s. That's by design — the cost-correctness trade is right for high-stakes turns.

---

## What "2.5s target" means precisely

**Audible latency** = wall-clock from `Extracting from transcript` log to the first audio frame reaching iOS (cache HIT delivery time, or TTS first-byte for live synth).

Measured by either:
- `voice_latency.outcome` correlation_id span from `backend_recv` to `sent_to_client` / `loaded_barrel_hit`.
- Direct timestamp diff between `Extracting from transcript` log and `loaded_barrel_hit` / `ElevenLabs TTS success` log.

**Target distribution:** P50 ≤ 2.5s on the eligible-turn shape (single-value `record_reading` on an unambiguous circuit). P95 ≤ 3.5s. The conversational + ask-user paths are exempt from this target.

**Baseline (today, 2026-05-25 field test session `47AEF376`):**

| Turn | Wall (Extract → audio served) | Sonnet rounds | Path |
|---|---|---|---|
| "Zs is 0.6" (ambiguous, becomes ask_user) | 6.78s | 2 | Sonnet + LB HIT |
| "R1 plus R2 for the cooker is 0.7" | **4.74s** | 2 | Sonnet + LB HIT |
| "Number of points for the cooker is 1" | **4.84s** | 2 | Sonnet + LB HIT |
| "R1 plus R2 for lighting is 0.7" (post-disambig) | mixed | 2 | Sonnet + LB HIT |

Where the 4.74s goes (Turn 4 trace):
- Round 1 streaming + dispatch: 2.0s
- Round 2 streaming + end_turn: 2.5s
- Bundler + WS send: <100ms
- iOS POST + cache HIT delivery: 51ms

The pre-Loaded-Barrel baseline was ~5.2s. Loaded Barrel saved ~440ms (the TTS first-byte leg). This plan attacks the remaining ~2-3s in the Sonnet stack.

---

## Architecture — where the time goes vs where it'll go

### Today (single-value record_reading turn, LB-HIT path):

```
T=00:00.0  Inspector finishes speaking, Deepgram finalises transcript
T=00:00.0  Backend "Extracting from transcript"
           │
           │  Sonnet round 1: read transcript + cached prefix,
           │  emit record_reading tool_use
T=02:00.0  ────────────────────────────────────────────────
           │  Dispatch + speculator fires (streamed hook) → ElevenLabs synth begins in parallel
           │
           │  Sonnet round 2: re-invoked with tool_result,
           │  emit end_turn (sometimes with text)
T=04:60.0  ────────────────────────────────────────────────
           │  Bundler renders confirmation text
           │  WS extraction → iOS
T=04:69.0  iOS POSTs /api/proxy/elevenlabs-tts
T=04:74.0  Cache HIT served (50ms) ◄── audible
```

### Target (after Phases 0+1+2):

For a regex-fast-path-eligible turn (e.g. inspector says "Circuit 1 Zs 0.4" with a unambiguous designation match):
```
T=00:00.0  Transcript finalised by Deepgram (or iOS regex matcher pre-match)
T=00:00.0  iOS POSTs /api/voice-latency/regex-fast-tts with candidate
T=00:00.4  ElevenLabs first audio frame arrives at iOS ◄── audible (~420ms)
            (Sonnet still runs in parallel for the actual data write — see Phase 1)
```

For a Phase-2-only turn (regex didn't match; Sonnet still owns the round):
```
T=00:00.0  Transcript → Sonnet
           │
           │  Round 1 (text-before-tool):
           │    [text:"Circuit 1, R1 plus R2 0.7."]
           │    [tool_use: record_reading(...)]
           │    [stop_reason: end_turn]
T=02:50.0  Sonnet round 1 done — NO round 2 needed
           │  Bundler renders confirmation (uses Sonnet's text if present, else friendly-name fallback)
           │  Speculator already fired off the streamed-hook ~2s ago
T=02:55.0  iOS POSTs → cache HIT (50ms) ◄── audible
```

Net: ~4.74s → ~2.55s. Both Phase 1 and Phase 2 together would let inspector turns be in the 0.4-2.6s window depending on which path they take.

---

## Phase 0 — Latency telemetry (1 day)

### What

Extend `voice-latency-telemetry.js` and `stage6_live_extraction` log row with new fields so a CloudWatch Insights query can produce a per-turn latency breakdown without manual log archaeology:

| New field | Source | Purpose |
|---|---|---|
| `sonnet_round1_ms` | `runToolLoop` per-round timing | Pinpoint round-1 cost in isolation |
| `sonnet_round2_ms` | `runToolLoop` per-round timing | Same for round 2 (null if loop ended in round 1) |
| `total_rounds` | already in `stage6_live_extraction.rounds` | Headline shape |
| `dispatch_total_ms` | sum of `stage6.tool_call.duration_ms` | Mutator cost (today ~5ms total) |
| `bundler_ms` | new `bundler_complete` span | Time from last dispatch to WS send |
| `audible_ms` | new `audible_first_byte` span on the LB HIT path | The headline metric — Extract→first-audio |
| `path` | `fast_path` \| `sonnet_lb_hit` \| `sonnet_lb_miss` \| `sonnet_live_synth` | Classifier so we can group |

### Why

Today we have `voice_latency.outcome` events but the rounds-broken-down timing requires diff'ing timestamps across multiple log rows by hand (as I did in today's field-test analysis). A single `voice_latency.turn_summary` row per turn would let CloudWatch Insights produce a per-week P50/P95 chart per path.

### Files

- `src/extraction/voice-latency-telemetry.js` — extend SERVER_OUTCOMES with `turn_summary`; new `emitTurnSummary({correlationId, sessionId, ...metrics})`.
- `src/extraction/stage6-tool-loop.js` — capture per-round `started` / `stream_complete` / `dispatch_complete` timestamps; pass them out via `onLoopComplete` event payload.
- `src/extraction/sonnet-stream.js` — call `emitTurnSummary` from the `runLiveMode` end-of-turn hook with the captured timings.
- `src/__tests__/voice-latency-telemetry.test.js` — extend with `turn_summary` shape tests.

### Verification gate (G0)

CloudWatch query produces a clean per-week P50/P95 per `path` value within 24h of deploy. No new ERROR-level logs. Existing `voice_latency.outcome` events unchanged.

### Things NOT to break

- The `correlation_id` namespace shape — every span must still attribute to a session+turn.
- The cost-tracker's existing ledger surfaces (`speculative.*`, `canonical.*`) — Phase 0 is additive observability only.

### Cost

~0 — adds ~3 log rows per turn at ~200 bytes each. CloudWatch ingestion is well below the noise floor.

---

## Phase 1 — Stage 4 regex fast-path productionisation + coverage (3-5 days)

### What's there today

`src/routes/voice-latency-fast-tts.js` (147 lines) exposes `POST /api/voice-latency/regex-fast-tts`. iOS posts a `{sessionId, transcript, candidate}` body where `candidate = {field, circuit, value}`. The endpoint:
1. Gates on `VOICE_LATENCY_REGEX_FAST_TTS=true` per-session flag + iOS `streaming_http_audio` capability + kill-switch.
2. Builds a short confirmation string via a small `FRIENDLY` table (10 fields).
3. Streams ElevenLabs TTS via the existing `ElevenLabsStreamClient`.

Measured P50 audible: 420ms in Stage 4 PoC. Sonnet is NEVER invoked.

### What's missing today

1. **No paired snapshot write.** The endpoint doesn't write the reading to the session's stateSnapshot. The audible confirmation lands but the value doesn't reach the certificate. iOS would need to call `/api/proxy/elevenlabs-tts` for the audio AND a separate write to the snapshot. There's no documented "snapshot write" endpoint distinct from the Sonnet round-trip. **Without this, Stage 4 is unshippable.**
2. **No eligibility whitelist.** The endpoint trusts iOS's candidate. A malformed `{field: "address", circuit: 1, value: "...nonsense..."}` would happily synth audio that doesn't match what's about to land in any data path.
3. **No race catalogue.** If iOS calls the fast path AND Sonnet runs in parallel (because iOS isn't sure regex was confident enough), two confirmations could fire for the same reading.
4. **No regex extension.** iOS's regex matcher today covers a small set — verified by today's field test where every "Circuit X is Y for Z" sentence took the Sonnet path. To meaningfully reduce Sonnet load, the matcher needs to cover ~5-10 more patterns.
5. **Telemetry isn't yet hooked to `path = "fast_path"` in Phase 0's `turn_summary`** (depends on Phase 0).

### What this phase delivers

#### 1.1 — Snapshot write endpoint (NEW)

New endpoint `POST /api/voice-latency/regex-fast-write` (separate from `regex-fast-tts`). Body:
```json
{
  "sessionId": "...",
  "transcript": "Circuit 1 number of points 5",
  "candidate": { "field": "number_of_points", "circuit": 1, "value": "5", "confidence": 0.95 }
}
```

Server logic:
1. Existing snapshot gates (session exists, kill-switch off, regexFastTts flag on).
2. **Eligibility validation:** `candidate.field` MUST be in an explicit whitelist of regex-safe fields (subset of CONFIRMATION_FRIENDLY_NAMES). `candidate.circuit` MUST exist in the session's snapshot (or be 0 for board readings).
3. Apply the same `coerceRecordReadingValue` from `record-reading-coercion.js` so post-coercion value matches what the bundler would produce.
4. Write to `session.stateSnapshot` via `applyReadingToSnapshot` (the same atom the dispatchers use).
5. **Emit the same WS extraction message** the Sonnet bundler would have emitted, with `source: "regex_fast_path"` so iOS can dedup if Sonnet ALSO fires.
6. Return 202.

iOS continues to call `regex-fast-tts` separately for audio. The two endpoints are decoupled by design — TTS can race ahead of the write, write can race ahead of TTS, neither blocks the other.

#### 1.2 — Eligibility whitelist (CLOSED ENUM)

Module `src/extraction/regex-fast-eligibility.js`:
```js
export const REGEX_FAST_ELIGIBLE_FIELDS = new Set([
  'measured_zs_ohm',
  'r1_r2_ohm',
  'ir_live_earth_mohm',
  'ir_live_live_mohm',
  'number_of_points',
  'polarity_confirmed',
  'rcd_time_ms',
]);
```
Exported list, single source of truth. Both endpoints validate against it. iOS reads the same list from a published constants endpoint or static config — TBD in Codex review.

**Carved out (NOT eligible):** `ocpd_bs_en`, `rcd_bs_en`, `wiring_type`, `ref_method` (multi-character/enum values too risky to regex-match), any board / supply field, any observation, any free-text designation.

#### 1.3 — Race catalogue

When iOS posts to `regex-fast-tts` AND/OR `regex-fast-write`, it MUST also flag the same transcript in its concurrent Sonnet stream with a `regex_resolved: true` hint. Sonnet's session sees the hint and suppresses its own duplicate `record_reading` for the same (field, circuit) pair if and only if:
- The Sonnet round-1 attempt to write that exact slot is rejected by a new dispatcher gate (`regex_already_resolved`).
- The dispatcher checks `session.regexResolvedSlots` (a per-turn set keyed by `${field}::${circuit}::${boardId}`) populated by the fast-write endpoint.

If Sonnet writes the slot BEFORE the regex-fast-write arrives, the fast-write endpoint sees the slot already populated in perTurnWrites and returns 409 `slot_already_written_by_sonnet`. iOS shrugs.

If they truly fire simultaneously: standard last-write-wins on the snapshot, but the FIRST one to land emits the `source` field that iOS receives and uses to attribute the confirmation audio. Either source is correct — they're synthesising the same value.

#### 1.4 — Regex extension (iOS side)

Audit CloudWatch transcripts from the last 30 days for the top-50 most-common single-value dictation patterns. Add iOS-side regex matchers for each. Expected additions (based on today's field test transcripts):
- "R1 plus R2 for the {designation} is {value}" → `r1_r2_ohm` via designation match
- "Number of points for the {designation} is {value}" → `number_of_points`
- "Insulation live to live for {designation} is {value}" → `ir_live_live_mohm`
- "Polarity on circuit {N} confirmed" → `polarity_confirmed = Y`
- "Zs of {value} on the {designation}" → `measured_zs_ohm`

iOS-side designation matcher reuses the same `DESCRIPTION MATCHING` rules from the agentic prompt — substring + synonym tolerance. Confidence threshold: 0.9. Below 0.9, falls through to Sonnet.

### Files

- `src/routes/voice-latency-fast-tts.js` — extend with `/regex-fast-write` route (or split into a sibling file).
- `src/extraction/regex-fast-eligibility.js` — NEW.
- `src/extraction/stage6-dispatchers-circuit.js` — `dispatchRecordReading` extends `validateRecordReading` to consult `session.regexResolvedSlots` and reject with `regex_already_resolved`.
- `src/extraction/eicr-extraction-session.js` — new `session.regexResolvedSlots: Set<string>` cleared at session-start, populated by the fast-write endpoint.
- iOS `Sources/Recording/`: regex matcher extension (see iOS-side scope below).

### iOS-side scope (3-5 days iOS, in parallel)

- Extend `TranscriptFieldMatcher` regex set with the 5 new patterns above.
- Designation matcher reusing the snapshot's circuit schedule.
- POST split: `regex-fast-tts` for audio, `regex-fast-write` for the data write. iOS dispatches both in parallel and proceeds when EITHER returns 202.
- Capability `streaming_http_audio` already advertised. Add `regex_paired_write` to the capability handshake so backend knows iOS supports the paired write.

### Verification gate (G1)

| Sub-gate | Pass criteria |
|---|---|
| G1.a — write endpoint correctness | Unit tests for happy path + every eligibility rejection. Race tests with Sonnet writing the same slot. |
| G1.b — drift detector | Compare the WS extraction emitted by fast-write vs the bundler's would-be output. Mismatch rate < 0.5% over 24h. |
| G1.c — iOS regex coverage | After iOS ship, ≥30% of single-value `record_reading` turns hit `path = "fast_path"`. Measured via Phase 0 telemetry. |
| G1.d — audible latency | P50 audible on `fast_path` turns ≤ 500ms. P95 ≤ 800ms. |

### Things NOT to break

- **The existing Stage 4 PoC endpoint** (`regex-fast-tts`) must keep working — paired-write is additive.
- **Loaded Barrel** must continue to fire for non-fast-path turns. The fast path is a complete bypass; LB only matters when Sonnet runs.
- **`record_reading` dispatcher's existing validators** — the new `regex_already_resolved` rejection is a new error code, not a modification of existing codes.
- **iOS capability handshake order** — `regex_paired_write` is appended to the existing capabilities list. Older iOS clients without it don't get fast-path eligibility (graceful degrade).

### Cost

- ElevenLabs: ~$0.0025 per fast-path turn (same as Loaded Barrel's pre-synth cost, identical synth call). Net delta vs Sonnet-LB-HIT path: $0 — both use ElevenLabs once per turn.
- Sonnet: **negative cost** — fast-path turns skip Sonnet entirely. Expected reduction: 20-40% of total Sonnet turns once regex coverage extends.
- Operational: monitoring + new CloudWatch alerts for `slot_already_written_by_sonnet` rate. Negligible.

### Rollback

`VOICE_LATENCY_REGEX_FAST_TTS=false` env on the task-def disables both endpoints (existing flag, no source change). Sonnet handles everything as before.

---

## Phase 2 — Single-round preference + text-before-tool (5-8 days incl. review)

### What

Modify `config/prompts/sonnet_agentic_system.md` so that on single-value `record_reading` turns, Sonnet:
1. Emits a concise confirmation TEXT block BEFORE the `record_reading` tool_use in the same assistant message.
2. Sets `stop_reason: end_turn` in round 1 (no follow-up text reply in round 2).

The tool-loop in `runToolLoop` already supports this — `stop_reason !== 'tool_use'` exits the loop cleanly (line 390 of `stage6-tool-loop.js`).

### Why this saves time

Today's traces show every record_reading turn does 2 Sonnet rounds:
- Round 1: think + emit tool_use → 2s
- Server dispatches tool → 5ms
- Round 2: re-invoked with tool_result, emits "Recorded Zs 0.6 on the cooker." text + end_turn → 2.5s

Round 2 is essentially a no-op acknowledgement. By moving the confirmation TEXT into round 1's output (alongside the tool_use), the bundler can derive the audible confirmation from Sonnet's emitted text rather than from the friendly-name table — and round 2 isn't needed at all.

### Prompt change (concrete)

Add to `config/prompts/sonnet_agentic_system.md` (after the existing WORKED EXAMPLES, before ANTI-PATTERNS):

```
ROUND-1 CLOSURE (single-value turns):

For turns where you call exactly ONE `record_reading` AND no ask_user,
emit a CONCISE confirmation text BEFORE the tool_use call in the SAME
assistant message, then end_turn. Do not wait for the tool_result
to emit a separate reply.

Format: "Circuit N, <friendly> <value>." (or "Ze 0.19" / "Pfc 1.2"
for board readings).

Worked examples:
  "Zs on circuit 3 is 0.35" → assistant message:
    [text]: "Circuit 3, Zs 0.35."
    [tool_use]: record_reading({field:"measured_zs_ohm", circuit:3, value:"0.35", ...})
    [stop_reason]: end_turn

Do this ONLY for the single-value clean path. For:
- Multi-value turns (>1 record_reading) → tool_use only, no text.
- Corrections (clear_reading + record_reading) → tool_use only.
- ask_user turns → tool_use only.
- Observations → tool_use only.
- Any uncertainty → tool_use only.

The server uses your text VERBATIM for the audible confirmation when
you provide it. If you do NOT provide text, the server falls back to
the friendly-name table.
```

### Bundler changes

`src/extraction/stage6-event-bundler.js`:
- `synthesiseConfirmations(perTurnWrites, options)` — if `options.modelText` is non-empty, treat it as the authoritative confirmation text for the single-value case AND skip the friendly-name lookup for that slot.
- Bundler keeps emitting the same `confirmations[]` wire shape. The text field carries Sonnet's emitted text when present.

### Tool-loop changes

`src/extraction/stage6-tool-loop.js`:
- Capture the round-1 assistant message's text blocks (currently discarded) and pass them out via `onLoopComplete({modelText, ...})`.
- No structural changes — the loop already accepts `stop_reason: end_turn` in any round.

### Speculator changes

Loaded Barrel's streamed-tool hook needs to PREFER Sonnet's emitted text over its own friendly-name builder when both are available. Concretely:
- `loaded-barrel-speculator.js:onToolUseStreamed` currently uses `buildConfirmationText(field, value, circuit)` which derives from `CONFIRMATION_FRIENDLY_NAMES`.
- If Sonnet emits text BEFORE the tool_use in the same message, the speculator's `onToolUseStreamed` fires AT content_block_stop of the tool_use — but the text block has already completed. The speculator could read it from the assembler's text accumulator.
- OR — simpler — keep the speculator using friendly-name for the cache key, and let the bundler reconcile. The cache key text and the bundler text would diverge for one turn only when Sonnet's emitted text differs from friendly-name. Drift detector picks this up.

**Open Q (Codex must resolve):** does the speculator need access to Sonnet's emitted text, or is friendly-name "close enough" for cache parity? Three options:
1. Friendly-name only (today's behaviour). Cache key uses friendly-name; iOS POST sends friendly-name (because the bundler isn't reached yet). Cache HIT.
2. Sonnet-text-aware. Cache key uses Sonnet's text when available. Cache HIT only when iOS later POSTs with the same Sonnet-derived text.
3. Hybrid: friendly-name for cache key (deterministic), Sonnet-text for the audible TTS text (when iOS POSTs the text from the bundler's result). This requires iOS to send the bundler-text in the POST, which it already does via `result.confirmations[].text`.

Default to option 3 unless Codex flags a race.

### Per-turn cost

Sonnet output: +~30 tokens per single-value turn for the confirmation text. At $15/1M output, that's $0.00045 per turn. Negligible.

Sonnet input: cache invalidation on prompt change. One-time ~$0.06.

Savings: ~2.5s per single-value turn (no round 2). On ~70% of turns being single-value, that's ~1.75s saved per inspection on average.

### iOS changes

Minimal — iOS already consumes `result.confirmations[].text` and TTS-speaks it. The text will sometimes be Sonnet-emitted (after Phase 2) vs friendly-name (today / when Sonnet doesn't emit text). iOS doesn't need to know which.

### Verification gate (G2)

| Sub-gate | Pass criteria |
|---|---|
| G2.a — prompt change harness | New voice-regression scenario `single_value_record_reading_round1_close`. Asserts `rounds: 1` in `stage6_live_extraction`, asserts `confirmations[0].text` matches Sonnet's emitted text (or friendly-name fallback). |
| G2.b — Sonnet behaviour stability | 20 runs of the existing harness with the prompt change. ≥18/20 single-value turns close in round 1 (≥90% adoption). Multi-value turns continue to behave correctly. |
| G2.c — wall-clock | Phase 0 telemetry shows P50 `total_rounds == 1` ratio rises from ~0% (today) to ≥70% within 48h of prompt deploy. P50 `audible_ms` on `path = sonnet_lb_hit` turns drops from ~4700 to ~2500. |
| G2.d — drift detector | `parity_mismatch` rate on the LB cache key remains <0.5% over 24h. (The cache key uses friendly-name; bundler text uses Sonnet's emission. They diverge only when Sonnet's text deviates from friendly-name's format.) |

### Things NOT to break

- **The text-emission ANTI-PATTERN line in the existing prompt** (line 178: "Do NOT emit JSON blobs..."). The new rule is text-PLUS-tool, not text-instead-of-tool. The anti-pattern continues to hold.
- **The "Do NOT verbally acknowledge a value without also emitting record_reading" rule** (line 182). The new rule strengthens this — text is now expected alongside the tool call, not instead of it.
- **Multi-value batching example** (line 143-145). Multi-value turns continue to emit no preceding text — only the tool calls. The prompt change is scoped to single-value turns only.
- **The 12-tool documentation header** (line 17). Tool count unchanged.

### Cost / rollback

Cost: +$0.00045/turn (output tokens). 1000 turns/day = $0.45/day. Negligible.

Rollback: prompt revert via single commit. No code dependencies — bundler change is additive (still falls back to friendly-name if no model text).

---

## Phase 3 — Haiku-on-round-2 (CONDITIONAL — only if Phases 1+2 don't close the gap)

### Trigger

Phase 0 telemetry shows P50 `audible_ms` > 3.0s on the `sonnet_lb_hit` path after Phase 2 has been deployed for 1 week. This phase only fires if Phase 2's single-round-preference adoption rate stalls below ~50% (e.g. Sonnet still emits round 2 too often).

### What

When `runToolLoop` enters round 2 (i.e. round 1 ended with `stop_reason: tool_use`), route round 2 to `claude-haiku-4-5-20251001` instead of `claude-opus-4-7` (or whatever the configured Sonnet model is). Haiku is ~3x faster on the second-round end_turn pattern (typically a no-op acknowledgement after the tool dispatched cleanly).

### Risk

Haiku is less intelligent. Round 2 sometimes does real work (e.g. emits an `ask_user` if the dispatch surfaced an error). Routing round 2 to Haiku risks:
1. Dispatcher errors handled differently / less robustly.
2. Multi-round corrections losing intelligence.

Mitigation:
- Only fire Haiku-on-round-2 when round 1 dispatched cleanly (no `is_error: true` tool_results).
- On Haiku error or unexpected behaviour, fall back to Sonnet for round 2.
- A/B gate the model swap via env flag `VOICE_LATENCY_HAIKU_ROUND2=true`.

### Verification gate (G3)

| Sub-gate | Pass criteria |
|---|---|
| G3.a — quality | After 1 week of A/B at 50%, no measurable difference in correctness metrics (cert-row-error rate, ask-storm rate, observation-error rate). |
| G3.b — latency | P50 `audible_ms` on 2-round turns drops by ≥1.0s vs Sonnet baseline. |

### Cost

Haiku at $1/1M output (vs Sonnet $15/1M) is ~15x cheaper. Net effect on 2-round turns: ~$0.001 cheaper per turn. Marginal positive.

---

## Hard non-goals (do NOT extend scope)

1. **Conversational / multi-value / ask_user turns staying at ~4-5s.** The Sonnet floor is the right place for those — the model needs reasoning room.
2. **Reducing Sonnet's per-round wall-clock below 2s.** That's an Anthropic-side constraint; the model's prompt-prefill + output-streaming is the dominant cost and we don't have levers there.
3. **Eager round-2 execution.** Proposed in the v5 Workstream-A discussion as a follow-on. Out of scope — too risky for the savings.
4. **Multi-context ElevenLabs WS pooling.** Already a v11 candidate of Loaded Barrel; out of scope here.
5. **iOS-side regex Sonnet bypass for ALL turn shapes.** Conversational dictation must stay on Sonnet — the regex matcher should not attempt to handle ambiguous inputs.
6. **Replacing Sonnet with Haiku for round 1.** Phase 3 is round-2 only.

---

## Verification gates (cross-phase, in order)

| Gate | Trigger | Pass condition |
|---|---|---|
| **G0** | Phase 0 deploy | `voice_latency.turn_summary` log row visible in CloudWatch within 24h; per-phase P50/P95 query produces a clean chart. |
| **G1** | Phase 1 deploy | iOS adoption of `regex_paired_write` capability ≥80%; P50 `audible_ms` on `fast_path` turns ≤ 500ms; drift detector mismatch rate <0.5%. |
| **G2** | Phase 2 deploy | Single-round adoption rate ≥70%; P50 `audible_ms` on `sonnet_lb_hit` turns ≤ 2.5s; `parity_mismatch` rate <0.5%. |
| **G3** | Phase 3 deploy (CONDITIONAL) | Only triggered if G2 misses 2.5s target. P50 `audible_ms` drops ≥1.0s; correctness metrics within noise. |
| **G4** | Sprint complete | 1-week field test session: ≥70% of routine `record_reading` turns hit ≤ 2.5s P50 audible. |

---

## Rollback criteria

Each phase has independent rollback:

| Phase | Rollback trigger | Action |
|---|---|---|
| 0 | `voice_latency.turn_summary` emit rate >10% errors | Revert telemetry commit |
| 1 | Drift detector mismatch rate >1.0% over 1h | `VOICE_LATENCY_REGEX_FAST_TTS=false` env flip |
| 2 | Sonnet behaviour regression: tool_use emission rate <95% | Revert prompt change |
| 3 | Cert correctness metrics drift >5% week-over-week | `VOICE_LATENCY_HAIKU_ROUND2=false` env flip |

---

## Files to read before starting (per phase)

### Phase 0
- `src/extraction/voice-latency-telemetry.js` — current outcomes + correlation_id shape.
- `src/extraction/stage6-tool-loop.js:316-456` — per-round structure, where to capture timestamps.
- `src/extraction/sonnet-stream.js:runLiveMode` — end-of-turn hook point.

### Phase 1
- `src/routes/voice-latency-fast-tts.js` — existing PoC endpoint.
- `src/extraction/stage6-dispatchers-circuit.js` — `dispatchRecordReading` to add `regex_already_resolved` gate.
- `src/extraction/stage6-snapshot-mutators.js` — `applyReadingToSnapshot` atom the new write endpoint will call.
- `src/extraction/record-reading-coercion.js` — coercion the new endpoint must apply.
- iOS `Sources/Processing/TranscriptFieldMatcher.swift` — regex matcher to extend.
- iOS `Sources/Services/APIClient.swift` — POST plumbing for the two endpoints.

### Phase 2
- `config/prompts/sonnet_agentic_system.md:177-186` — ANTI-PATTERNS list (the new rule must not contradict it).
- `src/extraction/stage6-event-bundler.js` — bundler text source.
- `src/extraction/stage6-tool-loop.js` — round-1 assistant message text accumulator.
- `src/extraction/loaded-barrel-speculator.js` — cache key derivation; Sonnet-text-vs-friendly-name decision.

### Phase 3
- `src/extraction/sonnet-stream.js` — model selection point.
- `src/extraction/cost-tracker.js` — Haiku cost rate config.

---

## Open questions (for Claude + Codex review to resolve)

1. **Phase 1.3 race catalogue completeness.** Have I enumerated every race between fast-write and Sonnet? Specifically: what if Sonnet emits `ask_user` for the same field+circuit while fast-write is in flight? The ask_user would be irrelevant after the write lands but iOS might already be TTS-speaking the question. Need a Sonnet-side guard.
2. **Phase 1 iOS designation matcher correctness.** Today's Stage 6 `DESCRIPTION MATCHING` is fuzzy (substring + synonym). Replicating that on iOS risks drift. Should iOS POST the candidate WITH the matched circuit_ref (after iOS-side matching) AND the backend re-verify? Or should iOS POST the spoken designation and the backend match? The latter adds a round-trip; the former adds drift risk.
3. **Phase 2 cache parity (covered above).** Three options for the speculator's cache key derivation. Need a decision.
4. **Phase 2 multi-value detection in the prompt.** "Single-value turn" is currently defined as "exactly ONE record_reading". But what about turns that emit `create_circuit` + `record_reading` in the same response (Example 3 in the prompt)? Are those single-value or multi-value for the round-1-close rule? Lean toward including them (round-1-close applies as long as there's exactly ONE record_reading AND no ask_user).
5. **Phase 3 Haiku model availability for tool-use.** Anthropic API may differ on Haiku's tool-use streaming behaviour. Need to verify Haiku 4.5 (claude-haiku-4-5-20251001) supports the same tool-loop wire shape as Sonnet.

---

## Approvals

- **Claude Plan-agent:** PENDING (round 1)
- **Codex CLI:** PENDING (round 1)
- **Derek:** PENDING (after both reviewers converge to zero BLOCKERs)

---

## Revision history

- **v1 (2026-05-25)** — initial draft after field-test data confirmed 4.7s baseline. Replaces the v5 Workstream A sketch with a full multi-phase plan grounded in measured baseline.
