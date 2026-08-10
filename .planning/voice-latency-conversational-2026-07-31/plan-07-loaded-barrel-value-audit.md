# Plan 07 — prove the value of the live, parked-audio Loaded Barrel

Status: **CLOSED 2026-08-10 — verdict: KEEP UNCHANGED.** Phase 1 shipped 2026-07-31.
**Phases 2–3 are CUT** (Derek's 2026-08-10 re-scope: read the telemetry that already shipped, decide,
build nothing). No cohort assignment, no A/B flag, no new apparatus was built — and none should be.
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
iOS repo: `/Users/derekbeckley/Developer/CertMateUnified`

## VERDICT (2026-08-10) — KEEP UNCHANGED

Loaded Barrel is doing what it was built to do. It removes **≈ 200–300 ms** from perceived latency at
p50, hits on **78 %** of turns, and costs nothing at the correctness surface (audio is parked, never
played before canonical validation). Narrowing it to `single_call` would give that back for nothing;
retiring it would cost it outright. **Keep it exactly as it is.**

### How the earlier contradiction resolved

Two readings of the same shipped telemetry disagreed. The between-groups read said hits were ~35 %
*slower* (p50 5240 ms vs canonical 3890 ms) and pointed at retirement. The within-turn read said a
hit was why one turn's 12.4 s round-sum produced 3.97 s of perceived latency.

**The between-groups read was confounded, and this is the mechanism.** Perceived latency is
dominated by the model loop — measured here at **96.2 %** of perceived latency at p50, independently
reproducing the 0.91–0.97 ratio that Plan 08A was written from. So comparing raw latency between hit
and non-hit turns mostly compares *how hard the turns were*, not what the barrel did. It is the wrong
denominator.

### The measurement that settles it

23 turns from the four Luna field sessions of 2026-08-06/07, joined through the shipped
correlation-id evidence chain. The honest statistic is the **non-loop residual** — everything in
perceived latency that is *not* the model loop:

```
non_loop_ms = perceived_latency_ms − Σ stream_ms − Σ dispatch_ms(ask-wait excluded)
```

This contains **no imputed value**, which matters because `vendor_ms` had to be imputed for all 18
hit turns (a hit has no canonical vendor span to measure). Any verdict read off `A/B` directly would
have been partly circular.

| Group | n | non-loop residual, p50 |
|---|---|---|
| `loaded_barrel_hit` | 18 | **204.0 ms** |
| `legacy_confirmation` | 5 | **501.9 ms** |
| **difference** | | **297.9 ms** |

Measured canonical vendor time on the five legacy turns: **p50 211 ms** — which is what the barrel
should be able to hide, and is independently consistent with Plan 03 §3's separately measured
**≈215 ms** whole-vendor budget (66 ms handshake + 147 ms synthesis). Three independent routes to
the same number is the reason to believe it.

The barrel's head start is **not** the constraint: p50 1,596 ms, max 12,628 ms before loop
completion, against ~215 ms of vendor work to hide. **It starts roughly 7× earlier than it needs
to.** The binding constraint is that speech may not begin until the write is canonically confirmed —
so the barrel can only ever cash in the vendor time, never the head start.

### Caveats, stated rather than buried

- **n = 23 turns, and the comparison group is 5.** Enough to resolve a contradiction and size an
  effect; not enough to certify 297.9 ms to three significant figures. Read it as "roughly the
  vendor budget", which is what the three independent measurements agree on.
- **Means are meaningless here and were not used.** Several turns have a *negative* non-loop
  residual (min −10,110 ms) because a barrel firing up to 12.6 s before loop completion lets audio
  play while the loop continues — perceived latency legitimately ends before the model loop does.
  p50 is the only defensible statistic on this shape.
- `vendor_ms` is imputed on hits by construction. The verdict deliberately does not rest on it.

## Consequences for the rest of the wave

This verdict prices two other plans, because **the barrel has already taken the vendor win on 78 % of
turns**:

- **Plan 02 (iOS incremental TTS) should be demoted to Tier C.** Incremental playback buys the
  synthesis tail — at most Plan 03's measured 147 ms — and buys **exactly zero on a hit**, because
  the audio is already synthesised and parked ~1.6 s early. Amortised: `147 ms × 22 % ≈ 32 ms`,
  against a 6.4 s p50. That is ~0.5 %, in exchange for an iOS build carrying a capability handshake
  and an exactly-once ACK — which is precisely why it was scoped for the full dual-reviewer loop.
  **Recommend dropping it from Tier B.** Plan 08A's `pre_tool_use_ms` split can still overturn this
  if it shows something unexpected, but the burden has moved: 02 now has to argue its way back in.
