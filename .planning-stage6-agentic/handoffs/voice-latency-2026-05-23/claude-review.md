# Claude review — PLAN.md (voice-latency-2026-05-23)

## Verdict
The plan is structurally sound and impressively thorough on race-condition cataloguing, but it contains three latent BLOCKERs (a missing `req.body.source` field that the entire Stage 2 gate keys off, a `field_corrected` backend event that does not exist, and a KVO-not-observable telemetry hook) plus several ordering and budget gaps that will cause Stage 2 to land with a ~800 ms over-budget P50 and Stage 3 to silently never invalidate on corrections.

**Counts:** 3 BLOCKERs, 10 IMPORTANT, 8 NITs.

---

## BLOCKERS

### B1. `req.body.source` doesn't exist — Stage 2's central discriminator is fictional
**Where:** PLAN.md §5.2 step 1; §5.3; §6.3 ("`source = 'correction'`"); §7.2.

**Problem:** Plan repeatedly gates behaviour on `req.body.source ∈ {confirmation, correction, ask_user}`. The actual call site (iOS `APIClient.swift:847` → `proxyElevenLabsTTS`) sends only `{text, sessionId}`. The backend `src/routes/keys.js:223-290` only destructures `text, sessionId`. There is no Stage 1 or Stage 2 commit that adds a `source` field to either side, but Stage 2 commit 2.2 silently depends on it, and the suppression bypass for corrections (§6.3) and ask_user (§5.3) cannot work without it. Worse, iOS sends ALL confirmations through the same endpoint today, so `source==='confirmation'` cannot be inferred server-side either — the bundler is the only thing that knows.

**Fix:** Add a Stage 1 commit that (a) adds a `source` enum to the iOS request body (`AlertManager` knows whether it's a confirmation, correction, or question — it sets that today via `confirmedFieldKeys` and the question vs confirmation paths), (b) updates `APIClient.proxyElevenLabsTTS(text:sessionId:source:)`, (c) bumps the protocol capability version so backend can defensively default `source='confirmation'` when missing (back-compat with builds that don't send it). Land in the Stage 1 capability-handshake commit so it ships behind the bit.

### B2. `field_corrected` is referenced as if it exists; the backend never emits it
**Where:** PLAN.md §6.2 ("`field_corrected` event fires"), §6.3, §7.4 Race 5, §7.2 step 2(h), §3.4 commit subject.

**Problem:** Grep of `src/` and `packages/` confirms: there is **no** code that emits `field_corrected`. Only iOS consumes it (`Stage6Messages.swift:132`, `Stage6FieldClearer.swift`, `DeepgramRecordingViewModel.swift:2379–2459`). The backend has a `clear_reading` dispatcher and a same-turn correction code path in `stage6-per-turn-writes.js`, but neither emits a `field_corrected` event to the WS. Stage 3 commit 3.4 ("wire field_corrected into suppression invalidation") therefore has nothing to wire to, and Stage 4 Race 5 ("the `field_corrected` event fires") never fires. Suppression will not invalidate on corrections; Codex #19 is unmitigated; Race 5 is unresolved.

**Fix:** Either (a) Stage 3 must include a new commit emitting `field_corrected` from `stage6-dispatchers-circuit.dispatchClearReading` and from same-turn correction in `stage6-per-turn-writes.js`, with payload `{circuit, field, previousValue, newValue}`; OR (b) the plan re-targets the existing `clear_reading` tool-dispatcher hook directly. Either way, this is a new commit on the critical path before §6.2's invalidation contract can hold.

### B3. AVAudioPlayer `isPlaying` is not KVO-observable
**Where:** PLAN.md §5.2 ("Log `ios_first_audible_frame` on `audioPlayerDidStart` (use KVO on AVAudioPlayer's `isPlaying`)").

**Problem:** `AVAudioPlayer` has no `audioPlayerDidStart` delegate method and `isPlaying` is not declared KVO-compliant (Apple does not synthesise KVO for it). The plan's "first audible frame" measurement will silently fail to fire. Telemetry's primary success metric (P50 audible latency) cannot be collected as designed.

**Fix:** Use one of: (a) infer first-audible-frame as `play()` return time + `deviceCurrentTime - audioPlayer.deviceCurrentTime` offset; (b) compute via `AVAudioSession.outputLatency` + the `play(atTime:)` API; (c) only meaningful first-audible-frame is via `AVAudioEngine + AVAudioPlayerNode + completionHandler(callbackType: .dataPlayedBack)`. Approach (c) is the Strategy C path in §3.A, so this also re-couples the telemetry to the Stage 0 outcome.

