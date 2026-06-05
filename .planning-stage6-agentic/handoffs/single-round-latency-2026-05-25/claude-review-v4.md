# Claude Plan-agent review — PLAN v4 (round 4)

**Date:** 2026-05-25
**Verdict:** 1 BLOCKER, 4 IMPORTANTs, 5 NITs — **DO NOT SHIP as written. One spec contradiction needs reconciling before execution; the rest are clarifications the executor will hit and lose hours on.**

## Round-3 closure verification

### My round-3 IMPORTANTs
- **NI1 (`pendingFastTtsSlots` cleanup contract):** **CLOSED** by Pivot 12. `endTurn` definition is pinned; WS-close hook spec'd; inner Set capped at 32 with overflow log; try/finally wrapper around `runLiveMode` body.
- **NI2 (`abortBySlot` API surface):** **CLOSED IN DESIGN** by Pivot 11 — `pendingByCorrelation` Map + `abortBySlot({sessionId, turnId, boardId, field, circuit})` exported method. See I3 below for one matching-predicate gap that the spec still leaves ambiguous.

### Codex round-3 BLOCKERs
- **B1 (telemetry emission model):** **CLOSED IN DESIGN** by Pivot 8 — two-row split with `turn_core_summary` (immutable at runLiveMode end) + `turn_audio_summary` (delayed finalizer with 8s timeout or ACK-completion). Shared `{sessionId, turnId, correlation_id}` keys for CloudWatch conditional-aggregation queries. v3's overclaimed `audio_played_but_ack_dropped` enum dropped → `unknown_playback_outcome` (correctness improvement).
- **B2 (two-entry-point speculator skip):** **CLOSED** by Pivot 9 — verified in codebase: `_speculate()` (`loaded-barrel-speculator.js:144-295`) IS the shared preflight; called by `onToolUseStreamed` (line 510) AND by `onSnapshotPatch` (lines 389, 401, 413, 425). Putting the skip check inside `_speculate()` covers both paths in one place. `pendingFastTtsSlotsRef` closure design is correct. Test plan asserts both entry paths.

## BLOCKERs

### B-v4.1: Pivot 11's cost-tracker contract is self-contradictory

**Where:** PLAN_v4.md:108 (Pivot 11 §A) vs PLAN_v4.md:142 (§B); `src/extraction/cost-tracker.js:254-266`

Two non-overlapping calling conventions for `recordElevenLabsSpeculativeTerminal` are specified in v4 and the executor cannot reconcile them from the plan alone:

1. **Pivot 11 §A (line 108):** `recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled_by_fast_tts_hint')` — adds a new terminal **string** value.

2. **§B "Speculator abort: text-not-yet-sent attribution" (line 142):** "v4 adds a `cancelledBeforeTextSent: bool` flag on the abort-terminal cost-tracker call. Cost-tracker's `recordElevenLabsSpeculativeTerminal` accepts the flag and adjusts the speculative-spend ledger accordingly." — adds a new opts **flag**.

The current validator at `cost-tracker.js:256-258` only accepts the three legacy strings `'completed' | 'cancelled' | 'failed'`. **As written, Pivot 11 §A's call would return false (no-op), so the cost ledger would not record the cancellation** — exactly the cost-attribution surface the pivot promises to close.

Either:
- (a) Pivot 11 §A should use `'cancelled'` (matching existing enum) and emit a SEPARATE telemetry event for the reason ('cancelled_by_fast_tts_hint'). The cost ledger uses `'cancelled'`, telemetry captures the WHY.
- (b) Plan must extend the validator to accept `'cancelled_by_fast_tts_hint'`.
- (c) Plan must rework the signature into `recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts)` so both the reason-tag AND the `cancelledBeforeTextSent` flag have a coherent home.

Without an unambiguous pick the executor will write three different prototypes and one of them will silently no-op in production. This is a CONTRACT-LEVEL gap that an executor cannot answer on their own without potentially compromising cost accounting integrity — promote to BLOCKER.

## IMPORTANTs

### I1: Pivot 10 omits the `deferredTTS` interaction (silent-loss race)

**Where:** PLAN_v4.md:74-94 (Pivot 10); `AlertManager.swift:1136-1141`, `:1178-1213`, `:1404-1410`

The existing AlertManager has a `deferredTTS` mechanism (line 1145 declaration; deferral at line 1136-1141; resume/drop at line 1178-1213) which stashes audio when `shouldDeferPlayback()` returns true (inspector still speaking). `deferredTTS` older than 6s is dropped (line 1182-1186).

