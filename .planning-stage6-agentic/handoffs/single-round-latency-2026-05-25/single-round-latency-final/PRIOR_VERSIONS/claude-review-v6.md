# Claude Plan-agent review — PLAN v6 (round 6)

**Date:** 2026-05-25
**Verdict:** 0 BLOCKERs, 2 IMPORTANTs, 1 NIT — **SHIP with documentation refinements.** v6 closes the Codex round-5 BLOCKER (B-v5.1) structurally and resolves both IMPORTANTs (I-v5.1, I-v5.2). The remaining IMPORTANTs are gaps in v6's own design surface — not regressions, but they would force the executor to invent ad-hoc plumbing.

## Round-5 closure verification

### B-v5.1 — Pre-text-abort cost ledger inflation
**CLOSED** by Pivot 11.4.

Verified at `src/extraction/loaded-barrel-speculator.js:182-187`: `recordElevenLabsSpeculativeStarted` is the very first ledger touch and runs BEFORE `_resolveApiKey()` (`:224-230`), before `clientFactory(...)` (`:242-248`), before `client.synth(...)` (`:251-257`). Confirmed at `cost-tracker.js:224-235` that `Started` increments BOTH `charsStarted` AND `elevenLabsCharacters` (the legacy billable aggregate). v5's `cancelledBeforeTextSent` flag only suppressed `charsCancelled` — Codex's BLOCKER is real.

v6's fix is the right one. By moving `recordElevenLabsSpeculativeStarted` to AFTER key resolution + client construction + the abort-already-fired guard, AND BEFORE `client.synth()`, a pre-text abort never opens the ledger:
- `charsStarted` is not incremented → no leak into `charsStarted`.
- `elevenLabsCharacters` (the mirror at `cost-tracker.js:233`) is not incremented → `elevenLabsCost` unaffected.
- `_charsByCorrelationId.set(...)` (`cost-tracker.js:229`) never fires → terminal lookups return 0 chars by default; the `_maybeRecordTerminal` guard then no-ops anyway.
- `elevenLabsSpeculativeWastedChars = charsStarted - charsServed` invariant preserved.
- `charsCompleted + charsCancelled + charsFailed === charsStarted` invariant preserved.

The `costRegistered` flag on the cache entry is the right secondary guard. By the time success/failure handlers fire, the entry's `costRegistered === true` (set immediately after the Started call at v6 design lines 93-94). For abort paths, the cache entry is deleted before the deferred `.then()/.catch()` would close. The `_maybeRecordTerminal` helper safely no-ops because either (a) entry is gone or (b) `costRegistered === false`.

### I-v5.1 — `decrementExpectedAcks(sessionId, turnId)` resolvable key
**CLOSED** by Pivot 8.3.

The correlation_id stash design is sound. iOS already mints `regex_fast_correlation_id` and sends it in both the fast-TTS POST (per Pivot 8/v3) and the WS transcript (per Pivot 8.2/v5). Both endpoints can reference it without needing server-side `turnId`.

The 60s expiry + lazy cleanup-on-read pattern handles the orphan case (socket drops mid-utterance). The `consumePendingDecrements` invariant — only consume entries matching the turn's correlation set, by sessionId — prevents cross-turn or cross-session pollution.

**Caveat:** v6 references `session.fastPathCorrelationIdByTurn` (Pivot 8.3 line 200) but this Map is not defined elsewhere in v6 or, as far as I can verify, in v5. See IMPORTANT below.

### I-v5.2 — G0 gate pairing
**CLOSED** by Pivot 11.5.

The pairing now correctly distinguishes:
- `loaded_barrel_skipped_fast_tts_hint` = preflight skip (no ledger entry, NO terminal_reason row expected).
- `loaded_barrel_aborted_by_fast_tts_hint` = post-text abort (ledger opened, terminal_reason row REQUIRED).

The additional cost invariant gate (`charsCompleted + charsCancelled + charsFailed === charsStarted` across deployment window) is a strong correctness check that should detect any future regression in the Started/Terminal pairing.

## BLOCKERs

None.

## IMPORTANTs

### I-v6.1: `session.fastPathCorrelationIdByTurn` Map is referenced but not defined

**Where:** PLAN_v6.md:200 (`const correlationIds = session.fastPathCorrelationIdByTurn.get(turnId) ?? new Set();`)

The `consumePendingDecrements` design depends on the finalizer knowing "which correlation IDs belonged to this turn." v6 calls `session.fastPathCorrelationIdByTurn.get(turnId)` but never specifies:
- Where this Map is allocated (`active-sessions.js` session entry?).
- Who populates it (presumably the WS transcript handler when it sees `regex_fast_correlation_id`?).
- When entries are cleared (per-turn at finalizer arm? On session end?).

Without this plumbing pinned, the executor will either invent it ad-hoc OR will discover after implementing Pivot 8.3 that there's no way to enumerate a turn's fast-TTS correlation IDs.