---

## IMPORTANT

### I1. Stage 6.3 rollout order leaves a duplicate-readback window
**Where:** PLAN.md §9.1 steps 3–5.

**Problem:** Steps 3 → 4 → 5 land Stage 2 (`STREAM_CONFIRMATIONS=true`) BEFORE Stage 3 (`SUPPRESSION=true`). Stage 2 only changes the synthesis path for confirmations; iOS-emitted regex-fast TTS isn't live yet, so there's no duplicate source. Plan claims this is safe. However, Stage 2 still creates entries in the suppression store at §5.2 step 2 ("Look up suppression cache (Stage 3)") — but the gate flag is OFF. If the lookup is gated, no entries are written. If entries are written but gate is off, you get a stale cache that becomes wrong by the time Stage 3 turns on. Plan does not specify which.

**Fix:** Explicit invariant: "with `SUPPRESSION=false`, the suppression store is never read AND never written." Add a top-of-route guard and a Stage 3 verification gate covering "no suppression entries exist while flag is false."

### I2. Capability handshake does not actually gate Stage 2
**Where:** PLAN.md §4.3, §5.2.

**Problem:** Stage 2 is a server-side change (batch → streaming HTTP response on the same endpoint with same `Content-Type: audio/mpeg`). The plan claims iOS needs no change for Strategy A/B. So what does the `chunked_mp3` capability bit actually gate? An iOS Build N without the bit and a backend with `VOICE_LATENCY_STREAM_CONFIRMATIONS=true` will still receive a chunked HTTP response. `URLSession.dataTask` accepts it. If chunked HTTP causes any iOS regression (it can on iOS <17 with certain Alamofire validators that buffer differently), the bit doesn't protect against it. The bit is currently theatre for Stage 2.

**Fix:** Either (a) make `chunked_mp3` a real precondition — when missing, backend assembles the stream server-side into a single buffer before responding (defeats the latency win for old clients but is safe); or (b) acknowledge in §4.3 that Stage 2 ships unilaterally and the capability bit only matters for Stage 4's `regex_fast_tts`.

### I3. Latency budget §2 double-counts iOS hop and assumes a too-optimistic ElevenLabs handshake
**Where:** PLAN.md §2 ("Stage 2 (stream confirmations)" column).

**Problem:** Sum of new column rows: 40+5+30+50+(700–1400)+(500–800)+30+(150–250)+(100–200) = 1,605–2,805 ms; plan claims 1,200–1,800 ms. The row "Backend → ElevenLabs `stream-input` WS first audio: 150–250 ms" omits the documented "800 ms BOS handshake delay" (Research APIs §A.7) on cold opens. Stage 4's session-pooled WS (§7.6) handles this for the fast path, but Stage 2 has no pool — each confirmation opens a fresh WS. So Stage 2 will see ~800 ms more first-audio than budgeted, putting actual P50 around 2,000–2,400 ms.

**Fix:** Move the session-pooled WS (Stage 4 §7.6) earlier — promote to Stage 2 — OR honestly restate Stage 2's target as ~2.0 s. Pooling is cheap to add and removes 800 ms from every confirmation, so the right move is to fold it into Stage 2.

### I4. Suppression key has no coverage for installation-level readings (Ze, PFC) when `boardId` differs by call
**Where:** PLAN.md §6.1.

**Problem:** Canonical key uses `boardId|noboard` for supply-characteristic readings. But Ze and PFC are installation-level — there's no "the" board for them; iOS currently sets the **currently-selected** board on the message. So the *same* Ze reading dictated with board A selected then again with board B selected will have two different suppression keys (`sup_<sid>_<A>_nocircuit_Ze_0.13` and `sup_<sid>_<B>_nocircuit_Ze_0.13`) and both will speak. Codex #2 #12 explicitly call this out.

**Fix:** For installation-level field whitelist (Ze, PFC, earthing arrangement, etc.) the key must use a sentinel `installation` segment rather than `noboard`/`currentBoardId`. Add this to §6.1 normalisation rules; identify which fields are installation-level vs board-level from `field_schema.json`.

### I5. Idempotency-key collision between Stage 2 (ElevenLabsStreamClient) and Stage 4 (fast-path POST)
**Where:** PLAN.md §5.1 ("Idempotency: every `open()` call carries an `idempotency_key`"); §7.2 ("idempotencyKey").

