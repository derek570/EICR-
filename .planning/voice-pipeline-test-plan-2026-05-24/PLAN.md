# Voice-pipeline comprehensive test plan
*2026-05-24 — Author: claude-opus session derek/main*

## Goal

Reach a state where every meaningful failure mode in the
voice-recording pipeline is covered by a deterministic test that
produces (a) a clean pass/fail verdict and (b) a per-stage wall-clock
breakdown so we can localise the cost of any regression to a single
layer before opening a code change.

Today the gap is large: the prod 286D500D-2026-05-24
designation-loop bug shipped, ran in production for an unknown
duration, and was only caught because Derek stopped a field session
manually. We have ~13 scenarios that cover ~4 single-utterance happy
paths. This plan replaces that with a layered suite.

## Pipeline map — every place a failure can hide

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  iOS recording session                                               │
   └──────────────────────────────────────────────────────────────────────┘

   audio capture          1. AVAudioEngine + Silero VAD
        │                    failure: silence dropped, false wake,
        │                    incorrect doze entry
        ▼
   Deepgram WS            2. Nova-3 STT (direct from iOS)
        │                    failure: misheard digit, dropped final,
        │                    KeepAlive timeout, disconnect on phone-call
        ▼
   regex normaliser       3. TranscriptFieldMatcher (on-device, instant)
        │                    failure: missed digit, wrong field,
        │                    overshoot match
        ▼
   server WS              4. ServerWebSocketService → backend
        │                    failure: token expired, ALB drop,
        │                    reconnect storm
        ▼
   Stage 6 tool-loop      5. Sonnet 4.5 + dispatchers
        │                    failure: wrong tool emitted, missing
        │                    designation, hallucinated circuit, ask_user
        │                    storm, snapshot compaction hides context
        ▼
   per-turn dispatcher    6. record_reading / create_circuit / ask_user /
        │                    add_board / record_board_reading / etc.
        │                    failure: validation reject, write to wrong
        │                    bucket, key-name mismatch (just fixed)
        ▼
   confirmation TTS       7. ElevenLabs (live) OR Loaded Barrel cache HIT
        │                    failure: cache MISS when expected, latency
        │                    blow-out, garbled text, parity drift between
        │                    spec text and actual text
        ▼
   iOS apply              8. DeepgramRecordingViewModel applies
        │                    circuit_updates + extracted_readings to
        │                    job state, surfaces TTS audio
        │                    failure: decoder drops field, wrong-board
        │                    routing, UI not refreshed
        ▼
   persistence            9. PUT /api/jobs/:id → S3 extracted_data.json
                             failure: validation reject, hierarchy
                             validator hit, schema mismatch