Pivot 10's state machine says "fast-tts POST 200 → `AVAudioPlayer.play()`. On success: `fastPending → fastPlayed`." Two unspecified questions:

1. **Does the fast-tts playback path honor `shouldDeferPlayback`?** Plan doesn't say. If yes, fast audio gets stashed in `deferredTTS`; the state-machine transition `fastPending → fastPlayed` doesn't fire until `resumeDeferredTTSIfNeeded` plays it (or doesn't, if the 6s drop window triggers). If the 6s drop fires, `fastPending` is NEVER terminated → queued bundler in `pendingBundlerConfirmations` is NEVER drained → **user hears nothing**.

2. **Does the bundler-confirmation queue check happen BEFORE `speakBriefConfirmation` is invoked, or inside it?** Plan says "Bundler confirmation arrives for slot in `fastPending` → DO NOT play yet" but doesn't pin the insertion site. If the check happens AFTER speakWithTTS has been dispatched, the bundler audio could enter `deferredTTS` instead of the queue — bypassing Pivot 10's queue logic entirely.

Recommendation: Pivot 10 must specify (a) fast-tts playback bypasses `shouldDeferPlayback` (immediate play), and (b) bundler queue check happens at the TOP of `speakBriefConfirmation` (before speakWithTTS dispatch), and (c) `deferredTTS` drop at line 1183 transitions any matching slot `fastPending → idle` and drains its queued bundler. Without these, the state machine has uncovered transitions that produce silent loss.

### I2: Pivot 11's matching predicate doesn't specify type normalization

**Where:** PLAN_v4.md:101-104; `loaded-barrel-cache.js:309-329` (existing `invalidateBySlot` is the template)

Pivot 11 §A's predicate uses strict-equal (`===`) on `slot.boardId`, `slot.field`, `slot.circuit`. The speculator stores these in `_speculate({field, circuit, boardId, ...})`:
- `circuit` comes from `parseCircuit(slot.circuit)` (integer-or-null for record_reading at line 391) OR `null` (board_reading at line 415).
- `boardId` comes from `slot.boardId` (string-or-null).

The iOS hint will POST `circuit: integer >=0 <=99`, `boardId: string|null` per §B. With `===`:
- Speculator slot `{boardId: null}` and hint `{boardId: ""}` — `null === ""` is false; match misses.
- Speculator slot `{boardId: null}` and hint `{boardId: null}` — match works.
- Speculator slot `{circuit: null}` (board reading) and hint `{circuit: 0}` — match misses.

The existing `loaded-barrel-cache.js:309-329` `invalidateBySlot` normalizes via `String(...)` and treats nullish-or-empty consistently. Pivot 11's predicate should follow that contract: normalize null/"" boardId; document whether `circuit: 0` matches `circuit: null` (it shouldn't — board-level vs circuit-1 are different slots, but the executor needs explicit guidance).

This is a real risk because if the predicate misses, `abortBySlot` returns 0, the speculation continues to synth, the wasted-synth-cost claim ($0 vs LB-on baseline in Pivot 7) is broken in race conditions.

### I3: §B I4 falsely claims `getActiveSession` exists

**Where:** PLAN_v4.md:147; `src/extraction/active-sessions.js`

§B I4 says: "Helper `getActiveSession(sessionId)` already exists in `active-sessions.js`."

**Verified false.** Exports are: `activeSessions` (the raw Map), `recordElevenLabsUsageForSession`, `recordElevenLabsStreamingStartedForSession`, `recordElevenLabsStreamingTerminalForSession`, `getVoiceLatencyForSession`, `promoteSpeculativeToCanonicalForSession`. No `getActiveSession`.

The IMPLEMENTATION path exists — the raw `activeSessions` Map is exported and `entry.session.stateSnapshot.currentBoardId` is reachable via `activeSessions.get(sessionId)?.session?.stateSnapshot?.currentBoardId`. But the plan misnames the helper. The executor will spend 20+ min looking for a function that doesn't exist or add a new export they didn't need to. Either rename to the actual surface or note that a new helper must be added.

### I4: Pivot 8's late-arriving ACK isn't specified

**Where:** PLAN_v4.md:34-39

Pivot 8 specifies the 8s timeout and ACK-driven completion, but doesn't say what happens to a `/playback-ack` POST that arrives AFTER the finalizer has fired (i.e. `pendingAudioFinalizers.get(turnId)` returns null).

