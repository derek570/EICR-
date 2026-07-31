# Plan 04 — cautious Deepgram Flux Eager End-of-Turn

Status: **DRAFT — not RP-reviewed**
Backend repo: `/Users/derekbeckley/Developer/EICR_Automation`
iOS repo: `/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified`
Dependency: Plan 00 complete
Safety classification: high risk; shadow evidence before any LLM speculation

## Outcome

Determine whether Flux `EagerEndOfTurn` can safely reduce mouth-stop latency without ever allowing a partial first half of a sentence to mutate the certificate or speak. Begin with measurement only. The first useful deployment may be limited to connection preparation; sending eager text to Luna is an optional later phase requiring a separate explicit go/no-go.

This plan does not lower the authoritative `eot_threshold`/`eot_timeout_ms`, does not treat eager text as final, and does not use a timer to guess that the missing second half will never arrive.

## Non-negotiable hazard

A split such as “Circuit one is a cooker … circuit” is harmful if the LLM acts on the first fragment without the continuation. This project has already seen tighter focused thresholds split a natural reading. Therefore:

- `EagerEndOfTurn` is provisional evidence only;
- `TurnResumed` invalidates the entire eager generation even if the later final text looks similar;
- any authoritative final with added, removed, reordered or changed words invalidates it;
- no eager result may call a real dispatcher, mutate session/history/dedupe state, register a question, incur spoken-cost attribution, or reach TTS;
- only authoritative Flux `EndOfTurn` can release work toward the user.

## Verified starting point

- iOS uses Flux `flux-general-en` with `eot_threshold=0.7` and `eot_timeout_ms=5000`.
- `eager_eot_threshold` is omitted by design.
- `EagerEndOfTurn` and `TurnResumed` are decoded but only logged as ignored.
- the client has a local RMS speech-onset state machine and `probeLastVoicedAt`, but current perceived-latency reporting starts from server-authoritative EndOfTurn rather than an estimate of the user's actual mouth-stop.
- focused-answer `0.5/1500` thresholds were unsuitable for ordinary sentences; they are not the template for this work.

## Phase 1 — measurement only

- Add a source-gated eager threshold using Deepgram's current documented range, initially in a telemetry-only cohort.
- Preserve the complete eager transcript, event time, next `TurnResumed`, and authoritative final only in the existing privacy-safe device session log. Do not add raw transcript to backend CloudWatch.
- Add a device-local speech-stop estimate from the existing RMS state (`last voiced sample + declared hangover`) and explicitly label it estimated.
- Measure:
  - local estimated mouth-stop → eager event;
  - eager event → authoritative EndOfTurn;
  - proportion followed by `TurnResumed`;
  - normalized word-sequence equality between eager and final;
  - how frequently final adds a second clause/value/correction;
  - network and utterance-length splits.
- In this phase the existing final-transcript delegate is the only route to the backend. Assert in tests that eager events cannot invoke it.

### Safe normalization for comparison

Define one deterministic comparator that may normalize only case, Unicode punctuation/apostrophes and runs of whitespace. It must not normalize numbers, units, homophones, field names, word order or dropped filler. The normalized word sequence must be exactly equal. “Semantic similarity” is forbidden for commit eligibility.

## Phase 2 — no-text preparation experiment

Before considering an eager LLM request, test whether the eager event can safely prepare infrastructure without sending transcript content:

- ensure the backend session/socket is awake;
- establish/reuse the ElevenLabs connection from Plan 03;
- prepare an empty generation/correlation container;
- perform no model API request and no cost attribution.

Measure whether this produces a real first-audio gain once authoritative EndOfTurn arrives. If it captures enough of the available eager lead, stop here.

## Phase 3 — optional quarantined Luna speculation

This phase is not authorized merely because Phase 1 ships. RP/EP must leave it dark unless the field dataset shows a high exact-match rate, a material lead and Derek explicitly approves the remaining waste/risk.

If approved:

- mint a provisional generation ID that is never inserted into canonical session history;
- call Luna through an isolated tool loop whose dispatcher records proposed calls in memory only;
- disable Loaded Barrel, ElevenLabs synthesis, answer emission, asks, cost-facing client messages and all real write dispatchers;
- abort the request immediately on `TurnResumed`, a newer eager event, disconnect, session stop or watchdog;
- at authoritative EndOfTurn, require: no resume occurred, exact normalized word-sequence equality, matching session/utterance generation and a complete non-aborted provisional result;
- if any condition fails, destroy every provisional artefact and run the authoritative full transcript through the normal Luna path;
- if all conditions pass, replay the buffered tool calls through the real validation/dispatcher layer exactly once, then continue the normal Luna loop with the canonical tool results so Luna retains its self-correction/end-turn opportunity;
- never trust provisional validation: real dispatch can still reject a call, and Luna must see that canonical result.

The executor must prove that a discarded provisional run leaves session snapshots, pending asks, generation latches, dedupe tokens, confirmation caches, cost ledgers and conversation history byte-for-byte unchanged except for explicit speculative telemetry/model spend.

## Tests

iOS:

- eager event never emits a final transcript or utterance end in Phases 1–2;
- `TurnResumed` association and generation fencing;
- exact comparator accepts only casing/punctuation/whitespace changes;
- additions such as a second value/clause always fail equality;
- local speech-stop estimates reset across TTS, barge-in, pause, doze and reconnect;
- Configure echo mismatch/failure leaves canonical thresholds active.

Backend Phase 3, if authorized:

- eager half + resumed second half → provisional aborted, full final runs once;
- eager half + final extension without a resume → discarded and full final runs once;
- exact eager/final → real dispatcher invoked once, full Luna continuation retained;
- correction/negation/additional circuit/value in final can never inherit an eager write;
- cancellation at every await seam leaves zero mutation/audio/ask/history;
- multi-board, pending-question, answer-user and Loaded Barrel isolation;
- no concurrent canonical/provisional model generation for one session;
- model spend is separately attributed even when discarded, while TTS/write cost remains zero.

## Gates

- Phase 1 must collect enough real utterances across Wi-Fi/cellular and short/long speech for stable p50/p95 estimates; RP must set the number after inspecting current field volume.
- Report exact-match and resume rates, not a blended “accuracy” score.
- No promotion if meaningful second-clause continuations occur inside the proposed eager window without reliable resume detection.
- Phase 3 requires an explicit decision; it cannot auto-enable from a metric threshold.
- Any double TTS, partial write, missed continuation or history leak is an immediate rollback.

## Rollout and rollback

- Add versioned iOS capability/config, backend tolerance and telemetry first; ship backend before TestFlight.
- Keep ordinary final handling unchanged in Phases 1–2.
- Rollback eager configuration through source/TestFlight and preserve canonical 0.7/5000 settings.
- Update `docs/reference/ios-pipeline.md`, `vad-investigation.md`, `architecture.md`, `deployment.md`, `changelog.md`, iOS docs and TestFlight runbook evidence.

## Reviewer pressure points

- Is there any path—even logging callbacks or Loaded Barrel—that can observe provisional tool calls as real?
- Can `TurnResumed` arrive after authoritative processing starts, and how is that race fenced?
- Does exact equality compare the full accumulated transcript, not only the last update?
- Can a resumed sentence produce no `TurnResumed`; if so, the exact-final mismatch still must discard it.
- Does speculation actually save enough time to justify duplicate model spend and complexity over the no-text preparation phase?