**Problem:** Both use a UUID, but the namespace and TTL differ (30 s in §5.1 for the WS client cache; not specified in §7.2). If iOS sends the same logical confirmation through both paths (regex-fast POST + Sonnet's later confirmation) and both happen to derive their idempotency key from the same content hash (the plan never specifies how iOS picks the fast-path key — only that it's a UUID), no collision; but if the fast-path key is content-derived (sensible to dedupe iOS retries), it will collide with a different request from a different code path. Worse: §5.2's 30 s in-memory cache "returns cached audio buffer" — but the chunks may have been streamed-and-discarded already; replaying from cache requires having retained them, which the wrapper doesn't say it does.

**Fix:** Make the idempotency key namespaced (`fast:<uuid>` vs `confirm:<uuid>`) and document the cache contract: either retain full audio buffer for 30 s (costs memory) or only short-circuit if the prior request is still in-flight (LRU on outstanding requests).

### I6. Race catalogue §7.4 misses ≥2 cases
**Where:** PLAN.md §7.4.

**Problem:** Two races not catalogued:
   - **Race 6: session-pooled WS evicted mid-fast-path.** §7.6 closes the pool entry after 60 s of no traffic. If the pool closes after fast-path opens its WS but before `isFinal`, the WS dies; reconnect-and-replay (§5.1) kicks in, but pool eviction races with the per-request lifetime. Need explicit reference-counting on pool entries.
   - **Race 7: kill-switch flipped mid-stream.** §9.2 says kill-switch is checked "at the top" of each gate. But an in-flight ElevenLabs WS keeps streaming chunks after the flag flips. iOS still receives the audio; no rollback. Plan says "no errors" but doesn't address in-flight cleanup.

**Fix:** (a) Reference-count pool entries; eviction respects in-flight requests. (b) Kill-switch path includes "cancel all open ElevenLabs WSes" so in-flight stops within ~50 ms.

### I7. Stage 0.A "Strategy A/B/C selection" → Stage 2 plan mapping is incoherent
**Where:** PLAN.md §3.A fail action; §5.2 step 4–7.

**Problem:** Stage 0.A pass criterion is "at least one strategy delivers first-audible-frame ≤ 300 ms after first chunk arrival, with no clicks/gaps." Pass is reported as a single choice. But §5.2 says "Strategy A confirmed: existing URLSession path works"; §5.2 then offers Strategy B and C as conditional addenda "Add to plan only if Stage 0.A demands." There is no concrete plan for the case where ONLY Strategy C passes — that path requires AVAudioEngine + AVAudioConverter, which is a substantial iOS rework not budgeted in any Stage 2 commit. §3.A's "Fail action" only covers "no strategy passes." There's no defined action for "only Strategy C passes."

**Fix:** Add an explicit branch: "If only Strategy C passes, Stage 2 ships with backend server-side accumulate-then-send (no streaming benefit on Stage 2 — Stage 2 becomes a no-op for latency, kept only so Stage 3's machinery can land); iOS AudioQueue rework is split into a new phase that gates Stage 4." Document the latency target adjustment.

### I8. Codex #5 (mic feedback during chunked TTS) — partially addressed
**Where:** PLAN.md §5.4 ("**#5 mic capture during TTS:** unchanged from today — `pauseAudioStream()` still wraps playback").

**Problem:** `pauseAudioStream()` is called on `markTTSStarted` today. With chunked playback (Strategy A) the audio object isn't instantiated until all chunks arrive, so `pauseAudioStream` fires correctly. With Strategy B/C (incremental playback) the "start" trigger moves earlier — but the plan never reorders the pause call. With Strategy B, the pause fires when AVAudioPlayer is instantiated at frame 4, which is correct. With Strategy C (AVAudioEngine), there's no AVAudioPlayer instantiation — the pause call site must move. Plan doesn't address this.

**Fix:** Add Stage 2 commit that emits a "tts-pause-mic" signal from the response-handling layer (independent of AVAudioPlayer lifecycle), so it works regardless of playback strategy.

### I9. Test coverage for races is sparse
**Where:** PLAN.md §10.1–§10.2.

**Problem:** Races 1–5 are catalogued in §7.4 but the test list only mentions "race resolved deterministically" (one test) and "concurrent Sonnet confirmation." There are no explicit tests for: (a) async-mutex behaviour under contended fast-path + Sonnet arriving within 5 ms of each other; (b) Race 4 — fast-path eligibility rejects when `pending_ask` is set; (c) Race 5 — correction-class TTS after suppression invalidation; (d) Race 6/7 from I6 above. Stage 4 is the riskiest stage and has 3 specifically-named test fixtures.

