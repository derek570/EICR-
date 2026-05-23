# Loaded Barrel v4 — Prompt + Speculator + Late-Commit Buffer

**Date:** 2026-05-24
**Supersedes:** LOADED_BARREL_PLAN_v3.md (closed 13/13 v2 issues but
introduced 5 NEW BLOCKERs + 5 IMPORTANTs from Codex review).
**Scope expansion vs v3:** v3 was an audio-cache implementation plan.
v4 is the **full system change** required to make the Sonnet-path
audible latency hit 2-2.5s for the natural-language case (not just
the regex fast-path's narrow case).

## TL;DR

The 2-2.5s goal on the Sonnet path is reachable but requires three
concurrent workstreams, not just a cache:

1. **Prompt change**: switch `tool_choice` from forced
   `{type:"tool"}` to `"auto"`, AND prompt-instruct Sonnet to emit
   ONE concise confirmation sentence as TEXT *before* the
   record_reading tool call. Without this change there is no text
   block to stream during round 1, and the cache-only approach
   (v2/v3) can only shave the TTS hop, not the Sonnet hop.
2. **Late-commit streaming buffer**: speculator streams the round-1
   text deltas to ElevenLabs in real time; audio frames buffered
   server-side. At round-1 `message_stop` we run the dispatchers,
   then decide to FIRE (stream buffered audio to iOS via the
   existing chunked HTTP path) or DISCARD (one wasted synth, fall to
   today's path).
3. **Invariant test suite expansion + field assessment gate**:
   prompt tuning is the highest-risk surface in the plan. Tests
   replay 100+ historical transcripts before each prompt revision;
   field assessment over 5-10 inspector sessions before rollout.

v3 BLOCKERs all addressed by switching from "predict from tool_use
args" (v3, races dispatch) to "buffer Sonnet's actual text stream"
(v4, eliminates the prediction problem entirely).

## v3 BLOCKER closure

| v3 BLOCKER | v4 fix |
|---|---|
| v3-B1: ESM cycle | Leaf-module pattern: `src/extraction/confirmation-text.js` (constants + buildConfirmationText). Bundler imports it. Speculator doesn't need it (uses Sonnet's actual text deltas, not predicted text). |
| v3-B2: pre-dispatch vs post-bundle race | Speculator buffers audio but does NOT cache it. Audio fires (or doesn't) at round-1 `message_stop` AFTER dispatchers run and verdict is known. No race. |
| v3-B3: dispatcher writes value verbatim → predictor normalisation diverges | Speculator no longer predicts. Text comes from Sonnet itself. The dispatcher contract is irrelevant to the text content. |
| v3-B4: hook only fires for streaming path | The non-streaming `messages.create` path stays on today's batch latency. Document scope: speculation only applies to Stage 6 `runToolLoop`-routed transcripts. The current Stage 6 prod path IS the streaming path; the non-streaming path is legacy/test-only. |
| v3-B5: pruneForSession can't cancel pending synths | Speculator owns an AbortController per synth. `session_stop` calls `controller.abort()` on every pending. ElevenLabsStreamClient already honours AbortSignal (existing). |

## v3 IMPORTANT closure

| v3 IMPORTANT | v4 fix |
|---|---|
| IMP-1: miss telemetry no-ops with null id | Misses mint a fresh telemetry-only correlation ID (no cost recorder) and emit `voice_latency.speculation_miss` |
| IMP-2: TTL → double synth | Removed: cache no longer exists (audio is fired or discarded synchronously at round-1 message_stop, never persisted) |
| IMP-3: lastTranscriptHadConfirmationsEnabled wrong shape | Speculator reads `confirmationsEnabled` from `options` plumbed through `runToolLoop`, matching the bundler pattern at `stage6-shadow-harness.js:322`. No session-state mutation. |
| IMP-4: calculated/bulk writes uncovered | v4 doesn't predict from tool_use; it streams Sonnet's text. Calculated writes still emit confirmations bundler-side; v4 covers them naturally via text streaming (no special path needed). |
| IMP-5: 'speculation' not in KNOWN_SOURCES | Add `'speculation'` to `KNOWN_SOURCES` set in `voice-latency-telemetry.js` |

## Three concurrent workstreams

### Workstream A — Prompt + tool_choice change

**Files:**
- `config/prompts/sonnet_extraction_system.md` (or wherever the
  agentic prompt lives; needs verification)
- `src/extraction/eicr-extraction-session.js` (where
  `tool_choice` is set on the request)

**Change:**

```diff
- tool_choice: { type: 'tool', name: 'record_extraction' }
+ tool_choice: 'auto'
```

Prompt addition (system prompt):

```
RESPONSE FORMAT for any utterance that produces a record_reading
or record_board_reading tool call:

  1. Emit a single concise confirmation sentence as TEXT FIRST.
     Use exactly the form: "Circuit N, <friendly_field> <value>."
     For board readings: "<friendly_field> <value>."
     For polarity_confirmed: "Circuit N, polarity confirmed."
     Keep under 8 words.
  2. THEN emit the record_reading tool_use call.

For all other utterances (ask_user, observations, clear_reading,
multi-tool turns, ambiguity), follow normal Stage 6 patterns.
```

**Risk:** Sonnet may emit text WITHOUT tool_use on some turns →
regression to pre-Stage-6 JSON-parse failure mode. Mitigations:
- Post-loop validation: if `assistant.content` has text but no
  tool_use, re-prompt once with `tool_choice: {type:"any"}` to
  force tool selection. One extra Anthropic call (~1.4s) on the
  recovery path; expected rate <5% based on Anthropic's `auto`
  reliability for tool-instructed prompts.
- Feature-flagged: `VOICE_LATENCY_PROMPT_TEXT_FIRST=false` default;
  flip on per-session after Workstream C field-test passes.

**A/B harness work:** before flipping the flag, replay 100+
historical transcripts captured from session-analytics S3 against
both prompt variants and compare:
- Tool-use emission rate (must stay >95%)
- Confirmation text quality (manual Derek review of ~20 samples)
- ask_user emergence rate (must not change meaningfully)
- Cost per turn (text-before-tool adds ~30 tokens output)

### Workstream B — Late-commit streaming buffer

**Files:**
- `src/extraction/stage6-stream-assembler.js` — add `onTextDelta` + `onCompletedToolUse` callbacks (v3-B5 fix applies; add AbortSignal plumb-through too)
- `src/extraction/eicr-extraction-session.js` — switch `messages.create` to `messages.stream`; wire callbacks to speculator
- `src/extraction/loaded-barrel-buffer.js` (NEW) — buffer + verdict logic
- `src/routes/keys.js` — `streamConfirmationViaElevenLabs` accepts a "pre-loaded buffer" hint that short-circuits the live synth path
- `src/extraction/voice-latency-telemetry.js` — extend SERVER_OUTCOMES + KNOWN_SOURCES
- `src/extraction/voice-latency-config.js` + `ecs/task-def-backend.json` — `VOICE_LATENCY_LOADED_BARREL=false` snapshot flag

**Speculator state machine:**

```
state machine (per Sonnet-stream call):

  IDLE → opened ElevenLabsStreamClient on first text_delta
         (text_delta arrives ~947ms in = TTFT)
       → forward text deltas to ElevenLabs as they arrive
       → buffer audio frames in audioBuffer[]
       → state: BUFFERING

  BUFFERING → onCompletedToolUse(toolUseBlock):
              capture {name, input} for verdict
            → text content_block_stop:
              send flush to ElevenLabs
            → message_stop arrives:
              dispatch tool_use, get dispatchResults
              run verdict classifier
              → FIRE or DISCARD

  FIRE     → emit extraction envelope as today (rounds 2+3 still run
              for board_ops/observations but their results queue for
              the *next* turn, not this one — see "two-turn pattern"
              below)
           → stream audioBuffer to iOS via keys.js short-circuit hint

  DISCARD  → controller.abort() the ElevenLabs WS
           → tool loop continues (rounds 2+3) as today
           → final extraction envelope emits today's batch path
           → telemetry: speculation_discarded with reason
```

**The two-turn pattern (fixing v1's "skip rounds 2+3" BLOCKER properly):**

Fire mode does NOT skip rounds 2+3 of the tool loop. The audio
fires; rounds 2+3 still execute but their side-effects
(board_ops, observation_updates, refined observation codes) emit as
they always do via `dispatchObservationUpdates` and
`emitCurrentBoardChangedFromBoardOps` AFTER the extraction
envelope.

Critically: rounds 2+3's writes are bundled into the SAME
extraction envelope IF they complete before iOS POSTs for TTS.
This requires:
- Bundle is emitted lazily — wait up to `BARREL_FIRE_DRAIN_MS` (e.g.
  500ms) for rounds 2+3 to finish
- If they finish in <500ms → bundle includes them, single envelope
- If they don't → emit envelope with round-1 results, emit a second
  `extraction_supplement` envelope when they finish

iOS already handles `extraction` envelopes idempotently
(`JobViewModel.applySonnetExtraction` is incremental); a follow-up
`extraction_supplement` is a 1-line iOS handler change OR can be
re-shaped as a normal `extraction` envelope with a turn-id that
matches the first (existing reconnect/replay path already handles
this).

**Verdict classifier** (corrected from v1):

```
FIRE if:
  - exactly one record_reading OR record_board_reading tool_use in round 1
  - dispatcher returned outcome='ok' on that tool
  - no clear_reading tool_use in round 1
  - no ask_user tool_use in round 1
  - confidence (from tool_use.input.confidence OR 1.0 default) ≥ 0.8

DISCARD otherwise (multi-write, mixed, ask_user-led, validation
failed, low confidence).
```

The verdict classifier does NOT try to predict; it runs after the
dispatcher returns the actual result.

### Workstream C — Test suite expansion + field gate

**Files:**
- `src/__tests__/loaded-barrel-buffer.test.js` (NEW)
- `src/__tests__/sonnet-prompt-text-first-regression.test.js` (NEW)
- `tests/fixtures/historical-transcripts/` (NEW — captures replayed
  from production session-analytics S3, anonymised)
- `scripts/voice-latency-bench/replay-historical.mjs` (NEW)
- `tests/fixtures/voice-latency-scenarios/loaded_barrel/` (NEW
  harness scenarios)

**Test coverage:**

| Layer | Test |
|---|---|
| Speculator state machine | text_delta → buffer; message_stop → verdict; FIRE path; DISCARD path; AbortSignal cancellation |
| Prompt regression | 100+ historical transcripts replayed against new prompt; assert tool_use emission rate ≥95%; assert no record_reading/clear_reading sequence regressions |
| End-to-end audible | harness scenarios `loaded_barrel_fire_npts.yaml`, `loaded_barrel_discard_clear.yaml`, `loaded_barrel_discard_ask_user.yaml`, `loaded_barrel_discard_multi_write.yaml` |
| Cost-tracker invariant | mixed FIRE/DISCARD/FAIL sweep across 100 runs; assert `charsStarted = charsCompleted + charsCancelled + charsFailed` |
| Stage 6 invariant suite (NEW expansion) | each of ask_user, board_ops, observations, clear_reading, multi-board scenarios — assert prompt change doesn't regress |

**Field assessment gate** (PLAN_v5 §A.5 pattern, expanded):

5-10 inspector sessions with the flag flipped on. Captured:
- FIRE rate by transcript class (single value / question / multi-value)
- Audible-latency P50/P95 per class
- Inspector subjective ("did the confirmation feel right? Was it
  ever wrong?")
- Cost per session
- Telemetry of `discard_reason` distribution

**Roll-back criteria:**
- FIRE rate <40% on value transcripts → cost overhead too high
- Any session shows confirmation said BEFORE inspector finished speaking
- Inspector reports any audible WRONG value
- P95 audible (FIRE) >2.5s

## Estimated effort + sequence

| Workstream | Phase | Days |
|---|---|---|
| A | A1: capture 100 historical transcripts from S3 + anonymise | 1 |
| A | A2: prompt revision draft (Claude + Derek iterate, ~3 rounds) | 2 |
| A | A3: replay harness build + A/B comparison | 2 |
| A | A4: prompt change commit (flag off) + soak | 1 |
| B | B1: stream-assembler hook (onTextDelta + onCompletedToolUse + AbortSignal) | 1 |
| B | B2: switch eicr-extraction-session to messages.stream behind flag | 2 |
| B | B3: loaded-barrel-buffer module + verdict + tests | 3 |
| B | B4: keys.js short-circuit hint + cost-tracker single-owner contract | 1 |
| B | B5: harness scenarios + STAGE0_RESULTS_LOADED_BARREL.md | 1 |
| C | C1: test suite expansion for prompt + invariants | 2 |
| C | C2: field assessment over 5-10 sessions | wall-clock 1-2 weeks |
| **Total** | | **~16 backend days + 1-2 weeks field validation** |

Workstreams A and B can develop in parallel after A2 completes; C2
gates the rollout flag flip.

## Rollout

1. Cost-rate prep commit (`$0.030/1K` → `$0.050/1K`) lands first
2. Workstream A1-A3 captures historical data + builds replay harness
3. Workstream B1-B5 builds the buffer infrastructure behind
   `VOICE_LATENCY_LOADED_BARREL=false` flag (zero behavioural change
   until flipped)
4. Workstream A4 ships prompt change behind
   `VOICE_LATENCY_PROMPT_TEXT_FIRST=false` flag
5. Workstream C1 lands test expansion
6. Soak both flags off for 24h, no regressions
7. Flip `PROMPT_TEXT_FIRST=true` ONLY in a canary session; run
   Workstream C2 field assessment over 5-10 sessions
8. If C2 passes: flip `LOADED_BARREL=true` for the same canary
9. Final field measurement: P50 audible on FIRE path ≤2.5s; rollback
   if not met

## Honest scope

This is a **sprint-scale plan**, not a session-scale one. ~16
backend days + ~1-2 weeks field validation = ~4 wall-clock weeks
minimum. The risk concentration is in Workstream A (prompt tuning
can subtly regress Stage 6 correctness in ways the test suite may
not catch). Workstream C exists specifically to mitigate that.

vs alternatives:
- **Skip v4, accept Stage 4 regex-fast** (deployed today at 822 ms)
  for ~50% of inspector transcripts, accept ~4.5 s for the other
  ~50%. Zero additional work.
- **Skip v4, prompt-revise Stage 6 for single-round extraction
  only** (no streaming buffer). Cuts the loop from 3 rounds to 1
  round = ~1.5 s saving. Audible drops from ~4.55 s to ~3.05 s.
  Below target but closer. ~3 days of prompt work + invariant
  testing. Probably the right "interim" step before committing to
  v4's full streaming buffer.

Recommend v4 only if the Stage 4 fast-path field assessment
concludes "regex coverage is too narrow for the inspector's real
speech patterns" AND the single-round prompt change alone doesn't
get audible under target.

## Open questions for Derek before any code lands

1. Is the prompt-tuning risk acceptable given the existing Stage 6
   `restrainedMode` + `askBudget` safety nets are NOT engaged in this
   path? They were specifically removed/stubbed for stability per
   `sonnet-stream.js:2540-2555`.
2. Single-round preference (skip rounds 2+3 by prompt rule, not by
   loop hack): is it acceptable to LOSE some Stage 6 features for
   single-value-extraction turns? (No ask_user follow-up, no
   board_op cross-references, no observation auto-link to high Zs.)
3. Field assessment cadence — Derek's inspector availability for 5-10
   sessions in a 2-week window.
4. Cost ceiling — at 50% FIRE rate, ~$2/day overhead on 1000 turns.
   Acceptable?