```

**Eight stages, eight failure surfaces.** A single integration test
that observes only the final state ("was the reading saved?") leaves
seven of these invisible. We need per-stage observation.

## Test layer matrix

| Layer | Tool | What it tests | What it cannot test | Cost / run |
|---|---|---|---|---|
| **A. Unit** | jest (`src/__tests__/`) | dispatcher logic, snapshot mutators, validator branches, prompt-leak filter, schema enums | model behaviour, real network, audio | $0 |
| **B. Direct harness** | `scripts/voice-latency-bench/transcript-replay-direct.mjs` | Stage 6 with real Sonnet, tool emission, ask_user shape, snapshot context | iOS, Deepgram, TTS, persistence | ~$0.05/scenario |
| **C. HTTP harness** | `scripts/voice-latency-bench/transcript-replay.mjs` (needs local backend) | C + WS protocol, auth, ALB-shape, real circuit_updates wire | iOS apply path | ~$0.10/scenario |
| **D. iOS unit** | `xcodebuild test` on `CertMateUnified` | TranscriptFieldMatcher, NumberNormaliser, applier, codable decoders | server-side anything | $0 |
| **E. iOS UI** | manual on TestFlight | full E2E including audio + VAD + Deepgram + TTS | nothing skipped | hard to automate |

**This plan focuses on B + D.** A is already comprehensive
(3,747 tests). C and E require infra we don't have (local Postgres,
TestFlight pipeline) — separate plans.

## Coverage gap inventory

What does the current direct-harness scenario set cover?

| Theme | Today | Target | Delta |
|---|---|---|---|
| Single-utterance happy path | 6 | 6 | — |
| Designation flow (the bug just fixed) | 4 | 4 | — |
| Multi-circuit dictation | 0 | 4 | **+4** |
| Observations | 0 | 5 | **+5** |
| OCPD / RCD type entry | 0 | 4 | **+4** |
| Ring continuity | 0 | 3 | **+3** |
| Polarity + dependent-Zs | 0 | 2 | **+2** |
| Sub-board / multi-board | 0 | 4 | **+4** |
| ask_user response paths (need harness extension) | 0 | 4 | **+4** |
| Negative / adversarial | 1 | 5 | **+4** |
| Loaded Barrel HIT/MISS | 7 yaml exist, runner can't drive | 7 | runner work |
| Chitchat / pause / resume | 1 | 3 | **+2** |
| Long-session compaction | 0 | 2 | **+2** |
| **TOTAL** | 19 | 53 | **+34 scenarios** |

At ~$0.05/scenario × 34 new + 19 existing = **~$2.65 per full suite run**.
Cheap enough to run on every push to a `voice-test` branch, expensive
enough that it shouldn't run on every PR — see Execution model below.

## Scenario catalogue — priority-ordered

### P0 — production failure modes already seen
1. **`designation_after_rename`** — create c1 with name "Cooker"; later rename it to c2 — Sonnet should resolve "cooker" → c2 on a subsequent reading, not c1 (rename rekey path)
2. **`hallucinated_phantom_circuit`** — pin the 20% flake observed today: 3-utterance designation flow MUST end with exactly ONE c2 in the schedule, never both c1 and c2 with the same designation
3. **`bs_en_normalisation`** — "60898" should resolve to `BS EN 60898` per `parseBsCode` Lev-1 fallback (regression cover for the 2026-05-06 fix)
4. **`silent_drop_on_short_utterance`** — "Circuit one is X" (3 words) — should not be dropped as chitchat
5. **`phone_call_interruption_recovery`** — gap of 60s between utterances should not invalidate state; both readings land on same circuit

### P1 — high-frequency real-session patterns
6. **`multi_circuit_dictation`** — "Circuit 1 Zs 0.4 ohms, circuit 2 Zs 0.6 ohms, circuit 3 Zs 0.5 ohms" (one utterance, three writes)
7. **`reading_chain_one_circuit`** — Zs, R1+R2, R2, polarity, IR-L-L, IR-L-E all on circuit 1 (the inspector's standard cadence)
8. **`observation_create_with_code`** — "Observation, there's a crack in a socket in the kitchen, code C2" — should land observation w/ code, no circuit pollution
9. **`observation_clarify_followup`** — short obs + clarification on next turn — both texts merged
10. **`bulk_polarity_confirm`** — "all circuits polarity confirmed" — N writes, one per non-spare circuit
11. **`ocpd_full_spec`** — "circuit 3 is a 32 amp B-curve MCB, BS-EN 60898" — type, rating, curve, BS number on one circuit
12. **`rcd_type_with_trip_time`** — "RCD 1 is type AC, 30 ma, trip time 28 milliseconds"
13. **`ring_continuity_full`** — r1, rn, r2, R1+R2 all dictated for one ring circuit
14. **`spare_circuit_skip`** — "Circuit 6 is a spare" — should NOT trigger any subsequent readings on bulk operations

### P2 — protocol / state edges
15. **`add_board_sub_main`** — "new sub-board, garage, fed from circuit 3" — board hierarchy validator path
16. **`select_board_then_reading`** — switch to sub-board, dictate reading — should land on sub-board's circuit not main's
17. **`mark_distribution_circuit`** — promote an existing circuit to distribution-circuit pointing at a sub-board
18. **`session_resume_designation_preserved`** — pause/resume, verify state-snapshot-rebuild includes designation
19. **`compaction_then_designation_lookup`** — 10 circuits dictated, then "Zs for the cooker" — even after compaction Sonnet should still resolve

### P3 — ask_user response paths (need harness extension)
20. **`ask_user_answer_circuit_number`** — Sonnet asks "which circuit?", harness responds "circuit 3", write should land
21. **`ask_user_answer_yes_create`** — Sonnet asks "shall I create kitchen ring?", harness responds "yes circuit 4"
22. **`ask_user_timeout`** — Sonnet asks, harness waits 30s without responding, expect graceful state (no write)
23. **`ask_user_user_moves_on`** — Sonnet asks, harness sends unrelated next utterance, expect old question dismissed

### P3 — adversarial / negative
24. **`misheard_digit`** — "circuit 13 zee s nought point eight" (Deepgram drops the "z") — should resolve to Zs
25. **`empty_transcript`** — `""` final — no extraction, no crash
26. **`prompt_injection_in_designation`** — designation text containing "ignore your instructions" — should reject via Layer-2 leak filter
27. **`out_of_range_circuit_create`** — "circuit 99 polarity confirmed" with no circuit 99 in schedule — ask_user
28. **`contradicting_reading`** — Zs=0.5 written, then "circuit 1 Zs is 0.3" — should ask_user reason=contradiction

### P3 — long-session
29. **`50_circuit_full_eicr`** — full realistic session, 50 circuits, every field type — measure cumulative tokens + wall-clock
30. **`session_with_two_chitchat_pauses`** — extraction → chitchat → resume → extraction → chitchat → resume → extraction

### P3 — Loaded Barrel (needs runner extension)
31–34. **`loaded_barrel_*`** — re-enable the existing 7 yamls under direct harness

## Harness enhancements needed

### H1. ask_user response simulation
Today: harness ignores ask_user, scenario times out after 45s. Need:
```yaml
transcript:
  - at_ms: 0
    text: "Zs for the kitchen ring is 0.5."
