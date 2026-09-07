# ConversationAdmissionV1

> Last updated: 2026-09-07
> Related: [iOS pipeline](ios-pipeline.md) | [Architecture](architecture.md) | [TestFlight](deploy-testflight.md)

ConversationAdmissionV1 is the client boundary between a raw Deepgram final
and CertMate's local mutation pipeline. It prevents a question or conversational
reference containing reading-shaped words and numbers from being written by the
client regex matcher before the server can answer it.

## Order of operations

Both clients perform this sequence once per final:

1. Complete the existing split-final naming concatenation and TTS echo checks.
2. Classify the **raw final** as `QUERY_TRIGGER`, `REFERENCE_TRIGGER`,
   `QUESTION_SHAPED`, `MIXED`, or `ORDINARY`.
3. Protect complete ordinal reference spans while running number normalisation.
4. For every non-ordinary class, keep the display transcript and optional
   `postcode_hint`, but skip local board/apply/calculate commands, alert
   resolution, regex matching, regex hints, job writes, and regex fast TTS.
5. Clear only the matcher's rolling input, cursor, and active-circuit context.
   Pending server/legacy asks and their timers remain intact.
6. Forward `QUERY_TRIGGER` and `REFERENCE_TRIGGER` directly. Other classes
   still use the existing client transcript gate.

The web implementation is
`web/src/lib/recording/conversation-admission.ts`; iOS mirrors it in
`Sources/Recording/ConversationAdmission.swift`. JavaScript spans use UTF-16
code-unit offsets (`start`, exclusive `end`); Swift uses `NSRange`, also UTF-16.

## Classification boundary

The bounded grammar recognises assistant requests such as “repeat that” and
“what did you hear”, explicit reading questions such as “Was circuit four Zs
0.7”, and references such as “The second one”. Marker recognition includes the
actual mirrored spoken-abbreviation source tables. It does not accept isolated
initial letters or maintain a broad server-side question word list.

Known-board imperatives such as “Can you work on board two?” remain ordinary so
their established local selection path still runs. A board command combined
with a separate question is mixed and therefore bypasses mutation. Definite
reading continuations remain ordinary; bare ordinal references are protected.
Deterministic ordinal-reference expansion belongs to A02C, so “The second one”
reaches the server unchanged instead of being locally redirected.

`postcode_hint` is lookup-only metadata. It never grants admission, enters the
matcher, or writes a job. A real WebSocket ingress test with a no-write model
pins that boundary.

## Shared contract and verification

`config/conversation-admission-vectors.json` is the canonical raw-final
contract. It freezes classification, mutation bypass, direct admission,
normalised output, protected spans, and postcode carriers. Existing platform
normaliser differences use explicit `normalised_ios` or `normalised_web`
overrides; normaliser convergence is outside this change.

The iOS copy at
`Tests/CertMateUnifiedTests/Fixtures/conversation-admission-vectors.json` must
remain byte-identical. Jest, Vitest, and XCTest pin its SHA-256 digest and the
clients' actual spoken-abbreviation tables. Before TestFlight, run:

```bash
IOS_REPO_ROOT=/path/to/CertMateUnified \
  scripts/check-conversation-admission-fixture-sync.sh
```

Mounted tests count real job writes, alert-resolution calls, matcher attempts,
regex hints, fast-TTS dispatches, transcript carriers, and boundary resets.
Simulator tests prove software behaviour; physical-device hearing remains
unverified until the paired TestFlight build is exercised.

## Rollback order

Revert client direct admission while retaining mutation protection first, then
deploy both clients. Disable `VOICE_AGENTIC_ANSWERS` only after released clients
no longer depend on borderline-forward. Removing mutation protection is a
separate later revert. No new runtime flag or wire field was added.
