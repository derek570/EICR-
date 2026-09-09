# RegexFreshOccurrenceV1 and FinalWindowV1

> Last updated: 2026-09-09
> Related: [ConversationAdmissionV1](conversation-admission-v1.md) | [iOS pipeline](ios-pipeline.md) | [Architecture](architecture.md)

A02D keeps client regex writes fresh after corrections and clears. A fresh
ordinary reading still prefills in a long session. Old speech never restores a
cleared value, never undoes a correction, and is never reassigned through later
context.

## The problem it fixes

Both client matchers deliberately rescan an 800-character overlap of the
cumulative transcript on every final. Before A02D the apply layer decided
freshness by value equality against the job. After a value was cleared or
corrected, the next unrelated final's rescan found the old text, saw an empty
or different destination, and wrote the old value back.

## Order of operations (web)

Both clients perform this sequence once per admitted final:

1. **Admission boundary.** `onFinalTranscript` accepts a final only when the
   emitting `DeepgramService` is the provider's current instance, the emitting
   socket's epoch is that service's current epoch, and the session is the
   active recording session. `disconnect()` invalidates the instance
   synchronously, before its 300 ms CloseStream grace. A failing final is
   dropped with no record, no hold, no clarification, and no send.
   `onmessage`, `handleMessage`, and `advanceProcessedWatermark` are unchanged,
   so PLAN-E2 still retires a superseded socket's own epoch.
2. **FinalWindowV1 record.** `{session, epoch, final_sequence, speech_start,
   window_end}`. `speech_start` is the session VAD's onset, recorded at the
   onset frame's send as the epoch's `dispatchedSampleOffset`, and it counts
   only when Deepgram emits a StartOfTurn or a non-empty interim within 2.5 s
   of the onset and before the run's silence transition. The confirmation
   belongs to its own VAD run: it serves every provider turn of that run,
   including a final that lands after the run's debounced silence, and it is
   superseded when the next onset begins, so a later run whose onset never
   confirms emits `unbounded` finals. `window_end` is the
   EndOfTurn `audio_window_end` converted through `audioWindowEndToSampleOffset`
   plus the epoch's dispatch origin. A final with no confirmed onset or a
   malformed window is `unbounded`. Nova-3 uses the first word start and the
   last word end.
3. **Hold decision.** One decision for the whole dispatch, before every
   mutation-capable consumer: local commands, feedback capture, the admitted
   buffer append, regex application and hints, the chime, ask-state consumption,
   and the send. A dispatch is held when a manual cutoff applies on its epoch
   and any constituent's `speech_start` is below the cutoff, or the constituent
   is `unbounded`. A held dispatch forwards nothing, writes nothing, consumes no
   ask, and speaks exactly one clarification line through the confirmation
   FIFO.
4. **Admitted buffer append.** The dispatch becomes one fragment with a stable
   id, its epoch, its maximum constituent final sequence, and its absolute raw
   span. Positions are session-monotonic across bypass resets and front-trims.
5. **Match with provenance.** The matcher records every successful regex match
   and attributes each section write, at the write, to the regex evidence since
   the previous write plus the segment's anchor (the `circuit N` or designation
   match). The normalised window carries a token-aligned source map back to the
   raw window.
6. **Occurrence freshness before value gates.** Each candidate is evaluated in
   this order: ambiguous span, unbounded contributing final, old overlap
   (candidate touches no current fragment), settled identity, buffer cutoff
   (any contributing final at or below the destination's cutoff, so a
   cross-final completion whose anchor preceded the clear is stale), manual
   stream cutoff, fresh. Only fresh candidates reach
   `applyRegexMatchToJob` (hints on) or `computeFreshRegexWrites` (hints off).
   A fresh candidate is settled whether or not the value gate writes it.
7. **Retention.** The admitted buffer front-trims at a fragment boundary above
   2,400 characters, keeping at least 1,200. The store evicts settled
   occurrences below the watermark, final records of evicted fragments, and
   manual cutoff lists of epochs no retained fragment references.

## Destination routing

`web/src/lib/recording/regex-destination-routing.ts` is the ONE routing rule
for every regex consumer: matcher provenance, the freshness gate, cutoff
identity, clarification naming, and the apply layer. It translates the
matcher's `supply.main_switch_*` and `supply.spd_*` keys to `board.*`
(their `board_info` store), renames `install.general_condition_of_installation`
to `install.general_condition`, and resolves a circuit ref to a row by
board: the active board (`current_board_changed`), then the job's first
board, then a row without `board_id`, then the first row in job order. Two
boards sharing "circuit 4" are therefore two destinations, and the row the
gate evaluated is the row the apply layer writes.

## Clear and replacement cutoffs

