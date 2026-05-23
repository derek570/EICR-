# Loaded Barrel — FINAL Plan (v10)

**Date:** 2026-05-24
**Status:** ZERO BLOCKERs — approved by Claude Plan-agent and Codex
gpt-5.5 (both reviewers independently confirmed ship-ready).
**Revision history:** v1 (7 BLOCKERs) → v2 (7) → v3 (5) → v4 (5) → v5 (6)
→ v6 (10) → v7 (5) → v8 (1) → v9 (0) → v10 FINAL (integrates v9's
IMPORTANT tightenings).
**For the executing session:** read this entire file. Companion docs
in same folder: `EXECUTION_HANDOFF.md` (start here), `REVIEW_HISTORY.md`
(all 9 review rounds for audit), `PRIOR_VERSIONS/` (v1-v9 for context).

---

## What "Loaded Barrel" is

A speculative TTS cache that synthesises confirmation audio in
parallel with Stage 6's final tool round and serves it to iOS
instantly when the inspector's POST arrives, instead of waiting for
the on-demand ElevenLabs synth.

Today: dispatch completes → bundler emits confirmation text → iOS
POSTs `/api/proxy/elevenlabs-tts` → backend synthesises live → returns
MP3 → iOS plays. The live synth is ~470ms of the audible critical
path.

With Loaded Barrel: at the moment Stage 6 dispatches a successful
`record_reading`, a speculator IMMEDIATELY computes the predicted
bundler text and starts an ElevenLabs WS synth. By the time the
bundler completes and iOS POSTs, the MP3 is already cached. Cache
HIT returns in ~30ms.

**Latency win**: ~470ms shaved off audible per turn.
**Non-goal**: this does NOT fix Sonnet's 3-round tool-loop floor
(~3.5s). To hit 2-2.5s on multi-round turns requires a separate
prompt-side single-round-preference sprint.

---

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │ Stage 6 runToolLoop (stage6-tool-loop)  │
                  │                                          │
  Sonnet stream → │  dispatchToolUseWithDiff(toolUse)        │ ← v10 NEW
                  │   ├─ snapshot perTurnWrites BEFORE       │
                  │   ├─ call existing dispatcher chain       │ ← unchanged
                  │   ├─ diff perTurnWrites AFTER             │
                  │   └─ emit onSnapshotPatch({patch, raw}) ─┼──┐
                  └─────────────────────────────────────────┘  │
                                                                │
                  ┌─────────────────────────────────────────┐  │
                  │ Loaded Barrel speculator                 │ ←┘
                  │ (loaded-barrel-speculator.js)            │
                  │                                          │
                  │  on patch.boardOps.includes(add_board):  │ ← BL1
                  │    pruneSessionUnboardedEntries()        │
                  │  on patch.boardOps.includes(select_board):│ ← v10 fix
                  │    pruneMismatchedBoardEntries()          │
                  │  on patch.readings.added/overwritten:    │ ← I4
                  │    speculate(slot, expandedText)         │
                  │      → cache.set(key, {state:'pending',  │
                  │           promise, controller, slot})    │
                  │      → elevenLabs.synth(expandedText)    │
                  │      → onSynthComplete → CAS pending→ready │
                  └─────────────────────────────────────────┘
                                       │
                                       │ MP3 bytes
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │ loaded-barrel-cache.js                   │
                  │   sha1(sessionId+turnId+boardId          │
                  │        +field+circuit+expandedText)      │
                  │   state machine (§B)                     │
                  │   per-session LRU=20, global LRU=200     │
                  │   TTL=15s                                │
                  └─────────────────────────────────────────┘
                                       │
                                       │
                  ┌─────────────────────────────────────────┐
                  │ iOS AlertManager (Swift)                 │
                  │   text = expandForTTS(bundler.text)      │
                  │   POST /api/proxy/elevenlabs-tts         │
                  │     body: {text, turnId,                 │
                  │            boardId, field, circuit}      │
                  │     headers: x-expand-version            │
                  └─────────────────────────────────────────┘
                                       │
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │ keys.js streamConfirmationViaElevenLabs  │
                  │   cached = cache.peek(key)                │
                  │   if cached.state === 'ready':            │
                  │     if cache.claim(key):                  │
                  │       serve cached.mp3Buffer (HIT)        │
                  │   if cached.state === 'pending':          │
                  │     await Promise.race(promise, 200ms)    │
                  │       (with re-peek in timer cb — §A)     │
                  │   else: existing live synth path          │
                  └─────────────────────────────────────────┘