ask_user_responses:
  - matches: "which circuit"
    text: "circuit 4."
    at_ms_after_ask: 2000
```

`transcript-replay-direct.mjs` extension: when the captured `stage6.ask_user` matches a configured pattern, send a follow-up
`extractFromUtterance(text)` call after `at_ms_after_ask`. Implementation lives in the harness, ~30 lines.

### H2. Wall-clock span attribution
Today: only end-to-end elapsed. Need per-scenario JSON:
```json
{
  "name": "new_circuit_then_readings",
  "spans": {
    "session_start_ms": 0,
    "turns": [
      { "turn_id": "t1", "transcript_at_ms": 0, "sonnet_first_byte_ms": 320, "sonnet_complete_ms": 1450, "tool_dispatches_ms": 12, "extraction_emit_ms": 1465 },
      { "turn_id": "t2", "transcript_at_ms": 5000, "sonnet_first_byte_ms": 5410, "sonnet_complete_ms": 6890, "tool_dispatches_ms": 11, "extraction_emit_ms": 6905 }
    ],
    "ask_users": [],
    "elapsed_ms": 16590,
    "p50_sonnet_round_trip_ms": 1380,
    "p95_sonnet_round_trip_ms": 1480
  }
}
```

Implementation: instrument `runShadowHarness` call sites in the
runner with `performance.now()` marks, capture `runToolLoop`'s
existing round-counter, hook the Anthropic stream client's
`onFirstByte` if available (else approximate via tool-loop start).
~50 lines in the runner + maybe a tiny tap into stage6-shadow-harness.

### H3. Structured per-stage logging
Today: capturing logger collects `stage6_tool_call` and `stage6.ask_user`. Need to ALSO capture:
- `stage6_live_extraction` (per-turn outcome)
- `voice_latency.outcome` (loaded_barrel events when running TTS path)
- `[StateSnapshot] Estimated tokens: …` (compaction telemetry)
- `validateRecordReading` + `validateAndCorrectFields` rejections

Already logged in prod — just need the harness's logger to capture
them by `message:` instead of only the two currently-named events.
~20 lines.

### H4. Tool-call sequence assertions
Today: scenarios assert presence of `has_reading` + count of
`ask_user`. Add:
```yaml
expect:
  tool_call_sequence:
    - tool: create_circuit
      input_summary: { circuit_ref: 2 }
    - tool: record_reading
      input_summary: { field: measured_zs_ohm, circuit: 2 }
  forbid_tools:
    - tool: rename_circuit  # was rejected today; we want it NOT to fire