| Boundary | Buffer cutoff | Stream cutoff | Source on web |
| --- | --- | --- | --- |
| Manual clear or replacement | Latest minted final sequence at the tap | Emitting epoch's `dispatchedSampleOffset` at the tap | `JobProvider` mutation observer, `source: 'manual'` |
| Server clear frame | Causative final's sequence via echoed `utterance_id` | none | `field_corrected` handler |
| Server replacement or clear in a result | Causative final's sequence via echoed `utterance_id` | none | `applyExtraction` changed keys and `field_clears` |
| A01B accepted receipt | Producer table by `{session_epoch, mutation_id}` | Manual snapshot when the producer was a tap | Not on `main` yet; the table is dormant (no local identities are minted) and its rows are evicted with their epoch |

Sampling happens at the tap, on the same tick as the mutation, because
`JobProvider.subscribeJobMutations` notifies synchronously. A rejected or
pending edit never reaches the observer. The `utterance_id` echo is decoded
by `SonnetSession` on both the `extraction` envelope and the standalone
`field_corrected` frame (`ExtractionResult.utterance_id`,
`Stage6FieldCorrected.utterance_id`); without it the cutoff does not advance
across newer finals. A clear never blacklists a value: a later fragment may
apply the same value.

## Clarification obligation

Templates are pinned byte-equal to `config/regex-freshness-vectors.json`:

- One to three destinations: `I heard something just as you cleared
  {destinations}. Say it again if it should apply.` Two destinations join with
  ` and `; three join with `, ` and `, and `.
- Four or more: `I heard something just as you cleared those fields. Say it
  again if it should apply.`

A destination speaks the canonical field label, the stored circuit reference
exactly as displayed, and the board name only when the job has more than one
board. The token follows PLAN-E2's lifecycle plus a text-freeze boundary: a
second held final merges only while the wording is unfrozen; after the freeze
it awaits a successor minted at natural completion. Re-park on preemption,
overflow, TTS unavailability, playback failure, and discard; abandon at session
teardown. Held audio is charged to no PLAN-E2 counter.

A duplicate delivery of one provider final is one obligation. The transport
stamps every final with the provider's identity (`FinalTranscriptMeta.
providerFinalId`: Flux epoch + `turn_index` + `audio_window_end`; nova-3
epoch + `start` + `duration`), the provider reuses that final's
FinalWindowV1 record instead of minting a new sequence, and the ledger
remembers disclosed keys until session teardown, so the duplicate is a
duplicate before and after the clarification played.

## Replay is retired

Both clients keep the tagged ring only for PLAN-E2 loss accounting. The web
sleep and doze drains in `handleWake` and the full-sleep branch of `resume()`
are removed. Ring contents at a wake or resume are charged through
`UplinkLossLedger.recordStagedLoss`, so PLAN-E2's disclosure fires under its
unchanged materiality rules. No path re-sends ring audio to any socket.

## Fixture and pins

- Canonical: `config/regex-freshness-vectors.json`.
- Web pin: `web/tests/regex-freshness-fixture.test.ts` (SHA-256), which also
  runs every sequence through the pure helpers; `web/tests/harness/
  a02d-regex-freshness-fixture-mounted.test.tsx` runs every sequence through
  the mounted provider (real Deepgram frames and the real `SonnetSession`
  decoder behind captive sockets) in both hint lanes.
- iOS pin: byte copy under the iOS test fixtures.
- Sync: `scripts/check-regex-freshness-fixture-sync.sh` fails closed on drift.
- The clarification templates are also in `config/closed-enum-vectors.json`
  `spoken_distinctness_union`, so that fixture's pins move with them.

## Files (web)

- `web/src/lib/recording/final-window.ts` — record, onset tracker, transport meta.
- `web/src/lib/recording/normalisation-source-map.ts` — token-aligned source map.
- `web/src/lib/recording/regex-destination-routing.ts` — the shared
  destination routing (section aliases, duplicate refs by board).
- `web/src/lib/recording/regex-fresh-occurrence.ts` — admitted buffer, store,
  cutoffs, hold decision, labels, freshness gate.
- `web/src/lib/recording/held-fragment-clarification.ts` — templates and token ledger.
- `web/src/lib/recording/transcript-field-matcher.ts` — occurrence trace.
- `web/src/lib/recording/deepgram-service.ts` — meta on every final, admission flag.
- `web/src/lib/recording/tts.ts` — clarification speech family.
- `web/src/lib/job-context.tsx` — mutation observer and recording write path.
- `web/src/lib/recording-context.tsx` — admission, hold, cutoffs, retention, replay removal.

## Known limits

- An `unbounded` final never prefills locally. The server still extracts it.
- After an owned close (stop, pause, sleep, replacement) a late final is
  dropped without disclosure. That is PLAN-E2's accepted design.
- A01B is not on `main`. The producer table keeps the join-key shape so an
  accepted receipt can resolve its cutoff by identity when A01B lands; until
  then nothing writes to it (a manual tap records its cutoff, not a
  producer row).
- `VoicedActivityDetector.isLocalSpeakingWithin` compared a
  `performance.now()` stamp against `Date.now()` since 2026-08-29, so the
  raw-VAD parking never engaged in production. A02D fixed the default clock.
