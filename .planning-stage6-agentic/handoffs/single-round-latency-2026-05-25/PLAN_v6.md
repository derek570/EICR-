# Single-Round Latency Sprint — Plan v6

**Date:** 2026-05-25
**Status:** DRAFT — pending round 6 review.
**Supersedes:** PLAN_v5.md. SURGICAL revision closing Codex round-5 BLOCKER (B-v5.1 cost-tracker pre-text abort still leaves chars in billable aggregate) + 2 IMPORTANTs (I-v5.1 decrementExpectedAcks key, I-v5.2 G0 gate pairing).

**Read PLAN_v3.md, PLAN_v4.md, and PLAN_v5.md alongside this file.** v6 only describes deltas from v5.

---

## §A — v6 pivot deltas

### Pivot 11.4 — Move `recordElevenLabsSpeculativeStarted()` to the text-sent boundary (closes Codex B-v5.1)

**Problem identified by Codex:** v5's `cancelledBeforeTextSent` flag only skipped `charsCancelled`, but `recordElevenLabsSpeculativeStarted()` at `loaded-barrel-speculator.js:182-183` already incremented `charsStarted` AND the legacy billable aggregate `elevenLabsCharacters` BEFORE `client.synth()` was called at line 251-257. So pre-text aborts still inflated the billable counters. The v5 fix preserved the signature but did not preserve cost integrity.