```

---

## What changes from today

### Backend changes

| File | Change | Lines |
|---|---|---|
| `src/extraction/stage6-tool-loop.js` | Add `dispatchToolUseWithDiff` wrapper; emit `onSnapshotPatch` lifecycle hook with `{patch, raw}` payload (raw includes boardOps for prune subscribers) | ~80 |
| `src/extraction/stage6-event-bundler.js` | Move `buildConfirmationText` + `CONFIRMATION_FRIENDLY_NAMES` + `CONFIRMATION_MIN_CONFIDENCE` to new leaf module `confirmation-text.js` (no behaviour change); modify `synthesiseConfirmations` to also emit `board_id` on each confirmation; bundler ALWAYS runs at turn-end regardless of HIT/MISS for the drift detector | ~40 |
| `src/extraction/confirmation-text.js` (NEW) | Exports `buildConfirmationText` + `shouldGenerateConfirmation` + constants | ~120 |
| `src/extraction/tts-text-expander.js` (NEW) | JS port of iOS `AlertManager.expandForTTS`, ordered rule application + `expandNumbers`, includes `EXPANDER_VERSION = '2026-05-24'` constant | ~150 |
| `src/extraction/loaded-barrel-cache.js` (NEW) | LRU cache with state machine (§B), `set/peek/claim/markReady/markSuperseded/invalidateBySlot/pruneSessionUnboardedEntries/pruneMismatchedBoardEntries/pruneForSession`, TTL=15s, per-session=20, global=200 | ~250 |
| `src/extraction/loaded-barrel-speculator.js` (NEW) | Subscribes to `onSnapshotPatch`; runs `diffReadingsMap` + `diffBoardReadingsMap`; calls speculate() on added+overwritten; calls prune* on boardOps presence; enforces per-turn cap=2; manages controllers + state CAS | ~300 |
| `src/extraction/cost-tracker.js` | New methods `recordElevenLabsSpeculativeStarted(chars, correlationId)`, `recordElevenLabsSpeculativeTerminal(correlationId, reason)`, `promoteSpeculativeToCanonical(correlationId)`. Speculative sub-ledger separate from canonical streaming | ~80 |
| `src/extraction/voice-latency-config.js` | Add `VOICE_LATENCY_LOADED_BARREL` to SNAPSHOTTED_FLAGS; add `VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN=2` | ~5 |
| `src/extraction/voice-latency-telemetry.js` | SERVER_OUTCOMES additions: `loaded_barrel_started/buffered/fired/discarded/hit/hit_pending/hit_late/miss/aborted/cap_skipped/parity_mismatch/text_drift_detected`; KNOWN_SOURCES adds `loaded_barrel` | ~15 |
| `src/routes/keys.js` | `streamConfirmationViaElevenLabs` first-block cache short-circuit per §A pseudocode; `if (res.headersSent \|\| res.writableEnded) return;` guard before live fallback | ~70 |
| `src/routes/voice-latency-readiness.js` (NEW) | GET `/api/voice-latency/loaded-barrel-readiness` returns adoption % of `turnId`-POSTing clients over last 1h | ~50 |
| `ecs/task-def-backend.json` | Add 2 env vars (default OFF) | ~6 |
| Tests (new) | `tts-text-expander-parity.test.js`, `loaded-barrel-cache.test.js`, `loaded-barrel-speculator.test.js`, `loaded-barrel-keys-route.test.js`, `loaded-barrel-state-machine-fuzz.test.js`, `stage6-invariants-with-loaded-barrel.test.js`, `voice-latency-readiness.test.js` | ~1500 |
| Harness scenarios (new) | 10 YAML files in `tests/fixtures/voice-latency-scenarios/loaded_barrel/` | ~600 |

### iOS changes (split into 4a + 4b)

**Phase 4a (ships first, minimal):**
| File | Change |
|---|---|
| `Sources/Recording/AlertManager.swift` | Add `turnId` param to `proxyElevenLabsTTS(text, sessionId, source, turnId?)`; thread through from caller |
| `Sources/Services/ServerWebSocketService.swift` | Extract `result.turn_id` from extraction wire and pass to AlertManager |
| `Sources/Services/Stage6Messages.swift` | `ValueConfirmation` struct adds `let boardId: String?` with CodingKey `board_id`, `decodeIfPresent` for backwards-compat |

**Phase 4b (ships later, after 4a adoption ≥80%):**
| File | Change |
|---|---|
| `Sources/Recording/AlertManager.swift` | Add `boardId`, `field`, `circuit` to POST body; add `x-expand-version` header; extend dedupe key from `field_circuit` to `field_circuit_boardId` |
| `Sources/Services/ServerWebSocketService.swift` | Capability handshake on session_start advertises `loaded_barrel_v8a` (after 4a) → `loaded_barrel_v8b` (after 4b) |
| Bundle | Add `tts-expander-rules.json` resource + build-script that hashes it into `Bundle.expandForTTSVersion`. (Effort: 0.5d if rules already extracted; ~2d if rules need extracting from Swift code into JSON resource.) |

---

## §A — Timer-race-safe pseudocode (final)

```javascript
// keys.js streamConfirmationViaElevenLabs first block:
const turnId = req.body.turnId ?? null;
const boardId = req.body.boardId ?? null;  // 4b only; null for 4a
const field = req.body.field ?? null;
const circuit = req.body.circuit ?? null;