**Required fix:** add a 2-3 line spec block to Pivot 8.3:
- Allocate `session.fastPathCorrelationIdByTurn: Map<turnId, Set<correlationId>>` in `active-sessions.js` createSession.
- Populate on WS transcript: when `regex_fast_correlation_id` is read off the transcript inside `runLiveMode()`, do `session.fastPathCorrelationIdByTurn.set(turnId, (session.fastPathCorrelationIdByTurn.get(turnId) ?? new Set()).add(cid))`.
- Clear in the existing `try/finally` in `stage6-shadow-harness.js` (same place Pivot 12.2 cleans `pendingFastTtsSlots`).

### I-v6.2: `cacheKeyForCorrelation(correlationId)` helper is referenced but does not exist

**Where:** PLAN_v6.md:108 inside `_maybeRecordTerminal`: `cache.get(cacheKeyForCorrelation(correlationId))`.

Verified at `src/extraction/loaded-barrel-cache.js`: there is NO export named `cacheKeyForCorrelation` and NO secondary index from correlationId → cacheKey. The cache is keyed by `cacheKey = buildCacheKey({sessionId, turnId, boardId, field, circuit, expandedText})` — a hashed composite. Resolving correlationId → cacheKey requires either:

(a) a new reverse-index Map<correlationId, cacheKey> maintained by `set()`/`_terminate()`, OR
(b) passing the cacheKey through to `_maybeRecordTerminal` alongside the correlationId (the speculator already has both locally).

Option (b) is simpler and avoids a new data structure. The speculator's `.then()`/`.catch()` closures already capture `cacheKey` (line 265, 297 in current code). Change the helper signature to `_maybeRecordTerminal(correlationId, cacheKey, terminal, opts)`.

**Required fix:** specify in Pivot 11.4 either (a) add `correlationToCacheKey` reverse index to `loaded-barrel-cache.js` (export `cacheKeyForCorrelation`), OR (b) change helper signature to take cacheKey directly. Option (b) is preferred — less new state, cleaner contract.

## NITs

### N-v6.1: `_resetForTests` and the cost-tracker invariant assertion

Pivot 11.4 introduces a runtime invariant (`charsCompleted + charsCancelled + charsFailed === charsStarted`) but doesn't say WHERE it's checked. The plan implies "asserted in every test run" — but is it a self-assert inside `cost-tracker.js` (e.g. logged warning on summary), or is it a test-only invariant inside `cost-tracker-pre-text-abort.test.js`? Either is fine, but the executor should know which. Suggest: assert in test (cheap), not in prod (no need to add hot-path overhead). Adding "Implementation: test-only assertion in `afterEach`" to Pivot 11.4 closes this.

## Things I verified in the codebase (v6 deltas)

| Claim | Status |
|---|---|
| `recordElevenLabsSpeculativeStarted` mirrors chars into `elevenLabsCharacters` (legacy billable aggregate) | VERIFIED (`cost-tracker.js:233`) |
| `Started` currently runs at `loaded-barrel-speculator.js:182-183` BEFORE `_resolveApiKey`/client/synth | VERIFIED (`:182-187` vs `:251-257`) |
| `cachePeek` dedup at `:174-180` runs BEFORE `Started` call → unaffected by v6 move | VERIFIED |
| `loaded-barrel-cache.js` does NOT export `cacheKeyForCorrelation` or any correlation→cacheKey index | VERIFIED (exports listed at lines 61, 161, 242, 253, 278, 296, 309, 337, 355, 374) |
| `session.fastPathCorrelationIdByTurn` is not defined in v5 or v6 elsewhere | VERIFIED via grep |
| `pendingControllers` Set + `_onSynthError` abort handling pattern that v6's pre-text aborts must mirror | VERIFIED (`:297-333`) |
| Cache entries support `costRegistered` extension field | VERIFIED — `set()` (`:161-234`) creates a mutable object; adding a field is safe |

## Recommended verdict

**SHIP v6 with the two IMPORTANT fixes folded in.** The structural correctness contract is right: moving `Started` to the text-sent boundary is the only design that genuinely closes B-v5.1, and v6 implements it cleanly with `costRegistered` as the secondary guard for the deferred terminal callbacks. Pivot 8.3's correlation-keyed stash is the correct closure for I-v5.1. Pivot 11.5 properly disentangles the two abort branches.

The IMPORTANTs are not regressions — they are surfaces v6 introduces but doesn't quite fully specify. Both fixes are small (10-20 lines of design text each). Once those are pinned, the executor has an unambiguous plan.

**B-v5.1 is closed structurally.** The cost-integrity invariants Codex flagged are all preserved. v6 is the convergence draft v5 aspired to be.

## Sanity check on prior-round closures

- Round-3 B1 (telemetry emission model) — preserved (Pivot 8.1 still emits separate `turn_audio_summary` + late-ACK rows).
- Round-3 B2 (two-entry speculator skip) — preserved (no v6 changes to `_speculate()` preflight logic).
- Round-4 BLOCKER (cost-tracker signature) — superseded by v6's structural fix; the opts signature is now vestigial but harmlessly preserved per v6 §A line 128.
- Round-4 IMPORTANTs (I1-I4) — all closed in v5; no v6 regressions.
- Round-5 BLOCKER + 2 IMPORTANTs — all closed in v6 (subject to the two v6 IMPORTANTs above being addressed).
