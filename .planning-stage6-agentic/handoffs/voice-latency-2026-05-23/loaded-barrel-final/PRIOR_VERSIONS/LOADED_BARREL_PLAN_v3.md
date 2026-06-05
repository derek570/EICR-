# Loaded Barrel v3 — Shared-Helper Speculative Cache

**Date:** 2026-05-23
**Supersedes:** LOADED_BARREL_PLAN_v2.md (which fixed v1's 7 BLOCKERs
but introduced 7 NEW BLOCKERs around value-normalisation drift,
unexported helpers, missing assembler hooks, cost-tracker
double-counting, etc).
**Reconciles:** Claude Plan-agent review of v2 + Codex gpt-5.5 review of v2.

## TL;DR

v2's design was right (server-side speculative cache, iOS unchanged,
tool loop unchanged) but the call-graph contracts were sloppy. v3
locks the contracts:

- **One shared `predictConfirmationText(toolUse, sessionState)` helper**
  used by BOTH the speculator AND the bundler. No drift possible.
- **One hook** (`onCompletedToolUse`) added to the
  stream-assembler/tool-loop so the speculator can react the moment
  Sonnet emits a complete tool_use, without waiting for `message_stop`.
- **Cost-tracker single-owner contract**: speculator is the billable
  recorder. Cache hit is a bytes-only short-circuit; never touches
  cost counters.
- **In-flight dedupe** via a separate `pendingSpeculations: Map<key, Promise>`.
- **Confidence + multi-context + circuit-coercion** drift closed by
  making `predictConfirmationText` the SOLE source of truth.

Estimated effort revised from v2's 6.5 days → **~8 backend days** (the
extra 1.5 days = export-cleanup of bundler helpers + assembler hook +
covering record_board_reading + scripted-write callsites).

## v2 BLOCKER closure matrix

| v2 BLOCKER | v3 fix | New contract surface |
|---|---|---|
| v2-B1: value-normalisation drift | Shared helper `predictConfirmationText` consumes the SAME `normaliseToolUseValueForConfirmation` function the dispatcher uses | §3.1 |
| v2-B2: helpers not exported | Export `buildConfirmationText` + `synthesiseConfirmations` from `stage6-event-bundler.js`; refactor bundler to consume the new shared helper | §3.2 |
| v2-B3: multi-context requires contextId | Speculator mints `spec_<correlationId>` contextId, mirrors `streamConfirmationViaElevenLabs` pattern at `keys.js:263` | §3.3 |
| v2-B4: cost-tracker double-counting | Speculator owns `recordElevenLabsStreamingStarted` + `…Terminal`. Cache hit serves bytes, never calls recorders. Cache-hit logs `voice_latency.speculation_hit` ONLY | §3.4 |
| v2-B5: no per-tool-use callback in assembler | Add `onCompletedToolUse(toolUseBlock)` to `stage6-stream-assembler.js`; wire into `runToolLoop` so callers can subscribe per-tool-use | §3.5 |
| v2-B6: confidence threshold suppression | Speculator runs the SAME confidence gate as `synthesiseConfirmations` (`CONFIRMATION_MIN_CONFIDENCE = 0.8`) BEFORE synth | §3.1 |
| v2-B7: circuit int/string coercion | `predictConfirmationText` coerces to int when round-trippable, matching bundler line :199-204 | §3.1 |

## v2 IMPORTANT closures

