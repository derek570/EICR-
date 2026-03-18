# ADR-004: Three-Tier Field Priority

**Date:** 2026-02-18
**Status:** Accepted

## Context

EICR-oMatic 3000 populates certificate fields from three different sources during a recording session:

1. **Pre-existing data** -- Values from CCU (consumer unit) photo analysis via GPT Vision, manual edits the inspector made before recording, or data imported from a previous certificate. These are high-confidence values the inspector has already seen and implicitly accepted.

2. **Sonnet extraction** -- Structured fields extracted by the server-side Claude Sonnet 4.5 multi-turn conversation (ADR-003). These are high-accuracy values from the AI extraction pipeline, returned 1-2 seconds after the inspector speaks.

3. **Regex extraction** -- Instant pattern-matched values from `TranscriptFieldMatcher.swift` (iOS) or `transcript-field-matcher.ts` (PWA). These are extracted in ~40ms using 30+ regex patterns that match common dictation patterns like "Ze nought point two seven" or "RCD trip time twenty-one milliseconds".

The problem: when multiple sources provide a value for the same field, which one wins? Without a clear priority, the UI would flicker as values were overwritten, and the inspector would lose trust in the system.

### Specific conflict scenarios

- Inspector takes a CCU photo (GPT Vision extracts earthing arrangement as "TN-C-S"), then dictates "earthing is TN-S". Should Sonnet overwrite the photo-extracted value?
- Regex extracts "Ze = 0.27" from "Ze nought point two seven", then Sonnet extracts "Ze = 0.27" from the same transcript 1.5 seconds later. Should Sonnet overwrite with the same value (causing a UI flicker)?
- Inspector manually types "12" for a circuit breaker rating, then dictates "thirty-two amps". Should voice data overwrite a manual edit?

## Decision

Implement a **three-tier field priority system** where the source of each field value is tracked and higher-priority sources are never overwritten by lower-priority sources:

```
Pre-existing (CCU photo / manual edit)  >  Sonnet  >  Regex
```

Each field carries a `FieldSource` enum (`.preExisting`, `.sonnet`, `.regex`) that records how it was populated. The rules:

1. **Regex can fill empty fields only.** If a field already has a value from any source, regex will not overwrite it.
2. **Sonnet can fill empty fields and overwrite regex values.** Sonnet is more accurate than regex (it has full conversation context), so it can replace regex-extracted values. It cannot overwrite pre-existing values.
3. **Pre-existing values are immutable during recording.** Values from CCU photo analysis, manual edits, or imported certificates are never overwritten by voice extraction. The inspector must manually edit them if they want to change them.

This is implemented in:
- **iOS:** `DeepgramRecordingViewModel.swift` -- `applySonnetReadings()` and `applyRegexReadings()` check `FieldSource` before updating
- **PWA:** `frontend/src/lib/recording/use-recording.ts` -- same logic with TypeScript `FieldSource` enum
- **Backend hint context:** Regex-matched field names (not values) are sent to Sonnet as hints, helping Sonnet understand what the inspector is currently describing without overriding its own extraction logic

## Consequences

### Positive

- **No UI flickering.** Fields do not bounce between values as different extractors produce results. Once a field is set by Sonnet, regex will not overwrite it. Once set by a pre-existing source, nothing overwrites it during recording.
- **Instant feedback + high accuracy.** Regex fills fields in ~40ms (giving the inspector instant visual confirmation), then Sonnet overwrites with potentially more accurate values 1-2 seconds later. The inspector sees fast results that get refined.
- **Inspector trust.** Manual edits and photo-extracted values are respected. The inspector knows that anything they explicitly set will not be changed by the AI.
- **Dual extraction without conflict.** Regex and Sonnet run independently and in parallel without needing to coordinate. The priority system resolves conflicts deterministically.
- **Transparent provenance.** Because each field tracks its source, debugging extraction issues is straightforward -- you can see whether a value came from regex, Sonnet, or the CCU photo.

### Negative

- **Pre-existing errors persist.** If GPT Vision misreads the CCU photo (e.g., extracts "TN-C-S" when it is actually "TN-S"), voice extraction will not correct it. The inspector must notice and manually fix it.
- **Sonnet may redundantly extract.** Sonnet does not know that a field was already filled by regex, so it may spend tokens extracting values that will not be used. The regex hints sent to the backend partially mitigate this by giving Sonnet context about what regex already matched.
- **Field source tracking adds complexity.** Every field update path must check and set the `FieldSource` enum. Missing a check in a new code path could break the priority guarantee.
- **No automatic conflict resolution.** If Sonnet extracts a value that differs from a pre-existing value, the system silently ignores the Sonnet value rather than flagging it for review. A future enhancement could alert the inspector to discrepancies.