const requiresBoardKeying = sessionContext.jobState.boards.length > 1;
const clientHasV8b = sessionContext.capabilities.includes('loaded_barrel_v8b');

// Single-board guard (B-V7-3): if session needs board keying but
// client can't supply it, skip cache lookup entirely
if (requiresBoardKeying && !clientHasV8b) {
  // fall through to live path
} else if (turnId) {
  const key = sha1(`${sessionId}:${turnId}:${boardId || ''}:${field || ''}:${circuit || ''}:${text}`);
  const cached = loadedBarrelCache.peek(key);

  if (cached && cached.state === 'ready') {
    if (loadedBarrelCache.claim(key)) {  // CAS ready→claimed
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      res.set('X-Voice-Latency-Source', 'loaded_barrel_hit');
      res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
      res.write(cached.mp3Buffer);
      res.end();
      recordOutcome(cached.correlationId, 'loaded_barrel_hit', {
        meta: {sessionId, bytes: cached.mp3Buffer.length}
      });
      promoteSpeculativeToCanonical(cached.correlationId);
      return;  // skip ALL canonical-streaming cost recorders
    }
  }

  if (cached && cached.state === 'pending') {
    const winner = await new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      cached.promise.then((buf) => settle({type: 'spec', buf}));
      setTimeout(() => {
        // RE-PEEK before timing out — synth may have completed on same macrotask
        const recheck = loadedBarrelCache.peek(key);
        if (recheck && recheck.state === 'ready') {
          settle({type: 'spec_late', buf: recheck.mp3Buffer});
        } else {
          settle({type: 'timeout'});
        }
      }, 200);
    });

    if ((winner.type === 'spec' || winner.type === 'spec_late')
        && loadedBarrelCache.claim(key)) {
      const source = winner.type === 'spec' ? 'loaded_barrel_hit_pending' : 'loaded_barrel_hit_late';
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      res.set('X-Voice-Latency-Source', source);
      res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
      res.write(winner.buf);
      res.end();
      recordOutcome(cached.correlationId, source);
      promoteSpeculativeToCanonical(cached.correlationId);
      return;
    }

    loadedBarrelCache.markSuperseded(key);  // CAS pending→aborted only
  }
}

