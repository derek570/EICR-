# Claude review v2 — PLAN_v2.md

## Verdict

PLAN_v2 closes all four Codex BLOCKERs and most Claude/Codex IMPORTANTs cleanly, but introduces a wire-format mismatch on the `field_corrected` event it just added (camelCase emission vs snake_case iOS decoder), inherits an internal-inconsistency between §0/§5 headline numbers and §2 arithmetic for Stage 2 warm latency, and underspecifies the MP3-frame parser as a one-commit deliverable when AVAudioConverter in Swift cannot accept raw MP3 chunks directly. With those fixed, the plan is approve-with-caveats.

## Counts

- v1 BLOCKERs verified fixed: 6 of 7 (1 PARTIAL — Claude B2 wire shape)
- v1 IMPORTANTs verified fixed: 18 of 20 (2 PARTIAL — Codex B3 future-ambiguity; Codex I1 still has telemetry-only mitigation for angle #7)
- v1 NITs verified fixed: 13 of 13
- NEW BLOCKERs in v2: 1
- NEW IMPORTANTs in v2: 4
- NEW NITs in v2: 3

---

## v1 findings re-verified

### v1 BLOCKERs

| ID | v1 Source | PLAN_v2 §ref | Status | Note |
|---|---|---|---|---|
| Claude B1 | `req.body.source` missing | §1.6, §4.4, commit 1.5 | FIXED | iOS enum `TTSSource`, three call sites in AlertManager (confirmation/correction/question), backend defaults to `'confirmation'` when missing. Capability handshake gates it. Caveat: see NI2 — the AlertManager call sites need to actually be distinct entry points, which they are (`speakBriefConfirmation` vs `speakCriticalNotification` vs question-path via `askQuestion`). The mapping from those Swift call sites to the new enum is plausible but not pinned in the plan. |
| Claude B2 | `field_corrected` never emitted | §1.6, §4.5, commit 1.6 | **PARTIAL** | Emission added correctly from `dispatchClearReading` + same-turn correction path. But the **emitted payload `{previousValue, newValue: null}` does not match the iOS decoder** at `Stage6Messages.swift:138-165`. The iOS decoder uses `CodingKeys.previousValue = "previous_value"` (snake_case wire) and reads `reason`, not `newValue`. JS object literal `{previousValue}` will serialise as camelCase; iOS will `decodeIfPresent` it to nil. `circuit` and `field` are single-word so survive. Net: handler fires, but `previousValue` is always nil, defeating Stage 3 §6.1's `previousValue` invalidation contract. See NB1. |
| Claude B3 | AVAudioPlayer `isPlaying` not KVO | §1.6, §5.1, commit 2.1 | FIXED | New `StreamingAudioPlayer` on `AVAudioEngine + AVAudioPlayerNode + scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack)`. This is the documented Apple API for "audio audibly emitted." See NI1 — the MP3-decode pathway inside StreamingAudioPlayer is non-trivial and the plan treats it as one commit. |
| Codex B1 | Latency budget didn't add up | §2 (rewritten) | FIXED | Cold/warm split + first-byte/first-audible columns. 800 ms BOS now line-itemed per RESEARCH_APIS §A.7. Arithmetic checks out for Stage 4 cold (1,200 ms) and Stage 4 warm (400 ms). However §5 prose still claims Stage 2 warm = 1.2–1.5 s, which §2 arithmetic contradicts — see NI3. |
| Codex B2 | Suppression mutex race | §6.1, §6.4 | FIXED | Reservation states (`reserved → synthesising → first_byte → sent_to_client → suppression_active`) acquired BEFORE vendor call; mutex held through `reserved → synthesising` transition. Cancellation rules explicit. Caveat: see NI4 — the wait-up-to-3 s / wait-up-to-1.5 s timings in the decision tree have no derivation. |
| Codex B3 | Fast TTS confirms, Sonnet later asks | §7.2 step 4, §1.6 | **PARTIAL** | §7.2 catches "pending ask already exists" and "multi-candidate at iOS regex level" and "prior correction in turn." But cannot catch the case where Sonnet, on seeing the full transcript context that the iOS regex didn't have, decides to emit ask_user. That's the actual case Codex B3 described. The mitigation `transcriptContext.wasMultiCandidate` requires iOS to self-flag — but iOS only knows about its OWN regex matches, not what Sonnet would consider ambiguous. Acceptable residual risk if explicit, but §16 row 4 still implies full coverage. |
| Codex B4 | Pooled WS unsafe | §1.9, §3.F, §7.5 | FIXED | Pooling gated on Stage 0.F passing — explicit protocol evaluation of `multi-stream-input` with concrete pass criteria. Fail action ships one-shot WS per synth, accepts the 800 ms BOS cost. Good safety. |

### v1 IMPORTANTs (compressed)

| ID | Status | Note |
|---|---|---|
| Claude I1 (rollout order, suppression-store invariant) | FIXED | §9.1 step 3 flips SUPPRESSION first; §3.7 commit adds top-of-route guard + test. |
| Claude I2 (capability bit is theatre) | FIXED | §4.3 spells out defensive defaults; chunked HTTP gated on `chunked_http_audio` capability. |
| Claude I3 (latency budget) | FIXED | Subsumed by Codex B1 rewrite. |
| Claude I4 (installation-vs-board key) | FIXED | §6.2 introduces `scopeSegment` with `installation` sentinel; new module `field-scope-classifier.js`. |
| Claude I5 (idempotency collision) | FIXED | §5.2 explicit "5 s in-flight dedupe NOT 30 s replay cache." Keyed `confirm:<contentHash>` vs `fast:<...>`. |
| Claude I6 (race catalogue gaps) | FIXED | §7.4 now 7 races; R6 (pool eviction) and R7 (kill switch) added explicitly. |
| Claude I7 (Strategy A/B/C → Stage 2 incoherence) | FIXED | Strategy C is mandatory per §1.6; Stage 0.A fail action escalates to Derek. |
| Claude I8 (mic feedback timing) | FIXED | §5.1 final bullet — `pauseAudioStream` moves to first-scheduled-buffer. |
| Claude I9 (race tests) | FIXED | §10.2 lists 7 explicit race fixtures (R1–R7) with deterministic timing. |
| Claude I10 (cost reconciliation threshold) | FIXED | §9.3 raised to weekly + 30% + $5 floor. |
| Codex I1 (overstated coverage) | **PARTIAL** | §16 22-row table added. Angle #7 mitigation still says "telemetry hop + field test" — that's detection, not prevention, and Codex I1 explicitly said "Do not count telemetry-only items as mitigated." Same risk for #13 ("network drop → counted as `synth_complete` only" — gap acknowledged but not mitigated). |
| Codex I2 (60 s TTL too broad) | FIXED | §6.3 dropped to 12 s; Stage 0.B validates p99. |
| Codex I3 (double-spend tracking) | FIXED | §4.1 outcome enum split into 8 server states + 4 iOS states. |
| Codex I4 (capability negotiation) | FIXED | §4.3 explicit "missing capabilities → supports=[], all gated false" + test surface listed in commit 1.3. |
| Codex I5 (partial-JSON streaming) | FIXED | §8.1 dropped streaming JSON parser; uses focused string extractor; holds audio until `content_block_stop`. |
| Codex I6 (eligibility whitelist + schema) | FIXED | §7.3 rebuilt from `field_schema.json`; `r1_plus_r2` corrected; Ze + PFC eligible; ring values explicitly deferred to 4.5. |
| Codex I7 (transport inconsistency) | FIXED | §3.E explicit "chunked HTTP for audio; WS for session events." Stage 0.E tests HTTP chunked specifically. |
| Codex I8 (telemetry overstates) | FIXED | §4.1 server outcomes vs iOS outcomes split; `fast_heard` requires iOS ack. |
| Codex I9 (live trace fixtures brittle) | FIXED | §10.5 synthetic MP3 + synthetic protocol fixtures only. No captured real-session audio. |
| Codex I10 (kill switch vs snapshot) | FIXED | §1.12 + §4.2 + §9.2 — live override, cancels in-flight, emits `voice_latency_kill_switch_active`. |

### v1 NITs (all addressed in §17 of PLAN_v2)

All 13 NITs from both reviews are addressed in PLAN_v2 §17. The pool-TTL-vs-suppression-TTL coincidence (Claude N5) is fixed by the 12 s / 120 s split. ADR-009 location (Claude N6) is flagged for verify-and-create. Stage 0.D explicitly covers voice-clone-compat with Flash v2.5 (Claude N3). Hop list now includes `suppression_decision` (Claude N4).

---

## NEW BLOCKERs (v2)

### NB1. `field_corrected` wire-format mismatch between v2's new backend emission and the existing iOS decoder

**Where:** PLAN_v2.md §4.5 ("push `{type: 'field_corrected', circuit, field, previousValue, newValue: null}` to the session's WS event queue") + iOS decoder at `CertMateUnified/Sources/Services/Stage6Messages.swift:138-165`.

**Problem:** Two mismatches:

1. **Key casing:** PLAN_v2 §4.5 emits the JS object literal `{previousValue}` — that JSON-serialises as `"previousValue"` (camelCase). The iOS decoder declares `case previousValue = "previous_value"` (snake_case wire). `decodeIfPresent` will silently set it to `nil` instead of failing — so the handler fires but always receives `nil` for the previous value. Stage 3's §6.1 invalidation contract claims it can invalidate suppression by previousValue — that invalidation will operate on `nil` every time, which is wrong.
2. **Field names diverge:** PLAN_v2 emits `newValue: null`. The iOS decoder reads `reason` (string?), not `newValue`. `newValue` would be ignored; `reason` would always be absent. Plan does not specify whether `reason` is needed at all — but iOS's existing handler logs `msg.reason` in debug output (DeepgramRecordingViewModel.swift:2459), so existing TestFlight builds may depend on it.

§4.5 final line: "iOS handler already exists, so no iOS change needed (the dead consumer becomes a live consumer — verify the handler signature matches the emitted payload)." The plan acknowledges the verification requirement but does not perform it. The shape does not match.

**Fix:**
- Pin the wire shape in the plan to match the existing iOS decoder: `{"type": "field_corrected", "circuit": <int>, "field": <string>, "previous_value": <string|null>, "reason": <string|null>}`.
- Add an explicit "Stage 1 wire-contract test" to commit 1.6 that round-trips the emission through the iOS decoder fixture (the test surface is mentioned but the contract isn't pinned).
- Either drop `newValue` from the emission (decoder doesn't read it; no need) or add it to the iOS decoder with a corresponding CodingKey.
- Decide whether `reason` carries semantic meaning. If yes, populate it from the dispatcher (`"same_turn_correction"` vs `"clear_reading"` vs `"replace_value"`). If no, drop from the decoder.

---

## NEW IMPORTANTs (v2)

### NI1. `StreamingAudioPlayer` MP3-decode pathway treated as one commit (2.1) but AVAudioConverter does not accept raw MP3 chunks directly

**Where:** PLAN_v2.md §5.1 + commit table 2.1.

**Problem:** §5.1 says: "`AVAudioConverter` configured for MP3 input (constructed via `AVAudioFormat(streamDescription: ...)` for `kAudioFormatMPEGLayer3`) → PCM Float32 output at 22.05 kHz mono."

`AVAudioConverter` is meant for PCM-to-PCM (or AAC encode/decode in a limited shape). For MP3, the correct primitive is `AudioFileStream` (Core Audio) which parses chunked MP3 in-flight and emits `AudioStreamPacketDescription`s, which can then be fed to an `AVAudioConverter` configured for compressed→PCM, OR to `AVAudioFile`-backed read, OR directly to `AVAudioEngine` via `scheduleSegment` after writing to a file. Doing this from raw MP3 chunks (not a file URL) requires the C-level `AudioFileStreamOpen` + `AudioFileStreamParseBytes` callbacks. There are existing open-source iOS libraries that handle this (FreeStreamer, AudioStreamer); the plan does not reference them. Writing one in Swift from scratch — including MP3 frame sync word detection (which §5.1 also mentions: "Internal MPEG frame parser (MP3 frame sync words `0xFF 0xFB` etc.)") — is genuinely 2–3 days of work alone, NOT one commit.

Additionally, Stage 0.A's pass criterion is "P50 from first_chunk_received to dataPlayedBack ≤ 200 ms." If the parser is wrong, that gate fails, and the §3.A "Fail action: Replan entire sprint" fires. The plan correctly identifies the gate but understates the implementation cost behind the gate.

**Fix:**
- Either (a) evaluate FreeStreamer / AudioStreamer / similar open-source MP3-streaming library and budget a single commit for "add dependency + wrap", OR (b) switch to `pcm_16000` or `pcm_22050` output format (mentioned in §3.A fail action as a fallback) which avoids MP3 decode entirely — `AVAudioPlayerNode` accepts raw PCM frames natively. Recommend prototyping the PCM path FIRST in Stage 0.A, since it avoids the entire MP3-frame-parser commitment.
- Split commit 2.1 into 2.1a (frame-stream parser or dep wrap) + 2.1b (PlayerNode + scheduleBuffer + callback wiring), so each has a coherent WHY paragraph per CLAUDE.md.

### NI2. AlertManager call sites do not map cleanly to `TTSSource` enum

**Where:** PLAN_v2.md §4.4 + iOS AlertManager.swift entry points.

**Problem:** PLAN_v2 §4.4 says the AlertManager call sites are:
- Confirmation → `source: .confirmation`
- Correction → `source: .correction`
- ask_user → `source: .question`

Actual entry points in `AlertManager.swift`:
- `speakResponse(_:)` — appears to be the generic question/response path.
- `speakBriefConfirmation(_:)` — short confirmations.
- `speakCriticalNotification(_:)` — connection/error TTS (e.g., "Server disconnected").
- `askSlotCount`/`askSlotContent` — CCU-specific asks.

All five funnel through `speakWithTTS(_:fallbackRate:fallbackVolume:fallbackDelay:)` (line 1030) → `APIClient.shared.proxyElevenLabsTTS(text:sessionId:)`. The plan needs to (a) inject the `source` parameter at each of the FIVE entry points (not three), (b) decide where `speakCriticalNotification` lives — it's neither a confirmation, correction, nor question. Suggestion: extend enum to `.notification`. (c) `speakBriefConfirmation` is used today for BOTH plain confirmations AND correction read-backs from same-turn paths — the caller doesn't disambiguate; the bundler does. So the iOS side has to be passed an explicit `source` from the caller (currently `confirmedFieldKeys` and the bundle payload contain enough information, but it's not threaded through to AlertManager).

The plan's "AlertManager.swift callers" bullet list compresses this into three lines but the actual surgery is non-trivial.

**Fix:** Expand commit 1.5 in the plan to enumerate the exact call sites (with line numbers) and add a 4th enum case `.notification` or document that `speakCriticalNotification` bypasses the new `source` field entirely. Add a test (`AlertManagerTests`) asserting that the source value at each call site matches the new contract.

### NI3. §0 / §5 prose contradicts §2 arithmetic on Stage 2 warm latency

**Where:** PLAN_v2.md §0 item 1 + §5 opening ("After Stage 2: audible-confirmation latency goes from ~3 s today to ~2.0–2.5 s (cold WS) or ~1.2–1.5 s (warm, if 0.F enables multi-context)").

**Problem:** §2 Stage 2 warm row would be: `40 + 1,800-2,200 + 30 + 80 + 0 (BOS warm) + 150-250 + 30 + 50 = 2,180–2,680 ms`. §0 even quotes "Stage 0.F passing → Stage 2 audible drops to **~2,180–2,680 ms**" — that's the right arithmetic. But §5 (the actual stage section) says warm = 1.2–1.5 s. That number does not come from anywhere in §2. The dominating term is Sonnet TTFT (1.8–2.2 s), which is unchanged regardless of pool warmth. Either §5 is using a fictional Sonnet number, or it accidentally copy-pasted from Stage 4's budget.

This isn't fatal to the plan but it will mislead anyone reading the stage section in isolation about what to expect at Stage 2 sign-off.

**Fix:** §5 should say "After Stage 2: audible-confirmation latency goes from ~3 s today to ~3.0 s (cold) or ~2.2 s (warm). Stage 2 alone is a marginal latency win; its primary value is to land the suppression machinery for Stage 4." Update §13 exit criteria to match.

### NI4. Suppression decision-tree wait timings (3 s / 1.5 s) lack derivation

**Where:** PLAN_v2.md §6.1 "Suppression decision tree."

**Problem:**
- `reserved | synthesising | first_byte` → new caller waits up to **3 s** for state to advance.
- `sent_to_client` → hold for up to **1.5 s** for iOS ack.

No derivation given. These are blocking holds on the HTTP request layer — if Sonnet's synthesis takes 2.5 s (well within the 1.8–2.2 s TTFT + finalisation window already in §2), the second caller's 3 s wait is mostly successful. But if a regex-fast wins the race and is synthesising at 800 ms BOS + 200 ms first audio + chunked stream over 1.5 s, the second caller waits 3 s while the first finishes — and then might be told `suppressed`. The 3 s is *just* enough but not generously so.

Why does 1.5 s for ack matter? iOS playback ack fires on `ios_playback_complete`. A 5-character confirmation at 22.05 kHz mp3 32 kbps is roughly 1–1.2 s of audio. So an ack often won't arrive before the 1.5 s hold expires, in which case the plan says "cancel old, acquire new" — but the old synth was completed, the inspector heard it, and now the second caller will also synthesise and the inspector will hear two readbacks. The 1.5 s assumes the ack arrives BEFORE playback completes, which is false (ack fires AT playback complete).

**Fix:**
- Either derive these numbers from Stage 0 measurements (one of the Stage 0 gates should establish "p99 synth completion in our config = X s; set wait timeout to X + 200 ms").
- Or change the `sent_to_client` semantics: the new caller should wait until either ack arrives OR a budget timeout based on `(audio_byte_count / bitrate) + 200 ms` (i.e., when iOS would have finished playback if everything went right).
- Add a test fixture for the "ack-never-arrives" case (network drop after server emits `sent_to_client`).

---

## NEW NITs (v2)

### NN1. §12 "Stage 0.F engineering investment ~half day" understates undocumented-protocol risk

**Where:** PLAN_v2.md §12 Open Question 1.

The plan budgets half a day for evaluating `multi-stream-input`. RESEARCH_APIS.md §A source 537 was a single search result, and the endpoint protocol shape is largely undocumented per Codex B4. Half a day is reasonable for the happy path but tight if the endpoint has quirks (per-context BOS, context-id wire format, eviction semantics, audio-frame-tagging shape). Recommend budgeting a full day with the explicit failure mode "if we can't fully characterise the protocol in one day, fail Stage 0.F and ship one-shot." (This IS the fallback per §3.F, but the time-budgeting deserves the realistic estimate.)

### NN2. CLAUDE.md backend-immutability rule check

**Where:** Whole plan.

PLAN_v2 touches `src/` extensively (new files in `src/extraction/` and `src/routes/voice-latency.js`). The project CLAUDE.md immutability rule applies to "PWA-only work." This sprint is iOS + backend, NOT PWA — confirmed by §11 and §9 (no `web/` work, no PWA changes). Plan does NOT touch `web/`. **Compliance: OK.** Just flagging that reviewers should not raise this as a separate concern.

### NN3. Commit-message subjects are well-scoped for CLAUDE.md WHY rule

Spot-checked subjects in §4.7, §5.5, §6.6, §7.6:
- 1.1 telemetry module — clear WHY (no-op until stages enable).
- 1.2 feature flags + kill switch — clear WHY (per-session vs live override is the design decision).
- 2.1 StreamingAudioPlayer — WHY ties to Claude B3 (AVAudioPlayer cannot stream MP3). But see NI1 — should be split.
- 3.3 reservation-state store — clear WHY (Codex B2 race fix).
- 4.2 fast-path endpoint — clear WHY (Stage 4 main commit).

All scoped to a single concern. The CLAUDE.md "WHAT, WHY, WHY-THIS-APPROACH, CONTEXT" body discipline is supportable. **Compliance: OK.**

---

## Infrastructure-from-source check

Per CLAUDE.md MANDATORY rule: every env var added to `ecs/task-def-backend.json` must be read in code in the same commit.

PLAN_v2 §4.2 declares 6 env vars. Verifying each has a paired commit:

| Env var | Pair commit | Status |
|---|---|---|
| `VOICE_LATENCY_STREAM_CONFIRMATIONS` | commit 2.5 (task-def) + 2.4 (route reads it) | OK — but 2.4 and 2.5 are separate commits. CLAUDE.md says "the canonical change goes into the corresponding source-controlled file AND is committed in the same session." Two commits in same session = OK. |
| `VOICE_LATENCY_SUPPRESSION` | commit 3.7 (task-def) + 3.3/3.4 (store reads it) | OK |
| `VOICE_LATENCY_REGEX_FAST_TTS` | commit 6.4 (task-def) + 4.2 (endpoint reads it) | OK |
| `VOICE_LATENCY_STREAM_ASK_USER` | commit 5.3 (task-def) + 5.2 (tool-loop reads it) | OK |
| `VOICE_LATENCY_USE_MULTI_CONTEXT` | commit 6.3 (task-def) + 7.5 (pool reads it) | OK |
| `VOICE_LATENCY_KILL_SWITCH` | commit 1.2 (task-def + reader) | OK |

All 6 env vars are paired with code that reads them in the same stage. Plan also references `scripts/check-task-def-env-drift.sh` (Stage 1 verification gate) — that's the existing CI guardrail per project CLAUDE.md. **Compliance: OK.**

---

## Recommendation

**Approve with caveats.**

Land the three required tweaks before Stage 1 begins:

1. **NB1 (BLOCKER):** Pin `field_corrected` wire shape to match the existing iOS decoder. One-line plan edit; one extra contract test. Without this, Stage 3 suppression invalidation is broken for the entire sprint.
2. **NI1:** Decide MP3 vs PCM playback path in Stage 0.A. If MP3, split commit 2.1 and budget realistically. Strongly recommend prototyping `pcm_22050` first — it sidesteps the whole frame-parser commitment.
3. **NI3:** Fix §0 / §5 prose to match §2 arithmetic for Stage 2 warm latency (~2.2 s, not 1.2 s). Misleading otherwise.

NI2 and NI4 are good-to-fix during Stage 1 planning but won't block the sprint. The PARTIAL items (B2 wire shape covered by NB1; B3 future-ambiguity; I1 telemetry-only #7) are well-bounded and the residual risks are honestly documented in §16 — accept and ship.

Per §12 Open Question 3, Derek should also confirm the 1.5–2 week realistic timeline before kickoff.