- **Plan 03 §1–2 (ElevenLabs connection pooling) stays held, with a stronger reason.** Pooling
  attacks the 66 ms handshake, which the barrel already hides on 78 % of turns.

Neither conclusion depends on Plan 08A. Both are consistent with Tier A's finding that the entire
vendor half of the budget is ≈215 ms against a 6.76 s p50.

## What is live now (unchanged by this verdict)

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

These numbers show the mechanism is active and often hits, but they do not prove the current latency saving. The code comment's historical “~470 ms” is not a current Luna measurement. At baseline-capture time, iOS playback summaries carried `correlation_id:null`, so a `loaded_barrel_hit` could not be joined directly to the audible ACK. `acked_by_ios:false` on the immediate outcome row was therefore not proof it was unheard; the shipped prerequisite below repairs that join for new sessions.

## Shipped prerequisite — evidence chain (removed from future scope)

Implemented and tested on 2026-07-31, before RP review of the experiment itself:

- iOS preserves `X-Voice-Latency-Correlation-Id` and response source through immediate FIFO and deferred-head playback;
- the ACK retains delivery `source:"bundler"` and adds backward-compatible `audio_source` for Loaded Barrel hit/pending/late and canonical streaming/buffered audio;
- ACK emission occurs only after successful playback start—not network receipt or failed playback;
- delayed turn-audio and unified perceived-latency rows flatten correlation plus audio source;
- a PII-safe same-correlation `playback_started`, `acked_by_ios:true` outcome completes the ledger for:
  - speculative start and vendor first/final audio;
  - validation keep/drift/discard;
  - cache ready/pending/miss and the server serve timestamp;
  - iOS first playback;
  - canonical fallback synth if any;
  - whether any second playback occurred for the same confirmation identity.
- buffered canonical fallback now mints its own correlation/source headers and starts its vendor timer before `fetch`, rather than after response headers arrive.

The controlled comparison uses the common mouth-stop→actual-playback boundary; a finer client request-start→response-receipt micro-split is deliberately not required for the keep/narrow/retire decision and is not represented as if measured.

Implemented files:

- `src/routes/keys.js`
- `src/extraction/voice-latency-telemetry.js`
- `src/extraction/voice-latency-turn-summary.js`
- `Sources/Services/APIClient.swift`
- `Sources/Recording/AlertManager.swift`
- relevant backend and iOS telemetry tests

No synthesis eligibility, cache matching, playback ordering, TTS wording, Luna loop, or conversation behaviour changed.

## Phase 2 — controlled value measurement — **CUT, NOT BUILT**

> **CUT 2026-08-10.** This is the cohort machinery Derek's re-scope removed from the wave. The
> keep/narrow/retire question was answered from telemetry that had already shipped, at a cost of one
> analysis pass — a session-latched cohort flag would have frozen behaviour across field sessions to
> re-derive a number three independent measurements already agree on. **Do not build this.** The
> section is retained below only so the reasoning is legible if the question is ever reopened with a
> genuinely larger sample.

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

## Phase 3 — narrow improvements only if supported — **NOT TRIGGERED**

> **Not triggered 2026-08-10.** Phase 3 was conditional on the evidence supporting a narrow. It does
> not: the barrel hits 78 % of turns and its head start already exceeds the vendor time it hides by
> ~7×, so restricting eligibility or skipping late-round candidates would trade a measured saving for
> nothing. The one item here that remains independently worth doing is the stale
> `midStreamEmittedSlots` / `VOICE_MID_STREAM_FILTER` scaffolding removal — that is dead-code hygiene,
> not a Loaded Barrel change, and needs its own small plan.

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

## Web companion

None required for Phase 1: it is additive telemetry on iOS's `AVAudioPlayer` boundary and changes no spoken/visible behaviour or server speech frame. Web continues to use its existing delivery telemetry; any future cross-client Loaded Barrel experiment must define an equivalent browser audible-start boundary before combining web and iOS cohorts.

## Reviewer pressure points

- Does a hit prove actual playback, or merely a cache claim?
- Can the correlation ID be lost during FIFO deferral as it is today?
- Are hit-only savings being mistaken for overall weighted savings?
- Is unused speculative TTS spend counted even when a canonical fallback is also synthesized?
- Can any old mid-stream preview code be reactivated accidentally by a flag or callback?