| v2 IMP | v3 fix |
|---|---|
| Fire-and-forget can block | Call site MUST use `void speculate(...).catch(noop)`; test asserts speculator returns synchronously after first awaitable yields |
| Multi-write turns only first hits | Speculator fires on EVERY `onCompletedToolUse` event, deduped via `pendingSpeculations` |
| Cache-hit loses correlation ID | Cache entry stores `correlationId` from speculation; cache-hit response sets `X-Voice-Latency-Correlation-Id: <stored>` + emits its OWN `voice_latency.outcome=sent_to_client` so the existing iOS ack pipeline (Stage 1b) pairs correctly |
| `confirmations_enabled` gate | Speculator checks `entry.session.lastTranscriptHadConfirmationsEnabled` before synth (added to session entry; updated in `handleTranscript`) |
| Board readings (Ze/PFC/etc) | Speculator handles `record_board_reading` tool_use too |
| Calculated writes (`calculate_zs`, `set_field_for_all_circuits`) | Out of scope for v3 (no `tool_use` to hook). Documented as future v4. |
| Dialogue-engine `wire-emit.js` bypass | Out of scope (script flows already have their own latency profile). Documented. |
| Same text dictated twice | First consume deletes the cache entry; second speculation creates a fresh entry. Race window covered by `pendingSpeculations` |
| Cache RAM pressure | Per-session bound 50 entries, global LRU 1000, TTL **10s** (lowered from v2's 60s per NIT-3) |
| New telemetry outcomes will be rejected | Add `speculation_hit`, `speculation_miss`, `speculation_completed`, `speculation_cancelled`, `speculation_failed` to `IOS_OUTCOMES` set in `voice-latency-telemetry.js` (these are SERVER outcomes actually; categorise correctly — extend `SERVER_OUTCOMES`) |
| `VOICE_LATENCY_SPECULATION` not snapshotted | Add to `SNAPSHOTTED_FLAGS` in `voice-latency-config.js` + corresponding task-def env var |
| Redis migration story | Acknowledged as out of scope; single-instance assumption documented + linted |
| Cost rate stale | Update `cost-tracker.js` ELEVENLABS_RATE_PER_CHAR from `0.000030` → `0.000050` (Flash actual). Separate commit before v3 lands |
| Cost text contradiction | Single cost section in v3 §5 |

## v3 design (the deltas vs v2)

### §3.1 The shared helper

New file: `src/extraction/predict-confirmation-text.js`

```
// SINGLE SOURCE OF TRUTH for "given this tool_use, what confirmation
// text will eventually be spoken?" Used by BOTH the speculator (v3)
// and the bundler (after refactor) so no value/circuit/confidence
// drift can occur between prediction and final emission.
//
// Inputs:
//   toolUseBlock: { name, input: {...} }   // from Anthropic stream-assembler
//   sessionState (optional, for board context)
//
// Returns: { eligible: boolean, text: string|null, predictedReading: {...} }
//   eligible=false when:
//     - tool name not in supported set (record_reading, record_board_reading)
//     - field not in FRIENDLY map
//     - input.confidence !== undefined && < CONFIRMATION_MIN_CONFIDENCE (0.8)
//     - input.value missing / null / empty
//     - polarity_confirmed with non-truthy value (suppression rule from bundler)

export const CONFIRMATION_MIN_CONFIDENCE = 0.8;

export function predictConfirmationText(toolUseBlock, sessionState = null) {
  const { name, input } = toolUseBlock;
  if (name !== 'record_reading' && name !== 'record_board_reading') {
    return { eligible: false, text: null, predictedReading: null };
  }
  const field = input.field;
  const friendly = FRIENDLY_NAMES[field];
  if (!friendly) return { eligible: false, text: null, predictedReading: null };

  const confidence = typeof input.confidence === 'number' ? input.confidence : 1.0;
  if (confidence < CONFIRMATION_MIN_CONFIDENCE) {
    return { eligible: false, text: null, predictedReading: null };
  }

  // Coerce circuit to int when round-trippable (matches
  // stage6-event-bundler decodeReadingKey behaviour at lines 199-204).
  let circuit = input.circuit;
  if (typeof circuit === 'string') {
    const n = parseInt(circuit, 10);
    if (Number.isFinite(n) && String(n) === circuit.trim()) circuit = n;
  }

  // Value normalisation — apply the SAME transform record_reading
  // dispatcher does so the bundler's eventual entry.value matches.
  // (For polarity_confirmed → "true"/"false"; for numerics → trimmed
  //  decimal string; for enums → lowercase.)
  const normalisedValue = normaliseValueForConfirmation(field, input.value);

  // Reuse buildConfirmationText (exported from stage6-event-bundler).
  const text = buildConfirmationText(field, normalisedValue, circuit);
  if (!text) return { eligible: false, text: null, predictedReading: null };

  return {
    eligible: true,
    text,
    predictedReading: { field, circuit, value: normalisedValue, confidence },
  };
}
```

Bundler refactor: `synthesiseConfirmations` rebuilt to call this same
helper for each reading. Guarantees prediction == final emission.

### §3.2 Export cleanup commit

`src/extraction/stage6-event-bundler.js`:
- Change `function buildConfirmationText(...)` → `export function buildConfirmationText(...)`
- Change `function synthesiseConfirmations(...)` → `export function synthesiseConfirmations(...)`
- Add `CONFIRMATION_MIN_CONFIDENCE` export
- Move `CONFIRMATION_FRIENDLY_NAMES` to `predict-confirmation-text.js` (single source) and re-export back for bundler use.

Ships in its own commit BEFORE the speculator lands, so the refactor
is isolated from new logic.

### §3.3 The stream-assembler hook

`src/extraction/stage6-stream-assembler.js`:

```
// EXISTING: assembler accumulates content_blocks during the stream,
// dispatches at message_stop. v3 adds a per-tool-use callback so a
// subscriber can react the moment a tool_use block's input JSON
// completes (at content_block_stop for that block), BEFORE
// message_stop fires.
//
// Backward-compat: when no onCompletedToolUse callback is passed,
// behaviour is unchanged.

export async function assembleStream(stream, opts = {}) {
  const { onCompletedToolUse = null } = opts;
  ...
  case 'content_block_stop': {
    const block = blocks[event.index];
    if (block?.type === 'tool_use' && onCompletedToolUse) {
      // Synchronously try the callback; never await; never throw.
      try { onCompletedToolUse(block); } catch (err) { logger.warn(...); }
    }
    break;
  }
  ...
}
```

`runToolLoop` accepts an `onCompletedToolUse` option, plumbs through
to `assembleStream`. Callers (sonnet-stream.js / eicr-extraction-session.js)
pass the speculator's trigger.

### §3.4 Speculator + cache contract

`src/extraction/loaded-barrel-speculator.js`:

```
const speculationCache = new Map();      // key → { audioBuffer, contentType, correlationId, completeAt, ttlMs }
const pendingSpeculations = new Map();   // key → Promise<void>

const TTL_MS = 10_000;
const PER_SESSION_CAP = 50;
const GLOBAL_CAP = 1000;

export function speculateOnToolUse({ toolUseBlock, sessionEntry, apiKey, costTracker }) {
  if (!sessionEntry?.voiceLatency?.flags?.speculation) return;
  if (!sessionEntry?.voiceLatency?.flags?.streamConfirmations) return; // gate inherits Stage 2
  if (!sessionEntry?.lastTranscriptHadConfirmationsEnabled) return;

  const { eligible, text, predictedReading } = predictConfirmationText(toolUseBlock);
  if (!eligible) return;

  const key = makeCacheKey(sessionEntry.sessionId, text);
  if (speculationCache.has(key) || pendingSpeculations.has(key)) return; // dedupe

  const correlationId = mintCorrelationId(sessionEntry.sessionId, 'speculation');
  // SPECULATOR OWNS BILLABLE SIDE.
  costTracker.recordElevenLabsStreamingStarted(text.length, correlationId);

  const promise = (async () => {
    const useMC = sessionEntry.voiceLatency.flags.useMultiContext === true;
    const client = new ElevenLabsStreamClient({ apiKey, multiContext: useMC });
    const bufs = [];
    try {
      const opts = { onAudio: (chunk) => bufs.push(chunk) };
      if (useMC) opts.contextId = `spec_${correlationId}`;
      await client.synth(text, opts);
      speculationCache.set(key, {
        audioBuffer: Buffer.concat(bufs),
        contentType: contentTypeForFormat(client.outputFormat),
        correlationId,
        completeAt: Date.now(),
        ttlMs: TTL_MS,
      });
      enforceCaps(sessionEntry.sessionId);
      costTracker.recordElevenLabsStreamingTerminal(correlationId, 'completed', text.length);
      recordOutcome(correlationId, 'speculation_completed', { meta: { sessionId: sessionEntry.sessionId, text_chars: text.length } });
    } catch (err) {
      costTracker.recordElevenLabsStreamingTerminal(correlationId, 'failed', text.length);
      recordOutcome(correlationId, 'speculation_failed', { meta: { sessionId: sessionEntry.sessionId, error: err.message } });
    } finally {
      pendingSpeculations.delete(key);
    }
  })();
  pendingSpeculations.set(key, promise);
}

export function consumeSpeculation(sessionId, text) {
  const key = makeCacheKey(sessionId, text);
  const entry = speculationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.completeAt > entry.ttlMs) {
    speculationCache.delete(key);
    return null;
  }
  speculationCache.delete(key); // single-use
  return entry;
}

export function pruneForSession(sessionId) {
  for (const key of [...speculationCache.keys()]) {
    if (keyBelongsToSession(key, sessionId)) speculationCache.delete(key);
  }
}
```

### §3.5 Cache-hit short-circuit in keys.js

`streamConfirmationViaElevenLabs` gains a top-of-function check:

```
const cached = consumeSpeculation(sessionId, text);
if (cached) {
  res.set('Content-Type', cached.contentType);
  res.set('Transfer-Encoding', 'chunked');
  res.set('Cache-Control', 'no-store');
  res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
  res.set('X-Voice-Latency-Source', 'speculation_cache_hit');
  res.write(cached.audioBuffer);
  res.end();
  recordOutcome(cached.correlationId, 'speculation_hit', {
    meta: { sessionId, source: 'confirmation', bytes: cached.audioBuffer.length },
  });
  return;
}
// existing streaming path unchanged — emits its own correlationId
recordOutcome(null, 'speculation_miss', { meta: { sessionId, text_preview: text.slice(0, 60) } });
```

Note: hit path does NOT call `recordElevenLabsStreamingStarted` /
`Terminal`. The speculator already did. Cost-tracker invariant holds:
`charsStarted = charsCompleted + charsCancelled + charsFailed`.

### §3.6 Telemetry outcomes added

`voice-latency-telemetry.js`:
- Extend `SERVER_OUTCOMES`:
  + `speculation_completed`
  + `speculation_cancelled`
  + `speculation_failed`
  + `speculation_hit`
  + `speculation_miss`

### §3.7 Flag + env

`voice-latency-config.js`:
- Add `'VOICE_LATENCY_SPECULATION'` to `SNAPSHOTTED_FLAGS` array
- Add `speculation: parseBool(process.env.VOICE_LATENCY_SPECULATION)` to `snapshotFlagsForSession`'s return

`ecs/task-def-backend.json`:
- Add `{ "name": "VOICE_LATENCY_SPECULATION", "value": "false" }` env var

### §3.8 confirmations_enabled tracking

`sonnet-stream.js handleTranscript`:
- After parsing `msg.confirmations_enabled`, stamp on
  `entry.lastTranscriptHadConfirmationsEnabled = !!msg.confirmations_enabled`
  so the speculator can check at tool_use-completion time without
  re-reading the original transcript message.

## §4 Cost (corrected, single rate)

- ElevenLabs Flash actual: `$0.000050 / char` (separate prep commit
  updates `cost-tracker.js:19-20` from `0.000030`).
- Speculative synth on every eligible `record_reading` / `record_board_reading`:
  ~50-100 chars × $0.000050 = **$0.0025 - $0.005 per speculation**.
- Cache hit (text matches): synth cost was the same one user would
  have paid live. NET COST DELTA: 0.
- Cache miss (text differs from final): wasted speculation = one
  full synth. Live path runs second synth.
  **NET COST DELTA per miss: 1 wasted synth = ~$0.003.**
- At hit rate H: average extra cost per eligible turn = `(1 - H) × $0.003`.
- At H=0.7: ~$0.001/turn × 1000 turns/day = $1/day overhead.

## §5 Failure modes table

| Failure | Detection | Handling |
|---|---|---|
| ElevenLabs synth fails | `client.synth` throws | `recordElevenLabsStreamingTerminal('failed')` + `recordOutcome('speculation_failed')`; cache entry never set; iOS POST falls through to live path |
| iOS POSTs before speculation completes | `consumeSpeculation` returns null | Falls through to live path; `recordOutcome('speculation_miss')` |
| iOS POSTs same text twice in session | First consume deletes entry | Second POST gets miss → live path; acceptable |
| Speculator called twice for identical (sessionId, text) | `pendingSpeculations.has(key)` check | Second call is no-op |
| Session ends while speculations pending | `session_stop` → `pruneForSession` | Pending promises resolve into nothing; entries pruned; cancellation telemetry emitted |
| Cache RAM unbounded | per-session 50, global 1000, TTL 10s, LRU eviction | Bounded |
| Cost-tracker double-count | Speculator is sole billable; hit-path is bytes-only | Asserted by test that mocks both paths + checks counters |
| Multi-instance backend | Currently single-instance (CLAUDE.md) | Documented as out of scope; future Redis required for cross-instance cache |

## §6 Test surface

| Test file | Coverage |
|---|---|
| `predict-confirmation-text.test.js` | Eligibility + circuit coercion + value normalisation + confidence gate + polarity-false suppression + every field in FRIENDLY_NAMES |
| `loaded-barrel-speculator.test.js` | Happy path, in-flight dedupe, cap enforcement, TTL expiry, gate checks (flag off / confirmations_enabled false / stream_confirmations false), pruning on session_stop, ElevenLabs failure |
| `keys.js cache-hit test extension` | Hit serves cached bytes + correct header set + recordOutcome 'speculation_hit'; miss falls through to existing path |
| `predict-vs-bundle parity.test.js` | For each (field, value, circuit, confidence) tuple, assert `predictConfirmationText(toolUseInput) === buildConfirmationText(...)` for the final emission |
| Harness scenarios | `speculation_hit_npts.yaml`, `speculation_miss_clear_and_re_record.yaml`, `speculation_concurrent_dedupe.yaml` |
| Cost-tracker invariant test | After 100 mixed hit/miss/fail scenarios, assert `charsStarted = charsCompleted + charsCancelled + charsFailed` |

Pass criterion for the harness suite:
- `speculation_hit_npts.yaml`: end-to-end audible P50 ≤ 2500ms (hit path)
- Cost tracker invariant green across 100-run mixed scenario sweep

## §7 Rollout

1. **Prep commit (separate)**: update `cost-tracker.js` ELEVENLABS rate
   `0.000030` → `0.000050`. Adds test asserting new rate. Lands first
   so cost math everywhere is consistent.
2. **Bundler export commit**: export `buildConfirmationText`,
   `synthesiseConfirmations`, `CONFIRMATION_MIN_CONFIDENCE`,
   `CONFIRMATION_FRIENDLY_NAMES`. Tests assert no behavioural change.
3. **predict-confirmation-text commit**: new shared helper + tests.
   Bundler refactored to call it. Parity test asserts no drift.
4. **Stream-assembler hook commit**: add `onCompletedToolUse` opt to
   `assembleStream` + `runToolLoop`. Tests assert backward compatibility.
5. **Telemetry outcomes commit**: extend SERVER_OUTCOMES set + tests.
6. **Speculator commit**: new module + cache + tests + harness scenarios.
7. **Wire-in commit**: `sonnet-stream.js` passes `onCompletedToolUse` to
   `runToolLoop`; `keys.js` consumes cache; flag added; env var added.
8. **Soak 24h** with `VOICE_LATENCY_SPECULATION=false`.
9. **Flip to true**. Monitor hit-rate via `voice_latency.speculation_*`
   telemetry. Roll back if hit rate < 50% (cost > value).

## §8 What v3 still doesn't solve

- Non-`record_reading`/`record_board_reading` paths (scripted writes,
  dialogue-engine wire-emit) — no `tool_use` to hook. Future v4 could
  hook at the bundler boundary instead, but that's after `message_stop`
  so the win shrinks.
- The Sonnet 4.2s tool-loop floor for non-regex transcripts. Speculation
  shaves the TTS round-trip (~470ms → ~50ms cache hit), getting us
  from ~4.55s to ~4.18s. Still well above the 2-2.5s target for the
  Sonnet path.
- The 2-2.5s target for Sonnet-driven turns requires either Stage 4
  fast-path (deployed, 822ms measured) OR Stage 6 prompt redesign for
  single-round extraction (separate sprint).

## §9 Effort

| Phase | Days |
|---|---|
| 1. Cost-rate prep commit | 0.25 |
| 2. Bundler export refactor | 0.5 |
| 3. predict-confirmation-text + parity tests | 1 |
| 4. Stream-assembler hook | 1 |
| 5. Telemetry outcome enum extension | 0.25 |
| 6. Speculator module + tests | 2 |
| 7. Wire-in (sonnet-stream + keys.js) | 1 |
| 8. Harness scenarios + STAGE0_RESULTS_SPECULATION.md | 1 |
| 9. 24h soak + telemetry analyser | 1 |
| **Total** | **8 days** |

## §10 Sanity gates BEFORE coding

Before any commit lands:
1. Run `predict-vs-bundle parity.test.js` against the current bundler.
   If parity fails on day 1 of phase 3, the value-normalisation contract
   is more brittle than v3 assumes — revisit before continuing.
2. Manually run the stream-assembler hook against a recorded Sonnet
   stream fixture (already captured in
   `tests/fixtures/stage6-stream-fixtures/` if present, else capture
   one from a harness session). Assert `onCompletedToolUse` fires
   strictly before `message_stop`.
3. With everything off-flag, run the existing 5 baseline harness
   scenarios. Zero regression vs current measurements.