// Live-fallback path (existing logic):
if (res.headersSent || res.writableEnded) return;  // safety
await streamConfirmationViaElevenLabsLive(/* existing path unchanged */);
```

**Determinism note**: Node's microtask-vs-macrotask ordering guarantees
that if `cached.promise.then` and `setTimeout` are both scheduled to
fire on tick T, the promise's `.then` callback (microtask) drains
before the timer (macrotask). The timer's re-peek catches the case
where synth resolves between timer-fire and re-peek within the same
macrotask cycle. The cached promise itself MUST resolve only AFTER
`markReady` has CAS'd the state — speculator's complete-handler
ordering: `markReady(buf)` → if returns true → `entry.promise.resolve(buf)`.
This invariant is asserted by fuzz test.

---

## §B — Cache entry state machine (FROZEN)

```
   ┌─────────┐  synth ok       ┌───────┐   claim()   ┌─────────┐
   │ pending ├────────────────►│ ready ├────────────►│ claimed │ (terminal)
   └────┬────┘                 └───┬───┘             └─────────┘
        │                          │
        │ abort/supersede/cap      │ ttl_fire
        │ board_transition_prune   │
        ▼                          ▼
   ┌─────────┐                ┌──────────────┐
   │ aborted │ (terminal)     │ ttl_expired  │ (terminal)
   └─────────┘                └──────────────┘
        ▲
        │ board_transition_prune
        │ (ready entries dropped this way too)
        │
   ┌────┴────┐
   │  ready  │
   └─────────┘