Realistic scenario: cellular network blip stretches ACK delivery to 10s; finalizer fired at 8s with `audio_finalizer_timeout_fired: true`. Then the ACK lands. Plan doesn't say:
- Silently 200 OK and drop? (currently the only sensible behaviour given the row is already emitted)
- Emit a separate `late_playback_ack` event so dashboards can correlate post-hoc?
- 404 the ACK?

I'd recommend option 2 (separate event) plus a comment in the spec noting the row is immutable. NIT-grade if the executor knows to silently drop, IMPORTANT if dashboards expect the late ACK to land in the row.

## NITs

### N1: Pivot 10 header says "4-state" but lists 5 states (idle, fastPending, fastPlayed, bundlerPlayed, resolved). Rename header or drop `resolved` (it's redundant with bundlerPlayed/fastPlayed since both are terminal for this slot's turn-lifetime).

### N2: Pivot 11 doesn't say whether `pendingControllers` (existing Set in speculator) stays or is replaced. It must STAY (shutdown() uses it at line 537-544) while `pendingByCorrelation` is ADDED in parallel. Make that explicit so the executor doesn't refactor shutdown by accident.

### N3: §D #11 says "loaded-barrel-cache.js invalidateBySlot semantics — unchanged; Pivot 11's abortBySlot uses it as the cleanup surface." Good. But Pivot 11 also calls `cache.invalidateBySlot(sessionId, slot)` — confirm the existing `invalidateBySlot(sessionId, {boardId, field, circuit})` signature matches what Pivot 11 passes. Verified: yes (cache line 309 matches). Add a comment to the plan citing the existing signature so the executor doesn't think they're inventing the API.

### N4: Pivot 12 says "the audio finalizer can still consult the slot if needed" but the audio finalizer (per Pivot 8) doesn't consult `pendingFastTtsSlots` — it consults `pendingAudioFinalizers`. The rationale comment is misleading. The real reason for ordering cleanup after `startAudioFinalizer` arms is that the finalizer's Map entry needs to exist before any ACK POST can land — `pendingFastTtsSlots` is unrelated. Reword.

### N5: Pivot 8 says `bundler_emitted_confirmations.length + (fast_tts_outcome === 'ack_played' ? 1 : 0)` as the expected ACK count. But fast_tts_outcome is determined by the ACK itself (an ACK with source=fast_tts IS what makes outcome='ack_played'). Circular. Practical fix: expected_acks = bundler_emitted_confirmations.length + (fast_tts_correlation_id != null ? 1 : 0). Reword.

## Things I verified in the codebase

| Claim | Status |
|---|---|
| `_speculate()` shared by both entry points | VERIFIED (lines 389, 401, 413, 425 for onSnapshotPatch; line 510 for onToolUseStreamed) |
| `invalidateBySlot(sessionId, {boardId, field, circuit})` exists in cache | VERIFIED (line 309) |
| `runLiveMode` body amenable to try/finally wrap | VERIFIED (single function, line 197-644, with two return paths) |
| `recordElevenLabsSpeculativeTerminal` signature can accept new flag | PARTIAL — current validator only accepts 3 strings; extending requires explicit work the plan understates |
| `getActiveSession` exists in active-sessions.js | FALSE — only `getVoiceLatencyForSession` + the raw Map |
| AlertManager has state-machine + queue insertion sites | NONE EXIST — all new code per Pivots 4/10. `deferredTTS` interaction not addressed (see I1) |
| `regex_fast_v2` location at config.js:139-177 | VERIFIED (KNOWN_SUPPORTS at line 139) |
| `pendingControllers` is slot-addressable | FALSE (confirmed at line 130 — Set with no slot metadata). Plan correctly says add `pendingByCorrelation` Map in parallel |

## Recommended verdict

**DO NOT SHIP v4 as written.** The single BLOCKER (B-v4.1) is a contract-level contradiction in Pivot 11 that the executor cannot resolve without breaking either cost accounting or the abort path. The 4 IMPORTANTs are all execution-path clarifications that, if left ambiguous, will cause silent failures in production (I1 silent-loss race on deferred TTS, I2 type-mismatch missing abort, I3 missing helper) or measurement gaps (I4 late-ACK).

**Expected work to converge:** 30-45 minutes of plan editing to reconcile the cost-tracker signature, specify the fast-tts playback's deferral behaviour, normalise the abortBySlot predicate, and correct the `getActiveSession` reference. After v5, I'd expect to ship at 0 BLOCKERs.

The 5 new pivots ARE architecturally correct in intent. v4 has closed Codex's B1 and B2 properly. The remaining BLOCKER and IMPORTANTs are precision gaps, not structural rethinks.
