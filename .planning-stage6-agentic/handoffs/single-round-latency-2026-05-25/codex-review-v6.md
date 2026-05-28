# Codex CLI review — PLAN v6 (round 6)

**Date:** 2026-05-25
**Reviewer:** Codex CLI
**Verdict:** 1 BLOCKER, 2 IMPORTANTs, 1 NIT — **DO NOT SHIP as written.**

v6 closes the original round-5 pre-text cost inflation by moving `recordElevenLabsSpeculativeStarted()` out of the preflight/key-resolution path. However, Pivot 11.4 introduces a new terminal-accounting hole: `_maybeRecordTerminal()` uses the live cache entry as the source of truth for whether the ledger was opened, but the cache deliberately deletes entries before several post-text terminal callbacks run.

## BLOCKERs

### B-v6.1: `_maybeRecordTerminal()` loses post-text terminal accounting after cache deletion

**Where:** `PLAN_v6.md:104-120`; `src/extraction/loaded-barrel-cache.js:83-118`, `:296-300`, `:374-382`; `src/extraction/loaded-barrel-speculator.js:258-315`; `src/routes/keys.js:451-454`

Pivot 11.4 says every existing `.then()` / `.catch()` terminal call should consult the cache entry's `costRegistered` flag:

```js
const entry = cache.get(cacheKeyForCorrelation(correlationId));
if (entry?.costRegistered === true) {
  costTracker.recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts);
} else {
  recordOutcome(correlationId, 'speculative_terminal_skipped', ...);
}
```

That is not a durable guard in the current cache lifecycle. `loaded-barrel-cache.js:_terminate()` clears timers, resolves pending awaiters, aborts the controller, then deletes the entry from `entries` at `loaded-barrel-cache.js:116`. `markSuperseded()`, TTL expiry, `invalidateBySlot()`, and `pruneForSession()` all use that path. The current speculator then records terminal state later, from either:

- the synth success handler when `markReady(cacheKey, mp3Buffer)` returns false (`loaded-barrel-speculator.js:265-282`);
- `_onSynthError()` after the controller abort rejects the synth promise (`loaded-barrel-speculator.js:297-315`).

With v6 as written, a normal post-text path can become:

1. `recordElevenLabsSpeculativeStarted(...)` succeeds, so `charsStarted` and `elevenLabsCharacters` increment.
2. iOS waits on a pending cache entry and times out; `keys.js` calls `markSuperseded(cacheKey, 'ios_post_timeout')`.
3. `_terminate()` deletes the cache entry and aborts the synth controller.
4. `_onSynthError()` runs and calls `_maybeRecordTerminal(correlationId, 'cancelled')`.
5. `_maybeRecordTerminal()` sees no cache entry and emits `speculative_terminal_skipped` instead of closing the ledger.

That leaves `charsStarted` without `charsCancelled` / `charsFailed`, breaking v6's own invariant at `PLAN_v6.md:122-124`. It also understates speculative wasted chars by failing to classify the started correlation as cancelled or failed.

This is a new cost-integrity blocker. It does not mean the round-5 pre-text bug is still open; the Started move fixes that part. The problem is the proposed guard state is attached to an object whose lifetime is shorter than the cost ledger's terminal lifecycle.

**Required fix:** make "ledger was opened" durable outside the loaded-barrel cache entry.

Acceptable designs:

- Keep a speculator-local `costRegisteredByCorrelation: Set<string>` or `Map<correlationId, { cacheKey, slot }>`; add the id immediately after `recordElevenLabsSpeculativeStarted()` succeeds; `_maybeRecordTerminal()` checks that structure, not cache presence; delete on first terminal.
- Extend `pendingByCorrelation` with `costRegistered`, and do not delete that correlation record until the terminal handler has run. `abortBySlot()` may still call terminal immediately; cost-tracker terminal idempotency can absorb the later `.catch()` / `.then()` call.

Do not fix this by only changing `cacheKeyForCorrelation(correlationId)` to `cacheKey`. `peek(cacheKey)` after `markSuperseded()` / `pruneForSession()` still returns no entry.

Add a regression test for a post-text cache termination that is not the explicit fast-TTS `abortBySlot()` happy path, e.g. Started succeeds, `markSuperseded(cacheKey, 'ios_post_timeout')` or `pruneForSession(sessionId)` runs, the synth rejects/finishes late, and the final invariant still holds.

## Round-5 Closure Check

### B-v5.1 — Pre-text-abort cost ledger inflation

**Structurally closed, subject to B-v6.1 above.**

Moving `recordElevenLabsSpeculativeStarted()` from current `loaded-barrel-speculator.js:182-187` to after API-key resolution, after client construction, and after the `controller.signal.aborted` guard prevents pre-text aborts from touching `charsStarted` or the legacy `elevenLabsCharacters` aggregate. That directly closes the bug from my round-5 review: v5's `cancelledBeforeTextSent` could skip `charsCancelled`, but it could not undo the already-incremented billable aggregate.

The remaining problem is not pre-text charging; it is post-text terminal closure when the cache entry has already been deleted.

