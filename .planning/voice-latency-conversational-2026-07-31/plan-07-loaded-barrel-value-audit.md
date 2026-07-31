# Plan 07 — prove the value of the live, parked-audio Loaded Barrel

Status: **DRAFT — not RP-reviewed**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
iOS repo: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
Dependency: Plan 00 before code changes
Timing: establish baseline before Plans 02–03 change the TTS waterfall

## Outcome

Measure whether the current safe form of Loaded Barrel materially reduces mouth-stop-to-audio latency under Luna, then make an evidence-backed keep, narrow or retire decision. Keep the full Luna loop and post-loop canonical validation. Do not restore mid-turn preview playback or round-one early termination.

## What is live now

Loaded Barrel and the removed fast exit are different mechanisms:

- `VOICE_LATENCY_LOADED_BARREL=true` is present in source and live ECS.
- the GPT-5.6 Responses adapter exposes streamed function-call completion to the existing `onToolUseStreamed` hook;
- the hook starts ElevenLabs synthesis and parks the audio;
- `onSlotAudioReady:null` prevents any mid-stream preview envelope or playback;
- Luna continues through every normal round and reaches its own terminal;
- post-loop validation invalidates drifted audio;
- iOS receives the normal canonical confirmation and its TTS POST claims the parked audio only on a slot+expanded-text match;
- the server-side round-one early-terminate mechanism was deleted in commit `1db6230a` because skipping Luna/Claude's second look ruined the conversational feel.

The live parked-audio design is therefore compatible with conversational behaviour in principle: it overlaps TTS work but does not shorten or bypass the LLM conversation.

## Preliminary evidence (2026-07-31, last 24 hours)

Across the two sessions visible in CloudWatch:

- 28 speculative candidates started / completed synthesis;
- 21 were claimed as `loaded_barrel_hit` (75% of candidates);
- 4 candidates were invalidated for canonical text drift;
- 7 candidates, totalling 230 characters, were not claimed;
- at $0.05/1,000 characters, unclaimed candidate synthesis was approximately $0.0115 across those sessions;
- a further 18 canonical requests were recorded as misses, including circuit operations and unsupported/ambiguous shapes.

These numbers show the mechanism is active and often hits, but they do not prove the current latency saving. The code comment's historical “~470 ms” is not a current Luna measurement. Current iOS playback summaries carry `correlation_id:null`, so a `loaded_barrel_hit` cannot be joined directly to the audible ACK. `acked_by_ios:false` on the immediate outcome row is therefore not proof it was unheard.

## Phase 1 — repair the evidence chain

- Carry the `X-Voice-Latency-Correlation-Id` from the TTS response into every actual playback-start ACK, including queued/deferred confirmation items.
- Preserve the source (`loaded_barrel_hit`, pending/late hit, streaming confirmation, legacy/buffered fallback) through the same path.
- Do not ACK network receipt; stamp only the existing actual playback-start event.
- Make the delayed turn-audio finalizer join by session, turn, slot and correlation ID.
- Add a PII-safe outcome ledger that can answer for each canonical confirmation:
  - speculative start and vendor first/final audio;
  - validation keep/drift/discard;
  - cache ready/pending/miss and HTTP response time;
  - iOS first playback;
  - canonical fallback synth if any;
  - whether any second playback occurred for the same confirmation identity.
- Correct the legacy `ElevenLabs TTS success` timing labels if they currently begin after the vendor fetch has already returned; a 0–6 ms “synth total” must not be presented as vendor latency without proving the start stamp.

Likely files:

- `src/routes/keys.js`
- `src/extraction/voice-latency-telemetry.js`
- `src/extraction/voice-latency-turn-summary.js`
- `Sources/Services/APIClient.swift`
- `Sources/Recording/AlertManager.swift`
- relevant backend and iOS telemetry tests

## Phase 2 — controlled value measurement

Use a source-controlled, session-latched cohort assignment so a session never changes behaviour mid-job. Compare matched fixtures/field turns with Loaded Barrel on and off while keeping Luna Fast, Deepgram settings, TTS model and client build constant.

Report:

- mouth-stop estimate and authoritative EndOfTurn → actual first playback;
- Luna streamed tool completion → canonical result;
- canonical result → first playback;
- hit, pending-hit, late-hit, miss, drift and discarded rates;
- p50/p75/p95 saving for hits and overall weighted saving across every confirmation;
- extra ElevenLabs characters/cost from unused candidates;
- double-TTS, wrong-text, partial-audio and fallback rates;
- result split by field/tool type, single versus multi-round, single versus multi-board, Wi-Fi versus cellular and cold versus warm vendor connection.

Use at least the current field-replay confirmations plus real sessions. RP must choose the sample count after looking at field volume; do not infer a population result from the current two sessions.

## Phase 3 — narrow improvements only if supported

Possible changes are evidence-dependent and independently flagged:

- restrict speculation to tool/field shapes with high hit and low drift rates;
- skip later-round candidates whose remaining canonical gap is too short to repay synthesis;
- share Plan 03's persistent ElevenLabs connection so more candidates become ready before canonical confirmation;
- remove stale `midStreamEmittedSlots`/`VOICE_MID_STREAM_FILTER` scaffolding only after tests prove no consumer remains;
- reduce the per-turn cap from 12 if multi-write turns create wasted audio with little first-play benefit.

Do not:

- restore `onSlotAudioReady` preview emission;
- play before canonical post-loop validation;
- skip Luna's next round or synthesize model-authored questions/answers through the reading cache;
- widen approximate text matching—expanded text must match exactly;
- optimize for hit rate by weakening dispatcher validation.

## Tests

- streamed candidate remains inaudible until canonical confirmation;
- changed/corrected/dropped/grouped/board-moved result invalidates candidate;
- exact canonical match claims once;
- pending race, timeout, cache claim race and reconnect cannot double-synth/play;
- regex-fast audio and Loaded Barrel cannot both own the same slot;
- double-TTS regression cases cover duplicate backend envelopes, two iOS queue inserts and partial/fallback playback;
- correlation/source survives network response, FIFO deferral and playback ACK;
- full Loaded Barrel, bundler, multi-board, clamp, enum, LIM and read-back suites pass;
- cohort flag is session-latched and source-controlled.

## Decision gates

Keep unchanged when weighted latency saving is material and there are zero correctness/double-play failures.

Narrow when a small set of fields/rounds supplies most benefit and most waste/drift comes from identifiable excluded shapes.

Retire when the weighted end-to-end gain is negligible after Luna Fast and modern TTS streaming, or when correctness/maintenance risk outweighs the measured benefit. Retirement means flag off and removal through a reviewed plan—not reactivation of fast exit.

## Rollout and rollback

- Telemetry additions ship backward compatibly, backend first then TestFlight where required.
- Capture the baseline before enabling incremental iOS TTS or persistent ElevenLabs so attribution remains possible.
- Any eligibility change is dark-deployed and can revert to the current known path by source flag.
- Update `architecture.md`, `ios-pipeline.md`, `deployment.md`, `changelog.md`, voice-latency query docs and iOS docs.

## Reviewer pressure points

- Does a hit prove actual playback, or merely a cache claim?
- Can the correlation ID be lost during FIFO deferral as it is today?
- Are hit-only savings being mistaken for overall weighted savings?
- Is unused speculative TTS spend counted even when a canonical fallback is also synthesized?
- Can any old mid-stream preview code be reactivated accidentally by a flag or callback?