**v6 design (Codex's recommended Option 1):** Move `recordElevenLabsSpeculativeStarted()` to the text-sent boundary — immediately before `client.synth()`. If abort fires before that boundary, the speculator never enters the cost ledger at all.

Concretely, restructure `loaded-barrel-speculator.js:_speculate()` from:

```js
// CURRENT (line 182-257):
const correlationId = mintCorrelationId(sessionId, 'loaded_barrel');
if (!costTracker.recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)) return;

const controller = new AbortController();
pendingControllers.add(controller);
cacheSet({ ... });
recordOutcome(correlationId, 'loaded_barrel_started', { ... });

let resolvedApiKey;
try { resolvedApiKey = await _resolveApiKey(); } catch (err) { ... }
// ... key resolution + client construction (~20 lines)

client.synth(expandedText, { ... });  // ← text actually sent here
```

To:

```js
// v6 design:
const correlationId = mintCorrelationId(sessionId, 'loaded_barrel');
const controller = new AbortController();

// Open the cache entry early (so cachePeek de-dup works); register the
// abort surface; but DO NOT touch the cost ledger yet.
pendingControllers.add(controller);
pendingByCorrelation.set(correlationId, { slot: { field, circuit, boardId }, controller, cacheKey });
cacheSet({ cacheKey, ..., correlationId, promise, resolvePromise, controller, costRegistered: false });
recordOutcome(correlationId, 'loaded_barrel_speculate_began', { ... });  // telemetry only, no ledger

let resolvedApiKey;
try { resolvedApiKey = await _resolveApiKey(); } catch (err) {
  // Abort path BEFORE text sent. No ledger entry to reverse.
  pendingControllers.delete(controller);
  pendingByCorrelation.delete(correlationId);
  resolvePromise(null);
  cache.delete(cacheKey);
  recordOutcome(correlationId, 'loaded_barrel_pretext_abort', { reason: 'key_resolution_failed' });
  return;
}

let client;
try { client = clientFactory({ apiKey: resolvedApiKey, outputFormat }); } catch (err) {
  // Same pre-text abort handling.
  /* ... */
  return;
}

// Check if abortBySlot has fired between cacheSet and now.
if (controller.signal.aborted) {
  pendingControllers.delete(controller);
  pendingByCorrelation.delete(correlationId);
  resolvePromise(null);
  cache.delete(cacheKey);
  recordOutcome(correlationId, 'loaded_barrel_pretext_abort', { reason: 'aborted_by_fast_tts_hint' });
  return;
}

// NOW open the cost ledger — this is the actual text-sent boundary.
if (!costTracker.recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)) {
  // Dedupe or invalid input. Roll back the abort surface but no ledger entry to reverse.
  pendingControllers.delete(controller);
  pendingByCorrelation.delete(correlationId);
  resolvePromise(null);
  cache.delete(cacheKey);
  return;
}

// Mark the cache entry so its subsequent terminal calls know the ledger
// IS open (for `recordElevenLabsSpeculativeTerminal` calls in the
// .then() / .catch() success and failure paths).
const entry = cache.get(cacheKey);
if (entry) entry.costRegistered = true;

client.synth(expandedText, {
  onAudio: (buf) => { if (buf && buf.length) audioChunks.push(buf); },
  signal: controller.signal,
})
.then((_timings) => { /* ... existing success path, calls recordElevenLabsSpeculativeTerminal('completed') ... */ })
.catch((err) => { /* ... existing failure path ... */ });
```

**Critical guard:** the existing `.then()` / `.catch()` paths that call `recordElevenLabsSpeculativeTerminal(correlationId, 'completed' | 'failed' | 'cancelled')` must consult the cache entry's new `costRegistered` flag before recording. If `costRegistered === false`, skip the ledger call (the speculator aborted pre-text and the ledger was never opened). New helper:

```js
function _maybeRecordTerminal(correlationId, terminal, opts = {}) {
  const entry = cache.get(cacheKeyForCorrelation(correlationId));
  if (entry?.costRegistered === true) {
    costTracker.recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts);
  } else {
    // Telemetry only — speculator never opened the ledger.
    recordOutcome(correlationId, 'speculative_terminal_skipped', {
      meta: { terminal, reason: opts.reason ?? null, cost_registered: false },
    });
  }
}
```

`abortBySlot()` calls `_maybeRecordTerminal(correlationId, 'cancelled', { reason: 'cancelled_by_fast_tts_hint', cancelledBeforeTextSent: !entry?.costRegistered })` — so the same code path covers (a) abort before text sent (no ledger entry, telemetry only) AND (b) abort after text sent (ledger gets 'cancelled' with the legacy charsCancelled bucket).

**Cost integrity invariants restored:**
- `charsCompleted + charsCancelled + charsFailed === charsStarted` — preserved (every Started increment has a matching Terminal).
- `elevenLabsCharacters` only includes chars that actually reached `client.synth()` — fixed.
- `elevenLabsSpeculativeWastedChars = charsStarted - charsServed` — preserved with correct meaning.
- Pre-text aborts: 0 chars in any cost bucket, single telemetry event for observability.

**v5's `opts.cancelledBeforeTextSent` becomes vestigial.** v6 keeps the flag in the `recordElevenLabsSpeculativeTerminal` signature for diagnostic purposes (callers may pass it for telemetry), but the cost ledger never sees a pre-text terminal because `_maybeRecordTerminal` filters those out at the `costRegistered === false` gate. The flag is now belt-and-braces; the structural fix (Started moved late) is the actual correctness contract.

Tests at `cost-tracker.test.js` updated:
- New case: pre-text abort → no `charsStarted`, `elevenLabsCharacters`, `charsCancelled` increments. `voice_latency.speculative_terminal_skipped` event emitted.
- New case: text-sent abort → `charsStarted`, `elevenLabsCharacters` incremented; `charsCancelled` incremented; `voice_latency.speculative_terminal_reason` event emitted with `reason: 'cancelled_by_fast_tts_hint'`.
- Existing case: completed normal speculation → unchanged behaviour (text sent, ledger opened, completed normally).
- New invariant assertion: `charsCompleted + charsCancelled + charsFailed === charsStarted` at end of every test run.

Speculator tests at `loaded-barrel-speculator-abort-by-slot.test.js` updated:
- `abortBySlot` fires BEFORE `_resolveApiKey()` returns → no ledger entry, no `recordElevenLabsSpeculativeStarted` call.
- `abortBySlot` fires AFTER `client.synth()` begins → ledger opened with `charsStarted`, terminated with `'cancelled'`, `voice_latency.speculative_terminal_reason` event emitted.

### Pivot 8.3 — `decrementExpectedAcks` keyed by `regex_fast_correlation_id` (closes Codex I-v5.1)

**Problem identified by Codex:** v5's fast-TTS rejection path (409/422) was supposed to call `decrementExpectedAcks(sessionId, turnId)` to keep the finalizer's expected-ACK count accurate. But the fast-TTS HTTP endpoint doesn't know the server-side `turnId` — that's minted inside `runLiveMode()` AFTER the WS transcript arrives. The decrement could be deferred via `session.pendingAckDecrements`, but v5 didn't specify how the deferred decrement found its target turn.

**v6 design:** Switch the decrement key from `turnId` to `regex_fast_correlation_id` (the same client-minted UUID iOS sends in BOTH the fast-TTS POST AND the WS transcript). The fast-TTS endpoint and the finalizer both know this id.

`src/extraction/voice-latency-turn-summary.js`:
```js
// pendingAckDecrements stores rejected fast-TTS attempts BEFORE their
// corresponding finalizer is armed. Keyed by correlation_id (the one
// minted by iOS, passed in both the fast-TTS POST body and the WS
// transcript's regex_fast_correlation_id).
//
// startAudioFinalizer() consults this map by the SAME correlation_id
// (looked up from session.fastPathCorrelationIdByTurn[turnId]) and
// subtracts the cached decrement from expected_acks before arming the
// timer. Pop the entry on arm.
//
// Entries auto-expire after 60s to prevent leak if iOS sends a
// rejection-bound POST and then the WS transcript never reaches the
// session (e.g. socket drop mid-utterance).
const pendingAckDecrements = new Map();  // correlationId -> { sessionId, expires_at_ms }

export function decrementExpectedAcksByCorrelation(sessionId, correlationId) {
  const finalizer = findFinalizerByCorrelation(sessionId, correlationId);
  if (finalizer) {
    finalizer.expected_acks = Math.max(0, finalizer.expected_acks - 1);
    if (finalizer.received_acks.length >= finalizer.expected_acks) {
      clearTimeout(finalizer.timer);
      emitTurnAudioSummary(finalizer.turnId, /*timeout=*/false);
    }
    return;
  }
  // Finalizer not armed yet — stash.
  pendingAckDecrements.set(correlationId, {
    sessionId,
    expires_at_ms: Date.now() + 60000,
  });
}

export function consumePendingDecrements(sessionId, correlationIds) {
  // Called by startAudioFinalizer with the set of correlationIds the
  // turn's WS transcript carried (from session.fastPathCorrelationIdByTurn[turnId]).
  let count = 0;
  for (const cid of correlationIds) {
    const entry = pendingAckDecrements.get(cid);
    if (entry && entry.sessionId === sessionId && entry.expires_at_ms > Date.now()) {
      count += 1;
      pendingAckDecrements.delete(cid);
    }
  }
  return count;
}
```

`startAudioFinalizer` then calls `consumePendingDecrements` to drain any stashed decrements:
```js
function startAudioFinalizer(session, turnId, bundlerEmittedCount, attemptedFastTtsCount) {
  // Drain pending decrements for fast-TTS correlations that were rejected
  // BEFORE this finalizer was armed.
  const correlationIds = session.fastPathCorrelationIdByTurn.get(turnId) ?? new Set();
  const decrementCount = consumePendingDecrements(session.sessionId, correlationIds);

  const expected_acks = bundlerEmittedCount + attemptedFastTtsCount - decrementCount;
  // ... arm timer ...
}
```

Fast-TTS endpoint (`src/routes/voice-latency-fast-tts.js`) rejection path:
```js
// On 409/422 rejection:
if (req.body.correlationId) {
  decrementExpectedAcksByCorrelation(sessionId, req.body.correlationId);
}
return res.status(409).json({ reason: 'wrong_board' });
```

**Cleanup:** a periodic sweep (or lazy expiry on read) drops entries older than 60s. Single test asserts this in `voice-latency-turn-summary-decrement.test.js`:
- Rejected fast-TTS BEFORE finalizer armed → stashed → finalizer arms → expected_acks reduced.
- Rejected fast-TTS AFTER finalizer armed → immediate decrement → no stash entry.
- Stashed entry that never gets consumed → expires after 60s, no leak.

### Pivot 11.5 — G0 telemetry gate pairing corrected (closes Codex I-v5.2)

**Problem identified by Codex:** v5's G0 gate said `voice_latency.speculative_terminal_reason` rows are "gated at ≥1 row per `loaded_barrel_skipped_fast_tts_hint` event." That paired terminal-reason with PREFLIGHT skip — pure preflight skips don't open the cost ledger and shouldn't emit terminal rows.

**v6 design:** Reword the gate:

```
| G0 | Add: `voice_latency.speculative_terminal_reason` rows emitted for every
   `loaded_barrel_aborted_by_fast_tts_hint` event (i.e. when `abortBySlot`
   fires AFTER the ledger was opened — text already sent to ElevenLabs).
   `loaded_barrel_skipped_fast_tts_hint` events (preflight skips) have
   NO corresponding terminal_reason row — they emit only the skip event
   itself, which the dashboard counts separately. |
```

Separately, the G0 gate also asserts:
- Total speculative-aborts (preflight + post-text) on fast-path turns equals total `loaded_barrel_skipped_fast_tts_hint + loaded_barrel_aborted_by_fast_tts_hint` events.
- Cost ledger invariant `charsCompleted + charsCancelled + charsFailed === charsStarted` holds across the deployment window.

This makes the gates queryable without forcing fake terminal events for speculations that never started.

---

## §B — Updated files (v6 deltas vs v5)

| File | v6 change |
|---|---|
| `src/extraction/loaded-barrel-speculator.js` | RESTRUCTURE `_speculate()` per Pivot 11.4: move `recordElevenLabsSpeculativeStarted` to the text-sent boundary; add `costRegistered` flag on cache entry; add `_maybeRecordTerminal` helper |
| `src/extraction/cost-tracker.js` | (vestigial v5 changes preserved) — `opts.cancelledBeforeTextSent` still accepted for telemetry diagnostic; ledger semantics now controlled by speculator's `costRegistered` flag |
| `src/extraction/voice-latency-turn-summary.js` | Add `decrementExpectedAcksByCorrelation` + `consumePendingDecrements` + `pendingAckDecrements` map per Pivot 8.3 |
| `src/routes/voice-latency-fast-tts.js` | Rejection path calls `decrementExpectedAcksByCorrelation(sessionId, correlationId)` BEFORE returning 4xx |

---

## §C — Updated tests (v6 deltas)

- `src/__tests__/cost-tracker-pre-text-abort.test.js` (RENAMED from v5's `cost-tracker-opts-reason.test.js`): asserts ledger integrity under pre-text and post-text abort. New invariant check `charsCompleted + charsCancelled + charsFailed === charsStarted`.
- `src/__tests__/loaded-barrel-speculator-abort-by-slot.test.js` (EXPANDED): two new cases for pre-text vs post-text abort accounting.
- `src/__tests__/voice-latency-turn-summary-decrement.test.js` (NEW per v5; signatures updated for v6's correlation-keyed decrement): three cases as above.

---

## §D — Verification gate deltas (vs v5)

| Gate | v6 delta |
|---|---|
| **G0** | Pivot 11.5: `speculative_terminal_reason` gated on `loaded_barrel_aborted_by_fast_tts_hint` events ONLY. Preflight skips counted separately. Add cost invariant assertion across deployment window. |
| **G1.c** | UNCHANGED. iOS suppression correctness gate from v4 still applies. |
| **G2** | UNCHANGED. |

---

## §E — Things NOT to break (v6 deltas vs v5)

18. **`recordElevenLabsSpeculativeStarted` signature** — unchanged. Only its CALLER moves later in `_speculate()`.
19. **Existing `.then()`/`.catch()` paths in the speculator** — preserved. New `_maybeRecordTerminal` helper guards every call site without changing the outer flow.
20. **`charsCompleted + charsCancelled + charsFailed === charsStarted` invariant** — now genuinely held (v5 broke it via the skip-charsCancelled path).
21. **`abortBySlot` API contract** — unchanged. Internal call to `_maybeRecordTerminal` is a wrapper, not a signature change.
22. **WS transcript shape** — unchanged. `regex_fast_correlation_id` field already specified in v3/v4.

---

## §F — Revision history

- **v1-v5** — see prior revisions.
- **v6** — Pivot 11.4 (move Started to text-sent boundary; `_maybeRecordTerminal` helper), Pivot 8.3 (decrementExpectedAcks keyed by correlation_id with deferred-stash), Pivot 11.5 (G0 gate pairing). Target: zero BLOCKERs from both reviewers.

---

## §G — Open questions resolved in v6

- v5's `opts.cancelledBeforeTextSent` flag is now vestigial — kept for telemetry but no longer the cost-integrity mechanism.
- `pendingAckDecrements` lifecycle: 60s expiry + lazy cleanup on read. Tested.
- G0 gate pairing: split into preflight-skip and post-text-abort branches with distinct event sources.