### I-v5.1 — `decrementExpectedAcks(sessionId, turnId)` missing key

**Closed in concept.**

Pivot 8.3's switch to `regex_fast_correlation_id` is the right key shape. The fast-TTS HTTP endpoint can know it before server `turnId` exists, and the WS transcript can carry the same id into the eventual turn. The 60s expiry and sessionId check are also the right guardrails.

Claude's `fastPathCorrelationIdByTurn` concern below is real, but it is plumbing for this design, not a reason to go back to turn-keyed decrement.

### I-v5.2 — G0 gate pairing

**Closed.**

Pivot 11.5 correctly splits:

- `loaded_barrel_skipped_fast_tts_hint`: preflight skip, no ledger, no `speculative_terminal_reason` row.
- `loaded_barrel_aborted_by_fast_tts_hint`: post-text abort, ledger opened, terminal reason required.

That removes the fake-terminal pressure I flagged in v5.

## IMPORTANTs

### I-v6.1: `session.fastPathCorrelationIdByTurn` is referenced but not allocated/populated/cleared

**Where:** `PLAN_v6.md:153-200`; `src/extraction/active-sessions.js:14-15`, `:92-96`; `src/extraction/stage6-shadow-harness.js:197-200`

I agree with Claude: this is a genuine IMPORTANT, not a BLOCKER.

The correlation-keyed ACK decrement design depends on enumerating the fast-TTS correlation ids associated with a server turn. v6 calls:

```js
const correlationIds = session.fastPathCorrelationIdByTurn.get(turnId) ?? new Set();
```

but neither v6 nor the current code defines that map. `active-sessions.js` currently exports the raw `activeSessions` map and a few lookup helpers; the session entry in `sonnet-stream.js` has `voiceLatency.lastAudioSeqByCorrelation`, but no turn-to-fast-correlation index.

Required plan text:

- allocate `fastPathCorrelationIdByTurn: Map<turnId, Set<correlationId>>` on the active session entry or session object;
- populate it when the WS transcript's `regex_fast_correlation_id` is associated with the newly minted `turnId` in `runLiveMode()`;
- clear the turn's set after `startAudioFinalizer()` has consumed pending decrements, and on session teardown.

This is small and addressable. It does not change the verdict to a second blocker because the intended data source is clear and v3 already specified analogous `pendingFastTtsSlots` per-turn plumbing.

### I-v6.2: `cacheKeyForCorrelation(correlationId)` is not defined

**Where:** `PLAN_v6.md:107-108`; `src/extraction/loaded-barrel-cache.js:61-74`, `:161-233`, `:242-246`

I agree with Claude's specific point, with the caveat that B-v6.1 is the deeper issue.

The cache has no `cacheKeyForCorrelation()` export and no correlation-to-cache reverse index. The current speculator already has `cacheKey` in the `.then()` / `.catch()` closures, and v4/v5's `pendingByCorrelation` entry also includes `cacheKey`, so the simplest implementation is:

```js
_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)
```

That resolves the missing helper. It does not by itself resolve B-v6.1, because a direct `cacheKey` lookup still fails after `_terminate()` deletes the cache entry. The helper should use `cacheKey` for telemetry context if useful, but use a durable ledger-open structure for the cost decision.

## NIT

### N-v6.1: `client.synth()` is a pragmatic accounting boundary, not a literal vendor text-sent boundary

`PLAN_v6.md:124` says `elevenLabsCharacters` only includes chars that actually reached `client.synth()`. That is true with the v6 move.

It is not exactly the same as "text accepted by ElevenLabs": `ElevenLabsStreamClient.synth()` constructs the WebSocket at `elevenlabs-stream-client.js:149-150`, but sends BOS/text/EOS only inside the later `open` handler at `:194-212`. Existing streaming confirmation accounting already treats synth invocation as the billable boundary, so I am not counting this as a blocker. If the requirement is vendor-exact billing rather than backend-handoff billing, expose an `onTextSent` / `onBosSent` callback from `ElevenLabsStreamClient` and open the ledger there.

## Claude v6 Classification

| Claude item | My classification | Notes |
|---|---|---|
| I-v6.1 `fastPathCorrelationIdByTurn` missing | **IMPORTANT** | Genuine, small, must be pinned before execution. |
| I-v6.2 `cacheKeyForCorrelation` missing | **IMPORTANT as stated; BLOCKER in the surrounding guard design** | Passing `cacheKey` fixes the missing helper. The live-cache-entry guard still breaks post-text terminal accounting; tracked as B-v6.1. |

## Recommended Verdict

**DO NOT SHIP v6 as written.**

The convergence direction is good, and the exact B-v5.1 pre-text cost inflation is closed by moving Started later. But Pivot 11.4 needs one more surgical change: the terminal guard must be based on durable "ledger opened" state, not on the loaded-barrel cache entry that is intentionally deleted during abort/supersede/TTL/session-prune paths.

Once B-v6.1 is fixed, I would expect the remaining Claude items to stay IMPORTANTs only, and the plan should be shippable with those refinements folded in.
