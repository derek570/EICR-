# Extraction-bypass sprint — skip Sonnet on regex-clean turns + SoI lazy-load

**Date:** 2026-05-28
**Author:** Claude (Opus 4.7) at Derek's direction
**Sprint scope:** 3 phases, ~3–4 days end-to-end
**Branches:** `regex-bypass`, `soi-tool-lookup`, `observation-tts-bridge`
**Expected saving:** $0.12–$0.30/session on top of Phase 1 (= roughly another 35–50% reduction in per-turn cost)

---

## 0. Why this exists

Phase 1 of snapshot-restructure (shipped 2026-05-27) cut per-turn Sonnet cost by 40% and dropped total session cost by ~26%. Phase 3 didn't pay off (canary RED, reverted 2026-05-28). Looking at the post-Phase-1 cost composition, the headline finding is:

- **Cache reads are now 58% of per-turn Sonnet cost** (35,000 read tokens/turn × $0.30/M ≈ $0.0105/turn).
- **Cache writes have already been squeezed to ~16%** (Phase 1's win).
- The remaining cost-reduction levers live on the *prompt input side* (reducing what's read) and the *call-frequency side* (avoiding Sonnet calls entirely).

This sprint addresses both:

- **Phase A (regex bypass):** skip Sonnet entirely when iOS regex caught everything in the utterance. Today regex hits still trigger a full Sonnet round with "DO NOT extract" prompt steering — pure overhead at ~$0.018/turn. Estimated 30–50% of turns are regex-clean.
- **Phase B (SoI as tool):** move the Schedule of Inspection (BS 7671's 99-item appendix) out of every Sonnet prompt and behind a `lookup_inspection_item` tool. Sonnet only reads SoI text when emitting an observation (~5–10% of turns).
- **Phase C (observation TTS bridge):** mask the latency cost of Phase B's tool round-trip by firing a pre-baked TTS ("noting that…") the instant iOS detects an observation trigger word.

## 0.1 Relationship to prior sprints

| Prior work | Relevance |
|---|---|
| Snapshot-restructure Phase 0 (env-var audit, identity counter) | Reuse audit script for new env vars. |
| Snapshot-restructure Phase 1 (split_blocks layout) | **Critical dependency** — Phase A only works because Phase 1 §2.2A merge ensures iOS state lands in `stateSnapshot` independent of Sonnet tool calls. Without that, skipping Sonnet would orphan iOS reads. |
| Snapshot-restructure Phase 3 (ascending) | Reverted; not in scope. |
| Voice-latency: pre-LLM gate (`pre-llm-gate.js`) | **Direct extension surface** — Phase A is a new branch in this file. |
| Voice-latency: regex-fast-TTS route | **Extension surface** — Phase A reuses the eligibility heuristics. |
| Voice-latency: loaded-barrel speculator | **UX model** — Phase C is the same pattern (pre-fired TTS to mask backend latency). |

## 0.2 Honest cumulative estimate

| Source | Saving range | Confidence |
|---|---|---|
| Phase A (regex bypass) | $0.05–$0.18/session | High — direct skip, measurable per-turn cost saved |
| Phase B (SoI tool) | $0.04–$0.08/session | Medium — depends on SoI's actual token weight in the cached prefix |
| Phase C (TTS bridge) | $0.00 cost, +UX | High — proven pattern from Loaded Barrel |
| **Combined** | **$0.09–$0.26/session** | Mid-range $0.12–$0.18 most likely |

At ~6 sessions/day current usage: ~£0.50–£1.00/day extra savings. At commercial launch scale: scales linearly with session count.

---

## 1. Architecture summary

### 1.1 Current state (after Phase 1)

```
iOS utterance
  ├─ DeepgramService -> transcript
  ├─ NumberNormaliser -> normalised transcript
  ├─ TranscriptFieldMatcher (regex) -> regex hits
  │     └─> iOS pre-applies values to local state -> UI updates ~40ms
  └─ ServerWebSocketService -> backend
        └─> sonnet-stream.handleTranscript
              └─> pre-llm-gate (blocks filler) -> usually forwards
                    └─> EICRExtractionSession.extractFromUtterance
                          └─> Sonnet API call -> ~$0.018, ~3–8s
                                └─> tool calls -> snapshot update, TTS, etc.

Parallel: iOS pushes job_state_update over WebSocket
  └─> backend.updateJobState
        └─> _mergeIncomingJobStateIntoSnapshot (Phase 1 §2.2A)
              └─> stateSnapshot.circuits[N] = {...}
```

### 1.2 Target state (after this sprint)

```
iOS utterance
  ├─ Deepgram -> NumberNormaliser -> transcript
  ├─ TranscriptFieldMatcher (regex) -> regex hits + observation trigger detection
  │     ├─ regex hits -> iOS pre-applies (unchanged)
  │     ├─ if observation trigger detected -> play pre-baked "noting that..." TTS instantly
  │     └─ ObservationTriggerDetector -> flag in WS message
  └─ ServerWebSocketService -> backend
        └─> sonnet-stream.handleTranscript
              └─> pre-llm-gate
                    ├─ filler block (unchanged)
                    ├─ NEW: regex-clean bypass -> skip Sonnet, ack only
                    └─> otherwise forward to EICRExtractionSession
                          └─> Sonnet API call (smaller prompt: no SoI in prefix)
                                └─> tool calls including NEW lookup_inspection_item
                                      └─> server lookups SoI section, returns to Sonnet
                                └─> observation emitted, TTS

Parallel: iOS job_state_update -> stateSnapshot merge (unchanged from Phase 1 §2.2A)
```

### 1.3 Phase ordering rationale

Phases A and B are independent in code but share the same observation-detection logic (A uses it as part of the bypass eligibility check; B uses it to gate which Sonnet turns need SoI). Phase C is iOS-only and slots in alongside B.

Recommended sequence: **A → B → C**.

- A is the biggest single saving and is purely server-side; canary it in isolation.
- B introduces a tool call which Sonnet has to learn; canary separately to isolate any extraction-quality regression.
- C is UX-only, no cost impact, ships alongside B's iOS work.

---

## 2. Phase A — Skip Sonnet on regex-clean turns

### 2.1 Eligibility rule

Skip Sonnet for an utterance iff ALL hold:

1. At least one iOS regex hit attached to the message (i.e. `regexResults.length > 0`).
2. No observation trigger word in the transcript (closed lexicon — see §2.3).
3. No correction lead-in ("actually", "no", "sorry", "wait", "scratch that", "that was wrong", "I meant").
4. No question lead-in ("what is", "what was", "what's the", "how", "calculate", "work out", "tell me").
5. No pending `ask_user` in flight (transcript may be the answer).
6. iOS did NOT tag the transcript as `in_response_to` an inflight TTS.
7. No `start_dialogue_script` pattern (ring continuity walkthroughs, OCPD multi-slot dictation, etc — Sonnet drives those).

Failing ANY check → forward to Sonnet as today. Conservative-by-design — better to spend $0.018 occasionally than to drop a real observation.

### 2.2 Implementation

`src/extraction/pre-llm-gate.js` gets a new function alongside `shouldForwardToSonnet`:

```js
export function shouldBypassSonnet(transcriptText, regexResults, sessionState) {
  // Returns { bypass: boolean, reason: string }
  // bypass=true means: ack to iOS, update telemetry, do NOT call Sonnet.
}
```

`src/extraction/sonnet-stream.js` calls this BEFORE forwarding to `EICRExtractionSession`. New decision tree:

```js
if (PRE_LLM_GATE_ENABLED && !shouldForwardToSonnet(...)) {
  // existing filler block path — emit voice_latency.gate_blocked
  return;
}

if (REGEX_BYPASS_ENABLED) {
  const { bypass, reason } = shouldBypassSonnet(transcriptText, regexResults, sessionState);
  if (bypass) {
    // NEW: regex-clean bypass
    logger.info('voice_latency.sonnet_bypass', { sessionId, reason, regexFields: ... });
    // No Sonnet call. iOS already pre-applied. Done.
    return;
  }
}

// existing path
await session.extractFromUtterance(transcriptText, regexResults, options);
```

### 2.3 Observation trigger lexicon

Closed enum, lowercase match against tokenised transcript:

```
observation, observations, noting, note that, code 1, code 2, code 3, code one, code two, code three, c1, c2, c3, concern, danger, dangerous, broken, damage, damaged, missing, exposed, loose, faulty, defective, cracked, burnt, scorched, melted, corroded, unsafe, hazard
```

Stored as a `Set` in a new module `src/extraction/observation-triggers.js` so Phase B can import the same lexicon.

### 2.4 Verification step: confirm iOS reliably pushes job_state_update

**Before Phase A ships, run one log query to confirm this assumption:**

```
fields @timestamp, sessionId, message
| filter sessionId = "<recent-session-with-regex-hits>"
| filter message = "updateJobState" or message like /Extracting from transcript/
| sort @timestamp asc
```

Need to see `updateJobState` fire WITHIN ~2 seconds of each regex-clean transcript. If iOS delays the push until session end (or batches over long windows), the snapshot will be stale and the next Sonnet turn — when it finally happens — will see outdated data.

If verification fails: implement Phase A.1 — server-side regex application directly into `stateSnapshot` on bypass (mirrors iOS's pre-apply but on the server). +1 day work.

### 2.5 Telemetry

New log line per bypass:

```
voice_latency.sonnet_bypass {
  sessionId,
  turnId: <auto>,
  reason: "regex_clean" | "regex_clean_with_observation_in_other_part" (if extended)
  regexFieldsBypassed: ["zs", "circuit"],
  transcript_length: 12,
}
```

Cost-saving counter at session end: `bypass_count`, `total_count`, `bypass_rate`. Mirrors Phase 0's identity-rate pattern.

### 2.6 Test plan

| # | Case | Assertion |
|---|---|---|
| 1 | Pure reading utterance ("Zs 0.35 circuit 3") with regex hit | bypass=true, reason="regex_clean" |
| 2 | Reading + observation ("Zs 0.35 circuit 3 and the cover is broken") | bypass=false (observation trigger) |
| 3 | Reading with correction lead-in ("actually Zs 0.35 circuit 3") | bypass=false (correction) |
| 4 | Reading with question lead-in ("what's the Zs for circuit 3?") | bypass=false (question) |
| 5 | Reading while ask_user in flight | bypass=false (pending ask) |
| 6 | Reading tagged in_response_to | bypass=false (response) |
| 7 | No regex hit, but content words | bypass=false (no regex catch) |
| 8 | start_dialogue_script keyword ("I'm starting OCPD") | bypass=false (multi-slot walkthrough) |
| 9 | `REGEX_BYPASS_ENABLED=false` env override | bypass=false regardless |
| 10 | E2E: bypass fires → no Sonnet call → ack returned to iOS → telemetry logged | Full path, mock Sonnet client expects 0 calls |

### 2.7 Rollout

- Day 1: implementation + tests + audit-script env var registration.
- Day 1 evening: deploy with `REGEX_BYPASS_ENABLED=false` default. Code lands inert. Run telemetry sweep to confirm normal session shape unchanged.
- Day 2: flip a canary task to `REGEX_BYPASS_ENABLED=true`, run two iPad sessions same as snapshot canaries. Read out:
  - bypass_rate > 25% (if it's below this, the eligibility rules are too strict)
  - Sonnet turn count down ~30–50%
  - No drop in observations extracted (compare to baseline)
  - No spike in `ask_user.missing_context`
  - cost/turn down on remaining Sonnet turns (because fewer "trivial" turns drag the average)
- Day 2-3: if canary green, flip fleet default. Single task-def env-var change.

---

## 3. Phase B — Schedule of Inspection as lookup tool

### 3.1 Current footprint

`_AGENTIC_BASE_PROMPT` (loaded from `config/prompts/sonnet_agentic_system.md`) + `_SCHEDULE_OF_INSPECTION_EICR` (loaded from `config/prompts/schedule-of-inspection-bs7671-eicr.md`) are concatenated at module init into `EICR_AGENTIC_SYSTEM_PROMPT`. This whole thing sits in the cached system prefix on every Sonnet call.

The SoI is 99 inspection items each with ID + description + regulation ref. Rough token estimate: **10–15k tokens.** At 35k total per-turn cache reads, that's a meaningful chunk.

### 3.2 Target shape

Split into:

- **In-prompt:** A compact directory — just the item IDs and one-line summaries — so Sonnet knows what items exist and roughly what they cover. Estimated 1–2k tokens.
- **Behind a tool:** Full item descriptions + regulation text fetched via `lookup_inspection_item({ item_ref: "1.1" })`. The tool returns the verbatim SoI text for that item only (~100–300 tokens per lookup).

Sonnet's contract: when emitting an observation, MAY call `lookup_inspection_item` to retrieve the verbatim regulation text + schedule_item attribution before populating `schedule_item` and `regulation` fields. For the most common observations (cover damage, missing labels, etc), the compact directory's one-liner is enough — Sonnet only calls the tool when confidence is low.

### 3.3 Implementation

| Surface | Change |
|---|---|
| `config/prompts/schedule-of-inspection-bs7671-eicr.md` | Split into two artefacts: `schedule-of-inspection-directory.md` (compact, in-prompt) + `schedule-of-inspection-bs7671-eicr.md` retained as the lookup data source |
| `src/extraction/eicr-extraction-session.js` | `EICR_AGENTIC_SYSTEM_PROMPT` references the directory, not the full SoI |
| `src/extraction/stage6-tool-schemas.js` | New tool: `lookup_inspection_item` with `item_ref: string` parameter |
| `src/extraction/stage6-dispatchers-circuit.js` (or new dispatcher file) | Handler that reads the full SoI artefact, looks up the requested ref, returns the matching item's text |
| `config/prompts/sonnet_agentic_system.md` | Add a paragraph in the observation-handling section explaining when to call the lookup tool vs trust the directory |

### 3.4 Test plan

| # | Case | Assertion |
|---|---|---|
| 1 | Directory + lookup tool together cover all 99 items (no orphans) | Static check at session start |
| 2 | Common observation ("cover damage") routes via directory only, no lookup call | Mock + replay |
| 3 | Uncommon observation routes via lookup_inspection_item | Mock + replay |
| 4 | `lookup_inspection_item` with invalid item_ref returns error tool_result | Sonnet sees error, asks user to clarify or skips lookup |
| 5 | E2E observation emission has valid schedule_item + regulation fields populated | Snapshot of result.observations |
| 6 | `SOI_TOOL_ENABLED=false` env override falls back to full-SoI-in-prompt (regression lock for rollback) | Prompt size matches pre-Phase-B |

### 3.5 Rollout

- Day 2–3 (after Phase A canary green): implementation + tests.
- Day 3 evening: deploy with `SOI_TOOL_ENABLED=false` default (full SoI in prompt unchanged).
- Day 4: canary flip, two iPad sessions.
  - Cache reads per turn down ~25–30% (10–15k tokens shaved)
  - Observation extraction quality unchanged (count + correctness vs baseline)
  - `lookup_inspection_item` tool_call rate consistent with observation rate (~1× per observation, NOT per turn)
- Day 4-5: fleet flip.

### 3.6 Risk

**Observation quality regression** is the main risk. Mitigations:

- Compact directory carries enough one-liner context that Sonnet can attribute the 70% most common observations without a lookup call. Tool only fires for uncommon ones.
- The directory must be carefully drafted — first version review by hand-walking the most common 20 BS 7671 observations and verifying Sonnet picks the right item ID from just the directory line.
- Canary E2E test: feed 5 prerecorded observation-heavy transcripts through both modes and diff the emitted observations.

---

## 4. Phase C — Observation TTS bridge

### 4.1 Problem

Phase B adds a tool round to observation handling — Sonnet emits `lookup_inspection_item`, server runs lookup, returns tool_result, Sonnet runs again to emit the observation. That's at least one extra Sonnet round (~3s) on top of the existing observation-classification round. Inspector experience: longer silence after they say "observation".

### 4.2 Solution

Pre-baked TTS bridge played the instant iOS detects an observation trigger:

- iOS-side `TranscriptFieldMatcher` (or a new `ObservationTriggerDetector`) catches the trigger words from §2.3.
- iOS plays a pre-baked audio asset — "Noting that…" or "Let me check…" — bundled with the app (zero generation latency).
- iOS continues sending the transcript to backend in parallel.
- Sonnet processes, calls lookup tool, emits observation, ElevenLabs generates the final "Code 2, regulation X.Y.Z, observation text" TTS.
- Final TTS plays *after* the bridge audio finishes (~1s).

Net inspector experience: ~100ms after they say "observation broken socket cover", they hear "Noting that…". The full observation TTS lands ~5–7s later, on top of the bridge.

### 4.3 Implementation

| Surface | Change |
|---|---|
| iOS — `TranscriptFieldMatcher.swift` or new `ObservationTriggerDetector.swift` | Detect trigger words from the shared closed lexicon (§2.3 — port via shared-types or duplicate with a comment pointing at the canonical) |
| iOS — bundle asset | Pre-baked audio file ("noting_that.m4a" or similar). 1–2 short variants for variety. Generated via ElevenLabs once, committed to the app bundle |
| iOS — `AlertManager.swift` or audio pipeline | Play the bridge asset instantly on detection; ensure subsequent TTS plays on top without conflict (existing TTS queue handles this) |
| Backend | No change — server is oblivious to the bridge |

### 4.4 Test plan (iOS, lighter)

- Trigger word detected → bridge plays within 200ms of utterance end.
- Subsequent server TTS plays after bridge finishes, no audio overlap.
- False-positive: trigger word in a non-observation context (e.g. "I have a concern about the wiring spec" — "concern" hits but it's a comment, not an observation). Acceptable — bridge plays, no observation emitted by Sonnet, inspector hears the brief bridge but no follow-up. Better than silence + slow follow-up.

### 4.5 Rollout

Ships alongside Phase B's iOS changes. TestFlight build. No backend coupling — independent canary.

---

## 5. Combined cost model

For a session with:
- 24 turns total
- 30% regex-clean (8 turns)
- 5% observation turns (1 turn)
- 65% other (15 turns)

| Component | Today (Phase 1) | After Phase A | After Phase A+B |
|---|---|---|---|
| Sonnet turns called | 24 | 16 (24 − 8) | 16 |
| Avg tokens read/Sonnet turn | 35,000 | 35,000 | 23,000 (SoI removed) |
| Cache read $/turn | $0.0105 | $0.0105 | $0.0069 |
| Total cache read $/session | $0.252 | $0.168 | $0.110 |
| Cache write $/session | $0.070 | $0.046 (16 turns) | $0.046 |
| Input + output $/session | $0.115 | $0.077 | $0.077 |
| Sonnet total $/session | ~$0.44 | ~$0.29 | ~$0.23 |
| **Saving vs Phase 1** | — | **−34%** | **−47%** |
| Saving in $/session | — | $0.14 | $0.20 |

(Above is a worked example for one shape of session. Real per-session saving varies — sessions with fewer regex hits or more observations save less; the opposite save more. The averages should land in the $0.12–$0.30 band quoted in §0.)

---

## 6. Sequencing + canary plan

### 6.1 Calendar

| Day | Phase | Activity |
|---|---|---|
| 1 | A | Implementation + tests + env var registration |
| 1 PM | A | Deploy inert (`REGEX_BYPASS_ENABLED=false`) |
| 2 AM | A | Canary flip, 2 iPad sessions |
| 2 PM | A | Read out + fleet flip if green |
| 2 PM | B | Implementation start (parallel with A canary read-out) |
| 3 | B | Tests + offline replay against past observation-heavy sessions |
| 3 PM | B | Deploy inert (`SOI_TOOL_ENABLED=false`) |
| 4 AM | B + C | Canary flip + iOS TestFlight build with Phase C bridge |
| 4 PM | B + C | Field test, read out |
| 5 | B + C | Fleet flip if green; otherwise iterate |

### 6.2 Abort thresholds

| Phase | Abort if |
|---|---|
| A | bypass_rate < 10% (eligibility rules too strict; not worth shipping) OR observation count drops vs baseline OR missing_context spike |
| B | Observation extraction quality drops on the 5-session replay OR `lookup_inspection_item` fires on every turn (Sonnet doesn't trust the directory) |
| C | False-positive rate > 20% (bridge plays without follow-up observation too often) |

---

## 7. Out of scope (explicitly deferred)

- Phase 4 of snapshot-restructure (ops ledger). Still gated per original plan.
- Routing simple turns through Haiku 4.5 (Avenue C from the earlier discussion). Real saving but riskier — Haiku misses nuance. Revisit after this sprint if the cost floor still needs work.
- Server-side regex re-application (only fires if §2.4 verification fails).
- Compressing the per-turn user message phrasing (Avenue D from earlier — small lever).

## 8. Reviewer notes

This plan deliberately skips the multi-iteration self-review + Codex review dance that the snapshot-restructure sprint went through. The architectural surface is smaller (no schema changes, no data-shape changes, no cross-platform contract changes), and the rollback path is a single env-var flip per phase. If field-test results surprise us, that's the signal to slow down — not the planning phase.

A Codex CLI review pass before Phase B ships is worth doing because the SoI tool changes the prompt contract; a review pass before Phase A is probably overkill.