```

**Allowed transitions:**
- `pending → ready` (synth completed; records `Terminal('completed')`)
- `pending → aborted` (invalidate/supersede/cap/board_transition; records `Terminal('cancelled_<reason>')`)
- `ready → claimed` (HIT; records `promoteSpeculativeToCanonical`)
- `ready → ttl_expired` (TTL; records `Terminal('cancelled_ttl')`)
- `ready → aborted` (board_transition_prune; records `Terminal('cancelled_board_transition')`)

**Forbidden transitions:**
- `claimed → *` (terminal — entry physically removed from LRU after, no state change)
- `aborted → *` (terminal)
- `ttl_expired → *` (terminal)
- `ready → pending` (no walking back)

**Audit invariant (Phase 5 test):**
Every `recordElevenLabsSpeculativeStarted(correlationId)` has
EXACTLY ONE matching `recordElevenLabsSpeculativeTerminal(correlationId, reason)` across 10,000-seed fuzz runs.

---

## §C — Phase plan + ordering

| Phase | What | Lands on | When | Flag state |
|---|---|---|---|---|
| **0** | Research: AlertManager.expandForTTS extraction + parity fixtures (ordered, step-by-step) + flush-true verification + dataflow doc | n/a | week 1 | n/a |
| **1.A** | Cost-rate prep: $0.000030 → $0.000050/char | main | wk 2 day 1 | n/a |
| **1.B** | Bundler helpers exported to `confirmation-text.js`; `synthesiseConfirmations` adds `board_id` to wire | main | wk 2 day 1-2 | n/a |
| **1.C** | `tts-text-expander.js` with parity test (50+ ordered fixtures, EXPANDER_VERSION) | main | wk 2 day 2-3 | n/a |
| **1.D** | Telemetry enum extensions | main | wk 2 day 3 | n/a |
| **1.E** | `VOICE_LATENCY_LOADED_BARREL=false` + `MAX_PER_TURN=2` declared in config + task-def | main | wk 2 day 3 | OFF |
| **1.F** | Readiness probe endpoint `/api/voice-latency/loaded-barrel-readiness` | main | wk 2 day 3 | n/a |
| **4a iOS** | turnId + board_id decode + ValueConfirmation field | TestFlight | wk 2 day 4 | n/a |
| **2** | Wrapper-diff in tool-loop; speculator + cache + lifecycle hook + per-turn cap + cost ledger | main | wk 3 days 1-4 | OFF |
| **3** | keys.js short-circuit + atomic claim + timer-race guard | main | wk 3 day 5 | OFF |
| **5** | Stage 6 invariants + state-machine fuzz test + drift detector | main | wk 4 days 1-2 | OFF |
| **6** | Harness scenarios (10) | main | wk 4 days 3-5 | OFF |
| **gate** | Readiness probe shows ≥80% 4a adoption | n/a | wait | OFF |
| **flip 1%** | Flag flip for 1% of sessions | live | wk 5+ | 1% |
| **ramp** | 1% → 10% → 50% → 100% (1 wk per step if metrics green) | live | wk 5-9 | up |
| **4b iOS** | slot fields + parity header + dedupe key + Bundle expandForTTSVersion | TestFlight | wk 6 | n/a |
| **7** | Field assessment (5-10 inspector sessions per ramp step) | n/a | continuous | n/a |

**Total effort:** 25.5 backend + 2 iOS (split 0.5+1.5) + 2 wks field assessment (concurrent with ramp).

---

## §D — Cost analysis

ElevenLabs Flash $0.000050/char (post 1.A rate prep).
Average confirmation: 50 chars × $0.000050 = $0.0025/synth.

| Scenario | Speculator cost | Live POST cost | Total | Notes |
|---|---|---|---|---|
| HIT (cache ready when POST arrives) | $0.0025 | $0 | $0.0025 | Same as today's batch |
| HIT_PENDING (POST arrives mid-synth, awaits ≤200ms, wins) | $0.0025 | $0 | $0.0025 | Net latency improvement |
| HIT_LATE (synth completes during timer re-peek) | $0.0025 | $0 | $0.0025 | Edge-case correctness |
| MISS (cache empty) | $0 | $0.0025 | $0.0025 | Today's batch path |
| WASTED (speculation invalidated by clear/correction) | $0.0025 | $0.0025 | $0.0050 | 1× extra |
| TIMEOUT_FALLTHROUGH (200ms wait → live) | $0.0025 | $0.0025 | $0.0050 | 1× extra; speculator finishes uselessly |
| TTL_EXPIRY (POST never arrived, 15s passed) | $0.0025 | $0.0025 | $0.0050 | 1× extra (next session) |
| CAP_SKIPPED (3rd+ write in turn, speculator skipped) | $0 | $0.0025 | $0.0025 | Same as today |
| PARITY_MISMATCH (cache lookup skipped) | $0.0025 | $0.0025 | $0.0050 | Should be 0% steady-state |

**Expected mix at steady state (estimated, gated by Phase 7 measurement):**
70% HIT/HIT_PENDING/HIT_LATE × $0.0025 +
20% MISS × $0.0025 +
5% WASTED × $0.0050 +
3% TIMEOUT × $0.0050 +
2% TTL/CAP × $0.0025

Average ≈ $0.00282/turn vs today's $0.0025 ⇒ **+13% TTS cost**.

1000 turns/day = +$3.20/day. At £3/cert margin: ~0.1% overhead.

**Rollback criteria (Phase 7):**
- HIT rate < 50%
- Any audibly-wrong confirmation reported by inspector
- P95 audible latency on HIT path > 2.5s
- Cost overhead > 25%
- Text-drift detector >1% mismatch over any 1h window
- `parity_mismatch` rate >0.5% over any 1h window
- State-machine audit invariant fails in production (orphaned start without terminal)

---

## §E — Hard non-goals (do NOT extend scope)

1. **Multi-round Sonnet latency reduction** — separate sprint; requires prompt-side single-round-preference work.
2. **Single-source-of-truth expandForTTS rules** — v11 candidate; would require code-gen pipeline from a master JSON to both Swift + JS expanders.
3. **WS client pooling per session** — v11 candidate; each speculation opens fresh client (~340ms cold BOS), acceptable.
4. **Generic agentic streaming framework** — this is Stage 6 specific.

---

## §F — Open questions answered post-v9 review

1. ~~Express response semantics with await Promise.race~~ — Verified safe per Node single-threaded macrotask ordering; §A pseudocode includes explicit `headersSent` guard.
2. ~~`perTurnWrites.readings` shape~~ — Confirmed flat Map keyed by `encodeReadingKey(field, circuit, boardId)` with NUL sentinel for null boardId at `stage6-per-turn-writes.js:65-75`.
3. ~~`boardReadings` separate?~~ — Yes, separate Map. Diff function `diffBoardReadingsMap` handles independently.
4. ~~`boardOps`/`observationOps` cumulative per turn?~~ — Append-only per turn. Inspection-only for `add_board`/`select_board` prune.

---

## §G — Verification gates (in order)

| Gate | Trigger | Pass condition |
|---|---|---|
| **G1** | After Phase 0 complete | Parity fixtures match iOS expandForTTS byte-for-byte across 50+ inputs incl. ordered intermediate steps |
| **G2** | After Phase 1 complete | All new tests pass; flag default OFF in deployed task-def |
| **G3** | After Phase 4a TestFlight wave | iOS clients sending `turnId` ≥ 80% via readiness probe |
| **G4** | After Phase 2 complete | Wrapper-diff PoC: 130/130 match (100 record_reading + 20 corrections + 10 clear_reading) for speculator-text vs bundler-text |
| **G5** | After Phase 3 complete | keys.js short-circuit unit tests pass; timer-race fuzz (1000 micro-timing variants) zero double-bill, zero lost audio |
| **G6** | After Phase 5 complete | State-machine fuzz (10000 seeded sequences) zero illegal transitions, zero orphaned starts |
| **G7** | Before flag flip 1% | Drift detector deployed, parity_mismatch wiring deployed, CloudWatch alerts armed |
| **G8** | After each ramp step (1→10→50→100%) | Phase 7 field session metrics within rollback criteria |

---

## §H — Files to read before starting

- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-tool-loop.js` (loop structure + understand where to insert wrapper)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-per-turn-writes.js` (verify readings + boardReadings + boardOps shape)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-event-bundler.js` (LOCAL buildConfirmationText + synthesiseConfirmations — Phase 1.B subject)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/stage6-dispatchers-circuit.js` (verify return shape so wrapper diff is sound)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/elevenlabs-stream-client.js` (verify synth(text) takes complete string only — informs Phase 0 §4)
- `/Users/derekbeckley/Developer/EICR_Automation/src/routes/keys.js:streamConfirmationViaElevenLabs` (where Phase 3 short-circuit lives)
- `/Users/derekbeckley/Developer/EICR_Automation/src/extraction/cost-tracker.js` (extend for speculative sub-ledger)
- `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Recording/AlertManager.swift:986-1082` (Phase 0 §1 — extract expandForTTS rules)
- `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Services/ServerWebSocketService.swift:848` (where extraction wire is decoded, Phase 4a turnId extraction)
- `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/Sources/Services/Stage6Messages.swift:138-165` (ValueConfirmation struct, Phase 4a board_id field)

---

## §I — Approvals

- **Plan-agent (Claude)**: v9 verdict "**v9 has ZERO BLOCKERs. Ship-ready.**" Ten IMPORTANT findings across v6-v9 integrated into v10 FINAL. All cleared.
- **Codex (gpt-5.5)**: v9 verdict "**v9 has 0 BLOCKERs.**" All IMPORTANT findings integrated into v10 FINAL.
- **9 rounds of independent paper review**: see `REVIEW_HISTORY.md` for the full chain.
