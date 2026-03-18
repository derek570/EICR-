# Extraction-Driven Transcript & Field Highlighting

**Date:** 2026-03-03
**Status:** Implemented
**Platforms:** iOS, Web

---

## Problem

Previously, transcript words changed colour immediately on regex detection (iOS) or via static keyword matching (web). This gave false confidence because:

- Regex detection doesn't guarantee the value will enter the system — pre-existing values block it, Sonnet may overwrite it, or it may be rejected
- The web used a hardcoded `HIGHLIGHT_KEYWORDS` array of ~45 static keywords with no connection to actual extraction
- Users had no way to distinguish "recognised by speech-to-text" from "actually entered into a form field"

## Solution

Words in the live transcript only turn **green** once a value is actually entered into a form field by Sonnet extraction. The form field that received the value flashes **blue** for 3 seconds. No colouring happens on regex detection.

This gives the user unambiguous confirmation that spoken data has been processed.

## Flow

```
Speech → Deepgram transcription → Regex fills fields silently (no visual feedback)
                                 → Sonnet confirms/overwrites (1-2s delay)
                                   → Value turns GREEN in transcript
                                   → Target field flashes BLUE
```

## iOS Changes

| File | Change |
|------|--------|
| `DeepgramRecordingViewModel.swift` | Removed `updateHighlight()` calls from `applyRegexValue()`. Added `liveFillState?.markFieldUpdated(key)` to `applySonnetValue()` after each successful application. |
| `TranscriptDisplayView.swift` | Removed keyword (blue) colouring block from `buildHighlightedText()`. Only values confirmed by Sonnet extraction are coloured green. |
| `LiveFillState.swift` | Added `recentlyUpdatedFields: [String: Date]` dictionary, `markFieldUpdated(_:)`, and `isFieldRecent(_:within:)` for timestamp-based flash tracking. |
| `LiveFillView.swift` | Added blue flash animation to `LiveField` using `isFieldRecent(key)` — `Color.blue.opacity(0.15)` fades out over 2s via `.animation(.easeOut(duration: 2.0))`. |

**Commit:** `beb9863` in CertMateUnified repo.

## Web Changes

| File | Change |
|------|--------|
| `web/hooks/use-recording.ts` | Added `TranscriptHighlight` type and `recentlyUpdatedFields` state. In `applySonnetResults()`, pushes highlights and field timestamps only after successful application. |
| `web/components/recording/transcript-display.tsx` | Removed `HIGHLIGHT_KEYWORDS` array entirely. Rewrote `buildHighlightedText()` to accept extraction-driven highlights with word-boundary matching in last 300 chars. Values render as `text-green-600`. |
| `web/components/recording/recording-strip.tsx` | Passes `highlights` prop through to `TranscriptDisplay`. |
| `web/components/circuits/circuit-table.tsx` | Added `RECENT_FIELD_WINDOW_MS = 3000`, blue flash (`bg-blue-100` → transparent over 2s CSS transition) on `EditableCell` via `recentlyUpdatedFields` table meta. |

**Commit:** `2a2870f` in EICR_App repo.

## What Didn't Change

- Regex still fills fields as before on both platforms — it just doesn't trigger visual feedback
- Sonnet extraction pipeline unchanged
- 3-tier field priority (pre-existing > Sonnet > Regex) unchanged
- TypingText animation on iOS unchanged
- Auto-scrolling to updated sections unchanged
- Interim text styling (grey italic) unchanged

## Technical Details

### Transcript Highlighting Algorithm

Both platforms use the same approach:
1. Take the visible tail of the transcript (200 chars iOS, 300 chars web)
2. For each Sonnet-confirmed highlight, search for the **last** word-boundary occurrence of the extracted value
3. Merge overlapping ranges
4. Render matched ranges as green bold text

### Blue Flash Mechanism

**iOS:** `@Observable` LiveFillState stores `[String: Date]` timestamps. `isFieldRecent()` checks if timestamp is within 3s window. SwiftUI `.animation(.easeOut(duration: 2.0))` handles fade.

**Web:** React `useState` + `useEffect` with `setTimeout` to clear flash after 3s. CSS `transition-colors duration-[2000ms]` handles fade. Field key built from `circuitRef + columnId` via TanStack Table meta.

### Note on Web Integration

`RecordingStrip` is exported but not yet imported in any web page layout — the recording UI isn't fully wired into the web app. `CircuitTable` accepts optional `recentlyUpdatedFields` prop for forward compatibility.

## Verification

1. **iOS:** Start recording, speak "Ze is 0.35"
   - Transcript does NOT colour on regex detection
   - After Sonnet confirms (~1-2s), "0.35" turns green
   - Ze field in LiveFillView flashes blue

2. **Web:** Same test via web recording interface
   - Static keywords no longer coloured
   - Values turn green only after Sonnet extraction
   - Circuit table cells flash blue when filled

3. **Edge cases:**
   - Pre-existing fields: no colouring (Sonnet doesn't overwrite)
   - Regex fills then Sonnet confirms same value: green appears on Sonnet confirmation
   - Regex fills then Sonnet overwrites with different value: green shows Sonnet value