**Fix:** Expand §10.2 with one integration test per catalogued race, named after the §7.4 race number, with fixture-based deterministic timing.

### I10. Stage 6.4 cost reconciliation threshold mismatched with §D.3 baseline
**Where:** PLAN.md §9.3.

**Problem:** §D.3 (Research APIs) estimates 6,000 chars/day post-fast-path = $0.30/day. At that volume, a 10% discrepancy = 600 chars = $0.03/day. ElevenLabs' billing reconciliation is unlikely to hit <10% accuracy on such low daily volume (rounding, in-flight requests at midnight, etc.). The alert will fire constantly.

**Fix:** Either (a) raise threshold to 30% AND raise the floor: only alert if discrepancy > 30% AND > $1/day absolute; or (b) reconcile weekly rather than daily for the small-volume case.

---

## NITs

### N1. Stage 1.2 commit message says "feat" but adds env vars that don't yet do anything
**Where:** PLAN.md §4.5.
Commit 1.2's body should be a `chore` or `feat(voice-latency): scaffold` — convention-purist nit, but the auto-commit-WHY rule in CLAUDE.md wants the WHY to be honest about no-op-until-stages-enable.

### N2. `auto_mode=true` good. But Stage 5 partial-JSON streaming would benefit from `enable_ssml_parsing=true` for prosody on punctuation in question text. Not mentioned anywhere in §8.

### N3. §1.4 says model PINNED `eleven_flash_v2_5` but research §D.1 quotes IVC pricing assuming same plan as today; suggest one-line note that current `Fahco4VZzobUeiPqni1S` voice is verified to work under Flash v2.5 (Research APIs §A.3 says it should, but the field-test in Stage 0.D doesn't explicitly verify same-voice-clone-type compatibility).

### N4. §4.1 telemetry hop list omits `suppression_decision` — Codex angle #15 wants telemetry at the decision point, and §6.5 promises it, but the canonical hop list doesn't include it.

### N5. §7.6 session-pooled WS lifecycle says "Closed on session_end OR after 60 s of no traffic." 60 s is shorter than the 60 s suppression TTL — borderline coincidence-design. Consider 120 s pool TTL.

### N6. §11 docs list says `docs/adr/` for ADR-009 — verify directory exists (it didn't last time I looked; CLAUDE.md mentions `docs/reference/` but not `docs/adr/`).

### N7. The plan ignores Codex angle #8 (regex false positives cost) on supply-characteristics readings (Ze) — those are NOT in the §7.3 whitelist's "anything else" deferred set but **are** in the whitelist (`measured_zs_ohm`). If iOS regex misreads "Ze 0.13" as "Ze 1.3" due to Flux STT confusion (the very reason this sprint exists per HANDOFF.md), the fast-path will speak it. The plan's "canonical_drift" mitigation in §7.5 only catches divergence between iOS-claimed canonical and server-derived canonical, not iOS-regex vs ground-truth.

### N8. §13 exit criterion "P50 audible-confirmation latency < 1,000 ms with Stages 2+3+4 enabled" — measured how? Plan should pin to the iOS-side `ios_first_audible_frame` hop minus `ios_ws_send`. Currently ambiguous.

---

## Top 3 BLOCKERs (summary)

1. **B1 — `req.body.source` field doesn't exist.** Stage 2's central discriminator (`req.body.source === 'confirmation'`) keys off a field that iOS does not send and the backend does not parse. The suppression bypass for corrections (§6.3) and ask_user separation (§5.3) cannot work without it. Fix: add a Stage 1 commit that ships `source` on iOS, with capability-bit fallback.

2. **B2 — `field_corrected` event is referenced but does not exist in the backend.** Only iOS consumes it; nothing in `src/` emits it. Stage 3's suppression-invalidation contract and Stage 4 Race 5 silently never fire. Fix: add a new backend commit that emits `field_corrected` from `dispatchClearReading` and same-turn correction paths.

3. **B3 — AVAudioPlayer `isPlaying` is not KVO-observable.** The "first audible frame" telemetry — the primary success metric for the entire sprint — will silently fail to fire on iOS. Fix: use `AVAudioEngine + AVAudioPlayerNode.completionHandler(callbackType: .dataPlayedBack)` (re-couples to Stage 0.A Strategy C decision), or compute via `deviceCurrentTime` offsets.
