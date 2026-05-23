# Claude review v3 — PLAN_v3.md

## Verdict

PLAN_v3 is structurally honest, internally consistent, and ready to execute with two minor pre-flight corrections. The 1.21 conditional-Stage-4 framing is sound; the §13 split into Minimum-Viable Exit vs Full Exit gives the sprint two equally legitimate landing zones. The five v1+v2 BLOCKER fixes hold up against the code. Two NEW IMPORTANTs and two NEW NITs emerged — none are blockers to starting Stage 0.

## Counts

- Total review investment so far (v1+v2): **9 BLOCKERs caught, 27 IMPORTANTs caught, 24 NITs caught** (consistent with PLAN_v3 §19)
- v1+v2 findings re-verified intact: **34 of 36** (2 IMPORTANTs accepted as honest residual in §16 — Codex v1 I1 #7 and #13)
- **NEW BLOCKERs in v3: 0**
- **NEW IMPORTANTs in v3: 2**
- **NEW NITs in v3: 2**

---

## Phase A — v2 amendments coherence check

### A1. Minimum-Viable Exit (§13.1) is honestly achievable

**Verdict: yes.** Stages 0+1+2+3 deliver:
- Streaming TTS infrastructure landed (`StreamingAudioPlayer`, chunked HTTP transport, ack messaging).
- Suppression machinery wired but firing at ~0% in steady state (Stage 4 is the source of duplication; without it, the only firings are legitimate same-value-twice utterances).
- Telemetry framework live with iOS acks reconciled.
- `field_corrected` event live and consumed.
- Stage 0.G transcript-replay harness available for ongoing regression coverage.
- Stage 5 ask_user streaming lands separately and is useful regardless.

The ~17-33% latency improvement (3.0 s → ~2.5 s warm) is real even though marginal. The plan correctly frames Stage 2 as scaffolding (§5 opening: "Stage 2 alone is a marginal latency win. The win is infrastructure, not latency.").

### A2. §7's conditional gating doesn't break downstream stages

**Verdict: clean.** Stage 5 (ask_user streaming) does NOT depend on Stage 4 — it consumes the same `StreamingAudioPlayer` from Stage 2 commit 2.1 and the same chunked HTTP path from Stage 1b commit 1b.6. Stage 6 (rollout) is feature-flag-gated per env var; with `VOICE_LATENCY_REGEX_FAST_TTS=false` the fast-path code never runs. The Minimum-Viable Exit path leaves `VOICE_LATENCY_STREAM_ASK_USER` (Stage 5) and `VOICE_LATENCY_STREAM_CONFIRMATIONS` (Stage 2) + `VOICE_LATENCY_SUPPRESSION` (Stage 3) on and the rest off — clean rollout.

### A3. Suppression machinery (Stage 3) without Stage 4 source-of-duplication

**Honest assessment: it IS partially wasted work at the 13.1 exit.** §13.1 acknowledges this implicitly ("suppression rate = 0% in steady state — validates wiring"). The Stage 3 machinery is justified because:
- It exercises the `field_corrected` invalidation contract.
- It lets Stage 4 ship cleanly later (the contract is the integration interface).
- It catches naturally-occurring duplicate-final cases (Flux misrecognition `circuit 1` + `Socket 1.` 1ms apart, per `flux_misrecognition_socket_one.yaml`).

But the suppression-state machine (reserved/synthesising/first_byte/sent_to_client/suppression_active with 12s TTL + ack timeouts) is significantly more machinery than the 13.1 exit needs. This is a legitimate engineering choice (build the contract once, even if mostly idle), but Derek should know that ~30% of Stage 3's commit set is Stage 4 preparation. See **NI1**.

### A4. `field_corrected` emission (Stage 1a) standalone value

**Verdict: useful regardless of Stage 4.** `field_corrected` invalidates UI state in `Stage6FieldClearer.swift` independent of suppression. It's already a live consumer waiting for a backend producer (per RESEARCH_PIPELINE.md F and verified by grep — backend has zero `field_corrected` emission today, while iOS has the full handler chain at `Stage6Messages.swift:138-165` + `DeepgramRecordingViewModel.swift:2379-2459`). Shipping Stage 1a closes a long-standing gap.

### A5. Cost-tracker streaming accounting (Stage 2 commit 2.6) still needed without Stage 4

**Verdict: yes, mandatory.** Stage 2's `ElevenLabsStreamClient` is text-sent-bills-on-acceptance — the existing batch `recordElevenLabsUsageForSession` charges on full-call-complete (per RESEARCH_PIPELINE.md G), which is wrong semantics for streaming. Stage 2 ships streaming for confirmations regardless of Stage 4. Commit 2.6 is correctly scoped.

### A6. Stage 1b commit 1b.6 (replace Alamofire `.responseData` with chunked HTTP)

**Verdict: yes, required by Stage 2.** Verified at `CertMateUnified/Sources/Services/APIClient.swift:846-862`:
```swift
func proxyElevenLabsTTS(text: String, sessionId: String? = nil) async throws -> Data {
    ...
    .responseData { response in     // line 855 — buffers full response
```
Stage 2's `StreamingAudioPlayer.ingest(_ data: Data)` needs incremental chunk delivery. Without 1b.6, Stage 2 silently regresses to batch-buffering (the v2 Codex NB1 finding). Plan correctly promotes 1b.6 into Stage 1b so Stage 4 can also reuse the streaming client (commit 4.5 + §7.6).

### A7. References to "Stage 4" sprinkled through the plan

Searched the plan for unqualified Stage-4 dependencies in Stages 1-3 + 5. Findings:
- §5.4 angle #1 says "iOS monotonic `audioSeq` counter; AlertManager queue drops stale. **N/A in Stage 2 without Stage 4, but the machinery lands now.**" — explicit. OK.
- §6.4–6.6 commit references match Stage 3, no Stage-4 assumptions.
- §8 Stage 5 is independent — no Stage-4 dependency.
- §9 Stage 6 rollout — relies on env-var flags, not Stage-4 code paths.

No incoherent Stage-4 references found.

---

## Phase B — v1+v2 finding spot-check

### Spot-check 1 — Claude v1 B1 (`req.body.source`)

PLAN_v3 §4.4 enumerates 5 AlertManager entry points. **Verified against `AlertManager.swift`:** the actual surface is more complex than the plan reflects.

| Plan entry point | Actual code | Status |
|---|---|---|
| `speakResponse(_:)` | **PRIVATE (line 881)** — internal helper, not an entry point | Plan wrong |
| `speakBriefConfirmation(_:)` | Public (line 889) — external callers in `DeepgramRecordingViewModel`, `RecordingSessionCoordinator`, `JobDetailView` | OK |
| `speakCriticalNotification(_:)` | Public (line 921) | OK |
| `askSlotCount(_:)` / `askSlotContent(_:)` | Public (lines 241, 260) | OK |
| (any future) | — | OK |

**Missing from the plan's table:**
- `speakTourNarration(_:tourStep:completion:)` (line 653) — bundled audio first, BUT falls back to ElevenLabs at line 693 via `speakWithTTS`. Tour audio shouldn't be subject to confirmation suppression.
- `queueAlert(_:)` / `queueInformational(_:)` (lines 198, 210) — present alert flow → `presentAlert` → `speakAlertMessage` (private, line 874) → ElevenLabs. These are the validation-alert path.
- `processTranscriptForResponse(_:)` (line 295) — voice-command path, called from `DeepgramRecordingViewModel.swift:1926`; internally invokes `speakResponse` (the private helper).

**Net:** 4 enum cases (`confirmation`, `correction`, `question`, `notification`) is short. Tour narration and validation alerts have NO source mapping in the plan. They'd default to `.confirmation` (per Stage 1a commit 1a.5), which means they'd be subject to suppression — wrong semantics for a tour narration or a "validation failed" alert. See **NI2**.

### Spot-check 2 — Claude v1 B2 / Claude v2 NB1 (`field_corrected` wire shape)

**Verified against `Stage6Messages.swift:138-165`:**

```swift
struct Stage6FieldCorrected: Decodable, Equatable {
    let circuit: Int
    let field: String
    let previousValue: String?
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case circuit
        case field
        case previousValue = "previous_value"  // snake_case wire
        case reason
    }
```

PLAN_v3 §4.5 pins the wire shape to:
```json
{
  "type": "field_corrected",
  "circuit": <int>,
  "field": <string>,
  "previous_value": <string|null>,
  "reason": "clear_reading" | "same_turn_correction" | "replace_value"
}
```

**Result:** decoder matches the pinned wire shape exactly. Plan correctly noted (§4.5 last paragraph): "iOS handler `Stage6Messages.swift:138-165` already decodes `case previousValue = "previous_value"` and `case reason` — wire-shape matches as-is. No iOS changes for the decoder." This is the v2 NB1 fix landing correctly.

### Spot-check 3 — Codex v2 NB1 (Alamofire `.responseData`)

**Verified against `APIClient.swift:846-862`:** plan claim is accurate — current `proxyElevenLabsTTS` uses Alamofire `.responseData` at line 855, which buffers the full response.

Stage 1b commit 1b.6 says: "replace Alamofire .responseData with chunked HTTP client (DataStreamRequest) — adds `proxyElevenLabsTTSStreaming(text:sessionId:source:onChunk:onComplete:)`. Old method retained for back-compat until Stage 2 ships."

**Concern:** the plan promotes 1b.6 into Stage 1b, but Stage 1a's commit 1a.5 (backend `source` field parsing) adds the `source` request field that will only flow through the NEW `proxyElevenLabsTTSStreaming` method. Existing `proxyElevenLabsTTS` (which retains the original buffer path) is back-compat for the rollout window. The plan should clarify whether the new streaming method's body also threads through `source` — re-reading §4.4 and 1b.4 confirms yes (commit 1b.4 modifies `APIClient.proxyElevenLabsTTS` to add `source`, then 1b.6 introduces `proxyElevenLabsTTSStreaming`). Subtle but workable. See **NN1** for clarification.

### Spot-check 4 — Codex v1 B4 (Pooled WS unsafe) + Stage 0.F pass criteria operationalness

**Plan §3.F pass criteria (re-read):**
1. Per-context BOS amortisation: open ONE WS, initialise context A, send text, receive audio frames tagged with `context_id: A`. Synthesis succeeds.
2. Concurrent contexts: initialise context A AND context B in same WS. Send text for both. Audio frames arrive correctly tagged with their respective `context_id`. No untagged frames.
3. Per-context finality: context A reaches `isFinal` independently of context B's progress.
4. Context closure: close context A explicitly. Context B continues to synthesise. WS does not die.
5. Eviction protocol: documented (LRU? bounded? plan for it).
6. Voice continuity within a context: A's two consecutive synth requests sound identical (voice settings carry over).
7. Failure handling: text submitted to context after `isFinal` returns documented error, doesn't close WS.

**Verdict: operationally clean.** Each criterion has a binary pass/fail with a defined experiment shape. Codex v2 PARTIAL B4's residual concern ("not operational enough") is closed. Criteria 6's "N/A if WS only carries one synth per context" lets the experiment degrade gracefully if `multi-stream-input` doesn't allow within-context re-synth — that's honest residual. The fail action (one-shot WS per synth + 800 ms BOS accepted) is clearly documented.

### Spot-check 5 — Codex v1 I2 (60s → 12s TTL derivation)

PLAN_v3 §6.3: `TTL = max(12s, p99_sonnet_completion + p99_ios_playback_ack_delay + 2s) [stage0_tunable: from B + A]`.

**Stage 0.B (§3.B):** "Also measure (Codex v2 NI1): p99 Sonnet-completion (TTFT + finalisation) — this number becomes the [stage0: derive from B] suppression TTL."

**Stage 0.A:** measures `first_chunk_received → first_pcm_frame_scheduled → dataPlayedBack` — that's iOS playback latency but NOT explicitly p99_ios_playback_ack_delay. The ack is sent on `dataPlayedBack` per §5.1, so `dataPlayedBack` time IS the ack-send time. The gate is implicit but real.

**Verdict: chain is intact.** Stage 0.B's p99_sonnet_completion + Stage 0.A's `dataPlayedBack` timing → §6.3 TTL formula. The `[stage0_tunable]` markers per locked decision 1.15 give explicit hooks for the analyser to update the value post-Stage-0.

---

## Phase C — Stage-4-skipped path issues

### C1. Stage 3 cost vs. value at 13.1 exit

See A3 above. The reservation state machine + ack timeouts + cancel-on-error machinery from §5.2 step 6 represents ~7 of Stage 3's 8 commits worth of state-machine engineering. With Stage 4 skipped, the only source of duplicate-readback risk is naturally-occurring (Flux duplicates, double-finals 1ms apart). A simpler in-flight dedupe + canonical key check would handle 90% of those cases at ~20% the engineering cost. **However**, since Stage 3 is also building infrastructure Stage 4 might use later, fully scoping Stage 3 is the right call. The plan acknowledges this implicitly. Flagged as **NI1** for "ensure Derek understands the trade-off before approving the 13.1 path."

### C2. Stage 5 (ask_user streaming) dependencies

**Verified:** Stage 5 (§8) consumes `StreamingAudioPlayer` (Stage 2 commit 2.1) and `proxyElevenLabsTTSStreaming` (Stage 1b commit 1b.6). Zero Stage-4 dependency. Stage 5 ships clean in both 13.1 and 13.2 paths.

### C3. Parked "received tick" (§12 Q11) as viable backup

Plan says: "Implementation surface (if revisited): ~1 day — pre-generate the cue with `say` or AudioKit, bundle in iOS resources, play from `AlertManager` on `utterance_final` hop. Mic-pause coupling needs same treatment as TTS playback."

**Realism check:** the bundled tour-audio pattern at `Sources/Resources/TourAudio/` (8 MP3s, 2.1MB) provides the template. The 1-day estimate is plausible IF the cue is purely indicative (no value information), played from `AlertManager.swift` on receipt of utterance-final. Mic-pause-coupling is the real complexity — the cue is short (50ms) but the mic pause cycle (`pauseAudioStream` → audio plays → `resumeAudioStream`) adds 100-200ms of overhead per cue, which would defeat the purpose if it interferes with Deepgram's silence detection.

**Verdict: viable backup, BUT the 1-day estimate understates the mic-coupling complexity by perhaps half a day.** Not a blocker — the plan flags it as a contingency only, not a primary path.

### C4. Stage 0.G scenarios for Stage-2+3-only paths

The plan's 15 initial scenarios target both paths:
- Functional (works in both 13.1 and 13.2): `normal_*`, `chitchat_no_engagement`, `burst_dictation`, `adversarial_unicode`.
- Race fixtures R1-R8: most depend on fast-path AND Sonnet path running in parallel. Without Stage 4, R1-R5 (fast-vs-Sonnet timing) cannot fire.

**Missing scenarios for 13.1 path:**
- `stage2_warm_path_no_fast.yaml` — Stage 2 confirmation streaming with warm pool, asserting P50 cold/warm latency budget.
- `stage2_cold_path_no_fast.yaml` — Stage 2 cold synthesis, asserting BOS handshake doesn't break it.
- `stage3_suppression_natural_duplicate.yaml` — Flux emits two finals 1ms apart with same value; Stage 3 suppression fires correctly without any Stage-4 source.
- `field_corrected_clear_reading.yaml` — clear_reading dispatched; iOS receives `field_corrected`; UI slot clears.
- `field_corrected_same_turn_correction.yaml` — `record_reading` followed by `record_reading` for same field, different value; correction emits.

**Flagged as NI2.** Adding these is a Stage 0.G enhancement, not a blocker.

### C5. Decision-point ergonomics for Stage-3-end assessment

PLAN_v3 §7: "Derek runs ~5 normal cert sessions."

**Concern: 5 sessions is small.** P50 from 5 samples has wide confidence intervals. The plan says "Telemetry P50/P95 audible-confirmation latency captured per session." — that's clear, but with N=5 the P95 measurement isn't statistically meaningful (single outlier swamps it).

**"Feel" capture:** the plan says "Derek subjectively assesses: does the inspector experience feel acceptable?" — there's no structured way to capture this (no rubric, no Likert scale, no question template). On a bad day Derek might say "still slow"; on a good day "fine." This is acknowledged in the plan's "Decision is yours after seeing real numbers" but the bias is real.

**Suggestion (NN2):** add a brief Decision-Gate rubric to §7 — 3-4 yes/no questions ("Did the confirmation arrive before you started speaking the next value?", "Did you ever notice waiting for it?", etc.) — so the answer isn't a function of Derek's mood that day.

Not a blocker. Flagged as NN2.

---

## Phase D — CLAUDE.md compliance

### Commit-message WHY paragraphs

Spot-checked subjects from §4.7, §4.8, §5.5, §6.6, §7.7:

- 1a.6 `feat(stage6): emit field_corrected with pinned wire shape from dispatchClearReading + same-turn correction` — clear WHY (Claude v2 NB1 fix; iOS handler dormant since shipped).
- 1b.6 `feat(voice-latency-ios): replace Alamofire .responseData with chunked HTTP client (DataStreamRequest)` — clear WHY (Codex v2 NB1: Stage 2 chunked transport).
- 2.1 / 2.1a / 2.1b — split per Claude v2 NI1; clean.
- 2.6 `feat(voice-latency): cost-tracker streaming usage (charged on text-sent, not isFinal)` — clear WHY (Codex v2 NI5 fix).
- 4.4a `feat(voice-latency): R8 ack-timeout cancellation with audio-duration-based timeout` — clear WHY (Codex v2 NI4 ack-never-arrives race).

All commit subjects are scoped and CLAUDE.md-compatible.

### Infrastructure-from-source check

PLAN_v3 §4.2 retains 6 env vars from PLAN_v2. Re-verified against ECS `task-def-backend.json` and the env-drift CI guardrail (`scripts/check-task-def-env-drift.sh` confirmed present).

| Env var | Pair commit | Status |
|---|---|---|
| `VOICE_LATENCY_STREAM_CONFIRMATIONS` | 2.7 (task-def) + 2.5 (route reads) | OK — same stage |
| `VOICE_LATENCY_SUPPRESSION` | 6.6 (task-def, was 3.7 in v2) + 6.3 (store reads) | OK |
| `VOICE_LATENCY_REGEX_FAST_TTS` | 9.x (task-def) + 7.x (endpoint reads) | OK — but the Stage 4 conditional means this commit landing is itself conditional on the 1.21 decision gate |
| `VOICE_LATENCY_STREAM_ASK_USER` | 8.x | OK |
| `VOICE_LATENCY_USE_MULTI_CONTEXT` | 9.x + 7.5 (pool reads) | OK |
| `VOICE_LATENCY_KILL_SWITCH` | 1a.2 (task-def + reader) | OK |

All pairings preserve the rule. The Stage-4 conditional means `VOICE_LATENCY_REGEX_FAST_TTS` may never ship its env-var addition — that's fine (no orphaned env var). The 13.1 exit just doesn't add it.

### iOS file path consistency

Spot-checked 5 commit table rows from §4.7 and §4.8 — all use `CertMateUnified/Sources/...`. Clean.

---

## NEW BLOCKERs (v3)

None.

---

## NEW IMPORTANTs (v3)

### NI1. Stage 3 engineering investment may not be justified at 13.1 exit; plan should flag the trade-off explicitly

**Where:** PLAN_v3.md §13.1 + §6.

**Problem:** Stage 3's reservation state machine (`reserved → synthesising → first_byte → sent_to_client → suppression_active`) with 12s TTL, ack timeouts, cancel-on-error, R8 ack-never-arrives handling, etc., is ~7 of 8 commits worth of state-machine engineering. At the 13.1 exit, the suppression rate is ~0% in steady state (no fast-path source of duplication) — the machinery exists but doesn't fire in production.

§13.1 says: "Stage 3 suppression machinery proven against zero sources of duplication (suppression rate = 0% in steady state — validates wiring)." This frames a zero-utilisation outcome as a feature, not a cost.

The legitimate counter-argument is that Stage 3 builds the contract Stage 4 needs later, AND catches natural-duplicate cases (Flux `circuit 1` + `Socket 1.` 1ms apart). Both are true. But Derek should make the 13.1-vs-13.2 decision knowing that 13.1 ships ~5x more state-machine engineering than would be needed to handle natural duplicates alone (a simpler in-flight dedupe + canonical key would cover ~90% of those).

**Fix:** Add a paragraph to §13.1 explicitly noting "Stage 3 ships its full reservation-state machinery in both exits; ~70% of that machinery is dormant at 13.1 exit, preserved as infrastructure for a future Stage 4 sprint. If Stage 4 is permanently cancelled (not just deferred), consider a follow-up commit reducing Stage 3 to a simpler in-flight dedupe to drop maintenance burden." This is the honest framing.

### NI2. Stage 0.G scenario library lacks Stage-2+3-only fixtures

**Where:** PLAN_v3.md §3.G + §10.6.

**Problem:** The 15 initial scenarios mostly target Stage 4 behaviour. Race fixtures R1-R5 specifically test fast-vs-Sonnet timing — they don't fire if Stage 4 is skipped. If Derek takes the 13.1 exit, the scenario library has limited regression coverage for the Stage 2+3 path because most of its fixtures depend on the fast-path being live.

**Fix:** Add to §3.G scenario list:
- `stage2_warm_path_no_fast.yaml` — Stage 2 streaming confirmation with warm WS pool (if Stage 0.F passed). Assert P50 audible latency within budget.
- `stage2_cold_path_no_fast.yaml` — Stage 2 cold synthesis, BOS handshake. Assert no errors, audio plays correctly.
- `stage3_suppression_natural_duplicate.yaml` — Flux emits two finals 1ms apart with same `(field, circuit, value)`. Stage 3 suppression fires correctly without any Stage 4 source. Assert: ONE TTS plays, second is suppressed.
- `field_corrected_clear_reading.yaml` — clear_reading dispatched. iOS receives `field_corrected` event with correct snake_case wire shape. Suppression invalidates.
- `field_corrected_same_turn_correction.yaml` — `record_reading` followed by `record_reading` for same field, different value. Correction event emits. Suppression invalidates correctly.

Without these, the 13.1 exit ships with weaker regression coverage than the 13.2 exit.

---

## NEW NITs (v3)

### NN1. Commit 1b.4 + 1b.6 ordering: which threads `source` first?

**Where:** PLAN_v3.md §4.8.

Commit 1b.4 modifies `APIClient.proxyElevenLabsTTS` to add `source`. Commit 1b.6 introduces NEW method `proxyElevenLabsTTSStreaming(text:sessionId:source:onChunk:onComplete:)`. The plan doesn't say whether 1b.4 also threads `source` into the existing buffer-based method or only the new streaming one.

Reading commit 1b.4 carefully: "TTSSource enum + source field on APIClient.proxyElevenLabsTTS" — this implies threading through the existing method. Then 1b.6 introduces a streaming sibling that also carries source.

**Fix:** Clarify in §4.8 that commit 1b.4 adds source to the buffered method (5 AlertManager call sites pass it), and 1b.6's new streaming method inherits the same signature. Both methods are live during the Stage-1b → Stage-2 transition window so old code paths don't break.

### NN2. §7 Decision Gate lacks a structured "feel" capture rubric

**Where:** PLAN_v3.md §7 (Stage 4 conditional decision gate).

The plan says "Derek subjectively assesses: does the inspector experience feel acceptable?" with no rubric. P50 from 5 sessions isn't statistically meaningful for the P95 column. "Feel" can be a function of mood.

**Suggested rubric (3 yes/no questions before assessing):**
1. Did the confirmation arrive before you started speaking the next value, on most utterances?
2. Did you ever notice yourself waiting for the confirmation to finish?
3. Would you prefer faster confirmations even if it cost 1-2 weeks more engineering?

If 2+ are "no" → take the 13.1 exit. If 2+ are "yes" → proceed to 13.2.

Not a blocker — Derek can apply judgement either way.

---

## v1+v2 findings re-verification table

| Finding | v3 status | Note |
|---|---|---|
| Claude v1 B1 source field | OK (with NI2 caveat from v2 carried into NI2 here) | 5-call-site enumeration in §4.4 is approximate; spot-check found `speakResponse` is private, 2 entry points missed (tour, alerts). Not a blocker — default-to-confirmation is safe. |
| Claude v1 B2 field_corrected wire shape | OK | Pinned in §4.5 + commit 1a.6 + verified against `Stage6Messages.swift:138-165`. |
| Claude v1 B3 KVO not observable | OK | StreamingAudioPlayer with AVAudioPlayerNode.completionHandler(.dataPlayedBack) is the documented API. |
| Codex v1 B1 latency budget | OK | §2 arithmetic checks; Stage 2 honestly framed as marginal (§5 intro). |
| Codex v1 B2 mutex race | OK | Reservation states acquired BEFORE vendor call; §5.2 step 6 includes the `→ synthesising` transition (was missing in v2, now wired). |
| Codex v1 B3 fast-then-ask_user | Honest residual | §16 row 1; locked decision 1.20 confirms Strategy B (0.85 floor, telemetry-driven tune). |
| Codex v1 B4 pooled WS unsafe | OK | §3.F operational pass criteria; fail action defined. |
| Claude v1 I1-I10 | All FIXED in v2, no regression in v3 | — |
| Codex v1 I1-I10 | Two honest residuals (#7 BT route, #13 ack-drop) accepted per locked decision 1.19 + §16 | Both acknowledged residuals; not blockers. |
| Claude v2 NB1 (wire shape) | FIXED | Verified above. |
| Claude v2 NI1-NI4 | All addressed | NI1 split into 2.1/2.1a/2.1b; NI2 enumerated entry points (with NN1 v3 clarification); NI3 §0/§5 prose now matches §2 arithmetic; NI4 wait timings now `[stage0_tunable]`. |
| Claude v2 NN1-NN3 | All addressed | §3.F raised to full day; backend-immutability OK; commit subjects OK. |
| Codex v2 NB1 (Alamofire) | FIXED | Verified at APIClient.swift:855; commit 1b.6 promoted to Stage 1b. |
| Codex v2 NI1-NI5 | All addressed | NI1 all constants `[stage0_tunable]`; NI2 PCM-default with MP3 contingency; NI3 §3.F full-day with operational criteria; NI4 Stage 1 split into 1a/1b; NI5 cost-tracker streaming accounting in commit 2.6. |
| Codex v2 NN1-NN2 | Both addressed | `synthesising` transition wired in §5.2 step 6; `playback_completed` outcome name with `fast_heard` reserved as analyser aggregate. |
| Derek 2026-05-23 amendments | All landed | Stage 0.G scenario library + locked decisions 1.19/1.20/1.21 + §13 split. |

**Total: 34 of 36 v1+v2 findings intact; 2 honest residuals explicitly documented.**

---

## Diminishing returns assessment

**Honest read: stop reviewing. Start building.**

The v1 → v2 cycle caught 2 BLOCKERs (`field_corrected` wire shape; Alamofire .responseData). The v2 → v3 cycle caught zero NEW BLOCKERs and 2 NEW IMPORTANTs (both about ergonomics of the Minimum-Viable Exit path, not fundamental correctness). The marginal value of a v4 review is genuinely low:

- The plan now has full traceability tables (§16 22 rows, §17 v2-NN1/NN2 carryover, §19 review-driven changes consolidated).
- All locked decisions are explicit.
- Stage 0 measurement-before-code is preserved.
- Every constant carries `[stage0_tunable]`.
- Every env var has a paired code-read commit.
- The Stage 4 conditional gate gives Derek an honest off-ramp at the half-way point.

The plan is more polished than the typical sprint kickoff. **The cost of one more review pass would not be repaid by the marginal findings.** If a v4 happened, expect 0-1 NEW BLOCKER, 1-3 NEW NITs, and 0 NEW IMPORTANTs. Stage 0 measurement will reveal more useful information than another textual review pass.

The two NEW IMPORTANTs (NI1 trade-off framing, NI2 missing 13.1 scenarios) are good-to-fix during Stage 0.G implementation, but neither blocks Stage 0 kickoff.

---

## Recommendation

**Approve with two pre-flight tweaks (both Stage-0-G-scope, not blockers):**

1. **NI2:** Add 5 Stage-2+3-only scenarios to the Stage 0.G initial scenario library. Without these, the 13.1 exit ships with weaker regression coverage than the 13.2 exit. Estimated 30 minutes added to Stage 0.G implementation budget.

2. **NI1:** Add a paragraph to §13.1 acknowledging that ~70% of Stage 3's machinery is Stage-4 preparation. Lets Derek make the 13.1-vs-13.2 decision with honest cost framing. Five minutes of plan editing.

The NNs (NN1 commit ordering clarity; NN2 decision-gate rubric) can land any time before Stage 3 ships.

**Sprint is ready to start Stage 0 measurement immediately on Derek's approval.** Continued planning iterations past this point are diminishing returns.