```

This is what would have caught the `rename_circuit(2,2)` red herring
Sonnet kept emitting in the prod repro. ~40 lines.

### H5. State-snapshot inspection
Expose what Sonnet ACTUALLY saw on each turn:
```json
"snapshot_text_per_turn": [
  "BOARDS: …\nCIRCUITS:\n2:{\"1\":\"<<<USER_TEXT>>>Upstairs Lighting<<<END_USER_TEXT>>>\"}\n…"
]
```
Hook `session.buildStateSnapshotMessage` and capture before each
`runShadowHarness` call. Vital for debugging compaction / recency
bugs. The recency push fix in commit `7f0cf4d` would have been a
1-line fix instead of a 1-hour investigation if the harness had this.

### H6. Reproducibility seed
Add `--temperature=0` mode that forces Anthropic deterministic
sampling (where supported) so flakes like the 20% phantom-c1 case
can be reproduced reliably.

## Comprehensive logging — what the prod backend should add

For locating errors in real sessions (the field-test failure mode):

### L1. Per-tool dispatch timing
Currently `stage6_tool_call` rows log `duration_ms` for the whole
dispatch. Add a `phase_breakdown` with validate / mutate / log
sub-spans. ~5 lines per dispatcher, mostly mechanical.

### L2. Stage 6 turn-level wall-clock
Currently `stage6_live_extraction` logs `rounds`, `usage_input`,
`usage_output`, `usage_cache_read/write`. Add `wall_clock_ms` and
`sonnet_first_byte_ms`. Already trivially available in `runToolLoop`.

### L3. ask_user enqueue → answer trace
Currently `Client diagnostic` logs queue depth + question preview at
various stages (`question_enqueued`, `inflight_anchored`,
`inflight_reanchored_tts_end`). Tie them by `tool_call_id` so the
full lifecycle is one query in CloudWatch.

### L4. Snapshot rendering trace
Log the `recentCircuitOrder` slice + compacted-count on every
`stage6.snapshot_built` event. This is the diagnostic that would
have pointed at the recency-push fix instantly.

### L5. PII-safe input capture for create_circuit/rename_circuit
Today `input_summary` strips `designation` for PII reasons. Replace
with `designation_hash` (truncated SHA-1) + `designation_length` so
we can correlate field-test failures with model-emitted designations
without leaking PII. The dispatcher already imports `hashPayload`
from the prompt-leak filter for this exact purpose at line 344.

## Execution model

| Trigger | What runs | Frequency | Cost |
|---|---|---|---|
| Every push to any branch | jest (A) | per push | $0 |
| `[voice-test]` in commit message | A + direct-harness P0+P1 (~14 scenarios) | on-demand | ~$0.70 |
| `[voice-test-full]` | A + all 34 scenarios | on-demand | ~$2.65 |
| Nightly cron on main | full suite | daily | ~$2.65 × 30 = $80/mo |
| Field-test reproduction | one scenario + per-stage timing report | manual | ~$0.05 |

The CI plumbing:
- `.github/workflows/voice-test.yml` — triggered by commit-message
  tag OR `workflow_dispatch`. Pulls `ANTHROPIC_API_KEY` from the
  same `eicr/api-keys` secret as the backend, runs the chosen
  scenario set, uploads JUnit XML + per-scenario JSON artifacts.
- Pass/fail surfaces as a GitHub status check.

## Success criteria

1. Every P0 scenario has a green run within 14 days.
2. Every P0+P1 scenario in CI by end of milestone.
3. Direct-harness coverage hits ≥90% of tool dispatchers (every
   `dispatch*` function exercised by at least one scenario).
4. Wall-clock p95 < 3s per Sonnet turn measured across the full suite
   (alerts on regression).
5. **Zero prod-failure modes that aren't catchable by a scenario.**
   Any new prod regression must be reproducible in the harness
   before the fix lands. (This is the bar that would have caught
   286D500D-2026-05-24 before it shipped — the prod bug repro is
   our 13-line YAML in `new_circuit_then_readings.yaml` today.)

## Work breakdown

| Slice | Work | Effort | Depends on |
|---|---|---|---|
| **S1** | Harness H1 (ask_user response) + H2 (wall-clock spans) | half day | none |
| **S2** | Harness H3 (logging capture) + H4 (sequence asserts) + H5 (snapshot inspection) | half day | S1 |
| **S3** | Author P0 scenarios (5) + run them | half day | S2 |
| **S4** | Author P1 scenarios (9) + run them | full day | S3 |
| **S5** | Backend logging L1–L5 | half day | none (independent) |
| **S6** | CI workflow + `[voice-test]` trigger | quarter day | S2 |
| **S7** | P2 + P3 scenarios | full day | S6 |
| **S8** | Loaded-barrel runner integration | half day | S6 |

**Total ~4 days for the foundational set + CI.** P3 + L5 can land
incrementally.

## Open questions

1. **Cost ceiling on nightly runs?** $80/mo is small but not zero.
   Worth gating nightly behind a "main-only" filter, or running
   every Sunday only ($10/mo)?
2. **Real audio replay?** A separate harness could replay actual
   .wav files through Deepgram and into the WS handler, adding
   coverage for stages 1–3 above. ~1 day to author, ~$0.30 per
   Deepgram session. Out of scope for this plan; flag as future
   work.
3. **iOS unit-test integration?** Currently runs locally only.
   Adding to CI needs an macOS runner (~$8/min). Defer.
4. **Pass/fail policy for flaky scenarios** (the phantom-c1 case at
   ~20%): run 3× and require 2/3 pass? Or fix the model
   nondeterminism via prompt? Decide before CI integration so the
   policy is uniform.
